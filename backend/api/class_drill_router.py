# -*- coding: utf-8 -*-
"""课堂抽问（随机抽问）· 出题 → 抽人 → 判分

用途：课前热身、课中提问互动。老师选年级/班级，选知识点（下拉或手输），
系统从题库抽题（或按开关让 AI 生题），再用与「智能点名」同一套公平算法抽一名学生作答，
答对 +5 / 答错 +2 / 跳过 0，可无限循环。

设计口径（与 docs/class-question/00-方案建议.md 一致）
------------------------------------------------------
1. **底层共用、记录独立**：抽人算法（_weighted_pick / _apply_decay）、权限判定、
   学生名单、积分键全部复用 rollcall_router 与 score_utils；但抽问的会话与流水写
   class_drill_sessions / class_drill_records，绝不写进 rollcall_* 表 —— 老师查看点名
   记录时不会混进抽问，反之亦然。
2. **出题只有一条路**：题库优先 → 缺口交 AI → AI 题必须先入库（backend.question_fill）。
   与随堂测验/同步练习完全相同，不另写一套抽题逻辑。
3. **大屏课堂用**：学生不使用自己设备，本模块没有学生端接口。
4. **AI 开关双层**：系统级 CLASS_DRILL_AI_ENABLED（管理员）+ 页面级 allow_ai（老师当堂）。
   系统关掉时页面开关无效，只走题库。
"""
from __future__ import annotations

import json
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from backend.api.dependencies import get_current_user
from backend.auth import ROLE_ADMIN
from backend.database import (
    execute_insert_update,
    execute_query,
    execute_query_dict,
    execute_query_one,
    get_connection,
)
from backend.logger import logger
from backend.score_utils import load_teacher_scores, save_teacher_scores, teacher_score_key

# 抽人与权限判定复用点名（同一份实现，避免两套"公平"算法各改各的）
from backend.api.rollcall_router import (
    _apply_decay,
    _get_rollcall_teacher,
    _is_teacher_allowed,
    _load_students,
    _normalize_grade_class,
    _weighted_pick,
)

router = APIRouter()

#: 计分口径（与「智能点名」mark 的默认值一致）
POINTS_CORRECT = 5
POINTS_INCORRECT = 2
POINTS_SKIP = 0

#: 出题题型：课堂抽问只要选择题与判断题
QUESTION_TYPES = ("single", "true_false")

#: 抽中一名学生后权重下调（与点名一致）；答对再 +1（上限 10）
WEIGHT_PICK_PENALTY = 3
WEIGHT_CORRECT_BONUS = 1
WEIGHT_MAX = 10


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _ai_enabled_by_admin() -> bool:
    try:
        from backend.api.config_router import get_config_value
        return bool(get_config_value("CLASS_DRILL_AI_ENABLED", True))
    except Exception:
        return True


def _decode(value: Any, default: Any) -> Any:
    """把库里存的 JSON 文本解出来，并容忍**双重编码**。

    历史坑：`_save_session` 曾经对已经是字符串的 weights 又 json.dumps 了一次，库里于是
    存成 "\\"{...}\\""（字符串里再套一层 JSON）。读回来 json.loads 得到的是 str 而不是 dict，
    调用方按 dict 用就静默丢掉了全部权重 —— 表现为"抽过的学生下一轮又被抽"。
    这里连续解到不再是字符串为止（最多两层），旧的脏数据也能自愈。
    """
    if value is None or value == "":
        return default
    parsed = value
    for _ in range(2):
        if not isinstance(parsed, str):
            break
        try:
            parsed = json.loads(parsed)
        except (json.JSONDecodeError, TypeError, ValueError):
            return default
    if not isinstance(parsed, type(default)):
        return default
    return parsed


def _encode(value: Any, default: Any) -> str:
    """存库前统一编码：先解开可能存在的双重编码，再 dumps 一次，保证库里只有一层。"""
    return json.dumps(_decode(value, default), ensure_ascii=False)


# ── 会话读写 ──


def _load_active_session(teacher: str, grade: str, cls: str) -> dict | None:
    return execute_query_one(
        "SELECT * FROM class_drill_sessions WHERE teacher_username=? AND grade=? AND class_name=? "
        "AND status='active' ORDER BY id DESC LIMIT 1",
        (teacher, grade, cls),
    )


