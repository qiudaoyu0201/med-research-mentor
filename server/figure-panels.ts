import type { Source, DeckOutline } from "../shared/types.ts";
import {
  validRegion,
  cropPixels,
  type ImageRegion,
  type FigurePanel,
} from "../shared/image-region.ts";
import type { SKRSContext2D } from "@napi-rs/canvas";

export interface PanelText {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  height: number;
  font: string;
}
export interface FigureBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Only a complete, unambiguous printed a,b,... sequence is eligible.
// Unlabelled raster figures and uncertain layouts retain their whole figure.
export function figurePanels(
  figure: FigureBox,
  caption: string,
  texts: PanelText[],
): FigurePanel[] {
  const expected = [
    ...new Set(
      [
        ...caption.matchAll(/\(([A-P])\)/gi),
        ...caption.matchAll(/(?:^|\s)([A-P])\s*[,]\s+/gi),
      ]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((m) => m[1].toLowerCase()),
    ),
  ];
  if (
    expected.length < 2 ||
    expected.some((l, i) => l !== String.fromCharCode(97 + i))
  )
    return [];
  const points = texts.filter(
    (t) =>
      /^[a-p]$/i.test(t.text.trim()) &&
      t.height >= 5 &&
      t.height <= 20 &&
      t.left >= figure.left &&
      t.right <= figure.right &&
      t.top >= figure.top &&
      t.bottom <= figure.bottom,
  );
  const groups = [...new Set(points.map((p) => p.font))]
    .map((f) => points.filter((p) => p.font === f))
    .filter(
      (ps) =>
        ps.length >= expected.length &&
        ps.length <= 16 &&
        expected.every(
          (l) =>
            ps.filter((p) => p.text.trim().toLowerCase() === l).length === 1,
        ) &&
        [...ps]
          .sort((a, b) =>
            a.text.localeCompare(b.text, undefined, { sensitivity: "base" }),
          )
          .every(
            (p, i) =>
              p.text.trim().toLowerCase() === String.fromCharCode(97 + i),
          ),
    );
  if (groups.length !== 1) return [];
  const sequence = groups[0].map((p) => p.text.trim().toLowerCase()).sort();
  const rows: { y: number; points: PanelText[] }[] = [];
  for (const point of [...groups[0]].sort(
    (a, b) => a.top - b.top || a.left - b.left,
  )) {
    let row = rows.at(-1);
    if (!row || point.top - row.y > Math.max(3, point.height * 0.5)) {
      row = { y: point.top, points: [] };
      rows.push(row);
    }
    row.points.push(point);
  }
  for (const row of rows) row.points.sort((a, b) => a.left - b.left);
  if (
    rows
      .flatMap((r) => r.points.map((p) => p.text.trim().toLowerCase()))
      .join("") !== sequence.join("")
  )
    return [];
  const panels: (FigureBox & { label: string })[] = [];
  let active: typeof panels = [];
  for (const row of rows) {
    const top = Math.max(figure.top, row.y - row.points[0].height * 0.35);
    const starts = row.points.map((p) => p.left - Math.min(10, p.height));
    if (starts[0] - figure.left < row.points[0].height * 2)
      starts[0] = figure.left;
    const next: typeof panels = [];
    for (let i = 0; i < row.points.length; i++) {
      const left = Math.max(figure.left, starts[i]);
      const inherited = active
        .filter((p) => p.left > left + 1)
        .sort((a, b) => a.left - b.left)[0];
      const right =
        i + 1 < starts.length
          ? starts[i + 1]
          : row.points.length > 1
            ? figure.right
            : (inherited?.left ?? figure.right);
      if (right - left < 25) return [];
      const box = {
        label: row.points[i].text.trim().toLowerCase(),
        left,
        right,
        top,
        bottom: figure.bottom,
      };
      for (const old of active)
        if (Math.min(old.right, right) - Math.max(old.left, left) > 1)
          old.bottom = top;
      panels.push(box);
      next.push(box);
    }
    active = [...active.filter((p) => p.bottom === figure.bottom), ...next];
  }
  if (panels.some((p) => p.bottom - p.top < 20)) return [];
  const result = panels.map((p) => ({
    label: p.label,
    region: {
      left: (p.left - figure.left) / (figure.right - figure.left),
      top: (p.top - figure.top) / (figure.bottom - figure.top),
      width: (p.right - p.left) / (figure.right - figure.left),
      height: (p.bottom - p.top) / (figure.bottom - figure.top),
    },
  }));
  return result.every((p) => validRegion(p.region)) ? result : [];
}

// A geometrically plausible split must also pass a raster boundary check.
// Dense ink at an internal cut may be an axis, legend or data: keep the full figure.
export function clearPanelBoundaries(
  ctx: SKRSContext2D,
  width: number,
  height: number,
  panels: FigurePanel[],
): boolean {
  if (!panels.length || width <= 0 || height <= 0) return false;
  const clear = (x: number, y: number, w: number, h: number) => {
    const pixels = ctx.getImageData(x, y, w, h).data;
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i + 3] > 32 && pixels[i] + pixels[i + 1] + pixels[i + 2] < 690)
        ink++;
    return ink / (w * h) <= 0.015;
  };
  for (const p of panels) {
    if (!validRegion(p.region)) return false;
    const b = cropPixels(p.region, width, height);
    for (const x of [b.left, b.left + b.width])
      if (x > 2 && x < width - 2 && !clear(x - 1, b.top, 3, b.height))
        return false;
    for (const y of [b.top, b.top + b.height])
      if (y > 2 && y < height - 2 && !clear(b.left, y - 1, b.width, 3))
        return false;
  }
  return true;
}

export function panelSelectionIds(sources: Source[]) {
  return sources.flatMap((s) =>
    ((s.image && s.imagePanels) || [])
      .filter((p) => validRegion(p.region))
      .map((p) => s.id + ":" + p.label),
  );
}
// Model selects an existing region ID. Coordinates come from printed PDF labels
// or clear raster gutters, never model-generated fractions or another source.
export function applyDeckPanels(
  deck: DeckOutline | null | undefined,
  sources: Source[],
) {
  for (const slide of deck?.slides ?? []) {
    const selected = (slide as typeof slide & { imagePanel?: string })
      .imagePanel;
    if (selected) {
      const source = sources.find((s) => s.id === slide.imageSource && s.image);
      const panel = source?.imagePanels?.find(
        (p) => source.id + ":" + p.label === selected,
      );
      if (!panel || !validRegion(panel.region))
        throw new Error("汇报选择了不属于当前图件的面板；未保存为完成结果。");
      slide.imageCrop = structuredClone(panel.region);
    }
    delete (slide as typeof slide & { imagePanel?: string }).imagePanel;
  }
}
