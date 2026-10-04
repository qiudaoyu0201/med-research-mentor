import { randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  AssistantPlan,
  AssistantTurn,
  ConversationState,
  Module,
  PaperBundle,
  TaskInput,
  TaskRun,
} from "../shared/types.ts";
import { sample, profiles } from "../examples/bundle.ts";
import { save, list } from "./storage.ts";
import { ConversationStore } from "./conversation.ts";
import { BudgetLedger } from "./budget.ts";
import { TaskManager } from "./orchestrator.ts";
import type { Provider } from "./provider.ts";
import { assistantRules } from "./skills.ts";
import { planSchema } from "./schemas.ts";
import { digest, selectEvidence } from "./materials.ts";
import { exportDeck } from "./export.ts";
import { ResultCache } from "./cache.ts";

const terminal = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "clarification",
]);
const actions: Record<
  Module,
  "paper.read" | "method.explain" | "figure.explain" | "ppt.compose"
> = {
  paper: "paper.read",
  method: "method.explain",
  figure: "figure.explain",
  ppt: "ppt.compose",
};
export function rulePlan(
  message: AssistantMessage,
  state: ConversationState,
  paper: PaperBundle,
): AssistantPlan | undefined {
  const question = state.pending
    ? `${state.pending.question}\n用户补充：${message.question}`
    : message.question;
  const report = /PPT|汇报|幻灯|演示文稿/i.test(question);
  const figure = /Figure\s*\d+|图\s*[一二三四五六七八九十\d]+|读图|图表/i.test(
    question,
  );
  const method = /PCR|Ct\b|流式|方法|原理/i.test(question);
  const knownMethod = /PCR|Ct\b|流式/i.test(question);
  const modules: Module[] = [];
  if (report) {
    if (figure) modules.push("figure");
    if (method) modules.push("method");
    modules.push("ppt");
  } else if (message.module) modules.push(message.module);
  else if (figure) modules.push("figure");
  else if (method) modules.push("method");
  else if (/论文|研究问题|衰老细胞|实验|读懂|带读/.test(question))
    modules.push("paper");
  else if (state.lastRunId && /这|上|继续|对照|为什么|还是/.test(question))
    modules.push(state.pending?.module ?? message.module ?? "paper");
  const clarify =
    modules.length === 0 &&
    !state.lastRunId &&
    /这|那|此|这样|这一步/.test(question);
  if (modules.length === 0 && !clarify && !message.exportRunId) return;
  const count = /(\d+)\s*[页张]/.exec(question);
  const chinese = /([一二两三四五六七八九十]+)\s*[页张]/.exec(question);
  const digit = (value: string) =>
    value === "两" ? 2 : "一二三四五六七八九".indexOf(value) + 1;
  const chineseCount = chinese?.[1].includes("十")
    ? (chinese[1].split("十")[0] ? digit(chinese[1].split("十")[0]) : 1) * 10 +
      (chinese[1].split("十")[1] ? digit(chinese[1].split("十")[1]) : 0)
    : chinese
      ? digit(chinese[1])
      : null;
  const slideCount = report
    ? count
      ? Number(count[1])
      : chinese
        ? chineseCount
        : null
    : null;
  let sourceIds = message.sourceIds ?? state.pending?.sourceIds;
  if (
    !sourceIds?.length &&
    modules.includes("method") &&
    !figure &&
    !knownMethod &&
    !state.lastRunId
  ) {
    return {
      goal: question,
      modules,
      sourceIds: [],
      slideCount,
      groups: [],
      clarification: "你想了解哪一种方法？请提供方法名称或相关方法原文。",
      estimatedCalls: 0,
    };
  }
  if (!sourceIds?.length) {
    if (
      modules.every((m) => m === "method") ||
      (modules.includes("method") && !figure)
    ) {
      sourceIds = paper.sources
        .filter(
          (s) =>
            s.kind === "foundation" &&
            (/流式/.test(question) ? /flow/.test(s.id) : /pcr/.test(s.id)),
        )
        .map((s) => s.id);
    } else {
      const figureNumber = /(?:Figure|图)\s*([\d一二三四五六七八九十]+)/i.exec(
        question,
      )?.[1];
      const number =
        figureNumber &&
        (/^\d+$/.test(figureNumber)
          ? figureNumber
          : String("一二三四五六七八九十".indexOf(figureNumber) + 1));
      const target = paper.sources.find(
        (s) => s.figure && s.image && (!number || s.figure.startsWith(number)),
      );
      sourceIds = target
        ? [
            target.id,
            ...paper.sources
              .filter(
                (s) =>
                  s.id !== target.id &&
                  ((number === "1" &&
                    ["xu-fig1-results", "xu-fig1-methods"].includes(s.id)) ||
                    (!paper.sources.some((s) => s.id === "xu-fig1-methods") &&
                      s.id === "xu-design" &&
                      number === "1")),
              )
              .slice(0, 2)
              .map((s) => s.id),
          ]
        : paper.sources
            .filter(
              (s) =>
                s.kind === "paper" &&
                (!figure || !number || s.figure?.startsWith(number)),
            )
            .slice(0, 4)
            .map((s) => s.id);
    }
  }
  return {
    goal: question,
    modules,
    sourceIds,
    slideCount,
    groups: clarify
      ? []
      : [
          {
            id: "group-1",
            actions: message.exportRunId
              ? ["ppt.export"]
              : modules.map((m) => actions[m]),
            dependsOn: [],
          },
        ],
    clarification: clarify
      ? "你指的是哪个实验步骤？请提供步骤名称、原文段落或图号。"
      : null,
    estimatedCalls: clarify || message.exportRunId ? 0 : 6,
  };
}
export function validatePlan(
  value: unknown,
  paper: PaperBundle,
  message: AssistantMessage,
): AssistantPlan {
  const plan = planSchema.parse(value);
  if (plan.sourceIds.some((id) => !paper.sources.some((s) => s.id === id)))
    throw new Error("计划引用了不存在的来源。");
  if (plan.groups.some((g) => g.dependsOn.length))
    throw new Error("当前版本只执行一个无依赖任务组。");
  if (
    (plan.clarification && plan.groups.length) ||
    (!plan.clarification && plan.groups.length !== 1)
  )
    throw new Error("澄清与执行任务组不能同时存在。");
  const selectedActions = plan.groups.flatMap((g) => g.actions);
  if (selectedActions.includes("material.request") && !plan.clarification)
    throw new Error("材料请求必须提供具体澄清问题并停止执行。");
  if (
    selectedActions.includes("ppt.export") &&
    (!message.exportRunId || selectedActions.length !== 1)
  )
    throw new Error("直接导出需要指定已核对的大纲记录。");
  if (
    !plan.clarification &&
    !selectedActions.includes("ppt.export") &&
    (!plan.modules.length ||
      plan.modules.some((m) => !selectedActions.includes(actions[m])) ||
      selectedActions.some((a) => !plan.modules.some((m) => actions[m] === a)))
  )
    throw new Error("计划动作与功能不一致。");
  if (
    !plan.clarification &&
    !selectedActions.includes("ppt.export") &&
    plan.sourceIds.length === 0
  )
    throw new Error("计划没有绑定教学资料。");
  return plan;
}