def _create_session(teacher: str, grade: str, cls: str, subject: str, topic: str,
                    ai_enabled: bool) -> dict:
    now = _now()
    sid = execute_insert_update(
        "INSERT INTO class_drill_sessions "
        "(teacher_username, grade, class_name, subject, topic, ai_enabled, status, "
        " weights, picked_in_round, last_time, current_question, "
        " correct_count, incorrect_count, skip_count, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'active', '{}', '[]', ?, '', 0, 0, 0, ?, ?)",
        (teacher, grade, cls, subject, topic, 1 if ai_enabled else 0, time.time(), now, now),
    )
    return execute_query_one("SELECT * FROM class_drill_sessions WHERE id=?", (sid,)) or {}


def _ensure_session(teacher: str, grade: str, cls: str, *, subject: str = "", topic: str = "",
                    ai_enabled: bool | None = None) -> dict:
    """取当前进行中的会话；没有就新建一个（老师点进页面即可用，无需先"开始活动"）。"""
    row = _load_active_session(teacher, grade, cls)
    if row:
        updates: list[str] = []
        params: list[Any] = []
        if subject and subject != (row.get("subject") or ""):
            updates.append("subject=?")
            params.append(subject)
        if topic and topic != (row.get("topic") or ""):
            updates.append("topic=?")
            params.append(topic)
        if ai_enabled is not None and int(ai_enabled) != int(row.get("ai_enabled") or 0):
            updates.append("ai_enabled=?")
            params.append(1 if ai_enabled else 0)
        if updates:
            updates.append("updated_at=?")
            params.extend([_now(), row["id"]])
            execute_insert_update(
                f"UPDATE class_drill_sessions SET {', '.join(updates)} WHERE id=?", tuple(params))
            row = execute_query_one("SELECT * FROM class_drill_sessions WHERE id=?", (row["id"],)) or row
        return row
    return _create_session(teacher, grade, cls, subject, topic, bool(ai_enabled))


def _save_session(session: dict) -> None:
    execute_insert_update(
        "UPDATE class_drill_sessions SET subject=?, topic=?, ai_enabled=?, status=?, "
        "weights=?, picked_in_round=?, last_time=?, current_question=?, "
        "correct_count=?, incorrect_count=?, skip_count=?, updated_at=? WHERE id=?",
        (
            session.get("subject") or "", session.get("topic") or "",
            1 if session.get("ai_enabled") else 0, session.get("status") or "active",
            _encode(session.get("weights"), {}),
            _encode(session.get("picked_in_round"), []),
            session.get("last_time"), session.get("current_question") or "",
            int(session.get("correct_count") or 0), int(session.get("incorrect_count") or 0),
            int(session.get("skip_count") or 0), _now(), session["id"],
        ),
    )


def _session_dict(session: dict, grade: str, cls: str) -> dict:
    """会话对外形状（含公平度统计，供页面顶部展示"已抽/覆盖"）。"""
    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]
    records = execute_query(
        "SELECT student_name FROM class_drill_records WHERE session_id=?", (session["id"],)
    )
    covered = len({r[0] for r in records if r[0]})
    weights = _decode(session.get("weights"), {})
    picked_in_round = _decode(session.get("picked_in_round"), [])
    return {
        "session_id": session["id"],
        "grade": grade,
        "class": cls,
        "subject": session.get("subject") or "",
        "topic": session.get("topic") or "",
        "ai_enabled": bool(session.get("ai_enabled")),
        "status": session.get("status") or "active",
        "total_students": len(names),
        "covered": covered,
        "picked_in_round": len(picked_in_round),
        "weights_count": len(weights),
        "correct_count": int(session.get("correct_count") or 0),
        "incorrect_count": int(session.get("incorrect_count") or 0),
        "skip_count": int(session.get("skip_count") or 0),
        "created_at": session.get("created_at") or "",
    }


# ── 权限：读 body / query 里的 (grade, class) 并校验 ──


