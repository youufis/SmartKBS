"""
活动完成监控 API 路由
教师查看各种活动（考试、练习、任务、测验等）的完成情况
支持按活动名称、年级、班级筛选已完成/未完成学生及简要成绩
"""
from typing import Optional, Dict, List, Any, Tuple

from fastapi import APIRouter, HTTPException, Request, Query

from backend.api.dependencies import get_current_user
from backend.database import execute_query_dict as db_query_dict
from backend.question_db import execute_query as qdb_query
from backend.permission_service import (
    get_students_in_scope,
)
from backend.auth import is_admin
from backend.logger import logger

router = APIRouter()

ACTIVITY_TYPE_LABELS = {
    "exam": "考试",
    "practice": "智能练习",
    "quick_quiz": "知识抢答",
    "task": "在线任务",
    "quiz": "随堂测验",
    "code": "代码练习",
    "discussion": "分组讨论",
    "poll": "快速投票",
    "course": "课程练习",
}


# ═══════════════════════════════════════════════════════════
# 辅助：获取教师创建的所有活动
# ═══════════════════════════════════════════════════════════

def _get_teacher_activities(teacher_username: str) -> List[Dict[str, Any]]:
    """获取教师创建的所有活动"""
    # 查询教师姓名
    _name_rows = db_query_dict(
        "SELECT COALESCE(NULLIF(name,''), username) as display_name FROM users WHERE username=?",
        (teacher_username,),
    )
    _creator_name = _name_rows[0]["display_name"] if _name_rows else teacher_username

    activities = []

    # ── 1. 考试（questions.db）──
    exams = qdb_query(
        """SELECT e.id, e.title, e.status, e.created_at, e.updated_at,
                  e.total_score, e.pass_score, e.duration, e.subject,
                  e.target_scope, e.target_grade, e.target_class,
                  'exam' as activity_type
           FROM exams e
           WHERE e.creator_username = ?
           ORDER BY e.created_at DESC""",
        (teacher_username,),
    )
    for e in exams:
        sub = qdb_query(
            "SELECT COUNT(DISTINCT student_username) as cnt FROM exam_attempts WHERE exam_id=? AND status IN ('submitted','graded')",
            (e["id"],),
        )
        e["submitted_count"] = sub[0]["cnt"] if sub else 0
        activities.append(e)

    # ── 2. 智能练习（questions.db）──
    # 排除：错题巩固(source=wrong_book)、定向给个别学生的(target_students不为空)
    practices = qdb_query(
        """SELECT ps.id, ps.title, ps.status, ps.created_at, ps.updated_at,
                  COALESCE(ps.total_score,0) as total_score,
                  ps.subject, ps.target_grade, ps.target_class, ps.source,
                  'practice' as activity_type
           FROM practice_sessions ps
           WHERE ps.creator_username = ?
             AND (ps.source IS NULL OR ps.source != 'wrong_book')
             AND (ps.target_students IS NULL OR ps.target_students = '')
           ORDER BY ps.created_at DESC""",
        (teacher_username,),
    )
    for p in practices:
        sub = qdb_query(
            "SELECT COUNT(DISTINCT student_username) as cnt FROM practice_attempts WHERE session_id=? AND status='submitted'",
            (p["id"],),
        )
        p["submitted_count"] = sub[0]["cnt"] if sub else 0
        p["duration"] = 0
        p["pass_score"] = 0
        activities.append(p)

    # ── 3. 知识抢答（smartkb.db）──
    quick_quiz_rows = db_query_dict(
        """SELECT qr.id, qr.title, qr.status, qr.created_at,
                  COALESCE(qr.started_at, qr.created_at) as updated_at,
                  qr.target_grade, qr.target_class, qr.subject,
                  0 as total_score, 0 as pass_score, 0 as duration,
                  'quick_quiz' as activity_type
           FROM quick_quiz_rooms qr
           WHERE qr.creator_username = ?
           ORDER BY qr.created_at DESC""",
        (teacher_username,),
    )
    for q in quick_quiz_rows:
        players = db_query_dict(
            "SELECT COUNT(DISTINCT student_username) as cnt FROM quick_quiz_players WHERE room_id=?",
            (q["id"],),
        )
        q["submitted_count"] = players[0]["cnt"] if players else 0
        q["status"] = q.get("status") or "ended"
        activities.append(q)

    # ── 4. 在线任务（smartkb.db）──
    task_rows = db_query_dict(
        """SELECT t.id, t.name as title, t.status, t.created_at, t.updated_at,
                  '' as subject, 0 as total_score, 0 as pass_score, 0 as duration,
                  t.target_scope, t.target_grade, t.target_class,
                  'task' as activity_type
           FROM tasks t
           WHERE t.creator_username = ?
           ORDER BY t.created_at DESC""",
        (teacher_username,),
    )
    for t in task_rows:
        sub = db_query_dict(
            "SELECT COUNT(DISTINCT student_username) as cnt FROM task_submissions WHERE task_id=?",
            (t["id"],),
        )
        t["submitted_count"] = sub[0]["cnt"] if sub else 0
        activities.append(t)

    # ── 5. 随堂测验（smartkb.db）──
    quiz_rows = db_query_dict(
        """SELECT iq.id, iq.title, iq.status, iq.created_at, iq.updated_at,
                  '' as subject, 0 as total_score, 0 as pass_score, 0 as duration,
                  iq.target_scope, iq.target_grade, iq.target_class,
                  'quiz' as activity_type
           FROM interaction_quizzes iq
           WHERE iq.creator_username = ?
           ORDER BY iq.created_at DESC""",
        (teacher_username,),
    )
    for qz in quiz_rows:
        sub = db_query_dict(
            "SELECT COUNT(DISTINCT student_username) as cnt FROM interaction_quiz_answers WHERE quiz_id=?",
            (qz["id"],),
        )
        qz["submitted_count"] = sub[0]["cnt"] if sub else 0
        activities.append(qz)

    # ── 6. 代码练习（questions.db）──
    code_rows = qdb_query(
        """SELECT cp.id, cp.title, cp.status, cp.created_at, cp.updated_at,
                  cp.subject, 0 as total_score, 0 as pass_score, 0 as duration,
                  cp.target_scope, cp.target_grade, cp.target_class,
                  'code' as activity_type
           FROM code_problems cp
           WHERE cp.creator_username = ?
           ORDER BY cp.created_at DESC""",
        (teacher_username,),
    )
    for c in code_rows:
        sub = qdb_query(
            "SELECT COUNT(DISTINCT student_username) as cnt FROM code_submissions WHERE problem_id=? AND status='submitted'",
            (c["id"],),
        )
        c["submitted_count"] = sub[0]["cnt"] if sub else 0
        activities.append(c)

    # ── 7. 分组讨论（smartkb.db）──
    disc_rows = db_query_dict(
        """SELECT d.id, d.title, d.status, d.created_at, d.updated_at,
                  d.subject, 0 as total_score, 0 as pass_score, 0 as duration,
                  'discussion' as activity_type
           FROM discussions d
           WHERE d.creator_username = ?
           ORDER BY d.created_at DESC""",
        (teacher_username,),
    )
    for d in disc_rows:
        # 讨论完成 = 有成员加入（至少参与了讨论）
        sub = db_query_dict(
            """SELECT COUNT(DISTINCT dm.username) as cnt
               FROM discussion_groups dg
               JOIN discussion_members dm ON dm.group_id = dg.id
               WHERE dg.discussion_id = ?""",
            (d["id"],),
        )
        d["submitted_count"] = sub[0]["cnt"] if sub else 0
        d["status"] = d.get("status") or "pending"
        activities.append(d)

    # ── 9. 课程练习（smartkb.db）──
    # 参考学生端任务清单(dashboard_router.py) 的统计逻辑：
    #   按具体练习资源（curriculum_bindings 中 resource_type='html' 且文件名含 _练习.html）细分
    #   完成数按 ai_practice_results 统计（questions.db）
    course_grade_set: set[str] = set()
    for ta in db_query_dict(
        "SELECT DISTINCT g.name as grade_name FROM teacher_assignments ta JOIN grades g ON ta.grade_id=g.id WHERE ta.teacher_username=?",
        (teacher_username,),
    ):
        gn = ta.get("grade_name", "").strip()
        if gn:
            course_grade_set.add(gn)

    # 查询绑定了 _练习.html 的课程练习资源（与 task-todo 逻辑一致）
    bind_rows = db_query_dict(
        """SELECT cb.id as binding_id, cb.knowledge_point_id,
                  kp.name as kp_name, c.name as course_name, c.id as course_id,
                  c.subject, c.status as course_status, c.grade as course_grade,
                  c.created_at, c.updated_at,
                  COALESCE(sr.file_path, '') as fp, COALESCE(sr.file_name, '') as fn,
                  sr.owner_username
           FROM curriculum_bindings cb
           JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
           JOIN chapters ch ON kp.chapter_id = ch.id
           JOIN courses c ON ch.course_id = c.id
           LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
           WHERE cb.resource_type='html' AND c.status='active'
           ORDER BY c.sort_order, ch.sort_order, kp.sort_order, cb.id""",
    )
    for b in bind_rows:
        fn = str(b["fn"] or "")
        fp = str(b["fp"] or "")
        # 只显示 _练习.html 的资源（参考学生端任务清单）
        if "_练习.html" not in fn and "_练习.html" not in fp:
            continue

        course_grade = (b.get("course_grade") or "").strip()
        # 管理员：显示全部课程练习；教师：仅显示自己共享的 + 匹配任教年级的课程
        if not is_admin(teacher_username):
            if b.get("owner_username") != teacher_username:
                continue
            if not course_grade or not course_grade_set or course_grade not in course_grade_set:
                continue

        # 统计已完成的 Student 数（从 ai_practice_results 查询，与 task-todo 一致）
        done_count = qdb_query(
            "SELECT COUNT(DISTINCT student_username) as cnt FROM ai_practice_results WHERE kp_id=?",
            (b["knowledge_point_id"],),
        )

        # 用练习资源文件名作为活动名称（去掉 _练习.html 后缀更友好）
        practice_name = b["fn"]
        if practice_name.endswith("_练习.html"):
            practice_name = practice_name[:-len("_练习.html")]
        if not practice_name:
            practice_name = f"{b['course_name']} - {b['kp_name']}"

        # 查询共享资源拥有者的姓名
        _owner_name = _creator_name
        owner = b.get("owner_username")
        if owner:
            owner_rows = db_query_dict(
                "SELECT COALESCE(NULLIF(name,''), username) as display_name FROM users WHERE username=?",
                (owner,),
            )
            if owner_rows:
                _owner_name = owner_rows[0]["display_name"]

        activities.append({
            "id": b["binding_id"],
            "title": practice_name,
            "creator_name": _owner_name,
            "status": b["course_status"],
            "created_at": b["created_at"],
            "updated_at": b["updated_at"],
            "subject": b.get("subject", "") or "",
            "total_score": 0,
            "pass_score": 0,
            "duration": 0,
            "activity_type": "course",
            "submitted_count": done_count[0]["cnt"] if done_count else 0,
            "target_scope": "",
            "target_grade": course_grade,
            "target_class": "",
        })

    # ── 8. 快速投票（smartkb.db）──
    poll_rows = db_query_dict(
        """SELECT p.id, p.question as title, p.status, p.created_at, p.created_at as updated_at,
                  '' as subject, 0 as total_score, 0 as pass_score, 0 as duration,
                  p.target_scope, p.target_grade, p.target_class,
                  'poll' as activity_type
           FROM interaction_polls p
           WHERE p.creator_username = ?
           ORDER BY p.created_at DESC""",
        (teacher_username,),
    )
    for p in poll_rows:
        sub = db_query_dict(
            "SELECT COUNT(DISTINCT student_username) as cnt FROM interaction_poll_votes WHERE poll_id=?",
            (p["id"],),
        )
        p["submitted_count"] = sub[0]["cnt"] if sub else 0
        activities.append(p)

    # 统一设置创建者姓名（课程练习已有独立的 creator_name，不覆盖）
    for act in activities:
        if act.get("activity_type") != "course":
            act["creator_name"] = _creator_name
    return activities


