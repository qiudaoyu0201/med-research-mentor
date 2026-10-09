import type { Root, RootContent } from "mdast";
import type { VFile } from "vfile";

// CommonMark treats a closing CJK bracket followed by a CJK letter as an
// intraword delimiter. Recover only those literal model-authored bold spans;
// code, escaped markdown and already parsed emphasis are left to CommonMark.
export function remarkCjkStrong() {
  return (tree: Root, file: VFile) => {
    const source = String(file);
    const walk = (parent: { children: RootContent[] }) => {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if (node.type !== "text") {
          if ("children" in node && node.type !== "strong")
            walk(node as { children: RootContent[] });
          return [node];
        }
        const start = node.position?.start.offset,
          end = node.position?.end.offset;
        if (
          start === undefined ||
          end === undefined ||
          source.slice(start, end) !== node.value
        )
          return [node];
        const pieces: RootContent[] = [];
        let cursor = 0;
        for (const match of node.value.matchAll(/\*\*([^*\n]+)\*\*/g)) {
          const content = match[1];
          if (
            !/[\p{Script=Han}]/u.test(content) ||
            !/[）】》」』：，。！？]$/u.test(content)
          )
            continue;
          if (match.index > cursor)
            pieces.push({
              type: "text",
              value: node.value.slice(cursor, match.index),
            });
          pieces.push({
            type: "strong",
            children: [{ type: "text", value: content }],
          });
          cursor = match.index + match[0].length;
        }
        if (!pieces.length) return [node];
        if (cursor < node.value.length)
          pieces.push({ type: "text", value: node.value.slice(cursor) });
        return pieces;
      });
    };
    walk(tree);
  };
}
