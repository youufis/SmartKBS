"""
积分奖励 API 路由
查询积分流水、排行榜、统计数据
"""
from fastapi import APIRouter, HTTPException, Request, Query

from backend.api.dependencies import get_current_user
from backend.reward_engine import (
    get_student_total,
    get_student_rewards,
    get_class_ranking,
    get_activity_statistics,
)
from backend.database import execute_query

router = APIRouter()


@router.get("/rewards/my-points", summary="获取我的积分")
async def my_points(request: Request):
    """获取当前学生用户的积分总和"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role != 2:
        # 教师/管理员可查看自己积分（0）或指定学生积分
        return {"username": username, "total_points": 0, "is_teacher": True}

    total = get_student_total(username)
    return {"username": username, "total_points": total, "is_teacher": False}


@router.get("/rewards/my-history", summary="获取我的积分流水")
async def my_reward_history(
    request: Request,
    limit: int = Query(50, description="返回条数"),
    activity_type: str = Query("", description="筛选活动类型"),
):
    """获取当前学生的积分流水"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        return []

    history = get_student_rewards(username, limit=limit, activity_type=activity_type)
    return history


@router.get("/rewards/ranking", summary="获取班级积分排名")
async def ranking(
    request: Request,
    grade: str = Query(..., description="年级"),
    class_name: str = Query("", description="班级，空表示全年级"),
    teacher: str = Query("", description="教师用户名，用于权限过滤"),
):
    """获取班级或年级的积分排名（教师只能看自己任教班级）"""
    user = get_current_user(request)
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看排名")

    # 教师权限过滤
    allowed_classes = None
    if role == 1:
        # 教师只能看自己任教的班级
        t = teacher or user["username"]
        from backend.api.score_router import _get_teacher_allowed_classes
        allowed = _get_teacher_allowed_classes(t, grade)
        if allowed:
            allowed_classes = [f"{grade}{a}班" for a in allowed]

    ranking_list = get_class_ranking(grade, class_name, allowed_classes)

    # 补充排名序号
    for i, r in enumerate(ranking_list):
        r["rank"] = i + 1

    return ranking_list


@router.get("/rewards/statistics", summary="获取积分统计")
async def statistics(
    request: Request,
    grade: str = Query("", description="年级"),
    class_name: str = Query("", description="班级"),
):
    """获取积分统计数据（教师/管理员）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看统计")

    stats = get_activity_statistics(grade=grade, class_name=class_name)
    return stats


@router.get("/rewards/student/{student_username}", summary="查询指定学生积分")
async def student_points(student_username: str, request: Request):
    """教师/管理员查询指定学生的积分及流水"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查询")

    # 验证学生存在
    rows = execute_query(
        "SELECT name FROM users WHERE username=? AND role=2",
        (student_username,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="学生不存在")

    total = get_student_total(student_username)
    history = get_student_rewards(student_username, limit=100)

    return {
        "username": student_username,
        "name": rows[0][0],
        "total_points": total,
        "history": history,
    }
