import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { BudgetLedger } from "../server/budget.ts";
import {
  CodexProvider,
  type Provider,
  type ProviderEvent,
} from "../server/provider.ts";
import {
  TrainingProvider,
  type TrainingBatch,
} from "../server/internal-training.ts";
import { watchRequest, taskTiming } from "../server/task-timing.ts";
import {
  initializeLoops,
  assertLoopHistory,
  reserveLoop,
  freezeFragment,
  type LoopReport,
} from "../server/short-loop.ts";
import { iterationUsage } from "../server/training-protocol.ts";
import { TaskManager, materialSources } from "../server/orchestrator.ts";
import { ResearchPlans } from "../server/research-plans.ts";
import { sample, defaultDeck, exampleUnits } from "../examples/bundle.ts";
import { shortLoopCases } from "../evals/short-loop-cases.ts";

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const schema = z.object({ text: z.string() });
const options = { groupId: "g", sourceHash: "s", skillHash: "k" };
const timing = {
  version: "task-timing-v1" as const,
  scope: "fragment" as const,
  taskMs: 500,
  requestMs: 450,
  firstOutputMs: 80,
  idleMs: 40,
};
function report(): LoopReport {
  const budget = new BudgetLedger("old", async () => {}).state;
  budget.attempts = Array.from(
    { length: 5 },
    (_, i) =>
      ({ id: `old-${i}`, status: i ? "succeeded" : "unknown" }) as never,
  );
  const value: LoopReport = {
    quota: {
      version: "iteration-v1.1-70x3",
      cycle: 3,
      historicalAttempts: 44,
      priorProductAttempts: 22,
      previousReportHash: "a".repeat(64),
      originReportHash: "b".repeat(64),
    },
    batches: [{ id: "old", phase: "M1", status: "stopped", budget }],
  };
  value.shortLoops = initializeLoops(value);
  return value;
}
test("short loops inherit 71 cumulative calls, reserve whole acceptance and reject historical mutations or a new unknown", () => {
  const r = report();
  assert.equal(iterationUsage(r.quota, r.batches).combined, 71);
  assert.equal(
    reserveLoop(r, "round-1", "intervention", "freeze").reservedCalls,
    4,
  );
  assert.throws(() => reserveLoop(r, "whole", "whole-ppt", "f"), /未验通过/);
  const old = structuredClone(r.batches);
  r.batches[0].budget.attempts[0].status = "succeeded";
  assert.throws(() => assertLoopHistory(r), /历史/);
  r.batches = old;
  const budget = new BudgetLedger("new", async () => {}).state;
  budget.attempts = [{ id: "new", status: "unknown" } as never];
  r.batches.push({ id: "new", phase: "M2", status: "stopped", budget });
  assert.throws(() => assertLoopHistory(r), /新请求/);
});
test("failed diagnostics stay counted; lane caps and duplicate samples block hidden retries", () => {
  const r = report();
  for (let i = 0; i < 3; i++) {
    const entry = reserveLoop(r, "round-1", `s-${i}`, "f");
    r.shortLoops!.runs.push({
      ...entry,
      batchId: entry.id,
      status: "failed",
      calls: 4,
    });
  }
  assert.throws(() => reserveLoop(r, "round-1", "s-0", "f"), /已运行/);
  assert.throws(() => reserveLoop(r, "round-1", "extra", "f"), /分路/);
  assert.throws(
    () => initializeLoops({ ...r, quota: { ...r.quota, cycle: 2 } }),
    /第三周期/,
  );
});
test("frozen development fragments retain exact complete ranges and forbid holdout input", () => {
  const paper = {
    ...sample,
    id: "train-xu",
    sources: [
      {
        ...sample.sources[0],
        id: "p3",
        page: 3,
        text: "unrelated\nDasatinib plus quercetin reduces this complete paragraph.\nN AT u RE footer",
      },
      {
        ...sample.sources[0],
        id: "p4",
        page: 4,
        text: "header eliminate senescent cells by altering pathways. Their observed comparison has limits.\nWe next examined another question.",
      },
      {
        ...sample.sources[0],
        id: "p5",
        page: 5,
        text: "D   +   Q reduced cytokine production with a broader target range.\nEliminating senescent cells both follows.",
      },
    ],
  };
  const frozen = freezeFragment(paper, "intervention");
  assert.equal(frozen.sources.length, 3);
  assert.equal(
    frozen.sources[0].text,
    "Dasatinib plus quercetin reduces this complete paragraph.\n",
  );
  assert.equal(frozen.sources[1].text.includes("another question"), false);
  assert.equal(paper.sources[0].text.startsWith("unrelated"), true);
  assert.throws(
    () => freezeFragment({ ...paper, id: "holdout-passos" }, "intervention"),
    /保留材料/,
  );
  assert.deepEqual(freezeFragment(paper, "protein").sources, []);
  assert.deepEqual(
    shortLoopCases.map((c) => c.split),
    ["development", "development", "development"],
  );
});
test("content growth sustains production; whitespace, RPC and usage cannot hide a stall", async () => {
  const events: ProviderEvent[] = [];
  const watch = watchRequest(
    new AbortController().signal,
    new Date(Date.now() + 800).toISOString(),
    { requestMs: 700, firstOutputMs: 100, idleMs: 80, diagnosisMs: 25 },
    (e) => events.push(e),
  );
  try {
    watch.observe({
      type: "output",
      text: "one",
      at: new Date().toISOString(),
    });
    await wait(50);
    watch.observe({
      type: "output",
      text: "one two",
      at: new Date().toISOString(),
    });
    await wait(50);
    assert.equal(watch.signal.aborted, false);
    assert.equal(
      events.some((e) => e.type === "diagnosis"),
      true,
    );
    watch.observe({
      type: "output",
      text: "one two",
      at: new Date().toISOString(),
    });
    watch.observe({ type: "response", at: new Date().toISOString() });
    watch.observe({ type: "usage", at: new Date().toISOString() });
    watch.observe({
      type: "output",
      text: "one two" + " \t\n".repeat(500),
      at: new Date().toISOString(),
    });
    await wait(70);
    assert.equal(watch.signal.aborted, true);
    assert.equal(events.at(-1)?.layer, "output-idle");
  } finally {
    watch.close();
  }
});
test("first output and task total are distinct, and continuous output cannot extend the total", async () => {
  for (const mode of ["first", "total"] as const) {
    const events: ProviderEvent[] = [];
    const watch = watchRequest(
      new AbortController().signal,
      new Date(Date.now() + (mode === "total" ? 120 : 500)).toISOString(),
      {
        requestMs: 450,
        firstOutputMs: mode === "first" ? 40 : 400,
        idleMs: 300,
      },
      (e) => events.push(e),
    );
    if (mode === "first")
      watch.observe({
        type: "output",
        text: " \t\n".repeat(500),
        at: new Date().toISOString(),
      });
    const ticker =
      mode === "total"
        ? setInterval(
            () =>
              watch.observe({
                type: "output",
                text: "x".repeat(Date.now() % 100000),
                at: new Date().toISOString(),
              }),
            20,
          )
        : undefined;
    try {
      await wait(180);
      assert.equal(watch.signal.aborted, true);
      assert.equal(
        events.at(-1)?.layer,
        mode === "first" ? "first-output" : "task-total",
      );
    } finally {
      clearInterval(ticker);
      watch.close();
    }
  }
});
test("managed Codex request ignores its fallback timer and preserves remote terminal cancellation", async () => {
  const events = new EventEmitter();
  let interrupts = 0;
  const client = {
    events,
    async init() {},
    close() {},
    async rpc(method: string) {
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "thread/start") return { thread: { id: "t" } };
      if (method === "turn/start") {
        setTimeout(
          () =>
            events.emit("message", {
              method: "item/completed",
              params: {
                threadId: "t",
                turnId: "u",
                item: { type: "agentMessage", text: '{"text":"answer"}' },
              },
            }),
          60,
        );
        setTimeout(
          () =>
            events.emit("message", {
              method: "turn/completed",
              params: { threadId: "t", turn: { id: "u", status: "completed" } },
            }),
          70,
        );
        return { turn: { id: "u" } };
      }
      if (method === "turn/interrupt") {
        interrupts++;
        return {};
      }
    },
  };
  const ledger = new BudgetLedger("managed", async () => {});
  ledger.state.timing = timing;
  const result = await ledger.call(
    new CodexProvider(() => client, 5),
    "teaching",
    "",
    {},
    schema,
    new AbortController().signal,
    options,
  );
  assert.equal(result.output.text, "answer");
  assert.equal(interrupts, 0);
  assert.ok(ledger.state.attempts[0].observation?.validatedOutputAt);
});
test("nested training ledger counts the same call while inheriting upstream timing and cancellation", async () => {
  let managed: boolean | undefined;
  const inner: Provider = {
    model: "fixture",
    async generate(_i, _x, s, _signal, _image, observe, control) {
      managed = control?.managedTiming;
      observe?.({
        type: "output",
        text: '{"text":"answer"}',
        at: new Date().toISOString(),
      });
      return { output: s.parse({ text: "answer" }) };
    },
  };
  const budget = new BudgetLedger("batch", async () => {}).state;
  const batch: TrainingBatch = {
    id: "batch",
    phase: "M2",
    status: "running",
    cycleLimit: 70,
    budget,
  };
  const counted = new TrainingProvider(
    inner,
    batch,
    async () => {},
    async () => {},
    () => budget.attempts.length,
  );
  const ledger = new BudgetLedger("task", async () => {});
  ledger.state.timing = timing;
  await ledger.call(
    counted,
    "generation",
    "",
    {},
    schema,
    new AbortController().signal,
    options,
  );
  assert.equal(managed, true);
  assert.equal(budget.attempts.length, 1);
  assert.equal(ledger.state.attempts.length, 1);
});
test("two-page diagnostic uses real generation/check/revision/recheck, retains drafts, and omits novice and full speech", async () => {
  const deck = { slides: structuredClone(defaultDeck.slides.slice(0, 2)) };
  const unit = {
    ...exampleUnits.paper,
    sections: exampleUnits.paper.sections.slice(0, 1),
    terms: [],
  };
  const issue = {
    id: "gap",
    location: deck.slides[0].title,
    type: "teaching",
    evidence: [],
    suggestion: "补充解释",
    severity: "warning",
    resolved: false,
  };
  const outputs = [
    { unit, deck },
    { issues: [issue], checkedSources: [], limitations: [] },
    { unit, deck },
    { issues: [], checkedSources: [], limitations: [] },
  ];
  const inputs: any[] = [];
  const provider: Provider = {
    model: "fixture",
    async generate(_i, x, s) {
      inputs.push(structuredClone(x));
      return { output: s.parse(outputs.shift()) };
    },
  };
  const manager = new TaskManager(provider, async () => {});
  const run = await manager.start(
    {
      paperId: sample.id,
      module: "ppt",
      mode: "live",
      question: "解释此图",
      profileId: "beginner",
      sourceIds: sample.sources.map((s) => s.id),
      taughtConcepts: [],
      checks: { readability: false },
      diagnosticScope: "fragment-v1",
    },
    sample,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.calls, 4);
  assert.equal(
    run.roles.some((r) => r.role.startsWith("novice")),
    false,
  );
  assert.equal(inputs[0].speechScript, false);
  assert.equal(inputs[1].question, "解释此图");
  assert.equal(run.budget!.limit, 4);
  assert.ok(run.revisionTrace);
  assert.equal(run.deck?.speechScript, undefined);
});
for (const issueType of ["material", "teaching"] as const)
  test(`revision and final check restore paper context for ${issueType} issues`, async () => {
    const paper = {
      ...sample,
      sources: [
        ...sample.sources.map((s, i) =>
          i
            ? s
            : {
                ...s,
                title: "PDF 第 1 页",
                page: 1,
                text:
                  "Earlier context. ".repeat(250) +
                  "Hidden intervention identity.",
              },
        ),
        ...Array.from({ length: 6 }, (_, i) => ({
          ...sample.sources[0],
          id: `extra-${i}`,
          title: `PDF 第 ${i + 2} 页`,
          page: i + 2,
          text: `Page ${i}. ` + "Unrelated narrative. ".repeat(230),
        })),
      ],
    };
    const inputs: any[] = [];
    const issue = {
      id: "identity",
      location: "干预",
      type: issueType,
      evidence: ["xu-question"],
      suggestion: "请提供核心干预身份的原文。",
      severity: "warning",
      resolved: false,
    };
    const outputs = [
      { unit: exampleUnits.paper, deck: null },
      { issues: [issue], checkedSources: [], limitations: [] },
      { unit: exampleUnits.paper, deck: null },
      {
        issues: [{ ...issue, resolved: true }],
        checkedSources: [],
        limitations: [],
      },
    ];
    const provider: Provider = {
      model: "fixture",
      async generate(_i, x, s) {
        inputs.push(structuredClone(x));
        return { output: s.parse(outputs.shift()) };
      },
    };
    const manager = new TaskManager(provider, async () => {});
    const run = await manager.start(
      {
        paperId: paper.id,
        module: "paper",
        mode: "live",
        question: "说明干预",
        profileId: "beginner",
        sourceIds: paper.sources.map((s) => s.id),
        taughtConcepts: [],
        checks: { readability: false },
      },
      paper,
    );
    await manager.wait(run.id);
    assert.equal(run.status, "completed", run.error);
    assert.equal(inputs.length, 4);
    assert.ok(
      !JSON.stringify(inputs[0].sources.blocks).includes("Hidden intervention"),
    );
    assert.ok(
      JSON.stringify(inputs[2].sources.blocks).includes("Hidden intervention"),
    );
    assert.deepEqual(inputs[3].sources, inputs[2].sources);
    if (issueType === "material") {
      assert.equal(run.materialRequests?.[0].kind, "paper");
      assert.equal(run.materialRequests?.[0].status, "resolved");
      assert.deepEqual(run.materialRequests?.[0].matchedIds, ["xu-question"]);
    } else assert.deepEqual(run.materialRequests, []);
  });

