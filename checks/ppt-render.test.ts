import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { renderDeckPages } from "../server/ppt-render.ts";
import { sample } from "../examples/bundle.ts";
import type { DeckOutline } from "../shared/types.ts";

const image = createCanvas(800, 500);
image.getContext("2d").fillStyle = "#177E7D";
image.getContext("2d").fillRect(0, 0, 800, 500);
const paper = {
  ...sample,
  sources: sample.sources.map((source) =>
    source.id === "xu-fig1"
      ? { ...source, image: image.toDataURL("image/png") }
      : source,
  ),
};

const deck: DeckOutline = {
  slides: [
    {
      title: "研究路径",
      bullets: ["队列：识别研究对象", "指标：比较两组结果"],
      notes: "",
      citations: ["xu-fig1"],
      imageSource: "xu-fig1",
    },
    {
      title: "判断边界",
      bullets: ["观察关联不等于因果"],
      notes: "",
      citations: ["xu-fig1"],
      layout: "spotlight",
    },
  ],
};

test("renders every PPT page and a contact sheet from the frozen deck", async () => {
  const directory = await mkdtemp(join(tmpdir(), "medmentor-ppt-render-"));
  try {
    const result = await renderDeckPages(deck, paper.sources, directory);
    assert.equal(result.renderer, "layout-preview");
    assert.equal(result.pageCount, deck.slides.length);
    assert.equal(result.pages.length, deck.slides.length);
    for (const path of [...result.pages, result.contactSheet]) {
      const bytes = await readFile(path);
      assert.ok(bytes.length > 1000, path);
      assert.deepEqual(
        [...bytes.slice(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
