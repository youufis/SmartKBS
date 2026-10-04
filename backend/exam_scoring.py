# -*- coding: utf-8 -*-
"""考试试卷的分值分配、结构校验与"在途答卷"守卫（单一事实源）。

为什么要有这个模块（2026-10 走查结论）：写分值的四处各写各的——
  手动添加 : total_score / 本次新增题数        —— 忽略已选题，卷面合计直接超出目标
  自动均分 : total_score / 全部题数，余数全压第 1 题 —— 实测出现 4.8 / 4.3 / 4.3 …
  智能选题 : total_score / 本次新增题数，并把 exams.total_score 改写成"新增批次之和"
  AI  生成 : 同智能选题的算法，却不改 total_score
而判分同时拿 exams.total_score 当分母、exam_questions.score 当分子，两个数一不一致，
学生的满分就不可达或能超过 100%（实测考试 #8：目标 100 分、卷面只有 12 分）。

本模块立两条规矩：
  1) 分配结果之和恒等于给定总分（最大余数法，0.1 分粒度，单题尽量不低于 0.5 分）；
  2) exams.total_score 只能由教师显式改（编辑考试 / 智能组卷配置），选题类操作
     **不再偷偷改目标分**；改成每次动完题目就把整份卷子按原比例配平回目标分，
     于是"卷面合计 == 目标总分"从期望变成了硬保证。
     老师要留自己的手动分值走「批量保存分值」，那条路不配平、只如实报缺口。
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Sequence

from backend.logger import logger
from backend.question_db import execute_query, execute_query_one, get_connection

# ── 分值粒度 ──
GRID = 0.1            # 最小分值步长（0.1 分）
MIN_SCORE = 0.5       # 单题建议下限；题量多到放不下时自动放弃下限，优先保证总和精确
GRACE_SECONDS = 180   # 个人作答截止的宽限，与考试计时同一口径

# ── 题型：判分器能真正给分的那些 ──
# 与 exam_router.submit_exam 的三条判分分支保持一致（客观/简答填空/作文主观）。
# 题库题型是管理员可配的（/api/config/question-types），出现过没有判分分支的题型
# （如 code 编程题）时，它的分值会白占总分、学生永远拿不到 —— 入卷前挡掉。
GRADABLE_TYPES = ("single", "multiple", "true_false", "short", "fill", "essay", "subjective")

# 新题默认分值的相对权重：多选/简答天然比判断题贵
TYPE_WEIGHTS = {
    "single": 1.0, "multiple": 1.5, "true_false": 0.8,
    "short": 2.0, "fill": 1.2, "essay": 3.0, "subjective": 2.5,
}
DEFAULT_WEIGHT = 1.0


def gap_text(gap: float) -> str:
    """把"卷面合计 - 目标总分"翻成给老师看的话（正=超出，负=还差）。"""
    n = abs(round(float(gap), 1))
    return f"卷面已超出目标总分 {n} 分" if gap > 0 else f"卷面还差 {n} 分到目标总分"


def weight_of(q_type: Any) -> float:
    """题型 → 默认分值权重。未知题型按 1.0，不给 0（0 权重会让该题算出 0 分）。"""
    return TYPE_WEIGHTS.get(str(q_type or "").strip(), DEFAULT_WEIGHT)


def is_gradable(q_type: Any) -> bool:
    return str(q_type or "").strip() in GRADABLE_TYPES


def ungradable_types(q_types: Sequence[Any]) -> list[str]:
    """返回其中"进考卷就没法判分"的题型（去重、保序）。"""
    out: list[str] = []
    for t in q_types:
        s = str(t or "").strip()
        if s and not is_gradable(s) and s not in out:
            out.append(s)
    return out


# ══════════════════════════════════════════════════════════════
# 纯函数：分值分配
# ══════════════════════════════════════════════════════════════

def distribute_scores(total: float, weights: Sequence[float]) -> list[float]:
    """把 total 精确分成 len(weights) 份，返回与 weights 等长的分值列表。

    恒等式 sum(result) == round(total, 1) —— 用"十分位整数"算，不用浮点累加，
    所以不会出现 33.3+33.3+33.3 = 99.9 这种差一丁点的情况。
    余数按权重从大到小摊开（最大余数法），不再全压在第 1 题上。
    单题尽量不低于 MIN_SCORE；题太多放不下时放弃该下限，仍保证总和精确。
    """
    n = len(weights)
    if n == 0:
        return []
    total_t = int(round(float(total) / GRID))
    if total_t <= 0:
        raise ValueError("待分配的总分必须大于 0")
    ws = [max(float(w or 0.0), 0.0) for w in weights]
    if sum(ws) <= 0:
        ws = [1.0] * n
    sw = sum(ws)

    raw = [total_t * w / sw for w in ws]
    alloc = [int(math.floor(r)) for r in raw]
    rem = total_t - sum(alloc)
    if rem > 0:
        # 余数优先给"小数部分最大"的题，其次给权重大的题；-i 保证结果可复现
        order = sorted(range(n), key=lambda i: (raw[i] - alloc[i], ws[i], -i), reverse=True)
        for k in order[:min(rem, n)]:
            alloc[k] += 1

    min_t = int(round(MIN_SCORE / GRID))
    if n * min_t <= total_t:            # 放不下下限就不强求（否则总和会被顶歪）
        deficit = 0
        for i in range(n):
            if alloc[i] < min_t:
                deficit += min_t - alloc[i]
                alloc[i] = min_t
        while deficit > 0:
            donors = [i for i in range(n) if alloc[i] > min_t]
            if not donors:
                break
            j = max(donors, key=lambda i: (alloc[i], ws[i], -i))
            alloc[j] -= 1
            deficit -= 1

    out = [round(a * GRID, 1) for a in alloc]
    # 兜底自检：浮点 round 后仍要精确等于目标（不精确说明上面的算法被改坏了）
    if round(sum(out), 1) != round(float(total), 1):
        logger.warning("[分值分配] 总和 %s != 目标 %s，weights=%s", round(sum(out), 1), total, list(weights))
    return out


def rebalance_paper(exam_id: int, target_total: float, *, equal: bool = False) -> float:
    """把整份卷子配平到目标总分，返回配平后的缺口（正常应为 0.0）。

      equal=False（结构性变更之后：加题 / 删题 / 自动选题 / AI 组卷）
          保持每题**现有分值的相对比例** —— 老师手工拉开的难度差不会被抹平；
          刚入卷的题（分值还是 0）按题型权重拿一份"平均题"量级的分值。
      equal=True（老师点「自动均分」）
          忽略现有分值，每题等值，余数摊开。

    为什么结构性变更要默认配平：判分的分母是目标总分、分子是每题分值，只要
    "加完题留下一个缺口"就迟早出事（实测考试 #8 目标 100 / 卷面 12）。配平让
    每一次改题之后卷子都是自洽的，老师想留手动值就走「批量保存分值」那条路。
    """
    rows = execute_query(
        """SELECT eq.id AS eq_id, eq.score, q.type
           FROM exam_questions eq
           LEFT JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ?
           ORDER BY eq.sort_order, eq.id""",
        (exam_id,),
    ) or []
    n = len(rows)
    if not n:
        return paper_gap(exam_id, target_total)
    target = float(target_total or 0)
    if target <= 0:
        raise ValueError("目标总分必须大于 0，无法配平")

    if equal:
        weights: list[float] = [1.0] * n
    else:
        cur = [float(r.get("score") or 0) for r in rows]
        positives = [s for s in cur if s > 0]
        avg = (sum(positives) / len(positives)) if positives else 1.0
        # 有分值的按原值当权重（保比例），0 分的新题按题型权重挤进同一量纲
        weights = [s if s > 0 else weight_of(r.get("type")) * avg
                   for s, r in zip(cur, rows)]
        if sum(weights) <= 0:
            weights = [1.0] * n

    scores = distribute_scores(target, weights)
    set_scores(exam_id, {int(r["eq_id"]): s for r, s in zip(rows, scores)})
    return paper_gap(exam_id, target)


def paper_total(exam_id: int) -> float:
    """卷面实算合计（Σ每题分值）。判分的分子、试卷上印的满分都该读这个数。"""
    row = execute_query_one(
        "SELECT COALESCE(SUM(score), 0) AS s FROM exam_questions WHERE exam_id = ?", (exam_id,))
    return round(float(row["s"] if row else 0), 1)


def paper_gap(exam_id: int, target_total: float) -> float:
    """卷面合计与目标总分的差额（正=超出，负=还差）。"""
    return round(paper_total(exam_id) - float(target_total or 0), 1)


# ══════════════════════════════════════════════════════════════
# 原子写入：整份卷子的多行改动必须一次成型
# （question_db 的 execute_insert/execute_update 每条各自 commit，
#   中途异常会留下"半套卷子"，所以这里统一走一个事务）
# ══════════════════════════════════════════════════════════════

def insert_paper_questions(exam_id: int, items: Sequence[tuple[int, float]],
                           start_order: int = 0) -> list[int]:
    """批量入卷，返回真正插入的 question_id 列表（已存在的自动跳过）。

    事务内先读现有题号再过滤：既防并发重复，也不依赖唯一索引一定建成
    （老库若历史上有重复行，唯一索引会建失败，这里仍不会新增重复）。
    """
    inserted: list[int] = []
    with get_connection() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        try:
            have = {int(r[0]) for r in conn.execute(
                "SELECT question_id FROM exam_questions WHERE exam_id = ?", (exam_id,)).fetchall()}
            order_row = conn.execute(
                "SELECT COALESCE(MAX(sort_order), -1) FROM exam_questions WHERE exam_id = ?",
                (exam_id,)).fetchone()
            # 接在卷面最后一题之后（sort_order 决定试卷导出的题序，不能重号）
            cur_max = int(order_row[0]) if order_row and order_row[0] is not None else -1
            next_order = max(cur_max + 1, int(start_order), 0)
            for qid, score in items:
                qid = int(qid)
                if qid in have:
                    continue
                have.add(qid)
                conn.execute(
                    "INSERT INTO exam_questions (exam_id, question_id, sort_order, score) VALUES (?, ?, ?, ?)",
                    (exam_id, qid, next_order, round(float(score), 1)))
                next_order += 1
                inserted.append(qid)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return inserted


def set_scores(exam_id: int, mapping: dict[int, float]) -> int:
    """批量改分值，一次事务。返回实际写入行数。"""
    applied = 0
    with get_connection() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        try:
            for eq_id, score in mapping.items():
                cur = conn.execute(
                    "UPDATE exam_questions SET score = ? WHERE id = ? AND exam_id = ?",
                    (round(float(score), 1), int(eq_id), exam_id))
                applied += int(cur.rowcount or 0)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return applied


# ══════════════════════════════════════════════════════════════
# 在途答卷守卫
# ══════════════════════════════════════════════════════════════

def attempt_deadline(attempt: dict, exam: dict) -> datetime | None:
    """个人作答截止时间 = 开始时间 + 考试时长(+宽限)；未设时长返回 None（仅受考试起止窗约束）。

    学生端的超时判定（exam_router._attempt_deadline）与这里的"还有没有人正在答"
    共用同一个函数，避免两处口径分叉。
    """
    try:
        dur = float(exam.get("duration") or 0)
    except (TypeError, ValueError):
        dur = 0
    if dur <= 0:
        return None
    try:
        started = datetime.strptime(str(attempt.get("started_at") or ""), "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return None
    return started + timedelta(minutes=dur, seconds=GRACE_SECONDS)


def live_attempts(exam: dict, limit: int = 50) -> list[dict[str, Any]]:
    """此刻真有人在作答的答卷（in_progress/grading 且未超时）。

    只在 status='published' 时才可能有人在线：start_exam 拒绝非发布考试，
    已结束/草稿卷子里的 in_progress 行都是历史遗留，不该把老师永久锁在门外。
    """
    if str(exam.get("status") or "") != "published":
        return []
    rows = execute_query(
        """SELECT id, student_username, started_at, status FROM exam_attempts
           WHERE exam_id = ? AND status IN ('in_progress','grading')
           ORDER BY id DESC LIMIT ?""",
        (int(exam["id"]), int(limit))) or []
    now = datetime.now()
    live: list[dict[str, Any]] = []
    for r in rows:
        dl = attempt_deadline(r, exam)
        if dl is None or now <= dl:
            live.append(r)
    return live


# ══════════════════════════════════════════════════════════════
# 卷面诊断与存量修复（发布前体检与全站扫描共用这一份判定）
# ══════════════════════════════════════════════════════════════

def paper_rows(exam_id: int) -> list[dict[str, Any]]:
    """这张卷子的每一行（含题型与题目状态）。LEFT JOIN：题目被硬删也不漏行。"""
    return execute_query(
        """SELECT eq.id AS eq_id, eq.question_id, eq.sort_order, eq.score,
                  q.type, q.status
           FROM exam_questions eq
           LEFT JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ?
           ORDER BY eq.sort_order, eq.id""",
        (exam_id,),
    ) or []


def diagnose(exam: dict[str, Any], rows: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """返回卷子的结构问题清单，每项 {code, message, fixable}。

    code 是机器可读的，供发布拦截、存量扫描、一键修复三处共同判断；
    message 是给老师看的一句可操作说明。fixable=False 的问题不能自动修
    （删题、改及格线都是会动老师决策的事），只能报出来。
    """
    rows = rows if rows is not None else paper_rows(int(exam["id"]))
    if not rows:
        return [{"code": "empty_paper", "message": "试卷里一道题都没有", "fixable": False}]

    target = float(exam.get("total_score") or 0)
    pass_score = float(exam.get("pass_score") or 0)
    active = [r for r in rows if str(r.get("status") or "") == "active"]
    dead = [r for r in rows if str(r.get("status") or "") != "active"]
    ungradable = sorted({str(r.get("type") or "") for r in active
                         if not is_gradable(r.get("type"))})
    zero = [r for r in rows if float(r.get("score") or 0) <= 0]
    active_sum = round(sum(float(r["score"] or 0) for r in active), 1)
    dead_sum = round(sum(float(r["score"] or 0) for r in dead), 1)

    seen: set[int] = set()
    dupes = 0
    for r in rows:
        qid = int(r["question_id"])
        if qid in seen:
            dupes += 1
        seen.add(qid)

    issues: list[dict[str, Any]] = []
    if dupes:
        issues.append({"code": "duplicate_question", "fixable": True,
                       "message": f"有 {dupes} 道重复题（同一道题进了两次，分值被重复计算）"})
    if dead:
        issues.append({"code": "dead_question", "fixable": False,
                       "message": f"有 {len(dead)} 道题已从题库删除但仍挂在卷面上"
                                  f"（合计 {dead_sum} 分学生永远拿不到），请移除后重排分值"})
    if ungradable:
        issues.append({"code": "ungradable_type", "fixable": False,
                       "message": "有题型暂不支持考试判分：" + "、".join(ungradable) + "，请换题"})
    if zero:
        issues.append({"code": "zero_score", "fixable": True,
                       "message": f"有 {len(zero)} 道题分值为 0 或缺失，请重新分配分值"})
    if target <= 0:
        issues.append({"code": "no_target", "fixable": False,
                       "message": "目标总分未设置，请在「编辑考试」里填写"})
    elif abs(active_sum - target) > 0.5:
        issues.append({"code": "total_mismatch", "fixable": True,
                       "message": f"卷面合计 {active_sum} 分 ≠ 目标总分 {target} 分"
                                  f"（{gap_text(round(active_sum - target, 1))}）"})
    if target > 0 and pass_score > target:
        issues.append({"code": "pass_above_total", "fixable": False,
                       "message": f"及格分 {pass_score} 高于目标总分 {target}，没人能及格"})
    return issues


# 能自动修的就只有这三类：重复题、0 分题、卷面与目标不符（都是"重新分配分值"）
REPAIRABLE = {"duplicate_question", "zero_score", "total_mismatch"}


def repair(exam: dict[str, Any], *, dry_run: bool = True) -> dict[str, Any]:
    """把一张卷子修到自洽：删重复题 → 按题型权重重新配平到目标总分。

    默认 dry_run=True 只报告不写库 —— 改的是老师卷子上的分值，必须让他先看见要改什么。
    删题、改及格线这类会动决策的问题不在这里做，只报出来。
    """
    exam_id = int(exam["id"])
    rows = paper_rows(exam_id)
    issues = diagnose(exam, rows)
    fixable = [i for i in issues if i["code"] in REPAIRABLE]
    target = float(exam.get("total_score") or 0)
    before = round(sum(float(r["score"] or 0) for r in rows), 1)
    result: dict[str, Any] = {
        "exam_id": exam_id, "title": exam.get("title"), "dry_run": dry_run,
        "before_total": before, "target": round(target, 1),
        "fixed": [i["code"] for i in fixable], "remaining": [],
        "removed_duplicates": 0, "after_total": before,
    }
    if not fixable:
        result["remaining"] = [i["message"] for i in issues]
        result["changed"] = False
        return result
    if target <= 0:
        result["remaining"] = [i["message"] for i in issues]
        result["changed"] = False
        return result

    keep_ids: list[int] = []
    seen: set[int] = set()
    for r in sorted(rows, key=lambda x: int(x["eq_id"])):
        qid = int(r["question_id"])
        if qid in seen:
            continue
        seen.add(qid)
        keep_ids.append(int(r["eq_id"]))
    dup_rows = len(rows) - len(keep_ids)
    result["removed_duplicates"] = dup_rows

    # 权重：有分值的按原值（保比例），0 分题按题型权重挤进同一量纲
    by_eq = {int(r["eq_id"]): r for r in rows}
    positives = [float(by_eq[i]["score"] or 0) for i in keep_ids if float(by_eq[i]["score"] or 0) > 0]
    avg = (sum(positives) / len(positives)) if positives else 1.0
    weights = []
    for i in keep_ids:
        s = float(by_eq[i]["score"] or 0)
        weights.append(s if s > 0 else weight_of(by_eq[i].get("type")) * avg)
    scores = distribute_scores(target, weights)
    mapping = dict(zip(keep_ids, scores))
    result["after_total"] = round(sum(mapping.values()), 1)
    result["new_scores"] = {str(k): v for k, v in mapping.items()}

    if not dry_run:
        if dup_rows:
            with get_connection() as conn:
                conn.isolation_level = None
                conn.execute("BEGIN IMMEDIATE")
                try:
                    conn.execute(
                        f"DELETE FROM exam_questions WHERE exam_id = ? AND id NOT IN ({','.join('?' * len(keep_ids))})",
                        (exam_id, *keep_ids))
                    conn.execute("COMMIT")
                except Exception:
                    conn.execute("ROLLBACK")
                    raise
        set_scores(exam_id, mapping)

    left = [i["message"] for i in diagnose(
        exam, [dict(by_eq[i], score=mapping[i]) for i in keep_ids]) if i["code"] not in REPAIRABLE]
    result["remaining"] = left
    result["changed"] = True
    return result


def submitted_count(exam_id: int) -> int:
    """已交卷份数：改题改分会让历史成绩与现行卷面脱节，界面据此提示二次确认。"""
    row = execute_query_one(
        "SELECT COUNT(*) AS c FROM exam_attempts WHERE exam_id = ? AND status = 'submitted'",
        (exam_id,))
    return int(row["c"] if row else 0)