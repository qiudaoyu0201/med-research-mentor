import { digest } from "./materials.ts";
import type {
  LearningUnit,
  DeckOutline,
  Source,
  ReviewResult,
} from "../shared/types.ts";

export type TeachingArtifact = { unit: LearningUnit; deck: DeckOutline | null };
export function explanationTrace(
  artifact: TeachingArtifact,
  sources: Source[],
  question: string,
) {
  const visibleIds = new Set(sources.map((s) => s.id));
  const locations = [
    ...artifact.unit.sections.map((s, i) => ({
      location: `unit.sections.${i}`,
      title: s.title,
      text: s.text,
      sourceIds: s.citations,
    })),
    ...(artifact.deck?.slides.map((s, i) => ({
      location: `deck.slides.${i}`,
      title: s.title,
      text: [...s.bullets, s.notes].join("\n"),
      sourceIds: [...s.citations, ...(s.imageSource ? [s.imageSource] : [])],
    })) ?? []),
  ];
  if (locations.some((l) => l.sourceIds.some((id) => !visibleIds.has(id))))
    throw new Error("解释追踪包含实际不可见来源。");
  return {
    question,
    artifactHash: digest(artifact),
    sourceHash: digest(sources),
    locations,
    sources: sources.map((s) => ({
      id: s.id,
      page: s.page ?? null,
      locator: s.locator,
      textHash: digest(s.text),
    })),
  };
}
function leaves(value: unknown, path = ""): Map<string, string> {
  if (typeof value === "string") return new Map([[path, value]]);
  return new Map(
    Object.entries(value ?? {}).flatMap(([key, item]) => [
      ...leaves(item, path ? `${path}.${key}` : key),
    ]),
  );
}
export function revisionTrace(
  before: TeachingArtifact,
  after: TeachingArtifact,
  sources: Source[],
  beforeReview: ReviewResult,
  question: string,
) {
  const old = leaves({ unit: before.unit, deck: before.deck }),
    next = leaves({ unit: after.unit, deck: after.deck });
  const changes = [...new Set([...old.keys(), ...next.keys()])]
    .filter((p) => old.get(p) !== next.get(p))
    .map((location) => ({
      location,
      before: old.get(location) ?? null,
      after: next.get(location) ?? null,
      sensitive:
        /\d|[%％=\/÷]|参照|分母|对照|单位|高于|低于|增加|降低|baseline|control/i.test(
          `${old.get(location) ?? ""}\n${next.get(location) ?? ""}`,
        ),
    }));
  return {
    beforeHash: digest(before),
    afterHash: digest(after),
    before: structuredClone(before),
    after: structuredClone(after),
    beforeReview: structuredClone(beforeReview),
    changes,
    evidence: explanationTrace(after, sources, question),
  };
}
export const revisionAuditInstruction = `核对首稿和修订稿的改动位置 changes：除检查原问题是否解决，还逐项对照实际来源检查新增／改写的对象、比较组、参照或分母、单位、方向、页面和公式。首稿本身可能有错，纠错必须有来源依据；图注有歧义时结合实际坐标、图例和原图，不能凭词义填造计算流程。必要原理、对照作用和推理缺口分别检查。`;
export function revisionAuditInput(trace: ReturnType<typeof revisionTrace>) {
  return {
    beforeHash: trace.beforeHash,
    afterHash: trace.afterHash,
    changes: trace.changes.map(({ location, before, sensitive }) => ({
      location,
      before,
      sensitive,
    })),
  };
}
