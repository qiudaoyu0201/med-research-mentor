import test from "node:test";
import assert from "node:assert/strict";
import {
  cloneOpenLearner,
  answerOpenTask,
  openLearnerView,
  type Exposure,
} from "../server/internal-learner.ts";
import { digest } from "../server/materials.ts";
import type { LearnerState } from "../shared/learner.ts";
const initial: LearnerState = {
  id: "initial",
  version: 0,
  profile: { id: "novice", version: "1", background: "科研新手", concepts: [] },
  concepts: [],
  visible: [],
  observations: [],
};
const exposure = (kind: Exposure["kind"]): Exposure => ({
  id: kind,
  kind,
  text: kind,
  versionHash: digest(kind),
});
test("three open learning branches clone identical initial state and reveal only their recorded exposure", () => {
  const branches = (
    ["unlearned", "materials", "materials-and-teaching"] as const
  ).map((b) =>
    cloneOpenLearner(
      initial,
      b,
      b,
      [exposure("material")],
      [exposure("teaching")],
    ),
  );
  assert.deepEqual(
    branches.map((b) => b.exposures.length),
    [0, 1, 2],
  );
  assert.equal(new Set(branches.map((b) => b.initialStateHash)).size, 1);
  branches[0].state.profile.background = "changed";
  assert.equal(branches[1].state.profile.background, "科研新手");
  assert.throws(() =>
    cloneOpenLearner(
      initial,
      "bad",
      "materials-and-teaching",
      [],
      [exposure("target-rewrite")],
    ),
  );
  const task = {
    id: "target",
    kind: "design-draft" as const,
    question: "设计草案",
    sources: [],
  };
  assert.equal(
    JSON.stringify(openLearnerView(branches[1], task)).includes("teaching"),
    false,
  );
});
test("raw open answers survive without rewriting and target assistance is distinguished from independent work", async () => {
  const record = cloneOpenLearner(initial, "open", "unlearned", [], []);
  record.exposures.push(exposure("target-hint"));
  const original = {
    text: "我还不知道如何设对照。",
    questions: ["如何设对照？"],
    usedVisibleIds: ["bogus"],
  };
  const observed = await answerOpenTask(
    {
      model: "fixture",
      async generate(_i, _x, schema) {
        return { output: schema.parse(original) };
      },
    },
    record,
    { id: "target", kind: "design-draft", question: "设计草案", sources: [] },
    new AbortController().signal,
    async () => {},
  );
  assert.deepEqual(observed.rawAnswer, original);
  assert.equal(observed.mode, "assisted");
  assert.deepEqual(observed.unsupportedVisibleIds, ["bogus"]);
  assert.deepEqual(initial.observations, []);
});
