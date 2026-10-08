import test from "node:test";
import assert from "node:assert/strict";
import {
  deliveredFigureBasics,
  figureFamiliarity,
} from "../server/figure-familiarity.ts";
import type { TaskRun } from "../shared/types.ts";
const run = (text: string) =>
  ({
    status: "completed",
    result: { sections: [{ text, citations: ["s"] }] },
    review: { issues: [] },
    materials: [{ sources: [{ id: "s", kind: "paper" }] }],
  }) as unknown as TaskRun;

test("figure familiarity requires delivered explanation with evidence, not merely a named graph", () => {
  assert.deepEqual(deliveredFigureBasics(run("这是箱线图，结果有差异。")), []);
  assert.deepEqual(
    deliveredFigureBasics(
      run("这是箱线图，箱体表示四分位间距，横轴表示分组。"),
    ),
    ["曾讲读图基础：箱线图"],
  );
  const blocked = run("箱线图的纵轴表示读数。");
  blocked.review!.issues = [{ severity: "blocking", resolved: false }] as any;
  assert.deepEqual(deliveredFigureBasics(blocked), []);
  const unsupported = run("箱线图的纵轴表示读数。");
  unsupported.materials = [];
  assert.deepEqual(deliveredFigureBasics(unsupported), []);
});

test("lightweight familiarity permits re-explanation and never treats graph types as mastery", () => {
  assert.equal(figureFamiliarity([], "继续"), undefined);
  const memory = ["曾讲读图基础：箱线图"];
  assert.equal(figureFamiliarity(memory, "继续")?.revisitBasics, false);
  assert.match(figureFamiliarity(memory, "继续")!.guidance, /变量、单位、分组/);
  assert.equal(
    figureFamiliarity(memory, "没看懂，重新讲讲横轴")?.revisitBasics,
    true,
  );
});
