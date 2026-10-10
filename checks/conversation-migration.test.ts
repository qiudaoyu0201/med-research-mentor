import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConversationState, ConversationStore } from "../server/conversation.ts";

test("legacy conversations receive structural defaults without inventing evidence", () => {
  const legacy = {
    id: "legacy",
    paperId: "paper-1",
    sourceVersion: null,
    goal: "",
    profileId: "beginner",
    version: 0,
    taughtConcepts: [],
    userProgress: [],
    openQuestions: [],
    taskGroups: [],
    artifacts: [],
    recentTurnIds: [],
    summaries: [],
  } as any;
  const next = normalizeConversationState(legacy);
  assert.equal(next.purpose, undefined);
  assert.equal(next.sourceVersion, null);
  assert.deepEqual(next.learningRecords, []);
  assert.equal(next.readingSession, undefined);
  next.taughtConcepts.push({ name: "new", unitId: "new" });
  assert.deepEqual(legacy.taughtConcepts, []);
});

test("restore persists a migrated legacy record once and keeps its identity", async () => {
  const saved: unknown[] = [];
  const store = new ConversationStore(async (_group, _id, value) => {
    saved.push(value);
  });
  await store.restore((async () => [{
    id: "legacy", paperId: null, sourceVersion: null, goal: "", profileId: "beginner",
    version: 0, taughtConcepts: [], userProgress: [], openQuestions: [], taskGroups: [], artifacts: [], recentTurnIds: [], summaries: [],
  }]) as any);
  assert.equal(saved.length, 1);
  assert.equal(store.get("legacy").id, "legacy");
  const migrated = store.get("legacy");
  await store.restore((async () => [migrated]) as any);
  assert.equal(saved.length, 1);
});
