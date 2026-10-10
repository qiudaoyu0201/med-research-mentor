import test from "node:test";
import assert from "node:assert/strict";
import { ConversationStore } from "../server/conversation.ts";
import { LearningRecords } from "../server/learning-records.ts";
import { exampleUnits } from "../examples/bundle.ts";
import { save } from "../server/storage.ts";
import type { ConversationState, TaskRun } from "../shared/types.ts";
function harness() {
  const stored = new Map<string, any>();
  let fail = false;
  const persist: typeof save = async (g, id, state) => {
    if (fail) throw new Error("disk failure");
    stored.set(`${g}/${id}`, JSON.stringify(state));
  };
  const conversations = new ConversationStore(persist);
  const runs = new Map<string, TaskRun>();
  const records = new LearningRecords(conversations, (id) => runs.get(id));
  return {
    stored,
    conversations,
    records,
    runs,
    fail: () => {
      fail = true;
    },
  };
}
function run(state: ConversationState): TaskRun {
  return {
    id: "delivered-unit",
    status: "completed",
    input: { conversationId: state.id, paperId: "foundation-only" },
    result: exampleUnits.qpcr,
  } as TaskRun;
}
test("explicit records remain separate from teaching, undo restores user feedback and deletion removes edit history", async () => {
  const h = harness();
  let state = await h.conversations.create();
  h.runs.set("delivered-unit", run(state));
  assert.deepEqual(state.userProgress, []);
  assert.deepEqual(state.learningRecords, []);
  state = await h.records.create(state.id, state.version, {
    kind: "favorite",
    unitId: "delivered-unit",
    sectionIndex: 0,
  });
  const favorite = state.learningRecords![0];
  assert.equal(favorite.sourceText, exampleUnits.qpcr.sections[0].text);
  assert.deepEqual(state.userProgress, []);
  state = await h.records.create(state.id, state.version, {
    kind: "feedback",
    unitId: "delivered-unit",
    feedback: "confused",
  });
  const feedback = state.learningRecords![1];
  assert.equal(state.userProgress[0].state, "confused");
  state = await h.records.edit(
    state.id,
    state.version,
    feedback.id,
    feedback.version,
    { text: "我能复述，但还没核验应用表现", feedback: "understood" },
  );
  assert.equal(state.userProgress[0].state, "understood");
  state = await h.records.undo(state.id, state.version, feedback.id, 1);
  assert.equal(state.userProgress[0].state, "confused");
  const restored = JSON.parse(h.stored.get(`conversations/${state.id}`));
  assert.deepEqual(restored.learningRecords, state.learningRecords);
  state = await h.records.delete(state.id, state.version, feedback.id, 2);
  assert.deepEqual(state.userProgress, []);
  assert.equal(
    JSON.stringify(h.stored.get(`conversations/${state.id}`)).includes(
      feedback.id,
    ),
    false,
  );
  assert.equal(state.learningRecords?.length, 1);
});
test("foreign or uncompleted explanations and stale writes cannot create a learning diagnosis", async () => {
  const h = harness();
  let state = await h.conversations.create();
  h.runs.set("delivered-unit", run(state));
  const other = await h.conversations.create();
  await assert.rejects(
    h.records.create(other.id, other.version, {
      kind: "feedback",
      unitId: "delivered-unit",
      feedback: "understood",
    }),
    /本会话/,
  );
  h.runs.get("delivered-unit")!.status = "failed";
  await assert.rejects(
    h.records.create(state.id, state.version, {
      kind: "favorite",
      unitId: "delivered-unit",
    }),
    /实际交付/,
  );
  h.runs.get("delivered-unit")!.status = "completed";
  state = await h.records.create(state.id, state.version, {
    kind: "question",
    text: "归一化为什么必要？",
  });
  const record = state.learningRecords![0];
  await assert.rejects(
    h.records.edit(state.id, state.version, record.id, record.version, {
      feedback: "understood",
    }),
    /主动理解反馈/,
  );
  await assert.rejects(
    h.records.edit(state.id, state.version - 1, record.id, record.version, {
      text: "stale",
    }),
    /会话版本/,
  );
  await assert.rejects(
    h.records.edit(state.id, state.version, record.id, record.version + 1, {
      text: "stale",
    }),
    /记录版本/,
  );
  assert.deepEqual(h.conversations.get(state.id).userProgress, []);
  state = await h.records.edit(
    state.id,
    state.version,
    record.id,
    record.version,
    { resolved: true },
  );
  assert.equal(state.learningRecords![0].resolved, true);
  assert.deepEqual(state.userProgress, []);
});
test("favorites are idempotent; storage failure preserves the prior record and paper changes retain explicit history", async () => {
  const h = harness();
  let state = await h.conversations.create();
  h.runs.set("delivered-unit", run(state));
  state = await h.records.create(state.id, state.version, {
    kind: "favorite",
    unitId: "delivered-unit",
    sectionIndex: 0,
  });
  state = await h.records.create(state.id, state.version, {
    kind: "favorite",
    unitId: "delivered-unit",
    sectionIndex: 0,
  });
  assert.equal(state.learningRecords?.length, 1);
  state.paperId = "another-paper";
  state = await h.conversations.put(state, state.version);
  assert.equal(state.learningRecords![0].paperId, null);
  const previous = structuredClone(state);
  h.fail();
  await assert.rejects(
    h.records.edit(state.id, state.version, state.learningRecords![0].id, 0, {
      text: "my edit",
    }),
    /disk failure/,
  );
  assert.deepEqual(h.conversations.get(state.id), previous);
});
