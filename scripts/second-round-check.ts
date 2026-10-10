// Explicit opt-in real model verification. Uses isolated records, not the user's chats.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { CodexProvider, type Provider } from "../server/provider.ts";
import { localSample } from "../server/sample.ts";
import { Attachments } from "../server/attachments.ts";
import { AssistantService } from "../server/assistant.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { ConversationStore } from "../server/conversation.ts";
import { DeckVersions } from "../server/deck-versions.ts";
import { ReadingGuides } from "../server/reading-guides.ts";
import { BudgetLedger } from "../server/budget.ts";
import { TaskScheduler } from "../server/scheduler.ts";
import { save } from "../server/storage.ts";
if (!process.argv.includes("--generate")) {
  console.log(
    "加 --generate 运行真实模型验收，最多 16 次调用。结果在 runs/second-round/live/。",
  );
  process.exit(0);
}
const path = process.argv.includes("--parallel")
  ? "runs/second-round/live-parallel"
  : "runs/second-round/live";
await mkdir(path, { recursive: true });
const disk = new Map<string, unknown>(),
  cases: unknown[] = [],
  calls: unknown[] = [];
const persist: typeof save = async (g, id, value) => {
  disk.set(`${g}/${id}`, structuredClone(value));
};
const actual = new CodexProvider();
let count = 0,
  concurrent = 0,
  maximumConcurrent = 0;
