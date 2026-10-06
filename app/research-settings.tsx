import { useEffect, useRef, useState } from "react";
import type { ConversationState, Profile } from "../shared/types.ts";
import { researchApi } from "./research-api.ts";
import type { ResearchFont, ResearchTheme } from "./research-theme.ts";
import {
  focusLabels,
  verbosityLabels,
  legacyPreferences,
} from "../shared/learning-intent.ts";
export function ResearchSettings({
  conversation,
  onState,
  ensure,
  close,
  reset,
  theme,
  onTheme,
  font,
  onFont,
  autoGuide,
  onAutoGuide,
}: {
  conversation?: ConversationState;
  onState: (state: ConversationState) => void;
  ensure: () => Promise<ConversationState>;
  close: () => void;
  reset: () => void;
  theme: ResearchTheme;
  onTheme: (theme: ResearchTheme) => void;
  font: ResearchFont;
  onFont: (font: ResearchFont) => void;
  autoGuide: boolean;
  onAutoGuide: (value: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [profiles, setProfiles] = useState<Profile[]>([]),
    [model, setModel] = useState<{
      model: string;
      authenticated: boolean;
      configured?: boolean;
      note?: string;
      error?: string;
    }>();
  const [error, setError] = useState(""),
    [working, setWorking] = useState(false);
  const learning =
    conversation?.learningPreferences ??
    legacyPreferences(conversation?.explanationDepth);
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
        外观
        <select
          aria-label="外观"
          value={theme}
          onChange={(e) => onTheme(e.target.value as ResearchTheme)}
        >
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </label>
      <label>
        界面与阅读字体
        <select
          aria-label="阅读字体"
          value={font}
          onChange={(e) => onFont(e.target.value as ResearchFont)}
        >
          <option value="system">系统无衬线 · 简洁清晰</option>
          <option value="source-han">思源黑体</option>
        </select>
        <small>导航、正文和控件统一使用所选字体，原始 PDF 保留原文样式。</small>
      </label>
      <label>
        <span className="rw-switch-row">
          自动整理阅读起点
          <input
            className="rw-switch"
            role="switch"
            aria-label="自动整理阅读起点"
            type="checkbox"
            checked={autoGuide}
            onChange={(e) => onAutoGuide(e.target.checked)}
          />
        </span>
        <small>
          开启后，无聊天且没有有效缓存的论文会自动整理；服务端禁用时仍以手动方式使用。
        </small>
      </label>
      <label>
        学习背景
        <select
          aria-label="学习背景"
          disabled={working || !profiles.length}
          value={conversation?.profileId ?? profiles[0]?.id ?? ""}
          onChange={(e) => void preference({ profileId: e.target.value })}
        >
          {!profiles.length && (
            <option value={conversation?.profileId ?? ""}>
              正在读取学习背景…
            </option>
          )}
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
          value={learning.verbosity}
          onChange={(e) =>
            void preference({
              learningPreferences: { verbosity: e.target.value },
            })
          }
        >
          {Object.entries(verbosityLabels).map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <label>
        学习重点
        <select
          aria-label="学习重点"
          disabled={working}
          value={learning.focus}
          onChange={(e) =>
            void preference({ learningPreferences: { focus: e.target.value } })
          }
        >
          {Object.entries(focusLabels).map(([v, text]) => (
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
          {model.authenticated
            ? "已登录"
            : model.configured
              ? "已配置，待实际验证"
              : (model.error ?? "未连接")}
          {model.note && <small>{model.note}</small>}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </dialog>
  );
}
