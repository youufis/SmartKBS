"""
积分奖励引擎
自动在学生参与活动后发放积分，支持参与基础分和成绩等级奖励
"""
from datetime import datetime
from typing import Any

from backend.database import execute_query, execute_insert_update
from backend.logger import logger
from backend.title_system import check_main_title_upgrade, check_and_unlock_badges

# ── 奖励配置 ──

REWARD_CONFIG = {
    # activity_type: (participation_points, has_grade_levels)
    "quiz":       {"participation": 2,  "has_grade": True},
    "poll":       {"participation": 2,  "has_grade": False},
    "question":   {"participation": 2,  "has_grade": True},   # 优质提问=优秀
    "exam":       {"participation": 2,  "has_grade": True},
    "practice":   {"participation": 2,  "has_grade": True},
    "discussion": {"participation": 2,  "has_grade": True},
    "rollcall":   {"participation": 2,  "has_grade": False},
    "chat":       {"participation": 2,  "has_grade": False},
    "task":       {"participation": 2,  "has_grade": True},
    "learning":   {"participation": 2,  "has_grade": False},
    "login":      {"participation": 1,  "has_grade": False},  # 每日登录（一天一次）
    "code":       {"participation": 2,  "has_grade": True},
    "quest":      {"participation": 1,  "has_grade": True},
    "quick_quiz": {"participation": 2,  "has_grade": True},
    "course_practice": {"participation": 2, "has_grade": True},
    "resource_view": {"participation": 1, "has_grade": False},  # 浏览共享资源（不重复）
}

GRADE_POINTS = {
    "excellent": 15,   # 优秀 >= 90%
    "good":      10,   # 良好 >= 75%
    "pass":       5,   # 及格 >= 60%
}

ACTIVITY_TYPE_NAMES = {
    "quiz":       "随堂测验",
    "poll":       "快速投票",
    "question":   "课堂提问",
    "exam":       "考试",
    "practice":   "智能练习",
    "discussion": "分组讨论",
    "rollcall":   "点名签到",
    "chat":       "AI 对话",
    "task":       "任务",
    "learning":   "学习进度",
    "login":      "每日登录",
    "code":       "代码练习",
    "quest":      "知识闯关",
    "quick_quiz": "知识抢答",
    "course_practice": "课程练习",    "resource_view":  "资源浏览",}

REWARD_TYPE_NAMES = {
    "participation": "参与基础分",
    "excellent":     "优秀奖励",
    "good":          "良好奖励",
    "pass":          "及格奖励",
}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def update_student_total(student_username: str, check_upgrade: bool = True):
    """重新计算并更新学生的积分汇总，同时检测称号升级

    Args:
        student_username: 学生用户名
        check_upgrade: 是否检测称号升级（默认开启）

    Returns:
        更新后的总积分
    """
    # 获取旧积分
    old_row = execute_query(
        "SELECT total_points FROM student_total_points WHERE student_username=?",
        (student_username,),
    )
    old_total = old_row[0][0] if old_row else 0

    row = execute_query(
        "SELECT COALESCE(SUM(points), 0) FROM activity_rewards WHERE student_username=?",
        (student_username,),
    )
    new_total = row[0][0] if row else 0

    execute_insert_update(
        "INSERT OR REPLACE INTO student_total_points (student_username, total_points, updated_at) VALUES (?, ?, ?)",
        (student_username, new_total, _now()),
    )

    # 称号升级检测
    if check_upgrade and new_total != old_total:
        upgrade = check_main_title_upgrade(student_username, old_total, new_total)
        if upgrade:
            logger.info(f"学生 {student_username} 称号升级: {upgrade['old_title']['name']} → {upgrade['new_title']['name']}")
            # AI 学伴推送称号升级通知
            try:
                from backend.companion_push import push_title_upgrade
                push_title_upgrade(student_username, upgrade['old_title']['name'], upgrade['new_title']['name'])
            except Exception:
                pass
        # 同时检测徽章
        new_badges = check_and_unlock_badges(student_username)
        if new_badges:
            logger.info(f"学生 {student_username} 解锁 {len(new_badges)} 个新徽章")

    return new_total


