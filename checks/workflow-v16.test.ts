import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import {
  readingAction,
  readingUnits,
  prepareReading,
  completeReading,
} from "../server/reading-session.ts";
import { AssistantService } from "../server/assistant.ts";
import { ConversationStore } from "../server/conversation.ts";
import { TaskManager } from "../server/orchestrator.ts";
import {
  LiteratureService,
  pubmedSources,
  LiteratureSearchFailure,
} from "../server/literature.ts";
import { ResearchPlans } from "../server/research-plans.ts";
import { planDocx } from "../server/plan-docx.ts";
import { TaskScheduler } from "../server/scheduler.ts";
import { save } from "../server/storage.ts";
import { digest } from "../server/materials.ts";
import {
  extendWorkflow,
  reserveWorkflow,
  validateWorkflow,
  type WorkflowReport,
} from "../server/workflow-iteration.ts";
import {
  iterationUsage,
  reserveIterationUnit,
} from "../server/training-protocol.ts";
import { reserveLoop } from "../server/short-loop.ts";
import type { Provider } from "../server/provider.ts";
import type { PaperBundle, AssistantMessage } from "../shared/types.ts";
import type { ResearchPlanVersion } from "../shared/research-plan.ts";

const paper: PaperBundle = {
  id: "test-paper",
  title: "医学原文",
  version: "v1",
  scope: "三段原文",
  sources: [
    "Introduction\nA study of signaling.",
    "Methods\nTwo conditions compared.",
    "Results\nThe association was observed.",
  ].map((text, i) => ({
    id: `s${i}`,
    title: `PDF 第 ${i + 1} 页`,
    page: i + 1,
    text,
    kind: "paper" as const,
    locator: `第 ${i + 1} 页`,
    verified: false,
  })),
};
const silent: typeof save = async () => {};
const xml =
  '<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>12345</PMID><Article><ArticleTitle>Signal &amp; study</ArticleTitle><Abstract><AbstractText Label="METHODS">A &lt; B in two groups.</AbstractText></Abstract><Journal><Title>Journal</Title><JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue></Journal><AuthorList><Author><LastName>Li</LastName><Initials>X</Initials></Author></AuthorList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1234/test</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>';
