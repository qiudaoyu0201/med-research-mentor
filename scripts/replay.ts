import { readFile } from "node:fs/promises";
import { replay } from "../server/replay.ts";
import { CodexProvider } from "../server/provider.ts";
const id = "medical-method-tutor";
const text = await readFile(`skills/${id}/SKILL.md`, "utf8");
const candidate =
  text +
  "\n修订候选：先解释测量对象，再解释原理；首次出现扩增与门控时补概念。不得删掉来源要求，材料缺失时停止具体事实判断。\n";
const batch = await replay(
  {
    skillId: id,
    text: candidate,
    mode: process.argv.includes("--live") ? "live" : "fixture",
    ...(process.argv.includes("--small")
      ? { caseIds: ["pcr", "ct-context"] }
      : {}),
  },
  new CodexProvider(),
);
console.log(JSON.stringify(batch, null, 2));
