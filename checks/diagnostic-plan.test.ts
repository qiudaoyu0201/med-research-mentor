import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnosticManifest,
  diagnosticTiming,
} from "../server/model-diagnostic.ts";
import {
  diagnosticPlanAssessment,
  runDiagnosticPlan,
} from "../server/diagnostic-plan.ts";
import type { Provider } from "../server/provider.ts";
import type { PaperBundle } from "../shared/types.ts";

const paper: PaperBundle = {
  id: "fixture",
  title: "Local",
  version: "1",
  scope: "test",
  sources: [
    {
      id: "evidence",
      kind: "paper",
      title: "Evidence",
      text: "This is a local source.",
      locator: "Figure 1",
      verified: true,
    },
  ],
};
const manifest = diagnosticManifest.parse({
  id: "sol-plan-test",
  model: "gpt-6.1-sol",
  parentReport: "parent.json",
  paperPath: "paper.json",
  module: "research-plan",
  question: "比较测量和对照",
  sourceIds: ["evidence"],
  criteria: ["事实", "取舍", "限制"],
  onlineUrl: "http://127.0.0.1:4336",
  plan: {
    conditions: "检测设备未知",
    studyTypes: ["basic-translational"],
    revision: {
      conditions: "只能观察形态",
      instruction: "根据实际设备修订，保留目标与未知。",
    },
  },
});
const content = {
  title: "方案草案",
  sections: [
    {
      id: "design",
      title: "测量与对照",
      text: "拟比较。",
      rationale: "区分解释。",
      kind: "proposal",
      sourceRefs: [],
      unknowns: ["条件待确认"],
    },
  ],
  assumptions: [],
  questions: [],
  limitations: ["没有实测结果。"],
};
const review = {
  issues: [],
  checkedSourceRefs: [],
  limitations: ["局部检查。"],
};
function harness(outputs: unknown[] = [content, review, content, review]) {
  const inputs: any[] = [],
    records = new Map<string, any>();
  const provider: Provider = {
    id: "fixture",
    model: "fixture",
    async generate(_instructions, input, schema, signal) {
      signal.throwIfAborted();
      inputs.push(structuredClone(input));
      const output = outputs.shift();
      if (output instanceof Error) throw output;
      return { output: schema.parse(output) };
    },
  };
  const options = {
    provider,
    manifest,
    paper,
    signal: new AbortController().signal,
    persist: async (group: string, id: string, value: unknown) => {
      records.set(group + "/" + id, structuredClone(value));
    },
    progress: async (_value: { planId: string; jobIds: string[] }) => {},
  };
  return { options, inputs, records };
}
test("plan diagnostics require explicit conditions and cannot silently enter another module", () => {
  const { plan, ...rest } = manifest;
  assert.equal(diagnosticManifest.safeParse(rest).success, false);
  assert.equal(
    diagnosticManifest.safeParse({ ...manifest, module: "paper" }).success,
    false,
  );
  assert.equal(
    diagnosticManifest.safeParse({
      ...manifest,
      sourceIds: Array.from({ length: 13 }, (_, i) => String(i)),
    }).success,
    false,
  );
});
test("plan pilot uses real generation/review twice, binds sources, preserves history and restores local timing", async () => {
  const h = harness();
  const before = process.env.TUTOR_INTERNAL_REQUEST_MS;
  const result = await runDiagnosticPlan(h.options);
  assert.equal(h.inputs.length, 4);
  assert.deepEqual(
    result.jobs.map((j) => j.budget.attempts.length),
    [2, 2],
  );
  assert.ok(
    result.jobs.every(
      (j) => j.budget.timing?.requestMs === diagnosticTiming.requestMs,
    ),
  );
  assert.equal(
    result.plan.versions[0].topic.conditions,
    manifest.plan!.conditions,
  );
  assert.equal(
    result.plan.versions[1].topic.conditions,
    manifest.plan!.revision.conditions,
  );
  assert.equal(result.plan.versions[1].parentId, result.plan.versions[0].id);
  assert.equal(
    result.plan.versions[0].topic.sources[0].excerpt,
    paper.sources[0].text,
  );
  assert.deepEqual(
    h.inputs[2].original.sections[0].text,
    content.sections[0].text,
  );
  assert.equal(result.assessment.strictPassed, true);
  assert.equal(result.sources[0].id, result.plan.topic.sources[0].id);
  assert.equal(process.env.TUTOR_INTERNAL_REQUEST_MS, before);
  const warned = structuredClone(result.plan);
  warned.versions[0].review!.issues.push({
    id: "warning",
    sectionId: "design",
    severity: "warning",
    message: "解释仍有缺口",
    evidence: [],
    status: "open",
  });
  const revisedAssessment = diagnosticPlanAssessment(warned, result.jobs);
  assert.equal(revisedAssessment.mainlinePassed, true);
  assert.equal(
    revisedAssessment.strictPassed,
    true,
    "A warning from an earlier version is superseded when the final version resolves it.",
  );
  assert.equal(revisedAssessment.unresolvedIssues.length, 0);
  assert.equal(revisedAssessment.supersededIssues.length, 1);
  const finalWarning = structuredClone(result.plan);
  finalWarning.versions[1].review!.issues.push({
    id: "final-warning",
    sectionId: "design",
    severity: "warning",
    message: "最终版本仍有缺口",
    evidence: [],
    status: "open",
  });
  assert.equal(
    diagnosticPlanAssessment(finalWarning, result.jobs).strictPassed,
    false,
    "An unresolved final-version warning still fails strict assessment.",
  );
  const unbound = structuredClone(result.plan);
  unbound.versions[1].jobId = "wrong";
  assert.equal(
    diagnosticPlanAssessment(unbound, result.jobs).mainlinePassed,
    false,
  );
});
test("plan pilot never retries a failed generation or runs its resource revision", async () => {
  const h = harness([new Error("request unknown")]);
  const before = process.env.TUTOR_INTERNAL_IDLE_MS;
  await assert.rejects(runDiagnosticPlan(h.options), /unknown/);
  assert.equal(h.inputs.length, 1);
  assert.equal(
    [...h.records.keys()].filter((k) => k.startsWith("research-plan-jobs/"))
      .length,
    1,
  );
  assert.equal(process.env.TUTOR_INTERNAL_IDLE_MS, before);
});
test("progress persistence failure cancels and waits for the launched plan job", async () => {
  const h = harness();
  let progress = 0;
  h.options.progress = async () => {
    if (++progress === 2) throw new Error("progress write failed");
  };
  await assert.rejects(runDiagnosticPlan(h.options), /progress write failed/);
  const jobs = [...h.records.entries()].filter(([key]) =>
    key.startsWith("research-plan-jobs/"),
  );
  assert.equal(jobs.length, 1);
  assert.ok(["cancelled", "completed"].includes(jobs[0][1].status));
  assert.ok(h.inputs.length <= 2);
});

