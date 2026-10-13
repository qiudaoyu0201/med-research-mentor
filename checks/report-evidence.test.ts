import test from "node:test";
import assert from "node:assert/strict";
import { defaultPaperSources, selectEvidence } from "../server/materials.ts";
import type { PaperBundle, Source } from "../shared/types.ts";
import { onlineDeliveryProblem } from "../server/delivery-policy.ts";

test("PPT emphasis on several figures keeps their images through large-paper selection", () => {
  const figures: Source[] = [1, 4, 5].map((n) => ({
    id: `fig${n}`,
    title: `Figure ${n}`,
    figure: String(n),
    kind: "paper",
    text: `Figure ${n} experiment and results.`,
    caption: `Figure ${n} experiment and results.`,
    locator: `Figure ${n}`,
    image: "data:image/png;base64,AA==",
    verified: true,
  }));
  const paper: PaperBundle = {
    id: "p",
    version: "v",
    title: "Paper",
    scope: "fixture",
    sources: [
      ...figures,
      ...[1, 2, 3, 4, 5, 6].map((n): Source => ({
        id: `p${n}`,
        title: `PDF 第 ${n} 页`,
        kind: "paper",
        page: n,
        text: "Results and methods. ".repeat(250),
        locator: `p${n}`,
        verified: true,
      })),
    ],
  };
  const question = "做6页PPT，重点Figure 1、4、5的实验设计和证据";
  const defaults = defaultPaperSources(paper, question, ["figure", "ppt"]);
  const selected = selectEvidence(defaults, question, ["figure", "ppt"]);
  assert.deepEqual(
    selected
      .filter((s) => s.image)
      .map((s) => s.id)
      .sort(),
    ["fig1", "fig4", "fig5"],
  );
  assert.deepEqual(
    defaultPaperSources(paper, "解释Figure 1", ["figure"]).map((s) => s.id),
    ["fig1"],
  );
});

test("major material gaps cannot bypass delivery checks through placeholder wording", () => {
  const gap = {
    id: "gap",
    type: "material" as const,
    severity: "blocking" as const,
    location: "第 5 页：Figure 4、5：关键材料尚缺",
    suggestion: "需补入 Figure 4、5 原图和结果正文。",
    evidence: [],
    resolved: false,
  };
  assert.ok(
    onlineDeliveryProblem({
      issues: [gap],
      checkedSources: [],
      limitations: [],
    }),
  );
  assert.equal(
    onlineDeliveryProblem({
      issues: [{ ...gap, severity: "warning" }],
      checkedSources: [],
      limitations: [],
    }),
    undefined,
  );
  assert.equal(
    onlineDeliveryProblem({
      issues: [{ ...gap, type: "fact", location: "Figure 4 组别错误" }],
      checkedSources: [],
      limitations: [],
    }),
    "仍有影响结论或理解主线的问题，已保留核对结果，需要修正后再交付。",
  );
});
