import type { TrainingCase } from "../evals/internal-training-cases.ts";
import type { TrainingBatch } from "./internal-training.ts";
import type { Attempt } from "../shared/types.ts";

export const iterationQuotaVersion = "iteration-v1.1-70x3";
export const recoveryProtocolVersion = "iteration-v1.2-recovery-c";
export function calibrationPassed(
  samples: readonly {
    id: string;
    checks: readonly { criterion: string; passed: boolean }[];
  }[],
  records: {
    id: string;
    expected: boolean;
    expectedChecks?: { criterion: string; passed: boolean }[];
    evaluation: {
      valid: boolean;
      passed: boolean;
      review: { checks: { criterion: string; passed: boolean }[] };
    };
  }[],
) {
  return (
    records.length === samples.length &&
    samples.every((sample) => {
      const matches = records.filter((record) => record.id === sample.id);
      if (matches.length !== 1) return false;
      const record = matches[0],
        expected = sample.checks.every((check) => check.passed);
      return (
        record.expected === expected &&
        record.evaluation.valid &&
        record.evaluation.passed === expected &&
        record.expectedChecks?.length === sample.checks.length &&
        record.evaluation.review.checks.length === sample.checks.length &&
        sample.checks.every(
          (check) =>
            record.expectedChecks!.filter(
              (c) =>
                c.criterion === check.criterion && c.passed === check.passed,
            ).length === 1 &&
            record.evaluation.review.checks.filter(
              (c) =>
                c.criterion === check.criterion && c.passed === check.passed,
            ).length === 1,
        )
      );
    })
  );
}
export interface TrainingRecovery {
  version: typeof recoveryProtocolVersion;
  previousDirectory: string;
  reportHash: string;
  originReportHash: string;
  historicalAttempts: number;
  priorProductAttempts: number;
  engineHash: string;
  planHash: string;
  attempts: {
    id: string;
    status: string;
    threadId: string | null;
    turnId: string | null;
    remoteTerminal: string | null;
    confirmed: boolean;
    evidence?: { path: string; hash: string };
  }[];
}
export function validateRecovery(
  manifest: TrainingRecovery,
  report: { quota: IterationQuota; batches: TrainingBatch[] },
  bindings: {
    reportHash: string;
    previousDirectory: string;
    engineHash: string;
    planHash: string;
  },
  verifiedEvidence: Record<string, NonNullable<Attempt["observation"]>> = {},
) {
  validateQuota(report.quota);
  const pending = report.batches
    .flatMap((b) => b.budget.attempts)
    .filter((a) => ["reserved", "unknown", "cancelled"].includes(a.status));
  if (
    manifest.version !== recoveryProtocolVersion ||
    report.quota.cycle !== 2 ||
    manifest.originReportHash !== report.quota.originReportHash ||
    manifest.historicalAttempts !== 44 ||
    manifest.priorProductAttempts !==
      iterationUsage(report.quota, report.batches).product ||
    Object.entries(bindings).some(
      ([key, value]) => manifest[key as keyof TrainingRecovery] !== value,
    ) ||
    report.batches.some((b) => b.status === "running") ||
    !pending.length ||
    manifest.attempts.length !== pending.length ||
    new Set(manifest.attempts.map((a) => a.id)).size !== pending.length
  )
    throw new Error("恢复清单与前序账本、引擎或方案不一致。");
  for (const attempt of pending) {
    const entry = manifest.attempts.find((a) => a.id === attempt.id);
    const observation = entry?.evidence
      ? verifiedEvidence[attempt.id]
      : attempt.observation;
    if (
      !entry ||
      entry.status !== attempt.status ||
      !entry.confirmed ||
      !observation?.threadId ||
      !observation.turnId ||
      !["completed", "interrupted", "failed"].includes(
        observation.remoteTerminal ?? "",
      ) ||
      entry.threadId !== observation.threadId ||
      entry.turnId !== observation.turnId ||
      entry.remoteTerminal !== observation.remoteTerminal ||
      !observation.events.some(
        (e) => e.type === "terminal" && e.status === entry.remoteTerminal,
      )
    )
      throw new Error(
        "前序请求远端终止未确认；停止命令确认不代替终态，不派发新候选。",
      );
  }
}
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
