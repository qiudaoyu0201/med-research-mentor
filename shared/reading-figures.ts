import type { LearningUnit, Source } from "./types.ts";
import { validRegion, type FigurePanel } from "./image-region.ts";

export interface ReadingFigure {
  source: Source;
  panel?: FigurePanel;
}

export function validateReadingFigures(
  unit: LearningUnit,
  sources: Source[],
  exposure?: { sourceIds: string[]; panelIds?: string[] },
) {
  for (const section of unit.sections) {
    for (const figure of section.figures ?? []) {
      const source = sources.find((s) => s.id === figure.sourceId);
      if (
        !source ||
        !section.citations.includes(source.id) ||
        !(
          source.image ||
          source.figure ||
          source.attachmentId ||
          source.imagePurpose
        ) ||
        (exposure && !exposure.sourceIds.includes(source.id))
      )
        throw new Error("讲解图件必须属于本节已引用且实际提供的图源。");
      if (figure.panelId) {
        const panel = source.imagePanels?.find(
          (p) => source.id + ":" + p.label === figure.panelId,
        );
        if (
          !panel ||
          !validRegion(panel.region) ||
          (exposure && !exposure.panelIds?.includes(figure.panelId))
        )
          throw new Error("讲解选区不属于本次实际展示的图件面板。");
      }
    }
  }
}

// Old answers have citations only: show each complete figure at its first mention.
// Explicit selections take precedence so a later panel does not add a whole-figure copy.
export function readingFiguresBySection(
  unit: LearningUnit,
  sources: Source[],
): ReadingFigure[][] {
  const selected = new Set(
    unit.sections.flatMap((s) => (s.figures ?? []).map((f) => f.sourceId)),
  );
  const shown = new Set<string>();
  return unit.sections.map((section) => {
    const figures: ReadingFigure[] = [];
    for (const figure of section.figures ?? []) {
      const source = sources.find((s) => s.id === figure.sourceId);
      if (!source || !section.citations.includes(source.id)) continue;
      const panel = figure.panelId
        ? source.imagePanels?.find(
            (p) =>
              source.id + ":" + p.label === figure.panelId &&
              validRegion(p.region),
          )
        : undefined;
      if (figure.panelId && !panel) continue;
      if (
        source.image ||
        source.figure ||
        source.attachmentId ||
        source.imagePurpose
      )
        figures.push({ source, panel });
    }
    for (const id of section.citations) {
      if (selected.has(id) || shown.has(id)) continue;
      const source = sources.find((s) => s.id === id && s.figure);
      if (source) {
        figures.push({ source });
        shown.add(id);
      }
    }
    return figures;
  });
}
