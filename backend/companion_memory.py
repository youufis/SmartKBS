"""
AI 学伴记忆引擎
构建和维护学生画像，从各数据源聚合学习信息
"""
import json
from datetime import datetime, timedelta
from typing import Any, Optional

from backend.database import execute_query
from backend.question_db import execute_query as q_execute_query
from backend.logger import logger
from backend.companion_profile import get_config as get_companion_config, get_companion_name
from backend.prompts.companion import build_companion_prompt

# ── 画像缓存 ──
_profile_cache: dict[str, tuple[float, str]] = {}  # username -> (timestamp, profile_text)
_PROFILE_CACHE_TTL = 120  # 2分钟


def _now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def clear_profile_cache(username: str):
    """清除指定学生的画像缓存"""
    _profile_cache.pop(username, None)


# ═══════════════════════════════════════════════
# 画像构建
# ═══════════════════════════════════════════════

def get_student_profile(username: str) -> dict[str, Any]:
    """获取学生完整画像

    从多个数据源聚合学生的全维度学习数据
    """
    # 基本信息
    user_rows = execute_query(
        "SELECT name, class, grade FROM users WHERE username=?",
        (username,),
    )
    if not user_rows:
        return {"username": username, "name": username}

    name = user_rows[0][0] or username
    cls = user_rows[0][1] or ""
    grade = user_rows[0][2] or ""

    profile: dict[str, Any] = {
        "username": username,
        "name": name,
        "grade": grade,
        "class": cls,
    }

    # 薄弱知识点分析
    profile["weakness"] = _analyze_weakness(username)

    # 优势知识点分析
    profile["strength"] = _analyze_strength(username)

    # 积分与称号
    profile["titles"] = _get_titles(username)
    profile["total_points"] = _get_total_points(username)

    # 近期考试趋势
    exam_data = _analyze_exam_trend(username)
    profile["recent_exams"] = exam_data

    # 连续登录天数
    profile["streak_days"] = _get_streak_days(username)

    # 里程碑事件
    profile["milestones"] = _get_milestones(username)

    # 学伴推荐建议
    profile["recommendation"] = _generate_recommendation(profile)

    return profile


def get_student_profile_text(username: str) -> str:
    """获取学生画像的纯文本描述（供 system prompt 使用）

    带缓存，2分钟内相同 username 返回相同结果
    """
    now = datetime.now().timestamp()
    cached = _profile_cache.get(username)
    if cached and (now - cached[0]) < _PROFILE_CACHE_TTL:
        return cached[1]

    profile = get_student_profile(username)
    text = _format_profile_text(profile)
    _profile_cache[username] = (now, text)
    return text


def build_companion_system_prompt(username: str) -> str:
    """构建完整的学伴系统提示词（含学生画像）"""
    profile = get_student_profile(username)
    config = get_companion_config(username)
    profile_text = _format_profile_text(profile)

    return build_companion_prompt(
        student_name=profile.get("name", username),
        companion_name=config.get("companion_name", "小智"),
        personality=config.get("personality", "encouraging"),
        student_profile_text=profile_text,
    )


# ═══════════════════════════════════════════════
# 内部分析方法
# ═══════════════════════════════════════════════

def _analyze_weakness(username: str) -> list[dict[str, Any]]:
    """从错题本分析薄弱知识点"""
    weaknesses = []

    # 从错题本统计各知识点的错误次数
    try:
        rows = execute_query(
            """SELECT knowledge_points, COUNT(*) as wrong_count
               FROM wrong_book
               WHERE student_username=? AND status IN ('active', 'reviewing')
               GROUP BY knowledge_points
               ORDER BY wrong_count DESC
               LIMIT 5""",
            (username,),
        )
        for row in rows:
            kp = str(row[0] or "").strip()
            count = row[1]
            if kp and count > 0:
                # 判断难度级别
                if count >= 5:
                    level = "hard"
                elif count >= 3:
                    level = "medium"
                else:
                    level = "easy"
                weaknesses.append({
                    "kp": kp,
                    "wrong_count": count,
                    "level": level,
                })
    except Exception as e:
        logger.warning(f"分析薄弱知识点失败 ({username}): {e}")

    return weaknesses


