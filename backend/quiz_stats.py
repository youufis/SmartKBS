# -*- coding: utf-8 -*-
"""随堂测验判分 / 统计的公共口径（全站唯一实现）。

P0-2: 判对错的实现原本散在四处（interaction_router 的结果页、AI 分析的自己一套、
export_router CSV 的字符串相等、summary_service 写死的满分），同一场测验在不同页面
算出不同正确率。这里收敛成一份，被下列调用方共用：
  - backend/api/interaction_router.py  → /results、/my-result、/ai-analysis
  - backend/api/export_router.py       → 测验 CSV 导出
  - backend/summary_service.py         → 汇总导出（满分）
  - backend/api/dashboard_router.py    → 首页动态（百分制）

三条口径（改动前请先读）：
  1. 对错以 interaction_quiz_answers.graded 留痕为准 —— 简答题是 AI 判的 8 分，
     用字符串相等重算必然得到"答错"（老数据没留痕才退回精确匹配）；
  2. 满分 = 各题分值之和 —— 老测验每题固定 1 分（满分=题数），新测验由
     create_quiz 折算成合计 100（与同步练习/考试同一套百分制口径）；
  3. 正确率分母用「已判分人数」—— 批改中的主观题计入分母会把正确率凭空压低。
"""
from __future__ import annotations

import json
import re
from typing import Any


def quiz_graded(row: Any) -> dict[str, Any]:
    """interaction_quiz_answers.graded → 逐题批改结果字典(老数据为空则返回 {})"""
    try:
        data = json.loads(row) if isinstance(row, str) else (row or {})
    except (json.JSONDecodeError, TypeError):
        data = {}
    return data if isinstance(data, dict) else {}


def quiz_questions(row: Any) -> list[Any]:
    """测验行的 questions 字段(JSON 字符串/列表) → 题目数组"""
    raw = (row or {}).get("questions") if isinstance(row, dict) else row
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    return raw if isinstance(raw, list) else []


def quiz_total(questions: Any) -> float:
    """全卷满分 = 各题分值之和（老数据每题 1 分 → 等于题数）"""
    if not isinstance(questions, list):
        questions = quiz_questions(questions)
    total = 0.0
    for q in questions:
        try:
            total += float((q or {}).get("score", 1) or 0)
        except (TypeError, ValueError):
            total += 1.0
    return total


def centesimal(score: Any, total: Any) -> float | None:
    """原始分 → 百分制得分（满分固定 100，保留 1 位小数）。

    全站"得分"统一 100 分制：R2 之后新建的测验满分本来就是 100，但**老测验**
    满分等于题数（每题 1 分），同一份答卷在两处会显示成 3/5 与 3/100 —— 老师
    看到的是两个数。对外的 score/total_score 一律走这个折算（total_score 固定
    100），原始分用 raw_score/raw_total_score 单独暴露，界面上的"原始分 3/5"
    提示与 CSV 导出都读它。

    total<=0（讨论/投票这类没有分数的活动）返回 None，由调用方决定怎么显示。
    """
    try:
        s = float(score if score is not None else 0)
        t = float(total if total is not None else 0)
    except (TypeError, ValueError):
        return None
    if t <= 0:
        return None
    return round(max(0.0, min(100.0, s / t * 100.0)), 1)


def quiz_subjects(rows: Any) -> dict[Any, str]:
    """一批测验行 → {测验id: 学科}。

    interaction_quizzes **没有 subject 列**（2026-10-16 才补上，见 database.py 的字段迁移），
    所以老测验的学科只能反查：题目 JSON 里存了题库 id，拿它去 question_bank 取 subject，
    同一份测验跨学科抽题时取出现次数最多的那个。

    调用方（活动监控 / 测验列表）应当**优先用行里已落库的 subject**，查不到才用这里的结果；
    两边都取不到就留空由界面显示"-" —— 宁可空着，也不猜一个学科出来（猜错比空着更糟）。

    rows: [{"id": ..., "questions": <JSON 字符串或列表>}, ...]
    """
    import json as _json

    ids_of: dict[Any, list[int]] = {}
    all_ids: set[int] = set()
    for row in rows or []:
        raw = (row or {}).get("questions")
        try:
            items = _json.loads(raw) if isinstance(raw, str) else (raw or [])
        except (ValueError, TypeError):
            items = []
        ids: list[int] = []
        for it in items if isinstance(items, list) else []:
            if not isinstance(it, dict):
                continue
            try:
                ids.append(int(it.get("id")))
            except (TypeError, ValueError):
                continue            # 老卷题目没有题库 id（AI 直出/手写），跳过
        if ids:
            ids_of[(row or {}).get("id")] = ids
            all_ids.update(ids)
    if not all_ids:
        return {}

    from backend.question_db import execute_query as _q

    subj_of: dict[int, str] = {}
    ordered = sorted(all_ids)
    for i in range(0, len(ordered), 500):      # 分批，避开 SQLite 的变量个数上限
        chunk = ordered[i:i + 500]
        ph = ",".join("?" * len(chunk))
        for r in _q(f"SELECT id, subject FROM question_bank WHERE id IN ({ph})", tuple(chunk)):
            s = str((r["subject"] if isinstance(r, dict) else r[1]) or "").strip()
            qid = int(r["id"] if isinstance(r, dict) else r[0])
            if s:
                subj_of[qid] = s

    from collections import Counter

    out: dict[Any, str] = {}
    for qid, ids in ids_of.items():
        counter = Counter(subj_of[i] for i in ids if i in subj_of)
        if counter:
            out[qid] = counter.most_common(1)[0][0]
    return out


