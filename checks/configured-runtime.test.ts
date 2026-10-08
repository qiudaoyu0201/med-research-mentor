import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  CodexClient,
  CodexProvider,
  publicProviderDiagnostic,
} from "../server/provider.ts";
import { createProvider } from "../server/model-config.ts";

const configuration = {
  model: "fixture-model",
  modelProvider: "relay",
  authType: "apiKey" as const,
};
function clientFixture(
  authType = "apiKey",
  configuredProvider = "relay",
  tool = false,
) {
  const events = new EventEmitter();
  const requests: { method: string; params: any }[] = [];
  return {
    events,
    requests,
    async init() {},
    close() {},
    async rpc(method: string, params: any) {
      requests.push({ method, params });
      if (method === "account/read") return { account: { type: authType } };
      if (method === "model/list")
        return {
          data: [
            {
              id: "fixture-model",
              model: "fixture-model",
              displayName: "Fixture",
            },
          ],
        };
      if (method === "config/read")
        return {
          config: {
            model_provider: configuredProvider,
            model_providers: {
              relay: {
                wire_api: "responses",
                experimental_bearer_token: "must-not-be-logged",
              },
            },
          },
        };
      if (method === "thread/start") return { thread: { id: "thread" } };
      if (method === "turn/start") {
        setTimeout(() => {
          if (tool)
            events.emit("message", {
              method: "item/started",
              params: {
                threadId: "thread",
                turnId: "turn",
                item: { type: "commandExecution" },
              },
            });
          else {
            events.emit("message", {
              method: "item/completed",
              params: {
                threadId: "thread",
                turnId: "turn",
                item: { type: "agentMessage", text: '{"answer":"ok"}' },
              },
            });
            events.emit("message", {
              method: "turn/completed",
              params: {
                threadId: "thread",
                turn: { id: "turn", status: "completed" },
              },
            });
          }
        }, 5);
        return { turn: { id: "turn" } };
      }
      if (method === "turn/interrupt") {
        setTimeout(
          () =>
            events.emit("message", {
              method: "turn/completed",
              params: {
                threadId: "thread",
                turn: { id: "turn", status: "interrupted" },
              },
            }),
          1,
        );
        return {};
      }
      throw new Error("Unexpected request " + method);
    },
  };
}
const schema = z.object({ answer: z.string() });

test("provider diagnostics redact returned endpoints and common credential formats", () => {
  const result = publicProviderDiagnostic(
    'HTTP 401 https://u:password@example.test/v1?key=private Bearer secret_token api_key="private_value" sk-private123456789',
  );
  for (const secret of ["password", "private", "secret_token", "example.test"])
    assert.ok(!result.includes(secret));
  assert.match(result, /HTTP 401/);
});

test("existing Codex relay requires explicit provider, model and billing auth selection", () => {
  assert.throws(
    () => createProvider({ TUTOR_PROVIDER: "codex-configured" }),
    /显式/,
  );
  const env = {
    TUTOR_PROVIDER: "codex-configured",
    TUTOR_MODEL: "fixture-model",
    TUTOR_CODEX_PROVIDER: "relay",
    TUTOR_CODEX_AUTH: "apiKey",
  };
  const provider = createProvider(env);
  assert.equal(provider.id, "codex-configured:relay");
  assert.equal(provider.model, "fixture-model");
  assert.equal(provider.billingMode, "api");
  assert.throws(
    () => createProvider({ ...env, TUTOR_CODEX_AUTH: "chatgpt" }),
    /apiKey/,
  );
  assert.throws(
    () =>
      createProvider({
        ...env,
        TUTOR_CODEX_PROVIDER: "relay.request_max_retries",
      }),
    /显式/,
  );
  assert.equal(createProvider({}).id, "codex-chatgpt");
});

test("relay authenticates configured account without exporting secrets or enabling tools/retries", async () => {
  const client = clientFixture();
  const provider = new CodexProvider(() => client, 2000, configuration);
  const info = await provider.inspect();
  assert.equal(info.authenticated, true);
  assert.equal(info.billingMode, "api");
  assert.ok(!JSON.stringify(info).includes("must-not-be-logged"));
  assert.deepEqual(
    (
      await provider.generate(
        "instructions",
        {},
        schema,
        new AbortController().signal,
      )
    ).output,
    { answer: "ok" },
  );
  const started = client.requests.find(
    (r) => r.method === "thread/start",
  )!.params;
  assert.equal(started.modelProvider, "relay");
  assert.equal(started.model, "fixture-model");
  assert.equal(started.allowProviderModelFallback, false);
  assert.equal(started.config["model_providers.relay.request_max_retries"], 0);
  assert.equal(started.config["model_providers.relay.stream_max_retries"], 0);
  assert.equal(started.config["features.shell_tool"], false);
  assert.deepEqual(started.dynamicTools, []);
  assert.equal(
    client.requests.filter((r) => r.method === "turn/start").length,
    1,
  );
});

test("account/provider mismatch fails before a generated turn and cannot fall back", async () => {
  for (const client of [
    clientFixture("chatgpt"),
    clientFixture("apiKey", "other"),
  ]) {
    const provider = new CodexProvider(() => client, 2000, configuration);
    await assert.rejects(
      provider.generate("", {}, schema, new AbortController().signal),
      /不一致/,
    );
    assert.ok(
      !client.requests.some(
        (r) => r.method === "thread/start" || r.method === "turn/start",
      ),
    );
  }
});

test("relay still interrupts a disallowed tool request without retrying", async () => {
  const client = clientFixture("apiKey", "relay", true);
  const provider = new CodexProvider(() => client, 2000, configuration);
  await assert.rejects(
    provider.generate("", {}, schema, new AbortController().signal),
    /未授权工具/,
  );
  assert.equal(
    client.requests.filter((r) => r.method === "turn/start").length,
    1,
  );
  assert.equal(
    client.requests.filter((r) => r.method === "turn/interrupt").length,
    1,
  );
});

test("unavailable Codex executable rejects pending and later RPC calls without hanging", async () => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = "tutor-runtime-test-nonexistent-codex-executable";
  const client = new CodexClient();
  try {
    await assert.rejects(client.init(), /进程不可用/);
    await assert.rejects(client.rpc("account/read", {}), /已经关闭/);
  } finally {
    client.close();
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});
