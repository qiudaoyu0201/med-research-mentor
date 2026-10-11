import { useEffect, useRef, useState } from "react";
import type {
  AssistantTurn,
  ConversationState,
  DeckVersion,
  PaperBundle,
} from "../shared/types.ts";
import type { PlanJob, ResearchPlan } from "../shared/research-plan.ts";
import {
  chronological,
  selectPlanSources,
} from "../shared/generation-intake.ts";
import { planJobDone, planVersionReady } from "../shared/research-plan.ts";
import { importPaper, researchApi } from "./research-api.ts";
import { ResearchMarkdown } from "./markdown.tsx";
import { ResearchSlide } from "./research-slide.tsx";
import { ArtifactNavigation } from "./artifact-navigation.tsx";
import type { WorkspaceIndex, ArtifactSummary } from "../shared/workspace.ts";
import { useArtifactIntake } from "./artifact-intake.ts";
import { slideImageKey } from "../shared/image-region.ts";

const terminal = (status: string) =>
  [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "clarification",
    "conflict",
  ].includes(status);
function sameShape(value: unknown, fallback: unknown): boolean {
  if (Array.isArray(fallback))
    return Array.isArray(value) && value.every((v) => typeof v === "string");
  if (fallback && typeof fallback === "object")
    return (
      !!value &&
      typeof value === "object" &&
      Object.entries(fallback).every(([key, field]) =>
        sameShape((value as Record<string, unknown>)[key], field),
      )
    );
  return typeof value === typeof fallback;
}
function readDraft<T>(
  key: string,
  fallback: T,
  validate = (value: unknown) => sameShape(value, fallback),
): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return validate(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
function writeDraft(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
type PendingPpt = {
  conversationId: string;
  body: { clientMessageId: string } & Record<string, unknown>;
};
type PendingPlan = {
  id: string;
  body: { requestKey: string } & Record<string, unknown>;
};
function pendingPpt(key: string) {
  return readDraft<PendingPpt | undefined>(
    key,
    undefined,
    (v) =>
      !!v &&
      typeof v === "object" &&
      typeof (v as PendingPpt).conversationId === "string" &&
      typeof (v as PendingPpt).body?.clientMessageId === "string",
  );
}
function pendingPlan() {
  return readDraft<PendingPlan | undefined>(
    "tutor-plan-pending",
    undefined,
    (v) =>
      !!v &&
      typeof v === "object" &&
      typeof (v as PendingPlan).id === "string" &&
      typeof (v as PendingPlan).body?.requestKey === "string",
  );
}
function savePending(key: string, value: unknown) {
  if (!writeDraft(key, value))
    throw new Error(
      "浏览器无法保存提交记录。请允许本地存储后重试，以便刷新后继续查询本次任务。",
    );
}

function PaperPicker({
  papers,
  selected,
  onSelect,
  onImported,
  onBusyChange,
  multiple = false,
  disabled = false,
}: {
  papers: PaperBundle[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  onImported: (paper: PaperBundle) => void;
  onBusyChange?: (busy: boolean) => void;
  multiple?: boolean;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null),
    lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="tg-papers">
      <div>
        <span>{multiple ? "参考论文（可选）" : "选择论文"}</span>
        <div
          className="tg-paper-picker"
          role={multiple ? "group" : "radiogroup"}
          aria-label={multiple ? "参考论文" : "选择论文"}
        >
          {!papers.length && (
            <span className="hint">暂无可选论文，请先导入 PDF。</span>
          )}
          {papers.map((p) => {
            const checked = selected.includes(p.id);
            return (
              <label
                className={`tg-paper-option ${checked ? "is-selected" : ""}`}
                key={p.id}
              >
                <input
                  type={multiple ? "checkbox" : "radio"}
                  name={multiple ? undefined : "generation-paper"}
                  checked={checked}
                  disabled={busy || disabled}
                  onChange={() =>
                    onSelect(
                      multiple
                        ? checked
                          ? selected.filter((id) => id !== p.id)
                          : [...selected, p.id]
                        : [p.id],
                    )
                  }
                />
                <span>{p.title}</span>
              </label>
            );
          })}
        </div>
      </div>
      {multiple && <small>可勾选多篇，也可以不选，由助手检索文献。</small>}
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file || lock.current) return;
          lock.current = true;
          setBusy(true);
          onBusyChange?.(true);
          setError("");
          try {
            const r = await importPaper([file]);
            onImported(r.paper);
            onSelect(
              multiple ? [...new Set([...selected, r.paper.id])] : [r.paper.id],
            );
            if (r.error) setError(r.error);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            lock.current = false;
            setBusy(false);
            onBusyChange?.(false);
          }
        }}
      />
      <button
        disabled={busy || disabled}
        onClick={() => input.current?.click()}
      >
        {busy ? "正在导入…" : "导入 PDF"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function PptGeneration({
  papers: initial,
  initialPaper,
  onImported,
  index,
  onCreateProject,
  onEditProject,
}: {
  papers: PaperBundle[];
  initialPaper?: PaperBundle;
  onImported: (paper: PaperBundle) => void;
  index: WorkspaceIndex;
  onCreateProject: () => void;
  onEditProject: (id: string) => void;
}) {
  const [artifactId, setArtifactId] = useState(() =>
    readDraft("tutor-ppt-artifact", ""),
  );
  const [draftOnly, setDraftOnly] = useState(() =>
    readDraft("tutor-ppt-draft-only", false),
  );
  useEffect(() => {
    writeDraft("tutor-ppt-draft-only", draftOnly);
  }, [draftOnly]);
  const [papers, setPapers] = useState(initial);
  useEffect(() => setPapers(initial), [initial]);
  const [paperId, setPaperId] = useState(
      artifactId
        ? readDraft("tutor-ppt-paper", "")
        : (initialPaper?.id ?? readDraft("tutor-ppt-paper", "")),
    ),
    [request, setRequest] = useState(() => readDraft("tutor-ppt-request", "")),
    [count, setCount] = useState(() =>
      readDraft("tutor-ppt-count", "", (value) =>
        ["", "6", "8", "10", "12", "16"].includes(value as string),
      ),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [turn, setTurn] = useState<AssistantTurn>(),
    [versions, setVersions] = useState<DeckVersion[]>([]),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState(0),
    [download, setDownload] = useState("");
  const conversation = useRef<ConversationState | undefined>(undefined),
    lock = useRef(false),
    epoch = useRef(0);
  const pending = useRef<PendingPpt | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true),
    [awaiting, setAwaiting] = useState(false),
    [restoreFailed, setRestoreFailed] = useState(false),
    [restoreAttempt, setRestoreAttempt] = useState(0);
  const pendingKey = "tutor-ppt-pending";
  const current = versions.find((v) => v.id === selected) ?? versions.at(-1);
  const paper = current?.sourceSnapshot ?? papers.find((p) => p.id === paperId);
  const running = turn && !terminal(turn.status);
  useArtifactIntake(
    "ppt",
    artifactId,
    { paperId, request, count },
    !loading && !busy && !running && !awaiting,
    setError,
  );
  useEffect(() => {
    writeDraft("tutor-ppt-request", request);
    if (artifactId) writeDraft(`tutor-ppt-request:${artifactId}`, request);
  }, [request, artifactId]);
  useEffect(() => {
    writeDraft("tutor-ppt-count", count);
    if (artifactId) writeDraft(`tutor-ppt-count:${artifactId}`, count);
  }, [count, artifactId]);
  useEffect(() => {
    if (artifactId && !loading && selected)
      writeDraft(`tutor-ppt-view:${artifactId}`, { selected, page });
  }, [artifactId, selected, page, loading]);
  useEffect(() => {
    const token = ++epoch.current;
    conversation.current = undefined;
    pending.current =
      pendingPpt(pendingKey) ?? pendingPpt(`tutor-ppt-pending:${paperId}`);
    setAwaiting(!!pending.current);
    setLoading(true);
    setRestoreFailed(false);
    setError("");
    setTurn(undefined);
    setVersions([]);
    setSelected("");
    setPage(0);
    setDownload("");
    writeDraft("tutor-ppt-paper", paperId);
    writeDraft("tutor-ppt-artifact", artifactId);
    if (!paperId && !artifactId && !pending.current) {
      setLoading(false);
      return;
    }
    void researchApi<ConversationState[]>("/api/conversations")
      .then(async (all) => {
        if (token !== epoch.current) return;
        if (artifactId) {
          const items = await researchApi<ArtifactSummary[]>("/api/artifacts");
          const item = items.find(
            (a) => a.kind === "ppt" && a.id === artifactId && !a.archived,
          );
          if (token !== epoch.current) return;
          if (!item) {
            setArtifactId("");
            setRequest("");
            setCount("");
            return;
          }
          if (item.draftOnly) {
            setDraftOnly(true);
            return;
          }
        }
        const histories = chronological(
          all.filter(
            (c) =>
              c.id === artifactId || c.id === pending.current?.conversationId,
          ),
        );
        const matches = histories;
        const c =
          matches.find((c) => c.id === pending.current?.conversationId) ??
          matches.at(-1);
        if (token !== epoch.current) return;
        if (c?.paperId && c.paperId !== paperId) {
          setPaperId(c.paperId);
          return;
        }
        if (c && !artifactId) {
          setArtifactId(c.id);
          return;
        }
        const [decks, turns] = await Promise.all([
          Promise.all(
            histories.map((item) =>
              researchApi<DeckVersion[]>(
                `/api/deck-versions?conversationId=${item.id}&paperId=${paperId}`,
              ),
            ),
          ),
          c
            ? researchApi<AssistantTurn[]>(`/api/conversations/${c.id}/turns`)
            : Promise.resolve([]),
        ]);
        if (token !== epoch.current) return;
        conversation.current = c;
        setDraftOnly(false);
        const accepted =
          pending.current &&
          turns.find(
            (t) =>
              t.message.clientMessageId ===
              pending.current!.body.clientMessageId,
          );
        if (c && !readDraft(`tutor-ppt-request:${c.id}`, "")) {
          const last = chronological(turns).at(-1)?.message;
          if (last) {
            setRequest(last.question.split("用户要求：")[1] ?? "");
            setCount(last.slideCount ? String(last.slideCount) : "");
          }
        }
        if (accepted) {
          pending.current = undefined;
          writeDraft(pendingKey, null);
          writeDraft(`tutor-ppt-pending:${paperId}`, null);
          setAwaiting(false);
        }
        const ordered = chronological(decks.flat());
        setVersions(ordered);
        const view = readDraft(`tutor-ppt-view:${artifactId}`, {
          selected: "",
          page: 0,
        });
        setSelected(
          ordered.some((v) => v.id === view.selected)
            ? view.selected
            : (ordered.at(-1)?.id ?? ""),
        );
        const chosen =
          ordered.find((v) => v.id === view.selected) ?? ordered.at(-1);
        setPage(
          Math.max(
            0,
            Math.min(view.page, (chosen?.outline.slides.length ?? 1) - 1),
          ),
        );
        setTurn(accepted || chronological(turns).at(-1));
      })
      .catch((e) => {
        if (token === epoch.current) {
          setError(e.message);
          setRestoreFailed(true);
        }
      })
      .finally(() => {
        if (token === epoch.current) setLoading(false);
      });
    return () => {
      epoch.current++;
    };
  }, [paperId, artifactId, pendingKey, restoreAttempt]);
  useEffect(() => {
    if (!running || !turn) return;
    let stopped = false,
      polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await researchApi<AssistantTurn>(`/api/turns/${turn.id}`);
        if (stopped) return;
        if (terminal(next.status)) {
          const v = await researchApi<DeckVersion[]>(
            `/api/deck-versions?conversationId=${next.conversationId}&paperId=${paperId}`,
          );
          if (!stopped) {
            setVersions((old) =>
              chronological([
                ...old.filter(
                  (item) => item.conversationId !== next.conversationId,
                ),
                ...v,
              ]),
            );
            setSelected(chronological(v).at(-1)?.id ?? "");
            setPage(0);
          }
        }
        if (!stopped) setTurn(next);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        polling = false;
      }
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [turn?.id, running, paperId]);
  async function generate() {
    if (
      !paper ||
      lock.current ||
      loading ||
      restoreFailed ||
      importing ||
      running
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    setDownload("");
    const token = ++epoch.current;
    let accepted = false;
    try {
      if (!pending.current) {
        const c =
          conversation.current ??
          (await researchApi<ConversationState>("/api/conversations", {
            paperId,
            goal: "论文汇报生成专区",
            purpose: "ppt-generation",
            ...(draftOnly && artifactId ? { draftId: artifactId } : {}),
          }));
        conversation.current = c;
        setDraftOnly(false);
        if (artifactId !== c.id) {
          // Keep the current request mounted; adopt the artifact after submission.
          writeDraft("tutor-ppt-artifact", c.id);
        }
        const submission: PendingPpt = {
          conversationId: c.id,
          body: {
            clientMessageId: crypto.randomUUID(),
            mode: "live",
            paperId,
            module: "ppt",
            speechScript: false,
            ...(count ? { slideCount: Number(count) } : {}),
            question:
              `为已读过论文的人制作向老师汇报的医学论文PPT。讲清背景、研究问题、实验思路、关键方法、结果证据、创新与局限。按研究内容选择合适页数，自动使用论文原图；notes仅写独立交付的简洁讲述提示。无需教学考试或完整演讲稿。${request ? `用户要求：${request}` : ""}`.slice(
                0,
                2000,
              ),
          },
        };
        savePending(pendingKey, submission);
        pending.current = submission;
      }
      if (token === epoch.current) setAwaiting(true);
      const next = await researchApi<AssistantTurn>(
        `/api/conversations/${pending.current.conversationId}/messages`,
        pending.current.body,
      );
      writeDraft(pendingKey, null);
      pending.current = undefined;
      accepted = true;
      if (token === epoch.current) {
        setAwaiting(false);
        setTurn(next);
        setBusy(false);
        if (!artifactId) setArtifactId(next.conversationId);
      }
      if (terminal(next.status)) {
        const decks = await researchApi<DeckVersion[]>(
          `/api/deck-versions?conversationId=${next.conversationId}&paperId=${paperId}`,
        );
        if (token === epoch.current) {
          setVersions((old) =>
            chronological([
              ...old.filter(
                (item) => item.conversationId !== next.conversationId,
              ),
              ...decks,
            ]),
          );
          setSelected(chronological(decks).at(-1)?.id ?? "");
          setPage(0);
        }
      }
    } catch (e) {
      if (token === epoch.current) {
        setError((e as Error).message);
        if (accepted) setRestoreFailed(true);
      }
    } finally {
      lock.current = false;
      if (token === epoch.current) setBusy(false);
    }
  }
  const slide =
    current?.outline.slides[
      Math.min(page, (current?.outline.slides.length ?? 1) - 1)
    ];
  const ready =
    current?.status === "completed" &&
    !current.review.issues.some(
      (i) => !i.resolved && i.severity === "blocking",
    );
  function newPpt() {
    if (busy || running || awaiting) return;
    setArtifactId("");
    setPaperId("");
    setVersions([]);
    setSelected("");
    setTurn(undefined);
    setRequest("");
    setCount("");
    setDownload("");
    conversation.current = undefined;
    setDraftOnly(false);
  }
  async function createPptDraft() {
    if (lock.current || busy || running || awaiting) return;
    lock.current = true;
    setBusy(true);
    try {
      const draft = await researchApi<ArtifactSummary>(
        "/api/artifacts/ppt",
        {},
      );
      setArtifactId(draft.id);
      setDraftOnly(true);
      setPaperId("");
      setRequest("");
      setCount("");
      setVersions([]);
      setTurn(undefined);
      setSelected("");
      setDownload("");
      conversation.current = undefined;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="tg-zone" aria-label="PPT生成专区">
      <ArtifactNavigation
        kind="ppt"
        index={index}
        onCreateProject={onCreateProject}
        onEditProject={onEditProject}
        selected={artifactId}
        revision={`${artifactId}:${versions.length}:${turn?.status}`}
        disabled={loading || busy || importing || awaiting || !!running}
        onNew={() => void createPptDraft()}
        onSelect={(a) => {
          setRequest(
            readDraft(`tutor-ppt-request:${a.id}`, a.intake?.request ?? ""),
          );
          setCount(readDraft(`tutor-ppt-count:${a.id}`, a.intake?.count ?? ""));
          setDraftOnly(!!a.draftOnly);
          setArtifactId(a.id);
          setPaperId(a.paperId ?? a.intake?.paperId ?? "");
        }}
        onArchived={(id) => {
          if (id === artifactId) newPpt();
        }}
      />
      <header>
        <h2>论文汇报</h2>
        <p>选一篇论文，生成汇报 PPT 与独立讲述提示。下载后可自行修改。</p>
      </header>
      <div className="tg-card">
        {artifactId && paper && !papers.some((p) => p.id === paper.id) && (
          <p className="hint">
            来源论文已归档或移除，当前汇报继续使用保存的资料副本。
          </p>
        )}
        {artifactId && !draftOnly && paper ? (
          <p>来源：{paper.title}</p>
        ) : (
          <PaperPicker
            papers={papers}
            selected={paperId ? [paperId] : []}
            disabled={
              (!!artifactId && !draftOnly) ||
              loading ||
              busy ||
              awaiting ||
              !!running
            }
            onSelect={(ids) => setPaperId(ids[0] ?? "")}
            onBusyChange={setImporting}
            onImported={(p) => {
              setPapers((old) => [...old.filter((x) => x.id !== p.id), p]);
              onImported(p);
            }}
          />
        )}
        <label>
          补充要求（可选）
          <textarea
            disabled={busy || importing || awaiting || !!running}
            value={request}
            maxLength={1400}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="例如：15 分钟组会，重点说明实验设计"
          />
        </label>
        <details>
          <summary>生成选项</summary>
          <label>
            页数
            <select
              disabled={busy || importing || awaiting || !!running}
              value={count}
              onChange={(e) => setCount(e.target.value)}
            >
              <option value="">根据论文安排</option>
              {[6, 8, 10, 12, 16].map((n) => (
                <option key={n} value={n}>
                  {n} 页
                </option>
              ))}
            </select>
          </label>
        </details>
        <button
          className="rp-primary"
          disabled={
            !paper || loading || restoreFailed || importing || busy || !!running
          }
          onClick={() => void generate()}
        >
          {loading
            ? "正在恢复记录…"
            : busy
              ? "正在提交…"
              : awaiting
                ? "查询／重试提交"
                : turn?.status === "cancelled" || turn?.status === "failed"
                  ? "按当前要求重试"
                  : artifactId && !draftOnly
                    ? "按当前要求生成新版本"
                    : "生成汇报"}
        </button>
      </div>
      {awaiting && !busy && (
        <p>上次提交尚未确认。点击查询／重试会沿用同一任务编号。</p>
      )}
      {error && <p role="alert">{error}</p>}
      {restoreFailed && (
        <button
          disabled={loading}
          onClick={() => setRestoreAttempt((n) => n + 1)}
        >
          重试恢复记录
        </button>
      )}
      {running && (
        <p role="status">
          正在思考…{" "}
          <button
            onClick={() =>
              void researchApi<{ turn?: AssistantTurn }>(
                `/api/turns/${turn.id}/cancel`,
                {},
              )
                .then((r) => {
                  if (r.turn) setTurn(r.turn);
                })
                .catch((e) => setError(e.message))
            }
          >
            取消生成
          </button>
        </p>
      )}
      {turn && terminal(turn.status) && turn.status !== "completed" && (
        <p role="alert">
          {turn.error ?? turn.reply?.nextStep ?? "本次未完成，可重新生成。"}
        </p>
      )}
      {!!versions.length && (
        <div className="tg-version-browser">
          <strong>当前汇报的版本</strong>
          <div className="tg-version-cards" aria-label="已生成汇报列表">
            {versions.map((v) => (
              <div
                className={`tg-version-card ${current?.id === v.id ? "is-selected" : ""}`}
                key={v.id}
              >
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSelected(v.id);
                    setPage(0);
                    setDownload("");
                  }}
                >
                  <span>{new Date(v.createdAt).toLocaleString("zh-CN")}</span>
                  <small>
                    {v.status === "completed" ? "已完成" : "未完成"}
                  </small>
                </button>
              </div>
            ))}
          </div>
          {current && current.id !== versions.at(-1)?.id && ready && (
            <button
              disabled={busy || !!running}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const restored = await researchApi<DeckVersion>(
                    `/api/deck-versions/${versions.at(-1)!.id}/restore`,
                    {
                      conversationId: current.conversationId,
                      targetId: current.id,
                    },
                  );
                  setVersions((old) => chronological([...old, restored]));
                  setSelected(restored.id);
                  setPage(0);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              以此版本继续修改
            </button>
          )}
        </div>
      )}
      {current && slide && paper && (
        <div className="tg-card">
          <ResearchSlide
            slide={slide}
            paper={paper}
            page={page + 1}
            total={current.outline.slides.length}
            url={
              current.displayAssets?.[slideImageKey(slide) ?? ""]
                ? `/api/display-assets/${current.displayAssets[slideImageKey(slide)!]}`
                : slide.imageSource
                  ? paper.sources.find((s) => s.id === slide.imageSource)?.image
                  : undefined
            }
            crop={
              current.displayAssets?.[slideImageKey(slide) ?? ""]
                ? undefined
                : slide.imageCrop
            }
          />
          <div className="tg-actions">
            <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
              上一页
            </button>
            <span>
              {page + 1} / {current.outline.slides.length}
            </span>
            <button
              disabled={page >= current.outline.slides.length - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </button>
          </div>
          {ready && (
            <div className="tg-actions">
              <button
                disabled={busy}
                onClick={async () => {
                  const token = epoch.current;
                  setBusy(true);
                  setError("");
                  try {
                    const a = await researchApi<{ url: string }>(
                      `/api/deck-versions/${current.id}/export`,
                      { conversationId: current.conversationId },
                    );
                    if (token === epoch.current) setDownload(a.url);
                  } catch (e) {
                    if (token === epoch.current) setError((e as Error).message);
                  } finally {
                    if (token === epoch.current) setBusy(false);
                  }
                }}
              >
                准备 PPTX 下载
              </button>
              {download && (
                <a href={download} download>
                  下载 PPTX
                </a>
              )}
              <a
                href={`/api/deck-versions/${current.id}/speaking-notes?conversationId=${current.conversationId}`}
                download
              >
                下载独立讲述提示
              </a>
            </div>
          )}
          <details>
            <summary>这一页的讲述提示</summary>
            <ResearchMarkdown text={slide.notes} />
          </details>
          {!!current.review.issues.length && (
            <details>
              <summary>内容核对说明</summary>
              {current.review.issues
                .filter((i) => !i.resolved)
                .map((i) => (
                  <p key={i.id}>{i.suggestion}</p>
                ))}
            </details>
          )}
        </div>
      )}
    </section>
  );
}

export function PlanGeneration({
  papers: initial,
  onImported,
  index,
  onCreateProject,
  onEditProject,
}: {
  papers: PaperBundle[];
  onImported: (paper: PaperBundle) => void;
  index: WorkspaceIndex;
  onCreateProject: () => void;
  onEditProject: (id: string) => void;
}) {
  const [draftId, setDraftId] = useState(() =>
    readDraft("tutor-plan-draft-id", ""),
  );
  const [papers, setPapers] = useState(initial);
  useEffect(() => setPapers(initial), [initial]);
  const [form, setForm] = useState(() =>
    readDraft("tutor-plan-intake", {
      question: "",
      conditions: "",
      instruction: "",
      paperIds: [] as string[],
    }),
  );
  const [plans, setPlans] = useState<ResearchPlan[]>([]),
    [plan, setPlan] = useState<ResearchPlan>(),
    [job, setJob] = useState<PlanJob>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    pending = useRef<PendingPlan | undefined>(undefined),
    generation = useRef(0);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true),
    [awaiting, setAwaiting] = useState(false),
    [restoreFailed, setRestoreFailed] = useState(false),
    [restoreAttempt, setRestoreAttempt] = useState(0);
  const active = job && !planJobDone(job);
  useArtifactIntake(
    "plan",
    plan?.id || draftId,
    form,
    !loading && !busy && !active && !awaiting,
    setError,
  );
  useEffect(() => {
    writeDraft("tutor-plan-draft-id", draftId);
  }, [draftId]);
  useEffect(() => {
    writeDraft("tutor-plan-intake", form);
    if (plan) writeDraft(`tutor-plan-intake:${plan.id}`, form);
    else if (draftId) writeDraft(`tutor-plan-intake:${draftId}`, form);
  }, [form, plan?.id, draftId]);
  useEffect(() => {
    const token = ++generation.current;
    setLoading(true);
    setRestoreFailed(false);
    setError("");
    pending.current = pendingPlan();
    setAwaiting(!!pending.current);
    void researchApi<ResearchPlan[]>("/api/research-plans")
      .then(async (all) => {
        if (token !== generation.current) return;
        setPlans(chronological(all.filter((p) => !p.archived)));
        const id = pending.current?.id ?? readDraft("tutor-plan-selected", "");
        const p = all.find((p) => p.id === id && !p.archived);
        if (!p) {
          if (draftId) {
            const drafts =
              await researchApi<ArtifactSummary[]>("/api/artifacts");
            if (token !== generation.current) return;
            const draft = drafts.find(
              (a) =>
                a.kind === "plan" &&
                a.id === draftId &&
                a.draftOnly &&
                !a.archived,
            );
            if (draft) return;
            setDraftId("");
          }
          // A successful list response confirms that the selected record was
          // removed. Do not keep retrying a submission for a nonexistent plan.
          pending.current = undefined;
          writeDraft("tutor-plan-pending", null);
          writeDraft("tutor-plan-selected", null);
          setAwaiting(false);
          setPlan(undefined);
          setJob(undefined);
          return;
        }
        const jobs = await researchApi<PlanJob[]>(
          `/api/research-plans/${p.id}/jobs`,
        );
        if (token !== generation.current) return;
        const accepted =
          pending.current &&
          jobs.find((j) => j.requestKey === pending.current!.body.requestKey);
        if (accepted) {
          pending.current = undefined;
          writeDraft("tutor-plan-pending", null);
          setAwaiting(false);
        }
        setPlan(p);
        setJob(accepted || chronological(jobs).at(-1));
      })
      .catch((e) => {
        if (token === generation.current) {
          setError(e.message);
          setRestoreFailed(true);
        }
      })
      .finally(() => {
        if (token === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [restoreAttempt]);
  useEffect(() => {
    if (!active || !job) return;
    let stopped = false,
      polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await researchApi<PlanJob>(
          `/api/research-plan-jobs/${job.id}`,
        );
        const p = await researchApi<ResearchPlan>(
          `/api/research-plans/${job.planId}`,
        );
        const all = planJobDone(next)
          ? await researchApi<ResearchPlan[]>("/api/research-plans")
          : undefined;
        if (!stopped) {
          setJob(next);
          setPlan(p);
          if (planJobDone(next)) setSelectedVersion(p.currentVersion ?? "");
          if (all) setPlans(chronological(all));
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        polling = false;
      }
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, job?.id]);
  async function generate() {
    if (
      lock.current ||
      loading ||
      restoreFailed ||
      importing ||
      active ||
      !form.question.trim()
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    const token = ++generation.current;
    let accepted = false;
    try {
      if (!pending.current) {
        const sources = selectPlanSources(
          papers,
          form.paperIds,
          `${form.question}\n${form.conditions}\n${form.instruction}`,
        );
        const retained = (plan?.topic.sources ?? [])
          .filter(
            (r) =>
              r.paperId &&
              form.paperIds.includes(r.paperId) &&
              !papers.some((p) => p.id === r.paperId),
          )
          .map((r) => ({
            paperId: r.paperId!,
            sourceId: r.sourceId!,
            sourceVersion: r.sourceVersion!,
            ...(r.range ? { range: r.range } : {}),
          }));
        const topic = {
          question: form.question,
          conditions: form.conditions,
          sources: [...sources, ...retained],
        };
        const p = plan
          ? await researchApi<ResearchPlan>(
              `/api/research-plans/${plan.id}/topic`,
              { expectedTopicVersion: plan.topic.version, topic },
              "PUT",
            )
          : await researchApi<ResearchPlan>("/api/research-plans", {
              ...topic,
              ...(draftId ? { draftId } : {}),
            });
        const submission: PendingPlan = {
          id: p.id,
          body: {
            requestKey: crypto.randomUUID(),
            expectedVersion: p.currentVersion,
            expectedTopicVersion: p.topic.version,
            action: "generate",
            requestedScope: "full-plan",
            retrieveLiterature: true,
            instruction: form.instruction,
          },
        };
        savePending("tutor-plan-pending", submission);
        pending.current = submission;
        writeDraft("tutor-plan-selected", p.id);
        if (token === generation.current) {
          setPlan(p);
          setDraftId("");
          setJob(undefined);
          setPlans((old) =>
            chronological([...old.filter((item) => item.id !== p.id), p]),
          );
        }
      }
      if (token === generation.current) setAwaiting(true);
      const next = await researchApi<PlanJob>(
        `/api/research-plans/${pending.current.id}/jobs`,
        pending.current.body,
      );
      writeDraft("tutor-plan-pending", null);
      pending.current = undefined;
      accepted = true;
      if (token === generation.current) {
        setAwaiting(false);
        setJob(next);
      }
      const [p, all] = await Promise.all([
        researchApi<ResearchPlan>(`/api/research-plans/${next.planId}`),
        researchApi<ResearchPlan[]>("/api/research-plans"),
      ]);
      if (token === generation.current) {
        setPlan(p);
        setPlans(chronological(all));
      }
    } catch (e) {
      if (token === generation.current) {
        setError((e as Error).message);
        if (accepted) setRestoreFailed(true);
      }
    } finally {
      lock.current = false;
      if (token === generation.current) setBusy(false);
    }
  }
  async function showPlan(id: string, intake?: ArtifactSummary["intake"]) {
    if (!id || busy || active || awaiting) return;
    const token = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const [p, jobs] = await Promise.all([
        researchApi<ResearchPlan>(`/api/research-plans/${id}`),
        researchApi<PlanJob[]>(`/api/research-plans/${id}/jobs`),
      ]);
      if (token === generation.current) {
        setPlan(p);
        setJob(chronological(jobs).at(-1));
        setDraftId("");
        setForm(
          readDraft(`tutor-plan-intake:${id}`, {
            question: intake?.question ?? p.topic.question,
            conditions: intake?.conditions ?? p.topic.conditions,
            instruction: intake?.instruction ?? "",
            paperIds: intake?.paperIds ?? [
              ...new Set(
                p.topic.sources.flatMap((s) => (s.paperId ? [s.paperId] : [])),
              ),
            ],
          }),
        );
        writeDraft("tutor-plan-selected", id);
      }
    } catch (e) {
      if (token === generation.current) setError((e as Error).message);
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }
  const [selectedVersion, setSelectedVersion] = useState("");
  useEffect(
    () => setSelectedVersion(readDraft(`tutor-plan-view:${plan?.id}`, "")),
    [plan?.id],
  );
  useEffect(() => {
    if (
      plan &&
      selectedVersion &&
      plan.versions.some((v) => v.id === selectedVersion)
    )
      writeDraft(`tutor-plan-view:${plan.id}`, selectedVersion);
  }, [plan?.id, selectedVersion]);
  const version =
    plan?.versions.find((v) => v.id === selectedVersion) ??
    plan?.versions.find((v) => v.id === plan.currentVersion);
  function newPlan() {
    if (busy || active || awaiting) return;
    generation.current++;
    setPlan(undefined);
    setJob(undefined);
    setError("");
    setDraftId("");
    setForm({ question: "", conditions: "", instruction: "", paperIds: [] });
    writeDraft("tutor-plan-selected", "");
  }
  async function createPlanDraft() {
    if (lock.current || busy || active || awaiting) return;
    lock.current = true;
    setBusy(true);
    try {
      const draft = await researchApi<ArtifactSummary>(
        "/api/artifacts/plan",
        {},
      );
      setPlan(undefined);
      setJob(undefined);
      setError("");
      setDraftId(draft.id);
      setForm({ question: "", conditions: "", instruction: "", paperIds: [] });
      writeDraft("tutor-plan-selected", "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const ready = version && planVersionReady(version);
  return (
    <section className="tg-zone" aria-label="研究方案生成专区">
      <ArtifactNavigation
        kind="plan"
        index={index}
        onCreateProject={onCreateProject}
        onEditProject={onEditProject}
        selected={plan?.id || draftId}
        revision={`${draftId}:${plans.length}:${plan?.updatedAt}:${job?.status}`}
        disabled={loading || busy || importing || awaiting || !!active}
        onNew={() => void createPlanDraft()}
        onSelect={(a) => {
          if (!a.draftOnly) return void showPlan(a.id, a.intake);
          setPlan(undefined);
          setJob(undefined);
          setDraftId(a.id);
          writeDraft("tutor-plan-selected", "");
          setForm(
            readDraft(`tutor-plan-intake:${a.id}`, {
              question: a.intake?.question ?? "",
              conditions: a.intake?.conditions ?? "",
              instruction: a.intake?.instruction ?? "",
              paperIds: a.intake?.paperIds ?? [],
            }),
          );
        }}
        onArchived={(id) => {
          setPlans((old) => old.filter((p) => p.id !== id));
          if (plan?.id === id || draftId === id) newPlan();
        }}
      />
      <header>
        <h2>研究方案</h2>
        <p>描述一个医学研究想法，获得适合与老师讨论的完整草案。</p>
      </header>
      <div className="tg-card">
        <label>
          研究方向或问题 <span aria-label="必填">*</span>
          <textarea
            disabled={busy || importing || awaiting || !!active}
            required
            aria-label="研究方向或问题"
            maxLength={3000}
            value={form.question}
            onChange={(e) => setForm({ ...form, question: e.target.value })}
            placeholder="例如：想研究某种干预如何影响某疾病的过程"
          />
        </label>
        <label>
          已有条件与限制（可选）
          <textarea
            disabled={busy || importing || awaiting || !!active}
            maxLength={5000}
            value={form.conditions}
            onChange={(e) => setForm({ ...form, conditions: e.target.value })}
            placeholder="已有材料、可用数据、时间或资源；不清楚可以直说"
          />
        </label>
        <label>
          想法与补充要求（可选）
          <textarea
            disabled={busy || importing || awaiting || !!active}
            maxLength={3000}
            value={form.instruction}
            onChange={(e) => setForm({ ...form, instruction: e.target.value })}
            placeholder="你希望重点考虑什么，或已有怎样的初步思路"
          />
        </label>
        <PaperPicker
          papers={papers}
          selected={form.paperIds}
          multiple
          disabled={loading || busy || awaiting || !!active}
          onSelect={(ids) => setForm({ ...form, paperIds: ids })}
          onBusyChange={setImporting}
          onImported={(p) => {
            setPapers((old) => [...old.filter((x) => x.id !== p.id), p]);
            onImported(p);
          }}
        />
        <button
          className="rp-primary"
          disabled={
            !form.question.trim() ||
            loading ||
            restoreFailed ||
            importing ||
            busy ||
            !!active
          }
          onClick={() => void generate()}
        >
          {loading
            ? "正在恢复记录…"
            : busy
              ? "正在提交…"
              : awaiting
                ? "查询／重试提交"
                : job?.status === "cancelled" || job?.status === "failed"
                  ? "按当前要求重试"
                  : plan
                    ? "按当前要求生成新版本"
                    : "生成完整草案"}
        </button>
      </div>
      {awaiting && !busy && (
        <p>上次提交尚未确认。点击查询／重试会沿用同一任务编号。</p>
      )}
      {error && <p role="alert">{error}</p>}
      {restoreFailed && (
        <button
          disabled={loading}
          onClick={() => setRestoreAttempt((n) => n + 1)}
        >
          重试恢复记录
        </button>
      )}
      {active && (
        <p role="status">
          正在思考…{" "}
          <button
            onClick={() =>
              void researchApi<PlanJob>(
                `/api/research-plan-jobs/${job.id}/cancel`,
                {},
              )
                .then(setJob)
                .catch((e) => setError(e.message))
            }
          >
            取消生成
          </button>
        </p>
      )}
      {job?.error && (
        <p role="alert">{job.error} 已有内容保留，可调整输入重新生成。</p>
      )}
      {!!plan?.versions.length && (
        <div className="tg-version-browser">
          <strong>当前方案的版本</strong>
          <div className="tg-version-cards" aria-label="方案版本列表">
            {plan.versions.map((v) => (
              <div
                className={`tg-version-card ${version?.id === v.id ? "is-selected" : ""}`}
                key={v.id}
              >
                <button type="button" onClick={() => setSelectedVersion(v.id)}>
                  <span>{v.content.title}</span>
                  <small>{new Date(v.createdAt).toLocaleString("zh-CN")}</small>
                </button>
              </div>
            ))}
          </div>
          {version && version.id !== plan.currentVersion && (
            <button
              disabled={loading || busy || !!active}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const restored = await researchApi<ResearchPlan>(
                    `/api/research-plans/${plan.id}/restore`,
                    {
                      versionId: version.id,
                      expectedVersion: plan.currentVersion,
                      expectedTopicVersion: plan.topic.version,
                    },
                  );
                  setPlan(restored);
                  setSelectedVersion(restored.currentVersion ?? "");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              以此版本继续修改
            </button>
          )}
        </div>
      )}
      {version && (
        <article className="tg-card">
          <h2>{version.content.title}</h2>
          {ready && (
            <div className="tg-actions">
              <a
                href={`/api/research-plans/${plan!.id}/exports/${version.id}?format=docx`}
                download
              >
                下载 Word
              </a>
              <a
                href={`/api/research-plans/${plan!.id}/exports/${version.id}?format=md`}
                download
              >
                下载 Markdown
              </a>
            </div>
          )}
          {!ready && <p>当前草案尚未完成核对，保留供查看。</p>}
          {version.review && (
            <section aria-label="需与导师讨论">
              <h3>需与导师讨论</h3>
              {version.review.issues.map((issue) => (
                <p key={issue.id}>
                  {version.content.sections.find(
                    (s) => s.id === issue.sectionId,
                  )?.title ?? "整体方案"}
                  {issue.severity === "blocking" ? " · 尚需修正：" : "："}
                  {issue.message}
                </p>
              ))}
              {version.review.limitations.map((text, index) => (
                <p key={index}>{text}</p>
              ))}
            </section>
          )}
          {version.content.sections.map((s) => (
            <section key={s.id}>
              <h3>{s.title}</h3>
              <ResearchMarkdown text={s.text} />
              <details>
                <summary>设计理由</summary>
                <ResearchMarkdown text={s.rationale} />
              </details>
            </section>
          ))}
          <details>
            <summary>待讨论条件与来源</summary>
            {[
              ...version.content.assumptions,
              ...version.content.questions,
              ...version.content.limitations,
            ].map((s, i) => (
              <p key={i}>{s}</p>
            ))}
            {version.topic.sources.map((s) => (
              <p key={s.id}>
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                ) : (
                  s.title
                )}{" "}
                · {s.locator}
              </p>
            ))}
          </details>
        </article>
      )}
    </section>
  );
}
