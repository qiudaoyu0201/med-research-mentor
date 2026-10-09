// Four bounded calibration calls on frozen real drafts, not four full generations.
import { readFile, mkdir, open, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  noviceCoordination,
  groundingCoordination,
  groundingCoverage,
  groundingDisposition,
} from "../evals/role-coordination-candidate.ts";
import { noviceSchema, reviewSchema } from "../server/schemas.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
const third = process.argv[2] === "review-v3";
const second = process.argv[2] === "review-v2" || third;
if (process.argv[2] && !second)
  throw new Error("仅支持默认四例校准或review-v2/review-v3两例窄修复测");
const suffix = third ? "-review-v3" : second ? "-review-v2" : "";
const directory = resolve(
  "runs/internal-training/role-calibration-20261009" + suffix,
);
const limit = second ? 2 : 4;
process.env.TUTOR_DATA_DIR = join(directory, "data");
const { RecordStorage } = await import("../server/storage.ts");
const { createProvider } = await import("../server/model-config.ts");
const { TrainingProvider, reserveUnit } =
  await import("../server/internal-training.ts");
const { BudgetLedger } = await import("../server/budget.ts");
const { trainingAdmission } = await import("../server/training-admission.ts");
const parent = resolve("runs/internal-training/development-20261009/records");
const parentRaw = await readFile(join(parent, "training/report.json"), "utf8");
const previous = JSON.parse(parentRaw);
let predecessorHash: string | undefined;
if (second) {
  const raw = await readFile(
    "runs/internal-training/role-calibration-20261009" +
      (third ? "-review-v2" : "") +
      "/records/training/report.json",
    "utf8",
  );
  const state = JSON.parse(raw);
  if (
    state.status !== "awaiting-evaluation" ||
    state.batch.budget.attempts.length !== (third ? 2 : 4) ||
    state.batch.budget.attempts.some((a: any) => a.status !== "succeeded")
  )
    throw new Error("上一版校准未明确结束，不派发");
  predecessorHash = createHash("sha256").update(raw).digest("hex");
}
if (
  previous.status !== "diagnostic-passed" ||
  previous.batch.budget.attempts.some((a: any) => a.status !== "succeeded")
)
  throw new Error("前批未明确完成，不能开启角色校准");
