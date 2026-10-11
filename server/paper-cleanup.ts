import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { root, read, remove } from "./storage.ts";

/** Receipts/cache IDs differ from paper IDs: inspect their binding before erasing. */
export async function removePaperCaches(paperId: string) {
  for (const group of [
    "paper-imports",
    "reading-guides",
    "source-translations",
    "tutor-research",
    "task-cache",
  ]) {
    let files: string[];
    try {
      files = await readdir(join(root, group));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      const id = file.slice(0, -5);
      const record = await read<{
        paperId?: string;
        input?: { paperId?: string };
      }>(group, id);
      if (record.paperId === paperId || record.input?.paperId === paperId)
        await remove(group, id);
    }
  }
}
