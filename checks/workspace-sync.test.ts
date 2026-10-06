import test from "node:test";
import assert from "node:assert/strict";
import { pollWorkspace } from "../app/research-api.ts";
import type { WorkspaceBootstrap } from "../shared/workspace.ts";

test("工作区增量同步保留未变资料，合并新版本与新论文，并移除已删除论文", async (t) => {
  const first: WorkspaceBootstrap = {
    index: { projects: [], papers: [], notes: [], positions: [] },
    conversations: [],
    papers: [
      { id: "a", version: "1", title: "a", scope: "", sources: [] },
      { id: "b", version: "1", title: "b", scope: "", sources: [] },
      { id: "removed", version: "1", title: "removed", scope: "", sources: [] },
    ],
    paperIds: ["a", "b", "removed"],
    paperRevisions: { a: "a1", b: "b1", removed: "r1" },
  };
  const delta = {
    ...first,
    index: { ...first.index, notes: [{ id: "new-note", text: "同步笔记" }] },
    papers: [
      { ...first.papers[1], version: "2" },
      { id: "new", version: "1", title: "new", scope: "", sources: [] },
    ],
    paperIds: ["a", "b", "new"],
    paperRevisions: { a: "a1", b: "b2", new: "n1" },
  };
  const replies = [first, delta];
  const requests: RequestInit[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      requests.push(init);
      return Response.json(replies.shift());
    },
  );
  const previous = await pollWorkspace();
  const next = await pollWorkspace(previous);
  assert.equal(next.papers[0], previous.papers[0]);
  assert.deepEqual(
    next.papers.map((paper) => [paper.id, paper.version]),
    [
      ["a", "1"],
      ["b", "2"],
      ["new", "1"],
    ],
  );
  assert.equal(next.index.notes[0].text, "同步笔记");
  assert.equal(requests[0].method, undefined);
  assert.equal(requests[1].method, "POST");
  assert.deepEqual(JSON.parse(requests[1].body as string), {
    paperRevisions: first.paperRevisions,
  });
});
test("同步缺少资料或服务器报错时保留错误，不发布不完整工作区", async (t) => {
  const previous: WorkspaceBootstrap = {
    index: { projects: [], papers: [], notes: [], positions: [] },
    papers: [],
    conversations: [],
    paperRevisions: {},
  };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ ...previous, paperIds: ["missing"] }),
  );
  await assert.rejects(pollWorkspace(previous), /更新不完整/);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "存储读取失败" }, { status: 400 }),
  );
  await assert.rejects(pollWorkspace(previous), /存储读取失败/);
});
