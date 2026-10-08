import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { localSample } from "../server/sample.ts";
import { parsePdf } from "../server/pdf.ts";
import { registerFigureEvidence } from "../server/paper-assets.ts";
import {
  hewittPdf,
  hewittTitle,
  hewittFigure,
  transferCases,
} from "../evals/transfer.ts";
import {
  defaultPaperSources,
  digest,
  materialPacket,
} from "../server/materials.ts";
import { foundationCatalog } from "../server/foundations.ts";
import { createProvider } from "../server/model-config.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { AssistantService } from "../server/assistant.ts";
import { ConversationStore } from "../server/conversation.ts";
import { evaluateRun, generationAttempts } from "../server/evaluation.ts";
import { save, read } from "../server/storage.ts";
import type { TaskRun, PaperBundle } from "../shared/types.ts";

const args = process.argv.slice(2),
  batch = args[args.indexOf("--batch") + 1];
if (args.includes("--batch") && !["A", "B"].includes(batch))
  throw new Error("--batch 仅支持 A 或 B。");
const a = await localSample();
let b: PaperBundle | undefined;
let materialError: string | undefined;
try {
  b = await parsePdf(hewittPdf, "hewitt-2012", hewittTitle);
  assert.ok(
    b.sources.some((s) => s.text.includes("10.1038/ncomms1708")),
    "正文 DOI 必须匹配",
  );
  b = await registerFigureEvidence(
    {
      ...b,
      doi: "10.1038/ncomms1708",
      scope:
        "Hewitt 2012 开放正文。真实原图及图注、结果、方法已按 PDF 页序登记，自动提取需对照原页。仅阅读正文。",
    },
    hewittPdf,
    hewittFigure,
  );
} catch (error) {
  b = undefined;
  materialError = "Hewitt 材料未就绪：" + (error as Error).message;
}
const papers = [a, ...(b ? [b] : [])];
const preparation = papers.map((p) => {
  const selected = defaultPaperSources(p, "Figure 1", ["figure"]),
    foundations = foundationCatalog.match(
      selected.map((s) => s.caption ?? s.text).join("\n"),
    );
  const chars = materialPacket([...selected, ...foundations]).blocks.reduce(
    (n, x) => n + x.text.length,
    0,
  );
  assert.equal(selected.length, 3);
  assert.ok(selected[0].image && selected[0].caption);
  assert.ok(chars <= 20000);
  return {
    paperId: p.id,
    version: p.version,
    chars,
    sources: selected.map(({ id, locator, text, image }) => ({
      id,
      locator,
      chars: text.length,
      image: !!image,
    })),
    foundations: foundations.map((s) => ({
      id: s.id,
      version: s.foundation!.version,
    })),
  };
});
await mkdir("runs", { recursive: true });
await writeFile(
  "runs/transfer-materials.json",
  JSON.stringify(
    {
      preparation,
      ...(materialError
        ? { status: "material-not-ready", error: materialError }
        : { status: "ready" }),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    mode: args.includes("--live") ? "live" : "materials",
    batch,
    preparation,
  }),
);
if (!args.includes("--live")) {
  assert.ok(!materialError, materialError);
  process.exit(0);
}
assert.ok(["A", "B"].includes(batch), "实跑需指定 A 或 B 批次");
const provider = createProvider();
if (args.includes("--evaluate-only")) {
  const caseId = args[args.indexOf("--case") + 1];
  const test = transferCases.find((c) => c.id === caseId);
  assert.ok(
    test && args.includes("--case"),
    "单独补验需明确 --case，不能自动重试。",
  );
  let reportPath = `runs/transfer-validation-${batch}-${caseId}.json`;
  try {
    await readFile(reportPath);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    reportPath = `runs/transfer-validation-${batch}.json`;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const record = report.records.find((r: any) => r.caseId === caseId);
  assert.ok(
    record?.runId && record.status === "completed",
    "只能补验已完成的产品讲解。",
  );
  assert.ok(report.calls < 32, "补验仍受批次 32 次调用额度约束。");
  const original = await read<TaskRun>("runs", record.runId);
  const number = (record.evaluationHistory?.length ?? 0) + 2;
  await writeFile(
    reportPath + `.before-evaluation${number}.json`,
    JSON.stringify(report, null, 2),
  );
  const run = structuredClone(original);
  run.id += `-evaluation${number}`;
  delete run.evaluationBudget;
  const started = Date.now();
  const persistEvaluation: typeof save = (_group, id, value) =>
    save("evaluation-runs", id, value);
  const result = await evaluateRun(
    test,
    run,
    run.materials!.at(-1)!.sources,
    provider,
    new AbortController().signal,
    persistEvaluation,
  );
  const attempts = run.evaluationBudget!.attempts.map(
    ({ id, role, status, durationMs, tokens }) => ({
      id,
      role,
      status,
      durationMs,
      tokens,
    }),
  );
  record.evaluationHistory ??= [];
  record.evaluationHistory.push(record.evaluation);
  record.evaluation = result;
  record.attempts.push(...attempts);
  record.calls += attempts.length;
  record.durationMs += Date.now() - started;
  record.passed =
    record.engineering.every((c: any) => c.passed) && result.passed;
  report.calls += attempts.length;
  report.endedAt = new Date().toISOString();
  report.passed = report.records.every((r: any) => r.passed);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      caseId,
      evaluationOnly: true,
      passed: record.passed,
      calls: attempts.length,
      findings: result.findings,
      path: reportPath,
    }),
  );
  assert.ok(record.passed, "补验未通过，原始记录与本次评价均已保留。");
  process.exit(0);
}
const persist: typeof save = async (group, id, value: any) => {
  await save(group, id, value);
  if (group === "runs") {
    const run = value as TaskRun;
    const latest = run.budget?.attempts.at(-1);
    const marker = `${run.id}-${latest?.id}-${latest?.status}-${run.status}`;
    if (lastMarker !== marker) {
      lastMarker = marker;
      console.log(
        JSON.stringify({
          progress: run.status,
          runId: run.id,
          role: latest?.role,
          attempt: latest?.status,
          calls: run.budget?.attempts.length,
        }),
      );
    }
  }
};
let lastMarker = "";
const manager = new TaskManager(provider, persist),
  conversations = new ConversationStore(persist);
