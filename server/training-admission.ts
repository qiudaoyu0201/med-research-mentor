import { freemem, totalmem, loadavg } from "node:os";
export async function trainingAdmission(
  base = process.env.TUTOR_ONLINE_URL ?? "http://127.0.0.1:4317",
) {
  const url = new URL(base);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:"
  )
    throw new Error("在线状态检查仅支持本机 HTTP。");
  let online = "offline";
  try {
    const response = await fetch(new URL("/api/training-admission", url), {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error("在线准入接口不可用。");
    const state = (await response.json()) as { busy?: boolean };
    if (typeof state.busy !== "boolean")
      throw new Error("在线队列状态不明确。");
    if (state.busy) throw new Error("在线有用户任务，训练单元延后。");
    online = "idle";
  } catch (error: any) {
    if (error.cause?.code !== "ECONNREFUSED") throw error;
  }
  return {
    online,
    freeMemory: freemem(),
    totalMemory: totalmem(),
    load: loadavg(),
    scope: "本机瞬时资源；模型账号竞争与远端算力未测",
  };
}
