"""
称号系统模块
管理学生积分主称号、学科称号、成就徽章的配置与计算
支持从 system_config.json 覆盖默认配置
"""
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.database import execute_query, execute_insert_update
from backend.logger import logger

# ── 配置文件路径 ──
_CONFIG_FILE = Path(__file__).resolve().parent / "system_config.json"

# ── 默认积分主称号配置（12 级科技探索风） ──

DEFAULT_TITLE_CONFIG = [
    {"level": 1,  "name": "初窥门径", "min_points": 0,   "emoji": "🥚", "color": "default",  "desc": "刚刚开启学习之旅"},
    {"level": 2,  "name": "筑基学徒", "min_points": 15,  "emoji": "🌱", "color": "lime",     "desc": "打下了坚实的基础"},
    {"level": 3,  "name": "勤学新人", "min_points": 40,  "emoji": "📖", "color": "green",    "desc": "勤勉好学，已然入门"},
    {"level": 4,  "name": "知识猎人", "min_points": 75,  "emoji": "🔍", "color": "cyan",     "desc": "善于捕捉每一个知识点"},
    {"level": 5,  "name": "解题能手", "min_points": 120, "emoji": "💡", "color": "blue",     "desc": "解题思路清晰，反应敏捷"},
    {"level": 6,  "name": "逻辑新星", "min_points": 180, "emoji": "⚡", "color": "geekblue", "desc": "闪耀的思维新星"},
    {"level": 7,  "name": "学业先锋", "min_points": 250, "emoji": "🚀", "color": "purple",   "desc": "走在学习的最前沿"},
    {"level": 8,  "name": "班级学霸", "min_points": 330, "emoji": "🌟", "color": "magenta",  "desc": "班级中的学习佼佼者"},
    {"level": 9,  "name": "创新领袖", "min_points": 420, "emoji": "🧠", "color": "gold",     "desc": "不仅会学，更会创新"},
    {"level": 10, "name": "全能学神", "min_points": 520, "emoji": "🏆", "color": "orange",   "desc": "无所不学的学习大神"},
    {"level": 11, "name": "传奇大师", "min_points": 640, "emoji": "👑", "color": "volcano",  "desc": "学习路上的传奇人物"},
    {"level": 12, "name": "至高贤者", "min_points": 800, "emoji": "✨", "color": "red",      "desc": "登峰造极的至高存在"},
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
    {"id": "questions_100",   "name": "刷题达人", "icon": "📚", "desc": "累计完成 100 道题目", "condition_type": "total_questions", "condition_value": 100},
    {"id": "all_rounder",     "name": "全能选手", "icon": "🏆", "desc": "参加过所有类型的活动", "condition_type": "all_activity_types"},
    {"id": "ai_explorer_50",  "name": "AI 探索者", "icon": "💬", "desc": "AI 对话累计 50 次", "condition_type": "chat_count", "condition_value": 50},
    {"id": "discussion_10",   "name": "讨论之星", "icon": "👥", "desc": "参与 10 次分组讨论", "condition_type": "discussion_count", "condition_value": 10},
    {"id": "punctual_3",      "name": "准时达人", "icon": "⏱️", "desc": "连续 3 次按时提交考试", "condition_type": "punctual_3"},
    {"id": "rollcall_ace",    "name": "点名达人", "icon": "🎯", "desc": "点名正确率≥90%（累计≥10次）", "condition_type": "rollcall_accuracy", "condition_value": 90},
    {"id": "perfect_attendance", "name": "全勤标兵", "icon": "📅", "desc": "当月全部签到", "condition_type": "monthly_full_attendance"},
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


def _load_system_config() -> dict[str, Any]:
    """从 system_config.json 加载配置，不存在则返回空 dict"""
    try:
        if _CONFIG_FILE.exists():
            return json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning(f"读取 system_config.json 失败: {e}")
    return {}


def _load_title_config() -> list[dict[str, Any]]:
    """从 system_config.json 加载称号配置，不存在则返回默认"""
    cfg = _load_system_config()
    custom = cfg.get("TITLE_CONFIG")
    if custom and isinstance(custom, list) and len(custom) == len(DEFAULT_TITLE_CONFIG):
        return custom
    return DEFAULT_TITLE_CONFIG


def _load_subject_title_config() -> list[dict[str, Any]]:
    """加载学科称号配置"""
    cfg = _load_system_config()
    enabled = cfg.get("ENABLE_SUBJECT_TITLES", True)
    if not enabled:
        return []
    custom = cfg.get("SUBJECT_TITLE_CONFIG")
    if custom and isinstance(custom, list) and len(custom) == len(DEFAULT_SUBJECT_TITLE_CONFIG):
        return custom
    return DEFAULT_SUBJECT_TITLE_CONFIG


def _load_badge_config() -> list[dict[str, Any]]:
    """加载成就徽章配置"""
    cfg = _load_system_config()
    custom = cfg.get("BADGE_CONFIG")
    if custom and isinstance(custom, list):
        return custom
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


def get_subject_title(subject: str, question_count: int) -> dict[str, Any]:
    """根据答题数计算学科称号

    Args:
        subject: 科目名称
        question_count: 该科累计答题数

    Returns:
        {"level": int, "name": str, "emoji": str, "color": str}
    """
    config = _load_subject_title_config()
    result = config[0].copy()
    for t in config:
        if question_count >= t["min_questions"]:
            result = t.copy()
        else:
            break
    result["subject"] = subject
    return result


def check_subject_title_upgrade(student_username: str, subject: str, old_count: int, new_count: int) -> dict[str, Any] | None:
    """检测学科称号是否升级

    Returns:
        如果升级了，返回称号信息 dict，否则 None
    """
    old_title = get_subject_title(subject, old_count)
    new_title = get_subject_title(subject, new_count)

    if new_title["level"] > old_title["level"]:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        execute_insert_update(
            """INSERT OR REPLACE INTO student_subject_titles
               (student_username, subject, question_count, title_level, title_name, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (student_username, subject, new_count, new_title["level"], new_title["name"], now),
        )

        execute_insert_update(
            """INSERT INTO title_upgrade_history
               (student_username, old_title, new_title, title_type, subject, created_at)
               VALUES (?, ?, ?, 'subject', ?, ?)""",
            (student_username, old_title["name"], new_title["name"], subject, now),
        )

        logger.info(f"学科称号升级: {student_username} {subject} {old_title['name']} → {new_title['name']}")
        return {"old_title": old_title, "new_title": new_title, "subject": subject}

    return None


def get_student_subject_titles(student_username: str) -> list[dict[str, Any]]:
    """获取学生所有科目的称号"""
    rows = execute_query(
        "SELECT subject, question_count, title_level, title_name FROM student_subject_titles WHERE student_username=?",
        (student_username,),
    )
    if not rows:
        # 未初始化，返回默认
        return [get_subject_title(s, 0) for s in get_subject_list()]

    result = []
    for s in get_subject_list():
        found = None
        for r in rows:
            if r[0] == s:
                found = {
                    "subject": s,
                    "question_count": r[1],
                    "level": r[2],
                    "name": r[3],
                }
                break
        if found:
            # 补齐 emoji、color
            title_info = get_subject_title(s, found["question_count"])
            found["emoji"] = title_info["emoji"]
            found["color"] = title_info["color"]
            result.append(found)
        else:
            result.append(get_subject_title(s, 0))
    return result


# ── 成就徽章计算 ──


def check_and_unlock_badges(student_username: str) -> list[dict[str, Any]]:
    """检测学生所有可解锁的徽章，并自动解锁

    Returns:
        新解锁的徽章列表（空列表表示没有新徽章）
    """
    badges = _load_badge_config()
    newly_unlocked = []

    for badge in badges:
        # 检查是否已解锁
        existing = execute_query(
            "SELECT id FROM student_badges WHERE student_username=? AND badge_id=?",
            (student_username, badge["id"]),
        )
        if existing:
            continue

        # 检测条件
        unlocked = _check_badge_condition(student_username, badge)
        if unlocked:
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            execute_insert_update(
                "INSERT INTO student_badges (student_username, badge_id, badge_name, unlocked_at) VALUES (?, ?, ?, ?)",
                (student_username, badge["id"], badge["name"], now),
            )
            newly_unlocked.append(badge)

            # 写入升级历史
            execute_insert_update(
                """INSERT INTO title_upgrade_history
                   (student_username, old_title, new_title, title_type, created_at)
                   VALUES (?, '', ?, 'badge', ?)""",
                (student_username, badge["name"], now),
            )

            # 创建通知
            _create_badge_notification(student_username, badge)

    return newly_unlocked


def _check_badge_condition(student_username: str, badge: dict[str, Any]) -> bool:
    """检查单个徽章条件是否满足"""
    ctype = badge.get("condition_type", "")
    cvalue = badge.get("condition_value")

    if ctype == "first_points":
        try:
            row = execute_query(
                "SELECT COUNT(*) FROM activity_rewards WHERE student_username=?",
                (student_username,),
            )
            return bool(row and row[0][0] > 0)
        except Exception:
            return False

    if ctype == "full_score":
        # 从 question_db 查询满分
        try:
            from backend.question_db import execute_query as q_execute
            rows = q_execute(
                """SELECT COUNT(*) FROM exam_attempts
                   WHERE student_username=? AND score = total_score AND total_score > 0""",
                (student_username,),
            )
            return bool(rows and rows[0]["COUNT(*)"] > 0)
        except Exception:
            return False

    if ctype == "login_streak":
        # 查询连续登录天数（简化：看 login_logs 最近连续记录）
        try:
            rows = execute_query(
                """SELECT DISTINCT login_time FROM login_logs
                   WHERE username=? ORDER BY login_time DESC LIMIT 30""",
                (student_username,),
            )
            if not rows:
                return False
            dates = sorted(set(r[0][:10] for r in rows if r[0]), reverse=True)
            streak = 1
            from datetime import datetime, timedelta
            for i in range(1, len(dates)):
                d1 = datetime.strptime(dates[i - 1], "%Y-%m-%d")
                d2 = datetime.strptime(dates[i], "%Y-%m-%d")
                if (d1 - d2).days == 1:
                    streak += 1
                else:
                    break
            return streak >= (cvalue or 7)
        except Exception:
            return False

    if ctype == "total_questions":
        try:
            from backend.question_db import execute_query as q_execute
            rows = q_execute(
                """SELECT COALESCE(SUM(question_count), 0) AS total FROM (
                       SELECT COUNT(*) as question_count FROM exam_attempts WHERE student_username=?
                       UNION ALL
                       SELECT COUNT(*) FROM practice_attempts WHERE student_username=?
                   )""",
                (student_username, student_username),
            )
            total = rows[0]["total"] if rows else 0
            return total >= (cvalue or 100)
        except Exception:
            return False

    if ctype == "all_activity_types":
        try:
            rows = execute_query(
                "SELECT COUNT(DISTINCT activity_type) FROM activity_rewards WHERE student_username=?",
                (student_username,),
            )
            total_types = len(set(t["activity_type"] for t in _get_all_activity_types()))
            return bool(rows and rows[0][0] >= total_types)
        except Exception:
            return False

    if ctype == "chat_count":
        try:
            rows = execute_query(
                "SELECT COUNT(*) FROM conversations WHERE username=?",
                (student_username,),
            )
            return bool(rows and rows[0][0] >= (cvalue or 50))
        except Exception:
            return False

    if ctype == "discussion_count":
        try:
            rows = execute_query(
                """SELECT COUNT(*) FROM discussion_groups dg
                   JOIN discussion_members dm ON dg.id = dm.group_id
                   WHERE dm.username=?""",
                (student_username,),
            )
            return bool(rows and rows[0][0] >= (cvalue or 10))
        except Exception:
            return False

    if ctype == "punctual_3":
        try:
            from backend.question_db import execute_query as q_execute
            rows = q_execute(
                """SELECT submitted_at FROM exam_attempts
                   WHERE student_username=? AND status IN ('submitted', 'graded')
                   ORDER BY submitted_at DESC LIMIT 3""",
                (student_username,),
            )
            if not rows or len(rows) < 3:
                return False
            # 检查最近 3 次考试是否都在截止时间前提交
            # 简化处理：只要最近 3 次都有提交记录就算
            return True
        except Exception:
            return False

    if ctype == "rollcall_accuracy":
        try:
            rows = execute_query(
                """SELECT 
                       COALESCE(SUM(CASE WHEN result='correct' THEN 1 ELSE 0 END), 0) as correct,
                       COUNT(*) as total
                   FROM rollcall_history WHERE student_name=?""",
                (student_username,),
            )
            if rows:
                total = rows[0][1] if len(rows[0]) > 1 else 0
                correct = rows[0][0] if len(rows[0]) > 0 else 0
                if total >= 10 and total > 0:
                    return (correct / total * 100) >= (cvalue or 90)
            return False
        except Exception:
            return False

    if ctype == "monthly_full_attendance":
        # 当月全部签到（简化：有签到记录即为当月签到）
        try:
            from datetime import datetime
            month = datetime.now().strftime("%Y-%m")
            rows = execute_query(
                """SELECT COUNT(DISTINCT login_time) FROM login_logs
                   WHERE username=? AND login_time LIKE ?""",
                (student_username, f"{month}%"),
            )
            # 当月至少有 20 天登录（按上课日估算）
            return bool(rows and rows[0][0] >= 20)
        except Exception:
            return False

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


def get_student_badges(student_username: str) -> list[dict[str, Any]]:
    """获取学生所有徽章状态（已解锁+未解锁）"""
    badge_config = _load_badge_config()
    unlocked_rows = execute_query(
        "SELECT badge_id, unlocked_at FROM student_badges WHERE student_username=?",
        (student_username,),
    )
    unlocked_map = {r[0]: r[1] for r in unlocked_rows} if unlocked_rows else {}

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

    # 徽章
    badges = get_student_badges(student_username)

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


def update_subject_question_counts(student_username: str) -> list[dict[str, Any]]:
    """统计学生的各学科答题数，更新学科称号并检测升级

    从 exam_attempts + practice_attempts 中按科目统计答题数，
    对比 student_subject_titles 中的记录，如果答题数增加则触发升级检测。

    Returns:
        新升级的学科称号列表
    """
    upgrades = []

    # 获取各科当前答题数
    counts = _count_questions_per_subject(student_username)

    for subject, new_count in counts.items():
        # 获取旧的答题数
        old_row = execute_query(
            "SELECT question_count FROM student_subject_titles WHERE student_username=? AND subject=?",
            (student_username, subject),
        )
        old_count = old_row[0][0] if old_row else 0

        if new_count > old_count:
            # 更新答题数
            title_info = get_subject_title(subject, new_count)
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            execute_insert_update(
                """INSERT OR REPLACE INTO student_subject_titles
                   (student_username, subject, question_count, title_level, title_name, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (student_username, subject, new_count, title_info["level"], title_info["name"], now),
            )

            # 检测升级
            upgrade = check_subject_title_upgrade(student_username, subject, old_count, new_count)
            if upgrade:
                upgrades.append(upgrade)

    return upgrades


def _count_questions_per_subject(student_username: str) -> dict[str, int]:
    """统计学生在各学科的答题数

    从以下来源统计：
    1. exam_attempts → exams.subject（每次考试算一题？其实考试可能有多题）
    2. practice_attempts → practice_sessions.subject（同上）

    注意：由于 exam_attempts 没有直接记录题目数量，
    我们用 exam_questions 表的关联来统计每场考试的题目数。
    简化方案：按考试/练习的参与次数来算（每参加一次算一套题）。
    """
    counts: dict[str, int] = {s: 0 for s in get_subject_list()}

    try:
        from backend.question_db import execute_query as q_execute

        # 1. 从 exam_attempts 统计各科考试数量
        # exam_attempts 没有直接科目字段，需要通过 exam_id 关联 exams 表
        # 简化：用 exam_questions 统计每场考试的题数
        exam_rows = q_execute(
            """SELECT e.subject, COUNT(eq.id) as q_count
               FROM exam_attempts ea
               JOIN exams e ON ea.exam_id = e.id
               LEFT JOIN exam_questions eq ON eq.exam_id = e.id
               WHERE ea.student_username=? AND ea.status IN ('submitted', 'graded')
               GROUP BY e.subject""",
            (student_username,),
        )
        for row in exam_rows:
            subject = row["subject"]
            q_count = row["q_count"] if row["q_count"] else 0
            if subject in counts:
                counts[subject] += q_count
    except Exception as e:
        logger.warning(f"统计 exam_attempts 题目数失败: {e}")

    try:
        # 2. 从 practice_attempts 统计各科练习数量
        # practice_sessions 有 subject 字段
        # practice_session_questions 记录每场练习的题目
        practice_rows = execute_query(
            """SELECT ps.subject, COUNT(psq.id) as q_count
               FROM practice_attempts pa
               JOIN practice_sessions ps ON pa.session_id = ps.id
               LEFT JOIN practice_session_questions psq ON psq.session_id = ps.id
               WHERE pa.student_username=? AND pa.status='submitted'
               GROUP BY ps.subject""",
            (student_username,),
        )
        for row in practice_rows:
            subject = row[0]
            q_count = row[1] if row[1] else 0
            if subject in counts:
                counts[subject] += q_count
    except Exception as e:
        logger.warning(f"统计 practice_attempts 题目数失败: {e}")

    # 3. 从 interaction_quiz_answers 统计互动测验
    try:
        quiz_rows = execute_query(
            """SELECT iq.subject, COUNT(iqa.id) as q_count
               FROM interaction_quiz_answers iqa
               JOIN interaction_quizzes iq ON iqa.quiz_id = iq.id
               WHERE iqa.student_username=?
               GROUP BY iq.subject""",
            (student_username,),
        )
        for row in quiz_rows:
            subject = row[0]
            q_count = row[1] if row[1] else 0
            if subject in counts:
                counts[subject] += q_count
    except Exception as e:
        logger.warning(f"统计 quiz 答题数失败: {e}")

    return counts
