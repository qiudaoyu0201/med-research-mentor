import test from "node:test";
import assert from "node:assert/strict";
import { AssistantService } from "../server/assistant.ts";
import { ConversationStore } from "../server/conversation.ts";
import { TaskManager } from "../server/orchestrator.ts";
import { DeckVersions } from "../server/deck-versions.ts";
import { PaperImports } from "../server/paper-imports.ts";
import { sample } from "../examples/bundle.ts";
import type { Provider } from "../server/provider.ts";
import type { PaperBundle } from "../shared/types.ts";
import { save, read, list } from "../server/storage.ts";

const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await delay();
  assert.ok(check(), "expected state was not reached");
}
function harness() {
  const disk = new Map<string, any>();
  const persist: typeof save = async (g, id, value) => {
    disk.set(`${g}/${id}`, structuredClone(value));
  };
  const load: typeof read = async <T>(g: string, id: string): Promise<T> => {
    if (!disk.has(`${g}/${id}`))
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return structuredClone(disk.get(`${g}/${id}`));
  };
  const loader: typeof list = async <T>(g: string): Promise<T[]> =>
    [...disk]
      .filter(([k]) => k.startsWith(`${g}/`))
      .map(([, v]) => structuredClone(v));
  const inputs = new Map<string, any>(),
    releases = new Map<string, () => void>();
  const papers = new Map<string, PaperBundle>();
  let concurrent = 0,
    maximum = 0;
  const provider: Provider = {
    model: "deterministic-scheduling-fixture",
    async generate(_instructions, value, schema, signal) {
      const input = value as any;
      const question =
        input.responseMode === "explain" ? input.question : "deck-review";
      inputs.set(question, structuredClone(input));
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          releases.set(question, () => {
            signal.removeEventListener("abort", abort);
            resolve();
          });
        });
        signal.throwIfAborted();
        return {
          output: schema.parse(
            question === "deck-review"
              ? {
                  issues: [],
                  checkedSources: ["xu-question"],
                  limitations: [],
                }
              : {
                  title: question,
                  question,
                  sections: [
                    {
                      title: "核心意思",
                      text: `${question} 的已完成回答`,
                      kind: "background",
                      citations: [],
                    },
                  ],
                  terms: [],
                  nextQuestion: "继续理解这个问题",
                },
          ),
        };
      } finally {
        concurrent--;
      }
    },
  };
  const paperById = async (id: string) => structuredClone(papers.get(id)!);
  const conversations = new ConversationStore(persist),
    manager = new TaskManager(provider, persist);
  const decks = new DeckVersions(provider, paperById, persist);
  const assistant = new AssistantService(
    provider,
    manager,
    conversations,
    paperById,
    persist,
    undefined,
    undefined,
    decks,
  );
  const send = (id: string, label: string) =>
    assistant.submit(id, {
      clientMessageId: label,
      question: `一句话解释${label}`,
      mode: "live",
    });
  async function chat(id: string) {
    papers.set(id, { ...structuredClone(sample), id });
    return conversations.mainForPaper(id);
  }
  return {
    disk,
    persist,
    load,
    loader,
    inputs,
    releases,
    papers,
    provider,
    conversations,
    manager,
    decks,
    assistant,
    send,
    chat,
    max: () => maximum,
  };
}

test("two chats run, a third waits and can cancel without a call; cancellation releases the slot", async () => {
  const h = harness(),
    a = await h.chat("a"),
    b = await h.chat("b"),
    c = await h.chat("c"),
    d = await h.chat("d");
  const [ta, tb] = await Promise.all([h.send(a.id, "A"), h.send(b.id, "B")]);
  await until(() => h.inputs.size === 2);
  const tc = await h.send(c.id, "C"),
    td = await h.send(d.id, "D");
  assert.equal(tc.status, "queued");
  assert.equal(td.status, "queued");
  assert.equal(tc.budget.attempts.length, 0);
  await h.assistant.cancel(tc.id);
  assert.equal(tc.status, "cancelled");
  assert.equal(h.inputs.has("一句话解释C"), false);
  await h.assistant.cancel(ta.id);
  await until(() => h.inputs.has("一句话解释D"));
  h.releases.get("一句话解释B")!();
  h.releases.get("一句话解释D")!();
  await Promise.all([h.assistant.wait(tb.id), h.assistant.wait(td.id)]);
  assert.equal(tb.status, "completed", tb.error);
  assert.equal(td.status, "completed", td.error);
  assert.equal(h.max(), 2);
  assert.equal(h.assistant.busy, false);
});

test("same chat runs in order and inherits the completed answer without losing queued message IDs or a concurrent rename", async () => {
  const h = harness(),
    a = await h.chat("a");
  const first = await h.send(a.id, "first");
  await until(() => h.inputs.size === 1);
  const [second, third] = await Promise.all([
    h.send(a.id, "second"),
    h.send(a.id, "third"),
  ]);
  await h.conversations.update(a.id, (state) => ({
    ...state,
    title: "我的实验",
    titleEdited: true,
  }));
  assert.equal(second.status, "queued");
  assert.equal(third.status, "queued");
  h.releases.get("一句话解释first")!();
  await h.assistant.wait(first.id);
  await until(() => h.inputs.has("一句话解释second"));
  assert.match(h.inputs.get("一句话解释second").contextSummary, /first/);
  h.releases.get("一句话解释second")!();
  await h.assistant.wait(second.id);
  await until(() => h.inputs.has("一句话解释third"));
  h.releases.get("一句话解释third")!();
  await h.assistant.wait(third.id);
  const state = h.conversations.get(a.id);
  assert.deepEqual(state.recentTurnIds, [first.id, second.id, third.id]);
  assert.equal(state.title, "我的实验");
  assert.equal(h.max(), 1);
  assert.equal(third.status, "completed", third.error);
});

