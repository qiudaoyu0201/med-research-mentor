import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { createProvider } from "../server/model-config.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { AssistantService } from "../server/assistant.ts";
import { ConversationStore } from "../server/conversation.ts";
import { localSample } from "../server/sample.ts";
import { materialPacket } from "../server/materials.ts";
const paper = await localSample();
const selected = paper.sources.filter((s) =>
  ["xu-fig1", "xu-fig1-results", "xu-fig1-methods"].includes(s.id),
);
assert.equal(selected.length, 3, "需要本机 Xu 2018 正文及固定 Figure 1 资料");
assert.ok(selected.find((s) => s.id === "xu-fig1")?.image);
materialPacket(selected);
console.log(
  JSON.stringify({
    sourceVersion: paper.version,
    sources: selected.map((s) => ({
      id: s.id,
      locator: s.locator,
      chars: s.text.length,
      image: !!s.image,
    })),
    mode: process.argv.includes("--live") ? "live" : "materials-only",
  }),
);
if (process.argv.includes("--live")) {
  const provider = createProvider();
  const manager = new TaskManager(provider);
  const conversations = new ConversationStore();
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    async () => paper,
  );
  const conversation = await conversations.create({ paperId: paper.id });
  const started = Date.now();
  const turn = await assistant.submit(conversation.id, {
    clientMessageId: "figure1-report",
    question:
      "帮我读懂 Figure 1，解释相关方法，再整理成三页汇报。重点讲 d–f 功能比较与对照，k–m 只说明测量含义和推理范围。",
    mode: "live",
    sourceIds: selected.map((s) => s.id),
  });
  await assistant.wait(turn.id);
  const run = manager.runs.get(turn.runId ?? "");
  const result = {
    turnId: turn.id,
    conversationId: conversation.id,
    status: turn.status,
    error: turn.error,
    model: provider.model,
    sourceVersion: paper.version,
    calls: turn.budget.attempts.length,
    durationMs: Date.now() - started,
    attempts: turn.budget.attempts.map(
      ({ id, role, status, durationMs, inputChars, outputChars, tokens }) => ({
        id,
        role,
        status,
        durationMs,
        inputChars,
        outputChars,
        tokens,
      }),
    ),
    slides: run?.deck?.slides.length ?? 0,
    artifacts: turn.reply?.artifacts,
    pending: turn.reply?.pendingQuestions,
    novicePresentation: !!(run?.roles[1]?.input as any)?.presentation,
  };
  await mkdir("runs", { recursive: true });
  await writeFile("runs/assistant-check.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(turn.status, "completed", turn.error);
  assert.ok(result.calls <= 6);
  assert.equal(result.slides, 3);
  assert.ok(result.novicePresentation);
  assert.ok(result.artifacts?.length);
  const zip = unzipSync(
    new Uint8Array(
      await readFile(join("exports", `${result.artifacts![0].id}.pptx`)),
    ),
  );
  assert.equal(
    Object.keys(zip).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .length,
    3,
  );
  assert.equal(
    Object.keys(zip).filter((k) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k),
    ).length,
    3,
  );
  assert.ok(Object.keys(zip).some((k) => k.startsWith("ppt/media/")));
}
