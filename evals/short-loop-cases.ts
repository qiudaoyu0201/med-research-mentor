// Development prompts only. Evaluation expectations never enter generation input.
export const shortLoopCases = [
  {
    id: "intervention",
    kind: "paper",
    split: "development",
    question:
      "为什么 Xu 研究选择 dasatinib 与 quercetin 联用来检验衰老细胞的作用？结合提供原文，解释干预改变什么、为何这样选择、比较怎样支持判断及证据边界。",
    conditions: "",
    pages: [3, 4],
    figures: [],
    output: "一个完整解释片段，不生成 PPT 或整篇综述",
    criteria: [
      "干预原理及选择理由进入实际回答",
      "实际引用支持相应解释",
      "区分细胞机制依据、组织观察与临床获益",
    ],
  },
  {
    id: "figure-6f",
    kind: "ppt",
    split: "development",
    question:
      "用约两页中文 PPT 解释 Xu Fig.6f：从设计与跑台测量连接到结果和边界。使用提供的原图，解释比较对象、读数及单位，保留必要图例和标签；提供逐页讲稿，不生成整篇完整演讲稿。",
    conditions: "",
    pages: [4, 7, 8, 12, 13],
    figures: ["6"],
    output: "两页起步的图稿、逐页备注及实际 PPTX；必要时可第三页",
    criteria: [
      "原图观察、方向、单位和参照与文字一致",
      "设计到结果有必要解释连接",
      "必要标签可读，预览与实际文件一致",
    ],
  },
  {
    id: "protein",
    kind: "plan",
    split: "development",
    question:
      "某细胞刺激后蛋白测量信号升高，如何区分测量伪影、细胞数量变化和目标表达变化？",
    conditions:
      "仅能使用显微镜；设备、效应量与变异未知。拟提出一个可行设计单元，不编样本量或操作浓度。",
    changedConditions:
      "只能使用已有蛋白检测读数和细胞计数，无法新增显微成像；效应量与变异未知。不编样本量或操作浓度。",
    pages: [],
    figures: [],
    output: "问题→变量／测量→比较／分析→限制的完整设计单元",
    criteria: [
      "各替代解释对应可用测量或比较",
      "未知条件限制实际设计，不编设备或参数",
      "资源变化后保留目标并调整设计",
    ],
  },
] as const;
export type ShortLoopCase = (typeof shortLoopCases)[number];
export const reservedMaterials = [
  "holdout-passos",
  "holdout-bell",
  "握力",
  "血脂",
];
