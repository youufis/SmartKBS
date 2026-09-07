"""
活动数据重置 API

权限一律在服务端强校验（不依赖前端隐藏按钮）：
  role=0 管理员  可重置任何人的活动；重置他人活动时审计标 admin_override
  role=1 教师    仅可重置 creator_username == 本人 的活动；课程练习按
                 "资源拥有者 + 本人任教年级" 双重判定（与活动监控页同口径）
  role=2 学生    一律 403

写路径的越权返回 403（与 exams / quick-quiz / practice 的删除端点一致）；
类型或 ID 非法返回 400，活动不存在返回 404，进行中活动未带 force 返回 409。
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from backend.activity_reset import (RESET_SCOPES, ResetError, describe_scope,
                                    execute_reset, preview_reset, scope_keys)
from backend.api.dependencies import get_current_user
from backend.database import execute_insert_update, execute_query_dict
from backend.logger import logger
from backend.permission_service import get_teacher_grades

router = APIRouter()

# 重置后给学生的通知落点（与前端 App.tsx 的路由表对齐）
RELATED_LINKS = {
    "exam": "/exam", "practice": "/practice", "quick_quiz": "/quick-quiz",
    "task": "/tasks", "quiz": "/interaction", "code": "/code-practice",
    "discussion": "/discussion", "poll": "/quick-poll", "course": "/curriculum",
}


class ResetBody(BaseModel):
    """重置请求体；options 的合法键见 activity_reset.OPTION_LABELS"""
    options: dict[str, bool] = Field(default_factory=dict)
    force: bool = Field(False, description="活动进行中时强制重置")
    notify_students: bool = Field(True, description="是否通知受影响学生")
    confirm_text: str = Field("", description="二次确认口令，需与 preview 的 policy.confirmation_expected 一致")


def _http(err: ResetError) -> HTTPException:
    """detail 用 {code,msg,params} 结构：前端按 code 查词典，msg 只做中文兜底"""
    return HTTPException(status_code=err.status_code, detail=err.as_detail())


def _require_staff(user: dict[str, Any]) -> tuple[str, int]:
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail={"code": "staff_only", "msg": "仅教师和管理员可重置活动"})
    return username, role


def _authorize(user: dict[str, Any], act: dict[str, Any]) -> bool:
    """返回是否为"管理员代操作他人活动"；无权限直接抛 403"""
    username, role = _require_staff(user)
    if role == 0:
        return bool(act.get("creator")) and act["creator"] != username

    creator = act.get("creator") or ""
    if act["type"] == "course":
        # 课程练习没有 creator_username，沿用活动监控页的归属口径
        if creator != username:
            raise HTTPException(status_code=403, detail={"code": "course_not_owner", "msg": "只能重置本人共享的练习资源"})
        grades = {g.get("name") for g in get_teacher_grades(username)}
        if not act.get("grade") or act["grade"] not in grades:
            raise HTTPException(status_code=403, detail={"code": "course_grade_out_of_scope", "msg": "只能重置本人任教年级的课程练习"})
        return False
    if not creator:
        raise HTTPException(status_code=403, detail={"code": "owner_unknown", "msg": "无法确认该活动的归属，已拒绝重置"})
    if creator != username:
        raise HTTPException(status_code=403, detail={"code": "not_yours", "msg": "只能重置自己创建的活动（管理员可重置全部）"})
    return False


def _with_display_name(act: dict[str, Any]) -> dict[str, Any]:
    """界面上展示教师姓名而不是登录名；creator 原值仍留给权限判定用"""
    raw = act.get("creator") or ""
    act["creator_name"] = _display_name(raw) if raw else ""
    return act


def _display_name(username: str) -> str:
    rows = execute_query_dict(
        "SELECT COALESCE(NULLIF(name,''), username) AS dn FROM users WHERE username=?", (username,))
    return rows[0]["dn"] if rows else username


@router.get("/activity-reset/scopes", summary="各活动类型的重置口径（前端渲染用）")
async def list_reset_scopes(request: Request):
    _require_staff(get_current_user(request))
    return {"types": [describe_scope(k) for k in scope_keys()]}


@router.post("/activity-reset/preview/{activity_type}/{activity_id}", summary="重置前干跑预览（只读）")
async def reset_preview(activity_type: str, activity_id: str, request: Request, body: ResetBody):
    """把"将删多少行、影响哪些学生、回收多少积分"先算给教师看，不做任何写入"""
    user = get_current_user(request)
    try:
        plan = preview_reset(activity_type, activity_id, body.options)
    except ResetError as e:
        raise _http(e)
    _authorize(user, plan["activity"])
    _with_display_name(plan["activity"])          # 就地把登录名换成显示名
    return plan


@router.post("/activity-reset/reset/{activity_type}/{activity_id}", summary="执行重置（清数据、留内容）")
async def reset_activity(activity_type: str, activity_id: str, body: ResetBody, request: Request):
    user = get_current_user(request)
    username, role = _require_staff(user)

    try:
        plan = preview_reset(activity_type, activity_id, body.options)
    except ResetError as e:
        raise _http(e)
    admin_override = _authorize(user, plan["activity"])

    if plan["in_progress"]["count"] and not body.force:
        ip = plan["in_progress"]        # 取结构化的进行中信息，不依赖 warnings 的顺序
        raise HTTPException(
            status_code=409,
            detail={"code": "in_progress_force",
                    "msg": f"检测到{ip['label'] or '参与记录'} {ip['count']} 条，"
                           f"重置会打断进行中的参与；确认无误请勾选强制重置后重试",
                    "params": {"count": ip["count"], "label": ip.get("label") or "",
                               "label_code": ip.get("code") or "", "type": activity_type}})

    try:
        result = execute_reset(activity_type, activity_id, body.options,
                               operator=username, force=body.force,
                               confirm_text=body.confirm_text)
    except ResetError as e:
        raise _http(e)

    students = result.pop("student_usernames", [])   # 名单只在服务端使用，响应里只留计数
    notified = _notify_students(result, students, username, body.notify_students)
    _write_audit(user, result, admin_override, notified)
    result["notified_students"] = notified
    _with_display_name(result["activity"])
    return result


def _notify_students(result: dict[str, Any], students: list[str], operator: str,
                     enabled: bool) -> int:
    """重置后必须告诉学生"记录被清空了"，否则他们会以为成绩丢了而来找教师"""
    if not enabled:
        return 0
    if not students:
        return 0
    from backend.api.notification_router import notify_users
    act = result["activity"]
    who = _display_name(operator)
    # 通知在铃铛/通知中心都是纯文本渲染，标题必须先剥掉 markdown 语法
    from backend.text_utils import plain_title
    shown = plain_title(act["title"]) or str(act["title"])
    # payload 里的 params 全是"数据"（活动名/教师名），句式由前端词典按界面语言拼装
    payload = json.dumps({"i18n": "activityReset",
                          "params": {"activity": shown, "operator": who}},
                         ensure_ascii=False)
    notify_users(
        students, "info",
        f"「{shown}」已被教师重置",
        f"{who} 已清空该活动的全部参与记录，你可以重新参与",
        RELATED_LINKS.get(act["type"], "/dashboard"),
        source_type=act["type"], source_id=str(act["id"]), payload=payload,
    )
    return len(students)


def _write_audit(user: dict[str, Any], result: dict[str, Any],
                 admin_override: bool, notified: int) -> None:
    """重置是破坏性且不可撤销的操作，必须留痕；审计写失败只告警，不掩盖已完成的重置"""
    act = result["activity"]
    try:
        execute_insert_update(
            """INSERT INTO activity_reset_logs
               (operator_username, operator_role, activity_type, activity_id, activity_title,
                options_json, deleted_json, deleted_total, points_revoked, students_affected,
                admin_override, notified_students, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                user["username"], int(user.get("role", 2)), act["type"], str(act["id"]),
                act["title"],
                json.dumps(result["options_effective"], ensure_ascii=False),
                json.dumps(result["deleted"], ensure_ascii=False),
                int(result["deleted_total"]), int(result["rewards_points"]),
                int(result["students_affected"]), 1 if admin_override else 0,
                int(notified), datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            ),
        )
    except Exception as e:
        logger.error(f"[活动重置] 审计写入失败（重置已完成，请人工补记）: {e}")


