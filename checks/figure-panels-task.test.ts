import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { TaskManager } from "../server/orchestrator.ts";
import type { Provider } from "../server/provider.ts";
import type { PaperBundle } from "../shared/types.ts";
import { sample } from "../examples/bundle.ts";

test("PPT generation and revision preserve page crops and separately ground complete originals", async () => {
  const canvas = createCanvas(100, 60),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 50, 60);
  ctx.fillStyle = "blue";
  ctx.fillRect(50, 0, 50, 60);
  const a = { left: 0, top: 0, width: 0.5, height: 1 },
    b = { left: 0.5, top: 0, width: 0.5, height: 1 };
  const paper: PaperBundle = {
    ...sample,
    id: "panel-task-fixture",
    sources: [
      {
        id: "figure",
        title: "Figure 1",
        kind: "paper",
        figure: "1",
        locator: "page 1",
        verified: true,
        text: "a: design; b: results.",
        image: canvas.toDataURL("image/png"),
        imagePanels: [
          { label: "a", region: a },
          { label: "b", region: b },
        ],
      },
    ],
  };
  const unit = {
    title: "比较",
    question: "解释图片",
    terms: [],
    nextQuestion: "",
    sections: [
      {
        title: "结果",
        text: "对照与处理进行比较。",
        kind: "paper",
        citations: ["figure"],
      },
    ],
  };
  const teaching = (panel: string) => ({
    unit,
    deck: {
      slides: [
        {
          title: "比较",
          bullets: ["对照与处理"],
          notes: "解释当前面板的比较。",
          citations: ["figure"],
          imageSource: "figure",
          imagePanel: "figure:" + panel,
        },
      ],
    },
  });
  const novice = { understood: ["比较"], breakpoints: [] },
    review = { issues: [], checkedSources: ["figure"], limitations: [] };
  const firstReview = {
    ...review,
    issues: [
      {
        id: "switch",
        location: "结果",
        type: "teaching",
        evidence: ["figure"],
        suggestion: "改为讲解已提供的结果面板。",
        severity: "warning",
        resolved: false,
      },
    ],
  };
  const outputs = [
    teaching("a"),
    novice,
    firstReview,
    teaching("b"),
    novice,
    review,
  ];
  let calls = 0;
  const provider: Provider = {
    model: "fixture-test-only",
    async generate(rules, value, schema, signal, image) {
      signal.throwIfAborted();
      const index = calls++;
      const decoded = await loadImage(image!);
      const selecting = [0, 3].includes(index);
      const grounding = [2, 5].includes(index);
      assert.equal(decoded.height, selecting ? 1240 : grounding ? 620 : 60);
      assert.equal(decoded.width, selecting || grounding ? 1800 : 50);
      if (selecting) {
        const board = createCanvas(1800, 1240),
          pixels = board.getContext("2d");
        pixels.drawImage(decoded, 0, 0);
        const pixel = (x: number, y: number) =>
          pixels.getImageData(x, y, 1, 1).data;
        for (const [x, y] of [
          [200, 300],
          [1100, 300],
        ]) {
          const p = pixel(x, y); // Original red half and actual candidate a.
          assert.ok(p[0] > 240 && p[2] < 15);
        }
        for (const [x, y] of [
          [700, 300],
          [200, 900],
        ]) {
          const p = pixel(x, y); // Original blue half and actual candidate b.
          assert.ok(p[2] > 240 && p[0] < 15);
        }
      } else if (grounding) {
        const check = createCanvas(1800, 620),
          pixels = check.getContext("2d");
        pixels.drawImage(decoded, 0, 0);
        const selected = pixels.getImageData(200, 300, 1, 1).data;
        assert.ok(
          index < 3
            ? selected[0] > 240 && selected[2] < 15
            : selected[2] > 240 && selected[0] < 15,
        );
        const originalRed = pixels.getImageData(1100, 300, 1, 1).data;
        const originalBlue = pixels.getImageData(1700, 300, 1, 1).data;
        assert.ok(originalRed[0] > 240 && originalRed[2] < 15);
        assert.ok(originalBlue[2] > 240 && originalBlue[0] < 15);
        assert.match(rules, /来源原图（非页面展示）/);
        assert.equal(
          (value as any).pptImageEvidence,
          "ppt-grounding-images-v1-cited-originals",
        );
      } else {
        const check = createCanvas(50, 60),
          pixels = check.getContext("2d");
        pixels.drawImage(decoded, 0, 0);
        assert.deepEqual(
          [...pixels.getImageData(25, 30, 1, 1).data],
          index < 3 ? [255, 0, 0, 255] : [0, 0, 255, 255],
        );
      }
      if ([0, 3].includes(index)) {
        const references = (value as any).sources.references;
        assert.equal(references[0].image, undefined);
        assert.equal(references[0].imagePanels.length, 2);
      }
      return { output: schema.parse(outputs[index]) };
    },
  };
  const manager = new TaskManager(provider, async () => {});
  const run = await manager.start(
    {
      paperId: paper.id,
      module: "ppt",
      mode: "live",
      question: "按内容选图",
      profileId: "beginner",
      sourceIds: ["figure"],
      taughtConcepts: [],
      slideCount: 1,
    },
    paper,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(calls, 6);
  assert.deepEqual((run.roles[0].output as any).deck.slides[0].imageCrop, a);
  assert.deepEqual(run.deck!.slides[0].imageCrop, b);
  assert.equal("imagePanel" in run.deck!.slides[0], false);
  assert.equal(run.materials![0].sources[0].image, undefined);
});
