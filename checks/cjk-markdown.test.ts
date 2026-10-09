import test from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root } from "mdast";
import { remarkCjkStrong } from "../app/remark-cjk-strong.ts";

async function parse(text: string) {
  const processor = unified().use(remarkParse).use(remarkCjkStrong);
  return (await processor.run(processor.parse(text), { value: text })) as Root;
}
test("中文括号结束的术语能正常加粗", async () => {
  const tree = await parse("**细胞衰老（cellular senescence）**指停止分裂。");
  assert.equal(tree.children[0].type, "paragraph");
  const children = (tree.children[0] as any).children;
  assert.equal(children[0].type, "strong");
  assert.equal(
    children[0].children[0].value,
    "细胞衰老（cellular senescence）",
  );
  assert.equal(children[1].value, "指停止分裂。");
});
test("代码、转义星号、普通强调及公式不被重写", async () => {
  for (const text of [
    "`**端粒（telomere）**可以`",
    "\\*\\*端粒（telomere）\\*\\*可以",
    "```text\n**端粒（telomere）**可以\n```",
    "**正常加粗** 与 *普通斜体*",
    "2 ** 3 与 x*y",
  ]) {
    const original = unified().use(remarkParse).parse(text);
    assert.deepEqual(await parse(text), original, text);
  }
});
