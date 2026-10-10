import type { Source } from "./types.ts";

/** Only accept ranges whose complete exposed text still matches this source. */
export function currentSourceRanges(source: Source, excerpt?: Source) {
  if (
    !excerpt ||
    excerpt.id !== source.id ||
    source.caption ||
    (excerpt.paperId && source.paperId && excerpt.paperId !== source.paperId) ||
    (excerpt.paperVersion &&
      source.paperVersion &&
      excerpt.paperVersion !== source.paperVersion)
  )
    return [];
  const ranges = excerpt.excerptRanges;
  if (
    !Array.isArray(ranges) ||
    !ranges.length ||
    ranges.some(
      (r) =>
        !r ||
        !["current", "context"].includes(r.role) ||
        !Number.isInteger(r.start) ||
        !Number.isInteger(r.end) ||
        r.start < 0 ||
        r.end <= r.start ||
        r.end > source.text.length,
    )
  )
    return [];
  if (
    ranges.map((r) => source.text.slice(r.start, r.end)).join("\n\n") !==
    excerpt.text
  )
    return [];
  const current = ranges.filter((r) => r.role === "current");
  return (current.length ? current : ranges).map(({ start, end }) => ({
    start,
    end,
  }));
}

export function translationSegments(
  text: string,
  ranges: { start: number; end: number }[] = [],
) {
  return (ranges.length ? ranges : [{ start: 0, end: text.length }]).flatMap(
    (r) => {
      const segments: { start: number; end: number }[] = [];
      for (let start = r.start; start < r.end; start += 3500)
        segments.push({ start, end: Math.min(start + 3500, r.end) });
      return segments;
    },
  );
}
