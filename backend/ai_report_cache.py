# -*- coding: utf-8 -*-
"""AI 报告落库与导出复用。

页面生成 AI 报告后保存正文与元数据，Word 导出只读缓存，不再第二次调用模型：
  - 避免导出等待几十秒；
  - 避免同一份报告屏幕与导出内容不一致；
  - 避免重复计费。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from fastapi import HTTPException

from backend.database import execute_insert_update, execute_query_one

_READY = False


def _ensure_table() -> None:
    global _READY
    if _READY:
        return
    execute_insert_update(
        """CREATE TABLE IF NOT EXISTS ai_reports (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               kind TEXT NOT NULL,
               scope_key TEXT NOT NULL,
               content TEXT NOT NULL,
               meta TEXT DEFAULT '',
               created_by TEXT DEFAULT '',
               created_at TEXT NOT NULL
           )"""
    )
    try:
        execute_insert_update(
            "CREATE INDEX IF NOT EXISTS idx_ai_reports_scope "
            "ON ai_reports(kind, scope_key, created_at)"
        )
    except Exception:
        pass
    _READY = True


def save_report(kind: str, scope_key: str, content: str,
                created_by: str = "", meta: dict[str, Any] | None = None) -> int:
    _ensure_table()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return int(execute_insert_update(
        "INSERT INTO ai_reports (kind, scope_key, content, meta, created_by, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (kind, scope_key, content or "",
         json.dumps(meta or {}, ensure_ascii=False), created_by or "", now),
    ) or 0)


def get_report(report_id: int, username: str = "", role: int = 2,
               kind: str = "") -> dict[str, Any]:
    _ensure_table()
    row = execute_query_one("SELECT * FROM ai_reports WHERE id=?", (report_id,))
    if not row:
        raise HTTPException(status_code=404, detail="报告不存在或已过期，请重新生成")
    if kind and row.get("kind") != kind:
        raise HTTPException(status_code=404, detail="报告类型不匹配")
    if role != 0 and str(row.get("created_by") or "") != str(username or ""):
        raise HTTPException(status_code=403, detail="无权导出他人的报告")
    try:
        row["meta"] = json.loads(row.get("meta") or "{}")
    except (json.JSONDecodeError, TypeError):
        row["meta"] = {}
    return row


def get_latest_report(kind: str, scope_key: str,
                      max_age_hours: int = 24) -> dict[str, Any] | None:
    _ensure_table()
    since = (datetime.now() - timedelta(hours=max_age_hours)).strftime("%Y-%m-%d %H:%M:%S")
    row = execute_query_one(
        "SELECT * FROM ai_reports WHERE kind=? AND scope_key=? AND created_at>=? "
        "ORDER BY id DESC LIMIT 1",
        (kind, scope_key, since),
    )
    if not row:
        return None
    try:
        row["meta"] = json.loads(row.get("meta") or "{}")
    except (json.JSONDecodeError, TypeError):
        row["meta"] = {}
    return row
