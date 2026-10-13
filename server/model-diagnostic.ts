import { z } from "zod";
import { digest } from "./materials.ts";
import type { TrainingBatch } from "./internal-training.ts";
import type { TaskTiming, Source, RoleRecord } from "../shared/types.ts";
import { studyTypeIds } from "../shared/research-plan.ts";

export const diagnosticManifest = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(100),
    model: z.literal("gpt-6.1-sol"),
    parentReport: z.string().min(1),
    paperPath: z.string().min(1),
    module: z.enum(["paper", "ppt", "research-plan"]),
    plan: z
      .object({
        conditions: z.string().trim().min(1).max(5000),
        studyTypes: z
          .array(z.enum(studyTypeIds))
          .min(1)
          .max(studyTypeIds.length),
        revision: z
          .object({
            conditions: z.string().trim().min(1).max(5000),
            instruction: z.string().trim().min(1).max(3000),
          })
          .strict(),
      })
      .strict()
      .optional(),
    question: z.string().trim().min(1).max(3000),
    sourceIds: z.array(z.string().min(1)).min(1).max(20),
    criteria: z.array(z.string().min(1)).min(3).max(12),
    slideCount: z.number().int().min(3).max(6).default(4),
    onlineUrl: z.string().url(),
    sharedAddition: z.string().max(3000).default(""),
    previousDiagnostic: z.string().min(1).optional(),
    structuredDelivery: z
      .enum(["native", "json-string", "json-string-native-novice"])
      .default("native"),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.module === "research-plan") !== !!value.plan)
      context.addIssue({
        code: "custom",
        path: ["plan"],
        message:
          "研究方案诊断必须提供条件及一次条件变更；其他模块不得携带方案配置。",
      });
    if (value.module === "research-plan" && value.sourceIds.length > 12)
      context.addIssue({
        code: "custom",
        path: ["sourceIds"],
        message: "研究方案最多绑定12个来源。",
      });
  });
export type DiagnosticManifest = z.infer<typeof diagnosticManifest>;
export const diagnosticLimit = 8;
// Temporary pilot settings, not online defaults or a claim of optimal latency.
export const diagnosticTiming: TaskTiming = {
  version: "task-timing-v1",
  scope: "full",
  taskMs: 4_500_000,
  requestMs: 600_000,
  firstOutputMs: 300_000,
  idleMs: 240_000,
  targetTaskMs: 900_000,
  targetRequestMs: 180_000,
  targetFirstOutputMs: 90_000,
  targetIdleMs: 60_000,
};
export interface ParentEvidence {
  id: string;
  threadId: string;
  turnId: string;
  checkedAt: string;
  result:
    "completed" | "failed" | "interrupted" | "historical-ephemeral-unavailable";
}
export function stoppedParent(
  parent: {
    batches: TrainingBatch[];
    workflow?: { checkpoint?: { decision: string } };
  },
  evidence: ParentEvidence[] = [],
) {
  if (
    parent.workflow?.checkpoint?.decision !== "stop" ||
    !parent.batches.length ||
    parent.batches.some((b) => b.status === "running")
  )
    throw new Error("父周期必须已明确停止；诊断不能改写旧周期。");
  const attempts = parent.batches.flatMap((b) => b.budget.attempts);
  if (
    new Set(attempts.map((a) => a.id)).size !== attempts.length ||
    attempts.some((a) => {
      if (
        a.status === "succeeded" ||
        ["completed", "failed", "interrupted"].includes(
          a.observation?.remoteTerminal ?? "",
        )
      )
        return false;
      const entry = evidence.find(
        (e) =>
          e.id === a.id &&
          e.threadId === a.observation?.threadId &&
          e.turnId === a.observation?.turnId,
      );
      if (!entry || !entry.threadId || !entry.turnId) return true;
      const age = Date.now() - Date.parse(entry.checkedAt);
      if (!Number.isFinite(age) || age < 0 || age > 300_000) return true;
      return entry.result === "historical-ephemeral-unavailable"
        ? !Number.isFinite(Date.parse(a.startedAt)) ||
            Date.now() - Date.parse(a.startedAt) < 600_000
        : !["completed", "failed", "interrupted"].includes(entry.result);
    })
  )
    throw new Error("父周期请求仍可能活动；不能发起新诊断。");
  return { attempts: attempts.length, digest: digest(parent) };
}
export function assertDiagnosticRun(
  status: string,
  batch: TrainingBatch,
  contractHash: string,
  currentHash: string,
) {
  if (status !== "prepared" || batch.budget.attempts.length !== 0)
    throw new Error("诊断只派发一次；中断或未知请求不自动重发。");
  if (
    batch.budget.limit !== diagnosticLimit ||
    batch.cycleLimit !== diagnosticLimit ||
    batch.budget.groupLimit !== diagnosticLimit ||
    digest(batch.budget.timing) !== digest(diagnosticTiming) ||
    contractHash !== currentHash
  )
    throw new Error("诊断额度或冻结输入已变化。");
}
export function diagnosticMetrics(batch: TrainingBatch) {
  const attempts = batch.budget.attempts;
  const summary = (records: typeof attempts) => ({
    calls: records.length,
    durationMs: records.map((a) => a.durationMs),
    firstOutputMs: records.map((a) =>
      a.observation?.firstMeaningfulOutputAt
        ? Date.parse(a.observation.firstMeaningfulOutputAt) -
          Date.parse(a.startedAt)
        : null,
    ),
    maxOutputGapMs: records.map((a) => a.observation?.maxOutputGapMs ?? null),
  });
  return {
    limit: diagnosticLimit,
    calls: attempts.length,
    remaining: diagnosticLimit - attempts.length,
    successful: summary(attempts.filter((a) => a.status === "succeeded")),
    incomplete: attempts
      .filter((a) => a.status !== "succeeded")
      .map((a) => ({
        id: a.id,
        status: a.status,
        observedDurationMs: a.durationMs,
        timeoutLayer: a.observation?.timeoutLayer ?? null,
        remoteTerminal: a.observation?.remoteTerminal ?? null,
      })),
    tokens: attempts.map((a) => ({
      id: a.id,
      status: a.status,
      tokens: a.tokens,
    })),
    amount: null,
    amountReason: "未取得账单；不以模型名称估算现金费用。",
  };
}

