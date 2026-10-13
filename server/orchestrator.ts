import { figureFamiliarity } from "./figure-familiarity.ts";
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
import { pptImagePacket } from "./ppt-image-packet.ts";
import {
  teachingSchema,
  noviceSchema,
  reviewSchema,
  groundedTeachingSchema,
  groundedReviewSchema,
  groundingContractVersion,
  unitSchema,
} from "./schemas.ts";
import { loadSkills, assistantRules } from "./skills.ts";
import { z } from "zod";
import type { Provider } from "./provider.ts";
import { save } from "./storage.ts";
import { BudgetLedger } from "./budget.ts";
import { taskTiming } from "./task-timing.ts";
import { materialPacket, digest, selectionVersion } from "./materials.ts";
import { foundationCatalog } from "./foundations.ts";
import type { ResultCache } from "./cache.ts";
import { legacyPreferences } from "../shared/learning-intent.ts";
import {
  explanationTrace,
  revisionTrace,
  revisionAuditInstruction,
  revisionAuditInput,
} from "./revision-trace.ts";
import {
  tracingSchema,
  validateExplanationLinks,
} from "./explanation-links.ts";

export function visibleInput(
  input: TaskInput,
  unit: LearningUnit,
  profile: (typeof profiles)[number],
  sources: Source[],
  oldFeedback?: NoviceFeedback,
  deck?: DeckOutline | null,
) {
  return {
    profile,
    question: input.question,
    learningIntent: input.learningIntent ?? null,
    explanation: unit,
    visibleFigures: sources
      .filter((s) => s.figure)
      .map((s) => ({
        id: s.id,
        title: s.title,
        caption: s.caption || (s.page ? "未提供独立图注" : s.text),
      })),
    taughtConcepts: input.taughtConcepts,
    ...(deck ? { presentation: deck } : {}),
    ...(oldFeedback ? { previousBreakpoints: oldFeedback.breakpoints } : {}),
  };
}
export function validateCitations(
  unit: LearningUnit,
  review: ReviewResult,
  sources: Source[],
  deck?: DeckOutline,
  deliveryPolicy: "internal" | "online" = "internal",
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
      (s) =>
        ["paper", "foundation"].includes(s.kind) && s.citations.length === 0,
    )
  )
    throw new Error("事实或基础知识缺少可定位的引用。");
  const transparentGapSlide = (slide: DeckOutline["slides"][number]) =>
    deliveryPolicy === "online" &&
    slide.citations.length === 0 &&
    /(尚缺|缺失|未提供|缺少|补齐|材料)/.test(
      `${slide.title} ${slide.bullets.join(" ")} ${slide.notes}`,
    );
  if (
    deck?.slides.some(
      (s) => s.citations.length === 0 && !transparentGapSlide(s),
    )
  )
    throw new Error("汇报页缺少来源。");
  for (const section of unit.sections) {
    if (
      ["paper", "foundation"].includes(section.kind) &&
      !section.citations.some((id) => {
        const kind = sources.find((s) => s.id === id)?.kind;
        return (
          kind === section.kind ||
          (deliveryPolicy === "online" &&
            section.kind === "foundation" &&
            kind === "paper")
        );
      })
    )
      throw new Error("论文事实与通用基础的引用类型不匹配。");
  }
  if (
    sources.some((s) => s.kind === "paper" && s.paperId) &&
    new Set(sources.filter((s) => s.kind === "paper").map((s) => s.paperId))
      .size > 1
  )
    throw new Error("单论文任务混入了其他论文证据。");
}
export function validateTeachingSurface(
  unit: LearningUnit,
  deck: DeckOutline | undefined,
  internalIds: string[],
  sources: Source[],
) {
  const visible = [
    unit.title,
    unit.nextQuestion,
    ...unit.sections.flatMap((s) => [s.title, s.text]),
    ...unit.terms.flatMap((t) => [t.name, t.explanation]),
    ...(deck?.slides.flatMap((s) => [s.title, ...s.bullets, s.notes]) ?? []),
    deck?.speechScript ?? "",
  ].join("\n");
  for (const id of new Set(internalIds)) {
    if (
      id.length < 2 ||
      sources.some((s) =>
        [
          s.id,
          s.title,
          s.text,
          s.caption ?? "",
          ...(s.foundation?.aliases ?? []),
        ]
          .join("\n")
          .toLowerCase()
          .includes(id.toLowerCase()),
      )
    )
      continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "i").test(
        visible,
      )
    )
      throw new Error("讲解或讲稿包含内部问题编号，未保存为完成结果。");
  }
}
export function validateRunSurface(
  run: TaskRun,
  unit: LearningUnit,
  deck: DeckOutline | undefined,
  sources: Source[],
) {
  const ids = run.roles.flatMap((role) => {
    const output = role.output as
      { breakpoints?: { id: string }[]; issues?: { id: string }[] } | undefined;
    return [...(output?.breakpoints ?? []), ...(output?.issues ?? [])].map(
      (item) => item.id,
    );
  });
  validateTeachingSurface(
    unit,
    deck,
    [
      ...ids,
      ...(run.novice?.breakpoints ?? []).map((b) => b.id),
      ...(run.review?.issues ?? []).map((i) => i.id),
      ...(run.materialRequests ?? []).map((r) => r.id),
    ],
    sources,
  );
}
export function materialSources(run: TaskRun, paper: PaperBundle) {
  const snapshot = run.materials?.at(-1);
  if (!snapshot) return paper.sources; // Backward-compatible historical records.
  if (run.sourceVersion !== paper.version || run.input.paperId !== paper.id)
    throw new Error("任务与当前论文来源版本不一致。");
  return snapshot.sources.map((source) => {
    const current =
      source.kind === "foundation"
        ? (paper.sources.find((s) => s.id === source.id) ??
          foundationCatalog.all().find((s) => s.id === source.id))
        : paper.sources.find((s) => s.id === source.id);
    if (!current) throw new Error("最终资料来源已移除。");
    const { image, ...text } = current;
    const expected = { ...source };
    delete expected.image;
    if (digest(text) !== digest(expected))
      throw new Error("最终资料已发生变化，请重新核对后导出。");
    return { ...source, ...(image ? { image } : {}) };
  });
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
        input: {
          ...input,
          question: input.question.trim().replace(/\s+/g, " "),
          conversationId: undefined,
          turnId: undefined,
          groupId: undefined,
        },
        schemaVersion: digest(
          [teachingSchema, noviceSchema, reviewSchema].map((schema) =>
            z.toJSONSchema(schema),
          ),
        ),
        paperVersion: paper.version,
        sources: paper.sources,
        selector: selectionVersion,
        foundations: foundationCatalog.version,
        groundingContract: groundingContractVersion,
        versions,
        profile: profiles.find((p) => p.id === input.profileId),
        model,
      }),
    )
    .digest("hex");
}
export function needsRevision(
  review: ReviewResult,
  feedback: NoviceFeedback,
  policy: "internal" | "online" = "internal",
) {
  if (policy === "online") {
    return (
      Boolean(onlineDeliveryProblem(review)) ||
      feedback.breakpoints.some((b) => b.status === "open")
    );
  }
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
  readonly activeIds = new Set<string>();
  get active() {
    return this.activeIds.values().next().value;
  }
  starting = false;
  private completions = new Map<string, Promise<void>>();
  private resultKeys = new Map<string, string>();
  async publishCache(id: string, cache: ResultCache) {
    const run = this.runs.get(id),
      key = this.resultKeys.get(id);
    if (run && key && !run.cacheHit && (run.materials?.length ?? 1) === 1)
      await cache.put(key, run);
  }
  wait(id: string) {
    return this.completions.get(id) ?? Promise.resolve();
  }
  constructor(
    private provider: Provider,
    private persist: typeof save = save,
    private deliveryPolicy: "internal" | "online" = "internal",
  ) {}
  async start(
    input: TaskInput,
    paper: PaperBundle,
    override?: { id: string; text: string; version: string },
    snapshot?: Awaited<ReturnType<typeof loadSkills>>,
    execution?: {
      ledger?: BudgetLedger;
      signal?: AbortSignal;
      id?: string;
      cache?: ResultCache;
    },
  ) {
    if (!execution?.ledger && (this.active || this.starting))
      throw new Error("已有学习任务运行中，请先取消或等待完成。");
    this.starting = true;
    try {
      input = {
        ...input,
        learningIntent: input.learningIntent ?? {
          ...legacyPreferences(input.depth),
          version: "1",
          goal: (input.modules ?? [input.module]).includes("ppt")
            ? "report"
            : "understand",
          scope: {
            paperId: paper.id,
            sourceVersion: paper.version,
            sourceIds: input.sourceIds,
            selection: input.focusedText ?? null,
            artifactVersion: null,
          },
          backgroundRef: input.profileId,
          preferenceScope: "turn",
        },
      };
      if (input.mode === "example" && input.paperId !== "xu-2018")
        throw new Error("上传论文需要实时模式，示例不会替代新论文的回答。");
      const profile = profiles.find((p) => p.id === input.profileId);
      if (!profile) throw new Error("新手画像不存在");
      const skills =
        snapshot ||
        (await loadSkills(input.modules ?? input.module, override, {
          readability:
            input.workflow !== "direct" && (input.checks?.readability ?? true),
          grounding: input.workflow !== "direct",
        }));
      skills.versions["delivery-policy"] =
        this.deliveryPolicy +
        (this.deliveryPolicy === "online" ? "-v3" : "-v1");
      skills.versions["visual-evidence-protocol"] = "endpoint-audit-v1";
      if (input.workflow === "direct")
        skills.versions["medical-research-assistant"] = (
          await assistantRules()
        ).version;
      if (input.sourceIds.some((id) => !paper.sources.some((s) => s.id === id)))
        throw new Error("所选来源不存在");
      const selected = paper.sources.filter((s) =>
        input.sourceIds.includes(s.id),
      );
      const sources = selected.map(({ image, ...source }) => source);
      input = {
        ...input,
        visibleImage:
          input.visibleImage ||
          ((input.modules ?? [input.module]).includes("ppt")
            ? await pptImagePacket(selected)
            : selected.find((s) => s.image)?.image),
      };
      if (sources.length === 0 && input.workflow !== "direct")
        throw new Error("请先选择本任务的原文或基础资料。");
      if (
        input.workflow === "direct" &&
        (input.module === "ppt" || sources.some((s) => s.kind === "paper"))
      )
        throw new Error("论文事实与汇报必须走来源核对流程。");
      if (input.mode === "live") materialPacket(sources, input.question);
      const run: TaskRun = {
        id: execution?.id ?? randomUUID(),
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
        materials: [
          {
            hash: digest({ sources, image: input.visibleImage }),
            phase: "initial",
            sources: structuredClone(sources),
            addedIds: [],
          },
        ],
        materialRequests: (input.missingFoundations ?? []).map((s) => ({
          id: `material-${s.id}`,
          concept: s.title,
          question: `请提供 ${s.title} 的必要基础，当前材料额度未能容纳。`,
          reason: "基础条目存在，但超过当前资料额度。",
          kind: "foundation",
          paperId: paper.id,
          sourceVersion: paper.version,
          matchedIds: [s.id],
          status: "pending",
        })),
      };
      const controller = new AbortController();
      const signal = execution?.signal
        ? AbortSignal.any([controller.signal, execution.signal])
        : controller.signal;
      const ledger =
        execution?.ledger ??
        new BudgetLedger(run.input.turnId ?? run.id, () =>
          this.persist("runs", run.id, run),
        );
      run.budget = ledger.state;
      if (input.diagnosticScope && !execution?.ledger)
        ledger.state.limit = ledger.state.groupLimit = 4;
      if (!execution?.ledger) {
        ledger.state.timing = taskTiming(
          input.diagnosticScope
            ? "fragment"
            : (input.modules ?? [input.module]).includes("ppt")
              ? "full"
              : "explanation",
          input.slideCount ?? 6,
          this.deliveryPolicy,
        );
        ledger.state.deadline = new Date(
          Date.now() + ledger.state.timing.taskMs,
        ).toISOString();
      }
      const resultKey = cacheKey(
        input,
        { ...paper, sources: selected },
        {
          ...skills.versions,
          ...(execution?.cache
            ? { assistant: (await assistantRules()).version }
            : {}),
          providerSettings: digest(this.provider.settings ?? {}),
          providerIdentity: this.provider.id ?? this.provider.model,
        },
        this.provider.model,
      );
      if (input.mode === "live" && execution?.cache) {
        const cached = await execution.cache.get(resultKey);
        if (cached) {
          run.cacheHit = cached.id;
          run.result = structuredClone(cached.result);
          if ((input.modules ?? [input.module]).includes("ppt"))
            run.deck = structuredClone(cached.deck);
          run.novice = structuredClone(cached.novice);
          run.review = structuredClone(cached.review);
          run.materialRequests = structuredClone(cached.materialRequests ?? []);
        }
      }
      this.runs.set(run.id, run);
      this.controllers.set(run.id, controller);
      this.activeIds.add(run.id);
      try {
        await this.persist("runs", run.id, run);
      } catch (error) {
        this.runs.delete(run.id);
        this.controllers.delete(run.id);
        this.activeIds.delete(run.id);
        throw error;
      }
      this.resultKeys.set(run.id, resultKey);
      const completion = this.execute(
        run,
        paper,
        sources,
        skills,
        signal,
        ledger,
      );
      this.completions.set(run.id, completion);
      void completion.catch(() => {});
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
    ledger: BudgetLedger,
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
      let record = {
        role,
        inputKeys: Object.keys(input as object),
        input: structuredClone(input),
        durationMs: 0,
      } as TaskRun["roles"][number];
      const started = Date.now();
      try {
        const result = await ledger.call(
          this.provider,
          role,
          instructions,
          input,
          schema,
          signal,
          {
            recoverTransport: this.deliveryPolicy === "online",
            groupId: run.input.groupId ?? run.id,
            image: run.input.visibleImage,
            sourceHash: digest({ sources, image: run.input.visibleImage }),
            skillHash: digest(skills.versions),
            onReserved: async (attempt) => {
              if (record.attemptId) {
                record.durationMs =
                  ledger.state.attempts.find((a) => a.id === record.attemptId)
                    ?.durationMs ?? 0;
                record = {
                  role,
                  inputKeys: Object.keys(input as object),
                  input: structuredClone(input),
                  durationMs: 0,
                };
              }
              record.attemptId = attempt.id;
              run.calls++;
              run.roles.push(record);
              await this.persist("runs", run.id, run);
            },
          },
        );
        signal.throwIfAborted();
        record.output = result.output;
        record.usage = result.usage;
        return result.output;
      } finally {
        record.durationMs =
          ledger.state.attempts.find((a) => a.id === record.attemptId)
            ?.durationMs ?? Date.now() - started;
        await this.persist("runs", run.id, run);
      }
    };
    try {
      const profile = profiles.find((p) => p.id === run.input.profileId)!;
      if (run.cacheHit) {
        validateCitations(
          run.result!,
          run.review!,
          sources,
          run.deck,
          this.deliveryPolicy,
        );
        await set("completed");
      } else if (run.input.mode === "example") {
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
        validateCitations(
          run.result,
          run.review,
          paper.sources,
          run.deck,
          this.deliveryPolicy,
        );
        await set("completed");
      } else if (run.input.workflow === "direct") {
        const rules = await assistantRules();
        await set("teaching");
        const result = await call(
          "assistant-explain",
          rules.text +
            (this.deliveryPolicy === "online"
              ? naturalDeliveryInstructions
              : "") +
            "\n" +
            skills.shared +
            "\n" +
            skills.modules.map((m) => m.text).join("\n"),
          {
            responseMode: "explain",
            question: run.input.question,
            focusedText: run.input.focusedText ?? null,
            depth: run.input.depth ?? "standard",
            learningIntent: run.input.learningIntent ?? null,
            previous: run.input.previous ?? null,
            contextSummary: run.input.contextSummary ?? "",
            sources: materialPacket(sources, run.input.question),
            boundary:
              "普通背景解释，不核验论文事实。只用 background 或 interpretation 段落；无来源知识不用编造引用。",
          },
          unitSchema,
        );
        if (
          result.sections.some(
            (s) => !["background", "interpretation"].includes(s.kind),
          )
        )
          throw new Error("直接解释不能冒充已核验的论文事实或基础资料。");
        run.review = {
          issues: [],
          checkedSources: [],
          limitations: ["本次为背景解释，未运行来源核对或模拟试读。"],
        };
        validateCitations(
          result,
          run.review,
          sources,
          undefined,
          this.deliveryPolicy,
        );
        run.result = result;
        await set("completed");
      } else {
        const teaching =
          skills.shared +
          (this.deliveryPolicy === "online"
            ? naturalDeliveryInstructions
            : "") +
          (skills.teachingContract ?? "") +
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
        const readCheck = run.input.checks?.readability ?? true;
        const novice =
          (skills.modules.find((m) => m.id === "medical-novice-simulator")
            ?.text ?? "") +
          (this.deliveryPolicy === "online" ? onlineNoviceInstructions : "");
        const checking =
          skills.shared +
          "\n" +
          skills.modules.find((m) => m.id === "medical-grounding-check")!.text +
          "\n若 deck 含 speechScript，联合核对完整稿与页面的事实、术语、页序、转场和结尾；仅提供逐页备注不能当作完整稿。";
        const scopedChecking =
          checking +
          "\n图像事实核对：显著性括号必须按该面板横向组别逐个定位两条竖线端点，再用图例核对两端点的颜色、形状和组名；不要按星号居中位置、最近的散点或其他面板推测比较组。提出改组建议时在suggestion写明这条定位依据。原稿、前次审核和用户的说法均不是原始证据；重新核对图像后才能采纳，读不清时限定到可确认的结果，不编造精确比较。" +
          (this.deliveryPolicy === "online" ? onlineReviewInstructions : "") +
          (run.input.diagnosticScope
            ? "\n本次核对同时检查事实与解释：当前问题涉及的干预／测量原理、术语含义、比较的作用和从读数到判断的推理是否进入实际产物。只依据本次来源；合理的真实未知保留，不要求额外复现手册。不把缺少必要解释判为通过。"
            : "");
        const task = {
          question: run.input.question,
          visualEvidenceProtocol:
            "涉及图中显著性比较时，先按面板列出横向组别顺序，用图例识别符号，再沿括号两端竖线向下定位组别。星号居中位置不是比较端点。反馈不是原始证据，任何改组必须独立核图；不确定的具体比较不作确定断言。正文不重复这套工作步骤，清楚讲实际结果即可。",
          module: run.input.module,
          sourceScope: sources.every((s) => s.kind === "foundation")
            ? "独立基础课程；未提供论文材料，不把通用方法写成本文具体做法。"
            : paper.scope,
          sources: materialPacket(sources, run.input.question),
          taughtConcepts: run.input.taughtConcepts,
          figureFamiliarity: figureFamiliarity(
            run.input.taughtConcepts,
            run.input.question,
          ),
          previous: run.input.previous || null,
          modules: run.input.modules ?? [run.input.module],
          slideCount: run.input.slideCount ?? null,
          speechScript: run.input.speechScript === true,
          contextSummary: run.input.contextSummary ?? "",
          openQuestions: run.input.openQuestions ?? [],
          focusedText: run.input.focusedText ?? null,
          depth: run.input.depth ?? "standard",
          learningIntent: run.input.learningIntent ?? null,
        };
        await set("teaching");
        // The auxiliary unit is a short introduction to a diagnostic deck,
        // never a second copy of its notes. Normal product schemas stay intact.
        const scopedSchema = () => {
          const baseSchema = groundedTeachingSchema(
            sources,
            run.input.speechScript,
          );
          return run.input.diagnosticScope && run.input.module === "ppt"
            ? baseSchema.extend({
                unit: baseSchema.shape.unit.extend({
                  sections: baseSchema.shape.unit.shape.sections.max(1),
                  terms: baseSchema.shape.unit.shape.terms.max(3),
                }),
              })
            : baseSchema;
        };
        const generationSchema = skills.explanationTracing
          ? scopedSchema().extend({
              explanationLinks: tracingSchema(skills.explanationTracing),
            })
          : scopedSchema();
        let generated = await call(
          "teaching",
          teaching +
            (run.input.diagnosticScope
              ? "\n只完成当前完整片段，保留必要方法、比较、测量解释与证据边界。PPT 的 unit 只写一段简短导读；必要解释进入页面和逐页备注，不另写重复长讲解，不生成完整演讲稿。"
              : "") +
            (run.input.speechScript
              ? "\n同时在 deck.speechScript 输出完整中文演讲稿（Markdown）：开场、按实际页序逐页讲述与转场、结尾。解释图件与方法，不机械复读 bullet，不补造结果；结构随研究类型和用户要求调整。"
              : ""),
          task,
          generationSchema,
        );
        const requestedDeck = (
          run.input.modules ?? [run.input.module]
        ).includes("ppt");
        if (!requestedDeck) generated = { ...generated, deck: null };
        run.draft = generated.unit;
        run.explanationTrace = explanationTrace(
          generated,
          sources,
          run.input.question,
        );
        if (skills.explanationTracing)
          run.explanationTrace = {
            evidence: run.explanationTrace,
            links: validateExplanationLinks(
              generated,
              sources,
              run.input.question,
              requestedDeck ? "ppt" : "paper",
              skills.explanationTracing,
            ),
          };
        if (readCheck) await set("novice");
        let feedback: NoviceFeedback = readCheck
          ? await call(
              "novice",
              novice,
              visibleInput(
                run.input,
                generated.unit,
                profile,
                sources,
                undefined,
                generated.deck,
              ),
              noviceSchema,
            )
          : { understood: [], breakpoints: [] };
        await set("checking");
        let review = await call(
          "grounding",
          scopedChecking,
          {
            question: run.input.question,
            sources: materialPacket(sources, run.input.question),
            draft: generated.unit,
            previous: run.input.previous ?? null,
            previousIsContextOnly: true,
            deck: generated.deck,
            feedback,
            learningIntent: run.input.learningIntent ?? null,
          },
          groundedReviewSchema(sources),
        );
        validateCitations(
          generated.unit,
          review,
          sources,
          generated.deck || undefined,
          this.deliveryPolicy,
        );
        const requestMap = new Map<
          string,
          { id: string; concept: string; question: string }
        >();
        for (const request of [
          ...feedback.breakpoints
            .filter((b) => b.status !== "resolved")
            .map((b) => ({
              id: b.id,
              concept: b.missingConcept,
              question: b.question,
            })),
          ...review.issues
            .filter(
              (i) =>
                !i.resolved &&
                i.type === "material" &&
                (this.deliveryPolicy === "internal" ||
                  i.severity === "blocking"),
            )
            .map((i) => ({
              id: i.id,
              concept: i.suggestion,
              question: i.suggestion,
            })),
        ]) {
          const prior = requestMap.get(request.id);
          requestMap.set(
            request.id,
            prior
              ? {
                  ...request,
                  concept: prior.concept + "\n" + request.concept,
                  question: prior.question + "\n" + request.question,
                }
              : request,
          );
        }
        const requests = [...requestMap.values()];
        let supplemented = false;
        const focusIds = review.issues
          .filter(
            (i) =>
              !i.resolved &&
              ["material", "teaching"].includes(i.type) &&
              (this.deliveryPolicy === "internal" || i.severity === "blocking"),
          )
          .flatMap((i) => i.evidence)
          .filter((id) => sources.some((s) => s.id === id && !s.image));
        const focusedPacket = materialPacket(
          sources,
          run.input.question,
          focusIds,
        );
        const providedPaperIds = focusIds.filter((id) =>
          focusedPacket.references.some(
            (r) => r.id === id && !("fullText" in r && r.fullText === false),
          ),
        );
        if (digest(focusedPacket) !== digest(task.sources)) {
          task.sources = focusedPacket;
          supplemented = true;
        }
        for (const request of requests) {
          const paperSpecific =
            review.issues.some(
              (i) =>
                i.id === request.id &&
                i.type === "material" &&
                i.evidence.some((id) =>
                  sources.some((s) => s.id === id && s.kind === "paper"),
                ),
            ) ||
            /缺.*(原图|图注|方法原文|论文.*参数)|未提供.*(原图|图注|方法原文)|需(?:要)?(?:提供|补充).*(归一化与校准|稳定性依据)|(?:图注|所给材料|当前论文|本文).*(?:未明确|缺少|未提供).*(?:分母|基线|筛选|参数)|基线.*(?:哪个时间|何时|测量时间|逐.*配对)/s.test(
              request.question,
            );
          // A request can cite a paper figure and still ask for foundational
          // definitions. Paper provenance must not suppress that second need.
          const needsFoundation =
            /代表什么|测量什么|生物学含义|基础来源|基础定义|概念含义|基础原理/.test(
              request.concept + "\n" + request.question,
            );
          const matches =
            paperSpecific && !needsFoundation
              ? []
              : foundationCatalog.match(
                  request.concept + "\n" + request.question,
                );
          const added = matches.filter(
            (s) => !sources.some((x) => x.id === s.id),
          );
          let provided = matches.length > 0;
          if (
            paperSpecific &&
            supplemented &&
            review.issues.some(
              (i) =>
                i.id === request.id &&
                i.evidence.some((id) => providedPaperIds.includes(id)),
            )
          )
            provided = true;
          if (added.length) {
            try {
              materialPacket([...sources, ...added]);
              sources.push(...added);
              supplemented = true;
            } catch {
              provided = false;
            }
          }
          run.materialRequests!.push({
            ...request,
            kind: paperSpecific ? "paper" : "foundation",
            reason: provided
              ? "已补入可核验资料，须由修订及复核确认解释是否解决。"
              : "未匹配到可用资料，或相关资料超过额度。",
            paperId: paper.id,
            sourceVersion: paper.version,
            matchedIds: provided
              ? [
                  ...new Set([
                    ...(paperSpecific ? providedPaperIds : []),
                    ...matches.map((s) => s.id),
                  ]),
                ]
              : [],
            status: provided ? "provided" : "pending",
          });
        }
        if (supplemented) {
          run.materials!.push({
            hash: digest({ sources, image: run.input.visibleImage }),
            phase: "revision",
            sources: structuredClone(sources),
            addedIds: sources
              .filter((s) => !run.input.sourceIds.includes(s.id))
              .map((s) => s.id),
          });
          task.sources = materialPacket(sources, run.input.question, focusIds);
          await this.persist("runs", run.id, run);
        }
        if (
          needsRevision(review, feedback, this.deliveryPolicy) ||
          run.materialRequests!.some((r) => r.status === "provided")
        ) {
          await ledger.revise(run.input.groupId ?? run.id);
          await set("revising");
          const firstDraft = structuredClone(generated),
            firstReview = structuredClone(review);
          generated = await call(
            "revision",
            teaching +
              (run.input.diagnosticScope
                ? "\n保留片段范围：PPT unit 仅简短导读，解释集中在页面和逐页备注，不生成完整稿或重复长讲解。"
                : "") +
              (run.input.speechScript
                ? "\n保留并修订 deck.speechScript 完整中文演讲稿，包含开场、按页讲述、转场、结尾，与修改后的页面一致。"
                : ""),
            {
              ...task,
              draft: generated.unit,
              deck: generated.deck,
              feedback,
              review,
              materialRequests: run.materialRequests,
              revisionEvidence: {
                beforeHash: digest(firstDraft),
                sourceHash: digest(sources),
                locations: explanationTrace(
                  firstDraft,
                  sources,
                  run.input.question,
                ).locations.map(({ location, sourceIds }) => ({
                  location,
                  sourceIds,
                })),
                verifiedSourceIds: firstReview.checkedSources,
              },
              instruction:
                "只修订一次。逐项审计当前问题的位置、来源和理解缺口后融入正文。审核建议也可能误读图像，不得直接把suggestion当作事实：修改比较组前重新从原图的图例、组别顺序和括号两端核实；原稿正确时保留，不为迎合审核改错。已核实的对象、比较组、参照、单位、方向与证据边界依来源保留；首稿若有错误，给实际依据再纠正，不凭图注词义填造公式。核对所有新增或改变的事实。内部编号留在工作记录。",
            },
            skills.explanationTracing
              ? scopedSchema().extend({
                  explanationLinks: tracingSchema(skills.explanationTracing),
                })
              : scopedSchema(),
          );
          if (!requestedDeck) generated = { ...generated, deck: null };
          if (skills.explanationTracing)
            run.explanationTrace = {
              evidence: explanationTrace(
                generated,
                sources,
                run.input.question,
              ),
              links: validateExplanationLinks(
                generated,
                sources,
                run.input.question,
                requestedDeck ? "ppt" : "paper",
                skills.explanationTracing,
              ),
            };
          const trace = revisionTrace(
            firstDraft,
            generated,
            sources,
            firstReview,
            run.input.question,
          );
          run.revisionTrace = trace;
          await this.persist("runs", run.id, run);
          if (readCheck) await set("rereading");
          feedback = readCheck
            ? await call(
                "novice-reread",
                novice,
                visibleInput(
                  run.input,
                  generated.unit,
                  profile,
                  sources,
                  feedback,
                  generated.deck,
                ),
                noviceSchema,
              )
            : { understood: [], breakpoints: [] };
          await set("rechecking");
          review = await call(
            "grounding-final",
            scopedChecking +
              "\n" +
              revisionAuditInstruction +
              (this.deliveryPolicy === "online"
                ? "\n不得保留未经来源支持的创新断言。必要原始材料仍缺失且影响用户目标时，不能把占位页当作已完成成果。"
                : "\n在线交付的PPT若审核指出‘创新’缺少全文依据，必须把页面中的‘创新’改为‘设计特点’或‘本图贡献’，并同步收窄讲述提示；不得保留未经来源支持的创新断言。对明确标注原始材料缺失的占位页，可以保留占位并交付草稿。"),
            {
              sources: task.sources,
              draft: generated.unit,
              deck: generated.deck,
              feedback,
              previousIssues: review.issues,
              revisionAudit: revisionAuditInput(trace),
              learningIntent: run.input.learningIntent ?? null,
            },
            groundedReviewSchema(sources),
          );
        }
        validateCitations(
          generated.unit,
          review,
          sources,
          generated.deck || undefined,
          this.deliveryPolicy,
        );
        if (readCheck) run.novice = feedback;
        run.review = review;
        for (const request of run.materialRequests ?? []) {
          const bp = feedback.breakpoints.find((b) => b.id === request.id);
          const issue = review.issues.find((i) => i.id === request.id);
          if (
            (bp?.status === "resolved" || issue?.resolved) &&
            (!bp || bp.status === "resolved") &&
            (!issue || issue.resolved)
          )
            request.status = "resolved";
        }
        validateRunSurface(
          run,
          generated.unit,
          generated.deck || undefined,
          sources,
        );
        if ((run.input.modules ?? [run.input.module]).includes("ppt")) {
          if (!generated.deck) throw new Error("汇报任务未返回页面与讲稿。");
          if (
            run.input.slideCount &&
            generated.deck.slides.length !== run.input.slideCount
          )
            throw new Error("汇报页数与用户要求不符。");
          if (
            (run.input.modules ?? []).includes("figure") &&
            !generated.deck.slides.some(
              (s) =>
                s.imageSource &&
                sources.some((x) => x.id === s.imageSource && x.figure) &&
                run.input.visibleImage,
            )
          )
            throw new Error("读图汇报缺少已提供的原图来源。");
        }
        if (this.deliveryPolicy === "online") {
          const problem = onlineDeliveryProblem(review);
          if (problem) throw new Error(problem);
        }
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
      this.activeIds.delete(run.id);
    }
  }
}
import {
  onlineDeliveryProblem,
  onlineReviewInstructions,
  naturalDeliveryInstructions,
  onlineNoviceInstructions,
} from "./delivery-policy.ts";
