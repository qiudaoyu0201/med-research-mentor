import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { z } from "zod";
import { createCanvas } from "@napi-rs/canvas";
import {
  AssistantService,
  rulePlan,
  validatePlan,
} from "../server/assistant.ts";
import { ConversationStore } from "../server/conversation.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { BudgetLedger, normalizeUsage } from "../server/budget.ts";
import { ProviderFailure, type Provider } from "../server/provider.ts";
import { materialPacket } from "../server/materials.ts";
import { ResultCache } from "../server/cache.ts";
import { sample, exampleUnits, defaultDeck } from "../examples/bundle.ts";
import type {
  AssistantMessage,
  PaperBundle,
  TaskRun,
} from "../shared/types.ts";
import { save } from "../server/storage.ts";
import { DeckVersions } from "../server/deck-versions.ts";
import { exportDeck } from "../server/export.ts";
import { LearningRecords } from "../server/learning-records.ts";

const novice = { understood: ["原理"], breakpoints: [] };
const review = { issues: [], checkedSources: ["qpcr-basics"], limitations: [] };
function fixture(outputs: unknown[]): Provider {
  return {
    model: "deterministic-fixture",
    async generate(_i, _x, schema, signal) {
      signal.throwIfAborted();
      return {
        output: schema.parse(outputs.shift()),
        usage: { last: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
      };
    },
  };
}
function harness(
  outputs: unknown[],
  paper: PaperBundle = sample,
  cache?: ResultCache,
  enableDeckVersions = false,
) {
  const records = new Map<string, unknown>();
  const persist: typeof save = async (g, id, value) => {
    records.set(`${g}/${id}`, structuredClone(value));
  };
  const provider = fixture(outputs);
  const manager = new TaskManager(provider, persist);
  const conversations = new ConversationStore(persist);
  const decks = enableDeckVersions
    ? new DeckVersions(
        provider,
        async () => structuredClone(paper),
        persist,
        async () => "fixture.pptx",
      )
    : undefined;
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    async () => structuredClone(paper),
    persist,
    cache,
    exportDeck,
    decks,
  );
  return { assistant, manager, conversations, records, provider, decks };
}
const method: AssistantMessage = {
  clientMessageId: "first",
  question: "PCR 原理是什么？",
  mode: "live",
};
const lesson = { unit: exampleUnits.qpcr, deck: null };
test("ordinary explanations exclude unexpected slides from checks, revisions and delivered artifacts", async () => {
  for (const module of ["paper", "method"] as const) {
    const content = module === "paper" ? exampleUnits.paper : lesson.unit;
    const injected = {
      unit: content,
      deck: {
        slides: defaultDeck.slides.map(
          ({ imageSource: _imageSource, ...slide }) => ({
            ...slide,
            citations: content.sections.flatMap((s) => s.citations),
          }),
        ),
      },
    };
    const open = {
      ...review,
      checkedSources: content.sections.flatMap((s) => s.citations),
      issues: [
        {
          id: "gap",
          type: "teaching",
          severity: "warning",
          location: content.sections[0].title,
          claim: "解释",
          evidence: [],
          suggestion: "补充解释",
          resolved: false,
        },
      ],
    };
    const h = harness(
      [injected, novice, open, injected, novice, { ...open, issues: [] }],
      sample,
      undefined,
      true,
    );
    const state = await h.conversations.create({ paperId: sample.id });
    const turn = await h.assistant.submit(state.id, {
      clientMessageId: `no-extra-${module}`,
      question:
        module === "paper" ? "请讲解这篇论文的研究问题和证据" : method.question,
      mode: "live",
      module,
      depth: "deep",
    });
    await h.assistant.wait(turn.id);
    assert.equal(turn.status, "completed", turn.error);
    const run = h.manager.runs.get(turn.runId!)!;
    assert.equal(run.calls, 6);
    assert.equal(run.deck, undefined);
    for (const role of run.roles.filter((r) => r.role !== "teaching")) {
      assert.equal((role.input as any).deck ?? null, null, role.role);
      assert.equal((role.input as any).presentation ?? null, null, role.role);
    }
    assert.equal(
      turn.reply!.artifacts.some((a) => a.kind === "pptx"),
      false,
    );
    assert.equal(h.decks!.versions.size, 0);
    assert.equal(h.conversations.get(state.id).latestDeckVersionId, undefined);
  }
});
test("an ordinary explanation cache cannot reintroduce an unexpected presentation", async () => {
  const cached = new Map<string, unknown>();
  const cache = new ResultCache(
    "scope-cache",
    async (_g, id, value) => {
      cached.set(id, structuredClone(value));
    },
    async <T>(_g: string, id: string) => {
      if (!cached.has(id))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return cached.get(id) as T;
    },
  );
  const h = harness([lesson, novice, review], sample, cache, true);
  const first = await h.conversations.create({ paperId: sample.id });
  const original = await h.assistant.submit(first.id, method);
  await h.assistant.wait(original.id);
  assert.equal(original.status, "completed", original.error);
  assert.equal(cached.size, 1);
  for (const value of cached.values())
    (value as TaskRun).deck = structuredClone(defaultDeck);
  const next = await h.conversations.create({ paperId: sample.id });
  const turn = await h.assistant.submit(next.id, method);
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "completed", turn.error);
  const run = h.manager.runs.get(turn.runId!)!;
  assert.ok(run.cacheHit);
  assert.equal(run.calls, 0);
  assert.equal(run.deck, undefined);
  assert.equal(h.decks!.versions.size, 0);
  assert.equal(turn.reply!.artifacts.length, 0);
});
test("隔离损坏会话后，其健康回答不阻断其他聊天恢复，也不被删除", async () => {
  const h = harness([lesson, novice, review]);
  const state = await h.conversations.create({ paperId: sample.id });
  const accepted = await h.assistant.submit(state.id, method);
  await h.assistant.wait(accepted.id);
  const turn = structuredClone(h.assistant.turns.get(accepted.id)!);
  const orphan = {
    ...turn,
    id: "orphan-turn",
    conversationId: "quarantined-chat",
  };
  const restored = harness([]);
  await restored.assistant.restore(
    async <T>(group: string): Promise<T[]> =>
      (group === "conversations"
        ? [h.conversations.get(state.id)]
        : group === "turns"
          ? [turn, orphan]
          : []) as T[],
  );
  assert.ok(restored.conversations.states.has(state.id));
  assert.ok(restored.assistant.turns.has(turn.id));
  assert.ok(restored.assistant.turns.has(orphan.id));
  assert.equal(restored.records.has("turns/orphan-turn"), false);
});
test("generic PPT requests with methods keep paper evidence and do not ask for a method name", async () => {
  const h = harness([]),
    state = await h.conversations.create({ paperId: sample.id });
  const plan = rulePlan(
    {
      clientMessageId: "generic-ppt",
      mode: "live",
      module: "ppt",
      question: "根据论文生成汇报，说明核心问题、方法、证据及局限。",
    },
    state,
    sample,
  )!;
  assert.equal(plan.clarification, null);
  assert.ok(plan.modules.includes("ppt"));
  assert.ok(plan.sourceIds.includes("xu-question"));
});
test("optional full speech reaches PPT generation, grounding and saved deck without extra compose calls", async () => {
  const script =
    "# 开场\n介绍本次汇报。\n# 逐页讲述\n根据页面解释证据。\n# 转场\n下面讨论边界。\n# 结尾\n谢谢。";
  const h = harness(
    [
      {
        unit: exampleUnits.paper,
        deck: { ...defaultDeck, speechScript: script },
      },
      {
        issues: [],
        checkedSources: ["xu-question"],
        limitations: ["固定响应工程验证"],
      },
    ],
    undefined,
    undefined,
    true,
  );
  const state = await h.conversations.create({ paperId: sample.id });
  const turn = await h.assistant.submit(state.id, {
    clientMessageId: "speech-compose-test",
    paperId: sample.id,
    mode: "live",
    module: "ppt",
    question: "根据论文生成汇报",
    sourceIds: sample.sources.map((s) => s.id),
    speechScript: true,
  });
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "completed", turn.error);
  const run = h.manager.runs.get(turn.runId!)!;
  assert.equal(run.input.speechScript, true);
  assert.equal(run.calls, 2);
  assert.equal((run.roles[0].input as any).speechScript, true);
  assert.equal((run.roles[1].input as any).deck.speechScript, script);
  assert.equal([...h.decks!.versions.values()][0].outline.speechScript, script);
});
test("shared intent reaches all roles; foundational and focused core learning cannot disable novice checks", async () => {
  const h = harness([lesson, novice, review, lesson, novice, review]);
  const state = await h.conversations.create();
  await h.conversations.update(state.id, (s) => ({
    ...s,
    learningPreferences: { verbosity: "brief", focus: "research-reasoning" },
  }));
  const first = await h.assistant.submit(state.id, {
    ...method,
    depth: "deep",
    learningIntent: { verbosity: "brief" },
    readabilityCheck: false,
  });
  await h.assistant.wait(first.id);
  assert.equal(first.status, "completed", first.error);
  const run = h.manager.runs.get(first.runId!)!;
  assert.deepEqual(
    run.roles.map((r) => r.role),
    ["teaching", "novice", "grounding"],
  );
  for (const role of run.roles)
    assert.deepEqual((role.input as any).learningIntent, first.learningIntent);
  const student = run.roles[1].input as any;
  assert.equal(student.learningIntent.focus, "research-reasoning");
  assert.equal(student.learningIntent.verbosity, "brief");
  assert.equal(student.sources, undefined);
  assert.equal(student.review, undefined);
  assert.equal(student.previous, undefined);
  const section = first.reply!.content!.sections[0];
  const second = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "foundation-focus",
    question: "从基础讲，我还是不懂",
    focus: {
      runId: run.id,
      sectionIndex: 0,
      excerpt: section.text.slice(0, 12),
    },
    readabilityCheck: false,
  });
  await h.assistant.wait(second.id);
  assert.equal(second.status, "completed", second.error);
  assert.equal(second.learningIntent?.focus, "foundations");
  assert.equal(second.budget.attempts.length, 3);
  assert.deepEqual(h.conversations.get(state.id).learningPreferences, {
    verbosity: "brief",
    focus: "research-reasoning",
  });
});

