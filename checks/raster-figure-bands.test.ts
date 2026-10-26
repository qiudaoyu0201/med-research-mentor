import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import {
  rasterFigureBands,
  rasterFigureRegions,
} from "../server/raster-figure-bands.ts";
import {
  clearPanelBoundaries,
  applyDeckPanels,
} from "../server/figure-panels.ts";
import { groundedTeachingSchema } from "../server/schemas.ts";
import { cropPixels } from "../shared/image-region.ts";
import type { Source, DeckOutline } from "../shared/types.ts";
import { validRecordShape } from "../server/record-shapes.ts";
import { pdfExtractionVersion } from "../server/pdf-runtime.ts";

function figure() {
  const canvas = createCanvas(800, 1500),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 800, 1500);
  ctx.fillStyle = "black";
  for (const y of [20, 520, 1020]) {
    // Printed label, paired plots, and their attached distribution panels.
    ctx.fillRect(5, y, 15, 20);
    ctx.fillRect(60, y + 35, 300, 290);
    ctx.fillRect(440, y + 35, 300, 290);
    ctx.fillRect(60, y + 345, 300, 80);
    ctx.fillRect(440, y + 345, 300, 80);
  }
  return { canvas, ctx };
}
test("raster bands retain paired plots, labels and distributions without inferring letters", () => {
  const { canvas, ctx } = figure(),
    bands = rasterFigureBands(ctx, 800, 1500);
  assert.deepEqual(
    bands.map((p) => p.label),
    ["band-1", "band-2", "band-3"],
  );
  assert.equal(clearPanelBoundaries(ctx, 800, 1500, bands), true);
  assert.equal(bands[0].region.top, 0);
  assert.equal(bands.at(-1)!.region.top + bands.at(-1)!.region.height, 1);
  const cuts = bands.slice(1).map((p) => p.region.top * 1500);
  assert.ok(cuts[0] > 445 && cuts[0] < 520);
  assert.ok(cuts[1] > 945 && cuts[1] < 1020);
  for (const p of bands) {
    assert.equal(p.region.left, 0);
    assert.equal(p.region.width, 1);
  }
  const original = ctx.getImageData(0, 0, 800, 1500).data;
  const coverage = new Uint8Array(1500);
  for (const p of bands) {
    const b = cropPixels(p.region, 800, 1500);
    for (let y = b.top; y < b.top + b.height; y++) coverage[y]++;
  }
  assert.ok([...coverage].every((n) => n >= 1));
  assert.ok(original.some((n) => n === 0));
  const source: Source = {
    id: "figure",
    kind: "paper",
    title: "Figure 4",
    text: "Original figure",
    locator: "PDF p.10",
    verified: false,
    image: canvas.toDataURL("image/png"),
    imagePanels: bands,
  };
  const slide = {
    title: "医院一：更新前后",
    bullets: ["同一人群的拟合比较"],
    notes: "比较同一医院更新前后的拟合，不代表新增独立验证样本。",
    citations: [source.id],
    imageSource: source.id,
    imagePanel: "figure:band-1",
  };
  const parsed = groundedTeachingSchema([source])
    .shape.deck.unwrap()
    .shape.slides.parse([slide]);
  const deck = { slides: parsed } as DeckOutline;
  applyDeckPanels(deck, [source]);
  assert.deepEqual(deck.slides[0].imageCrop, bands[0].region);
  assert.equal("imagePanel" in deck.slides[0], false);
});
test("a faint axis or colored connector through a gutter prevents that cut", () => {
  const { ctx } = figure();
  ctx.fillStyle = "#eeeeee";
  ctx.fillRect(390, 0, 2, 1500);
  assert.deepEqual(rasterFigureBands(ctx, 800, 1500), []);
  const f = figure();
  f.ctx.fillStyle = "#ffb4b4";
  f.ctx.fillRect(390, 0, 2, 1500);
  assert.deepEqual(rasterFigureBands(f.ctx, 800, 1500), []);
});
test("blank, small, wide or continuous raster figures retain the full image", () => {
  const c = createCanvas(800, 1500),
    ctx = c.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 800, 1500);
  assert.deepEqual(rasterFigureBands(ctx, 800, 1500), []);
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, 800, 1500);
  assert.deepEqual(rasterFigureBands(ctx, 800, 1500), []);
  const tiny = createCanvas(300, 600);
  assert.deepEqual(rasterFigureBands(tiny.getContext("2d"), 300, 600), []);
  const wide = createCanvas(1000, 400);
  assert.deepEqual(rasterFigureBands(wide.getContext("2d"), 1000, 400), []);
});

