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
    execute_update,
)
from backend import exam_scoring
# 组卷选题引擎（题型配额 + 难度配比 + 分层召回 + AI 择优）已抽成共享模块，
# 三个入口（智能组卷 / 管理题目-自动选题 / 管理题目-AI 生成）共用这一份实现。
from backend.question_select import family_members, split_tags, subject_family
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
    config_total, err_msg = validate_compose_config(req)
    if err_msg:
        raise HTTPException(status_code=400, detail=err_msg)

    # ── 确定目标总分 ──
    # 旧写法把"老师填的总分"和"配置算出的合计"当成两个数各用一半：响应回前者、
    # 写库用后者，试卷上印的又是第三个数（实测 响应 999 / 库里 60 / 卷面 60）。
    # 现在只有一个事实源：目标总分决定一切，每题分值按配置比例缩放到位。
    target_total = float(req.total_score or 0) or float(exam["total_score"] or 0) \
        or round(float(config_total), 1)
    if target_total <= 0:
        raise HTTPException(status_code=400, detail="目标总分必须大于 0，请先设定总分")

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
    # 配置里的"每题分值"当作**权重**先写进去（体现"多选比判断贵"的意图），
    # 再交给 rebalance_paper 按权重把整份卷子配平到目标总分：
    #   · 替换模式 → 新题按比例精确凑成目标总分；
    #   · 追加模式 → 存量题保持原有相对比例，新题按权重挤进同一量纲，
    #                目标总分不动（旧写法是"新题按配置分值直接叠上去"，
    #                实测把总分从 60 顶到 160，而及格线仍是 60）。
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    type_score_map = {tc.type: tc.score_per_question for tc in req.type_configs}
    inserted = exam_scoring.insert_paper_questions(
        exam_id,
        [(int(q["id"]), float(type_score_map.get(q["type"], 5.0) or 5.0))
         for q in selected_questions],
    )
    added = len(inserted)
    if not inserted:
        raise HTTPException(status_code=400, detail="所选试题都已在试卷中，请调整配置或改用替换模式")
    gap = exam_scoring.rebalance_paper(exam_id, target_total)

    # ── 更新考试信息 ──
    # 总分不再由"实算合计"反向覆盖：配平已经保证 Σ == target_total，
    # 总分只能由老师显式设定（编辑考试 / 本向导的"设定总分"）。
    _actual_total = exam_scoring.paper_total(exam_id)
    if abs(_actual_total - target_total) > 0.05:
        logger.warning(f"智能组卷配平后卷面 {_actual_total} 仍不等于目标 {target_total}，请检查")
    execute_update("UPDATE exams SET total_score = ?, updated_at = ? WHERE id = ?",
                   (round(target_total, 1), now, exam_id))

    # ── 统计 ──
    type_stats: dict[str, int] = {}
    difficulty_stats: dict[str, int] = {"easy": 0, "medium": 0, "hard": 0}
    for q in selected_questions:
        q_type = q["type"]
        type_stats[q_type] = type_stats.get(q_type, 0) + 1
        q_diff = q["difficulty"]
        if q_diff in difficulty_stats:
            difficulty_stats[q_diff] += 1

    # 配平后各题型每题的真实分值（让界面显示"实际落到卷面上的数"，而不是配置值）
    type_scores = {
        str(r["type"]): round(float(r["s"]), 1) for r in execute_query(
            """SELECT q.type, MAX(eq.score) AS s FROM exam_questions eq
               JOIN question_bank q ON q.id = eq.question_id
               WHERE eq.exam_id = ? AND eq.question_id IN (%s)
               GROUP BY q.type""" % ",".join("?" * len(inserted)),
            (exam_id, *inserted)) or []
    }

    warnings: list[str] = []
    if abs(gap) > 0.05:
        warnings.append(f"卷面合计 {round(_actual_total, 1)} 分与目标总分 {round(target_total, 1)} 分不一致")
    if req.replace_existing and existing_ids:
        warnings.append(f"已删除原有 {len(existing_ids)} 道题目")
    _pass = float(exam["pass_score"] or 0)
    if _pass > target_total:
        warnings.append(f"及格分 {_pass} 高于新的目标总分 {round(target_total, 1)}，没人能及格，"
                        f"请到「编辑考试」调整及格分")
    elif abs(float(exam["total_score"] or 0) - target_total) > 0.05 and _pass > 0:
        warnings.append(f"目标总分已变为 {round(target_total, 1)}，及格分 {_pass} 相当于 "
                        f"{round(_pass / target_total * 100)}%，请确认是否合适")

    parts = [f"智能组卷完成，共添加 {added} 道试题，卷面合计 {round(_actual_total, 1)} 分"]
    if abs(float(exam["total_score"] or 0) - target_total) > 0.05:
        parts.append(f"目标总分 {exam['total_score']} → {round(target_total, 1)}")
    if abs(config_total - target_total) > 0.05:
        parts.append(f"配置的每题分值已按比例配平（配置合计 {round(config_total, 1)}）")
    if warnings:
        parts.append("；".join(warnings))

    logger.info(
        f"智能组卷完成: 考试{exam_id} by {username}, 选题{added}道, "
        f"目标总分={round(target_total, 1)}, 题型={type_stats}, 难度={difficulty_stats}"
    )

    return ComposeResponse(
        message="，".join(parts),
        added=added,
        total_questions=len(selected_questions),
        type_stats=type_stats,
        difficulty_stats=difficulty_stats,
        total_score=round(_actual_total, 1),
        reason=reason,
        submitted_attempts=int(impact.get("submitted_attempts") or 0),
        score_gap=gap,
        config_total=round(float(config_total), 1),
        target_total=round(target_total, 1),
        type_scores=type_scores,
        warnings=warnings,
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
async def list_knowledge_points(request: Request, subject: str = Query("", description="按学科过滤（含学科族归一）")):
    """获取题库中的知识点标签（供组卷配置选择）

    旧写法全库无过滤 + 自己一套分隔符逻辑：通用技术/生物/人工智能的标签会混进
    信息科技的考卷配置里，且与 defaults 端点切出来的结果不一致。现在两处都走
    question_select.split_tags，并支持按学科（含学科族）过滤。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    where = "status = 'active' AND knowledge_points IS NOT NULL AND knowledge_points != ''"
    params: tuple = ()
    writes = family_members(subject) if subject else []
    if writes:
        where += " AND subject IN (%s)" % ",".join("?" * len(writes))
        params = tuple(writes)
    rows = execute_query(
        f"SELECT knowledge_points, COUNT(*) AS n FROM question_bank WHERE {where}"
        " GROUP BY knowledge_points", params) or []

    counts: dict[str, int] = {}
    for row in rows:
        for tag in split_tags(row["knowledge_points"]):
            tag = tag.strip()
            if tag and len(tag) <= 50:          # 过长的整段题干不是知识点标签
                counts[tag] = counts.get(tag, 0) + int(row["n"])

    sorted_kps = [k for k, _n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
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

    subject = str(exam.get("subject") or "")

    # 供给量必须与组卷引擎**同一个口径**：走 get_question_pool（学科族归一 + 分层召回
    # + 近重复折叠 + 排除已在卷子里的题）。旧写法自己写 SQL 且 subject 精确等值 ——
    # 实测对"信息科技"的考试报 96 道，而组卷实际能召回 248 道（信息技术 154 +
    # 信息科技 94），老师照这个数配题量只会得出"题库不足"的错误结论。
    existing_ids = {int(r["question_id"]) for r in execute_query(
        "SELECT question_id FROM exam_questions WHERE exam_id = ?", (exam_id,)) or []}
    pool = get_question_pool(
        subject=subject, exclude_ids=existing_ids,
        types=exam_scoring.GRADABLE_TYPES, seed="defaults",
    )

    stats: list[dict[str, Any]] = []
    by_type: dict[str, int] = {}
    by_difficulty: dict[str, int] = {"easy": 0, "medium": 0, "hard": 0}
    for qtype in exam_scoring.GRADABLE_TYPES:
        rows_t = [q for q in pool if str(q.get("type") or "") == qtype]
        if not rows_t:
            continue
        by_type[qtype] = len(rows_t)
        for d in ("easy", "medium", "hard"):
            n = sum(1 for q in rows_t if str(q.get("difficulty") or "") == d)
            if n:
                stats.append({"type": qtype, "difficulty": d, "cnt": n})
                by_difficulty[d] += n

    kp_counts: dict[str, int] = {}
    for q in pool:
        for tag in split_tags(q.get("knowledge_points")):
            tag = tag.strip()
            if tag and len(tag) <= 50:
                kp_counts[tag] = kp_counts.get(tag, 0) + 1
    # 按"本学科有几道题挂着这个标签"排序，而不是字母序：排在前面的才是真出得了卷的知识点
    ranked_kps = [k for k, _n in sorted(kp_counts.items(), key=lambda kv: (-kv[1], kv[0]))]

    return {
        "subject": subject,
        "subject_family": subject_family(subject),
        "subject_writes": family_members(subject),        # 让老师看见"信息技术≡信息科技"
        "pool_size": len(pool),
        "already_in_paper": len(existing_ids),
        "available_by_type": by_type,
        "available_by_difficulty": by_difficulty,
        "question_stats": stats,
        "available_knowledge_points": ranked_kps[:80],
        "knowledge_point_total": len(ranked_kps),
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
