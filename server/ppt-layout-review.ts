import { slideLayout } from "../shared/slide-layout.ts";
import type { DeckOutline, ReviewResult, Source } from "../shared/types.ts";

export const pptLayoutContractVersion = "ppt-layout-v16-review-image-purpose";

const layoutId = (index: number) => `ppt-layout-${index + 1}`;
const repeatedImageId = (index: number) => `ppt-image-reuse-${index + 1}`;

export function pptLayoutIssues(
  deck: DeckOutline | null | undefined,
  sources: Source[],
): ReviewResult["issues"] {
  const slides = deck?.slides ?? [];
  const firstImageUse = new Map<string, number>();
  const repeatedImages = slides.flatMap((slide, index) => {
    if (!slide.imageSource) return [];
    const crop = slide.imageCrop;
    const region = crop
      ? [crop.left, crop.top, crop.width, crop.height]
          .map((value) => Number(value.toFixed(4)))
          .join(",")
      : "0,0,1,1";
    const key = `${slide.imageSource}:${region}`;
    const first = firstImageUse.get(key);
    if (first === undefined) {
      firstImageUse.set(key, index);
      return [];
    }
    return [
      {
        id: repeatedImageId(index),
        location: `PPT 第 ${index + 1} 页：${slide.title}`,
        type: "scope" as const,
        severity: "warning" as const,
        resolved: false,
        evidence: [...slide.citations],
        suggestion: `本页与第 ${first + 1} 页重复使用同一来源图的相同范围。请核对重复是否承担不同讲述任务；有明确必要时说明本页新增的判断，否则改用对应证据或已核实的不同选区。没有合适图件时用文字表达，不能随意换图。`,
      },
    ];
  });
  return [
    ...repeatedImages,
    ...slides.flatMap((slide, index) => {
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
    }),
  ];
}

export function withPptLayoutReview(
  review: ReviewResult,
  deck: DeckOutline | null | undefined,
  sources: Source[],
  previous?: ReviewResult,
): ReviewResult {
  if (!deck) return review;
  const isManagedIssue = (id: string) =>
    /^ppt-(?:layout|image-reuse)-\d+$/.test(id);
  const current = pptLayoutIssues(deck, sources);
  const unresolved = new Set(current.map((issue) => issue.id));
  return {
    ...review,
    // A model cannot clear a layout error without changing the actual page.
    issues: [
      ...review.issues.filter((issue) => !isManagedIssue(issue.id)),
      ...(previous?.issues ?? [])
        .filter(
          (issue) => isManagedIssue(issue.id) && !unresolved.has(issue.id),
        )
        .map((issue) => ({ ...issue, resolved: true })),
      ...current.map((issue) => {
        const reviewed = review.issues.find(
          (candidate) => candidate.id === issue.id,
        );
        return issue.severity === "warning" &&
          reviewed?.resolved &&
          reviewed.evidence.length
          ? {
              ...issue,
              resolved: true,
              evidence: reviewed.evidence,
              suggestion: reviewed.suggestion,
            }
          : issue;
      }),
    ],
  };
}

export function assertPptLayout(
  deck: DeckOutline | null | undefined,
  sources: Source[],
) {
  const issue = pptLayoutIssues(deck, sources).find(
    (issue) => issue.severity === "blocking",
  );
  if (issue) throw new Error(`${issue.location}：${issue.suggestion}`);
}
