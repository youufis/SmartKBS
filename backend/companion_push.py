"""
AI 学伴主动推送引擎
在关键时机向学生推送学伴消息（登录时/考试后/称号升级等）
"""
from datetime import datetime, date
from typing import Any, Optional

from backend.database import execute_query, execute_insert_update, get_connection
from backend.logger import logger

# ── 推送类型 ──

PUSH_TYPES = {
    "morning": "☀️ 早安提醒",
    "achievement": "🏆 成就通知",
    "encourage": "💪 鼓励消息",
    "reminder": "📌 学习提醒",
    "milestone": "⭐ 里程碑",
}


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _today() -> str:
    return date.today().isoformat()


# ═══════════════════════════════════════════════
# 推送记录管理
# ═══════════════════════════════════════════════

def get_unread_pushes(student_username: str) -> list[dict[str, Any]]:
    """获取学生未读的推送消息"""
    rows = execute_query(
        "SELECT id, push_type, title, content, created_at FROM ai_companion_push_log "
        "WHERE student_username=? AND read_status=0 ORDER BY created_at DESC LIMIT 20",
        (student_username,),
    )
    return [
        {
            "id": row[0],
            "push_type": str(row[1]),
            "push_type_label": PUSH_TYPES.get(str(row[1]), str(row[1])),
            "title": str(row[2]),
            "content": str(row[3]),
            "created_at": str(row[4] or ""),
        }
        for row in rows
    ]


def mark_push_read(push_id: int, student_username: str) -> bool:
    """标记推送为已读"""
    execute_insert_update(
        "UPDATE ai_companion_push_log SET read_status=1 WHERE id=? AND student_username=?",
        (push_id, student_username),
    )
    return True


def mark_all_pushes_read(student_username: str):
    """标记该学生所有推送为已读"""
    execute_insert_update(
        "UPDATE ai_companion_push_log SET read_status=1 WHERE student_username=? AND read_status=0",
        (student_username,),
    )


def get_unread_push_count(student_username: str) -> int:
    """获取未读推送数量"""
    rows = execute_query(
        "SELECT COUNT(*) FROM ai_companion_push_log WHERE student_username=? AND read_status=0",
        (student_username,),
    )
    return rows[0][0] if rows else 0


# ═══════════════════════════════════════════════
# 推送触发
# ═══════════════════════════════════════════════

def _create_push(student_username: str, push_type: str, title: str, content: str):
    """创建一条推送记录"""
    now = _now()
    execute_insert_update(
        "INSERT INTO ai_companion_push_log (student_username, push_type, title, content, read_status, created_at) "
        "VALUES (?, ?, ?, ?, 0, ?)",
        (student_username, push_type, title, content, now),
    )
    logger.debug(f"学伴推送 [{push_type}] → {student_username}: {title}")


def push_morning_greeting(student_username: str, student_name: str):
    """推送早安问候（每日仅推送一次）"""
    today = _today()
    # 检查今天是否已推送过早安
    rows = execute_query(
        "SELECT COUNT(*) FROM ai_companion_push_log "
        "WHERE student_username=? AND push_type='morning' AND DATE(created_at)=?",
        (student_username, today),
    )
    if rows and rows[0][0] > 0:
        return  # 今天已推送过

    # 获取今日待办
    pending_exam_count = _get_pending_exam_count(student_username)
    pending_task_count = _get_pending_task_count(student_username)
    streak_days = _get_streak_days(student_username)
    companion_name = _get_companion_name(student_username)

    # 组装推送文案
    parts = [f"☀️ 早安，{student_name}！"]
    if pending_exam_count > 0:
        parts.append(f"今天有 {pending_exam_count} 场考试待参加")
    if pending_task_count > 0:
        parts.append(f"还有 {pending_task_count} 个任务待完成")
    if streak_days >= 3:
        parts.append(f"已连续学习 {streak_days} 天，太棒了继续保持！🔥")
    else:
        parts.append("新的一天，一起加油吧！💪")

    title = f"☀️ {companion_name}的早安问候"
    content = "，".join(parts)
    _create_push(student_username, "morning", title, content)


