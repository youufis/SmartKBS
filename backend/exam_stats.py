# -*- coding: utf-8 -*-
"""考试判分 / 统计的公共口径（全站唯一实现）。

与 `backend/quiz_stats.py` 同形，解决同一类问题：考试成绩此前散在三处各算一遍 ——
  - `exam_router./{exam_id}/results`（教师成绩弹窗：平均分/及格率/最高最低）
  - `analytics_router./exam/{exam_id}/report`（学情分析：每题正确率 + AI 报告）
  - `export_router.export_exam_result`（Excel 逐题分析的正确率列）
三处的答卷筛选、对错判定、分母口径都不一样，同一场考试能算出三个数。

四条口径（改动前请先读）：
  1. 对错以答卷里 `graded` 留痕的 `is_correct` 为准（简答题是 AI/教师判的），
     没留痕的旧数据才退回归一化比对；
  2. 批改中的题（`grading == 'pending'`）**不计入分母** —— 否则主观题没判完时正确率被压低；
  3. 每份答卷的"是否还在批改"= 它还有 pending 的题；这类答卷不计入平均分/及格率/最高最低；
  4. 得分率一律 = 原始分 / 卷面满分 × 100（考试满分可以是 150，不能拿原始分横向比）。
"""
from __future__ import annotations

import json
from typing import Any


def exam_graded(row: Any) -> dict[str, Any]:
    """答卷行的 answers / grading_details 字段 → {题号: 判分明细}"""
    try:
        data = json.loads(row) if isinstance(row, str) else (row or {})
    except (json.JSONDecodeError, TypeError):
        data = {}
    return data if isinstance(data, dict) else {}


def is_pending(entry: Any) -> bool:
    """这道题是否还在后台批改（分数未定）"""
    return isinstance(entry, dict) and entry.get("grading") == "pending"


def pending_keys(graded: dict[str, Any]) -> list[str]:
    """仍待后台批改的题号"""
    return [k for k, v in (graded or {}).items() if is_pending(v)]


def needs_review(entry: Any) -> bool:
    """这道题判不准、已转人工（分数同样未定，但不属于"批改中"）"""
    return isinstance(entry, dict) and bool(entry.get("needs_review"))


def is_question_correct(entry: Any, student_answer: str, correct_answer: str,
                        q_type: str = "", options: Any = None) -> bool:
    """该题是否判对：有留痕以留痕为准；老数据（没留痕）才退回归一化比对。"""
    if isinstance(entry, dict) and entry:
        return bool(entry.get("is_correct"))
    from backend.answer_norm import answers_equal
    return answers_equal(student_answer, correct_answer, options, q_type)


def attempt_pending(graded: dict[str, Any]) -> bool:
    """这份答卷是否还有题在批改中（决定它算不算"最终成绩"）"""
    return bool(pending_keys(graded))


def attempt_graded(attempt: dict[str, Any]) -> dict[str, Any]:
    """从答卷行里取出判分明细 —— 三个调用方字段名不一（exam_router 用 answers、
    export 用 _graded、分析页自己解析），这里统一兜住，避免"忘了挂 graded 就整场不算批改中"。"""
    for key in ("graded", "_graded", "answers"):
        raw = attempt.get(key)
        if not raw:
            continue
        data = exam_graded(raw)
        if data:
            return data
    return {}


def question_stats(questions: list[Any],
                   parsed: list[tuple[str, dict[str, Any], dict[str, Any]]]) -> list[dict[str, Any]]:
    """每题正确率 —— 结果页 / AI 分析 / Excel 导出共用。

    questions: [{qid, type, question_text, options, correct_answer, question_score}]
    parsed:    [(student_username, {题号: 学生答案}, graded 留痕)]，题号用 `str(qid)`
    """
    stats: list[dict[str, Any]] = []
    for i, q in enumerate(questions):
        qid = str(q.get("qid") or q.get("id") or "")
        q_type = q.get("type", "single")
        options = q.get("options") or {}
        correct_ans = str(q.get("correct_answer", "") or "")
        correct_count = 0
        graded_count = 0
        pending_count = 0
        for _stu, ans_map, graded in parsed:
            entry = (graded or {}).get(qid)
            if is_pending(entry):
                pending_count += 1
                continue
            graded_count += 1
            if is_question_correct(entry, str(ans_map.get(qid, "") or ""), correct_ans, q_type, options):
                correct_count += 1
        stats.append({
            "index": i,
            "qid": qid,
            "type": q_type,
            "question_text": q.get("question_text", ""),
            "options": options,
            "correct_answer": correct_ans,
            "question_score": q.get("question_score"),
            "knowledge_points": q.get("knowledge_points", ""),
            "difficulty": q.get("difficulty", ""),
            "correct_count": correct_count,
            "total_count": graded_count,        # 已判分人数（正确率分母）
            "submitted_count": len(parsed),     # 提交人数（含批改中）
            "pending_count": pending_count,     # 本题批改中人数
            "correct_rate": round(correct_count / max(graded_count, 1) * 100, 1),
        })
    return stats


def score_stats(attempts: list[dict[str, Any]], total_score: float,
                pass_score: float) -> dict[str, Any]:
    """班级成绩统计：**只统计已判完的答卷**，并把"还有几份在批改"单独下发。

    attempts: [{score, graded}]（graded 为该卷的判分明细字典）
    """
    total = float(total_score or 0)
    graded_attempts = [a for a in attempts if not attempt_pending(attempt_graded(a))]
    scores = [float(a.get("score") or 0) for a in graded_attempts]
    rates = [round(s / total * 100, 1) if total > 0 else 0.0 for s in scores]
    n = len(scores)
    passed = sum(1 for s in scores if s >= float(pass_score or 0))
    return {
        "submitted_count": len(attempts),
        "graded_count": n,
        "pending_count": len(attempts) - n,
        "total_score": total,
        "pass_score": float(pass_score or 0),
        "avg_score": round(sum(scores) / n, 1) if n else 0,
        "avg_rate": round(sum(rates) / n, 1) if n else None,
        "pass_count": passed,
        "pass_rate": round(passed / n * 100, 1) if n else None,
        "max_score": max(scores) if n else None,
        "min_score": min(scores) if n else None,
        "max_rate": max(rates) if n else None,
        "min_rate": min(rates) if n else None,
    }


def attempt_percentage(score: Any, total_score: Any) -> float:
    """单份答卷的百分制得分率（前端不自己算）"""
    try:
        t = float(total_score or 0)
        s = float(score or 0)
    except (TypeError, ValueError):
        return 0.0
    if t <= 0:
        return 0.0
    return round(max(0.0, min(s / t, 1.0)) * 100, 1)
