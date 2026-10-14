import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { parsePdf } from "../server/pdf.ts";
import { registerFigureEvidence } from "../server/paper-assets.ts";
import {
  FoundationCatalog,
  foundationCatalog,
  aliasMatches,
} from "../server/foundations.ts";
import {
  bindPaperEvidence,
  defaultPaperSources,
  matchesFigure,
  materialPacket,
  selectEvidence,
} from "../server/materials.ts";
import {
  TaskManager,
  validateCitations,
  cacheKey,
  materialSources,
  validateTeachingSurface,
} from "../server/orchestrator.ts";
import { AssistantService, rulePlan } from "../server/assistant.ts";
import { ConversationStore } from "../server/conversation.ts";
import { ResultCache } from "../server/cache.ts";
import { evaluateRun, generationAttempts } from "../server/evaluation.ts";
import {
  groundedTeachingSchema,
  groundedReviewSchema,
  inputSchema,
  messageSchema,
} from "../server/schemas.ts";
import type { Source, PaperBundle, TaskRun } from "../shared/types.ts";
import type { Provider } from "../server/provider.ts";
const discard = async () => {};

test("explicit PDF registration preserves original images and rejects unlocated evidence", async () => {
  await mkdir("runs", { recursive: true });
  const content =
    "BT /F1 10 Tf 20 650 Td (ResultsStart An observed group comparison. ResultsEnd) Tj 0 -40 Td (MethodsStart An explicitly registered assay. MethodsEnd) Tj 0 -40 Td (Figure 1 | Original caption with the groups, observations, assay and conditions needed to identify this complete figure.) Tj ET";
  const pdf =
    "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 600 700] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n5 0 obj << /Length " +
    content.length +
    " >> stream\n" +
    content +
    "\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF";
  const path = "runs/figure-registration.pdf";
  await writeFile(path, pdf);
  const original = await parsePdf(
    path,
    "arbitrary-paper",
    "Generic registration",
  );
  const spec = {
    number: "1",
    page: 1,
    results: [{ page: 1, start: "ResultsStart", end: "ResultsEnd" }],
    methods: [{ page: 1, start: "MethodsStart", end: "MethodsEnd" }],
  };
  const registered = await registerFigureEvidence(original, path, spec);
  const selected = defaultPaperSources(registered, "Figure 1", ["figure"]);
  assert.equal(selected.length, 3);
  assert.match(selected[0].image!, /^data:image\/png;base64,/);
  assert.match(selected[0].caption!, /Original caption/);
  assert.match(selected[1].text, /observed group/);
  assert.match(selected[2].locator, /提取字符范围/);
  assert.notEqual(registered.version, original.version);
  assert.equal(original.sources.length, 1);
  await assert.rejects(
    registerFigureEvidence(original, path, { ...spec, number: "10" }),
    /图注/,
  );
  await assert.rejects(
    registerFigureEvidence(original, path, {
      ...spec,
      methods: [{ page: 1, start: "unlocated", end: "MethodsEnd" }],
    }),
    /定位失败/,
  );
});
const figure = (id: string, number = "1"): Source => ({
  id,
  title: `Figure ${number}`,
  figure: number,
  image: "data:image/png;base64,AA==",
  caption: `Figure ${number} | complete caption`,
  text: `Figure ${number} | complete caption`,
  kind: "paper",
  locator: "PDF page 1",
  verified: false,
  section: "figure",
});
const paper = (id: string): PaperBundle =>
  bindPaperEvidence({
    id,
    title: id,
    version: "v1",
    scope: "test",
    sources: [
      figure(id + "-figure"),
      {
        id: id + "-result",
        title: "results",
        text: "原文观察",
        kind: "paper",
        locator: "Results",
        verified: false,
        section: "results",
        relatedFigures: ["1"],
      },
    ],
  });
