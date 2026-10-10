import test from "node:test";
import assert from "node:assert/strict";
import {
  chronological,
  selectPlanSources,
} from "../shared/generation-intake.ts";
import type { PaperBundle } from "../shared/types.ts";

function paper(id: string, lengths: number[]): PaperBundle {
  return {
    id,
    title: `论文 ${id}`,
    version: `version-${id}`,
    sources: lengths.map((length, index) => ({
      id: `${id}-${index}`,
      kind: "paper",
      text: "a".repeat(length),
      title: `正文 ${index}`,
      locator: `第 ${index + 1} 页`,
      verified: true,
    })),
  } as PaperBundle;
}

test("reference intake covers every selected paper before spending remaining source slots", () => {
  const papers = [
    paper("many", Array(30).fill(100)),
    paper("short", [2000]),
    paper("last", [4000]),
  ];
  const selected = selectPlanSources(papers, ["many", "short", "last"]);
  assert.deepEqual(
    new Set(selected.map((s) => s.paperId)),
    new Set(["many", "short", "last"]),
  );
  assert.ok(selected.length <= 12);
  for (const source of selected)
    assert.equal(source.sourceVersion, `version-${source.paperId}`);
  const total = selected.reduce(
    (n, s) =>
      n +
      papers
        .find((p) => p.id === s.paperId)!
        .sources.find((x) => x.id === s.sourceId)!.text.length,
    0,
  );
  assert.ok(total <= 18000);
});

test("unavailable, empty and too many references fail before draft submission; oversized text is bounded into excerpts", () => {
  assert.throws(
    () => selectPlanSources([paper("existing", [100])], ["deleted"]),
    /已不存在/,
  );
  assert.throws(
    () => selectPlanSources([paper("empty", [0])], ["empty"]),
    /empty/,
  );
  const oversized = selectPlanSources(
    [paper("ok", [100]), paper("huge", [18001])],
    ["ok", "huge"],
    "huge method",
  );
  assert.ok(oversized.some((source) => source.paperId === "huge" && source.range));
  const papers = Array.from({ length: 13 }, (_, i) =>
    paper(`paper-${i}`, [100]),
  );
  assert.throws(
    () =>
      selectPlanSources(
        papers,
        papers.map((p) => p.id),
      ),
    /12/,
  );
});

test("duplicate reference selections do not penalize the source budget or duplicate evidence", () => {
  const papers = [paper("a", [12000])];
  assert.deepEqual(selectPlanSources(papers, ["a", "a"]), [
    { paperId: "a", sourceVersion: "version-a", sourceId: "a-0" },
  ]);
  assert.deepEqual(selectPlanSources(papers, []), []);
});

test("history chooses the newest artifact independently of server insertion order", () => {
  const items = [
    { id: "latest", createdAt: "2026-10-09T12:00:00Z" },
    { id: "legacy" },
    { id: "older", createdAt: "2026-10-08T12:00:00Z" },
  ];
  assert.equal(chronological(items).at(-1)?.id, "latest");
  assert.equal(items[0].id, "latest");
  const reopened = [
    {
      id: "older",
      createdAt: "2026-10-07T12:00:00Z",
      updatedAt: "2026-10-10T12:00:00Z",
    },
    items[0],
  ];
  assert.equal(chronological(reopened).at(-1)?.id, "older");
});
