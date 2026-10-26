import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import {
  verifyTrainingDeliveryFiles,
  trainingGuidance,
} from "../server/training-delivery.ts";
import type { LearningProduct } from "../server/learning-exposure.ts";
import type { Provider } from "../server/provider.ts";
import type { DeckOutline, ReviewResult } from "../shared/types.ts";
import { sample, exampleUnits } from "../examples/bundle.ts";
import { groundedTeachingSchema } from "../server/schemas.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { ResultCache } from "../server/cache.ts";
import { exportDeck } from "../server/export.ts";
import { wrapSlideText, slideLayout } from "../shared/slide-layout.ts";
import {
  pptLayoutIssues,
  withPptLayoutReview,
} from "../server/ppt-layout-review.ts";

const canvas = createCanvas(800, 500);
canvas.getContext("2d").fillRect(20, 20, 760, 460);
const paper = {
  ...sample,
  sources: sample.sources.map((source) =>
    source.id === "xu-fig1"
      ? { ...source, image: canvas.toDataURL("image/png") }
      : source,
  ),
};
const unit = {
  ...exampleUnits.paper,
  sections: exampleUnits.paper.sections.slice(0, 2),
  terms: [],
};
const dense: DeckOutline = {
  slides: [
    {
      title: "工程测试页面",
      bullets: Array.from({ length: 3 }, () => "工程排版测试字符".repeat(14)),
      notes: "仅用于检验文字是否能在固定图页空间内完整排版。",
      citations: ["xu-fig1"],
      imageSource: "xu-fig1",
    },
  ],
};
const compact: DeckOutline = {
  slides: [
    {
      ...dense.slides[0],
      bullets: ["工程比较：保留主结果", "必要限定：不扩展结论"],
    },
  ],
};
const clear: ReviewResult = {
  issues: [],
  checkedSources: ["xu-fig1"],
  limitations: ["工程流程测试，不评价科学主张。"],
};

function provider(outputs: unknown[]): Provider {
  return {
    model: "fixture-test-only",
    async generate<T>(
      _instructions: string,
      _input: unknown,
      schema: import("zod").z.ZodType<T>,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      assert.ok(outputs.length, "unexpected extra model request");
      return { output: schema.parse(outputs.shift()) };
    },
  };
}
async function runDeck(revised: DeckOutline, finalReview = clear) {
  const manager = new TaskManager(
    provider([
      { unit, deck: dense },
      clear,
      { unit, deck: revised },
      finalReview,
    ]),
    async () => {},
    "online",
  );
  const run = await manager.start(
    {
      paperId: paper.id,
      module: "ppt",
      mode: "live",
      question: "工程验证一页图件汇报",
      profileId: "beginner",
      sourceIds: paper.sources.map((s) => s.id),
      taughtConcepts: [],
      slideCount: 1,
      checks: { readability: false, reason: "工程排版回归" },
    },
    paper,
  );
  await manager.wait(run.id);
  return run;
}

test("schema-valid figure text can exceed real layout capacity; text-only capacity differs", () => {
  assert.equal(
    groundedTeachingSchema(paper.sources).safeParse({ unit, deck: dense })
      .success,
    true,
  );
  assert.throws(
    () =>
      slideLayout(dense.slides[0], paper.sources, { width: 800, height: 500 }),
    /过密/,
  );
  const issues = pptLayoutIssues(dense, paper.sources);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "blocking");
  assert.deepEqual(
    pptLayoutIssues(
      { slides: [{ ...dense.slides[0], imageSource: "" }] },
      paper.sources,
    ),
    [],
  );
  assert.deepEqual(pptLayoutIssues(compact, paper.sources), []);
});

test("clear model reviews still trigger one layout repair, and repaired product exports", async () => {
  const run = await runDeck(compact);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.calls, 4);
  assert.deepEqual(
    run.roles.map((r) => r.role),
    ["teaching", "grounding", "revision", "grounding-final"],
  );
  const revision = run.roles.find((r) => r.role === "revision")!.input as any;
  assert.equal(revision.review.issues[0].severity, "blocking");
  assert.equal(
    run.review!.issues.find((i) => i.id === "ppt-layout-1")!.resolved,
    true,
  );
  const output = await exportDeck(
    run.deck!,
    paper,
    "layout-regression-" + randomUUID(),
  );
  try {
    assert.ok((await readFile(output)).length > 1000);
  } finally {
    await unlink(output);
  }
});

test("model-resolved layout issue remains blocking when revised page still cannot fit", async () => {
  const initial = withPptLayoutReview(clear, dense, paper.sources);
  const claimsResolved = {
    ...clear,
    issues: initial.issues.map((i) => ({ ...i, resolved: true })),
  };
  const run = await runDeck(dense, claimsResolved);
  assert.equal(run.status, "failed");
  assert.equal(run.calls, 4);
  assert.equal(run.deck, undefined);
  assert.match(run.error!, /过密/);
  assert.equal(
    run.review!.issues.find((i) => i.id === "ppt-layout-1")!.resolved,
    false,
  );
});

test("cached completed figure deck is rechecked before delivery", async () => {
  const repaired = await runDeck(compact);
  const stale = {
    ...repaired,
    id: "legacy-layout-cache",
    deck: dense,
    review: clear,
  };
  const cache = new ResultCache(
    "fixture-cache",
    async () => {},
    async <T>() => stale as unknown as T,
  );
  const manager = new TaskManager(provider([]), async () => {}, "online");
  const run = await manager.start(
    {
      paperId: paper.id,
      module: "ppt",
      mode: "live",
      question: "工程缓存回归",
      profileId: "beginner",
      sourceIds: paper.sources.map((s) => s.id),
      taughtConcepts: [],
      checks: { readability: false, reason: "工程缓存回归" },
    },
    paper,
    undefined,
    undefined,
    { cache },
  );
  await manager.wait(run.id);
  assert.equal(run.cacheHit, stale.id);
  assert.equal(run.status, "failed");
  assert.equal(run.calls, 0);
  assert.match(run.error!, /过密/);
});

test("wide evidence gets more image area while preserving every claim and the full image", () => {
  const slide = {
    ...compact.slides[0],
    bullets: ["横轴为效应量，纵轴列出各研究", "区间较宽，不能据点估计断言差异"],
  };
  const wide = slideLayout(slide, paper.sources, { width: 2100, height: 700 });
  assert.equal(wide.composition, "evidence-wide");
  assert.ok(
    wide.image!.w > 11,
    "A wide figure should use more than the old 7.95-inch column",
  );
  assert.ok(Math.abs(wide.image!.w / wide.image!.h - 3) < 1e-9);
  const text = wide.text.filter((box) => box.role === "bullet");
  assert.deepEqual(
    text.map((box) => box.lines.join("")),
    slide.bullets,
  );
  assert.ok(
    text.every(
      (box) =>
        box.fontSize >= 20 && box.y >= wide.image!.y + wide.image!.h + 0.2,
    ),
  );
  assert.ok(text.every((box) => box.y + box.h <= 6.68 + 1e-9));
  const portrait = slideLayout(slide, paper.sources, {
    width: 700,
    height: 1400,
  });
  assert.equal(portrait.composition, "evidence");
  assert.ok(Math.abs(portrait.image!.w / portrait.image!.h - 0.5) < 1e-9);
  assert.throws(
    () =>
      slideLayout(dense.slides[0], paper.sources, { width: 2100, height: 700 }),
    /过密/,
  );
});

