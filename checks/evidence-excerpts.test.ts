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

test("randomized strategy questions preserve informed choice and actual analysis grouping within the same quota", () => {
  const choice =
    "Participants were randomly assigned to supervised care, self-care or an informed choice arm. Within the choice arm, a nurse reviewed preferences before participants chose their delivery strategy. They had the option to switch strategies at any time.";
  const analysis =
    "All participants were analyzed in their randomized arms. In the as-treated analysis, choice-arm participants were allocated to their initial choice of strategy, rather than their last recorded treatment.";
  const interval =
    "Bonferroni-corrected confidence intervals were used for the planned comparisons; a nonsignificant difference was not evidence of equivalence.";
  const flow =
    "Of 900 screened participants, 600 were randomized. One participant was erroneously rerandomized; only the second enrollment record was excluded.";
  const text = [
    "Methods and outcome analysis were reviewed. ".repeat(80),
    flow,
    choice,
    interval,
    "Further outcome analysis and methods were reviewed. ".repeat(80),
    analysis,
    "Additional outcome analysis was summarized. ".repeat(80),
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    text,
    900,
    ["methods", "outcome", "analysis"],
    "说明随机比较的三种支持策略、结局、分组方法和等效误区",
  );
  const visible = ranges.map((r) => text.slice(r.start, r.end)).join("\n");
  assert.ok(visible.includes(interval));
  assert.ok(visible.includes(flow));
  assert.ok(visible.includes(choice));
  assert.ok(visible.includes(analysis));
  assert.ok(ranges.reduce((sum, r) => sum + r.end - r.start, 0) <= 900);
  for (const range of ranges)
    assert.ok(range.start >= 0 && range.end <= text.length);
});

test("an English trial-analysis question retains the prespecified as-treated definition instead of only repeated results", () => {
  const analysis =
    "The as-treated analysis reassigned participants according to treatment received. The intention-to-treat analysis retained the original randomized groups.";
  const text = [
    "Methods and results were reviewed. ".repeat(80),
    analysis,
    "Further methods and results were reviewed. ".repeat(80),
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    text,
    450,
    ["methods", "results"],
    "Explain the randomized trial and as-treated analysis.",
  );
  assert.ok(
    ranges
      .map((r) => text.slice(r.start, r.end))
      .join("\n")
      .includes(analysis),
  );
  assert.ok(ranges.reduce((sum, r) => sum + r.end - r.start, 0) <= 450);
});

test("random measurement error alone does not activate trial strategy selection", () => {
  const text = [
    "Methods and measurement precision were reviewed. ".repeat(80),
    "In the choice arm participants could switch strategies. An as-treated analysis regrouped participants.",
    "Additional measurement methods were reviewed. ".repeat(80),
  ].join("\n");
  assert.deepEqual(
    evidenceExcerptRanges(text, 450, ["methods"], "说明测量的随机误差与图例"),
    evidenceExcerptRanges(text, 450, ["methods"], "说明测量误差与图例"),
  );
});

test("an outcome request does not reserve space for a secondary-outcome list when the page has no outcome definition", () => {
  const unrelated =
    "Additional secondary outcomes include staff preferences and provider interviews, reported separately.";
  const text = [
    "Methods for comparing treatment groups were prespecified. ".repeat(60),
    unrelated,
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    text,
    200,
    ["methods"],
    "解释结局的定义",
  );
  const visible = ranges.map((r) => text.slice(r.start, r.end)).join("\n");
  assert.ok(
    visible.includes(
      "Methods for comparing treatment groups were prespecified.",
    ),
  );
  assert.ok(!visible.includes(unrelated));
  assert.ok(ranges.reduce((sum, r) => sum + r.end - r.start, 0) <= 200);
});

test("cohort report selection preserves design, recruitment and baseline population beside repeated model methods", () => {
  const design =
    "Study setting and participants\nWe conducted a retrospective cohort study at a single tertiary center from 2008 to 2022.";
  const cohort =
    "Baseline characteristics of the patients\nDuring the study period, 4,216 eligible adults were identified. All participants belonged to the reported recruitment population.";
  const followup =
    "Time to event was measured from the first baseline measurement to death or censoring.";
  const source = [
    "Methods and statistical analysis of survival models. ".repeat(65),
    design,
    "Statistical methods for survival analysis were specified. ".repeat(65),
    cohort,
    followup,
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    source,
    800,
    ["methods", "analysis", "survival"],
    "汇报研究设计与生存随访",
  );
  const visible = ranges.map((r) => source.slice(r.start, r.end)).join("\n");
  for (const block of [design, cohort, followup])
    assert.ok(visible.includes(block));
  assert.ok(ranges.reduce((n, r) => n + r.end - r.start, 0) <= 800);
});

