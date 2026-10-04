import type { TaskRun } from "../shared/types.ts";
import { read, save } from "./storage.ts";
export class ResultCache {
  constructor(
    private namespace = "task-cache",
    private persist: typeof save = save,
    private fetch: typeof read = read,
  ) {}
  async get(key: string): Promise<TaskRun | undefined> {
    try {
      const run = await this.fetch<TaskRun>(this.namespace, key);
      return this.eligible(run) ? run : undefined;
    } catch (error: any) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
  eligible(run: TaskRun) {
    return (
      run.status === "completed" &&
      !!run.result &&
      !!run.review &&
      !run.review.issues.some((i) => !i.resolved) &&
      !run.novice?.breakpoints.some((b) => b.status !== "resolved")
    );
  }
  async put(key: string, run: TaskRun) {
    if (this.eligible(run)) await this.persist(this.namespace, key, run);
  }
}
