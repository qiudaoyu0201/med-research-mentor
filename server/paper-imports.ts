import { randomUUID } from "node:crypto";
import type { PaperBundle } from "../shared/types.ts";
import { save, read } from "./storage.ts";
import { TaskScheduler } from "./scheduler.ts";

export interface ImportResult {
  paper: PaperBundle;
  error?: string;
}
type Receipt = { hash: string; paperId: string; result?: ImportResult };

export class PaperImports {
  private pending = new Map<
    string,
    { hash: string; result: Promise<ImportResult> }
  >();
  private parser = new TaskScheduler(1);
  constructor(
    private persist = save,
    private load = read,
  ) {}
  run(
    id: string,
    hash: string,
    parse: (paperId: string) => Promise<ImportResult>,
  ) {
    const pending = this.pending.get(id);
    if (pending) {
      if (pending.hash !== hash) throw new Error("导入标识已用于另一个文件。");
      return pending.result;
    }
    const result = this.import(id, hash, parse);
    this.pending.set(id, { hash, result });
    void result.finally(() => this.pending.delete(id)).catch(() => {});
    return result;
  }
  private async import(
    id: string,
    hash: string,
    parse: (paperId: string) => Promise<ImportResult>,
  ) {
    let receipt: Receipt;
    try {
      receipt = await this.load<Receipt>("paper-imports", id);
      if (receipt.hash !== hash) throw new Error("导入标识已用于另一个文件。");
      if (receipt.result) return receipt.result;
      // Recover a paper saved before an interrupted receipt write.
      try {
        const paper = await this.load<PaperBundle>("papers", receipt.paperId);
        return {
          paper,
          ...(paper.parseStatus === "failed"
            ? { error: "PDF 解析失败，请补充原文。" }
            : {}),
        };
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      receipt = { hash, paperId: randomUUID() };
      await this.persist("paper-imports", id, receipt);
    }
    let result!: ImportResult;
    await this.parser.run(id, new AbortController().signal, async () => {
      result = await parse(receipt.paperId);
      await this.persist("paper-imports", id, { ...receipt, result });
    });
    return result;
  }
}
