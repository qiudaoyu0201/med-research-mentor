import express from "express";
import multer from "multer";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createServer as createVite } from "vite";
import { z } from "zod";
import { sample, profiles, defaultDeck } from "../examples/bundle.ts";
import type { PaperBundle, TaskRun } from "../shared/types.ts";
import { root, save, read, list, remove, safeId } from "./storage.ts";
import {
  inputSchema,
  deckSchema,
  conversationSchema,
  messageSchema,
  preferencesSchema,
} from "./schemas.ts";
import { legacyDepth, legacyPreferences } from "../shared/learning-intent.ts";
import { createProvider } from "./model-config.ts";
import {
  TaskManager,
  materialSources,
  validateRunSurface,
} from "./orchestrator.ts";
import { parsePdf } from "./pdf.ts";
import { localSample, samplePdf } from "./sample.ts";
import { exportDeck, exportNotes } from "./export.ts";
import { allSkills } from "./skills.ts";
import { replay, decideRevision } from "./replay.ts";
import { AssistantService } from "./assistant.ts";
import { ConversationStore } from "./conversation.ts";
import { ResultCache } from "./cache.ts";
import { foundationCatalog, withFoundationSources } from "./foundations.ts";
import { registerFigureEvidence } from "./paper-assets.ts";
import { DeckVersions } from "./deck-versions.ts";
import { digest } from "./materials.ts";
import { LearningRecords } from "./learning-records.ts";
import { Projects } from "./projects.ts";
import { PaperImports } from "./paper-imports.ts";
import { Attachments } from "./attachments.ts";
import { attachmentLimits } from "../shared/attachments.ts";
import { taskKey } from "./scheduler.ts";
import { ReadingGuides } from "./reading-guides.ts";
import { ResearchPlans } from "./research-plans.ts";
import { researchId } from "./research-plan-schemas.ts";

const app = express(),
  port = Number(process.env.PORT || 4317),
  provider = createProvider(),
  manager = new TaskManager(provider);
let replayController: AbortController | undefined;
const loadedSample = withFoundationSources(await localSample());
await mkdir(join(root, "uploads"), { recursive: true });
for (const run of await list<TaskRun>("runs")) {
  if (
    !["completed", "failed", "cancelled", "interrupted"].includes(run.status)
  ) {
    run.status = "interrupted";
    run.error = "后台重启中断了任务，未自动重发。";
    for (const attempt of run.budget?.attempts ?? [])
      if (attempt.status === "reserved") attempt.status = "unknown";
    await save("runs", run.id, run);
  }
  manager.runs.set(run.id, run);
}
app.disable("x-powered-by");
app.use((req, res, next) => {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(req.headers.host || ""))
    return res.status(403).json({ error: "仅允许本机访问" });
  const origin = req.headers.origin;
  if (
    origin &&
    !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(origin)
  )
    return res.status(403).json({ error: "来源不受支持" });
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json({ limit: "5mb" }));
app.get("/api/health", (_req, res) =>
  res.json({ app: "medical-research-tutor", version: "0.1.0" }),
);
const upload = multer({
  storage: multer.diskStorage({
    destination: join(root, "uploads"),
    filename: (_req, _file, cb) => cb(null, randomUUID() + ".pdf"),
  }),
  limits: { fileSize: 30 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!/\.pdf$/i.test(file.originalname))
      return callback(new Error("此入口用于导入 PDF；图片请在输入区添加。"));
    callback(null, true);
  },
});
const attachments = new Attachments(provider);
await attachments.restore();
const basePaperById = async (id: string) =>
  id === "foundation-only"
    ? {
        id,
        title: "独立基础课程",
        version: foundationCatalog.version,
        scope: "独立基础资料；未绑定论文。",
        sources: [],
      }
    : id === sample.id
      ? structuredClone(loadedSample)
      : read<PaperBundle>("papers", id);
