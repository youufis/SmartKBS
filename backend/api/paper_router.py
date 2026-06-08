"""
智能组卷 & Word 导出 API 路由
支持：智能组卷配置、AI 选题、Word 试卷导出、答案卷导出
"""
import json
import math
import random
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.auth import is_admin
from backend.logger import logger
from backend.question_db import (
    execute_query,
    execute_query_one,
    execute_insert,
    execute_update,
)
from backend.database import execute_query as user_query

router = APIRouter()


# ═══════════════════════════════════════════════════════════════
# 请求/响应模型
# ═══════════════════════════════════════════════════════════════

class TypeConfigItem(BaseModel):
    """题型配置项"""
    type: str                          # single | multiple | true_false | short
    count: int = 0                     # 题数
    score_per_question: float = 5.0    # 每题分值


class ComposeRequest(BaseModel):
    """智能组卷请求"""
    school_name: str = ""              # 学校名称
    semester: str = ""                 # 学年学期
    target_grade: str = ""             # 考试年级
    type_configs: list[TypeConfigItem] = []  # 题型配置列表
    difficulty_easy_ratio: int = 20    # 简单题占比 %
    difficulty_medium_ratio: int = 50  # 中等题占比 %
    difficulty_hard_ratio: int = 30    # 困难题占比 %
    knowledge_points: list[str] = []   # 知识点范围（留空=全部）
    total_score: float | None = None   # 总分（如不传则根据配置自动计算）
    replace_existing: bool = False     # 是否替换考试中已有题目
    use_ai: bool = True                # 是否使用 AI 智能选择


class ComposeResponse(BaseModel):
    """组卷响应"""
    message: str
    added: int
    total_questions: int
    type_stats: dict[str, int]
    difficulty_stats: dict[str, int]
    total_score: float
    reason: str = ""


# ═══════════════════════════════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════════════════════════════

TYPE_LABELS = {
    "single": "单选题",
    "multiple": "多选题",
    "true_false": "判断题",
    "short": "简答题",
}


def _can_manage_exam(username: str, exam: dict | None = None) -> bool:
    """检查是否有管理考试的权限"""
    if is_admin(username):
        return True
    if exam and exam.get("creator_username") == username:
        return True
    return False


def _get_question_pool(
    subject: str,
    exclude_ids: set[int],
    knowledge_points: list[str] | None = None,
) -> list[dict]:
    """获取候选题目池

    Args:
        subject: 科目
        exclude_ids: 需要排除的题目 ID 集合
        knowledge_points: 知识点列表（为空则全部）

    Returns:
        候选题目列表
    """
    conditions = ["q.status = 'active'", "q.subject = ?"]
    params: list[Any] = [subject]

    if knowledge_points:
        kp_conditions = []
        for kp in knowledge_points:
            kp_conditions.append("q.knowledge_points LIKE ?")
            params.append(f"%{kp}%")
        if kp_conditions:
            conditions.append(f"({' OR '.join(kp_conditions)})")

    if exclude_ids:
        placeholders = ",".join("?" * len(exclude_ids))
        conditions.append(f"q.id NOT IN ({placeholders})")
        params.extend(exclude_ids)

    where = " AND ".join(conditions)

    rows = execute_query(
        f"""SELECT q.id, q.type, q.question_text, q.options, q.correct_answer,
                   q.explanation, q.difficulty, q.knowledge_points, q.subject
            FROM question_bank q
            WHERE {where}
            ORDER BY q.difficulty, q.id""",
        tuple(params),
    )

    # 解析 options JSON
    for row in rows:
        if row.get("options") and isinstance(row["options"], str):
            try:
                row["options"] = json.loads(row["options"])
            except (json.JSONDecodeError, TypeError):
                row["options"] = None

    return rows


def _validate_compose_config(req: ComposeRequest) -> tuple[float, str]:
    """验证组卷配置，返回 (计算总分, 错误信息)"""
    if not req.type_configs:
        return 0, "请配置至少一种题型"

    total = 0.0
    for tc in req.type_configs:
        if tc.count < 0:
            return 0, f"题型 {TYPE_LABELS.get(tc.type, tc.type)} 的题数不能为负"
        if tc.score_per_question <= 0:
            return 0, f"题型 {TYPE_LABELS.get(tc.type, tc.type)} 的分值必须大于 0"
        total += tc.count * tc.score_per_question

    if total <= 0:
        return 0, "试卷总分必须大于 0"

    total_ratio = req.difficulty_easy_ratio + req.difficulty_medium_ratio + req.difficulty_hard_ratio
    if total_ratio != 100:
        return 0, "难度分布比例之和必须为 100"

    return total, ""


