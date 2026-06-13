"""
错题本 API 路由
自动归集学生错题，AI 生成复习计划
"""
import json
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.question_db import execute_query, execute_query_one
from backend.database import execute_query as user_query
from backend.logger import logger
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_async
from backend.database import execute_query as db_exec, execute_insert_update as db_insert

router = APIRouter()


def _parse_teacher_grade_class(grade: str, class_str: str) -> dict[str, list[str]]:
    """解析教师的年级和班级字段，返回 {年级: [班级列表]} 的映射"""
    result = {}
    if not grade or not grade.strip():
        return result

    grade_parts = [g.strip() for g in grade.split("|")]
    class_parts = [c.strip() for c in class_str.split("|")] if class_str else []

    for i, g in enumerate(grade_parts):
        if not g:
            continue
        if i < len(class_parts) and class_parts[i]:
            classes = [c.strip() for c in class_parts[i].split(",") if c.strip()]
            result[g] = classes
        else:
            result[g] = []
    return result


def _check_teacher_can_view_student(teacher_username: str, student_username: str):
    """检查教师是否有权限查看该学生的错题（教师只能看自己班级的学生）"""
    teacher_rows = user_query(
        "SELECT grade, class FROM users WHERE username=?", (teacher_username,)
    )
    teacher_grade = (teacher_rows[0][0] or "").strip() if teacher_rows else ""
    teacher_class = str(teacher_rows[0][1] or "").strip() if teacher_rows else ""
    grade_class_map = _parse_teacher_grade_class(teacher_grade, teacher_class)

    student_rows = user_query(
        "SELECT grade, class FROM users WHERE username=?", (student_username,)
    )
    if not student_rows:
        raise HTTPException(status_code=404, detail="学生不存在")
    student_grade = (student_rows[0][0] or "").strip()
    student_class = str(student_rows[0][1] or "").strip()

    allowed_classes = grade_class_map.get(student_grade, [])
    if allowed_classes and student_class not in allowed_classes:
        raise HTTPException(status_code=403, detail="无权查看其他班级学生的错题")
    if not allowed_classes and student_grade not in grade_class_map:
        raise HTTPException(status_code=403, detail="无权查看其他年级学生的错题")


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
            # 教师只能查看自己班级的学生
            if role == 1:
                _check_teacher_can_view_student(username, target)
            target_username = target
        else:
            # 自动查找有错题记录的第一个学生（教师只能看自己班级的）
            if role == 1:
                teacher_rows = user_query(
                    "SELECT grade, class FROM users WHERE username=?", (username,)
                )
                teacher_grade = (teacher_rows[0][0] or "").strip() if teacher_rows else ""
                teacher_class = str(teacher_rows[0][1] or "").strip() if teacher_rows else ""
                grade_class_map = _parse_teacher_grade_class(teacher_grade, teacher_class)

                # 构建教师班级的 OR 条件
                grade_conditions = []
                params = []
                for g, classes in grade_class_map.items():
                    if classes:
                        cls_placeholders = ",".join("?" * len(classes))
                        grade_conditions.append("(u.grade = ? AND u.class IN ({}))".format(cls_placeholders))
                        params.extend([g] + classes)
                    else:
                        grade_conditions.append("u.grade = ?")
                        params.append(g)

                if grade_conditions:
                    where_clause = " OR ".join(grade_conditions)
                    first = execute_query(
                        f"""SELECT ea.student_username FROM exam_attempts ea
                           JOIN exams e ON e.id = ea.exam_id
                           JOIN (SELECT username, grade, class FROM users) u ON u.username = ea.student_username
                           WHERE ea.status = 'submitted' AND ({where_clause})
                           ORDER BY ea.submitted_at DESC LIMIT 1""",
                        tuple(params),
                    )
                else:
                    first = []
                target_username = first[0]["student_username"] if first else ""
            else:
                # 管理员看到所有
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
                      q.knowledge_points, q.options, eq.score as question_score,
                      q.svg_content, q.has_svg, q.media_files, q.media_placeholders
               FROM exam_questions eq
               JOIN question_bank q ON q.id = eq.question_id
               WHERE eq.exam_id = ? AND q.status = 'active'""",
            (a["exam_id"],),
        )
        q_map = {str(q["id"]): q for q in questions}

        exam_wrong = []
        for qid, ans in answers_data.items():
            if isinstance(ans, dict) and not ans.get("is_correct", False):
                # 检查该题在后来的考试/练习中是否已被答对
                if _is_question_mastered(target_username, qid, a["submitted_at"]):
                    continue
                q_info = q_map.get(qid, {})
                # 解析选项
                options_raw = q_info.get("options", "")
                options = {}
                if options_raw:
                    try:
                        opts = json.loads(options_raw) if isinstance(options_raw, str) else options_raw
                        if isinstance(opts, dict):
                            options = opts
                    except (json.JSONDecodeError, TypeError):
                        pass
                exam_wrong.append({
                    "question_id": qid,
                    "question_text": q_info.get("question_text", ""),
                    "question_type": q_info.get("type", ""),
                    "options": options,
                    "correct_answer": q_info.get("correct_answer", ""),
                    "student_answer": ans.get("student_answer", ""),
                    "score": ans.get("score", 0),
                    "max_score": ans.get("max_score", 0),
                    "knowledge_points": q_info.get("knowledge_points", ""),
                    "svg_content": q_info.get("svg_content", ""),
                    "has_svg": q_info.get("has_svg", 0),
                    "media_files": q_info.get("media_files", ""),
                    "media_placeholders": q_info.get("media_placeholders", ""),
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


def _is_question_mastered(student_username: str, question_id: str, submitted_at: str) -> bool:
    """检查学生在该次提交之后，是否在后续考试或练习中答对了该题"""
    # 检查后续的考试中是否答对（exam_attempts 在 question_db 中，用顶层 execute_query）
    later_exams = execute_query(
        """SELECT ea.answers
           FROM exam_attempts ea
           JOIN exams e ON e.id = ea.exam_id
           WHERE ea.student_username = ? AND ea.status = 'submitted' AND ea.submitted_at > ?
           ORDER BY ea.submitted_at DESC""",
        (student_username, submitted_at),
    )
    for exam in later_exams:
        answers = exam.get("answers")
        if isinstance(answers, str):
            try:
                answers = json.loads(answers)
            except (json.JSONDecodeError, TypeError):
                continue
        if isinstance(answers, dict) and question_id in answers:
            ans = answers[question_id]
            if isinstance(ans, dict) and ans.get("is_correct", False):
                return True

    # 检查练习中是否答对（practice_attempts 在 smartkb.db 中，用顶层 user_query）
    practice_attempts = user_query(
        """SELECT pa.answers
           FROM practice_attempts pa
           WHERE pa.student_username = ? AND pa.status = 'submitted' AND pa.submitted_at > ?
           ORDER BY pa.submitted_at DESC""",
        (student_username, submitted_at),
    )
    for attempt in practice_attempts:
        p_answers = attempt.get("answers")
        if isinstance(p_answers, str):
            try:
                p_answers = json.loads(p_answers)
            except (json.JSONDecodeError, TypeError):
                continue
        if isinstance(p_answers, dict) and question_id in p_answers:
            ans = p_answers[question_id]
            if isinstance(ans, dict) and ans.get("is_correct", False):
                return True

    return False


@router.get("/students", summary="获取有错题记录的学生列表")
async def get_students_with_wrong(
    request: Request,
    grade: str = Query("", description="年级筛选"),
    class_name: str = Query("", description="班级筛选"),
):
    """获取有错题记录的学生列表（教师只返回自己所教班级的学生）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    # 先查有错题记录的学生用户名
    rows = execute_query(
        """SELECT DISTINCT ea.student_username FROM exam_attempts ea
           WHERE ea.status = 'submitted'"""
    )
    usernames = [r["student_username"] for r in rows]
    if not usernames:
        return {"students": []}

    # 构建查询条件
    conditions = ["username IN ({})".format(",".join("?" * len(usernames)))]
    params = list(usernames)

    if grade:
        conditions.append("grade = ?")
        params.append(grade)
    if class_name:
        conditions.append("class = ?")
        params.append(class_name)

    # 教师只能看自己所教班级的学生
    if role == 1:
        teacher_rows = user_query(
            "SELECT grade, class FROM users WHERE username=?", (username,)
        )
        teacher_grade = (teacher_rows[0][0] or "").strip() if teacher_rows else ""
        teacher_class = str(teacher_rows[0][1] or "").strip() if teacher_rows else ""
        grade_class_map = _parse_teacher_grade_class(teacher_grade, teacher_class)

        if not grade:
            # 没有指定年级，限制在所有所教年级和班级
            grade_conditions = []
            for g, classes in grade_class_map.items():
                if classes:
                    cls_placeholders = ",".join("?" * len(classes))
                    grade_conditions.append("(grade = ? AND class IN ({}))".format(cls_placeholders))
                    params.extend([g] + classes)
                else:
                    grade_conditions.append("grade = ?")
                    params.append(g)
            if grade_conditions:
                conditions.append("(" + " OR ".join(grade_conditions) + ")")
        else:
            # 指定了年级，只限制该年级下的班级
            allowed_classes = grade_class_map.get(grade, [])
            if allowed_classes:
                cls_placeholders = ",".join("?" * len(allowed_classes))
                conditions.append("class IN ({})".format(cls_placeholders))
                params.extend(allowed_classes)

    where = " AND ".join(conditions)
    student_rows = user_query(
        f"""SELECT username, name, grade, class FROM users
           WHERE {where}
           ORDER BY grade, class""",
        tuple(params),
    )

    students = []
    for r in student_rows:
        students.append({
            "username": r[0],
            "name": r[1] or r[0],
            "grade": r[2] or "",
            "class": str(r[3] or ""),
        })
    return {"students": students}


