import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import type { Provider } from "../server/provider.ts";
import {
  TaskManager,
  visibleInput,
  validateCitations,
  cacheKey,
  needsRevision,
} from "../server/orchestrator.ts";
import {
  sample,
  exampleUnits,
  profiles,
  defaultDeck,
} from "../examples/bundle.ts";
import type { TaskInput, TaskRun } from "../shared/types.ts";
import { exportDeck } from "../server/export.ts";
import { parsePdf } from "../server/pdf.ts";
import { inputSchema, groundedTeachingSchema } from "../server/schemas.ts";
import { defaultPaperSources } from "../server/materials.ts";
import { staticCheck } from "../server/replay.ts";
const input: TaskInput = {
  paperId: sample.id,
  module: "paper",
  mode: "live",
  question: "解释对照与推理",
  profileId: "beginner",
  sourceIds: sample.sources.map((s) => s.id),
  taughtConcepts: [],
};
const unit = exampleUnits.paper;
const novice = { understood: ["研究问题"], breakpoints: [] };
const review = { issues: [], checkedSources: ["xu-design"], limitations: [] };
async function wait(run: TaskRun) {
  await new Promise<void>((resolve, reject) => {
    const stop = setTimeout(() => reject(new Error("test timed out")), 4000);
    const timer = setInterval(() => {
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        clearInterval(timer);
        clearTimeout(stop);
        resolve();
      }
    }, 10);
  });
}
function provider(outputs: unknown[]): Provider {
  return {
    model: "fixture-test-only",
    async generate<T>(
      _instructions: string,
      _input: unknown,
      schema: import("zod").z.ZodType<T>,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      return { output: schema.parse(outputs.shift()) as T };
    },
  };
}
const discard = async () => {};

test("online peripheral advice does not force another model call, internal review still revises", async () => {
  const minor = {
    ...review,
    issues: [
      {
        id: "optional",
        location: "术语",
        type: "teaching" as const,
        evidence: ["xu-design"],
        suggestion: "可补充术语读法",
        severity: "warning" as const,
        resolved: false,
      },
    ],
  };
  for (const policy of ["online", "internal"] as const) {
    const outputs = [{ unit, deck: null }, minor, { unit, deck: null }, review];
    const manager = new TaskManager(provider(outputs), discard, policy);
    const run = await manager.start(
      { ...input, checks: { readability: false } },
      sample,
    );
    await wait(run);
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.calls, policy === "online" ? 2 : 4);
    if (policy === "online")
      assert.equal(run.review?.issues[0].resolved, false);
  }
  assert.equal(needsRevision(minor, novice, "online"), false);
  for (const type of ["fact", "scope"] as const)
    assert.equal(
      needsRevision(
        { ...minor, issues: [{ ...minor.issues[0], type }] },
        novice,
        "online",
      ),
      false,
    );
  assert.equal(
    needsRevision(
      { ...minor, issues: [{ ...minor.issues[0], severity: "blocking" }] },
      novice,
      "online",
    ),
    true,
  );
  assert.equal(
    needsRevision(
      {
        ...minor,
        issues: ["a", "b", "c"].map((location) => ({
          ...minor.issues[0],
          location,
        })),
      },
      novice,
      "online",
    ),
    false,
  );
  assert.equal(
    needsRevision(
      minor,
      {
        understood: [],
        breakpoints: [
          {
            id: "bp",
            sentence: "原句",
            missingConcept: "比较",
            question: "为什么",
            status: "open",
          },
        ],
      },
      "online",
    ),
    true,
  );
});
test("grounded PPT schema keeps generated slide text within the renderable budget", () => {
  const schema = groundedTeachingSchema(sample.sources);
  const base = structuredClone(defaultDeck);
  assert.equal(schema.safeParse({ unit, deck: base }).success, true);
  assert.equal(
    schema.safeParse({
      unit,
      deck: {
        ...base,
        slides: [{ ...base.slides[0], bullets: ["a", "b", "c", "d", "e"] }],
      },
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      unit,
      deck: {
        ...base,
        slides: [{ ...base.slides[0], bullets: ["x".repeat(121)] }],
      },
    }).success,
    false,
  );
});

