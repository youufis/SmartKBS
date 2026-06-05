"""
考试发布 API 路由
创建/发布/答题/批改/查分
"""
import asyncio
import json
import re
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.question_db import (
    execute_query,
    execute_query_one,
    execute_insert,
    execute_update,
)
from backend.api.dependencies import get_current_user
from backend.auth import is_admin
from backend.database import execute_query as user_query
from backend.logger import logger

router = APIRouter()


# ── 请求/响应模型 ──

class ExamCreate(BaseModel):
    """创建考试请求"""
    title: str
    description: str = ""
    subject: str = ""  # 默认值由前端传递
    duration: int = 45
    total_score: float = 100
    pass_score: float = 60
    shuffle_questions: bool = True
    shuffle_options: bool = True
    show_result_immediately: bool = False
    max_attempts: int = 1
    start_time: str | None = None
    end_time: str | None = None


class ExamUpdate(BaseModel):
    """更新考试请求"""
    title: str | None = None
    description: str | None = None
    subject: str | None = None
    duration: int | None = None
    total_score: float | None = None
    pass_score: float | None = None
    shuffle_questions: bool | None = None
    shuffle_options: bool | None = None
    show_result_immediately: bool | None = None
    max_attempts: int | None = None
    start_time: str | None = None
    end_time: str | None = None


class ExamQuestionAdd(BaseModel):
    """添加试题到考试请求"""
    question_ids: list[int]
    scores: list[float] | None = None  # 每道题的分值，不传则使用默认值


class ExamSubmit(BaseModel):
    """学生提交答案请求"""
    answers: dict  # {question_id: answer}


class AutoSelectRequest(BaseModel):
    """智能选题请求"""
    subject: str | None = None
    question_types: list[str] | None = None
    difficulty: str | None = None
    knowledge_keyword: str | None = None
    count: int = 10
    exclude_existing: bool = True


# ── 辅助函数 ──

def _can_manage_exam(username: str, exam: dict | None = None) -> bool:
    """检查是否有管理考试的权限"""
    if is_admin(username):
        return True
    if exam and exam.get("creator_username") == username:
        return True
    return False


def _get_teacher_name(username: str) -> str:
    """获取用户姓名"""
    rows = user_query("SELECT name FROM users WHERE username=?", (username,))
    return rows[0][0] if rows and rows[0][0] else username


def _parse_teacher_grade_class(grade: str, class_str: str) -> dict[str, list[str]]:
    """解析教师的年级和班级字段，返回 {年级: [班级列表]} 的映射

    格式说明:
    - grade: "高一|高二" 表示教两个年级
    - class: "1,2,3,4|1,2,7,8" 表示高一教1,2,3,4班，高二教1,2,7,8班
    - 如果只有单个年级/班级列表，不加 | 分隔
    """
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


# ── 考试 CRUD ──

