import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { digest } from "./materials.ts";
export const recoveryPlanPath = "docs/ITERATION.md";
export const hashFile = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
export async function trainingEngine() {
  const files = (
    await Promise.all(
      ["server", "shared", "scripts", "evals"].map(async (root) =>
        (await readdir(root, { recursive: true }))
          .filter((p) => /\.(ts|ps1)$/.test(p))
          .map((p) => join(root, p)),
      ),
    )
  )
    .flat()
    .concat("package.json", "package-lock.json")
    .sort();
  return Promise.all(
    files.map(async (path) => ({ path, hash: await hashFile(path) })),
  );
}
export async function recoveryBindings() {
  return {
    engineHash: digest(await trainingEngine()),
    planHash: await hashFile(recoveryPlanPath),
  };
}
