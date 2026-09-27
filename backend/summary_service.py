# -*- coding: utf-8 -*-
"""跨活动学生成绩汇总采集服务

把考试/随堂测验/在线任务/智能练习/代码练习/课程练习/知识抢答/知识闯关/
快速投票/分组讨论/课堂积分等分散数据归一化成统一的"学生×活动"明细行,
再按学生、按活动、按班级三种口径聚合, 供 export_router 的汇总导出端点
(JSON 预览 / Excel 多 Sheet / CSV) 使用。

权限口径与现有导出功能保持一致:
  - 管理员 (role=0): 全部活动、全部学生; 可用 teacher 参数按某教师的
    创建者口径导出 (与 export_router E1 规则同口径);
  - 教师 (role=1): 仅自己创建的活动 × 仅自己任教年级/班级内的学生;
    指定学生时逐一校验在任教范围内, 越权 403;
  - 学生: 本服务不对学生开放 (路由层 403)。

分数口径 (方案确认稿):
  - 考试/智能练习: teacher_score >= 0 (教师已复核) 时优先, 否则用原始/AI 分;
  - 在线任务: task_grades.ai_score 为准, 已提交无分记「待评分」;
  - 代码练习: 取学生最高分一条;
  - 知识闯关: 口径为答题正确率 (correct_count / total_questions), 积分不计入均分;
  - 计分类统一折算百分制得分率 (rate) 后再平均, 避免不同满分直接平均;
  - 投票/讨论为参与类, 只统计参与次数, 不参与得分率平均;
  - 课堂积分单独成列, 不参与得分率平均。
"""
from __future__ import annotations

import re
from typing import Any, Optional

from fastapi import HTTPException

from backend.database import execute_query_dict
from backend.question_db import execute_query as q_execute_query
from backend.logger import logger
from backend.permission_service import (
    get_students_in_scope,
    get_grade_by_name,
    get_teacher_assignments,
    _resolve_class_id_flexible,
)

# ── 活动类型注册表 ─────────────────────────────────────────────
# kind: score=计分类(参与均分/及格率) / participation=参与类(只统计次数)
#       points=积分类(单独列, 不参与均分)
SUMMARY_TYPES: dict[str, dict[str, str]] = {
    "exam":        {"label": "考试",     "kind": "score"},
    "quiz":        {"label": "随堂测验", "kind": "score"},
    "task":        {"label": "在线任务", "kind": "score"},
    "practice":    {"label": "智能练习", "kind": "score"},
    "code":        {"label": "代码练习", "kind": "score"},
    "course":      {"label": "课程练习", "kind": "score"},
    "quick_quiz":  {"label": "知识抢答", "kind": "score"},
    "quest":       {"label": "知识闯关", "kind": "score"},
    "poll":        {"label": "快速投票", "kind": "participation"},
    "discussion":  {"label": "分组讨论", "kind": "participation"},
    "score_point": {"label": "课堂积分", "kind": "points"},
}

_PASS_RATE_DEFAULT = 60.0  # 无及格线数据时按得分率 60% 记及格
_IN_CHUNK = 400            # SQLite IN 参数分块大小


def _chunks(items: list, size: int = _IN_CHUNK):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _txt(v: Any) -> str:
    """年级/班级等文本字段统一转字符串 (users.class 可能存了数字)"""
    return str(v if v is not None else "").strip()