# ═══════════════════════════════════════════════════════════
# 辅助：获取学生完成情况
# ═══════════════════════════════════════════════════════════

def _get_students_with_completion(
    activity_type: str,
    activity_id: int,
    grade_id: Optional[int] = None,
    class_id: Optional[int] = None,
    teacher_username: str = "",
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    获取某活动的已完成和未完成学生列表
    返回: (completed_students, incomplete_students)
    """
    all_students = get_students_in_scope(
        teacher_username, grade_id=grade_id, class_id=class_id  # type: ignore[arg-type]
    )
    if not all_students:
        return [], []

    student_map = {s["username"]: s for s in all_students}
    completed_map: Dict[str, Dict[str, Any]] = {}

    if activity_type == "exam":
        rows = qdb_query(
            """SELECT student_username, student_name, score, total_score, submitted_at
               FROM exam_attempts WHERE exam_id=? AND status IN ('submitted','graded')""",
            (activity_id,),
        )
        for a in rows:
            uname = a["student_username"]
            if uname not in student_map:
                continue
            completed_map[uname] = {
                "username": uname,
                "name": a.get("student_name") or student_map[uname].get("name", ""),
                "grade": student_map[uname].get("grade", ""),
                "class_name": student_map[uname].get("class", ""),
                "score": a.get("score", 0),
                "total_score": a.get("total_score", 0),
                "submitted_at": a.get("submitted_at", ""),
                "status": "completed",
            }

    elif activity_type == "practice":
        rows = qdb_query(
            """SELECT student_username, score, total_score, submitted_at
               FROM practice_attempts WHERE session_id=? AND status='submitted'""",
            (activity_id,),
        )
        for a in rows:
            uname = a["student_username"]
            if uname not in student_map:
                continue
            completed_map[uname] = {
                "username": uname,
                "name": student_map[uname].get("name", ""),
                "grade": student_map[uname].get("grade", ""),
                "class_name": student_map[uname].get("class", ""),
                "score": a.get("score", 0),
                "total_score": a.get("total_score", 0),
                "submitted_at": a.get("submitted_at", ""),
                "status": "completed",
            }

    elif activity_type == "quick_quiz":
        rows = db_query_dict(
            """SELECT student_username, student_name, total_score, joined_at
               FROM quick_quiz_players WHERE room_id=?""",
            (activity_id,),
        )
        for p in rows:
            uname = p["student_username"]
            if uname not in student_map:
                continue
            completed_map[uname] = {
                "username": uname,
                "name": p.get("student_name") or student_map[uname].get("name", ""),
                "grade": student_map[uname].get("grade", ""),
                "class_name": student_map[uname].get("class", ""),
                "score": p.get("total_score", 0),
                "total_score": 100,
                "submitted_at": p.get("joined_at", ""),
                "status": "completed",
            }

    elif activity_type == "task":
        rows = db_query_dict(
            """SELECT student_username, submitted_at
               FROM task_submissions WHERE task_id=?""",
            (activity_id,),
        )
        # 同时查 task_grades 获取分数
        grade_rows = db_query_dict(
            """SELECT student_username, ai_score FROM task_grades WHERE task_id=?""",
            (activity_id,),
        )
        grade_map = {g["student_username"]: g["ai_score"] for g in grade_rows}
        for a in rows:
            uname = a["student_username"]
            if uname not in student_map:
                continue
            completed_map[uname] = {
                "username": uname,
                "name": student_map[uname].get("name", ""),
                "grade": student_map[uname].get("grade", ""),
                "class_name": student_map[uname].get("class", ""),
                "score": grade_map.get(uname, 0) or 0,
                "total_score": 100,
                "submitted_at": a.get("submitted_at", ""),
                "status": "completed",
            }

    elif activity_type == "quiz":
        rows = db_query_dict(
            """SELECT student_username, score, submitted_at
               FROM interaction_quiz_answers WHERE quiz_id=?""",
            (activity_id,),
        )
        for a in rows:
            uname = a["student_username"]
            if uname not in student_map:
                continue
            completed_map[uname] = {
                "username": uname,
                "name": student_map[uname].get("name", ""),
                "grade": student_map[uname].get("grade", ""),
                "class_name": student_map[uname].get("class", ""),
                "score": a.get("score", 0),
                "total_score": 100,
                "submitted_at": a.get("submitted_at", ""),
                "status": "completed",
            }

    elif activity_type == "code":
        rows = qdb_query(
            """SELECT student_username, score, created_at as submitted_at
               FROM code_submissions
               WHERE problem_id=? AND status='submitted'
               AND is_best=1""",
            (activity_id,),
        )
        # 如果没有 is_best 标记，取最高分记录
        if not rows:
            rows = qdb_query(
                """SELECT student_username, MAX(score) as score, MAX(created_at) as submitted_at
                   FROM code_submissions
                   WHERE problem_id=? AND status='submitted'
                   GROUP BY student_username""",
                (activity_id,),
            )
        for a in rows:
            uname = a["student_username"]
            if uname not in student_map:
                continue
            completed_map[uname] = {
                "username": uname,
                "name": student_map[uname].get("name", ""),
                "grade": student_map[uname].get("grade", ""),
                "class_name": student_map[uname].get("class", ""),
                "score": a.get("score", 0),
                "total_score": 100,
                "submitted_at": a.get("submitted_at", ""),
                "status": "completed",
            }

    elif activity_type == "discussion":
        rows = db_query_dict(
            """SELECT dm.username, dm.joined_at as submitted_at
               FROM discussion_groups dg
               JOIN discussion_members dm ON dm.group_id = dg.id
               WHERE dg.discussion_id=?""",
            (activity_id,),
        )
        for a in rows:
            uname = a["username"]
            if uname not in student_map:
                continue
            completed_map[uname] = {
                "username": uname,
                "name": student_map[uname].get("name", ""),
                "grade": student_map[uname].get("grade", ""),
                "class_name": student_map[uname].get("class", ""),
                "score": 0,
                "total_score": 0,
                "submitted_at": a.get("submitted_at", ""),
                "status": "completed",
            }

    elif activity_type == "course":
        # 课程练习：按知识点从 ai_practice_results 查询完成情况（与 task-todo 一致）
        bind_rows = db_query_dict(
            """SELECT cb.knowledge_point_id, kp.name as kp_name
               FROM curriculum_bindings cb
               JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
               WHERE cb.id=?""",
            (activity_id,),
        )
        if bind_rows:
            kp_id = bind_rows[0]["knowledge_point_id"]
            done_rows = qdb_query(
                "SELECT DISTINCT student_username, accuracy as score FROM ai_practice_results WHERE kp_id=?",
                (kp_id,),
            )
            for a in done_rows:
                uname = a["student_username"]
                if uname not in student_map:
                    continue
                completed_map[uname] = {
                    "username": uname,
                    "name": student_map[uname].get("name", ""),
                    "grade": student_map[uname].get("grade", ""),
                    "class_name": student_map[uname].get("class", ""),
                    "score": round(a.get("score", 0) or 0, 1),
                    "total_score": 100,
                    "submitted_at": "",
                    "status": "completed",
                }

    elif activity_type == "poll":
        rows = db_query_dict(
            """SELECT DISTINCT student_username, MIN(created_at) as submitted_at
               FROM interaction_poll_votes WHERE poll_id=?
               GROUP BY student_username""",
            (activity_id,),
        )
        for a in rows:
            uname = a["student_username"]
            if uname not in student_map:
                continue
            completed_map[uname] = {
                "username": uname,
                "name": student_map[uname].get("name", ""),
                "grade": student_map[uname].get("grade", ""),
                "class_name": student_map[uname].get("class", ""),
                "score": 0,
                "total_score": 0,
                "submitted_at": a.get("submitted_at", ""),
                "status": "completed",
            }

    # 构建已完成列表
    completed = list(completed_map.values())

    # 构建未完成列表
    incomplete = []
    for s in all_students:
        if s["username"] not in completed_map:
            incomplete.append({
                "username": s["username"],
                "name": s.get("name", ""),
                "grade": s.get("grade", ""),
                "class_name": s.get("class", ""),
                "score": 0,
                "total_score": 0,
                "submitted_at": "",
                "status": "incomplete",
            })

    return completed, incomplete


# ════════════════════════════════════════════
# API 端点
# ════════════════════════════════════════════

@router.get("/activity-monitor/activities")
async def list_teacher_activities(
    request: Request,
    activity_type: str = Query("all", description="筛选类型"),
    keyword: str = Query("", description="搜索活动名称关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """获取教师创建的所有活动列表"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    # 管理员可查看全部教师的活动
    if is_admin(username):
        from backend.database import execute_query as db_query
        teacher_rows = db_query("SELECT username FROM users WHERE role IN (0, 1)")
        all_activities = []
        seen: set[tuple[str, int]] = set()
        for row in teacher_rows:
            t_uname = row[0] if row else ""
            if not t_uname:
                continue
            for act in _get_teacher_activities(t_uname):
                key = (act["activity_type"], act["id"])
                if key not in seen:
                    seen.add(key)
                    all_activities.append(act)
    else:
        all_activities = _get_teacher_activities(username)

    # 筛选类型
    if activity_type != "all":
        all_activities = [a for a in all_activities if a["activity_type"] == activity_type]

    # 搜索关键词
    if keyword:
        kw = keyword.lower()
        all_activities = [a for a in all_activities if kw in a["title"].lower()]

    # 排序
    all_activities.sort(key=lambda a: a.get("created_at", ""), reverse=True)

    total = len(all_activities)
    offset = (page - 1) * page_size
    page_items = all_activities[offset:offset + page_size]

    return {
        "activities": page_items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def _lookup_activity(activity_type: str, activity_id: int, username: str):
    """
    根据类型查找活动记录，返回 (record_dict, db_source)
    db_source: 'qdb' 表示 questions.db, 'db' 表示 smartkb.db
    """
    qdb_types = {"exam", "practice", "code"}
    db_types = {"quick_quiz", "task", "quiz", "discussion", "poll", "course"}

    _QDB_TABLES = {"exam": "exams", "practice": "practice_sessions", "code": "code_problems"}
    _DB_TABLES = {
        "quick_quiz": "quick_quiz_rooms",
        "task": "tasks",
        "quiz": "interaction_quizzes",
        "discussion": "discussions",
        "poll": "interaction_polls",
        "course": "courses",
    }

    if activity_type in qdb_types:
        table = _QDB_TABLES[activity_type]
        rows = qdb_query(f"SELECT * FROM {table} WHERE id=? AND creator_username=?", (activity_id, username))
        if not rows and is_admin(username):
            rows = qdb_query(f"SELECT * FROM {table} WHERE id=?", (activity_id,))
        return rows[0] if rows else None, 'qdb'

    elif activity_type in db_types:
        table = _DB_TABLES[activity_type]
        if activity_type == "course":
            # 课程练习按 binding_id 查询，与活动列表保持一致
            rows = db_query_dict(
                """SELECT cb.id, cb.knowledge_point_id, kp.name as kp_name,
                          c.name as title, c.status, c.subject, c.created_at,
                          0 as total_score, 0 as pass_score
                   FROM curriculum_bindings cb
                   JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
                   JOIN chapters ch ON kp.chapter_id = ch.id
                   JOIN courses c ON ch.course_id = c.id
                   WHERE cb.id=?""",
                (activity_id,),
            )
        else:
            rows = db_query_dict(f"SELECT * FROM {table} WHERE id=? AND creator_username=?", (activity_id, username))
            if not rows and is_admin(username):
                rows = db_query_dict(f"SELECT * FROM {table} WHERE id=?", (activity_id,))
        return rows[0] if rows else None, 'db'

    return None, None


@router.get("/activity-monitor/activities/{activity_type}/{activity_id}/status")
async def get_activity_completion_status(
    activity_type: str,
    activity_id: int,
    request: Request,
    grade_id: int = Query(None, description="年级ID"),
    class_id: int = Query(None, description="班级ID"),
    status_filter: str = Query("all", description="筛选: all/completed/incomplete"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """获取某活动的学生完成情况"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    valid_types = set(ACTIVITY_TYPE_LABELS.keys())
    if activity_type not in valid_types:
        raise HTTPException(status_code=400, detail=f"无效的活动类型，可选: {', '.join(valid_types)}")

    result = _lookup_activity(activity_type, activity_id, username)
    if not result or not result[0]:
        raise HTTPException(status_code=404, detail="活动不存在或无权查看")

    activity_rec = result[0]

    # 获取学生完成情况
    completed, incomplete = _get_students_with_completion(
        activity_type, activity_id,
        grade_id=grade_id, class_id=class_id,
        teacher_username=username,
    )

    # 根据状态筛选
    if status_filter == "completed":
        students = completed
    elif status_filter == "incomplete":
        students = incomplete
    else:
        students = completed + incomplete

    total = len(students)
    offset = (page - 1) * page_size
    page_items = students[offset:offset + page_size]

    completed_count = len(completed)
    incomplete_count = len(incomplete)
    avg_score = round(sum(s["score"] for s in completed) / max(completed_count, 1), 1)

    # 标题兼容不同表字段
    act_title = activity_rec.get("title") or activity_rec.get("name") or activity_rec.get("question", "") or ""

    return {
        "activity": {
            "id": activity_rec["id"],
            "title": act_title,
            "type": activity_type,
            "type_label": ACTIVITY_TYPE_LABELS.get(activity_type, activity_type),
            "status": activity_rec.get("status", "") or "",
            "total_score": activity_rec.get("total_score", 0) or 0,
            "pass_score": activity_rec.get("pass_score", 0) or 0,
            "subject": activity_rec.get("subject", "") or "",
            "created_at": activity_rec.get("created_at", "") or "",
        },
        "students": page_items,
        "statistics": {
            "total_students": total,
            "completed_count": completed_count,
            "incomplete_count": incomplete_count,
            "avg_score": avg_score,
            "completion_rate": round(completed_count / max(total, 1) * 100, 1),
        },
        "page": page,
        "page_size": page_size,
        "total": total,
    }


@router.get("/activity-monitor/grades-classes")
async def get_teacher_grades_classes(request: Request):
    """获取教师管辖范围内有实际学生的年级和班级列表（动态加载）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    # 获取教师管辖范围内的所有学生
    students = get_students_in_scope(username)
    if not students:
        return {"grades": []}

    # 按 grade_id 和 grade_name 分组去重
    grade_dict: dict[int, dict[str, Any]] = {}
    class_dict: dict[str, dict[str, Any]] = {}
    for s in students:
        gid = s.get("grade_id")
        gname = s.get("grade") or ""
        cid = s.get("class_id")
        cname = s.get("class") or ""
        if not gid:
            continue
        if gid not in grade_dict:
            grade_dict[gid] = {"grade_id": gid, "grade_name": gname, "classes": {}}
        if cid:
            key = f"{gid}-{cid}"
            if key not in class_dict:
                class_dict[key] = {"class_id": cid, "class_name": cname, "display_name": f"{gname}{cname}班"}
                grade_dict[gid]["classes"][cid] = class_dict[key]

    result = []
    for gid in sorted(grade_dict.keys()):
        g = grade_dict[gid]
        classes_list = sorted(g["classes"].values(), key=lambda x: x["class_id"] or 0)
        result.append({
            "grade_id": g["grade_id"],
            "grade_name": g["grade_name"],
            "stage": "",
            "classes": classes_list,
        })

    return {"grades": result}
