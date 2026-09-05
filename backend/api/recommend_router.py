# -*- coding: utf-8 -*-
"""
AI 教学资源推荐 API 路由
根据知识点自动推荐关联的教学资源（HTML、考试、讨论等）
"""
import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi import Query

from backend.api.dependencies import get_current_user
from backend.database import execute_query_dict as execute_query
from backend.question_db import execute_query as q_execute_query
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_async
from backend.utils import extract_json_from_text
from backend.logger import logger
from backend.permission_service import check_share_visibility

router = APIRouter()

RESOURCE_TYPE_LABELS = {
    "html": "HTML 课件",
    "exam": "考试试卷",
    "discussion": "课堂讨论",
    "interaction_quiz": "随堂测验",
}

RESOURCE_TYPE_ICONS = {
    "html": "\U0001F4C4",
    "exam": "\U0001F4DD",
    "discussion": "\U0001F4AC",
    "interaction_quiz": "\u2753",
}

# W13: 同一知识点短期内重复点击直接复用结果, 避免重复计费与重复排队
_CACHE_TTL_SECONDS = 600
_REC_CACHE: dict[str, tuple[float, Any]] = {}
_MAX_HTML_CANDIDATES = 80


def _to_int(v: Any) -> int | None:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _collect_candidates(username: str) -> list[dict[str, Any]]:
    """候选资源池(W12): 自己创建的 + 别人共享给自己可见范围的 HTML 资源"""
    candidates: list[dict[str, Any]] = []

    mine_html = execute_query(
        """SELECT id, file_name AS title, owner_username
           FROM shared_resources
           WHERE resource_type='html' AND owner_username=?
           ORDER BY id DESC LIMIT ?""",
        (username, _MAX_HTML_CANDIDATES),
    ) or []
    for r in mine_html:
        candidates.append({"id": r["id"], "title": r["title"], "type": "html",
                           "owner": username, "mine": True})

    # 他人共享给我的 HTML(用统一的可见性判定, 不在 SQL 里猜 scope 语义)
    shared_ids = {c["id"] for c in candidates}
    others = execute_query(
        """SELECT id, file_name AS title, owner_username, share_scope,
                  target_users, target_grade, target_class
           FROM shared_resources
           WHERE resource_type='html' AND owner_username <> ?
             AND share_scope <> 'private'
           ORDER BY id DESC LIMIT 200""",
        (username,),
    ) or []
    for r in others:
        if r["id"] in shared_ids:
            continue
        try:
            visible = check_share_visibility(
                username,
                r.get("share_scope") or "",
                r.get("target_users") or "",
                r.get("target_grade") or "",
                r.get("target_class") or "",
            )
        except Exception as vis_err:
            logger.warning(f"[recommend] 共享可见性判定失败(id={r['id']}): {vis_err}")
            continue
        if not visible:
            continue
        candidates.append({"id": r["id"], "title": r["title"], "type": "html",
                           "owner": r.get("owner_username") or "", "mine": False})

    for row in q_execute_query(
        "SELECT id, title, creator_username FROM exams WHERE status='published' AND creator_username=? ORDER BY id DESC LIMIT 50",
        (username,),
    ) or []:
        candidates.append({"id": row["id"], "title": row["title"], "type": "exam",
                           "owner": username, "mine": True})

    for row in execute_query(
        "SELECT id, title, creator_username FROM discussions WHERE creator_username=? ORDER BY id DESC LIMIT 50",
        (username,),
    ) or []:
        candidates.append({"id": row["id"], "title": row["title"], "type": "discussion",
                           "owner": username, "mine": True})

    for row in execute_query(
        "SELECT id, title, creator_username FROM interaction_quizzes WHERE creator_username=? ORDER BY id DESC LIMIT 50",
        (username,),
    ) or []:
        candidates.append({"id": row["id"], "title": row["title"], "type": "interaction_quiz",
                           "owner": username, "mine": True})

    return candidates


def _parse_recommend_result(text: str) -> list[dict[str, Any]]:
    """兼容 {\"recommendations\": [...]} 与裸数组两种返回(W12: 旧实现只认前者, 否则误判 502)"""
    data = extract_json_from_text(text)
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        recs = data.get("recommendations")
        if isinstance(recs, list):
            return [x for x in recs if isinstance(x, dict)]
        # 个别模型会直接返回 {\"resource_id\": ...} 单个对象
        if "resource_id" in data:
            return [data]
    return []


