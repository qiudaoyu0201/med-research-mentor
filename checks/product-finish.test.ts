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
  revisionMaterialPacket,
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

test("missing-data questions preserve the MAR/MICE method paragraph in compressed page evidence", () => {
  const p7 = {
    id: "missing-page",
    title: "PDF 第 7 页",
    page: 7,
    kind: "paper" as const,
    locator: "PDF 7",
    verified: false,
    text:
      "Sample size and statistical analysis. " +
      "Background details. ".repeat(175) +
      "Missing data. Presence and patterns of missing data were explored. " +
      "Although missing not at random (MNAR) cannot be ruled out, we assume a missing at random (MAR) mechanism conditional on observed covariates. " +
      "We used multiple imputation by chained equations (MICE), generated multiple datasets, and pooled estimates using Rubin's rules. " +
      "Closing details. ".repeat(160),
  };
  const sources = [
    p7,
    ...Array.from({ length: 5 }, (_, i) => ({
      ...p7,
      id: `other-${i}`,
      page: i + 1,
      title: `PDF 第 ${i + 1} 页`,
      text: `Page ${i + 1}. ` + "Unrelated narrative. ".repeat(240),
    })),
  ];
  const packet = materialPacket(sources, "解释缺失值处理、失访和插补假设");
  const ref = packet.references.find((r) => r.id === "missing-page")!;
  const block = packet.blocks.find((b) => b.hash === ref.blockHash)!.text;
  assert.match(block, /MNAR/);
  assert.match(block, /MAR/);
  assert.match(block, /MICE/);
});
test("Chinese trial questions retain endpoint, margin and safety definitions within the evidence budget", () => {
  const page = {
    id: "trial-methods",
    title: "PDF 第 6 页",
    page: 6,
    kind: "paper" as const,
    locator: "PDF 6",
    verified: false,
    text:
      "Methods and statistical analysis. " +
      "Background details. ".repeat(80) +
      "The primary outcome was recovery assessed per person. " +
      "Background details. ".repeat(90) +
      "The non-inferiority margin of 0.75 units was fixed before analysis; confidence intervals determine the comparison. " +
      "Background details. ".repeat(90) +
      "Serious adverse events included complications; safety observations were weekly. " +
      "Closing details. ".repeat(170),
  };
  const sources = [
    page,
    ...Array.from({ length: 5 }, (_, i) => ({
      ...page,
      id: `trial-other-${i}`,
      title: `PDF 第 ${i + 1} 页`,
      text: `Page ${i + 1}. ` + "Unrelated narrative. ".repeat(250),
    })),
  ];
  const packet = materialPacket(
    sources,
    "带读这项非劣效随机试验，解释主要终点、界值、置信区间和安全性",
  );
  const ref = packet.references.find((r) => r.id === page.id)!;
  const block = packet.blocks.find((b) => b.hash === ref.blockHash)!.text;
  assert.ok(block.includes("margin of 0.75 units"));
  assert.ok(block.includes("primary outcome was recovery"));
  assert.ok(block.includes("Serious adverse events included complications"));
  assert.ok("visibleRanges" in ref && ref.fullText === false);
  assert.ok(packet.blocks.reduce((n, b) => n + b.text.length, 0) <= 22_000);
  if ("visibleRanges" in ref)
    for (const range of ref.visibleRanges!)
      assert.ok(block.includes(page.text.slice(range.start, range.end)));
});

