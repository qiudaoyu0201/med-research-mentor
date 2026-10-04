import type { Source, PaperBundle } from "../shared/types.ts";
import { existingFoundations } from "../materials/foundations.ts";
import { digest, bindPaperEvidence } from "./materials.ts";

const date = "2026-10-04";
const aliases: Record<string, string[]> = {
  "pcr-mechanism": ["PCR", "聚合酶链式反应", "扩增"],
  "qpcr-chemistry": [
    "PCR",
    "qPCR",
    "RT-PCR",
    "real-time PCR",
    "SYBR",
    "Ct",
    "荧光",
  ],
  "qpcr-basics": ["PCR", "qPCR", "RT-PCR", "real-time PCR", "Ct", "阈值"],
  "qpcr-controls": ["PCR", "qPCR", "Ct", "NTC", "无模板对照"],
  "flow-basics": ["流式", "flow cytometry", "门控"],
};
const existing = existingFoundations.map((s): Source => ({
  ...s,
  foundation: {
    version: "1.0.0",
    concepts: [s.title],
    aliases: aliases[s.id],
    prerequisites: s.id.startsWith("qpcr") ? ["pcr-mechanism"] : [],
    scope: "通用基础；具体论文条件须依据该论文方法核对。",
    limitations: "不用于确定未提供论文的操作参数或实验结论。",
    status: "available",
    references: [
      {
        id: s.id + "-reference",
        title: s.title,
        url: s.url!,
        locator: s.locator,
      },
    ],
    claims: [{ text: s.text, referenceIds: [s.id + "-reference"] }],
    verification: {
      date,
      readScope: "沿用项目来源记录中已读的官方原理／术语章节；独立短摘要。",
      supportedClaims: [s.text],
    },
  },
}));

