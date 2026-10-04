import { parsePdf } from "../server/pdf.ts";
import { writeFile } from "node:fs/promises";
import { localSample } from "../server/sample.ts";
import { exportDeck } from "../server/export.ts";
import { defaultDeck } from "../examples/bundle.ts";
import assert from "node:assert/strict";
const paper = await parsePdf(
  "data/papers/Xu_2018_Senolytics/Xu_2018_NatureMedicine_Senolytics_fulltext.pdf",
  "xu-original",
  "Xu 2018",
);
await writeFile("runs/xu-text.json", JSON.stringify(paper, null, 2));
const loaded = await localSample();
assert.equal(loaded.pageCount, 15);
for (const [id, page] of [
  ["xu-fig1", 2],
  ["xu-fig6", 8],
] as const) {
  const source = loaded.sources.find((s) => s.id === id)!;
  assert.equal(source.page, page);
  assert.ok(source.caption?.startsWith("Fig."));
  assert.ok(source.image);
  await writeFile(
    `runs/${id}.png`,
    Buffer.from(source.image.split(",")[1], "base64"),
  );
}
await exportDeck(defaultDeck, loaded, "xu-original-check");
console.log(
  paper.sources.map((s) => ({
    page: s.page,
    head: s.text.slice(0, 150),
    chars: s.text.length,
    figure1: s.text.includes("Transplanting small numbers"),
    figure6: s.text.includes("Senolytics extend"),
  })),
);
