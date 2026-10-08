import type { TaskTiming } from "../shared/types.ts";
import type { ProviderEvent } from "./provider.ts";
export class TaskDeadline extends Error {
  constructor(readonly layer: string) {
    super(`任务达到${layer}期限；保留输出，不自动重发。`);
  }
}

export function taskTiming(scope: TaskTiming["scope"], size = 1): TaskTiming {
  if (scope === "explanation")
    return {
      version: "task-timing-v1",
      scope,
      taskMs: 480_000,
      requestMs: 180_000,
      firstOutputMs: 120_000,
      idleMs: 60_000,
      diagnosisMs: 90_000,
    };
  if (scope === "fragment")
    return {
      version: "task-timing-v1",
      scope,
      taskMs: 600_000,
      requestMs: 300_000,
      firstOutputMs: 240_000,
      idleMs: 90_000,
    };
  return {
    version: "task-timing-v1",
    scope,
    taskMs: Math.min(2_400_000, 600_000 + Math.max(1, size) * 90_000),
    requestMs: 720_000,
    firstOutputMs: 300_000,
    idleMs: 120_000,
  };
}

// The ledger owns deadlines. RPC acknowledgments and token events cannot keep
// a stalled output alive; only growth of the actual output resets inactivity.
export function watchRequest(
  signal: AbortSignal,
  deadline: string,
  timing: Pick<
    TaskTiming,
    "requestMs" | "firstOutputMs" | "idleMs" | "diagnosisMs"
  >,
  emit: (event: ProviderEvent) => void,
) {
  const controller = new AbortController();
  const timers = new Set<NodeJS.Timeout>();
  let outputTimer: NodeJS.Timeout | undefined,
    outputLength = 0;
  const after = (ms: number, work: () => void) => {
    const timer = setTimeout(work, Math.max(0, ms));
    timers.add(timer);
    return timer;
  };
  const stop = (layer: string) => {
    if (controller.signal.aborted || signal.aborted) return;
    emit({ type: "timeout", at: new Date().toISOString(), layer });
    controller.abort(new TaskDeadline(layer));
  };
  after(Date.parse(deadline) - Date.now(), () => stop("task-total"));
  after(timing.requestMs, () => stop("request-total"));
  outputTimer = after(timing.firstOutputMs, () => stop("first-output"));
  if (timing.diagnosisMs)
    after(timing.diagnosisMs, () => {
      if (!controller.signal.aborted && !signal.aborted)
        emit({
          type: "diagnosis",
          at: new Date().toISOString(),
          layer: "response-target",
        });
    });
  return {
    signal: AbortSignal.any([signal, controller.signal]),
    observe(event: ProviderEvent) {
      if (event.type !== "output" || (event.text?.length ?? 0) <= outputLength)
        return;
      outputLength = event.text!.length;
      if (outputTimer) {
        clearTimeout(outputTimer);
        timers.delete(outputTimer);
      }
      outputTimer = after(timing.idleMs, () => stop("output-idle"));
    },
    close() {
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}
