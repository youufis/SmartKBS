# -*- coding: utf-8 -*-
"""教学简报：快照 / 报告 / 任务 / 偏好 落库层。

与采集层（briefing_service）分离：
  - service 只算，不写库；
  - 本模块只读写，不做业务判断；
  - 快照唯一键 (period_type, period_key, scope_key)，重新生成时原地刷新并新建报告版本。
"""
from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timedelta
from typing import Any

from backend.database import (
    execute_insert_update,
    execute_query,
    execute_query_dict,
    execute_query_one,
    get_connection,
)

_READY = False
_AUTO_OFF_MIGRATION = "2026-11-19-auto-off-defaults"


def ensure_tables() -> None:
    global _READY
    if _READY:
        return
    execute_insert_update(
        """CREATE TABLE IF NOT EXISTS briefing_snapshots (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               period_type TEXT NOT NULL,
               period_key TEXT NOT NULL,
               period_start TEXT NOT NULL,
               period_end TEXT NOT NULL,
               scope_type TEXT NOT NULL DEFAULT 'teacher',
               scope_key TEXT NOT NULL,
               filter_json TEXT NOT NULL DEFAULT '{}',
               filter_label TEXT NOT NULL DEFAULT '',
               owner_username TEXT NOT NULL,
               metrics_json TEXT NOT NULL,
               facts_json TEXT NOT NULL DEFAULT '[]',
               metrics_version INTEGER NOT NULL DEFAULT 1,
               data_hash TEXT NOT NULL DEFAULT '',
               is_empty INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL
           )"""
    )
    execute_insert_update(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_briefing_snapshot "
        "ON briefing_snapshots(period_type, period_key, scope_key)"
    )
    execute_insert_update(
        "CREATE INDEX IF NOT EXISTS idx_briefing_snapshot_owner "
        "ON briefing_snapshots(owner_username, created_at)"
    )
    execute_insert_update(
        """CREATE TABLE IF NOT EXISTS briefing_reports (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               snapshot_id INTEGER NOT NULL,
               version INTEGER NOT NULL DEFAULT 1,
               headline TEXT DEFAULT '',
               sections_json TEXT NOT NULL,
               ai_model TEXT DEFAULT '',
               prompt_version INTEGER NOT NULL DEFAULT 1,
               tokens INTEGER DEFAULT 0,
               status TEXT NOT NULL DEFAULT 'done',
               created_by TEXT DEFAULT '',
               metrics_json TEXT DEFAULT '',
               created_at TEXT NOT NULL
           )"""
    )
    cols = {str(r[1]) for r in execute_query("PRAGMA table_info(briefing_reports)")}
    if "metrics_json" not in cols:
        execute_insert_update("ALTER TABLE briefing_reports ADD COLUMN metrics_json TEXT DEFAULT ''")
    execute_insert_update(
        "CREATE INDEX IF NOT EXISTS idx_briefing_report_snapshot "
        "ON briefing_reports(snapshot_id, version)"
    )
    execute_insert_update(
        """CREATE TABLE IF NOT EXISTS briefing_jobs (
               id TEXT PRIMARY KEY,
               period_type TEXT NOT NULL,
               period_key TEXT NOT NULL,
               scope_key TEXT NOT NULL,
               owner_username TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               progress INTEGER DEFAULT 0,
               stage TEXT DEFAULT '',
               report_id INTEGER,
               error TEXT DEFAULT '',
               trigger_type TEXT DEFAULT 'manual',
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
           )"""
    )
    execute_insert_update(
        "CREATE INDEX IF NOT EXISTS idx_briefing_job_owner "
        "ON briefing_jobs(owner_username, created_at)"
    )
    execute_insert_update(
        """CREATE TABLE IF NOT EXISTS briefing_runtime_locks (
               name TEXT PRIMARY KEY,
               holder TEXT NOT NULL,
               expires_at TEXT NOT NULL
           )"""
    )
    execute_insert_update(
        """CREATE TABLE IF NOT EXISTS briefing_settings (
               owner_username TEXT PRIMARY KEY,
               auto_daily INTEGER DEFAULT 0,
               auto_weekly INTEGER DEFAULT 0,
               auto_monthly INTEGER DEFAULT 0,
               auto_yearly INTEGER NOT NULL DEFAULT 0,
               notify INTEGER DEFAULT 1,
               year_mode TEXT DEFAULT 'school_year',
               updated_at TEXT
           )"""
    )
    execute_insert_update(
        """CREATE TABLE IF NOT EXISTS briefing_migrations (
               name TEXT PRIMARY KEY,
               applied_at TEXT NOT NULL
           )"""
    )
    _apply_auto_off_migration()
    expire_stale_jobs()
    _READY = True


