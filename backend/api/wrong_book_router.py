"""
错题本 API 路由
自动归集学生错题，AI 生成复习计划
"""
import json
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query

from backend.api.dependencies import get_current_user
from backend.question_db import execute_query, execute_query_one
from backend.database import execute_query as user_query
from backend.logger import logger
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_sync

router = APIRouter()


@router.get("/list", summary="获取我的错题")
async def get_wrong_questions(request: Request):
    """获取当前学生的所有错题，按考试归类"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 2:
        # 学生看自己的
        target_username = username
    else:
        # 教师/管理员看指定学生，默认看第一个有错题记录的学生
        target = request.query_params.get("student_username", "")
        if target:
            target_username = target
        else:
            # 自动查找有错题记录的第一个学生
            first = execute_query(
                """SELECT DISTINCT ea.student_username FROM exam_attempts ea
                   WHERE ea.status = 'submitted' ORDER BY ea.submitted_at DESC LIMIT 1"""
            )
            target_username = first[0]["student_username"] if first else ""

    if not target_username:
        return {"total_wrong": 0, "exams": []}

    attempts = execute_query(
        """SELECT ea.id, ea.exam_id, ea.score, ea.total_score, ea.submitted_at, ea.answers,
                  e.title as exam_title, e.subject as exam_subject
           FROM exam_attempts ea
           JOIN exams e ON e.id = ea.exam_id
           WHERE ea.student_username = ? AND ea.status = 'submitted'
           ORDER BY ea.submitted_at DESC""",
        (target_username,),
    )

    wrong_list = []
    total_wrong = 0

    for a in attempts:
        answers_data = a.get("answers")
        if isinstance(answers_data, str):
            try:
                answers_data = json.loads(answers_data)
            except (json.JSONDecodeError, TypeError):
                answers_data = {}

        if not answers_data:
            continue

        # 获取该考试的题目信息
        questions = execute_query(
            """SELECT q.id, q.type, q.question_text, q.correct_answer,
                      q.knowledge_points, eq.score as question_score
               FROM exam_questions eq
               JOIN question_bank q ON q.id = eq.question_id
               WHERE eq.exam_id = ? AND q.status = 'active'""",
            (a["exam_id"],),
        )
        q_map = {str(q["id"]): q for q in questions}

        exam_wrong = []
        for qid, ans in answers_data.items():
            if isinstance(ans, dict) and not ans.get("is_correct", False):
                q_info = q_map.get(qid, {})
                exam_wrong.append({
                    "question_id": qid,
                    "question_text": q_info.get("question_text", ""),
                    "question_type": q_info.get("type", ""),
                    "correct_answer": q_info.get("correct_answer", ""),
                    "student_answer": ans.get("student_answer", ""),
                    "score": ans.get("score", 0),
                    "max_score": ans.get("max_score", 0),
                    "knowledge_points": q_info.get("knowledge_points", ""),
                })
                total_wrong += 1

        if exam_wrong:
            wrong_list.append({
                "exam_id": a["exam_id"],
                "exam_title": a["exam_title"],
                "exam_subject": a["exam_subject"],
                "submitted_at": a["submitted_at"],
                "score": a["score"],
                "total_score": a["total_score"],
                "wrong_count": len(exam_wrong),
                "wrong_questions": exam_wrong,
            })

    return {
        "total_wrong": total_wrong,
        "exams": wrong_list,
        "student_username": target_username,
    }


@router.get("/students", summary="获取有错题记录的学生列表")
async def get_students_with_wrong(request: Request):
    """获取有错题记录的学生列表（供教师/管理员选择）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    rows = execute_query(
        """SELECT DISTINCT ea.student_username, u.name
           FROM exam_attempts ea
           LEFT JOIN users u ON u.username = ea.student_username
           WHERE ea.status = 'submitted'
           ORDER BY ea.submitted_at DESC"""
    )
    seen = set()
    students = []
    for r in rows:
        uname = r["student_username"]
        if uname not in seen:
            seen.add(uname)
            students.append({
                "username": uname,
                "name": r.get("name") or uname,
            })
    return {"students": students}


