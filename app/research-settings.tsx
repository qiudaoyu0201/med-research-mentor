import { useEffect, useRef, useState } from "react";
import type { ConversationState, Profile } from "../shared/types.ts";
import { researchApi } from "./research-api.ts";
export function ResearchSettings({
  conversation,
  onState,
  ensure,
  close,
  reset,
}: {
  conversation?: ConversationState;
  onState: (state: ConversationState) => void;
  ensure: () => Promise<ConversationState>;
  close: () => void;
  reset: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [profiles, setProfiles] = useState<Profile[]>([]),
    [model, setModel] = useState<{
      model: string;
      authenticated: boolean;
      error?: string;
    }>();
  const [error, setError] = useState(""),
    [working, setWorking] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    let closed = false;
    void researchApi<{ profiles: Profile[] }>("/api/bootstrap")
      .then((v) => {
        if (!closed) setProfiles(v.profiles);
      })
      .catch((err) => {
        if (!closed) setError(err.message);
      });
    return () => {
      closed = true;
    };
  }, []);
  async function preference(patch: object) {
    if (working) return;
    setWorking(true);
    try {
      const state = await ensure();
      onState(
        await researchApi<ConversationState>(
          `/api/conversations/${state.id}/preferences`,
          patch,
          "PATCH",
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <dialog ref={dialog} className="rp-settings rw-settings" onCancel={close}>
      <header className="rp-modal-heading">
        <h2>设置</h2>
        <button aria-label="关闭设置" onClick={close}>
          ×
        </button>
      </header>
      <p>讲解偏好保存在当前聊天，随时可用自然语言调整。</p>
      <label>
        学习背景
        <select
          aria-label="学习背景"
          disabled={working}
          value={conversation?.profileId ?? profiles[0]?.id ?? ""}
          onChange={(e) => void preference({ profileId: e.target.value })}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        讲解程度
        <select
          aria-label="讲解程度"
          disabled={working}
          value={conversation?.explanationDepth ?? "standard"}
          onChange={(e) =>
            void preference({ explanationDepth: e.target.value })
          }
        >
          {Object.entries({
            brief: "简单点",
            standard: "常规讲解",
            deep: "详细点",
            foundations: "从基础讲",
            mechanism: "重点解释机制",
          }).map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <button onClick={reset}>恢复默认布局</button>
      <button
        onClick={() =>
          void researchApi<typeof model>("/api/model")
            .then(setModel)
            .catch((err) => setError(err.message))
        }
      >
        检查模型连接
      </button>
      {model && (
        <p role="status">
          {model.model} ·{" "}
          {model.authenticated ? "已登录" : (model.error ?? "未连接")}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </dialog>
  );
}
