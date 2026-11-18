# -*- coding: utf-8 -*-
"""教学简报采集与事实生成（P0）。

设计要点（与 docs/briefing/00-方案建议.md 对齐）：
  - 数字与叙述分离：本模块只算数字与"事实要点"，不调用 AI；
  - 快照不可变：同周期同筛选只产出一份 metrics/facts；
  - 教师范围在采集层收敛：只认 teacher_assignments，不静默回退全校；
  - 口径统一：得分一律折算百分制（复用 quiz_stats.centesimal），
    同生同活动取最优，样本不足不给比率。

对外入口：
  resolve_period()      周期解析（日/周/月/年）
  previous_period()     上一周期
  resolve_scope()       角色 + 四维筛选 → 学生集合与快照签名
  collect_metrics()     采集指标 + 事实 + 表扬名单
"""
from __future__ import annotations

import calendar
import hashlib
import json
import re
from datetime import date, datetime, timedelta
from typing import Any, Iterable

from fastapi import HTTPException

from backend.database import execute_query_dict
from backend.logger import logger
from backend.permission_service import get_teacher_assignments
from backend.question_db import execute_query as q_execute_query
from backend.quiz_stats import centesimal, quiz_graded, quiz_questions, quiz_total

PERIOD_TYPES = ("day", "week", "month", "year")

# 口径常量：改动必须同步升 METRICS_VERSION
METRICS_VERSION = 3
MIN_SAMPLE = 5               # 比率的最小样本（人次）
MIN_CLASS_STUDENTS = 10      # 班级比率的最小在籍人数
MIN_KP_ANSWERS = 10          # 知识点正确率的最小作答数
PASS_RATE_LINE = 60.0        # 及格线（百分制）
EXCELLENT_LINE = 85.0        # 优秀线
SILENT_ALERT_RATE = 40.0     # 低分预警线

PRAISE_QUOTA = {
    "week": {"students": 6, "classes": 3},
    "month": {"students": 12, "classes": 5},
    "year": {"students": 20, "classes": 8},
}
PRAISE_COVERAGE_CAP = 0.3    # 表扬覆盖率上限
PRAISE_MIN_CLASS_PARTICIPATION = 50.0  # 班级表扬的最低参与率（防止 1/55 也上榜）


# ══════════════════════════════════════════════════════════════
# 基础工具
# ══════════════════════════════════════════════════════════════

def _txt(v: Any) -> str:
    return str(v if v is not None else "").strip()


def _split_multi(v: Any) -> list[str]:
    """'高一,高二' / ['高一','高二'] → ['高一','高二']"""
    if isinstance(v, (list, tuple, set)):
        return [str(x).strip() for x in v if str(x).strip()]
    raw = _txt(v).replace("，", ",").replace("、", ",")
    return [x.strip() for x in raw.split(",") if x.strip()]


def _as_list(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return _split_multi(v)
    return [str(x).strip() for x in v if str(x).strip()]


def _dt(v: Any) -> datetime | None:
    s = _txt(v).replace("T", " ")
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:19] if fmt != "%Y-%m-%d" else s[:10], fmt)
        except ValueError:
            continue
    return None


def _fmt(dt: datetime, end: bool = False) -> str:
    if end:
        return dt.strftime("%Y-%m-%d") + " 23:59:59"
    return dt.strftime("%Y-%m-%d") + " 00:00:00"


def _rate(score: Any, total: Any) -> float | None:
    """百分制得分率；无有效满分返回 None（讨论/投票这类不计分）"""
    try:
        s = float(score if score is not None else 0)
        t = float(total if total is not None else 0)
    except (TypeError, ValueError):
        return None
    if t <= 0:
        return None
    return round(max(0.0, min(100.0, s / t * 100.0)), 1)


def _mean(vals: Iterable[float]) -> float | None:
    items = [v for v in vals if v is not None]
    return round(sum(items) / len(items), 1) if items else None


def _pct(n: int, d: int) -> float | None:
    if d <= 0:
        return None
    return round(n / d * 100.0, 1)


def _class_tokens(display: str, short: str = "") -> set[str]:
    """班级名归一化：'高一1班' → {'高一1班','1班','1'}"""
    out: set[str] = set()
    for raw in (display, short):
        v = _txt(raw)
        if not v:
            continue
        out.add(v)
        if v.endswith("班"):
            out.add(v[:-1])
        nums = re.findall(r"\d+", v)
        if nums:
            out.add(nums[0])
            out.add(f"{nums[0]}班")
    return out


def _mask_name(name: str) -> str:
    """预警名单脱敏：'李明' → '李*'"""
    n = _txt(name)
    if len(n) <= 1:
        return n or "匿名"
    return n[0] + "*" * (len(n) - 1)


# ══════════════════════════════════════════════════════════════
# 周期解析
# ══════════════════════════════════════════════════════════════