const paperById = async (id: string): Promise<PaperBundle> => {
  const paper = await basePaperById(id);
  return {
    ...paper,
    sources: [
      ...paper.sources.filter((s) => !s.attachmentId),
      ...attachments.sources(id, undefined, paper.version),
    ],
  };
};
const deckVersions = new DeckVersions(provider, paperById);
await deckVersions.restoreDisk();
const assistant = new AssistantService(
  provider,
  manager,
  new ConversationStore(),
  paperById,
  save,
  new ResultCache(),
  exportDeck,
  deckVersions,
  undefined,
  attachments,
);
const readingGuides = new ReadingGuides(provider, assistant.scheduler);
await readingGuides.restore();
await assistant.restore();
const researchPlans = new ResearchPlans(
  provider,
  paperById,
  assistant.scheduler,
);
await researchPlans.restore();
app.get("/api/research-plans", (_req, res) => res.json(researchPlans.all()));
app.post("/api/research-plans", async (req, res) =>
  res.status(201).json(await researchPlans.create(req.body)),
);
app.get("/api/research-plans/:id", (req, res) =>
  res.json(researchPlans.get(req.params.id)),
);
app.put("/api/research-plans/:id/topic", async (req, res) => {
  const body = z
    .object({ expectedTopicVersion: researchId, topic: z.unknown() })
    .strict()
    .parse(req.body);
  res.json(
    await researchPlans.updateTopic(
      req.params.id,
      body.expectedTopicVersion,
      body.topic,
    ),
  );
});
app.post("/api/research-plans/:id/versions", async (req, res) =>
  res.json(await researchPlans.saveVersion(req.params.id, req.body)),
);
app.post("/api/research-plans/:id/restore", async (req, res) => {
  const body = z
    .object({
      versionId: researchId,
      expectedVersion: researchId.nullable(),
      expectedTopicVersion: researchId,
    })
    .strict()
    .parse(req.body);
  res.json(
    await researchPlans.restoreVersion(
      req.params.id,
      body.versionId,
      body.expectedVersion,
      body.expectedTopicVersion,
    ),
  );
});
app.get("/api/research-plans/:id/jobs", (req, res) =>
  res.json(researchPlans.planJobs(req.params.id)),
);
app.post("/api/research-plans/:id/jobs", async (req, res) =>
  res.status(202).json(await researchPlans.start(req.params.id, req.body)),
);
app.get("/api/research-plan-jobs/:id", (req, res) =>
  res.json(researchPlans.job(req.params.id)),
);
app.post("/api/research-plan-jobs/:id/cancel", async (req, res) =>
  res.json(await researchPlans.cancel(req.params.id)),
);
app.post("/api/research-plan-jobs/:id/resume-review", async (req, res) =>
  res.json(await researchPlans.resumeReview(req.params.id)),
);
app.patch("/api/research-plans/:id", async (req, res) => {
  const body = z.object({ archived: z.boolean() }).strict().parse(req.body);
  res.json(await researchPlans.archive(req.params.id, body.archived));
});
app.delete("/api/research-plans/:id", async (req, res) => {
  await researchPlans.delete(req.params.id);
  res.json({ ok: true });
});
app.get("/api/research-plans/:id/exports/:versionId", (req, res) => {
  const markdown = researchPlans.exportMarkdown(
    req.params.id,
    researchId.parse(req.params.versionId),
  );
  res
    .type("text/markdown; charset=utf-8")
    .setHeader(
      "Content-Disposition",
      `attachment; filename="research-plan-${req.params.versionId}.md"`,
    )
    .send(markdown);
});
const imports = new PaperImports();
const projects = new Projects();
await projects.restore();
const entityId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const nameInput = z.string().trim().min(1).max(120);
app.get("/api/display-assets/:id", async (req, res) => {
  const asset = await read<{ image: string }>(
    "display-assets",
    entityId.parse(req.params.id),
  );
  res
    .type(asset.image.startsWith("data:image/png") ? "image/png" : "image/jpeg")
    .setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.send(Buffer.from(asset.image.split(",")[1], "base64"));
});
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: attachmentLimits.imageBytes, files: 1 },
});
app.post(
  "/api/conversations/:id/attachments",
  imageUpload.single("image"),
  async (req, res) => {
    const state = assistant.conversations.get(entityId.parse(req.params.id));
    if (!req.file) throw new Error("请选择要发送的图片。");
    const id = entityId.parse(req.body.attachmentId);
    const name = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    res
      .status(201)
      .json(
        await attachments.upload(
          id,
          state.id,
          state.paperId,
          name,
          req.file.buffer,
        ),
      );
  },
);
app.post("/api/turns/:id/attachments/:attachmentId/retry", async (req, res) => {
  const body = z
    .object({ purpose: z.string().max(1000).optional() })
    .parse(req.body);
  res
    .status(202)
    .json(
      await assistant.retryAttachment(
        req.params.id,
        req.params.attachmentId,
        body.purpose,
      ),
    );
});
app.get(
  "/api/conversations/:id/attachments/:attachmentId/original",
  async (req, res) => {
    const state = assistant.conversations.get(entityId.parse(req.params.id));
    const record = attachments.get(
      entityId.parse(req.params.attachmentId),
      state.id,
    );
    if (!record.originalUrl || !record.originalMime)
      return res.status(404).json({ error: "原件缺失，请补充清晰图片。" });
    const original = await read<{ base64: string }>(
      "attachment-originals",
      record.id,
    );
    res
      .type(record.originalMime)
      .setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(Buffer.from(original.base64, "base64"));
  },
);
app.get("/api/workspace", async (_req, res) => {
  const papers = await Promise.all(
    [loadedSample, ...(await list<PaperBundle>("papers"))].map((p) =>
      paperById(p.id),
    ),
  );
  const index = projects.snapshot();
  index.positions = index.positions.map((p) =>
    projects.validatePosition(
      p,
      papers.find((paper) => paper.id === p.paperId),
    ),
  );
  res.json({
    index,
    papers,
    conversations: [...assistant.conversations.states.values()],
  });
});
app.post("/api/projects", async (req, res) => {
  const body = z
    .object({ name: nameInput, goal: z.string().max(2000).optional() })
    .parse(req.body);
  res.status(201).json(await projects.create(body.name, body.goal));
});
app.patch("/api/projects/:id", async (req, res) => {
  const body = z
    .object({
      name: nameInput.optional(),
      goal: z.string().max(2000).optional(),
      archived: z.boolean().optional(),
    })
    .parse(req.body);
  res.json(await projects.edit(safeId(req.params.id), body));
});
app.patch("/api/papers/:id/metadata", async (req, res) => {
  await paperById(req.params.id);
  const body = z
    .object({
      projectId: entityId.nullable().optional(),
      displayName: nameInput.optional(),
    })
    .parse(req.body);
  res.json(await projects.paper(req.params.id, body));
});
app.post("/api/papers/:id/chat", async (req, res) => {
  await paperById(req.params.id);
  const owner =
    projects.snapshot().papers.find((p) => p.paperId === req.params.id)
      ?.projectId ?? null;
  res.json(await assistant.conversations.mainForPaper(req.params.id, owner));
});
app.get("/api/papers/:id/start", async (req, res) => {
  const guide = readingGuides.get(await paperById(req.params.id));
  res.json({
    ...guide,
    autoGenerate:
      process.env.TUTOR_READING_GUIDES !== "manual" &&
      !guide.status &&
      Boolean(guide.excerpt),
  });
});
app.post("/api/papers/:id/start", async (req, res) => {
  const body = z.object({ automatic: z.boolean().optional() }).parse(req.body);
  const paper = await paperById(req.params.id);
  if (body.automatic && process.env.TUTOR_READING_GUIDES === "manual")
    return res.json(readingGuides.get(paper));
  if (body.automatic && assistant.scheduler.has(taskKey(paper.id, "guide")))
    return res.json(readingGuides.get(paper));
  res.status(202).json(await readingGuides.start(paper));
});
app.post("/api/papers/:id/start/cancel", (req, res) => {
  readingGuides.cancel(req.params.id);
  res.json({ ok: true });
});
app.patch("/api/conversations/:id/title", async (req, res) => {
  const body = z
    .object({ title: nameInput, version: z.number().int().min(0) })
    .parse(req.body);
  const state = assistant.conversations.get(req.params.id);
  state.title = body.title;
  state.titleEdited = true;
  res.json(
    await assistant.conversations.update(state.id, (current) => {
      current.title = body.title;
      current.titleEdited = true;
      return current;
    }),
  );
});
app.put("/api/workspace/position", async (req, res) => {
  const body = z
    .object({
      conversationId: entityId,
      paperId: entityId.nullable(),
      sourceVersion: z.string().max(200).optional(),
      sourceId: entityId.optional(),
      panel: z.enum(["sources", "notes"]).nullable(),
    })
    .parse(req.body);
  const state = assistant.conversations.get(body.conversationId);
  res.json(
    await projects.position(
      state,
      state.paperId ? await paperById(state.paperId) : undefined,
      body,
    ),
  );
});
app.put("/api/workspace/context", async (req, res) => {
  const body = z
    .object({ paperId: entityId.nullable(), projectId: entityId.nullable() })
    .parse(req.body);
  if (body.paperId) await paperById(body.paperId);
  res.json(await projects.context(body.paperId, body.projectId));
});
app.post("/api/workspace/notes", async (req, res) => {
  const body = z
    .object({ conversationId: entityId, turnId: entityId })
    .parse(req.body);
  const state = assistant.conversations.get(body.conversationId);
  const turn = assistant.turns.get(body.turnId);
  if (!turn) throw new Error("回答不存在。");
  res
    .status(201)
    .json(
      await projects.saveAnswer(
        state,
        { ...turn, run: turn.runId ? manager.runs.get(turn.runId) : undefined },
        state.paperId ? await paperById(state.paperId) : undefined,
      ),
    );
});
app.patch("/api/workspace/notes/:id", async (req, res) => {
  const body = z
    .object({
      title: nameInput,
      text: z.string().trim().min(1).max(50_000),
      updatedAt: z.string().min(1),
    })
    .parse(req.body);
  res.json(await projects.editNote(safeId(req.params.id), body));
});
app.post("/api/workspace/notes/manual", async (req, res) => {
  const body = z
    .object({
      conversationId: entityId,
      id: entityId,
      title: nameInput.default("我的笔记"),
      text: z.string().trim().min(1).max(50_000),
    })
    .strict()
    .parse(req.body);
  const state = assistant.conversations.get(body.conversationId);
  res.status(201).json(await projects.createNote(state, body));
});
const learningRecords = new LearningRecords(assistant.conversations, (id) =>
  manager.runs.get(id),
);
const recordInput = z.object({
  version: z.number().int().min(0),
  kind: z.enum(["favorite", "feedback", "question"]),
  unitId: z.string().optional(),
  sectionIndex: z.number().int().min(0).max(9).optional(),
  text: z.string().min(1).max(4000).optional(),
  feedback: z.enum(["read", "confused", "understood"]).optional(),
});
const recordVersion = z.object({
  version: z.number().int().min(0),
  recordVersion: z.number().int().min(0),
});
const recordPatch = recordVersion.extend({
  text: z.string().min(1).max(4000).optional(),
  feedback: z.enum(["read", "confused", "understood"]).optional(),
  resolved: z.boolean().optional(),
});
function recordsIdle(conversationId: string) {
  const state = assistant.conversations.get(conversationId);
  if (assistant.scheduler.has(taskKey(state.paperId, state.id)))
    throw new Error("请等待当前请求保存完成后记录反馈。");
}
app.post("/api/conversations/:id/records", async (req, res) => {
  recordsIdle(req.params.id);
  const body = recordInput.parse(req.body);
  res.json(await learningRecords.create(req.params.id, body.version, body));
});
app.put("/api/conversations/:id/records/:recordId", async (req, res) => {
  recordsIdle(req.params.id);
  const body = recordPatch.parse(req.body);
  res.json(
    await learningRecords.edit(
      req.params.id,
      body.version,
      req.params.recordId,
      body.recordVersion,
      body,
    ),
  );
});
app.post("/api/conversations/:id/records/:recordId/undo", async (req, res) => {
  recordsIdle(req.params.id);
  const body = recordVersion.parse(req.body);
  res.json(
    await learningRecords.undo(
      req.params.id,
      body.version,
      req.params.recordId,
      body.recordVersion,
    ),
  );
});
app.delete("/api/conversations/:id/records/:recordId", async (req, res) => {
  recordsIdle(req.params.id);
  const body = recordVersion.parse(req.body);
  res.json(
    await learningRecords.delete(
      req.params.id,
      body.version,
      req.params.recordId,
      body.recordVersion,
    ),
  );
});
app.post("/api/conversations", async (req, res) => {
  const input = conversationSchema.parse(req.body);
  if (input.paperId) await paperById(input.paperId);
  if (input.projectId) projects.project(input.projectId);
  res.status(201).json(await assistant.conversations.create(input));
});
app.get("/api/conversations", (_req, res) => {
  res.json(
    [...assistant.conversations.states.values()].map((state) => ({
      ...state,
      goal: state.goal,
    })),
  );
});
app.get("/api/conversations/:id/turns", (req, res) => {
  const state = assistant.conversations.get(req.params.id);
  res.json(
    state.recentTurnIds
      .map((id) => assistant.turns.get(id))
      .filter(Boolean)
      .map((turn) => ({
        ...turn,
        run: turn?.runId ? manager.runs.get(turn.runId) : undefined,
      })),
  );
});
app.get("/api/conversations/:id", (req, res) => {
  res.json(assistant.conversations.get(req.params.id));
});
app.put("/api/conversations/:id/progress", async (req, res) => {
  recordsIdle(req.params.id);
  const body = z
    .object({
      version: z.number().int().min(0),
      unitId: z.string(),
      state: z.enum(["read", "confused", "understood"]),
    })
    .parse(req.body);
  const state = assistant.conversations.get(req.params.id);
  const run = manager.runs.get(body.unitId);
  if (
    !run ||
    run.input.conversationId !== state.id ||
    run.status !== "completed"
  )
    throw new Error("学习单元未在本会话交付。");
  res.json(
    await learningRecords.create(state.id, body.version, {
      kind: "feedback",
      unitId: body.unitId,
      feedback: body.state,
    }),
  );
});
app.post("/api/conversations/:id/messages", async (req, res) => {
  assistant.conversations.get(req.params.id);
  readingGuides.cancelAll();
  if (replayController) throw new Error("开发回放运行中，请先取消或等待。");
  res
    .status(202)
    .json(await assistant.submit(req.params.id, messageSchema.parse(req.body)));
});
app.get("/api/turns/:id", (req, res) => {
  const turn = assistant.turns.get(req.params.id);
  if (!turn) return res.status(404).json({ error: "轮次不存在" });
  res.json({
    ...turn,
    run: turn.runId ? manager.runs.get(turn.runId) : undefined,
  });
});
app.post("/api/turns/:id/cancel", async (req, res) => {
  await assistant.cancel(req.params.id);
  res.json({ ok: true, turn: assistant.turns.get(req.params.id) });
});
app.get("/api/bootstrap", async (_req, res) =>
  res.json({
    sample: loadedSample,
    profiles,
    defaultDeck,
    papers: await list<PaperBundle>("papers"),
    runs: [...manager.runs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
    skills: await allSkills(),
    revisions: await list("revisions"),
  }),
);
app.get("/api/model", async (_req, res) => {
  try {
    res.json(await provider.inspect());
  } catch {
    res.json({
      authenticated: false,
      model: provider.model,
      error: "Codex 本地连接不可用；检查 CODEX_BIN 和登录状态。",
    });
  }
});
app.post("/api/papers", upload.single("pdf"), async (req, res) => {
  if (!req.file) throw new Error("请选择 PDF");
  try {
    const signature = await readFile(req.file.path);
    if (signature.subarray(0, 1024).indexOf("%PDF-") < 0)
      throw new Error("文件内容不是 PDF，请提供真正的 PDF 文件。");
  } catch (error) {
    await rm(req.file.path, { force: true });
    throw error;
  }
  try {
    const importId = entityId.parse(req.headers["x-import-id"] ?? randomUUID());
    const hash = createHash("sha256")
      .update(await readFile(req.file.path))
      .digest("hex");
    const path = req.file.path;
    const filename = Buffer.from(req.file.originalname, "latin1").toString(
      "utf8",
    );
    const result = await imports.run(importId, hash, async (id) => {
      let paper: PaperBundle;
      let parseError: string | undefined;
      try {
        paper = await parsePdf(path, id, filename);
      } catch (error) {
        parseError = error instanceof Error ? error.message : "PDF 解析失败";
        paper = {
          id,
          title: filename,
          version: "failed-upload",
          scope: "原文件已保留，请补充原文。",
          pdfUrl: `/api/papers/${id}/pdf`,
          sources: [],
          parseStatus: "failed",
        };
      }
      await rename(path, join(root, "uploads", id + ".pdf"));
      await save("papers", id, paper);
      return { paper, ...(parseError ? { error: parseError } : {}) };
    });
    await assistant.conversations.mainForPaper(result.paper.id);
    res
      .status(result.error ? 422 : 201)
      .json(result.error ? result : result.paper);
  } finally {
    await rm(req.file.path, { force: true });
  }
});
app.get("/api/papers/:id/pdf", async (req, res) => {
  safeId(req.params.id);
  if (req.params.id === sample.id && loadedSample.pdfUrl)
    return res.type("application/pdf").sendFile(samplePdf);
  res
    .type("application/pdf")
    .sendFile(resolve(root, "uploads", req.params.id + ".pdf"));
});
app.post("/api/papers/:id/text", async (req, res) => {
  if (req.params.id === sample.id)
    throw new Error("示例证据只读；请在上传资料中补充文本。");
  const paper = await basePaperById(req.params.id);
  const body = z
    .object({
      text: z.string().min(1).max(20_000),
      page: z
        .number()
        .int()
        .min(1)
        .max(paper.pageCount || 100),
      title: z.string().max(100),
      section: z.enum(["results", "methods", "overview"]).optional(),
      relatedFigures: z.array(z.string().regex(/^\d+$/)).max(4).optional(),
    })
    .parse(req.body);
  const source = {
    id: `${paper.id}-manual-${randomUUID()}`,
    title: body.title || "补充原文",
    kind: "paper" as const,
    text: body.text,
    page: body.page,
    locator: `用户补充：PDF 第 ${body.page} 页，未核对`,
    verified: false,
    section: body.section,
    relatedFigures: body.relatedFigures,
  };
  paper.sources.push(source);
  paper.version = `manual-${source.id}`;
  paper.parseStatus = "ready";
  await save("papers", paper.id, paper);
  res.json(paper);
});
app.post("/api/papers/:id/evidence", async (req, res) => {
  safeId(req.params.id);
  if (req.params.id === sample.id)
    throw new Error("示例证据只读，请在上传论文中登记。");
  const range = z.object({
    page: z.number().int().min(1).max(100),
    start: z.string().min(1).max(400),
    end: z.string().min(1).max(400),
  });
  const spec = z
    .object({
      number: z.string().regex(/^\d{1,3}$/),
      page: z.number().int().min(1).max(100),
      results: z.array(range).min(1).max(8),
      methods: z.array(range).min(1).max(8),
    })
    .parse(req.body);
  const paper = await registerFigureEvidence(
    await basePaperById(req.params.id),
    resolve(root, "uploads", req.params.id + ".pdf"),
    spec,
  );
  await save("papers", paper.id, paper);
  res.json(paper);
});
app.post("/api/papers/:id/figure", async (req, res) => {
  if (req.params.id === sample.id)
    throw new Error("请先上传原始 PDF，再保存圈选图件。");
  const paper = await basePaperById(req.params.id);
  const body = z
    .object({
      image: z
        .string()
        .regex(/^data:image\/(png|jpeg);base64,/)
        .max(3_000_000),
      page: z
        .number()
        .int()
        .min(1)
        .max(paper.pageCount || 100),
      caption: z.string().min(1).max(10_000),
    })
    .parse(req.body);
  paper.sources.push({
    id: `${paper.id}-figure-${randomUUID()}`,
    title: "手动圈选图件",
    kind: "paper",
    page: body.page,
    figure: "用户圈选",
    locator: `PDF 第 ${body.page} 页，用户圈选区域及补充图注`,
    text: body.caption,
    caption: body.caption,
    image: body.image,
    verified: false,
  });
  paper.version = `figure-${Date.now()}`;
  await save("papers", paper.id, paper);
  res.json(paper);
});
app.post("/api/tasks", async (req, res) => {
  if (replayController) throw new Error("开发回放运行中，请先取消或等待。");
  const input = inputSchema.parse(req.body);
  const paper = await paperById(input.paperId);
  if (
    input.sourceIds.some(
      (id) =>
        !paper.sources.some((s) => s.id === id) &&
        !foundationCatalog.all().some((s) => s.id === id),
    )
  )
    throw new Error("所选来源不存在");
  res.status(201).json(await assistant.legacy(input));
});
app.get("/api/tasks/:id", (req, res) => {
  const run = manager.runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "记录不存在" });
  res.json(run);
});
app.post("/api/tasks/:id/cancel", async (req, res) => {
  const turnId = manager.runs.get(req.params.id)?.input.turnId;
  if (turnId) await assistant.cancel(turnId);
  else await manager.cancel(req.params.id);
  res.json({ ok: true });
});
app.delete("/api/tasks/:id", async (req, res) => {
  if (manager.active === req.params.id) throw new Error("请先取消运行中的任务");
  await remove("runs", req.params.id);
  manager.runs.delete(req.params.id);
  res.json({ ok: true });
});
app.get("/api/tasks/:id/notes", (req, res) => {
  const run = manager.runs.get(req.params.id);
  if (!run) throw new Error("记录不存在");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="learning-notes.md"',
  );
  res.type("text/markdown").send(exportNotes(run));
});
app.put("/api/session", async (req, res) => {
  const body = z
    .object({
      paperId: z.string(),
      page: z.number().int().min(1).max(100),
      module: z.enum(["paper", "method", "figure", "ppt"]),
      bookmarks: z.array(z.string().max(200)).max(100),
      progress: z
        .array(
          z.object({
            unitId: z.string(),
            state: z.enum(["read", "confused", "understood"]),
          }),
        )
        .max(300),
    })
    .parse(req.body);
  await save("sessions", "current", body);
  if (!assistant.busy && assistant.conversations.states.has("legacy-current")) {
    const conversation = assistant.conversations.get("legacy-current");
    conversation.userProgress = body.progress.filter(
      (p) =>
        manager.runs.get(p.unitId)?.input.conversationId === conversation.id,
    );
    await assistant.conversations.put(conversation, conversation.version);
  }
  res.json({ ok: true });
});
app.get("/api/session", async (_req, res) => {
  try {
    res.json(await read("sessions", "current"));
  } catch {
    res.json(null);
  }
});
app.put("/api/outlines/:id", async (req, res) => {
  await save("outlines", safeId(req.params.id), deckSchema.parse(req.body));
  res.json({ ok: true });
});
app.get("/api/outlines/:id", async (req, res) => {
  try {
    res.json(await read("outlines", req.params.id));
  } catch {
    res.json(null);
  }
});
app.post("/api/decks", async (req, res) => {
  const body = z
    .object({
      paperId: z.string(),
      runId: z.string().optional(),
      outline: deckSchema,
    })
    .parse(req.body);
  let paper = withFoundationSources(await paperById(body.paperId));
  if (body.runId) {
    const run = manager.runs.get(body.runId);
    if (
      !run ||
      run.status !== "completed" ||
      !run.deck ||
      !run.result ||
      run.input.paperId !== paper.id ||
      run.sourceVersion !== paper.version
    )
      throw new Error("汇报内容尚未完成核对");
    paper = { ...paper, sources: materialSources(run, paper) };
    if (digest(body.outline) !== digest(run.deck))
      throw new Error("编辑后的页面请先保存新版本并核对，再导出。");
    validateRunSurface(run, run.result, body.outline, paper.sources);
  } else if (paper.id !== sample.id)
    throw new Error("上传论文请先生成并核对汇报内容");
  else if (digest(body.outline) !== digest(defaultDeck))
    throw new Error("编辑后的示例请先保存新版本并核对。");
  const id = randomUUID();
  await exportDeck(body.outline, paper, id);
  res.json({
    url: `/api/decks/${id}`,
    id,
    note: "按保存版本导出；固定示例不代表全文核验。",
  });
});
app.get("/api/deck-versions", (req, res) => {
  const conversationId = safeId(String(req.query.conversationId));
  assistant.conversations.get(conversationId);
  res.json(
    [...deckVersions.versions.values()].filter(
      (v) =>
        v.conversationId === conversationId &&
        (!req.query.paperId || v.paperId === req.query.paperId),
    ),
  );
});
app.post("/api/deck-versions", async (req, res) => {
  const body = z
    .object({
      conversationId: z.string(),
      paperId: z.string(),
      runId: z.string().optional(),
    })
    .parse(req.body);
  recordsIdle(body.conversationId);
  const state = assistant.conversations.get(body.conversationId);
  const run = body.runId ? manager.runs.get(body.runId) : undefined;
  if (body.runId && !run) throw new Error("汇报记录不存在。");
  const version = await deckVersions.seed(
    body.conversationId,
    body.paperId,
    run,
  );
  state.paperId = body.paperId;
  state.sourceVersion = version.sourceVersion;
  state.latestDeckVersionId = version.id;
  await assistant.conversations.put(state, state.version);
  res.status(201).json(version);
});
app.patch("/api/deck-versions/:id/name", async (req, res) => {
  const body = z
    .object({ conversationId: entityId, displayName: nameInput })
    .parse(req.body);
  res.json(
    await deckVersions.rename(
      req.params.id,
      body.conversationId,
      body.displayName,
    ),
  );
});
app.patch("/api/conversations/:id/preferences", async (req, res) => {
  const body = preferencesSchema.parse(req.body);
  res.json(
    await assistant.conversations.update(req.params.id, (state) => {
      const learningPreferences = {
        ...(state.learningPreferences ??
          legacyPreferences(state.explanationDepth)),
        ...(body.explanationDepth
          ? legacyPreferences(body.explanationDepth)
          : {}),
        ...body.learningPreferences,
      };
      return {
        ...state,
        ...(body.profileId ? { profileId: body.profileId } : {}),
        learningPreferences,
        explanationDepth: legacyDepth(learningPreferences),
        preferenceRevision: (state.preferenceRevision ?? 0) + 1,
      };
    }),
  );
});
app.get("/api/deck-versions/:id", (req, res) =>
  res.json(deckVersions.get(req.params.id)),
);
app.post("/api/deck-versions/:id/edit", async (req, res) => {
  if (replayController) throw new Error("开发回放运行中，请先取消或等待。");
  const body = z
    .object({
      conversationId: z.string(),
      slideIndex: z.number().int().min(0).max(15),
      question: z.string().min(1).max(2000),
      slide: deckSchema.shape.slides.element.optional(),
    })
    .parse(req.body);
  assistant.conversations.get(body.conversationId);
  readingGuides.cancelAll();
  res
    .status(202)
    .json(await deckVersions.start(req.params.id, body.conversationId, body));
});
app.post("/api/deck-versions/:id/cancel", async (req, res) => {
  await deckVersions.cancel(req.params.id);
  res.json({ ok: true, version: deckVersions.get(req.params.id) });
});
app.post("/api/deck-versions/:id/speech", async (req, res) => {
  if (replayController) throw new Error("开发回放运行中，请先取消或等待。");
  const body = z
    .object({
      conversationId: z.string(),
      question: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .default("根据当前 PPT 补写完整演讲稿"),
      speechScript: deckSchema.shape.speechScript,
    })
    .strict()
    .parse(req.body);
  assistant.conversations.get(body.conversationId);
  readingGuides.cancelAll();
  res.status(202).json(
    await deckVersions.start(req.params.id, body.conversationId, {
      ...body,
      operation: "speech",
    }),
  );
});
app.get("/api/deck-versions/:id/speech", async (req, res) => {
  const format = z.enum(["md", "txt"]).parse(req.query.format ?? "md");
  const text = await deckVersions.speech(
    req.params.id,
    safeId(String(req.query.conversationId)),
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="speech-script.${format}"`,
  );
  res.type(format === "txt" ? "text/plain" : "text/markdown").send(text);
});
app.post("/api/deck-versions/:id/restore", async (req, res) => {
  const body = z
    .object({ conversationId: z.string(), targetId: z.string() })
    .parse(req.body);
  recordsIdle(body.conversationId);
  const version = await deckVersions.restoreVersion(
    req.params.id,
    body.targetId,
    body.conversationId,
  );
  const state = assistant.conversations.get(body.conversationId);
  state.latestDeckVersionId = version.id;
  await assistant.conversations.put(state, state.version);
  res.json(version);
});
app.post("/api/deck-versions/:id/export", async (req, res) => {
  const body = z.object({ conversationId: z.string() }).parse(req.body);
  assistant.conversations.get(body.conversationId);
  const artifact = await deckVersions.export(
    req.params.id,
    body.conversationId,
  );
  await assistant.conversations.update(body.conversationId, (state) => {
    state.artifacts.push({
      id: artifact.id,
      kind: "pptx",
      sourceHash: deckVersions.get(req.params.id).sourceHash,
    });
    return state;
  });
  res.json(artifact);
});
app.post("/api/deck-versions/:id/select", async (req, res) => {
  const body = z.object({ conversationId: z.string() }).parse(req.body);
  const version = deckVersions.get(req.params.id, body.conversationId);
  recordsIdle(body.conversationId);
  const state = assistant.conversations.get(body.conversationId);
  if (
    version.status !== "completed" ||
    version.paperId !== state.paperId ||
    version.sourceVersion !== state.sourceVersion
  )
    throw new Error("不能承接未完成或其他论文的版本。");
  state.latestDeckVersionId = version.id;
  res.json(await assistant.conversations.put(state, state.version));
});
app.get("/api/decks/:id", (req, res) =>
  res.download(
    resolve("exports", safeId(req.params.id) + ".pptx"),
    "医学科研汇报.pptx",
  ),
);
app.post("/api/replays", async (req, res) => {
  const body = z
    .object({
      skillId: z.string(),
      text: z.string().min(20).max(20_000),
      mode: z.enum(["fixture", "live"]),
      caseIds: z.array(z.string()).max(4).optional(),
    })
    .parse(req.body);
  if (
    assistant.busy ||
    manager.active ||
    manager.starting ||
    replayController ||
    deckVersions.busy
  )
    throw new Error("请等待当前任务完成");
  replayController = new AbortController();
  try {
    res.json(await replay(body, provider, replayController.signal));
  } finally {
    replayController = undefined;
  }
});
app.post("/api/replays/cancel", (_req, res) => {
  replayController?.abort();
  res.json({ ok: true });
});
app.post("/api/revisions/:id/decision", async (req, res) => {
  const body = z
    .object({
      decision: z.enum(["keep", "revert"]),
      note: z.string().min(1).max(1000),
    })
    .parse(req.body);
  res.json(await decideRevision(req.params.id, body));
});
if (process.argv.includes("--production")) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const vite = await createVite({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(error.status === 409 ? 409 : 400).json({
      error:
        error instanceof z.ZodError
          ? "输入格式或长度不符合要求"
          : error.code === "LIMIT_FILE_SIZE"
            ? "文件超过 30 MB"
            : error.message || "操作失败",
    });
  },
);
const server = app.listen(port, "127.0.0.1", () =>
  console.log(`医学科研入门导师：http://127.0.0.1:${port}`),
);
async function shutdown() {
  await researchPlans.cancelAll();
  readingGuides.cancelAll();
  replayController?.abort();
  await Promise.all([
    ...[...assistant.turns.values()]
      .filter(
        (t) =>
          ![
            "completed",
            "failed",
            "cancelled",
            "interrupted",
            "clarification",
          ].includes(t.status),
      )
      .map((t) => assistant.cancel(t.id)),
    ...[...deckVersions.versions.values()]
      .filter((v) => ["queued", "revising", "checking"].includes(v.status))
      .map((v) => deckVersions.cancel(v.id)),
    ...[...manager.activeIds].map((id) => manager.cancel(id)),
  ]);
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
