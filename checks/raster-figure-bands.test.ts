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