@router.get("/grades", summary="获取有错题记录的年级列表")
async def get_grades_with_wrong(request: Request):
    """获取有错题记录的年级列表（教师只返回自己所教年级）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    # 先查有错题记录的学生用户名
    rows = execute_query(
        """SELECT DISTINCT ea.student_username FROM exam_attempts ea
           WHERE ea.status = 'submitted'"""
    )
    usernames = [r["student_username"] for r in rows]
    if not usernames:
        return {"grades": []}

    # 管理员看到所有年级
    if role == 0:
        placeholders = ",".join("?" * len(usernames))
        grade_rows = user_query(
            f"""SELECT DISTINCT grade FROM users
               WHERE username IN ({placeholders}) AND grade IS NOT NULL AND grade != ''
               ORDER BY grade""",
            tuple(usernames),
        )
        return {"grades": [r[0] for r in grade_rows]}

    # 教师只返回自己所教年级
    teacher_rows = user_query(
        "SELECT grade, class FROM users WHERE username=?", (username,)
    )
    teacher_grade = (teacher_rows[0][0] or "").strip() if teacher_rows else ""
    teacher_class = str(teacher_rows[0][1] or "").strip() if teacher_rows else ""
    grade_class_map = _parse_teacher_grade_class(teacher_grade, teacher_class)
    teacher_grades = list(grade_class_map.keys())

    if not teacher_grades:
        return {"grades": []}

    placeholders = ",".join("?" * len(usernames))
    grade_rows = user_query(
        f"""SELECT DISTINCT grade FROM users
           WHERE username IN ({placeholders}) AND grade IS NOT NULL AND grade != ''
           AND grade IN ({','.join('?' * len(teacher_grades))})
           ORDER BY grade""",
        tuple(usernames + teacher_grades),
    )
    return {"grades": [r[0] for r in grade_rows]}


@router.get("/classes", summary="获取指定年级下有错题记录的班级列表")
async def get_classes_with_wrong(
    request: Request,
    grade: str = Query("", description="年级"),
):
    """获取指定年级下有错题记录的班级列表（教师只返回自己所教班级）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    if not grade:
        return {"classes": []}

    # 先查有错题记录的学生用户名
    rows = execute_query(
        """SELECT DISTINCT ea.student_username FROM exam_attempts ea
           WHERE ea.status = 'submitted'"""
    )
    usernames = [r["student_username"] for r in rows]
    if not usernames:
        return {"classes": []}

    # 管理员看到该年级所有班级
    placeholders = ",".join("?" * len(usernames))
    params = [grade] + usernames

    if role == 0:
        class_rows = user_query(
            f"""SELECT DISTINCT class FROM users
               WHERE grade = ? AND username IN ({placeholders})
               AND class IS NOT NULL AND class != ''
               ORDER BY class""",
            tuple(params),
        )
        return {"classes": [str(r[0]) for r in class_rows]}

    # 教师只返回自己所教班级
    teacher_rows = user_query(
        "SELECT grade, class FROM users WHERE username=?", (username,)
    )
    teacher_grade = (teacher_rows[0][0] or "").strip() if teacher_rows else ""
    teacher_class = str(teacher_rows[0][1] or "").strip() if teacher_rows else ""
    grade_class_map = _parse_teacher_grade_class(teacher_grade, teacher_class)
    allowed_classes = grade_class_map.get(grade, [])

    if not allowed_classes:
        return {"classes": []}

    class_placeholders = ",".join("?" * len(allowed_classes))
    class_rows = user_query(
        f"""SELECT DISTINCT class FROM users
           WHERE grade = ? AND username IN ({placeholders})
           AND class IS NOT NULL AND class != ''
           AND class IN ({class_placeholders})
           ORDER BY class""",
        tuple(params + allowed_classes),
    )
    return {"classes": [str(r[0]) for r in class_rows]}


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

    type_labels = {"single": "单选题", "multiple": "多选题", "true_false": "判断题", "short": "简答题",
                   "fill": "填空题", "essay": "作文", "subjective": "主观题"}
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

    from backend.ai_task_manager import task_manager

    async def _do_plan() -> dict:
        try:
            result = await call_ai_async(prompt, api_key)
            return {"plan": result}
        except Exception as e:
            logger.error(f"AI 复习计划生成失败: {e}")
            return {"error": f"生成复习计划失败: {str(e)}"}

    task_id = await task_manager.create_task(description="错题复习计划", coro_factory=_do_plan)

    return {
        "task_id": task_id,
        "message": "AI 复习计划已提交，请稍后查询结果",
        "total_wrong": len(all_wrong),
        "knowledge_points": list(kp_set),
        "weak_types": list(type_set),
    }


