import { readFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { TrainingBatch } from "./internal-training.ts";

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