test("four-line figure captions keep a wider original when it still gains usable image area", () => {
  const bullets = [
    "A｜登记起点→事件完成：中位数12.0 vs 15.0小时；调整后风险比（aHR）1.50（95% CI，1.10–2.10），干预组 vs 对照组。",
    "B｜干预启动→事件完成：中位数8.0 vs 11.0小时；aHR 1.30（95% CI，1.01–1.70），干预组 vs 对照组。",
  ];
  const slide = { ...compact.slides[0], bullets };
  const layout = slideLayout(slide, paper.sources, {
    width: 2700,
    height: 1000,
  });
  assert.equal(layout.composition, "evidence-wide");
  assert.ok(layout.image!.w >= 7.95 * 1.12);
  assert.ok(Math.abs(layout.image!.w / layout.image!.h - 2.7) < 1e-9);
  const boxes = layout.text.filter((box) => box.role === "bullet");
  assert.equal(Math.max(...boxes.map((box) => box.lines.length)), 4);
  assert.deepEqual(
    boxes.map((box) => box.lines.join("").replace(/\s/g, "")),
    bullets.map((text) => text.replace(/\s/g, "")),
  );
  assert.ok(
    boxes.every(
      (box) =>
        box.fontSize === 20 &&
        box.y >= layout.image!.y + layout.image!.h + 0.2 &&
        box.y + box.h <= 6.68 + 1e-9,
    ),
  );
  const noGain = slideLayout(slide, paper.sources, {
    width: 1800,
    height: 1000,
  });
  assert.equal(noGain.composition, "evidence");
  assert.ok(noGain.image!.w >= 7.95);
  assert.throws(
    () =>
      slideLayout(
        {
          ...slide,
          bullets: [
            bullets[0] +
              "这项比较仍需较长的额外说明，不能继续压缩图件来容纳文字。".repeat(
                4,
              ),
            bullets[1],
          ],
        },
        paper.sources,
        { width: 2700, height: 1000 },
      ),
    /过密/,
  );
});

test("actual PPT export preserves a selected crop and rejects changed image placement", async () => {
  const sourceImage = createCanvas(2100, 1400);
  const ctx = sourceImage.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 2100, 1400);
  ctx.fillStyle = "#245968";
  ctx.fillRect(40, 40, 2020, 620);
  const localPaper = {
    ...paper,
    sources: paper.sources.map((source) =>
      source.id === "xu-fig1"
        ? { ...source, image: sourceImage.toDataURL("image/png") }
        : source,
    ),
  };
  const deck: DeckOutline = {
    slides: [
      {
        ...compact.slides[0],
        imageCrop: { left: 0, top: 0, width: 1, height: 0.5 },
      },
      {
        ...compact.slides[0],
        title: "记录与比较",
        imageSource: "",
        bullets: ["记录对象", "比较分母", "不确定性", "推广范围"],
      },
    ],
  };
  const path = await exportDeck(
    deck,
    localPaper,
    "wide-delivery-" + randomUUID(),
  );
  const guidancePath = path.replace(/\.pptx$/, "-guidance.md");
  const product: LearningProduct = {
    id: "wide-delivery",
    side: "candidate",
    status: "generated",
    exportPath: path,
    artifact: { deck },
    delivery: { version: "separate-guidance-v1", guidancePath },
  };
  try {
    await writeFile(guidancePath, trainingGuidance(deck));
    const parts = unzipSync(await readFile(path));
    const slide = strFromU8(parts["ppt/slides/slide1.xml"]);
    const picture = /<p:pic\b[\s\S]*?<\/p:pic>/.exec(slide)![0];
    const imageWidth = Number(/<a:ext\b[^>]*cx="(\d+)"/.exec(picture)![1]);
    assert.ok(
      imageWidth > 11 * 914400,
      "Actual exported crop should exceed the old figure column",
    );
    assert.equal(
      (await verifyTrainingDeliveryFiles(product, localPaper)).slides,
      2,
    );
    const changedPicture = picture.replace(
      /(<a:off\b[^>]*x=")(\d+)/,
      (_all, before, value) => before + (Number(value) + 914400),
    );
    assert.notEqual(changedPicture, picture);
    parts["ppt/slides/slide1.xml"] = strToU8(
      slide.replace(picture, changedPicture),
    );
    await writeFile(path, zipSync(parts));
    await assert.rejects(
      verifyTrainingDeliveryFiles(product, localPaper),
      /图件位置/,
    );
  } finally {
    await Promise.all([unlink(path), unlink(guidancePath)]);
  }
});

test("semantic diagrams preserve scientific text and keep process arrows separate from comparisons", async () => {
  const { deckSchema } = await import("../server/schemas.ts");
  const { unzipSync, strFromU8 } = await import("fflate");
  const bullets = [
    "急诊入组：记录基线检验与液体分配",
    "重复检测：确认生化缓解条件",
    "比较：估计缓解时间及95%区间",
  ];
  const slide = {
    title: "从采样到组间比较",
    bullets,
    notes: "提示单独交付",
    citations: [paper.sources[0].id],
    layout: "flow" as const,
  };
  const parsed = deckSchema.parse({ slides: [slide] });
  assert.equal(parsed.slides[0].layout, "flow");
  const flow = slideLayout(slide, paper.sources);
  assert.equal(flow.composition, "flow");
  assert.equal(
    flow.shapes.filter((shape) => shape.kind === "chevron").length,
    2,
  );
  const boxes = flow.text.filter((box) => box.role === "bullet");
  assert.deepEqual(
    boxes.map((box) => box.lines.join("")),
    bullets,
  );
  assert.ok(
    boxes.every(
      (box) => box.fontSize >= 20 && box.x + box.w < 13 && box.y + box.h < 6.7,
    ),
  );
  const comparison = slideLayout(
    { ...slide, layout: "comparison", bullets: bullets.slice(0, 2) },
    paper.sources,
  );
  assert.equal(comparison.composition, "comparison");
  assert.equal(
    comparison.shapes.some((shape) => shape.kind === "chevron"),
    false,
  );
  assert.throws(
    () => slideLayout({ ...slide, bullets: ["只有一步"] }, paper.sources),
    /二至六/,
  );
  assert.throws(
    () => slideLayout({ ...slide, layout: "comparison" }, paper.sources),
    /两项/,
  );
  assert.throws(
    () => slideLayout(slide, paper.sources, { width: 800, height: 500 }),
    /原图/,
  );
  const output = await exportDeck(
    parsed,
    paper,
    "diagram-regression-" + randomUUID(),
  );
  try {
    const zip = unzipSync(await readFile(output));
    const xml = strFromU8(zip["ppt/slides/slide1.xml"]);
    assert.equal((xml.match(/prst="chevron"/g) ?? []).length, 2);
    assert.equal((xml.match(/prst="roundRect"/g) ?? []).length, 3);
    for (const value of bullets)
      assert.ok(
        xml
          .replace(/<[^>]+>/g, "")
          .replace(/\s/g, "")
          .includes(value.replace(/\s/g, "")),
      );
    assert.equal(xml.includes("提示单独交付"), false);
  } finally {
    await unlink(output);
  }
});

