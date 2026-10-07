import test from "node:test";
import assert from "node:assert/strict";
import { ResearchPlans } from "../server/research-plans.ts";
import { ProviderFailure, type Provider } from "../server/provider.ts";
import { TaskScheduler } from "../server/scheduler.ts";
import type { PlanContent, ResearchPlan } from "../shared/research-plan.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { PlanJobInput } from "../server/research-plan-schemas.ts";
const content = {
  title: "测量与对照草案",
  sections: [
    {
      id: "question",
      title: "问题与目标",
      text: "拟观察是否影响测量对象。",
      rationale: "先确定对象与观察指标。",
      kind: "proposal" as const,
      sourceRefs: [],
      unknowns: ["对象待确认"],
    },
    {
      id: "controls",
      title: "对照与判读",
      text: "拟设置操作对照。",
      rationale: "排除操作本身的解释。",
      kind: "proposal" as const,
      sourceRefs: [],
      unknowns: ["设备待确认"],
    },
  ],
  assumptions: ["假设为基础实验，仍需确认"],
  questions: ["有哪些设备？"],
  limitations: ["没有样本依据，不指定 n；未完成实验。"],
};
const review = {
  issues: [],
  checkedSourceRefs: [],
  limitations: ["仅轻量设计衔接检查；无原文与专业审阅。"],
};
function harness(
  outputs: unknown[] = [content, review],
  custom?: Provider["generate"],
) {
  const records = new Map<string, any>(),
    calls: { instructions: string; input: any }[] = [];
  const papers: PaperBundle[] = ["a", "b"].map((id) => ({
    id,
    title: id,
    version: "1",
    scope: "测试局部原文",
    sources: [
      {
        id: "duplicate",
        kind: "paper",
        title: "同名片段",
        text: `${id} 的可见原文`,
        locator: "Figure 1",
        verified: true,
      },
    ],
  }));
  const provider: Provider = {
    id: "fixture",
    model: "fixture",
    async generate(i, x, schema, signal) {
      calls.push({ instructions: i, input: structuredClone(x) });
      if (custom) return custom(i, x, schema, signal);
      signal.throwIfAborted();
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      return {
        output: schema.parse(next),
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      };
    },
  };
  const persist = async (g: string, id: string, value: unknown) => {
    records.set(`${g}/${id}`, structuredClone(value));
  };
  const erase = async (g: string, id: string) => {
    records.delete(`${g}/${id}`);
  };
  const store = new ResearchPlans(
    provider,
    async (id) => {
      const p = papers.find((p) => p.id === id);
      if (!p) throw new Error("来源已删除");
      return structuredClone(p);
    },
    new TaskScheduler(),
    persist,
    erase,
  );
  return { store, records, calls, papers, provider, persist, erase };
}
const topic = {
  question: "比较一个医学测量与对照策略",
  conditions: "缺设备，先看方向",
  studyTypes: ["basic-translational"],
  typeStatus: "provisional",
};
const input = (p: ResearchPlan, extra: Partial<PlanJobInput> = {}) => ({
  requestKey: crypto.randomUUID(),
  expectedVersion: p.currentVersion,
  expectedTopicVersion: p.topic.version,
  action: "generate",
  ...extra,
});
const plain = (p: PlanContent) => ({
  ...p,
  sections: p.sections.map(({ author: _a, ...s }) => s),
});
test("零调用条件继承保留目标和历史稿，手改新稿关联新条件并拒绝核对旧版本", async () => {
  const h = harness(),
    p = await h.store.create({ ...topic, conditions: "仅显微镜" });
  const saved = await h.store.saveVersion(p.id, {
    expectedVersion: null,
    expectedTopicVersion: p.topic.version,
    content,
  });
  const changed = await h.store.updateTopic(p.id, saved.topic.version, {
    ...topic,
    conditions: "仅已有蛋白读数和细胞计数",
  });
  assert.equal(changed.topic.question, p.topic.question);
  assert.deepEqual(changed.versions[0], saved.versions[0]);
  await assert.rejects(
    h.store.start(p.id, input(changed, { action: "review" })),
    /旧课题条件/,
  );
  const edited = structuredClone(content);
  edited.sections[1].text = "按细胞计数检查总体读数变化";
  const next = await h.store.saveVersion(p.id, {
    expectedVersion: changed.currentVersion,
    expectedTopicVersion: changed.topic.version,
    content: edited,
  });
  assert.equal(next.versions.at(-1)!.parentId, saved.currentVersion);
  assert.equal(next.versions.at(-1)!.topic.version, changed.topic.version);
  assert.equal(next.topic.question, p.topic.question);
  assert.equal(h.calls.length, 0);
});
test("无 PDF 起步，在线只调用助手和核对；草稿先持久化，导出保留范围", async () => {
  const h = harness();
  const p = await h.store.create(topic);
  const j = await h.store.start(p.id, input(p));
  const completed = await h.store.wait(j.id);
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(completed.budget.attempts.length, 2);
  assert.equal(completed.budget.attempts[0].tokens.total, 30);
  assert.equal(h.calls[0].input.context.learningIntent.scope.paperId, null);
  assert.equal(h.calls[0].input.context.workMode, "assisted");
  assert.equal(h.calls[0].input.context.reviewPolicy, "lightweight");
  assert.ok(completed.capability.version);
  assert.equal(completed.capability.evidenceLevel, "engineering-preview");
  assert.equal("instructions" in h.store.job(j.id), false);
  const result = h.store.get(p.id);
  const v = result.versions[0];
  assert.equal(v.review?.versionId, v.id);
  assert.equal(v.review?.status, "checked");
  assert.equal(v.content.sections[0].author, "assistant");
  assert.match(h.store.exportMarkdown(p.id, v.id), /没有样本依据/);
  assert.match(h.store.exportMarkdown(p.id, v.id), /未提供文献/);
});
test("相同请求返回原任务；不同内容同键冲突，并发提交仅一份", async () => {
  const h = harness(),
    p = await h.store.create(topic),
    body = input(p);
  const [a, b] = await Promise.all([
    h.store.start(p.id, body),
    h.store.start(p.id, body),
  ]);
  assert.equal(a.id, b.id);
  await h.store.wait(a.id);
  assert.equal(h.calls.length, 2);
  await assert.rejects(
    h.store.start(p.id, { ...body, instruction: "改成另一种设计" }),
    /不同内容/,
  );
  const stored = h.store.get(p.id),
    next = input(stored);
  h.provider.generate = async (_i, _x, schema) => ({
    output: schema.parse(content),
  });
  const settled = await Promise.allSettled([
    h.store.start(p.id, next),
    h.store.start(p.id, input(stored)),
  ]);
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
  await h.store.wait(
    (
      settled.find(
        (s) => s.status === "fulfilled",
      ) as PromiseFulfilledResult<any>
    ).value.id,
  );
});
test("失败的新稿不影响先前成功稿导出；手改和恢复稿必须重新核对", async () => {
  const h = harness([content, review, content, new Error("核对连接断开")]);
  const p = await h.store.create(topic);
  const first = await h.store.start(p.id, input(p));
  const successful = await h.store.wait(first.id);
  assert.equal(successful.status, "completed");
  const checked = h.store.get(p.id);
  const failed = await h.store.start(
    p.id,
    input(checked, { action: "revise" }),
  );
  assert.equal((await h.store.wait(failed.id)).status, "failed");
  assert.match(
    h.store.exportMarkdown(p.id, successful.resultVersion!),
    /当前内容核对完成/,
  );
  assert.throws(
    () => h.store.exportMarkdown(p.id, h.store.get(p.id).currentVersion!),
    /不能导出/,
  );
  const current = h.store.get(p.id);
  const restored = await h.store.restoreVersion(
    p.id,
    successful.resultVersion!,
    current.currentVersion,
    current.topic.version,
  );
  assert.throws(
    () => h.store.exportMarkdown(p.id, restored.currentVersion!),
    /不能导出/,
  );
});
test("多论文同名来源不碰撞，不信任客户端来源正文或权限", async () => {
  const h = harness();
  const p = await h.store.create({
    ...topic,
    sources: [
      { paperId: "a", sourceVersion: "1", sourceId: "duplicate" },
      { paperId: "b", sourceVersion: "1", sourceId: "duplicate" },
    ],
  });
  assert.equal(p.topic.sources.length, 2);
  assert.notEqual(p.topic.sources[0].id, p.topic.sources[1].id);
  assert.match(p.topic.sources[0].excerpt, /a 的/);
  await assert.rejects(
    h.store.create({
      ...topic,
      sources: [
        {
          paperId: "a",
          sourceVersion: "1",
          sourceId: "duplicate",
          excerpt: "伪造",
        },
      ],
    }),
  );
  await assert.rejects(
    h.store.start(p.id, { ...input(p), executionMode: "internal-evaluation" }),
  );
  h.papers[0].version = "2";
  await assert.rejects(h.store.start(p.id, input(p)), /来源版本/);
  assert.equal(h.calls.length, 0);
});
test("手动保存和恢复创建新版本，保留归属，旧核对不复制，版本冲突不覆盖", async () => {
  const h = harness(),
    p = await h.store.create(topic);
  const j = await h.store.start(p.id, input(p));
  await h.store.wait(j.id);
  const base = h.store.get(p.id),
    old = base.versions[0],
    edited = plain(old.content);
  edited.sections[1].text = "用户修改对照";
  const updated = await h.store.saveVersion(p.id, {
    expectedVersion: old.id,
    expectedTopicVersion: base.topic.version,
    content: edited,
  });
  const v = updated.versions.at(-1)!;
  assert.ok(updated.updatedAt > base.updatedAt);
  assert.equal(v.content.sections[0].author, "assistant");
  assert.equal(v.content.sections[1].author, "mixed");
  assert.equal(v.review, undefined);
  assert.throws(() => h.store.exportMarkdown(p.id, v.id), /不能导出/);
  await assert.rejects(
    h.store.saveVersion(p.id, {
      expectedVersion: old.id,
      expectedTopicVersion: base.topic.version,
      content: edited,
    }),
    /已经变化/,
  );
  const restored = await h.store.restoreVersion(
    p.id,
    old.id,
    v.id,
    updated.topic.version,
  );
  assert.equal(restored.versions.length, 3);
  assert.equal(restored.versions.at(-1)!.review, undefined);
  assert.deepEqual(restored.versions[0], old);
  assert.equal(restored.versions.at(-1)!.restoredFrom, old.id);
});
test("生成期间条件改变，保存候选但不覆盖；不继续过期核对", async () => {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    entered = new Promise<void>((r) => {
      reached = r;
    });
  const h = harness([], async (_i, _x, schema) => {
    reached();
    await gate;
    return { output: schema.parse(content) };
  });
  const p = await h.store.create(topic),
    j = await h.store.start(p.id, input(p));
  await entered;
  await h.store.updateTopic(p.id, p.topic.version, {
    ...topic,
    conditions: "设备改变",
  });
  release();
  const result = await h.store.wait(j.id);
  assert.equal(result.status, "conflict");
  assert.ok(result.candidate);
  assert.equal(h.store.get(p.id).currentVersion, null);
  assert.equal(h.calls.length, 1);
});
test("生成成功但核对失败时，保存草稿且不标通过；用量和未知状态保留", async () => {
  const h = harness([content, new Error("连接断开")]),
    p = await h.store.create(topic);
  const j = await h.store.start(p.id, input(p)),
    done = await h.store.wait(j.id);
  assert.equal(done.status, "failed");
  assert.equal(done.budget.attempts[1].status, "unknown");
  const saved = h.store.get(p.id);
  assert.equal(saved.versions.length, 1);
  assert.equal(saved.versions[0].review, undefined);
  assert.throws(
    () => h.store.exportMarkdown(p.id, saved.currentVersion!),
    /不能导出/,
  );
  await assert.rejects(h.store.resumeReview(j.id), /未知/);
});
test("非法模型引用与无依据事实拒绝，未污染旧稿", async () => {
  const bad = structuredClone(content);
  bad.sections[0].sourceRefs = ["fake" as never];
  const h = harness([bad]),
    p = await h.store.create(topic),
    j = await h.store.start(p.id, input(p));
  const done = await h.store.wait(j.id);
  assert.equal(done.status, "failed");
  assert.match(done.error!, /引用/);
  assert.equal(h.store.get(p.id).versions.length, 0);
  const fakeFact = structuredClone(content);
  (fakeFact.sections[0] as any).kind = "source-fact";
  await assert.rejects(
    h.store.saveVersion(p.id, {
      expectedVersion: null,
      expectedTopicVersion: p.topic.version,
      content: fakeFact,
    }),
    /事实必须/,
  );
});
test("核对返回非法定位或阻断问题时保留草稿，但禁止导出", async () => {
  const h = harness([
    content,
    {
      ...review,
      issues: [
        {
          id: "i",
          sectionId: "missing",
          severity: "blocking",
          message: "错误",
          evidence: [],
        },
      ],
    },
  ]);
  const p = await h.store.create(topic),
    j = await h.store.start(p.id, input(p));
  assert.equal((await h.store.wait(j.id)).status, "failed");
  assert.equal(h.store.get(p.id).versions[0].review, undefined);
  const h2 = harness([
    content,
    {
      ...review,
      issues: [
        {
          id: "i",
          sectionId: "controls",
          severity: "blocking",
          message: "关键对照待确认",
          evidence: [],
        },
      ],
    },
  ]);
  const p2 = await h2.store.create(topic),
    j2 = await h2.store.start(p2.id, input(p2));
  await h2.store.wait(j2.id);
  const result = h2.store.get(p2.id);
  assert.equal(result.versions[0].review?.status, "issues");
  assert.throws(
    () => h2.store.exportMarkdown(p2.id, result.currentVersion!),
    /不能导出/,
  );
  const legacy = structuredClone(h2.records.get(`research-plan-jobs/${j2.id}`));
  legacy.status = "completed";
  await h2.store.restore([result], [legacy]);
  assert.equal(h2.store.job(j2.id).status, "failed");
});
test("单节改写保留其它章节和用户归属", async () => {
  const revised = structuredClone(content);
  revised.sections[0].text = "不应改到这里";
  revised.sections[1].text = "助手改对照";
  const h = harness([content, review, revised, review]),
    p = await h.store.create(topic),
    j = await h.store.start(p.id, input(p));
  await h.store.wait(j.id);
  const base = h.store.get(p.id),
    edited = plain(base.versions[0].content);
  edited.sections[0].text = "用户原稿";
  const saved = await h.store.saveVersion(p.id, {
    expectedVersion: base.currentVersion,
    expectedTopicVersion: base.topic.version,
    content: edited,
  });
  const next = await h.store.start(
    p.id,
    input(saved, { action: "revise", sectionId: "controls" }),
  );
  await h.store.wait(next.id);
  const result = h.store.get(p.id).versions.at(-1)!;
  assert.deepEqual(
    result.content.sections[0],
    saved.versions.at(-1)!.content.sections[0],
  );
  assert.equal(result.content.sections[1].text, "助手改对照");
});
test("停止的迟到响应不能写内容，删除清理任务和来源副本", async () => {
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    entered = new Promise<void>((r) => {
      reached = r;
    });
  const h = harness([], async (_i, _x, schema) => {
    reached();
    await gate;
    return { output: schema.parse(content) };
  });
  const p = await h.store.create(topic),
    j = await h.store.start(p.id, input(p));
  await entered;
  assert.equal((await h.store.cancel(j.id)).status, "cancelled");
  release();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(h.store.get(p.id).versions.length, 0);
  await h.store.delete(p.id);
  assert.equal(h.records.size, 0);
  assert.throws(() => h.store.get(p.id), /删除/);
  assert.equal(h.papers.length, 2);
});
test("重启未知调用不重发；提交草稿与任务写入的崩溃窗口可恢复定位", async () => {
  const h = harness(),
    p = await h.store.create(topic),
    j = await h.store.start(p.id, input(p));
  await h.store.wait(j.id);
  const saved = h.store.get(p.id),
    diskJob = structuredClone(h.records.get(`research-plan-jobs/${j.id}`));
  diskJob.status = "generating";
  diskJob.phase = "generation";
  diskJob.resultVersion = null;
  diskJob.budget.attempts[1].status = "reserved";
  const other = new ResearchPlans(
    h.provider,
    async () => h.papers[0],
    new TaskScheduler(),
    h.persist,
    h.erase,
  );
  await other.restore([saved], [diskJob]);
  const restored = other.job(j.id);
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.resultVersion, saved.currentVersion);
  assert.equal(restored.phase, "review");
  assert.equal(restored.budget.attempts[1].status, "unknown");
  assert.equal(h.calls.length, 2);
  await assert.rejects(other.resumeReview(j.id), /未知/);
  const afterRepair = structuredClone(saved);
  const repairedVersion = {
    ...structuredClone(saved.versions[0]),
    id: crypto.randomUUID(),
    parentId: saved.currentVersion,
    review: undefined,
  };
  afterRepair.versions.push(repairedVersion);
  afterRepair.currentVersion = repairedVersion.id;
  const repairJob = structuredClone(diskJob);
  repairJob.resultVersion = saved.currentVersion;
  const repairedStore = new ResearchPlans(
    h.provider,
    async () => h.papers[0],
    new TaskScheduler(),
    h.persist,
    h.erase,
  );
  await repairedStore.restore([afterRepair], [repairJob]);
  assert.equal(repairedStore.job(j.id).resultVersion, repairedVersion.id);
  assert.equal(repairedStore.job(j.id).phase, "review");
  assert.equal(h.calls.length, 2);
});
test("来源内容变化使新任务失效，归档阻止生成但保留导出", async () => {
  const h = harness(),
    p = await h.store.create({
      ...topic,
      sources: [{ paperId: "a", sourceVersion: "1", sourceId: "duplicate" }],
    });
  h.papers[0].sources[0].text = "修改的正文";
  await assert.rejects(h.store.start(p.id, input(p)), /来源内容/);
  await h.store.archive(p.id, true);
  await assert.rejects(h.store.start(p.id, input(p)), /归档/);
  assert.equal(h.calls.length, 0);
});
test("恢复核对沿用期限与预占次数，不重置预算", async () => {
  const h = harness([content, new ProviderFailure("格式错误", "format")]),
    p = await h.store.create(topic),
    j = await h.store.start(p.id, input(p));
  await h.store.wait(j.id);
  await assert.rejects(h.store.resumeReview(j.id), /预算已耗尽/);
  assert.equal(h.store.job(j.id).budget.attempts.length, 2);
});
test("阻断问题最多一次修订与复核，首稿与两份核对保留在原根账本", async () => {
  const blocked = {
    ...review,
    issues: [
      {
        id: "control-gap",
        sectionId: "controls",
        severity: "blocking",
        message: "需要说明匹配对照",
        evidence: [],
      },
    ],
  };
  const revised = structuredClone(content);
  revised.sections[1].text = "补充匹配操作对照，仍待条件确认";
  const h = harness([content, blocked, revised, review]),
    p = await h.store.create(topic),
    j = await h.store.start(p.id, input(p));
  const result = await h.store.wait(j.id),
    saved = h.store.get(p.id);
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.budget.attempts.length, 4);
  assert.equal(result.budget.revisions.length, 1);
  assert.equal(result.reviewHistory?.length, 2);
  assert.equal(saved.versions.length, 2);
  assert.equal(saved.versions[0].review?.status, "issues");
  assert.equal(saved.versions[1].parentId, saved.versions[0].id);
  assert.equal(saved.versions[1].review?.status, "checked");
});
test("新条件不能直接核对旧稿；纯核对不自动改用户稿", async () => {
  const h = harness(),
    p = await h.store.create(topic);
  const saved = await h.store.saveVersion(p.id, {
    expectedVersion: null,
    expectedTopicVersion: p.topic.version,
    content,
  });
  const changed = await h.store.updateTopic(p.id, p.topic.version, {
    ...topic,
    conditions: "新条件",
  });
  await assert.rejects(
    h.store.start(p.id, input(changed, { action: "review" })),
    /旧课题条件/,
  );
  const restored = await h.store.restoreVersion(
    p.id,
    saved.currentVersion!,
    saved.currentVersion,
    changed.topic.version,
  );
  h.provider.generate = async (_i, _x, schema) => ({
    output: schema.parse({
      ...review,
      issues: [
        {
          id: "i",
          sectionId: "controls",
          severity: "blocking",
          message: "有待确认",
          evidence: [],
        },
      ],
    }),
  });
  const j = await h.store.start(p.id, input(restored, { action: "review" })),
    result = await h.store.wait(j.id);
  assert.equal(result.budget.attempts.length, 1);
  assert.equal(result.status, "failed");
  assert.equal(h.store.get(p.id).versions.length, 2);
});
test("显式两次上限不被自动修订扩大，客户端不能提高上限", async () => {
  const blocked = {
    ...review,
    issues: [
      {
        id: "i",
        sectionId: "controls",
        severity: "blocking",
        message: "条件不足",
        evidence: [],
      },
    ],
  };
  const h = harness([content, blocked]),
    p = await h.store.create(topic);
  await assert.rejects(h.store.start(p.id, { ...input(p), maxCalls: 100 }));
  const j = await h.store.start(p.id, { ...input(p), maxCalls: 2 });
  const done = await h.store.wait(j.id);
  assert.equal(done.status, "failed");
  assert.equal(done.budget.attempts.length, 2);
  assert.equal(done.budget.limit, 2);
  assert.equal(h.store.get(p.id).versions[0].review?.status, "issues");
});
