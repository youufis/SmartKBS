# -*- coding: utf-8 -*-
"""
课堂互动 API 路由
随堂测验、快速投票、课堂提问
"""
import asyncio
import json
import re
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.database import execute_query, execute_insert_update, execute_batch
from backend.logger import logger

router = APIRouter()


def _get_user_grade_class(username: str) -> tuple:
    """查询用户的年级(grade)和班级(class)"""
    rows = execute_query(
        "SELECT grade, class FROM users WHERE username = ?",
        (username,),
    )
    if rows and rows[0]:
        return str(rows[0][0] or ""), str(rows[0][1] or "")
    return "", ""


# ── 请求模型 ──

class QuizCreate(BaseModel):
    title: str
    description: str = ""
    questions: str  # JSON 字符串 [{type, question, options, answer, score}]


class QuizAnswerSubmit(BaseModel):
    answers: str  # JSON 字符串 [{question_index, answer}]


class PollCreate(BaseModel):
    question: str
    options: list[str]
    poll_type: str = "single"  # single / multiple


class QuestionCreate(BaseModel):
    content: str
    is_anonymous: bool = False


class QuestionAnswer(BaseModel):
    answer: str


class AiGenerateQuiz(BaseModel):
    topic: str
    subject: str = ""  # 由前端传递
    count: int = 5
    question_type: str = "single"  # single / true_false / mixed


class AiGeneratePoll(BaseModel):
    topic: str
    option_count: int = 4


# ── AI 辅助函数 ──

def _call_ai(prompt: str) -> str:
    """调用 AI（非流式）- 支持智能体/直接调大模型双模式"""
    import os
    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        try:
            from backend.api.config_router import load_config
            cfg = load_config()
            api_key = cfg.get("dashscope_api_key", "")
        except Exception:
            pass
    if not api_key:
        return "⚠️ AI 功能不可用：请配置 DashScope API Key"

    from backend.api.ai_service import call_ai_sync
    try:
        return call_ai_sync(prompt, api_key)
    except Exception as e:
        return f"AI 调用出错: {str(e)}"


# ── AI 生成随堂测验 ──

@router.post("/quizzes/ai-generate", summary="AI 自动生成随堂测验")
async def ai_generate_quiz(req: AiGenerateQuiz, request: Request):
    """AI 根据主题自动生成测验题目"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    type_desc = {
        "single": "单选题",
        "true_false": "判断题",
        "mixed": "混合（单选+判断）",
    }.get(req.question_type, "单选题")

    from backend.prompts.quiz import QUIZ_GENERATE_PROMPT
    prompt = QUIZ_GENERATE_PROMPT.format(
        subject=req.subject,
        topic=req.topic,
        type_desc=type_desc,
        count=req.count,
    )

    result = _call_ai(prompt)
    # 尝试从返回中提取 JSON
    import re
    json_match = re.search(r'\[[\s\S]*\]', result)
    if json_match:
        try:
            questions = json.loads(json_match.group())
            return {"questions": questions, "raw": result}
        except json.JSONDecodeError:
            pass
    return {"questions": [], "raw": result, "error": "AI 返回格式异常，请重试或手动输入"}


# ── AI 生成快速投票 ──

@router.post("/polls/ai-generate", summary="AI 自动生成投票")
async def ai_generate_poll(req: AiGeneratePoll, request: Request):
    """AI 根据主题自动生成投票问题和选项"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    prompt = (
        '请根据主题"' + req.topic + '"生成一个课堂投票，包含' + str(req.option_count) + '个选项。\n\n'
        '请严格按照以下JSON格式输出，不要包含任何其他文字：\n'
        '{\n'
        '  "question": "投票问题",\n'
        '  "options": ["选项1", "选项2", ...]\n'
        '}'
    )

    result = _call_ai(prompt)
    import re
    json_match = re.search(r'\{[\s\S]*\}', result)
    if json_match:
        try:
            data = json.loads(json_match.group())
            return {"poll": data, "raw": result}
        except json.JSONDecodeError:
            pass
    return {"poll": None, "raw": result, "error": "AI 返回格式异常，请重试或手动输入"}


# ── AI 建议回答提问 ──

@router.post("/questions/{question_id}/ai-suggest", summary="AI 建议回答")
async def ai_suggest_answer(question_id: int, request: Request):
    """AI suggests answer based on question content (teacher can modify before submit)"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师可用")

    rows = execute_query(
        "SELECT content FROM interaction_questions WHERE id = ?",
        (question_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="问题不存在")

    content = rows[0][0]
    prompt = (
        '你是一位高中教师。学生在课堂上提出了以下问题，请给出专业、清晰的回答。\n\n'
        '学生问题：' + content + '\n\n'
        '请用中文回答，语气亲切，条理清晰。'
    )

    answer = _call_ai(prompt)
    return {"suggested_answer": answer, "question": content}


class QuizUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    questions: str | None = None
    status: str | None = None


class PollUpdate(BaseModel):
    question: str | None = None
    options: list[str] | None = None
    poll_type: str | None = None


class QuestionUpdate(BaseModel):
    content: str | None = None


# ── 随堂测验 ──

@router.post("/quizzes", summary="创建随堂测验")
async def create_quiz(req: QuizCreate, request: Request):
    """教师创建随堂测验"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可创建测验")

    # 验证 JSON
    try:
        questions = json.loads(req.questions) if isinstance(req.questions, str) else req.questions
        if not isinstance(questions, list) or len(questions) == 0:
            raise ValueError("试题不能为空")
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"试题格式错误: {e}")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    quiz_id = execute_insert_update(
        """INSERT INTO interaction_quizzes
           (creator_username, title, description, questions, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)""",
        (user["username"], req.title, req.description, json.dumps(questions, ensure_ascii=False), now, now),
    )

    logger.info(f"用户 {user['username']} 创建随堂测验: {req.title} (id={quiz_id})")

    # ── 异步通知学生（不阻塞创建操作） ──
    async def _notify_quiz():
        try:
            from backend.api.notification_router import _notify_users
            from backend.database import execute_query as db_query
            creator = user["username"]
            role_u = user.get("role", 2)
            if role_u == 0:
                students = db_query("SELECT username FROM users WHERE role = 2")
            else:
                grade, cls = _get_user_grade_class(creator)
                if grade:
                    cls_param = f",{cls}," if cls else ""
                    students = db_query(
                        f"SELECT username FROM users WHERE role = 2 AND grade = ?"
                        + (" AND INSTR(',' || class || ',', ?) > 0" if cls else ""),
                        (grade, cls_param) if cls else (grade,),
                    )
                else:
                    students = []
            if students:
                _notify_users(
                    [r[0] for r in students], "info",
                    f"新随堂测验「{req.title}」已发布",
                    f"共 {len(questions)} 题，请及时完成",
                    "/interaction",
                )
        except Exception as e:
            logger.warning(f"发送测验通知失败: {e}")
    asyncio.create_task(_notify_quiz())

    return {"message": "测验创建成功", "quiz_id": quiz_id}


