"""代码练习的分数归一（独立小模块）。

**为什么不放在 code_router.py 里**：那个模块 import 一次要 15 秒（依赖全站路由、AI 服务、
FastAPI 等）。如果启动钩子里 `from backend.api.code_router import normalize_all_case_scores`，
整个 startup 会被同步阻塞十几秒，服务在这段时间内完全不响应。

这里只依赖 question_db（一个连接工具），import 是毫秒级。
"""
from __future__ import annotations

import logging
from typing import Any

from backend.question_db import get_connection

logger = logging.getLogger(__name__)

#: 用例分合计的规范值
FULL_SCORE = 100


def split_100(scores: list[float]) -> list[int]:
    """把一组分值按比例缩放到合计 100，用最大余数法分配余数。

    只改总量、不改相对权重：教师给"边界用例 3 分、普通用例 1 分"的意图是保留的。
    """
    n = len(scores)
    if not n:
        return []
    total = sum(scores)
    if total <= 0:
        base, rem = divmod(FULL_SCORE, n)
        return [base + (1 if i < rem else 0) for i in range(n)]
    raw = [s * FULL_SCORE / total for s in scores]
    floor = [int(x) for x in raw]
    left = FULL_SCORE - sum(floor)
    order = sorted(range(n), key=lambda i: raw[i] - floor[i], reverse=True)
    for i in order[:max(0, left)]:
        floor[i] += 1
    return floor


def apply_split(conn: Any, problem_id: int) -> bool:
    """把某道题的用例分归一到合计 100；已经规范则不动。返回是否真的改了。"""
    rows = conn.execute(
        "SELECT id, score FROM code_test_cases WHERE problem_id=? ORDER BY sort_order, id",
        (problem_id,)).fetchall()
    if not rows:
        return False
    cur = [float(r[1] or 0) for r in rows]
    if abs(sum(cur) - FULL_SCORE) < 0.01:
        return False
    target = split_100(cur)
    changed = False
    for (rid, old), val in zip(rows, target):
        if abs(float(old or 0) - val) >= 0.01:
            conn.execute("UPDATE code_test_cases SET score=? WHERE id=?", (float(val), rid))
            changed = True
    return changed


def normalize_all_case_scores() -> int:
    """把历史题目的用例分归一到 100（幂等），历史提交按同比例换算成百分制。

    早期题目按"每个用例 1~2 分"建，满分只有 10 分甚至 1 分 —— 学生的分数、
    教师看到的平均分都跟着这个走，跨题根本没法比。这里只缩放总量，不动相对权重。
    """
    changed = 0
    with get_connection() as conn:
        ids = [r[0] for r in conn.execute(
            "SELECT DISTINCT problem_id FROM code_test_cases").fetchall()]
        for pid in ids:
            if apply_split(conn, int(pid)):
                changed += 1
            # 提交的换算**不能挂在 apply_split 的返回值上**：用例可能早已归一（上一次启动做过），
            # 那时 apply_split 返回 False，历史提交就永远换算不到 —— 会变成「均分 10 / 满分 100」。
            # 所以这里独立判断：只要这条提交的满分不是 100 就按比例换算。
            # （max_score=0 是判题失败时的老数据，无法换算，保持原样，统计时单独排除）
            conn.execute(
                """UPDATE code_submissions
                      SET score = ROUND(score * 100.0 / max_score, 2), max_score = 100
                    WHERE problem_id = ? AND max_score > 0
                      AND ABS(max_score - 100) > 0.01""",
                (int(pid),))
        conn.commit()
    if changed:
        logger.info(f"[code-score] 用例分已归一：{changed} 道题，历史提交同步换算为百分制")
    return changed
