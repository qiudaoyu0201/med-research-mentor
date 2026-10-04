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
) {
  const records = new Map<string, unknown>();
  const persist: typeof save = async (g, id, value) => {
    records.set(`${g}/${id}`, structuredClone(value));
  };
  const provider = fixture(outputs);
  const manager = new TaskManager(provider, persist);
  const conversations = new ConversationStore(persist);
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    async () => structuredClone(paper),
    persist,
    cache,
  );
  return { assistant, manager, conversations, records, provider };
}
const method: AssistantMessage = {
  clientMessageId: "first",
  question: "PCR 原理是什么？",
  mode: "live",
};
const lesson = { unit: exampleUnits.qpcr, deck: null };

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
  const firstState = await h.conversations.create();
  const first = await h.assistant.submit(firstState.id, method);
  await h.assistant.wait(first.id);
  const secondState = await h.conversations.create();
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
  const state = await other.conversations.create();
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
