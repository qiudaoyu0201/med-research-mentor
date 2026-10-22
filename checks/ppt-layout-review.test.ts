import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
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
import { slideLayout } from "../shared/slide-layout.ts";
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
  assert.equal(noGain.image!.w, 7.95);
  const tooLong = slideLayout(
    {
      ...slide,
      bullets: [
        bullets[0] + "这项比较仍需较长的额外说明，不能继续压缩图件来容纳文字。",
        bullets[1],
      ],
    },
    paper.sources,
    { width: 2700, height: 1000 },
  );
  assert.equal(tooLong.composition, "evidence");
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
    /二至四/,
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
