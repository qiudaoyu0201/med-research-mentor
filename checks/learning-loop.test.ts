import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../server/materials.ts";
import { addAssistedCorrection, addIndependentTransfer, addRemedialTeaching, beginLearningLoop } from "../server/learning-loop.ts";
import type { OpenTask } from "../server/internal-learner.ts";

const task = (id: string): OpenTask => ({ id, kind: "design-draft", question: "设计", sources: [] });
const answer = (mode: "independent" | "assisted") => ({ mode, rawAnswer: { text: "回答", questions: [], usedVisibleIds: [] } });
const teaching = { id: "remedial-1", kind: "teaching" as const, text: "补充解释", versionHash: digest("补充解释") };

test("learning loop keeps remedial correction separate from independent transfer", () => {
  const loop = beginLearningLoop(task("a"), answer("independent"), { passed: false });
  assert.equal(loop.status, "initial-only");
  addRemedialTeaching(loop, teaching, "缺少测量边界");
  addAssistedCorrection(loop, answer("assisted"), { passed: true });
  addIndependentTransfer(loop, task("b"), answer("independent"), { passed: true });
  assert.equal(loop.status, "transferred");
  assert.equal(loop.correction?.mode, "assisted");
  assert.equal(loop.transfer?.mode, "independent");
});

test("learning loop rejects target leakage and skipped stages", () => {
  const loop = beginLearningLoop(task("a"), answer("independent"), {});
  assert.throws(() => addIndependentTransfer(loop, task("b"), answer("independent"), {}), /辅助纠正/);
  assert.throws(() => addRemedialTeaching(loop, { ...teaching, kind: "target-hint" }, "x"), /教学曝光/);
  addRemedialTeaching(loop, teaching, "x");
  assert.throws(() => addAssistedCorrection(loop, answer("independent"), {}), /辅助/);
  addAssistedCorrection(loop, answer("assisted"), {});
  assert.throws(() => addIndependentTransfer(loop, task("a"), answer("independent"), {}), /新任务/);
});
