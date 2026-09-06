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
from backend.permission_service import get_user_grade_class

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


def _act_q(sql: str, params=()):
    """recent-activity 单源容错查询: 任何数据源失败只丢该源并记日志, 不再整体 500;
    同时天然兜住空范围 IN () 等非法 SQL(K5)"""
    try:
        return execute_query(sql, tuple(params) if params else ())
    except Exception as e:
        logger.warning(f"[recent-activity] 数据源查询失败已跳过: {e} | SQL={sql.strip()[:120]}")
        return []


def _act_q_db(sql: str, params=()):
    """同上, 题库库(questions.db)版本"""
    try:
        return q_execute_query(sql, tuple(params) if params else ())
    except Exception as e:
        logger.warning(f"[recent-activity] 题库数据源查询失败已跳过: {e} | SQL={sql.strip()[:120]}")
        return []


def _student_labels(usernames: list[Any]) -> dict[str, dict[str, str]]:
    """批量解析学生标识(实现已上移到 permission_service, 与全站共用一份)"""
    from backend.permission_service import get_student_identity
    return get_student_identity(usernames)


def _with_tag(tag: str, detail: str) -> str:
    """把年级·班级拼到 detail 前面, 缺任一侧时不留孤立分隔符"""
    if tag and detail:
        return f"{tag} · {detail}"
    return tag or detail


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

    # 尝试从缓存读取（教师按年级/班级分别缓存）
    grade_param = request.query_params.get("grade", "")
    class_param = request.query_params.get("class", "")
    cache_key = f"{role}:{username}:{grade_param}:{class_param}"
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

    grade = grade_param
    cls = class_param

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
        grade_row2 = execute_query("SELECT grade_id, class_id FROM users WHERE username=?", (username,))
        grade_id2 = grade_row2[0][0] if grade_row2 else None
        class_id2 = grade_row2[0][1] if grade_row2 and len(grade_row2[0]) > 1 else None
        if grade_id2:
            # 通过 teacher_assignments 找到任教教师
            if class_id2:
                ta_rows = execute_query(
                    """SELECT DISTINCT teacher_username FROM teacher_assignments
                       WHERE grade_id=? AND (class_id=? OR class_id IS NULL)""",
                    (grade_id2, class_id2),
                )
            else:
                ta_rows = execute_query(
                    """SELECT DISTINCT teacher_username FROM teacher_assignments
                       WHERE grade_id=?""",
                    (grade_id2,),
                )
            teacher_names = [r[0] for r in ta_rows] if ta_rows else []
            # 管理员也算
            admin_rows = execute_query("SELECT username FROM users WHERE role=0")
            admin_names = [r[0] for r in admin_rows] if admin_rows else []
            allowed_creators = admin_names + teacher_names
            if allowed_creators:
                placeholders = ",".join("?" for _ in allowed_creators)
                active_quiz_count = _db_count(
                    f"""SELECT COUNT(*) FROM interaction_quizzes q
                        WHERE q.status = 'active'
                        AND q.creator_username IN ({placeholders})
                        AND q.id NOT IN (SELECT quiz_id FROM interaction_quiz_answers WHERE student_username = ?)""",
                    tuple(allowed_creators + [username]),
                )
            else:
                active_quiz_count = 0
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
        if grade_id2:
            # 复用上面 already computed allowed_creators
            if allowed_creators:
                ph2 = ",".join("?" for _ in allowed_creators)
                active_discussion_count = _db_count(
                    f"""SELECT COUNT(*) FROM discussions
                       WHERE status='active' AND creator_username IN ({ph2})""",
                    tuple(allowed_creators),
                )
            else:
                active_discussion_count = 0
        else:
            active_discussion_count = 0

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
                """SELECT COUNT(*) FROM shared_resources sr
                   WHERE (sr.share_scope='all'
                        OR (sr.share_scope='class' AND (sr.target_grade=? OR INSTR(sr.target_grade, ?)>0) AND (sr.target_class='' OR sr.target_class IS NULL OR sr.target_class=? OR INSTR(sr.target_class, ?)>0))
                        OR (sr.share_scope='teacher' AND INSTR(sr.target_users, ?)>0))
                     AND NOT EXISTS (
                       SELECT 1 FROM resource_view_logs rvl
                       WHERE rvl.student_username=?
                         AND rvl.resource_type=sr.resource_type
                         AND rvl.resource_id=sr.id
                     )""",
                (grade, grade, cls, cls, username, username) if grade else ("", "", "", "", "", username),
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
                "SELECT COUNT(*) FROM discussions WHERE creator_username=?",
                (username,),
            )
            discussion_active = _db_count(
                "SELECT COUNT(*) FROM discussions WHERE status='active' AND creator_username=?",
                (username,),
            )
            discussion_member_count = _db_count(
                """SELECT COUNT(*) FROM discussion_members dm
                   JOIN discussion_groups dg ON dm.group_id = dg.id
                   JOIN discussions d ON dg.discussion_id = d.id
                   WHERE d.creator_username=?""",
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
    """返回系统最近活动的时间线(30 秒缓存, 与 summary 同策略)"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    act_cache_key = f"act:{role}:{username}"
    cached_act = _get_cached(act_cache_key)
    if cached_act is not None:
        return cached_act

    activities = []
    now = datetime.now()

    if role == 2:  # 学生
        # 获取学生显示名（与 summary 逻辑一致）
        _display_name = user.get("name", "")
        if not _display_name or _display_name == username:
            name_row = _act_q(
                "SELECT name FROM users WHERE username=?",
                (username,),
            )
            _display_name = name_row[0][0] if name_row and name_row[0][0] else username

        # 最近的考试结果 (question_db 返回 dict)
        exam_activities = _act_q_db(
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
        score_activities = _act_q(
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
        quiz_activities = _act_q(
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
        vote_activities = _act_q(
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
        disc_activities = _act_q(
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
        join_activities = _act_q(
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
        quest_activities = _act_q(
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
        qq_activities = _act_q(
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
        practice_activities = _act_q_db(
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
        kp_raw = _act_q_db(
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
                k_rows = _act_q(
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

        # 最近的资源浏览记录
        try:
            rv_acts = _act_q(
                """SELECT rvl.viewed_at, rvl.resource_type,
                          COALESCE(sr.file_name, rvl.file_path) as resource_name
                   FROM resource_view_logs rvl
                   LEFT JOIN shared_resources sr ON rvl.resource_id=sr.id AND rvl.resource_type=sr.resource_type
                   WHERE rvl.student_username=?
                   ORDER BY rvl.viewed_at DESC LIMIT 5""",
                (username,),
            )
            for act in rv_acts:
                res_type_label = "HTML 资源" if act[1] == "html" else "下载文件"
                activities.append({
                    "time": act[0],
                    "type": "resource_view",
                    "title": f"浏览了{res_type_label}",
                    "detail": f"「{act[2][:40]}{'...' if len(act[2]) > 40 else ''}」",
                })
        except Exception as e:
            logger.warning(f"[recent-activity] 查询资源浏览记录失败: {e}")

    else:  # 教师/管理员
        # 最近的任务提交
        if role == 0:
            sub_activities = _act_q(
                """SELECT ts.submitted_at, t.name, ts.student_username
                   FROM task_submissions ts
                   JOIN tasks t ON ts.task_id = t.id
                   ORDER BY ts.submitted_at DESC LIMIT 10""",
            )
        else:
            sub_activities = _act_q(
                """SELECT ts.submitted_at, t.name, ts.student_username
                   FROM task_submissions ts
                   JOIN tasks t ON ts.task_id = t.id
                   WHERE t.creator_username = ?
                   ORDER BY ts.submitted_at DESC LIMIT 10""",
                (username,),
            )
        sub_info = _student_labels([act[2] for act in sub_activities])
        for act in sub_activities:
            info = sub_info.get(act[2]) or {}
            activities.append({
                "time": act[0],
                "type": "task",
                "title": f"学生 {act[2]} {info.get('name') or act[2]} 提交了任务「{act[1]}」",
                "detail": info.get("tag", ""),
            })

        # 最近创建的考试 (question_db 返回 dict)
        if role == 0:
            exam_creations = _act_q_db(
                """SELECT created_at, title, status
                   FROM exams ORDER BY created_at DESC LIMIT 5""",
            )
        else:
            exam_creations = _act_q_db(
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
            rc_activities = _act_q(
                """SELECT created_at, student_name, result, class_name
                   FROM rollcall_history
                   ORDER BY created_at DESC LIMIT 5""",
            )
        else:
            rc_activities = _act_q(
                """SELECT created_at, student_name, result, class_name
                   FROM rollcall_history WHERE teacher_username = ?
                   ORDER BY created_at DESC LIMIT 5""",
                (username,),
            )
        for act in rc_activities:
            # 点名结果实际存的是 correct/incorrect/skip 文本, 旧代码按 "1"/"0" 判定,
            # 永远落到兜底分支 -> 教师看到的是英文原文 correct
            _rc_map = {"correct": "正确", "incorrect": "错误", "skip": "跳过",
                       "picked": "已点名", "quiz": "随堂作答", "1": "正确", "0": "错误"}
            result_label = _rc_map.get(str(act[2] or "").strip().lower(), act[2] or "待定")
            activities.append({
                "time": act[0],
                "type": "rollcall",
                "title": f"点名 {act[1]}",
                "detail": f"{act[3]} - {result_label}",
            })

        # 最近的随堂测验提交
        if role == 0:
            quiz_acts = _act_q(
                """SELECT a.submitted_at, q.title, a.student_username
                   FROM interaction_quiz_answers a
                   JOIN interaction_quizzes q ON a.quiz_id = q.id
                   ORDER BY a.submitted_at DESC LIMIT 5""",
            )
        else:
            quiz_acts = _act_q(
                """SELECT a.submitted_at, q.title, a.student_username
                   FROM interaction_quiz_answers a
                   JOIN interaction_quizzes q ON a.quiz_id = q.id
                   WHERE q.creator_username = ?
                   ORDER BY a.submitted_at DESC LIMIT 5""",
                (username,),
            )
        quiz_info = _student_labels([act[2] for act in quiz_acts])
        for act in quiz_acts:
            info = quiz_info.get(act[2]) or {}
            activities.append({
                "time": act[0],
                "type": "quiz",
                "title": f"学生 {act[2]} {info.get('name') or act[2]} 完成了测验「{act[1]}」",
                "detail": info.get("tag", ""),
            })

        # 最近的投票活动
        # B2: 旧写法 SELECT 里没取投票者却按 poll_id 分组, 返回的是不确定行,
        # 教师只看到"有学生参与了投票"却不知道是谁。改为取每个投票的最新一票。
        _latest_vote = """SELECT v.created_at, p.question, v.student_username
                   FROM interaction_poll_votes v
                   JOIN interaction_polls p ON v.poll_id = p.id
                   JOIN (SELECT MAX(id) AS mid FROM interaction_poll_votes GROUP BY poll_id) t
                     ON v.id = t.mid"""
        if role == 0:
            poll_acts = _act_q(_latest_vote + " ORDER BY v.created_at DESC LIMIT 5")
        else:
            poll_acts = _act_q(
                _latest_vote + " WHERE p.creator_username = ? ORDER BY v.created_at DESC LIMIT 5",
                (username,),
            )
        poll_info = _student_labels([act[2] for act in poll_acts])
        for act in poll_acts:
            su = str(act[2] or "")
            info = poll_info.get(su) or {}
            who = f"学生 {su} {info.get('name') or ''}".strip() if su else "有学生"
            activities.append({
                "time": act[0],
                "type": "poll",
                "title": f"{who} 参与了投票",
                "detail": _with_tag(info.get("tag", ""), f"「{act[1]}」"),
            })

        # 最近的讨论活动（仅最近30天，避免全表扫描）
        week_ago_ts = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        if role == 0:
            disc_acts = _act_q(
                """SELECT m.created_at, d.title, dg.group_index, m.username
                   FROM discussion_messages m
                   JOIN discussion_groups dg ON m.group_id = dg.id
                   JOIN discussions d ON dg.discussion_id = d.id
                   WHERE m.created_at >= ? AND m.msg_type IN ('text', 'ai_suggest')
                   ORDER BY m.created_at DESC LIMIT 5""",
                (week_ago_ts,),
            )
        else:
            disc_acts = _act_q(
                """SELECT m.created_at, d.title, dg.group_index, m.username
                   FROM discussion_messages m
                   JOIN discussion_groups dg ON m.group_id = dg.id
                   JOIN discussions d ON dg.discussion_id = d.id
                   WHERE m.created_at >= ?
                   AND d.creator_username = ?
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
            disc_events = _act_q(
                """SELECT created_at, title, 'created' as event_type FROM discussions WHERE created_at >= ?
                   UNION ALL
                   SELECT updated_at, title, 'ended' FROM discussions WHERE status='ended' AND updated_at >= ?
                   ORDER BY created_at DESC LIMIT 5""",
                (week_ago_ts, week_ago_ts),
            )
        else:
            disc_events = _act_q(
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
            practice_acts = _act_q_db(
                """SELECT pa.submitted_at, ps.title, pa.student_username, pa.score, pa.total_score
                   FROM practice_attempts pa
                   JOIN practice_sessions ps ON pa.session_id = ps.id
                   WHERE pa.submitted_at IS NOT NULL
                   ORDER BY pa.submitted_at DESC LIMIT 5""",
            )
        else:
            practice_acts = _act_q_db(
                """SELECT pa.submitted_at, ps.title, pa.student_username, pa.score, pa.total_score
                   FROM practice_attempts pa
                   JOIN practice_sessions ps ON pa.session_id = ps.id
                   WHERE ps.creator_username = ? AND pa.submitted_at IS NOT NULL
                   ORDER BY pa.submitted_at DESC LIMIT 5""",
                (username,),
            )
        prac_info = _student_labels([act['student_username'] for act in practice_acts])
        for act in practice_acts:
            su = act['student_username']
            info = prac_info.get(su) or {}
            activities.append({
                "time": act['submitted_at'],
                "type": "practice",
                "title": f"学生 {su} {info.get('name') or su} 完成了智能练习",
                "detail": _with_tag(info.get("tag", ""), f"「{act['title']}」得分 {act['score']}/{act['total_score']}"),
            })

        # 最近的知识抢答活动
        if role == 0:
            qq_acts = _act_q(
                """SELECT qr.ended_at, qr.title, COUNT(qp.id) as player_count
                   FROM quick_quiz_rooms qr
                   LEFT JOIN quick_quiz_players qp ON qp.room_id = qr.id
                   WHERE qr.ended_at IS NOT NULL
                   GROUP BY qr.id
                   ORDER BY qr.ended_at DESC LIMIT 5""",
            )
        else:
            qq_acts = _act_q(
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
            cp_acts = _act_q_db(
                f"""SELECT ar.submitted_at, ar.student_username, ar.score, ar.total_score, ar.accuracy
                    FROM ai_practice_results ar
                    WHERE ar.submitted_at IS NOT NULL AND ar.student_username IN ({ph})
                    ORDER BY ar.submitted_at DESC LIMIT 10""",
                tuple(cp_student_names),
            )
        else:
            cp_acts = []
        cp_info = _student_labels([act['student_username'] for act in cp_acts])
        for act in cp_acts:
            su = act['student_username']
            info = cp_info.get(su) or {}
            activities.append({
                "time": act['submitted_at'],
                "type": "practice",
                "title": f"学生 {su} {info.get('name') or su} 完成了课程练习",
                "detail": _with_tag(info.get("tag", ""),
                                    f"得分 {act['score']}/{act['total_score']} · 正确率 {act['accuracy']}%"),
            })

        # 最近的知识闯关完成记录
        if cp_student_names:
            quest_acts = _act_q(
                f"""SELECT qr.completed_at, qr.student_username, qr.score, qr.correct_count, qr.total_questions
                    FROM quest_records qr
                    WHERE qr.student_username IN ({ph}) AND qr.completed != 0 AND qr.completed_at IS NOT NULL
                    ORDER BY qr.completed_at DESC LIMIT 10""",
                tuple(cp_student_names),
            )
        else:
            quest_acts = []
        quest_info = _student_labels([act[1] for act in quest_acts])
        for act in quest_acts:
            info = quest_info.get(act[1]) or {}
            activities.append({
                "time": act[0],
                "type": "quest",
                "title": f"学生 {act[1]} {info.get('name') or act[1]} 完成了知识闯关",
                "detail": _with_tag(info.get("tag", ""), f"答对 {act[3]}/{act[4]} 题，得分 {act[2]} 分"),
            })

        # 最近的资源浏览记录
        try:
            if cp_student_names:
                rv_acts = _act_q(
                    f"""SELECT rvl.viewed_at, rvl.student_username, rvl.resource_type,
                               COALESCE(sr.file_name, rvl.file_path) as resource_name
                        FROM resource_view_logs rvl
                        LEFT JOIN shared_resources sr ON rvl.resource_id=sr.id AND rvl.resource_type=sr.resource_type
                        WHERE rvl.student_username IN ({ph})
                        ORDER BY rvl.viewed_at DESC LIMIT 10""",
                    tuple(cp_student_names),
                )
            else:
                rv_acts = []
            rv_info = _student_labels([act[1] for act in rv_acts])
            for act in rv_acts:
                info = rv_info.get(act[1]) or {}
                res_type_label = "HTML 资源" if act[2] == "html" else "下载文件"
                res_name = str(act[3] or "")
                activities.append({
                    "time": act[0],
                    "type": "resource_view",
                    "title": f"学生 {act[1]} {info.get('name') or act[1]} 浏览了{res_type_label}",
                    "detail": _with_tag(info.get("tag", ""),
                                        f"「{res_name[:40]}{'...' if len(res_name) > 40 else ''}」"),
                })
        except Exception as e:
            logger.warning(f"[recent-activity] 查询资源浏览记录失败: {e}")

    # 按时间排序
    # 修复时间格式：如果只有时间没有日期，跳过（无法确定真实日期）
    activities = [
        a for a in activities
        if not (len(a.get("time") or "") <= 10 and ":" in (a.get("time") or ""))
    ]
    # 兜底去重: 同事件多源写入(如浏览日志历史双写)不再重复成多条动态
    _seen = set()
    _deduped = []
    for a in activities:
        k = (a.get("time") or "", a.get("type") or "", a.get("title") or "", a.get("detail") or "")
        if k in _seen:
            continue
        _seen.add(k)
        _deduped.append(a)
    _deduped.sort(key=lambda x: x["time"] or "", reverse=True)
    result = _deduped[:20]
    _set_cache(act_cache_key, result)
    return result


# ══════════════════════════════════════════════════════════════════
# 学生任务清单 API（待办聚合）
# ══════════════════════════════════════════════════════════════════


@router.get("/task-todo", summary="获取学生任务清单（待办聚合）")
async def get_task_todo(request: Request):
    """聚合所有待办事项，按类型分组排序返回"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        # 目前仅对学生开放，教师/管理员返回空
        return {"items": [], "counts": {}, "stats": {}}

    # 尝试缓存
    cache_key = f"todo:{username}"
    cached = _get_cached(cache_key)
    if cached is not None:
        return cached

    now = datetime.now()
    today_str = now.strftime("%Y-%m-%d")
    items: list[dict[str, Any]] = []

    # 获取学生年级班级信息
    grade, cls = get_user_grade_class(username)
    grade_row = execute_query("SELECT grade_id, class_id FROM users WHERE username=?", (username,))
    grade_id = grade_row[0][0] if grade_row else None
    class_id = grade_row[0][1] if grade_row and len(grade_row[0]) > 1 else None

    # ── 1. 待考试 ──
    try:
        pending_exams = q_execute_query(
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
               ORDER BY e.end_time IS NULL, e.end_time ASC""",
            (today_str, today_str, username),
        )
        for ex in pending_exams:
            deadline = ex.get("end_time") or ex.get("start_time")
            items.append({
                "id": f"exam-{ex['id']}",
                "type": "exam",
                "title": ex["title"],
                "description": f"{ex.get('subject','')} · {ex['duration']}分钟 · {ex['total_score']}分",
                "subject": ex.get("subject", ""),
                "status": "pending",
                "priority": 90 if deadline and deadline <= today_str else 70,
                "deadline": deadline,
                "url": f"/exam-take/{ex['id']}",
                "action_label": "开始考试",
                "meta": {"duration": ex["duration"], "total_score": ex["total_score"]},
            })
    except Exception as e:
        logger.warning(f"[task-todo] 查询考试失败: {e}")

    # ── 2. 待提交任务 ──
    try:
        from backend.api.tasks_router import get_all_tasks, get_user_relevant_tasks
        all_active = get_all_tasks()
        relevant = get_user_relevant_tasks(username, all_active)
        for tk in relevant:
            has_submitted = _db_count(
                "SELECT COUNT(*) FROM task_submissions WHERE task_id=? AND student_username=?",
                (tk["id"], username),
            )
            if has_submitted == 0:
                items.append({
                    "id": f"task-{tk['id']}",
                    "type": "task",
                    "title": tk["name"],
                    "description": tk.get("description", "") or "教师布置的任务",
                    "subject": "",
                    "status": "pending",
                    "priority": 65,
                    "deadline": None,
                    "url": "/tasks",
                    "action_label": "去提交",
                    "meta": {},
                })
    except Exception as e:
        logger.warning(f"[task-todo] 查询任务失败: {e}")

    # ── 3. 待完成智能练习 ──
    try:
        pending_practices = q_execute_query(
            """SELECT ps.id, ps.title, ps.subject, ps.question_count, ps.total_score,
                      ps.source, ps.target_students
               FROM practice_sessions ps
               WHERE ps.status='active'
                 AND ps.id NOT IN (
                   SELECT session_id FROM practice_attempts WHERE student_username=?
                 )
               ORDER BY ps.created_at DESC""",
            (username,),
        )
        for pp in pending_practices:
            # 定向练习（target_students 不为空）仅对指定学生可见
            target = (pp.get("target_students") or "").strip()
            if target:
                target_list = [u.strip() for u in target.split(",") if u.strip()]
                if username not in target_list:
                    continue
            # 错题巩固练习（source='wrong_book'）仅对目标学生可见
            if pp.get("source") == "wrong_book" and not target:
                continue
            items.append({
                "id": f"practice-{pp['id']}",
                "type": "practice",
                "title": pp["title"],
                "description": f"{pp.get('subject','信息科技')} · {pp['question_count']}题 · {pp['total_score']}分",
                "subject": pp.get("subject", ""),
                "status": "pending",
                "priority": 60,
                "deadline": None,
                "url": "/practice",
                "action_label": "开始练习",
                "meta": {"question_count": pp["question_count"]},
            })
    except Exception as e:
        logger.warning(f"[task-todo] 查询练习失败: {e}")

    # ── 4. 待完成代码练习 ──
    try:
        from backend.permission_service import is_student_in_teacher_scope
        si = execute_query("SELECT grade,class FROM users WHERE username=?", (username,))
        if si:
            tu = execute_query("SELECT username FROM users WHERE role=1")
            at = []
            for t in tu:
                tn = str(t[0])
                if is_student_in_teacher_scope(username, tn):
                    at.append(tn)
            au = execute_query("SELECT username FROM users WHERE role=0")
            an = [str(a[0]) for a in au] if au else []
            aa = an + at
            if aa:
                ph = ",".join("?" for _ in aa)
                pending_codes = q_execute_query(
                    f"""SELECT cp.id, cp.title, cp.subject, cp.difficulty, cp.language
                        FROM code_problems cp
                        WHERE cp.status='active'
                          AND cp.creator_username IN ({ph})
                          AND cp.id NOT IN (
                            SELECT cs.problem_id FROM code_submissions cs
                            WHERE cs.student_username=? AND cs.is_best=1 AND cs.status='accepted'
                          )
                        ORDER BY cp.id DESC""",
                    tuple(aa + [username]),
                )
                for pc in pending_codes:
                    items.append({
                        "id": f"code-{pc['id']}",
                        "type": "code",
                        "title": pc["title"],
                        "description": f"{pc.get('subject','')} · {pc.get('language','')} · {pc.get('difficulty','')}",
                        "subject": pc.get("subject", ""),
                        "status": "pending",
                        "priority": 55,
                        "deadline": None,
                        "url": "/code-practice",
                        "action_label": "去练习",
                        "meta": {"difficulty": pc.get("difficulty")},
                    })
    except Exception as e:
        logger.warning(f"[task-todo] 查询代码练习失败: {e}")

    # ── 5/6. 课程学习：统计未完成的 AI 练习资源（_练习.html） ──
    # 先用 SQL 查出年级匹配的 HTML 绑定 + 文件路径，再到 Python 端过滤：
    #   1) 文件名含 _练习.html 的
    #   2) 排除已在 ai_practice_results 中完成的
    try:
        # 先查 question_db：该学生已完成的练习（按知识点）
        done_kp_ids = set(
            row['kp_id'] for row in q_execute_query(
                "SELECT DISTINCT kp_id FROM ai_practice_results WHERE student_username=?",
                (username,),
            )
        )
        # 再查 smartkb.db：年级匹配的所有 HTML 绑定
        if grade:
            raw = execute_query(
                """SELECT cb.id, cb.knowledge_point_id, kp.name, c.name,
                          COALESCE(sr.file_path, '') as fp,
                          COALESCE(sr.file_name, '') as fn
                   FROM curriculum_bindings cb
                   JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
                   JOIN chapters ch ON kp.chapter_id = ch.id
                   JOIN courses c ON ch.course_id = c.id
                   LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
                   WHERE cb.resource_type='html'
                     AND c.status='active'
                     AND (c.grade = '' OR INSTR(c.grade, ?) > 0)
                   ORDER BY c.sort_order, ch.sort_order, kp.sort_order, cb.id
                   LIMIT 50""",
                (grade,),
            )
        else:
            raw = execute_query(
                """SELECT cb.id, cb.knowledge_point_id, kp.name, c.name,
                          COALESCE(sr.file_path, '') as fp,
                          COALESCE(sr.file_name, '') as fn
                   FROM curriculum_bindings cb
                   JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
                   JOIN chapters ch ON kp.chapter_id = ch.id
                   JOIN courses c ON ch.course_id = c.id
                   LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
                   WHERE cb.resource_type='html' AND c.status='active' AND c.grade=''
                   ORDER BY c.sort_order, ch.sort_order, kp.sort_order, cb.id
                   LIMIT 50""",
            )
        for b in raw:
            kp_id = b[1]          # knowledge_point_id
            fn = str(b[5] or '')  # file_name
            fp = str(b[4] or '')  # file_path
            # 条件1：文件名含 _练习.html
            if '_练习.html' not in fn and '_练习.html' not in fp:
                continue
            # 条件2：该知识点未完成练习
            if kp_id in done_kp_ids:
                continue
            # 用实际资源文件名作为显示名称
            practice_name = fn
            if practice_name.endswith('_练习.html'):
                practice_name = practice_name[:-len('_练习.html')]
            if not practice_name:
                practice_name = f"{b[3] or ''} - {b[2]}"
            file_path = fp.lstrip('/')
            resource_url = f"/api/files/{file_path}" if file_path else "/curriculum"
            items.append({
                "id": f"course_practice-{b[0]}",
                "type": "course_practice",
                "title": practice_name,
                "description": "知识点练习 · HTML 资源",
                "subject": "",
                "status": "pending",
                "priority": 45,
                "deadline": None,
                "url": resource_url,
                "action_label": "去练习",
                "meta": {"resource_url": resource_url},
            })
    except Exception as e:
        logger.warning(f"[task-todo] 查询课程练习资源失败: {e}")

    # ── 7. 活跃随堂测验 ──
    try:
        active_quizzes = []
        if grade_id:
            # 通过 teacher_assignments 找到任教教师和管理员
            if class_id:
                ta_rows = execute_query(
                    """SELECT DISTINCT teacher_username FROM teacher_assignments
                       WHERE grade_id=? AND (class_id=? OR class_id IS NULL)""",
                    (grade_id, class_id),
                )
            else:
                ta_rows = execute_query(
                    """SELECT DISTINCT teacher_username FROM teacher_assignments
                       WHERE grade_id=?""",
                    (grade_id,),
                )
            teacher_names = [r[0] for r in ta_rows] if ta_rows else []
            admin_rows = execute_query("SELECT username FROM users WHERE role=0")
            admin_names = [r[0] for r in admin_rows] if admin_rows else []
            all_creators = admin_names + teacher_names
            if all_creators:
                ph = ",".join("?" for _ in all_creators)
                quiz_rows = execute_query(
                    f"""SELECT q.id, q.title, q.description FROM interaction_quizzes q
                        WHERE q.status = 'active'
                        AND q.creator_username IN ({ph})
                        AND q.id NOT IN (SELECT quiz_id FROM interaction_quiz_answers WHERE student_username = ?)
                        ORDER BY q.created_at DESC""",
                    tuple(all_creators + [username]),
                )
                for qr in quiz_rows:
                    active_quizzes.append({"id": qr[0], "title": qr[1], "description": qr[2] or ""})
        for aq in active_quizzes:
            items.append({
                "id": f"quiz-{aq['id']}",
                "type": "quiz",
                "title": aq["title"],
                "description": aq["description"] or "随堂测验",
                "subject": "",
                "status": "pending",
                "priority": 60,
                "deadline": None,
                "url": "/interaction",
                "action_label": "去作答",
                "meta": {},
            })
    except Exception as e:
        logger.warning(f"[task-todo] 查询随堂测验失败: {e}")

    # ── 8. 活跃投票 ──
    try:
        voted_poll_ids = set(
            row[0] for row in execute_query(
                "SELECT DISTINCT poll_id FROM interaction_poll_votes WHERE student_username=?",
                (username,),
            )
        )
        active_polls = execute_query(
            """SELECT id, question FROM interaction_polls
               WHERE status='active' ORDER BY created_at DESC""",
        )
        for ap in active_polls:
            if ap[0] not in voted_poll_ids:
                items.append({
                    "id": f"poll-{ap[0]}",
                    "type": "poll",
                    "title": ap[1],
                    "description": "课堂投票 · 进行中",
                    "subject": "",
                    "status": "pending",
                    "priority": 55,
                    "deadline": None,
                    "url": "/quick-poll",
                    "action_label": "去投票",
                    "meta": {},
                })
    except Exception as e:
        logger.warning(f"[task-todo] 查询投票失败: {e}")

    # ── 9. 活跃分组讨论 ──
    try:
        my_group_ids = set(
            row[0] for row in execute_query(
                """SELECT dg.discussion_id FROM discussion_members dm
                   JOIN discussion_groups dg ON dm.group_id = dg.id
                   WHERE dm.username=?""",
                (username,),
            )
        )
        active_discussions = execute_query(
            """SELECT id, title, description FROM discussions
               WHERE status='active' ORDER BY created_at DESC""",
        )
        for ad in active_discussions:
            if ad[0] not in my_group_ids:
                items.append({
                    "id": f"discussion-{ad[0]}",
                    "type": "discussion",
                    "title": ad[1],
                    "description": ad[2] or "分组讨论 · 进行中",
                    "subject": "",
                    "status": "pending",
                    "priority": 60,
                    "deadline": None,
                    "url": f"/discussion-room/{ad[0]}",
                    "action_label": "加入讨论",
                    "meta": {},
                })
    except Exception as e:
        logger.warning(f"[task-todo] 查询讨论失败: {e}")

    # ── 10. 抢答竞赛（进行中的） ──
    try:
        joined_rooms = set(
            row[0] for row in execute_query(
                "SELECT DISTINCT room_id FROM quick_quiz_players WHERE student_username=?",
                (username,),
            )
        )
        active_rooms = execute_query(
            """SELECT id, title FROM quick_quiz_rooms
               WHERE status IN ('waiting','active')
               ORDER BY created_at DESC""",
        )
        for ar in active_rooms:
            if ar[0] not in joined_rooms:
                items.append({
                    "id": f"quick_quiz-{ar[0]}",
                    "type": "quick_quiz",
                    "title": ar[1],
                    "description": "抢答竞赛 · 进行中",
                    "subject": "",
                    "status": "pending",
                    "priority": 70,
                    "deadline": None,
                    "url": f"/quick-quiz/lobby/{ar[0]}",
                    "action_label": "去参与",
                    "meta": {},
                })
    except Exception as e:
        logger.warning(f"[task-todo] 查询抢答失败: {e}")

    # ── 11. 活跃白板活动 ──
    try:
        joined_whiteboards = set(
            row[0] for row in execute_query(
                "SELECT DISTINCT room_id FROM whiteboard_room_members WHERE username=? AND leave_time IS NULL",
                (username,),
            )
        )
        active_whiteboards = execute_query(
            """SELECT id, title FROM whiteboard_rooms
               WHERE status='active' ORDER BY created_at DESC""",
        )
        for aw in active_whiteboards:
            if aw[0] not in joined_whiteboards:
                items.append({
                    "id": f"whiteboard-{aw[0]}",
                    "type": "whiteboard",
                    "title": aw[1],
                    "description": "白板互动 · 进行中",
                    "subject": "",
                    "status": "pending",
                    "priority": 50,
                    "deadline": None,
                    "url": f"/whiteboard-room/{aw[0]}",
                    "action_label": "加入白板",
                    "meta": {},
                })
    except Exception as e:
        logger.warning(f"[task-todo] 查询白板失败: {e}")

    # ── 12. 我提出的待回答问题 ──
    try:
        my_pending_qs = execute_query(
            """SELECT id, content FROM interaction_questions
               WHERE student_username=? AND status='pending'
               ORDER BY created_at DESC""",
            (username,),
        )
        for pq in my_pending_qs:
            items.append({
                "id": f"question_waiting-{pq[0]}",
                "type": "question_waiting",
                "title": f"等待回答：{pq[1][:60]}{'...' if len(pq[1])>60 else ''}",
                "description": "你提出的问题等待老师回答",
                "subject": "",
                "status": "pending",
                "priority": 75,
                "deadline": None,
                "url": "/student-questions",
                "action_label": "查看",
                "meta": {},
            })
    except Exception as e:
        logger.warning(f"[task-todo] 查询待回答问题失败: {e}")

    # ── 13. 可回答的同学提问 ──
    try:
        my_answered = set(
            row[0] for row in execute_query(
                "SELECT DISTINCT question_id FROM interaction_question_answers WHERE student_username=?",
                (username,),
            )
        )
        peer_questions = execute_query(
            """SELECT id, content, student_username FROM interaction_questions
               WHERE status='pending' AND student_username!=?
               ORDER BY created_at DESC LIMIT 10""",
            (username,),
        )
        for pqq in peer_questions:
            if pqq[0] not in my_answered:
                items.append({
                    "id": f"question_can_answer-{pqq[0]}",
                    "type": "question_can_answer",
                    "title": f"可回答：{pqq[2]} 提问「{pqq[1][:60]}{'...' if len(pqq[1])>60 else ''}」",
                    "description": "同学提问，你可以帮助回答",
                    "subject": "",
                    "status": "pending",
                    "priority": 35,
                    "deadline": None,
                    "url": "/student-questions",
                    "action_label": "去回答",
                    "meta": {},
                })
    except Exception as e:
        logger.warning(f"[task-todo] 查询可回答问题失败: {e}")

    # ── 14. 进行中的知识闯关 ──
    try:
        ongoing_quest = execute_query(
            """SELECT id, score, current_question_index, total_questions
               FROM quest_records
               WHERE student_username=? AND completed=0
               ORDER BY created_at DESC LIMIT 1""",
            (username,),
        )
        if ongoing_quest and ongoing_quest[0]:
            oq = ongoing_quest[0]
            items.append({
                "id": f"quest-{oq[0]}",
                "type": "quest",
                "title": "知识闯关",
                "description": f"进行中 · 第{oq[2]+1}/{oq[3]}题 · 当前{oq[1]}分",
                "subject": "",
                "status": "in_progress",
                "priority": 65,
                "deadline": None,
                "url": "/quest",
                "action_label": "继续闯关",
                "meta": {"progress": f"{oq[2]}/{oq[3]}", "score": oq[1]},
            })
    except Exception as e:
        logger.warning(f"[task-todo] 查询闯关失败: {e}")

    # ── 15. 待巩固错题 ──
    try:
        wrong_count = _db_count(
            "SELECT COUNT(*) FROM wrong_book WHERE student_username=? AND status='pending'",
            (username,),
        )
        if wrong_count > 0:
            items.append({
                "id": "wrong_book",
                "type": "wrong_book",
                "title": f"错题巩固（{wrong_count} 道待巩固）",
                "description": f"有 {wrong_count} 道错题需要复习巩固",
                "subject": "",
                "status": "pending",
                "priority": 70,
                "deadline": None,
                "url": "/wrong-book",
                "action_label": "去巩固",
                "meta": {"count": wrong_count},
            })
    except Exception as e:
        logger.warning(f"[task-todo] 查询错题失败: {e}")

    # ── 16. 未读通知 ──
    try:
        unread_count = _db_count(
            "SELECT COUNT(*) FROM notifications WHERE recipient_username=? AND is_read=0",
            (username,),
        )
        if unread_count > 0:
            items.append({
                "id": "notification",
                "type": "notification",
                "title": f"未读通知（{unread_count} 条）",
                "description": f"有 {unread_count} 条未读通知等待查看",
                "subject": "",
                "status": "pending",
                "priority": 40,
                "deadline": None,
                "url": "/notifications",
                "action_label": "查看",
                "meta": {"count": unread_count},
            })
    except Exception as e:
        logger.warning(f"[task-todo] 查询通知失败: {e}")

    # ── 16. 共享资源（仅未浏览过的，已浏览的不再显示） ──
    try:
        if grade:
            shared_items = execute_query(
                """SELECT sr.id, sr.file_name, sr.file_path, sr.resource_type
                   FROM shared_resources sr
                   WHERE (sr.share_scope='all'
                        OR (sr.share_scope='class' AND (sr.target_grade=? OR INSTR(sr.target_grade, ?)>0) AND (sr.target_class='' OR sr.target_class IS NULL OR sr.target_class=? OR INSTR(sr.target_class, ?)>0))
                        OR (sr.share_scope='teacher' AND INSTR(sr.target_users, ?)>0))
                     AND NOT EXISTS (
                       SELECT 1 FROM resource_view_logs rvl
                       WHERE rvl.student_username=?
                         AND rvl.resource_type=sr.resource_type
                         AND rvl.resource_id=sr.id
                     )
                   ORDER BY sr.created_at DESC
                   LIMIT 30""",
                (grade, grade, cls, cls, username, username),
            )
        else:
            shared_items = execute_query(
                """SELECT sr.id, sr.file_name, sr.file_path, sr.resource_type
                   FROM shared_resources sr
                   WHERE sr.share_scope='all'
                     AND NOT EXISTS (
                       SELECT 1 FROM resource_view_logs rvl
                       WHERE rvl.student_username=?
                         AND rvl.resource_type=sr.resource_type
                         AND rvl.resource_id=sr.id
                     )
                   ORDER BY sr.created_at DESC
                   LIMIT 30""",
                (username,),
            )
        for si in shared_items:
            file_path = str(si[2] or '').lstrip('/')
            resource_url = f"/api/files/{file_path}" if file_path else "/shared-center"
            items.append({
                "id": f"shared_resource-{si[0]}",
                "type": "shared_resource",
                "title": str(si[1] or si[2] or f'资源#{si[0]}'),
                "description": f"{'HTML 资源' if si[3]=='html' else '共享文件'} · 点击查看",
                "subject": "",
                "status": "pending",
                "priority": 30,
                "deadline": None,
                "url": resource_url,
                "action_label": "查看",
                "meta": {"resource_url": resource_url},
            })
    except Exception as e:
        logger.warning(f"[task-todo] 查询共享资源失败: {e}")

    # ── 排序：按优先级降序，同优先级按 deadline 升序 ──
    items.sort(key=lambda x: (
        -x["priority"],
        x["deadline"] or "9999-99-99",
    ))

    # ── 统计分类（与导航菜单保持一致） ──
    # 📝 考核测评 | 📖 课程学习 | 🎯 互动课堂 | 🎮 趣味挑战 | 📂 系统服务
    counts: dict[str, int] = {
        "exam": 0, "curriculum": 0, "interactive": 0,
        "challenge": 0, "service": 0,
    }
    type_category: dict[str, str] = {
        "exam": "exam",
        "task": "exam",
        "practice": "exam",
        "code": "exam",
        "course_practice": "curriculum",
        "quiz": "interactive",
        "poll": "interactive",
        "discussion": "interactive",
        "whiteboard": "interactive",
        "quick_quiz": "interactive",
        "question_waiting": "interactive",
        "question_can_answer": "interactive",
        "quest": "exam",
        "wrong_book": "exam",
        "shared_resource": "challenge",
        "notification": "service",
    }
    for it in items:
        cat = type_category.get(it["type"], "other")
        counts[cat] = counts.get(cat, 0) + 1

    # ── 学习统计 ──
    stats: dict[str, Any] = {
        "course_progress": 0,
        "completion_rate": 0,
        "accuracy_rate": 0,
        "streak_days": 0,
    }
    try:
        # 课程进度：已完成课程练习数 / 总课程练习数
        # 总练习数 = curriculum_bindings 中匹配学生年级且文件名含 _练习.html 的资源数
        # 已完成数 = ai_practice_results 中学生完成的去重知识点数
        if grade:
            total_kp = _db_count(
                """SELECT COUNT(*) FROM curriculum_bindings cb
                   JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
                   JOIN chapters ch ON kp.chapter_id = ch.id
                   JOIN courses c ON ch.course_id = c.id
                   LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
                   WHERE cb.resource_type='html'
                     AND c.status='active'
                     AND (c.grade = '' OR INSTR(c.grade, ?) > 0)
                     AND (COALESCE(sr.file_name, '') LIKE '%_练习.html'
                          OR COALESCE(sr.file_path, '') LIKE '%_练习.html')""",
                (grade,),
            )
        else:
            total_kp = _db_count(
                """SELECT COUNT(*) FROM curriculum_bindings cb
                   JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
                   JOIN chapters ch ON kp.chapter_id = ch.id
                   JOIN courses c ON ch.course_id = c.id
                   LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
                   WHERE cb.resource_type='html' AND c.status='active' AND c.grade=''
                     AND (COALESCE(sr.file_name, '') LIKE '%_练习.html'
                          OR COALESCE(sr.file_path, '') LIKE '%_练习.html')""",
            )
        done_kp = 0
        kp_rows = q_execute_query(
            "SELECT COUNT(DISTINCT kp_id) as cnt FROM ai_practice_results WHERE student_username=?",
            (username,),
        )
        if kp_rows:
            done_kp = kp_rows[0]["cnt"]
        stats["course_progress"] = round(done_kp / total_kp * 100) if total_kp > 0 else 0

        # 总体完成率：已完成的各类活动 / (已完成 + 待完成)
        # 涵盖考试、智能练习、课程练习、代码练习
        completed = _q_count(
            "SELECT COUNT(*) FROM exam_attempts WHERE student_username=? AND status IN ('submitted','graded')",
            (username,),
        )
        completed += _q_count(
            "SELECT COUNT(*) FROM practice_attempts WHERE student_username=? AND status='submitted'",
            (username,),
        )
        completed += done_kp
        code_done_rows = q_execute_query(
            "SELECT COUNT(DISTINCT problem_id) as cnt FROM code_submissions WHERE student_username=? AND status='accepted' AND is_best=1",
            (username,),
        )
        completed += code_done_rows[0]["cnt"] if code_done_rows else 0
        # 待完成数取自 items 中对应类型的数量
        pending = sum(1 for it in items if it["type"] in ("exam", "practice", "course_practice", "code"))
        stats["completion_rate"] = round(completed / (completed + pending) * 100) if (completed + pending) > 0 else 0

        # 总体正确率：综合考试得分率 + 课程练习正确率的加权平均（统一为百分比）
        exam_acc = 0.0
        exam_count = 0
        exam_rows = q_execute_query(
            """SELECT ea.score, e.total_score
               FROM exam_attempts ea
               JOIN exams e ON ea.exam_id = e.id
               WHERE ea.student_username=? AND ea.status IN ('submitted','graded') AND e.total_score > 0""",
            (username,),
        )
        if exam_rows:
            exam_count = len(exam_rows)
            total_score_sum = sum(r["total_score"] for r in exam_rows)
            actual_score_sum = sum(r["score"] for r in exam_rows)
            exam_acc = actual_score_sum / total_score_sum * 100 if total_score_sum > 0 else 0

        course_acc = 0.0
        course_count = 0
        course_rows = q_execute_query(
            "SELECT accuracy FROM ai_practice_results WHERE student_username=? AND accuracy IS NOT NULL",
            (username,),
        )
        if course_rows:
            course_count = len(course_rows)
            course_acc = sum(r["accuracy"] for r in course_rows) / course_count

        total_acc_count = exam_count + course_count
        if total_acc_count > 0:
            weighted_acc = (exam_acc * exam_count + course_acc * course_count) / total_acc_count
            # accuracy 可能是小数(0.85)或百分比(85)，统一为百分比
            stats["accuracy_rate"] = round(weighted_acc * 100, 1) if max(exam_acc, course_acc) <= 1 else round(weighted_acc, 1)
        else:
            stats["accuracy_rate"] = 0

        # 连续学习天数（从 login_logs 计算）
        streak = execute_query(
            """SELECT DISTINCT DATE(login_time) as d FROM login_logs
               WHERE username=? ORDER BY d DESC LIMIT 60""",
            (username,),
        )
        if streak:
            streak_days = 0
            from datetime import date, timedelta
            check_date = date.today()
            for row in streak:
                log_date_str = str(row[0]) if row[0] else ""
                if log_date_str:
                    try:
                        log_date = datetime.strptime(log_date_str[:10], "%Y-%m-%d").date()
                        if log_date == check_date:
                            streak_days += 1
                            check_date -= timedelta(days=1)
                        elif log_date < check_date:
                            break
                    except ValueError:
                        continue
            stats["streak_days"] = streak_days
    except Exception as e:
        logger.warning(f"[task-todo] 查询学习统计失败: {e}")

    result = {"items": items, "counts": counts, "stats": stats}
    _set_cache(cache_key, result)
    return result
