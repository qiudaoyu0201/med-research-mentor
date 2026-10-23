import { createCanvas, loadImage } from "@napi-rs/canvas";
import { pptSelectionCandidates } from "./figure-panels.ts";
import { validRegion, cropPixels } from "../shared/image-region.ts";
import type { Source, DeckOutline } from "../shared/types.ts";
export async function pptImagePacket(sources: Source[], limit = 8) {
  const images = sources.filter((s) => s.image).slice(0, limit);
  if (!images.length) return undefined;
  if (images.length === 1) return images[0].image;
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

// Review the picture actually selected for each page, including its crop.
export async function pptDeckImagePacket(
  deck: DeckOutline | null | undefined,
  sources: Source[],
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
  return pptImagePacket(pictures, 16);
}
