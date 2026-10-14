import test from "node:test";
import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfRuntime } from "../server/pdf-runtime.ts";
import { pageFigures } from "../server/pdf-figures.ts";

// Tiny original PDF with real vector geometry and independently styled caption runs.
function fixture(caption: string, graphics: boolean | string = true) {
  const stream = [
    typeof graphics === "string"
      ? graphics
      : graphics
        ? "90 220 400 250 re S"
        : "",
    graphics ? "BT /F1 10 Tf 96 230 Td (Y axis) Tj ET" : "",
    caption,
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Length " +
      Buffer.byteLength(stream) +
      " >>\nstream\n" +
      stream +
      "\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += index + 1 + " 0 obj\n" + object + "\nendobj\n";
  }
  const xref = Buffer.byteLength(pdf);
  pdf += "xref\n0 " + offsets.length + "\n0000000000 65535 f \n";
  pdf += offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("");
  pdf +=
    "trailer\n<< /Size " +
    offsets.length +
    " /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF\n";
  return new Uint8Array(Buffer.from(pdf));
}
const text = (font: string, x: number, y: number, value: string) =>
  "BT /" +
  font +
  " 8 Tf " +
  x +
  " " +
  y +
  " Td (" +
  value.replace(/[\\()]/g, "\\$&") +
  ") Tj ET";
const split = (suffix = ".", x = 58, y = 160) =>
  [
    text("F2", 36, 160, "Fig 2"),
    text("F1", x, y, suffix),
    text("F1", 65, 160, "Outcome by group."),
  ].join("\n");
async function extract(caption: string, graphics: boolean | string = true) {
  const task = getDocument({ ...pdfRuntime, data: fixture(caption, graphics) });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    return {
      items: content.items,
      sources: await pageFigures(page, "fixture", content.items),
    };
  } finally {
    await task.destroy();
  }
}

test("figure extraction recognizes an adjacent punctuation run and retains the plotted region", async () => {
  const result = await extract(split());
  assert.ok(result.items.some((item: any) => item.str === "Fig 2"));
  assert.equal(result.sources.length, 1);
  const source = result.sources[0];
  assert.equal(source.figure, "2");
  assert.equal(source.id, "fixture-p1-fig2-1");
  assert.match(source.caption!, /Outcome by group/);
  assert.ok(source.image?.startsWith("data:image/png;base64,"));
  const region = source.imageRegion!;
  assert.ok(region.left < 90 / 612);
  assert.ok(region.left + region.width > 490 / 612);
  assert.ok(region.top < 322 / 792);
  assert.ok(region.top + region.height > 572 / 792);
  assert.ok(region.top + region.height < 624 / 792);
});

test("figure extraction still accepts a complete caption in one text run", async () => {
  const result = await extract(
    text("F1", 36, 160, "Figure 3. Outcome by group."),
  );
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].figure, "3");
});

test("bare figure references cannot borrow punctuation from another line or column", async () => {
  for (const caption of [
    split(")."),
    split(".", 120),
    split(".", 58, 140),
    split(".5"),
  ]) {
    const result = await extract(caption);
    assert.ok(result.items.some((item: any) => item.str === "Fig 2"));
    assert.deepEqual(result.sources, []);
  }
});

test("a split caption without original plot geometry does not invent a figure", async () => {
  const result = await extract(split(), false);
  assert.deepEqual(result.sources, []);
});

test("short caption titles retain wide multi-panel explanations and their controls", async () => {
  const result = await extract(
    [
      text("F2", 36, 160, "Figure 2. Outcome."),
      text(
        "F1",
        36,
        150,
        "(A) Oxygen treatment is compared with its matched control.",
      ),
      text(
        "F1",
        36,
        140,
        "(B) Expression is normalized to the loading reference.",
      ),
      text("F1", 36, 130, "(C) si-C is a scrambled control; N is untreated."),
    ].join("\n"),
  );
  assert.equal(result.sources.length, 1);
  const caption = result.sources[0].caption!;
  assert.match(caption, /Oxygen treatment/);
  assert.match(caption, /loading reference/);
  assert.match(caption, /si-C is a scrambled control; N is untreated/);
});

test("short caption titles retain continuation lines wider than the original plot", async () => {
  const explanation = "(A) " + "Control measurements ".repeat(7) + "n=3.";
  const result = await extract(
    [
      text("F2", 36, 160, "Figure 4. Short title."),
      text("F1", 36, 150, explanation),
    ].join("\n"),
  );
  const continuation = result.items.find((item: any) =>
    item.str?.includes("Control measurements"),
  ) as any;
  assert.ok(
    36 + continuation.width > 497,
    "fixture must extend beyond the plot and its padding",
  );
  assert.equal(result.sources.length, 1);
  assert.match(result.sources[0].caption!, /Control measurements/);
});

test("long captions keep final panel methods beyond the old 110-point cutoff", async () => {
  const lines = Array.from({ length: 15 }, (_, i) =>
    text(
      "F1",
      36,
      160 - i * 8,
      i === 0
        ? "Figure 3. Result."
        : i === 14
          ? "(E) Final method and independent repeat count n=3."
          : "Caption explanation of the plotted comparison.",
    ),
  );
  const result = await extract(lines.join("\n"));
  assert.equal(result.sources.length, 1);
  assert.match(
    result.sources[0].caption!,
    /Final method and independent repeat count n=3/,
  );
});

test("caption extraction stops before separated body text and publication footers", async () => {
  const result = await extract(
    [
      text("F1", 36, 160, "Figure 2. Outcome."),
      text("F1", 36, 150, "(A) Caption comparison and its control."),
      text("F1", 36, 118, "Unrelated body text that must remain on the page."),
      text("F1", 36, 100, "Publication footer and page number."),
    ].join("\n"),
  );
  const caption = result.sources[0].caption!;
  assert.match(caption, /Caption comparison/);
  assert.doesNotMatch(caption, /Unrelated body|Publication footer/);
});

test("uppercase panel labels in original PDF geometry bind separate figure regions", async () => {
  const result = await extract(
    [
      text("F2", 96, 400, "A"),
      text("F2", 300, 400, "B"),
      text("F1", 36, 160, "Figure 4. (A) Measurement. (B) Control."),
    ].join("\n"),
    "90 220 400 250 re S",
  );
  assert.equal(result.sources.length, 1);
  const panels = result.sources[0].imagePanels!;
  assert.deepEqual(
    panels.map((p) => p.label),
    ["a", "b"],
  );
  assert.ok(
    panels[0].region.left + panels[0].region.width <= panels[1].region.left,
  );
  assert.ok(panels[0].region.width < 0.6 && panels[1].region.width < 0.6);
});
