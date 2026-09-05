"""
自适应出题 API 路由
教师：AI 出题 → 布置到班级
学生：查看练习 → 答题 → 提交 → 看结果
"""
import json
import re
import sqlite3
import asyncio
import traceback
from datetime import datetime
from typing import Optional, Any

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.question_db import execute_insert, execute_query, execute_query_one, execute_update
from backend.database import execute_query as db_execute_query, execute_insert_update as db_execute_update
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_async
from backend.utils import extract_json_from_text
from backend.api.config_router import get_config_value
from backend.logger import logger
from backend.prompts import apply_skills, build_ai_role
from backend.async_utils import spawn_bg as _spawn_bg

router = APIRouter()

TYPE_DESC_MAP = {
    "single": "单选题（4个选项）",
    "multiple": "多选题（多个正确选项）",
    "true_false": "判断题",
    "short": "简答题",
    "fill": "填空题",
    "essay": "作文",
    "subjective": "主观题",
    "mixed": "混合出题（AI 自动搭配单选/多选/判断/简答/填空等）",
}


# ── 请求模型 ──

class PracticeGenerateRequest(BaseModel):
    """教师：AI 出题"""
    knowledge_points: str
    subject: str = ""
    question_type: str = "mixed"
    count: int = 5
    difficulty: str = "medium"


class PracticeCreateSession(BaseModel):
    """教师：创建练习任务"""
    title: str
    knowledge_points: str
    question_ids: list[int]
    scores: Optional[list[int]] = None
    target_grade: str = ""
    target_class: str = ""
    target_students: list[str] = []
    subject: str = ""


class PracticeSubmitRequest(BaseModel):
    """学生：提交答案"""
    answers: dict[str, str]


# ════════════════════════════════════════════
# 教师端
# ════════════════════════════════════════════

# ════════════════════════════════════════════
# 共用工具：权限 / 可见性 / 归一化 / 后台任务
# ════════════════════════════════════════════

# 走 AI 语义批改的题型(P5: 主观题必须有人批改, 不允许静默丢题)
AI_GRADED_TYPES = ("short", "fill", "essay", "subjective")

_ANS_SEP_RE = re.compile(r"[,，;；、/\s|]+")

def _num_class(v: Any) -> str:
    """班级归一化: '高一1班' / '1班' / '01' / 1 -> '1'"""
    digits = re.sub(r"\D", "", str(v if v is not None else ""))
    return digits.lstrip("0")


def _normalize_objective_answer(v: Any) -> str:
    """P7: 客观题答案归一化(去分隔符/空白 + 大写 + 排序, 使多选 AC 与 CA 等价)"""
    return "".join(sorted(_ANS_SEP_RE.sub("", str(v if v is not None else "")).upper()))


def _is_correct_objective(student_ans: str, correct: str) -> bool:
    ref = _normalize_objective_answer(correct)
    return bool(ref) and _normalize_objective_answer(student_ans) == ref


def _parse_target_students(raw: Any) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw]
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    return [str(x) for x in data] if isinstance(data, list) else []


def _student_scope(username: str) -> tuple[str, str]:
    """学生的年级与班级(users 在 smartkb.db)"""
    rows = db_execute_query("SELECT grade, class FROM users WHERE username=?", (username,))
    if not rows:
        return "", ""
    return (rows[0][0] or "").strip(), str(rows[0][1] or "").strip()


def _session_visible_to_student(sess: dict, username: str, grade: str, cls: str) -> bool:
    """P2/P9: 练习是否对该学生开放 —— 定向名单优先, 否则按年级+班级范围"""
    targets = _parse_target_students(sess.get("target_students"))
    if targets:
        return username in targets
    sg = (sess.get("target_grade") or "").strip()
    if sg and sg != grade:
        return False
    sc = _num_class(sess.get("target_class"))
    if sc and sc != _num_class(cls):
        return False
    return True


def _assert_student_session(sess: dict, username: str) -> None:
    """学生取题/提交前的范围与状态校验"""
    if (sess.get("status") or "") == "ended":
        raise HTTPException(status_code=400, detail="该练习已结束，无法继续作答或提交")
    grade, cls = _student_scope(username)
    if not _session_visible_to_student(sess, username, grade, cls):
        raise HTTPException(status_code=403, detail="该练习未分配给你")


