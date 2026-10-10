// A traceable editorial correction followed by independent review; not a Skill release.
import { readFile, writeFile, mkdir, open, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { TrainingBatch } from "../server/internal-training.ts";
const pageEvidence = process.argv[2] === "page-evidence";
const population = process.argv[2] === "population";
if (process.argv[2] && !pageEvidence && !population)
  throw Error("未知修订模式");
const id = population
  ? "campaign-scope-repair-20261010-v3"
  : pageEvidence
    ? "campaign-scope-repair-20261010-v2"
    : "campaign-scope-repair-20261010-v1";
const directory = resolve("runs/internal-training", id);
process.env.TUTOR_DATA_DIR = join(directory, "data");
const { RecordStorage } = await import("../server/storage.ts");
const { createProvider } = await import("../server/model-config.ts");
const { TrainingProvider, reviewArtifact } =
  await import("../server/internal-training.ts");
const { BudgetLedger } = await import("../server/budget.ts");
const { trainingAdmission } = await import("../server/training-admission.ts");
const { reviewCrossFunction, pendingProductValidation } =
  await import("../server/cross-function-review.ts");
const { pptImagePacket } = await import("../server/ppt-image-packet.ts");
const parentDirectory = resolve(
  population
    ? "runs/internal-training/campaign-scope-repair-20261010-v2/records"
    : pageEvidence
      ? "runs/internal-training/campaign-scope-repair-20261010-v1/records"
      : "runs/internal-training/mainline-campaign-20261010-cross-images-v2/records",
);
const parentRaw = await readFile(
  join(parentDirectory, "training/report.json"),
  "utf8",
);
const parent = JSON.parse(parentRaw);
if (
  parent.batch.status !== "complete" ||
  parent.calls !== parent.batch.budget.attempts.length ||
  parent.batch.budget.attempts.some((a: any) => a.status !== "succeeded")
)
  throw Error("前批未正常结束");
const artifactRaw = await readFile(
  join(
    parentDirectory,
    pageEvidence || population
      ? "freeze/after.json"
      : "artifacts/senescence-first-experiment-cross.json",
  ),
  "utf8",
);
const input =
  pageEvidence || population
    ? JSON.parse(artifactRaw)
    : JSON.parse(artifactRaw).input;
const changes = population
  ? [
      { before: "6月龄年轻小鼠", after: "6月龄年轻雄性C57BL/6小鼠", count: 0 },
      {
        before: "也不能直接外推为人体结论",
        after: "也不能直接推广至雌性、其他品系或人体",
        count: 0,
      },
    ]
  : pageEvidence
    ? [
        {
          before: "1个月后检测步速、握力、耐力、活动、进食与体重",
          after: "1个月后测功能；各组n=6，均值±SEM；ANOVA＋Tukey",
          count: 0,
        },
        {
          before: "100万衰老细胞：最大步速、悬挂耐力和握力下降",
          after: "相对100万对照细胞，100万衰老组步速、悬挂耐力和握力下降",
          count: 0,
        },
        {
          before: "50万衰老细胞：握力下降；补充结果报告最大步速下降",
          after: "50万组握力下降；正文称补充图步速下降，该补充图本轮未提供",
          count: 0,
        },
      ]
    : [
        {
          before: "当前材料未覆盖清除衰老细胞后的功能或寿命结果",
          after:
            "本次汇报不展开后续清除实验；摘要已报告功能及生存获益，完整细节另读后续章节",
          count: 0,
        },
        {
          before:
            "所给材料仅覆盖论文前3页的部分文本，未提供后续干预、寿命结果和完整方法。",
          after:
            "本次重点为前3页的移植实验；摘要已概述后续干预与寿命结果，其完整方法和结果细节不在本轮展开。",
          count: 0,
        },
      ];
function revise(value: any): any {
  if (typeof value === "string") {
    for (const change of changes) {
      change.count += value.split(change.before).length - 1;
      value = value.replaceAll(change.before, change.after);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(revise);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, revise(item)]),
    );
  return value;
}
if (population) input.artifacts.reading = revise(input.artifacts.reading);
else input.artifacts.ppt = revise(input.artifacts.ppt);
if (changes.some((c) => !c.count)) throw Error("待修订原句不匹配，未猜测修改");
const sample = JSON.parse(
  await readFile("evals/campaign-mainlines-focused-20261010.json", "utf8"),
).cases[0];
await mkdir(directory, { recursive: true });
const lockPath = resolve("runs/internal-training/dispatch.lock"),
  lock = await open(lockPath, "wx");
