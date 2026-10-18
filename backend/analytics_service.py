# -*- coding: utf-8 -*-
"""班级学情 / 课堂活动统一数据快照（2026-10）。

背景：
  - 课堂总结原先只按创建教师取最近 5 场测验/投票/讨论，学生提问甚至不带
    任何班级条件，导致"这个班、本节课"的总结混入其他班级、其他月份的数据。
  - 学情总览的考试/作业统计没有按班级收敛，且 `teacher` 参数可被教师用于
    读取其他教师的汇总数据。

本模块把"班级范围 + 时间窗 + 数据口径"收敛成一份实现，页面、AI Prompt、
Word 导出共用，避免三个入口算出三套数字。
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from fastapi import HTTPException

from backend.database import execute_query, execute_query_dict
from backend.question_db import execute_query as q_execute_query
from backend.permission_service import (
    _resolve_class_id_flexible,
    can_access_class,
    get_grade_by_name,
    get_teacher_classes,
)
from backend.quiz_stats import (
    answer_index_map,
    build_question_stats,
    centesimal,
    quiz_graded,
    quiz_questions,
    quiz_total,
)


def _txt(v: Any) -> str:
    return str(v if v is not None else "").strip()


def _split_multi(v: Any) -> list[str]:
    """把 '高一1班,高一2班' / '1,2' 统一拆成列表。"""
    raw = _txt(v).replace("，", ",").replace("、", ",")
    return [x.strip() for x in raw.split(",") if x.strip()]


def _class_num(v: Any) -> str:
    nums = re.findall(r"\d+", _txt(v))
    return nums[0] if nums else _txt(v)


def class_name_variants(grade: str, cls: str) -> list[str]:
    """各表里班级名的历史写法：'高一1班' / '1班' / '1'。"""
    out: list[str] = []
    v = _txt(cls)
    if not v:
        return out
    out.append(v)
    if grade and v.startswith(grade):
        out.append(v[len(grade):])
    num = _class_num(v)
    if num:
        out.extend([num, f"{num}班", f"{grade}{num}班"])
    seen, res = set(), []
    for x in out:
        if x and x not in seen:
            seen.add(x)
            res.append(x)
    return res


def class_display_name(grade: str, cls: str) -> str:
    """避免把 '高一' + '高一1班' 拼成 '高一高一1班'。"""
    grade, cls = _txt(grade), _txt(cls)
    if cls.endswith("班"):
        return cls if cls.startswith(grade) else f"{grade}{cls}"
    return f"{grade}{cls}班"


def parse_window(start: str = "", end: str = "") -> dict[str, str]:
    """解析统计时间窗；缺省为今天 00:00 至当前时刻。

    created_at 统一存 'YYYY-MM-DD HH:MM:SS'，字符串比较即时间比较。
    """
    now = datetime.now()

    def _parse(value: str, is_end: bool = False) -> datetime | None:
        s = _txt(value).replace("T", " ")
        if not s:
            return None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(s[:19] if fmt != "%Y-%m-%d" else s[:10], fmt)
            except ValueError:
                continue
            if fmt == "%Y-%m-%d" and is_end:
                dt = dt.replace(hour=23, minute=59, second=59)
            return dt
        raise HTTPException(status_code=400, detail="时间格式错误，应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS")

    start_dt = _parse(start) or now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_dt = _parse(end, is_end=True) or now
    if end_dt < start_dt:
        raise HTTPException(status_code=400, detail="结束时间不能早于开始时间")
    return {
        "start": start_dt.strftime("%Y-%m-%d %H:%M:%S"),
        "end": end_dt.strftime("%Y-%m-%d %H:%M:%S"),
        "start_date": start_dt.strftime("%Y-%m-%d"),
        "end_date": end_dt.strftime("%Y-%m-%d"),
        "label": f"{start_dt.strftime('%Y-%m-%d %H:%M')} ~ {end_dt.strftime('%Y-%m-%d %H:%M')}",
    }


def resolve_class_scope(grade: str, cls: str) -> dict[str, Any]:
    """把年级/班级解析为 FK、文本候选集与班级学生名单。"""
    grade, cls = _txt(grade), _txt(cls)
    if not grade or not cls:
        raise HTTPException(status_code=400, detail="请选择年级和班级")
    grade_info = get_grade_by_name(grade)
    grade_id = int(grade_info["id"]) if grade_info else None
    class_id = _resolve_class_id_flexible(grade_id, cls) if grade_id else None
    variants = class_name_variants(grade, cls)
    num = _class_num(cls)

    def _students(where: str, params: list[Any]) -> list[dict[str, Any]]:
        return execute_query_dict(
            "SELECT username, name, grade, class, grade_id, class_id FROM users "
            f"WHERE role=2 AND {where}",
            tuple(params),
        )

    rows: list[dict[str, Any]] = []
    if grade_id and class_id:
        rows = _students("grade_id=? AND class_id=?", [grade_id, class_id])
    if not rows and grade_id:
        ph = ",".join("?" for _ in variants)
        rows = _students(f"grade_id=? AND class IN ({ph})", [grade_id, *variants])
    if not rows:
        ph = ",".join("?" for _ in variants)
        rows = _students(f"grade=? AND class IN ({ph})", [grade, *variants])

    return {
        "grade": grade,
        "cls": cls,
        "class_num": num,
        "grade_id": grade_id,
        "class_id": class_id,
        "variants": variants,
        "display_name": class_display_name(grade, cls),
        "students": {str(r["username"]): str(r.get("name") or r["username"]) for r in rows},
        "total_students": len(rows),
    }


def assert_class_access(user: dict[str, Any], scope: dict[str, Any]) -> None:
    """教师只能操作任教班级；管理员不受限。"""
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看班级数据")
    if role == 0:
        return
    username = _txt(user.get("username"))
    gid, cid = scope.get("grade_id"), scope.get("class_id")
    if gid and cid and can_access_class(username, int(gid), int(cid)):
        return
    if gid:
        # 年级全包（teacher_assignments.class_id IS NULL）
        rows = execute_query(
            "SELECT 1 FROM teacher_assignments WHERE teacher_username=? "
            "AND grade_id=? AND class_id IS NULL",
            (username, gid),
        )
        if rows:
            return
        allowed = get_teacher_classes(username, int(gid))
        allowed_nums = {_class_num(c.get("name") or c.get("display_name") or "") for c in allowed}
        if scope.get("class_num") in allowed_nums:
            return
    raise HTTPException(status_code=403, detail="无权查看该班级的数据")


def resolve_query_teacher(user: dict[str, Any], explicit: str = "") -> str:
    """课堂活动查询的创建者口径。

    管理员未指定教师（或指定的是自己）时返回空串，表示"本班全部教师的活动"；
    教师固定返回自己。空串不能出现在权限判断里，只用于 SQL 是否加创建者条件。
    """
    explicit = _txt(explicit)
    role = user.get("role", 2)
    if role == 0 and (not explicit or explicit == _txt(user.get("username"))):
        return ""
    return explicit or _txt(user.get("username"))


def _target_state(row: dict[str, Any], scope: dict[str, Any],
                  grade_key: str = "target_grade", class_key: str = "target_class") -> bool | None:
    """True=明确命中；False=明确不命中；None=旧数据未填目标，需按参与者回退。"""
    scope_type = _txt(row.get("target_scope")).lower()
    if scope_type in ("all", "school"):
        return True
    grades = _split_multi(row.get(grade_key))
    classes = _split_multi(row.get(class_key))
    if not grades and not classes:
        return None
    if grades and scope["grade"] not in grades:
        return False
    if classes:
        wanted = {scope["class_num"], scope["cls"], scope["display_name"]}
        if not wanted.intersection(set(classes)):
            return False
    return True


def _teacher_filter(user: dict[str, Any], query_teacher: str) -> str:
    """管理员未指定教师时不加创建者过滤；教师固定为自己。"""
    if user.get("role", 2) == 1:
        return query_teacher
    return query_teacher if query_teacher and query_teacher != user.get("username") else ""


def build_class_snapshot(
    user: dict[str, Any],
    query_teacher: str,
    grade: str,
    cls: str,
    start: str = "",
    end: str = "",
) -> dict[str, Any]:
    """班级学情快照：积分、点名、考试、任务，全部按班级收敛。"""
    scope = resolve_class_scope(grade, cls)
    assert_class_access(user, scope)
    window = parse_window(start, end)
    variants = scope["variants"] or [scope["cls"]]
    ph = ",".join("?" for _ in variants)
    teacher_filter = _teacher_filter(user, query_teacher)

    teacher_sql = "AND teacher_username=?" if teacher_filter else ""
    score_params: list[Any] = [grade, *variants, *([teacher_filter] if teacher_filter else [])]
    score_rows = execute_query_dict(
        f"""SELECT student_name, COALESCE(SUM(score),0) AS total
            FROM scores
            WHERE grade=? AND class_name IN ({ph}) {teacher_sql}
            GROUP BY student_name""",
        tuple(score_params),
    )
    score_totals = [int(r["total"] or 0) for r in score_rows]
    score_count = len(score_totals)
    score_total = sum(score_totals)
    score_avg = round(score_total / score_count, 1) if score_count else 0.0
    score_max = max(score_totals) if score_totals else 0
    score_min = min(score_totals) if score_totals else 0
    rc_params: list[Any] = [grade, *variants, *([teacher_filter] if teacher_filter else [])]
    rc_row = execute_query(
        f"""SELECT SUM(CASE WHEN result IN ('correct','incorrect') THEN 1 ELSE 0 END),
                   SUM(CASE WHEN result='correct' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN result='incorrect' THEN 1 ELSE 0 END)
            FROM rollcall_history
            WHERE grade=? AND class_name IN ({ph}) {teacher_sql}""",
        tuple(rc_params),
    )[0]

    students = scope["students"]
    student_names = list(students.keys())
    attempts_by_exam: dict[int, list[dict[str, Any]]] = {}
    if student_names:
        sph = ",".join("?" for _ in student_names)
        rows = q_execute_query(
            f"""SELECT exam_id, student_username, score, total_score, teacher_score
                FROM exam_attempts
                WHERE student_username IN ({sph}) AND status IN ('submitted', 'graded')""",
            tuple(student_names),
        )
        for r in rows:
            attempts_by_exam.setdefault(int(r["exam_id"]), []).append(dict(r))

    exams_sql = (
        "SELECT id, title, subject, total_score, pass_score, creator_username, "
        "target_scope, target_grade, target_class, created_at "
        "FROM exams WHERE status IN ('published', 'ended')"
    )
    exam_rows = q_execute_query(
        exams_sql + (" AND creator_username=?" if teacher_filter else "") +
        " ORDER BY created_at DESC LIMIT 50",
        (teacher_filter,) if teacher_filter else (),
    )
    exams: list[dict[str, Any]] = []
    for e in exam_rows:
        att = attempts_by_exam.get(int(e["id"]), [])
        matched = _target_state(e, scope)
        if matched is False:
            continue
        if matched is None and not att:
            continue
        scores = []
        for a in att:
            raw = a.get("teacher_score")
            score = float(raw) if raw is not None and float(raw) >= 0 else float(a.get("score") or 0)
            scores.append(score)
        total_score = float(e.get("total_score") or 0)
        pass_score = float(e.get("pass_score") or 0)
        exams.append({
            "id": e["id"],
            "title": e.get("title") or "",
            "subject": e.get("subject") or "",
            "attempts": len(att),
            "avg_score": round(sum(scores) / len(scores), 1) if scores else 0,
            "pass_count": sum(1 for s in scores if s >= pass_score),
            "pass_rate": round(sum(1 for s in scores if s >= pass_score) / len(scores) * 100, 1) if scores else 0,
            "total_score": total_score,
            "created_at": e.get("created_at") or "",
        })
        if len(exams) >= 5:
            break

    task_rows = execute_query_dict(
        "SELECT id, name, target_scope, target_grade, target_class FROM tasks "
        "WHERE status='active'" + (" AND creator_username=?" if teacher_filter else ""),
        (teacher_filter,) if teacher_filter else (),
    )
    task_ids = [str(r["id"]) for r in task_rows]
    submissions_by_task: dict[str, set[str]] = {}
    if task_ids and student_names:
        tph = ",".join("?" for _ in task_ids)
        sph = ",".join("?" for _ in student_names)
        rows = execute_query_dict(
            f"SELECT task_id, student_username FROM task_submissions "
            f"WHERE task_id IN ({tph}) AND student_username IN ({sph})",
            tuple(task_ids) + tuple(student_names),
        )
        for r in rows:
            submissions_by_task.setdefault(str(r["task_id"]), set()).add(str(r["student_username"]))
    active_tasks = 0
    submitted_students: set[str] = set()
    for t in task_rows:
        submitted = submissions_by_task.get(str(t["id"]), set())
        matched = _target_state(t, scope)
        if matched is False:
            continue
        if matched is None and not submitted:
            continue
        active_tasks += 1
        submitted_students |= submitted

    total_students = scope["total_students"]
    rc_total = int(rc_row[0] or 0)
    rc_correct = int(rc_row[1] or 0)
    data = {
        "grade": grade,
        "class": scope["class_num"],
        "class_display": scope["display_name"],
        "total_students": total_students,
        "score_count": score_count,
        "score_total": score_total,
        "score_avg": score_avg,
        "score_max": score_max,
        "score_min": score_min,
        "rollcall_total": rc_total,
        "rollcall_correct": rc_correct,
        "rollcall_wrong": int(rc_row[2] or 0),
        "rollcall_rate": round(rc_correct / max(rc_total, 1) * 100, 1),
        "exam_count": len(exams),
        "exams": exams,
        "active_tasks": active_tasks,
        "submitted_students": len(submitted_students),
        "task_rate": round(len(submitted_students) / max(total_students, 1) * 100, 1),
    }
    exam_lines = "\n".join(
        f"- 《{e['title']}》({e['subject']}): 本班参考{e['attempts']}人, "
        f"平均分{e['avg_score']}/{e['total_score']}, 及格率{e['pass_rate']}%"
        for e in exams
    ) or "暂无本班考试数据"
    return {
        "scope": scope,
        "window": window,
        "data": data,
        "exam_lines": exam_lines,
        "sources": [
            {"type": "exam", "id": e["id"], "title": e["title"], "created_at": e["created_at"],
             "participants": e["attempts"]}
            for e in exams
        ],
    }


def build_class_activity_snapshot(
    user: dict[str, Any],
    query_teacher: str,
    grade: str,
    cls: str,
    start: str = "",
    end: str = "",
    subject: str = "",
) -> dict[str, Any]:
    """课堂活动快照：测验、投票、提问、讨论，全部按班级与时间窗收敛。"""
    scope = resolve_class_scope(grade, cls)
    assert_class_access(user, scope)
    window = parse_window(start, end)
    students = scope["students"]
    student_set = set(students)
    subject = _txt(subject)
    time_sql = "created_at>=? AND created_at<=?"

    def _subject_sql(alias: str = "") -> tuple[str, list[Any]]:
        if not subject:
            return "", []
        col = f"{alias}.subject" if alias else "subject"
        return f" AND COALESCE({col},'')=?", [subject]

    # ── 测验 ──
    s_sql, s_params = _subject_sql()
    creator_sql = " AND creator_username=?" if query_teacher else ""
    quiz_rows = execute_query_dict(
        "SELECT id, title, subject, questions, status, created_at, target_scope, "
        "target_grade, target_class FROM interaction_quizzes "
        f"WHERE status IN ('active','ended') AND {time_sql}{creator_sql}{s_sql} "
        "ORDER BY created_at DESC LIMIT 50",
        (window["start"], window["end"], *([query_teacher] if query_teacher else []), *s_params),
    )
    quiz_ids = [int(r["id"]) for r in quiz_rows]
    answers_by_quiz: dict[int, list[Any]] = {}
    if quiz_ids:
        qph = ",".join("?" for _ in quiz_ids)
        rows = execute_query_dict(
            f"SELECT quiz_id, student_username, answers, score, graded "
            f"FROM interaction_quiz_answers WHERE quiz_id IN ({qph})",
            tuple(quiz_ids),
        )
        for r in rows:
            answers_by_quiz.setdefault(int(r["quiz_id"]), []).append(r)
    quizzes: list[dict[str, Any]] = []
    quiz_participants: set[str] = set()
    quiz_sources: list[dict[str, Any]] = []
    for q in quiz_rows:
        rows = [a for a in answers_by_quiz.get(int(q["id"]), []) if str(a["student_username"]) in student_set]
        matched = _target_state(dict(q), scope)
        if matched is False:
            continue
        if matched is None and not rows:
            continue
        questions = quiz_questions(q)
        total = quiz_total(questions)
        scores = [centesimal(a["score"], total) for a in rows]
        scores = [s for s in scores if s is not None]
        parsed = [(a, answer_index_map(a["answers"]), quiz_graded(a["graded"])) for a in rows]
        q_stats = build_question_stats(questions, parsed) if questions and parsed else []
        weak = sorted(
            [x for x in q_stats if x.get("total_count", 0) > 0],
            key=lambda x: x.get("correct_rate", 0),
        )[:3]
        participants = {str(a["student_username"]) for a in rows}
        quiz_participants |= participants
        quizzes.append({
            "id": q["id"],
            "title": q.get("title") or "",
            "subject": q.get("subject") or "",
            "created_at": q.get("created_at") or "",
            "question_count": len(questions),
            "participants": len(participants),
            "avg_score": round(sum(scores) / len(scores), 1) if scores else 0,
            "pass_rate": round(sum(1 for s in scores if s >= 60) / len(scores) * 100, 1) if scores else 0,
            "weak_questions": [
                {"index": x.get("index", 0) + 1,
                 "question": str(x.get("question") or "")[:60],
                 "correct_rate": x.get("correct_rate", 0)}
                for x in weak
            ],
        })
        quiz_sources.append({"type": "quiz", "id": q["id"], "title": q.get("title") or "",
                             "created_at": q.get("created_at") or "", "participants": len(participants)})

    # ── 投票 ──
    p_sql, p_params = _subject_sql()
    poll_rows = execute_query_dict(
        "SELECT id, question, options, subject, status, created_at, target_scope, "
        "target_grade, target_class FROM interaction_polls "
        f"WHERE COALESCE(status,'active')!='draft' AND {time_sql}{creator_sql}{p_sql} "
        "ORDER BY created_at DESC LIMIT 50",
        (window["start"], window["end"], *([query_teacher] if query_teacher else []), *p_params),
    )
    poll_ids = [int(r["id"]) for r in poll_rows]
    votes_by_poll: dict[int, list[Any]] = {}
    if poll_ids:
        pph = ",".join("?" for _ in poll_ids)
        rows = execute_query_dict(
            f"SELECT poll_id, student_username, selected_option FROM interaction_poll_votes "
            f"WHERE poll_id IN ({pph})",
            tuple(poll_ids),
        )
        for r in rows:
            votes_by_poll.setdefault(int(r["poll_id"]), []).append(r)
    polls: list[dict[str, Any]] = []
    poll_participants: set[str] = set()
    poll_sources: list[dict[str, Any]] = []
    for p in poll_rows:
        votes = [v for v in votes_by_poll.get(int(p["id"]), []) if str(v["student_username"]) in student_set]
        matched = _target_state(dict(p), scope)
        if matched is False:
            continue
        if matched is None and not votes:
            continue
        try:
            options = json.loads(p["options"]) if isinstance(p["options"], str) else (p["options"] or [])
        except (json.JSONDecodeError, TypeError):
            options = []
        dist: dict[int, int] = {}
        for v in votes:
            idx = int(v["selected_option"])
            dist[idx] = dist.get(idx, 0) + 1
        participants = {str(v["student_username"]) for v in votes}
        poll_participants |= participants
        polls.append({
            "id": p["id"],
            "question": p.get("question") or "",
            "subject": p.get("subject") or "",
            "created_at": p.get("created_at") or "",
            "options": options,
            "participants": len(participants),
            "distribution": [
                {"option": str(options[i]) if i < len(options) else str(i + 1),
                 "count": c}
                for i, c in sorted(dist.items())
            ],
        })
        poll_sources.append({"type": "poll", "id": p["id"], "title": p.get("question") or "",
                             "created_at": p.get("created_at") or "", "participants": len(participants)})

    # ── 学生提问（提问时快照了 grade_id/class_id）──
    q_sql, q_params = _subject_sql()
    question_rows = execute_query_dict(
        "SELECT id, content, status, subject, knowledge_point, created_at, grade_id, class_id, student_username "
        "FROM interaction_questions "
        f"WHERE {time_sql}{q_sql} ORDER BY created_at DESC LIMIT 200",
        (window["start"], window["end"], *q_params),
    )
    questions: list[dict[str, Any]] = []
    for q in question_rows:
        gid_ok = scope["grade_id"] and q.get("grade_id") == scope["grade_id"]
        cid_ok = scope["class_id"] and q.get("class_id") == scope["class_id"]
        if not (gid_ok and cid_ok) and str(q.get("student_username")) not in student_set:
            continue
        questions.append({
            "id": q["id"],
            "content": str(q.get("content") or ""),
            "status": q.get("status") or "",
            "subject": q.get("subject") or "",
            "knowledge_point": q.get("knowledge_point") or "",
            "created_at": q.get("created_at") or "",
            "student_username": str(q.get("student_username") or ""),
        })
    question_total = len(questions)
    question_pending = sum(1 for q in questions if q["status"] != "answered")
    questions_for_prompt = questions[:20]
    question_sources = [
        {"type": "question", "id": q["id"], "title": q["content"][:50],
         "created_at": q["created_at"], "participants": 1}
        for q in questions_for_prompt
    ]

    # ── 分组讨论 ──
    d_sql, d_params = _subject_sql()
    discussion_rows = execute_query_dict(
        "SELECT id, title, subject, status, grade, classes, created_at "
        f"FROM discussions WHERE 1=1{creator_sql} AND {time_sql}{d_sql} "
        "ORDER BY created_at DESC LIMIT 50",
        (*([query_teacher] if query_teacher else []), window["start"], window["end"], *d_params),
    )
    discussion_ids = [int(r["id"]) for r in discussion_rows]
    members_by_disc: dict[int, set[str]] = {}
    messages_by_disc: dict[int, int] = {}
    if discussion_ids:
        dph = ",".join("?" for _ in discussion_ids)
        rows = execute_query_dict(
            "SELECT g.discussion_id, m.username FROM discussion_groups g "
            "JOIN discussion_members m ON m.group_id = g.id "
            f"WHERE g.discussion_id IN ({dph})",
            tuple(discussion_ids),
        )
        for r in rows:
            members_by_disc.setdefault(int(r["discussion_id"]), set()).add(str(r["username"]))
        rows = execute_query_dict(
            "SELECT g.discussion_id, COUNT(*) AS cnt FROM discussion_groups g "
            "JOIN discussion_messages m ON m.group_id = g.id "
            f"WHERE g.discussion_id IN ({dph}) GROUP BY g.discussion_id",
            tuple(discussion_ids),
        )
        for r in rows:
            messages_by_disc[int(r["discussion_id"])] = int(r["cnt"] or 0)
    discussions: list[dict[str, Any]] = []
    discussion_participants: set[str] = set()
    discussion_sources: list[dict[str, Any]] = []
    for d in discussion_rows:
        members = members_by_disc.get(int(d["id"]), set()) & student_set
        classes = set(_split_multi(d.get("classes")))
        explicit = bool(_txt(d.get("grade")) or classes)
        matched: bool | None
        if explicit:
            matched = (
                (not _txt(d.get("grade")) or _txt(d.get("grade")) == scope["grade"])
                and (not classes or bool(classes & {scope["class_num"], scope["cls"], scope["display_name"]}))
            )
        else:
            matched = None
        if matched is False:
            continue
        if matched is None and not members:
            continue
        discussion_participants |= members
        discussions.append({
            "id": d["id"],
            "title": d.get("title") or "",
            "subject": d.get("subject") or "",
            "status": d.get("status") or "",
            "created_at": d.get("created_at") or "",
            "members": len(members),
            "messages": messages_by_disc.get(int(d["id"]), 0),
        })
        discussion_sources.append({"type": "discussion", "id": d["id"], "title": d.get("title") or "",
                                   "created_at": d.get("created_at") or "", "participants": len(members)})

    asked_students = {
        q["student_username"] for q in questions
        if q["student_username"] and q["student_username"] in student_set
    }
    all_participants = quiz_participants | poll_participants | asked_students | discussion_participants

    total_students = scope["total_students"]
    data = {
        "quiz_count": len(quizzes),
        "poll_count": len(polls),
        "question_count": question_total,
        "discussion_count": len(discussions),
        "student_count": len(all_participants),
        "class_student_count": total_students,
        "participation_rate": round(len(all_participants) / max(total_students, 1) * 100, 1),
        "avg_quiz_score": round(
            sum(q["avg_score"] for q in quizzes) / len([q for q in quizzes if q["participants"] > 0]), 1
        ) if any(q["participants"] > 0 for q in quizzes) else 0,
        "pending_question_count": question_pending,
    }

    quiz_lines_list = []
    for q in quizzes:
        line = (
            f"- 《{q['title']}》: {q['question_count']}题, 本班{q['participants']}人参与, "
            f"平均{q['avg_score']}分, 及格率{q['pass_rate']}%"
        )
        if q["weak_questions"]:
            line += "; 薄弱题: " + ", ".join(
                f"第{w['index']}题{w['correct_rate']}%" for w in q["weak_questions"]
            )
        quiz_lines_list.append(line)
    quiz_lines = "\n".join(quiz_lines_list) or "暂无本班随堂测验数据"
    poll_lines = "\n".join(
        f"- 「{p['question']}」: 本班{p['participants']}人投票, 分布="
        + ", ".join(f"{x['option']}:{x['count']}票" for x in p["distribution"])
        for p in polls
    ) or "暂无本班投票数据"
    question_lines = "\n".join(
        f"- {q['content'][:60]} ({'已回答' if q['status'] == 'answered' else '待回答'}"
        + (f", 知识点:{q['knowledge_point']}" if q["knowledge_point"] else "") + ")"
        for q in questions_for_prompt
    ) or "暂无本班学生提问"
    discussion_lines = "\n".join(
        f"- 《{d['title']}》: 本班{d['members']}人参与, {d['messages']}条消息 ({d['status']})"
        for d in discussions
    ) or "暂无本班分组讨论数据"
    return {
        "scope": scope,
        "window": window,
        "data": data,
        "quizzes": quizzes,
        "polls": polls,
        "questions": questions,
        "discussions": discussions,
        "sources": quiz_sources + poll_sources + question_sources + discussion_sources,
        "quiz_lines": quiz_lines,
        "poll_lines": poll_lines,
        "question_lines": question_lines,
        "discussion_lines": discussion_lines,
    }
