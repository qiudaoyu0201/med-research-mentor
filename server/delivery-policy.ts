import type {
  ConversationState,
  DeckVersion,
  ReviewResult,
  TaskRun,
} from "../shared/types.ts";

export const onlineReviewInstructions = `
这是面向用户的正常讲解审核。优先帮助用户获得完整连贯的回答，不要求逐句复刻论文。
重大事实错误、关键数值或组别错误、因果越界、缺少回答当前问题必需的核心方法/对照/推理，标 blocking，不能用流畅易懂抵消。
少量不影响研究主线的术语补充、非必要操作细节和已自然说明的真实局限，不作为交付阻断。通用正确定义可以自然补充，不要求本篇论文逐字定义；论文特有事实仍必须有来源。
按当前任务评价交付：顺序带读只要求讲清当前段落及其衔接，不要求一轮讲完整篇；PPT要求实验思路、关键证据和结论边界可讲清，不把完整讲稿或所有方法参数塞进幻灯片；研究构思允许合理假设和待与导师确认的条件，不要求提交时已完成预实验。影响理解或阅读的内容缺失仍需修复，纯措辞、版式偏好及不影响当前任务的额外深挖不列为issues。真实联网补充有明确来源且不冒充原论文时正常使用，不因使用外部资料扣分。
同一段落可以先转述论文再解释研究价值。若正文已明确标出“作者报告”“据此理解”“仅凭本页不能判断”等归属与边界，不因建议拆段或调整section.kind就报告scope错误；真正把推测冒充论文事实、把相关性写成因果或改变适用范围仍按实际错误处理。
同一原因的问题合并说明，不为同一缺口反复新增问题。若缺口遍布多个关键部分，必须标 blocking，不能靠大量免责声明交付。修订应自行解决可解决的问题，不把已有全文中的资料索取任务转嫁给用户。
先确认材料实际是否包含有关信息，不把未读到当作原文没有。问题按对当前任务的影响分级，不按措辞或意见数量升级；对照设计的真实不足可以在结论边界自然解释，不能要求原论文补做不存在的实验才能介绍它。审核日志只留在内部。
`;

export const naturalDeliveryInstructions = `
直接呈现自然连贯的教学或成果，不把审核意见、角色评语、内部编号和修订过程写入正文、页面或讲稿。次要表达问题自行改善，不附警告清单。影响结论的真实边界在相关处清楚说明一次；假设、拟议实验和已观察结果仍须区分，不用免责声明替代必要解释。用户追问依据和不足时结合来源回答。
同一个材料范围或证据限制集中说明一次，后文用准确归属自然衔接，不在每段反复强调“仅本页”“尚未提供”“不能证明”。已有全文时，当前选段没有的信息不等于论文没有；按带读进度衔接后续实验即可。不同结论各自必要的限制仍须讲清，不能为了简短删除。
`;

export const onlineNoviceInstructions = `
这是日常使用的理解检查。open 断点仅用于无法理解当前研究问题、关键实验/对照或从结果到结论的必要推理。不要把额外专业深挖、已经解释过的术语或个人表达偏好列为 open；这些不应触发整份修订。保持新手视角，不猜答案，不降低关键理解要求。
`;

export function onlineDeliveryProblem(
  review: ReviewResult,
): string | undefined {
  const unresolved = review.issues.filter((i) => !i.resolved);
  if (unresolved.some((i) => i.severity === "blocking"))
    return "仍有影响结论或理解主线的问题，已保留核对结果，需要修正后再交付。";
}

// Old conversations may contain warning-derived questions. Match the owning run,
// never delete user questions merely because they resemble an audit suggestion.
export function visibleOpenQuestions(
  questions: ConversationState["openQuestions"],
  runs: Iterable<TaskRun>,
  conversationId: string,
) {
  const internalIds = new Set<string>();
  for (const run of runs) {
    if (run.input.conversationId !== conversationId) continue;
    for (const issue of run.review?.issues ?? []) {
      const required =
        run.novice?.breakpoints.some(
          (b) => b.id === issue.id && b.status !== "resolved",
        ) ||
        run.materialRequests?.some(
          (r) => r.id === issue.id && r.status !== "resolved",
        );
      if (issue.severity === "warning" && !required)
        internalIds.add(`${run.id}-${issue.id}`);
    }
  }
  return questions.filter((q) => !internalIds.has(q.id));
}

export function reviewFollowupContext(
  question: string,
  run?: TaskRun | DeckVersion,
) {
  if (
    !run?.review ||
    !("outline" in run || run.result) ||
    !/可靠|依据|局限|不足|核验|核对|审核|为什么这样判断/.test(question)
  )
    return "";
  return (
    "\n用户正在追问上一版的依据或不足。以下是该版本保留的核对线索，不是已经证实的事实；结合实际来源重新判断，用自然语言回答，不复制内部清单：\n" +
    JSON.stringify({
      ...("outline" in run ? { currentDeck: run.outline } : {}),
      issues: run.review.issues
        .filter((i) => !i.resolved)
        .map((i) => ({
          location: i.location,
          evidence: i.evidence,
          suggestion: i.suggestion,
        })),
      scope: run.review.limitations,
    })
  );
}
