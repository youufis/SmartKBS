"""
智能点名 · 公平版 API 路由（重构版）
从 backend/smart_rollcall_api.py 迁移，保持功能完全一致
"""
from fastapi import APIRouter, Request, HTTPException

from backend.api.dependencies import get_current_user
from backend.auth import is_admin
from backend.database import execute_query
from backend.smart_rollcall_api import (
    # ── 原有 API 处理函数（保持原有逻辑）──
    api_grades,
    api_classes,
    api_students,
    api_pick,
    api_mark,
    api_history,
    api_reset,
    api_save_record,
    _load_history,
)

router = APIRouter()

# ── 从原 module-level 函数直接注册 ──

router.get("/grades", summary="获取年级列表")(api_grades)
router.get("/classes", summary="获取班级列表")(api_classes)
router.get("/students", summary="获取学生列表（含积分）")(api_students)
router.post("/pick", summary="公平点名选取")(api_pick)
router.post("/mark", summary="标记点名结果")(api_mark)
router.get("/history", summary="获取点名历史")(api_history)
router.post("/reset", summary="重置点名数据")(api_reset)
router.post("/save-record", summary="保存答题记录到 ChatHistory")(api_save_record)


# ── 管理员总览、教师查看自己的班级 ──


@router.get("/admin/sessions", summary="获取点名会话列表")
async def admin_list_sessions(request: Request):
    """管理员查看所有班级，教师只查看自己的"""
    user = get_current_user(request)
    username = user["username"]

    if is_admin(username):
        rows = execute_query(
            """SELECT rw.teacher_username, rw.grade, rw.class_name,
                      COUNT(DISTINCT rw.student_name) as student_count,
                      COUNT( rh.id) as history_count
               FROM rollcall_weights rw
               LEFT JOIN rollcall_history rh ON rh.teacher_username=rw.teacher_username
                   AND rh.grade=rw.grade AND rh.class_name=rw.class_name
               GROUP BY rw.teacher_username, rw.grade, rw.class_name
               ORDER BY rw.teacher_username, rw.grade, rw.class_name"""
        )
    else:
        rows = execute_query(
            """SELECT rw.teacher_username, rw.grade, rw.class_name,
                      COUNT(DISTINCT rw.student_name) as student_count,
                      COUNT(rh.id) as history_count
               FROM rollcall_weights rw
               LEFT JOIN rollcall_history rh ON rh.teacher_username=rw.teacher_username
                   AND rh.grade=rw.grade AND rh.class_name=rw.class_name
               WHERE rw.teacher_username=?
               GROUP BY rw.teacher_username, rw.grade, rw.class_name
               ORDER BY rw.grade, rw.class_name""",
            (username,),
        )

    return {
        "sessions": [
            {
                "teacher": r[0],
                "grade": r[1],
                "class": r[2],
                "student_count": r[3],
                "history_count": r[4],
            }
            for r in rows
        ],
        "total": len(rows),
    }


@router.get("/admin/detail", summary="查看点名会话详情")
async def admin_session_detail(request: Request):
    """管理员可查看任意班级，教师只能查看自己的"""
    user = get_current_user(request)
    username = user["username"]
    teacher = request.query_params.get("teacher", username)
    grade = request.query_params.get("grade", "")
    cls = request.query_params.get("class", "")

    if not grade or not cls:
        raise HTTPException(status_code=400, detail="缺少 grade/class 参数")

    if not is_admin(username) and teacher != username:
        raise HTTPException(status_code=403, detail="只能查看自己的班级")

    state = _load_history(teacher, grade, cls)
    return {
        "teacher": teacher,
        "grade": grade,
        "class": cls,
        "weights": state.get("weights", {}),
        "history": state.get("history", []),
        "picked_in_round": state.get("picked_in_round", []),
        "last_time": state.get("last_time"),
        "updated": state.get("updated", ""),
        "student_count": len(state.get("weights", {})),
        "history_count": len(state.get("history", [])),
    }


@router.post("/admin/reset", summary="重置点名会话")
async def admin_reset_session(request: Request):
    """管理员可重置任意班级，教师只能重置自己的"""
    user = get_current_user(request)
    username = user["username"]
    body = await request.json()
    teacher = body.get("teacher", username)
    grade = body.get("grade", "")
    cls = body.get("class", "")

    if not grade or not cls:
        raise HTTPException(status_code=400, detail="缺少 grade/class 参数")

    if not is_admin(username) and teacher != username:
        raise HTTPException(status_code=403, detail="只能重置自己的班级")

    # 重新构建参数调用原 reset 逻辑
    from backend.smart_rollcall_api import _load_students
    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]

    from backend.smart_rollcall_api import _save_history
    import time
    state = {
        "weights": {n: 10 for n in names},
        "history": [],
        "picked_in_round": [],
        "last_time": time.time(),
    }
    _save_history(teacher, grade, cls, state)

    return {"success": True, "total": len(names), "teacher": teacher}
