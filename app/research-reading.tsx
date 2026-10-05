import { researchApi } from "./research-api.ts";
import { ResearchPdf } from "./research-pdf.tsx";
import { selectedText } from "./research-selection.ts";
import { useEffect, useRef, useState } from "react";
import type { PaperBundle, Source } from "../shared/types.ts";
import type { ResearchNote } from "../shared/workspace.ts";
import type { ResearchSelection } from "./research-discussion.tsx";

function NoteEditor({
  note,
  onSave,
  onReturn,
  onCitation,
  busy,
}: {
  note: ResearchNote;
  onSave: (note: ResearchNote, title: string, text: string) => void;
  onReturn: (id: string) => void;
  onCitation: (id: string) => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState(note.title),
    [text, setText] = useState(note.text);
  const changed = title !== note.title || text !== note.text;
  return (
    <article className="rw-note">
      <label>
        笔记名称
        <input
          aria-label="笔记名称"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <textarea
        aria-label={`笔记正文 ${note.title}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={50_000}
      />
      <div className="rw-actions">
        <button
          disabled={busy || !changed || !title.trim() || !text.trim()}
          onClick={() => onSave(note, title, text)}
        >
          保存修改
        </button>
        <button disabled={busy} onClick={() => onReturn(note.conversationId)}>
          回到原讨论
        </button>
      </div>
      {note.anchors.map((anchor) => (
        <details key={anchor.sourceId}>
          <summary>
            保存时的依据 ·{" "}
            {anchor.page ? `第 ${anchor.page} 页` : anchor.sourceId}
          </summary>
          <p>{anchor.excerpt}</p>
          <button onClick={() => onCitation(anchor.sourceId)}>
            打开当前来源
          </button>
        </details>
      ))}
      {note.evidence
        ?.filter((s) => s.kind !== "paper")
        .map((source) => (
          <details key={source.id}>
            <summary>保存时的依据 · {source.title}</summary>
            <p>{source.locator}</p>
            <p>{source.text}</p>
            {source.url && (
              <a href={source.url} target="_blank" rel="noreferrer">
                打开来源 ↗
              </a>
            )}
          </details>
        ))}
      <small>保存于 {new Date(note.createdAt).toLocaleString("zh-CN")}</small>
    </article>
  );
}
export function ResearchReading({
  paper,
  name,
  panel,
  sourceId,
  locatorRevision,
  onMaterial,
  extraSource,
  notes,
  busy,
  onPanel,
  onClose,
  onSource,
  onFocus,
  onSaveNote,
  onReturn,
}: {
  paper?: PaperBundle;
  name: string;
  panel: "sources" | "notes";
  sourceId?: string;
  locatorRevision: number;
  onMaterial: (paper: PaperBundle) => void;
  extraSource?: Source;
  notes: ResearchNote[];
  busy: boolean;
  onPanel: (panel: "sources" | "notes") => void;
  onClose: () => void;
  onSource: (id: string) => void;
  onFocus: (selection: ResearchSelection, question: string) => void;
  onSaveNote: (note: ResearchNote, title: string, text: string) => void;
  onReturn: (id: string) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [manual, setManual] = useState(() => {
      try {
        return localStorage.getItem(`research-manual:${paper?.id}`) ?? "";
      } catch {
        return "";
      }
    }),
    [manualPage, setManualPage] = useState(1),
    [savingText, setSavingText] = useState(false),
    [textError, setTextError] = useState("");
  const [pdfMode, setPdfMode] = useState(false);
  const [selected, setSelected] = useState<{ id: string; text: string }>();
  const sources = paper?.sources.filter((s) => s.kind === "paper") ?? [];
  if (extraSource && !sources.some((s) => s.id === extraSource.id))
    sources.unshift(extraSource);
  useEffect(() => {
    setSelected(undefined);
    const card = [
      ...(body.current?.querySelectorAll<HTMLElement>("[data-source]") ?? []),
    ].find((e) => e.dataset.source === sourceId);
    card?.scrollIntoView({ block: "start" });
  }, [sourceId, paper?.id, panel, locatorRevision]);
  function ask(source: Source, text: string) {
    if (!paper || !paper.sources.some((s) => s.id === source.id)) return;
    onFocus(
      {
        label: text,
        sourceAnchor: {
          paperId: paper.id,
          sourceVersion: paper.version,
          sourceId: source.id,
          excerpt: text,
          page: source.page,
        },
      },
      "请解释这段原文，先讲清楚它在研究中的意思。",
    );
  }
  function exportNotes() {
    const text = notes
      .map(
        (n) =>
          `# ${n.title}\n\n${n.text}\n\n${n.anchors.map((a) => `依据：${a.sourceId}${a.page ? ` · PDF 第 ${a.page} 页` : ""}\n> ${a.excerpt.replace(/\n/g, "\n> ")}`).join("\n\n")}\n\n${(
            n.evidence ?? []
          )
            .filter((s) => s.kind !== "paper")
            .map(
              (s) =>
                `依据：${s.title} · ${s.locator}\n${s.url ?? ""}\n> ${s.text.replace(/\n/g, "\n> ")}`,
            )
            .join("\n\n")}`,
      )
      .join("\n\n---\n\n");
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/markdown;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "论文研究笔记.md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <aside className="rp-viewer rw-reader" aria-label="资料与笔记面板">
      <header className="rp-viewer-header">
        <strong>{name}</strong>
        <button aria-label="返回讨论" onClick={onClose}>
          × 返回讨论
        </button>
      </header>
      <div className="rp-tabs" role="tablist" aria-label="阅读面板">
        {(["sources", "notes"] as const).map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={panel === tab}
            tabIndex={panel === tab ? 0 : -1}
            onClick={() => onPanel(tab)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                onPanel(tab === "sources" ? "notes" : "sources");
                (
                  e.currentTarget.parentElement?.querySelector(
                    `[aria-selected="false"]`,
                  ) as HTMLElement
                )?.focus();
              }
            }}
          >
            {tab === "sources" ? "原文与图件" : "我的笔记"}
          </button>
        ))}
      </div>
      <div className="rp-viewer-body" ref={body}>
        {panel === "sources" ? (
          <>
            {paper && (
              <details className="rw-bibliography">
                <summary>原始题录与材料状态</summary>
                <p>{paper.title}</p>
                {paper.doi && <p>DOI · {paper.doi}</p>}
                <p>{paper.scope}</p>
              </details>
            )}
            {paper && paper.id !== "xu-2018" && (
              <details
                className="rw-manual-text"
                open={
                  paper.parseStatus === "needs-text" ||
                  paper.parseStatus === "failed"
                }
              >
                <summary>补充原文</summary>
                <label>
                  原文所在 PDF 页码
                  <input
                    aria-label="补充原文页码"
                    type="number"
                    min={1}
                    max={paper.pageCount ?? 100}
                    value={manualPage}
                    onChange={(e) => setManualPage(Number(e.target.value))}
                  />
                </label>
                <textarea
                  aria-label="补充原文正文"
                  maxLength={20000}
                  value={manual}
                  onChange={(e) => {
                    setManual(e.target.value);
                    try {
                      localStorage.setItem(
                        `research-manual:${paper?.id}`,
                        e.target.value,
                      );
                    } catch {}
                  }}
                  placeholder="粘贴需要讨论的原文，保留真实来源页码"
                />
                <button
                  disabled={savingText || !manual.trim()}
                  onClick={() => {
                    setSavingText(true);
                    setTextError("");
                    void researchApi<PaperBundle>(
                      `/api/papers/${paper.id}/text`,
                      {
                        text: manual,
                        page: manualPage,
                        title: `用户补充原文 · 第 ${manualPage} 页`,
                        section: "overview",
                      },
                    )
                      .then((value) => {
                        setManual("");
                        try {
                          localStorage.removeItem(
                            `research-manual:${paper.id}`,
                          );
                        } catch {}
                        onMaterial(value);
                      })
                      .catch((err) => setTextError(err.message))
                      .finally(() => setSavingText(false));
                  }}
                >
                  保存补充原文
                </button>
                {textError && <p role="alert">{textError}</p>}
              </details>
            )}
            {paper?.pdfUrl && (
              <a
                className="rw-pdf-link"
                href={`${paper.pdfUrl}#page=${sources.find((s) => s.id === sourceId)?.page ?? 1}`}
                target="_blank"
                rel="noreferrer"
              >
                打开原始 PDF ↗
              </a>
            )}
            {!sources.length && (
              <p>当前没有可用原文。可以先讨论研究想法，再补充论文。</p>
            )}
            {paper?.pdfUrl && (
              <div className="rw-reading-modes">
                <button
                  aria-pressed={!pdfMode}
                  onClick={() => setPdfMode(false)}
                >
                  提取原文
                </button>
                <button aria-pressed={pdfMode} onClick={() => setPdfMode(true)}>
                  PDF 页面
                </button>
              </div>
            )}
            {pdfMode && paper?.pdfUrl ? (
              <ResearchPdf
                key={paper.id}
                paper={paper}
                sourceId={sourceId}
                locatorRevision={locatorRevision}
                onSource={onSource}
                onFocus={onFocus}
              />
            ) : (
              sources.map((source) => (
                <article
                  key={source.id}
                  data-source={source.id}
                  className={`rp-source-card ${sourceId === source.id ? "rp-source-active" : ""}`}
                >
                  <h3>{source.title}</h3>
                  <small>{source.locator}</small>
                  {source.image && (
                    <>
                      <img
                        className="rw-figure"
                        src={source.image}
                        alt={`${source.title} 原图`}
                      />
                      <button
                        disabled={busy}
                        onClick={() => {
                          onSource(source.id);
                          onFocus(
                            {
                              label: source.figure || source.title,
                              figureSourceId: source.id,
                            },
                            "带我看这张图：比较了什么，结果是什么，有哪些解释边界？",
                          );
                        }}
                      >
                        带我看这张图
                      </button>
                    </>
                  )}
                  <p
                    className="rw-selectable"
                    onMouseUp={(e) => {
                      const text = selectedText(e.currentTarget, source.text);
                      setSelected(text ? { id: source.id, text } : undefined);
                    }}
                    onKeyUp={(e) => {
                      const text = selectedText(e.currentTarget, source.text);
                      setSelected(text ? { id: source.id, text } : undefined);
                    }}
                    onTouchEnd={(e) => {
                      const element = e.currentTarget;
                      setTimeout(() => {
                        const text = selectedText(element, source.text);
                        setSelected(text ? { id: source.id, text } : undefined);
                      }, 100);
                    }}
                  >
                    {source.text || "此页未提取到正文，请查看 PDF 或补充文字。"}
                  </p>
                  {source.kind === "paper" &&
                    paper?.sources.some((s) => s.id === source.id) &&
                    source.text.trim() && (
                      <div className="rw-actions">
                        {selected?.id === source.id && (
                          <button
                            className="rp-primary"
                            disabled={busy}
                            onClick={() => {
                              onSource(source.id);
                              ask(source, selected.text);
                            }}
                          >
                            引用提问
                          </button>
                        )}
                        <button
                          disabled={busy}
                          onClick={() => {
                            onSource(source.id);
                            ask(source, source.text.slice(0, 1600));
                          }}
                        >
                          对这段原文提问
                        </button>
                      </div>
                    )}
                  {source.url && (
                    <a href={source.url} target="_blank" rel="noreferrer">
                      打开来源 ↗
                    </a>
                  )}
                </article>
              ))
            )}
          </>
        ) : (
          <>
            <h2>我的笔记</h2>
            <p className="rw-note-help">
              在回答下方保存内容，笔记会保留原讨论与依据。
            </p>
            {!notes.length && <p>还没有保存笔记。</p>}
            {notes.map((note) => (
              <NoteEditor
                key={`${note.id}-${note.updatedAt}`}
                note={note}
                onSave={onSaveNote}
                onReturn={onReturn}
                onCitation={onSource}
                busy={busy}
              />
            ))}
            {!!notes.length && (
              <button className="rp-primary rw-export" onClick={exportNotes}>
                导出 Markdown
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
