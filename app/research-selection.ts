// Both endpoints must belong to the displayed paragraph. Preserve the actual
// selected substring, including its punctuation and interior whitespace.
export function selectedText(element: HTMLElement, source: string) {
  const selection = window.getSelection();
  const text = selection?.toString();
  return text?.trim() &&
    text.length <= 2000 &&
    source.includes(text) &&
    selection?.anchorNode &&
    selection.focusNode &&
    element.contains(selection.anchorNode) &&
    element.contains(selection.focusNode)
    ? text
    : undefined;
}
