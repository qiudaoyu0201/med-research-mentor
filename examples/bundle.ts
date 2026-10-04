import { existingFoundations } from "../materials/foundations.ts";
import type {
  PaperBundle,
  LearningUnit,
  DeckOutline,
  Profile,
} from "../shared/types.ts";
export const profiles: Profile[] = [
  {
    id: "beginner",
    version: "1.0.0",
    name: "医学科研初学者",
    background: "有基础医学背景，听过 PCR 与流式名称。",
    difficulties: "术语、方法原理、陌生图形、实验到结论的衔接。",
  },
  {
    id: "methods",
    version: "1.0.0",
    name: "方法入门者",
    background: "知道操作名称和基本步骤。",
    difficulties: "为什么做、测了什么、对照有什么用。",
  },
  {
    id: "reasoning",
    version: "1.0.0",
    name: "推理入门者",
    background: "可以描述图上的变化。",
    difficulties: "观察如何支持结论、替代解释与证据范围。",
  },
];
export const sample: PaperBundle = {
  id: "xu-2018",
  title: "衰老细胞如何影响身体功能？",
  version: "local-evidence-2",
  doi: "10.1038/s41591-018-0092-9",
  scope:
    "Xu 等，Nature Medicine，2018。当前内置为经过来源核对的局部中文证据摘要，并非全文或论文原图。点击来源可阅读在线原文；上传合法 PDF 后可在本机对照页面。",
  sources: [
    {
      id: "xu-question",
      title: "研究问题",
      kind: "paper",
      verified: true,
      locator: "Abstract / Introduction",
      url: "https://www.nature.com/articles/s41591-018-0092-9",
      text: "研究考察衰老细胞是否能引起身体功能下降，以及减少这类细胞是否能改善老年小鼠的功能。研究也包括人体脂肪组织的离体实验，不能等同于人体治疗试验。",
    },
    {
      id: "xu-design",
      title: "移植实验与对照",
      kind: "paper",
      verified: true,
      locator: "Results: Transplanting small numbers… / Figure 1a",
      figure: "1a",
      url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6082705/#F1",
      text: "作者向年轻小鼠移植衰老或非衰老的前脂肪细胞，并设置 PBS 注射对照，随后测量身体功能。此设计使细胞状态与移植本身的影响能够区分。此处是中文证据摘要，不是原文逐句翻译。",
    },
    {
      id: "xu-fig1",
      title: "Figure 1：功能与图注",
      kind: "paper",
      verified: true,
      locator: "Figure 1d–j caption / corresponding Results",
      figure: "1d–j",
      url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6082705/#F1",
      text: "Figure 1d–j 比较步行速度、悬挂耐力、握力、活动、跑台耐力、进食与体重等指标。图注将这些结果的误差线定义为均值的标准误（SEM）。作者报告衰老细胞移植组的部分功能指标下降，并非所有指标均有显著差异。未缓存原图，不能从此摘要读取柱高或逐点数值。",
    },
    {
      id: "xu-fig6",
      title: "Figure 6：老年小鼠与边界",
      kind: "paper",
      verified: true,
      locator: "Figure 6 / Results: Senolytics extend…",
      figure: "6",
      url: "https://www.nature.com/articles/s41591-018-0092-9",
      text: "老年小鼠研究比较达沙替尼与槲皮素组合（D+Q）与溶剂对照。论文报告身体功能和生存方面的改善。小鼠结果不能直接证明人类获益；中位剩余寿命与总寿命不是同一个指标。",
    },
    ...existingFoundations,
  ],
};
const section = (
  title: string,
  text: string,
  citations: string[],
  kind: "paper" | "foundation" | "interpretation" = "interpretation",
) => ({ title, text, citations, kind });
export const exampleUnits: Record<string, LearningUnit> = {
  paper: {
    title: "从一个问题，读懂一个实验",
    question: "衰老细胞是伴随现象，还是能引起功能下降？",
    terms: [
      {
        name: "衰老细胞（senescent cell）",
        explanation:
          "进入稳定增殖停滞状态的细胞；细胞衰老不等于整个个体已经老年。",
      },
      {
        name: "对照（control）",
        explanation: "提供比较基准，帮助区分被研究因素与其他步骤的影响。",
      },
    ],
    sections: [
      section(
        "01 · 这项研究在问什么",
        "看见老年组织中衰老细胞增多，只是一起出现。要进一步探查作用，作者主动改变小鼠接收到的细胞状态，再测量身体功能。",
        ["xu-question", "xu-design"],
      ),
      section(
        "02 · 为什么要有两种对照",
        "非衰老细胞对照帮助判断影响是否与衰老状态有关；PBS 对照帮助判断注射与移植过程的影响。把两个对照分开理解，才能知道比较到底排除了什么。",
        ["xu-design"],
      ),
      section(
        "03 · 测到了什么",
        "步行速度、悬挂耐力和握力属于不同的功能指标。论文报告部分指标下降；不能把这一观察写成“所有功能都下降”。",
        ["xu-fig1"],
        "paper",
      ),
      section(
        "04 · 从观察走到结论",
        "改变细胞状态 → 测量身体功能 → 比较干预组与对照 → 支持衰老细胞可能参与功能损伤。主动干预比单纯相关更接近因果判断，但还需要考虑模型、剂量及替代解释。",
        ["xu-design", "xu-fig1"],
      ),
      section(
        "05 · 结论停在哪里",
        "这一单元支持小鼠模型中的推理。人体离体组织与人体临床试验处在不同证据层级，不能据此推荐人类用药。",
        ["xu-question", "xu-fig6"],
      ),
    ],
    nextQuestion: "为什么移植非衰老细胞，而不只设置 PBS 对照？",
  },
  qpcr: {
    title: "qPCR：为什么复制 DNA 能帮助测量？",
    question: "qPCR 到底测到了什么？",
    terms: [
      {
        name: "扩增（amplification）",
        explanation: "把目标 DNA 片段复制成更多份，让信号更容易被检测。",
      },
      {
        name: "阈值循环（Ct）",
        explanation: "荧光曲线首次越过指定阈值时对应的循环位置。",
      },
    ],
    sections: [
      section(
        "01 · 问题与最低基础",
        "如果样本里目标核酸很少，直接检测困难。PCR 反复复制目标 DNA，qPCR 同时记录与产物积累有关的荧光。先理解“复制”，再理解荧光如何变成读数。",
        ["qpcr-basics"],
        "foundation",
      ),
      section(
        "02 · 真正测量的对象",
        "仪器读的是荧光随循环的变化，经过合适的定量方法才用于推断起始核酸量。RNA 表达通常先逆转录成 cDNA；RNA、DNA 与蛋白活性不要混为一谈。",
        ["qpcr-basics"],
        "foundation",
      ),
      section(
        "03 · 怎样读结果",
        "先认横轴循环数与纵轴荧光，再看阈值。相同有效条件下，较早越过阈值常提示起始模板较多；跨试剂与不同效率的 Ct 不能直接比较。",
        ["qpcr-basics"],
        "foundation",
      ),
      section(
        "04 · 对照与限制",
        "无模板对照用于查看背景，定量还需要标准或参照。核酸增加不能单独证明蛋白活性增加。当前为独立课程，未核验的论文操作参数不补写。",
        ["qpcr-controls"],
        "foundation",
      ),
    ],
    nextQuestion: "为什么不能把低 Ct 直接解释为蛋白更活跃？",
  },
  flow: {
    title: "流式：把一群细胞拆成逐个信号",
    question: "流式的一个点代表什么？",
    terms: [
      {
        name: "门控（gating）",
        explanation: "按图中信号条件选出要分析的事件群。",
      },
      {
        name: "事件（event）",
        explanation:
          "仪器检测到的一次颗粒通过记录；需筛选后才能当作目标单细胞分析。",
      },
    ],
    sections: [
      section(
        "01 · 用来回答什么",
        "我们想知道不同细胞群的比例或信号差异。仪器逐个检测颗粒的散射与荧光，得到许多事件记录。",
        ["flow-basics"],
        "foundation",
      ),
      section(
        "02 · 怎么认图",
        "先核对轴的信号与尺度，再看每个点属于哪类事件。FSC 与大小有关，SSC 与复杂程度有关；散射不是细胞身份的直接证明。",
        ["flow-basics"],
        "foundation",
      ),
      section(
        "03 · 为什么要门控",
        "先排除不合适的事件，再定义目标群。阳性比例必须说明分母；改变门控会改变进入分子和分母的事件。",
        ["flow-basics"],
      ),
      section(
        "04 · 对照与范围",
        "未染色及补偿等对照帮助解释荧光。阳性信号不是功能证明，且这节通用课程没有把流式实验归到当前论文。",
        ["flow-basics"],
        "foundation",
      ),
    ],
    nextQuestion: "同样的阳性细胞数量，为什么换分母后比例会改变？",
  },
  figure: {
    title: "Figure 1：先认比较，再读含义",
    question: "Figure 1 的误差线与功能结果如何理解？",
    terms: [
      {
        name: "标准误（SEM）",
        explanation: "描述样本均值估计的不确定性；不是所有个体的分布范围。",
      },
    ],
    sections: [
      section(
        "01 · 先准备图与图注",
        "固定讲解以图注摘要为依据。本机有正文时可在阅读器对照原页并圈选面板；也可打开来源或上传 PDF。没有提供图像时，不能估计柱高、坐标单位或逐点数值。",
        ["xu-fig1"],
        "paper",
      ),
      section(
        "02 · 找到图注能确认的内容",
        "Figure 1d–j 是多种身体功能及相关指标。图注定义误差线为 SEM。读任一子图时都应分别核对横轴分组、纵轴单位、样本单位和统计比较。",
        ["xu-fig1"],
        "paper",
      ),
      section(
        "03 · 观察不自动等于机制",
        "部分功能指标下降支持功能损伤；不能写成所有指标显著下降，也不能只从一个柱形图证明唯一机制。",
        ["xu-fig1"],
      ),
      section(
        "04 · 读图顺序",
        "图形类型 → 坐标与单位 → 分组与样本 → 误差线与统计标记 → 观察 → 结论边界。不清楚的标记先补材料。",
        ["xu-fig1"],
      ),
    ],
    nextQuestion: "标准误和标准差为什么不能互换？",
  },
};
export const defaultDeck: DeckOutline = {
  slides: [
    {
      title: "衰老细胞与身体功能",
      bullets: ["Xu 等 · Nature Medicine · 2018", "论文局部证据汇报"],
      notes: "今天以局部证据练习科研推理；尚未覆盖整篇方法与补充材料。",
      citations: ["xu-question"],
    },
    {
      title: "研究问题：相关，还是作用？",
      bullets: ["衰老细胞是否能引起功能下降？", "减少衰老细胞是否能改善功能？"],
      notes: "观察到两者同时出现，不等于已经建立因果。作者用干预实验推进判断。",
      citations: ["xu-question"],
    },
    {
      title: "必要基础：细胞衰老与对照",
      bullets: ["细胞衰老不等于个体老年", "对照提供比较基准"],
      notes: "先解释细胞状态，再解释为什么要控制注射与移植本身的影响。",
      citations: ["xu-design"],
    },
    {
      title: "研究路径：改变，再测量",
      bullets: ["移植衰老细胞与非衰老细胞", "设置 PBS 对照", "测量身体功能"],
      notes: "用不同对照区分细胞状态与操作过程；这一设计仍有模型适用边界。",
      citations: ["xu-design"],
    },
    {
      title: "Figure 1：部分功能指标下降",
      bullets: [
        "步行、耐力、握力等指标",
        "不能概括为所有功能均下降",
        "面板与图注需对照原文",
      ],
      notes: "当前采用图注及结果摘要。正式汇报前应对照原图坐标和各子图。",
      citations: ["xu-fig1"],
      imageSource: "xu-fig1",
    },
    {
      title: "Figure 6：老年小鼠的干预验证",
      bullets: ["D+Q 与溶剂对照比较", "观察功能与生存", "区分剩余寿命与总寿命"],
      notes: "不要将小鼠结果转成人类用药结论；汇报前需对照原图。",
      citations: ["xu-fig6"],
      imageSource: "xu-fig6",
    },
    {
      title: "结论与局限",
      bullets: [
        "干预证据支持小鼠模型中的作用",
        "离体人体组织不等于临床试验",
        "模型、材料与机制仍有边界",
      ],
      notes: "把能够支持的结论与尚待核验的内容分开。",
      citations: ["xu-question", "xu-fig6"],
    },
    {
      title: "汇报小结：把推理说完整",
      bullets: [
        "改变了什么 → 测了什么",
        "观察到了什么 → 支持什么",
        "还需要什么证据？",
      ],
      notes: "最后用自己的语言复述证据链，不把作者结论当作推理过程。",
      citations: ["xu-design", "xu-fig1"],
    },
  ],
};
