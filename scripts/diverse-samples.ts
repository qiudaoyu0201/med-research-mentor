// Bounded real three-role samples. Frozen inputs, no retries or rule promotion.
import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Provider } from "../server/provider.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
import {
  inlineAuditSources,
  sharedCitationInstructions,
} from "../evals/claim-audit.ts";
import {
  noviceCoordination,
  groundingCoordination,
  groundingCoverage,
  feedbackAttribution,
} from "../evals/role-coordination-candidate.ts";

const id = "diverse-samples-20261010-v1";
const directory = resolve("runs/internal-training", id);
process.env.TUTOR_DATA_DIR = join(directory, "data");
process.env.TUTOR_READING_GUIDES = "manual";
const { RecordStorage } = await import("../server/storage.ts");
const { createProvider } = await import("../server/model-config.ts");
const { TrainingProvider, reserveUnit } =
  await import("../server/internal-training.ts");
const { BudgetLedger } = await import("../server/budget.ts");
const { TaskManager } = await import("../server/orchestrator.ts");
const { freezeRules, withRuleSnapshot } = await import("../server/skills.ts");
const { trainingAdmission } = await import("../server/training-admission.ts");
const { strictDevelopmentAcceptance, mainlineDevelopmentAcceptance } =
  await import("../server/development-acceptance.ts");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const parentRaw = await readFile(
  "runs/internal-training/clinical-transfer-20261010-v1/records/training/report.json",
  "utf8",
);
const parent = JSON.parse(parentRaw);
if (
  parent.batch.status !== "complete" ||
  parent.calls !== 2 ||
  parent.parentNewAttempts !== 71 ||
  parent.batch.budget.attempts.some((a: any) => a.status !== "succeeded")
)
  throw Error("前批未明确结束");
