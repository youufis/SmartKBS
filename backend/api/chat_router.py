"""
AI 对话 API 路由 — SSE 流式对话
"""
import asyncio
import json
import os
import time
import re
from typing import Optional, Any, Tuple, Dict

import httpx
from dashscope import Application as DashScopeApp
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel

from backend.config import (
    DEFAULT_LOGGED_IN_NAME,
)
from backend.api.config_router import get_config_value
from backend.api.dependencies import get_current_user
from backend.auth import get_user_role
from backend.utils import (
    encode_image_to_base64,
    get_image_mime_type,
    is_image_file,
    is_document_file,
    check_file_size,
    calculate_file_hash,
    enhance_prompt_with_user_context,
    get_account_chat_history_dir,
    get_admin_chat_history_dir,
    check_user_daily_requests,
)
from backend.logger import logger
from backend.database import execute_query

router = APIRouter()


class ChatRequest(BaseModel):
    prompt: str = ""
    file_paths: list[str] = []
    session_id: Optional[str] = None
    context_enhance: bool = False


# ── API Key 获取 ──

# ── API Key 缓存 ──
_API_KEY_CACHE: dict[str, tuple[float, str]] = {}  # username -> (timestamp, key)
_API_KEY_CACHE_TTL = 60  # 缓存 60 秒


def get_api_keys(username: str) -> Tuple[str, str]:
    """获取 API Key，带 60 秒缓存

    优先级：
    1. 系统环境变量 DASHSCOPE_API_KEY（最安全，适合生产部署）
    2. system_config.json 中的 dashscope_api_key（管理员在页面配置）

    注意：空 key 不会被缓存，确保环境变量在服务器启动后设置也能被及时拾取。
    """
    now = time.time()
    cached = _API_KEY_CACHE.get(username)
    if cached and (now - cached[0]) < _API_KEY_CACHE_TTL:
        # 缓存命中且非空 → 直接返回
        if cached[1]:
            return cached[1], ""
        # 缓存命中但 key 为空 → 缓存过期，重新读取
        # （避免因启动时序导致空 key 被缓存而阻塞后续请求）

    # 优先从系统环境变量读取（部署时设置，不留文件）
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    # 回退到 system_config.json
    if not key:
        try:
            from backend.api.config_router import load_config
            cfg = load_config()
            key = cfg.get("dashscope_api_key", "")
        except Exception:
            pass

    if not key:
        logger.warning("API Key 未配置：请设置环境变量 DASHSCOPE_API_KEY，或由管理员在系统配置中填写")
    else:
        # 仅在 key 非空时缓存，避免空 key 污染缓存
        _API_KEY_CACHE[username] = (now, key)

    return key, ""


def clear_api_key_cache():
    """清除 API Key 缓存（管理员更新配置后调用，使新 key 即时生效）"""
    _API_KEY_CACHE.clear()


# ── DashScope 文件上传 ──

async def upload_file_to_dashscope(file_path: str, api_key: str) -> str:
    """上传文件到 DashScope 并获取文件 ID"""
    async with httpx.AsyncClient() as client:
        with open(file_path, "rb") as f:
            files = {"file": f, "purpose": (None, "file-extract")}
            resp = await client.post(
                f'{get_config_value("QWEN_OPENAI_API_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1")}/files',
                headers={"Authorization": f"Bearer {api_key}"},
                files=files,
            )
        if resp.status_code == 200:
            return resp.json().get("id", "")
        raise Exception(f"文件上传失败: {resp.text}")


# ── 文件摘要缓存 ──

