import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createProvider } from "../server/model-config.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { AssistantService } from "../server/assistant.ts";
import { ConversationStore } from "../server/conversation.ts";
import { sample } from "../examples/bundle.ts";
import { save } from "../server/storage.ts";

// Two separate user turns, each with the product ledger; development aggregate is capped at two calls.
const id = randomUUID();
const report: any = {
  id,
  limits: { totalCalls: 2, turnSeconds: 480 },
  turns: [],
  status: "running",
  limitations: [
    "背景解释内容经阅读检查；未验证真人学习效果。",
    "历史三页汇报失败及 Figure 1m 分母缺依据未改变。",
  ],
};
console.log(
  "主助手行为检查：背景直接解释与绑定句子的追问，最多两次调用，失败不重发。",
);
const provider = createProvider();
const manager = new TaskManager(provider);
const conversations = new ConversationStore();
const assistant = new AssistantService(
  provider,
  manager,
  conversations,
  async () => sample,
);
const state = await conversations.create();
try {
  for (let step = 0; step < 2; step++) {
    const prior = report.turns[0];
    const turn = await assistant.submit(state.id, {
      clientMessageId: `${id}-${step}`,
      mode: "live",
      depth: step ? "standard" : "brief",
      question: step
        ? "这句话换个通俗说法，给一个对照的例子"
        : "用一句话解释实验中为什么要设置对照组",
      ...(step
        ? {
            focus: {
              runId: prior.runId,
              sectionIndex: 0,
              excerpt: prior.reply.content.sections[0].text,
            },
          }
        : {}),
    });
    await assistant.wait(turn.id);
    report.turns.push(structuredClone(turn));
    await save("workflow-reports", id, report);
    if (turn.status !== "completed" || turn.budget.attempts.length !== 1)
      throw new Error(turn.error ?? "工作流未按一次直接解释完成");
  }
  report.status = "behavior-observed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
}
await save("workflow-reports", id, report);
await mkdir("runs", { recursive: true });
await writeFile("runs/workflow-check.json", JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      id,
      status: report.status,
      error: report.error,
      turns: report.turns.map((t: any) => ({
        id: t.id,
        calls: t.budget.attempts.length,
        reply: t.reply,
      })),
    },
    null,
    2,
  ),
);
