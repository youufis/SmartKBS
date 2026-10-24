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

# ── 奖励配置（学生端「积分规则」的唯一真相，前端不再手抄一份）──────────────
#
# 一种活动一行，四个维度决定学生实际拿到什么：
#   participation 参与基础分：做这件事就给的保底分，与对错无关
#   weight        等级奖权重：基准档（优秀 15 / 良好 10 / 及格 5）× 权重 = 该活动的等级奖；
#                 None = 没有标准答案，不发等级奖（投票/浏览/对话/登录）
#   pool          计入哪个每日额度池（防刷上限按池生效，见 DAILY_POOL_CAPS）
#   points_cap    该活动自身的每日积分上限；session_cap 每日计分场次数上限
#
# 权重按「耗时 × 有无标准答案 × 能否作弊」定档：期末考试 1.0 > 随堂测验/作业/练习/
# 代码 0.6 > 抽问/闯关/讨论/提问 0.4。抢答不用权重，走单独的名次奖表——一场 30 秒
# 的活动不该和一场 40 分钟的考试同分（旧口径两者都是 2+15=17，实测被抢答刷穿榜单）。
#
# 本次补齐的活动（以前只进教师手动账 scores，学生积分账 activity_rewards 为空）：
#   class_drill 课堂抽问、class_ladder 课堂闯关、wrong_book 错题订正、
#   share 资源分享、showcase 作品上墙，以及 rollcall「答对」的质量奖。
POOL_ACADEMIC = "academic"
POOL_CLASS = "class"
POOL_FUN = "fun"

REWARD_CONFIG: dict[str, dict[str, Any]] = {
    # ── 学术：教师布置、耗时、有标准答案 ──
    "quiz":            {"name": "随堂测验", "participation": 2, "weight": 0.6, "pool": POOL_ACADEMIC},
    "exam":            {"name": "考试",     "participation": 3, "weight": 1.0, "pool": POOL_ACADEMIC},
    "practice":        {"name": "同步练习", "participation": 2, "weight": 0.6, "pool": POOL_ACADEMIC},
    "course_practice": {"name": "课程练习", "participation": 2, "weight": 0.6, "pool": POOL_ACADEMIC},
    "task":            {"name": "任务",     "participation": 3, "weight": 0.6, "pool": POOL_ACADEMIC},
    "code":            {"name": "代码练习", "participation": 2, "weight": 0.6, "pool": POOL_ACADEMIC},
    "quest":           {"name": "知识闯关", "participation": 1, "weight": 0.4, "pool": POOL_ACADEMIC},

    # ── 课堂参与：现场发生、量大，单次价值有限 ──
    "rollcall":        {"name": "点名签到", "participation": 1, "weight": 0.4, "pool": POOL_CLASS},
    "class_drill":     {"name": "课堂抽问", "participation": 1, "weight": 0.4, "pool": POOL_CLASS},
    "class_ladder":    {"name": "课堂闯关", "participation": 2, "weight": 0.4, "pool": POOL_CLASS},
    "question":        {"name": "课堂提问", "participation": 2, "weight": 0.4, "pool": POOL_CLASS},
    "discussion":      {"name": "分组讨论", "participation": 2, "weight": 0.4, "pool": POOL_CLASS, "points_cap": 10},
    "poll":            {"name": "快速投票", "participation": 2, "weight": None, "pool": POOL_CLASS},
    "learning":        {"name": "学习进度", "participation": 2, "weight": None, "pool": POOL_CLASS, "points_cap": 10},
    "login":           {"name": "每日登录", "participation": 1, "weight": None, "pool": POOL_CLASS},
    "wrong_book":      {"name": "错题订正", "participation": 1, "weight": None, "pool": POOL_CLASS, "points_cap": 5},

    # ── 轻量娱乐：刷得动，必须封顶 ──
    "quick_quiz":      {"name": "知识抢答", "participation": 2, "weight": None, "pool": POOL_FUN, "session_cap": 3},
    "chat":            {"name": "AI 对话",  "participation": 2, "weight": None, "pool": POOL_FUN, "points_cap": 10},
    "resource_view":   {"name": "资源浏览", "participation": 1, "weight": None, "pool": POOL_FUN, "points_cap": 5},
    "daily_discovery": {"name": "每日精选", "participation": 1, "weight": None, "pool": POOL_FUN, "points_cap": 5},
    "news_view":       {"name": "热点新闻", "participation": 1, "weight": None, "pool": POOL_FUN, "points_cap": 3},
}

