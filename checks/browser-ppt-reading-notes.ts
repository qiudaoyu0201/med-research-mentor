import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4330";
const folder = "runs/ppt-reading-notes/browser";
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const report = { status: "running", modelCalls: 0, assertions: [] as string[] };
async function post(path: string, data: unknown) {
  const result = await page.request.post(base + path, { data });
  assert.ok(result.ok(), await result.text());
  return result.json();
}
try {
  const chat = await post("/api/conversations", { paperId: "xu-2018" });
  const seed = await post("/api/deck-versions", {
    conversationId: chat.id,
    paperId: "xu-2018",
  });
  const position = await page.request.put(base + "/api/workspace/position", {
    data: { conversationId: chat.id, paperId: "xu-2018", panel: null },
  });
  assert.ok(position.ok());
  await page.addInitScript(() => {
    if (!localStorage.getItem("research-font-version"))
      localStorage.setItem("research-font", "source-han");
  });
  await page.goto(base);
  await page.waitForFunction(
    () => document.documentElement.dataset.researchFont === "system",
  );
  await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
  await page.getByLabel("第 1 页预览").waitFor();
  await page
    .locator(".rw-slide-list > .rw-object > button:first-child")
    .nth(2)
    .click();
  await page.getByLabel("第 3 页预览").waitFor();
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  await page.getByLabel("幻灯片标题").fill("未保存的第3页");
  await page.getByText("完整演讲稿", { exact: true }).click();
  await page.locator(".rw-ppt-preview").evaluate((element) => {
    (element as HTMLElement).dataset.qaMarker = "kept";
  });
  const source = page.locator(".rw-ppt-preview .rw-citation-chip").first();
  await source.click();
  const modal = page.getByRole("dialog", { name: "PPT 来源与笔记" });
  await modal.waitFor();
  await modal
    .getByText("正在显示 PDF…", { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    await page
      .getByRole("button", {
        name: "PPT 汇报",
        exact: true,
        includeHidden: true,
      })
      .getAttribute("aria-current"),
    "page",
  );
  await modal
    .getByRole("button", { name: "返回 PPT 汇报", exact: true })
    .click();
  await modal.waitFor({ state: "hidden" });
  assert.equal(
    await page.getByLabel("幻灯片标题").inputValue(),
    "未保存的第3页",
  );
  assert.equal(
    await page.locator(".rw-ppt-preview").getAttribute("data-qa-marker"),
    "kept",
  );
  assert.equal(
    await page
      .locator(".rw-ppt-preview > details")
      .filter({ has: page.getByText("完整演讲稿", { exact: true }) })
      .getAttribute("open"),
    "",
  );
  await source.click();
  await modal.waitFor();
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  await page.getByLabel("第 3 页预览").waitFor();
  report.assertions.push(
    "PPT 来源原位打开，返回按钮与 Escape 均回到原页；编辑草稿、展开状态及预览节点保留",
  );

  await page.getByRole("button", { name: "资料", exact: true }).click();
  await modal.getByRole("tab", { name: "我的笔记", exact: true }).click();
  await modal.getByRole("button", { name: "新建笔记", exact: true }).click();
  const noteTitle = `手写记录-${Date.now()}`;
  await modal.getByLabel("新笔记标题").fill(noteTitle);
  const body = "直接打字记录的想法。\n下一步整理研究问题。";
  await modal.getByLabel("新笔记正文").fill(body);
  await modal
    .getByRole("button", { name: "返回 PPT 汇报", exact: true })
    .click();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await modal.getByRole("tab", { name: "我的笔记", exact: true }).click();
  assert.equal(await modal.getByLabel("新笔记正文").inputValue(), body);
  const saving = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/workspace/notes/manual") && response.ok(),
  );
  await modal.getByRole("button", { name: "保存新笔记", exact: true }).click();
  const note = await (await saving).json();
  assert.equal(note.turnId, undefined);
  assert.deepEqual(note.anchors, []);
  assert.equal(note.text, body);
  await modal.getByLabel(`笔记正文 ${noteTitle}`).waitFor();
  await modal
    .getByLabel(`笔记正文 ${noteTitle}`)
    .fill(body + "\n保存后的补充。");
  const edited = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/workspace/notes/${note.id}`) &&
      response.request().method() === "PATCH" &&
      response.ok(),
  );
  await modal
    .locator(".rw-note")
    .filter({ has: page.getByLabel(`笔记正文 ${noteTitle}`) })
    .getByRole("button", { name: "保存修改", exact: true })
    .click();
  await edited;
  const download = page.waitForEvent("download");
  await modal
    .getByRole("button", { name: "导出 Markdown", exact: true })
    .click();
  const output = await download;
  await output.saveAs(`${folder}/typed-note.md`);
  assert.ok(
    (await readFile(`${folder}/typed-note.md`, "utf8")).includes(
      "保存后的补充。",
    ),
  );
  await page.reload();
  await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await modal.getByRole("tab", { name: "我的笔记", exact: true }).click();
  assert.equal(
    await modal.getByLabel(`笔记正文 ${noteTitle}`).inputValue(),
    body + "\n保存后的补充。",
  );
  assert.equal(
    await page.request
      .post(base + "/api/workspace/notes/manual", {
        data: {
          id: note.id,
          conversationId: chat.id,
          title: note.title,
          text: note.text,
        },
      })
      .then((response) => response.status()),
    400,
  );
  await modal
    .getByRole("button", { name: "返回 PPT 汇报", exact: true })
    .click();
  report.assertions.push(
    "手写笔记无需回答即可新建；关闭时草稿保留，真实 API 保存、后续编辑、刷新恢复及 Markdown 导出可用",
  );

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.waitForFunction(
      (value) => document.documentElement.dataset.researchTheme === value,
      theme,
    );
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => document.fonts.ready);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
      );
      const style = await page
        .locator(".rw-ppt-preview > details")
        .first()
        .evaluate((element) => ({
          border: getComputedStyle(element).borderTopWidth,
          radius: getComputedStyle(element).borderRadius,
          font: getComputedStyle(element).fontFamily,
        }));
      assert.equal(style.border, "1px");
      assert.equal(style.radius, "13px");
      assert.equal(style.font.includes("Research Sans"), false);
      await page.screenshot({ path: `${folder}/${theme}-${width}.png` });
      await page.getByRole("button", { name: "资料", exact: true }).click();
      await modal.waitFor();
      await modal
        .getByText("正在显示 PDF…", { exact: true })
        .waitFor({ state: "hidden" });
      const bounds = await modal.boundingBox();
      assert.ok(
        bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
      );
      await page.screenshot({
        path: `${folder}/${theme}-${width}-sources.png`,
      });
      await modal
        .getByRole("button", { name: "返回 PPT 汇报", exact: true })
        .click();
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("阅读字体", { exact: true }).selectOption("source-han");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.reload();
  await page.waitForFunction(
    () => document.documentElement.dataset.researchFont === "source-han",
  );
  report.assertions.push(
    "旧默认字体迁移为系统无衬线，用户重新选字体仍会保存；浅深色与 1440/1024/768/390 视口的卡片和来源浮层无横向裁切",
  );
  assert.deepEqual(errors, []);
  assert.equal(seed.outline.slides.length, 8);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  throw error;
} finally {
  await writeFile(
    `${folder}/report.json`,
    JSON.stringify({ ...report, errors }, null, 2),
  );
  await browser.close();
}
