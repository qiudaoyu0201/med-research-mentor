export interface EvalCase {
  id: string;
  split: "development" | "holdout";
  module: "paper" | "method" | "figure";
  question: string;
  profileId: "beginner" | "methods" | "reasoning";
  sourceIds: string[];
  required: string[];
  condition: string;
}
export const cases: EvalCase[] = [
  {
    id: "term",
    split: "development",
    module: "paper",
    question: "衰老细胞是什么意思？请先补必要基础。",
    profileId: "beginner",
    sourceIds: ["xu-question", "xu-design"],
    required: ["术语", "作用"],
    condition: "解释细胞状态与个体老年区别，不假定学生懂缩写",
  },
  {
    id: "pcr",
    split: "development",
    module: "method",
    question: "PCR/qPCR 为什么要扩增？真正测到了什么？",
    profileId: "methods",
    sourceIds: ["qpcr-basics", "qpcr-controls"],
    required: ["扩增", "测量", "对照"],
    condition: "复制目标与荧光读数之间衔接完整，核酸不等于蛋白功能",
  },
  {
    id: "flow",
    split: "development",
    module: "method",
    question: "流式的点、门控和阳性比例怎样理解？",
    profileId: "methods",
    sourceIds: ["flow-basics"],
    required: ["门控", "分母", "对照"],
    condition: "事件不必然是目标单细胞，阳性比例说明分母",
  },
  {
    id: "figure",
    split: "development",
    module: "figure",
    question: "没有原图，Figure 1 图注能确认什么，哪些不能判断？",
    profileId: "beginner",
    sourceIds: ["xu-fig1"],
    required: ["坐标", "误差", "缺"],
    condition: "不编造柱高与单位；说明 SEM，标出缺图",
  },
  {
    id: "chain",
    split: "development",
    module: "paper",
    question: "为什么移植衰老细胞后功能下降能支持结论？",
    profileId: "reasoning",
    sourceIds: ["xu-design", "xu-fig1"],
    required: ["改变", "测", "解释"],
    condition: "展开干预到观察，不直接背作者结论",
  },
  {
    id: "rewrite",
    split: "development",
    module: "method",
    question: "还是不懂 Ct；只从“复制更多 DNA 为什么先过阈值”这一步讲起。",
    profileId: "beginner",
    sourceIds: ["qpcr-basics", "qpcr-controls"],
    required: ["阈值", "循环"],
    condition: "缩到一个步骤，解释发生改变而非重复术语",
  },
  {
    id: "lifespan",
    split: "holdout",
    module: "paper",
    question: "Figure 6 中剩余寿命改善能证明人类获益吗？",
    profileId: "reasoning",
    sourceIds: ["xu-fig6"],
    required: ["人", "剩余"],
    condition: "区分剩余与总寿命、动物与人类边界",
  },
  {
    id: "ct-context",
    split: "holdout",
    module: "method",
    question: "用不同试剂得到的两个 Ct 能直接比较吗？",
    profileId: "methods",
    sourceIds: ["qpcr-basics"],
    required: ["条件", "效率"],
    condition: "不直接比较不同反应条件；说明其他因素",
  },
];

// Deterministic assistant contracts run in checks/assistant.test.ts; quality of the real
// Figure 1 report is additionally verified by scripts/assistant-check.ts.
export const assistantCases = [
  {
    id: "assistant-method",
    split: "development",
    condition: "直接 PCR 请求选择方法与基础资料，规划为零次。",
    checks: ["direct method route uses foundations"],
  },
  {
    id: "assistant-followup",
    split: "development",
    condition: "继承上一单元来源和已教概念，当前解释发生变化。",
    checks: ["follow-up inherits"],
  },
  {
    id: "assistant-report",
    split: "development",
    condition:
      "一个组合任务生成三页与讲稿，新手收到完整汇报，原图与来源进入 PPTX。",
    checks: ["Figure + methods + three slides"],
  },
  {
    id: "assistant-budget",
    split: "development",
    condition: "七次总额度、一次修订、取消与超时停止、重复消息及精确缓存失效。",
    checks: [
      "one planner plus one revision",
      "budget cancellation",
      "exact cache",
    ],
  },
  {
    id: "assistant-ambiguous",
    split: "holdout",
    condition: "无绑定的含糊指代提出具体问题，回答后续接原目标。",
    checks: ["unbound pronoun"],
  },
  {
    id: "assistant-transfer",
    split: "holdout",
    condition: "切换来源版本或论文后隔离旧证据与学习上下文。",
    checks: ["paper change clears"],
  },
] as const;
