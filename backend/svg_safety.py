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

import json
import re
import xml.etree.ElementTree as ET

# 模型输出里 SVG 的常见包装：```svg ... ``` / 裸 <svg>...</svg>
_FENCE_RE = re.compile(r"```(?:svg|xml|html)?\s*([\s\S]*?)```", re.IGNORECASE)
# 解壳时要能认任意语言的围栏（```json 里装响应壳是最常见的一种）
_ANY_FENCE_RE = re.compile(r"```[a-zA-Z0-9_-]*\s*([\s\S]*?)```")
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


#: 智能体/网关返回的响应壳字段（值里才是真正的 SVG 文本）
_SHELL_KEYS = ("result", "content", "answer", "data", "text", "output", "message")


def unwrap_ai_text(text: str) -> str:
    """剥掉 ``{"code":0,"status":"success","result":"<svg ...>"}`` 这类响应壳

    百炼智能体应用（以及 json_mode 兜底）有时会把模型输出包在 JSON 里返回。
    这时**整段壳里能正则匹配到 ``<svg>``，但它是被 JSON 转义过的**
    （引号变成 ``\"``、换行变成 ``\\n``），直接入库就是一张永远渲染不出来的空图。
    所以提取 SVG 之前必须先把壳解开、拿到未转义的原文。
    """
    if not text:
        return ""
    body = text.strip()
    # 常见形态：整个回复就是一段 JSON，或被 ```json 之类的围栏包着
    candidate = body
    if not candidate.startswith("{"):
        for fence in _ANY_FENCE_RE.finditer(body):
            inner = fence.group(1).strip()
            if inner.startswith("{"):
                candidate = inner
                break
    if not candidate.startswith("{"):
        return text
    if not candidate.startswith("{"):
        return text
    parsed: object
    try:
        parsed = json.loads(candidate)
    except (json.JSONDecodeError, ValueError):
        return text
    if not isinstance(parsed, dict):
        return text
    for key in _SHELL_KEYS:
        value = parsed.get(key)
        if isinstance(value, str) and "<svg" in value.lower():
            return value
        if isinstance(value, dict):                     # 再套一层 data.result 之类
            inner = unwrap_ai_text(json.dumps(value, ensure_ascii=False))
            if inner != json.dumps(value, ensure_ascii=False):
                return inner
    return text


def _looks_double_escaped(svg: str) -> bool:
    """识别"被 JSON 转义过却没解壳"的文本：字面 ``\\n`` / ``\\"`` 出现在标签里"""
    if not svg:
        return False
    head = svg[:400]
    return ("\\n" in head or '\\"' in head) and "<svg" in head.lower()


def extract_svg(text: str | None) -> str:
    """从模型回复里取出第一段 SVG 源码（自动解响应壳）；取不到返回空串"""
    if not text:
        return ""
    payload = unwrap_ai_text(text)
    block = _SVG_BLOCK_RE.search(payload)
    if not block:
        # 带 ```svg 围栏但内部被截断时，先剥围栏再试一次
        for fence in _FENCE_RE.finditer(payload):
            block = _SVG_BLOCK_RE.search(fence.group(1))
            if block:
                break
    if not block:
        return ""
    svg = block.group(0).strip()
    # 解壳失败（例如壳里还套了一层字符串）时宁可判失败，也别把转义串存进库
    return "" if _looks_double_escaped(svg) else svg


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
    """清洗后是否还是一张「浏览器真能画出来」的 SVG。

    必须做 XML 良构校验：``<img src="data:image/svg+xml,...">`` 走的是严格 XML 解析，
    非良构（未闭合标签、未定义实体、残留 JSON 转义）不会报错提示，而是**直接空白**——
    教师只会看到"生成成功但图是空的"。只判长度和 ``<svg`` 就是这次空图事故的漏口。
    """
    if not svg or len(svg) < min_len:
        return False
    if "<svg" not in svg.lower():
        return False
    if _looks_double_escaped(svg):
        return False
    try:
        ET.fromstring(svg)
    except (ET.ParseError, ValueError, TypeError, SyntaxError):
        return False
    return True


def sanitize_ai_svg_output(text: str | None) -> str:
    """模型原始回复 → 安全 SVG 源码（提取 + 清洗），失败返回空串"""
    return sanitize_svg(extract_svg(text))
