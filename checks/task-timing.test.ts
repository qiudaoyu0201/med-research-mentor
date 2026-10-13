import test from "node:test";
import assert from "node:assert/strict";
import { taskTiming, watchRequest } from "../server/task-timing.ts";
import type { ProviderEvent } from "../server/provider.ts";
import { BudgetLedger } from "../server/budget.ts";
import { z } from "zod";
import {
  reserveUnit,
  type TrainingBatch,
} from "../server/internal-training.ts";

for (const scope of ["explanation", "fragment", "full"] as const) {
  test(`online ${scope} tolerates slow first output and pauses beyond the former limits`, (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const timing = taskTiming(scope, 1, "online");
    const events: ProviderEvent[] = [];
    const watch = watchRequest(
      new AbortController().signal,
      new Date(timing.taskMs).toISOString(),
      timing,
      (event) => events.push(event),
    );
    try {
      context.mock.timers.tick(scope === "full" ? 300_001 : 240_001);
      assert.equal(watch.signal.aborted, false);
      watch.observe({
        type: "output",
        text: "partial",
        at: new Date().toISOString(),
      });
      context.mock.timers.tick(180_001);
      assert.equal(watch.signal.aborted, false);
      watch.observe({
        type: "output",
        text: "partial answer",
        at: new Date().toISOString(),
      });
      context.mock.timers.tick(timing.idleMs - 1);
      assert.equal(watch.signal.aborted, false);
      context.mock.timers.tick(1);
      assert.equal(watch.signal.aborted, true);
      assert.equal(events.at(-1)?.layer, "output-idle");
    } finally {
      watch.close();
    }
  });

  test(`online ${scope} still bounds silent requests and honors immediate manual cancellation`, (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const timing = taskTiming(scope, 1, "online");
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    const watch = watchRequest(
      controller.signal,
      new Date(timing.taskMs).toISOString(),
      timing,
      (event) => events.push(event),
    );
    try {
      context.mock.timers.tick(timing.firstOutputMs - 1);
      assert.equal(watch.signal.aborted, false);
      context.mock.timers.tick(1);
      assert.equal(watch.signal.aborted, true);
      assert.equal(events.at(-1)?.layer, "first-output");
    } finally {
      watch.close();
    }
    const cancelled = watchRequest(
      controller.signal,
      new Date(Date.now() + timing.taskMs).toISOString(),
      timing,
      () => {},
    );
    try {
      const reason = new Error("user cancelled");
      controller.abort(reason);
      assert.equal(cancelled.signal.aborted, true);
      assert.equal(cancelled.signal.reason, reason);
    } finally {
      cancelled.close();
    }
  });
}

test("continuing online output cannot extend the request limit or the task deadline", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const timing = taskTiming("explanation", 1, "online");
  for (const layer of ["request-total", "task-total"] as const) {
    const events: ProviderEvent[] = [];
    const limit =
      layer === "task-total" ? timing.requestMs / 2 : timing.requestMs;
    const watch = watchRequest(
      new AbortController().signal,
      new Date(
        Date.now() + (layer === "task-total" ? limit : timing.taskMs),
      ).toISOString(),
      timing,
      (event) => events.push(event),
    );
    try {
      for (let elapsed = 0; elapsed < limit; elapsed += 30_000) {
        watch.observe({
          type: "output",
          text: "x".repeat(elapsed + 1),
          at: new Date().toISOString(),
        });
        context.mock.timers.tick(30_000);
      }
      assert.equal(watch.signal.aborted, true);
      assert.equal(events.at(-1)?.layer, layer);
    } finally {
      watch.close();
    }
  }
});

test("online waiting does not change internal experiment timing", () => {
  for (const scope of ["explanation", "fragment", "full"] as const) {
    const internal = taskTiming(scope);
    assert.deepEqual(internal, taskTiming(scope, 1, "internal"));
    assert.equal(
      internal.idleMs,
      { explanation: 60_000, fragment: 90_000, full: 120_000 }[scope],
    );
    const online = taskTiming(scope, 1, "online");
    assert.ok(online.firstOutputMs > internal.firstOutputMs);
    assert.ok(online.idleMs > internal.idleMs);
    assert.ok(online.requestMs > internal.requestMs);
    assert.ok(online.taskMs > internal.taskMs);
  }
});

