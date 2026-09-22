"""
考试发布 API 路由
创建/发布/答题/批改/查分
"""
import asyncio
import json
import traceback
import re
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.grading_state import pending_grading_by_exam
from backend.question_db import (
    execute_query,
    execute_query_one,
    execute_insert,
    execute_update,
)
from backend.api.dependencies import get_current_user
from backend.auth import is_admin
from backend.database import execute_query as user_query, execute_insert_update as db_update
from backend.logger import logger
from backend.api.ai_service import call_ai_async
from backend.prompts import apply_skills, build_ai_role
from backend.async_utils import spawn_bg
from backend.utils import extract_json_from_text
from backend.permission_service import check_activity_visibility
# S-GRADING(P2): 主观题后台批量批改引擎(与同步练习/随堂测验共用)
from backend.ai_grading import GradingJob, SourceAdapter, register_source, pending_keys
from backend.question_db import get_connection

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
    # 目标范围字段
    target_scope: str = "teacher_classes"
    target_grade: str = ""
    target_class: str = ""
    target_users: str = ""


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
    target_scope: str | None = None
    target_grade: str | None = None
    target_class: str | None = None
    target_users: str | None = None


class ExamQuestionAdd(BaseModel):
    """添加试题到考试请求"""
    question_ids: list[int]
    scores: list[float] | None = None  # 每道题的分值，不传则使用默认值


class ExamSubmit(BaseModel):
    """学生提交答案请求"""
    answers: dict[str, Any]  # {question_id: answer}


class AutoSelectRequest(BaseModel):
    """智能选题请求"""
    subject: str | None = None
    question_types: list[str] | None = None
    difficulty: str | None = None
    knowledge_keyword: str | None = None
    count: int = 10
    exclude_existing: bool = True

    class Config:
        @staticmethod
        def validate_schema(v):
            if v.get("count", 10) < 1 or v.get("count", 10) > 200:
                raise ValueError("选题数量范围为 1-200")
            return v


# ── 辅助函数 ──

