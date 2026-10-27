import { currentSourceRanges } from "../shared/source-ranges.ts";
import { researchApi } from "./research-api.ts";
import { ResearchPdf } from "./research-pdf.tsx";
import { selectedText } from "./research-selection.ts";
import { useEffect, useRef, useState } from "react";
import type { PaperBundle, Source } from "../shared/types.ts";
import type { ResearchNote } from "../shared/workspace.ts";
import type { ResearchSelection } from "./research-discussion.tsx";
import { SelectionActions } from "./research-menu.tsx";
import { ResearchImage } from "./research-image.tsx";
import { BilingualSource } from "./source-translation.tsx";

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
  const key = `research-note-draft:${note.id}`;
  const readDraft = () => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null") ?? note;
    } catch {
      return note;
    }
  };
  const [title, setTitle] = useState<string>(readDraft().title),
    [text, setText] = useState<string>(readDraft().text);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ title, text }));
    } catch {}
  }, [key, title, text]);
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
type NewNote = { id: string; title: string; text: string };
function NoteComposer({
  draftKey,
  onCreate,
}: {
  draftKey: string;
  onCreate: (input: NewNote) => Promise<void>;
}) {
  const empty = (): NewNote => ({
    id: crypto.randomUUID(),
    title: "",
    text: "",
  });
  const [draft, setDraft] = useState<NewNote>(() => {
    try {
      return JSON.parse(localStorage.getItem(draftKey) ?? "null") ?? empty();
    } catch {
      return empty();
    }
  });
  const [open, setOpen] = useState(Boolean(draft.text)),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  function update(value: NewNote) {
    setDraft(value);
    try {
      localStorage.setItem(draftKey, JSON.stringify(value));
    } catch {}
  }
  async function saveNote() {
    if (lock.current || !draft.text.trim()) return;
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      await onCreate({
        ...draft,
        title: draft.title.trim() || "我的笔记",
        text: draft.text.trim(),
      });
      update(empty());
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return (
    <section className="rw-note">
      {!open ? (
        <button onClick={() => setOpen(true)}>新建笔记</button>
      ) : (
        <>
          <label>
            标题（可选）
            <input
              aria-label="新笔记标题"
              maxLength={120}
              value={draft.title}
              onChange={(e) => update({ ...draft, title: e.target.value })}
              disabled={saving}
            />
          </label>
          <label>
            记录内容
            <textarea
              aria-label="新笔记正文"
              autoFocus
              rows={6}
              maxLength={50000}
              value={draft.text}
              placeholder="直接记录想法、要点或待办…"
              onChange={(e) => update({ ...draft, text: e.target.value })}
              disabled={saving}
            />
          </label>
          <div className="rw-actions">
            <button
              disabled={saving || !draft.text.trim()}
              onClick={() => void saveNote()}
            >
              {saving ? "正在保存…" : "保存新笔记"}
            </button>
            <button
              disabled={saving}
              onClick={() => {
                setOpen(false);
                setError("");
              }}
            >
              收起草稿
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
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
  onCreateNote,
  onReturn,
  pinned,
  onPin,
  wide,
  onWide,
  onBack,
  returnLabel = "返回讨论",
  overlay = false,
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
  onCreateNote: (input: NewNote) => Promise<void>;
  onReturn: (id: string) => void;
  pinned: boolean;
  onPin: () => void;
  wide: boolean;
  onWide: () => void;
  onBack: () => void;
  returnLabel?: string;
  overlay?: boolean;
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
  const [selected, setSelected] = useState<{ id: string; text: string }>();
  useEffect(() => {
    const clear = () => {
      const selection = window.getSelection();
      if (
        !selection?.toString() ||
        !selection.anchorNode ||
        !body.current?.contains(selection.anchorNode)
      )
        setSelected(undefined);
    };
    document.addEventListener("selectionchange", clear);
    return () => document.removeEventListener("selectionchange", clear);
  }, []);
  const sources =
    paper?.sources.filter(
      (s) =>
        s.kind === "paper" &&
        (!paper.pdfUrl || (s.attachmentId && s.id === sourceId)),
    ) ?? [];
  if (
    extraSource &&
    (!paper?.pdfUrl ||
      extraSource.kind !== "paper" ||
      extraSource.attachmentId) &&
    !sources.some((s) => s.id === extraSource.id)
  )
    sources.unshift(extraSource);
  useEffect(() => {
    setSelected(undefined);
    const card = [
      ...(body.current?.querySelectorAll<HTMLElement>("[data-source]") ?? []),
    ].find((e) => e.dataset.source === sourceId);
    if (!paper?.pdfUrl) card?.scrollIntoView({ block: "start" });
    else if (body.current && locatorRevision) body.current.scrollTop = 0;
  }, [sourceId, paper?.id, panel, locatorRevision]);
  useEffect(() => {
    try {
      if (body.current)
        body.current.scrollTop =
          Number(
            localStorage.getItem(
              `research-reader-scroll:${paper?.id}:${panel}`,
            ),
          ) || 0;
    } catch {}
  }, [paper?.id, panel]);
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
        <strong title={name}>{name}</strong>
        {!overlay && (
          <button aria-pressed={pinned} onClick={onPin}>
            {pinned ? "取消固定" : "固定对照"}
          </button>
        )}
        {!overlay && (
          <button onClick={wide ? onBack : onWide}>
            {wide ? "返回资料" : "展开阅读"}
          </button>
        )}
        <button aria-label={returnLabel} onClick={onClose}>
          × {returnLabel}
        </button>
      </header>
      <div className="rp-tabs" role="tablist" aria-label="阅读面板">
        {(
          ["sources", ...(notes.length ? ["notes" as const] : [])] as const
        ).map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={panel === tab}
            tabIndex={panel === tab ? 0 : -1}
            onClick={() => onPanel(tab)}
            onKeyDown={(e) => {
              const tabs = Array.from(
                e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ) ?? [],
              );
              const currentIndex = tabs.indexOf(e.currentTarget);
              let nextIndex: number;
              switch (e.key) {
                case "ArrowLeft":
                case "ArrowRight":
                  if (tabs.length < 2) return;
                  nextIndex =
                    (currentIndex +
                      (e.key === "ArrowRight" ? 1 : -1) +
                      tabs.length) %
                    tabs.length;
                  break;
                case "Home":
                  nextIndex = 0;
                  break;
                case "End":
                  nextIndex = tabs.length - 1;
                  break;
                default:
                  return;
              }
              e.preventDefault();
              tabs[nextIndex]?.focus();
              tabs[nextIndex]?.click();
            }}
          >
            {tab === "sources" ? "原文与图件" : "历史笔记"}
          </button>
        ))}
      </div>
      <div
        className="rp-viewer-body"
        ref={body}
        onScroll={(e) => {
          try {
            localStorage.setItem(
              `research-reader-scroll:${paper?.id}:${panel}`,
              String(e.currentTarget.scrollTop),
            );
          } catch {}
        }}
      >
        {panel === "sources" ? (
          <>
            {paper &&
              (() => {
                const source =
                  paper.sources.find(
                    (s) => s.id === sourceId && s.kind === "paper",
                  ) ??
                  (!sourceId
                    ? paper.sources.find((s) => s.kind === "paper" && !s.image)
                    : undefined);
                if (!source) return null;
                const ranges = currentSourceRanges(source, extraSource);
                return (
                  <BilingualSource
                    key={`${paper.id}:${paper.version}:${source.id}:${locatorRevision}`}
                    paper={paper}
                    source={source}
                    ranges={ranges}
                    displayLabel={
                      source.caption
                        ? "对应图注 · 中英对照"
                        : ranges.length
                          ? "所引片段 · 中英对照"
                          : "论文原文 · 中英对照"
                    }
                  />
                );
              })()}
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
                  !paper.pdfUrl &&
                  (paper.parseStatus === "needs-text" ||
                    paper.parseStatus === "failed")
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
            {!sources.length && !paper?.pdfUrl && (
              <p>当前没有可用原文。可以先讨论研究想法，再补充论文。</p>
            )}
            {paper?.pdfUrl && (
              <>
                <p className="rw-source-guide">
                  在 PDF 原页选中文字，可以继续解释或引用提问。
                </p>
                <ResearchPdf
                  key={paper.id}
                  paper={paper}
                  sourceId={sourceId}
                  locatorRevision={locatorRevision}
                  onSource={onSource}
                  onFocus={onFocus}
                />
              </>
            )}
            {paper && !paper.pdfUrl && (
              <p role="status">仅有摘录，缺少原始 PDF。可从导航导入原文件。</p>
            )}
            {sources.map((source) => (
              <article
                key={source.id}
                data-source={source.id}
                className={`rp-source-card ${sourceId === source.id ? "rp-source-active" : ""}`}
              >
                <h3>{source.title}</h3>
                <small>{source.locator}</small>
                {source.image && (!paper?.pdfUrl || source.attachmentId) && (
                  <>
                    <ResearchImage
                      url={source.displayImage ?? source.image}
                      title={source.title}
                      caption={source.text}
                      originalMissing={
                        !source.displayImage &&
                        Boolean(
                          source.attachmentId ||
                          source.imagePurpose === "attachment",
                        )
                      }
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
                <details>
                  <summary>查看来源文字</summary>
                  <p
                    className="rw-selectable"
                    onMouseUp={(e) => {
                      const text = selectedText(
                        e.currentTarget,
                        source.text,
                        "plain",
                      );
                      setSelected(text ? { id: source.id, text } : undefined);
                    }}
                    onKeyUp={(e) => {
                      const text = selectedText(
                        e.currentTarget,
                        source.text,
                        "plain",
                      );
                      setSelected(text ? { id: source.id, text } : undefined);
                    }}
                    onTouchEnd={(e) => {
                      const element = e.currentTarget;
                      setTimeout(() => {
                        const text = selectedText(
                          element,
                          source.text,
                          "plain",
                        );
                        setSelected(text ? { id: source.id, text } : undefined);
                      }, 100);
                    }}
                  >
                    {source.text.includes("\uFFFD")
                      ? "文本提取异常，请查看原始 PDF。"
                      : source.text ||
                        "此页未提取到正文，请查看 PDF 或补充文字。"}
                  </p>
                  {source.kind === "paper" &&
                    paper?.sources.some((s) => s.id === source.id) &&
                    source.text.trim() && (
                      <div className="rw-actions">
                        {selected?.id === source.id && (
                          <SelectionActions
                            text={selected.text}
                            explain={() => {
                              onSource(source.id);
                              ask(source, selected.text);
                            }}
                            cite={() =>
                              onFocus(
                                {
                                  label: selected.text,
                                  sourceAnchor: {
                                    paperId: paper!.id,
                                    sourceVersion: paper!.version,
                                    sourceId: source.id,
                                    excerpt: selected.text,
                                    page: source.page,
                                  },
                                },
                                "",
                              )
                            }
                            source={() => onSource(source.id)}
                          />
                        )}
                        {!paper?.pdfUrl && (
                          <button
                            disabled={busy}
                            onClick={() => {
                              onSource(source.id);
                              ask(source, source.text.slice(0, 1600));
                            }}
                          >
                            对这段原文提问
                          </button>
                        )}
                      </div>
                    )}
                  {source.url && (
                    <a href={source.url} target="_blank" rel="noreferrer">
                      打开来源 ↗
                    </a>
                  )}
                </details>
              </article>
            ))}
          </>
        ) : (
          <>
            <h2>我的笔记</h2>
            <p className="rw-note-help">
              保留此前保存的笔记，新的内容可从回答菜单复制。
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
              <button
                className="rp-primary rw-export"
                disabled={busy}
                onClick={exportNotes}
              >
                导出 Markdown
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
