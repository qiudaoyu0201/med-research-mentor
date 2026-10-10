import { z } from "zod";
import type { Source } from "../shared/types.ts";
import { materialPacket, digest } from "./materials.ts";

export const explanationLinkSchema = z.object({
  purpose: z.enum(["subject", "measurement", "intervention", "comparison"]),
  goal: z.string().min(1).max(160),
  sourceIds: z.array(z.string()).max(4),
  evidenceQuote: z.string().max(240),
  artifactLocation: z.string().min(1).max(120),
  explanation: z.string().min(1).max(500),
  gap: z.string().max(240).nullable(),
});
export const explanationLinksSchema = z
  .array(explanationLinkSchema)
  .min(1)
  .max(8);
export const compactExplanationLinksSchema = z
  .array(
    z.object({
      purpose: z.enum(["subject", "measurement", "intervention", "comparison"]),
      sourceIds: z.array(z.string()).max(4),
      sourceQuote: z.string().max(96),
      artifactLocation: z.string().min(1).max(120),
      artifactAnchor: z.string().min(4).max(64),
      gap: z.string().max(80).nullable(),
    }),
  )
  .min(1)
  .max(8);
export const compactExplanationLinksInstruction = `同一次生成返回内部 explanationLinks（最多8项）：purpose为subject/measurement/intervention/comparison；sourceIds最多4个实际可见来源；sourceQuote为最多96字的唯一逐字短引，通用背景可用空来源和空引文；artifactLocation指向真实交付字段；artifactAnchor为该字段中唯一出现的4至64字解释片语；gap为最多80字的真实缺口或null。先使用来源解释必要原理，将完整解释写入正文或讲稿，服务器据短引和片语还原全文。PPT位置仅deck.slides.N.notes或deck.speechScript；讲解仅unit.sections.N.text或unit.terms.N.explanation；方案仅sections.N.text或sections.N.rationale。来源已有的选择原理不能当作未知。内部记录不替代交付解释，核验进度留在gap，科学限制紧贴结论说明一次。`;
export function tracingSchema(mode: boolean | "compact-v1") {
  return mode === "compact-v1"
    ? compactExplanationLinksSchema
    : explanationLinksSchema;
}
export const explanationLinksInstruction = `同一次生成返回内部 explanationLinks（最多8项）。按当前任务逐项选择必要的研究对象、测量、干预选择和比较作用，特别检查结果主线背后的方法选择理由；先从实际 sources 的原句确定应解释的原理，再把理由写进真实交付内容。每项填写 purpose、当前目标 goal、真实 sourceIds、逐字 evidenceQuote、实际字段路径 artifactLocation、在该字段中逐字出现的解释 explanation，以及真实材料缺口 gap（无缺口为null）。原句短引只用于追踪；通用背景解释可 sourceIds=[]、evidenceQuote=""，保持科学准确。PPT 的解释位置必须在 deck.slides.N.notes 或 deck.speechScript；讲解在 unit.sections.N.text 或 unit.terms.N.explanation；方案在 sections.N.rationale 或 sections.N.text。不能用内部记录代替交付解释，不能以组分名称或细节缺失掩盖来源已经给出的选择原理。先准确解释，再写相关科学限制；将核验进度和材料需求留在内部 gap，避免反复写进讲稿。`;

export function validateExplanationLinks(
  artifact: unknown,
  sources: Source[],
  question: string,
  kind: "ppt" | "paper" | "plan",
  mode: boolean | "compact-v1" = true,
) {
  if (mode === "compact-v1")
    return validateCompactLinks(artifact, sources, question, kind);
  const links = explanationLinksSchema.parse(
    (artifact as { explanationLinks?: unknown }).explanationLinks,
  );
  const packet = materialPacket(sources, question);
  for (const link of links) {
    const allowed =
      kind === "ppt"
        ? /^(deck\.slides\.\d+\.notes|deck\.speechScript)$/
        : kind === "paper"
          ? /^unit\.(sections\.\d+\.text|terms\.\d+\.explanation)$/
          : /^sections\.\d+\.(text|rationale)$/;
    if (!allowed.test(link.artifactLocation))
      throw new Error("必要解释未绑定当前请求的交付位置。");
    const text = link.artifactLocation
      .split(".")
      .reduce<any>((value, key) => value?.[key], artifact);
    if (typeof text !== "string" || !text.includes(link.explanation))
      throw new Error("追踪解释没有进入实际交付内容。");
    if (
      link.sourceIds.length &&
      (link.evidenceQuote.length < 4 ||
        !link.sourceIds.some((id) => {
          const ref = packet.references.find((s) => s.id === id);
          return (
            ref &&
            packet.blocks
              .find((b) => b.hash === ref.blockHash)
              ?.text.includes(link.evidenceQuote)
          );
        }))
    )
      throw new Error("解释原句不在实际可见来源中。");
    if (
      link.sourceIds.some((id) => !packet.references.some((s) => s.id === id))
    )
      throw new Error("解释来源无效。");
    if (!link.sourceIds.length && link.evidenceQuote)
      throw new Error("背景解释不能填造来源原句。");
  }
  return links;
}

function validateCompactLinks(
  artifact: unknown,
  sources: Source[],
  question: string,
  kind: "ppt" | "paper" | "plan",
) {
  const links = compactExplanationLinksSchema.parse(
    (artifact as { explanationLinks?: unknown }).explanationLinks,
  );
  const packet = materialPacket(sources, question);
  const uniqueOffset = (text: string, anchor: string) => {
    const offset = text.indexOf(anchor);
    if (offset < 0 || text.indexOf(anchor, offset + 1) >= 0)
      throw new Error("追踪定位缺失或歧义。");
    return offset;
  };
  return links.map((link) => {
    const allowed =
      kind === "ppt"
        ? /^(deck\.slides\.\d+\.notes|deck\.speechScript)$/
        : kind === "paper"
          ? /^unit\.(sections\.\d+\.text|terms\.\d+\.explanation)$/
          : /^sections\.\d+\.(text|rationale)$/;
    if (!allowed.test(link.artifactLocation))
      throw new Error("必要解释未绑定当前请求的交付位置。");
    const text = link.artifactLocation
      .split(".")
      .reduce<any>((value, key) => value?.[key], artifact);
    if (typeof text !== "string")
      throw new Error("追踪解释没有进入实际交付内容。");
    const artifactOffset = uniqueOffset(text, link.artifactAnchor);
    const refs = link.sourceIds.map((id) => {
      const ref = packet.references.find((s) => s.id === id);
      if (!ref) throw new Error("解释来源无效。");
      return ref;
    });
    if (
      (!refs.length && link.sourceQuote) ||
      (refs.length && link.sourceQuote.length < 4)
    )
      throw new Error("解释原句无效。");
    const blocks = [...new Set(refs.map((ref) => ref.blockHash))].map((hash) =>
      packet.blocks.find((b) => b.hash === hash)!,
    );
    const matches = blocks.filter((block) =>
      block.text.includes(link.sourceQuote),
    );
    if (refs.length && matches.length !== 1)
      throw new Error("解释原句不在实际可见来源中或定位歧义。");
    const source = refs.length ? matches[0] : null;
    const sourceOffset = source
      ? uniqueOffset(source.text, link.sourceQuote)
      : null;
    return {
      ...link,
      sourceOffset,
      artifactOffset,
      sourceText: source?.text ?? null,
      sourceHash: source?.hash ?? null,
      artifactText: text,
      artifactHash: digest(text),
    };
  });
}
