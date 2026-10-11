"""Build local contest evidence attachments from existing verified records."""
from pathlib import Path
import json, re, shutil, hashlib, zipfile, html
from xml.etree import ElementTree as ET
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, KeepTogether
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/pdf/医研导师作品支撑材料'
QA = ROOT / 'runs/support-materials-review'
OUT.mkdir(parents=True, exist_ok=True)
QA.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont('CN', 'C:/Windows/Fonts/simhei.ttf'))
BLUE = colors.HexColor('#215C86')
INK = colors.HexColor('#203144')
styles = {
    'title': ParagraphStyle('title', fontName='CN', fontSize=24, leading=33, textColor=INK, spaceAfter=16),
    'sub': ParagraphStyle('sub', fontName='CN', fontSize=11, leading=18, textColor=BLUE, spaceAfter=16),
    'h': ParagraphStyle('h', fontName='CN', fontSize=14, leading=21, textColor=BLUE, spaceBefore=14, spaceAfter=8, keepWithNext=True),
    'p': ParagraphStyle('p', fontName='CN', fontSize=11, leading=19, textColor=INK, spaceAfter=10, wordWrap='CJK'),
    'small': ParagraphStyle('small', fontName='CN', fontSize=9, leading=15, textColor=colors.HexColor('#566678'), spaceAfter=8, wordWrap='CJK'),
}
def para(text, style='p'):
    return Paragraph(html.escape(text), styles[style])
def footer(c, d):
    w,h=d.pagesize
    c.setStrokeColor(colors.HexColor('#DCE4EC')); c.line(44, 42, w-44, 42)
    c.setFont('CN',9); c.setFillColor(BLUE)
    c.drawString(44,27,'医研导师  /  作品支撑材料')
    c.drawRightString(w-44,27,str(d.page))
def pdf(name, story):
    d=SimpleDocTemplate(str(OUT/name), pagesize=(595.28,841.89), rightMargin=48,leftMargin=48,topMargin=43,bottomMargin=57,
                        title=name.removesuffix('.pdf'),author='秋刀鱼 / qiudaoyu0201')
    d.build(story,onFirstPage=footer,onLaterPages=footer)
