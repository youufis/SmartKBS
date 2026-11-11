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


def build_docx_bytes(title: str, subtitle: str, markdown_text: str) -> bytes:
    """报告正文（Markdown）→ docx 字节。各处 AI 报告导出共用，样式与考试分析报告一致。"""
    import io as _io

    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt, RGBColor

    from backend.api.analytics_router import _markdown_to_docx

    doc = Document()
    style = doc.styles["Normal"]  # type: ignore[union-attr, attr-defined]
    style.font.name = "Microsoft YaHei"  # type: ignore[attr-defined]
    style.font.size = Pt(11)  # type: ignore[attr-defined]
    style.paragraph_format.line_spacing = 1.5  # type: ignore[attr-defined]

    head = doc.add_heading(title, level=1)
    head.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if subtitle:
        info = doc.add_paragraph()
        info.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = info.add_run(subtitle)
        run.font.size = Pt(10)
        run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
    doc.add_paragraph()
    _markdown_to_docx(doc, markdown_text or "")

    buf = _io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.read()


def docx_response(title: str, subtitle: str, markdown_text: str, filename: str):
    """包成浏览器直接下载的 Word 附件响应。"""
    import urllib.parse

    from fastapi.responses import StreamingResponse

    data = build_docx_bytes(title, subtitle, markdown_text)
    safe = urllib.parse.quote(filename)
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe}"})


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
