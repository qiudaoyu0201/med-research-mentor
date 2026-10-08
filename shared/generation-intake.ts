import type { PaperBundle } from "./types.ts";
import type { SourceSelector } from "./research-plan.ts";

// Budget is shared fairly: no selected paper may silently disappear from a draft.
export function selectPlanSources(
  papers: PaperBundle[],
  selectedIds: string[],
  request = "",
): SourceSelector[] {
  const ids = [...new Set(selectedIds)];
  if (ids.length > 12)
    throw new Error(
      "一次最多选择 12 篇参考论文，请保留与研究问题最相关的论文。",
    );
  const selected = ids.map((id) => {
    const paper = papers.find((p) => p.id === id);
    if (!paper) throw new Error("所选参考论文已不存在，请重新选择参考论文。");
    return paper;
  });
  const allowance = Math.floor(18000 / Math.max(1, selected.length));
  // Rank actual bounded excerpts. Lexical relevance is a retrieval heuristic,
  // not a scientific relevance verdict; retain locators and exact offsets.
  const terms = [...new Set(request.toLowerCase().match(/[a-z][a-z0-9-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [])]
    .flatMap((term) => /[\u4e00-\u9fff]/.test(term)
      ? Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2))
      : [term]);
  const score = (text: string) => {
    const lower = text.toLowerCase();
    return terms.reduce((n, term) => n + (lower.includes(term) ? 4 : 0), 0) +
      (/methods?|materials?|实验设计|研究方法|对照组/i.test(text) ? 2 : 0);
  };
  const queues = selected.map((paper) => ({
    paper,
    used: 0,
    sources: paper.sources.filter(
      (s) =>
        s.kind === "paper" &&
        !s.image &&
        s.text.trim(),
    ).flatMap((s) => {
      if (s.text.length <= allowance) return [{ source: s, text: s.text, range: undefined as SourceSelector["range"] }];
      const chunks = [];
      const size = Math.min(allowance, 4000);
      for (let start = 0; start < s.text.length; start += size) {
        const end = Math.min(start + size, s.text.length);
        const text = s.text.slice(start, end);
        if (text.trim()) chunks.push({ source: s, text, range: { start, end } });
      }
      return chunks;
    }).sort((a, b) => score(b.text) - score(a.text)),
  }));
  const missing = queues.filter((q) => !q.sources.length);
  if (missing.length)
    throw new Error(
      `这些参考论文缺少可读取的正文，或正文超出本次可读取范围：${missing.map((q) => q.paper.title).join("、")}。请减少所选论文或更换 PDF 后重试。`,
    );
  const sources: SourceSelector[] = [];
  let added = true;
  while (added && sources.length < 12) {
    added = false;
    for (const queue of queues) {
      const index = queue.sources.findIndex(
        (s) => queue.used + s.text.length <= allowance,
      );
      if (index < 0 || sources.length >= 12) continue;
      const [source] = queue.sources.splice(index, 1);
      sources.push({
        paperId: queue.paper.id,
        sourceVersion: queue.paper.version,
        sourceId: source.source.id,
        ...(source.range ? { range: source.range } : {}),
      });
      queue.used += source.text.length;
      added = true;
    }
  }
  return sources;
}

export function chronological<
  T extends { createdAt?: string; updatedAt?: string },
>(items: T[]): T[] {
  const time = (item: T) =>
    Date.parse(item.updatedAt ?? item.createdAt ?? "") || 0;
  return [...items].sort((a, b) => time(a) - time(b));
}
