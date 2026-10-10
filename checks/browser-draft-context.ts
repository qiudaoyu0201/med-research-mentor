import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";

const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4335";
const folder = "runs/completion-audit-20261007/browser-draft-context";
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const report = { status: "running", modelCalls: 0, assertions: [] as string[] };
const ready = (tab: Page) =>
  tab.waitForFunction(
    () =>
      document.querySelector<HTMLButtonElement>(".rp-new-task")?.disabled ===
      false,
  );
const post = async (path: string, data: unknown) => {
  const r = await page.request.post(base + path, { data });
  assert.ok(r.ok(), await r.text());
  return r.json();
};
try {
  const project = await post("/api/projects", {
    name: `草稿课题-${randomUUID()}`,
  });
  const chat = await post("/api/papers/xu-2018/chat", {});
  const paper = (
    await page.request.get(base + "/api/workspace").then((r) => r.json())
  ).papers.find((p: any) => p.id === "xu-2018");
  await page.request.put(base + "/api/workspace/position", {
    data: { paperId: paper.id, conversationId: chat.id, panel: null },
  });
  await page.goto(base);
  await ready(page);
  const other = await context.newPage();
  other.on("pageerror", (e) => errors.push(e.message));
  for (const group of ["未分组论文", project.name]) {
    await page.bringToFront();
    await page
      .getByRole("button", { name: `课题操作 ${group}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: "讨论方向", exact: true }).click();
    await page.waitForFunction(
      () => sessionStorage.getItem("research-new-discussion") !== null,
    );
    const text = `${group}：尚未发送的想法应留在这个标签页。`;
    await page.getByLabel("向科研助手提问", { exact: true }).fill(text);
    await other.bringToFront();
    await other.goto(base);
    await ready(other);
    await Promise.all([
      other.waitForResponse(
        (r) => r.url().endsWith("/api/workspace/position") && r.ok(),
      ),
      other.getByRole("button", { name: paper.title, exact: true }).click(),
    ]);
    await page.bringToFront();
    await page.reload();
    await ready(page);
    await page.waitForFunction(
      (value) =>
        document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="向科研助手提问"]',
        )?.value === value,
      text,
    );
    const pending = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("research-new-discussion")!),
    );
    assert.equal(pending.paperId, null);
    assert.equal(pending.projectId, group === project.name ? project.id : null);
    report.assertions.push(
      `${group}：另一标签页打开论文后仍恢复未发送草稿及其课题`,
    );
  }
  const ungrouped = page.locator(".rw-project").filter({
    has: page.getByText("未分组论文", { exact: true }),
  });
  if ((await ungrouped.getAttribute("open")) === null)
    await ungrouped.locator("summary").click();
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/api/workspace/position") && r.ok(),
    ),
    page.getByRole("button", { name: paper.title, exact: true }).click(),
  ]);
  await page.waitForFunction(
    () => sessionStorage.getItem("research-new-discussion") === null,
  );
  await page.reload();
  await ready(page);
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem("research-new-discussion"),
    ),
    null,
  );
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("research-current-chat")),
    chat.id,
  );
  report.assertions.push("转入已保存聊天后清除新讨论上下文，刷新继续当前聊天");
  assert.deepEqual(errors, []);
  report.status = "passed";
  await page.screenshot({ path: `${folder}/completed.png` });
} catch (error) {
  report.status = "failed";
  await page.screenshot({ path: `${folder}/failed.png` });
  throw error;
} finally {
  await writeFile(
    `${folder}/report.json`,
    JSON.stringify({ ...report, errors }, null, 2),
  );
  console.log(JSON.stringify(report));
  await browser.close();
}
