import { randomUUID, createHash } from "node:crypto";
import type {
  TaskInput,
  TaskRun,
  PaperBundle,
  LearningUnit,
  NoviceFeedback,
  ReviewResult,
  DeckOutline,
  Source,
} from "../shared/types.ts";
import { profiles, exampleUnits, defaultDeck } from "../examples/bundle.ts";
import { teachingSchema, noviceSchema, reviewSchema } from "./schemas.ts";
import { loadSkills } from "./skills.ts";
import type { Provider } from "./provider.ts";
import { save } from "./storage.ts";

export function visibleInput(
  input: TaskInput,
  unit: LearningUnit,
  profile: (typeof profiles)[number],
  sources: Source[],
  oldFeedback?: NoviceFeedback,
) {
  return {
    profile,
    question: input.question,
    explanation: unit,
    visibleFigures: sources
      .filter((s) => s.figure)
      .map((s) => ({
        id: s.id,
        title: s.title,
        caption: s.caption || (s.page ? "未提供独立图注" : s.text),
      })),
    taughtConcepts: input.taughtConcepts,
    ...(oldFeedback ? { previousBreakpoints: oldFeedback.breakpoints } : {}),
  };
}
export function validateCitations(
  unit: LearningUnit,
  review: ReviewResult,
  sources: Source[],
  deck?: DeckOutline,
) {
  const ids = new Set(sources.map((s) => s.id));
  const used = [
    ...unit.sections.flatMap((s) => s.citations),
    ...review.checkedSources,
    ...review.issues.flatMap((s) => s.evidence),
    ...(deck?.slides.flatMap((s) => s.citations) || []),
    ...(deck?.slides.flatMap((s) => (s.imageSource ? [s.imageSource] : [])) ||
      []),
  ];
  if (used.some((id) => !ids.has(id)))
    throw new Error("输出引用了本任务未提供的来源，未保存为完成结果。");
  if (
    unit.sections.some(
      (s) => s.kind !== "interpretation" && s.citations.length === 0,
    )
  )
    throw new Error("事实或基础知识缺少可定位的引用。");
  if (deck?.slides.some((s) => s.citations.length === 0))
    throw new Error("汇报页缺少来源。");
}
export function cacheKey(
  input: TaskInput,
  paper: PaperBundle,
  versions: Record<string, string>,
  model: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        input,
        paperVersion: paper.version,
        sources: paper.sources,
        versions,
        profile: profiles.find((p) => p.id === input.profileId),
        model,
      }),
    )
    .digest("hex");
}
export function needsRevision(review: ReviewResult, feedback: NoviceFeedback) {
  return (
    review.issues.some((i) => !i.resolved && i.type !== "material") ||
    feedback.breakpoints.some((b) => b.status === "open")
  );
}
export function confirmedUnit(
  unit: LearningUnit,
  review: ReviewResult,
): LearningUnit {
  const blocking = review.issues.filter(
    (i) =>
      i.severity === "blocking" &&
      !i.resolved &&
      ["fact", "scope"].includes(i.type),
  );
  return {
    ...unit,
    sections: unit.sections.filter(
      (s) =>
        !blocking.some(
          (i) => i.location === s.title || s.text.includes(i.location),
        ),
    ),
  };
}
export class TaskManager {
  runs = new Map<string, TaskRun>();
  private controllers = new Map<string, AbortController>();
  active: string | undefined;
  starting = false;
  constructor(
    private provider: Provider,
    private persist: typeof save = save,
  ) {}
  async start(
    input: TaskInput,
    paper: PaperBundle,
    override?: { id: string; text: string; version: string },
    snapshot?: Awaited<ReturnType<typeof loadSkills>>,
  ) {
    if (this.active || this.starting)
      throw new Error("已有学习任务运行中，请先取消或等待完成。");
    this.starting = true;
    try {
      if (input.mode === "example" && input.paperId !== "xu-2018")
        throw new Error("上传论文需要实时模式，示例不会替代新论文的回答。");
      const profile = profiles.find((p) => p.id === input.profileId)!;
      const skills = snapshot || (await loadSkills(input.module, override));
      const selected = paper.sources.filter((s) =>
        input.sourceIds.includes(s.id),
      );
      const sources = selected.map(({ image, ...source }) => source);
      input = {
        ...input,
        visibleImage:
          input.visibleImage || selected.find((s) => s.image)?.image,
      };
      if (sources.length === 0)
        throw new Error("请先选择本任务的原文或基础资料。");
      const run: TaskRun = {
        id: randomUUID(),
        input,
        status: "queued",
        createdAt: new Date().toISOString(),
        calls: 0,
        model:
          input.mode === "live" ? this.provider.model : "固定示例 / 无模型调用",
        skillVersions: skills.versions,
        profileVersion: profile.version,
        sourceVersion: paper.version,
        events: [],
        roles: [],
      };
      const controller = new AbortController();
      this.runs.set(run.id, run);
      this.controllers.set(run.id, controller);
      this.active = run.id;
      try {
        await this.persist("runs", run.id, run);
      } catch (error) {
        this.runs.delete(run.id);
        this.controllers.delete(run.id);
        this.active = undefined;
        throw error;
      }
      void this.execute(run, paper, sources, skills, controller.signal).catch(
        () => {},
      );
      return run;
    } finally {
      this.starting = false;
    }
  }
  async cancel(id: string) {
    const run = this.runs.get(id);
    if (
      !run ||
      ["completed", "failed", "cancelled", "interrupted"].includes(run.status)
    )
      return;
    this.controllers.get(id)?.abort();
    run.status = "cancelled";
    run.endedAt = new Date().toISOString();
    await this.persist("runs", id, run);
  }
  private async execute(
    run: TaskRun,
    paper: PaperBundle,
    sources: Source[],
    skills: Awaited<ReturnType<typeof loadSkills>>,
    signal: AbortSignal,
  ) {
    const set = async (status: TaskRun["status"]) => {
      signal.throwIfAborted();
      run.status = status;
      run.events.push({ status, time: new Date().toISOString() });
      await this.persist("runs", run.id, run);
    };
    const call = async <T>(
      role: string,
      instructions: string,
      input: unknown,
      schema: import("zod").z.ZodType<T>,
    ): Promise<T> => {
      signal.throwIfAborted();
      if (run.calls >= 6) throw new Error("已达到六次生成上限。");
      run.calls++;
      const record = {
        role,
        inputKeys: Object.keys(input as object),
        input,
        durationMs: 0,
      } as TaskRun["roles"][number];
      run.roles.push(record);
      await this.persist("runs", run.id, run);
      const started = Date.now();
      const result = await this.provider.generate(
        instructions,
        input,
        schema,
        signal,
        run.input.visibleImage,
      );
      signal.throwIfAborted();
      record.durationMs = Date.now() - started;
      record.output = result.output;
      record.usage = result.usage;
      await this.persist("runs", run.id, run);
      return result.output;
    };
    try {
      const profile = profiles.find((p) => p.id === run.input.profileId)!;
      if (run.input.mode === "example") {
        // Fixed, verified content has no fabricated role execution or progress.
        const key =
          run.input.module === "method"
            ? /流式/.test(run.input.question)
              ? "flow"
              : "qpcr"
            : run.input.module === "ppt"
              ? "paper"
              : run.input.module;
        run.result = structuredClone(exampleUnits[key]);
        if (run.input.module === "ppt") run.deck = structuredClone(defaultDeck);
        run.review = {
          issues: [],
          checkedSources: run.result.sections.flatMap((s) => s.citations),
          limitations: [
            "固定教学示例；本次未运行教学、模拟新手或核对模型。",
            "论文局部证据包，不是全文核验。",
          ],
        };
        validateCitations(run.result, run.review, paper.sources, run.deck);
        await set("completed");
      } else {
        const teaching =
          skills.shared +
          "\n" +
          skills.modules
            .filter(
              (m) =>
                ![
                  "medical-novice-simulator",
                  "medical-grounding-check",
                ].includes(m.id),
            )
            .map((m) => m.text)
            .join("\n");
        const novice = skills.modules.find(
          (m) => m.id === "medical-novice-simulator",
        )!.text;
        const checking =
          skills.shared +
          "\n" +
          skills.modules.find((m) => m.id === "medical-grounding-check")!.text;
        const task = {
          question: run.input.question,
          module: run.input.module,
          sourceScope: sources.every((s) => s.kind === "foundation")
            ? "独立基础课程；未提供论文材料，不把通用方法写成本文具体做法。"
            : paper.scope,
          sources,
          taughtConcepts: run.input.taughtConcepts,
          previous: run.input.previous || null,
        };
        await set("teaching");
        let generated = await call("teaching", teaching, task, teachingSchema);
        run.draft = generated.unit;
        await set("novice");
        let feedback = await call(
          "novice",
          novice,
          visibleInput(run.input, generated.unit, profile, sources),
          noviceSchema,
        );
        await set("checking");
        let review = await call(
          "grounding",
          checking,
          { sources, draft: generated.unit, deck: generated.deck, feedback },
          reviewSchema,
        );
        validateCitations(
          generated.unit,
          review,
          sources,
          generated.deck || undefined,
        );
        if (needsRevision(review, feedback)) {
          await set("revising");
          generated = await call(
            "revision",
            teaching,
            {
              ...task,
              draft: generated.unit,
              deck: generated.deck,
              feedback,
              review,
              instruction: "只修订一次。逐项解决具体问题；不新增无来源数据。",
            },
            teachingSchema,
          );
          await set("rereading");
          feedback = await call(
            "novice-reread",
            novice,
            visibleInput(run.input, generated.unit, profile, sources, feedback),
            noviceSchema,
          );
          await set("rechecking");
          review = await call(
            "grounding-final",
            checking,
            { sources, draft: generated.unit, deck: generated.deck, feedback },
            reviewSchema,
          );
        }
        validateCitations(
          generated.unit,
          review,
          sources,
          generated.deck || undefined,
        );
        run.novice = feedback;
        run.review = review;
        // If a blocking issue cannot be mapped to a section, withhold the whole draft.
        if (
          review.issues.some(
            (i) =>
              i.severity === "blocking" &&
              !i.resolved &&
              ["fact", "scope"].includes(i.type),
          )
        ) {
          const confirmed = confirmedUnit(generated.unit, review);
          if (
            confirmed.sections.length === generated.unit.sections.length ||
            confirmed.sections.length === 0
          )
            throw new Error(
              "仍有实质事实争议，保留草稿与核对报告，不导出为已确认内容。",
            );
          run.result = confirmed;
        } else {
          run.result = generated.unit;
          if (generated.deck) run.deck = generated.deck;
        }
        await set("completed");
      }
    } catch (error) {
      if (signal.aborted) run.status = "cancelled";
      else {
        run.status = "failed";
        run.error = error instanceof Error ? error.message : "任务失败";
      }
    } finally {
      run.endedAt = new Date().toISOString();
      try {
        await this.persist("runs", run.id, run);
      } catch {
        run.status = "failed";
        run.error = "保存失败，请复制当前内容。";
      }
      this.controllers.delete(run.id);
      if (this.active === run.id) this.active = undefined;
    }
  }
}
