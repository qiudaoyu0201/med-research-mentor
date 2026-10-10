import { useEffect, useRef, useState } from "react";
export const defaultLayout = {
  navigation: 216,
  reading: 360,
  composer: 140,
  pptList: 230,
  pptEditor: 340,
};
const bounds = {
  navigation: [200, 280],
  reading: [320, 560],
  composer: [110, 300],
  pptList: [180, 380],
  pptEditor: [260, 480],
} as const;
export function useResearchLayout() {
  const [layout, setLayout] = useState(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem("research-layout-v2") ?? "{}",
      );
      if (!localStorage.getItem("research-layout-v2")) {
        const previous = JSON.parse(
          localStorage.getItem("research-layout") ?? "{}",
        );
        if (Number.isFinite(previous.navigation))
          stored.navigation = previous.navigation;
      }
      return Object.fromEntries(
        Object.entries(defaultLayout).map(([key, value]) => [
          key,
          Number.isFinite(stored[key])
            ? Math.max(
                bounds[key as keyof typeof bounds][0],
                Math.min(bounds[key as keyof typeof bounds][1], stored[key]),
              )
            : value,
        ]),
      ) as typeof defaultLayout;
    } catch {
      return defaultLayout;
    }
  });
  function update(key: keyof typeof defaultLayout, value: number) {
    setLayout((old) => {
      const next = { ...old, [key]: value };
      return next;
    });
  }
  function reset() {
    try {
      localStorage.setItem("research-layout-v2", JSON.stringify(defaultLayout));
      localStorage.removeItem("research-navigation-collapsed");
      localStorage.removeItem("research-reader-pinned");
    } catch {}
    setLayout(defaultLayout);
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem("research-layout-v2", JSON.stringify(layout));
      } catch {}
    }, 200);
    return () => clearTimeout(timer);
  }, [layout]);
  return { layout, update, reset };
}
export function Splitter({
  label,
  value,
  min,
  max,
  onChange,
  horizontal,
  scale = 1,
  reverse = false,
  className = "",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  horizontal?: boolean;
  scale?: number;
  reverse?: boolean;
  className?: string;
}) {
  const start = useRef<{ coordinate: number; value: number } | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      document.body.classList.remove("rw-resizing");
    },
    [],
  );
  const clamp = (n: number) => Math.round(Math.max(min, Math.min(max, n)));
  return (
    <div
      className={`rw-splitter ${horizontal ? "rw-splitter-horizontal" : ""} ${className}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuenow={clamp(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = {
          coordinate: horizontal ? e.clientY : e.clientX,
          value,
        };
        document.body.classList.add("rw-resizing");
      }}
      onPointerMove={(e) => {
        if (start.current)
          onChange(
            clamp(
              start.current.value +
                ((horizontal ? e.clientY : e.clientX) -
                  start.current.coordinate) *
                  scale *
                  (reverse ? -1 : 1),
            ),
          );
      }}
      onPointerUp={(e) => {
        start.current = undefined;
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("rw-resizing");
      }}
      onLostPointerCapture={() => {
        start.current = undefined;
        document.body.classList.remove("rw-resizing");
      }}
      onKeyDown={(e) => {
        const positive = horizontal ? "ArrowDown" : "ArrowRight",
          negative = horizontal ? "ArrowUp" : "ArrowLeft";
        if ([positive, negative, "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const step = max <= 100 ? 2 : 20;
          onChange(
            e.key === "Home"
              ? min
              : e.key === "End"
                ? max
                : clamp(
                    value +
                      (e.key === positive ? step : -step) * (reverse ? -1 : 1),
                  ),
          );
        }
      }}
    />
  );
}
