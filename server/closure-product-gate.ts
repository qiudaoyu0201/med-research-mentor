import { assertCleanLearningArtifact } from "./learning-exposure.ts";
import { learningImage } from "./learning-exposure.ts";
import { openLearnerView } from "./internal-learner.ts";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import type { ClosureManifest, FrozenFile } from "./closure-experiment.ts";
import type { ClosureInput } from "./learning-closure.ts";
import type { LearningProduct } from "./learning-exposure.ts";
import type { PaperBundle } from "../shared/types.ts";
import {
  planVersionReady,
  type ResearchPlanVersion,
} from "../shared/research-plan.ts";
import { unitSchema, deckSchema } from "./schemas.ts";
import { planContentSchema } from "./research-plan-schemas.ts";
import { planDocx } from "./plan-docx.ts";
import {
  trainingDeliveryFiles,
  verifyTrainingDeliveryFiles,
} from "./training-delivery.ts";
import { digest } from "./materials.ts";
import {
  currentCrossFunctionReview,
  type CrossFunctionInput,
  type CrossFunctionReview,
} from "./cross-function-review.ts";

export interface ClosureProductRecord {
  product: LearningProduct;
  paper?: PaperBundle;
  proposalVersion?: ResearchPlanVersion;
}
async function frozen(file: FrozenFile) {
  const bytes = await readFile(file.path);
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new Error(`产物验收文件已变化：${file.path}`);
  return bytes;
}
const sourceView = (sources: NonNullable<LearningProduct["sources"]>) =>
  sources.map(({ id, text, locator }) => ({ id, text, locator }));

/** Production dispatch requires actual product bytes and a review of precisely
 * these versions. Hashes alone or a manually set accepted boolean are insufficient. */
export async function assertClosureProducts(manifest: ClosureManifest) {
  if (!manifest.crossValidation || manifest.phases.some((p) => !p.product))
    throw new Error("学习闭环尚缺真实三功能产物与交叉验收记录，未派发。");
  const receipt: { input: CrossFunctionInput; review: CrossFunctionReview } =
    JSON.parse((await frozen(manifest.crossValidation)).toString());
  if (
    !["reading", "ppt", "proposal"].every(
      (kind) => kind in receipt.input.artifacts,
    ) ||
    !currentCrossFunctionReview(receipt.input, receipt.review)
  )
    throw new Error("三功能交叉验收缺失、未通过或对应旧产物。");
  const teachingTexts = Object.values(receipt.input.artifacts).map((artifact) =>
    JSON.stringify(artifact),
  );
  for (const phase of manifest.phases) {
    const record: ClosureProductRecord = JSON.parse(
      (await frozen(phase.product!)).toString(),
    );
    const product = record.product,
      artifact = product.artifact as any;
    if (
      product.status !== "generated" ||
      !product.evaluation?.valid ||
      !product.evaluation.passed ||
      digest(artifact) !== digest(receipt.input.artifacts[phase.kind]) ||
      !product.sources?.length
    )
      throw new Error("学习曝光产物与当前交叉验收不一致。");
    for (const source of sourceView(product.sources))
      if (
        !receipt.input.sources.some(
          (s) =>
            digest({ id: s.id, text: s.text, locator: s.locator }) ===
            digest(source),
        )
      )
        throw new Error("产物可见来源与交叉复核来源不一致。");
    assertCleanLearningArtifact(artifact);
    const required: string[] = [];
    if (phase.kind === "reading" || phase.kind === "ppt") {
      if (Object.keys(artifact).some((key) => !["unit", "deck"].includes(key)))
        throw new Error("教学曝光包含产物以外的工作记录。");
      const unit = unitSchema.parse(artifact.unit);
      if (
        unit.sections.some((s) =>
          s.citations.some(
            (id) => !product.sources!.some((ref) => ref.id === id),
          ),
        )
      )
        throw new Error("带读引用了未验收来源。");
      if (phase.kind === "ppt") {
        const deck = deckSchema.parse(artifact.deck);
        if (
          !record.paper ||
          deck.slides.some((slide) =>
            slide.citations.some(
              (id) => !product.sources!.some((s) => s.id === id),
            ),
          )
        )
          throw new Error("汇报缺少实际原文及原图绑定。");
        for (const slide of deck.slides) {
          const original = record.paper.sources.find(
            (s) => s.id === slide.imageSource,
          );
          if (
            original?.image &&
            receipt.input.sources.find((s) => s.id === original.id)?.image !==
              original.image
          )
            throw new Error("交叉复核没有看到实际导出使用的原图。");
        }
        await verifyTrainingDeliveryFiles(product, record.paper);
        required.push(...trainingDeliveryFiles(product).map((f) => f.path));
      }
    } else {
      if (
        !record.proposalVersion ||
        !planVersionReady(record.proposalVersion) ||
        Object.keys(artifact).some((key) => key !== "content")
      )
        throw new Error("研究方案缺少已核对的实际版本。");
      const { sections, ...content } = record.proposalVersion.content;
      planContentSchema.parse({
        ...content,
        sections: sections.map(({ author, ...section }) => section),
      });
      if (
        digest(artifact.content) !== digest(record.proposalVersion.content) ||
        !product.exportPath?.endsWith(".docx")
      )
        throw new Error("方案内容或实际导出路径不一致。");
      const actual = unzipSync(await readFile(product.exportPath)),
        expected = unzipSync(planDocx(record.proposalVersion));
      for (const part of ["word/document.xml", "word/_rels/document.xml.rels"])
        if (
          strFromU8(actual[part] ?? new Uint8Array()) !==
          strFromU8(expected[part] ?? new Uint8Array())
        )
          throw new Error("实际研究方案文档与冻结版本不一致。");
      required.push(product.exportPath);
    }
    for (const path of required) {
      const file = phase.files.find((f) => resolve(f.path) === resolve(path));
      if (!file) throw new Error("实际交付文件没有纳入冻结实验清单。");
      await frozen(file);
    }
    const input: ClosureInput = JSON.parse(
      (await frozen(phase.input)).toString(),
    );
    const teaching = input.learner.exposures.filter(
      (e) => e.kind === "teaching",
    );
    if (
      teaching.some((e) => !teachingTexts.includes(e.text)) ||
      (input.learner.branch === "materials-and-teaching" && !teaching.length)
    )
      throw new Error("学生实际教学曝光没有绑定已验收产物。");
    const initialIndex = input.learner.observations.findIndex(
      (o) => digest(o) === digest(input.initial),
    );
    if (initialIndex < 0) throw new Error("缺少实际初始作答记录。");
    const before = structuredClone(input.learner);
    before.observations = before.observations.slice(0, initialIndex);
    const image = await learningImage(before, input.initialImage);
    const expectedInputHash = digest({
      input: openLearnerView(before, input.initial.task),
      imageHash: image ? digest(image) : null,
    });
    if (input.initial.inputHash !== expectedInputHash)
      throw new Error(
        "初始作答的实际输入与教学曝光或图件不一致，不能事后补换材料。",
      );
  }
}
