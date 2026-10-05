import express from "express";
import multer from "multer";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
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
} from "./schemas.ts";
import { CodexProvider } from "./provider.ts";
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

const app = express(),
  port = Number(process.env.PORT || 4317),
  provider = new CodexProvider(),
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
});
const paperById = async (id: string) =>
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
);
await assistant.restore();
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
function recordsIdle() {
  if (assistant.busy || deckVersions.busy)
    throw new Error("请等待当前请求保存完成后记录反馈。");
}
app.post("/api/conversations/:id/records", async (req, res) => {
  recordsIdle();
  const body = recordInput.parse(req.body);
  res.json(await learningRecords.create(req.params.id, body.version, body));
});
app.put("/api/conversations/:id/records/:recordId", async (req, res) => {
  recordsIdle();
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
  recordsIdle();
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
  recordsIdle();
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
  if (assistant.busy) throw new Error("请等待当前请求保存完成后记录反馈。");
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
  res.json({ ok: true });
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
  const id = randomUUID();
  let paper: PaperBundle;
  try {
    paper = await parsePdf(
      req.file.path,
      id,
      Buffer.from(req.file.originalname, "latin1").toString("utf8"),
    );
  } catch (error) {
    paper = {
      id,
      title: "待修复的上传 PDF",
      version: "failed-upload",
      scope: "原文件已保留，请补充原文。",
      pdfUrl: `/api/papers/${id}/pdf`,
      sources: [],
      parseStatus: "failed",
    };
    await rename(req.file.path, join(root, "uploads", id + ".pdf"));
    await save("papers", id, paper);
    return res.status(422).json({
      error: error instanceof Error ? error.message : "PDF 解析失败",
      paper,
    });
  }
  await rename(req.file.path, join(root, "uploads", id + ".pdf"));
  await save("papers", id, paper);
  res.status(201).json(paper);
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
  const paper = await paperById(req.params.id);
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
  paper.version = `manual-${Date.now()}`;
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
    await paperById(req.params.id),
    resolve(root, "uploads", req.params.id + ".pdf"),
    spec,
  );
  await save("papers", paper.id, paper);
  res.json(paper);
});
app.post("/api/papers/:id/figure", async (req, res) => {
  if (req.params.id === sample.id)
    throw new Error("请先上传原始 PDF，再保存圈选图件。");
  const paper = await paperById(req.params.id);
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
  if (assistant.busy || deckVersions.busy)
    throw new Error("请等待当前请求完成。");
  const body = z
    .object({
      conversationId: z.string(),
      paperId: z.string(),
      runId: z.string().optional(),
    })
    .parse(req.body);
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
app.get("/api/deck-versions/:id", (req, res) =>
  res.json(deckVersions.get(req.params.id)),
);
app.post("/api/deck-versions/:id/edit", async (req, res) => {
  if (assistant.busy || manager.active || replayController)
    throw new Error("请等待当前请求完成。");
  const body = z
    .object({
      conversationId: z.string(),
      slideIndex: z.number().int().min(0).max(15),
      question: z.string().min(1).max(2000),
      slide: deckSchema.shape.slides.element.optional(),
    })
    .parse(req.body);
  assistant.conversations.get(body.conversationId);
  res
    .status(202)
    .json(await deckVersions.start(req.params.id, body.conversationId, body));
});
app.post("/api/deck-versions/:id/cancel", async (req, res) => {
  await deckVersions.cancel(req.params.id);
  res.json({ ok: true });
});
app.post("/api/deck-versions/:id/restore", async (req, res) => {
  if (assistant.busy) throw new Error("请等待当前请求完成。");
  const body = z
    .object({ conversationId: z.string(), targetId: z.string() })
    .parse(req.body);
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
  if (assistant.busy || deckVersions.busy)
    throw new Error("请等待当前请求完成。");
  const body = z.object({ conversationId: z.string() }).parse(req.body);
  const state = assistant.conversations.get(body.conversationId);
  const artifact = await deckVersions.export(
    req.params.id,
    body.conversationId,
  );
  state.latestDeckVersionId = req.params.id;
  state.artifacts.push({
    id: artifact.id,
    kind: "pptx",
    sourceHash: deckVersions.get(req.params.id).sourceHash,
  });
  await assistant.conversations.put(state, state.version);
  res.json(artifact);
});
app.post("/api/deck-versions/:id/select", async (req, res) => {
  if (assistant.busy || deckVersions.busy)
    throw new Error("请等待当前请求完成。");
  const body = z.object({ conversationId: z.string() }).parse(req.body);
  const version = deckVersions.get(req.params.id, body.conversationId);
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
    res.status(error instanceof z.ZodError ? 400 : 400).json({
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
  replayController?.abort();
  if (assistant.active) await assistant.cancel(assistant.active);
  if (manager.active) await manager.cancel(manager.active);
  if (deckVersions.active) await deckVersions.cancel(deckVersions.active);
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
