import { resolve, join, relative, isAbsolute } from "node:path";
import { open, unlink, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { RecordStorage } from "../server/storage.ts";
import { BudgetLedger } from "../server/budget.ts";
import { createProvider } from "../server/model-config.ts";
import { digest, materialPacket } from "../server/materials.ts";
import {
  TrainingProvider,
  reviewArtifact,
  assertContinuation,
  type TrainingBatch,
} from "../server/internal-training.ts";
import {
  cloneOpenLearner,
  answerOpenTask,
  type OpenTask,
  type Exposure,
} from "../server/internal-learner.ts";
import { LearnerStore } from "../server/learner.ts";
import type { PaperBundle } from "../shared/types.ts";
import {
  assertLearningGate,
  lessonExposure,
  assertIndependentTarget,
  learningImage,
  type LearningProduct,
} from "../server/learning-exposure.ts";
import {
  trainingCases,
  trainingPapers,
} from "../evals/internal-training-cases.ts";
import { pptImagePacket } from "../server/ppt-image-packet.ts";
import { trainingAdmission } from "../server/training-admission.ts";
import {
  learningCriteria,
  learningCalibration,
  reserveLearningUnit,
} from "../server/learning-protocol.ts";
const stage = process.argv[2] ?? "run";
if (!["calibrate", "run"].includes(stage))
  throw new Error("学习入口：calibrate / run");
const directory = resolve(
  process.env.TUTOR_TRAINING_DIR ?? "runs/internal-training/cycle-1",
);
const rel = relative(resolve("runs/internal-training"), directory);
if (!rel || rel.startsWith("..") || isAbsolute(rel))
  throw new Error("训练目录必须隔离");
const store = new RecordStorage(join(directory, "records"));
type Product = LearningProduct;
const products = await store.read<{
  results: Product[];
  batches: TrainingBatch[];
  protocolHash: string;
}>("training", "report");
assertContinuation(products.batches);
if (products.results.length !== 12)
  throw new Error("M2 尚未完成六例两侧比较，M3 未发起。");
const accepted = await store
  .read<{
    protocolHash: string;
    accepted: boolean;
    files: { path: string; hash: string }[];
  }>("training", "file-acceptance")
  .catch(() => null);
assertLearningGate(
  products.results,
  accepted?.protocolHash === products.protocolHash && accepted.accepted,
);
for (const file of accepted!.files) {
  if (
    createHash("sha256")
      .update(await readFile(file.path))
      .digest("hex") !== file.hash
  )
    throw new Error("验收后的实际文件发生变化，学习试验未发起。");
}
if (!accepted!.files.length) throw new Error("缺少实际 PPT 与完整稿文件验收。");
for (const product of products.results.filter(
  (p) => p.status === "generated" && p.exportPath,
)) {
  const required = [
    product.exportPath!,
    product.exportPath!.replace(/\.pptx$/i, "-speech.md"),
  ];
  if (
    !required.every((path) =>
      accepted!.files.some((file) => resolve(file.path) === resolve(path)),
    )
  )
    throw new Error("实际已交付 PPT 或完整稿没有对应文件验收记录。");
}
const protocol = await store.read<{
  fingerprint: unknown;
  materials: { id: string; sources: PaperBundle["sources"] }[];
  baselineHash: string;
  candidateHash: string;
}>("training", "protocol");
const provider = createProvider();
const fingerprint = {
  id: provider.id,
  model: provider.model,
  settings: provider.settings,
  capabilities: provider.capabilities,
};
if (digest(fingerprint) !== digest(protocol.fingerprint))
  throw new Error("模型配置变化，不能拼接学习试验。");
const lock = await open(join(directory, "learning.lock"), "wx");
const globalLock = await open(
  resolve("runs/internal-training/dispatch.lock"),
  "wx",
).catch(async (error) => {
  await lock.close();
  await unlink(join(directory, "learning.lock"));
  throw error;
});
try {
  const tasks = [
    {
      id: "retelling",
      kind: "evidence-retelling",
      paperId: "holdout-passos",
      lessonCase: "D1",
      question:
        "请独立复述一条从线粒体活性氧测量、干预对照到细胞衰老的证据链。解释读数测到了什么、可排除什么和仍不能证明什么。",
    },
    {
      id: "design",
      kind: "design-draft",
      paperId: "holdout-bell",
      lessonCase: "D3",
      question:
        "本院仅有一次握力与一次常规血脂测量、年龄和性别，无法追踪。请独立提出青年人握力与血脂关联的设计草案，说明资源变化为何改变设计及其局限。样本规模和缺失率未知，不填造结果。",
    },
    {
      id: "outline",
      kind: "report-outline",
      paperId: "holdout-bell",
      lessonCase: "D1",
      question:
        "请独立组织三页中文论文汇报提纲。每页给标题、简短要点、要解释的证据和讲述连接；说明观察关联的边界。不复制任何现成 PPT。",
    },
  ] as const;
  const initial = await new LearnerStore(async () => {}).create(
    {
      id: "fixed-beginner",
      version: "1",
      background:
        "医学背景科研新手，知道细胞和临床记录，尚不熟悉实验单位、归一化或关联与因果的区别。",
      concepts: [
        {
          id: "measurement",
          description: "测量读数和解释边界",
          initial: "unknown",
        },
        { id: "design", description: "资源约束与设计对照", initial: "unknown" },
        { id: "report", description: "汇报证据主线", initial: "unknown" },
      ],
    },
    "00000000-0000-0000-0000-000000000001",
  );
  const code = await Promise.all(
    [
      "scripts/internal-learning.ts",
      "server/internal-learner.ts",
      "server/internal-training.ts",
      "server/budget.ts",
      "server/learning-exposure.ts",
      "server/training-admission.ts",
      "server/materials.ts",
      "server/ppt-image-packet.ts",
      "server/learner.ts",
      "server/learning-protocol.ts",
      "server/provider.ts",
      "evals/internal-training-cases.ts",
    ].map(async (path) => ({
      path,
      hash: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    })),
  );
  const learningHash = digest({
    tasks,
    initial,
    fingerprint,
    code,
    productProtocol: products.protocolHash,
    products: products.results,
    learningCriteria,
    learningCalibration,
  });
  interface LearningReport {
    hash: string;
    batches: TrainingBatch[];
    calibration: { id: string; matched: boolean; evaluation: unknown }[];
    status: "calibrating" | "ready" | "running" | "complete" | "stopped";
    results: {
      taskId: string;
      side: string;
      branch: string;
      status: string;
      reason?: string;
      raw?: unknown;
      evaluation?: unknown;
    }[];
    admission?: unknown[];
  }
  let report: LearningReport;
  try {
    report = await store.read<LearningReport>("learning", "report");
    if (report.hash !== learningHash) throw new Error("学习试验输入版本改变");
    assertContinuation(report.batches);
    if (report.status === "stopped")
      throw new Error("学习批次已停止，保留原记录，不自动重发。");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    report = {
      hash: learningHash,
      batches: [],
      calibration: [],
      results: [],
      status: "calibrating",
    };
    await store.save("learning", "protocol", {
      tasks,
      initial,
      fingerprint,
      code,
      learningHash,
      productProtocol: products.protocolHash,
      learningCriteria,
      learningCalibration,
      maxCalls: 28,
      batchLimit: 12,
      limitations: [
        "每条件一次，仅模型模拟；自带先验无法消除，不能据单次正确作答归因于教学，真实学习迁移未验。",
      ],
    });
    await store.save("learning", "report", report);
  }
  if (
    report.status === "complete" ||
    (stage === "calibrate" &&
      report.calibration.length === 4 &&
      report.calibration.every((c) => c.matched))
  ) {
    console.log("已有完整阶段记录，不重复调用。");
  } else {
    if (
      stage === "run" &&
      (report.calibration.length !== 4 ||
        report.calibration.some((c) => !c.matched))
    )
      throw new Error("先完成独立学习评价校准批次。");
    if (stage === "calibrate" && report.calibration.length)
      throw new Error("校准单元不完整，保留记录，不自动补发。");
    if (
      stage === "run" &&
      report.batches.filter((b) => b.budget.limit === 12).length >= 2
    )
      throw new Error("两批学习比较已用完，保留未运行分支，不追加第三批。");
    const batch: TrainingBatch = {
      id: `learning-batch-${report.batches.length + 1}`,
      phase: "M3",
      cycleLimit: 28,
      status: "running",
      budget: new BudgetLedger(
        "learning",
        async () => {},
        undefined,
        45 * 60_000,
      ).state,
    };
    batch.budget.limit = stage === "calibrate" ? 4 : 12;
    batch.budget.groupLimit = batch.budget.limit;
    report.batches.push(batch);
    const persist = () => store.save("learning", "report", report);
    await persist();
    const counted = new TrainingProvider(
      provider,
      batch,
      persist,
      (id, data) => store.save("learner-inputs", id, data),
      () => report.batches.reduce((n, b) => n + b.budget.attempts.length, 0),
    );
    const controller = new AbortController(),
      cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      if (stage === "calibrate") {
        reserveLearningUnit(batch, report.batches, 4);
        for (const sample of learningCalibration) {
          counted.context = `learning-calibration-${sample.id}`;
          await trainingAdmission();
          const evaluation = await reviewArtifact(
            counted,
            {
              question: "按可见材料完成独立复述或设计，说明必要推理和依据范围",
              conditions:
                "预定学习评价正反例；逐项评价，不把自评理解当作通过。",
              criteria: learningCriteria,
              artifact: { text: sample.text },
              sources: [
                {
                  id: "learning-calibration-source",
                  text: sample.source,
                  locator: "校准原句",
                },
              ],
            },
            controller.signal,
          );
          const matched =
            evaluation.valid &&
            learningCriteria.every((criterion, index) =>
              evaluation.review.checks.some(
                (c) =>
                  c.criterion === criterion &&
                  c.passed === sample.expected[index],
              ),
            );
          report.calibration.push({ id: sample.id, matched, evaluation });
          await persist();
          if (!matched)
            throw new Error("学习评价逐维校准失败，不启动四条件比较。");
        }
        report.status = "ready";
      }
      comparisons: for (const specification of stage === "run" ? tasks : [])
        for (const condition of [
          { side: "control", branch: "unlearned" },
          { side: "control", branch: "materials" },
          { side: "baseline", branch: "materials-and-teaching" },
          { side: "candidate", branch: "materials-and-teaching" },
        ] as const) {
          const { side, branch } = condition;
          if (
            report.results.some(
              (r) =>
                r.taskId === specification.id &&
                r.side === side &&
                r.branch === branch,
            )
          )
            continue;
          if (batch.budget.attempts.length + 2 > batch.budget.limit)
            break comparisons;
          if (
            Date.parse(batch.budget.deadline) - Date.now() <
            2 * 180_000 + 120_000
          )
            break comparisons;
          const item: LearningReport["results"][number] = {
            taskId: specification.id,
            side,
            branch,
            status: "not-run",
          };
          const { material, teaching } = lessonExposure(
            products.results,
            specification.lessonCase,
            side === "control" ? "baseline" : side,
          );
          if (branch === "materials-and-teaching" && !teaching) {
            report.results.push(item);
            item.reason =
              "前序教学未成功交付；不能用失败草稿或固定答案替代可见教学。";
            await persist();
            continue;
          }
          const targetSources = protocol.materials.find(
            (p) => p.id === specification.paperId,
          )!.sources;
          const sourcePacket = materialPacket(
            targetSources,
            specification.question,
          );
          const sources = sourcePacket.references.map((s) => ({
            id: s.id,
            text: sourcePacket.blocks.find((b) => b.hash === s.blockHash)!.text,
            locator: s.locator,
          }));
          const record = cloneOpenLearner(
            initial,
            `${specification.id}-${side}-${branch}`,
            branch,
            [material],
            teaching ? [teaching] : [],
          );
          const task: OpenTask = {
            id: specification.id,
            kind: specification.kind,
            question: specification.question,
            sources,
          };
          assertIndependentTarget(
            task,
            trainingCases
              .filter((c) => c.id === specification.lessonCase)
              .map((c) => ({
                question: c.question,
                study: trainingPapers.find((p) => p.id === c.paperId)!.study,
              })),
            trainingPapers.find((p) => p.id === specification.paperId)!.study,
          );
          const targetImage = await pptImagePacket(
            protocol.materials
              .find((p) => p.id === specification.paperId)!
              .sources.filter((s) => s.image),
          );
          if (batch.stopReason)
            throw new Error("学习试验额度或状态不允许完整作答及独立评价。");
          reserveLearningUnit(batch, report.batches, 2);
          report.results.push(item);
          item.status = "running";
          report.status = "running";
          (report.admission ??= []).push({
            task: specification.id,
            side,
            branch,
            ...(await trainingAdmission()),
          });
          await persist();
          const visibleImage = await learningImage(record, targetImage);
          counted.context = `${record.id}-answer`;
          const observation = await answerOpenTask(
            counted,
            record,
            task,
            controller.signal,
            (r) => store.save("open-learners", r.id, r),
            visibleImage,
          );
          item.raw = observation;
          item.status = "answered";
          await persist();
          counted.context = `${record.id}-evaluation`;
          item.evaluation = await reviewArtifact(
            counted,
            {
              question: task.question,
              conditions:
                "固定初始画像的独立克隆；未经助手改写的原始作答。评价可见依据，不能按自评掌握判通过。",
              criteria: learningCriteria,
              artifact: observation.rawAnswer,
              sources: [
                ...sources,
                ...(record.exposures.some((e) => e.kind === "material")
                  ? products.results.find(
                      (p) =>
                        p.id === specification.lessonCase &&
                        p.side === "baseline",
                    )!.sources!
                  : []),
                ...record.exposures.map((e) => ({
                  id: e.id,
                  text: e.text,
                  locator: `${e.kind}:${e.versionHash}`,
                })),
              ],
            },
            controller.signal,
            visibleImage,
          );
          item.status = observation.unsupportedVisibleIds.length
            ? "unsupported-visible-ids"
            : "evaluated";
          await persist();
          console.log("learning", specification.id, side, branch, item.status);
        }
      batch.status = "complete";
      if (stage === "run" && report.results.length === 12)
        report.status = "complete";
    } catch (error) {
      batch.status = "stopped";
      report.status = "stopped";
      batch.stopReason ??= String(error);
      console.log("learning stopped", batch.stopReason);
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      await persist();
    }
  }
} finally {
  await lock.close();
  await unlink(join(directory, "learning.lock"));
  await globalLock.close();
  await unlink(resolve("runs/internal-training/dispatch.lock"));
}
