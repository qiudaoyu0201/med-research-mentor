import test from "node:test";
import assert from "node:assert/strict";
import {
  historicalSummary,
  assertAllowance,
} from "../scripts/mentor-iteration.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
import { BudgetLedger } from "../server/budget.ts";
const batch = (): TrainingBatch => ({
  id: "test",
  phase: "M2",
  status: "stopped",
  cycleLimit: 18,
  budget: {
    ...new BudgetLedger("test", async () => {}).state,
    limit: 18,
    groupLimit: 18,
  },
});
test("mentor extension counts uncertain historical attempts without changing them", () => {
  const b = batch();
  b.budget.attempts = [
    { id: "unknown", status: "unknown", startedAt: "2026-10-08" },
    { id: "cancelled", status: "cancelled", startedAt: "2026-10-08" },
  ] as any;
  const report = { priorAttempts: 126, batches: [b] };
  const before = JSON.stringify(report);
  assert.equal(historicalSummary(report).combined, 128);
  assert.equal(historicalSummary(report).unresolved.length, 2);
  assert.equal(JSON.stringify(report), before);
  b.status = "running";
  assert.throws(() => historicalSummary(report), /活动/);
});
test("mentor extension refuses fresh unknowns, overspending and altered ceiling", () => {
  const b = batch();
  assertAllowance(b, 12);
  b.budget.attempts = Array.from({ length: 13 }, (_, i) => ({
    id: String(i),
    status: "succeeded",
  })) as any;
  assert.throws(() => assertAllowance(b, 6));
  assertAllowance(b, 5);
  b.budget.attempts[0].status = "unknown";
  assert.throws(() => assertAllowance(b, 1));
  b.budget.attempts = [];
  b.budget.limit = 19;
  assert.throws(() => assertAllowance(b, 1));
});
