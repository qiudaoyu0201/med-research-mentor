import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Source } from "../shared/types.ts";

export const readingImagePacketVersion = "selected-reading-images-v1";
export async function readingImagePacket(sources: Source[], explicit?: string) {
  if (explicit) {
    const source = sources.find((s) => s.image === explicit);
    return { image: explicit, sourceIds: source ? [source.id] : [] };
  }
  const pictures = sources.filter((s) => s.image).slice(0, 8);
  if (pictures.length <= 1)
    return {
      image: pictures[0]?.image,
      sourceIds: pictures.map((s) => s.id),
    };
  const columns = 2,
    cell = 1200;
  const canvas = createCanvas(
    columns * cell,
    Math.ceil(pictures.length / columns) * cell,
  );
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [i, source] of pictures.entries()) {
    const image = await loadImage(source.image!);
    const scale = Math.min(
      (cell - 40) / image.width,
      (cell - 70) / image.height,
    );
    const x = (i % columns) * cell,
      y = Math.floor(i / columns) * cell;
    ctx.fillStyle = "#1d1d1f";
    ctx.font = "22px sans-serif";
    ctx.fillText(source.id, x + 20, y + 32, cell - 40);
    ctx.drawImage(
      image,
      x + (cell - image.width * scale) / 2,
      y + 55,
      image.width * scale,
      image.height * scale,
    );
  }
  return {
    image: canvas.toDataURL("image/jpeg", 0.92),
    sourceIds: pictures.map((s) => s.id),
  };
}
