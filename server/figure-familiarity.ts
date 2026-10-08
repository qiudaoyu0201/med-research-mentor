import type { TaskRun } from "../shared/types.ts";

const prefix = "曾讲读图基础：";
const families = [
  ["散点图", /散点图|scatter\s*plot/i],
  ["箱线图", /箱线图|箱须图|box\s*plot/i],
  ["柱状图", /柱状图|bar\s*(?:chart|plot)/i],
  ["生存曲线", /生存曲线|Kaplan[–-]?Meier/i],
  ["森林图", /森林图|forest\s*plot/i],
  ["热图", /热图|heat\s*map/i],
] as const;

/** Evidence of delivered explanation, never a claim about learner mastery. */
export function deliveredFigureBasics(run: TaskRun) {
  if (
    run.status !== "completed" ||
    !run.result ||
    !run.review ||
    run.review.issues.some((i) => i.severity === "blocking" && !i.resolved)
  )
    return [];
  const sources = run.materials?.at(-1)?.sources ?? [];
  const sections = run.result.sections.filter((s) =>
    s.citations.some((id) =>
      sources.some((source) => source.id === id && source.kind === "paper"),
    ),
  );
  return families
    .filter(([, pattern]) =>
      sections.some(
        (section) =>
          pattern.test(section.text) &&
          /(?:横轴|纵轴|坐标轴|颜色|箱体|中位数|风险集|置信区间).{0,36}(?:表示|代表|反映|对应|含义)|(?:表示|代表).{0,36}(?:横轴|纵轴|箱体)/s.test(
            section.text,
          ),
      ),
    )
    .map(([name]) => `${prefix}${name}`);
}

export function figureFamiliarity(taughtConcepts: string[], question: string) {
  const explained = families
    .map(([name]) => name)
    .filter((name) => taughtConcepts.includes(`${prefix}${name}`));
  if (!explained.length) return undefined;
  const revisit =
    /从头|从零|从基础|补基础|重新.*(?:解释|讲)|看不懂|没看懂|不理解|横轴|纵轴|怎么看/.test(
      question,
    );
  return {
    previouslyExplained: explained,
    revisitBasics: revisit,
    guidance: revisit
      ? "用户要求重讲或表示困惑，重新解释必要读图基础，不因曾讲过而省略。"
      : "这些图形基础曾被讲解，不代表已掌握。再次遇到同类图可简短衔接，把重点放在当前数据、比较、实验目的和结论。当前图实际变量、单位、分组、对照或编码发生变化时仍须说明，不能沿用上一张图的含义。新图形照常解释，不反复提醒用户曾学过。",
  };
}