test("population selection retains recruited numbers without inventing numeric requirements", () => {
  const cohort =
    "We identified 832 eligible patients from the national registry. Baseline characteristics were summarized for the recruited cohort.";
  const source = [
    "Patient model methods and analysis. ".repeat(90),
    cohort,
    "Patient model results and analysis. ".repeat(90),
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    source,
    420,
    ["patients", "methods", "analysis"],
    "Explain the study population and eligibility.",
  );
  assert.ok(
    ranges
      .map((r) => source.slice(r.start, r.end))
      .join("\n")
      .includes(cohort),
  );
  assert.ok(ranges.reduce((n, r) => n + r.end - r.start, 0) <= 420);
});

test("limitation requests retain verification mechanism and unmeasured context within the existing budget", () => {
  const verification =
    "Verification bias can arise when low test results receive fewer confirmatory examinations. False negatives may be underestimated and sensitivity overestimated.";
  const unmeasured =
    "We did not collect medication or renal function data. It was not possible to determine active arrhythmia at blood sampling.";
  const source = [
    "Methods and diagnostic results were summarized. ".repeat(75),
    verification,
    "Study results and subgroup analysis were reviewed. ".repeat(75),
    unmeasured,
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    source,
    650,
    ["methods", "results", "analysis"],
    "汇报诊断方法、结果及局限和外推",
  );
  const visible = ranges.map((r) => source.slice(r.start, r.end)).join("\n");
  assert.ok(visible.includes(verification));
  assert.ok(visible.includes(unmeasured));
  assert.ok(ranges.reduce((n, r) => n + r.end - r.start, 0) <= 650);
});

test("unmeasured factors do not displace source evidence without a limitation question", () => {
  const source = [
    "Methods and outcomes were reported. ".repeat(90),
    "We did not collect additional context data.",
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    source,
    200,
    ["methods", "outcomes"],
    "Explain the outcome definition.",
  );
  assert.ok(
    !ranges
      .map((r) => source.slice(r.start, r.end))
      .join("\n")
      .includes("additional context"),
  );
});

test("population requests preserve the linked-data sampling frame and limitation requests prefer bias consequences over generic labels", () => {
  const setting =
    "Patient records were linked to hospital records, which limited the analysis to the recorded jurisdiction.";
  const design = "Study design\nThis was a retrospective primary care cohort.";
  const population =
    "Baseline characteristics of the patients\nWe identified 2,493 eligible adults.";
  const generic =
    "Methods and results were reported. Some selection bias may affect the results.";
  const mechanism =
    "This means false negative results are likely to be under-estimated and sensitivity over-estimated.";
  const source = [
    design,
    "Methods and results. ".repeat(80),
    population,
    setting,
    generic,
    mechanism,
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    source,
    650,
    ["methods", "results"],
    "说明研究人群与局限",
  );
  const visible = ranges.map((r) => source.slice(r.start, r.end)).join("\n");
  for (const block of [design, population, setting, mechanism])
    assert.ok(visible.includes(block), block);
  assert.ok(ranges.reduce((n, r) => n + r.end - r.start, 0) <= 650);
});

test("intervention questions preserve delivery and the actual comparator beside generic rationale", () => {
  const delivery =
    "Procedures\nAfter catheter placement, 60 ml of 5 °C saline was infused at 12 ml/min, followed by the common procedure.";
  const control =
    "The control group underwent identical procedures with room temperature saline.";
  const source = [
    "Methods and treatment rationale. ".repeat(95),
    delivery,
    "Study design and methods. ".repeat(60),
    control,
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    source,
    520,
    ["methods", "treatment", "design"],
    "解释干预联用思路与设计",
  );
  const visible = ranges.map((r) => source.slice(r.start, r.end)).join("\n");
  assert.ok(visible.includes(delivery));
  assert.ok(visible.includes(control));
  assert.ok(ranges.reduce((n, r) => n + r.end - r.start, 0) <= 520);
});

test("evidence interpretation preserves an explicit lack of multiplicity correction in a table footnote", () => {
  const footnote =
    "Every analysis used bilateral testing. No corrections were applied for repeated comparisons.";
  const source = [
    "Results and statistical methods. ".repeat(90),
    footnote,
    "Other outcome results. ".repeat(80),
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    source,
    260,
    ["results", "methods"],
    "解释结果及结论支持多强的证据",
  );
  assert.ok(
    ranges
      .map((r) => source.slice(r.start, r.end))
      .join("\n")
      .includes(footnote),
  );
  assert.ok(ranges.reduce((n, r) => n + r.end - r.start, 0) <= 260);
});

test("intervention-only topics do not crowd out an unrelated outcome question", () => {
  const source = [
    "Primary outcome was defined as independent function at day 70.",
    "Study outcome methods and results. ".repeat(70),
    "The control group underwent identical procedures with room temperature saline.",
  ].join("\n");
  const ranges = evidenceExcerptRanges(
    source,
    220,
    ["outcome", "methods"],
    "Explain the primary outcome definition.",
  );
  const visible = ranges.map((r) => source.slice(r.start, r.end)).join("\n");
  assert.ok(visible.includes("independent function at day 70"));
  assert.ok(!visible.includes("room temperature saline"));
});
