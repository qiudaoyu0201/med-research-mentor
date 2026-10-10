// Bounded strict product diagnosis. Never resumes old calls or promotes rules.
import { readFile, mkdir, open, readdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { PaperBundle } from "../shared/types.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
import { strictDevelopmentAcceptance } from "../server/development-acceptance.ts";

const root = resolve("runs/internal-training");
const directory = join(root, "development-20261009");
process.env.TUTOR_DATA_DIR = join(directory, "data");
process.env.TUTOR_READING_GUIDES = "manual";
const { RecordStorage } = await import("../server/storage.ts");
const { freezeRules, withRuleSnapshot } = await import("../server/skills.ts");
const { createProvider } = await import("../server/model-config.ts");
const { TrainingProvider, reserveUnit } =
  await import("../server/internal-training.ts");
const { BudgetLedger } = await import("../server/budget.ts");
const { TaskManager } = await import("../server/orchestrator.ts");
const { trainingAdmission } = await import("../server/training-admission.ts");
const { CodexClient, CodexRpcFailure } = await import("../server/provider.ts");
const store = new RecordStorage(join(directory, "records"));
await mkdir(directory, { recursive: true });
const lockPath = join(root, "dispatch.lock");
const lock = await open(lockPath, "wx");
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const hash = (x: string) => createHash("sha256").update(x).digest("hex");
try {
  // Exclusive claim survives failures: rerunning this command cannot reset spend.
  const claim = await open(join(directory, "claimed.json"), "wx");
  await claim.writeFile(
    JSON.stringify({
      at: new Date().toISOString(),
      limit: 12,
      authorization: "用户授权开始内部迭代；两项开发诊断各最多六次，不发布候选",
    }),
  );
  await claim.close();
  const history: { path: string; sha256: string }[] = [];
  const attempts = new Map<string, any>();
  async function collect(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (path === directory) continue;
      if (entry.isDirectory()) await collect(path);
      else if (
        entry.name === "report.json" ||
        (folder === resolve("data/turns") && entry.name.endsWith(".json"))
      ) {
        const raw = await readFile(path, "utf8");
        history.push({ path, sha256: hash(raw) });
        const visit = (v: any): void => {
          if (!v || typeof v !== "object") return;
          if (v.id && v.startedAt && v.status && "inputChars" in v)
            attempts.set(v.id, v);
          for (const child of Object.values(v)) visit(child);
        };
        visit(JSON.parse(raw));
      }
    }
  }
  await collect(root);
  await collect(resolve("data/turns"));
  await store.save("freeze", "history", {
    files: history,
    attempts: [...attempts.values()],
    note: "去重可见账本；并非全项目完整账单，旧未知用量不按零处理",
  });
  const admission: any = { local: await trainingAdmission(), oldUncertain: [] };
  const client = new CodexClient();
  try {
    await client.init();
    for (const a of attempts.values()) {
      if (
        !["unknown", "reserved", "cancelled"].includes(a.status) ||
        a.observation?.remoteTerminal
      )
        continue;
      if (!a.observation?.threadId || !a.observation?.turnId) {
        if (a.status === "reserved")
          throw new Error("历史预留缺少远端定位，停止派发");
        admission.oldUncertain.push({
          id: a.id,
          status: a.status,
          finding: "无远端定位，保留历史未知，不续发",
        });
        continue;
      }
      try {
        const response = await client.rpc(
          "thread/read",
          { threadId: a.observation.threadId, includeTurns: true },
          5000,
        );
        const turn = response.thread?.turns?.find(
          (t: any) => t.id === a.observation.turnId,
        );
        if (
          !turn ||
          !["completed", "failed", "interrupted"].includes(turn.status)
        )
          throw new Error("历史调用仍可能活动");
        admission.oldUncertain.push({
          id: a.id,
          remote: turn.status,
          preserved: a.status,
        });
      } catch (e) {
        if (
          !(e instanceof CodexRpcFailure) ||
          !e.missingThread ||
          Date.now() - Date.parse(a.startedAt) < 600_000
        )
          throw e;
        admission.oldUncertain.push({
          id: a.id,
          preserved: a.status,
          finding: "历史临时线程不可读，不恢复或重发",
        });
      }
    }
  } finally {
    client.close();
  }
  await store.save("freeze", "admission", admission);
  const paper: PaperBundle = JSON.parse(
    await readFile(
      "data/papers/6149094e-e528-461a-bc3e-791ae6e5652e.json",
      "utf8",
    ),
  );
  const rules = await freezeRules();
  const provider = createProvider();
  const batch: TrainingBatch = {
    id: "development-20261009",
    phase: "M1",
    status: "running",
    cycleLimit: 12,
    budget: new BudgetLedger(
      "development-20261009",
      async () => {},
      undefined,
      45 * 60_000,
    ).state,
  };
  batch.budget.limit = batch.budget.groupLimit = 12;
  const report: any = {
    status: "running",
    batch,
    units: [],
    historicalObservedAttempts: attempts.size,
    git: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    provider: {
      id: provider.id,
      model: provider.model,
      settings: provider.settings,
    },
    rulesHash: hash(JSON.stringify(rules)),
    scope: "严格三角色开发诊断；不是留出或自动发布",
  };
  const persist = () => store.save("training", "report", report);
  await store.save("freeze", "rules", rules);
  await store.save("freeze", "paper", paper);
  await persist();
  const counted = new TrainingProvider(
    provider,
    batch,
    persist,
    (id, input) => store.save("inputs", id, input),
    () => batch.budget.attempts.length,
  );
  const manager = new TaskManager(
    counted,
    (group, id, value) => store.save(group, id, value),
    "internal",
  );
  try {
    for (const module of ["paper", "ppt"] as const) {
      await trainingAdmission();
      reserveUnit(batch, 6, batch.budget.attempts.length);
      counted.context = module;
      const question =
        module === "paper"
          ? "请用中文带医学科研新手读第2页，从研究背景接到第一个实验。已读摘要，讲清端粒定位假设、方法测量什么、必要对照和证据边界；术语中英对照。"
          : "生成6页组会汇报：研究背景、实验设计、关键对照、主要结果与创新局限。逐页讲述提示独立保存在notes，不进入幻灯片正文；不需要完整讲稿。";
      const run = await withRuleSnapshot(rules, async () => {
        const result = await manager.start(
          {
            paperId: paper.id,
            module,
            mode: "live",
            profileId: "beginner",
            question,
            sourceIds: paper.sources
              .filter(
                (s) =>
                  module === "ppt" ||
                  s.id.endsWith("-p1") ||
                  s.id.endsWith("-p2"),
              )
              .map((s) => s.id),
            taughtConcepts: [],
            ...(module === "ppt" ? { slideCount: 6 } : {}),
            checks: { readability: true, reason: "内部严格三Agent回归" },
          },
          paper,
          undefined,
          undefined,
          { signal: controller.signal },
        );
        await manager.wait(result.id);
        return result;
      });
      const passed = strictDevelopmentAcceptance(run);
      report.units.push({
        module,
        runId: run.id,
        status: run.status,
        passed,
        calls: run.calls,
        error: run.error,
        issues: run.review?.issues,
      });
      await persist();
      console.log(JSON.stringify(report.units.at(-1)));
      if (
        controller.signal.aborted ||
        batch.budget.attempts.some((a) =>
          ["unknown", "reserved", "cancelled"].includes(a.status),
        )
      )
        throw new Error("新请求状态不明确，停止后续派发");
    }
    report.status = report.units.every((u: any) => u.passed)
      ? "diagnostic-passed"
      : "needs-improvement";
    batch.status = "complete";
  } catch (e) {
    report.status = "stopped";
    report.error = String(e);
    batch.status = "stopped";
  } finally {
    report.endedAt = new Date().toISOString();
    report.calls = batch.budget.attempts.length;
    await persist();
    console.log(
      JSON.stringify({
        status: report.status,
        calls: report.calls,
        error: report.error,
      }),
    );
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
