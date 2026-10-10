import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfRuntime, pdfExtractionVersion } from "./pdf-runtime.ts";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { read, save, missingRecord } from "./storage.ts";
import type { PaperBundle } from "../shared/types.ts";
import { pageFigures } from "./pdf-figures.ts";
export async function parsePdf(
  path: string,
  id: string,
  title: string,
): Promise<PaperBundle> {
  const bytes = new Uint8Array(await readFile(path));
  if (Buffer.from(bytes.subarray(0, 1024)).indexOf("%PDF-") < 0)
    throw new Error("文件不是有效 PDF，原文件已保留。");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const key = `${hash}-${pdfExtractionVersion}`;
  let cached:
    | {
        pages: string[];
        parseStatus: string;
        figures: (Omit<import("../shared/types.ts").Source, "id"> & {
          suffix: string;
        })[];
      }
    | undefined;
  try {
    cached = await read("material-cache", key);
  } catch (error: any) {
    if (!missingRecord(error)) throw error;
  }
  if (cached)
    return {
      id,
      title,
      version: key,
      scope: "用户上传资料。页码为 PDF 实际页序；文本提取尚未经人工校对。",
      pdfUrl: `/api/papers/${id}/pdf`,
      pageCount: cached.pages.length,
      parseStatus: cached.parseStatus,
      sources: [
        ...cached.pages.map((text, index) => ({
          id: `${id}-p${index + 1}`,
          title: `PDF 第 ${index + 1} 页`,
          kind: "paper" as const,
          page: index + 1,
          locator: `PDF 实际第 ${index + 1} 页`,
          text,
          verified: false,
        })),
        ...cached.figures.map(({ suffix, ...s }) => ({
          ...s,
          id: `${id}${suffix}`,
        })),
      ],
    };
  const task = getDocument({ ...pdfRuntime, data: bytes });
  const paper: PaperBundle = {
    id,
    title,
    version: key,
    scope: "用户上传资料。页码为 PDF 实际页序；文本提取尚未经人工校对。",
    pdfUrl: `/api/papers/${id}/pdf`,
    sources: [],
  };
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 100)
      throw new Error("初版支持最多 100 页，原文件已保留。");
    paper.pageCount = pdf.numPages;
    for (let page = 1; page <= pdf.numPages; page++) {
      const pdfPage = await pdf.getPage(page);
      const content = await pdfPage.getTextContent();
      const text = content.items
        .map((item: any) => item.str + (item.hasEOL ? "\n" : " "))
        .join("")
        .trim();
      paper.sources.push({
        id: `${id}-p${page}`,
        title: `PDF 第 ${page} 页`,
        kind: "paper",
        page,
        locator: `PDF 实际第 ${page} 页`,
        text,
        verified: false,
      });
      try {
        paper.sources.push(...(await pageFigures(pdfPage, id, content.items)));
      } catch {
        /* Keep readable text and original PDF when graphics cannot be located/rendered. */
      }
    }
    paper.parseStatus = paper.sources.some((s) => s.text.length > 50)
      ? "ready"
      : "needs-text";
    await save("material-cache", key, {
      pages: paper.sources.filter((s) => !s.image).map((s) => s.text),
      figures: paper.sources
        .filter((s) => s.image)
        .map(({ id: sourceId, ...s }) => ({
          ...s,
          suffix: sourceId.slice(id.length),
        })),
      parseStatus: paper.parseStatus,
    });
    return paper;
  } finally {
    await task.destroy();
  }
}
