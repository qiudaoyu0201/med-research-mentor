import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  figurePanels,
  clearPanelBoundaries,
  applyDeckPanels,
} from "../server/figure-panels.ts";
import { groundedTeachingSchema } from "../server/schemas.ts";
import { pptDeckImagePacket } from "../server/ppt-image-packet.ts";
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
