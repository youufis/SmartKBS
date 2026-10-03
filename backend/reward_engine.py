"""
积分奖励引擎
自动在学生参与活动后发放积分，支持参与基础分和成绩等级奖励
"""
import contextlib
import contextvars
from datetime import datetime
from typing import Any
import time

from backend.database import execute_query, execute_insert_update
from backend.logger import logger
from backend.permission_service import is_student_account
from backend.title_system import check_main_title_upgrade, check_and_unlock_badges


def _skip_non_student(username: str, scene: str) -> bool:
    """非学生账号不参与积分体系：返回 True 表示调用方应立即放弃发分/建号"""
    if is_student_account(username):
        return False
    # DEBUG 级：教师用测试账号刷一遍活动是正常运维行为，不该刷 WARN 日志
    logger.debug(f"[reward] 跳过非学生账号 {username} 的{scene}（积分/称号只属于学生）")
    return True

# ── 奖励配置 ──

REWARD_CONFIG = {
    # activity_type: (participation_points, has_grade_levels)
    "quiz":       {"participation": 2,  "has_grade": True},
    "poll":       {"participation": 2,  "has_grade": False},
    # 提问目前只有参与分: 全仓只调用过 award_participation, 等级奖从未接入
    # (旧注释"优质提问=优秀"与实际不符, 会误导维护者), 故 has_grade=False
    "question":   {"participation": 2,  "has_grade": False},
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
    "daily_discovery": {"participation": 1, "has_grade": False},  # 每日精选浏览
    "news_view": {"participation": 1, "has_grade": False},      # 热点新闻浏览
}

# ══════════════════════════════════════════════════════════════
# 每日计分上限（防刷）—— 0 表示该维度不限制
# ══════════════════════════════════════════════════════════════
#: 按活动类型限制"每人每天从这类活动最多拿多少分"
DAILY_POINTS_CAPS: dict[str, int] = {
    "chat": 10,               # AI 对话/学伴：保留"每次对话都给分"，但每人每天封顶 10 分
    "news_view": 3,           # 与 news_router 的 DAILY_POINTS_MAX 同口径（引擎再兜一道）
    "daily_discovery": 5,     # 与每日精选的 DAILY_POINTS_MAX 同口径
    "resource_view": 5,       # 资源浏览：每天最多 5 个新资源计分
}
#: 按活动类型限制"每人每天最多有几场计分"（抢答这种一场就 17 分的必须按场数控）
DAILY_SESSION_CAPS: dict[str, int] = {
    "quick_quiz": 3,
}
#: 全局每日封顶：只做"跨类型连刷"的兜底，刻意高于各分类上限之和的下界，
#: 否则它会盖掉更具体的策略（抢答 3 场就有 51 分，若这里定 40 就等于把用户定的
#: "每日 3 场"变成"每日 40 分"，两条规则互相遮蔽）
DAILY_TOTAL_POINTS_CAP = 60

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
    "course_practice": "课程练习",
    "resource_view":    "资源浏览",
    "daily_discovery":  "每日精选",
    "news_view":        "热点新闻",
}

REWARD_TYPE_NAMES = {
    "participation": "参与基础分",
    "excellent":     "优秀奖励",
    "good":          "良好奖励",
    "pass":          "及格奖励",
    "penalty":       "扣分",
    "refund":        "失败退还",
}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# 批处理上下文：非 None 时，update_student_total 只把学生记进名单，重算留到批尾
_batch_pending: contextvars.ContextVar[set[str] | None] = contextvars.ContextVar(
    "reward_batch_pending", default=None)


