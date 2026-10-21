import PptxGenJS from "pptxgenjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { deckSchema } from "./schemas.ts";
import { slideLayout, slideLineHeight } from "../shared/slide-layout.ts";
import type { DeckOutline, PaperBundle, TaskRun } from "../shared/types.ts";
import { safeId } from "./storage.ts";
import { completePptxPackage } from "./pptx-package.ts";
import { cropPixels } from "../shared/image-region.ts";
export async function exportDeck(
  outline: DeckOutline,
  paper: PaperBundle,
  id: string,
) {
  const deck = deckSchema.parse(outline),
    sourceMap = new Map(paper.sources.map((s) => [s.id, s]));
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "医研导师（Med Research Mentor）";
  pptx.subject = "学习汇报";
  pptx.title = paper.title;
  pptx.theme = {
    headFontFace: "Microsoft YaHei",
    bodyFontFace: "Microsoft YaHei",
  };
  for (const [i, s] of deck.slides.entries()) {
    if (!s.citations.length || s.citations.some((id) => !sourceMap.has(id)))
      throw new Error("每一页必须保留有效来源。");
    let image = s.imageSource ? sourceMap.get(s.imageSource)?.image : undefined;
    if (s.imageSource && !sourceMap.has(s.imageSource))
      throw new Error("图件来源无效。");
    if (s.imageSource && !image)
      throw new Error(
        `第 ${i + 1} 页已选择原图，但图片数据缺失；请重新加载论文原图后导出。`,
      );
    let size: { width: number; height: number } | undefined;
    if (image) {
      let decoded = await loadImage(image);
      if (s.imageCrop) {
        const bounds = cropPixels(s.imageCrop, decoded.width, decoded.height),
          canvas = createCanvas(bounds.width, bounds.height);
        canvas
          .getContext("2d")
          .drawImage(
            decoded,
            bounds.left,
            bounds.top,
            canvas.width,
            canvas.height,
            0,
            0,
            canvas.width,
            canvas.height,
          );
        image = canvas.toDataURL("image/png");
        decoded = await loadImage(image);
      }
      size = { width: decoded.width, height: decoded.height };
    }
    const layout = slideLayout(
        s,
        s.citations.map((id) => sourceMap.get(id)!),
        size,
      ),
      slide = pptx.addSlide();
    slide.background = { color: layout.background };
    for (const shape of layout.shapes)
      slide.addShape(pptx.ShapeType[shape.kind ?? "rect"], {
        x: shape.x,
        y: shape.y,
        w: shape.w,
        h: shape.h,
        rectRadius:
          shape.kind === "roundRect"
            ? Math.min(shape.w, shape.h) * 0.08
            : undefined,
        fill: { color: shape.fill },
        line: { color: shape.fill, transparency: 100 },
      });
    for (const b of layout.text) {
      if (b.role === "bullet" && b.marker) {
        slide.addText(b.marker, {
          x: b.markerAbove ? b.x : b.x - 0.42,
          y: b.markerAbove ? b.y - 0.36 : b.y + 0.02,
          w: 0.28,
          h: 0.22,
          fontSize: 10,
          bold: true,
          color: "177E7D",
          margin: 0,
          fontFace: "Aptos",
        });
      }
      slide.addText(b.lines.join("\n"), {
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        fontSize: b.fontSize,
        bold: b.bold,
        color: b.color,
        margin: 0,
        breakLine: false,
        // Relative spacing uses Office font metrics and can overflow fitted boxes.
        lineSpacing: b.fontSize * slideLineHeight,
        valign: "top",
        fontFace: "Microsoft YaHei",
      });
    }
    if (image && layout.image) slide.addImage({ data: image, ...layout.image });
    slide.addText(`${i + 1} / ${deck.slides.length}`, {
      x: 12.1,
      y: 7.02,
      w: 0.7,
      h: 0.22,
      fontSize: 10,
      color: "65656F",
      margin: 0,
    });
    // Speaking guidance is delivered separately, never embedded in the PPTX.
  }
  await mkdir("exports", { recursive: true });
  const path = resolve("exports", `${safeId(id)}.pptx`);
  const bytes = await pptx.write({ outputType: "nodebuffer" });
  if (!(bytes instanceof Uint8Array))
    throw new Error("PPTX导出未返回文件数据。");
  await writeFile(path, completePptxPackage(bytes));
  return path;
}
export function exportNotes(run: TaskRun) {
  if (!run.result || run.status !== "completed")
    throw new Error("只有已完成的最终内容可以导出。");
  const sources = run.materials?.at(-1)?.sources ?? [];
  const used = [
    ...new Set(run.result.sections.flatMap((s) => s.citations)),
  ].flatMap((id) => {
    const s = sources.find((s) => s.id === id);
    return s ? [`${s.title} · ${s.locator}${s.url ? ` · ${s.url}` : ""}`] : [];
  });
  return `# ${run.result.title}\n\n${run.result.sections.map((s) => `## ${s.title}\n\n${s.text}`).join("\n\n")}${used.length ? `\n\n## 来源\n\n${used.join("\n\n")}` : ""}\n\n核对范围：${run.review?.limitations.join("；") || "未记录"}\n`;
}
