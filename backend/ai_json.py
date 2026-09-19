"""AI 结构化输出的容错解析、失败取证与产物校验。

模型返回的 JSON 常见四类「差一点就能用」的问题：夹带客套话、被 max_tokens 截断、
非法转义（LaTeX / SVG 里的裸反斜杠）、尾逗号或单引号 key。以前各处各写一份
json.loads + 正则，一遇漂移就整单失败，而且日志只留下字符长度，事后无法复盘。
"""
import json
import os
import re
from datetime import datetime
from typing import Any

from backend.logger import logger

_ESC_OK = set('"\\/bfnrtu')

_SMART_QUOTES = {chr(0x201c): chr(34), chr(0x201d): chr(34), chr(0x2018): chr(39), chr(0x2019): chr(39)}
_REFUSAL_WORDS = ("抱歉", "无法完成", "无法生成", "作为AI", "作为 AI", "I cannot", "I'm sorry", "抱歉，")


def dump_failed_raw(scene: str, text: str) -> str:
    """把解析失败的原文留档到 LogFiles/ai_raw/，返回相对路径（失败返回空串）。"""
    try:
        from backend.config import BASE_DIR
        d = os.path.join(str(BASE_DIR), "LogFiles", "ai_raw")
        os.makedirs(d, exist_ok=True)
        name = "%s_%s_%d.txt" % (datetime.now().strftime("%Y%m%d_%H%M%S"), re.sub(r"[^0-9a-zA-Z_-]", "", scene) or "raw", os.getpid())
        path = os.path.join(d, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write("# scene=%s len=%d" % (scene, len(text or "")) + chr(10))
            f.write(text or "")
        rel = os.path.relpath(path, str(BASE_DIR)).replace("\\", "/")
        logger.warning("AI 输出解析失败，原文已留存待复盘: %s", rel)
        return rel
    except Exception as e:  # 取证本身绝不能影响主流程
        logger.warning("AI 原文留档失败: %s", e)
        return ""


def _fix_escapes(s: str) -> str:
    """把 JSON 里非法的裸反斜杠（LaTeX \\rightarrow、SVG 路径等）补成合法转义。"""
    out = []
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == "\\":
            nxt = s[i + 1] if i + 1 < n else ""
            if nxt and nxt in _ESC_OK:
                out.append(ch)
                out.append(nxt)
                i += 2
                continue
            out.append("\\\\")
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _drop_trailing_commas(s: str) -> str:
    """删掉 } 或 ] 前多余的逗号（模型常多写一个），纯字符扫描避免正则转义踩坑。"""
    out = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] == ",":
            j = i + 1
            while j < n and s[j] in " \t\r\n":
                j += 1
            if j < n and s[j] in "}]":
                i = j
                continue
        out.append(s[i])
        i += 1
    return "".join(out)


def _repair(s: str) -> str:
    """常见漂移的保守修复：中文引号、非法转义、尾逗号、纯单引号 key。"""
    for a, b in _SMART_QUOTES.items():
        s = s.replace(a, b)
    s = _fix_escapes(s)
    s = _drop_trailing_commas(s)
    return s


    return s


def _try(text: str) -> Any:
    if not text:
        return None
    for cand in (text, _repair(text)):
        try:
            return json.loads(cand)
        except (ValueError, TypeError):
            continue
    return None


def _balanced(text: str, open_ch: str, close_ch: str) -> str:
    """从第一个 open_ch 起做括号配平（跳过字符串内部），返回完整片段。"""
    start = text.find(open_ch)
    if start < 0:
        return ""
    depth = 0
    in_str = False
    quote = ""
    i = start
    n = len(text)
    while i < n:
        ch = text[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                in_str = False
        elif ch in '"':
            in_str = True
            quote = ch
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    return ""


def _from_dict(data: Any) -> list | None:
    """模型爱把数组包一层：{"questions": [...]} / {"data": [...]}"""
    if isinstance(data, dict):
        for key in ("questions", "items", "data", "list", "result", "results"):
            v = data.get(key)
            if isinstance(v, list) and v:
                return v
        if any(k in data for k in ("question", "question_text", "options", "answer")):
            return [data]
        for v in data.values():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v
    if isinstance(data, list) and data:
        return data
    return None


def extract_json_array(text: str) -> list | None:
    """尽最大努力把 AI 文本里的题目数组取出来；实在拿不到才返回 None。"""
    if not text or not text.strip():
        return None

    direct = _try(text)
    if isinstance(direct, (list, dict)):
        got = _from_dict(direct)
        if got:
            return got

    # ```json ... ``` 代码块（可能有多个，逐个试）
    for m in re.finditer(r"```(?:json|JSON)?\*(.+?)```", text, re.DOTALL):
        got = _from_dict(_try(m.group(1).strip()))
        if got:
            return got

    # 客套话 + 裸数组：括号配平取最外层
    frag = _balanced(text, "[", "]")
    if frag:
        got = _from_dict(_try(frag))
        if got:
            return got

    # 被包成对象的情况
    frag = _balanced(text, "{", "}")
    if frag:
        got = _from_dict(_try(frag))
        if got:
            return got

    # 截断兜底：从后往前逐个补齐右括号再试（模型被 max_tokens 砍断时常见）
    if frag or text.count("{") > 0:
        cut = text.rstrip()
        for tail in ("}]", "]}", "]}", "}]}]", "]"):
            got = _from_dict(_try(_balanced(cut + tail, "[", "]")))
            if got:
                logger.warning("AI 输出疑似被截断，已按 %s 兜底解析", tail)
                return got
    return None


def looks_like_html(text: str) -> bool:
    t = (text or "").strip()
    return "<!doctype" in t[:400].lower() or "<html" in t[:2000].lower()


def html_is_complete(text: str) -> tuple[bool, str]:
    """课件/练习页落盘前的最低体检：能不能算一份能打开的 HTML。"""
    t = (text or "").strip()
    if len(t) < 400:
        return False, "内容过短（%d 字符），疑似未生成完整页面" % len(t)
    low = t.lower()
    if "<html" not in low:
        return False, "缺少 <html> 标签"
    if "</html>" not in low:
        return False, "缺少 </html> 结束标签，输出可能被截断"
    opens = len(re.findall(r"<script\b", low))
    closes = low.count("</script>")
    if opens != closes:
        return False, "script 标签不闭合（%d 开 / %d 闭），输出可能被截断" % (opens, closes)
    if low.count("<style") != low.count("</style>"):
        return False, "style 标签不闭合，输出可能被截断"
    return True, ""


def extract_html(text: str) -> str:
    """剥掉模型爱加的客套话与 ```fence，取真正的 HTML 主体。"""
    t = (text or "").strip()
    i = t.lower().find("<!doctype")
    if i < 0:
        i = t.lower().find("<html")
    if i > 0:
        t = t[i:]
    if t.lower().startswith("```"):
        nl = t.find(chr(10))
        if nl > -1:
            t = t[nl + 1:]
    while t.rstrip().endswith("```"):
        t = t.rstrip()[:-3]
    j = t.lower().rfind("</html>")
    if j > -1:
        t = t[:j + len("</html>")]
    return t.strip()


def looks_like_refusal(text: str, min_len: int = 200) -> bool:
    """教案/正文类结果的基本体检：太短、或明显是模型的推脱话，就别缓存下来。"""
    t = (text or "").strip()
    if len(t) < min_len:
        return True
    head = t[:120]
    return any(w in head for w in _REFUSAL_WORDS)
