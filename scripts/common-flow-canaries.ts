// Paired local claim probes. Injected errors stay in diagnostic records only.
import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { groundedReviewSchema } from "../server/schemas.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
const id = "common-flow-canaries-20261010-v1";
const directory = resolve("runs/internal-training", id);
process.env.TUTOR_DATA_DIR = join(directory, "data");
const { RecordStorage } = await import("../server/storage.ts");
const { createProvider } = await import("../server/model-config.ts");
const { TrainingProvider } = await import("../server/internal-training.ts");
const { BudgetLedger } = await import("../server/budget.ts");
const { trainingAdmission } = await import("../server/training-admission.ts");
const parentDirectory = resolve(
  "runs/internal-training/mainline-campaign-20261010-candidate2/records",
);
const raw = await readFile(
  join(parentDirectory, "training/report.json"),
  "utf8",
);
const parent = JSON.parse(raw);
if (
  parent.batch.status !== "complete" ||
  parent.calls !== parent.batch.budget.attempts.length ||
  parent.batch.budget.attempts.some((a: any) => a.status !== "succeeded")
)
  throw new Error("前批调用尚未正常结束");
const baseline = JSON.parse(
  await readFile(join(parentDirectory, "freeze/baseline-rules.json"), "utf8"),
);
const candidate = JSON.parse(
  await readFile(join(parentDirectory, "freeze/rules.json"), "utf8"),
);
const paper: PaperBundle = JSON.parse(
  await readFile(
    "runs/internal-training/campaign-pool-20261010/diabetes-paper.json",
    "utf8",
  ),
);
const cases = [
  {
    id: "population-overreach",
    blocking: true,
    text: "这项研究已证明，低心血管风险且未确诊糖尿病的健康成人也能通过恩格列净降低心血管死亡。",
  },
  {
    id: "component-significance",
    blocking: true,
    text: "本试验的心肌梗死和卒中均显著减少，因此每个主要复合终点组成事件都得到了独立的显著性证明。",
  },
  {
    id: "qualified-background",
    blocking: false,
    text: "摘要报告主要复合结局达到统计学优效性，但心肌梗死和卒中单项无显著差异。通用理解上，整体复合终点的检验不同于各组成事件的单独检验，不能把整体显著推成每项均显著。仅凭摘要不能复原完整统计检验层级，也不能确定各组成事件对总体结果的具体贡献。",
  },
];
await mkdir(directory, { recursive: true });
const lockPath = resolve("runs/internal-training/dispatch.lock");
const lock = await open(lockPath, "wx");
try {
  const claim = await open(join(directory, "claim.json"), "wx");
  await claim.writeFile(
    JSON.stringify({
      limit: 6,
      parentHash: createHash("sha256").update(raw).digest("hex"),
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
    throw new Error("模型配置改变");
  const store = new RecordStorage(join(directory, "records"));
  const batch: TrainingBatch = {
    id,
    phase: "M1",
    status: "running",
    cycleLimit: 6,
    budget: new BudgetLedger(id, async () => {}, undefined, 30 * 60_000).state,
  };
  batch.budget.limit = batch.budget.groupLimit = 6;
  const report: any = {
    status: "running",
    parentNewAttempts: parent.parentNewAttempts + parent.calls,
    provider: parent.provider,
    inheritedUnknownUsage: parent.inheritedUnknownUsage,
    batch,
    results: [],
    scope: "开发用三组局部审核配对，不是未见论文留出集，不作为候选上线证据。",
  };
  const persist = () => store.save("training", "report", report);
  await store.save("freeze", "cases", cases);
  await store.save("freeze", "rules", { baseline, candidate });
  await persist();
  const counted = new TrainingProvider(
    provider,
    batch,
    persist,
    (key, input) => store.save("inputs", key, input),
    () => batch.budget.attempts.length,
  );
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    for (const sample of cases)
      for (const [arm, rules] of Object.entries({ baseline, candidate })) {
        await trainingAdmission();
        await trainingAdmission("http://127.0.0.1:4319");
        counted.context = sample.id + ":" + arm;
        const input = {
          question: "仅审核提供的这一段，不要求补全整篇讲解。",
          sources: paper.sources,
          draft: {
            title: "研究结论",
            question: "研究能说明什么",
            sections: [
              {
                title: "结论与解释",
                kind: "paper",
                text: sample.text,
                citations: [paper.sources[0].id],
              },
            ],
            terms: [],
            nextQuestion: "",
          },
          deck: null,
          feedback: { understood: [], breakpoints: [] },
        };
        const { output } = await counted.generate(
          rules.shared +
            "\n" +
            rules.entries["medical-grounding-check"].text +
            "\n只返回指定审核JSON。",
          input,
          groundedReviewSchema(paper.sources),
          controller.signal,
        );
        const serious = output.issues.filter(
          (i) =>
            !i.resolved &&
            i.severity === "blocking" &&
            ["fact", "scope"].includes(i.type),
        );
        const passed = sample.blocking
          ? serious.some(
              (i) =>
                !!i.location.trim() && i.evidence.includes(paper.sources[0].id),
            )
          : !output.issues.some((i) => !i.resolved);
        report.results.push({
          id: sample.id,
          arm,
          expectedBlocking: sample.blocking,
          passed,
          output,
        });
        await persist();
        console.log(JSON.stringify({ case: sample.id, arm, passed }));
      }
    report.status = report.results.every((r: any) => r.passed)
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