def read(p): return json.loads((ROOT/p).read_text(encoding='utf-8-sig'))
base='runs/internal-training/mainline-campaign-20261010-candidate2/records'
repair='runs/internal-training/mainline-campaign-20261010-proposal-repair/records'
before=read(base+'/research-plan-jobs/b9ce6a86-de58-421b-850a-55545a174728.json')
after=read(repair+'/training/report.json')
result=after['results'][0]
assert before['review']['issues'][0]['id']=='index-hospitalization-handling'
assert result['cross']['evaluation']['passed'] and result['transfer']['passed']
assert all(x['passed'] for x in result['cross']['evaluation']['review']['checks'])
testlog=(ROOT/'runs/support-materials-tests.log').read_text(encoding='utf-8',errors='replace')
counts=re.search(r'tests (\d+)',testlog)
assert counts and re.search(r'fail 0\b',testlog), 'Fresh test run must pass'
n=counts.group(1)
story=[]
def add(text,style='p'): story.append(para(text,style))
add('医研导师｜成果与验证','title')
add('面向医学科研新手的论文学习智能体 · 支撑说明','sub')
add('01  实际产出样例','h')
add('本材料以成品和可追溯的验证案例，补充设计说明及演示视频。产出样例采用 Hewitt 等的端粒损伤论文，内部迭代案例采用 EMPA-REG OUTCOME 相关研究任务，分别展示交付质量与协作机制。')
add('论文汇报：提供六页可编辑 PPTX，以及相同页面的 PDF 预览。内容覆盖研究背景、实验思路、关键对照、主要结果与局限，保留论文图件及页内来源定位。独立讲述提示帮助使用者组织口头表达。')
add('研究方案：提供完整的体外研究草案 PDF，包含分组、时间序列、主要指标、成像质控、统计思路与可能结果。数量和比例分别报告，固定样本的群体轨迹与单细胞追踪分别解释。')
add('02  样例中的科学思路','h')
add('论文中 TAF 比例上升，并不自动说明 TAF 数量增加。汇报同时解释端粒相关焦点和非端粒相关焦点的变化；研究方案据此把每细胞数量轨迹作为主要终点，将比例作为辅助指标，并保留同期对照与独立培养批次。')
add('这种衔接使“读懂结论”进一步转化为“知道应测量什么、比较什么”。提交的两份样例为本地保存、经过核对的展示产物；支撑说明中的迭代结果则来自独立保存的内部运行记录。','small')
add('03  附件阅读顺序','h')
add('先阅读本说明的协作案例与验证摘要，再查看 02 汇报样例 PDF、03 可编辑 PPTX、04 研究方案 PDF，以及 05 独立讲述提示。各文件可分别打开，不依赖本地智能体运行。')
story.append(PageBreak())
add('交叉验证与修订案例','title')
add('病例资料研究任务 · 内部模型模拟与核验记录','sub')
add('01  任务与初始状态','h')
add('围绕 EMPA-REG OUTCOME 的试验证据，系统完成论文带读、汇报和一份基于本院既往病历的观察研究方案。candidate2 阶段的带读和 PPT 已通过该轮主线与严格检查，但研究方案的核对发现了实质性设计问题。')
add('02  核验发现：用药前的住院不能算作用药后的结局','h')
add('如果首次开药发生在一次正在进行的住院中，从索引日次日开始计风险，仍可能将促成用药决策的同一次住院算作暴露后的结局。核验 Agent 将“索引住院的处理规则未明确”列为阻断问题，方案没有被当作合格产物继续用于教学曝光。')
add('03  修订与三功能联合复核','h')
add('后续 proposal-repair 运行复用同一候选规则下已合格的带读和 PPT，修订研究方案，并对三项产物进行联合核验。复核记录确认：两组采用相同的索引日、基线、洗脱、住院重叠排除及风险起点规则；问题、对照、结局与可用资料保持一致。')
add('交叉检查同时核实五个方面：原始证据支持；跨产物关键条件一致；原研究结果与新方案假设分开；测量与对照能回答问题；PPT 页面自身保留关键证据和限制。该轮五项检查均通过。')
add('04  新手模拟者能否迁移到另一种资料条件？','h')
add('随后将条件改为“低风险、未确诊糖尿病成年人，仅有一次体检，无用药和随访”。模拟新手明确回答：不能估计药物治疗效果；现有资料可做横断面描述，不能照搬试验效应量、样本量或生存分析。独立迁移核验的五项检查均通过。')
add('这条记录体现：修订产物后，还要检查新手能否保留研究条件、理解结论边界，并把方法迁移到合适的问题上。这里报告的是内部模拟验证结果。','small')
story.append(PageBreak())
add('验证范围与核查入口','title')
add('保存的运行证据 + 本次交付检查','sub')
add('01  内部交叉迭代','h')
add('上述修订运行记录了 5 次模型调用，并复用了此前已通过检查的带读和 PPT。三功能联合核验通过，条件迁移核验通过。调用数按该运行报告口径列示，不等同于五轮迭代或五名用户测试。')
add('02  功能与工程验证','h')
add(f'本次整理时重新运行现有自动化测试：{n} 项通过、0 项失败。测试覆盖会话与来源归属、引用、调度与取消、版本保存、方案导出、跨功能核验和内部训练记录等工程行为。')
add('保存的研究方案浏览器验收报告列出了六组通过项，包括创建与提交、保存与恢复、导出资格、取消与重试，以及浅深色和多个窗口宽度的显示检查。该报告的模型调用数为 0，证明对应界面与流程行为；模型生成与迁移结果另由运行记录支撑。')
add('03  本组材料提供的证据','h')
add('实用性：可直接查看的论文汇报和研究方案成品。创新性：三功能共享证据并由多 Agent 交叉复核，进一步检验模拟新手的条件迁移。阶段性成效：真实记录中的问题定位、修订与后续通过结果。')
add('04  开源代码与 Skill','h')
add('项目：医研导师 / Med Research Mentor\n署名：秋刀鱼 / qiudaoyu0201')
story.append(Paragraph('<link href="https://github.com/qiudaoyu0201/med-research-mentor" color="#215C86">https://github.com/qiudaoyu0201/med-research-mentor</link>',styles['p']))
add('仓库作为源码、模块化 Skill 与协作设计的补充核查入口；附件本身包含可离线阅读的成品和验证说明。')
add('证据索引：E1＝candidate2 的方案核对记录；E2＝proposal-repair 的 training/report；E3＝研究方案 browser/report；E4＝本次自动化测试输出。对应完整路径、标识与文件摘要保存在本地核查记录中。','small')
pdf('01_成果与验证说明.pdf',story)

