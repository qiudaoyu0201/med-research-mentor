import { posix } from "node:path";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
// PptxGenJS 4.0.1 declares a slide master per slide but writes only one.
// Remove only unused declarations; a missing referenced part is a real failure.
export function completePptxPackage(bytes: Uint8Array): Uint8Array {
  const parts = unzipSync(bytes),
    types = parts["[Content_Types].xml"];
  if (!types) throw new Error("PPTX导出缺少内容类型表。");
  const referenced = new Set<string>();
  for (const [name, value] of Object.entries(parts)) {
    if (!name.endsWith(".rels")) continue;
    const folder = posix.dirname(posix.dirname(name));
    for (const [tag] of strFromU8(value).matchAll(/<Relationship\b[^>]*\/>/g)) {
      if (/\bTargetMode="External"/.test(tag)) continue;
      const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
      if (target)
        referenced.add(
          target.startsWith("/")
            ? target.slice(1)
            : posix.normalize(posix.join(folder === "." ? "" : folder, target)),
        );
    }
  }
  let changed = false;
  const fixed = strFromU8(types).replace(
    /<Override\b[^>]*\bPartName="([^"]+)"[^>]*\/>/g,
    (tag, part: string) => {
      const name = part.replace(/^\//, "");
      if (parts[name]) return tag;
      if (
        !/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name) ||
        referenced.has(name)
      )
        throw new Error("PPTX导出缺少必要部件：" + name);
      changed = true;
      return "";
    },
  );
  if (!changed) return bytes;
  parts["[Content_Types].xml"] = strToU8(fixed);
  return zipSync(parts, { level: 6 });
}