def _select_questions_by_rules(
    pool: list[dict],
    type_configs: list[TypeConfigItem],
    easy_ratio: int,
    medium_ratio: int,
    hard_ratio: int,
) -> tuple[list[dict], str]:
    """基于规则从候选池中选题（非 AI 模式）

    Returns:
        (选中的题目列表, 说明文字)
    """
    selected: list[dict] = []
    reason_parts = []

    # 按题型分组
    type_pool: dict[str, list[dict]] = {}
    for q in pool:
        q_type = q["type"]
        if q_type not in type_pool:
            type_pool[q_type] = []
        type_pool[q_type].append(q)

    # 按题型配置选题
    for tc in type_configs:
        q_type = tc.type
        target_count = tc.count
        if target_count == 0:
            continue

        candidates = type_pool.get(q_type, [])
        if not candidates:
            reason_parts.append(f"{TYPE_LABELS.get(q_type, q_type)}：题库中无候选题目")
            continue

        if len(candidates) < target_count:
            reason_parts.append(
                f"{TYPE_LABELS.get(q_type, q_type)}：需要{target_count}题，候选仅{len(candidates)}题，已全部选取"
            )
            selected.extend(candidates)
            continue

        # 按难度比例从候选池中分层抽样
        easy_pool = [q for q in candidates if q["difficulty"] == "easy"]
        medium_pool = [q for q in candidates if q["difficulty"] == "medium"]
        hard_pool = [q for q in candidates if q["difficulty"] == "hard"]

        # 计算每种难度应选题数
        target_easy = max(1, round(target_count * easy_ratio / 100))
        target_medium = max(1, round(target_count * medium_ratio / 100))
        target_hard = target_count - target_easy - target_medium

        # 调整：如果某种难度的题不够，均分给其他难度
        chosen: list[dict] = []

        def _pick_from(pool_list: list[dict], n: int) -> list[dict]:
            if not pool_list or n <= 0:
                return []
            return random.sample(pool_list, min(n, len(pool_list)))

        chosen.extend(_pick_from(easy_pool, target_easy))
        chosen.extend(_pick_from(medium_pool, target_medium))
        chosen.extend(_pick_from(hard_pool, target_hard))

        # 如果还不够，从剩余中随机补足
        if len(chosen) < target_count:
            remaining = [q for q in candidates if q not in chosen]
            additional = _pick_from(remaining, target_count - len(chosen))
            chosen.extend(additional)

        # 打乱顺序
        random.shuffle(chosen)
        selected.extend(chosen)

    if not selected:
        return [], "未能从题库中选出任何题目，请检查题库是否为空或筛选条件是否过于严格"

    # 统计
    type_stats_str = ", ".join(
        f"{TYPE_LABELS.get(tc.type, tc.type)}{tc.count}题"
        for tc in type_configs if tc.count > 0
    )
    reason_parts.insert(0, f"共选题 {len(selected)} 道（{type_stats_str}）")
    reason = "；".join(reason_parts)

    return selected, reason


