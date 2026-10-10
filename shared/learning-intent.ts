import type { ExplanationDepth, LearningPreferences } from "./types.ts";

export const verbosityLabels = {
  brief: "简洁",
  standard: "常规",
  deep: "深入",
} as const;
export const focusLabels = {
  balanced: "综合理解",
  foundations: "补基础",
  "research-reasoning": "研究思路",
  "methods-figures": "方法与图表",
  mechanism: "机制",
} as const;
export function legacyPreferences(
  depth?: ExplanationDepth,
): LearningPreferences {
  return {
    verbosity: depth === "brief" || depth === "deep" ? depth : "standard",
    focus:
      depth === "foundations" || depth === "mechanism" ? depth : "balanced",
  };
}
export function legacyDepth(
  preferences: LearningPreferences,
): ExplanationDepth {
  return preferences.focus === "foundations" ||
    preferences.focus === "mechanism"
    ? preferences.focus
    : preferences.verbosity;
}
