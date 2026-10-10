import test from "node:test";
import assert from "node:assert/strict";
import {
  LearnerStore,
  LearnerEnvironment,
  learnerView,
} from "../server/learner.ts";
import { BudgetLedger } from "../server/budget.ts";
import {
  skillCatalog,
  loadSkill,
  loadSkillReference,
  parseSkill,
} from "../server/skills.ts";
import {
  learnerProfile,
  knownTask,
  lomaTask,
  incompleteLesson,
  completeLesson,
} from "../examples/learner-case.ts";
import type { LearnerAnswer, LearnerState } from "../shared/learner.ts";
import type { Provider } from "../server/provider.ts";
import type { save } from "../server/storage.ts";
const discard = async () => {};
const answer = (
  choice: string | null,
  selfReportedUnderstanding = false,
): LearnerAnswer => ({
  choice,
  explanation: "测试作答",
  questions: [],
  usedVisibleIds: [],
  selfReportedUnderstanding,
});
function setup(outputs: LearnerAnswer[], persist: typeof save = discard) {
  const inputs: unknown[] = [];
  const provider: Provider = {
    model: "fixture-only",
    async generate(_instructions, input, schema) {
      inputs.push(input);
      return { output: schema.parse(outputs.shift()) };
    },
  };
  const store = new LearnerStore(persist);
  return {
    store,
    env: new LearnerEnvironment(store, provider, persist),
    ledger: new BudgetLedger("learner-test", discard),
    inputs,
  };
}
test("catalog exposes only trigger metadata and loads selected instructions with safe references", async () => {
  const catalog = await skillCatalog();
  assert.equal(catalog.length, 11);
  assert.ok(catalog.some((s) => s.id === "medical-research-plan"));
  assert.ok(catalog.every((s) => !Object.hasOwn(s, "body") && s.name === s.id));
  const skill = await loadSkill("medical-learner-simulation");
  assert.match(skill.text, /choice/);
  assert.ok(!skill.text.includes("汇报页面"));
  await assert.rejects(
    loadSkillReference("medical-learner-simulation", "../shared/rules.md"),
    /越过/,
  );
  assert.throws(
    () =>
      parseSkill(
        "---\nname: wrong\ndescription: test\n---\nbody",
        "medical-learner-simulation",
      ),
    /无效/,
  );
});
test("unknown answers are retained as leakage; self-report and teaching alone do not upgrade state", async () => {
  const h = setup([answer("red", true), answer(null, true)]);
  const learner = await h.store.create(learnerProfile);
  const rule = { expectedChoice: "red", requiredVisibleIds: ["complete"] };
  const result = await h.env.answer(
    learner.id,
    lomaTask("before", 4),
    rule,
    h.ledger,
    new AbortController().signal,
  );
  assert.equal(result.assessment.unauthorizedKnowledge, true);
  assert.equal(h.store.get(learner.id).concepts[1].status, "unknown");
  await h.store.teach(learner.id, incompleteLesson);
  await h.env.answer(
    learner.id,
    lomaTask("partial", 6),
    rule,
    h.ledger,
    new AbortController().signal,
  );
  assert.equal(h.store.get(learner.id).concepts[1].status, "unknown");
  assert.equal(h.store.get(learner.id).observations.length, 2);
  assert.ok(!JSON.stringify(h.inputs).includes("expectedChoice"));
  assert.ok(!JSON.stringify(h.inputs).includes("requiredVisibleIds"));
});
test("known basics can pass; observed application requires actual answer and persists across students and restore", async () => {
  const records: LearnerState[] = [];
  const h = setup(
    [answer("a"), answer("red"), answer("blue")],
    async (group, _id, value) => {
      if (group === "learners") {
        const state = structuredClone(value) as LearnerState;
        const at = records.findIndex((r) => r.id === state.id);
        if (at < 0) records.push(state);
        else records[at] = state;
      }
    },
  );
  const student = await h.store.create(learnerProfile);
  const other = await h.store.create(learnerProfile);
  await h.env.answer(
    student.id,
    knownTask,
    { expectedChoice: "a", requiredVisibleIds: [] },
    h.ledger,
    new AbortController().signal,
  );
  await h.store.teach(student.id, completeLesson);
  assert.equal(h.store.get(student.id).concepts[1].status, "unknown");
  const first = await h.env.answer(
    student.id,
    lomaTask("after", 5),
    { expectedChoice: "red", requiredVisibleIds: ["complete"] },
    h.ledger,
    new AbortController().signal,
  );
  assert.equal(h.store.get(student.id).concepts[1].status, "observed");
  assert.deepEqual(h.store.get(student.id).concepts[1].evidence, [
    first.observationId,
  ]);
  const recovered = new LearnerStore(discard);
  await recovered.restore(records);
  const view = learnerView(recovered.get(student.id), lomaTask("next", 1));
  assert.equal(view.history.length, 2);
  assert.equal(view.visible[0].text, completeLesson.text);
  assert.equal(recovered.get(other.id).visible.length, 0);
  assert.equal(recovered.get(other.id).concepts[1].status, "unknown");
  await h.env.answer(
    student.id,
    lomaTask("next", 1),
    { expectedChoice: "blue", requiredVisibleIds: ["complete"] },
    h.ledger,
    new AbortController().signal,
  );
  assert.equal(h.store.get(student.id).observations.length, 3);
});
test("cancel, unseen citation and storage failure do not fabricate learning evidence", async () => {
  let fail = false;
  const h = setup(
    [{ ...answer("red"), usedVisibleIds: ["hidden"] }, answer("red")],
    async () => {
      if (fail) throw new Error("disk full");
    },
  );
  const student = await h.store.create(learnerProfile);
  const rule = { expectedChoice: "red", requiredVisibleIds: ["complete"] };
  await assert.rejects(
    h.env.answer(
      student.id,
      lomaTask("bad", 4),
      rule,
      h.ledger,
      new AbortController().signal,
    ),
    /未见/,
  );
  const cancelled = AbortSignal.abort();
  await assert.rejects(
    h.env.answer(student.id, lomaTask("cancel", 4), rule, h.ledger, cancelled),
  );
  await h.store.teach(student.id, completeLesson);
  fail = true;
  await assert.rejects(
    h.env.answer(
      student.id,
      lomaTask("disk", 4),
      rule,
      h.ledger,
      new AbortController().signal,
    ),
    /disk full/,
  );
  assert.equal(h.store.get(student.id).observations.length, 0);
  assert.equal(h.store.get(student.id).concepts[1].status, "unknown");
});
