"""
AI 教学资源推荐 API 路由
根据知识点自动推荐关联的教学资源（HTML、考试、讨论等）
"""
import json
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.database import execute_query_dict as execute_query
from backend.question_db import execute_query as q_execute_query
from backend.api.chat_router import get_api_keys
from backend.prompts import apply_skills
from backend.api.ai_service import call_ai_async
from backend.utils import extract_json_from_text
from backend.logger import logger

router = APIRouter()

RESOURCE_TYPE_LABELS = {
    "html": "HTML 课件",
    "exam": "考试试卷",
    "discussion": "课堂讨论",
    "interaction_quiz": "随堂测验",
}

RESOURCE_TYPE_ICONS = {
    "html": "📄",
    "exam": "📝",
    "discussion": "💬",
    "interaction_quiz": "❓",
}


@router.post("/knowledge-point/{kp_id}")
async def recommend_resources(kp_id: int, request: Request):
    """[教师] AI 推荐教学资源给指定知识点"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可使用推荐")

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请在 AI 助手中配置")

    # 1. 获取知识点信息
    kp = execute_query(
        """SELECT kp.*, ch.name as chapter_name, c.name as course_name
           FROM knowledge_points kp
           JOIN chapters ch ON ch.id = kp.chapter_id
           JOIN courses c ON c.id = ch.course_id
           WHERE kp.id=?""",
        (kp_id,),
    )
    if not kp:
        raise HTTPException(status_code=404, detail="知识点不存在")
    kp = kp[0]

    # 2. 收集可推荐的候选资源（教师自己的 + 已公开的）
    candidates = []

    # 2a. HTML 资源
    html_rows = execute_query(
        """SELECT id, file_name as title, 'html' as type FROM shared_resources
           WHERE resource_type='html' AND owner_username=?
           ORDER BY id DESC LIMIT 100""",
        (username,),
    )
    for r in html_rows:
        candidates.append({"id": r["id"], "title": r["title"], "type": "html"})

    # 2b. 考试试卷
    exam_rows = q_execute_query(
        "SELECT id, title, 'exam' as type FROM exams WHERE status='published' AND creator_username=? ORDER BY id DESC LIMIT 50",
        (username,),
    )
    for r in exam_rows:
        candidates.append({"id": r["id"], "title": r["title"], "type": "exam"})

    # 2c. 讨论
    disc_rows = execute_query(
        "SELECT id, title, 'discussion' as type FROM discussions WHERE creator_username=? ORDER BY id DESC LIMIT 50",
        (username,),
    )
    for r in disc_rows:
        candidates.append({"id": r["id"], "title": r["title"], "type": "discussion"})

    # 2d. 随堂测验
    quiz_rows = execute_query(
        "SELECT id, title, 'interaction_quiz' as type FROM interaction_quizzes WHERE creator_username=? ORDER BY id DESC LIMIT 50",
        (username,),
    )
    for r in quiz_rows:
        candidates.append({"id": r["id"], "title": r["title"], "type": "interaction_quiz"})

    # 2e. 已绑定的资源（排除掉，避免重复推荐）
    bound = execute_query(
        "SELECT resource_type, resource_id FROM curriculum_bindings WHERE knowledge_point_id=?",
        (kp_id,),
    )
    bound_set = {(b["resource_type"], b["resource_id"]) for b in bound}
    candidates = [c for c in candidates if (c["type"], c["id"]) not in bound_set]

    if not candidates:
        return {"recommendations": [], "message": "暂无可推荐的资源，请先创建一些教学资源"}

    # 3. AI 推荐
    from backend.prompts.recommend import RESOURCE_RECOMMEND_PROMPT
    resources_json = json.dumps(
        [{"id": c["id"], "title": c["title"], "type": c["type"]} for c in candidates],
        ensure_ascii=False,
    )
    prompt = RESOURCE_RECOMMEND_PROMPT.format(
        kp_name=kp["name"],
        kp_description=kp.get("description", "") or "",
        chapter_name=kp["chapter_name"],
        course_name=kp["course_name"],
        resources_json=resources_json,
    )

    # 注意：不注入技能 — 技能的结构化输出指令与 JSON 格式要求冲突
    try:
        result_text = await call_ai_async(prompt, api_key)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 推荐失败: {str(e)}")

    # 4. 解析结果
    recommended = _parse_recommend_result(result_text)
    if not recommended:
        raise HTTPException(status_code=502, detail="AI 返回格式异常，未能解析推荐结果")

    # 5. 生成返回数据
    rec_map = {(c["type"], c["id"]): c for c in candidates}
    results = []
    for rec in recommended:
        rid = rec.get("resource_id")
        rtype = rec.get("resource_type", "")
        candidate = rec_map.get((rtype, rid))
        if candidate:
            results.append({
                "resource_id": rid,
                "resource_type": rtype,
                "resource_type_label": RESOURCE_TYPE_LABELS.get(rtype, rtype),
                "resource_icon": RESOURCE_TYPE_ICONS.get(rtype, "📎"),
                "title": candidate["title"],
                "relevance": rec.get("relevance", "medium"),
                "reason": rec.get("reason", ""),
            })

    # 按相关度排序
    relevance_order = {"high": 0, "medium": 1, "low": 2}
    results.sort(key=lambda x: relevance_order.get(x["relevance"], 99))

    logger.info(f"AI 为知识点 [{kp['name']}] 推荐了 {len(results)} 个资源")
    return {
        "recommendations": results,
        "kp_name": kp["name"],
        "total": len(results),
    }


def _parse_recommend_result(text: str) -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 推荐结果"""
    data = extract_json_from_text(text)
    if isinstance(data, dict):
        recs = data.get("recommendations", [])
        if isinstance(recs, list):
            return recs
    return []
