import type { Source } from "../shared/types.ts";

// Shared foundation records; independent of any example paper.
export const existingFoundations: Source[] = [
  {
    id: "pcr-mechanism",
    title: "PCR：为什么能逐轮复制？",
    kind: "foundation",
    verified: true,
    locator: "NHGRI PCR Fact Sheet / How does PCR work?",
    url: "https://www.genome.gov/about-genomics/fact-sheets/Polymerase-Chain-Reaction-Fact-Sheet",
    text: "DNA 双链经加热分开，DNA 聚合酶以已有链为模板合成新链。重复这一过程，可以增加目标片段的拷贝数。扩增的用途是为后续检测提供足够材料。此处讲基础原理，不提供任何具体论文的温度、循环次数或操作条件。",
  },
  {
    id: "qpcr-chemistry",
    title: "qPCR：复制与荧光的连接",
    kind: "foundation",
    verified: true,
    locator:
      "Applied Biosystems Reagent Guide 4387787b / Chapter 2, How the SYBR Green reagents work",
    url: "https://tools.thermofisher.com/content/sfs/manuals/cms_052263.pdf",
    text: "以 SYBR Green I 染料法为例：染料结合双链 DNA 后产生较强荧光；扩增产生更多双链 DNA，使这一信号随产物积累增强。染料可结合任何双链 DNA，不能只凭荧光判断产物一定是目标。这里是某类 qPCR 检测化学的通用示例，不意味着当前论文使用了这类染料。其他检测化学需另看具体资料。",
  },
  {
    id: "qpcr-basics",
    title: "qPCR：荧光与阈值",
    kind: "foundation",
    verified: true,
    locator: "Real-Time PCR: Understanding Ct / Introduction",
    url: "https://www.thermofisher.com/us/en/home/life-science/pcr/real-time-pcr/real-time-pcr-learning-center/real-time-pcr-basics/real-time-pcr-understanding-ct.html",
    text: "qPCR 在核酸扩增期间监测荧光。扩增指复制目标 DNA 片段，使微弱信号便于检测。Ct 是荧光曲线越过阈值时的循环位置。在相同且合适的反应条件下，起始模板较多通常较早越过阈值；试剂、效率与仪器也影响 Ct，不能直接比较不同条件的 Ct。RNA 表达研究还需逆转录得到 cDNA。",
  },
  {
    id: "qpcr-controls",
    title: "qPCR：对照与解释范围",
    kind: "foundation",
    verified: true,
    locator:
      "Essentials of Real-Time PCR / Terms Used in Quantitation Analysis",
    url: "https://www.thermofisher.com/hk/en/home/life-science/pcr/real-time-pcr/real-time-pcr-learning-center/real-time-pcr-basics/essentials-real-time-pcr.html",
    text: "无模板对照（NTC）用于检查无目标模板条件下的扩增背景。定量需要合适的标准或归一化参照。核酸信号不等于蛋白质活性，更不能独自证明细胞功能发生改变。这里是独立基础课程，不声称本篇论文的具体操作参数已被核对。",
  },
  {
    id: "flow-basics",
    title: "流式：逐细胞光学检测",
    kind: "foundation",
    verified: true,
    locator: "Flow Cytometry Basics Guide / Principles, Controls",
    url: "https://www.bio-rad-antibodies.com/static/2022/flow/flow-cytometry-basics-guide.pdf",
    text: "流式细胞术逐个检测流经激光的细胞或颗粒的散射与荧光信号。FSC 与细胞大小有关，SSC 与内部复杂程度有关，但不能只凭散射确定细胞身份。门控是在图中选择符合条件的事件群；应检查单细胞、活细胞、未染色和补偿等相关对照。阳性比例取决于门控与分母；荧光阳性不等于功能已获证明。此条目为独立基础课程。",
  },
];
