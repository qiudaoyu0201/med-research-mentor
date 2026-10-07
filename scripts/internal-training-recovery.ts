import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { recoveryBindings, hashFile } from "../server/training-engine.ts";
import { readRecoveryEvidence } from "../server/training-recovery.ts";
import { trainingAdmission } from "../server/training-admission.ts";
import {
  recoveryProtocolVersion,
  iterationUsage,
  validateRecovery,
  type TrainingRecovery,
} from "../server/training-protocol.ts";
const isolateHistorical = process.argv
  .slice(2)
  .includes("--isolate-historical-b");
if (process.argv.slice(2).some((arg) => arg !== "--isolate-historical-b"))
  throw new Error("未知恢复选项。");
const previousDirectory = resolve(
  process.env.TUTOR_TRAINING_PREVIOUS_DIR ??
    "runs/internal-training/iteration-b",
);
const directory = resolve(
  process.env.TUTOR_TRAINING_DIR ?? "runs/internal-training/iteration-c",
);
for (const path of [previousDirectory, directory]) {
  const rel = relative(resolve("runs/internal-training"), path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("恢复记录必须在独立训练目录。");
}
if (previousDirectory === directory) throw new Error("不能修改前序周期目录。");
const raw = await readFile(
  join(previousDirectory, "records/training/report.json"),
);
const report = JSON.parse(raw.toString());
if (
  report.quota?.cycle !== 2 ||
  report.batches.some((b: any) => b.status === "running")
)
  throw new Error("仅允许已停止第二候选建立第三候选恢复记录。");
const manifest: TrainingRecovery = {
  version: recoveryProtocolVersion,
  previousDirectory,
  reportHash: createHash("sha256").update(raw).digest("hex"),
  originReportHash: report.quota.originReportHash,
  historicalAttempts: report.quota.historicalAttempts,
  priorProductAttempts: iterationUsage(report.quota, report.batches).product,
  ...(await recoveryBindings()),
  attempts: report.batches
    .flatMap((b: any) => b.budget.attempts)
    .filter((a: any) => ["reserved", "unknown", "cancelled"].includes(a.status))
    .map((a: any) => ({
      id: a.id,
      status: a.status,
      threadId: a.observation?.threadId ?? null,
      turnId: a.observation?.turnId ?? null,
      remoteTerminal: a.observation?.remoteTerminal ?? null,
      confirmed:
        !!a.observation?.threadId &&
        !!a.observation?.turnId &&
        ["completed", "interrupted", "failed"].includes(
          a.observation?.remoteTerminal,
        ) &&
        a.observation.events.some(
          (e: any) =>
            e.type === "terminal" && e.status === a.observation.remoteTerminal,
        ),
    })),
};
if (process.env.TUTOR_TRAINING_TERMINAL_EVIDENCE) {
  const path = resolve(process.env.TUTOR_TRAINING_TERMINAL_EVIDENCE);
  const rawEvidence = JSON.parse(await readFile(path, "utf8"));
  const entry = manifest.attempts.find((a) => a.id === rawEvidence.attemptId);
  if (!entry) throw new Error("终态证据不属于待恢复请求。");
  const evidence = { path, hash: await hashFile(path) };
  const observation = await readRecoveryEvidence(
    evidence,
    previousDirectory,
    entry.id,
  );
  Object.assign(entry, {
    evidence,
    confirmed: true,
    threadId: observation.threadId,
    turnId: observation.turnId,
    remoteTerminal: observation.remoteTerminal,
  });
}
if (isolateHistorical) {
  for (const path of [
    resolve("runs/internal-training/dispatch.lock"),
    join(previousDirectory, "runner.lock"),
  ]) {
    try {
      await access(path);
      throw new Error("本地训练锁仍存在，不能建立历史隔离准入。");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const admission = await trainingAdmission();
  manifest.disposition = "historical-unknown-isolated";
  manifest.decisionReason = `旧 B 本地批次已停止，在线状态 ${admission.online}；保留未确认远端终态和未知用量，新 C 独立派发，不重发旧请求。`;
  validateRecovery(manifest, report, {
    previousDirectory,
    reportHash: manifest.reportHash,
    engineHash: manifest.engineHash,
    planHash: manifest.planHash,
  });
}
await mkdir(directory, { recursive: true });
const path = resolve(
  process.env.TUTOR_TRAINING_RECOVERY ?? join(directory, "recovery.json"),
);
const outputRelative = relative(directory, path);
if (
  !outputRelative ||
  outputRelative.startsWith("..") ||
  isAbsolute(outputRelative)
)
  throw new Error("新恢复清单必须保存在当前周期目录，不能覆盖前序记录。");
await writeFile(path, JSON.stringify(manifest, null, 2), { flag: "wx" });
console.log(
  JSON.stringify({
    path,
    admitted:
      manifest.attempts.length > 0 &&
      (manifest.disposition === "historical-unknown-isolated" ||
        manifest.attempts.every((a) => a.confirmed)),
    disposition: manifest.disposition ?? "verified-terminal-required",
    historicalAttempts: manifest.historicalAttempts,
    priorProductAttempts: manifest.priorProductAttempts,
    modelCalls: 0,
  }),
);
