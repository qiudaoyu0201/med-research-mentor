import { randomUUID } from "node:crypto";
import type { Attempt, BudgetState, TokenUsage } from "../shared/types.ts";
import type { Provider } from "./provider.ts";
import { ProviderFailure } from "./provider.ts";
import type { z } from "zod";

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
    options: {
      groupId?: string;
      image?: string;
      sourceHash: string;
      skillHash: string;
      onReserved?: (attempt: Attempt) => Promise<void>;
    },
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
    this.reserving = true;
    this.state.billingMode = provider.billingMode ?? "chatgpt";
    this.state.attempts.push(attempt);
    try {
      await this.persist(); // Persist the reservation before sending anything to the provider.
      await options.onReserved?.(attempt);
    } finally {
      this.reserving = false;
    }
    const deadline = Math.min(
      options.groupId ? 180_000 : 60_000,
      Date.parse(this.state.deadline) - Date.now(),
    );
    if (signal.aborted || deadline <= 0) {
      attempt.status = signal.aborted ? "cancelled" : "failed";
      attempt.error = signal.aborted
        ? "预算预留后取消，未发送生成请求。"
        : "保存预算期间超过总时长，未发送生成请求。";
      await this.persist();
      throw new Error(attempt.error);
    }
    const timed = AbortSignal.any([signal, AbortSignal.timeout(deadline)]);
    const started = Date.now();
    let abortListener: (() => void) | undefined;
    try {
      const result = await Promise.race([
        provider.generate(instructions, input, schema, timed, options.image),
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(timed.reason);
          timed.addEventListener("abort", abortListener, { once: true });
          if (timed.aborted) abortListener();
        }),
      ]);
      timed.throwIfAborted();
      attempt.usage = result.usage;
      attempt.tokens = normalizeUsage(result.usage);
      attempt.outputChars = JSON.stringify(result.output).length;
      attempt.status = "succeeded";
      return result;
    } catch (error) {
      attempt.status = signal.aborted
        ? "cancelled"
        : timed.aborted || !(error instanceof ProviderFailure)
          ? "unknown"
          : error.kind === "format"
            ? "failed"
            : "unknown";
      attempt.error = error instanceof Error ? error.message : "生成失败";
      if (error instanceof ProviderFailure) {
        attempt.rawOutput = error.rawOutput;
        attempt.usage = error.usage;
        attempt.tokens = normalizeUsage(error.usage);
        attempt.outputChars = error.rawOutput?.length ?? 0;
      }
      throw error;
    } finally {
      if (abortListener) timed.removeEventListener("abort", abortListener);
      attempt.durationMs = Date.now() - started;
      await this.persist();
    }
  }
}
