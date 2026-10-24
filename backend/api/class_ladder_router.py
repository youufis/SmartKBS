# -*- coding: utf-8 -*-
"""课堂闯关（大屏版）· 单人阶梯闯关

用途：教师投屏用的「百万富翁」式闯关互动。老师选主题（或学科+知识点）→ 生成题池
→ 抽一名学生 → 该学生连打 15 关（每关可用 3 个锦囊之一）→ 答错/超时即止 → 结算上榜
→ 抽下一名学生开新局。

设计口径（与 docs/class-ladder/00-方案建议.md 一致）
------------------------------------------------------
1. **规则同口径**：15 关阶梯分值、3 个锦囊、折减系数、答错终止，全部对齐学生端
   「知识闯关」（backend/api/quest_router.py 的 SCORE_TABLE / LIFELINE_DISCOUNT），
   不产生第二套分值口径。
2. **复用不重写**：抽人（backend.pick_engine：同一套权重算法 + 同一份班级权重）、
   题库召回（question_select 分层+难度）、凑题策略（question_fill）、AI 题入库
   （question_factory）、课堂积分（score_utils）、锦囊提示词（prompts/quest.py）全部复用。
3. **状态共用、明细独立**：权重与本轮覆盖标记自 2026-10 起与「智能点名」「课堂抽问」
   共用一份（这节课在点名里被抽过两次的人，这里就该少抽到）；关卡轨迹与结算仍写
   class_ladder_runs，另在统一台账 pick_ledger 各落一行抽人记录，点名管理一条时间线看全。
4. **判定在服务端**：题面下发不含答案；学生所选项由服务端比对。
5. **AI 双层开关**：系统级 CLASS_LADDER_AI_ENABLED（管理员）+ 页面级 allow_ai（老师当堂）。
"""
from __future__ import annotations

import json
import math
import random
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
)
from backend.logger import logger
from backend.score_utils import load_teacher_scores, save_teacher_scores, teacher_score_key

# 权限判定与年级班级归一复用点名（同一份实现，避免两套口径各改各的）
from backend.api.rollcall_router import (
    _get_rollcall_teacher,
    _is_teacher_allowed,
    _load_students,
    _normalize_grade_class,
)
# 抽人：算法 + 权重 + 本轮覆盖 + 台账都在这一处（点名/抽问/闯关共用）
from backend import pick_engine
# 题面归一化复用课堂抽问（题库/AI 两种形状统一成前端可渲染形状）
from backend.api.class_drill_router import _normalize_client_question

router = APIRouter()

# ── 规则常量（与学生端「知识闯关」同口径）──
MAX_LEVELS = 15
LEVEL_SCORES = {
    1: 10, 2: 15, 3: 15, 4: 20, 5: 20, 6: 20,
    7: 25, 8: 25, 9: 25, 10: 30, 11: 30, 12: 30,
    13: 50, 14: 50, 15: 50,
}
TOTAL_FULL_SCORE = sum(LEVEL_SCORES.values())          # 415
SAFE_LEVELS = (5, 10)                                  # 安全关（经典回落模式的落点）
LIFELINE_TYPES = ("remove_one", "phone_friend", "audience_vote")
LIFELINE_DISCOUNT = {"remove_one": 0.85, "phone_friend": 0.70, "audience_vote": 0.70}
# 大屏专属锦囊（可选替换）：现场表决（老师录入举手人数）/ 请军师（再抽一人当军师）
EXTRA_LIFELINE_DISCOUNT = {"class_vote": 0.70, "helper": 0.70}
_ALL_LIFELINE_DISCOUNT = {**LIFELINE_DISCOUNT, **EXTRA_LIFELINE_DISCOUNT}
LIFELINE_NAMES = {
    "remove_one": "去伪存真", "phone_friend": "远程连线", "audience_vote": "群策群力",
    "class_vote": "现场表决", "helper": "请军师",
}
#: 默认三件套（与学生端一致）；老师开场最多换 3 个
DEFAULT_LIFELINES = ("remove_one", "phone_friend", "audience_vote")
MAX_LIFELINES = 3
QUESTION_TYPES = ("single", "true_false")
DEFAULT_TIME_LIMIT = 0  # 0 = no countdown (default)
DEFAULT_POOL_SIZE = 30
SKINS = ("star", "cyber", "academy", "classic", "cloud", "sunrise", "mint")

#: 权重口径（抽中 -3、答对 +1、上限 10、覆盖 60% 开新轮）只在 pick_engine 定义一次，
#: 三个活动共用同一份状态，不该再有三份副本。


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _as_time_limit(value: Any) -> int:
    """限时秒数：0 = 不限时。必须显式判 None，不能用 or 兜默认值（会把 0 吞掉）。"""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return DEFAULT_TIME_LIMIT
    return max(0, n)


def _ai_enabled_by_admin() -> bool:
    try:
        from backend.api.config_router import get_config_value
        return bool(get_config_value("CLASS_LADDER_AI_ENABLED", True))
    except Exception:
        return True


def _sound_enabled_by_admin() -> bool:
    try:
        from backend.api.config_router import get_config_value
        return bool(get_config_value("CLASS_LADDER_SOUND_ENABLED", True))
    except Exception:
        return True


def _default_skin() -> str:
    try:
        from backend.api.config_router import get_config_value
        skin = str(get_config_value("CLASS_LADDER_DEFAULT_SKIN", "cloud") or "cloud")
        return skin if skin in SKINS else "cloud"
    except Exception:
        return "cloud"


