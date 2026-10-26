import type { SKRSContext2D } from "@napi-rs/canvas";
import { ruledFigureRegions } from "./raster-ruled-grid.ts";
import { cropPixels, type FigurePanel } from "../shared/image-region.ts";

// Full-width spatial groups for raster figures without reliable PDF panel labels.
// These groups do not identify scientific panels. Every original row is retained.
export function rasterFigureBands(
  ctx: SKRSContext2D,
  width: number,
  height: number,
): FigurePanel[] {
  if (width < 400) return [];
  return pixelBands(ctx.getImageData(0, 0, width, height).data, width, height);
}

function pixelBands(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  minimumGap = Math.max(12, height * 0.018),
): FigurePanel[] {
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
      if (y - start >= minimumGap)
        gaps.push({ middle: Math.floor((start + y) / 2), size: y - start });
      start = -1;
    }
  }
  // Prefer broad gaps. The minimum on both sides also protects short attached
  // tables in landscape figures; aspect ratio alone does not identify one row.
  // Nearby gaps may divide a plot from its labels or histogram.
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

// Optional full-height columns within a spatial row. These are not scientific
// panel identities: preserve the row choice and every original pixel, including
// axes, labels and attached risk tables. A non-white connector blocks its gutter.
export function rasterFigureRegions(
  ctx: SKRSContext2D,
  width: number,
  height: number,
): FigurePanel[] {
  if (width < 400 || height < 180) return [];
  const ruled = ruledFigureRegions(ctx, width, height);
  if (ruled.length) return ruled;
  const bands = rasterFigureBands(ctx, width, height);
  const rows: FigurePanel[] = bands.length
    ? bands
    : [
        {
          label: "band-1",
          region: { left: 0, top: 0, width: 1, height: 1 },
        },
      ];
  const columns: FigurePanel[] = [];
  for (const row of rows) {
    const b = cropPixels(row.region, width, height);
    const pixels = ctx.getImageData(b.left, b.top, b.width, b.height).data;
    const inkColumns = new Uint32Array(b.width);
    const gaps: { middle: number; size: number }[] = [];
    let start = -1;
    for (let x = 0; x <= b.width; x++) {
      let clear = x < b.width;
      for (let y = 0; x < b.width && y < b.height; y++) {
        const i = (y * b.width + x) * 4;
        if (
          pixels[i + 3] > 32 &&
          Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 245
        ) {
          clear = false;
          inkColumns[x]++;
        }
      }
      if (clear && start < 0) start = x;
      if (!clear && start >= 0) {
        // A thin strip between a y label and its axis is not a panel gutter.
        if (x - start >= Math.max(24, b.width * 0.012))
          gaps.push({ middle: Math.floor((start + x) / 2), size: x - start });
        start = -1;
      }
    }
    const minimum = Math.max(160, b.width * 0.24);
    const cuts: number[] = [];
    for (const gap of gaps.sort((a, b) => b.size - a.size)) {
      if (
        gap.middle < minimum ||
        b.width - gap.middle < minimum ||
        cuts.some((cut) => Math.abs(cut - gap.middle) < minimum)
      )
        continue;
      cuts.push(gap.middle);
      if (cuts.length === 2) break;
    }
    if (!cuts.length) continue;
    const bounds = [0, ...cuts.sort((a, b) => a - b), b.width];
    if (
      bounds
        .slice(0, -1)
        .some(
          (left, i) =>
            inkColumns
              .slice(left, bounds[i + 1])
              .reduce((sum, n) => sum + n, 0) <
            b.height * 0.1,
        )
    )
      continue;
    bounds.slice(0, -1).forEach((left, i) =>
      columns.push({
        label: row.label + "-col-" + (i + 1),
        region: {
          left: left / width,
          top: row.region.top,
          width: (bounds[i + 1] - left) / width,
          height: row.region.height,
        },
      }),
    );
  }
  // Staggered columns can have local row gutters that do not cross the whole
  // figure. Reuse the same pixel checks once within each column; keep the
  // parent choices, and reject short strips that could be attached tables.
  const localRows: FigurePanel[] = [];
  for (const column of columns) {
    const b = cropPixels(column.region, width, height);
    const children = pixelBands(
      ctx.getImageData(b.left, b.top, b.width, b.height).data,
      b.width,
      b.height,
      Math.max(16, b.width * 0.06),
    );
    if (
      children.length < 2 ||
      children.some((child) => child.region.height * b.height < b.width * 0.65)
    )
      continue;
    for (const child of children)
      localRows.push({
        label: column.label + "-" + child.label,
        region: {
          left: column.region.left,
          top: (b.top + child.region.top * b.height) / height,
          width: column.region.width,
          height: (child.region.height * b.height) / height,
        },
      });
  }
  return [...bands, ...columns, ...localRows];
}