const feedback = { understood: [], breakpoints: [] };
const review = { issues: [], checkedSources: [], limitations: [] };
function provider(outputs: unknown[]): Provider {
  return {
    model: "test",
    async generate(_i, _x, schema) {
      return { output: schema.parse(outputs.shift()) };
    },
  };
}
const lesson = (id: string, kind: "foundation" | "paper" = "foundation") => ({
  unit: {
    title: "测量含义",
    question: "解释",
    terms: [],
    nextQuestion: "对照？",
    sections: [{ title: "读数", text: "解释具体原理", kind, citations: [id] }],
  },
  deck: null,
});

test("catalog aliases, dependencies and provenance work without a paper identifier", () => {
  const a = foundationCatalog.match("SA-β-gal p16^Ink4a TAF");
  assert.deepEqual(
    new Set(a.map((s) => s.id)),
    new Set([
      "senescence-basics",
      "sa-beta-gal",
      "sa-beta-gal-detection",
      "sa-beta-gal-tissue-assay",
      "p16-ink4a",
      "taf-basics",
    ]),
  );
  assert.equal(aliasMatches("staff", "TAF"), false);
  assert.ok(a.every((s) => s.foundation?.verification.supportedClaims.length));
  const source = structuredClone(a.find((s) => s.id === "taf-basics")!);
  source.id = "new-theme";
  source.foundation!.aliases = ["新主题"];
  source.foundation!.prerequisites = [];
  const catalog = new FoundationCatalog([source]);
  assert.equal(catalog.match("请讲新主题原理")[0].id, "new-theme");
  source.text += " changed";
  assert.notEqual(catalog.version, new FoundationCatalog([source]).version);
  assert.deepEqual(catalog.match("未知方法"), []);
});
test("output contracts reject annotated images, nonimages and foreign source IDs", () => {
  const sources = [figure("current-image"), foundationCatalog.all()[0]];
  const output = {
    ...lesson(sources[1].id),
    deck: {
      slides: [
        {
          title: "原图",
          bullets: ["读数"],
          notes: "说明",
          citations: ["current-image"],
          imageSource: "current-image",
        },
      ],
    },
  };
  const schema = groundedTeachingSchema(sources);
  assert.ok(schema.safeParse(output).success);
  for (const imageSource of [
    "current-image：第 2 页",
    sources[1].id,
    "other-paper-image",
  ]) {
    const invalid = structuredClone(output);
    invalid.deck.slides[0].imageSource = imageSource;
    assert.equal(schema.safeParse(invalid).success, false);
  }
  const blank = structuredClone(output);
  blank.deck.slides[0].imageSource = "";
  assert.ok(schema.safeParse(blank).success);
  assert.equal(
    groundedReviewSchema(sources).safeParse({
      ...review,
      checkedSources: ["other-paper-source"],
    }).success,
    false,
  );
});

test("source selection accepts the expanded catalog while output citations stay bounded", () => {
  const sourceIds = Array.from({ length: 22 }, (_, n) => `source-${n}`);
  assert.ok(
    inputSchema.safeParse({
      paperId: "xu-2018",
      module: "paper",
      mode: "example",
      question: "带读",
      profileId: "beginner",
      sourceIds,
      taughtConcepts: [],
    }).success,
  );
  assert.ok(
    messageSchema.safeParse({
      clientMessageId: "catalog",
      question: "带读",
      sourceIds,
    }).success,
  );
  const sources = sourceIds.map((id) => ({
    ...foundationCatalog.all()[0],
    id,
  }));
  const output = lesson(sourceIds[0]);
  output.unit.sections[0].citations = sourceIds;
  assert.equal(
    groundedTeachingSchema(sources).safeParse(output).success,
    false,
  );
});