const assistant = new AssistantService(
  provider,
  manager,
  conversations,
  async (id) => structuredClone(papers.find((p) => p.id === id)!),
  persist,
);
const state = await conversations.create(
  batch === "A" ? { paperId: a.id } : {},
);
const report: any = {
  batch,
  model: provider.model,
  settings: provider.settings,
  foundationVersion: foundationCatalog.version,
  preparation,
  startedAt: new Date().toISOString(),
  limit: 32,
  calls: 0,
  records: [],
};
const requestedCase = args.includes("--case")
  ? args[args.indexOf("--case") + 1]
  : undefined;
if (requestedCase)
  assert.ok(
    transferCases.some((c) => c.id === requestedCase),
    "未知场景 ID。",
  );
const reportPath = `runs/transfer-validation-${batch}${requestedCase ? "-" + requestedCase : ""}.json`;
try {
  const previous = await readFile(reportPath, "utf8");
  await writeFile(
    `runs/transfer-validation-${batch}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    previous,
  );
} catch (error: any) {
  if (error.code !== "ENOENT") throw error;
}
const cases = (
  batch === "A" ? transferCases.slice(0, 3) : transferCases.slice(3)
).filter((c) => !requestedCase || c.id === requestedCase);
assert.ok(cases.length, "场景不属于当前批次。");
assert.ok(
  !requestedCase || batch === "B",
  "连续会话 A 需要前置与追问，请完整运行。单独补评价可使用 --evaluate-only。",
);
for (const test of cases) {
  if (report.calls + 8 > 32)
    throw new Error("剩余批次额度不足以覆盖一个轮次。");
  if (test.id === "S2-transfer" && !b) {
    report.records.push({
      caseId: test.id,
      status: "material-not-ready",
      error: materialError,
      calls: 0,
      passed: false,
    });
    report.passed = false;
    report.endedAt = new Date().toISOString();
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    continue;
  }
  const conversation =
    batch === "A"
      ? conversations.get(state.id)
      : await conversations.create(
          test.id === "S4-report" ? { paperId: a.id } : {},
        );
  const started = Date.now();
  const turn = await assistant.submit(conversation.id, {
    clientMessageId: test.id,
    mode: "live",
    question: test.question,
    ...(test.id === "S2-transfer" ? { paperId: b!.id } : {}),
  });
  await assistant.wait(turn.id);
  const run = manager.runs.get(turn.runId ?? "");
  const record: any = {
    caseId: test.id,
    conversationId: conversation.id,
    turnId: turn.id,
    runId: run?.id,
    status: turn.status,
    error: turn.error,
    durationMs: Date.now() - started,
    productCalls: turn.budget.attempts.length,
    engineering: [],
    artifacts: turn.reply?.artifacts,
    pending: turn.reply?.pendingQuestions,
  };
  if (run?.status === "completed") {
    const final = run.materials!.at(-1)!.sources;
    const check = (ok: unknown, name: string) => {
      record.engineering.push({ name, passed: !!ok });
    };
    check(run.calls <= 6 && turn.budget.attempts.length <= 7, "bounded calls");
    check(
      run.roles
        .filter((r) => /novice/.test(r.role))
        .every(
          (r) =>
            !("sources" in (r.input as any)) && !("review" in (r.input as any)),
        ),
      "novice isolation",
    );
    if (test.id === "S1-followup") {
      check(
        !!run.input.previous && run.input.module === "figure",
        "followup context",
      );
      check(
        ["sa-beta-gal", "p16-ink4a", "taf-basics"].every((id) =>
          final.some((s) => s.id === id),
        ),
        "marker foundations",
      );
      check(
        digest(run.result) !== report.records[0].resultHash,
        "changed explanation",
      );
    }
    if (test.id === "S2-transfer") {
      check(
        final
          .filter((s) => s.kind === "paper")
          .every((s) => s.paperId === b!.id),
        "new paper only",
      );
      check(
        !run.input.previous &&
          !run.input.taughtConcepts.length &&
          !run.input.openQuestions?.length,
        "old context cleared",
      );
      check(
        final.some(
          (s) =>
            s.id === "taf-basics" &&
            s.foundation?.version ===
              foundationCatalog.all().find((x) => x.id === "taf-basics")
                ?.foundation?.version,
        ),
        "shared TAF foundation",
      );
      check(
        !JSON.stringify(run.roles.map((r) => r.input)).includes("xu-"),
        "no Xu evidence",
      );
    }
    if (test.id === "S3-independent") {
      check(
        run.input.paperId === "foundation-only" &&
          final.every((s) => s.kind === "foundation"),
        "independent foundations",
      );
      check(
        !turn.budget.attempts.some((a) => a.role === "assistant"),
        "zero planner",
      );
    }
    if (test.id === "S4-report") {
      check(
        run.deck?.slides.every(
          (s) =>
            !!s.imageSource &&
            final.some((x) => x.id === s.imageSource && !!x.image),
        ),
        "original image on every page",
      );
      check(run.deck?.slides.length === 3, "three slide outline");
      check(
        run.roles
          .filter((r) => /novice/.test(r.role))
          .every((r) => (r.input as any).presentation?.slides.length === 3),
        "whole deck reread",
      );
      const artifact = turn.reply?.artifacts[0];
      if (artifact) {
        const zip = unzipSync(
          new Uint8Array(
            await readFile(join("exports", artifact.id + ".pptx")),
          ),
        );
        check(
          Object.keys(zip).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
            .length === 3,
          "PPTX slides",
        );
        check(
          Object.keys(zip).filter((k) =>
            /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k),
          ).length === 3,
          "PPTX notes",
        );
        check(
          Object.keys(zip).some((k) => k.startsWith("ppt/media/")),
          "original image embedded",
        );
      } else check(false, "PPTX export");
    }
    record.evaluation = await evaluateRun(
      test,
      run,
      final,
      provider,
      new AbortController().signal,
      persist,
    );
    record.resultHash = digest(run.result);
    record.materialHash = run.materials!.at(-1)!.hash;
    record.sourceIds = final.map((s) => s.id);
    record.materialRequests = run.materialRequests;
    record.novice = run.novice;
    record.review = run.review;
    record.calls = generationAttempts(run).length;
    record.attempts = generationAttempts(run).map(
      ({ id, role, status, durationMs, tokens }) => ({
        id,
        role,
        status,
        durationMs,
        tokens,
      }),
    );
    record.passed =
      record.engineering.every((c: any) => c.passed) &&
      record.evaluation.passed;
  } else {
    record.calls = turn.budget.attempts.length;
    record.passed = false;
  }
  record.durationMs = Date.now() - started;
  report.records.push(record);
  report.calls += record.calls;
  assert.ok(report.calls <= 32);
  report.endedAt = new Date().toISOString();
  report.passed = report.records.every((r: any) => r.passed);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      caseId: test.id,
      status: turn.status,
      passed: record.passed,
      calls: record.calls,
      durationMs: record.durationMs,
      findings: record.evaluation?.findings,
      path: reportPath,
    }),
  );
}
assert.ok(report.passed, "有场景未通过，参见 " + reportPath);