try {
  const claim = await open(join(directory, "claim.json"), "wx");
  await claim.writeFile(
    JSON.stringify({
      limit: 3,
      parentHash: createHash("sha256").update(parentRaw).digest("hex"),
    }),
  );
  await claim.close();
  const provider = createProvider();
  if (
    provider.id !== parent.provider.id ||
    provider.model !== parent.provider.model ||
    JSON.stringify(provider.settings) !==
      JSON.stringify(parent.provider.settings)
  )
    throw Error("模型配置改变");
  const store = new RecordStorage(join(directory, "records"));
  const batch: TrainingBatch = {
    id,
    phase: "M1",
    status: "running",
    cycleLimit: 3,
    budget: new BudgetLedger(id, async () => {}, undefined, 30 * 60_000).state,
  };
  batch.budget.limit = batch.budget.groupLimit = 3;
  const report: any = {
    status: "running",
    parentNewAttempts: parent.parentNewAttempts + parent.calls,
    provider: parent.provider,
    inheritedUnknownUsage: parent.inheritedUnknownUsage,
    batch,
    changes,
    scope:
      "按changes记录编辑已有产物，独立复核；不改历史评价，不冒称导师自动修复或Skill泛化成功。",
  };
  const persist = () => store.save("training", "report", report);
  await store.save("freeze", "before", JSON.parse(artifactRaw));
  await store.save("freeze", "after", input);
  await store.save(
    "freeze",
    "implementation",
    await readFile("scripts/campaign-scope-repair.ts", "utf8"),
  );
  await persist();
  const counted = new TrainingProvider(
    provider,
    batch,
    persist,
    (key, value) => store.save("inputs", key, value),
    () => batch.budget.attempts.length,
  );
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const stage = async (name: string) => {
    await trainingAdmission();
    await trainingAdmission("http://127.0.0.1:4319");
    counted.context = report.currentStage = name;
    await persist();
  };
  try {
    await stage("cross-review");
    report.cross = await reviewCrossFunction(counted, input, controller.signal);
    report.pendingProducts = pendingProductValidation(input, [report.cross]);
    await persist();
    if (!report.pendingProducts.length) {
      const { exportDeck } = await import("../server/export.ts");
      const { materialSources } = await import("../server/orchestrator.ts");
      const paper = JSON.parse(await readFile(sample.paperPath, "utf8"));
      const run = JSON.parse(
        await readFile(
          "runs/internal-training/mainline-campaign-20261010-figure-comparators-v2/records/runs/ae2a7223-1d05-468d-9f53-f3c12179d03b.json",
          "utf8",
        ),
      );
      report.ppt = await exportDeck(
        input.artifacts.ppt.deck,
        { ...paper, sources: materialSources(run, paper) },
        id,
      );
      await stage("novice-transfer");
      report.learner = (
        await counted.generate(
          "你是医学科研新手，只根据可见教学产物回答新情境。保留条件，说明可借鉴和不能照搬的思路，不虚构资源；只返回JSON。",
          { teaching: input.artifacts, scenario: sample.transferScenario },
          z.object({ answer: z.string().min(1).max(6000) }),
          controller.signal,
        )
      ).output;
      await persist();
      await stage("transfer-review");
      report.transfer = await reviewArtifact(
        counted,
        {
          question: sample.transferScenario,
          conditions:
            "检查必要理解和条件迁移；location逐字引用一条连续原句，不拼接。",
          criteria: sample.transferCriteria,
          artifact: report.learner,
          sources: input.sources.map(({ image, ...s }: any) => s),
        },
        controller.signal,
        await pptImagePacket(
          input.sources.map((s: any) => ({
            ...s,
            title: s.id,
            kind: "paper",
            verified: true,
          })),
        ),
      );
    }
    report.status =
      !report.pendingProducts.length && report.transfer?.passed
        ? "diagnostic-passed"
        : "needs-improvement";
    batch.status = "complete";
  } catch (error) {
    report.status = batch.status = "stopped";
    report.error = String(error);
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
