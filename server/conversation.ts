import { randomUUID } from "node:crypto";
import type { ConversationState } from "../shared/types.ts";
import { save, list } from "./storage.ts";
export class ConversationStore {
  states = new Map<string, ConversationState>();
  private writing = new Set<string>();
  constructor(private persist: typeof save = save) {}
  async restore() {
    for (const state of await list<ConversationState>("conversations"))
      this.states.set(state.id, state);
  }
  async create(
    input: { paperId?: string | null; profileId?: string; goal?: string } = {},
    id: string = randomUUID(),
  ) {
    const state: ConversationState = {
      id,
      version: 0,
      paperId: input.paperId ?? null,
      sourceVersion: null,
      goal: input.goal ?? "",
      profileId: input.profileId ?? "beginner",
      taughtConcepts: [],
      userProgress: [],
      openQuestions: [],
      taskGroups: [],
      artifacts: [],
      recentTurnIds: [],
      summaries: [],
    };
    await this.persist("conversations", state.id, state);
    this.states.set(state.id, state);
    return state;
  }
  get(id: string) {
    const state = this.states.get(id);
    if (!state) throw new Error("会话不存在");
    return structuredClone(state);
  }
  async put(state: ConversationState, expectedVersion: number) {
    if (this.writing.has(state.id))
      throw new Error("会话正在保存，请重新读取后重试。");
    if (this.states.get(state.id)?.version !== expectedVersion)
      throw new Error("会话版本发生变化，请重新读取。");
    const next = { ...structuredClone(state), version: expectedVersion + 1 };
    this.writing.add(state.id);
    try {
      await this.persist("conversations", next.id, next);
      this.states.set(state.id, next);
    } finally {
      this.writing.delete(state.id);
    }
    return next;
  }
}
