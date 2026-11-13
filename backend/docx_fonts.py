"""Word 导出字体统一口径：东亚字体族走系统配置（DOCX_FONT_BODY/DOCX_FONT_HEADING），西文按公文惯例配对。

python-docx 的 font.name 只写 w:ascii/hAnsi；中文必须另写 w:eastAsia，
否则 Word 回退主题默认东亚字体（等线），出现"导出不是宋体/黑体"的问题。
"""
from __future__ import annotations

from typing import Any

# 配置页下拉选项（校验同口径）
FONT_CHOICES = ("宋体", "黑体", "楷体", "仿宋", "微软雅黑", "等线")
DEFAULT_BODY = "宋体"
DEFAULT_HEADING = "黑体"
_LATIN_BODY = "Times New Roman"
_LATIN_HEAD = "Arial"


def _cfg(key: str, default: str) -> str:
    try:
        from backend.api.config_router import get_config_value
        v = str(get_config_value(key, default) or default).strip()
        return v or default
    except Exception:  # noqa: BLE001 - 配置不可用时兜底默认字体
        return default


def docx_font_body() -> str:
    return _cfg("DOCX_FONT_BODY", DEFAULT_BODY)


def docx_font_heading() -> str:
    return _cfg("DOCX_FONT_HEADING", DEFAULT_HEADING)


def _set_style_font(style: Any, east: str, latin: str) -> None:
    from docx.oxml.ns import qn
    style.font.name = latin
    rpr = style.element.get_or_add_rPr()
    rpr.get_or_add_rFonts().set(qn("w:eastAsia"), east)


def apply_docx_fonts(doc: Any) -> None:
    """Normal/Title/Heading 1-4 + docDefaults 同时写西文与东亚字体；表格继承 Normal 自动生效。"""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    body, head = docx_font_body(), docx_font_heading()
    dd = doc.styles.element.find(qn("w:docDefaults"))
    if dd is not None:
        rprd = dd.find(qn("w:rPrDefault"))
        if rprd is not None:
            rpr = rprd.find(qn("w:rPr"))
            if rpr is None:
                rpr = OxmlElement("w:rPr")
                rprd.append(rpr)
            rf = rpr.find(qn("w:rFonts"))
            if rf is None:
                rf = OxmlElement("w:rFonts")
                rpr.insert(0, rf)
            rf.set(qn("w:ascii"), _LATIN_BODY)
            rf.set(qn("w:hAnsi"), _LATIN_BODY)
            rf.set(qn("w:eastAsia"), body)
    for name in ("Normal", "Title", "Heading 1", "Heading 2", "Heading 3", "Heading 4"):
        try:
            st = doc.styles[name]
        except KeyError:
            continue
        if name == "Normal":
            _set_style_font(st, body, _LATIN_BODY)
        else:
            _set_style_font(st, head, _LATIN_HEAD)
