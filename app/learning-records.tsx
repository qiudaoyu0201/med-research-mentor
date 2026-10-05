import React, { useEffect, useState } from "react";
import type {
  ConversationState,
  LearningRecord,
  TaskRun,
} from "../shared/types.ts";
import { request } from "./conversation.tsx";

function RecordEditor({
  record,
  busy,
  update,
  undo,
  remove,
  view,
}: {
  record: LearningRecord;
  busy: boolean;
  update: (record: LearningRecord, patch: unknown) => void;
  undo: (record: LearningRecord) => void;
  remove: (record: LearningRecord) => void;
  view: (id: string) => void;
}) {
  const [text, setText] = useState(record.text),
    [feedback, setFeedback] = useState(record.feedback),
    [resolved, setResolved] = useState(record.resolved);
  useEffect(() => {
    setText(record.text);
    setFeedback(record.feedback);
    setResolved(record.resolved);
  }, [record.id, record.version]);
  return (
    <article className="personal-record">
      <h4>
        {record.kind === "favorite"
          ? "收藏解释"
          : record.kind === "feedback"
            ? "我的主动反馈"
            : "我的待解决问题"}
      </h4>
      <textarea
        aria-label="学习记录内容"
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
      />
      {record.kind === "feedback" && (
        <label>
          我的反馈
          <select
            aria-label="记录反馈状态"
            value={feedback}
            onChange={(e) =>
              setFeedback(e.target.value as LearningRecord["feedback"])
            }
          >
            <option value="read">读过</option>
            <option value="confused">仍不理解</option>
            <option value="understood">主动确认理解</option>
          </select>
        </label>
      )}
      {record.kind === "question" && (
        <label>
          <input
            type="checkbox"
            checked={resolved}
            onChange={(e) => setResolved(e.target.checked)}
          />
          我确认这个问题已解决
        </label>
      )}
      <div className="action-row">
        <button
          disabled={busy || !text.trim()}
          onClick={() =>
            update(record, {
              text,
              ...(record.kind === "feedback" ? { feedback } : {}),
              ...(record.kind === "question" ? { resolved } : {}),
            })
          }
        >
          保存记录编辑
        </button>
        <button
          disabled={busy || !record.history.length}
          onClick={() => undo(record)}
        >
          撤销记录编辑
        </button>
        <button disabled={busy} onClick={() => remove(record)}>
          删除记录
        </button>
        {record.unitId && (
          <button disabled={busy} onClick={() => view(record.unitId!)}>
            回到关联讲解
          </button>
        )}
      </div>
      {record.sourceText && (
        <details>
          <summary>当时交付的解释</summary>
          <p>{record.sourceText}</p>
        </details>
      )}
    </article>
  );
}

export function PersonalRecordsPanel({
  state,
  ensure,
  onState,
  onView,
  disabled,
}: {
  state?: ConversationState;
  ensure: () => Promise<ConversationState>;
  onState: (state: ConversationState) => void;
  onView: (run: TaskRun) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const records = state?.learningRecords ?? [];
  async function mutate(
    record: LearningRecord,
    patch: unknown,
    action: "edit" | "undo" | "delete",
  ) {
    if (!state) return;
    setBusy(true);
    setError("");
    try {
      const latest = await request<ConversationState>(
        `/api/conversations/${state.id}`,
      );
      const next = await request<ConversationState>(
        `/api/conversations/${state.id}/records/${record.id}${action === "undo" ? "/undo" : ""}`,
        {
          version: latest.version,
          recordVersion: record.version,
          ...(action === "edit" ? (patch as object) : {}),
        },
        action === "delete" ? "DELETE" : action === "edit" ? "PUT" : "POST",
      );
      onState(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function addQuestion(value: string) {
    setBusy(true);
    setError("");
    try {
      const conversation = await ensure();
      const latest = await request<ConversationState>(
        `/api/conversations/${conversation.id}`,
      );
      onState(
        await request<ConversationState>(
          `/api/conversations/${conversation.id}/records`,
          { version: latest.version, kind: "question", text: value },
        ),
      );
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="personal-records" aria-label="个人学习记录">
      <h3>个人学习记录</h3>
      <p className="hint">
        收藏、主动反馈和待解决问题由你保存。确认理解是你的反馈；模拟试读与学习模拟另存。
      </p>
      <textarea
        aria-label="保存待解决问题"
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        placeholder="下次继续要解决的问题"
      />
      <button
        disabled={disabled || busy || !text.trim()}
        onClick={() => void addQuestion(text)}
      >
        保存我的问题
      </button>
      {state?.openQuestions.length ? (
        <details>
          <summary>讲解中提出的待补问题</summary>
          {state.openQuestions.map((q) => (
            <div key={q.id}>
              <p>{q.question}</p>
              <button
                disabled={disabled || busy}
                onClick={() => void addQuestion(q.question)}
              >
                保存到我的问题
              </button>
            </div>
          ))}
        </details>
      ) : null}
      {!records.length && <p className="hint">还没有主动保存的记录。</p>}
      {records.map((r) => (
        <RecordEditor
          key={r.id}
          record={r}
          busy={busy || disabled}
          update={(r, p) => void mutate(r, p, "edit")}
          undo={(r) => void mutate(r, {}, "undo")}
          remove={(r) => void mutate(r, {}, "delete")}
          view={(id) =>
            void request<TaskRun>(`/api/tasks/${id}`)
              .then(onView)
              .catch((err) => setError(err.message))
          }
        />
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
