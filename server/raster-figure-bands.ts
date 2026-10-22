import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FigurePanel } from "../shared/image-region.ts";

// Full-width spatial groups for raster figures without reliable PDF panel labels.
// These groups do not identify scientific panels. Every original row is retained.
export function rasterFigureBands(
  ctx: SKRSContext2D,
  width: number,
  height: number,
): FigurePanel[] {
  if (width < 400 || height < width * 0.95) return [];
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const gaps: { middle: number; size: number }[] = [];
  const inkRows = new Uint32Array(height);
  let start = -1;
  for (let y = 0; y <= height; y++) {
    let clear = y < height;
    for (let x = 0; y < height && x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        pixels[i + 3] > 32 &&
        Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 245
      ) {
        clear = false;
        inkRows[y]++;
      }
    }
    if (clear && start < 0) start = y;
    if (!clear && start >= 0) {
      if (y - start >= Math.max(12, height * 0.018))
        gaps.push({ middle: Math.floor((start + y) / 2), size: y - start });
      start = -1;
    }
  }
  // Prefer broad gaps. Nearby gaps may divide a plot from its labels or histogram.
  const minimum = Math.max(height * 0.18, width * 0.28);
  const cuts: number[] = [];
  for (const gap of gaps.sort((a, b) => b.size - a.size)) {
    if (
      gap.middle < minimum ||
      height - gap.middle < minimum ||
      cuts.some((cut) => Math.abs(cut - gap.middle) < minimum)
    )
      continue;
    cuts.push(gap.middle);
    if (cuts.length === 3) break;
  }
  if (!cuts.length) return [];
  const bounds = [0, ...cuts.sort((a, b) => a - b), height];
  if (
    bounds
      .slice(0, -1)
      .some(
        (top, i) =>
          inkRows.slice(top, bounds[i + 1]).reduce((sum, n) => sum + n, 0) <
          width * 0.1,
      )
  )
    return [];
  return bounds.slice(0, -1).map((top, i) => ({
    label: "band-" + (i + 1),
    region: {
      left: 0,
      top: top / height,
      width: 1,
      height: (bounds[i + 1] - top) / height,
    },
  }));
}
