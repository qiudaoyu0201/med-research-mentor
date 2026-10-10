// A two-call transfer probe; the learner receives the lesson, never the answer key.
import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { TrainingBatch } from "../server/internal-training.ts";

const id = "clinical-transfer-20261010-v1";
const directory = resolve("runs/internal-training", id);
process.env.TUTOR_DATA_DIR = join(directory, "data");
const { RecordStorage } = await import("../server/storage.ts");
const { createProvider } = await import("../server/model-config.ts");
const { TrainingProvider, reserveUnit } =
  await import("../server/internal-training.ts");
const { BudgetLedger } = await import("../server/budget.ts");
const { trainingAdmission } = await import("../server/training-admission.ts");
const parentDir =
  "runs/internal-training/role-closure-20261009-clinical-small-v7/records";
const raw = await readFile(join(parentDir, "training/report.json"), "utf8");
const parent = JSON.parse(raw);
if (
  parent.status !== "diagnostic-passed" ||
  parent.calls !== 3 ||
  parent.parentNewAttempts !== 68 ||
  parent.batch.budget.attempts.some((a: any) => a.status !== "succeeded")
)
  throw Error("前批未通过或未结束");
const run = JSON.parse(
  await readFile(join(parentDir, "runs", parent.runId + ".json"), "utf8"),
);
const paper = JSON.parse(
  await readFile(join(parentDir, "freeze/paper.json"), "utf8"),
);
const scenario =
  "老师希望研究65岁以上住院患者的睡眠问题与出院后6个月新发生的衰弱。科室能在入院时做问卷、读取病历，并进行一次6个月电话随访；没有干预安排，也没有预实验数据。请根据刚学的论文给出简短设计思路，说明哪些能借鉴、哪些不能直接套用、还有什么必须确认。";
const criteria = [
  "保留65岁以上住院对象与6个月随访条件，不照搬社区横断面结论",
  "新发生衰弱须考虑基线衰弱状态与随访结局，不能只做同期相关",
  "不把原研究OR或454样本直接当新研究结果或样本量",
  "观察性关联不等同干预因果，提出实际混杂与随访缺失问题",
  "量表和电话随访可行性须核实，不编造验证状态或详细参数",
];
const answerSchema = z.object({ answer: z.string().min(1).max(6000) });
const reviewSchema = z.object({
  checks: z
    .array(
      z.object({
        criterion: z.enum(criteria as [string, ...string[]]),
        passed: z.boolean(),
        quote: z.string().max(900),
        reason: z.string().max(900),
      }),
    )
    .length(criteria.length),
  majorErrors: z.array(z.string()).max(8),
});
const store = new RecordStorage(join(directory, "records"));
await mkdir(directory, { recursive: true });
const lockPath = resolve("runs/internal-training/dispatch.lock");
const lock = await open(lockPath, "wx");
try {
  const inherited = parent.parentNewAttempts + parent.calls;
  const parentHash = createHash("sha256").update(raw).digest("hex");
  const claim = await open(join(directory, "claim.json"), "wx");
  await claim.writeFile(
    JSON.stringify({ limit: 2, inheritedAttempts: inherited, parentHash }),
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
    phase: "calibration",
    status: "running",
    cycleLimit: 2,
    budget: new BudgetLedger(id, async () => {}, undefined, 15 * 60_000).state,
  };
  batch.budget.limit = batch.budget.groupLimit = 2;
  const report: any = {
    status: "running",
    parentNewAttempts: inherited,
    parentHash,
    inheritedUnknownUsage: "继承此前全部unknown，线上实测另记",
    provider: parent.provider,
    batch,
    scope: "新手依据教学内容迁移到条件变化的假想课题，非真人能力或有效方案证明",
  };
  const persist = () => store.save("training", "report", report);
  await store.save("freeze", "scenario", {
    scenario,
    criteria,
    lesson: run.result,
    sources: paper.sources,
  });
  await persist();
  const counted = new TrainingProvider(
    provider,
    batch,
    persist,
    (id, input) => store.save("inputs", id, input),
    () => batch.budget.attempts.length,
  );
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    reserveUnit(batch, 2, 0);
    counted.context = "novice-transfer";
    report.answer = (
      await counted.generate(
        "你是刚读完本次lesson的医学科研新手。尝试把学到的思路用于scenario，保留题目给定条件。不扮演专家、不假装学过lesson没有讲过的内容；不会的明确说待确认。给出自己的简短思路，不编数据。只返回JSON。",
        { lesson: run.result, scenario },
        answerSchema,
        controller.signal,
      )
    ).output.answer;
    await persist();
    await admission();
    counted.context = "transfer-grounding";
    report.review = (
      await counted.generate(
        "独立核验学习者对新情境的迁移，区别原论文、教学材料和假想新课题。检查是否遗漏或改变条件，是否把原数据套用为新数据。不要因没有专家级细节扣分；真正影响设计或结论的缺陷仍指出。逐条用学习者原句作quote，无相应原句则quote为空并判未满足。只返回JSON。",
        {
          scenario,
          answer: report.answer,
          lesson: run.result,
          sources: paper.sources,
          criteria,
        },
        reviewSchema,
        controller.signal,
      )
    ).output;
    const checks = report.review.checks;
    report.valid =
      new Set(checks.map((c: any) => c.criterion)).size === criteria.length &&
      checks.every(
        (c: any) => !c.passed || (!!c.quote && report.answer.includes(c.quote)),
      );
    report.passed =
      report.valid &&
      checks.every((c: any) => c.passed) &&
      report.review.majorErrors.length === 0;
    report.status = report.passed ? "diagnostic-passed" : "needs-improvement";
    batch.status = "complete";
  } catch (e) {
    report.status = "stopped";
    report.error = String(e);
    batch.status = "stopped";
  } finally {
    report.calls = batch.budget.attempts.length;
    await persist();
    console.log(
      JSON.stringify({
        status: report.status,
        calls: report.calls,
        passed: report.passed,
        error: report.error,
      }),
    );
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
