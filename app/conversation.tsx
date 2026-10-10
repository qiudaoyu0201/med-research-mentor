import React, { useEffect, useRef, useState } from "react";
import type {
  AssistantMessage,
  AssistantTurn,
  ConversationState,
  TaskRun,
} from "../shared/types.ts";

export async function request<T>(
  url: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "保存或读取失败");
  return value;
}
type Turn = AssistantTurn & { run?: TaskRun };
export function useConversation(
  onRun: (run: TaskRun) => void,
  onError: (message: string) => void,
  onReset?: () => void,
) {
  const [state, setState] = useState<ConversationState>();
  const [choices, setChoices] = useState<ConversationState[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sending, setSending] = useState(false);
  const [focus, setFocus] = useState<AssistantMessage["focus"]>();
  const callbacks = useRef({ onRun, onError, onReset });
  callbacks.current = { onRun, onError, onReset };
  const stateRef = useRef(state);
  stateRef.current = state;
  const loading = useRef<Promise<ConversationState> | undefined>(undefined);
  const revision = useRef(0);
  async function select(id?: string) {
    const token = ++revision.current;
    setTurns([]);
    setFocus(undefined);
    if (!id) {
      callbacks.current.onReset?.();
      setState(undefined);
      stateRef.current = undefined;
      localStorage.removeItem("tutor-conversation");
      return;
    }
    const next = await request<ConversationState>(`/api/conversations/${id}`);
    const history = await request<Turn[]>(`/api/conversations/${id}/turns`);
    if (token !== revision.current) return;
    stateRef.current = next;
    setState(next);
    setTurns(history);
    localStorage.setItem("tutor-conversation", id);
    const last = history.at(-1)?.run;
    if (last) callbacks.current.onRun(last);
  }
  useEffect(() => {
    let closed = false;
    request<ConversationState[]>("/api/conversations")
      .then(async (values) => {
        if (closed) return;
        setChoices(values);
        const saved = localStorage.getItem("tutor-conversation");
        if (saved && values.some((v) => v.id === saved)) await select(saved);
      })
      .catch((error) => callbacks.current.onError(error.message));
    return () => {
      closed = true;
      revision.current++;
    };
  }, []);
  async function ensure() {
    if (stateRef.current) return stateRef.current;
    loading.current ??= request<ConversationState>("/api/conversations", {})
      .then((next) => {
        stateRef.current = next;
        setState(next);
        setChoices((prev) => [...prev, next]);
        localStorage.setItem("tutor-conversation", next.id);
        return next;
      })
      .finally(() => {
        loading.current = undefined;
      });
    return loading.current;
  }
  const active = turns.find(
    (t) =>
      ![
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "clarification",
      ].includes(t.status),
  );
  useEffect(() => {
    if (!active) return;
    let closed = false;
    const tick = async () => {
      try {
        const value = await request<Turn>(`/api/turns/${active.id}`);
        if (closed) return;
        setTurns((prev) => prev.map((t) => (t.id === value.id ? value : t)));
        if (value.run) callbacks.current.onRun(value.run);
        if (
          [
            "completed",
            "failed",
            "cancelled",
            "interrupted",
            "clarification",
          ].includes(value.status)
        ) {
          const next = await request<ConversationState>(
            `/api/conversations/${value.conversationId}`,
          );
          if (!closed) {
            stateRef.current = next;
            setState(next);
            setChoices((prev) =>
              prev.map((c) => (c.id === next.id ? next : c)),
            );
          }
        }
      } catch (error) {
        if (!closed) callbacks.current.onError((error as Error).message);
      }
    };
    const timer = setInterval(() => void tick(), 650);
    void tick();
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [active?.id]);
  async function send(
    question: string,
    options: Omit<AssistantMessage, "question" | "clientMessageId">,
  ) {
    setSending(true);
    try {
      const conversation = await ensure();
      const value = await request<Turn>(
        `/api/conversations/${conversation.id}/messages`,
        { ...options, question, clientMessageId: crypto.randomUUID() },
      );
      setTurns((prev) => [...prev, value]);
      setFocus(undefined);
      if (value.run) callbacks.current.onRun(value.run);
      return value;
    } finally {
      setSending(false);
    }
  }
  async function cancel() {
    if (active) await request(`/api/turns/${active.id}/cancel`, {});
  }
  return {
    state,
    ensure,
    setState,
    choices,
    turns,
    sending,
    active,
    send,
    select,
    cancel,
    focus,
    setFocus,
    view: (run: TaskRun) => callbacks.current.onRun(run),
  };
}

export function ConversationPanel({
  chat,
  options,
  disabled,
}: {
  chat: ReturnType<typeof useConversation>;
  options: Omit<AssistantMessage, "question" | "clientMessageId">;
  disabled: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState<AssistantMessage["depth"]>("standard");
  const [check, setCheck] = useState(false);
  const [error, setError] = useState("");
  const busy = disabled || chat.sending || Boolean(chat.active);
  const latest = chat.turns.at(-1);
  const status: Record<string, string> = {
    queued: "准备材料",
    planning: "确认问题与材料",
    running: "处理中",
    teaching: "正在讲解",
    novice: "模拟试读",
    checking: "核对出处",
    revising: "补足具体问题",
    rereading: "模拟复读",
    rechecking: "复核修改",
    completed: "已完成",
    failed: "失败，记录已保留",
    cancelled: "已停止",
    interrupted: "已中断",
    clarification: "需要补充材料或指代",
  };
  return (
    <section className="conversation-panel" aria-label="统一科研对话">
      <div className="action-row">
        <h3>科研对话</h3>
        <select
          aria-label="继续已有对话"
          disabled={busy}
          value={chat.state?.id ?? ""}
          onChange={(e) =>
            void chat
              .select(e.target.value || undefined)
              .catch((err) => setError(err.message))
          }
        >
          <option value="">新对话</option>
          {chat.choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.goal.slice(0, 35) || "科研学习对话"}
            </option>
          ))}
        </select>
      </div>
      <ol className="chat-history">
        {chat.turns.map((t) => (
          <li key={t.id}>
            <p className="chat-question">你：{t.message.question}</p>
            <p role="status">
              {status[
                t.run &&
                !["failed", "cancelled", "interrupted"].includes(t.status)
                  ? t.run.status
                  : t.status
              ] ?? status[t.status]}
            </p>
            {t.reply?.content && (
              <button disabled={busy} onClick={() => t.run && chat.view(t.run)}>
                查看讲解：{t.reply.content.title}
              </button>
            )}
            {t.reply?.nextStep && <p>{t.reply.nextStep}</p>}
            {t.reply?.artifacts.map((a) => (
              <a key={a.id} href={a.url}>
                下载汇报
              </a>
            ))}
            {t.error && <p role="alert">{t.error}</p>}
            {t.reply?.pendingQuestions.length ? (
              <div className="pending-questions">
                <strong>待补充与影响</strong>
                {t.reply.pendingQuestions.map((q) => (
                  <p key={q.id}>{q.question}</p>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {chat.active && (
        <button
          onClick={() =>
            void chat.cancel().catch((err) => setError(err.message))
          }
        >
          停止本轮
        </button>
      )}
      {latest?.run?.draft &&
        !latest.run.result &&
        ["failed", "cancelled", "interrupted"].includes(latest.status) && (
          <details>
            <summary>查看已保存草稿（尚未核对，不可导出）</summary>
            {latest.run.draft.sections.map((s, i) => (
              <p key={i}>
                {s.title}：{s.text}
              </p>
            ))}
          </details>
        )}
      {chat.focus && (
        <div className="focused-question">
          <p>围绕这句话：{chat.focus.excerpt}</p>
          <button onClick={() => chat.setFocus(undefined)}>取消句子选择</button>
        </div>
      )}
      <label>
        讲解深度
        <select
          aria-label="讲解深度"
          value={depth}
          onChange={(e) =>
            setDepth(e.target.value as AssistantMessage["depth"])
          }
        >
          <option value="brief">简短</option>
          <option value="standard">解释与例子</option>
          <option value="deep">深入机制</option>
        </select>
      </label>
      <label className="check-option">
        <input
          type="checkbox"
          checked={check}
          onChange={(e) => setCheck(e.target.checked)}
        />
        请求模拟试读（表达检查）
      </label>
      <textarea
        aria-label="统一对话问题"
        rows={3}
        value={question}
        disabled={busy || options.mode === "example"}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder={
          chat.focus ? "这句话哪里没懂？" : "读图、补基础、整理汇报或继续追问"
        }
      />
      <button
        disabled={busy || !question.trim() || options.mode === "example"}
        onClick={() => {
          setError("");
          void chat
            .send(question, {
              ...options,
              depth,
              readabilityCheck: check,
              ...(chat.focus ? { focus: chat.focus } : {}),
            })
            .then(() => setQuestion(""))
            .catch((err) => setError(err.message));
        }}
      >
        发送对话
      </button>
      {options.mode === "example" && (
        <p className="hint">
          示例使用固定内容；在设置中切换实时对话后可自由追问。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
