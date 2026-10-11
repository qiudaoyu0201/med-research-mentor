import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaperBundle } from "../shared/types.ts";
import { root, safeId } from "./storage.ts";
import { samplePdf } from "./sample.ts";

export function paperPdfPath(paper: PaperBundle) {
  return paper.pdfAssetId
    ? join(root, "evidence-pdfs", `${safeId(paper.pdfAssetId)}.pdf`)
    : paper.id === "xu-2018"
      ? samplePdf
      : join(root, "uploads", `${safeId(paper.id)}.pdf`);
}

/** Freeze the PDF as well as extracted text before publishing an artifact. */
export async function snapshotPaper(paper: PaperBundle): Promise<PaperBundle> {
  const snapshot = structuredClone(paper);
  if (!paper.pdfUrl) return snapshot;
  const bytes = await readFile(paperPdfPath(paper));
  const id = createHash("sha256").update(bytes).digest("hex");
  await mkdir(join(root, "evidence-pdfs"), { recursive: true });
  try {
    await writeFile(join(root, "evidence-pdfs", `${id}.pdf`), bytes, {
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  snapshot.pdfAssetId = id;
  snapshot.pdfUrl = `/api/evidence-pdfs/${id}`;
  return snapshot;
}