@router.post("")
async def create_exam(req: ExamCreate, request: Request):
    """创建考试（教师/管理员）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")

    if not req.title.strip():
        raise HTTPException(status_code=400, detail="请输入考试标题")

    creator_name = _get_teacher_name(username)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    exam_id = execute_insert(
        """INSERT INTO exams
           (title, description, subject, duration, total_score, pass_score,
            shuffle_questions, shuffle_options, show_result_immediately,
            max_attempts, start_time, end_time, status,
            creator_username, creator_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)""",
        (
            req.title, req.description, req.subject, req.duration,
            req.total_score, req.pass_score,
            1 if req.shuffle_questions else 0,
            1 if req.shuffle_options else 0,
            1 if req.show_result_immediately else 0,
            req.max_attempts, req.start_time, req.end_time,
            username, creator_name, now, now,
        ),
    )

    logger.info(f"用户 {username} 创建考试: {req.title} (id={exam_id})")
    return {
        "message": f"考试「{req.title}」创建成功",
        "exam_id": exam_id,
    }


@router.get("")
async def list_exams(
    request: Request,
    status: str = Query(None, description="筛选状态"),
    subject: str = Query(None, description="筛选科目"),
    keyword: str = Query(None, description="搜索标题"),
    scope: str = Query("all", description="all/my"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """查询考试列表"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    conditions = []
    params = []

    # 权限控制
    if role == 2:  # 学生：只能看到已发布或已结束且是本班教师或管理员创建的考试
        conditions.append("e.status IN ('published', 'ended')")
    elif role == 1:  # 教师：只能看到自己创建的考试
        conditions.append("e.creator_username = ?")
        params.append(username)
    elif scope == "my":  # 管理员通过 scope=my 筛选自己的
        conditions.append("e.creator_username = ?")
        params.append(username)

    if status:
        conditions.append("e.status = ?")
        params.append(status)
    if subject:
        conditions.append("e.subject = ?")
        params.append(subject)
    if keyword:
        conditions.append("e.title LIKE ?")
        params.append(f"%{keyword}%")

    where = " AND ".join(conditions) if conditions else "1=1"

    # ── 学生特殊处理：按班级匹配教师 ──
    if role == 2:
        # 先获取学生自己的年级和班级信息
        student_rows = user_query(
            "SELECT grade, class FROM users WHERE username=?", (username,)
        )
        student_grade = (student_rows[0][0] or "").strip() if student_rows else ""
        student_class = str(student_rows[0][1] or "").strip() if student_rows else ""

        # 不分页获取所有已发布的考试（数据量不会很大）
        all_rows = execute_query(
            f"""SELECT e.*,
                (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) as question_count
                FROM exams e
                WHERE {where}
                ORDER BY e.created_at DESC""",
            tuple(params),
        )

        # 批量查询所有管理员用户名（一次 DB 查询代替 N 次 is_admin() 调用）
        admin_rows = user_query("SELECT username FROM users WHERE role=0")
        admin_set = set(row[0] for row in admin_rows) if admin_rows else {"root"}

        # 逐条判断学生是否有权限看到该考试
        filtered = []
        for exam in all_rows:
            creator = exam["creator_username"]
            # 管理员创建的考试对所有学生可见
            if creator in admin_set:
                filtered.append(exam)
                continue
            # 获取该考试创建者的年级班级信息
            teacher_rows = user_query(
                "SELECT grade, class FROM users WHERE username=?", (creator,)
            )
            if not teacher_rows:
                filtered.append(exam)  # 用户不存在则默认可见
                continue
            teacher_grade = (teacher_rows[0][0] or "").strip()
            teacher_class = str(teacher_rows[0][1] or "").strip()
            # 教师未设置年级班级信息 → 对所有学生可见（兼容旧数据）
            if not teacher_grade and not teacher_class:
                filtered.append(exam)
                continue
            # 检查学生是否匹配教师的任课班级
            grade_class_map = _parse_teacher_grade_class(teacher_grade, teacher_class)
            matched = False
            if student_grade and student_grade in grade_class_map:
                allowed_classes = grade_class_map[student_grade]
                if not allowed_classes:
                    matched = True  # 有年级但没有具体班级限制 → 该年级所有学生可见
                elif student_class in allowed_classes:
                    matched = True
            if matched:
                filtered.append(exam)

        # 重新分页
        total = len(filtered)
        offset = (page - 1) * page_size
        rows = filtered[offset:offset + page_size]

        # 补充答题状态
        for row in rows:
            attempt = execute_query_one(
                """SELECT id, exam_id, status, score, total_score
                   FROM exam_attempts
                   WHERE exam_id = ? AND student_username = ?
                   ORDER BY id DESC LIMIT 1""",
                (row["id"], username),
            )
            row["my_attempt"] = attempt
    else:
        # 非学生：常规分页查询
        count_row = execute_query_one(
            f"SELECT COUNT(*) as total FROM exams e WHERE {where}", tuple(params)
        )
        total = count_row["total"] if count_row else 0

        offset = (page - 1) * page_size
        rows = execute_query(
            f"""SELECT e.*,
                (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) as question_count
                FROM exams e
                WHERE {where}
                ORDER BY e.created_at DESC
                LIMIT ? OFFSET ?""",
            tuple(params) + (page_size, offset),
        )

    # 补充 creator_name
    for row in rows:
        creator = row.get("creator_username", "")
        if creator and not row.get("creator_name"):
            name_rows = user_query(
                "SELECT COALESCE(NULLIF(name, ''), username) FROM users WHERE username = ?",
                (creator,),
            )
            row["creator_name"] = name_rows[0][0] if name_rows and name_rows[0] else creator

    return {
        "exams": rows,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/{exam_id}")
async def get_exam(exam_id: int, request: Request):
    """获取考试详情（含题目列表）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    # 权限控制
    if role == 2 and exam["status"] != "published":
        raise HTTPException(status_code=403, detail="考试未发布")
    if role == 1 and exam["creator_username"] != username:
        raise HTTPException(status_code=403, detail="无权查看其他教师的考试")

    # 获取题目列表
    questions = execute_query(
        """SELECT eq.id as eq_id, eq.sort_order, eq.score as question_score,
                  q.id, q.type, q.question_text, q.options, q.correct_answer,
                  q.explanation, q.difficulty, q.knowledge_points
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'
           ORDER BY eq.sort_order, eq.id""",
        (exam_id,),
    )

    # 解析选项 JSON
    for q in questions:
        if q.get("options"):
            try:
                q["options"] = json.loads(q["options"])
            except (json.JSONDecodeError, TypeError):
                q["options"] = None
        else:
            q["options"] = None
        # 学生不返回正确答案
        if role == 2:
            q.pop("correct_answer", None)

    exam["questions"] = questions

    # 获取我的答题记录（学生）
    if role == 2:
        attempt = execute_query_one(
            """SELECT * FROM exam_attempts
               WHERE exam_id = ? AND student_username = ?
               ORDER BY id DESC LIMIT 1""",
            (exam_id, username),
        )
        exam["my_attempt"] = attempt

    return exam


@router.put("/{exam_id}")
async def update_exam(exam_id: int, req: ExamUpdate, request: Request):
    """更新考试信息"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权修改此考试")

    updates = []
    params = []
    for field in ["title", "description", "subject", "duration",
                   "total_score", "pass_score", "start_time", "end_time",
                   "max_attempts"]:
        val = getattr(req, field, None)
        if val is not None:
            updates.append(f"{field} = ?")
            params.append(val)

    for field in ["shuffle_questions", "shuffle_options", "show_result_immediately"]:
        val = getattr(req, field, None)
        if val is not None:
            updates.append(f"{field} = ?")
            params.append(1 if val else 0)

    if not updates:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")

    updates.append("updated_at = ?")
    params.append(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    params.append(exam_id)

    execute_update(
        f"UPDATE exams SET {', '.join(updates)} WHERE id = ?",
        tuple(params),
    )

    # ── 如果考试已发布且有重要字段变更，异步通知学生（不阻塞更新操作） ──
    if exam["status"] == "published":
        key_notify_fields = {"title", "duration", "total_score", "pass_score", "start_time", "end_time"}
        changed = [f for f in key_notify_fields if getattr(req, f, None) is not None]
        if changed:
            async def _notify_update():
                try:
                    from backend.api.notification_router import _notify_users
                    all_students = user_query("SELECT username FROM users WHERE role = 2")
                    student_usernames = [r[0] for r in all_students]
                    _notify_users(
                        student_usernames, "exam",
                        f"考试「{exam['title']}」信息已更新",
                        f"涉及字段：{'、'.join(changed)}，请重新查看考试详情",
                        "/exam",
                    )
                except Exception as notify_err:
                    logger.warning(f"发送考试更新通知失败: {notify_err}")
            asyncio.create_task(_notify_update())

    return {"message": "更新成功"}


@router.delete("/{exam_id}")
async def delete_exam(exam_id: int, request: Request):
    """删除考试"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权删除此考试")

    # ── 异步发送考试取消通知（在删除前查出受影响的学生，不阻塞删除操作） ──
    if exam["status"] == "published":
        async def _notify_delete():
            try:
                from backend.api.notification_router import _notify_users
                affected = execute_query(
                    """SELECT DISTINCT student_username FROM exam_attempts
                       WHERE exam_id = ?""",
                    (exam_id,),
                )
                if affected:
                    _notify_users(
                        [r["student_username"] for r in affected], "exam",
                        f"考试「{exam['title']}」已取消",
                        f"教师已删除该考试",
                        "/exam",
                    )
            except Exception as notify_err:
                logger.warning(f"发送考试取消通知失败: {notify_err}")
        asyncio.create_task(_notify_delete())

    # 删除关联数据
    execute_update("DELETE FROM exam_questions WHERE exam_id = ?", (exam_id,))
    execute_update("DELETE FROM exam_attempts WHERE exam_id = ?", (exam_id,))
    execute_update("DELETE FROM exams WHERE id = ?", (exam_id,))

    logger.info(f"用户 {username} 删除考试: {exam['title']} (id={exam_id})")
    return {"message": "已删除"}


# ── 考试发布/结束 ──

@router.put("/{exam_id}/publish")
async def publish_exam(exam_id: int, request: Request):
    """发布考试"""
    user = get_current_user(request)
    username = user["username"]

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权发布此考试")

    # 检查是否有题目
    q_count = execute_query_one(
        "SELECT COUNT(*) as cnt FROM exam_questions WHERE exam_id = ?",
        (exam_id,),
    )
    if not q_count or q_count["cnt"] == 0:
        raise HTTPException(status_code=400, detail="考试中没有任何试题，请先添加试题")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE exams SET status = 'published', updated_at = ? WHERE id = ?",
        (now, exam_id),
    )

    logger.info(f"用户 {username} 发布考试: {exam['title']} (id={exam_id})")

    # ── 异步发送通知给所有学生（不阻塞发布操作） ──
    async def _notify_publish():
        try:
            from backend.api.notification_router import _notify_users
            from backend.database import execute_query as db_query
            all_students = db_query("SELECT username FROM users WHERE role = 2")
            student_usernames = [r[0] for r in all_students]
            _notify_users(
                student_usernames, "exam",
                f"新考试「{exam['title']}」已发布",
                f"时长 {exam['duration']} 分钟，满分 {exam['total_score']} 分",
                "/exam",
            )
        except Exception as notify_err:
            logger.warning(f"发送考试通知失败: {notify_err}")
    asyncio.create_task(_notify_publish())

    return {"message": "考试已发布"}


@router.put("/{exam_id}/end")
async def end_exam(exam_id: int, request: Request):
    """结束考试"""
    user = get_current_user(request)
    username = user["username"]

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权结束此考试")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE exams SET status = 'ended', updated_at = ? WHERE id = ?",
        (now, exam_id),
    )

    # ── 异步通知正在答题的学生（不阻塞结束操作） ──
    async def _notify_end():
        try:
            from backend.api.notification_router import _notify_users
            in_progress = execute_query(
                """SELECT student_username FROM exam_attempts
                   WHERE exam_id = ? AND status = 'in_progress'""",
                (exam_id,),
            )
            if in_progress:
                _notify_users(
                    [r["student_username"] for r in in_progress], "exam",
                    f"考试「{exam['title']}」已提前结束",
                    f"教师已结束考试，请查看成绩",
                    "/exam",
                )
        except Exception as notify_err:
            logger.warning(f"发送考试结束通知失败: {notify_err}")
    asyncio.create_task(_notify_end())

    return {"message": "考试已结束"}


# ── 考试题目管理 ──

@router.post("/{exam_id}/questions")
async def add_questions_to_exam(exam_id: int, req: ExamQuestionAdd, request: Request):
    """向考试添加试题"""
    user = get_current_user(request)
    username = user["username"]

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权操作此考试")

    if not req.question_ids:
        raise HTTPException(status_code=400, detail="请选择要添加的试题")

    # 获取当前最大排序序号
    max_order = execute_query_one(
        "SELECT COALESCE(MAX(sort_order), -1) as max_order FROM exam_questions WHERE exam_id = ?",
        (exam_id,),
    )
    next_order = (max_order["max_order"] + 1) if max_order else 0

    added = 0
    skipped_existing = 0  # 因重复跳过
    skipped_invalid = 0   # 因题目不存在跳过
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for i, qid in enumerate(req.question_ids):
        # 检查题目是否存在且未删除
        q = execute_query_one(
            "SELECT id FROM question_bank WHERE id = ? AND status = 'active'",
            (qid,),
        )
        if not q:
            skipped_invalid += 1
            continue

        # 检查是否已添加
        existing = execute_query_one(
            "SELECT id FROM exam_questions WHERE exam_id = ? AND question_id = ?",
            (exam_id, qid),
        )
        if existing:
            skipped_existing += 1
            continue

        score = (req.scores[i] if req.scores and i < len(req.scores)
                 else round(exam["total_score"] / max(len(req.question_ids), 1), 1))
        score = round(max(score, 1), 1)

        execute_insert(
            """INSERT INTO exam_questions (exam_id, question_id, sort_order, score)
               VALUES (?, ?, ?, ?)""",
            (exam_id, qid, next_order + i, score),
        )
        added += 1

    # 更新考试时间
    execute_update(
        "UPDATE exams SET updated_at = ? WHERE id = ?",
        (now, exam_id),
    )

    parts = [f"成功添加 {added} 道试题"]
    if skipped_existing:
        parts.append(f"{skipped_existing} 道重复已跳过")
    if skipped_invalid:
        parts.append(f"{skipped_invalid} 道不存在")
    message = "，".join(parts)

    return {
        "message": message,
        "added": added,
        "skipped_existing": skipped_existing,
        "skipped_invalid": skipped_invalid,
    }


@router.delete("/{exam_id}/questions")
async def remove_questions_from_exam(
    exam_id: int,
    request: Request,
    question_ids: str = Query(..., description="逗号分隔的题目ID列表"),
):
    """从考试中移除试题"""
    user = get_current_user(request)
    username = user["username"]

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权操作此考试")

    ids = [int(x.strip()) for x in question_ids.split(",") if x.strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="请指定要移除的试题")

    placeholders = ",".join("?" * len(ids))
    params = [exam_id] + ids
    execute_update(
        f"DELETE FROM exam_questions WHERE exam_id = ? AND question_id IN ({placeholders})",
        tuple(params),
    )

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update("UPDATE exams SET updated_at = ? WHERE id = ?", (now, exam_id))

    return {"message": f"已移除 {len(ids)} 道试题"}


class BatchScoresUpdate(BaseModel):
    """批量更新题目分值请求"""
    scores: dict[str, float]  # {exam_question_id: score}


@router.put("/{exam_id}/questions/batch-scores")
async def batch_update_scores(exam_id: int, req: BatchScoresUpdate, request: Request):
    """批量更新试题分值，并校验总分与考试设定总分一致"""
    user = get_current_user(request)
    username = user["username"]

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权操作此考试")

    if not req.scores:
        raise HTTPException(status_code=400, detail="请提供分值数据")

    # 获取当前所有题目
    existing = execute_query(
        "SELECT id, question_id, score FROM exam_questions WHERE exam_id = ?",
        (exam_id,),
    )
    existing_ids = {str(row["id"]) for row in existing}

    # 校验提交的 ID 是否合法
    for eq_id in req.scores:
        if eq_id not in existing_ids:
            raise HTTPException(status_code=400, detail=f"题目 ID {eq_id} 不属于本考试")

    # 更新分值
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for eq_id_str, score in req.scores.items():
        score = round(max(float(score), 0), 1)
        execute_update(
            "UPDATE exam_questions SET score = ? WHERE id = ? AND exam_id = ?",
            (score, int(eq_id_str), exam_id),
        )

    # 可选：校验总分（仅警告，不强制阻断，因为可能有故意留白）
    total = round(sum(float(v) for v in req.scores.values()), 1)
    expected = exam["total_score"]
    execute_update("UPDATE exams SET updated_at = ? WHERE id = ?", (now, exam_id))

    msg = f"已更新 {len(req.scores)} 道试题分值"
    if abs(total - expected) > 0.1:
        msg += f"，但当前总分 {total} ≠ 目标总分 {expected}"

    logger.info(f"用户 {username} 批量更新考试{exam_id}分值: {req.scores}")
    return {
        "message": msg,
        "current_total": total,
        "expected_total": expected,
        "balanced": abs(total - expected) <= 0.1,
    }


@router.post("/{exam_id}/questions/auto-balance")
async def auto_balance_scores(exam_id: int, request: Request):
    """自动将考试总分均衡分配给所有题目"""
    user = get_current_user(request)
    username = user["username"]

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权操作此考试")

    questions = execute_query(
        "SELECT id FROM exam_questions WHERE exam_id = ? ORDER BY sort_order, id",
        (exam_id,),
    )
    if not questions:
        raise HTTPException(status_code=400, detail="考试中没有任何试题")

    total_score = exam["total_score"]
    count = len(questions)
    base = round(total_score / count, 1)
    remainder = round(total_score - base * count, 1)

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for i, q in enumerate(questions):
        score = base + (remainder if i == 0 else 0)
        execute_update(
            "UPDATE exam_questions SET score = ? WHERE id = ?",
            (score, q["id"]),
        )

    execute_update("UPDATE exams SET updated_at = ? WHERE id = ?", (now, exam_id))

    return {
        "message": f"已均衡分配 {count} 道试题，每题 {base} 分",
        "count": count,
        "score_per_question": base,
    }


@router.post("/{exam_id}/auto-select-questions")
async def auto_select_questions(exam_id: int, req: AutoSelectRequest, request: Request):
    """智能选题：根据条件自动从题库选取试题添加到考试"""
    user = get_current_user(request)
    username = user["username"]

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权操作此考试")

    # 构建查询条件
    conditions = ["q.status = 'active'"]
    params = []

    if req.subject:
        conditions.append("q.subject = ?")
        params.append(req.subject)

    if req.difficulty:
        conditions.append("q.difficulty = ?")
        params.append(req.difficulty)

    if req.question_types:
        placeholders = ",".join("?" * len(req.question_types))
        conditions.append(f"q.type IN ({placeholders})")
        params.extend(req.question_types)

    if req.knowledge_keyword:
        kw = f"%{req.knowledge_keyword}%"
        conditions.append("(q.knowledge_points LIKE ? OR q.question_text LIKE ?)")
        params.extend([kw, kw])

    # 排除已添加的题目
    if req.exclude_existing:
        conditions.append("q.id NOT IN (SELECT question_id FROM exam_questions WHERE exam_id = ?)")
        params.append(exam_id)

    where = " AND ".join(conditions)

    # 获取符合条件的题目列表
    rows = execute_query(
        f"SELECT q.id, q.type, q.question_text, q.difficulty, q.knowledge_points FROM question_bank q WHERE {where}",
        tuple(params),
    )

    if not rows:
        raise HTTPException(status_code=404, detail="未找到符合条件的题目")

    # 随机选取
    import random
    selected = random.sample(rows, min(req.count, len(rows)))

    # 获取当前最大排序序号
    max_order_row = execute_query_one(
        "SELECT COALESCE(MAX(sort_order), -1) as max_order FROM exam_questions WHERE exam_id = ?",
        (exam_id,),
    )
    next_order = (max_order_row["max_order"] + 1) if max_order_row else 0

    # 等分总分
    score_per_question = round(exam["total_score"] / len(selected), 1)
    score_per_question = max(score_per_question, 1)

    added = 0
    added_questions = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for i, q in enumerate(selected):
        qid = q["id"]
        # 二次检查是否已添加（避免并发）
        existing = execute_query_one(
            "SELECT id FROM exam_questions WHERE exam_id = ? AND question_id = ?",
            (exam_id, qid),
        )
        if existing:
            continue

        execute_insert(
            """INSERT INTO exam_questions (exam_id, question_id, sort_order, score)
               VALUES (?, ?, ?, ?)""",
            (exam_id, qid, next_order + i, score_per_question),
        )
        added += 1
        added_questions.append({
            "id": qid,
            "type": q["type"],
            "question_text": q["question_text"],
            "difficulty": q["difficulty"],
            "knowledge_points": q["knowledge_points"],
        })

    # 更新考试时间
    execute_update("UPDATE exams SET updated_at = ? WHERE id = ?", (now, exam_id))

    logger.info(f"用户 {username} 智能选题: 考试{exam_id} 条件={req.dict()} 选取={added}题")

    return {
        "message": f"智能选题完成，共添加 {added} 道试题",
        "added": added,
        "questions": added_questions,
    }


# ── 学生答题 ──

@router.post("/{exam_id}/start")
async def start_exam(exam_id: int, request: Request):
    """学生开始考试（创建答题记录）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可以参加考试")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if exam["status"] != "published":
        raise HTTPException(status_code=400, detail="考试未发布或已结束")

    # 检查考试时间范围
    now = datetime.now()
    if exam.get("start_time"):
        try:
            start_time = datetime.strptime(exam["start_time"], "%Y-%m-%d %H:%M:%S")
            if now < start_time:
                raise HTTPException(status_code=400, detail="考试尚未开始")
        except ValueError:
            pass
    if exam.get("end_time"):
        try:
            end_time = datetime.strptime(exam["end_time"], "%Y-%m-%d %H:%M:%S")
            if now > end_time:
                raise HTTPException(status_code=400, detail="考试已结束")
        except ValueError:
            pass

    # 检查答题次数
    attempts = execute_query(
        """SELECT * FROM exam_attempts
           WHERE exam_id = ? AND student_username = ? AND status = 'submitted'""",
        (exam_id, username),
    )
    if len(attempts) >= exam["max_attempts"]:
        raise HTTPException(status_code=400,
                            detail=f"已达到最大答题次数 ({exam['max_attempts']}次)")

    # 检查是否有进行中的答题
    in_progress = execute_query_one(
        """SELECT * FROM exam_attempts
           WHERE exam_id = ? AND student_username = ? AND status = 'in_progress'""",
        (exam_id, username),
    )
    if in_progress:
        return {
            "message": "检测到进行中的答题，继续作答",
            "attempt_id": in_progress["id"],
            "existing": True,
        }

    # 获取学生姓名
    name_rows = user_query("SELECT name FROM users WHERE username=?", (username,))
    student_name = name_rows[0][0] if name_rows and name_rows[0][0] else username

    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    attempt_id = execute_insert(
        """INSERT INTO exam_attempts
           (exam_id, student_username, student_name, started_at, status, total_score)
           VALUES (?, ?, ?, ?, 'in_progress', ?)""",
        (exam_id, username, student_name, now_str, exam["total_score"]),
    )

    return {
        "message": "考试开始",
        "attempt_id": attempt_id,
        "existing": False,
    }


@router.post("/{exam_id}/submit")
async def submit_exam(exam_id: int, req: ExamSubmit, request: Request):
    """学生提交答案并自动批改"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可以提交答案")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    # 获取进行中的答题记录（先查 attempt_id）
    attempt = execute_query_one(
        """SELECT id FROM exam_attempts
           WHERE exam_id = ? AND student_username = ? AND status = 'in_progress'
           ORDER BY id DESC LIMIT 1""",
        (exam_id, username),
    )
    if not attempt:
        raise HTTPException(status_code=400, detail="没有进行中的答题记录")

    attempt_id = attempt["id"]

    # 获取所有题目信息（用于批改）
    questions = execute_query(
        """SELECT q.id, q.type, q.correct_answer, eq.score
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'""",
        (exam_id,),
    )

    # 自动批改
    total_score = exam["total_score"]
    earned_score = 0.0
    graded_answers = {}

    # 分离简答题和其他题
    short_qs = [q for q in questions if q["type"] == "short"]
    other_qs = [q for q in questions if q["type"] != "short"]

    # 非简答题：精确匹配
    for q in other_qs:
        qid = str(q["id"])
        student_answer = req.answers.get(qid, "")
        correct_answer = q["correct_answer"]
        q_score = q["score"] or (total_score / max(len(questions), 1))
        is_correct = _check_choice_answer(student_answer, correct_answer, q["type"])
        if is_correct:
            earned_score += q_score
        graded_answers[qid] = {
            "student_answer": student_answer,
            "correct_answer": correct_answer,
            "score": q_score if is_correct else 0,
            "max_score": q_score,
            "is_correct": is_correct,
        }

    # 简答题：AI 语义批改（并发）
    if short_qs:
        try:
            from backend.api.chat_router import get_api_keys
            from backend.api.ai_service import call_ai_async
            api_key, _ = get_api_keys(username)
        except Exception:
            api_key = ""

        if api_key and api_key.strip():
            sem = asyncio.Semaphore(3)

            async def _grade_short(q):
                qid = str(q["id"])
                student_answer = req.answers.get(qid, "")
                correct_answer = q["correct_answer"]
                q_score = q["score"] or (total_score / max(len(questions), 1))
                async with sem:
                    try:
                        from backend.prompts.teaching import SHORT_ANSWER_GRADING_PROMPT
                        prompt = SHORT_ANSWER_GRADING_PROMPT.format(
                            question_text=str(q.get("question_text", "")).replace('{', '{{').replace('}', '}}') if q.get("question_text") else "",
                            correct_answer=str(correct_answer).replace('{', '{{').replace('}', '}}'),
                            max_score=str(q_score),
                            half_score=str(q_score * 0.5),
                            near_full=str(q_score * 0.8),
                            half_minus=str(q_score * 0.4),
                            student_answer=str(student_answer).replace('{', '{{').replace('}', '}}'),
                        )
                        ai_resp = await call_ai_async(prompt, api_key)
                        jm = re.search(r'\{[^}]+\}', ai_resp)
                        if jm:
                            result = json.loads(jm.group())
                            ai_score = float(result.get("score", 0))
                            ai_score = max(0, min(ai_score, q_score))
                            return qid, {
                                "student_answer": student_answer,
                                "correct_answer": correct_answer,
                                "score": ai_score,
                                "max_score": q_score,
                                "is_correct": ai_score >= q_score * 0.6,
                            }
                    except Exception:
                        pass
                # AI 失败回退
                is_correct = _check_short_answer(student_answer, correct_answer)
                return qid, {
                    "student_answer": student_answer,
                    "correct_answer": correct_answer,
                    "score": q_score if is_correct else 0,
                    "max_score": q_score,
                    "is_correct": is_correct,
                }

            results = await asyncio.gather(*[_grade_short(q) for q in short_qs])
            for qid, result in results:
                graded_answers[qid] = result
                if result["is_correct"]:
                    earned_score += result["score"]
        else:
            # 无 API Key：关键词匹配
            for q in short_qs:
                qid = str(q["id"])
                student_answer = req.answers.get(qid, "")
                correct_answer = q["correct_answer"]
                q_score = q["score"] or (total_score / max(len(questions), 1))
                is_correct = _check_short_answer(student_answer, correct_answer)
                if is_correct:
                    earned_score += q_score
                graded_answers[qid] = {
                    "student_answer": student_answer,
                    "correct_answer": correct_answer,
                    "score": q_score if is_correct else 0,
                    "max_score": q_score,
                    "is_correct": is_correct,
                }

    earned_score = round(earned_score, 1)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 原子更新：带上 status='in_progress' 条件防止重复提交
    # 如果已提交过（status 已变更），rowcount 为 0，不会重复处理
    rows = execute_update(
        """UPDATE exam_attempts
           SET status = 'submitted', submitted_at = ?, score = ?, answers = ?, auto_graded = 1
           WHERE id = ? AND status = 'in_progress'""",
        (now, earned_score, json.dumps(graded_answers, ensure_ascii=False), attempt_id),
    )
    if rows == 0:
        logger.warning(f"学生 {username} 重复提交考试 {exam_id}，已忽略")
        raise HTTPException(status_code=400, detail="该考试已提交，请勿重复提交")

    logger.info(f"学生 {username} 提交考试 {exam_id}，得分 {earned_score}/{total_score}")

    # ── 发送考试结果通知（给学生） ──
    try:
        from backend.api.notification_router import _create_notification
        passed_str = "通过" if earned_score >= exam["pass_score"] else "未通过"
        _create_notification(
            username, "exam",
            f"考试「{exam['title']}」成绩已出",
            f"得分 {earned_score}/{total_score}（{passed_str}）",
            "/exam",
        )
    except Exception as notify_err:
        logger.warning(f"发送考试结果通知失败: {notify_err}")

    # ── 通知考试创建者（教师/管理员）有学生提交 ──
    try:
        from backend.api.notification_router import _create_notification
        teacher_username = exam["creator_username"]
        if teacher_username != username:
            name_rows = user_query("SELECT name FROM users WHERE username=?", (username,))
            student_display = name_rows[0][0] if name_rows and name_rows[0][0] else username
            _create_notification(
                teacher_username, "exam",
                f"学生提交答卷: {student_display}",
                f"已提交考试「{exam['title']}」，得分 {earned_score}/{total_score}",
                f"/exam/{exam_id}/results",
            )
    except Exception as notify_err:
        logger.warning(f"发送教师通知失败: {notify_err}")

    result = {
        "message": "提交成功",
        "attempt_id": attempt["id"],
        "score": earned_score,
        "total_score": total_score,
        "passed": earned_score >= exam["pass_score"],
        "details": graded_answers if exam["show_result_immediately"] else None,
    }

    if exam["show_result_immediately"]:
        result["details"] = graded_answers

    return result