def _can_manage_exam(username: str, exam: dict[str, Any] | None = None) -> bool:
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
            creator_username, creator_name, created_at, updated_at,
            target_scope, target_grade, target_class, target_users)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?,
                   ?, ?, ?, ?)""",
        (
            req.title, req.description, req.subject, req.duration,
            req.total_score, req.pass_score,
            1 if req.shuffle_questions else 0,
            1 if req.shuffle_options else 0,
            1 if req.show_result_immediately else 0,
            req.max_attempts, req.start_time, req.end_time,
            username, creator_name, now, now,
            req.target_scope, req.target_grade, req.target_class, req.target_users,
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
    pending_grading: int = Query(0, description="1=仅看仍有待批改答卷的考试"),
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
    pending_counts: dict[int, int] = {}

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

        # 逐条判断学生是否有权限看到该考试（使用统一的活动范围检查）
        filtered = []
        for exam in all_rows:
            if check_activity_visibility(
                student_username=username,
                student_grade=student_grade,
                student_class=student_class,
                creator_username=exam["creator_username"],
                target_scope=exam.get("target_scope", "teacher_classes"),
                target_grade=exam.get("target_grade", ""),
                target_class=exam.get("target_class", ""),
                target_users=exam.get("target_users", ""),
            ):
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
                   WHERE exam_id = ? AND student_username = ? AND status <> 'expired'
                   ORDER BY id DESC LIMIT 1""",
                (row["id"], username),
            )
            row["my_attempt"] = _normalize_client_attempt(attempt)
    else:
        # 待批改判定要看 ai_pending / grading_details（JSON），SQL 里近似判断会算错，
        # 所以带该筛选时先全量取、Python 侧筛完再分页（考试量级很小）
        if pending_grading:
            pending_counts, _ = pending_grading_by_exam()
            all_rows = execute_query(
                f"""SELECT e.*,
                    (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) as question_count
                    FROM exams e WHERE {where} ORDER BY e.created_at DESC""",
                tuple(params),
            )
            kept = [r for r in (all_rows or []) if pending_counts.get(int(r["id"]), 0) > 0]
            total = len(kept)
            start = (page - 1) * page_size
            rows = kept[start:start + page_size]
        else:
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

    # 每场的待批改份数：与首页「待处理批阅」共用 grading_state 口径
    if role != 2:
        _pc = pending_counts if pending_grading else pending_grading_by_exam()[0]
        for row in rows:
            try:
                row["pending_grading"] = _pc.get(int(row["id"]), 0)
            except (TypeError, ValueError, KeyError):
                row["pending_grading"] = 0

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
    if role == 2:
        if exam["status"] != "published":
            raise HTTPException(status_code=403, detail="考试未发布")
        # 学生还需检查活动范围
        student_rows = user_query(
            "SELECT grade, class FROM users WHERE username=?", (username,)
        )
        s_grade = str(student_rows[0][0] or "").strip() if student_rows else ""
        s_class = str(student_rows[0][1] or "").strip() if student_rows else ""
        if not check_activity_visibility(
            student_username=username,
            student_grade=s_grade,
            student_class=s_class,
            creator_username=exam["creator_username"],
            target_scope=exam.get("target_scope", "teacher_classes"),
            target_grade=exam.get("target_grade", ""),
            target_class=exam.get("target_class", ""),
            target_users=exam.get("target_users", ""),
        ):
            raise HTTPException(status_code=403, detail="无权查看该考试")
    if role == 1 and exam["creator_username"] != username:
        raise HTTPException(status_code=403, detail="无权查看其他教师的考试")

    # 获取题目列表
    questions = execute_query(
        """SELECT eq.id as eq_id, eq.sort_order, eq.score as question_score,
                  q.id, q.type, q.question_text, q.options, q.correct_answer,
                  q.explanation, q.difficulty, q.knowledge_points,
                  q.svg_content, q.has_svg, q.media_files
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
               WHERE exam_id = ? AND student_username = ? AND status <> 'expired'
               ORDER BY id DESC LIMIT 1""",
            (exam_id, username),
        )
        exam["my_attempt"] = _normalize_client_attempt(attempt)

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
                   "max_attempts", "target_scope", "target_grade",
                   "target_class", "target_users"]:
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
                    from backend.api.notification_router import notify_users_by_scope
                    notify_users_by_scope(
                        creator_username=exam["creator_username"],
                        type_="exam",
                        title=f"考试「{exam['title']}」信息已更新",
                        content=f"涉及字段：{'、'.join(changed)}，请重新查看考试详情",
                        related_link="/exam",
                        target_scope=exam.get("target_scope", "teacher_classes"),
                        target_grade=exam.get("target_grade", ""),
                        target_class=exam.get("target_class", ""),
                        target_users=exam.get("target_users", ""),
                        source_type="exam",
                        source_id=str(exam_id),
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
                from backend.api.notification_router import notify_users
                affected = execute_query(
                    """SELECT DISTINCT student_username FROM exam_attempts
                       WHERE exam_id = ?""",
                    (exam_id,),
                )
                if affected:
                    notify_users(
                        [r["student_username"] for r in affected], "exam",
                        f"考试「{exam['title']}」已取消",
                        f"教师已删除该考试",
                        "/exam",
                        source_type="exam",
                        source_id=str(exam_id),
                    )
            except Exception as notify_err:
                logger.warning(f"发送考试取消通知失败: {notify_err}")
        asyncio.create_task(_notify_delete())

    # 删除关联数据
    execute_update("DELETE FROM exam_questions WHERE exam_id = ?", (exam_id,))
    execute_update("DELETE FROM exam_attempts WHERE exam_id = ?", (exam_id,))
    # activity_rewards 和 notifications 在 smartkb.db（使用主数据库连接）
    from backend.reward_engine import activity_reward_students, recompute_students
    _affected = activity_reward_students([("exam", exam_id)])
    db_update("DELETE FROM activity_rewards WHERE activity_type='exam' AND activity_id=?", (str(exam_id),))
    db_update("DELETE FROM notifications WHERE source_type='exam' AND source_id=?", (str(exam_id),))
    execute_update("DELETE FROM exams WHERE id = ?", (exam_id,))
    recompute_students(_affected)          # 缺陷A：删流水必须就地重算总分

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

    # ── 异步按目标范围发送通知（不阻塞发布操作） ──
    async def _notify_publish():
        try:
            from backend.api.notification_router import notify_users_by_scope
            notify_users_by_scope(
                creator_username=exam["creator_username"],
                type_="exam",
                title=f"新考试「{exam['title']}」已发布",
                content=f"时长 {exam['duration']} 分钟，满分 {exam['total_score']} 分",
                related_link="/exam",
                target_scope=exam.get("target_scope", "teacher_classes"),
                target_grade=exam.get("target_grade", ""),
                target_class=exam.get("target_class", ""),
                target_users=exam.get("target_users", ""),
                source_type="exam",
                source_id=str(exam_id),
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
            from backend.api.notification_router import notify_users
            in_progress = execute_query(
                """SELECT student_username FROM exam_attempts
                   WHERE exam_id = ? AND status = 'in_progress'""",
                (exam_id,),
            )
            if in_progress:
                notify_users(
                    [r["student_username"] for r in in_progress], "exam",
                    f"考试「{exam['title']}」已提前结束",
                    f"教师已结束考试，请查看成绩",
                    "/exam",
                    source_type="exam",
                    source_id=str(exam_id),
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
    conditions = ["q.status = 'active'", "q.type != 'code'"]
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

    # count 上限校验
    select_count = max(1, min(req.count, 200, len(rows)))

    # 随机选取
    import random
    selected = random.sample(rows, select_count)

    # 获取当前最大排序序号
    max_order_row = execute_query_one(
        "SELECT COALESCE(MAX(sort_order), -1) as max_order FROM exam_questions WHERE exam_id = ?",
        (exam_id,),
    )
    next_order = (max_order_row["max_order"] + 1) if max_order_row else 0

    # 等分总分
    score_per_question = round(exam["total_score"] / len(selected), 1)
    score_per_question = max(score_per_question, 1)
    actual_total = round(score_per_question * len(selected), 1)

    added = 0
    added_questions = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for i, q in enumerate(selected):
        qid = q["id"]
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

    # 同步总分（确保与实际分配一致）
    if abs(actual_total - exam["total_score"]) > 0.1:
        execute_update(
            "UPDATE exams SET total_score = ?, updated_at = ? WHERE id = ?",
            (actual_total, now, exam_id),
        )
        logger.info(f"智能选题同步总分: {exam['total_score']} → {actual_total}")
    else:
        execute_update("UPDATE exams SET updated_at = ? WHERE id = ?", (now, exam_id))

    logger.info(f"用户 {username} 智能选题: 考试{exam_id} 选取={added}题")

    return {
        "message": f"智能选题完成，共添加 {added} 道试题",
        "added": added,
        "questions": added_questions,
    }


# ── 学生答题 ──

def _attempt_deadline(attempt: dict, exam: dict):
    """X1: 个人作答截止时间 = 开始时间 + 考试时长(+3 分钟宽限)；未设时长返回 None(仅受考试起止窗约束)"""
    try:
        dur = float(exam.get("duration") or 0)
    except (TypeError, ValueError):
        dur = 0
    if dur <= 0:
        return None
    try:
        started = datetime.strptime(attempt["started_at"], "%Y-%m-%d %H:%M:%S")
    except (KeyError, TypeError, ValueError):
        return None
    return started + timedelta(minutes=dur, seconds=180)


def _normalize_client_attempt(attempt):
    """客户端只识别 in_progress/submitted: 过期记录不返回, 批改中短暂表现为进行中"""
    if attempt and attempt.get("status") == "grading":
        attempt = dict(attempt)
        attempt["status"] = "in_progress"
    return attempt


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

    # 检查活动范围
    student_rows = user_query(
        "SELECT grade, class FROM users WHERE username=?", (username,)
    )
    s_grade = str(student_rows[0][0] or "").strip() if student_rows else ""
    s_class = str(student_rows[0][1] or "").strip() if student_rows else ""
    if not check_activity_visibility(
        student_username=username,
        student_grade=s_grade,
        student_class=s_class,
        creator_username=exam["creator_username"],
        target_scope=exam.get("target_scope", "teacher_classes"),
        target_grade=exam.get("target_grade", ""),
        target_class=exam.get("target_class", ""),
        target_users=exam.get("target_users", ""),
    ):
        raise HTTPException(status_code=403, detail="无权参加该考试")

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

    # 检查是否有进行中的答题（X1: 超时未交的旧尝试置为 expired, 允许重新开始）
    in_progress = execute_query_one(
        """SELECT * FROM exam_attempts
           WHERE exam_id = ? AND student_username = ? AND status IN ('in_progress','grading')
           ORDER BY id DESC LIMIT 1""",
        (exam_id, username),
    )
    if in_progress:
        _dl = _attempt_deadline(in_progress, exam)
        if _dl is None or now <= _dl:
            return {
                "message": "检测到进行中的答题，继续作答",
                "attempt_id": in_progress["id"],
                "existing": True,
            }
        execute_update(
            "UPDATE exam_attempts SET status='expired' WHERE id=? AND status IN ('in_progress','grading')",
            (in_progress["id"],),
        )

    # 获取学生姓名
    name_rows = user_query("SELECT name FROM users WHERE username=?", (username,))
    student_name = name_rows[0][0] if name_rows and name_rows[0][0] else username

    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    try:
        attempt_id = execute_insert(
            """INSERT INTO exam_attempts
               (exam_id, student_username, student_name, started_at, status, total_score)
               VALUES (?, ?, ?, ?, 'in_progress', ?)""",
            (exam_id, username, student_name, now_str, exam["total_score"]),
        )
    except Exception:
        # X4: 并发下另一请求已创建进行中记录(唯一索引拦截), 复用既有记录
        _active = execute_query_one(
            """SELECT id FROM exam_attempts
               WHERE exam_id = ? AND student_username = ? AND status IN ('in_progress','grading')
               ORDER BY id DESC LIMIT 1""",
            (exam_id, username),
        )
        if _active:
            return {
                "message": "检测到进行中的答题，继续作答",
                "attempt_id": _active["id"],
                "existing": True,
            }
        raise

    return {
        "message": "考试开始",
        "attempt_id": attempt_id,
        "existing": False,
    }


# ── AI 批改辅助函数 ──

def _extract_json_from_ai_response(text: str) -> dict[str, Any] | None:
    """从 AI 响应中提取 JSON 对象（支持嵌套 {}）"""
    if not text:
        return None
    text = text.strip()
    # 尝试直接解析整段文本
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    # 尝试提取被 ```json ... ``` 包裹的代码块
    code_match = re.search(r'```(?:json)?\s*\n?([\s\S]*?)\n?```', text)
    if code_match:
        try:
            return json.loads(code_match.group(1).strip())
        except (json.JSONDecodeError, TypeError):
            pass
    # 用栈匹配法提取最外层的完整 JSON 对象（支持嵌套）
    i = text.find('{')
    if i < 0:
        return None
    depth = 0
    in_str = False
    escape = False
    for j in range(i, len(text)):
        ch = text[j]
        if escape:
            escape = False
            continue
        if ch == '\\' and in_str:
            escape = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[i:j + 1])
                except (json.JSONDecodeError, TypeError):
                    return None
    return None


async def _grade_short_with_ai(q: dict[str, Any], student_answer: str, api_key: str, sem: asyncio.Semaphore) -> dict[str, Any]:
    """AI 批改简答题，返回含评语的详细批改结果"""
    qid = str(q["id"])
    correct_answer = q["correct_answer"]
    q_score = q["score"] or 10
    async with sem:
        try:
            from backend.prompts.exam import SHORT_ANSWER_GRADING_PROMPT
            question_text = str(q.get("question_text", "") or "")
            prompt = SHORT_ANSWER_GRADING_PROMPT.format(
                question_text=question_text.replace('{', '{{').replace('}', '}}'),
                correct_answer=str(correct_answer or "").replace('{', '{{').replace('}', '}}'),
                max_score=str(q_score),
                half_score=str(q_score * 0.5),
                near_full=str(q_score * 0.8),
                half_minus=str(q_score * 0.4),
                student_answer=str(student_answer or "").replace('{', '{{').replace('}', '}}'),
            )
            # S-GRADING: 评分 prompt 不注入技能 —— 技能段会多塞约 1900 字教学指令
            # (「禁止直接给出最终答案、要展示推导过程」等), 与「只输出 JSON」冲突,
            # 返回变成散文 → 解析失败 → 静默退回关键词判 0 分。与练习侧同一结论。
            ai_resp = await call_ai_async(prompt, api_key)
            result = _extract_json_from_ai_response(ai_resp)
            if result:
                ai_score = float(result.get("score", 0))
                ai_score = max(0, min(ai_score, q_score))
                return {
                    "student_answer": student_answer,
                    "correct_answer": correct_answer,
                    "score": ai_score,
                    "max_score": q_score,
                    "is_correct": ai_score >= q_score * 0.6,
                    "comment": result.get("comment", ""),
                    "feedback": result.get("feedback", ""),
                    "key_points_hit": result.get("key_points_hit", []),
                    "key_points_missed": result.get("key_points_missed", []),
                    # S-GRADING: 标明这份结果是谁给的, 后台批改器据此判断要不要转人工
                    "graded_by": "ai",
                }
        except Exception as e:
            logger.warning(f"AI 批改简答题 {qid} 失败: {e}")
    # AI 失败回退到关键词匹配
    is_correct = _check_short_answer(student_answer, correct_answer)
    return {
        "student_answer": student_answer,
        "correct_answer": correct_answer,
        "score": q_score if is_correct else 0,
        "max_score": q_score,
        "is_correct": is_correct,
        "comment": "",
        "feedback": "",
        "key_points_hit": [],
        "key_points_missed": [],
        "graded_by": "keyword",     # S-GRADING: 没走成 AI, 关键词兜底
    }


async def _grade_essay_with_ai(q: dict[str, Any], student_answer: str, api_key: str, sem: asyncio.Semaphore,
                                 subject: str = "") -> dict[str, Any]:
    """AI 多维批改主观题/作文，返回含维度评分的详细批改结果"""
    qid = str(q["id"])
    correct_answer = q["correct_answer"]
    q_score = q["score"] or 20
    async with sem:
        try:
            from backend.prompts.exam import ESSAY_GRADING_PROMPT
            question_text = str(q.get("question_text", "") or "")
            # S-GRADING: 这里只加学科角色, 不再 apply_skills(理由同上)
            ai_role = build_ai_role(subject=subject)
            prompt = f"{ai_role}" + ESSAY_GRADING_PROMPT.format(
                subject=subject.replace('{', '{{').replace('}', '}}'),
                question_text=question_text.replace('{', '{{').replace('}', '}}'),
                correct_answer=str(correct_answer or "").replace('{', '{{').replace('}', '}}'),
                max_score=str(q_score),
                student_answer=str(student_answer or "").replace('{', '{{').replace('}', '}}'),
            )
            ai_resp = await call_ai_async(prompt, api_key)
            result = _extract_json_from_ai_response(ai_resp)
            if result:
                ai_score = float(result.get("score", 0))
                ai_score = max(0, min(ai_score, q_score))
                dims = result.get("dimensions", {})
                return {
                    "student_answer": student_answer,
                    "correct_answer": correct_answer,
                    "score": ai_score,
                    "max_score": q_score,
                    "is_correct": ai_score >= q_score * 0.6,
                    "grading_type": "essay",
                    "dimensions": {
                        "content": dims.get("content", {}),
                        "structure": dims.get("structure", {}),
                        "language": dims.get("language", {}),
                    },
                    "overall_comment": result.get("overall_comment", ""),
                    "improvement_suggestions": result.get("improvement_suggestions", []),
                    "key_points_hit": result.get("key_points_hit", []),
                    "key_points_missed": result.get("key_points_missed", []),
                    "graded_by": "ai",         # S-GRADING: AI 多维评分成功
                }
        except Exception as e:
            logger.warning(f"AI 批改主观题 {qid} 失败: {e}")
    # AI 失败回退到关键词匹配
    is_correct = _check_short_answer(student_answer, correct_answer)
    return {
        "student_answer": student_answer,
        "correct_answer": correct_answer,
        "score": q_score if is_correct else 0,
        "max_score": q_score,
        "is_correct": is_correct,
        "grading_type": "essay",
        "dimensions": {},
        "overall_comment": "AI 批改失败，使用关键词匹配评分",
        "improvement_suggestions": [],
        "key_points_hit": [],
        "key_points_missed": [],
        "graded_by": "keyword",     # S-GRADING: 没走成 AI, 关键词兜底
    }


def _claim_settlement(attempt_id: Any) -> bool:
    """抢占本份答卷的"结算权"：抢到才发通知/进错题本/发积分/推学伴。

    settled_at 为空 → 写入当前时间戳, rowcount=1 即抢占成功; 已被别人占过则返回 False。
    列还没补上(极老库未跑过启动期迁移)时**放行而不是拦死** —— 宁可不幂等, 也不能因为
    缺列就一条通知都不发。
    """
    if not attempt_id:
        return True
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        changed = execute_update(
            "UPDATE exam_attempts SET settled_at = ? WHERE id = ? AND ifnull(settled_at, '') = ''",
            (stamp, attempt_id),
        )
    except Exception as e:
        logger.warning(f"[结算抢占] settled_at 不可用, 按原逻辑继续结算: {e}")
        return True
    if not changed:
        logger.info(f"[结算抢占] 答卷 {attempt_id} 已结算过, 跳过重复的通知/错题本/积分")
    return bool(changed)


def _settle_exam_attempt(attempt: dict, exam: dict | None = None) -> dict:
    """一份考试答卷判分完毕后的收尾：成绩通知 + 教师通知 + 错题本 + 等级积分 + 学伴推送

    有主观题挂在后台批改队列时，提交请求里一律不做这些动作 —— 否则会拿
    "只算了客观分的临时成绩"去发通知、进错题本、按低档发等级积分，几十秒后又变了。
    参与分与成绩无关，仍在提交当场发。可重复调用（award_*/错题本自身都做了去重）。
    """
    exam_id = attempt["exam_id"]
    username = attempt["student_username"]
    earned = round(float(attempt.get("score") or 0), 1)
    if not exam:
        exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        return {"settled": False, "reason": "考试不存在"}
    if not _claim_settlement(attempt.get("id")):
        return {"settled": False, "reason": "已结算过(重复收敛), 本次不再重发通知"}
    total = float(attempt.get("total_score") or exam.get("total_score") or 0)
    try:
        graded = json.loads(attempt.get("answers") or "{}") if isinstance(attempt.get("answers"), str) \
            else (attempt.get("answers") or {})
    except (json.JSONDecodeError, TypeError):
        graded = {}
    if not isinstance(graded, dict):
        graded = {}
    title = exam.get("title") or f"考试#{exam_id}"

    # ── 学生成绩通知 ──
    try:
        from backend.api.notification_router import create_notification
        passed_str = "通过" if earned >= (exam.get("pass_score") or 0) else "未通过"
        create_notification(
            username, "exam", f"考试「{title}」成绩已出",
            f"得分 {earned}/{total}（{passed_str}）", "/exam",
            source_type="exam", source_id=str(exam_id),
        )
    except Exception as notify_err:
        logger.warning(f"发送考试结果通知失败: {notify_err}")

    # ── 通知教师 ──
    try:
        from backend.api.notification_router import create_notification
        teacher_username = exam.get("creator_username", "")
        if teacher_username and teacher_username != username:
            name_rows = user_query("SELECT name FROM users WHERE username=?", (username,))
            student_display = name_rows[0][0] if name_rows and name_rows[0][0] else username
            create_notification(
                teacher_username, "exam", f"学生提交答卷: {student_display}",
                f"已提交考试「{title}」，得分 {earned}/{total}",
                f"/exam/{exam_id}/results",
                source_type="exam", source_id=str(exam_id),
            )
    except Exception as notify_err:
        logger.warning(f"发送教师通知失败: {notify_err}")

    # ── 错题本 ──
    try:
        from backend.api.wrong_book_router import (
            record_wrong_answers, mark_wrong_mastered, check_and_auto_generate_wrong_practice,
        )
        record_wrong_answers(username, exam_id, graded)
        correct_graded = {k: v for k, v in graded.items()
                          if isinstance(v, dict) and v.get("is_correct", False)}
        if correct_graded:
            mark_wrong_mastered(username, correct_graded)
        # W10: 阈值检查与练习生成放后台线程, 不拖慢请求
        spawn_bg(check_and_auto_generate_wrong_practice, username,
                 name=f"错题巩固练习检查({username})")
    except Exception as wb_err:
        logger.warning(f"记录错题失败 (user={username}, exam_id={exam_id}): {wb_err}")
        logger.warning(traceback.format_exc())

    # ── 等级积分(得分率) ──
    try:
        from backend.reward_engine import award_grade
        award_grade(username, "exam", str(exam_id), earned, total, title)
    except Exception as rw_err:
        logger.warning(f"考试等级积分结算失败 (user={username}, exam_id={exam_id}): {rw_err}")

    # ── AI 学伴考试结果推送 ──
    try:
        from backend.companion_push import push_exam_result
        push_exam_result(username, title, earned, total, earned >= (exam.get("pass_score") or 0))
    except Exception as cp_err:
        logger.warning(f"学伴推送失败: {cp_err}")

    return {"settled": True, "score": earned, "total": total}


def _submitted_receipt(attempt_row: dict, exam: dict) -> dict:
    """X5: 重复提交时幂等返回既有批改结果。

    AI 批改(简答/作文)可能超过前端超时, 学生端显示"提交失败"但服务端仍在
    正常完成; 学生再次点击提交时旧实现一律 400("没有进行中的答题记录"/
    "该考试已提交"), 造成"明明有成绩却提示失败"的错觉。这里直接返回已存的
    得分与结果, 让第二次点击变成"看到成绩"而不是报错。
    """
    graded: dict = {}
    raw = attempt_row.get("answers")
    try:
        if isinstance(raw, str) and raw:
            graded = json.loads(raw)
        elif isinstance(raw, dict):
            graded = raw
    except (json.JSONDecodeError, TypeError):
        graded = {}
    earned = attempt_row.get("score") or 0.0
    pass_score = exam.get("pass_score") or 0
    pend = len(pending_keys(graded if isinstance(graded, dict) else {}))
    if pend:
        # 主观题还在后台批改: 再次点击提交时看到的是临时分, 说清楚免得被当成判错
        return {
            "message": f"已提交，{pend} 道主观题正在批改中，成绩稍后自动更新",
            "attempt_id": attempt_row["id"],
            "score": earned,
            "total_score": exam["total_score"],
            "passed": earned >= pass_score,
            "details": graded if exam.get("show_result_immediately") else None,
            "pending_ai": pend,
        }
    return {
        "message": "已提交，请勿重复提交",
        "attempt_id": attempt_row["id"],
        "score": earned,
        "total_score": exam["total_score"],
        "passed": earned >= pass_score,
        "details": graded if exam.get("show_result_immediately") else None,
        "pending_ai": 0,
    }


@router.post("/{exam_id}/submit")
async def submit_exam(exam_id: int, req: ExamSubmit, request: Request):
    """学生提交答案并自动批改（支持简答题 AI 语义批改 + 主观题/作文 AI 多维评分）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可以提交答案")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    # 获取进行中的答题记录
    attempt = execute_query_one(
        """SELECT id, started_at FROM exam_attempts
           WHERE exam_id = ? AND student_username = ? AND status = 'in_progress'
           ORDER BY id DESC LIMIT 1""",
        (exam_id, username),
    )
    if not attempt:
        # X5: 可能首单已提交成功(前端超时误报失败)或仍在 AI 批改中
        last = execute_query_one(
            """SELECT id, status, score, answers FROM exam_attempts
               WHERE exam_id = ? AND student_username = ?
               ORDER BY id DESC LIMIT 1""",
            (exam_id, username),
        )
        if last and last["status"] == "submitted":
            return _submitted_receipt(last, exam)
        if last and last["status"] == "grading":
            raise HTTPException(status_code=400,
                                detail="答卷已收到，AI 正在批改中，请勿重复提交，稍后刷新即可查看成绩")
        raise HTTPException(status_code=400, detail="没有进行中的答题记录")

    attempt_id = attempt["id"]

    # X2: 原子占坑 in_progress→grading, 并发重复提交只放行第一个(避免 AI 批改重复计费)
    claimed = execute_update(
        "UPDATE exam_attempts SET status='grading' WHERE id=? AND status='in_progress'",
        (attempt_id,),
    )
    if claimed == 0:
        _st = execute_query_one("SELECT id, status, score, answers FROM exam_attempts WHERE id=?", (attempt_id,))
        if _st and _st["status"] == "submitted":
            # X5: 并发重复提交 → 幂等返回既有结果, 不再误报失败
            return _submitted_receipt(_st, exam)
        if _st and _st["status"] == "grading":
            raise HTTPException(status_code=400,
                                detail="答卷已收到，AI 正在批改中，请勿重复提交，稍后刷新即可查看成绩")
        raise HTTPException(status_code=400, detail="答题记录状态已变化(批改中或已过期), 请刷新后查看结果")

    # X1: 个人时长校验(开始时间+时长+宽限)
    _dl = _attempt_deadline(attempt, exam)
    if _dl is not None and datetime.now() > _dl:
        execute_update("UPDATE exam_attempts SET status='expired' WHERE id=? AND status='grading'", (attempt_id,))
        raise HTTPException(status_code=400, detail="答题已超出考试时长限制, 请重新进入考试页面开始作答")

    # 校验考试是否已过期
    now_dt = datetime.now()
    if exam.get("end_time"):
        try:
            end_dt = datetime.strptime(exam["end_time"], "%Y-%m-%d %H:%M:%S")
            if now_dt > end_dt:
                raise HTTPException(status_code=400, detail="考试已结束，无法提交")
        except ValueError:
            pass

    # 获取所有题目信息（含 question_text 用于 AI 批改）
    questions = execute_query(
        """SELECT q.id, q.type, q.question_text, q.correct_answer, eq.score
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'""",
        (exam_id,),
    )

    # 检测是否有题目已被删除
    total_in_exam = execute_query_one(
        "SELECT COUNT(*) as cnt FROM exam_questions WHERE exam_id = ?",
        (exam_id,),
    )
    if total_in_exam and len(questions) < total_in_exam["cnt"]:
        deleted_count = total_in_exam["cnt"] - len(questions)
        logger.warning(f"考试 {exam_id} 有 {deleted_count} 道题已被删除，跳过评分")

    total_score = exam["total_score"]
    earned_score = 0.0
    graded_answers = {}       # 批改结果（含评语）
    grading_details = {}      # AI 详细批改数据（多维评分等，仅主观题/作文）

    # 按题型分组
    objective_qs = [q for q in questions if q["type"] in ("single", "multiple", "true_false")]
    short_qs = [q for q in questions if q["type"] in ("short", "fill")]  # 简答+填空：AI语义批改
    essay_qs = [q for q in questions if q["type"] in ("essay", "subjective")]

    # ── 客观题（单选/多选/判断）：精确匹配 ──
    for q in objective_qs:
        qid = str(q["id"])
        student_answer = req.answers.get(qid, "")
        correct_answer = q["correct_answer"]
        q_score = q["score"] or (total_score / max(len(questions), 1))
        is_correct = _check_choice_answer(
            student_answer, correct_answer, q["type"], _exam_opts_of(q.get("options")),
        )
        if is_correct:
            earned_score += q_score
        graded_answers[qid] = {
            "student_answer": student_answer,
            "correct_answer": correct_answer,
            "score": q_score if is_correct else 0,
            "max_score": q_score,
            "is_correct": is_correct,
        }

    # ── 获取 API Key（所有 AI 批改共享） ──
    try:
        from backend.api.chat_router import get_api_keys
        api_key, _ = get_api_keys(username)
    except Exception:
        api_key = ""
    if not api_key or not api_key.strip():
        api_key = ""  # 统一处理

    # ── 主观题（简答/填空/作文）：S-GRADING(P2) 一律交给后台批改器 ──
    # 提交请求里不再等 AI：一个班 40 人 × 5 道主观题 = 200 次调用，既慢又费 token。
    # 这里只写 grading='pending' 占位并把整行标记 ai_pending=1，由后台按「同一道题」
    # 合并多份答案批量评分，判完再补成绩通知/错题本/等级积分/学伴推送。
    pending_ai = 0
    subjective = [(q, "short") for q in short_qs] + [(q, "essay") for q in essay_qs]
    if subjective and api_key:
        for q, mode in subjective:
            qid = str(q["id"])
            q_max = float(q["score"] or (total_score / max(len(questions), 1)))
            one = {
                "student_answer": req.answers.get(qid, ""),
                "correct_answer": q["correct_answer"] or "",
                "score": 0,
                "max_score": q_max,
                "is_correct": False,
                "grading": "pending",
                "graded_by": "queued",
                "comment": "",
                "feedback": "",
                "key_points_hit": [],
                "key_points_missed": [],
            }
            if mode == "essay":
                # 作文/主观题的多维评分结构先占位, 判完由批改器回填(前端按空数组渲染不报错)
                one.update({
                    "grading_type": "essay",
                    "dimensions": {},
                    "overall_comment": "",
                    "improvement_suggestions": [],
                })
                grading_details[qid] = {
                    "dimensions": {}, "overall_comment": "", "improvement_suggestions": [],
                }
            graded_answers[qid] = one
            pending_ai += 1

    # 没配 API Key 时才走当场关键词兜底(不占后台队列), 与同步练习同一口径
    if subjective and not api_key:
        for q, mode in subjective:
            qid = str(q["id"])
            student_answer = req.answers.get(qid, "")
            correct_answer = q["correct_answer"]
            q_max = float(q["score"] or (total_score / max(len(questions), 1)))
            is_correct = _check_short_answer(student_answer, correct_answer)
            if is_correct:
                earned_score += q_max
            one = {
                "student_answer": student_answer,
                "correct_answer": correct_answer,
                "score": q_max if is_correct else 0,
                "max_score": q_max,
                "is_correct": is_correct,
                "comment": "",
                "feedback": "",
                "key_points_hit": [],
                "key_points_missed": [],
            }
            if mode == "essay":
                one.update({
                    "grading_type": "essay",
                    "dimensions": {},
                    "overall_comment": "当前为关键词匹配评分，建议配置 API Key 开启 AI 多维评分",
                    "improvement_suggestions": [],
                })
            graded_answers[qid] = one

    earned_score = round(earned_score, 1)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 原子更新
    rows = execute_update(
        """UPDATE exam_attempts
           SET status = 'submitted', submitted_at = ?, score = ?, answers = ?,
               auto_graded = 1, graded_by = ?,
               grading_details = ?, ai_pending = ?,
               settled_at = ''
           WHERE id = ? AND status = 'grading'""",
        (now, earned_score,
         json.dumps(graded_answers, ensure_ascii=False),
         # 待批改的题也先占好 grading_details 的位, 多维评分判完直接回填
         json.dumps(grading_details, ensure_ascii=False) if grading_details else '',
         '' if pending_ai else 'ai',        # 还没判完就别先声称是 AI 定的分
         1 if pending_ai else 0,
         attempt_id),
    )
    if rows == 0:
        logger.warning(f"学生 {username} 重复提交考试 {exam_id}，已忽略")
        raise HTTPException(status_code=400, detail="该考试已提交，请勿重复提交")

    logger.info(f"学生 {username} 提交考试 {exam_id}，得分 {earned_score}/{total_score}")

    # ── 判分后续动作：S-GRADING(P2) ──
    # 参与分与成绩无关，当场发；成绩通知/教师通知/错题本/等级积分/学伴推送
    # 都必须等主观题判完，否则发出去的就是"只含客观分的临时成绩"。
    try:
        from backend.reward_engine import award_participation
        award_participation(username, "exam", str(exam_id), exam["title"])
    except Exception as rw_err:
        logger.warning(f"考试参与积分发放失败 (user={username}, exam_id={exam_id}): {rw_err}")

    if not pending_ai:
        try:
            _settle_exam_attempt({
                "id": attempt_id, "exam_id": exam_id, "student_username": username,
                "score": earned_score, "total_score": total_score,
                "answers": json.dumps(graded_answers, ensure_ascii=False),
            }, exam)
        except Exception as st_err:
            logger.warning(f"考试结算失败 (user={username}, exam_id={exam_id}): {st_err}")
            logger.warning(traceback.format_exc())
    else:
        logger.info(f"考试 {exam_id} 答卷 {attempt_id} 已提交, {pending_ai} 道主观题转入后台批改队列")

    result = {
        "message": ("提交成功，主观题批改中，成绩稍后自动更新" if pending_ai else "提交成功"),
        "attempt_id": attempt["id"],
        "score": earned_score,
        "total_score": total_score,
        "passed": earned_score >= exam["pass_score"],   # 待批改时是临时判定, 前端按 pending_ai 覆盖显示
        "details": graded_answers if exam["show_result_immediately"] else None,
        # S-GRADING(P2): >0 表示还有主观题在后台批改, 前端据此显示「AI 批改中」并自动刷新
        "pending_ai": pending_ai,
    }

    if exam["show_result_immediately"]:
        result["details"] = graded_answers

    return result


# ═══════════════════════════════════════════════════════════
# 教师复核 AI 批改
# ═══════════════════════════════════════════════════════════

class TeacherReviewRequest(BaseModel):
    """教师复核/手动批改请求"""
    attempt_id: int
    teacher_score: float | None = None          # 手工调整的总分（null 表示不改动总分）
    teacher_comment: str | None = None           # 教师评语
    question_scores: dict[str, float] | None = None  # {question_id: 调整后的分数}
    question_comments: dict[str, str] | None = None  # {question_id: 教师针对该题的评语}


@router.post("/review", summary="教师复核/手动批改 AI 评分")
async def teacher_review_grading(req: TeacherReviewRequest, request: Request):
    """教师复核 AI 批改结果，可手动调整分数和添加评语"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可复核批改")

    attempt = execute_query_one("SELECT * FROM exam_attempts WHERE id = ?", (req.attempt_id,))
    if not attempt:
        raise HTTPException(status_code=404, detail="答题记录不存在")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (attempt["exam_id"],))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权复核此考试的成绩")

    # S-GRADING(P2): 本次复核前是否还挂着后台批改(决定要不要补结算)
    was_pending = bool(attempt.get("ai_pending"))

    updates = ["teacher_reviewed = 1", "graded_by = ?"]
    params = [username]

    # 更新总分
    final_score = attempt["score"]
    # S-GRADING(P2)修正: 只逐题改分而未显式给总分时, 总分按改后的逐题分重算
    # (见下方 answers 分支; 旧实现总分一直留在提交时的旧值, 教师补分看不到效果)
    if req.teacher_score is not None:
        final_score = round(max(float(req.teacher_score), 0), 1)
        updates.append("teacher_score = ?")
        params.append(final_score)
        updates.append("score = ?")
        params.append(final_score)

    # 更新教师评语
    if req.teacher_comment is not None:
        updates.append("teacher_comment = ?")
        params.append(req.teacher_comment)

    # 更新单题分数/评语（需要解析现有的 answers JSON）
    answers_data: dict = {}
    if req.question_scores or req.question_comments:
        answers_data = attempt.get("answers")
        if isinstance(answers_data, str):
            try:
                answers_data = json.loads(answers_data)
            except (json.JSONDecodeError, TypeError):
                answers_data = {}
        if not isinstance(answers_data, dict):
            answers_data = {}

        modified = False
        for qid, new_score in (req.question_scores or {}).items():
            if qid in answers_data:
                answers_data[qid]["score"] = round(max(float(new_score), 0), 1)
                answers_data[qid]["is_correct"] = answers_data[qid]["score"] >= (answers_data[qid].get("max_score", 1) * 0.6)
                answers_data[qid]["teacher_adjusted"] = True
                # S-GRADING(P2): 教师定分即视为判完, 该题退出后台批改队列(否则批改器还会来评)
                answers_data[qid]["grading"] = "graded"
                answers_data[qid].pop("needs_review", None)
                modified = True

        for qid, comment in (req.question_comments or {}).items():
            if qid in answers_data:
                answers_data[qid]["teacher_comment"] = comment
                modified = True

        if modified:
            answers_json = json.dumps(answers_data, ensure_ascii=False)
            updates.append("answers = ?")
            params.append(answers_json)
            # 逐题分已在上面改过, 总分按改后的题面重算(教师显式给总分时下面会覆盖)
            if req.teacher_score is None:
                _sum = round(sum(float(v.get("score") or 0) for v in answers_data.values()
                                 if isinstance(v, dict)), 1)
                _total = float(attempt["total_score"] or 0)
                final_score = min(_sum, _total) if _total > 0 else _sum
                updates.append("score = ?")
                params.append(final_score)

    # S-GRADING(P2): 只有逐题改分才需要重算队列标记(只改总分时题态没变, 别把 pending 抹掉)
    if answers_data:
        updates.append("ai_pending = ?")
        params.append(1 if pending_keys(answers_data) else 0)
        # 教师逐题定分=有新结果要告知, 放开结算标记, 允许再通知一次
        updates.append("settled_at = ''")

    params.append(attempt["id"])
    execute_update(
        f"UPDATE exam_attempts SET {', '.join(updates)} WHERE id = ?",
        tuple(params),
    )

    # 教师把最后一道主观题定分时, 补做考试收尾(与后台批改器同一个入口)
    if was_pending:
        try:
            again = execute_query_one("SELECT * FROM exam_attempts WHERE id = ?", (attempt["id"],))
            if again and not again.get("ai_pending"):
                _settle_exam_attempt(again, exam)
        except Exception as settle_err:
            logger.warning(f"考试结算失败 attempt={req.attempt_id}: {settle_err}")

    logger.info(f"教师 {username} 复核批改 attempt_id={req.attempt_id}, score={final_score}")
    return {
        "message": "复核完成",
        "attempt_id": req.attempt_id,
        "score": final_score,
        "total_score": attempt["total_score"],
    }


@router.get("/review/{attempt_id}", summary="获取 AI 批改详情与复核信息")
async def get_grading_review_detail(attempt_id: int, request: Request):
    """获取 AI 批改详情（含多维评分明细），供教师复核参考"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看批改详情")

    attempt = execute_query_one("SELECT * FROM exam_attempts WHERE id = ?", (attempt_id,))
    if not attempt:
        raise HTTPException(status_code=404, detail="答题记录不存在")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (attempt["exam_id"],))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权查看")

    # 解析 answers
    answers_data = attempt.get("answers")
    if isinstance(answers_data, str):
        try:
            answers_data = json.loads(answers_data)
        except (json.JSONDecodeError, TypeError):
            answers_data = {}
    if not isinstance(answers_data, dict):
        answers_data = {}

    # 解析 grading_details（多维评分明细）
    grading_details = attempt.get("grading_details")
    if isinstance(grading_details, str):
        try:
            grading_details = json.loads(grading_details)
        except (json.JSONDecodeError, TypeError):
            grading_details = {}
    if not grading_details:
        grading_details = {}

    # 获取题目信息
    questions = execute_query(
        """SELECT q.id, q.type, q.question_text, q.correct_answer, q.options,
                  q.explanation, q.knowledge_points, eq.score as question_score,
                  q.svg_content, q.has_svg, q.media_files
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'
           ORDER BY eq.sort_order""",
        (attempt["exam_id"],),
    )
    for q in questions:
        if q.get("options"):
            try:
                q["options"] = json.loads(q["options"])
            except (json.JSONDecodeError, TypeError):
                q["options"] = None
        else:
            q["options"] = None

    # 为每个题目补充批改信息
    question_results = []
    for q in questions:
        qid = str(q["id"])
        ans_info = answers_data.get(qid, {})
        grading_info = grading_details.get(qid, {})
        question_results.append({
            **q,
            "student_answer": ans_info.get("student_answer", ""),
            "score": ans_info.get("score", 0),
            "max_score": ans_info.get("max_score", q.get("question_score", 0)),
            "is_correct": ans_info.get("is_correct", False),
            "comment": ans_info.get("comment", ""),
            "feedback": ans_info.get("feedback", ""),
            "teacher_comment": ans_info.get("teacher_comment", ""),
            "teacher_adjusted": ans_info.get("teacher_adjusted", False),
            "key_points_hit": ans_info.get("key_points_hit", []),
            "key_points_missed": ans_info.get("key_points_missed", []),
            # 多维评分明细（主观题/作文）
            "dimensions": grading_info.get("dimensions", ans_info.get("dimensions", {})),
            "overall_comment": grading_info.get("overall_comment", ans_info.get("overall_comment", "")),
            "improvement_suggestions": grading_info.get("improvement_suggestions", ans_info.get("improvement_suggestions", [])),
        })

    return {
        "exam": {
            "id": exam["id"],
            "title": exam["title"],
            "subject": exam["subject"],
        },
        "student": {
            "username": attempt["student_username"],
            "name": attempt["student_name"] or attempt["student_username"],
        },
        "attempt": {
            "id": attempt["id"],
            "score": attempt["score"],
            "total_score": attempt["total_score"],
            "teacher_score": attempt.get("teacher_score", -1),
            "teacher_comment": attempt.get("teacher_comment", ""),
            "teacher_reviewed": attempt.get("teacher_reviewed", 0),
            "graded_by": attempt.get("graded_by", "ai"),
            "submitted_at": attempt["submitted_at"],
            "auto_graded": attempt["auto_graded"],
        },
        "questions": question_results,
    }


