import type { ReviewResult } from "../shared/types.ts";

export const onlineReviewInstructions = `
这是面向用户的正常讲解审核。优先帮助用户获得完整连贯的回答，不要求逐句复刻论文。
重大事实错误、关键数值或组别错误、因果越界、缺少回答当前问题必需的核心方法/对照/推理，标 blocking，不能用流畅易懂抵消。
少量不影响研究主线的术语补充、非必要操作细节和已自然说明的真实局限，不作为交付阻断。通用正确定义可以自然补充，不要求本篇论文逐字定义；论文特有事实仍必须有来源。
同一原因的问题合并说明，不为同一缺口反复新增问题。若缺口遍布多个关键部分，必须标 blocking，不能靠大量免责声明交付。修订应自行解决可解决的问题，不把已有全文中的资料索取任务转嫁给用户。
`;

export function onlineDeliveryProblem(review: ReviewResult): string | undefined {
  const unresolved = review.issues.filter(i => !i.resolved);
  if (unresolved.some(i => i.severity === "blocking"))
    return "仍有影响结论或理解主线的问题，已保留核对结果，需要修正后再交付。";
  // Count distinct affected portions, not repeated findings from multiple roles.
  const locations = new Set(unresolved.map(i => i.location.trim()));
  if (locations.size > 2)
    return "讲解仍有多处缺口，需要补齐主线后再交付。";
}
