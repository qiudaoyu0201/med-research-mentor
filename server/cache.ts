import type { TaskRun } from "../shared/types.ts";
import { read, save, missingRecord } from "./storage.ts";
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
      if (missingRecord(error)) return;
      throw error;
    }
  }
  eligible(run: TaskRun) {
    const online = run.skillVersions?.["delivery-policy"] === "online-v3";
    return (
      run.status === "completed" &&
      !!run.result &&
      !!run.review &&
      !run.review.issues.some(
        (i) => !i.resolved && (!online || i.severity === "blocking"),
      ) &&
      !run.materialRequests?.some((r) => r.status !== "resolved") &&
      !run.novice?.breakpoints.some((b) => b.status !== "resolved")
    );
  }
  async put(key: string, run: TaskRun) {
    if (this.eligible(run)) await this.persist(this.namespace, key, run);
  }
}