def deduct_points(student_username: str, reason: str, points: int = 2) -> int:
    """扣除学生积分（记录为负数 reward），返回实际扣除的分数"""
    if points <= 0:
        return 0
    now = _now()
    execute_insert_update(
        """INSERT INTO activity_rewards
           (student_username, activity_type, activity_id, activity_title, reward_type, points, reason, created_at)
           VALUES (?, ?, ?, ?, 'penalty', ?, ?, ?)""",
        (student_username, "penalty", f"{now}_{student_username}", reason, -points, reason, now),
    )
    update_student_total(student_username)
    logger.info(f"积分扣除: {student_username} {points} 分 ({reason})")
    return points


def award_participation(student_username: str, activity_type: str, activity_id: str,
                        activity_title: str = "", teacher_username: str = "") -> int:
    """发放参与基础分（2分）"""
    config = REWARD_CONFIG.get(activity_type)
    if not config:
        logger.warning(f"未知活动类型: {activity_type}")
        return 0

    points = config["participation"]
    if points <= 0:
        return 0

    # 检查是否已发放过参与奖（幂等）
    existing = execute_query(
        "SELECT id FROM activity_rewards WHERE student_username=? AND activity_type=? AND activity_id=? AND reward_type='participation'",
        (student_username, activity_type, activity_id),
    )
    if existing:
        return 0

    now = _now()
    execute_insert_update(
        """INSERT INTO activity_rewards
           (student_username, activity_type, activity_id, activity_title, reward_type, points, reason, teacher_username, created_at)
           VALUES (?, ?, ?, ?, 'participation', ?, ?, ?, ?)""",
        (student_username, activity_type, activity_id, activity_title,
         points, f"参与「{activity_title}」基础奖励",
         teacher_username, now),
    )
    update_student_total(student_username)
    logger.info(f"积分奖励: {student_username} +{points} ({activity_type}/{activity_id}) 参与奖")
    return points


