import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Source } from "../shared/types.ts";
export async function pptImagePacket(sources: Source[]) {
  const images = sources.filter((s) => s.image).slice(0, 8);
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
    ctx.fillText(s.id, x + 12, y + 24);
    ctx.drawImage(img, x + 12, y + 42, img.width * scale, img.height * scale);
  }
  return canvas.toDataURL("image/jpeg", 0.88);
}
