"""
活动完成监控 API 路由
教师查看各种活动（考试、练习、任务、测验等）的完成情况
支持按活动名称、年级、班级筛选已完成/未完成学生及简要成绩
"""
import json
import re
import time
from typing import Optional, Dict, List, Any, Tuple

from fastapi import APIRouter, HTTPException, Request, Query

from backend.api.dependencies import get_current_user
from backend.database import execute_query_dict as db_query_dict, execute_query as db_execute
from backend.question_db import execute_query as qdb_query
from backend.permission_service import (
    get_students_in_scope,
)
from backend import quiz_stats
from backend.auth import is_admin
from backend.logger import logger

router = APIRouter()

# P2: 整班学习进度短 TTL 缓存（监控页频繁刷新, 避免每次重算全班）
_PROGRESS_CACHE: dict = {}
_PROGRESS_CACHE_TTL = 60.0

ACTIVITY_TYPE_LABELS = {
    "exam": "考试",
    "practice": "同步练习",
    "quick_quiz": "知识抢答",
    "task": "在线任务",
    "quiz": "随堂测验",
    "code": "代码练习",
    "discussion": "分组讨论",
    "poll": "快速投票",
    "course": "课程练习",
    "class_ladder": "课堂闯关",
}


# ═══════════════════════════════════════════════════════════
# 辅助：获取教师创建的所有活动
# ═══════════════════════════════════════════════════════════

def _group_counts(query_fn, sql_tpl: str, ids: list) -> Dict[Any, int]:
    """P1: 一次 GROUP BY 取回各活动提交数, 替代逐条 COUNT(N+1)。sql_tpl 含 {ph} 占位。"""
    if not ids:
        return {}
    ph = ",".join("?" for _ in ids)
    rows = query_fn(sql_tpl.format(ph=ph), tuple(ids))
    return {r["aid"]: r["cnt"] for r in rows}


