import { z } from "zod";
import type { Source } from "../shared/types.ts";
import { panelSelectionIds } from "./figure-panels.ts";
import { validRegion } from "../shared/image-region.ts";
export const imageRegionSchema = z
  .object({
    left: z.number(),
    top: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .refine(validRegion, "选区必须位于图像内且不为空。");
const citations = z.array(z.string()).max(20);
const selectedSources = z.array(z.string()).max(100);
export const learningPreferencesSchema = z.object({
  verbosity: z.enum(["brief", "standard", "deep"]),
  focus: z.enum([
    "balanced",
    "foundations",
    "research-reasoning",
    "methods-figures",
    "mechanism",
  ]),
});
export const learningRequestSchema = learningPreferencesSchema
  .partial()
  .extend({
    goal: z
      .enum(["understand", "transfer", "discuss-research", "report"])
      .optional(),
    preferenceScope: z.enum(["turn", "conversation"]).optional(),
  })
  .strict();
export const preferencesSchema = z
  .object({
    profileId: z.enum(["beginner", "methods", "reasoning"]).optional(),
    explanationDepth: z
      .enum(["brief", "standard", "deep", "foundations", "mechanism"])
      .optional(),
    learningPreferences: learningPreferencesSchema
      .partial()
      .strict()
      .optional(),
  })
  .strict();
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
  imageCrop: imageRegionSchema.optional(),
});
export const deckSchema = z.object({
  slides: z.array(slideSchema).min(1).max(16),
  speechScript: z.string().trim().min(1).max(24000).optional(),
});
export const teachingSchema = z.object({
  unit: unitSchema,
  deck: deckSchema.nullable(),
});
export const groundingContractVersion = "grounded-output-v4-source-kinds";
export function groundedTeachingSchema(
  sources: Source[],
  speechScript = false,
  options: { compactUnit?: boolean } = {},
) {
  const ids = z.array(z.enum(sources.map((s) => s.id))).max(20);
  const kinds = [
    "interpretation",
    "background",
    ...(sources.some((s) => s.kind === "paper") ? ["paper" as const] : []),
    ...(sources.some((s) => s.kind === "foundation")
      ? ["foundation" as const]
      : []),
  ] as const;
  const sections = unitSchema.shape.sections.element.extend({
    citations: ids,
    kind: z
      .enum(kinds)
      .describe(
        "证据性质：paper为本文事实，interpretation为基于来源的解释，background为通用背景解释，foundation仅在提供对应基础来源时可用；kind仅为结构化分类，不得写入用户正文或讲述提示中的来源状态。",
      ),
  });
  const slides = slideSchema.omit({ imageCrop: true }).extend({
    // The rendered evidence layout reserves a narrow text column. Keep generated
    // bullets compact enough to survive the actual PowerPoint export.
    bullets: z.array(z.string().trim().min(1).max(120)).min(1).max(4),
    citations: ids,
    imagePanel: z
      .enum(["", ...panelSelectionIds(sources)])
      .optional()
      .describe(
        "可选当前imageSource已有的面板ID；空字符串表示全图。不能猜坐标。",
      ),
    imageSource: z
      .enum([
        "",
        ...sources
          .filter((s) => s.image || s.figure || s.attachmentId)
          .map((s) => s.id),
      ])
      .optional()
      .describe("仅写原图来源 ID；无图写空字符串，不能附说明。"),
  });
  const groundedSlides = z
    .array(slides)
    .min(1)
    .max(16)
    .superRefine((items, ctx) => {
      for (const [index, slide] of items.entries()) {
        if (slide.imageSource && slide.bullets.length > 3)
          ctx.addIssue({
            code: "too_big",
            origin: "array",
            maximum: 3,
            inclusive: true,
            path: [index, "bullets"],
            message: "带图页面最多保留三条正文要点。",
          });
      }
    });
  const unitSections = z
    .array(sections)
    .min(1)
    .max(options.compactUnit ? 3 : 10);
  const unitTerms = options.compactUnit
    ? unitSchema.shape.terms.max(5)
    : unitSchema.shape.terms;
  return teachingSchema.extend({
    unit: unitSchema.extend({ sections: unitSections, terms: unitTerms }),
    deck: (speechScript
      ? deckSchema.extend({
          speechScript: deckSchema.shape.speechScript.unwrap(),
        })
      : deckSchema.omit({ speechScript: true })
    )
      .extend({ slides: groundedSlides })
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
  speechScript: z.boolean().optional(),
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
  purpose: z.enum(["reading", "ppt-generation"]).optional(),
  paperId: recordId.nullable().optional(),
  projectId: recordId.nullable().optional(),
  goal: z.string().max(2000).optional(),
  profileId: z.enum(["beginner", "methods", "reasoning"]).optional(),
});
export const messageSchema = z.object({
  readingAction: z
    .enum(["start", "continue", "deepen", "jump", "long", "summary", "resume"])
    .optional(),
  expectedReadingRevision: z.number().int().min(0).optional(),
  speechScript: z.boolean().optional(),
  learningIntent: learningRequestSchema.optional(),
  slideCount: z.number().int().min(1).max(16).optional(),
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
  sourceAnchor: z
    .object({
      textView: z.literal("pdf").optional(),
      paperId: recordId,
      sourceVersion: z.string().min(1).max(200),
      sourceId: recordId,
      excerpt: z.string().min(1).max(2000),
      page: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  figureSourceId: recordId.optional(),
  depth: z
    .enum(["brief", "standard", "deep", "foundations", "mechanism"])
    .optional(),
  attachmentIds: z.array(recordId).max(4).optional(),
  readabilityCheck: z.boolean().optional(),
  deckEdit: z
    .object({
      versionId: recordId,
      slideIndex: z.number().int().min(0).max(15),
    })
    .optional(),
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