def _select_questions_by_ai(
    pool: list[dict],
    type_configs: list[TypeConfigItem],
    easy_ratio: int,
    medium_ratio: int,
    hard_ratio: int,
    knowledge_points: list[str],
    exam_info: dict,
    username: str,
) -> tuple[list[dict], str]:
    """使用 AI 从候选池中智能选题"""
    from backend.api.chat_router import get_api_keys
    from backend.api.ai_service import call_ai_async
    from backend.prompts.paper import AI_PAPER_COMPOSE_PROMPT

    keys = get_api_keys(username)
    api_key = keys[0] if keys and keys[0] else ""
    if not api_key:
        logger.warning("AI 组卷：未配置 API Key，回退到规则选题")
        return _select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio)

    # 构建题型配置文本
    type_config_lines = []
    for tc in type_configs:
        if tc.count > 0:
            label = TYPE_LABELS.get(tc.type, tc.type)
            type_config_lines.append(f"- {label}：{tc.count} 题，每题 {tc.score_per_question:.0f} 分")
    type_config_text = "\n".join(type_config_lines)

    # 构建候选题目文本
    type_map = {"single": "单选题", "multiple": "多选题", "true_false": "判断题", "short": "简答题"}
    diff_map = {"easy": "简单", "medium": "中等", "hard": "困难"}

    candidate_lines = []
    for i, q in enumerate(pool, 1):
        q_type = type_map.get(q["type"], q["type"])
        q_diff = diff_map.get(q["difficulty"], q["difficulty"])
        q_text = q["question_text"][:100]
        q_kp = q.get("knowledge_points", "") or "无"
        # 为每道题加一个预设分值
        matching_config = next((tc for tc in type_configs if tc.type == q["type"]), None)
        q_score = matching_config.score_per_question if matching_config else 5
        candidate_lines.append(
            f"{i}. [ID:{q['id']}] [{q_type}][{q_diff}] {q_text} (知识点: {q_kp}, 预设分值: {q_score:.0f}分)"
        )
    candidate_text = "\n".join(candidate_lines)

    knowledge_focus = "、".join(knowledge_points) if knowledge_points else "无特定要求，覆盖广泛"

    def _safe(s):
        return str(s).replace('{', '{{').replace('}', '}}')

    prompt = AI_PAPER_COMPOSE_PROMPT.format(
        subject=_safe(exam_info.get("subject", "")),
        exam_title=_safe(exam_info.get("title", "")),
        total_score=_safe(exam_info.get("total_score", 100)),
        grade=_safe(exam_info.get("target_grade", "")),
        type_config=_safe(type_config_text),
        easy_ratio=easy_ratio,
        medium_ratio=medium_ratio,
        hard_ratio=hard_ratio,
        knowledge_focus=_safe(knowledge_focus),
        candidate_questions=_safe(candidate_text),
    )

    try:
        ai_response = call_ai_async(prompt, api_key)
        # 由于 call_ai_async 可能是同步或异步，这里处理兼容
        if hasattr(ai_response, '__await__'):
            import asyncio
            ai_response = asyncio.run(ai_response) if hasattr(asyncio, 'run') else ai_response

        logger.info(f"AI 组卷返回: {str(ai_response)[:300]}")
    except Exception as e:
        logger.error(f"AI 组卷调用失败: {e}")
        # 回退到规则选题
        logger.warning("AI 组卷失败，回退到规则选题")
        return _select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio)

    # 解析 AI 返回的 JSON
    import re
    text = str(ai_response).strip()
    json_match = re.search(r'\{[^}]+\}', text)
    if not json_match:
        logger.warning("AI 组卷返回格式异常，回退到规则选题")
        return _select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio)

    try:
        result = json.loads(json_match.group())
        selected_ids = result.get("selected_ids", [])
        reason = result.get("reason", "AI 智能组卷")
    except (json.JSONDecodeError, TypeError):
        logger.warning("AI 组卷 JSON 解析失败，回退到规则选题")
        return _select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio)

    if not selected_ids:
        logger.warning("AI 未选择任何题目，回退到规则选题")
        return _select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio)

    # 匹配选中的题目
    pool_map = {q["id"]: q for q in pool}
    selected = []
    for sid in selected_ids:
        if sid in pool_map:
            selected.append(pool_map[sid])

    if not selected:
        return _select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio)

    return selected, reason


# ═══════════════════════════════════════════════════════════════
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

    # ── 校验配置 ──
    total_score, err_msg = _validate_compose_config(req)
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

    pool = _get_question_pool(
        subject=exam["subject"],
        exclude_ids=exclude_ids,
        knowledge_points=req.knowledge_points if req.knowledge_points else None,
    )

    if not pool:
        raise HTTPException(status_code=400, detail="题库中没有符合条件的题目，请先导入试题或调整筛选条件")

    # ── 选题 ──
    if req.use_ai and pool:
        selected_questions, reason = _select_questions_by_ai(
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
        selected_questions, reason = _select_questions_by_rules(
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
