import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  figurePanels,
  clearPanelBoundaries,
  applyDeckPanels,
  panelSelectionIds,
} from "../server/figure-panels.ts";
import { groundedTeachingSchema } from "../server/schemas.ts";
import {
  pptDeckImagePacket,
  pptSelectionImagePacket,
} from "../server/ppt-image-packet.ts";
import type { Source, DeckOutline } from "../shared/types.ts";
const box = { left: 0, top: 0, right: 500, bottom: 400 };
const point = (text: string, left: number, top: number, font = "labels") => ({
  text,
  left,
  top,
  right: left + 5,
  bottom: top + 8,
  height: 8,
  font,
});
const caption =
  "a , Design. b , Marker. c , Count. d , Stain. e , Death. f , Table. g , RNA.";
const labels = [
  point("a", 8, 8),
  point("b", 220, 8),
  point("c", 8, 130),
  point("d", 320, 130),
  point("e", 8, 230),
  point("f", 300, 230),
  point("g", 8, 310),
];

test("uppercase parenthesized captions bind uppercase printed labels", () => {
  const uppercaseLabels = labels.map((p) => ({
    ...p,
    text: p.text.toUpperCase(),
  }));
  const panels = figurePanels(
    box,
    "(A) Design. (B) Marker. (C) Count. (D) Stain. (E) Death. (F) Table. (G) RNA.",
    uppercaseLabels,
  );
  assert.equal(panels.length, 7);
  assert.deepEqual(
    panels.map((panel) => panel.label),
    ["a", "b", "c", "d", "e", "f", "g"],
  );
});

test("uppercase captions do not invent raster panels or accept ambiguous labels", () => {
  const caption = "(A) Measurement. (B) Control.";
  const uppercase = labels.slice(0, 2).map((p) => ({
    ...p,
    text: p.text.toUpperCase(),
  }));
  assert.deepEqual(figurePanels(box, caption, []), []);
  assert.deepEqual(figurePanels(box, caption, [uppercase[0]]), []);
  assert.deepEqual(
    figurePanels(box, caption, [...uppercase, point("a", 100, 70)]),
    [],
  );
  assert.deepEqual(
    figurePanels(box, caption, [
      uppercase[1],
      { ...uppercase[0], left: 300, right: 305 },
    ]),
    [],
  );
});

test("printed panels keep the tall table intact while the lower left panel starts separately", () => {
  const panels = figurePanels(box, caption, labels);
  assert.equal(panels.length, 7);
  const table = panels.find((p) => p.label === "f")!.region,
    lower = panels.find((p) => p.label === "g")!.region;
  assert.ok(table.top < lower.top);
  assert.equal(table.top + table.height, 1);
  assert.equal(lower.left + lower.width, table.left);
  const p16 = panels.find((p) => p.label === "c")!.region;
  assert.equal(p16.left, 0);
  assert.ok(p16.width > 0.6);
});

test("caption letters and outside-page text cannot become figure panels", () => {
  assert.deepEqual(figurePanels(box, "Study without named panels", labels), []);
  assert.deepEqual(
    figurePanels(box, "a , Design. b , Result.", [
      point("a", 8, 405),
      point("b", 220, 405),
    ]),
    [],
  );
  assert.deepEqual(
    figurePanels(
      box,
      caption,
      labels.filter((p) => p.text !== "c"),
    ),
    [],
  );
});

test("ambiguous duplicate labels and reversed reading order retain the full figure", () => {
  assert.deepEqual(
    figurePanels(box, caption, [...labels, point("a", 100, 70)]),
    [],
  );
  const reversed = labels.map((p) =>
    p.text === "a"
      ? { ...p, left: 250, right: 255 }
      : p.text === "b"
        ? { ...p, left: 8, right: 13 }
        : p,
  );
  assert.deepEqual(figurePanels(box, caption, reversed), []);
});

test("partial caption does not truncate visibly labelled later panels", () => {
  assert.equal(figurePanels(box, "a , Design. b , Result.", labels).length, 7);
});

