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
from backend.token_usage import record_token_usage

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
    """
    now = time.time()
    cached = _API_KEY_CACHE.get(username)
    if cached and (now - cached[0]) < _API_KEY_CACHE_TTL:
        return cached[1], ""

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
                    # 记录 token 用量
                    usage = data.get("usage", {})
                    if usage:
                        record_token_usage("system", 0, "qwen-long",
                            usage.get("input_tokens", 0) or 0,
                            usage.get("output_tokens", 0) or 0,
                            "summary", "")
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
                        "model": get_config_value("MODEL_VL_NAME", "qwen3-vl-flash"),
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

    return {
        "enabled": enabled,
        "used": used,
        "max": max_req,
        "remaining": max(0, max_req - used),
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

    # 请求限流（仅对学生和教师生效）
    allowed, remaining = check_user_daily_requests(username, role_val)
    if not allowed:
        from backend.utils import get_limit_config
        _, max_req = get_limit_config()
        return StreamingResponse(_error_stream(f"今日请求次数已达上限 ({max_req}次)"), media_type="text/event-stream")

    dashscope_api_key, _ = get_api_keys(username)
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

        if context_enhance and valid_file_paths:
            summaries = []
            for fp in valid_file_paths:
                s = file_summary_cache.get(fp, dashscope_api_key, user_payload)
                if s:
                    summaries.append(f"文件 {os.path.basename(fp)} 摘要：\n{s.strip()}")
            if summaries:
                enhanced_prompt = ("\n\n".join(summaries) + "\n\n" + enhanced_prompt).strip()

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
                usage = {}
                for chunk in _agent_chat_image_stream(fp, enhanced_prompt, dashscope_api_key):
                    if 'usage' in chunk:
                        usage = chunk['usage']
                        # usage 所在 chunk 也携带了完整文本，需要发送到前端
                        if chunk.get('text'):
                            content = chunk['text']
                            yield f"data: {json.dumps({'type': 'delta', 'content': combined + content})}\n\n"
                        continue
                    content = chunk['text']
                    yield f"data: {json.dumps({'type': 'delta', 'content': combined + content})}\n\n"
                combined += content
                if usage:
                    record_token_usage(username, user_payload.get('role', 2) if user_payload else 2,
                        usage.get('model', 'qwen3-vl-flash'), usage.get('input_tokens', 0), usage.get('output_tokens', 0),
                        'chat', session_id or '')
            elif is_document_file(fp):
                content = ""
                usage = {}
                for chunk in _agent_chat_document_stream(fp, enhanced_prompt, dashscope_api_key):
                    if 'usage' in chunk:
                        usage = chunk['usage']
                        # usage 所在 chunk 也携带了完整文本
                        if chunk.get('text'):
                            content = chunk['text']
                            yield f"data: {json.dumps({'type': 'delta', 'content': combined + content})}\n\n"
                        continue
                    content = chunk['text']
                    yield f"data: {json.dumps({'type': 'delta', 'content': combined + content})}\n\n"
                combined += content
                if usage:
                    record_token_usage(username, user_payload.get('role', 2) if user_payload else 2,
                        usage.get('model', 'qwen-long'), usage.get('input_tokens', 0), usage.get('output_tokens', 0),
                        'chat', session_id or '')
            else:
                err = f'不支持的文件类型: {fp}'
                combined += err
                yield f"data: {json.dumps({'type': 'delta', 'content': combined})}\n\n"
        yield f"data: {json.dumps({'type': 'done', 'session_id': session_id or ''})}\n\n"

    except Exception as e:
        logger.error(f"对话流式生成失败: {e}")
        yield f"data: {json.dumps({'type': 'error', 'content': f'对话生成失败：{str(e)}'})}\n\n"


def _agent_chat_stream(prompt: str, session_id: Optional[str], api_key: str, username: str = ""):
    """DashScope Agent 流式对话（同步生成器）"""
    os.environ["DASHSCOPE_API_KEY"] = api_key

    call_params = {
        "app_id": get_config_value("APPID", "6fcb54e8f16f4e3b94e4b9fd4eab1125"),
        "prompt": prompt,
        "stream": True,
        "incremental_output": True,
        "headers": {"X-DashScope-OssResourceResolve": "enable"},
    }
    if session_id:
        call_params["session_id"] = session_id

    try:
        response = DashScopeApp.call(**call_params)
        new_session_id = session_id
        full_text = ""
        for chunk in response:
            output = getattr(chunk, "output", None)
            if output:
                sid = getattr(output, "session_id", None)
                if sid:
                    new_session_id = sid
                text = getattr(output, "text", None)
                if text:
                    full_text += text
                    yield {"text": full_text, "session_id": new_session_id}
        # 记录 token 用量
        try:
            usage = getattr(response, "usage", None)
            if usage and username:
                record_token_usage(username, 2, "deepseek-v4-flash",
                    getattr(usage, "input_tokens", 0) or 0,
                    getattr(usage, "output_tokens", 0) or 0,
                    "chat", new_session_id or "")
        except Exception:
            pass
    except Exception as e:
        logger.error(f"Agent chat error: {e}")
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
                    if "usage" in data:
                        yield {"text": full_text, "usage": {
                            "model": data["usage"].get("model", "qwen-long") if isinstance(data["usage"], dict) else "qwen-long",
                            "input_tokens": data["usage"].get("input_tokens", 0) if isinstance(data["usage"], dict) else 0,
                            "output_tokens": data["usage"].get("output_tokens", 0) if isinstance(data["usage"], dict) else 0,
                        }}
                        continue
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
        payload = {
            "model": get_config_value("MODEL_VL_NAME", "qwen3-vl-flash"),
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
                    if "usage" in data:
                        yield {"text": full_text, "usage": {
                            "model": data["usage"].get("model", "qwen3-vl-flash") if isinstance(data["usage"], dict) else "qwen3-vl-flash",
                            "input_tokens": data["usage"].get("input_tokens", 0) if isinstance(data["usage"], dict) else 0,
                            "output_tokens": data["usage"].get("output_tokens", 0) if isinstance(data["usage"], dict) else 0,
                        }}
                        continue
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
