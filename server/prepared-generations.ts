import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PaperBundle, TaskRun } from "../shared/types.ts";
import type {
  ResearchPlan,
  PlanContent,
  PlanJob,
  ResearchPlanVersion,
  SourceRef,
} from "../shared/research-plan.ts";
import { planContentSchema } from "./research-plan-schemas.ts";
import { randomUUID } from "node:crypto";

export async function loadPreparedDeck() {
  try {
    const run = JSON.parse(
      await readFile(
        resolve("data/runs/7aaf89d6-9d2f-497c-917e-0108763dc749.json"),
        "utf8",
      ),
    ) as TaskRun;
    return run;
  } catch {
    return undefined;
  }
}

function planContent(markdown: string, refs: SourceRef[]): PlanContent {
  const chunks = markdown
    .split(/(?=^## )/m)
    .filter((chunk) => chunk.startsWith("## "));
  const sections = chunks.map((chunk, index) => {
    const lines = chunk.trim().split(/\r?\n/);
    const title = lines
      .shift()!
      .replace(/^##\s+/, "")
      .trim();
    const text = lines
      .join("\n")
      .replace(/^\s*\r?\n/, "")
      .trim();
    return {
      id: `prepared-section-${index + 1}`,
      title,
      text,
      rationale: "根据固定论文来源与录制条件整理，作为与老师讨论的草案。",
      kind: index === 0 ? ("hypothesis" as const) : ("proposal" as const),
      sourceRefs: refs.slice(0, Math.min(3, refs.length)).map((ref) => ref.id),
      unknowns: ["正式条件、重复数和样本量需结合实验室预实验确认。"],
    };
  });
  const parsed = planContentSchema.parse({
    title: "端粒相关损伤灶的群体残留轨迹与成纤维细胞衰老",
    sections,
    assumptions: ["方案用于与导师讨论，关键实验条件尚待预实验确认。"],
    questions: ["实验室可用的损伤诱导方式、成像能力和独立重复如何确定？"],
    limitations: [
      "这是基于单篇论文的设计草案，不代表已完成伦理、统计或实验可行性审批。",
    ],
  });
  return {
    ...parsed,
    sections: parsed.sections.map((section) => ({
      ...section,
      author: "assistant" as const,
    })),
  };
}

export async function preparedPlan(
  plan: ResearchPlan,
  markdownPath: string,
): Promise<{ plan: ResearchPlan; job: PlanJob }> {
  const markdown = await readFile(resolve(markdownPath), "utf8");
  const content = planContent(markdown, plan.topic.sources);
  const version: ResearchPlanVersion = {
    id: randomUUID(),
    parentId: null,
    createdAt: new Date().toISOString(),
    topic: structuredClone(plan.topic),
    content,
    origin: "assistant",
  };
  const review = {
    id: randomUUID(),
    jobId: "recording-prepared",
    versionId: version.id,
    status: "checked" as const,
    purposes: ["artifact-quality"] as ["artifact-quality"],
    issues: [],
    checkedSourceRefs: plan.topic.sources.map((source) => source.id),
    limitations: [
      "固定预备草案；关键参数、正式重复数和伦理可行性仍需与导师确认。",
    ],
    createdAt: new Date().toISOString(),
  };
  version.review = review;
  const now = new Date().toISOString();
  const job: PlanJob = {
    id: randomUUID(),
    planId: plan.id,
    status: "completed",
    phase: "generation",
    requestKey: "recording-prepared",
    requestHash: "recording-prepared",
    context: {
      schemaVersion: "2",
      learningIntent: {
        version: "1",
        verbosity: "standard",
        focus: "research-reasoning",
        goal: "discuss-research",
        scope: {
          paperId: plan.topic.sources[0]?.paperId ?? null,
          sourceVersion: plan.topic.sources[0]?.sourceVersion ?? null,
          sourceIds: plan.topic.sources.map(
            (source) => source.sourceId ?? source.id,
          ),
          selection: "prepared-recording",
          artifactVersion: null,
        },
        backgroundRef: "prepared-recording",
        preferenceScope: "turn",
      },
      topicRef: { id: plan.topic.id, version: plan.topic.version },
      capabilityRef: { id: "prepared-recording", version: "1" },
      researchProfile: {
        domain: "medical",
        studyTypes: plan.topic.studyTypes,
        status: plan.topic.typeStatus,
      },
      artifactRef: { kind: "research-plan", id: plan.id, version: version.id },
      executionMode: "online",
      workMode: "assisted",
      requestedScope: "full-plan",
      requestGuidance: { currentInstructions: [] },
      reviewPolicy: "lightweight",
      learningSourceRefs: plan.topic.sources,
      targetSourceRefs: [],
    },
    expectedVersion: null,
    resultVersion: version.id,
    review,
    candidate: version,
    budget: {
      limit: 0,
      groupLimit: 0,
      attempts: [],
      revisions: [],
      deadline: now,
      billingMode: "api",
      amount: null,
    },
    createdAt: now,
    capability: {
      id: "prepared-recording",
      version: "1",
      model: "prepared",
      modelFingerprint: "prepared",
      scope: "recording",
      evidenceLevel: "engineering-preview",
      rulesHash: "prepared",
    },
  };
  return {
    plan: {
      ...structuredClone(plan),
      currentVersion: version.id,
      versions: [version],
      updatedAt: now,
    },
    job,
  };
}
