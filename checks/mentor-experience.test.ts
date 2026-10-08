import test from "node:test";
import assert from "node:assert/strict";
import { containsRenderedQuote, markdownText } from "../shared/markdown.ts";
import { ConversationStore } from "../server/conversation.ts";
import { resolveLearningIntent } from "../server/depth.ts";
import { SourceTranslations } from "../server/source-translation.ts";
import { TaskScheduler, taskKey } from "../server/scheduler.ts";
import {
  completeReading,
  prepareReading,
  readingUnits,
} from "../server/reading-session.ts";
import { validRecordShape } from "../server/record-shapes.ts";
import type { Provider } from "../server/provider.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { list, save } from "../server/storage.ts";

const paper: PaperBundle = {
  id: "translation-paper",
  title: "Control study",
  version: "v1",
  scope: "fixture",
  sources: [
    {
      id: "s1",
      kind: "paper",
      title: "Introduction",
      locator: "Page 1",
      text: "The control group received no treatment.",
      verified: true,
    },
  ],
};
function harness(fail = false) {
  let calls = 0;
  const records = new Map<string, any>();
  const persist: typeof save = async (g, id, data) => {
    records.set(`${g}/${id}`, structuredClone(data));
  };
  const provider: Provider = {
    id: "fixture",
    model: "translation-fixture",
    async generate(_rules, _input, schema) {
      calls++;
      if (fail) throw new Error("fixture transport failure");
      return { output: schema.parse({ translation: "对照组未接受处理。" }) };
    },
  };
  const scheduler = new TaskScheduler();
  const translations = new SourceTranslations(provider, scheduler, persist);
  return {
    translations,
    records,
    provider,
    persist,
    scheduler,
    calls: () => calls,
  };
}

test("Markdown visible quotations preserve emphasis, entities, links and tables without accepting hidden content", () => {
  const text =
    "## 结果\n\n**对照组**的 A &amp; B [观察](https://example.test/private)有效。\n\n|组别|结果|\n|---|---|\n|干预|减少|\n\n<!-- hidden -->";
  assert.ok(containsRenderedQuote(text, "对照组的 A & B 观察有效。"));
  assert.ok(containsRenderedQuote(text, "干预\t减少"));
  assert.ok(!containsRenderedQuote(text, "https://example.test/private"));
  assert.ok(!containsRenderedQuote(text, "hidden"));
  assert.ok(!containsRenderedQuote(text, "**对照组**"));
  assert.ok(!containsRenderedQuote(text, "不存在的结论"));
  assert.equal(
    markdownText("A\n\n`x_y` **strong** ~~removed~~"),
    "A x_y strong removed",
  );
});

test("new-paper defaults are snapshots, existing preference and PPT session do not replace reading", async () => {
  const defaults = { verbosity: "deep" as const, focus: "balanced" as const };
  const store = new ConversationStore(
    async () => {},
    () => defaults,
  );
  const ppt = await store.create({
    paperId: paper.id,
    purpose: "ppt-generation",
  });
  const reading = await store.mainForPaper(paper.id);
  assert.notEqual(ppt.id, reading.id);
  assert.equal(reading.learningPreferences?.verbosity, "deep");
  (defaults as any).verbosity = "brief";
  assert.equal(store.get(reading.id).learningPreferences?.verbosity, "deep");
  assert.equal((await store.create()).learningPreferences?.verbosity, "brief");
  assert.equal((await store.mainForPaper(paper.id)).id, reading.id);
  const message = {
    clientMessageId: "m",
    mode: "live" as const,
    question: "详细一点",
  };
  assert.equal(
    resolveLearningIntent(message, reading).preferenceScope,
    "conversation",
  );
  assert.equal(
    resolveLearningIntent({ ...message, question: "这一段详细一点" }, reading)
      .preferenceScope,
    "turn",
  );
  assert.equal(
    resolveLearningIntent(
      { ...message, focus: { runId: "r", sectionIndex: 0, excerpt: "对照组" } },
      reading,
    ).preferenceScope,
    "turn",
  );
});

test("translation concurrent requests, restart and model-specific cache spend once per content", async () => {
  const h = harness();
  const [a, b] = await Promise.all([
    h.translations.start(paper, "s1", 0, "request-a"),
    h.translations.start(paper, "s1", 0, "request-b"),
  ]);
  assert.equal(a.id, b.id);
  const done = await h.translations.wait(a.id);
  assert.equal(done.status, "completed");
  assert.equal(h.calls(), 1);
  assert.equal(done.budget.attempts.length, 1);
  const restored = new SourceTranslations(h.provider, h.scheduler, h.persist);
  await restored.restore((async () => [...h.records.values()]) as typeof list);
  assert.equal((await restored.start(paper, "s1", 0, "request-c")).id, a.id);
  h.provider.model = "new-model";
  const changed = await restored.start(paper, "s1", 0, "request-d");
  assert.notEqual(changed.id, a.id);
  await restored.wait(changed.id);
  assert.equal(h.calls(), 2);
  await assert.rejects(
    () => restored.start(paper, "s1", 0, "request-a"),
    /编号/,
  );
});