export function finishedDiagnostic(previous: {
  status: string;
  batch: TrainingBatch;
  priorDiagnosticCalls?: number;
}) {
  const calls = previous.batch.budget.attempts;
  const prior = previous.priorDiagnosticCalls ?? 0;
  if (
    ![
      "stopped",
      "cancelled",
      "diagnostic-passed",
      "needs-improvement",
    ].includes(previous.status) ||
    previous.batch.status === "running" ||
    !Number.isSafeInteger(prior) ||
    prior < 0 ||
    new Set(calls.map((a) => a.id)).size !== calls.length ||
    calls.some(
      (a) =>
        a.status !== "succeeded" &&
        !["completed", "failed", "interrupted"].includes(
          a.observation?.remoteTerminal ?? "",
        ),
    )
  )
    throw new Error("前诊断未确认停止，不能另起请求；保留原消耗。");
  return prior + calls.length;
}

// Preserve the reading task's actual image exposure and source binding.
export function diagnosticReadingImage(
  visibleImage: string | undefined,
  sources: Pick<Source, "id" | "image">[],
) {
  if (!visibleImage) return undefined;
  const source = sources.find((s) => s.image === visibleImage);
  if (!source) throw new Error("带读独立评价的原图无法绑定到本任务来源。");
  return { image: visibleImage, imageSourceId: source.id };
}

// Use recorded generator inputs, never reconstruct evidence from full source pages.
const diagnosticPacket = z.object({
  blocks: z
    .array(z.object({ hash: z.string().min(1), text: z.string().min(1) }))
    .min(1),
  references: z
    .array(
      z.object({
        id: z.string().min(1),
        locator: z.string().min(1),
        blockHash: z.string().min(1),
      }),
    )
    .min(1),
});
export function diagnosticVisibleSources(
  roles: Pick<RoleRecord, "role" | "input">[],
) {
  const generated = roles.filter(
    (r) => r.role === "teaching" || r.role === "revision",
  );
  if (!generated.length)
    throw new Error("独立评价缺少实际生成资料包，未派发评价请求。");
  const visible = new Map<
    string,
    { id: string; text: string; locator: string }
  >();
  for (const role of generated) {
    const parsed = z
      .object({ sources: diagnosticPacket })
      .safeParse(role.input);
    if (!parsed.success)
      throw new Error("独立评价的实际生成资料包无效，未派发评价请求。");
    const blocks = new Map<string, string>();
    for (const block of parsed.data.sources.blocks) {
      if (blocks.has(block.hash) && blocks.get(block.hash) !== block.text)
        throw new Error("独立评价资料块绑定存在歧义，未派发评价请求。");
      blocks.set(block.hash, block.text);
    }
    for (const ref of parsed.data.sources.references) {
      const text = blocks.get(ref.blockHash);
      if (text === undefined)
        throw new Error("独立评价来源无法绑定到实际资料块，未派发评价请求。");
      const source = { id: ref.id, text, locator: ref.locator };
      // The original-page hash can be shared by different actual excerpts.
      visible.set(digest(source), source);
    }
  }
  return [...visible.values()];
}
