import type { Slide, Source } from "./types.ts";
export type TextBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  lines: string[];
  bold?: boolean;
  color: string;
  role?: "title" | "bullet" | "footer";
  marker?: string;
  markerAbove?: boolean;
};
export const slideSize = { width: 13.333333, height: 7.5 };
export function wrapSlideText(text: string, width: number, fontSize: number) {
  // Office glyph placement needs room beyond nominal character widths.
  const limit = (width * 72 * 0.95) / fontSize,
    lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "",
      length = 0;
    const tokens =
      paragraph.match(
        /\d[\d,.]*(?:[–—−-]\d[\d,.]*)?(?:%|％)?|[A-Za-z\u0370-\u03ff][A-Za-z0-9\u0370-\u03ff_./+-]*|[^\x00-\x7f]|\s+|./gu,
      ) ?? [];
    const words: string[] = [];
    // Keep closing punctuation with the preceding token before wrapping;
    // appending it after wrapping would overflow an already full line.
    for (const token of tokens) {
      if (
        words.length &&
        /^[，。；：！？、）》」』】”’…,.!?;:)\]]+$/.test(token)
      )
        words[words.length - 1] += token;
      else words.push(token);
    }
    for (const word of words) {
      const units = [...word].reduce(
        (n, c) => n + (/[\x00-\x7f]/.test(c) ? 0.52 : 1),
        0,
      );
      if (length + units > limit && line) {
        lines.push(line.trimEnd());
        line = "";
        length = 0;
      }
      if (units > limit) {
        for (const c of word) {
          const u = /[\x00-\x7f]/.test(c) ? 0.52 : 1;
          if (length + u > limit && line) {
            lines.push(line);
            line = "";
            length = 0;
          }
          line += c;
          length += u;
        }
      } else {
        line += word;
        length += units;
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}
export function citationLabel(sources: Source[]) {
  const figurePages = new Set(
    sources
      .filter((s) => s.page && s.figure && /^\d+$/.test(s.figure))
      .map((s) => s.page),
  );
  return [
    ...new Set(
      sources
        .filter(
          (s) =>
            !s.page ||
            !figurePages.has(s.page) ||
            (s.figure && /^\d+$/.test(s.figure)),
        )
        .map((s) =>
          s.figure && /^\d+$/.test(s.figure)
            ? `Fig. ${s.figure}${s.page ? ` · p. ${s.page}` : ""}`
            : s.page
              ? `PDF p. ${s.page}`
              : s.kind === "foundation"
                ? "方法参考"
                : s.title.slice(0, 35),
        ),
    ),
  ].join("  ·  ");
}
export function slideLayout(
  slide: Slide,
  sources: Source[],
  imageSize?: { width: number; height: number },
) {
  const text: TextBox[] = [];
  let titleSize = 32,
    titleLines = wrapSlideText(slide.title, 11.8, titleSize);
  while ((titleLines.length * titleSize * 1.18) / 72 > 0.9 && titleSize > 22) {
    titleSize--;
    titleLines = wrapSlideText(slide.title, 11.8, titleSize);
  }
  if ((titleLines.length * titleSize * 1.18) / 72 > 0.9)
    throw new Error("幻灯片标题太长，请精简后再导出。");
  text.push({
    x: 0.85,
    y: 0.55,
    w: 11.8,
    h: 0.9,
    fontSize: titleSize,
    lines: titleLines,
    bold: true,
    color: "1D1D1F",
    role: "title",
  });
  const hasImage = !!imageSize;
  const count = slide.bullets.length;
  const steps =
    !hasImage && count === 3 && /路径|步骤|流程|路线/.test(slide.title);
  const columns = hasImage ? 1 : steps ? 3 : count >= 4 ? 2 : 1;
  const bulletW = hasImage
      ? 3.5
      : columns === 3
        ? 3.35
        : columns === 2
          ? 5.1
          : 10.65,
    startY = columns > 1 ? 2.1 : 1.7,
    gap = hasImage ? 0.22 : columns > 1 ? 0.68 : 0.36,
    bodyX = hasImage ? 9.05 : columns > 1 ? 0.9 : 1.35;
  // Fit the whole column at one font size instead of shrinking each bullet or
  // spreading a short sentence over a fixed, mostly empty slot.
  let fontSize = hasImage ? 20 : columns > 1 ? 24 : 25;
  const measure = () =>
    slide.bullets.map((b) => {
      const lines = wrapSlideText(b, bulletW, fontSize);
      return {
        lines,
        h: (Math.max(1, lines.length) * fontSize * 1.18) / 72 + 0.09,
      };
    });
  let blocks = measure();
  const rowHeights = () =>
    Array.from({ length: Math.ceil(count / columns) }, (_, row) =>
      Math.max(
        ...blocks.slice(row * columns, (row + 1) * columns).map((b) => b.h),
      ),
    );
  const height = () =>
    rowHeights().reduce((sum, h) => sum + h, 0) +
    Math.max(0, Math.ceil(count / columns) - 1) * gap;
  const available = 6.68 - startY;
  while (height() > available && fontSize > 17) {
    fontSize--;
    blocks = measure();
  }
  if (height() > available)
    throw new Error(
      "幻灯片要点过密，请精简页面内容并将解释移入讲述提示后再导出。",
    );
  let y = startY;
  for (const [i, b] of blocks.entries()) {
    text.push({
      x:
        bodyX +
        (i % columns) * (columns === 3 ? 4.08 : columns === 2 ? 6.1 : 0),
      y,
      w: bulletW,
      h: b.h,
      fontSize,
      lines: b.lines,
      color: "303039",
      role: "bullet",
      marker: hasImage ? undefined : String(i + 1).padStart(2, "0"),
      markerAbove: columns > 1,
    });
    if (i % columns === columns - 1)
      y += rowHeights()[Math.floor(i / columns)] + gap;
  }
  const footer = wrapSlideText(citationLabel(sources), 11.2, 11).slice(0, 1);
  text.push({
    x: 0.9,
    y: 7.02,
    w: 11.2,
    h: 0.22,
    fontSize: 11,
    lines: footer,
    color: "65656F",
    role: "footer",
  });
  let image;
  if (imageSize) {
    const area = { x: 0.72, y: 1.53, w: 7.95, h: 5.18 },
      scale = Math.min(area.w / imageSize.width, area.h / imageSize.height),
      w = imageSize.width * scale,
      h = imageSize.height * scale;
    image = {
      x: area.x + (area.w - w) / 2,
      y: area.y + (area.h - h) / 2,
      w,
      h,
    };
  }
  return { text, image };
}
