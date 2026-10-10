import { randomUUID } from "node:crypto";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { DeckVersions } from "../server/deck-versions.ts";
import { CodexProvider } from "../server/provider.ts";
import { localSample } from "../server/sample.ts";
import { ConversationStore } from "../server/conversation.ts";
import { save } from "../server/storage.ts";
const id = randomUUID(),
  paper = await localSample();
const report: any = {
  id,
  status: "running",
  limits: { productCalls: 4, seconds: 480 },
  limitation:
    "固定八页示例只验证第二页修改；不替代历史三页汇报验收或真人学习效果。",
};
console.log(
  "单页修改行为检查：最多四次调用、一次具体修订、480 秒；失败保留，不自动重发。",
);
const conversations = new ConversationStore(),
  state = await conversations.create({ paperId: paper.id });
const store = new DeckVersions(new CodexProvider(), async () => paper);
try {
  const parent = await store.seed(state.id, paper.id);
  report.parent = parent.id;
  const started = await store.start(parent.id, state.id, {
    slideIndex: 1,
    question:
      "修改第二页，把研究问题写得更通俗。保留相关不等于因果的边界，不增加数值或新结论。",
  });
  const version = await store.wait(started.id);
  report.version = version;
  await save("deck-reports", id, report);
  assert.equal(version.status, "completed", version.error);
  for (let i = 0; i < parent.outline.slides.length; i++)
    if (i !== 1)
      assert.deepEqual(version.outline.slides[i], parent.outline.slides[i]);
  const artifact = await store.export(version.id, state.id);
  report.artifact = artifact;
  const zip = unzipSync(
    new Uint8Array(await readFile(`exports/${artifact.id}.pptx`)),
  );
  assert.equal(
    Object.keys(zip).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .length,
    8,
  );
  assert.equal(
    Object.keys(zip).filter((p) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p),
    ).length,
    8,
  );
  const restored = await store.restoreVersion(version.id, parent.id, state.id);
  assert.deepEqual(restored.outline, parent.outline);
  report.restored = restored.id;
  report.status = "behavior-observed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
}
await save("deck-reports", id, report);
await mkdir("runs", { recursive: true });
await writeFile("runs/deck-check.json", JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      id,
      status: report.status,
      error: report.error,
      calls: report.version?.budget?.attempts.length,
      slide: report.version?.outline.slides[1],
      artifact: report.artifact,
      restored: report.restored,
    },
    null,
    2,
  ),
);
