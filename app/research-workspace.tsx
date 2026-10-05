import { useEffect, useRef, useState } from "react";
import type {
  ConversationState,
  PaperBundle,
  Source,
} from "../shared/types.ts";
import { paperName } from "../shared/workspace.ts";
import type {
  Project,
  ReadingStart,
  ResearchNote,
  ResearchTurn,
  WorkspaceBootstrap,
  WorkspaceIndex,
} from "../shared/workspace.ts";
import { importPaper, researchApi } from "./research-api.ts";
import { ResearchNavigation } from "./research-navigation.tsx";
import {
  ResearchDiscussion,
  finished,
  statusLabel,
} from "./research-discussion.tsx";
import type { ResearchSelection } from "./research-discussion.tsx";
import { ResearchReading } from "./research-reading.tsx";
import "./reading-prototype.css";
import "./research-workspace.css";

type Management = {
  kind: "create" | "project" | "paper" | "discussion";
  id?: string;
  name: string;
  projectId?: string | null;
  archived?: boolean;
};
const emptyIndex: WorkspaceIndex = {
  projects: [],
  papers: [],
  notes: [],
  positions: [],
};
function titleOf(c: ConversationState) {
  return c.title || c.goal || "新讨论";
}

export function ResearchWorkspace() {
  const [index, setIndex] = useState<WorkspaceIndex>(emptyIndex);
  const [papers, setPapers] = useState<PaperBundle[]>([]);
  const [conversations, setConversations] = useState<ConversationState[]>([]);
  const [conversation, setConversation] = useState<ConversationState>();
  const [turns, setTurns] = useState<ResearchTurn[]>([]);
  const [paper, setPaper] = useState<PaperBundle>();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [start, setStart] = useState<ReadingStart>();
  const [panel, setPanel] = useState<"sources" | "notes" | null>(null);
  const [sourceId, setSourceId] = useState<string>();
  const [extraSource, setExtraSource] = useState<Source>();
  const [question, setQuestion] = useState("");
  const [selection, setSelection] = useState<ResearchSelection>();
  const [search, setSearch] = useState("");
  const [mobile, setMobile] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [management, setManagement] = useState<Management>();
  const fileInput = useRef<HTMLInputElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    revision = useRef(0),
    actionLock = useRef(false);
  const dragDepth = useRef(0),
    retry = useRef<
      | {
          question: string;
          selection?: ResearchSelection;
          clientMessageId: string;
          conversationId: string;
        }
      | undefined
    >(undefined);
  const draftKey = `research-draft:${paper?.id ?? projectId ?? "idea"}`;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const active = turns.find((t) => !finished(t));
  const busy = loading || working || uploading;
  const historical = !!paper && !!conversation && !conversation.mainChat;
  const importRetry = useRef<{ file: File; id: string } | undefined>(undefined);
  const recent = [...conversations]
    .filter((c) => c.recentTurnIds.length)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
  const currentName = paper
    ? paperName(paper, index)
    : (index.projects.find((p) => p.id === projectId)?.name ?? "研究想法");
  const notes = index.notes.filter((n) =>
    paper ? n.paperId === paper.id : n.conversationId === conversation?.id,
  );

  async function refresh() {
    const value = await researchApi<WorkspaceBootstrap>("/api/workspace");
    setIndex(value.index);
    setPapers(value.papers);
    setConversations(value.conversations);
    return value;
  }
  async function openConversation(id: string, supplied?: WorkspaceBootstrap) {
    const token = ++revision.current;
    setLoading(true);
    setError("");
    retry.current = undefined;
    try {
      const [value, state, history] = await Promise.all([
        supplied
          ? Promise.resolve(supplied)
          : researchApi<WorkspaceBootstrap>("/api/workspace"),
        researchApi<ConversationState>(`/api/conversations/${id}`),
        researchApi<ResearchTurn[]>(`/api/conversations/${id}/turns`),
      ]);
      if (token !== revision.current) return;
      const bound = value.papers.find((p) => p.id === state.paperId);
      if (state.paperId && !bound)
        throw new Error("这段讨论的论文材料不可用，请重新提供材料。");
      const owner =
        value.index.papers.find((p) => p.paperId === state.paperId)
          ?.projectId ??
        state.projectId ??
        null;
      const position = value.index.positions.find(
        (p) => p.conversationId === id && p.paperId === state.paperId,
      );
      setIndex(value.index);
      setPapers(value.papers);
      setConversations(value.conversations);
      setConversation(state);
      setTurns(history);
      setPaper(bound);
      setProjectId(owner);
      setPanel(position?.panel ?? null);
      setSourceId(position?.sourceId);
      setExtraSource(undefined);
      try {
        const key = `research-draft:${bound?.id ?? owner ?? "idea"}:selection`;
        const stored = localStorage.getItem(key);
        setSelection(stored ? JSON.parse(stored) : undefined);
      } catch {
        setSelection(undefined);
      }
      setStart(undefined);
      retry.current = undefined;
      setMobile(false);
      if (bound) {
        const nextStart = await researchApi<ReadingStart>(
          `/api/papers/${bound.id}/start`,
        );
        if (token === revision.current) setStart(nextStart);
      }
    } catch (err) {
      if (token === revision.current) setError((err as Error).message);
    } finally {
      if (token === revision.current) setLoading(false);
    }
  }
  useEffect(() => {
    let closed = false;
    void refresh()
      .then(async (value) => {
        if (closed) return;
        if (
          value.index.lastConversationId &&
          value.conversations.some(
            (c) => c.id === value.index.lastConversationId,
          )
        )
          await openConversation(value.index.lastConversationId, value);
        else {
          const bound = value.papers.find(
            (p) => p.id === value.index.currentPaperId,
          );
          setPaper(bound);
          const owner =
            value.index.papers.find((m) => m.paperId === bound?.id)
              ?.projectId ??
            value.index.currentProjectId ??
            null;
          setProjectId(
            value.index.projects.some((p) => p.id === owner && !p.archived)
              ? owner
              : null,
          );
          if (bound) {
            const main = await researchApi<ConversationState>(
              `/api/papers/${bound.id}/chat`,
              {},
            );
            if (!closed) await openConversation(main.id);
          }
        }
      })
      .catch((err) => {
        if (!closed) setError(err.message);
      })
      .finally(() => {
        if (!closed) setLoading(false);
      });
    return () => {
      closed = true;
      revision.current++;
    };
  }, []);
  useEffect(() => {
    try {
      setQuestion(localStorage.getItem(draftKey) || "");
      const stored = localStorage.getItem(`${draftKey}:selection`);
      setSelection(stored ? JSON.parse(stored) : undefined);
    } catch {
      setQuestion("");
      setSelection(undefined);
    }
  }, [draftKey]);
  function draft(text: string) {
    setQuestion(text);
    try {
      localStorage.setItem(draftKeyRef.current, text);
    } catch {
      setNotice("浏览器无法保存草稿，请复制重要内容。");
    }
    retry.current = undefined;
  }
  useEffect(() => {
    if (loading || uploading) return;
    if (!conversation) {
      const owner = index.projects.some(
        (p) => p.id === projectId && !p.archived,
      )
        ? projectId
        : null;
      void researchApi(
        "/api/workspace/context",
        { paperId: paper?.id ?? null, projectId: owner },
        "PUT",
        true,
      ).catch((err) => setError(err.message));
      return;
    }
    const position = {
      conversationId: conversation.id,
      paperId: conversation.paperId,
      panel,
      ...(paper ? { sourceVersion: paper.version } : {}),
      ...(sourceId && paper?.sources.some((s) => s.id === sourceId)
        ? { sourceId }
        : {}),
    };
    void researchApi("/api/workspace/position", position, "PUT", true)
      .then(() => {
        setIndex((prev) => ({
          ...prev,
          lastConversationId: conversation.id,
          positions: [
            ...prev.positions.filter(
              (p) => p.conversationId !== conversation.id,
            ),
            position,
          ],
        }));
      })
      .catch((err) => setError(err.message));
  }, [
    conversation?.id,
    panel,
    sourceId,
    paper?.id,
    paper?.version,
    projectId,
    loading,
    uploading,
  ]);
  useEffect(() => {
    if (!conversation) return;
    const id = conversation.id;
    const token = revision.current;
    let stopped = false,
      polling = false;
    const tick = async () => {
      if (polling) return;
      polling = true;
      try {
        const [history, state, workspace] = await Promise.all([
          researchApi<ResearchTurn[]>(`/api/conversations/${id}/turns`),
          researchApi<ConversationState>(`/api/conversations/${id}`),
          researchApi<WorkspaceBootstrap>("/api/workspace"),
        ]);
        if (stopped || token !== revision.current) return;
        setTurns(history);
        setConversation(state);
        setIndex(workspace.index);
        setConversations(workspace.conversations);
        setPapers(workspace.papers);
      } catch (err) {
        if (!stopped) setError((err as Error).message);
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void tick(), 900);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [conversation?.id]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPanel(null);
        setMobile(false);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  useEffect(() => {
    if (management) dialog.current?.showModal();
  }, [!!management]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function action(task: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setWorking(true);
    setError("");
    try {
      await task();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      actionLock.current = false;
      setWorking(false);
    }
  }
  function blank(owner: string | null = null, bound?: PaperBundle) {
    ++revision.current;
    setConversation(undefined);
    setTurns([]);
    setPaper(bound);
    setProjectId(owner);
    setPanel(null);
    setSourceId(undefined);
    setExtraSource(undefined);
    setSelection(undefined);
    setStart(undefined);
    setError("");
    setMobile(false);
    retry.current = undefined;
  }
  async function selectPaper(bound: PaperBundle) {
    const token = ++revision.current;
    setLoading(true);
    try {
      const main = await researchApi<ConversationState>(
        `/api/papers/${bound.id}/chat`,
        {},
      );
      if (token === revision.current) await openConversation(main.id);
    } catch (err) {
      if (token === revision.current) {
        setError((err as Error).message);
        setLoading(false);
      }
    }
  }
  async function upload(files: File[]) {
    if (busy || actionLock.current) return;
    actionLock.current = true;
    const token = revision.current;
    setUploading(true);
    setError("");
    const owner = index.projects.some((p) => p.id === projectId && !p.archived)
      ? projectId
      : null;
    try {
      if (
        files.length === 1 &&
        (!importRetry.current ||
          importRetry.current.file.name !== files[0].name ||
          importRetry.current.file.size !== files[0].size ||
          importRetry.current.file.lastModified !== files[0].lastModified)
      )
        importRetry.current = { file: files[0], id: crypto.randomUUID() };
      const result = await importPaper(files, importRetry.current?.id);
      importRetry.current = undefined;
      await researchApi(
        `/api/papers/${result.paper.id}/metadata`,
        { projectId: owner },
        "PATCH",
      );
      await refresh();
      if (token === revision.current) await selectPaper(result.paper);
      if (result.error) setError(result.error);
      else
        setNotice(
          result.paper.parseStatus === "needs-text"
            ? "文件已保留，需补充可读取正文。"
            : "论文已导入，可以从一个问题开始。",
        );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      actionLock.current = false;
      setUploading(false);
    }
  }
  function suggest(text: string) {
    draft(text);
    composer.current?.focus();
  }
  function focus(next: ResearchSelection, text: string) {
    setSelection(next);
    try {
      localStorage.setItem(
        `${draftKeyRef.current}:selection`,
        JSON.stringify(next),
      );
    } catch {}
    suggest(text);
  }
  function citation(id: string, source?: Source) {
    setSourceId(id);
    setExtraSource(source);
    setPanel("sources");
  }
  async function send() {
    if (busy || historical || !question.trim() || actionLock.current) return;
    const token = revision.current;
    const submittedDraftKey = draftKeyRef.current;
    await action(async () => {
      let state = conversation;
      if (!state) {
        state = await researchApi<ConversationState>("/api/conversations", {
          paperId: paper?.id ?? null,
          projectId: index.projects.some(
            (p) => p.id === projectId && !p.archived,
          )
            ? projectId
            : null,
        });
        if (token === revision.current) {
          setConversation(state);
          setConversations((prev) => [...prev, state!]);
        }
      }
      const pending =
        retry.current?.conversationId === state.id
          ? retry.current
          : {
              question: question.trim(),
              selection,
              clientMessageId: crypto.randomUUID(),
              conversationId: state.id,
            };
      retry.current = pending;
      const value = await researchApi<ResearchTurn>(
        `/api/conversations/${state.id}/messages`,
        {
          question: pending.question,
          clientMessageId: pending.clientMessageId,
          mode: "live",
          paperId: paper?.id ?? null,
          ...(pending.selection?.sourceAnchor
            ? { sourceAnchor: pending.selection.sourceAnchor }
            : {}),
          ...(pending.selection?.focus
            ? { focus: pending.selection.focus }
            : {}),
          ...(pending.selection?.figureSourceId
            ? { figureSourceId: pending.selection.figureSourceId }
            : {}),
        },
      );
      let clearDraft =
        token === revision.current && composer.current?.value === question;
      try {
        clearDraft = localStorage.getItem(submittedDraftKey) === question;
        if (clearDraft) {
          localStorage.setItem(submittedDraftKey, "");
          localStorage.removeItem(`${submittedDraftKey}:selection`);
        }
      } catch {}
      if (token !== revision.current) return;
      setTurns((prev) =>
        prev.some((t) => t.id === value.id) ? prev : [...prev, value],
      );
      if (clearDraft) {
        draft("");
        setSelection(undefined);
      }
      if (finished(value)) {
        const fresh = await researchApi<ConversationState>(
          `/api/conversations/${state.id}`,
        );
        if (token === revision.current) setConversation(fresh);
      }
    });
  }
  async function saveManagement() {
    if (!management?.name.trim()) return;
    await action(async () => {
      const { kind, id, name } = management;
      if (kind === "create") {
        const project = await researchApi<Project>("/api/projects", { name });
        blank(project.id);
      } else if (kind === "project")
        await researchApi(`/api/projects/${id}`, { name }, "PATCH");
      else if (kind === "paper") {
        await researchApi(
          `/api/papers/${id}/metadata`,
          { displayName: name, projectId: management.projectId ?? null },
          "PATCH",
        );
        setProjectId(management.projectId ?? null);
      } else if (conversation) {
        const fresh = await researchApi<ConversationState>(
          `/api/conversations/${conversation.id}`,
        );
        setConversation(
          await researchApi<ConversationState>(
            `/api/conversations/${conversation.id}/title`,
            { title: name, version: fresh.version },
            "PATCH",
          ),
        );
      }
      await refresh();
      setManagement(undefined);
      setNotice("已保存名称与归属。");
    });
  }
  const latestReply = [...turns]
    .reverse()
    .find((t) => t.status === "completed" && t.reply?.content);
  const archived = index.projects.filter((p) => p.archived);
  return (
    <div
      className="rp rw"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void upload([...e.dataTransfer.files]);
      }}
    >
      <ResearchNavigation
        index={index}
        papers={papers}
        conversations={conversations}
        paperId={paper?.id}
        projectId={projectId}
        busy={false}
        search={search}
        setSearch={setSearch}
        onPaper={(p) => void selectPaper(p)}
        onProject={(id) => blank(id)}
        onHome={() => blank()}
        onImport={() => fileInput.current?.click()}
        onCreateProject={() => setManagement({ kind: "create", name: "" })}
        onEditProject={(id) => {
          const p = index.projects.find((p) => p.id === id)!;
          setManagement({
            kind: "project",
            id,
            name: p.name,
            archived: p.archived,
          });
        }}
        onResume={(id) => void openConversation(id)}
        mobile={mobile}
        close={() => setMobile(false)}
      />
      <main className="rw-main">
        <header className="rp-topbar">
          <button
            className="rp-mobile-menu"
            aria-label="打开导航"
            onClick={() => setMobile(true)}
          >
            ☰
          </button>
          <div className="rw-breadcrumb">
            <span>论文研究</span>
            <strong>{currentName}</strong>
          </div>
          <button disabled={busy} onClick={() => fileInput.current?.click()}>
            导入材料
          </button>
          <button onClick={() => setPanel(panel ? null : "sources")}>
            资料与笔记
          </button>
        </header>
        <div className="rw-content">
          <section className="rw-chat">
            <header className="rp-chat-header rw-chat-header">
              <div>
                <small>
                  {paper
                    ? paper.parseStatus === "ready" || !paper.parseStatus
                      ? "论文资料可用"
                      : "需要补充正文"
                    : "无需先创建课题"}
                  {uploading ? " · 正在上传并解析" : ""}
                </small>
                <h1>
                  {conversation &&
                  (conversation.recentTurnIds.length ||
                    conversation.titleEdited)
                    ? titleOf(conversation)
                    : currentName}
                </h1>
              </div>
              <details className="rw-discussion-menu">
                <summary>讨论记录</summary>
                {!paper && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      blank(projectId, paper);
                    }}
                  >
                    开始新讨论
                  </button>
                )}
                {conversations
                  .filter(
                    (c) =>
                      c.paperId === (paper?.id ?? null) &&
                      (paper || (c.projectId ?? null) === projectId),
                  )
                  .sort((a, b) =>
                    (b.updatedAt || "").localeCompare(a.updatedAt || ""),
                  )
                  .map((c) => (
                    <button
                      key={c.id}
                      onClick={() => void openConversation(c.id)}
                    >
                      {titleOf(c)}
                    </button>
                  ))}
              </details>
            </header>
            <div className="rw-toolbar">
              {paper && (
                <button
                  disabled={busy}
                  onClick={() =>
                    setManagement({
                      kind: "paper",
                      id: paper.id,
                      name: currentName,
                      projectId,
                    })
                  }
                >
                  论文名称与归组
                </button>
              )}
              {conversation && (
                <button
                  disabled={busy}
                  onClick={() =>
                    setManagement({
                      kind: "discussion",
                      id: conversation.id,
                      name: titleOf(conversation),
                    })
                  }
                >
                  重命名讨论
                </button>
              )}
              {paper && (
                <details className="rw-route">
                  <summary>阅读路线</summary>
                  {[
                    "这篇论文提出了什么研究问题？",
                    "这篇论文的核心实验怎样设计？",
                    "这篇论文的结果有哪些证据？",
                    "这篇论文有哪些局限，对后续研究有什么启发？",
                  ].map((q) => (
                    <button key={q} disabled={busy} onClick={() => suggest(q)}>
                      {q}
                    </button>
                  ))}
                </details>
              )}
              {!!archived.length && (
                <details className="rw-route">
                  <summary>已归档课题</summary>
                  {archived.map((p) => (
                    <button
                      key={p.id}
                      disabled={busy}
                      onClick={() =>
                        setManagement({
                          kind: "project",
                          id: p.id,
                          name: p.name,
                          archived: true,
                        })
                      }
                    >
                      {p.name}
                    </button>
                  ))}
                </details>
              )}
            </div>
            {loading && (
              <p className="rw-loading" role="status">
                正在恢复资料与讨论…
              </p>
            )}
            <ResearchDiscussion
              turns={turns}
              paper={paper}
              start={start}
              busy={working}
              onCancel={(turn) =>
                void researchApi(`/api/turns/${turn.id}/cancel`, {}).catch(
                  (err) => setError(err.message),
                )
              }
              onRetry={(turn) => {
                draft(turn.message.question);
                const restored = turn.message.sourceAnchor
                  ? {
                      label: "原文引用",
                      sourceAnchor: turn.message.sourceAnchor,
                    }
                  : turn.message.focus
                    ? { label: "回答引用", focus: turn.message.focus }
                    : turn.message.figureSourceId
                      ? {
                          label: "图件引用",
                          figureSourceId: turn.message.figureSourceId,
                        }
                      : undefined;
                setSelection(restored);
                try {
                  if (restored)
                    localStorage.setItem(
                      `${draftKeyRef.current}:selection`,
                      JSON.stringify(restored),
                    );
                  else
                    localStorage.removeItem(`${draftKeyRef.current}:selection`);
                } catch {}
                composer.current?.focus();
              }}
              onSuggest={suggest}
              onImport={() => fileInput.current?.click()}
              onIdea={() => {
                blank(projectId);
                composer.current?.focus();
              }}
              onCitation={citation}
              onFocus={focus}
              onSave={(turn) =>
                void action(async () => {
                  await researchApi("/api/workspace/notes", {
                    conversationId: turn.conversationId,
                    turnId: turn.id,
                  });
                  await refresh();
                  setPanel("notes");
                  setNotice("回答已保存，原讨论与依据已保留。");
                })
              }
              savedIds={index.notes.map((n) => n.turnId)}
              latestTitle={
                !conversation && !paper && recent ? titleOf(recent) : undefined
              }
              onResume={() => recent && void openConversation(recent.id)}
            />
            <div className="rp-composer-area rw-composer-area">
              {error && (
                <div className="rw-error" role="alert">
                  <span>{error}</span>
                  {importRetry.current && (
                    <button
                      disabled={uploading}
                      onClick={() =>
                        importRetry.current &&
                        void upload([importRetry.current.file])
                      }
                    >
                      重试导入
                    </button>
                  )}
                  <button
                    aria-label="关闭错误提示"
                    onClick={() => setError("")}
                  >
                    ×
                  </button>
                </div>
              )}
              {active && (
                <div className="rw-running" role="status">
                  <span>
                    {statusLabel[active.run?.status ?? active.status] ??
                      "处理中"}
                  </span>
                  <button
                    disabled={working}
                    onClick={() =>
                      void action(async () => {
                        await researchApi(`/api/turns/${active.id}/cancel`, {});
                        setNotice("已请求停止，正在保存记录。");
                      })
                    }
                  >
                    停止
                  </button>
                </div>
              )}
              {latestReply && (
                <div className="rp-suggestions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      const unit = latestReply.reply!.content!;
                      const i = unit.sections.length - 1;
                      const section = unit.sections[i];
                      focus(
                        {
                          label: `回答「${section.title}」`,
                          focus: {
                            runId: latestReply.runId!,
                            sectionIndex: i,
                            excerpt: section.text.slice(0, 2000),
                          },
                        },
                        "把这段讲得更通俗一些。",
                      );
                    }}
                  >
                    讲得更通俗
                  </button>
                  {!!latestReply.reply?.content?.sections.some(
                    (s) => s.citations.length,
                  ) && (
                    <button
                      onClick={() => {
                        const id = latestReply.reply!.content!.sections.flatMap(
                          (s) => s.citations,
                        )[0];
                        citation(
                          id,
                          latestReply.run?.materials
                            ?.at(-1)
                            ?.sources.find((s) => s.id === id),
                        );
                      }}
                    >
                      查看依据
                    </button>
                  )}
                  {latestReply.reply?.nextStep && (
                    <button
                      disabled={busy}
                      title={latestReply.reply.nextStep}
                      onClick={() => suggest(latestReply.reply!.nextStep)}
                    >
                      继续探索
                    </button>
                  )}
                </div>
              )}
              {selection && (
                <div className="rw-reference">
                  <span>正在问：{selection.label}</span>
                  <button
                    aria-label="移除提问引用"
                    onClick={() => {
                      setSelection(undefined);
                      try {
                        localStorage.removeItem(
                          `${draftKeyRef.current}:selection`,
                        );
                      } catch {}
                      retry.current = undefined;
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
              {historical && (
                <p>
                  正在查看历史讨论。
                  <button onClick={() => paper && void selectPaper(paper)}>
                    回到主聊天
                  </button>
                </p>
              )}
              <form
                className="rp-composer rw-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  ref={composer}
                  aria-label="向科研助手提问"
                  placeholder="哪里没读懂？可以用自己的话问。"
                  value={question}
                  maxLength={2000}
                  onChange={(e) => draft(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div>
                  <small>支持 PDF · 图片检查即将接入</small>
                  <button
                    type="submit"
                    className="rp-primary"
                    disabled={busy || historical || !question.trim()}
                  >
                    {working ? "正在提交" : active ? "加入队列 ↑" : "发送 ↑"}
                  </button>
                </div>
              </form>
              <p className="rp-composer-note">
                Enter 发送 · Shift + Enter 换行
              </p>
            </div>
          </section>
          {panel && (
            <ResearchReading
              paper={paper}
              name={currentName}
              panel={panel}
              sourceId={sourceId}
              extraSource={extraSource}
              notes={notes}
              busy={busy}
              onPanel={setPanel}
              onClose={() => setPanel(null)}
              onSource={(id) => citation(id)}
              onFocus={focus}
              onSaveNote={(note: ResearchNote, title, text) =>
                void action(async () => {
                  await researchApi(
                    `/api/workspace/notes/${note.id}`,
                    { title, text, updatedAt: note.updatedAt },
                    "PATCH",
                  );
                  await refresh();
                  setNotice("笔记修改已保存。");
                })
              }
              onReturn={(id) => void openConversation(id)}
            />
          )}
        </div>
      </main>
      {dragging && (
        <div className="rw-drop" role="status">
          <strong>{uploading ? "正在导入论文" : "放下文件，导入论文"}</strong>
          <span>PDF · 每次一个 · 30 MiB 以内</span>
        </div>
      )}
      {!!notice && (
        <div className="rp-toast" role="status">
          <span>{notice}</span>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".pdf,application/pdf"
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void upload([...e.target.files]);
          e.target.value = "";
        }}
      />
      {management && (
        <dialog
          ref={dialog}
          className="rp-settings rw-management"
          onCancel={() => setManagement(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveManagement();
            }}
          >
            <div className="rp-modal-heading">
              <h2>
                {management.kind === "create"
                  ? "新建课题"
                  : management.kind === "paper"
                    ? "论文名称与归组"
                    : management.kind === "discussion"
                      ? "重命名讨论"
                      : "管理课题"}
              </h2>
              <button
                type="button"
                aria-label="关闭管理窗口"
                disabled={working}
                onClick={() => setManagement(undefined)}
              >
                ×
              </button>
            </div>
            <label>
              名称
              <input
                autoFocus
                aria-label="名称"
                value={management.name}
                maxLength={120}
                onChange={(e) =>
                  setManagement({ ...management, name: e.target.value })
                }
              />
            </label>
            {management.kind === "paper" && (
              <label>
                所属课题
                <select
                  aria-label="所属课题"
                  value={management.projectId ?? ""}
                  onChange={(e) =>
                    setManagement({
                      ...management,
                      projectId: e.target.value || null,
                    })
                  }
                >
                  <option value="">未分组论文</option>
                  {index.projects
                    .filter((p) => !p.archived)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <div className="rw-actions">
              <button
                type="submit"
                className="rp-primary"
                disabled={working || !management.name.trim()}
              >
                保存
              </button>
              {management.kind === "project" && (
                <button
                  type="button"
                  disabled={working}
                  onClick={() =>
                    void action(async () => {
                      await researchApi(
                        `/api/projects/${management.id}`,
                        { archived: !management.archived },
                        "PATCH",
                      );
                      await refresh();
                      setManagement(undefined);
                      if (projectId === management.id) setProjectId(null);
                      setNotice(
                        management.archived
                          ? "课题已恢复。"
                          : "课题已归档，论文与讨论保留。",
                      );
                    })
                  }
                >
                  {management.archived ? "恢复课题" : "归档课题"}
                </button>
              )}
            </div>
            {error && (
              <p className="rw-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </dialog>
      )}
    </div>
  );
}
