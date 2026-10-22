import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { rasterFigureBands } from "../server/raster-figure-bands.ts";
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
