import {
  readFile,
  writeFile,
  mkdir,
  open,
  access,
  unlink,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import { digest } from "../server/materials.ts";
import { hashFile, trainingEngine } from "../server/training-engine.ts";
import {
  extendWorkflow,
  reserveWorkflow,
  validateWorkflow,
  type WorkflowReport,
  type WorkflowRun,
} from "../server/workflow-iteration.ts";
import { iterationUsage } from "../server/training-protocol.ts";
import type { PaperBundle, TaskRun } from "../shared/types.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
const root = resolve("runs/internal-training");
const registry = JSON.parse(
  await readFile(join(root, "iteration-lineage.json"), "utf8"),
);
const directory = resolve(registry.directories[2] ?? "");
if (directory !== resolve("runs/internal-training/iteration-c"))
  throw new Error("必须接续已登记第三周期，不能另起额度。");
process.env.TUTOR_DATA_DIR = join(directory, "data");
process.env.TUTOR_READING_GUIDES = "manual";
const command = process.argv[2] ?? "status";
const folder = join(directory, "workflow-v1.6");
await mkdir(folder, { recursive: true });
const pause = join(folder, "pause.request");
if (command === "pause") {
  await writeFile(pause, new Date().toISOString());
  console.log("已请求优雅暂停，保留结果与账本。");
  process.exit(0);
}
if (!["prepare", "status", "admit", "run", "checkpoint"].includes(command))
  throw new Error(
    "入口：prepare / status / admit / run 冻结任务.json / checkpoint 复核.json / pause",
  );
const lockPath = join(root, "dispatch.lock");
const lock = await open(lockPath, "wx");
try {
  for (const p of ["runner.lock", "batches.lock"]) {
    try {
      await access(join(directory, p));
      throw new Error("旧入口活动锁未收尾。");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const { RecordStorage, list, save } = await import("../server/storage.ts");
  const { createProvider } = await import("../server/model-config.ts");
  const { trainingAdmission } = await import("../server/training-admission.ts");
  const { CodexClient, CodexRpcFailure } =
    await import("../server/provider.ts");
  const { assertLoopHistory } = await import("../server/short-loop.ts");
  const { BudgetLedger } = await import("../server/budget.ts");
  const { TrainingProvider } = await import("../server/internal-training.ts");
  const { trainingCost } = await import("../server/training-cost.ts");
  const store = new RecordStorage(join(directory, "records"));
  const report = await store.read<WorkflowReport>("training", "report");
  if (report.quota.originReportHash !== registry.origin)
    throw new Error("累计起点不符。");
  const checkpoint = async () => {
    await store.save("training", "report", report);
    await writeFile(
      join(folder, "summary.json"),
      JSON.stringify(
        {
          scope: "v1.6产品工程与内部真实样本；不构成候选发布或真人效果证明",
          usage: validateWorkflow(report),
          workflow: report.workflow,
          cost: trainingCost(
            report.batches,
            44 + report.quota.priorProductAttempts,
            report.quota,
          ),
        },
        null,
        2,
      ),
    );
  };
  const admit = async () => {
    assertLoopHistory(report);
    const local = await trainingAdmission();
    const evidence: unknown[] = [];
    const historical = report.batches
      .filter((b) => report.shortLoops!.historicalBatchIds.includes(b.id))
      .flatMap((b) => b.budget.attempts)
      .filter((a) => report.shortLoops!.historicalPendingIds.includes(a.id));
    const client = new CodexClient();
    try {
      await client.init();
      for (const a of historical) {
        if (a.observation?.remoteTerminal) {
          evidence.push({ id: a.id, terminal: a.observation.remoteTerminal });
          continue;
        }
        if (!a.observation?.threadId || !a.observation.turnId)
          throw new Error("旧未知请求缺定位信息。");
        try {
          const result = await client.rpc(
            "thread/read",
            { threadId: a.observation.threadId, includeTurns: true },
            5000,
          );
          const turn = result.thread?.turns?.find(
            (t: any) => t.id === a.observation!.turnId,
          );
          if (
            !turn ||
            !["completed", "failed", "interrupted"].includes(turn.status)
          )
            throw new Error("旧请求仍可能活动，停止派发。");
          evidence.push({ id: a.id, state: turn.status });
        } catch (e) {
          if (
            !(e instanceof CodexRpcFailure) ||
            !e.missingThread ||
            Date.now() - Date.parse(a.startedAt) < 600_000
          )
            throw e;
          evidence.push({
            id: a.id,
            state: "historical-ephemeral-unavailable",
          });
        }
      }
    } finally {
      client.close();
    }
    const recentUnknown = report.batches
      .filter((b) => !report.shortLoops!.historicalBatchIds.includes(b.id))
      .flatMap((b) => b.budget.attempts)
      .filter((a) => a.status === "unknown")
      .map((a) => ({
        id: a.id,
        status: a.status,
        terminal: a.observation?.remoteTerminal,
        timeoutLayer: a.observation?.timeoutLayer,
      }));
    const value = {
      at: new Date().toISOString(),
      local,
      evidence,
      recentUnknown,
      extensionHash: digest(report.quota.extension),
      reason:
        "旧未知保持未知；有界核查无活动迹象，仅允许新冻结单元，不续发旧请求。",
    };
    const path = join(folder, `admission-${Date.now()}.json`);
    await writeFile(path, JSON.stringify(value, null, 2), { flag: "wx" });
    return path;
  };
  if (command === "prepare") {
    await writeFile(
      join(folder, `before-extension-${Date.now()}.json`),
      JSON.stringify(report, null, 2),
      { flag: "wx" },
    );
    extendWorkflow(
      report,
      await hashFile("docs/真实使用流程与前后端磨合_落地方案_v1.6.md"),
    );
    await checkpoint();
    console.log(
      JSON.stringify({ modelCalls: 0, usage: validateWorkflow(report) }),
    );
  } else if (command === "status") {
    console.log(
      JSON.stringify(
        {
          modelCalls: 0,
          usage: report.quota.extension
            ? validateWorkflow(report)
            : iterationUsage(report.quota, report.batches),
          workflow: report.workflow,
        },
        null,
        2,
      ),
    );
  } else if (command === "admit") {
    validateWorkflow(report);
    const evidence = await admit();
    await unlink(pause).catch((e: any) => {
      if (e.code !== "ENOENT") throw e;
    });
    console.log(JSON.stringify({ modelCalls: 0, evidence }));
  } else if (command === "checkpoint") {
    validateWorkflow(report);
    const raw = await readFile(resolve(process.argv[3]), "utf8");
    const value = z
      .object({
        decision: z.enum(["continue", "stop"]),
        facts: z.string().min(1),
        rework: z.string().min(1),
        waiting: z.string().min(1),
        cost: z.string().min(1),
        reason: z.string().min(1),
      })
      .strict()
      .parse(JSON.parse(raw));
    report.workflow!.checkpoint = {
      at: new Date().toISOString(),
      evidenceHash: digest(value),
      evidence: raw,
      decision: value.decision,
    };
    await checkpoint();
    console.log("阶段复核已保存，历史结果未修改。");
  } else {
    validateWorkflow(report);
    const input = z
      .object({
        caseId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        lane: z.enum(["reading", "artifacts", "comparison", "reserve"]),
        kind: z.enum(["reading", "ppt", "plan", "speech"]),
        question: z.string().trim().min(1).max(2000),
        required: z.number().int().min(1).max(14),
        paperId: z.string().default("train-xu"),
        conversationId: z.string().optional(),
        expectedReadingRevision: z.number().int().min(0).default(0),
        readingAction: z
          .enum([
            "start",
            "continue",
            "deepen",
            "jump",
            "long",
            "summary",
            "resume",
          ])
          .optional(),
        conditions: z.string().max(5000).default(""),
        retrieveLiterature: z.boolean().default(false),
        versionId: z.string().optional(),
        slideCount: z.number().int().min(1).max(16).default(6),
      })
      .strict()
      .parse(JSON.parse(await readFile(resolve(process.argv[3]), "utf8")));
    if (
      input.required <
      (input.kind === "reading" && /看不懂|不理解/.test(input.question)
        ? 6
        : input.kind === "plan" && input.retrieveLiterature
          ? 5
          : input.kind === "speech"
            ? 2
            : 4)
    )
      throw new Error("预约必须覆盖完整单元及最多一次必要修复。");
    try {
      await access(pause);
      throw new Error("已暂停，请显式admit后继续。");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const admissionPath = await admit();
    const paper = await store.read<PaperBundle>("frozen-papers", input.paperId);
    const provider = createProvider();
    const freeze = {
      input,
      paperHash: digest(paper),
      engineHash: digest(await trainingEngine()),
      model: {
        id: provider.id,
        model: provider.model,
        settings: provider.settings,
      },
      extensionHash: digest(report.quota.extension),
    };
    const reserved = reserveWorkflow(
      report,
      input.lane,
      input.caseId,
      digest(freeze),
      input.required,
    );
    const budget = new BudgetLedger(
      reserved.id,
      async () => {},
      undefined,
      input.kind === "reading" ? 900_000 : 1_800_000,
    ).state;
    budget.limit = budget.groupLimit = input.required;
    const batch: TrainingBatch = {
      id: reserved.id,
      phase: "M2",
      status: "running",
      cycleLimit: 100,
      budget,
    };
    report.batches.push(batch);
    const run: WorkflowRun = { ...reserved, batchId: batch.id, artifacts: [] };
    report.workflow!.runs.push(run);
    await writeFile(
      join(folder, `${run.id}-freeze.json`),
      JSON.stringify({ freeze, admissionPath }, null, 2),
      { flag: "wx" },
    );
    await checkpoint();
    const counted = new TrainingProvider(
      provider,
      batch,
      checkpoint,
      (id, value) => store.save("provider-inputs", id, value),
      () => iterationUsage(report.quota, report.batches).current,
    );
    counted.context = `workflow-${input.kind}-${run.id}`;
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("用户暂停"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const timer = setTimeout(
      cancel,
      input.kind === "reading" ? 900_000 : 1_800_000,
    );
    const pauseTimer = setInterval(
      () => void access(pause).then(cancel, () => {}),
      500,
    );
    const begin = Date.now();
    const writeArtifact = async (suffix: string, value: string | Buffer) => {
      const path = join(folder, `${run.id}-${suffix}`);
      await writeFile(path, value);
      run.artifacts!.push({ path, hash: await hashFile(path) });
    };
    try {
      const paperById = async (id: string) => {
        if (id !== paper.id) throw new Error("冻结论文ID不一致");
        return structuredClone(paper);
      };
      const { TaskManager } = await import("../server/orchestrator.ts");
      const { AssistantService } = await import("../server/assistant.ts");
      const { ConversationStore } = await import("../server/conversation.ts");
      const { DeckVersions } = await import("../server/deck-versions.ts");
      const manager = new TaskManager(counted);
      for (const task of await list<TaskRun>("runs"))
        manager.runs.set(task.id, task);
      const decks = new DeckVersions(counted, paperById);
      await decks.restoreDisk();
      const assistant = new AssistantService(
        counted,
        manager,
        new ConversationStore(),
        paperById,
        save,
        undefined,
        undefined,
        decks,
      );
      await assistant.restore();
      if (input.kind === "plan") {
        const { ResearchPlans } = await import("../server/research-plans.ts");
        const plans = new ResearchPlans(
          counted,
          paperById,
          assistant.scheduler,
        );
        const plan = await plans.create({
          question: input.question,
          conditions: input.conditions,
        });
        const job = await plans.start(
          plan.id,
          {
            requestKey: run.id,
            expectedVersion: null,
            expectedTopicVersion: plan.topic.version,
            action: "generate",
            requestedScope: "full-plan",
            retrieveLiterature: input.retrieveLiterature,
          },
          { signal: controller.signal },
        );
        const done = await plans.wait(job.id);
        run.taskId = done.id;
        await writeArtifact("job.json", JSON.stringify(done, null, 2));
        await writeArtifact(
          "plan.json",
          JSON.stringify(plans.get(plan.id), null, 2),
        );
        if (done.status !== "completed")
          throw new Error(done.error ?? done.status);
        const v = plans.get(plan.id).currentVersion!;
        await writeArtifact("plan.md", plans.exportMarkdown(plan.id, v));
        await writeArtifact("plan.docx", plans.exportDocx(plan.id, v));
      } else if (input.kind === "speech") {
        if (!input.versionId) throw new Error("讲稿修改需绑定保存版本");
        const parent = decks.get(input.versionId);
        const ledger = new BudgetLedger(run.id, async () => {});
        const version = await decks.start(
          parent.id,
          parent.conversationId,
          { operation: "speech", question: input.question },
          { signal: controller.signal, ledger },
        );
        const done = await decks.wait(version.id);
        run.taskId = done.id;
        await writeArtifact(
          "speech-version.json",
          JSON.stringify(done, null, 2),
        );
        if (done.status !== "completed")
          throw new Error(done.error ?? done.status);
        await writeArtifact("speech.md", done.outline.speechScript ?? "");
      } else {
        const state = input.conversationId
          ? assistant.conversations.get(input.conversationId)
          : await assistant.conversations.create({ paperId: paper.id });
        const turn = await assistant.submit(state.id, {
          clientMessageId: run.id,
          question: input.question,
          mode: "live",
          paperId: paper.id,
          expectedReadingRevision: input.expectedReadingRevision,
          ...(input.kind === "ppt"
            ? {
                module: "ppt" as const,
                slideCount: input.slideCount,
                speechScript: true,
              }
            : { readingAction: input.readingAction ?? "start" }),
        });
        const abort = () => void assistant.cancel(turn.id);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
        await assistant.wait(turn.id);
        controller.signal.removeEventListener("abort", abort);
        run.taskId = turn.id;
        await writeArtifact(
          "turn.json",
          JSON.stringify(
            {
              ...turn,
              run: turn.runId ? manager.runs.get(turn.runId) : null,
              state: assistant.conversations.get(state.id),
            },
            null,
            2,
          ),
        );
        if (turn.status !== "completed")
          throw new Error(turn.error ?? turn.status);
        if (turn.reply?.deckVersionId) {
          const deck = decks.get(turn.reply.deckVersionId);
          await writeArtifact(
            "deck-version.json",
            JSON.stringify(deck, null, 2),
          );
          const exported = await decks.export(deck.id, state.id);
          console.log(JSON.stringify({ exported }));
        }
      }
      run.status = "completed";
      batch.status = "complete";
    } catch (error) {
      run.status = controller.signal.aborted ? "cancelled" : "failed";
      run.error = String(error);
      batch.status = "stopped";
      batch.stopReason = run.error;
    } finally {
      clearTimeout(timer);
      clearInterval(pauseTimer);
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
      run.endedAt = new Date().toISOString();
      run.calls = batch.budget.attempts.length;
      await checkpoint();
      console.log(
        JSON.stringify(
          {
            run,
            elapsedMs: Date.now() - begin,
            usage: validateWorkflow(report),
          },
          null,
          2,
        ),
      );
    }
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