test("spotlight keeps a research question and explanations visible without inventing a process", () => {
  const slide = {
    title: "为什么改变测量路径",
    bullets: [
      "研究目的：比较两种液体与DKA缓解时间的关联",
      "关键缺口：常规检测无法提供连续事件时间",
      "解释：测量规则影响跨医院复现",
    ],
    notes: "",
    citations: [],
    layout: "spotlight" as const,
  };
  const layout = slideLayout(slide, []);
  assert.equal(layout.composition, "spotlight");
  assert.deepEqual(
    layout.text
      .filter((box) => box.role === "bullet")
      .map((box) => box.lines.join("")),
    slide.bullets,
  );
  assert.equal(
    layout.shapes.some((shape) => shape.kind === "chevron"),
    false,
  );
  assert.throws(
    () =>
      slideLayout({ ...slide, bullets: [...slide.bullets, "额外论点"] }, []),
    /至多两项/,
  );
});

test("source footers keep table identifiers and visibly mark omitted long text", () => {
  const sources = [
    {
      ...paper.sources[0],
      id: "table",
      page: undefined,
      figure: undefined,
      title:
        "Table 2 Effect of tranexamic acid on bleeding death and complications",
    },
    ...Array.from({ length: 12 }, (_, i) => ({
      ...paper.sources[0],
      id: "long-" + i,
      page: undefined,
      figure: undefined,
      title:
        "Methods details " +
        i +
        " with a long descriptive source locator repeated",
    })),
  ];
  const slide = {
    title: "结果",
    bullets: ["主比较及区间"],
    notes: "",
    citations: sources.map((s) => s.id),
  };
  const footer = slideLayout(slide, sources).text.find(
    (box) => box.role === "footer",
  )!;
  assert.match(footer.lines[0], /^Table 2/);
  assert.equal(footer.lines.length, 2);
  assert.ok(footer.lines[1].endsWith("…"));
  assert.ok(footer.y + footer.h <= 7.5);
});

test("long ordered procedures use wide rows without rewriting or dropping any steps", async () => {
  const bullets = [
    "采样前记录处理条件与对照来源，随后以8°C盐水75 mL，15 mL/min实施局部操作。",
    "在同一固定时间窗口完成主要操作，保留各组一致的读出流程。",
    "操作后完成两项预先固定的测量，按原始组别估计差异并保留全部关键条件。",
    "最后完成盲法结局评价，保留缺失状态及统一随访窗口，不直接推断临床获益。",
  ];
  const slide = {
    title: "操作与结局评价流程",
    bullets,
    notes: "工程夹具，验证步骤文本与布局。",
    citations: [paper.sources[0].id],
    layout: "flow" as const,
  };
  const layout = slideLayout(slide, paper.sources);
  const boxes = layout.text.filter((box) => box.role === "bullet");
  assert.deepEqual(
    boxes.map((box) => box.lines.join("").replace(/\s/g, "")),
    bullets.map((value) => value.replace(/\s/g, "")),
  );
  assert.ok(boxes.every((box) => box.w > 10 && box.fontSize === 24));
  assert.deepEqual(
    boxes.map((box) => box.marker),
    ["01", "02", "03", "04"],
  );
  boxes.forEach((box, i) => {
    assert.ok(box.y + box.h < 6.7);
    if (i) assert.ok(box.y >= boxes[i - 1].y + boxes[i - 1].h);
  });
  for (const measurement of ["8°C", "75 mL", "15 mL/min"])
    assert.ok(boxes[0].lines.some((line) => line.includes(measurement)));
  const output = await exportDeck(
    { slides: [slide] },
    paper,
    "long-flow-" + randomUUID(),
  );
  try {
    const zip = unzipSync(await readFile(output));
    const xml = strFromU8(zip["ppt/slides/slide1.xml"]);
    for (const value of bullets)
      assert.ok(
        xml
          .replace(/<[^>]+>/g, "")
          .replace(/\s/g, "")
          .includes(value.replace(/\s/g, "")),
      );
  } finally {
    await unlink(output);
  }
  assert.throws(
    () =>
      slideLayout(
        {
          ...slide,
          bullets: bullets.map(() => "无法容纳的必要条件".repeat(90)),
        },
        paper.sources,
      ),
    /过密/,
  );
});

