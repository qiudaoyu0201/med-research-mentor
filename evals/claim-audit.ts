import { z } from "zod";
import { reviewSchema } from "../server/schemas.ts";

export type AuditPacket = {
  deck: {
    slides: {
      title: string;
      bullets: string[];
      notes: string;
      citations: string[];
    }[];
  };
  draft: { sections: { title: string; text: string; citations: string[] }[] };
  sources: {
    references: { id: string; blockHash?: string; text?: string }[];
    blocks?: { hash: string; text: string }[];
  };
  feedback: { breakpoints: { id: string }[] };
};

export function claimAuditContract(packet: AuditPacket, withWitnesses = false) {
  const referenceIndex = packet.sources.references.map((s, i) => ({
    key: i + 1,
    sourceId: s.id,
  }));
  const keys = (ids: string[]) =>
    ids.map((id) => {
      const ref = referenceIndex.find((r) => r.sourceId === id);
      if (!ref) throw new Error(`Unknown input citation: ${id}`);
      return ref.key;
    });
  const targets = [
    ...packet.deck.slides.flatMap((s, i) => [
      ...s.bullets.map((text, j) => ({
        id: `S${i + 1}.B${j + 1}`,
        text,
        citations: keys(s.citations),
      })),
      ...(s.notes
        ? [{ id: `S${i + 1}.N`, text: s.notes, citations: keys(s.citations) }]
        : []),
    ]),
    ...packet.draft.sections.map((s, i) => ({
      id: `D${i + 1}`,
      text: s.text,
      citations: keys(s.citations),
    })),
  ];
  if (!targets.length || !referenceIndex.length)
    throw new Error("Audit requires content and sources");
  const targetIds = targets.map((t) => t.id);
  const baseSchema = reviewSchema.extend({
    issues: z
      .array(
        reviewSchema.shape.issues.element.extend({
          targets: z.array(z.enum(targetIds)).min(1).max(8),
        }),
      )
      .max(20),
    claims: z
      .array(
        z.object({
          id: z.enum(targetIds),
          status: z.enum(["supported", "question", "gap", "insufficient"]),
          evidence: z
            .array(z.number().int().min(1).max(referenceIndex.length))
            .max(5),
          reason: z.string().min(1).max(160),
          issueIds: z.array(z.string()).max(5),
        }),
      )
      .length(targets.length),
    feedbackDecisions: z
      .array(
        z.object({
          id: z.string(),
          disposition: z.enum(["upheld", "dismissed", "insufficient"]),
          rationale: z.string().min(1).max(200),
          issueIds: z.array(z.string()).min(1).max(5),
        }),
      )
      .max(15),
  });
  const schema = withWitnesses
    ? baseSchema.extend({
        witnesses: z
          .array(
            z.object({
              target: z.enum(targetIds),
              source: z.number().int().min(1).max(referenceIndex.length),
              quote: z.string().min(20).max(260),
            }),
          )
          .max(targets.length * 3),
      })
    : baseSchema;
  const validate = (output: z.infer<typeof schema>) => {
    const errors: string[] = [];
    const unique = (ids: string[], label: string) => {
      if (new Set(ids).size !== ids.length) errors.push(`${label}: duplicate`);
    };
    unique(
      output.claims.map((c) => c.id),
      "claims",
    );
    unique(
      output.issues.map((i) => i.id),
      "issues",
    );
    unique(
      output.feedbackDecisions.map((d) => d.id),
      "feedback",
    );
    const issues = new Map(output.issues.map((i) => [i.id, i]));
    const sourceIds = new Set(referenceIndex.map((r) => r.sourceId));
    for (const id of [
      ...output.checkedSources,
      ...output.issues.flatMap((i) => i.evidence),
    ]) {
      if (!sourceIds.has(id)) errors.push(`unknown source: ${id}`);
    }
    for (const target of targets) {
      const claim = output.claims.find((c) => c.id === target.id);
      if (!claim) {
        errors.push(`missing claim: ${target.id}`);
        continue;
      }
      if (
        claim.status === "supported" &&
        (!claim.evidence.length ||
          claim.evidence.some((id) => !target.citations.includes(id)))
      )
        errors.push(`${target.id}: support not in local citations`);
      if (
        ["gap", "insufficient"].includes(claim.status) &&
        !claim.issueIds.some((id) => issues.get(id)?.resolved === false)
      )
        errors.push(`${target.id}: missing open issue`);
      if (
        claim.status === "supported" &&
        claim.issueIds.some((id) => issues.get(id)?.resolved === false)
      )
        errors.push(`${target.id}: supported with open issue`);
      for (const id of claim.issueIds)
        if (!issues.get(id)?.targets.includes(target.id))
          errors.push(`${target.id}: issue binding mismatch ${id}`);
    }
    for (const issue of output.issues) {
      for (const id of issue.targets)
        if (
          !output.claims.some(
            (c) => c.id === id && c.issueIds.includes(issue.id),
          )
        )
          errors.push(`${issue.id}: absent from claim ${id}`);
    }
    const feedbackIds = new Set(packet.feedback.breakpoints.map((b) => b.id));
    for (const id of feedbackIds)
      if (!output.feedbackDecisions.some((d) => d.id === id))
        errors.push(`missing feedback: ${id}`);
    for (const decision of output.feedbackDecisions) {
      if (!feedbackIds.has(decision.id))
        errors.push(`unknown feedback: ${decision.id}`);
      if (decision.issueIds.some((id) => !issues.has(id)))
        errors.push(`${decision.id}: unknown issue`);
      if (
        decision.disposition === "dismissed" &&
        decision.issueIds.some((id) => !issues.get(id)?.resolved)
      )
        errors.push(`${decision.id}: dismissal not resolved`);
      if (
        decision.disposition !== "dismissed" &&
        !decision.issueIds.some((id) => issues.get(id)?.resolved === false)
      )
        errors.push(`${decision.id}: missing open issue`);
    }
    if (withWitnesses) {
      const witnesses = z
        .array(
          z.object({
            target: z.string(),
            source: z.number(),
            quote: z.string(),
          }),
        )
        .parse("witnesses" in output ? output.witnesses : []);
      const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
      for (const witness of witnesses) {
        const ref = packet.sources.references[witness.source - 1];
        const block = packet.sources.blocks?.find(
          (b) => b.hash === ref?.blockHash,
        );
        const sourceText = block?.text ?? ref?.text;
        if (
          !sourceText ||
          !normalize(sourceText).includes(normalize(witness.quote))
        )
          errors.push(
            `${witness.target}: quote not in source ${witness.source}`,
          );
        const claim = output.claims.find((c) => c.id === witness.target);
        if (!claim?.evidence.includes(witness.source))
          errors.push(`${witness.target}: witness absent from evidence`);
      }
      for (const claim of output.claims.filter(
        (c) => c.status === "supported",
      )) {
        for (const key of claim.evidence)
          if (!witnesses.some((w) => w.target === claim.id && w.source === key))
            errors.push(`${claim.id}: missing source quote ${key}`);
      }
    }
    return errors;
  };
  return { schema, validate, manifest: { referenceIndex, targets } };
}

