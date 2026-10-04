import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cases, assistantCases } from "../evals/cases.ts";
import { sample } from "../examples/bundle.ts";
import { TaskManager, cacheKey } from "./orchestrator.ts";
import type { Provider } from "./provider.ts";
import { read, save } from "./storage.ts";
import { routes, loadSkills } from "./skills.ts";
import type { TaskInput, TaskRun } from "../shared/types.ts";
import { evaluateRun, rubricVersion, type EvalResult } from "./evaluation.ts";
interface Result {
  caseId: string;
  split: string;
  baseline: EvalResult;
  candidate: EvalResult;
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
  baselineCalls?: number;
  candidateCalls?: number;
  complete?: boolean;
  caseIds?: string[];
  deferredCaseIds?: string[];
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
  if (input.caseIds?.some((id) => !cases.some((c) => c.id === id)))
    throw new Error("回放案例不存在；主助手合同案例通过 npm test 执行。");
  const baselineText = await readFile(
    `skills/${input.skillId}/SKILL.md`,
    "utf8",
  );
  const start = Date.now();
  const requested = cases.filter((c) =>
    input.caseIds
      ? input.caseIds.includes(c.id)
      : input.mode === "fixture" || routes[c.module].includes(input.skillId),
  );
  if (!requested.length) throw new Error("没有可回放的案例");
  if (input.mode === "live" && input.caseIds && requested.length > 4)
    throw new Error("每批最多四个案例，请分批运行。");
  const selected = input.mode === "live" ? requested.slice(0, 4) : requested;
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
    baselineCalls: 0,
    candidateCalls: 0,
    durationMs: 0,
    decision: "pending",
    complete: false,
    caseIds: selected.map((c) => c.id),
    deferredCaseIds: requested.slice(selected.length).map((c) => c.id),
    limitations:
      input.mode === "fixture"
        ? [
            "静态回放只检查规则完整性，零模型调用；教学内容未评价。",
            `主助手 ${assistantCases.length} 项合同案例由 npm test 执行。`,
          ]
        : [
            "同模型审阅采用具体语义 rubric，保留位置与来源；不代表真实学习效果。",
            "留出条件仅在评价侧使用，不传入教学和新手角色。",
            "基线与候选各最多 32 次调用；候选跳过答案缓存。",
          ],
  };
  const snapshots = new Map(
    await Promise.all(
      [...new Set(selected.map((c) => c.module))].map(
        async (module) => [module, await loadSkills(module)] as const,
      ),
    ),
  );
  await save("revisions", batch.id, batch);
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
    const execute = async (candidate: boolean): Promise<EvalResult> => {
      if (signal?.aborted) return { passed: false, findings: ["回放已取消"] };
      const snapshot = structuredClone(snapshots.get(test.module)!);
      if (candidate) {
        const module = snapshot.modules.find((m) => m.id === input.skillId);
        if (module) {
          module.text = input.text;
          module.version = "candidate-" + batch.candidateHash.slice(0, 8);
          snapshot.versions[module.id] =
            module.version + ":" + hash(module.text).slice(0, 12);
        }
      }
      const task: TaskInput = {
        paperId: sample.id,
        module: test.module,
        mode: "live",
        question: test.question,
        profileId: test.profileId,
        sourceIds: test.sourceIds,
        taughtConcepts: [],
      };
      const baselineKey = hash(
        cacheKey(task, sample, snapshot.versions, provider.model) +
          JSON.stringify({
            rubric: test,
            schema: rubricVersion,
            settings: provider.settings ?? {},
          }),
      );
      if (!candidate) {
        const cacheStart = Date.now();
        try {
          const cached = await read<{ result: EvalResult; run: TaskRun }>(
            "replay-baselines",
            baselineKey,
          );
          if (
            ["completed", "failed"].includes(cached.run.status) &&
            !cached.result.findings.some((f) => /未完成|保存失败|取消/.test(f))
          )
            return {
              ...cached.result,
              reused: true,
              cacheReadMs: Date.now() - cacheStart,
            };
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      const used = candidate ? batch.candidateCalls! : batch.baselineCalls!;
      if (used + 7 > 32)
        return {
          passed: false,
          findings: ["本批剩余额度不足以覆盖当前案例，待评估。"],
        };
      const manager = new TaskManager(provider);
      const combined = signal ?? new AbortController().signal;
      const run = await manager.start(task, sample, undefined, snapshot, {
        signal: combined,
      });
      await manager.wait(run.id);
      const result = await evaluateRun(
        test,
        run,
        sample.sources.filter((s) => test.sourceIds.includes(s.id)),
        provider,
        combined,
      );
      const attempts = run.budget?.attempts.length ?? run.calls;
      if (candidate) batch.candidateCalls! += attempts;
      else batch.baselineCalls! += attempts;
      batch.calls = batch.baselineCalls! + batch.candidateCalls!;
      result.generationCalls = attempts;
      result.durationMs = run.budget!.attempts.reduce(
        (n, a) => n + a.durationMs,
        0,
      );
      result.reused = false;
      if (
        !candidate &&
        run.status === "completed" &&
        result.rubric &&
        !combined.aborted
      )
        await save("replay-baselines", baselineKey, { result, run });
      return result;
    };
    batch.results.push({
      caseId: test.id,
      split: test.split,
      baseline: await execute(false),
      candidate: await execute(true),
    });
    await save("revisions", batch.id, batch);
  }
  batch.durationMs = Date.now() - start;
  batch.complete =
    !signal?.aborted &&
    batch.results.length === selected.length &&
    batch.results.every(
      (r) =>
        input.mode === "fixture" ||
        (!!r.candidate.runId &&
          !!r.baseline.runId &&
          ![r.baseline, r.candidate].some((v) =>
            v.findings.some((f) => /待评估|未完成/.test(f)),
          )),
    );
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
      batch.mode !== "live" ||
      !batch.complete ||
      !batch.results.length ||
      batch.results.some((r) => !r.candidate.passed) ||
      !staticCheck(batch.candidateText).passed
    )
      throw new Error("候选存在退步、未完成内容评价或来源规则缺失，不能保留");
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