test("numeric comparison tables preserve every cell, align columns and export native editable tables", async () => {
  const { deckSchema } = await import("../server/schemas.ts");
  const rows = [
    "阈值（pg/mL） | 敏感度（95% CI） | 特异度（95% CI）",
    "125 | 98.8%（98.5–99.1） | 13.2%（12.6–13.7）",
    "400 | 93.2%（92.4–93.9） | 35.5%（34.7–36.3）",
  ];
  const parsed = deckSchema.parse({
    slides: [
      {
        title: "提高阈值的检出与误报取舍",
        bullets: rows,
        notes: "完整讲述提示另行交付",
        citations: [paper.sources[0].id],
        layout: "table",
      },
    ],
  });
  const layout = slideLayout(parsed.slides[0], paper.sources);
  assert.equal(layout.composition, "table");
  const cells = layout.text.filter((box) => box.role === "bullet");
  assert.equal(cells.length, 9);
  assert.deepEqual(
    cells.map((box) => box.lines.join("")),
    rows.flatMap((row) => row.split("|").map((cell) => cell.trim())),
  );
  for (let row = 0; row < 3; row++) {
    const group = cells.slice(row * 3, row * 3 + 3);
    assert.equal(new Set(group.map((box) => box.y)).size, 1);
    assert.ok(
      group.every(
        (box) =>
          box.fontSize >= 20 && box.x + box.w < 13 && box.y + box.h < 6.7,
      ),
    );
    if (row)
      assert.ok(group[0].y >= cells[(row - 1) * 3].y + cells[(row - 1) * 3].h);
    group.forEach((box, col) => assert.equal(box.x, cells[col].x));
  }
  assert.equal(
    layout.shapes.some((shape) => shape.kind === "chevron"),
    false,
  );
  const output = await exportDeck(
    parsed,
    paper,
    "table-regression-" + randomUUID(),
  );
  try {
    const zip = unzipSync(await readFile(output));
    const xml = strFromU8(zip["ppt/slides/slide1.xml"]);
    assert.equal(xml.includes("完整讲述提示另行交付"), false);
    assert.equal((xml.match(/<a:tbl>/g) ?? []).length, 1);
    assert.equal((xml.match(/<a:tr\b/g) ?? []).length, 3);
    assert.equal((xml.match(/<a:tc>/g) ?? []).length, 9);
    assert.equal((xml.match(/<a:t>125<\/a:t>/g) ?? []).length, 1);
    for (const cell of rows.flatMap((row) =>
      row.split("|").map((value) => value.trim()),
    ))
      assert.ok(
        xml
          .replace(/<[^>]+>/g, "")
          .replace(/\s/g, "")
          .includes(cell.replace(/\s/g, "")),
      );
    assert.equal((xml.match(/<p:pic>/g) ?? []).length, 0);
    const guidancePath = output.replace(/\.pptx$/, ".md");
    await writeFile(guidancePath, trainingGuidance(parsed));
    try {
      await verifyTrainingDeliveryFiles(
        {
          id: "table",
          side: "candidate",
          status: "generated",
          artifact: { deck: parsed },
          exportPath: output,
          delivery: { version: "separate-guidance-v1", guidancePath },
        },
        paper,
      );
    } finally {
      await unlink(guidancePath);
    }
  } finally {
    await unlink(output);
  }
});

test("five-column threshold tables retain both groups and every confidence interval", async () => {
  const rows = [
    "指标，%（95% CI） | 房颤125 | 房颤400 | 无房颤125 | 无房颤400",
    "敏感度 | 98.8（98.5–99.1） | 93.2（92.4–93.9） | 92.9（92.4–93.4） | 77.1（76.3–77.9）",
    "特异度 | 13.2（12.6–13.7） | 35.5（34.7–36.3） | 53.8（53.6–54.1） | 84.9（84.7–85.1）",
    "阴性预测值 | 97.3（96.5–98.0） | 94.3（93.6–94.9） | 98.9（98.9–99.0） | 97.8（97.8–97.9）",
  ];
  const deck: DeckOutline = {
    slides: [
      {
        title: "两组在125与400 pg/mL阈值的取舍",
        bullets: rows,
        notes: "每列含组别与阈值，所有数值为百分比。",
        citations: [paper.sources[0].id],
        layout: "table",
      },
    ],
  };
  const layout = slideLayout(deck.slides[0], paper.sources);
  assert.ok(layout.table);
  assert.equal(layout.table.widths.length, 5);
  assert.ok(layout.table.fontSize >= 20);
  assert.ok(layout.table.y + layout.table.h <= 6.7);
  const output = await exportDeck(
    deck,
    paper,
    "five-column-table-" + randomUUID(),
  );
  try {
    const zip = unzipSync(await readFile(output));
    const xml = strFromU8(zip["ppt/slides/slide1.xml"]);
    assert.equal((xml.match(/<a:gridCol\b/g) ?? []).length, 5);
    assert.equal((xml.match(/<a:tr\b/g) ?? []).length, 4);
    assert.equal((xml.match(/<a:tc>/g) ?? []).length, 20);
    const text = xml.replace(/<[^>]+>/g, "").replace(/\s/g, "");
    for (const cell of rows.flatMap((row) =>
      row.split("|").map((cell) => cell.trim()),
    ))
      assert.ok(text.includes(cell.replace(/\s/g, "")), cell);
    const guidancePath = output.replace(/\.pptx$/, ".md");
    await writeFile(guidancePath, trainingGuidance(deck));
    try {
      await verifyTrainingDeliveryFiles(
        {
          id: "five-column",
          side: "candidate",
          status: "generated",
          artifact: { deck },
          exportPath: output,
          delivery: { version: "separate-guidance-v1", guidancePath },
        },
        paper,
      );
    } finally {
      await unlink(guidancePath);
    }
  } finally {
    await unlink(output);
  }
});

test("tables reject missing cells, separator rows and excessive density rather than fabricate or hide values", () => {
  const slide = {
    title: "同指标比较",
    bullets: ["阈值 | 敏感度", "125 | 98.8%", "400 | 93.2%"],
    notes: "提示",
    citations: [paper.sources[0].id],
    layout: "table" as const,
  };
  for (const bullets of [
    ["阈值 | 敏感度", "125"],
    ["阈值 | 敏感度", "125 | "],
    ["阈值 | 敏感度", "--- | ---", "125 | 98.8%"],
    ["单列", "125"],
  ])
    assert.throws(
      () => slideLayout({ ...slide, bullets }, paper.sources),
      /表格/,
    );
  assert.throws(
    () => slideLayout(slide, paper.sources, { width: 800, height: 500 }),
    /原图/,
  );
  assert.throws(
    () =>
      slideLayout(
        {
          ...slide,
          bullets: [
            "阈值 | 条件",
            ...Array.from(
              { length: 4 },
              () => "125 | " + "不可省略的条件".repeat(20),
            ),
          ],
        },
        paper.sources,
      ),
    /过密/,
  );
  const unknown = slideLayout(
    { ...slide, bullets: ["阈值 | 区间", "660 | 未报告"] },
    paper.sources,
  );
  assert.equal(
    unknown.text
      .filter((box) => box.role === "bullet")
      .at(-1)
      ?.lines.join(""),
    "未报告",
  );
  const ordinary = slideLayout({ ...slide, layout: "auto" }, paper.sources);
  assert.notEqual(ordinary.composition, "table");
});

test("tables keep complete short headers when all columns fit at the original font", () => {
  const rows = [
    "Hospital 1 | 低阈值／敏感度（95% CI） | 高阈值／特异度（95% CI）",
    "原模型 | 0.080／93%（89%—96%） | 0.400／86%（84%—87%）",
    "本地更新后 | 0.026／90%（86%—93%） | 0.130／86%（85%—88%）",
  ];
  const layout = slideLayout(
    {
      title: "本地概率阈值与分类表现",
      bullets: rows,
      notes: "排版回归用例，数值不构成诊疗建议。",
      citations: [paper.sources[0].id],
      layout: "table",
    },
    paper.sources,
  );
  const cells = layout.text.filter((box) => box.role === "bullet");
  assert.deepEqual(
    cells.map((box) => box.lines),
    rows.flatMap((row) => row.split("|").map((cell) => [cell.trim()])),
  );
  assert.ok(cells.every((cell) => cell.fontSize === 23));
  for (let row = 0; row < rows.length; row++) {
    const group = cells.slice(row * 3, row * 3 + 3);
    group.forEach((cell, col) => {
      assert.ok(cell.x + cell.w <= 12.62);
      assert.equal(cell.x, cells[col].x);
      if (col) assert.ok(cell.x >= group[col - 1].x + group[col - 1].w);
    });
  }
});

