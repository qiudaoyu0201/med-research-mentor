import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4334";
const folder = "runs/product-finish/browser-crop";
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const api = async (path: string, data: unknown) => {
  const r = await page.request.post(base + path, { data });
  assert.ok(r.ok(), await r.text());
  return r.json();
};
try {
  const paper = (
    await page.request.get(base + "/api/workspace").then((r) => r.json())
  ).papers.find((p: any) => p.id === "xu-2018");
  const figure = paper.sources.find((s: any) => s.imageRegion);
  assert.ok(figure);
  const chat = await api("/api/conversations", { paperId: paper.id });
  const seed = await api("/api/deck-versions", {
    paperId: paper.id,
    conversationId: chat.id,
  });
  let versions = [seed],
    saved: any,
    message: any;
  await page.request.put(base + "/api/workspace/position", {
    data: { paperId: paper.id, conversationId: chat.id, panel: null },
  });
  await page.route("**/api/deck-versions?*", (r) =>
    r.fulfill({ json: versions }),
  );
  await page.route("**/api/deck-versions/*/edit", (r) => {
    saved = r.request().postDataJSON();
    const v = {
      ...seed,
      id: "crop-fixture",
      status: "failed",
      error: "Engineering fixture: revise this draft",
      parentId: seed.id,
      slideIndex: 0,
      outline: {
        slides: seed.outline.slides.map((s: any, i: number) =>
          i === 0 ? saved.slide : s,
        ),
      },
    };
    versions = [seed, v];
    return r.fulfill({ json: v });
  });
  await page.route("**/api/deck-versions/*/select", (r) =>
    r.fulfill({ json: { ...chat, latestDeckVersionId: versions.at(-1).id } }),
  );
  await page.route("**/api/conversations/*/messages", (r) => {
    message = r.request().postDataJSON();
    return r.fulfill({
      json: {
        id: "crop-generate-fixture",
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
  await page.goto(base);
  await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
  await page.getByLabel("第 1 页预览").waitFor();
  await page.getByText("生成新汇报", { exact: true }).click();
  await page.getByRole("button", { name: "生成汇报", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>(".rw-ppt-generate .rp-primary")
        ?.disabled,
  );
  assert.ok(message.sourceIds.includes(figure.id));
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  await page.getByText("配图与裁剪", { exact: true }).click();
  await page.getByLabel("幻灯片配图").selectOption(figure.id);
  const surface = page.locator(".rw-image-crop-surface");
  await surface.locator("img").evaluate((e: HTMLImageElement) => e.decode());
  await surface.scrollIntoViewIfNeeded();
  const b = (await surface.boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.1, b.y + b.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.9, {
    steps: 8,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "恢复完整图", exact: true }).waitFor();
  const preview = page.locator(".rw-slide-canvas");
  assert.ok(await preview.locator("image").count());
  const size = await preview.evaluate((e) => {
    const b = e.getBoundingClientRect();
    return b.width / b.height;
  });
  assert.ok(Math.abs(size - 16 / 9) < 0.01);
  await page.reload();
  await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
  await page.getByLabel("第 1 页预览").waitFor();
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  assert.equal(await page.getByLabel("幻灯片配图").inputValue(), figure.id);
  await page.getByText("配图与裁剪", { exact: true }).click();
  await page.getByRole("button", { name: "恢复完整图", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "保存指定页并核对", exact: true })
    .click();
  await page
    .getByLabel("保存版本", { exact: true })
    .selectOption("crop-fixture");
  await page
    .getByText("Engineering fixture: revise this draft", { exact: true })
    .waitFor({ state: "attached" });
  assert.equal(saved.slide.imageSource, figure.id);
  assert.ok(
    saved.slide.imageCrop.width > 0.69 && saved.slide.imageCrop.width < 0.71,
  );
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  assert.ok(
    await page
      .getByRole("button", { name: "保存指定页并核对", exact: true })
      .isEnabled(),
  );
  await page.screenshot({ path: folder + "/crop-draft.png" });
  assert.deepEqual(errors, []);
  await writeFile(
    folder + "/report.json",
    JSON.stringify(
      {
        status: "passed",
        modelCalls: 0,
        assertions: [
          "普通图件进入生成请求",
          "16:9 原页配图可换可裁",
          "裁剪草稿刷新保留",
          "失败稿可以再次保存核对",
        ],
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: folder + "/failed.png" });
  throw error;
} finally {
  await browser.close();
}
