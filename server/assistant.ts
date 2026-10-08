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
import { taskTiming } from "./task-timing.ts";
import {
  TaskManager,
  materialSources,
  validateRunSurface,
} from "./orchestrator.ts";
import type { Provider } from "./provider.ts";
import { assistantRules, skillCatalog } from "./skills.ts";
import { planSchema } from "./schemas.ts";
import {
  digest,
  selectEvidence,
  defaultPaperSources,
  selectionVersion,
  materialPacket,
  figureNumber,
} from "./materials.ts";
import { foundationCatalog, withFoundationSources } from "./foundations.ts";
import { exportDeck } from "./export.ts";
import { ResultCache } from "./cache.ts";
import type { DeckVersions } from "./deck-versions.ts";
import { TaskScheduler, taskKey } from "./scheduler.ts";
import type { Attachments } from "./attachments.ts";
import {
  attachmentSource,
  type ResearchAttachment,
} from "../shared/attachments.ts";
import {
  requestedDepth,
  requestedPreferences,
  resolveLearningIntent,
} from "./depth.ts";
import { legacyDepth } from "../shared/learning-intent.ts";
import { validateAnchor } from "../shared/workspace.ts";

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
  const report =
    message.module === "ppt" || /PPT|汇报|幻灯|演示文稿/i.test(question);
  const figure =
    figureNumber(question) !== undefined || /读图|图表/.test(question);
  const knownMethod = foundationCatalog.match(question).length > 0;
  const method =
    /PCR|Ct\b|流式|方法|原理/i.test(question) ||
    (knownMethod && !/论文|研究问题|实验|带读|影响|引起/.test(question));
  const modules: Module[] = [];
  if (report) {
    if (figure) modules.push("figure");
    if (knownMethod || (figure && method)) modules.push("method");
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
    ? (message.slideCount ??
      (count ? Number(count[1]) : chinese ? chineseCount : null))
    : null;
  let sourceIds = message.sourceIds ?? state.pending?.sourceIds;
  if (
    !sourceIds?.length &&
    modules.length > 0 &&
    modules.every((m) => m === "method") &&
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
    sourceIds =
      modules.every((m) => m === "method") ||
      (modules.includes("method") && !figure && !modules.includes("ppt"))
        ? foundationCatalog.match(question).map((s) => s.id)
        : defaultPaperSources(paper, question, modules).map((s) => s.id);
    if (!sourceIds.length && !clarify && !message.exportRunId)
      return {
        goal: question,
        modules,
        sourceIds: [],
        slideCount,
        groups: [],
        estimatedCalls: 0,
        clarification: figure
          ? "请提供目标图的原图和完整图注，以及对应结果／方法，并确认图号。"
          : "请提供具体方法名称及相关基础或论文原文。",
      };
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
  allowBackground = false,
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
    plan.sourceIds.length === 0 &&
    !allowBackground
  )
    throw new Error("计划没有绑定教学资料。");
  return plan;
}

