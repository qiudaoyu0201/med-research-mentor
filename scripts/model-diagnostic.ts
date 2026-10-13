// A new bounded pilot. Never resumes or modifies a stopped historical cycle.
import { readFile, mkdir, open, unlink, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { digest } from "../server/materials.ts";
import { hashFile, trainingEngine } from "../server/training-engine.ts";
import {
  diagnosticManifest,
  diagnosticLimit,
  diagnosticTiming,
  stoppedParent,
  assertDiagnosticRun,
  diagnosticMetrics,
  finishedDiagnostic,
  type DiagnosticManifest,
  type ParentEvidence,
} from "../server/model-diagnostic.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
import type { RuleSnapshot } from "../server/skills.ts";

const command = process.argv[2];
if (!["prepare", "run", "status", "pause"].includes(command))
  throw new Error(
    "入口：prepare 新清单.json / run 实验ID / status 实验ID / pause 实验ID",
  );
const manifest: DiagnosticManifest | undefined =
  command === "prepare"
    ? diagnosticManifest.parse(
        JSON.parse(await readFile(resolve(process.argv[3]), "utf8")),
      )
    : undefined;
const id = manifest?.id ?? process.argv[3];
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id ?? "") || id.length > 100)
  throw new Error("实验ID无效。");
const directory = resolve("runs/internal-training/model-diagnostics", id);
process.env.TUTOR_DATA_DIR = join(directory, "data");
process.env.TUTOR_READING_GUIDES = "manual";
const { RecordStorage } = await import("../server/storage.ts");
const store = new RecordStorage(join(directory, "records"));
const pausePath = join(directory, "pause.request");
if (command === "pause") {
  // Do not silently create an experiment from a mistyped ID.
  await store.read("diagnostic", "report");
  const file = await open(pausePath, "w");
  try {
    await file.writeFile(new Date().toISOString());
  } finally {
    await file.close();
  }
  console.log("已请求暂停，保留账本；本实验不自动续发。");
  process.exit(0);
}
if (command === "status") {
  const report = await store.read<any>("diagnostic", "report");
  console.log(
    JSON.stringify(
      {
        status: report.status,
        metrics: diagnosticMetrics(report.batch),
        assessment: report.assessment,
        error: report.error,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
await mkdir(resolve("runs/internal-training"), { recursive: true });
const lockPath = resolve("runs/internal-training/dispatch.lock");
const lock = await open(lockPath, "wx");
try {
  const { createProvider } = await import("../server/model-config.ts");
  const { freezeRules, withRuleSnapshot } = await import("../server/skills.ts");
  const { BudgetLedger } = await import("../server/budget.ts");
  const { trainingAdmission } = await import("../server/training-admission.ts");
  const { DiagnosticJsonProvider } =
    await import("../server/diagnostic-json-provider.ts");
  const rawProvider = createProvider();
  const mode =
    manifest?.structuredDelivery ??
    (await store.read<{ manifest: DiagnosticManifest }>("freeze", "inputs"))
      .manifest.structuredDelivery;
  const provider =
    mode === "json-string"
      ? new DiagnosticJsonProvider(rawProvider)
      : rawProvider;
  if (provider.model !== "gpt-6.1-sol")
    throw new Error("本诊断必须显式选用 gpt-6.1-sol，不回退模型。");
  const parentAdmission = async (parent: { batches: TrainingBatch[] }) => {
    const evidence: ParentEvidence[] = [];
    const pending = parent.batches
      .flatMap((b) => b.budget.attempts)
      .filter(
        (a) =>
          a.status !== "succeeded" &&
          !["completed", "failed", "interrupted"].includes(
            a.observation?.remoteTerminal ?? "",
          ),
      );
    if (!pending.length) return evidence;
    const { CodexClient, CodexRpcFailure } =
      await import("../server/provider.ts");
    const client = new CodexClient();
    try {
      await client.init();
      for (const attempt of pending) {
        const threadId = attempt.observation?.threadId,
          turnId = attempt.observation?.turnId;
        if (!threadId || !turnId) throw new Error("历史未知请求缺少定位信息。");
        let result: ParentEvidence["result"];
        try {
          const value = await client.rpc(
            "thread/read",
            { threadId, includeTurns: true },
            5000,
          );
          const turn = value.thread?.turns?.find((t: any) => t.id === turnId);
          if (
            !turn ||
            !["completed", "failed", "interrupted"].includes(turn.status)
          )
            throw new Error("历史请求仍可能活动，不派发。");
          result = turn.status;
        } catch (error) {
          if (
            !(error instanceof CodexRpcFailure) ||
            !error.missingThread ||
            Date.now() - Date.parse(attempt.startedAt) < 600_000
          )
            throw error;
          result = "historical-ephemeral-unavailable";
        }
        evidence.push({
          id: attempt.id,
          threadId,
          turnId,
          checkedAt: new Date().toISOString(),
          result,
        });
      }
    } finally {
      client.close();
    }
    return evidence;
  };
  const fingerprint = {
    id: provider.id,
    model: provider.model,
    settings: provider.settings,
    capabilities: provider.capabilities,
    billingMode: provider.billingMode,
  };
  const bindings = async (
    value: DiagnosticManifest,
    paper: PaperBundle,
    rules: RuleSnapshot,
  ) => ({
    manifest: value,
    paperHash: digest(paper),
    rulesHash: digest(rules),
    provider: fingerprint,
    timing: diagnosticTiming,
    limit: diagnosticLimit,
    engineHash: digest(await trainingEngine()),
    planHash: await hashFile("docs/ITERATION.md"),
    parentHash: await hashFile(resolve(value.parentReport)),
    previousDiagnosticHash: value.previousDiagnostic
      ? await hashFile(resolve(value.previousDiagnostic))
      : null,
  });
  if (command === "prepare") {
    await mkdir(directory, { recursive: true });
    const claim = await open(join(directory, "claim.json"), "wx");
    try {
      await claim.writeFile(
        JSON.stringify({
          id,
          limit: diagnosticLimit,
          createdAt: new Date().toISOString(),
        }),
      );
    } finally {
      await claim.close();
    }
    const parent = JSON.parse(
      await readFile(resolve(manifest!.parentReport), "utf8"),
    );
    const parentEvidence = await parentAdmission(parent);
    const history = stoppedParent(parent, parentEvidence);
    const priorDiagnosticCalls = manifest!.previousDiagnostic
      ? finishedDiagnostic(
          JSON.parse(
            await readFile(resolve(manifest!.previousDiagnostic), "utf8"),
          ),
        )
      : 0;
    const paper: PaperBundle = JSON.parse(
      await readFile(resolve(manifest!.paperPath), "utf8"),
    );
    if (
      !paper.sources.length ||
      new Set(manifest!.sourceIds).size !== manifest!.sourceIds.length ||
      manifest!.sourceIds.some(
        (sourceId) => !paper.sources.some((s) => s.id === sourceId),
      )
    )
      throw new Error("样本来源绑定无效。");
    const rules = await freezeRules();
    if (manifest!.sharedAddition)
      rules.shared += "\n" + manifest!.sharedAddition;
    const contract = await bindings(manifest!, paper, rules);
    const budget = new BudgetLedger(
      id,
      async () => {},
      undefined,
      diagnosticTiming.taskMs,
    ).state;
    budget.limit = budget.groupLimit = diagnosticLimit;
    budget.timing = diagnosticTiming;
    const batch: TrainingBatch = {
      id,
      phase: "M1",
      status: "awaiting-continuation",
      cycleLimit: diagnosticLimit,
      budget,
    };
    await store.save("freeze", "inputs", {
      manifest,
      paper,
      rules,
      contract,
      contractHash: digest(contract),
    });
    await store.save("diagnostic", "report", {
      id,
      status: "prepared",
      batch,
      contractHash: digest(contract),
      history,
      parentEvidence,
      priorDiagnosticCalls,
      scope:
        "独立八次诊断；父周期调用保持原状，不使用旧余额，不构成候选发布、盲测或真人效果证据。",
    });
    console.log(
      JSON.stringify({
        id,
        modelCalls: 0,
        contractHash: digest(contract),
        limit: diagnosticLimit,
      }),
    );
  } else {
    const frozen = await store.read<{
      manifest: DiagnosticManifest;
      paper: PaperBundle;
      rules: RuleSnapshot;
      contractHash: string;
    }>("freeze", "inputs");
    const report = await store.read<any>("diagnostic", "report");
    assertDiagnosticRun(
      report.status,
      report.batch,
      frozen.contractHash,
      digest(await bindings(frozen.manifest, frozen.paper, frozen.rules)),
    );
    const parent = JSON.parse(
      await readFile(resolve(frozen.manifest.parentReport), "utf8"),
    );
    report.parentEvidence = await parentAdmission(parent);
    stoppedParent(parent, report.parentEvidence);
    if (
      frozen.manifest.previousDiagnostic &&
      report.priorDiagnosticCalls !==
        finishedDiagnostic(
          JSON.parse(
            await readFile(resolve(frozen.manifest.previousDiagnostic), "utf8"),
          ),
        )
    )
      throw new Error("前诊断累计变化，停止派发。");
    if (
      await access(pausePath).then(
        () => true,
        () => false,
      )
    )
      throw new Error("该实验已请求暂停。");
    report.admission = await trainingAdmission(frozen.manifest.onlineUrl);
    // Apply only to this internal process. The running online service is untouched.
    const fields = {
      taskMs: "TASK_MS",
      requestMs: "REQUEST_MS",
      firstOutputMs: "FIRST_OUTPUT_MS",
      idleMs: "IDLE_MS",
      targetTaskMs: "TARGET_TASK_MS",
      targetRequestMs: "TARGET_REQUEST_MS",
      targetFirstOutputMs: "TARGET_FIRST_OUTPUT_MS",
      targetIdleMs: "TARGET_IDLE_MS",
    } as const;
    for (const [field, suffix] of Object.entries(fields))
      process.env["TUTOR_INTERNAL_" + suffix] = String(
        diagnosticTiming[field as keyof typeof fields],
      );
    report.status = "running";
    report.startedAt = new Date().toISOString();
    report.batch.status = "running";
    report.batch.budget.deadline = new Date(
      Date.now() + diagnosticTiming.taskMs,
    ).toISOString();
    const persist = async () => {
      report.metrics = {
        ...diagnosticMetrics(report.batch),
        priorDiagnosticCalls: report.priorDiagnosticCalls,
        combinedDiagnosticCalls:
          report.priorDiagnosticCalls + report.batch.budget.attempts.length,
      };
      await store.save("diagnostic", "report", report);
    };
    await persist(); // Durable claim before the first provider request.
    const { TrainingProvider, reviewArtifact } =
      await import("../server/internal-training.ts");
    const { TaskManager, materialSources } =
      await import("../server/orchestrator.ts");
    const { strictDevelopmentAcceptance, mainlineDevelopmentAcceptance } =
      await import("../server/development-acceptance.ts");
    const counted = new TrainingProvider(
      provider,
      report.batch,
      persist,
      (attemptId, input) => store.save("provider-inputs", attemptId, input),
      () => report.batch.budget.attempts.length,
    );
    const controller = new AbortController();
    const stop = () =>
      controller.abort(new Error("诊断已取消；保留结果，不自动重发。"));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const timer = setTimeout(stop, diagnosticTiming.taskMs);
    const pauseTimer = setInterval(
      () => void access(pausePath).then(stop, () => {}),
      500,
    );
    try {
      counted.context = "product";
      let artifact: unknown;
      let sources: { id: string; text: string; locator: string }[];
      let image: string | undefined;
      if (frozen.manifest.module === "research-plan") {
        const { runDiagnosticPlan } =
          await import("../server/diagnostic-plan.ts");
        const result = await withRuleSnapshot(frozen.rules, () =>
          runDiagnosticPlan({
            provider: counted,
            manifest: frozen.manifest,
            paper: frozen.paper,
            signal: controller.signal,
            persist: (group, taskId, value) => store.save(group, taskId, value),
            progress: async (value) => {
              Object.assign(report, value);
              await persist();
            },
          }),
        );
        report.assessment = result.assessment;
        report.roleMetrics = result.roleMetrics;
        artifact = result.artifact;
        sources = result.sources;
        await persist();
      } else {
        const module = frozen.manifest.module;
        const manager = new TaskManager(
          counted,
          (group, taskId, value) => store.save(group, taskId, value),
          "internal",
        );
        const run = await withRuleSnapshot(frozen.rules, async () => {
          const run = await manager.start(
            {
              paperId: frozen.paper.id,
              module,
              mode: "live",
              profileId: "beginner",
              question: frozen.manifest.question,
              sourceIds: frozen.manifest.sourceIds,
              taughtConcepts: [],
              ...(frozen.manifest.module === "ppt"
                ? { slideCount: frozen.manifest.slideCount }
                : {}),
              checks: { readability: true, reason: "当前模型小批内部诊断" },
            },
            frozen.paper,
            undefined,
            undefined,
            { signal: controller.signal },
          );
          report.runId = run.id;
          await persist();
          await manager.wait(run.id);
          return run;
        });
        report.roleMetrics = run.budget?.attempts.map((a) => ({
          id: a.id,
          role: a.role,
          status: a.status,
          durationMs: a.durationMs,
          outputChars: a.outputChars,
          meaningfulChars: a.rawOutput?.trimEnd().length ?? null,
          timing: a.timing,
          observation: a.observation,
        }));
        report.assessment = {
          runStatus: run.status,
          mainlinePassed: mainlineDevelopmentAcceptance(run),
          strictPassed: strictDevelopmentAcceptance(run),
          unresolvedIssues: run.review?.issues.filter((i) => !i.resolved),
          breakpoints: run.novice?.breakpoints.filter(
            (p) => p.status !== "resolved",
          ),
        };
        await persist();
        if (run.status !== "completed" || !run.result)
          throw new Error(run.error ?? run.status);
        const material = materialSources(run, frozen.paper);
        sources = material.map((s) => ({
          id: s.id,
          text: s.text,
          locator: s.locator,
        }));
        const { pptDeckImagePacket } =
          await import("../server/ppt-image-packet.ts");
        image =
          frozen.manifest.module === "ppt"
            ? await pptDeckImagePacket(run.deck, material)
            : undefined;
        artifact = { unit: run.result, deck: run.deck ?? null };
      }
      if (
        report.batch.budget.attempts.some((a: any) => a.status !== "succeeded")
      )
        throw new Error("产物请求未全部成功，不再派发独立评价。");
      counted.context = "independent-evaluation";
      report.evaluation = await reviewArtifact(
        counted,
        {
          question: frozen.manifest.question,
          conditions: "只评价本轮来源范围，不声称整篇论文或真人学习效果。",
          criteria: frozen.manifest.criteria,
          artifact,
          sources,
          evaluatorVersion:
            frozen.manifest.module === "ppt"
              ? "explanation-and-deck-images-v3-visible-text"
              : "explanation-v2-visible-text",
        },
        controller.signal,
        image,
      );
      report.status =
        report.assessment.strictPassed &&
        report.evaluation.valid &&
        report.evaluation.passed
          ? "diagnostic-passed"
          : "needs-improvement";
      report.batch.status = "complete";
    } catch (error) {
      report.status = controller.signal.aborted ? "cancelled" : "stopped";
      report.error = String(error);
      report.batch.status = "stopped";
      report.batch.stopReason = report.error;
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
      clearInterval(pauseTimer);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      report.endedAt = new Date().toISOString();
      await persist();
      console.log(
        JSON.stringify(
          {
            id,
            status: report.status,
            metrics: report.metrics,
            assessment: report.assessment,
            evaluation: report.evaluation,
            error: report.error,
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
