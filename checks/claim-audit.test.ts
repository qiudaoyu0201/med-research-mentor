import test from "node:test";
import assert from "node:assert/strict";
import {
  claimAuditContract,
  inlineAuditSources,
  type AuditPacket,
} from "../evals/claim-audit.ts";

const quote = "The experiment measured a marker in cultured mouse cells.";
const packet: AuditPacket = {
  deck: {
    slides: [
      {
        title: "结果",
        bullets: ["测量细胞标志物"],
        notes: "不能据此宣称治愈人体",
        citations: ["p1"],
      },
    ],
  },
  draft: { sections: [] },
  sources: {
    references: [
      { id: "p1", blockHash: "h1" },
      { id: "p2", blockHash: "h2" },
    ],
    blocks: [
      { hash: "h1", text: quote },
      {
        hash: "h2",
        text: "A different study described a clinical trial in humans.",
      },
    ],
  },
  feedback: { breakpoints: [] },
};
function fixture() {
  const audit = claimAuditContract(packet, true);
  const output = {
    issues: [],
    checkedSources: ["p1"],
    limitations: [],
    feedbackDecisions: [],
    claims: audit.manifest.targets.map((t) => ({
      id: t.id,
      status: "supported",
      evidence: [1],
      reason: "细胞观察的证据边界",
      issueIds: [],
    })),
    witnesses: audit.manifest.targets.map((t) => ({
      target: t.id,
      source: 1,
      quote,
    })),
  };
  return { audit, output };
}
test("逐主张合同校验引文存在性且不冒称验证科学正确性", () => {
  const { audit, output } = fixture();
  assert.deepEqual(audit.validate(audit.schema.parse(output)), []);
});
test("禁止挪用别页证据和把别处的真实引句挂到本页", () => {
  const { audit, output } = fixture();
  output.claims[0].evidence = [2];
  output.witnesses[0].source = 2;
  const errors = audit.validate(audit.schema.parse(output));
  assert.ok(errors.includes("S1.B1: support not in local citations"));
  assert.ok(errors.includes("S1.B1: quote not in source 2"));
});
test("每项通过结论必须保留所列证据的原文", () => {
  const { audit, output } = fixture();
  output.witnesses.pop();
  assert.ok(
    audit
      .validate(audit.schema.parse(output))
      .includes("S1.N: missing source quote 1"),
  );
});
test("固定目标不允许漏掉讲述提示、重复填同一要点或编造定位", () => {
  const { audit, output } = fixture();
  output.claims[1].id = "S1.B1";
  const errors = audit.validate(audit.schema.parse(output));
  assert.ok(errors.includes("claims: duplicate"));
  assert.ok(errors.includes("missing claim: S1.N"));
  output.claims[0].id = "S77.B9";
  assert.equal(audit.schema.safeParse(output).success, false);
});
test("空白归一化允许真实PDF换行，不允许改写原文", () => {
  const { audit, output } = fixture();
  output.witnesses[0].quote = quote.replace("measured a", "measured\n a");
  assert.deepEqual(audit.validate(audit.schema.parse(output)), []);
  output.witnesses[0].quote = quote.replace("mouse cells", "human patients");
  assert.ok(
    audit
      .validate(audit.schema.parse(output))
      .includes("S1.B1: quote not in source 1"),
  );
});

test("内联来源视图保留真实引文和引用身份，不改原始资料包", () => {
  const before = structuredClone(packet);
  const inline = inlineAuditSources(packet);
  assert.deepEqual(packet, before);
  assert.equal(inline.sources.references[0].text, quote);
  assert.equal(inline.sources.references[0].id, "p1");
  assert.deepEqual(inline.sources.blocks, []);
  const audit = claimAuditContract(inline, true);
  assert.deepEqual(audit.validate(audit.schema.parse(fixture().output)), []);
});
