import { z } from "zod";
import { BudgetLedger } from "./budget.ts";
import { digest } from "./materials.ts";
import type { BudgetState } from "../shared/types.ts";
import type { Provider } from "./provider.ts";
import { answerOpenTask, exposureVersion, type OpenLearnerRecord, type OpenTask, type Exposure } from "./internal-learner.ts";
import { reviewArtifact } from "./internal-training.ts";
import { learningCriteria } from "./learning-protocol.ts";
import { assertIndependentTarget, learningImage } from "./learning-exposure.ts";
import { addAssistedCorrection, addIndependentTransfer, addRemedialTeaching, beginLearningLoop, type LearningLoopRecord } from "./learning-loop.ts";

type Evaluation = Awaited<ReturnType<typeof reviewArtifact>>;
type Observation = OpenLearnerRecord["observations"][number];
type Stage = "teach" | "check-teaching" | "correct" | "check-correction" | "transfer" | "check-transfer";
export interface ClosureInput {
  learner: OpenLearnerRecord;
  initial: Observation;
  evaluation: Evaluation;
  transfer: OpenTask;
  priorStudies: { question: string; study: string }[];
  targetStudy: string;
  rules: string;
  // Supplied from the frozen experiment contract, not guessed from model name.
  environmentHash: string;
  initialImage?: string;
  transferImage?: string;
}
export interface ClosureState {
  version: "learning-closure-v1";
  id: string;
  inputHash: string;
  loop: LearningLoopRecord;
  stage: Stage | "done";
  status: "pending" | "running" | "complete" | "blocked";
  inFlight?: Stage;
  error?: string;
  teaching?: Exposure;
  teachingReview?: Evaluation;
  correction?: Observation;
  correctionReview?: Evaluation;
  transfer?: Observation;
  transferReview?: Evaluation;
  // Completion is procedural. A valid negative transfer is still evidence.
  transferPassed?: boolean;
  budget: BudgetState;
}
function contract(input: ClosureInput, provider: Provider) {
  return digest({ input, provider: { id: provider.id, model: provider.model,
    settings: provider.settings, capabilities: provider.capabilities, billingMode: provider.billingMode } });
}
function validateInput(input: ClosureInput) {
  if (!input.environmentHash.trim() || !input.rules.trim()) throw new Error("缺少冻结环境或教学规则。");
  if (!input.evaluation.valid) throw new Error("初始评价无效，先修复评价而非给学生补教。");
  if (input.initial.mode !== "independent" || input.initial.unsupportedVisibleIds.length)
    throw new Error("初始作答不是有效的独立证据。");
  if (!input.learner.observations.some((o) => digest(o) === digest(input.initial)))
    throw new Error("初始作答不属于冻结学生记录。");
  if (!input.priorStudies.length || !input.targetStudy.trim() || input.priorStudies.some((p) => !p.study.trim()))
    throw new Error("缺少原研究与迁移研究的绑定。");
  assertIndependentTarget(input.transfer, [
    ...input.priorStudies,
    { question: input.initial.task.question, study: input.priorStudies[0].study },
  ], input.targetStudy);
  if (input.transfer.id === input.initial.task.id) throw new Error("迁移任务编号重复。");
  for (const exposure of input.learner.exposures)
    if (!["material", "teaching"].includes(exposure.kind) || exposureVersion(exposure) !== exposure.versionHash)
      throw new Error("冻结学习曝光包含提示或版本不符。");
}
export function createClosure(id: string, input: ClosureInput, provider: Provider): ClosureState {
  validateInput(input);
  const loop = beginLearningLoop(input.initial.task, input.initial, input.evaluation);
  const budget = new BudgetLedger(id, async () => {}, undefined, 30 * 60_000).state;
  budget.limit = budget.groupLimit = loop.next === "remedial-teaching" ? 6 : 2;
  return { version: "learning-closure-v1", id, inputHash: contract(input, provider), loop,
    stage: loop.next === "remedial-teaching" ? "teach" : "transfer", status: "pending", budget };
}
const active = new WeakSet<ClosureState>();

/** One durable stage per call. The caller may continue through all stages or
 * stop at a safe checkpoint. An in-flight crash is never an automatic retry. */
