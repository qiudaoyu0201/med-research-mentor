import { randomUUID } from "node:crypto";
import type {
  ConversationState,
  LearningRecord,
  TaskRun,
} from "../shared/types.ts";
import { ConversationStore } from "./conversation.ts";
type Feedback = NonNullable<LearningRecord["feedback"]>;
export class LearningRecords {
  constructor(
    private conversations: ConversationStore,
    private runById: (id: string) => TaskRun | undefined,
  ) {}
  private state(id: string, version: number) {
    const state = this.conversations.get(id);
    if (state.version !== version)
      throw new Error("会话版本发生变化，请重新读取。");
    state.learningRecords ??= [];
    return state;
  }
  private async store(state: ConversationState, before: LearningRecord[]) {
    const records = state.learningRecords!;
    const ownedFeedback = new Set(
      [...before, ...records]
        .filter((r) => r.kind === "feedback")
        .map((r) => r.unitId),
    );
    state.userProgress = [
      ...state.userProgress.filter((p) => !ownedFeedback.has(p.unitId)),
      ...records
        .filter((r) => r.kind === "feedback" && r.unitId && r.feedback)
        .map((r) => ({ unitId: r.unitId!, state: r.feedback! })),
    ];
    return this.conversations.put(state, state.version);
  }
  async create(
    id: string,
    version: number,
    input: {
      kind: LearningRecord["kind"];
      unitId?: string;
      sectionIndex?: number;
      text?: string;
      feedback?: Feedback;
    },
  ) {
    const state = this.state(id, version);
    const before = structuredClone(state.learningRecords!);
    if (input.sectionIndex !== undefined && !input.unitId)
      throw new Error("关联段落需要实际讲解编号。");
    let sourceText: string | undefined;
    let recordPaperId = state.paperId;
    if (input.unitId) {
      const run = this.runById(input.unitId);
      if (
        !run ||
        run.status !== "completed" ||
        !run.result ||
        run.input.conversationId !== state.id
      )
        throw new Error("记录只能关联本会话实际交付的讲解。");
      if (
        input.sectionIndex !== undefined &&
        !run.result.sections[input.sectionIndex]
      )
        throw new Error("收藏段落不存在。");
      recordPaperId =
        run.input.paperId === "foundation-only" ? null : run.input.paperId;
      sourceText =
        input.sectionIndex !== undefined
          ? run.result.sections[input.sectionIndex].text
          : run.result.title;
    } else if (input.kind !== "question")
      throw new Error("收藏与理解反馈需要关联实际讲解。");
    if (input.kind === "feedback" && !input.feedback)
      throw new Error("请明确选择你的反馈。");
    if (input.kind !== "feedback" && input.feedback)
      throw new Error("收藏和问题不能被自动转成理解反馈。");
    if (
      input.kind === "favorite" &&
      state.learningRecords!.some(
        (r) =>
          r.kind === "favorite" &&
          r.unitId === input.unitId &&
          r.sectionIndex === input.sectionIndex,
      )
    )
      return state;
    const existing =
      input.kind === "feedback"
        ? state.learningRecords!.find(
            (r) => r.kind === "feedback" && r.unitId === input.unitId,
          )
        : undefined;
    if (existing)
      return this.edit(id, version, existing.id, existing.version, {
        text: input.text ?? existing.text,
        feedback: input.feedback,
      });
    if (state.learningRecords!.length >= 300)
      throw new Error("学习记录已达 300 条，请整理或删除后再保存。");
    const text = input.text ?? sourceText ?? "";
    if (!text.trim() || text.length > 4000)
      throw new Error("学习记录需要 1 至 4000 字的具体内容。");
    const now = new Date().toISOString();
    const record: LearningRecord = {
      id: randomUUID(),
      version: 0,
      kind: input.kind,
      paperId: recordPaperId,
      ...(input.unitId ? { unitId: input.unitId } : {}),
      ...(input.sectionIndex !== undefined
        ? { sectionIndex: input.sectionIndex }
        : {}),
      ...(sourceText ? { sourceText } : {}),
      text,
      ...(input.feedback ? { feedback: input.feedback } : {}),
      resolved: false,
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    state.learningRecords!.push(record);
    return this.store(state, before);
  }
  async edit(
    id: string,
    version: number,
    recordId: string,
    recordVersion: number,
    patch: { text?: string; feedback?: Feedback; resolved?: boolean },
  ) {
    const state = this.state(id, version),
      before = structuredClone(state.learningRecords!);
    const record = state.learningRecords!.find((r) => r.id === recordId);
    if (!record || record.version !== recordVersion)
      throw new Error("记录版本已变化或不存在，请重新读取。");
    if (patch.feedback && record.kind !== "feedback")
      throw new Error("只有主动理解反馈可以修改反馈状态。");
    if (patch.resolved !== undefined && record.kind !== "question")
      throw new Error("只有待解决问题可以主动标记解决。");
    if (
      patch.text !== undefined &&
      (!patch.text.trim() || patch.text.length > 4000)
    )
      throw new Error("记录内容需要 1 至 4000 字。");
    if (
      (patch.text === undefined || patch.text === record.text) &&
      (patch.feedback === undefined || patch.feedback === record.feedback) &&
      (patch.resolved === undefined || patch.resolved === record.resolved)
    )
      return state;
    record.history = [
      ...record.history,
      {
        text: record.text,
        feedback: record.feedback,
        resolved: record.resolved,
      },
    ].slice(-20);
    record.text = patch.text ?? record.text;
    record.feedback = patch.feedback ?? record.feedback;
    record.resolved = patch.resolved ?? record.resolved;
    record.version++;
    record.updatedAt = new Date().toISOString();
    return this.store(state, before);
  }
  async undo(
    id: string,
    version: number,
    recordId: string,
    recordVersion: number,
  ) {
    const state = this.state(id, version),
      before = structuredClone(state.learningRecords!);
    const record = state.learningRecords!.find((r) => r.id === recordId);
    if (!record || record.version !== recordVersion)
      throw new Error("记录版本已变化或不存在。");
    const previous = record.history.pop();
    if (!previous) throw new Error("没有可撤销的编辑。");
    record.text = previous.text;
    record.feedback = previous.feedback;
    record.resolved = previous.resolved;
    record.version++;
    record.updatedAt = new Date().toISOString();
    return this.store(state, before);
  }
  async delete(
    id: string,
    version: number,
    recordId: string,
    recordVersion: number,
  ) {
    const state = this.state(id, version),
      before = structuredClone(state.learningRecords!);
    const record = state.learningRecords!.find((r) => r.id === recordId);
    if (!record || record.version !== recordVersion)
      throw new Error("记录版本已变化或不存在。");
    state.learningRecords = state.learningRecords!.filter(
      (r) => r.id !== recordId,
    );
    return this.store(state, before);
  }
}
