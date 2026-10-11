import { ResearchMarkdown } from "./markdown.tsx";
import { selectedText } from "./research-selection.ts";
import { measureReadableAnswer } from "./response-timing.ts";
import { MessageAttachments } from "./research-attachments.tsx";
import { useEffect, useRef, useState } from "react";
import type { AssistantMessage, PaperBundle, Source } from "../shared/types.ts";
import type { ReadingStart, ResearchTurn } from "../shared/workspace.ts";
import {
  ObjectMenu,
  SelectionActions,
  type ObjectAction,
} from "./research-menu.tsx";
import { ResearchImage } from "./research-image.tsx";
import { focusLabels, verbosityLabels } from "../shared/learning-intent.ts";

export interface ResearchSelection {
  label: string;
  sourceAnchor?: AssistantMessage["sourceAnchor"];
  focus?: AssistantMessage["focus"];
  figureSourceId?: string;
}
export const finished = (turn: ResearchTurn) =>
  ["completed", "failed", "cancelled", "interrupted", "clarification"].includes(
    turn.status,
  );
export const statusLabel: Record<string, string> = {
  queued: "等待中",
  "checking-attachments": "正在思考…",
  planning: "正在思考…",
  running: "正在思考…",
  teaching: "正在思考…",
  novice: "正在思考…",
  checking: "正在思考…",
  revising: "正在思考…",
  rereading: "正在思考…",
  rechecking: "正在思考…",
  completed: "已完成",
  failed: "请求失败",
  cancelled: "已取消",
  interrupted: "请求已中断",
  clarification: "需要补充信息",
};
function citationGroups(
  ids: string[],
  paper: PaperBundle | undefined,
  materials: Source[],
) {
  const groups = new Map<
    string,
    { entries: { id: string; source?: Source }[] }
  >();
  for (const id of new Set(ids)) {
    const source =
      materials.find((s) => s.id === id) ??
      paper?.sources.find((s) => s.id === id);
    const samePage =
      source?.kind === "paper" && !source.attachmentId && source.page;
    const key = samePage
      ? JSON.stringify([
          source.paperId ?? paper?.id ?? id,
          source.paperVersion ?? paper?.version ?? id,
          source.page,
        ])
      : id;
    const group = groups.get(key) ?? { entries: [] };
    group.entries.push({ id, source });
    groups.set(key, group);
  }
  return [...groups.entries()];
}
export function AnswerSources({
  ids,
  paper,
  materials,
  onCitation,
}: {
  ids: string[];
  paper?: PaperBundle;
  materials: Source[];
  onCitation: (id: string, source?: Source) => void;
}) {
  const groups = citationGroups(ids, paper, materials);
  const original = groups.filter(([, group]) =>
    group.entries.some(
      (e) => e.source?.kind === "paper" && !e.source.attachmentId,
    ),
  );
  const supplements = groups.filter((group) => !original.includes(group));
  const originals = original.flatMap(([, group]) => group.entries);
  const first = originals[0];
  if (!first && !supplements.length) return null;
  return (
    <div className="rw-answer-sources">
      {first && (
        <div className="rw-evidence">
          <ObjectMenu
            objectKey={ids.join(":")}
            label="选择原文位置"
            actions={
              originals.length > 1
                ? originals.map((entry) => ({
                    label: [
                      entry.source?.page ? `第 ${entry.source.page} 页` : "",
                      entry.source?.figure ? `图 ${entry.source.figure}` : "",
                      entry.source?.caption ? "图注" : "正文",
                      entry.source?.title,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                    run: () => onCitation(entry.id, entry.source),
                  }))
                : []
            }
          >
            <button
              type="button"
              className="rw-citation-chip"
              onClick={() => onCitation(first.id, first.source)}
            >
              {paper?.pdfUrl ? "查看 PDF 原文" : "查看原文"}{" "}
              <span aria-hidden="true">↗</span>
            </button>
          </ObjectMenu>
        </div>
      )}
      {supplements.length > 0 && (
        <details>
          <summary>补充来源</summary>
          {supplements
            .flatMap(([, group]) => group.entries)
            .map((entry) => (
              <button
                type="button"
                key={entry.id}
                className="rw-citation-chip"
                onClick={() => onCitation(entry.id, entry.source)}
              >
                {entry.source?.title ?? "查看来源"}
              </button>
            ))}
        </details>
      )}
    </div>
  );
}
export function ResearchDiscussion({
  turns,
  paper,
  conversationId,
  readingSession,
  start,
  onGuide,
  onCancelGuide,
  busy,
  onSuggest,
  onImport,
  onIdea,
  onCitation,
  onFocus,
  onSave,
  onRecord,
  onCancel,
  onAttachmentRetry,
  onRetry,
  savedIds,
  latestTitle,
  onResume,
}: {
  turns: ResearchTurn[];
  paper?: PaperBundle;
  conversationId?: string;
  readingSession?: import("../shared/reading-session.ts").ReadingSession;
  start?: ReadingStart;
  onGuide: () => void;
  onCancelGuide: () => void;
  busy: boolean;
  onSuggest: (question: string) => void;
  onImport: () => void;
  onIdea: () => void;
  onCitation: (id: string, source?: Source) => void;
  onFocus: (selection: ResearchSelection, question: string) => void;
  onSave: (turn: ResearchTurn) => void;
  onRecord: (
    turn: ResearchTurn,
    kind: "favorite" | "feedback",
    feedback?: "confused" | "understood",
  ) => void;
  onCancel: (turn: ResearchTurn) => Promise<unknown>;
  onAttachmentRetry: (turn: ResearchTurn, id: string, purpose?: string) => void;
  onRetry: (turn: ResearchTurn) => void;
  savedIds: string[];
  latestTitle?: string;
  onResume: () => void;
}) {
  const [selectedSentence, setSelectedSentence] = useState<{
    turnId: string;
    index: number;
    text: string;
  }>();
  const messages = useRef<HTMLDivElement>(null);
  const [presentationTick, setPresentationTick] = useState(0);
  useEffect(() => {
    const pending = turns.map((turn) => Date.parse(turn.preparedDisplayAt ?? ""))
      .filter((time) => time > Date.now());
    if (!pending.length) return;
    const timer = setTimeout(() => setPresentationTick((tick) => tick + 1),
      Math.max(0, Math.min(...pending) - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [turns, presentationTick]);
  const [cancelling, setCancelling] = useState<string[]>([]);
  const cancelLocks = useRef(new Set<string>());
  const measureAnswers = () => {
    for (const turn of turns)
      if (turn.status === "completed" && turn.reply?.content)
        measureReadableAnswer(
          turn.id,
          messages.current?.querySelector(
            `[data-turn-id="${CSS.escape(turn.id)}"] .rw-answer`,
          ) ?? null,
        );
  };
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(measureAnswers);
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [turns, presentationTick]);
  async function cancel(turn: ResearchTurn) {
    if (cancelLocks.current.has(turn.id)) return;
    cancelLocks.current.add(turn.id);
    setCancelling((old) => [...old, turn.id]);
    try {
      await onCancel(turn);
    } finally {
      cancelLocks.current.delete(turn.id);
      setCancelling((old) => old.filter((id) => id !== turn.id));
    }
  }
  const scrollKey = `research-chat-scroll:${paper?.id ?? "idea"}:${conversationId ?? "new"}`;
  const follow = useRef(false);
  const previousTurns = useRef<
    { key: string; statuses: Map<string, string> } | undefined
  >(undefined);
  const [newContent, setNewContent] = useState(false);
  useEffect(() => {
    const el = messages.current;
    if (!el) return;
    const prior = previousTurns.current;
    const changed =
      prior?.key === scrollKey &&
      turns.some(
        (t) =>
          !prior.statuses.has(t.id) ||
          (prior.statuses.get(t.id) !== t.status && t.status === "completed"),
      );
    previousTurns.current = {
      key: scrollKey,
      statuses: new Map(turns.map((t) => [t.id, t.status])),
    };
    if (!prior || prior.key !== scrollKey) {
      setNewContent(false);
      follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 70;
      return;
    }
    if (changed && follow.current) {
      el.scrollTop = el.scrollHeight;
      setNewContent(false);
    } else if (changed) setNewContent(true);
  }, [turns.length, turns.map((t) => `${t.id}:${t.status}`).join("|")]);
  useEffect(() => {
    setSelectedSentence(undefined);
    try {
      if (messages.current)
        messages.current.scrollTop =
          Number(localStorage.getItem(scrollKey)) || 0;
    } catch {}
  }, [scrollKey]);
  useEffect(() => {
    const clear = () => {
      const selection = window.getSelection();
      if (
        !selection?.toString() ||
        !selection.anchorNode?.parentElement?.closest(".rw-answer")
      )
        setSelectedSentence(undefined);
    };
    document.addEventListener("selectionchange", clear);
    return () => document.removeEventListener("selectionchange", clear);
  }, []);
  return (
    <div
      ref={messages}
      className="rp-messages rw-messages"
      aria-label="连续研究讨论"
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 70;
        if (follow.current) setNewContent(false);
        requestAnimationFrame(() => requestAnimationFrame(measureAnswers));
        try {
          localStorage.setItem(scrollKey, String(e.currentTarget.scrollTop));
        } catch {}
      }}
    >
      {readingSession && (
        <div className="rw-reading-progress" role="status">
          <small>{readingSession.label}</small>
          <div className="rw-actions">
            {["继续带读", ...(readingSession.topic ? ["回到主线"] : [])].map(
              (q) => (
                <button key={q} disabled={busy} onClick={() => onSuggest(q)}>
                  {q}
                </button>
              ),
            )}
          </div>
        </div>
      )}
      {newContent && (
        <button
          className="rw-latest-content"
          onClick={() => {
            if (messages.current)
              messages.current.scrollTop = messages.current.scrollHeight;
            follow.current = true;
            setNewContent(false);
          }}
        >
          回到最新内容
        </button>
      )}
      {!turns.length && (
        <section className="rp-welcome">
          <div className="rp-welcome-icon">◎</div>
          <h2>{paper ? "中文带读，也可以直接提问" : "从一篇论文开始"}</h2>
          {paper ? (
            <>
              <p>
                {paper.parseStatus === "failed"
                  ? "PDF 解析失败，原文件已保留。请重新提供可读取的 PDF。"
                  : paper.parseStatus === "needs-text"
                    ? "该 PDF 未提取到可用正文。可上传可复制文字的版本，或在资料面板补充原文。"
                    : "可以直接提问，也可以先从下面的问题开始。"}
              </p>
              {start?.status === "completed" && start.summary && (
                <div className="rw-start-excerpt">
                  <small>{start.label}</small>
                  <p>{start.summary}</p>
                  {start.coverage && (
                    <small>
                      依据 {start.coverage.sourceIds.length} /{" "}
                      {start.coverage.availableSources} 个正文片段整理
                      {start.coverage.truncatedSourceIds.length
                        ? "，长片段已截取"
                        : ""}
                      ；可继续查阅全文。
                    </small>
                  )}
                  <AnswerSources
                    ids={
                      start.sourceIds ??
                      (start.sourceId ? [start.sourceId] : [])
                    }
                    paper={paper}
                    materials={[]}
                    onCitation={onCitation}
                  />
                </div>
              )}
              {start?.status !== "completed" &&
                (["queued", "running"].includes(start?.status ?? "") ? (
                  <button onClick={onCancelGuide}>停止整理研究起点</button>
                ) : (
                  <button disabled={busy} onClick={onGuide}>
                    开始中文带读
                  </button>
                ))}
              {start?.error && <p role="alert">{start.error}</p>}
              {(start?.status === "completed"
                ? start.questions.slice(0, 1)
                : ["这篇论文提出了什么研究问题？"]
              ).map((q) => (
                <button key={q} disabled={busy} onClick={() => onSuggest(q)}>
                  {q}
                  <span>↗</span>
                </button>
              ))}
              {start?.questions && start.questions.length > 1 && (
                <details>
                  <summary>更多问题</summary>
                  {start.questions.slice(1).map((q) => (
                    <button key={q} onClick={() => onSuggest(q)}>
                      {q}
                    </button>
                  ))}
                </details>
              )}
            </>
          ) : (
            <>
              <p>导入后一起理解研究问题、方法和证据。课题整理可以稍后进行。</p>
              <button disabled={busy} onClick={onImport}>
                ＋ 导入论文
              </button>
            </>
          )}
          {latestTitle && (
            <button disabled={busy} onClick={onResume}>
              继续上次讨论 · {latestTitle}
            </button>
          )}
        </section>
      )}
      {turns.map((turn) => {
        const preparing = turn.status === "completed" &&
          Date.parse(turn.preparedDisplayAt ?? "") > Date.now();
        const unit = preparing ? undefined : turn.reply?.content;
        const complete = turn.status === "completed";
        const actions: ObjectAction[] =
          complete && unit
            ? [
                {
                  label: "复制回答",
                  run: () =>
                    void navigator.clipboard.writeText(
                      [
                        unit.title,
                        ...unit.sections.map((s) => `${s.title}\n${s.text}`),
                      ].join("\n\n"),
                    ),
                },
                {
                  label: "调整讲解",
                  children: [
                    "简单点",
                    "常规讲解",
                    "详细点",
                    "从基础讲",
                    "重点解释机制",
                    "重点讲研究思路",
                    "重点讲方法与图表",
                  ].map((text) => ({
                    label: text,
                    run: () => onSuggest(`${text}，继续解释上一轮完整问题。`),
                  })),
                },
              ]
            : [];
        return (
          <article key={turn.id} className="rw-turn" data-turn-id={turn.id}>
            <div className="rp-user-message">
              <div>
                {turn.message.sourceAnchor && (
                  <blockquote>
                    第 {turn.message.sourceAnchor.page ?? "未知"} 页 ·{" "}
                    {turn.message.sourceAnchor.excerpt}
                  </blockquote>
                )}
                {turn.message.focus && (
                  <blockquote>{turn.message.focus.excerpt}</blockquote>
                )}
                {turn.message.figureSourceId && (
                  <small>图件：{turn.message.figureSourceId}</small>
                )}
                <p>{turn.message.question}</p>
                {!!turn.attachments?.length && (
                  <MessageAttachments
                    values={turn.attachments}
                    disabled={!finished(turn)}
                    onRetry={(id, purpose) =>
                      onAttachmentRetry(turn, id, purpose)
                    }
                  />
                )}
              </div>
            </div>
            <ObjectMenu objectKey={turn.id} label="回答操作" actions={actions}>
              <div className="rw-answer">
                {preparing && <small role="status">正在准备讲解…</small>}
                {!complete && (
                  <small>
                    {statusLabel[
                      !finished(turn) && turn.run
                        ? turn.run.status
                        : turn.status
                    ] ?? turn.status}
                  </small>
                )}
                {!finished(turn) && (
                  <button
                    disabled={cancelling.includes(turn.id)}
                    onClick={() => void cancel(turn)}
                  >
                    {cancelling.includes(turn.id)
                      ? "正在取消…"
                      : turn.status === "queued"
                        ? "取消等待"
                        : "取消回答"}
                  </button>
                )}
                {[
                  "cancelled",
                  "failed",
                  "interrupted",
                  "clarification",
                ].includes(turn.status) && (
                  <button onClick={() => onRetry(turn)}>编辑后重发</button>
                )}
                {unit && (
                  <>
                    <h2>{unit.title}</h2>
                    {paper &&
                      paper.version === turn.sourceVersion &&
                      [...new Set(unit.sections.flatMap((s) => s.citations))]
                        .map((id) => paper.sources.find((s) => s.id === id))
                        .filter(
                          (s): s is Source =>
                            !!s?.figure &&
                            !!(s.image || (s.page && paper.pdfUrl)),
                        )
                        .map((source) => (
                          <figure key={source.id} className="rw-answer-figure">
                            <ResearchImage
                              url={
                                source.image ??
                                `/api/papers/${encodeURIComponent(paper.id)}/sources/${encodeURIComponent(source.id)}/image`
                              }
                              title={source.title}
                              caption={source.caption}
                              thumbnail
                              onPage={() => onCitation(source.id, source)}
                            />
                            <figcaption>
                              {source.title} ·{" "}
                              {source.page ? `PDF 第 ${source.page} 页 · ` : ""}
                              点击放大查看
                            </figcaption>
                          </figure>
                        ))}
                    {unit.sections.map((section, i) => (
                      <section key={i}>
                        <h3>{section.title}</h3>
                        <div
                          className="rw-selectable"
                          onMouseUp={(e) => {
                            const text = selectedText(
                              e.currentTarget,
                              section.text,
                              "markdown",
                            );
                            setSelectedSentence(
                              complete && turn.runId && text
                                ? { turnId: turn.id, index: i, text }
                                : undefined,
                            );
                          }}
                          onKeyUp={(e) => {
                            const text = selectedText(
                              e.currentTarget,
                              section.text,
                              "markdown",
                            );
                            setSelectedSentence(
                              complete && turn.runId && text
                                ? { turnId: turn.id, index: i, text }
                                : undefined,
                            );
                          }}
                          onTouchEnd={(e) => {
                            const element = e.currentTarget;
                            setTimeout(() => {
                              const text = selectedText(
                                element,
                                section.text,
                                "markdown",
                              );
                              setSelectedSentence(
                                complete && turn.runId && text
                                  ? { turnId: turn.id, index: i, text }
                                  : undefined,
                              );
                            }, 100);
                          }}
                        >
                          <ResearchMarkdown text={section.text} />
                        </div>
                        {!!section.citations.length && (
                          <AnswerSources
                            ids={section.citations}
                            paper={paper}
                            materials={
                              turn.run?.materials?.at(-1)?.sources ?? []
                            }
                            onCitation={onCitation}
                          />
                        )}
                        <div className="rw-evidence">
                          {selectedSentence?.turnId === turn.id &&
                            selectedSentence.index === i &&
                            turn.runId && (
                              <SelectionActions
                                text={selectedSentence.text}
                                explain={() =>
                                  onFocus(
                                    {
                                      label: selectedSentence.text,
                                      focus: {
                                        runId: turn.runId!,
                                        sectionIndex: i,
                                        excerpt: selectedSentence.text,
                                      },
                                    },
                                    "请解释这句话，用更通俗的方式讲清楚。",
                                  )
                                }
                                cite={() =>
                                  onFocus(
                                    {
                                      label: selectedSentence.text,
                                      focus: {
                                        runId: turn.runId!,
                                        sectionIndex: i,
                                        excerpt: selectedSentence.text,
                                      },
                                    },
                                    "",
                                  )
                                }
                              />
                            )}
                        </div>
                      </section>
                    ))}
                    {[
                      ...new Set(unit.sections.flatMap((s) => s.citations)),
                    ].map((id) => {
                      const source =
                        paper?.sources.find((s) => s.id === id) ??
                        turn.run?.materials
                          ?.at(-1)
                          ?.sources.find((s) => s.id === id);
                      if (!source?.image) return null;
                      if (paper?.pdfUrl && source.page && !source.attachmentId)
                        return null;
                      if (
                        !source.displayImage &&
                        source.imagePurpose !== "figure"
                      )
                        return (
                          <p key={id}>
                            图件只有缓存预览，请补充原始 PDF 或清晰图片。
                            <button onClick={() => onCitation(id, source)}>
                              查看来源
                            </button>
                          </p>
                        );
                      return (
                        <ResearchImage
                          key={id}
                          url={source.displayImage ?? source.image}
                          title={source.title}
                          caption={source.text}
                        />
                      );
                    })}
                    {unit.terms.length > 0 && (
                      <details>
                        <summary>术语说明 · {unit.terms.length}</summary>
                        {unit.terms.map((t) => (
                          <p key={t.name}>
                            <strong>{t.name}</strong> · {t.explanation}
                          </p>
                        ))}
                      </details>
                    )}
                  </>
                )}
                {turn.error && (
                  <>
                    <p className="rw-error" role="alert">{turn.error}</p>
                    {turn.run?.review?.issues?.length ? (
                      <details className="rw-review-details">
                        <summary>
                          核验详情 · {turn.run.review.issues.filter((issue) => !issue.resolved).length} 个待处理问题
                        </summary>
                        {turn.run.review.issues
                          .filter((issue) => !issue.resolved)
                          .slice(0, 8)
                          .map((issue) => (
                            <div className="rw-review-issue" key={issue.id}>
                              <strong>
                                {issue.severity === "blocking" ? "必须修正" : "建议补充"} · {{fact: "事实", scope: "结论范围", teaching: "讲解衔接", material: "资料缺口"}[issue.type]}
                              </strong>
                              <p>{issue.location}</p>
                              <p>{issue.suggestion}</p>
                              {issue.evidence.length > 0 && (
                                <small>依据：{issue.evidence.map(id => turn.run?.materials?.at(-1)?.sources.find(s => s.id === id)?.locator ?? "相关引用资料").join("、")}</small>
                              )}
                            </div>
                          ))}
                        <p className="rw-review-next">
                          已保留本次核对结果。可调整问题后继续；需要额外资料时会说明具体缺少什么。
                        </p>
                      </details>
                    ) : null}
                  </>
                )}
                {turn.status === "clarification" && (
                  <p>{turn.reply?.nextStep}</p>
                )}
                {turn.reply?.pendingQuestions.length ? (
                  <details>
                    <summary>
                      待补充的问题 · {turn.reply.pendingQuestions.length}
                    </summary>
                    {turn.reply.pendingQuestions.map((q) => (
                      <p key={q.id}>{q.question}</p>
                    ))}
                  </details>
                ) : null}
              </div>
            </ObjectMenu>
          </article>
        );
      })}
    </div>
  );
}
