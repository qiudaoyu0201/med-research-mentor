import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
export const pdfExtractionVersion = "pdf-figures-v5-caption-anchors";
// Node factories read local paths; no network download or process-CWD reliance.
export const pdfRuntime = {
  wasmUrl: join(root, "wasm").replaceAll("\\", "/") + "/",
  cMapUrl: join(root, "cmaps").replaceAll("\\", "/") + "/",
  cMapPacked: true,
  standardFontDataUrl: join(root, "standard_fonts").replaceAll("\\", "/") + "/",
  useSystemFonts: true,
};
