import assert from "node:assert/strict";
import { test } from "node:test";
import { cropFromPoints, cropPixels } from "../app/research-pdf-crop.ts";

test("PDF crop normalizes reverse drags and confines selection to the actual page", () => {
  const crop = cropFromPoints({ x: 0.9, y: 0.8 }, { x: 0.1, y: 0.2 });
  assert.equal(crop.left, 0.1);
  assert.equal(crop.top, 0.2);
  assert.ok(Math.abs(crop.width - 0.8) < 1e-12);
  assert.ok(Math.abs(crop.height - 0.6) < 1e-12);
  assert.deepEqual(cropFromPoints({ x: -2, y: 0.2 }, { x: 3, y: 5 }), {
    left: 0,
    top: 0.2,
    width: 1,
    height: 0.8,
  });
});

test("PDF crop preserves the same region across zoom, pixel density and rotated viewport dimensions", () => {
  const crop = { left: 0.25, top: 0.1, width: 0.5, height: 0.2 };
  assert.deepEqual(cropPixels(crop, 600, 800), {
    left: 150,
    top: 80,
    width: 300,
    height: 160,
  });
  assert.deepEqual(cropPixels(crop, 1200, 1600), {
    left: 300,
    top: 160,
    width: 600,
    height: 320,
  });
  assert.deepEqual(cropPixels(crop, 800, 600), {
    left: 200,
    top: 60,
    width: 400,
    height: 120,
  });
});

test("PDF crop rejects corrupt stored coordinates and retains fractional edge pixels", () => {
  for (const crop of [
    { left: -1, top: 0, width: 1, height: 1 },
    { left: 0, top: 0, width: 0, height: 1 },
    { left: 0.9, top: 0, width: 0.2, height: 1 },
    { left: NaN, top: 0, width: 1, height: 1 },
  ])
    assert.equal(cropPixels(crop, 600, 800), undefined);
  assert.equal(
    cropPixels({ left: 0, top: 0, width: 1, height: 1 }, 0, 800),
    undefined,
  );
  assert.deepEqual(
    cropPixels(
      { left: 0.121, top: 0.231, width: 0.205, height: 0.177 },
      100,
      100,
    ),
    { left: 12, top: 23, width: 21, height: 18 },
  );
});
