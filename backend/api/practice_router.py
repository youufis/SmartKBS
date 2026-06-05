"""
自适应出题 API 路由
教师：AI 出题 → 布置到班级
学生：查看练习 → 答题 → 提交 → 看结果
"""
import json
import re
import asyncio
from datetime import datetime
from typing import Optional, Any

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.question_db import execute_insert, execute_query, execute_query_one, execute_update
from backend.database import execute_query as db_execute_query
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_async
from backend.logger import logger

router = APIRouter()

TYPE_DESC_MAP = {
    "single": "单选题（4个选项）",
    "multiple": "多选题（多个正确选项）",
    "true_false": "判断题",
    "short": "简答题",
    "mixed": "混合题型（单选+判断+简答）",
}


# ── 请求模型 ──

class PracticeGenerateRequest(BaseModel):
    """教师：AI 出题"""
    knowledge_points: str
    subject: str = "信息科技"
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
    subject: str = "信息科技"


class PracticeSubmitRequest(BaseModel):
    """学生：提交答案"""
    answers: dict[str, str]


# ════════════════════════════════════════════
# 教师端
# ════════════════════════════════════════════

@router.post("/generate")
async def generate_practice(req: PracticeGenerateRequest, request: Request):
    """[教师] AI 生成练习题（仅预览，不入库，不布置）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可出题")

    if not req.knowledge_points.strip():
        raise HTTPException(status_code=400, detail="请输入知识点")
    if req.count < 1 or req.count > 20:
        raise HTTPException(status_code=400, detail="数量范围为 1-20")

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    from backend.prompts.practice import PRACTICE_GENERATE_PROMPT
    type_desc = TYPE_DESC_MAP.get(req.question_type, "混合题型")
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(req.difficulty, "中等")
    prompt = PRACTICE_GENERATE_PROMPT.format(
        subject=req.subject, knowledge_points=req.knowledge_points,
        type_desc=type_desc, count=req.count, difficulty_desc=difficulty_desc,
    )

    try:
        result_text = await call_ai_async(prompt, api_key)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 出题失败: {str(e)}")

    questions = _parse_ai_result(result_text)
    if not questions:
        raise HTTPException(status_code=502, detail="AI 返回格式异常，未能解析出题目")
    questions = questions[:req.count]

    # 入库到 question_bank，同时保留返回给教师预览
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for q in questions:
        opts = json.dumps(q.get("options", {}), ensure_ascii=False) if q.get("options") else ""
        qid = execute_insert(
            """INSERT INTO question_bank (type,question_text,options,correct_answer,explanation,
                knowledge_points,subject,difficulty,creator_username,source,status,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,'ai','active',?,?)""",
            (q.get("type", "single"), q.get("question", ""), opts,
             q.get("answer", ""), q.get("explanation", ""),
             q.get("knowledge_point", req.knowledge_points), req.subject,
             q.get("difficulty", req.difficulty), username, now, now),
        )
        q["id"] = qid
        q["index"] = qid

    return {"questions": questions, "total": len(questions), "message": f"已生成 {len(questions)} 道题"}


@router.post("/generate-async")
async def generate_practice_async(req: PracticeGenerateRequest, request: Request):
    """[教师] AI 异步出题（后台任务，不阻塞）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可出题")

    if not req.knowledge_points.strip():
        raise HTTPException(status_code=400, detail="请输入知识点")
    if req.count < 1 or req.count > 20:
        raise HTTPException(status_code=400, detail="数量范围为 1-20")

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    from backend.ai_task_manager import task_manager
    from backend.prompts.practice import PRACTICE_GENERATE_PROMPT
    type_desc = TYPE_DESC_MAP.get(req.question_type, "混合题型")
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(req.difficulty, "中等")
    prompt = PRACTICE_GENERATE_PROMPT.format(
        subject=req.subject, knowledge_points=req.knowledge_points,
        type_desc=type_desc, count=req.count, difficulty_desc=difficulty_desc,
    )

    async def _generate_and_save() -> dict:
        result_text = await call_ai_async(prompt, api_key)
        questions = _parse_ai_result(result_text)
        if not questions:
            raise ValueError("AI 返回格式异常，未能解析出题目")
        questions = questions[:req.count]

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for q in questions:
            opts = json.dumps(q.get("options", {}), ensure_ascii=False) if q.get("options") else ""
            qid = execute_insert(
                """INSERT INTO question_bank (type,question_text,options,correct_answer,explanation,
                    knowledge_points,subject,difficulty,creator_username,source,status,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,'ai','active',?,?)""",
                (q.get("type", "single"), q.get("question", ""), opts,
                 q.get("answer", ""), q.get("explanation", ""),
                 q.get("knowledge_point", req.knowledge_points), req.subject,
                 q.get("difficulty", req.difficulty), username, now, now),
            )
            q["id"] = qid
            q["index"] = qid
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

    target_students_str = json.dumps(req.target_students, ensure_ascii=False) if req.target_students else ""

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    session_id = execute_insert(
        """INSERT INTO practice_sessions
           (title, knowledge_points, creator_username, subject, question_count,
            total_score, target_grade, target_class, target_students, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)""",
        (req.title, req.knowledge_points, username, req.subject,
         len(req.question_ids), 0, req.target_grade, req.target_class, target_students_str, now, now),
    )

    total = 0
    for i, qid in enumerate(req.question_ids):
        score = (req.scores[i] if req.scores and i < len(req.scores) else 10)
        execute_insert(
            "INSERT INTO practice_session_questions (session_id, question_id, sort_order, score) VALUES (?,?,?,?)",
            (session_id, qid, i, score),
        )
        total += score

    execute_update("UPDATE practice_sessions SET total_score=? WHERE id=?", (total, session_id))

    logger.info(f"教师 {username} 创建练习任务 {session_id} → {req.target_grade} {req.target_class}")
    return {"session_id": session_id, "message": "练习任务已发布"}