def _can_manage_quiz(username: str, role: int, quiz_id: int) -> bool:
    """检查是否有管理测验的权限"""
    if role == 0:
        return True
    rows = execute_query(
        "SELECT creator_username FROM interaction_quizzes WHERE id = ?",
        (quiz_id,),
    )
    return bool(rows and rows[0][0] == username)


@router.put("/quizzes/{quiz_id}", summary="更新测验")
async def update_quiz(quiz_id: int, req: QuizUpdate, request: Request):
    """编辑随堂测验"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_quiz(user["username"], role, quiz_id):
        raise HTTPException(status_code=403, detail="无权修改此测验")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    updates = ["updated_at = ?"]
    params = [now]
    for field in ("title", "description", "status"):
        val = getattr(req, field, None)
        if val is not None:
            updates.append(f"{field} = ?")
            params.append(val)
    if req.questions is not None:
        try:
            json.loads(req.questions) if isinstance(req.questions, str) else req.questions
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="试题格式错误")
        updates.append("questions = ?")
        params.append(req.questions if isinstance(req.questions, str) else json.dumps(req.questions, ensure_ascii=False))

    params.append(quiz_id)
    execute_insert_update(
        f"UPDATE interaction_quizzes SET {', '.join(updates)} WHERE id = ?",
        tuple(params),
    )
    return {"message": "测验已更新"}


@router.delete("/quizzes/{quiz_id}", summary="删除测验")
async def delete_quiz(quiz_id: int, request: Request):
    """删除随堂测验及其答案"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_quiz(user["username"], role, quiz_id):
        raise HTTPException(status_code=403, detail="无权删除此测验")

    execute_insert_update("DELETE FROM interaction_quiz_answers WHERE quiz_id = ?", (quiz_id,))
    execute_insert_update("DELETE FROM interaction_quizzes WHERE id = ?", (quiz_id,))
    return {"message": "测验已删除"}


def _can_manage_poll(username: str, role: int, poll_id: int) -> bool:
    if role == 0:
        return True
    rows = execute_query("SELECT creator_username FROM interaction_polls WHERE id = ?", (poll_id,))
    return bool(rows and rows[0][0] == username)


