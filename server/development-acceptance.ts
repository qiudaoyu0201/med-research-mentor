import type { TaskRun } from "../shared/types.ts";

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
