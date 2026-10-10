import { useEffect, useRef, useState } from "react";
import type {
  AssistantTurn,
  ConversationState,
  DeckVersion,
  PaperBundle,
  Slide,
} from "../shared/types.ts";
import type { ResearchNote, ResearchTurn } from "../shared/workspace.ts";
import { researchApi } from "./research-api.ts";
import { finished, statusLabel } from "./research-discussion.tsx";
import { Splitter, type defaultLayout } from "./research-layout.tsx";
import { ObjectMenu } from "./research-menu.tsx";
import { ResearchImage } from "./research-image.tsx";
import { ResearchSlide } from "./research-slide.tsx";
import { ImageCrop } from "./research-image-crop.tsx";
import { slideImageKey, preferredSources } from "../shared/image-region.ts";

const done = (v: DeckVersion) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(v.status);
const storedDraft = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
export function ResearchPpt({
  paper,
  conversation,
  turns,
  notes,
  ensure,
  onState,
  onCitation,
  onResearch,
  layout,
  resize,
}: {
  paper?: PaperBundle;
  conversation?: ConversationState;
  turns: ResearchTurn[];
  notes: ResearchNote[];
  ensure: () => Promise<ConversationState>;
  onState: (state: ConversationState) => void;
  onCitation: (id: string) => void;
  onResearch: () => void;
  layout: typeof defaultLayout;
  resize: (key: keyof typeof defaultLayout, value: number) => void;
}) {
  const viewKey = `research-ppt-view:${paper?.id}:${conversation?.id}`;
  const readView = () => {
    try {
      return JSON.parse(localStorage.getItem(viewKey) ?? "{}");
    } catch {
      return {};
    }
  };
  const [versions, setVersions] = useState<DeckVersion[]>([]),
    [selected, setSelected] = useState<string | undefined>(readView().selected);
  const [page, setPage] = useState<number>(
      Math.max(0, Number(readView().page) || 0),
    ),
    [draft, setDraft] = useState<Slide>(),
    [request, setRequest] = useState("");
  const [question, setQuestion] = useState(""),
    [count, setCount] = useState(6);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [exportUrl, setExportUrl] = useState(""),
    [name, setName] = useState("");
  const [useNotes, setUseNotes] = useState(true);
  const [editing, setEditing] = useState(false);
  const [withSpeech, setWithSpeech] = useState(true),
    [speechDraft, setSpeechDraft] = useState("");
  const [speechEditing, setSpeechEditing] = useState(false);
  const [speechRequest, setSpeechRequest] = useState("");
  const [cancelling, setCancelling] = useState<string[]>([]),
    [cancelledTurns, setCancelledTurns] = useState<string[]>([]),
    [notice, setNotice] = useState("");
  const cancelLocks = useRef(new Set<string>());
  const actionLock = useRef(false);
  useEffect(() => {
    try {
      localStorage.setItem(viewKey, JSON.stringify({ selected, page }));
    } catch {}
  }, [viewKey, selected, page]);
  const alive = useRef(true),
    previousStatus = useRef(new Map<string, string>()),
    settledVersions = useRef(new Map<string, DeckVersion>());
  const draftKey = (version: string, index: number) =>
    `research-ppt-draft:${version}:${index}`;
  function changeDraft(slide: Slide) {
    setDraft(slide);
    if (selected)
      localStorage.setItem(draftKey(selected, page), JSON.stringify(slide));
  }
  const current = versions.find((v) => v.id === selected),
    active = versions.filter((v) => !done(v));
  const generating = turns.filter(
    (t) =>
      !finished(t) &&
      !cancelledTurns.includes(t.id) &&
      (t.message.module === "ppt" || t.plan?.modules.includes("ppt")),
  );
  const taskPending = useRef(false),
    refreshNow = useRef<(() => void) | undefined>(undefined);
  taskPending.current = active.length > 0 || generating.length > 0;
  const changed =
    current &&
    draft &&
    JSON.stringify(draft) !== JSON.stringify(current.outline.slides[page]);
  const speechChanged = speechDraft !== (current?.outline.speechScript ?? "");
  const unsavedPages =
    current?.outline.slides.flatMap((slide, i) => {
      try {
        const saved = localStorage.getItem(draftKey(current.id, i));
        return saved && saved !== JSON.stringify(slide) ? [i + 1] : [];
      } catch {
        return [];
      }
    }) ?? [];
  const imageKey = draft && slideImageKey(draft);
  const imageSource = paper?.sources.find((s) => s.id === draft?.imageSource);
  const imageAsset = imageKey && current?.displayAssets?.[imageKey];
  const originalImageUrl =
    imageSource?.image ??
    (imageSource?.page && paper?.pdfUrl
      ? `/api/papers/${paper.id}/sources/${imageSource.id}/image`
      : undefined);
  const imageUrl = imageAsset
    ? `/api/display-assets/${imageAsset}`
    : originalImageUrl;
  useEffect(() => {
    setSpeechEditing(false);
    setSpeechRequest(
      storedDraft(`research-speech-request:${current?.id}`) ?? "",
    );
    try {
      setSpeechDraft(
        localStorage.getItem(`research-speech-draft:${current?.id}`) ??
          current?.outline.speechScript ??
          "",
      );
    } catch {
      setSpeechDraft(current?.outline.speechScript ?? "");
    }
  }, [current?.id]);
  useEffect(() => {
    alive.current = true;
    let closed = false,
      polling = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      if (closed || polling || !conversation || !paper) return;
      polling = true;
      try {
        const received = await researchApi<DeckVersion[]>(
          `/api/deck-versions?conversationId=${conversation.id}&paperId=${paper.id}`,
        );
        if (closed) return;
        const values = received.map((version) =>
          !done(version) && settledVersions.current.has(version.id)
            ? settledVersions.current.get(version.id)!
            : version,
        );
        setVersions((known) => [
          ...values,
          ...known.filter(
            (version) =>
              !done(version) &&
              !values.some((value) => value.id === version.id),
          ),
        ]);
        const failed = values.find(
          (v) =>
            ["failed", "interrupted"].includes(v.status) &&
            previousStatus.current.has(v.id) &&
            previousStatus.current.get(v.id) !== v.status,
        );
        if (failed)
          setError(
            failed.error ??
              "任务未完成，已保存的内容保留。请选择已保存版本重试。",
          );
        const newest = values.filter((v) => v.status === "completed").at(-1);
        const completed = values.find(
          (v) =>
            v.status === "completed" &&
            previousStatus.current.size > 0 &&
            previousStatus.current.get(v.id) !== "completed",
        );
        if (completed) {
          if (completed.parentId) {
            const parent = values.find((v) => v.id === completed.parentId);
            const priorSpeech = localStorage.getItem(
              `research-speech-draft:${completed.parentId}`,
            );
            if (
              priorSpeech !== null &&
              priorSpeech !== (parent?.outline.speechScript ?? "") &&
              (completed.operation !== "speech" ||
                priorSpeech !== completed.outline.speechScript)
            ) {
              localStorage.setItem(
                `${completed.operation === "speech" ? "research-speech-conflict" : "research-speech-draft"}:${completed.id}`,
                priorSpeech,
              );
              if (completed.operation !== "speech")
                localStorage.setItem(
                  `research-speech-draft-base:${completed.id}`,
                  completed.parentId,
                );
              setNotice(
                "旧讲稿修改已保留。先保存并核对页面，再比较讲稿与新页面的对应关系后保存核对。",
              );
            }
            completed.outline.slides.forEach((_slide, i) => {
              const prior = localStorage.getItem(
                draftKey(completed.parentId!, i),
              );
              if (
                prior &&
                prior !== JSON.stringify(parent?.outline.slides[i]) &&
                prior !== JSON.stringify(completed.outline.slides[i])
              ) {
                if (i === completed.slideIndex)
                  localStorage.setItem(
                    `research-ppt-conflict:${completed.id}:${i}`,
                    prior,
                  );
                else localStorage.setItem(draftKey(completed.id, i), prior);
              }
            });
          }
          setSelected(completed.id);
          void researchApi<ConversationState>(
            `/api/deck-versions/${completed.id}/select`,
            { conversationId: conversation.id },
          )
            .then((s) => {
              if (!closed) onState(s);
            })
            .catch((err) => {
              if (!closed) setError(err.message);
            });
        } else
          setSelected((old) =>
            values.some((v) => v.id === old)
              ? old
              : (conversation.latestDeckVersionId ?? newest?.id),
          );
        previousStatus.current = new Map(values.map((v) => [v.id, v.status]));
      } catch (err) {
        if (!closed) setError((err as Error).message);
      } finally {
        polling = false;
        if (!closed)
          timer = setTimeout(
            () => void refresh(),
            document.hidden ? 10000 : taskPending.current ? 900 : 3000,
          );
      }
    }
    const wake = () => {
      if (document.hidden || polling) return;
      clearTimeout(timer);
      void refresh();
    };
    refreshNow.current = wake;
    document.addEventListener("visibilitychange", wake);
    void refresh();
    return () => {
      closed = true;
      alive.current = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      if (refreshNow.current === wake) refreshNow.current = undefined;
    };
  }, [conversation?.id, paper?.id]);
  useEffect(() => {
    if (taskPending.current) refreshNow.current?.();
  }, [active.length > 0 || generating.length > 0]);
  useEffect(() => {
    setExportUrl("");
    try {
      setRequest(
        localStorage.getItem(`research-ppt-request:${selected}:${page}`) ?? "",
      );
    } catch {
      setRequest("");
    }
    if (!current) {
      setDraft(undefined);
      return;
    }
    const index = Math.min(page, current.outline.slides.length - 1);
    setPage(index);
    try {
      setDraft(
        JSON.parse(
          localStorage.getItem(draftKey(current.id, index)) ?? "null",
        ) ?? structuredClone(current.outline.slides[index]),
      );
    } catch {
      setDraft(structuredClone(current.outline.slides[index]));
    }
    setName(
      current.displayName ??
        `汇报 · ${new Date(current.createdAt).toLocaleString("zh-CN")}`,
    );
  }, [selected, page, current?.id]);
  async function action(task: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    } finally {
      actionLock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function generate() {
    await action(async () => {
      if (!paper) throw new Error("先选择论文，再生成汇报。");
      const state = await ensure();
      const noteText = useNotes
        ? notes
            .map((n) => `${n.title}：${n.text}`)
            .join("\n")
            .slice(0, 800)
        : "";
      await researchApi<AssistantTurn>(
        `/api/conversations/${state.id}/messages`,
        {
          clientMessageId: crypto.randomUUID(),
          mode: "live",
          paperId: paper.id,
          module: "ppt",
          slideCount: count,
          speechScript: withSpeech,
          sourceIds: [
            ...paper.sources.filter((s) => s.attachmentId).map((s) => s.id),
            ...preferredSources(paper.sources)
              .filter((s) => s.kind === "paper")
              .map((s) => s.id),
          ].slice(0, 100),
          question:
            `${question.trim() || "根据提供的论文材料生成清晰的汇报，结构与研究类型匹配，说明核心问题、方法、证据及局限。"}${noteText ? `\n以下是我的笔记偏好，论文事实须回到来源核对：\n${noteText}` : ""}`.slice(
              0,
              2000,
            ),
        },
      );
    });
  }
  async function edit(manual: boolean) {
    if (!current || !draft) return;
    await action(async () => {
      const version = await researchApi<DeckVersion>(
        `/api/deck-versions/${current.id}/edit`,
        {
          conversationId: current.conversationId,
          slideIndex: page,
          question:
            request || `保存我对第 ${page + 1} 页的修改，并核对事实与引用。`,
          ...(manual ? { slide: draft } : {}),
        },
      );
      if (!alive.current) return;
      setVersions((old) => [...old, version]);
      previousStatus.current.set(version.id, version.status);
    });
  }
  async function speech(manual: boolean) {
    if (!current) return;
    await action(async () => {
      const version = await researchApi<DeckVersion>(
        `/api/deck-versions/${current.id}/speech`,
        {
          conversationId: current.conversationId,
          question: manual
            ? "保存手动演讲稿，核对事实与稿页对应关系。"
            : speechRequest || "根据当前已保存页面补写或更新完整演讲稿。",
          ...(manual ? { speechScript: speechDraft } : {}),
        },
      );
      if (!alive.current) return;
      setVersions((old) => [...old, version]);
      previousStatus.current.set(version.id, version.status);
    });
  }
  async function cancel(id: string, kind: "turn" | "version") {
    if (cancelLocks.current.has(id)) return;
    cancelLocks.current.add(id);
    setCancelling((old) => [...old, id]);
    setError("");
    setNotice("");
    try {
      const result = await researchApi<{
        turn?: AssistantTurn;
        version?: DeckVersion;
      }>(
        `/api/${kind === "turn" ? "turns" : "deck-versions"}/${id}/cancel`,
        {},
      );
      if (!alive.current) return;
      if (result.version) {
        if (done(result.version))
          settledVersions.current.set(result.version.id, result.version);
        setVersions((old) =>
          old.map((v) => (v.id === id ? result.version! : v)),
        );
      }
      if (result.turn && finished(result.turn))
        setCancelledTurns((old) => [...old, id]);
      setNotice("任务已结束，已保存内容和未保存编辑保留，可以继续其他操作。");
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    } finally {
      cancelLocks.current.delete(id);
      if (alive.current)
        setCancelling((old) => old.filter((value) => value !== id));
    }
  }
  return (
    <section className="rw-ppt" aria-label="PPT 工作区">
      <header className="rw-ppt-header">
        <div>
          <small>当前论文与主聊天</small>
          <h1>{paper?.title ?? "论文汇报"}</h1>
        </div>
        <button onClick={onResearch}>返回论文研究</button>
      </header>
      {!paper ? (
        <p>在左侧选择论文，或导入 PDF 后开始汇报。</p>
      ) : (
        <>
          <p className="rw-ppt-materials">
            {paper.sources.filter((s) => s.kind === "paper").length} 处原文 ·{" "}
            {paper.sources.filter((s) => s.attachmentId).length} 张补图 ·{" "}
            {notes.length} 条笔记
          </p>
          <details className="rw-ppt-generate" open={!current}>
            <summary>生成新汇报</summary>
            <label>
              汇报要求（可选）
              <textarea
                aria-label="汇报重点"
                maxLength={1100}
                placeholder="例如：组会汇报，重点讲研究思路；也可以直接生成"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </label>
            <label>
              页数
              <select
                aria-label="汇报页数"
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              >
                {[3, 6, 9, 12].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            {!!notes.length && (
              <label>
                <input
                  type="checkbox"
                  checked={useNotes}
                  onChange={(e) => setUseNotes(e.target.checked)}
                />
                带上当前论文的 {notes.length} 条笔记
              </label>
            )}
            <label>
              <input
                type="checkbox"
                checked={withSpeech}
                onChange={(e) => setWithSpeech(e.target.checked)}
              />
              同时生成完整演讲稿
            </label>
            <button
              className="rp-primary"
              disabled={busy || generating.length > 0 || active.length > 0}
              onClick={() => void generate()}
            >
              生成汇报
            </button>
          </details>
          {generating.map((t) => (
            <p role="status" key={t.id}>
              {statusLabel[t.status]} · {t.message.question.slice(0, 55)}{" "}
              <button
                disabled={cancelling.includes(t.id)}
                onClick={() => void cancel(t.id, "turn")}
              >
                {cancelling.includes(t.id) ? "正在取消…" : "取消生成"}
              </button>
            </p>
          ))}
          {active.map((v) => (
            <p role="status" key={v.id}>
              {v.operation === "speech"
                ? v.status === "queued"
                  ? "等待处理演讲稿"
                  : "正在生成或核对演讲稿"
                : `${v.status === "queued" ? "等待修改" : "正在修改并核对"} · 第 ${(v.slideIndex ?? 0) + 1} 页`}{" "}
              <button
                disabled={cancelling.includes(v.id)}
                onClick={() => void cancel(v.id, "version")}
              >
                {cancelling.includes(v.id)
                  ? "正在取消…"
                  : v.operation === "speech"
                    ? "取消演讲稿任务"
                    : "取消修改"}
              </button>
            </p>
          ))}
          {notice && <p role="status">{notice}</p>}
          {error && (
            <p className="rw-error" role="alert">
              {error}
            </p>
          )}
          {!!versions.length && (
            <label className="rw-version-picker">
              保存版本
              <select
                aria-label="保存版本"
                value={selected ?? ""}
                onChange={(e) => {
                  setPage(0);
                  setSelected(e.target.value);
                }}
              >
                {[...versions].reverse().map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.displayName ??
                      new Date(v.createdAt).toLocaleString("zh-CN")}{" "}
                    ·{" "}
                    {v.status === "completed"
                      ? "已保存并核对"
                      : v.status === "failed"
                        ? v.operation === "speech"
                          ? "演讲稿未完成"
                          : "修改失败"
                        : v.status === "cancelled"
                          ? "已停止"
                          : v.status === "interrupted"
                            ? "已中断"
                            : "处理中"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className={`rw-ppt-body ${editing ? "rw-ppt-editing" : ""}`}>
            <aside
              className="rw-ppt-list"
              style={{ width: layout.pptList }}
              aria-label="汇报记录"
            >
              <h2>幻灯片</h2>
              {!versions.length && <p>生成后在这里预览、逐页修改和导出。</p>}
              {current && (
                <div className="rw-slide-list">
                  {current.outline.slides.map((s, i) => (
                    <ObjectMenu
                      key={i}
                      objectKey={`${current.id}:${i}`}
                      label={`第 ${i + 1} 页操作`}
                      actions={[
                        {
                          label: "编辑这一页",
                          run: () => {
                            setPage(i);
                            setEditing(true);
                          },
                        },
                        {
                          label: "提出修改要求",
                          run: () => {
                            setPage(i);
                            setEditing(true);
                          },
                        },
                        {
                          label: "查看本页来源",
                          run: () => onCitation(s.citations[0]),
                        },
                      ]}
                    >
                      <button
                        aria-pressed={page === i}
                        key={i}
                        onClick={() => setPage(i)}
                      >
                        第 {i + 1} 页 · {s.title}
                      </button>
                    </ObjectMenu>
                  ))}
                </div>
              )}
            </aside>
            <Splitter
              label="调整汇报列表宽度"
              value={layout.pptList}
              min={180}
              max={380}
              onChange={(v) => resize("pptList", v)}
              className="rw-ppt-list-split"
            />
            <div className="rw-ppt-preview" key={`${current?.id}:${page}`}>
              {current && draft && (
                <>
                  <details>
                    <summary>{name} · 汇报名称</summary>
                    <div className="rw-ppt-name">
                      <input
                        aria-label="汇报名称"
                        maxLength={120}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                      <button
                        disabled={busy || !name.trim()}
                        onClick={() =>
                          void action(async () => {
                            const value = await researchApi<DeckVersion>(
                              `/api/deck-versions/${current.id}/name`,
                              {
                                conversationId: current.conversationId,
                                displayName: name,
                              },
                              "PATCH",
                            );
                            if (alive.current)
                              setVersions((old) =>
                                old.map((v) => (v.id === value.id ? value : v)),
                              );
                          })
                        }
                      >
                        保存名称
                      </button>
                    </div>
                  </details>
                  <button onClick={() => setEditing(true)}>编辑这一页</button>
                  <article
                    className="rw-slide"
                    aria-label={"第 " + (page + 1) + " 页预览"}
                  >
                    {changed && <small>未保存编辑</small>}
                    <ResearchSlide
                      slide={draft}
                      paper={paper}
                      url={imageUrl}
                      crop={imageAsset ? undefined : draft.imageCrop}
                      page={page + 1}
                      total={current.outline.slides.length}
                    />
                  </article>
                  {imageSource && imageUrl && (
                    <ResearchImage
                      url={imageUrl}
                      title={imageSource.title}
                      caption=""
                      onPage={
                        imageSource.page && paper.pdfUrl
                          ? () => onCitation(imageSource.id)
                          : undefined
                      }
                    />
                  )}
                  <div className="rw-evidence">
                    {draft.citations.map((id) => (
                      <button
                        className="rw-citation-chip"
                        key={id}
                        onClick={() => onCitation(id)}
                      >
                        {paper.sources.find((s) => s.id === id)?.title ?? id} ↗
                      </button>
                    ))}
                  </div>
                  <details>
                    <summary>讲稿</summary>
                    <p className="rw-ppt-notes">{draft.notes}</p>
                  </details>
                  <details>
                    <summary>完整演讲稿</summary>
                    {!!unsavedPages.length && (
                      <p className="hint">
                        第 {unsavedPages.join("、")}{" "}
                        页还有未保存修改。请先保存并核对这些页面，再更新讲稿；导出对应已保存版本。
                      </p>
                    )}
                    {!current.outline.speechScript &&
                      current.parentId &&
                      versions.find((v) => v.id === current.parentId)?.outline
                        .speechScript && (
                        <p className="hint">
                          页面已修改，可重新生成对应演讲稿。
                        </p>
                      )}
                    <p className="hint">
                      根据已保存的 PPT
                      页面生成，包含开场、逐页讲述、转场和结尾。
                    </p>
                    {(current.outline.speechScript || speechDraft) &&
                      !speechEditing && (
                        <div aria-label="完整演讲稿预览">
                          <p className="rw-ppt-notes">{speechDraft}</p>
                          {speechChanged && <small>正在预览未保存修改。</small>}
                        </div>
                      )}
                    {(current.outline.speechScript || speechDraft) &&
                      speechEditing && (
                        <label>
                          演讲稿正文
                          <textarea
                            aria-label="完整演讲稿正文"
                            rows={12}
                            maxLength={24000}
                            value={speechDraft}
                            onChange={(e) => {
                              setSpeechDraft(e.target.value);
                              localStorage.setItem(
                                `research-speech-draft:${current.id}`,
                                e.target.value,
                              );
                            }}
                          />
                        </label>
                      )}
                    <div className="rw-actions">
                      {(current.outline.speechScript || speechDraft) && (
                        <button onClick={() => setSpeechEditing((old) => !old)}>
                          {speechEditing ? "返回讲稿阅读" : "编辑演讲稿"}
                        </button>
                      )}
                      <button
                        disabled={
                          busy ||
                          active.length > 0 ||
                          current.status !== "completed" ||
                          unsavedPages.length > 0 ||
                          speechChanged
                        }
                        onClick={() => void speech(false)}
                      >
                        {current.outline.speechScript
                          ? "重新生成演讲稿"
                          : "补写演讲稿"}
                      </button>
                      {speechChanged && (
                        <>
                          <button
                            disabled={
                              busy ||
                              active.length > 0 ||
                              !speechDraft.trim() ||
                              unsavedPages.length > 0
                            }
                            onClick={() => void speech(true)}
                          >
                            保存演讲稿
                          </button>
                          <button
                            onClick={() => {
                              setSpeechDraft(
                                current.outline.speechScript ?? "",
                              );
                              localStorage.removeItem(
                                `research-speech-draft:${current.id}`,
                              );
                            }}
                          >
                            放弃演讲稿修改
                          </button>
                        </>
                      )}
                      {current.outline.speechScript && !speechChanged && (
                        <>
                          <a
                            href={`/api/deck-versions/${current.id}/speech?conversationId=${current.conversationId}`}
                            download
                          >
                            导出演讲稿（Markdown）
                          </a>
                          <a
                            href={`/api/deck-versions/${current.id}/speech?conversationId=${current.conversationId}&format=txt`}
                            download
                          >
                            导出演讲稿（TXT）
                          </a>
                        </>
                      )}
                    </div>
                    <label>
                      讲稿修改要求
                      <textarea
                        aria-label="讲稿修改要求"
                        maxLength={2000}
                        value={speechRequest}
                        placeholder="例如：补充实验为什么这样设计，缩短开场"
                        onChange={(e) => {
                          setSpeechRequest(e.target.value);
                          localStorage.setItem(
                            `research-speech-request:${current.id}`,
                            e.target.value,
                          );
                        }}
                      />
                    </label>
                    {!!speechRequest.trim() && (
                      <button
                        disabled={
                          busy ||
                          active.length > 0 ||
                          unsavedPages.length > 0 ||
                          speechChanged ||
                          current.status !== "completed"
                        }
                        onClick={() => void speech(false)}
                      >
                        按要求修改讲稿并核对
                      </button>
                    )}
                    {storedDraft(`research-speech-conflict:${current.id}`) !==
                      null && (
                      <button
                        onClick={() => {
                          const prior = storedDraft(
                            `research-speech-conflict:${current.id}`,
                          );
                          if (prior !== null) {
                            setSpeechDraft(prior);
                            try {
                              localStorage.setItem(
                                `research-speech-draft:${current.id}`,
                                prior,
                              );
                            } catch {}
                            setSpeechEditing(true);
                            setNotice(
                              "已恢复旧讲稿修改供比较，保存后需重新核对。",
                            );
                          }
                        }}
                      >
                        恢复另一份未保存讲稿供比较
                      </button>
                    )}
                    {(changed ||
                      localStorage.getItem(
                        `research-speech-draft-base:${current.id}`,
                      )) && (
                      <p className="hint">
                        页面和讲稿分别保留。先保存并核对页面；讲稿基于旧页面时需比较并重新核对，不能作为新页面的已核对讲稿导出。
                      </p>
                    )}
                  </details>
                  <details>
                    <summary>核对结果与版本差异</summary>
                    {current.review.issues.length ? (
                      current.review.issues.map((i) => (
                        <p key={i.id}>
                          {i.resolved ? "已处理" : "待处理"} · {i.suggestion}
                        </p>
                      ))
                    ) : (
                      <p>未发现待处理核对项。</p>
                    )}
                    {current.parentId && (
                      <p>
                        基于版本 {current.parentId.slice(0, 8)} 修改
                        {current.slideIndex !== undefined
                          ? `第 ${current.slideIndex + 1} 页`
                          : ""}
                        。{current.request}
                      </p>
                    )}
                    {current.error && <p>{current.error}</p>}
                  </details>
                  <div className="rw-actions">
                    <button
                      disabled={
                        busy ||
                        current.status !== "completed" ||
                        Boolean(changed)
                      }
                      onClick={() =>
                        void action(async () => {
                          const result = await researchApi<{ url: string }>(
                            `/api/deck-versions/${current.id}/export`,
                            { conversationId: current.conversationId },
                          );
                          if (alive.current) setExportUrl(result.url);
                        })
                      }
                    >
                      导出当前保存版本
                    </button>
                    {selected !==
                      versions.filter((v) => v.status === "completed").at(-1)
                        ?.id && (
                      <button
                        disabled={busy || current.status !== "completed"}
                        onClick={() =>
                          void action(async () => {
                            const latest = versions
                              .filter((v) => v.status === "completed")
                              .at(-1)!;
                            const restored = await researchApi<DeckVersion>(
                              `/api/deck-versions/${latest.id}/restore`,
                              {
                                conversationId: current.conversationId,
                                targetId: current.id,
                              },
                            );
                            if (alive.current) {
                              setVersions((old) => [...old, restored]);
                              setSelected(restored.id);
                            }
                          })
                        }
                      >
                        恢复为新版本
                      </button>
                    )}
                    {exportUrl && (
                      <a className="rw-download" href={exportUrl} download>
                        下载 PPTX
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
            {editing && (
              <Splitter
                label="调整汇报编辑区宽度"
                value={layout.pptEditor}
                min={260}
                max={480}
                reverse
                onChange={(v) => resize("pptEditor", v)}
                className="rw-ppt-editor-split"
              />
            )}
            {editing && (
              <aside
                className="rw-ppt-editor"
                style={{ width: layout.pptEditor }}
                aria-label="指定页编辑"
              >
                {current && draft && (
                  <>
                    {storedDraft(
                      `research-ppt-conflict:${current.id}:${page}`,
                    ) !== null && (
                      <button
                        onClick={() => {
                          const prior = storedDraft(
                            `research-ppt-conflict:${current.id}:${page}`,
                          );
                          if (prior) {
                            try {
                              changeDraft(JSON.parse(prior));
                              setNotice(
                                "已恢复旧页面修改供比较，保存后需重新核对。",
                              );
                            } catch {
                              setError(
                                "旧页面草稿无法读取，已保留原记录；当前保存版本仍可查看。",
                              );
                            }
                          }
                        }}
                      >
                        恢复另一份未保存页面供比较
                      </button>
                    )}
                    <h2>编辑第 {page + 1} 页</h2>
                    <button onClick={() => setEditing(false)}>返回预览</button>
                    <p role="status">
                      {changed
                        ? "未保存编辑；关闭编辑后草稿继续保留。"
                        : "当前页与保存版本一致。"}
                    </p>
                    <label>
                      标题
                      <input
                        aria-label="幻灯片标题"
                        maxLength={65}
                        value={draft.title}
                        onChange={(e) =>
                          changeDraft({ ...draft, title: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      要点 · 每行一条
                      <textarea
                        aria-label="幻灯片要点"
                        value={draft.bullets.join("\n")}
                        onChange={(e) =>
                          changeDraft({
                            ...draft,
                            bullets: e.target.value.split("\n"),
                          })
                        }
                      />
                    </label>
                    <label>
                      讲稿
                      <textarea
                        aria-label="幻灯片讲稿"
                        maxLength={2000}
                        value={draft.notes}
                        onChange={(e) =>
                          changeDraft({ ...draft, notes: e.target.value })
                        }
                      />
                    </label>
                    <details>
                      <summary>配图与裁剪</summary>
                      <label>
                        这一页的图件
                        <select
                          aria-label="幻灯片配图"
                          value={draft.imageSource ?? ""}
                          onChange={(e) =>
                            changeDraft({
                              ...draft,
                              imageSource: e.target.value || undefined,
                              imageCrop: undefined,
                              citations: [
                                ...new Set([
                                  ...draft.citations,
                                  ...(e.target.value ? [e.target.value] : []),
                                ]),
                              ],
                            })
                          }
                        >
                          <option value="">不配图</option>
                          {paper.sources
                            .filter((s) => s.image || (s.page && paper.pdfUrl))
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.title}
                                {s.page ? " · PDF " + s.page : ""}
                              </option>
                            ))}
                        </select>
                      </label>
                      {imageSource && originalImageUrl && (
                        <ImageCrop
                          key={imageSource.id}
                          url={originalImageUrl}
                          value={draft.imageCrop}
                          onChange={(imageCrop) =>
                            changeDraft({ ...draft, imageCrop })
                          }
                        />
                      )}
                    </details>
                    {changed && (
                      <button
                        onClick={() => {
                          localStorage.removeItem(draftKey(current.id, page));
                          setDraft(
                            structuredClone(current.outline.slides[page]),
                          );
                        }}
                      >
                        放弃这页未保存编辑
                      </button>
                    )}
                    <button
                      disabled={
                        busy ||
                        active.length > 0 ||
                        (!changed &&
                          !["failed", "cancelled", "interrupted"].includes(
                            current.status,
                          )) ||
                        !draft.title.trim() ||
                        !draft.notes.trim() ||
                        draft.bullets.length > 5 ||
                        draft.bullets.some((s) => !s.trim() || s.length > 140)
                      }
                      onClick={() => void edit(true)}
                    >
                      保存指定页并核对
                    </button>
                    <label>
                      修改要求
                      <textarea
                        aria-label="单页修改要求"
                        maxLength={2000}
                        placeholder="例如：机制讲得更清楚，保留来源"
                        value={request}
                        onChange={(e) => {
                          setRequest(e.target.value);
                          try {
                            localStorage.setItem(
                              `research-ppt-request:${selected}:${page}`,
                              e.target.value,
                            );
                          } catch {}
                        }}
                      />
                    </label>
                    <button
                      disabled={busy || active.length > 0 || !request.trim()}
                      onClick={() => void edit(false)}
                    >
                      按要求修改这一页
                    </button>
                  </>
                )}
              </aside>
            )}
          </div>
        </>
      )}
    </section>
  );
}