def _apply_auto_off_migration() -> None:
    """把旧版本“默认自动开启”的设置一次性关掉。

    旧版本建表默认 auto_weekly/monthly=1；只在代码里改 DEFAULT 不会影响
    已经存在的行。迁移只执行一次，之后用户主动开启不会被重置。
    """
    row = execute_query_one(
        "SELECT name FROM briefing_migrations WHERE name=?",
        (_AUTO_OFF_MIGRATION,),
    )
    if row:
        return
    now = _now()
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO briefing_migrations(name, applied_at) VALUES (?, ?)",
            (_AUTO_OFF_MIGRATION, now),
        )
        if cur.rowcount:
            conn.execute(
                "UPDATE briefing_settings SET "
                "auto_daily=0, auto_weekly=0, auto_monthly=0, auto_yearly=0"
            )
        conn.commit()


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def slim_metrics(m: dict[str, Any]) -> dict[str, Any]:
    """报告版本只存渲染需要的指标：去掉活动明细、班级明细与 facts 副本。"""
    out = {k: v for k, v in (m or {}).items() if k not in ("activity", "by_class", "facts")}
    act = dict((m or {}).get("activity") or {})
    act.pop("items", None)
    out["activity"] = act
    return out


def _loads(raw: Any, default: Any):
    try:
        return json.loads(raw) if isinstance(raw, str) and raw else default
    except (json.JSONDecodeError, TypeError):
        return default


# ── 快照 ──────────────────────────────────────────────────────

def get_snapshot(period_type: str, period_key: str, scope_key: str) -> dict[str, Any] | None:
    ensure_tables()
    row = execute_query_one(
        "SELECT * FROM briefing_snapshots WHERE period_type=? AND period_key=? AND scope_key=?",
        (period_type, period_key, scope_key),
    )
    if not row:
        return None
    row["metrics"] = _loads(row.get("metrics_json"), {})
    row["facts"] = _loads(row.get("facts_json"), [])
    row["filter"] = _loads(row.get("filter_json"), {})
    return row


