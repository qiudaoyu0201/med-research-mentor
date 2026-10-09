import test from "node:test";
import assert from "node:assert/strict";
import { SourceTranslations } from "../server/source-translation.ts";
import {
  TutorResearch,
  needsBackgroundDecision,
} from "../server/tutor-research.ts";
import { TaskScheduler } from "../server/scheduler.ts";
import { BudgetLedger } from "../server/budget.ts";
import type { Provider } from "../server/provider.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { LiteratureSearch } from "../shared/literature.ts";
import type { list, save } from "../server/storage.ts";

const paper: PaperBundle = {
  id: "paper",
  title: "Medical study",
  version: "v1",
  scope: "fixture",
  sources: [
    {
      id: "source",
      title: "Text",
      kind: "paper",
      locator: "p1",
      text: "The control group was unchanged.",
      verified: true,
    },
  ],
};
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

test("translation close drains accepted starts before dispatch and refuses later requests", async () => {
  const entered = defer(),
    release = defer();
  let calls = 0;
  const provider: Provider = {
    model: "fixture",
    async generate(_a, _b, s) {
      calls++;
      return { output: s.parse({ translation: "对照组未变化。" }) };
    },
  };
  const persist: typeof save = async () => {
    entered.resolve();
    await release.promise;
  };
  const service = new SourceTranslations(
    provider,
    new TaskScheduler(),
    persist,
  );
  const starting = service.start(paper, "source", 0, "a");
  await entered.promise;
  const closing = service.close();
  release.resolve();
  const job = await starting;
  await closing;
  assert.equal(job.status, "cancelled");
  assert.equal(calls, 0);
  await assert.rejects(service.start(paper, "source", 0, "b"), /关闭/);
});

test("terminal persistence failure never advertises a cached successful translation", async () => {
  let calls = 0;
  const provider: Provider = {
    model: "fixture",
    async generate(_a, _b, s) {
      calls++;
      return { output: s.parse({ translation: "对照组未变化。" }) };
    },
  };
  const service = new SourceTranslations(
    provider,
    new TaskScheduler(),
    async (_g, _id, value: any) => {
      if (value.status === "completed") throw new Error("disk full");
    },
  );
  const job = await service.start(paper, "source", 0, "a");
  await service.wait(job.id).catch(() => {});
  assert.equal(service.get(job.id).status, "failed");
  assert.match(service.get(job.id).error!, /保存/);
  const duplicate = await service.start(paper, "source", 0, "a");
  assert.equal(duplicate.id, job.id);
  assert.equal(calls, 1);
  await service.close();
});

test("all concurrent request identities remain bound after the shared translation fails", async () => {
  const release = defer();
  let calls = 0;
  const provider: Provider = {
    model: "fixture",
    async generate() {
      calls++;
      await release.promise;
      throw new Error("transport failed");
    },
  };
  const records = new Map<string, any>();
  const persist: typeof save = async (_g, id, v) => {
    records.set(id, structuredClone(v));
  };
  const service = new SourceTranslations(
    provider,
    new TaskScheduler(),
    persist,
  );
  const [a, b] = await Promise.all([
    service.start(paper, "source", 0, "a"),
    service.start(paper, "source", 0, "b"),
  ]);
  assert.equal(a.id, b.id);
  release.resolve();
  await service.wait(a.id);
  assert.equal((await service.start(paper, "source", 0, "b")).status, "failed");
  assert.equal(calls, 1);
  const restored = new SourceTranslations(
    provider,
    new TaskScheduler(),
    persist,
  );
  await restored.restore((async () => [...records.values()]) as typeof list);
  assert.equal((await restored.start(paper, "source", 0, "b")).id, a.id);
  assert.equal(calls, 1);
});

function researchHarness(cancelAfterSearch = false) {
  const controller = new AbortController();
  const records = new Map<string, any>();
  let calls = 0,
    searches = 0;
  const provider: Provider = {
    id: "fixture",
    billingMode: "api",
    model: "fixture",
    async generate(_i, _x, s) {
      calls++;
      return {
        output: s.parse({
          query: "control group",
          reason: "method background",
        }),
      };
    },
  };
  const report: LiteratureSearch = {
    id: "report",
    topicVersion: "v1",
    query: "control group",
    queryReason: "method",
    startedAt: "2026-10-09T00:00:00Z",
    status: "completed",
    requests: [],
    candidatePmids: ["1"],
    selectionReason: "fixture",
    limitations: ["abstract only"],
    selected: [
      {
        id: "pmid-1",
        kind: "paper",
        verified: false,
        title: "Control group methods",
        locator: "PubMed PMID 1 · 摘要",
        excerpt: "Abstract evidence",
        hash: "hash",
        sourceType: "pubmed",
        url: "https://pubmed.ncbi.nlm.nih.gov/1/",
        bibliography: {
          pmid: "1",
          doi: "10.1000/example",
          authors: [],
          year: "2026",
          journal: "fixture",
          level: "abstract",
          fetchedAt: "2026-10-09T00:00:00Z",
          crossref: "mismatch",
          notices: ["DOI／题名不一致"],
        },
      },
    ],
  };
  const literature = {
    async restore() {},
    async search() {
      searches++;
      if (cancelAfterSearch) controller.abort();
      return structuredClone(report);
    },
  };
  const persist: typeof save = async (_g, id, value) => {
    records.set(id, structuredClone(value));
  };
  const service = new TutorResearch(literature, persist);
  const ledger = new BudgetLedger("turn", async () => {});
  return {
    controller,
    records,
    provider,
    service,
    ledger,
    literature,
    persist,
    report,
    calls: () => calls,
    searches: () => searches,
  };
}

