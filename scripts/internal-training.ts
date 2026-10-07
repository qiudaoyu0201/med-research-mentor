import {
  mkdir,
  readFile,
  writeFile,
  open,
  copyFile,
  readdir,
} from "node:fs/promises";
import { z } from "zod";
import {
  trainingLineage,
  iterationLineage,
} from "../server/training-lineage.ts";
import {
  iterationUsage,
  comparisonUpperBound,
  reserveIterationUnit,
  developmentPassed,
  type IterationQuota,
} from "../server/training-protocol.ts";
import { explanationCalibration } from "../evals/explanation-calibration.ts";
import { trainingAdmission } from "../server/training-admission.ts";
import { trainingCost } from "../server/training-cost.ts";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  trainingPapers,
  trainingCases,
  artifactCriteria,
  explanationCriteria,
  type TrainingCase,
} from "../evals/internal-training-cases.ts";
import type { AssistantTurn, PaperBundle, TaskRun } from "../shared/types.ts";
import type { PlanJob } from "../shared/research-plan.ts";
import {
  candidateRules,
  explanationCandidateRules,
  explanationReviewInstructions,
  TrainingProvider,
  assertContinuation,
  reserveUnit,
  reviewArtifact,
  calibrationCases,
  reviewVersion,
  reviewSchema as independentReviewSchema,
  textValues,
  type TrainingBatch,
} from "../server/internal-training.ts";

const directory = resolve(
  process.env.TUTOR_TRAINING_DIR ?? "runs/internal-training/cycle-1",
);
const runsRoot = resolve("runs/internal-training"),
  rel = relative(runsRoot, directory);
if (!rel || rel.startsWith("..") || isAbsolute(rel))
  throw new Error("运行目录必须在 runs/internal-training 的独立周期子目录。");
const stage = process.argv[2] ?? "prepare";
const iteration = process.env.TUTOR_TRAINING_QUOTA === "iteration-v1.1-70x3";
if (process.env.TUTOR_TRAINING_QUOTA && !iteration)
  throw new Error("未知训练额度版本。");
if (!["prepare", "m1", "m2"].includes(stage))
  throw new Error("入口：prepare / m1 / m2；M3 独立试验另行运行。");
