import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

test(
  "real API: archive/restore and source removal preserve independent artifacts across restart",
  { timeout: 90000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mentor-lifecycle-"));
    const fixture = await lifecycleFixture(directory);
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    let child: ChildProcess;
    async function start() {
      child = spawn(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "server/index.ts", "--production"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PORT: String(port),
            TUTOR_DATA_DIR: directory,
            TUTOR_RECORDING_PREPARED: "false",
            TUTOR_READING_GUIDES: "manual",
            TUTOR_PROVIDER: "codex",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("隔离服务启动超时")),
          30000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("隔离服务提前退出"));
        });
        child.stdout!.on("data", (bytes) => {
          if (String(bytes).includes(`:${port}`)) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }
    async function stop() {
      if (child && child.exitCode === null) {
        const closed = once(child, "exit");
        child.kill();
        await closed;
      }
    }
    async function api(path: string, body?: unknown, method = "POST") {
      const response = await fetch(
        `http://127.0.0.1:${port}${path}`,
        body === undefined
          ? undefined
          : {
              method,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      const data = await response.json();
      assert.equal(response.ok, true, `${path}: ${JSON.stringify(data)}`);
      return data;
    }
    try {
      await start();
      const draft = await api("/api/artifacts/plan", {});
      await api(
        `/api/artifacts/plan/${draft.id}`,
        {
          intake: {
            question: "持久化草稿",
            conditions: "尚未生成",
            paperIds: [],
          },
        },
        "PATCH",
      );
      await stop();
      await start();
      const persisted = (await api("/api/artifacts")).find(
        (a: { id: string }) => a.id === draft.id,
      );
      assert.equal(persisted.intake.question, "持久化草稿");
      const promoted = await api("/api/research-plans", {
        draftId: draft.id,
        question: "持久化草稿",
        sources: [],
      });
      assert.equal(promoted.id, draft.id);
      assert.equal(
        (await api("/api/artifacts")).filter(
          (a: { id: string }) => a.id === draft.id,
        ).length,
        1,
      );
      await api(`/api/artifacts/plan/${draft.id}`, { archived: true }, "PATCH");
      await api(`/api/artifacts/plan/${draft.id}`, {}, "DELETE");
      const pptDraft = await api("/api/artifacts/ppt", {});
      const promotedPpt = await api("/api/conversations", {
        draftId: pptDraft.id,
        purpose: "ppt-generation",
        paperId: fixture.paper.id,
      });
      assert.equal(promotedPpt.id, pptDraft.id);
      await api(
        `/api/artifacts/ppt/${pptDraft.id}`,
        { archived: true },
        "PATCH",
      );
      await api(`/api/artifacts/ppt/${pptDraft.id}`, {}, "DELETE");
      const initial = await api("/api/workspace");
      await api(
        `/api/papers/${fixture.paper.id}/metadata`,
        { archived: true },
        "PATCH",
      );
      const hidden = await api("/api/workspace", {
        paperRevisions: initial.paperRevisions,
      });
      assert.ok(!hidden.paperIds.includes(fixture.paper.id));
      await api(`/api/papers/${fixture.paper.id}/restore`, {});
      const restored = await api("/api/workspace", {
        paperRevisions: hidden.paperRevisions,
      });
      assert.ok(
        restored.papers.some((p: { id: string }) => p.id === fixture.paper.id),
      );
      await api(
        "/api/artifacts/ppt/lifecycle-ppt",
        { displayName: "独立汇报", archived: true },
        "PATCH",
      );
      assert.ok(
        (await api("/api/artifacts")).find(
          (a: { id: string }) => a.id === "lifecycle-ppt",
        ).archived,
      );
      await api(
        "/api/artifacts/ppt/lifecycle-ppt",
        { archived: false },
        "PATCH",
      );
      await api(
        `/api/papers/${fixture.paper.id}/metadata`,
        { archived: true },
        "PATCH",
      );
      await api(`/api/papers/${fixture.paper.id}`, {}, "DELETE");
      const deck = await api("/api/deck-versions/lifecycle-version");
      assert.equal(deck.sourceSnapshot.id, fixture.paper.id);
      await stop();
      await start();
      const exported = await api(
        "/api/deck-versions/lifecycle-version/export",
        { conversationId: "lifecycle-ppt" },
      );
      const retainedPdf = await fetch(
        `http://127.0.0.1:${port}${deck.sourceSnapshot.pdfUrl}`,
      );
      assert.equal(retainedPdf.status, 200);
      assert.equal(await retainedPdf.text(), fixture.pdf);
      const file = await fetch(`http://127.0.0.1:${port}${exported.url}`);
      assert.equal(file.status, 200);
      assert.ok((await file.arrayBuffer()).byteLength > 1000);
      const plan = await api("/api/research-plans", {
        question: "比较医学观察指标",
        conditions: "仅用于生命周期检查",
        sources: [],
      });
      await api(`/api/artifacts/plan/${plan.id}`, { archived: true }, "PATCH");
      await api(`/api/artifacts/plan/${plan.id}`, { archived: false }, "PATCH");
      await api(`/api/artifacts/plan/${plan.id}`, { archived: true }, "PATCH");
      await api(`/api/artifacts/plan/${plan.id}`, {}, "DELETE");
      await api(
        "/api/artifacts/ppt/lifecycle-ppt",
        { archived: true },
        "PATCH",
      );
      await api("/api/artifacts/ppt/lifecycle-ppt", {}, "DELETE");
      assert.equal((await api("/api/artifacts")).length, 0);
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}${exported.url}`)).ok,
        false,
      );
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
