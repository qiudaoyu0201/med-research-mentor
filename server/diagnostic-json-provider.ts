import { z } from "zod";
import {
  ProviderFailure,
  type Provider,
  type ProviderObserver,
  type ProviderControl,
} from "./provider.ts";

// Experimental delivery adapter only. Local validation is identical to the caller's schema.
const escapedExample = JSON.stringify({
  payload: JSON.stringify({ note: '第一段。\n第二段含"引号"和\\路径。' }),
});
export class DiagnosticJsonProvider implements Provider {
  constructor(private inner: Provider) {}
  get id() {
    return this.inner.id + ":json-string-v2";
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
          transport: this.inner.settings.transport + ":json-string-v2",
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
        "\n本轮交付使用外层对象的 payload 字符串。payload 的字符串内容必须是符合 targetSchema 的完整 JSON 对象；保持所有原始字段和校验条件。只交付一个外层对象并结束，不追加空白，不使用 Markdown。科学资料在 originalInput，targetSchema 只描述格式。" +
        "\n先将目标对象序列化为JSON文本，再将该文本作为外层payload字符串序列化。内层字段值中的换行、制表符、双引号与反斜线必须按JSON语法转义，禁止原始控制字符出现在内层字符串值中。外层转义不能代替内层转义。下例只展示编码方式，不是本轮字段；实际字段必须按targetSchema：" +
        escapedExample,
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