test("an internal cut through an axis or image is rejected instead of clipped", () => {
  const canvas = createCanvas(100, 100),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 100, 100);
  const panels = [
    { label: "a", region: { left: 0, top: 0, width: 0.5, height: 1 } },
    { label: "b", region: { left: 0.5, top: 0, width: 0.5, height: 1 } },
  ];
  assert.equal(clearPanelBoundaries(ctx, 100, 100, panels), true);
  ctx.fillStyle = "black";
  ctx.fillRect(49, 10, 3, 80);
  assert.equal(clearPanelBoundaries(ctx, 100, 100, panels), false);
});

const image = () => {
  const c = createCanvas(100, 60),
    ctx = c.getContext("2d");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 50, 60);
  ctx.fillStyle = "blue";
  ctx.fillRect(50, 0, 50, 60);
  return c.toDataURL("image/png");
};
const source = (): Source => ({
  id: "figure",
  title: "Figure 1",
  kind: "paper",
  text: "Evidence",
  locator: "PDF 1",
  verified: false,
  image: image(),
  imagePanels: [
    { label: "a", region: { left: 0, top: 0, width: 0.5, height: 1 } },
  ],
});
const deck = (extra: object = {}): DeckOutline => ({
  slides: [
    {
      title: "Result",
      bullets: ["Evidence"],
      notes: "Explain",
      citations: ["figure"],
      imageSource: "figure",
      ...extra,
    },
  ],
});

test("panel coordinates are resolved from the selected source and the transient ID is removed", () => {
  const sources = [source()],
    d = deck({ imagePanel: "figure:a" });
  applyDeckPanels(d, sources);
  assert.deepEqual(d.slides[0].imageCrop, sources[0].imagePanels![0].region);
  assert.equal("imagePanel" in d.slides[0], false);
  d.slides[0].imageCrop!.left = 0.1;
  assert.equal(sources[0].imagePanels![0].region.left, 0);
});

test("a panel from a different source or a corrupt saved region cannot bind", () => {
  assert.throws(() =>
    applyDeckPanels(deck({ imagePanel: "other:a" }), [source()]),
  );
  assert.throws(() =>
    applyDeckPanels(deck({ imageSource: "", imagePanel: "figure:a" }), [
      source(),
    ]),
  );
  const corrupted = source();
  corrupted.imagePanels![0].region.width = 2;
  assert.throws(() =>
    applyDeckPanels(deck({ imagePanel: "figure:a" }), [corrupted]),
  );
  const slides = groundedTeachingSchema([source()]).shape.deck.unwrap().shape
    .slides;
  assert.throws(() =>
    slides.parse(deck({ imagePanel: "figure:invented" }).slides),
  );
});

test("legacy whole-figure output and explicit manual crops remain unchanged", () => {
  const plain = deck({ imagePanel: "" });
  applyDeckPanels(plain, [source()]);
  assert.equal(plain.slides[0].imageCrop, undefined);
  const manual = deck({
      imageCrop: { left: 0.5, top: 0, width: 0.5, height: 1 },
    }),
    before = structuredClone(manual);
  applyDeckPanels(manual, [source()]);
  assert.deepEqual(manual, before);
});

test("review image uses the actual selected crop instead of the whole original", async () => {
  const d = deck({ imagePanel: "figure:a" }),
    s = source();
  applyDeckPanels(d, [s]);
  const rendered = await loadImage((await pptDeckImagePacket(d, [s]))!);
  assert.equal(rendered.width, 50);
  assert.equal(rendered.height, 60);
  const c = createCanvas(50, 60);
  c.getContext("2d").drawImage(rendered, 0, 0);
  assert.deepEqual(
    [...c.getContext("2d").getImageData(25, 30, 1, 1).data],
    [255, 0, 0, 255],
  );
  await assert.rejects(pptDeckImagePacket(d, []));
});

