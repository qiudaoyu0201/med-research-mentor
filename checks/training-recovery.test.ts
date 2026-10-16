import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile } from "../server/training-engine.ts";
import { readRecoveryEvidence } from "../server/training-recovery.ts";
import { ResearchPlans } from "../server/research-plans.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { z } from "zod";
import { CodexProvider, type Provider } from "../server/provider.ts";
import { BudgetLedger } from "../server/budget.ts";
import {
  explanationCandidateRules,
  reserveUnit,
  type TrainingBatch,
} from "../server/internal-training.ts";
import { freezeRules, withRuleSnapshot, loadSkills } from "../server/skills.ts";
import {
  validateExplanationLinks,
  compactExplanationLinksSchema,
  explanationLinksSchema,
} from "../server/explanation-links.ts";
import {
  validateRecovery,
  recoveryProtocolVersion,
  historicalCancelledAttempt,
  iterationUsage,
  type TrainingRecovery,
  type IterationQuota,
  calibrationPassed,
} from "../server/training-protocol.ts";
import {
  reserveLearningUnit,
  learningCalibration,
  learningCriteria,
} from "../server/learning-protocol.ts";
import { sample, defaultDeck, exampleUnits } from "../examples/bundle.ts";

const schema = z.object({ text: z.string() });
test("calibration reuse requires the same complete per-dimension expected judgments and rejects duplicate or empty checks", () => {
  const samples = [
    {
      id: "example",
      checks: [
        { criterion: "fact", passed: true },
        { criterion: "reason", passed: false },
      ],
    },
  ];
  const records = [
    {
      id: "example",
      expected: false,
      expectedChecks: [...samples[0].checks],
      evaluation: {
        valid: true,
        passed: false,
        review: { checks: [...samples[0].checks] },
      },
    },
  ];
  assert.equal(calibrationPassed(samples, records), true);
  for (const checks of [
    [],
    [samples[0].checks[0]],
    [samples[0].checks[0], samples[0].checks[0]],
  ]) {
    assert.equal(
      calibrationPassed(samples, [{ ...records[0], expectedChecks: checks }]),
      false,
    );
    assert.equal(
      calibrationPassed(samples, [
        {
          ...records[0],
          evaluation: { ...records[0].evaluation, review: { checks } },
        },
      ]),
      false,
    );
  }
  assert.equal(calibrationPassed(samples, [records[0], records[0]]), false);
});
class SimulatedClient {
  events = new EventEmitter();
  requests: string[] = [];
  closed = false;
  timers: NodeJS.Timeout[] = [];
  constructor(
    private mode:
      "normal" | "stall" | "cancel-terminal" | "delayed-terminal" | "transport",
  ) {}
  async init() {}
  later(ms: number, work: () => void) {
    this.timers.push(setTimeout(work, ms));
  }
  message(method: string, params: unknown) {
    this.events.emit("message", {
      method,
      params: {
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        ...(params as object),
      },
    });
  }
  async rpc(method: string) {
    this.requests.push(method);
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "thread/start") return { thread: { id: "thread-fixture" } };
    if (method === "turn/start") {
      this.later(5, () =>
        this.message("item/agentMessage/delta", { delta: '{"text":' }),
      );
      this.later(10, () =>
        this.message("thread/tokenUsage/updated", {
          tokenUsage: {
            last: { inputTokens: 19, outputTokens: 3, totalTokens: 22 },
          },
        }),
      );
      if (this.mode === "normal") {
        this.later(20, () =>
          this.message("item/agentMessage/delta", { delta: '"解释"}' }),
        );
        this.later(25, () =>
          this.message("item/completed", {
            item: { type: "agentMessage", text: '{"text":"解释"}' },
          }),
        );
        this.later(30, () =>
          this.message("turn/completed", {
            turn: { id: "turn-fixture", status: "completed" },
          }),
        );
      }
      if (this.mode === "transport") this.later(20, () => this.close());
      return { turn: { id: "turn-fixture" } };
    }
    if (method === "turn/interrupt") {
      if (this.mode === "delayed-terminal")
        this.later(15, () =>
          this.message("turn/completed", {
            turn: { id: "turn-fixture", status: "interrupted" },
          }),
        );
      if (this.mode === "cancel-terminal")
        this.message("turn/completed", {
          turn: { id: "turn-fixture", status: "interrupted" },
        });
      return {};
    }
    throw new Error("unexpected RPC");
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.timers.forEach(clearTimeout);
    this.events.emit("closed");
  }
}
const options = {
  groupId: "generation",
  sourceHash: "source",
  skillHash: "rules",
};
test("PPT C preserves full speech and binds explanations to actual slide notes through the only revision", async () => {
  const candidate = explanationCandidateRules(
    await freezeRules(),
    "compact-v1",
  );
  const deck = structuredClone(defaultDeck);
  deck.slides[0].notes += " 对照用于排除操作本身的影响。";
  deck.speechScript = deck.slides
    .map((s) => s.title + "\n" + s.notes)
    .join("\n\n");
  const revised = structuredClone(deck);
  revised.slides[0].notes += " 两组采用相同操作条件。";
  revised.speechScript += "\n两组采用相同操作条件。";
  const compactUnit = {
    ...exampleUnits.paper,
    sections: exampleUnits.paper.sections.slice(0, 3),
  };
  const generated = (value: typeof deck) => ({
    unit: compactUnit,
    deck: value,
    explanationLinks: [
      {
        purpose: "comparison",
        sourceIds: [],
        sourceQuote: "",
        artifactLocation: "deck.slides.0.notes",
        artifactAnchor: "对照用于排除操作本身的影响",
        gap: null,
      },
    ],
  });
  const check = {
    issues: [
      {
        id: "gap",
        location: deck.slides[0].title,
        type: "teaching",
        evidence: [],
        suggestion: "补充比较条件",
        severity: "warning",
        resolved: false,
      },
    ],
    checkedSources: [],
    limitations: ["夹具核对"],
  };
  const outputs: unknown[] = [
    generated(deck),
    check,
    generated(revised),
    { ...check, issues: [] },
  ];
  const calls: { instructions: string; input: any }[] = [];
  const provider: Provider = {
    model: "fixture",
    async generate(instructions, input, schema) {
      calls.push({ instructions, input });
      return { output: schema.parse(outputs.shift()) };
    },
  };
  const manager = new TaskManager(provider, async () => {});
  const run = await withRuleSnapshot(candidate, () =>
    manager.start(
      {
        paperId: sample.id,
        module: "ppt",
        mode: "live",
        question: "说明比较并提供逐页讲稿和完整稿",
        profileId: "beginner",
        sourceIds: sample.sources.map((s) => s.id),
        taughtConcepts: [],
        speechScript: true,
        slideCount: deck.slides.length,
        checks: { readability: false },
      },
      sample,
    ),
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(calls.length, 4);
  assert.equal(run.deck!.speechScript, revised.speechScript);
  assert.equal(run.deck!.slides[0].notes, revised.slides[0].notes);
  assert.equal(
    (run.explanationTrace as any).links[0].artifactText,
    revised.slides[0].notes,
  );
  for (const index of [1, 3]) {
    assert.equal(
      calls[index].instructions.includes(candidate.teachingContract!),
      false,
    );
    assert.equal(
      JSON.stringify(calls[index].input).includes("artifactAnchor"),
      false,
    );
  }
});
test("slow streamed generation preserves output growth, reported usage and completed remote state", async () => {
  const client = new SimulatedClient("normal");
  let persisted: unknown;
  const ledger = new BudgetLedger("normal", async () => {
    persisted = structuredClone(ledger.state);
  });
  const result = await ledger.call(
    new CodexProvider(() => client, 200),
    "teaching",
    "",
    {},
    schema,
    new AbortController().signal,
    options,
  );
  assert.equal(result.output.text, "解释");
  const attempt = ledger.state.attempts[0];
  assert.equal(attempt.status, "succeeded");
  assert.equal(attempt.tokens.total, 22);
  assert.equal(attempt.observation?.outputUpdates, 3);
  assert.equal(attempt.observation?.remoteTerminal, "completed");
  assert.ok(attempt.observation?.firstResponseAt);
  assert.ok(attempt.observation?.firstOutputAt);
  assert.deepEqual(persisted, ledger.state);
  assert.equal(client.requests.filter((r) => r === "turn/start").length, 1);
});
test("interrupt acknowledgment can precede a terminal notification and both remain recorded", async () => {
  const client = new SimulatedClient("delayed-terminal");
  const ledger = new BudgetLedger("deadline", async () => {}, undefined, 100);
  await assert.rejects(
    ledger.call(
      new CodexProvider(() => client, 500),
      "teaching",
      "",
      {},
      schema,
      new AbortController().signal,
      options,
    ),
  );
  const observation = ledger.state.attempts[0].observation!;
  assert.equal(observation.interruptAcknowledged, true);
  assert.equal(observation.remoteTerminal, "interrupted");
  assert.ok(
    observation.events.findIndex((e) => e.type === "interrupt") <
      observation.events.findIndex((e) => e.type === "terminal"),
  );
});
test("external terminal evidence binds original instructions, input, schema and model without changing the old report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutor-recovery-"));
  try {
    const inputDirectory = join(directory, "records/provider-inputs");
    await mkdir(inputDirectory, { recursive: true });
    const saved = {
      instructions: "候选合同",
      input: { question: "原始问题" },
      image: null,
      model: "fixture",
      settings: { effort: "low" },
      schema: z.toJSONSchema(schema),
    };
    await writeFile(
      join(inputDirectory, "attempt.json"),
      JSON.stringify(saved),
    );
    const expectedSchema = structuredClone(saved.schema) as any;
    expectedSchema.required = Object.keys(expectedSchema.properties);
    expectedSchema.additionalProperties = false;
    const record = {
      attemptId: "attempt",
      providerInputHash: await hashFile(join(inputDirectory, "attempt.json")),
      observedAt: new Date().toISOString(),
      threadStart: {
        method: "thread/start",
        params: { model: saved.model, baseInstructions: saved.instructions },
        result: { thread: { id: "thread" } },
      },
      turnStart: {
        method: "turn/start",
        params: {
          threadId: "thread",
          model: saved.model,
          effort: "low",
          input: [{ type: "text", text: JSON.stringify(saved.input) }],
          outputSchema: expectedSchema,
        },
        result: { turn: { id: "turn" } },
      },
      terminal: {
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: { id: "turn", status: "interrupted" },
        },
      },
    };
    const path = join(directory, "evidence.json");
    const save = async () => {
      await writeFile(path, JSON.stringify(record));
      return { path, hash: await hashFile(path) };
    };
    const evidence = await save();
    assert.equal(
      (await readRecoveryEvidence(evidence, directory, "attempt"))
        .remoteTerminal,
      "interrupted",
    );
    record.threadStart.params.baseInstructions = "另一候选";
    await assert.rejects(
      readRecoveryEvidence(await save(), directory, "attempt"),
      /不能关联/,
    );
    record.threadStart.params.baseInstructions = saved.instructions;
    record.terminal.params.turn.status = "running";
    await assert.rejects(
      readRecoveryEvidence(await save(), directory, "attempt"),
      /终止事件/,
    );
    await assert.rejects(
      readRecoveryEvidence(evidence, directory, "attempt"),
      /哈希改变/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("research-plan C locates actual rationale while its independent check receives only the deliverable", async () => {
  const baseline = await freezeRules(),
    candidate = explanationCandidateRules(baseline, "compact-v1");
  const calls: { instructions: string; input: any }[] = [];
  const rationale = "对照接受相同操作，以排除操作本身影响读数的解释。";
  const provider: Provider = {
    model: "fixture",
    async generate(instructions, input, schema) {
      calls.push({ instructions, input });
      return {
        output: schema.parse(
          (input as any).module === "research-plan"
            ? {
                title: "草案",
                sections: [
                  {
                    id: "controls",
                    title: "比较",
                    text: "拟设置操作对照。",
                    rationale,
                    kind: "proposal",
                    sourceRefs: [],
                    unknowns: ["设备未知"],
                  },
                ],
                assumptions: [],
                questions: [],
                limitations: ["未做实验"],
                explanationLinks: [
                  {
                    purpose: "comparison",
                    sourceIds: [],
                    sourceQuote: "",
                    artifactLocation: "sections.0.rationale",
                    artifactAnchor: "排除操作本身影响读数",
                    gap: null,
                  },
                ],
              }
            : { issues: [], checkedSourceRefs: [], limitations: ["局部检查"] },
        ),
      };
    },
  };
  const service = new ResearchPlans(
    provider,
    async () => {
      throw new Error("不读个人论文");
    },
    undefined,
    async () => {},
  );
  await withRuleSnapshot(candidate, async () => {
    const plan = await service.create({
      question: "怎样设计医学细胞测量的操作对照？",
    });
    const job = await service.start(plan.id, {
      requestKey: "compact",
      expectedVersion: plan.currentVersion,
      expectedTopicVersion: plan.topic.version,
      action: "generate",
      requestedScope: "design-draft",
      maxCalls: 2,
    });
    await service.wait(job.id);
    assert.equal(
      service.job(job.id).status,
      "completed",
      service.job(job.id).error,
    );
    const stored = service.get(plan.id);
    assert.equal(
      stored.versions.at(-1)!.content.sections[0].rationale,
      rationale,
    );
    assert.equal("explanationLinks" in stored.versions.at(-1)!.content, false);
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].instructions.includes(candidate.teachingContract!));
  assert.equal(
    calls[1].instructions.includes(candidate.teachingContract!),
    false,
  );
  assert.equal(
    JSON.stringify(calls[1].input).includes("artifactAnchor"),
    false,
  );
});
test("budget deadline preserves partial output and usage; interrupt acknowledgment is not remote termination", async () => {
  const client = new SimulatedClient("stall");
  const ledger = new BudgetLedger("deadline", async () => {}, undefined, 100);
  await assert.rejects(
    ledger.call(
      new CodexProvider(() => client, 500),
      "teaching",
      "",
      {},
      schema,
      new AbortController().signal,
      options,
    ),
  );
  const attempt = ledger.state.attempts[0];
  assert.equal(attempt.status, "unknown");
  assert.equal(attempt.rawOutput, '{"text":');
  assert.equal(attempt.tokens.total, 22);
  assert.equal(attempt.observation?.timeoutLayer, "task-total");
  assert.equal(attempt.observation?.interruptAcknowledged, true);
  assert.equal(attempt.observation?.remoteTerminal, undefined);
  assert.equal(client.requests.filter((r) => r === "turn/start").length, 1);
});
test("external cancellation records a separate remote terminal event without accepting incomplete output", async () => {
  const client = new SimulatedClient("cancel-terminal");
  const ledger = new BudgetLedger("cancel", async () => {});
  const controller = new AbortController();
  const pending = ledger.call(
    new CodexProvider(() => client, 500),
    "teaching",
    "",
    {},
    schema,
    controller.signal,
    options,
  );
  const timer = setTimeout(() => controller.abort(), 40);
  try {
    await assert.rejects(pending);
  } finally {
    clearTimeout(timer);
  }
  const attempt = ledger.state.attempts[0];
  assert.equal(attempt.status, "cancelled");
  assert.equal(attempt.observation?.remoteTerminal, "interrupted");
  assert.equal(attempt.observation?.threadId, "thread-fixture");
  assert.equal(attempt.observation?.turnId, "turn-fixture");
  assert.equal(attempt.tokens.total, 22);
});
test("managed request deadline and transport failure are distinct from a confirmed remote terminal", async () => {
  for (const mode of ["stall", "transport"] as const) {
    const client = new SimulatedClient(mode);
    const ledger = new BudgetLedger(mode, async () => {});
    ledger.state.timing = {
      version: "task-timing-v1",
      scope: "fragment",
      taskMs: 500,
      requestMs: 60,
      firstOutputMs: 100,
      idleMs: 100,
    };
    await assert.rejects(
      ledger.call(
        new CodexProvider(() => client, 60),
        "teaching",
        "",
        {},
        schema,
        new AbortController().signal,
        options,
      ),
    );
    const attempt = ledger.state.attempts[0];
    assert.equal(attempt.status, "unknown");
    assert.equal(attempt.tokens.total, 22);
    assert.equal(attempt.observation?.remoteTerminal, undefined);
    assert.equal(
      attempt.observation?.timeoutLayer,
      mode === "stall" ? "request-total" : undefined,
    );
    assert.equal(
      attempt.observation?.events.some((e) => e.type === "closed"),
      mode === "transport",
    );
  }
});
test("synchronous provider exceptions remain charged reservations and preserve ledger state", async () => {
  const provider: Provider = {
    model: "fixture",
    generate() {
      throw new Error("transport");
    },
  };
  const ledger = new BudgetLedger("sync", async () => {});
  await assert.rejects(
    ledger.call(
      provider,
      "teaching",
      "",
      {},
      schema,
      new AbortController().signal,
      options,
    ),
  );
  assert.equal(ledger.state.attempts[0].status, "unknown");
});
test("compact tracing reconstructs complete source and delivery text while rejecting ambiguity and fake positions", () => {
  const source = {
    ...sample.sources[0],
    text: "比较两组是为了排除操作本身的影响。" + "来源内容。".repeat(100),
  };
  const text =
    "对照与干预组接受相同操作，因此比较能隔离干预差异。" +
    "必要解释。".repeat(100);
  const link = {
    purpose: "comparison",
    sourceIds: [source.id],
    sourceQuote: "比较两组是为了排除操作本身的影响",
    artifactLocation: "deck.slides.0.notes",
    artifactAnchor: "因此比较能隔离干预差异",
    gap: null,
  };
  const artifact = {
    deck: { slides: [{ notes: text }] },
    explanationLinks: [link],
  };
  const valid = validateExplanationLinks(
    artifact,
    [source],
    "比较",
    "ppt",
    "compact-v1",
  );
  assert.equal("artifactText" in valid[0] && valid[0].artifactText, text);
  assert.equal("sourceText" in valid[0] && valid[0].sourceText, source.text);
  for (const change of [
    { sourceQuote: "虚构的原文" },
    { sourceIds: ["fake"] },
    { artifactLocation: "unit.sections.0.text" },
    { artifactLocation: "deck.slides.1.notes" },
    { artifactAnchor: "只写内部记录" },
  ])
    assert.throws(() =>
      validateExplanationLinks(
        { ...artifact, explanationLinks: [{ ...link, ...change }] },
        [source],
        "比较",
        "ppt",
        "compact-v1",
      ),
    );
  assert.throws(
    () =>
      validateExplanationLinks(
        {
          ...artifact,
          deck: { slides: [{ notes: text + link.artifactAnchor }] },
        },
        [source],
        "比较",
        "ppt",
        "compact-v1",
      ),
    /歧义/,
  );
  assert.throws(
    () =>
      validateExplanationLinks(
        artifact,
        [{ ...source, text: source.text + link.sourceQuote }],
        "比较",
        "ppt",
        "compact-v1",
      ),
    /歧义/,
  );
  assert.ok(
    JSON.stringify(z.toJSONSchema(compactExplanationLinksSchema)).length <
      JSON.stringify(z.toJSONSchema(explanationLinksSchema)).length,
  );
});
test("C is explicitly versioned, cache isolated, and leaves online generation and review rules unchanged", async () => {
  const baseline = await freezeRules();
  const candidate = explanationCandidateRules(baseline, "compact-v1");
  const c = await withRuleSnapshot(candidate, () => loadSkills("ppt"));
  const b = await withRuleSnapshot(
    explanationCandidateRules(baseline, true),
    () => loadSkills("ppt"),
  );
  const online = await loadSkills("ppt");
  assert.equal(candidate.teachingContractVersion, "source-explanation-c");
  assert.equal(c.explanationTracing, "compact-v1");
  assert.equal(online.explanationTracing, false);
  assert.equal(online.teachingContract, "");
  assert.notDeepEqual(c.versions, b.versions);
  assert.deepEqual(c.modules, online.modules);
  assert.equal(c.shared, online.shared);
});
test("recovery inherits every prior call and requires exact remote evidence, report, plan and engine bindings", () => {
  const quota: IterationQuota = {
    version: "iteration-v1.1-70x3",
    cycle: 2,
    historicalAttempts: 44,
    priorProductAttempts: 16,
    previousReportHash: "a".repeat(64),
    originReportHash: "b".repeat(64),
  };
  const budget = new BudgetLedger("fixture", async () => {}).state;
  budget.attempts = Array.from({ length: 6 }, (_, i) => ({
    id: `${i}`,
    status: i === 5 ? "cancelled" : "succeeded",
    observation:
      i === 5
        ? {
            threadId: "thread",
            turnId: "turn",
            remoteTerminal: "interrupted",
            events: [{ type: "terminal", status: "interrupted" }],
          }
        : undefined,
  })) as never;
  const report = {
    quota,
    batches: [
      {
        id: "fixture",
        phase: "M1",
        status: "stopped",
        budget,
      } as TrainingBatch,
    ],
  };
  const bindings = {
    previousDirectory: "fixture",
    reportHash: "c".repeat(64),
    engineHash: "d".repeat(64),
    planHash: "e".repeat(64),
  };
  const manifest: TrainingRecovery = {
    version: recoveryProtocolVersion,
    ...bindings,
    originReportHash: quota.originReportHash,
    historicalAttempts: 44,
    priorProductAttempts: 22,
    attempts: [
      {
        id: "5",
        status: "cancelled",
        threadId: "thread",
        turnId: "turn",
        remoteTerminal: "interrupted",
        confirmed: true,
      },
    ],
  };
  validateRecovery(manifest, report, bindings);
  assert.equal(iterationUsage(quota, report.batches).combined, 66);
  for (const change of [
    { priorProductAttempts: 21 },
    { engineHash: "f".repeat(64) },
    { reportHash: "f".repeat(64) },
    { planHash: "f".repeat(64) },
    { attempts: [] },
    { attempts: [{ ...manifest.attempts[0], confirmed: false }] },
    { attempts: [manifest.attempts[0], manifest.attempts[0]] },
  ])
    assert.throws(() =>
      validateRecovery({ ...manifest, ...change }, report, bindings),
    );
  delete budget.attempts[5].observation!.remoteTerminal;
  assert.throws(
    () => validateRecovery(manifest, report, bindings),
    /终止未确认/,
  );
  assert.equal(budget.attempts[5].status, "cancelled");
});
test("historical B isolation preserves unknown cost and only admits its stopped second-cycle cancellation", () => {
  const budget = new BudgetLedger("fixture", async () => {}).state;
  budget.attempts = Array.from({ length: 6 }, (_, i) => ({
    id: i === 5 ? historicalCancelledAttempt : `done-${i}`,
    status: i === 5 ? "cancelled" : "succeeded",
  })) as never;
  const report = {
    quota: {
      version: "iteration-v1.1-70x3" as const,
      cycle: 2,
      historicalAttempts: 44,
      priorProductAttempts: 16,
      previousReportHash: "a".repeat(64),
      originReportHash: "b".repeat(64),
    },
    batches: [
      { id: "B", phase: "M1", status: "stopped", budget } as TrainingBatch,
    ],
  };
  const bindings = {
    previousDirectory: "B",
    reportHash: "c".repeat(64),
    engineHash: "d".repeat(64),
    planHash: "e".repeat(64),
  };
  const manifest: TrainingRecovery = {
    version: recoveryProtocolVersion,
    ...bindings,
    originReportHash: report.quota.originReportHash,
    historicalAttempts: 44,
    priorProductAttempts: 22,
    disposition: "historical-unknown-isolated",
    decisionReason: "保留未知远端状态与用量，独立派发 C，不重发 B。",
    attempts: [
      {
        id: historicalCancelledAttempt,
        status: "cancelled",
        threadId: null,
        turnId: null,
        remoteTerminal: null,
        confirmed: false,
      },
    ],
  };
  const original = JSON.stringify(report);
  validateRecovery(manifest, report, bindings);
  assert.equal(JSON.stringify(report), original);
  assert.equal(iterationUsage(report.quota, report.batches).combined, 66);
  for (const change of [
    { disposition: undefined },
    { decisionReason: "" },
    { reportHash: "f".repeat(64) },
    { engineHash: "f".repeat(64) },
    { planHash: "f".repeat(64) },
    { priorProductAttempts: 21 },
    { attempts: [{ ...manifest.attempts[0], confirmed: true }] },
    { attempts: [{ ...manifest.attempts[0], remoteTerminal: "interrupted" }] },
    { attempts: [{ ...manifest.attempts[0], id: "new-cancelled" }] },
    { attempts: [...manifest.attempts, manifest.attempts[0]] },
  ])
    assert.throws(() =>
      validateRecovery({ ...manifest, ...change }, report, bindings),
    );
  for (const status of ["reserved", "unknown"]) {
    const changed = structuredClone(report);
    changed.batches[0].budget.attempts[5].status = status as "unknown";
    assert.throws(() =>
      validateRecovery(
        { ...manifest, attempts: [{ ...manifest.attempts[0], status }] },
        changed,
        bindings,
      ),
    );
  }
  const running = structuredClone(report);
  running.batches[0].status = "running";
  assert.throws(() => validateRecovery(manifest, running, bindings));
  const fourth = structuredClone(report);
  fourth.quota.cycle = 3;
  assert.throws(() => validateRecovery(manifest, fourth, bindings));
  const extra = structuredClone(report);
  extra.batches[0].budget.attempts.push({
    ...extra.batches[0].budget.attempts[5],
    id: "new-unknown",
    status: "unknown",
  });
  assert.throws(() => validateRecovery(manifest, extra, bindings));
});

test("whole-pair admission uses 180 seconds per role and learning shares a 28-call ledger across batches", () => {
  const budget = new BudgetLedger(
    "fixture",
    async () => {},
    undefined,
    45 * 60_000,
  ).state;
  budget.limit = 24;
  const batch: TrainingBatch = {
    id: "fixture",
    phase: "M1",
    status: "running",
    budget,
  };
  reserveUnit(batch, 14, 0);
  assert.throws(() => reserveUnit(batch, 20, 0));
  budget.deadline = new Date(Date.now() + 31 * 60_000).toISOString();
  assert.throws(() => reserveUnit(batch, 10, 0));
  const learning = {
    ...batch,
    phase: "M3" as const,
    cycleLimit: 28,
    budget: { ...budget, attempts: [], limit: 12 },
  };
  const prior = {
    ...learning,
    status: "complete" as const,
    budget: {
      ...budget,
      attempts: Array.from({ length: 26 }, (_, i) => ({ id: `${i}` })) as never,
    },
  };
  reserveLearningUnit(learning, [prior, learning], 2);
  assert.throws(() => reserveLearningUnit(learning, [prior, learning], 4));
  assert.equal(learningCalibration.length, 4);
  assert.ok(
    learningCalibration.every(
      (c) => c.expected.length === learningCriteria.length,
    ),
  );
});
