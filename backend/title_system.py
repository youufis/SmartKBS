"""
称号系统模块
管理学生积分主称号、学科称号、成就徽章的配置与计算
支持从 system_config.json 覆盖默认配置
"""
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.database import execute_query, execute_query as _db_query, execute_insert_update
from backend.logger import logger
from backend.permission_service import is_student_account

# ── 配置文件路径 ──
_CONFIG_FILE = Path(__file__).resolve().parent / "system_config.json"

# ── 默认积分主称号配置（12 级科技探索风） ──

# 阈值按「一个学期正常参与」重标定过。旧刻度（15/40/75/…/800）与真实得分能力脱节：
# 实测 1406 名在册学生里 1390 人停在 Lv1、只有 1 人 Lv12，Lv4 与 Lv6~Lv11 整段是空的
# —— Lv2 要 15 分（约 8 次签到）把偶尔参与的学生全挡在门外，Lv12 要 800 分又让重度
# 使用者一两个月就封顶，之后再无成长感。
#
# 新刻度按现行分值反推：点名答对 5 分、随堂测验满分 11 分、一场考试满分 18 分，
# 认真上一天课约 25~40 分。于是 Lv2=10（一节课）、Lv5=110（约一周）、Lv8=330（约一个月）、
# Lv12=1000（一学期持续高强度才够）。称号仍只升不降：student_titles 存历史最高等级。
DEFAULT_TITLE_CONFIG = [
    {"level": 1,  "name": "初窥门径", "min_points": 0,    "emoji": "🥚", "color": "default",  "desc": "刚刚开启学习之旅"},
    {"level": 2,  "name": "筑基学徒", "min_points": 10,   "emoji": "🌱", "color": "lime",     "desc": "打下了坚实的基础"},
    {"level": 3,  "name": "勤学新人", "min_points": 30,   "emoji": "📖", "color": "green",    "desc": "勤勉好学，已然入门"},
    {"level": 4,  "name": "知识猎人", "min_points": 60,   "emoji": "🔍", "color": "cyan",     "desc": "善于捕捉每一个知识点"},
    {"level": 5,  "name": "解题能手", "min_points": 110,  "emoji": "💡", "color": "blue",     "desc": "解题思路清晰，反应敏捷"},
    {"level": 6,  "name": "逻辑新星", "min_points": 170,  "emoji": "⚡", "color": "geekblue", "desc": "闪耀的思维新星"},
    {"level": 7,  "name": "学业先锋", "min_points": 240,  "emoji": "🚀", "color": "purple",   "desc": "走在学习的最前沿"},
    {"level": 8,  "name": "班级学霸", "min_points": 330,  "emoji": "🌟", "color": "magenta",  "desc": "班级中的学习佼佼者"},
    {"level": 9,  "name": "创新领袖", "min_points": 450,  "emoji": "🧠", "color": "gold",     "desc": "不仅会学，更会创新"},
    {"level": 10, "name": "全能学神", "min_points": 600,  "emoji": "🏆", "color": "orange",   "desc": "无所不学的学习大神"},
    {"level": 11, "name": "传奇大师", "min_points": 780,  "emoji": "👑", "color": "volcano",  "desc": "学习路上的传奇人物"},
    {"level": 12, "name": "至高贤者", "min_points": 1000, "emoji": "✨", "color": "red",      "desc": "登峰造极的至高存在"},
]


# ── 默认学科称号配置（按答题数，3 科共用同一套） ──

DEFAULT_SUBJECT_TITLE_CONFIG = [
    {"level": 1, "name": "入门",   "min_questions": 0,   "emoji": "🔰", "color": "default"},
    {"level": 2, "name": "见习",   "min_questions": 10,  "emoji": "📘", "color": "lime"},
    {"level": 3, "name": "进阶",   "min_questions": 30,  "emoji": "📗", "color": "green"},
    {"level": 4, "name": "精通",   "min_questions": 60,  "emoji": "📙", "color": "cyan"},
    {"level": 5, "name": "专家",   "min_questions": 100, "emoji": "📕", "color": "blue"},
    {"level": 6, "name": "大师",   "min_questions": 160, "emoji": "🏅", "color": "purple"},
]

# ── 默认成就徽章配置 ──