function entry(
  id: string,
  title: string,
  aliases: string[],
  text: string,
  reference:
    | NonNullable<Source["foundation"]>["references"][number]
    | NonNullable<Source["foundation"]>["references"],
  readScope: string,
  prerequisites: string[] = [],
  version = "1.0.0",
): Source {
  const references = Array.isArray(reference) ? reference : [reference];
  return {
    id,
    title,
    text,
    kind: "foundation",
    url: references[0].url,
    locator: references.map((r) => r.locator).join("; "),
    verified: true,
    foundation: {
      version,
      concepts: [title],
      aliases,
      prerequisites,
      scope: "概念与测量含义；当前论文的对象、参数、对照及结论另引论文原文。",
      limitations: "原始研究的情境不能直接推广为所有细胞、组织或人的结论。",
      status: "available",
      references,
      claims: [{ text, referenceIds: references.map((r) => r.id) }],
      verification: { date, readScope, supportedClaims: [text] },
    },
  };
}
const hewitt = {
  id: "hewitt-2012-reference",
  title:
    "Hewitt et al. Telomeres are favoured targets of a persistent DNA damage response in ageing and stress-induced senescence. Nature Communications 3, 708 (2012)",
  doi: "10.1038/ncomms1708",
  pmid: "22426229",
  url: "https://pubmed.ncbi.nlm.nih.gov/22426229/",
  locator: "Abstract; Results; Figure 1 caption; Methods / Immuno-FISH",
};
export const foundationSources: Source[] = [
  ...existing,
  entry(
    "sa-beta-gal-tissue-assay",
    "SA-βgal：可追溯的组织检测方法例子",
    ["SA-βgal", "SA-β-gal", "SA-beta-gal", "Sen-β-Gal"],
    "Xu 等 2015 的正文 Methods / SABG Assay 描述：细胞或脂肪组织用 PBS 洗涤，固定 5 分钟（2% formaldehyde 与 0.25% glutaraldehyde），再洗涤后在 pH 6.0 的 SABG 活性液中于 37°C 孵育 16–18 小时；冷 PBS 洗涤终止反应，荧光显微镜取每样本约 8–10 个随机视野，DAPI 染核用于细胞计数。仅当当前论文明确引用此文作为检测方法时，才能通过该引用链解释其方法依据；其他论文不自动沿用。本段没有列出活性液完整配方，不据通用 X-Gal 示例补造其底物或判色阈值。",
    {
      id: "xu-2015-sabg-reference",
      title:
        "Xu et al. JAK inhibition alleviates the cellular senescence-associated secretory phenotype and frailty in old age. PNAS 112, E6301–E6310 (2015)",
      doi: "10.1073/pnas.1515386112",
      pmid: "26578790",
      url: "https://www.pnas.org/doi/full/10.1073/pnas.1515386112",
      locator: "Main text / Methods / SABG Assay",
    },
    "2026-10-05 读取出版商开放正文 Methods / SABG Assay 两段；未读取独立补充材料。具体论文引用链另由该论文的方法与参考文献确认。",
    ["sa-beta-gal"],
  ),
  entry(
    "taqman-basics",
    "TaqMan：探针怎样连接扩增与荧光",
    ["TaqMan", "水解探针", "5′核酸酶"],
    "TaqMan 通用检测原理中，探针带有报告荧光基团与淬灭基团。完整探针中两者靠近，报告荧光受抑制；探针与目标序列结合后，聚合酶延伸时的 5′ 核酸酶活性可切割探针，使报告基团与淬灭基团分离，荧光增强。循环中的切割与扩增产物积累相联系，仪器逐循环监测信号，再按阈值读出 Ct。比较起始模板需要合适且可比的反应条件，RNA 比较还需逆转录与合适的归一化参照。本条解释通用探针原理，不确定论文的具体探针配方、效率或计算公式，也不以 SYBR 染料原理代替 TaqMan。",
    {
      id: "ab-taqman-reference",
      title:
        "Applied Biosystems Real-Time PCR Systems Chemistry Guide, P/N 4378658 Rev. A",
      url: "https://documents.thermofisher.com/TFS-Assets/LSG/manuals/cms_042681.pdf",
      locator:
        "Printed p. 2-3 / PDF page 29, TaqMan Probe-Based Chemistry, Figure 2-2",
    },
    "官方原理指南 PDF 实际第 29 页，完整读取 How TaqMan Real-Time Chemistry Works 的四步及示意图说明。",
    ["pcr-mechanism"],
  ),
  entry(
    "sa-beta-gal-detection",
    "SA-βgal 显色：从酶活到可见信号",
    ["SA-βgal", "SA-β-gal", "SA-beta-gal", "Sen-β-Gal", "X-Gal"],
    "以 Dimri 等的显色检测为通用例子，β-半乳糖苷酶作用于底物 X-Gal 后可形成局部蓝色沉淀，通过显微镜观察细胞中的信号。这样酶活成为可观察的显色读数，再按该实验的判阳性规则计数，并明确阳性数与总计数的分母，得到比例。这是测量链的示例，不意味着所有论文采用同一试剂、颜色阈值或方法。当前论文具体的底物、染色参数与判阳性细则仍须其方法支持；缺少时只能说明已知的酶活／阳性比例含义，不能用通用例子补成论文已核验步骤。",
    {
      id: "dimri-1995-reference",
      title:
        "Dimri et al. A biomarker that identifies senescent human cells in culture and in aging skin in vivo. PNAS 92, 9363–9367 (1995)",
      doi: "10.1073/pnas.92.20.9363",
      url: "https://pure.rug.nl/ws/files/3279918/1995ProcNatlAcadSciDimri.pdf",
      locator:
        "Printed p. 9364 / PDF page 3, β-Galactosidase Staining and β-Gal in Cultured Human Fibroblasts",
    },
    "原始论文开放机构仓储 PDF，第 3 页（前有机构封面）方法及结果读取：X-Gal 检测与局部蓝色沉淀。",
    ["sa-beta-gal"],
  ),
  entry(
    "mrna-basics",
    "mRNA：从遗传信息到蛋白质的连接",
    ["mRNA", "信使RNA", "信使 RNA", "RNA表达", "RNA 表达"],
    "mRNA 是信使 RNA，由 DNA 的转录产生，携带合成蛋白质的信息。核糖体读取 mRNA 的序列并通过翻译合成蛋白质链。检测某基因的 mRNA，是检测这一信息载体的水平；该检测没有直接测量对应蛋白的数量或实际功能。因此 mRNA 表达差异可以支持 RNA 层面的变化，不能直接当作蛋白功能变化，后者需要相应的蛋白或功能测量。这里说明测量层面的边界，不推定当前论文已进行这些额外实验。",
    {
      id: "nhgri-mrna-reference",
      title: "NHGRI Talking Glossary: Messenger RNA (mRNA)",
      url: "https://www.genome.gov/genetics-glossary/Messenger-RNA-mRNA",
      locator:
        "Definition / transcription, information transfer and translation",
    },
    "官方术语页 Definition 全段，核对转录、mRNA 信息传递及翻译；测量边界为对检测对象的明确区分。",
  ),
  entry(
    "qpcr-normalization",
    "qPCR：内参、归一化与相对表达",
    [
      "qPCR",
      "RT-PCR",
      "real-time PCR",
      "内参",
      "归一化",
      "相对表达",
      "相对mRNA",
      "TBP",
    ],
    "内参是在同一样本中一起测量的参照基因，归一化用于帮助校正起始材料量、核酸制备与逆转录等差异。内参必须在所研究条件下相对稳定，不能假定任何一个基因在所有实验中都合适。概念例子：仅因投入更多材料，目标和稳定内参的测量一起增大，不能直接解释为目标相对表达升高；目标相对于稳定内参的变化才是归一化比较关心的内容。内参基因与校准样本是两个概念：前者参照样本内的输入差异，后者是相对量比较的基准。当前论文具体选哪一个校准组、采用什么公式以及是否验证内参稳定性，必须另看论文，不能由此例推断。",
    [
      {
        id: "thermo-normalization-reference",
        title: "Thermo Fisher Scientific: TaqMan Endogenous Control Assays",
        url: "https://www.thermofisher.com/us/en/home/life-science/pcr/real-time-pcr/real-time-pcr-assays/taqman-gene-expression/single-tube-taqman-gene-expression-analysis/taqman-endogenous-controls.html",
        locator:
          "Endogenous control normalization / Selecting an endogenous control",
      },
      {
        id: "thermo-calibrator-reference",
        title: "Applied Biosystems Analysis Software: Getting started",
        url: "https://apps.thermofisher.com/apps/help/MAN0010505/GUID-7EED12A1-3341-4445-9C82-CCB7111325DD.html",
        locator:
          "Comparative CT / Reference sample and Endogenous control; Relative standard curve method",
      },
    ],
    "官方 Endogenous Control 正文，核对起始材料、逆转录差异和情境内稳定性；另读官方 QuantStudio Getting started 的 endogenous control / reference sample / normalization 定义。",
    ["pcr-mechanism"],
  ),
  entry(
    "pvalue-basics",
    "P 值与统计显著性的含义",
    ["P 值", "p-value", "P <", "P =", "显著", "ANOVA", "Tukey", "统计比较"],
    "P 值是在指定统计模型及其假设下，观察到当前或更不相容数据的概率。以组间无差异为零假设时，小 P 值提示数据与该假设较不相容；它不是“没有差异的概率”，也不是“结果由偶然造成的概率”。统计显著不能测量效应大小或重要性；均值方向、差异幅度、研究设计和不确定性要一起看。图中星号的阈值与被比较组别依据该图图注确认。没有显著差异不等于证明没有效应。",
    {
      id: "asa-2016-reference",
      title:
        "Wasserstein and Lazar. The ASA Statement on p-Values: Context, Process, and Purpose. The American Statistician 70, 129–133 (2016)",
      doi: "10.1080/00031305.2016.1154108",
      url: "https://doi.org/10.1080/00031305.2016.1154108",
      locator: "Statement / definition and principles 1, 2, 5 and 6",
    },
    "原始声明网页的检索可读正文：定义与原则；DOI 直接访问受限，另核对 ASA 官方发布说明。",
  ),
  entry(
    "sem-basics",
    "SEM：均值的标准误",
    ["SEM", "s.e.m.", "标准误", "误差线"],
    "SEM 是均值的标准误，用于描述样本均值估计的不确定性，不能直接解释为每个个体之间的散布；标准差 SD 描述个体观测的离散程度。在独立观测等相应前提下，均值标准误可估计为样本标准差除以样本量平方根。误差线究竟是 SEM、SD 还是置信区间，需要按当前图注确认。置信区间还结合所采用分布的临界值，SEM 本身不能直接当作 95% 置信区间；误差线重叠本身不决定统计比较是否显著。",
    {
      id: "cumming-2007-reference",
      title:
        "Cumming, Fidler and Vaux. Error bars in experimental biology. Journal of Cell Biology 177, 7–11 (2007)",
      doi: "10.1083/jcb.200611141",
      pmid: "17420288",
      url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC2064100/",
      locator:
        "What are error bars for? / Standard error / SE bars and CIs / Rules 2–3",
    },
    "原始方法说明的可读正文，SE／SD／CI 定义与独立重复实验要求；另核对 NIST 均值置信限公式。",
  ),
  entry(
    "boxplot-basics",
    "箱线图：排序、中位数和四分位数",
    [
      "箱线图",
      "箱体",
      "中位数",
      "百分位",
      "四分位",
      "box-and-whisker",
      "box plot",
      "median",
      "percentile",
    ],
    "读数从小到大排序，中位数描述中间位置：奇数个读数取中间一个，偶数个取中间两个的平均。概念示意、非论文数据：1、2、3、4、5 的中位数为 3。下、上四分位数分别对应第 25 与第 75 百分位，箱体通常覆盖中间约一半数据；中线表示中位数。须的端点有不同定义，必须核对当前图注，不能默认所有论文都用最小与最大值。中线或箱体整体更高提示这组读数的位置偏高，不意味着每个个体都更高，也不能仅凭箱体或须重叠判定统计显著。具体四分位数算法及论文原始数值须另有依据，示意数值不能写成论文观测。",
    [
      {
        id: "nist-boxplot-reference",
        title: "NIST/SEMATECH e-Handbook: Box Plot",
        url: "https://www.itl.nist.gov/div898/handbook/eda/section3/boxplot.htm",
        locator: "Purpose / Definition / Box plots with fences",
      },
      {
        id: "nist-median-reference",
        title: "NIST/SEMATECH e-Handbook: Measures of Location",
        url: "https://www.itl.nist.gov/div898/handbook/eda/section3/eda351.htm",
        locator: "Definition of Location / median",
      },
    ],
    "2026-10-05 读取 NIST 官方箱线图 Definition、不同须定义及中位数排序定义；不从示意计算推定论文统计算法。",
  ),
  entry(
    "senescence-basics",
    "细胞衰老与增殖停滞",
    ["senescence", "senescent", "衰老细胞", "细胞衰老"],
    "细胞衰老是一种稳定的增殖停滞状态，即细胞不再像原来那样继续分裂；这描述细胞状态，不等于细胞已经死亡，也不等于整个个体的年龄。Hewitt 研究讨论复制及应激诱导的衰老，用细胞增殖相关读数和损伤相关读数共同支持判断。各读数提供不同侧面，实验判断应结合诱导条件、对照与时间。",
    hewitt,
    "PubMed 摘要及本地开放全文 PDF 第 2–3 页结果与图注、第 8 页方法。",
  ),
  entry(
    "sa-beta-gal",
    "SA-βgal：衰老相关 β-半乳糖苷酶活性",
    [
      "SA-βgal",
      "SA-β-gal",
      "SA-beta-gal",
      "Sen-β-Gal",
      "beta-galactosidase",
      "半乳糖苷酶",
    ],
    "SA-βgal 是衰老相关 β-半乳糖苷酶活性，属于酶活读数。Lee 等研究说明其来自 GLB1 编码的溶酶体 β-半乳糖苷酶，可在 pH 6 的检测条件下观察。该研究中，GLB1 缺陷或降低时，细胞仍可进入衰老而没有这一活性。因此阴性不能单独排除衰老；阳性作为相关证据，还应结合增殖停滞及其他读数。这里的通用检测定义不能代替当前论文染色方法。",
    {
      id: "lee-2006-reference",
      title:
        "Lee et al. Senescence-associated beta-galactosidase is lysosomal beta-galactosidase. Aging Cell 5, 187–195 (2006)",
      doi: "10.1111/j.1474-9726.2006.00199.x",
      pmid: "16626397",
      url: "https://pubmed.ncbi.nlm.nih.gov/16626397/",
      locator: "Abstract / GLB1 perturbation experiments",
    },
    "PubMed 摘要；不包含该文完整实验流程。",
    ["senescence-basics"],
  ),
  entry(
    "p16-ink4a",
    "p16INK4a：细胞周期抑制相关蛋白",
    ["p16INK4a", "p16", "CDKN2A"],
    "p16INK4a 是细胞周期蛋白依赖性激酶 CDK4／6 的抑制因子，可参与限制细胞继续分裂。Stein 等在人二倍体成纤维细胞中观察到，衰老相关增殖停滞可早于 p16 的积累，较晚阶段 p16 升高。因此 p16 与该状态有关，但不能把 p16 升高单独当作所有细胞衰老的充分证明。读到 p16 时要先确认论文测的是 RNA 表达、蛋白量还是功能；这些读数不相同。",
    {
      id: "stein-1999-reference",
      title:
        "Stein et al. Differential roles for cyclin-dependent kinase inhibitors p21 and p16 in the mechanisms of senescence and differentiation in human fibroblasts. Molecular and Cellular Biology 19, 2109–2117 (1999)",
      doi: "10.1128/MCB.19.3.2109",
      pmid: "10022898",
      url: "https://pubmed.ncbi.nlm.nih.gov/10022898/",
      locator: "Abstract / timing of arrest and p16 accumulation",
    },
    "PubMed 摘要；RNA、蛋白、功能读数的区分另结合 qPCR 基础与当前论文。",
    ["senescence-basics"],
  ),
  entry(
    "taf-basics",
    "TAF：端粒相关 DNA 损伤反应焦点",
    ["TAF", "telomere-associated foci", "telomere associated foci", "端粒相关"],
    "TAF 是 telomere-associated foci，指与端粒共定位的 DNA 损伤反应焦点。端粒是染色体末端的保护性结构；焦点是显微图像中局部集中的信号。共定位指两类信号对应同一空间位置：观察一个损伤反应焦点是否与端粒信号重合，据其空间重合识别端粒相关焦点，而不是把任意两个亮点算作 TAF。Hewitt 的免疫荧光原位杂交（immuno-FISH）同时显示 γH2AX 损伤反应信号和端粒信号。它测的是损伤反应信号所在位置，不直接测端粒长度，也不凭单张图证明损伤持续存在；持续性需要不同时间的比较。TAF／非 TAF 数量与比例的变化支持该研究中的推理，不能单独证明整个细胞或个体已衰老。当前论文具体检测用哪种信号、怎样计数和共定位距离阈值，仍需依据该论文方法。",
    hewitt,
    "PubMed 摘要、Figure 1 完整图注；本地开放全文第 2–3 页 Results、第 8 页 Immuno-FISH。",
    ["senescence-basics"],
    "1.0.1",
  ),
];