export class AssistantService {
  turns = new Map<string, AssistantTurn>();
  readonly activeIds = new Set<string>();
  get active() {
    return this.activeIds.values().next().value;
  }
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
    private decks?: DeckVersions,
    readonly scheduler = new TaskScheduler(),
    private attachments?: Attachments,
  ) {
    if (decks) decks.scheduler = scheduler;
  }
  get busy() {
    return this.scheduler.busy || this.submissions.size > 0;
  }
  async restore(loader: typeof list = list) {
    await this.conversations.restore(loader);
    for (const turn of await loader<AssistantTurn>("turns")) {
      if (!terminal.has(turn.status)) {
        turn.status = "interrupted";
        turn.error = "后台重启中断了此轮，请提交新消息继续。";
        turn.endedAt = new Date().toISOString();
        for (const attempt of turn.budget.attempts)
          if (attempt.status === "reserved") attempt.status = "unknown";
        await this.persist("turns", turn.id, turn);
      }
      this.turns.set(turn.id, turn);
      // A damaged conversation is quarantined independently; its healthy
      // turns stay on disk and must not prevent other chats from restoring.
      if (!this.conversations.states.has(turn.conversationId)) continue;
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
    for (const paperId of new Set(
      [...this.conversations.states.values()]
        .map((s) => s.paperId)
        .filter((id): id is string => Boolean(id)),
    ))
      await this.conversations.mainForPaper(paperId);
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
    const state = this.conversations.get(conversationId);
    if (
      state.mainChat &&
      message.paperId !== undefined &&
      message.paperId !== state.paperId
    )
      throw new Error("问题与当前聊天的论文不匹配，请打开对应论文。");
    const submittedAttachments = (message.attachmentIds ?? []).map((id) => {
      if (!this.attachments) throw new Error("附件服务不可用。");
      return this.attachments.get(id, state.id);
    });
    const paper = state.paperId
      ? await this.paperById(state.paperId)
      : undefined;
    const id = randomUUID();
    const ledger = new BudgetLedger(id, async () =>
      this.persist("turns", id, turn),
    );
    ledger.state.timing = taskTiming(
      message.module === "ppt" || /PPT|汇报|幻灯/i.test(message.question)
        ? "full"
        : "explanation",
      message.slideCount ?? 6,
    );
    const turn: AssistantTurn = {
      id,
      conversationId,
      message: structuredClone(message),
      paperId: state.paperId,
      sourceVersion: paper?.version ?? null,
      createdAt: new Date().toISOString(),
      status: "queued",
      ...(submittedAttachments.length
        ? { attachments: submittedAttachments }
        : {}),
      budget: ledger.state,
    };
    await this.persist("turns", id, turn);
    this.turns.set(id, turn);
    try {
      await this.conversations.update(conversationId, (current) => {
        if (!current.titleEdited && !current.recentTurnIds.length)
          current.title = message.question.replace(/\s+/g, " ").slice(0, 45);
        current.recentTurnIds.push(id);
        return current;
      });
    } catch (error) {
      turn.status = "failed";
      turn.error = "会话保存失败，未发送模型请求。";
      await this.persist("turns", id, turn);
      throw error;
    }
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let markReady!: () => void;
    this.ready.set(
      id,
      new Promise((resolve) => {
        markReady = resolve;
      }),
    );
    const completion = this.scheduler
      .run(taskKey(state.paperId, state.id), controller.signal, async () => {
        this.activeIds.add(id);
        // Waiting does not consume the execution deadline.
        ledger.state.deadline = new Date(
          Date.now() + (ledger.state.timing?.taskMs ?? 480_000),
        ).toISOString();
        await this.execute(turn, ledger, controller.signal, legacy, markReady);
      })
      .catch(async (error) => {
        turn.status = controller.signal.aborted ? "cancelled" : "failed";
        turn.error = controller.signal.aborted ? undefined : String(error);
        turn.endedAt = new Date().toISOString();
        await this.persist("turns", id, turn);
      })
      .finally(() => {
        this.controllers.delete(id);
        this.activeIds.delete(id);
        markReady();
      });
    this.completions.set(id, completion);
    void completion.catch(() => {});
    return turn;
  }

  async retryAttachment(
    turnId: string,
    attachmentId: string,
    purpose?: string,
  ) {
    if (!this.attachments) throw new Error("附件服务不可用。");
    const turn = this.turns.get(turnId);
    if (
      !turn ||
      this.controllers.has(turnId) ||
      !terminal.has(turn.status) ||
      !turn.message.attachmentIds?.includes(attachmentId)
    )
      throw new Error("请等待这条问题完成后重试该附件。");
    const state = this.conversations.get(turn.conversationId);
    const paper = state.paperId
      ? await this.paperById(state.paperId)
      : {
          id: "foundation-only",
          title: "研究想法",
          scope: "用户提供材料",
          version: foundationCatalog.version,
          sources: [],
        };
    const hadReply = turn.status === "completed";
    const controller = new AbortController();
    const ledger = new BudgetLedger(
      turn.id,
      () => this.persist("turns", turn.id, turn),
      turn.budget,
    );
    turn.status = "queued";
    await this.persist("turns", turn.id, turn);
    this.controllers.set(turn.id, controller);
    const completion = this.scheduler
      .run(taskKey(state.paperId, state.id), controller.signal, async () => {
        ledger.state.deadline = new Date(Date.now() + 480_000).toISOString();
        const checked = await this.attachments!.check(
          attachmentId,
          state.id,
          turn.message.question,
          paper,
          ledger,
          controller.signal,
          purpose,
          true,
        );
        turn.attachments = (turn.attachments ?? []).map((a) =>
          a.id === attachmentId ? checked : a,
        );
        if (hadReply) turn.status = "completed";
        else
          await this.execute(turn, ledger, controller.signal, false, () => {});
      })
      .catch((error) => {
        turn.status = controller.signal.aborted ? "cancelled" : "failed";
        turn.error = String(error);
      })
      .finally(async () => {
        this.controllers.delete(turn.id);
        await this.persist("turns", turn.id, turn);
      });
    this.completions.set(turn.id, completion);
    void completion.catch(() => {});
    return turn;
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
      signal.throwIfAborted();
      const message = turn.message;
      const binding =
        message.paperId === undefined ? state.paperId : message.paperId;
      const original: PaperBundle =
        binding || message.mode === "example"
          ? await this.paperById(binding ?? sample.id)
          : {
              id: "foundation-only",
              title: "独立基础课程",
              version: foundationCatalog.version,
              scope: "独立基础资料；未绑定论文。",
              sources:
                this.attachments?.sources(
                  null,
                  state.id,
                  foundationCatalog.version,
                ) ?? [],
            };
      if (
        turn.paperId !== undefined &&
        ((state.mainChat && turn.paperId !== state.paperId) ||
          (turn.sourceVersion && turn.sourceVersion !== original.version))
      )
        throw new Error("等待期间论文资料发生变化，请重新选择材料后发送。");
      const checked: ResearchAttachment[] = [];
      if (message.attachmentIds?.length) {
        if (!this.attachments) throw new Error("附件服务不可用。");
        turn.status = "checking-attachments";
        await this.persist("turns", turn.id, turn);
        for (const id of message.attachmentIds) {
          signal.throwIfAborted();
          checked.push(
            await this.attachments.check(
              id,
              state.id,
              message.question,
              original,
              ledger,
              signal,
            ),
          );
          turn.attachments = message.attachmentIds.map(
            (id) =>
              checked.find((a) => a.id === id) ??
              this.attachments!.get(id, state.id),
          );
          await this.persist("turns", turn.id, turn);
        }
        const unavailable = checked.filter((a) => a.status !== "ready");
        const depends = /仅.{0,12}(图|附件)|这[张幅].{0,8}图|图中|截图上/.test(
          message.question,
        );
        if (
          unavailable.some(
            (a) =>
              a.dependsOnImage || (a.dependsOnImage === undefined && depends),
          )
        ) {
          turn.status = "clarification";
          turn.reply = {
            content: null,
            artifacts: [],
            pendingQuestions: [],
            nextStep: unavailable
              .map(
                (a) => `${a.name}：${a.reason ?? "请补充图片用途或清晰版本。"}`,
              )
              .join("\n"),
          };
          return;
        }
      }
      const admitted = checked.flatMap((a) => attachmentSource(a) ?? []);
      const paper = withFoundationSources({
        ...original,
        sources: [
          ...original.sources.filter(
            (s) => !admitted.some((a) => a.id === s.id),
          ),
          ...admitted,
        ],
      });
      if (
        [message.focus, message.sourceAnchor, message.figureSourceId].filter(
          Boolean,
        ).length > 1
      )
        throw new Error("每次追问请选择一个明确的对象。");
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
        state.latestDeckVersionId = undefined;
        state.pending = undefined;
      }
      state.paperId = binding;
      state.sourceVersion = paper.version;
      state.profileId = message.profileId ?? state.profileId;
      const depthRequest = requestedDepth(message.question, message.depth);
      const intent = resolveLearningIntent(message, state);
      turn.learningIntent = intent;
      if (intent.preferenceScope === "conversation") {
        state.learningPreferences = {
          verbosity: intent.verbosity,
          focus: intent.focus,
        };
        state.explanationDepth = legacyDepth(state.learningPreferences);
      }
      if (!profiles.some((p) => p.id === state.profileId))
        throw new Error("新手画像不存在");
      const pageRequest =
        /(?:修改|改写|重写|润色)[^\n]{0,15}?第?([一二两三四五六七八九]|\d{1,2})\s*页/.exec(
          message.question,
        );
      const naturalPage = pageRequest
        ? (/^\d+$/.test(pageRequest[1])
            ? Number(pageRequest[1])
            : pageRequest[1] === "两"
              ? 2
              : "一二三四五六七八九".indexOf(pageRequest[1]) + 1) - 1
        : undefined;
      const edit =
        message.deckEdit ??
        (naturalPage !== undefined && state.latestDeckVersionId
          ? { versionId: state.latestDeckVersionId, slideIndex: naturalPage }
          : undefined);
      if (naturalPage !== undefined && !edit) {
        const question = {
          id: turn.id,
          question:
            "请先提供要修改的汇报，或选择已有汇报版本，再指定这一页的修改要求。",
          sourceIds: [],
        };
        state.openQuestions.push(question);
        turn.reply = {
          content: null,
          artifacts: [],
          pendingQuestions: [question],
          nextStep: question.question,
        };
        turn.status = "clarification";
        await this.commitExecution(state);
        return;
      }
      if (edit) {
        if (!this.decks) throw new Error("汇报版本服务不可用。");
        const parent = this.decks.get(edit.versionId, state.id);
        intent.goal = "report";
        intent.scope.artifactVersion = parent.id;
        intent.scope.sourceIds = parent.sourceIds;
        if (
          parent.paperId !== paper.id ||
          parent.sourceVersion !== paper.version
        )
          throw new Error("修改目标不属于当前论文版本。");
        turn.status = "running";
        await this.persist("turns", turn.id, turn);
        const started = await this.decks.start(
          parent.id,
          state.id,
          { slideIndex: edit.slideIndex, question: message.question },
          { ledger, signal, learningIntent: intent },
        );
        const version = await this.decks.wait(started.id);
        signal.throwIfAborted();
        if (version.status !== "completed")
          throw new Error(version.error ?? "修改尚未完成核对");
        const artifact = await this.decks.export(version.id, state.id);
        signal.throwIfAborted();
        state.latestDeckVersionId = version.id;
        state.artifacts.push({
          id: artifact.id,
          kind: "pptx",
          sourceHash: version.sourceHash,
        });
        state.summaries = [
          ...state.summaries,
          {
            turnId: turn.id,
            text: `修改第 ${edit.slideIndex + 1} 页：${version.outline.slides[edit.slideIndex].title}`,
          },
        ].slice(-2);
        state.goal = message.question;
        turn.reply = {
          content: null,
          artifacts: [{ ...artifact, kind: "pptx" }],
          pendingQuestions: version.review.issues
            .filter((i) => !i.resolved)
            .map((i) => ({
              id: i.id,
              question: i.suggestion,
              sourceIds: i.evidence,
            })),
          nextStep: "指定页已保存新版本；可查看差异、恢复旧版或继续修改。",
          deckVersionId: version.id,
        };
        turn.status = "completed";
        await this.commitExecution(state);
        return;
      }
      const last = state.lastRunId
        ? this.manager.runs.get(state.lastRunId)
        : undefined;
      const referential =
        !message.module &&
        !message.sourceIds &&
        (/^(为什么|这|那|继续|还是|上一)/.test(message.question) ||
          Boolean(depthRequest) ||
          Object.keys(requestedPreferences(message)).length > 0) &&
        !/PCR|流式|Figure|图\s*\d|PPT|汇报/i.test(message.question);
      let focusedText: string | undefined;
      let focusedSources: string[] | undefined;
      let focusedPaper = false;
      let visibleImage =
        (await this.attachments?.sheet(checked)) ?? message.visibleImage;
      if (message.sourceAnchor) {
        const source = validateAnchor(message.sourceAnchor, original);
        focusedText = message.sourceAnchor.excerpt;
        focusedSources = [source.id];
        focusedPaper = true;
      }
      if (message.figureSourceId) {
        const source = original.sources.find(
          (s) => s.id === message.figureSourceId,
        );
        if (!source?.figure || !source.image || source.kind !== "paper")
          throw new Error("图件未在当前论文中登记，请重新选择。");
        focusedText = source.caption || source.text;
        focusedSources = [source.id];
        focusedPaper = true;
        visibleImage = source.image;
      }
      if (message.focus) {
        const focusedRun = this.manager.runs.get(message.focus.runId);
        const section =
          focusedRun?.result?.sections[message.focus.sectionIndex];
        if (
          !focusedRun ||
          focusedRun.status !== "completed" ||
          focusedRun.input.conversationId !== state.id ||
          focusedRun.sourceVersion !== paper.version ||
          focusedRun.input.paperId !== paper.id ||
          !section ||
          !section.text.includes(message.focus.excerpt)
        )
          throw new Error("追问句子未在当前会话及资料版本中交付。");
        focusedText = message.focus.excerpt;
        focusedSources = section.citations;
        focusedPaper =
          section.kind === "paper" ||
          section.citations.some((id) =>
            paper.sources.some((s) => s.id === id && s.kind === "paper"),
          );
      }
      const explicitFacts =
        /论文|本文|作者|Figure|图\s*\d|PPT|汇报|出处|引用|文献|数值|实验参数/i.test(
          message.question,
        ) ||
        (message.module && message.module !== "method");
      const coreLearning =
        intent.goal !== "understand" ||
        intent.focus !== "balanced" ||
        /PCR|qPCR|流式|测量|原理|机制|归一化|实验单位|统计|设计|迁移|为什么|如何|怎样|排除|专业细节|仍不理解|还是不懂/i.test(
          message.question,
        );
      const backgroundDefinition =
        /一句话|通俗|简单解释|简短说明/.test(message.question) &&
        /什么(?:是|叫)|是什么意思|定义|概念|解释(?:一下)?(?:对照(?:组)?|假设|样本|变量|术语)/.test(
          message.question,
        );
      const wordingOnly =
        Boolean(message.focus) &&
        !coreLearning &&
        /换个通俗说法|仅压缩|只.*(?:压缩|润色)|润色已核对/.test(
          message.question,
        );
      const direct =
        !legacy &&
        message.mode === "live" &&
        !message.exportRunId &&
        !message.readabilityCheck &&
        !coreLearning &&
        !explicitFacts &&
        !focusedPaper &&
        !admitted.length &&
        !state.pending &&
        (wordingOnly ||
          backgroundDefinition ||
          (Boolean(depthRequest) &&
            /^(?:再|更)?(?:简单[点些]|详细[点些]|简短[点些]|通俗[点些]|展开[点些])[。！？?!]?$/.test(
              message.question.trim(),
            ) &&
            last?.input.workflow === "direct")) &&
        !(message.sourceIds ?? []).some((id) =>
          paper.sources.some((s) => s.id === id && s.kind === "paper"),
        );
      const routed =
        message.focus || message.sourceAnchor || message.figureSourceId
          ? {
              ...message,
              module: message.figureSourceId
                ? ("figure" as const)
                : focusedPaper
                  ? ("paper" as const)
                  : ("method" as const),
              sourceIds: focusedSources,
            }
          : admitted.length
            ? {
                ...message,
                module: "paper" as const,
                sourceIds: [
                  ...new Set([
                    ...admitted.map((a) => a.id),
                    ...defaultPaperSources(paper, message.question, [
                      "paper",
                    ]).map((s) => s.id),
                  ]),
                ],
              }
            : referential && last
              ? {
                  ...message,
                  module: last.input.module,
                  sourceIds: last.input.sourceIds,
                }
              : message;
      let plan: AssistantPlan | undefined = direct
        ? {
            goal: message.question,
            modules: ["method"],
            sourceIds: [],
            slideCount: null,
            groups: [
              { id: "group-1", actions: ["method.explain"], dependsOn: [] },
            ],
            clarification: null,
            estimatedCalls: 1,
          }
        : rulePlan(routed, state, paper);
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
            learningIntent: intent,
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
            skills: await skillCatalog(),
          },
          planSchema,
          signal,
          {
            sourceHash: digest({
              sources: paper.sources,
              selectionVersion,
              foundations: foundationCatalog.version,
            }),
            skillHash: rules.version,
          },
        );
        plan = result.output;
      }
      plan = validatePlan(plan, paper, message, direct);
      if (
        !binding &&
        !admitted.length &&
        !plan.sourceIds.some((id) =>
          paper.sources.some((s) => s.id === id && s.attachmentId),
        ) &&
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
      let missingFoundations: { id: string; title: string }[] = [];
      if (
        message.mode === "live" &&
        !plan.clarification &&
        !message.exportRunId &&
        !direct
      ) {
        const selected = paper.sources.filter((s) =>
          plan!.sourceIds.includes(s.id),
        );
        const wanted = foundationCatalog.match(
          [
            plan.goal,
            ...(plan.modules.some((m) => m === "figure" || m === "method")
              ? selected.map((s) => s.caption ?? s.text)
              : []),
            ...state.openQuestions.map((q) => q.question),
          ].join("\n"),
        );
        const missing = wanted.filter(
          (s) => !selected.some((x) => x.id === s.id),
        );
        try {
          materialPacket([...selected, ...missing]);
          plan.sourceIds.push(...missing.map((s) => s.id));
        } catch {
          missingFoundations = missing.map(({ id, title }) => ({ id, title }));
        }
      }
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
            (s.image || visibleImage),
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
      intent.scope.sourceIds = plan.sourceIds;
      intent.scope.selection = focusedText ?? intent.scope.selection;
      if (plan.modules.includes("ppt")) intent.goal = "report";
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
        state = await this.commitExecution(state);
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
              ...(direct ? { workflow: "direct" as const } : {}),
              ...(focusedText ? { focusedText } : {}),
              depth: legacyDepth(intent),
              learningIntent: intent,
              checks: {
                readability:
                  !direct &&
                  (!plan.modules.includes("ppt") ||
                    plan.modules.includes("figure") ||
                    message.readabilityCheck === true) &&
                  (!wordingOnly || message.readabilityCheck === true),
                reason: direct
                  ? "简短独立背景解释，未核验论文事实"
                  : wordingOnly && message.readabilityCheck !== true
                    ? "仅改写当前已交付选区，保留来源核验"
                    : "核心教学按当前目标试读并核验；选区、附件和程度调整不省略检查",
              },
              ...(missingFoundations.length ? { missingFoundations } : {}),
              taughtConcepts: state.taughtConcepts
                .slice(-20)
                .map((c) => c.name),
              ...(previous
                ? {
                    previous: {
                      title: previous.title.slice(0, 80),
                      question: previous.question,
                      terms: [],
                      nextQuestion: "",
                      sections: previous.sections.map((s) => ({
                        ...s,
                        title: s.title.slice(0, 50),
                        text: s.text,
                      })),
                    },
                  }
                : {}),
              slideCount: plan.slideCount ?? undefined,
              speechScript: message.speechScript === true,
              contextSummary: this.context(state).summary.slice(
                0,
                previous ? 400 : 1200,
              ),
              openQuestions: state.openQuestions.slice(-5),
              conversationId: state.id,
              turnId: turn.id,
              groupId,
              ...(visibleImage ? { visibleImage } : {}),
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
        let deckVersionId: string | undefined;
        if (plan.modules.includes("ppt") && run.deck && this.decks) {
          const version = await this.decks.seed(state.id, paper.id, run);
          deckVersionId = version.id;
          state.latestDeckVersionId = version.id;
        }
        if (
          plan.modules.includes("ppt") &&
          run.deck &&
          !run.review?.issues.some(
            (i) => !i.resolved && i.severity === "blocking",
          )
        ) {
          const id = randomUUID();
          const finalPaper = { ...paper, sources: materialSources(run, paper) };
          if (!run.result) throw new Error("讲解尚未完成核对。");
          validateRunSurface(run, run.result, run.deck, finalPaper.sources);
          await this.exporter(
            run.deck,
            binding
              ? finalPaper
              : {
                  ...finalPaper,
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
            sourceHash: run.materials?.at(-1)?.hash ?? digest(paper.sources),
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
          ...(run.materialRequests
            ?.filter((r) => r.status !== "resolved")
            .map((r) => ({
              id: r.id,
              question: r.question,
              sourceIds: r.matchedIds,
            })) ?? []),
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
          ...(deckVersionId ? { deckVersionId } : {}),
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
      await this.commitExecution(state);
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
      if (this.attachments && turn.message.attachmentIds?.length)
        turn.attachments = turn.message.attachmentIds.map((id) =>
          this.attachments!.get(id, turn.conversationId),
        );
      turn.status = signal.aborted ? "cancelled" : "failed";
      turn.error = error instanceof Error ? error.message : "请求失败";
      turn.reply = undefined;
      const current = this.conversations.get(turn.conversationId);
      current.taskGroups = current.taskGroups.map((g) =>
        g.id.startsWith(turn.id) ? { ...g, status: turn.status } : g,
      );
      try {
        await this.commitExecution(current);
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
      this.activeIds.delete(turn.id);
    }
  }
  private commitExecution(state: ConversationState) {
    return this.conversations.update(state.id, (current) => ({
      ...state,
      version: current.version,
      recentTurnIds: current.recentTurnIds,
      mainChat: current.mainChat,
      title: current.title,
      titleEdited: current.titleEdited,
      ...(current.preferenceRevision !== state.preferenceRevision
        ? {
            profileId: current.profileId,
            explanationDepth: current.explanationDepth,
            learningPreferences: current.learningPreferences,
            preferenceRevision: current.preferenceRevision,
          }
        : {}),
    }));
  }
  private context(state: ConversationState) {
    const feedback = (state.learningRecords ?? [])
      .filter(
        (r) =>
          r.paperId === state.paperId &&
          (!r.unitId ||
            this.manager.runs.get(r.unitId)?.sourceVersion ===
              state.sourceVersion),
      )
      .filter(
        (r) => r.kind === "feedback" || (r.kind === "question" && !r.resolved),
      )
      .slice(-5)
      .map(
        (r) =>
          `${r.kind === "feedback" ? "用户主动反馈（非能力评估）" : "用户待解决问题"}：${r.feedback ?? ""} ${r.text.slice(0, 100)}`,
      )
      .join("\n");
    return {
      summary: [
        feedback,
        state.summaries
          .slice(-2)
          .map((s) => s.text)
          .join("\n"),
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1200),
      taughtConcepts: state.taughtConcepts.slice(-20),
      openQuestions: state.openQuestions.slice(-5),
    };
  }
}
