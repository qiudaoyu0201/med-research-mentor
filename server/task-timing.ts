import type { TaskTiming } from "../shared/types.ts";
import type { ProviderEvent } from "./provider.ts";
export class TaskDeadline extends Error {
  constructor(readonly layer: string) {
    const labels: Record<string, string> = {
      "task-total": "整轮任务达到等待上限",
      "request-total": "本次模型请求达到等待上限",
      "first-output": "等待模型首段正文超时",
      "output-idle": "模型长时间没有新增正文",
    };
    super(`${labels[layer] ?? layer}；已保留现有输出，未自动重发。`);
  }
}

export function taskTiming(
  scope: TaskTiming["scope"],
  size = 1,
  deliveryPolicy: "internal" | "online" = "internal",
  environment: NodeJS.ProcessEnv = process.env,
): TaskTiming {
  const configure = (timing: TaskTiming) => {
    const prefix = `TUTOR_${deliveryPolicy.toUpperCase()}`;
    const fields = {
      taskMs: "TASK_MS",
      requestMs: "REQUEST_MS",
      firstOutputMs: "FIRST_OUTPUT_MS",
      idleMs: "IDLE_MS",
    } as const;
    for (const field of Object.keys(fields) as (keyof typeof fields)[]) {
      const name = `${prefix}_${fields[field]}`;
      const raw = environment[name];
      if (raw === undefined) continue;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
        throw new Error(`${name} 必须是有效的正整数毫秒数。`);
      timing[field] = value;
    }
    return timing;
  };
  if (deliveryPolicy === "online")
    return configure({
      version: "task-timing-v1",
      scope,
      taskMs:
        scope === "full"
          ? Math.min(5_400_000, 2_700_000 + Math.max(1, size) * 180_000)
          : 2_700_000,
      requestMs: scope === "full" ? 1_200_000 : 900_000,
      firstOutputMs: scope === "full" ? 600_000 : 300_000,
      idleMs: scope === "full" ? 600_000 : 300_000,
      ...(scope === "explanation" ? { diagnosisMs: 90_000 } : {}),
    });
  if (scope === "explanation")
    return configure({
      version: "task-timing-v1",
      scope,
      taskMs: 480_000,
      requestMs: 180_000,
      firstOutputMs: 120_000,
      idleMs: 60_000,
      diagnosisMs: 90_000,
    });
  if (scope === "fragment")
    return configure({
      version: "task-timing-v1",
      scope,
      taskMs: 600_000,
      requestMs: 300_000,
      firstOutputMs: 240_000,
      idleMs: 90_000,
    });
  return configure({
    version: "task-timing-v1",
    scope,
    taskMs: Math.min(2_400_000, 600_000 + Math.max(1, size) * 90_000),
    requestMs: 720_000,
    firstOutputMs: 300_000,
    idleMs: 120_000,
  });
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
      // Some structured-output streams keep emitting whitespace after the JSON.
      // Preserve those raw bytes in the ledger, but do not treat them as progress.
      const meaningfulLength =
        event.type === "output" ? (event.text?.trimEnd().length ?? 0) : 0;
      if (event.type !== "output" || meaningfulLength <= outputLength) return;
      outputLength = meaningfulLength;
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