test("full speech is explicit, required when selected, and isolated in cache; generic PPT includes methods", () => {
  const ordinary = { unit, deck: defaultDeck };
  assert.throws(() =>
    groundedTeachingSchema(sample.sources, true).parse(ordinary),
  );
  const text = "开场、逐页讲述、转场和结尾";
  assert.deepEqual(
    groundedTeachingSchema(sample.sources, true).parse({
      ...ordinary,
      deck: { ...defaultDeck, speechScript: text },
    }).deck,
    { ...defaultDeck, speechScript: text },
  );
  assert.deepEqual(
    groundedTeachingSchema(sample.sources).parse({
      ...ordinary,
      deck: { ...defaultDeck, speechScript: text },
    }).deck,
    defaultDeck,
  );
  assert.notEqual(
    cacheKey(input, sample, {}, "fixture"),
    cacheKey({ ...input, speechScript: true }, sample, {}, "fixture"),
  );
  const generic = {
    ...sample,
    id: "observational-paper",
    sources: [
      {
        ...sample.sources[0],
        id: "overview",
        section: "overview" as const,
        image: undefined,
      },
      {
        ...sample.sources[0],
        id: "cohort-methods",
        section: "methods" as const,
        image: undefined,
      },
      {
        ...sample.sources[0],
        id: "observational-result",
        section: "results" as const,
        image: undefined,
      },
    ],
  };
  assert.deepEqual(
    defaultPaperSources(generic, "生成汇报", ["ppt"]).map((s) => s.id),
    ["overview", "cohort-methods", "observational-result"],
  );
});
test("three roles pass in three calls, novice cannot see raw methods or review", async () => {
  const manager = new TaskManager(
    provider([{ unit, deck: null }, novice, review]),
    discard,
  );
  const run = await manager.start(input, sample);
  await wait(run);
  assert.equal(run.status, "completed");
  assert.equal(run.calls, 3);
  assert.deepEqual(
    run.roles.map((r) => r.role),
    ["teaching", "novice", "grounding"],
  );
  const isolated = run.roles[1].input as any;
  assert.ok(!("sources" in isolated));
  assert.ok(!("review" in isolated));
  assert.ok(!("referenceAnswer" in isolated));
  assert.equal(isolated.profile.id, "beginner");
  const visible = visibleInput(input, unit, profiles[0], [
    {
      id: "original",
      title: "Figure 1",
      kind: "paper",
      figure: "1",
      page: 2,
      text: "RAW_METHODS_MUST_STAY_HIDDEN",
      caption: "图注",
      locator: "page 2",
      verified: false,
    },
  ]);
  assert.equal(visible.visibleFigures[0].caption, "图注");
  assert.ok(!JSON.stringify(visible).includes("RAW_METHODS_MUST_STAY_HIDDEN"));
});
test("one revision, same profile and six calls maximum", async () => {
  const feedback = {
    understood: [],
    breakpoints: [
      {
        id: "gap1",
        sentence: "干预",
        missingConcept: "对照",
        question: "为什么需要对照？",
        status: "open",
      },
    ],
  };
  const final = {
    ...feedback,
    breakpoints: [{ ...feedback.breakpoints[0], status: "resolved" }],
  };
  const manager = new TaskManager(
    provider([
      { unit, deck: null },
      feedback,
      review,
      { unit, deck: null },
      final,
      review,
    ]),
    discard,
  );
  const run = await manager.start(input, sample);
  await wait(run);
  assert.equal(run.calls, 6);
  assert.equal(run.status, "completed");
  const first = run.roles[1].input as any,
    last = run.roles[4].input as any;
  assert.deepEqual(first.profile, last.profile);
  assert.equal(last.previousBreakpoints[0].id, "gap1");
});
test("unknown citation prevents publication", () => {
  const broken = structuredClone(unit);
  broken.sections[0].citations = ["invented-id"];
  assert.throws(
    () => validateCitations(broken, review, sample.sources),
    /引用/,
  );
});
test("remaining blocking fact does not become confirmed export content", async () => {
  const blocked = {
    issues: [
      {
        id: "wrong",
        location: "无法映射的假数字",
        type: "fact",
        evidence: ["xu-design"],
        suggestion: "删除无来源数字",
        severity: "blocking",
        resolved: false,
      },
    ],
    checkedSources: ["xu-design"],
    limitations: [],
  };
  const manager = new TaskManager(
    provider([
      { unit, deck: null },
      novice,
      blocked,
      { unit, deck: null },
      novice,
      blocked,
    ]),
    discard,
  );
  const run = await manager.start(input, sample);
  await wait(run);
  assert.equal(run.status, "failed");
  assert.equal(run.result, undefined);
  assert.equal(run.deck, undefined);
  assert.equal(run.calls, 6);
});
test("cancel prevents later role calls and final result", async () => {
  let calls = 0;
  const slow: Provider = {
    model: "test",
    generate: async (_i, _x, schema, signal) => {
      calls++;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 1000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return { output: schema.parse({ unit, deck: null }) };
    },
  };
  const manager = new TaskManager(slow, discard);
  const run = await manager.start(input, sample);
  await new Promise((r) => setTimeout(r, 30));
  await manager.cancel(run.id);
  await wait(run);
  assert.equal(run.status, "cancelled");
  assert.ok(calls <= 1);
  assert.equal(run.result, undefined);
});
test("source, question, skills and profile versions affect cache identity", () => {
  const key = cacheKey(input, sample, { method: "1" }, "test");
  assert.notEqual(
    key,
    cacheKey(
      { ...input, question: "不同问题" },
      sample,
      { method: "1" },
      "test",
    ),
  );
  assert.notEqual(key, cacheKey(input, sample, { method: "2" }, "test"));
  assert.notEqual(
    key,
    cacheKey(
      { ...input, profileId: "methods" },
      sample,
      { method: "1" },
      "test",
    ),
  );
});
test("example records zero model calls and uploaded material cannot use fixed sample", async () => {
  const manager = new TaskManager(provider([]), discard);
  const run = await manager.start({ ...input, mode: "example" }, sample);
  await wait(run);
  assert.equal(run.status, "completed");
  assert.equal(run.calls, 0);
  assert.equal(run.roles.length, 0);
  await assert.rejects(
    () =>
      manager.start({ ...input, mode: "example", paperId: "upload" }, sample),
    /上传论文/,
  );
});
test("malformed model output fails without retry", async () => {
  const manager = new TaskManager(
    provider([{ unit: { title: "bad" }, deck: null }]),
    discard,
  );
  const run = await manager.start(input, sample);
  await wait(run);
  assert.equal(run.status, "failed");
  assert.equal(run.calls, 1);
});
test("candidate losing citation or missing-material rules is rejected by static gate", () => {
  assert.equal(staticCheck("只解释原理，任何时候都给结论").passed, false);
  assert.equal(
    staticCheck("解释基础原理与测量对象，绑定来源引用，缺材料时说明不足。")
      .passed,
    true,
  );
});
test("input rejects arbitrary source shape and non-image crop payload", () => {
  assert.throws(() =>
    inputSchema.parse({ ...input, visibleImage: "file:///secret" }),
  );
});
test("concurrent starts reserve a single task before asynchronous preparation", async () => {
  const manager = new TaskManager(
    provider([{ unit, deck: null }, novice, review]),
    discard,
  );
  const first = manager.start(input, sample);
  await assert.rejects(() => manager.start(input, sample), /已有学习任务/);
  await wait(await first);
});
test("PPTX keeps editable text and separate notes, and rejects lost referenced images", async () => {
  await assert.rejects(
    exportDeck(defaultDeck, sample, "test-missing-image"),
    /图片数据缺失/,
  );
  const textDeck = structuredClone(defaultDeck);
  for (const slide of textDeck.slides) slide.imageSource = "";
  const path = await exportDeck(textDeck, sample, "test-deck");
  const zip = unzipSync(new Uint8Array(await readFile(path)));
  const slides = Object.keys(zip).filter((k) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(k),
  );
  const notes = Object.keys(zip).filter((k) =>
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k),
  );
  for (const match of strFromU8(zip["[Content_Types].xml"]).matchAll(
    /<Override\b[^>]*PartName="([^"]+)"/g,
  ))
    assert.ok(zip[match[1].slice(1)], "declared part exists: " + match[1]);
  assert.equal(slides.length, 8);
  assert.equal(notes.length, 8);
  for (const file of notes) {
    const text = [...strFromU8(zip[file]).matchAll(/<a:t>(.*?)<\/a:t>/g)]
      .map((m) => m[1])
      .join("");
    assert.match(text, /^\d+$/); // PptxGenJS emits empty placeholders plus a page number.
  }
  assert.match(strFromU8(zip[slides[0]]), /<a:t>/);
  assert.ok(slides.every((s) => !strFromU8(zip[s]).includes("原图未提供")));
  assert.ok(defaultDeck.slides.some((s) => s.notes.length > 0));
});
test("PDF importer extracts actual pages and rejects malformed files", async () => {
  await mkdir("runs", { recursive: true });
  const body =
    "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n5 0 obj << /Length 120 >> stream\nBT /F1 16 Tf 50 650 Td (Scientific teaching evidence and control comparison in this sample PDF.) Tj ET\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF";
  const { writeFile } = await import("node:fs/promises");
  await writeFile("runs/test.pdf", body);
  const pdf = await parsePdf("runs/test.pdf", "test-pdf", "Test");
  assert.equal(pdf.pageCount, 1);
  assert.match(pdf.sources[0].text, /control comparison/);
  assert.equal(pdf.sources[0].page, 1);
  await writeFile("runs/invalid.pdf", "not a PDF");
  await assert.rejects(
    () => parsePdf("runs/invalid.pdf", "invalid", "Invalid"),
    /有效 PDF/,
  );
});

test("generation cannot label paper-only evidence as an unavailable foundation", () => {
  const paperSources = sample.sources.filter((s) => s.kind === "paper");
  const output = {
    unit: {
      ...unit,
      sections: [
        {
          title: "原理",
          text: "测量的解释。",
          kind: "foundation",
          citations: ["xu-design"],
        },
      ],
    },
    deck: null,
  };
  assert.throws(() => groundedTeachingSchema(paperSources).parse(output));
  const foundation = {
    ...sample.sources[0],
    id: "foundation",
    kind: "foundation" as const,
  };
  output.unit.sections[0].citations = ["foundation"];
  assert.equal(
    groundedTeachingSchema([...paperSources, foundation]).parse(output).unit
      .sections[0].kind,
    "foundation",
  );
  output.unit.sections[0].kind = "background";
  output.unit.sections[0].citations = [];
  assert.equal(
    groundedTeachingSchema(paperSources).parse(output).unit.sections[0].kind,
    "background",
  );
});
