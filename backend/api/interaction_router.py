"""
课堂互动 API 路由
随堂测验、快速投票、课堂提问
"""
import json
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.database import execute_query, execute_insert_update
from backend.logger import logger

router = APIRouter()


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


class QuestionCreate(BaseModel):
    content: str
    is_anonymous: bool = False


class QuestionAnswer(BaseModel):
    answer: str


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
    return {"message": "测验创建成功", "quiz_id": quiz_id}


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
        conditions.append("status = 'active'")
    elif role == 1:
        conditions.append("creator_username = ?")
        params.append(username)

    if status:
        conditions.append("status = ?")
        params.append(status)

    where = " AND ".join(conditions) if conditions else "1=1"
    offset = (page - 1) * page_size

    rows = execute_query(
        f"""SELECT id, creator_username, title, description, questions, status, created_at, updated_at
            FROM interaction_quizzes WHERE {where}
            ORDER BY created_at DESC LIMIT ? OFFSET ?""",
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
        }
        # 计算答题人数
        count_rows = execute_query(
            "SELECT COUNT(*) FROM interaction_quiz_answers WHERE quiz_id = ?",
            (r[0],),
        )
        q["answer_count"] = count_rows[0][0] if count_rows else 0
        quizzes.append(q)

    return {"quizzes": quizzes}


@router.post("/quizzes/{quiz_id}/answer", summary="提交测验答案")
async def submit_quiz_answer(quiz_id: int, req: QuizAnswerSubmit, request: Request):
    """学生提交随堂测验答案"""
    user = get_current_user(request)
    username = user["username"]

    # 验证测验存在且活跃
    quiz = execute_query(
        "SELECT * FROM interaction_quizzes WHERE id = ? AND status = 'active'",
        (quiz_id,),
    )
    if not quiz:
        raise HTTPException(status_code=404, detail="测验不存在或已结束")

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
    for ua in user_answers:
        idx = ua.get("question_index")
        if idx is not None and idx < len(questions):
            if str(ua.get("answer", "")).strip() == str(questions[idx].get("answer", "")).strip():
                total_score += questions[idx].get("score", 1)

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


@router.get("/quizzes/{quiz_id}/results", summary="查看测验结果")
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
        for a in answers:
            user_ans = json.loads(a[1]) if isinstance(a[1], str) else a[1]
            for ua in user_ans:
                if ua.get("question_index") == i:
                    if str(ua.get("answer", "")).strip() == str(q.get("answer", "")).strip():
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

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    poll_id = execute_insert_update(
        """INSERT INTO interaction_polls (creator_username, question, options, status, created_at)
           VALUES (?, ?, ?, 'active', ?)""",
        (user["username"], req.question, json.dumps(req.options, ensure_ascii=False), now),
    )

    return {"message": "投票创建成功", "poll_id": poll_id}


@router.get("/polls", summary="获取活跃投票")
async def list_polls(request: Request):
    """获取当前活跃的投票列表"""
    rows = execute_query(
        """SELECT id, creator_username, question, options, status, created_at
           FROM interaction_polls WHERE status = 'active'
           ORDER BY created_at DESC LIMIT 10""",
    )

    polls = []
    for r in rows:
        options = json.loads(r[3]) if isinstance(r[3], str) else r[3]
        vote_counts = []
        for i in range(len(options)):
            cnt = execute_query(
                "SELECT COUNT(*) FROM interaction_poll_votes WHERE poll_id = ? AND selected_option = ?",
                (r[0], i),
            )
            vote_counts.append(cnt[0][0] if cnt else 0)

        polls.append({
            "id": r[0],
            "creator": r[1],
            "question": r[2],
            "options": [{"index": i, "text": opt, "votes": vote_counts[i]} for i, opt in enumerate(options)],
            "total_votes": sum(vote_counts),
            "created_at": r[5],
        })

    return {"polls": polls}


@router.post("/polls/{poll_id}/vote", summary="提交投票")
async def submit_vote(poll_id: int, request: Request, option_index: int = Query(..., description="选项索引")):
    """学生参与投票"""
    user = get_current_user(request)
    username = user["username"]

    poll = execute_query(
        "SELECT * FROM interaction_polls WHERE id = ? AND status = 'active'",
        (poll_id,),
    )
    if not poll:
        raise HTTPException(status_code=404, detail="投票不存在或已结束")

    options = json.loads(poll[0][3]) if isinstance(poll[0][3], str) else poll[0][3]
    if option_index < 0 or option_index >= len(options):
        raise HTTPException(status_code=400, detail="无效的选项")

    existing = execute_query(
        "SELECT id FROM interaction_poll_votes WHERE poll_id = ? AND student_username = ?",
        (poll_id, username),
    )
    if existing:
        raise HTTPException(status_code=400, detail="您已经投过票")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "INSERT INTO interaction_poll_votes (poll_id, student_username, selected_option, created_at) VALUES (?, ?, ?, ?)",
        (poll_id, username, option_index, now),
    )

    return {"message": "投票成功"}


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
    return {
        "poll_id": poll_id,
        "question": poll[0][2],
        "options": [
            {"index": i, "text": opt, "votes": vote_counts[i],
             "percentage": round(vote_counts[i] / max(total, 1) * 100, 1)}
            for i, opt in enumerate(options)
        ],
        "total_votes": total,
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
    """获取课堂提问（教师看全部，学生看自己的）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]

    if role == 2:
        rows = execute_query(
            """SELECT id, content, is_anonymous, status, answer, created_at, answered_at
               FROM interaction_questions WHERE student_username = ?
               ORDER BY created_at DESC""",
            (username,),
        )
    else:
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
    """教师回答学生提问"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师可回答")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "UPDATE interaction_questions SET answer = ?, status = 'answered', answered_at = ? WHERE id = ?",
        (req.answer, now, question_id),
    )

    return {"message": "回答成功"}
