import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4330";
const folder = "runs/reading-focus/browser";
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 2,
});
page.setDefaultTimeout(12000);
await page.emulateMedia({ reducedMotion: "reduce" });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const report = { status: "running", modelCalls: 0, assertions: [] as string[] };

// The two colored blocks provide independently known image positions and pixels.
function fixture() {
  const content =
    "q 1 0 0 rg 60 500 200 200 re f Q\nq 0 0 1 rg 300 500 200 200 re f Q\nBT /F1 12 Tf 30 760 Td (Engineering crop fixture: red on left and blue on right.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((value) => `${String(value).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

try {
  const response = await page.request.post(base + "/api/papers", {
    multipart: {
      pdf: {
        name: "reading-crop.pdf",
        mimeType: "application/pdf",
        buffer: fixture(),
      },
    },
  });
  assert.ok(response.ok(), await response.text());
  const paper = await response.json();
  const chat = await page.request
    .post(base + `/api/papers/${paper.id}/chat`, { data: {} })
    .then((r) => r.json());
  await page.request.put(base + "/api/workspace/position", {
    data: { conversationId: chat.id, paperId: paper.id, panel: null },
  });
  const source = paper.sources[0],
    alias = { ...source, id: "same-page-alias" };
  const turn = {
    id: "reading-focus-fixture",
    conversationId: chat.id,
    status: "completed",
    runId: "fixture-run",
    message: { question: "说明这两个色块的比较。", paperId: paper.id },
    budget: { attempts: [] },
    run: { materials: [{ sources: [alias] }] },
    reply: {
      content: {
        title: "工程示例：先理解比较",
        sections: [
          {
            title: "比较对象",
            text: "左边红色、右边蓝色。这是合成图，用来检查裁剪。",
            kind: "paper",
            citations: [source.id, alias.id],
          },
          {
            title: "理解方式",
            text: "两个段落引用同一页，查看原文只需要一个入口。",
            kind: "paper",
            citations: [source.id],
          },
        ],
        terms: [],
      },
      artifacts: [],
      pendingQuestions: [],
      nextStep: "",
    },
  };
  await page.route(`**/api/conversations/${chat.id}/turns`, (route) =>
    route.fulfill({ json: [turn] }),
  );
  await page.goto(base);
  const answer = page.locator(".rw-answer");
  await answer
    .getByRole("button", { name: "查看 PDF 原文", exact: false })
    .waitFor();
  assert.equal(
    await answer
      .getByRole("button", { name: "查看 PDF 原文", exact: false })
      .count(),
    1,
  );
  assert.equal(await answer.locator("section .rw-citation-chip").count(), 0);
  assert.equal(await answer.getByRole("button", { name: /PDF 1/ }).count(), 0);
  await page.screenshot({ path: `${folder}/answer.png` });
  await answer
    .getByRole("button", { name: "查看 PDF 原文", exact: false })
    .click();
  await page
    .getByText("正在显示 PDF…", { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(await page.locator(".rw-reader .rp-source-card").count(), 0);
  await page.getByRole("button", { name: "展开阅读", exact: true }).click();
  const region = page.locator(".rw-pdf-crop-preview");
  async function choose(
    left: number,
    top: number,
    right: number,
    bottom: number,
  ) {
    await page.getByRole("button", { name: "框选局部", exact: true }).click();
    const overlay = page.getByLabel("框选图或段落区域", { exact: true });
    await overlay.waitFor();
    await page.locator(".rw-pdf-scroll").evaluate((element) => {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    });
    await overlay.evaluate((element) => {
      element.scrollIntoView({ block: "start" });
      const reader = element.closest(".rp-viewer-body");
      if (reader) reader.scrollTop = Math.max(0, reader.scrollTop - 64);
    });
    const box = (await overlay.boundingBox())!;
    await page.mouse.move(box.x + box.width * left, box.y + box.height * top);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width * right,
      box.y + box.height * bottom,
      { steps: 5 },
    );
    await page.mouse.up();
    await region.locator("img").waitFor();
  }
  await choose(0.08, 0.08, 0.86, 0.38);
  const key = `research-pdf-crop:${JSON.stringify([paper.id, paper.version, 1, source.id])}`;
  const crop = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    key,
  );
  assert.ok(
    Math.abs(crop.left - 0.08) < 0.002 && Math.abs(crop.width - 0.78) < 0.002,
  );
  const pixels = await region.locator("img").evaluate(async (element, crop) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const samples = [
      [150, 600],
      [400, 600],
      [280, 600],
    ].map(([x, y]) => [
      ...context.getImageData(
        Math.round(((x / 612 - crop.left) / crop.width) * canvas.width),
        Math.round(
          (((792 - y) / 792 - crop.top) / crop.height) * canvas.height,
        ),
        1,
        1,
      ).data,
    ]);
    return {
      red: samples[0],
      blue: samples[1],
      white: samples[2],
      width: canvas.width,
      height: canvas.height,
    };
  }, crop);
  assert.deepEqual(pixels.red, [255, 0, 0, 255]);
  assert.deepEqual(pixels.blue, [0, 0, 255, 255]);
  assert.deepEqual(pixels.white, [255, 255, 255, 255]);
  assert.ok(pixels.width > 900);
  await page.screenshot({ path: `${folder}/crop.png` });
  await page.getByRole("button", { name: "查看整页", exact: true }).click();
  await page.getByRole("button", { name: "放大 PDF", exact: true }).click();
  await page
    .getByText("正在显示 PDF…", { exact: true })
    .waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "查看已选局部", exact: true }).click();
  assert.deepEqual(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key),
    crop,
  );
  await page.getByRole("button", { name: "查看整页", exact: true }).click();
  await page.getByRole("button", { name: "适合宽度", exact: true }).click();
  await page
    .getByText("正在显示 PDF…", { exact: true })
    .waitFor({ state: "hidden" });
  await choose(0.86, 0.38, 0.08, 0.08);
  assert.ok(
    Math.abs(
      (
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key)!),
          key,
        )
      ).width - crop.width,
    ) < 0.002,
  );
  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  await answer
    .getByRole("button", { name: "查看 PDF 原文", exact: false })
    .click();
  await region.locator("img").waitFor();
  await page.reload();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await region.locator("img").waitFor();
  await page.getByRole("button", { name: "框选局部", exact: true }).click();
  await page.getByRole("button", { name: "取消框选", exact: true }).click();
  assert.equal(await page.getByLabel("框选图或段落区域").count(), 0);
  report.assertions.push(
    "一个回答只保留一个 PDF 入口，同页来源跨段合并；原页可读且没有重复提取正文；实际色块验证裁剪像素与范围，缩放、反向框选、关闭及刷新保留局部",
  );

  await page.getByRole("button", { name: "返回讨论", exact: true }).click();
  await page.getByRole("button", { name: "研究方案", exact: true }).click();
  const before = await page
    .getByRole("region", { name: "研究方案专区" })
    .innerText();
  await page
    .getByRole("button", { name: "当前论文更多操作", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "我的笔记", exact: true }).click();
  const modal = page.getByRole("dialog", {
    name: "研究方案资料与笔记",
    exact: true,
  });
  await modal.getByRole("heading", { name: "我的笔记", exact: true }).waitFor();
  await modal.getByRole("button", { name: "新建笔记", exact: true }).click();
  await modal.getByLabel("新笔记正文").fill("方案页面中直接记录想法。");
  await modal
    .getByRole("button", { name: "返回研究方案", exact: true })
    .click();
  assert.equal(
    await page.getByRole("region", { name: "研究方案专区" }).innerText(),
    before,
  );
  await page
    .getByRole("button", { name: "当前论文更多操作", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "我的笔记", exact: true }).click();
  assert.equal(
    await modal.getByLabel("新笔记正文").inputValue(),
    "方案页面中直接记录想法。",
  );
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  report.assertions.push(
    "方案页笔记原位打开、返回按钮与 Esc 保留方案，笔记草稿关闭后仍可继续",
  );
  const realChat = await page.request
    .post(base + "/api/conversations", { data: { paperId: "xu-2018" } })
    .then((r) => r.json());
  await page.request.put(base + "/api/workspace/position", {
    data: { paperId: "xu-2018", conversationId: realChat.id, panel: null },
  });
  await page.reload();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.getByRole("button", { name: "展开阅读", exact: true }).click();
  await page.getByLabel("PDF 页码", { exact: true }).selectOption("2");
  await page
    .getByText("正在显示 PDF…", { exact: true })
    .waitFor({ state: "hidden" });
  await page.screenshot({ path: `${folder}/real-page.png` });
  // Figure 1a: include its label and the complete experimental design panel.
  await choose(0.06, 0.072, 0.315, 0.2);
  await page.screenshot({ path: `${folder}/real-crop.png` });
  await page.getByLabel("PDF 页码", { exact: true }).selectOption("3");
  await page
    .getByText("正在显示 PDF…", { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(await region.count(), 0);
  await page.getByLabel("PDF 页码", { exact: true }).selectOption("2");
  await region.locator("img").waitFor();
  await page.getByRole("button", { name: "查看整页", exact: true }).click();
  for (let step = 0; step < 2; step++) {
    await page.getByRole("button", { name: "缩小 PDF", exact: true }).click();
    await page
      .getByText("正在显示 PDF…", { exact: true })
      .waitFor({ state: "hidden" });
  }
  await choose(0.001, 0.001, 0.999, 0.999);
  const broad = await region.locator("img").evaluate((element) => ({
    width: (element as HTMLImageElement).naturalWidth,
    height: (element as HTMLImageElement).naturalHeight,
    displayedHeight: element.getBoundingClientRect().height,
  }));
  assert.ok(
    broad.height > broad.width,
    "Nearly full-page crop preserves the portrait page instead of cutting it to a short strip",
  );
  assert.ok(
    broad.displayedHeight <= 420.1,
    "Preview scales down without trimming the original selection",
  );
  await page.screenshot({ path: `${folder}/real-wide-crop.png` });
  report.assertions.push(
    "真实论文局部与近整页大范围选区完整显示、预览等比缩放；切页返回按论文版本及来源保留，不串页",
  );
  assert.deepEqual(errors, []);
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
  await browser.close();
}