#: 不是「活动」的流水种类：只出现在明细里，不参与规则展示，也不算进「全能选手」
NON_ACTIVITY_TYPES = {"penalty": "纠错扣分", "refund": "积分退还", "spend": "积分消费"}

#: 历史/教师侧键名：只给流水做中文显示，不进「积分规则」表。
#: share 资源分享、showcase 作品上墙都由教师发起（学生既不能共享资源、也不能自建展示卡），
#: 当成学生活动去宣传会误导；但清理路径和历史数据里确实有这两个键，显示不能漏。
LEGACY_TYPE_NAMES = {"share": "资源分享", "showcase": "作品上墙"}

# ══════════════════════════════════════════════════════════════
# 每日计分上限（防刷）—— 0 表示该维度不限制
# ══════════════════════════════════════════════════════════════
#: 分池上限。旧版只有一条「每日总上限 60」，结果抢答 3 场就有 51 分，学生再认真考
#: 一场试，+15 会被总上限静默吞掉——防刷规则反过来惩罚认真学习的人。现在按池走：
#: 刷得再狠也只冲得满娱乐池，学术与课堂参与各有自己的额度，互不挤占。
DAILY_POOL_CAPS: dict[str, int] = {
    POOL_ACADEMIC: 80,   # ≈ 考试/测验/练习/作业/代码/课程练习/闯关各做满一次
    POOL_CLASS: 40,      # 点名+抽问+闯关+提问+讨论的正常一天课堂用量
    POOL_FUN: 30,        # 必须高于"抢答刷满 3 场"(3×8=24)，否则又变成遮蔽场次规则的旧问题
}
#: 池 → 系统配置键（管理员可调，0=不限）
POOL_CAP_CONFIG_KEYS = {
    POOL_ACADEMIC: "REWARD_DAILY_ACADEMIC_POINTS",
    POOL_CLASS: "REWARD_DAILY_CLASS_POINTS",
    POOL_FUN: "REWARD_DAILY_FUN_POINTS",
}
POOL_NAMES = {POOL_ACADEMIC: "学术", POOL_CLASS: "课堂参与", POOL_FUN: "轻量娱乐"}

#: 兼容旧引用与既有测试：由 REWARD_CONFIG 派生，不再手维护第二份表
DAILY_POINTS_CAPS: dict[str, int] = {t: c["points_cap"] for t, c in REWARD_CONFIG.items() if c.get("points_cap")}
DAILY_SESSION_CAPS: dict[str, int] = {t: c["session_cap"] for t, c in REWARD_CONFIG.items() if c.get("session_cap")}
#: 跨池总兜底：默认 0（不限）。三池之和已经收紧，这条只给「新加活动还没分池」兜底。
#: 注意：管理员把 REWARD_DAILY_TOTAL_POINTS 从旧的 60 改成非 0 时，它会盖过分池规则。
DAILY_TOTAL_POINTS_CAP = 0
TOTAL_CAP_CONFIG_KEY = "REWARD_DAILY_TOTAL_POINTS"

#: 等级奖基准档（考试口径 = 权重 1.0）；实际得分 = round(基准 × 权重)，最低 1 分
GRADE_POINTS = {"excellent": 15, "good": 10, "pass": 5}
#: 得分率达标线（优秀 ≥90% / 良好 ≥75% / 及格 ≥60%）
GRADE_THRESHOLDS = {"excellent": 0.9, "good": 0.75, "pass": 0.6}

#: 抢答名次奖表：名次直接决定得分。旧实现把名次硬塞成「得分率 100%/85%/75%」去套
#: 通用档位，既写出逐字错误的文案（答对 6/15 也说「得分率100.0%」），又让第 2~5 名
#: 同为 +10，把名次差抹平了。
QUICK_QUIZ_RANK_BONUS: dict[int, tuple[str, int]] = {
    1: ("excellent", 6),
    2: ("good", 5),
    3: ("good", 4),
    4: ("pass", 3),
    5: ("pass", 3),
}
#: 第 6 名以后、本场答对过题：象征性鼓励，别让陪跑一无所获
QUICK_QUIZ_CONSOLATION: tuple[str, int] = ("pass", 1)

