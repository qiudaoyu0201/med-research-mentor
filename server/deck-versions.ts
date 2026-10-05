import { TaskScheduler, taskKey } from "./scheduler.ts";
import { randomUUID } from "node:crypto";
import type {
  DeckVersion,
  PaperBundle,
  Slide,
  TaskRun,
} from "../shared/types.ts";
import { defaultDeck, sample } from "../examples/bundle.ts";
import { save, list } from "./storage.ts";
import { deckSchema, slideSchema, groundedReviewSchema } from "./schemas.ts";
import { z } from "zod";
import { materialSources, validateTeachingSurface } from "./orchestrator.ts";
import { withFoundationSources } from "./foundations.ts";
import { digest, materialPacket } from "./materials.ts";
import { loadSkills } from "./skills.ts";
import { BudgetLedger } from "./budget.ts";
import type { Provider } from "./provider.ts";
import { exportDeck } from "./export.ts";

export class DeckVersions {
  versions = new Map<string, DeckVersion>();
  readonly activeIds = new Set<string>();
  get active() {
    return this.activeIds.values().next().value;
  }
  private controllers = new Map<string, AbortController>();
  private completions = new Map<string, Promise<void>>();
  constructor(
    private provider: Provider,
    private paperById: (id: string) => Promise<PaperBundle>,
    private persist: typeof save = save,
    private exporter: typeof exportDeck = exportDeck,
    public scheduler = new TaskScheduler(),
  ) {}
  get busy() {
    return this.controllers.size > 0;
  }
  async restoreDisk() {
    for (const version of await list<DeckVersion>("deck-versions")) {
      if (["queued", "revising", "checking"].includes(version.status)) {
        version.status = "interrupted";
        version.error = "后台重启中断修改；旧版保留，未重发。";
        for (const attempt of version.budget?.attempts ?? [])
          if (attempt.status === "reserved") attempt.status = "unknown";
        await this.persist("deck-versions", version.id, version);
      }
      this.versions.set(version.id, version);
    }
  }
  get(id: string, conversationId?: string) {
    const version = this.versions.get(id);
    if (
      !version ||
      (conversationId && version.conversationId !== conversationId)
    )
      throw new Error("汇报版本不属于本会话。");
    return structuredClone(version);
  }
  private async sources(version: DeckVersion) {
    const paper = withFoundationSources(await this.paperById(version.paperId));
    const sources = paper.sources.filter((s) =>
      version.sourceIds.includes(s.id),
    );
    if (
      paper.version !== version.sourceVersion ||
      sources.length !== version.sourceIds.length ||
      digest(sources) !== version.sourceHash
    )
      throw new Error("汇报资料版本已变化，请重新核对。");
    return { ...paper, sources };
  }
  private async store(version: DeckVersion) {
    await this.persist("deck-versions", version.id, version);
    this.versions.set(version.id, structuredClone(version));
  }
  async seed(conversationId: string, paperId: string, run?: TaskRun) {
    const paper = withFoundationSources(await this.paperById(paperId));
    if (
      run &&
      (run.status !== "completed" ||
        !run.deck ||
        !run.result ||
        run.input.conversationId !== conversationId ||
        run.input.paperId !== paperId ||
        run.sourceVersion !== paper.version ||
        run.review?.issues.some(
          (i) => !i.resolved && i.severity === "blocking",
        ))
    )
      throw new Error("此会话没有可继续修改的有效汇报。");
    if (!run && paperId !== sample.id)
      throw new Error("请先生成此论文的汇报。");
    const outline = deckSchema.parse(run?.deck ?? defaultDeck);
    const materials = run ? materialSources(run, paper) : paper.sources;
    const ids = [
      ...new Set(
        outline.slides.flatMap((s) => [
          ...s.citations,
          ...(s.imageSource ? [s.imageSource] : []),
        ]),
      ),
    ];
    const sources = paper.sources.filter((s) => ids.includes(s.id));
    if (ids.some((id) => !materials.some((s) => s.id === id)))
      throw new Error("汇报来源不在已交付资料中。");
    const version: DeckVersion = {
      id: randomUUID(),
      conversationId,
      paperId,
      sourceVersion: paper.version,
      sourceIds: sources.map((s) => s.id),
      sourceHash: digest(sources),
      createdAt: new Date().toISOString(),
      runId: run?.id,
      origin: run?.input.mode === "live" ? "live" : "example",
      status: "completed",
      outline,
      review: structuredClone(
        run?.review ?? {
          issues: [],
          checkedSources: [],
          limitations: ["固定示例大纲，本次没有事实模型核对。"],
        },
      ),
      roles: [],
    };
    await this.store(version);
    return version;
  }
  async start(
    parentId: string,
    conversationId: string,
    input: { slideIndex: number; question: string; slide?: Slide },
    external?: { ledger: BudgetLedger; signal: AbortSignal },
  ) {
    const parent = this.get(parentId, conversationId);
    if (parent.status !== "completed")
      throw new Error("请选择已完成版本作为修改起点。");
    if (
      !Number.isInteger(input.slideIndex) ||
      !parent.outline.slides[input.slideIndex]
    )
      throw new Error("指定页不存在。");
    await this.sources(parent);
    const version: DeckVersion = {
      ...structuredClone(parent),
      id: randomUUID(),
      parentId,
      restoredFrom: undefined,
      slideIndex: input.slideIndex,
      request: input.question,
      createdAt: new Date().toISOString(),
      status: "queued",
      roles: [],
      budget: undefined,
      error: undefined,
    };
    const ledger =
      external?.ledger ??
      new BudgetLedger(version.id, () => this.store(version));
    if (!external) ledger.state.limit = 4;
    version.budget = ledger.state;
    if (input.slide)
      version.outline.slides[input.slideIndex] = slideSchema.parse(input.slide);
    await this.store(version);
    const controller = new AbortController();
    this.controllers.set(version.id, controller);

    const signal = external
      ? AbortSignal.any([external.signal, controller.signal])
      : controller.signal;
    const execute = async () => {
      this.activeIds.add(version.id);
      if (!external)
        ledger.state.deadline = new Date(Date.now() + 480_000).toISOString();
      await this.execute(
        version,
        parent,
        await this.sources(parent),
        input,
        ledger,
        signal,
      );
    };
    const completion = (
      external
        ? execute()
        : this.scheduler.run(
            taskKey(parent.paperId, conversationId),
            signal,
            execute,
          )
    )
      .catch(async (error) => {
        version.status = signal.aborted ? "cancelled" : "failed";
        version.error = signal.aborted ? undefined : String(error);
        await this.store(version);
      })
      .finally(() => {
        this.activeIds.delete(version.id);
        this.controllers.delete(version.id);
      });
    this.completions.set(version.id, completion);
    void completion.catch(() => {});
    return version;
  }

