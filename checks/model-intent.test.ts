import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { CompatibleProvider } from "../server/compatible-provider.ts";
import {
  createProvider,
  type CompatibleConfiguration,
} from "../server/model-config.ts";
import { BudgetLedger } from "../server/budget.ts";
import { ProviderFailure } from "../server/provider.ts";
import { legacyPreferences } from "../shared/learning-intent.ts";
import { messageSchema, preferencesSchema } from "../server/schemas.ts";
import { resolveLearningIntent } from "../server/depth.ts";
import { ConversationStore } from "../server/conversation.ts";
import { ReadingGuides } from "../server/reading-guides.ts";
import { TaskScheduler } from "../server/scheduler.ts";
import type { PaperBundle } from "../shared/types.ts";

const config: CompatibleConfiguration = {
  baseUrl: "https://domestic.example.test/v1",
  model: "local-vl-fixture",
  apiKey: "private-test-key",
  images: true,
  outputMode: "json_object",
  maxInputChars: 100_000,
  maxOutputTokens: 8192,
};
const schema = z.object({ answer: z.string().min(1) });
const usage = {
  prompt_tokens: 23,
  completion_tokens: 9,
  total_tokens: 32,
  prompt_tokens_details: { cached_tokens: 7 },
};
function transport(
  result = {
    choices: [
      { message: { content: '{"answer":"两组"}' }, finish_reason: "stop" },
    ],
    usage,
  },
  status = 200,
) {
  const requests: { url: string; init: RequestInit }[] = [];
  const request = (async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return Response.json(result, { status });
  }) as typeof fetch;
  return { request, requests };
}
const meta = { groupId: "group", sourceHash: "source", skillHash: "skill" };

test("legacy mappings and intent priority preserve independent dimensions and reject forged scope", async () => {
  for (const [depth, preference] of Object.entries({
    brief: { verbosity: "brief", focus: "balanced" },
    standard: { verbosity: "standard", focus: "balanced" },
    deep: { verbosity: "deep", focus: "balanced" },
    foundations: { verbosity: "standard", focus: "foundations" },
    mechanism: { verbosity: "standard", focus: "mechanism" },
  }))
    assert.deepEqual(legacyPreferences(depth as any), preference);
  const store = new ConversationStore(async () => {}),
    state = await store.create();
  state.learningPreferences = {
    verbosity: "deep",
    focus: "research-reasoning",
  };
  const intent = resolveLearningIntent(
    {
      clientMessageId: "choice",
      mode: "live",
      question: "这一段简单点",
      depth: "mechanism",
      learningIntent: { verbosity: "standard" },
    },
    state,
  );
  assert.equal(intent.verbosity, "standard");
  assert.equal(intent.focus, "research-reasoning");
  assert.equal(intent.preferenceScope, "turn");
  assert.equal(
    resolveLearningIntent(
      {
        clientMessageId: "transfer",
        mode: "live",
        question: "应用到新的测量中",
      },
      state,
    ).goal,
    "transfer",
  );
  assert.equal(
    resolveLearningIntent(
      { clientMessageId: "my-study", mode: "live", question: "讨论我的课题" },
      state,
    ).goal,
    "discuss-research",
  );
  assert.throws(() =>
    messageSchema.parse({
      clientMessageId: "forge",
      question: "提问",
      learningIntent: { scope: { paperId: "foreign" } },
    }),
  );
  assert.throws(() =>
    preferencesSchema.parse({ learningPreferences: { focus: "invalid" } }),
  );
});

