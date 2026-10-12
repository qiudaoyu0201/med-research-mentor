import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { DeckVersions } from "../server/deck-versions.ts";
import { sample, defaultDeck } from "../examples/bundle.ts";
import type { Provider } from "../server/provider.ts";
import type { DeckVersion, PaperBundle } from "../shared/types.ts";
import { save } from "../server/storage.ts";
const review = { issues: [], checkedSources: ["xu-question"], limitations: [] };
const speechText =
  "# 开场\n今天分享研究问题与证据。\n\n# 逐页讲述\n按已保存的页面说明方法、结果及限制。\n\n# 转场\n接下来回到证据边界。\n\n# 结尾\n谢谢，欢迎讨论。";

test("saved deck survives source removal and restart; tampered evidence still blocks export", async () => {
  const h = harness([review]);
  const original = await h.store.seed("retained", sample.id);
  const restarted = new DeckVersions(
    h.provider,
    async () => {
      throw new Error("论文已删除");
    },
    async () => {},
    async (_outline, paper) => {
      assert.equal(paper.version, original.sourceVersion);
      return "fixture.pptx";
    },
  );
  restarted.versions.set(original.id, structuredClone(original));
  await restarted.export(original.id, "retained");
  const revised = await restarted.start(original.id, "retained", {
    slideIndex: 0,
    question: "修改标题",
    slide: { ...original.outline.slides[0], title: "保留来源后的修改" },
  });
  assert.equal((await restarted.wait(revised.id)).status, "completed");
  const tampered = structuredClone(original);
  tampered.sourceSnapshot!.sources.find((s) =>
    original.sourceIds.includes(s.id),
  )!.text += "篡改";
  restarted.versions.set(original.id, tampered);
  await assert.rejects(restarted.export(original.id, "retained"), /版本已变化/);
});
function harness(
  outputs: unknown[],
  paper: PaperBundle = structuredClone(sample),
  policy: "internal" | "online" = "internal",
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
    undefined,
    policy,
  );
  return { store, records, exports, paper, provider };
}

test("online speech uses natural delivery instructions without changing internal edit prompts", async () => {
  for (const policy of ["internal", "online"] as const) {
    const h = harness(
      [{ speechScript: speechText }, review],
      structuredClone(sample),
      policy,
    );
    const base = await h.store.seed("speech-policy", sample.id);
    const job = await h.store.start(base.id, "speech-policy", {
      operation: "speech",
      question: "补写讲稿",
    });
    const done = await h.store.wait(job.id);
    assert.equal(done.status, "completed", done.error);
    assert.equal(
      done.roles[0].instructions.includes("次要表达问题自行改善"),
      policy === "online",
    );
    assert.equal(
      done.roles[1].instructions.includes("问题按对当前任务的影响分级"),
      policy === "online",
    );
    assert.deepEqual(done.outline.slides, base.outline.slides);
    assert.equal(done.budget?.attempts.length, 2);
  }
});

test("full speech supplements and manual edits preserve the exact deck and previous scripts", async () => {
  const h = harness([{ speechScript: speechText }, review, review, review]);
  const base = await h.store.seed("speech-chat", sample.id);
  const started = await h.store.start(base.id, "speech-chat", {
    operation: "speech",
    question: "补写完整演讲稿",
  });
  const scripted = await h.store.wait(started.id);
  assert.equal(scripted.status, "completed", scripted.error);
  assert.equal(scripted.budget?.attempts.length, 2);
  assert.deepEqual(scripted.outline.slides, base.outline.slides);
  assert.equal(await h.store.speech(scripted.id, "speech-chat"), speechText);
  assert.equal(h.store.get(base.id).outline.speechScript, undefined);
  const manualText = speechText + "\n用户补充的结尾。";
  const saved = await h.store.wait(
    (
      await h.store.start(scripted.id, "speech-chat", {
        operation: "speech",
        question: "保存改稿",
        speechScript: manualText,
      })
    ).id,
  );
  assert.equal(saved.status, "completed", saved.error);
  assert.equal(saved.budget?.attempts.length, 1);
  assert.equal(await h.store.speech(saved.id, "speech-chat"), manualText);
  assert.equal(h.store.get(scripted.id).outline.speechScript, speechText);
  const edited = await h.store.wait(
    (
      await h.store.start(saved.id, "speech-chat", {
        slideIndex: 0,
        question: "保存页面",
        slide: { ...saved.outline.slides[0], title: "修改后的页面" },
      })
    ).id,
  );
  assert.equal(edited.status, "completed", edited.error);
  assert.equal(edited.outline.speechScript, undefined);
  assert.equal(h.store.get(saved.id).outline.speechScript, manualText);
  const restored = await h.store.restoreVersion(
    edited.id,
    saved.id,
    "speech-chat",
  );
  assert.equal(await h.store.speech(restored.id, "speech-chat"), manualText);
  await assert.rejects(h.store.speech(saved.id, "other-chat"), /本会话/);
  h.paper.version = "changed";
  assert.equal(await h.store.speech(saved.id, "speech-chat"), manualText);
});