test("raster column choices retain complete plots and attached risk rows while keeping full-row fallback", () => {
  const { ctx } = figure();
  const regions = rasterFigureRegions(ctx, 800, 1500);
  assert.deepEqual(
    regions.map((p) => p.label),
    [
      "band-1",
      "band-2",
      "band-3",
      "band-1-col-1",
      "band-1-col-2",
      "band-2-col-1",
      "band-2-col-2",
      "band-3-col-1",
      "band-3-col-2",
    ],
  );
  assert.equal(clearPanelBoundaries(ctx, 800, 1500, regions), true);
  for (let n = 1; n <= 3; n++) {
    const row = regions.find((p) => p.label === "band-" + n)!;
    const cells = regions.filter((p) =>
      p.label.startsWith("band-" + n + "-col-"),
    );
    assert.equal(cells[0].region.left, 0);
    assert.equal(cells.at(-1)!.region.left + cells.at(-1)!.region.width, 1);
    assert.ok(
      cells.every(
        (p) =>
          p.region.top === row.region.top &&
          p.region.height === row.region.height,
      ),
    );
    assert.equal(
      cells[0].region.left + cells[0].region.width,
      cells[1].region.left,
    );
  }
  const source: Source = {
    id: "grid",
    kind: "paper",
    title: "Figure 2",
    text: "Paired plots",
    locator: "PDF p.9",
    verified: false,
    image: ctx.canvas.toDataURL("image/png"),
    imagePanels: regions,
  };
  const selected = groundedTeachingSchema([source])
    .shape.deck.unwrap()
    .shape.slides.parse([
      {
        title: "目标比较",
        bullets: ["完整的曲线及风险人数"],
        notes: "按轴和图例比较",
        citations: [source.id],
        imageSource: source.id,
        imagePanel: "grid:band-2-col-2",
      },
    ]);
  const deck = { slides: selected } as DeckOutline;
  const before = structuredClone(source);
  applyDeckPanels(deck, [source]);
  assert.deepEqual(
    deck.slides[0].imageCrop,
    regions.find((p) => p.label === "band-2-col-2")!.region,
  );
  assert.deepEqual(source, before);
  assert.equal("imagePanel" in deck.slides[0], false);
});

test("raster columns reject even faint connectors and narrow label gaps, and support wide paired plots", () => {
  const { ctx } = figure();
  ctx.fillStyle = "#eeeeee";
  ctx.fillRect(380, 20, 40, 4);
  const regions = rasterFigureRegions(ctx, 800, 1500);
  assert.equal(
    regions.some((p) => p.label.startsWith("band-1-col-")),
    false,
  );
  assert.equal(
    regions.some((p) => p.label.startsWith("band-2-col-")),
    true,
  );
  const wide = createCanvas(1000, 400),
    w = wide.getContext("2d");
  w.fillStyle = "white";
  w.fillRect(0, 0, 1000, 400);
  w.fillStyle = "black";
  w.fillRect(10, 20, 15, 300); // detached y label, not its own panel
  w.fillRect(45, 20, 400, 300);
  w.fillRect(550, 20, 420, 300);
  w.fillRect(45, 345, 400, 45);
  w.fillRect(550, 345, 420, 45);
  const cells = rasterFigureRegions(w, 1000, 400);
  assert.deepEqual(
    cells.map((p) => p.label),
    ["band-1-col-1", "band-1-col-2"],
  );
  assert.equal(cells[0].region.left, 0);
  assert.equal(cells[0].region.top, 0);
  assert.equal(cells[0].region.height, 1);
  assert.ok(cells[0].region.width > 0.445 && cells[0].region.width < 0.55);
  assert.equal(clearPanelBoundaries(w, 1000, 400, cells), true);
  w.fillStyle = "#ffb4b4";
  w.fillRect(440, 50, 120, 2);
  assert.deepEqual(rasterFigureRegions(w, 1000, 400), []);
});

