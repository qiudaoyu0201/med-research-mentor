import { answerAction, selectPdf } from "./browser-research-helpers.ts";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { chromium } from "playwright";
import { pdfFixture } from "./pdf-fixture.ts";
const base = process.env.TUTOR_BASE_URL || "http://127.0.0.1:4318";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.emulateMedia({ reducedMotion: "reduce" });
const errors: string[] = [],
  report = { status: "running", modelCalls: 0, assertions: [] as string[] };
page.on("pageerror", (e) => errors.push(e.message));
const unique = Date.now();
const png = createCanvas(30, 20).toBuffer("image/png");
const upload = (name: string) =>
  page.request.post(base + "/api/papers", {
    multipart: {
      pdf: { name, mimeType: "application/pdf", buffer: pdfFixture() },
    },
  });
const post = async (path: string, data: unknown) => {
  const r = await (path === "/api/workspace/position"
    ? page.request.put(base + path, { data })
    : page.request.post(base + path, { data }));
  assert.ok(r.ok(), await r.text());
  return r.json();
};
let turns: any[] = [],
  payload: any,
  imageUploads = 0,
  messages = 0;
page.on("request", (r) => {
  if (
    r.method() === "POST" &&
    /\/api\/conversations\/[^/]+\/attachments$/.test(r.url())
  )
    imageUploads++;
});
try {
  const imported = await (await upload(`materials-${unique}.pdf`)).json();
  const chat = await post(`/api/papers/${imported.id}/chat`, {});
  await post("/api/workspace/position", {
    conversationId: chat.id,
    paperId: imported.id,
    panel: null,
  });
  await page.route("**/api/conversations/*/messages", async (route) => {
    messages++;
    payload = route.request().postDataJSON();
    const chatId = /conversations\/([^/]+)/.exec(route.request().url())![1];
    const attachments = payload.attachmentIds?.length
      ? await Promise.all(
          payload.attachmentIds.map(async (id: string) => {
            // Uploaded records are kept on the server, while model execution is a browser fixture.
            return {
              id,
              conversationId: chatId,
              paperId: payload.paperId,
              name: "pasted.png",
              hash: "fixture",
              status: "needs-purpose",
              image: `data:image/png;base64,${png.toString("base64")}`,
              reason: "补充用途",
            };
          }),
        )
      : [];
    const turn = {
      id: `materials-turn-${messages}`,
      conversationId: chatId,
      status: "clarification",
      message: payload,
      attachments,
      reply: {
        content: null,
        artifacts: [],
        pendingQuestions: [],
        nextStep: "补充用途",
      },
      budget: { attempts: [] },
    };
    turns = [turn];
    await route.fulfill({ json: turn });
  });
  await page.route("**/api/conversations/*/turns", (route) =>
    route.fulfill({
      json: turns.filter((t) =>
        route.request().url().includes(t.conversationId),
      ),
    }),
  );
  await page.goto(base);
  await page
    .getByRole("heading", { name: "从这篇论文的一个问题开始" })
    .waitFor();
  const images = page.locator('input[type=file][accept=".png,.jpg,.jpeg"]');
  await images.setInputFiles({
    name: "prepared.png",
    mimeType: "image/png",
    buffer: png,
  });
  await page.getByLabel("待发送附件").getByText("prepared.png").waitFor();
  assert.equal(imageUploads, 0);
  assert.equal(messages, 0);
  await page.reload();
  await page.getByLabel("待发送附件").getByText("prepared.png").waitFor();
  await page.getByRole("button", { name: "移除附件 prepared.png" }).click();
  await page.evaluate((bytes) => {
    const data = new DataTransfer();
    data.items.add(
      new File(
        [Uint8Array.from(atob(bytes), (s) => s.charCodeAt(0))],
        "pasted.png",
        { type: "image/png" },
      ),
    );
    document
      .querySelector(".rw-composer")!
      .dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, clipboardData: data }),
      );
  }, png.toString("base64"));
  await page.getByLabel("待发送附件").getByText("pasted.png").waitFor();
  await page.getByLabel("向科研助手提问").fill("解释图片中的比较");
  await page.getByRole("button", { name: "发送 ↑", exact: true }).click();
  await page.getByText("补充用途", { exact: true }).first().waitFor();
  assert.equal(imageUploads, 1);
  assert.equal(messages, 1);
  assert.equal(payload.attachmentIds.length, 1);
  assert.equal(payload.paperId, imported.id);
  let retryBody: any;
  await page.route("**/api/turns/*/attachments/*/retry", async (route) => {
    retryBody = route.request().postDataJSON();
    await route.fulfill({ json: turns[0] });
  });
  await page.getByLabel("图片用途 pasted.png").fill("用来说明实验组和对照组");
  await page.getByRole("button", { name: "重试这项附件" }).click();
  await page.waitForFunction(() =>
    document.querySelector(".rw-message-attachments"),
  );
  assert.equal(retryBody.purpose, "用来说明实验组和对照组");
  assert.equal(messages, 1);
  assert.equal(imageUploads, 1);
  report.assertions.push(
    "file previews/removal survive reload; paste defers upload until Send; per-image purpose retry keeps the same message",
  );

  await page.getByRole("button", { name: "资料", exact: true }).click();

  const pdfText = page.locator(".rw-pdf-page .textLayer span").first();
  await pdfText.waitFor();
  const pdfExcerpt = await pdfText.evaluate((element) => {
    const end = Math.min(element.textContent!.length, 45),
      range = document.createRange();
    range.setStart(element.firstChild!, 5);
    range.setEnd(element.firstChild!, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return selection.toString();
  });
  await page.getByRole("button", { name: "解释", exact: true }).click();
  assert.equal(
    await page.locator(".rw-reference-target").textContent(),
    `正在问：${pdfExcerpt}`,
  );
  await page.getByRole("button", { name: "发送 ↑", exact: true }).click();
  assert.equal(payload.sourceAnchor.excerpt, pdfExcerpt);
  assert.equal(payload.sourceAnchor.textView, "pdf");

  report.assertions.push(
    "inline PDF renders a selectable text layer and submits the actual selected substring with a validated paper/page anchor",
  );
  const selectable = page.locator(".rw-pdf-page .textLayer span").first();
  const selected = await selectable.evaluate((element) => {
    const text = element.textContent!,
      range = document.createRange();
    range.setStart(element.firstChild!, 5);
    range.setEnd(element.firstChild!, 90);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return text.slice(5, 90);
  });
  await page.getByRole("button", { name: "解释", exact: true }).click();
  assert.equal(
    await page.locator(".rw-reference-target").textContent(),
    `正在问：${selected}`,
  );
  await page.locator(".rw-reference-target").click();
  await page.getByRole("button", { name: "发送 ↑", exact: true }).click();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".rw-turn").length > 0,
    messages,
  );
  assert.equal(payload.sourceAnchor.excerpt, selected);
  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  report.assertions.push(
    "partial/cross-sentence source selections display and submit the exact substring; quotation returns to the source",
  );

  await page.locator('input[type=file][accept=".pdf"]').setInputFiles({
    name: `composer-${unique}.pdf`,
    mimeType: "application/pdf",
    buffer: pdfFixture(
      "Different paper explores an experimental comparison. The experiment records strength and control group outcomes.",
    ),
  });
  await page.getByLabel("向科研助手提问").fill("解释新论文的实验设计");
  await page.getByRole("button", { name: "发送 ↑", exact: true }).click();
  await page
    .locator(".rw-breadcrumb strong")
    .filter({ hasText: `composer-${unique}.pdf` })
    .waitFor();
  assert.notEqual(payload.paperId, imported.id);
  assert.equal(payload.question, "解释新论文的实验设计");
  assert.equal(payload.sourceAnchor, undefined);
  report.assertions.push(
    "composer PDF starts a new paper main chat and carries the question, without carrying the old quotation",
  );

  // Actual sample version creation, rename, restore/export use the real backend; no model call.
  const sampleChat = await post("/api/papers/xu-2018/chat", {});
  const seed = await post("/api/deck-versions", {
    conversationId: sampleChat.id,
    paperId: "xu-2018",
  });
  await post("/api/workspace/position", {
    conversationId: sampleChat.id,
    paperId: "xu-2018",
    panel: null,
  });
  await page.evaluate(() => sessionStorage.removeItem("research-current-chat"));
  await page.reload();
  await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
  await page.getByLabel("第 1 页预览").waitFor();
  await page
    .locator(".rw-ppt-name")
    .locator("..")
    .getByText("汇报名称", { exact: false })
    .click();
  await page.getByLabel("汇报名称").fill(`研究汇报-${unique}`);
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await page
    .getByLabel("保存版本", { exact: true })
    .locator("option:checked")
    .filter({ hasText: `研究汇报-${unique}` })
    .waitFor({ state: "attached" });
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  await page.getByLabel("幻灯片标题").fill("本地修改预览");
  assert.ok(await page.getByText("本地修改预览", { exact: true }).isVisible());
  assert.ok(
    await page.getByRole("button", { name: "导出当前保存版本" }).isDisabled(),
  );
  let editBody: any;
  await page.route("**/api/deck-versions/*/edit", async (route) => {
    editBody = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ...seed,
        id: "fixture-edit",
        status: "queued",
        parentId: seed.id,
        slideIndex: editBody.slideIndex,
      },
    });
  });
  await page
    .getByRole("button", { name: "保存指定页并核对", exact: true })
    .click();
  assert.equal(editBody.slideIndex, 0);
  assert.equal(editBody.slide.title, "本地修改预览");
  assert.equal(editBody.conversationId, sampleChat.id);
  await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
  await page.getByLabel("第 1 页预览").waitFor();
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  assert.equal(
    await page.getByLabel("幻灯片标题").inputValue(),
    "本地修改预览",
  );
  await page
    .getByRole("button", { name: "放弃这页未保存编辑", exact: true })
    .click();
  await page
    .getByRole("button", { name: "导出当前保存版本", exact: true })
    .click();
  const link = page.getByRole("link", { name: "下载 PPTX" });
  await link.waitFor();
  const file = await page.request.get(base + (await link.getAttribute("href")));
  assert.ok(file.ok());
  assert.equal((await file.body()).subarray(0, 2).toString(), "PK");
  assert.equal(
    await page.locator('a[href="/assistant"], a[href="/prototype"]').count(),
    0,
  );
  report.assertions.push(
    "native PPT restores the paper's saved report, renames, previews edits, submits only the selected page and exports the saved PPTX; old tool/prototype links are absent",
  );

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/preferences") && r.ok()),
    page.getByLabel("学习重点", { exact: true }).selectOption("foundations"),
  ]);
  assert.equal(
    (
      await (
        await page.request.get(base + `/api/conversations/${sampleChat.id}`)
      ).json()
    ).explanationDepth,
    "foundations",
  );
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByRole("button", { name: "个人记录", exact: true }).click();
  await page.getByLabel("保存待解决问题").fill("以后继续比较实验对照");
  await page.getByRole("button", { name: "保存我的问题", exact: true }).click();
  await page.getByLabel("学习记录内容").first().waitFor();
  await page.getByRole("button", { name: "关闭个人记录", exact: true }).click();
  await page.getByRole("button", { name: "返回论文研究", exact: true }).click();
  const example = await post(`/api/conversations/${sampleChat.id}/messages`, {
    clientMessageId: `records-${unique}`,
    mode: "example",
    module: "paper",
    question: "介绍这篇论文的研究问题",
  });
  for (let i = 0; i < 100; i++) {
    const value = await (
      await page.request.get(base + `/api/turns/${example.id}`)
    ).json();
    if (value.status === "completed") {
      example.runId = value.runId;
      break;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  await page.unroute("**/api/conversations/*/turns");
  await page.reload();
  await answerAction(page, example.id, "收藏解释");
  await page.getByText("解释已收藏。", { exact: true }).waitFor();
  await answerAction(page, example.id, "仍不理解", "我的理解反馈");
  await page.getByText("你的理解反馈已保存。", { exact: true }).waitFor();
  const recorded = await (
    await page.request.get(base + `/api/conversations/${sampleChat.id}`)
  ).json();
  assert.ok(
    recorded.learningRecords.some(
      (r: any) => r.kind === "favorite" && r.unitId === example.runId,
    ),
  );
  assert.ok(
    recorded.learningRecords.some(
      (r: any) => r.kind === "feedback" && r.feedback === "confused",
    ),
  );
  report.assertions.push(
    "actual fixed-example answers can be favorited and receive explicit user feedback in the native workspace without model calls",
  );
  const navSplit = page.getByRole("separator", { name: "调整导航宽度" });
  await navSplit.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await navSplit.getAttribute("aria-valuenow"), "236");
  await post("/api/workspace/position", {
    conversationId: sampleChat.id,
    paperId: "xu-2018",
    panel: "sources",
  });
  await page.reload();
  assert.equal(await navSplit.getAttribute("aria-valuenow"), "236");
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.getByRole("button", { name: "固定对照", exact: true }).click();
  await page.getByLabel("资料与笔记面板", { exact: true }).waitFor();
  const readSplit = page.getByRole("separator", { name: "调整聊天与阅读宽度" });
  const box = (await readSplit.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x - 55, box.y + 80);
  await page.mouse.up();
  assert.ok(Number(await readSplit.getAttribute("aria-valuenow")) > 360);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "恢复默认布局" }).click();
  await page.getByRole("button", { name: "关闭设置" }).click();
  assert.equal(await navSplit.getAttribute("aria-valuenow"), "216");
  report.assertions.push(
    "native settings and personal records persist through backend; splitter keyboard/drag changes persist across reload and Reset restores defaults",
  );
  const scanResponse = await page.request.post(base + "/api/papers", {
    multipart: {
      pdf: {
        name: `scan-${unique}.pdf`,
        mimeType: "application/pdf",
        buffer: pdfFixture(""),
      },
    },
  });
  const scan = await scanResponse.json(),
    scanChat = await post(`/api/papers/${scan.id}/chat`, {});
  await post("/api/workspace/position", {
    conversationId: scanChat.id,
    paperId: scan.id,
    panel: "sources",
  });
  await page.evaluate(() => sessionStorage.removeItem("research-current-chat"));
  await page.reload();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.getByText("补充原文", { exact: true }).click();
  await page
    .getByLabel("补充原文正文")
    .fill(
      "In this study, exercise and control groups were compared for muscle function. The protocol measured strength and activity.",
    );
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/papers/${scan.id}/text`) && r.ok(),
    ),
    page.getByRole("button", { name: "保存补充原文", exact: true }).click(),
  ]);
  const updated = (
    await (await page.request.get(base + "/api/workspace")).json()
  ).papers.find((p: any) => p.id === scan.id);
  assert.equal(updated.parseStatus, "ready");
  assert.notEqual(updated.version, scan.version);
  assert.ok(
    updated.sources.some(
      (s: any) => s.title.includes("用户补充原文") && s.page === 1,
    ),
  );
  report.assertions.push(
    "scanned/no-text PDFs can receive page-labelled text in the native reader; availability and source version update through the actual backend",
  );
  await post("/api/workspace/position", {
    conversationId: sampleChat.id,
    paperId: "xu-2018",
    panel: "sources",
  });
  await page.reload();
  await mkdir("runs/second-round/screenshots", { recursive: true });
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 960 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `research overflow ${width}`,
    );
    await page.screenshot({
      path: `runs/second-round/screenshots/research-${width}.png`,
      fullPage: true,
    });
    if (width <= 1000)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `ppt overflow ${width}`,
    );
    await page.screenshot({
      path: `runs/second-round/screenshots/ppt-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "返回论文研究", exact: true })
      .click();
  }
  assert.deepEqual(errors, []);
  report.assertions.push(
    "research/PPT views have no horizontal overflow at 1440/1024/768/390; zero browser exceptions",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  await mkdir("runs/second-round/screenshots", { recursive: true });
  await page.screenshot({
    path: "runs/second-round/screenshots/materials-failure.png",
  });
  throw error;
} finally {
  await writeFile(
    "runs/second-round/browser-materials-tools.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