def _analyze_strength(username: str) -> list[dict[str, Any]]:
    """从考试成绩分析优势知识点"""
    strengths = []

    try:
        # 从最近考试中分析答对的题目
        # 通过 exam_attempts 表获取最近考试记录
        attempts = q_execute_query(
            """SELECT ea.id, ea.exam_id, ea.score, ea.total_score, ea.answers
               FROM exam_attempts ea
               WHERE ea.student_username=? AND ea.status IN ('submitted', 'graded')
               ORDER BY ea.submitted_at DESC
               LIMIT 5""",
            (username,),
        )

        # 简单分析：如果多次考试成绩 >= 80%，认为是优势
        high_score_count = 0
        total = len(attempts)
        for att in attempts:
            score = att.get("score", 0) or 0
            total_score = att.get("total_score", 1) or 1
            if total_score > 0 and (score / total_score) >= 0.8:
                high_score_count += 1

        if total > 0 and high_score_count >= total * 0.6:
            strengths.append({
                "kp": "综合学科能力",
                "correct_rate": round(high_score_count / total, 2),
                "level": "strong",
            })
    except Exception as e:
        logger.warning(f"分析优势知识点失败 ({username}): {e}")

    return strengths


def _get_titles(username: str) -> dict[str, str]:
    """获取学生的称号信息"""
    titles: dict[str, str] = {"main": "初窥门径"}

    try:
        row = execute_query(
            "SELECT title_name FROM student_titles WHERE student_username=?",
            (username,),
        )
        if row and row[0][0]:
            titles["main"] = str(row[0][0])

        # 学科称号
        subj_rows = execute_query(
            "SELECT subject, title_name FROM student_subject_titles WHERE student_username=?",
            (username,),
        )
        for sr in subj_rows:
            titles[str(sr[0])] = str(sr[1] or "")
    except Exception as e:
        logger.warning(f"获取称号信息失败 ({username}): {e}")

    return titles


def _get_total_points(username: str) -> int:
    """获取学生总积分"""
    try:
        row = execute_query(
            "SELECT total_points FROM student_total_points WHERE student_username=?",
            (username,),
        )
        return row[0][0] if row else 0
    except Exception:
        return 0


def _analyze_exam_trend(username: str) -> dict[str, Any]:
    """分析近期考试趋势"""
    result: dict[str, Any] = {"avg": 0, "trend": "stable", "count": 0}

    try:
        rows = q_execute_query(
            """SELECT score, total_score, submitted_at
               FROM exam_attempts
               WHERE student_username=? AND status IN ('submitted', 'graded')
               ORDER BY submitted_at ASC
               LIMIT 10""",
            (username,),
        )

        if not rows:
            return result

        percentages = []
        for r in rows:
            s = r.get("score", 0) or 0
            ts = r.get("total_score", 1) or 1
            if ts > 0:
                percentages.append(s / ts * 100)

        if not percentages:
            return result

        result["avg"] = round(sum(percentages) / len(percentages), 1)
        result["count"] = len(percentages)

        # 判断趋势：比较后一半和前一半的平均
        if len(percentages) >= 4:
            mid = len(percentages) // 2
            first_half = sum(percentages[:mid]) / mid
            second_half = sum(percentages[mid:]) / (len(percentages) - mid)
            diff = second_half - first_half
            if diff > 5:
                result["trend"] = "上升"
            elif diff < -5:
                result["trend"] = "下降"
            else:
                result["trend"] = "稳定"
    except Exception as e:
        logger.warning(f"分析考试趋势失败 ({username}): {e}")

    return result


def _get_streak_days(username: str) -> int:
    """获取连续登录天数"""
    try:
        rows = execute_query(
            """SELECT DISTINCT DATE(login_time) as login_date
               FROM login_logs
               WHERE username=?
               ORDER BY login_date DESC
               LIMIT 30""",
            (username,),
        )
        if not rows:
            return 0

        dates = [str(r[0]) for r in rows]
        streak = 0
        today = datetime.now().date()

        for i, d_str in enumerate(dates):
            d = datetime.strptime(d_str, "%Y-%m-%d").date()
            expected = today - timedelta(days=i)
            if d == expected:
                streak += 1
            else:
                break

        return streak
    except Exception as e:
        logger.warning(f"获取连续登录天数失败 ({username}): {e}")
        return 0


