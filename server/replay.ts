import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cases } from "../evals/cases.ts";
import { sample } from "../examples/bundle.ts";
import { TaskManager } from "./orchestrator.ts";
import type { Provider } from "./provider.ts";
import { read, save } from "./storage.ts";
import { routes, loadSkills } from "./skills.ts";
import type { TaskRun } from "../shared/types.ts";
interface Result {
  caseId: string;
  split: string;
  baseline: { passed: boolean; findings: string[]; runId?: string };
  candidate: { passed: boolean; findings: string[]; runId?: string };
}
export interface RevisionBatch {
  id: string;
  skillId: string;
  baselineText: string;
  candidateText: string;
  baselineHash: string;
  candidateHash: string;
  mode: "fixture" | "live";
  createdAt: string;
  results: Result[];
  calls: number;
  durationMs: number;
  decision: "pending" | "keep" | "revert";
  note?: string;
  limitations: string[];
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function staticCheck(text: string) {
  const findings: string[] = [];
  if (!/来源|引用/.test(text)) findings.push("缺少来源要求");
  if (!/缺|不足|未知/.test(text)) findings.push("缺少材料不足处理");
  if (!/原理|概念|步骤|测量|基础/.test(text)) findings.push("缺少教学步骤要求");
  return { passed: findings.length === 0, findings };
}
export async function replay(
  input: {
    skillId: string;
    text: string;
    mode: "fixture" | "live";
    caseIds?: string[];
  },
  provider: Provider,
  signal?: AbortSignal,
) {
  if (!Object.values(routes).flat().includes(input.skillId))
    throw new Error("只能比较一个教学模块");
  const baselineText = await readFile(
    `skills/${input.skillId}/SKILL.md`,
    "utf8",
  );
  const start = Date.now();
  const batch: RevisionBatch = {
    id: randomUUID(),
    skillId: input.skillId,
    baselineText,
    candidateText: input.text,
    baselineHash: hash(baselineText),
    candidateHash: hash(input.text),
    mode: input.mode,
    createdAt: new Date().toISOString(),
    results: [],
    calls: 0,
    durationMs: 0,
    decision: "pending",
    limitations:
      input.mode === "fixture"
        ? [
            "静态规则回放，无模型调用，不代表教学效果改善。",
            "案例条件供人工检查，未传入模拟新手；局部证据包不含原图。",
          ]
        : [
            "同模型三角色反馈不构成独立教学评价。",
            "留出案例只作评价，不拼接进角色提示或候选样例。",
          ],
  };
  const selected = cases.filter(
    (c) => !input.caseIds || input.caseIds.includes(c.id),
  );
  const snapshots = new Map(
    await Promise.all(
      [...new Set(selected.map((c) => c.module))].map(
        async (module) => [module, await loadSkills(module)] as const,
      ),
    ),
  );
  for (const test of selected) {
    if (signal?.aborted) {
      batch.limitations.push("用户取消，剩余案例未运行。");
      break;
    }
    if (input.mode === "fixture") {
      batch.results.push({
        caseId: test.id,
        split: test.split,
        baseline: staticCheck(baselineText),
        candidate: staticCheck(input.text),
      });
      continue;
    }
    const execute = async (override?: {
      id: string;
      text: string;
      version: string;
    }) => {
      if (signal?.aborted) return { passed: false, findings: ["回放已取消"] };
      const manager = new TaskManager(provider);
      const snapshot = structuredClone(snapshots.get(test.module)!);
      if (override && snapshot.modules.some((m) => m.id === override.id)) {
        const module = snapshot.modules.find((m) => m.id === override.id)!;
        module.text = override.text;
        module.version = override.version;
        snapshot.versions[override.id] =
          override.version + ":" + hash(override.text).slice(0, 12);
      }
      const run = await manager.start(
        {
          paperId: sample.id,
          module: test.module,
          mode: "live",
          question: test.question,
          profileId: test.profileId,
          sourceIds: test.sourceIds,
          taughtConcepts: [],
        },
        sample,
        override,
        snapshot,
      );
      const cancel = () => void manager.cancel(run.id);
      signal?.addEventListener("abort", cancel, { once: true });
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (["completed", "failed", "cancelled"].includes(run.status)) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
      });
      signal?.removeEventListener("abort", cancel);
      batch.calls += run.calls;
      const findings = [
        ...(run.error ? [run.error] : []),
        ...(run.review?.issues
          .filter((i) => !i.resolved)
          .map((i) => i.suggestion) || []),
        ...(run.novice?.breakpoints
          .filter((b) => b.status === "open")
          .map((b) => b.question) || []),
      ];
      return {
        passed: run.status === "completed" && findings.length === 0,
        findings,
        runId: run.id,
      };
    };
    batch.results.push({
      caseId: test.id,
      split: test.split,
      baseline: await execute(),
      candidate: await execute({
        id: input.skillId,
        text: input.text,
        version: "candidate-" + batch.candidateHash.slice(0, 8),
      }),
    });
    await save("revisions", batch.id, batch);
  }
  if (input.mode === "live") {
    for (const result of batch.results) {
      if (result.baseline.runId && result.candidate.runId) {
        const baseline = await read<TaskRun>("runs", result.baseline.runId),
          candidate = await read<TaskRun>("runs", result.candidate.runId);
        if (
          Object.keys(baseline.skillVersions).some(
            (id) =>
              id !== input.skillId &&
              baseline.skillVersions[id] !== candidate.skillVersions[id],
          )
        ) {
          result.candidate.passed = false;
          result.candidate.findings.push(
            "其他模块版本变化，比较无效，须固定版本回放。",
          );
        }
      }
    }
  }
  batch.durationMs = Date.now() - start;
  await save("revisions", batch.id, batch);
  return batch;
}
export async function decideRevision(
  id: string,
  input: { decision: "keep" | "revert"; note: string },
) {
  const batch = await read<RevisionBatch>("revisions", id);
  if (batch.decision !== "pending") throw new Error("此比较已记录决定");
  if (input.decision === "keep") {
    if (
      batch.results.some((r) => r.baseline.passed && !r.candidate.passed) ||
      !staticCheck(batch.candidateText).passed
    )
      throw new Error("候选存在退步或来源规则缺失，不能保留");
    // Keep an explicit local candidate; publication to project skills requires a reviewed Git change.
    await save("skill-candidates", batch.skillId, {
      id: batch.skillId,
      text: batch.candidateText,
      version: "candidate-" + batch.candidateHash.slice(0, 8),
      batchId: batch.id,
      status: "reviewed-candidate",
    });
  }
  batch.decision = input.decision;
  batch.note = input.note;
  await save("revisions", id, batch);
  return batch;
}
