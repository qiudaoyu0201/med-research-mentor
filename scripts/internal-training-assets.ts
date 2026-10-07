import { mkdir, copyFile, readFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { trainingPapers } from "../evals/internal-training-cases.ts";
// Ordinary PDF import keeps an original under uploads for immutable display assets.
// This zero-call preparation preserves the same bytes in an isolated cycle.
const directory = resolve(
  process.env.TUTOR_TRAINING_DIR ?? "runs/internal-training/cycle-1",
);
const rel = relative(resolve("runs/internal-training"), directory);
if (!rel || rel.startsWith("..") || isAbsolute(rel))
  throw new Error("训练周期目录必须隔离");
const uploads = join(directory, "data", "uploads");
await mkdir(uploads, { recursive: true });
for (const paper of trainingPapers) {
  const source = await readFile(paper.path);
  const target = join(uploads, `${paper.id}.pdf`);
  try {
    const existing = await readFile(target);
    if (
      createHash("sha256").update(existing).digest("hex") !==
      createHash("sha256").update(source).digest("hex")
    )
      throw new Error(`原始上传文件变化：${paper.id}`);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    await copyFile(paper.path, target);
  }
}
console.log("原始 PDF 已按普通导入路径保存在独立 uploads；零模型调用。");
