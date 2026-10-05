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
    [page, setPage] = useState(1),
    [width, setWidth] = useState(450);
  const [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [quote, setQuote] = useState<{ source: Source; text: string }>();
  const wrap = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const source = paper.sources.find((s) => s.id === sourceId);
    if (source?.page) setPage(source.page);
  }, [sourceId, locatorRevision]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(240, Math.floor(entry.contentRect.width))),
    );
    if (wrap.current) observer.observe(wrap.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let closed = false;
    const loading = getDocument({ url: paper.pdfUrl!, useSystemFonts: true });
    void loading.promise
      .then((value) => {
        if (!closed) setPdf(value);
      })
      .catch((err) => {
        if (!closed) setError(err.message);
      });
    return () => {
      closed = true;
      void loading.destroy();
    };
  }, [paper.pdfUrl]);
  useEffect(() => {
    if (!pdf || !canvas.current || !text.current) return;
    let closed = false,
      rendering: RenderTask | undefined,
      layer: TextLayer | undefined;
    setReady(false);
    setQuote(undefined);
    setError("");
    void (async () => {
      const pdfPage = await pdf.getPage(Math.min(page, pdf.numPages));
      if (closed) return;
      const viewport = pdfPage.getViewport({
        scale: width / pdfPage.getViewport({ scale: 1 }).width,
      });
      const target = canvas.current!,
        container = text.current!,
        ratio = Math.min(devicePixelRatio || 1, 2);
      target.width = Math.round(viewport.width * ratio);
      target.height = Math.round(viewport.height * ratio);
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      container.replaceChildren();
      container.style.setProperty(
        "--total-scale-factor",
        String(viewport.scale),
      );
      rendering = pdfPage.render({
        canvas: target,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      layer = new TextLayer({
        textContentSource: await pdfPage.getTextContent(),
        container,
        viewport,
      });
      if (closed) {
        layer.cancel();
        return;
      }
      await Promise.all([rendering.promise, layer.render()]);
      if (!closed) setReady(true);
    })().catch((err) => {
      if (!closed) setError(err.message);
    });
    return () => {
      closed = true;
      rendering?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, width]);
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
    <section className="rw-pdf" ref={wrap} aria-label="PDF 文字阅读">
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
        {!ready && <small role="status">正在显示 PDF…</small>}
      </div>
      {quote && (
        <button
          className="rp-primary rw-pdf-quote"
          onClick={() =>
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
        >
          引用 PDF 所选文字
        </button>
      )}
      {error && <p role="alert">{error} · 可切换提取原文继续阅读。</p>}
      <div className="rw-pdf-page">
        <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} />
        <div
          ref={text}
          className="textLayer"
          onMouseUp={select}
          onKeyUp={select}
          onTouchEnd={() => setTimeout(select, 100)}
        />
      </div>
    </section>
  );
}