class FileSummaryCache:
    """文件摘要缓存，带过期清理（最多保留 maxsize 条，超过 30 天自动清理）"""
    def __init__(self, maxsize: int = 100, max_age_days: int = 30):
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._maxsize = maxsize
        self._max_age = max_age_days * 86400  # 秒
        self._last_cleanup: float = 0
        self._cleanup_interval = 86400  # 每天检查一次

    def _maybe_cleanup(self):
        """定期清理过期缓存（超过 max_age 的条目）"""
        import time
        now = time.time()
        if now - self._last_cleanup < self._cleanup_interval:
            return
        self._last_cleanup = now
        cutoff = now - self._max_age
        expired = [k for k, v in self._cache.items() if v.get("mtime", 0) < cutoff]
        for k in expired:
            del self._cache[k]
        if expired:
            from backend.logger import logger
            logger.info(f"缓存清理: 移除 {len(expired)} 条过期文件摘要")

    def get(self, file_path: str, api_key: str, session_state: dict[str, Any] | None = None) -> str:
        self._maybe_cleanup()
        abs_path = os.path.abspath(file_path)
        file_hash = calculate_file_hash(abs_path)
        cached = self._cache.get(abs_path)
        if cached and cached.get("hash") == file_hash:
            return cached.get("summary", "")
        # 未命中缓存，生成摘要
        summary = self._generate_summary(abs_path, api_key)
        if summary:
            import time as _time
            self._cache[abs_path] = {"hash": file_hash, "summary": summary, "mtime": _time.time()}
            # 清理溢出
            if len(self._cache) > self._maxsize:
                oldest = min(self._cache.keys(), key=lambda k: self._cache[k]["mtime"])
                del self._cache[oldest]
        return summary

    def _generate_summary(self, abs_path: str, api_key: str) -> str:
        prompt = "请简要总结该文件的主要结论与要点，最多200字。"
        loop = asyncio.new_event_loop()
        try:
            if is_image_file(abs_path):
                result = loop.run_until_complete(self._async_image_summary(abs_path, prompt, api_key))
            elif is_document_file(abs_path):
                result = loop.run_until_complete(self._async_document_summary(abs_path, prompt, api_key))
            else:
                result = ""
            return result[:5000] if result else ""
        finally:
            loop.close()

    async def _async_document_summary(self, file_path: str, prompt: str, api_key: str) -> str:
        try:
            file_id = await upload_file_to_dashscope(file_path, api_key)
            if not file_id:
                return ""
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f'{get_config_value("QWEN_OPENAI_API_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1")}/chat/completions',
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": get_config_value("MODEL_LONG_NAME", "qwen-long"),
                        "messages": [
                            {"role": "system", "content": "You are a helpful assistant."},
                            {"role": "system", "content": f"fileid://{file_id}"},
                            {"role": "user", "content": prompt},
                        ],
                        "stream": False,
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data["choices"][0]["message"]["content"]
        except Exception as e:
            logger.warning(f"文件摘要生成失败: {e}")
        return ""

    async def _async_image_summary(self, file_path: str, prompt: str, api_key: str) -> str:
        try:
            encoded = encode_image_to_base64(file_path)
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f'{get_config_value("QWEN_OPENAI_API_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1")}/chat/completions',
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": get_config_value("MODEL_VL_NAME", "qwen3-vl-plus"),
                        "messages": [{
                            "role": "user",
                            "content": [
                                {"type": "image_url", "image_url": {"url": f"data:{get_image_mime_type(file_path)};base64,{encoded}"}},
                                {"type": "text", "text": prompt},
                            ]
                        }],
                        "stream": False,
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data["choices"][0]["message"]["content"]
        except Exception as e:
            logger.warning(f"图像摘要生成失败: {e}")
        return ""


file_summary_cache = FileSummaryCache()


# ── 用量查询 ──

@router.get("/usage")
async def get_usage(request: Request):
    """获取当前用户的每日用量信息"""
    user = request.state.user
    if not user:
        return {"enabled": False, "used": 0, "max": 0, "remaining": 0}

    username = user["username"]
    role_val = user.get("role", 2)

    from backend.utils import get_limit_config, get_user_daily_usage

    enabled, max_req = get_limit_config()
    used = get_user_daily_usage(username)

    # 管理员不受限
    if role_val == 0:
        return {"enabled": enabled, "used": 0, "max": 0, "remaining": -1}

    multimodal_enabled = get_config_value("ENABLE_MULTIMODAL", False)

    return {
        "enabled": enabled,
        "used": used,
        "max": max_req,
        "remaining": max(0, max_req - used),
        "multimodal_enabled": multimodal_enabled,
    }


