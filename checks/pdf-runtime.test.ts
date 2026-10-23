import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { pdfRuntime, pdfExtractionVersion } from "../server/pdf-runtime.ts";
import { validRecordShape } from "../server/record-shapes.ts";

test("PDF decoder resources resolve locally with PDF.js trailing slash semantics on Windows", async () => {
  for (const path of [
    pdfRuntime.wasmUrl,
    pdfRuntime.cMapUrl,
    pdfRuntime.standardFontDataUrl,
  ]) {
    assert.ok(path.endsWith("/"));
    assert.ok(!path.startsWith("http"));
    await access(path);
  }
  await access(pdfRuntime.wasmUrl + "jbig2.wasm");
  await access(pdfRuntime.wasmUrl + "openjpeg.wasm");
});
test("new decoder uses a fresh cache version while old cache records remain readable", () => {
  assert.equal(pdfExtractionVersion, "pdf-figures-v10-raster-columns");
  const record = { pages: ["原文"], parseStatus: "ready", figures: [] };
  for (const version of [
    "pdf-figures-v2",
    "pdf-figures-v3",
    "pdf-figures-v4-panels",
    "pdf-figures-v5-caption-anchors",
    "pdf-figures-v6-caption-width",
    "pdf-figures-v7-panel-labels",
    "pdf-figures-v8-caption-line-start",
    "pdf-figures-v9-raster-bands",
    pdfExtractionVersion,
  ]) {
    assert.ok(validRecordShape("material-cache", record, `hash-${version}`));
    assert.equal(
      validRecordShape("material-cache", { pages: null }, `hash-${version}`),
      false,
    );
  }
});

test("panel cache rejects corrupt and duplicate crop metadata while preserving older figure records", () => {
  const figure = {
    suffix: "-p1-fig1-1",
    title: "Figure 1",
    kind: "paper",
    text: "Caption",
    locator: "PDF 1",
    verified: false,
  };
  const record = (imagePanels?: unknown) => ({
    pages: ["原文"],
    parseStatus: "ready",
    figures: [
      { ...figure, ...(imagePanels === undefined ? {} : { imagePanels }) },
    ],
  });
  const key = `hash-${pdfExtractionVersion}`,
    panel = { label: "a", region: { left: 0, top: 0, width: 0.5, height: 1 } };
  assert.ok(validRecordShape("material-cache", record(), key));
  assert.ok(validRecordShape("material-cache", record([panel]), key));
  assert.ok(
    validRecordShape(
      "material-cache",
      record([{ ...panel, label: "band-1" }]),
      key,
    ),
  );
  assert.ok(
    validRecordShape(
      "material-cache",
      record([{ ...panel, label: "band-2-col-1" }]),
      key,
    ),
  );
  for (const malformed of [
    [{ ...panel, label: "band-2-col-4" }],
    null,
    { a: panel },
    [panel, panel],
    [{ ...panel, region: { ...panel.region, width: 2 } }],
  ])
    assert.equal(
      validRecordShape("material-cache", record(malformed), key),
      false,
    );
});
