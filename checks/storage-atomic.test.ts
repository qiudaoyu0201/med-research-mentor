import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  rename,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { renameWithRetry } from "../server/storage.ts";

test("temporary Windows replacement failures retry locally while preserving the old record", async (t) => {
  const root = resolve("runs/checks");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "atomic-"));
  assert.ok(resolve(dir).startsWith(root + sep));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "new.tmp"),
    target = join(dir, "report.json");
  await writeFile(source, '{"calls":2}');
  await writeFile(target, '{"calls":1}');
  let calls = 0;
  await renameWithRetry(source, target, async (from, to) => {
    calls++;
    assert.equal(await readFile(to, "utf8"), '{"calls":1}');
    if (calls < 3)
      throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
    await rename(from, to);
  });
  assert.equal(calls, 3);
  assert.equal(await readFile(target, "utf8"), '{"calls":2}');
});

test("permanent replacement failure stays bounded and keeps its original error", async () => {
  for (const code of ["EPERM", "ENOSPC"]) {
    let calls = 0;
    const failure = Object.assign(new Error(code), { code });
    await assert.rejects(
      renameWithRetry("source", "target", async () => {
        calls++;
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(calls, code === "EPERM" ? 4 : 1);
  }
});