def _anchor_of(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    dt = _dt(value)
    return dt.date() if dt else datetime.now().date()


def _shift_anchor(period_type: str, anchor: date, steps: int) -> date:
    if period_type == "day":
        return anchor + timedelta(days=steps)
    if period_type == "week":
        return anchor + timedelta(days=7 * steps)
    if period_type == "month":
        month_index = anchor.year * 12 + (anchor.month - 1) + steps
        return date(month_index // 12, month_index % 12 + 1, 1)
    if period_type == "year":
        return date(anchor.year + steps, anchor.month, 1)
    raise HTTPException(status_code=400, detail="周期类型错误")


def _year_bounds(anchor: date, year_mode: str) -> tuple[date, date, str]:
    if year_mode == "calendar":
        return date(anchor.year, 1, 1), date(anchor.year, 12, 31), f"{anchor.year} 年"
    start_year = anchor.year if anchor.month >= 9 else anchor.year - 1
    return (date(start_year, 9, 1), date(start_year + 1, 8, 31),
            f"{start_year}–{start_year + 1} 学年")


def _bounds(period_type: str, anchor: date, year_mode: str) -> tuple[date, date]:
    if period_type == "day":
        return anchor, anchor
    if period_type == "week":
        monday = anchor - timedelta(days=anchor.weekday())
        return monday, monday + timedelta(days=6)
    if period_type == "month":
        first = date(anchor.year, anchor.month, 1)
        nxt = date(anchor.year + (anchor.month // 12), anchor.month % 12 + 1, 1)
        return first, nxt - timedelta(days=1)
    start, end, _ = _year_bounds(anchor, year_mode)
    return start, end


def _period_key(period_type: str, anchor: date, year_mode: str) -> str:
    if period_type == "day":
        return f"d:{anchor:%Y-%m-%d}"
    if period_type == "week":
        iso = anchor.isocalendar()
        return f"w:{iso[0]}-W{iso[1]:02d}"
    if period_type == "month":
        return f"m:{anchor:%Y-%m}"
    start, _, _ = _year_bounds(anchor, year_mode)
    if year_mode == "calendar":
        return f"y:{start.year}"
    return f"y:{start.year}-{start.year + 1}"


def _period_label(period_type: str, start: date, end: date, anchor: date, year_mode: str) -> str:
    if period_type == "day":
        weekdays = "一二三四五六日"
        return f"{start:%Y-%m-%d}（周{weekdays[start.weekday()]}）"
    if period_type == "week":
        # 不用 ISO 周数：它不是教学周，容易被误读成"学期第几周"。
        if start.year == end.year:
            return f"{start.month}月{start.day}日–{end.month}月{end.day}日"
        return (f"{start.year}年{start.month}月{start.day}日–"
                f"{end.year}年{end.month}月{end.day}日")
    if period_type == "month":
        return f"{start.year} 年 {start.month} 月"
    return _year_bounds(anchor, year_mode)[2]


def resolve_period(period_type: str = "week", anchor: Any = None,
                   start: str = "", end: str = "", year_mode: str = "school_year") -> dict[str, Any]:
    """解析周期。start/end 可自定义区间（仍按 period_type 归组）。"""
    period_type = _txt(period_type).lower() or "week"
    if period_type not in PERIOD_TYPES:
        raise HTTPException(status_code=400, detail="周期类型应为 day/week/month/year")
    year_mode = "calendar" if _txt(year_mode).lower() == "calendar" else "school_year"

    if start or end:
        s = _anchor_of(start) if start else _anchor_of(anchor)
        e = _anchor_of(end) if end else _anchor_of(anchor or start)
        if e < s:
            raise HTTPException(status_code=400, detail="结束日期不能早于开始日期")
        if (e - s).days > 400:
            raise HTTPException(status_code=400, detail="时间区间过长（最多 400 天）")
        anchor_date = s
        label = f"{s:%Y-%m-%d}–{e:%m.%d}" if s != e else f"{s:%Y-%m-%d}"
        # 自定义区间必须与整周期区分：否则 11.12–11.13 会命中「11.09–11.15 周报」
        base_key = _period_key(period_type, anchor_date, year_mode)
        return {
            "type": period_type, "key": f"{base_key}@{s:%m%d}-{e:%m%d}",
            "start": _fmt(s), "end": _fmt(e, end=True),
            "start_date": s.isoformat(), "end_date": e.isoformat(),
            "label": label, "custom": True, "year_mode": year_mode,
        }

    anchor_date = _anchor_of(anchor)
    s, e = _bounds(period_type, anchor_date, year_mode)
    return {
        "type": period_type, "key": _period_key(period_type, anchor_date, year_mode),
        "start": _fmt(s), "end": _fmt(e, end=True),
        "start_date": s.isoformat(), "end_date": e.isoformat(),
        "label": _period_label(period_type, s, e, anchor_date, year_mode),
        "custom": False, "year_mode": year_mode,
    }


def previous_period(period: dict[str, Any]) -> dict[str, Any]:
    """上一同类型周期（环比基准）。

    自定义区间按「等长平移」算上一期，否则 11.12–11.13 会拿整周做分母。
    """
    ptype = period["type"]
    year_mode = period.get("year_mode", "school_year")
    if period.get("custom"):
        s = _anchor_of(period["start_date"])
        e = _anchor_of(period["end_date"])
        span = (e - s).days + 1
        return resolve_period(ptype, start=(s - timedelta(days=span)).isoformat(),
                              end=(e - timedelta(days=span)).isoformat(), year_mode=year_mode)
    prev_anchor = _shift_anchor(ptype, _anchor_of(period["start_date"]), -1)
    return resolve_period(ptype, anchor=prev_anchor, year_mode=year_mode)


# ══════════════════════════════════════════════════════════════
# 范围与筛选
# ══════════════════════════════════════════════════════════════

def _allowed_pairs(role: int, owner: str) -> list[dict[str, Any]]:
    """角色可访问的 (年级, 班级) 集合。

    教师：只认 teacher_assignments；class_id 为空表示该年级全部班级。
    管理员：owner 为空 → 全部年级班级；指定 owner → 该教师的范围。
    """
    if role == 0 and not owner:
        rows = execute_query_dict(
            """SELECT c.grade_id, c.id AS class_id, c.name AS class_name,
                      c.display_name AS class_display_name, g.name AS grade_name
               FROM classes c JOIN grades g ON c.grade_id = g.id
               ORDER BY g.sort_order, c.sort_order"""
        )
        return [{"grade_id": r["grade_id"], "class_id": r["class_id"],
                 "grade_name": r["grade_name"], "subject": _txt(r.get("subject")),
                 "class_name": r.get("class_name") or "",
                 "class_display": r.get("class_display_name") or r.get("class_name") or ""}
                for r in rows]

    rows = get_teacher_assignments(owner)
    out: list[dict[str, Any]] = []
    for r in rows:
        gid = int(r["grade_id"])
        if r.get("class_id") is None:
            classes = execute_query_dict(
                "SELECT id, name, display_name FROM classes WHERE grade_id=? ORDER BY sort_order", (gid,)
            )
            for c in classes:
                out.append({"grade_id": gid, "class_id": c["id"],
                            "grade_name": r.get("grade_name") or "",
                            "subject": _txt(r.get("subject")),
                            "class_name": c.get("name") or "",
                            "class_display": c.get("display_name") or c.get("name") or ""})
        else:
            out.append({"grade_id": gid, "class_id": int(r["class_id"]),
                        "grade_name": r.get("grade_name") or "",
                        "subject": _txt(r.get("subject")),
                        "class_name": r.get("class_name") or "",
                        "class_display": r.get("class_display_name") or r.get("class_name") or ""})
    return out


def resolve_scope(user: dict[str, Any], teacher: str = "", grades: Any = None,
                  classes: Any = None, subjects: Any = None) -> dict[str, Any]:
    """角色 + 四维筛选 → 学生集合、班级集合、快照签名。

    越权直接 403（不静默过滤），教师无任教记录直接 409。
    """
    role = int(user.get("role", 2))
    username = _txt(user.get("username"))
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看教学简报")

    teacher = _txt(teacher)
    if teacher and role != 0 and teacher != username:
        raise HTTPException(status_code=403, detail="无权查看其他教师的数据")

    owner = username if role != 0 else teacher
    pairs = _allowed_pairs(role, owner)
    if role != 0 and not pairs:
        raise HTTPException(status_code=409, detail="尚未分配任教班级，请联系管理员")

    # 教师可选学科来自任教关系
    own_subjects: list[str] = []
    for p in pairs:
        sub = _txt(p.get("subject"))
        if sub and sub not in own_subjects:
            own_subjects.append(sub)

    req_subjects = _as_list(subjects)

    def _same_family(a: str, b: str) -> bool:
        try:
            from backend.question_select import subject_family
            return subject_family(a) == subject_family(b)
        except Exception:
            return a == b

    if role != 0 and req_subjects:
        illegal = [s for s in req_subjects
                   if not any(_same_family(s, own) for own in own_subjects)]
        if illegal:
            raise HTTPException(status_code=403, detail=f"无权查看学科：{', '.join(illegal)}")

    # 查询用别名集合：选了「信息科技」也要把历史写法「信息技术」一起算进来
    subject_variants: set[str] = set()
    for sub in req_subjects:
        try:
            from backend.question_select import family_members
            subject_variants |= set(family_members(sub))
        except Exception:
            subject_variants.add(sub)

    # 年级筛选
    all_grades: dict[int, str] = {}
    for p in pairs:
        all_grades[int(p["grade_id"])] = p["grade_name"]
    req_grades = _as_list(grades)
    if req_grades:
        missing = [g for g in req_grades if g not in all_grades.values()]
        if missing:
            raise HTTPException(status_code=403, detail=f"无权查看年级：{', '.join(missing)}")
        grade_ids = {gid for gid, name in all_grades.items() if name in req_grades}
    else:
        grade_ids = set(all_grades.keys())
    pairs = [p for p in pairs if int(p["grade_id"]) in grade_ids]

    # 班级筛选：支持"高一1班" / "1班" / "1"
    req_classes = _as_list(classes)
    if req_classes:
        wanted_tokens: set[str] = set()
        for c in req_classes:
            wanted_tokens |= _class_tokens(c)
        matched = [p for p in pairs
                   if _class_tokens(p["class_display"], p["class_name"]) & wanted_tokens]
        if not matched:
            raise HTTPException(status_code=403, detail="无权查看所选班级")
        pairs = matched

    if not pairs:
        raise HTTPException(status_code=409, detail="当前筛选下没有可统计的班级")

    # 学生集合
    # 一次查询取回全部班级的学生（原实现按班循环，15–26 个班就是 15–26 次查询）
    class_meta = {
        (int(p["grade_id"]), int(p["class_id"])): p for p in pairs
    }
    conds: list[str] = []
    params_stu: list[Any] = []
    for gid, cid in class_meta:
        conds.append("(u.grade_id=? AND u.class_id=?)")
        params_stu += [gid, cid]
    students: dict[str, dict[str, Any]] = {}
    if conds:
        rows = execute_query_dict(
            """SELECT u.username, u.name, u.grade_id, u.class_id
               FROM users u
               WHERE u.role=2 AND IFNULL(u.status,'active')='active'
                 AND (""" + " OR ".join(conds) + ")",
            tuple(params_stu),
        )
        for r in rows:
            uname = _txt(r["username"])
            if not uname or uname in students:
                continue
            meta = class_meta.get((int(r["grade_id"]), int(r["class_id"])))
            if not meta:
                continue
            students[uname] = {
                "username": uname, "name": _txt(r.get("name")) or uname,
                "grade": meta["grade_name"], "class": meta["class_display"],
                "class_short": meta["class_name"],
                "grade_id": int(r["grade_id"]), "class_id": int(r["class_id"]),
            }

    # 学科筛选：影响活动过滤，无学科维度的指标会被标记不可用
    # 签名用「解析后的真实数据范围」：空筛选与显式选同一批班级得到同一份快照
    resolved_payload = {
        "teacher": owner, "subjects": sorted(req_subjects),
        "grade_ids": sorted({int(p["grade_id"]) for p in pairs}),
        "class_ids": sorted({int(p["class_id"]) for p in pairs}),
    }
    digest = hashlib.sha1(
        json.dumps(resolved_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16]

    # 落库/重生成用「用户实际选了什么」，避免把默认范围固化成 15 个班级名
    requested_payload = {
        "teacher": owner, "subjects": req_subjects, "grades": req_grades, "classes": req_classes,
    }

    class_count = len({p["class_display"] for p in pairs})
    label_parts: list[str] = []
    if role == 0:
        label_parts.append(f"教师：{owner}" if owner else "全校")
    elif not (req_subjects or req_grades or req_classes):
        label_parts.append("全部任教范围")
    if req_subjects:
        label_parts.append("、".join(req_subjects))
    if req_grades:
        label_parts.append("、".join(req_grades))
    if req_classes:
        label_parts.append("、".join(req_classes))
    elif class_count > 1:
        label_parts.append(f"{class_count} 个班")

    class_tokens: set[str] = set()
    for p in pairs:
        class_tokens |= _class_tokens(p["class_display"], p["class_name"])

    return {
        "role": role,
        "is_admin": role == 0,
        "owner": owner,
        "scope_key": f"f:{digest}",
        "filter": requested_payload,
        "filter_label": " · ".join(label_parts) or "全部任教范围",
        "subjects": req_subjects,
        "subject_variants": sorted(subject_variants),
        "own_subjects": own_subjects,
        "grade_ids": sorted({int(p["grade_id"]) for p in pairs}),
        "grade_names": sorted({p["grade_name"] for p in pairs}),
        "class_ids": sorted({int(p["class_id"]) for p in pairs}),
        "class_displays": sorted({p["class_display"] for p in pairs}),
        "class_tokens": class_tokens,
        "pairs": [{"grade_id": p["grade_id"], "class_id": p["class_id"],
                   "class_display": p["class_display"]} for p in pairs],
        "students": students,
        "student_usernames": sorted(students.keys()),
        "total_students": len(students),
    }


def _match_target(row: dict[str, Any], scope: dict[str, Any]) -> bool | None:
    """活动目标范围是否命中本简报范围。None=旧数据未填，需按参与者回退。"""
    ts = _txt(row.get("target_scope")).lower()
    if ts in ("all", "school"):
        return True
    grades = _split_multi(row.get("target_grade"))
    classes = _split_multi(row.get("target_class"))
    users = _split_multi(row.get("target_users"))
    if not grades and not classes and not users:
        return None
    if grades and not (set(grades) & set(scope["grade_names"])):
        return False
    if classes:
        wanted: set[str] = set()
        for c in classes:
            wanted |= _class_tokens(c)
        if not (wanted & scope["class_tokens"]):
            return False
    if users:
        if not (set(users) & set(scope["students"].keys())):
            return False
    return True


# ══════════════════════════════════════════════════════════════
# 活动与样本采集
# ══════════════════════════════════════════════════════════════

def _owner_sql(scope: dict[str, Any], alias: str = "") -> tuple[str, list[Any]]:
    """教师固定按创建者收敛；管理员未指定教师时不加条件。"""
    if scope["role"] != 0 or scope["owner"]:
        col = f"{alias}.creator_username" if alias else "creator_username"
        return f" AND {col}=?", [scope["owner"]]
    return "", []


def _subject_sql(scope: dict[str, Any], alias: str = "") -> tuple[str, list[Any]]:
    values = scope.get("subject_variants") or scope["subjects"]
    if not values:
        return "", []
    col = f"{alias}.subject" if alias else "subject"
    ph = ",".join("?" for _ in values)
    return f" AND COALESCE({col},'') IN ({ph})", list(values)


def _collect_activities(scope: dict[str, Any], period: dict[str, Any]) -> dict[str, Any]:
    t0, t1 = period["start"], period["end"]
    owner_sql, owner_params = _owner_sql(scope)
    subj_sql, subj_params = _subject_sql(scope)

    specs: list[tuple[str, str, str]] = [
        # (类型, 库, SQL)
        ("exam", "q", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users "
                      "FROM exams WHERE created_at BETWEEN ? AND ? AND status IN ('published','ended')"),
        ("quiz", "s", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users "
                      "FROM interaction_quizzes WHERE created_at BETWEEN ? AND ? AND status IN ('active','ended')"),
        ("poll", "s", "SELECT id, question AS title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users "
                      "FROM interaction_polls WHERE created_at BETWEEN ? AND ? AND COALESCE(status,'active')!='draft'"),
        ("discussion", "s", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users "
                            "FROM discussions WHERE created_at BETWEEN ? AND ?"),
        ("task", "s", "SELECT id, name AS title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users "
                      "FROM tasks WHERE created_at BETWEEN ? AND ?"),
        ("practice", "q", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users "
                          "FROM practice_sessions WHERE created_at BETWEEN ? AND ?"),
        ("code", "q", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users "
                      "FROM code_problems WHERE created_at BETWEEN ? AND ?"),
        ("quick_quiz", "s", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users "
                            "FROM quick_quiz_rooms WHERE created_at BETWEEN ? AND ?"),
        ("homework", "q", "SELECT id, title, subject, creator_username, created_at, '' AS target_scope, target_grade, target_class, '' AS target_users "
                          "FROM homework_assignments WHERE created_at BETWEEN ? AND ?"),
    ]

    items: list[dict[str, Any]] = []
    seen: set[tuple[str, Any]] = set()

    def _append(kind: str, r: dict[str, Any], carried: bool = False) -> None:
        matched = _match_target(r, scope)
        if matched is False:
            return
        key = (kind, str(r.get("id")))
        if key in seen:
            return
        seen.add(key)
        items.append({
            "type": kind, "id": r.get("id"), "title": _txt(r.get("title")),
            "subject": _txt(r.get("subject")), "created_at": _txt(r.get("created_at")),
            "target_scope": _txt(r.get("target_scope")),
            "target_grade": _txt(r.get("target_grade")),
            "target_class": _txt(r.get("target_class")),
            "target_users": _txt(r.get("target_users")),
            "matched": matched, "carried": carried,
        })

    def _pass_common(r: dict[str, Any]) -> bool:
        if (scope["role"] != 0 or scope["owner"]) and _txt(r.get("creator_username")) != scope["owner"]:
            return False
        variants = scope.get("subject_variants") or scope["subjects"]
        if variants and _txt(r.get("subject")) not in variants:
            return False
        return True

    for kind, db, sql in specs:
        params: list[Any] = [t0, t1]
        q = sql + owner_sql + subj_sql
        params += owner_params + subj_params
        try:
            rows = q_execute_query(q, tuple(params)) if db == "q" else execute_query_dict(q, tuple(params))
        except Exception as exc:  # noqa: BLE001 - 单类活动失败不影响整份简报
            logger.warning(f"[briefing] 采集 {kind} 失败: {exc}")
            continue
        for r in rows or []:
            _append(kind, r)

    # ── 补采「本期发生但不在本期创建」的活动（上周建的测验本周才做）──
    # 只看本范围学生是否真的参与过；仅其他班/教师侧的动作不把活动带进来。
    carry_sql: dict[str, tuple[str, str]] = {
        "exam": ("q", "SELECT DISTINCT exam_id AS id, student_username FROM exam_attempts WHERE submitted_at BETWEEN ? AND ?"),
        "quiz": ("s", "SELECT DISTINCT quiz_id AS id, student_username FROM interaction_quiz_answers WHERE submitted_at BETWEEN ? AND ?"),
        "poll": ("s", "SELECT DISTINCT poll_id AS id, student_username FROM interaction_poll_votes WHERE created_at BETWEEN ? AND ?"),
        "task": ("s", "SELECT DISTINCT task_id AS id, student_username FROM task_submissions WHERE submitted_at BETWEEN ? AND ?"),
        "practice": ("q", "SELECT DISTINCT session_id AS id, student_username FROM practice_attempts WHERE submitted_at BETWEEN ? AND ?"),
        "discussion": ("s", "SELECT DISTINCT g.discussion_id AS id, m.username AS student_username "
                            "FROM discussion_groups g JOIN discussion_messages m ON m.group_id=g.id "
                            "WHERE m.created_at BETWEEN ? AND ?"),
        "quick_quiz": ("s", "SELECT DISTINCT room_id AS id, student_username FROM quick_quiz_players WHERE joined_at BETWEEN ? AND ?"),
    }
    load_sql: dict[str, tuple[str, str]] = {
        "exam": ("q", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users FROM exams WHERE id IN ({ph})"),
        "quiz": ("s", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users FROM interaction_quizzes WHERE id IN ({ph})"),
        "poll": ("s", "SELECT id, question AS title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users FROM interaction_polls WHERE id IN ({ph})"),
        "task": ("s", "SELECT id, name AS title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users FROM tasks WHERE id IN ({ph})"),
        "practice": ("q", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users FROM practice_sessions WHERE id IN ({ph})"),
        "discussion": ("s", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users FROM discussions WHERE id IN ({ph})"),
        "quick_quiz": ("s", "SELECT id, title, subject, creator_username, created_at, target_scope, target_grade, target_class, target_users FROM quick_quiz_rooms WHERE id IN ({ph})"),
    }
    scoped_students = set(scope["students"].keys())
    for kind, (db, sql) in carry_sql.items():
        try:
            rows = q_execute_query(sql, (t0, t1)) if db == "q" else execute_query_dict(sql, (t0, t1))
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[briefing] 补采 {kind} 失败: {exc}")
            continue
        extra_ids = sorted({
            r["id"] for r in (rows or [])
            if _txt(r.get("student_username")) in scoped_students
            and (kind, str(r["id"])) not in seen
        }, key=str)
        if not extra_ids or kind not in load_sql:
            continue
        ldb, lsql = load_sql[kind]
        for chunk in _chunk_params(extra_ids):
            ph = ",".join("?" for _ in chunk)
            try:
                load_rows = (q_execute_query(lsql.format(ph=ph), tuple(chunk)) if ldb == "q"
                             else execute_query_dict(lsql.format(ph=ph), tuple(chunk)))
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[briefing] 载入 {kind} 失败: {exc}")
                continue
            for r in load_rows or []:
                if _pass_common(r):
                    _append(kind, r, carried=True)

    by_type: dict[str, int] = {}
    for it in items:
        by_type[it["type"]] = by_type.get(it["type"], 0) + 1
    return {"total": len(items), "by_type": by_type, "items": items}


def _ids(items: list[dict[str, Any]], kind: str) -> list[Any]:
    return [it["id"] for it in items if it["type"] == kind]


def _chunk_params(ids: list[Any], size: int = 400) -> list[list[Any]]:
    return [ids[i:i + size] for i in range(0, len(ids), size)]


def _collect_samples(scope: dict[str, Any], period: dict[str, Any],
                     activities: dict[str, Any]) -> list[dict[str, Any]]:
    """统一"学生×活动"得分样本。rate 一律百分制。"""
    t0, t1 = period["start"], period["end"]
    students = scope["students"]
    items = activities["items"]
    samples: list[dict[str, Any]] = []

    def _add(uname: str, source: str, rate: float | None, aid: Any, at: str) -> None:
        if rate is None or uname not in students:
            return
        samples.append({"username": uname, "source": source, "rate": rate,
                        "activity_id": aid, "at": at,
                        "class": students[uname]["class"]})

    # ── 考试 ──
    for chunk in _chunk_params(_ids(items, "exam")):
        ph = ",".join("?" for _ in chunk)
        rows = q_execute_query(
            f"SELECT exam_id, student_username, score, total_score, teacher_score, submitted_at "
            f"FROM exam_attempts WHERE exam_id IN ({ph}) AND submitted_at BETWEEN ? AND ? "
            f"AND status IN ('submitted','graded')",
            tuple(chunk) + (t0, t1),
        )
        for r in rows:
            ts = r.get("teacher_score")
            score = float(ts) if ts is not None and float(ts) >= 0 else float(r.get("score") or 0)
            _add(_txt(r["student_username"]), "exam", _rate(score, r.get("total_score")),
                 r["exam_id"], _txt(r.get("submitted_at")))

    # ── 随堂测验 ──
    quiz_map = {it["id"]: it for it in items if it["type"] == "quiz"}
    if quiz_map:
        quiz_rows = execute_query_dict(
            f"SELECT id, questions FROM interaction_quizzes WHERE id IN "
            f"({','.join('?' for _ in quiz_map)})", tuple(quiz_map.keys())
        )
        totals = {int(r["id"]): quiz_total(quiz_questions(r)) for r in quiz_rows}
        for chunk in _chunk_params(list(quiz_map.keys())):
            ph = ",".join("?" for _ in chunk)
            rows = execute_query_dict(
                f"SELECT quiz_id, student_username, score, submitted_at FROM interaction_quiz_answers "
                f"WHERE quiz_id IN ({ph}) AND submitted_at BETWEEN ? AND ?",
                tuple(chunk) + (t0, t1),
            )
            for r in rows:
                _add(_txt(r["student_username"]), "quiz",
                     centesimal(r.get("score"), totals.get(int(r["quiz_id"]))),
                     r["quiz_id"], _txt(r.get("submitted_at")))

    # ── 同步练习 ──
    for chunk in _chunk_params(_ids(items, "practice")):
        ph = ",".join("?" for _ in chunk)
        rows = q_execute_query(
            f"SELECT session_id, student_username, score, total_score, teacher_score, submitted_at "
            f"FROM practice_attempts WHERE session_id IN ({ph}) AND submitted_at BETWEEN ? AND ? "
            f"AND status IN ('submitted','graded')",
            tuple(chunk) + (t0, t1),
        )
        for r in rows:
            ts = r.get("teacher_score")
            score = float(ts) if ts is not None and float(ts) >= 0 else float(r.get("score") or 0)
            _add(_txt(r["student_username"]), "practice", _rate(score, r.get("total_score")),
                 r["session_id"], _txt(r.get("submitted_at")))

    # ── 代码练习 ──
    for chunk in _chunk_params(_ids(items, "code")):
        ph = ",".join("?" for _ in chunk)
        rows = q_execute_query(
            f"SELECT problem_id, student_username, score, max_score, created_at "
            f"FROM code_submissions WHERE problem_id IN ({ph}) AND created_at BETWEEN ? AND ?",
            tuple(chunk) + (t0, t1),
        )
        for r in rows:
            _add(_txt(r["student_username"]), "code", _rate(r.get("score"), r.get("max_score")),
                 r["problem_id"], _txt(r.get("created_at")))

    # ── 任务：成绩来自 task_grades ──
    task_items = [it for it in items if it["type"] == "task"]
    if task_items:
        task_ids = [it["id"] for it in task_items]
        task_rows = execute_query_dict(
            f"SELECT id, total_score FROM tasks WHERE id IN ({','.join('?' for _ in task_ids)})",
            tuple(task_ids),
        )
        task_totals = {_txt(r["id"]): float(r.get("total_score") or 100) for r in task_rows}
        grade_rows: dict[tuple[str, str], dict[str, Any]] = {}
        for chunk in _chunk_params(task_ids):
            ph = ",".join("?" for _ in chunk)
            for r in execute_query_dict(
                f"SELECT task_id, student_username, ai_score, teacher_score FROM task_grades "
                f"WHERE task_id IN ({ph})", tuple(chunk)
            ):
                grade_rows[(_txt(r["task_id"]), _txt(r["student_username"]))] = r
        for chunk in _chunk_params(task_ids):
            ph = ",".join("?" for _ in chunk)
            rows = execute_query_dict(
                f"SELECT task_id, student_username, submitted_at FROM task_submissions "
                f"WHERE task_id IN ({ph}) AND submitted_at BETWEEN ? AND ?",
                tuple(chunk) + (t0, t1),
            )
            for r in rows:
                tid, uname = _txt(r["task_id"]), _txt(r["student_username"])
                g = grade_rows.get((tid, uname)) or {}
                score = g.get("teacher_score")
                if score is None:
                    score = g.get("ai_score")
                _add(uname, "task", _rate(score, task_totals.get(tid, 100)),
                     tid, _txt(r.get("submitted_at")))

    # 口径 M2：同一学生同一活动多次作答取最优，避免重复计数
    best: dict[tuple[str, str, str], dict[str, Any]] = {}
    for s in samples:
        key = (s["source"], str(s["activity_id"]), s["username"])
        if key not in best or s["rate"] > best[key]["rate"]:
            best[key] = s
    return list(best.values())


def _student_rates(samples: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    bucket: dict[str, list[float]] = {}
    for s in samples:
        bucket.setdefault(s["username"], []).append(s["rate"])
    return {u: {"rate": _mean(v), "samples": len(v)} for u, v in bucket.items()}


def _collect_participation(scope: dict[str, Any], period: dict[str, Any],
                           activities: dict[str, Any], samples: list[dict[str, Any]]) -> dict[str, Any]:
    t0, t1 = period["start"], period["end"]
    students = set(scope["students"].keys())
    counts: dict[str, int] = {}
    kinds: dict[str, dict[str, int]] = {}

    def _hit(uname: str, kind: str, n: int = 1) -> None:
        u = _txt(uname)
        if u not in students:
            return
        counts[u] = counts.get(u, 0) + n
        kinds.setdefault(kind, {})[u] = kinds.setdefault(kind, {}).get(u, 0) + n

    for s in samples:
        if s["source"] == "task":
            continue    # 任务单独按「提交」计一次，避免已评分的重复 +1
        _hit(s["username"], s["source"])

    items = activities["items"]

    # 投票
    for chunk in _chunk_params(_ids(items, "poll")):
        ph = ",".join("?" for _ in chunk)
        for r in execute_query_dict(
            f"SELECT poll_id, student_username FROM interaction_poll_votes "
            f"WHERE poll_id IN ({ph}) AND created_at BETWEEN ? AND ?",
            tuple(chunk) + (t0, t1),
        ):
            _hit(r["student_username"], "poll")

    # 学生提问（带 grade_id/class_id 快照）
    for r in execute_query_dict(
        "SELECT student_username, grade_id, class_id FROM interaction_questions "
        "WHERE created_at BETWEEN ? AND ?", (t0, t1)
    ):
        u = _txt(r["student_username"])
        in_scope = (u in students) or (
            r.get("grade_id") in scope["grade_ids"] and r.get("class_id") in scope["class_ids"]
        )
        if in_scope:
            _hit(u, "question")

    # 讨论成员与消息
    for chunk in _chunk_params(_ids(items, "discussion")):
        ph = ",".join("?" for _ in chunk)
        for r in execute_query_dict(
            f"SELECT g.discussion_id, m.username FROM discussion_groups g "
            f"JOIN discussion_members m ON m.group_id=g.id WHERE g.discussion_id IN ({ph})",
            tuple(chunk),
        ):
            _hit(r["username"], "discussion")
        for r in execute_query_dict(
            f"SELECT g.discussion_id, m.username, COUNT(*) AS n FROM discussion_groups g "
            f"JOIN discussion_messages m ON m.group_id=g.id "
            f"WHERE g.discussion_id IN ({ph}) GROUP BY m.username",
            tuple(chunk),
        ):
            u = _txt(r["username"])
            if u in students:
                _hit(u, "discussion_msg", int(r["n"] or 0))

    # 抢答
    for chunk in _chunk_params(_ids(items, "quick_quiz")):
        ph = ",".join("?" for _ in chunk)
        for r in execute_query_dict(
            f"SELECT student_username, correct_count FROM quick_quiz_players WHERE room_id IN ({ph})",
            tuple(chunk),
        ):
            u = _txt(r["student_username"])
            if u in students:
                _hit(u, "quick_quiz")
                bucket = kinds.setdefault("quick_quiz_correct", {})
                bucket[u] = bucket.get(u, 0) + int(r.get("correct_count") or 0)

    # 任务提交（含未评分）
    for chunk in _chunk_params(_ids(items, "task")):
        ph = ",".join("?" for _ in chunk)
        for r in execute_query_dict(
            f"SELECT student_username FROM task_submissions WHERE task_id IN ({ph}) "
            f"AND submitted_at BETWEEN ? AND ?", tuple(chunk) + (t0, t1)
        ):
            _hit(r["student_username"], "task")

    participants = sorted(counts.keys())
    activity_counts: dict[str, int] = {}
    for per_user in kinds.values():
        for u, n in per_user.items():
            activity_counts[u] = activity_counts.get(u, 0) + n

    return {
        "participants": len(participants),
        "rate": _pct(len(participants), scope["total_students"]),
        "activity_counts": activity_counts,
        "silent": [scope["students"][u] for u in scope["student_usernames"] if u not in counts],
        "counts": counts,
        "kinds": kinds,
    }


def _collect_class_breakdown(scope: dict[str, Any], period: dict[str, Any],
                             samples: list[dict[str, Any]], participation: dict[str, Any],
                             extras: dict[str, Any]) -> list[dict[str, Any]]:
    by_class: dict[str, dict[str, Any]] = {}
    for uname, info in scope["students"].items():
        c = info["class"]
        row = by_class.setdefault(c, {"class": c, "students": 0, "participants": 0,
                                      "rates": [], "points": 0, "questions": 0, "messages": 0})
        row["students"] += 1
    for s in samples:
        by_class.setdefault(s["class"], {"class": s["class"], "students": 0, "participants": 0,
                                         "rates": [], "points": 0, "questions": 0, "messages": 0})
        by_class[s["class"]]["rates"].append(s["rate"])
    for uname, n in participation["counts"].items():
        c = scope["students"][uname]["class"]
        by_class[c]["participants"] += 1
    for uname, p in extras["points_by_student"].items():
        if uname in scope["students"]:
            by_class[scope["students"][uname]["class"]]["points"] += p
    for uname, n in extras["questions_by_student"].items():
        if uname in scope["students"]:
            by_class[scope["students"][uname]["class"]]["questions"] += n
    for uname, n in extras["messages_by_student"].items():
        if uname in scope["students"]:
            by_class[scope["students"][uname]["class"]]["messages"] += n

    out: list[dict[str, Any]] = []
    for c, r in by_class.items():
        rates = r.pop("rates")
        r["avg_rate"] = _mean(rates) if len(rates) >= MIN_SAMPLE else None
        r["samples"] = len(rates)
        r["participation_rate"] = _pct(r["participants"], r["students"])
        r["rate"] = r["avg_rate"]
        out.append(r)
    out.sort(key=lambda x: x["class"])
    return out


# ══════════════════════════════════════════════════════════════
# 补充维度：积分、提问、发言、作业守时、错题、资源、闯关
# ══════════════════════════════════════════════════════════════

def _collect_extras(scope: dict[str, Any], period: dict[str, Any],
                    activities: dict[str, Any]) -> dict[str, Any]:
    t0, t1 = period["start"], period["end"]
    students = set(scope["students"].keys())

    points: dict[str, int] = {}
    for r in execute_query_dict(
        "SELECT student_username, SUM(points) AS p FROM score_logs "
        "WHERE created_at BETWEEN ? AND ? AND undone=0 GROUP BY student_username", (t0, t1)
    ):
        u = _txt(r["student_username"])
        if u in students:
            points[u] = int(r.get("p") or 0)

    questions: dict[str, int] = {}
    for r in execute_query_dict(
        "SELECT student_username, COUNT(*) AS n FROM interaction_questions "
        "WHERE created_at BETWEEN ? AND ? GROUP BY student_username", (t0, t1)
    ):
        u = _txt(r["student_username"])
        if u in students:
            questions[u] = int(r.get("n") or 0)

    messages: dict[str, int] = {}
    disc_ids = _ids(activities["items"], "discussion")
    for chunk in _chunk_params(disc_ids):
        ph = ",".join("?" for _ in chunk)
        for r in execute_query_dict(
            f"SELECT m.username, COUNT(*) AS n FROM discussion_groups g "
            f"JOIN discussion_messages m ON m.group_id=g.id "
            f"WHERE g.discussion_id IN ({ph}) GROUP BY m.username", tuple(chunk)
        ):
            u = _txt(r["username"])
            if u in students:
                messages[u] = messages.get(u, 0) + int(r.get("n") or 0)

    # 任务提交：按学生统计 应提交/已提交/迟交
    task_stats: dict[str, dict[str, int]] = {}
    task_items = [it for it in activities["items"] if it["type"] == "task"]
    if task_items:
        tids = [it["id"] for it in task_items]
        deadlines: dict[str, str] = {}
        for chunk in _chunk_params(tids):
            ph = ",".join("?" for _ in chunk)
            for r in execute_query_dict(
                f"SELECT id, deadline_at FROM tasks WHERE id IN ({ph})", tuple(chunk)
            ):
                deadlines[_txt(r["id"])] = _txt(r.get("deadline_at"))
        for chunk in _chunk_params(tids):
            ph = ",".join("?" for _ in chunk)
            for r in execute_query_dict(
                f"SELECT task_id, student_username, submitted_at FROM task_submissions "
                f"WHERE task_id IN ({ph})", tuple(chunk)
            ):
                u = _txt(r["student_username"])
                if u not in students:
                    continue
                row = task_stats.setdefault(u, {"submitted": 0, "late": 0})
                row["submitted"] += 1
                dl = _dt(deadlines.get(_txt(r["task_id"])))
                st = _dt(r.get("submitted_at"))
                if dl and st and st > dl:
                    row["late"] += 1

    # 错题订正：本期标记掌握的题数
    mastered: dict[str, int] = {}
    for r in execute_query_dict(
        "SELECT student_username, COUNT(*) AS n FROM wrong_book "
        "WHERE mastered_at BETWEEN ? AND ? GROUP BY student_username", (t0, t1)
    ):
        u = _txt(r["student_username"])
        if u in students:
            mastered[u] = int(r.get("n") or 0)

    # 资源浏览
    views: dict[str, int] = {}
    for r in execute_query_dict(
        "SELECT student_username, COUNT(*) AS n FROM resource_view_logs "
        "WHERE viewed_at BETWEEN ? AND ? GROUP BY student_username", (t0, t1)
    ):
        u = _txt(r["student_username"])
        if u in students:
            views[u] = int(r.get("n") or 0)

    # 知识闯关：本期最好一次的正确率
    quest: dict[str, float] = {}
    for r in execute_query_dict(
        "SELECT student_username, total_questions, correct_count FROM quest_records "
        "WHERE created_at BETWEEN ? AND ?", (t0, t1)
    ):
        u = _txt(r["student_username"])
        if u not in students:
            continue
        rate = _rate(r.get("correct_count"), r.get("total_questions"))
        if rate is not None and rate > quest.get(u, -1):
            quest[u] = rate

    # 平台称号/徽章晋升（title_system 产生，不是简报表扬）
    titles_by_student: dict[str, list[dict[str, str]]] = {}
    try:
        for r in execute_query_dict(
            "SELECT student_username, new_title, title_type, subject FROM title_upgrade_history "
            "WHERE created_at BETWEEN ? AND ?", (t0, t1)
        ):
            u = _txt(r["student_username"])
            if u in students:
                titles_by_student.setdefault(u, []).append({
                    "title": _txt(r["new_title"]),
                    "type": _txt(r.get("title_type")),
                    "subject": _txt(r.get("subject")),
                })
    except Exception as exc:  # noqa: BLE001 - 老库没有该表时不影响简报
        logger.debug(f"[briefing] 称号升级读取失败: {exc}")

    return {
        "titles_by_student": titles_by_student,
        "points_by_student": points,
        "questions_by_student": questions,
        "messages_by_student": messages,
        "task_by_student": task_stats,
        "mastered_by_student": mastered,
        "views_by_student": views,
        "quest_rate_by_student": quest,
    }


# ══════════════════════════════════════════════════════════════
# 指标聚合
# ══════════════════════════════════════════════════════════════

def _period_trend(samples: list[dict[str, Any]], period: dict[str, Any]) -> dict[str, Any] | None:
    """周期内走势：月报按「7 天一段」，年报按「月」。

    每个点至少 3 人次才画，避免单人道听途说的一条线。
    """
    ptype = period.get("type")
    if ptype not in ("month", "year"):
        return None
    buckets: dict[int, dict[str, Any]] = {}
    for s in samples:
        dt = _dt(s.get("at"))
        if not dt:
            continue
        if ptype == "month":
            idx = (dt.day - 1) // 7
            start_day = idx * 7 + 1
            end_day = min(start_day + 6, calendar.monthrange(dt.year, dt.month)[1])
            order, name = idx, f"{dt.month}.{start_day}–{end_day}"
        else:
            # 学年跨年（9 月 → 次年 8 月），必须按相对起始月份排序，不能按 1–12 月
            s0 = _anchor_of(period["start_date"])
            order = (dt.year - s0.year) * 12 + (dt.month - s0.month)
            name = f"{dt.month}月"
        row = buckets.setdefault(order, {"name": name, "vals": []})
        row["vals"].append(s["rate"])
    points = [
        {"name": v["name"], "value": _mean(v["vals"]), "samples": len(v["vals"])}
        for _, v in sorted(buckets.items()) if len(v["vals"]) >= 3
    ]
    if len(points) < 2:
        return None
    return {"granularity": "week" if ptype == "month" else "month", "points": points}


_TITLE_TYPE_LABELS = {"main": "主称号", "subject": "学科称号", "badge": "徽章"}


def _title_summary(scope: dict[str, Any],
                   by_student: dict[str, list[dict[str, str]]]) -> dict[str, Any]:
    """平台称号/徽章晋升汇总（成长维度，不参与表扬评选）。"""
    events = 0
    counter: dict[str, int] = {}
    recent: list[dict[str, str]] = []
    seen_events: set[tuple[str, str, str, str]] = set()
    seen_recent: set[tuple[str, str]] = set()
    for uname, items in by_student.items():
        info = scope["students"].get(uname) or {}
        for it in items:
            title = it.get("title") or ""
            if not title:
                continue
            key = (uname, title, it.get("type", ""), it.get("subject", ""))
            if key in seen_events:
                continue
            seen_events.add(key)
            events += 1
            counter[title] = counter.get(title, 0) + 1
            if len(recent) < 8 and (uname, title) not in seen_recent:
                seen_recent.add((uname, title))
                recent.append({"name": _txt(info.get("name")) or uname,
                               "class": _txt(info.get("class")), "title": title,
                               "type": _TITLE_TYPE_LABELS.get(it.get("type", ""), "称号")})
    top = sorted(counter.items(), key=lambda kv: -kv[1])[:5]
    return {"upgrades": events, "students": len(by_student),
            "by_title": [{"title": k, "count": v} for k, v in top], "recent": recent}


def _aggregate_learning(samples: list[dict[str, Any]], prev: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    rates = [s["rate"] for s in samples]
    n = len(rates)
    by_source: dict[str, dict[str, Any]] = {}
    for s in samples:
        row = by_source.setdefault(s["source"], {"samples": 0, "rates": []})
        row["samples"] += 1
        row["rates"].append(s["rate"])
    by_source_out = {
        k: {"samples": v["samples"], "avg_rate": _mean(v["rates"])}
        for k, v in by_source.items()
    }

    def _bucket(rs: list[float]) -> dict[str, int]:
        return {
            "excellent": sum(1 for r in rs if r >= EXCELLENT_LINE),
            "good": sum(1 for r in rs if 70 <= r < EXCELLENT_LINE),
            "pass": sum(1 for r in rs if PASS_RATE_LINE <= r < 70),
            "fail": sum(1 for r in rs if r < PASS_RATE_LINE),
        }

    avg = _mean(rates)
    prev_avg = _mean([s["rate"] for s in prev]) if prev else None
    enough = n >= MIN_SAMPLE
    # 口径 M3：样本不足不对外给比率，只给样本数。
    return {
        "samples": n,
        "avg_rate": avg if enough else None,
        "pass_rate": _pct(sum(1 for r in rates if r >= PASS_RATE_LINE), n) if enough else None,
        "excellent_rate": _pct(sum(1 for r in rates if r >= EXCELLENT_LINE), n) if enough else None,
        "distribution": _bucket(rates) if enough else {},
        "by_source": by_source_out,
        "delta": (round(avg - prev_avg, 1) if avg is not None and prev_avg is not None
                  and enough and len(prev) >= MIN_SAMPLE else None),
        "enough_sample": enough,
    }


def _resolve_kp(qid: str, question: dict[str, Any] | None,
                qid_to_kp: dict[str, str], quiz_kps: list[str]) -> str:
    """确定一道题归属的知识点；无法唯一确定时返回空串（不硬塞）。

    优先级：题库映射 → 题目自带知识点 → 整卷只标了 1 个知识点时才沿用整卷。
    整卷标了多个知识点时不猜，计入"未关联"，避免把整卷都算到第一个知识点上。
    """
    if qid and qid_to_kp.get(qid):
        return qid_to_kp[qid]
    if isinstance(question, dict):
        own = _split_multi(question.get("knowledge_points"))
        if own:
            return own[0]
    if len(quiz_kps) == 1:
        return quiz_kps[0]
    return ""


def _weak_points(scope: dict[str, Any], period: dict[str, Any],
                 activities: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """知识点正确率：逐题 graded 留痕 + 题库映射。

    返回 (薄弱点列表, 数据质量统计)。统计里记录"未关联知识点的作答数"，
    这部分不进入正确率，避免污染知识点排名。
    """
    quiz_items = [it for it in activities["items"] if it["type"] == "quiz"]
    if not quiz_items:
        return [], {"answers": 0, "unmapped": 0}
    quiz_ids = [it["id"] for it in quiz_items]
    rows = execute_query_dict(
        f"SELECT id, questions, knowledge_points FROM interaction_quizzes "
        f"WHERE id IN ({','.join('?' for _ in quiz_ids)})", tuple(quiz_ids)
    )
    qinfo = {int(r["id"]): r for r in rows}

    answers: list[dict[str, Any]] = []
    for chunk in _chunk_params(quiz_ids):
        ph = ",".join("?" for _ in chunk)
        answers += [
            a for a in execute_query_dict(
                f"SELECT quiz_id, student_username, graded FROM interaction_quiz_answers "
                f"WHERE quiz_id IN ({ph}) AND submitted_at BETWEEN ? AND ?",
                tuple(chunk) + (period["start"], period["end"]))
            if _txt(a.get("student_username")) in scope["students"]
        ]

    qid_to_kp: dict[str, str] = {}
    all_qids: list[str] = []
    idx_questions: dict[int, list[dict[str, Any] | None]] = {}
    idx_qids: dict[int, list[str]] = {}
    for qid, info in qinfo.items():
        qs = quiz_questions(info)
        qids: list[str] = []
        questions: list[dict[str, Any] | None] = []
        for q in qs:
            raw = q.get("id") if isinstance(q, dict) else None
            qids.append(str(raw) if raw is not None else "")
            questions.append(q if isinstance(q, dict) else None)
            if raw is not None:
                all_qids.append(str(raw))
        idx_qids[qid] = qids
        idx_questions[qid] = questions

    if all_qids:
        try:
            for chunk in _chunk_params(list(dict.fromkeys(all_qids)), 300):
                ph = ",".join("?" for _ in chunk)
                for r in q_execute_query(
                    f"SELECT question_id, kp_name FROM question_kp_map WHERE question_id IN ({ph})",
                    tuple(chunk),
                ):
                    qid_to_kp[_txt(r["question_id"])] = _txt(r["kp_name"])
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[briefing] 知识点映射查询失败: {exc}")

    kp_stat: dict[str, dict[str, int]] = {}
    total_answers = 0
    unmapped = 0
    for a in answers:
        qid = int(a["quiz_id"])
        qids = idx_qids.get(qid) or []
        questions = idx_questions.get(qid) or []
        quiz_kps = _split_multi(qinfo.get(qid, {}).get("knowledge_points"))
        graded = quiz_graded(a.get("graded"))
        for key, g in graded.items():
            if not isinstance(g, dict):
                continue
            try:
                idx = int(key)
            except (TypeError, ValueError):
                continue
            total_answers += 1
            qid_str = qids[idx] if 0 <= idx < len(qids) else ""
            q_obj = questions[idx] if 0 <= idx < len(questions) else None
            kp = _resolve_kp(qid_str, q_obj, qid_to_kp, quiz_kps)
            if not kp:
                unmapped += 1
                continue
            row = kp_stat.setdefault(kp, {"correct": 0, "total": 0})
            row["total"] += 1
            if g.get("is_correct"):
                row["correct"] += 1

    out = []
    for kp, v in kp_stat.items():
        if v["total"] < MIN_KP_ANSWERS:
            continue
        out.append({"kp": kp, "correct": v["correct"], "total": v["total"],
                    "rate": _pct(v["correct"], v["total"])})
    out.sort(key=lambda x: (x["rate"] if x["rate"] is not None else 100, -x["total"]))
    return out, {"answers": total_answers, "unmapped": unmapped}


def _pending_grading(scope: dict[str, Any]) -> int:
    """待批改是「当前积压」，不是本期新增：按创建者 + 学科收敛，绝不统计全站。"""
    owner_scoped = scope["role"] != 0 or bool(scope["owner"])
    variants = scope.get("subject_variants") or scope["subjects"]
    total = 0
    specs = [
        ("s", "SELECT COUNT(*) AS n FROM task_grades g JOIN tasks t ON g.task_id=t.id "
              "WHERE COALESCE(g.teacher_score, g.ai_score) IS NULL",
         "t.creator_username", "t.subject"),
        ("q", "SELECT COUNT(*) AS n FROM exam_attempts a JOIN exams e ON a.exam_id=e.id "
              "WHERE a.ai_pending=1",
         "e.creator_username", "e.subject"),
        ("q", "SELECT COUNT(*) AS n FROM practice_attempts a JOIN practice_sessions p ON a.session_id=p.id "
              "WHERE a.ai_pending=1",
         "p.creator_username", "p.subject"),
    ]
    for db, sql, col_owner, col_subject in specs:
        params: list[Any] = []
        if owner_scoped and scope["owner"]:
            sql += f" AND {col_owner}=?"
            params.append(scope["owner"])
        if variants:
            ph = ",".join("?" for _ in variants)
            sql += f" AND COALESCE({col_subject},'') IN ({ph})"
            params += list(variants)
        try:
            rows = q_execute_query(sql, tuple(params)) if db == "q" else execute_query_dict(sql, tuple(params))
            total += int((rows[0] or {}).get("n") or 0) if rows else 0
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[briefing] 待批改统计失败: {exc}")
    return total


def _task_metrics(scope: dict[str, Any], activities: dict[str, Any],
                  extras: dict[str, Any]) -> dict[str, Any]:
    task_items = [it for it in activities["items"] if it["type"] == "task"]
    submitted = sum(v["submitted"] for v in extras["task_by_student"].values())
    late = sum(v["late"] for v in extras["task_by_student"].values())

    pending = _pending_grading(scope)

    expected_set: set[str] = set()
    for it in task_items:
        ts = _txt(it.get("target_scope")).lower()
        if ts in ("all", "school"):
            expected_set |= set(scope["students"].keys())
            continue
        tokens: set[str] = set()
        for c in _split_multi(it.get("target_class")):
            tokens |= _class_tokens(c)
        if tokens:
            expected_set |= {u for u, info in scope["students"].items()
                             if _class_tokens(info["class"], info.get("class_short", "")) & tokens}
        else:
            expected_set |= set(scope["students"].keys())
    expected = max(len(expected_set), 1)
    return {
        "assigned": len(task_items),
        "submitted": submitted,
        "submit_rate": _pct(len(extras["task_by_student"]), expected),
        "late": late,
        "on_time_rate": _pct(submitted - late, submitted) if submitted else None,
        "pending_grading": pending,
    }


# ══════════════════════════════════════════════════════════════
# 表扬评选（14 类学生 + 8 类班级，规则驱动）
# ══════════════════════════════════════════════════════════════

def _stu(scope: dict[str, Any], uname: str) -> dict[str, str]:
    info = scope["students"].get(uname) or {}
    return {"username": uname, "name": _txt(info.get("name")) or uname,
            "class": _txt(info.get("class"))}


def _cand(scope: dict[str, Any], uname: str, title: str, group: str,
          reason: str, metric: str, value: float, weight: float) -> dict[str, Any]:
    base = _stu(scope, uname)
    return {**base, "title": title, "group": group, "reason": reason,
            "metric": metric, "value": round(float(value), 1), "weight": weight}


# ══════════════════════════════════════════════════════════════
# 表扬称号注册表
#   新增称号 = 往注册表加一行；只有"全新的判定方式"才需要加一个 builder。
# ══════════════════════════════════════════════════════════════

# 学生称号的指标来源：metric 名 → ctx 取数函数
STUDENT_METRICS: dict[str, Any] = {
    "questions": lambda ctx: ctx["extras"]["questions_by_student"],
    "messages": lambda ctx: ctx["extras"]["messages_by_student"],
    "quick_quiz_correct": lambda ctx: ctx["quick_quiz_correct"],
    "quest_rate": lambda ctx: ctx["extras"]["quest_rate_by_student"],
    "mastered": lambda ctx: ctx["extras"]["mastered_by_student"],
    "resources": lambda ctx: ctx["extras"]["views_by_student"],
}


# ── 学生称号配置 ──────────────────────────────────────────────
PRAISE_TITLES: list[dict[str, Any]] = [
    {"key": "annual", "title": "年度人物", "group": "年度特别", "kind": "student",
     "weight": 1.2, "builder": "annual", "periods": ("year",),
     "empty": "全年没有积分记录"},
    {"key": "progress", "title": "进步之星", "group": "学业进步", "kind": "student",
     "weight": 1.0, "builder": "rate_delta", "min_sample": 5,
     "empty": "本期没有两期都有足够样本的学生"},
    {"key": "comeback", "title": "逆袭之星", "group": "学业进步", "kind": "student",
     "weight": 0.95, "builder": "comeback", "min_sample": 3, "min_rate": 60,
     "empty": "本期没有从预警回到正常的学生"},
    {"key": "perfect", "title": "满分之星", "group": "学业进步", "kind": "student",
     "weight": 0.9, "builder": "rate_at_least", "min_rate": 95,
     "empty": "本期没有 95% 以上的得分记录"},
    {"key": "steady", "title": "稳居之星", "group": "学业进步", "kind": "student",
     "weight": 0.85, "builder": "vacant", "empty": "需连续 3 期数据，P1 开放"},
    {"key": "mutual", "title": "互助之星", "group": "品格互助", "kind": "student",
     "weight": 0.9, "builder": "vacant", "empty": "互助口径待接入，P1 开放"},
    {"key": "question", "title": "提问之星", "group": "课堂表现", "kind": "student",
     "weight": 0.8, "builder": "top_metric", "metric": "questions", "min_value": 2,
     "template": "本期提问 {value} 条", "empty": "本期没有学生提问记录"},
    {"key": "speak", "title": "发言之星", "group": "课堂表现", "kind": "student",
     "weight": 0.8, "builder": "top_metric", "metric": "messages", "min_value": 3,
     "template": "讨论区发言 {value} 条", "empty": "本期没有分组讨论发言"},
    {"key": "persist", "title": "坚持之星", "group": "品格互助", "kind": "student",
     "weight": 0.8, "builder": "vacant", "empty": "连续周参与需跨期扫描，P1 开放"},
    {"key": "buzzer", "title": "抢答之星", "group": "课堂表现", "kind": "student",
     "weight": 0.75, "builder": "top_metric", "metric": "quick_quiz_correct", "min_value": 3,
     "template": "抢答答对 {value} 题", "empty": "本期没有抢答记录"},
    {"key": "quest", "title": "闯关之星", "group": "课堂表现", "kind": "student",
     "weight": 0.75, "builder": "top_metric", "metric": "quest_rate", "min_value": 60,
     "template": "知识闯关正确率 {value}%", "empty": "本期没有知识闯关记录"},
    {"key": "attendance", "title": "全勤之星", "group": "学习习惯", "kind": "student",
     "weight": 0.7, "builder": "attendance", "empty": "本期活动不足 3 次"},
    {"key": "on_time", "title": "守时之星", "group": "学习习惯", "kind": "student",
     "weight": 0.7, "builder": "on_time", "empty": "本期没有 2 次以上作业提交"},
    {"key": "correct", "title": "订正之星", "group": "学习习惯", "kind": "student",
     "weight": 0.7, "builder": "top_metric", "metric": "mastered", "min_value": 3,
     "template": "本期订正并掌握 {value} 道错题", "empty": "本期没有错题订正记录"},
    {"key": "resource", "title": "资源之星", "group": "学习习惯", "kind": "student",
     "weight": 0.65, "builder": "top_metric", "metric": "resources", "min_value": 3,
     "template": "浏览学习资源 {value} 次", "empty": "本期没有资源浏览记录"},
]


# ── 班级称号配置 ──────────────────────────────────────────────
CLASS_TITLES: list[dict[str, Any]] = [
    {"key": "c_progress", "title": "进步班级", "weight": 1.0, "builder": "c_rate_delta",
     "empty": "本期没有两期都有足够样本的班级"},
    {"key": "c_zero", "title": "零预警班级", "weight": 0.95, "builder": "c_zero_alert",
     "empty": "本期各班均有预警或零参与学生"},
    {"key": "c_part", "title": "参与标杆", "weight": 0.9, "builder": "c_participation",
     "empty": "班级样本不足"},
    {"key": "c_bottom", "title": "底部提升班级", "weight": 0.9, "builder": "c_bottom_delta",
     "empty": "两期样本不足 6 人次"},
    {"key": "c_balance", "title": "均衡班级", "weight": 0.85, "builder": "c_stddev",
     "empty": "班级得分样本不足"},
    {"key": "c_complete", "title": "完成力班级", "weight": 0.85, "builder": "c_completion",
     "empty": "本期没有作业提交"},
    {"key": "c_active", "title": "互动活跃班级", "weight": 0.8, "builder": "c_active",
     "empty": "班级人数不足"},
    {"key": "c_ask", "title": "提问氛围班级", "weight": 0.8, "builder": "c_ask",
     "empty": "班级人数不足"},
]


def _b_annual(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    pts = ctx["extras"]["points_by_student"]
    if not pts:
        return []
    top = max(pts.items(), key=lambda kv: kv[1])
    if top[1] <= 0:
        return []
    return [_cand(ctx["scope"], top[0], spec["title"], spec["group"],
                  f"全年获得 {top[1]} 积分，为任课范围内最高", "points", top[1], spec["weight"])]


def _b_rate_delta(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    cur, prev = ctx["rates"], ctx["prev_rates"]
    min_sample = int(spec.get("min_sample", 5))
    out = []
    for u, c in cur.items():
        p = prev.get(u)
        if not p or c["samples"] < min_sample or p["samples"] < min_sample:
            continue
        delta = round((c["rate"] or 0) - (p["rate"] or 0), 1)
        if delta <= 0:
            continue
        out.append(_cand(ctx["scope"], u, spec["title"], spec["group"],
                         f"得分率由 {p['rate']}% 提升至 {c['rate']}%，+{delta}pp",
                         "rate_delta", delta, spec["weight"]))
    return out


def _b_comeback(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    min_sample = int(spec.get("min_sample", 3))
    min_rate = float(spec.get("min_rate", 60))
    for u, c in ctx["rates"].items():
        p = ctx["prev_rates"].get(u)
        if not p or c["samples"] < min_sample or c["rate"] is None or c["rate"] < min_rate:
            continue
        was_low = (p["rate"] is not None and p["rate"] < SILENT_ALERT_RATE) or p["samples"] == 0
        if was_low:
            prev_rate = p["rate"] if p["rate"] is not None else 0
            out.append(_cand(ctx["scope"], u, spec["title"], spec["group"],
                             f"上期得分率 {prev_rate}%，本期回到 {c['rate']}%",
                             "rate", c["rate"], spec["weight"]))
    return out


def _b_rate_at_least(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    floor = float(spec.get("min_rate", 95))
    return [_cand(ctx["scope"], u, spec["title"], spec["group"],
                  f"本期最高得分率 {c['rate']}%（{c['samples']} 次作答）",
                  "rate", c["rate"], spec["weight"])
            for u, c in ctx["rates"].items()
            if c["rate"] is not None and c["rate"] >= floor]


def _b_top_metric(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    source = STUDENT_METRICS.get(spec["metric"])
    if not source:
        return []
    floor = float(spec.get("min_value", 0))
    template = spec.get("template") or "{value}"
    return [_cand(ctx["scope"], u, spec["title"], spec["group"],
                  template.format(value=n), spec["metric"], n, spec["weight"])
            for u, n in source(ctx).items() if n >= floor]


def _b_attendance(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    part = ctx["participation"]
    for u, n in (part.get("activity_counts") or {}).items():
        top = ctx["class_max_participation"].get(_stu(ctx["scope"], u)["class"], 0)
        if n >= 3 and n >= top:
            out.append(_cand(ctx["scope"], u, spec["title"], spec["group"],
                             f"本期参与 {n} 次活动，班内最全", "participation", n, spec["weight"]))
    return out


def _b_on_time(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    return [_cand(ctx["scope"], u, spec["title"], spec["group"],
                  f"{s['submitted']} 次作业全部按时提交", "on_time", s["submitted"], spec["weight"])
            for u, s in ctx["extras"]["task_by_student"].items()
            if s["submitted"] >= 2 and s["late"] == 0]


def _b_vacant(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    return []


_STUDENT_BUILDERS = {
    "annual": _b_annual, "rate_delta": _b_rate_delta, "comeback": _b_comeback,
    "rate_at_least": _b_rate_at_least, "top_metric": _b_top_metric,
    "attendance": _b_attendance, "on_time": _b_on_time, "vacant": _b_vacant,
}


def _student_praise_defs(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    ptype = (ctx["period"] or {}).get("type")
    defs = []
    for spec in PRAISE_TITLES:
        if spec.get("periods") and ptype not in spec["periods"]:
            continue
        builder = _STUDENT_BUILDERS[spec["builder"]]
        defs.append({
            "key": spec["key"], "title": spec["title"], "group": spec["group"],
            "weight": spec["weight"], "empty": spec.get("empty", "本期无符合条件的学生"),
            "fn": (lambda b=builder, s=spec: b(ctx, s)),
        })
    return defs


# ── 班级称号 builder ─────────────────────────────────────────

def _c_ok(c: dict[str, Any]) -> bool:
    return c["students"] >= MIN_CLASS_STUDENTS and (c.get("samples") or 0) >= MIN_SAMPLE


def _c_rate_delta(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    prev = {c["class"]: c for c in ctx["prev_by_class"]}
    out = []
    for c in ctx["by_class"]:
        p = prev.get(c["class"])
        if not p or not _c_ok(c) or (p.get("samples") or 0) < MIN_SAMPLE:
            continue
        if (c.get("participation_rate") or 0) < PRAISE_MIN_CLASS_PARTICIPATION:
            continue
        if c["avg_rate"] is None or p.get("avg_rate") is None:
            continue
        delta = round(c["avg_rate"] - p["avg_rate"], 1)
        if delta <= 0:
            continue
        out.append({"title": spec["title"], "name": c["class"], "metric": "rate_delta",
                    "value": delta, "weight": spec["weight"],
                    "reason": f"班级平均得分率 +{delta}pp（{p['avg_rate']}% → {c['avg_rate']}%）"})
    return out


def _c_zero_alert(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for c in ctx["by_class"]:
        if not _c_ok(c) or (c.get("participation_rate") or 0) < PRAISE_MIN_CLASS_PARTICIPATION:
            continue
        risky = [s for s in ctx["samples"]
                 if s["class"] == c["class"] and s["rate"] < SILENT_ALERT_RATE]
        silent = [u for u in ctx["silent_students"] if _stu(ctx["scope"], u)["class"] == c["class"]]
        if not risky and not silent:
            out.append({"title": spec["title"], "name": c["class"], "metric": "alerts",
                        "value": 1, "weight": spec["weight"],
                        "reason": "本期无低分预警、无零参与学生"})
    return out


def _c_participation(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"title": spec["title"], "name": c["class"], "metric": "participation_rate",
             "value": c["participation_rate"], "weight": spec["weight"],
             "reason": f"参与率 {c['participation_rate']}%，{c['participants']}/{c['students']} 人"}
            for c in ctx["by_class"]
            if _c_ok(c) and (c["participation_rate"] or 0) >= PRAISE_MIN_CLASS_PARTICIPATION]


def _c_bottom_delta(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for c in ctx["by_class"]:
        if not _c_ok(c) or (c.get("participation_rate") or 0) < 30:
            continue
        cur_rates = sorted(s["rate"] for s in ctx["samples"] if s["class"] == c["class"])
        prev_rates = sorted(s["rate"] for s in ctx["prev_samples"] if s["class"] == c["class"])
        if len(cur_rates) < 6 or len(prev_rates) < 6:
            continue
        k = max(3, int(len(cur_rates) * 0.3))
        cur_bottom, prev_bottom = _mean(cur_rates[:k]), _mean(prev_rates[:k])
        if cur_bottom is None or prev_bottom is None:
            continue
        delta = round(cur_bottom - prev_bottom, 1)
        if delta > 0:
            out.append({"title": spec["title"], "name": c["class"], "metric": "bottom_delta",
                        "value": delta, "weight": spec["weight"],
                        "reason": f"后 30% 学生平均得分率 +{delta}pp"})
    return out


def _c_stddev(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for c in ctx["by_class"]:
        if not _c_ok(c):
            continue
        rs = [s["rate"] for s in ctx["samples"] if s["class"] == c["class"]]
        if len(rs) < MIN_SAMPLE or (c.get("participants") or 0) < 10:
            continue
        m = sum(rs) / len(rs)
        std = (sum((x - m) ** 2 for x in rs) / len(rs)) ** 0.5
        out.append({"title": spec["title"], "name": c["class"], "metric": "stddev",
                    "value": round(-std, 1), "weight": spec["weight"],
                    "reason": f"班内得分率标准差 {std:.1f}，两极分化最小"})
    return out


def _c_completion(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for c in ctx["by_class"]:
        if c["students"] < MIN_CLASS_STUDENTS:
            continue
        submitters = {u for u in ctx["extras"]["task_by_student"]
                      if _stu(ctx["scope"], u)["class"] == c["class"]}
        if not submitters:
            continue
        rate = _pct(len(submitters), c["students"])
        if not rate or rate < 50:
            continue
        out.append({"title": spec["title"], "name": c["class"], "metric": "submit_rate",
                    "value": rate, "weight": spec["weight"], "reason": f"作业提交率 {rate}%"})
    return out


def _c_active(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for c in ctx["by_class"]:
        if c["students"] < MIN_CLASS_STUDENTS:
            continue
        total = sum(n for u, n in ctx["participation"]["counts"].items()
                    if _stu(ctx["scope"], u)["class"] == c["class"])
        per = round(total / c["students"], 1)
        if per < 1:
            continue
        out.append({"title": spec["title"], "name": c["class"], "metric": "interaction_per_student",
                    "value": per, "weight": spec["weight"], "reason": f"人均互动 {per} 次"})
    return out


def _c_ask(ctx: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for c in ctx["by_class"]:
        if c["students"] < MIN_CLASS_STUDENTS:
            continue
        qs = ctx["extras"]["questions_by_student"]
        total = sum(v for u, v in qs.items() if _stu(ctx["scope"], u)["class"] == c["class"])
        per = round(total / c["students"], 2)
        if per < 0.2:
            continue
        out.append({"title": spec["title"], "name": c["class"], "metric": "questions_per_student",
                    "value": per, "weight": spec["weight"], "reason": f"人均提问 {per} 条"})
    return out


_CLASS_BUILDERS = {
    "c_rate_delta": _c_rate_delta, "c_zero_alert": _c_zero_alert,
    "c_participation": _c_participation, "c_bottom_delta": _c_bottom_delta,
    "c_stddev": _c_stddev, "c_completion": _c_completion,
    "c_active": _c_active, "c_ask": _c_ask,
}


def _class_praise_defs(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    defs = []
    for spec in CLASS_TITLES:
        builder = _CLASS_BUILDERS[spec["builder"]]
        defs.append({
            "key": spec["key"], "title": spec["title"], "weight": spec["weight"],
            "empty": spec.get("empty", "本期无符合条件的班级"),
            "fn": (lambda b=builder, s=spec: b(ctx, s)),
        })
    return defs


def _select_praise(scope: dict[str, Any], period: dict[str, Any],
                   student_defs: list[dict[str, Any]],
                   class_defs: list[dict[str, Any]]) -> dict[str, Any]:
    quota = dict(PRAISE_QUOTA.get(period["type"], PRAISE_QUOTA["week"]))
    coverage_cap = max(1, int(scope["total_students"] * PRAISE_COVERAGE_CAP))
    quota["students"] = min(quota["students"], coverage_cap)

    chosen_students: list[dict[str, Any]] = []
    used: set[str] = set()
    vacant: list[dict[str, str]] = []

    prepared: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for d in sorted(student_defs, key=lambda x: -x["weight"]):
        cands = [c for c in d["fn"]() if c["username"] not in used]
        if not cands:
            vacant.append({"title": d["title"], "reason": d["empty"]})
            continue
        cands.sort(key=lambda c: -c["value"])
        prepared.append((d, cands))

    # 先每人仅取 1 个称号，再补第 2 个，避免榜首一个称号占满名额
    taken_per_title: dict[str, int] = {}
    for round_no in (1, 2):
        for d, cands in prepared:
            if len(chosen_students) >= quota["students"]:
                break
            if taken_per_title.get(d["key"], 0) >= round_no:
                continue
            for c in cands:
                if c["username"] in used:
                    continue
                chosen_students.append(c)
                used.add(c["username"])
                taken_per_title[d["key"]] = taken_per_title.get(d["key"], 0) + 1
                break
    # 称号种类不足时再用第 3 个补齐（仍不重复学生），不降门槛、不重复人
    if len(chosen_students) < quota["students"]:
        for d, cands in prepared:
            if len(chosen_students) >= quota["students"]:
                break
            for c in cands:
                if c["username"] in used:
                    continue
                chosen_students.append(c)
                used.add(c["username"])
                break

    chosen_classes: list[dict[str, Any]] = []
    class_used: dict[str, int] = {}
    class_vacant: list[dict[str, str]] = []
    for d in sorted(class_defs, key=lambda x: -x["weight"]):
        cands = [c for c in d["fn"]() if class_used.get(c["name"], 0) < 2]
        if not cands:
            class_vacant.append({"title": d["title"], "reason": d["empty"]})
            continue
        cands.sort(key=lambda c: -c["value"])
        if len(cands) < 2:
            class_vacant.append({"title": d["title"], "reason": "仅 1 个班有足够数据，不做班级比较"})
            continue
        if len(chosen_classes) >= quota["classes"]:
            continue
        best = cands[0]
        chosen_classes.append(best)
        class_used[best["name"]] = class_used.get(best["name"], 0) + 1

    return {
        "quota": quota,
        "students": chosen_students,
        "classes": chosen_classes,
        "vacant": vacant + class_vacant,
        "coverage": _pct(len(chosen_students), scope["total_students"]),
        "encouragement": "",
    }


# ══════════════════════════════════════════════════════════════
# 预警与事实
# ══════════════════════════════════════════════════════════════

def _collect_alerts(scope: dict[str, Any], rates: dict[str, dict[str, Any]],
                    prev_rates: dict[str, dict[str, Any]],
                    silent: list[dict[str, Any]],
                    by_class: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """预警只看"班级本身在动"的情况。

    全班都没参与时，不该给几十个学生逐个挂红牌——那是平台/教师侧没开展活动，
    不是学生问题。只有班级参与率达到 30% 而个别学生为零时才算个人预警。
    """
    alerts: list[dict[str, Any]] = []
    class_rate = {c["class"]: (c.get("participation_rate") or 0) for c in by_class}
    for s in silent:
        if class_rate.get(s["class"], 0) < 30:
            continue
        alerts.append({"level": "red", "student": _mask_name(s["name"]),
                       "class": s["class"], "reason": "本期零参与"})
        if sum(1 for a in alerts if a["reason"] == "本期零参与") >= 5:
            break
    for u, r in rates.items():
        if r["rate"] is None or r["samples"] < 3:
            continue
        info = scope["students"].get(u) or {}
        if r["rate"] < SILENT_ALERT_RATE:
            alerts.append({"level": "red", "student": _mask_name(info.get("name")),
                           "class": info.get("class"), "reason": f"得分率 {r['rate']}%"})
            continue
        p = prev_rates.get(u)
        if p and p["rate"] is not None and p["samples"] >= 3:
            delta = round(r["rate"] - p["rate"], 1)
            if delta <= -10:
                alerts.append({"level": "yellow", "student": _mask_name(info.get("name")),
                               "class": info.get("class"), "reason": f"得分率下滑 {abs(delta)}pp"})
    return alerts[:20]


ACTIVITY_LABELS = {
    "exam": "考试", "quiz": "随堂测验", "poll": "投票", "discussion": "分组讨论",
    "task": "任务", "practice": "同步练习", "code": "代码练习",
    "quick_quiz": "知识抢答", "homework": "文件作业",
}


def _build_facts(scope: dict[str, Any], period: dict[str, Any], m: dict[str, Any]) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    n = [0]

    def add(kind: str, text: str, value: Any = None) -> None:
        n[0] += 1
        facts.append({"id": f"F{n[0]}", "kind": kind, "text": text, "value": value})

    act = m["activity"]
    if act["total"]:
        parts = "、".join(f"{ACTIVITY_LABELS.get(k, k)} {v} 项"
                          for k, v in sorted(act["by_type"].items(), key=lambda x: -x[1]))
        add("activity", f"本期共开展 {act['total']} 项教学活动（{parts}）", act["total"])
    else:
        add("activity", "本期没有开展教学活动", 0)

    lr = m["learning"]
    if lr["samples"] and lr["avg_rate"] is None:
        add("learning", f"本期有效得分样本 {lr['samples']} 人次，低于 {MIN_SAMPLE} 人次，"
                        f"按口径不计算平均得分率", lr["samples"])
    elif lr["samples"]:
        text = f"本期有效得分样本 {lr['samples']} 人次，平均得分率 {lr['avg_rate']}%"
        if lr["delta"] is not None:
            text += f"，较上期 {'+' if lr['delta'] >= 0 else ''}{lr['delta']}pp"
        add("learning", text, lr["avg_rate"])
        add("learning", f"及格率 {lr['pass_rate']}%，优秀率 {lr['excellent_rate']}%",
            lr["pass_rate"])

    pa = m["participation"]
    if pa["rate"] is not None:
        add("participation", f"学生参与率 {pa['rate']}%（{pa['participants']}/{scope['total_students']} 人）",
            pa["rate"])
    if pa["silent_count"]:
        add("participation", f"{pa['silent_count']} 名学生本期零参与", pa["silent_count"])

    tk = m["tasks"]
    if tk["assigned"]:
        add("task", f"本期布置 {tk['assigned']} 项任务，提交率 {tk['submit_rate']}%", tk["submit_rate"])
    if tk["pending_grading"]:
        add("task", f"待批改 {tk['pending_grading']} 份，建议优先处理", tk["pending_grading"])

    if m["growth"]["available"] and m["growth"]["points_gained"]:
        add("growth", f"本期学生共获得 {m['growth']['points_gained']} 积分",
            m["growth"]["points_gained"])

    ti = m.get("titles") or {}
    if ti.get("upgrades"):
        examples = "、".join(x["title"] for x in (ti.get("recent") or [])[:3])
        add("growth", f"本期 {ti['students']} 名学生获得 {ti['upgrades']} 项平台称号/徽章晋升"
                      + (f"（如 {examples}）" if examples else ""), ti["upgrades"])

    for w in m["weak_points"][:3]:
        add("weak", f"知识点「{w['kp']}」正确率 {w['rate']}%（{w['total']} 次作答）", w["rate"])

    wq = m.get("weak_data_quality") or {}
    if wq.get("unmapped") and wq.get("answers"):
        ratio = wq["unmapped"] / max(wq["answers"], 1)
        if wq["unmapped"] >= 5 and ratio >= 0.2:
            add("quality", f"{wq['unmapped']} 条作答因题目未关联知识点未纳入薄弱分析",
                wq["unmapped"])

    p = m["praise"]
    if p["students"] or p["classes"]:
        add("praise", f"本期表扬 {len(p['students'])} 名学生、{len(p['classes'])} 个班级",
            len(p["students"]) + len(p["classes"]))

    if m["alerts"]:
        red = sum(1 for a in m["alerts"] if a["level"] == "red")
        yellow = len(m["alerts"]) - red
        add("alert", f"预警 {red} 人（红）、{yellow} 人（黄）", red + yellow)

    return facts


# ══════════════════════════════════════════════════════════════
# 主入口
# ══════════════════════════════════════════════════════════════

def collect_metrics(scope: dict[str, Any], period: dict[str, Any],
                    include_prev: bool = True) -> dict[str, Any]:
    """采集一份周期指标快照（不落库）。"""
    activities = _collect_activities(scope, period)
    samples = _collect_samples(scope, period, activities)
    participation = _collect_participation(scope, period, activities, samples)
    extras = _collect_extras(scope, period, activities)
    by_class = _collect_class_breakdown(scope, period, samples, participation, extras)
    rates = _student_rates(samples)

    prev_period_data = previous_period(period)
    if include_prev:
        prev_activities = _collect_activities(scope, prev_period_data)
        prev_samples = _collect_samples(scope, prev_period_data, prev_activities)
        prev_participation = _collect_participation(scope, prev_period_data, prev_activities, prev_samples)
        prev_extras = _collect_extras(scope, prev_period_data, prev_activities)
        prev_by_class = _collect_class_breakdown(scope, prev_period_data, prev_samples,
                                                 prev_participation, prev_extras)
        prev_rates = _student_rates(prev_samples)
    else:
        prev_samples, prev_by_class, prev_rates, prev_activities = [], [], {}, {"total": 0}

    learning = _aggregate_learning(samples, prev_samples)
    tasks = _task_metrics(scope, activities, extras)

    class_max: dict[str, int] = {}
    for u, n in (participation.get("activity_counts") or {}).items():
        c = _stu(scope, u)["class"]
        class_max[c] = max(class_max.get(c, 0), n)

    weak_points, weak_quality = _weak_points(scope, period, activities)
    alerts = _collect_alerts(scope, rates, prev_rates, participation["silent"], by_class)

    ctx = {
        "scope": scope, "period": period,
        "samples": samples, "prev_samples": prev_samples,
        "rates": rates, "prev_rates": prev_rates,
        "participation": participation, "extras": extras,
        "by_class": by_class, "prev_by_class": prev_by_class,
        "silent_students": [s["username"] for s in participation["silent"]],
        "class_max_participation": class_max,
        "quick_quiz_correct": participation["kinds"].get("quick_quiz_correct", {}),
    }
    praise = _select_praise(scope, period, _student_praise_defs(ctx), _class_praise_defs(ctx))

    growth_points = extras["points_by_student"]
    top_gainers = sorted(
        ({"username": u, "name": _stu(scope, u)["name"], "class": _stu(scope, u)["class"], "points": p}
         for u, p in growth_points.items()), key=lambda x: -x["points"]
    )[:5]

    metrics = {
        "period": period,
        "scope": {
            "scope_key": scope["scope_key"], "filter_label": scope["filter_label"],
            "filter": scope["filter"], "owner": scope["owner"], "is_admin": scope["is_admin"],
            "total_students": scope["total_students"],
            "grades": scope["grade_names"], "classes": scope["class_displays"],
            "subjects": scope["subjects"],
        },
        "activity": activities,
        "learning": learning,
        "participation": {
            "participants": participation["participants"], "rate": participation["rate"],
            "silent_count": len(participation["silent"]),
            "silent": [{"name": _mask_name(s["name"]), "class": s["class"]}
                       for s in participation["silent"][:10]],
        },
        "tasks": tasks,
        "growth": {
            "available": not scope["subjects"],
            "points_gained": sum(growth_points.values()),
            "top_gainers": top_gainers,
        },
        "titles": _title_summary(scope, extras.get("titles_by_student") or {}),
        "weak_points": weak_points,
        "weak_data_quality": weak_quality,
        "by_class": by_class,
        "alerts": alerts,
        "praise": praise,
        "prev_period": prev_period_data,
        "prev_summary": {
            "activity_total": prev_activities.get("total", 0),
            "avg_rate": (_mean([s["rate"] for s in prev_samples])
                         if len(prev_samples) >= MIN_SAMPLE else None),
            "samples": len(prev_samples),
            "participation_rate": _pct(int(prev_participation.get("participants") or 0),
                                       scope["total_students"]),
        },
        "trend": _period_trend(samples, period),
        "metrics_version": METRICS_VERSION,
        "is_empty": activities["total"] == 0 and not samples and not extras["points_by_student"],
    }
    metrics["facts"] = _build_facts(scope, period, metrics)
    return metrics
