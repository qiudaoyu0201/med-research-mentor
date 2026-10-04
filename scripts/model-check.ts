import { CodexProvider } from "../server/provider.ts";
import { z } from "zod";
const provider = new CodexProvider();
console.log(JSON.stringify(await provider.inspect(), null, 2));
if (process.argv.includes("--generate")) {
  console.log("开始一次短文本测试，使用现有 ChatGPT 额度；不自动重试。");
  const result = await provider.generate(
    "直接返回符合 JSON Schema 的结果，不使用工具。",
    { question: "用一句话解释对照组的用途。" },
    z.object({ answer: z.string() }),
    AbortSignal.timeout(180_000),
  );
  console.log(JSON.stringify(result));
}