def _check_choice_answer(student: str, correct: str, q_type: str) -> bool:
    """检查选择题/判断题答案"""
    if not student or not correct:
        return False
    if q_type == "multiple":
        # 多选题：答案顺序无关，比较集合
        student_set = set(s.strip().upper() for s in student.split(",") if s.strip())
        correct_set = set(c.strip().upper() for c in correct.split(",") if c.strip())
        return student_set == correct_set
    else:
        # 单选题和判断题：直接比较（忽略大小写和空白）
        return student.strip().upper() == correct.strip().upper()


def _check_short_answer(student: str, correct: str) -> bool:
    """简答题检查：包含关键词"""
    if not student or not correct:
        return False
    # 如果参考答案是逗号分隔的关键词，匹配任意一个即可
    keywords = [k.strip() for k in correct.replace("，", ",").split(",") if k.strip()]
    if not keywords:
        return False
    student_clean = student.strip().lower()
    # 如果学生回答和参考答案相似度较高（简单包含判断）
    for kw in keywords:
        if kw.lower() in student_clean:
            return True
    return False


# ── 学生查看自己的答题详情 ──

@router.get("/attempt/{attempt_id}/exam/{exam_id}")
async def get_my_attempt_detail(exam_id: int, attempt_id: int, request: Request):
    """获取学生自己的答题详情（学生可查看自己的，教师/管理员可查看任何）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    attempt = execute_query_one("SELECT * FROM exam_attempts WHERE id = ? AND exam_id = ?",
                                 (attempt_id, exam_id))
    if not attempt:
        raise HTTPException(status_code=404, detail="答题记录不存在")

    # 权限检查：学生只能看自己的，教师/管理员可看任何
    if role == 2 and attempt["student_username"] != username:
        raise HTTPException(status_code=403, detail="无权查看他人的答题详情")

    # 解析答案
    answers = attempt.get("answers")
    if isinstance(answers, str):
        try:
            answers = json.loads(answers)
        except (json.JSONDecodeError, TypeError):
            answers = {}

    # 获取题目信息
    questions = execute_query(
        """SELECT q.id, q.type, q.question_text, q.options, q.correct_answer,
                  q.explanation, q.knowledge_points, eq.score as question_score
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'
           ORDER BY eq.sort_order""",
        (exam_id,),
    )

    # 解析 options JSON
    for q in questions:
        if q.get("options"):
            try:
                q["options"] = json.loads(q["options"])
            except (json.JSONDecodeError, TypeError):
                q["options"] = None
        else:
            q["options"] = None

    return {
        "attempt": {
            "id": attempt["id"],
            "score": attempt["score"],
            "total_score": attempt["total_score"],
            "submitted_at": attempt["submitted_at"],
            "answers": answers,
        },
        "questions": questions,
    }


# ── 成绩与统计 ──

# 注意：/student/results 必须定义在 /{exam_id}/results 之前，避免路由冲突

@router.get("/student/results")
async def get_my_results(request: Request):
    """获取当前学生的考试成绩列表"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        # 教师和管理员可以看所有自己的考试结果
        pass

    if role == 2:
        rows = execute_query(
            """SELECT ea.*, e.title as exam_title, e.subject as exam_subject,
                      e.pass_score, e.creator_username
               FROM exam_attempts ea
               JOIN exams e ON e.id = ea.exam_id
               WHERE ea.student_username = ? AND ea.status = 'submitted'
               ORDER BY ea.submitted_at DESC""",
            (username,),
        )
    else:
        # 教师和管理员查看自己创建的考试的结果
        rows = execute_query(
            """SELECT ea.*, e.title as exam_title, e.subject as exam_subject,
                      e.pass_score, e.creator_username
               FROM exam_attempts ea
               JOIN exams e ON e.id = ea.exam_id
               WHERE (e.creator_username = ? OR ? = 'root') AND ea.status = 'submitted'
               ORDER BY ea.submitted_at DESC""",
            (username, username),
        )

    # 补充 creator_name（从 smartkb.db 查询）
    for r in rows:
        creator = r.get("creator_username", "")
        if creator:
            name_rows = user_query(
                "SELECT COALESCE(NULLIF(name, ''), username) FROM users WHERE username = ?",
                (creator,),
            )
            r["creator_name"] = name_rows[0][0] if name_rows and name_rows[0] else creator
        else:
            r["creator_name"] = ""

    return {"results": rows}


