import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { digest } from "./materials.ts";
import { hashFile } from "./training-engine.ts";
import type { Attempt } from "../shared/types.ts";

// A sidecar can supply original RPC events or a read-only terminal state without
// changing a historical cancelled attempt or inventing its missing usage.
export async function readRecoveryEvidence(
  evidence: { path: string; hash: string },
  previousDirectory: string,
  attemptId: string,
): Promise<NonNullable<Attempt["observation"]>> {
  if ((await hashFile(resolve(evidence.path))) !== evidence.hash)
    throw new Error("终态证据哈希改变。");
  const record = JSON.parse(await readFile(resolve(evidence.path), "utf8"));
  const inputPath = join(
    previousDirectory,
    "records/provider-inputs",
    `${attemptId}.json`,
  );
  const saved = JSON.parse(await readFile(inputPath, "utf8"));
  const expectedSchema = structuredClone(saved.schema);
  const strict = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.type === "object" && value.properties) {
      value.required = Object.keys(value.properties);
      value.additionalProperties = false;
    }
    Object.values(value).forEach(strict);
  };
  strict(expectedSchema);
  const thread = record.threadStart,
    turn = record.turnStart;
  const threadId = thread?.result?.thread?.id,
    turnId = turn?.result?.turn?.id;
  if (
    record.attemptId !== attemptId ||
    record.providerInputHash !== (await hashFile(inputPath)) ||
    !threadId ||
    !turnId ||
    thread?.method !== "thread/start" ||
    turn?.method !== "turn/start" ||
    thread.params.baseInstructions !== saved.instructions ||
    thread.params.model !== saved.model ||
    turn.params.threadId !== threadId ||
    turn.params.model !== saved.model ||
    turn.params.effort !== saved.settings?.effort ||
    digest(turn.params.outputSchema) !== digest(expectedSchema) ||
    digest(turn.params.input) !==
      digest([
        { type: "text", text: JSON.stringify(saved.input) },
        ...(saved.image ? [{ type: "image", url: saved.image }] : []),
      ])
  )
    throw new Error("终态证据不能关联原始派发、输入、模型与合同。");
  const terminal = record.terminal;
  const state =
    terminal?.method === "turn/completed" &&
    terminal.params?.threadId === threadId &&
    terminal.params?.turn?.id === turnId
      ? terminal.params.turn
      : terminal?.method === "thread/read" &&
          terminal.result?.thread?.id === threadId
        ? terminal.result.thread.turns?.find((t: any) => t.id === turnId)
        : null;
  if (
    !state ||
    !["completed", "interrupted", "failed"].includes(state.status) ||
    typeof record.observedAt !== "string" ||
    !Number.isFinite(Date.parse(record.observedAt))
  )
    throw new Error("证据没有对应请求的终止事件或可核对终态。");
  return {
    threadId,
    turnId,
    remoteTerminal: state.status,
    outputUpdates: 0,
    lastActivityAt: record.observedAt,
    events: [{ type: "terminal", status: state.status, at: record.observedAt }],
  };
}
