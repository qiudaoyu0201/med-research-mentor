import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { root, read } from "../server/storage.ts";
import {
  saveDisplayAsset,
  type DisplayAsset,
} from "../server/display-assets.ts";
import { pdfFixture } from "./pdf-fixture.ts";
import { DeckVersions } from "../server/deck-versions.ts";
import { sample } from "../examples/bundle.ts";
import type { Provider } from "../server/provider.ts";

test("display PDF derivatives use the original page at 3200px, cap pixels, and cache immutably without mutating the source", async () => {
  const id = `display-test-${Date.now()}`;
  await mkdir(join(root, "uploads"), { recursive: true });
  await writeFile(join(root, "uploads", `${id}.pdf`), pdfFixture());
  const source = {
    id: "page",
    kind: "paper" as const,
    title: "page",
    text: "fixture",
    locator: "page 1",
    page: 1,
    image: createCanvas(50, 50).toDataURL("image/png"),
    verified: false,
  };
  const paper = {
    id,
    version: "v1",
    title: "PDF",
    scope: "fixture",
    sources: [source],
    pdfUrl: `/api/papers/${id}/pdf`,
  };
  const before = structuredClone(source);
  const key = await saveDisplayAsset(paper, source),
    asset = await read<DisplayAsset>("display-assets", key);
  assert.equal(asset.purpose, "page");
  assert.ok(asset.width > 3000);
  assert.ok(asset.width * asset.height <= 12_000_000);
  assert.deepEqual(source, before);
  assert.equal(await saveDisplayAsset(paper, source), key);
  const decoded = await loadImage(asset.image);
  assert.equal(decoded.width, asset.width);
  assert.equal(decoded.height, asset.height);
});

test("new deck assets persist across store restart; legacy versions remain unchanged and cannot be silently upgraded on export", async () => {
  const paper = structuredClone(sample),
    records = new Map<string, unknown>(),
    outputs: any[] = [];
  for (const s of paper.sources.filter((s) => s.figure))
    s.image = createCanvas(100, 100).toDataURL("image/png");
  const provider: Provider = {
    model: "zero-call",
    async generate() {
      throw new Error("No model request expected");
    },
  };
  const persist = async (g: string, id: string, value: unknown) => {
    records.set(`${g}/${id}`, structuredClone(value));
  };
  const exporter = async (_outline: unknown, materials: unknown) => {
    outputs.push(materials);
    return "fixture.pptx";
  };
  const store = new DeckVersions(
    provider,
    async () => paper,
    persist,
    exporter,
  );
  const version = await store.seed("asset-chat", paper.id),
    immutable = structuredClone(version);
  assert.ok(Object.keys(version.displayAssets!).length > 0);
  assert.ok(
    Object.values(version.displayAssetQuality!).every(
      (value) => value === "legacy",
    ),
  );
  const restarted = new DeckVersions(
    provider,
    async () => paper,
    persist,
    exporter,
  );
  restarted.versions.set(version.id, structuredClone(version));
  await restarted.export(version.id, "asset-chat");
  assert.equal(outputs.length, 1);
  const exportedVersion = restarted.get(version.id);
  assert.equal(exportedVersion.exportIds?.length, 1);
  const { exportIds, ...unchangedContent } = exportedVersion;
  assert.deepEqual(unchangedContent, immutable);
  const legacy = {
    ...version,
    id: "legacy-deck",
    displayAssets: undefined,
    displayAssetQuality: undefined,
  };
  restarted.versions.set(legacy.id, legacy);
  await restarted.export(legacy.id, "asset-chat");
  assert.equal(restarted.get(legacy.id).displayAssets, undefined);
  const restored = await restarted.restoreVersion(
    version.id,
    legacy.id,
    "asset-chat",
  );
  assert.ok(restored.displayAssets);
  assert.equal(restarted.get(legacy.id).displayAssets, undefined);
});