function fixture() {
  const inputs: any[] = [];
  const records = new Map<string, unknown>();
  const persist: typeof save = async (g, id, value) => {
    records.set(`${g}/${id}`, structuredClone(value));
  };
  const provider: Provider = {
    model: "fixture",
    async generate(instructions, input, schema, signal) {
      signal.throwIfAborted();
      inputs.push({ instructions, input });
      const x = input as any;
      const packet = x.sources;
      const ref = packet?.references?.find((r: any) => r.kind === "paper");
      const candidate = {
        issues: [],
        checkedSources: [ref?.id].filter(Boolean),
        limitations: ["仅核对给定范围"],
      };
      const output = schema.safeParse(candidate).success
        ? candidate
        : {
            unit: {
              title: "中文单元",
              question: x.question ?? "带读",
              sections: [
                {
                  title: "研究问题与证据",
                  text: "这是给定原文的中文解释。",
                  kind: "paper",
                  citations: [ref?.id ?? "s0"],
                },
              ],
              terms: [],
              nextQuestion: "接着读",
            },
            deck: null,
          };
      return { output: schema.parse(output) };
    },
  };
  const manager = new TaskManager(provider, persist);
  const conversations = new ConversationStore(persist);
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    async () => structuredClone(paper),
    persist,
  );
  return { assistant, manager, conversations, inputs, records };
}
test("带读连续三单元、深化和总结绑定真实范围；焦点与明确汇报优先", () => {
  let state = completeReading(
    prepareReading(paper, undefined, "start", "开始"),
    "t1",
  );
  assert.equal(state.cursor, 1);
  const deep = completeReading(
    prepareReading(paper, state, "deepen", "详细点"),
    "t2",
  );
  assert.equal(deep.cursor, 1);
  assert.equal(deep.delivered.length, 1);
  state = completeReading(
    prepareReading(paper, deep, "continue", "继续"),
    "t3",
  );
  assert.equal(state.delivered[1].sourceId, "s1");
  state = completeReading(
    prepareReading(paper, state, "continue", "继续"),
    "t4",
  );
  const summary = completeReading(
    prepareReading(paper, state, "continue", "继续"),
    "t5",
  );
  assert.equal(summary.summaryDelivered, true);
  assert.equal(summary.delivered.length, 3);
  assert.throws(
    () => prepareReading(paper, summary, "continue", "继续"),
    /已经|已交付/,
  );
  const message: AssistantMessage = {
    clientMessageId: "m",
    question: "继续做汇报",
    mode: "live",
  };
  assert.equal(readingAction(message, state), undefined);
  const fromBeginning = prepareReading(
    paper,
    state,
    "long",
    "从头完整讲给我看",
  );
  assert.equal(fromBeginning.ranges[0].sourceId, "s0");
  assert.equal(
    readingAction({ ...message, question: "重新开始带读" }, state),
    "start",
  );
  assert.equal(
    readingAction(
      {
        ...message,
        question: "继续",
        sourceAnchor: {
          paperId: paper.id,
          sourceVersion: "v1",
          sourceId: "s0",
          excerpt: "study",
        },
      },
      state,
    ),
    undefined,
  );
  assert.throws(
    () =>
      prepareReading({ ...paper, version: "v2" }, state, "continue", "继续"),
    /版本/,
  );
});
test("部分长页覆盖具有内容哈希和字符范围，专题回主线不丢位置", () => {
  const long = {
    ...paper,
    sources: [
      { ...paper.sources[0], text: "Introduction\n" + "a".repeat(6200) },
      paper.sources[1],
    ],
  };
  const units = readingUnits(long);
  assert.ok(units.length > 3);
  const state = completeReading(
    prepareReading(long, undefined, "start", "开始"),
    "a",
  );
  assert.equal(state.delivered[0].sourceHash, digest(long.sources[0].text));
  assert.ok(state.delivered[0].end < long.sources[0].text.length);
  const jump = completeReading(
    prepareReading(long, state, "jump", "先看方法"),
    "b",
  );
  assert.equal(jump.mainCursor, 1);
  const resume = prepareReading(long, jump, "resume", "回主线");
  assert.equal(resume.ranges[0].unitId, units[1].unitId);
});
test("服务端必要核对后提交进度，重复请求不收费，排队的旧版本无调用", async () => {
  const h = fixture();
  const c = await h.conversations.create({ paperId: paper.id });
  const m: AssistantMessage = {
    clientMessageId: "read1",
    question: "开始带读",
    readingAction: "start",
    expectedReadingRevision: 0,
    mode: "live",
    paperId: paper.id,
  };
  const first = await h.assistant.submit(c.id, m);
  const stale = await h.assistant.submit(c.id, {
    ...m,
    clientMessageId: "stale",
    question: "继续",
    readingAction: "continue",
  });
  await h.assistant.wait(first.id);
  await h.assistant.wait(stale.id);
  assert.equal(first.status, "completed", first.error);
  assert.equal(stale.status, "failed");
  assert.equal(h.inputs.length, 2);
  assert.equal(h.conversations.get(c.id).readingSession?.revision, 1);
  assert.equal((await h.assistant.submit(c.id, m)).id, first.id);
  assert.equal(h.inputs.length, 2);
  const next = await h.assistant.submit(c.id, {
    ...m,
    clientMessageId: "read2",
    question: "继续",
    readingAction: "continue",
    expectedReadingRevision: 1,
  });
  await h.assistant.wait(next.id);
  assert.equal(next.status, "completed", next.error);
  assert.equal(
    h.conversations.get(c.id).readingSession?.delivered[1].sourceId,
    "s1",
  );
  assert.ok(
    h.inputs[2].input.sources.blocks.some((b: any) =>
      b.text.includes("Methods"),
    ),
  );
});
test("PubMed XML解码保留摘要层级，受控请求去重缓存、交叉核验和失败记录", async () => {
  const parsed = pubmedSources(xml, "2026-10-08");
  assert.equal(parsed[0].title, "Signal & study");
  assert.match(parsed[0].excerpt, /A < B/);
  assert.equal(parsed[0].paperId, undefined);
  let calls = 0;
  const transport: typeof fetch = async (input) => {
    calls++;
    const url = String(input);
    if (url.includes("esearch.fcgi"))
      return new Response(
        JSON.stringify({ esearchresult: { idlist: ["12345"] } }),
      );
    if (url.includes("efetch.fcgi")) return new Response(xml);
    return new Response(
      JSON.stringify({
        message: { DOI: "10.1234/test", title: ["Signal & study"] },
      }),
    );
  };
  const service = new LiteratureService(transport, silent);
  const a = await service.search(
    "signal study",
    "topic1",
    new AbortController().signal,
  );
  assert.equal(a.requests.length, 3);
  assert.equal(a.selected[0].bibliography?.crossref, "matched");
  await service.search("signal study", "topic1", new AbortController().signal);
  assert.equal(calls, 3);
  const bad = new LiteratureService(
    async () => new Response("bad", { status: 503 }),
    silent,
  );
  await assert.rejects(
    bad.search("signal", "v1", new AbortController().signal),
    (e: unknown) =>
      e instanceof LiteratureSearchFailure &&
      e.report.requests.length === 1 &&
      e.report.status === "failed",
  );
  const empty = new LiteratureService(
    async () => new Response(JSON.stringify({ esearchresult: { idlist: [] } })),
    silent,
  );
  assert.equal(
    (await empty.search("signal", "v1", new AbortController().signal)).status,
    "empty",
  );
});
test("检索→生成→核对合同使用稳定外部引用，模型翻译调用计数；DOCX资格不绕过核对", async () => {
  const sources = pubmedSources(xml, "2026-10-08");
  let calls = 0;
  const content = {
    title: "信号通路完整方案",
    sections: Array.from({ length: 12 }, (_, i) => ({
      id: `section${i}`,
      title: `第${i + 1}节`,
      text: i === 0 ? "背景来自摘要" : "条件性设计，未知量待确认",
      rationale: "根据研究问题与已有条件确定",
      kind: i === 0 ? "source-fact" : "proposal",
      sourceRefs: i === 0 ? [sources[0].id] : [],
      unknowns: ["样本量需估算"],
    })),
    assumptions: ["资源尚未确认"],
    questions: [],
    limitations: ["摘要不是方法全文"],
  };
  const provider: Provider = {
    model: "fixture",
    async generate(_i, x, schema) {
      calls++;
      const input = x as any;
      if (input.sources) {
        assert.equal(
          JSON.stringify(input).split(sources[0].excerpt.replace(/\n/g, "\\n"))
            .length - 1,
          1,
        );
        assert.equal(input.sources[0].excerpt, sources[0].excerpt);
      }
      return {
        output: schema.parse(
          input.question
            ? { query: "signal study", reason: "原问题概念" }
            : input.content
              ? {
                  issues: [],
                  checkedSourceRefs: [sources[0].id],
                  limitations: ["仅摘要与条件核对"],
                }
              : content,
        ),
      };
    },
  };
  const transport: typeof fetch = async (input) =>
    String(input).includes("esearch.fcgi")
      ? new Response(JSON.stringify({ esearchresult: { idlist: ["12345"] } }))
      : String(input).includes("efetch.fcgi")
        ? new Response(xml)
        : new Response(
            JSON.stringify({
              message: { DOI: "10.1234/test", title: ["Signal & study"] },
            }),
          );
  const plans = new ResearchPlans(
    provider,
    async () => paper,
    new TaskScheduler(),
    silent,
    async () => {},
    new LiteratureService(transport, silent),
  );
  const p = await plans.create({ question: "信号通路如何影响疾病" });
  const j = await plans.start(p.id, {
    requestKey: "full",
    expectedVersion: null,
    expectedTopicVersion: p.topic.version,
    action: "generate",
    requestedScope: "full-plan",
    retrieveLiterature: true,
    maxCalls: 2,
  });
  const done = await plans.wait(j.id);
  assert.equal(done.status, "completed", done.error);
  assert.equal(calls, 3);
  assert.equal(done.budget.attempts.length, 3);
  const v = plans.get(p.id).currentVersion!;
  const file = plans.exportDocx(p.id, v);
  const parts = unzipSync(file);
  const text = strFromU8(parts["word/document.xml"]);
  assert.equal((text.match(/w:pStyle w:val="Heading1"/g) ?? []).length, 15);
  assert.match(text, /PMID 12345/);
  assert.match(text, /未确认/);
  assert.doesNotMatch(text, /127.0.0.1|D:\\/);
  await plans.restoreVersion(p.id, v, v, p.topic.version);
  assert.throws(
    () => plans.exportDocx(p.id, plans.get(p.id).currentVersion!),
    /核对/,
  );
});
test("DOCX中文表格、转义、公开链接与保存版本确定一致", () => {
  const ref = pubmedSources(xml, "2026-10-08")[0];
  const version = {
    id: "saved-version",
    createdAt: "2026-10-08",
    topic: { question: "医学问题", conditions: "未知", sources: [ref] },
    content: {
      title: "医学科研方案",
      sections: [
        {
          title: "技术路线",
          text: "| 阶段 | 依据 |\n| --- | --- |\n| 测量 | A < B & C |",
          rationale: "待核对条件",
          sourceRefs: [ref.id],
          unknowns: [],
          kind: "proposal",
        },
      ],
      assumptions: [],
      questions: [],
      limitations: [],
    },
  } as unknown as ResearchPlanVersion;
  const parts = unzipSync(planDocx(version));
  const text = strFromU8(parts["word/document.xml"]);
  assert.match(text, /<w:tbl>/);
  assert.match(text, /A &lt; B &amp; C/);
  assert.match(
    strFromU8(parts["word/_rels/document.xml.rels"]),
    /https:\/\/doi.org\/10.1234\/test/,
  );
});
function report(): WorkflowReport {
  const batches = Array.from({ length: 42 }, (_, i) => ({
    id: `b${i}`,
    phase: "M2",
    status: "completed",
    budget: {
      attempts: [{ id: `a${i}`, status: "succeeded" }],
      limit: 1,
      groupLimit: 1,
      revisions: [],
      deadline: "2099-01-01",
    },
  }));
  return {
    quota: {
      version: "iteration-v1.1-70x3",
      cycle: 3,
      historicalAttempts: 44,
      priorProductAttempts: 22,
      originReportHash: "a".repeat(64),
      previousReportHash: "b".repeat(64),
    },
    batches,
    shortLoops: {
      version: "short-loop-v1.4",
      historicalBatchIds: batches.map((b) => b.id),
      historicalBatchHash: digest(batches),
      historicalPendingIds: [],
      runs: [],
    },
  } as unknown as WorkflowReport;
}
test("同周期扩展继承108次，历史不可改，旧派发关闭，完整预约和20次复核限制一致", () => {
  const r = report();
  extendWorkflow(r, "c".repeat(64));
  assert.equal(iterationUsage(r.quota, r.batches).remainingCycle, 58);
  assert.equal(iterationUsage(r.quota, r.batches).combined, 108);
  assert.throws(() => reserveIterationUnit(r.quota, r.batches, 2), /旧入口/);
  assert.throws(() => reserveLoop(r, "round-2", "case", "hash"), /旧/);
  assert.throws(
    () => reserveWorkflow(r, "reading", "too-large", "hash", 21),
    /20|分路/,
  );
  const entry = reserveWorkflow(r, "reading", "three-units", "hash", 6);
  r.workflow!.runs.push({ ...entry, batchId: entry.id });
  r.batches.push({
    id: entry.id,
    phase: "M2",
    status: "running",
    budget: {
      limit: 6,
      groupLimit: 6,
      attempts: [],
      revisions: [],
      deadline: "2099-01-01",
    },
  } as any);
  assert.equal(validateWorkflow(r).stageCalls, 0);
  assert.throws(
    () => reserveWorkflow(r, "artifacts", "concurrent", "hash", 3),
    /活动|运行|收尾/,
  );
  r.batches[0].budget.attempts[0].status = "failed";
  assert.throws(() => validateWorkflow(r), /历史/);
});