def _user_info_map(usernames: set[str]) -> dict[str, dict[str, str]]:
    """批量取学生/教师姓名与班级(避免逐行查询)"""
    if not usernames:
        return {}
    ph = ",".join("?" for _ in usernames)
    rows = db_execute_query(
        f"SELECT username, name, grade, class FROM users WHERE username IN ({ph})",
        tuple(usernames),
    )
    out = {}
    for r in rows or []:
        out[r[0]] = {"name": (r[1] or r[0]), "grade": (r[2] or ""), "class": str(r[3] or "")}
    for u in usernames:
        out.setdefault(u, {"name": u, "grade": "", "class": ""})
    return out


def _grade_class_totals() -> tuple[dict[tuple[str, str], int], dict[str, int], int]:
    """一次统计全校学生分布: {(年级,班级): 人数}, {年级: 人数}, 总人数"""
    rows = db_execute_query("SELECT grade, class, COUNT(*) FROM users WHERE role=2 GROUP BY grade, class")
    by_gc: dict[tuple[str, str], int] = {}
    by_grade: dict[str, int] = {}
    total = 0
    for r in rows or []:
        g = (r[0] or "").strip()
        c = _num_class(r[1])
        n = r[2] or 0
        by_gc[(g, c)] = by_gc.get((g, c), 0) + n
        by_grade[g] = by_grade.get(g, 0) + n
        total += n
    return by_gc, by_grade, total


# ════════════════════════════════════════════
# 教师端
# ════════════════════════════════════════════

def _validate_generate(req: PracticeGenerateRequest, user: dict) -> tuple[str, str]:
    username = user["username"]
    if user.get("role", 2) not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可出题")
    if not req.knowledge_points.strip():
        raise HTTPException(status_code=400, detail="请输入知识点")
    if req.count < 1 or req.count > 20:
        raise HTTPException(status_code=400, detail="数量范围为 1-20")
    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")
    return username, api_key


def _build_generate_prompt(req: PracticeGenerateRequest) -> str:
    from backend.prompts.practice import PRACTICE_GENERATE_PROMPT
    type_desc = TYPE_DESC_MAP.get(req.question_type, "混合出题")
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(req.difficulty, "中等")
    # 注意：不注入技能 —— 技能的结构化输出指令与 JSON 格式要求冲突
    return f"{build_ai_role(subject=req.subject)}\n" + PRACTICE_GENERATE_PROMPT.format(
        subject=req.subject, knowledge_points=req.knowledge_points,
        type_desc=type_desc, count=req.count, difficulty_desc=difficulty_desc,
    )