test("four-column clinical tables fit bold headers and retain complete intervals", () => {
  const rows = [
    "阈值（pg/mL） | 敏感度%，95% CI | 特异度%，95% CI | 阴性预测值%，95% CI",
    "125 | 98.8（98.5–99.1） | 13.2（12.6–13.7） | 97.3（96.5–98.0）",
    "400 | 93.2（92.4–93.9） | 35.5（34.7–36.3） | 94.3（93.6–94.9）",
    "660 | 未报告 | 未报告 | >90，区间未报告",
  ];
  const layout = slideLayout(
    {
      title: "不同阈值的检出与排除表现",
      bullets: rows,
      notes: "排版回归用例",
      citations: [paper.sources[0].id],
      layout: "table",
    },
    paper.sources,
  );
  const cells = layout.text.filter((box) => box.role === "bullet");
  assert.deepEqual(
    cells.map((cell) => cell.lines.join("").replace(/\s/g, "")),
    rows.flatMap((row) =>
      row.split("|").map((cell) => cell.replace(/\s/g, "")),
    ),
  );
  const context = createCanvas(1, 1).getContext("2d");
  cells.forEach((cell) => {
    assert.equal(cell.fontSize, 23);
    context.font =
      (cell.bold ? "bold " : "") + cell.fontSize + "pt Microsoft YaHei";
    for (const line of cell.lines)
      assert.ok(
        context.measureText(line).width <= cell.w * 96,
        "Actual table font overflow: " + line,
      );
    assert.ok(cell.y + cell.h < 6.7);
  });
});

test("paired calibration panels gain space without changing captions or shrinking their text", async () => {
  const bullets = [
    "医院1：原模型总体高估风险；更新后校准关系更接近理想对角线",
    "预测概率向低值移动，排序保持不变；高风险部分仍有偏离与较宽误差线",
  ];
  const figure = createCanvas(1410, 697);
  const localPaper = {
    ...paper,
    sources: paper.sources.map((s) =>
      s.id === "xu-fig1" ? { ...s, image: figure.toDataURL("image/png") } : s,
    ),
  };
  const slide = { ...compact.slides[0], bullets };
  const layout = slideLayout(slide, localPaper.sources, {
    width: 1410,
    height: 697,
  });
  assert.equal(layout.composition, "evidence-wide");
  assert.ok(layout.image!.w >= 7.95 * 1.05);
  assert.ok(Math.abs(layout.image!.w / layout.image!.h - 1410 / 697) < 1e-9);
  const captions = layout.text.filter((b) => b.role === "bullet");
  assert.deepEqual(
    captions.map((b) => b.lines.join("")),
    bullets,
  );
  assert.ok(
    captions.every(
      (b) =>
        b.fontSize === 20 &&
        b.y >= layout.image!.y + layout.image!.h + 0.2 &&
        b.y + b.h <= 6.68 + 1e-9,
    ),
  );
  const deck = { slides: [slide] };
  const output = await exportDeck(
    deck,
    localPaper,
    "paired-panel-space-" + randomUUID(),
  );
  const guidancePath = output.replace(/\.pptx$/, "-guidance.md");
  try {
    await writeFile(guidancePath, trainingGuidance(deck));
    const xml = strFromU8(
      unzipSync(await readFile(output))["ppt/slides/slide1.xml"],
    );
    const pic = /<p:pic\b[\s\S]*?<\/p:pic>/.exec(xml)![0];
    const width = Number(/<a:ext\b[^>]*cx="(\d+)"/.exec(pic)![1]);
    assert.ok(Math.abs(width / 914400 - layout.image!.w) < 1e-5);
    assert.equal(
      (
        await verifyTrainingDeliveryFiles(
          {
            id: "paired-panels",
            side: "candidate",
            status: "generated",
            exportPath: output,
            artifact: { deck },
            delivery: { version: "separate-guidance-v1", guidancePath },
          },
          localPaper,
        )
      ).slides,
      1,
    );
  } finally {
    await unlink(output);
    await unlink(guidancePath).catch(() => {});
  }
});

test("Latin row labels stay whole beside long mixed-language headers", () => {
  const rows = [
    "医院 | 原模型：低风险阈值；敏感度（95% CI） | 本地更新后：低风险阈值；敏感度（95% CI）",
    "Mbagathi | 0.08；93%（89%–96%） | 0.026；90%（86%–93%）",
    "Kiambu | 阈值未报告；81%（74%–88%） | 0.020；84%（77%–90%）",
  ];
  const layout = slideLayout(
    {
      title: "本地概率阈值与分类表现",
      bullets: rows,
      notes: "回归排版用例",
      citations: [paper.sources[0].id],
      layout: "table",
    },
    paper.sources,
  );
  const cells = layout.text.filter((box) => box.role === "bullet");
  assert.deepEqual(cells[3].lines, ["Mbagathi"]);
  assert.deepEqual(cells[6].lines, ["Kiambu"]);
  assert.deepEqual(
    cells.map((box) => box.lines.join("").replace(/\s/g, "")),
    rows.flatMap((row) =>
      row.split("|").map((cell) => cell.replace(/\s/g, "")),
    ),
  );
  const context = createCanvas(1, 1).getContext("2d");
  for (const cell of cells) {
    assert.equal(cell.fontSize, 23);
    context.font =
      (cell.bold ? "bold " : "") + cell.fontSize + "pt Microsoft YaHei";
    for (const line of cell.lines)
      assert.ok(
        context.measureText(line).width <= cell.w * 96,
        "Clipped cell: " + line,
      );
    assert.ok(cell.y + cell.h <= 6.7);
  }
  assert.ok(
    cells.every(
      (cell, i) => i % 3 === 0 || cell.x >= cells[i - 1].x + cells[i - 1].w,
    ),
  );
});

