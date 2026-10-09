// One bounded integration run after the local citation pair; never promotes rules.
import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Provider } from "../server/provider.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
import {
  inlineAuditSources,
  sharedCitationInstructions,
} from "../evals/claim-audit.ts";
import {
  noviceCoordination,
  groundingCoordination,
  groundingCoverage,
  presentationEvidence,
  feedbackAttribution,
} from "../evals/role-coordination-candidate.ts";
import { strictDevelopmentAcceptance } from "../server/development-acceptance.ts";

const recovery = process.argv[2] === "storage-recovery";
const coordination = process.argv[2] === "coordination-v3";
const revision = process.argv[2] === "revision-v2" || recovery || coordination;
if (process.argv[2] && !revision)
  throw new Error(
    "仅支持默认整合回归、revision-v2、storage-recovery或coordination-v3",
  );
const batchId =
  "role-closure-20261009" +
  (coordination
    ? "-coordination-v3"
    : recovery
      ? "-storage-recovery"
      : revision
        ? "-revision-v2"
        : "");
const directory = resolve("runs/internal-training/" + batchId);
process.env.TUTOR_DATA_DIR = join(directory, "data");
process.env.TUTOR_READING_GUIDES = "manual";
const { RecordStorage } = await import("../server/storage.ts");
const { createProvider } = await import("../server/model-config.ts");
const { TrainingProvider, reserveUnit } =
  await import("../server/internal-training.ts");
const { BudgetLedger } = await import("../server/budget.ts");
const { TaskManager } = await import("../server/orchestrator.ts");
const { freezeRules, withRuleSnapshot } = await import("../server/skills.ts");
const { trainingAdmission } = await import("../server/training-admission.ts");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const parentRaw = await readFile(
  "runs/internal-training/role-calibration-20261009-review-v9/records/training/report.json",
  "utf8",
);
const parent = JSON.parse(parentRaw);
let lineage = parent;
let lineageHash = digest(parentRaw);
if (coordination) {
  const raw = await readFile(
    "runs/internal-training/feedback-attribution-20261009-recovery-v2/records/training/report.json",
    "utf8",
  );
  lineage = JSON.parse(raw);
  lineageHash = digest(raw);
  const learner = lineage.results.find(
    (r: any) => r.id === "learner-only",
  )?.output;
  const wrong = lineage.results.find((r: any) => r.id === "draft-too")?.output;
  if (
    lineage.status !== "awaiting-evaluation" ||
    lineage.calls !== 2 ||
    lineage.batch.budget.attempts.length !== 2 ||
    lineage.batch.budget.attempts.some((a: any) => a.status !== "succeeded") ||
    !learner ||
    !wrong ||
    learner.issues.some((i: any) => !i.resolved && i.severity === "blocking") ||
    !learner.issues.some((i: any) =>
      i.location.includes("feedback.understood"),
    ) ||
    !wrong.issues.some(
      (i: any) =>
        i.type === "fact" &&
        i.severity === "blocking" &&
        !i.resolved &&
        i.location.includes("notes"),
    )
  )
    throw new Error("角色归属局部配对未通过，不扩展闭环");
} else if (revision) {
  const raw = await readFile(
    "runs/internal-training/role-closure-20261009" +
      (recovery ? "-revision-v2" : "") +
      "/records/training/report.json",
    "utf8",
  );
  lineage = JSON.parse(raw);
  lineageHash = digest(raw);
  if (
    lineage.status !== (recovery ? "needs-improvement" : "diagnostic-passed") ||
    lineage.calls !== (recovery ? 2 : 6) ||
    (recovery &&
      (lineage.runStatus !== "failed" ||
        !String(lineage.error).includes(
          "EPERM: operation not permitted, rename",
        ))) ||
    lineage.batch.budget.attempts.some((a: any) => a.status !== "succeeded")
  )
    throw new Error("前次整合回归未完整结束");
}
const missing = parent.results.find((r: any) => r.id === "citation-missing");
const repaired = parent.results.find((r: any) => r.id === "citation-repaired");
if (
  parent.status !== "awaiting-evaluation" ||
  parent.calls !== 2 ||
  parent.batch.budget.attempts.some((a: any) => a.status !== "succeeded") ||
  !missing ||
  !repaired ||
  [missing, repaired].some((r) => r.structuralErrors.length) ||
  missing.output.claims[0]?.status !== "gap" ||
  repaired.output.claims[0]?.status !== "supported" ||
  repaired.output.issues.some((i: any) => !i.resolved)
)
  throw new Error("局部配对未通过，不扩展整篇闭环");
