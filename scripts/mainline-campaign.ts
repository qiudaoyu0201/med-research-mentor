// A frozen multi-case campaign for the real product services, not canned answers.
import { readFile, writeFile, mkdir, open, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Provider } from "../server/provider.ts";
import type { PaperBundle, TaskRun } from "../shared/types.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
import { inlineAuditSources } from "../evals/claim-audit.ts";
import { selectCrossEvidence } from "../server/cross-function-sources.ts";
import { commonFlowCandidate } from "../evals/common-flow-candidate.ts";
import { pptImagePacket } from "../server/ppt-image-packet.ts";

const specification = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  parentReport: z.string(),
  rules: z
    .enum([
      "live",
      "common-flow-candidate1",
      "common-flow-candidate2",
      "common-flow-candidate3",
    ])
    .default("live"),
  cases: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        paperPath: z.string(),
        reuseFrom: z.string().optional(),
        reuseModules: z
          .array(z.enum(["paper", "ppt"]))
          .default(["paper", "ppt"]),
        reuseProposal: z.boolean().default(false),
        proposalRevision: z.string().max(3000).optional(),
        readingSourceIds: z.array(z.string()).min(1).optional(),
        pptSourceIds: z.array(z.string()).min(1).optional(),
        readingQuestion: z.string(),
        slideCount: z.number().int().min(3).max(6),
        planQuestion: z.string(),
        conditions: z.string(),
        planSourceIds: z.array(z.string()).min(1).max(12),
        transferScenario: z.string(),
        transferCriteria: z.array(z.string()).min(3).max(6),
      }),
    )
    .min(1)
    .max(4),
});
const manifest = specification.parse(
  JSON.parse(await readFile(process.argv[2], "utf8")),
);
if (new Set(manifest.cases.map((s) => s.id)).size !== manifest.cases.length)
  throw Error("样本ID重复");
const directory = resolve("runs/internal-training", manifest.id);
process.env.TUTOR_DATA_DIR = join(directory, "data");
process.env.TUTOR_READING_GUIDES = "manual";
const { RecordStorage } = await import("../server/storage.ts");
const { createProvider } = await import("../server/model-config.ts");
const { TrainingProvider, reserveUnit, reviewArtifact } =
  await import("../server/internal-training.ts");
const { BudgetLedger } = await import("../server/budget.ts");
const { TaskManager, materialSources } =
  await import("../server/orchestrator.ts");
const { ResearchPlans } = await import("../server/research-plans.ts");
const { freezeRules, withRuleSnapshot, loadSkills } =
  await import("../server/skills.ts");
const { trainingAdmission } = await import("../server/training-admission.ts");
const { reviewCrossFunction, pendingProductValidation } =
  await import("../server/cross-function-review.ts");
const { mainlineDevelopmentAcceptance, strictDevelopmentAcceptance } =
  await import("../server/development-acceptance.ts");
const { exportDeck } = await import("../server/export.ts");
const { trainingEngine } = await import("../server/training-engine.ts");
const { foundationCatalog } = await import("../server/foundations.ts");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const parentRaw = await readFile(manifest.parentReport, "utf8");
const parent = JSON.parse(parentRaw);
if (
  !Number.isSafeInteger(parent.parentNewAttempts) ||
  parent.parentNewAttempts < 0 ||
  !["complete", "stopped"].includes(parent.batch?.status) ||
  parent.calls !== parent.batch.budget.attempts.length ||
  parent.batch.budget.attempts.some(
    (a: any) =>
      a.status !== "succeeded" &&
      !["failed", "interrupted"].includes(a.observation?.remoteTerminal),
  )
)
  throw Error("前批累计或远端终态不明确");