async def _persist_generated_questions(questions: list[dict], req: PracticeGenerateRequest,
                                       username: str) -> list[dict]:
    """P11: 同步/异步两个出题端点共用一套入库逻辑(P10: 命中重复题时回填题库已有的图与媒体)"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for q in questions:
        q_text = (q.get("question") or "").strip()
        if not q_text:
            continue
        dup = execute_query(
            """SELECT id, svg_content, has_svg, media_files FROM question_bank
               WHERE knowledge_points LIKE ? AND question_text=? AND status='active' LIMIT 1""",
            (f"%{req.knowledge_points}%", q_text),
        )
        if dup:
            logger.info(f"跳过重复题目 (kp={req.knowledge_points}): {q_text[:40]}...")
            old = dict(dup[0])
            q["id"] = old["id"]
            q["index"] = old["id"]
            q["svg_content"] = old.get("svg_content") or ""
            q["has_svg"] = old.get("has_svg") or 0
            raw_media = old.get("media_files")
            try:
                q["media_files"] = json.loads(raw_media) if isinstance(raw_media, str) and raw_media else (raw_media or [])
            except (json.JSONDecodeError, TypeError):
                q["media_files"] = []
            continue

        opts = json.dumps(q.get("options", {}), ensure_ascii=False) if q.get("options") else ""
        svg_code = q.get("svg_code") or ""
        has_svg = 1 if svg_code.strip() else 0
        media_placeholders = json.dumps(q.get("media_placeholders") or [], ensure_ascii=False)
        qid = execute_insert(
            """INSERT INTO question_bank (type,question_text,options,correct_answer,explanation,
                knowledge_points,subject,difficulty,creator_username,source,status,created_at,updated_at,
                svg_content,has_svg,media_placeholders)
               VALUES (?,?,?,?,?,?,?,?,?,'ai','active',?,?,?,?,?)""",
            (q.get("type", "single"), q_text, opts,
             q.get("answer", ""), q.get("explanation", ""),
             q.get("knowledge_point", req.knowledge_points), req.subject,
             q.get("difficulty", req.difficulty), username, now, now,
             svg_code, has_svg, media_placeholders),
        )
        if qid is None:
            logger.warning(f"题目入库失败, 已跳过: {q_text[:40]}")
            continue
        q["id"] = qid
        q["index"] = qid
        # 统一字段名：AI 返回 svg_code -> 前端用 svg_content
        if "svg_code" in q and "svg_content" not in q:
            q["svg_content"] = q["svg_code"]
        if "has_svg" not in q:
            q["has_svg"] = 1 if q.get("svg_code") or q.get("svg_content") else 0

        placeholders = q.get("media_placeholders") or []
        media_files: list = []
        if placeholders and get_config_value("IMAGE_GEN_ENABLED", True):
            from backend.api.image_gen_service import generate_placeholders_batch
            from backend.config import BASE_DIR
            media_dir = BASE_DIR / "question_media" / str(qid)
            try:
                media_files = await generate_placeholders_batch(
                    placeholders=placeholders, subject=req.subject,
                    media_dir=media_dir, qid=qid, now=now,
                ) or []
                execute_update(
                    "UPDATE question_bank SET media_placeholders=?, media_files=? WHERE id=?",
                    (json.dumps(placeholders, ensure_ascii=False),
                     json.dumps(media_files, ensure_ascii=False), qid),
                )
            except Exception as gen_err:
                # 配图失败只降级为无图题, 不能让整次出题作废
                logger.warning(f"题目 {qid} 自动配图失败: {gen_err}")
        q["media_files"] = media_files
    return questions


@router.post("/generate")
async def generate_practice(req: PracticeGenerateRequest, request: Request):
    """[教师] AI 出题（同步版，仅预览不布置；建议用 /generate-async 避免长请求）"""
    user = get_current_user(request)
    username, api_key = _validate_generate(req, user)
    prompt = _build_generate_prompt(req)

    try:
        result_text = await call_ai_async(prompt, api_key)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 出题失败: {str(e)}")

    questions = _parse_ai_result(result_text)[: req.count]
    if not questions:
        raise HTTPException(status_code=502, detail="AI 返回格式异常，未能解析出题目")
    await _persist_generated_questions(questions, req, username)

    return {"questions": questions, "total": len(questions), "message": f"已生成 {len(questions)} 道题"}


@router.post("/generate-async")
async def generate_practice_async(req: PracticeGenerateRequest, request: Request):
    """[教师] AI 异步出题（后台任务，不阻塞）"""
    user = get_current_user(request)
    username, api_key = _validate_generate(req, user)
    prompt = _build_generate_prompt(req)

    from backend.ai_task_manager import task_manager

    async def _generate_and_save() -> dict[str, Any]:
        result_text = await call_ai_async(prompt, api_key)
        questions = _parse_ai_result(result_text)[: req.count]
        if not questions:
            raise ValueError("AI 返回格式异常，未能解析出题目")
        await _persist_generated_questions(questions, req, username)
        return {"questions": questions, "total": len(questions)}

    task_id = await task_manager.create_task(
        description=f"教师 {username} 出题：{req.knowledge_points}",
        coro_factory=_generate_and_save,
    )
    return {"task_id": task_id, "message": "AI 已开始出题，请稍候..."}


@router.post("/sessions")
async def create_session(req: PracticeCreateSession, request: Request):
    """[教师] 创建练习任务并布置到班级"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可布置练习")

    if not req.title.strip():
        raise HTTPException(status_code=400, detail="请输入练习标题")
    if not req.question_ids:
        raise HTTPException(status_code=400, detail="请选择题目")

    # 题目必须存在且未被删除, 否则会布置出无法判分的练习
    qph = ",".join("?" for _ in req.question_ids)
    alive = {r["id"] for r in execute_query(
        f"SELECT id FROM question_bank WHERE id IN ({qph}) AND status='active'",
        tuple(req.question_ids),
    )}
    missing = [qid for qid in req.question_ids if qid not in alive]
    if missing:
        raise HTTPException(status_code=400, detail=f"部分题目不存在或已被删除: {missing}")

    # 分值归一(缺省 10 分, 限制 1-100), 避免 0/负分把得分率算成无穷大
    scores: list[int] = []
    for i in range(len(req.question_ids)):
        raw = req.scores[i] if req.scores and i < len(req.scores) else 10
        try:
            val = int(raw)
        except (TypeError, ValueError):
            val = 10
        scores.append(min(max(val, 1), 100))
    total = sum(scores)

    target_students_str = json.dumps(req.target_students, ensure_ascii=False) if req.target_students else ""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    session_id = execute_insert(
        """INSERT INTO practice_sessions
           (title, knowledge_points, creator_username, subject, question_count,
            total_score, target_grade, target_class, target_students, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)""",
        (req.title.strip(), req.knowledge_points, username, req.subject,
         len(req.question_ids), total, req.target_grade, req.target_class,
         target_students_str, now, now),
    )

    for i, qid in enumerate(req.question_ids):
        execute_insert(
            "INSERT INTO practice_session_questions (session_id, question_id, sort_order, score) VALUES (?,?,?,?)",
            (session_id, qid, i, scores[i]),
        )

    logger.info(f"教师 {username} 创建练习任务 {session_id} → {req.target_grade or '全部年级'} {req.target_class or '全部班级'}")
    return {"session_id": session_id, "message": "练习任务已发布", "total_score": total}


