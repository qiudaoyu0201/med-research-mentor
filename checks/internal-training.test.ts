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
  assert.equal((await sharedRules()).includes(feedbackCandidate), false);
});