ACTIVITY_TYPE_NAMES: dict[str, str] = {t: c["name"] for t, c in REWARD_CONFIG.items()}
ACTIVITY_TYPE_NAMES.update(NON_ACTIVITY_TYPES)
ACTIVITY_TYPE_NAMES.update(LEGACY_TYPE_NAMES)
#: 算「参与过」的活动集合（不含扣分/退还/消费，否则「全能选手」永远不可达）
ACTIVITY_KEYS = tuple(REWARD_CONFIG)

REWARD_TYPE_NAMES = {
    "participation": "参与基础分",
    "excellent":     "优秀奖励",
    "good":          "良好奖励",
    "pass":          "及格奖励",
    "penalty":       "纠错扣分",
    "refund":        "失败退还",
    "spend":         "积分消费",
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


def _pool_of(activity_type: str) -> str:
    """活动计入哪个每日额度池；未登记的新类型一律先按课堂参与池对待（不会失控）"""
    return (REWARD_CONFIG.get(activity_type) or {}).get("pool") or POOL_CLASS


def _points_cap_of(activity_type: str) -> int:
    """该活动自身的每日积分上限：系统配置优先于规则表，0=不限"""
    table_cap = int((REWARD_CONFIG.get(activity_type) or {}).get("points_cap") or 0)
    # chat 沿用管理员早已认识的旧键；其余类型可用 REWARD_POINTS_CAP_<TYPE> 覆盖
    key = "REWARD_DAILY_CHAT_POINTS" if activity_type == "chat"         else "REWARD_POINTS_CAP_" + activity_type.upper()
    return _cap_int(key, table_cap)


def _session_cap_of(activity_type: str) -> int:
    """该活动每日计分场次数上限：系统配置优先于规则表，0=不限"""
    table_cap = int((REWARD_CONFIG.get(activity_type) or {}).get("session_cap") or 0)
    key = "REWARD_DAILY_QUIZ_SESSIONS" if activity_type == "quick_quiz"         else "REWARD_SESSION_CAP_" + activity_type.upper()
    return _cap_int(key, table_cap)


def daily_points_cap(activity_type: str) -> int:
    """对外暴露"该活动每日积分上限"（含系统配置覆盖，0=不限）。

    页面进度条上的"今日 x/y 分"必须和引擎判定用的是同一个数：以前 news_router /
    daily_discovery_router 各自写死一份常量，管理员在引擎侧调上限，界面还在按旧值显示。
    """
    return _points_cap_of(activity_type)


def _pool_cap_of(pool: str) -> int:
    return _cap_int(POOL_CAP_CONFIG_KEYS[pool], DAILY_POOL_CAPS.get(pool, 0))


# ── 上限触发的可见反馈 ──────────────────────────────────────────
#: 引擎静默拒绝是这套体系最伤体验的地方：学生做完了事、积分没动、界面毫无反应，
#: 只能靠猜。这里记下每人当日最后一次"被哪条上限挡住"，由 my-daily-status 带回前端。
_cap_notices: dict[str, tuple[str, str]] = {}


def _remember_cap_notice(student_username: str, reason: str) -> None:
    if len(_cap_notices) > 3000:          # 长跑内存兜底
        _cap_notices.clear()
    _cap_notices[student_username] = (datetime.now().strftime("%Y-%m-%d"), reason)


def get_cap_notice(student_username: str) -> str:
    """今天的最后一次拒绝原因；跨天自动失效（进程重启则丢失，属尽力而为的提示）"""
    rec = _cap_notices.get(student_username)
    if not rec or rec[0] != datetime.now().strftime("%Y-%m-%d"):
        return ""
    return rec[1]


def daily_cap_reason(student_username: str, activity_type: str,
                     activity_id: str, points: int) -> str | None:
    """本次发放是否会突破当日上限；返回拒绝原因，None 表示可以发。

    只用于**正向发放**：扣分/退还/消费（points<=0）永远放行，否则上限会反过来挡住
    回收，出现"活动都删了分还留着"的更坏结果。

    两处口径修正：
    - 额度只按正向得分累计。旧口径把扣分也算进"今日已得"，等于扣一次分就能多刷一次。
    - 上限按池生效（学术 / 课堂参与 / 轻量娱乐），判序由具体到笼统：
      单活动上限 → 单活动场次上限 → 所在池额度 → 跨池总兜底。
      这样"抢答刷满"只会冲顶娱乐池，不会再吞掉认真考试的等级奖。
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
    per_pool: dict[str, int] = {}
    sessions: dict[str, set[str]] = {}
    total_today = 0
    for atype, aid, pts in rows:
        pts = int(pts or 0)
        # 场次集合按全部流水算（含补发），额度只数正向分
        sessions.setdefault(atype, set()).add(str(aid))
        if pts > 0:
            per_type[atype] = per_type.get(atype, 0) + pts
            pool = _pool_of(atype)
            per_pool[pool] = per_pool.get(pool, 0) + pts
            total_today += pts

    name = ACTIVITY_TYPE_NAMES.get(activity_type, activity_type)

    cap_points = _points_cap_of(activity_type)
    if cap_points > 0 and per_type.get(activity_type, 0) + points > cap_points:
        return f"「{name}」今日已达上限 {cap_points} 分"

    cap_sessions = _session_cap_of(activity_type)
    if cap_sessions > 0:
        seen = sessions.get(activity_type, set())
        if str(activity_id) not in seen and len(seen) >= cap_sessions:
            return f"「{name}」今日计分场次已达上限 {cap_sessions} 场"

    pool = _pool_of(activity_type)
    cap_pool = _pool_cap_of(pool)
    if cap_pool > 0 and per_pool.get(pool, 0) + points > cap_pool:
        return f"今日「{POOL_NAMES.get(pool, pool)}」类积分已达上限 {cap_pool} 分"

    cap_total = _cap_int(TOTAL_CAP_CONFIG_KEY, DAILY_TOTAL_POINTS_CAP)
    if cap_total > 0 and total_today + points > cap_total:
        return f"今日累计积分已达上限 {cap_total} 分"
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
        _remember_cap_notice(student_username, reason)
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
    # weight=None 就是"这个活动没有对错，不发等级奖"（取代旧字段 has_grade，
    # 旧字段与真实发分行为对不上：discussion 标着有等级奖、全仓却没有一处 award_grade）
    if not config or config.get("weight") is None:
        return 0

    if total_score <= 0:
        return 0

    ratio = score / total_score

    if ratio >= GRADE_THRESHOLDS["excellent"]:
        reward_type = "excellent"
    elif ratio >= GRADE_THRESHOLDS["good"]:
        reward_type = "good"
    elif ratio >= GRADE_THRESHOLDS["pass"]:
        reward_type = "pass"
    else:
        return 0

    points = grade_bonus_points(activity_type, reward_type)
    if points <= 0:
        return 0

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


def grade_bonus_points(activity_type: str, reward_type: str) -> int:
    """该活动该档位的等级奖分值 = 基准档 × 活动权重（四舍五入，最低 1 分）

    基准档只有考试口径是满额：优秀 15 / 良好 10 / 及格 5（权重 1.0）。
    随堂测验/作业/练习/代码 0.6 → 9/6/3；抽问/闯关/讨论/提问 0.4 → 6/4/2。
    """
    base = int(GRADE_POINTS.get(reward_type) or 0)
    cfg = REWARD_CONFIG.get(activity_type) or {}
    weight = cfg.get("weight")
    if not base or weight is None:
        return 0
    return max(1, int(round(base * float(weight))))


def award_bonus(student_username: str, activity_type: str, activity_id: str,
                reward_type: str, points: int = 0, activity_title: str = "",
                reason: str = "", teacher_username: str = "",
                allow_downgrade: bool = False) -> int:
    """发一笔"档位奖"，分值按活动权重取默认值，或直接指定 points。

    award_grade 走的是"得分率→档位"的路子；抢答按名次、点名/抽问按对错、
    教师认可按"优质"评级，都没有得分率可言，就从这里进。
    仍然经过同一套守卫、幂等、上限与重算，杜绝旁路写账。

    Args:
        reward_type: excellent / good / pass
        points: 0 = 用该活动的权重换算；>0 = 显式分值（如抢答名次奖表）
        allow_downgrade: 默认 False —— 同一活动已发过更高等级的档，就不再补低档
    """
    if _skip_non_student(student_username, "档位奖"):
        return 0
    if reward_type not in GRADE_POINTS:
        logger.warning(f"未知档位 {reward_type}，放弃发放 ({activity_type}/{activity_id})")
        return 0

    earned = int(points) if int(points) > 0 else grade_bonus_points(activity_type, reward_type)
    if earned <= 0:
        return 0

    # 幂等 + 不降级：同一活动的同一档位只发一次，且已拿过更高档位不再补低档
    existing = execute_query(
        "SELECT id FROM activity_rewards WHERE student_username=? AND activity_type=? AND activity_id=? AND reward_type=?",
        (student_username, activity_type, activity_id, reward_type),
    )
    if existing:
        return 0
    order = ["pass", "good", "excellent"]
    if not allow_downgrade:
        rank = order.index(reward_type)
        for ht in order[rank + 1:]:
            if execute_query(
                "SELECT id FROM activity_rewards WHERE student_username=? AND activity_type=? AND activity_id=? AND reward_type=?",
                (student_username, activity_type, activity_id, ht)):
                return 0

    grade_name = REWARD_TYPE_NAMES.get(reward_type, reward_type)
    type_name = ACTIVITY_TYPE_NAMES.get(activity_type, activity_type)
    if _skip_by_daily_cap(student_username, activity_type, activity_id, earned, grade_name):
        return 0

    now = _now()
    text = reason or (f"{type_name}「{activity_title}」{grade_name}" if activity_title
                      else f"{type_name} {grade_name}")
    execute_insert_update(
        """INSERT OR IGNORE INTO activity_rewards
           (student_username, activity_type, activity_id, activity_title, reward_type, points, reason, teacher_username, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (student_username, activity_type, activity_id, activity_title,
         reward_type, earned, text, teacher_username, now),
    )
    update_student_total(student_username)
    logger.info(f"积分奖励: {student_username} +{earned} ({activity_type}/{activity_id}) {grade_name}")
    return earned


def award_quality(student_username: str, activity_type: str, activity_id: str,
                  tier: str, activity_title: str = "", teacher_username: str = "") -> int:
    """教师认可通道：把"提问提得好 / 讨论发言有价值 / 回答被批通过"折算成积分。

    这套体系原来只有"参与就有 2 分"和"考试按得分率给档"，答得好与答得一样差
    在积分上看不出区别，教师没有正向手段。tier 复用等级奖三档，分值按活动权重。
    """
    if tier not in GRADE_POINTS:
        return 0
    return award_bonus(student_username, activity_type, activity_id, tier,
                       activity_title=activity_title, teacher_username=teacher_username)


def spend_points(student_username: str, points: int, reason: str,
                 activity_id: str = "", activity_title: str = "") -> int:
    """积分消费（兑换 AI 画像这类"花掉积分"的行为），写成 reward_type='spend'。

    这笔账以前走 deduct_points，学生明细里显示成「扣分」——花 100 分兑一张画像，
    读起来像被罚了 100 分。消费与违纪必须分账，家长和学生才不会误读。
    """
    if _skip_non_student(student_username, "积分消费"):
        return 0
    points = int(min(points, max(get_student_total(student_username), 0)))
    if points <= 0:
        logger.info(f"积分消费跳过: {student_username} 可用积分为 0 ({reason})")
        return 0
    now = _now()
    aid = activity_id or f"spend_{int(time.time() * 1000)}_{student_username}"
    execute_insert_update(
        """INSERT INTO activity_rewards
           (student_username, activity_type, activity_id, activity_title, reward_type, points, reason, created_at)
           VALUES (?, 'spend', ?, ?, 'spend', ?, ?, ?)""",
        (student_username, aid, activity_title or "积分消费", -points, reason, now),
    )
    update_student_total(student_username)
    logger.info(f"积分消费: {student_username} -{points} ({reason})")
    return points


def rules_payload() -> dict[str, Any]:
    """学生端「积分规则」的数据源（前端不再手抄第二份，就不会再出现说明与发分不一致）

    返回：活动分表（含权重换算出的三档等级奖）+ 达标线 + 生效中的每日上限 + 非活动口径。
    """
    activities = []
    for key, cfg in REWARD_CONFIG.items():
        w = cfg.get("weight")
        activities.append({
            "type": key,
            "name": cfg["name"],
            "participation": cfg["participation"],
            "weight": w,
            "grade": None if w is None else {
                tier: grade_bonus_points(key, tier) for tier in ("excellent", "good", "pass")
            },
            "pool": cfg.get("pool", POOL_CLASS),
            "points_cap": int(cfg.get("points_cap") or 0),
            "session_cap": int(cfg.get("session_cap") or 0),
        })
    return {
        "activities": activities,
        "grade_thresholds": GRADE_THRESHOLDS,
        "pools": [
            {"key": p, "name": POOL_NAMES[p], "cap": _pool_cap_of(p)}
            for p in (POOL_ACADEMIC, POOL_CLASS, POOL_FUN)
        ],
        "total_cap": _cap_int(TOTAL_CAP_CONFIG_KEY, DAILY_TOTAL_POINTS_CAP),
        "session_caps": {t: _session_cap_of(t) for t in REWARD_CONFIG if _session_cap_of(t) > 0},
        "rank_bonus": {str(k): {"reward_type": v[0], "points": v[1]}
                       for k, v in QUICK_QUIZ_RANK_BONUS.items()},
        "rank_consolation": {"reward_type": QUICK_QUIZ_CONSOLATION[0],
                             "points": QUICK_QUIZ_CONSOLATION[1]},
        "non_activity": dict(NON_ACTIVITY_TYPES),
        "reward_type_names": dict(REWARD_TYPE_NAMES),
    }


def my_daily_status(student_username: str) -> dict[str, Any]:
    """今日各池/各活动已经拿了多少、上限是多少、最后一次被挡住的原因。"""
    today = datetime.now().strftime("%Y-%m-%d")
    rows = execute_query(
        """SELECT activity_type, COALESCE(SUM(CASE WHEN points > 0 THEN points ELSE 0 END), 0),
                  COUNT(DISTINCT activity_id)
           FROM activity_rewards
           WHERE student_username=? AND substr(created_at, 1, 10) = ?
           GROUP BY activity_type""",
        (student_username, today),
    ) or []
    per_type = {r[0]: int(r[1] or 0) for r in rows}
    per_pool: dict[str, int] = {}
    for atype, pts in per_type.items():
        p = _pool_of(atype)
        per_pool[p] = per_pool.get(p, 0) + pts
    return {
        "date": today,
        "pools": [
            {"key": p, "name": POOL_NAMES[p], "cap": _pool_cap_of(p),
             "used": per_pool.get(p, 0)}
            for p in (POOL_ACADEMIC, POOL_CLASS, POOL_FUN)
        ],
        "activities": [
            {"type": k, "name": ACTIVITY_TYPE_NAMES.get(k, k), "used": v,
             "cap": _points_cap_of(k)}
            for k, v in sorted(per_type.items(), key=lambda x: -x[1])
        ],
        "total_used": sum(per_type.values()),
        "total_cap": _cap_int(TOTAL_CAP_CONFIG_KEY, DAILY_TOTAL_POINTS_CAP),
        "last_block_reason": get_cap_notice(student_username),
    }


def my_summary(student_username: str) -> dict[str, Any]:
    """参与场次 / 获奖次数 / 消费扣分：一次聚合算准，不再由前端数流水条数。

    前端原来用 myHistory.length 当"参与活动次数"，而流水接口只回 100 条 ——
    学生的参与数会永远卡在 100，还把扣分行也数成了"参与"。
    """
    row = execute_query(
        """SELECT
               COUNT(DISTINCT CASE WHEN reward_type='participation'
                                   THEN activity_type || '|' || activity_id END),
               COALESCE(SUM(CASE WHEN reward_type IN ('excellent','good','pass')
                                 THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN points > 0 THEN points ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN points < 0 THEN -points ELSE 0 END), 0)
           FROM activity_rewards WHERE student_username=?""",
        (student_username,),
    )
    r = row[0] if row else (0, 0, 0, 0)
    return {
        "participation_sessions": int(r[0] or 0),
        "bonus_awards": int(r[1] or 0),
        "points_earned": int(r[2] or 0),
        "points_spent": int(r[3] or 0),
        "activity_types": int(execute_query(
            "SELECT COUNT(DISTINCT activity_type) FROM activity_rewards "
            "WHERE student_username=?", (student_username,))[0][0] or 0),
    }


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
