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


def extract_json_array(text: str, salvage: bool = True) -> list | None:
    """尽最大努力把 AI 文本里的题目数组取出来；实在拿不到才返回 None。

    salvage=False 时不做「补齐右括号」的截断兜底（严格模式用），
    被 max_tokens 砍断的输出会直接判失败，避免半截题目入库。
    """
    got, _meta = extract_json_array2(text, salvage=salvage)
    return got


def extract_json_array2(text: str, salvage: bool = True) -> tuple[list | None, dict]:
    """同上，但额外返回 meta：salvaged(是否走了截断兜底)、tail_chars(原文长度)。"""
    meta: dict = {"salvaged": False, "chars": len(text or "")}
    if not text or not text.strip():
        return None, meta

    direct = _try(text)
    if isinstance(direct, (list, dict)):
        got = _from_dict(direct)
        if got:
            return got, meta

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
            return got, meta

    # 被包成对象的情况 —— 仅当文本里根本没有数组起始符时才走这条路。
    # 否则「数组被截断」会被误当成「模型只出了一道题」：
    # 10 题只入库 1 题、还白烧一轮重试，就是这么来的。
    if text.find("[") < 0:
        obj_frag = _balanced(text, "{", "}")
        if obj_frag:
            got = _from_dict(_try(obj_frag))
            if got:
                return got, meta
    else:
        frag = ""  # 数组没配平：留给下面的截断兜底

    # 截断兜底：补齐右括号再试（模型被 max_tokens 砍断时常见）——严格模式下不做
    if salvage and text.count("{") > 0:
        cut = text.rstrip()
        for tail in ("}]", "]}", "]}", "}]}]", "]"):
            got = _from_dict(_try(_balanced(cut + tail, "[", "]")))
            if got:
                meta["salvaged"] = True
                logger.warning("AI 输出疑似被截断，已按 %s 兜底解析出 %d 条（严格模式会判本轮失败）", tail, len(got))
                return got, meta
    return None, meta


def looks_like_html(text: str) -> bool:
    t = (text or "").strip()
    return "<!doctype" in t[:400].lower() or "<html" in t[:2000].lower()


def html_is_complete(text: str) -> tuple[bool, str]:
    """课件/练习页落盘前的最低体检：能不能算一份能打开的 HTML。"""
    t = (text or "").strip()
    low = t.lower()
    # 跳转入口页（<meta http-equiv=refresh> 指向子目录 index.html）本来就只有一两百字符，
    # 属于合法产物，不能被「过短」规则误判
    if 'http-equiv="refresh"' in low and "</html>" in low:
        return True, ""
    if len(t) < 400:
        return False, "内容过短（%d 字符），疑似未生成完整页面" % len(t)
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


_OPT_MARK = re.compile(r"(?:(?<![A-Za-z0-9])([A-D])[\s]*[．.、:：][\s]*)")


def strip_options_from_stem(q: dict) -> tuple[dict, bool, str]:
    """把误写进题干的选项内容从题干里剥掉。

    AI 有时会把整串「A. xxx B. yyy C. zzz D. www」塞进 question 字段，
    页面渲染时题干和选项区各显示一遍，看起来就是重复。
    只在证据充分时才动手（≥2 个 A-D 标记且标记数接近选项数，
    或题干里出现 ≥2 个该题选项原文），避免误伤「下列 A、B、C 三项中…」这类合法题干。
    """
    stem = str(q.get("question_text") or q.get("question") or "")
    opts = q.get("options")
    if not stem or not isinstance(opts, dict) or len(opts) < 2:
        return q, False, ""

    marks = list(_OPT_MARK.finditer(stem))
    letters = {m.group(1) for m in marks}
    inline_hits = [
        stem.find(str(v).strip())
        for v in opts.values()
        if len(str(v).strip()) >= 6 and str(v).strip() in stem
    ]

    cut = None
    if len(letters) >= 2 and len(marks) >= min(len(opts), 2):
        cut = marks[0].start()
    elif len(inline_hits) >= 2:
        first = min(h for h in inline_hits if h >= 0)
        m = re.search(r"([A-D])[\s]*[．.、:：][\s]*$", stem[:first])
        cut = m.start() if m else first

    if cut is None or cut < 6:
        return q, False, ""
    new_stem = stem[:cut].rstrip("  \t　,，、;；:：—-")
    if len(new_stem) < 6 or new_stem == stem:
        return q, False, ""

    q2 = dict(q)
    if "question_text" in q2:
        q2["question_text"] = new_stem
    if "question" in q2:
        q2["question"] = new_stem
    return q2, True, "题干内嵌选项已剥离（截去 %d 字，标记 %s）" % (len(stem) - len(new_stem), "".join(sorted(letters)) or "inline")