DEFAULT_BADGE_CONFIG = [
    {"id": "first_points",    "name": "崭露头角", "icon": "🌱", "desc": "首次获得积分", "condition_type": "first_points"},
    {"id": "full_score",      "name": "满分达人", "icon": "💯", "desc": "任何考试获得满分", "condition_type": "full_score"},
    {"id": "streak_7d",       "name": "学习之星", "icon": "⭐", "desc": "连续 7 天登录学习", "condition_type": "login_streak", "condition_value": 7},
    {"id": "questions_100",   "name": "刷题达人", "icon": "📚", "desc": "累计作答 100 道题", "condition_type": "total_questions", "condition_value": 100},
    {"id": "all_rounder",     "name": "全能选手", "icon": "🏆", "desc": "参与过 8 类以上不同活动", "condition_type": "all_activity_types", "condition_value": 8},
    {"id": "ai_explorer_50",  "name": "AI 探索者", "icon": "💬", "desc": "AI 对话累计 50 次", "condition_type": "chat_count", "condition_value": 50},
    {"id": "discussion_10",   "name": "讨论之星", "icon": "👥", "desc": "参与 10 次分组讨论", "condition_type": "discussion_count", "condition_value": 10},
    {"id": "punctual_3",      "name": "准时达人", "icon": "⏱️", "desc": "3 次考试都在截止时间内提交", "condition_type": "punctual_3", "condition_value": 3},
    {"id": "rollcall_ace",    "name": "点名达人", "icon": "🎯", "desc": "点名正确率≥90%（累计≥10次）", "condition_type": "rollcall_accuracy", "condition_value": 90},
    {"id": "perfect_attendance", "name": "月度坚持", "icon": "📅", "desc": "当月登录学习满 20 天", "condition_type": "monthly_full_attendance", "condition_value": 20},
    # ── 一站到底·闯关徽章（由 quest_router 独立管理，此处仅作展示配置） ──
    {"id": "quest_first",    "name": "初出茅庐", "icon": "🥉", "desc": "首次闯关成功", "condition_type": "quest_milestone", "condition_value": 1},
    {"id": "quest_novice",   "name": "闯关新秀", "icon": "🥈", "desc": "累计 5 次闯关成功", "condition_type": "quest_milestone", "condition_value": 5},
    {"id": "quest_expert",   "name": "闯关达人", "icon": "🥇", "desc": "累计 10 次闯关成功", "condition_type": "quest_milestone", "condition_value": 10},
    {"id": "quest_master",   "name": "闯关大师", "icon": "💎", "desc": "累计 20 次闯关成功", "condition_type": "quest_milestone", "condition_value": 20},
    {"id": "quest_legend",   "name": "闯关传奇", "icon": "👑", "desc": "累计 50 次闯关成功", "condition_type": "quest_milestone", "condition_value": 50},
    {"id": "quest_all_15",   "name": "一站到底", "icon": "💯", "desc": "单轮 15 题全对", "condition_type": "quest_honor"},
    {"id": "quest_10_plus",  "name": "十连斩", "icon": "🔟", "desc": "单轮答对 10 题以上", "condition_type": "quest_honor"},
    # ── 每日精选徽章 ──
    {"id": "discovery_explorer_50",  "name": "知识探险家", "icon": "🔭",
     "desc": "累计浏览 50 条每日精选", "condition_type": "discovery_views", "condition_value": 50},
    {"id": "discovery_master_200",   "name": "百科达人",    "icon": "📖",
     "desc": "累计浏览 200 条每日精选", "condition_type": "discovery_views", "condition_value": 200},
    {"id": "discovery_collector_30", "name": "收藏家",      "icon": "💎",
     "desc": "累计收藏 30 条精选",   "condition_type": "discovery_favorites", "condition_value": 30},
    # ── 热点新闻徽章 ──
    {"id": "news_reader_30",   "name": "时事新人",    "icon": "📰",
     "desc": "累计阅读 30 篇新闻", "condition_type": "news_views", "condition_value": 30},
    {"id": "news_reader_100",  "name": "时事通",       "icon": "🌐",
     "desc": "累计阅读 100 篇新闻", "condition_type": "news_views", "condition_value": 100},
    {"id": "news_reader_365",  "name": "百晓生",       "icon": "🧠",
     "desc": "累计阅读 365 篇新闻", "condition_type": "news_views", "condition_value": 365},
]

# ── 主题科目列表（动态加载） ──
def get_subject_list() -> list[str]:
    """从系统配置动态获取科目列表"""
    try:
        from backend.subject_config import get_subjects
        return get_subjects()
    except Exception:
        pass
    return ["人工智能"]


# 称号/徽章/学科称号配置在每次渲染里都会被读多次（荣耀殿堂一屏 20 张卡 × 每科一次），
# 而 config_router 的 load_config 在 api 层、这里直接读盘会形成循环依赖，
# 因此本地做一份 (mtime_ns, size) 缓存：改文件即失效，无额外依赖。
_CFG_CACHE: dict[str, Any] = {"key": None, "data": {}}


def _load_system_config() -> dict[str, Any]:
    """从 system_config.json 加载配置（带 (mtime_ns,size) 缓存），不存在则返回空 dict"""
    try:
        if not _CONFIG_FILE.exists():
            return {}
        st = _CONFIG_FILE.stat()
        key = (st.st_mtime_ns, st.st_size)
        if _CFG_CACHE["key"] == key and isinstance(_CFG_CACHE["data"], dict):
            return _CFG_CACHE["data"]
        data = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
        _CFG_CACHE["key"] = key
        _CFG_CACHE["data"] = data
        return data
    except Exception as e:
        logger.warning(f"读取 system_config.json 失败: {e}")
        return {}


def _load_title_config() -> list[dict[str, Any]]:
    """从 system_config.json 加载称号配置，不存在则返回默认"""
    cfg = _load_system_config()
    custom = cfg.get("TITLE_CONFIG")
    if custom and isinstance(custom, list) and len(custom) == len(DEFAULT_TITLE_CONFIG):
        return list(custom)
    return list(DEFAULT_TITLE_CONFIG)


def _load_subject_title_config() -> list[dict[str, Any]]:
    """加载学科称号配置"""
    cfg = _load_system_config()
    enabled = cfg.get("ENABLE_SUBJECT_TITLES", True)
    if not enabled:
        return []
    custom = cfg.get("SUBJECT_TITLE_CONFIG")
    if custom and isinstance(custom, list) and len(custom) == len(DEFAULT_SUBJECT_TITLE_CONFIG):
        return list(custom)
    return list(DEFAULT_SUBJECT_TITLE_CONFIG)


def _load_badge_config() -> list[dict[str, Any]]:
    """加载成就徽章配置"""
    cfg = _load_system_config()
    custom = cfg.get("BADGE_CONFIG")
    if custom and isinstance(custom, list):
        return list(custom)
    enabled = cfg.get("ENABLE_BADGES", True)
    if not enabled:
        return []
    return DEFAULT_BADGE_CONFIG


def get_title_config() -> list[dict[str, Any]]:
    """获取完整的主称号配置（含所有等级）"""
    return _load_title_config()


def get_subject_title_config() -> list[dict[str, Any]]:
    """获取学科称号配置"""
    return _load_subject_title_config()


def get_badge_config() -> list[dict[str, Any]]:
    """获取成就徽章配置"""
    return _load_badge_config()


# ── 积分主称号计算 ──


def get_main_title(points: int) -> dict[str, Any]:
    """根据总积分计算当前主称号

    Args:
        points: 学生总积分

    Returns:
        {"level": int, "name": str, "emoji": str, "color": str, "desc": str}
    """
    config = _load_title_config()
    result = config[0].copy()
    for t in config:
        if points >= t["min_points"]:
            result = t.copy()
        else:
            break
    return result


