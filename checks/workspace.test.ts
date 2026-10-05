import test from "node:test";
import assert from "node:assert/strict";
import { Projects } from "../server/projects.ts";
import { readingStart, validateAnchor } from "../shared/workspace.ts";
import type {
  ResearchTurn,
  SourceAnchor,
  WorkspaceIndex,
} from "../shared/workspace.ts";
import { ConversationStore } from "../server/conversation.ts";
import { AssistantService } from "../server/assistant.ts";
import { TaskManager } from "../server/orchestrator.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { Provider } from "../server/provider.ts";
import { save, read } from "../server/storage.ts";
import { sample } from "../examples/bundle.ts";
import { createCanvas } from "@napi-rs/canvas";

const imported: PaperBundle = {
  id: "engineering-paper",
  title: "Exercise and muscle function.pdf",
  version: "text-v1",
  parseStatus: "ready",
  scope: "Synthetic engineering fixture, not a research finding.",
  sources: [
    {
      id: "engineering-p1",
      title: "PDF 第 1 页",
      kind: "paper",
      page: 1,
      locator: "PDF 第 1 页",
      verified: false,
      text: "Abstract: We compare exercise with a control group. Muscle function is measured at baseline and after training. The groups differ in exercise exposure. Introduction: Engineering fixture only.",
    },
  ],
};
const anchor: SourceAnchor = {
  paperId: imported.id,
  sourceVersion: imported.version,
  sourceId: imported.sources[0].id,
  excerpt: "We compare exercise with a control group.",
  page: 1,
};
function memory() {
  const disk = new Map<string, unknown>();
  const persist: typeof save = async (group, id, value) => {
    disk.set(`${group}/${id}`, structuredClone(value));
  };
  const load: typeof read = async <T>(group: string, id: string): Promise<T> =>
    structuredClone(disk.get(`${group}/${id}`)) as T;
  return { disk, persist, load };
}
test("concurrent project changes survive restart; regrouping preserves paper content and original title", async () => {
  const m = memory(),
    projects = new Projects(m.persist);
  const [a, b] = await Promise.all([
    projects.create("运动研究"),
    projects.create("方法学习"),
  ]);
  await Promise.all([
    projects.paper(imported.id, { projectId: a.id }),
    projects.edit(b.id, { name: "实验设计" }),
  ]);
  await projects.paper(imported.id, {
    projectId: b.id,
    displayName: "我的肌肉功能论文",
  });
  await projects.edit(b.id, { archived: true });
  const restored = new Projects(m.persist);
  await restored.restore(m.load);
  assert.equal(restored.snapshot().projects.length, 2);
  assert.equal(restored.snapshot().papers[0].projectId, b.id);
  assert.equal(imported.title, "Exercise and muscle function.pdf");
  assert.equal(imported.version, "text-v1");
  await assert.rejects(restored.paper("other", { projectId: b.id }), /已归档/);
  await restored.edit(b.id, { archived: false });
  await restored.paper("other", { projectId: b.id });
  assert.equal(restored.snapshot().papers.length, 2);
});
test("failed metadata persistence does not publish a change or block subsequent writes", async () => {
  let fail = true;
  const projects = new Projects(async () => {
    if (fail) throw new Error("disk full");
  });
  await assert.rejects(projects.create("失败课题"), /disk full/);
  assert.equal(projects.snapshot().projects.length, 0);
  fail = false;
  await projects.create("成功课题");
  assert.equal(projects.snapshot().projects.length, 1);
});
test("reading start uses the imported source and offers no invented figure; unreadable PDFs offer no questions", () => {
  const start = readingStart(imported);
  assert.equal(start.sourceVersion, imported.version);
  assert.ok(imported.sources[0].text.includes(start.excerpt));
  assert.match(start.label, /摘要/);
  assert.equal(start.questions.length, 3);
  assert.match(start.questions[0], /Exercise and muscle/);
  assert.ok(start.questions.every((q) => !q.includes("图表")));
  assert.equal(readingStart({ ...imported, sources: [] }).questions.length, 0);
});
test("source anchors reject another paper, changed version, page and invented excerpt", () => {
  assert.equal(validateAnchor(anchor, imported).id, anchor.sourceId);
  for (const patch of [
    { paperId: "wrong" },
    { sourceVersion: "old" },
    { page: 2 },
    { excerpt: "invented conclusion" },
    { sourceId: "xu-question" },
  ])
    assert.throws(
      () => validateAnchor({ ...anchor, ...patch }, imported),
      /不属于/,
    );
});
test("original text follow-up is grounded, title is automatic and user naming persists", async () => {
  const m = memory();
  let calls = 0;
  const lesson = {
    title: "How the comparison works",
    question: "解释这段原文",
    sections: [
      {
        title: "比较对象",
        text: "The source describes a comparison of exercise with a control group. It does not establish a clinical recommendation.",
        kind: "paper",
        citations: [anchor.sourceId],
      },
    ],
    terms: [],
    nextQuestion: "这篇论文如何测量功能？",
  };
  const provider: Provider = {
    model: "engineering-fixture",
    async generate(_instructions, input, schema) {
      calls++;
      const output =
        calls % 3 === 1
          ? { unit: lesson, deck: null }
          : calls % 3 === 2
            ? { understood: [], breakpoints: [] }
            : {
                issues: [],
                checkedSources: [anchor.sourceId],
                limitations: [],
              };
      return { output: schema.parse(output) };
    },
  };
  const conversations = new ConversationStore(m.persist),
    manager = new TaskManager(provider, m.persist);
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    async () => imported,
    m.persist,
  );
  let state = await conversations.create({ paperId: imported.id });
  const first = await assistant.submit(state.id, {
    clientMessageId: "anchor-valid",
    question: "解释这段原文",
    mode: "live",
    sourceAnchor: anchor,
  });
  await assistant.wait(first.id);
  assert.equal(first.status, "completed", first.error);
  assert.equal(
    manager.runs.get(first.runId!)!.input.focusedText,
    anchor.excerpt,
  );
  assert.equal(manager.runs.get(first.runId!)!.input.module, "paper");
  assert.equal(calls, 3);
  state = conversations.get(state.id);
  assert.equal(state.title, "解释这段原文");
  state.title = "我关心的实验对照";
  state.titleEdited = true;
  state = await conversations.put(state, state.version);
  const invalid = await assistant.submit(state.id, {
    clientMessageId: "anchor-invalid",
    question: "解释这句",
    mode: "live",
    sourceAnchor: { ...anchor, sourceVersion: "stale" },
  });
  await assistant.wait(invalid.id);
  assert.equal(invalid.status, "failed");
  assert.equal(calls, 3);
  assert.equal(conversations.get(state.id).title, "我关心的实验对照");
  const projects = new Projects(m.persist);
  const note = await projects.saveAnswer(
    state,
    { ...first, run: manager.runs.get(first.runId!) },
    imported,
  );
  const same = await projects.saveAnswer(
    state,
    { ...first, run: manager.runs.get(first.runId!) },
    imported,
  );
  assert.equal(note.id, same.id);
  assert.equal(projects.snapshot().notes.length, 1);
  assert.equal(note.anchors[0].sourceVersion, imported.version);
  const edited = await projects.editNote(note.id, {
    title: "对照笔记",
    text: "我自己的理解",
    updatedAt: note.updatedAt,
  });
  assert.deepEqual(edited.anchors, note.anchors);
  assert.deepEqual(edited.evidence, note.evidence);
  await assert.rejects(
    projects.editNote(note.id, {
      title: "旧版本",
      text: "不能覆盖",
      updatedAt: note.updatedAt,
    }),
    /已更新/,
  );
  await assert.rejects(
    projects.saveAnswer(state, { ...invalid, run: undefined }),
    /已经完成/,
  );
  const restored = new Projects(m.persist);
  await restored.restore(m.load);
  assert.equal(restored.snapshot().notes[0].text, "我自己的理解");
});
test("another paper's registered figure is rejected before model calls", async () => {
  const m = memory();
  let calls = 0;
  const provider: Provider = {
    model: "should-not-run",
    async generate() {
      calls++;
      throw new Error("unexpected generation");
    },
  };
  const conversations = new ConversationStore(m.persist),
    manager = new TaskManager(provider, m.persist);
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    async () => imported,
    m.persist,
  );
  const state = await conversations.create({ paperId: imported.id });
  const turn = await assistant.submit(state.id, {
    clientMessageId: "other-figure",
    question: "带我看这张图",
    mode: "live",
    figureSourceId: sample.sources.find((s) => s.figure)!.id,
  });
  await assistant.wait(turn.id);
  assert.equal(turn.status, "failed");
  assert.equal(calls, 0);
});
test("registered figure resolves its server image without mutating the deduplicated message", async () => {
  const m = memory();
  const image = createCanvas(16, 16).toDataURL("image/png");
  const paper = structuredClone(imported);
  paper.sources.push({
    id: "engineering-figure1",
    title: "Figure 1",
    figure: "1",
    image,
    caption:
      "Figure 1. Exercise and control groups are compared for muscle function.",
    text: "Figure 1. Exercise and control groups are compared for muscle function.",
    kind: "paper",
    page: 1,
    locator: "Figure 1 caption",
    verified: false,
  });
  let calls = 0,
    receivedImage: string | undefined;
  const provider: Provider = {
    model: "figure-fixture",
    async generate(_instructions, _input, schema, _signal, visibleImage) {
      if (visibleImage) receivedImage = visibleImage;
      const output =
        calls++ === 0
          ? {
              unit: {
                title: "Caption comparison",
                question: "带我看这张图",
                sections: [
                  {
                    title: "比较",
                    text: "The caption compares exercise and control groups for muscle function. No further result is established by this engineering fixture.",
                    kind: "paper",
                    citations: ["engineering-figure1"],
                  },
                ],
                terms: [],
                nextQuestion: "这张图的比较对象是什么？",
              },
              deck: null,
            }
          : calls === 2
            ? { understood: [], breakpoints: [] }
            : {
                issues: [],
                checkedSources: ["engineering-figure1"],
                limitations: [],
              };
      return { output: schema.parse(output) };
    },
  };
  const conversations = new ConversationStore(m.persist),
    manager = new TaskManager(provider, m.persist);
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    async () => paper,
    m.persist,
  );
  const state = await conversations.create({ paperId: paper.id });
  const message = {
    clientMessageId: "stored-figure",
    question: "带我看这张图",
    mode: "live" as const,
    figureSourceId: "engineering-figure1",
  };
  const turn = await assistant.submit(state.id, message);
  await assistant.wait(turn.id);
  assert.equal(turn.status, "completed", turn.error);
  assert.equal(receivedImage, image);
  assert.equal(manager.runs.get(turn.runId!)!.input.visibleImage, image);
  assert.equal((await assistant.submit(state.id, { ...message })).id, turn.id);
  assert.equal(calls, 3);
  assert.equal("visibleImage" in message, false);
});

test("reading positions verify the conversation binding and invalidate old source versions", async () => {
  const m = memory(),
    projects = new Projects(m.persist),
    conversations = new ConversationStore(m.persist);
  const state = await conversations.create({ paperId: imported.id });
  const position = {
    conversationId: state.id,
    paperId: imported.id,
    sourceVersion: imported.version,
    sourceId: anchor.sourceId,
    panel: "sources" as const,
  };
  await projects.position(state, imported, position);
  await assert.rejects(
    projects.position(state, imported, { ...position, paperId: "other" }),
    /不匹配/,
  );
  await assert.rejects(
    projects.position(state, imported, { ...position, sourceVersion: "old" }),
    /已过期/,
  );
  const restored = new Projects(m.persist);
  await restored.restore(m.load);
  assert.equal(restored.snapshot().lastConversationId, state.id);
  assert.equal(
    restored.validatePosition(position, { ...imported, version: "new" })
      .sourceId,
    undefined,
  );
  assert.equal(
    (m.disk.get("workspace/index") as WorkspaceIndex).positions.length,
    1,
  );
});
