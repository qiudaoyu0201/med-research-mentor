import { sample, defaultDeck } from "../examples/bundle.ts";
import { RecordStorage } from "../server/storage.ts";
import { ConversationStore } from "../server/conversation.ts";
import { digest } from "../server/materials.ts";
import { withFoundationSources } from "../server/foundations.ts";
import type { DeckVersion } from "../shared/types.ts";
import { createCanvas } from "@napi-rs/canvas";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function lifecycleFixture(directory: string) {
  const storage = new RecordStorage(directory);
  const persist = storage.save.bind(storage);
  const paper = withFoundationSources({
    ...structuredClone(sample),
    id: "lifecycle-paper",
    title: "生命周期验收论文",
  });
  paper.pdfUrl = `/api/papers/${paper.id}/pdf`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await mkdir(join(directory, "uploads"), { recursive: true });
  await writeFile(join(directory, "uploads", `${paper.id}.pdf`), pdf);
  const canvas = createCanvas(160, 100);
  canvas.getContext("2d").fillRect(20, 20, 110, 60);
  for (const source of paper.sources) {
    if (defaultDeck.slides.some((slide) => slide.imageSource === source.id)) {
      source.image = canvas.toDataURL("image/png");
      source.imagePurpose = "figure";
      source.imageRegion = undefined;
    }
  }
  await persist("papers", paper.id, paper);
  const conversations = new ConversationStore(persist);
  const conversation = await conversations.create(
    { paperId: paper.id, purpose: "ppt-generation" },
    "lifecycle-ppt",
  );
  const version: DeckVersion = {
    id: "lifecycle-version",
    conversationId: conversation.id,
    paperId: paper.id,
    sourceVersion: paper.version,
    sourceIds: paper.sources.map((s) => s.id),
    sourceHash: digest(paper.sources),
    createdAt: new Date().toISOString(),
    origin: "example",
    status: "completed",
    outline: structuredClone(defaultDeck),
    review: { issues: [], checkedSources: [], limitations: [] },
    roles: [],
  };
  await persist("deck-versions", version.id, version);
  return { paper, conversation, version, pdf };
}
