import test from "node:test";
import assert from "node:assert/strict";
import {
  currentSourceRanges,
  translationSegments,
} from "../shared/source-ranges.ts";
import { prepareReading, completeReading } from "../server/reading-session.ts";
import type { PaperBundle } from "../shared/types.ts";

test("reading continuation translates current text without repeating preceding context", () => {
  const paper: PaperBundle = {
    id: "p",
    version: "v1",
    title: "Study",
    scope: "fixture",
    sources: [
      {
        id: "s",
        title: "Results",
        kind: "paper",
        text: "A".repeat(4800) + "B".repeat(4800),
        locator: "p1",
        verified: true,
      },
    ],
  };
  const first = prepareReading(paper, undefined, "start", "开始带读");
  const state = completeReading(first, "first-turn");
  const next = prepareReading(paper, state, "continue", "继续");
  const excerpt = next.paper.sources[0];
  const ranges = currentSourceRanges(paper.sources[0], excerpt);
  assert.deepEqual(ranges, [{ start: 4800, end: 9600 }]);
  assert.deepEqual(translationSegments(paper.sources[0].text, ranges), [
    { start: 4800, end: 8300 },
    { start: 8300, end: 9600 },
  ]);
  assert.deepEqual(
    currentSourceRanges(paper.sources[0], { ...excerpt, text: "stale" }),
    [],
  );
  assert.deepEqual(
    currentSourceRanges({ ...paper.sources[0], caption: "Caption" }, excerpt),
    [],
  );
});

test("separate excerpts do not translate unexposed gaps; whole sources keep old chunks", () => {
  assert.deepEqual(
    translationSegments("x".repeat(8000), [
      { start: 100, end: 200 },
      { start: 7000, end: 8000 },
    ]),
    [
      { start: 100, end: 200 },
      { start: 7000, end: 8000 },
    ],
  );
  assert.deepEqual(translationSegments("x".repeat(3501)), [
    { start: 0, end: 3500 },
    { start: 3500, end: 3501 },
  ]);
});

test("context-only citations preserve their own range and malformed metadata falls back safely", () => {
  const source = {
    id: "s",
    title: "Results",
    kind: "paper" as const,
    text: "0123456789",
    locator: "p1",
    verified: true,
  };
  const excerpt = {
    ...source,
    text: "234",
    excerptRanges: [{ start: 2, end: 5, role: "context" as const }],
  };
  assert.deepEqual(currentSourceRanges(source, excerpt), [
    { start: 2, end: 5 },
  ]);
  assert.deepEqual(
    currentSourceRanges(source, { ...excerpt, excerptRanges: "broken" as any }),
    [],
  );
  assert.deepEqual(
    currentSourceRanges(source, { ...excerpt, excerptRanges: [null] as any }),
    [],
  );
});