test("future language stores chat preferences while a simple turn preserves them and paper rebinding updates scope", async () => {
  const h = harness([
    lesson,
    novice,
    review,
    lesson,
    novice,
    review,
    lesson,
    novice,
    review,
  ]);
  const state = await h.conversations.create();
  const persistent = await h.assistant.submit(state.id, {
    ...method,
    question: "以后都详细点，重点讲研究思路，PCR 原理是什么？",
  });
  await h.assistant.wait(persistent.id);
  assert.equal(persistent.status, "completed", persistent.error);
  assert.deepEqual(h.conversations.get(state.id).learningPreferences, {
    verbosity: "deep",
    focus: "research-reasoning",
  });
  const current = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "brief-only",
    question: "这一段简单点解释 PCR",
  });
  await h.assistant.wait(current.id);
  assert.equal(current.status, "completed", current.error);
  assert.equal(current.learningIntent?.verbosity, "brief");
  assert.equal(current.learningIntent?.focus, "research-reasoning");
  assert.equal(
    h.conversations.get(state.id).learningPreferences?.verbosity,
    "deep",
  );
  const bound = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "bound",
    paperId: sample.id,
  });
  await h.assistant.wait(bound.id);
  assert.equal(bound.status, "completed", bound.error);
  assert.equal(bound.learningIntent?.scope.paperId, sample.id);
  assert.equal(bound.learningIntent?.scope.sourceVersion, sample.version);
  assert.deepEqual(
    bound.learningIntent?.scope.sourceIds,
    bound.plan?.sourceIds,
  );
});
test("the next explanation carries explicit user feedback without turning teaching into mastery", async () => {
  const h = harness([lesson, novice, review, lesson, novice, review]);
  let state = await h.conversations.create();
  const first = await h.assistant.submit(state.id, method);
  await h.assistant.wait(first.id);
  state = h.conversations.get(state.id);
  const records = new LearningRecords(h.conversations, (id) =>
    h.manager.runs.get(id),
  );
  state = await records.create(state.id, state.version, {
    kind: "feedback",
    unitId: first.runId,
    feedback: "confused",
    text: "我仍不懂对照如何排除背景信号。",
  });
  const second = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "after-feedback",
    question: "还是不懂这个对照",
  });
  await h.assistant.wait(second.id);
  assert.equal(second.status, "completed", second.error);
  assert.match(
    h.manager.runs.get(second.runId!)!.input.contextSummary!,
    /用户主动反馈（非能力评估）.*仍不懂对照/,
  );
  assert.equal(h.conversations.get(state.id).userProgress[0].state, "confused");
  assert.equal(
    h.conversations.get(state.id).learningRecords![0].feedback,
    "confused",
  );
});
test("natural single-page request continues the current report within the same conversation ledger", async () => {
  const h = harness(
    [
      { ...defaultDeck.slides[1], title: "通俗的研究问题" },
      { issues: [], checkedSources: ["xu-question"], limitations: [] },
    ],
    sample,
    undefined,
    true,
  );
  let state = await h.conversations.create({ paperId: sample.id });
  const parent = await h.decks!.seed(state.id, sample.id);
  state.sourceVersion = parent.sourceVersion;
  state.latestDeckVersionId = parent.id;
  state = await h.conversations.put(state, state.version);
  const turn = await h.assistant.submit(state.id, {
    ...method,
    question: "修改第二页，把问题讲通俗一些。",
  });
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "completed", turn.error);
  assert.equal(turn.budget.attempts.length, 2);
  assert.equal(turn.reply?.artifacts.length, 1);
  const version = h.decks!.get(turn.reply!.deckVersionId!);
  assert.equal(version.parentId, parent.id);
  assert.equal(h.conversations.get(state.id).latestDeckVersionId, version.id);
  assert.deepEqual(version.outline.slides[4], parent.outline.slides[4]);
});

