import type { TrainingBatch } from "./internal-training.ts";
import { reserveUnit } from "./internal-training.ts";
export const learningCriteria = [
  "正确完成当前独立复述、设计或汇报任务，解释必要推理连接",
  "事实和设计边界准确，不编造资源、样本量或实测结果",
  "作答的知识依据可从可见目标资料和真实曝光支持，额外模型先验须指出",
];
export const learningCalibration = [
  {
    id: "association-good",
    text: "活动与风险一起变化，这是关联。因为并非随机分配运动，健康差异可能同时影响两者，因此不能证明运动造成风险下降。",
    source: "观察队列中活动与风险相关，存在残余混杂，不能证明因果。",
    expected: [true, true, true],
  },
  {
    id: "design-good",
    text: "只有一次握力与血脂测量，可做横断面关联分析；用年龄和性别比较控制已知差异。没有时间顺序，不能断言握力改变血脂。样本量与缺失率未知，尚无实测结果。",
    source: "只有一次握力、血脂、年龄和性别测量，无追踪。样本量与缺失率未知。",
    expected: [true, true, true],
  },
  {
    id: "reasoning-missing",
    text: "关联不是因果。记住这个结论即可。",
    source: "观察队列中活动与风险相关，存在残余混杂，不能证明因果。",
    expected: [false, true, true],
  },
  {
    id: "fabricated-result",
    text: "研究已随机分配1000人，运动使风险下降50%，所以确证因果。",
    source:
      "观察队列中活动与风险相关，存在残余混杂，不能证明因果。未提供人数或效应量。",
    expected: [false, false, false],
  },
];
export function reserveLearningUnit(
  batch: TrainingBatch,
  batches: TrainingBatch[],
  required: number,
) {
  const attempts = batches.flatMap((b) => b.budget.attempts);
  if (
    new Set(attempts.map((a) => a.id)).size !== attempts.length ||
    attempts.length + required > 28 ||
    ![1, 2, 4].includes(required)
  )
    throw new Error("学习总额度不足或账本重复，完整单元未运行。");
  reserveUnit(batch, required, attempts.length);
}
