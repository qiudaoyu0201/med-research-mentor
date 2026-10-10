import test from "node:test";
import assert from "node:assert/strict";
import { selectCrossEvidence } from "../server/cross-function-sources.ts";

const source = {
  id: "p1",
  text: "完整上下文，包含限制条件。",
  locator: "page 1",
};
const deck = {
  slides: [
    {
      title: "结果",
      bullets: [],
      notes: "",
      citations: ["p1"],
      imageSource: "fig1",
    },
  ],
};
test("proposal reference aliases retain the original figure even when no other product cites it", () => {
  const figure = {
    id: "figure4",
    text: "完整图注",
    locator: "Figure 4",
    image: "data:image/png;base64,AA==",
  };
  const reference = {
    id: "src-plan-ref",
    sourceId: figure.id,
    text: "方案选取的图注",
    locator: figure.locator,
  };
  const selected = selectCrossEvidence([], [figure], [reference]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, reference.id);
  assert.equal(selected[0].image, figure.image);
  assert.equal(selected[0].text, reference.text);
  assert.throws(() => selectCrossEvidence([], [], [reference]), /缺少原始来源/);
});
test("cross evidence retains complete cited context, image-only references and proposal evidence", () => {
  const figure = {
    id: "fig1",
    text: "原图图注",
    locator: "Figure 1",
    image: "data:image/png;base64,AA==",
  };
  const proposal = { id: "ref1", text: "方案原始来源", locator: "page 2" };
  const selected = selectCrossEvidence(
    [{ deck }],
    [
      source,
      figure,
      { ...source, id: "unused", text: "x".repeat(110000) },
      source,
    ],
    [proposal],
  );
  assert.deepEqual(selected, [source, figure, proposal]);
});
test("cross evidence rejects unresolved references and conflicting versions", () => {
  assert.throws(
    () => selectCrossEvidence([{ deck }], [source], []),
    /引用缺失：fig1/,
  );
  assert.throws(
    () => selectCrossEvidence([], [source], [{ ...source, text: "changed" }]),
    /版本冲突/,
  );
});
test("duplicate record without image cannot erase available original image", () => {
  const original = { ...source, image: "data:image/png;base64,AA==" };
  assert.deepEqual(selectCrossEvidence([], [original], [source]), [original]);
});