# ── SSE 流式对话 ──

@router.post("/stream")
async def chat_stream(req: ChatRequest, request: Request):
    """SSE 流式对话端点"""
    if not req.prompt and not req.file_paths:
        raise HTTPException(status_code=400, detail="提示词或文件不能为空")

    user = request.state.user
    username = user["username"] if user else DEFAULT_LOGGED_IN_NAME
    role_val = user.get("role", 2) if user else 2

    # AI 对话权限检查（管理员 role=0 始终可用，教师和学生按配置决定）
    if role_val != 0:
        allowed_roles = get_config_value("ENABLE_AI_CHAT_FOR_ROLES", [1, 2])
        if role_val not in allowed_roles:
            role_name = "教师" if role_val == 1 else "学生"
            return StreamingResponse(
                _error_stream(f"AI 对话功能已对{role_name}关闭，请联系管理员开启"),
                media_type="text/event-stream"
            )

    # 请求限流（仅对学生和教师生效）
    allowed, remaining = check_user_daily_requests(username, role_val)
    if not allowed:
        from backend.utils import get_limit_config
        _, max_req = get_limit_config()
        return StreamingResponse(_error_stream(f"今日请求次数已达上限 ({max_req}次)"), media_type="text/event-stream")

    dashscope_api_key, _ = get_api_keys(username)

    # ── AI 对话积分奖励（仅学生，每次对话） ──
    if role_val == 2:
        try:
            from backend.reward_engine import award_participation
            import datetime
            award_participation(username, "chat", f"{username}_{datetime.datetime.now().strftime('%Y%m%d%H%M%S')}", "AI 对话")
        except Exception:
            pass

    if not dashscope_api_key:
        return StreamingResponse(
            _error_stream("API Key 未配置 | 请管理员在「系统配置」中填写 DashScope API Key，或设置环境变量 DASHSCOPE_API_KEY"),
            media_type="text/event-stream"
        )

    # 用 StreaminingResponse 包装同步生成器（FastAPI 自动在线程池运行）
    return StreamingResponse(
        _chat_event_generator(
            prompt=req.prompt, file_paths=req.file_paths,
            session_id=req.session_id, username=username,
            user_payload=user,
            dashscope_api_key=dashscope_api_key,
            context_enhance=req.context_enhance,
        ),
        media_type="text/event-stream",
    )


