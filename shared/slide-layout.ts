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
};
export const slideSize = { width: 13.333333, height: 7.5 };
export function wrapSlideText(text: string, width: number, fontSize: number) {
  const limit = (width * 72) / fontSize,
    lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "",
      length = 0;
    for (const word of paragraph.match(
      /\d[\d,.]*(?:[–—−-]\d[\d,.]*)?(?:%|％)?|[A-Za-z][A-Za-z0-9_./+-]*|[^\x00-\x7f]|\s+|./gu,
    ) ?? []) {
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
  let titleSize = 27,
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
  });
  const hasImage = !!imageSize;
  const bulletW = hasImage ? 3.5 : 11.6,
    slot = hasImage ? 1.02 : 0.89;
  for (const [i, b] of slide.bullets.entries()) {
    let fontSize = hasImage ? 18 : 24;
    let lines = wrapSlideText(b, bulletW, fontSize);
    while (
      (lines.length * fontSize * 1.18) / 72 > slot - 0.12 &&
      fontSize > 14
    ) {
      fontSize--;
      lines = wrapSlideText(b, bulletW, fontSize);
    }
    if ((lines.length * fontSize * 1.18) / 72 > slot - 0.06)
      throw new Error(`第 ${i + 1} 条要点太长，请精简后再导出。`);
    text.push({
      x: hasImage ? 9.05 : 0.9,
      y: 1.65 + i * slot,
      w: bulletW,
      h: slot - 0.1,
      fontSize,
      lines,
      color: "303039",
    });
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
