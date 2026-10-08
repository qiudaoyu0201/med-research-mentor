import { randomUUID } from "node:crypto";
import type { LoopReport } from "./short-loop.ts";
import { assertLoopHistory } from "./short-loop.ts";
import { digest } from "./materials.ts";
import { iterationUsage, reserveIterationUnit } from "./training-protocol.ts";
export const workflowLaneLimits = {
  reading: 20,
  artifacts: 14,
  comparison: 12,
  reserve: 12,
} as const;
export type WorkflowLane = keyof typeof workflowLaneLimits;
export interface WorkflowRun {
  id: string;
  caseId: string;
  lane: WorkflowLane;
  freezeHash: string;
  batchId: string;
  reservedCalls: number;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
  calls?: number;
  taskId?: string;
  artifacts?: { path: string; hash: string }[];
  error?: string;
}
export interface WorkflowReport extends LoopReport {
  workflow?: {
    version: "workflow-v1.6";
    baselineLoopsHash: string;
    runs: WorkflowRun[];
    checkpoint?: {
      at: string;
      evidenceHash: string;
      evidence: string;
      decision: "continue" | "stop";
    };
  };
}
export function extendWorkflow(report: WorkflowReport, planHash: string) {
  if (report.quota.extension) {
    validateWorkflow(report);
    if (report.quota.extension.planHash !== planHash)
      throw new Error("扩展已绑定另一份方案。");
    return;
  }
  assertLoopHistory(report);
  const usage = iterationUsage(report.quota, report.batches);
  if (
    report.quota.cycle !== 3 ||
    usage.current !== 42 ||
    usage.combined !== 108 ||
    usage.remainingCycle !== 28
  )
    throw new Error("扩展起点应为累计108、当前42、余额28，不能改账清零。");
  const before = structuredClone(report.quota);
  report.quota.extension = {
    version: "workflow-v1.6",
    authorizedBy: "user-latest-plan-implementation",
    planHash,
    priorQuotaHash: digest(before),
    baselineBatchIds: report.batches.map((b) => b.id),
    baselineBatchHash: digest(report.batches),
    usedBefore: 42,
    oldLimit: 70,
    newLimit: 100,
    added: 30,
    createdAt: new Date().toISOString(),
  };
  report.workflow = {
    version: "workflow-v1.6",
    baselineLoopsHash: digest(report.shortLoops),
    runs: [],
  };
  validateWorkflow(report);
}
export function validateWorkflow(report: WorkflowReport) {
  const usage = iterationUsage(report.quota, report.batches);
  const state = report.workflow,
    ext = report.quota.extension;
  if (
    !ext ||
    !state ||
    state.version !== ext.version ||
    digest(report.shortLoops) !== state.baselineLoopsHash
  )
    throw new Error("原分路快照变化或阶段合同缺失。");
  const fresh = report.batches.filter(
    (b) => !ext.baselineBatchIds.includes(b.id),
  );
  if (
    fresh.length !== state.runs.length ||
    new Set(state.runs.map((r) => r.batchId)).size !== state.runs.length ||
    fresh.some((b) => !state.runs.some((r) => r.batchId === b.id))
  )
    throw new Error("新增账本与阶段预约不一致。");
  for (const r of state.runs) {
    const b = fresh.find((b) => b.id === r.batchId);
    if (
      !Object.hasOwn(workflowLaneLimits, r.lane) ||
      !b ||
      !Number.isSafeInteger(r.reservedCalls) ||
      r.reservedCalls < 1 ||
      b.budget.limit !== r.reservedCalls ||
      b.budget.attempts.length > r.reservedCalls ||
      (r.status !== "running" && r.calls !== b.budget.attempts.length)
    )
      throw new Error("调用、预约和分路计数不一致。");
  }
  for (const lane of Object.keys(workflowLaneLimits) as WorkflowLane[])
    if (
      state.runs
        .filter((r) => r.lane === lane)
        .reduce(
          (n, r) => n + (r.status === "running" ? r.reservedCalls : r.calls!),
          0,
        ) > workflowLaneLimits[lane]
    )
      throw new Error("分路阶段额度超限。");
  return {
    ...usage,
    stageCalls: usage.current - ext.usedBefore,
    stageRemaining: usage.remainingCycle,
  };
}
export function reserveWorkflow(
  report: WorkflowReport,
  lane: WorkflowLane,
  caseId: string,
  freezeHash: string,
  required: number,
) {
  const usage = validateWorkflow(report);
  assertLoopHistory(report);
  const state = report.workflow!;
  if (
    state.runs.some((r) => r.status === "running") ||
    report.batches.some((b) => b.status === "running")
  )
    throw new Error("已有活动预约，不派发并发任务。");
  if (
    state.runs.some((r) => r.caseId === caseId && r.freezeHash === freezeHash)
  )
    throw new Error("冻结单元已尝试，不自动重发；修复需显式新输入。");
  if (
    state.checkpoint?.decision === "stop" ||
    (usage.stageCalls + required > 20 && !state.checkpoint)
  )
    throw new Error(
      "前20次阶段需先记录事实、返工、等待与成本复核，再决定继续。",
    );
  const spent = state.runs
    .filter((r) => r.lane === lane)
    .reduce((n, r) => n + (r.calls ?? r.reservedCalls), 0);
  if (
    !Object.hasOwn(workflowLaneLimits, lane) ||
    spent + required > workflowLaneLimits[lane]
  )
    throw new Error("阶段分路余额不足。");
  reserveIterationUnit(report.quota, report.batches, required, "workflow-v1.6");
  return {
    id: randomUUID(),
    caseId,
    lane,
    freezeHash,
    reservedCalls: required,
    status: "running" as const,
    startedAt: new Date().toISOString(),
  };
}
