"""
AI 学伴 API 路由
提供学伴对话、配置管理、推送消息等接口
"""
import json
import os
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.api.chat_router import get_api_keys, _chat_event_generator
from backend.api.config_router import get_config_value
from backend.api.dependencies import get_current_user
from backend.companion_profile import (
    get_config as get_companion_config,
    update_config as update_companion_config,
    get_personality_list,
    is_enabled,
)
from backend.companion_memory import (
    get_student_profile,
    get_student_profile_text,
    build_companion_system_prompt,
    clear_profile_cache,
    save_memory,
    get_memories,
)
from backend.companion_push import (
    get_unread_pushes,
    mark_push_read,
    mark_all_pushes_read,
    get_unread_push_count,
    push_morning_greeting,
)
from backend.logger import logger
from backend.database import execute_query

router = APIRouter()


class CompanionChatRequest(BaseModel):
    prompt: str = ""
    file_paths: list[str] = []
    session_id: Optional[str] = None
    context_enhance: bool = False


class CompanionConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    personality: Optional[str] = None
    companion_name: Optional[str] = None
    avatar_style: Optional[str] = None
    wakeup_time: Optional[str] = None


# ═══════════════════════════════════════════════
# 学伴对话（SSE 流式）
# ═══════════════════════════════════════════════

@router.post("/companion/chat")
async def companion_chat(req: CompanionChatRequest, request: Request):
    """学伴对话端点（SSE 流式，自动注入学生画像）"""
    if not req.prompt:
        raise HTTPException(status_code=400, detail="提示词不能为空")

    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    # 仅学生可使用学伴完整功能；教师/管理员可体验但无画像
    if role not in (0, 1, 2):
        raise HTTPException(status_code=403, detail="无权限使用学伴功能")

    # 检查学伴是否启用
    if role == 2 and not is_enabled(username):
        return StreamingResponse(
            _error_stream("学伴已关闭，请在设置中启用后再使用"),
            media_type="text/event-stream",
        )

    # AI 对话权限检查（与智答模式共享同一权限配置）
    if role != 0:
        allowed_roles = get_config_value("ENABLE_AI_CHAT_FOR_ROLES", [1, 2])
        if role not in allowed_roles:
            role_name = "教师" if role == 1 else "学生"
            return StreamingResponse(
                _error_stream(f"AI 对话功能已对{role_name}关闭，请联系管理员开启"),
                media_type="text/event-stream",
            )

    # 请求限流（与智答模式共享每日次数）
    from backend.utils import check_user_daily_requests
    allowed, remaining = check_user_daily_requests(username, role)
    if not allowed:
        from backend.utils import get_limit_config
        _, max_req = get_limit_config()
        return StreamingResponse(
            _error_stream(f"今日请求次数已达上限 ({max_req}次)"),
            media_type="text/event-stream",
        )

    # AI 对话积分奖励（与智答模式一致，仅学生）
    if role == 2:
        try:
            from backend.reward_engine import award_participation
            import datetime
            award_participation(username, "chat", f"{username}_{datetime.datetime.now().strftime('%Y%m%d%H%M%S')}", "学伴对话")
        except Exception:
            pass

    dashscope_api_key, _ = get_api_keys(username)
    if not dashscope_api_key:
        return StreamingResponse(
            _error_stream("API Key 未配置，请管理员在「系统配置」中填写"),
            media_type="text/event-stream",
        )

    # 构建学伴增强提示词
    enhanced_prompt = _build_companion_prompt_with_profile(req.prompt, username, role)

    # 构建学伴增强提示词
    enhanced_prompt = _build_companion_prompt_with_profile(req.prompt, username, role)

    # 调用流式对话生成器（与智答模式共用 _chat_event_generator，支持文件/多模态/摘要/RAG）
    return StreamingResponse(
        _chat_event_generator(
            prompt=enhanced_prompt,
            file_paths=req.file_paths,
            session_id=req.session_id,
            username=username,
            user_payload=user,
            dashscope_api_key=dashscope_api_key,
            context_enhance=req.context_enhance,
        ),
        media_type="text/event-stream",
    )


def _build_companion_prompt_with_profile(user_prompt: str, username: str, role: int) -> str:
    """将用户提示词与学伴系统提示词合并

    为学生注入完整的画像信息，为教师使用教学助手提示词
    """
    if role == 2:
        # 学生 → 注入学伴系统提示词 + 画像
        system_prompt = build_companion_system_prompt(username)
        return f"{system_prompt}\n\n---\n\n学生说：{user_prompt}"
    elif role in (0, 1):
        # 教师/管理员 → 使用教学助手提示词
        from backend.prompts.companion import TEACHER_COMPANION_PROMPT
        from backend.database import execute_query
        name_row = execute_query("SELECT name FROM users WHERE username=?", (username,))
        teacher_name = name_row[0][0] if name_row and name_row[0][0] else username
        role_label = "管理员" if role == 0 else "老师"
        return f"{TEACHER_COMPANION_PROMPT.format(teacher_name=teacher_name)}\n\n---\n\n{role_label}说：{user_prompt}"


def _companion_event_generator(
    prompt: str,
    session_id: Optional[str],
    username: str,
    dashscope_api_key: str,
):
    """学伴流式事件生成器（保留用于兼容，新代码直接使用 _chat_event_generator）"""
    from backend.api.chat_router import _chat_event_generator as _cg

    try:
        for chunk in _cg(prompt, [], session_id, username, None, dashscope_api_key, False):
            yield f"data: {json.dumps({'type': 'delta', 'content': chunk['text']})}\n\n"
            session_id = chunk.get("session_id") or session_id

        yield f"data: {json.dumps({'type': 'done', 'session_id': session_id or ''})}\n\n"

        # 异步保存对话记忆（不阻塞响应）
        try:
            _save_chat_memory_async(username, prompt)
        except Exception:
            pass

    except Exception as e:
        logger.error(f"学伴对话流式生成失败: {e}")
        yield f"data: {json.dumps({'type': 'error', 'content': f'对话生成失败：{str(e)}'})}\n\n"


