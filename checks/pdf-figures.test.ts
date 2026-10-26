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
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im1 7 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Length " +
      Buffer.byteLength(stream) +
      " >>\nstream\n" +
      stream +
      "\nendstream",
    "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\nAAAAAAAAAAAA\nendstream",
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

test("a figure reference at the end of a body line cannot relabel an earlier plot", async () => {
  for (const reference of [
    text("F2", 220, 100, "Fig 2."),
    [text("F2", 220, 100, "Fig 2"), text("F1", 241, 100, ".")].join("\n"),
  ]) {
    const result = await extract(
      [
        text("F1", 36, 160, "Fig 1. Outcome."),
        text("F1", 140, 100, "Results are shown in "),
        reference,
      ].join("\n"),
    );
    assert.ok(result.items.some((item: any) => /^Fig 2/.test(item.str)));
    assert.deepEqual(
      result.sources.map((source) => source.figure),
      ["1"],
    );
    assert.doesNotMatch(result.sources[0].caption!, /Results are shown/);
  }
});

test("separate column captions on the same baseline remain independent anchors", async () => {
  const result = await extract(
    [
      text("F1", 36, 160, "Fig 1. Left outcome."),
      text("F2", 350, 160, "Fig 2"),
      text("F1", 371, 160, ". Right outcome."),
    ].join("\n"),
    "40 220 210 250 re S\n350 220 210 250 re S",
  );
  assert.deepEqual(
    result.sources.map((source) => source.figure),
    ["1", "2"],
  );
  const [left, right] = result.sources.map((source) => source.imageRegion!);
  assert.ok(left.left + left.width < right.left);
});

test("raster-style plots separated by clear horizontal gutters expose spatial bands without panel letters", async () => {
  const result = await extract(
    text("F1", 36, 100, "Figure 5. Paired plots with distributions."),
    "90 450 400 240 re f\n90 170 400 240 re f",
  );
  assert.equal(result.sources.length, 1);
  const bands = result.sources[0].imagePanels!;
  assert.deepEqual(
    bands.map((p) => p.label),
    ["band-1", "band-2"],
  );
  assert.ok(bands.every((p) => p.region.left === 0 && p.region.width === 1));
  assert.equal(bands[0].region.top, 0);
  assert.equal(bands[1].region.top + bands[1].region.height, 1);
});

test("raster columns expose whole-height paired plots through the PDF extraction path", async () => {
  const result = await extract(
    text("F1", 36, 100, "Figure 6. Paired complete plots."),
    "90 220 170 250 re\n320 220 170 250 re f",
  );
  assert.equal(result.sources.length, 1);
  const regions = result.sources[0].imagePanels!;
  assert.deepEqual(
    regions.map((p) => p.label),
    ["band-1-col-1", "band-1-col-2"],
  );
  assert.equal(regions[0].region.left, 0);
  assert.equal(regions[1].region.left + regions[1].region.width, 1);
  assert.equal(regions[0].region.width, regions[1].region.left);
  assert.ok(regions.every((p) => p.region.top === 0 && p.region.height === 1));
});

test("closed ruled figure grids survive PDF extraction with full-cell region choices", async () => {
  const graphics = [
    "0.5 w 90 220 400 400 re S",
    "290 220 m 290 620 l S 90 420 m 490 420 l S",
    ...[90, 290].flatMap((x) =>
      [220, 420].flatMap((y) => [
        `${x + 30} ${y + 45} 140 120 re S`,
        `${x + 15} ${y + 15} 170 15 re f`,
      ]),
    ),
  ].join("\n");
  const result = await extract(
    text("F1", 36, 160, "Figure 7. Outcomes in four study groups."),
    graphics,
  );
  assert.equal(result.sources.length, 1);
  const regions = result.sources[0].imagePanels!;
  assert.deepEqual(
    regions?.map((p) => p.label),
    [
      "band-1",
      "band-2",
      "band-1-col-1",
      "band-1-col-2",
      "band-2-col-1",
      "band-2-col-2",
    ],
  );
  const lowerRight = regions.at(-1)!.region;
  assert.ok(lowerRight.top > 0.49 && lowerRight.top < 0.51);
  assert.ok(lowerRight.left > 0.49 && lowerRight.left < 0.51);
  assert.ok(lowerRight.left + lowerRight.width >= 0.999);
  assert.ok(lowerRight.top + lowerRight.height >= 0.999);
});

test("styled figure labels without trailing punctuation bind an adjacent caption title", async () => {
  const result = await extract(
    [
      text("F2", 36, 160, "Fig. 2"),
      text("F1", 67, 160, "Causal impact analysis on patient outcomes."),
    ].join("\n"),
  );
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].figure, "2");
  assert.match(result.sources[0].caption!, /Causal impact analysis/);
});

test("unpunctuated figure references in the main text font do not create figures", async () => {
  const result = await extract(
    [
      text("F1", 36, 160, "Fig. 2"),
      text("F1", 67, 160, "Shows the patient outcomes discussed above."),
    ].join("\n"),
  );
  assert.equal(result.sources.length, 0);
});

test("styled figure numbers require an adjacent title on the same baseline", async () => {
  for (const [x, y, title] of [
    [145, 160, "Causal impact analysis on patient outcomes."],
    [67, 145, "Causal impact analysis on patient outcomes."],
    [67, 160, "shows the patient outcomes discussed above."],
  ] as const) {
    const result = await extract(
      [text("F2", 36, 160, "Fig. 2"), text("F1", x, y, title)].join("\n"),
    );
    assert.equal(result.sources.length, 0);
  }
});

