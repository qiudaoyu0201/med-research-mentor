import { useEffect, useState } from "react";
export type ResearchTheme = "system" | "light" | "dark";
export type ResearchFont = "source-han" | "system";
export function useResearchFont() {
  const [font, setFont] = useState<ResearchFont>(() =>
    readPreference("research-font", ["source-han", "system"], "source-han"),
  );
  useEffect(() => {
    document.documentElement.dataset.researchFont = font;
    try {
      localStorage.setItem("research-font", font);
    } catch {}
  }, [font]);
  return { font, setFont };
}
export function readPreference<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
export function useResearchTheme() {
  const [theme, setTheme] = useState<ResearchTheme>(() =>
    readPreference("research-theme", ["system", "light", "dark"], "system"),
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    function apply() {
      document.documentElement.dataset.researchTheme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    }
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("research-theme", theme);
    } catch {}
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return { theme, setTheme };
}