def _date_of(ts: Any) -> str:
    """从 'YYYY-MM-DD[ T]HH:MM:SS' 提取日期部分, 异常值返回 ''"""
    s = str(ts or "").strip()
    return s[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", s) else ""


def _round1(v: Any) -> Optional[float]:
    try:
        return round(float(v), 1)
    except (TypeError, ValueError):
        return None


def _rate(score: Any, total: Any) -> Optional[float]:
    """百分制得分率; 无法计算时返回 None"""
    try:
        t = float(total)
        s = float(score)
    except (TypeError, ValueError):
        return None
    if t <= 0:
        return None
    return _round1(max(0.0, min(100.0, s / t * 100.0)))


class SummaryContext:
    """一次汇总导出的解析结果 (角色 / 学生群体 / 时间窗)"""

    def __init__(
        self,
        user: dict[str, Any],
        grade: str = "",
        cls: str = "",
        usernames: Optional[list[str]] = None,
        types: Optional[list[str]] = None,
        start: str = "",
        end: str = "",
        teacher: str = "",
    ):
        role = user.get("role", 2)
        if role == 2:
            raise HTTPException(status_code=403, detail="权限不足：汇总导出仅限教师与管理员")
        self.is_admin = role == 0
        self.username = str(user.get("username", "") or "")
        # 管理员可通过 teacher 参数按指定教师的创建者口径导出; 教师固定为自己
        self.eff_teacher = (teacher or "").strip() if self.is_admin else self.username

        # ── 活动类型 ──
        req_types = [t for t in (types or []) if t in SUMMARY_TYPES]
        self.types = req_types or list(SUMMARY_TYPES.keys())

        # ── 时间窗 (按日, 含首含尾; 空串=不限) ──
        self.start = _date_of(start)
        self.end = _date_of(end)
        if start and not self.start:
            raise HTTPException(status_code=400, detail=f"start 日期格式不正确: {start}")
        if end and not self.end:
            raise HTTPException(status_code=400, detail=f"end 日期格式不正确: {end}")

        # ── 年级/班级解析 ──
        grade_id: Optional[int] = None
        class_id: Optional[int] = None
        gname = (grade or "").strip()
        cname = (cls or "").strip()
        if gname:
            ginfo = get_grade_by_name(gname)
            if not ginfo:
                raise HTTPException(status_code=400, detail=f"年级不存在: {gname}")
            grade_id = ginfo["id"]
        self.grade_name = gname
        if cname:
            if grade_id is None:
                raise HTTPException(status_code=400, detail="筛选班级时必须同时指定年级")
            class_id = _resolve_class_id_flexible(grade_id, cname)
            if class_id is None:
                raise HTTPException(status_code=400, detail=f"班级不存在: {gname} {cname}")
        self.class_name = cname

        # ── 学生群体 (权限范围 ∩ 筛选条件) ──
        pop = get_students_in_scope(self.username, grade_id=grade_id, class_id=class_id)
        picked = [u.strip() for u in (usernames or []) if u.strip()]
        if picked:
            pop_map = {s["username"]: s for s in pop}
            missing = [u for u in picked if u not in pop_map]
            if missing and not self.is_admin:
                raise HTTPException(
                    status_code=403,
                    detail="以下学生不在您的任教年级/班级范围内: " + ", ".join(missing[:10]),
                )
            if missing:  # 管理员指定的不存在/非在籍学生, 直接剔除
                pop = [pop_map[u] for u in picked if u in pop_map]
            else:
                pop = [pop_map[u] for u in picked]
        if not pop:
            raise HTTPException(status_code=404, detail="权限范围内没有符合条件的学生")

        self.population: list[dict[str, Any]] = pop
        self.student_map: dict[str, dict[str, Any]] = {s["username"]: s for s in pop}

        # 创建者显示名缓存
        self._creator_names: dict[str, str] = {}
        # 教师任教范围学生缓存 (用于按活动目标范围估算应参与人数)
        self._scope_cache: dict[str, set[str]] = {}

    # ── 工具 ──

    def in_window(self, ts: Any) -> bool:
        if not self.start and not self.end:
            return True
        d = _date_of(ts)
        if not d:
            return True  # 无时间戳的记录不因时间筛选丢失
        if self.start and d < self.start:
            return False
        if self.end and d > self.end:
            return False
        return True

    def creator_name(self, username: str) -> str:
        u = username or ""
        if not u:
            return ""
        if u not in self._creator_names:
            rows = execute_query_dict(
                "SELECT COALESCE(NULLIF(name,''), username) AS display_name FROM users WHERE username=?",
                (u,),
            )
            self._creator_names[u] = rows[0]["display_name"] if rows else u
        return self._creator_names[u]

    def teacher_scope_students(self, teacher_username: str) -> set[str]:
        """某教师的任教范围学生集合 (整个年级按其 assignments 展开), 带缓存

        管理员创建的 teacher_classes 范围活动面向全体学生
        (与 is_student_in_teacher_scope 对 admin 恒为 True 的口径一致)。
        """
        from backend.auth import is_admin
        u = teacher_username or ""
        if not u or is_admin(u):
            return set(self.student_map)
        if u not in self._scope_cache:
            result: set[str] = set()
            for a in get_teacher_assignments(u):
                gid = a["grade_id"]
                cid = a.get("class_id")
                if cid is None:
                    rows = execute_query_dict(
                        "SELECT username FROM users WHERE role=2 AND IFNULL(status,'active')='active' AND grade_id=?",
                        (gid,),
                    )
                else:
                    rows = execute_query_dict(
                        "SELECT username FROM users WHERE role=2 AND IFNULL(status,'active')='active' AND grade_id=? AND class_id=?",
                        (gid, cid),
                    )
                result.update(r["username"] for r in rows)
            self._scope_cache[u] = result
        return self._scope_cache[u]


# ── 活动清单采集 ───────────────────────────────────────────────

def _creator_where(ctx: SummaryContext, alias: str = "creator_username") -> tuple[str, list]:
    """教师/按教师过滤的创建者条件 (condition_sql, [param])"""
    if ctx.eff_teacher:
        return f"{alias} = ?", [ctx.eff_teacher]
    return "", []


def _list_activities(ctx: SummaryContext) -> dict[str, list[dict[str, Any]]]:
    """按类型采集活动清单, 返回 {type_key: [activity, ...]}"""
    acts: dict[str, list[dict[str, Any]]] = {}
    t = set(ctx.types)

    if "exam" in t:
        cw, cp = _creator_where(ctx)
        where = f"WHERE {cw}" if cw else ""
        acts["exam"] = q_execute_query(
            f"""SELECT id, title, creator_username, status, total_score, pass_score,
                       IFNULL(target_scope,'') AS target_scope, IFNULL(target_grade,'') AS target_grade,
                       IFNULL(target_class,'') AS target_class
                FROM exams {where}""",
            tuple(cp),
        )

    if "practice" in t:
        cw, cp = _creator_where(ctx)
        conds = ["(source IS NULL OR source != 'wrong_book')",
                 "(target_students IS NULL OR target_students = '')"]
        if cw:
            conds.insert(0, cw)
        acts["practice"] = q_execute_query(
            f"""SELECT id, title, creator_username, status, COALESCE(total_score,0) AS total_score,
                       0 AS pass_score, IFNULL(target_grade,'') AS target_grade,
                       IFNULL(target_class,'') AS target_class, '' AS target_scope, '' AS target_users
                FROM practice_sessions WHERE {' AND '.join(conds)}""",
            tuple(cp),
        )

    if "code" in t:
        cw, cp = _creator_where(ctx)
        conds = ["status = 'active'"] + ([cw] if cw else [])
        acts["code"] = q_execute_query(
            f"""SELECT id, title, creator_username, status, 0 AS total_score, 0 AS pass_score,
                       IFNULL(target_scope,'') AS target_scope, IFNULL(target_grade,'') AS target_grade,
                       IFNULL(target_class,'') AS target_class
                FROM code_problems WHERE {' AND '.join(conds)}""",
            tuple(cp),
        )

    if "quiz" in t:
        cw, cp = _creator_where(ctx)
        where = f"WHERE {cw}" if cw else ""
        acts["quiz"] = execute_query_dict(
            f"""SELECT id, title, creator_username, status, 100 AS total_score, 60 AS pass_score,
                       IFNULL(target_scope,'') AS target_scope, IFNULL(target_grade,'') AS target_grade,
                       IFNULL(target_class,'') AS target_class, IFNULL(target_users,'') AS target_users
                FROM interaction_quizzes {where}""",
            tuple(cp),
        )

    if "poll" in t:
        cw, cp = _creator_where(ctx)
        where = f"WHERE {cw}" if cw else ""
        acts["poll"] = execute_query_dict(
            f"""SELECT id, question AS title, creator_username, status,
                       0 AS total_score, 0 AS pass_score,
                       IFNULL(target_scope,'') AS target_scope, IFNULL(target_grade,'') AS target_grade,
                       IFNULL(target_class,'') AS target_class, IFNULL(target_users,'') AS target_users
                FROM interaction_polls {where}""",
            tuple(cp),
        )

    if "task" in t:
        cw, cp = _creator_where(ctx)
        where = f"WHERE {cw}" if cw else ""
        acts["task"] = execute_query_dict(
            f"""SELECT id, name AS title, creator_username, status,
                       100 AS total_score, 60 AS pass_score,
                       IFNULL(target_scope,'') AS target_scope, IFNULL(target_grade,'') AS target_grade,
                       IFNULL(target_class,'') AS target_class, '' AS target_users
                FROM tasks {where}""",
            tuple(cp),
        )

    if "quick_quiz" in t:
        cw, cp = _creator_where(ctx)
        where = f"WHERE {cw}" if cw else ""
        acts["quick_quiz"] = execute_query_dict(
            f"""SELECT id, title, creator_username, status,
                       100 AS total_score, 60 AS pass_score,
                       IFNULL(target_grade,'') AS target_grade, IFNULL(target_class,'') AS target_class,
                       '' AS target_scope, '' AS target_users
                FROM quick_quiz_rooms {where}""",
            tuple(cp),
        )

    if "discussion" in t:
        cw, cp = _creator_where(ctx)
        where = f"WHERE {cw}" if cw else ""
        acts["discussion"] = execute_query_dict(
            f"""SELECT id, title, creator_username, status,
                       0 AS total_score, 0 AS pass_score,
                       '' AS target_scope, '' AS target_grade, '' AS target_class, '' AS target_users
                FROM discussions {where}""",
            tuple(cp),
        )

    if "course" in t:
        acts["course"] = _list_course_activities(ctx)

    if "quest" in t:
        acts["quest"] = []  # 学生自助活动, 采集时直接按学生查 quest_records

    if "score_point" in t:
        acts["score_point"] = []

    return acts


def _list_course_activities(ctx: SummaryContext) -> list[dict[str, Any]]:
    """课程练习 (curriculum_bindings 上绑定的 *_练习.html 资源)

    口径与 activity_monitor._get_teacher_activities 的课程练习段一致:
    教师仅统计自己共享 + 任教年级的课程; 管理员可按 teacher 参数模拟。
    """
    bind_rows = execute_query_dict(
        """SELECT cb.id AS binding_id, cb.knowledge_point_id,
                  kp.name AS kp_name, c.name AS course_name,
                  c.status AS course_status, c.grade AS course_grade,
                  COALESCE(sr.file_name, '') AS fn, COALESCE(sr.file_path, '') AS fp,
                  COALESCE(sr.owner_username, '') AS owner_username
           FROM curriculum_bindings cb
           JOIN knowledge_points kp ON cb.knowledge_point_id = kp.id
           JOIN chapters ch ON kp.chapter_id = ch.id
           JOIN courses c ON ch.course_id = c.id
           LEFT JOIN shared_resources sr ON sr.id = cb.resource_id AND sr.resource_type='html'
           WHERE cb.resource_type='html' AND c.status='active'
           ORDER BY c.sort_order, ch.sort_order, kp.sort_order, cb.id"""
    )
    eff = ctx.eff_teacher
    grade_set: set[str] = set()
    if eff:
        for r in execute_query_dict(
            """SELECT DISTINCT g.name AS grade_name
               FROM teacher_assignments ta JOIN grades g ON ta.grade_id=g.id
               WHERE ta.teacher_username=?""",
            (eff,),
        ):
            gn = str(r.get("grade_name") or "").strip()
            if gn:
                grade_set.add(gn)

    result = []
    for b in bind_rows:
        fn = str(b["fn"] or "")
        fp = str(b["fp"] or "")
        if "_练习.html" not in fn and "_练习.html" not in fp:
            continue
        course_grade = str(b.get("course_grade") or "").strip()
        if eff:
            if b.get("owner_username") != eff:
                continue
            if not course_grade or not grade_set or course_grade not in grade_set:
                continue
        title = fn
        if title.endswith("_练习.html"):
            title = title[: -len("_练习.html")]
        if not title:
            title = f"{b['course_name']} - {b['kp_name']}"
        result.append({
            "id": b["binding_id"],
            "knowledge_point_id": b["knowledge_point_id"],
            "title": title,
            "creator_username": b.get("owner_username") or "",
            "status": b.get("course_status") or "active",
            "total_score": 100,
            "pass_score": 60,
            "target_scope": "grade" if course_grade else "teacher_classes",
            "target_grade": course_grade,
            "target_class": "",
            "target_users": "",
        })
    return result


# ── 学生完成记录采集 ───────────────────────────────────────────

def _make_record(ctx: SummaryContext, *, type_key: str, act: dict[str, Any],
                 student: dict[str, Any], score: Any = None, total: Any = None,
                 rate: Any = None, status: str = "", ts: Any = "") -> dict[str, Any]:
    return {
        "type": type_key,
        "type_label": SUMMARY_TYPES[type_key]["label"],
        "kind": SUMMARY_TYPES[type_key]["kind"],
        "activity_id": act.get("id"),
        "activity_title": act.get("title") or "",
        "creator_name": ctx.creator_name(str(act.get("creator_username") or "")),
        "username": student["username"],
        "student_name": student.get("name") or student["username"],
        "grade": _txt(student.get("grade")),
        "class_name": _txt(student.get("class")),
        "score": _round1(score),
        "total_score": _round1(total) if total is not None else None,
        "rate": _round1(rate) if rate is not None else _rate(score, total),
        "status": status,
        "time": str(ts or ""),
    }


def _query_in(items: list, sql_fn):
    """按 IN 分块执行查询并合并结果, sql_fn(marks, params) -> rows"""
    out = []
    for part in _chunks(items):
        marks = ",".join("?" for _ in part)
        out.extend(sql_fn(marks, tuple(part)))
    return out


def collect_records(ctx: SummaryContext, acts: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """采集全部"学生×活动"明细记录"""
    records: list[dict[str, Any]] = []
    t = set(ctx.types)
    pop_u = [s["username"] for s in ctx.population]

    # ── 1. 考试 ──
    if "exam" in t and acts.get("exam"):
        amap = {a["id"]: a for a in acts["exam"]}
        rows = _query_in(list(amap), lambda marks, params: q_execute_query(
            f"""SELECT exam_id, student_username, score, total_score, submitted_at, status,
                       COALESCE(teacher_score, -1) AS teacher_score,
                       COALESCE(teacher_reviewed, 0) AS teacher_reviewed
                FROM exam_attempts
                WHERE status IN ('submitted','graded') AND exam_id IN ({marks})""",
            params,
        ))
        for r in rows:
            stu = ctx.student_map.get(r["student_username"])
            if not stu or not ctx.in_window(r["submitted_at"]):
                continue
            act = amap[r["exam_id"]]
            tscore = r["teacher_score"]
            final = tscore if (tscore is not None and tscore >= 0) else r["score"]
            total = r["total_score"] or act.get("total_score") or 0
            if r["teacher_reviewed"]:
                status = "已批改(教师复核)"
            elif str(r["status"]) == "graded":
                status = "已批改"
            else:
                status = "已提交/待批改"
            records.append(_make_record(
                ctx, type_key="exam", act=act, student=stu, score=final, total=total,
                status=status, ts=r["submitted_at"],
            ))

    # ── 2. 随堂测验 ──
    if "quiz" in t and acts.get("quiz"):
        amap = {a["id"]: a for a in acts["quiz"]}
        rows = _query_in(list(amap), lambda marks, params: execute_query_dict(
            f"""SELECT quiz_id, student_username, score, submitted_at,
                       COALESCE(ai_pending, 0) AS ai_pending
                FROM interaction_quiz_answers WHERE quiz_id IN ({marks})""",
            params,
        ))
        for r in rows:
            stu = ctx.student_map.get(r["student_username"])
            if not stu or not ctx.in_window(r["submitted_at"]):
                continue
            records.append(_make_record(
                ctx, type_key="quiz", act=amap[r["quiz_id"]], student=stu,
                score=r["score"], total=100,
                status="待批改" if r["ai_pending"] else "已完成",
                ts=r["submitted_at"],
            ))

    # ── 3. 在线任务 (提交 + 评分) ──
    if "task" in t and acts.get("task"):
        amap = {a["id"]: a for a in acts["task"]}
        subs = _query_in(list(amap), lambda marks, params: execute_query_dict(
            f"SELECT task_id, student_username, submitted_at FROM task_submissions WHERE task_id IN ({marks})",
            params,
        ))
        grades = _query_in(list(amap), lambda marks, params: execute_query_dict(
            f"SELECT task_id, student_username, ai_score FROM task_grades WHERE task_id IN ({marks})",
            params,
        ))
        gmap = {(g["task_id"], g["student_username"]): g["ai_score"] for g in grades}
        for r in subs:
            stu = ctx.student_map.get(r["student_username"])
            if not stu or not ctx.in_window(r["submitted_at"]):
                continue
            ai_score = gmap.get((r["task_id"], r["student_username"]))
            records.append(_make_record(
                ctx, type_key="task", act=amap[r["task_id"]], student=stu,
                score=ai_score, total=None if ai_score is None else 100,
                rate=None if ai_score is None else _round1(ai_score),
                status="已评分" if ai_score is not None else "已提交/待评分",
                ts=r["submitted_at"],
            ))

    # ── 4. 智能练习 ──
    if "practice" in t and acts.get("practice"):
        amap = {a["id"]: a for a in acts["practice"]}
        rows = _query_in(list(amap), lambda marks, params: q_execute_query(
            f"""SELECT session_id, student_username, score, total_score, submitted_at,
                       COALESCE(teacher_score, -1) AS teacher_score,
                       COALESCE(teacher_reviewed, 0) AS teacher_reviewed,
                       COALESCE(ai_pending, 0) AS ai_pending
                FROM practice_attempts
                WHERE status='submitted' AND session_id IN ({marks})""",
            params,
        ))
        for r in rows:
            stu = ctx.student_map.get(r["student_username"])
            if not stu or not ctx.in_window(r["submitted_at"]):
                continue
            act = amap[r["session_id"]]
            tscore = r["teacher_score"]
            final = tscore if (tscore is not None and tscore >= 0) else r["score"]
            total = r["total_score"] or act.get("total_score") or 0
            if r["teacher_reviewed"]:
                status = "已批改(教师复核)"
            elif r["ai_pending"]:
                status = "待批改"
            else:
                status = "已完成"
            records.append(_make_record(
                ctx, type_key="practice", act=act, student=stu, score=final, total=total,
                status=status, ts=r["submitted_at"],
            ))

    # ── 5. 代码练习 (取最高分) ──
    if "code" in t and acts.get("code"):
        amap = {a["id"]: a for a in acts["code"]}
        rows = _query_in(list(amap), lambda marks, params: q_execute_query(
            f"""SELECT problem_id, student_username, MAX(score) AS score, MAX(created_at) AS submitted_at
                FROM code_submissions WHERE status='submitted' AND problem_id IN ({marks})
                GROUP BY problem_id, student_username""",
            params,
        ))
        for r in rows:
            stu = ctx.student_map.get(r["student_username"])
            if not stu or not ctx.in_window(r["submitted_at"]):
                continue
            records.append(_make_record(
                ctx, type_key="code", act=amap[r["problem_id"]], student=stu,
                score=r["score"], total=100, status="已完成", ts=r["submitted_at"],
            ))

    # ── 6. 课程练习 (按知识点成绩) ──
    if "course" in t and acts.get("course"):
        kp_map = {a["knowledge_point_id"]: a for a in acts["course"]}
        rows = _query_in(list(kp_map), lambda marks, params: q_execute_query(
            f"""SELECT kp_id, student_username, accuracy, submitted_at
                FROM ai_practice_results WHERE kp_id IN ({marks})""",
            params,
        ))
        for r in rows:
            stu = ctx.student_map.get(r["student_username"])
            if not stu or not ctx.in_window(r["submitted_at"]):
                continue
            records.append(_make_record(
                ctx, type_key="course", act=kp_map[r["kp_id"]], student=stu,
                score=_round1(r["accuracy"]), total=100,
                status="已完成", ts=r["submitted_at"],
            ))

    # ── 7. 知识抢答 ──
    if "quick_quiz" in t and acts.get("quick_quiz"):
        amap = {a["id"]: a for a in acts["quick_quiz"]}
        rows = _query_in(list(amap), lambda marks, params: execute_query_dict(
            f"""SELECT room_id, student_username, total_score, joined_at
                FROM quick_quiz_players WHERE room_id IN ({marks})""",
            params,
        ))
        for r in rows:
            stu = ctx.student_map.get(r["student_username"])
            if not stu or not ctx.in_window(r["joined_at"]):
                continue
            records.append(_make_record(
                ctx, type_key="quick_quiz", act=amap[r["room_id"]], student=stu,
                score=r["total_score"], total=100, status="已参与", ts=r["joined_at"],
            ))

    # ── 8. 知识闯关 (学生自助, 已通关记录, 口径=答题正确率) ──
    if "quest" in t:
        rows = _query_in(pop_u, lambda marks, params: execute_query_dict(
            f"""SELECT id, student_username, total_questions, correct_count, completed_at
                FROM quest_records WHERE completed=1 AND student_username IN ({marks})""",
            params,
        ))
        for r in rows:
            stu = ctx.student_map.get(r["student_username"])
            if not stu or not ctx.in_window(r["completed_at"]):
                continue
            records.append(_make_record(
                ctx, type_key="quest",
                act={"id": r["id"], "title": "知识闯关", "creator_username": ""},
                student=stu,
                score=r["correct_count"], total=r["total_questions"],
                status="已通关", ts=r["completed_at"],
            ))

    # ── 9. 快速投票 ──
    if "poll" in t and acts.get("poll"):
        amap = {a["id"]: a for a in acts["poll"]}
        rows = _query_in(list(amap), lambda marks, params: execute_query_dict(
            f"""SELECT poll_id, student_username, MIN(created_at) AS voted_at
                FROM interaction_poll_votes WHERE poll_id IN ({marks})
                GROUP BY poll_id, student_username""",
            params,
        ))
        for r in rows:
            stu = ctx.student_map.get(r["student_username"])
            if not stu or not ctx.in_window(r["voted_at"]):
                continue
            records.append(_make_record(
                ctx, type_key="poll", act=amap[r["poll_id"]], student=stu,
                status="已参与", ts=r["voted_at"],
            ))

    # ── 10. 分组讨论 (加入小组即算参与) ──
    if "discussion" in t and acts.get("discussion"):
        amap = {a["id"]: a for a in acts["discussion"]}
        rows = _query_in(list(amap), lambda marks, params: execute_query_dict(
            f"""SELECT dg.discussion_id AS discussion_id, dm.username AS student_username,
                       MIN(dm.joined_at) AS joined_at
                FROM discussion_groups dg
                JOIN discussion_members dm ON dm.group_id = dg.id
                WHERE dg.discussion_id IN ({marks})
                GROUP BY dg.discussion_id, dm.username""",
            params,
        ))
        for r in rows:
            stu = ctx.student_map.get(r["student_username"])
            if not stu or not ctx.in_window(r["joined_at"]):
                continue
            records.append(_make_record(
                ctx, type_key="discussion", act=amap[r["discussion_id"]], student=stu,
                status="已参与", ts=r["joined_at"],
            ))

    # ── 11. 课堂积分 (scores 表按「年级+姓名」映射回在籍学生, 与 export_scores 口径一致) ──
    if "score_point" in t:
        conds, params = [], []
        if ctx.eff_teacher:
            conds.append("teacher_username = ?")
            params.append(ctx.eff_teacher)
        where = f"WHERE {' AND '.join(conds)}" if conds else ""
        rows = execute_query_dict(
            f"""SELECT grade, class_name, student_name, SUM(score) AS points, MAX(updated_at) AS updated_at
                FROM scores {where}
                GROUP BY grade, class_name, student_name""",
            tuple(params),
        )
        name_index: dict[tuple[str, str], list[str]] = {}
        for s in ctx.population:
            name_index.setdefault((_txt(s.get("grade")), _txt(s.get("name"))), []).append(s["username"])
        for r in rows:
            if not ctx.in_window(r.get("updated_at")):
                continue
            unames = name_index.get((r.get("grade") or "", r.get("student_name") or "")) or []
            for uname in unames:
                stu = ctx.student_map[uname]
                records.append(_make_record(
                    ctx, type_key="score_point",
                    act={"id": None, "title": "课堂积分", "creator_username": ctx.eff_teacher},
                    student=stu,
                    score=r["points"], total=None, rate=None,
                    status="累计", ts=r.get("updated_at"),
                ))

    # 排序: 年级 → 班级 → 姓名 → 活动类型 → 时间
    type_order = {k: i for i, k in enumerate(SUMMARY_TYPES)}
    records.sort(key=lambda x: (x["grade"], x["class_name"], x["student_name"],
                                type_order.get(x["type"], 99), x["time"]))
    return records


# ── 应参与人数 (按活动目标范围估算) ────────────────────────────

_CLASS_NONNUM_RE = re.compile(r"[^\d]")


def _class_name_match(target: str, student_class: str) -> bool:
    """班级名匹配: 精确 或 数字等价 (与 check_activity_visibility 口径一致)"""
    if not target or not student_class:
        return False
    if target == student_class:
        return True
    num = _CLASS_NONNUM_RE.sub("", target)
    if num and student_class in (num, num + "班"):
        return True
    return False


def expected_students(ctx: SummaryContext, act: dict[str, Any]) -> list[dict[str, Any]]:
    """某活动的"应参与"学生集合 = 学生群体 ∩ 活动目标范围"""
    scope = str(act.get("target_scope") or "").strip() or "teacher_classes"
    pop = ctx.population
    tg = [x.strip() for x in str(act.get("target_grade") or "").split(",") if x.strip()]
    tc = [x.strip() for x in str(act.get("target_class") or "").split(",") if x.strip()]
    tu = [x.strip() for x in str(act.get("target_users") or "").split(",") if x.strip()]

    if scope == "all":
        return pop
    if scope == "individual" and tu:
        return [s for s in pop if s["username"] in tu]
    if scope == "grade" and tg:
        return [s for s in pop if _txt(s.get("grade")) in tg]
    if scope == "class" and tg and tc:
        return [s for s in pop
                if _txt(s.get("grade")) in tg
                and any(_class_name_match(c, _txt(s.get("class"))) for c in tc)]
    # teacher_classes 及数据缺失回退: 创建者任教范围 ∩ 学生群体
    scope_students = ctx.teacher_scope_students(str(act.get("creator_username") or ""))
    return [s for s in pop if s["username"] in scope_students]


# ── 聚合 ───────────────────────────────────────────────────────

def _mean(vals: list) -> Optional[float]:
    v = [x for x in vals if x is not None]
    return _round1(sum(v) / len(v)) if v else None


def aggregate_by_student(ctx: SummaryContext, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """学生 × 活动类型 汇总矩阵 (群体内每名学生一行, 未完成也保留)"""
    by_stu: dict[str, dict[str, Any]] = {}
    for s in ctx.population:
        by_stu[s["username"]] = {
            "username": s["username"],
            "name": s.get("name") or s["username"],
            "grade": _txt(s.get("grade")),
            "class_name": _txt(s.get("class")),
            "types": {},
            "total_done": 0,
            "overall_avg_rate": None,
            "points": None,
        }
    rates_by_stu: dict[str, list] = {}
    done_by_stu: dict[str, int] = {}

    for r in records:
        row = by_stu.get(r["username"])
        if row is None:
            continue
        cell = row["types"].setdefault(r["type"], {"count": 0, "rates": []})
        cell["count"] += 1
        if r["kind"] == "score":
            cell["rates"].append(r["rate"])
            rates_by_stu.setdefault(r["username"], []).append(r["rate"])
            done_by_stu[r["username"]] = done_by_stu.get(r["username"], 0) + 1
        elif r["kind"] == "participation":
            done_by_stu[r["username"]] = done_by_stu.get(r["username"], 0) + 1
        elif r["kind"] == "points":
            row["points"] = (row["points"] or 0) + (r["score"] or 0)

    result = []
    for username, row in by_stu.items():
        types_out = {}
        for tkey, cell in row["types"].items():
            meta = SUMMARY_TYPES[tkey]
            if meta["kind"] == "score":
                types_out[tkey] = {
                    "count": cell["count"],
                    "avg_rate": _mean(cell["rates"]),
                    "max_rate": _round1(max([x for x in cell["rates"] if x is not None]))
                    if any(x is not None for x in cell["rates"]) else None,
                }
            elif meta["kind"] == "participation":
                types_out[tkey] = {"count": cell["count"]}
            else:  # points
                types_out[tkey] = {"count": cell["count"], "points": row["points"]}
        row["types"] = types_out
        row["total_done"] = done_by_stu.get(username, 0)
        row["overall_avg_rate"] = _mean(rates_by_stu.get(username, []))
        result.append(row)
    result.sort(key=lambda x: (x["grade"], x["class_name"], x["name"]))
    return result


def aggregate_by_activity(ctx: SummaryContext, acts: dict[str, list[dict[str, Any]]],
                          records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按活动汇总: 应参与/实参与/参与率/平均得分率/及格率 (闯关与积分类不在清单内)"""
    grouped: dict[tuple[str, Any], list[dict[str, Any]]] = {}
    for r in records:
        if r["type"] in ("quest", "score_point"):
            continue
        grouped.setdefault((r["type"], r["activity_id"]), []).append(r)

    result = []
    for type_key, items in acts.items():
        if type_key in ("quest", "score_point"):
            continue
        meta = SUMMARY_TYPES[type_key]
        for act in items:
            recs = grouped.get((type_key, act["id"]), [])
            expected = expected_students(ctx, act)
            exp_n = len(expected)
            part_n = len({r["username"] for r in recs})
            rates = [r["rate"] for r in recs if r["rate"] is not None]
            pass_line = _PASS_RATE_DEFAULT
            try:
                ts, ps = float(act.get("total_score") or 0), float(act.get("pass_score") or 0)
                if ts > 0 and ps > 0:
                    pass_line = ps / ts * 100
            except (TypeError, ValueError):
                pass
            result.append({
                "type": type_key,
                "type_label": meta["label"],
                "kind": meta["kind"],
                "activity_id": act["id"],
                "activity_title": act.get("title") or "",
                "creator_name": ctx.creator_name(str(act.get("creator_username") or "")),
                "expected": exp_n,
                "participants": part_n,
                "participation_rate": _round1(part_n / exp_n * 100) if exp_n else None,
                "avg_rate": _mean(rates) if meta["kind"] == "score" else None,
                "max_rate": _round1(max(rates)) if rates else None,
                "min_rate": _round1(min(rates)) if rates else None,
                "pass_rate": _round1(sum(1 for x in rates if x >= pass_line) / len(rates) * 100)
                if rates and meta["kind"] == "score" else None,
                "last_time": max((r["time"] for r in recs), default=""),
            })
    type_order = {k: i for i, k in enumerate(SUMMARY_TYPES)}
    result.sort(key=lambda x: (type_order.get(x["type"], 99), -int(x["expected"] or 0),
                               str(x["activity_title"])))
    return result


def aggregate_by_class(ctx: SummaryContext, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按班级汇总: 人数 + 各类型完成次数/平均得分率 + 整体均分率"""
    classes: dict[tuple[str, str], dict[str, Any]] = {}
    for s in ctx.population:
        key = (_txt(s.get("grade")), _txt(s.get("class")))
        row = classes.setdefault(key, {
            "grade": key[0], "class_name": key[1], "students": 0,
            "types": {}, "overall_rates": [], "total_done": 0,
        })
        row["students"] += 1
    points_by_cls: dict[tuple[str, str], float] = {}
    for r in records:
        key = (r["grade"], r["class_name"])
        row = classes.get(key)
        if row is None:
            continue
        cell = row["types"].setdefault(r["type"], {"count": 0, "rates": []})
        cell["count"] += 1
        if r["kind"] == "score":
            if r["rate"] is not None:
                cell["rates"].append(r["rate"])
                row["overall_rates"].append(r["rate"])
                row["total_done"] += 1
        elif r["kind"] == "participation":
            row["total_done"] += 1
        elif r["kind"] == "points":
            points_by_cls[key] = points_by_cls.get(key, 0) + (r["score"] or 0)
    result = []
    for (grade, cname), row in classes.items():
        types_out = {}
        for tkey, cell in row["types"].items():
            meta = SUMMARY_TYPES[tkey]
            if meta["kind"] == "score":
                types_out[tkey] = {"count": cell["count"], "avg_rate": _mean(cell["rates"])}
            else:
                types_out[tkey] = {"count": cell["count"]}
        key = (grade, cname)
        result.append({
            "grade": grade, "class_name": cname, "students": row["students"],
            "types": types_out, "total_done": row["total_done"],
            "overall_avg_rate": _mean(row["overall_rates"]),
            "points_total": points_by_cls.get(key),
        })
    result.sort(key=lambda x: (x["grade"], x["class_name"]))
    return result


# ── 对外入口 ───────────────────────────────────────────────────

def build_summary(user: dict[str, Any], **filters: Any) -> dict[str, Any]:
    """解析筛选参数 → 采集明细 → 三类聚合, 返回完整汇总结果 (不截断)"""
    ctx = SummaryContext(user, **filters)
    acts = _list_activities(ctx)
    records = collect_records(ctx, acts)
    by_student = aggregate_by_student(ctx, records)
    by_activity = aggregate_by_activity(ctx, acts, records)
    by_class = aggregate_by_class(ctx, records)
    logger.info(
        f"[summary] user={ctx.username} admin={ctx.is_admin} pop={len(ctx.population)} "
        f"records={len(records)} types={len(ctx.types)} range={ctx.start or '-'}~{ctx.end or '-'}"
    )
    return {
        "types": {k: SUMMARY_TYPES[k] for k in ctx.types},
        "population": [
            {"username": s["username"], "name": s.get("name") or "",
             "grade": _txt(s.get("grade")), "class_name": _txt(s.get("class"))}
            for s in ctx.population
        ],
        "records": records,
        "by_student": by_student,
        "by_activity": by_activity,
        "by_class": by_class,
    }