export const claimAuditInstructions = `
按auditManifest.targets逐项核对：S表示幻灯片，B表示要点，N表示讲述提示，D表示讲解正文。每项只返回一条claims，不抄写原句；issues.targets直接使用已有ID。claims.evidence使用referenceIndex中的数字key；issues.evidence仍用原sourceId。每条reason用一句短话说明支持依据或具体缺口，不写长审稿。
supported必须有当前目标citations里的直接支持证据，不能以别页或资料包里有证据代替本页实际引用；只支持一部分主张不能标整项supported。引用包含参考文献列表不代表其中被引研究的结果已在本页出现。核对方法的测量对象与推理边界，必须检查承载这条具体边界的来源，不能因为另一条边界正确就放行整个要点。
question用于研究提问/假设且前提无事实错误；不是结论已证实。反馈裁决区分两件事：把研究问题指控为错误结论应驳回；需要解释读数或比较基准的真实学习疑问可以保留为教学补充，但应指向解释缺口，不能要求删改合法研究问题。发现其他位置的错误断言必须独立定位。不能机械关闭全部疑问，也不能把补讲需求都升级成blocking。
gap或insufficient关联未解决issue，修订建议只覆盖必要更正。重大事实错误、关键方法/对照错误仍blocking；来源本身支持且只是页内漏引可warning，内部仍要求修补。feedbackDecisions对每个断点给裁决、理由和issueIds，不成立用resolved=true记录。证据不足不是论文一定不存在该实验。
`;

export const sourceWitnessInstructions = `
每个supported判断必须在witnesses给出对应证据的原文短引句：target、source数字key、quote为该source对应block中连续20–260字符（允许空白归一化，不能自己翻译/改写/省略号拼接）。claims.evidence只列实际支撑本条内容的来源，每个listed source都要有相应witness；通常只需最相关的一到两个证据。不能把本页所有引用整组复制进每条evidence。
先找到所引用原文中支持该具体主张的句子，再判supported；找不到就记录引用缺口或证据不足。全局资料中确有该句、但该目标没有引用该来源时，仍是gap，可在issue建议补引。解释性边界也必须对应实际证据，不能看到观点熟悉就以无关原文作证。不要为填满witnesses编造引文。
`;

export const sharedCitationInstructions = `
同一页citations是页内共享来源池，不是声称每个来源都证明每个要点。单条主张已经由池中恰当来源支持时，其他引用用于该页其他内容不构成该条事实缺陷；在局部摘录测试中也不能把“摘录后暂时用不到的引用”判成未解决问题。仅建议删除多余引用属于编辑偏好，不进入issues。只有主张缺必要支持、引用本身虚构或有误导性的具体归属才报告。supported与未解决问题不能并存。
`;

// View of the same frozen evidence, not new material. Avoid a three-hop join.
export function inlineAuditSources<T extends AuditPacket>(packet: T): T {
  const copy = structuredClone(packet);
  copy.sources.references = copy.sources.references.map((ref, i) => {
    const text = packet.sources.blocks?.find(
      (b) => b.hash === ref.blockHash,
    )?.text;
    if (text === undefined) throw new Error(`Missing frozen block: ${ref.id}`);
    return { ...ref, key: i + 1, text };
  });
  copy.sources.blocks = [];
  return copy;
}
