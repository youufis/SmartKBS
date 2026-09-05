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


def _dedupe_view_logs() -> None:
    """清理历史双写产生的「同人+同资源+同秒」重复浏览记录(保留信息最全的一条):
    优先保留带 knowledge_point/binding 上下文或非 direct 来源, 再按最小 id; 幂等安全"""
    try:
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT id, student_username, resource_type, resource_id, file_path, viewed_at,"
                " source, knowledge_point_id, binding_id FROM resource_view_logs"
            ).fetchall()
            groups: dict = {}
            for r in rows:
                key = (r[1], r[2], r[3] or 0, r[4] or "", r[5])
                groups.setdefault(key, []).append(r)
            to_delete = []
            for members in groups.values():
                if len(members) < 2:
                    continue
                def rank(m):
                    return (1 if m[7] else 0, 1 if m[8] else 0, 1 if (m[6] or "") != "direct" else 0, -m[0])
                keep = max(members, key=rank)
                to_delete.extend([m[0] for m in members if m[0] != keep[0]])
            if to_delete:
                ph = ",".join("?" * len(to_delete))
                conn.execute("DELETE FROM resource_view_logs WHERE id IN (%s)" % ph, tuple(to_delete))
                conn.commit()
                logger.info(f"[log_retention] resource_view_logs 清理历史双写重复 {len(to_delete)} 条")
    except Exception as e:
        logger.warning(f"[log_retention] 浏览日志去重失败: {e}")


def purge_once() -> None:
    _dedupe_view_logs()
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