def _get_teacher_activities(teacher_username: str, creators: Optional[List[str]] = None,
                            admin_view: bool = False) -> List[Dict[str, Any]]:
    """获取教师创建的所有活动。

    P1: creators 传入多个创建者(管理员批量)时用 IN 一次查各类, 不再逐教师循环;
    每类提交数用一条 GROUP BY 聚合, 不再逐活动 COUNT。admin_view=True 时课程练习展示全部。
    """
    creators = creators or [teacher_username]
    cph = ",".join("?" for _ in creators)

    # 创建者姓名映射(批量)
    name_map: Dict[str, str] = {}
    _nph = ",".join("?" for _ in creators)
    for r in db_query_dict(
        f"SELECT username, COALESCE(NULLIF(name,''), username) AS dn FROM users WHERE username IN ({_nph})",
        tuple(creators),
    ):
        name_map[r["username"]] = r["dn"]
    _creator_name = name_map.get(teacher_username, teacher_username)

    activities = []

    # ── 1. 考试 ──
    exams = qdb_query(
        f"""SELECT e.id, e.title, e.status, e.created_at, e.updated_at,
                  e.total_score, e.pass_score, e.duration, e.subject,
                  e.target_scope, e.target_grade, e.target_class, e.target_users,
                  e.creator_username, 'exam' as activity_type
           FROM exams e WHERE e.creator_username IN ({cph})
           ORDER BY e.created_at DESC""", tuple(creators))
    _c = _group_counts(qdb_query,
        "SELECT exam_id AS aid, COUNT(DISTINCT student_username) AS cnt FROM exam_attempts "
        "WHERE status IN ('submitted','graded') AND exam_id IN ({ph}) GROUP BY exam_id",
        [e["id"] for e in exams])
    for e in exams:
        e["submitted_count"] = _c.get(e["id"], 0)
        activities.append(e)

    # ── 2. 同步练习 ──
    practices = qdb_query(
        f"""SELECT ps.id, ps.title, ps.status, ps.created_at, ps.updated_at,
                  COALESCE(ps.total_score,0) as total_score, ps.subject,
                  ps.target_grade, ps.target_class, ps.source,
                  ps.target_scope, ps.target_users, ps.target_students,
                  ps.creator_username, 'practice' as activity_type
           FROM practice_sessions ps
           WHERE ps.creator_username IN ({cph})
             AND COALESCE(ps.status, 'active') != 'draft'
             AND (ps.source IS NULL OR ps.source != 'wrong_book')
             AND (ps.target_students IS NULL OR ps.target_students = '')
           ORDER BY ps.created_at DESC""", tuple(creators))
    _c = _group_counts(qdb_query,
        "SELECT session_id AS aid, COUNT(DISTINCT student_username) AS cnt FROM practice_attempts "
        "WHERE status='submitted' AND session_id IN ({ph}) GROUP BY session_id",
        [p["id"] for p in practices])
    for p in practices:
        p["submitted_count"] = _c.get(p["id"], 0)
        p["duration"] = 0
        p["pass_score"] = 0
        activities.append(p)

    # ── 3. 知识抢答 ──
    quick_quiz_rows = db_query_dict(
        f"""SELECT qr.id, qr.title, qr.status, qr.created_at,
                  COALESCE(qr.started_at, qr.created_at) as updated_at,
                  qr.target_scope, qr.target_grade, qr.target_class, qr.target_users, qr.subject,
                  0 as total_score, 0 as pass_score, 0 as duration,
                  qr.creator_username, 'quick_quiz' as activity_type
           FROM quick_quiz_rooms qr WHERE qr.creator_username IN ({cph})
           ORDER BY qr.created_at DESC""", tuple(creators))
    _c = _group_counts(db_query_dict,
        "SELECT room_id AS aid, COUNT(DISTINCT student_username) AS cnt FROM quick_quiz_players "
        "WHERE room_id IN ({ph}) GROUP BY room_id",
        [q["id"] for q in quick_quiz_rows])
    for q in quick_quiz_rows:
        q["submitted_count"] = _c.get(q["id"], 0)
        q["status"] = q.get("status") or "ended"
        activities.append(q)

    # ── 4. 在线任务 ──
    task_rows = db_query_dict(
        f"""SELECT t.id, t.name as title, t.status, t.created_at, t.updated_at,
                  COALESCE(t.subject, '') as subject,
                  0 as total_score, 0 as pass_score, 0 as duration,
                  t.target_scope, t.target_grade, t.target_class, t.target_users,
                  t.creator_username, 'task' as activity_type
           FROM tasks t WHERE t.creator_username IN ({cph})
           ORDER BY t.created_at DESC""", tuple(creators))
    _c = _group_counts(db_query_dict,
        "SELECT task_id AS aid, COUNT(DISTINCT student_username) AS cnt FROM task_submissions "
        "WHERE task_id IN ({ph}) GROUP BY task_id",
        [t["id"] for t in task_rows])
    for t in task_rows:
        t["submitted_count"] = _c.get(t["id"], 0)
        activities.append(t)

    # ── 5. 随堂测验 ──
    quiz_rows = db_query_dict(
        f"""SELECT iq.id, iq.title, iq.status, iq.created_at, iq.updated_at, iq.questions,
                  COALESCE(iq.subject, '') as subject,
                  0 as total_score, 0 as pass_score, 0 as duration,
                  iq.target_scope, iq.target_grade, iq.target_class, iq.target_users,
                  iq.creator_username, 'quiz' as activity_type
           FROM interaction_quizzes iq
           WHERE iq.creator_username IN ({cph}) AND COALESCE(iq.status, 'active') != 'draft'
           ORDER BY iq.created_at DESC""", tuple(creators))
    _quiz_subj = quiz_stats.quiz_subjects(quiz_rows)
    _c = _group_counts(db_query_dict,
        "SELECT quiz_id AS aid, COUNT(DISTINCT student_username) AS cnt FROM interaction_quiz_answers "
        "WHERE quiz_id IN ({ph}) GROUP BY quiz_id",
        [qz["id"] for qz in quiz_rows])
    for qz in quiz_rows:
        qz["subject"] = (qz.get("subject") or "").strip() or _quiz_subj.get(qz["id"], "")
        qz.pop("questions", None)
        qz["submitted_count"] = _c.get(qz["id"], 0)
        activities.append(qz)

    # ── 6. 代码练习 ──
    code_rows = qdb_query(
        f"""SELECT cp.id, cp.title, cp.status, cp.created_at, cp.updated_at, cp.subject,
                  0 as total_score, 0 as pass_score, 0 as duration,
                  cp.target_scope, cp.target_grade, cp.target_class, cp.target_users,
                  cp.creator_username, 'code' as activity_type
           FROM code_problems cp WHERE cp.creator_username IN ({cph}) AND cp.status = 'active'
           ORDER BY cp.created_at DESC""", tuple(creators))
    _c = _group_counts(qdb_query,
        "SELECT problem_id AS aid, COUNT(DISTINCT student_username) AS cnt FROM code_submissions "
        "WHERE status='submitted' AND problem_id IN ({ph}) GROUP BY problem_id",
        [c["id"] for c in code_rows])
    for c in code_rows:
        c["submitted_count"] = _c.get(c["id"], 0)
        activities.append(c)

    # ── 7. 分组讨论 ──
    disc_rows = db_query_dict(
        f"""SELECT d.id, d.title, d.status, d.created_at, d.updated_at,
                  d.target_scope, d.target_grade, d.target_class, d.target_users, d.subject,
                  0 as total_score, 0 as pass_score, 0 as duration,
                  d.creator_username, 'discussion' as activity_type
           FROM discussions d WHERE d.creator_username IN ({cph})
           ORDER BY d.created_at DESC""", tuple(creators))
    _c = _group_counts(db_query_dict,
        "SELECT dg.discussion_id AS aid, COUNT(DISTINCT m.username) AS cnt "
        "FROM discussion_groups dg JOIN discussion_messages m ON m.group_id = dg.id "
        "WHERE m.username IS NOT NULL AND m.username <> '' AND dg.discussion_id IN ({ph}) "
        "GROUP BY dg.discussion_id",
        [d["id"] for d in disc_rows])
    for d in disc_rows:
        d["submitted_count"] = _c.get(d["id"], 0)
        d["status"] = d.get("status") or "pending"
        activities.append(d)

    # ── 8. 课程练习（按绑定资源细分, 完成数按 ai_practice_results）──
    course_grade_set: set = set()
    if not admin_view:
        for ta in db_query_dict(
            "SELECT DISTINCT g.name as grade_name FROM teacher_assignments ta "
            "JOIN grades g ON ta.grade_id=g.id WHERE ta.teacher_username=?", (teacher_username,)):
            gn = (ta.get("grade_name") or "").strip()
            if gn:
                course_grade_set.add(gn)
    bind_rows = db_query_dict(
        """SELECT cb.id as binding_id, cb.knowledge_point_id,
                  kp.name as kp_name, c.name as course_name, c.id as course_id,
                  c.subject, c.status as course_status, c.grade as course_grade,
                  cb.created_at as binding_at, c.updated_at,
                  COALESCE(sr.file_path, '') as fp, COALESCE(sr.file_name, '') as fn,
                  sr.owner_username
           FROM curriculum_bindings cb
           JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
           JOIN chapters ch ON kp.chapter_id = ch.id
           JOIN courses c ON ch.course_id = c.id
           LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
           WHERE cb.resource_type='html' AND c.status='active'
           ORDER BY c.sort_order, ch.sort_order, kp.sort_order, cb.id""")
    kept = []
    for b in bind_rows:
        fn = str(b["fn"] or "")
        fp = str(b["fp"] or "")
        if "_练习.html" not in fn and "_练习.html" not in fp:
            continue
        course_grade = (b.get("course_grade") or "").strip()
        if not admin_view:
            if b.get("owner_username") != teacher_username:
                continue
            if not course_grade or not course_grade_set or course_grade not in course_grade_set:
                continue
        kept.append(b)
    _done = _group_counts(qdb_query,
        "SELECT kp_id AS aid, COUNT(DISTINCT student_username) AS cnt FROM ai_practice_results "
        "WHERE kp_id IN ({ph}) GROUP BY kp_id",
        [b["knowledge_point_id"] for b in kept])
    _owners = {b.get("owner_username") for b in kept if b.get("owner_username")}
    _owner_names: Dict[str, str] = {}
    if _owners:
        _oph = ",".join("?" for _ in _owners)
        for r in db_query_dict(
            f"SELECT username, COALESCE(NULLIF(name,''), username) AS dn FROM users WHERE username IN ({_oph})",
            tuple(_owners)):
            _owner_names[r["username"]] = r["dn"]
    for b in kept:
        practice_name = b["fn"]
        if practice_name.endswith("_练习.html"):
            practice_name = practice_name[:-len("_练习.html")]
        if not practice_name:
            practice_name = f"{b['course_name']} - {b['kp_name']}"
        owner = b.get("owner_username")
        course_grade = (b.get("course_grade") or "").strip()
        activities.append({
            "id": b["binding_id"],
            "title": practice_name,
            "creator_name": _owner_names.get(owner, _creator_name),
            "creator_username": owner or teacher_username,
            "status": "available" if (b.get("course_status") or "") == "active" else "inactive",
            "created_at": b.get("binding_at") or b.get("updated_at") or "",
            "updated_at": b["updated_at"],
            "subject": b.get("subject", "") or "",
            "total_score": 0, "pass_score": 0, "duration": 0,
            "activity_type": "course",
            "submitted_count": _done.get(b["knowledge_point_id"], 0),
            "target_scope": "grade" if course_grade else "",
            "target_grade": course_grade,
            "target_class": "",
        })

    # ── 9. 快速投票 ──
    poll_rows = db_query_dict(
        f"""SELECT p.id, p.question as title, p.status, p.created_at, p.created_at as updated_at,
                  COALESCE(p.subject, '') as subject,
                  0 as total_score, 0 as pass_score, 0 as duration,
                  p.target_scope, p.target_grade, p.target_class, p.target_users,
                  p.creator_username, 'poll' as activity_type
           FROM interaction_polls p WHERE p.creator_username IN ({cph})
           ORDER BY p.created_at DESC""", tuple(creators))
    _c = _group_counts(db_query_dict,
        "SELECT poll_id AS aid, COUNT(DISTINCT student_username) AS cnt FROM interaction_poll_votes "
        "WHERE poll_id IN ({ph}) GROUP BY poll_id",
        [p["id"] for p in poll_rows])
    for p in poll_rows:
        p["submitted_count"] = _c.get(p["id"], 0)
        activities.append(p)

    # ── 10. 课堂闯关（大屏版）──
    ladder_rows = db_query_dict(
        f"""SELECT id, COALESCE(NULLIF(topic,''), NULLIF(subject,''), '课堂闯关') as title,
                  CASE status WHEN 'ready' THEN 'active' ELSE status END as status,
                  created_at, updated_at, COALESCE(subject,'') as subject,
                  0 as total_score, 0 as pass_score, 0 as duration,
                  'class' as target_scope, grade as target_grade, class_name as target_class,
                  '' as target_users, teacher_username AS creator_username, 'class_ladder' as activity_type
           FROM class_ladder_sessions WHERE teacher_username IN ({cph})
           ORDER BY created_at DESC""", tuple(creators))
    _lids = [p["id"] for p in ladder_rows]
    _agg: Dict[Any, Any] = {}
    if _lids:
        _lph = ",".join("?" for _ in _lids)
        for r in db_query_dict(
            f"SELECT session_id AS aid, COUNT(*) AS runs, "
            f"COUNT(DISTINCT CASE WHEN status != 'playing' THEN student_name END) AS students "
            f"FROM class_ladder_runs WHERE session_id IN ({_lph}) GROUP BY session_id", tuple(_lids)):
            _agg[r["aid"]] = r
    for p in ladder_rows:
        a = _agg.get(p["id"])
        p["submitted_count"] = (a["students"] if a else 0) or 0
        p["run_count"] = (a["runs"] if a else 0) or 0
        activities.append(p)

    # 统一创建者姓名与范围字段兜底（课程练习已有独立 creator_name, 不覆盖）
    for act in activities:
        if act.get("activity_type") != "course":
            cu = act.get("creator_username") or teacher_username
            act["creator_name"] = name_map.get(cu, cu)
            act["creator_username"] = cu
        act.setdefault("target_scope", "")
        act.setdefault("target_grade", "")
        act.setdefault("target_class", "")
        act.setdefault("target_users", "")
    return activities


