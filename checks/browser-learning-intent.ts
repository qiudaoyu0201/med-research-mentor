import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4326";
const folder = "runs/learning-intent";
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors: string[] = [],
  report = {
    status: "running",
    modelCalls: 0,
    assertions: [] as string[],
    screenshots: [] as string[],
  };
page.on("pageerror", (e) => errors.push(e.message));
try {
  const chatResponse = await page.request.post(
    base + "/api/papers/xu-2018/chat",
    { data: {} },
  );
  assert.ok(chatResponse.ok(), await chatResponse.text());
  const chat = await chatResponse.json();
  assert.ok(
    (
      await page.request.put(base + "/api/workspace/position", {
        data: { conversationId: chat.id, paperId: "xu-2018", panel: null },
      })
    ).ok(),
  );
  // The legacy API is kept so historical clients can migrate without rewriting private records.
  assert.ok(
    (
      await page.request.patch(
        base + `/api/conversations/${chat.id}/preferences`,
        { data: { explanationDepth: "foundations" } },
      )
    ).ok(),
  );
  await page.goto(base);
  const openSettings = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("学习重点", { exact: true }).waitFor();
  };
  await openSettings();
  assert.equal(
    await page.getByLabel("讲解程度", { exact: true }).inputValue(),
    "standard",
  );
  assert.equal(
    await page.getByLabel("学习重点", { exact: true }).inputValue(),
    "foundations",
  );
  assert.equal(
    await page
      .getByLabel("讲解程度", { exact: true })
      .locator("option")
      .count(),
    3,
  );
  assert.equal(
    await page
      .getByLabel("学习重点", { exact: true })
      .locator("option")
      .count(),
    5,
  );
  const choose = async (label: string, option: string) => {
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/preferences") && r.ok()),
      page.getByLabel(label, { exact: true }).selectOption(option),
    ]);
    await page.getByLabel(label, { exact: true }).waitFor({ state: "visible" });
  };
  await choose("讲解程度", "deep");
  await choose("学习重点", "research-reasoning");
  assert.equal(
    await page.getByLabel("讲解程度", { exact: true }).inputValue(),
    "deep",
  );
  const saved = await (
    await page.request.get(base + `/api/conversations/${chat.id}`)
  ).json();
  assert.deepEqual(saved.learningPreferences, {
    verbosity: "deep",
    focus: "research-reasoning",
  });
  assert.equal(saved.profileId, chat.profileId);
  report.assertions.push(
    "旧 foundations 迁移为常规＋补基础；两个选择独立保存且不重置学习背景",
  );
  await page.getByRole("button", { name: "关闭设置" }).click();
  const input = page.getByLabel("向科研助手提问");
  await input.fill("这段实验设计排除了什么解释？");
  await openSettings();
  await choose("学习重点", "methods-figures");
  await page.getByRole("button", { name: "关闭设置" }).click();
  assert.equal(await input.inputValue(), "这段实验设计排除了什么解释？");
  await page.reload();
  await openSettings();
  assert.equal(
    await page.getByLabel("讲解程度", { exact: true }).inputValue(),
    "deep",
  );
  assert.equal(
    await page.getByLabel("学习重点", { exact: true }).inputValue(),
    "methods-figures",
  );
  report.assertions.push("切换学习重点保留当前问题；刷新恢复两个有效设置");
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("外观", { exact: true }).selectOption(theme);
    for (const width of [1280, 1440, 1920]) {
      for (const zoom of [1, 1.25, 1.5]) {
        // Browser zoom reduces the CSS viewport; use equivalent viewport sizes.
        // This checks responsive layout, not native browser chrome or display scaling.
        const viewport = {
          width: Math.floor(width / zoom),
          height: Math.floor(960 / zoom),
        };
        await page.setViewportSize(viewport);
        for (const label of ["讲解程度", "学习重点", "关闭设置"]) {
          await page
            .getByLabel(label, { exact: true })
            .scrollIntoViewIfNeeded();
          const box = await page
            .getByLabel(label, { exact: true })
            .boundingBox();
          assert.ok(
            box &&
              box.x >= 0 &&
              box.y >= 0 &&
              box.x + box.width <= viewport.width + 1 &&
              box.y + box.height <= viewport.height + 1,
            `${width}/${zoom}/${theme}/${label}: ${JSON.stringify(box)}`,
          );
        }
        if (
          (width === 1440 && zoom === 1) ||
          (width === 1280 && zoom === 1.5)
        ) {
          const path = `${folder}/settings-${theme}-${width}-${zoom}.png`;
          await page.screenshot({ path });
          report.screenshots.push(path);
        }
      }
    }
  }
  report.assertions.push(
    "1280/1440/1920 窗口及 100/125/150% 等效 CSS 视口、浅深色下设置可访问；原生浏览器缩放另验",
  );
  assert.deepEqual(errors, []);
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
console.log(JSON.stringify(report, null, 2));
