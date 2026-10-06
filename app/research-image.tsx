import { useEffect, useRef, useState } from "react";
import { ObjectMenu } from "./research-menu.tsx";
export function ResearchImage({
  url,
  title,
  caption,
  originalMissing,
  onPage,
  thumbnail,
}: {
  url: string;
  title: string;
  caption?: string;
  originalMissing?: boolean;
  onPage?: () => void;
  thumbnail?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [zoom, setZoom] = useState(1),
    [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const [smallOriginal, setSmallOriginal] = useState(false);
  useEffect(() => {
    setError(false);
    setSmallOriginal(false);
  }, [url]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return (
    <ObjectMenu
      objectKey={url}
      label={`${title}图件操作`}
      actions={[
        { label: "查看大图与完整图注", run: () => setOpen(true) },
        ...(onPage ? [{ label: "返回原论文页", run: onPage }] : []),
      ]}
    >
      <button
        ref={trigger}
        type="button"
        className={`rw-image-open ${thumbnail ? "rw-image-thumbnail" : ""}`}
        aria-label={`${title} · 查看大图`}
        onClick={() => {
          setZoom(1);
          setOpen(true);
        }}
      >
        {thumbnail ? <img src={url} alt="待发送图片" /> : `${title} · 查看大图`}
      </button>
      {open && (
        <dialog ref={dialog} className="rw-image-dialog" onCancel={close}>
          <header>
            <strong>{title}</strong>
            <button onClick={close}>返回</button>
          </header>
          <div className="rw-image-controls">
            <button
              disabled={zoom <= 1}
              onClick={() => setZoom(Math.max(1, zoom - 0.5))}
            >
              缩小
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              disabled={zoom >= 4}
              onClick={() => setZoom(Math.min(4, zoom + 0.5))}
            >
              放大
            </button>
            {onPage && (
              <button
                onClick={() => {
                  close();
                  onPage();
                }}
              >
                查看原页
              </button>
            )}
          </div>
          {originalMissing && (
            <p role="status">
              仅保留压缩图片，原件缺失；细节不清时请补充清晰图片。
            </p>
          )}
          {smallOriginal && !originalMissing && (
            <p role="status">
              原图尺寸较小，放大无法增加原有细节；标签读不清时请补充清晰图片。
            </p>
          )}
          {error && (
            <p role="alert">
              图片加载失败，请重试或补充原件。
              <button onClick={() => setError(false)}>重试</button>
            </p>
          )}
          <div className="rw-image-scroll">
            {!error && (
              <img
                src={url}
                alt={title}
                style={{ width: `${zoom * 100}%`, maxWidth: "none" }}
                onLoad={(e) =>
                  setSmallOriginal(
                    Math.max(
                      e.currentTarget.naturalWidth,
                      e.currentTarget.naturalHeight,
                    ) < 1200,
                  )
                }
                onError={() => setError(true)}
              />
            )}
          </div>
          {caption && (
            <details>
              <summary>完整图注／图片说明</summary>
              <p>{caption}</p>
            </details>
          )}
        </dialog>
      )}
    </ObjectMenu>
  );
}