def _exam_opts_of(v: Any) -> Any:
    """题目 options 可能是 dict 或 JSON 字符串。"""
    if isinstance(v, (dict, list)):
        return v
    if isinstance(v, str) and v.strip():
        try:
            return json.loads(v)
        except (json.JSONDecodeError, TypeError):
            return None
    return None


def _check_choice_answer(student: str, correct: str, q_type: str, options: Any = None) -> bool:
    """选择题/判断题判分：统一走 backend.answer_norm。

    兼容历史与导入数据里的多种写法：选项下标('0')、多选 'ABC'/'A、B、C'、
    判断题 '对/错/正确'，避免「学生选 A、库里存 0」被判错。
    """
    from backend.answer_norm import answers_equal
    return answers_equal(student, correct, options, q_type)


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


# ── 学生查看自己的答题详情（增强版：含 AI 评语和多维评分） ──

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

    # 权限检查：学生只能看自己的；教师/管理员限本考试管理范围(X3, 与复核端点一致)
    if role == 2:
        if attempt["student_username"] != username:
            raise HTTPException(status_code=403, detail="无权查看他人的答题详情")
    else:
        _exam_row = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
        if not _exam_row or not _can_manage_exam(username, _exam_row):
            raise HTTPException(status_code=403, detail="无权查看该考试的答题详情")

    # 解析答案
    answers = attempt.get("answers")
    if isinstance(answers, str):
        try:
            answers = json.loads(answers)
        except (json.JSONDecodeError, TypeError):
            answers = {}
    if not isinstance(answers, dict):
        answers = {}

    # 解析 AI 详细批改数据
    grading_details = attempt.get("grading_details")
    if isinstance(grading_details, str):
        try:
            grading_details = json.loads(grading_details)
        except (json.JSONDecodeError, TypeError):
            grading_details = {}
    if not grading_details:
        grading_details = {}

    # 获取题目信息
    questions = execute_query(
        """SELECT q.id, q.type, q.question_text, q.options, q.correct_answer,
                  q.explanation, q.knowledge_points, eq.score as question_score,
                  q.svg_content, q.has_svg, q.media_files
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

    # 为每题补充 AI 批改详情
    enriched_questions = []
    for q in questions:
        qid = str(q["id"])
        ans = answers.get(qid, {})
        gd = grading_details.get(qid, {})
        enriched_questions.append({
            **q,
            "student_answer": ans.get("student_answer", ""),
            "student_score": ans.get("score", 0),
            "max_score": ans.get("max_score", q.get("question_score", 0)),
            "is_correct": ans.get("is_correct", False),
            # S-GRADING(P2): 题态与判分来源 —— 前端据此显示「AI 批改中」而不是误显示 0 分
            "grading": ans.get("grading", ""),
            "graded_by": ans.get("graded_by", ""),
            "needs_review": bool(ans.get("needs_review")),
            # AI 简答评语
            "comment": ans.get("comment", ""),
            "feedback": ans.get("feedback", ""),
            # AI 主观题多维评分
            "dimensions": gd.get("dimensions", ans.get("dimensions", {})),
            "overall_comment": gd.get("overall_comment", ans.get("overall_comment", "")),
            "improvement_suggestions": gd.get("improvement_suggestions", ans.get("improvement_suggestions", [])),
            "key_points_hit": ans.get("key_points_hit", []),
            "key_points_missed": ans.get("key_points_missed", []),
            # 教师复核
            "teacher_comment": ans.get("teacher_comment", ""),
            "teacher_adjusted": ans.get("teacher_adjusted", False),
        })

    return {
        "attempt": {
            "id": attempt["id"],
            "score": attempt["score"],
            "total_score": attempt["total_score"],
            "submitted_at": attempt["submitted_at"],
            "teacher_score": attempt.get("teacher_score", -1),
            "teacher_comment": attempt.get("teacher_comment", ""),
            "teacher_reviewed": attempt.get("teacher_reviewed", 0),
            # S-GRADING(P2): 还有几道主观题在后台批改(前端据此轮询刷新)
            "pending_ai": len(pending_keys(answers)),
            "answers": answers,
        },
        "questions": enriched_questions,
    }


@router.get("/attempt/{attempt_id}/grading-status", summary="批改进度轮询（不含题目与参考答案）")
async def get_attempt_grading_status(attempt_id: int, request: Request):
    """S-GRADING(P2): 前端在主观题后台批改期间轮询这个轻量接口拿最终分数。

    刻意不下发题面/参考答案：考试可能设置「不立即公布结果」，
    轮询接口不能变成绕过该设置的口子。逐题明细只在允许公布时给。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    attempt = execute_query_one("SELECT * FROM exam_attempts WHERE id = ?", (attempt_id,))
    if not attempt:
        raise HTTPException(status_code=404, detail="答题记录不存在")
    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (attempt["exam_id"],))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")
    if role == 2:
        if attempt["student_username"] != username:
            raise HTTPException(status_code=403, detail="无权查看他人的答题进度")
    elif not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权查看该考试的答题进度")

    graded = _exam_json_dict(attempt.get("answers"))
    pend = pending_keys(graded)
    out = {
        "attempt_id": attempt_id,
        "score": attempt.get("score") or 0,
        "total_score": attempt.get("total_score") or exam.get("total_score") or 0,
        "passed": bool((attempt.get("score") or 0) >= (exam.get("pass_score") or 0)),
        "pending_ai": len(pend),
        "pending_review": sum(1 for v in graded.values() if isinstance(v, dict) and v.get("needs_review")),
        "teacher_reviewed": attempt.get("teacher_reviewed") or 0,
        "graded_by": attempt.get("graded_by") or "",
        "show_details": bool(exam.get("show_result_immediately")),
        "items": {},
    }
    if out["show_details"]:
        # 只回判分结果, 不回 correct_answer / question_text
        for k, v in graded.items():
            if isinstance(v, dict):
                out["items"][k] = {kk: v.get(kk) for kk in (
                    "score", "max_score", "is_correct", "grading", "graded_by", "needs_review",
                    "comment", "feedback", "grading_type", "dimensions", "overall_comment",
                    "improvement_suggestions", "key_points_hit", "key_points_missed",
                    "teacher_adjusted",
                ) if v.get(kk) is not None}
    return out


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
                  submitted_at, status, auto_graded, ai_pending, teacher_reviewed, answers
           FROM exam_attempts
           WHERE exam_id = ? AND status = 'submitted'
           ORDER BY score DESC""",
        (exam_id,),
    )
    # S-GRADING(P2): 名册要能看出「谁还在批改中/谁需要人工批改」, 但 answers 明细不下发
    for a in attempts:
        _g = _exam_json_dict(a.get("answers"))
        a["pending_ai"] = len(pending_keys(_g))
        a["pending_review"] = sum(1 for v in _g.values() if isinstance(v, dict) and v.get("needs_review"))
        a.pop("answers", None)
    pending_ai_total = sum(a.get("pending_ai") or 0 for a in attempts)
    pending_review_total = sum(a.get("pending_review") or 0 for a in attempts)

    # 统计数据
    total_students = len(attempts)
    avg_score = round(sum(a["score"] for a in attempts) / max(total_students, 1), 1)
    pass_count = sum(1 for a in attempts if a["score"] >= exam["pass_score"])
    max_score = max((a["score"] for a in attempts), default=0)
    min_score = min((a["score"] for a in attempts), default=0)

    # 补充学生年级/班级（users/classes 在主库，批量查询；班级优先 classes.display_name）
    try:
        sus = [a["student_username"] for a in attempts if a.get("student_username")]
        if sus:
            _ph = ",".join("?" * len(sus))
            urows = user_query(
                f"SELECT username, grade, class, class_id FROM users WHERE username IN ({_ph})",
                tuple(sus),
            )
            cids = sorted({r[3] for r in urows if r[3]})
            cdisp = {}
            if cids:
                _cph = ",".join("?" * len(cids))
                for cid, dname in user_query(f"SELECT id, display_name FROM classes WHERE id IN ({_cph})", tuple(cids)):
                    cdisp[cid] = dname
            umap = {r[0]: r for r in urows}
            for a in attempts:
                u = umap.get(a.get("student_username"))
                cls_v = ""
                if u:
                    cls_v = cdisp.get(u[3], "") if u[3] else ""
                    if not cls_v:
                        raw = str(u[2] or "").strip()
                        if raw:
                            cls_v = raw if ("班" in raw or not raw.isdigit()) else f"{raw}班"
                a["grade"] = str((u[1] if u else "") or "")
                a["class_name"] = cls_v.strip()
    except Exception:
        pass

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
            # S-GRADING(P2): 整场考试还有多少题在后台批改 / 待人工批改
            "pending_ai_total": pending_ai_total,
            "pending_review_total": pending_review_total,
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

    # 获取题目信息（含选项和解析、配图）
    questions = execute_query(
        """SELECT q.id, q.type, q.question_text, q.options, q.correct_answer,
                  q.explanation, q.knowledge_points, eq.score as question_score,
                  q.svg_content, q.has_svg, q.media_files
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
            "teacher_reviewed": attempt.get("teacher_reviewed", 0),
            # S-GRADING(P2): 该份答卷的批改进度
            "pending_ai": len(pending_keys(answers if isinstance(answers, dict) else {})),
            "pending_review": sum(1 for v in (answers or {}).values()
                                  if isinstance(v, dict) and v.get("needs_review")),
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
                  q.knowledge_points, q.options, q.explanation,
                  q.svg_content, q.has_svg, q.media_files
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'""",
        (exam_id,),
    )

    from backend.ai_task_manager import task_manager

    async def _do_explain() -> dict[str, Any]:
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
            prompt = apply_skills(prompt, "exam")
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

    task_id = await task_manager.create_task(description="AI 错题讲解", coro_factory=_do_explain,
                                          dedupe_key=f"explain-wrong:{exam_id}", max_concurrent=4)
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
    type_map = {"single": "单选题", "multiple": "多选题", "true_false": "判断题", "short": "简答题",
                 "fill": "填空题", "essay": "作文", "subjective": "主观题"}
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

    ai_role = build_ai_role(subject=exam["subject"], grade=exam.get("target_grade", ""))
    prompt = f"{ai_role}" + AI_EXAM_COMPOSE_PROMPT.format(
        exam_title=_safe(exam["title"]),
        subject=_safe(exam["subject"]),
        total_score=_safe(exam["total_score"]),
        target_count=_safe(req.target_count),
        knowledge_focus=_safe(req.knowledge_focus or "无特定要求"),
        candidate_questions=_safe(candidate_text),
    )
    # 注意：不注入技能 — 技能的结构化输出指令与 JSON 格式要求冲突

    try:
        ai_response = await call_ai_async(prompt, api_key)
    except Exception as e:
        logger.error(f"AI 组卷调用失败: {e}")
        raise HTTPException(status_code=500, detail=f"AI 组卷失败: {str(e)}")

    # 解析 AI 返回的 JSON
    result = extract_json_from_text(ai_response)
    if not result or not isinstance(result, dict):
        raise HTTPException(status_code=500, detail="AI 返回格式异常，请重试")

    try:
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