def _as_text(value: Any) -> str:
    """把可能是 list/dict 的字段统一成入库用的文本（media_files 会被解析成数组）。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _decode(value: Any, default: Any) -> Any:
    """把库里存的 JSON 文本解出来，并容忍双重编码（与课堂抽问同一处踩过的坑）。"""
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
    return json.dumps(_decode(value, default), ensure_ascii=False)


def _norm_lifelines(raw: Any) -> list[str]:
    """收敛成"合法的、最多 3 个"的锦囊集合；空/非法一律回默认三件套。"""
    if not isinstance(raw, list):
        return list(DEFAULT_LIFELINES)
    seen: list[str] = []
    for x in raw:
        k = str(x or "").strip()
        if k in _ALL_LIFELINE_DISCOUNT and k not in seen:
            seen.append(k)
    return seen[:MAX_LIFELINES] or list(DEFAULT_LIFELINES)


def _session_lifelines(session: dict) -> list[str]:
    return _norm_lifelines(_decode(session.get("lifelines"), list(DEFAULT_LIFELINES)))


def _difficulty_of_level(level: int) -> str:
    """关卡 → 难度档（1-5 易 / 6-10 中 / 11-15 难）。"""
    if level <= 5:
        return "easy"
    if level <= 10:
        return "medium"
    return "hard"


def _diff_cn(diff: str) -> str:
    return {"easy": "较易", "medium": "中等", "hard": "较难"}.get(diff, "中等")


def _level_score(level: int) -> int:
    return int(LEVEL_SCORES.get(int(level or 0), 10))


def _option_key(opt: str, idx: int, qtype: str) -> str:
    """取选项的作答键（与课堂抽问 / 学生端闯关同一口径）。"""
    if qtype == "true_false":
        return str(opt or "").strip()
    import re
    matched = re.match(r"^([A-Ha-h])[.、．]", str(opt or "").strip())
    return matched.group(1).upper() if matched else chr(65 + idx)


def _options_to_dict(options: list[str], qtype: str) -> dict[str, str]:
    """["A. 文本", ...] → {"A": "文本"}（锦囊提示词需要 dict 形状）。"""
    out: dict[str, str] = {}
    for i, opt in enumerate(options or []):
        key = _option_key(opt, i, qtype)
        text = str(opt or "").strip()
        if qtype != "true_false":
            text = text[2:].strip() if len(text) > 2 and text[1] in ".、．" else text
        out[key] = text
    return out


def _score_with_lifelines(level: int, lifelines: list[str]) -> int:
    """单关得分（含锦囊折减），与学生端 _calc_question_score 同口径。"""
    discount = 1.0
    for lf in lifelines or []:
        discount *= _ALL_LIFELINE_DISCOUNT.get(lf, 1.0)
    return max(1, round(_level_score(level) * discount))


# ── 会话读写 ──


def _load_active_session(teacher: str, grade: str, cls: str) -> dict | None:
    return execute_query_one(
        "SELECT * FROM class_ladder_sessions WHERE teacher_username=? AND grade=? AND class_name=? "
        "AND status='ready' ORDER BY id DESC LIMIT 1",
        (teacher, grade, cls),
    )


def _create_session(teacher: str, grade: str, cls: str, *, subject: str, topic: str,
                    ai_enabled: bool, question_type: str,
                    time_limit_sec: int, pool_size: int, safe_mode: int, skin: str,
                    lifelines: list[str] | None = None) -> dict:
    now = _now()
    sid = execute_insert_update(
        "INSERT INTO class_ladder_sessions "
        "(teacher_username, grade, class_name, subject, topic, ai_enabled, "
        " question_type, time_limit_sec, pool_size, safe_mode, skin, lifelines, status, weights, "
        " picked_in_round, last_time, build_note, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', '{}', '[]', ?, '', ?, ?)",
        (teacher, grade, cls, subject, topic,
         1 if ai_enabled else 0, question_type, _as_time_limit(time_limit_sec),
         int(pool_size or DEFAULT_POOL_SIZE), int(safe_mode or 0), skin,
         _encode(_norm_lifelines(lifelines), list(DEFAULT_LIFELINES)),
         time.time(), now, now),
    )
    return execute_query_one("SELECT * FROM class_ladder_sessions WHERE id=?", (sid,)) or {}


def _save_session(session: dict) -> None:
    execute_insert_update(
        "UPDATE class_ladder_sessions SET subject=?, topic=?, ai_enabled=?, "
        "question_type=?, time_limit_sec=?, pool_size=?, safe_mode=?, skin=?, lifelines=?, status=?, weights=?, "
        "picked_in_round=?, last_time=?, build_note=?, updated_at=? WHERE id=?",
        (
            session.get("subject") or "", session.get("topic") or "",
            1 if session.get("ai_enabled") else 0, session.get("question_type") or "single",
            _as_time_limit(session.get("time_limit_sec")),
            int(session.get("pool_size") or DEFAULT_POOL_SIZE),
            int(session.get("safe_mode") or 0), session.get("skin") or "",
            _encode(session.get("lifelines"), list(DEFAULT_LIFELINES)),
            session.get("status") or "ready",
            _encode(session.get("weights"), {}),
            _encode(session.get("picked_in_round"), []),
            session.get("last_time"), session.get("build_note") or "",
            _now(), session["id"],
        ),
    )


def _pool_stats(session_id: int) -> dict:
    rows = execute_query(
        "SELECT level, source, COUNT(*) FROM class_ladder_pool WHERE session_id=? GROUP BY level, source",
        (session_id,),
    ) or []
    by_level = {i: 0 for i in range(1, MAX_LEVELS + 1)}
    bank = ai = 0
    for level, source, cnt in rows:
        by_level[int(level)] = by_level.get(int(level), 0) + int(cnt)
        if source == "ai":
            ai += int(cnt)
        else:
            bank += int(cnt)
    return {"total": sum(by_level.values()), "bank": bank, "ai": ai, "by_level": by_level}


def _session_dict(session: dict, grade: str, cls: str) -> dict:
    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]
    return {
        "session_id": session["id"],
        "grade": grade,
        "class": cls,
        "subject": session.get("subject") or "",
        "topic": session.get("topic") or "",


        "ai_enabled": bool(session.get("ai_enabled")),
        "question_type": session.get("question_type") or "single",
        "time_limit_sec": _as_time_limit(session.get("time_limit_sec")),
        "pool_size": int(session.get("pool_size") or DEFAULT_POOL_SIZE),
        "safe_mode": int(session.get("safe_mode") or 0),
        "skin": session.get("skin") or _default_skin(),
        "lifelines": _session_lifelines(session),
        "status": session.get("status") or "ready",
        "total_students": len(names),
        "pool": _pool_stats(session["id"]),
        "note": session.get("build_note") or "",
        "created_at": session.get("created_at") or "",
    }


# ── 权限：读 body / query 里的 (grade, class) 并校验 ──


def _scope_from_request(request: Request, user: dict, body: dict) -> tuple[str, str, str]:
    grade, cls = _normalize_grade_class(body.get("grade", ""), body.get("class", ""))
    teacher = _get_rollcall_teacher(request, user, body)
    if not grade or not cls:
        raise HTTPException(status_code=400, detail="请先选择年级和班级")
    if user.get("role") != ROLE_ADMIN and not _is_teacher_allowed(user["username"], grade, cls):
        raise HTTPException(status_code=403, detail="无权操作该班级")
    return teacher, grade, cls

# ── 题池构建：题库优先 → 缺口 AI 补 → AI 题必须入库 ──


def _levels_for_pool(pool_size: int) -> list[int]:
    """题池的关卡分布：循环铺满 1..15（pool_size=30 → 每关 2 题）。"""
    n = max(MAX_LEVELS, min(int(pool_size or DEFAULT_POOL_SIZE), MAX_LEVELS * 3))
    return [i % MAX_LEVELS + 1 for i in range(n)]


async def _build_pool(session: dict, *, username: str, grade: str, cls: str) -> dict:
    """补足题池：题库优先，缺口交 AI（AI 题走 question_factory 入库）。返回统计。"""
    from backend import question_fill
    from backend.api import interaction_router as ir
    from backend.api.ai_service import call_ai_async
    from backend.api.chat_router import get_api_keys
    from backend.prompts import build_ai_role
    from backend.prompts.quiz import QUIZ_GENERATE_PROMPT
    from backend.prompts.question_schema import render_question_prompt, schema_block
    from backend.question_search import query_bank_questions

    session_id = session["id"]
    topic = session.get("topic") or ""
    subject = session.get("subject") or ""
    qtype = session.get("question_type") or "single"
    if qtype not in QUESTION_TYPES:
        qtype = "single"
    allow_ai = bool(session.get("ai_enabled")) and _ai_enabled_by_admin()

    row = execute_query_one("SELECT COUNT(*) AS n FROM class_ladder_pool WHERE session_id=?", (session_id,))
    have = int((row or {}).get("n") or 0)
    want_levels = _levels_for_pool(session.get("pool_size") or DEFAULT_POOL_SIZE)[have:]
    if not want_levels:
        return {"added": 0, "notes": ["题池已满"]}

    used_ids = [int(r[0]) for r in (execute_query(
        "SELECT question_id FROM class_ladder_pool WHERE session_id=? AND question_id IS NOT NULL",
        (session_id,)) or []) if r[0]]

    buckets: dict[str, list[int]] = {}
    for lv in want_levels:
        buckets.setdefault(_difficulty_of_level(lv), []).append(lv)

    notes: list[str] = []
    staged: list[tuple[int, dict]] = []

    for diff, levels in buckets.items():
        need = len(levels)

        def _fetch_bank(n: int, _diff: str = diff) -> list[dict]:
            try:
                rows = query_bank_questions(topic, subject, qtype, n, scene="class_ladder",
                                            exclude_ids=used_ids, difficulty=_diff)
            except Exception as e:  # 题库查不动不该阻断课堂
                logger.warning(f"[课堂闯关] 题库搜索异常，跳过: {e}")
                return []
            return [_normalize_client_question({**r, "_source": "bank"}) for r in rows or []]

        async def _gen_ai(n: int, avoid: list[str], _diff: str = diff) -> list[dict]:
            api_key, _ = get_api_keys(username)
            if not api_key:
                raise question_fill.MissingApiKey(question_fill.NOTE_NO_KEY)
            type_desc = "单选题（4 个选项）" if qtype == "single" else "判断题"
            # 不要求配图（with_media=False）：课中要的是"快"，生图会拖到几十秒
            prompt = f"{build_ai_role(subject=subject, grade=grade)}\n" + render_question_prompt(
                QUIZ_GENERATE_PROMPT,
                schema=schema_block("single/true_false", options_shape="list", with_media=False),
                subject=subject,
                topic=f"{topic}（本批难度要求：{_diff_cn(_diff)}）",
                type_desc=type_desc,
                count=n,
            )
            text = await call_ai_async(prompt, api_key, json_mode=True, kb_query=f"{subject} {topic}")
            return ir._parse_ai_generated(text)

        async def _persist(items: list[dict]) -> list[dict]:
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            for q in items:
                q["_source"] = "ai"
            return await ir._persist_quiz_ai_questions(
                items, topic=topic, subject=subject, username=username, now=now_str)

        try:
            filled = await question_fill.fill_questions(
                count=need,
                fetch_bank=_fetch_bank,
                gen_ai=_gen_ai if allow_ai else None,
                persist=_persist if allow_ai else None,
                detail_when_empty="未能取到可用题目：题库无匹配题，AI 补题也未成功，请重试或调整主题",
            )
        except question_fill.FillUnavailable as e:
            notes.append(str(getattr(e, "detail", "") or "取题失败")[:140])
            continue

        notes.extend(filled.notes)
        for i, q in enumerate(filled.questions[:need]):
            norm = _normalize_client_question(q)
            norm["source"] = "bank" if i < filled.bank_count else "ai"
            staged.append((levels[i], norm))
            if norm.get("id"):
                try:
                    used_ids.append(int(norm["id"]))
                except (TypeError, ValueError):
                    pass

    now = _now()
    for level, q in staged:
        execute_insert_update(
            "INSERT INTO class_ladder_pool "
            "(session_id, level, difficulty, question_id, question_text, question_type, options, "
            " correct_answer, explanation, source, svg_content, has_svg, media_files, "
            " media_placeholders, used_count, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
            (
                session_id, level, _difficulty_of_level(level),
                q.get("id"), q.get("question") or "", q.get("type") or qtype,
                json.dumps(q.get("options") or [], ensure_ascii=False),
                q.get("answer") or "", q.get("explanation") or "", q.get("source") or "bank",
                q.get("svg_content") or "", int(q.get("has_svg") or 0),
                _as_text(q.get("media_files")), _as_text(q.get("media_placeholders")), now,
            ),
        )

    return {"added": len(staged), "notes": notes}


# ── 一局：抽人 + 从题池取 15 题 ──


def _pick_student_for(session: dict, names: list[str] | None = None,
                      exclude: str = "") -> dict[str, Any] | None:
    """按共用权重抽一名学生（可排除某人，用于"请军师"），返回引擎结果含 pick_id。

    权重与本轮覆盖标记不在会话里了：闯关、点名、抽问共用班级那一份，
    所以这里只负责"抽 + 落台账"，本局明细由调用方写 class_ladder_runs。
    """
    return pick_engine.pick_next(
        grade=session.get("grade") or "",
        cls=session.get("class_name") or "",
        activity=pick_engine.ACT_LADDER,
        teacher=session.get("teacher_username") or "",
        exclude=exclude,
    )


def _write_student_record(run: dict, session: dict) -> None:
    """把本局结果写进学生的 ChatHistory（复用点名同一写入口径）。"""
    student = run.get("student_name") or ""
    if not student:
        return
    from backend.api.rollcall_router import _save_to_student_chat
    answers = _decode(run.get("answers"), [])
    status = run.get("status") or ""
    verdict = {"win": "通关", "timeout": "超时结束"}.get(status, "止步")
    topic = session.get("topic") or session.get("subject") or "课堂闯关"
    lines = [
        f"【课堂闯关】{topic} · {verdict}第 {int(run.get('reached_level') or 0)} 关",
        f"答对 {int(run.get('correct_count') or 0)} 关，阶梯分 {int(run.get('ladder_score') or 0)}，课堂积分 +{int(run.get('points_awarded') or 0)}",
    ]
    for a in answers:
        mark = "✓" if a.get("correct") else ("⏱超时" if a.get("timeout") else "✗")
        lf = ("，用了" + "/".join(LIFELINE_NAMES.get(x, x) for x in (a.get("lifeline") or []))) if a.get("lifeline") else ""
        lines.append(f"第 {int(a.get('level') or 0)} 关 {mark}（选 {a.get('selected') or '—'} / 正确 {a.get('correct_answer') or '—'}）得分 {int(a.get('score') or 0)}{lf}")
    _save_to_student_chat(student, session.get("class_name") or "", "\n".join(lines),
                          grade=session.get("grade") or "",
                          actor=session.get("teacher_username") or "")


def _snapshot_questions(session_id: int) -> list[dict]:
    """为这一局每关取一题（优先池里没被用过的）。"""
    picked: list[dict] = []
    for level in range(1, MAX_LEVELS + 1):
        row = execute_query_one(
            "SELECT * FROM class_ladder_pool WHERE session_id=? AND level=? "
            "ORDER BY used_count ASC, RANDOM() LIMIT 1", (session_id, level))
        if not row:
            row = execute_query_one(
                "SELECT * FROM class_ladder_pool WHERE session_id=? ORDER BY used_count ASC, RANDOM() LIMIT 1",
                (session_id,))
        if not row:
            return []
        execute_insert_update("UPDATE class_ladder_pool SET used_count=used_count+1 WHERE id=?", (row["id"],))
        picked.append({
            "level": level,
            "pool_id": row["id"],
            "question_id": row.get("question_id"),
            "question_type": row.get("question_type") or "single",
            "question_text": row.get("question_text") or "",
            "options": _decode(row.get("options"), []),
            "correct_answer": row.get("correct_answer") or "",
            "explanation": row.get("explanation") or "",
            "source": row.get("source") or "bank",
            "svg_content": row.get("svg_content") or "",
            "has_svg": int(row.get("has_svg") or 0),
            "media_files": row.get("media_files") or "",
            "media_placeholders": row.get("media_placeholders") or "",
        })
    return picked


def _public_question(snap: dict, *, lifelines: list[str] | None = None) -> dict:
    """给前端的题面（**不含正确答案**）。"""
    out = {
        "level": snap.get("level"),
        "question_id": snap.get("question_id"),
        "type": snap.get("question_type") or "single",
        "question": snap.get("question_text") or "",
        "options": snap.get("options") or [],
        "source": snap.get("source") or "bank",
        "svg_content": snap.get("svg_content") or "",
        "has_svg": int(snap.get("has_svg") or 0),
        "media_files": snap.get("media_files") or "",
        "media_placeholders": snap.get("media_placeholders") or "",
        "score": _level_score(int(snap.get("level") or 1)),
        "difficulty": _difficulty_of_level(int(snap.get("level") or 1)),
        "lifelines": lifelines or [],
    }
    return out


def _get_run(run_id: int) -> dict | None:
    return execute_query_one("SELECT * FROM class_ladder_runs WHERE id=?", (int(run_id),))


def _run_and_session(run_id: int, user: dict) -> tuple[dict, dict]:
    run = _get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="本局不存在")
    session = execute_query_one("SELECT * FROM class_ladder_sessions WHERE id=?", (run["session_id"],))
    if not session:
        raise HTTPException(status_code=404, detail="该场次不存在")
    if user.get("role") != ROLE_ADMIN and session.get("teacher_username") != user["username"]:
        raise HTTPException(status_code=403, detail="无权操作该场次")
    return run, session


def _current_level(run: dict) -> int:
    answers = _decode(run.get("answers"), [])
    return len(answers) + 1


def _save_run(run: dict) -> None:
    execute_insert_update(
        "UPDATE class_ladder_runs SET status=?, reached_level=?, correct_count=?, ladder_score=?, "
        "points_awarded=?, lifelines_used=?, lifeline_by_level=?, questions=?, answers=?, ended_at=? "
        "WHERE id=?",
        (
            run.get("status") or "playing", int(run.get("reached_level") or 0),
            int(run.get("correct_count") or 0), int(run.get("ladder_score") or 0),
            int(run.get("points_awarded") or 0),
            _encode(run.get("lifelines_used"), []),
            _encode(run.get("lifeline_by_level"), {}),
            _encode(run.get("questions"), []),
            _encode(run.get("answers"), []),
            run.get("ended_at"), run["id"],
        ),
    )


def _settle_run(run: dict, session: dict) -> None:
    """终态结算：按口径算阶梯分、写入课堂积分（答对关数），只做一次。"""
    if run.get("_settled"):
        return
    answers = _decode(run.get("answers"), [])
    correct = sum(1 for a in answers if a.get("correct"))
    level = int(run.get("reached_level") or 0)
    full = sum(int(a.get("score") or 0) for a in answers if a.get("correct"))
    if int(session.get("safe_mode") or 0):
        # 经典回落：只保住最近一个安全关的分数
        safe = 0
        for s in SAFE_LEVELS:
            if level > s:
                safe = s
        ladder = sum(int(a.get("score") or 0) for a in answers
                     if a.get("correct") and int(a.get("level") or 0) <= safe)
    else:
        ladder = full
    run["correct_count"] = correct
    run["ladder_score"] = ladder
    run["points_awarded"] = correct
    run["_settled"] = True

    # 结算结果回填到抽人台账（points 记实际入账的课堂积分，阶梯分留在明细里）。
    # 走 ref 指针而不是姓名：同班两个同名学生同时闯关时，按姓名反查会回填到错误那行。
    try:
        done = pick_engine.finish_by_ref(
            ref_table="class_ladder_runs", ref_id=int(run.get("id") or 0),
            result=run.get("status") or "ended", points=correct,
            note=f"第{level}关 · 阶梯{ladder}分")
        if not done:
            pick_engine.finish(
                grade=session.get("grade") or "", cls=session.get("class_name") or "",
                activity=pick_engine.ACT_LADDER, student=run.get("student_name") or "",
                result=run.get("status") or "ended", points=correct,
                ref_table="class_ladder_runs", ref_id=int(run.get("id") or 0),
                note=f"第{level}关 · 阶梯{ladder}分",
                teacher=session.get("teacher_username") or "")
    except Exception as e:
        logger.warning(f"[课堂闯关] 抽人台账回填失败: {e}")

    if correct:
        teacher = session.get("teacher_username") or ""
        grade = session.get("grade") or ""
        cls = session.get("class_name") or ""
        student = run.get("student_name") or ""
        key = teacher_score_key(teacher, grade, cls, student)
        scores = load_teacher_scores(teacher)
        scores[key] = scores.get(key, 0) + correct
        save_teacher_scores(scores, teacher)

        # 学生积分：课堂闯关以前也只进教师手动账，学生端看不到自己闯关的收获。
        # 与"知识闯关(quest)"分列两种活动：前者是课堂大屏接力、后者是个人题库闯关。
        _stu = str(run.get("student_username") or "").strip()
        if not _stu and student:
            _u = execute_query(
                "SELECT username FROM users WHERE role=2 AND IFNULL(status,'active')='active' "
                "AND name=? AND grade=? AND (class=? OR class=?)",
                (student, grade, cls, f"{cls}班"),
            )
            _stu = _u[0][0] if _u else ""
        if _stu:
            try:
                from backend.reward_engine import award_participation, award_grade
                _lid = str(run.get("id") or "")
                _ltitle = f"课堂闯关 第{level}关"
                award_participation(_stu, "class_ladder", _lid, _ltitle, teacher_username=teacher)
                award_grade(_stu, "class_ladder", _lid, float(correct),
                            float(len(answers) or 1), _ltitle, teacher_username=teacher)
            except Exception as e:
                logger.warning(f"[课堂闯关] 积分发放失败 {_stu}: {e}")

    # 给学生留一条记录（ChatHistory）——写失败不影响结算与积分
    try:
        _write_student_record(run, session)
    except Exception as e:
        logger.warning(f"[课堂闯关] 写学生记录失败: {e}")


def _run_public(run: dict, session: dict, *, with_question: bool = True) -> dict:
    answers = _decode(run.get("answers"), [])
    lifeline_by_level = _decode(run.get("lifeline_by_level"), {})
    level = _current_level(run) if run.get("status") == "playing" else int(run.get("reached_level") or 0)
    running_score = sum(int(a.get("score") or 0) for a in answers if a.get("correct"))
    out = {
        "run_id": run["id"],
        "session_id": run["session_id"],
        "student": run.get("student_name") or "",
        "status": run.get("status") or "playing",
        "reached_level": int(run.get("reached_level") or 0),
        "correct_count": int(run.get("correct_count") or 0),
        "ladder_score": (running_score if (run.get("status") or "playing") == "playing"
                         else int(run.get("ladder_score") or 0)),
        "points_awarded": int(run.get("points_awarded") or 0),
        "lifelines_used": _decode(run.get("lifelines_used"), []),
        "current_level": level,
        "time_limit_sec": _as_time_limit(session.get("time_limit_sec")),
        "answered": answers,
    }
    if with_question and run.get("status") == "playing":
        snaps = _decode(run.get("questions"), [])
        snap = next((s for s in snaps if int(s.get("level") or 0) == level), None)
        if snap:
            out["question"] = _public_question(snap, lifelines=lifeline_by_level.get(str(level), []))
    return out


async def _ai_lifeline(kind: str, snap: dict, username: str) -> dict:
    """连线 / 群策群力：复用 prompts/quest.py 的锦囊提示词。"""
    from backend.api.ai_service import call_ai_async
    from backend.api.chat_router import get_api_keys
    from backend.prompts.quest import AUDIENCE_VOTE_PROMPT, PHONE_FRIEND_PROMPT

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，无法使用该锦囊")

    opts = _options_to_dict(snap.get("options") or [], snap.get("question_type") or "single")
    qtext = snap.get("question_text") or ""
    fill = dict(question=qtext, option_a=opts.get("A", ""), option_b=opts.get("B", ""),
                option_c=opts.get("C", ""), option_d=opts.get("D", ""))
    if kind == "phone_friend":
        text = await call_ai_async(PHONE_FRIEND_PROMPT.format(**fill), api_key)
        return {"advice": str(text or "").strip().strip('"').strip("'")[:200]}
    text = await call_ai_async(AUDIENCE_VOTE_PROMPT.format(**fill), api_key, json_mode=True)
    try:
        from backend.ai_json import try_parse
        data = try_parse(text) or {}
    except Exception:
        data = {}
    votes = data.get("votes") if isinstance(data, dict) else None
    if not isinstance(votes, dict) or not votes:
        votes = {"A": 25, "B": 25, "C": 25, "D": 25}
    out: dict[str, int] = {}
    for k in ("A", "B", "C", "D"):
        try:
            out[k] = max(0, int(votes.get(k, 0) or 0))
        except (TypeError, ValueError):
            out[k] = 0
    return {"votes": out}


def _norm_topics(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    if isinstance(raw, str):
        import re
        return [t for t in re.split(r"[、,，;；\s]+", raw) if t.strip()]
    return []


# ── API ──


@router.get("/config", summary="课堂闯关配置（阶梯/锦囊/皮肤/计时）")
async def ladder_config(request: Request):
    get_current_user(request)
    return {
        "ai_enabled": _ai_enabled_by_admin(),
        "default_skin": _default_skin(),
        "skins": [
            {"value": "star", "label": "星海紫金", "light": False},
            {"value": "cyber", "label": "赛博霓虹", "light": False},
            {"value": "academy", "label": "学院蓝", "light": False},
            {"value": "classic", "label": "复古金色", "light": False},
            {"value": "cloud", "label": "云白课堂", "light": True},
            {"value": "sunrise", "label": "暖阳米", "light": True},
            {"value": "mint", "label": "薄荷清", "light": True},
        ],
        "ladder": [
            {"level": i, "score": _level_score(i), "difficulty": _difficulty_of_level(i),
             "safe": i in SAFE_LEVELS}
            for i in range(1, MAX_LEVELS + 1)
        ],
        "full_score": TOTAL_FULL_SCORE,
        "max_levels": MAX_LEVELS,
        "safe_levels": list(SAFE_LEVELS),
        "lifelines": [
            {"type": k, "name": LIFELINE_NAMES[k], "discount": v,
             "default": k in DEFAULT_LIFELINES}
            for k, v in _ALL_LIFELINE_DISCOUNT.items()
        ],
        "default_lifelines": list(DEFAULT_LIFELINES),
        "max_lifelines": MAX_LIFELINES,
        "sound_enabled": _sound_enabled_by_admin(),
        "question_types": [
            {"value": "single", "label": "单选题"},
            {"value": "true_false", "label": "判断题"},
        ],
        "time_limits": [60, 90, 120],
        "default_time_limit": DEFAULT_TIME_LIMIT,
        "default_pool_size": DEFAULT_POOL_SIZE,
    }


@router.post("/session", summary="（重）开一场闯关")
async def open_session(request: Request):
    user = get_current_user(request)
    body = await request.json()
    teacher, grade, cls = _scope_from_request(request, user, body)

    subject = str(body.get("subject") or "").strip()
    topics = _norm_topics(body.get("topic") or body.get("topics"))
    topic = "、".join(topics)
    skin = str(body.get("skin") or "")

    if not topic and not subject:
        raise HTTPException(status_code=400, detail="请至少选择学科，或输入一个知识点")

    # 结束上一场（同一老师同一班级）
    old = _load_active_session(teacher, grade, cls)
    if old:
        execute_insert_update("UPDATE class_ladder_sessions SET status='ended', updated_at=? WHERE id=?",
                              (_now(), old["id"]))

    session = _create_session(
        teacher, grade, cls,
        subject=subject, topic=topic,
        ai_enabled=bool(body.get("allow_ai")),
        question_type="true_false" if body.get("question_type") == "true_false" else "single",
        time_limit_sec=_as_time_limit(body.get("time_limit_sec")),
        pool_size=int(body.get("pool_size") or DEFAULT_POOL_SIZE),
        safe_mode=int(body.get("safe_mode") or 0),
        skin=skin or _default_skin(),
        lifelines=body.get("lifelines"),
    )
    return _session_dict(session, grade, cls)


@router.get("/session", summary="查看当前场次（无则 null）")
async def current_session(request: Request):
    user = get_current_user(request)
    teacher, grade, cls = _scope_from_request(request, user, dict(request.query_params))
    session = _load_active_session(teacher, grade, cls)
    return {"session": _session_dict(session, grade, cls) if session else None}


@router.post("/session/pool", summary="生成/补齐题池（题库优先，缺口 AI 补）")
async def build_pool(request: Request):
    user = get_current_user(request)
    body = await request.json()
    teacher, grade, cls = _scope_from_request(request, user, body)
    session = _load_active_session(teacher, grade, cls)
    if not session:
        raise HTTPException(status_code=404, detail="请先开一场")
    result = await _build_pool(session, username=user["username"], grade=grade, cls=cls)
    session["build_note"] = "；".join(result.get("notes") or [])[:300]
    _save_session(session)
    session = execute_query_one("SELECT * FROM class_ladder_sessions WHERE id=?", (session["id"],)) or session
    return {"added": result.get("added", 0), "notes": result.get("notes") or [],
            "session": _session_dict(session, grade, cls)}


@router.post("/session/end", summary="结束本场")
async def end_session(request: Request):
    user = get_current_user(request)
    body = await request.json()
    teacher, grade, cls = _scope_from_request(request, user, body)
    session = _load_active_session(teacher, grade, cls)
    if not session:
        return {"success": True, "session": None}
    execute_insert_update("UPDATE class_ladder_sessions SET status='ended', updated_at=? WHERE id=?",
                          (_now(), session["id"]))
    return {"success": True, "session_id": session["id"]}


@router.get("/sessions", summary="历史场次（教师的；管理员看全部）")
async def list_sessions(request: Request, limit: int = 50):
    user = get_current_user(request)
    limit = max(1, min(int(limit or 50), 200))
    if user.get("role") == ROLE_ADMIN:
        rows = execute_query_dict("SELECT * FROM class_ladder_sessions ORDER BY id DESC LIMIT ?", (limit,))
    else:
        rows = execute_query_dict(
            "SELECT * FROM class_ladder_sessions WHERE teacher_username=? ORDER BY id DESC LIMIT ?",
            (user["username"], limit))
    out = []
    for r in rows:
        agg = execute_query_one(
            "SELECT COUNT(*) AS runs, COALESCE(MAX(ladder_score),0) AS best, COALESCE(SUM(correct_count),0) AS corr "
            "FROM class_ladder_runs WHERE session_id=?", (r["id"],)) or {}
        out.append({
            "session_id": r["id"], "teacher": r.get("teacher_username") or "",
            "grade": r.get("grade") or "", "class": r.get("class_name") or "",
            "subject": r.get("subject") or "", "topic": r.get("topic") or "",
            "status": r.get("status") or "",
            "runs": int(agg.get("runs") or 0), "best_score": int(agg.get("best") or 0),
            "created_at": r.get("created_at") or "",
        })
    return {"sessions": out, "total": len(out)}


@router.delete("/session/{session_id}", summary="删除一场（连同题池与局）")
async def delete_session(session_id: int, request: Request):
    user = get_current_user(request)
    row = execute_query_one("SELECT * FROM class_ladder_sessions WHERE id=?", (session_id,))
    if not row:
        raise HTTPException(status_code=404, detail="场次不存在")
    if user.get("role") != ROLE_ADMIN and row.get("teacher_username") != user["username"]:
        raise HTTPException(status_code=403, detail="无权删除该场次")
    execute_insert_update("DELETE FROM class_ladder_pool WHERE session_id=?", (session_id,))
    # 台账要跟着局走：删场次后抽人记录里不该留下指向不存在局的一行
    execute_insert_update(
        "DELETE FROM pick_ledger WHERE activity='class_ladder' AND ref_table='class_ladder_runs'"
        " AND ref_id IN (SELECT id FROM class_ladder_runs WHERE session_id=?)", (session_id,))
    execute_insert_update("DELETE FROM class_ladder_runs WHERE session_id=?", (session_id,))
    execute_insert_update("DELETE FROM class_ladder_sessions WHERE id=?", (session_id,))
    logger.info(f"[课堂闯关] {user['username']} 删除场次 #{session_id}")
    return {"success": True}


@router.post("/run", summary="开新一局（抽人 + 取 15 题）")
async def open_run(request: Request):
    user = get_current_user(request)
    body = await request.json()
    teacher, grade, cls = _scope_from_request(request, user, body)
    session = _load_active_session(teacher, grade, cls)
    if not session:
        raise HTTPException(status_code=404, detail="请先开一场")

    stats = _pool_stats(session["id"])
    if stats["total"] <= 0:
        raise HTTPException(status_code=404, detail="题池为空，请先生成题目")

    students = _load_students(grade)
    names = [s["name"] for s in students if s.get("class") == cls]
    if not names:
        raise HTTPException(status_code=404, detail="该班级暂无学生名单")

    picked = _pick_student_for(session)
    if not picked:
        raise HTTPException(status_code=404, detail="没有可抽取的学生")

    snaps = _snapshot_questions(session["id"])
    if not snaps:
        raise HTTPException(status_code=404, detail="题池为空，请先生成题目")

    now = _now()
    run_id = execute_insert_update(
        "INSERT INTO class_ladder_runs "
        "(session_id, student_name, student_username, status, reached_level, correct_count, "
        " ladder_score, points_awarded, lifelines_used, lifeline_by_level, questions, answers, "
        " created_at, ended_at) "
        "VALUES (?, ?, ?, 'playing', 0, 0, 0, 0, '[]', '{}', ?, '[]', ?, NULL)",
        (session["id"], picked["name"], picked["username"],
         json.dumps(snaps, ensure_ascii=False), now),
    )
    # 台账那行指回本局，点名管理的抽人记录能一键跳到关卡明细
    pick_engine.attach_ref(pick_id=picked["pick_id"], ref_table="class_ladder_runs", ref_id=int(run_id or 0))
    run = _get_run(run_id) or {}
    return {"run": _run_public(run, session),
            "covered": picked["covered"], "round_no": picked["round_no"],
            "total": picked["total"], "pick_id": picked["pick_id"]}


@router.get("/run/{run_id}", summary="本局状态（含当前关题面，不含答案）")
async def get_run(run_id: int, request: Request):
    user = get_current_user(request)
    run, session = _run_and_session(run_id, user)
    return {"run": _run_public(run, session)}


async def _apply_answer(run_id: int, user: dict, body: dict) -> dict:
    run, session = _run_and_session(run_id, user)
    if run.get("status") != "playing":
        raise HTTPException(status_code=400, detail="本局已结束")

    level = int(body.get("level") or 0)
    if level != _current_level(run):
        raise HTTPException(status_code=400, detail="关卡不匹配，请刷新后重试")
    snaps = _decode(run.get("questions"), [])
    snap = next((s for s in snaps if int(s.get("level") or 0) == level), None)
    if not snap:
        raise HTTPException(status_code=404, detail="题目不存在")

    selected = str(body.get("selected") or "").strip()
    correct_answer = str(snap.get("correct_answer") or "").strip()
    is_timeout = str(body.get("reason") or "") == "timeout"
    ok = (not is_timeout) and bool(selected) and selected.upper() == correct_answer.upper()
    lby = _decode(run.get("lifeline_by_level"), {})
    lifelines = list(lby.get(str(level), []))
    score = _score_with_lifelines(level, lifelines) if ok else 0

    answers = _decode(run.get("answers"), [])
    answers.append({"level": level, "selected": "" if is_timeout else selected,
                    "correct_answer": correct_answer, "correct": ok, "score": score,
                    "lifeline": lifelines, "time_spent": int(body.get("time_spent") or 0),
                    "timeout": is_timeout, "question_id": snap.get("question_id")})
    run["answers"] = answers
    run["reached_level"] = level

    if ok and level < MAX_LEVELS:
        run["correct_count"] = sum(1 for a in answers if a.get("correct"))
        if run.get("student_name"):
            # 过关回升权重（与点名标对、抽问答对加的是同一份班级权重）
            pick_engine.bonus_for_correct(grade=session.get("grade") or "",
                                          cls=session.get("class_name") or "",
                                          student=run["student_name"],
                                          student_key=str(run.get("student_username") or ""))
    else:
        run["status"] = "win" if ok else ("timeout" if is_timeout else "lost")
        run["ended_at"] = _now()
        _settle_run(run, session)
    _save_run(run)

    return {
        "correct": ok,
        "correct_answer": correct_answer,
        "selected": "" if is_timeout else selected,
        "score_added": score,
        "run": _run_public(run, session),
    }


@router.post("/run/{run_id}/answer", summary="提交本关作答（服务端判定）")
async def answer_run(run_id: int, request: Request):
    user = get_current_user(request)
    body = await request.json()
    return await _apply_answer(run_id, user, body)


@router.post("/run/{run_id}/timeout", summary="超时提交（=答错终止）")
async def timeout_run(run_id: int, request: Request):
    user = get_current_user(request)
    body = await request.json()
    body["reason"] = "timeout"
    body["selected"] = ""
    return await _apply_answer(run_id, user, body)


@router.post("/run/{run_id}/lifeline", summary="使用锦囊")
async def use_lifeline(run_id: int, request: Request):
    user = get_current_user(request)
    body = await request.json()
    run, session = _run_and_session(run_id, user)
    if run.get("status") != "playing":
        raise HTTPException(status_code=400, detail="本局已结束")
    kind = str(body.get("type") or "")
    if kind not in _session_lifelines(session):
        raise HTTPException(status_code=400, detail="无效的锦囊类型")
    used = _decode(run.get("lifelines_used"), [])
    if kind in used:
        raise HTTPException(status_code=400, detail="该锦囊本局已使用过")

    level = _current_level(run)
    snaps = _decode(run.get("questions"), [])
    snap = next((s for s in snaps if int(s.get("level") or 0) == level), None)
    if not snap:
        raise HTTPException(status_code=404, detail="题目不存在")

    qtype = snap.get("question_type") or "single"
    opts = snap.get("options") or []
    keys = [_option_key(o, i, qtype) for i, o in enumerate(opts)]

    # 「现场表决」：老师录入各选项举手人数 —— 先校验，别把锦囊白烧掉
    counts: dict[str, int] = {}
    if kind == "class_vote":
        raw = body.get("votes") or {}
        for k in keys:
            try:
                counts[k] = max(0, int((raw or {}).get(k, 0) or 0))
            except (TypeError, ValueError):
                counts[k] = 0
        if sum(counts.values()) <= 0:
            raise HTTPException(status_code=400, detail="请先填写各选项的举手人数")

    lby = _decode(run.get("lifeline_by_level"), {})
    lby.setdefault(str(level), []).append(kind)
    run["lifeline_by_level"] = lby
    run["lifelines_used"] = used + [kind]
    _save_run(run)

    result: dict[str, Any] = {
        "type": kind, "success": True,
        "score_after": _score_with_lifelines(level, lby[str(level)]),
    }
    if kind == "remove_one":
        wrong = [k for k in keys if k.upper() != str(snap.get("correct_answer") or "").strip().upper()]
        if wrong:
            result["removed"] = random.choice(wrong)
    elif kind == "class_vote":
        total = sum(counts.values())
        result["counts"] = counts
        result["votes"] = {k: round(v * 100 / total) for k, v in counts.items()}
        result["total_voters"] = total
    elif kind == "helper":
        # 名册与权重都由引擎取，这里只需要"排除本局在台学生"
        helper = _pick_student_for(session, exclude=run.get("student_name") or "")
        if not helper:
            raise HTTPException(status_code=404, detail="该班级暂无学生名单")
        result["student"] = helper["name"]
        result["student_username"] = helper["username"]
        # 军师只是被叫起来帮忙，不答题：台账里当场定性，不留"待作答"的行
        pick_engine.finish(grade=session.get("grade") or "", cls=session.get("class_name") or "",
                           activity=pick_engine.ACT_LADDER, student=helper["name"],
                           result="helper", points=0, pick_id=helper["pick_id"],
                           ref_table="class_ladder_runs", ref_id=int(run.get("id") or 0),
                           note="请军师", teacher=session.get("teacher_username") or "")
    else:
        result.update(await _ai_lifeline(kind, snap, user["username"]))
    return result


@router.get("/run/{run_id}/result", summary="本局结算（逐关明细 + 解析复盘）")
async def run_result(run_id: int, request: Request):
    user = get_current_user(request)
    run, session = _run_and_session(run_id, user)
    if run.get("status") == "playing":
        raise HTTPException(status_code=400, detail="本局尚未结束")
    snaps = {int(s.get("level") or 0): s for s in _decode(run.get("questions"), [])}
    detail = []
    for a in _decode(run.get("answers"), []):
        s = snaps.get(int(a.get("level") or 0), {})
        detail.append({
            "level": a.get("level"), "correct": bool(a.get("correct")),
            "selected": a.get("selected") or "", "correct_answer": a.get("correct_answer") or "",
            "score": int(a.get("score") or 0), "lifeline": a.get("lifeline") or [],
            "question": s.get("question_text") or "", "options": s.get("options") or [],
            "explanation": s.get("explanation") or "", "source": s.get("source") or "",
            "svg_content": s.get("svg_content") or "", "has_svg": int(s.get("has_svg") or 0),
            "media_files": s.get("media_files") or "",
            "media_placeholders": s.get("media_placeholders") or "",
        })
    return {"run": _run_public(run, session, with_question=False), "detail": detail}


@router.get("/board", summary="本场红榜")
async def board(request: Request, limit: int = 20):
    user = get_current_user(request)
    teacher, grade, cls = _scope_from_request(request, user, dict(request.query_params))
    session = _load_active_session(teacher, grade, cls)
    if not session:
        return {"session": None, "rows": [], "best": None}
    rows = execute_query_dict(
        "SELECT id, student_name, status, reached_level, correct_count, ladder_score, created_at "
        "FROM class_ladder_runs WHERE session_id=? "
        "ORDER BY ladder_score DESC, correct_count DESC, id ASC LIMIT ?",
        (session["id"], max(1, min(int(limit or 20), 100))),
    )
    best = rows[0] if rows else None
    return {"session": _session_dict(session, grade, cls), "rows": rows, "best": best}


@router.get("/records", summary="本场流水（最近的在前）")
async def records(request: Request, limit: int = 50):
    user = get_current_user(request)
    teacher, grade, cls = _scope_from_request(request, user, dict(request.query_params))
    session = _load_active_session(teacher, grade, cls)
    if not session:
        return {"session": None, "records": []}
    rows = execute_query_dict(
        "SELECT id, student_name, status, reached_level, correct_count, ladder_score, "
        "points_awarded, lifelines_used, created_at, ended_at FROM class_ladder_runs "
        "WHERE session_id=? ORDER BY id DESC LIMIT ?",
        (session["id"], max(1, min(int(limit or 50), 200))),
    )
    for r in rows:
        r["lifelines_used"] = _decode(r.get("lifelines_used"), [])
    return {"session": _session_dict(session, grade, cls), "records": rows}

@router.post("/session/pool/async", summary="后台生成/补齐题池（带进度，AI 补题时不阻塞）")
async def build_pool_async(request: Request):
    """与 /session/pool 同一条取题链路，但放到后台任务里跑，前端轮询进度。

    题库充足时它和同步版一样快；只有 AI 补题时才体现出"页面不卡"的价值。
    """
    user = get_current_user(request)
    body = await request.json()
    teacher, grade, cls = _scope_from_request(request, user, body)
    session = _load_active_session(teacher, grade, cls)
    if not session:
        raise HTTPException(status_code=404, detail="请先开一场")
    sid = int(session["id"])

    async def _job() -> dict:
        from backend.ai_task_manager import report_progress
        cur = execute_query_one("SELECT * FROM class_ladder_sessions WHERE id=?", (sid,))
        if not cur:
            return {"added": 0, "notes": ["场次已不存在"]}
        report_progress(phase="pool", done=0, total=1, message="开始取题")
        res = await _build_pool(cur, username=user["username"], grade=grade, cls=cls)
        cur["build_note"] = "；".join(res.get("notes") or [])[:300]
        _save_session(cur)
        report_progress(phase="pool", done=1, total=1, message="取题完成")
        return {"added": res.get("added", 0), "notes": res.get("notes") or []}

    from backend.ai_task_manager import TooManyAITasks, task_manager
    try:
        task_id = await task_manager.create_task(
            description=f"课堂闯关 取题：{session.get('topic') or (grade + cls)}",
            coro_factory=_job, owner_username=user["username"],
            dedupe_key=f"class-ladder-pool:{sid}", reuse_completed=False, max_concurrent=3)
    except TooManyAITasks as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
    return {"task_id": task_id, "accepted": True}


@router.get("/session/report", summary="本场战报（红榜 + 每局逐关明细）")
async def session_report(request: Request):
    user = get_current_user(request)
    teacher, grade, cls = _scope_from_request(request, user, dict(request.query_params))
    session = _load_active_session(teacher, grade, cls)
    if not session:
        return {"session": None, "board": [], "runs": []}
    rows = execute_query_dict(
        "SELECT * FROM class_ladder_runs WHERE session_id=? ORDER BY ladder_score DESC, id ASC",
        (session["id"],))
    runs = []
    for r in rows:
        answers = _decode(r.get("answers"), [])
        snaps = {int(s.get("level") or 0): s for s in _decode(r.get("questions"), [])}
        detail = []
        for a in answers:
            s = snaps.get(int(a.get("level") or 0), {})
            detail.append({
                "level": a.get("level"), "correct": bool(a.get("correct")),
                "timeout": bool(a.get("timeout")), "selected": a.get("selected") or "",
                "correct_answer": a.get("correct_answer") or "", "score": int(a.get("score") or 0),
                "lifeline": a.get("lifeline") or [], "question": s.get("question_text") or "",
            })
        runs.append({
            "run_id": r["id"], "student": r.get("student_name") or "",
            "status": r.get("status") or "", "reached_level": int(r.get("reached_level") or 0),
            "correct_count": int(r.get("correct_count") or 0),
            "ladder_score": int(r.get("ladder_score") or 0),
            "points_awarded": int(r.get("points_awarded") or 0),
            "created_at": r.get("created_at") or "", "detail": detail,
        })
    return {"session": _session_dict(session, grade, cls), "board": rows, "runs": runs}