test("comparison tables keep numerical confidence intervals together beside long headers", () => {
  const rows = [
    "结局与时间窗 | 试验数；事件/分析人数（二甲双胍 vs 安慰剂） | 风险比RR（95% CI） | 证据确定性与判断",
    "死亡，28天 | 2项；8/811 vs 10/804 | 0.76（0.30–1.90） | 低；可能几乎无影响",
    "因COVID-19住院，28天 | 2项；42/811 vs 47/804 | 0.74（0.28–1.95） | 极低；效果不确定",
    "长新冠，300天 | 1项；35/564 vs 58/562 | 0.60（0.40–0.90） | 低；可能减少发生",
  ];
  const layout = slideLayout(
    {
      title: "三个结局的比较",
      bullets: rows,
      notes: "排版回归夹具",
      citations: [paper.sources[0].id],
      layout: "table",
    },
    paper.sources,
  );
  const cells = layout.text.filter((box) => box.role === "bullet");
  for (const [row, interval] of [
    "（0.30–1.90）",
    "（0.28–1.95）",
    "（0.40–0.90）",
  ].entries()) {
    assert.ok(
      cells[(row + 1) * 4 + 2].lines.some((line) => line.includes(interval)),
      "Split confidence interval: " + interval,
    );
  }
  assert.deepEqual(
    cells.map((box) => box.lines.join("").replace(/\s/g, "")),
    rows.flatMap((row) =>
      row.split("|").map((cell) => cell.replace(/\s/g, "")),
    ),
  );
  assert.ok(cells.every((box) => box.fontSize >= 20 && box.y + box.h < 6.7));
});

test("comparison tables reserve short row labels and keep risk denominators intact", () => {
  const rows = [
    "结局 | 每1000人绝对效应（95% CI） | 最小重要差异 | GRADE降级依据",
    "死亡，28天 | 少3人（少8至多11） | 3/1000 | 非常严重的不精确：区间包含重要获益与伤害",
    "住院，28天 | 少15人（少42至多55） | 15/1000 | 严重不一致，I²=76.7%；非常严重的不精确",
    "长新冠，300天 | 少41人（少62至少10） | 20/1000 | 严重偏倚风险及不精确：存在失访，区间涵盖不重要获益",
  ];
  const layout = slideLayout(
    {
      title: "绝对效应及证据判断",
      bullets: rows,
      notes: "排版回归夹具",
      citations: [paper.sources[0].id],
      layout: "table",
    },
    paper.sources,
  );
  const cells = layout.text.filter((box) => box.role === "bullet");
  for (const [row, ratio] of ["3/1000", "15/1000", "20/1000"].entries())
    assert.ok(
      cells[(row + 1) * 4 + 2].lines.some((line) => line.includes(ratio)),
      "Split denominator: " + ratio,
    );
  assert.ok(
    cells[12].lines.some((line) => line.includes("长新冠")),
    "Short row label split between characters",
  );
  assert.deepEqual(
    cells.map((box) => box.lines.join("").replace(/\s/g, "")),
    rows.flatMap((row) =>
      row.split("|").map((cell) => cell.replace(/\s/g, "")),
    ),
  );
  const context = createCanvas(1, 1).getContext("2d");
  for (const cell of cells) {
    context.font =
      (cell.bold ? "bold " : "") + cell.fontSize + "pt Microsoft YaHei";
    for (const line of cell.lines)
      assert.ok(
        context.measureText(line).width <= cell.w * 96,
        "Clipped table cell: " + line,
      );
    assert.ok(cell.fontSize >= 20 && cell.y + cell.h < 6.7);
  }
});

test("five and six step routes preserve order, fit and export native downward connections", async () => {
  const bullets = [
    "明确筛查人群与纳入条件",
    "采集图像并固定输入",
    "运行模型取得优先级",
    "医务人员结合提示复核",
    "对照参考标准评价差异",
    "随访实际流程中的结局",
  ];
  for (const count of [5, 6]) {
    const slide = {
      title: "从研究对象到实际评价",
      bullets: bullets.slice(0, count),
      notes: "讲述提示单独交付。",
      citations: [paper.sources[0].id],
      layout: "flow" as const,
    };
    const layout = slideLayout(slide, paper.sources);
    const boxes = layout.text.filter((b) => b.role === "bullet");
    assert.deepEqual(
      boxes.map((b) => b.lines.join("")),
      slide.bullets,
    );
    assert.equal(
      layout.shapes.filter((s) => s.kind === "downArrow").length,
      count - 1,
    );
    boxes.forEach((b, i) => {
      assert.ok(b.fontSize >= 20 && b.y + b.h < 6.7);
      if (i) assert.ok(b.y > boxes[i - 1].y + boxes[i - 1].h);
    });
    const output = await exportDeck(
      { slides: [slide] },
      paper,
      "expanded-flow-" + randomUUID(),
    );
    try {
      const xml = strFromU8(
        unzipSync(await readFile(output))["ppt/slides/slide1.xml"],
      );
      assert.equal((xml.match(/prst="downArrow"/g) ?? []).length, count - 1);
      for (const value of slide.bullets)
        assert.ok(xml.replace(/<[^>]+>/g, "").includes(value));
    } finally {
      await unlink(output);
    }
  }
  assert.throws(
    () =>
      slideLayout(
        {
          title: "过密流程",
          bullets: bullets.map(() => "过长的步骤说明".repeat(30)),
          notes: "讲述提示单独交付。",
          citations: [],
          layout: "flow",
        },
        [],
      ),
    /过密/,
  );
});

test("comparison headings retain their original text and never introduce sequence arrows", () => {
  const bullets = [
    "既有研究：受控环境中的模型验证",
    "当前研究：在实际读片流程中比较辅助效果",
  ];
  const layout = slideLayout(
    {
      title: "临床流程带来什么新问题",
      bullets,
      notes: "讲述提示单独交付。",
      citations: [],
      layout: "comparison",
    },
    [],
  );
  for (const [i, value] of bullets.entries()) {
    const boxes = layout.text.filter((b) => b.sourceIndex === i);
    assert.equal(boxes.map((b) => b.lines.join("")).join(""), value);
    assert.equal(boxes[0].bold, true);
    assert.ok(boxes.every((b) => b.fontSize >= 20 && b.y + b.h < 6.7));
  }
  assert.equal(
    layout.shapes.some((s) => ["chevron", "downArrow"].includes(s.kind ?? "")),
    false,
  );
});

test("generated six-step routes pass the grounded contract without increasing ordinary page density", () => {
  const schema = groundedTeachingSchema(paper.sources);
  const slide = {
    title: "完整研究路径",
    bullets: [
      "确定研究对象",
      "形成输入",
      "生成预测",
      "人员复核",
      "比较结局",
      "随访验证",
    ],
    notes: "讲述提示单独交付。",
    citations: [],
    layout: "flow" as const,
  };
  assert.equal(
    schema.parse({ unit, deck: { slides: [slide] } }).deck!.slides[0].bullets
      .length,
    6,
  );
  assert.throws(() =>
    schema.parse({ unit, deck: { slides: [{ ...slide, layout: "auto" }] } }),
  );
  assert.throws(() =>
    schema.parse({
      unit,
      deck: { slides: [{ ...slide, imageSource: "xu-fig1" }] },
    }),
  );
});

