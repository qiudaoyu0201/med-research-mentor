import {
  mkdir,
  readFile,
  writeFile,
  open,
  unlink,
  access,
  copyFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  shortLoopCases,
  reservedMaterials,
} from "../evals/short-loop-cases.ts";
import {
  initializeLoops,
  assertLoopHistory,
  reserveLoop,
  freezeFragment,
  type LoopReport,
  type LoopLane,
} from "../server/short-loop.ts";
import { iterationUsage } from "../server/training-protocol.ts";
import { digest } from "../server/materials.ts";
import { hashFile, trainingEngine } from "../server/training-engine.ts";
import type { PaperBundle } from "../shared/types.ts";

// Use the registered THIRD cycle; a new directory must never reset its budget.
const root = resolve("runs/internal-training");
const registry = JSON.parse(
  await readFile(join(root, "iteration-lineage.json"), "utf8"),
);
const directory = resolve(registry.directories[2] ?? "");
if (directory !== resolve("runs/internal-training/iteration-c"))
  throw new Error("第三周期登记目录不符。");
const reportPath = join(directory, "records/training/report.json");
const folder = join(directory, "short-loops");
const command = process.argv[2] ?? "prepare",
  caseId = process.argv[3];
if (
  ![
    "prepare",
    "run",
    "whole",
    "crop",
    "edit",
    "pause",
    "admit",
    "verify",
    "status",
  ].includes(command)
)
  throw new Error(
    "入口：prepare / run 样本 [round-2] / whole ppt|plan / crop|edit 原记录ID 修改文件 / pause / admit / verify 记录ID 证据文件 / status",
  );
