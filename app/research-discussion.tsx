import { selectedText } from "./research-selection.ts";
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
  "checking-attachments": "检查附件",
  planning: "整理问题",
  running: "处理中",
  teaching: "正在讲解",
  novice: "检查理解步骤",
  checking: "核对来源",
  revising: "修订讲解",
  rereading: "复读检查",
  rechecking: "复核修改",
  completed: "已完成",
  failed: "请求失败",
  cancelled: "已停止",
  interrupted: "请求已中断",
  clarification: "需要补充信息",
};
export function ResearchDiscussion({
  turns,
  paper,
  conversationId,
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
  onCancel: (turn: ResearchTurn) => void;
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
  const scrollKey = `research-chat-scroll:${paper?.id ?? conversationId ?? "idea"}`;
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
        try {
          localStorage.setItem(scrollKey, String(e.currentTarget.scrollTop));
        } catch {}
      }}
    >
      {!turns.length && (
        <section className="rp-welcome">
          <div className="rp-welcome-icon">◎</div>
          <h2>
            {paper ? "从这篇论文的一个问题开始" : "从论文或你的研究想法开始"}
          </h2>
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
                  {(
                    start.sourceIds ?? (start.sourceId ? [start.sourceId] : [])
                  ).map((id) => (
                    <button key={id} onClick={() => onCitation(id)}>
                      查看原文依据
                    </button>
                  ))}
                </div>
              )}
              {start?.status !== "completed" &&
                (["queued", "running"].includes(start?.status ?? "") ? (
                  <button onClick={onCancelGuide}>停止整理研究起点</button>
                ) : (
                  <button onClick={onGuide}>整理研究起点</button>
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
              <p>导入后一起理解研究问题、实验和证据。课题整理可以稍后进行。</p>
              <button disabled={busy} onClick={onImport}>
                ＋ 导入论文
              </button>
              <button disabled={busy} onClick={onIdea}>
                说说你的研究想法
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
        const unit = turn.reply?.content;
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
                {
                  label: "收藏解释",
                  disabled: busy,
                  run: () => onRecord(turn, "favorite"),
                },
                {
                  label: savedIds.includes(turn.id)
                    ? "已保存到笔记"
                    : "保存回答为笔记",
                  disabled: busy || savedIds.includes(turn.id),
                  run: () => onSave(turn),
                },
                {
                  label: "我的理解反馈",
                  children: [
                    {
                      label: "仍不理解",
                      disabled: busy,
                      run: () => onRecord(turn, "feedback", "confused"),
                    },
                    {
                      label: "我已理解",
                      disabled: busy,
                      run: () => onRecord(turn, "feedback", "understood"),
                    },
                  ],
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
                {turn.learningIntent && (
                  <small>
                    {verbosityLabels[turn.learningIntent.verbosity]} ·{" "}
                    {focusLabels[turn.learningIntent.focus]}
                    {turn.learningIntent.preferenceScope === "turn"
                      ? " · 本轮"
                      : " · 聊天偏好"}
                  </small>
                )}
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
                  <button onClick={() => onCancel(turn)}>
                    {turn.status === "queued" ? "取消等待" : "停止回答"}
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
                    {unit.sections.map((section, i) => (
                      <section key={i}>
                        <h3>{section.title}</h3>
                        <p
                          className="rw-selectable"
                          onMouseUp={(e) => {
                            const text = selectedText(
                              e.currentTarget,
                              section.text,
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
                              const text = selectedText(element, section.text);
                              setSelectedSentence(
                                complete && turn.runId && text
                                  ? { turnId: turn.id, index: i, text }
                                  : undefined,
                              );
                            }, 100);
                          }}
                        >
                          {section.text}
                        </p>
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
                          {section.citations.map((id) => {
                            const source =
                              paper?.sources.find((s) => s.id === id) ??
                              turn.run?.materials
                                ?.at(-1)
                                ?.sources.find((s) => s.id === id);
                            return (
                              <button
                                key={id}
                                onClick={() => onCitation(id, source)}
                              >
                                {source?.kind === "paper"
                                  ? source.page
                                    ? `PDF ${source.page}`
                                    : source.figure
                                      ? `图 ${source.figure}`
                                      : "论文来源"
                                  : source?.attachmentId
                                    ? "上传图片"
                                    : "补充来源"}{" "}
                                ↗
                              </button>
                            );
                          })}
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
                      if (paper?.pdfUrl && source.page)
                        return (
                          <ObjectMenu
                            key={id}
                            objectKey={`${paper.id}:${id}`}
                            label={`${source.title}图件操作`}
                            actions={[
                              {
                                label: "查看图所在原页",
                                run: () => onCitation(id, source),
                              },
                              {
                                label: "查看图注与来源",
                                run: () => onCitation(id, source),
                              },
                            ]}
                          >
                            <button
                              className="rw-figure-link"
                              onClick={() => onCitation(id, source)}
                            >
                              {source.figure
                                ? `Figure ${source.figure}`
                                : source.title}{" "}
                              · 查看图所在原页（PDF {source.page}）
                            </button>
                          </ObjectMenu>
                        );
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
                  <p className="rw-error" role="alert">
                    {turn.error}
                  </p>
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
