import { randomUUID } from "node:crypto";
import type { Attempt, BudgetState, TokenUsage } from "../shared/types.ts";
import type { Provider, ProviderObserver } from "./provider.ts";
import { ProviderFailure } from "./provider.ts";
import type { z } from "zod";
import { watchRequest, TaskDeadline, taskTiming } from "./task-timing.ts";
import { setTimeout as delay } from "node:timers/promises";

interface CallOptions {
  groupId?: string;
  image?: string;
  sourceHash: string;
  skillHash: string;
  onReserved?: (attempt: Attempt) => Promise<void>;
  observe?: ProviderObserver;
  managedTiming?: boolean;
  recoverTransport?: boolean;
}

// Each provider turn uses a fresh thread. Prefer its increment, never add cumulative updates.
export function normalizeUsage(raw: any): TokenUsage {
  const value = raw?.last ?? raw?.total ?? raw ?? {};
  const number = (...keys: string[]) => {
    for (const key of keys)
      if (typeof value[key] === "number" && value[key] >= 0) return value[key];
    return null;
  };
  return {
    input: number("inputTokens", "input_tokens", "prompt_tokens"),
    output: number("outputTokens", "output_tokens", "completion_tokens"),
    cachedInput:
      number("cachedInputTokens", "cached_input_tokens") ??
      (typeof value.prompt_tokens_details?.cached_tokens === "number" &&
      value.prompt_tokens_details.cached_tokens >= 0
        ? value.prompt_tokens_details.cached_tokens
        : null),
    total: number("totalTokens", "total_tokens"),
  };
}
export class BudgetLedger {
  readonly state: BudgetState;
  private reserving = false;
  constructor(
    private turnId: string,
    private persist: () => Promise<void>,
    state?: BudgetState,
    timeoutMs = 480_000,
  ) {
    this.state = state ?? {
      limit: 7,
      groupLimit: 6,
      deadline: new Date(Date.now() + timeoutMs).toISOString(),
      attempts: [],
      revisions: [],
      billingMode: "chatgpt",
      amount: null,
    };
  }
  async revise(groupId: string) {
    if (this.state.revisions.includes(groupId))
      throw new Error("每个任务组最多修订一次。");
    this.state.revisions.push(groupId);
    await this.persist();
  }
  async call<T>(
    provider: Provider,
    role: string,
    instructions: string,
    input: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: CallOptions,
  ): Promise<{ output: T; usage?: unknown }> {
    const before = this.state.attempts.length;
    try {
      return await this.callOnce(
        provider,
        role,
        instructions,
        input,
        schema,
        signal,
        options,
      );
    } catch (error) {
      const failed = this.state.attempts.at(-1);
      if (
        !options.recoverTransport ||
        this.state.transportRecoveryOf ||
        signal.aborted ||
        !(error instanceof ProviderFailure) ||
        error.kind !== "transport" ||
        this.state.attempts.length !== before + 1 ||
        !failed ||
        failed.observation?.remoteTerminal !== "failed" ||
        failed.outputChars > 0 ||
        failed.observation.outputUpdates > 0 ||
        failed.observation.timeoutLayer ||
        !/stream disconnected|network error|error sending request|error decoding response body/i.test(
          error.message,
        ) ||
        /401|403|429|quota|rate.limit|unauthori|authentication/i.test(
          error.message,
        ) ||
        !options.groupId ||
        this.state.attempts.length >= this.state.limit ||
        this.state.attempts.filter((a) => a.groupId === options.groupId)
          .length >= this.state.groupLimit ||
        Date.parse(this.state.deadline) - Date.now() < 5000
      )
        throw error;
      // Persist once-per-task recovery and retain the failed attempt's unknown usage.
      this.state.transportRecoveryOf = failed.id;
      await this.persist();
      await delay(750, undefined, { signal });
      return this.callOnce(
        provider,
        role,
        instructions,
        input,
        schema,
        signal,
        options,
      );
    }
  }
  private async callOnce<T>(
    provider: Provider,
    role: string,
    instructions: string,
    input: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    options: CallOptions,
  ) {
    signal.throwIfAborted();
    const remaining = Date.parse(this.state.deadline) - Date.now();
    if (remaining <= 0) throw new Error("请求已超过总时长额度。");
    if (this.reserving) throw new Error("预算预留正在保存，请等待。");
    if (
      this.state.attempts.length >= this.state.limit ||
      (options.groupId &&
        this.state.attempts.filter((a) => a.groupId === options.groupId)
          .length >= this.state.groupLimit) ||
      (!options.groupId && this.state.attempts.some((a) => a.groupId === null))
    )
      throw new Error("已达到请求或阶段生成上限。");
    const attempt: Attempt = {
      providerId: provider.id,
      id: randomUUID(),
      turnId: this.turnId,
      groupId: options.groupId ?? null,
      role,
      model: provider.model,
      modelSettings: provider.settings,
      imageCount: options.image ? 1 : 0,
      sourceHash: options.sourceHash,
      skillHash: options.skillHash,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      status: "reserved",
      inputChars: instructions.length + JSON.stringify(input).length,
      outputChars: 0,
      tokens: normalizeUsage(null),
    };
    if (!options.managedTiming) {
      const timing = (this.state.timing ??= taskTiming("explanation"));
      attempt.timing = {
        ...timing,
        firstOutputMs:
          provider.capabilities?.streaming === false
            ? timing.requestMs
            : timing.firstOutputMs,
      };
    }
    this.reserving = true;
    this.state.billingMode = provider.billingMode ?? "chatgpt";
    this.state.attempts.push(attempt);
    try {
      await this.persist(); // Persist the reservation before sending anything to the provider.
      await options.onReserved?.(attempt);
    } finally {
      this.reserving = false;
    }
    const remainingAfterReservation =
      Date.parse(this.state.deadline) - Date.now();
    if (signal.aborted || remainingAfterReservation <= 0) {
      attempt.status = signal.aborted ? "cancelled" : "failed";
      attempt.error = signal.aborted
        ? "预算预留后取消，未发送生成请求。"
        : "保存预算期间超过总时长，未发送生成请求。";
      await this.persist();
      throw new Error(attempt.error);
    }
    // A counted training wrapper inherits the upstream signal instead of
    // competing with another fixed timer. Direct calls get one ledger watchdog.
    let watch: ReturnType<typeof watchRequest> | undefined;
    const timed = options.managedTiming
      ? signal
      : (watch = watchRequest(
          signal,
          this.state.deadline,
          attempt.timing!,
          (event) => observe(event),
        )).signal;
    const started = Date.now();
    let abortListener: (() => void) | undefined;
    let observationWrites = Promise.resolve();
    let lastObservationWrite = 0;
    let observationClosed = false;
    let meaningfulOutputLength = 0;
    const observe: ProviderObserver = (event) => {
      if (observationClosed) return;
      watch?.observe(event);
      const observation = (attempt.observation ??= {
        outputUpdates: 0,
        events: [],
      });
      observation.lastActivityAt = event.at;
      if (observation.lastMeaningfulOutputAt) {
        const gap =
          Date.parse(event.at) - Date.parse(observation.lastMeaningfulOutputAt);
        if (Number.isFinite(gap) && gap >= 0)
          observation.maxOutputGapMs = Math.max(
            observation.maxOutputGapMs ?? 0,
            gap,
          );
      }
      if (event.threadId) observation.threadId = event.threadId;
      if (event.turnId) observation.turnId = event.turnId;
      if (event.type === "response") observation.firstResponseAt ??= event.at;
      if (event.type === "output") {
        observation.firstOutputAt ??= event.at;
        observation.outputUpdates++;
        attempt.rawOutput = event.text;
        attempt.outputChars = event.text?.length ?? 0;
        const length = event.text?.trimEnd().length ?? 0;
        if (length > meaningfulOutputLength) {
          meaningfulOutputLength = length;
          observation.firstMeaningfulOutputAt ??= event.at;
          observation.lastMeaningfulOutputAt = event.at;
          observation.maxOutputGapMs ??= 0;
        }
      }
      if (event.type === "usage") {
        attempt.usage = event.usage;
        attempt.tokens = normalizeUsage(event.usage);
      }
      if (event.type === "timeout") observation.timeoutLayer = event.layer;
      if (event.type === "interrupt")
        observation.interruptAcknowledged = event.status === "acknowledged";
      if (event.type === "terminal") observation.remoteTerminal = event.status;
      // Output growth is summarized; avoid duplicating every streamed fragment in the ledger.
      if (
        event.type !== "output" &&
        (event.type !== "response" ||
          !observation.events.some((e) => e.type === "response"))
      )
        observation.events.push({
          type: event.type,
          at: event.at,
          status: event.status,
          layer: event.layer,
        });
      options.observe?.(event);
      if (
        Date.now() - lastObservationWrite >= 1000 ||
        ["terminal", "interrupt", "usage"].includes(event.type)
      ) {
        lastObservationWrite = Date.now();
        observationWrites = observationWrites.then(() => this.persist());
        // Handled here, then surfaced again before final persistence.
        void observationWrites.catch(() => {});
      }
    };
    const pending = Promise.resolve().then(() =>
      provider.generate(
        instructions,
        input,
        schema,
        timed,
        options.image,
        observe,
        { managedTiming: true },
      ),
    );
    // An abort must give cooperative providers time to capture interrupt/terminal events.
    // Providers that ignore cancellation still cannot hold the ledger indefinitely.
    const settled = pending.then(
      () => {},
      () => {},
    );
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          abortListener = () => {
            if (signal.aborted)
              observe({
                type:
                  signal.reason instanceof TaskDeadline ? "timeout" : "cancel",
                at: new Date().toISOString(),
                layer:
                  signal.reason instanceof TaskDeadline
                    ? signal.reason.layer
                    : "external",
              });
            const grace = setTimeout(() => reject(timed.reason), 5500);
            void settled.then(() => {
              clearTimeout(grace);
              reject(timed.reason);
            });
          };
          timed.addEventListener("abort", abortListener, { once: true });
          if (timed.aborted) abortListener();
        }),
      ]);
      timed.throwIfAborted();
      attempt.usage = result.usage ?? attempt.usage;
      attempt.tokens = normalizeUsage(attempt.usage);
      attempt.outputChars = JSON.stringify(result.output).length;
      attempt.status = "succeeded";
      (attempt.observation ??= {
        outputUpdates: 0,
        events: [],
      }).validatedOutputAt = new Date().toISOString();
      return result;
    } catch (error) {
      attempt.status =
        signal.aborted && !(signal.reason instanceof TaskDeadline)
          ? "cancelled"
          : timed.aborted || !(error instanceof ProviderFailure)
            ? "unknown"
            : error.kind === "format"
              ? "failed"
              : "unknown";
      attempt.error = error instanceof Error ? error.message : "生成失败";
      if (error instanceof ProviderFailure) {
        if (error.rawOutput !== undefined) {
          attempt.rawOutput = error.rawOutput;
          attempt.outputChars = error.rawOutput.length;
        }
        if (error.usage !== undefined) {
          attempt.usage = error.usage;
          attempt.tokens = normalizeUsage(error.usage);
        }
      }
      throw error;
    } finally {
      if (abortListener) timed.removeEventListener("abort", abortListener);
      observationClosed = true;
      watch?.close();
      attempt.durationMs = Date.now() - started;
      await observationWrites.catch(() => {});
      await this.persist();
    }
  }
}
