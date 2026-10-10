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
import {
  coverageReviewSchema,
  checkReviewCoverage,
  structuredCoverage,
} from "../evals/review-coverage.ts";
import type { TrainingBatch } from "../server/internal-training.ts";
import {
  claimAuditContract,
  claimAuditInstructions,
  sourceWitnessInstructions,
  inlineAuditSources,
  sharedCitationInstructions,
} from "../evals/claim-audit.ts";
const argument = process.argv[2];
if (argument && !/^review-v[2-9]$/.test(argument))
  throw new Error("仅支持默认四例校准或review-v2至review-v9两例窄修复测");
const version = argument ? Number(argument.slice(-1)) : 1;
const eighth = version >= 8,
  seventh = version >= 7,
  sixth = version >= 6;
const fifth = version >= 5,
  fourth = version >= 4,
  third = version >= 3,
  second = version >= 2;
const suffix = version === 1 ? "" : `-review-v${version}`;
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
let inheritedAttempts = previous.calls;
if (second) {
  const raw = await readFile(
    "runs/internal-training/role-calibration-20261009" +
      (version > 2 ? `-review-v${version - 1}` : "") +
      "/records/training/report.json",
    "utf8",
  );
  const state = JSON.parse(raw);
  if (version === 5 || version === 8) {
    // Preserve v4's unknown usage; require an acknowledged remote terminal.
    const a = state.batch.budget.attempts.at(-1);
    if (
      state.status !== "stopped" ||
      state.batch.budget.attempts.length !== (eighth ? 2 : 1) ||
      state.batch.budget.attempts
        .slice(0, -1)
        .some((prior: any) => prior.status !== "succeeded") ||
      a?.status !== "unknown" ||
      !a.observation?.threadId ||
      !a.observation?.turnId ||
      a.observation.remoteTerminal !== "interrupted" ||
      !a.observation.interruptAcknowledged ||
      !a.observation.events.some(
        (e: any) => e.type === "terminal" && e.status === "interrupted",
      )
    ) {
      throw new Error("前批未确认远端中断，不派发下一候选");
    }
  } else if (
    state.status !== "awaiting-evaluation" ||
    state.batch.budget.attempts.length !== (third ? 2 : 4) ||
    state.batch.budget.attempts.some((a: any) => a.status !== "succeeded")
  )
    throw new Error("上一版校准未明确结束，不派发");
  predecessorHash = createHash("sha256").update(raw).digest("hex");
  inheritedAttempts = state.parentNewAttempts + state.calls;
  if (
    !Number.isInteger(inheritedAttempts) ||
    inheritedAttempts < previous.calls
  )
    throw new Error("前批累计请求数无效");
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
  wrong.input.deck.slides[0].bullets[fifth ? 2 : 0] =
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
        schema: fourth ? coverageReviewSchema : c.schema,
        addition:
          c.addition +
          groundingCoverage +
          (third ? groundingDisposition : "") +
          (fourth ? structuredCoverage : "") +
          (fifth
            ? "\n审核保持紧凑：每条suggestion和rationale仅写必要判断与修改，不重复全段原稿；quote取足以定位的短原句；同一事实缺口不换名重复报告。保留所有关键缺陷。"
            : ""),
      }));
  if (eighth) {
    const narrow = structuredClone(grounding);
    const slide = structuredClone(narrow.input.deck.slides[5]);
    slide.bullets = [slide.bullets[2].split("；").slice(1).join("；")];
    if (!slide.bullets[0]?.startsWith("ChIP"))
      throw new Error("局部样本原句不匹配");
    slide.notes = "";
    narrow.input.deck.slides = [slide];
    narrow.input.draft.sections = [];
    narrow.input.feedback = { understood: [], breakpoints: [] };
    narrow.input.question =
      "仅核对原稿第6页所摘取的一条方法边界及它自己的引用，不评价未提供的其他页或教学完整性。";
    const repaired = structuredClone(narrow);
    const source = grounding.input.sources.references.find((r: any) =>
      r.id.endsWith("-p5"),
    );
    if (!source) throw new Error("缺少冻结的定位边界原文");
    repaired.input.deck.slides[0].citations.push(source.id);
    cases = [
      {
        id: "citation-missing",
        packet: narrow,
        addition: "",
        schema: reviewSchema,
        expected:
          "观点本身有来源，但本页漏引PDF第5页，必须发现citation gap，不得谎称其余页已经支持",
      },
      {
        id: "citation-repaired",
        packet: repaired,
        addition: "",
        schema: reviewSchema,
        expected:
          "只添加真实PDF第5页引用后应supported，不能继续误报漏引或要求不存在的临床证明",
      },
    ];
  }
  if (sixth)
    cases = cases.map((c) => {
      const audit = claimAuditContract(c.packet.input, seventh);
      return {
        ...c,
        packet: {
          ...c.packet,
          input: {
            ...(eighth ? inlineAuditSources(c.packet.input) : c.packet.input),
            auditManifest: audit.manifest,
          },
        },
        schema: audit.schema,
        addition:
          groundingCoordination +
          claimAuditInstructions +
          (seventh ? sourceWitnessInstructions : "") +
          (version === 9 ? sharedCitationInstructions : "") +
          (eighth
            ? "\n本版sources.references已将key、sourceId(id)、页码locator和原文text放在同一条记录中；blocks为空是存储视图改变，不是缺失材料。witness.source必须填该条记录key，不是PDF页码。教学补充问题关联的claims状态用gap或question，不要同时标supported。"
            : ""),
        expected: eighth
          ? c.expected
          : c.expected +
            "；逐要点覆盖，包括第6页ChIP定位边界的本页引用缺口；允许必要比较基准补讲但不改合法提问",
      };
    });
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
  if (fifth)
    batch.budget.timing = {
      version: "task-timing-v1",
      scope: "full",
      taskMs: 25 * 60_000,
      requestMs: 420_000,
      firstOutputMs: 90_000,
      idleMs: 90_000,
    };
  const report: any = {
    status: "running",
    parentReportHash: createHash("sha256").update(parentRaw).digest("hex"),
    predecessorHash,
    parentNewAttempts: inheritedAttempts,
    historicalObservedAttempts: previous.historicalObservedAttempts,
    batch,
    results: [],
    scope: "隔离角色校准，未采用候选",
    ...(version === 8
      ? {
          recovery:
            "v7末次请求已收到interrupt确认及远端interrupted事件；保留未知用量。v8仅测试一条方法边界的缺引/补引配对，不重发全文。",
        }
      : {}),
    ...(fifth && !sixth
      ? {
          recovery:
            "v4有interrupt确认及远端interrupted事件；保留unknown用量，不重发原请求。v5修正反例、缩短审核文本，内部请求上限7分钟。",
        }
      : {}),
  };
  const persist = () => store.save("training", "report", report);
  await store.save(
    "freeze",
    "expectations",
    cases.map((c) => ({ id: c.id, expected: c.expected })),
  );
  await store.save("freeze", "candidate", {
    actualAdditions: cases.map((c) => ({ id: c.id, addition: c.addition })),
    sourceView: eighth ? "inline-frozen-blocks" : "original",
    noviceCoordination,
    groundingCoordination,
    ...(second ? { groundingCoverage } : {}),
    ...(third ? { groundingDisposition } : {}),
    ...(seventh ? { sourceWitnessInstructions } : {}),
    ...(sixth
      ? {
          claimAuditInstructions,
          schema: z.toJSONSchema(cases[0].schema),
        }
      : {}),
    ...(fourth && !sixth
      ? { structuredCoverage, schema: z.toJSONSchema(coverageReviewSchema) }
      : {}),
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
      if (fourth) {
        const audit = sixth
          ? claimAuditContract(c.packet.input, seventh)
          : undefined;
        const errors = audit
          ? audit.validate(audit.schema.parse(response.output))
          : checkReviewCoverage(
              c.packet.input,
              coverageReviewSchema.parse(response.output),
            );
        await store.save("validation", c.id, {
          structuralErrors: errors,
          scientificAcceptance: "pending",
        });
        report.results.at(-1).structuralErrors = errors;
      }
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
