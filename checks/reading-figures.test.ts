import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { readingImagePacket } from "../server/reading-image-packet.ts";
import { diagnosticReadingImage } from "../server/model-diagnostic.ts";
import { digest } from "../server/materials.ts";
import { groundedTeachingSchema, unitSchema } from "../server/schemas.ts";
import {
  readingFiguresBySection,
  validateReadingFigures,
} from "../shared/reading-figures.ts";
import { reviewArtifact } from "../server/internal-training.ts";
import { BudgetLedger } from "../server/budget.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { RecordStorage } from "../server/storage.ts";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  LearningUnit,
  PaperBundle,
  Source,
  TaskRun,
} from "../shared/types.ts";
import type { Provider } from "../server/provider.ts";

const source = (): Source => {
  const c = createCanvas(200, 100),
    ctx = c.getContext("2d");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 100, 100);
  ctx.fillStyle = "blue";
  ctx.fillRect(100, 0, 100, 100);
  return {
    id: "figure",
    kind: "paper",
    title: "Figure 1",
    text: "Left red; right blue.",
    locator: "p1",
    verified: true,
    figure: "1",
    image: c.toDataURL(),
    imagePanels: [
      { label: "a", region: { left: 0, top: 0, width: 0.5, height: 1 } },
      { label: "b", region: { left: 0.5, top: 0, width: 0.5, height: 1 } },
    ],
  };
};
const unit = (): LearningUnit => ({
  title: "Reading",
  question: "Compare",
  sections: [
    {
      title: "First",
      text: "The left group.",
      kind: "paper",
      citations: ["figure"],
    },
    {
      title: "Second",
      text: "The right group.",
      kind: "paper",
      citations: ["figure"],
    },
  ],
  terms: [],
  nextQuestion: "What control is needed?",
});

test("legacy reading figures appear once at their first citation; explicit panels stay by their own section", () => {
  const s = source(),
    old = unit();
  assert.deepEqual(
    readingFiguresBySection(old, [s]).map((f) => f.map((x) => x.source.id)),
    [["figure"], []],
  );
  old.sections[1].figures = [{ sourceId: "figure", panelId: "figure:b" }];
  const located = readingFiguresBySection(old, [s]);
  assert.equal(located[0].length, 0);
  assert.equal(located[1][0].panel?.label, "b");
  assert.equal(old.sections[1].text, "The right group.");
});

test("reading bindings reject other figures, uncited sources, unknown and unseen panels", () => {
  const s = source(),
    u = unit();
  u.sections[0].figures = [{ sourceId: "figure", panelId: "figure:a" }];
  assert.doesNotThrow(() =>
    validateReadingFigures(u, [s], {
      sourceIds: [s.id],
      panelIds: ["figure:a"],
    }),
  );
  for (const invalid of [
    { sourceId: "other" },
    { sourceId: "figure", panelId: "figure:z" },
    { sourceId: "figure", panelId: "figure:b" },
  ]) {
    const changed = structuredClone(u);
    changed.sections[0].figures = [invalid];
    assert.throws(
      () =>
        validateReadingFigures(changed, [s], {
          sourceIds: [s.id],
          panelIds: ["figure:a"],
        }),
      /图源|面板/,
    );
  }
  const uncited = structuredClone(u);
  uncited.sections[0].citations = [];
  assert.throws(() => validateReadingFigures(uncited, [s]), /图源/);
  assert.throws(
    () => validateReadingFigures(u, [s], { sourceIds: [] }),
    /图源/,
  );
});

