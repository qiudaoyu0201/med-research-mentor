import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { activeRuleRelease, changeRuleRelease, ruleHash, validateReleaseEvidence, type RuleAcceptance } from "../server/rule-release.ts";
import { freezeRules, type RuleSnapshot } from "../server/skills.ts";
import { trainingEngine } from "../server/training-engine.ts";
import { digest } from "../server/materials.ts";
import { trainingAdmission } from "../server/training-admission.ts";

export async function main() {
  const [command = "status", file] = process.argv.slice(2);
  if (command === "status") {
    const active = await activeRuleRelease();
    console.log(JSON.stringify({ release: active?.id ?? null, effectiveHash: ruleHash(await freezeRules()), origin: active ? active.action : "workspace" }));
    return;
  }
  if (!file || !["adopt", "rollback"].includes(command)) throw new Error("rule:release status | adopt <验收包.json> | rollback <当前采用编号>");
  // A change during a live user task would mix instructions. Require the local service stopped.
  if ((await trainingAdmission()).online !== "offline") throw new Error("规则切换需先停止本地服务，避免正在执行的请求混用规则。");
  if (command === "rollback") {
    const release = await changeRuleRelease({ action: "rollback", expectedRelease: file });
    console.log(JSON.stringify({ release: release.id, effectiveHash: release.snapshotHash }));
    return;
  }
  const pkg: { candidate: RuleSnapshot; acceptance: RuleAcceptance; evidence: { path: string; sha256: string }[] } = JSON.parse(await readFile(resolve(file), "utf8"));
  const baseline = await freezeRules(), engineHash = digest(await trainingEngine());
  const caseSplits = new Map<string, string>();
  for (const check of pkg.acceptance.checks) {
    const entry = pkg.evidence.find((e) => e.sha256 === check.evidenceHash);
    if (!entry) throw new Error("缺少实际验收证据文件。");
    const bytes = await readFile(resolve(dirname(resolve(file)), entry.path));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("验收证据文件改变。");
    const evidence = JSON.parse(bytes.toString());
    if (evidence.candidateHash !== ruleHash(pkg.candidate) || evidence.baselineHash !== ruleHash(baseline) ||
      evidence.engineHash !== engineHash || evidence.kind !== check.kind || evidence.split !== check.split ||
      evidence.mode !== "live")
      throw new Error("采用证据不是当前候选的完整真实运行。");
    validateReleaseEvidence(evidence);
    const prior = caseSplits.get(evidence.caseId);
    if (prior && prior !== check.split) throw new Error("同一案例不能同时充当开发集与留出集。");
    caseSplits.set(evidence.caseId, check.split);
  }
  const release = await changeRuleRelease({ action: "adopt", baseline, candidate: pkg.candidate, acceptance: pkg.acceptance, engineHash });
  console.log(JSON.stringify({ release: release.id, effectiveHash: release.snapshotHash }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
