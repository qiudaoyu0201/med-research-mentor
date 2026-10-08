import { randomUUID } from "node:crypto";
import type { PaperBundle, Source } from "../shared/types.ts";
import type { TrainingBatch } from "./internal-training.ts";
import {
  iterationUsage,
  reserveIterationUnit,
  type IterationQuota,
} from "./training-protocol.ts";
import { digest } from "./materials.ts";
import { shortLoopCases } from "../evals/short-loop-cases.ts";

export type LoopLane = "round-1" | "round-2" | "whole" | "repair";
export const laneLimits = {
  "round-1": 12,
  "round-2": 12,
  whole: 20,
  repair: 21,
} as const;
export interface LoopRecord {
  id: string;
  caseId: string;
  lane: LoopLane;
  freezeHash: string;
  batchId: string;
  reservedCalls: number;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
  calls?: number;
  endToEndMs?: number;
  artifacts?: string[];
  taskIds?: string[];
  error?: string;
  fileValidation?: { passed: boolean; evidence: string };
  scienceValidation?: { passed: boolean; evidence: string };
}
export interface LoopState {
  version: "short-loop-v1.4";
  historicalBatchHash: string;
  historicalBatchIds: string[];
  historicalPendingIds: string[];
  runs: LoopRecord[];
}
export interface LoopReport {
  quota: IterationQuota;
  batches: TrainingBatch[];
  shortLoops?: LoopState;
}
export function initializeLoops(report: LoopReport): LoopState {
  const usage = iterationUsage(report.quota, report.batches);
  if (
    report.quota.cycle !== 3 ||
    usage.current !== 5 ||
    report.batches.some((b) => b.status === "running")
  )
    throw new Error("短闭环必须继承已停止的第三周期五次历史调用，不另建额度。");
  return {
    version: "short-loop-v1.4",
    historicalBatchHash: digest(report.batches),
    historicalBatchIds: report.batches.map((b) => b.id),
    historicalPendingIds: report.batches
      .flatMap((b) => b.budget.attempts)
      .filter((a) => ["reserved", "unknown", "cancelled"].includes(a.status))
      .map((a) => a.id),
    runs: [],
  };
}
export function assertLoopHistory(report: LoopReport) {
  const state = report.shortLoops;
  if (
    !state ||
    state.version !== "short-loop-v1.4" ||
    digest(
      report.batches.filter((b) => state.historicalBatchIds.includes(b.id)),
    ) !== state.historicalBatchHash
  )
    throw new Error("历史中断账本发生变化，不能恢复短闭环派发。");
  iterationUsage(report.quota, report.batches);
  const newBatches = report.batches.filter(
    (b) => !state.historicalBatchIds.includes(b.id),
  );
  if (
    newBatches.some(
      (b) =>
        b.status === "running" ||
        b.budget.attempts.some(
          (a) =>
            ["reserved", "unknown", "cancelled"].includes(a.status) &&
            !["completed", "interrupted", "failed"].includes(
              a.observation?.remoteTerminal ?? "",
            ),
        ),
    )
  )
    throw new Error("新请求仍运行或远端状态未确认，保留记录，不派发后续任务。");
  if (state.runs.some((r) => r.status === "running"))
    throw new Error("短闭环任务未收尾，不自动重发。");
}
export function reserveLoop(
  report: LoopReport,
  lane: LoopLane,
  caseId: string,
  freezeHash: string,
  required = 4,
) {
  assertLoopHistory(report);
  const state = report.shortLoops!;
  if (state.runs.some((r) => r.lane === lane && r.caseId === caseId))
    throw new Error("该冻结样本已运行，不自动重复。修复后使用第二轮新输入。");
  if (
    lane === "whole" &&
    !["figure-6f", "protein"].every((id) =>
      state.runs.some(
        (r) =>
          r.caseId === id &&
          r.status === "completed" &&
          r.scienceValidation?.passed &&
          (id !== "figure-6f" || r.fileValidation?.passed),
      ),
    )
  )
    throw new Error("局部质量与实际图稿未验通过，不能扩大到整体。");
  if (
    state.runs
      .filter((r) => r.lane === lane)
      .reduce((n, r) => n + (r.calls ?? r.reservedCalls), 0) +
      required >
    laneLimits[lane]
  )
    throw new Error("分路调用额度不足，不能追加对照或额外评价。");
  const usage = iterationUsage(report.quota, report.batches);
  const wholeUsed = state.runs
    .filter((r) => r.lane === "whole")
    .reduce((n, r) => n + (r.calls ?? r.reservedCalls), 0);
  if (lane !== "whole" && usage.remainingCycle - required < 20 - wholeUsed)
    throw new Error("调用将侵占必要整体验收预留，停止派发。");
  reserveIterationUnit(report.quota, report.batches, required);
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

// Exact ranges are checked against the frozen source. Boundaries follow complete
// paragraphs or method sections rather than arbitrary character truncation.
function excerpt(source: Source, start: string, end?: string): Source {
  const from = source.text.indexOf(start),
    to = end
      ? source.text.indexOf(end, from + start.length)
      : source.text.length;
  if (from < 0 || to <= from) throw new Error(`片段边界缺失：${source.id}`);
  return {
    ...source,
    id: `${source.id}-range-${from}-${to}`,
    text: source.text.slice(from, to),
    locator: `${source.locator} · 冻结原文字符 ${from}–${to}`,
    image: undefined,
  };
}
export function freezeFragment(
  paper: PaperBundle,
  caseId: string,
): PaperBundle {
  const test = shortLoopCases.find((c) => c.id === caseId);
  if (!test || paper.id !== "train-xu")
    throw new Error("未知开发样本，保留材料不进入调优。");
  const page = (n: number) => {
    const source = paper.sources.find((s) => s.page === n && !s.image);
    if (!source) throw new Error(`冻结 PDF 缺页 ${n}`);
    return source;
  };
  const sources: Source[] =
    caseId === "protein"
      ? []
      : [
          excerpt(page(3), "Dasatinib plus quercetin reduces", "N AT u RE"),
          excerpt(page(4), "eliminate senescent cells", "We next examined"),
        ];
  if (caseId === "intervention")
    sources.push(
      excerpt(
        page(5),
        "D   +   Q reduced cytokine production",
        "Eliminating senescent cells both",
      ),
    );
  if (caseId === "figure-6f") {
    sources.push(
      excerpt(page(7), "Clearance of senescent cells", "To further test"),
    );
    const figure = paper.sources.find((s) => s.image && s.figure === "6");
    if (!figure)
      throw new Error("Fig.6 原图缺失，使用原页／手选路径补齐再冻结。");
    const caption = excerpt(page(8), "Fig. 6 |", "N AT u RE").text;
    sources.push(
      { ...figure, text: caption, caption },
      excerpt(page(12), "Physical function measurements.", "N AT u RE"),
      excerpt(page(13), "day, mice ran on the treadmill", "Real-time PCR."),
      excerpt(page(13), "Statistical analysis.", "Reporting Summary."),
    );
  }
  const version = digest({ parent: paper.version, caseId, sources });
  return {
    ...paper,
    version,
    scope: `开发诊断 ${caseId}；只提供冻结的相关原文／方法／图注与必要原图，不能声称已读全文。`,
    sources: sources.map((s) => ({ ...s, paperVersion: version })),
  };
}
