import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { BudgetLedger } from "../server/budget.ts";
import { ProviderFailure, type Provider } from "../server/provider.ts";
import {
  TrainingProvider,
  assertContinuation,
  reserveUnit,
  validateReview,
  reviewArtifact,
  type TrainingBatch,
  candidateRules,
  factualCriterion,
  feedbackCandidate,
} from "../server/internal-training.ts";
import {
  freezeRules,
  withRuleSnapshot,
  loadSkills,
  sharedRules,
} from "../server/skills.ts";
import { readFile } from "node:fs/promises";
import { ResearchPlans } from "../server/research-plans.ts";
import { trainingCost } from "../server/training-cost.ts";
const batch = (): TrainingBatch => ({
  id: "training",
  phase: "M1",
  status: "running",
  budget: new BudgetLedger("training", async () => {}, undefined, 45 * 60_000)
    .state,
});
test("training counts failed and unknown dispatches, saves inputs before provider, stops unknown continuation", async () => {
  const b = batch();
  b.budget.limit = 24;
  b.budget.groupLimit = 24;
  const order: string[] = [];
  const inner: Provider = {
    model: "fixture",
    async generate() {
      order.push("dispatch");
      throw new ProviderFailure("unknown", "transport");
    },
  };
  const provider = new TrainingProvider(
    inner,
    b,
    async () => {
      order.push("persist");
    },
    async () => {
      order.push("input");
    },
    () => b.budget.attempts.length,
  );
  await assert.rejects(
    provider.generate(
      "rules",
      {},
      z.object({ text: z.string() }),
      new AbortController().signal,
    ),
  );
  assert.deepEqual(order.slice(0, 3), ["persist", "input", "dispatch"]);
  assert.equal(b.budget.attempts.length, 1);
  assert.equal(b.budget.attempts[0].status, "unknown");
  assert.equal(b.status, "stopped");
  const cost = trainingCost([b], 28);
  assert.equal(cost.firstRoundAttempts, 29);
  assert.equal(cost.remainingProductAttempts, 79);
  assert.equal(cost.statuses.unknown, 1);
  assert.deepEqual(cost.tokens.total, {
    reportedSum: null,
    reportedAttempts: 0,
    unreportedAttempts: 1,
  });
  assert.throws(() => assertContinuation([b]));
  await assert.rejects(
    provider.generate(
      "rules",
      {},
      z.object({ text: z.string() }),
      new AbortController().signal,
    ),
  );
  assert.equal(order.filter((s) => s === "dispatch").length, 1);
});
test("training stops before an unaffordable whole pair and preserves consumed cycle quota", () => {
  const b = batch();
  b.budget.limit = 24;
  b.budget.groupLimit = 24;
  reserveUnit(b, 14, 6);
  assert.throws(() => reserveUnit(b, 16, 6)); // 48 + 2 minutes cannot fit a 45-minute batch.
  assert.throws(() => reserveUnit(b, 16, 100));
  b.budget.deadline = new Date(Date.now() + 1000).toISOString();
  assert.throws(() => reserveUnit(b, 16, 0));
});
test("independent evaluator rejects bogus locations, missing, duplicate and unknown criteria even on negative judgments", () => {
  const check = {
    criterion: "boundary",
    passed: false,
    location: "真实句子",
    sourceIds: ["s"],
    explanation: "错误",
  };
  const valid = validateReview(["boundary"], { text: "真实句子" }, ["s"], {
    checks: [check],
  });
  assert.equal(valid.findings.length, 1);
  for (const checks of [
    [],
    [check, check],
    [{ ...check, location: "编造句子" }],
    [{ ...check, sourceIds: ["bogus"] }],
    [{ ...check, criterion: "unknown" }],
  ]) {
    const result = validateReview(["boundary"], { text: "真实句子" }, ["s"], {
      checks,
    });
    assert.equal(result.passed, false);
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((f) => /无效|缺少|重复|未知/.test(f)));
  }
});
test("independent review request binds the fixed criteria verbatim and keeps invalid judgments invalid", async () => {
  const criteria = ["比较 A 与 B", "保留 生存边界"];
  const check = {
    criterion: criteria[0],
    passed: true,
    location: "真实句子",
    sourceIds: ["s"],
    explanation: "与提供的来源相符",
  };
  const checks = [check, { ...check, criterion: criteria[1] }];
  let calls = 0;
  const provider: Provider = {
    model: "fixture",
    async generate(_instructions, _input, schema) {
      calls += 1;
      const parse = (value: unknown) => schema.safeParse(value).success;
      assert.equal(parse({ evaluations: checks }), false);
      assert.equal(
        parse({ checks: [{ ...check, criterion: "比较A与B" }, checks[1]] }),
        false,
      );
      assert.equal(parse({ checks: [check] }), false);
      assert.equal(parse({ checks: [...checks, check] }), false);
      return { output: schema.parse({ checks }) };
    },
  };
  const result = await reviewArtifact(
    provider,
    {
      question: "比较设计与边界",
      conditions: "只用当前材料",
      criteria,
      artifact: { text: "真实句子" },
      sources: [{ id: "s", text: "真实证据", locator: "原文" }],
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.review.checks.map((c) => c.criterion),
    criteria,
  );
  const invalid = validateReview(criteria, { text: "真实句子" }, ["s"], {
    checks: [{ ...check, criterion: "比较A与B" }, checks[1]],
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.passed, false);
  const duplicated = validateReview(criteria, { text: "真实句子" }, ["s"], {
    checks: [check, check],
  });
  assert.equal(duplicated.valid, false);
});
test("evaluator location accepts presentation quotes while retaining substantive artifact binding", () => {
  const check = {
    criterion: "boundary",
    passed: false,
    location: "真实句子",
    sourceIds: ["s"],
    explanation: "错误",
  };
  const result = validateReview(["boundary"], { text: "这是一个真实句子。" }, ["s"], {
    checks: [{ ...check, location: "“这是一个真实句子。”" }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  const bad = validateReview(["boundary"], { text: "这是一个真实句子。" }, ["s"], {
    checks: [{ ...check, location: "“这是另一个句子。”" }],
  });
  assert.equal(bad.valid, false);
  for (const location of ["“”", "\n", "\"\""]) {
    assert.equal(validateReview(["boundary"], { text: "真实句子" }, ["s"], {
      checks: [{ ...check, location }],
    }).valid, false);
  }
});
test("factual evaluation needs actual citations and omissions cannot default to passing", () => {
  const check = {
    criterion: factualCriterion,
    passed: true,
    location: "观察",
    sourceIds: [] as string[],
    explanation: "相符",
  };
  assert.equal(
    validateReview([factualCriterion], "观察", ["source"], { checks: [check] })
      .valid,
    false,
  );
  assert.equal(
    validateReview([factualCriterion], "观察", ["source"], {
      checks: [{ ...check, sourceIds: ["source"] }],
    }).passed,
    true,
  );
});
test("candidate rule scope stays isolated across concurrent baseline/online loading and strips YAML on both sides", async () => {
  const baseline = await freezeRules(),
    candidate = candidateRules(baseline);
  const [a, b, online] = await Promise.all([
    withRuleSnapshot(baseline, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return (await loadSkills("ppt")).shared;
    }),
    withRuleSnapshot(candidate, async () => (await loadSkills("ppt")).shared),
    sharedRules(),
  ]);
  assert.equal(a, online);
  assert.notEqual(a, b);
  const full = await readFile("skills/medical-paper-guide/SKILL.md", "utf8");
  const snapshot = await loadSkills("paper", {
    id: "medical-paper-guide",
    text: full,
    version: "candidate",
  });
  assert.equal(
    snapshot.modules.find((m) => m.id === "medical-paper-guide")!.text,
    baseline.entries["medical-paper-guide"].text,
  );
});
test("research-plan service freezes the scoped candidate into actual generation instructions", async () => {
  const baseline = await freezeRules(),
    candidate = candidateRules(baseline);
  candidate.entries["medical-research-plan"].text += "\nPLAN_SKILL_CANDIDATE_MARKER";
  const calls: string[] = [];
  const provider: Provider = {
    model: "fixture",
    async generate(instructions, input, schema) {
      calls.push(instructions);
      const generation =
        (input as { module?: string }).module === "research-plan";
      return {
        output: schema.parse(
          generation
            ? {
                title: "草案",
                sections: [
                  {
                    id: "question",
                    title: "目标",
                    text: "拟比较测量信号。",
                    rationale: "排除测量伪影。",
                    kind: "proposal",
                    sourceRefs: [],
                    unknowns: ["设备未知"],
                  },
                ],
                assumptions: [],
                questions: [],
                limitations: ["尚无结果"],
              }
            : {
                issues: [],
                checkedSourceRefs: [],
                limitations: ["仅局部核对"],
              },
        ),
      };
    },
  };
  const service = new ResearchPlans(
    provider,
    async () => {
      throw new Error("不应读取个人论文");
    },
    undefined,
    async () => {},
  );
  await withRuleSnapshot(candidate, async () => {
    const plan = await service.create({
      question: "如何排除医学细胞测量伪影？",
    });
    const job = await service.start(plan.id, {
      requestKey: "scoped",
      expectedVersion: plan.currentVersion,
      expectedTopicVersion: plan.topic.version,
      action: "generate",
      requestedScope: "design-draft",
      maxCalls: 2,
    });
    await service.wait(job.id);
    assert.equal(service.job(job.id).status, "completed");
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes(feedbackCandidate));
  assert.ok(calls[0].includes("PLAN_SKILL_CANDIDATE_MARKER"));
  assert.equal(calls[1].includes("PLAN_SKILL_CANDIDATE_MARKER"), false);
  assert.equal((await freezeRules()).entries["medical-research-plan"].text.includes("PLAN_SKILL_CANDIDATE_MARKER"), false);
  assert.equal((await sharedRules()).includes(feedbackCandidate), false);
});

test("visible-text evaluation rejects metadata locations while preserving actual body errors and legacy scope", () => {
  const artifact = {
    unit: {
      sections: [
        {
          title: "研究方法",
          text: "正文里错误地写入issue-9。",
          citations: ["source-1"],
        },
      ],
      sources: [{ text: "这是引用副本", id: "source-1" }],
    },
    deck: {
      slides: [
        {
          title: "结果",
          notes: "这是实际讲稿。",
          imageSource: "figure-source",
          imageCrop: { label: "panel-metadata" },
        },
      ],
    },
  };
  const review = (location: string) => ({
    checks: [
      {
        criterion: "body",
        passed: false,
        location,
        sourceIds: ["source-1"],
        explanation: "须修正",
      },
    ],
  });
  for (const location of [
    "source-1",
    "figure-source",
    "panel-metadata",
    "这是引用副本",
  ]) {
    assert.equal(
      validateReview(
        ["body"],
        artifact,
        ["source-1"],
        review(location),
        "visible-text",
      ).valid,
      false,
    );
    assert.equal(
      validateReview(["body"], artifact, ["source-1"], review(location)).valid,
      true,
    );
  }
  for (const location of ["研究方法", "issue-9", "这是实际讲稿。"]) {
    const result = validateReview(
      ["body"],
      artifact,
      ["source-1"],
      review(location),
      "visible-text",
    );
    assert.equal(result.valid, true);
    assert.equal(result.passed, false);
  }
});

test("reading review receives the original image and source binding; absent or mismatched evidence never dispatches", async () => {
  const image = "data:image/png;base64,source-image";
  let calls = 0;
  let receivedImage: string | undefined;
  let receivedInput: any;
  let receivedInstructions = "";
  const provider: Provider = {
    model: "fixture",
    async generate(_instructions, input, schema, _signal, visibleImage) {
      calls++;
      receivedInstructions = _instructions;
      receivedImage = visibleImage;
      receivedInput = input;
      return { output: schema.parse({ checks: [{
        criterion: "核对图中读数", passed: true,
        location: "可见曲线", sourceIds: ["figure"],
        explanation: "本测试只核对原图输入是否送达，不评定科学正确性。",
      }] }) };
    },
  };
  const input = {
    question: "解释曲线", conditions: "仅所给原图",
    criteria: ["核对图中读数"], artifact: { title: "可见曲线" },
    sources: [{ id: "figure", text: "图注未逐一抄录数值", locator: "Figure 2" }],
    evaluatorVersion: "explanation-and-original-image-v1-visible-text" as const,
    imageSourceId: "figure",
    sourceExposure: "actual-generation-packets-v1" as const,
  };
  const signal = new AbortController().signal;
  const reviewed = await reviewArtifact(provider, input, signal, image);
  assert.equal(reviewed.valid, true);
  assert.equal(receivedImage, image);
  assert.equal(receivedInput.imageSourceId, "figure");
  assert.equal(receivedInput.sourceExposure, "actual-generation-packets-v1");
  assert.match(receivedInstructions, /不把未提供的文字判为漏读/);
  assert.deepEqual(receivedInput.sources, input.sources);
  for (const bad of [
    { value: input, image: undefined },
    { value: { ...input, imageSourceId: undefined }, image },
    { value: { ...input, imageSourceId: "other" }, image },
  ]) {
    await assert.rejects(
      reviewArtifact(provider, bad.value, signal, bad.image), /未派发/,
    );
  }
  assert.equal(calls, 1);
  await reviewArtifact(provider, {
    ...input, evaluatorVersion: "explanation-v2-visible-text",
    imageSourceId: undefined,
  }, signal);
  assert.equal(calls, 2);
  assert.equal(receivedImage, undefined);
});

test("reading multi-figure review requires all source bindings and forwards the actual packet", async () => {
  let calls = 0;
  const provider: Provider = {
    model: "fixture",
    async generate(rules, input: any, schema, _signal, image) {
      calls++;
      assert.match(rules, /多图资料板/);
      assert.equal(image, "actual-reading-packet");
      assert.deepEqual(input.imageSourceIds, ["figure-a", "figure-b"]);
      return {
        output: schema.parse({
          checks: [
            {
              criterion: "compare",
              passed: true,
              location: "comparison",
              sourceIds: ["figure-a", "figure-b"],
              explanation: "source binding fixture",
            },
          ],
        }),
      };
    },
  };
  const input = {
    question: "compare",
    conditions: "two figures",
    criteria: ["compare"],
    artifact: { title: "comparison" },
    sources: [
      { id: "figure-a", text: "a", locator: "a" },
      { id: "figure-b", text: "b", locator: "b" },
    ],
    evaluatorVersion: "explanation-and-reading-images-v1-visible-text" as const,
    imageSourceIds: ["figure-a", "figure-b"],
  };
  const signal = new AbortController().signal;
  for (const bad of [
    undefined,
    [],
    ["figure-a", "other"],
    ["figure-a", "figure-a"],
  ])
    await assert.rejects(
      reviewArtifact(
        provider,
        { ...input, imageSourceIds: bad },
        signal,
        "actual-reading-packet",
      ),
      /未派发/,
    );
  await assert.rejects(reviewArtifact(provider, input, signal), /未派发/);
  assert.equal(calls, 0);
  assert.equal(
    (await reviewArtifact(provider, input, signal, "actual-reading-packet"))
      .valid,
    true,
  );
  assert.equal(calls, 1);
});
