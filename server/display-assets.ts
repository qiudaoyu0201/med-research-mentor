import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfRuntime } from "./pdf-runtime.ts";
import type { PaperBundle, Source } from "../shared/types.ts";
import { root, read, save, safeId, missingRecord } from "./storage.ts";
import { samplePdf } from "./sample.ts";
import { digest } from "./materials.ts";
import {
  validRegion,
  cropPixels,
  type ImageRegion,
} from "../shared/image-region.ts";

export interface DisplayAsset {
  image: string;
  width: number;
  height: number;
  purpose: "page" | "original" | "legacy" | "crop";
}
// Immutable derivatives are bound when a new deck is saved. Existing versions
// retain their original source hash and image; viewing never upgrades a version.
export async function saveDisplayAsset(
  paper: PaperBundle,
  source: Source,
  crop?: ImageRegion,
) {
  if (crop && !validRegion(crop)) throw new Error("图件裁剪区域无效。");
  let bytes: Buffer, purpose: DisplayAsset["purpose"];
  if (source.displayImage?.includes("/attachments/") && source.attachmentId) {
    const original = await read<{ base64: string }>(
      "attachment-originals",
      safeId(source.attachmentId),
    );
    bytes = Buffer.from(original.base64, "base64");
    purpose = "original";
  } else if (
    paper.pdfUrl &&
    source.page &&
    !(
      source.image &&
      !source.imageRegion &&
      (source.imagePurpose === "figure" || source.figure === "用户圈选")
    )
  ) {
    bytes = await readFile(
      paper.id === "xu-2018"
        ? samplePdf
        : join(root, "uploads", `${safeId(paper.id)}.pdf`),
    );
    purpose = "page";
  } else {
    bytes = Buffer.from(source.image!.split(",")[1], "base64");
    purpose = "legacy";
  }
  const id = digest({
    bytes: bytes.toString("base64"),
    page: source.page,
    purpose,
    targetWidth: 3200,
    renderer: "display-v2-jbig2",
    ...(source.imageRegion ? { region: source.imageRegion } : {}),
    ...(crop ? { crop } : {}),
  });
  try {
    await read<DisplayAsset>("display-assets", id);
    return id;
  } catch (err: any) {
    if (!missingRecord(err)) throw err;
  }
  let asset: DisplayAsset;
  if (purpose === "page") {
    const task = getDocument({
      ...pdfRuntime,
      data: new Uint8Array(bytes),
      useSystemFonts: true,
    });
    try {
      const pdf = await task.promise,
        page = await pdf.getPage(source.page!),
        base = page.getViewport({ scale: 1 });
      const scale = Math.min(
          3200 / base.width,
          Math.sqrt(12_000_000 / (base.width * base.height)),
        ),
        viewport = page.getViewport({ scale });
      const canvas = createCanvas(
        Math.floor(viewport.width),
        Math.floor(viewport.height),
      );
      await page.render({
        canvas: canvas as any,
        canvasContext: canvas.getContext("2d") as any,
        viewport,
      }).promise;
      asset = {
        image: canvas.toDataURL("image/png"),
        width: canvas.width,
        height: canvas.height,
        purpose,
      };
    } finally {
      await task.destroy();
    }
  } else {
    const img = await loadImage(bytes);
    asset = {
      image: `data:image/${bytes[0] === 137 ? "png" : "jpeg"};base64,${bytes.toString("base64")}`,
      width: img.width,
      height: img.height,
      purpose,
    };
  }
  for (const region of [
    purpose === "page" ? source.imageRegion : undefined,
    crop,
  ]) {
    if (!region) continue;
    if (!validRegion(region)) throw new Error("原图定位区域无效。");
    const original = await loadImage(asset.image),
      bounds = cropPixels(region, original.width, original.height);
    const canvas = createCanvas(bounds.width, bounds.height);
    canvas
      .getContext("2d")
      .drawImage(
        original,
        bounds.left,
        bounds.top,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    asset = {
      image: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
      purpose: "crop",
    };
  }
  await save("display-assets", id, asset);
  return id;
}
