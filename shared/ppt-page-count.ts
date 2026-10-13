// Keep saved intake, the selector and the model request within the same range.
export const pptPageCounts = Array.from({ length: 16 }, (_, i) =>
  String(i + 1),
);
export function isPptPageCount(value: unknown): value is string {
  return (
    typeof value === "string" && (value === "" || pptPageCounts.includes(value))
  );
}
