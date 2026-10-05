import { useState } from "react";
import type { AssistantMessage, PaperBundle, Source } from "../shared/types.ts";
import type { ReadingStart, ResearchTurn } from "../shared/workspace.ts";

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
  start,
  busy,
  onSuggest,
  onImport,
  onIdea,
  onCitation,
  onFocus,
  onSave,
  onCancel,
  onRetry,
  savedIds,
  latestTitle,
  onResume,
}: {
  turns: ResearchTurn[];
  paper?: PaperBundle;
  start?: ReadingStart;
  busy: boolean;
  onSuggest: (question: string) => void;
  onImport: () => void;
  onIdea: () => void;
  onCitation: (id: string, source?: Source) => void;
  onFocus: (selection: ResearchSelection, question: string) => void;
  onSave: (turn: ResearchTurn) => void;
  onCancel: (turn: ResearchTurn) => void;
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
  return (
    <div className="rp-messages rw-messages" aria-label="连续研究讨论">
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
                    ? "该 PDF 未提取到可用正文，请上传可复制文字的版本，或在现有工具中补充原文。"
                    : "可以直接提问，也可以先从下面的问题开始。"}
              </p>
              {start?.excerpt && (
                <div className="rw-start-excerpt">
                  <small>{start.label}</small>
                  <p>{start.excerpt}</p>
                  <button onClick={() => onCitation(start.sourceId!)}>
                    查看摘录依据
                  </button>
                </div>
              )}
              {start?.questions.map((q) => (
                <button key={q} disabled={busy} onClick={() => onSuggest(q)}>
                  {q}
                  <span>↗</span>
                </button>
              ))}
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
              </div>
            </div>
            <div className="rw-answer">
              <small>
                {statusLabel[
                  !finished(turn) && turn.run ? turn.run.status : turn.status
                ] ?? turn.status}
              </small>
              {!finished(turn) && (
                <button onClick={() => onCancel(turn)}>
                  {turn.status === "queued" ? "取消等待" : "停止回答"}
                </button>
              )}
              {["cancelled", "failed", "interrupted"].includes(turn.status) && (
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
                        onMouseUp={() => {
                          const selection = window.getSelection();
                          const text = selection?.toString().trim();
                          if (
                            complete &&
                            turn.runId &&
                            text &&
                            text.length <= 2000 &&
                            section.text.includes(text)
                          )
                            setSelectedSentence({
                              turnId: turn.id,
                              index: i,
                              text,
                            });
                        }}
                      >
                        {section.text}
                      </p>
                      <div className="rw-evidence">
                        {selectedSentence?.turnId === turn.id &&
                          selectedSentence.index === i &&
                          turn.runId && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                onFocus(
                                  {
                                    label: `回答「${section.title}」中的句子`,
                                    focus: {
                                      runId: turn.runId!,
                                      sectionIndex: i,
                                      excerpt: selectedSentence.text,
                                    },
                                  },
                                  "请解释这句话，用更通俗的方式讲清楚。",
                                )
                              }
                            >
                              解释这句
                            </button>
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
                              {source?.title ?? id} ↗
                            </button>
                          );
                        })}
                        {complete && turn.runId && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              onFocus(
                                {
                                  label: `回答「${section.title}」`,
                                  focus: {
                                    runId: turn.runId!,
                                    sectionIndex: i,
                                    excerpt: section.text.slice(0, 2000),
                                  },
                                },
                                "请把这段讲得更通俗一些。",
                              )
                            }
                          >
                            追问这段
                          </button>
                        )}
                      </div>
                    </section>
                  ))}
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
              {turn.status === "clarification" && <p>{turn.reply?.nextStep}</p>}
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
              {complete && unit && (
                <button
                  className="rw-save"
                  disabled={busy || savedIds.includes(turn.id)}
                  onClick={() => onSave(turn)}
                >
                  {savedIds.includes(turn.id)
                    ? "已保存到笔记"
                    : "保存回答为笔记"}
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
