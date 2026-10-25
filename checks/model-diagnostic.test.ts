import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnosticManifest,
  diagnosticLimit,
  diagnosticCallLimit,
  diagnosticTiming,
  diagnosticReadingImage,
  diagnosticVisibleSources,
  assertDiagnosticRun,
  stoppedParent,
  diagnosticMetrics,
  finishedDiagnostic,
} from "../server/model-diagnostic.ts";
import { BudgetLedger } from "../server/budget.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
function batch(): TrainingBatch {
  const budget = new BudgetLedger("pilot", async () => {}).state;
  budget.limit = budget.groupLimit = diagnosticLimit;
  budget.timing = structuredClone(diagnosticTiming);
  return {
    id: "pilot",
    phase: "M1",
    status: "awaiting-continuation",
    cycleLimit: diagnosticLimit,
    budget,
  };
}
test("diagnostic never resumes interrupted, unknown, or completed runs", () => {
  const b = batch();
  assert.doesNotThrow(() => assertDiagnosticRun("prepared", b, "same", "same"));
  for (const status of ["running", "cancelled", "stopped", "diagnostic-passed"])
    assert.throws(() => assertDiagnosticRun(status, b, "same", "same"));
  assert.throws(() => assertDiagnosticRun("prepared", b, "old", "new"));
  b.budget.limit++;
  assert.throws(() => assertDiagnosticRun("prepared", b, "same", "same"));
});
test("new diagnostic preserves stopped parent and rejects potentially active requests", () => {
  const b = batch();
  b.status = "stopped";
  const parent = {
    batches: [b],
    workflow: { checkpoint: { decision: "stop" } },
  };
  const before = structuredClone(parent);
  assert.equal(stoppedParent(parent).attempts, 0);
  assert.deepEqual(parent, before);
  parent.workflow.checkpoint.decision = "continue";
  assert.throws(() => stoppedParent(parent));
  parent.workflow.checkpoint.decision = "stop";
  b.budget.attempts.push({
    id: "uncertain",
    status: "unknown",
    durationMs: 100,
    tokens: {},
  } as any);
  assert.throws(() => stoppedParent(parent));
  b.budget.attempts[0].observation = {
    outputUpdates: 0,
    events: [],
    remoteTerminal: "interrupted",
  };
  assert.equal(stoppedParent(parent).attempts, 1);
});
test("truncated durations do not enter successful latency statistics", () => {
  const b = batch();
  b.budget.attempts.push(
    { id: "good", status: "succeeded", durationMs: 300, tokens: {} } as any,
    {
      id: "cut",
      status: "unknown",
      durationMs: 900,
      tokens: {},
      observation: {
        timeoutLayer: "output-idle",
        remoteTerminal: "interrupted",
      },
    } as any,
  );
  const metrics = diagnosticMetrics(b);
  assert.deepEqual(metrics.successful.durationMs, [300]);
  assert.equal(metrics.incomplete[0].observedDurationMs, 900);
  assert.equal(metrics.remaining, 6);
});
test("pilot binds Sol explicitly and keeps timing targets below protection limits", () => {
  const input = {
    id: "sol-pilot",
    model: "gpt-6.1-sol",
    parentReport: "parent.json",
    paperPath: "paper.json",
    module: "paper",
    question: "解释研究设计",
    sourceIds: ["source"],
    criteria: ["事实", "推理", "术语"],
    onlineUrl: "http://127.0.0.1:4336",
  };
  assert.equal(diagnosticManifest.parse(input).model, "gpt-6.1-sol");
  assert.equal(
    diagnosticManifest.parse({ ...input, module: "ppt", slideCount: 16 })
      .slideCount,
    16,
  );
  assert.equal(
    diagnosticManifest.parse({ ...input, slideCount: 1 }).slideCount,
    1,
  );
  assert.equal(
    diagnosticManifest.parse({
      ...input,
      sourceIds: Array.from({ length: 100 }, (_, i) => `s${i}`),
    }).sourceIds.length,
    100,
  );
  assert.equal(diagnosticCallLimit({}), 8);
  assert.equal(
    diagnosticCallLimit(diagnosticManifest.parse({ ...input, callLimit: 16 })),
    16,
  );
  for (const callLimit of [3, 65, 8.5])
    assert.throws(() => diagnosticManifest.parse({ ...input, callLimit }));
  assert.throws(() =>
    diagnosticManifest.parse({ ...input, module: "ppt", slideCount: 17 }),
  );
  assert.throws(() =>
    diagnosticManifest.parse({ ...input, model: "gpt-5.6-sol" }),
  );
  assert.ok(diagnosticTiming.targetRequestMs! < diagnosticTiming.requestMs);
  assert.ok(diagnosticTiming.targetIdleMs! < diagnosticTiming.idleMs);
});

