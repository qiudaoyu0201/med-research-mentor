import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4335";
const folder = "runs/short-loop-browser";
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const report = {
  status: "running",
  modelCalls: 0,
  readableMs: null as number | null,
  assertions: [] as string[],
};
try {
  const response = await page.request.post(base + "/api/papers/xu-2018/chat", {
    data: {},
  });
  assert.ok(response.ok());
  const chat = await response.json();
  const position = await page.request.put(base + "/api/workspace/position", {
    data: { conversationId: chat.id, paperId: "xu-2018", panel: null },
  });
  assert.ok(position.ok());
  let turn: any,
    released = false;
  await page.route(
    `**/api/conversations/${chat.id}/messages`,
    async (route) => {
      const message = route.request().postDataJSON();
      turn = {
        id: "short-loop-readable",
        conversationId: chat.id,
        createdAt: new Date().toISOString(),
        status: "running",
        message,
        budget: { attempts: [] },
        reply: null,
      };
      await route.fulfill({ json: turn });
    },
  );
  await page.route(`**/api/conversations/${chat.id}/turns`, (route) =>
    route.fulfill({ json: turn ? [turn] : [] }),
  );
  await page.goto(base);
  await page
    .getByRole("heading", { name: "从这篇论文的一个问题开始", exact: true })
    .waitFor();
  await page
    .getByLabel("向科研助手提问", { exact: true })
    .fill("为什么要设置对照？");
  await page.getByRole("button", { name: "发送 ↑", exact: true }).click();
  await page.locator('[data-turn-id="short-loop-readable"]').waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        performance
          .getEntriesByType("measure")
          .filter((e) => e.name.startsWith("tutor:readable:")).length,
    ),
    0,
  );
  assert.equal(await page.locator(".rw-answer .rw-selectable").count(), 0);
  report.assertions.push("运行状态和内部响应不计作可读回答，也不展示原始 JSON");
  turn = {
    ...turn,
    status: "completed",
    reply: {
      content: {
        title: "比较能说明什么",
        question: "为什么要设置对照？",
        sections: [
          {
            title: "对照的作用",
            text: "两组采用相同操作，比较才能减少操作本身对读数的影响。",
            kind: "interpretation",
            citations: [],
          },
        ],
        terms: [],
        nextQuestion: "",
      },
      artifacts: [],
      pendingQuestions: [],
      nextStep: "",
    },
  };
  released = true;
  await page
    .getByText("两组采用相同操作，比较才能减少操作本身对读数的影响。", {
      exact: true,
    })
    .waitFor();
  await page.waitForFunction(
    () =>
      performance.getEntriesByName("tutor:readable:short-loop-readable")
        .length === 1,
  );
  const measurement = await page.evaluate(() => {
    const entry = performance.getEntriesByName(
      "tutor:readable:short-loop-readable",
    )[0] as PerformanceMeasure;
    return { duration: entry.duration, detail: entry.detail };
  });
  assert.ok(measurement.duration > 0);
  assert.equal(measurement.detail.scope, "visible-validated-answer");
  report.readableMs = measurement.duration;
  report.assertions.push(
    "真实 DOM 完成绘制后记录用户可见响应，包含网络和轮询等待",
  );
  await page.screenshot({ path: `${folder}/readable-answer.png` });
  await page.reload();
  await page
    .getByText("两组采用相同操作，比较才能减少操作本身对读数的影响。", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        performance.getEntriesByName("tutor:readable:short-loop-readable")
          .length,
    ),
    0,
  );
  assert.equal(released, true);
  assert.deepEqual(errors, []);
  report.assertions.push("恢复历史答案不伪造一次新的响应测量");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  await page.screenshot({ path: `${folder}/failure.png` });
  throw error;
} finally {
  await writeFile(
    `${folder}/report.json`,
    JSON.stringify({ ...report, errors }, null, 2),
  );
  console.log(JSON.stringify(report));
  await browser.close();
}
