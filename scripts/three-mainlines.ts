// Real reading -> PPT / proposal products, cross-review, then a changed-condition learner probe.
import { readFile, writeFile, mkdir, open, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { TrainingBatch } from "../server/internal-training.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { Provider } from "../server/provider.ts";
import { inlineAuditSources } from "../evals/claim-audit.ts";

const id = "three-mainlines-20261010-v1";
const directory = resolve("runs/internal-training", id);
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
const { withRuleSnapshot } = await import("../server/skills.ts");
const { trainingAdmission } = await import("../server/training-admission.ts");
const { reviewCrossFunction, pendingProductValidation } =
  await import("../server/cross-function-review.ts");
const { mainlineDevelopmentAcceptance } =
  await import("../server/development-acceptance.ts");
const { exportDeck } = await import("../server/export.ts");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const parentRaw = await readFile(
  "runs/internal-training/diverse-samples-20261010-v1/records/training/report.json",
  "utf8",
);
const parent = JSON.parse(parentRaw);
const parentAttempts = parent.batch.budget.attempts;
if (
  !["complete", "stopped"].includes(parent.batch.status) ||
  parent.results.length !== 4 ||
  parent.calls !== parentAttempts.length ||
  parentAttempts.some(
    (a: any) =>
      a.status !== "succeeded" &&
      !["failed", "interrupted"].includes(a.observation?.remoteTerminal),
  )
)
  throw Error("多样本前批未结束");
const lessonDir =
  "runs/internal-training/role-closure-20261009-clinical-small-v7/records";
const lessonReport = JSON.parse(
  await readFile(join(lessonDir, "training/report.json"), "utf8"),
);
if (!lessonReport.mainlinePassed) throw Error("带读前序不合格");
const reading = JSON.parse(
  await readFile(join(lessonDir, "runs", lessonReport.runId + ".json"), "utf8"),
);
const paper: PaperBundle = JSON.parse(
  await readFile(join(lessonDir, "freeze/paper.json"), "utf8"),
);
const rules = JSON.parse(
  await readFile(join(lessonDir, "freeze/rules.json"), "utf8"),
);
const conditions =
  "拟研究65岁以上住院患者入院睡眠问题与出院后6个月新发衰弱。可做入院问卷、查病历、一次6个月电话随访；没有干预安排，没有预实验或样本量参数，伦理尚待申请。请给能与导师讨论的完整草案，不是已完成研究。";
const transferScenario =
  "换一个科室：仅有50至64岁门诊患者的既往病历，只有首次就诊的睡眠记录和当日衰弱评估，没有后续随访，也不能重新联系患者。老师问能否据此预测6个月新发衰弱，或者证明治疗睡眠会减少衰弱。请根据刚看到的带读、PPT和方案，说明哪些思路能借鉴、哪些条件已改变、现在能回答什么问题。不要编造新增资源。";
await mkdir(directory, { recursive: true });
const store = new RecordStorage(join(directory, "records"));
const lockPath = resolve("runs/internal-training/dispatch.lock");
const lock = await open(lockPath, "wx");
try {
  const inherited = parent.parentNewAttempts + parent.calls;
  const claim = await open(join(directory, "claim.json"), "wx");
  await claim.writeFile(
    JSON.stringify({
      limit: 13,
      inheritedAttempts: inherited,
      parentHash: digest(parentRaw),
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
  const batch: TrainingBatch = {
    id,
    phase: "M1",
    status: "running",
    cycleLimit: 13,
    budget: new BudgetLedger(id, async () => {}, undefined, 55 * 60_000).state,
  };
  batch.budget.limit = batch.budget.groupLimit = 13;
  const report: any = {
    status: "running",
    parentNewAttempts: inherited,
    parentHash: digest(parentRaw),
    inheritedUnknownUsage: "保留全部历史unknown，产品失败不改写为成功。",
    parentUncertain: parentAttempts
      .filter((a: any) => a.status !== "succeeded")
      .map((a: any) => ({
        id: a.id,
        status: a.status,
        terminal: a.observation?.remoteTerminal,
      })),
    batch,
    provider: parent.provider,
    scope:
      "复用已通过带读；实际PPT/方案生成核对；三功能交叉复核及改变条件的学习者迁移；非真人效果证明。",
  };
  const persist = () => store.save("training", "report", report);
  await store.save("freeze", "inputs", {
    paper,
    reading: reading.result,
    rules,
    conditions,
    transferScenario,
  });
  await persist();
  const counted = new TrainingProvider(
    provider,
    batch,
    persist,
    (key, value) => store.save("inputs", key, value),
    () => batch.budget.attempts.length,
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
          "\n来源原文在sources.references各条text中，blocks为空不代表缺失。";
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
  try {
    reserveUnit(batch, 13, 0);
    counted.context = "ppt-three-role-loop";
    const manager = new TaskManager(
      adapted,
      (group, key, value) => store.save(group, key, value),
      "internal",
    );
    const ppt = await withRuleSnapshot(rules, async () => {
      const run = await manager.start(
        {
          paperId: paper.id,
          module: "ppt",
          mode: "live",
          profileId: "beginner",
          question:
            "给已读过本文的人生成4页简洁组会PPT：背景问题、测量与设计、结果、局限及研究启发。当前只有摘要，无原始图表，不造图。页面保留核心证据和数字的含义，讲述提示独立放notes，不要完整讲稿。延续带读的关联与因果区分。",
          sourceIds: paper.sources.map((s) => s.id),
          taughtConcepts: [],
          slideCount: 4,
          checks: { readability: true, reason: "三功能产品交叉闭环" },
        },
        paper,
        undefined,
        undefined,
        { signal: controller.signal },
      );
      await manager.wait(run.id);
      return run;
    });
    report.ppt = {
      runId: ppt.id,
      status: ppt.status,
      mainlinePassed: mainlineDevelopmentAcceptance(ppt),
      error: ppt.error,
    };
    await persist();
    if (!report.ppt.mainlinePassed || !ppt.deck)
      throw Error("PPT存在待解决问题，保留稿件不冒充合格交叉输入");
    report.ppt.path = await exportDeck(
      ppt.deck,
      { ...paper, sources: materialSources(ppt, paper) },
      id,
    );
    await persist();
    counted.context = "proposal-generate-review";
    reserveUnit(batch, 4, batch.budget.attempts.length);
    const plans = new ResearchPlans(
      adapted,
      async (key) => {
        if (key !== paper.id) throw Error("来源论文不匹配");
        return structuredClone(paper);
      },
      undefined,
      (group, key, value) => store.save(group, key, value),
    );
    const { plan, job } = await withRuleSnapshot(rules, async () => {
      const plan = await plans.create({
        question: "住院老年患者睡眠问题与出院后新发衰弱的关联研究",
        conditions,
        studyTypes: ["clinical-observational"],
        typeStatus: "confirmed",
        sources: paper.sources.map((s) => ({
          paperId: paper.id,
          sourceVersion: paper.version,
          sourceId: s.id,
        })),
      });
      const job = await plans.start(
        plan.id,
        {
          requestKey: id,
          expectedVersion: null,
          expectedTopicVersion: plan.topic.version,
          action: "generate",
          requestedScope: "full-plan",
          maxCalls: 4,
          retrieveLiterature: false,
        },
        { signal: controller.signal },
      );
      await plans.wait(job.id);
      return { plan: plans.get(plan.id), job: plans.job(job.id) };
    });
    report.proposal = {
      planId: plan.id,
      jobId: job.id,
      status: job.status,
      error: job.error,
    };
    await persist();
    if (job.status !== "completed" || !plan.currentVersion)
      throw Error("研究方案存在待解决问题");
    await writeFile(
      join(directory, "proposal.docx"),
      plans.exportDocx(plan.id, plan.currentVersion),
    );
    await writeFile(
      join(directory, "proposal.md"),
      plans.exportMarkdown(plan.id, plan.currentVersion),
    );
    const version = plan.versions.find((v) => v.id === plan.currentVersion)!;
    const crossInput = {
      artifacts: {
        reading: { unit: reading.result, deck: null },
        ppt: { unit: ppt.result, deck: ppt.deck },
        proposal: { content: version.content, conditions },
      },
      sources: [
        ...materialSources(ppt, paper).map(({ id, text, locator, image }) => ({
          id,
          text,
          locator,
          ...(image ? { image } : {}),
        })),
        ...plan.topic.sources.map((s) => ({
          id: s.id,
          text: s.excerpt,
          locator: s.locator,
        })),
      ],
    };
    counted.context = "three-products-cross-review";
    const cross = await reviewCrossFunction(
      adapted,
      crossInput,
      controller.signal,
    );
    report.cross = cross;
    report.pendingProducts = pendingProductValidation(crossInput, [cross]);
    await store.save("artifacts", "cross", {
      input: crossInput,
      review: cross,
    });
    await persist();
    if (report.pendingProducts.length)
      throw Error("三功能交叉复核未通过，先保留具体缺口，不向学习者曝光");
    counted.context = "novice-changed-conditions";
    report.learner = (
      await adapted.generate(
        "模拟医学科研新手，仅根据提供的教学产物尝试回答新情境。保留给定人群、资源和时间条件，不凭先验专家知识补出新资源；不会的说明。给出简短有理由的回答，不声称掌握。只返回JSON。",
        { teaching: crossInput.artifacts, scenario: transferScenario },
        z.object({ answer: z.string().min(1).max(6000) }),
        controller.signal,
      )
    ).output;
    await persist();
    counted.context = "transfer-independent-review";
    report.transfer = await reviewArtifact(
      adapted,
      {
        question: transferScenario,
        conditions:
          "评价科研新手能否保留改变的条件，不要求专家级统计方案；location仅用回答中一个连续原句，不拼接相隔句子。",
        criteria: [
          "保留50至64岁门诊和既往记录条件，不照搬老年住院或社区样本",
          "没有随访结局时不声称可验证6个月新发衰弱预测",
          "不能联系患者时不暗增随访或干预资源",
          "区分同日关联、预测与治疗因果，并解释主要理由",
          "原文OR与样本量不成为新数据，提出当前资料可研究的问题",
        ],
        artifact: report.learner,
        sources: crossInput.sources,
      },
      controller.signal,
    );
    report.status = report.transfer.passed
      ? "diagnostic-passed"
      : "needs-improvement";
    batch.status = "complete";
  } catch (error) {
    report.status = "stopped";
    report.error = String(error);
    batch.status = "stopped";
  } finally {
    report.calls = batch.budget.attempts.length;
    await persist();
    console.log(
      JSON.stringify({
        status: report.status,
        calls: report.calls,
        ppt: report.ppt,
        proposal: report.proposal,
        pending: report.pendingProducts,
        error: report.error,
      }),
    );
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