@router.post("/knowledge-point/{kp_id}", summary="AI 推荐教学资源")
async def recommend_resources(kp_id: int, request: Request, refresh: bool = Query(False, description="忽略缓存重新推荐")):
    """[教师] AI 推荐教学资源给指定知识点"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可使用推荐")

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请在 AI 助手中配置")

    kp = execute_query(
        """SELECT kp.*, ch.name AS chapter_name, c.name AS course_name
           FROM knowledge_points kp
           JOIN chapters ch ON ch.id = kp.chapter_id
           JOIN courses c ON c.id = ch.course_id
           WHERE kp.id=?""",
        (kp_id,),
    )
    if not kp:
        raise HTTPException(status_code=404, detail="知识点不存在")
    kp = kp[0]

    candidates = _collect_candidates(username)

    # 排除已绑定的资源, 避免重复推荐
    bound_rows = execute_query(
        "SELECT resource_type, resource_id FROM curriculum_bindings WHERE knowledge_point_id=?",
        (kp_id,),
    ) or []
    bound_set = {(b["resource_type"], _to_int(b["resource_id"])) for b in bound_rows}
    candidates = [c for c in candidates if (c["type"], _to_int(c["id"])) not in bound_set]

    if not candidates:
        return {"recommendations": [], "message": "暂无可推荐的资源，请先创建或接收一些教学资源", "total": 0, "cached": False}

    # 候选集指纹: 资源有增删或绑定变化时缓存自动失效
    fp = f"{len(candidates)}:{max(_to_int(c['id']) or 0 for c in candidates)}:{len(bound_set)}"
    cache_key = f"{username}:{kp_id}:{fp}"
    now_ts = time.time()
    if not refresh:
        hit = _REC_CACHE.get(cache_key)
        if hit and now_ts - hit[0] < _CACHE_TTL_SECONDS:
            payload = dict(hit[1])
            payload["cached"] = True
            return payload

    resources_json = json.dumps(
        [{"id": c["id"], "title": str(c["title"] or "")[:80], "type": c["type"]} for c in candidates],
        ensure_ascii=False,
    )

    from backend.prompts.recommend import RESOURCE_RECOMMEND_PROMPT
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

    recommended = _parse_recommend_result(result_text)
    if not recommended:
        logger.warning(f"[recommend] AI 返回无法解析 (kp={kp_id}, user={username}): {str(result_text)[:200]}")
        raise HTTPException(status_code=502, detail="AI 返回格式异常，未能解析推荐结果，请重试或换一种说法")

    rec_map = {(c["type"], _to_int(c["id"])): c for c in candidates}
    results: list[dict[str, Any]] = []
    unmatched = 0
    for rec in recommended:
        rtype = str(rec.get("resource_type", "") or "").strip()
        rid = _to_int(rec.get("resource_id"))
        candidate = rec_map.get((rtype, rid))
        if not candidate:
            unmatched += 1
            continue
        results.append({
            "resource_id": rid,
            "resource_type": rtype,
            "resource_type_label": RESOURCE_TYPE_LABELS.get(rtype, rtype),
            "resource_icon": RESOURCE_TYPE_ICONS.get(rtype, "\U0001F4CE"),
            "title": candidate["title"],
            "owner": candidate.get("owner", ""),
            "mine": bool(candidate.get("mine", True)),
            "relevance": str(rec.get("relevance", "medium") or "medium").lower(),
            "reason": rec.get("reason", ""),
        })

    relevance_order = {"high": 0, "medium": 1, "low": 2}
    results.sort(key=lambda x: relevance_order.get(x["relevance"], 99))

    message = f"为知识点「{kp['name']}」推荐了 {len(results)} 个资源"
    if unmatched:
        # 不再静默返回空列表: 明确告诉教师发生了什么
        message += f"（另有 {unmatched} 条推荐因资源已删除或 ID 不匹配被忽略）"
    logger.info(f"AI 为知识点 [{kp['name']}] 推荐了 {len(results)} 个资源 (未匹配 {unmatched})")

    payload = {
        "recommendations": results,
        "kp_name": kp["name"],
        "total": len(results),
        "message": message,
        "cached": False,
        "candidate_total": len(candidates),
    }
    if results:
        _REC_CACHE[cache_key] = (now_ts, payload)
        if len(_REC_CACHE) > 200:      # 防止长期运行内存无上限
            for k in sorted(_REC_CACHE)[:50]:
                _REC_CACHE.pop(k, None)
    return payload