@router.get("/review-plan/export", summary="导出 AI 复习计划为 Word 文档")
async def export_review_plan_docx(
    request: Request,
    student_username: str = Query("", description="学生用户名"),
    token: str = Query("", description="JWT token 用于 window.open 下载"),
):
    """导出 AI 复习计划为 Word 文档"""
    import io
    from docx import Document
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from fastapi.responses import StreamingResponse

    if token:
        request.state.user = None
        from backend.auth import decode_jwt_token
        payload = decode_jwt_token(token)
        if payload:
            request.state.user = payload

    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    target_username = username
    if role != 2:
        target_username = student_username or username

    # 先调用 AI 生成复习计划
    user_rows = user_query(
        "SELECT name, grade, class FROM users WHERE username=?",
        (target_username,),
    )
    student_name = user_rows[0][0] if user_rows and user_rows[0][0] else target_username
    student_grade = user_rows[0][1] if user_rows else ""
    student_class = user_rows[0][2] if user_rows else ""

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
            """SELECT q.id, q.type, q.question_text, q.correct_answer, q.knowledge_points,
                      q.svg_content, q.has_svg, q.media_files, q.media_placeholders
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
        raise HTTPException(status_code=400, detail="暂无错题，无需生成复习计划")

    wrong_text = ""
    for i, w in enumerate(all_wrong[:15], 1):
        wrong_text += f"{i}. [{w['type']}] {w['question']}\n"
        wrong_text += f"   你的答案：{w['your_answer']} | 正确答案：{w['correct']}\n"
        wrong_text += f"   知识点：{w['knowledge']}\n\n"

    type_labels = {"single": "单选题", "multiple": "多选题", "true_false": "判断题", "short": "简答题",
                   "fill": "填空题", "essay": "作文", "subjective": "主观题"}
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

    keys = get_api_keys(username if role == 2 else username)
    api_key = keys[0] if keys and keys[0] else ""
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    try:
        plan_text = await call_ai_async(prompt, api_key)
    except Exception as e:
        logger.error(f"AI 复习计划生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"生成复习计划失败: {str(e)}")

    # 生成 Word 文档
    doc = Document()
    style = doc.styles['Normal']
    style.font.name = 'Microsoft YaHei'
    style.font.size = Pt(11)
    style.paragraph_format.line_spacing = 1.5

    title = doc.add_heading(f"{student_name} 的 AI 复习计划", level=1)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER

    info = doc.add_paragraph()
    info.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = info.add_run(f"学生：{student_name}  年级：{student_grade}  班级：{student_class}班  错题数：{len(all_wrong)} 道")
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    doc.add_paragraph()

    for line in plan_text.split('\n'):
        line = line.strip()
        if not line:
            doc.add_paragraph()
            continue
        if line.startswith('### '):
            doc.add_heading(line[4:], level=3)
        elif line.startswith('## '):
            doc.add_heading(line[3:], level=2)
        elif line.startswith('# '):
            doc.add_heading(line[2:], level=1)
        elif line.startswith('- **') and '：' in line:
            content = line.lstrip('- ')
            p = doc.add_paragraph()
            bold_end = content.find('**', 2)
            if bold_end > 0:
                run = p.add_run(content[2:bold_end])
                run.bold = True
                p.add_run(content[bold_end + 2:])
            else:
                p.add_run(content)
        elif line.startswith('- '):
            doc.add_paragraph(line[2:], style='List Bullet')
        elif any(line.startswith(f'{i}. ') for i in range(1, 10)):
            doc.add_paragraph(line, style='List Number')
        else:
            if '**' in line:
                p = doc.add_paragraph()
                parts = line.split('**')
                for i, part in enumerate(parts):
                    if part:
                        run = p.add_run(part)
                        if i % 2 == 1:
                            run.bold = True
            else:
                doc.add_paragraph(line)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    import urllib.parse
    safe_filename = urllib.parse.quote(f"{student_name}_复习计划.docx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}"},
    )


# ═══════════════════════════════════════════════════════════
# 错本题追踪系统（v5.3）
# ═══════════════════════════════════════════════════════════

def record_wrong_answers(student_username: str, exam_id: int, graded_answers: dict):
    """考试提交后，将答错的题目记录到 wrong_book 表"""
    from backend.question_db import execute_query as q_exec
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for qid_str, ans in graded_answers.items():
        if isinstance(ans, dict) and not ans.get("is_correct", False):
            # 获取题目知识点和类型
            q_info = q_exec(
                "SELECT knowledge_points, type FROM question_bank WHERE id = ? AND status = 'active'",
                (int(qid_str),),
            )
            kp = (q_info[0][0] or "") if q_info else ""
            qtype = (q_info[0][1] or "") if q_info else ""
            db_insert(
                """INSERT INTO wrong_book (student_username, question_id, source, source_id,
                   knowledge_points, question_type, status, wrong_answer, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (student_username, int(qid_str), 'exam', exam_id, kp, qtype,
                 'pending', ans.get("student_answer", ""), now),
            )


