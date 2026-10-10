import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  LearnerProfile,
  LearnerState,
  LearnerTask,
  LearnerAnswer,
  VisibleLesson,
} from "../shared/learner.ts";
import type { Provider } from "./provider.ts";
import { save, list } from "./storage.ts";
import { loadSkill } from "./skills.ts";
import { BudgetLedger } from "./budget.ts";
import { digest } from "./materials.ts";

export const learnerAnswerSchema = z.object({
  choice: z.string().max(100).nullable(),
  explanation: z.string().max(2000),
  questions: z.array(z.string().max(500)).max(5),
  usedVisibleIds: z.array(z.string().max(100)).max(20),
  selfReportedUnderstanding: z.boolean(),
});
// Scoring is local. Neither the rule nor its answer is ever part of learnerView.
export interface ScoringRule {
  expectedChoice: string;
  requiredVisibleIds: string[];
}
export function learnerView(state: LearnerState, task: LearnerTask) {
  return {
    profile: {
      id: state.profile.id,
      version: state.profile.version,
      background: state.profile.background,
    },
    concepts: state.concepts.map(
      ({ id, description, status, misconception }) => ({
        id,
        description,
        status,
        misconception: misconception ?? null,
      }),
    ),
    visible: state.visible.map(({ id, text, conceptIds }) => ({
      id,
      text,
      conceptIds,
    })),
    history: state.observations.map(({ task, answer }) => ({ task, answer })),
    task: {
      id: task.id,
      conceptId: task.conceptId,
      question: task.question,
      choices: task.choices.map(({ id, text }) => ({ id, text })),
    },
  };
}
export class LearnerStore {
  private states = new Map<string, LearnerState>();
  private writing = new Set<string>();
  constructor(private persist: typeof save = save) {}
  async restore(records?: LearnerState[]) {
    for (const record of records ?? (await list<LearnerState>("learners")))
      this.states.set(record.id, structuredClone(record));
  }
  async create(profile: LearnerProfile, id = randomUUID()) {
    if (this.states.has(id)) throw new Error("模拟学生已存在");
    if (
      new Set(profile.concepts.map((c) => c.id)).size !==
      profile.concepts.length
    )
      throw new Error("概念编号重复");
    if (
      profile.concepts.some(
        (c) => c.initial === "misconception" && !c.misconception,
      )
    )
      throw new Error("误解必须有明确设定");
    const state: LearnerState = {
      id,
      version: 0,
      profile: structuredClone(profile),
      concepts: profile.concepts.map((c) => ({
        id: c.id,
        description: c.description,
        status: c.initial,
        ...(c.misconception ? { misconception: c.misconception } : {}),
        taughtBy: [],
        evidence: [],
      })),
      visible: [],
      observations: [],
    };
    await this.persist("learners", id, state);
    this.states.set(id, structuredClone(state));
    return this.get(id);
  }
  get(id: string) {
    const state = this.states.get(id);
    if (!state) throw new Error("模拟学生不存在");
    return structuredClone(state);
  }
  async put(state: LearnerState, version: number) {
    if (
      this.writing.has(state.id) ||
      this.states.get(state.id)?.version !== version
    )
      throw new Error("模拟学生版本发生变化");
    const next = { ...structuredClone(state), version: version + 1 };
    this.writing.add(state.id);
    try {
      await this.persist("learners", state.id, next);
      this.states.set(state.id, next);
    } finally {
      this.writing.delete(state.id);
    }
    return this.get(state.id);
  }
  async teach(id: string, lesson: VisibleLesson) {
    const state = this.get(id);
    if (state.visible.some((v) => v.id === lesson.id))
      throw new Error("讲解编号已经使用");
    if (
      lesson.conceptIds.some((cid) => !state.concepts.some((c) => c.id === cid))
    )
      throw new Error("讲解概念不属于此画像");
    state.visible.push(structuredClone(lesson));
    for (const concept of state.concepts)
      if (lesson.conceptIds.includes(concept.id))
        concept.taughtBy.push(lesson.id);
    return this.put(state, state.version);
  }
}
export class LearnerEnvironment {
  private active = new Set<string>();
  constructor(
    readonly store: LearnerStore,
    private provider: Provider,
    private persist: typeof save = save,
  ) {}
  async answer(
    id: string,
    task: LearnerTask,
    rule: ScoringRule,
    ledger: BudgetLedger,
    signal: AbortSignal,
  ) {
    if (this.active.has(id)) throw new Error("此模拟学生正在作答");
    const state = this.store.get(id);
    this.active.add(id);
    const observationId = randomUUID();
    const input = learnerView(state, task);
    const record: {
      id: string;
      learnerId: string;
      stateVersion: number;
      input: typeof input;
      instructions?: string;
      skillVersion?: string;
      output?: LearnerAnswer;
      assessment?: unknown;
      error?: string;
      status: string;
    } = {
      id: observationId,
      learnerId: id,
      stateVersion: state.version,
      input,
      status: "queued",
    };
    try {
      const concept = state.concepts.find((c) => c.id === task.conceptId);
      if (!concept || !task.choices.some((c) => c.id === rule.expectedChoice))
        throw new Error("题目或评分规则无效");
      const skill = await loadSkill("medical-learner-simulation");
      record.instructions = skill.text;
      record.skillVersion = skill.hash;
      await this.persist("simulation-attempts", observationId, record);
      const result = await ledger.call(
        this.provider,
        "learner",
        skill.text,
        input,
        learnerAnswerSchema,
        signal,
        {
          groupId: "simulation",
          sourceHash: digest(input),
          skillHash: skill.hash,
        },
      );
      const answer = result.output;
      record.output = answer;
      if (
        answer.choice !== null &&
        !task.choices.some((c) => c.id === answer.choice)
      )
        throw new Error("学生返回了不存在的选项");
      if (
        answer.usedVisibleIds.some(
          (vid) => !state.visible.some((v) => v.id === vid),
        )
      )
        throw new Error("学生引用了未见讲解");
      const basisAvailable =
        concept.status === "known" ||
        (rule.requiredVisibleIds.length > 0 &&
          rule.requiredVisibleIds.every((vid) =>
            state.visible.some(
              (v) => v.id === vid && v.conceptIds.includes(concept.id),
            ),
          ));
      const assessment = {
        correct: answer.choice === rule.expectedChoice,
        unauthorizedKnowledge: answer.choice !== null && !basisAvailable,
        basisAvailable,
      };
      record.assessment = assessment;
      state.observations.push({
        id: observationId,
        task: structuredClone(task),
        answer,
        assessment,
      });
      // Self-reports and merely seeing a term cannot upgrade a concept.
      if (
        assessment.correct &&
        basisAvailable &&
        !assessment.unauthorizedKnowledge
      ) {
        if (concept.status !== "known") concept.status = "observed";
        concept.evidence.push(observationId);
      }
      signal.throwIfAborted();
      record.status = "assessed";
      await this.persist("simulation-attempts", observationId, record);
      await this.store.put(state, state.version);
      return { answer, assessment, observationId };
    } catch (error) {
      record.status = signal.aborted ? "cancelled" : "failed";
      record.error = error instanceof Error ? error.message : "模拟失败";
      await this.persist("simulation-attempts", observationId, record);
      throw error;
    } finally {
      this.active.delete(id);
    }
  }
}