test("long cohort labels do not starve short headers or split numbered hospital labels", () => {
  const rows = [
    "医院 | 分析人数 | 复合结局阳性",
    "Mbagathi County Hospital（医院1） | 2539 | 226（占本院分析人群8.9%）",
    "Kiambu County Referral Hospital（医院2） | 2464 | 112（占本院分析人群4.5%）",
  ];
  const layout = slideLayout(
    {
      title: "两院分析样本",
      bullets: rows,
      notes: "",
      citations: [],
      layout: "table",
    },
    [],
  );
  const cells = layout.text.filter((b) => b.role === "bullet");
  assert.deepEqual(cells[1].lines, ["分析人数"]);
  assert.ok(cells[3].lines.some((line) => line.includes("医院1）")));
  assert.ok(cells[6].lines.some((line) => line.includes("医院2）")));
  assert.deepEqual(
    cells.map((b) => b.lines.join("").replace(/\s/g, "")),
    rows.flatMap((row) =>
      row.split("|").map((cell) => cell.replace(/\s/g, "")),
    ),
  );
});

test("percentage confidence intervals and their labels wrap as complete scientific expressions", () => {
  const rows = [
    "医院／状态 | 低阈值：敏感度（95%CI） | 高阈值：特异度（95%CI）",
    "医院1／原模型 | 0.080：93%（89%–96%） | 0.400：86%（84%–87%）",
    "医院1／截距更新后 | 0.026：90%（86%–93%） | 0.130：86%（85%–88%）",
  ];
  const layout = slideLayout(
    {
      title: "阈值与区间",
      bullets: rows,
      notes: "",
      citations: [],
      layout: "table",
    },
    [],
  );
  const cells = layout.text.filter((b) => b.role === "bullet");
  for (const index of [1, 2])
    assert.ok(cells[index].lines.some((line) => line.includes("（95%CI）")));
  for (const [index, interval] of [
    [4, "（89%–96%）"],
    [5, "（84%–87%）"],
    [7, "（86%–93%）"],
    [8, "（85%–88%）"],
  ] as const)
    assert.ok(
      cells[index].lines.some((line) => line.includes(interval)),
      cells[index].lines.join(" / "),
    );
  assert.deepEqual(
    cells.map((b) => b.lines.join("").replace(/\s/g, "")),
    rows.flatMap((row) =>
      row.split("|").map((cell) => cell.replace(/\s/g, "")),
    ),
  );
});

test("four-step procedures use wide rows when narrow cards strand a final CJK character", () => {
  const bullets = [
    "原模型：计算肯尼亚儿童风险",
    "外部验证：分院及合并评价",
    "本地更新：重新估计截距",
    "更新评估：检查校准与阈值",
  ];
  const layout = slideLayout(
    { title: "验证与更新", bullets, notes: "", citations: [], layout: "flow" },
    [],
  );
  const boxes = layout.text.filter((b) => b.role === "bullet");
  assert.deepEqual(
    boxes.map((b) => b.lines.join("")),
    bullets,
  );
  assert.ok(boxes.every((b) => b.w > 8));
  assert.ok(boxes.every((b) => b.fontSize >= 24 && b.y + b.h < 6.7));
  boxes.forEach((b, i) => {
    if (i) assert.ok(b.y > boxes[i - 1].y + boxes[i - 1].h);
  });
});

test("footnote markers stay attached to outcome labels in narrow table cells", () => {
  for (const marker of ["＊", "*", "†", "‡", "¹"]) {
    const text = "有创通气或死亡" + marker;
    const lines = wrapSlideText(text, 1.9, 24);
    assert.equal(lines.join(""), text);
    assert.ok(
      lines.every((line) => !/^[＊*†‡¹]/.test(line)),
      JSON.stringify(lines),
    );
  }
});

test("identical figure regions require purpose review, while distinct verified crops remain available", () => {
  const crop = { left: 0, top: 0, width: 0.5, height: 1 };
  const deck: DeckOutline = {
    slides: [
      { ...compact.slides[0], title: "总体结果", imageSource: "xu-fig1" },
      { ...compact.slides[0], title: "重复整图", imageSource: "xu-fig1" },
      {
        ...compact.slides[0],
        title: "左侧证据",
        imageSource: "xu-fig1",
        imageCrop: crop,
      },
      {
        ...compact.slides[0],
        title: "右侧证据",
        imageSource: "xu-fig1",
        imageCrop: { left: 0.5, top: 0, width: 0.5, height: 1 },
      },
      {
        ...compact.slides[0],
        title: "重复左侧证据",
        imageSource: "xu-fig1",
        imageCrop: { ...crop, left: 0.00001 },
      },
    ],
  };
  const reuseIssues = pptLayoutIssues(deck, paper.sources).filter((issue) =>
    issue.id.startsWith("ppt-image-reuse-"),
  );
  assert.deepEqual(
    reuseIssues.map((issue) => issue.id),
    ["ppt-image-reuse-2", "ppt-image-reuse-5"],
  );
  assert.equal(reuseIssues[0].severity, "warning");
  assert.match(reuseIssues[0].suggestion, /第 1 页/);
});

test("image reuse review closes only after the repeated slide changes", () => {
  const deck: DeckOutline = {
    slides: [
      { ...compact.slides[0], title: "第一处", imageSource: "xu-fig1" },
      { ...compact.slides[0], title: "重复处", imageSource: "xu-fig1" },
    ],
  };
  const first = withPptLayoutReview(clear, deck, paper.sources);
  assert.equal(
    first.issues.find((issue) => issue.id === "ppt-image-reuse-2")?.resolved,
    false,
  );
  const repaired: DeckOutline = {
    slides: [deck.slides[0], { ...deck.slides[1], imageSource: "" }],
  };
  const final = withPptLayoutReview(clear, repaired, paper.sources, first);
  assert.equal(
    final.issues.find((issue) => issue.id === "ppt-image-reuse-2")?.resolved,
    true,
  );
});
test("a reviewer can accept purposeful image reuse without clearing layout errors", async () => {
  const { assertPptLayout } = await import("../server/ppt-layout-review.ts");
  const deck: DeckOutline = {
    slides: [
      { ...compact.slides[0], title: "总体结果", imageSource: "xu-fig1" },
      {
        ...compact.slides[0],
        title: "返回同图解释适用边界",
        imageSource: "xu-fig1",
      },
    ],
  };
  assert.doesNotThrow(() => assertPptLayout(deck, paper.sources));
  const reviewed = withPptLayoutReview(
    {
      ...clear,
      issues: [
        {
          id: "ppt-image-reuse-2",
          location: "第2页",
          type: "scope",
          severity: "warning",
          resolved: true,
          evidence: ["xu-fig1"],
          suggestion: "本页回到同图解释前页结论的条件，讲述任务不同。",
        },
      ],
    },
    deck,
    paper.sources,
  );
  assert.equal(
    reviewed.issues.find((issue) => issue.id === "ppt-image-reuse-2")?.resolved,
    true,
  );
  const crowded = {
    slides: [{ ...deck.slides[0], title: "研究结果".repeat(50) }],
  };
  assert.throws(() => assertPptLayout(crowded, paper.sources), /PPT/);
});