@router.get("/sessions")
async def list_teacher_sessions(request: Request):
    """[教师] 查看自己创建的练习任务"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 0:
        rows = execute_query(
            'SELECT * FROM practice_sessions ORDER BY created_at DESC'
        )
    else:
        rows = execute_query(
            'SELECT * FROM practice_sessions WHERE creator_username=? ORDER BY created_at DESC',
            (username,),
        )

    sessions = []
    for r in rows:
        # 查询发布者姓名
        name_rows = db_execute_query('SELECT name FROM users WHERE username=?', (r['creator_username'],))
        creator_name = name_rows[0][0] if name_rows and name_rows[0] and name_rows[0][0] else r['creator_username']

        target_students = []
        if r.get('target_students'):
            try:
                target_students = json.loads(r['target_students']) if isinstance(r['target_students'], str) else (r['target_students'] or [])
            except (json.JSONDecodeError, TypeError):
                target_students = []

        # 统计目标人数
        if target_students:
            student_count = len(target_students)
        elif r["target_grade"]:
            student_count = len(db_execute_query(
                'SELECT COUNT(*) FROM users WHERE role=2 AND grade=? AND class=?',
                (r['target_grade'], r['target_class']),
            )) if r["target_grade"] else 0
        else:
            student_count = 0

        submitted_count = len(execute_query(
            'SELECT DISTINCT student_username FROM practice_attempts WHERE session_id=?',
            (r['id'],),
        ))
        sessions.append({
            "id": r["id"], "title": r["title"],
            "knowledge_points": r["knowledge_points"],
            "subject": r["subject"], "question_count": r["question_count"],
            "total_score": r["total_score"],
            "target_grade": r["target_grade"], "target_class": r["target_class"],
            "target_students": target_students,
            "status": r["status"],
            "creator_name": creator_name,
            "student_count": student_count or 0,
            "submitted_count": submitted_count,
            "created_at": r["created_at"],
        })

    return {"sessions": sessions}


@router.get("/sessions/{session_id}")
async def get_session_detail(session_id: int, request: Request):
    """[教师] 查看练习详情（含提交情况）"""
    user = get_current_user(request)

    sess = execute_query_one(
        "SELECT * FROM practice_sessions WHERE id=?", (session_id,)
    )
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")

    # 题目列表
    questions = execute_query(
        """SELECT psq.*, qb.question_text, qb.type, qb.options, qb.correct_answer,
                  qb.explanation, qb.knowledge_points
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )
    for q in questions:
        if q.get("options"):
            try:
                q["options"] = json.loads(q["options"])
            except (json.JSONDecodeError, TypeError):
                q["options"] = None

    # 学生提交情况（用户表在 smartkb.db，不能跨库 JOIN）
    attempts = execute_query(
        'SELECT * FROM practice_attempts WHERE session_id=? ORDER BY score DESC',
        (session_id,),
    )
    # 补充学生姓名
    for a in attempts:
        name_rows = db_execute_query('SELECT name FROM users WHERE username=?', (a['student_username'],))
        a['student_name'] = name_rows[0][0] if name_rows and name_rows[0] and name_rows[0][0] else a['student_username']

    # 解析 target_students
    sess_dict = dict(sess)
    target_students = []
    if sess_dict.get('target_students'):
        try:
            target_students = json.loads(sess_dict['target_students']) if isinstance(sess_dict['target_students'], str) else (sess_dict['target_students'] or [])
        except (json.JSONDecodeError, TypeError):
            target_students = []
    sess_dict['target_students'] = target_students

    return {
        "session": sess_dict,
        "questions": questions,
        "attempts": attempts,
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

    execute_update("DELETE FROM practice_attempts WHERE session_id=?", (session_id,))
    execute_update("DELETE FROM practice_session_questions WHERE session_id=?", (session_id,))
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

@router.get("/my-sessions")
async def list_my_practices(request: Request):
    """[学生] 查看分配给自己的练习任务"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        # 教师/管理员也可查看自己布置的
        return await list_teacher_sessions(request)

    # 查学生的年级和班级
    rows = db_execute_query('SELECT grade, class FROM users WHERE username=?', (username,))
    grade = (rows[0][0] or "").strip() if rows else ""
    cls = str(rows[0][1] or "").strip() if rows else ""

    # 查出可给自己发布练习的教师：本班教师 + 管理员
    allowed_creators = []
    # 管理员
    admin_rows = db_execute_query("SELECT username FROM users WHERE role=0")
    allowed_creators.extend(r[0] for r in admin_rows if r[0])
    # 本班教师
    if grade:
        teacher_rows = db_execute_query(
            "SELECT username, grade, class FROM users WHERE role=1"
        )
        for t in teacher_rows:
            t_grade = (t[1] or "").strip()
            t_class = str(t[2] or "").strip()
            if not t_grade:
                continue
            # 解析教师的年级班级映射
            grade_parts = [g.strip() for g in t_grade.split("|") if g.strip()]
            class_parts = [c.strip() for c in t_class.split("|")] if t_class else []
            for i, g in enumerate(grade_parts):
                if g == grade:
                    if i < len(class_parts) and class_parts[i]:
                        classes = [c.strip() for c in class_parts[i].split(",") if c.strip()]
                        if cls in classes:
                            allowed_creators.append(t[0])
                    else:
                        allowed_creators.append(t[0])
                    break

    if not allowed_creators:
        return {"sessions": []}

    placeholders = ",".join("?" for _ in allowed_creators)
    # 同时匹配 target_grade/class（班级范围）和 target_students（定向学生）
    sessions = execute_query(
        f"""SELECT ps.*,
                  (SELECT COUNT(*) FROM practice_attempts pa WHERE pa.session_id=ps.id AND pa.student_username=?) as attempted
           FROM practice_sessions ps
           WHERE ps.status='active'
             AND ps.creator_username IN ({placeholders})
             AND (
               (ps.target_students='' AND (ps.target_grade='' OR ps.target_grade=?) AND (ps.target_class='' OR ps.target_class=?))
               OR
               (ps.target_students!='' AND ps.target_students LIKE ?)
             )
           ORDER BY ps.created_at DESC""",
        (username, *allowed_creators, grade, cls, f'%{username}%'),
    )

    result = []
    for s in sessions:
        name_rows = db_execute_query('SELECT name FROM users WHERE username=?', (s['creator_username'],))
        creator_name = name_rows[0][0] if name_rows and name_rows[0] and name_rows[0][0] else s['creator_username']
        result.append({
            "id": s["id"], "title": s["title"],
            "knowledge_points": s["knowledge_points"],
            "subject": s["subject"], "question_count": s["question_count"],
            "total_score": s["total_score"],
            "creator_name": creator_name,
            "attempted": bool(s["attempted"]),
            "created_at": s["created_at"],
        })

    return {"sessions": result}


@router.get("/my-sessions/{session_id}")
async def get_my_practice(session_id: int, request: Request):
    """[学生] 获取练习题目（开始答题）"""
    user = get_current_user(request)
    username = user["username"]

    sess = execute_query_one(
        "SELECT * FROM practice_sessions WHERE id=?", (session_id,)
    )
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")

    # 检查是否已提交
    existing = execute_query_one(
        "SELECT id FROM practice_attempts WHERE session_id=? AND student_username=?",
        (session_id, username),
    )
    if existing:
        # 已提交过 → 返回结果
        return await _get_practice_result(session_id, username)

    # 获取题目（不带答案）
    questions = execute_query(
        """SELECT psq.id as eq_id, psq.sort_order, psq.score,
                  qb.id, qb.type, qb.question_text, qb.options, qb.difficulty
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )
    for q in questions:
        if q.get("options"):
            try:
                q["options"] = json.loads(q["options"])
            except (json.JSONDecodeError, TypeError):
                q["options"] = None

    return {"session": sess, "questions": questions}


