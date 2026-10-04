import { z } from "zod";
const citations = z.array(z.string()).max(20);
export const unitSchema = z.object({
  title: z.string().min(1).max(160),
  question: z.string().max(2000),
  sections: z
    .array(
      z.object({
        title: z.string().max(160),
        text: z.string().min(1).max(4000),
        kind: z.enum(["paper", "foundation", "interpretation"]),
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
export const inputSchema = z.object({
  paperId: z.string().min(1),
  module: z.enum(["paper", "method", "figure", "ppt"]),
  mode: z.enum(["example", "live"]),
  question: z.string().min(1).max(2000),
  profileId: z.enum(["beginner", "methods", "reasoning"]),
  sourceIds: citations,
  taughtConcepts: z.array(z.string().max(150)).max(20),
  previous: unitSchema.optional(),
  visibleImage: z
    .string()
    .regex(/^data:image\/(png|jpeg);base64,/)
    .max(3_000_000)
    .optional(),
});