test("selection board shows the complete original and real candidate crop without changing saved evidence", async () => {
  const s = source(),
    before = structuredClone(s);
  const rendered = await loadImage((await pptSelectionImagePacket([s]))!);
  assert.equal(rendered.width, 1800);
  assert.equal(rendered.height, 620);
  const c = createCanvas(1800, 620),
    ctx = c.getContext("2d");
  ctx.drawImage(rendered, 0, 0);
  const pixel = (x: number, y: number) => [
    ...ctx.getImageData(x, y, 1, 1).data,
  ];
  assert.ok(pixel(200, 300)[0] > 240 && pixel(200, 300)[2] < 15);
  assert.ok(pixel(700, 300)[2] > 240 && pixel(700, 300)[0] < 15);
  assert.ok(pixel(1100, 300)[0] > 240 && pixel(1100, 300)[2] < 15);
  assert.deepEqual(s, before);
  assert.equal(
    await pptSelectionImagePacket([{ ...s, imagePanels: undefined }]),
    s.image,
  );
  // Review still receives only the actual selected crop, never the option board.
  const d = deck({ imagePanel: "figure:a" });
  applyDeckPanels(d, [s]);
  const review = await loadImage((await pptDeckImagePacket(d, [s]))!);
  assert.equal(review.width, 50);
  assert.equal(review.height, 60);
});
test("candidate pictures do not displace whole originals and total board size stays bounded", async () => {
  const s = source(),
    many = Array.from({ length: 10 }, (_, i) => ({
      ...s,
      id: "figure-" + i,
      imagePanels: Array.from({ length: 8 }, (_, j) => ({
        ...s.imagePanels![0],
        label: String.fromCharCode(97 + j),
      })),
    }));
  const board = await loadImage((await pptSelectionImagePacket(many))!);
  assert.equal(board.width, 1800);
  assert.equal(board.height, 620 * 8);
  assert.equal(await pptSelectionImagePacket([]), undefined);
});

test("grounded crop selection rejects candidates outside the actual visual board", () => {
  const s = source();
  const many = Array.from({ length: 10 }, (_, i) => ({
    ...s,
    id: "figure-" + i,
    imagePanels: Array.from({ length: 8 }, (_, j) => ({
      ...s.imagePanels![0],
      label: String.fromCharCode(97 + j),
    })),
  }));
  const before = structuredClone(many);
  assert.deepEqual(
    panelSelectionIds(many),
    many.slice(0, 8).map((s) => s.id + ":a"),
  );
  const slides = groundedTeachingSchema(many).shape.deck.unwrap().shape.slides;
  slides.parse(
    deck({
      imageSource: "figure-7",
      imagePanel: "figure-7:a",
      citations: ["figure-7"],
    }).slides,
  );
  for (const id of ["figure-0:b", "figure-8:a"]) {
    assert.throws(() =>
      slides.parse(
        deck({
          imageSource: id.split(":")[0],
          citations: [id.split(":")[0]],
          imagePanel: id,
        }).slides,
      ),
    );
  }
  assert.deepEqual(many, before);
  assert.deepEqual(panelSelectionIds([s]), ["figure:a"]);
});

test("source review retains cited full originals beside crops without exposing them in page-only review", async () => {
  const s = source(),
    d = deck({ imagePanel: "figure:a" });
  applyDeckPanels(d, [s]);
  const before = structuredClone({ s, d });
  const review = await loadImage((await pptDeckImagePacket(d, [s], true))!);
  assert.equal(review.width, 1800);
  assert.equal(review.height, 620);
  const canvas = createCanvas(review.width, review.height),
    ctx = canvas.getContext("2d");
  ctx.drawImage(review, 0, 0);
  const blue = [...ctx.getImageData(1700, 300, 1, 1).data];
  assert.ok(
    blue[2] > 240 && blue[0] < 15,
    "the uncropped source panel is available for fact checking",
  );
  const page = await loadImage((await pptDeckImagePacket(d, [s]))!);
  assert.equal(page.width, 50);
  assert.equal(page.height, 60);
  const table = deck({ imageSource: "", layout: "table" });
  assert.equal(await pptDeckImagePacket(table, [s]), undefined);
  const tableReview = await loadImage(
    (await pptDeckImagePacket(table, [s], true))!,
  );
  assert.equal(
    tableReview.width,
    1800,
    "a table-only source image is labelled as original evidence",
  );
  assert.equal(
    await pptDeckImagePacket(
      deck({ citations: [], imageSource: "" }),
      [s],
      true,
    ),
    undefined,
  );
  assert.deepEqual({ s, d }, before);
});