test("Chinese clinical-validation requests retain population and outcome anchors in bounded excerpts", () => {
  const pages = [
    {
      id: "validation-population",
      title: "PDF 第 4 页",
      page: 4,
      kind: "paper" as const,
      locator: "PDF 4",
      verified: false,
      text:
        "Results and methods. " +
        "Background details. ".repeat(180) +
        "Patients were screened for eligibility; 142 participants met inclusion criteria. Observations with unavailable labels were excluded from analysis. " +
        "Closing details. ".repeat(170),
    },
    {
      id: "validation-endpoint",
      title: "PDF 第 5 页",
      page: 5,
      kind: "paper" as const,
      locator: "PDF 5",
      verified: false,
      text:
        "Methods and statistical analysis. " +
        "Background details. ".repeat(180) +
        "The outcome was hospital admission for more than 48 hours. Calibration compared observed and predicted probabilities before and after recalibration. " +
        "Closing details. ".repeat(170),
    },
  ];
  const sources = [
    ...pages,
    ...Array.from({ length: 6 }, (_, i) => ({
      ...pages[0],
      id: `validation-other-${i}`,
      title: `PDF 第 ${i + 6} 页`,
      text: `Page ${i + 6}. ` + "Unrelated narrative. ".repeat(260),
    })),
  ];
  const packet = materialPacket(
    sources,
    "汇报预测模型外部验证：研究对象、入组和分析人群、研究结局与校准前后比较",
  );
  const texts = pages.map((page) => {
    const ref = packet.references.find((r) => r.id === page.id)!;
    assert.ok("visibleRanges" in ref && ref.fullText === false);
    const text = packet.blocks.find((b) => b.hash === ref.blockHash)!.text;
    if ("visibleRanges" in ref)
      for (const range of ref.visibleRanges!)
        assert.ok(text.includes(page.text.slice(range.start, range.end)));
    return text;
  });
  assert.match(texts[0], /142 participants met inclusion criteria/);
  assert.match(texts[0], /excluded from analysis/);
  assert.match(
    texts[1],
    /outcome was hospital admission for more than 48 hours/,
  );
  assert.match(texts[1], /before and after recalibration/);
  assert.ok(packet.blocks.reduce((n, b) => n + b.text.length, 0) <= 20_000);
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

const revisionPages = () =>
  Array.from({ length: 8 }, (_, i) => ({
    id: `revision-p${i + 1}`,
    title: `PDF 第 ${i + 1} 页`,
    page: i + 1,
    kind: "paper" as const,
    locator: `PDF ${i + 1}`,
    verified: false,
    text:
      `Page ${i + 1}. ` +
      "Generic evidence. ".repeat(128) +
      (i === 5
        ? "50% eligible, 60% initiate, 30% overall, design target 42.5%."
        : "Other evidence.") +
      " Remaining details. ".repeat(140),
  }));
function assertPriorExposure(
  previous: ReturnType<typeof materialPacket>,
  next: ReturnType<typeof materialPacket>,
  sources: ReturnType<typeof revisionPages>,
) {
  for (const ref of previous.references) {
    const source = sources.find((s) => s.id === ref.id)!;
    const after = next.references.find((r) => r.id === ref.id)!;
    assert.ok(after, "Previously delivered references must remain present");
    const oldRanges =
      "fullText" in ref && ref.fullText === false
        ? ref.visibleRanges!
        : [{ start: 0, end: source.text.length }];
    const newRanges =
      "fullText" in after && after.fullText === false
        ? after.visibleRanges!
        : [{ start: 0, end: source.text.length }];
    for (const range of oldRanges)
      assert.ok(
        newRanges.some((r) => r.start <= range.start && r.end >= range.end),
      );
  }
  assert.ok(next.blocks.reduce((n, b) => n + b.text.length, 0) <= 22_000);
}

test("revision supplementation preserves earlier sample-size assumptions within the same evidence bound", () => {
  const sources = revisionPages();
  const original = materialPacket(sources, "trial denominators");
  const p6 = original.references.find((r) => r.id === "revision-p6")!;
  assert.match(
    original.blocks.find((b) => b.hash === p6.blockHash)!.text,
    /30% overall/,
  );
  const independentlyCompressed = materialPacket(
    sources,
    "trial denominators",
    ["revision-p8"],
  );
  assert.doesNotMatch(
    independentlyCompressed.blocks.find((b) => b.hash === p6.blockHash)!.text,
    /30% overall/,
  );
  const revised = revisionMaterialPacket(
    original,
    sources,
    "trial denominators",
    ["revision-p8"],
  );
  assertPriorExposure(original, revised, sources);
  assert.match(
    revised.blocks.find((b) => b.hash === p6.blockHash)!.text,
    /30% overall/,
  );
  const again = revisionMaterialPacket(revised, sources, "trial denominators", [
    "revision-p8",
  ]);
  assertPriorExposure(revised, again, sources);
  assert.deepEqual(again, revised);
});

test("revision evidence stays partial when requested pages cannot fit and new foundations remain pending", () => {
  const sources = revisionPages(),
    original = materialPacket(sources, "trial denominators");
  const foundation = {
    ...sources[0],
    id: "new-foundation",
    title: "New foundation",
    kind: "foundation" as const,
    text: "Foundation definition. ".repeat(400),
  };
  const revised = revisionMaterialPacket(
    original,
    [...sources, foundation],
    "trial denominators",
    sources.map((s) => s.id),
  );
  assertPriorExposure(original, revised, sources);
  assert.ok(
    revised.references.some((r) => "fullText" in r && r.fullText === false),
  );
  assert.ok(!revised.references.some((r) => r.id === foundation.id));
  assert.match(revised.coverage!, /不代表全文/);
  const aliasFoundation = {
    ...sources[7],
    id: "alias-foundation",
    kind: "foundation" as const,
  };
  const aliasPacket = revisionMaterialPacket(
    original,
    [...sources, aliasFoundation],
    "trial denominators",
    sources.map((s) => s.id),
  );
  assert.ok(
    !aliasPacket.references.some((r) => r.id === aliasFoundation.id),
    "A partial shared block must not report a whole new foundation as delivered",
  );
});

test("revision evidence deduplicates shared text and rejects changed or ambiguous prior exposure", () => {
  const sources = revisionPages();
  sources.push({ ...sources[0], id: "alias" });
  const original = materialPacket(sources, "trial denominators");
  const revised = revisionMaterialPacket(
    original,
    sources,
    "trial denominators",
    ["alias"],
  );
  assertPriorExposure(original, revised, sources);
  assert.equal(revised.blocks.length, 8);
  assert.equal(revised.references.length, 9);
  const duplicate = structuredClone(original);
  duplicate.blocks.push({ ...duplicate.blocks[0] });
  assert.throws(() => revisionMaterialPacket(duplicate, sources), /重复/);
  const badText = structuredClone(original);
  badText.blocks[0].text += " fabricated";
  assert.throws(
    () => revisionMaterialPacket(badText, sources),
    /可见范围不一致/,
  );
  const changed = sources.map((s, i) =>
    i ? s : { ...s, text: s.text + " changed" },
  );
  assert.throws(() => revisionMaterialPacket(original, changed), /来源改变/);
  const orphan = structuredClone(original);
  orphan.blocks.push({ hash: "orphan", text: "unbound" });
  assert.throws(() => revisionMaterialPacket(orphan, sources), /未绑定/);
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
    assert.ok(
      lines.some((line) => line.includes(token)),
      "Identifier must stay in one line: " + token,
    );
    for (const line of lines)
      assert.ok(
        context.measureText(line).width <= 3.5 * 96,
        "Actual font width overflow: " + line,
      );
  }
});

test("slide wrapping preserves compound pressure units at real column widths", () => {
  const context = createCanvas(1, 1).getContext("2d");
  for (const [text, unit] of [
    ["舒张压≥90或收缩压≥140 mm Hg：告知高血压并鼓励就医", "mm Hg"],
    ["呼吸机压力记录为20 cm H2O，按相同时间窗比较", "cm H2O"],
  ]) {
    for (const [width, fontSize] of [
      [5.18, 26],
      [3.5, 19],
    ]) {
      const lines = wrapSlideText(text, width, fontSize);
      assert.equal(lines.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
      assert.ok(
        lines.some((line) => line.includes(unit)),
        "Pressure unit split: " + lines.join(" | "),
      );
      context.font = fontSize + "pt Microsoft YaHei";
      for (const line of lines)
        assert.ok(
          context.measureText(line).width <= width * 96,
          "Actual font width overflow: " + line,
        );
    }
  }
});

test("slide wrapping keeps Chinese words and allocation ratios together at real column widths", () => {
  const context = createCanvas(1, 1).getContext("2d");
  for (const [text, tokens] of [
    [
      "按初始选择重分后结果相近，但偏好进入比较，不能替代随机分析",
      ["比较", "随机", "分析"],
    ],
    [
      "1∶1∶1分配至不同策略，按随机分配进行比较",
      ["1∶1∶1", "随机", "分配", "比较"],
    ],
    [
      "按2:1:1比例随机分配，分别报告完成情况",
      ["2:1:1", "随机", "分配", "完成"],
    ],
  ] as const) {
    for (const [width, fontSize] of [
      [2.45, 26],
      [3.5, 20],
      [5.1, 24],
    ]) {
      const lines = wrapSlideText(text, width, fontSize);
      assert.equal(lines.join(""), text);
      for (const token of tokens)
        assert.ok(
          lines.some((line) => line.includes(token)),
          "Word split: " + token + " in " + lines.join(" | "),
        );
      context.font = fontSize + "pt Microsoft YaHei";
      for (const line of lines) {
        assert.ok(
          context.measureText(line).width <= width * 96,
          "Actual font width overflow: " + line,
        );
        assert.doesNotMatch(line, /^[，。；：！？、）》」』】”’]/);
        assert.doesNotMatch(line, /[（(《「『【“‘]$/);
      }
    }
  }
});

test("slide wrapping keeps signed estimates and interval bounds intact", () => {
  const context = createCanvas(1, 1).getContext("2d");
  for (const [text, tokens] of [
    [
      "召回相对差−2.5%（95%CI −6.5%～+1.7%），区间跨零",
      ["−2.5%", "−6.5%", "+1.7%"],
    ],
    [
      "推演召回−15.0%（−18.6%～−11.2%）；共识会议−19.4%",
      ["−15.0%", "−18.6%", "−11.2%", "−19.4%"],
    ],
    [
      "变化 -2.5% 至 +1.7%，均值±0.5；阈值− 10%",
      ["-2.5%", "+1.7%", "±0.5", "− 10%"],
    ],
  ] as const) {
    for (const [width, fontSize] of [
      [2.45, 25],
      [3.5, 20],
      [5.1, 24],
    ]) {
      const lines = wrapSlideText(text, width, fontSize);
      assert.equal(
        lines.join("").replace(/\s+/g, ""),
        text.replace(/\s+/g, ""),
      );
      for (const token of tokens)
        assert.ok(
          lines.some((line) => line.includes(token)),
          "Signed number split: " + token + " in " + lines.join(" | "),
        );
      context.font = fontSize + "pt Microsoft YaHei";
      for (const line of lines)
        assert.ok(
          context.measureText(line).width <= width * 96,
          "Actual font width overflow: " + line,
        );
    }
  }
});

test("slide wrapping can break a word wider than the whole column without losing content", () => {
  const text = "中华人民共和国：分析与比较";
  const lines = wrapSlideText(text, 1.1, 20);
  assert.equal(lines.join(""), text);
  const context = createCanvas(1, 1).getContext("2d");
  context.font = "20pt Microsoft YaHei";
  assert.ok(lines.length > 1);
  for (const line of lines)
    assert.ok(
      context.measureText(line).width <= 1.1 * 96,
      "Narrow column overflow: " + line,
    );
});

test("compressed clinical evidence retains a complete requested endpoint beside calibration and eligibility", () => {
  const definition =
    "Primary outcome\n" +
    "The primary outcome was defined as a composite of admission longer than 36 hours, death within 12 hours, or transfer within 60 hours. " +
    "Outcomes were established by telephone follow-up on day eight. " +
    "A transfer counted only after independent clinician review, and repeat contacts without a new event did not count as outcomes. " +
    "The definition preserved the separate observation windows rather than treating every participant as having eight days of continuous follow-up.\n";
  const page = {
    id: "clinical-methods",
    title: "PDF 第 4 页",
    page: 4,
    kind: "paper" as const,
    locator: "PDF 4",
    verified: false,
    text:
      "Methods\n" +
      "Data were recorded on encrypted devices. ".repeat(24) +
      "\n" +
      definition +
      "Calibration validation evaluated calibration slope, recalibration intercept and observed outcome rates in participants. ".repeat(
        32,
      ) +
      "\nInclusion criteria\nThe population included paediatric patients attending the two hospitals; participants outside the age limit were excluded.\n",
  };
  const sources = [
    page,
    ...Array.from({ length: 9 }, (_, i) => ({
      ...page,
      id: "clinical-other-" + i,
      title: "PDF 第 " + (i + 5) + " 页",
      page: i + 5,
      text:
        "Page " + (i + 5) + ". " + "Unrelated background details. ".repeat(210),
    })),
  ];
  const packet = materialPacket(
    sources,
    "为老师汇报该预测研究，说明研究对象、外部验证、复合结局与校准表现",
  );
  const reference = packet.references.find((r) => r.id === page.id)!;
  const block = packet.blocks.find((b) => b.hash === reference.blockHash)!.text;
  assert.ok(
    block.includes(definition),
    "The full endpoint definition and its unequal windows must remain together",
  );
  assert.match(block, /Inclusion criteria/);
  assert.match(block, /Calibration validation/);
  assert.ok("visibleRanges" in reference && reference.fullText === false);
  if ("visibleRanges" in reference) {
    const ranges = reference.visibleRanges!;
    const start = page.text.indexOf(definition);
    assert.ok(
      ranges.some(
        (r) => r.start <= start && r.end >= start + definition.length,
      ),
    );
    for (const range of ranges)
      assert.ok(block.includes(page.text.slice(range.start, range.end)));
    assert.ok(
      ranges.reduce((n, r) => n + r.end - r.start, 0) <= 1900,
      "Keep the existing per-page allowance",
    );
  }
  assert.ok(packet.blocks.reduce((n, b) => n + b.text.length, 0) <= 22000);
  assert.match(packet.coverage!, /不代表全文/);
});