@router.put("/polls/{poll_id}", summary="更新投票")
async def update_poll(poll_id: int, req: PollUpdate, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_poll(user["username"], role, poll_id):
        raise HTTPException(status_code=403, detail="无权修改")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if req.question is not None:
        execute_insert_update("UPDATE interaction_polls SET question = ?, created_at = ? WHERE id = ?",
                              (req.question, now, poll_id))
    if req.options is not None:
        execute_insert_update("UPDATE interaction_polls SET options = ?, created_at = ? WHERE id = ?",
                              (json.dumps(req.options, ensure_ascii=False), now, poll_id))
    if req.poll_type is not None:
        execute_insert_update("UPDATE interaction_polls SET poll_type = ?, created_at = ? WHERE id = ?",
                              (req.poll_type, now, poll_id))
    return {"message": "投票已更新"}


@router.delete("/polls/{poll_id}", summary="删除投票")
async def delete_poll(poll_id: int, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_poll(user["username"], role, poll_id):
        raise HTTPException(status_code=403, detail="无权删除")

    execute_insert_update("DELETE FROM interaction_poll_votes WHERE poll_id = ?", (poll_id,))
    execute_insert_update("DELETE FROM interaction_polls WHERE id = ?", (poll_id,))
    return {"message": "投票已删除"}


@router.delete("/questions/{question_id}", summary="删除提问")
async def delete_question(question_id: int, request: Request):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 0:
        # 管理员：删除任何提问
        execute_insert_update("DELETE FROM interaction_questions WHERE id = ?", (question_id,))
    elif role == 1:
        # 教师：只能删除自己班级学生的提问
        grade, cls = _get_user_grade_class(username)
        if cls:
            cls_param = f",{cls},"
            deleted = execute_insert_update(
                """DELETE FROM interaction_questions WHERE id = ? AND student_username IN (
                    SELECT username FROM users WHERE role = 2 AND grade = ? AND INSTR(',' || class || ',', ?) > 0
                )""",
                (question_id, grade, cls_param),
            )
        else:
            deleted = execute_insert_update(
                """DELETE FROM interaction_questions WHERE id = ? AND student_username IN (
                    SELECT username FROM users WHERE role = 2 AND grade = ?
                )""",
                (question_id, grade),
            )
    else:
        # 学生：只能删除自己的提问
        execute_insert_update(
            "DELETE FROM interaction_questions WHERE id = ? AND student_username = ?",
            (question_id, username),
        )
    return {"message": "提问已删除"}


@router.put("/questions/{question_id}", summary="更新提问")
async def update_question(question_id: int, req: QuestionUpdate, request: Request):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        rows = execute_query(
            "SELECT id FROM interaction_questions WHERE id = ? AND student_username = ?",
            (question_id, username),
        )
        if not rows:
            raise HTTPException(status_code=403, detail="无权修改")
    if req.content is not None:
        execute_insert_update("UPDATE interaction_questions SET content = ? WHERE id = ?",
                              (req.content, question_id))
    return {"message": "提问已更新"}


@router.get("/quizzes", summary="获取随堂测验列表")
async def list_quizzes(
    request: Request,
    status: str = Query("", description="筛选状态"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1),
):
    """获取随堂测验列表"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]

    conditions = []
    params: list = []

    if role == 2:
        # 学生：看自己班级的测验（管理员创建的全体可见，教师创建的需匹配班级）
        grade, cls = _get_user_grade_class(username)
        conditions.append("q.status = 'active'")
        if grade:
            conditions.append("(u.role = 0 OR u.grade = ?)")
            params.append(grade)
        if cls:
            # 教师 class 可能是 "1" 或 "1,2,3,4"，用 INSTR 匹配
            cls_param = f",{cls},"
            conditions.append("(u.role = 0 OR INSTR(',' || u.class || ',', ?) > 0)")
            params.append(cls_param)
    elif role == 1:
        conditions.append("q.creator_username = ?")
        params.append(username)
        if status:
            conditions.append("q.status = ?")
            params.append(status)
    else:
        if status:
            conditions.append("q.status = ?")
            params.append(status)

    where = " AND ".join(conditions) if conditions else "1=1"
    offset = (page - 1) * page_size

    if role == 2:
        # 学生：JOIN users 表筛选同班教师的测验（包括管理员创建的内容）
        rows = execute_query(
            f"""SELECT q.id, q.creator_username, q.title, q.description, q.questions, q.status, q.created_at, q.updated_at,
                        COALESCE(u.name, u.username) AS creator_name
                FROM interaction_quizzes q
                JOIN users u ON q.creator_username = u.username AND u.role IN (0, 1)
                WHERE {where}
                ORDER BY q.created_at DESC LIMIT ? OFFSET ?""",
            tuple(params + [page_size, offset]),
        )
    else:
        rows = execute_query(
            f"""SELECT q.id, q.creator_username, q.title, q.description, q.questions, q.status, q.created_at, q.updated_at,
                        COALESCE(u.name, u.username) AS creator_name
                FROM interaction_quizzes q
                LEFT JOIN users u ON q.creator_username = u.username
                WHERE {where}
                ORDER BY q.created_at DESC LIMIT ? OFFSET ?""",
            tuple(params + [page_size, offset]),
        )

    quizzes = []
    for r in rows:
        q = {
            "id": r[0],
            "creator_username": r[1],
            "title": r[2],
            "description": r[3],
            "questions": json.loads(r[4]) if isinstance(r[4], str) else r[4],
            "status": r[5],
            "created_at": r[6],
            "updated_at": r[7],
            "creator_name": r[8] if len(r) > 8 else r[1],
        }
        # 计算答题人数
        count_rows = execute_query(
            "SELECT COUNT(*) FROM interaction_quiz_answers WHERE quiz_id = ?",
            (r[0],),
        )
        q["answer_count"] = count_rows[0][0] if count_rows else 0
        # 学生端标记是否已答题
        if role == 2:
            answered = execute_query(
                "SELECT COUNT(*) FROM interaction_quiz_answers WHERE quiz_id = ? AND student_username = ?",
                (r[0], username),
            )
            q["answered"] = (answered[0][0] if answered else 0) > 0
        quizzes.append(q)

    return {"quizzes": quizzes}


@router.post("/quizzes/{quiz_id}/answer", summary="提交测验答案")
async def submit_quiz_answer(quiz_id: int, req: QuizAnswerSubmit, request: Request):
    """学生提交随堂测验答案"""
    user = get_current_user(request)
    username = user["username"]

    # 验证测验存在且活跃
    role = user.get("role", 2)
    quiz = execute_query(
        "SELECT * FROM interaction_quizzes WHERE id = ? AND status = 'active'",
        (quiz_id,),
    )
    if not quiz:
        raise HTTPException(status_code=404, detail="测验不存在或已结束")

    # 学生只能回答自己班级教师的测验
    if role == 2:
        grade, cls = _get_user_grade_class(username)
        creator = quiz[0][1]
        if cls:
            cls_param = f",{cls},"
            teacher_ok = execute_query(
                "SELECT username FROM users WHERE username = ? AND role IN (0, 1) AND grade = ? AND INSTR(',' || class || ',', ?) > 0",
                (creator, grade, cls_param),
            )
        else:
            teacher_ok = execute_query(
                "SELECT username FROM users WHERE username = ? AND role IN (0, 1) AND grade = ?",
                (creator, grade),
            )
        if not teacher_ok:
            raise HTTPException(status_code=403, detail="无权回答非本班教师的测验")

    # 验证是否已答过
    existing = execute_query(
        "SELECT id FROM interaction_quiz_answers WHERE quiz_id = ? AND student_username = ?",
        (quiz_id, username),
    )
    if existing:
        raise HTTPException(status_code=400, detail="您已经答过此题")

    # 解析答案并评分
    questions = json.loads(quiz[0][4]) if isinstance(quiz[0][4], str) else quiz[0][4]
    user_answers = json.loads(req.answers) if isinstance(req.answers, str) else req.answers

    total_score = 0
    q_score = sum(q.get("score", 1) for q in questions)

    # 分离简答题和其他题
    short_indices = [i for i, q in enumerate(questions) if q.get("type") == "short"]
    other_indices = [i for i, q in enumerate(questions) if q.get("type") != "short"]

    # 非简答题：精确匹配
    for idx in other_indices:
        q_type = questions[idx].get("type", "single")
        user_ans = str(next((ua.get("answer", "") for ua in user_answers if ua.get("question_index") == idx), "")).strip()
        correct_ans = str(questions[idx].get("answer", "")).strip()
        if q_type == "multiple":
            user_set = sorted([a.strip().upper() for a in user_ans.split(",") if a.strip()])
            correct_set = sorted([a.strip().upper() for a in correct_ans.split(",") if a.strip()])
            if user_set == correct_set:
                total_score += questions[idx].get("score", 1)
        else:
            if user_ans.upper() == correct_ans.upper():
                total_score += questions[idx].get("score", 1)

    # 简答题：AI 语义批改
    if short_indices:
        try:
            from backend.api.chat_router import get_api_keys
            from backend.api.ai_service import call_ai_async
            api_key, _ = get_api_keys(username)
        except Exception:
            api_key = ""

        if api_key and api_key.strip():
            sem = asyncio.Semaphore(3)

            async def _grade_short(idx):
                q = questions[idx]
                user_ans = str(next((ua.get("answer", "") for ua in user_answers if ua.get("question_index") == idx), "")).strip()
                correct_ans = str(q.get("answer", "")).strip()
                q_score_val = q.get("score", 1)
                async with sem:
                    try:
                        from backend.prompts.teaching import SHORT_ANSWER_GRADING_PROMPT
                        prompt = SHORT_ANSWER_GRADING_PROMPT.format(
                            question_text=str(q.get("question", "")).replace('{', '{{').replace('}', '}}'),
                            correct_answer=correct_ans.replace('{', '{{').replace('}', '}}'),
                            max_score=str(q_score_val),
                            half_score=str(q_score_val * 0.5),
                            near_full=str(q_score_val * 0.8),
                            half_minus=str(q_score_val * 0.4),
                            student_answer=user_ans.replace('{', '{{').replace('}', '}}'),
                        )
                        ai_resp = await call_ai_async(prompt, api_key)
                        jm = re.search(r'\{[^}]+\}', ai_resp)
                        if jm:
                            result = json.loads(jm.group())
                            ai_score = float(result.get("score", 0))
                            ai_score = max(0, min(ai_score, q_score_val))
                            return ai_score if ai_score >= q_score_val * 0.6 else 0.0
                    except Exception:
                        pass
                # AI 失败回退：关键词匹配
                keywords = [k.strip().lower() for k in correct_ans.replace("，", ",").split(",") if k.strip()]
                return q_score_val if keywords and any(kw in user_ans.lower() for kw in keywords) else 0.0

            results = await asyncio.gather(*[_grade_short(idx) for idx in short_indices])
            total_score += sum(results)

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        """INSERT INTO interaction_quiz_answers (quiz_id, student_username, answers, score, submitted_at)
           VALUES (?, ?, ?, ?, ?)""",
        (quiz_id, username, json.dumps(user_answers, ensure_ascii=False), total_score, now),
    )

    return {
        "message": "提交成功",
        "score": total_score,
        "total_score": q_score,
        "percentage": round(total_score / max(q_score, 1) * 100, 1),
    }


@router.get("/quizzes/{quiz_id}/my-result", summary="学生查看自己的答题结果")
async def get_my_quiz_result(quiz_id: int, request: Request):
    """学生查看自己的随堂测验答题详情"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可查看")

    quiz = execute_query(
        "SELECT * FROM interaction_quizzes WHERE id = ?",
        (quiz_id,),
    )
    if not quiz:
        raise HTTPException(status_code=404, detail="测验不存在")

    # 查询该学生的答题记录
    answers = execute_query(
        "SELECT answers, score, submitted_at FROM interaction_quiz_answers WHERE quiz_id = ? AND student_username = ?",
        (quiz_id, username),
    )
    if not answers:
        raise HTTPException(status_code=404, detail="未找到答题记录")

    questions = json.loads(quiz[0][4]) if isinstance(quiz[0][4], str) else quiz[0][4]
    user_answers = json.loads(answers[0][0]) if isinstance(answers[0][0], str) else answers[0][0]
    total_score = answers[0][1]
    q_score = sum(q.get("score", 1) for q in questions)

    # 每题批改详情
    details = []
    for i, q in enumerate(questions):
        user_ans = ""
        for ua in user_answers:
            if ua.get("question_index") == i:
                user_ans = str(ua.get("answer", "")).strip()
                break
        correct_ans = str(q.get("answer", "")).strip()
        q_type = q.get("type", "single")
        is_correct = False
        if q_type == "multiple":
            user_set = sorted([a.strip().upper() for a in user_ans.split(",") if a.strip()])
            correct_set = sorted([a.strip().upper() for a in correct_ans.split(",") if a.strip()])
            is_correct = user_set == correct_set
        else:
            is_correct = user_ans.upper() == correct_ans.upper()
        details.append({
            "index": i,
            "question": q.get("question", q.get("question_text", "")),
            "options": q.get("options", None),
            "type": q_type,
            "user_answer": user_ans,
            "correct_answer": correct_ans,
            "is_correct": is_correct,
            "score": q.get("score", 1) if is_correct else 0,
            "max_score": q.get("score", 1),
            "explanation": q.get("explanation", ""),
        })

    return {
        "quiz_title": quiz[0][2],
        "score": total_score,
        "total_score": q_score,
        "percentage": round(total_score / max(q_score, 1) * 100, 1),
        "details": details,
    }


@router.get("/quizzes/{quiz_id}/results", summary="教师查看测验结果统计")
async def get_quiz_results(quiz_id: int, request: Request):
    """教师查看随堂测验结果统计"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="无权查看")

    quiz = execute_query(
        "SELECT * FROM interaction_quizzes WHERE id = ?",
        (quiz_id,),
    )
    if not quiz:
        raise HTTPException(status_code=404, detail="测验不存在")

    questions = json.loads(quiz[0][4]) if isinstance(quiz[0][4], str) else quiz[0][4]
    answers = execute_query(
        "SELECT student_username, answers, score, submitted_at FROM interaction_quiz_answers WHERE quiz_id = ?",
        (quiz_id,),
    )

    # 每题正确率统计
    question_stats = []
    for i, q in enumerate(questions):
        correct_count = 0
        q_type = q.get("type", "single")
        correct_ans = str(q.get("answer", "")).strip()
        for a in answers:
            user_ans = json.loads(a[1]) if isinstance(a[1], str) else a[1]
            for ua in user_ans:
                if ua.get("question_index") == i:
                    user_ans_str = str(ua.get("answer", "")).strip()
                    if q_type == "multiple":
                        user_set = sorted([x.strip().upper() for x in user_ans_str.split(",") if x.strip()])
                        correct_set = sorted([x.strip().upper() for x in correct_ans.split(",") if x.strip()])
                        if user_set == correct_set:
                            correct_count += 1
                    else:
                        if user_ans_str.upper() == correct_ans.upper():
                            correct_count += 1
                    break
        question_stats.append({
            "index": i,
            "question": q.get("question", q.get("question_text", "")),
            "correct_count": correct_count,
            "total_count": len(answers),
            "correct_rate": round(correct_count / max(len(answers), 1) * 100, 1),
        })

    return {
        "quiz": {
            "id": quiz[0][0],
            "title": quiz[0][2],
            "question_count": len(questions),
        },
        "total_answers": len(answers),
        "question_stats": question_stats,
        "student_answers": [
            {"student": a[0], "score": a[2], "submitted_at": a[3]}
            for a in answers
        ],
    }


# ── 快速投票 ──

@router.post("/polls", summary="创建快速投票")
async def create_poll(req: PollCreate, request: Request):
    """教师创建快速投票"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可创建投票")

    if len(req.options) < 2:
        raise HTTPException(status_code=400, detail="至少需要2个选项")

    if req.poll_type not in ("single", "multiple"):
        raise HTTPException(status_code=400, detail="poll_type 必须是 single 或 multiple")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    poll_id = execute_insert_update(
        """INSERT INTO interaction_polls (creator_username, question, options, poll_type, status, created_at)
           VALUES (?, ?, ?, ?, 'active', ?)""",
        (user["username"], req.question, json.dumps(req.options, ensure_ascii=False), req.poll_type, now),
    )

    # ── 异步通知学生（不阻塞创建操作） ──
    async def _notify_poll():
        try:
            from backend.api.notification_router import _notify_users
            from backend.database import execute_query as db_query
            creator = user["username"]
            role_u = user.get("role", 2)
            if role_u == 0:
                students = db_query("SELECT username FROM users WHERE role = 2")
            else:
                grade, cls = _get_user_grade_class(creator)
                if grade:
                    cls_param = f",{cls}," if cls else ""
                    students = db_query(
                        f"SELECT username FROM users WHERE role = 2 AND grade = ?"
                        + (" AND INSTR(',' || class || ',', ?) > 0" if cls else ""),
                        (grade, cls_param) if cls else (grade,),
                    )
                else:
                    students = []
            if students:
                _notify_users(
                    [r[0] for r in students], "info",
                    f"新投票「{req.question}」已发布",
                    f"共 {len(req.options)} 个选项，请参与投票",
                    "/interaction",
                )
        except Exception as e:
            logger.warning(f"发送投票通知失败: {e}")
    asyncio.create_task(_notify_poll())

    return {"message": "投票创建成功", "poll_id": poll_id}


