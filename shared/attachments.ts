import type { Source } from "./types.ts";

export interface ResearchAttachment {
  id: string;
  conversationId: string;
  paperId: string | null;
  name: string;
  hash: string;
  image?: string;
  originalUrl?: string;
  originalWidth?: number;
  originalHeight?: number;
  modelWidth?: number;
  modelHeight?: number;
  originalMime?: "image/png" | "image/jpeg";
  status:
    | "ready"
    | "unchecked"
    | "checking"
    | "needs-purpose"
    | "unrelated"
    | "unreadable"
    | "failed";
  reason?: string;
  purpose?: string;
  sourceVersion?: string;
  description?: string;
  dependsOnImage?: boolean;
  checkedQuestion?: string;
}
export const attachmentLimits = {
  count: 4,
  imageBytes: 8 * 1024 * 1024,
  totalBytes: 40 * 1024 * 1024,
};
export function attachmentSource(a: ResearchAttachment): Source | undefined {
  return a.status === "ready" && a.image && a.description
    ? {
        id: a.id,
        title: a.name,
        kind: "interpretation",
        image: a.image,
        ...(a.originalUrl
          ? {
              displayImage: a.originalUrl,
              imagePurpose: "attachment" as const,
              imageWidth: a.originalWidth,
              imageHeight: a.originalHeight,
            }
          : {}),
        attachmentId: a.id,
        text: a.description,
        locator: `用户上传图片：${a.name}；未绑定论文页码`,
        verified: false,
      }
    : undefined;
}