def normalize_quiz_scores(questions: list[Any], auto: bool = True) -> list[Any]:
    """R2(Step B): 把题面分值折算成合计 100（与同步练习/考试对齐）。

    仅当调用方没有显式配过分值(auto=True, 即每题都是默认的 1 分)时才折算；
    教师手工配过分值就照用 —— 与 practice_router.create_session 的规则一致。
    """
    if not questions:
        return questions
    explicit = [float((q or {}).get("score") or 0) for q in questions]
    if not auto or any(abs(s - 1.0) > 1e-9 for s in explicit):
        return questions
    from backend.utils import distribute_scores
    scores = distribute_scores(len(questions), 100)
    return [{**(q or {}), "score": scores[i]} for i, q in enumerate(questions)]


def answer_index_map(raw: Any) -> dict[int, str]:
    """答卷 JSON → {题号: 答案}"""
    try:
        user_answers = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except (json.JSONDecodeError, TypeError):
        user_answers = []
    out: dict[int, str] = {}
    if isinstance(user_answers, list):
        for ua in user_answers:
            if isinstance(ua, dict) and ua.get("question_index") is not None:
                try:
                    out[int(ua["question_index"])] = str(ua.get("answer", "")).strip()
                except (TypeError, ValueError):
                    continue
    return out


def is_question_correct(g: Any, user_ans: str, correct_ans: str, q_type: str,
                        options: Any = None) -> bool:
    """该题是否判对: 有留痕以留痕为准, 没留痕(老数据)才按统一归一化重算。"""
    if isinstance(g, dict) and g:
        return bool(g.get("is_correct"))
    from backend.answer_norm import answers_equal
    return answers_equal(user_ans, correct_ans, options, q_type)


def is_pending(g: Any) -> bool:
    """该题是否还在后台批改(分数未定)"""
    return isinstance(g, dict) and g.get("grading") == "pending"


def pending_keys(graded: dict[str, Any]) -> list[str]:
    """仍待后台批改的题号"""
    return [k for k, v in (graded or {}).items() if is_pending(v)]


def split_answers(raw: str) -> list[str]:
    """多选答案 'AC' / 'A,C' / 'A、C' 都切成 ['A','C']"""
    return [x.strip().upper() for x in re.split(r"[,，、\s]+", str(raw or "")) if x.strip()]


def build_question_stats(
    questions: list[Any],
    parsed: list[tuple[Any, dict[int, str], dict[str, Any]]],
) -> list[dict[str, Any]]:
    """每题正确率统计 —— /results 与 /ai-analysis 共用的唯一口径。

    parsed = [(答卷行, {题号: 答案}, graded 留痕), ...]
    """
    stats: list[dict[str, Any]] = []
    for i, q in enumerate(questions):
        q_type = q.get("type", "single")
        correct_ans = str(q.get("answer", "")).strip()
        options = q.get("options", [])
        correct_count = 0
        graded_count = 0
        pending_count = 0
        wrong_options: dict[str, int] = {}
        for _row, m, gm in parsed:
            user_ans = str(m.get(i, "") or "").strip()
            if is_pending(gm.get(str(i))):
                pending_count += 1
                continue
            graded_count += 1
            if is_question_correct(gm.get(str(i)), user_ans, correct_ans, q_type, options):
                correct_count += 1
            elif user_ans:
                for part in split_answers(user_ans):
                    wrong_options[part] = wrong_options.get(part, 0) + 1
        stats.append({
            "index": i,
            "question": q.get("question", q.get("question_text", "")),
            "options": options,
            "correct_answer": correct_ans,
            "type": q_type,
            "svg_content": q.get("svg_content") or q.get("svg_code", ""),
            "has_svg": q.get("has_svg", 1 if q.get("svg_code") or q.get("svg_content") else 0),
            "media_placeholders": q.get("media_placeholders", []),
            "correct_count": correct_count,
            "total_count": graded_count,        # 已判分人数(正确率分母)
            "submitted_count": len(parsed),     # 提交人数(含批改中)
            "pending_count": pending_count,     # 本题批改中人数
            "correct_rate": round(correct_count / max(graded_count, 1) * 100, 1),
            "wrong_options": sorted(wrong_options.items(), key=lambda x: -x[1])[:3],
        })
    return stats