def award_grade(student_username: str, activity_type: str, activity_id: str,
                score: float, total_score: float, activity_title: str = "",
                teacher_username: str = "") -> int:
    """根据成绩/得分率发放等级奖励（优秀/良好/及格）

    Args:
        score: 实际得分
        total_score: 满分
        activity_title: 活动标题（可选）

    Returns:
        发放的积分，0 表示未达到任何等级或已发放过
    """
    config = REWARD_CONFIG.get(activity_type)
    if not config or not config["has_grade"]:
        return 0

    if total_score <= 0:
        return 0

    ratio = score / total_score

    if ratio >= 0.9:
        reward_type = "excellent"
    elif ratio >= 0.75:
        reward_type = "good"
    elif ratio >= 0.6:
        reward_type = "pass"
    else:
        return 0

    points = GRADE_POINTS[reward_type]

    # 检查是否已发放过该活动的等级奖
    existing = execute_query(
        "SELECT id FROM activity_rewards WHERE student_username=? AND activity_type=? AND activity_id=? AND reward_type=?",
        (student_username, activity_type, activity_id, reward_type),
    )
    if existing:
        return 0

    # 也检查是否已获得更高级别的奖励
    higher_types = {"excellent": [], "good": ["excellent"], "pass": ["excellent", "good"]}
    for ht in higher_types.get(reward_type, []):
        higher_exists = execute_query(
            "SELECT id FROM activity_rewards WHERE student_username=? AND activity_type=? AND activity_id=? AND reward_type=?",
            (student_username, activity_type, activity_id, ht),
        )
        if higher_exists:
            return 0

    now = _now()
    pct = round(ratio * 100, 1)
    grade_name = REWARD_TYPE_NAMES.get(reward_type, reward_type)
    type_name = ACTIVITY_TYPE_NAMES.get(activity_type, activity_type)

    execute_insert_update(
        """INSERT INTO activity_rewards
           (student_username, activity_type, activity_id, activity_title, reward_type, points, reason, teacher_username, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (student_username, activity_type, activity_id, activity_title,
         reward_type, points,
         f"{type_name}「{activity_title}」{grade_name}（得分率{pct}%）",
         teacher_username, now),
    )
    update_student_total(student_username)
    logger.info(f"积分奖励: {student_username} +{points} ({activity_type}/{activity_id}) {grade_name}")
    return points


def award_daily_login(student_username: str) -> int:
    """发放每日登录奖励（1分），一天只计一次

    Args:
        student_username: 学生用户名

    Returns:
        发放的积分，0 表示今日已领取
    """
    today = datetime.now().strftime("%Y-%m-%d")
    # 检查今日是否已发放过登录奖励
    existing = execute_query(
        "SELECT id FROM activity_rewards WHERE student_username=? AND activity_type='login' AND activity_id=?",
        (student_username, today),
    )
    if existing:
        return 0

    execute_insert_update(
        """INSERT INTO activity_rewards
           (student_username, activity_type, activity_id, activity_title, reward_type, points, reason, created_at)
           VALUES (?, 'login', ?, '每日登录', 'participation', 1, ?, ?)""",
        (student_username, today,
         f"每日登录奖励（{today}）",
         _now()),
    )
    update_student_total(student_username)
    logger.info(f"积分奖励: {student_username} +1 (login/{today}) 每日登录")
    return 1


def batch_award(records: list[dict[str, Any]]) -> list[int]:
    """批量发放积分

    Args:
        records: 每个元素为 dict，包含 student_username, activity_type, activity_id,
                 activity_title, reward_type, points, reason, teacher_username
    Returns:
        每个记录实际发放的积分列表
    """
    results = []
    now = _now()
    for rec in records:
        # 检查是否已发放
        existing = execute_query(
            "SELECT id FROM activity_rewards WHERE student_username=? AND activity_type=? AND activity_id=? AND reward_type=?",
            (rec["student_username"], rec["activity_type"], rec["activity_id"], rec.get("reward_type", "participation")),
        )
        if existing:
            results.append(0)
            continue

        execute_insert_update(
            """INSERT INTO activity_rewards
               (student_username, activity_type, activity_id, activity_title, reward_type, points, reason, teacher_username, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (rec["student_username"], rec["activity_type"], rec["activity_id"],
             rec.get("activity_title", ""),
             rec.get("reward_type", "participation"),
             rec["points"], rec.get("reason", ""),
             rec.get("teacher_username", ""), now),
        )
        update_student_total(rec["student_username"])
        results.append(rec["points"])
    return results


def get_student_rewards(student_username: str, limit: int = 50,
                        activity_type: str = "") -> list[dict[str, Any]]:
    """查询学生的积分流水"""
    if activity_type:
        rows = execute_query(
            """SELECT id, activity_type, activity_id, activity_title, reward_type, points, reason, created_at
               FROM activity_rewards
               WHERE student_username=? AND activity_type=?
               ORDER BY created_at DESC LIMIT ?""",
            (student_username, activity_type, limit),
        )
    else:
        rows = execute_query(
            """SELECT id, activity_type, activity_id, activity_title, reward_type, points, reason, created_at
               FROM activity_rewards
               WHERE student_username=?
               ORDER BY created_at DESC LIMIT ?""",
            (student_username, limit),
        )
    return [
        {
            "id": r[0],
            "activity_type": r[1],
            "activity_type_name": ACTIVITY_TYPE_NAMES.get(r[1], r[1]),
            "activity_id": r[2],
            "activity_title": r[3],
            "reward_type": r[4],
            "reward_type_name": REWARD_TYPE_NAMES.get(r[4], r[4]),
            "points": r[5],
            "reason": r[6],
            "created_at": r[7],
        }
        for r in rows
    ]


def get_student_total(student_username: str) -> int:
    """获取学生总积分"""
    row = execute_query(
        "SELECT total_points FROM student_total_points WHERE student_username=?",
        (student_username,),
    )
    if row:
        return row[0][0]
    return update_student_total(student_username)


def get_class_ranking(grade: str, class_name: str = "",
                      allowed_classes: list[str] | None = None) -> list[dict[str, Any]]:
    """获取班级积分排名，支持按教师任教的班级列表过滤

    Args:
        grade: 年级
        class_name: 班级名，为空表示全年级
        allowed_classes: 教师有权限的班级列表，None 表示不过滤（管理员）
    """
    if class_name:
        # 优先使用 FK 列
        import re
        cls_nums = re.findall(r'\d+', class_name)
        cls_num = cls_nums[0] if cls_nums else class_name
        gid_rows = execute_query("SELECT id FROM grades WHERE name=?", (grade,))
        if gid_rows:
            grade_id = gid_rows[0][0]
            cid_rows = execute_query("SELECT id FROM classes WHERE grade_id=? AND (name=? OR name=?)",
                                     (grade_id, f"{cls_num}班", cls_num))
            if cid_rows:
                class_id = cid_rows[0][0]
                rows = execute_query(
                    """SELECT u.name, u.username, COALESCE(stp.total_points, 0) as points
                       FROM users u
                       LEFT JOIN student_total_points stp ON u.username = stp.student_username
                       WHERE u.role=2 AND u.grade_id=? AND u.class_id=?
                       ORDER BY points DESC""",
                    (grade_id, class_id),
                )
            else:
                rows = execute_query(
                    """SELECT u.name, u.username, COALESCE(stp.total_points, 0) as points
                       FROM users u
                       LEFT JOIN student_total_points stp ON u.username = stp.student_username
                       WHERE u.role=2 AND u.grade_id=?
                       ORDER BY points DESC""",
                    (grade_id,),
                )
        else:
            rows = execute_query(
                """SELECT u.name, u.username, COALESCE(stp.total_points, 0) as points
                   FROM users u
                   LEFT JOIN student_total_points stp ON u.username = stp.student_username
                   WHERE u.role=2 AND u.grade=? AND (u.class=? OR u.class=?)
                   ORDER BY points DESC""",
                (grade, cls_num, f"{cls_num}班"),
            )
    elif allowed_classes:
        placeholders = ",".join(["?" for _ in allowed_classes])
        rows = execute_query(
            f"""SELECT u.name, u.username, COALESCE(stp.total_points, 0) as points
               FROM users u
               LEFT JOIN student_total_points stp ON u.username = stp.student_username
               WHERE u.role=2 AND u.grade=? AND u.class IN ({placeholders})
               ORDER BY points DESC""",
            (grade, *allowed_classes),
        )
    else:
        gid_rows = execute_query("SELECT id FROM grades WHERE name=?", (grade,))
        if gid_rows:
            grade_id = gid_rows[0][0]
            rows = execute_query(
                """SELECT u.name, u.username, COALESCE(stp.total_points, 0) as points
                   FROM users u
                   LEFT JOIN student_total_points stp ON u.username = stp.student_username
                   WHERE u.role=2 AND u.grade_id=?
                   ORDER BY points DESC""",
                (grade_id,),
            )
        else:
            rows = execute_query(
                """SELECT u.name, u.username, COALESCE(stp.total_points, 0) as points
                   FROM users u
                   LEFT JOIN student_total_points stp ON u.username = stp.student_username
                   WHERE u.role=2 AND u.grade=?
                   ORDER BY points DESC""",
                (grade,),
            )
    return [
        {
            "name": r[0] or r[1],
            "username": r[1],
            "total_points": r[2],
        }
        for r in rows
    ]


def get_activity_statistics(grade: str = "", class_name: str = "",
                            start_date: str = "", end_date: str = "") -> dict[str, Any]:
    """获取积分统计数据"""
    params = []
    where = []

    # 解析年级/班级 ID
    grade_id = None
    class_id = None
    if grade:
        gid_rows = execute_query("SELECT id FROM grades WHERE name=?", (grade,))
        if gid_rows:
            grade_id = gid_rows[0][0]
    if class_name and grade_id:
        import re
        nums = re.findall(r'\d+', class_name)
        cls_num = nums[0] if nums else class_name
        cid_rows = execute_query("SELECT id FROM classes WHERE grade_id=? AND (name=? OR name=?)",
                                 (grade_id, f"{cls_num}班", cls_num))
        if cid_rows:
            class_id = cid_rows[0][0]

    if grade_id:
        where.append("u.grade_id=?")
        params.append(grade_id)
    if class_id:
        where.append("u.class_id=?")
        params.append(class_id)

    where_clause = " AND ".join(where) if where else "1=1"

    # 各类活动总积分
    rows = execute_query(
        f"""SELECT ar.activity_type, SUM(ar.points)
            FROM activity_rewards ar
            JOIN users u ON ar.student_username = u.username
            WHERE {where_clause}
            GROUP BY ar.activity_type
            ORDER BY SUM(ar.points) DESC""",
        tuple(params),
    )
    activity_breakdown = {r[0]: {"points": r[1], "name": ACTIVITY_TYPE_NAMES.get(r[0], r[0])} for r in rows}

    # 总积分
    total_row = execute_query(
        f"""SELECT COALESCE(SUM(ar.points), 0)
            FROM activity_rewards ar
            JOIN users u ON ar.student_username = u.username
            WHERE {where_clause}""",
        tuple(params),
    )
    total_points = total_row[0][0] if total_row else 0

    # 参与人数
    count_row = execute_query(
        f"""SELECT COUNT(DISTINCT ar.student_username)
            FROM activity_rewards ar
            JOIN users u ON ar.student_username = u.username
            WHERE {where_clause}""",
        tuple(params),
    )
    participant_count = count_row[0][0] if count_row else 0

    return {
        "total_points": total_points,
        "participant_count": participant_count,
        "activity_breakdown": activity_breakdown,
    }
