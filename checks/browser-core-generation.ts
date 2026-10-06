import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4328";
const folder = "runs/core-generation/browser";
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const report = { status: "running", modelCalls: 0, assertions: [] as string[] };
async function post(path: string, data: unknown) {
  const r = await page.request.post(base + path, { data });
  assert.ok(r.ok(), await r.text());
  return r.json();
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
  let versions = [seed],
    message: any,
    speechBody: any;
  let turns: any[] = [],
    speechCancel = false,
    cancelGeneration = false;
  const speechText =
    "# 开场\n介绍研究问题。\n\n# 第 1 页\n解释问题与依据。\n\n# 转场\n接下来讨论方法。\n\n# 结尾\n谢谢，欢迎讨论。";
  await page.route("**/api/deck-versions?*", (route) =>
    route.fulfill({ json: versions }),
  );
  await page.route("**/api/deck-versions/*/select", (route) =>
    route.fulfill({
      json: { ...chat, latestDeckVersionId: versions.at(-1).id },
    }),
  );
  await page.route("**/api/conversations/*/turns", (route) =>
    route.fulfill({ json: turns }),
  );
  await page.route("**/api/conversations/*/messages", (route) => {
    message = route.request().postDataJSON();
    if (cancelGeneration) {
      const turn = {
        id: "queued-ppt-fixture",
        conversationId: chat.id,
        status: "queued",
        message,
        budget: { attempts: [] },
        createdAt: new Date().toISOString(),
      };
      turns = [turn];
      return route.fulfill({ json: turn });
    }
    return route.fulfill({
      json: {
        id: "fixture-ppt-message",
        conversationId: chat.id,
        status: "completed",
        message,
        budget: { attempts: [] },
        reply: {
          content: null,
          artifacts: [],
          pendingQuestions: [],
          nextStep: "",
        },
      },
    });
  });
  await page.route("**/api/deck-versions/*/speech", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    speechBody = route.request().postDataJSON();
    const parent = versions.at(-1);
    const child = {
      ...parent,
      id: `fixture-speech-${versions.length}`,
      parentId: parent.id,
      operation: "speech",
      createdAt: new Date().toISOString(),
      status: "queued",
      outline: {
        ...parent.outline,
        speechScript: speechBody.speechScript ?? speechText,
      },
    };
    versions = [...versions, child];
    if (!speechCancel)
      setTimeout(() => {
        versions = versions.map((v) =>
          v.id === child.id ? { ...v, status: "completed" } : v,
        );
      }, 250);
    return route.fulfill({ json: child });
  });
  await page.route("**/api/deck-versions/*/cancel", (route) => {
    const id = route.request().url().split("/").at(-2);
    versions = versions.map((version) =>
      version.id === id ? { ...version, status: "cancelled" } : version,
    );
    return route.fulfill({
      json: {
        ok: true,
        version: versions.find((version) => version.id === id),
      },
    });
  });
  await page.route("**/api/turns/*/cancel", (route) => {
    const turn = { ...turns[0], status: "cancelled" };
    turns = [turn];
    return route.fulfill({ json: { ok: true, turn } });
  });
  await page.route("**/api/deck-versions/*/speech?*", (route) =>
    route.fulfill({
      contentType: "text/markdown",
      body: versions.at(-1).outline.speechScript,
    }),
  );
  await page.goto(base);
  assert.equal(await page.locator(".rw-main-nav > button").count(), 3);
  await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
  await page.getByLabel("第 1 页预览").waitFor();
  await page.getByText("生成新汇报", { exact: true }).click();
  assert.equal(
    await page.getByLabel("汇报重点", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: "同时生成完整演讲稿", exact: true })
      .isChecked(),
    false,
  );
  await page
    .getByRole("checkbox", { name: "同时生成完整演讲稿", exact: true })
    .check();
  await page.getByRole("button", { name: "生成汇报", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>(".rw-ppt-generate .rp-primary")
        ?.disabled,
  );
  assert.equal(message.speechScript, true);
  assert.equal(message.module, "ppt");
  assert.ok(message.question.includes("结构与研究类型匹配"));
  assert.equal(message.question.includes("实验设计"), false);
  await page
    .getByRole("checkbox", { name: "同时生成完整演讲稿", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "生成汇报", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>(".rw-ppt-generate .rp-primary")
        ?.disabled,
  );
  assert.equal(message.speechScript, false);
  report.assertions.push(
    "三个核心入口保持原有布局；汇报要求为空可直接生成，完整稿显式可选，通用提示不预设实验论文",
  );
  await page.getByText("完整演讲稿", { exact: true }).click();
  await page.getByRole("button", { name: "补写演讲稿", exact: true }).click();
  await page
    .getByLabel("完整演讲稿正文", { exact: true })
    .waitFor({ state: "attached" });
  // The saved report changed, so reopen the existing disclosure in the newly mounted preview.
  if (!(await page.getByLabel("完整演讲稿正文", { exact: true }).isVisible()))
    await page.getByText("完整演讲稿", { exact: true }).click();
  assert.equal(speechBody.conversationId, chat.id);
  assert.equal(
    await page.getByLabel("完整演讲稿正文", { exact: true }).inputValue(),
    speechText,
  );
  const edited = speechText + "\n用户修改的结尾。";
  await page.getByLabel("完整演讲稿正文", { exact: true }).fill(edited);
  await page.reload();
  await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
  await page.getByLabel("第 1 页预览").waitFor();
  await page.getByText("完整演讲稿", { exact: true }).click();
  assert.equal(
    await page.getByLabel("完整演讲稿正文", { exact: true }).inputValue(),
    edited,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "重新生成演讲稿", exact: true })
      .isEnabled(),
    false,
  );
  await page.getByRole("button", { name: "保存演讲稿", exact: true }).click();
  await page
    .locator('a[href*="/speech?"]')
    .first()
    .waitFor({ state: "attached" });
  await page.getByText("完整演讲稿", { exact: true }).click();
  assert.equal(speechBody.speechScript, edited);
  const url = await page
    .getByRole("link", { name: "导出演讲稿（Markdown）", exact: true })
    .getAttribute("href");
  assert.equal(
    await page.evaluate(async (href) => (await fetch(href!)).text(), url),
    edited,
  );
  report.assertions.push(
    "已有 PPT 补稿、编辑草稿刷新恢复、未保存时禁止覆盖、保存和独立下载路径可用；模型响应为固定夹具",
  );
  const txtUrl = await page
    .getByRole("link", { name: "导出演讲稿（TXT）", exact: true })
    .getAttribute("href");
  assert.ok(txtUrl?.includes("format=txt"));
  await page
    .getByLabel("完整演讲稿正文", { exact: true })
    .fill(edited + "\n不再保留的修改");
  await page
    .getByRole("button", { name: "放弃演讲稿修改", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("完整演讲稿正文", { exact: true }).inputValue(),
    edited,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "重新生成演讲稿", exact: true })
      .isEnabled(),
    true,
  );
  speechCancel = true;
  await page
    .getByRole("button", { name: "重新生成演讲稿", exact: true })
    .click();
  await page
    .getByRole("button", { name: "取消演讲稿任务", exact: true })
    .click();
  await page
    .getByRole("button", { name: "取消演讲稿任务", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(versions.at(-1).status, "cancelled");
  assert.equal(
    await page.getByLabel("完整演讲稿正文", { exact: true }).inputValue(),
    edited,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "重新生成演讲稿", exact: true })
      .isEnabled(),
    true,
  );
  cancelGeneration = true;
  await page.getByText("生成新汇报", { exact: true }).click();
  await page.getByRole("button", { name: "生成汇报", exact: true }).click();
  await page.getByRole("button", { name: "取消生成", exact: true }).click();
  await page
    .getByRole("button", { name: "取消生成", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(turns[0].status, "cancelled");
  assert.equal(
    await page
      .getByRole("button", { name: "生成汇报", exact: true })
      .isEnabled(),
    true,
  );
  report.assertions.push(
    "排队生成与演讲稿任务可取消；取消后原稿保留、生成按钮恢复；放弃改稿可解除未保存阻塞，TXT/Markdown 导出入口可达",
  );
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.waitForFunction(
      (value) => document.documentElement.dataset.researchTheme === value,
      theme,
    );
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1440, 1024, 768]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(
        await page
          .locator(".rw-slide h2")
          .evaluate((element) => getComputedStyle(element).color),
        "rgb(28, 28, 30)",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
      );
      await page.screenshot({ path: `${folder}/${theme}-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  report.assertions.push(
    "浅深色与 1440/1024/768 视口保持原有布局，无横向裁切和浏览器异常",
  );
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