test("external pause reaches research-plan provider, saves partial attempt and permits no hidden retry", async () => {
  const records = new Map<string, any>();
  let started!: () => void;
  const ready = new Promise<void>((done) => (started = done));
  const provider: Provider = {
    model: "fixture",
    generate(_i, _x, _s, signal, _image, observe) {
      started();
      observe?.({
        type: "output",
        at: new Date().toISOString(),
        text: '{"title":"partial',
      });
      return new Promise((_ok, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            observe?.({
              type: "terminal",
              at: new Date().toISOString(),
              status: "interrupted",
            });
            reject(new Error("cancelled"));
          },
          { once: true },
        ),
      );
    },
  };
  const plans = new ResearchPlans(
    provider,
    async () => sample,
    undefined,
    async (g, id, value) => {
      records.set(`${g}/${id}`, structuredClone(value));
    },
  );
  const plan = await plans.create({
    question: "蛋白信号为什么变化",
    conditions: "设备未知",
    studyTypes: ["basic-translational"],
    typeStatus: "provisional",
    sources: [],
  });
  const controller = new AbortController();
  const job = await plans.start(
    plan.id,
    {
      requestKey: "pause-test",
      expectedVersion: null,
      expectedTopicVersion: plan.topic.version,
      action: "generate",
      maxCalls: 4,
    },
    { signal: controller.signal },
  );
  await ready;
  controller.abort();
  await plans.wait(job.id);
  const done = plans.job(job.id);
  assert.equal(done.status, "cancelled");
  assert.equal(done.budget.attempts.length, 1);
  assert.equal(done.budget.attempts[0].rawOutput, '{"title":"partial');
  assert.equal(
    done.budget.attempts[0].observation?.remoteTerminal,
    "interrupted",
  );
  assert.equal(records.get(`research-plan-jobs/${job.id}`).status, "cancelled");
});

