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
  kind?: "rect" | "roundRect" | "chevron" | "downArrow" | "ellipse";
  role?: "table-row" | "table-rule";
};
export type SlideTable = {
  rows: string[][];
  cellLines: string[][][];
  x: number;
  y: number;
  w: number;
  h: number;
  widths: number[];
  rowHeights: number[];
  fontSize: number;
};
export const slideSize = { width: 13.333333, height: 7.5 };
// Explicit point advances keep SVG, capacity checks, and PowerPoint in sync.
export const slideLineHeight = 1.18;

const slideWordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });

export function wrapSlideText(
  text: string,
  width: number,
  fontSize: number,
  bold = false,
) {
  // Bold CJK glyphs need slightly more room in Office than regular body text.
  const glyphUnits = (c: string) =>
    c.charCodeAt(0) < 128 ? 0.62 : bold ? 1.04 : 1;
  // Reserve room for Office glyph placement. Mixed Latin/CJK labels such as
  // repeated acronyms overflowed the former 0.52-em Latin estimate in PowerPoint.
  const limit = (width * 72 * 0.95) / fontSize,
    lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "",
      length = 0;
    // Keep clinical measurements, signed estimates, and scientific identifiers intact.
    // Match known units before identifiers; an arbitrary English word is not a unit.
    // Short parenthesized category labels and CI expressions also stay together.
    const tokens = (
      paragraph.match(
        /[（(]\p{Script=Han}{1,6}\d+[）)]|\d+(?:\.\d+)?(?:%|％)[ \t]*CI\b|\d+(?:[∶:]\d+)+|\d+(?:\.\d+)?(?:[ \t]*\/[ \t]*\d+(?:\.\d+)?)+|(?:[+−±-][ \t\u00a0]*)?\d[\d,.]*(?:[–—−-][+−-]?\d[\d,.]*)?[ \t\u00a0]*(?:(?:mEq|[mµμ]?mol|[npµμm]?g)\/(?:dL|mL|L|kg)|[µμm]?L(?:\/(?:min|h))?|°[CF]|(?:mm|cm)[ \t\u00a0]*(?:Hg|H2O))(?![A-Za-z0-9_./+-])|(?:mm|cm)[ \t\u00a0]+(?:Hg|H2O)\b|[0-9]+[A-Za-z\u0370-\u03ff][A-Za-z0-9\u0370-\u03ff_./+-]*|(?:[+−±-][ \t\u00a0]*)?\d[\d,.]*(?:(?:%|％|‰)?[ \t\u00a0]*[–—−-][ \t\u00a0]*[+−-]?\d[\d,.]*)?(?:%|％|‰)?|[A-Za-z\u0370-\u03ff][A-Za-z0-9\u0370-\u03ff_./+-]*|\p{Script=Han}+|[^\x00-\x7f]|\s+|./gu,
      ) ?? []
    ).flatMap((token) =>
      /^\p{Script=Han}+$/u.test(token)
        ? Array.from(
            slideWordSegmenter.segment(token),
            ({ segment }) => segment,
          )
        : [token],
    );
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
        /^[，。；：！？、）》」』】”’…,.!?;:)\]＊*†‡⁎⁑⁂¹²³⁴⁵⁶⁷⁸⁹⁰]+$/.test(
          token,
        )
      )
        words[words.length - 1] += token;
      else words.push(token);
    }
    for (const word of words) {
      const units = [...word].reduce((n, c) => n + glyphUnits(c), 0);
      if (length + units > limit && line) {
        lines.push(line.trimEnd());
        line = "";
        length = 0;
      }
      if (units > limit) {
        for (const c of word) {
          const u = glyphUnits(c);
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
                : (/^(?:Table|表)\s*\d+[A-Za-z]?\b/i.exec(s.title)?.[0] ??
                  (s.title.length > 35
                    ? s.title.slice(0, 34).trimEnd() + "…"
                    : s.title)),
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
  let table: SlideTable | undefined;
  let composition = "standard";
  let titleSize = 32,
    titleLines = wrapSlideText(slide.title, 11.8, titleSize);
  while (
    (titleLines.length * titleSize * slideLineHeight) / 72 > 0.9 &&
    titleSize > 22
  ) {
    titleSize--;
    titleLines = wrapSlideText(slide.title, 11.8, titleSize);
  }
  if ((titleLines.length * titleSize * slideLineHeight) / 72 > 0.9)
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
    while (
      (lines.length * fontSize * slideLineHeight) / 72 + 0.09 > h &&
      fontSize > 18
    ) {
      fontSize--;
      lines = wrapSlideText(value, w, fontSize);
    }
    if ((lines.length * fontSize * slideLineHeight) / 72 + 0.09 > h)
      return false;
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
  // A wide original can be larger above a short band of unchanged claims.
  // Keep the usual side column when the band would be dense or reduce the image.
  let wideEvidence:
    | { text: TextBox[]; image: { x: number; y: number; w: number; h: number } }
    | undefined;
  if (
    imageSize &&
    count > 0 &&
    count <= 3 &&
    imageSize.width / imageSize.height >= 1.65
  ) {
    const availableWidth = 11.9 - (count - 1) * 0.38;
    let widths = slide.bullets.map(() => availableWidth / count);
    let blocks = slide.bullets.map((value, i) => {
      const lines = wrapSlideText(value, widths[i], 20);
      return { lines, h: (lines.length * 20 * slideLineHeight) / 72 + 0.09 };
    });
    // Give a long numerical claim more width than a short interpretation.
    // Search line capacity without changing the claims or shrinking the font.
    for (let rows = 1; rows <= 4; rows++) {
      const minimum = slide.bullets.map((value) => {
        let low = 2.4,
          high = availableWidth - (count - 1) * 2.4;
        if (wrapSlideText(value, high, 20).length > rows) return Infinity;
        for (let pass = 0; pass < 18; pass++) {
          const middle = (low + high) / 2;
          if (wrapSlideText(value, middle, 20).length <= rows) high = middle;
          else low = middle;
        }
        return high;
      });
      const spare =
        availableWidth - minimum.reduce((sum, width) => sum + width, 0);
      if (spare < 0 || !Number.isFinite(spare)) continue;
      const candidateWidths = minimum.map((width) => width + spare / count);
      const candidate = slide.bullets.map((value, i) => {
        const lines = wrapSlideText(value, candidateWidths[i], 20);
        return { lines, h: (lines.length * 20 * slideLineHeight) / 72 + 0.09 };
      });
      if (
        Math.max(...candidate.map((b) => b.h)) <
        Math.max(...blocks.map((b) => b.h))
      ) {
        widths = candidateWidths;
        blocks = candidate;
      }
      break;
    }
    const bandHeight = Math.max(...blocks.map((b) => b.h));
    const area = {
      x: 0.72,
      y: 1.53,
      w: 11.9,
      h: 6.68 - bandHeight - 0.24 - 1.53,
    };
    const scale = Math.min(area.w / imageSize.width, area.h / imageSize.height);
    const previousScale = Math.min(
      7.95 / imageSize.width,
      5.18 / imageSize.height,
    );
    if (
      blocks.every((block) => block.lines.length <= 4) &&
      scale >= previousScale * 1.05
    ) {
      const w = imageSize.width * scale,
        h = imageSize.height * scale;
      wideEvidence = {
        image: {
          x: area.x + (area.w - w) / 2,
          y: area.y + (area.h - h) / 2,
          w,
          h,
        },
        text: blocks.map((block, i) => ({
          x:
            0.72 +
            widths.slice(0, i).reduce((sum, width) => sum + width + 0.38, 0),
          y: 6.68 - bandHeight,
          w: widths[i],
          h: block.h,
          fontSize: 20,
          lines: block.lines,
          color: "303039",
          role: "bullet",
          sourceIndex: i,
        })),
      };
    }
  }
  let evidenceColumnWidth = 3.5;
  if (imageSize && imageSize.width / imageSize.height >= 1.65 && count <= 3) {
    for (let tenths = 28; tenths < 35; tenths++) {
      const width = tenths / 10;
      const height =
        slide.bullets.reduce(
          (sum, value) =>
            sum +
            (wrapSlideText(value, width, 20).length * 20 * slideLineHeight) /
              72 +
            0.09,
          0,
        ) +
        Math.max(0, count - 1) * 0.22;
      const gain =
        Math.min(
          (7.95 + 3.5 - width) / imageSize.width,
          5.18 / imageSize.height,
        ) / Math.min(7.95 / imageSize.width, 5.18 / imageSize.height);
      if (height <= 6.68 - 1.7 && gain >= 1.05) {
        evidenceColumnWidth = width;
        break;
      }
    }
  }
  let custom = false;
  const requested = slide.layout ?? "auto";
  if (requested !== "auto" && hasImage)
    throw new Error(
      "流程、对照、重点或表格版式与原图页应分开，请为本页保留一种主要表达。",
    );
  if (requested === "table") {
    // Rows are explicit model-authored cells. Never infer values from prose or
    // fill a short row: a missing measure must be stated by its author.
    const rows = slide.bullets.map((row) =>
      row.split("|").map((cell) => cell.trim()),
    );
    const columns = rows[0]?.length ?? 0;
    if (
      count < 2 ||
      count > 5 ||
      columns < 2 ||
      columns > 5 ||
      rows.some(
        (row) =>
          row.length !== columns ||
          row.some((cell) => !cell || /^:?-{3,}:?$/.test(cell)),
      )
    )
      throw new Error(
        "表格需要表头及一至四行数据，每行二至五个非空单元格，以 | 分隔；不添加Markdown分隔行，缺失指标须明确标注。",
      );
    composition = "table";
    const units = (value: string, bold = false) =>
      [...value].reduce(
        (n, c) => n + (c.charCodeAt(0) < 128 ? 0.62 : bold ? 1.04 : 1),
        0,
      );
    const weights = rows[0].map((_, col) =>
      Math.max(
        6,
        Math.min(24, Math.max(...rows.map((row) => units(row[col])))),
      ),
    );
    // Reserve more space for the longest label/value in each column, with a
    // bounded weight so one long condition cannot starve the other measures.
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const proportionalWidths = weights.map(
      (weight) => (11.9 * weight) / totalWeight,
    );
    let widths = proportionalWidths;
    let fontSize = 23;
    const measure = () => {
      // Padding takes a larger share of short columns. If every column can fit
      // without wrapping, reserve its measured width before sharing spare room.
      const naturalWidths = rows[0].map((_, col) =>
        Math.max(
          1.1,
          (Math.max(
            ...rows.flatMap((row, index) =>
              row[col]
                .split("\n")
                .map((cell) => units(cell, index === 0 || col === 0)),
            ),
          ) *
            fontSize) /
            (72 * 0.95) +
            0.325,
        ),
      );
      const spare = 11.9 - naturalWidths.reduce((sum, width) => sum + width, 0);
      widths =
        spare >= 0
          ? naturalWidths.map((width) => width + spare / columns)
          : [...proportionalWidths];
      if (spare < 0) {
        // Reserve short headers, scientific intervals and denominators before distributing
        // spare space by prose length. A long header must not split 3/1000
        // or leave a confidence interval's closing bracket on its own line.
        let minimumWidths = rows[0].map((_, col) =>
          Math.max(
            1.1,
            (Math.max(
              0,
              ...rows.flatMap((row, index) =>
                [
                  ...(index === 0 && units(row[col], true) <= 8
                    ? [row[col]]
                    : []),
                  ...(row[col].match(
                    /[（(][+−±-]?\d[\d,.]*(?:%|％)?\s*[–—−-]\s*[+−±-]?\d[\d,.]*(?:%|％)?[）)]|\d+(?:\.\d+)?(?:[ \t]*\/[ \t]*\d+(?:\.\d+)?)+|[A-Za-z][A-Za-z0-9_./+-]*/g,
                  ) ?? []),
                ].map((atom) =>
                  /^[A-Za-z]/.test(atom)
                    ? atom.length * (index === 0 || col === 0 ? 0.7 : 0.62)
                    : units(atom, index === 0 || col === 0),
                ),
              ),
            ) *
              fontSize) /
              (72 * 0.95) +
              0.325,
          ),
        );
        // Reserve the row label with its following separator, before a time
        // or other qualifier. Longer labels may wrap within an equal share
        // of the table rather than crowding every result column.
        const labelWidth = Math.min(
          11.9 / columns,
          (Math.max(
            ...rows
              .slice(1)
              .flatMap((row) =>
                row[0]
                  .split("\n")
                  .map((label) =>
                    units(
                      /^[^，,;；]*(?:[，,;；]|$)/.exec(label)?.[0] ?? label,
                      true,
                    ),
                  ),
              ),
          ) *
            fontSize) /
            (72 * 0.95) +
            0.325,
        );
        const withLabels = minimumWidths.map((width, col) =>
          col === 0 ? Math.max(width, labelWidth) : width,
        );
        if (withLabels.reduce((sum, width) => sum + width, 0) <= 11.9)
          minimumWidths = withLabels;
        if (minimumWidths.reduce((sum, width) => sum + width, 0) <= 11.9) {
          const flexible = new Set(weights.map((_, col) => col));
          let available = 11.9;
          while (flexible.size) {
            const weight = [...flexible].reduce(
              (sum, col) => sum + weights[col],
              0,
            );
            const constrained = [...flexible].filter(
              (col) => (available * weights[col]) / weight < minimumWidths[col],
            );
            if (!constrained.length) {
              for (const col of flexible)
                widths[col] = (available * weights[col]) / weight;
              break;
            }
            for (const col of constrained) {
              widths[col] = minimumWidths[col];
              available -= widths[col];
              flexible.delete(col);
            }
          }
        }
      }
      return rows.map((row, index) =>
        row.map((cell, col) =>
          wrapSlideText(
            cell,
            widths[col] - 0.32,
            fontSize,
            index === 0 || col === 0,
          ),
        ),
      );
    };
    let blocks = measure();
    const heights = () =>
      blocks.map((row) =>
        Math.max(
          0.74,
          (Math.max(...row.map((lines) => lines.length)) *
            fontSize *
            slideLineHeight) /
            72 +
            0.32,
        ),
      );
    let rowHeights = heights();
    while (rowHeights.reduce((sum, h) => sum + h, 0) > 4.9 && fontSize > 20) {
      fontSize--;
      blocks = measure();
      rowHeights = heights();
    }
    const totalHeight = rowHeights.reduce((sum, h) => sum + h, 0);
    if (totalHeight > 4.9)
      throw new Error(
        "表格过密，请取舍指标或拆页；不能缩小字号或删除关键区间来容纳。",
      );
    let y = 1.65 + (4.98 - totalHeight) / 2;
    table = {
      rows,
      cellLines: blocks,
      x: 0.72,
      y,
      w: 11.9,
      h: totalHeight,
      widths: [...widths],
      rowHeights: [...rowHeights],
      fontSize,
    };
    rows.forEach((row, index) => {
      const h = rowHeights[index];
      shapes.push({
        x: 0.72,
        y,
        w: 11.9,
        h,
        fill: index === 0 ? "12384A" : index % 2 ? "EDF4F3" : "FFFFFF",
        role: "table-row",
      });
      let x = 0.72;
      row.forEach((_, col) => {
        const lines = blocks[index][col];
        const textHeight =
          (lines.length * fontSize * slideLineHeight) / 72 + 0.09;
        customText.push({
          x: x + 0.16,
          y: y + 0.12,
          w: widths[col] - 0.32,
          h: textHeight,
          fontSize,
          lines,
          color: index === 0 ? "FFFFFF" : "26384A",
          bold: index === 0 || col === 0,
          role: "bullet",
          sourceIndex: index,
        });
        x += widths[col];
      });
      shapes.push({
        x: 0.72,
        y: y + h - 0.012,
        w: 11.9,
        h: 0.012,
        fill: "DCE7E5",
        role: "table-rule",
      });
      y += h;
    });
    custom = true;
  } else if (requested === "flow" && count >= 5 && count <= 6) {
    // A longer route needs wide, short nodes rather than six narrow cards.
    // All steps and their order come from the author; no branch is inferred.
    composition = "flow";
    let fontSize = 24;
    const measure = () =>
      slide.bullets.map((value) => {
        const lines = wrapSlideText(value, 9.7, fontSize);
        const textH = (lines.length * fontSize * slideLineHeight) / 72 + 0.09;
        return { lines, textH, h: Math.max(0.62, textH + 0.18) };
      });
    let rows = measure();
    const height = () =>
      rows.reduce((sum, row) => sum + row.h, 0) + (count - 1) * 0.18;
    while (height() > 4.9 && fontSize > 20) {
      fontSize--;
      rows = measure();
    }
    if (height() > 4.9)
      throw new Error("流程文字过密，请精简节点或拆页，不能缩小关键条件。");
    let y = 1.7 + (4.9 - height()) / 2;
    rows.forEach((row, i) => {
      const dark = i === 0 || i === count - 1;
      shapes.push({
        x: 1.08,
        y,
        w: 11.1,
        h: row.h,
        kind: "roundRect",
        fill: i === 0 ? "12384A" : dark ? "146A71" : "EDF4F3",
      });
      customText.push({
        x: 1.8,
        y: y + (row.h - row.textH) / 2,
        w: 9.7,
        h: row.textH,
        lines: row.lines,
        fontSize,
        color: dark ? "FFFFFF" : "26384A",
        role: "bullet",
        sourceIndex: i,
      });
      if (i < count - 1)
        shapes.push({
          x: 6.5,
          y: y + row.h + 0.025,
          w: 0.28,
          h: 0.13,
          kind: "downArrow",
          fill: "177E7D",
        });
      y += row.h + 0.18;
    });
    custom = true;
  } else if (requested === "comparison" && count === 2) {
    composition = "comparison";
    // A short author-supplied label can head a column. Preserve its punctuation
    // and the full comparison text instead of inventing labels or takeaways.
    shapes.push({ x: 6.65, y: 1.9, w: 0.018, h: 4.45, fill: "DCE7E5" });
    slide.bullets.forEach((value, i) => {
      const x = i === 0 ? 0.98 : 7.1;
      const parts = /^([^：:\n]{1,18}[：:])\s*(.+)$/s.exec(value);
      shapes.push({ x, y: 1.82, w: 0.6, h: 0.055, fill: "177E7D" });
      if (parts) {
        if (
          !put(i, parts[1], x, 2.1, 5.2, 0.92, 29, "12384A", true) ||
          !put(i, value.slice(parts[1].length), x, 3.12, 5.2, 3.05, 26)
        )
          throw new Error("对照文字过密，请保留必要差异并展开较长解释。");
      } else if (!put(i, value, x, 2.25, 5.2, 3.9, 27))
        throw new Error("对照文字过密，请保留必要差异并展开较长解释。");
    });
    custom = true;
  } else if (requested === "flow" || requested === "comparison") {
    const flow = requested === "flow";
    if ((flow && (count < 2 || count > 4)) || (!flow && count !== 2))
      throw new Error(
        flow ? "流程页需要二至六个有序步骤。" : "对照页需要两项并列内容。",
      );
    composition = requested;
    const gap = flow ? 0.5 : 0.55;
    const cardW = (11.9 - (count - 1) * gap) / count;
    const innerW = cardW - 0.6;
    let fontSize = flow ? 24 : 27;
    const measure = () =>
      slide.bullets.map((value) => {
        const lines = wrapSlideText(value, innerW, fontSize);
        return {
          lines,
          h: (lines.length * fontSize * slideLineHeight) / 72 + 0.09,
        };
      });
    let blocks = measure();
    while (blocks.some((block) => block.h > 2.9) && fontSize > 20) {
      fontSize--;
      blocks = measure();
    }
    // Long procedures read as a sequence of wide rows rather than narrow cards.
    // Use the original text and order; the layout never extracts or rewrites steps.
    const rowW = 10.65;
    const rows = slide.bullets.map((value) => {
      const lines = wrapSlideText(value, rowW, 24);
      return { lines, h: (lines.length * 24 * slideLineHeight) / 72 + 0.09 };
    });
    const rowGap = 0.22;
    const rowHeights = rows.map((row) => Math.max(0.8, row.h + 0.12));
    const totalHeight =
      rowHeights.reduce((sum, h) => sum + h, 0) + rowGap * (count - 1);
    const vertical =
      flow &&
      blocks.some(
        (block) =>
          block.lines.length > 3 ||
          (block.lines.length >= 3 &&
            /^\p{Script=Han}[）)。，；：、]*$/u.test(block.lines.at(-1)!)),
      ) &&
      totalHeight <= 4.9;
    if (vertical) {
      let y = 1.7 + (4.9 - totalHeight) / 2;
      shapes.push({
        x: 0.88,
        y: y + 0.16,
        w: 0.018,
        h: totalHeight - rowHeights.at(-1)!,
        fill: "B9D9D3",
      });
      rows.forEach((row, i) => {
        shapes.push({
          x: 0.82,
          y: y + 0.1,
          w: 0.14,
          h: 0.14,
          kind: "ellipse",
          fill: i === 0 ? "12384A" : "177E7D",
        });
        customText.push({
          x: 1.55,
          y,
          w: rowW,
          h: row.h,
          fontSize: 24,
          lines: row.lines,
          color: "26384A",
          role: "bullet",
          marker: String(i + 1).padStart(2, "0"),
          sourceIndex: i,
        });
        y += rowHeights[i] + rowGap;
      });
    } else {
      if (blocks.some((block) => block.h > 2.9))
        throw new Error("图解文字过密，请拆分步骤或比较，保留关键条件与判断。");
      const cardH = Math.max(2.75, ...blocks.map((block) => block.h + 1.05));
      const top = 2.05 + (3.9 - cardH) / 2;
      blocks.forEach((block, i) => {
        const x = 0.72 + i * (cardW + gap);
        shapes.push({
          x,
          y: top,
          w: cardW,
          h: cardH,
          fill: flow && i === 0 ? "12384A" : "EDF4F3",
          kind: "roundRect",
        });
        shapes.push({
          x: x + 0.3,
          y: top + 0.35,
          w: 0.42,
          h: 0.05,
          fill: flow && i === 0 ? "62C4B1" : "177E7D",
        });
        customText.push({
          x: x + 0.3,
          y: top + 0.66,
          w: innerW,
          h: block.h,
          fontSize,
          lines: block.lines,
          color: flow && i === 0 ? "FFFFFF" : "26384A",
          role: "bullet",
          sourceIndex: i,
        });
        if (flow && i < count - 1)
          shapes.push({
            x: x + cardW + 0.13,
            y: top + cardH / 2 - 0.11,
            w: 0.24,
            h: 0.22,
            fill: "177E7D",
            kind: "chevron",
          });
      });
    }
    custom = true;
  } else if (requested === "spotlight") {
    if (count > 3)
      throw new Error(
        "重点页保留一个核心问题及至多两项解释，较复杂的背景请展开。",
      );
    composition = "spotlight";
    const panelW = count === 1 ? 11.9 : 7.1;
    shapes.push({
      x: 0.72,
      y: 1.85,
      w: panelW,
      h: 4.65,
      fill: "12384A",
      kind: "roundRect",
    });
    shapes.push({ x: 1.08, y: 2.22, w: 0.56, h: 0.06, fill: "62C4B1" });
    custom = put(
      0,
      slide.bullets[0],
      1.08,
      2.65,
      panelW - 0.76,
      3.1,
      33,
      "FFFFFF",
      true,
    );
    slide.bullets.slice(1).forEach((value, i) => {
      custom =
        put(i + 1, value, 8.35, 2.08 + i * 2.22, 4.0, 1.88, 24) && custom;
    });
    if (!custom)
      throw new Error(
        "重点页文字过密，请将核心问题与必要解释展开，不能缩成小字。",
      );
  } else if (wideEvidence) {
    composition = "evidence-wide";
    customText.push(...wideEvidence.text);
    custom = true;
  } else if (
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
      !hasImage &&
      count === 3 &&
      /路径|步骤|流程|路线/.test(slide.title) &&
      slide.bullets.every(
        (bullet) => wrapSlideText(bullet, 3.35, 24).length <= 4,
      );
    const columns = hasImage ? 1 : steps ? 3 : count >= 4 ? 2 : 1;
    const bulletW = hasImage
        ? evidenceColumnWidth
        : columns === 3
          ? 3.35
          : columns === 2
            ? 5.1
            : 10.65,
      startY = columns > 1 ? 2.1 : 1.7,
      gap = hasImage ? 0.22 : columns > 1 ? 0.68 : 0.36,
      bodyX = hasImage ? 12.55 - evidenceColumnWidth : columns > 1 ? 0.9 : 1.35;
    // Fit the whole column at one font size instead of shrinking each bullet or
    // spreading a short sentence over a fixed, mostly empty slot.
    let fontSize = hasImage ? 20 : columns > 1 ? 24 : 25;
    const measure = () =>
      slide.bullets.map((b) => {
        const lines = wrapSlideText(b, bulletW, fontSize);
        return {
          lines,
          h:
            (Math.max(1, lines.length) * fontSize * slideLineHeight) / 72 +
            0.09,
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
  // Shared quiet page frame keeps preview and native export consistent.
  shapes.push({ x: 0.75, y: 1.39, w: 0.56, h: 0.045, fill: "177E7D" });
  shapes.push({ x: 0.9, y: 6.91, w: 11.75, h: 0.009, fill: "E2E9E8" });
  const footerLines = wrapSlideText(citationLabel(sources), 11.2, 10);
  const footer = footerLines.slice(0, 2);
  if (footerLines.length > 2)
    footer[1] = footer[1].slice(0, -1).trimEnd() + "…";
  text.push({
    x: 0.9,
    y: 7.0,
    w: 11.2,
    h: 0.37,
    fontSize: 10,
    lines: footer,
    color: "65656F",
    role: "footer",
  });
  let image;
  if (wideEvidence) {
    image = wideEvidence.image;
  } else if (imageSize) {
    const area = {
        x: 0.72,
        y: 1.53,
        w: 7.95 + (3.5 - evidenceColumnWidth),
        h: 5.18,
      },
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
  return { text, image, shapes, composition, background: "FFFFFF", table };
}
