import test from "node:test";
import assert from "node:assert/strict";
import { onlineDeliveryProblem } from "../server/delivery-policy.ts";
import type { ReviewIssue } from "../shared/types.ts";
const issue = (location: string, patch: Partial<ReviewIssue> = {}): ReviewIssue => ({ id: location, location, type: "teaching", severity: "warning", resolved: false, evidence: [], suggestion: "补充说明", ...patch });
const review = (issues: ReviewIssue[]) => ({ issues, checkedSources: [], limitations: [] });
test("online delivery tolerates a small number of peripheral gaps, never substantive errors", () => {
  assert.equal(onlineDeliveryProblem(review([])), undefined);
  assert.equal(onlineDeliveryProblem(review([issue("术语"), issue("操作细节")])), undefined);
  for (const type of ["fact", "scope", "teaching", "material"] as const)
    assert.ok(onlineDeliveryProblem(review([issue("关键处", { type, severity: "blocking" })])));
  assert.ok(onlineDeliveryProblem(review([issue("方法"), issue("对照"), issue("推理")])));
  assert.equal(onlineDeliveryProblem(review([issue("相同位置"), issue("相同位置"), issue("相同位置")])), undefined);
  assert.equal(onlineDeliveryProblem(review([issue("已修正", { severity: "blocking", resolved: true })])), undefined);
});