def _scope_from_request(request: Request, user: dict, body: dict) -> tuple[str, str, str]:
    """返回 (teacher, grade, class)；教师只能操作自己任教的班级。"""
    grade, cls = _normalize_grade_class(body.get("grade", ""), body.get("class", ""))
    teacher = _get_rollcall_teacher(request, user, body)
    if not grade or not cls:
        raise HTTPException(status_code=400, detail="请先选择年级和班级")
    if user.get("role") != ROLE_ADMIN and not _is_teacher_allowed(user["username"], grade, cls):
        raise HTTPException(status_code=403, detail="无权操作该班级")
    return teacher, grade, cls


# ── 出题 ──


def _normalize_client_question(item: dict[str, Any]) -> dict[str, Any]:
    """把题库/AI 两种形状统一成前端可直接渲染的题目对象。"""
    qtype = str(item.get("type") or "single")
    opts = item.get("options")
    out_opts: list[str] = []
    if isinstance(opts, dict):
        for key in sorted(opts.keys()):
            label = str(key).strip().upper()
            text = str(opts[key]).strip()
            if text.startswith(f"{label}.") or text.startswith(f"{label}、"):
                out_opts.append(text)
            else:
                out_opts.append(f"{label}. {text}")
    elif isinstance(opts, (list, tuple)):
        out_opts = [str(o) for o in opts]
    if qtype == "true_false":
        # 判断题统一两选项，答案仍是"对/错"（入库时已归一，见 question_factory）
        out_opts = ["对", "错"]
    answer = str(item.get("answer") or item.get("correct_answer") or "").strip()
    letters = ("A", "B", "C", "D", "E", "F")
    return {
        "id": item.get("id"),
        "type": qtype,
        "question": item.get("question") or item.get("question_text") or "",
        "options": out_opts,
        "answer": answer.upper() if answer.upper() in letters else answer,
        "explanation": item.get("explanation") or "",
        "source": item.get("_source") or "bank",
    }


async def _draw_question(*, teacher: str, username: str, grade: str, cls: str, subject: str,
                         topic: str, question_type: str, allow_ai: bool,
                         exclude_ids: list) -> tuple[dict[str, Any], str, bool]:
    """抽 1 道题：题库优先，allow_ai 时缺口交 AI。返回 (题目, 提示文案, 是否用了 AI)。"""
    from backend import question_fill
    from backend.api import interaction_router as ir
    from backend.api.ai_service import call_ai_async
    from backend.api.chat_router import get_api_keys
    from backend.prompts import build_ai_role

    qtype = question_type if question_type in QUESTION_TYPES else "mixed"
    exclude: list[int] = []
    for i in exclude_ids or []:
        try:
            exclude.append(int(i))
        except (TypeError, ValueError):
            continue

    def _fetch_bank(need: int) -> list[dict[str, Any]]:
        try:
            rows = ir._search_questions_from_bank(topic, subject, qtype, need, exclude_ids=exclude)
        except Exception as e:  # 题库查不动不该阻断课堂
            logger.warning(f"[课堂抽问] 题库搜索异常，跳过: {e}")
            return []
        return rows or []

    async def _gen_ai(need: int, avoid: list[str]) -> list[dict[str, Any]]:
        api_key, _ = get_api_keys(username)
        if not api_key:
            raise question_fill.MissingApiKey(question_fill.NOTE_NO_KEY)
        type_desc = {
            "single": "单选题（4 个选项）",
            "true_false": "判断题",
            "mixed": "混合出题（AI 自动搭配单选/判断）",
        }[qtype]
        from backend.prompts.question_schema import render_question_prompt, schema_block
        from backend.prompts.quiz import QUIZ_GENERATE_PROMPT
        # 不要求配图（with_media=False）：课中抽问要的是"快"，生图会拖到几十秒
        prompt = f"{build_ai_role(subject=subject, grade=grade)}\n" + render_question_prompt(
            QUIZ_GENERATE_PROMPT,
            schema=schema_block("single/true_false", options_shape="list", with_media=False),
            subject=subject,
            topic=topic,
            type_desc=type_desc,
            count=need,
        )
        text = await call_ai_async(prompt, api_key, json_mode=True, kb_query=f"{subject} {topic}")
        return ir._parse_ai_generated(text)

    async def _persist(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for q in items:
            q["_source"] = "ai"
        # 复用随堂测验的入库口（question_factory 统一出口）：体检 → 查重 → 单事务 → 连知识点边
        return await ir._persist_quiz_ai_questions(
            items, topic=topic, subject=subject, username=username, now=now_str
        )

    try:
        filled = await question_fill.fill_questions(
            count=1,
            fetch_bank=_fetch_bank,
            gen_ai=_gen_ai if allow_ai else None,
            persist=_persist if allow_ai else None,
            detail_when_empty="未能取到可用题目：题库无匹配题，AI 补题也未成功，请重试或调整知识点",
        )
    except question_fill.FillUnavailable as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail) from e

    if not filled.questions:
        reason = "；".join(filled.notes) if filled.notes else ""
        reason = reason or "题库中暂无匹配该知识点的题目"
        if not allow_ai:
            reason += "。可开启「AI 生题」让系统即时生成，或更换知识点"
        raise HTTPException(status_code=404, detail=reason)

    used_ai = filled.ai_count > 0
    return _normalize_client_question(filled.questions[0]), "；".join(filled.notes), used_ai


