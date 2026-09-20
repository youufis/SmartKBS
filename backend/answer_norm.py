"""客观题答案归一化：把导入/AI 生成的各种写法统一成可比较的形式。

三类真实踩过的坑：
1. json_import 批量导入的题把答案写成**选项下标**（'0'），而判分是字符串相等比较
   （如 curriculum_router 的 `sa.upper() == ca.upper()`），学生选 A 也判错；
2. AI 生成的多选答案写成 'ABC' / 'A、B、C' / 'A, B'，与标准 'A,C' 比不出等价；
3. 判断题答案写成 '对' / '正确' / '√' / 'true'，而选项键是 A/B。

统一口径放在这里，各判分入口调用 answers_equal()，不再各写一份 upper()==。
"""
import re
from typing import Any

_LETTERS = "ABCDEFGHIJ"
_TRUE_WORDS = {"对", "正确", "是", "√", "true", "t", "yes", "y", "无误"}
_FALSE_WORDS = {"错", "错误", "不对", "否", "×", "x", "false", "f", "no", "n"}
_SEP_RE = re.compile(r"[,，、;；/\s.。]+")


def option_keys(options: Any) -> list[str]:
    """取选项键列表；列表形式的选项按下标转字母。"""
    if isinstance(options, dict):
        return [str(k).strip() for k in options.keys() if str(k).strip()]
    if isinstance(options, (list, tuple)):
        return [_LETTERS[i] for i in range(min(len(options), len(_LETTERS)))]
    return []


def _index_to_key(tok: str, keys: list[str]) -> str:
    """'0' → 第 1 个选项键；越界时再按 1 基尝试。"""
    if not keys:
        return ""
    try:
        n = int(tok)
    except (TypeError, ValueError):
        return ""
    if 0 <= n < len(keys):
        return keys[n]
    if 1 <= n <= len(keys):
        return keys[n - 1]
    return ""


def _judge_key(value: str, want_true: bool, options: Any, keys: list[str]) -> str:
    """判断题：优先按选项文字找键，找不到就退回首/次键。"""
    if isinstance(options, dict):
        for k in keys:
            text = str(options.get(k, "")).strip().lower()
            # 先判否定：「不对」里含「对」，顺序反了会把否定项认成正确答案
            neg = any(w in text for w in ("错误", "不对", "不正确", "有误", "否", "false", "×", "错"))
            pos = (not neg) and any(w in text for w in ("正确", "对", "是", "true", "√", "无误"))
            if want_true and pos:
                return k
            if (not want_true) and neg:
                return k
    if keys:
        return keys[0] if want_true else (keys[1] if len(keys) > 1 else keys[0])
    return "T" if want_true else "F"


def normalize_answer(value: Any, options: Any = None, qtype: str = "") -> str:
    """归一化为「大写字母升序、无分隔符」的串，如 'A' / 'AC'；判断题无选项时给 T/F。

    注意：下标答案（'0'）只有在拿到 options 时才能映射成字母，没给 options 就原样大写返回。
    """
    raw = str(value if value is not None else "").strip()
    if not raw:
        return ""
    keys = option_keys(options)
    low = raw.lower()

    # 先认选项键：单个字母（X/T/F/A…）优先当作选项，别被判断词规则吃掉
    if len(raw) == 1 and (not keys or raw.upper() in keys):
        return raw.upper()

    if low in _TRUE_WORDS or low in _FALSE_WORDS:
        # 单个 ASCII 字母不当判断词（否则非法答案 'X' 会被吃成某个选项）；
        # 中文「对/错」和 true/false 这类仍正常映射
        ascii_single = len(raw) == 1 and raw.isascii() and raw.isalpha()
        if not ascii_single or qtype in ("true_false", "judge") or not keys:
            return _judge_key(raw, low in _TRUE_WORDS, options, keys)

    parts = [p for p in _SEP_RE.split(raw) if p]
    if len(parts) == 1 and re.fullmatch(r"[A-Za-z]{2,}", parts[0]):
        parts = list(parts[0])          # 'ABC' → A B C

    out: list[str] = []
    for p in parts:
        token = p.strip(".。").strip()
        if not token:
            continue
        if re.fullmatch(r"\d{1,2}", token) and keys:
            k = _index_to_key(token, keys)
            if k:
                out.append(k.upper())
                continue
        up = token.upper()
        if len(up) == 1 and up.isalpha():
            out.append(up)
        elif up.lower() in _TRUE_WORDS:
            out.append(_judge_key(token, True, options, keys))
        elif up.lower() in _FALSE_WORDS:
            out.append(_judge_key(token, False, options, keys))
        else:
            out.append(up)             # 简答题等保持原样（大写去空格）

    uniq = sorted({x for x in out if x})
    if not uniq:
        return re.sub(r"\s+", "", raw).upper()
    return "".join(uniq)


def answers_equal(student: Any, correct: Any, options: Any = None, qtype: str = "") -> bool:
    """判分统一入口：两边都归一化后比较；标准答案为空一律算错。"""
    ref = normalize_answer(correct, options, qtype)
    got = normalize_answer(student, options, qtype)
    if not ref or not got:
        return False
    return got == ref