export async function advanceClosure(
  state: ClosureState, input: ClosureInput, provider: Provider,
  persist: (state: ClosureState) => Promise<void>, signal: AbortSignal,
) {
  validateInput(input);
  if (state.version !== "learning-closure-v1" || state.inputHash !== contract(input, provider))
    throw new Error("环境、模型、教学规则或材料已变化，请新建对照实验并继承历史成本。");
  if (active.has(state)) throw new Error("闭环阶段正在执行。");
  if (state.status === "complete") return;
  if (state.status === "blocked" || state.inFlight || state.budget.attempts.some((a) => a.status !== "succeeded"))
    throw new Error("闭环有阻塞或未确认请求，保留账本，不重发。");
  signal.throwIfAborted();
  active.add(state);
  const stage = state.stage;
  if (stage === "done") { active.delete(state); throw new Error("闭环终态不一致。"); }
  const save = () => persist(structuredClone(state));
  const ledger = new BudgetLedger(state.id, save, state.budget);
  // Every model call, including reviews, uses the same durable ledger.
  const counted: Provider = {
    model: provider.model,
    generate: (rules, value, schema, sig, image) => ledger.call(provider, stage, rules, value, schema, sig,
      { groupId: "closure", image, sourceHash: state.inputHash, skillHash: digest(rules) }),
  };
  const learner = structuredClone(input.learner);
  learner.observations = [];
  if (state.teaching) learner.exposures.push({ ...state.teaching,
    kind: stage === "correct" ? "target-hint" : "teaching" });
  const task = stage === "transfer" || stage === "check-transfer" ? input.transfer : input.initial.task;
  try {
    state.inFlight = stage;
    state.status = "running";
    await save();
    const image = await learningImage(learner,
      stage === "transfer" || stage === "check-transfer" ? input.transferImage : input.initialImage);
    const evaluate = (artifact: unknown, sources: OpenTask["sources"], criteria = learningCriteria) => reviewArtifact(
      counted, { question: task.question, conditions: "只核对实际来源。教学文字不是独立科学证据；流程完成不等于学生通过。",
        criteria, artifact, sources }, signal, image);
    switch (stage) {
      case "teach": {
        const { output } = await counted.generate(input.rules + "\n针对初始作答的具体断点补教，说明推理和设计理由；不输出评分记录。不调用工具。",
          { task: input.initial.task, answer: input.initial.rawAnswer, diagnosis: input.evaluation,
            exposures: input.learner.exposures.map(({ image, ...e }) => e) },
          z.object({ text: z.string().min(1).max(10000), reason: z.string().min(1).max(1000) }), signal, image);
        state.teaching = { id: `${state.id}-teaching`, kind: "teaching", text: output.text, versionHash: digest(output.text) };
        addRemedialTeaching(state.loop, state.teaching, output.reason);
        state.stage = "check-teaching";
        break;
      }
      case "check-teaching": {
        state.teachingReview = await evaluate({ text: state.teaching!.text }, input.initial.task.sources);
        if (!state.teachingReview.valid || !state.teachingReview.passed)
          throw new Error("补教内容核对未通过，保留产物，暂不向学生曝光。");
        state.stage = "correct";
        break;
      }
      case "correct":
      case "transfer": {
        const observation = await answerOpenTask(counted, learner, task, signal, async () => {}, image);
        if (stage === "correct") { state.correction = observation; state.stage = "check-correction"; }
        else { state.transfer = observation; state.stage = "check-transfer"; }
        if (observation.unsupportedVisibleIds.length) throw new Error("作答引用了不可见资料，不能作为学习证据。");
        break;
      }
      case "check-correction":
      case "check-transfer": {
        const observation = stage === "check-correction" ? state.correction! : state.transfer!;
        const sources = [...task.sources, ...learner.exposures.map((e) => ({ id: e.id, text: e.text, locator: e.kind }))];
        const review = await evaluate(observation.rawAnswer, sources);
        if (stage === "check-correction") state.correctionReview = review;
        else state.transferReview = review;
        if (!review.valid) throw new Error("评价的来源、位置或维度无效，不能结束闭环。");
        if (stage === "check-correction") {
          addAssistedCorrection(state.loop, observation, review);
          state.stage = "transfer";
        } else {
          addIndependentTransfer(state.loop, task, observation, review);
          state.transferPassed = review.passed;
          state.stage = "done";
          state.status = "complete";
        }
        break;
      }
    }
    delete state.inFlight;
    if (state.status === "running") state.status = "pending";
    await save();
  } catch (error) {
    state.status = "blocked";
    state.error = String(error);
    await save();
    throw error;
  } finally { active.delete(state); }
}