# ── API ──


@router.get("/config", summary="课堂抽问配置（AI 总开关与计分口径）")
async def drill_config(request: Request):
    get_current_user(request)
    return {
        "ai_enabled": _ai_enabled_by_admin(),
        "points": {"correct": POINTS_CORRECT, "incorrect": POINTS_INCORRECT, "skip": POINTS_SKIP},
        "question_types": [
            {"value": "single", "label": "单选题"},
            {"value": "true_false", "label": "判断题"},
            {"value": "mixed", "label": "混合（单选+判断）"},
        ],
    }


@router.post("/session", summary="开始/继续本次抽问会话")
async def open_session(request: Request):
    user = get_current_user(request)
    body = await request.json()
    teacher, grade, cls = _scope_from_request(request, user, body)
    session = _ensure_session(
        teacher, grade, cls,
        subject=str(body.get("subject") or "").strip(),
        topic=str(body.get("topic") or "").strip(),
        ai_enabled=bool(body.get("allow_ai")),
    )
    return _session_dict(session, grade, cls)


@router.get("/session", summary="查看当前抽问会话（无则返回 null）")
async def current_session(request: Request):
    user = get_current_user(request)
    teacher, grade, cls = _scope_from_request(request, user, dict(request.query_params))
    session = _load_active_session(teacher, grade, cls)
    if not session:
        return {"session": None}
    return {"session": _session_dict(session, grade, cls)}


@router.post("/session/reset", summary="结束本次会话并重新开始（清空权重与流水）")
async def reset_session(request: Request):
    user = get_current_user(request)
    body = await request.json()
    teacher, grade, cls = _scope_from_request(request, user, body)
    old = _load_active_session(teacher, grade, cls)
    if old:
        execute_insert_update(
            "UPDATE class_drill_sessions SET status='ended', updated_at=? WHERE id=?",
            (_now(), old["id"]),
        )
    session = _create_session(
        teacher, grade, cls,
        str(body.get("subject") or (old or {}).get("subject") or "").strip(),
        str(body.get("topic") or (old or {}).get("topic") or "").strip(),
        bool(body.get("allow_ai")),
    )
    return _session_dict(session, grade, cls)


@router.post("/draw", summary="抽一道题（题库优先，按开关交 AI 生成）")
async def draw_question(request: Request):
    user = get_current_user(request)
    body = await request.json()
    teacher, grade, cls = _scope_from_request(request, user, body)

    topic = str(body.get("topic") or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="请先选择或输入知识点")
    subject = str(body.get("subject") or "").strip()
    raw_type = str(body.get("question_type") or "mixed").strip()
    allow_ai = bool(body.get("allow_ai")) and _ai_enabled_by_admin()
    exclude_ids = body.get("exclude_ids") or []
    if not isinstance(exclude_ids, list):
        exclude_ids = []

    question, note, used_ai = await _draw_question(
        teacher=teacher, username=user["username"], grade=grade, cls=cls, subject=subject,
        topic=topic, question_type=raw_type, allow_ai=allow_ai, exclude_ids=exclude_ids,
    )

    session = _ensure_session(teacher, grade, cls, subject=subject, topic=topic, ai_enabled=allow_ai)
    session["current_question"] = json.dumps(question, ensure_ascii=False)
    _save_session(session)

    return {
        "question": question,
        "source": "ai" if used_ai else "bank",
        "note": note,
        "session": _session_dict(session, grade, cls),
    }


