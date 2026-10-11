import { PptGeneration, PlanGeneration } from "./generation-zones.tsx";
import { useResearchLayout, Splitter } from "./research-layout.tsx";
import { startResponseTiming } from "./response-timing.ts";
import { ResearchSettings } from "./research-settings.tsx";
import { PersonalRecordsPanel } from "./learning-records.tsx";
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
import { importPaper, researchApi, pollWorkspace } from "./research-api.ts";
import { ResearchNavigation } from "./research-navigation.tsx";
import {
  ResearchDiscussion,
  finished,
  statusLabel,
} from "./research-discussion.tsx";
import type { ResearchSelection } from "./research-discussion.tsx";
import {
  PendingAttachments,
  useAttachmentDraft,
} from "./research-attachments.tsx";
import type { ResearchAttachment } from "../shared/attachments.ts";
import { ResearchReading } from "./research-reading.tsx";
import "./reading-prototype.css";
import "./research-workspace.css";
import { ObjectMenu } from "./research-menu.tsx";
import {
  readPreference,
  useResearchTheme,
  useResearchFont,
} from "./research-theme.ts";
import { ResearchIcon } from "./research-icons.tsx";
import "./research-appearance.css";

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
  const { layout, update: resize, reset: resetLayout } = useResearchLayout();
  const { theme, setTheme } = useResearchTheme();
  const { font, setFont } = useResearchFont();
  const [collapsed, setCollapsed] = useState(
    () =>
      readPreference(
        "research-navigation-collapsed",
        ["true", "false"],
        "false",
      ) === "true",
  );
  const [pinned, setPinned] = useState(
    () =>
      readPreference("research-reader-pinned", ["true", "false"], "false") ===
      "true",
  );
  const [autoGuide, setAutoGuide] = useState(
    () =>
      readPreference("research-auto-reading", ["true", "false"], "true") ===
      "true",
  );
  const [wide, setWide] = useState(false),
    [composerExpanded, setComposerExpanded] = useState(false),
    [contentWidth, setContentWidth] = useState(0);
  const returnPosition = useRef<
    { top: number; target?: HTMLElement } | undefined
  >(undefined);
  const canCompare = contentWidth - layout.reading - 7 >= 720;
  useEffect(() => {
    const target = document.querySelector(".rw-main");
    if (!target) return;
    const observer = new ResizeObserver(([entry]) =>
      setContentWidth(entry.contentRect.width),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("research-navigation-collapsed", String(collapsed));
      localStorage.setItem("research-reader-pinned", String(pinned));
      localStorage.setItem("research-auto-reading", String(autoGuide));
    } catch {}
  }, [collapsed, pinned, autoGuide]);
  function rememberAnswer() {
    if (returnPosition.current) return;
    const messages = document.querySelector<HTMLElement>(".rw-messages");
    returnPosition.current = {
      top: messages?.scrollTop ?? 0,
      target: document.activeElement as HTMLElement,
    };
  }
  function closeReading() {
    setWide(false);
    setPanel(null);
    requestAnimationFrame(() => {
      const messages = document.querySelector<HTMLElement>(".rw-messages");
      if (messages && returnPosition.current)
        messages.scrollTop = returnPosition.current.top;
      returnPosition.current?.target?.focus({ preventScroll: true });
      returnPosition.current = undefined;
    });
  }
  const [mode, setMode] = useState<"research" | "ppt" | "plan">("research"),
    [settings, setSettings] = useState(false),
    [records, setRecords] = useState(false);
  const [planTitle, setPlanTitle] = useState("新医学课题");
  const recordsDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (records) recordsDialog.current?.showModal();
  }, [records]);
  const [index, setIndex] = useState<WorkspaceIndex>(emptyIndex);
  const [papers, setPapers] = useState<PaperBundle[]>([]);
  const [conversations, setConversations] = useState<ConversationState[]>([]);
  const [conversation, setConversation] = useState<ConversationState>();
  useEffect(() => {
    if (conversation)
      try {
        sessionStorage.removeItem("research-new-discussion");
        sessionStorage.setItem("research-current-chat", conversation.id);
      } catch {}
  }, [conversation?.id]);
  const [turns, setTurns] = useState<ResearchTurn[]>([]);
  const [paper, setPaper] = useState<PaperBundle>();
  useEffect(() => {
    window.dispatchEvent(new Event("research-dismiss-menus"));
    setWide(false);
    returnPosition.current = undefined;
  }, [paper?.id, mode]);
  useEffect(() => {
    window.dispatchEvent(new Event("research-dismiss-menus"));
  }, [settings, records]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [start, setStart] = useState<ReadingStart>();
  const [panel, setPanel] = useState<"sources" | "notes" | null>(null);
  const pptSourcesDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (mode !== "research" && panel) pptSourcesDialog.current?.showModal();
  }, [mode, panel]);
  const [sourceId, setSourceId] = useState<string>();
  const [sourceRevision, setSourceRevision] = useState(0);
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
  const attachmentInput = useRef<HTMLInputElement>(null),
    imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    revision = useRef(0),
    actionLock = useRef(false);
  const pollNow = useRef<(() => void) | undefined>(undefined);
  const dragDepth = useRef(0),
    retry = useRef<
      | {
          question: string;
          selection?: ResearchSelection;
          clientMessageId: string;
          conversationId: string;
          attachmentIds?: string[];
          targetPaperId?: string | null;
        }
      | undefined
    >(undefined);
  const draftKey = `research-draft:${paper?.id ?? projectId ?? "idea"}`;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const pendingAttachments = useAttachmentDraft(draftKey, setError);
  const active = turns.find((t) => !finished(t));
  const busy = loading || working || uploading;
  const historical = !!paper && !!conversation && !conversation.mainChat;
  const staleSelection =
    !!selection?.sourceAnchor &&
    (selection.sourceAnchor.paperId !== paper?.id ||
      selection.sourceAnchor.sourceVersion !== paper?.version);
  const importRetry = useRef<{ file: File; id: string } | undefined>(undefined);
  const recent = [...conversations]
    .filter((c) => c.recentTurnIds.length && c.purpose !== "ppt-generation")
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
  const currentName = paper
    ? paperName(paper, index)
    : (index.projects.find((p) => p.id === projectId)?.name ?? "论文带读");
  const notes = index.notes.filter((n) =>
    paper ? n.paperId === paper.id : n.conversationId === conversation?.id,
  );

  async function refresh() {
    const value = await researchApi<WorkspaceBootstrap>("/api/workspace");
    setIndex(value.index);
    setPapers(value.papers);
    setConversations(value.conversations);
    if (value.recoveryNotice) setNotice(value.recoveryNotice);
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
      setPanel(pinned ? (position?.panel ?? null) : null);
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
        if (token === revision.current) {
          setStart(nextStart);
        }
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
        try {
          const pending = JSON.parse(
            sessionStorage.getItem("research-new-discussion") ?? "null",
          );
          if (
            pending &&
            (pending.paperId === null ||
              value.papers.some((p) => p.id === pending.paperId)) &&
            (pending.projectId === null ||
              value.index.projects.some(
                (p) => p.id === pending.projectId && !p.archived,
              ))
          ) {
            blank(
              pending.projectId,
              value.papers.find((p) => p.id === pending.paperId),
            );
            return;
          }
        } catch {}
        // Opening the app starts at home; explicit paper selection restores its chat.
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
    if (!paper || !start || !["queued", "running"].includes(start.status ?? ""))
      return;
    let closed = false;
    const timer = setInterval(() => {
      void researchApi<ReadingStart>(`/api/papers/${paper.id}/start`)
        .then((value) => {
          if (!closed) setStart(value);
        })
        .catch((err) => {
          if (!closed) setError(err.message);
        });
    }, 900);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [paper?.id, start?.status]);
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
      polling = false,
      timer: ReturnType<typeof setTimeout>,
      previous: WorkspaceBootstrap | undefined;
    const tick = async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        const [history, state, workspace] = await Promise.all([
          researchApi<ResearchTurn[]>(`/api/conversations/${id}/turns`),
          researchApi<ConversationState>(`/api/conversations/${id}`),
          pollWorkspace(previous),
        ]);
        if (stopped || token !== revision.current) return;
        setTurns((current) => {
          const known = new Map(current.map((turn) => [turn.id, turn]));
          const received = new Set(history.map((turn) => turn.id));
          return [
            ...history.map((turn) =>
              !finished(turn) &&
              known.has(turn.id) &&
              finished(known.get(turn.id)!)
                ? known.get(turn.id)!
                : turn,
            ),
            ...current.filter((turn) => !received.has(turn.id)),
          ];
        });
        previous = workspace;
        setConversation((current) =>
          current?.id === state.id && current.version > state.version
            ? current
            : state,
        );
        setIndex(workspace.index);
        setConversations(workspace.conversations);
        setPapers(workspace.papers);
      } catch (err) {
        if (!stopped) setError((err as Error).message);
      } finally {
        polling = false;
        if (!stopped) {
          const running =
            currentConversation.current?.id === id &&
            currentTurns.current.some((turn) => !finished(turn));
          timer = setTimeout(
            () => void tick(),
            document.hidden ? 10000 : running ? 900 : 3000,
          );
        }
      }
    };
    const wake = () => {
      if (document.hidden || polling) return;
      clearTimeout(timer);
      void tick();
    };
    pollNow.current = wake;
    document.addEventListener("visibilitychange", wake);
    timer = setTimeout(() => void tick(), active ? 900 : 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      if (pollNow.current === wake) pollNow.current = undefined;
    };
  }, [conversation?.id]);
  useEffect(() => {
    if (active) pollNow.current?.();
  }, [active?.id]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (
          e.defaultPrevented ||
          (e.target as HTMLElement).closest("dialog,[role=menu]")
        )
          return;
        if (wide) setWide(false);
        else closeReading();
        setMobile(false);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [wide]);
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
    try {
      sessionStorage.removeItem("research-current-chat");
      sessionStorage.setItem(
        "research-new-discussion",
        JSON.stringify({ paperId: bound?.id ?? null, projectId: owner }),
      );
    } catch {}
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
      const importId = importRetry.current?.id ?? crypto.randomUUID();
      const result = await importPaper(files, importId);
      importRetry.current = undefined;
      await researchApi(
        `/api/papers/${result.paper.id}/metadata`,
        { projectId: owner },
        "PATCH",
      );
      await refresh();
      if (token === revision.current) {
        await selectPaper(result.paper);
        const openedToken = revision.current;
        if (
          autoGuide &&
          !result.error &&
          !question.trim() &&
          result.paper.parseStatus !== "needs-text"
        ) {
          const chat = await researchApi<ConversationState>(
            `/api/papers/${result.paper.id}/chat`,
            {},
          );
          if (
            openedToken !== revision.current ||
            composer.current?.value.trim()
          )
            return;
          const started = await researchApi<{ turn: ResearchTurn | null }>(
            `/api/papers/${result.paper.id}/reading-start`,
            { importId, conversationId: chat.id },
          );
          if (openedToken === revision.current && started.turn)
            setTurns((old) =>
              old.some((t) => t.id === started.turn!.id)
                ? old
                : [...old, started.turn!],
            );
        }
      }
      if (result.error) setError(result.error);
      else
        setNotice(
          result.paper.parseStatus === "needs-text"
            ? "文件已保留，需补充可读取正文。"
            : "论文已导入，可继续中文带读，或直接告诉我你的问题。",
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
    if (text) suggest(text);
    else composer.current?.focus();
  }
  function citation(id: string, source?: Source) {
    rememberAnswer();
    setSourceRevision((value) => value + 1);
    setSourceId(id);
    setExtraSource(source);
    setPanel("sources");
  }
  const currentPaper = useRef(paper);
  currentPaper.current = paper;
  const currentConversation = useRef(conversation);
  currentConversation.current = conversation;
  const currentTurns = useRef(turns);
  currentTurns.current = turns;
  function applyConversation(state: ConversationState) {
    if (currentConversation.current?.id === state.id)
      setConversation((current) =>
        current && current.version > state.version ? current : state,
      );
  }
  async function ensure() {
    if (conversation) return conversation;
    const token = revision.current;
    const state = paper
      ? await researchApi<ConversationState>(`/api/papers/${paper.id}/chat`, {})
      : await researchApi<ConversationState>("/api/conversations", {
          paperId: null,
          projectId,
        });
    if (token === revision.current) {
      setConversation(state);
      setConversations((old) =>
        old.some((c) => c.id === state.id) ? old : [...old, state],
      );
    }
    return state;
  }
  async function send() {
    if (
      busy ||
      historical ||
      (!question.trim() && !pendingAttachments.files.length) ||
      actionLock.current
    )
      return;
    const token = revision.current;
    const submittedDraftKey = draftKeyRef.current;
    const submittedFiles = [...pendingAttachments.files];
    const submittedQuestion = question.trim() || "请带我理解这些材料。";
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
      const pdf = submittedFiles.find(
        (a) => a.file && /\.pdf$/i.test(a.file.name),
      );
      let targetPaperId = paper?.id ?? null;
      if (pdf?.file) {
        const result = await importPaper([pdf.file], pdf.id);
        await researchApi(
          `/api/papers/${result.paper.id}/metadata`,
          { projectId },
          "PATCH",
        );
        state = await researchApi<ConversationState>(
          `/api/papers/${result.paper.id}/chat`,
          {},
        );
        targetPaperId = result.paper.id;
      }
      const attachmentIds: string[] = [];
      for (const item of submittedFiles.filter((a) => a !== pdf)) {
        if (item.record && item.record.conversationId === state.id) {
          attachmentIds.push(item.id);
          continue;
        }
        let file = item.file,
          id = item.id;
        if (item.record) {
          if (!item.record.image)
            throw new Error(`${item.record.name} 需要重新选择文件。`);
          const blob = await (await fetch(item.record.image)).blob();
          file = new File([blob], item.record.name, { type: blob.type });
          id = `${item.id}-${state.id}`;
        }
        const body = new FormData();
        body.append("image", file!);
        body.append("attachmentId", id);
        const response = await fetch(
          `/api/conversations/${state.id}/attachments`,
          { method: "POST", body },
        );
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error || "附件上传失败，请重试。");
        attachmentIds.push((value as ResearchAttachment).id);
      }
      const pending =
        retry.current?.conversationId === state.id
          ? retry.current
          : {
              question: submittedQuestion,
              selection: pdf ? undefined : selection,
              attachmentIds,
              targetPaperId,
              clientMessageId: crypto.randomUUID(),
              conversationId: state.id,
            };
      retry.current = pending;
      const bindTiming = startResponseTiming();
      const value = await researchApi<ResearchTurn>(
        `/api/conversations/${state.id}/messages`,
        {
          question: pending.question,
          clientMessageId: pending.clientMessageId,
          mode: "live",
          paperId: pending.targetPaperId ?? targetPaperId,
          attachmentIds: pending.attachmentIds ?? attachmentIds,
          expectedReadingRevision: state.readingSession?.revision ?? 0,
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
      bindTiming(value.id);
      await pendingAttachments.sent(
        submittedFiles.map((a) => a.id),
        submittedDraftKey,
      );
      if (pdf) {
        if (token === revision.current) await openConversation(state.id);
        try {
          localStorage.setItem(submittedDraftKey, "");
          localStorage.removeItem(`${submittedDraftKey}:selection`);
        } catch {}
        return;
      }
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
          {
            displayName: name,
            projectId: management.projectId ?? null,
            ...(management.archived ? { archived: true } : {}),
          },
          "PATCH",
        );
        setProjectId(management.projectId ?? null);
        if (management.archived && paper?.id === id) {
          blank(management.projectId ?? null);
          setNotice("论文已归档；已有成果和带读记录保留，可在设置中恢复。");
        }
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
  const readingPanel = panel ? (
    <ResearchReading
      overlay={mode !== "research"}
      returnLabel={
        mode === "ppt"
          ? "返回 PPT 汇报"
          : mode === "plan"
            ? "返回研究方案"
            : "返回讨论"
      }
      key={paper?.id ?? "idea"}
      paper={paper}
      name={currentName}
      panel={panel}
      sourceId={sourceId}
      locatorRevision={sourceRevision}
      onMaterial={(value) => {
        if (value.id === currentPaper.current?.id) {
          const token = revision.current;
          setPaper(value);
          setSelection(undefined);
          localStorage.removeItem(`${draftKeyRef.current}:selection`);
          void refresh()
            .then(() =>
              researchApi<ReadingStart>(`/api/papers/${value.id}/start`),
            )
            .then((guide) => {
              if (token === revision.current) setStart(guide);
            })
            .catch((err) => setError(err.message));
        }
      }}
      extraSource={extraSource}
      notes={notes}
      busy={busy}
      onPanel={setPanel}
      onClose={closeReading}
      pinned={pinned}
      onPin={() => {
        setPinned((old) => !old);
        if (!canCompare)
          setNotice("当前空间不足以并排，可收起导航后固定对照。");
      }}
      wide={wide}
      onWide={() => setWide(true)}
      onBack={() => setWide(false)}
      onSource={(id) => citation(id)}
      onFocus={(next, text) => {
        if (mode !== "research") {
          closeReading();
          setMode("research");
        }
        focus(next, text);
      }}
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
      onCreateNote={async (input) => {
        const state = await ensure();
        await researchApi("/api/workspace/notes/manual", {
          ...input,
          conversationId: state.id,
        });
        await refresh();
      }}
      onReturn={(id) => void openConversation(id)}
    />
  ) : null;
  const latestReply = [...turns]
    .reverse()
    .find((t) => t.status === "completed" && t.reply?.content);
  const archived = index.projects.filter((p) => p.archived);
  return (
    <div
      style={
        {
          "--rw-navigation": `${layout.navigation}px`,
          "--rw-reading": `${layout.reading}px`,
          "--rw-composer": `${layout.composer}px`,
        } as import("react").CSSProperties
      }
      className={`rp rw ${collapsed ? "rw-nav-collapsed" : ""} ${panel && (!canCompare || wide) ? "rw-reading-single" : ""} ${wide ? "rw-reading-wide" : ""} ${composerExpanded ? "rw-composer-expanded" : ""}`}
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
        if (e.defaultPrevented) return;
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
        onPaper={(p) => {
          setMode("research");
          setMobile(false);
          void selectPaper(p);
        }}
        onProject={(id) => blank(id)}
        mode={mode}
        onHome={() => {
          setMode("research");
          setMobile(false);
        }}
        onPpt={() => {
          setPanel(null);
          setMode("ppt");
          setMobile(false);
        }}
        onPlan={() => {
          setPanel(null);
          setMode("plan");
          setMobile(false);
        }}
        onSettings={() => {
          setSettings(true);
          setMobile(false);
        }}
        onRecords={() => {
          setRecords(true);
          setMobile(false);
        }}
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
        onEditPaper={(p, archive = false) =>
          setManagement({
            kind: "paper",
            id: p.id,
            name: paperName(p, index),
            archived: archive,
            projectId:
              index.papers.find((m) => m.paperId === p.id)?.projectId ?? null,
          })
        }
        onResume={(id) => void openConversation(id)}
        mobile={mobile}
        close={() => setMobile(false)}
      />
      <Splitter
        className="rw-navigation-split"
        label="调整导航宽度"
        value={layout.navigation}
        min={200}
        max={280}
        onChange={(v) => resize("navigation", v)}
      />
      <main className="rw-main">
        <header className="rp-topbar">
          <button
            className="rp-mobile-menu"
            aria-label="打开导航"
            onClick={() => {
              if (innerWidth > 1000) setCollapsed((old) => !old);
              else setMobile((old) => !old);
            }}
          >
            <ResearchIcon name="sidebar" />
          </button>
          <div className="rw-breadcrumb">
            <span>
              {mode === "research"
                ? "论文带读"
                : mode === "plan"
                  ? "研究方案"
                  : "PPT 汇报"}
            </span>
            <strong
              title={
                mode === "plan" ? planTitle : (paper?.title ?? currentName)
              }
            >
              {mode === "plan"
                ? "研究方案"
                : mode === "ppt"
                  ? "论文汇报"
                  : currentName}
            </strong>
          </div>
          <button
            aria-expanded={!!panel}
            disabled={loading || mode !== "research" || !paper}
            onClick={() => {
              if (panel) closeReading();
              else {
                rememberAnswer();
                setPanel("sources");
              }
            }}
          >
            资料
          </button>
          <ObjectMenu
            objectKey={paper?.id ?? conversation?.id ?? "idea"}
            label="当前论文更多操作"
            actions={[
              ...(paper
                ? [
                    {
                      label: "论文名称与归组",
                      run: () =>
                        setManagement({
                          kind: "paper",
                          id: paper.id,
                          name: currentName,
                          projectId,
                        }),
                    },
                  ]
                : [
                    {
                      label: "导入论文",
                      run: () => fileInput.current?.click(),
                    },
                  ]),
              {
                label: "讨论记录",
                children: [
                  ...(conversation
                    ? [
                        {
                          label: "重命名讨论",
                          run: () =>
                            setManagement({
                              kind: "discussion",
                              id: conversation.id,
                              name: titleOf(conversation),
                            }),
                        },
                      ]
                    : []),
                  ...conversations
                    .filter(
                      (c) =>
                        c.paperId === (paper?.id ?? null) &&
                        (paper || (c.projectId ?? null) === projectId),
                    )
                    .map((c) => ({
                      label: titleOf(c),
                      run: () => void openConversation(c.id),
                    })),
                  ...(!paper
                    ? [{ label: "开始新讨论", run: () => blank(projectId) }]
                    : []),
                ],
              },

              {
                label: "PPT 汇报",
                run: () => {
                  setPanel(null);
                  setMode("ppt");
                },
              },
              {
                label: "研究方案",
                run: () => {
                  setPanel(null);
                  setMode("plan");
                },
              },
              {
                label: "更多问题",
                children: [
                  "这篇论文提出了什么研究问题？",
                  "这篇论文采用了什么研究方法，为什么这样选择？",
                  "这篇论文的结果有哪些证据？",
                  "这篇论文有哪些局限，对后续研究有什么启发？",
                ].map((q) => ({ label: q, run: () => suggest(q) })),
              },
              ...(archived.length
                ? [
                    {
                      label: "已归档课题",
                      children: archived.map((p) => ({
                        label: p.name,
                        run: () =>
                          setManagement({
                            kind: "project",
                            id: p.id,
                            name: p.name,
                            archived: true,
                          }),
                      })),
                    },
                  ]
                : []),
            ]}
          />
        </header>
        {mode === "plan" ? (
          <PlanGeneration
            papers={papers}
            onImported={(p) => {
              setPapers((old) => [...old.filter((x) => x.id !== p.id), p]);
              void refresh();
            }}
          />
        ) : mode === "ppt" ? (
          <PptGeneration
            papers={papers}
            initialPaper={paper}
            onImported={(p) => {
              setPapers((old) => [...old.filter((x) => x.id !== p.id), p]);
              void refresh();
            }}
          />
        ) : (
          <div className="rw-content">
            <section className="rw-chat">
              {loading && (
                <p className="rw-loading" role="status">
                  正在恢复资料与讨论…
                </p>
              )}
              <ResearchDiscussion
                conversationId={conversation?.id}
                readingSession={conversation?.readingSession}
                turns={turns}
                paper={paper}
                start={start}
                onGuide={() => {
                  void action(async () => {
                    const state = await ensure();
                    const token = revision.current;
                    const turn = await researchApi<ResearchTurn>(
                      `/api/conversations/${state.id}/messages`,
                      {
                        clientMessageId: crypto.randomUUID(),
                        question:
                          "请用中文带我读这篇论文，从第一个可读单元开始。",
                        mode: "live",
                        paperId: state.paperId,
                        readingAction: "start",
                        expectedReadingRevision:
                          state.readingSession?.revision ?? 0,
                      },
                    );
                    if (token === revision.current)
                      setTurns((old) =>
                        old.some((t) => t.id === turn.id)
                          ? old
                          : [...old, turn],
                      );
                  });
                }}
                onCancelGuide={() =>
                  paper &&
                  void researchApi(
                    `/api/papers/${paper.id}/start/cancel`,
                    {},
                  ).catch((err) => setError(err.message))
                }
                busy={working}
                onAttachmentRetry={(turn, id, purpose) =>
                  void researchApi(
                    `/api/turns/${turn.id}/attachments/${id}/retry`,
                    { purpose },
                  ).catch((err) => setError(err.message))
                }
                onCancel={(turn) =>
                  researchApi<{ turn?: ResearchTurn }>(
                    `/api/turns/${turn.id}/cancel`,
                    {},
                  )
                    .then((result) => {
                      if (result.turn)
                        setTurns((old) =>
                          old.map((value) =>
                            value.id === turn.id ? result.turn! : value,
                          ),
                        );
                      setNotice("本次回答已结束，可以继续提问。");
                    })
                    .catch((err) => setError(err.message))
                }
                onRetry={(turn) => {
                  draft(turn.message.question);
                  pendingAttachments.restore(turn.attachments ?? []);
                  const restored = turn.message.sourceAnchor
                    ? {
                        label: turn.message.sourceAnchor.excerpt,
                        sourceAnchor: turn.message.sourceAnchor,
                      }
                    : turn.message.focus
                      ? {
                          label: turn.message.focus.excerpt,
                          focus: turn.message.focus,
                        }
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
                      localStorage.removeItem(
                        `${draftKeyRef.current}:selection`,
                      );
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
                onRecord={(turn, kind, feedback) =>
                  void action(async () => {
                    const state = await researchApi<ConversationState>(
                      `/api/conversations/${turn.conversationId}`,
                    );
                    const next = await researchApi<ConversationState>(
                      `/api/conversations/${state.id}/records`,
                      {
                        version: state.version,
                        kind,
                        unitId: turn.runId,
                        text:
                          turn.reply?.content?.title ?? turn.message.question,
                        ...(feedback ? { feedback } : {}),
                      },
                    );
                    applyConversation(next);
                    setNotice(
                      kind === "favorite"
                        ? "解释已收藏。"
                        : "你的理解反馈已保存。",
                    );
                  })
                }
                onSave={(turn) =>
                  void action(async () => {
                    await researchApi("/api/workspace/notes", {
                      conversationId: turn.conversationId,
                      turnId: turn.id,
                    });
                    await refresh();
                    rememberAnswer();
                    setPanel("notes");
                    setNotice("回答已保存，原讨论与依据已保留。");
                  })
                }
                savedIds={index.notes.flatMap((n) =>
                  n.turnId ? [n.turnId] : [],
                )}
                latestTitle={
                  !conversation && !paper && recent
                    ? titleOf(recent)
                    : undefined
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
                {latestReply?.reply?.nextStep && (
                  <details className="rw-next-step">
                    <summary>接下来可以…</summary>
                    <button
                      type="button"
                      onClick={() => suggest(latestReply.reply!.nextStep)}
                    >
                      {latestReply.reply.nextStep}
                    </button>
                  </details>
                )}
                {selection && (
                  <div className="rw-reference">
                    {staleSelection && (
                      <span role="alert">
                        来源版本已变化，请移除后重新选择引用。
                      </span>
                    )}
                    <button
                      type="button"
                      className="rw-reference-target"
                      onClick={() => {
                        if (selection.sourceAnchor)
                          citation(selection.sourceAnchor.sourceId);
                        else if (selection.figureSourceId)
                          citation(selection.figureSourceId);
                        else if (selection.focus)
                          document
                            .querySelector(
                              `[data-turn-id="${turns.find((t) => t.runId === selection.focus!.runId)?.id}"]`,
                            )
                            ?.scrollIntoView({ block: "center" });
                      }}
                    >
                      正在问：{selection.label}
                    </button>
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
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes("Files"))
                      e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragging(false);
                    dragDepth.current = 0;
                    pendingAttachments.add([...e.dataTransfer.files]);
                  }}
                  onPaste={(e) => {
                    const images = [...e.clipboardData.files].filter((f) =>
                      /image\/(png|jpeg)/.test(f.type),
                    );
                    if (images.length) {
                      e.preventDefault();
                      pendingAttachments.add(images);
                    }
                  }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <PendingAttachments
                    files={pendingAttachments.files}
                    remove={pendingAttachments.remove}
                  />
                  <textarea
                    ref={composer}
                    aria-label="向科研助手提问"
                    disabled={loading}
                    placeholder={
                      loading
                        ? "正在恢复当前讨论，请稍候…"
                        : "哪里没读懂？可以用自己的话问。"
                    }
                    value={question}
                    maxLength={2000}
                    onChange={(e) => {
                      draft(e.target.value);
                      e.currentTarget.style.height = "auto";
                      e.currentTarget.style.height =
                        Math.min(
                          e.currentTarget.scrollHeight,
                          composerExpanded ? 320 : 112,
                        ) + "px";
                    }}
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
                    <div className="rw-file-buttons">
                      <ObjectMenu
                        objectKey={draftKey}
                        label="添加附件"
                        actions={[
                          {
                            label: "添加 PDF",
                            run: () => attachmentInput.current?.click(),
                          },
                          {
                            label: "添加图片",
                            run: () => imageInput.current?.click(),
                          },
                        ]}
                      />
                      <button
                        type="button"
                        aria-expanded={composerExpanded}
                        onClick={() => setComposerExpanded((old) => !old)}
                      >
                        {composerExpanded ? "收起输入" : "展开输入"}
                      </button>
                    </div>
                    <button
                      type="submit"
                      className="rp-primary rw-send"
                      aria-label={
                        working ? "正在提交" : active ? "加入队列 ↑" : "发送 ↑"
                      }
                      disabled={
                        busy ||
                        staleSelection ||
                        historical ||
                        (!question.trim() && !pendingAttachments.files.length)
                      }
                    >
                      <ResearchIcon name={working ? "more" : "arrow"} />
                    </button>
                  </div>
                </form>
                <p className="rp-composer-note">
                  Enter 发送 · Shift + Enter 换行
                </p>
              </div>
            </section>
            {panel && canCompare && !wide && (
              <Splitter
                className="rw-reading-split"
                label="调整聊天与阅读宽度"
                value={layout.reading}
                min={320}
                max={Math.max(320, Math.min(560, contentWidth - 727))}
                reverse
                scale={1}
                onChange={(v) => resize("reading", v)}
              />
            )}
            {readingPanel}
          </div>
        )}
      </main>
      {mode !== "research" && panel && (
        <dialog
          ref={pptSourcesDialog}
          className="rw-ppt-sources-dialog"
          aria-label={mode === "ppt" ? "PPT 来源与笔记" : "研究方案资料与笔记"}
          onCancel={(event) => {
            event.preventDefault();
            closeReading();
          }}
        >
          {readingPanel}
        </dialog>
      )}
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
        ref={attachmentInput}
        type="file"
        accept=".pdf"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) pendingAttachments.add([...e.target.files]);
          e.target.value = "";
        }}
      />
      <input
        ref={imageInput}
        type="file"
        accept=".png,.jpg,.jpeg"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) pendingAttachments.add([...e.target.files]);
          e.target.value = "";
        }}
      />
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
      {settings && (
        <ResearchSettings
          conversation={conversation}
          loading={loading}
          ensure={ensure}
          onState={applyConversation}
          close={() => setSettings(false)}
          reset={() => {
            resetLayout();
            setCollapsed(false);
            setPinned(false);
            setComposerExpanded(false);
            setWide(false);
            setPanel(null);
          }}
          theme={theme}
          onTheme={setTheme}
          font={font}
          onFont={setFont}
          autoGuide={autoGuide}
          onAutoGuide={setAutoGuide}
          onArchiveChange={async () => {
            await refresh();
          }}
        />
      )}
      {records && (
        <dialog
          ref={recordsDialog}
          className="rp-settings rw-settings rw-records"
          onCancel={() => setRecords(false)}
        >
          <header className="rp-modal-heading">
            <h2 title={currentName}>个人记录 · {currentName}</h2>
            <button aria-label="关闭个人记录" onClick={() => setRecords(false)}>
              ×
            </button>
          </header>
          <PersonalRecordsPanel
            key={conversation?.id}
            state={conversation}
            ensure={ensure}
            onState={applyConversation}
            disabled={false}
            onView={(run) => {
              setRecords(false);
              setMode("research");
              const id = turns.find((t) => t.runId === run.id)?.id;
              setTimeout(
                () =>
                  document
                    .querySelector(`[data-turn-id="${id}"]`)
                    ?.scrollIntoView({ block: "center" }),
                50,
              );
            }}
          />
        </dialog>
      )}
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
                    ? management.archived
                      ? "归档论文"
                      : "论文名称与归组"
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
              <details open>
                <summary>论文信息</summary>
                <p>{papers.find((p) => p.id === management.id)?.title}</p>
                <p>{papers.find((p) => p.id === management.id)?.doi}</p>
                <p>{papers.find((p) => p.id === management.id)?.scope}</p>
              </details>
            )}
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
                {management.kind === "paper" && management.archived
                  ? "确认归档"
                  : "保存"}
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
