import { useEffect, useRef, useState } from "react";
import type { PaperBundle, Source } from "../shared/types.ts";
import type { SourceTranslation } from "../server/source-translation.ts";
import { researchApi } from "./research-api.ts";
import { ResearchMarkdown } from "./markdown.tsx";

interface PendingTranslation {
  requestKey: string;
  jobId?: string;
}
const pendingKey = (paper: PaperBundle, source: Source, offset: number) =>
  "tutor-translation-request:" +
  JSON.stringify([paper.id, paper.version, source.id, offset]);
function readPending(key: string): PendingTranslation | undefined {
  const raw = localStorage.getItem(key);
  if (!raw) return;
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value.requestKey !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value.requestKey) ||
    (value.jobId !== undefined && typeof value.jobId !== "string")
  )
    throw new Error("本地翻译请求记录损坏，已停止新请求，避免重复生成。");
  return value;
}
function savePending(key: string, value: PendingTranslation) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error(
      "无法保存翻译请求编号，尚未提交新请求。请检查浏览器存储空间后重试。",
    );
  }
}

export function BilingualSource({
  paper,
  source,
  initialOffset = 0,
  displayLabel,
}: {
  paper: PaperBundle;
  source: Source;
  initialOffset?: number;
  displayLabel?: string;
}) {
  const text = source.caption || source.text;
  const [offset, setOffset] = useState(
    () =>
      Math.max(
        0,
        Math.min(
          Math.floor(initialOffset / 3500),
          Math.max(0, Math.ceil(text.length / 3500) - 1),
        ),
      ) * 3500,
  );
  const [job, setJob] = useState<SourceTranslation>();
  const [pending, setPending] = useState<PendingTranslation>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const alive = useRef(true),
    submitting = useRef(false);
  const key = pendingKey(paper, source, offset);
  const active = !!job && ["queued", "running"].includes(job.status);
  const terminalFailure =
    !!job && ["failed", "cancelled", "interrupted"].includes(job.status);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setStorageReady(false);
    setJob(undefined);
    try {
      setPending(readPending(key));
      setError("");
      setStorageReady(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [key]);
  useEffect(() => {
    if (!active) return;
    let stopped = false,
      polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void researchApi<SourceTranslation>(`/api/translations/${job!.id}`)
        .then((v) => {
          if (!stopped) {
            setJob(v);
            setError("");
          }
        })
        .catch((e) => {
          if (!stopped)
            setError(`状态暂未确认：${e.message}。已保留原请求编号。`);
        })
        .finally(() => {
          polling = false;
        });
    }, 1200);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [job?.id, active]);

  const submit = async () => {
    if (submitting.current || !storageReady) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      let saved = terminalFailure ? undefined : readPending(key);
      if (!saved) {
        saved = { requestKey: crypto.randomUUID() };
        savePending(key, saved);
      }
      // Once a retry is durably reserved, its state is unknown until the
      // response arrives. Do not let the old failed job authorize another key.
      setJob(undefined);
      setPending(saved);
      const v = saved.jobId
        ? await researchApi<SourceTranslation>(
            `/api/translations/${saved.jobId}`,
          )
        : await researchApi<SourceTranslation>(
            `/api/papers/${paper.id}/translation`,
            { sourceId: source.id, offset, requestKey: saved.requestKey },
          );
      const accepted = { ...saved, jobId: v.id };
      savePending(key, accepted);
      if (alive.current) {
        setPending(accepted);
        setJob(v);
      }
    } catch (e) {
      if (alive.current)
        setError(
          `${(e as Error).message} 原请求编号会保留；下次点击先恢复原请求。`,
        );
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return (
    <details className="rw-bilingual">
      <summary>{displayLabel ?? "当前原文 · 中英对照"}</summary>
      <small>{source.locator}</small>
      {text.length > 3500 && (
        <label>
          原文范围
          <select
            disabled={busy || active}
            value={offset}
            onChange={(e) => {
              setOffset(Number(e.target.value));
              setStorageReady(false);
              setJob(undefined);
              setPending(undefined);
            }}
          >
            {Array.from({ length: Math.ceil(text.length / 3500) }, (_, i) => (
              <option key={i} value={i * 3500}>
                第 {i + 1} 段
              </option>
            ))}
          </select>
        </label>
      )}
      <blockquote lang="en">{text.slice(offset, offset + 3500)}</blockquote>
      {job?.translated && (
        <>
          <ResearchMarkdown text={job.translated} />
          {job.status !== "completed" && (
            <p role="status">
              这份译文尚未成功保存为已完成结果，原任务状态见下方。
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {job?.error && <p role="alert">{job.error}</p>}
      {terminalFailure && !job.error && (
        <p role="status">
          {job.status === "interrupted"
            ? "上次翻译因服务重启中断。"
            : job.status === "cancelled"
              ? "上次翻译已停止。"
              : "上次翻译未完成。"}
        </p>
      )}
      {!active && job?.status !== "completed" && (
        <>
          <button
            disabled={busy || !storageReady || !text}
            onClick={() => void submit()}
          >
            {busy
              ? "正在确认…"
              : terminalFailure
                ? "重新翻译这段原文"
                : pending
                  ? "恢复上次翻译请求"
                  : "翻译这段原文"}
          </button>
        </>
      )}
      {active && (
        <p role="status">
          正在思考…{" "}
          <button
            onClick={() =>
              void researchApi(`/api/translations/${job.id}/cancel`, {}).catch(
                (e) => setError(e.message),
              )
            }
          >
            停止
          </button>
        </p>
      )}
    </details>
  );
}