def _save_chat_memory_async(username: str, prompt: str):
    """异步保存对话记忆（简化版：记录对话中提到的知识点）"""
    # 从对话中提取常见知识点关键词
    kp_keywords = [
        "进制转换", "网络协议", "OSI模型", "TCP/IP", "IP地址",
        "数据结构", "算法", "排序", "查找", "二叉树",
        "Python", "JavaScript", "HTML", "CSS", "SQL",
        "电路", "传感器", "控制系统", "流程图", "编程",
    ]
    mentioned = [kp for kp in kp_keywords if kp in prompt]
    if mentioned:
        save_memory(username, "preference", {"mentioned_kps": mentioned}, confidence=0.3)


def _error_stream(msg: str):
    """生成错误流"""
    yield f"data: {json.dumps({'type': 'error', 'content': msg})}\n\n"


# ═══════════════════════════════════════════════
# 学伴配置
# ═══════════════════════════════════════════════

@router.get("/companion/config", summary="获取学伴配置")
async def get_config(request: Request):
    """获取当前学生的学伴配置"""
    user = get_current_user(request)
    username = user["username"]

    config = get_companion_config(username)
    # 添加额外信息（仅 GET 返回这些运行时数据）
    profile = get_student_profile(username)
    config["student_name"] = profile.get("name", username)
    config["personality_list"] = get_personality_list()
    unread_count = get_unread_push_count(username)
    config["unread_push_count"] = unread_count

    return config


@router.put("/companion/config", summary="更新学伴配置")
async def update_config(req: CompanionConfigUpdate, request: Request):
    """更新学伴配置"""
    user = get_current_user(request)
    username = user["username"]

    update_data = {}
    if req.enabled is not None:
        update_data["enabled"] = req.enabled
    if req.personality is not None:
        valid_personalities = {"encouraging", "rigorous", "humorous"}
        if req.personality not in valid_personalities:
            raise HTTPException(status_code=400, detail=f"无效的人格类型，可选: {', '.join(valid_personalities)}")
        update_data["personality"] = req.personality
        # 切换人格时清除画像缓存，使新人格立即生效
        clear_profile_cache(username)
    if req.companion_name is not None:
        if not req.companion_name.strip() or len(req.companion_name.strip()) > 10:
            raise HTTPException(status_code=400, detail="学伴名称限 1-10 个字符")
        update_data["companion_name"] = req.companion_name.strip()
    if req.avatar_style is not None:
        update_data["avatar_style"] = req.avatar_style
    if req.wakeup_time is not None:
        update_data["wakeup_time"] = req.wakeup_time

    if not update_data:
        raise HTTPException(status_code=400, detail="没有提供要更新的字段")

    result = update_companion_config(username, update_data)
    # 返回完整配置（companion_profile.get_config 已含 personality_label）
    return {"success": True, "config": result}


# ═══════════════════════════════════════════════
# 学生画像
# ═══════════════════════════════════════════════

@router.get("/companion/profile", summary="获取学伴画像摘要")
async def get_profile(request: Request):
    """获取当前学生的学伴画像摘要"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    # 教师/管理员可查看指定学生
    target = username
    if role in (0, 1):
        student = request.query_params.get("student_username", "")
        if student:
            target = student

    profile = get_student_profile(target)
    config = get_companion_config(target)
    return {
        "profile": profile,
        "config": config,
    }


@router.post("/companion/refresh", summary="刷新学伴画像")
async def refresh_profile(request: Request):
    """手动刷新学生画像缓存"""
    user = get_current_user(request)
    username = user["username"]

    clear_profile_cache(username)
    profile = get_student_profile(username)
    return {"success": True, "message": "画像已刷新", "profile": profile}


# ═══════════════════════════════════════════════
# 推送消息
# ═══════════════════════════════════════════════

@router.get("/companion/push", summary="获取学伴推送消息")
async def get_push_messages(request: Request):
    """获取当前学生的学伴推送消息"""
    user = get_current_user(request)
    username = user["username"]

    pushes = get_unread_pushes(username)
    return {"pushes": pushes, "total": len(pushes)}


@router.put("/companion/push/{push_id}/read", summary="标记推送已读")
async def read_push(push_id: int, request: Request):
    """标记单条推送为已读"""
    user = get_current_user(request)
    username = user["username"]

    mark_push_read(push_id, username)
    return {"success": True}


@router.put("/companion/push/read-all", summary="标记所有推送已读")
async def read_all_pushes(request: Request):
    """标记所有推送为已读"""
    user = get_current_user(request)
    username = user["username"]

    mark_all_pushes_read(username)
    return {"success": True}


@router.get("/companion/push/unread-count", summary="获取未读推送数量")
async def unread_push_count(request: Request):
    """获取未读推送数量"""
    user = get_current_user(request)
    username = user["username"]

    count = get_unread_push_count(username)
    return {"count": count}


@router.post("/companion/push/check-morning", summary="检查并发送早安推送")
async def check_morning_push(request: Request):
    """登录时调用：检查是否需要发送早安推送"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        return {"skipped": True, "reason": "仅学生触发"}

    student_name = user.get("name", username)
    push_morning_greeting(username, student_name)

    return {"success": True}


# ═══════════════════════════════════════════════
# 内部帮助函数
# ═══════════════════════════════════════════════


