"""Word/Excel 导出字体统一口径：东亚字体走系统配置（DOCX_FONT_BODY/DOCX_FONT_HEADING），西文按公文惯例配对。

两个坑必须同时处理，只处理第一个就会出现「标题字体怎么设都不生效」：

1. python-docx 的 font.name 只写 w:ascii/hAnsi，中文要另写 w:eastAsia，否则 Word 回退主题东亚字体。
2. 同一个 w:rFonts 上，主题引用（w:asciiTheme / w:hAnsiTheme / w:eastAsiaTheme / w:cstheme）
   优先级高于显式的 w:ascii / w:eastAsia。python-docx 默认模板里 Title、Subtitle、Heading 1-9
   （含对应 *Char 字符样式）以及 LightGrid / MediumList 等表样式全都自带
   w:eastAsiaTheme="majorEastAsia"，而该模板主题的 majorFont 东亚字体名是空的 —— Word 于是
   一路回退成 "MS Gothic (中文标题)"。所以只补 eastAsia、不删主题引用，等于写了个被忽略的属性。
   正文字体之所以正常，是因为 Normal 样式本身不带 rFonts/主题引用，显式值直接生效。

做法（一份口径，三处落地）：
· styles.xml / stylesWithEffects.xml：先清扫主题引用（major* → 标题字体，minor* → 正文字体），
  再按样式名点名补 Normal / Title / Subtitle / Heading 1-9 的显式字体（模板里 Normal 不带 rFonts，
  光靠清扫补不出来）；
· theme1.xml：把空的东亚主题名填成配置值，给未点名到的样式与 WPS/老版本兜底；
· stylesWithEffects.xml 是默认模板里跟 styles.xml 重复的 Word 2010 兼容副本，Word 认 styles.xml，
  但留着旧数据会被别的渲染器读到，所以一起扫。
"""
from __future__ import annotations

import re
from typing import Any

# 配置页下拉选项（校验同口径）
FONT_CHOICES = ("宋体", "黑体", "楷体", "仿宋", "微软雅黑", "等线")
DEFAULT_BODY = "宋体"
DEFAULT_HEADING = "黑体"
_LATIN_BODY = "Times New Roman"
_LATIN_HEAD = "Arial"

# 与显式字体名同属一个 rFonts、且会压过显式值的主题引用属性
_THEME_ATTRS = ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme")
# 标题类样式（按 w:styleId 匹配，含字符样式变体）
_HEAD_STYLE_IDS = {
    s for base in ("Title", "Subtitle", *(f"Heading{i}" for i in range(1, 10)))
    for s in (base, base + "Char")
}
_RT_STYLES_WITH_EFFECTS = (
    "http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects"
)


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


def _safe_face(face: str) -> bool:
    """字体名要写进 XML（主题包还是字符串替换），只接受普通名称。"""
    return bool(face) and not re.search(r"""["'<>&]""", face)


def _strip_theme_refs(rfonts: Any) -> None:
    """删掉主题引用，否则同元素上的显式 w:eastAsia 会被主题值压住而不生效。"""
    from docx.oxml.ns import qn
    for attr in _THEME_ATTRS:
        name = qn(attr)
        if name in rfonts.attrib:
            del rfonts.attrib[name]


def _write_rfonts(rfonts: Any, east: str, latin: str) -> None:
    """先删主题引用、再写显式字体名（顺序反了等于白写）。"""
    from docx.oxml.ns import qn
    _strip_theme_refs(rfonts)
    rfonts.set(qn("w:ascii"), latin)
    rfonts.set(qn("w:hAnsi"), latin)
    rfonts.set(qn("w:eastAsia"), east)
    rfonts.set(qn("w:cs"), latin)


def _apply_styles_tree(styles_root: Any, head: str, body: str) -> None:
    """把一棵 styles 树（主 styles.xml 或 stylesWithEffects.xml）按配置口径落字体。"""
    from docx.oxml.ns import qn

    # 1) 清扫主题引用：docDefaults 与各样式（含表样式、字符样式）
    for rf in styles_root.iter(qn("w:rFonts")):
        refs = " ".join(str(rf.get(qn(attr)) or "") for attr in _THEME_ATTRS)
        if "major" in refs:
            _write_rfonts(rf, head, _LATIN_HEAD)
        elif "minor" in refs:
            _write_rfonts(rf, body, _LATIN_BODY)

    # 2) 按样式名点名：模板里 Normal 不带 rFonts，只靠上一步补不出显式字体
    for st in styles_root.iter(qn("w:style")):
        sid = st.get(qn("w:styleId")) or ""
        if sid == "Normal":
            east, latin = body, _LATIN_BODY
        elif sid in _HEAD_STYLE_IDS:
            east, latin = head, _LATIN_HEAD
        else:
            continue
        try:
            rpr = st.get_or_add_rPr()
            _write_rfonts(rpr.get_or_add_rFonts(), east, latin)
        except Exception:  # noqa: BLE001 - 个别样式结构异常不影响其余
            continue


def _iter_internal_parts(doc: Any, reltype: str):
    try:
        for rel in doc.part.rels.values():
            if rel.reltype == reltype and not rel.is_external:
                yield rel.target_part
    except Exception:  # noqa: BLE001
        return


def _patch_legacy_styles_part(doc: Any, head: str, body: str) -> None:
    """同步 Word 2010 兼容副本 stylesWithEffects.xml，别给外部渲染器留一份带主题引用的旧数据。"""
    try:
        from docx.oxml import parse_xml
        from lxml import etree
        for part in _iter_internal_parts(doc, _RT_STYLES_WITH_EFFECTS):
            blob = getattr(part, "_blob", None)
            if not isinstance(blob, (bytes, bytearray)) or not blob:
                continue
            root = parse_xml(bytes(blob))
            _apply_styles_tree(root, head, body)
            part._blob = etree.tostring(root, xml_declaration=True,
                                        encoding="UTF-8", standalone=True)
    except Exception:  # noqa: BLE001 - 兼容副本失败不影响主 styles.xml
        pass


def _patch_theme_east_asian(doc: Any, head: str, body: str) -> None:
    """默认模板主题的东亚字体名是空的（Word 因此回退 MS Gothic）；填成配置值给未点名的样式兜底。"""
    try:
        from docx.opc.constants import RELATIONSHIP_TYPE as RT
        for part in _iter_internal_parts(doc, RT.THEME):
            blob = getattr(part, "_blob", None)
            if not isinstance(blob, (bytes, bytearray)) or not blob:
                continue
            text = blob.decode("utf-8")
            for tag, face in (("majorFont", head), ("minorFont", body)):
                if not _safe_face(face):
                    continue
                seg = re.search(r"<a:%s>.*?</a:%s>" % (tag, tag), text, re.S)
                if not seg:
                    continue
                new_seg = re.sub(r'<a:ea typeface="[^"]*"',
                                 '<a:ea typeface="%s"' % face, seg.group(0), count=1)
                text = text[:seg.start()] + new_seg + text[seg.end():]
            part._blob = text.encode("utf-8")
    except Exception:  # noqa: BLE001 - 主题兜底失败不影响已写好的显式样式字体
        pass


def apply_docx_fonts(doc: Any) -> None:
    """Normal/Title/Heading + docDefaults 同时写西文与东亚字体，并清掉会压住显式值的主题引用；表格继承 Normal 自动生效。"""
    body, head = docx_font_body(), docx_font_heading()
    _apply_styles_tree(doc.styles.element, head, body)
    _patch_legacy_styles_part(doc, head, body)
    _patch_theme_east_asian(doc, head, body)