def _get_milestones(username: str) -> list[str]:
    """获取学生的里程碑事件"""
    milestones = []

    try:
        # 称号升级
        rows = execute_query(
            """SELECT new_title, created_at
               FROM title_upgrade_history
               WHERE student_username=? AND title_type='main'
               ORDER BY created_at DESC
               LIMIT 3""",
            (username,),
        )
        for row in rows:
            milestones.append(f"称号升至「{row[0]}」")

        # 满分记录
        try:
            full_score = q_execute_query(
                """SELECT e.title
                   FROM exam_attempts ea
                   JOIN exams e ON ea.exam_id = e.id
                   WHERE ea.student_username=? AND ea.score >= ea.total_score
                   ORDER BY ea.submitted_at DESC
                   LIMIT 1""",
                (username,),
            )
            if full_score:
                milestones.append(f"在「{full_score[0]['title']}」中获得满分")
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"获取里程碑失败 ({username}): {e}")

    return milestones


def _generate_recommendation(profile: dict[str, Any]) -> str:
    """基于画像生成学习建议"""
    weakness = profile.get("weakness", [])
    if weakness:
        top = weakness[0]
        return f"建议重点复习「{top['kp']}」，近期已有 {top['wrong_count']} 次在此知识点失分"

    exam_data = profile.get("recent_exams", {})
    if exam_data.get("count", 0) > 0:
        return "继续保持当前学习节奏，定期复习巩固"
    return "建议多参与考试和练习，让学伴更了解你的学习情况"


def _format_profile_text(profile: dict[str, Any]) -> str:
    """将画像格式化为纯文本"""
    lines = []
    lines.append(f"- 姓名：{profile.get('name', '未知')}")
    lines.append(f"- 年级/班级：{profile.get('grade', '')} {profile.get('class', '')}")

    # 薄弱点
    weakness = profile.get("weakness", [])
    if weakness:
        items = [f"{w['kp']}（错{w['wrong_count']}次）" for w in weakness[:3]]
        lines.append(f"- 薄弱知识点：{'、'.join(items)}")

    # 优势
    strength = profile.get("strength", [])
    if strength:
        items = [f"{s['kp']}" for s in strength[:2]]
        lines.append(f"- 优势领域：{'、'.join(items)}")

    # 积分与称号
    titles = profile.get("titles", {})
    main_title = titles.get("main", "初窥门径")
    points = profile.get("total_points", 0)
    lines.append(f"- 当前称号：{main_title}（{points}积分）")

    # 考试趋势
    exams = profile.get("recent_exams", {})
    if exams.get("count", 0) > 0:
        trend = exams.get("trend", "稳定")
        avg = exams.get("avg", 0)
        lines.append(f"- 考试平均分：{avg}分（趋势：{trend}）")

    # 连续登录
    streak = profile.get("streak_days", 0)
    if streak > 0:
        lines.append(f"- 连续学习：{streak}天")

    # 里程碑
    milestones = profile.get("milestones", [])
    if milestones:
        lines.append(f"- 近期成就：{'、'.join(milestones[:2])}")

    # 建议
    recommendation = profile.get("recommendation", "")
    if recommendation:
        lines.append(f"- 学习建议：{recommendation}")

    return "\n".join(lines)


# ═══════════════════════════════════════════════
# 记忆存储/读取
# ═══════════════════════════════════════════════

def save_memory(student_username: str, memory_type: str, content: str, confidence: float = 0.5):
    """保存一条记忆（去重）"""
    from backend.database import execute_insert_update
    now = _now_str()
    execute_insert_update(
        """INSERT OR REPLACE INTO ai_companion_memory
           (student_username, memory_type, content, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (student_username, memory_type, json.dumps(content, ensure_ascii=False), confidence, now, now),
    )


def get_memories(student_username: str, memory_type: Optional[str] = None) -> list[dict[str, Any]]:
    """获取记忆列表"""
    if memory_type:
        rows = execute_query(
            "SELECT memory_type, content, confidence, created_at FROM ai_companion_memory "
            "WHERE student_username=? AND memory_type=? ORDER BY updated_at DESC",
            (student_username, memory_type),
        )
    else:
        rows = execute_query(
            "SELECT memory_type, content, confidence, created_at FROM ai_companion_memory "
            "WHERE student_username=? ORDER BY updated_at DESC",
            (student_username,),
        )

    result = []
    for row in rows:
        try:
            content = json.loads(str(row[1]))
        except (json.JSONDecodeError, TypeError):
            content = str(row[1])
        result.append({
            "memory_type": str(row[0]),
            "content": content,
            "confidence": float(row[2] or 0.5),
            "created_at": str(row[3] or ""),
        })
    return result
