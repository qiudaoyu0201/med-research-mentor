"""Convert the saved speaking notes without regenerating other attachments."""
from pathlib import Path
from xml.sax.saxutils import escape
import zipfile
from reportlab.platypus import SimpleDocTemplate, Paragraph, KeepTogether
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pypdf import PdfReader

root = Path(__file__).resolve().parents[1]
folder = root / 'output/pdf/医研导师作品支撑材料'
source = folder / '05_独立讲述提示.md'
pdfmetrics.registerFont(TTFont('CN', 'C:/Windows/Fonts/simhei.ttf'))
title = ParagraphStyle('title', fontName='CN', fontSize=24, leading=32, spaceAfter=12, textColor=HexColor('#203144'))
sub = ParagraphStyle('sub', fontName='CN', fontSize=10, leading=17, spaceAfter=16, textColor=HexColor('#566678'))
head = ParagraphStyle('head', fontName='CN', fontSize=13, leading=21, spaceBefore=12, spaceAfter=6, textColor=HexColor('#215C86'))
body = ParagraphStyle('body', fontName='CN', fontSize=11, leading=19, spaceAfter=10, textColor=HexColor('#203144'), wordWrap='CJK')
story = [Paragraph('论文汇报｜独立讲述提示', title), Paragraph('与六页端粒论文汇报逐页对应，供口头表达时参考。', sub)]
sections = source.read_text(encoding='utf-8-sig').split('## ')[1:]
assert len(sections) == 6
for section in sections:
    heading, text = section.strip().split('\n', 1)
    story.append(KeepTogether([Paragraph(escape(heading), head), Paragraph(escape(text.strip()), body)]))
def footer(c, d):
    c.setStrokeColor(HexColor('#DCE4EC')); c.line(48,42,547,42)
    c.setFillColor(HexColor('#215C86')); c.setFont('CN',9)
    c.drawString(48,27,'医研导师 / 作品支撑材料'); c.drawRightString(547,27,str(d.page))
target = folder / '05_独立讲述提示.pdf'
SimpleDocTemplate(str(target), pagesize=(595.28,841.89), leftMargin=48,rightMargin=48,topMargin=43,bottomMargin=57,
                  title='论文汇报独立讲述提示',author='秋刀鱼 / qiudaoyu0201').build(story,onFirstPage=footer,onLaterPages=footer)
reader = PdfReader(target)
extracted = ''.join(p.extract_text() for p in reader.pages)
assert all(s.strip().split('\n',1)[0] in extracted for s in sections)
catalog = folder / '00_文件目录.md'
catalog.write_text(catalog.read_text(encoding='utf-8').replace('05_独立讲述提示.md','05_独立讲述提示.pdf'),encoding='utf-8')
with zipfile.ZipFile(folder.with_suffix('.zip'),'w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(folder.iterdir()):
        if p.name != source.name:
            z.write(p,folder.name+'/'+p.name)
print('pages:',len(reader.pages),'sections:',len(sections))