test("provider configuration is explicit, secrets stay server-side and invalid selection cannot fall back", async () => {
  assert.equal(createProvider({}).id, "codex-chatgpt");
  assert.throws(
    () => createProvider({ TUTOR_PROVIDER: "unknown" }),
    /TUTOR_PROVIDER/,
  );
  assert.throws(() => createProvider({ TUTOR_PROVIDER: "compatible" }), /配置/);
  const env = {
    TUTOR_PROVIDER: "compatible",
    TUTOR_MODEL_BASE_URL: config.baseUrl,
    TUTOR_MODEL: config.model,
    TUTOR_MODEL_API_KEY: config.apiKey,
    TUTOR_MODEL_IMAGES: "true",
  };
  const provider = createProvider(env);
  const info = await provider.inspect();
  assert.equal(info.authenticated, false);
  assert.ok(!JSON.stringify(info).includes(config.apiKey));
  for (const url of [
    "http://insecure.test/v1",
    "https://user:password@example.test/v1",
    "https://example.test/v1?key=private",
  ])
    assert.throws(
      () => createProvider({ ...env, TUTOR_MODEL_BASE_URL: url }),
      /HTTPS/,
    );
  assert.throws(
    () => createProvider({ ...env, TUTOR_MODEL_IMAGES: "yes" }),
    /true/,
  );
});

test("compatible text/image requests share the budget and normalize actual API usage", async () => {
  const t = transport(),
    provider = new CompatibleProvider(config, t.request),
    ledger = new BudgetLedger("turn", async () => {});
  const signal = new AbortController().signal;
  const image = "data:image/png;base64,AA==";
  const result = await ledger.call(
    provider,
    "teaching",
    "rules",
    { question: "两组?" },
    schema,
    signal,
    { ...meta, image },
  );
  assert.equal(result.output.answer, "两组");
  assert.equal(t.requests.length, 1);
  const request = t.requests[0],
    body = JSON.parse(String(request.init.body));
  assert.equal(request.url, config.baseUrl + "/chat/completions");
  assert.equal(request.init.redirect, "error");
  assert.deepEqual(body.messages[1].content[1], {
    type: "image_url",
    image_url: { url: image },
  });
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.tools, undefined);
  assert.equal(body.stream, false);
  assert.equal(ledger.state.billingMode, "api");
  assert.equal(ledger.state.amount, null);
  assert.equal(ledger.state.attempts[0].providerId, provider.id);
  assert.deepEqual(ledger.state.attempts[0].tokens, {
    input: 23,
    output: 9,
    total: 32,
    cachedInput: 7,
  });
});

test("native schema mode sends strict objects while images/context limits stop before transport", async () => {
  const t = transport(),
    provider = new CompatibleProvider(
      { ...config, outputMode: "json_schema" },
      t.request,
    );
  await provider.generate("rules", {}, schema, new AbortController().signal);
  const format = JSON.parse(String(t.requests[0].init.body)).response_format;
  assert.equal(format.json_schema.strict, true);
  assert.equal(format.json_schema.schema.additionalProperties, false);
  const noImages = new CompatibleProvider(
    { ...config, images: false },
    t.request,
  );
  await assert.rejects(
    noImages.generate(
      "rules",
      {},
      schema,
      new AbortController().signal,
      "data:image/png;base64,AA==",
    ),
    /图像/,
  );
  const limited = new CompatibleProvider(
    { ...config, maxInputChars: 10 },
    t.request,
  );
  await assert.rejects(
    limited.generate("rules", {}, schema, new AbortController().signal),
    /额度/,
  );
  assert.equal(t.requests.length, 1);
});

test("invalid JSON, schema failure, tools and truncation retain attempts with no retry", async () => {
  for (const choice of [
    { message: { content: "not-json" }, finish_reason: "stop" },
    { message: { content: '{"answer":123}' }, finish_reason: "stop" },
    {
      message: { content: '{"answer":"x"}', tool_calls: [{}] },
      finish_reason: "stop",
    },
    { message: { content: '{"answer":"x"}' }, finish_reason: "length" },
  ]) {
    const t = transport({ choices: [choice], usage } as any),
      provider = new CompatibleProvider(config, t.request),
      ledger = new BudgetLedger("turn", async () => {});
    await assert.rejects(
      ledger.call(
        provider,
        "teaching",
        "rules",
        {},
        schema,
        new AbortController().signal,
        meta,
      ),
      ProviderFailure,
    );
    assert.equal(t.requests.length, 1);
    assert.equal(ledger.state.attempts.length, 1);
    assert.equal(ledger.state.attempts[0].status, "failed");
    assert.equal(ledger.state.attempts[0].tokens.input, 23);
  }
});

