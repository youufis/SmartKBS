"""坏 JSON 的结构修复：让"人/AI 手写"的 JSON 也能被直接解析。

处理三类常见问题（均为字符串内外区分的状态机修复，不做语义猜测）：
1. 结构位置的全角标点（，：；｝］｛［）→ 半角
2. 字符串值里的裸换行/制表符/控制字符 → \n \t 转义
3. 尾部逗号
启发式：字符串内出现 " 时，若后面第一个非空白字符是结构符(, : } ])或到文本尾，
视为闭合引号；否则视为内容引号并转义。
"""
from __future__ import annotations

import json
import re

_FULLWIDTH_STRUCT = {
    "，": ",", "：": ":", "；": ",",
    "｛": "{", "｝": "}", "［": "[", "］": "]", "【": "[", "】": "]",
}
_STRUCT_AFTER_CLOSE = ",:}]"


def _looks_closing(raw: str, i: int) -> bool:
    """" 在位置 i, 是字符串闭合引号还是内容引号"""
    j = i + 1
    n = len(raw)
    while j < n and raw[j] in " \t\r\n":
        j += 1
    if j >= n:
        return True
    return raw[j] in _STRUCT_AFTER_CLOSE


def repair_json_text(raw: str) -> str:
    out: list[str] = []
    in_str = False
    esc = False
    n = len(raw)
    i = 0
    while i < n:
        ch = raw[i]
        if in_str:
            if esc:
                out.append(ch)
                esc = False
            elif ch == "\\":
                out.append(ch)
                esc = True
            elif ch == '"':
                if _looks_closing(raw, i):
                    out.append('"')
                    in_str = False
                else:
                    out.append('\\"')
            elif ch == "\n":
                out.append("\\n")
            elif ch == "\r":
                if i + 1 < n and raw[i + 1] == "\n":
                    pass  # \r\n 统一只输出一个 \n 转义
                else:
                    out.append("\\r")
            elif ch == "\t":
                out.append("\\t")
            elif ord(ch) < 0x20:
                pass
            else:
                out.append(ch)
        else:
            if ch == '"':
                out.append('"')
                in_str = True
            elif ch in _FULLWIDTH_STRUCT:
                out.append(_FULLWIDTH_STRUCT[ch])
            else:
                out.append(ch)
        i += 1
    s = "".join(out)
    # 尾逗号（结构位，"a":1,} / [1,2,]）
    s = re.sub(r",\s*([}\]])", r"\1", s)
    return s


def try_parse_repaired(raw_text: str):
    """先按原样解析, 失败再用修复文本解析; 成功返回对象, 失败返回 None"""
    if not raw_text or len(raw_text.strip()) < 20:
        return None
    t = raw_text.strip()
    # 带 BOM / 前置说明文字的宽容起点: 定位第一个 [ 或 {
    starts = [idx for idx in (t.find("["), t.find("{")) if idx != -1]
    if not starts:
        return None
    t = t[min(starts):]
    for candidate in (t, repair_json_text(t)):
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
    return None