test("queued source versions are immutable and reject changed material before any generation", async () => {
  const h = harness(),
    a = await h.chat("a");
  const first = await h.send(a.id, "first"),
    second = await h.send(a.id, "second");
  await until(() => h.inputs.size === 1);
  h.papers.get("a")!.version = "changed";
  h.releases.get("一句话解释first")!();
  await h.assistant.wait(first.id);
  await h.assistant.wait(second.id);
  assert.equal(second.status, "failed");
  assert.match(second.error!, /资料发生变化/);
  assert.equal(h.inputs.size, 1);
  await assert.rejects(
    h.assistant.submit(a.id, {
      clientMessageId: "wrong",
      mode: "live",
      question: "一句话解释",
      paperId: "b",
    }),
    /不匹配/,
  );
});

test("PPT edits share the two slots and serialize with the owning paper chat", async () => {
  const h = harness(),
    a = await h.chat(sample.id),
    b = await h.chat("b"),
    c = await h.chat("c");
  const base = await h.decks.seed(a.id, sample.id);
  const ta = await h.send(a.id, "A"),
    tb = await h.send(b.id, "B");
  await until(() => h.inputs.size === 2);
  const edit = await h.decks.start(base.id, a.id, {
    slideIndex: 1,
    question: "保存修改",
    slide: base.outline.slides[1],
  });
  assert.equal(edit.status, "queued");
  assert.equal(h.inputs.has("deck-review"), false);
  const tc = await h.send(c.id, "C");
  h.releases.get("一句话解释A")!();
  await h.assistant.wait(ta.id);
  await until(() => h.inputs.has("deck-review"));
  assert.equal(tc.status, "queued");
  await h.decks.cancel(edit.id);
  assert.equal(h.decks.get(edit.id).status, "cancelled");
  await until(() => h.inputs.has("一句话解释C"));
  h.releases.get("一句话解释B")!();
  h.releases.get("一句话解释C")!();
  await Promise.all([h.assistant.wait(tb.id), h.assistant.wait(tc.id)]);
  assert.equal(h.max(), 2);
});

test("main chat migrates the newest historical discussion once and remains stable after other histories are used", async () => {
  const h = harness();
  const old = await h.conversations.create({ paperId: "a" });
  const recent = await h.conversations.create({ paperId: "a" });
  await h.conversations.update(recent.id, (s) => ({ ...s, goal: "最新讨论" }));
  const [main, same] = await Promise.all([
    h.conversations.mainForPaper("a"),
    h.conversations.mainForPaper("a"),
  ]);
  assert.equal(main.id, recent.id);
  assert.equal(same.id, main.id);
  await h.conversations.update(old.id, (s) => ({ ...s, goal: "回看旧讨论" }));
  const restored = new ConversationStore(h.persist);
  await restored.restore(h.loader);
  assert.equal((await restored.mainForPaper("a")).id, main.id);
  assert.equal(restored.get(old.id).goal, "回看旧讨论");
  assert.equal(restored.states.size, 2);
});

test("restart interrupts running and queued tasks and does not repeat model calls", async () => {
  const h = harness(),
    a = await h.chat("a");
  const first = await h.send(a.id, "first"),
    queued = await h.send(a.id, "queued");
  await until(() => h.inputs.size === 1);
  const restored = new AssistantService(
    h.provider,
    new TaskManager(h.provider, h.persist),
    new ConversationStore(h.persist),
    async (id) => h.papers.get(id)!,
    h.persist,
  );
  await restored.restore(h.loader);
  assert.equal(restored.turns.get(first.id)!.status, "interrupted");
  assert.equal(restored.turns.get(queued.id)!.status, "interrupted");
  assert.equal(restored.turns.get(queued.id)!.budget.attempts.length, 0);
  assert.equal(h.inputs.size, 1);
  assert.equal(restored.busy, false);
  await Promise.all([
    h.assistant.cancel(queued.id),
    h.assistant.cancel(first.id),
  ]);
});

test("import retries reuse the same paper across concurrent submissions and restart, and reject another file", async () => {
  const h = harness(),
    imports = new PaperImports(h.persist, h.load);
  let count = 0;
  const parse = async (id: string) => {
    count++;
    const paper = { ...sample, id };
    await h.persist("papers", id, paper);
    return { paper };
  };
  const [a, b] = await Promise.all([
    imports.run("retry", "hash", parse),
    imports.run("retry", "hash", parse),
  ]);
  assert.equal(count, 1);
  assert.equal(a.paper.id, b.paper.id);
  const restored = new PaperImports(h.persist, h.load);
  assert.equal(
    (await restored.run("retry", "hash", parse)).paper.id,
    a.paper.id,
  );
  await assert.rejects(
    restored.run("retry", "other-hash", parse),
    /另一个文件/,
  );
  assert.equal(count, 1);
});

test("PDF parsing uses a separate single slot while model tasks remain available", async () => {
  const h = harness(),
    imports = new PaperImports(h.persist, h.load);
  let running = 0,
    max = 0,
    release!: () => void;
  const parse = async (id: string) => {
    running++;
    max = Math.max(max, running);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    running--;
    return { paper: { ...sample, id } };
  };
  const first = imports.run("first", "hash1", parse),
    second = imports.run("second", "hash2", parse);
  await until(() => running === 1);
  const a = await h.chat("a"),
    turn = await h.send(a.id, "A");
  await until(() => h.inputs.size === 1);
  release();
  await first;
  await until(() => running === 1);
  release();
  await second;
  h.releases.get("一句话解释A")!();
  await h.assistant.wait(turn.id);
  assert.equal(max, 1);
  assert.equal(turn.status, "completed", turn.error);
});