@router.get("/{exam_id}/results")
async def get_exam_results(exam_id: int, request: Request):
    """获取考试成绩统计（教师/管理员）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 2:
        raise HTTPException(status_code=403, detail="无权查看考试成绩统计")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权查看此考试的结果")

    # 获取所有提交记录（不包含 answers 详情，展开时再按学生加载）
    attempts = execute_query(
        """SELECT id, exam_id, student_username, student_name, score, total_score,
                  submitted_at, status, auto_graded
           FROM exam_attempts
           WHERE exam_id = ? AND status = 'submitted'
           ORDER BY score DESC""",
        (exam_id,),
    )

    # 统计数据
    total_students = len(attempts)
    avg_score = round(sum(a["score"] for a in attempts) / max(total_students, 1), 1)
    pass_count = sum(1 for a in attempts if a["score"] >= exam["pass_score"])
    max_score = max((a["score"] for a in attempts), default=0)
    min_score = min((a["score"] for a in attempts), default=0)

    return {
        "exam": exam,
        "attempts": attempts,
        "statistics": {
            "total_students": total_students,
            "avg_score": avg_score,
            "pass_count": pass_count,
            "pass_rate": round(pass_count / max(total_students, 1) * 100, 1),
            "max_score": max_score,
            "min_score": min_score,
        },
    }


@router.get("/{exam_id}/attempt/{attempt_id}/detail", summary="获取学生答题详情（教师展开时按需加载）")
async def get_student_attempt_detail(exam_id: int, attempt_id: int, request: Request):
    """教师/管理员展开学生成绩时，按需加载该学生的答题详情"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="无权查看")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    attempt = execute_query_one("SELECT * FROM exam_attempts WHERE id = ? AND exam_id = ?",
                                 (attempt_id, exam_id))
    if not attempt:
        raise HTTPException(status_code=404, detail="答题记录不存在")

    # 解析答案
    answers = attempt.get("answers")
    if isinstance(answers, str):
        try:
            answers = json.loads(answers)
        except (json.JSONDecodeError, TypeError):
            answers = {}

    # 获取题目信息（含选项和解析）
    questions = execute_query(
        """SELECT q.id, q.type, q.question_text, q.options, q.correct_answer,
                  q.explanation, q.knowledge_points, eq.score as question_score
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'
           ORDER BY eq.sort_order""",
        (exam_id,),
    )

    # 解析 options JSON
    for q in questions:
        if q.get("options"):
            try:
                q["options"] = json.loads(q["options"])
            except (json.JSONDecodeError, TypeError):
                q["options"] = None
        else:
            q["options"] = None

    return {
        "attempt": {
            "id": attempt["id"],
            "score": attempt["score"],
            "total_score": attempt["total_score"],
            "submitted_at": attempt["submitted_at"],
            "answers": answers,
        },
        "questions": questions,
    }


