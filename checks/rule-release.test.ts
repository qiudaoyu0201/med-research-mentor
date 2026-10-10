import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRuleRelease, changeRuleRelease, ruleHash, validateRuleAcceptance, validateReleaseEvidence, ruleAcceptanceCriteria, type RuleAcceptance } from "../server/rule-release.ts";
import { withRuleSnapshot, loadSkills, freezeRules, type RuleSnapshot } from "../server/skills.ts";
const snapshot = (text: string): RuleSnapshot => ({ shared: text, entries: { "medical-paper-guide": { text, version: "1", hash: ruleHash(text), description: "test" } } });
const baseline = snapshot("来源、测量与未知"), candidate = snapshot("改进来源、测量与未知");

test("release evidence cannot replace fixed criteria, omit the baseline or use simulated calls", () => {
  const arm = { artifact: { text: "有来源的真实句子" }, budget: { attempts: [{ status: "succeeded", model: "configured-model" }] },
    review: { checks: ruleAcceptanceCriteria.map(criterion => ({ criterion, passed: true, location: "有来源的真实句子", sourceIds: ["s"], explanation: "支持" })) } };
  const evidence = { caseId: "case-1", criteria: ruleAcceptanceCriteria, sources: [{ id: "s", text: "原始资料" }], baseline: arm, candidate: structuredClone(arm) };
  validateReleaseEvidence(evidence);
  assert.throws(() => validateReleaseEvidence({ ...evidence, criteria: ["看起来不错"] }));
  assert.throws(() => validateReleaseEvidence({ ...evidence, baseline: undefined }));
  evidence.candidate.budget.attempts[0].model = "fixture";
  assert.throws(() => validateReleaseEvidence(evidence));
  evidence.candidate.budget.attempts[0].model = "configured-model";
  evidence.candidate.review.checks[0].passed = false;
  assert.throws(() => validateReleaseEvidence(evidence));
});
const acceptance: RuleAcceptance = { version: "rule-acceptance-v1", mode: "live", baselineHash: ruleHash(baseline), candidateHash: ruleHash(candidate), engineHash: "engine", checks: (["reading", "ppt", "proposal", "transfer"] as const).flatMap(kind => (["development", "holdout"] as const).map(split => ({ id: `${kind}-${split}`, kind, split, scientific: true, teaching: true, complete: true, evidenceHash: ruleHash(kind + split) }))) };

test("rule adoption requires exact candidate, environment, all functions and no scientific regression", () => {
  validateRuleAcceptance(baseline, candidate, acceptance, "engine");
  assert.throws(() => validateRuleAcceptance(baseline, snapshot("changed"), acceptance, "engine"));
  assert.throws(() => validateRuleAcceptance(baseline, candidate, acceptance, "new-engine"));
  assert.throws(() => validateRuleAcceptance(baseline, candidate, { ...acceptance, checks: acceptance.checks.slice(1) }, "engine"));
  assert.throws(() => validateRuleAcceptance(baseline, candidate, { ...acceptance, checks: acceptance.checks.map((c,i) => ({ ...c, scientific: i !== 0 })) }, "engine"));
});

test("adoption loads exact immutable rules, rollback restores prior content and stale rollback is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutor-rules-"));
  try {
    const release = await changeRuleRelease({ action: "adopt", baseline, candidate, acceptance, engineHash: "engine" }, directory);
    const loaded = (await activeRuleRelease(directory))!;
    assert.deepEqual(await withRuleSnapshot(loaded.snapshot, () => freezeRules()), candidate);
    const reverted = await changeRuleRelease({ action: "rollback", expectedRelease: release.id }, directory);
    assert.equal(reverted.snapshotHash, ruleHash(baseline));
    await assert.rejects(changeRuleRelease({ action: "rollback", expectedRelease: release.id }, directory), /当前有效/);
    const path = join(directory, reverted.id + ".json");
    const corrupted = JSON.parse(await readFile(path, "utf8")); corrupted.snapshot.shared = "tampered";
    await writeFile(path, JSON.stringify(corrupted));
    await assert.rejects(activeRuleRelease(directory), /指纹不一致/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("module execution records exactly the frozen effective skill hashes", async () => {
  const real = await freezeRules();
  real.shared = "固定来源和基础解释";
  const loaded = await withRuleSnapshot(real, () => loadSkills("paper"));
  assert.equal(loaded.shared, real.shared);
  for (const entry of loaded.modules) assert.equal(loaded.versions[entry.id], entry.hash);
});
