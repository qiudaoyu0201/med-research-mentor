import type { ExplanationDepth, AssistantMessage } from "../shared/types.ts";
import type {
  ConversationState,
  LearningIntent,
  LearningPreferences,
} from "../shared/types.ts";
import { legacyPreferences } from "../shared/learning-intent.ts";
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

export function requestedPreferences(
  message: AssistantMessage,
): Partial<LearningPreferences> {
  const question = message.question;
  const preferences: Partial<LearningPreferences> = {};
  if (/简单[点些一]|简短[点些一]|通俗[点些一]|简化|一句话|简洁/.test(question))
    preferences.verbosity = "brief";
  if (/详细[点些一]|展开[点些一]|更详细|深入[点些一]/.test(question))
    preferences.verbosity = "deep";
  if (/常规讲|正常讲/.test(question)) preferences.verbosity = "standard";
  if (/从基础|从头讲|从零|先补基础|补基础/.test(question))
    preferences.focus = "foundations";
  if (/研究思路|研究设计|设计逻辑/.test(question))
    preferences.focus = "research-reasoning";
  if (/重点.*(?:方法|图表)|(?:方法|图表).*重点/.test(question))
    preferences.focus = "methods-figures";
  if (/重点.*机制|机制.*重点|深入.*机制/.test(question))
    preferences.focus = "mechanism";
  if (/综合理解/.test(question)) preferences.focus = "balanced";
  // Old fields only fill dimensions that have no new explicit or natural-language choice.
  const legacy =
    message.depth && !message.learningIntent
      ? message.depth === "foundations" || message.depth === "mechanism"
        ? { focus: message.depth }
        : { verbosity: message.depth }
      : {};
  const explicit = message.learningIntent;
  return {
    ...legacy,
    ...preferences,
    ...(explicit?.verbosity ? { verbosity: explicit.verbosity } : {}),
    ...(explicit?.focus ? { focus: explicit.focus } : {}),
  };
}

export function resolveLearningIntent(
  message: AssistantMessage,
  state: ConversationState,
): LearningIntent {
  const preferences = {
    ...(state.learningPreferences ?? legacyPreferences(state.explanationDepth)),
    ...requestedPreferences(message),
  };
  const goal =
    message.learningIntent?.goal ??
    (message.module === "ppt" ||
    message.deckEdit ||
    /PPT|汇报|讲稿/i.test(message.question)
      ? "report"
      : /我的(?:研究|课题)|自己的(?:研究|课题)/.test(message.question)
        ? "discuss-research"
        : /迁移|举一反三|运用到|应用到|借鉴到/.test(message.question)
          ? "transfer"
          : "understand");
  return {
    ...preferences,
    version: "1",
    goal,
    scope: {
      paperId: state.paperId,
      sourceVersion: state.sourceVersion,
      sourceIds: message.sourceIds ?? [],
      selection:
        message.sourceAnchor?.excerpt ?? message.focus?.excerpt ?? null,
      artifactVersion: message.deckEdit?.versionId ?? null,
    },
    backgroundRef: state.profileId,
    preferenceScope:
      message.learningIntent?.preferenceScope ??
      (/以后|今后|接下来都|始终|一直用/.test(message.question)
        ? "conversation"
        : "turn"),
  };
}