const provider: Provider = {
  model: actual.model,
  settings: actual.settings,
  async generate(instructions, input, schema, signal, image) {
    const number = ++count;
    if (number > 16) throw new Error("真实验收已达 16 次调用上限。");
    concurrent++;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    console.log(
      `模型调用 ${count} · ${(input as any).filename ?? (input as any).question ?? ((input as any).draft ? "核对" : "阅读起点")}`,
    );
    const start = Date.now();
    try {
      const result = await actual.generate(
        instructions,
        input,
        schema,
        signal,
        image,
      );
      calls.push({
        number,
        input,
        image: !!image,
        output: result.output,
        usage: result.usage,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error) {
      calls.push({
        number,
        input,
        image: !!image,
        error: String(error),
        durationMs: Date.now() - start,
      });
      throw error;
    } finally {
      concurrent--;
      await writeFile(`${path}/calls.json`, JSON.stringify(calls, null, 2));
    }
  },
};
const paper = await localSample(),
  attachments = new Attachments(provider, persist);
const paperById = async () => ({
  ...paper,
  sources: [...paper.sources, ...attachments.sources(paper.id)],
});
const scheduler = new TaskScheduler(),
  conversations = new ConversationStore(persist),
  manager = new TaskManager(provider, persist);
const decks = new DeckVersions(
  provider,
  paperById,
  persist,
  undefined,
  scheduler,
);
const assistant = new AssistantService(
  provider,
  manager,
  conversations,
  paperById,
  persist,
  undefined,
  undefined,
  decks,
  scheduler,
  attachments,
);
let outcome = "running";
try {
  if (process.argv.includes("--parallel")) {
    const chats = await Promise.all([
      conversations.create(),
      conversations.create(),
      conversations.create(),
    ]);
    const first = await assistant.submit(chats[0].id, {
      clientMessageId: crypto.randomUUID(),
      mode: "live",
      question: "一句话解释实验对照组的用途。",
    });
    const second = await assistant.submit(chats[1].id, {
      clientMessageId: crypto.randomUUID(),
      mode: "live",
      question: "一句话解释重复实验的用途。",
    });
    for (let i = 0; i < 500 && count < 2; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(count, 2);
    const third = await assistant.submit(chats[2].id, {
      clientMessageId: crypto.randomUUID(),
      mode: "live",
      question: "一句话解释实验盲法的用途。",
    });
    assert.equal(third.status, "queued");
    await assistant.cancel(third.id);
    await Promise.all([assistant.wait(first.id), assistant.wait(second.id)]);
    assert.equal(first.status, "completed", first.error);
    assert.equal(second.status, "completed", second.error);
    assert.equal(third.budget.attempts.length, 0);
    assert.equal(maximumConcurrent, 2);
    cases.push({
      kind: "parallel",
      statuses: [first.status, second.status, third.status],
      maximumConcurrent,
      queuedAttempts: third.budget.attempts.length,
      outputs: [first.reply?.content, second.reply?.content],
    });
  } else {
    const chat = await conversations.mainForPaper(paper.id);
    for (const question of [
      "一句话解释实验对照组的用途。",
      "再详细点，继续解释对照组。",
      "从基础讲，继续解释对照组。",
      "重点解释机制：对照组怎样帮助排除其他影响？",
    ]) {
      const turn = await assistant.submit(chat.id, {
        clientMessageId: crypto.randomUUID(),
        mode: "live",
        question,
      });
      await assistant.wait(turn.id);
      cases.push({
        kind: "depth",
        question,
        status: turn.status,
        error: turn.error,
        depth: conversations.get(chat.id).explanationDepth,
        output: turn.reply?.content,
        attempts: turn.budget.attempts.length,
      });
      assert.equal(turn.status, "completed", turn.error);
    }
    const figure = paper.sources.find(
      (s) => s.figure?.startsWith("1") && s.image,
    );
    assert.ok(figure?.image, "缺少本机论文的 Figure 1 原始图件");
    const bytes = Buffer.from(figure.image.split(",")[1], "base64");
    const drawing = createCanvas(600, 300),
      ctx = drawing.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 600, 300);
    ctx.fillStyle = "black";
    ctx.font = "32px sans-serif";
    ctx.fillText("Shopping list", 25, 60);
    ctx.fillText("Milk / Apples / Bread", 25, 130);
    const unrelated = drawing.toBuffer("image/png");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 600, 300);
    const blank = drawing.toBuffer("image/png");
    const ledger = new BudgetLedger("image-acceptance", async () => {});
    for (const [id, filename, data, question] of [
      [
        "related",
        "figure1.jpg",
        bytes,
        "这是论文 Figure 1 的截图，用于理解实验组和对照组的比较。",
      ],
      [
        "unclear",
        "unknown.jpg",
        bytes,
        "附件先留作备查，我只想知道这篇论文的研究问题。",
      ],
      [
        "unrelated",
        "shopping.png",
        unrelated,
        "附件先留作备查，我只想知道这篇论文的研究问题。",
      ],
      ["blank", "blank.png", blank, "仅根据这张图片解释它包含的实验数据。"],
    ] as const) {
      await attachments.upload(id, chat.id, paper.id, filename, data);
      const checked = await attachments.check(
        id,
        chat.id,
        question,
        paper,
        ledger,
        AbortSignal.timeout(180_000),
      );
      cases.push({
        kind: "image",
        id,
        status: checked.status,
        reason: checked.reason,
        dependsOnImage: checked.dependsOnImage,
        description: checked.description,
      });
      assert.notEqual(checked.status, "failed", checked.reason);
    }
    const before = calls.length;
    const visual = await assistant.submit(chat.id, {
      clientMessageId: crypto.randomUUID(),
      mode: "live",
      question:
        "这张截图中的 Fig.1 主要比较哪两类细胞？只解释比较对象和研究问题，不展开实验数值。",
      attachmentIds: ["related"],
      readabilityCheck: false,
    });
    await assistant.wait(visual.id);
    cases.push({
      kind: "image-answer",
      status: visual.status,
      error: visual.error,
      output: visual.reply?.content,
      calls: calls.length - before,
    });
    assert.equal(visual.status, "completed", visual.error);
    const guides = new ReadingGuides(provider, scheduler, persist);
    await guides.start(paper);
    for (
      let i = 0;
      i < 1800 && ["queued", "running"].includes(guides.get(paper).status!);
      i++
    )
      await new Promise((r) => setTimeout(r, 100));
    cases.push({ kind: "guide", result: guides.get(paper) });
    assert.equal(
      guides.get(paper).status,
      "completed",
      guides.get(paper).error,
    );
    const ppt = await assistant.submit(chat.id, {
      clientMessageId: crypto.randomUUID(),
      mode: "live",
      module: "ppt",
      slideCount: 3,
      sourceIds: ["xu-question", "xu-fig1"],
      question:
        "生成三页简短 PPT 汇报，围绕研究问题、比较对象及证据边界。每页讲稿不超过200字。",
      readabilityCheck: false,
    });
    await assistant.wait(ppt.id);
    cases.push({
      kind: "ppt",
      status: ppt.status,
      error: ppt.error,
      versionId: ppt.reply?.deckVersionId,
    });
    assert.equal(ppt.status, "completed", ppt.error);
    const version = decks.get(ppt.reply!.deckVersionId!);
    assert.equal(version.outline.slides.length, 3);
    const edited = await decks.start(version.id, chat.id, {
      slideIndex: 0,
      question:
        "第一页面向科研新手，用简短的日常语言介绍研究问题。保留引用，讲稿100字以内。",
    });
    const final = await decks.wait(edited.id);
    cases.push({
      kind: "ppt-edit",
      status: final.status,
      error: final.error,
      outline: final.outline,
    });
    assert.equal(final.status, "completed", final.error);
    for (let i = 1; i < 3; i++)
      assert.deepEqual(final.outline.slides[i], version.outline.slides[i]);
    const artifact = await decks.export(final.id, chat.id);
    cases.push({ kind: "export", artifact });
  }
  outcome = "passed";
} catch (error) {
  cases.push({ kind: "failure", error: String(error) });
  outcome = "failed";
  process.exitCode = 1;
} finally {
  await writeFile(
    `${path}/report.json`,
    JSON.stringify(
      {
        status: outcome,
        model: actual.model,
        modelCalls: calls.length,
        maximumConcurrent,
        paper: { id: paper.id, version: paper.version, title: paper.title },
        cases,
      },
      null,
      2,
    ),
  );
  await writeFile(`${path}/records.json`, JSON.stringify([...disk], null, 2));
  console.log(
    JSON.stringify({
      status: outcome,
      modelCalls: calls.length,
      report: `${path}/report.json`,
    }),
  );
}
