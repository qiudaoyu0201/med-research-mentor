import { z } from "zod";
import { CodexProvider } from "./provider.ts";
import { CompatibleProvider } from "./compatible-provider.ts";

const configuration = z.object({
  baseUrl: z.string().url(),
  model: z.string().trim().min(1).max(150),
  apiKey: z.string().trim().min(1),
  images: z.boolean(),
  outputMode: z.enum(["json_object", "json_schema"]),
  maxInputChars: z.coerce.number().int().min(1000).max(1_000_000),
  maxOutputTokens: z.coerce.number().int().min(256).max(32768),
});
export type CompatibleConfiguration = z.infer<typeof configuration>;

export function createProvider(env: NodeJS.ProcessEnv = process.env) {
  const selected = env.TUTOR_PROVIDER ?? "codex";
  if (selected === "codex") return new CodexProvider();
  if (selected === "codex-configured") {
    const parsed = z
      .object({
        model: z.string().trim().min(1).max(150),
        modelProvider: z.string().regex(/^[A-Za-z0-9_-]+$/),
        authType: z.literal("apiKey"),
      })
      .safeParse({
        model: env.TUTOR_MODEL,
        modelProvider: env.TUTOR_CODEX_PROVIDER,
        authType: env.TUTOR_CODEX_AUTH,
      });
    if (!parsed.success)
      throw new Error(
        "复用 Codex 配置须显式设置 TUTOR_MODEL、TUTOR_CODEX_PROVIDER 和 TUTOR_CODEX_AUTH=apiKey；原生订阅请使用 TUTOR_PROVIDER=codex，不会猜测账费通道。",
      );
    return new CodexProvider(undefined, undefined, parsed.data);
  }
  if (selected !== "compatible")
    throw new Error(
      "TUTOR_PROVIDER 必须为 codex、codex-configured 或 compatible。",
    );
  const parsed = configuration.safeParse({
    baseUrl: env.TUTOR_MODEL_BASE_URL,
    model: env.TUTOR_MODEL,
    apiKey: env.TUTOR_MODEL_API_KEY,
    images: env.TUTOR_MODEL_IMAGES === "true",
    outputMode: env.TUTOR_MODEL_OUTPUT_MODE ?? "json_object",
    maxInputChars: env.TUTOR_MODEL_MAX_INPUT_CHARS ?? 100_000,
    maxOutputTokens: env.TUTOR_MODEL_MAX_OUTPUT_TOKENS ?? 8192,
  });
  if (!parsed.success)
    throw new Error(
      "国内兼容接入配置不完整或无效；请检查 TUTOR_MODEL_* 配置，不会回退模型。",
    );
  const url = new URL(parsed.data.baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("模型地址须为不含凭据、查询或片段的 HTTPS API 基础地址。");
  if (
    env.TUTOR_MODEL_IMAGES &&
    !["true", "false"].includes(env.TUTOR_MODEL_IMAGES)
  )
    throw new Error("TUTOR_MODEL_IMAGES 必须为 true 或 false。");
  return new CompatibleProvider(parsed.data);
}
