import { useEffect, useState } from "react";
import type { PaperBundle, Slide } from "../shared/types.ts";
import { slideLayout, slideSize } from "../shared/slide-layout.ts";
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
      {layout.shapes.map((shape, index) => (
        <rect
          key={`shape-${index}`}
          x={shape.x * 100}
          y={shape.y * 100}
          width={shape.w * 100}
          height={shape.h * 100}
          fill={`#${shape.fill}`}
        />
      ))}
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
              y={(b.y + ((j + 0.88) * b.fontSize * 1.18) / 72) * 100}
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
                ((10 * 1.18) / 72) * 0.88) *
              100
            }
            fill="#007AFF"
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
