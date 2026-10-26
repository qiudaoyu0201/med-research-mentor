import type { SKRSContext2D } from "@napi-rs/canvas";
import type { FigurePanel } from "../shared/image-region.ts";

type Rule = { start: number; end: number; middle: number };

// Only a closed, neutral, thin ruled grid with clear padding around every
// internal divider is eligible. Spatial IDs never assert scientific panel names.
export function ruledFigureRegions(
  ctx: SKRSContext2D,
  width: number,
  height: number,
): FigurePanel[] {
  if (width < 400 || height < 300) return [];
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const ink = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return (
      pixels[i + 3] > 32 &&
      Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 245
    );
  };
  const neutral = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const lo = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
    return (
      pixels[i + 3] > 32 &&
      lo < 235 &&
      Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - lo < 24
    );
  };
  const rules = (vertical: boolean): Rule[] => {
    const size = vertical ? width : height,
      extent = vertical ? height : width;
    const found: Rule[] = [];
    let start = -1;
    for (let position = 0; position <= size; position++) {
      let count = 0;
      if (position < size)
        for (let along = 0; along < extent; along++)
          if (neutral(vertical ? position : along, vertical ? along : position))
            count++;
      if (count / extent >= 0.94 && position < size) {
        if (start < 0) start = position;
      } else if (start >= 0) {
        found.push({
          start,
          end: position,
          middle: Math.floor((start + position) / 2),
        });
        start = -1;
      }
    }
    return found;
  };
  const xs = rules(true),
    ys = rules(false);
  const framed = (rs: Rule[], size: number) =>
    rs.length >= 3 &&
    rs.length <= 5 &&
    rs[0].start <= Math.max(3, size * 0.04) &&
    size - rs.at(-1)!.end <= Math.max(3, size * 0.04) &&
    rs.every((r) => r.end - r.start <= Math.max(4, size * 0.006)) &&
    rs.slice(1).every((r, i) => r.middle - rs[i].middle >= size * 0.18);
  if (!framed(xs, width) || !framed(ys, height)) return [];
  // The PDF extractor may preserve a small white margin. Require each rule
  // to run continuously between the detected frame edges, not just most of
  // the image; missing or colored segments cannot become a safe divider.
  const continuous = (rs: Rule[], cross: Rule[], vertical: boolean) => {
    const start = cross[0].start,
      end = cross.at(-1)!.end;
    return rs.every((r) => {
      let count = 0;
      for (let a = start; a < end; a++)
        if (neutral(vertical ? r.middle : a, vertical ? a : r.middle)) count++;
      return count / (end - start) >= 0.998;
    });
  };
  if (!continuous(xs, ys, true) || !continuous(ys, xs, false)) return [];
  const paddingClear = (rs: Rule[], cross: Rule[], vertical: boolean) => {
    const size = vertical ? width : height,
      extent = vertical ? height : width;
    const padding = Math.max(6, Math.ceil(size * 0.008));
    for (const r of rs.slice(1, -1))
      for (
        let p = Math.max(0, r.start - padding);
        p < Math.min(size, r.end + padding);
        p++
      ) {
        if (p >= r.start - 1 && p < r.end + 1) continue;
        let count = 0;
        for (let a = 0; a < extent; a++) {
          if (cross.some((c) => a >= c.start - 1 && a <= c.end)) continue;
          if (ink(vertical ? p : a, vertical ? a : p)) count++;
        }
        if (count > 0) return false;
      }
    return true;
  };
  if (!paddingClear(xs, ys, true) || !paddingClear(ys, xs, false)) return [];
  const xb = [0, ...xs.slice(1, -1).map((r) => r.middle), width];
  const yb = [0, ...ys.slice(1, -1).map((r) => r.middle), height];
  // Empty framed cells or a decorative grid are not useful evidence regions.
  for (let y = 0; y < yb.length - 1; y++) {
    for (let x = 0; x < xb.length - 1; x++) {
      let count = 0;
      for (let py = ys[y].end + 3; py < ys[y + 1].start - 3; py++) {
        for (let px = xs[x].end + 3; px < xs[x + 1].start - 3; px++) {
          if (ink(px, py)) count++;
        }
      }
      if (
        count < Math.max(20, (xb[x + 1] - xb[x]) * (yb[y + 1] - yb[y]) * 0.001)
      )
        return [];
    }
  }
  const result: FigurePanel[] = [];
  for (let y = 0; y < yb.length - 1; y++) {
    const top = yb[y] / height,
      h = (yb[y + 1] - yb[y]) / height,
      label = `band-${y + 1}`;
    result.push({ label, region: { left: 0, top, width: 1, height: h } });
  }
  // Existing cache and source contracts allow three spatial columns. A
  // denser grid still exposes complete rows instead of invalid col-4 IDs.
  if (xb.length <= 4)
    for (let y = 0; y < yb.length - 1; y++)
      for (let x = 0; x < xb.length - 1; x++)
        result.push({
          label: `band-${y + 1}-col-${x + 1}`,
          region: {
            left: xb[x] / width,
            top: yb[y] / height,
            width: (xb[x + 1] - xb[x]) / width,
            height: (yb[y + 1] - yb[y]) / height,
          },
        });
  return result;
}