# ═══════════════════════════════════════════════════════════
# V3.1 新增：AI 知识点讲解 & AI 简答题评分
# ═══════════════════════════════════════════════════════════

@router.get("/{exam_id}/explain-wrong")
async def get_wrong_answer_explanation(exam_id: int, request: Request):
    """AI 讲解错题：根据学生的错误答案生成知识点讲解"""
    user = get_current_user(request)
    username = user["username"]

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    # 获取该学生的答题记录
    attempt = execute_query_one(
        """SELECT * FROM exam_attempts
           WHERE exam_id = ? AND student_username = ? AND status = 'submitted'
           ORDER BY submitted_at DESC LIMIT 1""",
        (exam_id, username),
    )
    if not attempt:
        raise HTTPException(status_code=404, detail="未找到答题记录")

    answers_data = attempt.get("answers")
    if isinstance(answers_data, str):
        answers_data = json.loads(answers_data)

    if not answers_data:
        raise HTTPException(status_code=404, detail="无答题数据")

    # 获取所有题目
    questions = execute_query(
        """SELECT q.id, q.type, q.question_text, q.correct_answer,
                  q.knowledge_points, q.options, q.explanation
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'""",
        (exam_id,),
    )

    from backend.ai_task_manager import task_manager

    async def _do_explain() -> dict:
        from backend.prompts.teaching import KNOWLEDGE_EXPLAIN_PROMPT
        from backend.api.chat_router import get_api_keys
        from backend.api.ai_service import call_ai_async
        import asyncio

        keys = get_api_keys(username)
        api_key = keys[0] if keys and keys[0] else ""
        if not api_key:
            return {
                "exam_title": exam["title"],
                "explanations": [{"error": "未配置 API Key"}],
                "total_wrong": 0,
            }

        async def _call_ai_for_question(q, ans):
            def _safe(s):
                return str(s).replace('{', '{{').replace('}', '}}')
            prompt = KNOWLEDGE_EXPLAIN_PROMPT.format(
                question_text=_safe(q["question_text"]),
                question_type=_safe(q["type"]),
                correct_answer=_safe(q["correct_answer"]),
                student_answer=_safe(ans.get("student_answer", "")),
                knowledge_points=_safe(q.get("knowledge_points", "")),
            )
            ai_response = await call_ai_async(prompt, api_key)
            return {
                "question_id": q["id"],
                "question_text": q["question_text"],
                "question_type": q["type"],
                "knowledge_points": q.get("knowledge_points", ""),
                "explanation": ai_response,
                "student_answer": ans.get("student_answer", ""),
                "correct_answer": q["correct_answer"],
            }

        wrong_questions = []
        for q in questions:
            qid = str(q["id"])
            if qid not in answers_data:
                continue
            ans = answers_data[qid]
            if not ans.get("is_correct", False):
                wrong_questions.append((q, ans))

        explanations = []
        if wrong_questions:
            sem = asyncio.Semaphore(5)
            async def _limited(q, ans):
                async with sem:
                    return await _call_ai_for_question(q, ans)
            tasks = [_limited(q, ans) for q, ans in wrong_questions]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for r in results:
                if isinstance(r, Exception):
                    logger.error(f"AI 讲解生成失败: {r}")
                    explanations.append({"error": f"AI 讲解生成失败: {str(r)}"})
                else:
                    explanations.append(r)

        return {
            "exam_title": exam["title"],
            "explanations": explanations,
            "total_wrong": len(explanations),
        }

    task_id = await task_manager.create_task(description="AI 错题讲解", coro_factory=_do_explain)
    return {"task_id": task_id, "message": "AI 讲解已提交，请稍后查询结果"}


