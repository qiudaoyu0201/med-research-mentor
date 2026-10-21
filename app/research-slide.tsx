import { useEffect, useState } from "react";
import type { PaperBundle, Slide } from "../shared/types.ts";
import {
  slideLayout,
  slideSize,
  slideLineHeight,
} from "../shared/slide-layout.ts";
import type { ImageRegion } from "../shared/image-region.ts";
import { cropPixels } from "../shared/image-region.ts";
export function useCropImage(url: string | undefined, crop?: ImageRegion) {
  const [result, setResult] = useState<{
    url: string;
    width: number;
    height: number;
    failed?: boolean;
  }>();
  useEffect(() => {
    setResult(undefined);
    if (!url) return;
    let cancelled = false;
    const img = new Image();
    img.onerror = () => {
      if (!cancelled)
        setResult({ url: "", width: 1600, height: 1000, failed: true });
    };
    img.onload = () => {
      if (cancelled) return;
      if (!crop) {
        setResult({ url, width: img.width, height: img.height });
        return;
      }
      const bounds = cropPixels(crop, img.width, img.height),
        c = document.createElement("canvas");
      c.width = bounds.width;
      c.height = bounds.height;
      c.getContext("2d")!.drawImage(
        img,
        bounds.left,
        bounds.top,
        c.width,
        c.height,
        0,
        0,
        c.width,
        c.height,
      );
      setResult({ url: c.toDataURL(), width: c.width, height: c.height });
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url, JSON.stringify(crop)]);
  return result;
}
export function ResearchSlide({
  slide,
  paper,
  url,
  crop,
  page,
  total,
}: {
  slide: Slide;
  paper: PaperBundle;
  url?: string;
  crop?: ImageRegion;
  page: number;
  total: number;
}) {
  const img = useCropImage(url, crop);
  let layout;
  try {
    layout = slideLayout(
      slide,
      paper.sources.filter((s) => slide.citations.includes(s.id)),
      img ?? (slide.imageSource ? { width: 1600, height: 1000 } : undefined),
    );
  } catch (error) {
    return <p role="alert">{(error as Error).message}</p>;
  }
  return (
    <svg
      className="rw-slide-canvas"
      viewBox={`0 0 ${slideSize.width * 100} ${slideSize.height * 100}`}
      role="img"
      aria-label={`第 ${page} 页幻灯片：${slide.title}`}
    >
      <rect width="100%" height="100%" fill={`#${layout.background}`} />
      {layout.shapes.map((shape, index) => {
        const x = shape.x * 100,
          y = shape.y * 100;
        const w = shape.w * 100,
          h = shape.h * 100;
        if (shape.kind === "chevron")
          return (
            <polygon
              key={`shape-${index}`}
              points={[
                [x, y],
                [x + w * 0.5, y],
                [x + w, y + h / 2],
                [x + w * 0.5, y + h],
                [x, y + h],
                [x + w * 0.5, y + h / 2],
              ]
                .map((point) => point.join(","))
                .join(" ")}
              fill={`#${shape.fill}`}
            />
          );
        if (shape.kind === "ellipse")
          return (
            <ellipse
              key={`shape-${index}`}
              cx={x + w / 2}
              cy={y + h / 2}
              rx={w / 2}
              ry={h / 2}
              fill={`#${shape.fill}`}
            />
          );
        return (
          <rect
            key={`shape-${index}`}
            x={x}
            y={y}
            width={w}
            height={h}
            rx={shape.kind === "roundRect" ? Math.min(w, h) * 0.08 : undefined}
            fill={`#${shape.fill}`}
          />
        );
      })}
      {layout.image && img && !img.failed && (
        <image
          href={img.url}
          x={layout.image.x * 100}
          y={layout.image.y * 100}
          width={layout.image.w * 100}
          height={layout.image.h * 100}
        />
      )}
      {layout.image && (!img || img.failed) && (
        <text
          x={(layout.image.x + layout.image.w / 2) * 100}
          y={(layout.image.y + layout.image.h / 2) * 100}
          textAnchor="middle"
          fill="#73737C"
          fontSize="28"
        >
          {img?.failed
            ? "图件加载失败，请重新打开"
            : url
              ? "图件加载中"
              : "原图未提供"}
        </text>
      )}
      {layout.text.map((b, i) => (
        <text
          key={i}
          fill={`#${b.color}`}
          fontSize={(b.fontSize / 72) * 100}
          fontFamily="Microsoft YaHei, sans-serif"
          fontWeight={b.bold ? 700 : 400}
        >
          {b.lines.map((line, j) => (
            <tspan
              key={j}
              x={b.x * 100}
              y={(b.y + ((j + 0.88) * b.fontSize * slideLineHeight) / 72) * 100}
            >
              {line}
            </tspan>
          ))}
        </text>
      ))}
      {layout.text
        .filter((b) => b.marker)
        .map((b, i) => (
          <text
            key={`marker-${i}`}
            x={(b.markerAbove ? b.x : b.x - 0.42) * 100}
            y={
              ((b.markerAbove ? b.y - 0.36 : b.y + 0.02) +
                ((10 * slideLineHeight) / 72) * 0.88) *
              100
            }
            fill="#177E7D"
            fontSize={(10 / 72) * 100}
            fontWeight="700"
            fontFamily="Aptos, sans-serif"
          >
            {b.marker}
          </text>
        ))}
      <text x="1225" y="724" fill="#65656F" fontSize="14">
        {page} / {total}
      </text>
    </svg>
  );
}