def get_main_title_progress(points: int) -> dict[str, Any]:
    """获取当前称号进度信息

    Returns:
        {
            "current": {...},           # 当前称号
            "next": {...} or None,      # 下一级称号（None 表示已满级）
            "progress_percent": float,  # 0~100
            "points_needed": int,       # 到下一级还需多少分
        }
    """
    config = _load_title_config()
    current = config[0].copy()
    next_title = None
    for i, t in enumerate(config):
        if points >= t["min_points"]:
            current = t.copy()
            next_title = config[i + 1] if i + 1 < len(config) else None
        else:
            break

    if next_title is None:
        return {
            "current": current,
            "next": None,
            "progress_percent": 100.0,
            "points_needed": 0,
        }

    current_min = current["min_points"]
    next_min = next_title["min_points"]
    total_gap = next_min - current_min
    earned_in_level = points - current_min
    progress = (earned_in_level / total_gap) * 100 if total_gap > 0 else 100

    return {
        "current": current,
        "next": next_title,
        "progress_percent": round(progress, 1),
        "points_needed": max(0, next_min - points),
    }


def check_main_title_upgrade(student_username: str, old_total: int, new_total: int) -> dict[str, Any] | None:
    """检测主称号是否升级

    Args:
        student_username: 学生用户名
        old_total: 更新前的总积分
        new_total: 更新后的总积分

    Returns:
        如果升级了，返回 {"old_title": ..., "new_title": ..., "level": ...}
        否则返回 None
    """
    old_title = get_main_title(old_total)
    new_title = get_main_title(new_total)

    if new_title["level"] > old_title["level"]:
        logger.info(f"称号升级: {student_username} {old_title['name']} → {new_title['name']} (积分: {old_total}→{new_total})")

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 更新 student_titles 表
        execute_insert_update(
            """INSERT OR REPLACE INTO student_titles
               (student_username, title_level, title_name, unlocked_at, updated_at)
               VALUES (?, ?, ?, COALESCE((SELECT unlocked_at FROM student_titles WHERE student_username=?), ?), ?)""",
            (student_username, new_title["level"], new_title["name"],
             student_username, now, now),
        )

        # 写入升级历史
        execute_insert_update(
            """INSERT INTO title_upgrade_history
               (student_username, old_title, new_title, title_type, created_at)
               VALUES (?, ?, ?, 'main', ?)""",
            (student_username, old_title["name"], new_title["name"], now),
        )

        # 创建系统通知
        _create_title_upgrade_notification(student_username, old_title, new_title)

        return {
            "old_title": old_title,
            "new_title": new_title,
            "level": new_title["level"],
        }

    # 首次初始化（旧积分为0但新积分>0，学生刚注册）
    if old_total == 0 and new_total > 0:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        execute_insert_update(
            """INSERT OR REPLACE INTO student_titles
               (student_username, title_level, title_name, unlocked_at, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (student_username, new_title["level"], new_title["name"], now, now),
        )

    return None


def _create_title_upgrade_notification(student_username: str, old_title: dict[str, Any], new_title: dict[str, Any]):
    """创建称号升级系统通知"""
    try:
        from backend.database import execute_insert_update
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        content = (
            f"🎉 恭喜升级！\n"
            f"您的称号已从 {old_title['emoji']} {old_title['name']} "
            f"升级为 {new_title['emoji']} {new_title['name']}！\n"
            f"继续加油，下一个称号等你来拿！"
        )
        execute_insert_update(
            """INSERT INTO notifications
               (recipient_username, type, title, content, is_read, created_at)
               VALUES (?, 'title_upgrade', ?, ?, 0, ?)""",
            (student_username,
             f"🏆 称号升级：{new_title['emoji']} {new_title['name']}",
             content, now),
        )
    except Exception as e:
        logger.warning(f"创建称号升级通知失败: {e}")


# ── 学科称号计算 ──

#: 学科称号的正确率封顶：只刷够题、基本答错，不给高段称号（防"乱答刷级"）。
#: 命中第一条即取该上限；accuracy=None（还一道没答）不设限。
SUBJECT_ACCURACY_CAPS = ((0.75, 6), (0.60, 4), (0.00, 2))


def accuracy_level_cap(accuracy: float | None) -> int:
    """按正确率给出学科称号的等级上限（1~6）"""
    if accuracy is None:
        return 6
    for floor_, cap in SUBJECT_ACCURACY_CAPS:
        if accuracy >= floor_:
            return cap
    return 2


def _subject_title_by_level(level: int) -> dict[str, Any]:
    """按等级取学科称号样式（emoji/颜色），等级找不到时退回第一档"""
    config = _load_subject_title_config() or [DEFAULT_SUBJECT_TITLE_CONFIG[0]]
    for t in config:
        if t["level"] == level:
            return t.copy()
    return config[0].copy()


def get_subject_title(subject: str, question_count: int,
                     accuracy: float | None = None) -> dict[str, Any]:
    """学科称号 = 按累计作答题数定档，再按正确率封顶

    只看题数会被"乱答"刷到大师，所以正确率 <60% 最高"进阶"、
    60~75% 最高"精通"、75% 以上才放开到"大师"。

    注意：question_count 必须一并返回。学科称号列表里“没有答题记录”的科目走的是这里
    的兜底分支，早期版本漏了该字段，前端（成长档案 / 荣誉页）会渲染出 undefined。
    """
    config = _load_subject_title_config()
    if not config:
        return {"subject": subject, "question_count": int(question_count or 0),
                "level": 0, "name": "", "emoji": "", "color": "default", "accuracy": accuracy}
    result = config[0].copy()
    for t in config:
        if question_count >= t["min_questions"]:
            result = t.copy()
        else:
            break
    cap = accuracy_level_cap(accuracy)
    if result["level"] > cap:
        result = _subject_title_by_level(cap)
    result["subject"] = subject
    result["question_count"] = int(question_count or 0)
    result["accuracy"] = accuracy
    return result


def check_subject_title_upgrade(student_username: str, subject: str,
                                old_level: int, new_level: int,
                                new_count: int) -> dict[str, Any] | None:
    """学科称号升级：只升不降（与主称号同一口径），升级才写历史与提示

    旧签名传的是"新旧答题数"，而等级现在还要看正确率，光比题数会算错档位，
    所以改由调用方把算好的新旧等级传进来。
    """
    if new_level <= (old_level or 0):
        return None
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    old_title = _subject_title_by_level(old_level) if old_level else None
    new_title = _subject_title_by_level(new_level)
    execute_insert_update(
        """INSERT INTO title_upgrade_history
           (student_username, old_title, new_title, title_type, subject, created_at)
           VALUES (?, ?, ?, 'subject', ?, ?)""",
        (student_username, (old_title or {}).get("name", ""), new_title["name"], subject, now),
    )
    logger.info(f"学科称号升级: {student_username} {subject} Lv{(old_level or 0)} → Lv{new_level}")
    return {"old_title": old_title or {}, "new_title": new_title, "subject": subject,
            "level": new_level}


def get_student_subject_titles(student_username: str) -> list[dict[str, Any]]:
    """获取学生所有科目的称号（等级直接读存量，不再按题数反算）

    按题数反算会把"只升不降"的等级打回原形：学生靠正确率拿到 Lv4 后，
    题数一少就显示掉级，而升级历史与徽章又不会回退，界面与台账自相矛盾。
    """
    rows = execute_query(
        """SELECT subject, question_count, title_level, title_name,
                  IFNULL(score_earned, 0), IFNULL(score_total, 0)
           FROM student_subject_titles WHERE student_username=?""",
        (student_username,),
    )
    stored = {r[0]: r for r in (rows or [])}
    result = []
    for s in get_subject_list():
        r = stored.get(s)
        if r:
            earned, total = float(r[4] or 0), float(r[5] or 0)
            level = int(r[2] or 1)
            style = _subject_title_by_level(level)
            result.append({
                "subject": s,
                "question_count": int(r[1] or 0),
                "level": level,
                "name": r[3] or style.get("name", ""),
                "emoji": style.get("emoji", ""),
                "color": style.get("color", "default"),
                "score_earned": round(earned, 1),
                "score_total": round(total, 1),
                "accuracy": round(earned / total, 4) if total > 0 else None,
            })
        else:
            result.append(get_subject_title(s, 0))
    return result



# ── 成就徽章计算 ──


def _login_streak_from_dates(dates: list[str]) -> int:
    """从日期串(YYYY-MM-DD, 建议倒序)算连续登录天数"""
    if not dates:
        return 0
    uniq = sorted({d[:10] for d in dates if d}, reverse=True)
    try:
        from datetime import datetime as _dt
        streak = 1
        for i in range(1, len(uniq)):
            d1 = _dt.strptime(uniq[i - 1], "%Y-%m-%d")
            d2 = _dt.strptime(uniq[i], "%Y-%m-%d")
            if (d1 - d2).days == 1:
                streak += 1
            else:
                break
        return streak
    except Exception:
        return 0


def _collect_badge_facts(student_username: str) -> dict[str, Any]:
    """R10: 一次性把徽章判定要用到的事实全部查出来。

    旧实现是"每枚徽章各查一遍"(徽章数 × 若干 SQL), 而它挂在积分变动路径上,
    学生每得一次分就可能触发几十条查询。改成一份 facts 复用后只剩个位数查询。
    """
    facts: dict[str, Any] = {
        "reward_rows": 0, "activity_types": 0, "total_points": 0,
        "full_score_exams": 0, "total_questions": 0, "submitted_exams": 0,
        "punctual_exams": 0,
        "chat_count": 0, "discussion_count": 0,
        "rollcall_correct": 0, "rollcall_total": 0,
        "login_streak": 0, "month_login_days": 0,
        # 本次补齐：这几枚徽章以前"条件类型根本没实现"，永远判 False → 永远灰
        "news_views": 0, "discovery_views": 0, "discovery_favorites": 0,
        "quest_success_count": 0, "quest_perfect_runs": 0, "quest_runs_10plus": 0,
    }
    try:
        row = _db_query(
            "SELECT COUNT(*), COALESCE(SUM(points),0) FROM activity_rewards WHERE student_username=?",
            (student_username,),
        )
        if row and row[0]:
            facts["reward_rows"] = int(row[0][0] or 0)
            facts["total_points"] = int(row[0][1] or 0)   # 聚合从 3 列改 2 列后这里必须跟改
        # 只数 REWARD_CONFIG 里登记过的活动：penalty/spend/refund 与历史的 share/
        # showcase 键不能算"参与过"，否则全能选手会被无关流水凑齐
        types_rows = _db_query(
            "SELECT DISTINCT activity_type FROM activity_rewards WHERE student_username=?",
            (student_username,),
        ) or []
        from backend.reward_engine import ACTIVITY_KEYS
        facts["activity_types"] = len([r[0] for r in types_rows if r[0] in ACTIVITY_KEYS])
    except Exception as e:
        logger.warning(f"[badge] 奖励统计失败({student_username}): {e}")

    try:
        rows = _db_query(
            "SELECT DISTINCT substr(login_time, 1, 10) FROM login_logs WHERE username=? ORDER BY 1 DESC LIMIT 120",
            (student_username,),
        ) or []
        dates = [r[0] for r in rows if r[0]]
        facts["login_streak"] = _login_streak_from_dates(dates)
        month = datetime.now().strftime("%Y-%m")
        # 注释说的是"当月至少 20 天", 旧实现数的是登录次数(同一秒不同时间戳也算多次), 口径修正为按天
        facts["month_login_days"] = len({d for d in dates if d.startswith(month)})
    except Exception as e:
        logger.warning(f"[badge] 登录统计失败({student_username}): {e}")

    try:
        from backend.question_db import execute_query as q_execute
        rows = q_execute(
            """SELECT
                   COALESCE(SUM(CASE WHEN score = total_score AND total_score > 0 THEN 1 ELSE 0 END), 0),
                   COUNT(*)
               FROM exam_attempts WHERE student_username=? AND status IN ('submitted','graded')""",
            (student_username,),
        )
        if rows:
            facts["full_score_exams"] = int(rows[0]["COALESCE(SUM(CASE WHEN score = total_score AND total_score > 0 THEN 1 ELSE 0 END), 0)"] if isinstance(rows[0], dict) else rows[0][0])
            facts["submitted_exams"] = int(rows[0]["COUNT(*)"] if isinstance(rows[0], dict) else rows[0][1])
        # 题数口径统一：与学科称号用同一份统计（旧写法数的是"交了几次卷"，
        # 于是一场 20 题的考试只算 1 题，"累计作答 100 道题"实际要交 100 次卷）
        _stats = _subject_stats(student_username)
        facts["total_questions"] = sum(s["questions"] for s in _stats.values())
        # 按时提交：拿 exam_attempts.submitted_at 与 exams.end_time 真比一次，
        # 旧实现只是 submitted_exams >= 3，把"交过 3 场试"叫成"准时达人"
        rows = q_execute(
            """SELECT COUNT(*) FROM exam_attempts ea
               JOIN exams e ON ea.exam_id = e.id
               WHERE ea.student_username=? AND ea.status IN ('submitted','graded')
                 AND (e.end_time IS NULL OR e.end_time = ''
                      OR substr(ea.submitted_at, 1, 19) <= substr(e.end_time, 1, 19))""",
            (student_username,),
        )
        if rows:
            v = rows[0]["COUNT(*)"] if isinstance(rows[0], dict) else rows[0][0]
            facts["punctual_exams"] = int(v or 0)
    except Exception as e:
        logger.warning(f"[badge] 答题统计失败({student_username}): {e}")

    try:
        # 与积分流水同一口径数"对话次数"：conversations 存的是会话文件（一次会话一行），
        # 而对话分是按每一次成功回答发的，用会话数判"累计 50 次"会严重低估
        row = _db_query(
            "SELECT COUNT(*) FROM activity_rewards WHERE student_username=? AND activity_type='chat'",
            (student_username,),
        )
        facts["chat_count"] = int(row[0][0]) if row and row[0] else 0
        row = _db_query(
            """SELECT COUNT(*) FROM discussion_groups dg
               JOIN discussion_members dm ON dg.id = dm.group_id WHERE dm.username=?""",
            (student_username,),
        )
        facts["discussion_count"] = int(row[0][0]) if row and row[0] else 0
        # rollcall_history.student_name 存的是姓名而非学号, 旧写法用 username 匹配 → 徽章永不解锁
        row = _db_query(
            """SELECT COALESCE(SUM(CASE WHEN result='correct' THEN 1 ELSE 0 END), 0), COUNT(*)
               FROM rollcall_history
               WHERE student_username = ?
                  OR (IFNULL(student_username, '') = ''
                      AND student_name = COALESCE((SELECT name FROM users WHERE username=?), ''))""",
            (student_username, student_username),
        )
        if row and row[0]:
            facts["rollcall_correct"] = int(row[0][0] or 0)
            facts["rollcall_total"] = int(row[0][1] or 0)
    except Exception as e:
        logger.warning(f"[badge] 对话/讨论/签到统计失败({student_username}): {e}")

    # 每日精选 / 热点新闻 / 知识闯关：这三类徽章的 condition_type 以前在
    # _check_badge_condition 里根本没有分支，一律 fallthrough 到 return False ——
    # 6 枚徽章（知识探险家、百科达人、收藏家、时事新人、时事通、百晓生）永远点不亮。
    # 数据一直都在（news_view_log / discovery_view_log / discovery_favorites /
    # quest_badge_counts / quest_records），只是没人查。
    try:
        row = _db_query("SELECT COUNT(DISTINCT news_id) FROM news_view_log WHERE username=?",
                        (student_username,))
        facts["news_views"] = int(row[0][0]) if row and row[0] else 0
        row = _db_query("SELECT COUNT(DISTINCT pool_card_id) FROM discovery_view_log WHERE username=?",
                        (student_username,))
        facts["discovery_views"] = int(row[0][0]) if row and row[0] else 0
        row = _db_query("SELECT COUNT(DISTINCT pool_card_id) FROM discovery_favorites WHERE username=?",
                        (student_username,))
        facts["discovery_favorites"] = int(row[0][0]) if row and row[0] else 0
    except Exception as e:
        logger.warning(f"[badge] 精选/新闻阅读统计失败({student_username}): {e}")

    try:
        row = _db_query("SELECT IFNULL(MAX(total_success_count), 0) FROM quest_badge_counts WHERE student_username=?",
                        (student_username,))
        facts["quest_success_count"] = int(row[0][0]) if row and row[0] else 0
        row = _db_query(
            """SELECT COALESCE(SUM(CASE WHEN completed=1 AND total_questions>0
                                         AND correct_count=total_questions THEN 1 ELSE 0 END), 0),
                      COALESCE(SUM(CASE WHEN correct_count>=10 THEN 1 ELSE 0 END), 0)
               FROM quest_records WHERE student_username=?""",
            (student_username,),
        )
        if row and row[0]:
            facts["quest_perfect_runs"] = int(row[0][0] or 0)
            facts["quest_runs_10plus"] = int(row[0][1] or 0)
    except Exception as e:
        logger.warning(f"[badge] 闯关统计失败({student_username}): {e}")

    return facts


def check_and_unlock_badges(student_username: str, only_badge_ids: list[str] | None = None) -> list[dict[str, Any]]:
    """检测学生可解锁的徽章并自动解锁(R10: 已解锁集合一次查出 + 事实一次查全)。

    only_badge_ids: 增量检测时只判定相关徽章, None 表示全量。
    """
    # 徽章属于学生荣誉体系：非学生（教师/管理员/幽灵账号）一律不解锁、不建行
    if not is_student_account(student_username):
        return []

    badges = _load_badge_config()
    if only_badge_ids:
        want = set(only_badge_ids)
        badges = [b for b in badges if str(b.get("id")) in want]
    if not badges:
        return []

    try:
        unlocked_rows = execute_query(
            "SELECT badge_id FROM student_badges WHERE student_username=?", (student_username,)
        ) or []
        unlocked = {r[0] for r in unlocked_rows}
    except Exception:
        unlocked = set()
    todo = [b for b in badges if str(b.get("id")) not in unlocked]
    if not todo:
        return []

    facts = _collect_badge_facts(student_username)
    newly_unlocked: list[dict[str, Any]] = []
    for badge in todo:
        try:
            hit = _check_badge_condition(student_username, badge, facts)
        except Exception as e:
            logger.warning(f"[badge] 条件判定异常 {badge.get('id')}: {e}")
            hit = False
        if not hit:
            continue
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        execute_insert_update(
            "INSERT OR IGNORE INTO student_badges (student_username, badge_id, badge_name, unlocked_at) VALUES (?, ?, ?, ?)",
            (student_username, badge["id"], badge["name"], now),
        )
        execute_insert_update(
            """INSERT INTO title_upgrade_history
               (student_username, old_title, new_title, title_type, created_at)
               VALUES (?, '', ?, 'badge', ?)""",
            (student_username, badge["name"], now),
        )
        _create_badge_notification(student_username, badge)
        newly_unlocked.append(badge)

    return newly_unlocked


def _check_badge_condition(student_username: str, badge: dict[str, Any], facts: dict[str, Any] | None = None) -> bool:
    """检查单个徽章条件(全部读 facts, 不再各自查库)"""
    if facts is None:
        facts = _collect_badge_facts(student_username)
    ctype = badge.get("condition_type", "")
    cvalue = badge.get("condition_value")

    if ctype == "first_points":
        return facts["reward_rows"] > 0
    if ctype == "full_score":
        return facts["full_score_exams"] > 0
    if ctype == "login_streak":
        return facts["login_streak"] >= (cvalue or 7)
    if ctype == "total_questions":
        return facts["total_questions"] >= (cvalue or 100)
    if ctype == "all_activity_types":
        # 旧判定要求集齐 ACTIVITY_TYPE_NAMES 的**每一个**键（还把扣分/退还等历史键
        # 算进去），实测只有把全部活动刷一遍的测试账号拿得到，真实学生 0 人。
        # 现改为"参与过 8 类以上活动"：表里 21 类活动，8 类≈一学期什么都参与一点。
        return facts["activity_types"] >= (cvalue or 8)
    if ctype == "chat_count":
        return facts["chat_count"] >= (cvalue or 50)
    if ctype == "discussion_count":
        return facts["discussion_count"] >= (cvalue or 10)
    if ctype == "rollcall_accuracy":
        total = facts["rollcall_total"]
        if total < 10:
            return False
        return (facts["rollcall_correct"] / total * 100) >= (cvalue or 90)
    if ctype == "monthly_full_attendance":
        # 库里没有逐日"签到"台账，能核实的口径是"当月登录学习满 20 天"，
        # 徽章名与描述已同步改成"月度坚持"，不再自称"全勤/全部签到"
        return facts["month_login_days"] >= (cvalue or 20)
    if ctype == "punctual_3":
        return facts["punctual_exams"] >= (cvalue or 3)
    if ctype == "news_views":
        return facts["news_views"] >= (cvalue or 30)
    if ctype == "discovery_views":
        return facts["discovery_views"] >= (cvalue or 50)
    if ctype == "discovery_favorites":
        return facts["discovery_favorites"] >= (cvalue or 30)
    if ctype == "quest_milestone":
        return facts["quest_success_count"] >= (cvalue or 1)
    if ctype == "quest_honor":
        # 两张荣誉徽章共用一个条件类型，靠 id 区分：一站到底 / 十连斩
        if str(badge.get("id") or "") == "quest_all_15":
            return facts["quest_perfect_runs"] > 0
        return facts["quest_runs_10plus"] > 0
    logger.debug(f"[badge] 未实现的条件类型 {ctype}（徽章 {badge.get('id')}），按未解锁处理")
    return False


def _get_all_activity_types() -> list[dict[str, Any]]:
    """获取所有活动类型列表"""
    from backend.reward_engine import ACTIVITY_TYPE_NAMES
    return [{"activity_type": k} for k in ACTIVITY_TYPE_NAMES]


def _create_badge_notification(student_username: str, badge: dict[str, Any]):
    """创建徽章解锁通知"""
    try:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        execute_insert_update(
            """INSERT INTO notifications
               (recipient_username, type, title, content, is_read, created_at)
               VALUES (?, 'badge_unlock', ?, ?, 0, ?)""",
            (student_username,
             f"🏅 解锁徽章：{badge['icon']} {badge['name']}",
             f"🎉 恭喜获得「{badge['icon']} {badge['name']}」徽章！\n{badge.get('desc', '')}",
             now),
        )
    except Exception as e:
        logger.warning(f"创建徽章解锁通知失败: {e}")


#: 可量化徽章的进度来源：condition_type → 事实字段（徽章墙据此显示"还差多少"）
BADGE_PROGRESS_SOURCE = {
    "login_streak": "login_streak",
    "total_questions": "total_questions",
    "chat_count": "chat_count",
    "discussion_count": "discussion_count",
    "all_activity_types": "activity_types",
    "punctual_3": "punctual_exams",
    "monthly_full_attendance": "month_login_days",
    "news_views": "news_views",
    "discovery_views": "discovery_views",
    "discovery_favorites": "discovery_favorites",
    "quest_milestone": "quest_success_count",
}
#: 没写 condition_value 时的默认目标（与 _check_badge_condition 的默认值保持一致）
BADGE_PROGRESS_DEFAULT = {
    "all_activity_types": 8, "punctual_3": 3, "monthly_full_attendance": 20,
    "news_views": 30, "discovery_views": 50, "discovery_favorites": 30,
    "quest_milestone": 1,
}


def _badge_progress(badge: dict[str, Any], facts: dict[str, Any]) -> dict[str, Any] | None:
    """数量型徽章的进度；满分/首次这类布尔成就返回 None（没有"差多少"可言）"""
    ctype = str(badge.get("condition_type") or "")
    src = BADGE_PROGRESS_SOURCE.get(ctype)
    if not src:
        return None
    target = int(badge.get("condition_value") or BADGE_PROGRESS_DEFAULT.get(ctype) or 0)
    return {"current": int(facts.get(src) or 0), "target": target}


def get_student_badges(student_username: str,
                       with_progress: bool = False) -> list[dict[str, Any]]:
    """获取学生所有徽章状态（已解锁+未解锁）

    with_progress=True 时附带"还差多少"（点亮徽章墙需要它）。这会多跑一次
    facts 采集，所以只在学生本人的荣誉页开启：教师端荣耀殿堂一屏要读几十个人的
    徽章，全都算进度会把一次浏览放大成几百条查询。
    """
    badge_config = _load_badge_config()
    unlocked_rows = execute_query(
        "SELECT badge_id, unlocked_at FROM student_badges WHERE student_username=?",
        (student_username,),
    )
    unlocked_map = {r[0]: r[1] for r in unlocked_rows} if unlocked_rows else {}

    facts = _collect_badge_facts(student_username) if with_progress else None
    result = []
    for badge in badge_config:
        entry = {
            "badge_id": badge["id"],
            "name": badge["name"],
            "icon": badge["icon"],
            "desc": badge.get("desc", ""),
            "unlocked": badge["id"] in unlocked_map,
        }
        if entry["unlocked"]:
            entry["unlocked_at"] = unlocked_map[badge["id"]]
        elif with_progress:
            entry["progress"] = _badge_progress(badge, facts or {})
        result.append(entry)
    return result


def get_title_upgrade_history(student_username: str, limit: int = 50) -> list[dict[str, Any]]:
    """获取学生称号/徽章升级历史"""
    rows = execute_query(
        """SELECT old_title, new_title, title_type, subject, created_at
           FROM title_upgrade_history
           WHERE student_username=?
           ORDER BY created_at DESC LIMIT ?""",
        (student_username, limit),
    )
    return [
        {
            "old_title": r[0],
            "new_title": r[1],
            "title_type": r[2],
            "subject": r[3] or "",
            "created_at": r[4],
        }
        for r in rows
    ]


def get_or_init_student_title(student_username: str) -> dict[str, Any]:
    """获取学生当前称号，如果尚未初始化则创建"""
    row = execute_query(
        "SELECT title_level, title_name FROM student_titles WHERE student_username=?",
        (student_username,),
    )
    if row:
        level = row[0][0]
        name = row[0][1]
        return {"level": level, "name": name}

    # 未初始化：计算当前积分并初始化
    total_row = execute_query(
        "SELECT total_points FROM student_total_points WHERE student_username=?",
        (student_username,),
    )
    points = total_row[0][0] if total_row else 0
    title = get_main_title(points)

    if not is_student_account(student_username):
        # 教师/管理员打开自己的资料页时也要能渲染"称号"这块 UI，但绝不能因此
        # 往 student_titles 里插一行 —— 那正是"管理员有称号"这类脏数据的来源。
        # 这里只按当前积分返回一个不落库的展示值。
        return {"level": title["level"], "name": title["name"], "virtual": True}

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "INSERT OR REPLACE INTO student_titles (student_username, title_level, title_name, unlocked_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (student_username, title["level"], title["name"], now, now),
    )
    return {"level": title["level"], "name": title["name"]}


def get_full_title_info(student_username: str, total_points: int = -1) -> dict[str, Any]:
    """获取学生完整称号信息（供 API 使用）

    Returns:
        {
            "main_title": {...},
            "progress": {...},
            "subject_titles": [...],
            "badges": [...],
            "recent_upgrades": [...]
        }
    """
    if total_points < 0:
        total_row = execute_query(
            "SELECT total_points FROM student_total_points WHERE student_username=?",
            (student_username,),
        )
        total_points = total_row[0][0] if total_row else 0

    # 获取或初始化主称号
    st = get_or_init_student_title(student_username)
    main_title = get_main_title(total_points)
    progress = get_main_title_progress(total_points)

    # 学科称号
    subject_titles = get_student_subject_titles(student_username)

    # 徽章（学生本人页面：带"还差多少"）
    badges = get_student_badges(student_username, with_progress=True)

    # 最近升级历史
    recent_upgrades = get_title_upgrade_history(student_username, limit=10)

    return {
        "main_title": main_title,
        "progress": progress,
        "subject_titles": subject_titles,
        "badges": badges,
        "recent_upgrades": recent_upgrades,
    }


# ── 学科题目数统计与自动升级 ──


def _subject_stats(student_username: str) -> dict[str, dict[str, float]]:
    """各科「作答题数 / 得分 / 满分」：学科称号与「刷题达人」徽章共用这一份口径。

    只统计**能确定学科**的作答，拿不到学科的一律不计——错误归属比不计入更糟：
      1. 考试      exams.subject × 该卷题数（答一次算一套）
      2. 同步练习  practice_sessions.subject × 该练习卷题数
      3. 代码练习  code_problems.subject × 提交过的题目（取最佳一次）
      4. 课堂提问  interaction_questions.subject ×（提问数 + 回答数）
      5. 随堂测验  题目以 JSON 快照存库、没有学科字段，只在"该教师唯一任教学科"时
                   归属；跨学科或未填任教科目的测验不计入任何学科
    课程练习(ai_practice_results) 挂在知识点上，而 knowledge_points 不带学科，
    归属要跨课程结构反查，暂不计入。
    """
    out: dict[str, dict[str, float]] = {
        s: {"questions": 0, "score": 0.0, "max": 0.0} for s in get_subject_list()
    }

    def bump(subject: Any, questions: int = 0, score: float = 0.0, max_: float = 0.0) -> None:
        row = out.get(str(subject or "").strip())
        if row is None:
            return        # 不在科目列表里的不强行塞进去，避免学科称号多出未知科目
        row["questions"] += int(questions or 0)
        row["score"] += float(score or 0)
        row["max"] += float(max_ or 0)

    try:
        from backend.question_db import execute_query as q_execute
    except Exception as e:
        logger.warning(f"[学科统计] 题库不可用: {e}")
        return out

    # 1+2：考试与同步练习——题数与得分分两条查询，避免 attempts × questions 的连接扇出把分算重
    for sql_q, sql_s, table in (
        ("""SELECT e.subject, COUNT(eq.id) AS q
            FROM exam_attempts ea
            JOIN exams e ON ea.exam_id = e.id
            LEFT JOIN exam_questions eq ON eq.exam_id = e.id
            WHERE ea.student_username=? AND ea.status IN ('submitted','graded')
            GROUP BY e.subject""",
         """SELECT e.subject, SUM(COALESCE(ea.score, 0)) AS s, SUM(COALESCE(ea.total_score, 0)) AS m
            FROM exam_attempts ea JOIN exams e ON ea.exam_id = e.id
            WHERE ea.student_username=? AND ea.status IN ('submitted','graded')
            GROUP BY e.subject""", "exam"),
        ("""SELECT ps.subject, COUNT(psq.id) AS q
            FROM practice_attempts pa
            JOIN practice_sessions ps ON pa.session_id = ps.id
            LEFT JOIN practice_session_questions psq ON psq.session_id = ps.id
            WHERE pa.student_username=? AND pa.status='submitted'
            GROUP BY ps.subject""",
         """SELECT ps.subject, SUM(COALESCE(pa.score, 0)) AS s, SUM(COALESCE(pa.total_score, 0)) AS m
            FROM practice_attempts pa JOIN practice_sessions ps ON pa.session_id = ps.id
            WHERE pa.student_username=? AND pa.status='submitted'
            GROUP BY ps.subject""", "practice"),
    ):
        try:
            for r in q_execute(sql_q, (student_username,)) or []:
                bump(r["subject"], questions=r["q"])
            for r in q_execute(sql_s, (student_username,)) or []:
                bump(r["subject"], score=r["s"], max_=r["m"])
        except Exception as e:
            logger.warning(f"[学科统计] {table} 统计失败: {e}")

    # 3：代码练习（每题按最佳一次提交的用例通过率计分）
    try:
        for r in q_execute(
            """SELECT cp.subject,
                          COUNT(*) AS q,
                          SUM(CASE WHEN cs.total_cases > 0
                              THEN cs.passed_cases * 1.0 / cs.total_cases ELSE 0 END) AS s,
                          COUNT(*) AS m
                   FROM code_submissions cs
                   JOIN code_problems cp ON cs.problem_id = cp.id
                   WHERE cs.student_username=? AND IFNULL(cs.is_best, 0)=1
                   GROUP BY cp.subject""",
            (student_username,),
        ) or []:
            bump(r["subject"], questions=r["q"], score=r["s"], max_=r["m"])
    except Exception as e:
        logger.warning(f"[学科统计] 代码练习统计失败: {e}")

    # 4：课堂提问与回答（主库，interaction_questions 自带 subject）
    try:
        for r in execute_query(
            """SELECT subject, COUNT(*) AS q FROM interaction_questions
               WHERE student_username=? AND IFNULL(subject, '') <> ''
               GROUP BY subject""",
            (student_username,),
        ) or []:
            bump(r[0], questions=r[1])
        for r in execute_query(
            """SELECT q.subject, COUNT(*) AS q_count
               FROM interaction_question_answers a
               JOIN interaction_questions q ON a.question_id = q.id
               WHERE a.student_username=? AND IFNULL(q.subject, '') <> ''
               GROUP BY q.subject""",
            (student_username,),
        ) or []:
            bump(r[0], questions=r[1])
    except Exception as e:
        logger.warning(f"[学科统计] 课堂提问统计失败: {e}")

    # 5：随堂测验——按创建教师唯一任教学科归属，答案 JSON 数组长度即题数
    try:
        for r in execute_query(
            """SELECT ta.subject,
                      SUM(CASE WHEN json_valid(iqa.answers)
                               THEN json_array_length(iqa.answers) ELSE 0 END) AS q_count
               FROM interaction_quiz_answers iqa
               JOIN interaction_quizzes iq ON iqa.quiz_id = iq.id
               JOIN (
                   SELECT teacher_username, MIN(subject) AS subject
                   FROM teacher_assignments
                   WHERE subject IS NOT NULL AND subject <> ''
                   GROUP BY teacher_username
                   HAVING COUNT(DISTINCT subject) = 1
               ) ta ON ta.teacher_username = iq.creator_username
               WHERE iqa.student_username=?
               GROUP BY ta.subject""",
            (student_username,),
        ) or []:
            bump(r[0], questions=r[1])
    except Exception as e:
        logger.warning(f"[学科统计] 随堂测验统计失败: {e}")

    return out


def _count_questions_per_subject(student_username: str) -> dict[str, int]:
    """各科作答题数（保留旧函数名，供外部按"题数"取用时不必改口径）"""
    return {s: int(v["questions"]) for s, v in _subject_stats(student_username).items()}


def update_subject_question_counts(student_username: str) -> list[dict[str, Any]]:
    """刷新各学科答题数与正确率，等级只升不降

    触发点：夜间荣誉兜底任务（log_retention）+ 学生端"刷新学科数据"按钮。
    不在答题热路径上跑，避免每次发分都多三条统计查询。
    """
    upgrades: list[dict[str, Any]] = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for subject, st in _subject_stats(student_username).items():
        new_count = int(st["questions"])
        earned, max_ = float(st["score"] or 0), float(st["max"] or 0)
        accuracy = (earned / max_) if max_ > 0 else None
        title = get_subject_title(subject, new_count, accuracy)
        old_row = execute_query(
            """SELECT question_count, title_level, IFNULL(score_earned, 0), IFNULL(score_total, 0)
               FROM student_subject_titles WHERE student_username=? AND subject=?""",
            (student_username, subject),
        )
        old_count = int(old_row[0][0] or 0) if old_row else 0
        old_level = int(old_row[0][1] or 1) if old_row else 0
        new_level = int(title["level"])
        # 等级只升不降；题数与分数照常更新（荣誉不会因一次没考好而倒退）
        keep_level = max(new_level, old_level)
        style = _subject_title_by_level(keep_level)
        if old_row and old_count == new_count and old_level == keep_level \
                and float(old_row[0][2] or 0) == earned and float(old_row[0][3] or 0) == max_:
            continue     # 没有任何变化，别写库也别刷 updated_at
        execute_insert_update(
            """INSERT OR REPLACE INTO student_subject_titles
               (student_username, subject, question_count, title_level, title_name,
                score_earned, score_total, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (student_username, subject, new_count, keep_level, style["name"],
             round(earned, 1), round(max_, 1), now),
        )
        up = check_subject_title_upgrade(student_username, subject, old_level, keep_level, new_count)
        if up:
            upgrades.append(up)
    return upgrades
