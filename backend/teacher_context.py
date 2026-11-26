"""教师教学快照：为助手模式注入平台实时数据

助手模式此前只有人设没有数据，"班级分析"只能反问老师上传成绩。
本模块聚合任教范围、近期考试、待批改与班级薄弱知识点，产出一段
紧凑文本快照，由 companion_router 拼进系统提示词。构建失败返回空串，
绝不阻塞对话主链路。
"""
import threading
import time
from datetime import datetime
from typing import Any

from backend.database import execute_query
from backend.question_db import execute_query as q_execute_query
from backend.logger import logger

_cache: dict[str, tuple[float, str]] = {}
_LOCK = threading.Lock()
_TTL_SECONDS = 60

_STATUS_LABEL = {"draft": "草稿", "published": "已发布", "ended": "已结束"}


def build_teacher_snapshot(username: str, role: int) -> str:
    """带 60 秒缓存的快照文本；任何异常都吞掉返回空串"""
    now = time.time()
    with _LOCK:
        hit = _cache.get(username)
        if hit and now - hit[0] < _TTL_SECONDS:
            return hit[1]
    try:
        text = _build(username, role)
    except Exception as e:
        logger.warning(f"教学快照构建失败 ({username}): {e}")
        text = ""
    with _LOCK:
        _cache[username] = (now, text)
    return text


def _build(username: str, role: int) -> str:
    from backend.permission_service import (
        get_teacher_subjects, get_teacher_scope, get_students_in_scope,
    )

    lines: list[str] = []

    # ── 身份与任教范围 ──
    row = execute_query("SELECT name FROM users WHERE username=?", (username,))
    name = row[0][0] if row and row[0][0] else username
    subjects = [s for s in (get_teacher_subjects(username) or []) if s]
    if role == 0:
        scope_desc = "管理员（全平台）"
        try:
            n_students = int(execute_query(
                "SELECT COUNT(*) FROM users WHERE role=2 AND IFNULL(status,'active')='active'")[0][0] or 0)
        except Exception:
            n_students = 0
    else:
        parts: list[str] = []
        for grp in get_teacher_scope(username):
            for g in grp.get("grades", []):
                gname = str(g.get("grade_name") or "")
                if g.get("all_classes"):
                    parts.append(f"{gname}全部班级")
                elif g.get("classes"):
                    parts.append(f"{gname}" + "".join(f"{c}班" for c in g["classes"][:6]))
                else:
                    parts.append(gname or "未配置班级")
        scope_desc = "、".join(dict.fromkeys(p for p in parts if p)) or "未配置任教范围"
        try:
            n_students = len(get_students_in_scope(username))
        except Exception:
            n_students = 0
    lines.append(f"- 教师：{name}｜学科：{'、'.join(subjects) or '未配置'}｜任教：{scope_desc}｜范围内学生：{n_students} 人")

    # ── 近期考试（教师看自己创建，管理员看全平台最新）──
    if role == 0:
        exams = q_execute_query(
            "SELECT id, title, status, total_score FROM exams ORDER BY created_at DESC LIMIT 3")
    else:
        exams = q_execute_query(
            "SELECT id, title, status, total_score FROM exams WHERE creator_username=? "
            "ORDER BY created_at DESC LIMIT 3", (username,))
    exams = list(exams or [])
    if exams:
        lines.append("- 近期考试：")
        for i, ex in enumerate(exams, 1):
            st = _STATUS_LABEL.get(str(ex.get("status")), str(ex.get("status") or "-"))
            try:
                stat = q_execute_query(
                    "SELECT COUNT(*) AS n, AVG(score) AS avg_s, AVG(total_score) AS avg_t FROM exam_attempts "
                    "WHERE exam_id=? AND status IN ('submitted','graded')", (ex["id"],))
                r0 = stat[0] if stat else None
                n = int(r0["n"] or 0) if r0 else 0
                avg = float(r0["avg_s"]) if r0 and r0["avg_s"] is not None else 0.0
                avg_total = float(r0["avg_t"]) if r0 and r0["avg_t"] is not None else 0.0
            except Exception:
                n, avg, avg_total = 0, 0.0, 0.0
            pct = f"，平均得分率 {round(avg / avg_total * 100, 1)}%" if n and avg and avg_total else ""
            lines.append(f"  {i}.《{ex.get('title') or ''}》[{st}]，已交 {n} 份{pct}")
        try:
            ids = [ex["id"] for ex in exams]
            ph = ",".join("?" * len(ids))
            if role == 0:
                pending = int(q_execute_query(
                    "SELECT COUNT(*) AS n FROM exam_attempts WHERE status='submitted'")[0]["n"] or 0)
            else:
                pending = int(q_execute_query(
                    f"SELECT COUNT(*) AS n FROM exam_attempts WHERE status='submitted' AND exam_id IN ({ph})",
                    tuple(ids))[0]["n"] or 0)
            lines.append(f"- 待批改（已提交未评分）：{pending} 份")
        except Exception:
            pass
    else:
        lines.append("- 近期考试：暂无")

    # ── 班级薄弱知识点（错题本聚合，限前 300 名学生）──
    try:
        if role == 0:
            students = [str(r[0]) for r in (execute_query(
                "SELECT username FROM users WHERE role=2 AND IFNULL(status,'active')='active' LIMIT 300") or [])]
        else:
            students = [str(s["username"]) for s in get_students_in_scope(username)[:300]]
        if students:
            ph = ",".join("?" * len(students))
            rows = execute_query(
                f"""SELECT knowledge_points, SUM(wrong_count) AS c FROM wrong_book
                    WHERE student_username IN ({ph})
                      AND status='pending'
                      AND knowledge_points IS NOT NULL AND knowledge_points != ''
                    GROUP BY knowledge_points ORDER BY c DESC LIMIT 5""",
                tuple(students))
            if rows:
                lines.append("- 班级薄弱知识点 Top5（错题本）：" +
                             "；".join(f"{str(r[0]).strip()}×{int(r[1] or 0)}" for r in rows if r[0]))
    except Exception as e:
        logger.debug(f"快照-班级薄弱点查询失败: {e}")

    header = f"## 当前教学快照（平台实时数据，生成于 {datetime.now().strftime('%Y-%m-%d %H:%M')}）"
    return header + "\n" + "\n".join(lines)