test("reading schema only offers actually exposed panels and old records still parse", () => {
  const s = source(),
    u = unit();
  const schema = groundedTeachingSchema([s], false, {
    readingFigureSourceIds: [s.id],
    readingFigurePanelIds: ["figure:a"],
  });
  u.sections[0].figures = [{ sourceId: s.id, panelId: "figure:a" }];
  assert.ok(schema.safeParse({ unit: u, deck: null }).success);
  u.sections[0].figures[0].panelId = "figure:b";
  assert.equal(schema.safeParse({ unit: u, deck: null }).success, false);
  u.sections[0].figures = [{ sourceId: "" }];
  assert.equal(schema.safeParse({ unit: u, deck: null }).success, false);
  u.sections[0].figures = [{ sourceId: s.id }];
  assert.equal(
    groundedTeachingSchema([s]).safeParse({ unit: u, deck: null }).success,
    false,
  );
  assert.ok(unitSchema.safeParse(unit()).success);
});

test("single-figure panel board binds complete original and visible crops for independent review", async () => {
  const s = source(),
    packet = await readingImagePacket([s]);
  assert.notEqual(packet.image, s.image);
  assert.deepEqual(packet.panelIds, ["figure:a", "figure:b"]);
  const binding = {
    sourceIds: packet.sourceIds,
    panelIds: packet.panelIds,
    imageHash: digest(packet.image!),
  };
  assert.deepEqual(diagnosticReadingImage(packet.image, [s], binding), {
    image: packet.image,
    imageSourceIds: ["figure"],
    imagePanelIds: ["figure:a", "figure:b"],
  });
  for (const invalid of [
    { ...binding, imageHash: "changed" },
    { ...binding, panelIds: ["figure:z"] },
    { ...binding, panelIds: ["figure:a", "figure:a"] },
    { ...binding, sourceIds: [] },
  ])
    assert.throws(
      () => diagnosticReadingImage(packet.image, [s], invalid),
      /绑定无效/,
    );
  assert.throws(
    () =>
      diagnosticReadingImage(s.image, [s], {
        sourceIds: [s.id],
        imageHash: "changed",
      }),
    /绑定无效/,
  );
  assert.throws(
    () =>
      diagnosticReadingImage(s.image, [s], {
        sourceIds: [],
        imageHash: digest(s.image!),
      }),
    /绑定无效/,
  );
  assert.deepEqual(await readingImagePacket([s], s.image), {
    image: s.image,
    sourceIds: [s.id],
  });
});