@router.get("/polls", summary="获取活跃投票")
async def list_polls(request: Request):
    """获取当前活跃的投票列表"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]

    if role == 2:
        # 学生：看自己班级的投票（管理员创建的全体可见，教师创建的需匹配班级）
        grade, cls = _get_user_grade_class(username)
        conditions = ["p.status = 'active'"]
        params: list = []
        if grade:
            conditions.append("(u.role = 0 OR u.grade = ?)")
            params.append(grade)
        if cls:
            cls_param = f",{cls},"
            conditions.append("(u.role = 0 OR INSTR(',' || u.class || ',', ?) > 0)")
            params.append(cls_param)
        where = " AND ".join(conditions)
        rows = execute_query(
            f"""SELECT p.id, p.creator_username, p.question, p.options, p.poll_type, p.status, p.created_at,
                        COALESCE(u.name, u.username) AS creator_name
                FROM interaction_polls p
                JOIN users u ON p.creator_username = u.username AND u.role IN (0, 1)
                WHERE {where}
                ORDER BY p.created_at DESC LIMIT 50""",
            tuple(params),
        )
    elif role == 1:
        # 教师：只看自己创建的投票
        rows = execute_query(
            """SELECT p.id, p.creator_username, p.question, p.options, p.poll_type, p.status, p.created_at,
                        COALESCE(u.name, u.username) AS creator_name
               FROM interaction_polls p
               LEFT JOIN users u ON p.creator_username = u.username
               WHERE p.status = 'active' AND p.creator_username = ?
               ORDER BY p.created_at DESC LIMIT 50""",
            (username,),
        )
    else:
        rows = execute_query(
            """SELECT p.id, p.creator_username, p.question, p.options, p.poll_type, p.status, p.created_at,
                        COALESCE(u.name, u.username) AS creator_name
               FROM interaction_polls p
               LEFT JOIN users u ON p.creator_username = u.username
               WHERE p.status = 'active'
               ORDER BY p.created_at DESC LIMIT 50""",
        )

    polls = []
    for r in rows:
        options = json.loads(r[3]) if isinstance(r[3], str) else r[3]
        poll_type = r[4] if r[4] else "single"
        creator_name = r[7] if len(r) > 7 else r[1]
        vote_counts = []
        for i in range(len(options)):
            cnt = execute_query(
                "SELECT COUNT(*) FROM interaction_poll_votes WHERE poll_id = ? AND selected_option = ?",
                (r[0], i),
            )
            vote_counts.append(cnt[0][0] if cnt else 0)

        # 对于多选投票，计算每人投了几项
        total_votes = sum(vote_counts)
        unique_voters = 0
        if poll_type == "multiple":
            voters = execute_query(
                "SELECT COUNT(DISTINCT student_username) FROM interaction_poll_votes WHERE poll_id = ?",
                (r[0],),
            )
            unique_voters = voters[0][0] if voters else 0

        # 学生端标记是否已投票
        voted = False
        if role == 2:
            voted_row = execute_query(
                "SELECT COUNT(*) FROM interaction_poll_votes WHERE poll_id = ? AND student_username = ?",
                (r[0], username),
            )
            voted = (voted_row[0][0] if voted_row else 0) > 0

        polls.append({
            "id": r[0],
            "creator_username": r[1],
            "creator_name": creator_name,
            "question": r[2],
            "poll_type": poll_type,
            "options": [{"index": i, "text": opt, "votes": vote_counts[i]} for i, opt in enumerate(options)],
            "total_votes": total_votes,
            "unique_voters": unique_voters or total_votes,
            "voted": voted,
            "created_at": r[6],
        })

    return {"polls": polls}


@router.post("/polls/{poll_id}/vote", summary="提交投票")
async def submit_vote(
    poll_id: int,
    request: Request,
    option_index: int = Query(None, description="单选：选项索引"),
    option_indices: str = Query(None, description="多选：逗号分隔的选项索引，如 '0,2,3'"),
):
    """学生参与投票，支持单选和多选"""
    user = get_current_user(request)
    username = user["username"]

    poll = execute_query(
        "SELECT * FROM interaction_polls WHERE id = ? AND status = 'active'",
        (poll_id,),
    )
    if not poll:
        raise HTTPException(status_code=404, detail="投票不存在或已结束")

    # 学生只能参与自己班级教师的投票
    role = user.get("role", 2)
    if role == 2:
        grade, cls = _get_user_grade_class(username)
        creator = poll[0][1]
        if cls:
            cls_param = f",{cls},"
            teacher_ok = execute_query(
                "SELECT username FROM users WHERE username = ? AND role IN (0, 1) AND grade = ? AND INSTR(',' || class || ',', ?) > 0",
                (creator, grade, cls_param),
            )
        else:
            teacher_ok = execute_query(
                "SELECT username FROM users WHERE username = ? AND role IN (0, 1) AND grade = ?",
                (creator, grade),
            )
        if not teacher_ok:
            raise HTTPException(status_code=403, detail="无权参与非本班教师的投票")

    poll_type = poll[0][6] if len(poll[0]) > 6 and poll[0][6] else "single"
    options = json.loads(poll[0][3]) if isinstance(poll[0][3], str) else poll[0][3]

    # 解析选择的选项
    selected_indices = []
    if poll_type == "single":
        if option_index is None:
            raise HTTPException(status_code=400, detail="请选择一个选项")
        selected_indices = [option_index]
    else:
        if not option_indices:
            raise HTTPException(status_code=400, detail="请至少选择一个选项")
        try:
            selected_indices = [int(i.strip()) for i in option_indices.split(",") if i.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="选项索引格式错误")
        if not selected_indices:
            raise HTTPException(status_code=400, detail="请至少选择一个选项")

    # 验证所有选项索引
    for idx in selected_indices:
        if idx < 0 or idx >= len(options):
            raise HTTPException(status_code=400, detail=f"无效的选项索引: {idx}")

    # 检查是否已投票
    existing = execute_query(
        "SELECT id FROM interaction_poll_votes WHERE poll_id = ? AND student_username = ?",
        (poll_id, username),
    )
    if existing:
        if poll_type == "single":
            raise HTTPException(status_code=400, detail="您已经投过票")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if poll_type == "multiple":
        # 多选：先删后插，所有操作在同一个事务中执行，避免数据库锁冲突
        ops = [
            ("DELETE FROM interaction_poll_votes WHERE poll_id = ? AND student_username = ?", (poll_id, username)),
        ]
        for idx in selected_indices:
            ops.append((
                "INSERT INTO interaction_poll_votes (poll_id, student_username, selected_option, created_at) VALUES (?, ?, ?, ?)",
                (poll_id, username, idx, now),
            ))
        execute_batch(ops)
    else:
        # 单选：直接插入一条记录
        execute_insert_update(
            "INSERT INTO interaction_poll_votes (poll_id, student_username, selected_option, created_at) VALUES (?, ?, ?, ?)",
            (poll_id, username, selected_indices[0], now),
        )

    return {"message": "投票成功", "selected_count": len(selected_indices)}


@router.get("/polls/{poll_id}/results", summary="查看投票结果")
async def get_poll_results(poll_id: int, request: Request):
    """获取投票实时结果"""
    poll = execute_query(
        "SELECT * FROM interaction_polls WHERE id = ?",
        (poll_id,),
    )
    if not poll:
        raise HTTPException(status_code=404, detail="投票不存在")

    options = json.loads(poll[0][3]) if isinstance(poll[0][3], str) else poll[0][3]
    vote_counts = []
    for i in range(len(options)):
        cnt = execute_query(
            "SELECT COUNT(*) FROM interaction_poll_votes WHERE poll_id = ? AND selected_option = ?",
            (poll_id, i),
        )
        vote_counts.append(cnt[0][0] if cnt else 0)

    total = sum(vote_counts)
    # 计算实际参与人数（去重）
    voters = execute_query(
        "SELECT COUNT(DISTINCT student_username) FROM interaction_poll_votes WHERE poll_id = ?",
        (poll_id,),
    )
    unique_voters = voters[0][0] if voters else 0
    poll_type = poll[0][6] if len(poll[0]) > 6 and poll[0][6] else "single"
    denominator = unique_voters if unique_voters > 0 else total
    return {
        "poll_id": poll_id,
        "question": poll[0][2],
        "poll_type": poll_type,
        "options": [
            {"index": i, "text": opt, "votes": vote_counts[i],
             "percentage": round(vote_counts[i] / max(denominator, 1) * 100, 1)}
            for i, opt in enumerate(options)
        ],
        "total_votes": total,
        "unique_voters": unique_voters,
    }


# ── 课堂提问 ──

@router.post("/questions", summary="学生发起提问")
async def ask_question(req: QuestionCreate, request: Request):
    """学生在课堂上提问"""
    user = get_current_user(request)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    qid = execute_insert_update(
        """INSERT INTO interaction_questions (student_username, content, is_anonymous, status, created_at)
           VALUES (?, ?, ?, 'pending', ?)""",
        (user["username"], req.content, 1 if req.is_anonymous else 0, now),
    )

    return {"message": "提问成功", "question_id": qid}


@router.get("/questions", summary="获取课堂提问列表")
async def list_questions(
    request: Request,
    status: str = Query("", description="筛选状态"),
):
    """获取课堂提问（教师看自己班级学生的提问，学生看所有）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]

    if role == 2:
        # 学生：只看自己班级同学的提问和回答
        grade, cls = _get_user_grade_class(username)
        conditions = []
        params: list = []
        if grade:
            conditions.append("u.grade = ?")
            params.append(grade)
        if cls:
            cls_param = f",{cls},"
            conditions.append("INSTR(',' || u.class || ',', ?) > 0")
            params.append(cls_param)
        where = " AND ".join(conditions) if conditions else "1=1"
        rows = execute_query(
            f"""SELECT q.id, q.student_username, q.content, q.is_anonymous, q.status, q.answer, q.created_at, q.answered_at
                FROM interaction_questions q
                JOIN users u ON q.student_username = u.username AND u.role = 2
                WHERE {where}
                ORDER BY q.created_at DESC""",
            tuple(params),
        )
    elif role == 1:
        # 教师：只看自己班级学生的提问
        grade, cls = _get_user_grade_class(username)
        conditions = []
        params: list = []
        if grade:
            conditions.append("u.grade = ?")
            params.append(grade)
        if cls:
            cls_param = f",{cls},"
            conditions.append("INSTR(',' || u.class || ',', ?) > 0")
            params.append(cls_param)
        if status:
            conditions.append("q.status = ?")
            params.append(status)
        where = " AND ".join(conditions) if conditions else "1=1"
        rows = execute_query(
            f"""SELECT q.id, q.student_username, q.content, q.is_anonymous, q.status, q.answer, q.created_at, q.answered_at
                FROM interaction_questions q
                JOIN users u ON q.student_username = u.username AND u.role = 2
                WHERE {where}
                ORDER BY q.created_at DESC""",
            tuple(params),
        )
    else:
        # 管理员：看全部
        conditions = []
        params: list = []
        if status:
            conditions.append("status = ?")
            params.append(status)
        where = " AND ".join(conditions) if conditions else "1=1"
        rows = execute_query(
            f"""SELECT id, student_username, content, is_anonymous, status, answer, created_at, answered_at
                FROM interaction_questions WHERE {where}
                ORDER BY created_at DESC""",
            tuple(params),
        )

    questions = []
    for r in rows:
        q = {
            "id": r[0],
            "content": r[2],
            "is_anonymous": bool(r[3]),
            "status": r[4],
            "answer": r[5] or "",
            "created_at": r[6],
        }
        if role != 2:
            q["student_username"] = r[1] if not r[3] else "(匿名)"
            q["answered_at"] = r[7] or ""
        questions.append(q)

    return {"questions": questions}


