import { digest } from "./materials.ts";
import type { OpenTask, OpenAnswer, Exposure } from "./internal-learner.ts";

/** The internal learning loop is recorded as separate evidence, so assisted
 * correction can never be mistaken for independent transfer. */
export interface LearningLoopRecord {
  taskId: string;
  initial: { mode: "independent"; answerHash: string; evaluationHash: string };
  remedial?: { exposureId: string; exposureHash: string; reason: string };
  correction?: { mode: "assisted"; answerHash: string; evaluationHash: string };
  transfer?: { taskId: string; mode: "independent"; answerHash: string; evaluationHash: string };
  next?: "remedial-teaching" | "independent-transfer";
  status: "initial-only" | "remediated" | "transferred" | "blocked";
}

export function beginLearningLoop(
  task: OpenTask,
  observation: { mode: "independent" | "assisted"; rawAnswer: OpenAnswer },
  evaluation: unknown,
): LearningLoopRecord {
  if (observation.mode !== "independent")
    throw new Error("学习闭环的初始作答必须是独立作答。");
  return {
    taskId: task.id,
    initial: {
      mode: "independent" as const,
      answerHash: digest(observation.rawAnswer),
      evaluationHash: digest(evaluation),
    },
    status: "initial-only",
  };
}

export function addRemedialTeaching(
  loop: LearningLoopRecord,
  exposure: Exposure,
  reason: string,
) {
  if (loop.status !== "initial-only") throw new Error("补救教学只能接在初始独立评价之后。");
  if (exposure.kind !== "teaching") throw new Error("补救材料必须标记为教学曝光。");
  loop.remedial = { exposureId: exposure.id, exposureHash: exposure.versionHash, reason };
  loop.status = "remediated";
  return loop;
}

export function addAssistedCorrection(
  loop: LearningLoopRecord,
  observation: { mode: "independent" | "assisted"; rawAnswer: OpenAnswer },
  evaluation: unknown,
) {
  if (!loop.remedial || loop.status !== "remediated") throw new Error("补救教学后才能记录辅助纠正。");
  if (observation.mode !== "assisted") throw new Error("纠正阶段必须明确标记为辅助作答。");
  loop.correction = {
    mode: "assisted",
    answerHash: digest(observation.rawAnswer),
    evaluationHash: digest(evaluation),
  };
  return loop;
}

export function addIndependentTransfer(
  loop: LearningLoopRecord,
  task: OpenTask,
  observation: { mode: "independent" | "assisted"; rawAnswer: OpenAnswer },
  evaluation: unknown,
) {
  if (!loop.correction || loop.status !== "remediated") throw new Error("必须先完成辅助纠正才能做迁移题。");
  if (observation.mode !== "independent") throw new Error("迁移题必须重新独立作答。");
  if (task.id === loop.taskId) throw new Error("迁移题必须是新任务，不能重复原题。");
  loop.transfer = {
    taskId: task.id,
    mode: "independent",
    answerHash: digest(observation.rawAnswer),
    evaluationHash: digest(evaluation),
  };
  loop.status = "transferred";
  return loop;
}

export function loopNeedsRemediation(evaluation: { valid: boolean; review: { checks: { passed: boolean }[] } }) {
  return !evaluation.valid || evaluation.review.checks.some((check) => !check.passed);
}

export function learningLoopClosed(loop: LearningLoopRecord) {
  return loop.status === "transferred" && !!loop.transfer;
}

export function assertLearningClosureAdmission(
  loops: LearningLoopRecord[],
  expectedCount: number,
) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1)
    throw new Error("学习闭环数量无效。");
  if (loops.length !== expectedCount)
    throw new Error("学习闭环记录不完整，不能开始续接。");
  if (loops.some((loop) => learningLoopClosed(loop)))
    throw new Error("已完成的迁移记录不能再次派发，保留原结果。");
  if (loops.some((loop) => loop.status === "blocked"))
    throw new Error("存在阻塞闭环，需先处理阻塞原因，不能自动重发。");
  if (loops.some((loop) => loop.status !== "initial-only" && loop.status !== "remediated"))
    throw new Error("闭环状态不支持安全续接。");
  return structuredClone(loops);
}
