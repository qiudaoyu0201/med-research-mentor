// Experimental audit contract. Never used as an online delivery gate.
import { z } from "zod";
import { reviewSchema } from "../server/schemas.ts";

export const coverageReviewSchema = reviewSchema.extend({
  pages: z
    .array(
      z.object({
        page: z.number().int().min(1),
        checkedCitations: z.array(z.string()),
        verdict: z.enum(["supported", "gap", "insufficient"]),
        rationale: z.string().min(1),
        issueIds: z.array(z.string()),
      }),
    )
    .max(16),
  bindings: z
    .array(
      z.object({
        issueId: z.string(),
        target: z.enum(["slide", "section"]),
        index: z.number().int().min(1),
        quote: z.string().min(1),
        speechAct: z.enum(["question", "hypothesis", "report", "assertion"]),
      }),
    )
    .max(40),
  feedbackDecisions: z
    .array(
      z.object({
        id: z.string(),
        disposition: z.enum(["upheld", "dismissed", "insufficient"]),
        rationale: z.string().min(1),
        issueIds: z.array(z.string()).min(1),
      }),
    )
    .max(15),
});

type Input = {
  deck: {
    slides: {
      title: string;
      bullets: string[];
      notes: string;
      citations: string[];
    }[];
  };
  draft: { sections: { title: string; text: string }[] };
  sources: { references: { id: string }[] };
  feedback: { breakpoints: { id: string }[] };
};

// Checks traceability, not scientific correctness. A model can still make a wrong judgment.
export function checkReviewCoverage(
  input: Input,
  output: z.infer<typeof coverageReviewSchema>,
): string[] {
  const errors: string[] = [];
  const unique = (values: (string | number)[], label: string) => {
    if (new Set(values).size !== values.length)
      errors.push(`${label}: duplicate`);
  };
  unique(
    output.pages.map((p) => p.page),
    "pages",
  );
  unique(
    output.issues.map((i) => i.id),
    "issues",
  );
  unique(
    output.feedbackDecisions.map((d) => d.id),
    "feedback",
  );
  const sources = new Set(input.sources.references.map((s) => s.id));
  const issues = new Map(output.issues.map((i) => [i.id, i]));
  const feedback = new Set(input.feedback.breakpoints.map((b) => b.id));
  const checkIds = (ids: string[], label: string) => {
    unique(ids, label);
    for (const id of ids)
      if (!issues.has(id)) errors.push(`${label}: unknown issue ${id}`);
  };
  for (const id of [
    ...output.checkedSources,
    ...output.issues.flatMap((i) => i.evidence),
  ]) {
    if (!sources.has(id)) errors.push(`unknown source: ${id}`);
  }
  for (let i = 0; i < input.deck.slides.length; i++) {
    if (!output.pages.some((p) => p.page === i + 1))
      errors.push(`missing page: ${i + 1}`);
  }
  for (const page of output.pages) {
    const slide = input.deck.slides[page.page - 1];
    if (!slide) {
      errors.push(`unknown page: ${page.page}`);
      continue;
    }
    unique(page.checkedCitations, `page ${page.page} citations`);
    if (
      slide.citations.some((id) => !page.checkedCitations.includes(id)) ||
      page.checkedCitations.some(
        (id) => !slide.citations.includes(id) || !sources.has(id),
      )
    ) {
      errors.push(`page ${page.page}: citation inventory mismatch`);
    }
    checkIds(page.issueIds, `page ${page.page}`);
    if (
      page.verdict !== "supported" &&
      !page.issueIds.some((id) => issues.get(id)?.resolved === false)
    ) {
      errors.push(`page ${page.page}: gap without open issue`);
    }
    for (const id of page.issueIds) {
      if (
        !output.bindings.some(
          (b) =>
            b.issueId === id && b.target === "slide" && b.index === page.page,
        )
      ) {
        errors.push(`page ${page.page}: unbound issue ${id}`);
      }
    }
  }
  for (const binding of output.bindings) {
    if (!issues.has(binding.issueId))
      errors.push(`binding: unknown issue ${binding.issueId}`);
    const item =
      binding.target === "slide"
        ? input.deck.slides[binding.index - 1]
        : input.draft.sections[binding.index - 1];
    const texts = !item
      ? []
      : "bullets" in item
        ? [item.title, ...item.bullets, item.notes]
        : [item.title, item.text];
    if (!texts.some((t) => t.includes(binding.quote)))
      errors.push(`binding ${binding.issueId}: quote not in target`);
    if (
      binding.target === "slide" &&
      !output.pages.some(
        (p) => p.page === binding.index && p.issueIds.includes(binding.issueId),
      )
    ) {
      errors.push(`binding ${binding.issueId}: absent from page`);
    }
  }
  for (const issue of output.issues) {
    if (!output.bindings.some((b) => b.issueId === issue.id))
      errors.push(`issue ${issue.id}: missing binding`);
  }
  for (const id of feedback)
    if (!output.feedbackDecisions.some((d) => d.id === id))
      errors.push(`missing feedback: ${id}`);
  for (const decision of output.feedbackDecisions) {
    if (!feedback.has(decision.id))
      errors.push(`unknown feedback: ${decision.id}`);
    checkIds(decision.issueIds, `feedback ${decision.id}`);
    if (
      decision.disposition === "dismissed" &&
      decision.issueIds.some((id) => issues.get(id)?.resolved !== true)
    )
      errors.push(`feedback ${decision.id}: dismissal not resolved`);
    if (
      decision.disposition !== "dismissed" &&
      !decision.issueIds.some((id) => issues.get(id)?.resolved === false)
    )
      errors.push(`feedback ${decision.id}: missing open issue`);
  }
  return errors;
}

export const structuredCoverage = `
输出结构化审核轨迹：pages按deck每页一行（page从1开始），checkedCitations逐一列出该页原有citations，不能用其他页来源冒充本页已有引用。逐一核查bullets与notes的关键主张能否由本页引用支撑，rationale简述支持或缺口；gap/insufficient必须关联未解决issue。资料包里有证据而本页没引用，仍属本页引用缺口；资料包不完整也不得说原论文没有证据。
bindings为每个issue记录实际稿件中的原句quote（必须是目标原文连续子串）、target=slide或section、从1开始的index及言语用途speechAct；slide问题必须在对应pages.issueIds出现。正文section也要继续核验。不把不同位置的研究提问与结论断言合为一个问题。已驳回的疑虑同样绑定其所针对的实际原句。
feedbackDecisions逐条裁决新手断点：upheld/dismissed/insufficient，保留反馈id、理由及关联issueIds。dismissed只关联resolved=true的问题；其他裁决关联未解决问题。结构记录是可追溯依据，不是凑满行数即可通过；不得为了填表编造缺陷或引用。重大事实错误仍阻断。
`;