def mark_wrong_mastered(student_username: str, correct_answers: dict):
    """练习/考试答对后，标记 wrong_book 中的对应题目为已掌握"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    from backend.question_db import execute_query as q_exec
    for qid_str, ans in correct_answers.items():
        if isinstance(ans, dict) and ans.get("is_correct", False):
            qid = int(qid_str)
            # 精确匹配 question_id
            db_insert(
                "UPDATE wrong_book SET status='mastered', mastered_at=? WHERE student_username=? AND question_id=? AND status='pending'",
                (now, student_username, qid),
            )
            # 也按知识点匹配—同知识点其他错题也标记掌握
            q_info = q_exec(
                "SELECT knowledge_points FROM question_bank WHERE id = ? AND status = 'active'",
                (qid,),
            )
            if q_info and q_info[0][0]:
                kp = q_info[0][0]
                db_insert(
                    "UPDATE wrong_book SET status='mastered', mastered_at=? WHERE student_username=? AND knowledge_points=? AND status='pending'",
                    (now, student_username, kp),
                )


@router.get("/wrong-book/list", summary="从错题本获取待掌握错题")
async def get_wrong_book_list(request: Request):
    """从 wrong_book 表获取当前学生的待掌握错题"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 2:
        target_username = username
    else:
        target = request.query_params.get("student_username", "")
        target_username = target or username

    rows = db_exec(
        """SELECT wb.id, wb.question_id, wb.source, wb.source_id,
                  wb.knowledge_points, wb.question_type, wb.wrong_answer,
                  wb.created_at, qb.question_text, qb.correct_answer,
                  qb.options, qb.svg_content, qb.has_svg, qb.media_files
           FROM wrong_book wb
           LEFT JOIN question_bank qb ON qb.id = wb.question_id
           WHERE wb.student_username = ? AND wb.status = 'pending'
           ORDER BY wb.created_at DESC""",
        (target_username,),
    )

    wrong_list = []
    for r in rows:
        options = {}
        if r.get("options"):
            try:
                opts = json.loads(r["options"]) if isinstance(r["options"], str) else r["options"]
                if isinstance(opts, dict):
                    options = opts
            except (json.JSONDecodeError, TypeError):
                pass
        wrong_list.append({
            "id": r["id"],
            "question_id": r["question_id"],
            "question_text": r["question_text"] or f"(题目ID:{r['question_id']})",
            "question_type": r["question_type"],
            "options": options,
            "correct_answer": r["correct_answer"] or "",
            "wrong_answer": r["wrong_answer"],
            "knowledge_points": r["knowledge_points"],
            "source": r["source"],
            "source_id": r["source_id"],
            "created_at": r["created_at"],
            "svg_content": r.get("svg_content", ""),
            "has_svg": r.get("has_svg", 0),
            "media_files": r.get("media_files", ""),
        })

    return {"total_wrong": len(wrong_list), "wrong_questions": wrong_list, "student_username": target_username}