test("internal feedback IDs in notes fail before delivery while real source identifiers remain valid", async () => {
  const p = paper("surface");
  const output = {
    ...lesson("surface-result", "paper"),
    deck: {
      slides: [
        {
          title: "汇报",
          bullets: ["观察"],
          notes: "读数含义",
          citations: ["surface-result"],
        },
      ],
    },
  };
  const draft = structuredClone(output);
  output.deck.slides[0].notes = "补讲BP-01：读数含义";
  assert.throws(
    () =>
      validateTeachingSurface(output.unit, output.deck, ["BP-01"], p.sources),
    /内部.*编号/,
  );
  const real = structuredClone(p.sources);
  real[1].text += " 实际测量对象 BP-01。";
  assert.doesNotThrow(() =>
    validateTeachingSurface(output.unit, output.deck, ["BP-01"], real),
  );
  const open = {
    ...feedback,
    breakpoints: [
      {
        id: "BP-01",
        sentence: "读数",
        missingConcept: "读数",
        question: "解释读数",
        status: "open",
      },
    ],
  };
  const closed = structuredClone(open);
  closed.breakpoints[0].status = "resolved";
  const manager = new TaskManager(
    provider([draft, open, review, output, closed, review]),
    discard,
  );
  const run = await manager.start(
    {
      paperId: p.id,
      module: "ppt",
      mode: "live",
      question: "汇报",
      profileId: "beginner",
      sourceIds: ["surface-result"],
      taughtConcepts: [],
    },
    p,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "failed");
  assert.match(run.error!, /内部.*编号/);
  assert.equal(run.calls, 6);
  assert.equal(run.result, undefined);
  assert.equal(run.deck, undefined);
  assert.ok(run.roles.some((r) => JSON.stringify(r.output).includes("BP-01")));
});

test("an explicitly missing paper denominator stays pending despite matching TAF foundations", async () => {
  const p = paper("denominator");
  p.sources.push(...foundationCatalog.match("TAF"));
  const output = lesson("denominator-result", "paper");
  const open = {
    ...feedback,
    breakpoints: [
      {
        id: "paper-gap",
        sentence: "TAF比例",
        missingConcept: "TAF计数分母",
        question: "图注报告TAF百分比，但所给材料未明确计数分母，请补论文方法。",
        status: "open",
      },
    ],
  };
  const insufficient = structuredClone(open);
  insufficient.breakpoints[0].status = "insufficient";
  const manager = new TaskManager(
    provider([output, open, review, output, insufficient, review]),
    discard,
  );
  const run = await manager.start(
    {
      paperId: p.id,
      module: "figure",
      mode: "live",
      question: "读图",
      profileId: "beginner",
      sourceIds: p.sources.map((s) => s.id),
      taughtConcepts: [],
    },
    p,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.calls, 6);
  assert.equal(run.materialRequests![0].kind, "paper");
  assert.equal(run.materialRequests![0].status, "pending");
  assert.deepEqual(run.materialRequests![0].matchedIds, []);
});

