import test from "node:test";
import assert from "node:assert/strict";
import { taskTiming, watchRequest } from "../server/task-timing.ts";
import type { ProviderEvent } from "../server/provider.ts";

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