export class AssistantService {
  turns = new Map<string, AssistantTurn>();
  active: string | undefined;
  private accepting = false;
  private controllers = new Map<string, AbortController>();
  private completions = new Map<string, Promise<void>>();
  private ready = new Map<string, Promise<void>>();
  private submissions = new Map<string, Promise<AssistantTurn>>();
  private legacyState?: Promise<ConversationState>;
  constructor(
    private provider: Provider,
    readonly manager: TaskManager,
    readonly conversations: ConversationStore,
    private paperById: (id: string) => Promise<PaperBundle>,
    private persist: typeof save = save,
    private cache?: ResultCache,
    private exporter: typeof exportDeck = exportDeck,
  ) {}
  get busy() {
    return this.accepting || !!this.active;
  }
  async restore() {
    await this.conversations.restore();
    for (const turn of await list<AssistantTurn>("turns")) {
      if (!terminal.has(turn.status)) {
        turn.status = "interrupted";
        turn.error = "后台重启中断了此轮，请提交新消息继续。";
        turn.endedAt = new Date().toISOString();
        for (const attempt of turn.budget.attempts)
          if (attempt.status === "reserved") attempt.status = "unknown";
        await this.persist("turns", turn.id, turn);
      }
      this.turns.set(turn.id, turn);
      const state = this.conversations.get(turn.conversationId);
      let changed = false;
      if (!state.recentTurnIds.includes(turn.id)) {
        state.recentTurnIds.push(turn.id);
        changed = true;
      }
      for (const group of state.taskGroups)
        if (group.id.startsWith(turn.id) && !terminal.has(group.status)) {
          group.status = turn.status;
          changed = true;
        }
      if (changed) await this.conversations.put(state, state.version);
    }
  }
  async submit(
    conversationId: string,
    message: AssistantMessage,
    legacy = false,
  ): Promise<AssistantTurn> {
    const key = `${conversationId}:${message.clientMessageId}`;
    const pending = this.submissions.get(key);
    if (pending) {
      const turn = await pending;
      if (digest(turn.message) !== digest(message))
        throw new Error("客户端消息 ID 已用于不同内容。");
      return turn;
    }
    const submission = this.accept(conversationId, message, legacy);
    this.submissions.set(key, submission);
    try {
      return await submission;
    } finally {
      this.submissions.delete(key);
    }
  }
  private async accept(
    conversationId: string,
    message: AssistantMessage,
    legacy: boolean,
  ): Promise<AssistantTurn> {
    const duplicate = [...this.turns.values()].find(
      (t) =>
        t.conversationId === conversationId &&
        t.message.clientMessageId === message.clientMessageId,
    );
    if (duplicate) {
      if (digest(duplicate.message) !== digest(message))
        throw new Error("客户端消息 ID 已用于不同内容。");
      return duplicate;
    }
    if (this.busy || this.manager.active || this.manager.starting)
      throw new Error("已有学习请求运行中，请先取消或等待完成。");
    this.accepting = true;
    try {
      const state = this.conversations.get(conversationId);
      const id = randomUUID();
      const ledger = new BudgetLedger(id, async () =>
        this.persist("turns", id, turn),
      );
      const turn: AssistantTurn = {
        id,
        conversationId,
        message,
        createdAt: new Date().toISOString(),
        status: "queued",
        budget: ledger.state,
      };
      await this.persist("turns", id, turn);
      this.turns.set(id, turn);
      state.recentTurnIds = [...state.recentTurnIds, id];
      try {
        await this.conversations.put(state, state.version);
      } catch (error) {
        turn.status = "failed";
        turn.error = "会话保存失败，未发送模型请求。";
        await this.persist("turns", id, turn);
        throw error;
      }
      const controller = new AbortController();
      this.controllers.set(id, controller);
      this.active = id;
      let markReady!: () => void;
      this.ready.set(
        id,
        new Promise((resolve) => {
          markReady = resolve;
        }),
      );
      const completion = this.execute(
        turn,
        ledger,
        controller.signal,
        legacy,
        markReady,
      );
      this.completions.set(id, completion);
      void completion.catch(() => {});
      return turn;
    } finally {
      this.accepting = false;
    }
  }
  async wait(id: string) {
    await this.completions.get(id);
  }
  async taskReady(id: string) {
    await this.ready.get(id);
    const turn = this.turns.get(id);
    if (!turn?.runId)
      throw new Error(
        turn?.error || turn?.reply?.nextStep || "此轮未建立教学任务。",
      );
    return this.manager.runs.get(turn.runId)!;
  }
  async legacy(input: TaskInput & { clientMessageId?: string }) {
    let state: ConversationState;
    if (input.conversationId)
      state = this.conversations.get(input.conversationId);
    else {
      this.legacyState ??= this.conversations.states.has("legacy-current")
        ? Promise.resolve(this.conversations.get("legacy-current"))
        : this.conversations.create({}, "legacy-current");
      state = await this.legacyState;
    }
    const turn = await this.submit(
      state.id,
      {
        clientMessageId: input.clientMessageId ?? randomUUID(),
        question: input.question,
        module: input.module,
        mode: input.mode,
        paperId: input.paperId,
        sourceIds: input.sourceIds,
        profileId: input.profileId,
        ...(input.visibleImage ? { visibleImage: input.visibleImage } : {}),
      },
      true,
    );
    return this.taskReady(turn.id);
  }
  async cancel(id: string) {
    const turn = this.turns.get(id);
    if (!turn || terminal.has(turn.status)) return;
    this.controllers.get(id)?.abort();
    if (turn.runId) await this.manager.cancel(turn.runId);
    turn.status = "cancelled";
    await this.persist("turns", id, turn);
    await this.wait(id);
  }
  private async execute(
    turn: AssistantTurn,
    ledger: BudgetLedger,
    signal: AbortSignal,
    legacy: boolean,
    markReady: () => void,
  ) {
    let state = this.conversations.get(turn.conversationId);
    try {
      const message = turn.message;
      const binding =
        message.paperId === undefined ? state.paperId : message.paperId;
      const original = await this.paperById(binding ?? sample.id);
      const paper = {
        ...original,
        sources: [
          ...original.sources.map((s) =>
            s.figure === "用户圈选" && !s.caption
              ? { ...s, caption: s.text }
              : s,
          ),
          ...sample.sources.filter(
            (s) =>
              s.kind === "foundation" &&
              !original.sources.some((x) => x.id === s.id),
          ),
        ],
      };
      if (
        message.sourceIds?.some((id) => !paper.sources.some((s) => s.id === id))
      )
        throw new Error("所选来源不存在");
      if (
        state.paperId !== binding ||
        (state.sourceVersion !== null && state.sourceVersion !== paper.version)
      ) {
        state.taughtConcepts = [];
        state.summaries = [];
        state.openQuestions = [];
        state.taskGroups = [];
        state.lastRunId = undefined;
        state.pending = undefined;
      }
      state.paperId = binding;
      state.sourceVersion = paper.version;
      state.profileId = message.profileId ?? state.profileId;
      if (!profiles.some((p) => p.id === state.profileId))
        throw new Error("新手画像不存在");
      const last = state.lastRunId
        ? this.manager.runs.get(state.lastRunId)
        : undefined;
      const referential =
        !message.module &&
        !message.sourceIds &&
        /^(为什么|这|那|继续|还是|上一)/.test(message.question) &&
        !/PCR|流式|Figure|图\s*\d|PPT|汇报/i.test(message.question);
      const routed =
        referential && last
          ? {
              ...message,
              module: last.input.module,
              sourceIds: last.input.sourceIds,
            }
          : message;
      let plan = rulePlan(routed, state, paper);
      if (!plan) {
        if (message.mode === "example")
          throw new Error("请在示例模式选择具体功能。");
        turn.status = "planning";
        const rules = await assistantRules();
        const result = await ledger.call(
          this.provider,
          "assistant",
          rules.text,
          {
            question: message.question,
            pending: state.pending ?? null,
            paper: { id: paper.id, title: paper.title, scope: paper.scope },
            sources: paper.sources.map(
              ({ id, title, locator, kind, figure, image, caption }) => ({
                id,
                title,
                locator,
                kind,
                figure: figure ?? null,
                hasImage: !!image,
                hasCaption: !!caption,
              }),
            ),
            context: this.context(state),
          },
          planSchema,
          signal,
          { sourceHash: digest(paper.sources), skillHash: rules.version },
        );
        plan = result.output;
      }
      plan = validatePlan(plan, paper, message);
      if (
        !binding &&
        message.mode === "live" &&
        !plan.clarification &&
        (plan.modules.some((m) => m === "paper" || m === "figure") ||
          (plan.modules.includes("ppt") &&
            !plan.modules.includes("method") &&
            !state.lastRunId))
      ) {
        plan = {
          ...plan,
          sourceIds: [],
          groups: [],
          estimatedCalls: 0,
          clarification: "请提供需要带读或汇报的论文，并选择相关段落或图件。",
        };
      }
      if (message.mode === "live" && !plan.clarification)
        plan.sourceIds = selectEvidence(
          paper.sources.filter((s) => plan!.sourceIds.includes(s.id)),
          plan.goal,
          plan.modules,
        ).map((s) => s.id);
      ledger.state.limit = ledger.state.attempts.length ? 7 : 6;
      signal.throwIfAborted();
      // Natural read-figure requests require the original image and a complete caption.
      if (
        !legacy &&
        message.mode === "live" &&
        plan.modules.includes("figure") &&
        !plan.clarification
      ) {
        const figure = paper.sources.find(
          (s) =>
            plan!.sourceIds.includes(s.id) &&
            s.figure &&
            (s.image || message.visibleImage),
        );
        if (
          !figure ||
          !figure.caption ||
          /未可靠|未提供/.test(figure.caption)
        ) {
          plan = {
            ...plan,
            groups: [],
            estimatedCalls: 0,
            clarification: "请补上目标图的原图和完整图注，再继续读图及汇报。",
          };
        }
      }
      turn.plan = plan;
      if (plan.clarification) {
        turn.status = "clarification";
        state.pending = {
          questionId: turn.id,
          question: plan.goal,
          sourceIds: plan.sourceIds,
          module: plan.modules[0],
        };
        const question = {
          id: turn.id,
          question: plan.clarification,
          sourceIds: plan.sourceIds,
        };
        state.openQuestions = [
          ...state.openQuestions.filter((q) => q.id !== turn.id),
          question,
        ];
        turn.reply = {
          content: null,
          artifacts: [],
          pendingQuestions: [question],
          nextStep: plan.clarification,
        };
      } else {
        const groupId = `${turn.id}-${plan.groups[0].id}`;
        state.goal = plan.goal;
        state.taskGroups.push({
          id: groupId,
          status: "running",
          dependsOn: [],
        });
        state = await this.conversations.put(state, state.version);
        turn.status = "running";
        await this.persist("turns", turn.id, turn);
        const artifacts: NonNullable<AssistantTurn["reply"]>["artifacts"] = [];
        let run: TaskRun;
        if (message.exportRunId) {
          const existing = this.manager.runs.get(message.exportRunId);
          if (
            !existing ||
            existing.status !== "completed" ||
            !existing.deck ||
            existing.input.paperId !== paper.id ||
            existing.sourceVersion !== paper.version ||
            existing.input.conversationId !== state.id ||
            existing.review?.issues.some((i) => !i.resolved)
          )
            throw new Error("指定大纲尚未核对，或与当前会话及来源版本不一致。");
          run = existing;
        } else {
          const previous = state.lastRunId
            ? this.manager.runs.get(state.lastRunId)?.result
            : undefined;
          run = await this.manager.start(
            {
              paperId: paper.id,
              module: plan.modules.includes("ppt") ? "ppt" : plan.modules[0],
              modules: plan.modules,
              mode: message.mode,
              question: plan.goal,
              profileId: state.profileId,
              sourceIds: plan.sourceIds,
              taughtConcepts: state.taughtConcepts
                .slice(-20)
                .map((c) => c.name),
              ...(previous
                ? {
                    previous: {
                      title: previous.title.slice(0, 80),
                      question: previous.question.slice(0, 100),
                      terms: [],
                      nextQuestion: "",
                      sections: previous.sections.slice(0, 4).map((s) => ({
                        ...s,
                        title: s.title.slice(0, 50),
                        text: s.text.slice(0, 100),
                      })),
                    },
                  }
                : {}),
              slideCount: plan.slideCount ?? undefined,
              contextSummary: this.context(state).summary.slice(
                0,
                previous ? 400 : 1200,
              ),
              openQuestions: state.openQuestions.slice(-5),
              conversationId: state.id,
              turnId: turn.id,
              groupId,
              ...(message.visibleImage
                ? { visibleImage: message.visibleImage }
                : {}),
            },
            paper,
            undefined,
            undefined,
            { ledger, signal, cache: this.cache },
          );
          turn.runId = run.id;
          await this.persist("turns", turn.id, turn);
          markReady();
          await this.manager.wait(run.id);
          signal.throwIfAborted();
          if (run.status !== "completed")
            throw new Error(run.error ?? "教学任务未完成");
        }
        if (
          run.deck &&
          !run.review?.issues.some(
            (i) => !i.resolved && i.severity === "blocking",
          )
        ) {
          const id = randomUUID();
          await this.exporter(
            run.deck,
            binding
              ? paper
              : {
                  ...paper,
                  title: run.result?.title ?? plan.goal,
                  scope: "独立方法课程",
                },
            id,
          );
          signal.throwIfAborted();
          artifacts.push({ id, kind: "pptx", url: `/api/decks/${id}` });
          state.artifacts.push({
            id,
            kind: "pptx",
            sourceHash: digest(paper.sources),
          });
        }
        state.lastRunId = run.id;
        const names = new Map(state.taughtConcepts.map((c) => [c.name, c]));
        for (const term of run.result?.terms ?? [])
          names.set(term.name, { name: term.name, unitId: run.id });
        state.taughtConcepts = [...names.values()];
        const resolvedIds = new Set([
          ...(run.review?.issues.filter((i) => i.resolved).map((i) => i.id) ??
            []),
          ...(run.novice?.breakpoints
            .filter((b) => b.status === "resolved")
            .map((b) => b.id) ?? []),
          ...(state.pending?.questionId ? [state.pending.questionId] : []),
        ]);
        const questions = new Map(
          state.openQuestions
            .filter((q) => !resolvedIds.has(q.id))
            .map((q) => [q.id, q]),
        );
        for (const item of [
          ...(run.review?.issues
            .filter((i) => !i.resolved)
            .map((i) => ({
              id: i.id,
              question: i.suggestion,
              sourceIds: i.evidence,
            })) ?? []),
          ...(run.novice?.breakpoints
            .filter((b) => b.status !== "resolved")
            .map((b) => ({
              id: b.id,
              question: b.question,
              sourceIds: plan!.sourceIds,
            })) ?? []),
        ]) {
          if (!questions.has(item.id)) item.id = `${run.id}-${item.id}`;
          const prior = questions.get(item.id);
          questions.set(
            item.id,
            prior
              ? {
                  ...prior,
                  sourceIds: [
                    ...new Set([...prior.sourceIds, ...item.sourceIds]),
                  ],
                }
              : item,
          );
        }
        state.openQuestions = [...questions.values()];
        state.pending = undefined;
        state.summaries = [
          ...state.summaries,
          {
            turnId: turn.id,
            text: [
              run.result?.title,
              ...(run.result?.sections.map((s) => `${s.title}: ${s.text}`) ??
                []),
            ]
              .join("\n")
              .slice(0, 600),
          },
        ].slice(-2);
        turn.reply = {
          content: run.result ?? null,
          artifacts,
          pendingQuestions: state.openQuestions,
          nextStep: run.result?.nextQuestion ?? "",
        };
        turn.status = "completed";
      }
      signal.throwIfAborted();
      state.taskGroups = state.taskGroups.map((g) =>
        g.id.startsWith(turn.id) ? { ...g, status: turn.status } : g,
      );
      await this.conversations.put(state, state.version);
      if (
        turn.status === "completed" &&
        turn.runId &&
        this.cache &&
        turn.message.mode === "live"
      ) {
        await this.persist("turns", turn.id, turn);
        await this.manager.publishCache(turn.runId, this.cache);
      }
    } catch (error) {
      turn.status = signal.aborted ? "cancelled" : "failed";
      turn.error = error instanceof Error ? error.message : "请求失败";
      turn.reply = undefined;
      const current = this.conversations.get(turn.conversationId);
      current.taskGroups = current.taskGroups.map((g) =>
        g.id.startsWith(turn.id) ? { ...g, status: turn.status } : g,
      );
      try {
        await this.conversations.put(current, current.version);
      } catch {
        turn.error = "会话保存失败，请重新读取记录。";
      }
    } finally {
      turn.endedAt = new Date().toISOString();
      try {
        await this.persist("turns", turn.id, turn);
      } catch {
        turn.status = "failed";
        turn.error = "轮次保存失败，请复制当前内容。";
      }
      markReady();
      this.controllers.delete(turn.id);
      if (this.active === turn.id) this.active = undefined;
    }
  }
  private context(state: ConversationState) {
    return {
      summary: state.summaries
        .slice(-2)
        .map((s) => s.text)
        .join("\n")
        .slice(0, 1200),
      taughtConcepts: state.taughtConcepts.slice(-20),
      openQuestions: state.openQuestions.slice(-5),
    };
  }
}