export function aliasMatches(text: string, alias: string) {
  const normalize = (s: string) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/β/g, "beta")
      .replace(/[\s_^{}‐–-]+/g, "");
  // Keep whitespace boundaries for short Latin abbreviations: TAF must not match staff.
  if (/^[a-zA-Z]{2,4}$/.test(alias))
    return new RegExp(`(?<![a-zA-Z0-9])${alias}(?![a-zA-Z0-9])`, "i").test(
      text,
    );
  return normalize(text).includes(normalize(alias));
}
export class FoundationCatalog {
  private records = new Map<string, Source>();
  constructor(sources = foundationSources) {
    for (const source of sources) this.register(source);
    this.validateDependencies();
  }
  register(source: Source) {
    const meta = source.foundation;
    if (
      source.kind !== "foundation" ||
      !meta ||
      !meta.aliases.length ||
      !meta.version ||
      !meta.references.length ||
      !meta.claims.length ||
      !meta.verification.readScope ||
      meta.claims.some(
        (c) =>
          !c.referenceIds.length ||
          c.referenceIds.some(
            (id) => !meta.references.some((r) => r.id === id),
          ),
      ) ||
      (meta.status === "available" &&
        (!source.verified || !meta.verification.supportedClaims.length))
    )
      throw new Error("基础条目缺少核验记录、概念别名或事实出处。");
    if (this.records.has(source.id)) throw new Error("基础条目 ID 重复。");
    this.records.set(source.id, structuredClone(source));
  }
  validateDependencies() {
    const visit = (id: string, path: Set<string>) => {
      if (path.has(id)) throw new Error("基础条目依赖存在循环。");
      const source = this.records.get(id);
      if (!source) throw new Error("基础条目依赖不存在。");
      for (const dependency of source.foundation!.prerequisites)
        visit(dependency, new Set([...path, id]));
    };
    for (const id of this.records.keys()) visit(id, new Set());
  }
  all() {
    return structuredClone(
      [...this.records.values()].filter(
        (s) => s.foundation!.status === "available",
      ),
    );
  }
  match(text: string) {
    this.validateDependencies();
    const selected = new Map<string, Source>();
    const add = (source: Source) => {
      if (selected.has(source.id) || source.foundation!.status !== "available")
        return;
      selected.set(source.id, source);
      for (const id of source.foundation!.prerequisites)
        add(this.records.get(id)!);
    };
    for (const source of this.all())
      if (source.foundation!.aliases.some((alias) => aliasMatches(text, alias)))
        add(source);
    return structuredClone([...selected.values()]);
  }
  get version() {
    return digest([...this.records.values()]);
  }
}
export const foundationCatalog = new FoundationCatalog();
export function withFoundationSources(paper: PaperBundle) {
  const catalog = foundationCatalog.all();
  return bindPaperEvidence({
    ...paper,
    sources: [
      ...paper.sources.map((s) => {
        const entry = catalog.find((f) => f.id === s.id);
        const enriched =
          entry && entry.text === s.text
            ? { ...entry, ...s, foundation: entry.foundation }
            : s;
        return enriched.figure === "用户圈选" && !enriched.caption
          ? { ...enriched, caption: enriched.text }
          : enriched;
      }),
      ...catalog.filter((s) => !paper.sources.some((x) => x.id === s.id)),
    ],
  });
}