const store = new RecordStorage(join(directory, "records"));
await mkdir(directory, { recursive: true });
const lockPath = resolve("runs/internal-training/dispatch.lock");
const lock = await open(lockPath, "wx");
try {
  const claim = await open(join(directory, "claim.json"), "wx");
  await claim.writeFile(
    JSON.stringify({
      parentHash: createHash("sha256").update(parentRaw).digest("hex"),
      predecessorHash,
      limit,
      purpose: "校准角色边界，不改线上Skill，不重复生成全文",
    }),
  );
  await claim.close();
  await trainingAdmission();
  const provider = createProvider();
  if (
    provider.id !== previous.provider.id ||
    provider.model !== previous.provider.model ||
    JSON.stringify(provider.settings) !==
      JSON.stringify(previous.provider.settings)
  )
    throw new Error("模型配置与基线不一致");
  const attempts = previous.batch.budget.attempts;
  const load = async (index: number) =>
    JSON.parse(
      await readFile(
        join(parent, "inputs", attempts[index].id + ".json"),
        "utf8",
      ),
    );
  const novice = await load(7),
    grounding = await load(8);
  if (!novice.input.explanation || !grounding.input.draft)
    throw new Error("历史角色输入位置不符");
  const wrong = structuredClone(grounding);
  wrong.input.deck.slides[0].bullets[0] =
    "本文已在人体随机对照试验中证明该干预可以治愈人类衰老。";
  const unclear = structuredClone(novice);
  unclear.input.explanation = {
    title: "测量与推理",
    question: "这个实验为什么支持结论？",
    sections: [
      {
        title: "结果",
        kind: "interpretation",
        text: "我们测定X指数，见到X上升，所以已证明唯一机制成立。",
        citations: [],
      },
    ],
    terms: [],
    nextQuestion: "",
  };
  delete unclear.input.presentation;
  let cases: {
    id: string;
    packet: any;
    addition: string;
    schema: z.ZodType;
    expected: string;
  }[] = [
    {
      id: "novice-real",
      packet: novice,
      addition: noviceCoordination,
      schema: noviceSchema,
      expected:
        "只报告可见讲解的必要断点，不凭先验列审稿清单；保留真实测量/对照/推理缺口",
    },
    {
      id: "grounding-real",
      packet: grounding,
      addition: groundingCoordination,
      schema: reviewSchema,
      expected:
        "不把研究疑问句当结论阻断；保留错页引用、标志物不可证明不可逆等真实缺口",
    },
    {
      id: "grounding-false-clinical",
      packet: wrong,
      addition: groundingCoordination,
      schema: reviewSchema,
      expected:
        "必须blocking拦截新增人体RCT治愈衰老主张；这是人工注入的反例，不是论文内容",
    },
    {
      id: "novice-missing-measurement",
      packet: unclear,
      addition: noviceCoordination,
      schema: noviceSchema,
      expected:
        "必须指出X测量含义和从信号上升到唯一机制的必要理解缺口，不能自称理解；人工反例",
    },
  ];
  if (second)
    cases = cases
      .filter((c) => c.id.startsWith("grounding-"))
      .map((c) => ({
        ...c,
        addition:
          c.addition + groundingCoverage + (third ? groundingDisposition : ""),
      }));
  const batch: TrainingBatch = {
    id: "role-calibration-20261009" + suffix,
    phase: "calibration",
    status: "running",
    cycleLimit: limit,
    budget: new BudgetLedger(
      "role-calibration-20261009",
      async () => {},
      undefined,
      25 * 60_000,
    ).state,
  };
  batch.budget.limit = batch.budget.groupLimit = limit;
  const report: any = {
    status: "running",
    parentReportHash: createHash("sha256").update(parentRaw).digest("hex"),
    predecessorHash,
    parentNewAttempts: previous.calls + (third ? 6 : second ? 4 : 0),
    historicalObservedAttempts: previous.historicalObservedAttempts,
    batch,
    results: [],
    scope: "隔离角色校准，未采用候选",
  };
  const persist = () => store.save("training", "report", report);
  await store.save(
    "freeze",
    "expectations",
    cases.map((c) => ({ id: c.id, expected: c.expected })),
  );
  await store.save("freeze", "candidate", {
    noviceCoordination,
    groundingCoordination,
    ...(second ? { groundingCoverage } : {}),
    ...(third ? { groundingDisposition } : {}),
  });
  await persist();
  const counted = new TrainingProvider(
    provider,
    batch,
    persist,
    (id, input) => store.save("inputs", id, input),
    () => batch.budget.attempts.length,
  );
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    reserveUnit(batch, limit, 0);
    for (const c of cases) {
      await trainingAdmission();
      counted.context = c.id;
      // Expectations never enter the learner or reviewer request.
      const response = await counted.generate(
        c.packet.instructions + "\n" + c.addition,
        c.packet.input,
        c.schema,
        controller.signal,
        c.packet.image ?? undefined,
      );
      await store.save("results", c.id, response.output);
      report.results.push({ id: c.id, output: response.output });
      await persist();
      console.log(JSON.stringify({ id: c.id, status: "returned" }));
    }
    report.status = "awaiting-evaluation";
    batch.status = "complete";
  } catch (e) {
    report.status = "stopped";
    report.error = String(e);
    batch.status = "stopped";
  } finally {
    report.calls = batch.budget.attempts.length;
    await persist();
    console.log(
      JSON.stringify({
        status: report.status,
        calls: report.calls,
        error: report.error,
      }),
    );
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