def _split_targets(value: Any) -> List[str]:
    """target_users / target_grade / target_class 都是逗号串（可能混中文逗号）"""
    raw = str(value or "").replace("，", ",").replace("、", ",")
    return [x.strip() for x in raw.split(",") if x.strip()]


def _num_class(value: Any) -> str:
    """班级归一：'1' / '1班' / '高一1班' 都取数字部分；没有数字就原样返回"""
    s = str(value or "").strip()
    m = re.search(r"(\d+)", s)
    return m.group(1) if m else s


def _activity_scope(rec: Dict[str, Any]) -> str:
    return str(rec.get("target_scope") or "").strip() or "teacher_classes"


def _filter_activity_target(students: List[Dict[str, Any]], rec: Dict[str, Any]) -> List[Dict[str, Any]]:
    """按**活动自身**的对象范围收窄名册。

    旧口径只按"查看者权限范围"算应完成人数：一份只发给高一1班的练习，在没选班级时
    会按全校 1406 人算应完成/未完成（截图里的 0/1406 就是这么来的）。
    这里先看活动发给谁（点名 → 年级/班级），再与查看者权限、页面筛选取交集。
    """
    scope = _activity_scope(rec)

    # 点名到人：同步练习用 target_students(JSON)，其它活动用 target_users(逗号串)
    named: List[str] = []
    raw_named = rec.get("target_students")
    if raw_named:
        try:
            parsed = json.loads(raw_named) if isinstance(raw_named, str) else raw_named
            if isinstance(parsed, list):
                named = [str(x).strip() for x in parsed if str(x).strip()]
        except (json.JSONDecodeError, TypeError):
            named = _split_targets(raw_named)
    if not named:
        named = _split_targets(rec.get("target_users"))
    if named:
        keep = set(named)
        return [s for s in students if s.get("username") in keep]

    if scope in ("grade", "class"):
        grades = _split_targets(rec.get("target_grade"))
        if grades:
            students = [s for s in students if (s.get("grade") or "").strip() in grades]
        if scope == "class":
            classes = {_num_class(x) for x in _split_targets(rec.get("target_class"))}
            if classes:
                students = [s for s in students if _num_class(s.get("class")) in classes]
    return students


