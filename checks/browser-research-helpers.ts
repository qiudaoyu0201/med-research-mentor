import type { Page } from "playwright";
export async function selectPdf(page: Page, start = 0, end = 70) {
  const span = page.locator(".rw-pdf-page .textLayer span").first();
  await span.waitFor();
  return span.evaluate(
    (element, [from, to]) => {
      const range = document.createRange(),
        text = element.firstChild!;
      range.setStart(text, Math.min(from, text.textContent!.length));
      range.setEnd(text, Math.min(to, text.textContent!.length));
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return selection.toString();
    },
    [start, end],
  );
}
export async function currentAction(
  page: Page,
  action: string,
  parent?: string,
) {
  await page
    .getByRole("button", { name: "当前论文更多操作", exact: true })
    .click();
  if (parent)
    await page.getByRole("menuitem", { name: parent, exact: false }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}
export async function answerAction(
  page: Page,
  id: string,
  action: string,
  parent?: string,
) {
  await page
    .locator(`[data-turn-id="${id}"]`)
    .getByRole("button", { name: "回答操作", exact: true })
    .click();
  if (parent)
    await page.getByRole("menuitem", { name: parent, exact: false }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}
