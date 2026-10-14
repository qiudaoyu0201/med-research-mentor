import { createHash } from "node:crypto";
import type { Source, PaperBundle } from "../shared/types.ts";
import { preferredSources } from "../shared/image-region.ts";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const selectionVersion = "generic-evidence-v8-trial-anchors";
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
  // Report requests may name several figures as emphasis, not as a restriction
  // to the first figure mentioned. Preserve whole-paper context for composition.
  if (modules.includes("ppt"))
    return preferredSources(paper.sources).filter((s) => s.kind === "paper");
  const number = figureNumber(question);
  const images = preferredSources(paper.sources).filter(
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
  return paper.sources.filter((s) => s.kind === "paper" && !s.image);
}
export function selectEvidence(
  sources: Source[],
  question: string,
  modules: string[],
) {
  const genericPages = sources.filter(
    (s) => !s.image && /^PDF 第 \d+ 页$/.test(s.title),
  );
  if (
    genericPages.length &&
    sources.reduce((n, s) => n + s.text.length, 0) > 20_000
  ) {
    const terms = evidenceTerms(question);
    const ranked = [...sources].sort(
      (a, b) => pageScore(b, terms, modules) - pageScore(a, terms, modules),
    );
    const selected = ranked
      .filter(
        (s) =>
          !s.image ||
          modules.includes("ppt") ||
          !targetFigure(question) ||
          matchesFigure(s, targetFigure(question)!),
      )
      .slice(0, 18);
    materialPacket(selected, question);
    return selected;
  }
  try {
    materialPacket(sources);
    return sources;
  } catch (error) {
    if (!(error as Error).message.includes("20,000")) throw error;
  }
  const target = modules.includes("ppt") ? undefined : figureNumber(question);
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
const targetFigure = (question: string) => figureNumber(question);
function evidenceTerms(question: string) {
  const normalized = question.toLowerCase();
  const terms: string[] = normalized.match(/[a-z][a-z0-9-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  // Page text is usually English while the user may ask in Chinese. Keep
  // method-specific anchors together so excerpting does not leave only a
  // section heading and its final sentence. These aliases are selection hints,
  // not claims about what the paper used.
  if (/缺失|失访|插补|不完整/.test(normalized))
    terms.push("missing", "imputation", "mice", "mar", "mnar");
  if (/中期|停止|提前结束|alpha|显著性/.test(normalized))
    terms.push("interim", "stopping", "alpha-spending");
  if (/随机|分组|随访|流程/.test(normalized))
    terms.push("randomized", "allocation", "follow-up");
  if (/主要终点|主要结局/.test(normalized))
    terms.push("primary", "outcome", "endpoint");
  if (/安全性|不良事件/.test(normalized))
    terms.push("adverse", "serious", "complications", "safety");
  if (/非劣|等效|non[ -]?inferior|equivalence/.test(normalized))
    terms.push(
      "non-inferiority",
      "noninferiority",
      "equivalence",
      "margin",
      "confidence",
      "intention-to-treat",
      "per-protocol",
    );
  return [...new Set(terms)];
}
function containsEvidenceTerm(text: string, term: string) {
  if (/^[a-z][a-z0-9-]*$/i.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  }
  return text.includes(term);
}
function pageScore(s: Source, terms: string[], modules: string[]) {
  const t = s.text.toLowerCase();
  return (
    (s.image ? 120 : 0) +
    (s.page === 1 ? 55 : 0) +
    (/methods|materials|statistical analysis|研究方法|统计分析/i.test(t)
      ? modules.includes("method") || modules.includes("ppt")
        ? 80
        : 35
      : 0) +
    (/results|结果/i.test(t) ? 45 : 0) +
    (s.section === "methods" ? 60 : 0) +
    terms.reduce((n, w) => n + (containsEvidenceTerm(t, w) ? 15 : 0), 0)
  );
}
export function materialPacket(
  sources: Source[],
  question = "",
  focusIds: string[] = [],
) {
  const rawLength = [
    ...new Map(sources.map((s) => [digest(s.text), s.text])).values(),
  ].reduce((n, t) => n + t.length, 0);
  const pageExcerpts =
    rawLength > 20_000 && sources.some((s) => /^PDF 第 \d+ 页$/.test(s.title));
  // A material request may concern text that exists on an already selected page
  // but was omitted by compression. Preserve its complete block for revision,
  // sharing the original input allowance rather than appending unlimited text.
  const focused = new Set<string>();
  let focusedLength = 0;
  for (const id of focusIds) {
    const source = sources.find((s) => s.id === id);
    if (!source) continue;
    const hash = digest(source.text);
    if (focused.has(hash)) continue;
    if (focusedLength + source.text.length > 10_000) continue;
    focused.add(hash);
    focusedLength += source.text.length;
  }
  const unfocused = new Set(
    sources.map((s) => digest(s.text)).filter((hash) => !focused.has(hash)),
  );
  const quota = Math.floor(
    (19_000 - focusedLength) / Math.max(1, unfocused.size),
  );
  const terms = evidenceTerms(question);
  const blocks = new Map<string, { hash: string; text: string }>();
  const references = sources.map(({ text, image, ...metadata }) => {
    // In excerpt mode the block is the actual visible evidence. Repeating full
    // captions in metadata defeats the input bound and hides coverage limits.
    const source = pageExcerpts
      ? { ...metadata, caption: undefined }
      : metadata;
    const hash = digest(text);
    if (!pageExcerpts || focused.has(hash) || text.length <= quota) {
      blocks.set(hash, { hash, text });
      return { ...source, blockHash: hash };
    }
    const chunks: { start: number; end: number; score: number }[] = [];
    for (let start = 0; start < text.length; start += 600) {
      const end = Math.min(text.length, start + 600),
        part = text.slice(start, end).toLowerCase();
      chunks.push({
        start,
        end,
        score:
          (start === 0 ? 8 : 0) +
          (/methods|materials|statistical analysis|研究方法|统计分析/i.test(
            part,
          )
            ? 12
            : 0) +
          (/results|结果/i.test(part) ? 5 : 0) +
          terms.reduce((n, w) => n + (containsEvidenceTerm(part, w) ? 10 : 0), 0),
      });
    }
    let remaining = quota;
    const slices = chunks
      .sort((a, b) => b.score - a.score || a.start - b.start)
      .flatMap((c) => {
        if (remaining < 100) return [];
        const end = Math.min(c.end, c.start + remaining);
        remaining -= end - c.start;
        return [{ start: c.start, end }];
      })
      .sort((a, b) => a.start - b.start);
    const excerpt = slices
      .map(
        (c) => `[提取字符 ${c.start}–${c.end}]\n${text.slice(c.start, c.end)}`,
      )
      .join("\n\n");
    blocks.set(hash, { hash, text: excerpt });
    return {
      ...source,
      blockHash: hash,
      visibleRanges: slices,
      fullText: false,
    };
  });
  const length = [...blocks.values()].reduce((n, b) => n + b.text.length, 0);
  if (length > (pageExcerpts ? 22_000 : 20_000))
    throw new Error("相关原文超过 20,000 字符，请缩小到目标段落或图件。");
  return {
    blocks: [...blocks.values()],
    references,
    ...(pageExcerpts
      ? {
          coverage:
            "按问题选择的原文片段，visibleRanges 为实际提供范围，不代表全文阅读。",
        }
      : {}),
  };
}

type EvidenceRange = { start: number; end: number };
function mergedRanges(ranges: EvidenceRange[]) {
  const merged: EvidenceRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end)
      last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
function excerptText(text: string, ranges: EvidenceRange[]) {
  return ranges
    .map((r) => `[提取字符 ${r.start}–${r.end}]\n${text.slice(r.start, r.end)}`)
    .join("\n\n");
}

// Revision extends the actual prior exposure, never a newly compressed substitute.
// Additions share the existing 22,000-character excerpt allowance. Unavailable
// additions remain partial/pending rather than displacing already supplied facts.
export function revisionMaterialPacket(
  previous: ReturnType<typeof materialPacket>,
  sources: Source[],
  question = "",
  focusIds: string[] = [],
): ReturnType<typeof materialPacket> {
  const candidate = materialPacket(sources, question, focusIds);
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const oldBlocks = new Map(previous.blocks.map((b) => [b.hash, b.text]));
  if (
    sourceById.size !== sources.length ||
    oldBlocks.size !== previous.blocks.length
  )
    throw new Error("修订证据绑定重复，不能确认先前提供范围。");
  const selected = new Map<string, EvidenceRange[]>();
  const priorById = new Map(previous.references.map((r) => [r.id, r]));
  if (priorById.size !== previous.references.length)
    throw new Error("修订证据引用重复。");
  for (const ref of previous.references) {
    const source = sourceById.get(ref.id);
    if (
      !source ||
      digest(source.text) !== ref.blockHash ||
      source.kind !== ref.kind ||
      source.paperId !== ref.paperId ||
      source.paperVersion !== ref.paperVersion
    )
      throw new Error("修订证据来源改变，不能确认先前提供范围。");
    const partial = "fullText" in ref && ref.fullText === false;
    const ranges = partial
      ? ref.visibleRanges
      : [{ start: 0, end: source.text.length }];
    if (
      !ranges?.length ||
      ranges.some(
        (r, i) =>
          !Number.isInteger(r.start) ||
          !Number.isInteger(r.end) ||
          r.start < 0 ||
          r.end <= r.start ||
          r.end > source.text.length ||
          (i > 0 && r.start < ranges[i - 1].end),
      ) ||
      oldBlocks.get(ref.blockHash) !==
        (partial ? excerptText(source.text, ranges) : source.text)
    )
      throw new Error("修订证据文字与可见范围不一致。");
    selected.set(
      ref.blockHash,
      mergedRanges([...(selected.get(ref.blockHash) ?? []), ...ranges]),
    );
  }
  if ([...oldBlocks.keys()].some((hash) => !selected.has(hash)))
    throw new Error("修订证据含未绑定文字块。");
  const textByHash = new Map(sources.map((s) => [digest(s.text), s.text]));
  const visibleText = (hash: string, ranges: EvidenceRange[]) => {
    const text = textByHash.get(hash)!;
    return ranges.length === 1 &&
      ranges[0].start === 0 &&
      ranges[0].end === text.length
      ? text
      : excerptText(text, ranges);
  };
  let length = [...selected].reduce(
    (n, [h, r]) => n + visibleText(h, r).length,
    0,
  );
  if (length > 22_000) throw new Error("先前修订证据超过材料额度。");
  const allowedReferences = new Set(previous.references.map((r) => r.id));
  let extended = false;
  const tryAdd = (hash: string, range: EvidenceRange) => {
    const old = selected.get(hash) ?? [];
    const next = mergedRanges([...old, range]);
    const delta =
      visibleText(hash, next).length -
      (old.length ? visibleText(hash, old).length : 0);
    if (length + delta > 22_000) return false;
    if (
      next.reduce((n, r) => n + r.end - r.start, 0) >
      old.reduce((n, r) => n + r.end - r.start, 0)
    )
      extended = true;
    selected.set(hash, next);
    length += delta;
    return true;
  };
  // Requested pages first, then new sources, then other useful candidate ranges.
  const priority = (id: string) =>
    focusIds.includes(id) ? 0 : priorById.has(id) ? 2 : 1;
  for (const ref of [...candidate.references].sort(
    (a, b) => priority(a.id) - priority(b.id),
  )) {
    const source = sourceById.get(ref.id)!;
    const hash = ref.blockHash;
    if (source.kind === "foundation" && !priorById.has(ref.id)) {
      if (tryAdd(hash, { start: 0, end: source.text.length }))
        allowedReferences.add(ref.id);
      continue;
    }
    const ranges =
      "fullText" in ref && ref.fullText === false
        ? ref.visibleRanges!
        : [{ start: 0, end: source.text.length }];
    for (const range of ranges) {
      if (tryAdd(hash, range)) continue;
      // Preserve a bounded additional excerpt when the whole requested range
      // cannot fit. Coverage remains explicit; it is never reported as full.
      let low = range.start,
        high = range.end;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const old = selected.get(hash) ?? [];
        const next = mergedRanges([...old, { start: range.start, end: mid }]);
        const delta =
          visibleText(hash, next).length -
          (old.length ? visibleText(hash, old).length : 0);
        if (length + delta <= 22_000) low = mid;
        else high = mid - 1;
      }
      if (low - range.start >= 100)
        tryAdd(hash, { start: range.start, end: low });
    }
    if (selected.has(hash)) allowedReferences.add(ref.id);
  }
  if (
    !extended &&
    !candidate.references.some(
      (ref) => !priorById.has(ref.id) && allowedReferences.has(ref.id),
    )
  )
    return previous;
  const references = candidate.references.flatMap((ref) => {
    const ranges = selected.get(ref.blockHash);
    if (!ranges || !allowedReferences.has(ref.id)) return [];
    const metadata: Omit<Source, "text" | "image"> & {
      blockHash: string;
      fullText?: false;
      visibleRanges?: EvidenceRange[];
    } = { ...(priorById.get(ref.id) ?? ref) };
    delete metadata.fullText;
    delete metadata.visibleRanges;
    const text = textByHash.get(ref.blockHash)!;
    const complete =
      ranges.length === 1 &&
      ranges[0].start === 0 &&
      ranges[0].end === text.length;
    return [
      {
        ...metadata,
        ...(complete
          ? {}
          : { fullText: false as const, visibleRanges: ranges }),
      },
    ];
  });
  return {
    blocks: [...selected].map(([hash, ranges]) => ({
      hash,
      text: visibleText(hash, ranges),
    })),
    references,
    ...(references.some((r) => "fullText" in r && r.fullText === false)
      ? {
          coverage:
            "保留先前实际提供范围并在额度内补充；visibleRanges 为本次实际提供范围，不代表全文阅读。",
        }
      : {}),
  };
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
