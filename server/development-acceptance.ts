import type { TaskRun } from "../shared/types.ts";
import { onlineDeliveryProblem } from "./delivery-policy.ts";

// Common-flow acceptance is separate from zero-warning diagnostic scoring.
// Keep scientific errors and learner breakpoints blocking; tolerate peripheral advice.
export function mainlineDevelopmentAcceptance(run: TaskRun): boolean {
  return (
    run.status === "completed" &&
    !!run.result &&
    !!run.review &&
    !onlineDeliveryProblem(run.review) &&
    !run.review.issues.some(
      (i) => !i.resolved && ["fact", "scope"].includes(i.type),
    ) &&
    !!run.novice &&
    !run.novice.breakpoints.some((p) => p.status !== "resolved") &&
    (run.input.module !== "ppt" ||
      (!!run.deck &&
        (!run.input.slideCount ||
          run.deck.slides.length === run.input.slideCount)))
  );
}

// Development acceptance is stricter than online delivery and TaskRun status.
export function strictDevelopmentAcceptance(run: TaskRun): boolean {
  return (
    run.status === "completed" &&
    !!run.result &&
    !!run.review &&
    !run.review.issues.some((issue) => !issue.resolved) &&
    !!run.novice &&
    !run.novice.breakpoints.some((point) => point.status !== "resolved") &&
    (run.input.module !== "ppt" ||
      (!!run.deck &&
        (!run.input.slideCount ||
          run.deck.slides.length === run.input.slideCount)))
  );
}
