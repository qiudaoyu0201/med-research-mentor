import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { pdfFixture } from "./pdf-fixture.ts";

// Run against an isolated TUTOR_DATA_DIR to keep the user's library unchanged.
const base = process.env.TUTOR_BASE_URL || "http://127.0.0.1:4318";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.emulateMedia({ reducedMotion: "reduce" });
const errors: string[] = [],
  report = { status: "running", modelCalls: 0, assertions: [] as string[] };
page.on("pageerror", (e) => errors.push(e.message));
await mkdir("runs/workspace/screenshots", { recursive: true });
async function bootstrap() {
  const response = await page.request.get(base + "/api/workspace");
  assert.ok(response.ok());
  return response.json();
}
async function post(path: string, data: unknown) {
  const response = await page.request.post(base + path, { data });
  assert.ok(response.ok(), await response.text());
  return response.json();
}
async function upload(name: string, buffer: Buffer) {
  return page.request.post(base + "/api/papers", {
    multipart: { pdf: { name, mimeType: "application/pdf", buffer } },
  });
}
try {
  await page.goto(base);
  await page
    .getByRole("heading", { name: "从论文或你的研究想法开始" })
    .waitFor();
  await page.screenshot({
    path: "runs/workspace/screenshots/home.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "导入材料", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "wrong.docx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("wrong"),
  });
  await page.getByRole("alert").filter({ hasText: "当前支持 PDF" }).waitFor();
  await page.locator("input[type=file]").setInputFiles({
    name: "bad.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a PDF"),
  });
  await page
    .getByRole("alert")
    .filter({ hasText: "文件内容不是 PDF" })
    .waitFor();
  const before = (await bootstrap()).papers.length;
  assert.equal(
    (await upload("image.png", Buffer.from("not-pdf"))).status(),
    400,
  );
  assert.equal(
    (await upload("forged.pdf", Buffer.from("not-pdf"))).status(),
    400,
  );
  assert.equal((await bootstrap()).papers.length, before);
  await page.evaluate(() => {
    const files = new DataTransfer();
    files.items.add(new File(["test"], "one.pdf"));
    files.items.add(new File(["test"], "two.pdf"));
    document
      .querySelector(".rw")!
      .dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: files }),
      );
  });
  await page
    .getByRole("alert")
    .filter({ hasText: "每次请导入一个文件" })
    .waitFor();
  await page.evaluate(() => {
    const files = new DataTransfer();
    files.items.add(
      new File([new Uint8Array(30 * 1024 * 1024 + 1)], "large.pdf"),
    );
    document
      .querySelector(".rw")!
      .dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer: files }),
      );
  });
  await page.getByRole("alert").filter({ hasText: "超过 30 MiB" }).waitFor();
  const scan = await upload("scan-fixture.pdf", pdfFixture(""));
  assert.equal(scan.status(), 201);
  assert.equal((await scan.json()).parseStatus, "needs-text");
  const damaged = await upload(
    "damaged-fixture.pdf",
    Buffer.from("%PDF-1.4\nBroken document"),
  );
  assert.equal(damaged.status(), 422);
  assert.equal((await damaged.json()).paper.parseStatus, "failed");
  report.assertions.push(
    "click/drop validation; backend rejects forged content and extensions; scan and damaged PDF states remain truthful",
  );

  // Import without a project, select real extracted text, verify requests and cancellation using browser fixtures.
  await page.locator("input[type=file]").setInputFiles({
    name: "engineering-exercise.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(),
  });
  await page
    .getByRole("heading", { name: "从这篇论文的一个问题开始" })
    .waitFor();
  await page
    .getByText("论文已导入，可以从一个问题开始。", { exact: true })
    .waitFor();
  let workspace = await bootstrap();
  const imported = workspace.papers.find(
    (p: any) => p.title === "engineering-exercise.pdf",
  );
  assert.ok(imported);
  assert.equal(
    workspace.index.papers.find((m: any) => m.paperId === imported.id)
      .projectId,
    null,
  );
  await page.getByRole("button", { name: "资料与笔记", exact: true }).click();
  await page
    .locator(".rp-source-card .rw-selectable")
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 0);
      range.setEnd(element.firstChild!, 70);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
  assert.equal(await page.getByLabel("向科研助手提问").inputValue(), "");
  await page.getByRole("button", { name: "解释所选文字", exact: true }).click();
  await page.getByText("正在问：第 1 页这句话").waitFor();
  assert.match(
    await page.getByLabel("向科研助手提问").inputValue(),
    /解释这段/,
  );
  let payload: any,
    cancelled = false;
  await page.route("**/api/conversations/*/messages", async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      json: {
        id: "browser-workspace-fixture",
        conversationId: route.request().url().split("/").at(-2),
        message: payload,
        status: "queued",
        createdAt: new Date().toISOString(),
        budget: { attempts: [] },
      },
    });
  });
  await page.route("**/api/turns/browser-workspace-fixture", async (route) =>
    route.fulfill({
      json: {
        id: "browser-workspace-fixture",
        conversationId: (await bootstrap()).conversations.at(-1).id,
        message: payload,
        status: cancelled ? "cancelled" : "running",
        createdAt: new Date().toISOString(),
        budget: { attempts: [] },
      },
    }),
  );
  await page.route(
    "**/api/turns/browser-workspace-fixture/cancel",
    async (route) => {
      cancelled = true;
      await route.fulfill({ json: { ok: true } });
    },
  );
  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  await page.getByRole("button", { name: "发送 ↑", exact: true }).click();
  await page.getByRole("button", { name: "停止", exact: true }).waitFor();
  assert.equal(payload.paperId, imported.id);
  assert.equal(payload.sourceAnchor.sourceVersion, imported.version);
  assert.ok(imported.sources[0].text.includes(payload.sourceAnchor.excerpt));
  assert.equal(payload.sourceAnchor.excerpt.length, 70);
  assert.equal(payload.focus, undefined);
  assert.equal(payload.module, undefined);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.getByText("已停止", { exact: true }).waitFor();
  await page.unroute("**/api/conversations/*/messages");
  report.assertions.push(
    "ungrouped real PDF import and original-text anchor reach the unified API; cancel displays true state (browser fixture, zero model calls)",
  );

  await page.getByRole("button", { name: "新建课题", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("名称", { exact: true })
    .fill("实验与功能");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.locator("input[type=file]").setInputFiles({
    name: "grouped-exercise.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(),
  });
  await page
    .getByRole("heading", { name: "从这篇论文的一个问题开始" })
    .waitFor();
  await page
    .getByRole("button", { name: "论文名称与归组", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("名称", { exact: true })
    .fill("我的对照实验论文");
  const owner = (await bootstrap()).index.projects.find(
    (p: any) => p.name === "实验与功能",
  ).id;
  assert.equal(
    await page.getByRole("dialog").getByLabel("所属课题").inputValue(),
    owner,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  workspace = await bootstrap();
  const grouped = workspace.papers.find(
    (p: any) => p.title === "grouped-exercise.pdf",
  );
  assert.equal(
    workspace.index.papers.find((m: any) => m.paperId === grouped.id)
      .displayName,
    "我的对照实验论文",
  );
  assert.equal(grouped.title, "grouped-exercise.pdf");
  await page.getByLabel("向科研助手提问").fill("先保留这篇论文的草稿");
  await page.getByRole("button", { name: "资料与笔记", exact: true }).click();
  await page
    .getByRole("button", { name: "对这段原文提问", exact: true })
    .click();
  await page.getByLabel("向科研助手提问").fill("先保留这篇论文的草稿");
  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  await page
    .locator(".rw-project > summary")
    .filter({ hasText: "未分组论文" })
    .click();
  await page
    .getByRole("button", { name: "engineering-exercise.pdf", exact: true })
    .click();
  await page.getByRole("heading", { name: "新讨论", exact: true }).waitFor();
  assert.equal(await page.locator(".rw-reference").count(), 0);
  await page
    .locator(".rw-project > summary")
    .filter({ hasText: "实验与功能" })
    .click();
  await page
    .getByRole("button", { name: "我的对照实验论文", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "我的对照实验论文", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("向科研助手提问").inputValue(),
    "先保留这篇论文的草稿",
  );
  report.assertions.push(
    "project creation, default ownership, rename keeps original bibliography; paper switch isolates references and preserves drafts",
  );

  // Existing sample material produces explicitly engineering/example records with zero model calls.
  workspace = await bootstrap();
  const sample = workspace.papers.find((p: any) => p.doi);
  const conversation = await post("/api/conversations", { paperId: sample.id });
  const turn = await post(`/api/conversations/${conversation.id}/messages`, {
    clientMessageId: "workspace-engineering-example",
    mode: "example",
    module: "paper",
    question: "解释论文研究问题",
    paperId: sample.id,
  });
  let finished: any;
  for (let i = 0; i < 100; i++) {
    finished = await (
      await page.request.get(base + `/api/turns/${turn.id}`)
    ).json();
    if (["completed", "failed"].includes(finished.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(finished.status, "completed", finished.error);
  assert.equal(finished.budget.attempts.length, 0);
  const position = await page.request.put(base + "/api/workspace/position", {
    data: {
      conversationId: conversation.id,
      paperId: sample.id,
      panel: "sources",
      sourceId: sample.sources[0].id,
      sourceVersion: sample.version,
    },
  });
  assert.ok(position.ok());
  await page.reload();
  await page
    .getByRole("button", { name: "保存回答为笔记", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "重命名讨论", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("名称", { exact: true })
    .fill("研究问题与对照");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "保存回答为笔记", exact: true })
    .click();
  await page.getByRole("heading", { name: "我的笔记", exact: true }).waitFor();
  const text = page.getByRole("textbox", { name: /^笔记正文/ });
  await text.fill("我的理解：对照帮助区分不同解释。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByText("笔记修改已保存。", { exact: true }).waitFor();
  const repeated = await post("/api/workspace/notes", {
    conversationId: conversation.id,
    turnId: turn.id,
  });
  workspace = await bootstrap();
  assert.equal(
    workspace.index.notes.filter((n: any) => n.turnId === turn.id).length,
    1,
  );
  assert.ok(repeated.anchors.length);
  await page.reload();
  await page
    .getByRole("heading", { name: "研究问题与对照", exact: true })
    .waitFor();
  await page.getByRole("heading", { name: "我的笔记", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: /^笔记正文/ }).inputValue(),
    "我的理解：对照帮助区分不同解释。",
  );
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出 Markdown", exact: true })
    .click();
  assert.equal((await download).suggestedFilename(), "论文研究笔记.md");
  await page.screenshot({
    path: "runs/workspace/screenshots/notes-desktop.png",
    fullPage: true,
  });
  report.assertions.push(
    "named discussion, saved answer, immutable evidence, idempotent save, edited notes and panel survive reload; Markdown export",
  );
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 960 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `horizontal overflow at ${width}`,
    );
    await page.screenshot({
      path: `runs/workspace/screenshots/notes-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  await page.getByRole("button", { name: "资料与笔记", exact: true }).click();
  await page
    .getByRole("button", { name: "对这段原文提问", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  await page.getByText("正在问：", { exact: false }).waitFor();
  await page.screenshot({
    path: "runs/workspace/screenshots/mobile-question.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByLabel("搜索论文").fill("我的对照");
  await page
    .getByRole("button", { name: "我的对照实验论文", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".rp-sidebar-open").count(), 0);
  report.assertions.push(
    "desktop/tablet/mobile have no horizontal overflow; mobile paragraph questioning and keyboard navigation",
  );
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  await page.screenshot({
    path: "runs/workspace/screenshots/failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await writeFile(
    "runs/workspace/browser-report.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
