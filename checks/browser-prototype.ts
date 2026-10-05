import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.TUTOR_BASE_URL || "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors: string[] = [];
const apiCalls: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (new URL(request.url()).pathname.startsWith("/api/"))
    apiCalls.push(request.url());
});
await mkdir("runs/prototype", { recursive: true });
try {
  await page.goto(baseUrl);
  await page
    .getByRole("heading", { name: "读懂研究问题", exact: true })
    .waitFor();
  await page.screenshot({ path: "runs/prototype/desktop.png", fullPage: true });

  await page
    .getByRole("button", { name: "为什么需要两种对照？", exact: true })
    .click();
  await page.getByRole("heading", { name: "两种对照，各排除什么？" }).waitFor();
  await page.getByRole("button", { name: "讲得更通俗", exact: true }).click();
  await page.getByText("简单说：非衰老细胞组", { exact: false }).waitFor();
  await page.getByRole("button", { name: "理解实验对照", exact: true }).click();
  await page
    .getByRole("button", { name: "解读 Figure 1", exact: true })
    .click();
  await page.getByRole("heading", { name: "按这三步读图" }).waitFor();
  await page
    .getByRole("button", { name: "Figure 1 图注", exact: true })
    .click();
  const selectedSource = page.locator(".rp-source-active");
  assert.match(await selectedSource.innerText(), /Figure 1d–j/);
  assert.equal(
    await selectedSource.getByRole("link").getAttribute("href"),
    "https://pmc.ncbi.nlm.nih.gov/articles/PMC6082705/#F1",
  );
  await page.screenshot({ path: "runs/prototype/sources.png", fullPage: true });

  await page.getByRole("tab", { name: "我的笔记" }).click();
  await page
    .getByLabel("我的论文阅读笔记")
    .fill("测试笔记：比较组不同，排除的解释也不同。");
  await page.getByRole("button", { name: "保存笔记", exact: true }).click();
  await page
    .getByRole("status")
    .getByText("阅读笔记已保存在此浏览器")
    .waitFor();
  await page.reload();
  await page.getByRole("tab", { name: "我的笔记" }).click();
  assert.equal(
    await page.getByLabel("我的论文阅读笔记").inputValue(),
    "测试笔记：比较组不同，排除的解释也不同。",
  );
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 Markdown" }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "论文阅读笔记.md");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  assert.match(Buffer.concat(chunks).toString("utf8"), /测试笔记：比较组不同/);

  await page.getByRole("tab", { name: "论文解读" }).click();
  await page.getByRole("tab", { name: "论文解读" }).press("ArrowRight");
  assert.equal(
    await page
      .getByRole("tab", { name: "原文依据" })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.getByRole("button", { name: "放大阅读成果" }).click();
  assert.ok(await page.locator(".rp-expanded").count());
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".rp-expanded").count(), 0);
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByRole("button", { name: "紧凑阅读", exact: false }).click();
  assert.ok(await page.locator(".rp-compact").count());
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);

  await page.getByLabel("搜索阅读任务").fill("不存在的任务");
  await page.getByText("没有找到相关任务").waitFor();
  await page.getByLabel("搜索阅读任务").fill("");
  await page.getByRole("button", { name: "新建阅读任务" }).click();
  await page.getByRole("heading", { name: "先选一个你想弄懂的问题" }).waitFor();
  await page.getByLabel("向科研助手提问").fill("从研究问题开始");
  await page.getByLabel("向科研助手提问").press("Enter");
  await page.getByRole("heading", { name: "先记住这一个问题" }).waitFor();

  await page.locator("input[type=file]").setInputFiles({
    name: "preview-paper.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% Local upload UI fixture\n"),
  });
  await page.locator(".rp-attachment").getByText("preview-paper.pdf").waitFor();
  await page.locator(".rp-attachment").getByRole("button").first().click();
  await page.getByText("本地 PDF 预览 · 示例解读仍对应 Xu 2018").waitFor();
  assert.ok(
    (
      await page.locator(".rp-pdf-preview iframe").getAttribute("src")
    )?.startsWith("blob:"),
  );
  await page.getByRole("button", { name: "关闭 PDF 预览" }).click();
  await page.getByRole("button", { name: "移除上传论文" }).click();
  assert.equal(await page.locator(".rp-attachment").count(), 0);
  await page
    .getByRole("status")
    .getByText("PDF 已添加，可点击文件名预览")
    .waitFor({ state: "hidden" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "关闭成果面板" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".rp-sidebar")!.getBoundingClientRect().right <= 1,
  );
  await page.evaluate(() =>
    localStorage.removeItem("reading-prototype-notes-v1"),
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "runs/prototype/mobile-chat.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "打开任务导航" }).click();
  await page.getByRole("button", { name: "读懂研究问题", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".rp-sidebar")!.getBoundingClientRect().right <= 1,
  );
  await page.getByRole("button", { name: "打开成果面板" }).click();
  await page.getByRole("tab", { name: "论文解读" }).click();
  await page.screenshot({
    path: "runs/prototype/mobile-reading.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 820, height: 1000 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page
    .getByRole("heading", { name: "读懂研究问题", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("阅读成果面板").count(),
    0,
    "Mobile starts with the discussion visible",
  );
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByRole("button", { name: "舒适阅读", exact: false }).waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(
    apiCalls,
    [],
    "The prototype must not submit teaching/model requests",
  );
  await page.goto(baseUrl + "/prototype");
  await page
    .getByRole("heading", { name: "读懂研究问题", exact: true })
    .waitFor();
  await page.route("**/api/**", (route) =>
    route.request().method() === "GET"
      ? route.continue()
      : route.fulfill({ contentType: "application/json", body: "{}" }),
  );
  await page.goto(baseUrl + "/assistant");
  await page.getByRole("button", { name: "打开示例论文" }).waitFor();
  console.log(
    "Prototype browser checks passed: task switching, guided questions, source links, persisted notes, export, keyboard navigation, PDF attachment, responsive layout; zero API calls.",
  );
} finally {
  await browser.close();
}
