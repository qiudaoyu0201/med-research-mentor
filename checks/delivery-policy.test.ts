import test from "node:test";
import assert from "node:assert/strict";
import {
  onlineDeliveryProblem,
  visibleOpenQuestions,
  reviewFollowupContext,
} from "../server/delivery-policy.ts";
import type { ReviewIssue } from "../shared/types.ts";
import { needsRevision } from "../server/orchestrator.ts";
import { ResultCache } from "../server/cache.ts";
import type { TaskRun } from "../shared/types.ts";
const issue = (
  location: string,
  patch: Partial<ReviewIssue> = {},
): ReviewIssue => ({
  id: location,
  location,
  type: "teaching",
  severity: "warning",
  resolved: false,
  evidence: [],
  suggestion: "补充说明",
  ...patch,
});
const review = (issues: ReviewIssue[]) => ({
  issues,
  checkedSources: [],
  limitations: [],
});
test("online delivery tolerates a small number of peripheral gaps, never substantive errors", () => {
  assert.equal(onlineDeliveryProblem(review([])), undefined);
  assert.equal(
    onlineDeliveryProblem(review([issue("术语"), issue("操作细节")])),
    undefined,
  );
  for (const type of ["fact", "scope", "teaching", "material"] as const)
    assert.ok(
      onlineDeliveryProblem(
        review([issue("关键处", { type, severity: "blocking" })]),
      ),
    );
  assert.equal(
    onlineDeliveryProblem(
      review([issue("方法"), issue("对照"), issue("推理")]),
    ),
    undefined,
  );
  assert.equal(
    onlineDeliveryProblem(
      review([issue("相同位置"), issue("相同位置"), issue("相同位置")]),
    ),
    undefined,
  );
  assert.equal(
    onlineDeliveryProblem(
      review([issue("已修正", { severity: "blocking", resolved: true })]),
    ),
    undefined,
  );
});

test("cache reuses online warnings without relaxing internal or blocking eligibility", () => {
  const cache = new ResultCache();
  const run = {
    status: "completed",
    result: {},
    review: review([issue("minor")]),
    skillVersions: { "delivery-policy": "online-v3" },
  } as unknown as TaskRun;
  assert.equal(cache.eligible(run), true);
  assert.equal(
    cache.eligible({
      ...run,
      skillVersions: { "delivery-policy": "internal-v1" },
    }),
    false,
  );
  assert.equal(
    cache.eligible({
      ...run,
      review: review([issue("major", { severity: "blocking" })]),
    }),
    false,
  );
  assert.equal(cache.eligible({ ...run, status: "failed" }), false);
});

test("online warnings do not trigger revision; internal review and novice core gaps stay strict", () => {
  const warnings = review([
    issue("a", { type: "fact" }),
    issue("b", { type: "scope" }),
    issue("c"),
  ]);
  const feedback = { understood: [], breakpoints: [] };
  assert.equal(needsRevision(warnings, feedback, "online"), false);
  assert.equal(needsRevision(warnings, feedback, "internal"), true);
  assert.equal(needsRevision(warnings, feedback), true);
  assert.equal(
    needsRevision(
      review([]),
      {
        understood: [],
        breakpoints: [
          {
            id: "core",
            sentence: "结果",
            missingConcept: "对照",
            question: "为什么能得出结论",
            status: "open",
          },
        ],
      },
      "online",
    ),
    true,
  );
});

test("historical warning questions are hidden without erasing user questions or major gaps", () => {
  const runs = [
    {
      id: "run",
      input: { conversationId: "c" },
      review: review([
        issue("minor"),
        issue("major", { severity: "blocking" }),
      ]),
    },
  ] as unknown as TaskRun[];
  const questions = ["run-minor", "run-major", "minor", "user"].map((id) => ({
    id,
    question: "补充说明",
    sourceIds: [],
  }));
  assert.deepEqual(
    visibleOpenQuestions(questions, runs, "c").map((q) => q.id),
    ["run-major", "minor", "user"],
  );
  assert.deepEqual(visibleOpenQuestions(questions, runs, "other"), questions);
  assert.equal(runs[0].review!.issues.length, 2);
});

test("audit details enter context only for an explicit question about the current artifact", () => {
  const run = {
    result: {},
    review: review([issue("minor")]),
  } as unknown as TaskRun;
  assert.equal(reviewFollowupContext("继续带读", run), "");
  assert.equal(reviewFollowupContext("这有什么不足？"), "");
  assert.match(reviewFollowupContext("这有什么不足？", run), /补充说明/);
  assert.match(reviewFollowupContext("可靠么？", run), /不是已经证实的事实/);
});
