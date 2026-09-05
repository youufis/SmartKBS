"""
积分奖励 API 路由
查询积分流水、排行榜、统计数据、称号系统
"""
from fastapi import APIRouter, HTTPException, Request, Query

from backend.api.dependencies import get_current_user
from backend.reward_engine import (
    get_student_total,
    get_student_rewards,
    get_class_ranking,
    get_activity_statistics,
)
from backend.title_system import (
    get_full_title_info,
    get_title_config,
    get_subject_title_config,
    get_badge_config,
    get_title_upgrade_history,
    get_student_subject_titles,
    get_student_badges,
    check_and_unlock_badges,
    get_main_title,
    get_main_title_progress,
    get_or_init_student_title,
    update_subject_question_counts,
    get_subject_list,
)
from backend.database import execute_query
from backend.permission_service import (
    get_grade_by_name,
    get_teacher_classes,
    get_teacher_grades,
    is_student_in_teacher_scope,
)

router = APIRouter()


def _class_nums(username: str, grade: str) -> list[str]:
    """教师在指定年级任教的班级编号(如 ['1','2'])，年级不存在或未任教时返回空列表"""
    gi = get_grade_by_name(grade)
    if not gi:
        return []
    out: list[str] = []
    for c in get_teacher_classes(username, gi["id"]) or []:
        name = str(c.get("name") or "").replace("班", "").strip()
        if name:
            out.append(name)
    return out


def _assert_student_visible(user: dict, target: str, what: str = "数据") -> None:
    """R3: 教师只能查看自己任教范围内学生的积分/流水/称号/档案"""
    role = user.get("role", 2)
    username = user.get("username", "")
    if role == 0 or target == username:
        return
    if role != 1:
        raise HTTPException(status_code=403, detail="无权查看他人数据")
    if not is_student_in_teacher_scope(target, username):
        raise HTTPException(status_code=403, detail=f"只能查看本班学生的{what}")


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
    limit: int = Query(50, ge=1, le=500, description="返回条数"),
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
    teacher: str = Query("", description="仅管理员生效：以指定教师视角过滤"),
):
    """获取班级或年级的积分排名（教师只能看自己任教班级）"""
    user = get_current_user(request)
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看排名")

    allowed_classes: list[str] | None = None   # None = 管理员不过滤
    # R4: teacher 参数只有管理员可用, 教师一律按自己的任教范围过滤
    #      (旧写法 teacher=root 就能借管理员视角看任意班级)
    if role == 1:
        allowed_classes = _class_nums(user["username"], grade)
        if not allowed_classes:
            raise HTTPException(status_code=403, detail="你在该年级没有任教班级，无权查看排名")
        if class_name:
            import re as _re
            nums = _re.findall(r"\d+", class_name)
            cls_num = nums[0] if nums else class_name
            if cls_num not in allowed_classes:
                raise HTTPException(status_code=403, detail="只能查看自己任教班级的排名")

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

    # R8: 教师必须指定任教年级(旧实现任意 grade/class 都能查全校统计)
    if role == 1:
        if not grade:
            raise HTTPException(status_code=403, detail="请指定年级：教师只能查看任教年级的统计")
        own = {str(g.get("name") or "").strip() for g in get_teacher_grades(user["username"])}
        if grade not in own:
            raise HTTPException(status_code=403, detail="只能查看任教年级的统计")
        if class_name:
            import re as _re
            nums = _re.findall(r"\d+", class_name)
            cls_num = nums[0] if nums else class_name
            if cls_num not in _class_nums(user["username"], grade):
                raise HTTPException(status_code=403, detail="只能查看自己任教班级的统计")

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

    _assert_student_visible(user, student_username, "积分数据")
    total = get_student_total(student_username)
    history = get_student_rewards(student_username, limit=100)
    title_info = get_full_title_info(student_username, total)

    return {
        "username": student_username,
        "name": rows[0][0],
        "total_points": total,
        "history": history,
        "title_info": title_info,
    }


# ═══════════════════════════════════════════════
# 称号系统 API
# ═══════════════════════════════════════════════


@router.get("/rewards/my-title", summary="获取我的完整称号信息")
async def my_title(request: Request):
    """获取当前学生的完整称号信息（主称号+学科称号+徽章+升级历史）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        return {"main_title": get_main_title(0), "progress": get_main_title_progress(0)}

    info = get_full_title_info(username)
    return info


@router.get("/rewards/title-config", summary="获取称号配置列表")
async def title_config(request: Request):
    """获取全部称号配置（主称号+学科称号+徽章+科目列表）"""
    return {
        "main_titles": get_title_config(),
        "subject_titles": get_subject_title_config(),
        "badges": get_badge_config(),
        "subjects": get_subject_list(),
    }


@router.get("/rewards/title-history", summary="获取称号升级历史")
async def title_history(
    request: Request,
    limit: int = Query(20, ge=1, le=200, description="返回条数"),
    student_username: str = Query("", description="指定学生（教师专用）"),
):
    """获取称号/徽章升级历史"""
    user = get_current_user(request)
    role = user.get("role", 2)

    if student_username:
        if role not in (0, 1):
            raise HTTPException(status_code=403, detail="仅教师和管理员可查询他人记录")
        _assert_student_visible(user, student_username, "称号升级记录")   # R3
        username = student_username
    else:
        username = user["username"]

    history = get_title_upgrade_history(username, limit=limit)
    return history


@router.get("/rewards/my-subject-titles", summary="获取学科称号")
async def my_subject_titles(request: Request):
    """获取当前学生的各学科称号"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        return []

    titles = get_student_subject_titles(username)
    return titles


@router.get("/rewards/my-badges", summary="获取成就徽章")
async def my_badges(request: Request):
    """获取当前学生的成就徽章（含已解锁/未解锁状态）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        return []

    badges = get_student_badges(username)
    return badges


@router.post("/rewards/check-badges", summary="重新检测徽章")
async def check_badges(request: Request):
    """手动触发徽章检测，返回新解锁的徽章"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        return {"newly_unlocked": []}

    new_badges = check_and_unlock_badges(username)
    return {"newly_unlocked": new_badges}


@router.post("/rewards/update-subject-counts", summary="更新学科答题数")
async def update_subject_counts(request: Request):
    """重新统计学生的各学科答题数并更新学科称号"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        return {"upgrades": []}

    upgrades = update_subject_question_counts(username)
    return {"upgrades": upgrades}
