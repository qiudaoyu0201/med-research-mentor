import { z } from "zod";
import { createHash } from "node:crypto";
import { unitSchema, reviewSchema } from "./schemas.ts";
import type { AssistantMessage, PaperBundle } from "../shared/types.ts";

export const preparedRecordingSchema = z
  .object({
    approved: z.literal(true),
    paperId: z.string(),
    model: z.string(),
    preparedAt: z.string(),
    sourceDigest: z.string(),
    steps: z.array(z.object({ sourceIds: z.array(z.string()) })),
    answers: z.array(unitSchema).length(4),
    reviews: z.object({ reviews: z.array(reviewSchema).length(4) }),
  })
  .refine(
    (value) =>
      value.reviews.reviews.every((review) =>
        review.issues.every(
          (issue) => issue.resolved || issue.severity !== "blocking",
        ),
      ),
    "Prepared answers contain unresolved blocking findings",
  );
export type PreparedRecording = z.infer<typeof preparedRecordingSchema>;
export function recordingQuestion(text: string) {
  return text
    .replace(/\s/g, "")
    .replace(/和图1e/g, "和1e")
    .replace(/[。？！?]+$/g, "");
}
export function recordingAnswer(
  bundle: PreparedRecording | undefined,
  paper: PaperBundle | undefined,
  message: AssistantMessage,
) {
  if (
    !bundle ||
    !paper ||
    paper.id !== bundle.paperId ||
    (message.paperId !== undefined && message.paperId !== paper.id) ||
    message.mode !== "live" ||
    message.attachmentIds?.length ||
    message.exportRunId ||
    message.module === "ppt" ||
    message.deckEdit
  )
    return;
  const index = bundle.answers.findIndex(
    (answer) =>
      recordingQuestion(answer.question) ===
      recordingQuestion(message.question),
  );
  if (index < 0) return;
  const ids = new Set(bundle.steps.flatMap((step) => step.sourceIds));
  const selected = paper.sources.filter((source) => ids.has(source.id));
  if (
    createHash("sha256").update(JSON.stringify(selected)).digest("hex") !==
    bundle.sourceDigest
  )
    return;
  const answer = bundle.answers[index];
  if (
    answer.sections.some((section) =>
      section.citations.some(
        (id) => !paper.sources.some((source) => source.id === id),
      ),
    )
  )
    return;
  return { answer, index };
}
