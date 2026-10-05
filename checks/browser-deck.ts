import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
const base = process.env.TUTOR_BASE_URL || "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const report: any = {
  mode: "browser-live-manual-review",
  productCallLimit: 4,
  aggregateCallLimit: 4,
  status: "running",
};
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await mkdir("runs/screenshots", { recursive: true });
try {
  if (process.argv.includes("--resume-mobile")) {
    const prior = JSON.parse(
      await readFile("runs/browser-deck-first-failure.json", "utf8"),
    );
    await page.addInitScript(
      (id) => localStorage.setItem("tutor-conversation", id),
      prior.version.conversationId,
    );
    await page.goto(base + "/assistant");
    await page.getByRole("button", { name: "打开示例论文" }).click();
    await page.getByRole("button", { name: "汇报 PPT", exact: true }).click();
    await page.getByText("当前版本：", { exact: false }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    );
    await page
      .locator(".deck-version-panel")
      .screenshot({ path: "runs/screenshots/deck-versions-mobile.png" });
    assert.deepEqual(errors, []);
    report.status = "passed";
    report.mode = "mobile-repair-no-new-calls";
    report.newModelCalls = 0;
    report.priorVersion = prior.version.id;
  } else {
    await page.goto(base + "/assistant");
    await page.getByRole("button", { name: "打开示例论文" }).click();
    await page.getByRole("button", { name: "汇报 PPT", exact: true }).click();
    const original = await page.getByLabel("第 2 页标题").inputValue();
    await page
      .getByLabel("第 2 页标题")
      .fill("研究问题：一起出现，还是有作用？");
    await page.getByLabel("指定修改页").selectOption("1");
    await page
      .getByRole("button", { name: "保存指定页并核对", exact: true })
      .click();
    await page
      .getByText("当前版本：", { exact: false })
      .waitFor({ timeout: 480000 });
    await page
      .getByRole("button", { name: "保存指定页并核对", exact: true })
      .waitFor();
    for (let count = 0; count < 480; count++) {
      const enabled = await page
        .getByRole("button", { name: "保存指定页并核对", exact: true })
        .isEnabled();
      if (enabled) break;
      await page.waitForTimeout(1000);
    }
    const id = await page.evaluate(() =>
      localStorage.getItem("tutor-conversation"),
    );
    assert.ok(id);
    const versions = await (
      await page.request.get(base + `/api/deck-versions?conversationId=${id}`)
    ).json();
    const changed = versions.find((v: any) => v.parentId);
    assert.ok(changed);
    report.version = changed;
    assert.equal(changed.status, "completed", changed.error);
    assert.ok(changed.budget.attempts.length <= 4);
    const parent = versions.find((v: any) => v.id === changed.parentId);
    assert.ok(parent);
    for (let i = 0; i < parent.outline.slides.length; i++)
      if (i !== 1)
        assert.deepEqual(changed.outline.slides[i], parent.outline.slides[i]);
    assert.equal(
      await page.getByLabel("第 2 页标题").inputValue(),
      "研究问题：一起出现，还是有作用？",
    );
    await page.getByRole("button", { name: "生成 PPTX", exact: true }).click();
    const link = page.getByRole("link", {
      name: "下载汇报 PPTX",
      exact: false,
    });
    await link.waitFor();
    const download = await page.request.get(
      base + (await link.getAttribute("href")),
    );
    assert.ok(download.ok());
    report.exportBytes = (await download.body()).length;
    await page.getByText("比较与恢复已有版本（2）", { exact: true }).click();
    await page
      .getByRole("button", { name: "恢复此版本", exact: true })
      .first()
      .click();
    await page.waitForFunction(
      (title) =>
        (
          document.querySelector(
            '[aria-label="第 2 页标题"]',
          ) as HTMLInputElement
        )?.value === title,
      original,
    );
    await page
      .locator(".deck-version-panel")
      .screenshot({ path: "runs/screenshots/deck-versions.png" });
    await page.reload();
    await page.getByRole("button", { name: "打开示例论文" }).click();
    await page.getByRole("button", { name: "汇报 PPT", exact: true }).click();
    assert.equal(await page.getByLabel("第 2 页标题").inputValue(), original);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    );
    assert.deepEqual(errors, []);
    report.status = "passed";
  }
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  await writeFile("runs/browser-deck.json", JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(
  JSON.stringify(
    {
      status: report.status,
      calls: report.version?.budget.attempts.length ?? 0,
      exportBytes: report.exportBytes,
    },
    null,
    2,
  ),
);
