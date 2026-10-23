import { z } from "zod";
import { studyTypeIds } from "../shared/research-plan.ts";
export const researchId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const preferences = z
  .object({
    verbosity: z.enum(["brief", "standard", "deep"]),
    focus: z.enum([
      "balanced",
      "foundations",
      "research-reasoning",
      "methods-figures",
      "mechanism",
    ]),
  })
  .strict();
export const topicInputSchema = z
  .object({
    question: text(3000),
    conditions: z.string().trim().max(5000).default(""),
    studyTypes: z
      .array(z.enum(studyTypeIds))
      .max(studyTypeIds.length)
      .default([]),
    typeStatus: z
      .enum(["confirmed", "provisional", "unknown"])
      .default("unknown"),
    sources: z
      .array(
        z
          .object({
            paperId: researchId,
            sourceVersion: text(200),
            sourceId: text(200),
            range: z.object({ start: z.number().int().min(0), end: z.number().int().positive() }).strict()
              .refine((r) => r.end > r.start, { message: "来源字符范围无效" }).optional(),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    learningPreferences: preferences.default({
      verbosity: "standard",
      focus: "research-reasoning",
    }),
  })
  .strict()
  .refine(
    (x) =>
      x.typeStatus === "unknown"
        ? x.studyTypes.length === 0
        : x.studyTypes.length > 0,
    { message: "研究类型和确认状态不一致" },
  );
export const sectionSchema = z
  .object({
    id: researchId,
    title: text(160),
    text: text(6000),
    rationale: z.string().trim().max(3000),
    kind: z.enum(["proposal", "hypothesis", "source-fact", "possible-result"]),
    sourceRefs: z.array(researchId).max(12),
    unknowns: z.array(text(500)).max(10),
  })
  .strict();
export const planContentSchema = z
  .object({
    title: text(200),
    sections: z.array(sectionSchema).min(1).max(12),
    assumptions: z.array(text(500)).max(15),
    questions: z.array(text(500)).max(3),
    limitations: z.array(text(700)).max(15),
  })
  .strict()
  .refine(
    (x) => new Set(x.sections.map((s) => s.id)).size === x.sections.length,
    { message: "章节 ID 重复" },
  );
export function groundedPlanContentSchema(sourceIds: string[]) {
  const refs = z
    .array(sourceIds.length ? z.enum(sourceIds) : researchId)
    .max(sourceIds.length ? 12 : 0, "章节引用了未提供的来源。");
  return planContentSchema.safeExtend({
    sections: z
      .array(sectionSchema.extend({ sourceRefs: refs }))
      .min(1)
      .max(12),
  });
}
export const planReviewSchema = z
  .object({
    issues: z
      .array(
        z
          .object({
            id: researchId,
            sectionId: researchId,
            severity: z.enum(["blocking", "warning"]),
            message: text(1500),
            evidence: z.array(researchId).max(12),
          })
          .strict(),
      )
      .max(30),
    checkedSourceRefs: z.array(researchId).max(12),
    limitations: z.array(text(1000)).min(1).max(20),
  })
  .strict();
export function groundedPlanReviewSchema(
  sectionIds: string[],
  sourceIds: string[],
) {
  const refs = z
    .array(sourceIds.length ? z.enum(sourceIds) : researchId)
    .max(sourceIds.length ? 12 : 0);
  return planReviewSchema.extend({
    issues: z
      .array(
        planReviewSchema.shape.issues.element.extend({
          sectionId: z.enum(sectionIds),
          evidence: refs,
        }),
      )
      .max(30),
    checkedSourceRefs: refs,
  });
}
export const planJobInputSchema = z
  .object({
    retrieveLiterature: z.boolean().default(false),
    requestKey: researchId,
    expectedVersion: researchId.nullable(),
    expectedTopicVersion: researchId,
    action: z.enum(["generate", "revise", "review"]),
    instruction: z.string().trim().max(3000).default(""),
    sectionId: researchId.optional(),
    requestedScope: z
      .enum(["direction", "design-draft", "full-plan"])
      .default("design-draft"),
    maxCalls: z.union([z.literal(2), z.literal(4)]).default(4),
  })
  .strict();
export const planSaveInputSchema = z
  .object({
    expectedVersion: researchId.nullable(),
    expectedTopicVersion: researchId,
    content: planContentSchema,
  })
  .strict();
export type TopicInput = z.infer<typeof topicInputSchema>;
export type PlanJobInput = z.infer<typeof planJobInputSchema>;