@router.post("/pick", summary="公平抽取一名学生（与点名同一套权重算法）")
async def pick_student(request: Request):
    user = get_current_user(request)
    body = await request.json()
    teacher, grade, cls = _scope_from_request(request, user, body)

    session = _ensure_session(teacher, grade, cls)
    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]
    if not names:
        raise HTTPException(status_code=404, detail="该班级暂无学生名单")

    weights = dict(_decode(session.get("weights"), {}))
    for n in names:
        weights.setdefault(n, 10)

    picked_in_round = list(_decode(session.get("picked_in_round"), []))

    last_time = _apply_decay(weights, session.get("last_time"))
    if len(picked_in_round) / len(names) >= 0.6:
        picked_in_round.clear()
    available = {n: weights[n] for n in names if n not in picked_in_round}
    if not available:
        picked_in_round.clear()
        available = {n: weights[n] for n in names}

    picked = _weighted_pick(available)
    if not picked:
        raise HTTPException(status_code=404, detail="没有可抽取的学生")
    weights[picked] = max(1, weights[picked] - WEIGHT_PICK_PENALTY)
    picked_in_round.append(picked)

    session["weights"] = weights
    session["picked_in_round"] = picked_in_round
    session["last_time"] = time.time()
    _save_session(session)

    rows = execute_query(
        "SELECT student_name, result, points FROM class_drill_records "
        "WHERE session_id=? ORDER BY id DESC LIMIT 1",
        (session["id"],),
    )
    covered_rows = execute_query(
        "SELECT student_name FROM class_drill_records WHERE session_id=?", (session["id"],)
    )
    return {
        "student": picked,
        "covered": len({r[0] for r in covered_rows if r[0]}),
        "total": len(names),
        "last_record": (
            {"student": rows[0][0], "result": rows[0][1], "points": rows[0][2]} if rows else None
        ),
    }


@router.post("/judge", summary="判定作答结果并计分（答对 +5 / 答错 +2 / 跳过 0）")
async def judge(request: Request):
    user = get_current_user(request)
    body = await request.json()
    teacher, grade, cls = _scope_from_request(request, user, body)

    student = str(body.get("student") or "").strip()
    result = str(body.get("result") or "").strip()
    if not student:
        raise HTTPException(status_code=400, detail="请先抽取学生")

    session = _ensure_session(teacher, grade, cls)
    # 题目快照以服务端会话为准（老师可能连抽两人答同一题）
    question: dict[str, Any] = {}
    raw_q = session.get("current_question")
    if isinstance(raw_q, str) and raw_q:
        try:
            parsed = json.loads(raw_q)
            if isinstance(parsed, dict):
                question = parsed
        except (json.JSONDecodeError, TypeError):
            question = {}

    # 学生所选项（字母或「对/错」）：给了它就由**服务端**判定对错，客户端不必自己比答案
    student_answer = str(body.get("selected") or "").strip()
    if student_answer and result not in ("correct", "incorrect", "skip"):
        correct_answer = str(question.get("answer") or "").strip()
        if not correct_answer:
            raise HTTPException(status_code=400, detail="当前题目没有答案，无法自动判定")
        result = ("correct" if student_answer.upper() == correct_answer.upper()
                  else "incorrect")
    if result not in ("correct", "incorrect", "skip"):
        raise HTTPException(status_code=400, detail="判定结果不合法")

    points = {"correct": POINTS_CORRECT, "incorrect": POINTS_INCORRECT, "skip": POINTS_SKIP}[result]
    key = teacher_score_key(teacher, grade, cls, student)
    if points:
        scores = load_teacher_scores(teacher)
        scores[key] = scores.get(key, 0) + points
        save_teacher_scores(scores, teacher)

    weights = dict(_decode(session.get("weights"), {}))
    if result == "correct":
        weights[student] = min(WEIGHT_MAX, weights.get(student, WEIGHT_MAX) + WEIGHT_CORRECT_BONUS)
    session["weights"] = weights

    counter_key = {"correct": "correct_count", "incorrect": "incorrect_count",
                   "skip": "skip_count"}[result]
    session[counter_key] = int(session.get(counter_key) or 0) + 1
    _save_session(session)

    execute_insert_update(
        "INSERT INTO class_drill_records "
        "(session_id, teacher_username, grade, class_name, student_name, question_id, "
        " question_text, question_type, options, correct_answer, student_answer, explanation, source, "
        " result, points, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            session["id"], teacher, grade, cls, student, question.get("id"),
            question.get("question") or "", question.get("type") or "",
            json.dumps(question.get("options") or [], ensure_ascii=False),
            question.get("answer") or "", student_answer, question.get("explanation") or "",
            question.get("source") or "bank", result, points, _now(),
        ),
    )

    scores = load_teacher_scores(teacher)
    return {
        "success": True,
        "student": student,
        "result": result,
        "correct_answer": question.get("answer") or "",
        "student_answer": student_answer,
        "points_added": points,
        "total_score": scores.get(key, 0),
        "session": _session_dict(session, grade, cls),
    }


