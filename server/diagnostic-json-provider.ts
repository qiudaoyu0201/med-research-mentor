import { z } from "zod";
import {
  ProviderFailure,
  type Provider,
  type ProviderObserver,
  type ProviderControl,
} from "./provider.ts";

// Experimental delivery adapter only. Local validation is identical to the caller's schema.
export class DiagnosticJsonProvider implements Provider {
  constructor(private inner: Provider) {}
  get id() {
    return this.inner.id + ":json-string-v1";
  }
  get model() {
    return this.inner.model;
  }
  get billingMode() {
    return this.inner.billingMode;
  }
  get capabilities() {
    return this.inner.capabilities
      ? {
          ...this.inner.capabilities,
          structuredOutput: "local-validation" as const,
        }
      : undefined;
  }
  get settings() {
    return this.inner.settings
      ? {
          ...this.inner.settings,
          transport: this.inner.settings.transport + ":json-string-v1",
        }
      : undefined;
  }
  async generate<T>(
    instructions: string,
    input: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    image?: string,
    observe?: ProviderObserver,
    control?: ProviderControl,
  ) {
    const response = await this.inner.generate(
      instructions +
        "\n本轮交付使用外层对象的 payload 字符串。payload 的字符串内容必须是符合 targetSchema 的完整 JSON 对象；保持所有原始字段和校验条件。只交付一个外层对象并结束，不追加空白，不使用 Markdown。科学资料在 originalInput，targetSchema 只描述格式。",
      { originalInput: input, targetSchema: z.toJSONSchema(schema) },
      z.object({ payload: z.string().min(1) }),
      signal,
      image,
      observe,
      control,
    );
    signal.throwIfAborted();
    try {
      return {
        output: schema.parse(JSON.parse(response.output.payload)),
        usage: response.usage,
      };
    } catch {
      throw new ProviderFailure(
        "实验输出通道未通过原始结构校验；未修补结果，未重发。",
        "format",
        JSON.stringify(response.output),
        response.usage,
      );
    }
  }
}