const backgroundLesson = {
  title: "对照是什么",
  question: "用一句话解释对照",
  sections: [
    {
      title: "背景解释",
      text: "对照提供一个比较基准，帮助判断观察到的差异与哪种改变有关。",
      kind: "background",
      citations: [],
    },
  ],
  terms: [],
  nextQuestion: "要看一个例子吗？",
};
test("ordinary explanation and a focused continuation use one call each without grading roles", async () => {
  const h = harness([backgroundLesson, backgroundLesson]);
  const state = await h.conversations.create();
  const first = await h.assistant.submit(state.id, {
    ...method,
    question: "用一句话解释对照",
    depth: "brief",
  });
  await h.assistant.wait(first.id);
  assert.equal(first.status, "completed", first.error);
  assert.equal(first.budget.attempts.length, 1);
  assert.equal(first.budget.attempts[0].role, "assistant-explain");
  const second = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "focused",
    question: "这句话换个通俗说法",
    focus: { runId: first.runId!, sectionIndex: 0, excerpt: "比较基准" },
  });
  await h.assistant.wait(second.id);
  assert.equal(second.status, "completed", second.error);
  const run = h.manager.runs.get(second.runId!)!;
  assert.equal(run.calls, 1);
  assert.equal(run.input.focusedText, "比较基准");
  assert.equal(run.novice, undefined);
  assert.deepEqual(run.review?.checkedSources, []);
  assert.ok(!("medical-novice-simulator" in run.skillVersions));
  assert.ok(!("medical-grounding-check" in run.skillVersions));
  assert.deepEqual(h.conversations.get(state.id).userProgress, []);
  const other = await h.conversations.create();
  const bad = await h.assistant.submit(other.id, {
    ...method,
    question: "换个通俗说法",
    focus: { runId: first.runId!, sectionIndex: 0, excerpt: "比较基准" },
  });
  await h.assistant.wait(bad.id);
  assert.equal(bad.status, "failed");
  assert.equal(bad.budget.attempts.length, 0);
});
test("focused paper explanation keeps source checking and does not force readability", async () => {
  const paperLesson = { unit: exampleUnits.paper, deck: null };
  const paperReview = {
    issues: [],
    checkedSources: paperLesson.unit.sections.flatMap((s) => s.citations),
    limitations: [],
  };
  const focusedSection = paperLesson.unit.sections.find(
    (s) => s.kind === "paper",
  )!;
  const focusedLesson = {
    unit: { ...paperLesson.unit, sections: [focusedSection] },
    deck: null,
  };
  const h = harness([
    paperLesson,
    novice,
    paperReview,
    focusedLesson,
    { ...paperReview, checkedSources: focusedSection.citations },
  ]);
  const state = await h.conversations.create({ paperId: sample.id });
  const first = await h.assistant.submit(state.id, {
    ...method,
    question: "带读论文",
    module: "paper",
  });
  await h.assistant.wait(first.id);
  assert.equal(first.status, "completed", first.error);
  const index = first.reply!.content!.sections.findIndex(
    (s) => s.kind === "paper",
  );
  const section = first.reply!.content!.sections[index];
  const second = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "paper-focus",
    question: "这句话换个通俗说法",
    focus: {
      runId: first.runId!,
      sectionIndex: index,
      excerpt: section.text.slice(0, 15),
    },
  });
  await h.assistant.wait(second.id);
  assert.equal(second.status, "completed", second.error);
  assert.deepEqual(
    second.budget.attempts.map((a) => a.role),
    ["teaching", "grounding"],
  );
});
test("direct response cannot publish a paper fact as verified", async () => {
  const bad = structuredClone(backgroundLesson);
  bad.sections[0].kind = "paper";
  const h = harness([bad]);
  const state = await h.conversations.create();
  const turn = await h.assistant.submit(state.id, {
    ...method,
    question: "用一句话解释对照",
  });
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "failed");
  assert.equal(turn.budget.attempts.length, 1);
  assert.equal(turn.reply, undefined);
});

