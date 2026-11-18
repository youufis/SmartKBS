# -*- coding: utf-8 -*-
"""教学简报 API。

端点顺序注意：/options /periods /preview /list /jobs/{id} /settings 必须放在 /{report_id} 之前，
否则 "options" 会被当成 report_id 解析。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from backend import briefing_store as store
from backend.api.dependencies import get_current_user
from backend.database import execute_query_dict
from backend.briefing_compose import (
    PROMPT_VERSION,
    apply_ai,
    build_prompt,
    build_rule_sections,
    parse_ai_json,
    sections_to_markdown,
)
from backend.briefing_service import (
    _allowed_pairs,
    collect_metrics,
    previous_period,
    resolve_period,
    resolve_scope,
)
from backend.logger import logger

router = APIRouter()
_BG_TASKS: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    """后台任务持引用，避免事件循环回收未完成的 task。"""
    task = asyncio.create_task(coro)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)


class GenerateBody(BaseModel):
    period_type: str = "week"
    anchor: str = ""
    start: str = ""
    end: str = ""
    teacher: str = ""
    grade: str = ""
    class_filter: str = Field("", alias="class")
    subject: str = ""
    force: bool = False
    year_mode: str = "school_year"

    model_config = {"populate_by_name": True}


class SettingsBody(BaseModel):
    auto_daily: bool | None = None
    auto_weekly: bool | None = None
    auto_monthly: bool | None = None
    auto_yearly: bool | None = None
    notify: bool | None = None
    year_mode: str | None = None


def _user(request: Request) -> dict[str, Any]:
    user = get_current_user(request)
    if int(user.get("role", 2)) == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看教学简报")
    return user


def _scope_kwargs(body: GenerateBody) -> dict[str, Any]:
    return {
        "teacher": body.teacher,
        "grades": body.grade or None,
        "classes": body.class_filter or None,
        "subjects": body.subject or None,
    }


_DUPLICATE_KEYS = ("sections_json", "metrics_json", "facts_json", "filter_json",
                   "snapshot_metrics_json", "report_metrics_json")


def _public_report(report: dict[str, Any]) -> dict[str, Any]:
    """去掉重复的大字段：快照指标与版本指标各存一份，返回一份就够。"""
    out = dict(report)
    for k in _DUPLICATE_KEYS:
        out.pop(k, None)
    return out


def _data_hash(m: dict[str, Any]) -> str:
    slim = {
        "activity": (m.get("activity") or {}).get("total"),
        "samples": (m.get("learning") or {}).get("samples"),
        "rate": (m.get("learning") or {}).get("avg_rate"),
        "part": (m.get("participation") or {}).get("rate"),
        "praise": len((m.get("praise") or {}).get("students") or []),
        "weak": len(m.get("weak_points") or []),
    }
    return hashlib.sha1(json.dumps(slim, sort_keys=True).encode("utf-8")).hexdigest()[:16]


async def _run_job(job_id: str, body: GenerateBody, user: dict[str, Any]) -> None:
    try:
        period = resolve_period(body.period_type, anchor=body.anchor or None,
                                start=body.start, end=body.end, year_mode=body.year_mode)
        scope = resolve_scope(user, **_scope_kwargs(body))
        store.update_job(job_id, status="collecting", progress=15, stage="采集指标")
        metrics = await asyncio.to_thread(collect_metrics, scope, period)

        store.update_job(job_id, status="composing", progress=45, stage="生成报告骨架")
        snapshot_id = store.save_snapshot(period, scope, metrics, _data_hash(metrics))

        headline, sections = build_rule_sections(metrics)
        ai_model, tokens, status = "", 0, "done"
        rejected = 0

        if metrics.get("is_empty"):
            status = "empty"
        else:
            store.update_job(job_id, status="analyzing", progress=65, stage="AI 解读")
            payload = await _call_ai(metrics, scope, period)
            if payload:
                headline2, sections, rejected = apply_ai(metrics, sections, payload)
                headline = headline2 or headline
                ai_model = payload.get("_model", "")
                tokens = int(payload.get("_tokens", 0) or 0)
            else:
                status = "degraded"

        # 生成期间若用户删除了这份简报，任务行会被清掉：此时不要再落报告
        if not store.get_job(job_id):
            logger.info(f"[briefing] 任务 {job_id} 已被删除，放弃写入")
            return
        report_id = store.create_report(
            snapshot_id, headline, sections, ai_model=ai_model, tokens=tokens,
            status=status, created_by=user["username"], prompt_version=PROMPT_VERSION,
            metrics=metrics,
        )
        stage = "完成" if not rejected else f"完成（AI 段落校验丢弃 {rejected} 处）"
        # 空周期不当作“已生成”，避免调度器发通知
        job_status = "empty" if status == "empty" else "done"
        store.update_job(job_id, status=job_status, progress=100, stage=stage, report_id=report_id)
    except HTTPException as exc:
        store.update_job(job_id, status="failed", progress=100, stage="失败",
                         error=str(exc.detail))
    except Exception as exc:  # noqa: BLE001 - 任务失败要落库，不能只打日志
        logger.exception(f"[briefing] 生成失败 {job_id}: {exc}")
        store.update_job(job_id, status="failed", progress=100, stage="失败", error=str(exc)[:200])


async def _call_ai(m: dict[str, Any], scope: dict[str, Any], period: dict[str, Any]) -> dict[str, Any] | None:
    try:
        from backend.api.chat_router import get_api_keys
        api_key, _ = get_api_keys("")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[briefing] 读取 API Key 失败: {exc}")
        return None
    if not api_key:
        return None

    prompt = build_prompt(m, scope, period)
    max_tokens = {"day": 800, "week": 1400, "month": 2000, "year": 2600}.get(period["type"], 1400)
    try:
        from backend.api.ai_service import call_ai_async
        text = await asyncio.wait_for(
            call_ai_async(prompt, api_key, max_tokens=max_tokens, json_mode=True, use_kb=False),
            timeout=120,
        )
        payload = parse_ai_json(text)
        if payload:
            payload["_model"] = "dashscope"
            payload["_tokens"] = len(text) // 2
        return payload
    except asyncio.TimeoutError:
        logger.warning("[briefing] AI 解读超时，降级为规则版")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[briefing] AI 解读失败，降级为规则版: {exc}")
    return None


# ── 选项与周期 ────────────────────────────────────────────────

@router.get("/options", summary="简报筛选器可选值")
async def briefing_options(request: Request):
    user = _user(request)
    role = int(user.get("role", 2))
    owner = user["username"] if role != 0 else ""
    pairs = _allowed_pairs(role, owner)
    grades: dict[int, str] = {}
    classes: list[dict[str, Any]] = []
    for p in pairs:
        grades[int(p["grade_id"])] = p["grade_name"]
        classes.append({"grade": p["grade_name"], "name": p["class_display"],
                        "id": p["class_id"]})
    subjects: list[str] = []
    if role != 0:
        from backend.permission_service import get_teacher_assignments
        for r in get_teacher_assignments(user["username"]):
            s = str(r.get("subject") or "").strip()
            if s and s not in subjects:
                subjects.append(s)
    else:
        # 管理员：用系统配置的学科清单，不从历史数据里凑
        # （否则「信息技术」这种旧写法会作为一个独立学科出现在下拉里）
        from backend.subject_config import get_subjects
        subjects = get_subjects()
    teachers: list[dict[str, str]] = []
    if role == 0:
        teachers = [{"username": r["username"], "name": r.get("name") or r["username"]}
                    for r in execute_query_dict(
                        "SELECT username, name FROM users WHERE role=1 ORDER BY username")]
    return {
        "role": role,
        "grades": sorted(grades.values()),
        "classes": sorted(classes, key=lambda x: (x["grade"], x["name"])),
        "subjects": subjects,
        "teachers": teachers,
        "year_mode": store.get_settings(user["username"]).get("year_mode", "school_year"),
    }


def _pick_type(type_: Any, period_type: Any) -> str:
    """兼容两种参数名：前端传 period_type，脚本/旧调用传 type。

    直接调用端点函数（测试脚本）时默认值是 Query 对象，这里一并兜住。
    """
    for v in (period_type, type_):
        if isinstance(v, str) and v.strip():
            return v.strip().lower()
    return "week"


@router.get("/periods", summary="可选周期列表")
async def briefing_periods(request: Request, type: str = Query("week"),
                           period_type: str = Query(""), anchor: str = Query(""),
                           limit: int = Query(12, ge=1, le=60),
                           year_mode: str = Query("school_year")):
    _user(request)
    ptype = _pick_type(type, period_type)
    if ptype not in ("day", "week", "month", "year"):
        raise HTTPException(status_code=400, detail="周期类型错误")
    cur = resolve_period(ptype, anchor=anchor or None, year_mode=year_mode)
    out = []
    p = cur
    for _ in range(limit):
        out.append({"key": p["key"], "label": p["label"], "start": p["start_date"],
                    "end": p["end_date"]})
        p = previous_period(p)
    return {"current": cur, "items": out}


@router.get("/preview", summary="实时指标预览（不落库）")
async def briefing_preview(request: Request,
                           type: str = Query("week"), period_type: str = Query(""),
                           anchor: str = Query(""),
                           start: str = Query(""), end: str = Query(""),
                           teacher: str = Query(""), grade: str = Query(""),
                           cls: str = Query("", alias="class"), subject: str = Query(""),
                           year_mode: str = Query("school_year")):
    user = _user(request)
    period = resolve_period(_pick_type(type, period_type), anchor=anchor or None,
                            start=start, end=end, year_mode=year_mode)
    scope = resolve_scope(user, teacher=teacher, grades=grade or None,
                          classes=cls or None, subjects=subject or None)
    metrics = collect_metrics(scope, period)
    return {
        "period": period,
        "scope": metrics["scope"],
        "summary": {
            "activity_total": metrics["activity"]["total"],
            "samples": metrics["learning"]["samples"],
            "avg_rate": metrics["learning"]["avg_rate"],
            "delta": metrics["learning"]["delta"],
            "participation_rate": metrics["participation"]["rate"],
            "silent_count": metrics["participation"]["silent_count"],
            "pending_grading": metrics["tasks"]["pending_grading"],
            "praise_count": len(metrics["praise"]["students"]),
            "alert_count": len(metrics["alerts"]),
        },
        "is_empty": metrics["is_empty"],
        "facts": metrics["facts"],
    }


# ── 生成 ──────────────────────────────────────────────────────

@router.post("/generate", summary="生成/重新生成简报")
async def briefing_generate(body: GenerateBody, request: Request):
    user = _user(request)
    period = resolve_period(body.period_type, anchor=body.anchor or None,
                            start=body.start, end=body.end, year_mode=body.year_mode)
    scope = resolve_scope(user, **_scope_kwargs(body))

    if not body.force:
        existing = store.latest_report(period["type"], period["key"], scope["scope_key"])
        if existing:
            return {"existed": True, "report_id": existing["id"], "status": existing["status"]}

    running = store.running_job(period["type"], period["key"], scope["scope_key"])
    if running:
        return {"existed": False, "job_id": running["id"], "status": running["status"]}

    if store.count_running_jobs(user["username"]) >= 2:
        raise HTTPException(status_code=429, detail="同时生成中的简报过多，请稍后再试")

    job_id = uuid.uuid4().hex[:12]
    store.create_job(job_id, period["type"], period["key"], scope["scope_key"],
                     user["username"], trigger="manual")
    _spawn(_run_job(job_id, body, user))
    return {"existed": False, "job_id": job_id, "status": "pending"}


@router.get("/jobs/{job_id}", summary="生成进度")
async def briefing_job(job_id: str, request: Request):
    user = _user(request)
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")
    if int(user.get("role", 2)) != 0 and job["owner_username"] != user["username"]:
        raise HTTPException(status_code=403, detail="无权查看该任务")
    return job


# ── 列表与详情 ────────────────────────────────────────────────

@router.get("/list", summary="简报列表")
async def briefing_list(request: Request, type: str = Query(""), page: int = Query(1, ge=1),
                        size: int = Query(20, ge=1, le=50)):
    user = _user(request)
    rows, total = store.list_reports(user["username"], int(user.get("role", 2)),
                                     period_type=type, limit=size, offset=(page - 1) * size)
    return {"total": total, "page": page, "items": rows}


@router.get("/latest", summary="当前周期的已有简报（没有则返回空）")
async def briefing_latest(request: Request, type: str = Query("week"),
                          period_type: str = Query(""), anchor: str = Query(""),
                          start: str = Query(""), end: str = Query(""),
                          teacher: str = Query(""), grade: str = Query(""),
                          cls: str = Query("", alias="class"), subject: str = Query(""),
                          year_mode: str = Query("school_year")):
    user = _user(request)
    period = resolve_period(_pick_type(type, period_type), anchor=anchor or None,
                            start=start, end=end, year_mode=year_mode)
    scope = resolve_scope(user, teacher=teacher, grades=grade or None,
                          classes=cls or None, subjects=subject or None)
    report = store.latest_report(period["type"], period["key"], scope["scope_key"])
    if not report:
        return {"exists": False, "period": period, "scope": scope["filter_label"]}
    return {"exists": True, "report": _public_report(report)}


@router.get("/settings", summary="简报偏好")
async def get_settings(request: Request):
    user = _user(request)
    return store.get_settings(user["username"])


@router.put("/settings", summary="保存简报偏好")
async def put_settings(body: SettingsBody, request: Request):
    user = _user(request)
    return store.save_settings(user["username"], body.model_dump(exclude_none=True))


@router.get("/{report_id}", summary="简报详情")
async def briefing_detail(report_id: int, request: Request):
    user = _user(request)
    report = store.get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="简报不存在")
    if int(user.get("role", 2)) != 0 and report["owner_username"] != user["username"]:
        raise HTTPException(status_code=403, detail="无权查看他人简报")
    return _public_report(report)


@router.post("/{report_id}/regenerate", summary="重新生成（新版本）")
async def briefing_regenerate(report_id: int, request: Request):
    user = _user(request)
    report = store.get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="简报不存在")
    if int(user.get("role", 2)) != 0 and report["owner_username"] != user["username"]:
        raise HTTPException(status_code=403, detail="无权操作他人简报")

    f = report.get("filter") or {}
    target = int(user.get("role", 2)) == 0 and report["owner_username"] != user["username"]
    is_custom = "@" in str(report.get("period_key") or "")
    # 标准周期只能用 anchor：传 start/end 会走自定义分支，生成出另一个 key 的快照
    body = GenerateBody(
        period_type=report["period_type"],
        anchor="" if is_custom else report["period_start"][:10],
        start=report["period_start"][:10] if is_custom else "",
        end=report["period_end"][:10] if is_custom else "",
        teacher=report["owner_username"] if target else "",
        grade=",".join(f.get("grades") or []),
        class_filter=",".join(f.get("classes") or []),
        subject=",".join(f.get("subjects") or []),
        force=True,
    )
    period = resolve_period(body.period_type, anchor=body.anchor or None,
                            start=body.start, end=body.end)
    scope_key = report["scope_key"]
    running = store.running_job(period["type"], period["key"], scope_key)
    if running:
        return {"job_id": running["id"], "status": running["status"]}

    if store.count_running_jobs(user["username"]) >= 2:
        raise HTTPException(status_code=429, detail="同时生成中的简报过多，请稍后再试")

    job_id = uuid.uuid4().hex[:12]
    store.create_job(job_id, period["type"], period["key"], scope_key,
                     user["username"], trigger="regenerate")
    _spawn(_run_job(job_id, body, user))
    return {"job_id": job_id, "status": "pending"}


@router.delete("/{report_id}", summary="删除简报（含所有历史版本）")
async def briefing_delete(report_id: int, request: Request):
    user = _user(request)
    report = store.get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="简报不存在")
    if int(user.get("role", 2)) != 0 and report["owner_username"] != user["username"]:
        raise HTTPException(status_code=403, detail="无权删除他人简报")
    ok_deleted = store.delete_briefing(report_id)
    return {"ok": bool(ok_deleted)}


@router.get("/{report_id}/versions", summary="同一快照的报告版本列表")
async def briefing_versions(report_id: int, request: Request):
    user = _user(request)
    report = store.get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="简报不存在")
    if int(user.get("role", 2)) != 0 and report["owner_username"] != user["username"]:
        raise HTTPException(status_code=403, detail="无权查看他人简报")
    return {"items": store.list_versions(report_id)}


@router.get("/{report_id}/export", summary="导出 Word")
async def briefing_export(report_id: int, request: Request):
    user = _user(request)
    report = store.get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="简报不存在")
    if int(user.get("role", 2)) != 0 and report["owner_username"] != user["username"]:
        raise HTTPException(status_code=403, detail="无权导出他人简报")

    from backend.ai_report_cache import docx_response
    md = sections_to_markdown(report.get("headline", ""), report.get("sections") or [])
    subtitle = f"{report['period_start'][:10]} 至 {report['period_end'][:10]} · {report.get('filter_label', '')}"
    title = f"教学简报 · {report['period_start'][:10]} 至 {report['period_end'][:10]}"
    raw_name = f"教学简报_{report['period_start'][:10]}_{report.get('filter_label', '')[:12]}"
    filename = re.sub(r'[\\/:*?"<>|\s]+', '_', raw_name) + ".docx"
    tables = []
    for sec in report.get("sections") or []:
        for tb in sec.get("tables") or []:
            tables.append({"heading": f"{sec.get('title', '')} · {tb.get('title', '')}",
                           "columns": tb.get("columns") or [], "rows": tb.get("rows") or []})
    return docx_response(title, subtitle, md, filename, tables=tables)
