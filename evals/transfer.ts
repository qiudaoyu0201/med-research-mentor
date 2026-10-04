import type { EvalCase } from "./cases.ts";
import type { FigureRegistration } from "../server/paper-assets.ts";
export const hewittTitle =
  "Telomeres are favoured targets of a persistent DNA damage response in ageing and stress-induced senescence";
export const hewittPdf =
  process.env.TUTOR_HEWITT_PDF ??
  "data/papers/Hewitt_2012_TAF/PDFs/Telomeres_are_favoured_targets_of_a_persistent_DNA_damage_response_in_ageing_and_stress-induced_senescence.pdf";
export const hewittFigure: FigureRegistration = {
  number: "1",
  page: 3,
  results: [
    {
      page: 2,
      start: "Results \nTAF are persistent",
      end: "To determine that enrichment",
    },
  ],
  methods: [
    { page: 8, start: "Cell culture and treatments .", end: "Animals ." },
    {
      page: 8,
      start: "Immunofluorescence .",
      end: "For Immuno-FISH in formalin",
    },
    {
      page: 8,
      start: "Crosslinked ChIP assay .",
      end: "Extraction of immunoprecipitated",
    },
  ],
};
export const transferCases: EvalCase[] = [
  {
    id: "S1-setup",
    split: "development",
    module: "figure",
    profileId: "beginner",
    sourceIds: [],
    question:
      "帮我读懂 Figure 1，先只讲 d–f 的功能比较、两种对照与推理范围。k–m 的标记留到我追问时再讲。",
    required: ["对照", "功能比较"],
    condition:
      "说明衰老细胞、非衰老细胞和PBS对照，d–f分别测量什么，观察支持小鼠模型结论而非直接推出人类获益；当前单元明确只展开d–f。",
  },
  {
    id: "S1-followup",
    split: "development",
    module: "figure",
    profileId: "beginner",
    sourceIds: [],
    question:
      "还是没懂：SA-βgal、p16INK4a、TAF 分别测到了什么？为什么单靠一个指标不能把衰老判断讲完整？请把三个读数一步步说明，并联系刚才的对照。",
    required: ["SA-βgal", "p16INK4a", "TAF"],
    condition:
      "分别解释酶活、RNA表达和端粒相关损伤反应焦点，区分论文读数与通用原理；说明单指标的边界及与增殖停滞的关系；有证据地承接上一单元的对照，不能只重复缩写。",
  },
  {
    id: "S2-transfer",
    split: "development",
    module: "figure",
    profileId: "beginner",
    sourceIds: [],
    question:
      "读懂这篇 Hewitt 2012 论文 Figure 1，重点讲 b–e：TAF 是怎样的读数，作者怎样支持它持续存在？先补必要概念，说明不同时间点的群体读数与追踪单个焦点的区别。",
    required: ["TAF", "共定位", "持续"],
    condition:
      "细胞对象和条件据Hewitt原文，b–e区分TAF数量、比例、不同时间点及非TAF比较；图1的固定时间点图像和数量变化不能冒充对同一焦点的活细胞连续追踪；通用原理引用foundation，具体观察引用当前论文，不能引用Xu分组、数值或推理。",
  },
  {
    id: "S3-independent",
    split: "development",
    module: "method",
    profileId: "beginner",
    sourceIds: [],
    question:
      "qPCR 的荧光怎样变成 Ct？为什么起始模板多通常较早过阈值，无模板对照又检查什么？",
    required: ["扩增", "荧光", "阈值", "无模板对照"],
    condition:
      "解释扩增到信号累积再到跨阈值的衔接，染料法是通用示例且不能只凭荧光判定目标，指出比较Ct需要相同合适条件；NTC检查无模板背景，核酸信号不等于蛋白功能；独立课程不声称任何论文的具体条件。",
  },
  {
    id: "S4-report",
    split: "development",
    module: "figure",
    profileId: "beginner",
    sourceIds: [],
    question:
      "读懂 Figure 1，解释相关方法，整理成三页汇报；重点 d–f，k–m 解释测量含义与推理范围。先解释 SA-βgal、p16INK4a 和 TAF，再说明论文具体怎样测量，讲稿供初学者复述。",
    required: ["SA-βgal", "p16INK4a", "TAF", "对照"],
    condition:
      "三页具备要点、讲稿、原图和逐页来源；d–f功能比较与两种对照准确；k–m分别说明酶活、RNA表达、端粒相关损伤焦点，先定义再连接测量与推理，论文方法与通用原理分开引用；标记支持衰老相关解释但不能单个指标充分判定；讲稿不出现内部断点ID或账本术语。",
  },
];
