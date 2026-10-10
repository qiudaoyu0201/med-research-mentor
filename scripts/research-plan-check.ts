import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { PlanJob, ResearchPlan } from "../shared/research-plan.ts";
import { planJobDone } from "../shared/research-plan.ts";
const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4327";
const folder = "runs/research-plan-implementation/live";
await mkdir(folder, { recursive: true });
const verifyExisting = process.argv.includes("--verify-existing");
const report: any = verifyExisting
  ? JSON.parse(await readFile(`${folder}/report.json`, "utf8"))
  : {
      status: "running",
      maxCalls: 4,
      modelCalls: 0,
      jobs: [],
      limitations: [
        "有限实际生成与核对样本；不证明广泛科学有效性、国内平台、独立迁移或真人效果。",
      ],
    };
if (verifyExisting) {
  await writeFile(
    `${folder}/first-result.json`,
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  report.verificationOnly = true;
}
async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(
    base + path,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
async function generate(
  p: ResearchPlan,
  action: "generate" | "revise",
  instruction: string,
) {
  let j = await api<PlanJob>(`/api/research-plans/${p.id}/jobs`, {
    requestKey: crypto.randomUUID(),
    expectedVersion: p.currentVersion,
    expectedTopicVersion: p.topic.version,
    action,
    instruction,
    requestedScope: "direction",
    maxCalls: 2,
  });
  while (!planJobDone(j)) {
    await new Promise((r) => setTimeout(r, 1500));
    j = await api<PlanJob>(`/api/research-plan-jobs/${j.id}`);
  }
  report.jobs.push(j);
  report.modelCalls += j.budget.attempts.length;
  await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2));
  assert.equal(j.status, "completed", j.error);
  assert.ok(report.modelCalls <= 4);
  return api<ResearchPlan>(`/api/research-plans/${p.id}`);
}
try {
  if (verifyExisting) {
    assert.equal(report.jobs.length, 2);
    assert.ok(report.jobs.every((j: PlanJob) => j.status === "completed"));
    const saved = await api<ResearchPlan>(
      `/api/research-plans/${report.planId}`,
    );
    const exported = await fetch(
      base + `/api/research-plans/${saved.id}/exports/${saved.currentVersion}`,
    );
    assert.ok(exported.ok);
    await writeFile(`${folder}/current.md`, await exported.text());
    assert.equal(saved.versions.length, 2);
    assert.ok(report.modelCalls <= 4);
    report.status = "behavior-observed";
    delete report.error;
  } else {
    const p = await api<ResearchPlan>("/api/research-plans", {
      question:
        "细胞刺激后某个测量信号升高，怎样设计对照区分测量伪影、细胞数量变化与目标变化？只要医学基础实验方向框架。",
      conditions: "设备与效应量未知，不要编样本量、操作参数或已测结果。",
      studyTypes: ["basic-translational"],
      typeStatus: "provisional",
      learningPreferences: { verbosity: "brief", focus: "research-reasoning" },
    });
    report.planId = p.id;
    let saved = await generate(
      p,
      "generate",
      "最多三个短章节，每节解释取舍；缺条件列待确认。",
    );
    const first = saved.versions.at(-1)!;
    assert.ok(first.content.sections.every((s) => s.rationale));
    assert.equal(first.topic.sources.length, 0);
    const adjusted = await api<ResearchPlan>(
      `/api/research-plans/${p.id}/topic`,
      {
        expectedTopicVersion: saved.topic.version,
        topic: {
          question: p.topic.question,
          conditions:
            "只能进行基础显微观察，没有目标特异的检测设备；暂时无法作机制判断。",
          studyTypes: p.topic.studyTypes,
          typeStatus: p.topic.typeStatus,
          learningPreferences: p.topic.learningPreferences,
        },
      },
      "PUT",
    );
    saved = await generate(
      adjusted,
      "revise",
      "资源条件改变，简短改写可行测量路径与能支持的结论；保留待确认，最多三个短章节。",
    );
    report.plan = saved;
    const exported = await fetch(
      base + `/api/research-plans/${p.id}/exports/${saved.currentVersion}`,
    );
    assert.ok(exported.ok);
    await writeFile(`${folder}/current.md`, await exported.text());
    assert.equal(saved.versions.length, 2);
    assert.equal(saved.versions[0].id, first.id);
    assert.notEqual(saved.versions[1].topic.version, first.topic.version);
    report.status = "behavior-observed";
  }
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2));
}
