export type EvidenceRange = { start: number; end: number };
type Topic = { terms: string[]; anchor: RegExp };
export function containsEvidenceTerm(text: string, term: string) {
  if (/^[a-z][a-z0-9-]*$/i.test(term)) {
    // The guard permits only letters, digits and literal hyphens.
    return new RegExp("\\b" + term + "\\b", "i").test(text);
  }
  return text.includes(term);
}
function requestedTopics(question: string): Topic[] {
  const topics: Topic[] = [];
  const add = (request: RegExp, terms: string[], anchor: RegExp) => {
    if (request.test(question)) topics.push({ terms, anchor });
  };
  add(
    /缺失|失访|插补|不完整|\bmissing\b|\bimputation\b/i,
    ["missing", "imputation", "mice", "mar", "mnar"],
    /missing\s+(?:data|values)|multiple\s+imputation|缺失|插补/i,
  );
  add(
    /研究对象|研究人群|人群|入组|纳排|队列|外部验证|\bpopulation\b|\bcohort\b|\beligibility\b/i,
    [
      "population",
      "patients",
      "participants",
      "eligibility",
      "inclusion",
      "excluded",
    ],
    /study\s+population|eligibility|inclusion\s+criteria|exclusion\s+criteria|纳排|入组/i,
  );
  add(
    /结局|终点|\boutcomes?\b|\bendpoints?\b/i,
    ["outcome", "outcomes", "endpoint", "endpoints"],
    /primary\s+(?:outcome|endpoint)|(?:outcomes?|endpoints?)\s+(?:was|were|is|are)\s+defined|主要结局|主要终点/i,
  );
  add(
    /校准|\bcalibration\b|\brecalibration\b/i,
    ["calibration", "recalibration"],
    /model\s+(?:validation\s+and\s+)?calibration|calibration\s+(?:was|is)|校准/i,
  );
  add(
    /非劣|等效|non[ -]?inferior|equivalence/i,
    [
      "non-inferiority",
      "noninferiority",
      "equivalence",
      "margin",
      "confidence",
    ],
    /non[ -]?inferiority\s+margin|equivalence\s+margin|非劣效界值|等效界值/i,
  );
  add(
    /安全性|不良事件|\bsafety\b|\badverse\b/i,
    ["adverse", "serious", "complications", "safety"],
    /(?:serious\s+)?adverse\s+events|安全性|不良事件/i,
  );
  return topics;
}
// Preserve natural source blocks, including PDF hard-wrapped definitions. Only
// oversized blocks need sentence splitting; all offsets refer to untouched text.
function naturalSpans(text: string): EvidenceRange[] {
  const cuts = [0];
  for (const match of text.matchAll(/\r?\n[ \t]*/g)) {
    const before = text
      .slice(Math.max(0, match.index! - 32), match.index)
      .trimEnd();
    const lineStart = match.index! + match[0].length;
    const lineEnd = text.indexOf("\n", lineStart);
    const heading = text
      .slice(
        lineStart,
        Math.min(lineEnd < 0 ? text.length : lineEnd, lineStart + 80),
      )
      .trim();
    if (
      /[.!?。！？]["')\]]*$/.test(before) ||
      (/^(?:[A-Z][A-Za-z /-]{2,65}|[\u4e00-\u9fff]{2,20})$/.test(heading) &&
        heading.split(/\s+/).length <= 6)
    )
      cuts.push(match.index + match[0].length);
  }
  cuts.push(text.length);
  const spans: EvidenceRange[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    let start = cuts[i];
    const end = cuts[i + 1];
    while (end - start > 900) {
      const boundaries = [
        ...text
          .slice(start, Math.min(end, start + 900))
          .matchAll(/[.!?。！？]["')\]]*\s+/g),
      ]
        .map((m) => start + m.index! + m[0].length)
        .filter((b) => b >= start + 300)
        .sort(
          (a, b) =>
            Math.abs(a - start - 600) - Math.abs(b - start - 600) || a - b,
        );
      const next = boundaries[0] ?? start + 600;
      spans.push({ start, end: next });
      start = next;
    }
    if (end > start) spans.push({ start, end });
  }
  return spans;
}
export function evidenceExcerptRanges(
  text: string,
  quota: number,
  terms: string[],
  question: string,
): EvidenceRange[] {
  const topics = requestedTopics(question);
  const chunks = naturalSpans(text).map((range) => {
    const part = text.slice(range.start, range.end).toLowerCase();
    return {
      ...range,
      score:
        (range.start === 0 ? 8 : 0) +
        (/methods|materials|statistical analysis|研究方法|统计分析/i.test(part)
          ? 12
          : 0) +
        (/results|结果/i.test(part) ? 5 : 0) +
        terms.reduce((n, w) => n + (containsEvidenceTerm(part, w) ? 10 : 0), 0),
      topics: topics.map(
        (t) =>
          t.terms.reduce(
            (n, w) => n + (containsEvidenceTerm(part, w) ? 1 : 0),
            0,
          ) + (t.anchor.test(part) ? 5 : 0),
      ),
    };
  });
  const ranked = [...chunks].sort(
    (a, b) => b.score - a.score || a.start - b.start,
  );
  // Prefer one relevant span per requested topic before filling with repeated
  // high-scoring text. This is bounded selection, not a claim of full coverage.
  const representatives = topics.flatMap((_, index) => {
    const best = [...chunks]
      .filter((c) => c.topics[index] > 0)
      .sort(
        (a, b) =>
          b.topics[index] - a.topics[index] ||
          b.score - a.score ||
          a.start - b.start,
      )[0];
    return best ? [best] : [];
  });
  const selected: EvidenceRange[] = [];
  let remaining = quota;
  for (const chunk of [...new Set(representatives)]) {
    if (chunk.end - chunk.start > remaining) continue;
    selected.push({ start: chunk.start, end: chunk.end });
    remaining -= chunk.end - chunk.start;
  }
  // Fill in relevance order. Do not jump past an earlier relevant span merely
  // because a shorter tail fits. Prefer a sentence end within the spare space.
  for (const chunk of ranked) {
    if (remaining < 100) break;
    if (selected.some((r) => r.start === chunk.start)) continue;
    if (chunk.end - chunk.start <= remaining) {
      selected.push({ start: chunk.start, end: chunk.end });
      remaining -= chunk.end - chunk.start;
      continue;
    }
    const prefix = text.slice(chunk.start, chunk.start + remaining);
    const ends = [...prefix.matchAll(/[.!?。！？]["')\]]*\s+/g)].map(
      (m) => m.index! + m[0].length,
    );
    const length = ends.at(-1) ?? (selected.length ? 0 : prefix.length);
    if (!length) continue;
    selected.push({ start: chunk.start, end: chunk.start + length });
    remaining -= length;
  }
  return selected
    .sort((a, b) => a.start - b.start)
    .reduce<EvidenceRange[]>((ranges, range) => {
      const previous = ranges.at(-1);
      if (previous?.end === range.start) previous.end = range.end;
      else ranges.push({ ...range });
      return ranges;
    }, []);
}
