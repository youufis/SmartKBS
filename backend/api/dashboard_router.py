"""
首页仪表盘 API 路由
聚合展示系统关键数据：考试、积分、任务、点名、用户统计等
"""
import time
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Request

from backend.api.dependencies import get_current_user
from backend.database import execute_query
from backend.question_db import execute_query as q_execute_query
from backend.auth import get_online_count
from backend.logger import logger
from backend.title_system import (
    get_main_title,
    get_main_title_progress,
    get_student_subject_titles,
    get_student_badges,
    get_or_init_student_title,
)
from backend.reward_engine import get_student_total as get_reward_total

router = APIRouter()

# ── 简单内存缓存（TTL 30 秒） ──
_dashboard_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_DASHBOARD_CACHE_TTL = 30


def _get_cached(key: str) -> dict[str, Any] | None:
    """获取缓存"""
    cached = _dashboard_cache.get(key)
    if cached and (time.time() - cached[0]) < _DASHBOARD_CACHE_TTL:
        return cached[1]
    return None


def _set_cache(key: str, data: dict[str, Any]):
    """设置缓存"""
    _dashboard_cache[key] = (time.time(), data)
    # 限制缓存大小，防止内存泄漏
    if len(_dashboard_cache) > 200:
        now = time.time()
        keys_to_del = [k for k, v in _dashboard_cache.items() if now - v[0] > _DASHBOARD_CACHE_TTL * 2]
        for k in keys_to_del:
            del _dashboard_cache[k]


def _q_count(sql: str, params: tuple[Any, ...] = ()) -> int:
    """执行 question_db 的 COUNT 查询并返回数值（返回 dict，按列名访问）"""
    rows = q_execute_query(sql, params)
    return rows[0]['COUNT(*)'] if rows else 0


def _get_user_grade_class(username: str) -> tuple[str, str]:
    """查询用户的年级(grade)和班级(class)"""
    rows = execute_query(
        "SELECT grade, class FROM users WHERE username = ?",
        (username,),
    )
    if rows and rows[0]:
        return str(rows[0][0] or ""), str(rows[0][1] or "")
    return "", ""


def _db_count(sql: str, params: tuple[Any, ...] = ()) -> int:
    """执行 database 的 COUNT 查询并返回数值（返回 tuple，按下标访问）"""
    rows = execute_query(sql, params)
    return rows[0][0] if rows else 0