test("later diagnostics inherit prior attempts and never treat uncertain requests as free retries", () => {
  const b = batch();
  b.status = "stopped";
  b.budget.attempts.push({
    id: "cut",
    status: "unknown",
    tokens: {},
    observation: { remoteTerminal: "interrupted" },
  } as any);
  const previous = { status: "stopped", batch: b, priorDiagnosticCalls: 3 };
  assert.equal(finishedDiagnostic(previous), 4);
  assert.throws(() => finishedDiagnostic({ ...previous, status: "running" }));
  delete b.budget.attempts[0].observation!.remoteTerminal;
  assert.throws(() => finishedDiagnostic(previous));
});

test("reading evaluation binds the image actually shown rather than the first figure", () => {
  const sources = [
    { id: "figure-a", image: "original-a" },
    { id: "figure-b", image: "original-b" },
    { id: "method-text" },
  ];
  assert.deepEqual(diagnosticReadingImage("original-b", sources), {
    image: "original-b",
    imageSourceId: "figure-b",
  });
  assert.equal(diagnosticReadingImage(undefined, sources), undefined);
  assert.throws(
    () => diagnosticReadingImage("unbound-image", sources),
    /无法绑定/,
  );
});

function exposedRole(role: string, text: string, hash = "page-hash") {
  return {
    role,
    input: {
      sources: {
        blocks: [{ hash, text }],
        references: [
          {
            id: "page",
            locator: "PDF p4",
            blockHash: hash,
          },
        ],
      },
    },
  };
}
test("diagnostic uses actual excerpts and merges revision exposure even with the same original-page hash", () => {
  const teaching = exposedRole("teaching", "[0–5] visible A");
  const revision = exposedRole("revision", "[8–12] visible B");
  const result = diagnosticVisibleSources([
    teaching,
    exposedRole("grounding", "hidden entire page"),
    revision,
    revision,
    exposedRole("novice", "hidden novice source"),
  ]);
  assert.deepEqual(result, [
    { id: "page", locator: "PDF p4", text: "[0–5] visible A" },
    { id: "page", locator: "PDF p4", text: "[8–12] visible B" },
  ]);
  assert.ok(!JSON.stringify(result).includes("Hidden"));
  assert.deepEqual(diagnosticVisibleSources([revision]), [result[1]]);
  const complete = exposedRole("revision", "Actually delivered complete page");
  assert.equal(
    diagnosticVisibleSources([teaching, complete])[1].text,
    "Actually delivered complete page",
  );
});
test("missing, malformed and ambiguous generator evidence is rejected before evaluation", () => {
  for (const roles of [
    [],
    [exposedRole("novice", "unused")],
    [{ role: "teaching", input: {} }],
    [{ role: "revision", input: { sources: { blocks: [], references: [] } } }],
    [
      {
        role: "teaching",
        input: {
          sources: {
            blocks: [{ hash: "other", text: "unbound" }],
            references: [{ id: "page", locator: "p4", blockHash: "missing" }],
          },
        },
      },
    ],
    [
      {
        role: "teaching",
        input: {
          sources: {
            blocks: [
              { hash: "same", text: "a" },
              { hash: "same", text: "b" },
            ],
            references: [{ id: "page", locator: "p4", blockHash: "same" }],
          },
        },
      },
    ],
    [exposedRole("teaching", "valid"), { role: "revision", input: {} }],
  ])
    assert.throws(() => diagnosticVisibleSources(roles), /未派发/);
});

test("diagnostic retains captions explicitly delivered in generator references without reconstructing a hidden caption", () => {
  const role = exposedRole("teaching", "Actual block");
  const sources: any = role.input.sources;
  sources.references[0].caption =
    "Caption explicitly received by the generator";
  assert.equal(
    diagnosticVisibleSources([role])[0].text,
    "Actual block\n[实际提供的图注]\nCaption explicitly received by the generator",
  );
  sources.blocks[0].text += " Caption explicitly received by the generator";
  assert.equal(
    diagnosticVisibleSources([role])[0].text,
    sources.blocks[0].text,
  );
  delete sources.references[0].caption;
  sources.blocks[0].text = "Excerpt with no caption delivered";
  assert.equal(
    diagnosticVisibleSources([role])[0].text,
    sources.blocks[0].text,
  );
});

test("configured diagnostic budgets remain frozen and are reported without the pilot default", () => {
  const b = batch();
  b.budget.limit = b.budget.groupLimit = b.cycleLimit = 16;
  assert.doesNotThrow(() =>
    assertDiagnosticRun("prepared", b, "same", "same", 16),
  );
  assert.throws(() => assertDiagnosticRun("prepared", b, "same", "same"));
  const metrics = diagnosticMetrics(b);
  assert.equal(metrics.limit, 16);
  assert.equal(metrics.remaining, 16);
  b.budget.groupLimit = 8;
  assert.throws(() => assertDiagnosticRun("prepared", b, "same", "same", 16));
});