test("different ranges of the same PDF page have distinct identities and export checks retain the complete caption", () => {
  const page = (n: number, text: string) => ({
    ...sample.sources[0],
    id: `p${n}`,
    page: n,
    text,
  });
  const paper = {
    ...sample,
    id: "train-xu",
    sources: [
      page(3, "Dasatinib plus quercetin reduces burden. N AT u RE"),
      page(4, "eliminate senescent cells. We next examined another target."),
      page(
        7,
        "Clearance of senescent cells improves function. To further test another target.",
      ),
      page(
        8,
        "Fig. 6 | Complete caption, axis units and two-tailed tests. N AT u RE",
      ),
      {
        ...page(8, "Truncated caption."),
        id: "fig6",
        figure: "6",
        image: "data:image/png;base64,fixture",
      },
      page(
        12,
        "Physical function measurements. Treadmill acclimation. N AT u RE",
      ),
      page(
        13,
        "day, mice ran on the treadmill. Formula and units. Real-time PCR. Other method. Statistical analysis. Tests and replicates. Reporting Summary.",
      ),
    ],
  };
  const frozen = freezeFragment(paper, "figure-6f");
  assert.equal(
    new Set(frozen.sources.map((s) => s.id)).size,
    frozen.sources.length,
  );
  assert.equal(frozen.sources.filter((s) => s.page === 13).length, 2);
  assert.ok(
    frozen.sources
      .find((s) => s.figure === "6")!
      .caption!.includes("two-tailed"),
  );
  const run = {
    input: { paperId: frozen.id },
    sourceVersion: frozen.version,
    materials: [{ sources: frozen.sources.map(({ image, ...s }) => s) }],
  } as unknown as import("../shared/types.ts").TaskRun;
  assert.equal(materialSources(run, frozen).length, frozen.sources.length);
  const changed = structuredClone(frozen);
  changed.sources[0].text += "changed";
  assert.throws(() => materialSources(run, changed), /资料已发生变化/);
});