await mkdir(folder, { recursive: true });
const pausePath = join(folder, "pause.request");
if (command === "pause") {
  await writeFile(pausePath, new Date().toISOString());
  console.log("已请求暂停；当前 provider 将收到取消，不杀进程，不自动重发。");
} else {
  const lock = await open(join(root, "dispatch.lock"), "wx").catch(() => {
    throw new Error("已有训练入口或中断锁，当前入口不派发。");
  });
  try {
    for (const name of ["runner.lock", "batches.lock"]) {
      try {
        await access(join(directory, name));
        throw new Error("旧训练入口锁仍存在，不派发。");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    process.env.TUTOR_DATA_DIR = join(directory, "data");
    process.env.TUTOR_READING_GUIDES = "manual";
    const { RecordStorage } = await import("../server/storage.ts");
    const { freezeRules, withRuleSnapshot } =
      await import("../server/skills.ts");
    const training = await import("../server/internal-training.ts");
    const { BudgetLedger } = await import("../server/budget.ts");
    const { taskTiming, TaskDeadline } =
      await import("../server/task-timing.ts");
    const { createProvider } = await import("../server/model-config.ts");
    const { trainingAdmission } =
      await import("../server/training-admission.ts");
    const { CodexClient, CodexRpcFailure } =
      await import("../server/provider.ts");
    const { TaskManager } = await import("../server/orchestrator.ts");
    const { ResearchPlans } = await import("../server/research-plans.ts");
    const { DeckVersions } = await import("../server/deck-versions.ts");
    const { trainingCost } = await import("../server/training-cost.ts");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as LoopReport;
    if (report.quota.originReportHash !== registry.origin)
      throw new Error("额度起点不符。");
    const store = new RecordStorage(join(directory, "records"));
    const checkpoint = async () => {
      await store.save("training", "report", report);
      await writeFile(
        join(folder, "summary.json"),
        JSON.stringify(
          {
            scope: "产品诊断；不是正式候选比较或发布证明",
            shortLoops: report.shortLoops,
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
    const provider = createProvider();
    const fingerprint = digest({
      id: provider.id,
      model: provider.model,
      settings: provider.settings,
    });
    const admit = async () => {
      assertLoopHistory(report);
      const local = await trainingAdmission();
      const attempts = report.batches
        .filter((b) => report.shortLoops!.historicalBatchIds.includes(b.id))
        .flatMap((b) => b.budget.attempts)
        .filter((a) => report.shortLoops!.historicalPendingIds.includes(a.id));
      const evidence: { id: string; state: string; terminal?: string }[] = [];
      const client = new CodexClient();
      try {
        await client.init();
        for (const attempt of attempts) {
          if (attempt.observation?.remoteTerminal) {
            evidence.push({
              id: attempt.id,
              state: "historical-terminal",
              terminal: attempt.observation.remoteTerminal,
            });
            continue;
          }
          if (!attempt.observation?.threadId || !attempt.observation.turnId)
            throw new Error("历史请求缺定位信息，不能形成隔离判断。");
          try {
            const result = await client.rpc(
              "thread/read",
              { threadId: attempt.observation.threadId, includeTurns: true },
              5000,
            );
            const turn = result.thread?.turns?.find(
              (t: any) => t.id === attempt.observation!.turnId,
            );
            if (
              !turn ||
              !["completed", "interrupted", "failed"].includes(turn.status)
            )
              throw new Error("旧请求仍有活动迹象或状态不明确，不派发。");
            evidence.push({
              id: attempt.id,
              state: "read-terminal",
              terminal: turn.status,
            });
          } catch (error) {
            if (
              !(error instanceof CodexRpcFailure) ||
              !error.missingThread ||
              Date.now() - Date.parse(attempt.startedAt) < 600_000
            )
              throw error;
            evidence.push({
              id: attempt.id,
              state: "historical-ephemeral-unavailable",
            });
          }
        }
      } finally {
        client.close();
      }
      const decision = {
        at: new Date().toISOString(),
        local,
        evidence,
        historicalBatchHash: report.shortLoops!.historicalBatchHash,
        reason:
          "用户要求按 v1.4 实施；旧本地批次停止，有界查询未发现可恢复的活动请求。旧未知保持未知；仅派发新冻结任务，不续发旧 attempt。服务异常或新未知时停止。",
      };
      const path = join(folder, `admission-${randomUUID()}.json`);
      await writeFile(path, JSON.stringify(decision, null, 2), { flag: "wx" });
      return path;
    };
    if (command === "prepare") {
      report.shortLoops ??= initializeLoops(report);
      assertLoopHistory(report);
      const paper = await store.read<PaperBundle>("frozen-papers", "train-xu");
      const rules = await freezeRules();
      // A local diagnostic rule, never a new global candidate or effective rule.
      rules.shared += "\n" + training.sourceExplanationCandidate;
      const samples = shortLoopCases.map((test) => ({
        test,
        paper: freezeFragment(paper, test.id),
      }));
      const freeze = {
        version: "short-loop-v1.4",
        scope: "development-diagnostic-only",
        samples,
        rules,
        fingerprint,
        engineHash: digest(await trainingEngine()),
        planHash: await hashFile("docs/ITERATION.md"),
        reservedMaterials,
        historicalBatchHash: report.shortLoops.historicalBatchHash,
      };
      const freezeHash = digest(freeze);
      await writeFile(
        join(folder, `freeze-${freezeHash}.json`),
        JSON.stringify(freeze, null, 2),
      );
      await writeFile(
        join(folder, "current-freeze.json"),
        JSON.stringify({ freezeHash }),
      );
      await checkpoint();
      console.log(
        JSON.stringify({
          modelCalls: 0,
          freezeHash,
          samples: samples.map((s) => ({
            id: s.test.id,
            sourceChars: s.paper.sources.reduce((n, s) => n + s.text.length, 0),
            figures: s.paper.sources.filter((s) => s.image).length,
          })),
          remaining: iterationUsage(report.quota, report.batches)
            .remainingCycle,
        }),
      );
    } else if (command === "status") {
      console.log(
        JSON.stringify(
          {
            usage: iterationUsage(report.quota, report.batches),
            shortLoops: report.shortLoops,
          },
          null,
          2,
        ),
      );
    } else if (command === "admit") {
      const evidence = await admit();
      await unlink(pausePath).catch((e: any) => {
        if (e.code !== "ENOENT") throw e;
      });
      console.log(JSON.stringify({ modelCalls: 0, evidence }));
    } else if (command === "verify") {
      const run = report.shortLoops?.runs.find((r) => r.id === caseId);
      if (!run || run.status !== "completed" || !process.argv[4])
        throw new Error("只能验收已完成的确切诊断记录。");
      const path = resolve(process.argv[4]),
        evidence = JSON.parse(await readFile(path, "utf8"));
      if (
        evidence.runId !== run.id ||
        evidence.freezeHash !== run.freezeHash ||
        !evidence.findings?.length ||
        !run.artifacts?.length ||
        evidence.artifacts?.length !== run.artifacts.length ||
        !(
          await Promise.all(
            run.artifacts.map(async (p) => {
              const hash = await hashFile(p);
              return evidence.artifacts.some(
                (a: any) => a.path === p && a.hash === hash,
              );
            }),
          )
        ).every(Boolean)
      )
        throw new Error("验收依据必须绑定全部实际文件、冻结输入和走查发现。");
      run.scienceValidation = {
        passed: evidence.sciencePassed === true,
        evidence: path,
      };
      run.fileValidation = {
        passed: evidence.filePassed === true,
        evidence: path,
      };
      await checkpoint();
      console.log(
        JSON.stringify({
          runId: run.id,
          science: run.scienceValidation.passed,
          file: run.fileValidation.passed,
          modelCalls: 0,
        }),
      );
    } else {
      await access(pausePath).then(
        () => {
          throw new Error("暂停标志仍在，请先有界 admit，不自动恢复。");
        },
        (e: any) => {
          if (e.code !== "ENOENT") throw e;
        },
      );
      const { freezeHash: baseFreezeHash } = JSON.parse(
        await readFile(join(folder, "current-freeze.json"), "utf8"),
      );
      const freeze = JSON.parse(
        await readFile(join(folder, `freeze-${baseFreezeHash}.json`), "utf8"),
      );
      if (
        digest(freeze) !== baseFreezeHash ||
        freeze.fingerprint !== fingerprint ||
        freeze.engineHash !== digest(await trainingEngine())
      )
        throw new Error(
          "冻结输入、模型或实现变化；先 prepare 新版本，不覆盖旧输入。",
        );
      const lane: LoopLane = ["crop", "edit"].includes(command)
        ? "repair"
        : command === "whole"
          ? "whole"
          : process.argv[4] === "round-2"
            ? "round-2"
            : "round-1";
      if (lane === "whole" && !["ppt", "plan"].includes(caseId ?? ""))
        throw new Error("整体仅支持 ppt 或 plan。");
      const wholeRepair = lane === "whole" && process.argv[4] === "repair";
      if (wholeRepair) {
        const prior = report.shortLoops?.runs.find(
          (r) => r.id === process.argv[5],
        );
        if (
          caseId !== "ppt" ||
          !prior ||
          prior.caseId !== "whole-ppt" ||
          prior.status !== "completed" ||
          prior.scienceValidation?.passed !== false ||
          prior.freezeHash === baseFreezeHash
        )
          throw new Error(
            "整体修复需明确已走查失败的 PPT 记录与新的冻结实现；不自动重跑。",
          );
      }
      const sample = freeze.samples.find(
        (s: any) =>
          s.test.id ===
          (lane === "whole"
            ? caseId === "ppt"
              ? "figure-6f"
              : "protein"
            : ["crop", "edit"].includes(command)
              ? "figure-6f"
              : caseId),
      );
      if (!sample) throw new Error("未知小样本。");
      const parentRun = ["crop", "edit"].includes(command)
        ? report.shortLoops?.runs.find(
            (r) =>
              r.id === caseId &&
              (r.caseId === "figure-6f" ||
                (command === "edit" &&
                  (r.caseId.startsWith("whole-ppt") ||
                    r.caseId.startsWith("edit-")))) &&
              (r.status === "completed" ||
                (command === "edit" && r.status === "failed")),
          )
        : undefined;
      if (
        ["crop", "edit"].includes(command) &&
        (!parentRun || !process.argv[4])
      )
        throw new Error("裁剪仅针对已完成图稿，并需明确选区文件。");
      const crops = ["crop", "edit"].includes(command)
        ? JSON.parse(await readFile(resolve(process.argv[4]), "utf8"))
        : null;
      if (crops) {
        const { imageRegionSchema } = await import("../server/schemas.ts");
        if (
          !Array.isArray(crops.edits) ||
          !crops.edits.length ||
          crops.edits.length > 2
        )
          throw new Error("一次最多修复两页配图。");
        for (const edit of crops.edits) {
          if (command === "crop" || edit.region)
            imageRegionSchema.parse(edit.region);
          if (command === "edit" && typeof edit.notes !== "string")
            throw new Error("手改必须提供确切备注。");
          if (!Number.isInteger(edit.slideIndex) || edit.slideIndex < 0)
            throw new Error("页面编号无效。");
        }
      }
      const freezeHash = crops
        ? digest({ baseFreezeHash, parentRunId: parentRun!.id, crops })
        : baseFreezeHash;
      if (crops)
        await writeFile(
          join(folder, `crop-freeze-${freezeHash}.json`),
          JSON.stringify(
            { baseFreezeHash, parentRunId: parentRun!.id, crops },
            null,
            2,
          ),
          { flag: "wx" },
        );
      if (
        lane === "round-2" &&
        sample.test.id !== "protein" &&
        report.shortLoops?.runs.some(
          (r) => r.caseId === sample.test.id && r.freezeHash === freezeHash,
        )
      )
        throw new Error("第二轮需明确修复的新冻结版本，不能同输入空跑。");
      const record = reserveLoop(
        report,
        lane,
        lane === "whole"
          ? `whole-${caseId}${wholeRepair ? "-repair" : ""}`
          : command === "edit"
            ? `edit-${parentRun!.id}-${digest(crops).slice(0, 12)}`
            : sample.test.id,
        freezeHash,
        lane === "whole" && caseId === "plan" ? 8 : 4,
      );
      const admissionPath = await admit();
      const budget = new BudgetLedger(
        record.id,
        async () => {},
        undefined,
        lane === "whole" ? 2_400_000 : 600_000,
      ).state;
      budget.limit = budget.groupLimit = record.reservedCalls;
      budget.timing = taskTiming(
        sample.test.kind === "paper"
          ? "explanation"
          : lane === "whole"
            ? "full"
            : "fragment",
        6,
      );
      const batch: import("../server/internal-training.ts").TrainingBatch = {
        id: record.id,
        phase: "M2",
        status: "running",
        cycleLimit: 70,
        budget,
      };
      report.batches.push(batch);
      report.shortLoops!.runs.push({ ...record, batchId: batch.id });
      const run = report.shortLoops!.runs.at(-1)!;
      await writeFile(
        join(folder, `${run.id}-dispatch.json`),
        JSON.stringify(
          {
            run,
            admissionPath,
            inputHash: freezeHash,
            sampleId: sample.test.id,
            ...(wholeRepair ? { repairOf: process.argv[5] } : {}),
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      await checkpoint();
      const counted = new training.TrainingProvider(
        provider,
        batch,
        checkpoint,
        (id, data) => store.save("provider-inputs", id, data),
        () => iterationUsage(report.quota, report.batches).current,
      );
      counted.context = `short-loop-${run.id}`;
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("短闭环已暂停"));
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      const totalTimer = setTimeout(
        () => controller.abort(new TaskDeadline("batch-total")),
        budget.timing.taskMs,
      );
      const pauseTimer = setInterval(() => {
        void access(pausePath).then(cancel, (e: any) => {
          if (e.code !== "ENOENT") cancel();
        });
      }, 500);
      const begin = Date.now();
      try {
        const paper: PaperBundle =
          lane === "whole" ||
          ((parentRun?.caseId.startsWith("whole-ppt") ||
            parentRun?.caseId.startsWith("edit-")) ??
            false)
            ? await store.read("frozen-papers", "train-xu")
            : sample.paper;
        const paperById = async () => paper;
        const artifacts: string[] = [],
          taskIds: string[] = [];
        run.artifacts = artifacts;
        run.taskIds = taskIds;
        await withRuleSnapshot(freeze.rules, async () => {
          if (crops) {
            const decks = new DeckVersions(counted, paperById);
            await decks.restoreDisk();
            let version =
              decks.versions.get(parentRun!.taskIds?.at(-1) ?? "") ??
              [...decks.versions.values()].find(
                (v) =>
                  v.runId === parentRun!.taskIds?.[0] &&
                  v.status === "completed" &&
                  !v.parentId,
              );
            if (!version)
              throw new Error("原稿保存版本不存在，不能跳过版本核对。");
            const editLedger = new BudgetLedger(run.id, async () => {});
            editLedger.state.timing = taskTiming("fragment");
            editLedger.state.deadline = new Date(
              Date.now() + editLedger.state.timing.taskMs,
            ).toISOString();
            editLedger.state.limit = editLedger.state.groupLimit = 4;
            for (const edit of crops.edits) {
              const old = version.outline.slides[edit.slideIndex];
              if (!old?.imageSource) throw new Error("指定页缺原图。");
              const next = await decks.start(
                version.id,
                version.conversationId,
                {
                  slideIndex: edit.slideIndex,
                  question:
                    crops.question ??
                    "仅调整原图局部的可读性；保留轴、图例、面板标签和既有科学结论。",
                  slide: {
                    ...old,
                    ...(edit.region ? { imageCrop: edit.region } : {}),
                    ...(edit.notes ? { notes: edit.notes } : {}),
                  },
                },
                { signal: controller.signal, ledger: editLedger },
              );
              taskIds.push(next.id);
              await checkpoint();
              await decks.wait(next.id);
              version = decks.get(next.id);
              const attempted = join(
                folder,
                `${run.id}-${next.id}-version.json`,
              );
              await writeFile(attempted, JSON.stringify(version, null, 2));
              artifacts.push(attempted);
              await checkpoint();
              if (version.status !== "completed")
                throw new Error(version.error ?? version.status);
            }
            if (crops.speechScript !== undefined) {
              if (typeof crops.speechScript !== "string")
                throw new Error("完整稿须为文本。");
              const next = await decks.start(
                version.id,
                version.conversationId,
                {
                  operation: "speech",
                  question:
                    crops.question ?? "核对手改完整稿与逐页备注的一致性。",
                  speechScript: crops.speechScript,
                },
                { signal: controller.signal, ledger: editLedger },
              );
              taskIds.push(next.id);
              await checkpoint();
              await decks.wait(next.id);
              version = decks.get(next.id);
              const attempted = join(
                folder,
                `${run.id}-${next.id}-version.json`,
              );
              await writeFile(attempted, JSON.stringify(version, null, 2));
              artifacts.push(attempted);
              await checkpoint();
              if (version.status !== "completed")
                throw new Error(version.error ?? version.status);
            }
            const saved = join(folder, `${run.id}-version.json`);
            await writeFile(saved, JSON.stringify(version, null, 2));
            artifacts.push(saved);
            const exported = await decks.export(
              version.id,
              version.conversationId,
            );
            const pptPath = join(folder, `${run.id}.pptx`);
            await copyFile(resolve("exports", `${exported.id}.pptx`), pptPath);
            artifacts.push(pptPath);
            if (version.outline.speechScript) {
              const speechPath = join(folder, `${run.id}-speech.md`);
              await writeFile(speechPath, version.outline.speechScript);
              artifacts.push(speechPath);
            }
          } else if (sample.test.kind === "plan") {
            const plans = new ResearchPlans(counted, paperById);
            let plan = await plans.create({
              question: sample.test.question,
              conditions:
                lane === "round-2"
                  ? sample.test.changedConditions
                  : sample.test.conditions,
              studyTypes: ["basic-translational"],
              typeStatus: "provisional",
              sources: [],
            });
            for (const [index, conditions] of (lane === "whole"
              ? [sample.test.conditions, sample.test.changedConditions]
              : [plan.topic.conditions]
            ).entries()) {
              if (index)
                plan = await plans.updateTopic(plan.id, plan.topic.version, {
                  question: sample.test.question,
                  conditions,
                  studyTypes: ["basic-translational"],
                  typeStatus: "provisional",
                  sources: [],
                });
              const job = await plans.start(
                plan.id,
                {
                  requestKey: randomUUID(),
                  expectedVersion: plan.currentVersion,
                  expectedTopicVersion: plan.topic.version,
                  action: "generate",
                  requestedScope:
                    lane === "whole" ? "full-plan" : "design-draft",
                  maxCalls: 4,
                  instruction:
                    "完成一个有完整设计理由的可行设计单元，逐一连接替代解释、测量／比较与限制，不编条件；核对同时检查必要解释。",
                },
                { signal: controller.signal },
              );
              taskIds.push(job.id);
              await checkpoint();
              await plans.wait(job.id);
              const done = plans.job(job.id);
              if (done.status !== "completed" || !done.resultVersion)
                throw new Error(done.error ?? done.status);
              const path = join(folder, `${run.id}-${index + 1}.md`);
              await writeFile(
                path,
                plans.exportMarkdown(plan.id, done.resultVersion),
              );
              artifacts.push(path);
              await checkpoint();
              plan = plans.get(plan.id);
            }
          } else {
            const manager = new TaskManager(counted);
            const task = await manager.start(
              {
                paperId: paper.id,
                module: sample.test.kind,
                mode: "live",
                question:
                  lane === "whole"
                    ? "生成六页完整中文论文 PPT，组织问题、方法、证据及边界，使用对应原图，提供逐页备注和完整演讲稿。"
                    : sample.test.question,
                profileId: "beginner",
                sourceIds: paper.sources.map((s) => s.id),
                taughtConcepts: [],
                checks: {
                  readability: false,
                  reason: "单侧诊断；仅发现具体理解断点时追加试读",
                },
                conversationId: run.id,
                speechScript: lane === "whole",
                slideCount: lane === "whole" ? 6 : undefined,
                ...(lane === "whole"
                  ? {}
                  : { diagnosticScope: "fragment-v1" as const }),
              },
              paper,
              undefined,
              undefined,
              { signal: controller.signal },
            );
            task.budget!.limit = task.budget!.groupLimit = 4;
            taskIds.push(task.id);
            await checkpoint();
            await manager.wait(task.id);
            const path = join(folder, `${run.id}-task.json`);
            await writeFile(path, JSON.stringify(task, null, 2));
            artifacts.push(path);
            await checkpoint();
            if (
              task.status !== "completed" ||
              task.review?.issues.some(
                (i) => !i.resolved && i.severity === "blocking",
              )
            )
              throw new Error(task.error ?? "产物核对未通过");
            if (sample.test.kind === "ppt") {
              if (
                !task.deck?.slides.some((s) => s.imageSource) ||
                (lane !== "whole" &&
                  (task.deck.slides.length < 2 || task.deck.slides.length > 3))
              )
                throw new Error("图稿范围或原图未满足要求。");
              const decks = new DeckVersions(counted, paperById);
              const version = await decks.seed(run.id, paper.id, task);
              const exported = await decks.export(version.id, run.id);
              const pptPath = join(folder, `${run.id}.pptx`);
              await copyFile(
                resolve("exports", `${exported.id}.pptx`),
                pptPath,
              );
              artifacts.push(pptPath);
              if (task.deck.speechScript) {
                const speech = join(folder, `${run.id}-speech.md`);
                await writeFile(speech, task.deck.speechScript);
                artifacts.push(speech);
              }
            } else {
              const { exportNotes } = await import("../server/export.ts");
              const md = join(folder, `${run.id}.md`);
              await writeFile(md, exportNotes(task));
              artifacts.push(md);
            }
          }
        });
        run.status = "completed";
        batch.status = "complete";
      } catch (error) {
        run.status = controller.signal.aborted ? "cancelled" : "failed";
        run.error = String(error);
        batch.status = "stopped";
        batch.stopReason ??= run.error;
        process.exitCode = 1;
      } finally {
        clearTimeout(totalTimer);
        clearInterval(pauseTimer);
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
        run.calls = batch.budget.attempts.length;
        run.endToEndMs = Date.now() - begin;
        run.endedAt = new Date().toISOString();
        await checkpoint();
        console.log(
          JSON.stringify({
            run,
            usage: iterationUsage(report.quota, report.batches),
            publication: "retain-baseline",
          }),
        );
      }
    }
  } finally {
    await lock.close();
    await unlink(join(root, "dispatch.lock"));
  }
}
