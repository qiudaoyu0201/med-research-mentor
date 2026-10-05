import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { pdfFixture } from "./pdf-fixture.ts";

// UI-only task responses; scheduler execution is exercised in scheduler.test.ts.
// Use a separate TUTOR_DATA_DIR on the server; no real model requests are sent.
const base = process.env.TUTOR_BASE_URL || "http://127.0.0.1:4318";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.emulateMedia({ reducedMotion: "reduce" });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const report = { status: "running", modelCalls: 0, assertions: [] as string[] };
await mkdir("runs/workspace/scheduling", { recursive: true });
try {
  const papers: any[] = [],
    chats: any[] = [];
  for (const name of ["a", "b", "c"].map(
    (letter) => `schedule-${letter}-${randomUUID().slice(0, 6)}.pdf`,
  )) {
    const token = randomUUID();
    const upload = async () => {
      const response = await page.request.post(`${base}/api/papers`, {
        headers: { "X-Import-Id": token },
        multipart: {
          pdf: { name, mimeType: "application/pdf", buffer: pdfFixture() },
        },
      });
      assert.equal(response.status(), 201);
      return response.json();
    };
    const paper = await upload();
    assert.equal((await upload()).id, paper.id);
    const response = await page.request.post(
      `${base}/api/papers/${paper.id}/chat`,
      { data: {} },
    );
    assert.ok(response.ok());
    papers.push(paper);
    chats.push(await response.json());
  }
  const bootstrap = await (
    await page.request.get(`${base}/api/workspace`)
  ).json();
  for (const paper of papers) {
    assert.equal(
      bootstrap.conversations.filter((c: any) => c.paperId === paper.id).length,
      1,
    );
  }
  report.assertions.push(
    "real PDF import retries produce one paper and main chat per submission",
  );

  const turns: any[] = [];
  let admissionStarted!: () => void, releaseAdmission!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admissionStarted = resolve;
  });
  function drain() {
    const running = turns.filter((t) => t.status === "running");
    for (const turn of turns) {
      if (running.length >= 2) break;
      if (
        turn.status === "queued" &&
        !running.some((t) => t.conversationId === turn.conversationId)
      ) {
        turn.status = "running";
        running.push(turn);
      }
    }
  }
  await page.route("**/api/conversations/*/messages", async (route) => {
    const message = route.request().postDataJSON();
    if (message.question === "A 提交中切换") {
      admissionStarted();
      await new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
    }
    const turn = {
      id: randomUUID(),
      conversationId: route.request().url().split("/").at(-2),
      message,
      status: "queued",
      createdAt: new Date().toISOString(),
      budget: { attempts: [] },
    };
    turns.push(turn);
    drain();
    await route.fulfill({ json: turn });
  });
  await page.route("**/api/conversations/*/turns", async (route) => {
    const id = route.request().url().split("/").at(-2);
    if (!chats.some((c) => c.id === id)) return route.continue();
    await route.fulfill({ json: turns.filter((t) => t.conversationId === id) });
  });
  await page.route("**/api/turns/*/cancel", async (route) => {
    const id = route.request().url().split("/").at(-2);
    const turn = turns.find((t) => t.id === id);
    assert.ok(turn);
    turn.status = "cancelled";
    drain();
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(base);
  async function select(index: number) {
    await page
      .locator(".rp-sidebar")
      .getByRole("button", { name: papers[index].title, exact: true })
      .click();
    await page
      .getByRole("heading", { name: papers[index].title, exact: true })
      .waitFor();
    await page
      .getByText("正在恢复资料与讨论…", { exact: true })
      .waitFor({ state: "hidden" });
  }
  async function send(text: string) {
    await page.getByLabel("向科研助手提问").fill(text);
    await page.locator(".rw-composer button[type=submit]").click();
    await page.waitForFunction(
      () =>
        (document.querySelector(".rw-composer textarea") as HTMLTextAreaElement)
          .value === "",
    );
  }
  await select(0);
  await send("A 的第一个问题");
  await page.getByRole("button", { name: "停止回答", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "开始新讨论", exact: true }).count(),
    0,
  );
  await send("A 的第二个问题");
  await page.getByRole("button", { name: "取消等待", exact: true }).waitFor();
  await page.getByLabel("向科研助手提问").fill("A 下一条草稿");
  await select(1);
  assert.equal(await page.getByLabel("向科研助手提问").inputValue(), "");
  await send("B 的问题");
  await page.getByRole("button", { name: "停止回答", exact: true }).waitFor();
  await select(2);
  await send("C 的问题");
  await page.getByRole("button", { name: "取消等待", exact: true }).waitFor();
  assert.equal(turns.filter((t) => t.status === "running").length, 2);
  await page.getByRole("button", { name: "取消等待", exact: true }).click();
  await page.getByText("已停止", { exact: true }).waitFor();
  await select(0);
  assert.equal(
    await page.getByLabel("向科研助手提问").inputValue(),
    "A 下一条草稿",
  );
  await page.getByRole("button", { name: "资料与笔记", exact: true }).click();
  await page
    .getByRole("button", { name: "对这段原文提问", exact: true })
    .click();
  await page.getByLabel("向科研助手提问").fill("A 带引用的草稿");
  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  await select(1);
  assert.equal(await page.locator(".rw-reference").count(), 0);
  await select(0);
  assert.equal(await page.locator(".rw-reference").count(), 1);
  assert.equal(
    await page.getByLabel("向科研助手提问").inputValue(),
    "A 带引用的草稿",
  );
  await page.reload();
  await page.getByRole("button", { name: "取消等待", exact: true }).waitFor();
  assert.equal(await page.locator(".rw-reference").count(), 1);
  assert.equal(
    await page.getByLabel("向科研助手提问").inputValue(),
    "A 带引用的草稿",
  );
  await page.getByRole("button", { name: "取消等待", exact: true }).click();
  await page.getByRole("button", { name: "编辑后重发", exact: true }).click();
  assert.equal(
    await page.getByLabel("向科研助手提问").inputValue(),
    "A 的第二个问题",
  );
  report.assertions.push(
    "generating chats keep navigation, source reading and composer usable; per-chat queue cancel restores editable question; drafts/references survive switching and reload",
  );
  await page.getByLabel("向科研助手提问").fill("A 提交中切换");
  await page.locator(".rw-composer button[type=submit]").click();
  await admitted;
  await page.getByLabel("向科研助手提问").fill("A 发送期间的新草稿");
  await select(1);
  await page.getByLabel("向科研助手提问").fill("B 正在准备的问题");
  releaseAdmission();
  await page.waitForFunction(
    () =>
      !(
        document.querySelector(
          ".rw-composer button[type=submit]",
        ) as HTMLButtonElement
      ).disabled,
  );
  assert.equal(
    await page.getByLabel("向科研助手提问").inputValue(),
    "B 正在准备的问题",
  );
  assert.equal(
    await page.getByText("A 提交中切换", { exact: true }).count(),
    0,
  );
  await select(0);
  assert.equal(
    await page.getByLabel("向科研助手提问").inputValue(),
    "A 发送期间的新草稿",
  );
  await page.getByText("A 提交中切换", { exact: true }).waitFor();
  report.assertions.push(
    "late submission responses stay in the owning chat and preserve drafts edited during submission",
  );
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 960 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: `runs/workspace/scheduling/${width}.png`,
      fullPage: true,
    });
  }
  report.assertions.push(
    "waiting/running rows fit 1440/1024/768/390 widths without horizontal overflow",
  );
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  await page.screenshot({
    path: "runs/workspace/scheduling/failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await writeFile(
    "runs/workspace/scheduling/report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