def push_exam_result(student_username: str, exam_title: str, score: float, total_score: float, passed: bool):
    """考试完成后推送成绩分析"""
    companion_name = _get_companion_name(student_username)
    student_name = _get_student_name(student_username)

    percentage = round(score / total_score * 100, 1) if total_score > 0 else 0

    if passed:
        if percentage >= 90:
            emoji = "🎉"
            praise = "太厉害了"
        elif percentage >= 80:
            emoji = "👏"
            praise = "表现不错"
        else:
            emoji = "👍"
            praise = "顺利通过"
        title = f"{emoji} 考试捷报"
        content = f"{student_name}，你在「{exam_title}」中得了 {score}/{total_score} 分（{percentage}%），{praise}！"
    else:
        title = "💪 再接再厉"
        content = f"{student_name}，这次「{exam_title}」得了 {score}/{total_score} 分，别灰心！让小智帮你分析错题，下次一定能过！"

    # 获取最新错题知识点，添加到推送中
    weakness = _get_recent_weakness(student_username)
    if weakness and not passed:
        content += f" 薄弱知识点「{weakness}」需要重点复习哦"

    _create_push(student_username, "achievement", title, content)


def push_title_upgrade(student_username: str, old_title: str, new_title: str):
    """称号升级时推送成就通知"""
    companion_name = _get_companion_name(student_username)
    student_name = _get_student_name(student_username)
    title = "🎉 称号升级"
    content = f"{student_name}，恭喜你从「{old_title}」升级为「{new_title}」！{companion_name}为你感到骄傲！🌟"
    _create_push(student_username, "achievement", title, content)


def push_weakness_reminder(student_username: str):
    """薄弱知识点提醒推送"""
    weakness = _analyze_weakness_summary(student_username)
    if not weakness:
        return

    companion_name = _get_companion_name(student_username)
    student_name = _get_student_name(student_username)

    title = "📌 薄弱点提醒"
    kp = weakness["kp"]
    count = weakness["wrong_count"]
    content = f"{student_name}，你在「{kp}」上已连续错 {count} 次了。要不要做个专项练习巩固一下？{companion_name}随时帮你！"
    _create_push(student_username, "reminder", title, content)


def push_milestone(student_username: str, milestone_text: str):
    """里程碑事件推送"""
    companion_name = _get_companion_name(student_username)
    student_name = _get_student_name(student_username)
    title = "⭐ 里程碑达成"
    content = f"{student_name}，{milestone_text}！{companion_name}见证了你的成长，继续加油！🚀"
    _create_push(student_username, "milestone", title, content)


# ═══════════════════════════════════════════════
# 内部辅助
# ═══════════════════════════════════════════════

def _get_student_name(username: str) -> str:
    rows = execute_query("SELECT name FROM users WHERE username=?", (username,))
    return rows[0][0] or username if rows else username


def _get_companion_name(username: str) -> str:
    try:
        from backend.companion_profile import get_companion_name
        return get_companion_name(username)
    except Exception:
        return "小智"


def _get_pending_exam_count(username: str) -> int:
    try:
        from backend.question_db import execute_query as q_exec
        rows = q_exec(
            """SELECT COUNT(*) FROM exams e
               WHERE e.status='published'
               AND NOT EXISTS (
                   SELECT 1 FROM exam_attempts ea
                   WHERE ea.exam_id=e.id AND ea.student_username=?
               )""",
            (username,),
        )
        return rows[0]['COUNT(*)'] if rows else 0
    except Exception:
        return 0


def _get_pending_task_count(username: str) -> int:
    try:
        rows = execute_query(
            """SELECT COUNT(*) FROM tasks t
               WHERE t.status='active'
               AND NOT EXISTS (
                   SELECT 1 FROM task_submissions ts
                   WHERE ts.task_id=t.id AND ts.student_username=?
               )""",
            (username,),
        )
        return rows[0][0] if rows else 0
    except Exception:
        return 0


def _get_streak_days(username: str) -> int:
    try:
        from backend.companion_memory import _get_streak_days
        return _get_streak_days(username)
    except Exception:
        return 0


def _get_recent_weakness(username: str) -> Optional[str]:
    try:
        rows = execute_query(
            """SELECT knowledge_points, COUNT(*) as cnt
               FROM wrong_book
               WHERE student_username=? AND status='active'
               GROUP BY knowledge_points
               ORDER BY cnt DESC
               LIMIT 1""",
            (username,),
        )
        return str(rows[0][0]) if rows else None
    except Exception:
        return None


def _analyze_weakness_summary(username: str) -> Optional[dict[str, Any]]:
    """获取最严重的薄弱点摘要"""
    try:
        rows = execute_query(
            """SELECT knowledge_points, COUNT(*) as cnt
               FROM wrong_book
               WHERE student_username=? AND status='active'
               GROUP BY knowledge_points
               HAVING cnt >= 3
               ORDER BY cnt DESC
               LIMIT 1""",
            (username,),
        )
        if rows:
            return {"kp": str(rows[0][0]), "wrong_count": rows[0][1]}
    except Exception:
        pass
    return None