@router.get("/sessions")
async def list_teacher_sessions(request: Request):
    """[教师] 查看自己创建的练习任务（root 可查看全部）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 0:
        rows = execute_query('SELECT * FROM practice_sessions ORDER BY created_at DESC')
    else:
        rows = execute_query(
            'SELECT * FROM practice_sessions WHERE creator_username=? ORDER BY created_at DESC',
            (username,),
        )
    if not rows:
        return {"sessions": []}

    # P8: 提交数与姓名都改为批量查询(原来每行 3 次 SQL, 练习一多就卡)
    sids = [r["id"] for r in rows]
    sph = ",".join("?" for _ in sids)
    sub_map = {
        r["session_id"]: r["c"] for r in execute_query(
            f"SELECT session_id, COUNT(DISTINCT student_username) c FROM practice_attempts "
            f"WHERE session_id IN ({sph}) GROUP BY session_id",
            tuple(sids),
        )
    }
    creator_map = _user_info_map({r["creator_username"] for r in rows if r.get("creator_username")})

    by_gc: dict[tuple[str, str], int] = {}
    by_grade: dict[str, int] = {}
    all_students = 0
    if any(not _parse_target_students(r.get("target_students")) for r in rows):
        by_gc, by_grade, all_students = _grade_class_totals()

    sessions = []
    for r in rows:
        target_students = _parse_target_students(r.get("target_students"))
        grade = (r.get("target_grade") or "").strip()
        cls = _num_class(r.get("target_class"))
        # P3: 之前按年级布置(未指定班级)时目标人数恒为 0, 列表显示 "2/0"
        if target_students:
            student_count = len(target_students)
        elif grade and cls:
            student_count = by_gc.get((grade, cls), 0)
        elif grade:
            student_count = by_grade.get(grade, 0)
        elif cls:
            student_count = sum(n for (_g, c), n in by_gc.items() if c == cls)
        else:
            student_count = all_students

        sessions.append({
            "id": r["id"], "title": r["title"],
            "knowledge_points": r["knowledge_points"],
            "subject": r["subject"], "question_count": r["question_count"],
            "total_score": r["total_score"],
            "target_grade": r["target_grade"], "target_class": r["target_class"],
            "target_students": target_students,
            "status": r["status"],
            "source": r.get("source") or "teacher",
            "creator_name": creator_map.get(r.get("creator_username", ""), {}).get("name") or r.get("creator_username", ""),
            "student_count": student_count,
            "submitted_count": sub_map.get(r["id"], 0),
            "created_at": r["created_at"],
        })

    return {"sessions": sessions}


@router.get("/sessions/{session_id}")
async def get_session_detail(session_id: int, request: Request):
    """[教师] 查看练习详情（含提交情况与未交名单）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    # P1: 本端点含正确答案与其他学生成绩, 学生账号一律拒绝
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看练习详情")

    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")
    if role != 0 and sess["creator_username"] != username:
        raise HTTPException(status_code=403, detail="只能查看自己创建的练习")

    questions = execute_query(
        """SELECT psq.*, qb.question_text, qb.type, qb.options, qb.correct_answer,
                  qb.explanation, qb.knowledge_points,
                  qb.svg_content, qb.has_svg, qb.media_files, qb.media_placeholders
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )
    for q in questions:
        for field in ("options", "media_files", "media_placeholders"):
            if isinstance(q.get(field), str) and q.get(field):
                try:
                    q[field] = json.loads(q[field])
                except (json.JSONDecodeError, TypeError):
                    q[field] = None

    attempts = execute_query(
        'SELECT * FROM practice_attempts WHERE session_id=? ORDER BY score DESC',
        (session_id,),
    )
    target_students = _parse_target_students(sess.get("target_students"))

    # 目标学生名单(定向名单优先, 否则按年级/班级范围), 用于教师看"谁没交"
    if target_students:
        tph = ",".join("?" for _ in target_students)
        urows = db_execute_query(
            f"SELECT username, name, class FROM users WHERE role=2 AND username IN ({tph})",
            tuple(target_students),
        ) or []
    else:
        grade = (sess.get("target_grade") or "").strip()
        if grade:
            urows = db_execute_query(
                "SELECT username, name, class FROM users WHERE role=2 AND grade=?", (grade,)
            ) or []
        else:
            urows = db_execute_query(
                "SELECT username, name, class FROM users WHERE role=2"
            ) or []
        want_cls = _num_class(sess.get("target_class"))
        if want_cls:
            urows = [r for r in urows if _num_class(r[2]) == want_cls]

    info = _user_info_map({a["student_username"] for a in attempts} | {r[0] for r in urows})
    for a in attempts:
        meta = info.get(a["student_username"], {})
        a["student_name"] = meta.get("name") or a["student_username"]
        a["student_class"] = meta.get("class") or ""
        a["student_grade"] = meta.get("grade") or ""

    att_map = {a["student_username"]: a for a in attempts}
    students = [{
        "username": r[0],
        "name": r[1] or r[0],
        "class": str(r[2] or ""),
        "submitted": r[0] in att_map,
        "score": att_map[r[0]]["score"] if r[0] in att_map else None,
        "total_score": att_map[r[0]]["total_score"] if r[0] in att_map else None,
        "submitted_at": att_map[r[0]]["submitted_at"] if r[0] in att_map else None,
    } for r in urows]
    students.sort(key=lambda x: (bool(x["submitted"]), _num_class(x["class"]), x["name"]))

    sess_dict = dict(sess)
    sess_dict["target_students"] = target_students

    return {
        "session": sess_dict,
        "questions": questions,
        "attempts": attempts,
        "students": students,
    }


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: int, request: Request):
    """[教师] 删除练习任务"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")
    if role != 0 and sess["creator_username"] != username:
        raise HTTPException(status_code=403, detail="只能删除自己的练习")

    left = execute_query_one("SELECT COUNT(*) c FROM practice_attempts WHERE session_id=?", (session_id,))
    logger.info(f"删除练习 {session_id}(操作者 {username}): 连带清除 {left['c'] if left else 0} 条学生提交记录")
    execute_update("DELETE FROM practice_attempts WHERE session_id=?", (session_id,))
    execute_update("DELETE FROM practice_session_questions WHERE session_id=?", (session_id,))
    # 清理关联的积分奖励(P14: 原来用只读 helper 执行 DELETE, 事务不提交被静默回滚, 奖励记录永久残留)
    db_execute_update(
        "DELETE FROM activity_rewards WHERE activity_type='practice' AND activity_id=?",
        (str(session_id),),
    )
    execute_update("DELETE FROM practice_sessions WHERE id=?", (session_id,))
    return {"message": "已删除"}