test("complete plan diagnostics honor scope and depth and retain repaired drafts as history", async () => {
  const blocked = {
    ...review,
    issues: [
      {
        id: "missing",
        sectionId: "design",
        severity: "blocking",
        message: "需要补全测量流程",
        evidence: [],
      },
    ],
  };
  const h = harness([content, blocked, content, review, content, review]);
  h.options.manifest = diagnosticManifest.parse({
    ...manifest,
    callLimit: 16,
    plan: {
      ...manifest.plan,
      requestedScope: "full-plan",
      verbosity: "deep",
      maxCalls: 4,
    },
  });
  const result = await runDiagnosticPlan(h.options);
  assert.equal(h.inputs.length, 6);
  assert.equal(result.plan.versions.length, 3);
  assert.equal(result.artifact.versions.length, 2);
  assert.ok(
    result.jobs.every((job) => job.context.requestedScope === "full-plan"),
  );
  assert.equal(result.plan.topic.learningPreferences.verbosity, "deep");
  assert.equal(result.assessment.strictPassed, true);
  assert.equal(result.plan.versions[0].review!.status, "issues");
  assert.equal(result.jobs[0].budget.attempts.length, 4);
  const broken = structuredClone(result.plan);
  broken.versions[1].parentId = null;
  assert.equal(
    diagnosticPlanAssessment(broken, result.jobs).mainlinePassed,
    false,
  );
});
