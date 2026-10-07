import type { TrainingBatch } from "./internal-training.ts";
export function trainingCost(batches: TrainingBatch[], priorAttempts = 0) {
  const attempts = batches.flatMap((b) => b.budget.attempts);
  const statuses = Object.fromEntries(
    ["reserved", "succeeded", "failed", "cancelled", "unknown"].map(
      (status) => [status, attempts.filter((a) => a.status === status).length],
    ),
  );
  const tokens = Object.fromEntries(
    ["input", "output", "cachedInput", "total"].map((key) => {
      const values = attempts.map(
        (a) => a.tokens[key as keyof typeof a.tokens],
      );
      const known = values.filter((v): v is number => typeof v === "number");
      return [
        key,
        {
          reportedSum: known.length ? known.reduce((a, b) => a + b, 0) : null,
          reportedAttempts: known.length,
          unreportedAttempts: values.length - known.length,
        },
      ];
    }),
  );
  return {
    currentAttempts: attempts.length,
    priorAttempts,
    firstRoundAttempts: attempts.length + priorAttempts,
    productLimit: 108,
    remainingProductAttempts: Math.max(
      0,
      108 - attempts.length - priorAttempts,
    ),
    statuses,
    tokens,
    providerMs: attempts.reduce((n, a) => n + a.durationMs, 0),
    inputChars: attempts.reduce((n, a) => n + a.inputChars, 0),
    billingModes: [...new Set(batches.map((b) => b.budget.billingMode))],
    amount: null,
    amountReason: "未取得可核对账单；订阅调用不换算成虚构现金费用。",
    maxConcurrentProductRequests: 1,
  };
}
