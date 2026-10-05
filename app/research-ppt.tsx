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

const done = (v: DeckVersion) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(v.status);
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
  const [versions, setVersions] = useState<DeckVersion[]>([]),
    [selected, setSelected] = useState<string>();
  const [page, setPage] = useState(0),
    [draft, setDraft] = useState<Slide>(),
    [request, setRequest] = useState("");
  const [question, setQuestion] = useState(
      "围绕研究问题、实验设计、主要结果和讨论生成汇报",
    ),
    [count, setCount] = useState(6);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [exportUrl, setExportUrl] = useState(""),
    [name, setName] = useState("");
  const [useNotes, setUseNotes] = useState(true);
  const alive = useRef(true),
    previousStatus = useRef(new Map<string, string>());
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
      (t.message.module === "ppt" || t.plan?.modules.includes("ppt")),
  );
  const changed =
    current &&
    draft &&
    JSON.stringify(draft) !== JSON.stringify(current.outline.slides[page]);
  useEffect(() => {
    alive.current = true;
    let closed = false;
    async function refresh() {
      if (!conversation || !paper) return;
      try {
        const values = await researchApi<DeckVersion[]>(
          `/api/deck-versions?conversationId=${conversation.id}&paperId=${paper.id}`,
        );
        if (closed) return;
        setVersions(values);
        const newest = values.filter((v) => v.status === "completed").at(-1);
        const completed = values.find(
          (v) =>
            v.status === "completed" &&
            previousStatus.current.size > 0 &&
            previousStatus.current.get(v.id) !== "completed",
        );
        if (completed) {
          if (completed.parentId) {
            completed.outline.slides.forEach((_slide, i) => {
              const prior = localStorage.getItem(
                draftKey(completed.parentId!, i),
              );
              if (prior && i !== completed.slideIndex)
                localStorage.setItem(draftKey(completed.id, i), prior);
            });
            if (completed.slideIndex !== undefined)
              localStorage.removeItem(
                draftKey(completed.parentId, completed.slideIndex),
              );
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
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 900);
    return () => {
      closed = true;
      alive.current = false;
      clearInterval(timer);
    };
  }, [conversation?.id, paper?.id]);
  useEffect(() => {
    setExportUrl("");
    setRequest("");
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
  }, [selected, page]);
  async function action(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    } finally {
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
          sourceIds: [
            ...paper.sources
              .filter(
                (s) =>
                  s.kind === "paper" && !s.image && s.section !== "methods",
              )
              .slice(0, 4)
              .map((s) => s.id),
            ...paper.sources.filter((s) => s.attachmentId).map((s) => s.id),
          ],
          question:
            `${question}${noteText ? `\n以下是我的笔记偏好，论文事实须回到来源核对：\n${noteText}` : ""}`.slice(
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
              汇报重点
              <textarea
                aria-label="汇报重点"
                maxLength={1100}
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
            <button
              className="rp-primary"
              disabled={busy || !question.trim()}
              onClick={() => void generate()}
            >
              生成汇报
            </button>
          </details>
          {generating.map((t) => (
            <p role="status" key={t.id}>
              {statusLabel[t.status]} · {t.message.question.slice(0, 55)}{" "}
              <button
                onClick={() =>
                  void researchApi(`/api/turns/${t.id}/cancel`, {}).catch(
                    (err) => setError(err.message),
                  )
                }
              >
                {t.status === "queued" ? "取消等待" : "停止生成"}
              </button>
            </p>
          ))}
          {active.map((v) => (
            <p role="status" key={v.id}>
              {v.status === "queued" ? "等待修改" : "正在修改并核对"} · 第{" "}
              {(v.slideIndex ?? 0) + 1} 页{" "}
              <button
                onClick={() =>
                  void researchApi(
                    `/api/deck-versions/${v.id}/cancel`,
                    {},
                  ).catch((err) => setError(err.message))
                }
              >
                停止修改
              </button>
            </p>
          ))}
          {error && (
            <p className="rw-error" role="alert">
              {error}
            </p>
          )}
          <div className="rw-ppt-body">
            <aside
              className="rw-ppt-list"
              style={{ width: layout.pptList }}
              aria-label="汇报记录"
            >
              <h2>汇报记录</h2>
              {!versions.length && <p>生成后在这里预览、逐页修改和导出。</p>}
              {[...versions].reverse().map((v) => (
                <button
                  key={v.id}
                  aria-pressed={selected === v.id}
                  onClick={() => {
                    setPage(0);
                    setSelected(v.id);
                  }}
                >
                  {v.displayName ??
                    new Date(v.createdAt).toLocaleString("zh-CN")}
                  <small>
                    {v.status === "completed"
                      ? `${v.outline.slides.length} 页 · 已核对`
                      : v.status === "failed"
                        ? "修改失败"
                        : v.status === "cancelled"
                          ? "已停止"
                          : v.status === "interrupted"
                            ? "已中断"
                            : "处理中"}
                  </small>
                </button>
              ))}
              {current && (
                <div className="rw-slide-list">
                  {current.outline.slides.map((s, i) => (
                    <button
                      aria-pressed={page === i}
                      key={i}
                      onClick={() => setPage(i)}
                    >
                      第 {i + 1} 页 · {s.title}
                    </button>
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
            <div className="rw-ppt-preview">
              {current && draft && (
                <>
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
                  <article
                    className="rw-slide"
                    aria-label={`第 ${page + 1} 页预览`}
                  >
                    <small>
                      第 {page + 1} / {current.outline.slides.length} 页
                      {changed ? " · 未保存编辑" : ""}
                    </small>
                    <h2>{draft.title}</h2>
                    <ul>
                      {draft.bullets.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                    {draft.imageSource &&
                      paper.sources.find((s) => s.id === draft.imageSource)
                        ?.image && (
                        <img
                          src={
                            paper.sources.find(
                              (s) => s.id === draft.imageSource,
                            )!.image
                          }
                          alt="来源图件"
                        />
                      )}
                  </article>
                  <div className="rw-evidence">
                    {draft.citations.map((id) => (
                      <button key={id} onClick={() => onCitation(id)}>
                        {paper.sources.find((s) => s.id === id)?.title ?? id} ↗
                      </button>
                    ))}
                  </div>
                  <details open>
                    <summary>讲稿</summary>
                    <p className="rw-ppt-notes">{draft.notes}</p>
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
            <Splitter
              label="调整汇报编辑区宽度"
              value={layout.pptEditor}
              min={260}
              max={480}
              reverse
              onChange={(v) => resize("pptEditor", v)}
              className="rw-ppt-editor-split"
            />
            <aside
              className="rw-ppt-editor"
              style={{ width: layout.pptEditor }}
              aria-label="指定页编辑"
            >
              {current && draft && (
                <>
                  <h2>编辑第 {page + 1} 页</h2>
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
                  {changed && (
                    <button
                      onClick={() => {
                        localStorage.removeItem(draftKey(current.id, page));
                        setDraft(structuredClone(current.outline.slides[page]));
                      }}
                    >
                      放弃这页未保存编辑
                    </button>
                  )}
                  <button
                    disabled={
                      busy ||
                      active.length > 0 ||
                      !changed ||
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
                      onChange={(e) => setRequest(e.target.value)}
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
          </div>
        </>
      )}
    </section>
  );
}