@router.post("/my-sessions/{session_id}/submit")
async def submit_practice(session_id: int, req: PracticeSubmitRequest, request: Request):
    """[学生] 提交练习答案"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可提交")

    sess = execute_query_one(
        "SELECT * FROM practice_sessions WHERE id=?", (session_id,)
    )
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")

    # 防重复提交
    existing = execute_query_one(
        "SELECT id FROM practice_attempts WHERE session_id=? AND student_username=?",
        (session_id, username),
    )
    if existing:
        raise HTTPException(status_code=400, detail="已提交过，不可重复提交")

    # 获取题目和答案
    questions = execute_query(
        """SELECT qb.id, qb.type, qb.correct_answer, qb.question_text, psq.score
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )

    total = 0
    earned = 0
    graded = {}

    # 分离简答题和其他题，简答题走 AI 批改
    short_questions = [q for q in questions if q["type"] == "short"]
    other_questions = [q for q in questions if q["type"] != "short"]

    # 非简答题：关键词/精确匹配
    for q in other_questions:
        qid = str(q["id"])
        student_ans = req.answers.get(qid, "")
        correct = q["correct_answer"] or ""
        q_score = q["score"] or 10
        is_correct = student_ans.strip().upper() == correct.strip().upper()
        s = q_score if is_correct else 0
        earned += s
        total += q_score
        graded[qid] = {
            "student_answer": student_ans, "correct_answer": correct,
            "score": s, "max_score": q_score, "is_correct": is_correct,
        }

    # 简答题：AI 语义批改（并发）
    if short_questions:
        api_key, _ = get_api_keys(username)
        if api_key:
            sem = asyncio.Semaphore(3)

            async def _grade_short(q):
                qid = str(q["id"])
                student_ans = req.answers.get(qid, "")
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
                        ai_resp = await call_ai_async(prompt, api_key)
                        import re
                        jm = re.search(r'\{[^}]+\}', ai_resp)
                        if jm:
                            result = json.loads(jm.group())
                            ai_score = float(result.get("score", 0))
                            ai_score = max(0, min(ai_score, q_score))
                            return qid, {
                                "student_answer": student_ans,
                                "correct_answer": correct,
                                "score": ai_score,
                                "max_score": q_score,
                                "is_correct": ai_score >= q_score * 0.6,
                            }
                    except Exception:
                        pass
                # AI 失败时回退到关键词匹配
                keywords = [k.strip().lower() for k in correct.replace("，", ",").split(",") if k.strip()]
                is_correct = bool(keywords and any(kw in student_ans.lower() for kw in keywords))
                return qid, {
                    "student_answer": student_ans, "correct_answer": correct,
                    "score": q_score if is_correct else 0,
                    "max_score": q_score, "is_correct": is_correct,
                }

            results = await asyncio.gather(*[_grade_short(q) for q in short_questions])
            for qid, result in results:
                graded[qid] = result
                earned += result["score"]
                total += result["max_score"]
        else:
            # 无 API Key：关键词匹配兜底
            for q in short_questions:
                qid = str(q["id"])
                student_ans = req.answers.get(qid, "")
                correct = q["correct_answer"] or ""
                q_score = q["score"] or 10
                keywords = [k.strip().lower() for k in correct.replace("，", ",").split(",") if k.strip()]
                is_correct = bool(keywords and any(kw in student_ans.lower() for kw in keywords))
                s = q_score if is_correct else 0
                earned += s
                total += q_score
                graded[qid] = {
                    "student_answer": student_ans, "correct_answer": correct,
                    "score": s, "max_score": q_score, "is_correct": is_correct,
                }

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert(
        """INSERT INTO practice_attempts (session_id, student_username, answers, score, total_score, status, submitted_at)
           VALUES (?,?,?,?,?,'submitted',?)""",
        (session_id, username, json.dumps(graded, ensure_ascii=False), earned, total, now),
    )

    logger.info(f"学生 {username} 提交练习 {session_id}: {earned}/{total}")
    return {
        "score": earned, "total_score": total,
        "accuracy": round(earned / max(total, 1) * 100, 1),
        "results": graded,
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
    if isinstance(answers_data, str):
        answers_data = json.loads(answers_data)

    # 补全题目信息
    questions = execute_query(
        """SELECT qb.id, qb.question_text, qb.type, qb.explanation, psq.score
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )

    results = []
    for q in questions:
        qid = str(q["id"])
        ans = answers_data.get(qid, {})
        results.append({
            "question_id": q["id"],
            "question_text": q["question_text"],
            "type": q["type"],
            "explanation": q.get("explanation", ""),
            **ans,
        })

    return {
        "session": sess,
        "attempt": {
            "score": attempt["score"],
            "total_score": attempt["total_score"],
            "accuracy": round(attempt["score"] / max(attempt["total_score"], 1) * 100, 1),
            "submitted_at": attempt["submitted_at"],
        },
        "results": results,
    }


# ── 共享工具 ──

def _parse_ai_result(text: str) -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 题目列表"""
    text = text.strip()
    json_match = re.search(r'\[[\s\S]*\]', text)
    if json_match:
        json_str = json_match.group()
    else:
        json_str = text
    json_str = json_str.replace("```json", "").replace("```", "").strip()
    try:
        questions = json.loads(json_str)
        if isinstance(questions, list):
            return questions
        elif isinstance(questions, dict) and "questions" in questions:
            return questions["questions"]
    except json.JSONDecodeError:
        pass
    return []
