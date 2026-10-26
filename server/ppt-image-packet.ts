import { createCanvas, loadImage } from "@napi-rs/canvas";
import { pptSelectionCandidates } from "./figure-panels.ts";
import { validRegion, cropPixels } from "../shared/image-region.ts";
import type { Source, DeckOutline } from "../shared/types.ts";
export async function pptImagePacket(
  sources: Source[],
  limit = 8,
  labelSingle = false,
) {
  const images = sources.filter((s) => s.image).slice(0, limit);
  if (!images.length) return undefined;
  if (images.length === 1 && !labelSingle) return images[0].image;
  const cols = 2,
    cellW = 900,
    cellH = 620,
    canvas = createCanvas(
      cols * cellW,
      Math.ceil(images.length / cols) * cellH,
    ),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [i, s] of images.entries()) {
    const img = await loadImage(s.image!),
      scale = Math.min((cellW - 24) / img.width, (cellH - 55) / img.height),
      x = (i % cols) * cellW,
      y = Math.floor(i / cols) * cellH;
    ctx.fillStyle = "#1d1d1f";
    ctx.font = "18px sans-serif";
    ctx.fillText(s.id, x + 12, y + 24, cellW - 24);
    ctx.drawImage(img, x + 12, y + 42, img.width * scale, img.height * scale);
  }
  return canvas.toDataURL("image/jpeg", 0.88);
}

export const pptSelectionImageVersion =
  "ppt-selection-images-v2-visible-candidates";
// Show the actual available crops beside complete originals before selection.
// Limits apply separately: no original is displaced by another figure's panels.
export async function pptSelectionImagePacket(sources: Source[]) {
  const originals = sources.filter((s) => s.image).slice(0, 8);
  const pictures = originals.map((s) => ({ ...s, id: s.id + " | whole" }));
  const decoded = new Map<string, Awaited<ReturnType<typeof loadImage>>>();
  for (const { source, panel } of pptSelectionCandidates(sources)) {
    let original = decoded.get(source.id);
    if (!original) {
      original = await loadImage(source.image!);
      decoded.set(source.id, original);
    }
    const box = cropPixels(panel.region, original.width, original.height);
    const canvas = createCanvas(box.width, box.height);
    canvas
      .getContext("2d")
      .drawImage(
        original,
        box.left,
        box.top,
        box.width,
        box.height,
        0,
        0,
        box.width,
        box.height,
      );
    pictures.push({
      ...source,
      id: source.id + ":" + panel.label,
      image: canvas.toDataURL("image/png"),
    });
  }
  // Existing single whole-image behavior remains exact when no crop is available.
  return pptImagePacket(pictures, 16);
}

export const pptGroundingImageVersion =
  "ppt-grounding-images-v1-cited-originals";
export const pptGroundingImageInstruction =
  "图件核验资料板中，‘第N页’只展示该页实际选择的图件范围；‘来源原图（非页面展示）’是额外提供的完整来源证据，可用于核对表格或讲稿引用的其他面板读数，不代表这些面板已在页面显示。分别核对来源支持与当页图文定位，不能用完整来源图替代页面裁切或可读性检查。此资料板不是最终PPTX渲染。";

// Page-only review keeps exactly the picture selected for each page. Grounding
// may also receive up to eight cited originals, with a distinct evidence label.
export async function pptDeckImagePacket(
  deck: DeckOutline | null | undefined,
  sources: Source[],
  includeCitedOriginals = false,
) {
  const pictures: Source[] = [];
  for (const [index, slide] of (deck?.slides ?? []).entries()) {
    if (!slide.imageSource) continue;
    const source = sources.find((s) => s.id === slide.imageSource);
    if (!source) throw new Error("汇报核验缺少已选择的原图来源。");
    if (!source.image) {
      if (slide.imageCrop) throw new Error("汇报核验缺少裁剪所需的原图。");
      continue;
    }
    let image = source.image;
    if (slide.imageCrop) {
      if (!validRegion(slide.imageCrop)) throw new Error("汇报核验选区无效。");
      const original = await loadImage(image),
        box = cropPixels(slide.imageCrop, original.width, original.height);
      const crop = createCanvas(box.width, box.height);
      crop
        .getContext("2d")
        .drawImage(
          original,
          box.left,
          box.top,
          box.width,
          box.height,
          0,
          0,
          box.width,
          box.height,
        );
      image = crop.toDataURL("image/png");
    }
    pictures.push({ ...source, id: `第${index + 1}页 | ${source.id}`, image });
  }
  if (includeCitedOriginals) {
    const cited = new Set(
      (deck?.slides ?? []).flatMap((slide) => [
        ...slide.citations,
        slide.imageSource,
      ]),
    );
    for (const source of sources
      .filter((s) => s.image && cited.has(s.id))
      .slice(0, 8))
      pictures.push({ ...source, id: "来源原图（非页面展示） | " + source.id });
  }
  return pptImagePacket(
    pictures,
    includeCitedOriginals ? 24 : 16,
    includeCitedOriginals,
  );
}
