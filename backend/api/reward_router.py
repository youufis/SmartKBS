"""
积分奖励 API 路由
查询积分流水、排行榜、统计数据、称号系统
"""
from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.reward_engine import (
    get_student_total,
    get_student_rewards,
    get_class_ranking,
    get_activity_statistics,
    rules_payload,
    my_daily_status,
    my_summary,
    award_quality,
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


class QualityAward(BaseModel):
    """教师认可一次具体表现（优质提问 / 优质发言 / 优质回答）"""
    student_username: str
    activity_type: str
    activity_id: str
    tier: str = "excellent"
    activity_title: str = ""


@router.get("/rewards/rules", summary="积分规则（学生端唯一数据源）")
async def reward_rules(request: Request):
    """把发分规则原样下发：活动分表、达标线、生效中的每日上限、扣分与消费口径。

    学生端「积分规则」弹窗以前在前端手抄了一份数值表（RewardPage 的 RULES 数组），
    后端改了它就漂——实测已经漂出三处：分组讨论标着有等级奖却从未发过、
    闯关写着每次 +1 而实际每天只发一次、整套每日上限对学生只字未提。
    现在规则只有一份，出自 backend/reward_engine.py。
    """
    get_current_user(request)          # 与其它端点一致的登录门槛
    return rules_payload()


@router.get("/rewards/my-daily-status", summary="今日额度与上限提示")
async def my_daily_status_endpoint(request: Request):
    """今天各池/各活动拿了多少、上限多少、以及最近一次"被上限挡住"的原因。

    上限本来就会静默生效：学生做完事积分不动，界面毫无反应，只能靠猜。
    """
    user = get_current_user(request)
    username = user["username"]
    if user.get("role", 2) != 2:
        return {"pools": [], "activities": [], "last_block_reason": "", "is_teacher": True}
    return {**my_daily_status(username), "is_teacher": False}


@router.get("/rewards/my-summary", summary="参与与获奖汇总")
async def my_summary_endpoint(request: Request):
    """参与场次 / 获奖次数 / 累计得分与消费：由后端一次聚合算准。

    前端原来拿流水条数当"参与活动次数"，而流水接口只回 100 条，
    学生的参与数会永远卡在 100，还把扣分与等级奖行也数进了"参与"。
    """
    user = get_current_user(request)
    username = user["username"]
    if user.get("role", 2) != 2:
        return {"participation_sessions": 0, "bonus_awards": 0,
                "points_earned": 0, "points_spent": 0, "activity_types": 0}
    return my_summary(username)


@router.post("/rewards/award-quality", summary="教师发放优质认可奖励")
async def reward_quality_award(req: QualityAward, request: Request):
    """给"答得好"而不是"答过"发分：提问、讨论发言、回答审批之外的通用认可入口。

    权限与积分可见范围同源（R3：教师只能给自己任教范围内的学生加分）。
    """
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可发放认可奖励")
    _assert_student_visible(user, req.student_username, "积分发放")
    points = award_quality(req.student_username, req.activity_type, req.activity_id,
                           req.tier, activity_title=req.activity_title,
                           teacher_username=user["username"])
    if points > 0:
        try:
            from backend.api.notification_router import create_notification
            create_notification(req.student_username, "success",
                                f"老师给了你一个「{req.tier}」认可 +{points} 分",
                                req.activity_title or req.activity_type, user["username"])
        except Exception:
            pass
    return {"awarded": points, "tier": req.tier,
            "activity_type": req.activity_type, "activity_id": req.activity_id}


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

    # 排行榜此前只有姓名+学号, 看不出年级班级: 统一补全
    from backend.permission_service import attach_student_info
    attach_student_info(ranking_list, key="username", prefix="")

    # 补充排名序号
    for i, r in enumerate(ranking_list):
        r["rank"] = i + 1

    return ranking_list


@router.get("/rewards/weekly-stars", summary="本周之星（学生可访问）")
async def weekly_stars(
    request: Request,
    grade: str = Query("", description="仅教师/管理员：指定年级"),
    class_name: str = Query("", description="仅教师/管理员：指定班级"),
):
    """本周之星 + 我自己的位置（学生一律只看本班）。

    两处改动：
    1. 口径收到本班。原来学生看到的全校前 5 名 + 全校名次：一个 40 人的班，学生
       看到"第 47 名"却不知道分母，也永远挤不进别的班的刷分榜；还把其他年级学生的
       姓名班级向全校公开。本班榜才可比，也只有本班谈得上公开。
    2. 一并下发 total_students，前端能写"第 3 / 38 名"，未上榜时给诚实文案。

    榜单口径与教师端一致（activity_rewards 本周一起算、role=2 且未停用），
    只下发姓名/年级班/积分，不下发任何答题明细或答案数据。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    from backend.utils import week_range_str

    since = week_range_str()[0]   # 本周一起算，与教师端卡片同一口径

    # 学生只看本班；教师/管理员可指定年级班级（都不传则全校）
    scope_grade = ""
    class_variants: list[str] = []
    if role == 2:
        me = execute_query("SELECT grade, class FROM users WHERE username=?", (username,))
        if me:
            scope_grade = str(me[0][0] or "").strip()
            class_variants = _class_variants(str(me[0][1] or ""))
    else:
        scope_grade = (grade or "").strip()
        class_variants = _class_variants(class_name or "")

    rows = execute_query(
        """SELECT ar.student_username, u.name, u.grade, u.class,
                  COALESCE(SUM(ar.points), 0) AS pts
           FROM activity_rewards ar
           JOIN users u ON u.username = ar.student_username
            AND u.role = 2 AND IFNULL(u.status,'active') = 'active'
           WHERE substr(ar.created_at, 1, 10) >= ?
           GROUP BY ar.student_username""",
        (since,),
    ) or []
    in_scope = [r for r in rows
                if (not scope_grade or str(r[2] or "") == scope_grade)
                and (not class_variants or str(r[3] or "") in class_variants)]
    in_scope.sort(key=lambda r: (-int(r[4] or 0), str(r[1] or r[0])))
    stars = [
        {"username": r[0], "name": r[1] or r[0], "grade": r[2] or "", "class": r[3] or "",
         "points": int(r[4] or 0)}
        for r in in_scope[:5]
    ]

    # 本班/本年级在册学生数：名次要有分母，否则"第 47 名"毫无意义
    total_rows = execute_query(
        """SELECT grade, class FROM users
           WHERE role = 2 AND IFNULL(status,'active') = 'active'""", ()
    ) or []
    total_students = len([r for r in total_rows
                        if (not scope_grade or str(r[0] or "") == scope_grade)
                        and (not class_variants or str(r[1] or "") in class_variants)])

    my_week = execute_query(
        """SELECT COALESCE(SUM(points), 0) FROM activity_rewards
           WHERE student_username=? AND substr(created_at, 1, 10) >= ?""",
        (username, since),
    )
    my_week_points = int((my_week[0][0] if my_week else 0) or 0)
    my_rank = None
    if role == 2:
        my_rank = next((i + 1 for i, r in enumerate(in_scope) if str(r[0]) == username), None)
    return {
        "stars": stars,
        "my_points": int(get_student_total(username) or 0),
        "my_week_points": my_week_points,
        "my_rank": my_rank,
        "ranked_count": len(in_scope),
        "total_students": total_students,
        "scope": {"grade": scope_grade, "class": (class_variants[0] if class_variants else "")},
    }


def _class_variants(raw: str) -> list[str]:
    """班级名归一成可比集合："高一1班"/"1班"/"1" 都算同一个班；空串返回 []（不按班过滤）"""
    raw = (raw or "").strip()
    if not raw:
        return []
    digits = "".join(ch for ch in raw if ch.isdigit())
    out = [raw]
    if digits:
        out += [digits, digits + "班"]
    return list(dict.fromkeys(out))


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

    # 学生本人的徽章墙：带"还差多少"的进度
    badges = get_student_badges(username, with_progress=True)
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
