import { randomUUID } from "node:crypto";
import type {
  ConversationState,
  LearningPreferences,
} from "../shared/types.ts";
import { save, list } from "./storage.ts";
export class ConversationStore {
  states = new Map<string, ConversationState>();
  private writing = new Set<string>();
  private updates = new Map<string, Promise<unknown>>();
  private mainPending = new Map<string, Promise<ConversationState>>();
  constructor(
    private persist: typeof save = save,
    private defaults: () => LearningPreferences | undefined = () => undefined,
  ) {}
  async restore(loader: typeof list = list) {
    for (const state of await loader<ConversationState>("conversations"))
      this.states.set(state.id, state);
  }
  async create(
    input: {
      paperId?: string | null;
      projectId?: string | null;
      profileId?: string;
      goal?: string;
      purpose?: "reading" | "ppt-generation";
    } = {},
    id: string = randomUUID(),
  ) {
    const preferences = this.defaults();
    const state: ConversationState = {
      id,
      purpose: input.purpose,
      version: 0,
      projectId: input.projectId ?? null,
      title: "新讨论",
      titleEdited: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      paperId: input.paperId ?? null,
      sourceVersion: null,
      goal: input.goal ?? "",
      profileId: input.profileId ?? "beginner",
      taughtConcepts: [],
      userProgress: [],
      learningRecords: [],
      openQuestions: [],
      taskGroups: [],
      artifacts: [],
      recentTurnIds: [],
      summaries: [],
      ...(preferences
        ? { learningPreferences: structuredClone(preferences) }
        : {}),
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
  mainForPaper(paperId: string, projectId: string | null = null) {
    const pending = this.mainPending.get(paperId);
    if (pending) return pending;
    const operation = (async () => {
      const existing = [...this.states.values()]
        .filter((s) => s.paperId === paperId && s.purpose !== "ppt-generation")
        .sort(
          (a, b) =>
            Number(Boolean(b.mainChat)) - Number(Boolean(a.mainChat)) ||
            (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
        )[0];
      const state = existing ?? (await this.create({ paperId, projectId }));
      return state.mainChat
        ? this.get(state.id)
        : this.update(state.id, (next) => {
            next.mainChat = true;
            return next;
          });
    })();
    this.mainPending.set(paperId, operation);
    void operation
      .finally(() => this.mainPending.delete(paperId))
      .catch(() => {});
    return operation;
  }
  update(id: string, apply: (state: ConversationState) => ConversationState) {
    const operation = (this.updates.get(id) ?? Promise.resolve()).then(() => {
      const current = this.get(id);
      return this.put(apply(current), current.version);
    });
    this.updates.set(
      id,
      operation.catch(() => {}),
    );
    return operation;
  }
  async put(state: ConversationState, expectedVersion: number) {
    if (this.writing.has(state.id))
      throw new Error("会话正在保存，请重新读取后重试。");
    if (this.states.get(state.id)?.version !== expectedVersion)
      throw new Error("会话版本发生变化，请重新读取。");
    const next = {
      ...structuredClone(state),
      version: expectedVersion + 1,
      updatedAt: new Date(
        Math.max(
          Date.now(),
          Date.parse(this.states.get(state.id)?.updatedAt ?? "1970-01-01") + 1,
        ),
      ).toISOString(),
    };
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
