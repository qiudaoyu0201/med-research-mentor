import { randomUUID } from "node:crypto";
import { ResearchPlans } from "./research-plans.ts";
import { TaskScheduler } from "./scheduler.ts";
import {
  diagnosticTiming,
  type DiagnosticManifest,
} from "./model-diagnostic.ts";
import {
  planVersionReady,
  type PlanJob,
  type ResearchPlan,
} from "../shared/research-plan.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { Provider } from "./provider.ts";

export function diagnosticPlanAssessment(plan: ResearchPlan, jobs: PlanJob[]) {
  // A complete job and a saved version alone are not a quality pass.
  const complete =
    jobs.length === 2 && jobs.every((j) => j.status === "completed");
  const bound =
    plan.versions.length === 2 &&
    plan.versions.every(
      (version, index) =>
        version.jobId === jobs[index]?.id &&
        version.id === jobs[index]?.resultVersion &&
        (index === 0
          ? version.parentId === null
          : version.parentId === plan.versions[0].id),
    );
  const issues = plan.versions.flatMap((v) => v.review?.issues ?? []);
  const mainlinePassed =
    complete && bound && plan.versions.every(planVersionReady);
  return {
    runStatus: complete ? "completed" : "failed",
    mainlinePassed,
    strictPassed: mainlinePassed && issues.length === 0,
    unresolvedIssues: issues,
    breakpoints: null,
    scope:
      "方案生成、条件变更、修订及来源核验；没有模拟新手复读，不声称真人效果。",
  };
}

export async function runDiagnosticPlan(options: {
  provider: Provider;
  manifest: DiagnosticManifest;
  paper: PaperBundle;
  signal: AbortSignal;
  persist: (group: string, id: string, value: unknown) => Promise<void>;
  progress: (value: { planId: string; jobIds: string[] }) => Promise<void>;
}) {
  const { manifest, paper, provider, signal, persist, progress } = options;
  if (manifest.module !== "research-plan" || !manifest.plan)
    throw new Error("研究方案诊断配置缺失。");
  const settings = manifest.plan;
  // Private process settings only; use the same generous pilot protection as the batch.
  // Restored even on cancellation/failure. No online configuration is written.
  const environment: Record<string, string> = {
    TUTOR_RECORDING_PREPARED: "false",
    TUTOR_INTERNAL_TASK_MS: String(diagnosticTiming.taskMs),
    TUTOR_INTERNAL_REQUEST_MS: String(diagnosticTiming.requestMs),
    TUTOR_INTERNAL_FIRST_OUTPUT_MS: String(diagnosticTiming.firstOutputMs),
    TUTOR_INTERNAL_IDLE_MS: String(diagnosticTiming.idleMs),
    TUTOR_INTERNAL_TARGET_TASK_MS: String(diagnosticTiming.targetTaskMs),
    TUTOR_INTERNAL_TARGET_REQUEST_MS: String(diagnosticTiming.targetRequestMs),
    TUTOR_INTERNAL_TARGET_FIRST_OUTPUT_MS: String(
      diagnosticTiming.targetFirstOutputMs,
    ),
    TUTOR_INTERNAL_TARGET_IDLE_MS: String(diagnosticTiming.targetIdleMs),
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  try {
    const manager = new ResearchPlans(
      provider,
      async (id) => {
        if (id !== paper.id) throw new Error("诊断只能读取冻结论文。");
        return structuredClone(paper);
      },
      new TaskScheduler(),
      persist,
      async () => {
        throw new Error("诊断不删除记录。");
      },
      undefined,
      "internal",
    );
    const topic = {
      question: manifest.question,
      conditions: settings.conditions,
      studyTypes: settings.studyTypes,
      typeStatus: "provisional",
      sources: manifest.sourceIds.map((sourceId) => ({
        paperId: paper.id,
        sourceVersion: paper.version,
        sourceId,
      })),
      learningPreferences: {
        verbosity: "standard",
        focus: "research-reasoning",
      },
    };
    const jobs: PlanJob[] = [],
      jobIds: string[] = [];
    let plan = await manager.create(topic);
    const stage = async (
      action: "generate" | "revise",
      instruction: string,
    ) => {
      signal.throwIfAborted();
      const job = await manager.start(
        plan.id,
        {
          requestKey: randomUUID(),
          expectedVersion: plan.currentVersion,
          expectedTopicVersion: plan.topic.version,
          action,
          instruction,
          requestedScope: "design-draft",
          maxCalls: 2,
          retrieveLiterature: false,
        },
        { signal },
      );
      jobIds.push(job.id);
      let finished: PlanJob;
      try {
        await progress({ planId: plan.id, jobIds: [...jobIds] });
        finished = await manager.wait(job.id);
      } catch (error) {
        await manager.cancel(job.id);
        throw error;
      }
      jobs.push(finished);
      if (finished.status !== "completed")
        throw new Error(finished.error ?? "研究方案诊断未完成；不重发。");
      plan = manager.get(plan.id);
    };
    await progress({ planId: plan.id, jobIds });
    await stage(
      "generate",
      "给出能用于讨论的简短设计草案，说明必要测量与对照的作用，以及结论边界。缺条件保留未知，不补造参数或结果。",
    );
    const original = structuredClone(plan.versions[0]);
    plan = await manager.updateTopic(plan.id, plan.topic.version, {
      ...topic,
      conditions: settings.revision.conditions,
    });
    await stage("revise", settings.revision.instruction);
    if (JSON.stringify(original) !== JSON.stringify(plan.versions[0]))
      throw new Error("修订改写了历史版本，不能标记通过。");
    return {
      plan,
      jobs,
      assessment: diagnosticPlanAssessment(plan, jobs),
      roleMetrics: jobs.flatMap((job, stage) =>
        job.budget.attempts.map((a) => ({
          id: a.id,
          stage: stage === 0 ? "generate" : "revise",
          role: a.role,
          status: a.status,
          durationMs: a.durationMs,
          outputChars: a.outputChars,
          meaningfulChars: a.rawOutput?.trimEnd().length ?? null,
          timing: a.timing,
          observation: a.observation,
        })),
      ),
      artifact: {
        versions: plan.versions.map((v) => ({
          topic: { question: v.topic.question, conditions: v.topic.conditions },
          content: v.content,
        })),
      },
      sources: plan.topic.sources.map((s) => ({
        id: s.id,
        text: s.excerpt,
        locator: s.locator,
      })),
    };
  } finally {
    for (const key of Object.keys(environment)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}
