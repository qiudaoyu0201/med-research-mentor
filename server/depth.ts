import type { ExplanationDepth, AssistantMessage } from "../shared/types.ts";
export function requestedDepth(
  question: string,
  explicit?: AssistantMessage["depth"],
): ExplanationDepth | undefined {
  if (explicit) return explicit;
  if (/从基础|从头讲|从零|先补基础/.test(question)) return "foundations";
  if (/重点.*机制|机制.*重点|深入.*机制/.test(question)) return "mechanism";
  if (/简单[点些一]|简短[点些一]|通俗[点些一]|简化|一句话/.test(question))
    return "brief";
  if (/详细[点些一]|展开[点些一]|更详细|深入[点些一]/.test(question))
    return "deep";
  return undefined;
}
