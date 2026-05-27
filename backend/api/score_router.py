"""
课堂积分系统 API 路由（重构版）
从 backend/score_system.py 迁移，保持功能完全一致
"""
from fastapi import APIRouter, Request

from backend.database import execute_query
from backend.score_system import (
    # ── 原有 API 处理函数（保持原有逻辑）──
    api_classes,
    api_my_grades,
    api_teacher_info,
    api_students,
    api_ranking,
    api_stats,
    api_score_post,
    api_reset_post,
    api_student_save,
    api_student_delete,
    # ── 原有工具函数（供内联路由使用）──
    _load_teacher_scores,
    _get_teacher,
)

router = APIRouter()

# ── 从原 module-level 函数直接注册 ──

router.get("/classes", summary="获取班级列表")(api_classes)
router.get("/my-grades", summary="获取我的年级列表")(api_my_grades)
router.get("/teacher-info", summary="获取教师任教信息")(api_teacher_info)
router.get("/students", summary="获取学生列表（含积分）")(api_students)
router.get("/ranking", summary="获取积分排名")(api_ranking)
router.get("/stats", summary="获取积分统计")(api_stats)
router.post("/score", summary="添加积分")(api_score_post)
router.post("/reset", summary="重置积分")(api_reset_post)
router.post("/student", summary="保存/迁移学生积分")(api_student_save)
router.delete("/student", summary="删除学生积分")(api_student_delete)


# ── 原 mount_score_api 内联定义的路由 ──


@router.get("/ping", summary="健康检查")
async def ping():
    """积分系统健康检查"""
    return {"status": "ok"}


@router.get("/my-score", summary="查询学生个人累计积分")
async def api_my_score(request: Request):
    """查询某个学生在所有教师下的累计积分"""
    name = request.query_params.get("name", "").strip()
    if not name:
        return {"error": "缺少 name 参数"}

    # 收集所有教师/管理员
    teachers_list = ["root"]
    try:
        rows = execute_query("SELECT username FROM users WHERE role IN (0, 1)")
        teachers_list = ["root"] + [row[0] for row in rows if row[0] != "root"]
    except Exception:
        pass

    total_score = 0
    found_grade = ""
    found_class = ""
    found_teachers = []
    teacher_scores = {}

    for t in teachers_list:
        scores = _load_teacher_scores(t)
        for key, val in scores.items():
            parts = key.split("|")
            if len(parts) == 4 and parts[-1] == name:
                total_score += val
                if not found_grade:
                    found_grade = parts[1]
                    found_class = parts[2]
                if t not in found_teachers:
                    found_teachers.append(t)
                teacher_scores[t] = teacher_scores.get(t, 0) + val

    if total_score > 0:
        return {
            "name": name,
            "class": found_class,
            "grade": found_grade,
            "score": total_score,
            "teacher": "、".join(found_teachers),
            "teacher_scores": teacher_scores,
        }
    return {"name": name, "score": None, "message": "未找到该学生的积分记录"}


@router.get("/teachers", summary="获取教师/管理员列表")
async def api_teachers():
    """获取所有教师/管理员列表"""
    teachers = ["root"]
    try:
        rows = execute_query(
            "SELECT username FROM users WHERE role IN (0, 1) ORDER BY username"
        )
        teachers = ["root"] + [row[0] for row in rows if row[0] != "root"]
    except Exception:
        pass
    return sorted(set(teachers))
