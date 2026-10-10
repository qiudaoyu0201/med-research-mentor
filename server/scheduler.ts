type Entry = {
  key: string;
  signal: AbortSignal;
  start: () => Promise<void>;
  abort: () => void;
  background: boolean;
};

// A slot covers the entire answer/review/revision, including nested deck work.
export class TaskScheduler {
  private pending: Entry[] = [];
  private running = new Set<string>();
  constructor(readonly limit = 2) {}
  get busy() {
    return this.running.size > 0 || this.pending.length > 0;
  }
  has(key: string) {
    return this.running.has(key) || this.pending.some((e) => e.key === key);
  }
  run(
    key: string,
    signal: AbortSignal,
    task: () => Promise<void>,
    background = false,
  ) {
    return new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const entry: Entry = {
        key,
        signal,
        background,
        abort: () => {
          this.pending = this.pending.filter((e) => e !== entry);
          signal.removeEventListener("abort", entry.abort);
          reject(signal.reason);
          this.drain();
        },
        start: async () => {
          try {
            signal.throwIfAborted();
            await task();
            resolve();
          } catch (error) {
            reject(error);
          } finally {
            this.running.delete(key);
            this.drain();
          }
        },
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.pending.push(entry);
      this.drain();
    });
  }
  private drain() {
    while (this.running.size < this.limit) {
      let index = this.pending.findIndex(
        (e) => !e.background && !this.running.has(e.key),
      );
      if (index < 0)
        index = this.pending.findIndex((e) => !this.running.has(e.key));
      if (index < 0) return;
      const [entry] = this.pending.splice(index, 1);
      entry.signal.removeEventListener("abort", entry.abort);
      this.running.add(entry.key);
      void entry.start();
    }
  }
}

export const taskKey = (paperId: string | null, conversationId: string) =>
  paperId ? `paper:${paperId}` : `chat:${conversationId}`;
