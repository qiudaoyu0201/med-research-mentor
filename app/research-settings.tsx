import { useEffect, useRef, useState } from "react";
import type { ConversationState, Profile } from "../shared/types.ts";
import { researchApi } from "./research-api.ts";
import type { ArtifactSummary } from "../shared/workspace.ts";
import type { LearningPreferences } from "../shared/types.ts";
import type { ResearchFont, ResearchTheme } from "./research-theme.ts";
import {
  focusLabels,
  verbosityLabels,
  legacyPreferences,
} from "../shared/learning-intent.ts";
export function ResearchSettings({
  conversation,
  loading = false,
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
  onArchiveChange,
}: {
  conversation?: ConversationState;
  loading?: boolean;
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
  onArchiveChange: () => Promise<void>;
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
  const [archived, setArchived] = useState<{ id: string; title: string }[]>([]);
  const [archivedArtifacts, setArchivedArtifacts] = useState<ArtifactSummary[]>(
    [],
  );
  const [defaults, setDefaults] = useState<{
    learningPreferences: LearningPreferences;
    webLookup: boolean;
    rememberTerms: boolean;
  }>();
  const learning =
    conversation?.learningPreferences ??
    legacyPreferences(conversation?.explanationDepth);
  useEffect(() => {
    dialog.current?.showModal();
    let closed = false;
    void researchApi<NonNullable<typeof defaults>>("/api/tutor-settings")
      .then((v) => {
        if (!closed) setDefaults(v);
      })
      .catch((err) => {
        if (!closed) setError(err.message);
      });
    void researchApi<{ profiles: Profile[] }>("/api/bootstrap")
      .then((v) => {
        if (!closed) setProfiles(v.profiles);
      })
      .catch((err) => {
        if (!closed) setError(err.message);
      });
    void researchApi<{ id: string; title: string }[]>("/api/papers/archived")
      .then(setArchived)
      .catch((e) => {
        if (!closed) setError(e.message);
      });
    void researchApi<ArtifactSummary[]>("/api/artifacts")
      .then((items) => {
        if (!closed) setArchivedArtifacts(items.filter((a) => a.archived));
      })
      .catch((e) => {
        if (!closed) setError(e.message);
      });
    return () => {
      closed = true;
    };
  }, []);
  async function preference(patch: object) {
    if (working || loading) return;
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
  async function manageArtifact(item: ArtifactSummary, erase: boolean) {
    if (working) return;
    if (
      erase &&
      !window.confirm("彻底删除这份成果及其全部版本？此操作无法恢复。")
    )
      return;
    setWorking(true);
    setError("");
    try {
      await researchApi(
        `/api/artifacts/${item.kind}/${item.id}`,
        erase ? {} : { archived: false },
        erase ? "DELETE" : "PATCH",
      );
      setArchivedArtifacts((old) =>
        old.filter((a) => a.kind !== item.kind || a.id !== item.id),
      );
      window.dispatchEvent(new Event("artifacts-changed"));
      await onArchiveChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="rp-settings rw-settings"
      aria-labelledby="research-settings-title"
      onCancel={close}
    >
      <header className="rp-modal-heading">
        <h2 id="research-settings-title">设置</h2>
        <button aria-label="关闭设置" onClick={close}>
          ×
        </button>
      </header>
      <p>
        {loading
          ? "正在读取当前聊天的偏好…"
          : "讲解偏好保存在当前聊天，随时可用自然语言调整。"}
      </p>
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
          导入后开始中文带读
          <input
            className="rw-switch"
            role="switch"
            aria-label="导入后开始中文带读"
            type="checkbox"
            checked={autoGuide}
            onChange={(e) => onAutoGuide(e.target.checked)}
          />
        </span>
        <small>仅在主动导入且没有问题时开始；打开历史论文不会重复生成。</small>
      </label>
      <label>
        学习背景
        <select
          aria-label="学习背景"
          disabled={loading || working || !profiles.length}
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
      {defaults && (
        <fieldset disabled={working}>
          <legend>默认讲解与辅助功能</legend>
          <label>
            默认讲解程度
            <select
              aria-label="新论文默认讲解程度"
              value={defaults.learningPreferences.verbosity}
              onChange={(e) =>
                setDefaults({
                  ...defaults,
                  learningPreferences: {
                    ...defaults.learningPreferences,
                    verbosity: e.target
                      .value as LearningPreferences["verbosity"],
                  },
                })
              }
            >
              {Object.entries(verbosityLabels).map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <small>默认讲解程度仅用于新建聊天。当前聊天可在下面单独调整。</small>
          <label>
            <input
              type="checkbox"
              checked={defaults.webLookup}
              onChange={(e) =>
                setDefaults({ ...defaults, webLookup: e.target.checked })
              }
            />
            按需联网补充医学资料
          </label>
          <label>
            <input
              type="checkbox"
              checked={defaults.rememberTerms}
              onChange={(e) =>
                setDefaults({ ...defaults, rememberTerms: e.target.checked })
              }
            />
            适度减少跨论文重复解释
          </label>
          <button
            onClick={async () => {
              setWorking(true);
              setError("");
              try {
                setDefaults(
                  await researchApi("/api/tutor-settings", defaults, "PUT"),
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setWorking(false);
              }
            }}
          >
            保存设置
          </button>
          <small>
            联网补充和减少重复解释是全局开关，保存后从下一次请求起生效，包括已有聊天。
          </small>
        </fieldset>
      )}
      <label>
        讲解程度
        <select
          aria-label="讲解程度"
          disabled={loading || working}
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
          disabled={loading || working}
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
      <details>
        <summary>归档管理</summary>
        {archivedArtifacts.map((item) => (
          <div className="rw-archive-row" key={`${item.kind}:${item.id}`}>
            <span>
              {item.kind === "ppt" ? "PPT" : "方案"} · {item.title}
            </span>
            <button
              disabled={working}
              onClick={() => void manageArtifact(item, false)}
            >
              恢复
            </button>
            <button
              disabled={working}
              onClick={() => void manageArtifact(item, true)}
            >
              彻底删除
            </button>
          </div>
        ))}
        {!archived.length && <small>暂无已归档论文。</small>}
        {archived.map((paper) => (
          <div className="rw-archive-row" key={paper.id}>
            <span>{paper.title}</span>
            <button
              disabled={working}
              onClick={async () => {
                setWorking(true);
                try {
                  await researchApi(`/api/papers/${paper.id}/restore`, {});
                  setArchived((old) =>
                    old.filter((item) => item.id !== paper.id),
                  );
                  await onArchiveChange();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setWorking(false);
                }
              }}
            >
              恢复
            </button>
            <button
              disabled={working}
              onClick={async () => {
                if (
                  !window.confirm(
                    "彻底删除这篇论文及其论文资料？已有成果保留副本。",
                  )
                )
                  return;
                setWorking(true);
                try {
                  await researchApi(`/api/papers/${paper.id}`, {}, "DELETE");
                  setArchived((old) =>
                    old.filter((item) => item.id !== paper.id),
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setWorking(false);
                }
              }}
            >
              彻底删除
            </button>
          </div>
        ))}
      </details>
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