  async wait(id: string) {
    await this.completions.get(id);
    return this.get(id);
  }
  async cancel(id: string) {
    this.controllers.get(id)?.abort();
    await this.wait(id);
  }
  private async execute(
    version: DeckVersion,
    parent: DeckVersion,
    paper: PaperBundle,
    input: { slideIndex: number; question: string; slide?: Slide },
    ledger: BudgetLedger,
    signal: AbortSignal,
  ) {
    try {
      const skills = await loadSkills("ppt", undefined, {
        readability: false,
        grounding: true,
      });
      const guide =
        skills.shared +
        "\n" +
        skills.modules
          .filter((m) => m.id !== "medical-grounding-check")
          .map((m) => m.text)
          .join("\n");
      const check =
        skills.shared +
        "\n" +
        skills.modules.find((m) => m.id === "medical-grounding-check")!.text;
      const original = parent.outline.slides[input.slideIndex];
      const localIds = new Set([
        ...original.citations,
        ...(original.imageSource ? [original.imageSource] : []),
        ...(input.slide?.citations ?? []),
        ...(input.slide?.imageSource ? [input.slide.imageSource] : []),
      ]);
      const sources = paper.sources.filter((s) => localIds.has(s.id));
      const packet = materialPacket(sources);
      const schema = slideSchema.extend({
        citations: z.array(z.enum(sources.map((s) => s.id))).max(20),
        imageSource: z
          .enum(["", ...sources.filter((s) => s.image).map((s) => s.id)])
          .optional(),
      });
      const call = async <T>(
        role: string,
        instructions: string,
        data: unknown,
        outputSchema: import("zod").z.ZodType<T>,
      ) => {
        const record: DeckVersion["roles"][number] = {
          role,
          instructions,
          input: data,
        };
        version.roles.push(record);
        try {
          const result = await ledger.call(
            this.provider,
            role,
            instructions,
            data,
            outputSchema,
            signal,
            {
              groupId: version.id,
              sourceHash: digest(sources),
              skillHash: digest(skills.versions),
              image: sources.find((s) => s.image)?.image,
              onReserved: async () => this.store(version),
            },
          );
          record.output = result.output;
          await this.store(version);
          return result.output;
        } catch (error) {
          record.error = String(error);
          await this.store(version);
          throw error;
        }
      };
      const validate = (slide: Slide) => {
        deckSchema.parse({ slides: [slide] });
        if (
          !slide.citations.length ||
          slide.citations.some((id) => !sources.some((s) => s.id === id)) ||
          (slide.imageSource &&
            !sources.some((s) => s.id === slide.imageSource && s.image))
        )
          throw new Error("修改页缺少有效来源或原图。");
        if (original.imageSource && slide.imageSource !== original.imageSource)
          throw new Error("单页修改需要保留原图绑定。");
        validateTeachingSurface(
          {
            title: "单页修改",
            question: input.question,
            sections: [],
            terms: [],
            nextQuestion: "",
          },
          { slides: [slide] },
          version.review.issues.map((i) => i.id),
          sources,
        );
      };
      version.status = "revising";
      await this.store(version);
      let slide =
        input.slide ??
        (await call(
          "slide-edit",
          guide +
            "\n只修改指定一页，输出 Slide JSON，不输出整套汇报；保留原图和来源。",
          {
            question: input.question,
            page: input.slideIndex + 1,
            original,
            sources: packet,
          },
          schema,
        ));
      validate(slide);
      version.outline.slides[input.slideIndex] = slide;
      version.status = "checking";
      await this.store(version);
      let review = await call(
        "slide-grounding",
        check,
        {
          question: input.question,
          page: input.slideIndex + 1,
          deck: { slides: [slide] },
          sources: packet,
        },
        groundedReviewSchema(sources),
      );
      if (review.issues.some((i) => !i.resolved && i.severity === "blocking")) {
        await ledger.revise(version.id);
        version.status = "revising";
        version.review = review;
        await this.store(version);
        slide = await call(
          "slide-revision",
          guide +
            "\n只修订这一页，根据具体核对问题补足；缺事实材料保留未知，不编造。输出 Slide JSON，保留原图。",
          {
            question: input.question,
            original,
            draft: slide,
            review,
            sources: packet,
          },
          schema,
        );
        validate(slide);
        version.outline.slides[input.slideIndex] = slide;
        version.status = "checking";
        await this.store(version);
        review = await call(
          "slide-grounding-final",
          check,
          {
            question: input.question,
            page: input.slideIndex + 1,
            deck: { slides: [slide] },
            previousIssues: review.issues,
            sources: packet,
          },
          groundedReviewSchema(sources),
        );
      }
      signal.throwIfAborted();
      version.review = {
        issues: [...parent.review.issues, ...review.issues],
        checkedSources: [
          ...new Set([
            ...parent.review.checkedSources,
            ...review.checkedSources,
          ]),
        ],
        limitations: [
          ...new Set([...parent.review.limitations, ...review.limitations]),
        ],
      };
      if (
        version.review.issues.some(
          (i) => !i.resolved && i.severity === "blocking",
        )
      )
        throw new Error(
          "修改页仍有事实或材料问题，旧版本保留，当前草稿不能导出。",
        );
      for (let i = 0; i < parent.outline.slides.length; i++)
        if (
          i !== input.slideIndex &&
          digest(version.outline.slides[i]) !== digest(parent.outline.slides[i])
        )
          throw new Error("修改越过指定页。");
      version.status = "completed";
    } catch (error) {
      version.status = signal.aborted ? "cancelled" : "failed";
      version.error = String(error);
    } finally {
      try {
        await this.store(version);
      } finally {
        this.activeIds.delete(version.id);
        this.controllers.delete(version.id);
      }
    }
  }
  async restoreVersion(
    currentId: string,
    targetId: string,
    conversationId: string,
  ) {
    if (this.busy) throw new Error("请先停止或等待修改完成。");
    const current = this.get(currentId, conversationId),
      target = this.get(targetId, conversationId);
    await this.sources(target);
    if (
      target.status !== "completed" ||
      current.paperId !== target.paperId ||
      current.sourceVersion !== target.sourceVersion ||
      current.sourceHash !== target.sourceHash
    )
      throw new Error("不能恢复未完成或其他资料版本。");
    const version: DeckVersion = {
      ...target,
      id: randomUUID(),
      parentId: current.id,
      restoredFrom: target.id,
      createdAt: new Date().toISOString(),
      roles: [],
      budget: undefined,
      slideIndex: undefined,
      request: "恢复旧版本",
    };
    await this.store(version);
    return version;
  }
  async export(id: string, conversationId: string) {
    const version = this.get(id, conversationId);
    if (
      version.status !== "completed" ||
      version.review.issues.some(
        (i) => !i.resolved && i.severity === "blocking",
      )
    )
      throw new Error("此版本尚未完成核对，不能导出。");
    const paper = await this.sources(version),
      artifactId = randomUUID();
    await this.exporter(version.outline, paper, artifactId);
    return { id: artifactId, url: `/api/decks/${artifactId}`, versionId: id };
  }
}