test("failed translations require explicit new request; queued cancellation never calls provider", async () => {
  const h = harness(true);
  const a = await h.translations.start(paper, "s1", 0, "fail-a");
  await h.translations.wait(a.id);
  assert.equal(
    (await h.translations.start(paper, "s1", 0, "fail-a")).status,
    "failed",
  );
  assert.equal(h.calls(), 1);
  const retry = await h.translations.start(paper, "s1", 0, "fail-b");
  await h.translations.wait(retry.id);
  assert.equal(h.calls(), 2);
  const block = new AbortController();
  let release!: () => void;
  const blocking = h.scheduler.run(
    taskKey(paper.id, "blocking"),
    block.signal,
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  const queued = await h.translations.start(paper, "s1", 0, "cancel-a");
  h.translations.cancel(queued.id);
  assert.equal((await h.translations.wait(queued.id)).status, "cancelled");
  assert.equal(h.calls(), 2);
  release();
  await blocking;
});

test("persistence failure cannot publish an accepted translation or spend; malformed records rejected", async () => {
  const h = harness();
  const broken = new SourceTranslations(h.provider, h.scheduler, async () => {
    throw new Error("disk full");
  });
  const results = await Promise.allSettled([
    broken.start(paper, "s1", 0, "same"),
    broken.start(paper, "s1", 0, "same"),
  ]);
  assert.ok(results.every((r) => r.status === "rejected"));
  assert.equal(h.calls(), 0);
  assert.equal(
    validRecordShape("source-translations", { id: "bad", budget: {} }),
    false,
  );
  assert.equal(
    validRecordShape("tutor-research", { id: "bad", sources: "bad" }),
    false,
  );
  await assert.rejects(
    () => h.translations.start(paper, "s1", 1, "bad-range"),
    /范围/,
  );
});

test("new reading ranges respect paragraph boundaries, preserve legacy cursors and summarize beyond last six units", () => {
  const long = {
    ...paper,
    sources: [
      {
        ...paper.sources[0],
        text: ("A complete sentence. ".repeat(110) + "\n\n").repeat(4),
      },
    ],
  };
  const units = readingUnits(long);
  assert.equal(
    long.sources[0].text.slice(0, units[0].end).endsWith("\n\n"),
    true,
  );
  const old = completeReading(
    prepareReading(long, undefined, "start", "开始"),
    "first",
  );
  delete old.segmentation;
  old.delivered = [readingUnits(long, false)[0]];
  old.lastRanges = old.delivered;
  assert.equal(
    prepareReading(long, old, "continue", "继续").ranges[0].unitId,
    readingUnits(long, false)[1].unitId,
  );
  const many = {
    ...paper,
    sources: Array.from({ length: 9 }, (_, i) => ({
      ...paper.sources[0],
      id: `part${i}`,
      text: `Section ${i} reports the evidence.`,
    })),
  };
  let state = completeReading(
    prepareReading(many, undefined, "start", "开始"),
    "0",
  );
  for (let i = 1; i < 9; i++)
    state = completeReading(
      prepareReading(many, state, "continue", "继续"),
      String(i),
    );
  const summary = prepareReading(many, state, "summary", "总结");
  assert.equal(summary.ranges.length, 9);
  assert.equal(summary.ranges[0].sourceId, "part0");
  const deep = prepareReading(many, state, "deepen", "最后这段详细讲");
  assert.equal(deep.summary, false);
  assert.equal(deep.ranges[0].sourceId, "part8");
  const boundary = {
    ...paper,
    sources: [
      { ...paper.sources[0], text: "a".repeat(2600) + "\n" + "b".repeat(2600) },
    ],
  };
  assert.equal(readingUnits(boundary, false)[0].end, 2601);
  const figures = {
    ...paper,
    sources: [
      {
        ...paper.sources[0],
        text: "Controls are in Extended Data Fig. 1. Main results are in Fig. 2.",
      },
      {
        ...paper.sources[0],
        id: "main-1",
        figure: "1",
        image: "fixture",
        text: "Figure 1",
      },
      {
        ...paper.sources[0],
        id: "main-2",
        figure: "2",
        image: "fixture",
        text: "Figure 2",
      },
    ],
  };
  assert.deepEqual(
    prepareReading(figures, undefined, "start", "开始").paper.sources.map(
      (s) => s.id,
    ),
    ["s1", "main-2"],
  );
});
