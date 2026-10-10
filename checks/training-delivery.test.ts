import test from "node:test";
import assert from "node:assert/strict";
import { trainingDeliveryFiles, trainingGuidance } from "../server/training-delivery.ts";
import type { LearningProduct } from "../server/learning-exposure.ts";
const deck = { slides: [{ title: "研究设计", bullets: ["对照比较"], notes: "讲清对照目的", citations: [] }] };
const base: LearningProduct = { id: "D1", side: "candidate", status: "generated", exportPath: "D1.pptx", artifact: { deck } };
test("legacy PPT acceptance retains full-speech requirement without rewriting history", () => {
  assert.deepEqual(trainingDeliveryFiles(base).map((f) => f.path), ["D1.pptx", "D1-speech.md"]);
});
test("new PPT acceptance checks separate guidance and only actually delivered full speech", () => {
  const next: LearningProduct = { ...base, delivery: { version: "separate-guidance-v1", guidancePath: "D1-guidance.md" } };
  const files = trainingDeliveryFiles(next);
  assert.equal(files.length, 2);
  assert.equal(files[1].text, trainingGuidance(deck));
  assert.throws(() => trainingDeliveryFiles({ ...next, artifact: { deck: { ...deck, speechScript: "完整稿" } } }), /不一致/);
  assert.throws(() => trainingDeliveryFiles({ ...next, delivery: { ...next.delivery!, guidancePath: "D1.pptx" } }), /重复/);
});
