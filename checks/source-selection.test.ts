import test from "node:test";
import assert from "node:assert/strict";
import { selectedText } from "../app/research-selection.ts";

function selection(
  text: string,
  action: (element: HTMLElement) => void,
  outside = false,
) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const anchor = {},
    focus = outside ? {} : anchor;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      getSelection: () => ({
        toString: () => text,
        anchorNode: anchor,
        focusNode: focus,
      }),
    },
  });
  try {
    action({ contains: (node: unknown) => node === anchor } as HTMLElement);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("literal original-source punctuation remains selectable without Markdown interpretation", () => {
  for (const text of [
    "Use [control](method) as written.",
    "Value <i> not markup",
    "The variable a_b_c is measured.",
  ]) {
    selection(text, (element) =>
      assert.equal(selectedText(element, text, "plain"), text),
    );
  }
});

test("rendered answer quotes accept formatted labels but reject hidden destinations", () => {
  const source =
    "Compare **control** with [treatment](https://example.test/hidden-secret).";
  selection("control with treatment", (element) =>
    assert.equal(
      selectedText(element, source, "markdown"),
      "control with treatment",
    ),
  );
  selection("hidden-secret", (element) =>
    assert.equal(selectedText(element, source, "markdown"), undefined),
  );
  selection("https://example.test/hidden-secret", (element) =>
    assert.equal(selectedText(element, source, "markdown"), undefined),
  );
});

test("both quote modes enforce ownership of the entire selection and reject invented text", () => {
  for (const format of ["plain", "markdown"] as const) {
    selection(
      "visible text",
      (element) =>
        assert.equal(selectedText(element, "visible text", format), undefined),
      true,
    );
    selection("invented text", (element) =>
      assert.equal(selectedText(element, "visible text", format), undefined),
    );
    selection("visible\ntext", (element) =>
      assert.equal(
        selectedText(element, "visible text", format),
        "visible\ntext",
      ),
    );
  }
});
