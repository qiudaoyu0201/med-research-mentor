import {
  prepareClosureExperiment,
  stepClosureExperiment,
} from "../server/closure-experiment.ts";
import { LearnerStore } from "../server/learner.ts";
import {
  cloneOpenLearner,
  openLearnerView,
} from "../server/internal-learner.ts";
import { digest } from "../server/materials.ts";
import { learningCriteria } from "../server/learning-protocol.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { createCanvas } from "@napi-rs/canvas";
import { exportDeck } from "../server/export.ts";
import { planDocx } from "../server/plan-docx.ts";
import {
  trainingGuidance,
  verifyTrainingDeliveryFiles,
} from "../server/training-delivery.ts";
import {
  assertClosureProducts,
  type ClosureProductRecord,
} from "../server/closure-product-gate.ts";
import {
  reviewCrossFunction,
  currentCrossFunctionReview,
  pendingProductValidation,
  type CrossFunctionInput,
} from "../server/cross-function-review.ts";
import type {
  ClosureManifest,
  FrozenFile,
} from "../server/closure-experiment.ts";
import type {
  PaperBundle,
  DeckOutline,
  LearningUnit,
} from "../shared/types.ts";
import type { ResearchPlanVersion } from "../shared/research-plan.ts";
import type { Provider } from "../server/provider.ts";

