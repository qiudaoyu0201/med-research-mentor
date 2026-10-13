import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { DiagnosticJsonProvider } from "../server/diagnostic-json-provider.ts";
import { ProviderFailure, type Provider } from "../server/provider.ts";

test("diagnostic adapter changes only delivery format and dispatches exactly one request", async () => {
  let calls = 0;
  const schema = z.object({
    title: z.string().min(1),
    sources: z.array(z.enum(["s1"])),
  });
  const controller = new AbortController();
  const image = "data:image/png;base64,fixture";
  const observe = () => {};
  const control = { managedTiming: true as const };
  const provider: Provider = {
    id: "fixture",
    model: "gpt-6.1-sol",
    billingMode: "api",
    settings: { effort: "low", transport: "fixture", imageMode: "fixture" },
    async generate(
      instructions,
      input,
      wrapper,
      signal,
      receivedImage,
      receivedObserve,
      receivedControl,
    ) {
      calls++;
      assert.ok(instructions.startsWith("original rules"));
      assert.deepEqual((input as any).originalInput, { question: "question" });
      assert.deepEqual((input as any).targetSchema, z.toJSONSchema(schema));
      assert.equal(signal, controller.signal);
      assert.equal(receivedImage, image);
      assert.equal(receivedObserve, observe);
      assert.equal(receivedControl, control);
      return {
        output: wrapper.parse({
          payload: JSON.stringify({ title: "result", sources: ["s1"] }),
        }),
        usage: { total: 12 },
      };
    },
  };
  const adapted = new DiagnosticJsonProvider(provider);
  const result = await adapted.generate(
    "original rules",
    { question: "question" },
    schema,
    controller.signal,
    image,
    observe,
    control,
  );
  assert.equal(calls, 1);
  assert.equal(adapted.model, provider.model);
  assert.equal(adapted.billingMode, provider.billingMode);
  assert.deepEqual(result, {
    output: { title: "result", sources: ["s1"] },
    usage: { total: 12 },
  });
});

test("invalid, truncated, or fabricated source output is rejected without repair or retry", async () => {
  for (const payload of [
    '{"title":',
    '{"title":""}',
    '{"title":"ok","sources":["invented"]}',
    '{"title":"first\nsecond","sources":["real"]}',
    '{"title":"first\tsecond","sources":["real"]}',
  ]) {
    let calls = 0;
    const adapted = new DiagnosticJsonProvider({
      model: "gpt-6.1-sol",
      async generate(_rules, _input, schema) {
        calls++;
        return { output: schema.parse({ payload }), usage: { tokens: 8 } };
      },
    });
    await assert.rejects(
      adapted.generate(
        "rules",
        {},
        z.object({
          title: z.string().min(1),
          sources: z.array(z.enum(["real"])),
        }),
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof ProviderFailure &&
        error.kind === "format" &&
        error.rawOutput === JSON.stringify({ payload }) &&
        (error.usage as any).tokens === 8,
    );
    assert.equal(calls, 1);
  }
});

test("double JSON encoding preserves multiline scientific text, quotes, tabs and backslashes", async () => {
  const text = '首段。\n次段含"引号"、\t制表符与\\路径。';
  let calls = 0;
  const original = { title: text, sources: ["real"] };
  const adapted = new DiagnosticJsonProvider({
    id: "fixture",
    model: "gpt-6.1-sol",
    async generate(_rules, _input, schema) {
      calls++;
      // Simulate the native provider parsing its outer response once.
      const native = JSON.parse(
        JSON.stringify({ payload: JSON.stringify(original) }),
      );
      return { output: schema.parse(native) };
    },
  });
  const result = await adapted.generate(
    "rules",
    {},
    z.object({ title: z.string(), sources: z.array(z.enum(["real"])) }),
    new AbortController().signal,
  );
  assert.deepEqual(result.output, original);
  assert.equal(calls, 1);
  assert.equal(adapted.id, "fixture:json-string-v2");
});