@router.put("/sessions/{session_id}/end")
async def end_session(session_id: int, request: Request):
    """[教师] 结束练习任务（标记为结束，学生不可再提交）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")
    if role != 0 and sess["creator_username"] != username:
        raise HTTPException(status_code=403, detail="只能结束自己的练习")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update("UPDATE practice_sessions SET status='ended', updated_at=? WHERE id=?", (now, session_id))
    return {"message": "已结束"}


# ════════════════════════════════════════════
# 学生端
# ════════════════════════════════════════════

# ════════════════════════════════════════════
# 学生端
# ════════════════════════════════════════════

@router.get("/my-sessions")
async def list_my_practices(request: Request):
    """[学生] 查看分配给自己的练习任务"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        # 教师/管理员查看自己布置的练习
        return await list_teacher_sessions(request)

    grade, cls = _student_scope(username)

    # P9: 可见性只由 target_* 决定。旧实现额外要求"发布者必须是本班教师或管理员",
    #     导致①任教该课程但未列该班的教师发的年级练习学生永远看不到;
    #     ②系统自动生成的错题巩固练习(creator=system)学生看不到。
    rows = execute_query(
        """SELECT ps.*,
                  (SELECT COUNT(*) FROM practice_attempts pa
                    WHERE pa.session_id = ps.id AND pa.student_username = ?) AS attempted
           FROM practice_sessions ps
           WHERE ps.status = 'active'
             AND (
               (COALESCE(ps.target_students, '') <> '' AND ps.target_students LIKE ?)
               OR
               (COALESCE(ps.target_students, '') = ''
                 AND (COALESCE(ps.target_grade, '') = '' OR ps.target_grade = ?))
             )
           ORDER BY ps.created_at DESC""",
        (username, f'%"{username}"%', grade),
    )
    # 精确判定(班级归一化 + 定向名单成员), SQL 只做粗筛
    visible = [r for r in rows if _session_visible_to_student(r, username, grade, cls)]
    creator_map = _user_info_map({r["creator_username"] for r in visible if r.get("creator_username")})

    result = []
    for s_ in visible:
        result.append({
            "id": s_["id"], "title": s_["title"],
            "knowledge_points": s_["knowledge_points"],
            "subject": s_["subject"], "question_count": s_["question_count"],
            "total_score": s_["total_score"],
            "creator_name": creator_map.get(s_.get("creator_username", ""), {}).get("name") or s_.get("creator_username", ""),
            "source": s_.get("source") or "teacher",
            "attempted": bool(s_["attempted"]),
            "created_at": s_["created_at"],
        })

    return {"sessions": result}