test("manual full-speech check receives actual figures used by the saved deck", async () => {
  const paper = structuredClone(sample);
  const canvas = createCanvas(120, 80);
  canvas.getContext("2d").fillRect(10, 10, 90, 60);
  for (const source of paper.sources)
    if (["xu-fig1", "xu-fig6"].includes(source.id))
      source.image = canvas.toDataURL("image/png");
  const h = harness([review], paper);
  const images: (string | undefined)[] = [];
  const generate = h.provider.generate.bind(h.provider);
  h.provider.generate = async (i, x, s, signal, image) => {
    images.push(image);
    return generate(i, x, s, signal, image);
  };
  const base = await h.store.seed("figure-speech", paper.id);
  const saved = await h.store.wait(
    (
      await h.store.start(base.id, "figure-speech", {
        operation: "speech",
        question: "核对原图与完整稿",
        speechScript: speechText,
      })
    ).id,
  );
  assert.equal(saved.status, "completed", saved.error);
  assert.equal(saved.budget?.attempts.length, 1);
  assert.equal(saved.budget?.attempts[0].imageCount, 1);
  assert.match(images[0]!, /^data:image/);
  assert.deepEqual(saved.outline.slides, base.outline.slides);
});

test("blocking full speech stops after one repair and keeps the original usable", async () => {
  const blocking = {
    ...review,
    issues: [
      {
        id: "speech-error",
        location: "结尾",
        type: "fact",
        evidence: ["xu-question"],
        suggestion: "补造结果",
        severity: "blocking",
        resolved: false,
      },
    ],
  };
  const h = harness([
    { speechScript: speechText },
    blocking,
    { speechScript: speechText },
    blocking,
  ]);
  const base = await h.store.seed("speech-chat", sample.id);
  const result = await h.store.wait(
    (
      await h.store.start(base.id, "speech-chat", {
        operation: "speech",
        question: "补稿",
      })
    ).id,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.budget?.attempts.length, 4);
  assert.equal(result.budget?.revisions.length, 1);
  assert.equal(result.outline.speechScript, speechText);
  assert.equal(h.store.get(base.id).status, "completed");
  await assert.rejects(h.store.speech(result.id, "speech-chat"), /没有已完成/);
  await h.store.export(base.id, "speech-chat");
});

test("blocking manual speech is kept as a draft without automatic rewriting", async () => {
  const blocking = {
    ...review,
    issues: [
      {
        id: "draft-error",
        location: "结尾",
        type: "fact",
        evidence: ["xu-question"],
        suggestion: "需要用户修改",
        severity: "blocking",
        resolved: false,
      },
    ],
  };
  const h = harness([blocking]);
  const base = await h.store.seed("speech-chat", sample.id);
  const result = await h.store.wait(
    (
      await h.store.start(base.id, "speech-chat", {
        operation: "speech",
        question: "保存",
        speechScript: speechText,
      })
    ).id,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.budget?.attempts.length, 1);
  assert.equal(result.outline.speechScript, speechText);
});

test("speech cancellation retains the source deck and persists the interrupted attempt", async () => {
  const h = harness([]);
  const base = await h.store.seed("speech-chat", sample.id);
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.provider.generate = async (_i, _x, _s, signal) => {
    entered();
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      }),
    );
  };
  const result = await h.store.start(base.id, "speech-chat", {
    operation: "speech",
    question: "补稿",
  });
  await entry;
  await h.store.cancel(result.id);
  assert.equal(h.store.get(result.id).status, "cancelled");
  assert.equal(h.store.get(result.id).budget?.attempts.length, 1);
  assert.deepEqual(h.store.get(base.id).outline, base.outline);
});
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
  await h.store.export(edited.id, "conversation-a");
  assert.equal(h.exports.at(-1).materials.version, base.sourceVersion);
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
