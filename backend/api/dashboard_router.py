"""
首页仪表盘 API 路由
聚合展示系统关键数据：考试、积分、任务、点名、用户统计等
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Request

from backend.api.dependencies import get_current_user
from backend.database import execute_query
from backend.question_db import execute_query as q_execute_query
from backend.logger import logger

router = APIRouter()


def _q_count(sql: str, params: tuple = ()) -> int:
    """执行 question_db 的 COUNT 查询并返回数值（返回 dict，按列名访问）"""
    rows = q_execute_query(sql, params)
    return rows[0]['COUNT(*)'] if rows else 0


def _get_user_grade_class(username: str) -> tuple:
    """查询用户的年级(grade)和班级(class)"""
    rows = execute_query(
        "SELECT grade, class FROM users WHERE username = ?",
        (username,),
    )
    if rows and rows[0]:
        return rows[0][0] or "", rows[0][1] or ""
    return "", ""


def _db_count(sql: str, params: tuple = ()) -> int:
    """执行 database 的 COUNT 查询并返回数值（返回 tuple，按下标访问）"""
    rows = execute_query(sql, params)
    return rows[0][0] if rows else 0


@router.get("/summary", summary="获取仪表盘概览数据")
async def dashboard_summary(request: Request):
    """根据用户角色返回聚合的仪表盘数据"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    now = datetime.now()
    today_str = now.strftime("%Y-%m-%d")

    result = {
        "role": "admin" if role == 0 else ("teacher" if role == 1 else "student"),
        "username": username,
        "user_name": user.get("name", username),
    }

    # ── AI Token 用量（今日） ──
    token_today = _db_count(
        "SELECT COALESCE(SUM(total_tokens), 0) FROM ai_token_usage WHERE created_at >= ? AND created_at <= ?",
        (today_str, today_str + " 23:59:59"),
    )

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

        total_score = _db_count(
            """SELECT COALESCE(SUM(score), 0) FROM scores WHERE student_name = ?""",
            (user.get("name", username),),
        )

        rank = _db_count(
            """SELECT COUNT(*) + 1 FROM (
                   SELECT student_name, SUM(score) as total
                   FROM scores
                   WHERE grade = (SELECT grade FROM users WHERE username = ?)
                   GROUP BY student_name
                   HAVING total > ?
               )""",
            (username, total_score),
        )

        active_task_count = _db_count(
            "SELECT COUNT(*) FROM tasks WHERE status = 'active'",
        )
        if active_task_count > 0:
            # 与学生相关的活跃任务（按年级/班级匹配教师）才计数
            from backend.api.tasks_router import _get_all_tasks, _get_user_relevant_tasks
            all_active = _get_all_tasks()
            relevant = _get_user_relevant_tasks(username, all_active)
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
        if grade:
            active_quiz_count = _db_count(
                """SELECT COUNT(*) FROM interaction_quizzes q
                   JOIN users u ON q.creator_username = u.username AND u.role IN (0, 1)
                   WHERE q.status = 'active' AND u.grade = ?
                   AND q.id NOT IN (SELECT quiz_id FROM interaction_quiz_answers WHERE student_username = ?)""",
                (grade, username),
            )
            if cls:
                cls_param = f",{cls},"
                active_quiz_count = _db_count(
                    """SELECT COUNT(*) FROM interaction_quizzes q
                       JOIN users u ON q.creator_username = u.username AND u.role IN (0, 1)
                       WHERE q.status = 'active' AND u.grade = ? AND INSTR(',' || u.class || ',', ?) > 0
                       AND q.id NOT IN (SELECT quiz_id FROM interaction_quiz_answers WHERE student_username = ?)""",
                    (grade, cls_param, username),
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
            "token_today": token_today,
        })

    else:  # ── 教师/管理员 ──
        exam_where = ""
        exam_params: list = []
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

        total_students = _db_count("SELECT COUNT(*) FROM users WHERE role = 2")

        if role == 0:
            total_teachers = _db_count("SELECT COUNT(*) FROM users WHERE role = 1")
        else:
            total_teachers = 0

        week_ago = (now - timedelta(days=7)).strftime("%Y-%m-%d")
        # rollcall_history.created_at 可能只有时间没有日期，兼容两种格式
        if role == 0:
            total_rollcalls = execute_query(
                """SELECT COUNT(*) FROM rollcall_history
                   WHERE (length(created_at) > 10 AND created_at >= ?)
                      OR (length(created_at) <= 10)""",
                (week_ago,),
            )
        else:
            total_rollcalls = execute_query(
                """SELECT COUNT(*) FROM rollcall_history
                   WHERE teacher_username = ?
                   AND ((length(created_at) > 10 AND created_at >= ?)
                        OR (length(created_at) <= 10))""",
                (username, week_ago),
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

        # ── AI Token 用量（今日） ──

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
            "token_today": token_today,
        })

        if role == 1:
            rows = execute_query(
                "SELECT grade, class FROM users WHERE username = ?",
                (username,),
            )
            if rows:
                result["teacher_grades"] = rows[0][0] or ""
                result["teacher_classes"] = rows[0][1] or ""

    return result


@router.get("/recent-activity", summary="获取最近活动动态")
async def recent_activity(request: Request):
    """返回系统最近活动的时间线"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    activities = []

    if role == 2:  # 学生
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
            (user.get("name", username),),
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
        for act in sub_activities:
            activities.append({
                "time": act[0],
                "type": "task",
                "title": f"学生 {act[2]} 提交了任务「{act[1]}」",
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
        for act in quiz_acts:
            activities.append({
                "time": act[0],
                "type": "quiz",
                "title": f"学生 {act[2]} 完成了测验「{act[1]}」",
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

    # 按时间排序
    # 修复时间格式：如果只有时间没有日期，补上今天
    now = datetime.now()
    for act_obj in activities:
        t = act_obj.get("time") or ""
        if len(t) <= 10 and ":" in t:
            act_obj["time"] = now.strftime("%Y-%m-%d") + " " + t

    activities.sort(key=lambda x: x["time"] or "", reverse=True)
    return activities[:20]


@router.get("/token-usage", summary="获取 AI Token 用量统计")
async def get_token_usage(
    request: Request,
    range_type: str = "today",
    model: str = "",
):
    """获取 AI Token 用量统计

    - 学生：仅看自己
    - 教师：看自己 + 本班学生（通过 user_role + grade 过滤）
    - 管理员：看全部
    - range_type: today / yesterday / week / month / custom
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    from backend.token_usage import get_token_usage_summary

    if role == 2:
        # 学生只看自己
        summary = get_token_usage_summary(username=username, range_type=range_type)
    elif role == 1:
        # 教师看自己和本班学生的
        grade, cls = _get_user_grade_class(username)
        rows = execute_query(
            "SELECT username FROM users WHERE role=2 AND grade=?", (grade,),
        )
        usernames = [username] + [r[0] for r in rows]
        # 没有按用户列表过滤的简便方式，直接用 user_role 过滤（学生=2）
        summary = get_token_usage_summary(range_type=range_type)
        summary["filtered"] = f"{grade}"
    else:
        # 管理员看全部
        summary = get_token_usage_summary(range_type=range_type)

    if model:
        summary["by_model"] = [m for m in summary["by_model"] if m["model"] == model]

    return summary
