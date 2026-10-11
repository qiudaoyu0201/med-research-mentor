import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { exportDeck } from "../server/export.ts";
import { safeId } from "../server/storage.ts";

// Prepare an existing reviewed deck without changing any conversation or server.
const versionId = safeId(process.argv[2] ?? "");
const outputId = safeId(process.argv[3] ?? "");
const version = JSON.parse(
  await readFile(resolve("data/deck-versions", `${versionId}.json`), "utf8"),
);
if (
  version.status !== "completed" ||
  version.review.issues.some(
    (i: { resolved: boolean; severity: string }) =>
      !i.resolved && i.severity === "blocking",
  )
) {
  throw new Error(
    "A completed deck without unresolved blocking issues is required.",
  );
}
const paper = JSON.parse(
  await readFile(
    resolve("data/papers", `${safeId(version.paperId)}.json`),
    "utf8",
  ),
);
const output = resolve("runs", outputId);
await mkdir(output); // Refuse to overwrite previous preparation.
await exportDeck(version.outline, paper, outputId);
const pptx = resolve("exports", `${outputId}.pptx`);
const zip = unzipSync(await readFile(pptx));
const slides = Object.keys(zip).filter((p) =>
  /^ppt\/slides\/slide\d+\.xml$/.test(p),
);
if (slides.length !== version.outline.slides.length)
  throw new Error("Slide count mismatch.");
await copyFile(pptx, resolve(output, "预备汇报.pptx"));
await writeFile(
  resolve(output, "讲述提示.md"),
  version.outline.slides
    .map(
      (s: { title: string; notes: string }, i: number) =>
        `## ${i + 1}. ${s.title}\n\n${s.notes}`,
    )
    .join("\n\n"),
);
await writeFile(
  resolve(output, "固定问题.txt"),
  "6页，给老师的组会汇报，讲清研究背景、实验思路、关键对照、主要结果和局限。讲述提示单独提供，不放入幻灯片。\n",
);
await writeFile(
  resolve(output, "provenance.json"),
  JSON.stringify(
    {
      versionId,
      runId: version.runId,
      paperId: version.paperId,
      sourceVersion: version.sourceVersion,
      preparedAt: new Date().toISOString(),
      slides: slides.length,
      mode: "reexport-existing-reviewed-deck",
      frontendReplayInstalled: false,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    output,
    slides: slides.length,
    images: Object.keys(zip).filter((p) => p.startsWith("ppt/media/")).length,
  }),
);