test("an upstream timeout stays unknown in the counted ledger and carries the same timeout layer", async () => {
  const inner: Provider = {
    model: "fixture",
    generate(_i, _x, _s, signal, _image, observe) {
      observe?.({ type: "output", at: new Date().toISOString(), text: "{" });
      return new Promise((_ok, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            observe?.({
              type: "terminal",
              at: new Date().toISOString(),
              status: "interrupted",
            });
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
  };
  const budget = new BudgetLedger("counted", async () => {}).state;
  const batch: TrainingBatch = {
    id: "counted",
    phase: "M2",
    status: "running",
    cycleLimit: 70,
    budget,
  };
  const counted = new TrainingProvider(
    inner,
    batch,
    async () => {},
    async () => {},
    () => budget.attempts.length,
  );
  const ledger = new BudgetLedger("outer", async () => {});
  ledger.state.timing = { ...timing, idleMs: 30 };
  await assert.rejects(
    ledger.call(
      counted,
      "generate",
      "",
      {},
      schema,
      new AbortController().signal,
      options,
    ),
  );
  assert.equal(ledger.state.attempts[0].status, "unknown");
  assert.equal(budget.attempts[0].status, "unknown");
  assert.equal(budget.attempts[0].observation?.timeoutLayer, "output-idle");
  assert.equal(budget.attempts[0].observation?.remoteTerminal, "interrupted");
});