// Set isolation before loading any module that binds its default storage root.
process.env.TUTOR_DATA_DIR = join(directory, "data");
process.env.TUTOR_READING_GUIDES = "manual";
await mkdir(directory, { recursive: true });
const globalLock = await open(join(runsRoot, "dispatch.lock"), "wx").catch(
  () => {
    throw new Error("另一个训练入口运行中，当前入口不派发模型请求。");
  },
);
const lock = await open(join(directory, "runner.lock"), "wx").catch(
  async () => {
    await globalLock.close();
    const { unlink } = await import("node:fs/promises");
    await unlink(join(runsRoot, "dispatch.lock"));
    throw new Error("此周期已在运行或上次中断；检查原账本，不自动另起训练。");
  },
);
try {
  const { RecordStorage } = await import("../server/storage.ts");
  const { parsePdf } = await import("../server/pdf.ts");
  const { bindPaperEvidence, digest, materialPacket, defaultPaperSources } =
    await import("../server/materials.ts");
  const { freezeRules, withRuleSnapshot } = await import("../server/skills.ts");
  const { createProvider } = await import("../server/model-config.ts");
  const { BudgetLedger } = await import("../server/budget.ts");
  const { TaskManager } = await import("../server/orchestrator.ts");
  const { ConversationStore } = await import("../server/conversation.ts");
  const { AssistantService, rulePlan } = await import("../server/assistant.ts");
  const { ResearchPlans } = await import("../server/research-plans.ts");
  const { DeckVersions } = await import("../server/deck-versions.ts");
  const { withFoundationSources } = await import("../server/foundations.ts");
  const storage = new RecordStorage(join(directory, "records"));
  type Evaluation = Awaited<ReturnType<typeof reviewArtifact>>;
  interface UnitResult {
    id: string;
    side: "baseline" | "candidate";
    status: string;
    artifact?: unknown;
    run?: TaskRun;
    turn?: AssistantTurn;
    jobs?: PlanJob[];
    sources?: { id: string; text: string; locator: string }[];
    evaluation?: Evaluation;
    exportPath?: string;
    error?: string;
    startedAt?: string;
    providerMs: number;
    endToEndMs: number;
    calls: number;
  }
  interface Report {
    protocolHash: string;
    priorAttempts: number;
    quota?: IterationQuota;
    admission?: unknown[];
    batches: TrainingBatch[];
    calibration: {
      id: string;
      expected: boolean;
      expectedChecks?: { criterion: string; passed: boolean }[];
      reusedFrom?: string;
      evaluation: Evaluation;
    }[];
    results: UnitResult[];
    decision: string;
    stopReason?: string;
  }
  const provider = createProvider();
  const fingerprint = {
    id: provider.id,
    model: provider.model,
    settings: provider.settings,
    capabilities: provider.capabilities,
  };
  const fileHash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const papers: PaperBundle[] = [];
  const lineage = await trainingLineage(directory);
  const quota = iteration ? await iterationLineage(directory) : undefined;
  if (quota) {
    // One append-only lineage per authorization; sibling directories cannot reset the allowance.
    const registryPath = join(runsRoot, "iteration-lineage.json");
    let registry: { origin: string; directories: string[] } = {
      origin: quota.originReportHash,
      directories: [],
    };
    try {
      registry = JSON.parse(await readFile(registryPath, "utf8"));
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      registry.origin !== quota.originReportHash ||
      (registry.directories[quota.cycle - 1] &&
        registry.directories[quota.cycle - 1] !== directory) ||
      registry.directories.length < quota.cycle - 1 ||
      (quota.cycle > 1 &&
        registry.directories[quota.cycle - 2] !== lineage.previousDirectory)
    )
      throw new Error(
        "候选目录偏离已登记的额度 lineage，不能另建目录重置预算。",
      );
    registry.directories[quota.cycle - 1] = directory;
    await writeFile(registryPath, JSON.stringify(registry, null, 2));
  }
  const baseline = await freezeRules(),
    candidate = iteration
      ? explanationCandidateRules(baseline, (quota?.cycle ?? 0) >= 2)
      : candidateRules(baseline);
  const engineFiles = (
    await Promise.all(
      ["server", "shared", "scripts", "evals"].map(async (root) =>
        (await readdir(root, { recursive: true }))
          .filter((p) => /\.(ts|ps1)$/.test(p))
          .map((p) => join(root, p)),
      ),
    )
  )
    .flat()
    .concat("package.json", "package-lock.json")
    .sort();
  const engine = await Promise.all(
    engineFiles.map(async (path) => ({ path, hash: await fileHash(path) })),
  );
  const materials = [];
  for (const input of trainingPapers) {
    const hash = await fileHash(input.path);
    const snapshotPath = join(directory, `${input.id}.pdf`);
    try {
      if ((await fileHash(snapshotPath)) !== hash)
        throw new Error("冻结 PDF 与原材料不一致");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await copyFile(input.path, snapshotPath);
    }
    // Figure display assets use the ordinary uploads path inside the isolated data root.
    await mkdir(join(directory, "data/uploads"), { recursive: true });
    const uploadPath = join(directory, "data/uploads", `${input.id}.pdf`);
    try {
      if ((await fileHash(uploadPath)) !== hash)
        throw new Error("隔离导出副本与冻结 PDF 不一致");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await copyFile(snapshotPath, uploadPath);
    }
    let paper: PaperBundle;
    try {
      paper = await storage.read<PaperBundle>("frozen-papers", input.id);
      if (paper.version !== `${hash}-pdf-figures-v2`)
        throw new Error("冻结解析版本变化");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      paper = bindPaperEvidence(
        await parsePdf(snapshotPath, input.id, input.title),
      );
    }
    if (paper.parseStatus === "failed" || !paper.sources.length)
      throw new Error(`${input.id} 无可读材料`);
    papers.push(paper);
    materials.push({
      ...input,
      hash,
      snapshotPath,
      version: paper.version,
      sources: paper.sources,
    });
    await storage.save("frozen-papers", paper.id, paper);
  }
  if (
    new Set(materials.map((p) => p.study)).size !== 4 ||
    new Set(materials.map((p) => p.hash)).size !== 4
  )
    throw new Error("开发与留出材料重复");
  const paperById = async (id: string) => {
    const paper = papers.find((p) => p.id === id);
    if (!paper) throw new Error("未知论文");
    return paper;
  };
  const preflight = [];
  for (const test of trainingCases) {
    const paper = await paperById(test.paperId);
    const selected = defaultPaperSources(
      withFoundationSources(paper),
      test.question,
      [test.kind === "plan" ? "paper" : test.kind],
    );
    const packet = materialPacket(selected, test.question);
    if (!packet.references.length) throw new Error(`${test.id} 无可用来源`);
    if (test.kind === "ppt" && !selected.some((s) => s.image))
      throw new Error(`${test.id} 缺原图`);
    // Use actual automatic routing, never inject hidden sourceIds into the request.
    if (test.kind !== "plan") {
      const conversations = new ConversationStore();
      const state = await conversations.create({ paperId: paper.id });
      const plan = rulePlan(
        {
          clientMessageId: randomUUID(),
          mode: "live",
          module: test.kind,
          question: test.question,
          slideCount: 6,
        },
        state,
        withFoundationSources(paper),
      );
      if (plan?.clarification)
        throw new Error(`${test.id} 普通路径会请求补充：${plan.clarification}`);
    }
    preflight.push({
      id: test.id,
      packet,
      figures: selected
        .filter((s) => s.image)
        .map((s) => ({ id: s.id, page: s.page, imageRegion: s.imageRegion })),
    });
  }
  const protocol = {
    version: iteration ? "internal-iteration-v1.1" : "internal-first-cycle-2",
    quota,
    lineage,
    git: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    engine,
    fingerprint,
    baseline,
    candidate,
    baselineHash: digest(baseline),
    candidateHash: digest(candidate),
    materials,
    cases: trainingCases,
    preflight,
    reviewVersion,
    evaluatorHash: iteration
      ? digest(explanationReviewInstructions)
      : reviewVersion,
    calibrationCases: iteration ? explanationCalibration : calibrationCases,
    caseUpperBounds: trainingCases.map((test) => ({
      id: test.id,
      calls: iteration ? comparisonUpperBound(test) : 16,
    })),
    maxCalls: iteration ? 70 : 108,
    batchLimit: 24,
    batchMinutes: 45,
    answerCache: false,
    supportingInformation: false,
  };
  // Git HEAD is informational; exact executable hashes, inputs and rules define continuation.
  const { git: _git, ...comparable } = protocol;
  const protocolHash = digest(comparable);
  let report: Report;
  try {
    report = await storage.read<Report>("training", "report");
    if (
      stage === "prepare" &&
      report.protocolHash !== protocolHash &&
      report.batches.length === 0 &&
      report.results.length === 0 &&
      report.calibration.length === 0
    ) {
      // Input-only repair before any model exposure is still M0, not a new trained candidate.
      report.protocolHash = protocolHash;
      await storage.save("training", "protocol", protocol);
    }
    if (report.protocolHash !== protocolHash)
      throw new Error(
        "输入、引擎、规则或模型版本变化；原周期不继续，需新周期与独立留出。",
      );
    assertContinuation(report.batches);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    report = {
      protocolHash,
      priorAttempts: lineage.attempts,
      quota,
      batches: [],
      calibration: [],
      results: [],
      decision: "retain-baseline-unverified",
    };
    if (iteration && quota && quota.cycle > 1 && lineage.previousDirectory) {
      const previousProtocol = JSON.parse(
        await readFile(
          join(lineage.previousDirectory, "records/training/protocol.json"),
          "utf8",
        ),
      );
      const previousReport = JSON.parse(
        await readFile(
          join(lineage.previousDirectory, "records/training/report.json"),
          "utf8",
        ),
      );
      if (
        previousProtocol.evaluatorHash === protocol.evaluatorHash &&
        digest(previousProtocol.fingerprint) === digest(fingerprint) &&
        digest(previousProtocol.calibrationCases) ===
          digest(explanationCalibration) &&
        previousProtocol.reviewVersion === reviewVersion &&
        previousReport.calibration.length === 6 &&
        previousReport.calibration.every(
          (c: Report["calibration"][number]) =>
            c.evaluation.valid &&
            c.expectedChecks?.every((check) =>
              c.evaluation.review.checks.some(
                (actual) =>
                  actual.criterion === check.criterion &&
                  actual.passed === check.passed,
              ),
            ),
        )
      ) {
        let identical = true;
        for (const sample of explanationCalibration) {
          const attempt = previousReport.batches
            .flatMap((b: TrainingBatch) => b.budget.attempts)
            .find(
              (a: any) =>
                a.role === `calibration-${sample.id}` &&
                a.status === "succeeded",
            );
          const saved = attempt
            ? JSON.parse(
                await readFile(
                  join(
                    lineage.previousDirectory,
                    "records/provider-inputs",
                    `${attempt.id}.json`,
                  ),
                  "utf8",
                ),
              )
            : null;
          const input = {
            question: "逐项判断必要解释、事实与材料范围",
            conditions: "预先核对的局部产物",
            evaluatorVersion: "explanation-v1",
            criteria: sample.checks.map((c) => c.criterion),
            artifact: { text: sample.text },
            sources: [
              {
                id: "calibration-source",
                text: sample.source,
                locator: "校准原句",
              },
            ],
          };
          identical &&=
            !!saved &&
            digest(saved.input) === digest(input) &&
            saved.instructions === explanationReviewInstructions &&
            digest(saved.schema) ===
              digest(z.toJSONSchema(independentReviewSchema));
        }
        if (identical)
          report.calibration = structuredClone(
            previousReport.calibration as Report["calibration"],
          ).map((c) => ({ ...c, reusedFrom: lineage.previousDirectory }));
      }
    }
    await storage.save("training", "protocol", protocol);
  }
  const checkpoint = async () => {
    await storage.save("training", "report", report);
    await writeFile(
      join(directory, "summary.json"),
      JSON.stringify(
        {
          protocolHash,
          cost: trainingCost(report.batches, report.priorAttempts, quota),
          iterationCost: quota ? iterationUsage(quota, report.batches) : null,
          runnerResourceUsage: {
            ...process.resourceUsage(),
            scope:
              "仅当前 Node 进程，不含模型服务、子进程或整机负载；maxRSS 单位 KiB，CPU 时间单位微秒。",
          },
          decision: report.decision,
          stopReason: report.stopReason,
          calibration: report.calibration.map((c) => ({
            id: c.id,
            reusedFrom: c.reusedFrom ?? null,
            matched: c.evaluation.valid && c.evaluation.passed === c.expected,
            dimensionsMatched: c.expectedChecks?.every((check) =>
              c.evaluation.review.checks.some(
                (actual) =>
                  actual.criterion === check.criterion &&
                  actual.passed === check.passed,
              ),
            ),
          })),
          batches: report.batches,
          results: report.results.map(
            ({ artifact, sources, run, turn, jobs, ...brief }) => brief,
          ),
        },
        null,
        2,
      ),
    );
  };
  await checkpoint();
  console.log(
    JSON.stringify({
      stage,
      protocolHash,
      cases: preflight.map((c) => ({
        id: c.id,
        references: c.packet.references.length,
        figures: c.figures.length,
      })),
      modelCalls: 0,
    }),
  );
  if (stage === "prepare") {
    /* zero external calls */
  } else {
    if (iteration) await trainingAdmission();
    if (report.stopReason) throw new Error(report.stopReason);
    if (
      stage === "m2" &&
      !report.results.some(
        (r) =>
          r.id === "D1" &&
          r.side === "candidate" &&
          r.status === "generated" &&
          r.evaluation?.valid &&
          r.evaluation.passed,
      )
    )
      throw new Error("开发候选未达质量门槛，不消耗后续比较与留出调用。");
    if (
      stage === "m2" &&
      (report.calibration.length !== 6 ||
        report.calibration.some(
          (c) => !c.evaluation.valid || c.evaluation.passed !== c.expected,
        ) ||
        !["baseline", "candidate"].every((side) =>
          report.results.some(
            (r) => r.id === "D1" && r.side === side && r.evaluation,
          ),
        ))
    )
      throw new Error("M1 未完成校准与 D1 独立评价，不进入 M2。");
    const batch: TrainingBatch = {
      id: randomUUID(),
      phase: stage === "m1" ? "M1" : "M2",
      cycleLimit: iteration ? 70 : 108,
      status: "running",
      budget: new BudgetLedger("batch", async () => {}, undefined, 45 * 60_000)
        .state,
    };
    batch.budget.limit = 24;
    batch.budget.groupLimit = 24;
    report.batches.push(batch);
    await checkpoint();
    const used = () =>
      report.batches.reduce(
        (n, b) => n + b.budget.attempts.length,
        iteration ? 0 : report.priorAttempts,
      );
    const reserve = (required: number, minimumMs?: number) => {
      if (quota) reserveIterationUnit(quota, report.batches, required);
      reserveUnit(batch, required, used(), minimumMs);
    };
    const counted = new TrainingProvider(
      provider,
      batch,
      checkpoint,
      (id, data) => storage.save("provider-inputs", id, data),
      used,
    );
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("训练已取消"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      if (stage === "m1" && !iteration) {
        for (const sample of calibrationCases) {
          if (report.calibration.some((c) => c.id === sample.id)) continue;
          reserve(1);
          counted.context = `calibration-${sample.id}`;
          const evaluation = await reviewArtifact(
            counted,
            {
              question: sample.criterion,
              conditions: "预先核对的局部产物",
              criteria: [sample.criterion],
              artifact: { text: sample.text },
              sources: [
                {
                  id: "calibration-source",
                  text: sample.source,
                  locator: "校准原句",
                },
              ],
            },
            controller.signal,
          );
          report.calibration.push({
            id: sample.id,
            expected: sample.expected,
            evaluation,
          });
          await checkpoint();
          console.log(
            "calibration",
            sample.id,
            evaluation.valid && evaluation.passed === sample.expected
              ? "matched"
              : "mismatch",
          );
          // Invalid coverage/evidence cannot count as correct rejection.
          if (!evaluation.valid || evaluation.passed !== sample.expected)
            throw new Error("评价校准未通过，停止产物比较并保留基线。");
        }
      }
      if (stage === "m1" && iteration) {
        if (report.calibration.length < 6)
          reserve(6 - report.calibration.length);
        for (const sample of explanationCalibration) {
          if (report.calibration.some((c) => c.id === sample.id)) continue;
          counted.context = `calibration-${sample.id}`;
          const evaluation = await reviewArtifact(
            counted,
            {
              question: "逐项判断必要解释、事实与材料范围",
              conditions: "预先核对的局部产物",
              evaluatorVersion: "explanation-v1",
              criteria: sample.checks.map((c) => c.criterion),
              artifact: { text: sample.text },
              sources: [
                {
                  id: "calibration-source",
                  text: sample.source,
                  locator: "校准原句",
                },
              ],
            },
            controller.signal,
          );
          const expected = sample.checks.every((c) => c.passed);
          report.calibration.push({
            id: sample.id,
            expected,
            expectedChecks: [...sample.checks],
            evaluation,
          });
          await checkpoint();
          const matched =
            evaluation.valid &&
            sample.checks.every((check) =>
              evaluation.review.checks.some(
                (actual) =>
                  actual.criterion === check.criterion &&
                  actual.passed === check.passed,
              ),
            );
          console.log(
            "calibration",
            sample.id,
            matched ? "matched" : "mismatch",
          );
          if (!matched)
            throw new Error("新评价逐维校准未通过，停止比较并保留基线。");
        }
      }
      const selectedCases =
        stage === "m1"
          ? trainingCases.filter((c) => c.id === "D1")
          : trainingCases.filter((c) => c.id !== "D1");
      for (const test of selectedCases) {
        if (
          ["baseline", "candidate"].every((side) =>
            report.results.some((r) => r.id === test.id && r.side === side),
          )
        )
          continue;
        // Reserve a complete pair, including failure and independent evaluations.
        if (
          iteration &&
          test.split === "holdout" &&
          !developmentPassed(report.results)
        ) {
          report.decision = "retain-baseline-development-failed";
          break;
        }
        if (
          iteration &&
          report.results.some((r) => r.id === test.id) &&
          !["baseline", "candidate"].every((side) =>
            report.results.some((r) => r.id === test.id && r.side === side),
          )
        )
          throw new Error("比较单元不完整，保留记录，不自动补发。");
        reserve(iteration ? comparisonUpperBound(test) : 16);
        if (iteration) {
          (report.admission ??= []).push({
            caseId: test.id,
            at: new Date().toISOString(),
            ...(await trainingAdmission()),
          });
          await checkpoint();
        }
        for (const side of ["baseline", "candidate"] as const) {
          if (report.results.some((r) => r.id === test.id && r.side === side))
            continue;
          const begin = Date.now(),
            before = batch.budget.attempts.length;
          const result: UnitResult = {
            id: test.id,
            side,
            status: "running",
            startedAt: new Date(begin).toISOString(),
            calls: 0,
            providerMs: 0,
            endToEndMs: 0,
          };
          report.results.push(result);
          await checkpoint();
          counted.context = `${test.id}-${side}-generation`;
          console.log("start", test.id, side);
          try {
            await withRuleSnapshot(
              side === "baseline" ? baseline : candidate,
              async () => {
                const paper = await paperById(test.paperId);
                if (test.kind === "plan") {
                  const plans = new ResearchPlans(counted, paperById);
                  const sources = paper.sources
                    .filter((s) => !s.image && s.page === 1)
                    .map((s) => ({
                      paperId: paper.id,
                      sourceVersion: paper.version,
                      sourceId: s.id,
                    }));
                  const outputs = [],
                    jobs = [];
                  let continuingPlan:
                    Awaited<ReturnType<typeof plans.create>> | undefined;
                  for (const conditions of [
                    test.conditions,
                    ...("changedConditions" in test
                      ? [test.changedConditions]
                      : []),
                  ]) {
                    const topic = {
                      question: test.question,
                      conditions,
                      studyTypes: [test.studyType],
                      typeStatus: "provisional",
                      sources,
                    };
                    const plan =
                      iteration && continuingPlan
                        ? await plans.updateTopic(
                            continuingPlan.id,
                            continuingPlan.topic.version,
                            topic,
                          )
                        : await plans.create(topic);
                    const job = await plans.start(plan.id, {
                      requestKey: randomUUID(),
                      expectedVersion: plan.currentVersion,
                      expectedTopicVersion: plan.topic.version,
                      action: "generate",
                      requestedScope: "design-draft",
                      maxCalls: 2,
                      instruction:
                        "写可理解、可修改的设计草案。必要条件保留为未知，简洁说明设计理由；不把建议写成已完成结果。",
                    });
                    await plans.wait(job.id);
                    const done = plans.job(job.id);
                    jobs.push(done);
                    const version = plans
                      .get(plan.id)
                      .versions.find((v) => v.id === done.resultVersion);
                    if (version)
                      outputs.push({ conditions, content: version.content });
                    result.jobs = jobs;
                    result.artifact = outputs;
                    result.sources = plans
                      .get(plan.id)
                      .topic.sources.map((s) => ({
                        id: s.id,
                        text: s.excerpt,
                        locator: s.locator,
                      }));
                    await checkpoint();
                    if (done.status !== "completed" || !done.resultVersion)
                      throw new Error(done.error ?? done.status);
                    continuingPlan = plans.get(plan.id);
                    await writeFile(
                      join(
                        directory,
                        `${test.id}-${side}-${outputs.length}.md`,
                      ),
                      plans.exportMarkdown(plan.id, done.resultVersion),
                    );
                  }
                } else {
                  const manager = new TaskManager(counted),
                    conversations = new ConversationStore();
                  const decks = new DeckVersions(counted, paperById);
                  const assistant = new AssistantService(
                    counted,
                    manager,
                    conversations,
                    paperById,
                    undefined,
                    undefined,
                    undefined,
                    decks,
                  );
                  const chat = await conversations.create({
                    paperId: paper.id,
                  });
                  const turn = await assistant.submit(chat.id, {
                    clientMessageId: randomUUID(),
                    mode: "live",
                    module: test.kind,
                    question: test.question,
                    slideCount: 6,
                    speechScript: test.speechScript,
                  });
                  await assistant.wait(turn.id);
                  const done = assistant.turns.get(turn.id)!;
                  result.turn = done;
                  const run = [...manager.runs.values()].at(-1);
                  result.run = run;
                  result.artifact = run
                    ? {
                        unit:
                          run.result ??
                          (
                            [...run.roles]
                              .reverse()
                              .find(
                                (r) =>
                                  r.role === "revision" ||
                                  r.role === "teaching",
                              )?.output as { unit?: unknown } | undefined
                          )?.unit,
                        deck: run.deck,
                      }
                    : done.reply;
                  const visible = run?.materials?.at(-1)?.sources ?? [];
                  const packet = materialPacket(visible, test.question);
                  result.sources = packet.references.map((s) => ({
                    id: s.id,
                    text: packet.blocks.find((b) => b.hash === s.blockHash)!
                      .text,
                    locator: s.locator,
                  }));
                  await checkpoint();
                  if (done.status !== "completed" || !done.reply?.content)
                    throw new Error(done.error ?? done.status);
                  if (test.kind === "ppt") {
                    const version = [...decks.versions.values()].at(-1)!;
                    if (!version.outline.slides.some((s) => s.imageSource))
                      throw new Error("可用原图未进入实际 PPT");
                    if (test.speechScript && !version.outline.speechScript)
                      throw new Error("完整稿未生成");
                    const exported = await decks.export(version.id, chat.id);
                    result.exportPath = join(
                      directory,
                      `${test.id}-${side}.pptx`,
                    );
                    await copyFile(
                      resolve("exports", `${exported.id}.pptx`),
                      result.exportPath,
                    );
                    if (version.outline.speechScript)
                      await writeFile(
                        join(directory, `${test.id}-${side}-speech.md`),
                        version.outline.speechScript,
                      );
                  }
                }
              },
            );
            result.status = "generated";
          } catch (error) {
            result.status = "failed";
            result.error = String(error);
          }
          await checkpoint();
          if (batch.stopReason || controller.signal.aborted)
            throw new Error(batch.stopReason ?? "已取消");
          if (result.artifact && textValues(result.artifact).length) {
            counted.context = `${test.id}-${side}-independent-review`;
            result.evaluation = await reviewArtifact(
              counted,
              {
                question: test.question,
                conditions: test.conditions,
                criteria: iteration
                  ? explanationCriteria(test)
                  : artifactCriteria(test),
                evaluatorVersion: iteration ? "explanation-v1" : undefined,
                artifact: result.artifact,
                sources: result.sources ?? [],
              },
              controller.signal,
              result.run?.input.visibleImage,
            );
          }
          result.calls = batch.budget.attempts.length - before;
          result.providerMs = batch.budget.attempts
            .slice(before)
            .reduce((n, a) => n + a.durationMs, 0);
          result.endToEndMs = Date.now() - begin;
          await checkpoint();
          console.log(
            "end",
            test.id,
            side,
            result.status,
            result.evaluation?.passed ?? "not-evaluated",
            result.error ?? "",
          );
        }
        if (
          iteration &&
          test.split === "development" &&
          !report.results.some(
            (r) =>
              r.id === test.id &&
              r.side === "candidate" &&
              r.status === "generated" &&
              r.evaluation?.valid &&
              r.evaluation.passed,
          )
        ) {
          report.decision = "retain-baseline-development-failed";
          break;
        }
      }
      batch.status = "complete";
      report.decision =
        report.decision === "retain-baseline-development-failed"
          ? report.decision
          : stage === "m1" &&
              !report.results.some(
                (r) =>
                  r.id === "D1" &&
                  r.side === "candidate" &&
                  r.status === "generated" &&
                  r.evaluation?.valid &&
                  r.evaluation.passed,
              )
            ? "retain-baseline-development-failed"
            : "retain-baseline-pending-file-and-learning-validation";
    } catch (error) {
      batch.status = "stopped";
      batch.stopReason ??= String(error);
      report.stopReason = batch.stopReason;
      console.log("stopped", batch.stopReason);
    } finally {
      // Includes failed/unknown dispatches, even when a unit throws before completion.
      for (const result of report.results.filter((r) => !r.calls)) {
        const attempts = batch.budget.attempts.filter((a) =>
          a.role.startsWith(`${result.id}-${result.side}-`),
        );
        result.calls = attempts.length;
        result.providerMs = attempts.reduce((n, a) => n + a.durationMs, 0);
        if (result.startedAt && !result.endToEndMs)
          result.endToEndMs = Date.now() - Date.parse(result.startedAt);
      }
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      await checkpoint();
    }
  }
} finally {
  await lock.close();
  const { unlink } = await import("node:fs/promises");
  await unlink(join(directory, "runner.lock"));
  await globalLock.close();
  await unlink(join(runsRoot, "dispatch.lock"));
}
