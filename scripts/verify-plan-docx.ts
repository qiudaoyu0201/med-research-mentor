import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { unzipSync, strFromU8 } from "fflate";
import { planDocx } from "../server/plan-docx.ts";
import { digest } from "../server/materials.ts";
import type {
  ResearchPlanVersion,
  SourceRef,
} from "../shared/research-plan.ts";

// This is an export/render fixture, not a real scientific proposal or evidence claim.
const folder = resolve("runs/workflow-v16/docx");
const source: SourceRef = {
  id: "pmid-12345",
  sourceType: "pubmed",
  kind: "paper",
  title: "公开书目链接渲染夹具",
  locator: "书目元数据夹具",
  excerpt: "用于版式与链接验证，不支持科学结论。",
  hash: digest("用于版式与链接验证，不支持科学结论。"),
  verified: false,
  url: "https://pubmed.ncbi.nlm.nih.gov/12345/",
  bibliography: {
    pmid: "12345",
    authors: ["中文作者", "Fixture Author"],
    year: "2026",
    journal: "渲染夹具期刊",
    level: "metadata",
    fetchedAt: "2026-10-08T00:00:00.000Z",
    crossref: "no-doi",
    notices: ["这是确定性测试数据，未检索或核实文献内容"],
  },
};
const sections = [
  [
    "背景与文献现状",
    "本文件验证完整中文方案的导出与阅读版式。医学问题需要结合研究对象、测量尺度和原文证据解释。这里采用公开书目链接夹具，不把链接存在当作科学主张已经验证。",
  ],
  [
    "研究缺口与意义",
    "拟确认疾病相关信号能否在当前条件下稳定测量，并界定观察关联能够支持的结论。研究意义须建立在实际文献比较和可行性分析上；本夹具没有完成这样的评审，不宣称创新性已经证实。",
  ],
  [
    "目标与假设",
    "拟比较预先定义的条件与操作对照，检验信号变化是否符合待验证假设。假设写作示例：A < B、B > C、A & B 同时变化；标签包含引号 \"signal\" 和单引号 'control'，验证特殊字符在 Word 中完整保留。",
  ],
  [
    "总体设计与技术路线",
    "技术路线从问题界定开始，依次完成材料核实、测量可行性、预实验、正式测量和分析。下表用于比较阶段任务与判读条件。\n| 阶段 | 核心任务 | 对照与质控 | 输出与边界 |\n| --- | --- | --- | --- |\n| 准备 | 核实材料和测量原理 | 保存批次与设备信息 | 可行性记录 |\n| 预实验 | 估计变异并检查操作稳定性 | 操作对照与重复测量 | 样本量输入，待统计核实 |\n| 正式测量 | 按预定顺序采集数据 | 盲法编码和批次控制 | 实测记录，当前尚未开展 |\n| 分析 | 报告效应与不确定性 | 检查缺失和模型假设 | 条件性结论与限制 |",
  ],
  [
    "对象材料与纳排",
    "研究对象、材料来源和纳排标准由实际研究类型决定。拟预先说明目标总体、测量单位和不能纳入的情形，记录排除原因。设备、样本来源与人员资源尚未提供；不凭空填入材料型号和操作浓度。",
  ],
  [
    "对照变量与混杂",
    "对照用于区分目标因素变化与背景波动。拟识别会同时影响条件分配和读数的变量，说明如何记录、限制或调整。若不能随机分配，应明确残余混杂仍可能存在，观察差异不能直接解释为因果效应。",
  ],
  [
    "测量与质量控制",
    "拟说明每个读数代表什么、测量误差从哪里产生，以及异常值和缺失如何记录。批次信息、操作顺序和原始文件保持可追溯。质量控制用于发现测量不稳定，不能以漂亮图形替代原始记录和重复性检查。",
  ],
  [
    "统计与样本量依据",
    "样本量待效应量、变异、实验单位和误差控制要求确认后确定。拟报告估计值与不确定性，并检查分析假设。没有预实验或可核实依据时，不生成具体样本数，不把技术重复当作独立对象重复。",
  ],
  [
    "可行性资源与风险",
    "拟结合设备、材料、人员时间和经费条件判断是否能完成核心测量。关键资源缺失时，先缩小目标或更换可验证的测量方式。风险记录包括材料不可得、测量失败和解释边界，不把资源假设写成既有事实。",
  ],
  [
    "伦理与数据管理",
    "涉及人体、动物或敏感数据时，应依实际机构流程完成相应审查。本夹具不代表伦理批准。拟保存原始数据、处理记录和版本信息；公开共享范围由实际许可与数据条件确定，当前均待确认。",
  ],
  [
    "进度与交付",
    "进度按准备、预实验、正式测量、分析与讨论安排，具体日期依资源核实后制定。阶段交付采用可检查的记录和分析产物，发现核心问题时先修订设计。本文件验证中文内容、表格、链接和多页分页，不证明科研方案可以直接执行。",
  ],
  [
    "预期贡献与可能结果",
    "可能观察到条件差异，也可能没有稳定差异；两者均尚未发生。拟依据读数质量、对照表现和不确定性讨论结果。贡献限于实际设计和证据能够支持的范围，不能预先写成已获得机制证明或临床获益。",
  ],
] as const;
const version: ResearchPlanVersion = {
  id: "docx-full-plan-fixture",
  parentId: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  origin: "user",
  topic: {
    id: "fixture-topic",
    version: "fixture-topic-v1",
    question: "疾病相关信号的测量与条件性研究设计",
    conditions: "仅用于导出版式验证；材料、设备、效应量和样本量待确认。",
    studyTypes: ["basic-translational"],
    typeStatus: "provisional",
    sources: [source],
    learningPreferences: { verbosity: "standard", focus: "balanced" },
    createdAt: "2026-10-08T00:00:00.000Z",
  },
  content: {
    title: "医学科研完整方案导出验证夹具",
    sections: sections.map(([title, text], index) => ({
      id: `section-${index + 1}`,
      title,
      text,
      rationale: "依据本节问题说明设计与条件的联系，保留尚未核实的边界。",
      kind:
        index === 2
          ? "hypothesis"
          : index === 11
            ? "possible-result"
            : "proposal",
      sourceRefs: index === 0 ? [source.id] : [],
      unknowns: index === 7 ? ["效应量、变异和独立实验单位待核实"] : [],
      author: "user",
    })),
    assumptions: ["这是确定性测试夹具，未调用模型或查询真实文献。"],
    questions: ["实际研究材料与设备条件是什么？"],
    limitations: [
      "用于文件打开与版式验证，不构成科学质量、创新性或伦理资格评审。",
    ],
  },
};