@router.get("/activity-reset/logs", summary="重置操作记录（管理员看全部，教师看自己）")
async def list_reset_logs(
    request: Request,
    activity_type: str = Query("", description="筛选活动类型"),
    limit: int = Query(50, ge=1, le=200),
):
    username, role = _require_staff(get_current_user(request))
    where = ["1=1"]
    params: list[Any] = []
    if role != 0:
        where.append("operator_username = ?")
        params.append(username)
    if activity_type:
        if activity_type not in RESET_SCOPES:
            raise HTTPException(status_code=400,
                                detail={"code": "unsupported_type",
                                        "msg": f"无效的活动类型: {activity_type}",
                                        "params": {"type": activity_type}})
        where.append("activity_type = ?")
        params.append(activity_type)
    rows = execute_query_dict(
        f"""SELECT id, operator_username, activity_type, activity_id, activity_title,
                   deleted_total, points_revoked, students_affected, admin_override,
                   notified_students, created_at
            FROM activity_reset_logs WHERE {' AND '.join(where)}
            ORDER BY id DESC LIMIT ?""",
        tuple(params + [limit]),
    )
    for r in rows:
        r["type_label"] = RESET_SCOPES.get(r["activity_type"], {}).get("label", r["activity_type"])
    return {"logs": rows, "total": len(rows)}
