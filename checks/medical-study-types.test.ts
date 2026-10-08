import test from "node:test";
import assert from "node:assert/strict";
import { ResearchPlans } from "../server/research-plans.ts";
import { topicInputSchema } from "../server/research-plan-schemas.ts";
import { studyTypeIds } from "../shared/research-plan.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { Provider } from "../server/provider.ts";

function harness() {
  const calls: { instructions: string; input: any }[] = [];
  const provider: Provider = {
    id: "fixture",
    model: "fixture",
    async generate(instructions, input, schema, signal) {
      signal.throwIfAborted();
      calls.push({ instructions, input });
      return {
        output: schema.parse(
          calls.length % 2
            ? {
                title: "医学影像课题草案",
                sections: [
                  {
                    id: "design",
                    title: "设计",
                    text: "拟按患者划分训练与验证，并评价标注一致性。",
                    rationale: "同一患者的切片存在依赖，避免泄漏。",
                    kind: "proposal",
                    sourceRefs: [],
                    unknowns: ["独立队列尚未确认"],
                  },
                ],
                assumptions: ["数据可用于获批的科研分析"],
                questions: [],
                limitations: ["待导师核对可用样本与数据授权。"],
              }
            : {
                issues: [],
                checkedSourceRefs: [],
                limitations: ["只核对设计衔接，未核实真实数据与科学效果。"],
              },
        ),
      };
    },
  };
  const paper: PaperBundle = {
    id: "reference",
    title: "MRI 与 RNA-seq 参考论文",
    version: "1",
    scope: "测试正文",
    sources: [
      {
        id: "text",
        title: "方法",
        kind: "paper",
        text: "这篇参考论文使用了 MRI、转录组和随机对照试验。",
        locator: "第 1 页",
        verified: true,
      },
    ],
  };
  const store = new ResearchPlans(
    provider,
    async () => structuredClone(paper),
    undefined,
    async () => {},
    async () => {},
  );
  return { store, calls };
}

test("study type schema preserves legacy values and admits imaging/bioinformatics combinations", () => {
  for (const type of studyTypeIds) {
    const parsed = topicInputSchema.parse({
      question: "医学研究",
      studyTypes: [type],
      typeStatus: "confirmed",
    });
    assert.deepEqual(parsed.studyTypes, [type]);
  }
  assert.equal(
    topicInputSchema.parse({
      question: "医学研究",
      studyTypes: [...studyTypeIds],
      typeStatus: "provisional",
    }).studyTypes.length,
    6,
  );
  assert.throws(() =>
    topicInputSchema.parse({
      question: "医学研究",
      studyTypes: ["unrecognized"],
      typeStatus: "confirmed",
    }),
  );
});

test("intake suggests intersecting medical profiles provisionally without calling a model", async () => {
  const { store, calls } = harness();
  const plan = await store.create({
    question: "做肺癌的回顾性队列研究，结合 CT 影像组学与 RNA-seq",
    conditions: "有现成的患者数据",
  });
  assert.deepEqual(plan.topic.studyTypes, [
    "clinical-observational",
    "bioinformatics",
    "medical-imaging",
  ]);
  assert.equal(plan.topic.typeStatus, "provisional");
  const changed = await store.updateTopic(plan.id, plan.topic.version, {
    question: "做一个小鼠实验，研究细胞干预",
    conditions: "可用动物模型",
  });
  assert.deepEqual(changed.topic.studyTypes, ["basic-translational"]);
  assert.equal(changed.topic.typeStatus, "provisional");
  assert.equal(calls.length, 0);
});

test("explicit choices and unknown remain authoritative; reference-paper types never become target types", async () => {
  const { store } = harness();
  const explicit = await store.create({
    question: "医学影像研究",
    studyTypes: ["clinical-observational"],
    typeStatus: "confirmed",
  });
  assert.deepEqual(explicit.topic.studyTypes, ["clinical-observational"]);
  assert.equal(explicit.topic.typeStatus, "confirmed");
  const undecided = await store.create({
    question: "医学影像研究",
    studyTypes: [],
    typeStatus: "unknown",
  });
  assert.equal(undecided.topic.typeStatus, "unknown");
  const onlyReference = await store.create({
    question: "比较疾病进展的几种解释",
    sources: [{ paperId: "reference", sourceVersion: "1", sourceId: "text" }],
  });
  assert.equal(onlyReference.topic.sources.length, 1);
  assert.deepEqual(onlyReference.topic.studyTypes, []);
  assert.equal(onlyReference.topic.typeStatus, "unknown");
  const negative = await store.create({
    question: "研究疾病风险，不做生信，不开展临床试验",
    conditions: "参考论文使用医学影像",
  });
  assert.deepEqual(negative.topic.studyTypes, []);
});

test("type-specific safeguards reach both generation and review while capability claims stay bounded", async () => {
  const { store, calls } = harness();
  const p = await store.create({
    question: "用病理图像与转录组建立癌症预测模型",
  });
  const job = await store.start(p.id, {
    requestKey: "medical-profile-test",
    expectedVersion: null,
    expectedTopicVersion: p.topic.version,
    action: "generate",
    requestedScope: "full-plan",
  });
  const result = await store.wait(job.id);
  assert.equal(result.status, "completed", result.error);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.instructions, /按患者而非切片/);
    assert.match(call.instructions, /标注者一致性/);
    assert.match(call.instructions, /批次效应/);
    assert.match(call.instructions, /多重检验/);
    assert.match(call.instructions, /只在训练折拟合/);
    assert.match(call.instructions, /不能把参考论文的研究类型套给新课题/);
    assert.equal(call.input.context.researchProfile.status, "provisional");
    assert.deepEqual(call.input.context.researchProfile.studyTypes, [
      "bioinformatics",
      "medical-imaging",
    ]);
  }
  assert.equal(result.capability.evidenceLevel, "engineering-preview");
  assert.match(result.capability.scope, /不等于/);
});

test("restoring an existing unknown topic does not retroactively infer or rewrite its type", async () => {
  const { store, calls } = harness();
  const p = await store.create({
    question: "研究 MRI",
    studyTypes: [],
    typeStatus: "unknown",
  });
  const another = harness();
  await another.store.restore([structuredClone(p)], []);
  assert.deepEqual(another.store.get(p.id), p);
  assert.equal(calls.length, 0);
  assert.equal(another.calls.length, 0);
});
