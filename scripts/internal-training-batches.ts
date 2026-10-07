import { resolve, join, relative, isAbsolute } from "node:path";
import { open, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { RecordStorage } from "../server/storage.ts";
import {
  assertContinuation,
  type TrainingBatch,
} from "../server/internal-training.ts";
import { trainingCases } from "../evals/internal-training-cases.ts";
import {
  comparisonUpperBound,
  iterationUsage,
  type IterationQuota,
} from "../server/training-protocol.ts";
const directory = resolve(
  process.env.TUTOR_TRAINING_DIR ?? "runs/internal-training/cycle-1",
);
const rel = relative(resolve("runs/internal-training"), directory);
if (!rel || rel.startsWith("..") || isAbsolute(rel))
  throw new Error("训练目录必须隔离");
const lock = await open(join(directory, "batches.lock"), "wx");
const store = new RecordStorage(join(directory, "records"));
interface Report {
  batches: TrainingBatch[];
  decision: string;
  priorAttempts?: number;
  quota?: IterationQuota;
  stopReason?: string;
  results: { id: string; side: string }[];
}
try {
  for (let index = 0; index < 8; index++) {
    const report = await store.read<Report>("training", "report");
    assertContinuation(report.batches);
    if (
      [
        "retain-baseline-development-failed",
        "retain-baseline-holdout-failed",
      ].includes(report.decision)
    ) {
      console.log("候选未达质量门槛，保留后续额度；本周期停止。");
      break;
    }
    const used = report.batches.reduce(
      (n, b) => n + b.budget.attempts.length,
      report.priorAttempts ?? 0,
    );
    const pending = trainingCases.filter(
      (c) =>
        !["baseline", "candidate"].every((side) =>
          report.results.some((r) => r.id === c.id && r.side === side),
        ),
    );
    if (!pending.length) {
      console.log(
        "六例比较已运行；实际文件、收益及学习结论另行验收，基线仍保留。",
      );
      break;
    }
    const required = report.quota ? comparisonUpperBound(pending[0]) : 16;
    if (
      report.quota
        ? required > iterationUsage(report.quota, report.batches).remainingCycle
        : used + required > 108
    ) {
      console.log(
        "周期剩余额度不足以预约完整比较，未运行：",
        pending.map((c) => c.id).join(","),
      );
      break;
    }
    if (report.stopReason) {
      if (
        report.stopReason !== "Error: 剩余调用或时间不足，完整比较单元未运行。"
      )
        throw new Error(report.stopReason);
      // Only a known batch admission failure permits a new batch. Preserve all
      // previous attempts, deadlines, failure reasons and the global cycle quota.
      delete report.stopReason;
      await store.save("training", "report", report);
    }
    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(
        process.execPath,
        [
          resolve("node_modules/tsx/dist/cli.mjs"),
          "scripts/internal-training.ts",
          pending[0].id === "D1" ? "m1" : "m2",
        ],
        { stdio: "inherit", windowsHide: true },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolveRun() : reject(new Error(`内部批次退出：${code}`)),
      );
    });
    const next = await store.read<Report>("training", "report");
    if (next.results.length === report.results.length)
      throw new Error(next.stopReason ?? "没有新增比较，不自动空跑。");
  }
} finally {
  await lock.close();
  await unlink(join(directory, "batches.lock"));
}
