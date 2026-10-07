import type { TrainingCase } from "../evals/internal-training-cases.ts";
import type { TrainingBatch } from "./internal-training.ts";

export const iterationQuotaVersion = "iteration-v1.1-70x3";
export interface IterationQuota {
  version: typeof iterationQuotaVersion;
  cycle: number;
  historicalAttempts: number;
  priorProductAttempts: number;
  previousReportHash: string;
  originReportHash: string;
}
export function validateQuota(quota: IterationQuota) {
  if (
    quota.version !== iterationQuotaVersion ||
    !Number.isSafeInteger(quota.cycle) ||
    quota.cycle < 1 ||
    quota.cycle > 3 ||
    quota.historicalAttempts !== 44 ||
    !Number.isSafeInteger(quota.priorProductAttempts) ||
    quota.priorProductAttempts < 0 ||
    quota.priorProductAttempts > (quota.cycle - 1) * 70 ||
    !/^[a-f0-9]{64}$/.test(quota.previousReportHash) ||
    !/^[a-f0-9]{64}$/.test(quota.originReportHash)
  )
    throw new Error("新增额度版本、前序消耗或冻结 lineage 无效。");
}
// Ordinary routes: PPT omits novice reading; paper reads twice at most;
// each plan condition has one generation and one check, then one evaluation per side.
export function comparisonUpperBound(test: TrainingCase) {
  return test.kind === "ppt"
    ? 10
    : test.kind === "paper"
      ? 14
      : 2 * (2 * ("changedConditions" in test ? 2 : 1) + 1);
}
export function iterationUsage(
  quota: IterationQuota,
  batches: TrainingBatch[],
) {
  validateQuota(quota);
  const attempts = batches
    .filter((b) => b.phase !== "M3")
    .flatMap((b) => b.budget.attempts);
  if (new Set(attempts.map((a) => a.id)).size !== attempts.length)
    throw new Error("当前账本调用 ID 重复。");
  const current = attempts.length,
    product = quota.priorProductAttempts + current;
  if (current > 70 || product > 210) throw new Error("新增产物额度超限。");
  return {
    current,
    product,
    historical: quota.historicalAttempts,
    combined: quota.historicalAttempts + product,
    remainingCycle: 70 - current,
    remainingProduct: 210 - product,
  };
}
export function reserveIterationUnit(
  quota: IterationQuota,
  batches: TrainingBatch[],
  required: number,
) {
  const usage = iterationUsage(quota, batches);
  if (
    !Number.isSafeInteger(required) ||
    required < 1 ||
    required > usage.remainingCycle ||
    required > usage.remainingProduct
  )
    throw new Error("新增额度不足以预约完整比较单元。");
}
export function developmentPassed(
  results: {
    id: string;
    side: string;
    status: string;
    evaluation?: { valid: boolean; passed: boolean };
  }[],
) {
  return ["D1", "D2", "D3"].every((id) =>
    results.some(
      (r) =>
        r.id === id &&
        r.side === "candidate" &&
        r.status === "generated" &&
        r.evaluation?.valid &&
        r.evaluation.passed,
    ),
  );
}
