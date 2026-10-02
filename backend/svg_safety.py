"""AI 生成 SVG 的统一提取与清洗。

为什么要单独一个模块
--------------------
SVG 配图有三条入库路径（AI 批量出题返回的 ``svg_code``、单题「重新生成 SVG」、
闯关/练习/课程大纲各自的 AI 出题），历史上只有一条做了安全检查，于是：

- 未过滤的 AI SVG 会进 DB，再被 ``container.innerHTML += q.svg_code`` 注入导出的
  练习 HTML（与站点同源），成为存储型 XSS 面；
- 各处「安全过滤」写的是同一条正则 ``\\bon\\w+\\s*=\\s*["\\\'][\\s\\S]*?["\\\']``。
  它匹配的是**以 on 开头的单词**，而 ``stop-opacity``、``stroke-opacity``、
  ``fill-opacity`` 里的 ``opacity=`` 前面正好是连字符（``\\b`` 成立），于是
  ``stroke-opacity="0.5"`` 会被删成残缺的 ``stroke-``，整条渐变/描边属性报废 ——
  画出来就是「AI 明明生成了 SVG，前端却渲染成空白/错色」。

这里改成先解析出标签、再按**完整属性名**判定，合法属性一律原样保留。
"""
from __future__ import annotations

import re

# 模型输出里 SVG 的常见包装：```svg ... ``` / 裸 <svg>...</svg>
_FENCE_RE = re.compile(r"```(?:svg|xml|html)?\s*([\s\S]*?)```", re.IGNORECASE)
_SVG_BLOCK_RE = re.compile(r"<svg\b[\s\S]*?</svg\s*>", re.IGNORECASE)

# 整块移除的元素（含内容）
_FORBIDDEN_BLOCKS = ("script", "foreignObject", "iframe", "frame", "embed",
                     "object", "applet", "handler", "listener")
# 单标签也要移除的元素（自关闭写法，如 <script/>）
_FORBIDDEN_TAGS = _FORBIDDEN_BLOCKS + ("animate", "set") if False else _FORBIDDEN_BLOCKS

_TAG_RE = re.compile(r"<[^>]*>", re.S)
_ATTR_RE = re.compile(r"([^\s/<>=\"']+)([ \t]*=[ \t]*(\"[^\"]*\"|'[^']*'))?")
_SVG_NAME_RE = re.compile(r"^<\s*/?\s*([A-Za-z][\w:.-]*)", re.S)

#: 事件属性：属性名（去命名空间后）形如 on<字母>
_EVENT_NAME_RE = re.compile(r"^(?:[A-Za-z][\w.-]*:)?on[A-Za-z]{2,}$")
#: 可承载 URL 的属性
_URL_ATTR_NAMES = {"href", "xlink:href", "src", "action", "formaction", "data", "background", "cite"}
_BAD_SCHEME_RE = re.compile(r"^\s*(?:javascript|vbscript|livescript|data:text/html|mocha)\s*:", re.IGNORECASE)
_STYLE_BAD_RE = re.compile(r"(?:javascript\s*:|expression\s*\(|@import|behavior\s*:|url\([^)]*(?:https?:|ftp:|//))", re.IGNORECASE)


def extract_svg(text: str | None) -> str:
    """从模型回复里取出第一段 SVG 源码；取不到返回空串"""
    if not text:
        return ""
    block = _SVG_BLOCK_RE.search(text)
    if block:
        return block.group(0).strip()
    # 带 ```svg 围栏但内部被截断时，先剥围栏再试一次
    for fence in _FENCE_RE.finditer(text):
        block = _SVG_BLOCK_RE.search(fence.group(1))
        if block:
            return block.group(0).strip()
    return ""


def sanitize_svg(svg: str | None) -> str:
    """清洗 SVG：去掉可执行/可外联的内容，合法属性原样保留（幂等）"""
    if not svg:
        return ""
    cleaned = svg

    # 1) 含内容的危险块
    for tag in _FORBIDDEN_BLOCKS:
        cleaned = re.sub(rf"<{tag}\b[\s\S]*?</{tag}\s*>", "", cleaned, flags=re.IGNORECASE)

    # 2) 逐标签处理：危险标签整体丢弃，危险属性单独丢弃
    def _clean_tag(match: re.Match) -> str:
        raw = match.group(0)
        name_match = _SVG_NAME_RE.match(raw)
        if not name_match:
            return raw
        tag_name = name_match.group(1).lower().split(":")[-1]
        if tag_name in {t.lower() for t in _FORBIDDEN_TAGS}:
            return ""
        if raw.startswith("</"):
            return raw
        return _ATTR_RE.sub(_clean_attr, raw)

    cleaned = _TAG_RE.sub(_clean_tag, cleaned)

    # 3) <style> 里的 @import / expression
    def _clean_style(match: re.Match) -> str:
        css = match.group(1)
        css = re.sub(r"@import[^;{]*;?", "", css, flags=re.IGNORECASE)
        css = re.sub(r"expression\s*\([^)]*\)?", "", css, flags=re.IGNORECASE)
        return f"<style>{css}</style>"

    cleaned = re.sub(r"<style\b[^>]*>([\s\S]*?)</style>", _clean_style,
                     cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def _attr_value(part: str) -> str:
    """从 ``= "value"`` 这段里取出未含引号的值；无值时返回空串"""
    if not part:
        return ""
    _, sep, rest = part.partition("=")
    if not sep:
        return ""
    rest = rest.strip()
    if len(rest) >= 2 and rest[0] in "\"'" and rest[-1] == rest[0]:
        return rest[1:-1]
    return rest


def _clean_attr(match: re.Match) -> str:
    name = match.group(1)
    url_value = _attr_value(match.group(2) or "")
    bare = name.lower().split(":")[-1]

    # 事件属性（onload / svg:onclick …）——必须整条去掉，含前导空格
    if _EVENT_NAME_RE.match(name):
        return ""

    if bare in {"href", "xlink:href", "src", "action", "formaction", "background", "cite", "data"}:
        if _BAD_SCHEME_RE.match(url_value):
            return ""
        if bare in {"href", "xlink:href", "src"} and re.match(
                r"^\s*(?:https?:|ftp:|file:|//)", url_value, re.IGNORECASE):
            # 教育图示不需要外链资源：外部 <image href="http://…"> 既能跟踪也能替换内容
            return ""
    if bare == "style" and _STYLE_BAD_RE.search(url_value):
        return ""
    return match.group(0)


def is_usable_svg(svg: str | None, min_len: int = 40) -> bool:
    """清洗后是否还是一张「能画出东西」的 SVG（防止把空壳存进 DB）"""
    if not svg:
        return False
    if "<svg" not in svg.lower():
        return False
    return len(svg) >= min_len


def sanitize_ai_svg_output(text: str | None) -> str:
    """模型原始回复 → 安全 SVG 源码（提取 + 清洗），失败返回空串"""
    return sanitize_svg(extract_svg(text))
