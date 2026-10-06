import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { sample } from "../examples/bundle.ts";
import { parsePdf } from "./pdf.ts";
import { figureOneEvidence, digest } from "./materials.ts";
import { read, save, missingRecord } from "./storage.ts";

export const samplePdf = resolve(
  "data/papers/Xu_2018_Senolytics/Xu_2018_NatureMedicine_Senolytics_fulltext.pdf",
);
export async function localSample() {
  const result = structuredClone(sample);
  let bytes: Buffer;
  try {
    bytes = await readFile(samplePdf);
  } catch (error: any) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  const parsed = await parsePdf(samplePdf, "xu-original", sample.title);
  if (!parsed.sources.some((s) => s.text.includes("s41591-018-0092-9")))
    throw new Error("示例正文 DOI 不匹配。");
  result.version =
    "local-pdf-" +
    createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  result.pdfUrl = `/api/papers/${sample.id}/pdf`;
  result.pageCount = parsed.pageCount;
  result.parseStatus = parsed.parseStatus;
  result.scope =
    "已接入本机 Xu 2018 期刊正文 PDF（含文件自带的报告页）。页序按 PDF；原文为自动提取，尚未逐段人工校对。本次只做局部带读，不使用独立补充材料。";
  const pages: Record<string, number> = {
    "xu-question": 1,
    "xu-design": 2,
    "xu-fig1": 2,
    "xu-fig6": 8,
  };
  for (const source of result.sources) {
    const page = pages[source.id];
    if (!page) continue;
    source.page = page;
    source.text = parsed.sources[page - 1].text;
    if (source.figure) {
      const figure = source.figure.startsWith("6") ? "6" : "1";
      const match = new RegExp(`Fig\\.\\s*${figure}\\s*\\|`).exec(source.text);
      source.caption = match
        ? source.text.slice(match.index).split("N AT u RE")[0].trim()
        : "图注未可靠提取，请在阅读器核对原页。";
      if (match) source.text = source.caption;
      source.section = "figure";
    } else {
      source.section = "overview";
    }
    source.locator = `正文 PDF 第 ${page} 页；自动提取，未逐段校对`;
    source.verified = false;
  }
  result.sources.push(...parsed.sources);
  const evidence = figureOneEvidence(parsed.sources);
  result.sources.push(...evidence);
  result.version += "-fig1-v2-" + digest(evidence).slice(0, 12);
  // 原始整页保留图件与图注；用户仍可在阅读器圈选单个面板。
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  });
  try {
    const pdf = await task.promise;
    for (const id of ["xu-fig1", "xu-fig6"]) {
      const source = result.sources.find((s) => s.id === id)!;
      const imageKey =
        createHash("sha256").update(bytes).digest("hex") +
        `-page-${source.page}-scale13-v1`;
      try {
        source.image = await read<string>("material-cache", imageKey);
        source.locator += "；图像为图件所在原页";
        continue;
      } catch (error: any) {
        if (!missingRecord(error)) throw error;
      }
      const page = await pdf.getPage(source.page!);
      const viewport = page.getViewport({ scale: 1.3 });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({
        canvas: canvas as any,
        canvasContext: canvas.getContext("2d") as any,
        viewport,
      }).promise;
      source.image = canvas.toDataURL("image/png");
      await save("material-cache", imageKey, source.image);
      source.locator += "；图像为图件所在原页";
    }
  } finally {
    await task.destroy();
  }
  await save(
    "material-snapshots",
    "xu-fig1-" + digest({ version: result.version, evidence }).slice(0, 16),
    {
      parserVersion: "figure1-excerpts-v2",
      sourceVersion: result.version,
      sources: [result.sources.find((s) => s.id === "xu-fig1"), ...evidence],
    },
  );
  return result;
}
