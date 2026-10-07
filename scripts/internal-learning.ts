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
const directory = resolve(
  process.env.TUTOR_TRAINING_DIR ?? "runs/internal-training/cycle-1",
);
const rel = relative(resolve("runs/internal-training"), directory);
if (!rel || rel.startsWith("..") || isAbsolute(rel))
  throw new Error("训练目录必须隔离");
const store = new RecordStorage(join(directory, "records"));
type Product = { id: string; side: string; status: string; artifact?: unknown };
const products = await store.read<{
  results: Product[];
  batches: TrainingBatch[];
  protocolHash: string;
}>("training", "report");
assertContinuation(products.batches);
if (products.results.length !== 12)
  throw new Error("M2 尚未完成六例两侧比较，M3 未发起。");
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
        "请独立组织三页中文论文汇报提纲。每页给标题、简短要点、要解释的原图观察和讲述连接；说明观察关联的边界。不复制任何现成 PPT。",
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
    batch.budget.limit = 36;
    batch.budget.groupLimit = 36;
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
        for (const side of ["baseline", "candidate"] as const)
          for (const branch of [
            "unlearned",
            "materials",
            "materials-and-teaching",
          ] as const) {
            const item: LearningReport["results"][number] = {
              taskId: specification.id,
              side,
              branch,
              status: "not-run",
            };
            report.results.push(item);
            const lesson = products.results.find(
              (p) => p.id === specification.lessonCase && p.side === side,
            )!;
            if (
              branch === "materials-and-teaching" &&
              lesson.status !== "generated"
            ) {
              item.reason =
                "前序教学未成功交付；不能用失败草稿或固定答案替代可见教学。";
              await persist();
              continue;
            }
            const targetSources = protocol.materials
              .find((p) => p.id === specification.paperId)!
              .sources.filter((s) => !s.image);
            const sourcePacket = materialPacket(
              targetSources,
              specification.question,
            );
            const sources = sourcePacket.references.map((s) => ({
              id: s.id,
              text: sourcePacket.blocks.find((b) => b.hash === s.blockHash)!
                .text,
              locator: s.locator,
            }));
            const learningPaper = protocol.materials.find(
              (p) => p.id === "train-xu",
            )!;
            const text = JSON.stringify(
              materialPacket(learningPaper.sources.filter((s) => !s.image)),
            );
            const material: Exposure = {
              id: "learning-material",
              kind: "material",
              text,
              versionHash: digest(text),
            };
            const teachingText = JSON.stringify(lesson.artifact ?? null),
              teaching: Exposure = {
                id: "learning-teaching",
                kind: "teaching",
                text: teachingText,
                versionHash: digest(teachingText),
              };
            const record = cloneOpenLearner(
              initial,
              `${specification.id}-${side}-${branch}`,
              branch,
              [material],
              [teaching],
            );
            const task: OpenTask = {
              id: specification.id,
              kind: specification.kind,
              question: specification.question,
              sources,
            };
            if (batch.budget.attempts.length + 2 > 36 || batch.stopReason)
              throw new Error("学习试验额度或状态不允许完整作答及独立评价。");
            counted.context = `${record.id}-answer`;
            const observation = await answerOpenTask(
              counted,
              record,
              task,
              controller.signal,
              (r) => store.save("open-learners", r.id, r),
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
                  ...record.exposures.map((e) => ({
                    id: e.id,
                    text: e.text,
                    locator: `${e.kind}:${e.versionHash}`,
                  })),
                ],
              },
              controller.signal,
            );
            item.status = observation.unsupportedVisibleIds.length
              ? "unsupported-visible-ids"
              : "evaluated";
            await persist();
            console.log(
              "learning",
              specification.id,
              side,
              branch,
              item.status,
            );
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
}
