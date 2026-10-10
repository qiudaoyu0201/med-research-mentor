import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { BudgetLedger } from "../server/budget.ts";
import { ProviderFailure, type Provider } from "../server/provider.ts";

const options = {
  groupId: "main",
  sourceHash: "source",
  skillHash: "rules",
  recoverTransport: true,
};
function harness(
  terminal = "failed",
  text = "",
  message = "stream disconnected: network error",
) {
  let calls = 0;
  const provider: Provider = {
    model: "fixture",
    async generate(_rules, _input, schema, _signal, _image, observe) {
      calls++;
      if (calls === 2) return { output: schema.parse({ answer: "ok" }) };
      if (text)
        observe?.({ type: "output", at: new Date().toISOString(), text });
      if (terminal)
        observe?.({
          type: "terminal",
          at: new Date().toISOString(),
          status: terminal,
        });
      throw new ProviderFailure(message, "transport", text);
    },
  };
  const ledger = new BudgetLedger("turn", async () => {});
  const invoke = (settings = options) =>
    ledger.call(
      provider,
      "teaching",
      "rules",
      {},
      z.object({ answer: z.string() }),
      new AbortController().signal,
      settings,
    );
  return { ledger, invoke, calls: () => calls };
}

test("confirmed empty network failure gets one separately counted recovery and retains unknown usage", async () => {
  const h = harness();
  assert.equal((await h.invoke()).output.answer, "ok");
  assert.equal(h.calls(), 2);
  assert.deepEqual(
    h.ledger.state.attempts.map((a) => a.status),
    ["unknown", "succeeded"],
  );
  assert.equal(h.ledger.state.attempts[0].tokens.total, null);
  assert.equal(
    h.ledger.state.transportRecoveryOf,
    h.ledger.state.attempts[0].id,
  );
  await assert.rejects(h.invoke());
  assert.equal(h.calls(), 3);
});

test("partial output, uncertain remote state, account rejection, disabled recovery and exhausted budget never resend", async () => {
  for (const [terminal, text, message] of [
    ["failed", "partial", "network error"],
    ["", "", "network error"],
    ["interrupted", "", "network error"],
    ["failed", "", "network error 429 quota"],
    ["failed", "", "invalid schema"],
  ]) {
    const h = harness(terminal, text, message);
    await assert.rejects(h.invoke());
    assert.equal(h.calls(), 1);
  }
  const disabled = harness();
  await assert.rejects(
    disabled.invoke({ ...options, recoverTransport: false }),
  );
  assert.equal(disabled.calls(), 1);
  const capped = harness();
  capped.ledger.state.limit = 1;
  await assert.rejects(capped.invoke());
  assert.equal(capped.calls(), 1);
  const grouped = harness();
  grouped.ledger.state.groupLimit = 1;
  await assert.rejects(grouped.invoke());
  assert.equal(grouped.calls(), 1);
});

test("cancellation during recovery delay prevents a second dispatch", async () => {
  const controller = new AbortController();
  let calls = 0;
  const ledger = new BudgetLedger("cancel", async () => {
    if (ledger.state.transportRecoveryOf) controller.abort();
  });
  const provider: Provider = {
    model: "fixture",
    async generate(_a, _b, _c, _d, _e, observe) {
      calls++;
      observe?.({
        type: "terminal",
        status: "failed",
        at: new Date().toISOString(),
      });
      throw new ProviderFailure("network error", "transport", "");
    },
  };
  await assert.rejects(
    ledger.call(
      provider,
      "teaching",
      "rules",
      {},
      z.object({ answer: z.string() }),
      controller.signal,
      options,
    ),
  );
  assert.equal(calls, 1);
});
