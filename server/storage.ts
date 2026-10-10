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
import { validRecordShape } from "./record-shapes.ts";
export const root = resolve(process.env.TUTOR_DATA_DIR || "data");
export function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("记录编号无效");
  return id;
}
export class CorruptRecordError extends Error {
  readonly code = "E_CORRUPT_RECORD";
  constructor(readonly preservedPath: string) {
    super("本地记录损坏，原件已隔离保留。请查看数据目录 quarantine。");
  }
}
export function missingRecord(error: unknown) {
  return (
    error instanceof CorruptRecordError ||
    (error as NodeJS.ErrnoException)?.code === "ENOENT"
  );
}

// Windows readers/scanners may briefly deny replacement. Never unlink the old record.
export async function renameWithRetry(
  source: string,
  target: string,
  replace: (source: string, target: string) => Promise<void> = rename,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await replace(source, target);
      return;
    } catch (error: any) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt === 3)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

// Serialize access to each record so an old corrupt read cannot move a newer
// successful save into quarantine. Other records remain independent.
export class RecordStorage {
  private queues = new Map<string, Promise<unknown>>();
  private recovered = new Set<string>();
  private indexRecovered = false;
  constructor(readonly directory: string) {}
  private target(group: string, id: string) {
    return join(this.directory, safeId(group), `${safeId(id)}.json`);
  }
  private locked<T>(target: string, work: () => Promise<T>): Promise<T> {
    const operation = (this.queues.get(target) ?? Promise.resolve()).then(work);
    const settled = operation.catch(() => {});
    this.queues.set(target, settled);
    void settled.then(() => {
      if (this.queues.get(target) === settled) this.queues.delete(target);
    });
    return operation;
  }
  private async atomic(target: string, content: string) {
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, "utf8");
      await renameWithRetry(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
  private async parsed<T>(target: string, group: string): Promise<T> {
    const content = await readFile(target, "utf8");
    try {
      const value = JSON.parse(content);
      if (
        !validRecordShape(
          group,
          value,
          target
            .split(/[\\/]/)
            .at(-1)
            ?.replace(/\.json(?:\.backup)?$/, ""),
        )
      )
        throw new SyntaxError("记录结构不完整或字段类型错误。");
      return value;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const dir = join(this.directory, "quarantine", safeId(group));
      await mkdir(dir, { recursive: true });
      const preserved = join(
        dir,
        `${target.split(/[\\/]/).at(-1)}.${randomUUID()}.corrupt`,
      );
      await rename(target, preserved);
      this.recovered.add(preserved);
      console.warn(`[storage] 损坏记录已保留：${preserved}`);
      throw new CorruptRecordError(preserved);
    }
  }
  save = async (group: string, id: string, value: unknown) => {
    const target = this.target(group, id);
    return this.locked(target, async () => {
      await mkdir(join(this.directory, safeId(group)), { recursive: true });
      const content = JSON.stringify(value, null, 2);
      if (content === undefined) throw new Error("记录内容不能为空。");
      // The index contains projects, notes and reading positions. Keep the
      // previous valid index, never replace its backup with malformed bytes.
      if (group === "workspace" && id === "index") {
        try {
          const previous = await this.parsed<unknown>(target, group);
          await this.atomic(
            `${target}.backup`,
            JSON.stringify(previous, null, 2),
          );
        } catch (error) {
          if (!missingRecord(error)) throw error;
        }
      }
      await this.atomic(target, content);
    });
  };
  read = async <T>(group: string, id: string): Promise<T> => {
    const target = this.target(group, id);
    return this.locked(target, async () => {
      try {
        return await this.parsed<T>(target, group);
      } catch (error) {
        if (!missingRecord(error) || group !== "workspace" || id !== "index")
          throw error;
        try {
          const backup = await this.parsed<T>(`${target}.backup`, group);
          await this.atomic(target, JSON.stringify(backup, null, 2));
          this.indexRecovered = true;
          return backup;
        } catch (backupError) {
          if (!missingRecord(backupError)) throw backupError;
          throw error;
        }
      }
    });
  };
  list = async <T>(group: string): Promise<T[]> => {
    const dir = join(this.directory, safeId(group));
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    const records = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (file) => {
          const target = join(dir, file);
          try {
            return {
              value: await this.locked(target, () =>
                this.parsed<T>(target, group),
              ),
            };
          } catch (error) {
            if (!missingRecord(error)) throw error;
            return undefined;
          }
        }),
    );
    return records.flatMap((record) => (record ? [record.value] : []));
  };
  remove = async (group: string, id: string) => {
    const target = this.target(group, id);
    await this.locked(target, () => rm(target, { force: true }));
  };
  recoveryNotice = () =>
    this.indexRecovered
      ? "工作区已从上一份有效备份恢复。损坏原件保留在数据目录 quarantine。"
      : this.recovered.size
        ? "部分本地记录损坏，原件已保留到数据目录 quarantine，其余记录可继续使用。"
        : undefined;
}
const storage = new RecordStorage(root);
export const save = storage.save;
export const read = storage.read;
export const list = storage.list;
export const remove = storage.remove;
export const recoveryNotice = storage.recoveryNotice;