@contextlib.contextmanager
def batch_recompute():
    """把一段批量发分的总分/称号/徽章结算合并成批尾一次。

    抢答结算与考试批量批改是"一个班几十人 × 每人 2~3 次发放"，而每次发放默认都会
    跑一遍 SUM 重算 + 称号升级 + 徽章 facts（约 10 条 SQL）。用这个上下文后，批内
    只登记名单，批尾每人重算一次，热路径上的查询量降一个数量级。
    """
    token = _batch_pending.set(set())
    try:
        yield
    finally:
        pending = _batch_pending.get() or set()
        _batch_pending.reset(token)
        for stu in pending:
            try:
                update_student_total(stu)
            except Exception as e:
                logger.warning(f"[reward] 批量结算重算 {stu} 失败: {e}")


def _cap_int(cfg_key: str, fallback: int) -> int:
    """读上限配置；管理员可在系统配置里调，0=不限"""
    try:
        from backend.api.config_router import get_config_value
        return int(get_config_value(cfg_key, fallback))
    except Exception:
        return fallback


def daily_cap_reason(student_username: str, activity_type: str,
                     activity_id: str, points: int) -> str | None:
    """本次发放是否会突破当日上限；返回拒绝原因，None 表示可以发。

    只用于**正向发放**：扣分/退还（points<=0）永远放行，否则上限会反过来挡住回收，
    出现"活动都删了分还留着"的更坏结果。
    """
    if points <= 0:
        return None

    today = datetime.now().strftime("%Y-%m-%d")
    rows = execute_query(
        """SELECT activity_type, activity_id, COALESCE(SUM(points), 0)
           FROM activity_rewards
           WHERE student_username=? AND substr(created_at, 1, 10) = ?
           GROUP BY activity_type, activity_id""",
        (student_username, today),
    ) or []

    per_type: dict[str, int] = {}
    sessions: dict[str, set[str]] = {}
    total_today = 0
    for atype, aid, pts in rows:
        pts = int(pts or 0)
        per_type[atype] = per_type.get(atype, 0) + pts
        sessions.setdefault(atype, set()).add(str(aid))
        total_today += pts

    cap_total = _cap_int("REWARD_DAILY_TOTAL_POINTS", DAILY_TOTAL_POINTS_CAP)
    if cap_total > 0 and total_today + points > cap_total:
        return f"今日累计积分已达上限 {cap_total} 分"

    cap_points = DAILY_POINTS_CAPS.get(activity_type, 0)
    if activity_type == "chat":
        cap_points = _cap_int("REWARD_DAILY_CHAT_POINTS", DAILY_POINTS_CAPS["chat"])
    if cap_points > 0 and per_type.get(activity_type, 0) + points > cap_points:
        return f"「{ACTIVITY_TYPE_NAMES.get(activity_type, activity_type)}」今日已达上限 {cap_points} 分"

    cap_sessions = DAILY_SESSION_CAPS.get(activity_type, 0)
    if activity_type == "quick_quiz":
        cap_sessions = _cap_int("REWARD_DAILY_QUIZ_SESSIONS", DAILY_SESSION_CAPS["quick_quiz"])
    if cap_sessions > 0:
        seen = sessions.get(activity_type, set())
        if str(activity_id) not in seen and len(seen) >= cap_sessions:
            return f"今日计分场次已达上限 {cap_sessions} 场"
    return None


def _purge_non_student_rows(username: str) -> None:
    """清掉非学生账号在学生荣誉四表里的残留行（幂等，只在真的存在时才动手）"""
    if not username:
        return
    tables = ("student_total_points", "student_titles", "student_badges",
              "student_subject_titles")
    hit = False
    for table in tables:
        try:
            rows = execute_query(f"SELECT 1 FROM {table} WHERE student_username=? LIMIT 1",
                                 (username,))
            if rows:
                execute_insert_update(f"DELETE FROM {table} WHERE student_username=?", (username,))
                hit = True
        except Exception as e:
            logger.warning(f"[reward] 清理 {username} 在 {table} 的残留行失败: {e}")
    if hit:
        _cache_invalidate(username)
        logger.info(f"[reward] 已清理非学生账号 {username} 在学生荣誉表里的残留行")


