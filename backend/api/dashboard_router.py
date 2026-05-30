"""
首页仪表盘 API 路由
聚合展示系统关键数据：考试、积分、任务、点名、用户统计等
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Request

from backend.api.dependencies import get_current_user
from backend.database import execute_query
from backend.question_db import execute_query as q_execute_query
from backend.auth import get_online_count
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
            # 分组讨论
            "active_discussion_count": active_discussion_count,
            "my_discussion_count": my_discussion_count,
            # 共享资源
            "shared_files_count": _db_count(
                """SELECT COUNT(*) FROM shared_resources WHERE share_scope='all'
                   OR (share_scope='class' AND (target_grade=? OR INSTR(target_grade, ?)>0) AND (target_class=? OR INSTR(target_class, ?)>0))
                   OR (share_scope='teacher' AND INSTR(target_users, ?)>0)""",
                (grade, grade, cls, cls, username) if grade else ("", "", "", "", username),
            ) if grade else _db_count("SELECT COUNT(*) FROM shared_resources WHERE share_scope='all'"),
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

        if role == 1:
            # 教师：只统计自己班级的学生数
            t_grade = execute_query(
                "SELECT grade, class FROM users WHERE username = ?", (username,)
            )
            if t_grade and t_grade[0][0]:
                tg, tc = t_grade[0][0] or "", t_grade[0][1] or ""
                total_students = _db_count(
                    """SELECT COUNT(*) FROM users WHERE role=2
                       AND (grade=? OR INSTR(?, grade)>0 OR INSTR(grade, ?)>0)
                       AND (class=? OR INSTR(?, class)>0 OR INSTR(class, ?)>0)""",
                    (tg, tg, tg, tc, tc, tc),
                )
            else:
                total_students = 0
        else:
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
            # 分组讨论
            "discussion_total": discussion_total,
            "discussion_active": discussion_active,
            "discussion_member_count": discussion_member_count,
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

    # 按时间排序
    # 修复时间格式：如果只有时间没有日期，跳过（无法确定真实日期）
    activities = [
        a for a in activities
        if not (len(a.get("time") or "") <= 10 and ":" in (a.get("time") or ""))
    ]
    activities.sort(key=lambda x: x["time"] or "", reverse=True)
    return activities[:20]


