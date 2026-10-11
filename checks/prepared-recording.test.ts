import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  recordingAnswer,
  preparedRecordingSchema,
} from "../server/prepared-recording.ts";
import type { PaperBundle, AssistantMessage } from "../shared/types.ts";

test("recording cache is paper-bound, reviewed and rejects changed sources", () => {
  const paper: PaperBundle = {
    id: "test-paper",
    title: "Paper",
    version: "1",
    scope: "test",
    sources: [],
  };
  const unit = {
    title: "Title",
    question: "请结合图1d和1e解释。",
    sections: [
      { title: "Result", text: "Result", kind: "paper", citations: [] },
    ],
    terms: [],
    nextQuestion: "Next",
  };
  const raw = {
    approved: true,
    paperId: paper.id,
    model: "test",
    preparedAt: "2026-10-11",
    sourceDigest: createHash("sha256").update("[]").digest("hex"),
    steps: [{ sourceIds: ["source"] }],
    answers: [unit, unit, unit, unit],
    reviews: {
      reviews: Array.from({ length: 4 }, () => ({
        issues: [],
        checkedSources: [],
        limitations: [],
      })),
    },
  };
  const bundle = preparedRecordingSchema.parse(raw);
  const message: AssistantMessage = {
    clientMessageId: "test",
    mode: "live",
    question: "请结合图1d和图1e解释。",
  };
  assert(recordingAnswer(bundle, paper, message));
  assert.equal(recordingAnswer(undefined, paper, message), undefined);
  assert.equal(
    recordingAnswer(bundle, { ...paper, id: "other" }, message),
    undefined,
  );
  assert.equal(
    recordingAnswer(bundle, paper, { ...message, question: "不同的问题" }),
    undefined,
  );
  assert.equal(
    recordingAnswer(bundle, paper, { ...message, attachmentIds: ["new"] }),
    undefined,
  );
  assert.equal(
    recordingAnswer({ ...bundle, sourceDigest: "changed" }, paper, message),
    undefined,
  );
  assert.equal(
    preparedRecordingSchema.safeParse({ ...raw, approved: false }).success,
    false,
  );
});