def _skip_by_daily_cap(student_username: str, activity_type: str, activity_id: str,
                       points: int, reward_type: str) -> bool:
    reason = daily_cap_reason(student_username, activity_type, activity_id, points)
    if reason:
        # DEBUG：这是设计中的止损，不是故障；刷 WARN 会把日志淹掉
        logger.debug(f"[reward] {student_username} {activity_type}/{activity_id} {reward_type} 未发放：{reason}")
        return True
    return False


def update_student_total(student_username: str, check_upgrade: bool = True):
    """重新计算并更新学生的积分汇总，同时检测称号升级

    Args:
        student_username: 学生用户名
        check_upgrade: 是否检测称号升级（默认开启）

    Returns:
        更新后的总积分
    """
    # 守卫：这里是 student_total_points / 称号 / 徽章 唯一的写入口，
    # 挡住非学生就不会再出现"管理员有称号、教师有徽章"的脏数据。
    # 顺手自愈：把非学生账号在这些表里的历史残留行清掉，这样系统自己就能收敛，
    # 不必每次靠人工跑 scripts/reset_non_student_rewards.py。
    if _skip_non_student(student_username, "总分汇总"):
        _purge_non_student_rows(student_username)
        return 0

    pending = _batch_pending.get()
    if pending is not None:
        # 批处理中：只登记，批尾统一重算（返回值用当前已知的汇总值）
        pending.add(student_username)
        row = execute_query(
            "SELECT total_points FROM student_total_points WHERE student_username=?",
            (student_username,),
        )
        return int(row[0][0] or 0) if row else 0

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
    new_total = int(row[0][0] or 0) if row else 0

    # R12: UPSERT 只更新分数与时间, 不再整行替换
    execute_insert_update(
        """INSERT INTO student_total_points (student_username, total_points, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(student_username) DO UPDATE SET total_points=excluded.total_points, updated_at=excluded.updated_at""",
        (student_username, new_total, _now()),
    )
    _cache_invalidate(student_username)   # R7: 总分变化必须让 30s 读缓存失效

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
    if _skip_non_student(student_username, "扣分"):
        return 0
    points = int(min(points, max(get_student_total(student_username), 0)))   # R7: 不为负
    if points <= 0:
        logger.info(f"积分扣除跳过: {student_username} 可用积分为 0 ({reason})")
        return 0
    now = _now()
    execute_insert_update(
        """INSERT INTO activity_rewards
           (student_username, activity_type, activity_id, activity_title, reward_type, points, reason, created_at)
           VALUES (?, ?, ?, ?, 'penalty', ?, ?, ?)""",
        (student_username, "penalty", f"{now}_{student_username}", reason, -points, reason, now),
    )
    update_student_total(student_username)
    logger.info(f"积分扣除: {student_username} -{points} 分 ({reason})")
    return points


def refund_points(student_username: str, points: int, reason: str = "失败退还",
                  activity_id: str = "") -> int:
    """兑换类操作失败时的冲正：写一条正向 refund 流水，保持账目可追溯。

    此前只有 portrait_router 直接 INSERT activity_rewards（绕过引擎），是唯一的
    旁路写入口 —— 守卫、幂等、批量重算全都管不到它。收进来后统一走这条路。
    """
    if points <= 0:
        return 0
    if _skip_non_student(student_username, "积分退还"):
        return 0
    now = _now()
    aid = activity_id or f"refund_{int(time.time() * 1000)}_{student_username}"
    execute_insert_update(
        """INSERT OR IGNORE INTO activity_rewards
           (student_username, activity_type, activity_id, activity_title, reward_type, points, reason, created_at)
           VALUES (?, 'refund', ?, '积分退还', 'refund', ?, ?, ?)""",
        (student_username, aid, int(points), reason, now),
    )
    update_student_total(student_username)
    logger.info(f"积分退还: {student_username} +{points} ({reason})")
    return int(points)