test("actual PPT delivery does not clear scientific or visual content defects", async () => {
  const { missingPptDeliveryClaim } =
    await import("../server/training-delivery.ts");
  assert.equal(
    missingPptDeliveryClaim("尚未提供PPTX文件和逐页渲染，无法验证成品"),
    true,
  );
  for (const text of [
    "PPTX缺少95%置信区间",
    "PPTX数值错误",
    "逐页视觉检查存在裁切溢出",
    "PPTX未提供同页引用来源",
    "表序错误，未完成逐页审计",
  ])
    assert.equal(missingPptDeliveryClaim(text), false, text);
});

test("native-table audit clears a verification-only claim but retains missing data", async () => {
  const { missingPptDeliveryClaim } =
    await import("../server/training-delivery.ts");
  const claim =
    "两组阈值和区间与原文一致，但不能据此确认PowerPoint原生单元格可编辑。此项为交付验证缺口，不是数值事实错误。";
  assert.equal(missingPptDeliveryClaim(claim), false);
  assert.equal(missingPptDeliveryClaim(claim, true), true);
  assert.equal(missingPptDeliveryClaim(claim + "遗漏无房颤组。", true), false);
});

test("grounding receives full cited evidence while novice sees only the selected panel", async () => {
  const evidence = createCanvas(100, 60),
    ctx = evidence.getContext("2d");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 50, 60);
  ctx.fillStyle = "blue";
  ctx.fillRect(50, 0, 50, 60);
  const scopedPaper = {
    ...paper,
    sources: paper.sources.map((s) =>
      s.id === "xu-fig1"
        ? {
            ...s,
            image: evidence.toDataURL("image/png"),
            imagePanels: [
              {
                label: "a",
                region: { left: 0, top: 0, width: 0.5, height: 1 },
              },
            ],
          }
        : s,
    ),
  };
  const outputs = [
    {
      unit,
      deck: { slides: [{ ...compact.slides[0], imagePanel: "xu-fig1:a" }] },
    },
    { understood: ["Selected panel"], breakpoints: [] },
    clear,
  ];
  const received: {
    width: number;
    height: number;
    instructions: string;
    input: any;
  }[] = [];
  const scopedProvider: Provider = {
    model: "fixture-test-only",
    async generate<T>(
      instructions: string,
      input: unknown,
      schema: import("zod").z.ZodType<T>,
      signal: AbortSignal,
      image?: string,
    ) {
      signal.throwIfAborted();
      assert.ok(image);
      const visible = await loadImage(image);
      received.push({
        width: visible.width,
        height: visible.height,
        instructions,
        input,
      });
      assert.ok(outputs.length, "unexpected extra model request");
      return { output: schema.parse(outputs.shift()) };
    },
  };
  const manager = new TaskManager(scopedProvider, async () => {}, "online");
  const run = await manager.start(
    {
      paperId: scopedPaper.id,
      module: "ppt",
      mode: "live",
      profileId: "beginner",
      question: "工程验证裁图页面与表格来源核验",
      sourceIds: scopedPaper.sources.map((s) => s.id),
      taughtConcepts: [],
      slideCount: 1,
    },
    scopedPaper,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.deepEqual(
    run.roles.map((r) => r.role),
    ["teaching", "novice", "grounding"],
  );
  assert.equal(received[1].width, 50);
  assert.equal(received[1].height, 60);
  assert.equal(received[1].input.pptImageEvidence, undefined);
  assert.equal(received[2].width, 1800);
  assert.equal(received[2].height, 620);
  assert.equal(
    received[2].input.pptImageEvidence,
    "ppt-grounding-images-v1-cited-originals",
  );
  assert.match(received[2].instructions, /来源原图（非页面展示）/);
  assert.match(
    received[2].instructions,
    /不能用完整来源图替代页面裁切或可读性检查/,
  );
});

test("a short interpretation gives its wider numerical claim room without reducing the font", () => {
  const bullets = [
    "A｜登记起点→事件完成：中位数12.0 vs 15.0小时；调整后风险比（aHR）1.50（95% CI，1.10–2.10），干预组 vs 对照组。这项比较需保留统计口径。",
    "区间较宽，不能据点估计断言差异。",
  ];
  const layout = slideLayout({ ...compact.slides[0], bullets }, paper.sources, {
    width: 2700,
    height: 1000,
  });
  assert.equal(layout.composition, "evidence-wide");
  const boxes = layout.text.filter((b) => b.role === "bullet");
  assert.ok(boxes[0].w > boxes[1].w);
  assert.deepEqual(
    boxes.map((b) => b.lines.join("").replace(/\s/g, "")),
    bullets.map((b) => b.replace(/\s/g, "")),
  );
  assert.ok(boxes.every((b) => b.fontSize === 20 && b.y + b.h <= 6.68 + 1e-9));
  assert.ok(boxes[0].x + boxes[0].w + 0.3 <= boxes[1].x);
  assert.ok(layout.image!.w > 8.5);
});

test("moderately wide figures gain space from a fitted sidebar while all claims stay readable", () => {
  const bullets = [
    "104周eGFR治疗差：＋0.75 ml/min/1.73 m²（95% CI 0.43–1.06），P＜0.001。",
    "总体效应是相对安慰剂下降较少，不是总体肾功能持续上升。",
  ];
  const slide = { ...compact.slides[0], bullets };
  const layout = slideLayout(slide, paper.sources, {
    width: 1459,
    height: 737,
  });
  assert.equal(layout.composition, "evidence");
  assert.ok(layout.image!.w >= 8.6);
  assert.ok(Math.abs(layout.image!.w / layout.image!.h - 1459 / 737) < 1e-9);
  const boxes = layout.text.filter((b) => b.role === "bullet");
  assert.deepEqual(
    boxes.map((b) => b.lines.join("").replace(/\s/g, "")),
    bullets.map((b) => b.replace(/\s/g, "")),
  );
  assert.ok(
    boxes.every(
      (b) =>
        b.fontSize === 20 &&
        b.x >= layout.image!.x + layout.image!.w + 0.3 &&
        b.x + b.w <= 12.55 + 1e-9 &&
        b.y + b.h <= 6.68 + 1e-9,
    ),
  );
  for (let i = 1; i < boxes.length; i++)
    assert.ok(boxes[i].y >= boxes[i - 1].y + boxes[i - 1].h + 0.2);
  const portrait = slideLayout(slide, paper.sources, {
    width: 700,
    height: 1400,
  });
  assert.ok(
    portrait.text.filter((b) => b.role === "bullet").every((b) => b.w === 3.5),
  );
});
