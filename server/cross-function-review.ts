import { pptImagePacket } from "./ppt-image-packet.ts";
import type { Provider } from "./provider.ts";
import { digest } from "./materials.ts";
import {
  reviewArtifact,
  validateReview,
  reviewSchema,
} from "./internal-training.ts";

export type ProductKind = "reading" | "ppt" | "proposal";
export interface CrossFunctionInput {
  artifacts: Partial<Record<ProductKind, unknown>>;
  sources: { id: string; text: string; locator: string; image?: string }[];
}
export const crossFunctionCriteria = [
  "论文事实分别得到原始来源支持，不以产物彼此一致代替证据",
  "研究背景、设计、对照、结果和局限在不同产物间没有遗漏关键条件或相互矛盾",
  "原研究结果、机制假设、新方案预期结果明确区分",
  "研究方案的测量与对照能回答其问题，未知条件没有被编造成已知",
  "汇报简化仍保留关键证据与限制，讲述提示不代替页面内容",
];
export interface CrossFunctionReview {
  version: "cross-function-v1";
  fingerprint: string;
  evaluation: Awaited<ReturnType<typeof reviewArtifact>>;
}
function validateInput(input: CrossFunctionInput) {
  const kinds = Object.keys(input.artifacts);
  if (
    kinds.length < 2 ||
    kinds.some((k) => !["reading", "ppt", "proposal"].includes(k)) ||
    Object.values(input.artifacts).some((v) => !v) ||
    !input.sources.length ||
    new Set(input.sources.map((s) => s.id)).size !== input.sources.length
  )
    throw new Error("交叉复核需要至少两类真实产物及无冲突的原始来源。");
}
export function crossFunctionFingerprint(input: CrossFunctionInput) {
  validateInput(input);
  return digest({
    version: "cross-function-v1",
    criteria: crossFunctionCriteria,
    input,
  });
}
export async function reviewCrossFunction(
  provider: Provider,
  input: CrossFunctionInput,
  signal: AbortSignal,
) {
  const fingerprint = crossFunctionFingerprint(input);
  if (input.sources.filter((s) => s.image).length > 8)
    throw new Error(
      "交叉复核图件超过单次范围，先拆分完整验证计划，不静默丢图。",
    );
  if (
    input.sources.some(
      (s) => s.image && !/^data:image\/(?:png|jpeg|webp);base64,/.test(s.image),
    )
  )
    throw new Error("交叉复核图件必须冻结为实际字节。");
  const image = await pptImagePacket(
    input.sources.map((s) => ({
      ...s,
      title: s.id,
      kind: "paper",
      verified: true,
    })),
  );

  const evaluation = await reviewArtifact(
    provider,
    {
      question:
        "对照原始论文，交叉复核当前版本的医学带读、科研汇报和研究方案。",
      conditions:
        "仅评价实际提供的产物。没有提供的功能维度注明不适用，不补造产物。返回每项真实产物中的原句定位；设计建议与论文事实分开判断。不宣称真人学习效果。",
      criteria: crossFunctionCriteria,
      artifact: input.artifacts,
      sources: input.sources.map(({ image, ...source }) => source),
    },
    signal,
    image,
  );
  if (
    !evaluation.review.checks.find(
      (c) => c.criterion === crossFunctionCriteria[0],
    )?.sourceIds.length
  ) {
    evaluation.valid = false;
    evaluation.passed = false;
    evaluation.findings.push("原始事实核对没有提供来源。");
  }
  return { version: "cross-function-v1" as const, fingerprint, evaluation };
}
export function currentCrossFunctionReview(
  input: CrossFunctionInput,
  review?: CrossFunctionReview,
) {
  if (
    !review ||
    review.version !== "cross-function-v1" ||
    review.fingerprint !== crossFunctionFingerprint(input)
  )
    return false;
  const parsed = reviewSchema.safeParse(review.evaluation?.review);
  if (
    !parsed.success ||
    !parsed.data.checks.find((c) => c.criterion === crossFunctionCriteria[0])
      ?.sourceIds.length
  )
    return false;
  const checked = validateReview(
    crossFunctionCriteria,
    input.artifacts,
    input.sources.map((s) => s.id),
    parsed.data,
  );
  return (
    review.evaluation.valid &&
    review.evaluation.passed &&
    checked.valid &&
    checked.passed
  );
}

export function pendingProductValidation(
  input: CrossFunctionInput,
  reviews: CrossFunctionReview[],
) {
  const kinds: ProductKind[] = ["reading", "ppt", "proposal"];
  const pending = kinds
    .filter((kind) => !input.artifacts[kind])
    .map((kind) => `${kind}:product`);
  for (const pair of [
    ["reading", "ppt"],
    ["reading", "proposal"],
    ["ppt", "proposal"],
  ] as const) {
    if (pair.some((kind) => !input.artifacts[kind])) {
      pending.push(`${pair.join("+")}:review`);
      continue;
    }
    const subset = {
      ...input,
      artifacts: Object.fromEntries(
        pair.map((kind) => [kind, input.artifacts[kind]]),
      ),
    };
    // A three-product check also covers each pair, but must match all current versions.
    if (
      !reviews.some(
        (r) =>
          currentCrossFunctionReview(subset, r) ||
          currentCrossFunctionReview(input, r),
      )
    )
      pending.push(`${pair.join("+")}:review`);
  }
  return pending;
}
