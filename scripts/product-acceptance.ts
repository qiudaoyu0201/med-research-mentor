import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AssistantTurn,
  PaperBundle,
  DeckVersion,
} from "../shared/types.ts";
import type { ResearchPlan, PlanJob } from "../shared/research-plan.ts";
// Deliberately separate real model acceptance from zero-call engineering tests.
if (process.env.TUTOR_ACCEPTANCE_LIVE !== "1")
  throw new Error(
    "真实核验会调用模型。明确设置 TUTOR_ACCEPTANCE_LIVE=1 后运行。",
  );
const base = process.env.TUTOR_BASE_URL ?? "http://127.0.0.1:4334",
  folder = resolve(
    process.env.TUTOR_ACCEPTANCE_DIR ?? "runs/product-acceptance",
  );
await mkdir(folder, { recursive: true });
const report: any =
  process.env.TUTOR_ACCEPTANCE_RESUME === "1"
    ? JSON.parse(await readFile(folder + "/report.json", "utf8"))
    : {
        startedAt: new Date().toISOString(),
        status: "running",
        cases: [],
        maxCases: 8,
        scope:
          "两篇普通导入论文、讲解、四类设计草案；不含内部迭代、国内模型和真人效果。",
      };
let providerBlocked = false;
report.status = "running";
async function checkpoint() {
  await writeFile(folder + "/report.json", JSON.stringify(report, null, 2));
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    base + path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function waitFor<T extends { status: string }>(path: string): Promise<T> {
  const end = Date.now() + 600_000;
  while (Date.now() < end) {
    const r = await api<T>(path);
    if (
      [
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "clarification",
        "conflict",
      ].includes(r.status)
    )
      return r;
    await new Promise((r) => setTimeout(r, 1500));
  }
  await api(path + "/cancel", {});
  throw new Error("核验等待超时，已请求取消本次任务；记录保留，不自动重发。");
}
async function record(name: string, work: (item: any) => Promise<void>) {
  if (report.cases.some((c: any) => c.name === name && c.status === "passed"))
    return;
  const item: any = {
    name,
    status: providerBlocked ? "not-run" : "running",
    startedAt: new Date().toISOString(),
  };
  report.cases.push(item);
  await checkpoint();
  if (providerBlocked) {
    item.error = "模型额度不足，本案例未发起。";
    await checkpoint();
    return;
  }
  console.log("start", name);
  try {
    await work(item);
    item.status = "passed";
  } catch (e) {
    item.status = "failed";
    item.error = String(e);
    if (/usage limit|quota|额度/i.test(item.error)) providerBlocked = true;
  }
  item.endedAt = new Date().toISOString();
  await checkpoint();
  console.log("end", name, item.status, item.error ?? "");
}
async function importPaper(path: string, name: string) {
  const form = new FormData();
  form.append(
    "pdf",
    new Blob([await readFile(path)], { type: "application/pdf" }),
    name,
  );
  const r = await fetch(base + "/api/papers", { method: "POST", body: form });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<PaperBundle>;
}
const paths = [
  process.env.TUTOR_ACCEPTANCE_PDF_A ??
    "data/papers/Xu_2018_Senolytics/Xu_2018_NatureMedicine_Senolytics_fulltext.pdf",
  process.env.TUTOR_ACCEPTANCE_PDF_B,
];
if (!paths[1])
  throw new Error("TUTOR_ACCEPTANCE_PDF_B 必须指定第二篇真实普通导入论文。");
const existing =
  process.env.TUTOR_ACCEPTANCE_RESUME === "1"
    ? await api<{ papers: PaperBundle[] }>("/api/workspace")
    : undefined;
const papers: PaperBundle[] = existing
  ? report.papers.map((p: any) => {
      const paper = existing.papers.find((s) => s.id === p.id);
      if (!paper)
        throw new Error(`原验收论文 ${p.id} 不存在，不重新上传替代。`);
      return paper;
    })
  : await Promise.all(
      paths.map((p, i) => importPaper(p!, `acceptance-paper-${i + 1}.pdf`)),
    );
report.papers = papers.map((p) => ({
  id: p.id,
  version: p.version,
  pages: p.pageCount,
  figures: p.sources
    .filter((s) => s.image)
    .map((s) => ({
      id: s.id,
      page: s.page,
      figure: s.figure,
      region: s.imageRegion,
    })),
}));
await checkpoint();
async function paperCases() {
  for (const [i, paper] of papers.entries()) {
    await record(`paper-${i + 1}-ppt`, async (item) => {
      const chat = await api<any>("/api/conversations", { paperId: paper.id });
      item.conversationId = chat.id;
      item.paperId = paper.id;
      const t = await api<AssistantTurn>(
        `/api/conversations/${chat.id}/messages`,
        {
          clientMessageId: crypto.randomUUID(),
          mode: "live",
          module: "ppt",
          paperId: paper.id,
          slideCount: 6,
          speechScript: i === 0,
          question:
            "根据论文生成六页可实际汇报的中文 PPT。按研究类型组织问题、方法、主要证据和局限，证据页选用提供的对应图件，图文互相说明，文字简短。不把材料解析或产品核对状态写成汇报正文。",
        },
      );
      item.turnId = t.id;
      const done = await waitFor<AssistantTurn>(`/api/turns/${t.id}`);
      item.calls = done.budget.attempts.length;
      item.providerMs = done.budget.attempts.reduce(
        (n, a) => n + a.durationMs,
        0,
      );
      item.tokens = done.budget.attempts.reduce(
        (n, a) => n + (a.tokens.total ?? 0),
        0,
      );
      if (done.status !== "completed")
        throw new Error(done.error ?? done.reply?.nextStep ?? done.status);
      const versions = await api<DeckVersion[]>(
          `/api/deck-versions?conversationId=${chat.id}&paperId=${paper.id}`,
        ),
        v = versions.at(-1)!;
      item.versionId = v.id;
      if (!v.outline.slides.some((s) => s.imageSource))
        throw new Error("真实生成没有采用已有图件。");
      await writeFile(
        folder + `/paper-${i + 1}-deck.json`,
        JSON.stringify(v, null, 2),
      );
      const out = await api<any>(`/api/deck-versions/${v.id}/export`, {
        conversationId: chat.id,
      });
      const response = await fetch(base + out.url);
      if (!response.ok) throw new Error(await response.text());
      await writeFile(
        folder + `/paper-${i + 1}.pptx`,
        new Uint8Array(await response.arrayBuffer()),
      );
      if (i === 0) {
        const speech = await fetch(
          base +
            `/api/deck-versions/${v.id}/speech?conversationId=${chat.id}&format=md`,
        );
        if (!speech.ok) throw new Error(await speech.text());
        await writeFile(folder + "/speech.md", await speech.text());
      }
      item.slides = v.outline.slides.length;
      item.figureSlides = v.outline.slides
        .filter((s) => s.imageSource)
        .map((s) => ({ title: s.title, source: s.imageSource }));
    });
    await record(`paper-${i + 1}-explain`, async (item) => {
      const chat = await api<any>("/api/conversations", { paperId: paper.id });
      item.conversationId = chat.id;
      item.paperId = paper.id;
      const t = await api<AssistantTurn>(
        `/api/conversations/${chat.id}/messages`,
        {
          clientMessageId: crypto.randomUUID(),
          mode: "live",
          module: "paper",
          paperId: paper.id,
          question:
            "解释这篇论文研究了什么、怎样比较、证据能说明什么及不能说明什么。区分观察关联与因果，通俗但保留设计理由。",
        },
      );
      item.turnId = t.id;
      const done = await waitFor<AssistantTurn>(`/api/turns/${t.id}`);
      item.calls = done.budget.attempts.length;
      item.providerMs = done.budget.attempts.reduce(
        (n, a) => n + a.durationMs,
        0,
      );
      if (done.status !== "completed" || !done.reply?.content)
        throw new Error(done.error ?? done.reply?.nextStep ?? done.status);
      await writeFile(
        folder + `/paper-${i + 1}-explanation.json`,
        JSON.stringify(done.reply.content, null, 2),
      );
    });
  }
}
async function planCases() {
  const topics = [
    [
      "basic-translational",
      "某细胞刺激后蛋白测量信号升高，如何区分测量伪影、细胞数量变化和目标表达变化？",
      "设备、效应量与变异未知；给设计草案，不编样本量或操作浓度。",
    ],
    [
      "clinical-observational",
      "房颤患者开始运动后心血管事件风险是否更低，如何用现有病历提出观察性研究设计？",
      "仅有回顾性病历，运动资料完整度未知，不能证明因果。",
    ],
    [
      "clinical-interventional",
      "给术后患者增加简短线上康复指导是否改善生活质量，如何提出一个可行的干预研究草案？",
      "拟开展、伦理和招募都尚未完成，依从性和资源未知；不替代实际临床决策。",
    ],
    [
      "secondary-research",
      "如何设计系统综述比较运动干预对成年人血压的影响？",
      "还没检索，没有纳入研究；不编数量、检索结果或合并效应。",
    ],
  ];
  for (const [type, question, conditions] of topics)
    await record(`plan-${type}`, async (item) => {
      const p = await api<ResearchPlan>("/api/research-plans", {
        question,
        conditions,
        studyTypes: [type],
        typeStatus: "provisional",
      });
      item.planId = p.id;
      const j = await api<PlanJob>(`/api/research-plans/${p.id}/jobs`, {
        requestKey: crypto.randomUUID(),
        expectedVersion: p.currentVersion,
        expectedTopicVersion: p.topic.version,
        action: "generate",
        requestedScope: "design-draft",
        instruction:
          "写可理解、可修改的设计草案。必要条件保留为未知，简洁说明设计理由；不把建议写成已完成结果。",
        maxCalls: 2,
      });
      item.jobId = j.id;
      const done = await waitFor<PlanJob>(`/api/research-plan-jobs/${j.id}`);
      item.calls = done.budget.attempts.length;
      item.providerMs = done.budget.attempts.reduce(
        (n, a) => n + a.durationMs,
        0,
      );
      if (done.status !== "completed" || !done.resultVersion)
        throw new Error(done.error ?? done.status);
      const response = await fetch(
        base + `/api/research-plans/${p.id}/exports/${done.resultVersion}`,
      );
      if (!response.ok) throw new Error(await response.text());
      await writeFile(folder + `/plan-${type}.md`, await response.text());
    });
}
await Promise.all([paperCases(), planCases()]);
report.status = [
  ...new Map(report.cases.map((c: any) => [c.name, c])).values(),
].every((c: any) => c.status === "passed")
  ? "passed"
  : "failed";
report.modelCalls = report.cases.reduce(
  (n: number, c: any) => n + (c.calls ?? 0),
  0,
);
report.endedAt = new Date().toISOString();
await checkpoint();
console.log(
  JSON.stringify(
    {
      status: report.status,
      modelCalls: report.modelCalls,
      cases: report.cases.map((c: any) => ({
        name: c.name,
        status: c.status,
        calls: c.calls,
        error: c.error,
      })),
    },
    null,
    2,
  ),
);
if (report.status === "failed") process.exitCode = 1;
