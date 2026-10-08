import { readFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { TrainingBatch } from "./internal-training.ts";
import {
  iterationQuotaVersion,
  validateQuota,
  iterationUsage,
  type IterationQuota,
  type TrainingRecovery,
  validateRecovery,
} from "./training-protocol.ts";
import { recoveryBindings } from "./training-engine.ts";
import { readRecoveryEvidence } from "./training-recovery.ts";

// A new candidate starts a new protocol; old dispatches, including unknowns,
// still consume the first round's 108-call budget. Never resume old attempts.
export async function trainingLineage(directory: string) {
  const previous = process.env.TUTOR_TRAINING_PREVIOUS_DIR;
  if (!previous)
    return { previousDirectory: null, reportHash: null, attempts: 0 };
  const path = resolve(previous),
    rel = relative(resolve("runs/internal-training"), path);
  if (
    !rel ||
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    path === resolve(directory)
  )
    throw new Error("前序周期必须是独立训练目录，不能指向当前周期。");
  const raw = await readFile(join(path, "records/training/report.json"));
  const report = JSON.parse(raw.toString()) as {
    priorAttempts?: number;
    batches: TrainingBatch[];
  };
  if (
    !Array.isArray(report.batches) ||
    report.batches.some((b) => b.status === "running")
  )
    throw new Error("前序周期尚在运行，不能建立新的候选周期。");
  const ids = report.batches.flatMap((b) => b.budget.attempts.map((a) => a.id));
  if (new Set(ids).size !== ids.length)
    throw new Error("前序账本重复，不能合并额度。");
  const prior = report.priorAttempts ?? 0;
  if (!Number.isSafeInteger(prior) || prior < 0)
    throw new Error("前序累计额度无效。");
  return {
    previousDirectory: path,
    reportHash: createHash("sha256").update(raw).digest("hex"),
    attempts: prior + ids.length,
  };
}

// Cost reconciliation is separate from dispatch authorization. In particular,
// changing a directory must never turn an existing experiment into a free root.
export function assertTrainingDispatchLineage(
  directory: string,
  lineage: { previousDirectory: string | null; reportHash: string | null; attempts: number },
) {
  if (!lineage.previousDirectory && resolve(directory) !== resolve("runs/internal-training/cycle-1"))
    throw new Error("新训练目录必须显式关联前序账本，不能从零重置历史成本。");
  if (lineage.previousDirectory && (!lineage.reportHash || !Number.isSafeInteger(lineage.attempts) || lineage.attempts < 0))
    throw new Error("前序账本关联无效，禁止派发。");
}

export async function iterationLineage(
  directory: string,
): Promise<IterationQuota> {
  const lineage = await trainingLineage(directory);
  if (!lineage.previousDirectory || !lineage.reportHash)
    throw new Error("新增额度必须显式关联前序周期，不能默认为零。");
  const report = JSON.parse(
    await readFile(
      join(lineage.previousDirectory, "records/training/report.json"),
      "utf8",
    ),
  );
  const uncertain = report.batches.some((b: TrainingBatch) =>
    b.budget.attempts.some((a) =>
      ["reserved", "unknown", "cancelled"].includes(a.status),
    ),
  );
  if (uncertain) {
    const recoveryPath = process.env.TUTOR_TRAINING_RECOVERY;
    if (!recoveryPath)
      throw new Error("前序新派发状态未确认，不能继续候选周期。");
    const manifest = JSON.parse(
      await readFile(resolve(recoveryPath), "utf8"),
    ) as TrainingRecovery;
    const evidence = Object.fromEntries(
      await Promise.all(
        manifest.attempts
          .filter((a) => a.evidence)
          .map(async (a) => [
            a.id,
            await readRecoveryEvidence(
              a.evidence!,
              lineage.previousDirectory!,
              a.id,
            ),
          ]),
      ),
    );
    validateRecovery(
      manifest,
      report,
      {
        ...(await recoveryBindings()),
        previousDirectory: lineage.previousDirectory,
        reportHash: lineage.reportHash,
      },
      evidence,
    );
  }
  let quota: IterationQuota;
  if (report.quota) {
    const previous = report.quota as IterationQuota;
    const usage = iterationUsage(previous, report.batches);
    if (
      report.priorAttempts !==
      previous.historicalAttempts + previous.priorProductAttempts
    )
      throw new Error("前序累计消耗与额度 lineage 不一致。");
    quota = {
      ...previous,
      cycle: previous.cycle + 1,
      priorProductAttempts: usage.product,
      previousReportHash: lineage.reportHash,
    };
  } else {
    if (
      lineage.previousDirectory !== resolve("runs/internal-training/cycle-2") ||
      lineage.attempts !== 44
    )
      throw new Error("新增额度首周期必须关联原 cycle-2 的 44 次累计账本。");
    quota = {
      version: iterationQuotaVersion,
      cycle: 1,
      historicalAttempts: 44,
      priorProductAttempts: 0,
      previousReportHash: lineage.reportHash,
      originReportHash: lineage.reportHash,
    };
  }
  validateQuota(quota);
  return quota;
}
