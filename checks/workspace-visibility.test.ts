import test from "node:test";
import assert from "node:assert/strict";
import { visibleWorkspace } from "../server/workspace-visibility.ts";
import { sample } from "../examples/bundle.ts";
import type { WorkspaceIndex } from "../shared/workspace.ts";
import type { ConversationState } from "../shared/types.ts";

test("archive removes revision fingerprints, restoring unchanged paper sends its content again", () => {
  const index: WorkspaceIndex = {
    projects: [],
    papers: [],
    positions: [],
    notes: [],
  };
  const conversations = [
    { id: "reading", paperId: sample.id },
    { id: "independent", paperId: null },
  ] as ConversationState[];
  const initial = visibleWorkspace(index, [sample], conversations);
  index.papers = [{ paperId: sample.id, projectId: null, archived: true }];
  const hidden = visibleWorkspace(
    index,
    [sample],
    conversations,
    initial.paperRevisions,
  );
  assert.deepEqual(hidden.paperRevisions, {});
  assert.deepEqual(
    hidden.conversations.map((c) => c.id),
    ["independent"],
  );
  index.papers[0].archived = false;
  const restored = visibleWorkspace(
    index,
    [sample],
    conversations,
    hidden.paperRevisions,
  );
  assert.deepEqual(restored.paperIds, [sample.id]);
  assert.equal(restored.papers.length, 1);
  assert.equal(restored.conversations.length, 2);
});