@router.put("/questions/{question_id}/answer", summary="教师回答提问")
async def answer_question(question_id: int, req: QuestionAnswer, request: Request):
    """教师回答学生提问（教师只能回答自己班级学生的问题）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师可回答")

    if role == 1:
        # 教师：验证该提问来自自己班级的学生
        grade, cls = _get_user_grade_class(username)
        if cls:
            cls_param = f",{cls},"
            rows = execute_query(
                """SELECT q.id FROM interaction_questions q
                   JOIN users u ON q.student_username = u.username AND u.role = 2
                   WHERE q.id = ? AND u.grade = ? AND INSTR(',' || u.class || ',', ?) > 0""",
                (question_id, grade, cls_param),
            )
        else:
            rows = execute_query(
                """SELECT q.id FROM interaction_questions q
                   JOIN users u ON q.student_username = u.username AND u.role = 2
                   WHERE q.id = ? AND u.grade = ?""",
                (question_id, grade),
            )
        if not rows:
            raise HTTPException(status_code=403, detail="无权回答非本班学生的提问")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "UPDATE interaction_questions SET answer = ?, status = 'answered', answered_at = ? WHERE id = ?",
        (req.answer, now, question_id),
    )

    return {"message": "回答成功"}


# ═══════════════════════════════════════════════════════════
# V3.4 新增：AI 实时答题分析
# ═══════════════════════════════════════════════════════════

@router.get("/quizzes/{quiz_id}/ai-analysis", summary="AI 实时答题分析")
async def ai_quiz_analysis(quiz_id: int, request: Request):
    """AI 分析随堂测验结果，生成教学建议"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    quiz = execute_query(
        "SELECT * FROM interaction_quizzes WHERE id = ?",
        (quiz_id,),
    )
    if not quiz:
        raise HTTPException(status_code=404, detail="测验不存在")

    quiz_data = quiz[0]
    questions = json.loads(quiz_data[4]) if isinstance(quiz_data[4], str) else quiz_data[4]

    answers = execute_query(
        "SELECT student_username, answers, score FROM interaction_quiz_answers WHERE quiz_id = ?",
        (quiz_id,),
    )

    participant_count = len(answers)
    total_possible = sum(q.get("score", 1) for q in questions)

    # 每题正确率统计
    question_stats = []
    for i, q in enumerate(questions):
        correct_count = 0
        q_type = q.get("type", "single")
        correct_ans = str(q.get("answer", "")).strip()
        wrong_options = {}  # 统计错误选项分布

        for a in answers:
            user_ans_list = json.loads(a[1]) if isinstance(a[1], str) else a[1]
            user_ans = ""
            for ua in user_ans_list:
                if ua.get("question_index") == i:
                    user_ans = str(ua.get("answer", "")).strip()
                    break

            if q_type == "multiple":
                user_set = sorted([x.strip().upper() for x in user_ans.split(",") if x.strip()])
                correct_set = sorted([x.strip().upper() for x in correct_ans.split(",") if x.strip()])
                if user_set == correct_set:
                    correct_count += 1
                else:
                    # 记录错误选项
                    for ans_part in user_set:
                        wrong_options[ans_part] = wrong_options.get(ans_part, 0) + 1
            else:
                if user_ans.upper() == correct_ans.upper():
                    correct_count += 1
                elif user_ans:
                    wrong_options[user_ans.upper()] = wrong_options.get(user_ans.upper(), 0) + 1

        rate = round(correct_count / max(participant_count, 1) * 100, 1)
        wrong_text = ""
        if wrong_options:
            sorted_wrong = sorted(wrong_options.items(), key=lambda x: -x[1])
            wrong_text = "，错误选项分布：" + "、".join(f"{k}({v}人)" for k, v in sorted_wrong[:3])

        question_stats.append({
            "index": i + 1,
            "text": q.get("question", "")[:60],
            "type": q_type,
            "correct_rate": rate,
            "correct_count": correct_count,
            "total": participant_count,
            "wrong_distribution": wrong_text,
        })

    # 构建统计文本
    stats_text = ""
    for qs in question_stats:
        stats_text += f"第{qs['index']}题 ({qs['type']}): 正确率{qs['correct_rate']}% ({qs['correct_count']}/{qs['total']}人){qs['wrong_distribution']}\n"
        stats_text += f"  题目：{qs['text']}\n\n"

    from backend.api.ai_service import call_ai_async
    from backend.ai_task_manager import task_manager

    async def _do_analysis() -> dict:
        from backend.prompts.interaction import QUIZ_ANALYSIS_PROMPT
        from backend.api.chat_router import get_api_keys

        keys = get_api_keys(user["username"])
        api_key = keys[0] if keys and keys[0] else ""
        if not api_key:
            raise HTTPException(status_code=400, detail="未配置 API Key")

        def _safe(s):
            return str(s).replace('{', '{{').replace('}', '}}')

        prompt = QUIZ_ANALYSIS_PROMPT.format(
            quiz_title=_safe(quiz_data[2] or ""),
            subject=_safe("信息科技"),
            participant_count=_safe(participant_count),
            question_stats=_safe(stats_text),
        )

        analysis = await call_ai_async(prompt, api_key)
        return {
            "analysis": analysis,
            "stats": question_stats,
            "participant_count": participant_count,
            "avg_score": round(sum(a[2] for a in answers) / max(participant_count, 1), 1),
            "total_score": total_possible,
        }

    task_id = await task_manager.create_task(
        description=f"测验 #{quiz_id} AI 答题分析",
        coro_factory=_do_analysis,
    )
    return {"task_id": task_id, "message": "AI 分析已提交，请稍后查询结果"}


