import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfRuntime } from "./pdf-runtime.ts";
import { createCanvas } from "@napi-rs/canvas";
import type { PaperBundle, Source } from "../shared/types.ts";
import { digest } from "./materials.ts";
import { read, save, missingRecord } from "./storage.ts";

export interface ExcerptRange {
  page: number;
  start: string;
  end: string;
}
export interface FigureRegistration {
  number: string;
  page: number;
  results: ExcerptRange[];
  methods: ExcerptRange[];
}
// Registration is explicit evidence mapping; this function never infers a method's applicability.
export async function registerFigureEvidence(
  paper: PaperBundle,
  path: string,
  spec: FigureRegistration,
): Promise<PaperBundle> {
  if (!/^\d+$/.test(spec.number)) throw new Error("图号必须是完整数字。");
  const page = paper.sources.find(
    (s) => s.page === spec.page && s.kind === "paper",
  );
  if (!page) throw new Error("图件所在原页不存在。");
  const mark = new RegExp(
    `(?:Figure|Fig\\.)\\s*${Number(spec.number)}(?!\\d)\\s*\\|`,
    "i",
  ).exec(page.text);
  if (!mark) throw new Error("完整图注未可靠定位，请提供人工图注。");
  const caption = page.text
    .slice(mark.index)
    .split(/N AT u RE|\nFigure\s+\d+\s*\|/)[0]
    .trim();
  if (caption.length < 80) throw new Error("图注过短，请核对完整性。");
  const added: Source[] = [
    {
      id: `${paper.id}-fig${spec.number}`,
      title: `Figure ${spec.number}`,
      kind: "paper",
      page: spec.page,
      figure: spec.number,
      section: "figure",
      relatedFigures: [spec.number],
      text: caption,
      caption,
      locator: `PDF 实际第 ${spec.page} 页；完整图注自提取字符 ${mark.index}；图像为所在原页`,
      verified: false,
    },
  ];
  for (const [section, ranges] of [
    ["results", spec.results],
    ["methods", spec.methods],
  ] as const) {
    if (!ranges.length) throw new Error("请登记目标图的结果与方法原文。");
    const texts: string[] = [],
      positions: string[] = [];
    for (const range of ranges) {
      const source = paper.sources.find(
        (s) => s.page === range.page && s.kind === "paper",
      );
      const from = source?.text.indexOf(range.start) ?? -1;
      const to =
        source?.text.indexOf(range.end, from + range.start.length) ?? -1;
      if (!source || from < 0 || to < 0)
        throw new Error(`PDF 第 ${range.page} 页 ${section} 段落定位失败。`);
      texts.push(source.text.slice(from, to).trim());
      positions.push(`第 ${range.page} 页 ${from}–${to}：${range.start}`);
    }
    added.push({
      id: `${paper.id}-fig${spec.number}-${section}`,
      title: `Figure ${spec.number} ${section} 原文`,
      kind: "paper",
      section,
      relatedFigures: [spec.number],
      text: texts.join("\n\n"),
      locator: "PDF 提取字符范围；" + positions.join("；"),
      verified: false,
    });
  }
  const bytes = new Uint8Array(await readFile(path));
  const key = digest({
    file: Buffer.from(bytes).toString("base64"),
    page: spec.page,
    scale: 1.3,
    renderer: "pdf-page-v2-jbig2",
  });
  try {
    added[0].image = await read<string>("material-cache", key);
  } catch (error: any) {
    if (!missingRecord(error)) throw error;
    const task = getDocument({ ...pdfRuntime, data: bytes });
    try {
      const pdf = await task.promise,
        pdfPage = await pdf.getPage(spec.page),
        viewport = pdfPage.getViewport({ scale: 1.3 });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await pdfPage.render({
        canvas: canvas as any,
        canvasContext: canvas.getContext("2d") as any,
        viewport,
      }).promise;
      added[0].image = canvas.toDataURL("image/png");
      await save("material-cache", key, added[0].image);
    } finally {
      await task.destroy();
    }
  }
  const ids = new Set(added.map((s) => s.id));
  return {
    ...paper,
    version:
      paper.version +
      "-figure-" +
      digest({ spec, added: added.map(({ image, ...s }) => s) }).slice(0, 12),
    sources: [...paper.sources.filter((s) => !ids.has(s.id)), ...added],
  };
}
