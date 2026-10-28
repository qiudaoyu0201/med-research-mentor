import test from "node:test";
import assert from "node:assert/strict";
import { generationFeedback } from "../app/generation-feedback.ts";

test("intentional cancellation is a localized status, not a transport error", () => {
  assert.deepEqual(
    generationFeedback("cancelled", "This operation was aborted"),
    {
      role: "status",
      text: "已取消生成，已有内容已保留，可调整要求后重新生成。",
    },
  );
});

test("cancellation feedback does not require a provider error", () => {
  assert.equal(generationFeedback("cancelled").role, "status");
  assert.match(generationFeedback("cancelled").text, /已取消生成/);
});

test("actual failure and clarification details remain visible", () => {
  for (const status of ["failed", "interrupted", "clarification", "conflict"])
    assert.deepEqual(generationFeedback(status, "请先补充来源资料。"), {
      role: "alert",
      text: "请先补充来源资料。",
    });
});

test("missing failure details still provide an actionable fallback", () => {
  assert.deepEqual(generationFeedback("failed"), {
    role: "alert",
    text: "本次未完成，可调整要求后重新生成。",
  });
});
