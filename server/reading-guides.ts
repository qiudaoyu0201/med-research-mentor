import { z } from "zod";
import { readingStart, type ReadingStart } from "../shared/workspace.ts";
import type { PaperBundle } from "../shared/types.ts";
import type { Provider } from "./provider.ts";
import { TaskScheduler, taskKey } from "./scheduler.ts";
import { BudgetLedger } from "./budget.ts";
import { save, list } from "./storage.ts";
import { digest } from "./materials.ts";

type Guide = ReadingStart & { id: string; budget: BudgetLedger["state"] };
export class ReadingGuides {
  records = new Map<string, Guide>();
  private controllers = new Map<string, AbortController>();
  constructor(
    private provider: Provider,
    private scheduler: TaskScheduler,
    private persist: typeof save = save,
  ) {}
  async restore(loader: typeof list = list) {
    for (const guide of await loader<Guide>("reading-guides")) {
      if (guide.status === "running" || guide.status === "queued") {
        guide.status = "cancelled";
        for (const attempt of guide.budget.attempts)
          if (attempt.status === "reserved") attempt.status = "unknown";
        await this.persist("reading-guides", guide.id, guide);
      }
      this.records.set(guide.id, guide);
    }
  }
  private key(paper: PaperBundle) {
    return digest({
      id: paper.id,
      version: paper.version,
      sources: paper.sources
        .filter((s) => s.kind === "paper")
        .map(({ image, ...s }) => s),
    });
  }
  get(paper: PaperBundle) {
    return this.records.get(this.key(paper)) ?? readingStart(paper);
  }
  cancel(paperId: string) {
    for (const [id, controller] of this.controllers)
      if (this.records.get(id)?.paperId === paperId) controller.abort();
  }
  cancelAll() {
    for (const controller of this.controllers.values()) controller.abort();
  }
  async start(paper: PaperBundle) {
    const id = this.key(paper),
      existing = this.records.get(id);
    if (
      existing &&
      (this.controllers.has(id) ||
        !["failed", "cancelled"].includes(existing.status!))
    )
      return existing;
    const sources = paper.sources
      .filter((s) => s.kind === "paper" && s.text.trim())
      .slice(0, 10)
      .map(({ id, title, locator, text }) => ({
        id,
        title,
        locator,
        text: text.slice(0, 1800),
      }));
    if (!sources.length) throw new Error("请先补充可读取的正文。");
    const ledger = new BudgetLedger(id, async () => {
      await this.persist("reading-guides", id, guide);
    });
    ledger.state.limit = 1;
    const guide: Guide = {
      ...readingStart(paper),
      id,
      budget: ledger.state,
      status: "queued",
    };
    const controller = new AbortController();
    this.records.set(id, guide);
    this.controllers.set(id, controller);
    await this.persist("reading-guides", id, guide);
    void this.scheduler
      .run(
        taskKey(paper.id, "guide"),
        controller.signal,
        async () => {
          ledger.state.deadline = new Date(Date.now() + 180_000).toISOString();
          guide.status = "running";
          await this.persist("reading-guides", id, guide);
          const schema = z.object({
            summary: z.string().min(1).max(1600),
            sourceIds: z
              .array(z.enum(sources.map((s) => s.id)))
              .min(1)
              .max(10),
            questions: z.array(z.string().min(1).max(200)).min(1).max(3),
          });
          const instructions =
            "根据给出的真实论文摘录整理中文阅读起点。先回应研究对象、问题、关键方法及可见结果，缺失部分不补造。summary 简短具体，sourceIds 只能用支持概述的摘录 ID；最多三个问题，具体涉及本研究的对象、方法或比较，避免所有论文通用的套话。无用能力声明和重复限制删去。只返回 JSON。";
          const result = await ledger.call(
            this.provider,
            "reading-guide",
            instructions,
            { title: paper.title, sources },
            schema,
            controller.signal,
            { groupId: id, sourceHash: id, skillHash: digest(instructions) },
          );
          controller.signal.throwIfAborted();
          Object.assign(guide, result.output, {
            status: "completed",
            label: "研究起点 · 根据原文整理",
          });
        },
        true,
      )
      .catch((error) => {
        guide.status = controller.signal.aborted ? "cancelled" : "failed";
        guide.error = controller.signal.aborted
          ? undefined
          : String(error).replace(/^Error: /, "");
      })
      .finally(async () => {
        this.controllers.delete(id);
        await this.persist("reading-guides", id, guide);
      });
    return guide;
  }
}