@router.get("/records", summary="本次抽问流水（最近的在前）")
async def records(request: Request):
    user = get_current_user(request)
    teacher, grade, cls = _scope_from_request(request, user, dict(request.query_params))
    session = _load_active_session(teacher, grade, cls)
    if not session:
        return {"session": None, "records": []}
    rows = execute_query_dict(
        "SELECT id, student_name, question_id, question_type, question_text, options, "
        "       correct_answer, student_answer, source, result, points, created_at "
        "FROM class_drill_records WHERE session_id=? ORDER BY id DESC LIMIT 200",
        (session["id"],),
    )
    for r in rows:
        try:
            r["options"] = json.loads(r.get("options") or "[]")
        except (json.JSONDecodeError, TypeError):
            r["options"] = []
    return {"session": _session_dict(session, grade, cls), "records": rows}


@router.get("/sessions", summary="抽问会话历史（本教师的，管理员可看全部）")
async def list_sessions(request: Request, limit: int = 50):
    user = get_current_user(request)
    limit = max(1, min(int(limit or 50), 200))
    if user.get("role") == ROLE_ADMIN:
        rows = execute_query_dict(
            "SELECT * FROM class_drill_sessions ORDER BY id DESC LIMIT ?", (limit,))
    else:
        rows = execute_query_dict(
            "SELECT * FROM class_drill_sessions WHERE teacher_username=? ORDER BY id DESC LIMIT ?",
            (user["username"], limit),
        )
    out = []
    for r in rows:
        total = (int(r.get("correct_count") or 0) + int(r.get("incorrect_count") or 0)
                 + int(r.get("skip_count") or 0))
        out.append({
            "session_id": r["id"],
            "teacher": r.get("teacher_username") or "",
            "grade": r.get("grade") or "",
            "class": r.get("class_name") or "",
            "subject": r.get("subject") or "",
            "topic": r.get("topic") or "",
            "status": r.get("status") or "",
            "ai_enabled": bool(r.get("ai_enabled")),
            "correct_count": int(r.get("correct_count") or 0),
            "incorrect_count": int(r.get("incorrect_count") or 0),
            "skip_count": int(r.get("skip_count") or 0),
            "total_count": total,
            "created_at": r.get("created_at") or "",
            "ended_at": (r.get("updated_at") or "") if r.get("status") == "ended" else "",
        })
    return {"sessions": out, "total": len(out)}


@router.delete("/session/{session_id}", summary="删除一条抽问会话（连同流水）")
async def delete_session(session_id: int, request: Request):
    user = get_current_user(request)
    row = execute_query_one("SELECT * FROM class_drill_sessions WHERE id=?", (session_id,))
    if not row:
        raise HTTPException(status_code=404, detail="会话不存在")
    if user.get("role") != ROLE_ADMIN and row.get("teacher_username") != user["username"]:
        raise HTTPException(status_code=403, detail="无权删除该会话")
    with get_connection() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM class_drill_records WHERE session_id=?", (session_id,))
        c.execute("DELETE FROM class_drill_sessions WHERE id=?", (session_id,))
        conn.commit()
    logger.info(f"[课堂抽问] {user['username']} 删除会话 #{session_id}")
    return {"success": True}
