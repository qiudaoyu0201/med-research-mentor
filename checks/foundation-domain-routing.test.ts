import test from "node:test";
import assert from "node:assert/strict";
import { foundationCatalog } from "../server/foundations.ts";

test("clinical thresholds and CT imaging do not retrieve PCR foundations", () => {
  for (const question of [
    "为什么概率经过校准仍不能说明可以按某个概率阈值转诊？",
    "肺 CT 模型诊断肺癌的敏感度和阈值是什么？",
    "CT值与肺结节的密度有什么关系？",
    "ct扫描能检测什么？",
  ])
    assert.ok(
      !foundationCatalog.match(question).some((s) => /pcr/.test(s.id)),
      question,
    );
});
test("PCR cycle thresholds retain their definitions and prerequisite retrieval", () => {
  for (const question of [
    "Ct是什么意思？",
    "qPCR的CT值",
    "阈值循环与模板量的关系",
    "循环阈值怎样读",
    "PCR中ct值如何比较",
  ]) {
    const ids = foundationCatalog.match(question).map((s) => s.id);
    assert.ok(ids.includes("qpcr-basics"), question);
    assert.ok(ids.includes("pcr-mechanism"), question);
  }
});
