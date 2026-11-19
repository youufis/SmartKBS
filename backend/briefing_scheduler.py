# -*- coding: utf-8 -*-
"""教学简报：定时预生成。

策略（与 00-方案建议.md 的"调度规则"一致）：
  - 每 30 分钟 tick 一次，补齐"该有但没有"的周期，漏跑也能自愈；
  - 只给「本期确实有教学活动/积分」的教师生成，避免全库空转；
  - 单次 tick 最多生成 2 份，防止启动瞬间把 AI 通道打满；
  - 全局开关 BRIEFING_AUTO_ENABLED（默认开），置 0 后只保留手动生成；
  - 报告已存在则跳过（同周期同筛选唯一）。
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from typing import Any

from backend import briefing_store as store
from backend.briefing_service import previous_period, resolve_period, resolve_scope
from backend.database import execute_query, execute_query_dict
from backend.logger import logger
from backend.question_db import execute_query as q_execute_query

TICK_SECONDS = 1800
MAX_PER_TICK = 2
# 优先级：周/月最有价值，年报默认关闭
AUTO_TYPES = ("week", "month", "year")
AUTO_CONFIG_KEY = {"week": "BRIEFING_AUTO_WEEKLY",
                   "month": "BRIEFING_AUTO_MONTHLY",
                   "year": "BRIEFING_AUTO_YEARLY"}
_SCOPE_CACHE: dict[str, dict[str, Any]] = {}


def _cfg(key: str, default: Any = None) -> Any:
    try:
        from backend.api.config_router import get_config_value
        return get_config_value(key, default)
    except Exception:  # noqa: BLE001
        return default


def _bool_cfg(key: str, default: bool = False) -> bool:
    v = _cfg(key, default)
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _enabled() -> bool:
    v = _cfg("BRIEFING_AUTO_ENABLED", 1)
    return str(v).strip().lower() not in ("0", "false", "off", "no", "")


def _last_completed(period_type: str, now: datetime, year_mode: str) -> dict[str, Any]:
    """最近一个已经结束的周期（当前周期永远不算）。"""
    return previous_period(resolve_period(period_type, anchor=now.date(), year_mode=year_mode))


def _teacher_usernames() -> list[str]:
    try:
        rows = execute_query(
            "SELECT username FROM users WHERE role=1 AND IFNULL(status,'active')='active' ORDER BY username"
        )
        return [r[0] for r in rows if r[0]]
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[briefing] 读取教师列表失败: {exc}")
        return []


def _count(rows: Any) -> int:
    if not rows:
        return 0
    first = rows[0]
    if isinstance(first, dict):
        return int(list(first.values())[0] or 0)
    return int(first[0] or 0)


def _has_data(owner: str, period: dict[str, Any]) -> bool:
    """本期是否有值得出简报的内容（活动或积分）。"""
    t0, t1 = period["start"], period["end"]
    checks = [
        ("s", "SELECT COUNT(*) AS n FROM interaction_quizzes WHERE creator_username=? AND created_at BETWEEN ? AND ?"),
        ("s", "SELECT COUNT(*) AS n FROM tasks WHERE creator_username=? AND created_at BETWEEN ? AND ?"),
        ("s", "SELECT COUNT(*) AS n FROM interaction_polls WHERE creator_username=? AND created_at BETWEEN ? AND ?"),
        ("q", "SELECT COUNT(*) AS n FROM exams WHERE creator_username=? AND created_at BETWEEN ? AND ?"),
        ("q", "SELECT COUNT(*) AS n FROM practice_sessions WHERE creator_username=? AND created_at BETWEEN ? AND ?"),
        ("s", "SELECT COUNT(*) AS n FROM discussions WHERE creator_username=? AND created_at BETWEEN ? AND ?"),
        ("q", "SELECT COUNT(*) AS n FROM code_problems WHERE creator_username=? AND created_at BETWEEN ? AND ?"),
        ("q", "SELECT COUNT(*) AS n FROM homework_assignments WHERE creator_username=? AND created_at BETWEEN ? AND ?"),
        ("s", "SELECT COUNT(*) AS n FROM score_logs WHERE teacher_username=? AND created_at BETWEEN ? AND ?"),
    ]
    for db, sql in checks:
        try:
            rows = q_execute_query(sql, (owner, t0, t1)) if db == "q" else execute_query_dict(sql, (owner, t0, t1))
            if _count(rows):
                return True
        except Exception:  # noqa: BLE001 - 单表异常不影响其它判断
            continue
    return False


def _scope(owner: str) -> dict[str, Any] | None:
    if owner in _SCOPE_CACHE:
        return _SCOPE_CACHE[owner]
    try:
        scope = resolve_scope({"username": owner, "role": 1})
    except Exception:
        return None
    _SCOPE_CACHE[owner] = scope
    return scope


def plan(now: datetime | None = None, limit: int = MAX_PER_TICK) -> list[dict[str, Any]]:
    """计算本次应该生成哪些简报（不写库、不调 AI）。"""
    now = now or datetime.now()
    planned: list[dict[str, Any]] = []
    teachers = _teacher_usernames()
    year_mode = str(_cfg("BRIEFING_YEAR_MODE", "school_year") or "school_year")
    _SCOPE_CACHE.clear()
    for ptype in AUTO_TYPES:
        # 全局策略：默认全关。管理员在「系统配置 → 教学与激励 → 教学简报」统一开启。
        if not _bool_cfg(AUTO_CONFIG_KEY[ptype], False):
            continue
        period = _last_completed(ptype, now, year_mode)
        for owner in teachers:
            if len(planned) >= limit:
                return planned
            scope = _scope(owner)
            if not scope:
                continue
            if store.latest_report(period["type"], period["key"], scope["scope_key"]):
                continue
            if store.running_job(period["type"], period["key"], scope["scope_key"]):
                continue
            if not _has_data(owner, period):
                continue
            planned.append({
                "owner": owner, "period_type": period["type"], "period_key": period["key"],
                "start": period["start_date"], "end": period["end_date"],
                "scope_key": scope["scope_key"], "label": period["label"],
                "anchor": period["start_date"],
                "year_mode": year_mode,
            })
    return planned


async def run_once(now: datetime | None = None, limit: int = MAX_PER_TICK) -> list[dict[str, Any]]:
    """执行一次 tick（带跨进程锁，多 worker 部署也只会有一个实例真正生成）。"""
    if not _enabled():
        return []
    holder = store.acquire_lock("briefing_tick")
    if not holder:
        logger.info("[briefing] 其他实例正在生成，本次跳过")
        return []
    try:
        return await _run_once_locked(now, limit)
    finally:
        store.release_lock("briefing_tick", holder)


async def _run_once_locked(now: datetime | None = None, limit: int = MAX_PER_TICK) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    for item in plan(now, limit):
        from backend.api.briefing_router import GenerateBody, _run_job
        job_id = uuid.uuid4().hex[:12]
        store.create_job(job_id, item["period_type"], item["period_key"], item["scope_key"],
                         item["owner"], trigger="auto")
        # 标准周期用 anchor，不能传 start/end：resolve_period 会把 start/end
        # 当成自定义区间，生成带 @ 后缀的另一份快照，调度器下一轮又认为没生成。
        body = GenerateBody(period_type=item["period_type"], anchor=item["anchor"],
                            year_mode=item.get("year_mode", "school_year"))
        try:
            await _run_job(job_id, body, {"username": item["owner"], "role": 1})
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[briefing] 自动生成失败 {item['owner']} {item['period_key']}: {exc}")
            continue
        job = store.get_job(job_id) or {}
        report_id = job.get("report_id")
        if job.get("status") == "done" and report_id:
            _notify(item, int(report_id))
        jobs.append({"job_id": job_id, "report_id": report_id, "status": job.get("status"), **item})
    return jobs


def _notify(item: dict[str, Any], report_id: int) -> None:
    try:
        if not _bool_cfg("BRIEFING_NOTIFY", True):
            return
        from backend.api.notification_router import create_notification
        create_notification(
            item["owner"], "system", f"教学简报已生成 · {item['label']}",
            "点击查看本期数据结论与教学建议。", "/briefing",
            source_type="briefing", source_id=str(report_id),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[briefing] 通知发送失败: {exc}")


async def auto_loop() -> None:
    """每 30 分钟补一次；异常不退出循环。"""
    await asyncio.sleep(90)     # 启动后先让主流程就绪
    while True:
        try:
            jobs = await run_once()
            if jobs:
                logger.info(f"[briefing] 自动生成 {len(jobs)} 份: "
                            + ", ".join(f"{j['owner']}/{j['period_key']}" for j in jobs))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[briefing] 自动生成循环异常: {exc}")
        await asyncio.sleep(TICK_SECONDS)
