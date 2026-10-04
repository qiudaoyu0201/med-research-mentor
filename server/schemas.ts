import { z } from "zod";
import type { Source } from "../shared/types.ts";
const citations = z.array(z.string()).max(20);
const selectedSources = z.array(z.string()).max(100);
export const unitSchema = z.object({
  title: z.string().min(1).max(160),
  question: z.string().max(2000),
  sections: z
    .array(
      z.object({
        title: z.string().max(160),
        text: z.string().min(1).max(4000),
        kind: z.enum(["paper", "foundation", "interpretation", "background"]),
        citations,
      }),
    )
    .min(1)
    .max(10),
  terms: z
    .array(
      z.object({ name: z.string().max(100), explanation: z.string().max(800) }),
    )
    .max(15),
  nextQuestion: z.string().max(500),
});
export const noviceSchema = z.object({
  understood: z.array(z.string()).max(15),
  breakpoints: z
    .array(
      z.object({
        id: z.string(),
        sentence: z.string(),
        missingConcept: z.string(),
        question: z.string(),
        status: z.enum(["open", "resolved", "insufficient"]),
      }),
    )
    .max(15),
});
export const reviewSchema = z.object({
  issues: z
    .array(
      z.object({
        id: z.string(),
        location: z.string(),
        type: z.enum(["fact", "scope", "teaching", "material"]),
        evidence: citations,
        suggestion: z.string(),
        severity: z.enum(["blocking", "warning"]),
        resolved: z.boolean(),
      }),
    )
    .max(20),
  checkedSources: citations,
  limitations: z.array(z.string()).max(20),
});
export const slideSchema = z.object({
  title: z.string().min(1).max(65),
  bullets: z.array(z.string().max(140)).min(1).max(5),
  notes: z.string().min(1).max(2000),
  citations,
  imageSource: z.string().optional(),
});
export const deckSchema = z.object({
  slides: z.array(slideSchema).min(1).max(16),
});
export const teachingSchema = z.object({
  unit: unitSchema,
  deck: deckSchema.nullable(),
});
export const groundingContractVersion = "grounded-output-v3-background";
export function groundedTeachingSchema(sources: Source[]) {
  const ids = z.array(z.enum(sources.map((s) => s.id))).max(20);
  const sections = unitSchema.shape.sections.element.extend({ citations: ids });
  const slides = slideSchema.extend({
    citations: ids,
    imageSource: z
      .enum(["", ...sources.filter((s) => s.figure).map((s) => s.id)])
      .optional()
      .describe("仅写原图来源 ID；无图写空字符串，不能附说明。"),
  });
  return teachingSchema.extend({
    unit: unitSchema.extend({ sections: z.array(sections).min(1).max(10) }),
    deck: deckSchema
      .extend({ slides: z.array(slides).min(1).max(16) })
      .nullable(),
  });
}
export function groundedReviewSchema(sources: Source[]) {
  const ids = z.array(z.enum(sources.map((s) => s.id))).max(20);
  return reviewSchema.extend({
    issues: z
      .array(reviewSchema.shape.issues.element.extend({ evidence: ids }))
      .max(20),
    checkedSources: ids,
  });
}
export const inputSchema = z.object({
  paperId: z.string().min(1),
  module: z.enum(["paper", "method", "figure", "ppt"]),
  mode: z.enum(["example", "live"]),
  question: z.string().min(1).max(2000),
  profileId: z.enum(["beginner", "methods", "reasoning"]),
  sourceIds: selectedSources,
  taughtConcepts: z.array(z.string().max(150)).max(20),
  previous: unitSchema.optional(),
  conversationId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,100}$/)
    .optional(),
  clientMessageId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,100}$/)
    .optional(),
  visibleImage: z
    .string()
    .regex(/^data:image\/(png|jpeg);base64,/)
    .max(3_000_000)
    .optional(),
});
const recordId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const conversationSchema = z.object({
  paperId: recordId.nullable().optional(),
  goal: z.string().max(2000).optional(),
  profileId: z.enum(["beginner", "methods", "reasoning"]).optional(),
});
export const messageSchema = z.object({
  clientMessageId: recordId,
  question: z.string().trim().min(1).max(2000),
  mode: z.enum(["example", "live"]).default("live"),
  paperId: recordId.nullable().optional(),
  module: z.enum(["paper", "method", "figure", "ppt"]).optional(),
  sourceIds: selectedSources.optional(),
  profileId: z.enum(["beginner", "methods", "reasoning"]).optional(),
  visibleImage: inputSchema.shape.visibleImage,
  exportRunId: recordId.optional(),
  focus: z
    .object({
      runId: recordId,
      sectionIndex: z.number().int().min(0).max(9),
      excerpt: z.string().min(1).max(2000),
    })
    .optional(),
  depth: z.enum(["brief", "standard", "deep"]).optional(),
  readabilityCheck: z.boolean().optional(),
});
export const planSchema = z.object({
  goal: z.string().min(1).max(2000),
  modules: z.array(z.enum(["paper", "method", "figure", "ppt"])).max(4),
  sourceIds: selectedSources,
  slideCount: z.number().int().min(1).max(16).nullable(),
  groups: z
    .array(
      z.object({
        id: recordId,
        actions: z
          .array(
            z.enum([
              "paper.read",
              "method.explain",
              "figure.explain",
              "ppt.compose",
              "ppt.export",
              "material.request",
            ]),
          )
          .min(1)
          .max(6),
        dependsOn: z.array(recordId).max(1),
      }),
    )
    .max(1),
  clarification: z.string().min(1).max(500).nullable(),
  estimatedCalls: z.number().int().min(0).max(7),
});
