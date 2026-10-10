import { useEffect, useRef, useState } from "react";
import {
  attachmentLimits,
  type ResearchAttachment,
} from "../shared/attachments.ts";
import { ResearchImage } from "./research-image.tsx";
import { ObjectMenu } from "./research-menu.tsx";

export interface PendingAttachment {
  id: string;
  file?: File;
  record?: ResearchAttachment;
}
const writes = new Map<string, Promise<unknown>>();
function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("research-attachment-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function stored(key: string, value?: PendingAttachment[]) {
  const db = await database();
  try {
    return await new Promise<PendingAttachment[]>((resolve, reject) => {
      const tx = db.transaction("drafts", value ? "readwrite" : "readonly"),
        store = tx.objectStore("drafts");
      const req = value ? store.put(value, key) : store.get(key);
      tx.oncomplete = () => resolve(value ?? req.result ?? []);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
function write(
  key: string,
  apply: (current: PendingAttachment[]) => PendingAttachment[],
) {
  const task = (writes.get(key) ?? Promise.resolve()).then(async () =>
    stored(key, apply(await stored(key))),
  );
  writes.set(
    key,
    task.catch(() => {}),
  );
  return task;
}
export function useAttachmentDraft(
  key: string,
  onError: (message: string) => void,
) {
  const [files, setFiles] = useState<PendingAttachment[]>([]),
    currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    let cancelled = false;
    setFiles([]);
    void (writes.get(key) ?? Promise.resolve())
      .then(() => stored(key))
      .then((value) => {
        if (!cancelled) setFiles(value);
      })
      .catch(() => {
        if (!cancelled) onError("附件草稿无法恢复，请重新添加文件。");
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  const update = (
    apply: (current: PendingAttachment[]) => PendingAttachment[],
  ) => {
    setFiles(apply);
    void write(key, apply).catch(() =>
      onError("附件草稿无法保存，请保持页面打开。"),
    );
  };
  return {
    files,
    add: (incoming: File[]) => {
      try {
        if (files.length + incoming.length > attachmentLimits.count)
          throw new Error("每次最多添加 4 个附件。");
        const combined = [...files.flatMap((a) => a.file ?? []), ...incoming];
        if (combined.filter((f) => /\.pdf$/i.test(f.name)).length > 1)
          throw new Error("每次发送只能包含一篇 PDF。");
        if (
          combined.reduce((sum, f) => sum + f.size, 0) >
          attachmentLimits.totalBytes
        )
          throw new Error("附件合计不能超过 40 MiB。");
        for (const f of incoming) {
          if (!f.size) throw new Error(`${f.name} 是空文件。`);
          if (!/\.(pdf|png|jpe?g)$/i.test(f.name))
            throw new Error("支持 PDF、PNG 和 JPEG。");
          if (
            f.size >
            (/\.pdf$/i.test(f.name)
              ? 30 * 1024 * 1024
              : attachmentLimits.imageBytes)
          )
            throw new Error(`${f.name} 超过大小限制。`);
        }
        const added = incoming.map((file) => ({
          id: crypto.randomUUID(),
          file,
        }));
        update((current) => [...current, ...added]);
      } catch (error) {
        onError((error as Error).message);
      }
    },
    remove: (id: string) =>
      update((current) => current.filter((a) => a.id !== id)),
    restore: (records: ResearchAttachment[]) =>
      update(() => records.map((record) => ({ id: record.id, record }))),
    sent: async (ids: string[], owner = key) => {
      await write(owner, (current) =>
        current.filter((a) => !ids.includes(a.id)),
      ).catch(() => {});
      if (currentKey.current === owner)
        setFiles((current) => current.filter((a) => !ids.includes(a.id)));
    },
  };
}
function Preview({ item }: { item: PendingAttachment }) {
  const [url, setUrl] = useState(
    item.record?.originalUrl ?? item.record?.image,
  );
  useEffect(() => {
    if (!item.file || /\.pdf$/i.test(item.file.name)) return;
    const next = URL.createObjectURL(item.file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [item.file]);
  return url ? (
    <ResearchImage
      url={url}
      title={item.file?.name ?? item.record?.name ?? "待发送图片"}
      originalMissing={!item.file && !item.record?.originalUrl}
      thumbnail
    />
  ) : (
    <span>PDF</span>
  );
}
export function PendingAttachments({
  files,
  remove,
}: {
  files: PendingAttachment[];
  remove: (id: string) => void;
}) {
  return (
    <div className="rw-attachments" aria-label="待发送附件">
      {files.map((item) => (
        <ObjectMenu
          key={item.id}
          objectKey={item.id}
          label={`附件操作 ${item.file?.name ?? item.record?.name}`}
          actions={[
            { label: "移除尚未发送的附件", run: () => remove(item.id) },
          ]}
        >
          <Preview item={item} />
          <span>{item.file?.name ?? item.record?.name}</span>
          <button
            type="button"
            aria-label={`移除附件 ${item.file?.name ?? item.record?.name}`}
            onClick={() => remove(item.id)}
          >
            ×
          </button>
          {/\.pdf$/i.test(item.file?.name ?? "") && (
            <small>发送后进入这篇论文的聊天</small>
          )}
        </ObjectMenu>
      ))}
    </div>
  );
}
export function MessageAttachments({
  values,
  onRetry,
  disabled,
}: {
  values: ResearchAttachment[];
  onRetry: (id: string, purpose?: string) => void;
  disabled: boolean;
}) {
  const [purposes, setPurposes] = useState<Record<string, string>>({});
  const labels = {
    ready: "可用于本次问题",
    unchecked: "待检查",
    checking: "正在检查",
    "needs-purpose": "补充用途",
    unrelated: "与当前问题无关",
    unreadable: "需清晰图片",
    failed: "处理失败",
  };
  return (
    <div className="rw-message-attachments">
      {values.map((a) => (
        <ObjectMenu
          key={a.id}
          objectKey={a.id}
          label={`附件操作 ${a.name}`}
          actions={[
            {
              label: "查看附件状态",
              run: () =>
                document.getElementById(`attachment-state-${a.id}`)?.focus(),
            },
            ...(a.status !== "ready" && a.image
              ? [
                  {
                    label: "补充用途",
                    run: () =>
                      document
                        .getElementById(`attachment-purpose-${a.id}`)
                        ?.focus(),
                  },
                  {
                    label: "重试这项附件",
                    disabled: disabled || Boolean(a.reason?.includes("上限")),
                    run: () => onRetry(a.id, purposes[a.id]),
                  },
                ]
              : []),
          ]}
        >
          {a.image && (
            <details>
              <summary>{a.name}</summary>
              <ResearchImage
                url={a.originalUrl ?? a.image}
                title={a.name}
                caption={a.description}
                originalMissing={!a.originalUrl}
              />
            </details>
          )}
          {!a.image && <strong>{a.name}</strong>}
          <span id={`attachment-state-${a.id}`} tabIndex={-1}>
            {labels[a.status]}
          </span>
          {a.reason && <p>{a.reason}</p>}
          {a.status !== "ready" && a.image && (
            <>
              <input
                id={`attachment-purpose-${a.id}`}
                aria-label={`图片用途 ${a.name}`}
                placeholder="补一句图片用途"
                maxLength={1000}
                value={purposes[a.id] ?? ""}
                onChange={(e) =>
                  setPurposes({ ...purposes, [a.id]: e.target.value })
                }
              />
              <button
                disabled={disabled || a.reason?.includes("上限")}
                onClick={() => onRetry(a.id, purposes[a.id])}
              >
                重试这项附件
              </button>
            </>
          )}
        </ObjectMenu>
      ))}
    </div>
  );
}
