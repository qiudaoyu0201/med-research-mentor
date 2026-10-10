import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import type { ConversationState, DeckVersion } from "../shared/types.ts";
import type { WorkspaceBootstrap } from "../shared/workspace.ts";
import { sample } from "../examples/bundle.ts";

const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4334";
const folder = "runs/workflow-v16/browser";
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(12000);
const errors: string[] = [],
  blocked: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const report = { status: "running", modelCalls: 0, assertions: [] as string[] };
async function post<T>(path: string, data: unknown): Promise<T> {
  const response = await page.request.post(base + path, { data });
  assert.ok(response.ok(), await response.text());
  return response.json();
}
async function speechDetails() {
  const details = page.locator(".rw-ppt-preview > details").filter({
    has: page.getByText("完整演讲稿", { exact: true }),
  });
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
}
async function importFixtures(chat: ConversationState) {
  const response = await page.request.get(base + "/api/workspace");
  assert.ok(response.ok());
  const bootstrap: WorkspaceBootstrap = await response.json();
  for (const scenario of ["reading", "explicit", "late"] as const) {
    const explicit = scenario === "explicit",
      late = scenario === "late";
    const imported = await browser.newPage({
      viewport: { width: 1440, height: 960 },
    });
    imported.setDefaultTimeout(12000);
    imported.on("pageerror", (error) => errors.push(error.message));
    const receiptIds: string[] = [],
      startReceipts: string[] = [];
    const receipts = new Set<string>(),
      dispatched = new Set<string>();
    let dropResponse = scenario === "reading",
      chatCalls = 0,
      deliveries: unknown[] = [];
    let releaseChat!: () => void, chatWaiting!: () => void;
    const chatHeld = new Promise<void>((resolve) => {
      chatWaiting = resolve;
    });
    const chatReleased = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });
    const state = () => ({
      ...chat,
      id: "import-fixture-chat",
      recentTurnIds: deliveries.length ? ["import-first-turn"] : [],
    });
    const snapshot = () => ({
      ...bootstrap,
      papers: [sample],
      conversations: [state()],
      index: {
        ...bootstrap.index,
        lastConversationId: state().id,
        positions: [],
        papers: bootstrap.index.papers.filter((p) => p.paperId === sample.id),
      },
    });
    await imported.route("**/api/**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path === "/api/papers" && request.method() === "POST") {
        const receipt = request.headers()["x-import-id"];
        assert.ok(receipt);
        receiptIds.push(receipt);
        receipts.add(receipt);
        if (dropResponse) {
          dropResponse = false;
          await route.abort("failed");
          return;
        }
        await route.fulfill({ json: { paper: sample } });
        return;
      }
      if (path.endsWith("/reading-start") && request.method() === "POST") {
        const body = request.postDataJSON();
        assert.ok(receipts.has(body.importId));
        assert.equal(body.conversationId, state().id);
        startReceipts.push(body.importId);
        if (dispatched.has(body.importId)) {
          await route.fulfill({ json: { turn: deliveries[0] } });
          return;
        }
        if (deliveries.length) {
          await route.fulfill({
            json: { turn: null, reason: "已有讨论，不自动重复起步" },
          });
          return;
        }
        dispatched.add(body.importId);
        const turn = {
          id: "import-first-turn",
          conversationId: state().id,
          status: "completed",
          createdAt: new Date().toISOString(),
          budget: { attempts: [] },
          message: {
            question:
              "请用中文带我读这篇论文，从研究问题和第一个原文单元开始。",
            module: "explain",
          },
          reply: {
            content: {
              title: "中文带读首轮（夹具）",
              sections: [
                {
                  title: "研究问题",
                  text: "先讲研究目的和第一个阅读单元。",
                  citations: [],
                },
              ],
              terms: [],
            },
            pendingQuestions: [],
            artifacts: [],
            nextStep: "继续读研究方法。",
          },
        };
        deliveries = [turn];
        await route.fulfill({ json: { turn } });
        return;
      }
      if (
        request.method() === "POST" &&
        /\/(messages|speech|edit|start|jobs)$/.test(path)
      ) {
        blocked.push(path);
        await route.fulfill({
          status: 409,
          json: { error: "导入夹具拒绝其他模型请求" },
        });
        return;
      }
      if (path === "/api/workspace") {
        await route.fulfill({ json: snapshot() });
        return;
      }
      if (
        path === `/api/papers/${sample.id}/chat` ||
        path === `/api/conversations/${state().id}`
      ) {
        if (path.endsWith("/chat") && late && ++chatCalls === 2) {
          chatWaiting();
          await chatReleased;
        }
        await route.fulfill({ json: state() });
        return;
      }
      if (path.endsWith("/turns")) {
        await route.fulfill({ json: deliveries });
        return;
      }
      if (path === `/api/papers/${sample.id}/start`) {
        await route.fulfill({
          json: {
            paperId: sample.id,
            questions: [],
            excerpt: "原文可读",
            autoGenerate: true,
          },
        });
        return;
      }
      if (path === `/api/papers/${sample.id}`) {
        await route.fulfill({ json: sample });
        return;
      }
      await route.fulfill({ json: {} });
    });
    try {
      await imported.goto(base);
      await imported.getByLabel("向科研助手提问").waitFor();
      await imported.waitForFunction(
        () =>
          sessionStorage.getItem("research-current-chat") ===
          "import-fixture-chat",
      );
      await imported.waitForFunction(
        () =>
          !document.querySelector<HTMLButtonElement>(
            '[aria-label="＋ 导入论文"]',
          )?.disabled,
      );
      const question = "重点解释这篇论文的人体实验条件。";
      if (explicit) await imported.getByLabel("向科研助手提问").fill(question);
      async function uploadSameFile() {
        await imported.evaluate(() => {
          const win = window as unknown as { importFixtureFile?: File };
          win.importFixtureFile ??= new File(
            ["%PDF-1.4 fixture"],
            "fixture-import.pdf",
            { type: "application/pdf", lastModified: 1 },
          );
          const data = new DataTransfer();
          data.items.add(win.importFixtureFile);
          const input = document.querySelector<HTMLInputElement>(
            'input[type="file"][accept=".pdf,application/pdf"]',
          )!;
          input.files = data.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      await uploadSameFile();
      if (late) {
        await Promise.race([
          chatHeld,
          imported.waitForTimeout(12000).then(() => {
            throw new Error("未观察到等待中的第二次chat读取");
          }),
        ]);
        await imported.getByLabel("向科研助手提问").fill(question);
        releaseChat();
        await imported.waitForFunction(
          () =>
            !document.querySelector<HTMLButtonElement>(
              '[aria-label="＋ 导入论文"]',
            )?.disabled,
        );
        assert.equal(startReceipts.length, 0);
        assert.equal(dispatched.size, 0);
        assert.equal(
          await imported.getByLabel("向科研助手提问").inputValue(),
          question,
        );
        await imported.screenshot({
          path: `${folder}/import-late-question.png`,
        });
      } else if (explicit) {
        await imported
          .getByText("论文已导入，可继续中文带读，或直接告诉我你的问题。", {
            exact: true,
          })
          .waitFor();
        assert.equal(
          await imported.getByLabel("向科研助手提问").inputValue(),
          question,
        );
        assert.equal(startReceipts.length, 0);
        assert.equal(dispatched.size, 0);
        await imported.screenshot({
          path: `${folder}/import-explicit-question.png`,
        });
      } else {
        await imported.getByRole("alert").waitFor();
        await uploadSameFile();
        await imported
          .getByRole("heading", { name: "中文带读首轮（夹具）", exact: true })
          .waitFor();
        assert.equal(receiptIds.length, 2);
        assert.equal(receiptIds[0], receiptIds[1]);
        assert.equal(startReceipts.length, 1);
        assert.equal(dispatched.size, 1);
        await imported.screenshot({
          path: `${folder}/import-chinese-reading.png`,
        });
        await uploadSameFile();
        await imported
          .getByText("论文已导入，可继续中文带读，或直接告诉我你的问题。", {
            exact: true,
          })
          .waitFor();
        await imported.waitForFunction(
          () =>
            !document.querySelector<HTMLButtonElement>(
              '[aria-label="＋ 导入论文"]',
            )?.disabled,
        );
        assert.equal(dispatched.size, 1);
        const requests = startReceipts.length;
        await imported.reload();
        await imported
          .getByRole("heading", { name: "中文带读首轮（夹具）", exact: true })
          .waitFor();
        await imported.waitForTimeout(100);
        assert.equal(startReceipts.length, requests);
        assert.equal(dispatched.size, 1);
      }
    } catch (error) {
      await imported
        .screenshot({
          path: `${folder}/import-failure-${scenario}.png`,
        })
        .catch(() => {});
      throw error;
    } finally {
      await imported.close();
    }
  }
  report.assertions.push(
    "主动导入且无明确问题才请求中文带读；带问题导入或等待会话响应时新输入问题均不额外起读。首导入响应丢失后同一 receipt 重试只起步一次；已有讨论与历史刷新不新增派发（服务幂等为模拟响应，真实后端另测）。",
  );
}
try {
  const chat = await post<ConversationState>("/api/conversations", {
    paperId: "xu-2018",
  });
  const seed = await post<DeckVersion>("/api/deck-versions", {
    conversationId: chat.id,
    paperId: "xu-2018",
  });
  const position = await page.request.put(base + "/api/workspace/position", {
    data: { conversationId: chat.id, paperId: "xu-2018", panel: null },
  });
  assert.ok(position.ok());
  const oldSpeech = "# 开场\n已保存的原讲稿。\n# 结尾\n谢谢。";
  let versions: DeckVersion[] = [
    { ...seed, outline: { ...seed.outline, speechScript: oldSpeech } },
  ];
  let speechBody: { question: string; speechScript?: string } | undefined;
  let history: unknown[] = [];
  let reading = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      route.request().method() === "POST" &&
      (/\/(messages|speech|edit|reading-start)$/.test(path) ||
        /\/papers\/[^/]+\/start$/.test(path))
    ) {
      blocked.push(path);
      await route.fulfill({
        status: 409,
        json: { error: "夹具拒绝未模拟的模型调用" },
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/deck-versions?*", (route) =>
    route.fulfill({ json: versions }),
  );
  await page.route("**/api/deck-versions/*/select", (route) =>
    route.fulfill({
      json: { ...chat, latestDeckVersionId: versions.at(-1)!.id },
    }),
  );
  await page.route(`**/api/conversations/${chat.id}/turns`, (route) =>
    route.fulfill({ json: history }),
  );
  await page.route(`**/api/conversations/${chat.id}`, (route) =>
    route.fulfill({
      json: {
        ...chat,
        ...(reading
          ? {
              readingSession: {
                paperId: "xu-2018",
                paperVersion: seed.sourceVersion,
                revision: 1,
                cursor: 1,
                mainCursor: 1,
                topic: null,
                delivered: [],
                lastRanges: [],
                lastTurnId: "reading-0",
                summaryDelivered: false,
                label: "已读研究问题；下一步读研究方法（夹具）",
              },
            }
          : {}),
      },
    }),
  );
  await page.route("**/api/deck-versions/*/edit", async (route) => {
    const body = route.request().postDataJSON();
    const parent = versions.find(
      (v) => v.id === new URL(route.request().url()).pathname.split("/").at(-2),
    )!;
    const outline = structuredClone(parent.outline);
    delete outline.speechScript;
    outline.slides[body.slideIndex] = body.slide ?? {
      ...outline.slides[body.slideIndex],
      title: "模型核对后的新页面",
    };
    const child: DeckVersion = {
      ...parent,
      id: `workflow-page-${versions.length}`,
      parentId: parent.id,
      slideIndex: body.slideIndex,
      operation: undefined,
      status: "queued",
      outline,
      createdAt: new Date().toISOString(),
      request: body.question,
    };
    versions = [...versions, child];
    await route.fulfill({ json: child });
    setTimeout(() => {
      versions = versions.map((v) =>
        v.id === child.id ? { ...v, status: "completed" } : v,
      );
    }, 200);
  });
  await page.route("**/api/deck-versions/*/speech", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    speechBody = route.request().postDataJSON();
    const parent = versions.find(
      (v) => v.id === new URL(route.request().url()).pathname.split("/").at(-2),
    )!;
    const child: DeckVersion = {
      ...parent,
      id: `workflow-speech-${versions.length}`,
      parentId: parent.id,
      slideIndex: undefined,
      operation: "speech",
      status: "queued",
      outline: {
        ...parent.outline,
        speechScript:
          speechBody!.speechScript ??
          "# 开场\n按定向要求修改后的讲稿。\n# 结尾\n谢谢。",
      },
      createdAt: new Date().toISOString(),
    };
    versions = [...versions, child];
    await route.fulfill({ json: child });
    setTimeout(() => {
      versions = versions.map((v) =>
        v.id === child.id ? { ...v, status: "completed" } : v,
      );
    }, 200);
  });
  await page.goto(base);
  await page.getByRole("button", { name: "PPT 汇报", exact: true }).click();
  await page.getByLabel("第 1 页预览").waitFor();
  const slideButtons = page.locator(
    ".rw-slide-list > .rw-object > button:first-child",
  );
  await slideButtons.nth(1).click();
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  await page.getByLabel("幻灯片标题").fill("第2页未保存的修改");
  await slideButtons.first().click();
  await speechDetails();
  await page
    .locator(".hint")
    .filter({ hasText: /第\s*2\s*页还有未保存修改/ })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "重新生成演讲稿", exact: true })
      .isEnabled(),
    false,
  );
  await page.getByLabel("讲稿修改要求").fill("缩短开场");
  assert.equal(
    await page
      .getByRole("button", { name: "按要求修改讲稿并核对", exact: true })
      .isEnabled(),
    false,
  );
  await page.getByRole("button", { name: "编辑演讲稿", exact: true }).click();
  await page.getByLabel("完整演讲稿正文").fill(oldSpeech + "\n手改讲稿");
  assert.equal(
    await page
      .getByRole("button", { name: "保存演讲稿", exact: true })
      .isEnabled(),
    false,
  );
  await page.getByLabel("讲稿修改要求").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${folder}/other-page-draft.png` });
  await page
    .getByRole("button", { name: "放弃演讲稿修改", exact: true })
    .click();
  await page.getByRole("button", { name: "返回讲稿阅读", exact: true }).click();
  await page.getByLabel("讲稿修改要求").fill("");
  await slideButtons.nth(1).click();
  await page
    .getByRole("button", { name: "放弃这页未保存编辑", exact: true })
    .click();
  await slideButtons.first().click();
  report.assertions.push(
    "第2页未保存后切回第1页，补写/重新生成、定向修改和手动保存讲稿均被保护，提示未保存页序号。",
  );
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  const pageDraft = "用户未保存的页面";
  await page.getByLabel("幻灯片标题").fill(pageDraft);
  await speechDetails();
  await page.getByRole("button", { name: "编辑演讲稿", exact: true }).click();
  const speechDraft = oldSpeech + "\n用户未保存的讲稿改动。";
  await page.getByLabel("完整演讲稿正文").fill(speechDraft);
  assert.equal(
    await page
      .getByRole("button", { name: "保存演讲稿", exact: true })
      .isEnabled(),
    false,
  );
  await page.getByLabel("单页修改要求").fill("将研究思路讲清楚，保留来源");
  await page
    .getByRole("button", { name: "按要求修改这一页", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>('[aria-label="保存版本"]')
        ?.value === "workflow-page-1",
  );
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('[aria-label="幻灯片标题"]')
        ?.value === "模型核对后的新页面",
  );
  assert.equal(
    await page.getByLabel("幻灯片标题").inputValue(),
    "模型核对后的新页面",
  );
  const preserved = await page.evaluate(() => ({
    page: JSON.parse(
      localStorage.getItem("research-ppt-conflict:workflow-page-1:0") ?? "null",
    ),
    speech: localStorage.getItem("research-speech-draft:workflow-page-1"),
  }));
  assert.equal(preserved.page.title, pageDraft);
  assert.equal(preserved.speech, speechDraft);
  await page
    .getByRole("button", { name: "恢复另一份未保存页面供比较", exact: true })
    .click();
  assert.equal(await page.getByLabel("幻灯片标题").inputValue(), pageDraft);
  await speechDetails();
  assert.equal(
    await page
      .getByRole("button", { name: "保存演讲稿", exact: true })
      .isEnabled(),
    false,
  );
  await page.screenshot({ path: `${folder}/dual-drafts.png` });
  await page
    .getByRole("button", { name: "保存指定页并核对", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>('[aria-label="保存版本"]')
        ?.value === "workflow-page-2",
  );
  assert.equal(await page.getByLabel("幻灯片标题").inputValue(), pageDraft);
  await speechDetails();
  assert.equal(
    await page
      .getByRole("button", { name: "保存演讲稿", exact: true })
      .isEnabled(),
    true,
  );
  await page.getByRole("button", { name: "保存演讲稿", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>('[aria-label="保存版本"]')
        ?.value === "workflow-speech-3",
  );
  assert.equal(speechBody!.speechScript, speechDraft);
  await speechDetails();
  await page
    .getByRole("link", { name: "导出演讲稿（Markdown）", exact: true })
    .waitFor();
  report.assertions.push(
    "同页 AI 新结果默认展示，旧页面可显式恢复比较；页与稿同时修改时先保存页面，旧讲稿保留至独立保存核对。",
  );
  const requirement = "缩短开场，补充实验设计的目的。";
  await page.getByLabel("讲稿修改要求", { exact: true }).fill(requirement);
  await page
    .getByRole("button", { name: "按要求修改讲稿并核对", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>('[aria-label="保存版本"]')
        ?.value === "workflow-speech-4",
  );
  assert.equal(speechBody!.question, requirement);
  await speechDetails();
  await page
    .getByLabel("讲稿修改要求", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${folder}/speech-revised.png` });
  report.assertions.push(
    "讲稿自然语言要求完整传入 speech.question，生成结果按独立保存版展示。",
  );
  history = Array.from({ length: 10 }, (_, i) => ({
    id: `reading-${i}`,
    conversationId: chat.id,
    status: "completed",
    message: { question: `第 ${i + 1} 个带读单元`, module: "explain" },
    createdAt: new Date().toISOString(),
    budget: { attempts: [] },
    reply: {
      content: {
        title: `讲解 ${i + 1}`,
        sections: [
          {
            title: "研究思路",
            text: "连续阅读的必要解释。".repeat(60),
            citations: [],
          },
        ],
        terms: [],
      },
      artifacts: [],
      pendingQuestions: [],
      nextStep: "继续理解研究方法。",
    },
  }));
  reading = true;
  await page.reload();
  await page.locator(".rw-messages .rw-turn").nth(9).waitFor();
  await page.getByRole("button", { name: "继续带读", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "回到最新内容", exact: true })
      .count(),
    0,
  );
  const messages = page.locator(".rw-messages");
  await messages.evaluate((element) => {
    element.scrollTop = 450;
  });
  await page.waitForTimeout(100);
  const priorAnchor = await messages
    .locator(".rw-turn")
    .first()
    .evaluate((element) => element.getBoundingClientRect().top);
  history = [
    ...history,
    {
      ...(history[0] as object),
      id: "new-reading",
      message: { question: "新内容（夹具）" },
    },
  ];
  await page
    .getByRole("button", { name: "回到最新内容", exact: true })
    .waitFor();
  const afterAnchor = await messages
    .locator(".rw-turn")
    .first()
    .evaluate((element) => element.getBoundingClientRect().top);
  assert.ok(
    Math.abs(afterAnchor - priorAnchor) < 25,
    `上翻可见位置变化：${priorAnchor} → ${afterAnchor}`,
  );
  await page.getByRole("button", { name: "回到最新内容", exact: true }).click();
  await page.waitForFunction(() => {
    const e = document.querySelector(".rw-messages")!;
    return e.scrollHeight - e.clientHeight - e.scrollTop < 70;
  });
  await page.screenshot({ path: `${folder}/reading-scroll.png` });
  report.assertions.push(
    "带读进度与继续入口可见；上翻时新回答保留当前位置，点击返回最新才移动。",
  );
  await importFixtures(chat);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  await page.screenshot({ path: `${folder}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(
    `${folder}/report.json`,
    JSON.stringify({ ...report, errors, blocked }, null, 2),
  );
  await browser.close();
}
