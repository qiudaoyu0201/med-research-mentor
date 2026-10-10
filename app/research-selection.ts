// Both endpoints must belong to the displayed paragraph. Preserve the actual
// selected substring, including its punctuation and interior whitespace.
import { containsRenderedQuote } from "../shared/markdown.ts";
export function selectedText(
  element: HTMLElement,
  source: string,
  format: "plain" | "markdown",
) {
  const selection = window.getSelection();
  const text = selection?.toString();
  return text?.trim() &&
    text.length <= 2000 &&
    (format === "markdown"
      ? containsRenderedQuote(source, text)
      : source
          .replace(/\s+/g, " ")
          .includes(text.replace(/\s+/g, " ").trim())) &&
    selection?.anchorNode &&
    selection.focusNode &&
    element.contains(selection.anchorNode) &&
    element.contains(selection.focusNode)
    ? text
    : undefined;
}