await mkdir(folder, { recursive: true });
const docx = planDocx(version);
const docxPath = join(folder, "full-plan-fixture.docx");
await writeFile(docxPath, docx);
await writeFile(join(folder, "fixture.json"), JSON.stringify(version, null, 2));
const parts = unzipSync(docx);
const documentXml = strFromU8(parts["word/document.xml"]);
assert.equal(
  (documentXml.match(/w:pStyle w:val="Heading1"/g) ?? []).length,
  15,
);
assert.equal((documentXml.match(/<w:tbl>/g) ?? []).length, 1);
assert.match(documentXml, /A &lt; B/);
assert.match(documentXml, /A &amp; B/);
assert.match(
  strFromU8(parts["word/_rels/document.xml.rels"]),
  /https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/12345\//,
);
const wordScript = resolve("scripts/render-plan-docx.ps1");
const word = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    wordScript,
    "-DocxPath",
    docxPath,
    "-OutputDirectory",
    folder,
  ],
  { encoding: "utf8", windowsHide: true, timeout: 90_000 },
);
if (word?.error || (word && word.status !== 0)) {
  const cleanup = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      wordScript,
      "-DocxPath",
      docxPath,
      "-OutputDirectory",
      folder,
      "-CleanupOnly",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  await writeFile(
    join(folder, "word-failure-report.json"),
    JSON.stringify(
      {
        modelCalls: 0,
        status: "failed",
        error: word.error?.message ?? word.stderr,
        stdout: word.stdout,
        cleanup: {
          status: cleanup.status,
          stdout: cleanup.stdout,
          error: cleanup.error?.message,
        },
        source: docxPath,
        rendered: false,
      },
      null,
      2,
    ),
  );
  throw word.error ?? new Error(`${word.stderr}\n${word.stdout}`);
}
const wordReport = JSON.parse(
  (await readFile(join(folder, "word-open-report.json"), "utf8")).replace(
    /^\uFEFF/,
    "",
  ),
);
if (wordReport) {
  assert.equal(wordReport.openedReadOnly, true);
  assert.equal(wordReport.hidden, true);
  assert.equal(wordReport.tables, 1);
  assert.equal(wordReport.hyperlinks, 1);
}
const pdfPath = join(folder, "full-plan-fixture.pdf");
const loadingTask = getDocument({
  data: new Uint8Array(await readFile(pdfPath)),
  useSystemFonts: true,
});
const pdf = await loadingTask.promise;
const pages: {
  page: number;
  png: string;
  width: number;
  height: number;
  text: string;
}[] = [];
const pdfLinks: string[] = [];
try {
  if (wordReport) assert.equal(pdf.numPages, wordReport.pages);
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({
      canvas: canvas as never,
      canvasContext: canvas.getContext("2d") as never,
      viewport,
    }).promise;
    const png = join(folder, `page-${index}.png`);
    await writeFile(png, canvas.toBuffer("image/png"));
    const content = await page.getTextContent();
    const annotations = await page.getAnnotations();
    for (const annotation of annotations)
      if (annotation.subtype === "Link" && typeof annotation.url === "string")
        pdfLinks.push(annotation.url);
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    assert.ok(text.length > 20, `PDF page ${index} has no usable text`);
    pages.push({
      page: index,
      png,
      width: canvas.width,
      height: canvas.height,
      text,
    });
  }
} finally {
  await loadingTask.destroy();
}
const text = pages.map((page) => page.text).join("\n");
const compact = text.replace(/\s/g, "");
for (const [heading] of sections)
  assert.ok(compact.includes(heading), `Missing heading ${heading}`);