const pool = JSON.parse(
  await readFile(
    "runs/internal-training/literature-pool-20261010/report.json",
    "utf8",
  ),
);
const cases: { id: string; paper: PaperBundle; question: string }[] = [];
for (const [pmid, focus] of [
  [
    "40680335",
    "系统综述如何合并观察性研究，OR与患病比例分别表示什么，不能据此开出睡眠干预结论",
  ],
  [
    "36221059",
    "横断面机器学习分类与未来风险预测的区别，AUC不是准确率；两套衰弱标准的结果不要混淆",
  ],
  ["40107121", "研究设计、测量与比较、结果能说明什么，以及不能说明什么"],
]) {
  const source = pool.selected.find((s: any) => s.id === "pmid-" + pmid);
  if (source?.bibliography?.level !== "abstract" || !source.excerpt)
    throw Error("摘要来源缺失");
  cases.push({
    id: source.id,
    paper: {
      id: source.id,
      title: source.title,
      version: digest(source.excerpt),
      scope: "已检索PubMed摘要；非全文，不补造未提供的图表或参数。",
      sources: [
        {
          id: source.id,
          title: source.title,
          text: source.excerpt,
          kind: "paper",
          locator: source.locator,
          url: source.url,
          verified: false,
        },
      ],
    },
    question: `我是医学科研新手，请分两三个有条理的短段带读这篇摘要，解释关键中英文术语和推理链。重点：${focus}。缺少的全文细节简要说明即可，不要求额外完成专家级审稿。`,
  });
}
const figurePaper: PaperBundle = JSON.parse(
  await readFile(
    "data/papers/494f12de-ceee-402d-a282-9d5fd0a7d6f7.json",
    "utf8",
  ),
);
figurePaper.sources = figurePaper.sources.filter(
  (s) => s.id.endsWith("-p6") || s.figure === "4",
);
figurePaper.version += "-figure4-excerpt";
figurePaper.scope = "原论文PDF第6页和Figure4原图/图注片段；不是整篇完整材料。";
cases.push({
  id: "xu-figure4-foundations",
  paper: figurePaper,
  question:
    "请带医学科研新手读Figure4：先解释TAF、p16INK4A和SA-β-gal各测什么，再联系组别比较和可支持的结论。说明多个指标的作用，不要只列缩写，也不要讲成绝对证明。原论文细节只根据提供的页和图注，基础概念可通过基础资料补充。",
});
const store = new RecordStorage(join(directory, "records"));
await mkdir(directory, { recursive: true });
const lockPath = resolve("runs/internal-training/dispatch.lock");
const lock = await open(lockPath, "wx");
try {
  const claim = await open(join(directory, "claim.json"), "wx");
  await claim.writeFile(
    JSON.stringify({
      limit: cases.length * 6,
      inheritedAttempts: 73,
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
  const rules = await freezeRules();
  for (const [key, addition] of [
    ["medical-novice-simulator", noviceCoordination],
    [
      "medical-grounding-check",
      groundingCoordination +
        groundingCoverage +
        sharedCitationInstructions +
        feedbackAttribution,
    ],
  ]) {
    const entry = rules.entries[key];
    entry.text += "\n" + addition;
    entry.version += "-diverse-samples-v1";
    entry.hash = digest(entry.text);
  }
  const batch: TrainingBatch = {
    id,
    phase: "M1",
    status: "running",
    cycleLimit: 6,
    budget: new BudgetLedger(id, async () => {}, undefined, 90 * 60_000).state,
  };
  batch.budget.limit = batch.budget.groupLimit = cases.length * 6;
  const report: any = {
    status: "running",
    parentNewAttempts: 73,
    parentHash: digest(parentRaw),
    inheritedUnknownUsage: "继承祖先全部unknown；不将失败格式核验改为通过。",
    batch,
    provider: parent.provider,
    scope:
      "三种新临床摘要与原论文图4小样本；开发诊断，不是留出评估或真人学习证明。",
    results: [],
  };
  const persist = () => store.save("training", "report", report);
  await store.save("freeze", "rules", rules);
  await store.save("freeze", "cases", cases);
  await persist();
  let cycleStart = 0;
  const counted = new TrainingProvider(
    provider,
    batch,
    persist,
    (key, value) => store.save("inputs", key, value),
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
      counted.context = `${cases[report.results.length].id}:role-${batch.budget.attempts.length - cycleStart + 1}`;
      if (schema instanceof z.ZodObject && "issues" in schema.shape) {
        input = inlineAuditSources(
          input as Parameters<typeof inlineAuditSources>[0],
        );
        instructions +=
          "\n来源原文在sources.references各条text中；blocks为空不是缺失，不互换相邻来源。";
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
  const manager = new TaskManager(
    adapted,
    (group, key, value) => store.save(group, key, value),
    "internal",
  );
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    for (const sample of cases) {
      cycleStart = batch.budget.attempts.length;
      reserveUnit(batch, 6, 0);
      const run = await withRuleSnapshot(rules, async () => {
        const run = await manager.start(
          {
            paperId: sample.paper.id,
            module: "paper",
            mode: "live",
            profileId: "beginner",
            question: sample.question,
            sourceIds: sample.paper.sources.map((s) => s.id),
            taughtConcepts: [],
            checks: { readability: true, reason: "多样本三Agent闭环" },
          },
          sample.paper,
          undefined,
          undefined,
          { signal: controller.signal },
        );
        await manager.wait(run.id);
        return run;
      });
      const result = {
        id: sample.id,
        runId: run.id,
        runStatus: run.status,
        calls: batch.budget.attempts.length - cycleStart,
        strictPassed: strictDevelopmentAcceptance(run),
        mainlinePassed: mainlineDevelopmentAcceptance(run),
        error: run.error,
      };
      report.results.push(result);
      await persist();
      console.log(JSON.stringify(result));
      if (
        batch.budget.attempts
          .slice(cycleStart)
          .some((a) => a.status !== "succeeded")
      )
        throw Error("本样本存在失败或未知调用，停止后续派发");
    }
    report.status = report.results.every((r: any) => r.strictPassed)
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
        error: report.error,
      }),
    );
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
