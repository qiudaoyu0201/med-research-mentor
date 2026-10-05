import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
const base = process.env.TUTOR_BASE_URL || "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const report: any = {
  mode: "browser-records-engineering",
  modelCalls: 0,
  status: "running",
  assertions: [],
};
try {
  if (process.argv.includes("--restore-only")) {
    const prior = JSON.parse(
      await readFile("runs/browser-records.json", "utf8"),
    );
    await page.addInitScript(
      (id) => localStorage.setItem("tutor-conversation", id),
      prior.conversationId,
    );
    await page.goto(base);
    await page.getByRole("button", { name: "打开示例论文" }).click();
    await page.getByRole("button", { name: "设置与记录" }).click();
    await page
      .getByRole("heading", { name: "收藏解释", exact: true })
      .waitFor();
    await page
      .getByRole("heading", { name: "我的主动反馈", exact: true })
      .waitFor();
    const state = await (
      await page.request.get(
        base + `/api/conversations/${prior.conversationId}`,
      )
    ).json();
    assert.equal(state.learningRecords.length, 2);
    assert.equal(state.userProgress[0].state, "understood");
    report.conversationId = prior.conversationId;
    report.assertions.push(
      "server restart restores explicit records and prior delivered explanation",
    );
  } else {
    await page.goto(base);
    await page.getByRole("button", { name: "打开示例论文" }).click();
    await page.getByRole("button", { name: "论文带读", exact: true }).click();
    await page.getByRole("button", { name: "打开教学示例" }).click();
    await page
      .getByRole("heading", { name: "从一个问题，读懂一个实验" })
      .waitFor();
    await page
      .getByRole("button", { name: "收藏这段解释", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "主动标记已理解", exact: true })
      .click();
    await page.getByRole("button", { name: "设置与记录" }).click();
    const favorite = page
      .locator(".personal-record")
      .filter({
        has: page.getByRole("heading", { name: "收藏解释", exact: true }),
      });
    await favorite.waitFor();
    const original = await favorite.getByLabel("学习记录内容").inputValue();
    await favorite
      .getByLabel("学习记录内容")
      .fill("我的补充：相关不等于因果，继续看对照。");
    await favorite
      .getByRole("button", { name: "保存记录编辑", exact: true })
      .click();
    await favorite
      .getByRole("button", { name: "撤销记录编辑", exact: true })
      .waitFor();
    for (
      let i = 0;
      i < 30 &&
      !(await favorite
        .getByRole("button", { name: "撤销记录编辑", exact: true })
        .isEnabled());
      i++
    )
      await page.waitForTimeout(100);
    await favorite
      .getByRole("button", { name: "撤销记录编辑", exact: true })
      .click();
    await page.waitForFunction(
      (value) =>
        Array.from(document.querySelectorAll(".personal-record textarea")).some(
          (e) => (e as HTMLTextAreaElement).value === value,
        ),
      original,
    );
    await page
      .getByLabel("保存待解决问题")
      .fill("下次弄清这个实验的对照能排除什么。");
    await page
      .getByRole("button", { name: "保存我的问题", exact: true })
      .click();
    const question = page
      .locator(".personal-record")
      .filter({
        has: page.getByRole("heading", { name: "我的待解决问题", exact: true }),
      });
    await question.waitFor();
    await question
      .getByRole("button", { name: "删除记录", exact: true })
      .click();
    await question.waitFor({ state: "detached" });
    const id = await page.evaluate(() =>
      localStorage.getItem("tutor-conversation"),
    );
    report.conversationId = id;
    const state = await (
      await page.request.get(base + `/api/conversations/${id}`)
    ).json();
    assert.equal(state.learningRecords.length, 2);
    assert.equal(state.userProgress[0].state, "understood");
    assert.ok(
      state.learningRecords.every((r: any) => !r.text.includes("下次弄清")),
    );
    report.assertions.push(
      "favorite snapshot, explicit feedback, edit, undo and delete use actual local API",
    );
    await page
      .locator(".personal-records")
      .screenshot({ path: "runs/screenshots/learning-records.png" });
    await page.reload();
    await page.getByRole("button", { name: "打开示例论文" }).click();
    await page.getByRole("button", { name: "设置与记录" }).click();
    await page
      .getByRole("heading", { name: "收藏解释", exact: true })
      .waitFor();
    report.assertions.push("reload continues the same records");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  );
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  await writeFile(
    process.argv.includes("--restore-only")
      ? "runs/browser-records-restored.json"
      : "runs/browser-records.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