const store = new RecordStorage(join(directory, "records"));
await mkdir(directory, { recursive: true });
const lockPath = resolve("runs/internal-training/dispatch.lock");
const lock = await open(lockPath, "wx");
try {
  const claim = await open(join(directory, "claim.json"), "wx");
  await claim.writeFile(
    JSON.stringify({
      limit: 6,
      parentHash: lineageHash,
      inheritedAttempts: lineage.parentNewAttempts + lineage.calls,
    }),
  );
  await claim.close();
  await trainingAdmission();
  await trainingAdmission("http://127.0.0.1:4319");
  const provider = createProvider();
  const baseline = JSON.parse(
    await readFile(
      "runs/internal-training/development-20261009/records/training/report.json",
      "utf8",
    ),
  );
  if (
    provider.id !== baseline.provider.id ||
    provider.model !== baseline.provider.model ||
    JSON.stringify(provider.settings) !==
      JSON.stringify(baseline.provider.settings)
  )
    throw new Error("模型配置与基线不同");
  const paper: PaperBundle = JSON.parse(
    await readFile(
      "data/papers/6149094e-e528-461a-bc3e-791ae6e5652e.json",
      "utf8",
    ),
  );
  const rules = await freezeRules();
  for (const [id, addition] of [
    ["medical-novice-simulator", noviceCoordination],
    [
      "medical-grounding-check",
      groundingCoordination +
        groundingCoverage +
        sharedCitationInstructions +
        (coordination ? feedbackAttribution : ""),
    ],
    ...(revision ? [["medical-journal-club-ppt", presentationEvidence]] : []),
  ]) {
    const entry = rules.entries[id];
    entry.text += "\n" + addition;
    entry.version += "-role-closure-candidate";
    entry.hash = digest(entry.text);
  }
  const batch: TrainingBatch = {
    id: batchId,
    phase: "M1",
    status: "running",
    cycleLimit: 6,
    budget: new BudgetLedger(batchId, async () => {}, undefined, 35 * 60_000)
      .state,
  };
  batch.budget.limit = batch.budget.groupLimit = 6;
  const report: any = {
    status: "running",
    parentHash: lineageHash,
    parentNewAttempts: lineage.parentNewAttempts + lineage.calls,
    batch,
    sourceView: "inline-frozen-blocks",
    scope: "整篇六页PPT三Agent开发回归；非发布/留出评估",
    provider: baseline.provider,
  };
  const persist = () => store.save("training", "report", report);
  await store.save("freeze", "rules", rules);
  await store.save("freeze", "paper", paper);
  await persist();
  const counted = new TrainingProvider(
    provider,
    batch,
    persist,
    (id, input) => store.save("inputs", id, input),
    () => batch.budget.attempts.length,
  );
  const adapted: Provider = {
    id: counted.id,
    model: counted.model,
    billingMode: counted.billingMode,
    settings: counted.settings,
    capabilities: counted.capabilities,
    async generate(
      instructions,
      input,
      schema,
      signal,
      image,
      observe,
      control,
    ) {
      await trainingAdmission();
      await trainingAdmission("http://127.0.0.1:4319");
      const review = schema instanceof z.ZodObject && "issues" in schema.shape;
      const stage = [
        "teaching",
        "novice",
        "grounding",
        "revision",
        "novice-reread",
        "grounding-final",
      ][batch.budget.attempts.length];
      counted.context = stage ?? "unexpected";
      if (review) {
        input = inlineAuditSources(
          input as Parameters<typeof inlineAuditSources>[0],
        );
        instructions +=
          "\n来源视图：sources.references每条已附原始text，id与blockHash不变；blocks为空不是证据缺失。逐项对照同条记录的id、locator与text；不可把相邻来源互换。";
      }
      return counted.generate(
        instructions,
        input,
        schema,
        signal,
        image,
        observe,
        control,
      );
    },
  };
  const manager = new TaskManager(
    adapted,
    (group, id, value) => store.save(group, id, value),
    "internal",
  );
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    reserveUnit(batch, 6, 0);
    const run = await withRuleSnapshot(rules, async () => {
      const run = await manager.start(
        {
          paperId: paper.id,
          module: "ppt",
          mode: "live",
          profileId: "beginner",
          question:
            "生成6页组会汇报：研究背景、实验设计、关键对照、主要结果与创新局限。逐页讲述提示独立保存在notes，不进入幻灯片正文；不需要完整讲稿。",
          sourceIds: paper.sources.map((s) => s.id),
          taughtConcepts: [],
          slideCount: 6,
          checks: {
            readability: true,
            reason: "内部三Agent协作与来源视图整合回归",
          },
        },
        paper,
        undefined,
        undefined,
        { signal: controller.signal },
      );
      await manager.wait(run.id);
      return run;
    });
    report.runId = run.id;
    report.runStatus = run.status;
    report.error = run.error;
    report.passed = strictDevelopmentAcceptance(run);
    const uncertain = batch.budget.attempts.some((a) =>
      ["unknown", "reserved", "cancelled"].includes(a.status),
    );
    report.status = uncertain
      ? "stopped"
      : report.passed
        ? "diagnostic-passed"
        : "needs-improvement";
    batch.status = uncertain ? "stopped" : "complete";
  } catch (error) {
    report.status = "stopped";
    report.error = String(error);
    batch.status = "stopped";
  } finally {
    report.calls = batch.budget.attempts.length;
    await persist();
    console.log(
      JSON.stringify({
        status: report.status,
        calls: report.calls,
        runId: report.runId,
        error: report.error,
      }),
    );
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
