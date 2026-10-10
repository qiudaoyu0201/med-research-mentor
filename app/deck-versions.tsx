import React, { useEffect, useState } from "react";
import type {
  ConversationState,
  DeckOutline,
  DeckVersion,
  Slide,
} from "../shared/types.ts";
import { request } from "./conversation.tsx";
function SlidePreview({ label, slide }: { label: string; slide?: Slide }) {
  return (
    <div>
      <strong>{label}</strong>
      {slide ? (
        <>
          <p>{slide.title}</p>
          <ul>
            {slide.bullets.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
          <p>讲稿：{slide.notes}</p>
          {slide.imageSource && <p>保留原图</p>}
        </>
      ) : (
        <p>父版本未加载</p>
      )}
    </div>
  );
}

export function DeckVersionPanel({
  conversation,
  ensure,
  paperId,
  runId,
  outline,
  onVersion,
  onState,
  onExport,
}: {
  conversation?: ConversationState;
  ensure: () => Promise<ConversationState>;
  paperId: string;
  runId?: string;
  outline: DeckOutline;
  onVersion: (version: DeckVersion, keepDraft?: boolean) => void;
  onState: (state: ConversationState) => void;
  onExport: (url: string) => void;
}) {
  const [versions, setVersions] = useState<DeckVersion[]>([]);
  const [current, setCurrent] = useState<DeckVersion>();
  const [working, setWorking] = useState<DeckVersion>();
  const [page, setPage] = useState(0);
  const [question, setQuestion] = useState("");
  const [method, setMethod] = useState("manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh(id: string) {
    const values = await request<DeckVersion[]>(
      `/api/deck-versions?conversationId=${id}&paperId=${paperId}`,
    );
    setVersions(values);
    return values;
  }
  useEffect(() => {
    let closed = false;
    if (!conversation) {
      setCurrent(undefined);
      setVersions([]);
      return;
    }
    refresh(conversation.id)
      .then((values) => {
        if (closed) return;
        const selected =
          values.find(
            (v) =>
              v.id === conversation.latestDeckVersionId &&
              v.status === "completed",
          ) ?? values.filter((v) => v.status === "completed").at(-1);
        setCurrent(selected);
        if (selected && selected.id !== current?.id) onVersion(selected);
      })
      .catch((err) => setError(err.message));
    return () => {
      closed = true;
    };
  }, [conversation?.id, conversation?.latestDeckVersionId, paperId]);
  useEffect(() => {
    if (!working) return;
    let closed = false;
    const timer = setInterval(() => {
      request<DeckVersion>(`/api/deck-versions/${working.id}`)
        .then(async (version) => {
          if (closed) return;
          setWorking(version);
          if (
            ["completed", "failed", "cancelled", "interrupted"].includes(
              version.status,
            )
          ) {
            await refresh(version.conversationId);
            if (version.status === "completed") {
              const state = await request<ConversationState>(
                `/api/deck-versions/${version.id}/select`,
                { conversationId: version.conversationId },
              );
              if (!closed) {
                setCurrent(version);
                onVersion(version, true);
                onState(state);
              }
            } else if (!closed)
              setError(version.error ?? "修改未完成，旧版保留。");
            if (!closed) {
              setWorking(undefined);
              setBusy(false);
            }
          }
        })
        .catch((err) => {
          if (!closed) {
            setError(err.message);
            setBusy(false);
          }
        });
    }, 650);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [working?.id]);
  async function base() {
    const state = await ensure();
    if (current) return current;
    const version = await request<DeckVersion>("/api/deck-versions", {
      conversationId: state.id,
      paperId,
      ...(runId ? { runId } : {}),
    });
    setCurrent(version);
    setVersions((prev) => [...prev, version]);
    return version;
  }
  async function edit() {
    setError("");
    setBusy(true);
    try {
      const parent = await base();
      const version = await request<DeckVersion>(
        `/api/deck-versions/${parent.id}/edit`,
        {
          conversationId: parent.conversationId,
          slideIndex: page,
          question:
            question || `保存我对第 ${page + 1} 页的修改，并核对事实与引用。`,
          ...(method === "manual" ? { slide: outline.slides[page] } : {}),
        },
      );
      setWorking(version);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  async function restore(target: DeckVersion) {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const version = await request<DeckVersion>(
        `/api/deck-versions/${current.id}/restore`,
        { conversationId: target.conversationId, targetId: target.id },
      );
      setCurrent(version);
      onVersion(version);
      onState(
        await request<ConversationState>(
          `/api/conversations/${target.conversationId}`,
        ),
      );
      await refresh(target.conversationId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="deck-version-panel" aria-label="汇报版本记录">
      <h3>逐页修改与版本</h3>
      <p className="hint">
        每次只保存指定页。修改内容会核对，其他页的未保存编辑继续留在编辑器中；导出前逐页保存。
      </p>
      <label>
        指定页
        <select
          aria-label="指定修改页"
          value={page}
          onChange={(e) => setPage(Number(e.target.value))}
        >
          {outline.slides.map((s, i) => (
            <option key={i} value={i}>
              第 {i + 1} 页：{s.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        修改方式
        <select
          aria-label="汇报修改方式"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        >
          <option value="manual">保存我的页面编辑</option>
          <option value="assistant">按要求改写这一页</option>
        </select>
      </label>
      <textarea
        aria-label="单页修改要求"
        value={question}
        rows={3}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="例如：第二页讲得通俗一些，保留证据边界"
      />
      <button
        disabled={
          busy ||
          !outline.slides.length ||
          (method === "assistant" && !question.trim())
        }
        onClick={() => void edit()}
      >
        保存指定页并核对
      </button>
      {working && (
        <div role="status">
          <p>
            {working.status === "checking"
              ? "正在核对修改页"
              : "正在修改指定页"}
          </p>
          <button
            onClick={() =>
              void request(`/api/deck-versions/${working.id}/cancel`, {}).catch(
                (err) => setError(err.message),
              )
            }
          >
            停止页面修改
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {current && (
        <p className="hint">
          当前版本：{new Date(current.createdAt).toLocaleTimeString()} ·{" "}
          {current.origin === "example" ? "固定示例作为起点" : "资料汇报"}
          {current.parentId ? " · 有父版本" : ""}
        </p>
      )}
      <details>
        <summary>比较与恢复已有版本（{versions.length}）</summary>
        {versions.map((v) => (
          <article key={v.id}>
            <p>
              {new Date(v.createdAt).toLocaleTimeString()} ·{" "}
              {v.slideIndex !== undefined
                ? `修改第 ${v.slideIndex + 1} 页`
                : v.restoredFrom
                  ? "恢复版本"
                  : "初始版本"}{" "}
              · {v.status === "completed" ? "可继续使用" : "草稿，未通过"}
            </p>
            {v.slideIndex !== undefined && (
              <details>
                <summary>查看页面差异</summary>
                <SlidePreview
                  label="父版"
                  slide={
                    versions.find((p) => p.id === v.parentId)?.outline.slides[
                      v.slideIndex
                    ]
                  }
                />
                <SlidePreview
                  label="此版"
                  slide={v.outline.slides[v.slideIndex]}
                />
              </details>
            )}
            {v.error && <p>{v.error}</p>}
            {v.review.issues
              .filter((i) => !i.resolved)
              .map((i) => (
                <p key={i.id}>
                  {i.location}：{i.suggestion}
                </p>
              ))}
            <button
              disabled={
                busy ||
                v.status !== "completed" ||
                !current ||
                v.id === current.id
              }
              onClick={() => void restore(v)}
            >
              恢复此版本
            </button>
            <button
              disabled={busy || v.status !== "completed"}
              onClick={() =>
                void request<{ url: string }>(
                  `/api/deck-versions/${v.id}/export`,
                  { conversationId: v.conversationId },
                )
                  .then((value) => onExport(value.url))
                  .catch((err) => setError(err.message))
              }
            >
              导出此版本
            </button>
          </article>
        ))}
      </details>
    </section>
  );
}
