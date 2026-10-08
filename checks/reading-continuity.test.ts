import test from "node:test";
import assert from "node:assert/strict";
import { prepareReading, completeReading } from "../server/reading-session.ts";
import type { PaperBundle } from "../shared/types.ts";
const paper = (first: string, second: string): PaperBundle => ({
  id: "p",
  version: "v",
  title: "Study",
  scope: "fixture",
  sources: [first, second].map((text, i) => ({
    id: `s${i}`,
    title: "Results",
    text,
    locator: `p${i + 1}`,
    page: i + 1,
    kind: "paper",
    verified: true,
    section: "results",
  })),
});

test("a continued experiment crosses the PDF page boundary while preserving per-source evidence", () => {
  const p = paper(
    "The treated group was compared with",
    "the control group. The outcome was unchanged.",
  );
  const prepared = prepareReading(p, undefined, "start", "带我读");
  assert.equal(prepared.ranges.length, 2);
  assert.deepEqual(
    prepared.ranges.map((r) => r.sourceId),
    ["s0", "s1"],
  );
  assert.equal(prepared.nextCursor, 2);
  const state = completeReading(prepared, "turn");
  const deepen = prepareReading(p, state, "deepen", "展开这个实验");
  assert.deepEqual(deepen.ranges, prepared.ranges);
  assert.equal(deepen.nextCursor, 2);
});

test("cross-page grouping respects new sections, finished thoughts, material limits and nonadjacent pages", () => {
  assert.equal(
    prepareReading(
      paper("The result was unchanged.", "Another experiment begins."),
      undefined,
      "start",
      "读",
    ).ranges.length,
    1,
  );
  assert.equal(
    prepareReading(
      paper("Fig. 1 shows the result.", "Methods\nFig. 1 was measured."),
      undefined,
      "start",
      "读",
    ).ranges.length,
    1,
  );
  const p = paper(
    "Fig. 1 shows the result.",
    "Fig. 1 also shows the matched control.",
  );
  assert.equal(prepareReading(p, undefined, "start", "读").ranges.length, 2);
  p.sources[1].page = 4;
  assert.equal(prepareReading(p, undefined, "start", "读").ranges.length, 1);
});