def _chat_event_generator(
    prompt: str, file_paths: list[str], session_id: Optional[str],
    username: str, user_payload: dict[str, Any] | None,
    dashscope_api_key: str, context_enhance: bool,
):
    """SSE 事件生成器（同步）"""
    try:
        enhanced_prompt = enhance_prompt_with_user_context(prompt, user_payload)
        valid_file_paths = [fp for fp in file_paths if fp and os.path.exists(fp)]

        # ── V3.2 RAG 增强：从试题库和课程大纲检索相关知识 ──
        try:
            from backend.rag import retrieve_knowledge
            rag_context = retrieve_knowledge(prompt, username)
            if rag_context:
                from backend.prompts import build_ai_role
                from backend.permission_service import get_teacher_subjects
                from backend.auth import get_user_role
                # 教师/管理员：使用其任教学科；学生：使用通用角色
                user_role = get_user_role(username)
                teacher_subjects = get_teacher_subjects(username) if user_role in (0, 1) else []
                ai_role = build_ai_role(subjects=teacher_subjects) if teacher_subjects else build_ai_role()
                system_role = f"{ai_role}请用你的学科知识回答用户的问题。"
                if "【相关试题】" in rag_context or "【课程知识点】" in rag_context:
                    rag_context = f"以下是数据库中检索到的相关教学资源，请参考这些内容回答：\n\n{rag_context}"
                enhanced_prompt = f"{system_role}\n\n{rag_context}\n\n用户问题：{enhanced_prompt}"
        except Exception as e:
            logger.warning(f"RAG 检索失败: {e}")

        # ── 判断是否启用多模态 ──
        multimodal_enabled = get_config_value("ENABLE_MULTIMODAL", False)
        image_files = [fp for fp in valid_file_paths if is_image_file(fp)]
        _summaries_generated = False

        if context_enhance and valid_file_paths:
            summaries = []
            for fp in valid_file_paths:
                s = file_summary_cache.get(fp, dashscope_api_key, user_payload)
                if s:
                    summaries.append(f"文件 {os.path.basename(fp)} 摘要：\n{s.strip()}")
            if summaries:
                enhanced_prompt = ("\n\n".join(summaries) + "\n\n" + enhanced_prompt).strip()
                _summaries_generated = True

        if multimodal_enabled and image_files:
            model = get_config_value("MODEL_NAME", "deepseek-v4-flash")
            # 安全校验：检查模型是否真的是多模态模型，防止配置不一致导致 API 报错
            from backend.api.ai_service import is_multimodal_model
            if not is_multimodal_model(model):
                logger.warning(f"多模态已勾选但模型 {model} 不支持多模态，降级到视觉模型处理")
                multimodal_enabled = False  # 降级，走下方旧逻辑
            else:
                api_base = get_config_value("QWEN_OPENAI_API_BASE",
                                            "https://dashscope.aliyuncs.com/compatible-mode/v1")
                from backend.api.ai_service import call_multimodal_stream

                # 如果摘要已由视觉模型生成文字描述，多模态模型无需再看原图
                image_files_for_mm = [] if _summaries_generated else image_files

                full_text = ""
                for chunk in call_multimodal_stream(
                    prompt=enhanced_prompt,
                    api_key=dashscope_api_key,
                    model=model,
                    api_base=api_base,
                    image_paths=image_files_for_mm,
                ):
                    full_text = chunk["text"]
                    yield f"data: {json.dumps({'type': 'delta', 'content': full_text})}\n\n"

                # 多模态处理完图片后，继续处理剩余的非图片文件（文档等）
                non_image_files = [fp for fp in valid_file_paths if fp not in image_files]
                if non_image_files:
                    _sep = "\n\n"
                    for fp in non_image_files:
                        if is_document_file(fp):
                            doc_content = ""
                            for chunk in _agent_chat_document_stream(fp, enhanced_prompt, dashscope_api_key):
                                doc_content = chunk['text']
                                combined = full_text + _sep + doc_content
                                yield f"data: {json.dumps({'type': 'delta', 'content': combined})}\n\n"
                            full_text += _sep + doc_content
                        else:
                            err = f'不支持的文件类型: {fp}'
                            combined = full_text + _sep + err
                            yield f"data: {json.dumps({'type': 'delta', 'content': combined})}\n\n"

                yield f"data: {json.dumps({'type': 'done', 'session_id': session_id or ''})}\n\n"
                return

        if not valid_file_paths:
            for chunk in _agent_chat_stream(enhanced_prompt, session_id, dashscope_api_key, username):
                yield f"data: {json.dumps({'type': 'delta', 'content': chunk['text']})}\n\n"
                session_id = chunk.get("session_id") or session_id
            yield f"data: {json.dumps({'type': 'done', 'session_id': session_id or ''})}\n\n"
            return

        # 累积所有文件输出，前端 onDelta 是替换模式，需要传完整文本
        combined = ""
        for i, fp in enumerate(valid_file_paths):
            if len(valid_file_paths) > 1:
                header = f'--- 文件 {i+1}/{len(valid_file_paths)} ---\n\n'
                combined += header
                yield f"data: {json.dumps({'type': 'delta', 'content': combined})}\n\n"
            if is_image_file(fp):
                content = ""
                for chunk in _agent_chat_image_stream(fp, enhanced_prompt, dashscope_api_key):
                    content = chunk['text']
                    yield f"data: {json.dumps({'type': 'delta', 'content': combined + content})}\n\n"
                combined += content
            elif is_document_file(fp):
                content = ""
                for chunk in _agent_chat_document_stream(fp, enhanced_prompt, dashscope_api_key):
                    content = chunk['text']
                    yield f"data: {json.dumps({'type': 'delta', 'content': combined + content})}\n\n"
                combined += content
            else:
                err = f'不支持的文件类型: {fp}'
                combined += err
                yield f"data: {json.dumps({'type': 'delta', 'content': combined})}\n\n"
        yield f"data: {json.dumps({'type': 'done', 'session_id': session_id or ''})}\n\n"

    except Exception as e:
        logger.error(f"对话流式生成失败: {e}")
        yield f"data: {json.dumps({'type': 'error', 'content': f'对话生成失败：{str(e)}'})}\n\n"