test("direct method route uses foundations, zero planning and three persisted attempts", async () => {
  const h = harness([lesson, novice, review]);
  const state = await h.conversations.create();
  const turn = await h.assistant.submit(state.id, method);
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "completed");
  assert.deepEqual(turn.plan?.modules, ["method"]);
  assert.ok(turn.plan!.sourceIds.includes("qpcr-chemistry"));
  assert.equal(turn.budget.limit, 6);
  assert.equal(turn.budget.attempts.length, 3);
  assert.ok(
    turn.budget.attempts.every(
      (a) => a.groupId && a.status === "succeeded" && a.tokens.total === 25,
    ),
  );
  const restored = h.conversations.get(state.id);
  assert.ok(restored.taughtConcepts.length);
  assert.deepEqual(restored.userProgress, []);
  assert.equal(restored.lastRunId, turn.runId);
});

test("concurrent duplicate messages return one turn; conflicting payload is rejected", async () => {
  const h = harness([lesson, novice, review]);
  const state = await h.conversations.create();
  const [first, duplicate] = await Promise.all([
    h.assistant.submit(state.id, method),
    h.assistant.submit(state.id, method),
  ]);
  assert.equal(first.id, duplicate.id);
  await h.assistant.wait(first.id);
  assert.equal((await h.assistant.submit(state.id, method)).id, first.id);
  await assert.rejects(
    h.assistant.submit(state.id, { ...method, question: "别的问题" }),
    /不同内容/,
  );
  assert.equal(first.budget.attempts.length, 3);
});

