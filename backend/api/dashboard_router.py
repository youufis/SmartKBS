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

    if role == 2:  # ── 学生 ──
        pending_count = _q_count(
            """SELECT COUNT(*) FROM exams
               WHERE status = 'published'
               AND (start_time IS NULL OR start_time <= ?)
               AND (end_time IS NULL OR end_time >= ?)""",
            (today_str, today_str),
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

    # 按时间排序
    # 修复时间格式：如果只有时间没有日期，补上今天
    now = datetime.now()
    for act_obj in activities:
        t = act_obj.get("time") or ""
        if len(t) <= 10 and ":" in t:
            act_obj["time"] = now.strftime("%Y-%m-%d") + " " + t

    activities.sort(key=lambda x: x["time"] or "", reverse=True)
    return activities[:20]
