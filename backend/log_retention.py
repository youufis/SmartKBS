# -*- coding: utf-8 -*-
"""业务日志表保留策略: 启动 60s 后首跑 + 每 24h 定期清理, 防只增不删

保留窗设置偏保守(考勤视图依赖 login_logs、资源统计依赖 resource_view_logs):
- config_sync_logs  30 天
- login_logs       180 天
- resource_view_logs 365 天
- notifications     90 天(仅已读, 未读永不清理)
"""
import threading
import time as _time
from datetime import datetime, timedelta

from backend.database import get_connection
from backend.logger import logger

_ITEMS = [
    ("config_sync_logs", ("synced_at", "created_at", "timestamp", "log_time"), 30, ""),
    ("login_logs", ("login_time",), 180, ""),
    ("resource_view_logs", ("viewed_at",), 365, ""),
    ("notifications", ("created_at",), 90, "is_read=1"),
]


def _pick_col(conn, table, candidates):
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)]
    except Exception:
        return None
    for c in candidates:
        if c in cols:
            return c
    return None


def purge_once() -> None:
    for table, cands, days, extra in _ITEMS:
        try:
            with get_connection() as conn:
                col = _pick_col(conn, table, cands)
                if not col:
                    continue
                cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
                sql = "DELETE FROM %s WHERE %s < ?" % (table, col)
                if extra:
                    sql += " AND " + extra
                cur = conn.execute(sql, (cutoff,))
                conn.commit()
                if cur.rowcount:
                    logger.info(f"[log_retention] {table} 清理 {cur.rowcount} 条过期记录(保留 {days} 天)")
        except Exception as e:
            logger.warning(f"[log_retention] {table} 清理失败: {e}")


def start() -> None:
    """启动后台守护线程(不阻塞服务启动)"""
    def _loop():
        _time.sleep(60)
        purge_once()
        while True:
            _time.sleep(24 * 3600)
            purge_once()

    threading.Thread(target=_loop, daemon=True, name="log-retention").start()