# ════════════════════════════════════════════════════════════
# S-GRADING(P2): 考试主观题「后台批量批改」适配（引擎见 backend/ai_grading.py）
#   提交时：客观题当场判，主观题写 grading='pending' + 整行 ai_pending=1
#   引擎：同题多份答案合并成 1 次 AI 调用；作文/主观题按多维评分逐条批（仍不占提交请求）
#   判完：写回分数 → 若整份判完则补做成绩通知/错题本/等级积分/学伴推送
# ════════════════════════════════════════════════════════════

_ESSAY_TYPES = ("essay", "subjective")


def _exam_json_dict(raw: Any) -> dict[str, Any]:
    try:
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (json.JSONDecodeError, TypeError):
        data = {}
    return data if isinstance(data, dict) else {}


@router.post("/{exam_id}/grade-now", summary="教师：立即批改该考试待判的主观题")
async def grade_exam_now(exam_id: int, request: Request):
    """不等后台轮次，立刻把这份试卷待判的主观题批量批改掉

    走 ai_task_manager，前端用 pollAiTask 看进度；dedupe_key 保证连点/刷新不重复评。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可发起批改")
    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")
    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权批改此考试")

    pend = execute_query_one(
        "SELECT COUNT(*) c FROM exam_attempts WHERE exam_id=? AND ai_pending=1", (exam_id,)
    )
    cnt = int((pend or {}).get("c") or 0)
    if not cnt:
        return {"task_id": "", "message": "没有待批改的主观题", "pending_attempts": 0}

    from backend.ai_grading import drain_async
    from backend.ai_task_manager import task_manager

    task_id = await task_manager.create_task(
        description=f"学习考试 #{exam_id} 主观题批改",
        coro_factory=lambda: drain_async(only_source="exam", only_activity=str(exam_id)),
        owner_username=username,
        dedupe_key=f"exam-grade:{exam_id}",
        reuse_completed=False,   # 再点一次就得真再批一轮
    )
    return {"task_id": task_id, "message": "批改已开始", "pending_attempts": cnt}


def _exam_force_review(attempt_id: int, keys: list[str], reason: str) -> None:
    """判不了的题直接转教师批改（并清掉 pending，避免队列里空转）"""
    with get_connection() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT answers FROM exam_attempts WHERE id=?", (attempt_id,)).fetchone()
        if not row:
            conn.execute("COMMIT")
            return
        graded = _exam_json_dict(row["answers"])
        for k in keys:
            one = graded.get(str(k))
            if isinstance(one, dict):
                one["grading"] = "review"
                one["needs_review"] = True
                one["graded_by"] = "none"
                one["comment"] = ""
                one["feedback"] = reason
        still = pending_keys(graded)
        conn.execute("UPDATE exam_attempts SET answers=?, ai_pending=? WHERE id=?",
                     (json.dumps(graded, ensure_ascii=False), 1 if still else 0, attempt_id))
        conn.execute("COMMIT")


def _exam_fetch_jobs(limit: int) -> list[GradingJob]:
    """取待批改的考试主观题作业（题面/参考答案/满分供拼批量评分 prompt）"""
    rows = execute_query(
        """SELECT id, exam_id, student_username, answers FROM exam_attempts
           WHERE ai_pending=1 ORDER BY submitted_at LIMIT ?""",
        (limit,),
    )
    jobs: list[GradingJob] = []
    qcache: dict[int, dict[str, dict[str, Any]]] = {}
    subj_cache: dict[int, str] = {}
    for r in rows or []:
        aid, eid, stu = r["id"], r["exam_id"], r["student_username"]
        graded = _exam_json_dict(r["answers"])
        pend = pending_keys(graded)
        if not pend:
            execute_update("UPDATE exam_attempts SET ai_pending=0 WHERE id=?", (aid,))
            continue
        if eid not in qcache:
            qcache[eid] = {
                str(q["id"]): q for q in execute_query(
                    """SELECT q.id, q.type, q.question_text, q.correct_answer, eq.score
                       FROM exam_questions eq
                       JOIN question_bank q ON q.id = eq.question_id
                       WHERE eq.exam_id=?""",
                    (eid,),
                )
            }
            erow = execute_query_one("SELECT subject FROM exams WHERE id=?", (eid,))
            subj_cache[eid] = str((erow or {}).get("subject") or "")
        for key in pend:
            q = qcache[eid].get(str(key))
            if not q:      # 题目已从试卷里删掉: 直接转人工, 别在队列里回炉
                _exam_force_review(aid, [key], "题目已从试卷中移除，无法自动批改。")
                continue
            one = graded.get(key) or {}
            jobs.append(GradingJob(
                source="exam", attempt_id=aid, entry_key=str(key), student_username=stu,
                activity_id=str(eid),
                question_text=str(q.get("question_text") or ""),
                ref_answer=str(q.get("correct_answer") or ""),
                # 满分以提交时写下的为准, 保证与 total_score 口径一致
                max_score=float(one.get("max_score") or q.get("score") or 10),
                answer_text=str(one.get("student_answer") or ""),
                mode="essay" if q.get("type") in _ESSAY_TYPES else "short",
                meta={"subject": subj_cache.get(eid, ""), "type": str(q.get("type") or "")},
            ))
        if len(jobs) >= limit:
            break
    return jobs


async def _exam_grade_single(job: GradingJob, api_key: str) -> dict[str, Any]:
    """单条批改复用考试自己的 prompt(简答带要点命中, 作文带多维评分)"""
    from backend.ai_grading import review_result
    q = {
        "id": job.entry_key,
        "type": str(job.meta.get("type") or "short"),
        "question_text": job.question_text,
        "correct_answer": job.ref_answer,
        "score": job.max_score,
    }
    sem = asyncio.Semaphore(1)
    if job.mode == "essay":
        r = await _grade_essay_with_ai(q, job.answer_text, api_key, sem, str(job.meta.get("subject") or ""))
    else:
        r = await _grade_short_with_ai(q, job.answer_text, api_key, sem)
    if str(r.get("graded_by") or "") != "ai":
        # 没真走成 AI 就不采信关键词的 0 分/满分, 直接交回教师
        return review_result("AI 批改未成功，已转教师批改。")
    out = {
        "score": float(r.get("score") or 0),
        "is_correct": bool(r.get("is_correct")),
        "graded_by": "ai",
        "needs_review": False,
        "comment": str(r.get("comment") or "")[:600],
        "feedback": str(r.get("feedback") or "")[:600],
        "key_points_hit": r.get("key_points_hit") or [],
        "key_points_missed": r.get("key_points_missed") or [],
    }
    if job.mode == "essay":
        out.update({
            "dimensions": r.get("dimensions") or {},
            "overall_comment": str(r.get("overall_comment") or "")[:600],
            "improvement_suggestions": r.get("improvement_suggestions") or [],
            "grading_type": "essay",
        })
    return out


def _exam_save_batch(attempt_id: int, items: list[tuple[GradingJob, dict[str, Any]]]) -> int:
    """读-改-写一份考试答卷（BEGIN IMMEDIATE 与教师复核互斥；题态已变的条目不覆盖）

    返回本轮**真正写入**的题数: 0 表示这份答卷没被改动(题态已被别的轮次或教师改过),
    调用方据此决定要不要再收尾结算 —— 空写回不该再发一遍通知。
    """
    with get_connection() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT answers, grading_details, score FROM exam_attempts WHERE id=?",
                           (attempt_id,)).fetchone()
        if not row:
            conn.execute("COMMIT")
            return 0
        graded = _exam_json_dict(row["answers"])
        details = _exam_json_dict(row["grading_details"])
        applied = 0
        for job, res in items:
            one = graded.get(str(job.entry_key))
            if not isinstance(one, dict) or one.get("grading") != "pending":
                continue            # 教师已定分/已被别的轮次写回 → 不覆盖
            applied += 1
            review = bool(res.get("needs_review"))
            one["grading"] = "review" if review else "graded"
            one["score"] = round(float(res.get("score") or 0), 1)
            one["max_score"] = job.max_score
            one["is_correct"] = False if review else bool(res.get("is_correct"))
            one["graded_by"] = str(res.get("graded_by") or "ai")
            if res.get("comment"):
                one["comment"] = str(res["comment"])[:600]
            note = str(res.get("feedback") or res.get("comment") or "")[:600]
            if note:
                one["feedback"] = note
            if review:
                one["needs_review"] = True
            else:
                one.pop("needs_review", None)
            for k in ("key_points_hit", "key_points_missed"):
                if res.get(k):
                    one[k] = res[k]
            if job.mode == "essay":
                one["grading_type"] = "essay"
                one["dimensions"] = res.get("dimensions") or {}
                one["overall_comment"] = str(res.get("overall_comment") or "")[:600]
                one["improvement_suggestions"] = res.get("improvement_suggestions") or []
                if not review:
                    # 多维评分明细同步进 grading_details(学生详情/教师复核都读这里)
                    details[str(job.entry_key)] = {
                        "dimensions": one["dimensions"],
                        "overall_comment": one["overall_comment"],
                        "improvement_suggestions": one["improvement_suggestions"],
                    }
        earned = round(sum(float(v.get("score") or 0) for v in graded.values() if isinstance(v, dict)), 1)
        still = pending_keys(graded)
        # 只有分数真的变了(如教师改判后重批)才放开结算标记; 空写回与同分重批不再重发通知
        score_changed = abs(earned - float(row["score"] or 0)) > 0.01
        conn.execute(
            """UPDATE exam_attempts SET answers=?, score=?, grading_details=?, ai_pending=?,
                      settled_at = CASE WHEN ? THEN '' ELSE settled_at END
               WHERE id=?""",
            (json.dumps(graded, ensure_ascii=False), earned,
             json.dumps(details, ensure_ascii=False) if details else "",
             1 if still else 0, 1 if score_changed else 0, attempt_id),
        )
        conn.execute("COMMIT")
        return applied


def _exam_finalize_if_done(attempt_id: int) -> None:
    """整份答卷判完 → 标明分数出自 AI, 并补做考试收尾(通知/错题本/等级积分/学伴推送)"""
    attempt = execute_query_one("SELECT * FROM exam_attempts WHERE id=?", (attempt_id,))
    if not attempt or attempt.get("ai_pending"):
        return
    if not str(attempt.get("graded_by") or "").strip():
        execute_update("UPDATE exam_attempts SET graded_by='ai', auto_graded=1 WHERE id=?", (attempt_id,))
        attempt["graded_by"] = "ai"
    _settle_exam_attempt(attempt)


register_source(SourceAdapter(
    source="exam",
    label="学习考试",
    fetch_jobs=_exam_fetch_jobs,
    save_batch=_exam_save_batch,
    finalize_if_done=_exam_finalize_if_done,
    grade_single=_exam_grade_single,
))