test("catalog rejects unverified references, missing dependencies and cycles", () => {
  const s = structuredClone(foundationCatalog.all()[0]);
  s.foundation!.claims[0].referenceIds = ["unknown"];
  assert.throws(() => new FoundationCatalog([s]), /出处/);
  s.foundation!.claims[0].referenceIds = [s.foundation!.references[0].id];
  s.foundation!.prerequisites = [s.id];
  assert.throws(() => new FoundationCatalog([s]), /循环/);
  s.foundation!.prerequisites = ["missing"];
  assert.throws(() => new FoundationCatalog([s]), /不存在/);
});
test("generic figure selection works for arbitrary papers and exact figure numbers", () => {
  for (const id of ["alpha", "beta"]) {
    const p = paper(id);
    p.sources.push(figure(id + "-figure10", "10"));
    assert.deepEqual(
      defaultPaperSources(p, "读图一", ["figure"]).map((s) => s.id),
      [id + "-figure", id + "-result"],
    );
    assert.equal(matchesFigure(p.sources.at(-1)!, "1"), false);
    assert.deepEqual(defaultPaperSources(p, "Figure 3", ["figure"]), []);
  }
  const manual = { ...figure("manual"), figure: "用户圈选" };
  assert.equal(matchesFigure(manual, "1"), true);
  const state = {
    pending: undefined,
    sourceIds: [],
    taughtConcepts: [],
    openQuestions: [],
  } as unknown as import("../shared/types.ts").ConversationState;
  assert.deepEqual(
    rulePlan(
      { clientMessageId: "fig", mode: "live", question: "解释 Fig. 1" },
      state,
      paper("alpha"),
    )?.modules,
    ["figure"],
  );
});
test("material cap keeps the target caption and registered evidence", () => {
  const target = figure("target");
  const results = { ...paper("alpha").sources[1], text: "R".repeat(18000) };
  const unrelated = {
    ...results,
    id: "other",
    relatedFigures: [],
    text: "U".repeat(19000),
  };
  const selected = selectEvidence([unrelated, results, target], "Figure 1", [
    "figure",
  ]);
  assert.ok(selected.some((s) => s.id === "target"));
  assert.ok(selected.some((s) => s.id === results.id));
  assert.ok(!selected.some((s) => s.id === "other"));
  materialPacket(selected);
  assert.throws(
    () =>
      selectEvidence(
        [{ ...results, text: "R".repeat(21000) }, target],
        "Figure 1",
        ["figure"],
      ),
    /20,000/,
  );
});
test("same foundation is reusable but paper facts and citation kinds stay isolated", () => {
  const foundation = foundationCatalog.match("TAF");
  const a = paper("alpha"),
    b = paper("beta");
  const unit = lesson(a.sources[1].id, "paper").unit;
  assert.throws(
    () => validateCitations(unit, review, [...b.sources, ...foundation]),
    /未提供/,
  );
  const wrong = lesson("taf-basics", "paper").unit;
  assert.throws(
    () => validateCitations(wrong, review, [...b.sources, ...foundation]),
    /类型/,
  );
  assert.doesNotThrow(() =>
    validateCitations(lesson("taf-basics").unit, review, [
      ...a.sources,
      ...foundation,
    ]),
  );
  assert.throws(
    () => validateCitations(unit, review, [...a.sources, ...b.sources]),
    /其他论文/,
  );
});
test("late foundation supplementation triggers exactly one revision and preserves audit snapshots", async () => {
  const gap = {
    id: "B1",
    sentence: "TAF",
    missingConcept: "TAF",
    question: "TAF怎样读？",
    status: "insufficient",
  };
  const p = paper("alpha"),
    outputs = [
      lesson("alpha-result", "paper"),
      { understood: [], breakpoints: [gap] },
      review,
      lesson("taf-basics"),
      { understood: [], breakpoints: [{ ...gap, status: "resolved" }] },
      review,
    ];
  const manager = new TaskManager(provider(outputs), discard);
  const run = await manager.start(
    {
      paperId: p.id,
      module: "paper",
      mode: "live",
      question: "讲实验",
      profileId: "beginner",
      sourceIds: ["alpha-result"],
      taughtConcepts: [],
    },
    p,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.calls, 6);
  assert.equal(run.materials?.length, 2);
  assert.ok(run.materials![1].addedIds.includes("taf-basics"));
  assert.equal(run.materialRequests![0].status, "resolved");
  assert.ok(!JSON.stringify(run.roles[0].input).includes("taf-basics"));
  assert.ok(JSON.stringify(run.roles[3].input).includes("taf-basics"));
  assert.ok(!("sources" in (run.roles[4].input as any)));
  assert.notEqual(
    run.budget!.attempts[0].sourceHash,
    run.budget!.attempts[3].sourceHash,
  );
  const cache = {
    put: async () => {
      throw Error("must not publish old key");
    },
  } as unknown as ResultCache;
  await manager.publishCache(run.id, cache);
});
test("paper-linked definition gaps also receive foundations before revision", async () => {
  const p = paper("mixed");
  const gap = {
    id: "bp-1",
    sentence: "TAF下降",
    missingConcept: "指标的生物学含义",
    question: "Figure 4中TAF和SA-β-gal各代表什么？请补充基础来源。",
    status: "open",
  };
  const audit = {
    ...review,
    issues: [
      {
        id: gap.id,
        type: "material",
        severity: "warning",
        location: "notes",
        suggestion: gap.question,
        evidence: ["mixed-result"],
        resolved: false,
      },
    ],
  };
  const manager = new TaskManager(
    provider([
      lesson("mixed-result", "paper"),
      { understood: [], breakpoints: [gap] },
      audit,
      lesson("taf-basics"),
      { understood: [], breakpoints: [{ ...gap, status: "resolved" }] },
      review,
    ]),
    discard,
  );
  const run = await manager.start(
    {
      paperId: p.id,
      module: "paper",
      mode: "live",
      question: "讲实验",
      profileId: "beginner",
      sourceIds: ["mixed-result"],
      taughtConcepts: [],
    },
    p,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.ok(run.materialRequests![0].matchedIds.includes("taf-basics"));
  assert.ok(run.materialRequests![0].matchedIds.includes("sa-beta-gal"));
  assert.ok(JSON.stringify(run.roles[3].input).includes("taf-basics"));
  assert.ok(!JSON.stringify(run.roles[0].input).includes("taf-basics"));
  assert.equal(run.materialRequests![0].status, "resolved");
});

test("unknown concepts stay pending with three calls and specific requests", async () => {
  const p = paper("alpha");
  const gap = {
    id: "B1",
    sentence: "新指标",
    missingConcept: "未登记标记",
    question: "缺未登记标记的基础定义",
    status: "insufficient",
  };
  const manager = new TaskManager(
    provider([
      lesson("alpha-result", "paper"),
      { understood: [], breakpoints: [gap] },
      review,
    ]),
    discard,
  );
  const run = await manager.start(
    {
      paperId: p.id,
      module: "paper",
      mode: "live",
      question: "讲实验",
      profileId: "beginner",
      sourceIds: ["alpha-result"],
      taughtConcepts: [],
    },
    p,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed");
  assert.equal(run.calls, 3);
  assert.equal(run.materialRequests![0].status, "pending");
  assert.deepEqual(run.materialRequests![0].matchedIds, []);
});
test("foundation version and final materials protect cache and export", () => {
  const p = paper("alpha"),
    s = foundationCatalog.match("TAF");
  p.sources.push(...s);
  const input = {
    paperId: p.id,
    module: "method" as const,
    mode: "live" as const,
    question: "TAF原理",
    profileId: "beginner",
    sourceIds: s.map((s) => s.id),
    taughtConcepts: [],
  };
  const before = cacheKey(input, p, {}, "test"),
    changed = structuredClone(p);
  changed.sources.at(-1)!.foundation!.version = "2";
  assert.notEqual(before, cacheKey(input, changed, {}, "test"));
  const run = {
    input,
    sourceVersion: p.version,
    materials: [
      {
        phase: "initial",
        sources: structuredClone(s),
        hash: "test",
        addedIds: [],
      },
    ],
  } as unknown as TaskRun;
  assert.equal(materialSources(run, p).length, s.length);
  assert.throws(() => materialSources(run, changed), /发生变化/);
});
test("independent method never loads a default paper and unknown methods ask before generation", async () => {
  const p = provider([lesson("qpcr-basics"), feedback, review]),
    manager = new TaskManager(p, discard),
    c = new ConversationStore(discard);
  const a = new AssistantService(
    p,
    manager,
    c,
    async () => {
      throw Error("must not load Xu");
    },
    discard,
  );
  const state = await c.create();
  const t = await a.submit(state.id, {
    clientMessageId: "first",
    mode: "live",
    question: "qPCR原理",
  });
  await a.wait(t.id);
  assert.equal(t.status, "completed", t.error);
  assert.equal(manager.runs.get(t.runId!)!.input.paperId, "foundation-only");
  const u = await a.submit(state.id, {
    clientMessageId: "unknown",
    mode: "live",
    question: "陌生检测方法原理",
  });
  await a.wait(u.id);
  assert.equal(u.status, "clarification");
  assert.equal(u.budget.attempts.length, 0);
});
test("evaluation inspects pending questions against required scope and never overrides blocking facts", async () => {
  const p = paper("scope");
  const manager = new TaskManager(
    provider([lesson("scope-result", "paper"), feedback, review]),
    discard,
  );
  const original = await manager.start(
    {
      paperId: p.id,
      module: "paper",
      mode: "live",
      question: "理解读数",
      profileId: "beginner",
      sourceIds: ["scope-result"],
      taughtConcepts: [],
    },
    p,
  );
  await manager.wait(original.id);
  const testCase = {
    id: "scope",
    split: "development" as const,
    module: "paper" as const,
    profileId: "beginner" as const,
    sourceIds: [],
    question: "理解读数",
    required: [],
    condition: "理解读数",
  };
  for (const necessary of [false, true]) {
    const run = structuredClone(original);
    run.materialRequests = [
      {
        id: "gap",
        concept: necessary ? "测量定义" : "完整复现时间安排",
        question: necessary
          ? "缺测量定义"
          : "时间安排已注明未知，不影响读数解释",
        reason: "缺材料",
        kind: "paper",
        paperId: p.id,
        sourceVersion: p.version,
        matchedIds: [],
        status: "pending",
      },
    ];
    const evaluator: Provider = {
      model: "test",
      async generate(_i, input: any, schema) {
        assert.equal(input.unresolvedQuestions[0].id, "gap");
        return {
          output: schema.parse({
            checks: input.criteria.map((criterion: string) => ({
              criterion,
              passed: !necessary || !criterion.startsWith("当前必要理解"),
              location: "读数",
              sourceIds: ["scope-result"],
              explanation: necessary
                ? "缺必要定义"
                : "范围外复现步骤已注明未知",
            })),
          }),
        };
      },
    };
    const result = await evaluateRun(
      testCase,
      run,
      p.sources,
      evaluator,
      new AbortController().signal,
      discard,
    );
    assert.equal(result.passed, !necessary);
    assert.equal(result.unresolvedQuestions?.length, 1);
    assert.equal(run.materialRequests[0].status, "pending");
  }
  const blocked = structuredClone(original);
  blocked.review!.issues.push({
    id: "fact",
    location: "读数",
    type: "fact",
    evidence: ["scope-result"],
    suggestion: "与来源矛盾",
    severity: "blocking",
    resolved: false,
  });
  const optimistic: Provider = {
    model: "test",
    async generate(_i, input: any, schema) {
      return {
        output: schema.parse({
          checks: input.criteria.map((criterion: string) => ({
            criterion,
            passed: true,
            location: "读数",
            sourceIds: ["scope-result"],
            explanation: "假设通过",
          })),
        }),
      };
    },
  };
  const rejected = await evaluateRun(
    testCase,
    blocked,
    p.sources,
    optimistic,
    new AbortController().signal,
    discard,
  );
  assert.equal(rejected.passed, false);
  assert.ok(rejected.findings.includes("与来源矛盾"));
});

test("evaluation has its own deadline and preserves the expired product ledger", async () => {
  const p = paper("alpha"),
    manager = new TaskManager(
      provider([lesson("alpha-result", "paper"), feedback, review]),
      discard,
    );
  const run = await manager.start(
    {
      paperId: p.id,
      module: "paper",
      mode: "live",
      question: "实验",
      profileId: "beginner",
      sourceIds: ["alpha-result"],
      taughtConcepts: [],
    },
    p,
  );
  await manager.wait(run.id);
  run.budget!.deadline = "2020-01-01T00:00:00Z";
  const original = structuredClone(run.budget);
  const evaluator: Provider = {
    model: "test",
    async generate(_i, input: any, schema) {
      return {
        output: schema.parse({
          checks: input.criteria.map((criterion: string) => ({
            criterion,
            passed: true,
            location: "读数",
            sourceIds: ["alpha-result"],
            explanation: "有原文依据",
          })),
        }),
      };
    },
  };
  const result = await evaluateRun(
    {
      id: "test",
      split: "development",
      module: "paper",
      profileId: "beginner",
      sourceIds: [],
      question: "实验",
      required: [],
      condition: "依据",
    },
    run,
    p.sources,
    evaluator,
    new AbortController().signal,
    discard,
  );
  assert.equal(result.passed, true, result.findings.join(" "));
  assert.deepEqual(run.budget, original);
  assert.equal(generationAttempts(run).length, 4);
});

test("teaching, revision and recheck retain previously delivered trial assumptions after a page request", async () => {
  const p = bindPaperEvidence({
    id: "retained-trial",
    title: "Trial",
    version: "v1",
    scope: "test",
    sources: Array.from({ length: 8 }, (_, i) => ({
      id: `trial-p${i + 1}`,
      title: `PDF 第 ${i + 1} 页`,
      page: i + 1,
      kind: "paper" as const,
      locator: `PDF ${i + 1}`,
      verified: false,
      text:
        `Page ${i + 1}. ` +
        "Generic evidence. ".repeat(128) +
        (i === 5
          ? "50% eligible, 60% initiate, 30% overall, design target 42.5%."
          : "Other evidence.") +
        " Remaining details. ".repeat(140),
    })),
  });
  const audit = {
    ...review,
    issues: [
      {
        id: "sample-size",
        type: "material",
        severity: "blocking",
        location: "正文",
        suggestion: "补充第八页方法原文",
        evidence: ["trial-p8"],
        resolved: false,
      },
    ],
  };
  const outputs = [
    lesson("trial-p6", "paper"),
    feedback,
    audit,
    lesson("trial-p6", "paper"),
    feedback,
    review,
  ];
  const inputs: any[] = [];
  const manager = new TaskManager(
    {
      model: "test",
      async generate(_i, input, schema) {
        inputs.push(structuredClone(input));
        return { output: schema.parse(outputs.shift()) };
      },
    },
    discard,
  );
  const run = await manager.start(
    {
      paperId: p.id,
      module: "paper",
      mode: "live",
      question: "trial denominators",
      profileId: "beginner",
      sourceIds: p.sources.map((s) => s.id),
      taughtConcepts: [],
    },
    p,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.calls, 6);
  for (const index of [0, 2, 3, 5]) {
    const packet = inputs[index].sources;
    const ref = packet.references.find((r: any) => r.id === "trial-p6");
    assert.match(
      packet.blocks.find((b: any) => b.hash === ref.blockHash).text,
      /30% overall/,
    );
    assert.ok(
      packet.blocks.reduce((n: number, b: any) => n + b.text.length, 0) <=
        22_000,
    );
  }
  assert.deepEqual(inputs[3].sources, inputs[5].sources);
});

test("simulated understanding is labelled through revision without replacing the actual user's question", async () => {
  const p = paper("feedback-origin");
  const actualQuestion = "我认为 OR 不是风险比，请解释条件比较与边际比较。";
  const simulated = {
    understood: ["我已理解调整后的 OR 可以当作风险比"],
    breakpoints: [],
  };
  const audit = {
    ...review,
    issues: [
      {
        id: "clarify-comparison",
        type: "teaching",
        severity: "blocking",
        location: "正文",
        suggestion: "解释条件与边际比较",
        evidence: ["feedback-origin-result"],
        resolved: false,
      },
    ],
  };
  const outputs = [
    lesson("feedback-origin-result", "paper"),
    simulated,
    audit,
    lesson("feedback-origin-result", "paper"),
    feedback,
    review,
  ];
  const inputs: any[] = [];
  const manager = new TaskManager(
    {
      model: "test",
      async generate(_instructions, input, schema) {
        inputs.push(structuredClone(input));
        return { output: schema.parse(outputs.shift()) };
      },
    },
    discard,
  );
  const run = await manager.start(
    {
      paperId: p.id,
      module: "paper",
      mode: "live",
      question: actualQuestion,
      profileId: "beginner",
      sourceIds: ["feedback-origin-result"],
      taughtConcepts: [],
    },
    p,
  );
  await manager.wait(run.id);
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.calls, 6);
  for (const index of [2, 3, 5]) {
    assert.equal(inputs[index].feedbackContext.origin, "simulated-novice");
    assert.equal(inputs[index].feedbackContext.isActualUserStatement, false);
  }
  assert.equal(inputs[0].question, actualQuestion);
  assert.equal(inputs[3].question, actualQuestion);
  assert.deepEqual(inputs[3].feedback, simulated);
  assert.notEqual(inputs[3].question, simulated.understood[0]);
});
