import { factualCriterion } from "../server/internal-training.ts";
export const explanationCalibration = [
  {
    id: "principles-omitted",
    text: "干预降低目标细胞读数。对照用于比较干预前后的变化。",
    source:
      "目标细胞依赖抗凋亡通路存活，干预抑制该通路；读数为存活细胞比例。对照用于排除溶剂影响。",
    checks: [
      { criterion: "干预选择原理已解释", passed: false },
      { criterion: "测量对象已解释", passed: false },
    ],
  },
  {
    id: "principles-complete",
    text: "这些细胞依赖抗凋亡通路抵抗细胞死亡。干预抑制该通路，使它们较难存活；存活细胞比例的下降据此支持清除效果。溶剂对照用于检查下降是否来自溶剂本身。",
    source:
      "目标细胞依赖抗凋亡通路存活，干预抑制该通路；读数为存活细胞比例。对照用于排除溶剂影响。",
    checks: [
      { criterion: "干预选择原理已解释", passed: true },
      { criterion: "测量对象已解释", passed: true },
      { criterion: "对照作用已解释", passed: true },
    ],
  },
  {
    id: "terms-without-bridge",
    text: "依据 ROS、MFI 与归一化中介识别即可确证因果。",
    source: "MFI 为荧光平均强度，反映探针信号，不能单凭该读数证明因果。",
    checks: [
      { criterion: "术语含义与读数到推理连接可理解", passed: false },
      { criterion: factualCriterion, passed: false },
    ],
  },
  {
    id: "revision-regression",
    text: "修订稿：对照为 0%，公式为信号除以对照再减 1。",
    source:
      "原图对照位于 100%；信号除以同背景对照后乘 100%，没有减 1。首稿：对照为 100%。",
    checks: [
      { criterion: factualCriterion, passed: false },
      { criterion: "修订保留已核实参照且未引入错误公式", passed: false },
    ],
  },
  {
    id: "supported-correction-and-gap",
    text: "按图注纠正参照：以同背景对照为 100%，计算为信号除以对照再乘 100%。材料未给误差线定义，无法判断误差线代表标准差还是标准误。",
    source:
      "对照为 100%；信号除以对照乘 100%。图注没有说明误差线定义。首稿误称对照为 0%。",
    checks: [
      { criterion: factualCriterion, passed: true },
      { criterion: "根据来源纠错且区分真实材料缺口", passed: true },
    ],
  },
  {
    id: "unused-and-contamination",
    text: "内部 BP-2 已处理，核验仍在进行。没有材料说明测量原理。核验背景尚未确认。",
    source:
      "提供的正文明确解释荧光读数是探针信号，细胞数量也会影响总体读数。BP-2 是内部反馈编号。",
    checks: [
      { criterion: "区分已有材料未使用与真正材料缺失", passed: false },
      { criterion: "交付正文没有内部工作状态污染", passed: false },
    ],
  },
] as const;
