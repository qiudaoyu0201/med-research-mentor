import { randomUUID } from "node:crypto";
import { z } from "zod";
import { save } from "../server/storage.ts";
import { LearnerStore, LearnerEnvironment } from "../server/learner.ts";
import { BudgetLedger } from "../server/budget.ts";
import { CodexProvider } from "../server/provider.ts";
import { loadSkill } from "../server/skills.ts";
import { noviceSchema } from "../server/schemas.ts";
import {
  learnerProfile,
  knownTask,
  lomaTask,
  incompleteLesson,
  completeLesson,
} from "../examples/learner-case.ts";

const live = process.argv.includes("--live");
const id = randomUUID();
const report: any = {
  id,
  mode: live ? "live-model-behavior" : "material-audit-only",
  limits: { calls: 7, learnerGroup: 6, deadlineSeconds: 480 },
  steps: [],
  limitations: [
    "虚构规则测试，不代表医学方法或真人学习效果。",
    "旧试读基线检查表达，不能与实际作答混作同一掌握分数。",
  ],
};
const ledger = new BudgetLedger(id, async () =>
  save("simulation-reports", id, report),
);
report.budget = ledger.state;
console.log(
  "模拟开发验证：固定画像，已知题、未教题、缺前提、完整讲解及恢复后新题；最多 7 次调用，480 秒；失败不自动重发。",
);
if (!live) {
  await loadSkill("medical-learner-simulation");
  report.materials = {
    learnerProfile,
    knownTask,
    incompleteLesson,
    completeLesson,
  };
  report.status = "materials-ready-not-behavior-validated";
} else {
  const provider = new CodexProvider();
  const signal = AbortSignal.timeout(480_000);
  const store = new LearnerStore();
  const env = new LearnerEnvironment(store, provider);
  const student = await store.create(learnerProfile);
  report.learnerId = student.id;
  try {
    const novice = await loadSkill("medical-novice-simulator");
    const baselineInput = {
      profile: learnerProfile,
      question: "能否按洛码编码新读数？",
      explanation: incompleteLesson.text,
      taughtConcepts: [],
    };
    const baseline = await ledger.call(
      provider,
      "baseline-readability",
      novice.text,
      baselineInput,
      noviceSchema,
      signal,
      {
        groupId: "simulation",
        sourceHash: "synthetic-v1",
        skillHash: novice.hash,
      },
    );
    report.baseline = {
      input: baselineInput,
      instructions: novice.text,
      output: baseline.output,
    };
    const perform = async (
      task: ReturnType<typeof lomaTask>,
      expectedChoice: string,
      requiredVisibleIds: string[],
    ) => {
      const result = await env.answer(
        student.id,
        task,
        { expectedChoice, requiredVisibleIds },
        ledger,
        signal,
      );
      report.steps.push({
        task: task.id,
        ...result,
        state: store.get(student.id),
      });
      await save("simulation-reports", id, report);
    };
    await perform(knownTask, "a", []);
    await perform(lomaTask("before", 4), "red", ["complete"]);
    await store.teach(student.id, incompleteLesson);
    await perform(lomaTask("incomplete", 6), "red", ["complete"]);
    const teacherInput = {
      source: completeLesson.text,
      request:
        "准确保留这份虚构规则的阈值和对应关系，用两句教学文字解释，不加入其他规则；明确是测试用虚构规则。",
    };
    const teacher = await ledger.call(
      provider,
      "teacher",
      "根据所给测试规则讲解，直接返回 text；不使用工具。",
      teacherInput,
      z.object({ text: z.string().min(1).max(1200) }),
      signal,
      { sourceHash: "synthetic-v1", skillHash: "teacher-source-v1" },
    );
    report.teacher = { input: teacherInput, output: teacher.output };
    // The teacher output is the actual visible text, never silently replaced by the reference.
    await store.teach(student.id, {
      ...completeLesson,
      text: teacher.output.text,
    });
    await perform(lomaTask("after", 5), "red", ["complete"]);
    const restored = new LearnerStore();
    await restored.restore();
    const next = await new LearnerEnvironment(restored, provider).answer(
      student.id,
      lomaTask("next", 1),
      { expectedChoice: "blue", requiredVisibleIds: ["complete"] },
      ledger,
      signal,
    );
    report.steps.push({
      task: "next",
      ...next,
      state: restored.get(student.id),
    });
    const by = (task: string) => report.steps.find((s: any) => s.task === task);
    report.checks = {
      known: by("known").assessment.correct,
      beforeNoLeak: !by("before").assessment.unauthorizedKnowledge,
      incompleteNoLeak: !by("incomplete").assessment.unauthorizedKnowledge,
      afterCorrect: by("after").assessment.correct,
      nextCorrect: next.assessment.correct,
      restoredSameStudent:
        restored.get(student.id).profile.version === learnerProfile.version,
    };
    report.status = Object.values(report.checks).every(Boolean)
      ? "synthetic-behavior-passed"
      : "synthetic-behavior-failed";
    if (report.status.endsWith("failed")) process.exitCode = 1;
  } catch (error) {
    report.status = "execution-failed";
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
}
await save("simulation-reports", id, report);
console.log(
  JSON.stringify(
    {
      id,
      status: report.status,
      calls: report.budget.attempts.length,
      checks: report.checks,
      error: report.error,
    },
    null,
    2,
  ),
);
