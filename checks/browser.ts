import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const baseUrl = process.env.TUTOR_BASE_URL || "http://127.0.0.1:4317";
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }),
  errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("runs/screenshots", { recursive: true });
try {
  await page.goto(baseUrl + "/assistant");
  await page.getByRole("button", { name: "打开示例论文" }).waitFor();
  await page.screenshot({ path: "runs/screenshots/home.png", fullPage: true });
  await page.getByRole("button", { name: "打开示例论文" }).click();
  await page.getByRole("button", { name: "论文带读", exact: true }).click();
  await page.getByRole("button", { name: "打开教学示例" }).click();
  await page
    .getByRole("heading", { name: "从一个问题，读懂一个实验" })
    .waitFor();
  assert.ok(await page.getByLabel("向导师提问").isDisabled());
  await page.getByRole("button", { name: "↗ 移植实验与对照" }).first().click();
  await page
    .locator(".source-block.focused")
    .getByText("移植实验与对照", { exact: true })
    .waitFor();
  assert.ok(
    await page
      .locator(".source-block.focused")
      .innerText()
      .then((t) => t.includes("移植实验与对照")),
  );
  await page.screenshot({
    path: "runs/screenshots/reading.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "主动标记已理解" }).click();
  await page.waitForTimeout(700);
  await page.reload();
  await page.getByRole("button", { name: "打开示例论文" }).waitFor();
  const session = await page.request.get(baseUrl + "/api/session");
  assert.ok(
    (await session.json()).progress.some((p: any) => p.state === "understood"),
  );
  await page.getByRole("button", { name: "打开示例论文" }).click();
  await page.getByRole("button", { name: "方法讲解", exact: true }).click();
  await page.getByRole("button", { name: "流式细胞术", exact: true }).click();
  await page.getByRole("button", { name: "打开教学示例" }).click();
  await page
    .getByRole("heading", { name: "流式：把一群细胞拆成逐个信号" })
    .waitFor();
  await page.getByRole("button", { name: "图表解读", exact: true }).click();
  await page.getByRole("button", { name: "打开教学示例" }).click();
  await page
    .getByRole("heading", { name: "Figure 1：先认比较，再读含义" })
    .waitFor();
  await page.getByRole("button", { name: "汇报 PPT", exact: true }).click();
  await page.getByRole("button", { name: "生成 PPTX", exact: true }).click();
  await page.getByRole("link", { name: "下载汇报 PPTX" }).waitFor();
  await page.screenshot({ path: "runs/screenshots/deck.png", fullPage: true });
  const pdf = await import("node:fs/promises").then((fs) =>
    fs.readFile("runs/test.pdf"),
  );
  await page.locator("input[type=file]").setInputFiles({
    name: "teaching-test.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.getByRole("button", { name: "论文带读", exact: true }).click();
  await page.locator(".pdf-canvas canvas").waitFor();
  await page.waitForTimeout(1000);
  assert.ok(
    await page
      .locator(".pdf-canvas canvas")
      .evaluate((c: HTMLCanvasElement) => c.width > 0),
  );
  await page.screenshot({ path: "runs/screenshots/pdf.png", fullPage: true });
  const canvas = page.locator(".pdf-canvas canvas");
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + 140);
    await page.mouse.up();
    await page.getByAltText("手动圈选的论文图件").waitFor();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "runs/screenshots/mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 2,
    ),
  );
  assert.deepEqual(errors, []);
  const created = await page.request.post(baseUrl + "/api/conversations", {
    data: { paperId: "xu-2018" },
  });
  assert.ok(created.ok());
  const conversation = await created.json();
  const message = {
    clientMessageId: "browser-contract",
    mode: "example",
    module: "paper",
    question: "从研究问题开始",
    sourceIds: ["xu-question", "xu-design", "xu-fig1", "xu-fig6"],
  };
  const submitted = await page.request.post(
    baseUrl + `/api/conversations/${conversation.id}/messages`,
    { data: message },
  );
  assert.ok(submitted.ok());
  const turn = await submitted.json();
  await assert.doesNotReject(async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await page.request.get(
        baseUrl + `/api/turns/${turn.id}`,
      );
      const result = await response.json();
      if (result.status === "completed") {
        assert.equal(result.budget.attempts.length, 0);
        const restored = await (
          await page.request.get(
            baseUrl + `/api/conversations/${conversation.id}`,
          )
        ).json();
        assert.ok(restored.taughtConcepts.length);
        const feedback = await page.request.put(
          baseUrl + `/api/conversations/${conversation.id}/progress`,
          {
            data: {
              version: restored.version,
              unitId: result.runId,
              state: "confused",
            },
          },
        );
        assert.ok(feedback.ok());
        assert.equal((await feedback.json()).userProgress[0].state, "confused");
        return;
      }
      assert.notEqual(result.status, "failed", result.error);
      await page.waitForTimeout(100);
    }
    throw new Error("conversation API did not complete");
  });
  const duplicate = await page.request.post(
    baseUrl + `/api/conversations/${conversation.id}/messages`,
    { data: message },
  );
  assert.equal((await duplicate.json()).id, turn.id);
  console.log(
    "Browser checks passed: examples, source location, persistence, methods, PPTX, PDF/crop, mobile, conversation API/feedback/dedup.",
  );
} finally {
  await browser.close();
}
