import type { LearnerProfile, LearnerTask } from "../shared/learner.ts";
// This synthetic rule is a test instrument, never a claim about a real method.
export const learnerProfile: LearnerProfile = {
  id: "medical-beginner-test",
  version: "1.0.0",
  background:
    "有医学基础，科研方法刚入门。对照组用于与接受目标处理的实验组比较。洛码是本测试自定义规则，无初始知识。",
  concepts: [
    {
      id: "control",
      description: "实验组接受目标处理，对照组用于比较",
      initial: "known",
    },
    { id: "loma", description: "本测试虚构的洛码编码规则", initial: "unknown" },
  ],
};
export const knownTask: LearnerTask = {
  id: "known",
  conceptId: "control",
  question: "甲组接受目标处理，乙组不接受。哪个是实验组？",
  choices: [
    { id: "a", text: "甲组" },
    { id: "b", text: "乙组" },
  ],
};
export function lomaTask(id: string, number: number): LearnerTask {
  return {
    id,
    conceptId: "loma",
    question: `仅按本测试的洛码规则，读数 ${number} 应记为什么颜色？`,
    choices: [
      { id: "red", text: "红" },
      { id: "blue", text: "蓝" },
    ],
  };
}
export const incompleteLesson = {
  id: "partial",
  text: "洛码会按读数分成红或蓝。这是虚构规则，不是医学方法；本段没有给出阈值及颜色对应关系。",
  conceptIds: ["loma"],
};
export const completeLesson = {
  id: "complete",
  text: "洛码仅是本测试的虚构规则：读数大于或等于 3 记为红，小于 3 记为蓝。判断时先与 3 比较，再根据规则选颜色。这不是医学方法。",
  conceptIds: ["loma"],
};