function ruledFigure() {
  const canvas = createCanvas(800, 800),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 800, 800);
  ctx.fillStyle = "#666666";
  for (const x of [0, 399, 798]) ctx.fillRect(x, 0, 2, 800);
  for (const y of [0, 399, 798]) ctx.fillRect(0, y, 800, 2);
  ctx.fillStyle = "black";
  for (const x of [0, 400])
    for (const y of [0, 400]) {
      ctx.fillRect(x + 14, y + 14, 20, 16); // printed panel label
      ctx.fillRect(x + 70, y + 65, 2, 230); // y axis
      ctx.fillRect(x + 70, y + 295, 290, 2); // x axis
      ctx.fillRect(x + 20, y + 330, 340, 40); // complete attached risk table
    }
  return { canvas, ctx };
}
test("closed thin ruled grids expose complete rows and cells, retaining labels, axes and risk tables", () => {
  const { ctx } = ruledFigure();
  const regions = rasterFigureRegions(ctx, 800, 800);
  assert.deepEqual(
    regions.map((p) => p.label),
    [
      "band-1",
      "band-2",
      "band-1-col-1",
      "band-1-col-2",
      "band-2-col-1",
      "band-2-col-2",
    ],
  );
  assert.equal(clearPanelBoundaries(ctx, 800, 800, regions), true);
  const cells = regions.filter((p) => p.label.includes("-col-"));
  const coverage = new Uint8Array(800 * 800);
  for (const cell of cells) {
    const b = cropPixels(cell.region, 800, 800);
    for (let y = b.top; y < b.top + b.height; y++)
      for (let x = b.left; x < b.left + b.width; x++) coverage[y * 800 + x]++;
  }
  assert.ok(
    coverage.every((n) => n >= 1),
    "every original pixel remains in at least one complete cell",
  );
  const first = cropPixels(cells[0].region, 800, 800);
  assert.ok(first.width >= 399 && first.width <= 401);
  assert.ok(first.height > 370, "risk table must remain with plot");
  const forged = structuredClone(cells);
  forged[0].region.width = 0.45;
  assert.equal(
    clearPanelBoundaries(ctx, 800, 800, forged),
    false,
    "rule ID does not authorize an arbitrary cut",
  );
});
test("ruled-grid detection rejects crossed data, colored or thick dividers, incomplete frames and empty cells", () => {
  const crossed = ruledFigure();
  crossed.ctx.fillStyle = "#eeeeee";
  crossed.ctx.fillRect(380, 185, 40, 3);
  assert.deepEqual(rasterFigureRegions(crossed.ctx, 800, 800), []);
  const colored = ruledFigure();
  colored.ctx.fillStyle = "#ffb4b4";
  colored.ctx.fillRect(399, 0, 2, 800);
  assert.deepEqual(rasterFigureRegions(colored.ctx, 800, 800), []);
  const thick = ruledFigure();
  thick.ctx.fillStyle = "#666666";
  thick.ctx.fillRect(390, 0, 20, 800);
  assert.deepEqual(rasterFigureRegions(thick.ctx, 800, 800), []);
  const open = ruledFigure();
  open.ctx.fillStyle = "white";
  open.ctx.fillRect(0, 0, 2, 800);
  assert.deepEqual(rasterFigureRegions(open.ctx, 800, 800), []);
  const empty = ruledFigure();
  empty.ctx.fillStyle = "white";
  empty.ctx.fillRect(406, 406, 386, 386);
  assert.deepEqual(rasterFigureRegions(empty.ctx, 800, 800), []);
});

test("four-column ruled grids retain full rows without producing unsupported column IDs", () => {
  const c = createCanvas(1200, 800),
    ctx = c.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 800);
  ctx.fillStyle = "#666666";
  for (const x of [0, 299, 599, 899, 1198]) ctx.fillRect(x, 0, 2, 800);
  for (const y of [0, 399, 798]) ctx.fillRect(0, y, 1200, 2);
  ctx.fillStyle = "black";
  for (const x of [0, 300, 600, 900])
    for (const y of [0, 400]) ctx.fillRect(x + 50, y + 60, 180, 280);
  const regions = rasterFigureRegions(ctx, 1200, 800);
  assert.deepEqual(
    regions.map((p) => p.label),
    ["band-1", "band-2"],
  );
  assert.equal(clearPanelBoundaries(ctx, 1200, 800, regions), true);
  assert.ok(regions.every((p) => p.region.left === 0 && p.region.width === 1));
});

function staggeredColumns() {
  const canvas = createCanvas(1200, 900),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 900);
  ctx.fillStyle = "black";
  // The right-hand plot spans the left-hand gap; there is no full-width row cut.
  ctx.fillRect(650, 20, 500, 860);
  for (const y of [20, 470]) {
    ctx.fillRect(20, y, 18, 18); // printed label
    ctx.fillRect(70, y + 45, 460, 265); // plot and axes
    ctx.fillRect(70, y + 325, 460, 55); // attached risk/distribution rows
  }
  return { canvas, ctx };
}