def question_is_complete(q: dict) -> tuple[bool, str]:
    """题目字段体检：题干/选项/答案三者齐备且答案落在选项键里。"""
    if not isinstance(q, dict):
        return False, "不是对象"
    stem = str(q.get("question_text") or q.get("question") or "").strip()
    if len(stem) < 6:
        return False, "题干缺失或过短"
    opts = q.get("options")
    if isinstance(opts, str):
        try:
            opts = json.loads(opts)
        except (ValueError, TypeError):
            return False, "options 不是合法 JSON"
    if not isinstance(opts, dict) or len(opts) < 2:
        return False, "选项不足 2 个"
    ans = str(q.get("answer") or q.get("correct_answer") or "").strip()
    if not ans:
        return False, "答案为空"

    keys = [str(k) for k in opts.keys()]
    letter_keys = [k.upper() for k in keys if len(k) == 1 and k.isalpha()]
    if letter_keys:
        letters = {c for c in re.sub(r"[^A-Za-z]", "", ans).upper()}
        digits = {c for c in re.sub(r"[^0-9]", "", ans)}
        if letters and letters <= set(letter_keys):
            return True, ""                      # 字母答案且都落在选项键里
        if digits and not letters:
            return False, "答案是选项下标 %r（应为字母 %s）" % (ans, "/".join(letter_keys))
        if not letters and not digits:
            # 判断题文字答案（对/错/正确…）交给归一化处理，能落到键上就算合格
            from backend.answer_norm import normalize_answer
            norm = normalize_answer(ans, opts)
            if norm and norm in "".join(letter_keys):
                return True, ""
            return False, "答案 %r 无法识别为选项" % ans
        return False, "答案 %r 不在选项键 %s 内" % (ans, letter_keys)
    return True, ""


def balanced_slice(text: str, open_ch: str = "[", close_ch: str = "]") -> str:
    """从第一个 open_ch 起做括号配平（正确跳过字符串内部），返回完整片段。

    注意：这是给 HTML/JS 里抠数组用的通用实现，替代各处手写循环 ——
    旧写法在 `for i in range(...)` 里改 `i` 想跳过字符串，Python 中无效，
    等于字符串里的括号也会被算进配平。
    """
    start = text.find(open_ch)
    if start < 0:
        return ""
    depth = 0
    i = start
    n = len(text)
    quote = ""
    while i < n:
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = ""
            i += 1
            continue
        if ch in ('"', "'"):
            quote = ch
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    return ""


def parse_js_array_loose(raw: str) -> Any:
    """解析 JS 字面量数组：容忍未加引号的键、单引号字符串、尾逗号、undefined、行注释。

    生成的练习页里题目数组常写成 `const questions = [ { id: 1, question: "..." } ]`
    —— 键没有引号，json.loads 会报「Expecting property name enclosed in double quotes」，
    于是页面明明有 15 题却被判成「解析到 0 题」，题目永远进不了题库。
    """
    import json as _json
    if not raw:
        return None
    try:
        return _json.loads(raw)
    except (ValueError, TypeError):
        pass

    out: list[str] = []
    i = 0
    n = len(raw)
    prev_significant = ""      # 上一个非字符串的结构字符
    while i < n:
        ch = raw[i]
        # 行注释
        if ch == "/" and i + 1 < n and raw[i + 1] == "/":
            j = raw.find("\n", i)
            i = n if j < 0 else j
            continue
        # 字符串原样保留（单引号转双引号）
        if ch in ('"', "'"):
            quote = ch
            j = i + 1
            buf = []
            while j < n:
                c = raw[j]
                if c == "\\":
                    buf.append(raw[j:j + 2] if j + 1 < n else "\\")
                    j += 2
                    continue
                if c == quote:
                    break
                if c == '"' and quote == "'":
                    buf.append('\\"')
                else:
                    buf.append(c)
                j += 1
            body = "".join(buf)
            if quote == "'":
                body = body.replace("'", "")
            out.append('"' + body + '"')
            i = j + 1
            prev_significant = "str"
            continue
        # 未加引号的键：前面是 { 或 , ，标识符后面跟 :
        if ch.isalpha() or ch in "_$":
            j = i
            while j < n and (raw[j].isalnum() or raw[j] in "_$"):
                j += 1
            word = raw[i:j]
            k = j
            while k < n and raw[k] in " \t\r\n":
                k += 1
            if k < n and raw[k] == ":" and prev_significant in ("", "{", ","):
                out.append('"' + word + '"')
                i = j
                prev_significant = "key"
                continue
            if word == "undefined" or word == "NaN":
                out.append("null")
                i = j
                prev_significant = "val"
                continue
            out.append(word)
            i = j
            prev_significant = "val"
            continue
        if ch in "{[,":
            prev_significant = ch
        elif ch in "}]":
            prev_significant = ch
        out.append(ch)
        i += 1

    fixed = "".join(out)
    fixed = re.sub(r",\s*([}\]])", r"\1", fixed)      # 尾逗号
    for cand in (fixed,):
        try:
            return _json.loads(cand)
        except (ValueError, TypeError):
            continue
    return None
