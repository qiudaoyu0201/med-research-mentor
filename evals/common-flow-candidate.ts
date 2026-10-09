import { createHash } from "node:crypto";
import type { RuleSnapshot } from "../server/skills.ts";

// Experimental, never loaded automatically by the online product.
export function commonFlowCandidate(
  baseline: RuleSnapshot,
  variant = "common-flow-candidate1",
): RuleSnapshot {
  const candidate = structuredClone(baseline);
  const additions: Record<string, string> = {
    "medical-paper-guide": `
补讲概念时区分通用原理与本篇观察，引用已有基础资料支持定义、论文原文支持具体实验与数字；没有提供定义来源时可用明确标识的通用背景，不暗示论文验证了该定义。用自然的小标题或过渡句区分即可，不为分类把流畅讲解拆成大量碎片。原文确实缺少的复现细节说明一次边界，不重复堆免责声明。
`,
    "medical-journal-club-ppt": `
修订新增统计或方法解释时，同步检查该段和该页的引用：论文摘要支持本研究数字，基础资料支持通用定义，两者不可互换。把基础解释与论文结果分开成简短段落，分别引用已有的对应来源；来源没有说明的通用背景可明确归为background，不把论文引用伪装成定义证据。引用字段只能使用当前来源ID。
汇报面向已读论文者，保留理解当前结果必要的概念和推理，不为满足试读把所有统计公式塞进页面。原文未提供公式、细节或原图时，准确说明一次资料边界；不编造，不反复铺陈。
`,
    "medical-novice-simulator": `
复读时区分“没解释懂”和“来源没有提供”。如果当前讲解已经讲清必要概念、比较和结论边界，仅缺本任务未要求复现的具体公式或参数，可在understood复述“知道是什么但当前材料不能复算”，原断点标resolved；这只表示理解了边界，不表示缺失证据已补齐。不能因此关闭仍存在的分子分母混淆、比较对象不明、测量到结论跳步或必要术语未解释。汇报试读按已读论文的听众目标，不要求把汇报改成长篇入门课。
`,
    "medical-grounding-check": `
核对新增基础解释的来源用途：通用定义应绑定提供的foundation来源，论文来源只支持其实际报告。background可以承载明确标识且不冒充本研究发现的通用知识；不能把准确的基础解释当作论文已验证结论，也不能因为background标签就放过错误定义。已准确说明且不影响当前必要理解的资料限制集中记在limitations，不反复列作待修错误。真实的数字、对象、对照、因果、引用错配仍严格处理。
按当前原句的实际语义判断归属，不仅凭section.kind判断科学错误。段落虽然合并叙述，但已经用“通用理解”“摘要未提供”“应用前仍需核实”等自然措辞清楚区分背景、论文事实与建议时，不把建议拆段本身列为fact/scope缺陷。若读者确实会被误导为论文已验证某项结论，指出准确原句和证据矛盾，不能用这条规则放过真正越界。
`,
  };
  if (["common-flow-candidate2", "common-flow-candidate3"].includes(variant)) {
    additions["medical-journal-club-ppt"] += `
交付前逐页检查每个关键结果能否回答“比较谁、测什么、方向和大小、支持到哪一步”。出现主要/次要复合终点时简短写明各自组成，不能仅留下抽象终点名称；来源缺失才保留未知。基础解释优先放独立notes，页面保留必要定义、结果和条件，不挤成教程。
HR（hazard ratio，危险比）描述事件的瞬时发生危险之比，不能写成累积风险比RR；事件率差、相对变化与HR分别保留各自含义。修订概念解释时核对同页要点、notes和unit，防止新解释挤掉已提供的终点定义、对照或不显著结果。
`;
  }
  if (variant === "common-flow-candidate3")
    additions["medical-journal-club-ppt"] += `
多组原图必须逐面板核对比较对象，尤其是显著性括号或连线两端：剂量组之间的差异不能写成相对非处理/非衰老对照的差异。各功能指标的对照未必相同，不能用一个“功能均下降”替代全部面板的比较关系。notes明确相应组名、剂量和指标；正文概括也不能改变比较对象。图注总体描述不能代替可见括号的具体含义；无法辨认时不补造比较。
`;
  for (const [id, addition] of Object.entries(additions)) {
    const entry = candidate.entries[id];
    if (!entry) throw new Error(`缺少候选规则入口：${id}`);
    entry.text += addition;
    entry.version += "-" + variant;
    entry.hash = createHash("sha256").update(entry.text).digest("hex");
  }
  return candidate;
}
