import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { DeckVersions } from "../server/deck-versions.ts";
import { sample, defaultDeck } from "../examples/bundle.ts";
import type { Provider } from "../server/provider.ts";
import type { DeckVersion, PaperBundle } from "../shared/types.ts";
import { save } from "../server/storage.ts";
const review = { issues: [], checkedSources: ["xu-question"], limitations: [] };
function harness(
  outputs: unknown[],
  paper: PaperBundle = structuredClone(sample),
) {
  const records = new Map<string, any>();
  const persist: typeof save = async (g, id, value) => {
    records.set(`${g}/${id}`, structuredClone(value));
  };
  const provider: Provider = {
    model: "fixture",
    async generate(_i, _x, schema, signal) {
      signal.throwIfAborted();
      return { output: schema.parse(outputs.shift()) };
    },
  };
  const exports: any[] = [];
  const store = new DeckVersions(
    provider,
    async () => paper,
    persist,
    async (outline, materials) => {
      exports.push({ outline, materials });
      return "fixture.pptx";
    },
  );
  return { store, records, exports, paper, provider };
}
test("single page edits preserve all other content and pictures, restore appends a version, exports the selected snapshot", async () => {
  const h = harness([review]);
  for (const source of h.paper.sources.filter((s) => s.figure))
    source.image = createCanvas(8, 8).toDataURL("image/png");
  const base = await h.store.seed("conversation-a", sample.id);
  const slide = {
    ...base.outline.slides[1],
    title: "相关出现，还是真有作用？",
  };
  const started = await h.store.start(base.id, "conversation-a", {
    slideIndex: 1,
    question: "保存第二页",
    slide,
  });
  const edited = await h.store.wait(started.id);
  assert.equal(edited.status, "completed", edited.error);
  assert.equal(edited.budget?.attempts.length, 1);
  assert.equal(edited.parentId, base.id);
  for (let i = 0; i < base.outline.slides.length; i++)
    if (i !== 1)
      assert.deepEqual(edited.outline.slides[i], base.outline.slides[i]);
  assert.deepEqual(h.store.get(base.id).outline, defaultDeck);
  const restored = await h.store.restoreVersion(
    edited.id,
    base.id,
    "conversation-a",
  );
  assert.equal(restored.parentId, edited.id);
  assert.equal(restored.restoredFrom, base.id);
  assert.deepEqual(restored.outline, base.outline);
  assert.equal(restored.budget, undefined);
  await h.store.export(edited.id, "conversation-a");
  assert.deepEqual(h.exports[0].outline, edited.outline);
  await assert.rejects(h.store.export(base.id, "conversation-b"), /本会话/);
  h.paper.version = "changed";
  await assert.rejects(
    h.store.export(edited.id, "conversation-a"),
    /版本已变化/,
  );
});
test("model edits only receive the target page; one revision retains a blocking failure and old export", async () => {
  const slide = { ...defaultDeck.slides[1], title: "改写后的问题" };
  const blocked = {
    issues: [
      {
        id: "missing-denominator",
        location: "第 2 页",
        type: "material",
        evidence: ["xu-question"],
        suggestion: "计数分母未提供，不能确认",
        severity: "blocking",
        resolved: false,
      },
    ],
    checkedSources: ["xu-question"],
    limitations: [],
  };
  const h = harness([slide, blocked, slide, blocked]);
  const base = await h.store.seed("conversation-a", sample.id);
  const started = await h.store.start(base.id, "conversation-a", {
    slideIndex: 1,
    question: "改写第二页",
  });
  const failed = await h.store.wait(started.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.budget?.attempts.length, 4);
  assert.equal(failed.budget?.revisions.length, 1);
  assert.deepEqual(
    (failed.roles[0].input as any).original,
    base.outline.slides[1],
  );
  assert.equal(
    JSON.stringify(failed.roles[0].input).includes(
      base.outline.slides[6].notes,
    ),
    false,
  );
  assert.ok(
    failed.review.issues.some(
      (i) => i.id === "missing-denominator" && !i.resolved,
    ),
  );
  await assert.rejects(h.store.export(failed.id, "conversation-a"), /不能导出/);
  await h.store.export(base.id, "conversation-a");
  assert.ok(h.records.get(`deck-versions/${failed.id}`).roles[3].output);
});
test("cancellation and invalid citation cannot replace the parent", async () => {
  const h = harness([]);
  const base = await h.store.seed("conversation-a", sample.id);
  let entered!: () => void;
  const startedCall = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.provider.generate = async (_i, _x, _schema, signal) => {
    entered();
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      }),
    );
  };
  const started = await h.store.start(base.id, "conversation-a", {
    slideIndex: 1,
    question: "修改第二页",
  });
  await startedCall;
  await h.store.cancel(started.id);
  const cancelled = h.store.get(started.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.budget?.attempts.length, 1);
  assert.deepEqual(h.store.get(base.id).outline, defaultDeck);
  await assert.rejects(
    h.store.start(base.id, "other", { slideIndex: 1, question: "修改第二页" }),
    /本会话/,
  );
  const invalid = await h.store.start(base.id, "conversation-a", {
    slideIndex: 1,
    question: "保存",
    slide: { ...defaultDeck.slides[1], citations: ["foreign"] },
  });
  assert.equal((await h.store.wait(invalid.id)).status, "failed");
  assert.equal(h.store.get(invalid.id).budget?.attempts.length, 0);
});
