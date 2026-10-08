// Measure answers painted in this tab. Restoring history creates no measurement.
const pending = new Map<string, number>();
export function startResponseTiming() {
  const started = performance.now();
  return (turnId: string) => {
    if (pending.size > 100) pending.delete(pending.keys().next().value!);
    pending.set(turnId, started);
  };
}
export function measureReadableAnswer(turnId: string, element: Element | null) {
  const started = pending.get(turnId);
  if (
    started === undefined ||
    !element?.isConnected ||
    document.visibilityState !== "visible" ||
    !element.textContent?.trim()
  )
    return;
  const bounds = element.getBoundingClientRect();
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.bottom <= 0 ||
    bounds.top >= window.innerHeight
  )
    return;
  pending.delete(turnId);
  const end = performance.now();
  const detail = {
    taskId: turnId,
    durationMs: end - started,
    renderedAt: new Date().toISOString(),
    scope: "visible-validated-answer",
  };
  performance.measure(`tutor:readable:${turnId}`, {
    start: started,
    end,
    detail,
  });
  window.dispatchEvent(new CustomEvent("tutor:readable-response", { detail }));
}
