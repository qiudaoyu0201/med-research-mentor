import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { Attachments, imageDimensions } from "../server/attachments.ts";
import { BudgetLedger } from "../server/budget.ts";
import { AssistantService } from "../server/assistant.ts";
import { ConversationStore } from "../server/conversation.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { ReadingGuides } from "../server/reading-guides.ts";
import { TaskScheduler } from "../server/scheduler.ts";
import type { Provider } from "../server/provider.ts";
import { save } from "../server/storage.ts";
import { attachmentSource } from "../shared/attachments.ts";
import type { PaperBundle } from "../shared/types.ts";
import { validateAnchor } from "../shared/workspace.ts";

const paper: PaperBundle = {
  id: "study-a",
  version: "v1",
  title: "Exercise and muscle strength",
  scope: "Provided excerpt only",
  sources: [
    {
      id: "study-source",
      title: "Abstract",
      kind: "paper",
      text: "In this study, exercise and control groups were compared for muscle strength. The experiment compared outcomes after training.",
      locator: "PDF page 1",
      page: 1,
      verified: false,
      section: "overview",
    },
  ],
};
function harness() {
  const disk = new Map<string, unknown>(),
    inputs: any[] = [];
  const persist: typeof save = async (g, id, value) => {
    disk.set(`${g}/${id}`, structuredClone(value));
  };
  let imageStatus = "ready",
    imageDepends = false;
  const provider: Provider = {
    model: "attachment-depth-engineering-fixture",
    async generate(_rules, value, schema, _signal, image) {
      const input = value as any;
      inputs.push({ ...input, hasImage: !!image });
      let output: unknown;
      if (input.filename)
        output = {
          status: imageStatus,
          reason: imageStatus === "ready" ? "可辨认图形" : "请说明用途",
          description: "可见两组训练示意，未提供论文页码。",
          dependsOnImage: imageDepends,
        };
      else if (input.draft)
        output = {
          issues: [],
          checkedSources: input.sources.references.map((s: any) => s.id),
          limitations: [],
        };
      else if (input.sources && !input.question)
        output = {
          summary: `研究对象：${input.title}`,
          questions: [`${input.title} 怎样比较训练与对照？`],
          sourceIds: [input.sources[0].id],
        };
      else {
        const unit = {
          title: "实验比较",
          question: input.question,
          sections: [
            {
              title: "核心比较",
              text: "实验比较训练和对照。",
              kind:
                input.responseMode === "explain"
                  ? "background"
                  : input.sources?.references.some(
                        (s: any) => s.kind === "paper",
                      )
                    ? "paper"
                    : "interpretation",
              citations:
                input.responseMode === "explain"
                  ? []
                  : [
                      input.sources.references.find(
                        (s: any) => s.kind === "paper",
                      )?.id ?? input.sources.references[0].id,
                    ],
            },
            {
              title: "证据关系",
              text: "不同组的结果需要结合对照解释。",
              kind: "background",
              citations: [],
            },
          ],
          terms: [],
          nextQuestion: "继续理解对照",
        };
        output = input.responseMode === "explain" ? unit : { unit, deck: null };
      }
      return { output: schema.parse(output) };
    },
  };
  const attachments = new Attachments(provider, persist, (id, bytes) =>
      persist("attachment-originals", id, { base64: bytes.toString("base64") }),
    ),
    conversations = new ConversationStore(persist),
    manager = new TaskManager(provider, persist);
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    async () => paper,
    persist,
    undefined,
    undefined,
    undefined,
    undefined,
    attachments,
  );
  return {
    disk,
    inputs,
    persist,
    provider,
    attachments,
    conversations,
    manager,
    assistant,
    setCheck: (status: string, depends: boolean) => {
      imageStatus = status;
      imageDepends = depends;
    },
  };
}
const image = () => createCanvas(50, 30).toBuffer("image/png");
test("image admission rejects forged formats and oversized dimensions before decoding; uploads are owned and idempotent", async () => {
  const h = harness();
  const good = await h.attachments.upload(
    "a",
    "chat",
    paper.id,
    "diagram.png",
    image(),
  );
  assert.equal(good.status, "unchecked");
  assert.ok(good.image?.startsWith("data:image/jpeg"));
  assert.equal(good.originalWidth, 50);
  assert.equal(good.originalHeight, 30);
  assert.equal(good.originalMime, "image/png");
  assert.equal(
    good.originalUrl,
    "/api/conversations/chat/attachments/a/original",
  );
  assert.equal(
    (h.disk.get("attachment-originals/a") as any).base64,
    image().toString("base64"),
  );
  assert.deepEqual(imageDimensions(image()), { width: 50, height: 30 });
  assert.deepEqual(
    await h.attachments.upload("a", "chat", paper.id, "diagram.png", image()),
    good,
  );
  await assert.rejects(
    h.attachments.upload("a", "other", paper.id, "diagram.png", image()),
    /其他文件或聊天/,
  );
  assert.throws(() => h.attachments.get("a", "other"), /不属于/);
  const fake = await h.attachments.upload(
    "fake",
    "chat",
    paper.id,
    "spoof.png",
    Buffer.from("not an image"),
  );
  assert.equal(fake.status, "failed");
  assert.equal(fake.image, undefined);
  const large = Buffer.from(image());
  large.writeUInt32BE(20000, 16);
  assert.equal(
    (await h.attachments.upload("large", "chat", paper.id, "large.png", large))
      .status,
    "failed",
  );
  assert.equal(
    (await h.attachments.upload("type", "chat", paper.id, "wrong.pdf", image()))
      .status,
    "failed",
  );
  assert.equal(h.inputs.length, 0);
});
test("high-resolution uploads keep original bytes while only model input is reduced", async () => {
  const h = harness(),
    bytes = createCanvas(3200, 1200).toBuffer("image/png");
  const value = await h.attachments.upload(
    "large-readable",
    "chat",
    paper.id,
    "figure.png",
    bytes,
  );
  assert.equal(value.status, "unchecked");
  assert.equal(value.originalWidth, 3200);
  assert.equal(value.modelWidth, 1800);
  assert.equal(value.modelHeight, 675);
  assert.deepEqual(
    Buffer.from(
      (h.disk.get("attachment-originals/large-readable") as any).base64,
      "base64",
    ),
    bytes,
  );
  const checked = await h.attachments.check(
    value.id,
    "chat",
    "解释比较",
    paper,
    new BudgetLedger("turn", async () => {}),
    new AbortController().signal,
  );
  assert.equal(attachmentSource(checked)!.displayImage, value.originalUrl);
  assert.equal(attachmentSource(checked)!.image, value.image);
  assert.equal(h.inputs.length, 1);
});
test("purpose checks reuse admitted source versions without inventing paper metadata and retry only the selected image", async () => {
  const h = harness();
  await h.attachments.upload("a", "chat", paper.id, "diagram.png", image());
  const ledger = new BudgetLedger("turn", async () => {}),
    signal = new AbortController().signal;
  const checked = await h.attachments.check(
    "a",
    "chat",
    "解释比较",
    paper,
    ledger,
    signal,
  );
  const source = attachmentSource(checked)!;
  assert.equal(source.kind, "interpretation");
  assert.equal(source.page, undefined);
  assert.equal(source.figure, undefined);
  assert.equal(source.verified, false);
  await h.attachments.check("a", "chat", "另一条问题", paper, ledger, signal);
  assert.equal(h.inputs.length, 1);
  await h.attachments.check(
    "a",
    "chat",
    "解释比较",
    { ...paper, version: "v2" },
    ledger,
    signal,
  );
  assert.equal(h.inputs.length, 2);
  h.setCheck("needs-purpose", true);
  await h.attachments.check(
    "a",
    "chat",
    "解释比较",
    paper,
    ledger,
    signal,
    undefined,
    true,
  );
  h.setCheck("ready", false);
  const retry = await h.attachments.check(
    "a",
    "chat",
    "解释比较",
    paper,
    ledger,
    signal,
    "补充比较示意",
    true,
  );
  assert.equal(retry.status, "ready");
  assert.equal(h.inputs.at(-1).purpose, "补充比较示意");
  assert.equal(ledger.state.limit, 7);
});
test("unrelated or unreadable images block only dependent questions; single-image retry resumes the same turn", async () => {
  const h = harness(),
    chat = await h.conversations.mainForPaper(paper.id);
  await h.attachments.upload(
    "image",
    chat.id,
    paper.id,
    "diagram.png",
    image(),
  );
  h.setCheck("unreadable", false);
  const first = await h.assistant.submit(chat.id, {
    clientMessageId: "first",
    mode: "live",
    question: "解释论文实验",
    module: "paper",
    attachmentIds: ["image"],
    readabilityCheck: false,
  });
  await h.assistant.wait(first.id);
  assert.equal(first.status, "completed", first.error);
  assert.equal(first.attachments![0].status, "unreadable");
  h.setCheck("needs-purpose", true);
  const second = await h.assistant.submit(chat.id, {
    clientMessageId: "second",
    mode: "live",
    question: "解释这张图中的比较",
    attachmentIds: ["image"],
  });
  await h.assistant.wait(second.id);
  assert.equal(second.status, "clarification");
  assert.equal(second.runId, undefined);
  const calls = h.inputs.length;
  h.setCheck("ready", true);
  await h.assistant.retryAttachment(
    second.id,
    "image",
    "这是对照组和实验组示意",
  );
  await h.assistant.wait(second.id);
  assert.equal(second.status, "completed", second.error);
  assert.equal(h.inputs.length - calls, 3); // check, teach, ground
  assert.deepEqual(h.conversations.get(chat.id).recentTurnIds, [
    first.id,
    second.id,
  ]);
  assert.ok(second.budget.attempts.length <= 7);
});
test("natural explanation depth persists per chat and uses the full previous answer; explicit quotation takes priority", async () => {
  const h = harness(),
    chat = await h.conversations.mainForPaper(paper.id);
  async function send(question: string, extra = {}) {
    const t = await h.assistant.submit(chat.id, {
      clientMessageId: question,
      mode: "live",
      question,
      ...extra,
    });
    await h.assistant.wait(t.id);
    assert.equal(t.status, "completed", t.error);
    return h.manager.runs.get(t.runId!)!;
  }
  const first = await send("一句话解释对照组");
  for (const [q, depth] of [
    ["再简单点", "brief"],
    ["详细点", "deep"],
    ["从基础讲", "foundations"],
    ["重点解释机制", "mechanism"],
  ]) {
    const run = await send(q);
    assert.equal(run.input.depth, depth);
    assert.equal(run.input.previous!.sections.length, 2);
    assert.match(run.input.previous!.sections[0].text, /训练/);
    assert.match(run.input.previous!.question, /对照组|简单|详细|基础/);
  }
  const focused = await send("简单点解释所选部分", {
    focus: { runId: first.id, sectionIndex: 0, excerpt: "比较训练" },
  });
  assert.equal(focused.input.focusedText, "比较训练");
  assert.equal(h.conversations.get(chat.id).explanationDepth, "brief");
  const other = await h.conversations.mainForPaper("study-b");
  assert.equal(other.explanationDepth, undefined);
});
test("research guides are grounded in each paper, cache by source content/version and do not regenerate after restart", async () => {
  const h = harness(),
    guides = new ReadingGuides(h.provider, new TaskScheduler(), h.persist);
  const wait = async (p: PaperBundle) => {
    for (
      let i = 0;
      i < 300 && ["queued", "running"].includes(guides.get(p).status!);
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(guides.get(p).status, "completed");
  };
  await guides.start(paper);
  await wait(paper);
  assert.match(guides.get(paper).summary!, /Exercise/);
  assert.deepEqual(guides.get(paper).sourceIds, ["study-source"]);
  await guides.start(paper);
  assert.equal(h.inputs.length, 1);
  const second = { ...paper, id: "study-b", title: "Inflammation and control" };
  await guides.start(second);
  await wait(second);
  assert.match(guides.get(second).questions[0], /Inflammation/);
  assert.equal(h.inputs.length, 2);
  const restored = new ReadingGuides(
    h.provider,
    new TaskScheduler(),
    h.persist,
  );
  await restored.restore(async <T>() =>
    [...h.disk]
      .filter(([key]) => key.startsWith("reading-guides/"))
      .map(([, v]) => structuredClone(v) as T),
  );
  await restored.start(paper);
  assert.equal(h.inputs.length, 2);
  assert.notEqual(
    restored.get({ ...paper, version: "v2" }).summary,
    guides.get(paper).summary,
  );
});
test("foreground tasks pass queued background guides and cancelling a queued guide sends no model call", async () => {
  const h = harness(),
    scheduler = new TaskScheduler(1),
    guides = new ReadingGuides(h.provider, scheduler, h.persist);
  let release!: () => void;
  const occupied = scheduler.run(
    "occupied",
    new AbortController().signal,
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  await guides.start(paper);
  assert.equal(guides.get(paper).status, "queued");
  let ran = false;
  const question = scheduler.run(
    "question",
    new AbortController().signal,
    async () => {
      ran = true;
      guides.cancel(paper.id);
    },
  );
  release();
  await occupied;
  await question;
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(ran);
  assert.equal(h.inputs.length, 0);
  assert.equal(guides.get(paper).status, "cancelled");
});
test("queued cancellation preserves attachment records and concurrent preferences survive the completed answer", async () => {
  const h = harness(),
    chat = await h.conversations.mainForPaper(paper.id);
  await h.attachments.upload(
    "queued-image",
    chat.id,
    paper.id,
    "diagram.png",
    image(),
  );
  let release!: () => void;
  const occupied = h.assistant.scheduler.run(
    `paper:${paper.id}`,
    new AbortController().signal,
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  const queued = await h.assistant.submit(chat.id, {
    clientMessageId: "queued",
    mode: "live",
    question: "解释论文实验",
    attachmentIds: ["queued-image"],
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.attachments![0].id, "queued-image");
  await h.assistant.cancel(queued.id);
  assert.equal(queued.attachments![0].status, "unchecked");
  assert.equal(h.inputs.length, 0);
  release();
  await occupied;
  const generate = h.provider.generate.bind(h.provider);
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      resume = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  h.provider.generate = async (rules, input, schema, signal, img) => {
    entered();
    await gate;
    return generate(rules, input, schema, signal, img);
  };
  const turn = await h.assistant.submit(chat.id, {
    clientMessageId: "preference",
    mode: "live",
    question: "一句话解释对照组",
  });
  await started;
  await h.conversations.update(chat.id, (state) => ({
    ...state,
    explanationDepth: "mechanism",
    preferenceRevision: 1,
  }));
  resume();
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "completed", turn.error);
  assert.equal(h.conversations.get(chat.id).explanationDepth, "mechanism");
});
test("PDF anchors preserve selected whitespace and validate against the actual paper/page, while invented text remains rejected", () => {
  const pdf = { ...paper, pdfUrl: "/api/papers/study-a/pdf" };
  const anchor = {
    paperId: paper.id,
    sourceVersion: paper.version,
    sourceId: "study-source",
    page: 1,
    textView: "pdf" as const,
    excerpt: "exercise\nand control groups",
  };
  assert.equal(validateAnchor(anchor, pdf).id, "study-source");
  assert.throws(
    () => validateAnchor({ ...anchor, excerpt: "invented experiment" }, pdf),
    /不属于/,
  );
  assert.throws(() => validateAnchor(anchor, paper), /不属于/);
  assert.throws(() => validateAnchor({ ...anchor, page: 2 }, pdf), /不属于/);
});
test("cancelling the first image check retains every submitted attachment and stops later checks", async () => {
  const h = harness(),
    chat = await h.conversations.mainForPaper(paper.id);
  for (const id of ["first-image", "second-image"])
    await h.attachments.upload(id, chat.id, paper.id, `${id}.png`, image());
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  h.provider.generate = async (_rules, _input, _schema, signal) => {
    entered();
    return await new Promise<never>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  };
  const turn = await h.assistant.submit(chat.id, {
    clientMessageId: "cancel-images",
    mode: "live",
    question: "解释这张图",
    attachmentIds: ["first-image", "second-image"],
  });
  await started;
  await h.assistant.cancel(turn.id);
  assert.equal(turn.status, "cancelled");
  assert.equal(turn.attachments!.length, 2);
  assert.equal(turn.attachments![0].status, "failed");
  assert.equal(turn.attachments![1].status, "unchecked");
  assert.equal(turn.budget.attempts.length, 1);
});
test("standalone screenshot discussions retain their sources for a depth follow-up", async () => {
  const h = harness(),
    chat = await h.conversations.create();
  await h.attachments.upload(
    "standalone",
    chat.id,
    null,
    "diagram.png",
    image(),
  );
  const first = await h.assistant.submit(chat.id, {
    clientMessageId: "standalone",
    mode: "live",
    question: "解释这张图的比较",
    attachmentIds: ["standalone"],
    readabilityCheck: false,
  });
  await h.assistant.wait(first.id);
  assert.equal(first.status, "completed", first.error ?? first.reply?.nextStep);
  const follow = await h.assistant.submit(chat.id, {
    clientMessageId: "simplify",
    mode: "live",
    question: "再简单点",
    readabilityCheck: false,
  });
  await h.assistant.wait(follow.id);
  assert.equal(follow.status, "completed", follow.error);
  assert.ok(
    h.manager.runs.get(follow.runId!)!.input.sourceIds.includes("standalone"),
  );
  assert.equal(h.conversations.get(chat.id).paperId, null);
});