const provider: Provider = {
  model: "fixture",
  async generate(_rules, input, schema) {
    const x = input as any;
    return {
      output: schema.parse(
        x.criteria
          ? {
              checks: x.criteria.map((criterion: string) => ({
                criterion,
                passed: true,
                sourceIds: ["s"],
                location: "科研证据",
                explanation: "合成夹具",
              })),
            }
          : { text: "科研证据", questions: [], usedVisibleIds: ["s"] },
      ),
    };
  },
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tutor-delivery-gate-"));
  const freeze = async (path: string): Promise<FrozenFile> => ({
    path,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  });
  const json = async (name: string, value: unknown) => {
    const path = join(directory, name);
    await writeFile(path, JSON.stringify(value));
    return freeze(path);
  };
  const image = createCanvas(64, 40),
    context = image.getContext("2d");
  context.fillStyle = "red";
  context.fillRect(0, 0, 32, 40);
  context.fillStyle = "blue";
  context.fillRect(32, 0, 32, 40);
  const paper: PaperBundle = {
    id: "fixture",
    version: "1",
    title: "科研证据",
    scope: "工程夹具",
    sources: [
      {
        id: "s",
        title: "科研证据",
        text: "观察仅支持关联。",
        locator: "p1",
        kind: "paper",
        verified: true,
        page: 1,
        image: image.toDataURL("image/png"),
      },
    ],
  };
  const unit: LearningUnit = {
    title: "科研证据",
    question: "如何分析",
    sections: [
      {
        title: "设计",
        text: "观察仅支持关联。",
        citations: ["s"],
        kind: "paper",
      },
    ],
    terms: [],
    nextQuestion: "如何设计对照",
  };
  const deck: DeckOutline = {
    slides: [
      {
        title: "科研证据",
        bullets: ["观察支持关联"],
        notes: "单独讲述推理，不放入幻灯片。",
        citations: ["s"],
        imageSource: "s",
        imageCrop: { left: 0, top: 0, width: 0.5, height: 1 },
      },
    ],
  };
  const version: ResearchPlanVersion = {
    id: "v1",
    parentId: null,
    origin: "assistant",
    createdAt: "2026-10-09",
    topic: {
      id: "t",
      version: "t1",
      question: "研究关联",
      conditions: "条件待确认",
      studyTypes: ["clinical-observational"],
      typeStatus: "confirmed",
      learningPreferences: { verbosity: "standard", focus: "balanced" },
      createdAt: "2026-10-09",
      sources: [
        {
          id: "s",
          title: "科研证据",
          locator: "p1",
          excerpt: "观察仅支持关联。",
          hash: "fixture",
          verified: true,
          kind: "paper",
        },
      ],
    },
    content: {
      title: "科研证据",
      sections: [
        {
          id: "design",
          title: "设计",
          text: "前瞻性观察",
          rationale: "建立时间顺序",
          kind: "proposal",
          sourceRefs: ["s"],
          unknowns: ["样本量待估算"],
          author: "assistant",
        },
      ],
      assumptions: [],
      questions: [],
      limitations: ["观察性研究"],
    },
    review: {
      id: "review",
      jobId: "job",
      versionId: "v1",
      status: "checked",
      purposes: ["artifact-quality"],
      issues: [],
      checkedSourceRefs: ["s"],
      limitations: ["工程夹具"],
      createdAt: "2026-10-09",
    },
  };
  const pptx = join(directory, "report.pptx"),
    guidance = join(directory, "guidance.md"),
    docx = join(directory, "proposal.docx");
  const exported = await exportDeck(
    deck,
    paper,
    `delivery-gate-${randomUUID()}`,
  );
  await copyFile(exported, pptx);
  await rm(exported);
  await writeFile(guidance, trainingGuidance(deck));
  await writeFile(docx, planDocx(version));
  const sources = paper.sources.map(({ id, text, locator }) => ({
    id,
    text,
    locator,
  }));
  const artifacts = {
    reading: { unit, deck: null },
    ppt: { unit, deck },
    proposal: { content: version.content },
  };
  const cross: CrossFunctionInput = {
    artifacts,
    sources: sources.map((s) => ({
      ...s,
      image: paper.sources.find((p) => p.id === s.id)?.image,
    })),
  };
  const review = await reviewCrossFunction(
    provider,
    cross,
    new AbortController().signal,
  );
  const manifest: ClosureManifest = {
    version: "closure-experiment-v1",
    id: "fixture",
    history: await json("history.json", {
      status: "completed",
      priorAttempts: 10,
      batches: [
        {
          status: "complete",
          budget: { attempts: [{ id: "a", status: "succeeded" }] },
        },
      ],
    }),
    crossValidation: await json("cross.json", { input: cross, review }),
    phases: [],
  };
  const records: Partial<Record<string, ClosureProductRecord>> = {};
  const paperFile = await json("paper.json", paper);
  for (const kind of ["reading", "ppt", "proposal"] as const) {
    const record: ClosureProductRecord = {
      product: {
        id: kind,
        side: "candidate",
        status: "generated",
        evaluation: { valid: true, passed: true },
        sources,
        artifact: artifacts[kind],
        ...(kind === "ppt"
          ? {
              exportPath: pptx,
              delivery: {
                version: "separate-guidance-v1",
                guidancePath: guidance,
              },
            }
          : kind === "proposal"
            ? { exportPath: docx }
            : {}),
      },
      ...(kind === "ppt"
        ? { paper }
        : kind === "proposal"
          ? { proposalVersion: version }
          : {}),
    };
    records[kind] = record;
    const learnerState = await new LearnerStore(async () => {}).create({
      id: "novice",
      version: "1",
      background: "科研新手",
      concepts: [],
    });
    const teachingText = JSON.stringify(artifacts[kind]);
    const learner = cloneOpenLearner(
      learnerState,
      kind,
      "materials-and-teaching",
      [],
      [
        {
          id: `${kind}-teaching`,
          kind: "teaching",
          text: teachingText,
          versionHash: digest(teachingText),
        },
      ],
    );
    const task = {
      id: `${kind}-initial`,
      kind: {
        reading: "evidence-retelling",
        ppt: "report-outline",
        proposal: "design-draft",
      }[kind],
      question: "原研究问题",
      sources,
    };
    const initial = {
      task,
      rawAnswer: { text: "科研证据", questions: [], usedVisibleIds: ["s"] },
      inputHash: "fixture",
      mode: "independent",
      unsupportedVisibleIds: [],
    };
    initial.inputHash = digest({
      input: openLearnerView(learner, task as any),
      imageHash: null,
    });
    learner.observations.push(initial as any);
    const input = {
      learner,
      initial,
      evaluation: {
        valid: true,
        passed: true,
        findings: [],
        review: {
          checks: learningCriteria.map((criterion) => ({
            criterion,
            passed: true,
            location: "科研证据",
            sourceIds: ["s"],
            explanation: "夹具",
          })),
        },
      },
      transfer: {
        ...task,
        id: `${kind}-transfer`,
        question: "另一个研究如何选择对照",
      },
      priorStudies: [{ study: "A", question: task.question }],
      targetStudy: "B",
      rules: "医学导师",
      environmentHash: "fixture",
    };
    manifest.phases.push({
      id: kind,
      kind,
      product: await json(`${kind}-product.json`, record),
      input: await json(`${kind}-input.json`, input),
      files: [
        paperFile,
        ...(await Promise.all(
          (kind === "ppt"
            ? [pptx, guidance]
            : kind === "proposal"
              ? [docx]
              : []
          ).map(freeze),
        )),
      ],
    });
  }
  return {
    directory,
    json,
    freeze,
    manifest,
    records,
    cross,
    review,
    pptx,
    guidance,
    docx,
    paper,
  };
}

