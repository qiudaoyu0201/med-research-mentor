import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
export const root = resolve(process.env.TUTOR_DATA_DIR || "data");
export function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("记录编号无效");
  return id;
}
export async function save(group: string, id: string, value: unknown) {
  const dir = join(root, safeId(group));
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${safeId(id)}.json`),
    temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
export async function read<T>(group: string, id: string): Promise<T> {
  return JSON.parse(
    await readFile(join(root, safeId(group), `${safeId(id)}.json`), "utf8"),
  );
}
export async function list<T>(group: string): Promise<T[]> {
  const dir = join(root, safeId(group));
  await mkdir(dir, { recursive: true });
  const files = await readdir(dir);
  return Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8"))),
  );
}
export async function remove(group: string, id: string) {
  await rm(join(root, safeId(group), `${safeId(id)}.json`), { force: true });
}
