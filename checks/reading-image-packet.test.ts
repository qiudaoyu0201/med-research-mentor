import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readingImagePacket } from "../server/reading-image-packet.ts";
import { diagnosticReadingImage } from "../server/model-diagnostic.ts";
import { digest } from "../server/materials.ts";
import { TaskManager } from "../server/orchestrator.ts";
import type { PaperBundle, Source } from "../shared/types.ts";
import type { Provider } from "../server/provider.ts";
const picture = (id: string, color: string): Source => {
  const c = createCanvas(120, 100),
    ctx = c.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 120, 100);
  return {
    id,
    kind: "paper",
    title: id,
    text: "Figure evidence",
    locator: id,
    figure: id,
    verified: true,
    image: c.toDataURL("image/png"),
  };
};

test("reading packet keeps single and explicit figures exact and binds only included sources", async () => {
  const red = picture("red", "red"),
    blue = picture("blue", "blue");
  assert.deepEqual(await readingImagePacket([]), {
    image: undefined,
    sourceIds: [],
  });
  assert.deepEqual(await readingImagePacket([red]), {
    image: red.image,
    sourceIds: ["red"],
  });
  assert.deepEqual(await readingImagePacket([red, blue], blue.image), {
    image: blue.image,
    sourceIds: ["blue"],
  });
  const external = picture("external", "green").image!;
  assert.deepEqual(await readingImagePacket([red, blue], external), {
    image: external,
    sourceIds: [],
  });
  const many = Array.from({ length: 10 }, (_, i) => ({
    ...red,
    id: "image-" + i,
  }));
  assert.deepEqual(
    (await readingImagePacket(many)).sourceIds,
    many.slice(0, 8).map((s) => s.id),
  );
});

test("reading multi-image evidence contains both complete sources and rejects changed bindings", async () => {
  const sources = [picture("red", "red"), picture("blue", "blue")];
  const packet = await readingImagePacket(sources);
  const decoded = await loadImage(packet.image!);
  assert.equal(decoded.width, 2400);
  assert.equal(decoded.height, 1200);
  const canvas = createCanvas(2400, 1200),
    ctx = canvas.getContext("2d");
  ctx.drawImage(decoded, 0, 0);
  const first = [...ctx.getImageData(600, 500, 1, 1).data],
    second = [...ctx.getImageData(1800, 500, 1, 1).data];
  assert.ok(first[0] > 240 && first[2] < 15);
  assert.ok(second[2] > 240 && second[0] < 15);
  const binding = {
    sourceIds: packet.sourceIds,
    imageHash: digest(packet.image!),
  };
  assert.deepEqual(diagnosticReadingImage(packet.image, sources, binding), {
    image: packet.image,
    imageSourceIds: ["red", "blue"],
  });
  for (const invalid of [
    { ...binding, imageHash: "changed" },
    { ...binding, sourceIds: ["red", "other"] },
    { ...binding, sourceIds: ["red", "red"] },
  ])
    assert.throws(
      () => diagnosticReadingImage(packet.image, sources, invalid),
      /绑定无效/,
    );
});

test("teaching, novice and grounding receive the same selected reading images and source binding", async () => {
  const paper: PaperBundle = {
    id: "multi-figure",
    version: "1",
    title: "Figure comparison",
    scope: "Two selected figures",
    sources: [
      picture("red", "red"),
      picture("blue", "blue"),
      picture("unselected", "green"),
    ],
  };
  const unit = {
    title: "Comparison",
    question: "Compare",
    sections: [
      {
        title: "Observations",
        text: "Compare the two observations.",
        kind: "paper",
        citations: ["red", "blue"],
      },
      {
        title: "Interpretation",
        text: "Use the same measurement.",
        kind: "interpretation",
        citations: ["red", "blue"],
      },
    ],
    terms: [],
    nextQuestion: "What changes?",
  };
  const outputs = [
    { unit, deck: null },
    { understood: ["comparison"], breakpoints: [] },
    { issues: [], checkedSources: ["red", "blue"], limitations: [] },
  ];
  const images: (string | undefined)[] = [];
  const provider: Provider = {
    model: "fixture",
    async generate(_rules, input: any, schema, _signal, image) {
      images.push(image);
      assert.deepEqual(input.visibleImageSourceIds, ["red", "blue"]);
      return { output: schema.parse(outputs.shift()) };
    },
  };
  const manager = new TaskManager(provider, async () => {});
  const run = await manager.start(
    {
      paperId: paper.id,
      module: "paper",
      mode: "live",
      question: "Compare the figures",
      profileId: "beginner",
      sourceIds: ["red", "blue"],
      taughtConcepts: [],
    },
    paper,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(images.length, 3);
  assert.ok(images.every((image) => image === run.input.visibleImage));
  assert.deepEqual(run.readingImageEvidence, {
    sourceIds: ["red", "blue"],
    imageHash: digest(run.input.visibleImage!),
  });
  assert.ok(run.materials![0].sources.every((s) => !s.image));
});
