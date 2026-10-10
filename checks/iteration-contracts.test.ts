import test from "node:test";
import assert from "node:assert/strict";
import {
  comparisonUpperBound,
  iterationUsage,
  reserveIterationUnit,
  developmentPassed,
  type IterationQuota,
} from "../server/training-protocol.ts";
import { trainingCases } from "../evals/internal-training-cases.ts";
import {
  explanationCandidateRules,
  type TrainingBatch,
} from "../server/internal-training.ts";
import {
  freezeRules,
  withRuleSnapshot,
  loadSkills,
  teachingContract,
} from "../server/skills.ts";
import {
  revisionTrace,
  revisionAuditInput,
  type TeachingArtifact,
} from "../server/revision-trace.ts";
import {
  lessonExposure,
  assertLearningGate,
  assertIndependentTarget,
  learningImage,
} from "../server/learning-exposure.ts";
import {
  cloneOpenLearner,
  exposureVersion,
  openLearnerView,
  answerOpenTask,
} from "../server/internal-learner.ts";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { BudgetLedger } from "../server/budget.ts";
import { TaskManager, cacheKey } from "../server/orchestrator.ts";
import { sample, exampleUnits } from "../examples/bundle.ts";
import type { TaskInput } from "../shared/types.ts";
import type { Provider } from "../server/provider.ts";
import { validateExplanationLinks } from "../server/explanation-links.ts";
import { createServer } from "node:http";
import { trainingAdmission } from "../server/training-admission.ts";