source=ROOT/'docs/recording-research-plan/预备研究方案.md'
text=source.read_text(encoding='utf-8-sig')
proposal=[para('端粒相关损伤灶的群体残留轨迹\n与成纤维细胞衰老','title'),para('研究方案样例 · 供课题讨论的体外研究草案','sub')]
for block in text.split('\n\n'):
    if block.startswith('# '): continue
    if block.startswith('## '):
        if block.startswith('## 7.'): proposal.append(PageBreak())
        proposal.append(para(block[3:].strip(),'h'))
    elif block.strip():
        for item in re.split(r'\n(?=\d+\. )', block.strip()):
            proposal.append(para(item))
pdf('04_研究方案样例.pdf',proposal)

src=ROOT/'runs/video-ppt-prepared-20261011/预备汇报.pptx'
shutil.copy2(src,OUT/'03_论文汇报样例.pptx')
renders=ROOT/'runs/internal-training/video-ppt-prepared-20261011'
with zipfile.ZipFile(src) as z:
    slides=sorted([p for p in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',p)],key=lambda s:int(re.search(r'slide(\d+)',s).group(1)))
    assert len(slides)==6
    slide_text=[' '.join(ET.fromstring(z.read(p)).itertext()) for p in slides]
    assert all(t in s for t,s in zip(['研究背景','实验思路','主要结果一','关键对照','主要结果二','创新'],slide_text))
c=canvas.Canvas(str(OUT/'02_论文汇报预览.pdf'),pagesize=(960,540))
c.setTitle('端粒损伤论文汇报样例'); c.setAuthor('秋刀鱼 / qiudaoyu0201')
for i in range(1,7):
    c.drawImage(ImageReader(str(renders/f'幻灯片{i}.PNG')),0,0,960,540,preserveAspectRatio=True,anchor='c'); c.showPage()
c.save()
shutil.copy2(ROOT/'runs/video-ppt-prepared-20261011/讲述提示.md',OUT/'05_独立讲述提示.md')
(OUT/'00_文件目录.md').write_text('''# 医研导师作品支撑材料

1. 01_成果与验证说明.pdf：三页，介绍成品、真实交叉验证案例和测试范围。
2. 02_论文汇报预览.pdf：六页，便于直接查看汇报版式与原图。
3. 03_论文汇报样例.pptx：对应的可编辑汇报成品。
4. 04_研究方案样例.pdf：端粒论文相关体外研究草案。
5. 05_独立讲述提示.md：与六页 PPT 对应的口头讲述提示。

PPT 与研究方案是保存并核对后的展示样例。内部迭代案例来自另一组医学研究任务，用于呈现真实修订和复核过程。

GitHub：https://github.com/qiudaoyu0201/med-research-mentor

样例论文与图件来源：Hewitt G, et al. Telomeres are favoured targets of a persistent DNA damage response in ageing and stress-induced senescence. Nature Communications. 2012;3:708. https://doi.org/10.1038/ncomms1708 。论文标注许可为 CC BY-NC-SA 3.0；图件权利归原作者，样例保留相应来源。
''',encoding='utf-8')
evidence={
 'E1':base+'/research-plan-jobs/b9ce6a86-de58-421b-850a-55545a174728.json',
 'E2':repair+'/training/report.json',
 'E3':'runs/research-plan-implementation/browser/report.json',
 'E4':'runs/support-materials-tests.log',
 'PPT':'runs/video-ppt-prepared-20261011/预备汇报.pptx',
 'proposal':'docs/recording-research-plan/预备研究方案.md',
}
manifest={k:{'path':p,'sha256':hashlib.sha256((ROOT/p).read_bytes()).hexdigest()} for k,p in evidence.items()}
(QA/'evidence.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(OUT)
