"""通用试题提取辅助：结构收集、规则分块、分批打包、合并去重。

给「智能提取试题」(文件/粘贴)提供与格式无关的通用能力：
- collect_question_dicts: 在任意嵌套 JSON/dict 结构里深挖"题目字典"
  (兼容按课/章/节分组、questions 数组、裸数组等组织方式)
- split_question_blocks: 纯规则按题号/题型标记把长文本切成题目块
- pack_batches / merge_questions: AI 分批提取的打包与合并去重
"""
from __future__ import annotations

import re
from typing import Any

# 题目字典判定键（与 _normalize_question_json 的取值键保持一致）
_Q_TEXT_KEYS = ("question", "question_text", "title", "stem", "content", "题干", "题目")
_Q_ANSWER_KEYS = ("answer", "correct_answer", "correctAnswer", "answerKey", "key", "答案", "正确答案")


def normalize_question_text(s: Any) -> str:
    """题干归一化（去空白/标点尾/全角空格），用于跨来源去重比对"""
    t = str(s or "").replace("\u3000", "")
    t = re.sub(r"\s+", "", t)
    return t.rstrip("。．.！!？?；;，,")


def _is_question_dict(obj: Any) -> bool:
    if not isinstance(obj, dict) or len(obj) < 2:
        return False
    has_q = any(str(obj.get(k) or "").strip() for k in _Q_TEXT_KEYS if k in obj)
    if not has_q:
        return False
    # 必须有"像题目"的配套字段之一（答案/选项/题型/解析），防止把普通带 title 的
    # 元数据对象误认成题目
    return any(k in obj for k in _Q_ANSWER_KEYS + (
        "options", "choices", "选项", "题型", "type", "question_type",
        "explanation", "解析",
    ))


def collect_question_dicts(obj: Any, group_hint: str = "") -> list[dict[str, Any]]:
    """DFS 收集结构中的所有"题目字典"，并把所属分组名(课/章节)兜底填入知识点"""
    out: list[dict[str, Any]] = []
    if isinstance(obj, dict):
        if _is_question_dict(obj):
            item = dict(obj)
            if group_hint and not any(item.get(k) for k in ("knowledge_point", "knowledge_points", "知识点", "标签")):
                item["knowledge_point"] = group_hint
            out.append(item)
            # 题目字典本身不再深入（避免把 options 里的键值对误当题目）
        else:
            for k, v in obj.items():
                hint = str(k) if isinstance(k, str) else group_hint
                # 分组键特征：短、含"课/节/章/题/单元"或本身是序号名
                if _is_question_dict(v):
                    out.extend(collect_question_dicts(v, group_hint or hint))
                else:
                    out.extend(collect_question_dicts(v, hint if isinstance(v, list) else (group_hint or hint)))
    elif isinstance(obj, list):
        for it in obj:
            out.extend(collect_question_dicts(it, group_hint))
    return out


# ── 规则分块 ─────────────────────────────────────────

# 行首题号: "1、" "12." "(3)" "（4）" "第5题"
_QNUM_RE = re.compile(r"^\s*(?:(\d{1,3})\s*[、.．)）]|[（(](\d{1,3})[)）]|第\s*(\d{1,3})\s*[、题.])")
_SECTION_RE = re.compile(
    r"^\s*(?:[一二三四五六七八九十]{1,3}\s*[、.．]\s*)?"
    r"[^\n]{0,10}?(单选题?|多选题?|判断题?|填空题?|简答题?|主观题?|作文题?)\s*[、.．]?\s*$")
_TYPE_BY_LABEL = {"单选": "single", "多选": "multiple", "判断": "true_false",
                  "填空": "fill", "简答": "short", "主观": "subjective", "作文": "essay"}


def split_question_blocks(text: str, max_chars: int = 6000) -> tuple[list[str], int]:
    """按题号切题目块。返回 (块列表, 估算题数)。

    规则：行首题号(数字递增可信)开新块；节区题型标题行并入当前块作为上下文。
    识别不到题号时退回按空行分段聚合；再不行按 max_chars 硬切。
    """
    lines = (text or "").splitlines()
    blocks: list[str] = []
    cur: list[str] = []
    expect = 1
    seen_nums: list[int] = []

    def flush():
        nonlocal cur
        if cur:
            blocks.append("\n".join(cur).strip())
            cur = []

    for ln in lines:
        m = _QNUM_RE.match(ln)
        if m:
            num = next((int(g) for g in m.groups() if g), None)
            if num is not None and num in (expect, 1) or (num is not None and abs(num - expect) <= 1):
                flush()
                if num == 1 and seen_nums:
                    pass
                seen_nums.append(num)
                expect = (num + 1) if num is not None else expect + 1
        elif cur and _SECTION_RE.match(ln):
            pass  # 题型标题行留在当前块尾部或下一块头部均可，随块走
        cur.append(ln)
    flush()
    blocks = [b for b in blocks if b.strip()]

    if len(blocks) >= 3 or len(text) <= max_chars:
        return blocks, len(blocks) or 1

    # 没识别到足够题号 → 按空行分段聚合
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(paras) >= 3:
        blocks, cur_buf = [], ""
        for p in paras:
            if cur_buf and len(cur_buf) + len(p) + 2 > max_chars:
                blocks.append(cur_buf)
                cur_buf = p
            else:
                cur_buf = (cur_buf + "\n\n" + p) if cur_buf else p
        if cur_buf.strip():
            blocks.append(cur_buf)
        return blocks, len(blocks)

    # 兜底硬切
    hard = [text[i:i + max_chars] for i in range(0, len(text), max_chars)]
    return hard, len(hard)


def pack_batches(blocks: list[str], max_chars: int = 6000, max_items: int = 15) -> list[str]:
    """把题目块聚合成批次: 同时受"字符上限"与"每批题数上限"约束。

    每批题数上限很关键——一次让 AI 转抄几十道题必然被输出 token 截断
    (实测 62 题挤一批只能提出 25 题, 每批 ≤20 题可完整提取)。
    """
    batches: list[str] = []
    buf = ""
    buf_n = 0
    for b in blocks:
        piece = b if not b.startswith("\n") else b.lstrip("\n")
        if len(piece) > max_chars:
            if buf:
                batches.append(buf)
                buf, buf_n = "", 0
            batches.append(piece[: max_chars * 2])  # 超大块给双倍容忍
            continue
        if buf and (len(buf) + len(piece) + 2 > max_chars or buf_n >= max_items):
            batches.append(buf)
            buf, buf_n = "", 0
        buf = (buf + "\n\n" + piece) if buf else piece
        buf_n += 1
    if buf:
        batches.append(buf)
    return batches


def merge_questions(batches: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """合并各批提取结果：按归一化题干去重，保留先出现的"""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for qs in batches:
        for q in qs or []:
            if not isinstance(q, dict):
                continue
            key = normalize_question_text(q.get("question") or q.get("question_text") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(q)
    return out
