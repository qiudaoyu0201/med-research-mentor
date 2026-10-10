import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { pdfRuntime, pdfExtractionVersion } from "../server/pdf-runtime.ts";
import { validRecordShape } from "../server/record-shapes.ts";

test("PDF decoder resources resolve locally with PDF.js trailing slash semantics on Windows", async () => {
  for (const path of [pdfRuntime.wasmUrl, pdfRuntime.cMapUrl, pdfRuntime.standardFontDataUrl]) {
    assert.ok(path.endsWith("/"));
    assert.ok(!path.startsWith("http"));
    await access(path);
  }
  await access(pdfRuntime.wasmUrl + "jbig2.wasm");
  await access(pdfRuntime.wasmUrl + "openjpeg.wasm");
});
test("new decoder uses a fresh cache version while old cache records remain readable", () => {
  assert.equal(pdfExtractionVersion, "pdf-figures-v3");
  const record = { pages: ["原文"], parseStatus: "ready", figures: [] };
  for (const version of ["pdf-figures-v2", pdfExtractionVersion]) {
    assert.ok(validRecordShape("material-cache", record, `hash-${version}`));
    assert.equal(validRecordShape("material-cache", { pages: null }, `hash-${version}`), false);
  }
});