test("panel selection survives generation, grounding, record save and reopen without binary snapshots", async () => {
  const s = source(),
    u = unit();
  u.sections[0].figures = [{ sourceId: s.id, panelId: "figure:a" }];
  u.sections[1].figures = [{ sourceId: s.id, panelId: "figure:b" }];
  const paper: PaperBundle = {
    id: "panel-paper",
    version: "1",
    title: "Panel study",
    scope: "Fixture",
    sources: [s],
  };
  const outputs = [
    { unit: u, deck: null },
    { understood: ["comparison"], breakpoints: [] },
    { issues: [], checkedSources: [s.id], limitations: [] },
  ];
  const images: (string | undefined)[] = [];
  const provider: Provider = {
    model: "fixture",
    async generate(_rules, input: any, schema, _signal, image) {
      images.push(image);
      assert.deepEqual(input.visibleImagePanelIds, ["figure:a", "figure:b"]);
      return { output: schema.parse(outputs.shift()) };
    },
  };
  const folder = await mkdtemp(resolve("runs/reading-panels-storage-")),
    store = new RecordStorage(folder);
  const manager = new TaskManager(provider, (g, id, data) =>
    store.save(g, id, data),
  );
  const run = await manager.start(
    {
      paperId: paper.id,
      module: "paper",
      mode: "live",
      question: "Compare both panels",
      profileId: "beginner",
      sourceIds: [s.id],
      taughtConcepts: [],
    },
    paper,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(images.length, 3);
  assert.ok(images.every((image) => image === run.input.visibleImage));
  const saved = await store.read<TaskRun>("runs", run.id);
  assert.deepEqual(
    saved.result?.sections.map((s) => s.figures),
    u.sections.map((s) => s.figures),
  );
  assert.deepEqual(saved.readingImageEvidence?.panelIds, [
    "figure:a",
    "figure:b",
  ]);
  assert.ok(saved.materials![0].sources.every((s) => !s.image));
  assert.equal(
    readingFiguresBySection(saved.result!, [s])[1][0].panel?.label,
    "b",
  );
});

test("panel review refuses missing originals and mismatched panel bindings before dispatch", async () => {
  let calls = 0;
  const provider: Provider = {
    model: "fixture",
    async generate(rules, input: any, schema, _signal, image) {
      calls++;
      assert.match(rules, /imagePanelIds/);
      assert.equal(image, "panel-board");
      return {
        output: schema.parse({
          checks: [
            {
              criterion: "correspondence",
              passed: true,
              location: "First",
              sourceIds: ["figure"],
              explanation: "matched",
            },
          ],
        }),
      };
    },
  };
  const input = {
    question: "compare",
    conditions: "bound panels",
    criteria: ["correspondence"],
    artifact: unit(),
    sources: [{ id: "figure", text: "a and b", locator: "p1" }],
    evaluatorVersion:
      "explanation-and-reading-images-v2-known-panels-visible-text" as const,
    imageSourceIds: ["figure"],
    imagePanelIds: ["figure:a"],
  };
  const signal = new AbortController().signal;
  for (const changed of [
    { ...input, imageSourceIds: [] },
    { ...input, imagePanelIds: ["other:a"] },
    { ...input, imagePanelIds: ["figure:a", "figure:a"] },
  ])
    await assert.rejects(
      reviewArtifact(provider, changed, signal, "panel-board"),
      /未派发/,
    );
  await assert.rejects(reviewArtifact(provider, input, signal), /未派发/);
  assert.equal(calls, 0);
  assert.equal(
    (await reviewArtifact(provider, input, signal, "panel-board")).valid,
    true,
  );
  assert.equal(calls, 1);
});

test("reading diagnostic revision keeps local figures without receiving deck-only instructions", async () => {
  const s = source(),
    first = unit(),
    revised = unit();
  first.sections[0].figures = [{ sourceId: s.id, panelId: s.id + ":a" }];
  revised.sections[0].figures = [{ sourceId: s.id, panelId: s.id + ":a" }];
  revised.sections[0].text =
    "The definition connects the marker to the measurement.";
  const breakpoint = {
    id: "BP1",
    sentence: first.sections[0].text,
    missingConcept: "marker meaning",
    question: "What does the marker measure?",
    status: "open",
  };
  const outputs = [
    { unit: first, deck: null },
    { understood: [], breakpoints: [breakpoint] },
    { issues: [], checkedSources: [s.id], limitations: [] },
    { unit: revised, deck: null },
    {
      understood: ["marker meaning"],
      breakpoints: [{ ...breakpoint, status: "resolved" }],
    },
    { issues: [], checkedSources: [s.id], limitations: [] },
  ];
  const instructions: string[] = [];
  const provider: Provider = {
    model: "fixture",
    async generate(rules, input: any, schema) {
      instructions.push(rules);
      if (input.draft || input.question === "Compare both panels")
        assert.doesNotMatch(
          rules,
          /PPT 的 unit 只写一段简短导读|保留片段范围：PPT unit/,
        );
      return { output: schema.parse(outputs.shift()) };
    },
  };
  const manager = new TaskManager(provider, async () => {});
  const ledger = new BudgetLedger("reading-revision", async () => {});
  const run = await manager.start(
    {
      paperId: "reading-revision",
      module: "paper",
      mode: "live",
      question: "Compare both panels",
      profileId: "beginner",
      sourceIds: [s.id],
      taughtConcepts: [],
      diagnosticScope: "fragment-v1",
    },
    {
      id: "reading-revision",
      version: "1",
      title: "Reading revision",
      scope: "Fixture",
      sources: [s],
    },
    undefined,
    undefined,
    { ledger },
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.calls, 6);
  assert.equal(instructions.length, 6);
  assert.ok(run.roles.some((r) => r.role === "revision"));
  assert.deepEqual(
    run.result?.sections[0].figures,
    revised.sections[0].figures,
  );
  assert.equal(run.result?.sections[0].text, revised.sections[0].text);
});