test("follow-up inherits the prior method, sources and taught concepts", async () => {
  const changed = structuredClone(lesson);
  changed.unit.sections[0].text =
    "无模板对照检查背景；这一步换成空试管的比较来解释。";
  const h = harness([lesson, novice, review, changed, novice, review]);
  const state = await h.conversations.create();
  const first = await h.assistant.submit(state.id, method);
  await h.assistant.wait(first.id);
  const second = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "follow",
    question: "为什么设置这个对照？",
  });
  await h.assistant.wait(second.id);
  const run = h.manager.runs.get(second.runId!)!;
  assert.equal(run.input.module, "method");
  assert.deepEqual(run.input.sourceIds, first.plan?.sourceIds);
  assert.ok(run.input.taughtConcepts.length);
  assert.ok(run.input.previous);
  assert.ok(run.input.contextSummary!.length <= 1200);
  assert.notEqual(run.result?.sections[0].text, lesson.unit.sections[0].text);
});

test("unbound pronoun asks a concrete question; the answer resumes the pending goal", async () => {
  const h = harness([lesson, novice, review]);
  const state = await h.conversations.create();
  const first = await h.assistant.submit(state.id, {
    ...method,
    question: "这一步为什么这样做？",
  });
  await h.assistant.wait(first.id);
  assert.equal(first.status, "clarification");
  assert.equal(first.budget.attempts.length, 0);
  assert.match(first.reply!.nextStep, /步骤名称/);
  assert.ok(h.conversations.get(state.id).pending);
  const second = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "answer",
    question: "指 PCR 扩增",
  });
  await h.assistant.wait(second.id);
  assert.equal(second.status, "completed");
  assert.match(second.plan!.goal, /这一步为什么这样做/);
  assert.equal(h.conversations.get(state.id).pending, undefined);
});

test("one planner plus one revision shares seven attempts with a fixed novice profile", async () => {
  const h = harness([]);
  const state = await h.conversations.create();
  const plan = rulePlan(method, state, sample)!;
  const open = {
    understood: [],
    breakpoints: [
      {
        id: "gap",
        sentence: "阈值",
        missingConcept: "循环",
        question: "为什么先过阈值？",
        status: "open",
      },
    ],
  };
  const resolved = {
    ...open,
    breakpoints: [{ ...open.breakpoints[0], status: "resolved" }],
  };
  Object.assign(
    h.provider,
    fixture([plan, lesson, open, review, lesson, resolved, review]),
  );
  const turn = await h.assistant.submit(state.id, {
    ...method,
    question: "帮助我理解检测信号的来龙去脉",
  });
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "completed");
  assert.equal(turn.budget.attempts.length, 7);
  assert.equal(turn.budget.attempts[0].groupId, null);
  assert.equal(turn.budget.revisions.length, 1);
  const run = h.manager.runs.get(turn.runId!)!;
  assert.equal(run.calls, 6);
  assert.deepEqual(
    (run.roles[1].input as any).profile,
    (run.roles[4].input as any).profile,
  );
  assert.equal((run.roles[4].input as any).previousBreakpoints[0].id, "gap");
});

test("planner rejects arbitrary actions, unknown sources, dependencies and multiple groups", async () => {
  const h = harness([]);
  const state = await h.conversations.create();
  const plan = rulePlan(method, state, sample)!;
  for (const broken of [
    { ...plan, groups: [{ ...plan.groups[0], actions: ["shell.exec"] }] },
    { ...plan, sourceIds: ["invented"] },
    { ...plan, groups: [plan.groups[0], { ...plan.groups[0], id: "second" }] },
    { ...plan, groups: [{ ...plan.groups[0], dependsOn: ["missing"] }] },
  ])
    assert.throws(() => validatePlan(broken, sample, method));
  Object.assign(h.provider, fixture([{ ...plan, sourceIds: ["invented"] }]));
  const turn = await h.assistant.submit(state.id, {
    ...method,
    question: "帮助我理解检测信号",
  });
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "failed");
  assert.equal(turn.budget.attempts.length, 1);
  assert.equal(h.manager.runs.size, 0);
});

