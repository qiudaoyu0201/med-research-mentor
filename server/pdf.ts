import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile } from "node:fs/promises";
import type { PaperBundle } from "../shared/types.ts";
export async function parsePdf(
  path: string,
  id: string,
  title: string,
): Promise<PaperBundle> {
  const bytes = new Uint8Array(await readFile(path));
  if (Buffer.from(bytes.subarray(0, 1024)).indexOf("%PDF-") < 0)
    throw new Error("文件不是有效 PDF，原文件已保留。");
  const task = getDocument({ data: bytes, useSystemFonts: true });
  const paper: PaperBundle = {
    id,
    title,
    version: `upload-${Date.now()}`,
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
      const content = await (await pdf.getPage(page)).getTextContent();
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
    }
    paper.parseStatus = paper.sources.some((s) => s.text.length > 50)
      ? "ready"
      : "needs-text";
    return paper;
  } finally {
    await task.destroy();
  }
}
