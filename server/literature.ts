import type { SourceRef } from "../shared/research-plan.ts";
import { randomUUID } from "node:crypto";
import type { LiteratureSearch } from "../shared/literature.ts";
import { digest } from "./materials.ts";
import { list, save } from "./storage.ts";

const hosts = new Set(["eutils.ncbi.nlm.nih.gov", "api.crossref.org"]);
const decode = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) => {
      const cp =
        n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const tag = (s: string, name: string) =>
  decode(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`).exec(s)?.[1] ??
      "",
  );
export function pubmedSources(xml: string, at: string): SourceRef[] {
  return [
    ...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g),
  ].flatMap(([, article]) => {
    const pmid = tag(article, "PMID"),
      title = tag(article, "ArticleTitle");
    if (!/^\d+$/.test(pmid) || !title) return [];
    const abstract = [
      ...article.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g),
    ]
      .map(([, attr, body]) =>
        `${/Label="([^"]+)"/.exec(attr)?.[1] ?? ""} ${decode(body)}`.trim(),
      )
      .join("\n");
    const doi = decode(
      /<ArticleId\s+IdType="doi">([\s\S]*?)<\/ArticleId>/.exec(article)?.[1] ??
        "",
    );
    const year =
      tag(tagRaw(article, "PubDate"), "Year") ||
      /\b(?:19|20)\d{2}\b/.exec(tag(article, "MedlineDate"))?.[0] ||
      "年份未提供";
    const authors = [
      ...article.matchAll(/<Author(?:\s[^>]*)?>([\s\S]*?)<\/Author>/g),
    ]
      .map(
        ([, a]) =>
          tag(a, "CollectiveName") ||
          `${tag(a, "LastName")} ${tag(a, "Initials")}`.trim(),
      )
      .filter(Boolean);
    const notices = [
      ...article.matchAll(
        /<CommentsCorrections\s+RefType="([^"]+)"[\s\S]*?<\/CommentsCorrections>/g,
      ),
    ].map(
      ([body, type]) =>
        `${type}: ${tag(body, "RefSource")} PMID ${tag(body, "PMID")}`,
    );
    if (/Retracted Publication|Retraction of Publication/.test(article))
      notices.push("PubMed 标记撤稿，不能作为设计依据");
    const excerpt = [
      title,
      abstract || "仅有书目信息，无摘要可支持科学主张。",
    ].join("\n");
    return [
      {
        id: `pmid-${pmid}`,
        sourceType: "pubmed" as const,
        kind: "paper" as const,
        title,
        locator: `PubMed PMID ${pmid} · ${abstract ? "摘要" : "元数据"}`,
        excerpt,
        hash: digest(excerpt),
        verified: false,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        bibliography: {
          pmid,
          ...(doi && /^10\.\d{4,9}\/\S+$/i.test(doi) ? { doi } : {}),
          authors,
          year,
          journal: tag(tagRaw(article, "Journal"), "Title"),
          level: abstract ? ("abstract" as const) : ("metadata" as const),
          fetchedAt: at,
          crossref: doi ? ("unavailable" as const) : ("no-doi" as const),
          notices,
        },
      },
    ];
  });
}
function tagRaw(s: string, name: string) {
  return (
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`).exec(s)?.[1] ??
    ""
  );
}
export class LiteratureSearchFailure extends Error {
  constructor(public report: LiteratureSearch) {
    super(report.error || "文献检索未完成，未生成方案。");
  }
}
export class LiteratureService {
  private cache = new Map<string, LiteratureSearch>();
  private requests: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;
  constructor(
    private transport: typeof fetch = fetch,
    private persist: typeof save = save,
  ) {}
  async restore(loader: typeof list = list) {
    for (const r of await loader<LiteratureSearch>("literature-searches"))
      if (["completed", "empty"].includes(r.status)) {
        const key = r.cacheKey ?? r.id;
        const previous = this.cache.get(key);
        if (!previous || r.startedAt > previous.startedAt)
          this.cache.set(key, r);
      }
  }
  private request(
    url: URL,
    report: LiteratureSearch,
    signal: AbortSignal,
  ): Promise<string> {
    if (
      url.protocol !== "https:" ||
      !hosts.has(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error("文献接口地址不在允许范围。");
    const work = this.requests
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        const wait = Math.max(0, 400 - (Date.now() - this.lastRequest));
        if (wait)
          await new Promise<void>((resolve) => setTimeout(resolve, wait));
        signal.throwIfAborted();
        this.lastRequest = Date.now();
        const entry: LiteratureSearch["requests"][number] = {
          url: url.href,
          status: null,
          at: new Date().toISOString(),
        };
        report.requests.push(entry);
        try {
          const boundedSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(12_000),
          ]);
          const response = await this.transport(url, {
            signal: boundedSignal,
            redirect: "error",
            headers: {
              "User-Agent":
                "MedicalResearchTutor/1.6 (local research workspace)",
              Accept: "application/json, application/xml, text/xml",
            },
          });
          entry.status = response.status;
          if (!response.ok)
            throw new Error(`文献接口 HTTP ${response.status}，未自动重试`);
          if (!response.body) throw new Error("文献接口没有返回正文");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 2_000_000) throw new Error("文献接口返回超过 2 MB");
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          return Buffer.concat(chunks).toString("utf8");
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      });
    this.requests = work;
    return work;
  }
  async search(
    query: string,
    topicVersion: string,
    signal: AbortSignal,
    queryReason = "用户课题检索式",
    progress?: (report: LiteratureSearch) => Promise<void>,
  ) {
    if (!query.trim() || query.length > 800 || !/[a-z]/i.test(query))
      throw new Error("请提供医学英文关键词或 PubMed 检索式。");
    const cacheKey = digest({
      contract: "pubmed-evidence-v1",
      query,
      topicVersion,
    });
    const cached = this.cache.get(cacheKey);
    if (
      cached &&
      ["completed", "empty"].includes(cached.status) &&
      Date.now() - Date.parse(cached.startedAt) < 86_400_000 &&
      cached.selected.every(
        (s) => Date.now() - Date.parse(s.bibliography!.fetchedAt) < 86_400_000,
      )
    ) {
      signal.throwIfAborted();
      const reused = {
        ...structuredClone(cached),
        id: randomUUID(),
        cacheKey,
        cacheHit: true,
        cachedFrom: cached.id,
        requests: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      await this.persist("literature-searches", reused.id, reused);
      await progress?.(structuredClone(reused));
      return reused;
    }
    const id = randomUUID();
    const report: LiteratureSearch = {
      id,
      cacheKey,
      cacheHit: false,
      excluded: [],
      topicVersion,
      query,
      queryReason,
      startedAt: new Date().toISOString(),
      status: "failed",
      requests: [],
      candidatePmids: [],
      selected: [],
      selectionReason:
        "PubMed 相关性排序前 25 条候选，读取前 10 条；排除撤稿，按 PMID／DOI 去重。排序不等于逐篇全文适用性评审。",
      limitations: [
        "读取层级为摘要／元数据；未读取全文，不据摘要补造操作参数，创新性与关键方法仍需原文核实。",
      ],
    };
    try {
      await progress?.(structuredClone(report));
      const url = new URL(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
      );
      url.search = new URLSearchParams({
        db: "pubmed",
        term: query,
        retmode: "json",
        retmax: "25",
        sort: "relevance",
        tool: "medical-research-tutor",
      }).toString();
      const result = JSON.parse(await this.request(url, report, signal));
      if (result.error || result.esearchresult?.errorlist)
        throw new Error("PubMed 检索式未被接受，请修改检索式后重试。");
      if (!Array.isArray(result.esearchresult?.idlist))
        throw new Error("PubMed 返回结构不正确。");
      report.candidatePmids = result.esearchresult.idlist
        .filter((id: unknown) => typeof id === "string" && /^\d+$/.test(id))
        .slice(0, 25);
      if (report.candidatePmids.length) {
        const articleURL = new URL(
          "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
        );
        articleURL.search = new URLSearchParams({
          db: "pubmed",
          id: report.candidatePmids.slice(0, 10).join(","),
          retmode: "xml",
          tool: "medical-research-tutor",
        }).toString();
        const sources = pubmedSources(
          await this.request(articleURL, report, signal),
          new Date().toISOString(),
        );
        if (!sources.length)
          throw new Error("PubMed 返回候选但没有可解析记录，不能当作零结果。");
        const seen = new Set<string>();
        report.excluded = sources.filter((s) =>
          s.bibliography!.notices.some((n) => /retract|撤稿/i.test(n)),
        );
        report.selected = sources.filter((s) => {
          const key = s.bibliography?.doi?.toLowerCase() || s.id;
          if (
            seen.has(key) ||
            s.bibliography!.notices.some((n) => /retract|撤稿/i.test(n))
          )
            return false;
          seen.add(key);
          return true;
        });
        for (const source of report.selected.slice(0, 6)) {
          signal.throwIfAborted();
          const b = source.bibliography!;
          if (!b.doi) continue;
          try {
            const cr = JSON.parse(
              await this.request(
                new URL(
                  `https://api.crossref.org/works/${encodeURIComponent(b.doi)}`,
                ),
                report,
                signal,
              ),
            ).message;
            const normalized = (s: string) =>
              s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
            b.crossref =
              typeof cr?.DOI === "string" &&
              cr.DOI.toLowerCase() === b.doi.toLowerCase() &&
              Array.isArray(cr.title) &&
              normalized(cr.title[0] ?? "") === normalized(source.title)
                ? "matched"
                : "mismatch";
            if (b.crossref === "mismatch")
              b.notices.push("Crossref DOI／题名交叉核验不一致，引用待核");
            for (const update of cr?.["update-to"] ?? [])
              b.notices.push(
                `Crossref 更新：${update.type ?? "unknown"} ${update.DOI ?? ""}`,
              );
          } catch (error) {
            signal.throwIfAborted();
            b.crossref = "unavailable";
            report.limitations.push(
              `PMID ${b.pmid} 的 Crossref 核验不可用；仅保留 PubMed 记录。`,
            );
          }
        }
        report.excluded!.push(
          ...report.selected.filter((s) =>
            s.bibliography!.notices.some((n) => /retract|撤稿/i.test(n)),
          ),
        );
        report.selected = report.selected.filter(
          (s) => !s.bibliography!.notices.some((n) => /retract|撤稿/i.test(n)),
        );
      }
      signal.throwIfAborted();
      report.status = report.selected.length ? "completed" : "empty";
      if (!report.selected.length)
        report.limitations.push(
          "本轮无可用依据；请调整关键词或补充已知文献，不宣称课题没有研究。",
        );
    } catch (error) {
      report.status = signal.aborted ? "cancelled" : "failed";
      report.error = error instanceof Error ? error.message : String(error);
    }
    report.completedAt = new Date().toISOString();
    await this.persist("literature-searches", report.id, report);
    await progress?.(structuredClone(report));
    if (["completed", "empty"].includes(report.status))
      this.cache.set(cacheKey, structuredClone(report));
    if (["failed", "cancelled"].includes(report.status))
      throw new LiteratureSearchFailure(report);
    return report;
  }
}
