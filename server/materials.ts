import { createHash } from "node:crypto";
import type { Source, PaperBundle } from "../shared/types.ts";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const selectionVersion = "generic-evidence-v3-ppt-methods";
export function figureNumber(text: string) {
  const match = /(?:Figure|Fig\.?|图)\s*([\d一二两三四五六七八九十]+)/i.exec(
    text,
  )?.[1];
  if (!match) return undefined;
  if (/^\d+$/.test(match)) return String(Number(match));
  const digit = (s: string) =>
    s === "两" ? 2 : "一二三四五六七八九".indexOf(s) + 1;
  const [tens, units] = match.split("十");
  return String(
    match.includes("十")
      ? (tens ? digit(tens) : 1) * 10 + (units ? digit(units) : 0)
      : digit(match),
  );
}
export function matchesFigure(source: Source, number: string) {
  if (source.relatedFigures?.includes(number)) return true;
  const label = source.figure?.match(/^\s*(\d+)(?!\d)/)?.[1];
  return label
    ? String(Number(label)) === number
    : figureNumber(source.caption ?? "") === number;
}
export function bindPaperEvidence(paper: PaperBundle): PaperBundle {
  return {
    ...paper,
    sources: paper.sources.map((s) =>
      s.kind === "paper"
        ? { ...s, paperId: paper.id, paperVersion: paper.version }
        : s,
    ),
  };
}
export function defaultPaperSources(
  paper: PaperBundle,
  question: string,
  modules: string[],
) {
  const number = figureNumber(question);
  const images = paper.sources.filter(
    (s) =>
      s.kind === "paper" && s.image && (!number || matchesFigure(s, number)),
  );
  if (modules.includes("figure") || number) {
    if (images.length !== 1) return [];
    const target = images[0];
    const actual =
      number ??
      figureNumber(
        target.figure ? "Figure " + target.figure : (target.caption ?? ""),
      );
    return [
      target,
      ...paper.sources.filter(
        (s) =>
          s.id !== target.id &&
          s.kind === "paper" &&
          !s.image &&
          actual &&
          s.relatedFigures?.includes(actual),
      ),
    ];
  }
  if (modules.includes("ppt"))
    return paper.sources.filter((s) => s.kind === "paper" && !s.image);
  return paper.sources
    .filter((s) => s.kind === "paper" && !s.image && s.section !== "methods")
    .slice(0, 4);
}
export function selectEvidence(
  sources: Source[],
  question: string,
  modules: string[],
) {
  try {
    materialPacket(sources);
    return sources;
  } catch (error) {
    if (!(error as Error).message.includes("20,000")) throw error;
  }
  const target = figureNumber(question);
  const score = (s: Source) => {
    if (s.image && (!target || matchesFigure(s, target))) return 100;
    if (target && matchesFigure(s, target))
      return s.section === "results" ? 95 : 90;
    if (s.kind === "foundation") return modules.includes("method") ? 85 : 50;
    if (s.section === "overview") return 70;
    return 20;
  };
  const required = sources.filter(
    (s) =>
      (s.image && (!target || matchesFigure(s, target))) ||
      (target &&
        matchesFigure(s, target) &&
        ["results", "methods"].includes(s.section ?? "")),
  );
  // Never silently drop the caption or the registered evidence for the target figure.
  materialPacket(required);
  const blocks = new Set<string>();
  let length = 0;
  const selected = [...sources]
    .sort((a, b) => score(b) - score(a))
    .filter((s) => {
      const hash = digest(s.text);
      if (blocks.has(hash)) return true;
      if (length + s.text.length > 20_000) {
        if (required.some((x) => x.id === s.id))
          throw new Error("关键图注或论文证据超过材料额度，请缩小目标。 ");
        return false;
      }
      blocks.add(hash);
      length += s.text.length;
      return true;
    });
  if (!selected.length)
    throw new Error("目标段落超过材料额度，请选择更短的原文范围。");
  return selected;
}
export function materialPacket(sources: Source[]) {
  const blocks = new Map<string, { hash: string; text: string }>();
  const references = sources.map(({ text, image, ...source }) => {
    const hash = digest(text);
    blocks.set(hash, { hash, text });
    return { ...source, blockHash: hash };
  });
  const length = [...blocks.values()].reduce((n, b) => n + b.text.length, 0);
  if (length > 20_000)
    throw new Error("相关原文超过 20,000 字符，请缩小到目标段落或图件。");
  return { blocks: [...blocks.values()], references };
}
// Fixed local Figure 1 evidence: retain exact extracted text and locations rather than summaries.
export function figureOneEvidence(sources: Source[]) {
  const page = (number: number) =>
    sources.find((s) => s.id === `xu-original-p${number}`)?.text;
  const p2 = page(2),
    p12 = page(12),
    p13 = page(13);
  if (!p2 || !p12 || !p13) return [];
  const excerpt = (text: string, start: string, end: string) => {
    const from = text.indexOf(start),
      to = text.indexOf(end, from + start.length);
    if (from < 0 || to < 0)
      throw new Error("Figure 1 资料段落定位失败，请核对原始 PDF。");
    return { text: text.slice(from, to).trim(), from, to };
  };
  const results = excerpt(p2, "Transplanting small numbers", "\n*");
  const transplant = excerpt(
    p12,
    "Cell transplantation.",
    "Bioluminescence imaging.",
  );
  const imaging = excerpt(
    p12,
    "Bioluminescence imaging.",
    "Physical function measurements.",
  );
  const physicalStart = p12.indexOf("Physical function measurements.");
  if (physicalStart < 0) throw new Error("Figure 1 功能测量方法缺失。");
  const physicalEnd = p13.indexOf("Real-time PCR.");
  if (physicalEnd < 0) throw new Error("Figure 1 跨页方法定位失败。");
  const pcr = excerpt(p13, "Real-time PCR.", "Testosterone assay.");
  const references = page(10);
  const assayReference = references
    ? excerpt(references, "14.   Xu, M.", "15.   Xu, M.")
    : undefined;
  const staining = excerpt(
    p13,
    "SA- β gal assay and immunostaining.",
    "Statistical analysis.",
  );
  const stats = excerpt(p13, "Statistical analysis.", "Reporting Summary.");
  return [
    {
      id: "xu-fig1-results",
      title: "Figure 1 对应结果原文",
      kind: "paper" as const,
      section: "results" as const,
      relatedFigures: ["1"],
      page: 2,
      text: results.text,
      locator: `PDF 第 2 页，Results，提取字符 ${results.from}–${results.to}`,
      verified: false,
    },
    {
      id: "xu-fig1-methods",
      title: "Figure 1 相关方法原文",
      kind: "paper" as const,
      section: "methods" as const,
      relatedFigures: ["1"],
      page: 12,
      text: [
        transplant.text,
        imaging.text,
        p12.slice(physicalStart).split("N AT u RE")[0],
        p13.slice(0, physicalEnd),
        pcr.text,
        staining.text,
        stats.text,
        ...(assayReference ? [assayReference.text] : []),
      ].join("\n\n"),
      locator:
        "PDF 第 12–13 页，Cell transplantation / Bioluminescence imaging / Physical function measurements / Real-time PCR / SA-βgal assay and immunostaining / Statistical analysis；第 10 页参考文献 14，核对 SABG 方法引用链",
      verified: false,
    },
  ];
}
