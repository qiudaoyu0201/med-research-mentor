import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { RuleSnapshot } from "./skills.ts";
import { root } from "./storage.ts";
import { reviewSchema, validateReview } from "./internal-training.ts";

export const ruleAcceptanceCriteria = [
  "事实、实验设计、对照、结果与局限得到提供的原始资料支持，不混淆关联与因果",
  "医学新手能理解关键术语、方法目的及证据到结论的推理，信息有条理且不过度重复",
  "完成当前功能任务且保留关键条件，独立迁移不泄露答案或纠正提示",
];

/** Fixed criteria and both arms are required; caller supplied pass flags are not evidence. */
export function validateReleaseEvidence(evidence: any) {
  if (JSON.stringify(evidence.criteria) !== JSON.stringify(ruleAcceptanceCriteria) ||
    typeof evidence.caseId !== "string" || !evidence.caseId.trim() ||
    !Array.isArray(evidence.sources) || !evidence.sources.length ||
    evidence.sources.some((s: any) => !s.id || !s.text?.trim()) ||
    new Set(evidence.sources.map((s: any) => s.id)).size !== evidence.sources.length)
    throw new Error("采用证据必须包含固定科学/教学指标、案例及原始来源。");
  for (const arm of [evidence.baseline, evidence.candidate]) {
    if (!arm?.artifact || !arm.budget?.attempts?.length ||
      arm.budget.attempts.some((a: any) => a.status !== "succeeded" || !a.model || /fixture|mock/i.test(a.model)))
      throw new Error("采用证据缺少基线或候选的真实运行账本。");
    const review = reviewSchema.parse(arm.review);
    const evaluated = validateReview(ruleAcceptanceCriteria, arm.artifact, evidence.sources.map((s: any) => s.id), review);
    if (!evaluated.valid || !review.checks[0]?.sourceIds.length || (arm === evidence.candidate && !evaluated.passed))
      throw new Error("采用证据存在无效或失败的科学/教学评价。");
  }
}

export const ruleReleaseDirectory = join(root, "rule-releases");
export const ruleHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface RuleAcceptance {
  version: "rule-acceptance-v1";
  mode: "live";
  baselineHash: string;
  candidateHash: string;
  engineHash: string;
  checks: { id: string; kind: "reading" | "ppt" | "proposal" | "transfer"; split: "development" | "holdout"; scientific: boolean; teaching: boolean; complete: boolean; evidenceHash: string }[];
}
interface Release {
  version: "rule-release-v1";
  id: string;
  action: "adopt" | "rollback";
  at: string;
  snapshot: RuleSnapshot;
  snapshotHash: string;
  previous: RuleSnapshot;
  previousHash: string;
  acceptance?: RuleAcceptance;
}
function assertSnapshot(snapshot: RuleSnapshot) {
  if (!snapshot?.shared?.trim() || !snapshot.entries || !Object.keys(snapshot.entries).length ||
    Object.entries(snapshot.entries).some(([id, e]) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !e.text?.trim() || !e.hash || !e.version || !e.description))
    throw new Error("规则快照不完整。");
}
export async function activeRuleRelease(directory = ruleReleaseDirectory): Promise<Release | undefined> {
  let raw: string;
  try { raw = await readFile(join(directory, "active.json"), "utf8"); }
  catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  const pointer = JSON.parse(raw);
  if (!/^[a-f0-9-]{36}$/.test(pointer.id)) throw new Error("有效规则指针损坏，未静默回退。");
  const release: Release = JSON.parse(await readFile(join(directory, `${pointer.id}.json`), "utf8"));
  if (release.version !== "rule-release-v1" || release.id !== pointer.id || ruleHash(release) !== pointer.hash ||
    ruleHash(release.snapshot) !== release.snapshotHash || ruleHash(release.previous) !== release.previousHash)
    throw new Error("有效规则内容与采用指纹不一致，未静默回退。");
  assertSnapshot(release.snapshot);
  return release;
}
export function validateRuleAcceptance(base: RuleSnapshot, candidate: RuleSnapshot, acceptance: RuleAcceptance, engineHash: string) {
  assertSnapshot(base); assertSnapshot(candidate);
  if (acceptance.version !== "rule-acceptance-v1" || acceptance.mode !== "live" || acceptance.baselineHash !== ruleHash(base) ||
    acceptance.candidateHash !== ruleHash(candidate) || acceptance.engineHash !== engineHash || !acceptance.checks?.length ||
    new Set(acceptance.checks.map((c) => c.id)).size !== acceptance.checks.length ||
    acceptance.checks.some((c) => !c.complete || !c.scientific || !c.teaching || !/^[a-f0-9]{64}$/.test(c.evidenceHash)) ||
    new Set(acceptance.checks.map((c) => c.evidenceHash)).size !== acceptance.checks.length)
    throw new Error("规则尚无完整真实验收、发生退步或材料/环境已经变化，不能采用。");
  for (const kind of ["reading", "ppt", "proposal", "transfer"])
    for (const split of ["development", "holdout"])
      if (!acceptance.checks.some((c) => c.kind === kind && c.split === split))
        throw new Error("规则采用缺少三功能与迁移的开发/留出验收。");
  if (Object.keys(base.entries).some((id) => !candidate.entries[id])) throw new Error("候选缺少既有角色或模块规则。");
}
async function publish(directory: string, release: Release) {
  const file = await open(join(directory, `${release.id}.json`), "wx");
  try { await file.writeFile(JSON.stringify(release)); } finally { await file.close(); }
  const temp = join(directory, `${randomUUID()}.tmp`);
  const pointer = await open(temp, "wx");
  try { await pointer.writeFile(JSON.stringify({ id: release.id, hash: ruleHash(release) })); }
  finally { await pointer.close(); }
  await rename(temp, join(directory, "active.json"));
}
export async function changeRuleRelease(input: {
  action: "adopt"; baseline: RuleSnapshot; candidate: RuleSnapshot; acceptance: RuleAcceptance; engineHash: string;
} | { action: "rollback"; expectedRelease: string }, directory = ruleReleaseDirectory) {
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, "change.lock"), lock = await open(lockPath, "wx");
  try {
    const current = await activeRuleRelease(directory);
    let snapshot: RuleSnapshot, previous: RuleSnapshot;
    if (input.action === "adopt") {
      validateRuleAcceptance(input.baseline, input.candidate, input.acceptance, input.engineHash);
      if (current && current.snapshotHash !== ruleHash(input.baseline)) throw new Error("有效规则已改变，不能覆盖其他采用决定。");
      snapshot = input.candidate; previous = input.baseline;
    } else {
      if (!current || current.id !== input.expectedRelease) throw new Error("回退对象不是当前有效规则。");
      snapshot = current.previous; previous = current.snapshot;
    }
    const release: Release = { version: "rule-release-v1", id: randomUUID(), at: new Date().toISOString(), action: input.action,
      snapshot, snapshotHash: ruleHash(snapshot), previous, previousHash: ruleHash(previous),
      ...(input.action === "adopt" ? { acceptance: input.acceptance } : {}) };
    await publish(directory, release);
    return release;
  } finally { await lock.close(); await unlink(lockPath); }
}
