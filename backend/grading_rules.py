# -*- coding: utf-8 -*-
"""主观题规则判分工具（同步练习 / 学习考试 / 随堂测验 共用）

AI 不可用或调用失败时，不能把「判不准」伪装成「判错」：这里按参考答案的要点
命中比例给分，切不出可比对要点时直接标 needs_review 交给教师批改。
从 practice_router 抽出，避免三处各写一套兜底判分再各自漂移。
"""
from __future__ import annotations

import re
from typing import Any

# 多选/答案分隔符
_ANS_SEP_RE = re.compile(r"[,，;；、/\s|]+")

# 参考答案里的要点分隔符: 中英文标点、空白、以及 ①②③ /(1)/ 1. 这类标号
_POINT_SEP_RE = re.compile(
    r"[,，;；、。①②③④⑤⑥⑦⑧⑨⑩\s|｜/]+"
    r"|[（(]\s*\d+\s*[)）]"
    r"|(?<![\d.])\.(?![\d.])"
)
# 只在「确实是题号标号」时剥前缀: 括号编号 / 圈号 / 数字+.、且后面不是数字
# (后者若不限定, 小数答案 "0.5" 会被剥成 "5")
_LEAD_NUM_RE = re.compile(r"^\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]|[（(]\s*\d+\s*[)）]|\d+\s*[\.、](?!\d))\s*")
_PUNCT_RE = re.compile("""[\s\u3000，。、；：“”‘’'"()（）《》【】\[\]！!？?～~\u2014\-_,./\\|]+""")
# 兜底/规则判分可用的要点最长长度: 超过说明是整段描述文字, 关键词命中没有意义
MAX_POINT_LEN = 12


def norm_text(v: Any) -> str:
    """归一化: 去空白与标点 + 转小写, 用于跨格式比对"""
    return _PUNCT_RE.sub("", str(v if v is not None else "")).lower()


def num_tokens(v: Any) -> set[str]:
    """抽出文本里的数字并归一('02'→'2', '2.0'→'2'), 供数字要点精确比对"""
    out: set[str] = set()
    for m in re.findall(r"[-+]?\d+(?:\.\d+)?", str(v if v is not None else "")):
        out.add(m)
        try:
            f = float(m)
            out.add(str(int(f)) if f == int(f) else str(f))
        except ValueError:
            pass
    return out


def split_points(raw: Any) -> list[str]:
    """参考答案 → 要点列表(去标号、去空项、去重)"""
    pts: list[str] = []
    for part in _POINT_SEP_RE.split(str(raw or "")):
        raw_pt = str(part or "").strip(" \t\r\n：:，。、；")
        pt = _LEAD_NUM_RE.sub("", raw_pt).strip(" \t\r\n：:，。、；")
        if not pt:
            pt = raw_pt  # 整段本身就是一个数字答案(如填空 "2"), 不能被当标号剥掉
        # 单字符要点只保留有意义的答案(数字/字母选项/对错), 其余噪声片段丢弃
        if (len(pt) >= 2 or re.fullmatch(r"[-+]?\d+(?:\.\d+)?|[A-Za-z对错√×±]", pt)) and pt not in pts:
            pts.append(pt)
    return pts


def point_hit(point: str, student_norm: str, student_nums: set[str]) -> bool:
    """单个要点是否命中。
    纯数字要点必须整词命中(否则参考答案 '2' 会被学生答案 '12' 蒙对), 其余按归一化包含判断。"""
    pt = point.strip()
    if re.fullmatch(r"[A-Za-z]", pt):
        return student_norm == pt.lower()
    if re.fullmatch(r"[-+]?\d+(?:\.\d+)?", pt):
        return num_tokens(pt) & student_nums != set() or pt in student_nums
    return bool(pt) and norm_text(pt) in student_norm


def ratio_score(q_score: float, hits: int, total: int) -> float:
    """按要点命中比例给分(保留 1 位小数)"""
    if total <= 0:
        return 0.0
    return round(q_score * min(hits / total, 1.0), 1)


def grade_fill_by_rule(q: dict, student_ans: str) -> dict[str, Any] | None:
    """[S-FILL] 填空题规则判分: 逐空比对参考答案, 按命中空数比例给分。

    返回 None 表示规则不可靠(参考答案为空 / 空位里是长段描述), 调用方再降级 AI。
    is_correct 要求全部空命中(部分正确只给部分分, 仍算错题进错题本)。
    """
    correct = str(q.get("correct_answer") or "").strip()
    blanks = split_points(correct)
    if not blanks or any(len(b) > MAX_POINT_LEN for b in blanks):
        return None
    q_score = float(q.get("score") or 10)
    norm = norm_text(student_ans)
    nums = num_tokens(student_ans)
    hits = sum(1 for b in blanks if point_hit(b, norm, nums))
    return {
        "student_answer": student_ans, "correct_answer": correct,
        "score": ratio_score(q_score, hits, len(blanks)), "max_score": q_score,
        "is_correct": hits == len(blanks), "graded_by": "exact",
    }


def keyword_fallback(correct_answer: Any, q_score: Any, student_ans: str) -> dict[str, Any]:
    """[S-GRADING] AI 不可用 / 调用失败时的兜底判分。

    旧实现是「参考答案按逗号切词 + 任一命中即给满分」, 实测题库 56 道主观题里 42 道
    切出来的是 15~69 字的整段文本(必然命中不了) → 答对也给 0 分; 而填空答案 "2" 会被
    学生答案 "12" 子串命中 → 答错反而给满分。现改为按要点命中比例给分, 且切不出可比对
    要点时不猜分, 标 needs_review 交给教师批改(而不是把 0 分伪装成「已判错」)。
    """
    correct = str(correct_answer or "")
    mx = float(q_score or 10)
    base = {"student_answer": student_ans, "correct_answer": correct, "max_score": mx}
    points = [pt for pt in split_points(correct) if len(pt) <= MAX_POINT_LEN]
    if not points:
        return {**base, "score": 0, "is_correct": False, "graded_by": "none",
                "needs_review": True,
                "feedback": "参考答案为主观描述，系统无法自动判分，已标记待教师批改。"}
    norm, nums = norm_text(student_ans), num_tokens(student_ans)
    hits = sum(1 for pt in points if point_hit(pt, norm, nums))
    return {**base,
            "score": ratio_score(mx, hits, len(points)),
            "is_correct": hits == len(points),
            "graded_by": "keyword",
            "needs_review": True,
            "feedback": f"系统按要点批改（命中 {hits}/{len(points)}），建议教师复核。"}