for (const token of ["A<B", "B>C", "A&B", "阶段", "对照与质控", "PMID12345"])
  assert.ok(compact.includes(token), `Missing text ${token}`);
assert.ok(
  pdfLinks.includes(source.url!),
  "Public reference hyperlink is missing from the Word PDF",
);
const report = {
  modelCalls: 0,
  renderer:
    "Microsoft Word COM PDF export followed by pdfjs-dist and @napi-rs/canvas",
  packagedRenderDocxUsed: false,
  docx: docxPath,
  pdf: pdfPath,
  fixtureHash: digest(version),
  docxSha256: createHash("sha256").update(docx).digest("hex"),
  sections: sections.length,
  pages: pages.length,
  tables: (documentXml.match(/<w:tbl>/g) ?? []).length,
  hyperlinks: (documentXml.match(/<w:hyperlink /g) ?? []).length,
  wordVersion: wordReport?.wordVersion ?? null,
  openedReadOnly: wordReport?.openedReadOnly ?? null,
  hidden: wordReport?.hidden ?? null,
  existingWordPdfUsed: false,
  wordPropertiesMeasured: Boolean(wordReport),
  docxLayoutVerified: Boolean(wordReport),
  visualInspectionPending: true,
  pdfLinks,
  allHeadingsPreserved: true,
  specialCharactersPreserved: true,
  renderedPages: pages,
};
await writeFile(
  join(folder, "verification-report.json"),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    { ...report, renderedPages: pages.map(({ text: _text, ...page }) => page) },
    null,
    2,
  ),
);
