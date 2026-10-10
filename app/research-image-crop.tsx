import { useEffect, useRef, useState } from "react";
import { cropFromPoints, type CropPoint } from "./research-pdf-crop.ts";
import type { ImageRegion } from "../shared/image-region.ts";
export function ImageCrop({
  url,
  value,
  onChange,
}: {
  url: string;
  value?: ImageRegion;
  onChange: (r: ImageRegion | undefined) => void;
}) {
  const start = useRef<CropPoint | undefined>(undefined),
    [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!start.current) setDraft(value);
  }, [JSON.stringify(value), url]);
  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    };
  };
  return (
    <div className="rw-image-crop">
      <p className="hint">
        拖动框选用于这一页的区域，保留相关标签、图例和比例尺。大范围也可以。
      </p>
      <div
        className="rw-image-crop-surface"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          start.current = point(e);
          e.currentTarget.setPointerCapture(e.pointerId);
          setDraft(undefined);
        }}
        onPointerMove={(e) => {
          if (start.current) setDraft(cropFromPoints(start.current, point(e)));
        }}
        onPointerUp={(e) => {
          if (!start.current) return;
          const r = cropFromPoints(start.current, point(e));
          start.current = undefined;
          if (r.width > 0.01 && r.height > 0.01) {
            setDraft(r);
            onChange(r);
          } else setDraft(value);
        }}
        onPointerCancel={() => {
          start.current = undefined;
          setDraft(value);
        }}
      >
        <img src={url} alt="拖动选择图件区域" draggable={false} />
        {draft && (
          <div
            className="rw-image-crop-selection"
            style={{
              left: `${draft.left * 100}%`,
              top: `${draft.top * 100}%`,
              width: `${draft.width * 100}%`,
              height: `${draft.height * 100}%`,
            }}
          />
        )}
      </div>
      {value && (
        <button
          onClick={() => {
            setDraft(undefined);
            onChange(undefined);
          }}
        >
          恢复完整图
        </button>
      )}
    </div>
  );
}