# ═══════════════════════════════════════════════════════════
# V3.3 新增：AI 智能组卷优化
# ═══════════════════════════════════════════════════════════

class AIComposeRequest(BaseModel):
    """AI 智能组卷请求"""
    target_count: int = 10
    knowledge_focus: str = ""
    difficulty_distribution: str = "easy:medium:hard = 2:5:3"


@router.post("/{exam_id}/ai-compose", summary="AI 智能组卷")
async def ai_compose_exam(exam_id: int, req: AIComposeRequest, request: Request):
    """AI 智能组卷：根据考试目标从题库自动选择最优试题组合"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可操作")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权操作此考试")

    # 获取候选题目（排除已添加的）
    candidates = execute_query(
        """SELECT q.id, q.type, q.question_text, q.difficulty,
                  q.knowledge_points, q.subject
           FROM question_bank q
           WHERE q.status = 'active'
           AND q.subject = ?
           AND q.id NOT IN (SELECT question_id FROM exam_questions WHERE exam_id = ?)
           ORDER BY q.difficulty
           LIMIT 50""",
        (exam["subject"], exam_id),
    )

    if not candidates:
        raise HTTPException(status_code=400, detail="题库中没有可选的题目，请先导入试题")

    # 构建候选题目文本
    type_map = {"single": "单选题", "multiple": "多选题", "true_false": "判断题", "short": "简答题"}
    diff_map = {"easy": "简单", "medium": "中等", "hard": "困难"}

    candidate_text = ""
    for i, q in enumerate(candidates, 1):
        q_type = type_map.get(q["type"], q["type"])
        q_diff = diff_map.get(q["difficulty"], q["difficulty"])
        q_text = q["question_text"][:80]
        q_kp = q.get("knowledge_points", "") or "无"
        candidate_text += f"{i}. [{q_type}][{q_diff}] {q_text} (知识点: {q_kp})\n"

    from backend.prompts.exam import AI_EXAM_COMPOSE_PROMPT
    from backend.api.chat_router import get_api_keys
    from backend.api.ai_service import call_ai_async

    keys = get_api_keys(username)
    api_key = keys[0] if keys and keys[0] else ""
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    def _safe(s):
        return str(s).replace('{', '{{').replace('}', '}}')

    prompt = AI_EXAM_COMPOSE_PROMPT.format(
        exam_title=_safe(exam["title"]),
        subject=_safe(exam["subject"]),
        total_score=_safe(exam["total_score"]),
        target_count=_safe(req.target_count),
        knowledge_focus=_safe(req.knowledge_focus or "无特定要求"),
        candidate_questions=_safe(candidate_text),
    )

    try:
        ai_response = await call_ai_async(prompt, api_key)
    except Exception as e:
        logger.error(f"AI 组卷调用失败: {e}")
        raise HTTPException(status_code=500, detail=f"AI 组卷失败: {str(e)}")

    # 解析 AI 返回的 JSON
    import re
    json_match = re.search(r'\{[^}]+\}', ai_response)
    if not json_match:
        raise HTTPException(status_code=500, detail="AI 返回格式异常，请重试")

    try:
        result = json.loads(json_match.group())
        selected_ids = result.get("selected_ids", [])
        reason = result.get("reason", "")
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=500, detail="AI 返回格式解析失败")

    if not selected_ids:
        raise HTTPException(status_code=400, detail="AI 未选择任何题目，请调整条件后重试")

    # 验证选中的题目是否都在候选列表中
    valid_ids = {q["id"] for q in candidates}
    selected_ids = [sid for sid in selected_ids if sid in valid_ids]

    if not selected_ids:
        raise HTTPException(status_code=400, detail="AI 选择的题目无效，请重试")

    # 添加题目到考试
    max_order_row = execute_query_one(
        "SELECT COALESCE(MAX(sort_order), -1) as max_order FROM exam_questions WHERE exam_id = ?",
        (exam_id,),
    )
    next_order = (max_order_row["max_order"] + 1) if max_order_row else 0

    score_per_question = round(exam["total_score"] / len(selected_ids), 1)
    score_per_question = max(score_per_question, 1)

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    added = 0
    for i, qid in enumerate(selected_ids):
        existing = execute_query_one(
            "SELECT id FROM exam_questions WHERE exam_id = ? AND question_id = ?",
            (exam_id, qid),
        )
        if existing:
            continue
        execute_insert(
            """INSERT INTO exam_questions (exam_id, question_id, sort_order, score)
               VALUES (?, ?, ?, ?)""",
            (exam_id, qid, next_order + i, score_per_question),
        )
        added += 1

    execute_update("UPDATE exams SET updated_at = ? WHERE id = ?", (now, exam_id))

    logger.info(f"AI 组卷: 考试{exam_id} by {username}, 推荐{len(selected_ids)}题, 实际添加{added}题")

    return {
        "message": f"AI 组卷完成，共添加 {added} 道试题",
        "added": added,
        "recommended": len(selected_ids),
        "reason": reason,
    }
