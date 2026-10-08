import { z } from "zod";
import { LiteratureService } from "./literature.ts";
import { digest } from "./materials.ts";
import { list, save } from "./storage.ts";
import type { Provider } from "./provider.ts";
import type { BudgetLedger } from "./budget.ts";
import type { PaperBundle, Source } from "../shared/types.ts";
import type { SourceRef } from "../shared/research-plan.ts";

interface ResearchRecord {
  id: string;
  paperId: string;
  version: string;
  sources: Source[];
  references?: { sourceId: string; reference: SourceRef }[];
  decisionAttemptId?: string;
}

export class TutorResearch {
  private records = new Map<string, ResearchRecord>();
  constructor(
    private literature: Pick<
      LiteratureService,
      "restore" | "search"
    > = new LiteratureService(),
    private persist: typeof save = save,
  ) {}
  async restore(loader: typeof list = list) {
    await this.literature.restore(loader);
    for (const r of await loader<ResearchRecord>("tutor-research"))
      this.records.set(r.id, structuredClone(r));
  }
  sources(paper: PaperBundle) {
    return structuredClone([
      ...new Map(
        [...this.records.values()]
          .filter((r) => r.paperId === paper.id && r.version === paper.version)
          .flatMap((r) => r.sources)
          .map((s) => [s.id, s]),
      ).values(),
    ]);
  }
  async supplement(
    paper: PaperBundle,
    question: string,
    provider: Provider,
    ledger: BudgetLedger,
    signal: AbortSignal,
  ) {
    const instructions =
      "你为医学论文导师判断是否需要补查背景或方法资料。当前原文足以回答时返回空query。需要时给一个精确的英文PubMed检索式，聚焦当前概念，不使用用户姓名或私人条件，不代替当前论文证据。仅返回JSON。";
    const decision = await ledger.call(
      provider,
      "background-search-plan",
      instructions,
      {
        question,
        paper: paper.title,
        available: paper.sources
          .filter((s) => !s.image)
          .slice(0, 8)
          .map((s) => ({ title: s.title, text: s.text.slice(0, 1100) })),
      },
      z.object({ query: z.string().max(400), reason: z.string().max(300) }),
      signal,
      {
        groupId: "background-search",
        sourceHash: digest(paper.sources),
        skillHash: digest(instructions),
      },
    );
    if (!decision.output.query.trim()) return [];
    signal.throwIfAborted();
    const report = await this.literature.search(
      decision.output.query,
      paper.version,
      signal,
      decision.output.reason,
    );
    signal.throwIfAborted();
    const selected = report.selected.slice(0, 3);
    const sources: Source[] = selected.map((s) => ({
      id: `web-${digest({ paper: paper.id, version: paper.version, reference: s }).slice(0, 22)}`,
      title: s.title,
      kind: "foundation",
      text: s.excerpt,
      locator: [
        s.locator,
        "联网补充，非当前论文原文",
        s.bibliography?.fetchedAt ?? report.startedAt,
        ...(s.bibliography?.doi ? [`DOI ${s.bibliography.doi}`] : []),
        ...(s.bibliography?.notices ?? []),
      ].join("；"),
      url: s.url,
      verified: false,
    }));
    const record: ResearchRecord = {
      id: report.id,
      paperId: paper.id,
      version: paper.version,
      sources,
      references: selected.map((reference, i) => ({
        sourceId: sources[i].id,
        reference: structuredClone(reference),
      })),
      decisionAttemptId: [...ledger.state.attempts]
        .reverse()
        .find((a) => a.role === "background-search-plan")?.id,
    };
    await this.persist("tutor-research", record.id, record);
    signal.throwIfAborted();
    this.records.set(record.id, record);
    return structuredClone(sources);
  }
}
