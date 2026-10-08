import type { DeckOutline } from "../shared/types.ts";
import type { LearningProduct } from "./learning-exposure.ts";
import { deckSchema } from "./schemas.ts";

export function trainingGuidance(deck: DeckOutline) {
  return deck.slides.map((slide, i) => `## ${i + 1}. ${slide.title}\n\n${slide.notes}`).join("\n\n") + "\n";
}

// Historical experiments keep their original file contract. New experiments
// validate the actual separate guidance, not a full speech nobody requested.
export function trainingDeliveryFiles(product: LearningProduct) {
  if (!product.exportPath || !/\.pptx$/i.test(product.exportPath))
    throw new Error("缺少实际 PPTX 文件路径。");
  if (!product.delivery) return [
    { path: product.exportPath },
    { path: product.exportPath.replace(/\.pptx$/i, "-speech.md") },
  ];
  if (product.delivery.version !== "separate-guidance-v1" || !product.delivery.guidancePath.trim())
    throw new Error("不支持的汇报交付合同。");
  const artifact = product.artifact as { deck?: unknown } | undefined;
  const deck = deckSchema.parse(artifact?.deck);
  if (!!deck.speechScript !== !!product.delivery.speechPath)
    throw new Error("完整稿与已交付文件记录不一致。");
  const files = [
    { path: product.exportPath },
    { path: product.delivery.guidancePath, text: trainingGuidance(deck) },
    ...(product.delivery.speechPath ? [{ path: product.delivery.speechPath, text: deck.speechScript! }] : []),
  ];
  if (new Set(files.map((f) => f.path)).size !== files.length)
    throw new Error("汇报交付文件路径重复。");
  return files;
}