test("Figure + methods + three slides uses one teaching group and novice sees the complete deck", async () => {
  const paper = structuredClone(sample);
  const figure = paper.sources.find((s) => s.id === "xu-fig1")!;
  figure.caption =
    "固定测试图注：各组、面板与 SEM；图像是用于工程验证的合成色块。";
  figure.image = createCanvas(20, 20).toDataURL("image/png");
  const deck = { slides: structuredClone(defaultDeck.slides.slice(0, 3)) };
  deck.slides[1].imageSource = "xu-fig1";
  deck.slides.forEach((s) => {
    s.citations = ["xu-fig1"];
  });
  const unit = structuredClone(exampleUnits.figure);
  unit.sections.forEach((s) => {
    s.citations = ["xu-fig1"];
  });
  const h = harness(
    [{ unit, deck }, novice, { ...review, checkedSources: ["xu-fig1"] }],
    paper,
  );
  const state = await h.conversations.create({ paperId: paper.id });
  const turn = await h.assistant.submit(state.id, {
    ...method,
    question: "帮我读懂 Figure 1，解释相关方法，再整理成三页汇报。",
  });
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "completed", turn.error);
  assert.deepEqual(turn.plan?.modules, ["figure", "method", "ppt"]);
  assert.equal(turn.budget.attempts.length, 3);
  const run = h.manager.runs.get(turn.runId!)!;
  assert.deepEqual((run.roles[1].input as any).presentation, deck);
  assert.equal((run.roles[1].input as any).sources, undefined);
  const id = turn.reply!.artifacts[0].id;
  const zip = unzipSync(
    new Uint8Array(await readFile(join("exports", `${id}.pptx`))),
  );
  assert.equal(
    Object.keys(zip).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .length,
    3,
  );
  assert.equal(
    Object.keys(zip).filter((k) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k),
    ).length,
    3,
  );
  assert.ok(Object.keys(zip).some((k) => k.startsWith("ppt/media/")));
  assert.match(strFromU8(zip["ppt/notesSlides/notesSlide2.xml"]), /来源/);
  const exported = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "export",
    question: "导出已有大纲",
    exportRunId: run.id,
  });
  await h.assistant.wait(exported.id);
  assert.equal(exported.status, "completed", exported.error);
  assert.equal(exported.budget.attempts.length, 0);
});

test("missing figure image stops for material without a model call", async () => {
  const h = harness([]);
  const state = await h.conversations.create({ paperId: sample.id });
  const turn = await h.assistant.submit(state.id, {
    ...method,
    question: "读懂 Figure 1 并做三页汇报",
  });
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "clarification");
  assert.equal(turn.budget.attempts.length, 0);
  assert.match(turn.reply!.nextStep, /原图和完整图注/);
});
test("unbound paper requests and unnamed methods ask for material; unsupported slide counts fail before generation", async () => {
  const h = harness([]);
  const state = await h.conversations.create();
  const paper = await h.assistant.submit(state.id, {
    ...method,
    question: "帮我带读论文",
    clientMessageId: "paper",
  });
  await h.assistant.wait(paper.id);
  assert.equal(paper.status, "clarification");
  assert.match(paper.reply!.nextStep, /论文/);
  assert.equal(paper.budget.attempts.length, 0);
  const methodState = await h.conversations.create();
  const unknown = await h.assistant.submit(methodState.id, {
    ...method,
    question: "请讲解方法原理",
    clientMessageId: "unknown",
  });
  await h.assistant.wait(unknown.id);
  assert.equal(unknown.status, "clarification");
  assert.match(unknown.reply!.nextStep, /方法名称/);
  const countState = await h.conversations.create();
  for (const question of [
    "把 PCR 介绍做成 17 页 PPT",
    "把 PCR 介绍做成二十页汇报",
  ]) {
    const turn = await h.assistant.submit(countState.id, {
      ...method,
      question,
      clientMessageId: question.includes("17") ? "seventeen" : "twenty",
    });
    await h.assistant.wait(turn.id);
    assert.equal(turn.status, "failed");
    assert.equal(turn.budget.attempts.length, 0);
  }
});
test("cancellation covers planning and teaching and persists terminal group state", async () => {
  for (const question of ["PCR 原理是什么？", "帮助我理解检测信号的来龙去脉"]) {
    const h = harness([]);
    h.provider.generate = async () => new Promise(() => {});
    const state = await h.conversations.create();
    const turn = await h.assistant.submit(state.id, { ...method, question });
    for (let i = 0; i < 50 && !turn.budget.attempts.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(turn.budget.attempts.length, 1);
    await h.assistant.cancel(turn.id);
    assert.equal(turn.status, "cancelled");
    assert.equal(turn.budget.attempts.length, 1);
    assert.equal(turn.budget.attempts[0].status, "cancelled");
    assert.equal(turn.reply, undefined);
    assert.ok(
      h.conversations
        .get(state.id)
        .taskGroups.every((g) => g.status === "cancelled"),
    );
    assert.equal(h.assistant.busy, false);
  }
});
test("material gaps merge across roles, survive later turns and keep an identifiable resolution", async () => {
  const issue = {
    id: "B1",
    type: "material",
    severity: "warning",
    resolved: false,
    evidence: ["qpcr-basics"],
    location: "测量原理",
    suggestion: "请补充检测化学原文。",
  };
  const breakpoint = {
    id: "B1",
    status: "insufficient",
    sentence: "荧光",
    missingConcept: "化学",
    question: "请补检测化学资料。",
  };
  const outputs: unknown[] = [
    lesson,
    { understood: [], breakpoints: [breakpoint] },
    { ...review, issues: [issue] },
  ];
  const h = harness(outputs);
  const state = await h.conversations.create();
  const first = await h.assistant.submit(state.id, method);
  await h.assistant.wait(first.id);
  const question = h.conversations.get(state.id).openQuestions[0];
  assert.equal(first.reply?.pendingQuestions.length, 1);
  assert.match(question.id, /-B1$/);
  outputs.push(lesson, novice, review);
  const later = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "later",
    question: "为什么设置这个对照？",
  });
  await h.assistant.wait(later.id);
  assert.equal(h.conversations.get(state.id).openQuestions[0].id, question.id);
  outputs.push(
    lesson,
    {
      understood: [],
      breakpoints: [{ ...breakpoint, id: question.id, status: "resolved" }],
    },
    { ...review, issues: [{ ...issue, id: question.id, resolved: true }] },
  );
  const final = await h.assistant.submit(state.id, {
    ...method,
    clientMessageId: "resolved",
  });
  await h.assistant.wait(final.id);
  assert.equal(final.status, "completed");
  assert.equal(h.conversations.get(state.id).openQuestions.length, 0);
});

