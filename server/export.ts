import PptxGenJS from "pptxgenjs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { deckSchema } from "./schemas.ts";
import type { DeckOutline, PaperBundle, TaskRun } from "../shared/types.ts";
import { safeId } from "./storage.ts";
export async function exportDeck(
  outline: DeckOutline,
  paper: PaperBundle,
  id: string,
) {
  const deck = deckSchema.parse(outline);
  const sourceMap = new Map(paper.sources.map((s) => [s.id, s]));
  for (const slide of deck.slides) {
    if (
      !slide.citations.length ||
      slide.citations.some((id) => !sourceMap.has(id))
    )
      throw new Error("每一页必须保留有效来源。");
    if (slide.imageSource && !sourceMap.has(slide.imageSource))
      throw new Error("图件来源无效。");
  }
  const pptx = new PptxGenJS();
  const imageBoxes = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();
  for (const slide of deck.slides) {
    const image = slide.imageSource && sourceMap.get(slide.imageSource)?.image;
    if (!image || imageBoxes.has(image)) continue;
    const decoded = await loadImage(image);
    const scale = Math.min(5.05 / decoded.width, 3.7 / decoded.height);
    const w = decoded.width * scale,
      h = decoded.height * scale;
    imageBoxes.set(image, {
      x: 7.35 + (5.05 - w) / 2,
      y: 1.75 + (3.7 - h) / 2,
      w,
      h,
    });
  }
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "医学科研入门导师";
  pptx.subject = "学习汇报";
  pptx.title = paper.title;
  pptx.theme = {
    headFontFace: "Microsoft YaHei",
    bodyFontFace: "Microsoft YaHei",
  };
  deck.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: "F5F5F7" };
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.55,
      y: 0.65,
      w: 0.12,
      h: 0.5,
      fill: { color: "007AFF" },
      line: { color: "007AFF" },
    });
    slide.addText(s.title, {
      x: 0.85,
      y: 0.55,
      w: 11.6,
      h: 0.9,
      fontSize: 28,
      bold: true,
      color: "1D1D1F",
      breakLine: false,
      margin: 0,
      fit: "resize",
    });
    const image = s.imageSource
      ? sourceMap.get(s.imageSource)?.image
      : undefined;
    const width = s.imageSource ? 6.0 : 11.6;
    s.bullets.forEach((text, j) =>
      slide.addText(text, {
        x: 0.9,
        y: 1.85 + j * 0.83,
        w: width,
        h: 0.67,
        fontSize: 20,
        color: "303039",
        margin: 0,
        fit: "resize",
        breakLine: false,
      }),
    );
    if (s.imageSource) {
      if (image)
        slide.addImage({
          data: image,
          ...imageBoxes.get(image)!,
        });
      else
        slide.addText("原图待导入\n未生成或补造论文图件", {
          x: 7.35,
          y: 1.85,
          w: 5.05,
          h: 3.6,
          fontSize: 20,
          color: "73737C",
          align: "center",
          valign: "middle",
          fill: { color: "E8E8ED" },
          margin: 0.3,
        });
    }
    const sourceText = s.citations
      .map((id) => {
        const source = sourceMap.get(id)!;
        return `${source.title} · ${source.locator}`;
      })
      .join("；");
    slide.addText(sourceText, {
      x: 0.9,
      y: 6.35,
      w: 11.2,
      h: 0.65,
      fontSize: 10,
      color: "65656F",
      margin: 0,
      fit: "resize",
    });
    slide.addText(`${i + 1} / ${deck.slides.length}`, {
      x: 12.1,
      y: 6.75,
      w: 0.7,
      h: 0.3,
      fontSize: 10,
      color: "65656F",
      margin: 0,
    });
    slide.addNotes(
      `${s.notes}\n\n来源：\n${s.citations
        .map((id) => {
          const x = sourceMap.get(id)!;
          return `${x.title} | ${x.locator} | ${x.url || "本机上传资料"}`;
        })
        .join("\n")}`,
    );
  });
  await mkdir("exports", { recursive: true });
  const path = resolve("exports", `${safeId(id)}.pptx`);
  await pptx.writeFile({ fileName: path });
  return path;
}
export function exportNotes(run: TaskRun) {
  if (!run.result || run.status !== "completed")
    throw new Error("只有已完成的最终内容可以导出。");
  return `# ${run.result.title}\n\n模式：${run.input.mode === "live" ? "实时" : "固定示例"}\n\n${run.result.sections.map((s) => `## ${s.title}\n\n${s.text}\n\n来源类型：${s.kind}；依据：${s.citations.join("、")}`).join("\n\n")}\n\n待核验：${run.review?.limitations.join("；") || "未记录"}\n\n版本：${JSON.stringify(run.skillVersions)}\n`;
}