const cases = await Promise.all(
  manifest.cases.map(async (sample) => {
    const paper: PaperBundle = JSON.parse(
      await readFile(sample.paperPath, "utf8"),
    );
    if (
      !paper.sources.length ||
      [
        ...sample.planSourceIds,
        ...(sample.readingSourceIds ?? []),
        ...(sample.pptSourceIds ?? []),
      ].some((id) => !paper.sources.some((s) => s.id === id))
    )
      throw Error("样本来源绑定不完整");
    return { ...sample, paper };
  }),
);
await mkdir(directory, { recursive: true });
const store = new RecordStorage(join(directory, "records"));
const lockPath = resolve("runs/internal-training/dispatch.lock");
const lock = await open(lockPath, "wx");
try {
  const limit = cases.length * 19;
  const claim = await open(join(directory, "claim.json"), "wx");
  await claim.writeFile(
    JSON.stringify({
      limit,
      parentHash: digest(parentRaw),
      inheritedAttempts: parent.parentNewAttempts + parent.calls,
    }),
  );
  await claim.close();
  const admission = async () => {
    await trainingAdmission();
    await trainingAdmission("http://127.0.0.1:4319");
  };
  await admission();
  const provider = createProvider();
  if (
    provider.id !== parent.provider.id ||
    provider.model !== parent.provider.model ||
    JSON.stringify(provider.settings) !==
      JSON.stringify(parent.provider.settings)
  )
    throw Error("模型配置改变");
  const baseline = await freezeRules();
  const rules =
    manifest.rules !== "live"
      ? commonFlowCandidate(baseline, manifest.rules)
      : baseline;
  const batch: TrainingBatch = {
    id: manifest.id,
    phase: "M1",
    status: "running",
    cycleLimit: 19,
    budget: new BudgetLedger(
      manifest.id,
      async () => {},
      undefined,
      180 * 60_000,
    ).state,
  };
  batch.budget.limit = batch.budget.groupLimit = limit;
  const report: any = {
    status: "running",
    parentNewAttempts: parent.parentNewAttempts + parent.calls,
    parentHash: digest(parentRaw),
    inheritedUnknownUsage:
      "继承祖先全部unknown，线上费用另记；不重试历史请求。",
    provider: parent.provider,
    batch,
    rulesHash: digest(JSON.stringify(rules)),
    baselineRulesHash: digest(JSON.stringify(baseline)),
    ruleVariant: manifest.rules,
    results: [],
    scope:
      "冻结规则的多样本三功能开发诊断，包含真实产物、交叉核验及独立条件迁移；候选不自动上线，非留出集或真人效果。",
  };
  const persist = () => store.save("training", "report", report);
  await store.save("freeze", "manifest", manifest);
  await store.save("freeze", "rules", rules);
  await store.save("freeze", "baseline-rules", baseline);
  await store.save("freeze", "engine", await trainingEngine());
  await store.save("freeze", "foundations", foundationCatalog.all());
  await store.save("freeze", "implementation", {
    campaign: await readFile("scripts/mainline-campaign.ts", "utf8"),
    candidate: await readFile("evals/common-flow-candidate.ts", "utf8"),
    sourceSelection: await readFile("server/cross-function-sources.ts", "utf8"),
  });
  await store.save("freeze", "cases", cases);
  await persist();
  let cycleStart = 0;
  const counted = new TrainingProvider(
    provider,
    batch,
    persist,
    (id, input) => store.save("inputs", id, input),
    () => batch.budget.attempts.length - cycleStart,
  );
  const adapted: Provider = {
    id: counted.id,
    model: counted.model,
    billingMode: counted.billingMode,
    settings: counted.settings,
    capabilities: counted.capabilities,
    async generate(
      instructions,
      input,
      schema,
      signal,
      image,
      observe,
      control,
    ) {
      await admission();
      if (
        schema instanceof z.ZodObject &&
        "issues" in schema.shape &&
        input &&
        typeof input === "object" &&
        "draft" in input
      ) {
        input = inlineAuditSources(
          input as Parameters<typeof inlineAuditSources>[0],
        );
        instructions +=
          "\n来源原文在sources.references各条text中；blocks为空不是缺失。逐条核对当前来源。";
      }
      return counted.generate(
        instructions,
        input,
        schema,
        signal,
        image,
        observe,
        control,
      );
    },
  };
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const ensureCalls = () => {
    if (
      batch.budget.attempts
        .slice(cycleStart)
        .some((a) => a.status !== "succeeded")
    )
      throw Error("当前样本调用未全部成功，保留状态供诊断，不自动重试");
  };
  try {
    for (const sample of cases) {
      cycleStart = batch.budget.attempts.length;
      reserveUnit(batch, 19, 0);
      const result: any = { id: sample.id, stages: {}, status: "running" };
      report.results.push(result);
      const reused = sample.reuseFrom
        ? JSON.parse(
            await readFile(
              join(sample.reuseFrom, "records/training/report.json"),
              "utf8",
            ),
          )
        : undefined;
      const reusedResult = reused?.results.find((r: any) => r.id === sample.id);
      if (
        reused &&
        (reused.batch.status !== "complete" ||
          JSON.stringify(reused.provider) !== JSON.stringify(report.provider) ||
          !reusedResult ||
          (!sample.proposalRevision && !sample.reuseProposal))
      )
        throw new Error("复用来源的模型、规则、样本或修订目标不匹配");
      if (reused)
        await store.save("freeze", sample.id + "-reused-report", reused);
      const stage = async (name: string) => {
        counted.context = sample.id + ":" + name;
        report.currentStage = counted.context;
        await persist();
      };
      const manager = new TaskManager(
        adapted,
        (group, id, value) => store.save(group, id, value),
        "internal",
      );
      const product = async (module: "paper" | "ppt") => {
        await stage(module);
        if (reusedResult && sample.reuseModules.includes(module)) {
          const path = join(
            sample.reuseFrom!,
            "records/runs",
            reusedResult.stages[module].runId + ".json",
          );
          const run: TaskRun = JSON.parse(await readFile(path, "utf8"));
          const currentSkills = await withRuleSnapshot(rules, () =>
            loadSkills(module),
          );
          if (
            JSON.stringify(run.skillVersions) !==
              JSON.stringify({
                ...currentSkills.versions,
                "delivery-policy": "internal-v1",
              }) ||
            !mainlineDevelopmentAcceptance(run) ||
            run.input.module !== module ||
            run.input.paperId !== sample.paper.id ||
            run.sourceVersion !== sample.paper.version ||
            (module === "paper"
              ? run.input.question !== sample.readingQuestion
              : run.input.slideCount !== sample.slideCount)
          )
            throw new Error("旧产物未通过或输入版本改变，不能直接复用");
          result.stages[module] = {
            ...reusedResult.stages[module],
            reusedFrom: path,
          };
          await store.save("runs", run.id, run);
          await persist();
          return run;
        }
        const run = await withRuleSnapshot(rules, async () => {
          const run = await manager.start(
            {
              paperId: sample.paper.id,
              module,
              mode: "live",
              profileId: "beginner",
              question:
                module === "paper"
                  ? sample.readingQuestion
                  : `生成${sample.slideCount}页科研组会汇报，讲清背景、设计、关键证据、局限与可借鉴思路。按提供材料范围，保留重要数值和适用条件。页面简洁有重点，讲述提示独立放notes。`,
              sourceIds:
                (module === "paper"
                  ? sample.readingSourceIds
                  : sample.pptSourceIds) ??
                sample.paper.sources.map((s) => s.id),
              taughtConcepts: [],
              ...(module === "ppt" ? { slideCount: sample.slideCount } : {}),
              checks: { readability: true, reason: "多样本当前产品三角色闭环" },
            },
            sample.paper,
            undefined,
            undefined,
            { signal: controller.signal },
          );
          await manager.wait(run.id);
          return run;
        });
        result.stages[module] = {
          runId: run.id,
          status: run.status,
          mainlinePassed: mainlineDevelopmentAcceptance(run),
          strictPassed: strictDevelopmentAcceptance(run),
          error: run.error,
        };
        await persist();
        ensureCalls();
        return run;
      };
      const reading = await product("paper");
      const ppt = await product("ppt");
      if (result.stages.ppt.mainlinePassed && ppt.deck) {
        result.stages.ppt.path = await exportDeck(
          ppt.deck,
          { ...sample.paper, sources: materialSources(ppt, sample.paper) },
          manifest.id + "-" + sample.id,
        );
        await persist();
      }
      await stage("proposal");
      const plans = new ResearchPlans(
        adapted,
        async (id) => {
          if (id !== sample.paper.id) throw Error("来源不匹配");
          return structuredClone(sample.paper);
        },
        undefined,
        (group, id, value) => store.save(group, id, value),
      );
      const { plan, job } = await withRuleSnapshot(rules, async () => {
        let plan;
        if (reusedResult) {
          const previousPlan = JSON.parse(
            await readFile(
              join(
                sample.reuseFrom!,
                "records/research-plans",
                reusedResult.stages.proposal.planId + ".json",
              ),
              "utf8",
            ),
          );
          if (
            previousPlan.topic.question !== sample.planQuestion ||
            previousPlan.topic.conditions !== sample.conditions ||
            previousPlan.topic.sources.some(
              (s: any) =>
                s.paperId !== sample.paper.id ||
                s.sourceVersion !== sample.paper.version,
            )
          )
            throw new Error("方案条件变化，不能复用为同任务修订");
          await plans.restore([previousPlan], []);
          plan = plans.get(previousPlan.id);
          await store.save(
            "freeze",
            sample.id + "-previous-plan",
            previousPlan,
          );
          if (sample.reuseProposal) {
            const previousRules = JSON.parse(
              await readFile(
                join(sample.reuseFrom!, "records/freeze/rules.json"),
                "utf8",
              ),
            );
            if (
              previousRules.shared !== rules.shared ||
              previousRules.teachingContract !== rules.teachingContract
            )
              throw new Error("方案所用规则变化，不能直接复用");
            const previousJob = JSON.parse(
              await readFile(
                join(
                  sample.reuseFrom!,
                  "records/research-plan-jobs",
                  reusedResult.stages.proposal.jobId + ".json",
                ),
                "utf8",
              ),
            );
            if (
              previousJob.status !== "completed" ||
              previousJob.resultVersion !== plan.currentVersion
            )
              throw new Error("方案尚未完成核对，不能直接复用");
            await plans.restore([previousPlan], [previousJob]);
            await store.save("research-plans", plan.id, previousPlan);
            await store.save("research-plan-jobs", previousJob.id, previousJob);
            return { plan: plans.get(plan.id), job: plans.job(previousJob.id) };
          }
        } else
          plan = await plans.create({
            question: sample.planQuestion,
            conditions: sample.conditions,
            sources: sample.planSourceIds.map((id) => ({
              paperId: sample.paper.id,
              sourceVersion: sample.paper.version,
              sourceId: id,
            })),
          });
        const job = await plans.start(
          plan.id,
          {
            requestKey: manifest.id + "-" + sample.id,
            expectedVersion: plan.currentVersion,
            expectedTopicVersion: plan.topic.version,
            action: reusedResult ? "revise" : "generate",
            instruction: sample.proposalRevision ?? "",
            requestedScope: "full-plan",
            maxCalls: 4,
            retrieveLiterature: false,
          },
          { signal: controller.signal },
        );
        await plans.wait(job.id);
        return { plan: plans.get(plan.id), job: plans.job(job.id) };
      });
      result.stages.proposal = {
        planId: plan.id,
        jobId: job.id,
        status: job.status,
        error: job.error,
        ...(sample.reuseProposal ? { reusedFrom: sample.reuseFrom } : {}),
      };
      await persist();
      ensureCalls();
      const version = plan.versions.find((v) => v.id === plan.currentVersion);
      if (job.status === "completed" && version) {
        await writeFile(
          join(directory, sample.id + ".docx"),
          plans.exportDocx(plan.id, version.id),
        );
        await writeFile(
          join(directory, sample.id + ".md"),
          plans.exportMarkdown(plan.id, version.id),
        );
      }
      if (
        !result.stages.paper.mainlinePassed ||
        !result.stages.ppt.mainlinePassed ||
        job.status !== "completed" ||
        !version
      ) {
        result.status = "needs-improvement";
        result.reason = "产物缺口保留；不以失败草稿替代合格教学曝光。";
      } else {
        await stage("cross-review");
        const selectedSources = selectCrossEvidence(
          [{ unit: reading.result }, { unit: ppt.result, deck: ppt.deck }],
          [
            ...materialSources(reading, sample.paper),
            ...materialSources(ppt, sample.paper),
            ...sample.paper.sources.filter((s) =>
              plan.topic.sources.some(
                (ref) =>
                  ref.paperId === sample.paper.id &&
                  ref.sourceVersion === sample.paper.version &&
                  ref.sourceId === s.id,
              ),
            ),
          ],
          plan.topic.sources.map((s) => ({
            id: s.id,
            text: s.excerpt,
            locator: s.locator,
            sourceId: s.sourceId,
          })),
        );
        const crossInput = {
          artifacts: {
            reading: { unit: reading.result, deck: null },
            ppt: { unit: ppt.result, deck: ppt.deck },
            proposal: {
              content: version.content,
              conditions: sample.conditions,
            },
          },
          sources: selectedSources,
        };
        const cross = await reviewCrossFunction(
          adapted,
          crossInput,
          controller.signal,
        );
        result.cross = cross;
        result.pendingProducts = pendingProductValidation(crossInput, [cross]);
        await store.save("artifacts", sample.id + "-cross", {
          input: crossInput,
          review: cross,
        });
        await persist();
        ensureCalls();
        if (result.pendingProducts.length) result.status = "needs-improvement";
        else {
          await stage("novice-transfer");
          result.learner = (
            await adapted.generate(
              "你是医学科研新手，仅根据可见教学产物回答新情境，保留人群、时间、设备和数据条件。不会的说明，不假装专家或新增资源。简短说明可以借鉴的思路及哪些不能照搬，只返回JSON。",
              {
                teaching: crossInput.artifacts,
                scenario: sample.transferScenario,
              },
              z.object({ answer: z.string().min(1).max(6000) }),
              controller.signal,
            )
          ).output;
          await persist();
          await stage("transfer-review");
          result.transfer = await reviewArtifact(
            adapted,
            {
              question: sample.transferScenario,
              conditions:
                "只评价必要理解与设计条件，不要求专家级细节。location引用一个连续原句，不能拼接不同句子。",
              criteria: sample.transferCriteria,
              artifact: result.learner,
              sources: crossInput.sources.map(({ image, ...source }) => source),
            },
            controller.signal,
            await pptImagePacket(
              crossInput.sources.map((s) => ({
                ...s,
                title: s.id,
                kind: "paper",
                verified: true,
              })),
            ),
          );
          result.status = result.transfer.passed
            ? "diagnostic-passed"
            : "needs-improvement";
        }
      }
      result.calls = batch.budget.attempts.length - cycleStart;
      await persist();
      console.log(
        JSON.stringify({
          id: sample.id,
          status: result.status,
          calls: result.calls,
          stages: result.stages,
        }),
      );
      ensureCalls();
    }
    report.status = report.results.every(
      (r: any) => r.status === "diagnostic-passed",
    )
      ? "diagnostic-passed"
      : "needs-improvement";
    batch.status = "complete";
  } catch (error) {
    report.status = "stopped";
    report.error = String(error);
    batch.status = "stopped";
    const current = report.results.at(-1);
    if (current?.status === "running") {
      current.status = "stopped";
      current.calls = batch.budget.attempts.length - cycleStart;
    }
  } finally {
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
