import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { unzipSync, strFromU8 } from "fflate";
import { pdfFixture } from "./pdf-fixture.ts";
import { parsePdf } from "../server/pdf.ts";
import {
  selectEvidence,
  materialPacket,
  defaultPaperSources,
} from "../server/materials.ts";
import { DeckVersions } from "../server/deck-versions.ts";
import { RecordStorage } from "../server/storage.ts";
import { ReadingGuides } from "../server/reading-guides.ts";
import { TaskScheduler } from "../server/scheduler.ts";
import { slideImageKey } from "../shared/image-region.ts";
import {
  slideLayout,
  wrapSlideText,
  citationLabel,
} from "../shared/slide-layout.ts";
import type { PaperBundle, TaskRun } from "../shared/types.ts";
import { saveDisplayAsset } from "../server/display-assets.ts";
import { read } from "../server/storage.ts";
const noModel = {
  model: "fixture",
  async generate() {
    throw new Error("Unexpected model call");
  },
};

test("ordinary PDF import locates original graphic with labels and preserves cache identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tutor-figures-"));
  try {
    const path = join(dir, "figure.pdf");
    await writeFile(
      path,
      pdfFixture(
        "",
        "q 0.1 0.3 0.8 rg 60 550 250 100 re f Q\nBT /F1 12 Tf 55 664 Td (a - original panel label) Tj ET\nBT /F1 10 Tf 40 520 Td (Fig. 1 | Synthetic graph for engineering verification.) Tj ET\nBT /F1 12 Tf 40 420 Td (Body paragraph must not appear in the extracted graphic.) Tj ET",
      ),
    );
    const p = await parsePdf(path, "figure-a", "Engineering"),
      q = await parsePdf(path, "figure-b", "Engineering");
    const f = p.sources.find((s) => s.image)!;
    assert.ok(f);
    assert.equal(f.figure, "1");
    assert.equal(f.page, 1);
    assert.ok(f.imageRegion!.top < 0.18);
    assert.ok(f.imageRegion!.top + f.imageRegion!.height < 0.34);
    const img = await loadImage(f.image!);
    assert.ok(img.width > 500);
    assert.ok(img.height > 200);
    assert.equal(q.sources.find((s) => s.image)?.image, f.image);
    assert.match(q.sources.find((s) => s.image)!.id, /^figure-b-/);
    assert.ok(
      defaultPaperSources(p, "生成汇报", ["ppt"]).some((s) => s.id === f.id),
    );
    const two = join(dir, "two.pdf");
    await writeFile(
      two,
      pdfFixture(
        "",
        "q 0.1 0.3 0.8 rg 40 550 220 100 re f Q\nq 0.8 0.1 0.1 rg 335 550 220 100 re f Q\nBT /F1 10 Tf 40 520 Td (Fig. 1 | Left figure.) Tj ET\nBT /F1 10 Tf 335 520 Td (Fig. 2 | Right figure.) Tj ET",
      ),
    );
    const columns = (
      await parsePdf(two, "two-columns", "Engineering")
    ).sources.filter((s) => s.imageRegion);
    assert.equal(columns.length, 2);
    assert.ok(
      columns[0].imageRegion!.left + columns[0].imageRegion!.width < 0.5,
    );
    assert.ok(columns[1].imageRegion!.left > 0.5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("long ordinary paper includes late methods and explicit exact excerpt ranges within a bounded packet", () => {
  const sources = Array.from({ length: 15 }, (_, i) => ({
    id: "page-" + (i + 1),
    title: `PDF 第 ${i + 1} 页`,
    page: i + 1,
    kind: "paper" as const,
    locator: "PDF " + (i + 1),
    verified: false,
    text:
      `Page ${i + 1}. ` +
      (i >= 11
        ? "Methods statistical analysis muscle measurement. "
        : "Background unrelated narrative. "
      ).repeat(210),
  }));
  const selected = selectEvidence(
      sources.map((s) => ({ ...s, caption: s.text })),
      "muscle measurement methods",
      ["ppt"],
    ),
    packet = materialPacket(selected, "muscle measurement methods");
  assert.ok(selected.some((s) => s.page === 12));
  assert.ok(selected.some((s) => s.page === 13));
  assert.ok(packet.references.some((r) => "visibleRanges" in r));
  assert.ok(packet.blocks.reduce((n, b) => n + b.text.length, 0) <= 22000);
  assert.ok(
    JSON.stringify(packet).length < 30_000,
    "Long captions must not bypass the excerpt budget through metadata",
  );
  assert.match(packet.coverage!, /不代表全文/);
  const ref = packet.references.find((r) => r.id === "page-12")! as any;
  for (const r of ref.visibleRanges)
    assert.ok(
      packet.blocks
        .find((b) => b.hash === ref.blockHash)!
        .text.includes(sources[11].text.slice(r.start, r.end)),
    );
});

test("material requests restore complete selected evidence without exceeding the shared packet allowance", () => {
  const sources = Array.from({ length: 12 }, (_, i) => ({
    id: `p-${i}`,
    title: `PDF 第 ${i + 1} 页`,
    page: i + 1,
    kind: "paper" as const,
    locator: `PDF ${i + 1}`,
    verified: false,
    text:
      "Generic evidence. ".repeat(250) +
      `The intervention identity is at the end of page ${i}.`,
  }));
  const original = materialPacket(sources, "complete presentation");
  assert.ok(!original.blocks[4].text.includes("identity"));
  const restored = materialPacket(sources, "complete presentation", ["p-4"]);
  const ref = restored.references.find((r) => r.id === "p-4")!;
  assert.equal(
    restored.blocks.find((b) => b.hash === ref.blockHash)!.text,
    sources[4].text,
  );
  assert.ok(restored.blocks.reduce((n, b) => n + b.text.length, 0) <= 22000);
  assert.ok(restored.references.some((r) => "visibleRanges" in r));
  const oversized = [
    { ...sources[0], text: "x".repeat(11000) },
    ...sources.slice(1),
  ];
  const bounded = materialPacket(oversized, "complete presentation", ["p-0"]);
  assert.ok(bounded.blocks.reduce((n, b) => n + b.text.length, 0) <= 22000);
  assert.ok("visibleRanges" in bounded.references[0]);
});

test("valid JSON with invalid nested shape is quarantined before startup consumers; workspace restores its backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tutor-shapes-")),
    store = new RecordStorage(dir);
  try {
    const index = { projects: [], papers: [], notes: [], positions: [] };
    await store.save("workspace", "index", index);
    await store.save("workspace", "index", index);
    await writeFile(join(dir, "workspace/index.json"), "{}");
    assert.deepEqual(await store.read("workspace", "index"), index);
    await mkdir(join(dir, "reading-guides"));
    await writeFile(
      join(dir, "reading-guides/bad.json"),
      JSON.stringify({ id: "bad", status: "queued" }),
    );
    const guides = new ReadingGuides(noModel, new TaskScheduler());
    await guides.restore(store.list);
    assert.equal(guides.records.size, 0);
    assert.equal(
      (await readdir(join(dir, "quarantine/reading-guides"))).length,
      1,
    );
    const badNested = {
      ...index,
      notes: [{ id: "note", text: "good text", anchors: null }],
    };
    await writeFile(
      join(dir, "workspace/index.json"),
      JSON.stringify(badNested),
    );
    assert.deepEqual(await store.read("workspace", "index"), index);
    assert.equal((await readdir(join(dir, "quarantine/workspace"))).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("different crops of one source remain separate immutable versions and survive actual PPTX export and restoration", async () => {
  const c = createCanvas(400, 200),
    ctx = c.getContext("2d");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = "blue";
  ctx.fillRect(200, 0, 200, 200);
  const image = c.toDataURL("image/png"),
    paper: PaperBundle = {
      id: "crop-test",
      title: "Crop test",
      version: "v1",
      scope: "engineering",
      sources: [
        {
          id: "text",
          title: "Text",
          kind: "paper",
          locator: "p1",
          text: "Synthetic comparison",
          verified: false,
        },
        {
          id: "image",
          title: "Figure 1",
          kind: "paper",
          locator: "p1",
          text: "Synthetic image",
          verified: false,
          image,
        },
        {
          id: "second-image",
          title: "Figure 2",
          kind: "paper",
          locator: "p2",
          text: "Second image",
          verified: false,
          image,
        },
      ],
    };
  const manualId = await saveDisplayAsset(
    { ...paper, pdfUrl: "/not-a-whole-page" },
    {
      ...paper.sources[1],
      page: 1,
      figure: "用户圈选",
      imagePurpose: "figure",
    },
  );
  const manual = await read<any>("display-assets", manualId);
  assert.equal(manual.width, 400);
  assert.equal(manual.height, 200);
  const review = {
    issues: [],
    checkedSources: ["text", "image"],
    limitations: ["Engineering only"],
  };
  // The replacement precedes the parent's sources in canonical paper order.
  paper.sources.unshift(paper.sources.pop()!);
  const provider = {
    model: "fixture",
    async generate(_i: any, _x: any, schema: any) {
      return { output: schema.parse(review) };
    },
  };
  const store = new DeckVersions(
    provider,
    async () => paper,
    async () => {},
  );
  const run = {
    id: "run",
    status: "completed",
    input: { conversationId: "chat", paperId: paper.id, mode: "live" },
    sourceVersion: "v1",
    result: {},
    review,
    deck: {
      slides: [
        {
          title: "Original",
          bullets: ["Compare conditions"],
          notes: "N".repeat(2000),
          citations: ["text"],
          imageSource: "image",
        },
      ],
    },
  } as unknown as TaskRun;
  const base = await store.seed("chat", paper.id, run);
  const changed = await store.wait(
    (
      await store.start(base.id, "chat", {
        slideIndex: 0,
        question: "Keep left panel",
        slide: {
          ...base.outline.slides[0],
          imageCrop: { left: 0, top: 0, width: 0.5, height: 1 },
        },
      })
    ).id,
  );
  assert.equal(changed.status, "completed", changed.error);
  const key = slideImageKey(changed.outline.slides[0])!,
    asset = await read<any>("display-assets", changed.displayAssets![key]);
  assert.equal(asset.width, 200);
  assert.equal(asset.height, 200);
  const exportResult = await store.export(changed.id, "chat"),
    zip = unzipSync(await readFile(join("exports", exportResult.id + ".pptx")));
  const media = Object.keys(zip).find((k) => /^ppt\/media\/image/.test(k))!;
  const img = await loadImage(Buffer.from(zip[media]));
  assert.equal(img.width, 200);
  assert.equal(img.height, 200);
  const png = createCanvas(200, 200);
  png.getContext("2d").drawImage(img, 0, 0);
  assert.ok(png.getContext("2d").getImageData(100, 100, 1, 1).data[0] > 240);
  assert.deepEqual(store.get(base.id).outline.slides[0].imageCrop, undefined);
  const replaced = await store.wait(
    (
      await store.start(changed.id, "chat", {
        slideIndex: 0,
        question: "Replace figure",
        slide: {
          ...changed.outline.slides[0],
          imageSource: "second-image",
          imageCrop: undefined,
          citations: ["text", "second-image"],
        },
      })
    ).id,
  );
  assert.equal(replaced.status, "completed", replaced.error);
  assert.ok(replaced.sourceIds.includes("second-image"));
  const restored = await store.restoreVersion(replaced.id, base.id, "chat");
  assert.equal(restored.outline.slides[0].imageSource, "image");
  const xml = strFromU8(zip["ppt/slides/slide1.xml"]);
  assert.ok(!xml.includes("Synthetic image"));
  const note = strFromU8(zip["ppt/notesSlides/notesSlide1.xml"]);
  assert.match(
    [...note.matchAll(/<a:t>(.*?)<\/a:t>/g)].map((m) => m[1]).join(""),
    /^\d+$/,
  );
  assert.ok(restored.outline.slides[0].notes.length > 0);
});

test("manual page correction failure retains exact draft and can be saved again from the healthy ancestor", async () => {
  const p: PaperBundle = {
    id: "recovery",
    title: "Recovery",
    version: "v1",
    scope: "fixture",
    sources: [
      {
        id: "s",
        title: "Source",
        kind: "paper",
        text: "Evidence",
        locator: "p1",
        verified: false,
      },
    ],
  };
  let blocked = true;
  const provider = {
    model: "fixture",
    async generate(_i: any, _x: any, schema: any) {
      return {
        output: schema.parse({
          issues: blocked
            ? [
                {
                  id: "issue",
                  location: "slide",
                  type: "fact",
                  evidence: ["s"],
                  suggestion: "Revise draft",
                  severity: "blocking",
                  resolved: false,
                },
              ]
            : [],
          checkedSources: ["s"],
          limitations: [],
        }),
      };
    },
  };
  const store = new DeckVersions(
      provider,
      async () => p,
      async () => {},
    ),
    run = {
      id: "r",
      status: "completed",
      input: { conversationId: "c", paperId: p.id, mode: "live" },
      sourceVersion: p.version,
      result: {},
      review: { issues: [], checkedSources: ["s"], limitations: [] },
      deck: {
        slides: [
          {
            title: "Original",
            bullets: ["Point"],
            notes: "Notes",
            citations: ["s"],
          },
        ],
      },
    } as unknown as TaskRun;
  const base = await store.seed("c", p.id, run),
    draft = { ...base.outline.slides[0], title: "User draft" };
  const failed = await store.wait(
    (
      await store.start(base.id, "c", {
        slideIndex: 0,
        question: "Save",
        slide: draft,
      })
    ).id,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.budget?.attempts.length, 1);
  assert.deepEqual(failed.outline.slides[0], draft);
  await assert.rejects(store.export(failed.id, "c"), /不能导出/);
  blocked = false;
  const recovered = await store.wait(
    (
      await store.start(failed.id, "c", {
        slideIndex: 0,
        question: "Save corrected draft",
        slide: { ...draft, title: "Corrected" },
      })
    ).id,
  );
  assert.equal(recovered.status, "completed", recovered.error);
  assert.equal(recovered.parentId, base.id);
  assert.equal(store.get(base.id).outline.slides[0].title, "Original");
});

test("shared slide layout enlarges figures, preserves readable text, and uses concise page citations", () => {
  for (const sentence of [
    "研究跨越急性应激、端粒酶表达、活细胞动力学与小鼠组织观察。",
    "检验结果（比较对照），再看证据。",
  ]) {
    const lines = wrapSlideText(sentence, 3.5, 20);
    assert.equal(lines.join(""), sentence);
    assert.ok(lines.every((line) => !/^[，。；：！？、）]/.test(line)));
  }
  const boundaryText = "损伤形成后处理：检验缓解作用";
  const boundaryLines = wrapSlideText(boundaryText, 3.5, 18);
  assert.ok(boundaryLines.length > 1);
  assert.equal(boundaryLines.join(""), boundaryText);
  assert.ok(
    wrapSlideText("1,000–1,499层与较低风险相关", 3.5, 18).some((line) =>
      line.includes("1,000–1,499"),
    ),
  );
  const s = {
    title: "Evidence",
    bullets: ["Compare outcome with control", "Interpret the uncertainty"],
    notes: "Notes",
    citations: ["s"],
    imageSource: "s",
  };
  const layout = slideLayout(
    s,
    [
      {
        id: "s",
        title: "Extremely long source title ".repeat(20),
        kind: "paper",
        text: "",
        locator: "Long locator ".repeat(30),
        page: 4,
        figure: "2",
        verified: false,
      },
    ],
    { width: 1900, height: 1000 },
  );
  assert.ok(layout.image!.w > 7.8);
  assert.ok(layout.text.slice(1, -1).every((b) => b.fontSize >= 17));
  assert.deepEqual(layout.text.at(-1)!.lines, ["Fig. 2 · p. 4"]);
  assert.equal(
    citationLabel([
      {
        id: "page",
        title: "PDF 4",
        kind: "paper",
        text: "",
        locator: "",
        page: 4,
        verified: false,
      },
      {
        id: "fig",
        title: "Figure 2",
        kind: "paper",
        text: "",
        locator: "",
        page: 4,
        figure: "2",
        verified: false,
      },
    ]),
    "Fig. 2 · p. 4",
  );
});

test("text-only slide layout uses content-aware spacing and numbered visual anchors", () => {
  const layout = slideLayout(
    {
      title: "三层证据",
      bullets: ["第一层观察", "第二层验证"],
      notes: "",
      citations: ["s"],
    },
    [
      {
        id: "s",
        title: "PDF",
        kind: "paper",
        text: "",
        locator: "p. 1",
        page: 1,
        verified: false,
      },
    ],
  );
  const bullets = layout.text.filter((b) => b.role === "bullet");
  assert.equal(bullets.length, 2);
  assert.deepEqual(
    bullets.map((b) => b.marker),
    ["01", "02"],
  );
  assert.ok(bullets[0].y < 2);
  assert.ok(bullets[1].y - bullets[0].y < 1);
  assert.ok(bullets.every((b) => b.x > 1));
});

test("slide compositions preserve all content within the canvas and keep molecular labels intact", () => {
  const bullets = [
    "模型：人 MRC5 成纤维细胞和小鼠组织",
    "干预：比较处理组与对照组",
    "定位：观察损伤灶与端粒共定位",
    "验证：ChIP 检测亚端粒区域 γH2A.X 富集",
    "结论边界：相关性不能直接证明因果",
  ];
  const layout = slideLayout(
    { title: "实验设计", bullets, notes: "讲稿不进入页面", citations: [] },
    [],
  );
  const boxes = layout.text.filter((b) => b.role === "bullet");
  assert.equal(layout.composition, "methods");
  assert.ok(boxes[1].x > boxes[0].x + boxes[0].w);
  for (const [i, b] of boxes.entries()) {
    assert.equal(
      b.lines.join("").replace(/\s/g, ""),
      bullets[i].replace(/\s/g, ""),
    );
    assert.ok(b.x + b.w <= 13.34 && b.y + b.h < 6.8);
    for (const next of boxes.slice(i + 1)) {
      const intersect =
        b.x < next.x + next.w &&
        next.x < b.x + b.w &&
        b.y < next.y + next.h &&
        next.y < b.y + b.h;
      assert.equal(intersect, false);
    }
  }
  assert.ok(boxes[3].lines.some((l) => l.includes("γH2A.X")));
  const steps = slideLayout(
    {
      title: "研究路径",
      bullets: bullets.slice(0, 3),
      notes: "",
      citations: [],
    },
    [],
  ).text.filter((b) => b.role === "bullet");
  assert.equal(new Set(steps.map((b) => b.y)).size, 1);
  assert.equal(new Set(steps.map((b) => b.x)).size, 3);
});

test("scientific slide emphasis preserves labels, values and every source bullet", () => {
  const examples = [
    {
      title: "背景与研究问题",
      bullets: [
        "对象：454名社区居民",
        "背景：多维衰弱",
        "问题：失眠是否与衰弱相关？",
        "目标：评估关联",
      ],
      expected: "question",
    },
    {
      title: "关键结果",
      bullets: [
        "平均年龄：69.1岁",
        "失眠：211/454（46.5%）",
        "衰弱：185/454（40.7%）",
        "关联涉及三个维度",
        "调整后OR 6.863（95% CI 4.237–11.116）",
      ],
      expected: "results",
    },
    {
      title: "关键证据：主要复合终点",
      bullets: [
        "主要终点：心血管死亡、非致死性心肌梗死或非致死性卒中",
        "恩格列净合并组：490/4687（10.5%）",
        "安慰剂组：282/2333（12.1%）",
        "HR 0.86（95.02% CI 0.74–0.99）",
        "优效性P=0.04：达到统计学显著",
      ],
      expected: "results",
    },
    {
      title: "结果结构：各终点并不一致",
      bullets: [
        "心血管死亡：3.7% vs 5.9%；相对降低38%",
        "心衰住院：2.7% vs 4.1%；相对降低35%",
        "全因死亡：5.7% vs 8.3%；相对降低32%",
        "心肌梗死、卒中：组间差异均不显著",
        "关键次要复合终点：优效性P=0.08，未达显著",
      ],
      expected: "comparisons",
    },
    {
      title: "局限与研究启发",
      bullets: [
        "不能建立时间先后",
        "存在混杂",
        "关联不等于因果",
        "摘要缺模型细节",
        "可借鉴：进一步纵向研究",
      ],
      expected: "takeaway",
    },
  ];
  for (const example of examples) {
    const layout = slideLayout(
      { ...example, notes: "不放入页面", citations: [] },
      [],
    );
    assert.equal(layout.composition, example.expected);
    const body = layout.text.filter((b) => b.role === "bullet");
    for (const [i, original] of example.bullets.entries()) {
      assert.equal(
        body
          .filter((b) => b.sourceIndex === i)
          .flatMap((b) => b.lines)
          .join("")
          .replace(/\s/g, ""),
        original.replace(/\s/g, ""),
      );
    }
    for (const [i, b] of body.entries()) {
      assert.ok(
        b.fontSize >= 18 && b.x >= 0.5 && b.y + b.h < 6.8 && b.x + b.w < 12.9,
      );
      assert.ok(
        body
          .slice(i + 1)
          .every(
            (next) =>
              !(
                b.x < next.x + next.w &&
                next.x < b.x + b.w &&
                b.y < next.y + next.h &&
                next.y < b.y + b.h
              ),
          ),
      );
    }
  }
});

test("mixed Latin and Chinese lines fit the actual export font width", () => {
  const context = createCanvas(1, 1).getContext("2d");
  context.font = "18pt Microsoft YaHei";
  for (const text of [
    "ABC阴性后DEF、ABC阳性后DEF",
    "五个选项：无检测、ABC、DEF、",
  ]) {
    for (const line of wrapSlideText(text, 3.5, 18)) {
      assert.ok(
        context.measureText(line).width <= 3.5 * 96,
        "The estimated line must fit the real export font: " + line,
      );
    }
  }
});


test("slide wrapping keeps digit-leading scientific identifiers intact without changing scientific text", () => {
  const context = createCanvas(1, 1).getContext("2d");
  context.font = "19pt Microsoft YaHei";
  for (const token of ["53BP1", "4EBP1", "5hmC", "3D"]) {
    const text = "抗ATM反向捕获：检出" + token + "，未检出SUZ12";
    const lines = wrapSlideText(text, 3.5, 19);
    assert.equal(lines.join(""), text);
    assert.ok(lines.some((line) => line.includes(token)), "Identifier must stay in one line: " + token);
    for (const line of lines)
      assert.ok(context.measureText(line).width <= 3.5 * 96, "Actual font width overflow: " + line);
  }
});
