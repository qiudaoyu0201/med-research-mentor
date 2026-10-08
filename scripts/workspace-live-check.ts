import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { parsePdf } from "../server/pdf.ts";
import { samplePdf } from "../server/sample.ts";
import { AssistantService } from "../server/assistant.ts";
import { ConversationStore } from "../server/conversation.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { createProvider } from "../server/model-config.ts";
import { Projects } from "../server/projects.ts";
import { save } from "../server/storage.ts";

// One real original-text question, maximum six role calls, no automatic retry.
const id = randomUUID(),
  provider = createProvider(),
  manager = new TaskManager(provider);
const conversations = new ConversationStore();
const report: any = {
  id,
  mode: "live-original-text",
  maxCalls: 6,
  status: "running",
};
await mkdir("runs/workspace", { recursive: true });
try {
  const paper = await parsePdf(
    samplePdf,
    `workspace-live-${id}`,
    "Xu 2018 · 实际正文导入检查",
  );
  await save("papers", paper.id, paper);
  const start = paper.sources[0].text.indexOf("Senescent cells");
  const excerpt = paper.sources[0].text.slice(
    Math.max(0, start),
    Math.max(0, start) + 450,
  );
  const state = await conversations.create({ paperId: paper.id });
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    async () => paper,
  );
  const turn = await assistant.submit(state.id, {
    clientMessageId: id,
    question:
      "请通俗解释所选原文中的研究问题、比较对象与结论范围；只解释这段原文能够说明的内容。",
    mode: "live",
    depth: "brief",
    sourceAnchor: {
      paperId: paper.id,
      sourceVersion: paper.version,
      sourceId: paper.sources[0].id,
      page: 1,
      excerpt,
    },
  });
  const timeout = setTimeout(() => void assistant.cancel(turn.id), 300_000);
  try {
    await assistant.wait(turn.id);
  } finally {
    clearTimeout(timeout);
  }
  const run = turn.runId ? manager.runs.get(turn.runId) : undefined;
  report.turn = turn;
  report.run = run;
  if (
    turn.status !== "completed" ||
    !run?.result ||
    turn.budget.attempts.length > 6
  )
    throw new Error(turn.error || "原文追问未完成");
  const projects = new Projects();
  const note = await projects.saveAnswer(
    conversations.get(state.id),
    { ...turn, run },
    paper,
  );
  report.noteId = note.id;
  report.status = "behavior-observed";
  report.limitations = [
    "仅验证一篇实际正文的一段原文；未验证真人学习效果或所有图件类型。",
  ];
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
}
await save("workspace-reports", id, report);
await writeFile(
  "runs/workspace/live-report.json",
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    {
      id,
      status: report.status,
      error: report.error,
      calls: report.turn?.budget.attempts.length,
      title: report.turn?.reply?.content?.title,
      noteId: report.noteId,
    },
    null,
    2,
  ),
);
