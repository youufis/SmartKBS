"""
智能组卷 & Word 导出 API 路由
支持：智能组卷配置、AI 选题、Word 试卷导出、答案卷导出
"""
import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query
from fastapi.responses import StreamingResponse

from backend.api.dependencies import get_current_user
from backend.auth import is_admin
from backend.logger import logger
from backend.question_db import (
    execute_query,
    execute_query_one,
    execute_insert,
    execute_update,
)
from backend import exam_scoring
# 组卷选题引擎（题型配额 + 难度配比 + 分层召回 + AI 择优）已抽成共享模块，
# 三个入口（智能组卷 / 管理题目-自动选题 / 管理题目-AI 生成）共用这一份实现。
from backend.paper_compose import (
    ComposeRequest,
    ComposeResponse,
    get_question_pool,
    select_questions_by_ai,
    select_questions_by_rules,
    validate_compose_config,
)

router = APIRouter()


# ═══════════════════════════════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════════════════════════════

def _can_manage_exam(username: str, exam: dict[str, Any] | None = None) -> bool:
    """检查是否有管理考试的权限"""
    if is_admin(username):
        return True
    if exam and exam.get("creator_username") == username:
        return True
    return False


def exam_scoring_guard(exam: dict[str, Any], action: str) -> dict[str, Any]:
    """在途答卷守卫（与 exam_router._require_paper_editable 同一口径，单独导出给组卷用）。"""
    live = exam_scoring.live_attempts(exam)
    if live:
        raise HTTPException(
            status_code=409,
            detail=f"该考试有 {len(live)} 份答卷正在作答中，{action}会影响他们的判分；"
                   f"请等学生交卷或先结束考试后再改",
        )
    return {"submitted_attempts": exam_scoring.submitted_count(int(exam["id"]))}

# API 端点
# ═══════════════════════════════════════════════════════════════