@router.get("/summary", summary="获取仪表盘概览数据")
async def dashboard_summary(request: Request):
    """根据用户角色返回聚合的仪表盘数据"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    # 尝试从缓存读取
    cache_key = f"{role}:{username}"
    cached = _get_cached(cache_key)
    if cached is not None:
        return cached

    now = datetime.now()
    today_str = now.strftime("%Y-%m-%d")

    # 获取用户显示名（JWT payload 可能不含 name，需从数据库兜底）
    display_name = user.get("name", "")
    if not display_name or display_name == username:
        name_row = execute_query(
            "SELECT name FROM users WHERE username=?",
            (username,),
        )
        display_name = name_row[0][0] if name_row and name_row[0][0] else username

    result = {
        "role": "admin" if role == 0 else ("teacher" if role == 1 else "student"),
        "username": username,
        "user_name": display_name,
    }

    grade = ""
    cls = ""

    if role == 2:  # ── 学生 ──
        pending_count = _q_count(
            """SELECT COUNT(*) FROM exams
               WHERE status = 'published'
               AND (start_time IS NULL OR start_time <= ?)
               AND (end_time IS NULL OR end_time >= ?)
               AND id NOT IN (
                   SELECT exam_id FROM exam_attempts
                   WHERE student_username = ? AND status IN ('submitted', 'graded')
               )""",
            (today_str, today_str, username),
        )

        completed_count = _q_count(
            """SELECT COUNT(*) FROM exam_attempts
               WHERE student_username = ? AND status IN ('submitted', 'graded')""",
            (username,),
        )

        # 使用积分奖励系统中的总积分（与排行榜一致）
        total_score = get_reward_total(username)

        # 同年级排名（基于 reward_engine 总积分）
        grade_row = execute_query("SELECT grade_id FROM users WHERE username=?", (username,))
        grade_id = grade_row[0][0] if grade_row else None
        if grade_id:
            rank = _db_count(
                """SELECT COUNT(*) + 1 FROM student_total_points stp
                   JOIN users u ON stp.student_username = u.username
                   WHERE u.role=2 AND u.grade_id=? AND stp.total_points > ?""",
                (grade_id, total_score),
            )
        else:
            rank = 1

        active_task_count = _db_count(
            "SELECT COUNT(*) FROM tasks WHERE status = 'active'",
        )
        if active_task_count > 0:
            # 与学生相关的活跃任务（按年级/班级匹配教师）才计数
            from backend.api.tasks_router import get_all_tasks, get_user_relevant_tasks
            all_active = get_all_tasks()
            relevant = get_user_relevant_tasks(username, all_active)
            active_task_count = len(relevant)

        submission_count = _db_count(
            "SELECT COUNT(*) FROM task_submissions WHERE student_username = ?",
            (username,),
        )

        recent_chat_count = _db_count(
            """SELECT COUNT(*) FROM conversations
               WHERE username = ? AND date >= ?""",
            (username, (now - timedelta(days=7)).strftime("%Y-%m-%d")),
        )

        # 近期考试结果 (question_db 返回 dict，按列名访问)
        recent_results = q_execute_query(
            """SELECT ea.id, e.title, ea.score, ea.total_score,
                      ea.submitted_at, e.pass_score
               FROM exam_attempts ea
               JOIN exams e ON ea.exam_id = e.id
               WHERE ea.student_username = ? AND ea.status IN ('submitted', 'graded')
               ORDER BY ea.submitted_at DESC LIMIT 5""",
            (username,),
        )
        exam_results = []
        for r in recent_results:
            exam_results.append({
                "id": r['id'],
                "title": r['title'],
                "score": r['score'],
                "total_score": r['total_score'],
                "submitted_at": r['submitted_at'],
                "pass_score": r['pass_score'],
                "passed": r['score'] >= r['pass_score'],
            })

        # 待参加的考试列表 (question_db 返回 dict)
        pending_exam_list = q_execute_query(
            """SELECT e.id, e.title, e.subject, e.duration, e.total_score,
                      e.pass_score, e.start_time, e.end_time
               FROM exams e
               WHERE e.status = 'published'
               AND (e.start_time IS NULL OR e.start_time <= ?)
               AND (e.end_time IS NULL OR e.end_time >= ?)
               AND e.id NOT IN (
                   SELECT exam_id FROM exam_attempts
                   WHERE student_username = ? AND status IN ('submitted', 'graded')
               )
               ORDER BY e.start_time IS NULL, e.start_time ASC
               LIMIT 5""",
            (today_str, today_str, username),
        )
        pending_exams_list = []
        for ex in pending_exam_list:
            pending_exams_list.append({
                "id": ex['id'],
                "title": ex['title'],
                "subject": ex['subject'],
                "duration": ex['duration'],
                "total_score": ex['total_score'],
                "pass_score": ex['pass_score'],
                "start_time": ex['start_time'],
                "end_time": ex['end_time'],
            })

        # ── 课堂互动数据 ──
        grade, cls = _get_user_grade_class(username)
        grade_row2 = execute_query("SELECT grade_id FROM users WHERE username=?", (username,))
        grade_id2 = grade_row2[0][0] if grade_row2 else None
        if grade_id2:
            cls_param = "," + cls + "," if cls else ""
            cls_cond = "AND (u.role = 0 OR INSTR(',' || u.class || ',', ?) > 0)" if cls else ""
            sql = (
                "SELECT COUNT(*) FROM interaction_quizzes q "
                "JOIN users u ON q.creator_username = u.username AND u.role IN (0, 1) "
                "WHERE q.status = 'active' "
                "AND (u.role = 0 OR u.grade_id = ?) "
                + cls_cond + " "
                "AND q.id NOT IN (SELECT quiz_id FROM interaction_quiz_answers WHERE student_username = ?)"
            )
            active_quiz_count = _db_count(
                sql,
                (grade_id2, cls_param, username) if cls else (grade_id2, username),
            )
        else:
            active_quiz_count = 0
        my_quiz_answers = _db_count(
            "SELECT COUNT(*) FROM interaction_quiz_answers WHERE student_username = ?",
            (username,),
        )
        poll_vote_count = _db_count(
            "SELECT COUNT(DISTINCT poll_id) FROM interaction_poll_votes WHERE student_username = ?",
            (username,),
        )

        # ── 分组讨论数据 ──
        active_discussion_count = _db_count(
            """SELECT COUNT(*) FROM discussions
               WHERE status='active'
               AND (creator_username IN (SELECT username FROM users WHERE role=0)
                    OR creator_username IN (
                        SELECT username FROM users WHERE role=1
                        AND (grade='' OR grade IS NULL OR INSTR(grade, ?)>0 OR INSTR(?, grade)>0)
                        AND (class='' OR class IS NULL OR INSTR(class, ?)>0 OR INSTR(?, class)>0)
                    ))""",
            (grade, grade, cls, cls) if grade else (),
        ) if grade else _db_count(
            """SELECT COUNT(*) FROM discussions
               WHERE status='active' AND creator_username IN (SELECT username FROM users WHERE role=0)""",
        )

        my_discussion_count = _db_count(
            """SELECT COUNT(*) FROM discussion_members dm
               JOIN discussion_groups dg ON dm.group_id = dg.id
               WHERE dm.username = ?""",
            (username,),
        )

        # ── 智能练习数据 ──
        pending_practice_count = _q_count(
            """SELECT COUNT(*) FROM practice_sessions ps
               WHERE ps.status='active'
                 AND ps.id NOT IN (
                   SELECT session_id FROM practice_attempts WHERE student_username=?
                 )""",
            (username,),
        )
        completed_practice_count = _q_count(
            "SELECT COUNT(*) FROM practice_attempts WHERE student_username=?",
            (username,),
        )

        # ── 错题本数据 ──
        wrong_exam_count = _q_count(
            """SELECT COUNT(*) FROM exam_attempts
               WHERE student_username=? AND status='submitted'""",
            (username,),
        )

        # ── 知识闯关数据（quest_records 在 smartkb.db 中，使用 _db_count）──
        quest_completed_count = _db_count(
            "SELECT COUNT(*) FROM quest_records WHERE student_username=? AND completed!=0",
            (username,),
        )
        quest_score = _db_count(
            "SELECT COALESCE(SUM(score), 0) FROM quest_records WHERE student_username=? AND completed!=0",
            (username,),
        )

        # ── 知识抢答数据 ──
        quick_quiz_participated = _db_count(
            "SELECT COUNT(DISTINCT room_id) FROM quick_quiz_players WHERE student_username=?",
            (username,),
        )
        quick_quiz_correct = _db_count(
            "SELECT COALESCE(SUM(correct_count), 0) FROM quick_quiz_players WHERE student_username=?",
            (username,),
        )

        # ── 课程练习数据（ai_practice_results 在 questions.db） ──
        course_practice_count = _q_count(
            "SELECT COUNT(*) FROM ai_practice_results WHERE student_username=?",
            (username,),
        )
        course_practice_avg_accuracy = 0
        if course_practice_count > 0:
            acc_row = q_execute_query(
                "SELECT COALESCE(AVG(accuracy), 0) FROM ai_practice_results WHERE student_username=?",
                (username,),
            )
            course_practice_avg_accuracy = round(acc_row[0]["COALESCE(AVG(accuracy), 0)"], 1) if acc_row else 0

        # ── 课堂提问/回答数据 ──
        my_questions_count = _db_count(
            "SELECT COUNT(*) FROM interaction_questions WHERE student_username = ?",
            (username,),
        )
        my_answers_count = _db_count(
            "SELECT COUNT(*) FROM interaction_question_answers WHERE student_username = ?",
            (username,),
        )
        my_approved_answers_count = _db_count(
            "SELECT COUNT(*) FROM interaction_question_answers WHERE student_username = ? AND status = 'approved'",
            (username,),
        )

        result.update({
            "pending_exam_count": pending_count,
            "completed_exam_count": completed_count,
            "total_score": total_score,
            "rank": rank,
            "active_task_count": active_task_count,
            "submission_count": submission_count,
            "recent_chat_count": recent_chat_count,
            "exam_results": exam_results,
            "pending_exams": pending_exams_list,
            # 课堂互动
            "active_quiz_count": active_quiz_count,
            "my_quiz_answers": my_quiz_answers,
            "student_poll_vote_count": poll_vote_count,
            # 课堂提问/回答
            "my_questions_count": my_questions_count,
            "my_answers_count": my_answers_count,
            "my_approved_answers_count": my_approved_answers_count,
            # 分组讨论
            "active_discussion_count": active_discussion_count,
            "my_discussion_count": my_discussion_count,
            # 智能练习
            "pending_practice_count": pending_practice_count,
            "completed_practice_count": completed_practice_count,
            # 错题本
            "wrong_exam_count": wrong_exam_count,
            # 知识闯关
            "quest_completed_count": quest_completed_count,
            "quest_score": quest_score,
            # 知识抢答
            "quick_quiz_participated": quick_quiz_participated,
            "quick_quiz_correct": quick_quiz_correct,
            # 课程练习
            "course_practice_count": course_practice_count,
            "course_practice_avg_accuracy": course_practice_avg_accuracy,
            # 共享资源
            "shared_files_count": _db_count(
                """SELECT COUNT(*) FROM shared_resources WHERE share_scope='all'
                   OR (share_scope='class' AND (target_grade=? OR INSTR(target_grade, ?)>0) AND (target_class=? OR INSTR(target_class, ?)>0))
                   OR (share_scope='teacher' AND INSTR(target_users, ?)>0)""",
                (grade, grade, cls, cls, username) if grade else ("", "", "", "", username),
            ) if grade else _db_count("SELECT COUNT(*) FROM shared_resources WHERE share_scope='all'"),
        })
        # 称号系统（使用 reward_engine 的活动积分）
        _main_t = get_main_title(total_score)
        _progress = get_main_title_progress(total_score)
        result["title_name"] = _main_t["name"]
        result["title_level"] = _main_t["level"]
        result["title_emoji"] = _main_t.get("emoji", "")
        result["title_color"] = _main_t.get("color", "default")
        result["next_title_name"] = _progress["next"]["name"] if _progress["next"] else None
        result["title_progress"] = _progress["progress_percent"]

    else:  # ── 教师/管理员 ──
        exam_where = ""
        exam_params: list[Any] = []
        if role == 1:
            exam_where = "WHERE creator_username = ?"
            exam_params.append(username)

        exam_total = _q_count(
            f"SELECT COUNT(*) FROM exams {exam_where}",
            tuple(exam_params),
        )
        exam_draft = _q_count(
            f"SELECT COUNT(*) FROM exams {exam_where} {'AND' if exam_where else 'WHERE'} status='draft'",
            tuple(exam_params) if role == 1 else (),
        )
        exam_published = _q_count(
            f"SELECT COUNT(*) FROM exams {exam_where} {'AND' if exam_where else 'WHERE'} status='published'",
            tuple(exam_params) if role == 1 else (),
        )
        exam_ended = _q_count(
            f"SELECT COUNT(*) FROM exams {exam_where} {'AND' if exam_where else 'WHERE'} status='ended'",
            tuple(exam_params) if role == 1 else (),
        )

        if role == 0:
            total_submissions = _db_count("SELECT COUNT(*) FROM task_submissions")
        else:
            total_submissions = _db_count(
                """SELECT COUNT(*) FROM task_submissions ts
                   JOIN tasks t ON ts.task_id = t.id
                   WHERE t.creator_username = ?""",
                (username,),
            )

        if role == 0:
            active_task_count = _db_count(
                "SELECT COUNT(*) FROM tasks WHERE status = 'active'",
            )
        else:
            active_task_count = _db_count(
                "SELECT COUNT(*) FROM tasks WHERE creator_username = ? AND status = 'active'",
                (username,),
            )

        if role == 1:
            # 教师：基于统一权限服务统计管辖学生数
            from backend.permission_service import get_students_in_scope
            _teacher_students = get_students_in_scope(username)
            _teacher_student_names = [s["username"] for s in _teacher_students]
            total_students = len(_teacher_student_names)
        else:
            total_students = _db_count("SELECT COUNT(*) FROM users WHERE role = 2")

        if role == 0:
            total_teachers = _db_count("SELECT COUNT(*) FROM users WHERE role = 1")
        else:
            total_teachers = 0

        if role == 0:
            total_rollcalls = execute_query(
                "SELECT COUNT(*) FROM rollcall_history",
            )
        else:
            total_rollcalls = execute_query(
                "SELECT COUNT(*) FROM rollcall_history WHERE teacher_username = ?",
                (username,),
            )
        total_rollcalls = total_rollcalls[0][0] if total_rollcalls else 0

        today_chat_count = _db_count(
            "SELECT COUNT(*) FROM conversations WHERE date = ?",
            (today_str,),
        )

        # ── 课堂互动数据 ──
        if role == 0:
            quiz_count = _db_count("SELECT COUNT(*) FROM interaction_quizzes")
            active_quiz_count = _db_count("SELECT COUNT(*) FROM interaction_quizzes WHERE status = 'active'")
            poll_count = _db_count("SELECT COUNT(*) FROM interaction_polls WHERE status = 'active'")
            quiz_answer_count = _db_count("SELECT COUNT(*) FROM interaction_quiz_answers")
            poll_vote_count = _db_count("SELECT COUNT(*) FROM interaction_poll_votes")
        else:
            quiz_count = _db_count(
                "SELECT COUNT(*) FROM interaction_quizzes WHERE creator_username = ?", (username,),
            )
            active_quiz_count = _db_count(
                "SELECT COUNT(*) FROM interaction_quizzes WHERE creator_username = ? AND status = 'active'", (username,),
            )
            poll_count = _db_count(
                "SELECT COUNT(*) FROM interaction_polls WHERE creator_username = ? AND status = 'active'", (username,),
            )
            quiz_answer_count = _db_count(
                """SELECT COUNT(*) FROM interaction_quiz_answers a
                   JOIN interaction_quizzes q ON a.quiz_id = q.id
                   WHERE q.creator_username = ?""", (username,),
            )
            poll_vote_count = _db_count(
                """SELECT COUNT(*) FROM interaction_poll_votes v
                   JOIN interaction_polls p ON v.poll_id = p.id
                   WHERE p.creator_username = ?""", (username,),
            )

        # ── 分组讨论数据 ──
        if role == 0:
            discussion_total = _db_count("SELECT COUNT(*) FROM discussions")
            discussion_active = _db_count("SELECT COUNT(*) FROM discussions WHERE status='active'")
            discussion_member_count = _db_count("SELECT COUNT(*) FROM discussion_members")
        else:
            discussion_total = _db_count(
                """SELECT COUNT(*) FROM discussions WHERE creator_username=? OR creator_username IN (SELECT username FROM users WHERE role=0)""",
                (username,),
            )
            discussion_active = _db_count(
                """SELECT COUNT(*) FROM discussions WHERE status='active' AND (creator_username=? OR creator_username IN (SELECT username FROM users WHERE role=0))""",
                (username,),
            )
            discussion_member_count = _db_count(
                """SELECT COUNT(*) FROM discussion_members dm
                   JOIN discussion_groups dg ON dm.group_id = dg.id
                   JOIN discussions d ON dg.discussion_id = d.id
                   WHERE d.creator_username=? OR d.creator_username IN (SELECT username FROM users WHERE role=0)""",
                (username,),
            )

        # ── 智能练习统计（教师） ──
        if role == 0:
            practice_published = _q_count(
                "SELECT COUNT(*) FROM practice_sessions WHERE status='active'",
            )
            practice_submitted = _q_count(
                "SELECT COUNT(*) FROM practice_attempts",
            )
        else:
            practice_published = _q_count(
                "SELECT COUNT(*) FROM practice_sessions WHERE status='active' AND creator_username=?",
                (username,),
            )
            practice_submitted = _q_count(
                """SELECT COUNT(*) FROM practice_attempts pa
                   JOIN practice_sessions ps ON pa.session_id=ps.id
                   WHERE ps.creator_username=?""",
                (username,),
            )

        # ── 知识闯关统计（教师/管理员，quest_records 在 smartkb.db）──
        if role == 0:
            quest_total_count = _db_count("SELECT COUNT(*) FROM quest_records")
            quest_completed_count_t = _db_count("SELECT COUNT(*) FROM quest_records WHERE completed=1")
        else:
            # 教师：基于统一权限服务统计管辖学生的闯关记录
            if _teacher_student_names:
                ph_q = ",".join("?" for _ in _teacher_student_names)
                quest_total_count = _db_count(
                    f"SELECT COUNT(*) FROM quest_records WHERE student_username IN ({ph_q})",
                    tuple(_teacher_student_names),
                )
                quest_completed_count_t = _db_count(
                    f"SELECT COUNT(*) FROM quest_records WHERE completed=1 AND student_username IN ({ph_q})",
                    tuple(_teacher_student_names),
                )
            else:
                quest_total_count = 0
                quest_completed_count_t = 0

        # ── 知识抢答统计（教师/管理员） ──
        if role == 0:
            quick_quiz_total = _db_count("SELECT COUNT(*) FROM quick_quiz_rooms")
            quick_quiz_ended = _db_count("SELECT COUNT(*) FROM quick_quiz_rooms WHERE status='ended'")
        else:
            quick_quiz_total = _db_count(
                "SELECT COUNT(*) FROM quick_quiz_rooms WHERE creator_username=?",
                (username,),
            )
            quick_quiz_ended = _db_count(
                "SELECT COUNT(*) FROM quick_quiz_rooms WHERE creator_username=? AND status='ended'",
                (username,),
            )

        # ── 教师：基于统一权限统计课堂提问/回答 ──
        if role == 1 and _teacher_student_names:
            ph_t = ",".join("?" for _ in _teacher_student_names)
            _teacher_q_count = _db_count(
                f"""SELECT COUNT(*) FROM interaction_questions q
                    JOIN users u ON q.student_username = u.username AND u.role = 2
                    WHERE q.student_username IN ({ph_t})""",
                tuple(_teacher_student_names),
            )
            _teacher_pending_q_count = _db_count(
                f"""SELECT COUNT(*) FROM interaction_questions q
                    JOIN users u ON q.student_username = u.username AND u.role = 2
                    WHERE q.status = 'pending' AND q.student_username IN ({ph_t})""",
                tuple(_teacher_student_names),
            )
            _teacher_answer_count = _db_count(
                f"""SELECT COUNT(*) FROM interaction_question_answers a
                    JOIN interaction_questions q ON a.question_id = q.id
                    JOIN users u ON q.student_username = u.username AND u.role = 2
                    WHERE q.student_username IN ({ph_t})""",
                tuple(_teacher_student_names),
            )
            _teacher_approved_answer_count = _db_count(
                f"""SELECT COUNT(*) FROM interaction_question_answers a
                    JOIN interaction_questions q ON a.question_id = q.id
                    JOIN users u ON q.student_username = u.username AND u.role = 2
                    WHERE a.status = 'approved' AND q.student_username IN ({ph_t})""",
                tuple(_teacher_student_names),
            )
        elif role == 1:
            _teacher_q_count = 0
            _teacher_pending_q_count = 0
            _teacher_answer_count = 0
            _teacher_approved_answer_count = 0

        result.update({
            "exam_stats": {
                "total": exam_total,
                "draft": exam_draft,
                "published": exam_published,
                "ended": exam_ended,
            },
            "total_submissions": total_submissions,
            "active_task_count": active_task_count,
            "total_students": total_students,
            "total_teachers": total_teachers,
            "rollcall_this_week": total_rollcalls,
            "today_chat_count": today_chat_count,
            # 课堂互动
            "teacher_quiz_count": quiz_count,
            "teacher_active_quiz_count": active_quiz_count,
            "teacher_poll_count": poll_count,
            "teacher_quiz_answer_count": quiz_answer_count,
            "teacher_poll_vote_count": poll_vote_count,
            # 课堂提问/回答
            "teacher_question_count": _db_count("SELECT COUNT(*) FROM interaction_questions") if role == 0 else _teacher_q_count,
            "teacher_pending_question_count": _db_count("SELECT COUNT(*) FROM interaction_questions WHERE status = 'pending'") if role == 0 else _teacher_pending_q_count,
            "teacher_student_answer_count": _db_count("SELECT COUNT(*) FROM interaction_question_answers") if role == 0 else _teacher_answer_count,
            "teacher_approved_answer_count": _db_count("SELECT COUNT(*) FROM interaction_question_answers WHERE status = 'approved'") if role == 0 else _teacher_approved_answer_count,
            # 分组讨论
            "discussion_total": discussion_total,
            "discussion_active": discussion_active,
            "discussion_member_count": discussion_member_count,
            # 智能练习
            "practice_published": practice_published,
            "practice_submitted": practice_submitted,
            # 知识闯关
            "quest_total_count": quest_total_count,
            "quest_completed_count_t": quest_completed_count_t,
            # 知识抢答
            "quick_quiz_total": quick_quiz_total,
            "quick_quiz_ended": quick_quiz_ended,
            "online_count": get_online_count(),
            "shared_resources_count": _db_count(
                "SELECT COUNT(*) FROM shared_resources"
            ) if role == 0 else _db_count(
                "SELECT COUNT(*) FROM shared_resources WHERE owner_username=? OR share_scope='all' OR share_scope='staff' OR (share_scope='teacher' AND INSTR(target_users, ?)>0)",
                (username, username),
            ),
        })

        # 最近几场考试
        if role == 0:
            recent_exams = q_execute_query(
                """SELECT id, title, status, created_at, creator_username, creator_name
                   FROM exams ORDER BY created_at DESC LIMIT 3"""
            )
        else:
            # 教师：只看自己创建的考试
            recent_exams = q_execute_query(
                """SELECT id, title, status, created_at, creator_username, creator_name
                   FROM exams WHERE creator_username=?
                   ORDER BY created_at DESC LIMIT 3""",
                (username,),
            )
        result["recent_exams"] = [
            {
                "id": r["id"], "title": r["title"], "status": r["status"],
                "created_at": r["created_at"], "creator_username": r["creator_username"],
                "creator_name": r.get("creator_name", ""),
            }
            for r in recent_exams
        ]

        if role == 1:
            rows = execute_query(
                "SELECT grade, class FROM users WHERE username = ?",
                (username,),
            )
            if rows:
                result["teacher_grades"] = rows[0][0] or ""
                result["teacher_classes"] = rows[0][1] or ""
            # 获取教师任教学科
            from backend.permission_service import get_teacher_subjects
            subjects = get_teacher_subjects(username)
            result["teacher_subjects"] = subjects

    # 写入缓存
    _set_cache(cache_key, result)
    return result


@router.get("/recent-activity", summary="获取最近活动动态")
async def recent_activity(request: Request):
    """返回系统最近活动的时间线"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    activities = []
    now = datetime.now()

    if role == 2:  # 学生
        # 获取学生显示名（与 summary 逻辑一致）
        _display_name = user.get("name", "")
        if not _display_name or _display_name == username:
            name_row = execute_query(
                "SELECT name FROM users WHERE username=?",
                (username,),
            )
            _display_name = name_row[0][0] if name_row and name_row[0][0] else username

        # 最近的考试结果 (question_db 返回 dict)
        exam_activities = q_execute_query(
            """SELECT ea.submitted_at, e.title, ea.score, ea.total_score
               FROM exam_attempts ea
               JOIN exams e ON ea.exam_id = e.id
               WHERE ea.student_username = ? AND ea.submitted_at IS NOT NULL
               ORDER BY ea.submitted_at DESC LIMIT 5""",
            (username,),
        )
        for act in exam_activities:
            activities.append({
                "time": act['submitted_at'],
                "type": "exam",
                "title": f"完成了考试「{act['title']}」",
                "detail": f"得分 {act['score']}/{act['total_score']}",
            })

        # 最近的积分变化
        score_activities = execute_query(
            """SELECT updated_at, score, class_name
               FROM scores WHERE student_name = ?
               ORDER BY updated_at DESC LIMIT 5""",
            (_display_name,),
        )
        for act in score_activities:
            activities.append({
                "time": act[0],
                "type": "score",
                "title": f"课堂积分变动",
                "detail": f"{'获得' if act[1] > 0 else '扣除'} {abs(act[1])} 分",
            })

        # 最近的随堂测验结果
        quiz_activities = execute_query(
            """SELECT a.submitted_at, q.title, a.score
               FROM interaction_quiz_answers a
               JOIN interaction_quizzes q ON a.quiz_id = q.id
               WHERE a.student_username = ?
               ORDER BY a.submitted_at DESC LIMIT 5""",
            (username,),
        )
        for act in quiz_activities:
            activities.append({
                "time": act[0],
                "type": "quiz",
                "title": f"完成了随堂测验「{act[1]}」",
                "detail": f"得分 {act[2]} 分",
            })

        # 最近的投票参与
        vote_activities = execute_query(
            """SELECT v.created_at, p.question
               FROM interaction_poll_votes v
               JOIN interaction_polls p ON v.poll_id = p.id
               WHERE v.student_username = ?
               GROUP BY v.poll_id
               ORDER BY v.created_at DESC LIMIT 5""",
            (username,),
        )
        for act in vote_activities:
            activities.append({
                "time": act[0],
                "type": "poll",
                "title": f"参与了投票「{act[1]}」",
                "detail": "",
            })

        # 最近的讨论消息（仅最近30天）
        week_ago_ts = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        disc_activities = execute_query(
            """SELECT m.created_at, d.title, m.content, dg.group_index, dg.name
               FROM discussion_messages m
               JOIN discussion_groups dg ON m.group_id = dg.id
               JOIN discussions d ON dg.discussion_id = d.id
               JOIN discussion_members dm ON dm.group_id = dg.id AND dm.username = ?
               WHERE m.username = ? AND m.created_at >= ?
               ORDER BY m.created_at DESC LIMIT 5""",
            (username, username, week_ago_ts),
        )
        for act in disc_activities:
            activities.append({
                "time": act[0],
                "type": "discussion",
                "title": f"在讨论「{act[1]}」中发言",
                "detail": f"{act[2][:50]}{'...' if len(act[2]) > 50 else ''}",
            })

        # 最近加入的讨论
        join_activities = execute_query(
            """SELECT dm.joined_at, d.title
               FROM discussion_members dm
               JOIN discussion_groups dg ON dm.group_id = dg.id
               JOIN discussions d ON dg.discussion_id = d.id
               WHERE dm.username = ? AND dm.joined_at >= ?
               ORDER BY dm.joined_at DESC LIMIT 5""",
            (username, week_ago_ts),
        )
        for act in join_activities:
            activities.append({
                "time": act[0],
                "type": "discussion",
                "title": f"加入了讨论「{act[1]}」",
                "detail": "",
            })

        # 最近的知识闯关完成记录
        quest_activities = execute_query(
            """SELECT completed_at, score, correct_count, total_questions
               FROM quest_records
               WHERE student_username = ? AND completed != 0 AND completed_at IS NOT NULL
               ORDER BY completed_at DESC LIMIT 5""",
            (username,),
        )
        for act in quest_activities:
            activities.append({
                "time": act[0],
                "type": "quest",
                "title": "完成了知识闯关",
                "detail": f"答对 {act[2]}/{act[3]} 题，得分 {act[1]} 分",
            })

        # 最近的知识抢答参与记录
        qq_activities = execute_query(
            """SELECT qp.joined_at, qr.title, qp.total_score, qp.correct_count
               FROM quick_quiz_players qp
               JOIN quick_quiz_rooms qr ON qp.room_id = qr.id
               WHERE qp.student_username = ?
               ORDER BY qp.joined_at DESC LIMIT 5""",
            (username,),
        )
        for act in qq_activities:
            activities.append({
                "time": act[0],
                "type": "quick_quiz",
                "title": f"参与了知识抢答「{act[1]}」",
                "detail": f"得分 {act[2]} 分 · 答对 {act[3]} 题",
            })

        # 最近的智能练习记录
        practice_activities = q_execute_query(
            """SELECT pa.submitted_at, ps.title, pa.score, pa.total_score
               FROM practice_attempts pa
               JOIN practice_sessions ps ON pa.session_id = ps.id
               WHERE pa.student_username = ? AND pa.submitted_at IS NOT NULL
               ORDER BY pa.submitted_at DESC LIMIT 5""",
            (username,),
        )
        for act in practice_activities:
            activities.append({
                "time": act['submitted_at'],
                "type": "practice",
                "title": f"完成了智能练习「{act['title']}」",
                "detail": f"得分 {act['score']}/{act['total_score']}",
            })

        # 最近的课程练习（知识点练习）记录
        # 注：ai_practice_results 在 questions.db，knowledge_points 在 smartkb.db
        kp_raw = q_execute_query(
            """SELECT kp_id, submitted_at, score, total_score, accuracy
               FROM ai_practice_results
               WHERE student_username = ? AND submitted_at IS NOT NULL
               ORDER BY submitted_at DESC LIMIT 5""",
            (username,),
        )
        if kp_raw:
            k_ids = list(set(r['kp_id'] for r in kp_raw))
            k_name_map = {}
            if k_ids:
                ph = ",".join("?" for _ in k_ids)
                k_rows = execute_query(
                    f"SELECT id, name FROM knowledge_points WHERE id IN ({ph})",
                    tuple(k_ids),
                )
                for kr in k_rows:
                    k_name_map[kr[0]] = kr[1]
            for act in kp_raw:
                kp_name = k_name_map.get(act['kp_id'], f"知识点#{act['kp_id']}")
                activities.append({
                    "time": act['submitted_at'],
                    "type": "practice",
                    "title": f"完成了课程练习「{kp_name}」",
                    "detail": f"得分 {act['score']}/{act['total_score']} · 正确率 {act['accuracy']}%",
                })

    else:  # 教师/管理员
        # 最近的任务提交
        if role == 0:
            sub_activities = execute_query(
                """SELECT ts.submitted_at, t.name, ts.student_username
                   FROM task_submissions ts
                   JOIN tasks t ON ts.task_id = t.id
                   ORDER BY ts.submitted_at DESC LIMIT 10""",
            )
        else:
            sub_activities = execute_query(
                """SELECT ts.submitted_at, t.name, ts.student_username
                   FROM task_submissions ts
                   JOIN tasks t ON ts.task_id = t.id
                   WHERE t.creator_username = ?
                   ORDER BY ts.submitted_at DESC LIMIT 10""",
                (username,),
            )
        # 批量获取学生姓名
        sub_usernames = list(set(act[2] for act in sub_activities))
        sub_name_map = {}
        if sub_usernames:
            ph = ",".join("?" for _ in sub_usernames)
            u_rows = execute_query(
                f"SELECT username, name FROM users WHERE username IN ({ph})",
                tuple(sub_usernames),
            )
            for ur in u_rows:
                sub_name_map[ur[0]] = ur[1] or ur[0]
        for act in sub_activities:
            s_name = sub_name_map.get(act[2], act[2])
            activities.append({
                "time": act[0],
                "type": "task",
                "title": f"学生 {act[2]} {s_name} 提交了任务「{act[1]}」",
                "detail": "",
            })

        # 最近创建的考试 (question_db 返回 dict)
        if role == 0:
            exam_creations = q_execute_query(
                """SELECT created_at, title, status
                   FROM exams ORDER BY created_at DESC LIMIT 5""",
            )
        else:
            exam_creations = q_execute_query(
                """SELECT created_at, title, status
                   FROM exams WHERE creator_username = ?
                   ORDER BY created_at DESC LIMIT 5""",
                (username,),
            )
        for act in exam_creations:
            status_map = {"draft": "草稿", "published": "已发布", "ended": "已结束"}
            activities.append({
                "time": act['created_at'],
                "type": "exam",
                "title": f"创建了考试「{act['title']}」（{status_map.get(act['status'], act['status'])}）",
                "detail": "",
            })

        # 最近的点名记录
        if role == 0:
            rc_activities = execute_query(
                """SELECT created_at, student_name, result, class_name
                   FROM rollcall_history
                   ORDER BY created_at DESC LIMIT 5""",
            )
        else:
            rc_activities = execute_query(
                """SELECT created_at, student_name, result, class_name
                   FROM rollcall_history WHERE teacher_username = ?
                   ORDER BY created_at DESC LIMIT 5""",
                (username,),
            )
        for act in rc_activities:
            result_label = "正确" if act[2] == "1" else ("错误" if act[2] == "0" else act[2] or "待定")
            activities.append({
                "time": act[0],
                "type": "rollcall",
                "title": f"点名 {act[1]}",
                "detail": f"{act[3]} - {result_label}",
            })

        # 最近的随堂测验提交
        if role == 0:
            quiz_acts = execute_query(
                """SELECT a.submitted_at, q.title, a.student_username
                   FROM interaction_quiz_answers a
                   JOIN interaction_quizzes q ON a.quiz_id = q.id
                   ORDER BY a.submitted_at DESC LIMIT 5""",
            )
        else:
            quiz_acts = execute_query(
                """SELECT a.submitted_at, q.title, a.student_username
                   FROM interaction_quiz_answers a
                   JOIN interaction_quizzes q ON a.quiz_id = q.id
                   WHERE q.creator_username = ?
                   ORDER BY a.submitted_at DESC LIMIT 5""",
                (username,),
            )
        quiz_usernames = list(set(act[2] for act in quiz_acts))
        quiz_name_map = {}
        if quiz_usernames:
            ph = ",".join("?" for _ in quiz_usernames)
            u_rows = execute_query(
                f"SELECT username, name FROM users WHERE username IN ({ph})",
                tuple(quiz_usernames),
            )
            for ur in u_rows:
                quiz_name_map[ur[0]] = ur[1] or ur[0]
        for act in quiz_acts:
            s_name = quiz_name_map.get(act[2], act[2])
            activities.append({
                "time": act[0],
                "type": "quiz",
                "title": f"学生 {act[2]} {s_name} 完成了测验「{act[1]}」",
                "detail": "",
            })

        # 最近的投票活动
        if role == 0:
            poll_acts = execute_query(
                """SELECT v.created_at, p.question
                   FROM interaction_poll_votes v
                   JOIN interaction_polls p ON v.poll_id = p.id
                   GROUP BY v.poll_id
                   ORDER BY v.created_at DESC LIMIT 5""",
            )
        else:
            poll_acts = execute_query(
                """SELECT v.created_at, p.question
                   FROM interaction_poll_votes v
                   JOIN interaction_polls p ON v.poll_id = p.id
                   WHERE p.creator_username = ?
                   GROUP BY v.poll_id
                   ORDER BY v.created_at DESC LIMIT 5""",
                (username,),
            )
        for act in poll_acts:
            activities.append({
                "time": act[0],
                "type": "poll",
                "title": "有学生参与了投票",
                "detail": f"「{act[1]}」",
            })

        # 最近的讨论活动（仅最近30天，避免全表扫描）
        week_ago_ts = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        if role == 0:
            disc_acts = execute_query(
                """SELECT m.created_at, d.title, dg.group_index, m.username
                   FROM discussion_messages m
                   JOIN discussion_groups dg ON m.group_id = dg.id
                   JOIN discussions d ON dg.discussion_id = d.id
                   WHERE m.created_at >= ? AND m.msg_type IN ('text', 'ai_suggest')
                   ORDER BY m.created_at DESC LIMIT 5""",
                (week_ago_ts,),
            )
        else:
            disc_acts = execute_query(
                """SELECT m.created_at, d.title, dg.group_index, m.username
                   FROM discussion_messages m
                   JOIN discussion_groups dg ON m.group_id = dg.id
                   JOIN discussions d ON dg.discussion_id = d.id
                   WHERE m.created_at >= ?
                   AND (d.creator_username = ? OR d.creator_username IN (SELECT username FROM users WHERE role=0))
                   AND m.msg_type IN ('text', 'ai_suggest')
                   ORDER BY m.created_at DESC LIMIT 5""",
                (week_ago_ts, username),
            )
        seen_disc = set()
        for act in disc_acts:
            key = f"{act[0]}_{act[1]}"
            if key in seen_disc:
                continue
            seen_disc.add(key)
            sender = act[3] or "AI助教"
            activities.append({
                "time": act[0],
                "type": "discussion",
                "title": f"讨论「{act[1]}」{act[2] and f'第{act[2]}组' or ''}有新消息",
                "detail": f"来自 {sender}",
            })

        # 讨论创建/结束活动
        if role == 0:
            disc_events = execute_query(
                """SELECT created_at, title, 'created' as event_type FROM discussions WHERE created_at >= ?
                   UNION ALL
                   SELECT updated_at, title, 'ended' FROM discussions WHERE status='ended' AND updated_at >= ?
                   ORDER BY created_at DESC LIMIT 5""",
                (week_ago_ts, week_ago_ts),
            )
        else:
            disc_events = execute_query(
                """SELECT created_at, title, 'created' as event_type FROM discussions WHERE creator_username=? AND created_at >= ?
                   UNION ALL
                   SELECT updated_at, title, 'ended' FROM discussions WHERE creator_username=? AND status='ended' AND updated_at >= ?
                   ORDER BY created_at DESC LIMIT 5""",
                (username, week_ago_ts, username, week_ago_ts),
            )
        for act in disc_events:
            label = "创建了" if act[2] == "created" else "结束了"
            activities.append({
                "time": act[0],
                "type": "discussion",
                "title": f"{label}讨论「{act[1]}」",
                "detail": "",
            })

        # 最近的智能练习提交（学生提交到教师的练习）
        if role == 0:
            practice_acts = q_execute_query(
                """SELECT pa.submitted_at, ps.title, pa.student_username, pa.score, pa.total_score
                   FROM practice_attempts pa
                   JOIN practice_sessions ps ON pa.session_id = ps.id
                   WHERE pa.submitted_at IS NOT NULL
                   ORDER BY pa.submitted_at DESC LIMIT 5""",
            )
        else:
            practice_acts = q_execute_query(
                """SELECT pa.submitted_at, ps.title, pa.student_username, pa.score, pa.total_score
                   FROM practice_attempts pa
                   JOIN practice_sessions ps ON pa.session_id = ps.id
                   WHERE ps.creator_username = ? AND pa.submitted_at IS NOT NULL
                   ORDER BY pa.submitted_at DESC LIMIT 5""",
                (username,),
            )
        prac_usernames = list(set(act['student_username'] for act in practice_acts))
        prac_name_map = {}
        if prac_usernames:
            ph = ",".join("?" for _ in prac_usernames)
            u_rows = execute_query(
                f"SELECT username, name FROM users WHERE username IN ({ph})",
                tuple(prac_usernames),
            )
            for ur in u_rows:
                prac_name_map[ur[0]] = ur[1] or ur[0]
        for act in practice_acts:
            s_name = prac_name_map.get(act['student_username'], act['student_username'])
            activities.append({
                "time": act['submitted_at'],
                "type": "practice",
                "title": f"学生 {act['student_username']} {s_name} 完成了智能练习",
                "detail": f"「{act['title']}」得分 {act['score']}/{act['total_score']}",
            })

        # 最近的知识抢答活动
        if role == 0:
            qq_acts = execute_query(
                """SELECT qr.ended_at, qr.title, COUNT(qp.id) as player_count
                   FROM quick_quiz_rooms qr
                   LEFT JOIN quick_quiz_players qp ON qp.room_id = qr.id
                   WHERE qr.ended_at IS NOT NULL
                   GROUP BY qr.id
                   ORDER BY qr.ended_at DESC LIMIT 5""",
            )
        else:
            qq_acts = execute_query(
                """SELECT qr.ended_at, qr.title, COUNT(qp.id) as player_count
                   FROM quick_quiz_rooms qr
                   LEFT JOIN quick_quiz_players qp ON qp.room_id = qr.id
                   WHERE qr.creator_username = ? AND qr.ended_at IS NOT NULL
                   GROUP BY qr.id
                   ORDER BY qr.ended_at DESC LIMIT 5""",
                (username,),
            )
        for act in qq_acts:
            activities.append({
                "time": act[0],
                "type": "quick_quiz",
                "title": f"知识抢答「{act[1]}」已结束",
                "detail": f"{act[2]} 人参与",
            })

        # 最近的课程练习（知识点练习）完成记录
        from backend.permission_service import get_students_in_scope
        cp_students = get_students_in_scope(username)
        cp_student_names = [s["username"] for s in cp_students]
        ph = ",".join("?" for _ in cp_student_names) if cp_student_names else ""
        if cp_student_names:
            cp_acts = q_execute_query(
                f"""SELECT ar.submitted_at, ar.student_username, ar.score, ar.total_score, ar.accuracy
                    FROM ai_practice_results ar
                    WHERE ar.submitted_at IS NOT NULL AND ar.student_username IN ({ph})
                    ORDER BY ar.submitted_at DESC LIMIT 10""",
                tuple(cp_student_names),
            )
        else:
            cp_acts = []
        # 批量获取学生姓名
        cp_usernames = list(set(act['student_username'] for act in cp_acts))
        cp_name_map = {}
        if cp_usernames:
            ph3 = ",".join("?" for _ in cp_usernames)
            u_rows = execute_query(
                f"SELECT username, name FROM users WHERE username IN ({ph3})",
                tuple(cp_usernames),
            )
            for ur in u_rows:
                cp_name_map[ur[0]] = ur[1] or ur[0]
        for act in cp_acts:
            s_name = cp_name_map.get(act['student_username'], act['student_username'])
            activities.append({
                "time": act['submitted_at'],
                "type": "practice",
                "title": f"学生 {act['student_username']} {s_name} 完成了课程练习",
                "detail": f"得分 {act['score']}/{act['total_score']} · 正确率 {act['accuracy']}%",
            })

        # 最近的知识闯关完成记录
        if cp_student_names:
            quest_acts = execute_query(
                f"""SELECT qr.completed_at, qr.student_username, qr.score, qr.correct_count, qr.total_questions
                    FROM quest_records qr
                    WHERE qr.student_username IN ({ph}) AND qr.completed != 0 AND qr.completed_at IS NOT NULL
                    ORDER BY qr.completed_at DESC LIMIT 10""",
                tuple(cp_student_names),
            )
        else:
            quest_acts = []
        quest_usernames = list(set(act[1] for act in quest_acts))
        quest_name_map = {}
        if quest_usernames:
            ph2 = ",".join("?" for _ in quest_usernames)
            u_rows2 = execute_query(
                f"SELECT username, name FROM users WHERE username IN ({ph2})",
                tuple(quest_usernames),
            )
            for ur in u_rows2:
                quest_name_map[ur[0]] = ur[1] or ur[0]
        for act in quest_acts:
            s_name = quest_name_map.get(act[1], act[1])
            activities.append({
                "time": act[0],
                "type": "quest",
                "title": f"学生 {act[1]} {s_name} 完成了知识闯关",
                "detail": f"答对 {act[3]}/{act[4]} 题，得分 {act[2]} 分",
            })

    # 按时间排序
    # 修复时间格式：如果只有时间没有日期，跳过（无法确定真实日期）
    activities = [
        a for a in activities
        if not (len(a.get("time") or "") <= 10 and ":" in (a.get("time") or ""))
    ]
    activities.sort(key=lambda x: x["time"] or "", reverse=True)
    return activities[:20]