# ═══════════════════════════════════════════════════════════
# V3.4 新增：AI 课堂总结
# ═══════════════════════════════════════════════════════════

@router.get("/class-summary", summary="AI 课堂总结")
async def ai_class_summary(
    request: Request,
    grade: str = Query("", description="年级"),
    cls: str = Query("", description="班级"),
    subject: str = Query("", description="学科（由前端传递）"),
    teacher_username: str = Query("", description="教师用户名"),
    time_range: str = Query("本堂课", description="时间范围"),
):
    """AI 综合分析课堂互动数据，生成课堂总结"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    query_teacher = teacher_username or user["username"]

    # 构建班级名称
    cls_display = cls
    cls_name = f"{grade}{cls_display}班" if not cls.endswith("班") else f"{grade}{cls}"

    # ── 1. 随堂测验数据 ──
    quizzes = execute_query(
        """SELECT q.id, q.title, q.questions,
                  (SELECT COUNT(*) FROM interaction_quiz_answers WHERE quiz_id = q.id) as answer_count
           FROM interaction_quizzes q
           WHERE q.creator_username = ? AND q.status = 'active'
           ORDER BY q.created_at DESC LIMIT 5""",
        (query_teacher,),
    )

    quiz_data = ""
    quiz_participants = set()
    for q in quizzes:
        questions = json.loads(q[2]) if isinstance(q[2], str) else q[2]
        q_count = len(questions) if isinstance(questions, list) else 0
        quiz_data += f"- 《{q[1]}》: {q_count}题, {q[3]}人参与\n"
        # 获取参与学生
        participants = execute_query(
            "SELECT student_username FROM interaction_quiz_answers WHERE quiz_id = ?",
            (q[0],),
        )
        for p in participants:
            quiz_participants.add(p[0])

    if not quiz_data:
        quiz_data = "暂无随堂测验数据"

    # ── 2. 投票数据 ──
    polls = execute_query(
        """SELECT p.id, p.question, p.options,
                  (SELECT COUNT(*) FROM interaction_poll_votes WHERE poll_id = p.id) as vote_count
           FROM interaction_polls p
           WHERE p.creator_username = ?
           ORDER BY p.created_at DESC LIMIT 5""",
        (query_teacher,),
    )

    poll_data = ""
    poll_participants = set()
    for p in polls:
        options = json.loads(p[2]) if isinstance(p[2], str) else p[2]
        opt_count = len(options) if isinstance(options, list) else 0
        poll_data += f"- 「{p[1]}」: {opt_count}个选项, {p[3]}人投票\n"
        voters = execute_query(
            "SELECT student_username FROM interaction_poll_votes WHERE poll_id = ?",
            (p[0],),
        )
        for v in voters:
            poll_participants.add(v[0])

    if not poll_data:
        poll_data = "暂无投票数据"

    # ── 3. 学生提问 ──
    questions_data = execute_query(
        """SELECT id, content, is_anonymous, status, created_at
           FROM interaction_questions
           ORDER BY created_at DESC LIMIT 10""",
    )

    question_data = ""
    for q in questions_data:
        status = "已回答" if q[3] == "answered" else "待回答"
        question_data += f"- {q[1][:60]} ({status})\n"

    if not question_data:
        question_data = "暂无学生提问"

    # ── 4. 分组讨论 ──
    discussions = execute_query(
        """SELECT d.id, d.title, d.status,
                  (SELECT COUNT(*) FROM discussion_groups g
                   INNER JOIN discussion_members m ON m.group_id = g.id
                   WHERE g.discussion_id = d.id) as member_count,
                  (SELECT COUNT(*) FROM discussion_groups g
                   INNER JOIN discussion_messages m ON m.group_id = g.id
                   WHERE g.discussion_id = d.id) as msg_count
           FROM discussions d
           WHERE d.creator_username = ?
           ORDER BY d.created_at DESC LIMIT 5""",
        (query_teacher,),
    )

    discussion_data = ""
    for d in discussions:
        discussion_data += f"- 《{d[1]}》: {d[3]}人参与, {d[4]}条消息 ({d[2]})\n"

    if not discussion_data:
        discussion_data = "暂无分组讨论数据"

    # 计算总参与人数
    all_participants = quiz_participants | poll_participants
    student_count = len(all_participants)

    from backend.api.ai_service import call_ai_async
    from backend.ai_task_manager import task_manager

    # 将参数复制到局部变量，避免闭包引用外层参数
    _subject = subject
    _time_range = time_range

    async def _do_summary() -> dict:
        from backend.prompts.class_summary import CLASS_SUMMARY_PROMPT
        from backend.api.chat_router import get_api_keys

        keys = get_api_keys(user["username"])
        api_key = keys[0] if keys and keys[0] else ""
        if not api_key:
            raise HTTPException(status_code=400, detail="未配置 API Key")

        def _safe(s):
            return str(s).replace('{', '{{').replace('}', '}}')

        prompt = CLASS_SUMMARY_PROMPT.format(
            subject=_safe(_subject),
            time_range=_safe(_time_range),
            student_count=_safe(student_count),
            quiz_data=_safe(quiz_data),
            poll_data=_safe(poll_data),
            question_data=_safe(question_data),
            discussion_data=_safe(discussion_data),
        )

        summary = await call_ai_async(prompt, api_key)
        return {
            "summary": summary,
            "data": {
                "quiz_count": len(quizzes),
                "poll_count": len(polls),
                "question_count": len(questions_data),
                "discussion_count": len(discussions),
                "student_count": student_count,
            },
        }

    task_id = await task_manager.create_task(
        description="AI 课堂总结",
        coro_factory=_do_summary,
    )
    return {"task_id": task_id, "message": "课堂总结已提交，请稍后查询结果"}


# ═══════════════════════════════════════════════════════════
# V3.4 新增：AI 异步任务状态查询
# ═══════════════════════════════════════════════════════════

@router.get("/ai-task/{task_id}", summary="查询 AI 异步任务状态")
async def get_ai_task_status(task_id: str):
    """查询 AI 后台任务的执行状态和结果"""
    from backend.ai_task_manager import task_manager
    task = task_manager.get_task_dict(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    return task