@router.post("/{exam_id}/compose", summary="智能组卷")
async def compose_exam_paper(exam_id: int, req: ComposeRequest, request: Request):
    """智能组卷：根据题型/难度/知识点配置，从题库智能选题并添加到考试"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")

    # ── 校验考试 ──
    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")
    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权操作此考试")

    # ── 有人在作答时不许动这张卷子（与「管理题目」六个端点同一道闸）──
    impact = exam_scoring_guard(exam, "智能组卷")

    # ── 校验配置 ──
    total_score, err_msg = validate_compose_config(req)
    if err_msg:
        raise HTTPException(status_code=400, detail=err_msg)

    # ── 确定总分 ──
    if req.total_score and req.total_score > 0:
        final_total_score = req.total_score
    else:
        final_total_score = round(total_score, 1)

    # ── 获取候选题目 ──
    existing_qs = execute_query(
        "SELECT question_id FROM exam_questions WHERE exam_id = ?", (exam_id,)
    )
    existing_ids = {q["question_id"] for q in existing_qs}

    # 如果不替换已有题目，排除它们
    exclude_ids = set() if req.replace_existing else existing_ids

    pool = get_question_pool(
        subject=exam["subject"],
        exclude_ids=exclude_ids,
        knowledge_points=req.knowledge_points if req.knowledge_points else None,
    )

    if not pool:
        raise HTTPException(status_code=400, detail="题库中没有符合条件的题目，请先导入试题或调整筛选条件")

    # ── 选题 ──
    if req.use_ai and pool:
        selected_questions, reason = await select_questions_by_ai(
            pool=pool,
            type_configs=req.type_configs,
            easy_ratio=req.difficulty_easy_ratio,
            medium_ratio=req.difficulty_medium_ratio,
            hard_ratio=req.difficulty_hard_ratio,
            knowledge_points=req.knowledge_points,
            exam_info={**exam, "target_grade": req.target_grade},
            username=username,
        )
    else:
        selected_questions, reason = select_questions_by_rules(
            pool=pool,
            type_configs=req.type_configs,
            easy_ratio=req.difficulty_easy_ratio,
            medium_ratio=req.difficulty_medium_ratio,
            hard_ratio=req.difficulty_hard_ratio,
        )

    if not selected_questions:
        raise HTTPException(status_code=400, detail=reason or "未能选出合适的题目，请调整配置后重试")

    # ── 如果替换已有题目，先删除旧的 ──
    if req.replace_existing and existing_ids:
        execute_update("DELETE FROM exam_questions WHERE exam_id = ?", (exam_id,))
        logger.info(f"智能组卷：已清除考试 {exam_id} 的 {len(existing_ids)} 道旧题目")

    # ── 添加题目到考试 ──
    max_order_row = execute_query_one(
        "SELECT COALESCE(MAX(sort_order), -1) as max_order FROM exam_questions WHERE exam_id = ?",
        (exam_id,),
    )
    next_order = (max_order_row["max_order"] + 1) if max_order_row else 0

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    added = 0

    # 构建 type -> score_per_question 映射
    type_score_map = {tc.type: tc.score_per_question for tc in req.type_configs}

    for i, q in enumerate(selected_questions):
        qid = q["id"]
        # 检查是否已存在（防止因 replace_existing 关闭时重复添加）
        existing = execute_query_one(
            "SELECT id FROM exam_questions WHERE exam_id = ? AND question_id = ?",
            (exam_id, qid),
        )
        if existing:
            continue

        # 确定分值
        score = type_score_map.get(q["type"], 5.0)
        execute_insert(
            """INSERT INTO exam_questions (exam_id, question_id, sort_order, score)
               VALUES (?, ?, ?, ?)""",
            (exam_id, qid, next_order + i, score),
        )
        added += 1

    # ── 更新考试信息 ──
    update_fields = ["updated_at = ?"]
    update_params: list[Any] = [now]

    # 如果提供了新信息，更新考试元数据
    if req.target_grade:
        pass  # grade 字段在 exams 表中可能没有，暂不更新

    # 总分同步：实际入卷分数合计与设定总分不一致时以实际为准（与考试自动选题同一口径）
    _sum_row = execute_query_one(
        "SELECT COALESCE(SUM(score), 0) AS s FROM exam_questions WHERE exam_id = ?", (exam_id,))
    _actual_total = round(float(_sum_row["s"] if _sum_row else 0), 2)
    if _actual_total > 0 and abs(_actual_total - float(exam["total_score"] or 0)) > 0.05:
        update_fields.append("total_score = ?")
        update_params.append(_actual_total)
        logger.info(f"智能组卷同步总分: {exam['total_score']} → {_actual_total}")
    update_params.append(exam_id)
    execute_update(
        f"UPDATE exams SET {', '.join(update_fields)} WHERE id = ?",
        tuple(update_params),
    )

    # ── 统计 ──
    type_stats: dict[str, int] = {}
    difficulty_stats: dict[str, int] = {"easy": 0, "medium": 0, "hard": 0}
    for q in selected_questions:
        q_type = q["type"]
        type_stats[q_type] = type_stats.get(q_type, 0) + 1
        q_diff = q["difficulty"]
        if q_diff in difficulty_stats:
            difficulty_stats[q_diff] += 1

    logger.info(
        f"智能组卷完成: 考试{exam_id} by {username}, "
        f"选题{added}道, 题型={type_stats}, 难度={difficulty_stats}"
    )

    return ComposeResponse(
        message=f"智能组卷完成，共添加 {added} 道试题",
        added=added,
        total_questions=len(selected_questions),
        type_stats=type_stats,
        difficulty_stats=difficulty_stats,
        total_score=final_total_score,
        reason=reason,
        submitted_attempts=int(impact.get("submitted_attempts") or 0),
    )


@router.get("/{exam_id}/export-paper", summary="导出 Word 试卷")
async def export_exam_paper(
    exam_id: int,
    request: Request,
    school_name: str = Query("", description="学校名称"),
    semester: str = Query("", description="学年学期"),
):
    """导出排版规范的 Word 试卷文档（学生用）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权操作此考试")

    # 获取题目列表
    questions = execute_query(
        """SELECT q.id, q.type, q.question_text, q.options, q.correct_answer,
                  q.explanation, q.difficulty, q.knowledge_points,
                  q.svg_content, q.has_svg, q.media_files,
                  eq.score as question_score
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'
           ORDER BY eq.sort_order, eq.id""",
        (exam_id,),
    )

    if not questions:
        raise HTTPException(status_code=400, detail="考试中没有任何试题，请先添加试题")

    # 解析 options / media_files JSON
    for q in questions:
        if q.get("options") and isinstance(q["options"], str):
            try:
                q["options"] = json.loads(q["options"])
            except (json.JSONDecodeError, TypeError):
                q["options"] = None
        if q.get("media_files") and isinstance(q["media_files"], str):
            try:
                q["media_files"] = json.loads(q["media_files"])
            except (json.JSONDecodeError, TypeError):
                pass

    # 生成 Word 文档
    from backend.paper_generator import generate_exam_paper

    exam_info = dict(exam)
    if school_name:
        exam_info["school_name"] = school_name

    try:
        buf = generate_exam_paper(
            exam_info=exam_info,
            questions=questions,
            school_name=school_name or "",
            semester=semester or "",
            show_answer_key=False,
        )
    except Exception as e:
        logger.error(f"生成 Word 试卷失败: {e}")
        raise HTTPException(status_code=500, detail=f"生成 Word 文档失败: {str(e)}")

    filename = _safe_filename(f"{exam['title']}_试卷.docx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@router.get("/{exam_id}/export-answer-key", summary="导出 Word 答案卷")
async def export_exam_answer_key(
    exam_id: int,
    request: Request,
    school_name: str = Query("", description="学校名称"),
    semester: str = Query("", description="学年学期"),
):
    """导出排版规范的 Word 答案卷（教师用，含答案和解析）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权操作此考试")

    questions = execute_query(
        """SELECT q.id, q.type, q.question_text, q.options, q.correct_answer,
                  q.explanation, q.difficulty, q.knowledge_points,
                  q.svg_content, q.has_svg, q.media_files,
                  eq.score as question_score
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'
           ORDER BY eq.sort_order, eq.id""",
        (exam_id,),
    )

    if not questions:
        raise HTTPException(status_code=400, detail="考试中没有任何试题")

    for q in questions:
        if q.get("options") and isinstance(q["options"], str):
            try:
                q["options"] = json.loads(q["options"])
            except (json.JSONDecodeError, TypeError):
                q["options"] = None
        if q.get("media_files") and isinstance(q["media_files"], str):
            try:
                q["media_files"] = json.loads(q["media_files"])
            except (json.JSONDecodeError, TypeError):
                pass

    from backend.paper_generator import generate_exam_paper

    exam_info = dict(exam)
    try:
        buf = generate_exam_paper(
            exam_info=exam_info,
            questions=questions,
            school_name=school_name or "",
            semester=semester or "",
            show_answer_key=True,
        )
    except Exception as e:
        logger.error(f"生成 Word 答案卷失败: {e}")
        raise HTTPException(status_code=500, detail=f"生成 Word 文档失败: {str(e)}")

    filename = _safe_filename(f"{exam['title']}_答案卷.docx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@router.get("/{exam_id}/export-answer-sheet", summary="导出 Word 答题卡")
async def export_exam_answer_sheet(
    exam_id: int,
    request: Request,
):
    """导出答题卡（选择题填涂区域 + 简答题作答区）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    if not _can_manage_exam(username, exam):
        raise HTTPException(status_code=403, detail="无权操作此考试")

    questions = execute_query(
        """SELECT q.id, q.type, q.question_text, q.options,
                  q.svg_content, q.has_svg, q.media_files,
                  eq.score as question_score
           FROM exam_questions eq
           JOIN question_bank q ON q.id = eq.question_id
           WHERE eq.exam_id = ? AND q.status = 'active'
           ORDER BY eq.sort_order, eq.id""",
        (exam_id,),
    )

    if not questions:
        raise HTTPException(status_code=400, detail="考试中没有任何试题")

    from backend.paper_generator import generate_answer_sheet

    try:
        buf = generate_answer_sheet(
            exam_info=dict(exam),
            questions=questions,
        )
    except Exception as e:
        logger.error(f"生成答题卡失败: {e}")
        raise HTTPException(status_code=500, detail=f"生成答题卡失败: {str(e)}")

    filename = _safe_filename(f"{exam['title']}_答题卡.docx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@router.get("/knowledge-points/list", summary="获取所有知识点标签")
async def list_knowledge_points(request: Request):
    """获取题库中所有知识点标签（供组卷配置选择）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    rows = execute_query(
        """SELECT DISTINCT knowledge_points FROM question_bank
           WHERE status = 'active' AND knowledge_points IS NOT NULL AND knowledge_points != ''"""
    )

    # 提取所有知识点（逗号/分号/顿号分隔）
    all_kps: set[str] = set()
    for row in rows:
        kp_text = row["knowledge_points"]
        if kp_text:
            # 尝试多种分隔符
            parts = kp_text.replace("；", ",").replace("、", ",").replace("，", ",").split(",")
            for part in parts:
                p = part.strip()
                if p and len(p) <= 50:  # 过滤掉过长的"知识点"
                    all_kps.add(p)

    sorted_kps = sorted(all_kps)
    return {
        "knowledge_points": sorted_kps,
        "total": len(sorted_kps),
    }


def _safe_filename(name: str) -> str:
    """生成安全的文件名（URL 编码）"""
    from urllib.parse import quote
    return quote(name, safe='')


@router.get("/compose-config/defaults", summary="获取默认组卷配置")
async def get_default_compose_config(
    request: Request,
    exam_id: int = Query(..., description="考试ID"),
):
    """根据考试科目和题库情况，返回推荐组卷配置"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    exam = execute_query_one("SELECT * FROM exams WHERE id = ?", (exam_id,))
    if not exam:
        raise HTTPException(status_code=404, detail="考试不存在")

    subject = exam["subject"]

    # 统计题库中各题型题数
    stats = execute_query(
        """SELECT type, difficulty, COUNT(*) as cnt
           FROM question_bank
           WHERE status = 'active' AND subject = ?
           GROUP BY type, difficulty""",
        (subject,),
    )

    # 获取知识点
    kp_rows = execute_query(
        """SELECT DISTINCT knowledge_points FROM question_bank
           WHERE status = 'active' AND subject = ? AND knowledge_points IS NOT NULL AND knowledge_points != ''""",
        (subject,),
    )
    all_kps: set[str] = set()
    for row in kp_rows:
        for sep in ["；", "、", "，", ","]:
            if sep in row["knowledge_points"]:
                for p in row["knowledge_points"].split(sep):
                    p = p.strip()
                    if p and len(p) <= 50:
                        all_kps.add(p)
                break
        else:
            p = row["knowledge_points"].strip()
            if p and len(p) <= 50:
                all_kps.add(p)

    return {
        "subject": subject,
        "question_stats": stats,
        "available_knowledge_points": sorted(all_kps),
        "default_config": {
            "type_configs": [
                {"type": "single", "count": 10, "score_per_question": 3},
                {"type": "multiple", "count": 5, "score_per_question": 4},
                {"type": "true_false", "count": 5, "score_per_question": 2},
                {"type": "short", "count": 3, "score_per_question": 10},
            ],
            "difficulty_easy_ratio": 20,
            "difficulty_medium_ratio": 50,
            "difficulty_hard_ratio": 30,
        },
    }