class PracticeGenerateRequest(BaseModel):
    count: int = 5
    subjects: list[str] = ["信息科技"]

@router.post("/practice/generate", summary="错题练习—生成题目")
async def generate_wrong_practice(req: PracticeGenerateRequest, request: Request):
    """根据错题知识点生成练习题（先搜题库，不够再AI生成）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可生成错题练习")

    if req.count < 1 or req.count > 20:
        req.count = 5

    # 获取该学生的待掌握错题知识点
    wrong_rows = db_exec(
        """SELECT DISTINCT knowledge_points FROM wrong_book
           WHERE student_username = ? AND status = 'pending' AND knowledge_points != ''""",
        (username,),
    )
    kp_list = [r["knowledge_points"] for r in wrong_rows]
    if not kp_list:
        # 回退到旧的 exam_attempts 方式
        return await generate_wrong_practice_fallback(req, request, username)

    questions = []
    needed = req.count

    # 1. 从 question_bank 中搜索同知识点的已有题目
    from backend.question_db import execute_query as q_exec
    for kp in kp_list:
        if needed <= 0:
            break
        existing = q_exec(
            """SELECT id, type, question_text, options, correct_answer, explanation,
                      knowledge_points, difficulty, svg_content, has_svg, media_files
               FROM question_bank
               WHERE knowledge_points LIKE ? AND status = 'active'
               ORDER BY RANDOM() LIMIT ?""",
            (f"%{kp}%", needed),
        )
        for eq in existing:
            qid = eq["id"]
            # 排除已在 wrong_book 中 pending 的
            dup = db_exec(
                "SELECT id FROM wrong_book WHERE student_username=? AND question_id=? AND status='pending'",
                (username, qid),
            )
            if dup:
                continue
            questions.append(eq)
            needed -= 1

    # 2. 不够则 AI 生成
    if needed > 0:
        try:
            api_key, _ = get_api_keys(username)
            if api_key:
                kp_text = "、".join(kp_list[:5])
                subject = req.subjects[0] if req.subjects else "信息科技"
                from backend.prompts.practice import PRACTICE_GENERATE_PROMPT
                prompt = PRACTICE_GENERATE_PROMPT.format(
                    subject=subject,
                    knowledge_points=kp_text,
                    question_type="mixed",
                    count=needed,
                    difficulty_desc="medium",
                )
                result_text = await call_ai_async(prompt, api_key)
                from backend.api.practice_router import _parse_ai_result
                ai_questions = _parse_ai_result(result_text)
                now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                for q in ai_questions[:needed]:
                    opts = json.dumps(q.get("options", {}), ensure_ascii=False) if q.get("options") else ""
                    svg_code = q.get("svg_code") or ""
                    has_svg = 1 if svg_code.strip() else 0
                    qid = q_exec(
                        """INSERT INTO question_bank (type,question_text,options,correct_answer,explanation,
                            knowledge_points,subject,difficulty,creator_username,source,status,created_at,updated_at,
                            svg_content,has_svg)
                           VALUES (?,?,?,?,?,?,?,?,?,'ai_wrong_practice','active',?,?,?,?)""",
                        (q.get("type", "single"), q.get("question", ""), opts,
                         q.get("answer", ""), q.get("explanation", ""),
                         kp_text, subject, "medium", username, now, now, svg_code, has_svg),
                    )
                    q["id"] = qid
                    q["question_id"] = qid
                    questions.append(q)
        except Exception as e:
            logger.warning(f"AI 错题练习出题失败: {e}")

    return {"questions": questions[:req.count], "total": len(questions)}


async def generate_wrong_practice_fallback(req: PracticeGenerateRequest, request: Request, username: str):
    """回退方案：从 exam_attempts 获取错题知识点"""
    from backend.question_db import execute_query as q_exec
    attempts = q_exec(
        """SELECT ea.answers, e.title
           FROM exam_attempts ea JOIN exams e ON e.id = ea.exam_id
           WHERE ea.student_username = ? AND ea.status = 'submitted'
           ORDER BY ea.submitted_at DESC LIMIT 10""",
        (username,),
    )
    kp_set = set()
    for a in attempts:
        ans_data = a.get("answers")
        if isinstance(ans_data, str):
            try:
                ans_data = json.loads(ans_data)
            except (json.JSONDecodeError, TypeError):
                continue
        if not ans_data:
            continue
        for qid_str, ans in ans_data.items():
            if isinstance(ans, dict) and not ans.get("is_correct", False):
                q_info = q_exec(
                    "SELECT knowledge_points FROM question_bank WHERE id = ? AND status = 'active'",
                    (int(qid_str),),
                )
                if q_info and q_info[0][0]:
                    kp_set.add(q_info[0][0])

    questions = []
    kp_list = list(kp_set)
    needed = req.count
    for kp in kp_list:
        if needed <= 0:
            break
        existing = q_exec(
            """SELECT id, type, question_text, options, correct_answer, explanation,
                      knowledge_points, difficulty, svg_content, has_svg, media_files
               FROM question_bank WHERE knowledge_points LIKE ? AND status = 'active'
               ORDER BY RANDOM() LIMIT ?""",
            (f"%{kp}%", needed),
        )
        for eq in existing:
            questions.append(eq)
            needed -= 1

    if needed > 0:
        api_key, _ = get_api_keys(username)
        if api_key:
            kp_text = "、".join(kp_list[:5]) if kp_list else "信息科技"
            subject = req.subjects[0] if req.subjects else "信息科技"
            from backend.prompts.practice import PRACTICE_GENERATE_PROMPT
            prompt = PRACTICE_GENERATE_PROMPT.format(subject=subject, knowledge_points=kp_text,
                question_type="mixed", count=needed, difficulty_desc="medium")
            result_text = await call_ai_async(prompt, api_key)
            from backend.api.practice_router import _parse_ai_result
            ai_qs = _parse_ai_result(result_text)
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            for q in ai_qs[:needed]:
                opts = json.dumps(q.get("options", {}), ensure_ascii=False) if q.get("options") else ""
                svg_code = q.get("svg_code") or ""
                has_svg = 1 if svg_code.strip() else 0
                qid = q_exec(
                    """INSERT INTO question_bank (type,question_text,options,correct_answer,explanation,
                        knowledge_points,subject,difficulty,creator_username,source,status,created_at,updated_at,
                        svg_content,has_svg) VALUES (?,?,?,?,?,?,?,?,?,'ai_wrong_practice','active',?,?,?,?)""",
                    (q.get("type", "single"), q.get("question", ""), opts,
                     q.get("answer", ""), q.get("explanation", ""),
                     kp_text, subject, "medium", username, now, now, svg_code, has_svg),
                )
                q["id"] = qid
                q["question_id"] = qid
                questions.append(q)

    return {"questions": questions[:req.count], "total": len(questions)}


class PracticeSubmitRequest(BaseModel):
    answers: dict[str, str]

@router.post("/practice/submit", summary="错题练习—提交答案")
async def submit_wrong_practice(req: PracticeSubmitRequest, request: Request):
    """提交错题练习答案，答对则标记 wrong_book 为 mastered"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可提交")

    from backend.question_db import execute_query as q_exec
    total = 0
    earned = 0
    graded = {}
    correct_grade = {}

    for qid_str, student_ans in req.answers.items():
        q_info = q_exec(
            "SELECT type, correct_answer FROM question_bank WHERE id = ? AND status = 'active'",
            (int(qid_str),),
        )
        if not q_info:
            graded[qid_str] = {"is_correct": False, "score": 0, "max_score": 10}
            continue
        qtype = q_info[0][0] if isinstance(q_info[0], (list, tuple)) else q_info[0].get("type", "")
        correct = q_info[0][1] if isinstance(q_info[0], (list, tuple)) else q_info[0].get("correct_answer", "")
        q_score = 10
        is_correct = student_ans.strip().upper() == (correct or "").strip().upper()
        s = q_score if is_correct else 0
        earned += s
        total += q_score
        graded[qid_str] = {
            "student_answer": student_ans, "correct_answer": correct,
            "score": s, "max_score": q_score, "is_correct": is_correct,
        }
        if is_correct:
            correct_grade[qid_str] = graded[qid_str]

    # 标记掌握的题目
    if correct_grade:
        mark_wrong_mastered(username, correct_grade)

    return {
        "score": earned, "total_score": total,
        "percentage": round(earned / total * 100, 1) if total else 0,
        "graded": graded,
    }
