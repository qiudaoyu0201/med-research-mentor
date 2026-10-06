import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RecordStorage, CorruptRecordError } from "../server/storage.ts";
import { Projects } from "../server/projects.ts";

async function fixture(
  work: (store: RecordStorage, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "tutor-records-"));
  try {
    await work(new RecordStorage(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("损坏记录单独隔离，正常记录保留，重启读取不再失败", async () =>
  fixture(async (store, dir) => {
    await store.save("papers", "good", { id: "good", text: "正常内容" });
    const broken = '{"id":"broken",';
    await writeFile(join(dir, "papers", "broken.json"), broken);
    assert.deepEqual(await store.list("papers"), [
      { id: "good", text: "正常内容" },
    ]);
    const preserved = await readdir(join(dir, "quarantine", "papers"));
    assert.equal(preserved.length, 1);
    assert.equal(
      await readFile(join(dir, "quarantine", "papers", preserved[0]), "utf8"),
      broken,
    );
    assert.match(store.recoveryNotice()!, /损坏/);
    assert.deepEqual(await new RecordStorage(dir).list("papers"), [
      { id: "good", text: "正常内容" },
    ]);
  }));
test("直接读取损坏记录明确报错；随后重建缓存不会覆盖隔离原件", async () =>
  fixture(async (store, dir) => {
    await mkdir(join(dir, "material-cache"));
    await writeFile(join(dir, "material-cache", "bad.json"), "bad bytes");
    await assert.rejects(
      store.read("material-cache", "bad"),
      CorruptRecordError,
    );
    await store.save("material-cache", "bad", { regenerated: true });
    assert.deepEqual(await store.read("material-cache", "bad"), {
      regenerated: true,
    });
    const names = await readdir(join(dir, "quarantine", "material-cache"));
    assert.equal(
      await readFile(
        join(dir, "quarantine", "material-cache", names[0]),
        "utf8",
      ),
      "bad bytes",
    );
  }));
test("工作区损坏后恢复上一份有效索引，笔记与课题保留", async () =>
  fixture(async (store, dir) => {
    const index = {
      projects: [{ id: "project" }],
      papers: [],
      notes: [{ id: "note", text: "记录" }],
      positions: [],
    };
    await store.save("workspace", "index", index);
    await store.save("workspace", "index", {
      ...index,
      lastConversationId: "chat",
    });
    await writeFile(join(dir, "workspace", "index.json"), "{broken");
    const projects = new Projects(store.save);
    await projects.restore(store.read);
    assert.deepEqual(projects.snapshot(), index);
    assert.deepEqual(
      await new RecordStorage(dir).read("workspace", "index"),
      index,
    );
    assert.equal(
      (await readdir(join(dir, "quarantine", "workspace"))).length,
      1,
    );
  }));
test("无备份索引隔离后仍可使用正常数据；文件系统错误不被当成空记录", async () =>
  fixture(async (store, dir) => {
    await mkdir(join(dir, "workspace"));
    await writeFile(join(dir, "workspace", "index.json"), "{");
    const projects = new Projects(store.save);
    await projects.restore(store.read);
    assert.deepEqual(projects.snapshot().notes, []);
    await projects.create("恢复后的课题");
    assert.equal(
      (await store.read<any>("workspace", "index")).projects.length,
      1,
    );
    await mkdir(join(dir, "papers"));
    await mkdir(join(dir, "papers", "directory.json"));
    await assert.rejects(
      store.list("papers"),
      (error: any) => error.code === "EISDIR",
    );
  }));
test("同时读取损坏记录和保存同一编号，保存的新记录不会被错误隔离", async () =>
  fixture(async (store, dir) => {
    await mkdir(join(dir, "turns"));
    await writeFile(join(dir, "turns", "turn.json"), "broken");
    const reading = store.read("turns", "turn");
    const saving = store.save("turns", "turn", {
      id: "turn",
      status: "completed",
    });
    await assert.rejects(reading, CorruptRecordError);
    await saving;
    assert.deepEqual(await store.read("turns", "turn"), {
      id: "turn",
      status: "completed",
    });
  }));