test("cross-function checks invalidate revisions, changed evidence and fabricated review coverage", async () => {
  const input: CrossFunctionInput = {
    artifacts: {
      reading: { title: "科研证据" },
      ppt: { title: "科研证据" },
      proposal: { title: "科研证据" },
    },
    sources: [{ id: "s", text: "来源", locator: "p1" }],
  };
  const review = await reviewCrossFunction(
    provider,
    input,
    new AbortController().signal,
  );
  assert.deepEqual(pendingProductValidation(input, [review]), []);
  const changed = structuredClone(input);
  changed.artifacts.proposal = { title: "科研证据", text: "修订" };
  assert.ok(
    pendingProductValidation(changed, [review]).includes(
      "reading+proposal:review",
    ),
  );
  assert.equal(currentCrossFunctionReview(changed, review), false);
  review.evaluation.review.checks = [];
  assert.equal(currentCrossFunctionReview(input, review), false);
  assert.ok(
    pendingProductValidation(
      { ...input, artifacts: { reading: input.artifacts.reading } },
      [],
    ).includes("ppt:product"),
  );
});

test("real PPT, separate guidance and proposal DOCX pass byte/content acceptance before learning", async () => {
  const h = await fixture();
  try {
    await assertClosureProducts(h.manifest);
    let state = await prepareClosureExperiment(h.manifest, provider);
    for (let i = 0; i < 6; i++) {
      let saved = structuredClone(state);
      await stepClosureExperiment(
        h.manifest,
        state,
        provider,
        async (value) => {
          saved = structuredClone(value);
        },
        new AbortController().signal,
        async () => {},
      );
      state = saved;
    }
    assert.equal(state.status, "complete");
    assert.equal(state.combinedAttempts, 17);
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test("acceptance rejects a changed deck image or embedded speech even with the same page count", async () => {
  const h = await fixture();
  try {
    const original = await readFile(h.pptx),
      parts = unzipSync(original);
    const media = Object.keys(parts).find((p) =>
      /^ppt\/media\/.*\.png$/.test(p),
    )!;
    const fake = createCanvas(32, 40);
    fake.getContext("2d").fillRect(0, 0, 32, 40);
    parts[media] = Uint8Array.from(fake.toBuffer("image/png"));
    await writeFile(h.pptx, zipSync(parts));
    await assert.rejects(
      verifyTrainingDeliveryFiles(h.records.ppt!.product, h.paper),
      /实际图片/,
    );
    const notes = unzipSync(original);
    notes["ppt/notesSlides/notesSlide1.xml"] =
      strToU8("<a:t>偷偷嵌入的讲稿</a:t>");
    await writeFile(h.pptx, zipSync(notes));
    await assert.rejects(
      verifyTrainingDeliveryFiles(h.records.ppt!.product, h.paper),
      /内嵌讲述/,
    );
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test("acceptance rejects stale proposal export, mismatched teaching exposure and missing actual files", async () => {
  const h = await fixture();
  try {
    const original = await readFile(h.docx),
      parts = unzipSync(original);
    parts["word/document.xml"] = strToU8(
      strFromU8(parts["word/document.xml"]).replace(
        "前瞻性观察",
        "随机对照干预",
      ),
    );
    await writeFile(h.docx, zipSync(parts));
    await assert.rejects(assertClosureProducts(h.manifest), /实际研究方案文档/);
    await writeFile(h.docx, original);
    const originalInput = h.manifest.phases[0].input;
    const changedInput = JSON.parse(await readFile(originalInput.path, "utf8"));
    changedInput.initial.inputHash = "not-the-observed-input";
    changedInput.learner.observations[0] = structuredClone(
      changedInput.initial,
    );
    h.manifest.phases[0].input = await h.json(
      "changed-observation.json",
      changedInput,
    );
    await assert.rejects(
      assertClosureProducts(h.manifest),
      /初始作答的实际输入/,
    );
    h.manifest.phases[0].input = originalInput;
    h.manifest.phases[0].input = await h.json("bad-input.json", {
      learner: {
        branch: "materials-and-teaching",
        exposures: [{ kind: "teaching", text: "另一版教学" }],
      },
    });
    await assert.rejects(assertClosureProducts(h.manifest), /实际教学曝光/);
    await assert.rejects(
      assertClosureProducts({ ...h.manifest, crossValidation: undefined }),
      /尚缺真实/,
    );
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});