test("staggered raster columns expose complete local rows without cutting attached risk rows", () => {
  const { ctx } = staggeredColumns();
  const regions = rasterFigureRegions(ctx, 1200, 900);
  const parent = regions.find((p) => p.label === "band-1-col-1")!;
  const children = regions.filter((p) =>
    p.label.startsWith("band-1-col-1-band-"),
  );
  assert.equal(children.length, 2);
  assert.ok(
    regions.some((p) => p.label === "band-1-col-2"),
    "whole-column fallback remains available",
  );
  assert.equal(
    regions.filter((p) => p.label.startsWith("band-1-col-2-band-")).length,
    0,
  );
  assert.equal(clearPanelBoundaries(ctx, 1200, 900, regions), true);
  const boxes = children.map((p) => cropPixels(p.region, 1200, 900));
  assert.ok(
    boxes[0].top + boxes[0].height >= 400,
    "first attached risk rows stay with their plot",
  );
  assert.ok(boxes[1].top <= 470, "second printed label stays inside its row");
  assert.ok(
    boxes[1].top + boxes[1].height >= 850,
    "second attached rows stay inside",
  );
  const coverage = new Uint8Array(900);
  for (const b of boxes)
    for (let y = b.top; y < b.top + b.height; y++) coverage[y]++;
  assert.ok(
    [...coverage].every((n) => n >= 1),
    "local rows retain every original pixel vertically",
  );
  assert.ok(
    children.every(
      (p) =>
        p.region.left === parent.region.left &&
        p.region.width === parent.region.width,
    ),
  );
  const source: Source = {
    id: "staggered",
    kind: "paper",
    title: "Original figure",
    text: "Figure caption",
    locator: "Figure 1",
    verified: false,
    image: ctx.canvas.toDataURL("image/png"),
    imagePanels: regions,
  };
  assert.ok(
    validRecordShape(
      "material-cache",
      {
        pages: ["Original text"],
        parseStatus: "ready",
        figures: [{ ...source, suffix: "-p1-fig1-1" }],
      },
      "hash-" + pdfExtractionVersion,
    ),
  );
  const parsed = groundedTeachingSchema([source])
    .shape.deck.unwrap()
    .shape.slides.parse([
      {
        title: "Local evidence",
        bullets: ["Complete plot and attached rows"],
        notes: "Keep the original axes and legend.",
        citations: [source.id],
        imageSource: source.id,
        imagePanel: source.id + ":" + children[1].label,
      },
    ]);
  const deck = { slides: parsed } as DeckOutline;
  applyDeckPanels(deck, [source]);
  assert.deepEqual(deck.slides[0].imageCrop, children[1].region);
});

test("local raster rows reject a faint connector and do not split a short attached result strip", () => {
  const { ctx } = staggeredColumns();
  ctx.fillStyle = "#ffb4b4";
  ctx.fillRect(300, 395, 2, 80);
  const crossed = rasterFigureRegions(ctx, 1200, 900);
  assert.ok(crossed.some((p) => p.label === "band-1-col-1"));
  assert.equal(
    crossed.some((p) => p.label.includes("-col-1-band-")),
    false,
    JSON.stringify(crossed),
  );
  const original = figure();
  assert.equal(
    rasterFigureRegions(original.ctx, 800, 1500).some((p) =>
      /-col-\d+-band-/.test(p.label),
    ),
    false,
  );
});

test("landscape multirow figures expose complete rows without slicing attached labels", () => {
  const canvas = createCanvas(1200, 820),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 820);
  ctx.fillStyle = "black";
  for (const top of [12, 432]) {
    for (const left of [12, 412, 812]) {
      ctx.fillRect(left, top, 20, 18); // printed panel label
      ctx.fillRect(left + 45, top + 35, 300, 260); // complete plot
      ctx.fillRect(left + 20, top + 315, 340, 70); // axis/attached distribution
    }
  }
  const bands = rasterFigureBands(ctx, 1200, 820);
  assert.equal(bands.length, 2);
  const cut = bands[1].region.top * 820;
  assert.ok(cut > 397 && cut < 432);
  assert.equal(clearPanelBoundaries(ctx, 1200, 820, bands), true);
  assert.equal(bands[0].region.top, 0);
  assert.equal(bands[1].region.top + bands[1].region.height, 1);
  // Every ink pixel is retained, and a connector disallows the row split.
  ctx.fillStyle = "#eeeeee";
  ctx.fillRect(600, 0, 2, 820);
  assert.deepEqual(rasterFigureBands(ctx, 1200, 820), []);
});

test("a wide plot stays attached to its short risk table across a broad white gap", () => {
  const canvas = createCanvas(1200, 820),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 820);
  ctx.fillStyle = "black";
  ctx.fillRect(30, 10, 1140, 500);
  ctx.fillRect(30, 650, 1140, 150);
  assert.deepEqual(rasterFigureBands(ctx, 1200, 820), []);
});
