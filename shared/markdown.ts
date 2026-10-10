import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);
type Node = {
  type: string;
  value?: string;
  alt?: string | null;
  children?: Node[];
};
function visible(node: Node): string {
  if (node.type === "html" || node.type === "definition") return "";
  if (node.type === "image") return node.alt ?? "";
  if (node.type === "break") return "\n";
  if (node.value !== undefined) return node.value;
  const inline = [
    "paragraph",
    "heading",
    "emphasis",
    "strong",
    "delete",
    "link",
    "linkReference",
    "tableCell",
  ].includes(node.type);
  return (node.children ?? []).map(visible).join(inline ? "" : "\n");
}
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

// Use the renderer's Markdown grammar. A quote is plain selected text, never
// markup; link destinations and hidden HTML cannot count as visible content.
export function markdownText(value: string) {
  return normalized(visible(parser.parse(value)));
}
export function containsRenderedQuote(source: string, quote: string) {
  const text = normalized(quote);
  return !!text && markdownText(source).includes(text);
}
