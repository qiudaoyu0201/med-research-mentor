import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { chromium } from "playwright";
import { unzipSync } from "fflate";
import { pdfFixture } from "./pdf-fixture.ts";
import {
  answerAction,
  currentAction,
  selectPdf,
} from "./browser-research-helpers.ts";
const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4318";
const beforeBase = process.env.TUTOR_BEFORE_URL;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const page = await context.newPage();
const folder = "runs/third-round";
await mkdir(`${folder}/screenshots`, { recursive: true });
const report = {
  status: "running",
  modelCalls: 0,
  assertions: [] as string[],
  dimensions: {} as Record<string, unknown>,
  fonts: [] as unknown[],
  userStudy: "待真人试用",
  materialReadability:
    "自动检查覆盖资产尺寸；科学标签人工核读与 P3 待验收项见第三轮实施验收",
};
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));
page.setDefaultTimeout(12000);
const post = async (path: string, data: unknown) => {
  const r = await page.request.post(base + path, { data });
  assert.ok(r.ok(), await r.text());
  return r.json();
};
const position = async (chat: any, paper: any) => {
  const r = await page.request.put(base + "/api/workspace/position", {
    data: { conversationId: chat.id, paperId: paper.id, panel: null },
  });
  assert.ok(r.ok());
};
const dimensions = () =>
  page.evaluate(() =>
    Object.fromEntries(
      [
        ".rw-chat",
        ".rw-messages",
        ".rp-topbar",
        ".rw-composer-area",
        ".rw-reader",
      ].map((s) => {
        const b = document.querySelector(s)?.getBoundingClientRect();
        return [s, b ? { width: b.width, height: b.height } : null];
      }),
    ),
  );
let messages = 0,
  guides = 0,
  payload: any;
