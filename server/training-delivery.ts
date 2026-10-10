import type { DeckOutline, PaperBundle } from "../shared/types.ts";
import type { LearningProduct } from "./learning-exposure.ts";
import { deckSchema } from "./schemas.ts";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { slideLayout } from "../shared/slide-layout.ts";
import { cropPixels } from "../shared/image-region.ts";
import { createHash } from "node:crypto";

export function trainingGuidance(deck: DeckOutline) {
  return (
    deck.slides
      .map((slide, i) => `## ${i + 1}. ${slide.title}\n\n${slide.notes}`)
      .join("\n\n") + "\n"
  );
}

// Historical experiments keep their original file contract. New experiments
// validate the actual separate guidance, not a full speech nobody requested.
export function trainingDeliveryFiles(product: LearningProduct) {
  if (!product.exportPath || !/\.pptx$/i.test(product.exportPath))
    throw new Error("缺少实际 PPTX 文件路径。");
  if (!product.delivery)
    return [
      { path: product.exportPath },
      { path: product.exportPath.replace(/\.pptx$/i, "-speech.md") },
    ];
  if (
    product.delivery.version !== "separate-guidance-v1" ||
    !product.delivery.guidancePath.trim()
  )
    throw new Error("不支持的汇报交付合同。");
  const artifact = product.artifact as { deck?: unknown } | undefined;
  const deck = deckSchema.parse(artifact?.deck);
  if (!!deck.speechScript !== !!product.delivery.speechPath)
    throw new Error("完整稿与已交付文件记录不一致。");
  const files = [
    { path: product.exportPath },
    { path: product.delivery.guidancePath, text: trainingGuidance(deck) },
    ...(product.delivery.speechPath
      ? [{ path: product.delivery.speechPath, text: deck.speechScript! }]
      : []),
  ];
  if (new Set(files.map((f) => f.path)).size !== files.length)
    throw new Error("汇报交付文件路径重复。");
  return files;
}

function xmlText(xml: string) {
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
    .map((m) =>
      m[1]
        .replace(/&#x([\da-f]+);/gi, (_, n) =>
          String.fromCodePoint(parseInt(n, 16)),
        )
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&"),
    )
    .join("");
}
const compact = (text: string) => text.replace(/\s/g, "");

/** Validate the exported bytes, not just the JSON used to request an export.
 * This checks content and source-image identity; visual readability is a separate gate. */
export async function verifyTrainingDeliveryFiles(
  product: LearningProduct,
  paper: PaperBundle,
) {
  if (!product.delivery)
    throw new Error("新验收入口不自动改写旧版讲稿交付合同。");
  const files = trainingDeliveryFiles(product);
  const contents = await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(file.path);
      if (file.text !== undefined && bytes.toString("utf8") !== file.text)
        throw new Error("实际独立讲述文件与冻结产物不一致。");
      return bytes;
    }),
  );
  const zip = unzipSync(contents[0]);
  const deck = deckSchema.parse((product.artifact as { deck: unknown }).deck);
  const slides = Object.keys(zip).filter((path) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(path),
  );
  if (slides.length !== deck.slides.length)
    throw new Error("实际 PPT 页数与冻结产物不一致。");
  for (const path of Object.keys(zip).filter((p) =>
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p),
  ))
    if (compact(xmlText(strFromU8(zip[path]))).replace(/\d/g, ""))
      throw new Error("PPT 内嵌讲述文字，必须单独交付。");
  for (const [i, slide] of deck.slides.entries()) {
    const xml = strFromU8(
      zip[`ppt/slides/slide${i + 1}.xml`] ?? new Uint8Array(),
    );
    const sources = slide.citations.map((id) =>
      paper.sources.find((s) => s.id === id),
    );
    if (!sources.length || sources.some((s) => !s))
      throw new Error("PPT 来源缺失。");
    const source = slide.imageSource
      ? paper.sources.find((s) => s.id === slide.imageSource)
      : undefined;
    if (slide.imageSource && !source) throw new Error("PPT 原图来源不存在。");
    const layout = slideLayout(
      slide,
      sources as PaperBundle["sources"],
      slide.imageSource ? { width: 1600, height: 1000 } : undefined,
    );
    const expectedText =
      layout.text.flatMap((box) => box.lines).join("") +
      (slide.imageSource && !source?.image ? "原图未提供" : "") +
      `${i + 1} / ${deck.slides.length}`;
    if (compact(xmlText(xml)) !== compact(expectedText))
      throw new Error(`PPT 第 ${i + 1} 页文字与冻结产物不一致。`);
    const pictures = [...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)];
    if (pictures.length !== (source?.image ? 1 : 0))
      throw new Error("PPT 实际图件数量不一致。");
    if (!source?.image) continue;
    const rid = /r:embed="([^"]+)"/.exec(pictures[0][0])?.[1];
    const relationships = strFromU8(
      zip[`ppt/slides/_rels/slide${i + 1}.xml.rels`] ?? new Uint8Array(),
    );
    const rel = [...relationships.matchAll(/<Relationship\b[^>]*\/>/g)]
      .map((m) => m[0])
      .find((r) => /\bId="([^"]+)"/.exec(r)?.[1] === rid);
    const target = rel && /\bTarget="([^"]+)"/.exec(rel)?.[1];
    if (!target || /TargetMode="External"/.test(rel!))
      throw new Error("PPT 图件关系无效。");
    const bytes = zip[posix.normalize(posix.join("ppt/slides", target))];
    if (!bytes) throw new Error("PPT 图件文件缺失。");
    const original = await loadImage(source.image),
      actual = await loadImage(Buffer.from(bytes));
    const bounds = slide.imageCrop
      ? cropPixels(slide.imageCrop, original.width, original.height)
      : { left: 0, top: 0, width: original.width, height: original.height };
    if (actual.width !== bounds.width || actual.height !== bounds.height)
      throw new Error("PPT 原图或裁剪尺寸不一致。");
    const expected = createCanvas(bounds.width, bounds.height),
      rendered = createCanvas(bounds.width, bounds.height);
    expected
      .getContext("2d")
      .drawImage(
        original,
        bounds.left,
        bounds.top,
        bounds.width,
        bounds.height,
        0,
        0,
        bounds.width,
        bounds.height,
      );
    rendered.getContext("2d").drawImage(actual, 0, 0);
    const pixels = (canvas: typeof expected) =>
      Buffer.from(
        canvas.getContext("2d").getImageData(0, 0, bounds.width, bounds.height)
          .data,
      );
    if (!pixels(expected).equals(pixels(rendered)))
      throw new Error("PPT 中的实际图片与冻结原图不一致。");
  }
  return {
    slides: deck.slides.length,
    files: files.map((file, i) => ({
      path: file.path,
      hash: createHash("sha256").update(contents[i]).digest("hex"),
    })),
  };
}
