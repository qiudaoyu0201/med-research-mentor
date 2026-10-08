import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  claimClosureHistory,
  assertClosureHistoryClaim,
  prepareClosureExperiment,
  stepClosureExperiment,
  inheritedClosureAttempts,
  type ClosureManifest,
  type FrozenFile,
} from "../server/closure-experiment.ts";
import { LearnerStore } from "../server/learner.ts";
import { cloneOpenLearner } from "../server/internal-learner.ts";
import { learningCriteria } from "../server/learning-protocol.ts";
import { ProviderFailure, type Provider } from "../server/provider.ts";
import type { ClosureInput } from "../server/learning-closure.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tutor-closure-test-"));
  async function file(name: string, value: unknown): Promise<FrozenFile> {
    const bytes = JSON.stringify(value),
      path = join(directory, name);
    await writeFile(path, bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const history = await file("history.json", {
    status: "stopped",
    priorAttempts: 160,
    batches: [
      {
        status: "complete",
        budget: { attempts: [{ id: "historic", status: "succeeded" }] },
      },
    ],
  });
  const material = await file("material.json", { text: "横断面不能证明因果" });
  const phases: ClosureManifest["phases"] = [];
  for (const [kind, taskKind] of [
    ["reading", "evidence-retelling"],
    ["ppt", "report-outline"],
    ["proposal", "design-draft"],
  ] as const) {
    const state = await new LearnerStore(async () => {}).create({
      id: "novice",
      version: "1",
      background: "医学新手",
      concepts: [],
    });
    const learner = cloneOpenLearner(
      state,
      kind,
      "materials-and-teaching",
      [],
      [],
    );
    const task = {
      id: `${kind}-old`,
      kind: taskKind,
      question: "原研究如何设计",
      sources: [{ id: "s", text: "横断面不能证明因果", locator: "方法" }],
    };
    const observation = {
      task,
      rawAnswer: { text: "因果已证实", questions: [], usedVisibleIds: ["s"] },
      inputHash: "fixture",
      mode: "independent" as const,
      unsupportedVisibleIds: [],
    };
    learner.observations.push(observation);
    const input: ClosureInput = {
      learner,
      initial: observation,
      evaluation: {
        valid: true,
        passed: false,
        findings: [],
        review: {
          checks: learningCriteria.map((criterion) => ({
            criterion,
            passed: false,
            location: "因果已证实",
            explanation: "无时间顺序",
            sourceIds: ["s"],
          })),
        },
      },
      transfer: { ...task, id: `${kind}-new`, question: "新队列如何控制混杂" },
      priorStudies: [{ question: task.question, study: "A" }],
      targetStudy: "B",
      environmentHash: "fixture",
      rules: "医学导师",
    };
    phases.push({
      id: kind,
      kind,
      input: await file(`${kind}.json`, input),
      files: [material],
    });
  }
  let calls = 0;
  const provider: Provider = {
    id: "fixture",
    model: "fixture",
    async generate(_rules, value, schema) {
      calls++;
      const x = value as any;
      return {
        output: schema.parse(
          x.criteria
            ? {
                checks: x.criteria.map((criterion: string) => ({
                  criterion,
                  passed: true,
                  location: x.artifact.text,
                  sourceIds: ["s"],
                  explanation: "符合来源",
                })),
              }
            : x.diagnosis
              ? { text: "横断面不能证明因果", reason: "补充推理" }
              : {
                  text: "横断面不能证明因果",
                  questions: [],
                  usedVisibleIds: ["s"],
                },
        ),
        usage: { total_tokens: 10 },
      };
    },
  };
  return {
    directory,
    material,
    provider,
    calls: () => calls,
    manifest: {
      version: "closure-experiment-v1",
      id: "fixture",
      history,
      phases,
    } as ClosureManifest,
  };
}

test("three-function runner persists each stage, resumes all phases and inherits cost without false completion", async () => {
  const h = await fixture();
  try {
    let state = await prepareClosureExperiment(h.manifest, h.provider);
    let saved = structuredClone(state),
      admissions = 0;
    const persist = async (v: typeof state) => {
      saved = structuredClone(v);
    };
    assert.equal(h.calls(), 0);
    assert.equal(state.combinedAttempts, 161);
    // Preparation time is not deducted from a phase that has never dispatched.
    state.phases[0].closure.budget.deadline = "2000-01-01T00:00:00Z";
    for (let i = 0; i < 18; i++) {
      await stepClosureExperiment(
        h.manifest,
        state,
        h.provider,
        persist,
        new AbortController().signal,
        async () => {
          admissions++;
        },
      );
      state = structuredClone(saved);
      assert.equal(state.combinedAttempts, 162 + i);
      if (i < 17) assert.equal(state.status, "pending");
    }
    assert.equal(state.status, "complete");
    assert.equal(state.combinedAttempts, 179);
    assert.ok(
      state.phases.every(
        (p) =>
          p.closure.transfer?.mode === "independent" &&
          p.closure.correction?.mode === "assisted",
      ),
    );
    await stepClosureExperiment(
      h.manifest,
      state,
      h.provider,
      persist,
      new AbortController().signal,
      async () => {
        admissions++;
      },
    );
    assert.equal(h.calls(), 18);
    assert.equal(admissions, 18);
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test("runner refuses omitted functions, changed frozen files, changed provider and unknown dispatch", async () => {
  const h = await fixture();
  try {
    await assert.rejects(
      prepareClosureExperiment(
        { ...h.manifest, phases: h.manifest.phases.slice(0, 2) },
        h.provider,
      ),
      /三类/,
    );
    const state = await prepareClosureExperiment(h.manifest, h.provider);
    await assert.rejects(
      stepClosureExperiment(
        h.manifest,
        state,
        { ...h.provider, model: "other" },
        async () => {},
        new AbortController().signal,
        async () => {},
      ),
      /合同/,
    );
    assert.equal(h.calls(), 0);
    h.provider.generate = async () => {
      throw new ProviderFailure("unknown", "transport");
    };
    let saved = structuredClone(state);
    await assert.rejects(
      stepClosureExperiment(
        h.manifest,
        state,
        h.provider,
        async (v) => {
          saved = v;
        },
        new AbortController().signal,
        async () => {},
      ),
    );
    assert.equal(saved.status, "blocked");
    assert.equal(saved.combinedAttempts, 162);
    await assert.rejects(
      stepClosureExperiment(
        h.manifest,
        saved,
        h.provider,
        async () => {},
        new AbortController().signal,
        async () => {},
      ),
      /未知请求/,
    );
    await writeFile(h.material.path, "changed");
    await assert.rejects(
      prepareClosureExperiment(h.manifest, h.provider),
      /冻结文件已变化/,
    );
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test("history parsing never treats absent, inconsistent or unknown costs as a free root", () => {
  const budget = { attempts: [{ id: "one", status: "succeeded" }] };
  assert.equal(
    inheritedClosureAttempts({
      status: "stopped",
      combinedAttempts: 161,
      batch: { status: "stopped", budget },
    }),
    161,
  );
  for (const report of [
    { batches: [{ budget }] },
    { status: "running", priorAttempts: 0, batches: [{ budget }] },
    { priorAttempts: 10, combinedAttempts: 2, batches: [{ budget }] },
    {
      priorAttempts: 10,
      batches: [{ budget: { attempts: [{ id: "one", status: "unknown" }] } }],
    },
  ])
    assert.throws(() => inheritedClosureAttempts(report));
});

test("changing directories cannot reserve the same historical budget twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutor-closure-claim-"));
  try {
    const claims = join(directory, "claims");
    await claimClosureHistory(claims, "a".repeat(64), "first", "contract");
    await assertClosureHistoryClaim(
      claims,
      "a".repeat(64),
      "first",
      "contract",
    );
    await assert.rejects(
      assertClosureHistoryClaim(claims, "a".repeat(64), "copied", "contract"),
      /其他实验目录/,
    );
    await assert.rejects(
      claimClosureHistory(claims, "a".repeat(64), "renamed", "contract"),
      /EEXIST/,
    );
    await assert.rejects(
      claimClosureHistory(claims, "../invalid", "renamed", "contract"),
      /指纹/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
