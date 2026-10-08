import test from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { LiteratureService } from "../server/literature.ts";
import { ResearchPlans } from "../server/research-plans.ts";
import { TaskScheduler } from "../server/scheduler.ts";
import { prepareReading, completeReading } from "../server/reading-session.ts";
import { AssistantService } from "../server/assistant.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { ConversationStore } from "../server/conversation.ts";
import { ReadingGuides } from "../server/reading-guides.ts";
import type { Provider } from "../server/provider.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { save } from "../server/storage.ts";

const silent: typeof save = async () => {};
const paper: PaperBundle = {
  id: "regression-paper",
  title: "医学研究",
  version: "v1",
  scope: "给定原文",
  sources: ["Introduction\nResearch question.", "Methods\nTwo conditions."].map(
    (text, i) => ({
      id: `s${i}`,
      title: `原文 ${i + 1}`,
      locator: `片段 ${i + 1}`,
      text,
      kind: "paper" as const,
      verified: false,
    }),
  ),
};
const article = (pmid: string, extra = "") =>
  `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>${pmid}</PMID><Article><ArticleTitle>Study ${pmid}</ArticleTitle><Abstract><AbstractText>Reported association.</AbstractText></Abstract>${extra}</Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;

test("新版原文明确重新开始重置专题与覆盖，继续保留单调进度版本", () => {
  let state = completeReading(
    prepareReading(paper, undefined, "start", "开始带读"),
    "t1",
  );
  state = completeReading(
    prepareReading(paper, state, "jump", "先看方法"),
    "t2",
  );
  assert.equal(state.delivered.length, 2);
  assert.throws(
    () =>
      prepareReading({ ...paper, version: "v2" }, state, "continue", "继续"),
    /版本/,
  );
  const restarted = completeReading(
    prepareReading({ ...paper, version: "v2" }, state, "start", "重新开始"),
    "t3",
  );
  assert.equal(restarted.paperVersion, "v2");
  assert.equal(restarted.revision, 3);
  assert.equal(restarted.topic, null);
  assert.equal(restarted.delivered.length, 1);
  assert.equal(restarted.delivered[0].sourceId, "s0");
  assert.equal(restarted.cursor, restarted.mainCursor);
});

test("PubMed 撤稿类型与 Crossref 后置撤稿更新均不能进入生成依据", async () => {
  const retracted = article(
    "123",
    "<PublicationTypeList><PublicationType>Retracted Publication</PublicationType></PublicationTypeList>",
  );
  const service = new LiteratureService(
    async (url) =>
      new Response(
        String(url).includes("esearch.fcgi")
          ? JSON.stringify({ esearchresult: { idlist: ["123"] } })
          : retracted,
      ),
    silent,
  );
  const result = await service.search(
    "medical signal",
    "topic",
    new AbortController().signal,
  );
  assert.equal(result.status, "empty");
  assert.deepEqual(result.selected, []);
  const withDoi = article("456").replace(
    "</PubmedArticle>",
    '<PubmedData><ArticleIdList><ArticleId IdType="doi">10.1234/regression</ArticleId></ArticleIdList></PubmedData></PubmedArticle>',
  );
  const crossref = new LiteratureService(
    async (url) =>
      new Response(
        String(url).includes("esearch.fcgi")
          ? JSON.stringify({ esearchresult: { idlist: ["456"] } })
          : String(url).includes("efetch.fcgi")
            ? withDoi
            : JSON.stringify({
                message: {
                  DOI: "10.1234/regression",
                  title: ["Study 456"],
                  "update-to": [{ type: "retraction", DOI: "10.1234/notice" }],
                },
              }),
      ),
    silent,
  );
  const updated = await crossref.search(
    "medical signal",
    "other-topic",
    new AbortController().signal,
  );
  assert.equal(updated.status, "empty");
  assert.deepEqual(updated.selected, []);
  assert.equal(updated.requests.length, 3);
});

test("章节改稿重新检索保留未修改章节引用，Markdown 与 DOCX 均可导出", async () => {
  let phase = 0;
  const provider: Provider = {
    model: "fixture",
    async generate(_instructions, input, schema) {
      const x = input as Record<string, unknown>;
      const output = x.question
        ? { query: phase ? "other medicine" : "medicine", reason: "原课题概念" }
        : x.content
          ? {
              issues: [],
              checkedSourceRefs: [],
              limitations: ["仅给定摘要范围"],
            }
          : {
              title: "医学方案",
              sections: [
                {
                  id: "facts",
                  title: "背景",
                  text: "来自给定摘要的结论",
                  rationale: "文献依据",
                  kind: "source-fact",
                  sourceRefs: [`pmid-${phase ? "999" : "123"}`],
                  unknowns: [],
                },
                {
                  id: "design",
                  title: "设计",
                  text: phase ? "修改后的条件性设计" : "条件性设计",
                  rationale: "当前条件",
                  kind: "proposal",
                  sourceRefs: [],
                  unknowns: [],
                },
              ],
              assumptions: [],
              questions: [],
              limitations: ["未读取全文"],
            };
      return { output: schema.parse(output) };
    },
  };
  const transport: typeof fetch = async (url) =>
    new Response(
      String(url).includes("esearch.fcgi")
        ? JSON.stringify({ esearchresult: { idlist: [phase ? "999" : "123"] } })
        : article(phase ? "999" : "123"),
    );
  const plans = new ResearchPlans(
    provider,
    async () => paper,
    new TaskScheduler(),
    silent,
    async () => {},
    new LiteratureService(transport, silent),
  );
  const plan = await plans.create({ question: "医学信号与疾病的关系" });
  const initial = await plans.start(plan.id, {
    requestKey: "initial",
    expectedVersion: null,
    expectedTopicVersion: plan.topic.version,
    action: "generate",
    requestedScope: "full-plan",
    retrieveLiterature: true,
    maxCalls: 2,
  });
  assert.equal((await plans.wait(initial.id)).status, "completed");
  phase = 1;
  const current = plans.get(plan.id);
  const revise = await plans.start(plan.id, {
    requestKey: "revise",
    expectedVersion: current.currentVersion,
    expectedTopicVersion: current.topic.version,
    action: "revise",
    sectionId: "design",
    requestedScope: "full-plan",
    retrieveLiterature: true,
    maxCalls: 2,
  });
  const done = await plans.wait(revise.id);
  assert.equal(done.status, "completed", done.error);
  const version = plans.get(plan.id).versions.at(-1)!;
  assert.deepEqual(version.content.sections[0].sourceRefs, ["pmid-123"]);
  assert.match(version.content.sections[1].text, /修改后/);
  assert.ok(version.topic.sources.some((source) => source.id === "pmid-123"));
  for (const section of version.content.sections)
    for (const id of section.sourceRefs)
      assert.ok(version.topic.sources.some((source) => source.id === id));
  assert.doesNotMatch(plans.exportMarkdown(plan.id, version.id), /\[0\]/);
  const parts = unzipSync(plans.exportDocx(plan.id, version.id));
  assert.match(strFromU8(parts["word/document.xml"]), /PMID 123/);
});

test("重新检索发现原引用撤稿时保留旧稿且不能复活为新依据", async () => {
  let retracted = false;
  let modelCalls = 0;
  const provider: Provider = {
    model: "fixture",
    async generate(_instructions, input, schema) {
      modelCalls++;
      const x = input as Record<string, unknown>;
      const output = x.question
        ? {
            query: retracted ? "updated medicine" : "medicine",
            reason: "课题概念",
          }
        : x.content
          ? {
              issues: [],
              checkedSourceRefs: ["pmid-123"],
              limitations: ["仅给定摘要"],
            }
          : {
              title: "原方案",
              sections: [
                {
                  id: "facts",
                  title: "背景",
                  text: "给定摘要的结论",
                  rationale: "文献依据",
                  kind: "source-fact",
                  sourceRefs: ["pmid-123"],
                  unknowns: [],
                },
              ],
              assumptions: [],
              questions: [],
              limitations: ["仅摘要"],
            };
      return { output: schema.parse(output) };
    },
  };
  const transport: typeof fetch = async (url) =>
    new Response(
      String(url).includes("esearch.fcgi")
        ? JSON.stringify({ esearchresult: { idlist: ["123"] } })
        : article(
            "123",
            retracted
              ? "<PublicationTypeList><PublicationType>Retracted Publication</PublicationType></PublicationTypeList>"
              : "",
          ),
    );
  const plans = new ResearchPlans(
    provider,
    async () => paper,
    new TaskScheduler(),
    silent,
    async () => {},
    new LiteratureService(transport, silent),
  );
  const plan = await plans.create({ question: "医学关系研究" });
  const first = await plans.start(plan.id, {
    requestKey: "original",
    expectedVersion: null,
    expectedTopicVersion: plan.topic.version,
    action: "generate",
    retrieveLiterature: true,
    maxCalls: 2,
  });
  assert.equal((await plans.wait(first.id)).status, "completed");
  const saved = plans.get(plan.id);
  assert.equal(modelCalls, 3);
  retracted = true;
  const update = await plans.start(plan.id, {
    requestKey: "withdrawn",
    expectedVersion: saved.currentVersion,
    expectedTopicVersion: saved.topic.version,
    action: "revise",
    retrieveLiterature: true,
    maxCalls: 2,
  });
  const done = await plans.wait(update.id);
  assert.equal(done.status, "conflict");
  assert.match(done.error ?? "", /撤稿/);
  assert.deepEqual(done.literature?.selected, []);
  assert.equal(done.literature?.excluded?.[0].id, "pmid-123");
  assert.equal(plans.get(plan.id).currentVersion, saved.currentVersion);
  assert.equal(plans.get(plan.id).versions.length, 1);
  assert.equal(done.budget.attempts.length, 1);
  assert.equal(modelCalls, 4, "发现撤稿后不得生成或核对新稿");
});

test("阅读起点失败记录保留，无请求编号不重发，明确新编号重试且同编号去重", async () => {
  let calls = 0;
  const saved = new Map<string, unknown>();
  const pending = new Map<string, () => void>();
  const persist: typeof save = async (_group, id, value) => {
    saved.set(id, structuredClone(value));
    if (
      ["failed", "cancelled", "completed"].includes(
        (value as { status: string }).status,
      )
    )
      pending.get(id)?.();
  };
  const terminal = async (id: string) => {
    if (
      ["failed", "cancelled", "completed"].includes(
        (saved.get(id) as { status: string })?.status,
      )
    )
      return;
    await new Promise<void>((resolve) => pending.set(id, resolve));
  };
  const provider: Provider = {
    model: "fixture",
    async generate(_instructions, _input, schema) {
      calls++;
      if (calls === 1) throw new Error("fixture initial failure");
      return {
        output: schema.parse({
          summary: "给定原文的中文阅读起点",
          sourceIds: ["s0"],
          questions: ["研究问题如何连接测量？"],
        }),
      };
    },
  };
  const guides = new ReadingGuides(provider, new TaskScheduler(), persist);
  const failed = await guides.start(paper);
  await terminal(failed.id);
  assert.equal(failed.status, "failed");
  const failedSnapshot = structuredClone(saved.get(failed.id));
  assert.equal((await guides.start(paper)).id, failed.id);
  assert.equal(calls, 1);
  const retry = await guides.start(paper, "explicit-retry");
  assert.notEqual(retry.id, failed.id);
  assert.equal((await guides.start(paper, "explicit-retry")).id, retry.id);
  await terminal(retry.id);
  assert.equal(retry.status, "completed");
  assert.equal(calls, 2);
  assert.equal((await guides.start(paper, "explicit-retry")).id, retry.id);
  assert.equal(calls, 2);
  assert.deepEqual(saved.get(failed.id), failedSnapshot);
  assert.equal(guides.records.get(failed.id)?.status, "failed");
  assert.equal(guides.records.size, 2);
});

test("完成答案后的进度持久化失败不提前修改内存覆盖", async () => {
  let progressSaveFailures = 0;
  const persist: typeof save = async (group, _id, value) => {
    if (
      group === "conversations" &&
      (value as { readingSession?: unknown }).readingSession
    ) {
      progressSaveFailures++;
      throw new Error("fixture progress persistence failure");
    }
  };
  const provider: Provider = {
    model: "fixture",
    async generate(_instructions, input, schema) {
      const x = input as {
        question?: string;
        sources?: { references?: { id: string; kind: string }[] };
      };
      const ref =
        x.sources?.references?.find((r) => r.kind === "paper")?.id ?? "s0";
      const review = {
        issues: [],
        checkedSources: [ref],
        limitations: ["仅给定原文范围"],
      };
      const output = schema.safeParse(review).success
        ? review
        : {
            unit: {
              title: "中文原文解释",
              question: x.question ?? "开始带读",
              sections: [
                {
                  title: "研究问题",
                  text: "这是给定原文的中文解释。",
                  kind: "paper",
                  citations: [ref],
                },
              ],
              terms: [],
              nextQuestion: "继续",
            },
            deck: null,
          };
      return { output: schema.parse(output) };
    },
  };
  const conversations = new ConversationStore(persist);
  const manager = new TaskManager(provider, silent);
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    async () => paper,
    silent,
  );
  const state = await conversations.create({ paperId: paper.id });
  const turn = await assistant.submit(state.id, {
    clientMessageId: "progress-save-failure",
    question: "开始带读",
    readingAction: "start",
    expectedReadingRevision: 0,
    paperId: paper.id,
    mode: "live",
  });
  await assistant.wait(turn.id);
  assert.equal(turn.status, "failed");
  assert.equal(progressSaveFailures, 1);
  assert.equal(conversations.get(state.id).readingSession, undefined);
  assert.equal(
    manager.runs.get(turn.runId!)?.status,
    "completed",
    "已核对的答案仍保留在原任务中",
  );
});

test("带读生成失败或用户取消不提交覆盖进度", async () => {
  for (const cancel of [false, true]) {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const provider: Provider = {
      model: "fixture",
      async generate(_instructions, _input, _schema, signal) {
        calls++;
        entered();
        if (!cancel) throw new Error("fixture generation failure");
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("fixture cancelled")),
            { once: true },
          );
          if (signal.aborted) reject(new Error("fixture cancelled"));
        });
        throw new Error("unreachable");
      },
    };
    const conversations = new ConversationStore(silent);
    const manager = new TaskManager(provider, silent);
    const assistant = new AssistantService(
      provider,
      manager,
      conversations,
      async () => paper,
      silent,
    );
    const state = await conversations.create({ paperId: paper.id });
    const turn = await assistant.submit(state.id, {
      clientMessageId: `failure-${cancel}`,
      question: "开始带读",
      readingAction: "start",
      expectedReadingRevision: 0,
      paperId: paper.id,
      mode: "live",
    });
    await started;
    if (cancel) await assistant.cancel(turn.id);
    await assistant.wait(turn.id);
    assert.equal(turn.status, cancel ? "cancelled" : "failed");
    assert.equal(conversations.get(state.id).readingSession, undefined);
    assert.equal(calls, 1);
  }
});