test("HTTP errors hide returned secrets and transport uncertainty never retries", async () => {
  const t = transport({ error: config.apiKey } as any, 401),
    provider = new CompatibleProvider(config, t.request),
    ledger = new BudgetLedger("turn", async () => {});
  await assert.rejects(
    ledger.call(
      provider,
      "teaching",
      "rules",
      {},
      schema,
      new AbortController().signal,
      meta,
    ),
    /HTTP 401/,
  );
  assert.equal(t.requests.length, 1);
  assert.equal(ledger.state.attempts[0].status, "unknown");
  assert.ok(!JSON.stringify(ledger.state).includes(config.apiKey));
});

test("empty or null successful HTTP envelopes fail format validation without retry", async () => {
  for (const response of [null, {}, { choices: [] }]) {
    const t = transport(response as any),
      provider = new CompatibleProvider(config, t.request),
      ledger = new BudgetLedger("turn", async () => {});
    await assert.rejects(
      ledger.call(
        provider,
        "teaching",
        "rules",
        {},
        schema,
        new AbortController().signal,
        meta,
      ),
      ProviderFailure,
    );
    assert.equal(t.requests.length, 1);
    assert.equal(ledger.state.attempts[0].status, "failed");
  }
});

test("cancelling compatible generation aborts the request and stops later calls", async () => {
  let started!: () => void,
    received = 0;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const request = (async (_url, init) => {
    received++;
    started();
    return await new Promise<Response>((_resolve, reject) =>
      init!.signal!.addEventListener(
        "abort",
        () => reject(init!.signal!.reason),
        { once: true },
      ),
    );
  }) as typeof fetch;
  const provider = new CompatibleProvider(config, request),
    ledger = new BudgetLedger("turn", async () => {}),
    controller = new AbortController();
  const pending = ledger.call(
    provider,
    "teaching",
    "rules",
    {},
    schema,
    controller.signal,
    meta,
  );
  await ready;
  controller.abort();
  await assert.rejects(pending);
  await assert.rejects(
    ledger.call(
      provider,
      "novice",
      "rules",
      {},
      schema,
      controller.signal,
      meta,
    ),
  );
  assert.equal(received, 1);
  assert.equal(ledger.state.attempts.length, 1);
  assert.equal(ledger.state.attempts[0].status, "cancelled");
});

test("reading guide caches separate provider identity, model and settings and preserve excerpt coverage", async () => {
  const paper: PaperBundle = {
    id: "paper",
    title: "Paper",
    version: "1",
    scope: "excerpts",
    sources: Array.from({ length: 12 }, (_, i) => ({
      id: `s-${i}`,
      kind: "paper",
      title: `Page ${i}`,
      locator: `Page ${i}`,
      text: "x".repeat(2000),
      verified: false,
    })),
  };
  const provider = {
    id: "a",
    model: "same-model",
    settings: { effort: "low", imageMode: "original", transport: "a" },
    async generate<T>(_rules: string, input: any, s: z.ZodType<T>) {
      return {
        output: s.parse({
          summary: "片段概述",
          sourceIds: [input.sources[0].id],
          questions: ["研究问题？"],
        }),
      };
    },
  };
  const guides = new ReadingGuides(
    provider,
    new TaskScheduler(),
    async () => {},
  );
  await guides.start(paper);
  for (let i = 0; i < 100 && guides.get(paper).status !== "completed"; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(guides.get(paper).status, "completed");
  assert.equal(guides.get(paper).coverage!.sourceIds.length, 10);
  assert.equal(guides.get(paper).coverage!.truncatedSourceIds.length, 10);
  assert.equal(guides.get(paper).coverage!.availableSources, 12);
  assert.equal(guides.get(paper).coverage!.fullText, false);
  provider.id = "b";
  assert.equal(guides.get(paper).summary, undefined);
  provider.id = "a";
  provider.model = "new-model";
  assert.equal(guides.get(paper).summary, undefined);
  provider.model = "same-model";
  provider.settings.effort = "high";
  assert.equal(guides.get(paper).summary, undefined);
});
