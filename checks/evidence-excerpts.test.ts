import test from "node:test";
import assert from "node:assert/strict";
import { evidenceExcerptRanges } from "../server/evidence-excerpts.ts";

// Original fictional table data exercises source delivery, not clinical inference.
const table = [
  "Table 4. Adverse events and safety endpoints.",
  "Event  Group A  Group B  Estimate (95% interval)",
  "Event X  3/40  7/40  0.43 (0.12, 1.50)",
  "Event Y  9/40  6/40  1.50 (0.59, 3.81)",
  "a Comparisons were not adjusted for multiplicity.",
  "https://doi.org/10.0000/example.t004",
].join("\n");
const narrative = "Safety outcomes and adverse events were reviewed. ".repeat(
  75,
);
const question = "解释安全性和不良事件";
const terms = ["adverse", "safety", "outcomes"];
const extract = (text: string, quota = 1000) => {
  const ranges = evidenceExcerptRanges(text, quota, terms, question);
  assert.ok(ranges.reduce((n, r) => n + r.end - r.start, 0) <= quota);
  for (const range of ranges) {
    assert.ok(range.start >= 0 && range.end <= text.length);
  }
  return {
    ranges,
    visible: ranges.map((r) => text.slice(r.start, r.end)).join("\n"),
  };
};

test("a compact relevant table retains headers, rows and footnotes within the existing excerpt quota", () => {
  const text = narrative + "\n" + table + "\nUnrelated closing section.";
  const { ranges, visible } = extract(text);
  const start = text.indexOf("Table 4.");
  assert.ok(
    ranges.some((r) => r.start <= start && r.end >= start + table.length),
  );
  assert.match(visible, /Group A  Group B/);
  assert.match(visible, /Event X  3\/40/);
  assert.match(visible, /Event Y  9\/40/);
  assert.match(visible, /not adjusted for multiplicity/);
});

test("an unrelated compact table does not displace requested safety evidence", () => {
  const unrelated = table.replace(
    "Adverse events and safety endpoints",
    "Instrument inventory",
  );
  const text = narrative + "\n" + unrelated;
  const { visible } = extract(text);
  assert.match(visible, /Safety outcomes and adverse events/);
  assert.ok(!visible.includes(unrelated));
});

test("an oversized table cannot consume more than the evidence quota", () => {
  const large = table.replace(
    "Event Y",
    "Additional measurement 1/40 2/40.\n".repeat(70) + "Event Y",
  );
  const { visible } = extract(narrative + "\n" + large, 600);
  assert.match(visible, /Safety outcomes and adverse events/);
  assert.ok(!visible.includes(large));
});

test("a Chinese table heading with its own printed boundary retains the same complete evidence", () => {
  const localized = table
    .replace(
      "Table 4. Adverse events and safety endpoints.",
      "表 12：安全性及不良事件",
    )
    .replace("example.t004", "example.t012");
  const text = narrative + "\n" + localized;
  const { visible } = extract(text);
  assert.ok(visible.includes(localized));
});

test("survival follow-up questions retain time origin and censoring definitions beside repeated method prose", () => {
  const definition =
    "Mortality records were linked from the registry. The date of censoring was the end of registry coverage. Time to event was measured from the first baseline test to death or censoring.";
  const text =
    "Methods and statistical analysis were reviewed. ".repeat(80) +
    "\n" +
    definition +
    "\n" +
    "Additional methods and analysis details. ".repeat(80);
  const ranges = evidenceExcerptRanges(
    text,
    1000,
    ["methods", "analysis"],
    "说明研究设计和生存随访口径",
  );
  const visible = ranges.map((r) => text.slice(r.start, r.end)).join("\n");
  assert.ok(visible.includes(definition));
  assert.ok(ranges.reduce((n, r) => n + r.end - r.start, 0) <= 1000);
});

test("clinical AI comparisons preserve delivered care, model use and time origin within the evidence allowance", () => {
  const delivered =
    "Treatment data reflect therapies actually performed and documented in medical records, rather than unimplemented recommendations.";
  const modelUse =
    "Models were accessed after the registry period. No patient received treatment based on model recommendations. Outputs were retrospectively compared with recorded care.";
  const timeOrigin =
    "Time to event was measured from treatment initiation to death or censoring.";
  const text = [
    "Survival results and model performance were reviewed. ".repeat(75),
    delivered,
    "Other model analysis details were reviewed. ".repeat(75),
    modelUse,
    timeOrigin,
    "Further survival results were summarized. ".repeat(75),
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    text,
    700,
    ["survival", "model"],
    "讲解真实治疗与LLM建议的比较方式和生存随访",
  );
  const visible = ranges.map((r) => text.slice(r.start, r.end)).join("\n");
  for (const block of [delivered, modelUse, timeOrigin])
    assert.ok(visible.includes(block));
  assert.ok(ranges.reduce((sum, r) => sum + r.end - r.start, 0) <= 700);
  for (const range of ranges)
    assert.ok(range.start >= 0 && range.end <= text.length);
});

test("clinical AI design selection also retains prospective allocation rather than assuming retrospective use", () => {
  const allocation =
    "Patients were randomly assigned to model-guided care or usual care. The model was used before treatment decisions.";
  const text = [
    "Model performance and statistical methods were summarized. ".repeat(80),
    allocation,
    "Additional model performance details were summarized. ".repeat(80),
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    text,
    500,
    ["model", "performance"],
    "说明临床AI如何参与治疗分配",
  );
  const visible = ranges.map((r) => text.slice(r.start, r.end)).join("\n");
  assert.ok(visible.includes(allocation));
  assert.ok(ranges.reduce((sum, r) => sum + r.end - r.start, 0) <= 500);
});

test("ordinary clinical statistical-model questions do not activate AI deployment selection", () => {
  const text = [
    "Methods and clinical statistical analysis were reviewed. ".repeat(80),
    "No patient received treatment based on model recommendations. Models were accessed after follow-up.",
    "Further methods and statistical analysis were reviewed. ".repeat(80),
  ].join("\n");
  assert.deepEqual(
    evidenceExcerptRanges(text, 600, ["methods"], "说明临床模型与治疗选择"),
    evidenceExcerptRanges(text, 600, ["methods"], "说明临床变量与治疗选择"),
  );
});
