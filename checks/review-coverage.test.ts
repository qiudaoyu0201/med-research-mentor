import test from "node:test";
import assert from "node:assert/strict";
import {
  checkReviewCoverage,
  coverageReviewSchema,
} from "../evals/review-coverage.ts";

const input = {
  deck: {
    slides: [
      {
        title: "问题",
        bullets: ["干预是否有效？"],
        notes: "尚待检验",
        citations: ["p1"],
      },
      {
        title: "结果",
        bullets: ["干预已经治愈所有人。"],
        notes: "小鼠观察",
        citations: ["p2"],
      },
    ],
  },
  draft: { sections: [{ title: "背景", text: "观察小鼠" }] },
  sources: { references: [{ id: "p1" }, { id: "p2" }] },
  feedback: { breakpoints: [{ id: "bp1" }] },
};
const valid = () =>
  coverageReviewSchema.parse({
    issues: [
      {
        id: "bp1",
        location: "第1页",
        type: "scope",
        evidence: ["p1"],
        suggestion: "提问未断言疗效，无需修改",
        severity: "warning",
        resolved: true,
      },
      {
        id: "false",
        location: "第2页",
        type: "fact",
        evidence: ["p2"],
        suggestion: "仅有小鼠观察",
        severity: "blocking",
        resolved: false,
      },
    ],
    checkedSources: ["p1", "p2"],
    limitations: [],
    pages: [
      {
        page: 1,
        checkedCitations: ["p1"],
        verdict: "supported",
        rationale: "研究问题",
        issueIds: ["bp1"],
      },
      {
        page: 2,
        checkedCitations: ["p2"],
        verdict: "gap",
        rationale: "对象越界",
        issueIds: ["false"],
      },
    ],
    bindings: [
      {
        issueId: "bp1",
        target: "slide",
        index: 1,
        quote: "干预是否有效？",
        speechAct: "question",
      },
      {
        issueId: "false",
        target: "slide",
        index: 2,
        quote: "干预已经治愈所有人。",
        speechAct: "assertion",
      },
    ],
    feedbackDecisions: [
      {
        id: "bp1",
        disposition: "dismissed",
        rationale: "未声称有效",
        issueIds: ["bp1"],
      },
    ],
  });

test("逐页审核允许驳回提问误报，同时保留后页重大错误", () => {
  assert.deepEqual(checkReviewCoverage(input, valid()), []);
});
test("漏页、重复页、引用挪用均不能冒充完整覆盖", () => {
  const result = valid();
  result.pages[1] = structuredClone(result.pages[0]);
  result.pages[0].checkedCitations = ["p2", "invented"];
  const errors = checkReviewCoverage(input, result);
  assert.ok(errors.includes("pages: duplicate"));
  assert.ok(errors.includes("missing page: 2"));
  assert.ok(errors.includes("page 1: citation inventory mismatch"));
});
test("不能将后页断言错误绑定到开篇问题", () => {
  const result = valid();
  result.bindings[1].index = 1;
  const errors = checkReviewCoverage(input, result);
  assert.ok(errors.includes("binding false: quote not in target"));
  assert.ok(errors.includes("page 2: unbound issue false"));
});
test("拒绝伪造来源、虚构问题ID、漏裁决及无问题支撑的缺口", () => {
  const result = valid();
  result.checkedSources.push("fake");
  result.pages[1].issueIds = ["missing"];
  result.feedbackDecisions = [];
  const errors = checkReviewCoverage(input, result);
  for (const expected of [
    "unknown source: fake",
    "page 2: unknown issue missing",
    "missing feedback: bp1",
    "page 2: gap without open issue",
  ])
    assert.ok(errors.includes(expected), expected);
});
test("驳回反馈不能暗中保留为未解决问题", () => {
  const result = valid();
  result.issues[0].resolved = false;
  assert.ok(
    checkReviewCoverage(input, result).includes(
      "feedback bp1: dismissal not resolved",
    ),
  );
});
