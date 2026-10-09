import type { LearningUnit, DeckOutline } from "../shared/types.ts";

export interface CrossEvidence {
  id: string;
  text: string;
  locator: string;
  image?: string;
  sourceId?: string;
}

// Select whole cited records, never substrings. This is a diagnostic packet,
// not a replacement for each product's original full-source grounding review.
export function selectCrossEvidence(
  products: { unit?: LearningUnit; deck?: DeckOutline }[],
  available: CrossEvidence[],
  proposalSources: CrossEvidence[],
): CrossEvidence[] {
  proposalSources = proposalSources.map((source) => {
    if (!source.sourceId) return source;
    const original = available.find((s) => s.id === source.sourceId);
    if (!original)
      throw new Error(`研究方案引用缺少原始来源：${source.sourceId}`);
    if (source.image && original.image && source.image !== original.image)
      throw new Error(`研究方案引用图像版本冲突：${source.id}`);
    return { ...source, ...(original.image ? { image: original.image } : {}) };
  });
  const required = new Set(proposalSources.map((s) => s.id));
  for (const product of products) {
    for (const section of product.unit?.sections ?? [])
      for (const id of section.citations) required.add(id);
    for (const slide of product.deck?.slides ?? []) {
      for (const id of slide.citations) required.add(id);
      if (slide.imageSource) required.add(slide.imageSource);
    }
  }
  const indexed = new Map<string, CrossEvidence>();
  for (const source of [...available, ...proposalSources]) {
    if (!required.has(source.id)) continue;
    const previous = indexed.get(source.id);
    if (
      previous &&
      (previous.text !== source.text ||
        previous.locator !== source.locator ||
        (previous.image && source.image && previous.image !== source.image))
    )
      throw new Error(`交叉复核来源版本冲突：${source.id}`);
    indexed.set(source.id, {
      ...source,
      ...(previous?.image ? { image: previous.image } : {}),
    });
  }
  for (const id of required)
    if (!indexed.has(id)) throw new Error(`交叉复核引用缺失：${id}`);
  if (!indexed.size) throw new Error("交叉复核没有可追溯的引用来源");
  return [...indexed.values()];
}
