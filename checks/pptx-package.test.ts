import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { completePptxPackage } from "../server/pptx-package.ts";
const master = "ppt/slideMasters/slideMaster2.xml";
const types = (name: string) =>
  strToU8(
    '<Types><Override PartName="/' + name + '" ContentType="test"/></Types>',
  );
test("only an unused missing master declaration is removed, preserving every actual part", () => {
  const parts = {
    "[Content_Types].xml": types(master),
    "ppt/slides/slide1.xml": strToU8("editable text"),
    "ppt/media/image1.png": new Uint8Array([1, 2, 3]),
  };
  const result = unzipSync(completePptxPackage(zipSync(parts)));
  assert.equal(strFromU8(result["[Content_Types].xml"]), "<Types></Types>");
  for (const name of ["ppt/slides/slide1.xml", "ppt/media/image1.png"])
    assert.deepEqual(result[name], parts[name as keyof typeof parts]);
});
test("missing referenced masters and other declared parts cannot be hidden", () => {
  const parts = {
    "[Content_Types].xml": types(master),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<Relationships><Relationship Target="slideMasters/slideMaster2.xml"/></Relationships>',
    ),
  };
  assert.throws(() => completePptxPackage(zipSync(parts)), /必要部件/);
  assert.throws(
    () =>
      completePptxPackage(
        zipSync({ "[Content_Types].xml": types("ppt/slides/slide2.xml") }),
      ),
    /必要部件/,
  );
});
test("complete PPTX data is returned unchanged", () => {
  const parts = {
    "[Content_Types].xml": types(master),
    [master]: strToU8("master"),
  };
  const bytes = zipSync(parts);
  assert.equal(completePptxPackage(bytes), bytes);
});