test("a styled unpunctuated label cannot skip intervening punctuation or create a plot", async () => {
  const malformed = await extract(
    [
      text("F2", 36, 160, "Fig. 2"),
      text("F1", 61, 160, ")."),
      text("F1", 70, 160, "Causal impact analysis on patient outcomes."),
    ].join("\n"),
  );
  assert.equal(malformed.sources.length, 0);
  const noPlot = await extract(
    [
      text("F2", 36, 160, "Fig. 2"),
      text("F1", 67, 160, "Causal impact analysis on patient outcomes."),
    ].join("\n"),
    false,
  );
  assert.equal(noPlot.sources.length, 0);
});

test("a raster figure below a separately titled ruled table excludes that table", async () => {
  const result = await extract(
    [
      text("F2", 36, 690, "Table 1."),
      text("F1", 78, 690, "Observed and expected outcomes."),
      text("F2", 36, 160, "Fig. 2"),
      text("F1", 67, 160, "Causal impact analysis on patient outcomes."),
    ].join("\n"),
    "36 660 500 1.2 re f\n36 500 500 1.2 re f\nq 400 0 0 250 90 220 cm /Im1 Do Q",
  );
  assert.equal(result.sources.length, 1);
  const region = result.sources[0].imageRegion!;
  assert.ok(region.top > 0.38, "the table above the plot is excluded");
  assert.ok(region.top < 0.41, "the top of the original plot is retained");
  assert.ok(region.top + region.height > 0.72, "bottom labels are retained");
  assert.doesNotMatch(result.sources[0].caption!, /Table 1/);
});

test("table separation requires matching original rules rather than an inferred table height", async () => {
  const result = await extract(
    [
      text("F2", 36, 690, "Table 1."),
      text("F1", 78, 690, "Observed and expected outcomes."),
      text("F2", 36, 160, "Fig. 2"),
      text("F1", 67, 160, "Causal impact analysis on patient outcomes."),
    ].join("\n"),
    "36 660 500 1.2 re f\n70 500 430 1.2 re f\nq 400 0 0 250 90 220 cm /Im1 Do Q",
  );
  assert.equal(result.sources.length, 1);
  assert.ok(result.sources[0].imageRegion!.top < 0.2);
});

test("subpixel borders enclose the full table including its notes above a figure", async () => {
  const result = await extract(
    [
      text("F2", 36, 690, "Table 1."),
      text("F1", 78, 690, "Observed and expected outcomes."),
      text("F1", 36, 495, "Table note below the last data row."),
      text("F2", 36, 160, "Fig. 2"),
      text("F1", 67, 160, "Causal impact analysis on patient outcomes."),
    ].join("\n"),
    "36 700 500 0.45 re f\n36 510 500 1.2 re f\n36 480 500 0.5 re f\nq 400 0 0 250 90 220 cm /Im1 Do Q",
  );
  assert.equal(result.sources.length, 1);
  const region = result.sources[0].imageRegion!;
  assert.ok(region.top > 0.39, "table notes and outer border are excluded");
  assert.ok(region.top < 0.41, "plot top is retained");
  assert.ok(region.top + region.height > 0.72, "bottom labels are retained");
});

test("a body sentence beginning with an unpunctuated figure reference cannot become a caption", async () => {
  for (const phrase of [
    "Figure 3 shows the effect in the trial population.",
    "Fig. 3 shows the effect in the trial population.",
  ]) {
    const result = await extract(text("F1", 36, 160, phrase));
    assert.equal(result.sources.length, 0);
  }
});

test("a complete unpunctuated caption still needs a distinct caption font and title", async () => {
  const title = "Figure 3 Treatment effect in the trial population.";
  const body = text(
    "F1",
    36,
    700,
    "The study methods and results are described here in the main text font with sufficient context.",
  );
  const result = await extract([body, text("F2", 36, 160, title)].join("\n"));
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].figure, "3");
  assert.equal(
    (await extract([body, text("F1", 36, 160, title)].join("\n"))).sources
      .length,
    0,
  );
});

test("a neighboring text column across a narrow gutter does not suppress a real caption", async () => {
  const paragraph =
    "The left column describes the study population and baseline characteristics.";
  const probe = await extract(text("F1", 36, 161.5, paragraph), false);
  const item = probe.items.find(
    (candidate) => "str" in candidate && candidate.str === paragraph,
  );
  assert.ok(item && "width" in item);
  const width = item.width;
  const result = await extract(
    [
      text("F1", 338 - width, 161.5, paragraph),
      text("F2", 350, 160, "Fig. 1 | Outcomes by randomized group."),
    ].join("\n"),
    "350 220 210 250 re S",
  );
  assert.deepEqual(
    result.sources.map((source) => source.figure),
    ["1"],
  );
  assert.ok(result.sources[0].imageRegion!.left > 0.5);
});

test("out-of-order PDF text runs retain axis titles and the attached risk rows", async () => {
  const result = await extract(
    [
      text("F2", 36, 160, "Fig. 1 | Time to first kidney event."),
      text("F1", 96, 185, "Placebo 100 90 80"),
      text("F1", 96, 194, "Treatment 100 92 84"),
      text("F1", 180, 210, "Time since randomization (weeks)"),
    ].join("\n"),
  );
  assert.equal(result.sources.length, 1);
  const bottom =
    result.sources[0].imageRegion!.top + result.sources[0].imageRegion!.height;
  assert.ok(bottom * 792 >= 607, "both attached risk rows must remain visible");
  assert.ok(bottom * 792 < 624, "the caption must not enter the crop");
});
