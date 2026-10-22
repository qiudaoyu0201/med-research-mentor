export type EvidenceRange = { start: number; end: number };
type Topic = { terms: string[]; anchor: RegExp; requireAnchor: boolean };
export function containsEvidenceTerm(text: string, term: string) {
  if (/^[a-z][a-z0-9-]*$/i.test(term)) {
    // The guard permits only letters, digits and literal hyphens.
    return new RegExp("\\b" + term + "\\b", "i").test(text);
  }
  return text.includes(term);
}
function requestedTopics(question: string): Topic[] {
  const topics: Topic[] = [];
  const add = (
    request: RegExp,
    terms: string[],
    anchor: RegExp,
    requireAnchor = false,
  ) => {
    if (request.test(question)) topics.push({ terms, anchor, requireAnchor });
  };
  add(
    /缺失|失访|插补|不完整|\bmissing\b|\bimputation\b/i,
    ["missing", "imputation", "mice", "mar", "mnar"],
    /missing\s+(?:data|values)|multiple\s+imputation|缺失|插补/i,
  );
  const populationRequest =
    /研究对象|研究人群|人群|入组|纳排|队列|外部验证|研究设计|\bstudy\s+design\b|\bpopulation\b|\bcohort\b|\beligibility\b/i;
  add(
    populationRequest,
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
    populationRequest,
    ["baseline", "characteristics", "identified", "recruited", "enrolled"],
    /baseline\s+characteristics(?:\s+of\s+(?:the\s+)?(?:patients|participants|cohort))?|(?:identified|included|enrolled|recruited)\s+[\d,]+\s+(?:eligible\s+)?(?:patients|participants|adults|children)|(?:patients|participants)\s*\(\s*n\s*=|基线特征|共(?:纳入|入组)|纳入\s*[\d,]+/i,
    true,
  );
  add(
    populationRequest,
    [
      "retrospective",
      "prospective",
      "multicenter",
      "multicentre",
      "single-center",
      "single-centre",
    ],
    /study\s+(?:design|setting)(?:\s+and\s+(?:setting|participants))?|(?:single|multi)[ -]cent(?:er|re)|(?:conducted|performed|undertook)\s+(?:a\s+)?(?:retrospective|prospective)|研究设计|单中心|多中心|回顾性|前瞻性/i,
    true,
  );
  add(
    populationRequest,
    ["linked", "limited", "restricted", "population", "setting"],
    /(?:limited|restricted)\s+(?:the\s+)?(?:study|analysis)\s+to|patient\s+records?\s+were\s+linked|recruitment\s+(?:setting|sites)|研究地区|研究场所/i,
    true,
  );
  const interventionRequest =
    /干预|治疗|联用|操作流程|给药|\bintervention\b|\btreatment\b|\bprocedures?\b/i;
  add(
    interventionRequest,
    ["infused", "administered", "dose", "catheter", "saline", "temperature"],
    /(?:infused|administered)\s+(?:at|through|via)|(?:of|with)\s+[\d.]+\s*°?\s*c\b|给药|输注/i,
    true,
  );
  add(
    interventionRequest,
    ["control", "group", "received", "underwent", "identical", "saline"],
    /(?:control|comparator|placebo)\s+group\s+(?:received|underwent|was\s+(?:given|treated))|对照组(?:接受|给予|采用)/i,
    true,
  );
  add(
    /统计|分析|结果|结论|证据|多重|\bstatistic(?:al|s)\b|\bmultiplicity\b|\bcomparisons?\b/i,
    ["correction", "corrections", "adjustment", "multiple", "comparisons"],
    /(?:no|without)\s+(?:corrections?|adjustments?)[\s\S]{0,60}(?:multiple|repeated)\s+(?:comparisons?|testing)|(?:not|un)adjusted[\s\S]{0,40}multiple\s+(?:comparisons?|testing)|多重比较|多重检验/i,
    true,
  );
  // Assignment to a strategy and regrouping for analysis answer different
  // questions. Keep both definitions when the reader asks about trial groups.
  const trialGroups =
    /随机(?:分配|分组|比较|试验|对照)|分组|选择权|偏好|切换|按实际|意向(?:性)?治疗|\brandomi[sz](?:ed|ation)\b|\b(?:assignment|allocation|as[ -]treated|per[ -]protocol|intention[ -]to[ -]treat)\b/i;
  add(
    trialGroups,
    ["enrollment", "enrolment", "rerandomized", "rerandomised", "withdrawals"],
    /erroneously[\s\S]{0,50}rerandomi[sz]ed|(?:second|duplicate)[\s\S]{0,100}(?:randomi[sz]ation|enrol[l]?ment|record)|participant\s+flow|重复随机|重复记录|受试者流程/i,
  );
  add(
    trialGroups,
    [
      "choice",
      "preference",
      "preferences",
      "choose",
      "chose",
      "switch",
      "switching",
    ],
    /choice\s+(?:arm|group)|(?:allowed|option|permitted|free)\s+to\s+switch|participants?\s+(?:could|chose|choose)|选择权|偏好|切换/i,
  );
  add(
    trialGroups,
    [
      "intention-to-treat",
      "itt",
      "as-treated",
      "per-protocol",
      "reclassified",
      "reassigned",
    ],
    /as[ -]treated|per[ -]protocol|intention[ -]to[ -]treat|analy[sz]ed\s+in[\s\S]{0,100}randomi[sz]ed|按实际|意向(?:性)?治疗|重新分组/i,
  );
  add(
    /结局|终点|\boutcomes?\b|\bendpoints?\b/i,
    ["outcome", "outcomes", "endpoint", "endpoints"],
    /primary\s+(?:outcome|endpoint)|(?:outcomes?|endpoints?)\s+(?:was|were|is|are)\s+defined|主要结局|主要终点/i,
    true,
  );
  // Keep the mechanism of a stated limitation, not only its heading. Selection
  // and verification bias differ from unavailable measurements and transportability.
  const limitationRequest =
    /局限|偏倚|外推|适用范围|\blimitations?\b|\bbias\b|\bgenerali[sz]ability\b/i;
  add(
    limitationRequest,
    [
      "selection",
      "verification",
      "false",
      "sensitivity",
      "bias",
      "under-estimated",
      "underestimated",
      "over-estimated",
      "overestimated",
    ],
    /selection\s+bias|verification\s+bias|false\s+negatives?[\s\S]{0,100}(?:under.?estimated|missed)|sensitivity[\s\S]{0,70}over.?estimated|选择偏倚|验证偏倚/i,
    true,
  );
  add(
    limitationRequest,
    [
      "not",
      "data",
      "measured",
      "recorded",
      "possible",
      "generalizability",
      "generalisability",
    ],
    /(?:did|were|was)\s+not\s+(?:extract|collect|measure|record)|(?:not\s+possible|unable)\s+to\s+(?:tell|determine|establish)|(?:generalizability|generalisability)\s+(?:is|was|may)|未(?:收集|测量|记录)|无法确定/i,
    true,
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
  add(
    /随访|生存|删失|\bfollow[ -]?up\b|\bsurvival\b|\bcensor(?:ing|ed)?\b/i,
    ["follow-up", "followup", "survival", "censoring", "censored", "mortality"],
    /time\s+(?:to\s+event|from)|follow[ -]?up|date\s+of\s+censoring|随访|删失/i,
  );
  add(
    /(?=[\s\S]*(?:\bai\b|\bllms?\b|人工智能|语言模型|机器学习|深度学习))(?=[\s\S]*(?:治疗|临床|建议|生存|\btreatment\b|\brecommendations?\b|\bsurvival\b))/i,
    ["prospective", "retrospective", "implemented", "deployed", "accessed"],
    /no\s+patients?\s+(?:received|were\s+treated)[\s\S]{0,140}(?:\bai\b|\bllms?\b|model)|patients?\s+were\s+(?:randomly\s+)?(?:assigned|allocated)[\s\S]{0,140}(?:\bai\b|\bllms?\b|model)|(?:models?|llms?)\s+were\s+accessed/i,
  );
  add(
    /实际治疗|真实治疗|实际干预|(?:treatment|intervention)[\s\S]{0,60}(?:received|delivered|administered)/i,
    ["performed", "documented", "implemented", "administered"],
    /(?:therapies|treatment)[\s\S]{0,100}(?:actually\s+performed|documented\s+in)|actual\s+therapy\s+administered/i,
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
// A printed table DOI gives a verifiable end boundary. Preserve a compact,
// relevant table as one block; do not infer missing rows or span other tables.
function linkedTableSpans(
  text: string,
  quota: number,
  terms: string[],
  topics: Topic[],
): EvidenceRange[] {
  const headings = [
    ...text.matchAll(/(?:^|\n)[ \t]*(?:Table|表)\s*(\d+)\s*[.：:。]/gi),
  ];
  return headings.flatMap((heading, index) => {
    const start = heading.index! + (heading[0].startsWith("\n") ? 1 : 0);
    const limit = headings[index + 1]?.index ?? text.length;
    const titleEnd = text.indexOf("\n", start);
    const title = text
      .slice(start, titleEnd < 0 ? limit : titleEnd)
      .toLowerCase();
    if (
      !terms.some((term) => containsEvidenceTerm(title, term)) &&
      !topics.some((topic) => topic.anchor.test(title))
    )
      return [];
    const tail = text.slice(start, limit);
    const link = [
      ...tail.matchAll(
        /https?:\/\/(?:dx\.)?doi\.org\/[^\s]+\.t(\d+)(?=\s|$)/gi,
      ),
    ].find((match) => Number(match[1]) === Number(heading[1]));
    if (!link) return [];
    const end = start + link.index! + link[0].length;
    if (end - start > quota) return [];
    const rows = text.slice(
      titleEnd < 0 ? end : titleEnd + 1,
      start + link.index!,
    );
    if (rows.split(/\r?\n/).filter((line) => /\d/.test(line)).length < 2)
      return [];
    return [{ start, end }];
  });
}
export function evidenceExcerptRanges(
  text: string,
  quota: number,
  terms: string[],
  question: string,
): EvidenceRange[] {
  const topics = requestedTopics(question);
  const tables = linkedTableSpans(text, quota, terms, topics);
  const spans = naturalSpans(text)
    .flatMap((range) =>
      tables.reduce<EvidenceRange[]>(
        (fragments, table) =>
          fragments.flatMap((fragment) => {
            if (fragment.end <= table.start || fragment.start >= table.end)
              return [fragment];
            return [
              ...(fragment.start < table.start
                ? [{ start: fragment.start, end: table.start }]
                : []),
              ...(fragment.end > table.end
                ? [{ start: table.end, end: fragment.end }]
                : []),
            ];
          }),
        [range],
      ),
    )
    .concat(tables);
  const chunks = spans.map((range) => {
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
      topics: topics.map((t) =>
        t.requireAnchor && !t.anchor.test(part)
          ? 0
          : t.terms.reduce(
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
  const completeTables = chunks
    .filter((chunk) =>
      tables.some(
        (table) => table.start === chunk.start && table.end === chunk.end,
      ),
    )
    .sort((a, b) => b.score - a.score || a.start - b.start);
  for (const chunk of [...new Set([...completeTables, ...representatives])]) {
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
