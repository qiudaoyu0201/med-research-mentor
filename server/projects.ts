import { randomUUID } from "node:crypto";
import type { PaperBundle, ConversationState } from "../shared/types.ts";
import type {
  Project,
  WorkspaceIndex,
  PaperMetadata,
  ReadingPosition,
  ResearchNote,
  ResearchTurn,
} from "../shared/workspace.ts";
import { read, save } from "./storage.ts";

export class Projects {
  private index: WorkspaceIndex = {
    projects: [],
    papers: [],
    notes: [],
    positions: [],
  };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private persist: typeof save = save) {}
  async restore(loader: typeof read = read) {
    try {
      this.index = await loader<WorkspaceIndex>("workspace", "index");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  snapshot() {
    return structuredClone(this.index);
  }
  private change<T>(apply: (index: WorkspaceIndex) => T) {
    const operation = this.queue.then(async () => {
      const next = this.snapshot();
      const result = apply(next);
      await this.persist("workspace", "index", next);
      this.index = next;
      return structuredClone(result);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  project(id: string, index = this.index) {
    const project = index.projects.find((p) => p.id === id);
    if (!project || project.archived)
      throw new Error("课题不存在或已归档，请选择其他课题。");
    return project;
  }
  create(name: string, goal?: string) {
    return this.change((index) => {
      const now = new Date().toISOString();
      const project: Project = {
        id: randomUUID(),
        name,
        goal,
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      index.projects.push(project);
      return project;
    });
  }
  edit(
    id: string,
    patch: { name?: string; goal?: string; archived?: boolean },
  ) {
    return this.change((index) => {
      const project = index.projects.find((p) => p.id === id);
      if (!project) throw new Error("课题不存在。");
      Object.assign(project, patch, { updatedAt: new Date().toISOString() });
      return project;
    });
  }
  paper(
    paperId: string,
    patch: Partial<Pick<PaperMetadata, "projectId" | "displayName">>,
  ) {
    return this.change((index) => {
      if (patch.projectId) this.project(patch.projectId, index);
      let metadata = index.papers.find((p) => p.paperId === paperId);
      if (!metadata) {
        metadata = { paperId, projectId: null };
        index.papers.push(metadata);
      }
      Object.assign(metadata, patch);
      return metadata;
    });
  }
  position(
    state: ConversationState,
    paper: PaperBundle | undefined,
    position: ReadingPosition,
  ) {
    return this.change((index) => {
      if (
        position.paperId !== state.paperId ||
        position.conversationId !== state.id
      )
        throw new Error("阅读位置与讨论不匹配。");
      if (
        position.sourceId &&
        (!paper ||
          position.sourceVersion !== paper.version ||
          !paper.sources.some((s) => s.id === position.sourceId))
      )
        throw new Error("阅读位置已过期，请重新打开原文。");
      index.positions = index.positions.filter(
        (p) => p.conversationId !== state.id,
      );
      index.positions.push(position);
      index.lastConversationId = state.id;
      index.currentPaperId = state.paperId;
      index.currentProjectId = state.projectId ?? null;
      return position;
    });
  }
  context(paperId: string | null, projectId: string | null) {
    return this.change((index) => {
      if (projectId) this.project(projectId, index);
      index.currentPaperId = paperId;
      index.currentProjectId = projectId;
      index.lastConversationId = undefined;
      return { paperId, projectId };
    });
  }
  saveAnswer(
    state: ConversationState,
    turn: ResearchTurn,
    paper?: PaperBundle,
  ) {
    return this.change((index) => {
      if (
        turn.conversationId !== state.id ||
        turn.status !== "completed" ||
        !turn.reply?.content ||
        !turn.run ||
        turn.run.status !== "completed" ||
        turn.run.input.paperId !== (state.paperId ?? "foundation-only")
      )
        throw new Error("只能保存此讨论中已经完成的回答。");
      const existing = index.notes.find(
        (n) => n.conversationId === state.id && n.turnId === turn.id,
      );
      if (existing) return existing;
      const content = turn.reply.content;
      const sources =
        turn.run.materials?.at(-1)?.sources ?? paper?.sources ?? [];
      const anchors = [
        ...new Set(content.sections.flatMap((s) => s.citations)),
      ].flatMap((id) => {
        const source = sources.find((s) => s.id === id && s.kind === "paper");
        return source && state.paperId
          ? [
              {
                paperId: state.paperId,
                sourceVersion: turn.run!.sourceVersion!,
                sourceId: id,
                excerpt: source.text.slice(0, 2000),
                page: source.page,
              },
            ]
          : [];
      });
      const now = new Date().toISOString();
      const note: ResearchNote = {
        id: randomUUID(),
        conversationId: state.id,
        turnId: turn.id,
        paperId: state.paperId,
        title: content.title,
        text: content.sections.map((s) => `${s.title}\n${s.text}`).join("\n\n"),
        anchors,
        evidence: [
          ...new Set(content.sections.flatMap((s) => s.citations)),
        ].flatMap((id) => {
          const source = sources.find((s) => s.id === id);
          if (!source) return [];
          const { image: _image, ...textual } = source;
          return [textual];
        }),
        createdAt: now,
        updatedAt: now,
      };
      index.notes.push(note);
      return note;
    });
  }
  editNote(
    id: string,
    patch: { title: string; text: string; updatedAt: string },
  ) {
    return this.change((index) => {
      const note = index.notes.find((n) => n.id === id);
      if (!note) throw new Error("笔记不存在。");
      if (note.updatedAt !== patch.updatedAt)
        throw new Error("笔记已更新，请重新读取后再编辑。");
      note.title = patch.title;
      note.text = patch.text;
      note.updatedAt = new Date(
        Math.max(Date.now(), Date.parse(note.updatedAt) + 1),
      ).toISOString();
      return note;
    });
  }
  createNote(
    state: ConversationState,
    input: { id: string; title: string; text: string },
  ) {
    return this.change((index) => {
      const existing = index.notes.find((note) => note.id === input.id);
      if (existing) {
        if (
          existing.conversationId !== state.id ||
          existing.title !== input.title ||
          existing.text !== input.text
        )
          throw new Error("此笔记已保存，内容有变化时请编辑已保存笔记。");
        return existing;
      }
      const now = new Date().toISOString();
      const note: ResearchNote = {
        ...input,
        conversationId: state.id,
        paperId: state.paperId,
        anchors: [],
        createdAt: now,
        updatedAt: now,
      };
      index.notes.push(note);
      return note;
    });
  }
  validatePosition(position: ReadingPosition, paper?: PaperBundle) {
    if (!position.sourceId) return position;
    const source = paper?.sources.find((s) => s.id === position.sourceId);
    if (source && paper?.version === position.sourceVersion) return position;
    return { ...position, sourceId: undefined, sourceVersion: paper?.version };
  }
}
