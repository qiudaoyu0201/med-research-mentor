import test from "node:test";
import assert from "node:assert/strict";
import { createClosure, advanceClosure, type ClosureInput } from "../server/learning-closure.ts";
import { LearnerStore } from "../server/learner.ts";
import { cloneOpenLearner } from "../server/internal-learner.ts";
import { ProviderFailure, type Provider } from "../server/provider.ts";
import { learningCriteria } from "../server/learning-protocol.ts";

async function fixture(initialPassed = false) {
  const initial = await new LearnerStore(async () => {}).create({ id: "novice", version: "1", background: "医学科研新手", concepts: [] });
  const learner = cloneOpenLearner(initial, "learner", "materials-and-teaching", [], []);
  const task = { id: "old", kind: "design-draft" as const, question: "原课题设计", sources: [{ id: "s1", text: "横断面观察不能证明因果", locator: "原始资料" }] };
  const observation = { task, rawAnswer: { text: "回答", questions: [], usedVisibleIds: ["s1"] }, inputHash: "frozen", mode: "independent" as const, unsupportedVisibleIds: [] };
  learner.observations.push(observation);
  const input: ClosureInput = { learner, initial: observation, evaluation: { valid: true, passed: initialPassed, findings: [], review: { checks: learningCriteria.map((criterion) => ({ criterion, passed: initialPassed, location: "回答", sourceIds: ["s1"], explanation: "测试诊断" })) } },
    transfer: { ...task, id: "new", question: "新课题设计：仅一次测量如何研究关联？" },
    priorStudies: [{ question: task.question, study: "study-a" }], targetStudy: "study-b", rules: "医学导师", environmentHash: "fixture-runtime-1" };
  const calls: any[] = [];
  const provider: Provider = { id: "fixture", model: "fixture", async generate(rules, value, schema) {
    const x = value as any;
    calls.push({ rules, input: structuredClone(value) });
    const output = x.criteria
      ? { checks: x.criteria.map((criterion: string) => ({ criterion, passed: true, location: x.artifact.text, sourceIds: ["s1"], explanation: "与来源相符" })) }
      : x.diagnosis ? { text: "补教：横断面研究没有时间顺序，因此不能确定因果。", reason: "补充设计推理" }
      : { text: "横断面只能研究关联，不能确定因果。", questions: [], usedVisibleIds: ["s1"] };
    return { output: schema.parse(output), usage: { total_tokens: 10 } };
  } };
  return { input, calls, provider };
}
test("six-stage closure resumes from saved checkpoints, counts all calls and isolates transfer", async () => {
  const h = await fixture();
  let state = createClosure("closure", h.input, h.provider);
  const snapshots: typeof state[] = [];
  for (let i = 0; i < 6; i++) {
    await advanceClosure(state, h.input, h.provider, async (s) => { snapshots.push(s); }, new AbortController().signal);
    state = structuredClone(snapshots.at(-1)!);
  }
  assert.equal(state.status, "complete");
  assert.equal(state.budget.attempts.length, 6);
  assert.ok(state.budget.attempts.every((a) => a.status === "succeeded"));
  assert.equal(state.correction?.mode, "assisted");
  assert.equal(state.transfer?.mode, "independent");
  assert.equal(state.transferPassed, true);
  assert.ok(!JSON.stringify(h.calls[0].input).includes(h.input.transfer.question));
  const transfer = h.calls[4].input;
  assert.deepEqual(transfer.history, []);
  assert.ok(transfer.exposures.every((e: any) => e.kind !== "target-hint"));
  assert.equal(transfer.diagnosis, undefined);
  assert.ok(snapshots.some((s) => s.budget.attempts.at(-1)?.status === "reserved" && s.inFlight));
  await advanceClosure(state, h.input, h.provider, async () => {}, new AbortController().signal);
  assert.equal(h.calls.length, 6);
});
test("passed initial task goes straight to new transfer, failed transfer is recorded without false success", async () => {
  const h = await fixture(true);
  const generate = h.provider.generate;
  h.provider.generate = async (rules, value, schema, signal) => {
    if ((value as any).criteria) return { output: schema.parse({ checks: learningCriteria.map((criterion) => ({ criterion, passed: false, location: (value as any).artifact.text, sourceIds: ["s1"], explanation: "独立迁移仍有断点" })) }) };
    return generate(rules, value, schema, signal);
  };
  const state = createClosure("direct", h.input, h.provider);
  assert.equal(state.budget.limit, 2);
  for (let i = 0; i < 2; i++) await advanceClosure(state, h.input, h.provider, async () => {}, new AbortController().signal);
  assert.equal(state.status, "complete");
  assert.equal(state.transferPassed, false);
  assert.equal(state.teaching, undefined);
});
test("environment changes, unknown dispatch and cancelled input never silently restart a closure", async () => {
  const h = await fixture();
  const state = createClosure("unknown", h.input, h.provider);
  await assert.rejects(advanceClosure(state, { ...h.input, environmentHash: "changed" }, h.provider, async () => {}, new AbortController().signal), /已变化/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(advanceClosure(state, h.input, h.provider, async () => {}, cancelled.signal));
  assert.equal(state.budget.attempts.length, 0);
  let calls = 0;
  h.provider.generate = async () => { calls++; throw new ProviderFailure("连接断开", "transport"); };
  await assert.rejects(advanceClosure(state, h.input, h.provider, async () => {}, new AbortController().signal));
  assert.equal(state.status, "blocked");
  assert.equal(state.budget.attempts[0].status, "unknown");
  await assert.rejects(advanceClosure(structuredClone(state), h.input, h.provider, async () => {}, new AbortController().signal), /不重发/);
  assert.equal(calls, 1);
});
test("renaming a task or relabelling its study does not admit an identical question", async () => {
  const h = await fixture();
  h.input.transfer.question = h.input.initial.task.question;
  assert.throws(() => createClosure("invalid", h.input, h.provider), /重叠/);
});
