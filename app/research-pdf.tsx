import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  TextLayer,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import type { PaperBundle, Source } from "../shared/types.ts";
import type { ResearchSelection } from "./research-discussion.tsx";
import "./research-pdf.css";
import { SelectionActions } from "./research-menu.tsx";
import {
  cropFromPoints,
  cropPixels,
  type CropPoint,
  type PdfCrop,
} from "./research-pdf-crop.ts";
import { ResearchImage } from "./research-image.tsx";
export function ResearchPdf({
  paper,
  sourceId,
  locatorRevision,
  onSource,
  onFocus,
}: {
  paper: PaperBundle;
  sourceId?: string;
  locatorRevision: number;
  onSource: (id: string) => void;
  onFocus: (selection: ResearchSelection, question: string) => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>(),
    [page, setPage] = useState(() => {
      try {
        return Math.max(
          1,
          Number(
            JSON.parse(localStorage.getItem(`research-pdf:${paper.id}`) ?? "{}")
              .page,
          ) || 1,
        );
      } catch {
        return 1;
      }
    }),
    [width, setWidth] = useState(450);
  const [zoom, setZoom] = useState(() => {
      try {
        return Math.max(
          0.5,
          Math.min(
            4,
            Number(
              JSON.parse(
                localStorage.getItem(`research-pdf:${paper.id}`) ?? "{}",
              ).zoom,
            ) || 1,
          ),
        );
      } catch {
        return 1;
      }
    }),
    [retry, setRetry] = useState(0),
    [hasText, setHasText] = useState(true),
    [limited, setLimited] = useState(false);
  const renderLock = useRef<Promise<unknown>>(Promise.resolve());
  const [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [quote, setQuote] = useState<{ source: Source; text: string }>();
  const wrap = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null);
  const cropKey = `research-pdf-crop:${JSON.stringify([paper.id, paper.version, page, sourceId ?? "page"])}`;
  const [cropping, setCropping] = useState(false),
    [crop, setCrop] = useState<PdfCrop>(),
    [cropDraft, setCropDraft] = useState<PdfCrop>(),
    [cropUrl, setCropUrl] = useState(""),
    [showCrop, setShowCrop] = useState(false),
    [cropError, setCropError] = useState("");
  const cropStart = useRef<CropPoint | undefined>(undefined);
  useEffect(() => {
    setCropping(false);
    setCropDraft(undefined);
    cropStart.current = undefined;
    setCropUrl("");
    setCropError("");
    try {
      const saved: PdfCrop = JSON.parse(
        localStorage.getItem(cropKey) ?? "null",
      );
      const valid = cropPixels(saved, 1000, 1000) ? saved : undefined;
      setCrop(valid);
      setShowCrop(!!valid);
    } catch {
      setCrop(undefined);
      setShowCrop(false);
    }
  }, [cropKey]);
  useEffect(() => {
    if (!pdf || !crop) return;
    let closed = false,
      rendering: RenderTask | undefined;
    setCropUrl("");
    setCropError("");
    void pdf
      .getPage(page)
      .then(async (pdfPage) => {
        if (closed) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(
          8,
          Math.min(width * 2, 1600) / (base.width * crop.width),
          Math.sqrt(
            4_000_000 / (base.width * crop.width * base.height * crop.height),
          ),
        );
        const viewport = pdfPage.getViewport({ scale });
        const pixels = cropPixels(crop, viewport.width, viewport.height);
        if (!pixels) throw new Error("局部范围无效，请重新框选。");
        const target = document.createElement("canvas");
        target.width = pixels.width;
        target.height = pixels.height;
        rendering = pdfPage.render({
          canvas: target,
          viewport,
          transform: [1, 0, 0, 1, -pixels.left, -pixels.top],
        });
        await rendering.promise;
        if (!closed) setCropUrl(target.toDataURL("image/png"));
      })
      .catch((err) => {
        if (!closed) setCropError(err.message);
      });
    return () => {
      closed = true;
      rendering?.cancel();
    };
  }, [pdf, page, crop, width]);
  function cropPoint(event: import("react").PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height,
    };
  }
  function beginCrop() {
    setShowCrop(false);
    setCropping(true);
    setCropDraft(undefined);
    cropStart.current = undefined;
    window.getSelection()?.removeAllRanges();
    setQuote(undefined);
  }
  useEffect(() => {
    if (!ready || !scroll.current) return;
    try {
      const position = JSON.parse(
        localStorage.getItem(
          `research-pdf-scroll:${paper.id}:${page}:${zoom}`,
        ) ?? "{}",
      );
      scroll.current.scrollLeft = position.left ?? 0;
      scroll.current.scrollTop = position.top ?? 0;
    } catch {}
  }, [ready, paper.id, page, zoom]);
  useEffect(() => {
    const clear = () => {
      const selection = window.getSelection();
      if (
        !selection?.toString() ||
        !selection.anchorNode ||
        !text.current?.contains(selection.anchorNode)
      )
        setQuote(undefined);
    };
    document.addEventListener("selectionchange", clear);
    return () => document.removeEventListener("selectionchange", clear);
  }, []);
  useEffect(() => {
    const source = paper.sources.find((s) => s.id === sourceId);
    if (source?.page) setPage(source.page);
  }, [sourceId, locatorRevision]);
  useEffect(() => {
    try {
      localStorage.setItem(
        `research-pdf:${paper.id}`,
        JSON.stringify({ page, zoom }),
      );
    } catch {}
  }, [paper.id, page, zoom]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(240, Math.floor(entry.contentRect.width))),
    );
    if (wrap.current) observer.observe(wrap.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let closed = false;
    setPdf(undefined);
    setError("");
    const loading = getDocument({ url: paper.pdfUrl!, useSystemFonts: true });
    void loading.promise
      .then((value) => {
        if (!closed) {
          setPdf(value);
          setPage((old) => Math.min(old, value.numPages));
        }
      })
      .catch((err) => {
        if (!closed) setError(err.message);
      });
    return () => {
      closed = true;
      void loading.destroy();
    };
  }, [paper.pdfUrl, retry]);
  useEffect(() => {
    if (!pdf || !canvas.current || !text.current) return;
    let closed = false,
      rendering: RenderTask | undefined,
      layer: TextLayer | undefined;
    setReady(false);
    setQuote(undefined);
    setError("");
    const operation = renderLock.current
      .catch(() => {})
      .then(async () => {
        if (closed) return;
        const pdfPage = await pdf.getPage(Math.min(page, pdf.numPages));
        if (closed) return;
        const viewport = pdfPage.getViewport({
          scale: (width * zoom) / pdfPage.getViewport({ scale: 1 }).width,
        });
        const target = canvas.current!,
          container = text.current!,
          ratio = Math.min(
            devicePixelRatio || 1,
            2,
            Math.sqrt(12_000_000 / (viewport.width * viewport.height)),
          );
        setLimited(ratio < Math.min(devicePixelRatio || 1, 2));
        target.width = Math.round(viewport.width * ratio);
        target.height = Math.round(viewport.height * ratio);
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        container.replaceChildren();
        container.style.setProperty(
          "--total-scale-factor",
          String(viewport.scale),
        );
        target.parentElement!.style.width = `${viewport.width}px`;
        target.parentElement!.style.height = `${viewport.height}px`;
        rendering = pdfPage.render({
          canvas: target,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        });
        // Attach the rejection handler before awaiting text extraction: closing
        // the reader may cancel the canvas while getTextContent is still pending.
        const rendered = rendering.promise.then(
          () => undefined,
          (err: unknown) => err,
        );
        const textContent = await pdfPage.getTextContent();
        if (closed) {
          rendering.cancel();
          await rendered;
          return;
        }
        setHasText(
          textContent.items.some((item) => "str" in item && item.str.trim()),
        );
        layer = new TextLayer({
          textContentSource: textContent,
          container,
          viewport,
        });
        if (closed) {
          layer.cancel();
          await rendered;
          return;
        }
        const [renderError] = await Promise.all([rendered, layer.render()]);
        if (renderError && !closed) throw renderError;
        if (!closed) setReady(true);
      })
      .catch((err) => {
        if (!closed) setError(err.message);
      });
    renderLock.current = operation;
    return () => {
      closed = true;
      rendering?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, width, zoom]);
  function select() {
    const selection = window.getSelection(),
      chosen = selection?.toString();
    if (
      !chosen?.trim() ||
      chosen.length > 2000 ||
      !selection?.anchorNode ||
      !selection.focusNode ||
      !text.current?.contains(selection.anchorNode) ||
      !text.current.contains(selection.focusNode)
    ) {
      setQuote(undefined);
      return;
    }
    const normalized = chosen.replace(/\s/g, "");
    const source = paper.sources.find(
      (s) =>
        s.kind === "paper" &&
        s.page === page &&
        s.text.replace(/\s/g, "").includes(normalized),
    );
    setQuote(source ? { source, text: chosen } : undefined);
  }
  return (
    <section
      className="rw-pdf"
      ref={wrap}
      aria-label="PDF 文字阅读"
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && cropping) {
          event.preventDefault();
          event.stopPropagation();
          setCropping(false);
          setCropDraft(undefined);
          cropStart.current = undefined;
        }
      }}
    >
      <div className="rw-pdf-controls">
        <label>
          页码
          <select
            aria-label="PDF 页码"
            value={page}
            onChange={(e) => {
              const next = Number(e.target.value);
              setPage(next);
              const source = paper.sources.find(
                (s) => s.kind === "paper" && s.page === next,
              );
              if (source) onSource(source.id);
            }}
          >
            {Array.from(
              { length: pdf?.numPages ?? paper.pageCount ?? 1 },
              (_, i) => (
                <option key={i} value={i + 1}>
                  第 {i + 1} 页
                </option>
              ),
            )}
          </select>
        </label>
        <button
          aria-label="缩小 PDF"
          disabled={zoom <= 0.5}
          onClick={() => setZoom((old) => Math.max(0.5, old - 0.25))}
        >
          −
        </button>
        <span aria-label="PDF 缩放比例">{Math.round(zoom * 100)}%</span>
        <button
          aria-label="放大 PDF"
          disabled={zoom >= 4}
          onClick={() => setZoom((old) => Math.min(4, old + 0.25))}
        >
          ＋
        </button>
        <button onClick={() => setZoom(1)}>适合宽度</button>
        <a
          href={`${paper.pdfUrl}#page=${page}`}
          target="_blank"
          rel="noreferrer"
        >
          原始 PDF ↗
        </a>
        {!ready && <small role="status">正在显示 PDF…</small>}
      </div>
      <div className="rw-pdf-local-actions">
        <button
          disabled={!ready}
          onClick={
            cropping
              ? () => {
                  setCropping(false);
                  setCropDraft(undefined);
                  cropStart.current = undefined;
                }
              : beginCrop
          }
        >
          {cropping ? "取消框选" : "框选局部"}
        </button>
        {crop && (
          <button
            onClick={() => {
              setCropping(false);
              setShowCrop((old) => !old);
            }}
          >
            {showCrop ? "查看整页" : "查看已选局部"}
          </button>
        )}
        {cropping && <small>拖动框选图或段落，松开即可查看；Esc 取消。</small>}
      </div>
      {showCrop && crop && (
        <div
          className="rw-pdf-crop-preview"
          aria-label={`PDF 第 ${page} 页局部`}
        >
          <small>第 {page} 页 · 已选局部</small>
          {cropUrl ? (
            <>
              <img src={cropUrl} alt={`PDF 第 ${page} 页已选局部`} />
              <ResearchImage
                url={cropUrl}
                title={`第 ${page} 页局部`}
                onPage={() => setShowCrop(false)}
              />
            </>
          ) : (
            <p role="status">{cropError || "正在显示局部…"}</p>
          )}
        </div>
      )}
      {quote && (
        <SelectionActions
          text={quote.text}
          source={() => onSource(quote.source.id)}
          explain={() =>
            onFocus(
              {
                label: quote.text,
                sourceAnchor: {
                  paperId: paper.id,
                  sourceVersion: paper.version,
                  sourceId: quote.source.id,
                  page,
                  textView: "pdf",
                  excerpt: quote.text,
                },
              },
              "请解释这段原文，先讲清楚它在研究中的意思。",
            )
          }
          cite={() =>
            onFocus(
              {
                label: quote.text,
                sourceAnchor: {
                  paperId: paper.id,
                  sourceVersion: paper.version,
                  sourceId: quote.source.id,
                  page,
                  textView: "pdf",
                  excerpt: quote.text,
                },
              },
              "",
            )
          }
        />
      )}
      {error && (
        <p role="alert">
          PDF 加载失败：{error}{" "}
          <button onClick={() => setRetry((old) => old + 1)}>重试</button> ·
          可打开原始 PDF。
        </p>
      )}
      {ready && !hasText && (
        <p role="status">
          此页没有可选文字，请查看原页；提问时注明 PDF 第 {page}{" "}
          页，必要时补充清晰图片或原文。
        </p>
      )}
      {ready && limited && (
        <p role="status">已限制画布像素占用；需要更大比例时可打开原始 PDF。</p>
      )}
      <div
        ref={scroll}
        className="rw-pdf-scroll"
        hidden={showCrop}
        onScroll={(e) => {
          if (!ready) return;
          try {
            localStorage.setItem(
              `research-pdf-scroll:${paper.id}:${page}:${zoom}`,
              JSON.stringify({
                left: e.currentTarget.scrollLeft,
                top: e.currentTarget.scrollTop,
              }),
            );
          } catch {}
        }}
      >
        <div className="rw-pdf-page" aria-busy={!ready}>
          <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} />
          <div
            ref={text}
            className="textLayer"
            onMouseUp={select}
            onKeyUp={select}
            onTouchEnd={() => setTimeout(select, 100)}
          />
          {cropping && ready && (
            <div
              className="rw-pdf-crop-layer"
              aria-label="框选图或段落区域"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                cropStart.current = cropPoint(event);
                setCropDraft(undefined);
              }}
              onPointerMove={(event) => {
                if (cropStart.current)
                  setCropDraft(
                    cropFromPoints(cropStart.current, cropPoint(event)),
                  );
              }}
              onPointerCancel={() => {
                cropStart.current = undefined;
                setCropDraft(undefined);
              }}
              onPointerUp={(event) => {
                if (!cropStart.current) return;
                const next = cropFromPoints(
                  cropStart.current,
                  cropPoint(event),
                );
                cropStart.current = undefined;
                setCropDraft(undefined);
                const box = event.currentTarget.getBoundingClientRect();
                if (
                  next.width * box.width < 12 ||
                  next.height * box.height < 12
                )
                  return;
                setCrop(next);
                setShowCrop(true);
                setCropping(false);
                try {
                  localStorage.setItem(cropKey, JSON.stringify(next));
                } catch {}
              }}
            >
              {cropDraft && (
                <div
                  className="rw-pdf-crop-box"
                  style={{
                    left: `${cropDraft.left * 100}%`,
                    top: `${cropDraft.top * 100}%`,
                    width: `${cropDraft.width * 100}%`,
                    height: `${cropDraft.height * 100}%`,
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