def save_snapshot(period: dict[str, Any], scope: dict[str, Any],
                  metrics: dict[str, Any], data_hash: str) -> int:
    ensure_tables()
    now = _now()
    metrics_json = json.dumps(metrics, ensure_ascii=False, default=str)
    facts_json = json.dumps(metrics.get("facts", []), ensure_ascii=False, default=str)
    filter_json = json.dumps(scope.get("filter", {}), ensure_ascii=False)
    scope_type = "admin" if (scope["is_admin"] and not scope["owner"]) else "teacher"

    existing = execute_query_one(
        "SELECT id FROM briefing_snapshots WHERE period_type=? AND period_key=? AND scope_key=?",
        (period["type"], period["key"], scope["scope_key"]),
    )
    if existing:
        execute_insert_update(
            """UPDATE briefing_snapshots
               SET period_start=?, period_end=?, filter_json=?, filter_label=?,
                   metrics_json=?, facts_json=?, metrics_version=?, data_hash=?,
                   is_empty=?, created_at=?
               WHERE id=?""",
            (period["start"], period["end"], filter_json, scope.get("filter_label", ""),
             metrics_json, facts_json, int(metrics.get("metrics_version", 1)), data_hash,
             1 if metrics.get("is_empty") else 0, now, existing["id"]),
        )
        return int(existing["id"])

    return int(execute_insert_update(
        """INSERT INTO briefing_snapshots
           (period_type, period_key, period_start, period_end, scope_type, scope_key,
            filter_json, filter_label, owner_username, metrics_json, facts_json,
            metrics_version, data_hash, is_empty, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (period["type"], period["key"], period["start"], period["end"], scope_type,
         scope["scope_key"], filter_json, scope.get("filter_label", ""), scope["owner"] or "",
         metrics_json, facts_json, int(metrics.get("metrics_version", 1)), data_hash,
         1 if metrics.get("is_empty") else 0, now),
    ) or 0)


# ── 报告 ──────────────────────────────────────────────────────

def create_report(snapshot_id: int, headline: str, sections: list[dict[str, Any]],
                  ai_model: str = "", tokens: int = 0, status: str = "done",
                  created_by: str = "", prompt_version: int = 1,
                  metrics: dict[str, Any] | None = None) -> int:
    ensure_tables()
    row = execute_query_one(
        "SELECT COALESCE(MAX(version), 0) AS v FROM briefing_reports WHERE snapshot_id=?",
        (snapshot_id,),
    )
    version = int((row or {}).get("v") or 0) + 1
    report_id = int(execute_insert_update(
        """INSERT INTO briefing_reports
           (snapshot_id, version, headline, sections_json, ai_model, prompt_version,
            tokens, status, created_by, metrics_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (snapshot_id, version, headline or "",
         json.dumps(sections, ensure_ascii=False, default=str),
         ai_model or "", int(prompt_version), int(tokens), status, created_by or "",
         json.dumps(slim_metrics(metrics or {}), ensure_ascii=False, default=str), _now()),
    ) or 0)
    # 同快照只保留最近 5 个版本
    execute_insert_update(
        """DELETE FROM briefing_reports WHERE snapshot_id=? AND id NOT IN (
               SELECT id FROM briefing_reports WHERE snapshot_id=? ORDER BY version DESC LIMIT 5)""",
        (snapshot_id, snapshot_id),
    )
    return report_id


def get_report(report_id: int) -> dict[str, Any] | None:
    ensure_tables()
    row = execute_query_one(
        """SELECT r.*, s.period_type, s.period_key, s.period_start, s.period_end,
                  s.scope_key, s.filter_json, s.filter_label, s.owner_username,
                  s.metrics_json AS snapshot_metrics_json, s.facts_json, s.metrics_version, s.is_empty,
                  s.created_at AS snapshot_at, r.metrics_json AS report_metrics_json
           FROM briefing_reports r JOIN briefing_snapshots s ON r.snapshot_id = s.id
           WHERE r.id=?""",
        (report_id,),
    )
    if not row:
        return None
    row["sections"] = _loads(row.get("sections_json"), [])
    # 优先用报告自己的指标（历史版本）；老数据没有则回落到当前快照
    own_metrics = _loads(row.get("report_metrics_json"), {})
    row["metrics"] = own_metrics or _loads(row.get("snapshot_metrics_json"), {})
    row["facts"] = _loads(row.get("facts_json"), [])
    row["filter"] = _loads(row.get("filter_json"), {})
    return row


def latest_report(period_type: str, period_key: str, scope_key: str) -> dict[str, Any] | None:
    ensure_tables()
    snap = get_snapshot(period_type, period_key, scope_key)
    if not snap:
        return None
    row = execute_query_one(
        "SELECT id FROM briefing_reports WHERE snapshot_id=? ORDER BY version DESC LIMIT 1",
        (snap["id"],),
    )
    return get_report(int(row["id"])) if row else None


def list_reports(owner: str, role: int, period_type: str = "", limit: int = 20,
                 offset: int = 0) -> tuple[list[dict[str, Any]], int]:
    """历史列表：同一快照只列最新版本，否则重生成几次就出现几条重复。"""
    ensure_tables()
    where = ["1=1"]
    params: list[Any] = []
    if role != 0:
        where.append("s.owner_username=?")
        params.append(owner)
    if period_type:
        where.append("s.period_type=?")
        params.append(period_type)
    cond = " AND ".join(where)

    total_row = execute_query_one(
        f"""SELECT COUNT(*) AS n FROM briefing_snapshots s
            WHERE {cond} AND EXISTS (SELECT 1 FROM briefing_reports r WHERE r.snapshot_id=s.id)""",
        tuple(params))
    rows = execute_query_dict(
        f"""SELECT r.id, r.snapshot_id, r.version, r.headline, r.status, r.created_at,
                   s.period_type, s.period_key, s.period_start, s.period_end,
                   s.filter_label, s.owner_username, s.is_empty,
                   CASE WHEN IFNULL(r.metrics_json,'')='' THEN json_extract(s.metrics_json,'$.learning.avg_rate')
                        ELSE json_extract(r.metrics_json,'$.learning.avg_rate') END AS avg_rate,
                   CASE WHEN IFNULL(r.metrics_json,'')='' THEN json_extract(s.metrics_json,'$.activity.total')
                        ELSE json_extract(r.metrics_json,'$.activity.total') END AS activity_total,
                   CASE WHEN IFNULL(r.metrics_json,'')='' THEN json_extract(s.metrics_json,'$.participation.rate')
                        ELSE json_extract(r.metrics_json,'$.participation.rate') END AS participation_rate
            FROM briefing_snapshots s
            JOIN briefing_reports r ON r.snapshot_id = s.id
             AND r.version = (SELECT MAX(version) FROM briefing_reports r2 WHERE r2.snapshot_id = s.id)
            WHERE {cond}
            ORDER BY r.id DESC LIMIT ? OFFSET ?""",
        tuple(params) + (limit, offset),
    )
    return rows, int((total_row or {}).get("n") or 0)


def delete_briefing(report_id: int) -> bool:
    """删除一条简报：该快照的所有版本一起删，避免列表里“删了又冒出来”。"""
    ensure_tables()
    row = execute_query_one(
        """SELECT r.snapshot_id, s.period_type, s.period_key, s.scope_key
           FROM briefing_reports r JOIN briefing_snapshots s ON r.snapshot_id=s.id
           WHERE r.id=?""", (report_id,))
    if not row:
        return False
    sid = int(row["snapshot_id"])
    # 通知里带的是 report_id，删报告后一并清掉，避免点开是死链
    try:
        ids = [int(r["id"]) for r in execute_query_dict(
            "SELECT id FROM briefing_reports WHERE snapshot_id=?", (sid,))]
        for rid in ids:
            execute_insert_update(
                "DELETE FROM notifications WHERE source_type='briefing' AND source_id=?", (str(rid),))
    except Exception:  # noqa: BLE001 - 通知表异常不影响删除
        pass
    execute_insert_update("DELETE FROM briefing_reports WHERE snapshot_id=?", (sid,))
    execute_insert_update("DELETE FROM briefing_snapshots WHERE id=?", (sid,))
    execute_insert_update(
        "DELETE FROM briefing_jobs WHERE period_type=? AND period_key=? AND scope_key=?",
        (row["period_type"], row["period_key"], row["scope_key"]))
    return True


def list_versions(report_id: int) -> list[dict[str, Any]]:
    """同一快照下的所有报告版本（按版本倒序）。"""
    ensure_tables()
    row = execute_query_one("SELECT snapshot_id FROM briefing_reports WHERE id=?", (report_id,))
    if not row:
        return []
    return execute_query_dict(
        "SELECT id, version, status, created_at FROM briefing_reports "
        "WHERE snapshot_id=? ORDER BY version DESC", (row["snapshot_id"],),
    )


def has_report(period_type: str, period_key: str, scope_key: str) -> bool:
    ensure_tables()
    row = execute_query_one(
        """SELECT r.id FROM briefing_reports r JOIN briefing_snapshots s ON r.snapshot_id=s.id
           WHERE s.period_type=? AND s.period_key=? AND s.scope_key=? LIMIT 1""",
        (period_type, period_key, scope_key),
    )
    return bool(row)


# ── 任务 ──────────────────────────────────────────────────────

def create_job(job_id: str, period_type: str, period_key: str, scope_key: str,
               owner: str, trigger: str = "manual") -> None:
    ensure_tables()
    now = _now()
    execute_insert_update(
        """INSERT INTO briefing_jobs
           (id, period_type, period_key, scope_key, owner_username, status, progress,
            stage, report_id, error, trigger_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, '排队中', NULL, '', ?, ?, ?)""",
        (job_id, period_type, period_key, scope_key, owner, trigger, now, now),
    )


def update_job(job_id: str, **fields: Any) -> None:
    ensure_tables()
    if not fields:
        return
    fields["updated_at"] = _now()
    cols = ", ".join(f"{k}=?" for k in fields)
    execute_insert_update(
        f"UPDATE briefing_jobs SET {cols} WHERE id=?", tuple(fields.values()) + (job_id,)
    )


def get_job(job_id: str) -> dict[str, Any] | None:
    ensure_tables()
    return execute_query_one("SELECT * FROM briefing_jobs WHERE id=?", (job_id,))


JOB_STALE_MINUTES = 30


def _stale_cut(minutes: int = JOB_STALE_MINUTES) -> str:
    return (datetime.now() - timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")


def expire_stale_jobs(minutes: int = JOB_STALE_MINUTES) -> int:
    """服务重启/线程中断会把任务永久卡在 running；超过 30 分钟直接判失败。"""
    try:
        execute_insert_update(
            "UPDATE briefing_jobs SET status='failed', stage='超时', "
            "error='生成超时（服务可能重启过）', updated_at=? "
            "WHERE status IN ('pending','collecting','analyzing','composing') AND updated_at<?",
            (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), _stale_cut(minutes)),
        )
        return 1
    except Exception:  # noqa: BLE001
        return 0


def count_running_jobs(owner: str) -> int:
    ensure_tables()
    row = execute_query_one(
        "SELECT COUNT(*) AS n FROM briefing_jobs WHERE owner_username=? "
        "AND status IN ('pending','collecting','analyzing','composing') AND updated_at>=?", (owner, _stale_cut())
    )
    return int((row or {}).get("n") or 0)


def running_job(period_type: str, period_key: str, scope_key: str) -> dict[str, Any] | None:
    ensure_tables()
    return execute_query_one(
        """SELECT * FROM briefing_jobs
           WHERE period_type=? AND period_key=? AND scope_key=?
             AND status IN ('pending','collecting','analyzing','composing')
             AND updated_at>=?
           ORDER BY created_at DESC LIMIT 1""",
        (period_type, period_key, scope_key, _stale_cut()),
    )


# ── 运行时锁（跨进程）────────────────────────────────────────

def acquire_lock(name: str, ttl_seconds: int = 900) -> str | None:
    """抢占一把带 TTL 的锁；抢不到返回 None。释放由 release_lock 负责。"""
    ensure_tables()
    holder = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
    now = datetime.now()
    exp = (now + timedelta(seconds=ttl_seconds)).strftime("%Y-%m-%d %H:%M:%S")
    now_s = now.strftime("%Y-%m-%d %H:%M:%S")
    try:
        with get_connection() as conn:
            cur = conn.execute(
                "UPDATE briefing_runtime_locks SET holder=?, expires_at=? "
                "WHERE name=? AND (expires_at<=? OR holder=?)",
                (holder, exp, name, now_s, holder),
            )
            if cur.rowcount == 0:
                try:
                    conn.execute(
                        "INSERT INTO briefing_runtime_locks(name, holder, expires_at) VALUES (?, ?, ?)",
                        (name, holder, exp),
                    )
                except sqlite3.IntegrityError:
                    conn.rollback()
                    return None
            conn.commit()
        return holder
    except Exception:  # noqa: BLE001 - 抢锁失败按"没抢到"处理，不阻断主流程
        return None


def release_lock(name: str, holder: str) -> None:
    try:
        execute_insert_update(
            "DELETE FROM briefing_runtime_locks WHERE name=? AND holder=?", (name, holder)
        )
    except Exception:  # noqa: BLE001
        pass


# ── 偏好 ──────────────────────────────────────────────────────

def get_settings(owner: str) -> dict[str, Any]:
    ensure_tables()
    row = execute_query_one("SELECT * FROM briefing_settings WHERE owner_username=?", (owner,))
    return row or {
        "owner_username": owner, "auto_daily": 0, "auto_weekly": 0,
        "auto_monthly": 0, "auto_yearly": 0, "notify": 1, "year_mode": "school_year",
    }


def save_settings(owner: str, data: dict[str, Any]) -> dict[str, Any]:
    ensure_tables()
    cur = get_settings(owner)
    merged = {
        "auto_daily": int(bool(data.get("auto_daily", cur.get("auto_daily", 0)))),
        "auto_weekly": int(bool(data.get("auto_weekly", cur.get("auto_weekly", 0)))),
        "auto_monthly": int(bool(data.get("auto_monthly", cur.get("auto_monthly", 0)))),
        "auto_yearly": int(bool(data.get("auto_yearly", cur.get("auto_yearly", 0)))),
        "notify": int(bool(data.get("notify", cur.get("notify", 1)))),
        "year_mode": "calendar" if str(data.get("year_mode") or cur.get("year_mode")) == "calendar"
        else "school_year",
    }
    execute_insert_update(
        """INSERT INTO briefing_settings
           (owner_username, auto_daily, auto_weekly, auto_monthly, auto_yearly, notify,
            year_mode, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_username) DO UPDATE SET
             auto_daily=excluded.auto_daily, auto_weekly=excluded.auto_weekly,
             auto_monthly=excluded.auto_monthly, auto_yearly=excluded.auto_yearly,
             notify=excluded.notify, year_mode=excluded.year_mode,
             updated_at=excluded.updated_at""",
        (owner, merged["auto_daily"], merged["auto_weekly"], merged["auto_monthly"],
         merged["auto_yearly"], merged["notify"], merged["year_mode"], _now()),
    )
    return get_settings(owner)
