import { zipSync, strToU8 } from "fflate";
import type { ResearchPlanVersion } from "../shared/research-plan.ts";

const xml = (s: string) =>
  s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const run = (s: string) =>
  `<w:r><w:t xml:space="preserve">${xml(s)}</w:t></w:r>`;
const paragraph = (s: string, style = "Normal", keepNext = false) =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/>${keepNext ? "<w:keepNext/>" : ""}</w:pPr>${run(s)}</w:p>`;
function body(text: string) {
  const lines = text.split(/\r?\n/);
  const parts: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (
      lines[i].trim().startsWith("|") &&
      lines[i + 1]?.match(/^\s*\|?\s*:?-{3,}/)
    ) {
      const rows = [lines[i]];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|"))
        rows.push(lines[i++]);
      const cells = rows.map((r) =>
        r
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim()),
      );
      const columns = Math.max(...cells.map((r) => r.length));
      if (columns > 6) {
        parts.push(...rows.map((r) => paragraph(r)));
        continue;
      }
      const width = Math.floor(9360 / columns);
      parts.push(
        `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4" w:color="B8B8B8"/>`).join("")}</w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${cells.map((row, index) => `<w:tr><w:trPr><w:cantSplit/>${index === 0 ? "<w:tblHeader/>" : ""}</w:trPr>${Array.from({ length: columns }, (_, c) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${index === 0 ? '<w:shd w:fill="EEEEEE"/>' : ""}</w:tcPr>${paragraph(row[c] ?? "", "TableText")}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`,
      );
    } else {
      if (lines[i].trim()) parts.push(paragraph(lines[i]));
      i++;
    }
  }
  return parts.join("");
}
export function planDocx(
  version: ResearchPlanVersion,
  historical = false,
): Buffer {
  const v = version,
    refs = v.topic.sources.filter((source) =>
      v.content.sections.some((section) =>
        section.sourceRefs.includes(source.id),
      ),
    );
  const cite = (ids: string[]) =>
    ids
      .map((id) => {
        const n = refs.findIndex((r) => r.id === id);
        if (n < 0) throw new Error("导出引用不存在。");
        return `[${n + 1}]`;
      })
      .join(" ");
  const links: string[] = [];
  const source = refs
    .map((r, i) => {
      const b = r.bibliography;
      const url = b?.doi ? `https://doi.org/${b.doi}` : r.url;
      const safe =
        url &&
        /^https:\/\//i.test(url) &&
        !/localhost|127\.0\.0\.1|\[::1\]/i.test(url)
          ? url
          : undefined;
      const ref = `[${i + 1}] ${b?.authors.length ? `${b.authors.join(", ")}. ` : ""}${r.title}${b ? `. ${b.journal}, ${b.year}. PMID ${b.pmid}${b.doi ? `. DOI ${b.doi}` : ""}` : ` · ${r.locator}`}`;
      let result = paragraph(ref, "Reference", Boolean(safe || b));
      if (safe) {
        links.push(safe);
        result += `<w:p><w:pPr><w:pStyle w:val="Reference"/>${b ? "<w:keepNext/>" : ""}</w:pPr><w:hyperlink r:id="link${links.length}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>${xml(safe)}</w:t></w:r></w:hyperlink></w:p>`;
      }
      if (b)
        result += paragraph(
          `实际读取：${b.level === "abstract" ? "摘要" : "元数据"}；读取时间 ${b.fetchedAt}；Crossref ${b.crossref}${b.notices.length ? `；${b.notices.join("；")}` : ""}`,
          "Reference",
        );
      return result;
    })
    .join("");
  const text = [
    paragraph(v.content.title, "Title"),
    paragraph("医学研究方案草案"),
    paragraph(`保存日期：${v.createdAt.slice(0, 10)}`),
    paragraph(`条件（用户陈述）：${v.topic.conditions || "未提供"}`),
    ...(historical
      ? [paragraph("当前课题条件已经变化，本文件对应选定历史版本。")]
      : []),
    ...v.content.sections.map(
      (s) =>
        paragraph(s.title, "Heading1") +
        body(
          `${s.kind === "hypothesis" ? "待验证假设：" : s.kind === "possible-result" ? "可能结果（尚未观察到）：" : ""}${s.text}${s.sourceRefs.length ? `${s.text.trimEnd().endsWith("|") ? "\n" : " "}${cite(s.sourceRefs)}` : ""}`,
        ) +
        paragraph(`设计理由：${s.rationale}`) +
        (s.unknowns.length
          ? paragraph(`待确认：${s.unknowns.join("；")}`)
          : ""),
    ),
    paragraph("假设与待确认", "Heading1"),
    ...[...new Set([...v.content.assumptions, ...v.content.questions])].map(
      (s) => paragraph(s),
    ),
    paragraph("研究局限", "Heading1"),
    ...[...new Set(v.content.limitations)].map((s) => paragraph(s)),
    paragraph("参考文献", "Heading1"),
    source ||
      paragraph(
        v.topic.sources.length
          ? "本版本正文未引用所提供资料，设计建议与假设仍待核实。"
          : "本版本没有提供文献依据，设计建议与假设仍待核实。",
      ),
    paragraph(
      "本文件为研究方案草案；拟议方法和假设尚需按实际资源及伦理要求确认。",
    ),
  ].join("");
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/><w:color w:val="000000"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="330" w:lineRule="auto"/><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[
    ["Title", "32"],
    ["Heading1", "27"],
    ["TableText", "20"],
  ]
    .map(
      ([name, size]) =>
        `<w:style w:type="paragraph" w:styleId="${name}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr>${name !== "TableText" ? "<w:keepNext/><w:keepLines/>" : ""}<w:spacing w:before="${name === "Heading1" ? "220" : "0"}" w:after="120"/></w:pPr><w:rPr><w:sz w:val="${size}"/>${name !== "TableText" ? "<w:b/>" : ""}<w:color w:val="000000"/></w:rPr></w:style>`,
    )
    .join(
      "",
    )}<w:style w:type="paragraph" w:styleId="Reference"><w:name w:val="Reference"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style></w:styles>`;
  const files: Record<string, Uint8Array> = {};
  const add = (name: string, content: string) => {
    files[name] = strToU8(header + content);
  };
  add(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  add(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  add(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${text}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1273" w:bottom="1200" w:left="1273" w:header="600" w:footer="600"/></w:sectPr></w:body></w:document>`,
  );
  add("word/styles.xml", styles);
  add(
    "word/_rels/document.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${links.map((url, i) => `<Relationship Id="link${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(url)}" TargetMode="External"/>`).join("")}</Relationships>`,
  );
  return Buffer.from(zipSync(files, { level: 6 }));
}
