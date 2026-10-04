import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const base = process.env.TUTOR_BASE_URL || "http://127.0.0.1:4317";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const report: any = {
  mode: "browser-engineering",
  modelCalls: 0,
  assertions: [],
  status: "running",
};
await mkdir("runs/screenshots", { recursive: true });
try {
  await page.goto(base);
  await page.getByRole("button", { name: "打开示例论文" }).click();
  await page.getByRole("button", { name: "图表解读", exact: true }).click();
  await page.getByRole("button", { name: "打开教学示例" }).click();
  await page
    .getByRole("heading", { name: "Figure 1：先认比较，再读含义" })
    .waitFor();
  await page.getByRole("button", { name: "针对这句话追问" }).first().click();
  await page.getByText("围绕这句话：", { exact: false }).waitFor();
  const id = await page.evaluate(() =>
    localStorage.getItem("tutor-conversation"),
  );
  assert.ok(id);
  await page.reload();
  await page.getByRole("button", { name: "打开示例论文" }).click();
  await page
    .getByRole("button", {
      name: "查看讲解：Figure 1：先认比较，再读含义",
      exact: true,
    })
    .click();
  await page
    .getByRole("heading", { name: "Figure 1：先认比较，再读含义" })
    .waitFor();
  report.assertions.push(
    "same conversation and delivered figure survive reload",
  );
  const citation = page.locator(".citations button").first();
  await citation.click();
  await page.locator(".source-block.focused").waitFor();
  const source = await page.locator(".source-block.focused").innerText();
  assert.ok(source.length > 50);
  report.assertions.push("citation opens actual source and page");
  await page.getByRole("button", { name: "设置与记录" }).click();
  await page.getByLabel("运行模式").selectOption("live");
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await page.getByRole("button", { name: "针对这句话追问" }).first().click();
  await page.getByLabel("讲解深度").selectOption("brief");
  await page.getByLabel("统一对话问题").fill("这句话换个通俗说法");
  let payload: any;
  let stopped = false;
  let reads = 0;
  const prior = await (
    await page.request.get(base + `/api/conversations/${id}/turns`)
  ).json();
  const run = prior.at(-1).run;
  const fixture = {
    id: "browser-fixture",
    conversationId: id,
    createdAt: new Date().toISOString(),
    status: "planning",
    message: {},
    budget: { attempts: [] },
    runId: run.id,
  };
  await page.route(`**/api/conversations/${id}/messages`, async (route) => {
    payload = route.request().postDataJSON();
    fixture.message = payload;
    await route.fulfill({ json: fixture });
  });
  await page.route("**/api/turns/browser-fixture", async (route) => {
    reads++;
    await route.fulfill({
      json: {
        ...fixture,
        status: stopped ? "cancelled" : reads > 1 ? "running" : "planning",
        ...(stopped ? { error: "已停止，草稿保留" } : {}),
        run: {
          ...run,
          status: stopped ? "cancelled" : "teaching",
          result: undefined,
          draft: run.result,
        },
      },
    });
  });
  await page.route("**/api/turns/browser-fixture/cancel", async (route) => {
    stopped = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByRole("button", { name: "发送对话", exact: true }).click();
  await page.getByRole("button", { name: "停止本轮", exact: true }).waitFor();
  assert.equal(payload.depth, "brief");
  assert.equal(payload.focus.runId, run.id);
  assert.ok(run.result.sections[0].text.includes(payload.focus.excerpt));
  report.assertions.push(
    "focused sentence and requested depth reach the conversation API",
  );
  await page.getByRole("button", { name: "停止本轮", exact: true }).click();
  await page
    .getByText("查看已保存草稿（尚未核对，不可导出）", { exact: true })
    .waitFor();
  await page
    .getByText("查看已保存草稿（尚未核对，不可导出）", { exact: true })
    .click();
  report.assertions.push(
    "cancel shows retained unverified draft; browser fixtures do not claim model behavior",
  );
  await page
    .locator(".conversation-panel")
    .screenshot({ path: "runs/screenshots/conversation.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  );
  await page
    .locator(".conversation-panel")
    .screenshot({ path: "runs/screenshots/conversation-mobile.png" });
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  await writeFile(
    "runs/browser-workflow.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