const quota: IterationQuota = {
  version: "iteration-v1.1-70x3",
  cycle: 2,
  historicalAttempts: 44,
  priorProductAttempts: 70,
  previousReportHash: "a".repeat(64),
  originReportHash: "b".repeat(64),
};
const batch = (calls: number): TrainingBatch => {
  const budget = new BudgetLedger("fixture", async () => {}).state;
  budget.attempts = Array.from(
    { length: calls },
    (_, i) => ({ id: `call-${i}`, status: "unknown" }) as never,
  );
  return { id: "fixture", phase: "M1", status: "stopped", budget };
};
test("training yields to online work and rejects ambiguous admission responses without model dispatch", async () => {
  let state: unknown = { busy: true };
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Connection", "close");
    response.end(JSON.stringify(state));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(trainingAdmission(base), /用户任务/);
    state = { busy: false };
    const admission = await trainingAdmission(base);
    assert.equal(admission.online, "idle");
    assert.ok(admission.freeMemory > 0);
    state = { pending: 0 };
    await assert.rejects(trainingAdmission(base), /不明确/);
    await assert.rejects(trainingAdmission("https://example.com"), /本机/);
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
  assert.equal((await trainingAdmission(base)).online, "offline");
});
test("new quota conservatively counts unknown dispatches without enlarging the old allowance", () => {
  assert.equal(iterationUsage(quota, [batch(64)]).combined, 178);
  reserveIterationUnit(quota, [batch(64)], 6);
  assert.throws(() => reserveIterationUnit(quota, [batch(64)], 10));
  assert.throws(() => iterationUsage({ ...quota, cycle: 4 }, []));
  assert.throws(() => iterationUsage({ ...quota, historicalAttempts: 0 }, []));
  const duplicate = batch(2);
  duplicate.budget.attempts[1].id = "call-0";
  assert.throws(() => iterationUsage(quota, [duplicate]), /重复/);
});
test("frozen ordinary routes reserve a whole comparison, with 40 development and 30 holdout calls", () => {
  assert.deepEqual(
    trainingCases.map(comparisonUpperBound),
    [10, 14, 10, 14, 10, 6],
  );
  assert.equal(
    6 +
      trainingCases
        .filter((c) => c.split === "development")
        .reduce((n, c) => n + comparisonUpperBound(c), 0),
    40,
  );
  assert.equal(
    trainingCases
      .filter((c) => c.split === "holdout")
      .reduce((n, c) => n + comparisonUpperBound(c), 0),
    30,
  );
  const results = ["D1", "D2", "D3"].map((id) => ({
    id,
    side: "candidate",
    status: "generated",
    evaluation: { valid: true, passed: true },
  }));
  assert.equal(developmentPassed(results), true);
  results[1].evaluation.valid = false;
  assert.equal(developmentPassed(results), false);
});
test("new candidate changes generation only; concurrent online and evaluator rules remain the active baseline", async () => {
  const baseline = await freezeRules(),
    candidate = explanationCandidateRules(baseline);
  const [a, b, online] = await Promise.all([
    withRuleSnapshot(candidate, async () => ({
      contract: teachingContract(),
      skills: await loadSkills("ppt"),
    })),
    withRuleSnapshot(baseline, async () => ({
      contract: teachingContract(),
      skills: await loadSkills("ppt"),
    })),
    loadSkills("ppt"),
  ]);
  assert.ok(a.contract.length > 0);
  assert.equal(b.contract, "");
  assert.deepEqual(a.skills.modules, b.skills.modules);
  assert.equal(a.skills.shared, online.shared);
  assert.equal(online.teachingContract, "");
  const input: TaskInput = {
    paperId: sample.id,
    module: "paper",
    mode: "live",
    question: "解释对照",
    profileId: "beginner",
    sourceIds: sample.sources.map((s) => s.id),
    taughtConcepts: [],
  };
  assert.notEqual(
    cacheKey(input, sample, a.skills.versions, "fixture"),
    cacheKey(input, sample, b.skills.versions, "fixture"),
  );
});
for (const tracing of [true, "compact-v1"] as const)
  test(`actual generation and revision receive ${tracing} candidate while checks only receive source-backed revision changes`, async () => {
    const baseline = await freezeRules(),
      candidate = explanationCandidateRules(baseline, tracing);
    const first = structuredClone(exampleUnits.paper),
      revised = structuredClone(first);
    revised.sections[0].text += " 修订后的比较以实际对照为参照。";
    const feedback = { understood: [], breakpoints: [] };
    const check = {
      issues: [
        {
          id: "gap",
          location: first.sections[0].title,
          type: "teaching",
          evidence: ["xu-design"],
          suggestion: "解释比较参照",
          severity: "warning",
          resolved: false,
        },
      ],
      checkedSources: ["xu-design"],
      limitations: [],
    };
    const outputs = [
      {
        unit: first,
        deck: null,
        explanationLinks: [
          {
            purpose: "comparison",
            goal: "解释比较",
            sourceIds: ["xu-design"],
            evidenceQuote: sample.sources
              .find((s) => s.id === "xu-design")!
              .text.slice(0, 16),
            sourceQuote: sample.sources
              .find((s) => s.id === "xu-design")!
              .text.slice(0, 16),
            artifactAnchor: first.sections[0].text.slice(0, 40),
            artifactLocation: "unit.sections.0.text",
            explanation: first.sections[0].text.slice(0, 80),
            gap: null,
          },
        ],
      },
      feedback,
      check,
      {
        unit: revised,
        deck: null,
        explanationLinks: [
          {
            purpose: "comparison",
            goal: "解释比较",
            sourceIds: ["xu-design"],
            evidenceQuote: sample.sources
              .find((s) => s.id === "xu-design")!
              .text.slice(0, 16),
            sourceQuote: sample.sources
              .find((s) => s.id === "xu-design")!
              .text.slice(0, 16),
            artifactAnchor: revised.sections[0].text.slice(0, 40),
            artifactLocation: "unit.sections.0.text",
            explanation: revised.sections[0].text.slice(0, 80),
            gap: null,
          },
        ],
      },
      feedback,
      { ...check, issues: [] },
    ];
    const calls: { instructions: string; input: any }[] = [];
    const provider: Provider = {
      model: "fixture",
      async generate(instructions, input, schema) {
        calls.push({ instructions, input: structuredClone(input) });
        return { output: schema.parse(outputs.shift()) };
      },
    };
    const manager = new TaskManager(provider, async () => {});
    const run = await withRuleSnapshot(candidate, () =>
      manager.start(
        {
          paperId: sample.id,
          module: "paper",
          mode: "live",
          question: "解释对照",
          profileId: "beginner",
          sourceIds: sample.sources.map((s) => s.id),
          taughtConcepts: [],
        },
        sample,
      ),
    );
    await manager.wait(run.id);
    assert.equal(run.status, "completed", run.error);
    assert.equal(calls.length, 6);
    assert.ok(calls[0].instructions.includes(candidate.teachingContract!));
    assert.ok(calls[3].instructions.includes(candidate.teachingContract!));
    assert.equal(
      calls[2].instructions.includes(candidate.teachingContract!),
      false,
    );
    assert.equal(
      calls[5].instructions.includes(candidate.teachingContract!),
      false,
    );
    assert.deepEqual(calls[3].input.revisionEvidence.verifiedSourceIds, [
      "xu-design",
    ]);
    assert.ok(
      calls[5].input.revisionAudit.changes.some(
        (c: any) => c.location === "unit.sections.0.text",
      ),
    );
    assert.equal("revisionTrace" in run.result!, false);
    assert.equal("explanationLinks" in run.result!, false);
    assert.equal(
      JSON.stringify(calls[1].input).includes('"explanationLinks"'),
      false,
    );
    assert.equal(
      JSON.stringify(calls[2].input).includes('"explanationLinks"'),
      false,
    );
    assert.ok((run.explanationTrace as { links: unknown[] }).links.length > 0);
    assert.ok(run.revisionTrace);
  });
