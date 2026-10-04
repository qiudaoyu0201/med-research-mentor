import { createHash } from "node:crypto";
import type { Source } from "../shared/types.ts";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  const target = /(?:Figure|图)\s*(\d+)/i.exec(question)?.[1];
  const method = /PCR|Ct\b|流式/i.test(question);
  const score = (s: Source) => {
    if (s.image && (!target || s.figure?.startsWith(target))) return 100;
    if (target === "1" && s.id === "xu-fig1-results") return 95;
    if (
      target === "1" &&
      modules.includes("method") &&
      s.id === "xu-fig1-methods"
    )
      return 90;
    if (s.kind === "foundation") return method ? 85 : 10;
    if (s.id === "xu-question") return 80;
    if (s.id === "xu-design") return 75;
    if (/methods|results/.test(s.id)) return 15;
    return 40;
  };
  const blocks = new Set<string>();
  let length = 0;
  const selected = [...sources]
    .sort((a, b) => score(b) - score(a))
    .filter((s) => {
      const hash = digest(s.text);
      if (blocks.has(hash)) return true;
      if (length + s.text.length > 20_000) return false;
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
  const stats = excerpt(p13, "Statistical analysis.", "Reporting Summary.");
  return [
    {
      id: "xu-fig1-results",
      title: "Figure 1 对应结果原文",
      kind: "paper" as const,
      page: 2,
      text: results.text,
      locator: `PDF 第 2 页，Results，提取字符 ${results.from}–${results.to}`,
      verified: false,
    },
    {
      id: "xu-fig1-methods",
      title: "Figure 1 相关方法原文",
      kind: "paper" as const,
      page: 12,
      text: [
        transplant.text,
        imaging.text,
        p12.slice(physicalStart).split("N AT u RE")[0],
        p13.slice(0, physicalEnd),
        pcr.text,
        stats.text,
      ].join("\n\n"),
      locator:
        "PDF 第 12–13 页，Cell transplantation / Bioluminescence imaging / Physical function measurements / Real-time PCR / Statistical analysis",
      verified: false,
    },
  ];
}