def _agent_chat_stream(prompt: str, session_id: Optional[str], api_key: str, username: str = ""):
    """AI 流式对话（同步生成器）- 支持智能体/直接调大模型双模式"""
    from backend.api.ai_service import call_ai_stream

    try:
        for chunk in call_ai_stream(prompt, api_key, session_id):
            yield chunk
    except Exception as e:
        logger.error(f"AI chat error: {e}")
        yield {"text": "网络连接错误：请检查您的网络连接或稍后重试！", "session_id": session_id}


def _agent_chat_document_stream(file_path: str, prompt: str, api_key: str):
    """文档问答流式（同步）"""
    import requests as sync_requests
    try:
        # 使用同步 requests 上传文件
        with open(file_path, "rb") as f:
            file_resp = sync_requests.post(
                f'{get_config_value("QWEN_OPENAI_API_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1")}/files',
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": f, "purpose": (None, "file-extract")},
            )
        if file_resp.status_code != 200:
            yield {"text": "文件上传失败"}
            return
        file_id = file_resp.json().get("id", "")

        payload = {
            "model": get_config_value("MODEL_LONG_NAME", "qwen-long"),
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "system", "content": f"fileid://{file_id}"},
                {"role": "user", "content": prompt},
            ],
            "stream": True,
        }

        resp = sync_requests.post(
            f'{get_config_value("QWEN_OPENAI_API_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1")}/chat/completions',
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            stream=True,
            timeout=120,
        )
        if resp.status_code != 200:
            yield {"text": "文档处理失败"}
            return

        full_text = ""
        for line in resp.iter_lines():
            if not line:
                continue
            decoded = line.decode("utf-8") if isinstance(line, bytes) else line
            if decoded.startswith("data:"):
                data_str = decoded[5:]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    if "choices" in data and data["choices"]:
                        delta = data["choices"][0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            full_text += content
                            yield {"text": full_text}
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        logger.error(f"文档处理失败: {e}")
        yield {"text": f"文档处理失败: {str(e)}"}


def _agent_chat_image_stream(file_path: str, prompt: str, api_key: str):
    """图像理解流式（同步）"""
    import requests as sync_requests
    try:
        encoded_image = encode_image_to_base64(file_path)
        model_name = get_config_value("MODEL_VL_NAME", "qwen3-vl-plus")
        payload = {
            "model": model_name,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:{get_image_mime_type(file_path)};base64,{encoded_image}"}},
                    {"type": "text", "text": prompt},
                ]
            }],
            "stream": True,
        }
        resp = sync_requests.post(
            f'{get_config_value("QWEN_OPENAI_API_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1")}/chat/completions',
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            stream=True,
            timeout=120,
        )
        if resp.status_code != 200:
            logger.warning(f"图像API返回非200状态: {resp.status_code} - {resp.text[:300]}")
            yield {"text": "图像处理失败"}
            return

        full_text = ""
        for line in resp.iter_lines():
            if not line:
                continue
            decoded = line.decode("utf-8") if isinstance(line, bytes) else line
            if decoded.startswith("data:"):
                data_str = decoded[5:]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    if "choices" in data and data["choices"]:
                        delta = data["choices"][0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            full_text += content
                            yield {"text": full_text}
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        logger.error(f"图像处理失败: {e}")
        yield {"text": f"图像处理失败: {str(e)}"}


async def _error_stream(message: str):
    """错误消息流"""
    yield f"data: {json.dumps({'type': 'error', 'content': message})}\n\n"
    yield f"data: {json.dumps({'type': 'done', 'session_id': ''})}\n\n"


@router.post("/new-topic")
async def new_topic():
    """新话题（清空当前会话）"""
    return {"message": "新话题已创建", "session_id": None}