def _activity_roster(
    rec: Dict[str, Any],
    viewer_username: str,
    role: int,
    grade_id: Optional[int] = None,
    class_id: Optional[int] = None,
    cache: Optional[Dict[Tuple[str, Any, Any], List[Dict[str, Any]]]] = None,
) -> List[Dict[str, Any]]:
    """应完成名册 = 活动对象范围 ∩ 查看者权限范围 ∩ 页面筛选。

    管理员看老活动（默认 teacher_classes）时按**创建者**的任教范围算，
    否则会退化成全校学生。
    """
    creator = str(rec.get("creator_username") or "").strip()
    scope = _activity_scope(rec)
    owner = creator if (role == 0 and creator and scope == "teacher_classes") else viewer_username
    key = (owner, grade_id, class_id)
    if cache is not None and key in cache:
        base = cache[key]
    else:
        base = get_students_in_scope(owner, grade_id=grade_id, class_id=class_id)
        if cache is not None:
            cache[key] = base
    return _filter_activity_target(base, rec)


def _get_students_with_completion(
    activity_type: str,
    activity_id: int,
    grade_id: Optional[int] = None,
    class_id: Optional[int] = None,
    teacher_username: str = "",
    all_students: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    获取某活动的已完成和未完成学生列表
    返回: (completed_students, incomplete_students)

    all_students：调用方（活动列表）已经查过同一份名册时传进来，避免一页 20 条活动
    重复查 20 次名册；不传则按 grade_id/class_id 现查。
    """
    if all_students is None:
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
        # 同时查 task_grades 获取分数：教师改过就以教师分为准（文件作业必有这一步）
        grade_rows = db_query_dict(
            """SELECT student_username, COALESCE(teacher_score, ai_score) AS score
               FROM task_grades WHERE task_id=?""",
            (activity_id,),
        )
        grade_map = {g["student_username"]: g["score"] for g in grade_rows}
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
        # ★ 与随堂测验页共用同一份口径（backend/quiz_stats.py，全站唯一实现）：
        #   得分统一 100 分制 —— 满分固定 100，老测验(满分=题数)按得分率折算过来，
        #   原始分另给 raw_score/raw_total_score。旧实现这里把满分写死 100 却又直接
        #   塞原始分，于是"5 题答对 3 题"显示成 3/100（3%），随堂测验页却是 3/5（60%）。
        _q_rows = db_query_dict("SELECT questions FROM interaction_quizzes WHERE id=?", (activity_id,))
        quiz_total = quiz_stats.quiz_total(quiz_stats.quiz_questions(_q_rows[0])) if _q_rows else 0.0
        cent_total = 100.0 if quiz_total > 0 else quiz_total
        rows = db_query_dict(
            """SELECT student_username, score, submitted_at, graded, ai_pending
               FROM interaction_quiz_answers WHERE quiz_id=?""",
            (activity_id,),
        )
        for a in rows:
            uname = a["student_username"]
            if uname not in student_map:
                continue
            # 主观题还在后台批改时分数未定：随堂测验页会标"批改中"、不计入正确率，
            # 监控这边同样不能把半个分当成最终成绩展示
            pending = len(quiz_stats.pending_keys(quiz_stats.quiz_graded(a.get("graded"))))
            raw_score = float(a.get("score") or 0)
            cent = quiz_stats.centesimal(raw_score, quiz_total)
            completed_map[uname] = {
                "username": uname,
                "name": student_map[uname].get("name", ""),
                "grade": student_map[uname].get("grade", ""),
                "class_name": student_map[uname].get("class", ""),
                "score": cent if cent is not None else round(raw_score, 1),   # 百分制
                "total_score": cent_total,                                    # 固定 100
                "raw_score": round(raw_score, 1),                             # 原始分(附注用)
                "raw_total_score": quiz_total,
                "percentage": cent,
                "pending_ai": pending,
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
        # 完成 = 至少发过一条言。旧口径是"加入小组就算"，学生点进小组什么都不做
        # 也算完成，完成率会虚高；这里改成看 discussion_messages 里的真实发言。
        rows = db_query_dict(
            """SELECT m.username, MIN(m.created_at) as submitted_at
               FROM discussion_groups dg
               JOIN discussion_messages m ON m.group_id = dg.id
               WHERE dg.discussion_id=? AND m.username IS NOT NULL AND m.username <> ''
               GROUP BY m.username""",
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
                "SELECT DISTINCT student_username, accuracy as score, submitted_at "
                "FROM ai_practice_results WHERE kp_id=?",
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
                    # 之前这里写死空串，名册里的"完成时间"永远是空的（列本身有值，白丢）
                    "submitted_at": a.get("submitted_at") or "",
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

    elif activity_type == "class_ladder":
        # 局记录早期只按姓名记账（大屏口播用），后来才补的 student_username，
        # 两种都要认：先按学号直查，学号空着再按 姓名+年级+班级号 反查。
        # 班级两边必须过 _num_class：users.class 存的是数字（1），场次存的是"高一1班"，
        # 直接字符串相等永远匹配不上，完成列表会整片空白。
        by_name = {}
        for uname, info in student_map.items():
            by_name[(str(info.get("name") or ""), str(info.get("grade") or ""),
                     _num_class(info.get("class")))] = uname
        rows = db_query_dict(
            """SELECT r.student_name,
                      MAX(NULLIF(COALESCE(r.student_username, ''), '')) as student_username,
                      s.grade, s.class_name, COUNT(*) as runs,
                      MAX(r.ladder_score) as best,
                      MAX(COALESCE(r.ended_at, r.created_at)) as submitted_at
               FROM class_ladder_runs r JOIN class_ladder_sessions s ON s.id = r.session_id
               WHERE r.session_id=? AND r.status != 'playing'
               GROUP BY r.student_name, s.grade, s.class_name""",
            (activity_id,),
        )
        for a in rows:
            uname = str(a.get("student_username") or "").strip()
            if uname not in student_map:
                uname = by_name.get((str(a.get("student_name") or ""), str(a.get("grade") or ""),
                                     _num_class(a.get("class_name")))) or ""
            if not uname or uname not in student_map:
                continue
            completed_map[uname] = {
                "username": uname,
                "name": student_map[uname].get("name", ""),
                "grade": student_map[uname].get("grade", ""),
                "class_name": student_map[uname].get("class", ""),
                "score": int(a.get("best") or 0),
                "total_score": 415,
                "submitted_at": a.get("submitted_at") or "",
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
def list_teacher_activities(
    request: Request,
    activity_type: str = Query("all", description="筛选类型"),
    keyword: str = Query("", description="搜索活动名称关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    grade_id: Optional[int] = Query(None, description="按班级统计完成情况时的年级ID"),
    class_id: Optional[int] = Query(None, description="按班级统计完成情况时的班级ID"),
):
    """获取教师创建的所有活动列表"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    # 管理员可查看全部教师的活动（P1: 批量 IN 一次查各类, 不再逐教师循环扇出）
    if is_admin(username):
        teacher_rows = db_execute("SELECT username FROM users WHERE role IN (0, 1)")
        creators = [r[0] for r in teacher_rows if r and r[0]]
        all_activities = _get_teacher_activities(username, creators=creators, admin_view=True)
        seen: set[tuple[str, int]] = set()
        deduped = []
        for act in all_activities:
            key = (act["activity_type"], act["id"])
            if key not in seen:
                seen.add(key)
                deduped.append(act)
        all_activities = deduped
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

    # ── 统一完成口径（只有选了班级才给分母）──
    # 分子必须与「完成情况」详情同一个函数算出来，否则列表和详情必然对不上；
    # 名册走 get_students_in_scope：教师只取本人任教班级，管理员可取任意班级。
    # 只选年级也统计（= 该年级全部班级）；两个都不选就不给分母。
    if grade_id or class_id:
        # 每场活动各自的名册：活动对象范围（年级/班级/指定学生）∩ 查看者权限 ∩ 页面筛选
        roster_cache: Dict[Tuple[str, Any, Any], List[Dict[str, Any]]] = {}
        for act in page_items:
            roster = _activity_roster(act, username, role, grade_id, class_id, roster_cache)
            total_students = len(roster)
            try:
                done, _ = _get_students_with_completion(
                    act["activity_type"], act["id"],
                    grade_id=grade_id, class_id=class_id,
                    teacher_username=username, all_students=roster,
                )
                completed_n = len(done)
            except Exception as e:      # 单个活动统计失败不该让整页打不开
                logger.warning(f"[活动监控] {act.get('activity_type')}#{act.get('id')} 完成统计失败: {e}")
                completed_n = int(act.get("submitted_count") or 0)
            act["student_count"] = total_students
            act["submitted_count"] = completed_n
            act["incomplete_count"] = max(total_students - completed_n, 0)
            act["completion_rate"] = (round(completed_n * 100.0 / total_students, 1)
                                      if total_students else 0.0)

    # 定向名单只在服务端用来算名册，不下发给前端
    for act in page_items:
        act.pop("target_students", None)

    return {
        "activities": page_items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def _unregistered_type(activity_type: str):
    """活动类型进了 ACTIVITY_TYPE_LABELS 却没配表名：按"查不到"处理并记一条日志。

    以前这里直接 KeyError → 500，界面上只剩一句"加载完成情况失败"，看不出是配置漏了。
    """
    logger.error(f"[活动监控] 活动类型 {activity_type} 未登记数据表，无法查询完成情况")
    return None, None


def _lookup_activity(activity_type: str, activity_id: int, username: str):
    """
    根据类型查找活动记录，返回 (record_dict, db_source)
    db_source: 'qdb' 表示 questions.db, 'db' 表示 smartkb.db
    """
    qdb_types = {"exam", "practice", "code"}
    db_types = {"quick_quiz", "task", "quiz", "discussion", "poll", "course", "class_ladder"}

    _QDB_TABLES = {"exam": "exams", "practice": "practice_sessions", "code": "code_problems"}
    _DB_TABLES = {
        "quick_quiz": "quick_quiz_rooms",
        "task": "tasks",
        "quiz": "interaction_quizzes",
        "discussion": "discussions",
        "poll": "interaction_polls",
        "course": "courses",
        "class_ladder": "class_ladder_sessions",
    }

    if activity_type in qdb_types:
        table = _QDB_TABLES.get(activity_type)
        if not table:
            return _unregistered_type(activity_type)
        rows = qdb_query(f"SELECT * FROM {table} WHERE id=? AND creator_username=?", (activity_id, username))
        if not rows and is_admin(username):
            rows = qdb_query(f"SELECT * FROM {table} WHERE id=?", (activity_id,))
        return rows[0] if rows else None, 'qdb'

    elif activity_type in db_types:
        table = _DB_TABLES.get(activity_type)
        if not table:
            return _unregistered_type(activity_type)
        if activity_type == "course":
            # 课程练习按 binding_id 查询，与活动列表保持一致；
            # 带上资源属主，供权限判断（教师只能看自己共享的练习，与列表/重置同口径）
            rows = db_query_dict(
                """SELECT cb.id, cb.knowledge_point_id, kp.name as kp_name,
                          c.name as title, c.status, c.subject, c.created_at,
                          COALESCE(sr.owner_username, '') as owner_username,
                          'grade' as target_scope, c.grade as target_grade,
                          0 as total_score, 0 as pass_score
                   FROM curriculum_bindings cb
                   JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
                   JOIN chapters ch ON kp.chapter_id = ch.id
                   JOIN courses c ON ch.course_id = c.id
                   LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
                   WHERE cb.id=?""",
                (activity_id,),
            )
            if rows and not is_admin(username) and (rows[0].get("owner_username") or "") != username:
                # 别人共享的练习：详情一律按"不存在"处理，避免绕过列表直接查
                return None, "db"
        elif activity_type == "class_ladder":
            # 闯关场次表用 teacher_username 记属主，列名也和统一口径不同
            # （topic/subject/grade/class_name），这里按活动列表同一套别名取列，
            # 否则"统计范围"标签和应完成名册都会失真（曾经直接 KeyError → 500）。
            ladder_cols = """id,
                       COALESCE(NULLIF(topic,''), NULLIF(subject,''), '课堂闯关') as title,
                       CASE status WHEN 'ready' THEN 'active' ELSE status END as status,
                       created_at, updated_at, COALESCE(subject,'') as subject,
                       teacher_username as creator_username,
                       0 as total_score, 0 as pass_score,
                       'class' as target_scope, grade as target_grade,
                       class_name as target_class, '' as target_users"""
            rows = db_query_dict(f"SELECT {ladder_cols} FROM class_ladder_sessions "
                                 f"WHERE id=? AND teacher_username=?", (activity_id, username))
            if not rows and is_admin(username):
                rows = db_query_dict(f"SELECT {ladder_cols} FROM class_ladder_sessions WHERE id=?",
                                     (activity_id,))
        else:
            rows = db_query_dict(f"SELECT * FROM {table} WHERE id=? AND creator_username=?", (activity_id, username))
            if not rows and is_admin(username):
                rows = db_query_dict(f"SELECT * FROM {table} WHERE id=?", (activity_id,))
        return rows[0] if rows else None, 'db'

    return None, None


@router.get("/activity-monitor/activities/{activity_type}/{activity_id}/status")
def get_activity_completion_status(
    activity_type: str,
    activity_id: int,
    request: Request,
    grade_id: int = Query(None, description="年级ID"),
    class_id: int = Query(None, description="班级ID"),
    status_filter: str = Query("all", description="筛选: all/completed/incomplete"),
    student_kw: str = Query("", description="学生姓名/学号/班级关键字"),
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

    # 随堂测验表没有 total_score/pass_score 列：按全站统一口径现算 —— 对外满分固定
    # 100（得分也已是百分制），原始满分放进 raw_total_score 备查。
    if activity_type == "quiz":
        _q_total = quiz_stats.quiz_total(quiz_stats.quiz_questions(activity_rec))
        _cent_total = 100.0 if _q_total > 0 else _q_total
        activity_rec = {**activity_rec, "total_score": _cent_total,
                        "pass_score": round(_cent_total * 0.6, 1),
                        "raw_total_score": _q_total}
        # 科目：优先用建卷时选的（已落库），老测验才按题目反查题库（与活动列表同一口径）
        activity_rec["subject"] = ((activity_rec.get("subject") or "").strip()
                                   or quiz_stats.quiz_subjects([activity_rec]).get(activity_rec.get("id"), ""))

    # 应完成名册：活动对象范围（高一1班 / 指定学生…）∩ 查看者权限 ∩ 页面筛选。
    # 不这样收窄的话，"只发给一个班"的练习会被算成全校 1406 人应完成。
    roster = _activity_roster(activity_rec, username, role, grade_id, class_id)

    # 获取学生完成情况
    completed, incomplete = _get_students_with_completion(
        activity_type, activity_id,
        grade_id=grade_id, class_id=class_id,
        teacher_username=username, all_students=roster,
    )

    # 统计卡片永远按"全量名册"算：旧写法先按状态筛选再取长度，切到「已完成」时
    # 应完成人数会跟着变成已完成人数、完成率直接显示 100%，是个误导人的口径。
    _all_students = completed + incomplete
    _stats_base = len(_all_students)

    # 根据状态筛选（只影响下面的名单，不影响统计数字）
    if status_filter == "completed":
        students = completed
    elif status_filter == "incomplete":
        students = incomplete
    else:
        students = _all_students

    # 学生关键字过滤（姓名/学号/年级/班级）——仅过滤列表，统计卡片保持过滤前口径
    _kw = (student_kw or "").strip().lower()
    if _kw:
        students = [
            s for s in students
            if any(_kw in str(s.get(f, "") or "").lower()
                   for f in ("username", "name", "grade", "class", "class_name"))
        ]

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
            # 活动自己的对象范围（前端据此显示"统计范围：高一1班 / 指定学生 N 人"）
            "target_scope": activity_rec.get("target_scope", "") or "",
            "target_grade": activity_rec.get("target_grade", "") or "",
            "target_class": activity_rec.get("target_class", "") or "",
            "target_users": activity_rec.get("target_users", "") or "",
        },
        "students": page_items,
        "statistics": {
            "total_students": _stats_base,
            "completed_count": completed_count,
            "incomplete_count": incomplete_count,
            "avg_score": avg_score,
            "completion_rate": round(completed_count / max(_stats_base, 1) * 100, 1),
        },
        "page": page,
        "page_size": page_size,
        "total": total,
    }


@router.get("/activity-monitor/grades-classes")
def get_teacher_grades_classes(request: Request):
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


def _course_total_for_grade(grade: str) -> int:
    """P2: 某年级的课程练习总数（同年级学生共用, 避免逐人重算重 JOIN+LIKE）。"""
    if grade:
        total_rows = db_execute(
            """SELECT COUNT(*) FROM curriculum_bindings cb
               JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
               JOIN chapters ch ON kp.chapter_id = ch.id
               JOIN courses c ON ch.course_id = c.id
               LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
               WHERE cb.resource_type='html' AND c.status='active'
                 AND (c.grade = '' OR INSTR(c.grade, ?) > 0)
                 AND (COALESCE(sr.file_name, '') LIKE '%_练习.html'
                      OR COALESCE(sr.file_path, '') LIKE '%_练习.html')""",
            (grade,),
        )
    else:
        total_rows = db_execute(
            """SELECT COUNT(*) FROM curriculum_bindings cb
               JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
               JOIN chapters ch ON kp.chapter_id = ch.id
               JOIN courses c ON ch.course_id = c.id
               LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
               WHERE cb.resource_type='html' AND c.status='active' AND c.grade=''
                 AND (COALESCE(sr.file_name, '') LIKE '%_练习.html'
                      OR COALESCE(sr.file_path, '') LIKE '%_练习.html')""",
        )
    return total_rows[0][0] if total_rows else 0


def _calc_student_progress(username: str, precomputed: Optional[dict] = None) -> dict[str, Any]:
    """计算单个学生的学习进度统计（与 dashboard task-todo 一致）"""
    from datetime import datetime, date, timedelta
    stats: dict[str, Any] = {
        "username": username,
        "course_progress": 0,
        "completion_rate": 0,
        "accuracy_rate": 0,
        "streak_days": 0,
        "course_done": 0,
        "course_total": 0,
        "exam_done": 0,
        "practice_done": 0,
        "code_done": 0,
    }
    try:
        # 学生年级
        grade_rows = db_execute(
            "SELECT grade FROM users WHERE username=?", (username,),
        )
        grade = str(grade_rows[0][0] or "").strip() if grade_rows else ""

        # 课程进度（P2: 优先用调用方按年级预算的 course_total）
        _pre = precomputed or {}
        if "course_total" in _pre:
            stats["course_total"] = _pre["course_total"]
        else:
            stats["course_total"] = _course_total_for_grade(grade)

        if "course_done" in _pre:
            stats["course_done"] = _pre["course_done"]
        else:
            done_rows = qdb_query(
                "SELECT COUNT(DISTINCT kp_id) as cnt FROM ai_practice_results WHERE student_username=?",
                (username,),
            )
            stats["course_done"] = done_rows[0]["cnt"] if done_rows else 0
        stats["course_progress"] = round(stats["course_done"] / stats["course_total"] * 100) if stats["course_total"] > 0 else 0

        # 完成率
        if "exam_done" in _pre:
            stats["exam_done"] = _pre["exam_done"]
        else:
            exam_done_rows = qdb_query(
                "SELECT COUNT(*) as cnt FROM exam_attempts WHERE student_username=? AND status IN ('submitted','graded')",
                (username,),
            )
            stats["exam_done"] = exam_done_rows[0]["cnt"] if exam_done_rows else 0

        if "practice_done" in _pre:
            stats["practice_done"] = _pre["practice_done"]
        else:
            practice_done_rows = qdb_query(
                "SELECT COUNT(*) as cnt FROM practice_attempts WHERE student_username=? AND status='submitted'",
                (username,),
            )
            stats["practice_done"] = practice_done_rows[0]["cnt"] if practice_done_rows else 0

        # 已完成代码练习数：统计状态为 accepted 且为最佳提交的题目数
        if "code_done" in _pre:
            stats["code_done"] = _pre["code_done"]
        else:
            code_done_rows = qdb_query(
                "SELECT COUNT(DISTINCT problem_id) as cnt FROM code_submissions WHERE student_username=? AND status='accepted' AND is_best=1",
                (username,),
            )
            stats["code_done"] = code_done_rows[0]["cnt"] if code_done_rows else 0

        completed = stats["exam_done"] + stats["practice_done"] + stats["course_done"] + stats["code_done"]

        # 待完成数：从各表查询未完成的记录（与 dashboard task-todo 逻辑保持一致）
        # 考试待完成
        exam_pending_rows = qdb_query(
            """SELECT COUNT(*) as cnt FROM exams e
               WHERE e.status='published'
                 AND e.id NOT IN (
                   SELECT exam_id FROM exam_attempts WHERE student_username=? AND status IN ('submitted','graded')
                 )""",
            (username,),
        )
        pending = exam_pending_rows[0]["cnt"] if exam_pending_rows else 0

        # 同步练习待完成
        practice_pending_rows = qdb_query(
            """SELECT COUNT(*) as cnt FROM practice_sessions ps
               WHERE ps.status='active'
                 AND ps.id NOT IN (
                   SELECT session_id FROM practice_attempts WHERE student_username=?
                 )""",
            (username,),
        )
        pending += practice_pending_rows[0]["cnt"] if practice_pending_rows else 0

        # 课程练习待完成
        pending += max(0, stats["course_total"] - stats["course_done"])

        # 代码练习待完成
        code_pending_rows = qdb_query(
            """SELECT COUNT(*) as cnt FROM code_problems cp
               WHERE cp.status='active'
                 AND cp.id NOT IN (
                   SELECT cs.problem_id FROM code_submissions cs
                   WHERE cs.student_username=? AND cs.is_best=1 AND cs.status='accepted'
                 )""",
            (username,),
        )
        pending += code_pending_rows[0]["cnt"] if code_pending_rows else 0

        stats["completion_rate"] = round(completed / (completed + pending) * 100) if (completed + pending) > 0 else 0

        # 正确率
        exam_rows = qdb_query(
            """SELECT ea.score, e.total_score
               FROM exam_attempts ea
               JOIN exams e ON ea.exam_id = e.id
               WHERE ea.student_username=? AND ea.status IN ('submitted','graded') AND e.total_score > 0""",
            (username,),
        )
        exam_acc = 0.0
        exam_count = len(exam_rows) if exam_rows else 0
        if exam_rows:
            total_score_sum = sum(r["total_score"] for r in exam_rows)
            actual_score_sum = sum(r["score"] for r in exam_rows)
            exam_acc = actual_score_sum / total_score_sum * 100 if total_score_sum > 0 else 0

        course_rows = qdb_query(
            "SELECT accuracy FROM ai_practice_results WHERE student_username=? AND accuracy IS NOT NULL",
            (username,),
        )
        course_acc = 0.0
        course_count = len(course_rows) if course_rows else 0
        if course_rows:
            course_acc = sum(r["accuracy"] for r in course_rows) / course_count

        total_acc_count = exam_count + course_count
        if total_acc_count > 0:
            weighted_acc = (exam_acc * exam_count + course_acc * course_count) / total_acc_count
            stats["accuracy_rate"] = round(weighted_acc * 100, 1) if max(exam_acc, course_acc) <= 1 else round(weighted_acc, 1)

        # 连续学习天数
        streak_rows = db_execute(
            """SELECT DISTINCT DATE(login_time) as d FROM login_logs
               WHERE username=? ORDER BY d DESC LIMIT 60""",
            (username,),
        )
        if streak_rows:
            streak_days = 0
            check_date = date.today()
            for row in streak_rows:
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

        # 学生姓名
        name_rows = db_execute(
            "SELECT COALESCE(NULLIF(name,''), username) FROM users WHERE username=?",
            (username,),
        )
        stats["student_name"] = name_rows[0][0] if name_rows else username
    except Exception as e:
        logger.warning(f"[learning-progress] 计算学生进度失败 ({username}): {e}")

    return stats


@router.get("/activity-monitor/learning-progress", summary="获取学习进度统计")
def get_learning_progress(
    request: Request,
    grade: str = Query(default=""),
    class_name: str = Query(default=""),
    username: str = Query(default=""),
):
    """获取学习进度统计，支持按班级汇总或单个学生查询

    教师仅能查看自己班级的学生，管理员可查看全部。
    """
    user = get_current_user(request)
    current_user = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    # 单个学生查询
    if username:
        # 校验权限：管理员可查全部，教师只能查自己班级的学生
        if role == 1:
            students = get_students_in_scope(current_user)
            if not any(s.get("username") == username for s in students):
                raise HTTPException(status_code=403, detail="无权查看该学生的数据")
        return {"summary": {"total_students": 1}, "students": [_calc_student_progress(username)]}

    # 按班级查询
    if not grade or not class_name:
        raise HTTPException(status_code=400, detail="请指定年级和班级，或指定学生用户名")

    # P4: FK 口径解析年级/班级, 复用 get_students_in_scope（教师∩任教范围, 管理员全班）,
    # 替代旧的 u.grade/u.class 文本匹配（班级显示名变体不再漏学生）
    from backend.permission_service import get_grade_by_name, _resolve_class_id_flexible
    _gi = get_grade_by_name(grade)
    _gid = _gi["id"] if _gi else None
    _cid = _resolve_class_id_flexible(_gid, class_name) if _gid else None
    students = get_students_in_scope(current_user, grade_id=_gid, class_id=_cid)

    # P2: 整班进度短 TTL 缓存
    _cache_key = f"{current_user}|{role}|{grade}|{class_name}"
    _now = time.time()
    _hit = _PROGRESS_CACHE.get(_cache_key)
    if _hit and _now - _hit[0] < _PROGRESS_CACHE_TTL:
        return _hit[1]

    # P2: course_total 按年级算一次 + 四类完成数批量 GROUP BY（替代逐人查询）
    _grade_totals: dict = {}
    for _g in {str(s.get("grade") or "") for s in students}:
        _grade_totals[_g] = _course_total_for_grade(_g)
    _unames = [s["username"] for s in students]
    _exam_done = _group_counts(qdb_query,
        "SELECT student_username AS aid, COUNT(*) AS cnt FROM exam_attempts "
        "WHERE status IN ('submitted','graded') AND student_username IN ({ph}) GROUP BY student_username", _unames)
    _practice_done = _group_counts(qdb_query,
        "SELECT student_username AS aid, COUNT(*) AS cnt FROM practice_attempts "
        "WHERE status='submitted' AND student_username IN ({ph}) GROUP BY student_username", _unames)
    _code_done = _group_counts(qdb_query,
        "SELECT student_username AS aid, COUNT(DISTINCT problem_id) AS cnt FROM code_submissions "
        "WHERE status='accepted' AND is_best=1 AND student_username IN ({ph}) GROUP BY student_username", _unames)
    _course_done = _group_counts(qdb_query,
        "SELECT student_username AS aid, COUNT(DISTINCT kp_id) AS cnt FROM ai_practice_results "
        "WHERE student_username IN ({ph}) GROUP BY student_username", _unames)

    results = []
    for s in students:
        _pre = {
            "course_total": _grade_totals.get(str(s.get("grade") or ""), 0),
            "exam_done": _exam_done.get(s["username"], 0),
            "practice_done": _practice_done.get(s["username"], 0),
            "code_done": _code_done.get(s["username"], 0),
            "course_done": _course_done.get(s["username"], 0),
        }
        st = _calc_student_progress(s["username"], precomputed=_pre)
        st["student_name"] = s.get("name") or s["username"]
        results.append(st)

    # 班级汇总
    if results:
        total = len(results)
        avg_course_progress = sum(r["course_progress"] for r in results) / total
        avg_completion = sum(r["completion_rate"] for r in results) / total
        avg_accuracy = sum(r["accuracy_rate"] for r in results) / total
        avg_streak = sum(r["streak_days"] for r in results) / total
        summary = {
            "total_students": total,
            "avg_course_progress": round(avg_course_progress),
            "avg_completion_rate": round(avg_completion, 1),
            "avg_accuracy_rate": round(avg_accuracy, 1),
            "avg_streak_days": round(avg_streak, 1),
        }
    else:
        summary = {"total_students": 0}

    _result = {"summary": summary, "students": results}
    _PROGRESS_CACHE[_cache_key] = (_now, _result)
    if len(_PROGRESS_CACHE) > 64:
        for k in [k for k, (ts, _) in _PROGRESS_CACHE.items() if _now - ts >= _PROGRESS_CACHE_TTL]:
            _PROGRESS_CACHE.pop(k, None)
    return _result
