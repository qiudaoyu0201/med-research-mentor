import { OPS, Util, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import type { Source } from "../shared/types.ts";
import { figurePanels, clearPanelBoundaries } from "./figure-panels.ts";
import { rasterFigureRegions } from "./raster-figure-bands.ts";
import type { ImageRegion } from "../shared/image-region.ts";

type Box = { left: number; top: number; right: number; bottom: number };
// Use PDF drawing geometry and printed caption anchors, never model-generated pixels.
// Uncertain pages remain available through the original PDF and manual crop.
export async function pageFigures(
  page: PDFPageProxy,
  id: string,
  items: any[],
): Promise<Source[]> {
  const viewport = page.getViewport({ scale: 1 }),
    W = viewport.width,
    H = viewport.height;
  const texts = items
    .filter((i) => typeof i.str === "string" && i.str.trim())
    .map((i) => {
      const m = Util.transform(viewport.transform, i.transform);
      const h = Math.hypot(m[2], m[3]);
      return {
        text: i.str,
        font: i.fontName ?? "",
        left: m[4],
        top: m[5] - h,
        right: m[4] + i.width,
        bottom: m[5],
        height: h,
      };
    });
  const captions = texts
    .filter((t) => {
      const label = t.text.trim();
      const wholeAnchor = /^(?:Fig(?:ure)?\.?|图)\s*\d+\s*(?:[|:：.]|\s)/i.test(
        label,
      );
      // Some PDFs put the bold figure number and normal punctuation in separate runs.
      // Require adjacent punctuation on the same baseline; bare in-text references do not qualify.
      const splitAnchor =
        /^(?:Fig(?:ure)?\.?|图)\s*\d+$/i.test(label) &&
        texts.some(
          (next) =>
            /^[|:：.](?:\s|$)/.test(next.text.trim()) &&
            Math.abs(next.bottom - t.bottom) <=
              Math.max(t.height, next.height) * 0.35 &&
            next.left >= t.right - 1 &&
            next.left <= t.right + Math.max(t.height, next.height) * 1.5,
        );
      // Font changes can split a body sentence just before "Fig 2.". A caption
      // must start its local line, not borrow a plot from a preceding caption.
      // Check only adjacent runs so independent columns remain valid anchors.
      const inlineReference = texts.some(
        (previous) =>
          previous !== t &&
          Math.abs(previous.bottom - t.bottom) <=
            Math.max(previous.height, t.height) * 0.35 &&
          previous.left < t.left &&
          previous.right <= t.left + 1 &&
          previous.right >= t.left - Math.max(previous.height, t.height) * 1.5,
      );
      return (
        (wholeAnchor || splitAnchor) &&
        !inlineReference &&
        t.top > H * 0.06 &&
        t.top < H * 0.95
      );
    })
    .sort((a, b) => a.top - b.top);
  if (!captions.length) return [];
  const ops = await page.getOperatorList(),
    boxes: Box[] = [];
  let matrix = [...viewport.transform];
  const stack: number[][] = [];
  const add = (b: number[]) => {
    const corners = [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[0], b[3]],
      [b[2], b[3]],
    ].map((p) => {
      Util.applyTransform(p, matrix);
      return p;
    });
    const box = {
      left: Math.min(...corners.map((p) => p[0])),
      right: Math.max(...corners.map((p) => p[0])),
      top: Math.min(...corners.map((p) => p[1])),
      bottom: Math.max(...corners.map((p) => p[1])),
    };
    if (
      box.bottom - box.top > 1 &&
      box.right - box.left > 1 &&
      box.top > H * 0.055 &&
      box.bottom < H * 0.96 &&
      (box.bottom - box.top) * (box.right - box.left) < W * H * 0.65
    )
      boxes.push(box);
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const f = ops.fnArray[i],
      a = ops.argsArray[i];
    if (f === OPS.save || f === OPS.paintFormXObjectBegin) {
      stack.push([...matrix]);
      if (f === OPS.paintFormXObjectBegin && a[0])
        matrix = Util.transform(matrix, a[0]);
    } else if (f === OPS.restore || f === OPS.paintFormXObjectEnd)
      matrix = stack.pop() ?? matrix;
    else if (f === OPS.transform)
      matrix = Util.transform(matrix, a.length === 1 ? a[0] : a);
    else if (f === OPS.constructPath && a[2] && a[0] !== OPS.endPath)
      add(Array.from(a[2]));
    else if (
      [
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageMaskXObject,
      ].includes(f)
    )
      add([0, 0, 1, 1]);
  }
  const regions: { region: ImageRegion; caption: string; number: string }[] =
    [];
  for (const cap of captions) {
    const line = texts
      .filter((t) => Math.abs(t.top - cap.top) < cap.height * 0.8)
      .sort((a, b) => a.left - b.left);
    let capRight = cap.right;
    for (const t of line.filter((t) => t.left >= cap.left - 2)) {
      if (t.left > capRight + W * 0.07) break;
      capRight = Math.max(capRight, t.right);
    }
    const column =
      capRight - cap.left > W * 0.55
        ? { left: 0, right: W }
        : {
            left: Math.max(0, cap.left - 15),
            right: Math.min(W, capRight + 15),
          };
    const previous = captions
      .filter(
        (c) =>
          c.top < cap.top - 2 && c.left < column.right && c.right > column.left,
      )
      .at(-1);
    const topLimit = previous ? previous.bottom + 15 : H * 0.06;
    const graphics = boxes.filter(
      (b) =>
        b.top >= topLimit &&
        b.bottom <= cap.top + 1 &&
        b.right > column.left &&
        b.left < column.right,
    );
    if (!graphics.length) continue;
    let left = Math.min(...graphics.map((b) => b.left)),
      right = Math.max(...graphics.map((b) => b.right)),
      top = Math.min(...graphics.map((b) => b.top)),
      bottom = Math.max(...graphics.map((b) => b.bottom));
    // Include text labels just outside vector/raster bounds, but never the caption/body.
    for (const t of texts.filter(
      (t) =>
        t.bottom < cap.top - 1 &&
        t.top >= top - 18 &&
        t.bottom <= bottom + 18 &&
        t.right >= left - 24 &&
        t.left <= right + 24,
    )) {
      left = Math.min(left, t.left);
      right = Math.max(right, t.right);
      top = Math.min(top, t.top);
      bottom = Math.max(bottom, t.bottom);
    }
    left = Math.max(0, left - 7);
    right = Math.min(W, right + 7);
    top = Math.max(topLimit, top - 7);
    bottom = Math.min(cap.top - 2, bottom + 7);
    if (right - left < 60 || bottom - top < 35) continue;
    // A short caption title can sit above full-width explanatory lines. When
    // the first continuation line starts at the caption margin, use its real
    // width instead of the title or plot width; this keeps long captions while
    // retaining the column guard for unrelated body text.
    const captionRight = Math.max(
      column.right,
      right,
      ...texts
        .filter(
          (t) =>
            t.top > cap.top + cap.height * 0.8 &&
            t.top <= cap.top + cap.height * 2.2 &&
            t.left >= cap.left - 2 &&
            t.left <= cap.left + cap.height * 1.2 &&
            t.height <= cap.height * 1.1,
        )
        .map((t) => t.right),
    );
    const nextCaption = captions.find(
      (c) =>
        c.top > cap.top + cap.height &&
        c.left < captionRight &&
        c.right > cap.left,
    );
    const captionBottom = Math.min(
      H * 0.95,
      cap.top + H * 0.25,
      nextCaption?.top ?? H,
    );
    const candidates = texts
      .filter(
        (t) =>
          t.top >= cap.top - 1 &&
          t.top < captionBottom &&
          t.left >= cap.left - 2 &&
          t.right <= captionRight + 2 &&
          t.height <= cap.height * 1.1,
      )
      .sort(
        (a, b) =>
          Math.round(a.top / 3) - Math.round(b.top / 3) || a.left - b.left,
      );
    const captionRuns: typeof texts = [];
    let lastCaptionTop = cap.top;
    for (const t of candidates) {
      // A vertical break marks body text or a footer, even if its font matches.
      if (t.top - lastCaptionTop > cap.height * 1.8) break;
      captionRuns.push(t);
      lastCaptionTop = Math.max(lastCaptionTop, t.top);
      if (/^doi\s*:/i.test(t.text.trim())) break;
    }
    const caption = captionRuns
      .map((t) => t.text)
      .join(" ")
      .slice(0, 7000);
    regions.push({
      region: {
        left: left / W,
        top: top / H,
        width: (right - left) / W,
        height: (bottom - top) / H,
      },
      caption,
      number: /\d+/.exec(cap.text)![0],
    });
  }
  if (!regions.length) return [];
  const scale = Math.min(2200 / W, Math.sqrt(6_000_000 / (W * H))),
    full = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(full.width), Math.ceil(full.height));
  await page.render({
    canvas: canvas as any,
    canvasContext: canvas.getContext("2d") as any,
    viewport: full,
  }).promise;
  return regions.map(({ region, caption, number }, index) => {
    const w = Math.ceil(region.width * canvas.width),
      h = Math.ceil(region.height * canvas.height),
      crop = createCanvas(w, h);
    crop
      .getContext("2d")
      .drawImage(
        canvas,
        region.left * canvas.width,
        region.top * canvas.height,
        w,
        h,
        0,
        0,
        w,
        h,
      );
    const panels = figurePanels(
      {
        left: region.left * W,
        top: region.top * H,
        right: (region.left + region.width) * W,
        bottom: (region.top + region.height) * H,
      },
      caption,
      texts,
    );
    const candidates = panels.length
      ? panels
      : rasterFigureRegions(crop.getContext("2d"), w, h);
    const imagePanels = clearPanelBoundaries(
      crop.getContext("2d"),
      w,
      h,
      candidates,
    )
      ? candidates
      : undefined;
    return {
      ...(imagePanels?.length ? { imagePanels } : {}),
      id: `${id}-p${page.pageNumber}-fig${number}-${index + 1}`,
      title: `Figure ${number}`,
      kind: "paper",
      page: page.pageNumber,
      figure: number,
      section: "figure",
      relatedFigures: [number],
      locator: `PDF 第 ${page.pageNumber} 页，Figure ${number}，按原页图形边界提取`,
      text: caption,
      caption,
      verified: false,
      image: crop.toDataURL("image/png"),
      imagePurpose: "figure",
      imageRegion: region,
      imageWidth: w,
      imageHeight: h,
    };
  });
}