test("paper change clears old evidence, concepts, summaries and open questions", async () => {
  const h = harness([lesson, novice, review]);
  const state = await h.conversations.create({ paperId: sample.id });
  state.sourceVersion = "old";
  state.taughtConcepts = [{ name: "OLD_CONCEPT", unitId: "old" }];
  state.summaries = [{ turnId: "old", text: "OLD_FACT" }];
  state.lastRunId = "old";
  state.openQuestions = [
    { id: "old", question: "OLD_QUESTION", sourceIds: ["old"] },
  ];
  await h.conversations.put(state, state.version);
  const turn = await h.assistant.submit(state.id, {
    ...method,
    paperId: "another-paper",
  });
  await h.assistant.wait(turn.id);
  const teaching = h.manager.runs.get(turn.runId!)?.roles[0].input;
  assert.ok(!JSON.stringify(teaching).includes("OLD_"));
});

test("budget cancellation, timeout and reservation write failure stop further generation", async () => {
  let calls = 0;
  const slow: Provider = {
    model: "slow",
    generate: async () => {
      calls++;
      return new Promise(() => {});
    },
  };
  const controller = new AbortController();
  const ledger = new BudgetLedger("cancel", async () => {});
  const pending = ledger.call(
    slow,
    "assistant",
    "",
    {},
    z.object({}),
    controller.signal,
    { sourceHash: "s", skillHash: "r" },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending);
  assert.equal(calls, 1);
  assert.equal(ledger.state.attempts[0].status, "cancelled");
  const timeout = new BudgetLedger("timeout", async () => {}, undefined, 30);
  await assert.rejects(
    timeout.call(
      slow,
      "assistant",
      "",
      {},
      z.object({}),
      new AbortController().signal,
      { sourceHash: "s", skillHash: "r" },
    ),
  );
  assert.equal(timeout.state.attempts[0].status, "unknown");
  const failing = new BudgetLedger("save", async () => {
    throw new Error("disk full");
  });
  const before = calls;
  await assert.rejects(
    failing.call(
      slow,
      "assistant",
      "",
      {},
      z.object({}),
      new AbortController().signal,
      {
        sourceHash: "s",
        skillHash: "r",
      },
    ),
  );
  assert.equal(calls, before);
  assert.equal(failing.state.attempts.length, 1);
});

test("format failure retains raw output, usage and elapsed time without retry", async () => {
  const h = harness([]);
  h.provider.generate = async () => {
    throw new ProviderFailure("格式错误", "format", '{"broken":', {
      last: { totalTokens: 33 },
    });
  };
  const state = await h.conversations.create();
  const turn = await h.assistant.submit(state.id, method);
  await h.assistant.wait(turn.id);
  assert.equal(turn.status, "failed");
  const attempt = turn.budget.attempts[0];
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.rawOutput, '{"broken":');
  assert.equal(attempt.tokens.total, 33);
  assert.equal(turn.budget.attempts.length, 1);
  assert.deepEqual(
    normalizeUsage({ last: { totalTokens: 5 }, total: { totalTokens: 100 } })
      .total,
    5,
  );
});