test("revision audit locates changed references and formulas, keeps both drafts, and permits evidence-backed correction", () => {
  const artifact = (text: string): TeachingArtifact => ({
    unit: {
      title: "观察",
      question: "参照是什么",
      sections: [{ title: "归一化", text, kind: "paper", citations: ["s"] }],
      terms: [],
      nextQuestion: "",
    },
    deck: null,
  });
  const sources = [
    {
      id: "s",
      kind: "paper" as const,
      title: "图1",
      locator: "Figure 1",
      text: "参照为 100%，分母为同背景对照。",
      verified: true,
    },
  ];
  const review = { issues: [], checkedSources: ["s"], limitations: [] };
  const before = artifact("对照为 100%。"),
    after = artifact("对照为 0%，公式为 x / control - 1。");
  const trace = revisionTrace(before, after, sources, review, "参照是什么");
  assert.notEqual(trace.beforeHash, trace.afterHash);
  assert.equal(trace.changes[0].location, "unit.sections.0.text");
  assert.equal(trace.changes[0].sensitive, true);
  assert.equal(trace.evidence.locations[0].sourceIds[0], "s");
  after.unit.sections[0].text = "改动";
  assert.match(trace.after.unit.sections[0].text, /0%/);
  assert.equal("after" in revisionAuditInput(trace), false);
  assert.equal(
    revisionTrace(trace.after, before, sources, review, "参照是什么").afterHash,
    trace.beforeHash,
  );
  assert.throws(
    () => revisionTrace(before, before, [], review, "参照是什么"),
    /不可见/,
  );
});
test("learning materials bind to the actual case; controls share exposure and failed teaching is withheld", () => {
  const source = [{ id: "actual", text: "当前课题可见材料", locator: "第1页" }];
  const products = ["baseline", "candidate"].map((side) => ({
    id: "D3",
    side,
    status: "generated",
    sources: source,
    artifact: [{ content: "实际设计" }],
    evaluation: { valid: true, passed: true },
  }));
  const a = lessonExposure(products, "D3", "baseline"),
    b = lessonExposure(products, "D3", "candidate");
  assert.deepEqual(a.material, b.material);
  assert.match(a.material.text, /当前课题/);
  products[0].status = "failed";
  assert.equal(lessonExposure(products, "D3", "baseline").teaching, null);
  products[1].sources = [{ ...source[0], text: "另一材料" }];
  assert.throws(() => lessonExposure(products, "D3", "candidate"), /材料不同/);
  assert.throws(() => assertLearningGate(products, true), /未完成/);
});
test("target input rejects hidden answers and overlap without sending a model request", () => {
  const task = {
    id: "target",
    kind: "design-draft" as const,
    question: "新问题",
    sources: [],
  };
  assertIndependentTarget(task, [{ question: "旧问题", study: "old" }], "new");
  assert.throws(
    () =>
      assertIndependentTarget(
        task,
        [{ question: "旧问题", study: "new" }],
        "new",
      ),
    /重叠/,
  );
  assert.throws(
    () =>
      assertIndependentTarget(
        { ...task, answer: "答案" } as typeof task,
        [],
        "new",
      ),
    /答案/,
  );
});
test("learning branches preserve actual prior images, show the same target, and audit image provenance without embedding pixels in text", async () => {
  const bitmap = (width: number, height: number, color: string) => {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/png");
  };
  const priorImage = bitmap(4, 6, "red"),
    target = bitmap(8, 10, "blue");
  const products = ["baseline", "candidate"].map((side) => ({
    id: "D1",
    side,
    status: "generated",
    sources: [{ id: "prior-figure", text: "实际图件", locator: "图1" }],
    run: { input: { visibleImage: priorImage } },
    artifact: { deck: { slides: [] } },
    evaluation: { valid: true, passed: true },
  }));
  const exposure = lessonExposure(products, "D1", "candidate");
  const initial = {
    id: "initial",
    version: 0,
    profile: { id: "novice", version: "1", background: "新手", concepts: [] },
    concepts: [],
    visible: [],
    observations: [],
  };
  const unlearned = cloneOpenLearner(
    initial,
    "unlearned",
    "unlearned",
    [exposure.material],
    [],
  );
  const materials = cloneOpenLearner(
    initial,
    "materials",
    "materials",
    [exposure.material],
    [],
  );
  assert.equal(await learningImage(unlearned, target), target);
  const merged = await learningImage(materials, target);
  const decoded = await loadImage(merged!);
  assert.deepEqual([decoded.width, decoded.height], [8, 88]);
  const canvas = createCanvas(8, 88),
    context = canvas.getContext("2d");
  context.drawImage(decoded, 0, 0);
  assert.deepEqual(
    [...context.getImageData(3, 41, 1, 1).data],
    [255, 0, 0, 255],
  );
  assert.deepEqual(
    [...context.getImageData(7, 87, 1, 1).data],
    [0, 0, 255, 255],
  );
  const task = {
    id: "target",
    kind: "report-outline" as const,
    question: "读图",
    sources: [{ id: "target-figure", text: "目标图件", locator: "图2" }],
  };
  assert.equal(
    JSON.stringify(openLearnerView(materials, task)).includes(priorImage),
    false,
  );
  assert.throws(
    () =>
      cloneOpenLearner(
        initial,
        "tampered",
        "materials",
        [{ ...exposure.material, image: target }],
        [],
      ),
    /版本/,
  );
  assert.equal(
    exposure.material.versionHash,
    exposureVersion({
      text: exposure.material.text,
      image: priorImage,
      sourceIds: ["prior-figure"],
    }),
  );
  let receivedImage: string | undefined;
  const observation = await answerOpenTask(
    {
      model: "fixture",
      async generate(_rules, _input, schema, _signal, image) {
        receivedImage = image;
        return {
          output: schema.parse({
            text: "基于可见原图作答",
            questions: [],
            usedVisibleIds: ["prior-figure", "target-figure"],
          }),
        };
      },
    },
    materials,
    task,
    new AbortController().signal,
    async () => {},
    merged,
  );
  assert.equal(receivedImage, merged);
  assert.deepEqual(observation.unsupportedVisibleIds, []);
  products[1].run.input.visibleImage = target;
  assert.throws(() => lessonExposure(products, "D1", "candidate"), /图件不同/);
});
test("source-to-explanation contract rejects invented quotations, fake paths and a PPT explanation placed only in the auxiliary unit", () => {
  const source = sample.sources[0],
    text = "解释实际比较的目的。";
  const link = {
    purpose: "comparison",
    goal: "比较理由",
    sourceIds: [source.id],
    evidenceQuote: source.text.slice(0, 16),
    artifactLocation: "deck.slides.0.notes",
    explanation: text,
    gap: null,
  };
  const artifact = {
    unit: { sections: [{ text }] },
    deck: { slides: [{ notes: text }] },
    explanationLinks: [link],
  };
  assert.equal(
    validateExplanationLinks(artifact, [source], "比较理由", "ppt").length,
    1,
  );
  for (const change of [
    { evidenceQuote: "编造的原文" },
    { sourceIds: ["bogus"] },
    { artifactLocation: "deck.slides.8.notes" },
    { artifactLocation: "unit.sections.0.text" },
    { explanation: "只存在于内部记录" },
  ]) {
    assert.throws(() =>
      validateExplanationLinks(
        { ...artifact, explanationLinks: [{ ...link, ...change }] },
        [source],
        "比较理由",
        "ppt",
      ),
    );
  }
  const baseline = [
    {
      id: "D1",
      side: "baseline",
      status: "generated",
      sources: [{ id: "s", text: "原文", locator: "p1" }],
      artifact: { unit: {}, feedback: { understood: ["答案"] } },
      evaluation: { valid: true, passed: true },
    },
  ];
  assert.throws(
    () =>
      lessonExposure(
        [...baseline, { ...baseline[0], side: "candidate" }],
        "D1",
        "baseline",
      ),
    /工作记录/,
  );
});