test("online and internal timing overrides remain independent and reject invalid timers", () => {
  const environment = {
    TUTOR_ONLINE_IDLE_MS: "240000",
    TUTOR_INTERNAL_IDLE_MS: "45000",
    TUTOR_INTERNAL_REQUEST_MS: "600000",
  };
  assert.equal(
    taskTiming("explanation", 1, "online", environment).idleMs,
    240000,
  );
  assert.equal(
    taskTiming("explanation", 1, "internal", environment).idleMs,
    45000,
  );
  assert.equal(
    taskTiming("explanation", 1, "internal", environment).requestMs,
    600000,
  );
  assert.equal(
    taskTiming("explanation", 1, "online", environment).requestMs,
    taskTiming("explanation", 1, "online", {}).requestMs,
  );
  for (const value of ["0", "-1", "NaN", "Infinity", "2147483648", "1.5", ""]) {
    assert.throws(
      () =>
        taskTiming("full", 8, "internal", { TUTOR_INTERNAL_IDLE_MS: value }),
      /TUTOR_INTERNAL_IDLE_MS/,
    );
  }
});

test("call observations measure meaningful output gaps without letting whitespace or heartbeats reset them", async () => {
  const ledger = new BudgetLedger("observation", async () => {});
  const events: ProviderEvent[] = [
    { type: "output", text: "   ", at: new Date(0).toISOString() },
    { type: "output", text: "a", at: new Date(1000).toISOString() },
    { type: "output", text: "a   ", at: new Date(61000).toISOString() },
    { type: "response", at: new Date(71000).toISOString() },
    { type: "output", text: "ab", at: new Date(91000).toISOString() },
    { type: "usage", at: new Date(101000).toISOString() },
    {
      type: "terminal",
      status: "completed",
      at: new Date(111000).toISOString(),
    },
  ];
  await ledger.call(
    {
      model: "fixture",
      async generate(_instructions, _input, schema, _signal, _image, observe) {
        for (const event of events) observe?.(event);
        return { output: schema.parse({ answer: "ab" }) };
      },
    },
    "fixture",
    "",
    {},
    z.object({ answer: z.string() }),
    new AbortController().signal,
    { groupId: "observation", sourceHash: "source", skillHash: "skill" },
  );
  const observation = ledger.state.attempts[0].observation!;
  assert.equal(
    observation.firstMeaningfulOutputAt,
    new Date(1000).toISOString(),
  );
  assert.equal(
    observation.lastMeaningfulOutputAt,
    new Date(91000).toISOString(),
  );
  assert.equal(observation.maxOutputGapMs, 90000);
});

test("buffered providers wait for the request limit instead of a streaming first-output deadline", async () => {
  const ledger = new BudgetLedger("buffered", async () => {});
  ledger.state.timing = {
    ...taskTiming("explanation"),
    taskMs: 1000,
    requestMs: 600,
    firstOutputMs: 20,
    idleMs: 100,
  };
  const result = await ledger.call(
    {
      model: "fixture",
      capabilities: {
        streaming: false,
        images: false,
        structuredOutput: "local-validation",
        cancellation: "abort-request",
        maxInputChars: 1000,
      },
      async generate(_instructions, _input, schema, signal) {
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        signal.throwIfAborted();
        return { output: schema.parse({ answer: "complete" }) };
      },
    },
    "fixture",
    "",
    {},
    z.object({ answer: z.string() }),
    new AbortController().signal,
    { groupId: "buffered", sourceHash: "source", skillHash: "skill" },
  );
  assert.equal(result.output.answer, "complete");
  assert.equal(ledger.state.attempts[0].status, "succeeded");
  assert.equal(ledger.state.attempts[0].timing?.firstOutputMs, 600);
  assert.equal(ledger.state.timing.firstOutputMs, 20);
});

test("internal unit admission reserves time using the experiment request limit", () => {
  const ledger = new BudgetLedger("admission", async () => {});
  ledger.state.timing = { ...taskTiming("explanation"), requestMs: 600_000 };
  ledger.state.deadline = new Date(Date.now() + 20 * 60_000).toISOString();
  const batch: TrainingBatch = {
    id: "admission",
    phase: "M1",
    status: "running",
    budget: ledger.state,
  };
  reserveUnit(batch, 1, 0);
  assert.throws(() => reserveUnit(batch, 2, 0));
});