def award_participation(student_username: str, activity_type: str, activity_id: str,
                        activity_title: str = "", teacher_username: str = "") -> int:
    """发放参与基础分（2分）"""
    if _skip_non_student(student_username, "参与奖"):
        return 0
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

    if _skip_by_daily_cap(student_username, activity_type, activity_id, points, "参与奖"):
        return 0

    now = _now()
    # 先查后插并非原子：并发双击/前端重试会插进两行。唯一索引
    # uq_ar_student_key 是真正的兜底，这里配 OR IGNORE 让重复插入安静失败
    execute_insert_update(
        """INSERT OR IGNORE INTO activity_rewards
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
    if _skip_non_student(student_username, "等级奖"):
        return 0
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

    pct = round(ratio * 100, 1)
    grade_name = REWARD_TYPE_NAMES.get(reward_type, reward_type)
    type_name = ACTIVITY_TYPE_NAMES.get(activity_type, activity_type)

    if _skip_by_daily_cap(student_username, activity_type, activity_id, points, grade_name):
        return 0

    now = _now()

    execute_insert_update(
        """INSERT OR IGNORE INTO activity_rewards
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
    # 登录奖励过去连"探测账号/不存在的账号"都照发（库里留下 __probe_login__ 等幽灵行）
    if _skip_non_student(student_username, "每日登录奖"):
        return 0
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
        if _skip_non_student(rec.get("student_username", ""), "批量发放"):
            results.append(0)
            continue
        if _skip_by_daily_cap(rec.get("student_username", ""), rec.get("activity_type", ""),
                              str(rec.get("activity_id", "")), int(rec.get("points", 0) or 0),
                              rec.get("reward_type", "participation")):
            results.append(0)
            continue
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


# 积分缓存：避免高频重复查询
_student_total_cache: dict[str, tuple[float, int]] = {}
_STUDENT_TOTAL_CACHE_TTL = 30


def _cache_invalidate(student_username: str) -> None:
    """R7: 积分变动后清读缓存, 否则 30 秒窗口内会按旧余额重复兑换/误判不足"""
    _student_total_cache.pop(student_username, None)


def _cache_put(student_username: str, total: int) -> None:
    if len(_student_total_cache) > 3000:      # 防止长期运行内存无上限
        _student_total_cache.clear()
    _student_total_cache[student_username] = (time.time(), total)


def activity_reward_students(pairs) -> list[str]:
    """删除某活动的积分流水**之前**，先记下会受影响的学生名单。

    pairs: [(activity_type, activity_id), ...]。`activity_rewards.activity_id` 是 TEXT，
    统一转字符串比较，与各删除端点保持同一口径（否则 SQLite 不做隐式转换会静默漏删/漏算）。
    """
    norm = [(str(t), str(i)) for t, i in pairs if i is not None and str(i) != ""]
    if not norm:
        return []
    where = " OR ".join(["(activity_type=? AND activity_id=?)"] * len(norm))
    args = [v for pair in norm for v in pair]
    rows = execute_query(
        f"SELECT DISTINCT student_username FROM activity_rewards WHERE {where}", tuple(args)) or []
    return [r[0] for r in rows if r[0]]


def recompute_students(students) -> int:
    """按名单重算总积分。

    `check_upgrade=False`：删除/重置这类回收动作不应反向触发称号与徽章变化
    （荣誉只升不降），与活动重置 service 同一口径；纯增量发放仍走 update_student_total 默认值。
    """
    done = 0
    for stu in students or []:
        try:
            update_student_total(stu, check_upgrade=False)
            done += 1
        except Exception as e:
            logger.warning(f"[积分重算] {stu} 失败: {e}")
    return done


def reconcile_student_totals(auto_fix: bool = True) -> dict[str, Any]:
    """R6: 对账 student_total_points 与 activity_rewards 真实合计。

    删除考试/练习/题目会连带删掉奖励流水, 但没人重算汇总, 排行榜会长期虚高。
    此函数幂等, 由日志保留任务每日调用。
    """
    rows = execute_query(
        "SELECT student_username, COALESCE(SUM(points), 0) FROM activity_rewards GROUP BY student_username"
    ) or []
    real = {r[0]: int(r[1] or 0) for r in rows if r[0]}
    cached = {r[0]: int(r[1] or 0) for r in (execute_query(
        "SELECT student_username, total_points FROM student_total_points") or [])}

    mismatch = [(u, cached.get(u, 0), t) for u, t in real.items() if cached.get(u, 0) != t]
    orphan = [(u, c, 0) for u, c in cached.items() if u not in real]
    if auto_fix:
        for u, _old, _new in mismatch + orphan:
            try:
                update_student_total(u, check_upgrade=False)
            except Exception as e:
                logger.warning(f"[reconcile] 重算 {u} 总分失败: {e}")
    return {
        "checked": len(real) + len(orphan),
        "mismatch": len(mismatch),
        "orphan": len(orphan),
        "samples": (mismatch + orphan)[:5],
        "fixed": bool(auto_fix),
    }


def get_student_total(student_username: str) -> int:
    """获取学生总积分（带 30 秒缓存）"""
    now = time.time()
    cached = _student_total_cache.get(student_username)
    if cached and (now - cached[0]) < _STUDENT_TOTAL_CACHE_TTL:
        return cached[1]
    row = execute_query(
        "SELECT total_points FROM student_total_points WHERE student_username=?",
        (student_username,),
    )
    if row:
        total = int(row[0][0] or 0)
        _cache_put(student_username, total)
        return total
    total = update_student_total(student_username)
    _cache_put(student_username, total)
    return total


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
        if allowed_classes is not None and str(cls_num) not in [str(x) for x in allowed_classes]:
            # R4: 越权班级直接返回空, 不泄露排名
            logger.warning(f"[ranking] 请求了非授权班级 {cls_num}, 已返回空列表")
            return []
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
                       WHERE u.role=2 AND IFNULL(u.status,'active')='active' AND u.grade_id=? AND u.class_id=?
                       ORDER BY points DESC""",
                    (grade_id, class_id),
                )
            else:
                rows = execute_query(
                    """SELECT u.name, u.username, COALESCE(stp.total_points, 0) as points
                       FROM users u
                       LEFT JOIN student_total_points stp ON u.username = stp.student_username
                       WHERE u.role=2 AND IFNULL(u.status,'active')='active' AND u.grade_id=?
                       ORDER BY points DESC""",
                    (grade_id,),
                )
        else:
            rows = execute_query(
                """SELECT u.name, u.username, COALESCE(stp.total_points, 0) as points
                   FROM users u
                   LEFT JOIN student_total_points stp ON u.username = stp.student_username
                   WHERE u.role=2 AND IFNULL(u.status,'active')='active' AND u.grade=? AND (u.class=? OR u.class=?)
                   ORDER BY points DESC""",
                (grade, cls_num, f"{cls_num}班"),
            )
    elif allowed_classes is not None:
        if not allowed_classes:
            return []              # 教师无任何授权班级 → 不给全校数据
        placeholders = ",".join(["?" for _ in allowed_classes])
        rows = execute_query(
            f"""SELECT u.name, u.username, COALESCE(stp.total_points, 0) as points
               FROM users u
               LEFT JOIN student_total_points stp ON u.username = stp.student_username
               WHERE u.role=2 AND IFNULL(u.status,'active')='active' AND u.grade=? AND u.class IN ({placeholders})
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
                   WHERE u.role=2 AND IFNULL(u.status,'active')='active' AND u.grade_id=?
                   ORDER BY points DESC""",
                (grade_id,),
            )
        else:
            rows = execute_query(
                """SELECT u.name, u.username, COALESCE(stp.total_points, 0) as points
                   FROM users u
                   LEFT JOIN student_total_points stp ON u.username = stp.student_username
                   WHERE u.role=2 AND IFNULL(u.status,'active')='active' AND u.grade=?
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
