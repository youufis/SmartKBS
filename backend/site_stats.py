# -*- coding: utf-8 -*-
"""站点访问统计：单调计数器 + 登录页要展示的那几个数。

为什么要单独一个"只增不减"的计数器（2026-10-06 定的口径）
  登录页想显示"累计访问多少次"。最直觉的做法是 `COUNT(*) FROM login_logs`，
  但管理员在「登录历史」子页里可以按 id 批量删除记录 —— 那样累计数会**往回退**，
  一个会倒退的"历史总量"没有意义。所以另存一个只增不减的计数器：删明细不影响它。
  代价说清楚：启用之前已经被删掉的历史无法追回，建档时一次性把基线设为
  "当前留存的明细条数"，此后只增。

为什么统计接口要缓存
  登录页对**未登录访客**也每 15 秒轮询一次。不缓存就等于把"扫 login_logs"
  挂在公网入口上，人越多越贵。TTL 与前端轮询同频（15 秒），数字最多滞后 15 秒。
"""
from __future__ import annotations

import datetime
import threading
import time
from typing import Any

from backend.database import execute_insert_update, execute_query
from backend.logger import logger

COUNTER_KEY = "login_total"
_STATS_TTL_SECONDS = 15          # 与登录页轮询同频
_lock = threading.Lock()
_stats_cache: tuple[float, dict[str, Any]] = (0.0, {})


def bump_login_count(step: int = 1) -> None:
    """访问计数 +1（原子 UPSERT）。

    **绝不能因为统计失败而拖垮登录**：所有异常只记 warning。
    多 worker 并发也安全 —— 累加交给 SQLite，不用进程内变量。
    """
    try:
        execute_insert_update(
            """INSERT INTO site_counter (key, value, updated_at)
               VALUES (?, ?, datetime('now', 'localtime'))
               ON CONFLICT(key) DO UPDATE
                 SET value = value + excluded.value, updated_at = excluded.updated_at""",
            (COUNTER_KEY, int(step)),
        )
    except Exception as exc:
        logger.warning(f"[stats] 访问计数递增失败（不影响登录）: {exc}")


def get_login_count() -> int:
    """累计访问次数；计数器行不存在时回落到当前留存明细数（只读，不写库）"""
    try:
        rows = execute_query("SELECT value FROM site_counter WHERE key=?", (COUNTER_KEY,))
        if rows and rows[0][0] is not None:
            return int(rows[0][0])
    except Exception as exc:
        logger.warning(f"[stats] 读取累计计数失败: {exc}")
    try:
        rows = execute_query("SELECT COUNT(*) FROM login_logs", ())
        return int(rows[0][0]) if rows else 0
    except Exception:
        return 0


def _today_prefix() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d")


def _query_stats() -> dict[str, Any]:
    from backend.auth import get_online_count

    today_times, today_users = 0, 0
    try:
        rows = execute_query(
            "SELECT COUNT(*), COUNT(DISTINCT username) FROM login_logs WHERE login_time LIKE ?",
            (f"{_today_prefix()}%",),
        )
        if rows:
            today_times, today_users = int(rows[0][0] or 0), int(rows[0][1] or 0)
    except Exception as exc:
        logger.warning(f"[stats] 今日访问统计失败: {exc}")
    return {
        "online": get_online_count(),
        "today_times": today_times,
        "today_users": today_users,
        "total_times": get_login_count(),
    }


def visit_stats(force: bool = False) -> dict[str, Any]:
    """登录页一次性要拿的四个数（在线 / 今日人次 / 今日人数 / 累计），带 15 秒缓存。

    缓存读不到时宁可返回**上一个旧值**也不要查库失败给前端一个 500：
    登录页的数字是装饰性的，不能成为登录的依赖。
    """
    now = time.time()
    with _lock:
        stamp, cached = _stats_cache
        if cached and not force and now - stamp < _STATS_TTL_SECONDS:
            return dict(cached)
    fresh = _query_stats()
    with _lock:
        globals()["_stats_cache"] = (now, dict(fresh))
    return dict(fresh)


def invalidate_cache() -> None:
    """测试与"刚登录完立刻刷新"场景用；线上不需要主动调"""
    with _lock:
        globals()["_stats_cache"] = (0.0, {})