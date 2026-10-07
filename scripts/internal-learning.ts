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
  reserveUnit,
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
  });
  interface LearningReport {
    hash: string;
    batch: TrainingBatch;
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
    assertContinuation([report.batch]);
    if (report.batch.status === "complete") {
      console.log("已有完整学习记录，不重复调用。");
      process.exitCode = 0;
    } else throw new Error("学习批次已停止，保留原记录，不自动重发。");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    const batch: TrainingBatch = {
      id: "learning-cycle-1",
      phase: "M3",
      status: "running",
      budget: new BudgetLedger(
        "learning",
        async () => {},
        undefined,
        45 * 60_000,
      ).state,
    };
    batch.budget.limit = 24;
    batch.budget.groupLimit = 24;
    report = { hash: learningHash, batch, results: [] };
    const persist = () => store.save("learning", "report", report);
    await store.save("learning", "protocol", {
      tasks,
      initial,
      fingerprint,
      code,
      learningHash,
      productProtocol: products.protocolHash,
      limitations: [
        "每条件一次，仅模型模拟；自带先验无法消除，不能据单次正确作答归因于教学，真实学习迁移未验。",
      ],
    });
    await persist();
    const counted = new TrainingProvider(
      provider,
      batch,
      persist,
      (id, data) => store.save("learner-inputs", id, data),
      () => batch.budget.attempts.length,
    );
    const controller = new AbortController(),
      cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      for (const specification of tasks)
        for (const condition of [
          { side: "control", branch: "unlearned" },
          { side: "control", branch: "materials" },
          { side: "baseline", branch: "materials-and-teaching" },
          { side: "candidate", branch: "materials-and-teaching" },
        ] as const) {
          const { side, branch } = condition;
          const item: LearningReport["results"][number] = {
            taskId: specification.id,
            side,
            branch,
            status: "not-run",
          };
          report.results.push(item);
          const { material, teaching } = lessonExposure(
            products.results,
            specification.lessonCase,
            side === "control" ? "baseline" : side,
          );
          if (branch === "materials-and-teaching" && !teaching) {
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
          if (batch.budget.attempts.length + 2 > 24 || batch.stopReason)
            throw new Error("学习试验额度或状态不允许完整作答及独立评价。");
          reserveUnit(batch, 2, batch.budget.attempts.length);
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
              criteria: [
                "正确完成当前独立复述、设计或汇报任务，解释必要推理连接",
                "事实和设计边界准确，不编造资源、样本量或实测结果",
                "作答的知识依据可从可见目标资料和真实曝光支持，额外模型先验须指出",
              ],
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
    } catch (error) {
      batch.status = "stopped";
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