test("exact cache reuses checked output, preserves audit ID and invalidates for context and source changes", async () => {
  const cacheRecords = new Map<string, unknown>();
  const cache = new ResultCache(
    "tests",
    async (g, id, value) => {
      cacheRecords.set(`${g}/${id}`, structuredClone(value));
    },
    async <T>(g: string, id: string) => {
      if (!cacheRecords.has(`${g}/${id}`))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return cacheRecords.get(`${g}/${id}`) as T;
    },
  );
  const h = harness(
    [lesson, novice, review, lesson, novice, review, lesson, novice, review],
    sample,
    cache,
  );
  const firstState = await h.conversations.create({ paperId: sample.id });
  const first = await h.assistant.submit(firstState.id, method);
  await h.assistant.wait(first.id);
  const secondState = await h.conversations.create({ paperId: sample.id });
  const second = await h.assistant.submit(secondState.id, method);
  await h.assistant.wait(second.id);
  assert.equal(second.status, "completed");
  assert.equal(second.budget.attempts.length, 0);
  assert.equal(h.manager.runs.get(second.runId!)?.cacheHit, first.runId);
  assert.ok(h.conversations.get(secondState.id).taughtConcepts.length);
  const follow = await h.assistant.submit(secondState.id, {
    ...method,
    clientMessageId: "repeat",
  });
  await h.assistant.wait(follow.id);
  assert.equal(follow.budget.attempts.length, 3);
  assert.equal(h.manager.runs.get(follow.runId!)?.cacheHit, undefined);
  assert.equal(
    cache.eligible({
      ...h.manager.runs.get(first.runId!)!,
      status: "cancelled",
    }),
    false,
  );
  const changed = structuredClone(sample);
  changed.sources.find((s) => s.id === "qpcr-basics")!.text += "新增来源内容";
  const other = harness([lesson, novice, review], changed, cache);
  const state = await other.conversations.create({ paperId: changed.id });
  const invalidated = await other.assistant.submit(state.id, method);
  await other.assistant.wait(invalidated.id);
  assert.equal(invalidated.budget.attempts.length, 3);
});

test("materials deduplicate text but preserve citation aliases and full caption", () => {
  const source = sample.sources[0];
  const packet = materialPacket([
    source,
    { ...source, id: "alias", caption: "完整图注" },
  ]);
  assert.equal(packet.blocks.length, 1);
  assert.equal(packet.references.length, 2);
  assert.equal(packet.references[1].caption, "完整图注");
  assert.throws(
    () => materialPacket([{ ...source, text: "x".repeat(20_001) }]),
    /20,000/,
  );
});

test("conversation optimistic version rejects stale writes and restores memory on disk failure", async () => {
  let fail = false;
  const store = new ConversationStore(async () => {
    if (fail) throw new Error("disk full");
  });
  const state = await store.create();
  await store.put({ ...state, goal: "saved" }, state.version);
  await assert.rejects(store.put(state, state.version), /版本/);
  const next = store.get(state.id);
  fail = true;
  await assert.rejects(
    store.put({ ...next, goal: "lost" }, next.version),
    /disk full/,
  );
  assert.equal(store.get(state.id).goal, "saved");
});

test("restart restores complete artifacts and marks running attempts interrupted, duplicate remains deduplicated", async () => {
  // Keep this test isolated from user data; restore() normally reads the runtime directory.
  const dir = await mkdtemp(join(tmpdir(), "tutor-recovery-"));
  const { writeFile, mkdir } = await import("node:fs/promises");
  const h = harness([lesson, novice, review]);
  const state = await h.conversations.create();
  const turn = await h.assistant.submit(state.id, method);
  await h.assistant.wait(turn.id);
  const restoredState = h.conversations.get(state.id);
  const pending = structuredClone(turn);
  pending.id += "-pending";
  pending.status = "running";
  pending.message.clientMessageId = "pending";
  pending.budget.attempts[0].status = "reserved";
  // A separate Node process supplies TUTOR_DATA_DIR before importing storage.
  for (const group of ["conversations", "turns"]) await mkdir(join(dir, group));
  await writeFile(
    join(dir, "conversations", `${state.id}.json`),
    JSON.stringify(restoredState),
  );
  await writeFile(join(dir, "turns", `${turn.id}.json`), JSON.stringify(turn));
  await writeFile(
    join(dir, "turns", `${pending.id}.json`),
    JSON.stringify(pending),
  );
  const { spawnSync } = await import("node:child_process");
  const script = `import { AssistantService } from './server/assistant.ts'; import { TaskManager } from './server/orchestrator.ts'; import { ConversationStore } from './server/conversation.ts'; const p={model:'test',generate:async()=>{throw Error('must not run')}}; const a=new AssistantService(p,new TaskManager(p),new ConversationStore(),async()=>{throw Error('must not load')}); await a.restore(); const t=[...a.turns.values()]; const pending=t.find(t=>t.status==='interrupted'); if(!pending || pending.budget.attempts[0].status!=='unknown') throw Error('recovery failed'); const done=t.find(t=>t.status==='completed'); const duplicate=await a.submit(done.conversationId,done.message); if(duplicate.id!==done.id) throw Error('dedup failed'); console.log('recovered');`;
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { env: { ...process.env, TUTOR_DATA_DIR: dir }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /recovered/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