def _existing_attempt_payload(existing: dict) -> dict:
    """已提交记录 → 与首次提交同构的返回体(避免并发时重复判分)"""
    raw = existing.get("answers")
    try:
        graded = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (json.JSONDecodeError, TypeError):
        graded = {}
    if not isinstance(graded, dict):
        graded = {}
    tot = max(existing.get("total_score") or 0, 1)
    return {
        "score": existing.get("score") or 0,
        "total_score": existing.get("total_score") or 0,
        "accuracy": round((existing.get("score") or 0) / tot * 100, 1),
        "results": graded,
        "submitted_at": existing.get("submitted_at"),
        "note": "你已提交过此练习，以下是已有成绩",
        "reward_note": "积分奖励已发放",
    }


@router.get("/my-sessions/{session_id}")
async def get_my_practice(session_id: int, request: Request):
    """[学生] 获取练习题目（开始答题）"""
    user = get_current_user(request)
    username = user["username"]

    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")

    # 检查是否已提交
    existing = execute_query_one(
        "SELECT * FROM practice_attempts WHERE session_id=? AND student_username=?",
        (session_id, username),
    )
    if existing:
        # 已提交过 → 直接返回结果（练习结束后仍可查看成绩）
        return await _get_practice_result(session_id, username)

    # P2/P4: 未分配给该生或已结束的练习不允许再开始作答
    _assert_student_session(sess, username)

    questions = execute_query(
        """SELECT psq.id as eq_id, psq.sort_order, psq.score,
                  qb.id, qb.type, qb.question_text, qb.options, qb.difficulty,
                  qb.svg_content, qb.has_svg, qb.media_files
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )
    for q in questions:
        for field in ("options", "media_files"):
            raw = q.get(field)
            if isinstance(raw, str) and raw.strip():
                try:
                    q[field] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    q[field] = None
            elif not raw:
                q[field] = [] if field == "media_files" else None

    sess_dict = dict(sess)
    sess_dict.pop("target_students", None)  # 不把其他学生名单下发给个人

    return {"session": sess_dict, "questions": questions}


@router.post("/my-sessions/{session_id}/submit")
async def submit_practice(session_id: int, req: PracticeSubmitRequest, request: Request):
    """[学生] 提交练习答案"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可提交")

    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")

    # 防重复提交 — 如已提交，直接返回已有成绩
    existing = execute_query_one(
        "SELECT * FROM practice_attempts WHERE session_id=? AND student_username=?",
        (session_id, username),
    )
    if existing:
        return _existing_attempt_payload(existing)

    # P2/P4: 练习必须仍在进行且确实分配给了该生(否则可枚举 session 刷参与积分)
    _assert_student_session(sess, username)

    questions = execute_query(
        """SELECT qb.id, qb.type, qb.correct_answer, qb.question_text, psq.score
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )
    if not questions:
        raise HTTPException(status_code=400, detail="该练习没有可作答的题目")

    total = 0
    earned = 0.0
    graded: dict[str, Any] = {}
    student_answers = req.answers or {}

    def _ans_of(qid: Any) -> str:
        v = student_answers.get(str(qid), "")
        return "" if v is None else str(v)

    # P5: 主观题(含 essay/subjective)一律进 AI 批改, 不再被两个列表同时漏掉
    ai_questions = [q for q in questions if q["type"] in AI_GRADED_TYPES]
    obj_questions = [q for q in questions if q["type"] not in AI_GRADED_TYPES]

    def _keyword_fallback(q: dict, student_ans: str) -> dict:
        """无 AI / AI 失败时: 按逗号分隔关键词命中给分"""
        correct = q["correct_answer"] or ""
        q_score = q["score"] or 10
        keywords = [k.strip().lower() for k in re.split(r"[,，;；、\n]+", correct) if k.strip()]
        hit = bool(keywords) and any(kw in student_ans.lower() for kw in keywords)
        return {
            "student_answer": student_ans, "correct_answer": correct,
            "score": q_score if hit else 0, "max_score": q_score, "is_correct": hit,
        }

    # 客观题：归一化后精确匹配(P7: 多选 AC 与 CA 等价)
    for q in obj_questions:
        qid = str(q["id"])
        student_ans = _ans_of(q["id"])
        correct = q["correct_answer"] or ""
        q_score = q["score"] or 10
        is_correct = _is_correct_objective(student_ans, correct)
        earned += q_score if is_correct else 0
        total += q_score
        graded[qid] = {
            "student_answer": student_ans, "correct_answer": correct,
            "score": q_score if is_correct else 0, "max_score": q_score,
            "is_correct": is_correct,
        }

    # 主观题：AI 语义批改（并发）
    if ai_questions:
        api_key, _ = get_api_keys(username)
        if api_key:
            sem = asyncio.Semaphore(3)

            async def _grade_ai(q):
                qid = str(q["id"])
                student_ans = _ans_of(q["id"])
                correct = q["correct_answer"] or ""
                q_score = q["score"] or 10
                async with sem:
                    try:
                        from backend.prompts.teaching import SHORT_ANSWER_GRADING_PROMPT
                        prompt = SHORT_ANSWER_GRADING_PROMPT.format(
                            question_text=str(q.get("question_text", "")).replace('{', '{{').replace('}', '}}'),
                            correct_answer=correct.replace('{', '{{').replace('}', '}}'),
                            max_score=str(q_score),
                            half_score=str(q_score * 0.5),
                            near_full=str(q_score * 0.8),
                            half_minus=str(q_score * 0.4),
                            student_answer=student_ans.replace('{', '{{').replace('}', '}}'),
                        )
                        prompt = apply_skills(prompt, "practice")
                        ai_resp = await call_ai_async(prompt, api_key)
                        result = extract_json_from_text(ai_resp)
                        if result:
                            ai_score = max(0, min(float(result.get("score", 0)), q_score))
                            return qid, {
                                "student_answer": student_ans,
                                "correct_answer": correct,
                                "score": ai_score,
                                "max_score": q_score,
                                "is_correct": ai_score >= q_score * 0.6,
                                "feedback": str(result.get("feedback", ""))[:500],
                            }
                    except Exception as ai_err:
                        logger.warning(f"练习主观题批改失败(qid={qid}): {ai_err}")
                return qid, _keyword_fallback(q, student_ans)

            results = await asyncio.gather(
                *[_grade_ai(q) for q in ai_questions], return_exceptions=True
            )
            for q, res in zip(ai_questions, results):
                if isinstance(res, Exception):
                    logger.warning(f"练习主观题批改异常(qid={q['id']}): {res}")
                    res = (str(q["id"]), _keyword_fallback(q, _ans_of(q["id"])))
                qid, one = res
                graded[qid] = one
                earned += one["score"]
                total += one["max_score"]
        else:
            for q in ai_questions:
                qid = str(q["id"])
                one = _keyword_fallback(q, _ans_of(q["id"]))
                graded[qid] = one
                earned += one["score"]
                total += one["max_score"]

    earned = round(earned, 2)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        execute_insert(
            """INSERT INTO practice_attempts (session_id, student_username, answers, score, total_score, status, submitted_at)
               VALUES (?,?,?,?,?,'submitted',?)""",
            (session_id, username, json.dumps(graded, ensure_ascii=False), earned, total, now),
        )
    except sqlite3.IntegrityError:
        # P6: 并发重复提交撞上唯一约束 → 返回既有成绩, 不再 500 丢学生答案
        again = execute_query_one(
            "SELECT * FROM practice_attempts WHERE session_id=? AND student_username=?",
            (session_id, username),
        )
        if again:
            logger.info(f"学生 {username} 重复提交练习 {session_id}, 返回既有成绩")
            return _existing_attempt_payload(again)
        raise

    # ── 错题本联动: 答对的标掌握, 答错的入库(W7: 练习错题从此不再漏记) ──
    try:
        from backend.api.wrong_book_router import (
            mark_wrong_mastered,
            record_wrong_answers,
            check_and_auto_generate_wrong_practice,
        )
        correct_graded = {k: v for k, v in graded.items() if isinstance(v, dict) and v.get("is_correct", False)}
        if correct_graded:
            mark_wrong_mastered(username, correct_graded)
        wrong_graded = {k: v for k, v in graded.items() if isinstance(v, dict) and not v.get("is_correct", False)}
        if wrong_graded:
            record_wrong_answers(username, session_id, wrong_graded, source="practice")
        # P8: 错题巩固练习重建要解析该生全部考试记录, 放后台执行
        _spawn_bg(check_and_auto_generate_wrong_practice, username)
    except Exception as wb_err:
        logger.warning(f"标记错题掌握状态失败 (user={username}, session={session_id}): {wb_err}")
        logger.warning(traceback.format_exc())

    # ── 积分奖励 ──
    try:
        from backend.reward_engine import award_participation, award_grade
        sess_title = sess.get("title", "") or f"练习#{session_id}"
        award_participation(username, "practice", str(session_id), sess_title)
        award_grade(username, "practice", str(session_id), earned, total, sess_title)
    except Exception as rw_err:
        logger.warning(f"练习积分发放失败 (user={username}, session_id={session_id}): {rw_err}")
        logger.warning(traceback.format_exc())

    logger.info(f"学生 {username} 提交练习 {session_id}: {earned}/{total}")
    return {
        "score": earned, "total_score": total,
        "accuracy": round(earned / max(total, 1) * 100, 1),
        "results": graded,
        "reward_note": "积分奖励已发放",
    }


async def _get_practice_result(session_id: int, username: str) -> dict[str, Any]:
    """获取已提交的练习结果"""
    attempt = execute_query_one(
        "SELECT * FROM practice_attempts WHERE session_id=? AND student_username=?",
        (session_id, username),
    )
    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not attempt or not sess:
        raise HTTPException(status_code=404, detail="练习或提交记录不存在")

    answers_data = attempt["answers"]
    try:
        answers_data = json.loads(answers_data) if isinstance(answers_data, str) else (answers_data or {})
    except (json.JSONDecodeError, TypeError):
        answers_data = {}
    if not isinstance(answers_data, dict):
        answers_data = {}

    questions = execute_query(
        """SELECT qb.id, qb.question_text, qb.type, qb.explanation, psq.score,
                  qb.svg_content, qb.has_svg, qb.media_files
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )

    results = []
    for q in questions:
        qid = str(q["id"])
        ans = answers_data.get(qid)
        # 题目在练习中被删等异常情况下也要有完整字段, 避免前端渲染 undefined
        one = {
            "student_answer": "", "correct_answer": "",
            "score": 0, "max_score": q.get("score") or 0, "is_correct": False,
        }
        if isinstance(ans, dict):
            one.update(ans)
        media = q.get("media_files")
        if isinstance(media, str) and media:
            try:
                media = json.loads(media)
            except (json.JSONDecodeError, TypeError):
                media = []
        results.append({
            "question_id": q["id"],
            "question_text": q["question_text"],
            "type": q["type"],
            "explanation": q.get("explanation", ""),
            "svg_content": q.get("svg_content", ""),
            "has_svg": q.get("has_svg", 0),
            "media_files": media or [],
            **one,
        })

    sess_dict = dict(sess)
    sess_dict.pop("target_students", None)

    return {
        "session": sess_dict,
        "attempt": {
            "score": attempt["score"],
            "total_score": attempt["total_score"],
            "accuracy": round((attempt["score"] or 0) / max(attempt["total_score"] or 0, 1) * 100, 1),
            "submitted_at": attempt["submitted_at"],
        },
        "results": results,
    }


# ── 共享工具 ──

def _parse_ai_result(text: str) -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 题目列表"""
    data = extract_json_from_text(text)
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and "questions" in data:
        return data["questions"]
    return []