@router.get("/review-plan", summary="AI 生成错题复习计划")
async def get_review_plan(request: Request):
    """AI 根据错题生成个性化复习计划"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    target_username = username
    if role != 2:
        target_username = request.query_params.get("student_username", username)

    # 获取学生信息
    user_rows = user_query(
        "SELECT name, grade, class FROM users WHERE username=?",
        (target_username,),
    )
    student_name = user_rows[0][0] if user_rows and user_rows[0][0] else target_username
    student_grade = user_rows[0][1] if user_rows else ""
    student_class = user_rows[0][2] if user_rows else ""

    # 获取所有错题
    attempts = execute_query(
        """SELECT ea.id, ea.exam_id, ea.answers
           FROM exam_attempts ea
           JOIN exams e ON e.id = ea.exam_id
           WHERE ea.student_username = ? AND ea.status = 'submitted'
           ORDER BY ea.submitted_at DESC""",
        (target_username,),
    )

    all_wrong = []
    kp_set = set()
    type_set = set()

    for a in attempts:
        answers_data = a.get("answers")
        if isinstance(answers_data, str):
            try:
                answers_data = json.loads(answers_data)
            except (json.JSONDecodeError, TypeError):
                answers_data = {}

        if not answers_data:
            continue

        questions = execute_query(
            """SELECT q.id, q.type, q.question_text, q.correct_answer,
                      q.knowledge_points
               FROM exam_questions eq
               JOIN question_bank q ON q.id = eq.question_id
               WHERE eq.exam_id = ? AND q.status = 'active'""",
            (a["exam_id"],),
        )
        q_map = {str(q["id"]): q for q in questions}

        for qid, ans in answers_data.items():
            if isinstance(ans, dict) and not ans.get("is_correct", False):
                q_info = q_map.get(qid, {})
                kp = q_info.get("knowledge_points", "") or "未知"
                kp_set.add(kp)
                q_type = q_info.get("type", "")
                type_set.add(q_type)
                all_wrong.append({
                    "question": q_info.get("question_text", ""),
                    "type": q_type,
                    "correct": q_info.get("correct_answer", ""),
                    "your_answer": ans.get("student_answer", ""),
                    "knowledge": kp,
                })

    if not all_wrong:
        return {"plan": "暂无错题，继续保持！", "total_wrong": 0}

    # 构建错题文本
    wrong_text = ""
    for i, w in enumerate(all_wrong[:15], 1):
        wrong_text += f"{i}. [{w['type']}] {w['question']}\n"
        wrong_text += f"   你的答案：{w['your_answer']} | 正确答案：{w['correct']}\n"
        wrong_text += f"   知识点：{w['knowledge']}\n\n"

    type_labels = {"single": "单选题", "multiple": "多选题", "true_false": "判断题", "short": "简答题"}
    weak_types = "、".join(type_labels.get(t, t) for t in type_set)

    from backend.prompts.wrong_book import WRONG_BOOK_REVIEW_PROMPT

    prompt = WRONG_BOOK_REVIEW_PROMPT.format(
        student_name=student_name,
        grade=student_grade,
        cls=student_class,
        total_wrong=len(all_wrong),
        knowledge_points="、".join(sorted(kp_set)[:10]),
        weak_types=weak_types,
        wrong_questions=wrong_text,
    )

    keys = get_api_keys(username)
    api_key = keys[0] if keys and keys[0] else ""
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    try:
        plan = call_ai_sync(prompt, api_key)
    except Exception as e:
        logger.error(f"AI 复习计划生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"生成复习计划失败: {str(e)}")

    return {
        "plan": plan,
        "total_wrong": len(all_wrong),
        "knowledge_points": list(kp_set),
        "weak_types": list(type_set),
    }
