import { createProvider } from "../server/model-config.ts";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BudgetLedger } from "../server/budget.ts";
import { digest } from "../server/materials.ts";
import { z } from "zod";
const provider = createProvider();
console.log(JSON.stringify(await provider.inspect(), null, 2));
if (process.argv.includes("--generate")) {
  const id = new Date().toISOString().replace(/[:.]/g, "-"),
    dir = resolve("runs/model-probe", id),
    report = {
      provider: provider.id,
      model: provider.model,
      results: [] as {
        task: string;
        status: string;
        error?: string;
        output?: { answer: string };
      }[],
    };
  await mkdir(dir, { recursive: true });
  const ledger = new BudgetLedger(id, async () => {
    await writeFile(
      resolve(dir, "report.json"),
      JSON.stringify({ ...report, budget: ledger.state }, null, 2),
    );
  });
  ledger.state.limit = 3;
  const instructions = "直接返回符合 JSON Schema 的结果，不使用工具。";
  const probe = async (
    task: string,
    question: string,
    image?: string,
    signal = AbortSignal.timeout(180_000),
  ) => {
    try {
      const result = await ledger.call(
        provider,
        "model-probe",
        instructions,
        { question },
        z.object({ answer: z.string().min(1) }),
        signal,
        {
          groupId: id,
          sourceHash: digest({ question, image }),
          skillHash: digest(instructions),
          image,
        },
      );
      report.results.push({
        task,
        status: task === "cancellation" ? "completed-before-stop" : "completed",
        output: result.output,
      });
    } catch (error) {
      report.results.push({
        task,
        status: signal.aborted ? "stopped" : "failed",
        error: (error as Error).message,
      });
    }
  };
  console.log("实际验证最多三次尝试，使用当前配置模型；不自动重试。");
  await probe("text-schema", "用一句话解释对照组的用途。");
  const imageIndex = process.argv.indexOf("--image");
  if (imageIndex !== -1) {
    const file = process.argv[imageIndex + 1];
    if (!file || file.startsWith("--"))
      throw new Error("--image 后须提供 PNG/JPEG 路径。");
    const bytes = await readFile(file);
    const mime = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "png"
      : bytes[0] === 255 && bytes[1] === 216
        ? "jpeg"
        : undefined;
    if (!mime) throw new Error("图片格式须为 PNG/JPEG。");
    await probe(
      "image-schema",
      "只描述图片中实际可见的分组、坐标或形状，无法读出的内容写未知。",
      `data:image/${mime};base64,${bytes.toString("base64")}`,
    );
  }
  if (process.argv.includes("--cancel")) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("主动停止模型探针")),
      1000,
    );
    try {
      await probe(
        "cancellation",
        "详细解释研究设计、对照和统计原理。",
        undefined,
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  await writeFile(
    resolve(dir, "report.json"),
    JSON.stringify({ ...report, budget: ledger.state }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(`记录：${dir}`);
  if (report.results.some((r) => r.status === "failed")) process.exitCode = 1;
}
