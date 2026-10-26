import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { SKRSContext2D } from "@napi-rs/canvas";
import type { DeckOutline, Source } from "../shared/types.ts";
import { cropPixels, validRegion } from "../shared/image-region.ts";
import {
  slideLayout,
  slideLineHeight,
  slideSize,
  type SlideTable,
  type SlideShape,
  type TextBox,
} from "../shared/slide-layout.ts";

const scale = 120;
const canvasWidth = Math.round(slideSize.width * scale);
const canvasHeight = Math.round(slideSize.height * scale);

function color(value: string) {
  return value.startsWith("#") ? value : `#${value}`;
}

function drawShape(ctx: SKRSContext2D, shape: SlideShape) {
  const x = shape.x * scale,
    y = shape.y * scale,
    w = shape.w * scale,
    h = shape.h * scale;
  ctx.fillStyle = color(shape.fill);
  ctx.beginPath();
  switch (shape.kind) {
    case "roundRect":
      ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.08);
      break;
    case "ellipse":
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "chevron":
      ctx.moveTo(x, y);
      ctx.lineTo(x + w * 0.82, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w * 0.82, y + h);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x + w * 0.18, y + h / 2);
      break;
    case "downArrow":
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h * 0.64);
      ctx.lineTo(x + w * 0.64, y + h * 0.64);
      ctx.lineTo(x + w / 2, y + h);
      ctx.lineTo(x + w * 0.36, y + h * 0.64);
      ctx.lineTo(x, y + h * 0.64);
      break;
    default:
      ctx.rect(x, y, w, h);
      break;
  }
  ctx.fill();
}

function drawText(ctx: SKRSContext2D, box: TextBox) {
  const fontSize = (box.fontSize * scale) / 72;
  ctx.font = `${box.bold ? "700" : "400"} ${fontSize}px "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = color(box.color);
  ctx.textBaseline = "top";
  const lineHeight = fontSize * slideLineHeight;
  const x = box.x * scale;
  let y = box.y * scale;
  if (box.marker && !box.markerAbove) {
    ctx.fillText(box.marker, (box.x - 0.42) * scale, y + 2);
  } else if (box.marker) {
    ctx.fillText(box.marker, x, (box.y - 0.36) * scale);
  }
  for (const line of box.lines) {
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
}

function drawTable(ctx: SKRSContext2D, table: SlideTable) {
  let y = table.y * scale;
  for (const [rowIndex, row] of table.cellLines.entries()) {
    const rowHeight = table.rowHeights[rowIndex] * scale;
    let x = table.x * scale;
    ctx.fillStyle = color(
      rowIndex === 0 ? "12384A" : rowIndex % 2 ? "EDF4F3" : "FFFFFF",
    );
    ctx.fillRect(x, y, table.w * scale, rowHeight);
    for (const [colIndex, lines] of row.entries()) {
      const width = table.widths[colIndex] * scale;
      ctx.strokeStyle = "#DCE7E5";
      ctx.lineWidth = Math.max(1, scale / 240);
      ctx.strokeRect(x, y, width, rowHeight);
      ctx.font = `${rowIndex === 0 || colIndex === 0 ? "700" : "400"} ${(table.fontSize * scale) / 72}px "Microsoft YaHei", sans-serif`;
      ctx.fillStyle = color(rowIndex === 0 ? "FFFFFF" : "26384A");
      ctx.textBaseline = "top";
      let lineY = y + 0.12 * scale;
      for (const line of lines) {
        ctx.fillText(line, x + 0.16 * scale, lineY);
        lineY += (table.fontSize * scale * slideLineHeight) / 72;
      }
      x += width;
    }
    y += rowHeight;
  }
}

async function slideImage(
  slide: DeckOutline["slides"][number],
  sources: Source[],
) {
  const source = slide.imageSource
    ? sources.find((candidate) => candidate.id === slide.imageSource)
    : undefined;
  if (!source?.image) return undefined;
  const original = await loadImage(source.image);
  if (!slide.imageCrop) {
    return { image: original, width: original.width, height: original.height };
  }
  if (!validRegion(slide.imageCrop)) throw new Error("汇报渲染选区无效。");
  const box = cropPixels(slide.imageCrop, original.width, original.height);
  const crop = createCanvas(box.width, box.height);
  crop
    .getContext("2d")
    .drawImage(
      original,
      box.left,
      box.top,
      box.width,
      box.height,
      0,
      0,
      box.width,
      box.height,
    );
  const image = await loadImage(crop.toDataURL("image/png"));
  return { image, width: image.width, height: image.height };
}

export async function renderDeckPages(
  deck: DeckOutline,
  sources: Source[],
  outputDirectory: string,
) {
  await mkdir(outputDirectory, { recursive: true });
  const pages: string[] = [];
  const pageImages: Awaited<ReturnType<typeof loadImage>>[] = [];
  for (const [index, slide] of deck.slides.entries()) {
    const selected = await slideImage(slide, sources);
    const layout = slideLayout(
      slide,
      sources.filter((source) => slide.citations.includes(source.id)),
      selected ? { width: selected.width, height: selected.height } : undefined,
    );
    const canvas = createCanvas(canvasWidth, canvasHeight),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = color(layout.background);
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    for (const shape of layout.shapes) {
      if (
        layout.table &&
        (shape.role === "table-row" || shape.role === "table-rule")
      )
        continue;
      drawShape(ctx, shape);
    }
    for (const box of layout.text) {
      if (
        layout.table &&
        box.role === "bullet" &&
        box.sourceIndex !== undefined
      )
        continue;
      drawText(ctx, box);
    }
    if (layout.table) drawTable(ctx, layout.table);
    if (selected && layout.image) {
      ctx.drawImage(
        selected.image,
        layout.image.x * scale,
        layout.image.y * scale,
        layout.image.w * scale,
        layout.image.h * scale,
      );
    }
    ctx.font = `400 ${(10 * scale) / 72}px "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = "#65656F";
    ctx.textBaseline = "top";
    ctx.fillText(
      `${index + 1} / ${deck.slides.length}`,
      12.1 * scale,
      7.02 * scale,
    );
    const path = join(
      outputDirectory,
      `slide-${String(index + 1).padStart(2, "0")}.png`,
    );
    await writeFile(path, canvas.toBuffer("image/png"));
    pages.push(path);
    pageImages.push(await loadImage(canvas.toDataURL("image/png")));
  }
  const columns = 3,
    tileWidth = 480,
    tileHeight = 270,
    rows = Math.max(1, Math.ceil(pageImages.length / columns)),
    contact = createCanvas(columns * tileWidth, rows * tileHeight),
    contactContext = contact.getContext("2d");
  contactContext.fillStyle = "#F4F7F7";
  contactContext.fillRect(0, 0, contact.width, contact.height);
  for (const [index, image] of pageImages.entries()) {
    const x = (index % columns) * tileWidth,
      y = Math.floor(index / columns) * tileHeight;
    contactContext.drawImage(image, x, y, tileWidth, tileHeight);
  }
  const contactSheet = join(outputDirectory, "contact-sheet.png");
  await writeFile(contactSheet, contact.toBuffer("image/png"));
  return {
    renderer: "layout-preview" as const,
    pageCount: pages.length,
    pages,
    contactSheet,
  };
}