try {
  const uploaded = await page.request.post(base + "/api/papers", {
    multipart: {
      pdf: {
        name: "simplification-fixture.pdf",
        mimeType: "application/pdf",
        buffer: pdfFixture(),
      },
    },
  });
  assert.ok(uploaded.ok());
  const paper = await uploaded.json(),
    chat = await post(`/api/papers/${paper.id}/chat`, {});
  await position(chat, paper);
  const turn = {
    id: "simplification-answer",
    conversationId: chat.id,
    runId: "fixture-run",
    status: "completed",
    message: { question: "为什么需要设置对照组？", paperId: paper.id },
    reply: {
      content: {
        title: "对照帮助区分不同解释",
        question: "为什么需要设置对照组？",
        sections: [
          {
            title: "先看比较了什么",
            text: "实验组接受训练，对照组提供比较的起点。比较需要结合测量方式和条件理解。这个固定回答用于检查阅读空间和操作，不代表论文结论。",
            kind: "paper",
            citations: [paper.sources[0].id],
          },
          {
            title: "继续核对依据",
            text: Array(18)
              .fill(
                "回到原始 PDF 核对研究对象、测量方法与实验条件。选中实际文字后，可以继续提问。",
              )
              .join("\n"),
            kind: "background",
            citations: [],
          },
        ],
        terms: [],
        nextQuestion: "如何选择对照？",
      },
      artifacts: [],
      pendingQuestions: [],
      nextStep: "如何选择对照？",
    },
    budget: { attempts: [] },
  };
  await page.route("**/api/conversations/*/turns", (r) =>
    r.fulfill({ json: r.request().url().includes(chat.id) ? [turn] : [] }),
  );
  await page.route("**/api/conversations/*/messages", (r) => {
    messages++;
    payload = r.request().postDataJSON();
    return r.fulfill({ json: { ...turn, message: payload } });
  });
  await page.route("**/api/papers/*/start", (r) => {
    if (r.request().method() === "POST") {
      guides++;
      return r.fulfill({
        json: {
          status: "completed",
          summary: "固定测试阅读起点",
          label: "测试",
          questions: ["比较了哪些组？"],
          sourceIds: [paper.sources[0].id],
        },
      });
    }
    return r.continue();
  });
  if (beforeBase) {
    const old = await context.newPage();
    await old.route("**/api/conversations/*/turns", (r) =>
      r.fulfill({ json: [turn] }),
    );
    await old.goto(beforeBase);
    await old.getByText(turn.reply.content.title, { exact: true }).waitFor();
    report.dimensions.before = await old.evaluate(() =>
      Object.fromEntries(
        [
          ".rw-chat",
          ".rw-messages",
          ".rp-topbar",
          ".rw-composer-area",
          ".rw-chat-header",
          ".rw-toolbar",
        ].map((s) => {
          const b = document.querySelector(s)!.getBoundingClientRect();
          return [s, { width: b.width, height: b.height }];
        }),
      ),
    );
    await old.screenshot({ path: `${folder}/screenshots/before-answer.png` });
    await old.close();
  }
  await page.goto(base);
  await page.getByText(turn.reply.content.title, { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const dom = await cdp.send("DOM.getDocument");
  const fontNode = await cdp.send("DOM.querySelector", {
    nodeId: dom.root.nodeId,
    selector: ".rw-answer .rw-selectable",
  });
  const fontResult = await cdp.send("CSS.getPlatformFontsForNode", {
    nodeId: fontNode.nodeId,
  });
  report.fonts = fontResult.fonts;
  assert.ok(
    fontResult.fonts.some(
      (f) => f.isCustomFont && f.familyName.includes("Source Han"),
    ),
  );
  await cdp.detach();
  assert.equal(await page.locator(".rw-reader").count(), 0);
  assert.equal(await page.locator(".rw-chat-header,.rw-toolbar").count(), 0);
  assert.equal(guides, 0);
  assert.equal(messages, 0);
  report.dimensions.after = await dimensions();
  const after = report.dimensions.after as any;
  assert.ok(after[".rw-chat"].width > 1200);
  assert.ok(after[".rw-messages"].height > 680);
  assert.equal(after[".rp-topbar"].height, 52);
  if (report.dimensions.before)
    assert.ok(
      after[".rw-messages"].height >
        (report.dimensions.before as any)[".rw-messages"].height,
    );
  await page.screenshot({ path: `${folder}/screenshots/light-answer.png` });
  report.assertions.push(
    "L1: same answer baseline versus chat-first layout, no duplicate header/management toolbar; default reader hidden",
  );

  const importGap = await page.locator(".rp-new-task").evaluate((button) => {
    const icon = button.querySelector("svg")!.getBoundingClientRect();
    const label = button.querySelector("span")!.getBoundingClientRect();
    return label.left - icon.right;
  });
  assert.ok(importGap >= 0 && importGap <= 16);
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  for (const name of ["论文研究", "设置", "个人记录", "PPT 汇报"]) {
    const button = page.getByRole("button", { name, exact: true });
    assert.ok(await button.isVisible());
    assert.ok(
      await button.evaluate((e) => {
        const b = e.getBoundingClientRect(),
          i = e.querySelector("svg")!.getBoundingClientRect();
        return i.left >= b.left && i.right <= b.right;
      }),
    );
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("button", { name: "打开导航", exact: true }).click();

  const answer = page.locator(`[data-turn-id="${turn.id}"]`);
  await answer.getByRole("button", { name: "回答操作" }).click();
  const normalActions = await page.getByRole("menuitem").allTextContents();
  await page.keyboard.press("Escape");
  assert.ok(
    await answer
      .getByRole("button", { name: "回答操作" })
      .evaluate((e) => e === document.activeElement),
  );
  await answer
    .getByRole("heading", { name: turn.reply.content.title })
    .click({ button: "right" });
  assert.deepEqual(
    await page.getByRole("menuitem").allTextContents(),
    normalActions,
  );
  await page.screenshot({ path: `${folder}/screenshots/object-menu.png` });
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "简单点", exact: true }).click();
  assert.match(await page.getByLabel("向科研助手提问").inputValue(), /简单点/);
  assert.equal(messages, 0);
  await page.getByLabel("向科研助手提问").fill("");
  const quote = await answer
    .locator(".rw-selectable")
    .first()
    .evaluate((e) => {
      const range = document.createRange();
      range.setStart(e.firstChild!, 3);
      range.setEnd(e.firstChild!, 28);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return selection.toString();
    });
  await page
    .getByRole("toolbar", { name: "所选文字操作" })
    .getByRole("button", { name: "引用", exact: true })
    .click();
  assert.ok(
    (await page.locator(".rw-reference-target").textContent())?.includes(quote),
  );
  assert.equal(messages, 0);
  await page.getByRole("button", { name: "移除提问引用" }).click();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.locator(".rw-pdf-page .textLayer span").first().waitFor();
  const tabWidths = await page
    .getByRole("tab")
    .evaluateAll((tabs) => tabs.map((e) => e.getBoundingClientRect().width));
  assert.equal(tabWidths.length, 2);
  assert.ok(Math.abs(tabWidths[0] - tabWidths[1]) < 1 && tabWidths[0] > 140);
  assert.equal(
    await page.getByRole("button", { name: "提取原文", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "固定对照", exact: true }).click();
  assert.ok((await dimensions())[".rw-chat"]!.width >= 720);
  const pdfQuote = await selectPdf(page, 5, 90);
  await page
    .getByRole("toolbar", { name: "所选文字操作" })
    .getByRole("button", { name: "解释", exact: true })
    .click();
  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  await page.getByRole("button", { name: "发送 ↑", exact: true }).click();
  assert.equal(payload.sourceAnchor.excerpt, pdfQuote);
  assert.equal(payload.sourceAnchor.textView, "pdf");
  assert.equal(messages, 1);
  report.assertions.push(
    "M1/M2/L2: identical right-click/more actions, keyboard submenu and focus restoration; actual answer/PDF substrings only submit on Send; comparison chat >=720px",
  );

  await page.getByRole("button", { name: "资料", exact: true }).click();
  const canvasWidth = await page
    .locator(".rw-pdf-page canvas")
    .evaluate((e) => (e as HTMLCanvasElement).width);
  await page.getByRole("button", { name: "放大 PDF" }).click();
  await page.waitForFunction(
    (w) =>
      (document.querySelector(".rw-pdf-page canvas") as HTMLCanvasElement)
        .width > w,
    canvasWidth,
  );
  await page.getByRole("button", { name: "展开阅读", exact: true }).click();
  assert.ok((await dimensions())[".rw-reader"]!.width > 1100);
  await page.getByRole("button", { name: "返回资料", exact: true }).click();
  assert.ok((await dimensions())[".rw-chat"]!.width >= 720);
  await page.getByRole("button", { name: "放大 PDF" }).click({ clickCount: 4 });
  await page.getByRole("button", { name: "适合宽度" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".rw-pdf-page")?.getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  const returnTop = await page.locator(".rw-messages").evaluate((e) => {
    e.scrollTop = 160;
    return e.scrollTop;
  });
  assert.ok(returnTop > 100);
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.getByRole("button", { name: "展开阅读", exact: true }).click();
  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  assert.equal(
    await page.locator(".rw-messages").evaluate((e) => e.scrollTop),
    returnTop,
  );
  await page.locator(".rw-messages").evaluate((e) => {
    e.scrollTop = 0;
  });
  await page
    .getByLabel("向科研助手提问")
    .fill(Array(35).fill("长草稿仍需要保留聊天空间").join("\n"));
  const imageBytes = createCanvas(3200, 1200).toBuffer("image/png");
  await page
    .locator('input[type=file][accept=".png,.jpg,.jpeg"]')
    .setInputFiles(
      Array.from({ length: 4 }, (_, i) => ({
        name: `draft-${i}.png`,
        mimeType: "image/png",
        buffer: imageBytes,
      })),
    );
  const long = await dimensions();
  assert.ok(long[".rw-messages"]!.height > 600);
  report.dimensions.longComposer = long;
  await page.screenshot({ path: `${folder}/screenshots/long-composer.png` });
  await page
    .getByRole("button", { name: "draft-0.png · 查看大图", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      (document.querySelector(".rw-image-dialog img") as HTMLImageElement)
        ?.naturalWidth === 3200,
  );
  assert.ok(
    await page
      .locator(".rw-image-dialog img")
      .evaluate((e) => e.getBoundingClientRect().height > 300),
  );
  await page
    .locator(".rw-image-dialog")
    .getByRole("button", { name: "返回", exact: true })
    .click();
  assert.equal(messages, 1);
  await page.reload();
  await page.getByLabel("待发送附件").getByText("draft-3.png").waitFor();
  assert.match(await page.getByLabel("向科研助手提问").inputValue(), /长草稿/);
  report.assertions.push(
    "L4/R1/R2/Q2/Q6: long draft plus four attachments retains history; reload restores drafts; zoom rerenders canvas, rapid zoom is cancelled safely, wide view returns to comparison",
  );

  const imageResponse = await page.request.post(
    base + `/api/conversations/${chat.id}/attachments`,
    {
      multipart: {
        attachmentId: `hires-${chat.id}`,
        image: {
          name: "clear-figure.png",
          mimeType: "image/png",
          buffer: imageBytes,
        },
      },
    },
  );
  assert.ok(imageResponse.ok(), await imageResponse.text());
  const record = await imageResponse.json();
  assert.equal(record.originalWidth, 3200);
  assert.equal(record.modelWidth, 1800);
  const original = await page.request.get(base + record.originalUrl);
  assert.deepEqual(await original.body(), imageBytes);
  const other = await post("/api/conversations", { paperId: null });
  assert.equal(
    (
      await page.request.get(
        base +
          `/api/conversations/${other.id}/attachments/${record.id}/original`,
      )
    ).status(),
    400,
  );
  report.assertions.push(
    "Q4: original bytes are unchanged and owned by their chat; 3200px original and 1800px model input are separate",
  );

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("阅读字体", { exact: true }).selectOption("system");
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.reload();
  await page.waitForFunction(
    () => document.documentElement.dataset.researchFont === "system",
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("阅读字体", { exact: true }).selectOption("source-han");
  await page.getByLabel("外观", { exact: true }).selectOption("dark");
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${folder}/screenshots/dark-answer.png` });
  await page.reload();
  await page.waitForFunction(
    () => document.documentElement.dataset.researchTheme === "dark",
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("外观", { exact: true }).selectOption("system");
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.waitForFunction(
    () => document.documentElement.dataset.researchTheme === "dark",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(
    () => document.documentElement.dataset.researchTheme === "light",
  );
  await page.evaluate(() =>
    localStorage.setItem("research-layout-v2", "{broken"),
  );
  await page.reload();
  assert.equal(
    await page
      .getByRole("separator", { name: "调整导航宽度" })
      .getAttribute("aria-valuenow"),
    "216",
  );
  await page.evaluate(() => {
    localStorage.setItem(
      "research-layout",
      JSON.stringify({ navigation: 280, reading: 60, composer: 360 }),
    );
    localStorage.removeItem("research-layout-v2");
  });
  await page.reload();
  assert.equal(
    await page
      .getByRole("separator", { name: "调整导航宽度" })
      .getAttribute("aria-valuenow"),
    "280",
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "恢复默认布局" }).click();
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.reload();
  assert.equal(
    await page
      .getByRole("separator", { name: "调整导航宽度" })
      .getAttribute("aria-valuenow"),
    "216",
  );
  const resetLayout = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("research-layout-v2") ?? "{}"),
  );
  assert.equal(resetLayout.reading, 360);
  assert.equal(resetLayout.composer, 140);
  await page.waitForFunction(() =>
    document
      .querySelector<HTMLTextAreaElement>('[aria-label="向科研助手提问"]')
      ?.value.includes("长草稿"),
  );
  assert.match(await page.getByLabel("向科研助手提问").inputValue(), /长草稿/);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-label="待发送附件"] > .rw-object')
        .length === 4,
  );
  assert.equal(
    await page.getByLabel("待发送附件").locator(":scope > .rw-object").count(),
    4,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("research-theme")),
    "system",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("research-font")),
    "source-han",
  );
  report.assertions.push(
    "V1/V2/R3: bundled Source Han Sans actually renders Chinese text; system font selection survives reload; legacy navigation migrates and reset survives reload while retaining drafts, font and theme preferences",
  );
  for (const width of [1920, 1440, 1366, 1280, 1024, 960, 768, 720]) {
    await page.setViewportSize({ width, height: width === 720 ? 480 : 960 });
    await page.getByRole("button", { name: "资料", exact: true }).click();
    await page.getByRole("button", { name: "返回讨论", exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector(".rw-pdf-page")?.getAttribute("aria-busy") ===
        "false",
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: `${folder}/screenshots/reader-${width}.png`,
    });
    await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  }
  report.assertions.push(
    "L3/R3/V2/V4: desktop 1920/1440/1366/1280/1024/960/768 and 720x480 effective 200% viewport; theme/system persistence and layout reset preserve business drafts",
  );

  await page.setViewportSize({ width: 1440, height: 960 });
  const freshGuide = await (
    await page.request.post(base + "/api/papers", {
      multipart: {
        pdf: {
          name: "manual-guide.pdf",
          mimeType: "application/pdf",
          buffer: pdfFixture(),
        },
      },
    })
  ).json();
  const freshChat = await post(`/api/papers/${freshGuide.id}/chat`, {});
  await position(freshChat, freshGuide);
  await page.reload();
  await page
    .getByRole("button", { name: "整理研究起点", exact: true })
    .waitFor();
  assert.equal(guides, 0);
  await page.getByRole("button", { name: "整理研究起点", exact: true }).click();
  await page.getByText("固定测试阅读起点", { exact: true }).waitFor();
  assert.equal(guides, 1);
  await page.getByRole("button", { name: /比较了哪些组？/ }).click();
  assert.equal(messages, 1);
  assert.equal(
    await page.getByLabel("向科研助手提问").inputValue(),
    "比较了哪些组？",
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("switch", { name: "自动整理阅读起点" }).check();
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "整理研究起点", exact: true })
    .waitFor();
  assert.equal(guides, 1);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("switch", { name: "自动整理阅读起点" }).uncheck();
  await page.getByRole("button", { name: "关闭设置" }).click();
  const blockedAuto = await page.request.post(
    base + `/api/papers/${freshGuide.id}/start`,
    { data: { automatic: true } },
  );
  assert.equal(blockedAuto.status(), 200);
  assert.equal((await blockedAuto.json()).status, undefined);
  report.assertions.push(
    "K2: fresh paper remains manual by default; explicit guide and suggested question only act on click; opt-in survives reload and server manual mode rejects automatic generation",
  );

  await page.setViewportSize({ width: 1440, height: 960 });
  const workspace = await (
      await page.request.get(base + "/api/workspace")
    ).json(),
    sample = workspace.papers.find((p: any) => p.id === "xu-2018"),
    sampleChat = await post("/api/papers/xu-2018/chat", {});
  await position(sampleChat, sample);
  await page.unroute("**/api/conversations/*/turns");
  await page.unroute("**/api/conversations/*/messages");
  const actual = await post(`/api/conversations/${sampleChat.id}/messages`, {
    mode: "example",
    module: "paper",
    question: "解释论文研究问题",
    clientMessageId: `simplification-${Date.now()}`,
  });
  for (let i = 0; i < 100; i++) {
    const t = await (
      await page.request.get(base + `/api/turns/${actual.id}`)
    ).json();
    if (t.status === "completed") break;
    await new Promise((r) => setTimeout(r, 30));
  }
  await page.reload();
  await page.locator(`[data-turn-id="${actual.id}"]`).waitFor();
  await answerAction(page, actual.id, "收藏解释");
  await page.getByText("解释已收藏。", { exact: true }).waitFor();
  await answerAction(page, actual.id, "保存回答为笔记");
  await page.getByRole("heading", { name: "我的笔记", exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: /^笔记正文/ })
    .last()
    .fill("关闭资料时保留的笔记草稿");
  await page.getByRole("button", { name: "返回讨论" }).click();
  await currentAction(page, "我的笔记");
  assert.equal(
    await page
      .getByRole("textbox", { name: /^笔记正文/ })
      .last()
      .inputValue(),
    "关闭资料时保留的笔记草稿",
  );
  await page.getByRole("button", { name: "返回讨论" }).click();
  if (sample.pdfUrl) {
    await page.getByRole("button", { name: "资料", exact: true }).click();
    await page.getByLabel("PDF 页码", { exact: true }).selectOption("2");
    await page.getByRole("button", { name: "展开阅读", exact: true }).click();
    for (let i = 0; i < 3; i++)
      await page.getByRole("button", { name: "放大 PDF" }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(".rw-pdf-page")?.getAttribute("aria-busy") ===
        "false",
    );
    await page.locator(".rp-viewer-body").evaluate((e) => {
      e.scrollTop = 350;
    });
    await page.screenshot({
      path: `${folder}/screenshots/real-paper-figure.png`,
    });
    const canvas = page.locator(".rw-pdf-page canvas");
    report.dimensions.realPdf = await canvas.evaluate((e) => ({
      width: (e as HTMLCanvasElement).width,
      height: (e as HTMLCanvasElement).height,
    }));
    await page.getByRole("button", { name: "返回讨论" }).click();
  }
  const seed = await post("/api/deck-versions", {
    conversationId: sampleChat.id,
    paperId: sample.id,
  });
  await currentAction(page, "PPT 汇报");
  await page.getByLabel("第 1 页预览").waitFor();
  assert.equal(await page.locator(".rw-ppt-editor").count(), 0);
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  const originalTitle = await page.getByLabel("幻灯片标题").inputValue();
  await page.getByLabel("幻灯片标题").fill("保留但尚未保存的页标题");
  await page.getByRole("button", { name: "返回预览", exact: true }).click();
  assert.ok(
    await page.getByRole("button", { name: "导出当前保存版本" }).isDisabled(),
  );
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  assert.equal(
    await page.getByLabel("幻灯片标题").inputValue(),
    "保留但尚未保存的页标题",
  );
  await page.getByRole("button", { name: "放弃这页未保存编辑" }).click();
  assert.equal(await page.getByLabel("幻灯片标题").inputValue(), originalTitle);
  await page.getByRole("button", { name: "返回预览", exact: true }).click();
  await page.getByRole("button", { name: "导出当前保存版本" }).click();
  const link = page.getByRole("link", { name: "下载 PPTX" });
  await link.waitFor();
  const exported = unzipSync(
    new Uint8Array(
      await (
        await page.request.get(base + (await link.getAttribute("href")))
      ).body(),
    ),
  );
  const media = Object.keys(exported).filter(
    (key) => key.startsWith("ppt/media/") && exported[key].length > 0,
  );
  for (const [i, name] of media.entries())
    await writeFile(
      `${folder}/screenshots/exported-media-${i}.png`,
      exported[name],
    );
  if (sample.pdfUrl) {
    assert.ok(Object.keys(seed.displayAssets ?? {}).length > 0);
    assert.ok(media.length > 0);
  }
  await page.screenshot({ path: `${folder}/screenshots/ppt-preview.png` });
  const figurePage = seed.outline.slides.findIndex((s: any) => s.imageSource);
  if (figurePage >= 0) {
    await page
      .getByRole("button", { name: new RegExp(`^第 ${figurePage + 1} 页 ·`) })
      .first()
      .click();
    await page.getByRole("button", { name: /· 查看大图$/ }).click();
    await page.locator(".rw-image-dialog img").waitFor();
    assert.ok(
      await page
        .locator(".rw-image-dialog img")
        .evaluate((img) => (img as HTMLImageElement).naturalWidth >= 3000),
    );
    await page.getByRole("button", { name: "放大", exact: true }).click();
    assert.ok(
      await page
        .locator(".rw-image-dialog img")
        .evaluate(
          (img) =>
            img.getBoundingClientRect().width >
            img.parentElement!.getBoundingClientRect().width,
        ),
    );
    await page.screenshot({
      path: `${folder}/screenshots/ppt-original-figure.png`,
    });
    await page
      .locator(".rw-image-dialog")
      .getByRole("button", { name: "返回", exact: true })
      .click();
    await page.locator(".rw-ppt-preview").evaluate((e) => {
      e.scrollTop = e.scrollHeight;
    });
    assert.ok(
      await page.locator(".rw-ppt-preview").evaluate((e) => e.scrollTop > 0),
    );
    const otherPage = figurePage === 0 ? 1 : 0;
    await page
      .getByRole("button", { name: new RegExp(`^第 ${otherPage + 1} 页 ·`) })
      .first()
      .click();
    assert.equal(
      await page.locator(".rw-ppt-preview").evaluate((e) => e.scrollTop),
      0,
    );
    await page
      .getByRole("button", { name: new RegExp(`^第 ${figurePage + 1} 页 ·`) })
      .first()
      .click();
  }
  await page.setViewportSize({ width: 1280, height: 768 });
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  assert.ok(!(await page.locator(".rw-ppt-preview").isVisible()));
  assert.ok((await page.locator(".rw-ppt-editor").boundingBox())!.width > 900);
  await page.getByRole("button", { name: "返回预览", exact: true }).click();
  report.assertions.push(
    "Desktop visual regressions: aligned import label; collapsed navigation keeps reachable tools and unclipped icons; tabs fill equal halves; page changes reset PPT scroll; constrained editor uses full panel width",
  );
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "编辑这一页", exact: true }).click();
  assert.ok(await page.getByLabel("幻灯片标题").isVisible());
  await page.getByRole("button", { name: "返回预览", exact: true }).click();
  assert.ok(
    await page
      .getByLabel(`第 ${figurePage >= 0 ? figurePage + 1 : 1} 页预览`)
      .isVisible(),
  );
  report.assertions.push(
    "K1/P1/P2/P3/V5: real example favorite/note round trip; compact saved version selector; editor opens on demand, closing keeps draft, unsaved export blocked; actual saved PPTX exported with media; narrow desktop editor returns to preview",
  );
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (err) {
  report.status = "failed";
  await page.screenshot({ path: `${folder}/screenshots/failure.png` });
  throw err;
} finally {
  await writeFile(
    `${folder}/browser-report.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
