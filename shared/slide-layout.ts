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
  sourceIndex?: number;
};
export type SlideShape = {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
};
export const slideSize = { width: 13.333333, height: 7.5 };
export function wrapSlideText(text: string, width: number, fontSize: number) {
  // Reserve room for Office glyph placement. Mixed Latin/CJK labels such as
  // repeated acronyms overflowed the former 0.52-em Latin estimate in PowerPoint.
  const limit = (width * 72 * 0.95) / fontSize,
    lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "",
      length = 0;
    // Keep compound pressure units and digit-leading scientific identifiers intact.
    const tokens =
      paragraph.match(
        /(?:mm|cm)[ \t\u00a0]+(?:Hg|H2O)\b|[0-9]+[A-Za-z\u0370-\u03ff][A-Za-z0-9\u0370-\u03ff_./+-]*|\d[\d,.]*(?:[–—−-]\d[\d,.]*)?(?:%|％)?|[A-Za-z\u0370-\u03ff][A-Za-z0-9\u0370-\u03ff_./+-]*|[^\x00-\x7f]|\s+|./gu,
      ) ?? [];
    const words: string[] = [];
    // Keep closing punctuation with the preceding token before wrapping;
    // appending it after wrapping would overflow an already full line.
    for (const token of tokens) {
      if (words.length && /^[（(《「『【“‘]+$/.test(words[words.length - 1])) {
        words[words.length - 1] += token;
        continue;
      }
      if (
        words.length &&
        /^[，。；：！？、）》」』】”’…,.!?;:)\]]+$/.test(token)
      )
        words[words.length - 1] += token;
      else words.push(token);
    }
    for (const word of words) {
      const units = [...word].reduce(
        (n, c) => n + (/[\x00-\x7f]/.test(c) ? 0.62 : 1),
        0,
      );
      if (length + units > limit && line) {
        lines.push(line.trimEnd());
        line = "";
        length = 0;
      }
      if (units > limit) {
        for (const c of word) {
          const u = /[\x00-\x7f]/.test(c) ? 0.62 : 1;
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
  const shapes: SlideShape[] = [];
  let composition = "standard";
  let titleSize = 32,
    titleLines = wrapSlideText(slide.title, 11.8, titleSize);
  while ((titleLines.length * titleSize * 1.18) / 72 > 0.9 && titleSize > 22) {
    titleSize--;
    titleLines = wrapSlideText(slide.title, 11.8, titleSize);
  }
  if ((titleLines.length * titleSize * 1.18) / 72 > 0.9)
    throw new Error("幻灯片标题太长，请精简后再导出。");
  text.push({
    x: 0.75,
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
  // Use the content's existing emphasis; do not invent claims, chart data, or
  // causal arrows merely to make a scientific slide look more varied.
  const questionIndex = slide.bullets.findIndex((b) =>
    /^(?:核心|研究)?问题[：:]/.test(b),
  );
  const effectIndex = slide.bullets.findIndex((b) =>
    /\b(?:OR|HR|RR)\b.*\d/i.test(b),
  );
  const takeawayIndex = slide.bullets.findIndex((b) =>
    /^(?:启发|可?借鉴|下一步|建议|核心结论)[：:]/.test(b),
  );
  const comparisonIndices = slide.bullets.flatMap((b, i) =>
    /\d.*\bvs\.?\s*\d/i.test(b) ? [i] : [],
  );
  const customText: TextBox[] = [];
  const put = (
    index: number,
    value: string,
    x: number,
    y: number,
    w: number,
    h: number,
    preferred: number,
    color = "26384A",
    bold = false,
  ) => {
    let fontSize = preferred;
    let lines = wrapSlideText(value, w, fontSize);
    while ((lines.length * fontSize * 1.18) / 72 + 0.09 > h && fontSize > 18) {
      fontSize--;
      lines = wrapSlideText(value, w, fontSize);
    }
    if ((lines.length * fontSize * 1.18) / 72 + 0.09 > h) return false;
    customText.push({
      x,
      y,
      w,
      h,
      fontSize,
      lines,
      color,
      bold,
      role: "bullet",
      sourceIndex: index,
    });
    return true;
  };
  let custom = false;
  if (
    !hasImage &&
    count >= 3 &&
    count <= 5 &&
    /背景|问题/.test(slide.title) &&
    questionIndex >= 0
  ) {
    composition = "question";
    shapes.push({ x: 0.65, y: 1.65, w: 6.15, h: 4.98, fill: "12384A" });
    custom = put(
      questionIndex,
      slide.bullets[questionIndex],
      1.03,
      2.22,
      5.38,
      3.75,
      34,
      "FFFFFF",
      true,
    );
    const rest = slide.bullets
      .map((_, i) => i)
      .filter((i) => i !== questionIndex);
    rest.forEach((i, row) => {
      custom =
        put(
          i,
          slide.bullets[i],
          7.35,
          1.94 + row * (4.65 / rest.length),
          5.18,
          4.65 / rest.length - 0.3,
          23,
        ) && custom;
    });
  } else if (
    !hasImage &&
    count >= 3 &&
    count <= 5 &&
    /结果|数据|证据|终点/.test(slide.title) &&
    effectIndex >= 0
  ) {
    composition = "results";
    shapes.push({ x: 0.65, y: 5.03, w: 12.02, h: 1.6, fill: "12384A" });
    custom = put(
      effectIndex,
      slide.bullets[effectIndex],
      1.02,
      5.29,
      11.25,
      1.14,
      30,
      "FFFFFF",
      true,
    );
    const rest = slide.bullets
      .map((_, i) => i)
      .filter((i) => i !== effectIndex);
    rest.forEach((i, order) => {
      const x = 0.95 + (order % 2) * 6.05,
        y = 1.76 + Math.floor(order / 2) * 1.58;
      const parts = /^(.*?[：:])\s*(.+)$/.exec(slide.bullets[i]);
      if (parts && parts[1].length <= 14 && /\d/.test(parts[2])) {
        custom = put(i, parts[1], x, y, 5.32, 0.4, 18, "596B79") && custom;
        custom =
          put(i, parts[2], x, y + 0.47, 5.32, 0.93, 33, "146A71", true) &&
          custom;
      } else
        custom =
          put(i, slide.bullets[i], x, y + 0.18, 5.32, 1.12, 24) && custom;
    });
  } else if (
    !hasImage &&
    count >= 3 &&
    count <= 5 &&
    /结果|数据|证据|终点/.test(slide.title) &&
    comparisonIndices.length >= Math.max(2, count - 2) &&
    comparisonIndices.length <= 3
  ) {
    composition = "comparisons";
    const width =
      (12.02 - (comparisonIndices.length - 1) * 0.28) /
      comparisonIndices.length;
    custom = true;
    comparisonIndices.forEach((index, order) => {
      const x = 0.65 + order * (width + 0.28);
      shapes.push({ x, y: 1.65, w: width, h: 3.1, fill: "E8F2F2" });
      custom =
        put(
          index,
          slide.bullets[index],
          x + 0.28,
          2.0,
          width - 0.56,
          2.38,
          29,
          "12535D",
          true,
        ) && custom;
    });
    const rest = slide.bullets
      .map((_, i) => i)
      .filter((i) => !comparisonIndices.includes(i));
    rest.forEach((index, order) => {
      custom =
        put(
          index,
          slide.bullets[index],
          0.95 + order * 6.05,
          5.13,
          rest.length === 1 ? 11.3 : 5.32,
          1.35,
          24,
        ) && custom;
    });
  } else if (
    !hasImage &&
    count >= 4 &&
    count <= 5 &&
    /设计|方法|测量/.test(slide.title)
  ) {
    composition = "methods";
    shapes.push({ x: 0.65, y: 1.65, w: 3.15, h: 4.98, fill: "E8F2F2" });
    custom = put(
      0,
      slide.bullets[0],
      1.0,
      2.16,
      2.45,
      3.98,
      26,
      "12535D",
      true,
    );
    slide.bullets.slice(1).forEach((value, order) => {
      custom =
        put(
          order + 1,
          value,
          4.32 + (order % 2) * 4.4,
          2.0 + Math.floor(order / 2) * 2.35,
          3.65,
          1.95,
          23,
        ) && custom;
    });
  } else if (
    !hasImage &&
    count >= 3 &&
    count <= 5 &&
    /局限|启发|总结/.test(slide.title) &&
    takeawayIndex >= 0
  ) {
    composition = "takeaway";
    shapes.push({ x: 0.65, y: 5.03, w: 12.02, h: 1.6, fill: "E8F2F2" });
    custom = put(
      takeawayIndex,
      slide.bullets[takeawayIndex],
      1.02,
      5.28,
      11.25,
      1.14,
      27,
      "12535D",
      true,
    );
    slide.bullets
      .map((_, i) => i)
      .filter((i) => i !== takeawayIndex)
      .forEach((i, order) => {
        custom =
          put(
            i,
            slide.bullets[i],
            0.95 + (order % 2) * 6.05,
            1.85 + Math.floor(order / 2) * 1.52,
            5.32,
            1.25,
            23,
          ) && custom;
      });
  }
  if (custom) {
    // Keep the source order in the document even when emphasis moves visually.
    text.push(...customText.sort((a, b) => a.sourceIndex! - b.sourceIndex!));
  } else {
    shapes.length = 0;
    composition = hasImage ? "evidence" : "standard";
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
  return { text, image, shapes, composition, background: "FFFFFF" };
}
