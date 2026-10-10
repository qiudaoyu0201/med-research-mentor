import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { pdfFixture } from "./pdf-fixture.ts";

const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4331";
const folder = "runs/usability-fixes/browser";
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const report = {
  status: "running",
  modelCalls: 0,
  fullBytes: 0,
  deltaBytes: 0,
  idleRequests: 0,
  assertions: [] as string[],
};
try {
  const fullResponse = await page.request.get(base + "/api/workspace");
  const full = await fullResponse.json();
  report.fullBytes = (await fullResponse.body()).length;
  const unchanged = await page.request.post(base + "/api/workspace", {
    data: { paperRevisions: full.paperRevisions },
  });
  const delta = await unchanged.json();
  report.deltaBytes = (await unchanged.body()).length;
  assert.deepEqual(delta.papers, []);
  assert.deepEqual(delta.paperIds, full.paperIds);
  assert.ok(report.deltaBytes < report.fullBytes / 5);
  const uploaded = await page.request.post(base + "/api/papers", {
    multipart: {
      pdf: {
        name: "stability-sync.pdf",
        mimeType: "application/pdf",
        buffer: pdfFixture(),
      },
    },
  });
  assert.ok(uploaded.ok());
  const paper = await uploaded.json();
  const changed = await (
    await page.request.post(base + "/api/workspace", {
      data: { paperRevisions: full.paperRevisions },
    })
  ).json();
  assert.deepEqual(
    changed.papers.map((p: any) => p.id),
    [paper.id],
  );
  const text = await page.request.post(base + `/api/papers/${paper.id}/text`, {
    data: {
      page: 1,
      title: "补充方法",
      text: "同步测试：补充的测量方法及对照条件。",
    },
  });
  assert.ok(text.ok(), await text.text());
  const updated = await (
    await page.request.post(base + "/api/workspace", {
      data: { paperRevisions: changed.paperRevisions },
    })
  ).json();
  assert.deepEqual(
    updated.papers.map((p: any) => p.id),
    [paper.id],
  );
  assert.notEqual(
    updated.paperRevisions[paper.id],
    changed.paperRevisions[paper.id],
  );
  report.assertions.push(
    "真实 API 空闲不传整页图像；新增论文和来源更新只传改变的资料",
  );

  const chat = await (
    await page.request.post(base + "/api/conversations", {
      data: { paperId: paper.id },
    })
  ).json();
  assert.ok(
    (
      await page.request.patch(
        base + `/api/conversations/${chat.id}/preferences`,
        {
          data: {
            learningPreferences: {
              verbosity: "deep",
              focus: "methods-figures",
            },
          },
        },
      )
    ).ok(),
  );
  assert.ok(
    (
      await page.request.put(base + "/api/workspace/position", {
        data: { conversationId: chat.id, paperId: paper.id, panel: null },
      })
    ).ok(),
  );
  await page.goto(base);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLSelectElement>(
        'select[aria-label="讲解程度"]',
      )?.disabled,
  );
  assert.equal(
    await page.getByLabel("讲解程度", { exact: true }).inputValue(),
    "deep",
  );
  assert.equal(
    await page.getByLabel("学习重点", { exact: true }).inputValue(),
    "methods-figures",
  );

  let started!: () => void, release!: () => void;
  const holding = new Promise<void>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false,
    stateRequests = 0;
  await page.route(`**/api/conversations/${chat.id}`, async (route) => {
    stateRequests++;
    if (held) return route.continue();
    held = true;
    const old = await route.fetch();
    started();
    await released;
    await route.fulfill({ response: old });
  });
  await holding;
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith("/preferences") && response.ok(),
    ),
    page.getByLabel("讲解程度", { exact: true }).selectOption("brief"),
  ]);
  await page.waitForTimeout(3200);
  assert.equal(stateRequests, 1, "请求未完成时不能开启第二轮轮询");
  release();
  await page.waitForTimeout(300);
  assert.equal(
    await page.getByLabel("讲解程度", { exact: true }).inputValue(),
    "brief",
  );
  report.assertions.push(
    "刷新先加载有效偏好；迟到的旧会话响应不会覆盖刚保存的偏好",
  );
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  let workspaceRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/workspace")) workspaceRequests++;
  });
  await page.waitForTimeout(6700);
  report.idleRequests = workspaceRequests;
  assert.ok(
    workspaceRequests >= 1 && workspaceRequests <= 3,
    String(workspaceRequests),
  );
  report.assertions.push("空闲约每三秒同步一次，上一轮请求完成后才安排下一轮");
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.getByRole("tab", { name: "我的笔记", exact: true }).click();
  const noteTitle = "同步的新笔记";
  assert.ok(
    (
      await page.request.post(base + "/api/workspace/notes/manual", {
        data: {
          conversationId: chat.id,
          id: randomUUID(),
          title: noteTitle,
          text: "另一窗口新增的笔记仍会同步。",
        },
      })
    ).ok(),
  );
  await page.getByLabel(`笔记正文 ${noteTitle}`, { exact: true }).waitFor();
  assert.equal(
    await page
      .getByLabel(`笔记正文 ${noteTitle}`, { exact: true })
      .inputValue(),
    "另一窗口新增的笔记仍会同步。",
  );
  report.assertions.push(
    "减频与增量同步后，另一窗口新增的笔记仍显示在当前资料面板",
  );
  assert.deepEqual(errors, []);
  report.status = "passed";
  await page.screenshot({ path: `${folder}/synced-notes.png` });
} catch (error) {
  report.status = "failed";
  throw error;
} finally {
  await writeFile(
    `${folder}/report.json`,
    JSON.stringify({ ...report, errors }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
