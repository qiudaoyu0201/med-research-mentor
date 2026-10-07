// This manifest contains requests only; scoring conditions are evaluation-side data.
export const trainingPapers = [
  {
    id: "train-xu",
    group: "development",
    study: "xu-2018",
    title: "Xu 2018 Senolytics",
    doi: "10.1038/s41591-018-0092-9",
    path: "data/papers/Xu_2018_Senolytics/Xu_2018_NatureMedicine_Senolytics_fulltext.pdf",
  },
  {
    id: "train-cohort",
    group: "development",
    study: "af-exercise-2021",
    title:
      "Exercise habits and the cardiovascular outcomes in patients with incident atrial fibrillation",
    doi: "10.1371/journal.pmed.1003659",
    path: "runs/product-finish/cohort.pdf",
  },
  {
    id: "holdout-passos",
    group: "holdout",
    study: "passos-2007",
    title:
      "Mitochondrial Dysfunction Accounts for the Stochastic Heterogeneity in Telomere-Dependent Senescence",
    doi: "10.1371/journal.pbio.0050110",
    path: "runs/internal-training/sources/holdout-a-passos/PDFs/Mitochondrial_Dysfunction_Accounts_for_the_Stochastic_Heterogeneity_in_Telomere-Dependent_Senescence.pdf",
  },
  {
    id: "holdout-bell",
    group: "holdout",
    study: "bell-2021",
    title:
      "Body muscle gain and markers of cardiovascular disease susceptibility in young adulthood: A cohort study",
    doi: "10.1371/journal.pmed.1003751",
    path: "runs/internal-training/sources/holdout-b/PDFs/Body_muscle_gain_and_markers_of_cardiovascular_disease_susceptibility_in_young_adulthood_A_cohort_study.pdf",
  },
] as const;
const pptQuestion =
  "根据论文生成六页可实际汇报的中文 PPT。按研究类型组织问题、方法、主要证据和局限，证据页选用提供的对应图件，图文互相说明，文字简短。不把材料解析或产品核对状态写成汇报正文。";
export const trainingCases = [
  {
    id: "D1",
    split: "development",
    kind: "ppt",
    paperId: "train-xu",
    question: pptQuestion,
    conditions: "",
    speechScript: true,
  },
  {
    id: "D2",
    split: "development",
    kind: "paper",
    paperId: "train-cohort",
    question:
      "解释这篇论文研究了什么、怎样比较、证据能说明什么及不能说明什么。区分观察关联与因果，通俗但保留设计理由。",
    conditions: "",
    speechScript: false,
  },
  {
    id: "D3",
    split: "development",
    kind: "plan",
    paperId: "train-xu",
    studyType: "basic-translational",
    question:
      "某细胞刺激后蛋白测量信号升高，如何区分测量伪影、细胞数量变化和目标表达变化？",
    conditions:
      "仅能使用显微镜；设备、效应量与变异未知。拟提出设计草案，不编样本量或操作浓度。",
    changedConditions:
      "只能使用已有蛋白检测读数和细胞计数，无法新增显微成像；效应量与变异未知。拟提出设计草案，不编样本量或操作浓度。",
    speechScript: false,
  },
  {
    id: "H1",
    split: "holdout",
    kind: "paper",
    paperId: "holdout-passos",
    question:
      "解释论文怎样把线粒体功能、活性氧读数和细胞衰老联系起来。测量对象是什么，对照排除了哪些解释，哪些因果联系仍受材料范围限制？",
    conditions: "",
    speechScript: false,
  },
  {
    id: "H2",
    split: "holdout",
    kind: "ppt",
    paperId: "holdout-bell",
    question: pptQuestion,
    conditions: "",
    speechScript: true,
  },
  {
    id: "H3",
    split: "holdout",
    kind: "plan",
    paperId: "holdout-bell",
    studyType: "clinical-observational",
    question: "如何研究青年人握力变化与后续心血管代谢指标的关联？",
    conditions:
      "仅有本院两次握力、体重和常规血脂记录；没有 DXA、代谢组学或随机干预资源。记录缺失率和样本规模未知。参考来源中的研究思路，不把其结果当成本院观察。",
    speechScript: false,
  },
] as const;
export type TrainingCase = (typeof trainingCases)[number];
export const artifactCriteria = (test: TrainingCase) => [
  "回应原问题并解释必要原理或设计理由，不用未知替代必要解释",
  "新手能沿着必要术语解释与测量到推理的连接理解内容，不靠省略关键概念或堆砌专业细节",
  "论文事实与实际可见来源相符，区分证据、推理、假设和结果",
  "交付正文不含内部问题编号、角色核对过程或重复状态说明",
  "只交付和评价当前请求的产物，不为核对额外生成未请求的 PPT 或复现操作手册",
  test.kind === "ppt"
    ? "页面主线、原图观察、逐页讲稿和完整演讲稿一致，保留证据边界"
    : test.kind === "plan"
      ? "根据给定资源选择可行设计，不编设备、样本量或实测结果"
      : "把测量对象、对照、读数和推理连接起来，并说明证据边界",
  ...(test.id === "D3"
    ? ["资源变更后修改对应测量和设计，保留未变的研究目标与必要对照"]
    : []),
];
