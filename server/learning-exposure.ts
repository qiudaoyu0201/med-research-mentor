import { digest } from "./materials.ts";
import {
  exposureVersion,
  type Exposure,
  type OpenTask,
  type OpenLearnerRecord,
} from "./internal-learner.ts";
import { createCanvas, loadImage } from "@napi-rs/canvas";
export interface LearningProduct {
  id: string;
  side: string;
  status: string;
  artifact?: unknown;
  sources?: { id: string; text: string; locator: string }[];
  evaluation?: { valid: boolean; passed: boolean };
  exportPath?: string;
  delivery?: {
    version: "separate-guidance-v1";
    guidancePath: string;
    speechPath?: string;
  };
  run?: { input?: { visibleImage?: string } };
}
export function assertLearningGate(
  products: LearningProduct[],
  fileAccepted: boolean,
) {
  if (
    !["D1", "D2", "D3", "H1", "H2", "H3"].every((id) =>
      products.some(
        (p) =>
          p.id === id &&
          p.side === "candidate" &&
          p.status === "generated" &&
          p.evaluation?.valid &&
          p.evaluation.passed,
      ),
    ) ||
    !fileAccepted
  )
    throw new Error("候选开发、留出或实际文件验收未完成，学习试验未发起。");
}
export function assertCleanLearningArtifact(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "run",
        "roles",
        "feedback",
        "review",
        "evaluation",
        "budget",
        "previousIssues",
        "materialRequests",
      ].includes(key)
    )
      throw new Error("教学曝光包含任务或评价工作记录。");
    assertCleanLearningArtifact(child);
  }
}
export function lessonExposure(
  products: LearningProduct[],
  caseId: string,
  side: string,
) {
  const pair = ["baseline", "candidate"].map((s) =>
    products.find((p) => p.id === caseId && p.side === s),
  );
  if (pair.some((p) => !p?.sources?.length))
    throw new Error("教学案例缺实际可见材料记录。");
  if (digest(pair[0]!.sources) !== digest(pair[1]!.sources))
    throw new Error("两侧实际教学材料不同，不能称为仅教学规则的学习比较。");
  const priorImage = pair[0]!.run?.input?.visibleImage;
  if (
    digest(priorImage ?? null) !==
    digest(pair[1]!.run?.input?.visibleImage ?? null)
  )
    throw new Error("两侧实际教学图件不同，不能合并材料控制。");
  const product = products.find((p) => p.id === caseId && p.side === side);
  assertCleanLearningArtifact(product?.artifact);
  const text = JSON.stringify(pair[0]!.sources);
  const materialPayload = {
    text,
    sourceIds: pair[0]!.sources!.map((s) => s.id),
    ...(priorImage ? { image: priorImage } : {}),
  };
  const material: Exposure = {
    id: `${caseId}-material`,
    kind: "material",
    ...materialPayload,
    versionHash: exposureVersion(materialPayload),
  };
  const teachingText = JSON.stringify(product?.artifact ?? null);
  const teaching =
    product?.status === "generated" &&
    product.evaluation?.valid &&
    product.evaluation.passed
      ? {
          id: `${caseId}-${side}-teaching`,
          kind: "teaching" as const,
          text: teachingText,
          versionHash: digest(teachingText),
        }
      : null;
  return { material, teaching };
}
// Preserve the actual lesson image and target image at their existing resolution.
export async function learningImage(
  record: OpenLearnerRecord,
  target?: string,
) {
  const inputs = [
    ...record.exposures
      .filter((e) => e.image)
      .map((e) => ({ id: e.id, image: e.image! })),
    ...(target ? [{ id: "目标资料", image: target }] : []),
  ];
  if (!inputs.length) return undefined;
  if (inputs.length === 1) return inputs[0].image;
  const decoded = await Promise.all(
    inputs.map(async (input) => ({
      ...input,
      decoded: await loadImage(input.image),
    })),
  );
  const width = Math.max(...decoded.map((d) => d.decoded.width));
  const canvas = createCanvas(
    width,
    decoded.reduce((sum, d) => sum + d.decoded.height + 36, 0),
  );
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  let top = 0;
  for (const item of decoded) {
    context.fillStyle = "black";
    context.font = "22px sans-serif";
    context.fillText(item.id, 12, top + 25);
    context.drawImage(item.decoded, 0, top + 36);
    top += item.decoded.height + 36;
  }
  return canvas.toDataURL("image/png");
}
export function assertIndependentTarget(
  task: OpenTask,
  prior: { question: string; study: string }[],
  targetStudy: string,
) {
  if (
    prior.some(
      (p) =>
        p.study === targetStudy || p.question.trim() === task.question.trim(),
    )
  )
    throw new Error("目标研究或问题与此前教学重叠，不能作为独立目标。");
  const unexpected = Object.keys(task).filter(
    (key) => !["id", "kind", "question", "sources"].includes(key),
  );
  if (unexpected.length)
    throw new Error("目标输入包含答案、评分或额外提示字段。");
}
