import { slideLayout } from "../shared/slide-layout.ts";
import type { DeckOutline, ReviewResult, Source } from "../shared/types.ts";

export const pptLayoutContractVersion = "ppt-layout-v4-signed-estimates";

const layoutId = (index: number) => `ppt-layout-${index + 1}`;

export function pptLayoutIssues(
  deck: DeckOutline | null | undefined,
  sources: Source[],
): ReviewResult["issues"] {
  return (deck?.slides ?? []).flatMap((slide, index) => {
    try {
      // Conservatively require the standard side-column capacity. A short text
      // band may enlarge wide figures later, but never rescues an overfull page.
      slideLayout(
        slide,
        sources.filter((source) => slide.citations.includes(source.id)),
        slide.imageSource ? { width: 1, height: 1 } : undefined,
      );
      return [];
    } catch (error) {
      return [
        {
          id: layoutId(index),
          location: `PPT 第 ${index + 1} 页：${slide.title}`,
          type: "scope" as const,
          severity: "blocking" as const,
          resolved: false,
          evidence: [...slide.citations],
          suggestion:
            (error instanceof Error ? error.message : "页面无法排版。") +
            "保留主结果、必要比较和结论边界，将重复读图步骤或展开解释移入讲述提示；保持用户要求的页数，不缩小字号或删除关键证据来掩盖问题。",
        },
      ];
    }
  });
}

export function withPptLayoutReview(
  review: ReviewResult,
  deck: DeckOutline | null | undefined,
  sources: Source[],
  previous?: ReviewResult,
): ReviewResult {
  if (!deck) return review;
  const ids = new Set(deck.slides.map((_, index) => layoutId(index)));
  const current = pptLayoutIssues(deck, sources);
  const unresolved = new Set(current.map((issue) => issue.id));
  return {
    ...review,
    // A model cannot clear a layout error without changing the actual page.
    issues: [
      ...review.issues.filter((issue) => !ids.has(issue.id)),
      ...(previous?.issues ?? [])
        .filter((issue) => ids.has(issue.id) && !unresolved.has(issue.id))
        .map((issue) => ({ ...issue, resolved: true })),
      ...current,
    ],
  };
}

export function assertPptLayout(
  deck: DeckOutline | null | undefined,
  sources: Source[],
) {
  const issue = pptLayoutIssues(deck, sources)[0];
  if (issue) throw new Error(`${issue.location}：${issue.suggestion}`);
}