/** Render the exported bytes through Office where available. A layout preview
 * is explicitly labelled and must not clear an actual-file visual gate. */
export async function renderExportedDeckPages(
  exportPath: string,
  deck: DeckOutline,
  sources: Source[],
  outputDirectory: string,
) {
  let limitation =
    "PowerPoint rendering is available only on Windows with Office installed.";
  if (process.platform === "win32") {
    try {
      const scriptPath = fileURLToPath(
        new URL("../scripts/render-pptx.ps1", import.meta.url),
      );
      const { stdout } = await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-InputPath",
          resolve(exportPath),
          "-OutputDirectory",
          resolve(outputDirectory),
        ],
        {
          timeout: 180_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
      );
      const audit = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as {
        renderer: "powerpoint";
        pageCount: number;
        pages: string[];
      };
      if (
        audit.renderer !== "powerpoint" ||
        audit.pageCount !== deck.slides.length ||
        !Array.isArray(audit.pages) ||
        audit.pages.length !== deck.slides.length
      )
        throw new Error(
          "PowerPoint rendered page count differs from the exported deck.",
        );
      const pageImages = await Promise.all(
        audit.pages.map(async (page) => loadImage(await readFile(page))),
      );
      const columns = 3,
        tileWidth = 480,
        tileHeight = 270;
      const contact = createCanvas(
        columns * tileWidth,
        Math.max(1, Math.ceil(pageImages.length / columns)) * tileHeight,
      );
      const ctx = contact.getContext("2d");
      ctx.fillStyle = "#F4F7F7";
      ctx.fillRect(0, 0, contact.width, contact.height);
      pageImages.forEach((image, index) =>
        ctx.drawImage(
          image,
          (index % columns) * tileWidth,
          Math.floor(index / columns) * tileHeight,
          tileWidth,
          tileHeight,
        ),
      );
      const contactSheet = join(outputDirectory, "contact-sheet.png");
      await writeFile(contactSheet, contact.toBuffer("image/png"));
      return { ...audit, contactSheet };
    } catch (error) {
      limitation = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ...(await renderDeckPages(deck, sources, outputDirectory)),
    limitation,
  };
}
