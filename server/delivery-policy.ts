import type { ReviewResult } from "../shared/types.ts";

export const onlineReviewInstructions = `
这是面向用户的正常讲解审核。优先帮助用户获得完整连贯的回答，不要求逐句复刻论文。
重大事实错误、关键数值或组别错误、因果越界、缺少回答当前问题必需的核心方法/对照/推理，标 blocking，不能用流畅易懂抵消。
少量不影响研究主线的术语补充、非必要操作细节和已自然说明的真实局限，不作为交付阻断。通用正确定义可以自然补充，不要求本篇论文逐字定义；论文特有事实仍必须有来源。
按当前任务评价交付：顺序带读只要求讲清当前段落及其衔接，不要求一轮讲完整篇；PPT要求实验思路、关键证据和结论边界可讲清，不把完整讲稿或所有方法参数塞进幻灯片；研究构思允许合理假设和待与导师确认的条件，不要求提交时已完成预实验。影响理解或阅读的内容缺失仍需修复，纯措辞、版式偏好及不影响当前任务的额外深挖不列为issues。真实联网补充有明确来源且不冒充原论文时正常使用，不因使用外部资料扣分。
同一段落可以先转述论文再解释研究价值。若正文已明确标出“作者报告”“据此理解”“仅凭本页不能判断”等归属与边界，不因建议拆段或调整section.kind就报告scope错误；真正把推测冒充论文事实、把相关性写成因果或改变适用范围仍按实际错误处理。
同一原因的问题合并说明，不为同一缺口反复新增问题。若缺口遍布多个关键部分，必须标 blocking，不能靠大量免责声明交付。修订应自行解决可解决的问题，不把已有全文中的资料索取任务转嫁给用户。
`;

function isTransparentGap(issue: ReviewResult["issues"][number]) {
  if (issue.severity !== "blocking") return false;
  if (issue.type !== "material" && issue.type !== "scope") return false;
  const text = `${issue.location} ${issue.suggestion}`;
  return /(尚缺|缺失|未提供|缺少|补齐|补入|材料)/.test(text);
}

export function onlineDeliveryProblem(review: ReviewResult): string | undefined {
  const unresolved = review.issues.filter(i => !i.resolved);
  if (unresolved.some(i => i.severity === "blocking" && !isTransparentGap(i)))
    return "仍有影响结论或理解主线的问题，已保留核对结果，需要修正后再交付。";
  // Count distinct affected portions, not repeated findings from multiple roles.
  const locations = new Set(unresolved.map(i => i.location.trim()));
  if (locations.size > 2)
    return "讲解仍有多处缺口，需要补齐主线后再交付。";
}