test("background evidence retains counted planning, abstract provenance and source isolation across restore", async () => {
  const h = researchHarness();
  const sources = await h.service.supplement(
    paper,
    "对照组原理",
    h.provider,
    h.ledger,
    h.controller.signal,
  );
  assert.equal(h.calls(), 1);
  assert.equal(h.searches(), 1);
  assert.equal(h.ledger.state.attempts.length, 1);
  assert.equal(sources[0].kind, "foundation");
  assert.equal(sources[0].verified, false);
  assert.match(sources[0].locator, /摘要.*非当前论文.*DOI.*不一致/);
  const saved = h.records.get("report");
  assert.equal(saved.decisionAttemptId, h.ledger.state.attempts[0].id);
  assert.equal(saved.references[0].reference.bibliography.level, "abstract");
  sources[0].text = "mutated";
  assert.notEqual(h.service.sources(paper)[0].text, "mutated");
  const restored = new TutorResearch(h.literature, h.persist);
  await restored.restore((async () => [...h.records.values()]) as typeof list);
  assert.equal(restored.sources(paper).length, 1);
  assert.equal(restored.sources({ ...paper, version: "v2" }).length, 0);
});

test("reading lookup admission allows bounded help while respecting explicit paper-only requests", () => {
  const base = {
    clientMessageId: "lookup",
    mode: "live" as const,
    question: "请查资料解释这个机制",
  };
  assert.equal(needsBackgroundDecision(base), true);
  assert.equal(
    needsBackgroundDecision({ ...base, question: "为什么会持续？" }),
    false,
  );
  for (const question of [
    "不需要联网，解释这个机制",
    "无需联网，为什么如此？",
    "不用上网查资料，解释原理",
    "仅根据已导入论文第2页解释，为什么会持续？",
    "仅依据原文解释这个机制",
  ])
    assert.equal(
      needsBackgroundDecision({ ...base, question }),
      false,
      question,
    );
  assert.equal(
    needsBackgroundDecision({
      ...base,
      question: "需要联网查资料，解释这个机制",
    }),
    true,
  );
  assert.equal(
    needsBackgroundDecision({ ...base, question: "只用原文解释这个机制" }),
    false,
  );
  assert.equal(needsBackgroundDecision({ ...base, module: "ppt" }), false);
  assert.equal(needsBackgroundDecision({ ...base, question: "继续" }), false);
});

test("cancelled background search cannot publish supplemental evidence", async () => {
  const h = researchHarness(true);
  await assert.rejects(
    h.service.supplement(
      paper,
      "原理",
      h.provider,
      h.ledger,
      h.controller.signal,
    ),
  );
  assert.equal(h.records.size, 0);
  assert.equal(h.service.sources(paper).length, 0);
  assert.equal(h.ledger.state.attempts.length, 1);
});

test("refreshed bibliography cannot overwrite an older source used by historical grounding", async () => {
  const h = researchHarness();
  const old = await h.service.supplement(
    paper,
    "method",
    h.provider,
    h.ledger,
    h.controller.signal,
  );
  h.report.id = "new-report";
  h.report.selected[0].bibliography!.fetchedAt = "2026-10-10T00:00:00Z";
  h.report.selected[0].bibliography!.notices = ["new notice"];
  const current = await h.service.supplement(
    paper,
    "method",
    h.provider,
    h.ledger,
    h.controller.signal,
  );
  assert.notEqual(current[0].id, old[0].id);
  assert.deepEqual(
    h.service.sources(paper).find((s) => s.id === old[0].id),
    old[0],
  );
  const restored = new TutorResearch(h.literature, h.persist);
  await restored.restore((async () => [...h.records.values()]) as typeof list);
  assert.deepEqual(
    restored.sources(paper).find((s) => s.id === old[0].id),
    old[0],
  );
});

test("exact excerpt translation binds retries to the actual range and preserves legacy chunks", async () => {
  let calls = 0;
  const service = new SourceTranslations(
    {
      model: "fixture",
      async generate(_r, _i, schema) {
        calls++;
        return { output: schema.parse({ translation: "译文" }) };
      },
    },
    new TaskScheduler(),
    async () => {},
  );
  const long = structuredClone(paper);
  long.sources[0].text = "A".repeat(3500) + "CURRENT" + "B".repeat(4000);
  try {
    const exact = await service.start(long, "source", 3500, "exact", 3507);
    await service.wait(exact.id);
    assert.equal(exact.original, "CURRENT");
    assert.equal(
      (await service.start(long, "source", 3500, "exact", 3507)).id,
      exact.id,
    );
    await assert.rejects(
      service.start(long, "source", 3500, "exact", 3508),
      /编号/,
    );
    const legacy = await service.start(long, "source", 0, "legacy");
    await service.wait(legacy.id);
    assert.equal(
      (await service.start(long, "source", 0, "equivalent", 3500)).id,
      legacy.id,
    );
    for (const [start, end] of [
      [1, undefined],
      [-1, 10],
      [1.5, 10],
      [1, 1],
      [0, 3501],
      [0, 99999],
      [0, 1.5],
    ])
      await assert.rejects(
        service.start(long, "source", start!, "bad", end),
        /范围/,
      );
    await assert.rejects(
      service.start(long, "source", 3500, "stale", 3507, "old-version"),
      /论文版本已变化/,
    );
    assert.equal(calls, 2);
  } finally {
    await service.close();
  }
});
