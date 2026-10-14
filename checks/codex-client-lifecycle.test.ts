import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CodexClient } from "../server/provider.ts";

const fixture = String.raw`
  const { createInterface } = require("node:readline");
  createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "die") process.exit(3);
    if (request.id === undefined || request.method === "hold") return;
    process.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n");
  });
`;

function launchFixture() {
  const child = spawn(process.execPath, ["-e", fixture], {
    stdio: "pipe",
    windowsHide: true,
  });
  const closed = once(child, "close");
  const client = new CodexClient(() => child);
  return { child, closed, client };
}

function assertReleased(child: ReturnType<typeof launchFixture>["child"]) {
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
}

test(
  "explicit client close rejects pending RPCs once and releases live child pipes",
  { timeout: 5000 },
  async (t) => {
    const { child, closed, client } = launchFixture();
    t.after(() => client.close());
    await client.init();
    assert.deepEqual(await client.rpc("echo", {}), { ok: true });
    let closedEvents = 0;
    client.events.on("closed", () => closedEvents++);
    const rejected = assert.rejects(client.rpc("hold", {}, 60_000), /不可用/);
    client.close();
    assertReleased(child);
    client.close();
    await rejected;
    await assert.rejects(client.rpc("echo", {}), /已经关闭/);
    await closed;
    assert.equal(closedEvents, 1);
  },
);

test(
  "unexpected process exit settles every pending RPC and releases stdio",
  { timeout: 5000 },
  async (t) => {
    const { child, closed, client } = launchFixture();
    t.after(() => client.close());
    await client.init();
    let closedEvents = 0;
    client.events.on("closed", () => closedEvents++);
    const rejected = Promise.all([
      assert.rejects(client.rpc("hold", {}, 60_000), /不可用/),
      assert.rejects(client.rpc("die", {}, 60_000), /不可用/),
    ]);
    await rejected;
    const [code] = await closed;
    assert.equal(code, 3);
    assertReleased(child);
    client.close();
    assert.equal(closedEvents, 1);
  },
);
