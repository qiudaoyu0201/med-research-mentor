// Two frozen local cases, isolated from production and full-paper generation.
import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { reviewSchema } from "../server/schemas.ts";
import { feedbackAttribution } from "../evals/role-coordination-candidate.ts";
import type { TrainingBatch } from "../server/internal-training.ts";

if (process.argv[2]) throw new Error("固定两例，不接受新目录或重复预算");
const id = "feedback-attribution-20261009";
const directory = resolve("runs/internal-training", id);
process.env.TUTOR_DATA_DIR = join(directory, "data");
const { RecordStorage } = await import("../server/storage.ts");
const { createProvider } = await import("../server/model-config.ts");
const { TrainingProvider, reserveUnit } =
  await import("../server/internal-training.ts");
const { BudgetLedger } = await import("../server/budget.ts");
const { trainingAdmission } = await import("../server/training-admission.ts");
const parentDirectory = resolve(
  "runs/internal-training/role-closure-20261009-storage-recovery/records",
);
const raw = await readFile(
  join(parentDirectory, "training/report.json"),
  "utf8",
);
const parent = JSON.parse(raw);
if (
  parent.status !== "needs-improvement" ||
  parent.calls !== 6 ||
  parent.batch.budget.attempts.length !== 6 ||
  parent.batch.budget.attempts.some((a: any) => a.status !== "succeeded")
)
  throw new Error("前批未明确结束");
const packet = JSON.parse(
  await readFile(
    join(
      parentDirectory,
      "inputs",
      parent.batch.budget.attempts.at(-1).id + ".json",
    ),
    "utf8",
  ),
);
const slide = structuredClone(packet.input.deck.slides[4]);
if (!slide.notes.includes("生存曲线直接比较两类灶的寿命"))
  throw new Error("冻结原句已改变");
// Remove unrelated claims, but retain the actual source bundle and citations.
slide.bullets = ["活细胞中可分别追踪端粒与非端粒损伤灶"];
slide.notes = "生存曲线直接比较两类灶的寿命。";
const falseClaim =
  "生存曲线经 log-rank 检验显示两类灶寿命有统计学显著差异，P=0.000001。";
const input = structuredClone(packet.input);
input.deck.slides = [slide];
input.draft.sections = [];
input.feedback = { understood: [falseClaim], breakpoints: [] };
input.previousIssues = [];
delete input.revisionAudit;
input.question =
  "仅检查摘取的动态追踪主张和学习者对它的复述，不评价未提供的其他页或整场汇报完整性。";
const wrong = structuredClone(input);
wrong.deck.slides[0].notes = falseClaim;
const cases = [
  {
    id: "learner-only",
    input,
    expected:
      "统计检验和数值仅在学习者复述中；应纠正误解，不得归责正文包含该句。",
  },
  {
    id: "draft-too",
    input: wrong,
    expected:
      "同一未提供依据的统计检验和P值已出现在notes，必须定位正文并blocking；不能以学习者误述为由放过。",
  },
];
const store = new RecordStorage(join(directory, "records"));
await mkdir(directory, { recursive: true });
const lockPath = resolve("runs/internal-training/dispatch.lock");
const lock = await open(lockPath, "wx");
try {
  const claim = await open(join(directory, "claim.json"), "wx");
  await claim.writeFile(
    JSON.stringify({
      limit: 2,
      parentHash: createHash("sha256").update(raw).digest("hex"),
      inheritedAttempts: parent.parentNewAttempts + parent.calls,
    }),
  );
  await claim.close();
  await trainingAdmission();
  const provider = createProvider();
  if (
    provider.id !== parent.provider.id ||
    provider.model !== parent.provider.model ||
    JSON.stringify(provider.settings) !==
      JSON.stringify(parent.provider.settings)
  )
    throw new Error("模型配置不同");
  const batch: TrainingBatch = {
    id,
    phase: "calibration",
    status: "running",
    cycleLimit: 2,
    budget: new BudgetLedger(id, async () => {}, undefined, 25 * 60_000).state,
  };
  batch.budget.limit = batch.budget.groupLimit = 2;
  batch.budget.timing = {
    version: "task-timing-v1",
    scope: "full",
    taskMs: 25 * 60_000,
    requestMs: 420_000,
    firstOutputMs: 90_000,
    idleMs: 90_000,
  };
  const report: any = {
    status: "running",
    parentReportHash: createHash("sha256").update(raw).digest("hex"),
    parentNewAttempts: parent.parentNewAttempts + parent.calls,
    inheritedUnknownUsage:
      "校准v4、v7各一次未知用量保留，远端均确认interrupted；参见父报告哈希链。",
    provider: parent.provider,
    batch,
    results: [],
    scope: "人工注入统计断言的局部配对，不是论文事实，不发布候选",
  };
  const persist = () => store.save("training", "report", report);
  await store.save(
    "freeze",
    "expectations",
    cases.map(({ id, expected }) => ({ id, expected })),
  );
  await store.save("freeze", "candidate", { addition: feedbackAttribution });
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
    for (const c of cases) {
      await trainingAdmission();
      counted.context = c.id;
      const result = await counted.generate(
        packet.instructions + "\n" + feedbackAttribution,
        c.input,
        reviewSchema,
        controller.signal,
        packet.image ?? undefined,
      );
      await store.save("results", c.id, result.output);
      report.results.push({ id: c.id, output: result.output });
      await persist();
      console.log(JSON.stringify({ id: c.id, status: "returned" }));
    }
    report.status = "awaiting-evaluation";
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
        error: report.error,
      }),
    );
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
