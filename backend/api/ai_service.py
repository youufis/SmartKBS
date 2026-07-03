"""
AI 服务封装：根据是否配置 APPID 自动选择调用模式

- 配置了 APPID → 调用百炼平台智能体应用 (DashScopeApp.call)
- 未配置 APPID → 直接调用大模型 (OpenAI 兼容接口 /chat/completions)
"""
import json
import os
import concurrent.futures
from typing import Any, Optional

from backend.logger import logger

# ── 专用线程池：隔离 AI 调用线程，防止耗尽 asyncio 默认线程池 ──
# 限制最大 3 个并发 AI 线程，避免长时间等待的 AI 调用阻塞数据库等其他操作
_ai_thread_pool = concurrent.futures.ThreadPoolExecutor(
    max_workers=3,
    thread_name_prefix="ai_call",
)


def get_ai_config():
    """获取 AI 调用配置"""
    from backend.api.config_router import get_config_value
    app_id = get_config_value("APPID", "")
    if app_id:
        return {"mode": "agent", "app_id": app_id}
    return {
        "mode": "direct",
        "model": get_config_value("MODEL_NAME", "deepseek-v4-flash"),
        "api_base": get_config_value("QWEN_OPENAI_API_BASE",
                                      "https://dashscope.aliyuncs.com/compatible-mode/v1"),
    }


# ── 非流式调用（同步，返回完整文本） ──

def call_ai_sync(prompt: str, api_key: str) -> str:
    """同步调用 AI，返回完整响应文本"""
    if not api_key or not api_key.strip():
        raise ValueError("API Key 为空，请在系统配置中设置 API Key")

    cfg = get_ai_config()
    os.environ["DASHSCOPE_API_KEY"] = api_key

    if cfg["mode"] == "agent":
        return _call_agent_sync(prompt, api_key, cfg["app_id"])
    else:
        return _call_model_sync(prompt, api_key, cfg["model"], cfg["api_base"])


async def call_ai_sync_with_timeout(prompt: str, api_key: str, timeout: int = 120) -> str:
    """带超时的异步 AI 调用，将同步调用放到专用线程池中执行"""
    import asyncio
    loop = asyncio.get_running_loop()
    try:
        result = await asyncio.wait_for(
            loop.run_in_executor(_ai_thread_pool, call_ai_sync, prompt, api_key),
            timeout=timeout,
        )
        return result
    except asyncio.TimeoutError:
        logger.error(f"AI 请求超时（{timeout}秒）: prompt={prompt[:200]}")
        raise TimeoutError(f"AI 请求超时（超过{timeout}秒），请稍后重试或简化描述")
    except Exception as e:
        logger.error(f"AI 请求失败: {e}")
        raise


def _call_agent_sync(prompt: str, api_key: str, app_id: str) -> str:
    """调用百炼智能体应用（同步）"""
    from dashscope import Application as DashScopeApp
    try:
        # 新版 dashscope SDK 使用 messages 替代 prompt
        messages = [{"role": "user", "content": prompt}]
        response = DashScopeApp.call(
            app_id=app_id,
            messages=messages,  # type: ignore
            stream=False,
            headers={"X-DashScope-OssResourceResolve": "enable"},
        )
        # 尝试多种方式提取响应文本
        text = None
        # 方式1: response.output.text
        output = getattr(response, "output", None)
        if output is not None:
            if isinstance(output, str):
                text = output
            elif hasattr(output, "get"):
                text = output.get("text", None) or getattr(output, "text", None)
            else:
                text = getattr(output, "text", None)
        # 方式2: response.text（兼容旧版 SDK）
        if not text:
            try:
                text = getattr(response, "text", None)
            except (KeyError, AttributeError, TypeError):
                pass
        # 方式3: response 本身是 dict
        if not text:
            try:
                if isinstance(response, dict):
                    out = response.get("output", {})
                    if isinstance(out, dict):
                        text = out.get("text", "")
            except (KeyError, TypeError):
                pass
        if text:
            return str(text)
        # 智能体返回空时，降级到直接调模型
        logger.warning(f"智能体返回为空，降级到直接调模型 (app_id={app_id})")
        from backend.api.config_router import get_config_value
        model = get_config_value("MODEL_NAME", "deepseek-v4-flash")
        api_base = get_config_value("QWEN_OPENAI_API_BASE",
                                     "https://dashscope.aliyuncs.com/compatible-mode/v1")
        return _call_model_sync(prompt, api_key, model, api_base)
    except Exception as e:
        logger.error(f"智能体调用失败 (app_id={app_id}): {e}，降级到直接调模型")
        from backend.api.config_router import get_config_value
        model = get_config_value("MODEL_NAME", "deepseek-v4-flash")
        api_base = get_config_value("QWEN_OPENAI_API_BASE",
                                     "https://dashscope.aliyuncs.com/compatible-mode/v1")
        return _call_model_sync(prompt, api_key, model, api_base)


def _call_model_sync(prompt: str, api_key: str, model: str, api_base: str) -> str:
    """直接调用大模型（同步，OpenAI 兼容接口）"""
    import requests as sync_requests
    # 构建消息内容（兼容 content 字符串和数组两种格式）
    content = prompt if prompt else ""
    # 先尝试字符串格式
    messages = [{"role": "user", "content": content}]
    last_error = None
    for fmt in ["str", "array"]:
        if fmt == "array":
            # 部分 DashScope 模型要求 content 为数组格式
            messages = [{"role": "user", "content": [{"type": "text", "text": content}]}]
        try:
            payload = {
                "model": model,
                "messages": messages,
                "stream": False,
            }
            resp = sync_requests.post(
                f"{api_base}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
                timeout=(30, 120),  # (连接超时30秒, 读取超时120秒)
            )
            if resp.status_code == 200:
                data = resp.json()
                return data["choices"][0]["message"]["content"]
            # 400 错误可能是格式问题，尝试下一种格式
            if resp.status_code == 400:
                last_error = resp.text[:300]
                continue
            logger.error(f"大模型调用失败: status={resp.status_code}, {resp.text[:300]}")
            raise Exception(f"AI 调用失败 (HTTP {resp.status_code})")
        except Exception as e:
            logger.error(f"大模型调用异常: {e}")
            raise
    # 两种格式都失败
    raise Exception(f"AI 调用失败: {last_error}")


def call_ai_sync_direct(prompt: str, api_key: str) -> str:
    """强制直接调用大模型（绕过智能体），用于知识闯关等不需要 APPID 的场景"""
    if not api_key or not api_key.strip():
        raise ValueError("API Key 为空，请在系统配置中设置 API Key")

    from backend.api.config_router import get_config_value
    model = get_config_value("MODEL_NAME", "deepseek-v4-flash")
    api_base = get_config_value("QWEN_OPENAI_API_BASE",
                                 "https://dashscope.aliyuncs.com/compatible-mode/v1")
    return _call_model_sync(prompt, api_key, model, api_base)


# ── 流式调用（返回事件生成器） ──

def call_ai_stream(prompt: str, api_key: str, session_id: Optional[str] = None):
    """流式调用 AI，返回 (text_generator, get_session_id)"""
    cfg = get_ai_config()
    os.environ["DASHSCOPE_API_KEY"] = api_key

    if cfg["mode"] == "agent":
        return _call_agent_stream(prompt, api_key, cfg["app_id"], session_id)
    else:
        return _call_model_stream(prompt, api_key, cfg["model"], cfg["api_base"])


def _call_agent_stream(prompt: str, api_key: str, app_id: str,
                       session_id: Optional[str] = None):
    """调用百炼智能体应用（流式），返回生成器，yield {"text": str, "session_id": str}"""
    from dashscope import Application as DashScopeApp
    messages = [{"role": "user", "content": prompt}]
    call_params = {
        "app_id": app_id,
        "messages": messages,
        "stream": True,
        "incremental_output": True,
        "headers": {"X-DashScope-OssResourceResolve": "enable"},
    }
    if session_id:
        call_params["session_id"] = session_id

    try:
        response = DashScopeApp.call(**call_params)
        new_session_id = session_id
        has_output = False
        accumulated_text = ""
        for chunk in response:
            output = getattr(chunk, "output", None)
            if output:
                sid = getattr(output, "session_id", None)
                if sid:
                    new_session_id = sid
                text = getattr(output, "text", None)
                if text:
                    has_output = True
                    accumulated_text += text
                    yield {"text": accumulated_text, "session_id": new_session_id}
        # 智能体返回空文本时降级
        if not has_output:
            logger.warning(f"智能体流式返回为空，降级到直接调模型 (app_id={app_id})")
            from backend.api.config_router import get_config_value
            model = get_config_value("MODEL_NAME", "deepseek-v4-flash")
            api_base = get_config_value("QWEN_OPENAI_API_BASE",
                                         "https://dashscope.aliyuncs.com/compatible-mode/v1")
            for chunk in _call_model_stream(prompt, api_key, model, api_base):
                yield chunk
    except Exception as e:
        logger.error(f"智能体流式调用失败: {e}，降级到直接调模型")
        from backend.api.config_router import get_config_value
        model = get_config_value("MODEL_NAME", "deepseek-v4-flash")
        api_base = get_config_value("QWEN_OPENAI_API_BASE",
                                     "https://dashscope.aliyuncs.com/compatible-mode/v1")
        for chunk in _call_model_stream(prompt, api_key, model, api_base):
            yield chunk


def _call_model_stream(prompt: str, api_key: str, model: str, api_base: str):
    """直接调用大模型（流式，OpenAI 兼容接口），yield {"text": str, "session_id": None}"""
    import requests as sync_requests
    content = prompt if prompt else ""
    # 先尝试字符串格式，失败则降级到数组格式
    for fmt in ["str", "array"]:
        if fmt == "str":
            messages = [{"role": "user", "content": content}]
        else:
            messages = [{"role": "user", "content": [{"type": "text", "text": content}]}]
        try:
            payload = {
                "model": model,
                "messages": messages,
                "stream": True,
            }
            resp = sync_requests.post(
                f"{api_base}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
                stream=True,
                timeout=180,
            )
            if resp.status_code == 400 and fmt == "str":
                continue  # 尝试数组格式
            if resp.status_code != 200:
                logger.error(f"大模型流式调用失败: status={resp.status_code}")
                yield {"text": f"AI 调用失败 (HTTP {resp.status_code})", "session_id": None}
                return

            accumulated_text = ""
            for line in resp.iter_lines():
                if not line:
                    continue
                decoded = line.decode("utf-8") if isinstance(line, bytes) else line
                if decoded.startswith("data:"):  # type: ignore[arg-type]
                    data_str = decoded[5:].strip()  # type: ignore[union-attr]
                    if data_str == "[DONE]":
                        break
                    try:
                        data = json.loads(data_str)
                        if "choices" in data and data["choices"]:
                            delta = data["choices"][0].get("delta", {})
                            chunk_text = delta.get("content", "")
                            if chunk_text:
                                accumulated_text += chunk_text
                                yield {"text": accumulated_text, "session_id": None}
                    except json.JSONDecodeError:
                        continue
        except Exception as e:
            logger.error(f"大模型流式调用异常: {e}")
            yield {"text": f"网络连接错误：{str(e)}", "session_id": None}


# ── 异步调用（非流式，使用 httpx） ──

async def call_ai_async(prompt: str, api_key: str) -> str:
    """异步调用 AI，返回完整响应文本（不阻塞工作线程）"""
    if not api_key or not api_key.strip():
        raise ValueError("API Key 为空，请在系统配置中设置 API Key")

    cfg = get_ai_config()
    os.environ["DASHSCOPE_API_KEY"] = api_key

    if cfg["mode"] == "agent":
        return await _call_agent_async(prompt, api_key, cfg["app_id"])
    else:
        return await _call_model_async(prompt, api_key, cfg["model"], cfg["api_base"])


async def _call_agent_async(prompt: str, api_key: str, app_id: str) -> str:
    """调用百炼智能体应用（使用 DashScope SDK，与同步版一致）"""
    import asyncio
    import concurrent.futures

    loop = asyncio.get_event_loop()
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        return await loop.run_in_executor(
            executor, _call_agent_sync, prompt, api_key, app_id
        )
    except Exception as e:
        logger.error(f"智能体异步调用失败 (app_id={app_id}): {e}，降级到直接调模型")
        from backend.api.config_router import get_config_value
        model = get_config_value("MODEL_NAME", "deepseek-v4-flash")
        api_base = get_config_value("QWEN_OPENAI_API_BASE",
                                      "https://dashscope.aliyuncs.com/compatible-mode/v1")
        return await _call_model_async(prompt, api_key, model, api_base)
    finally:
        executor.shutdown(wait=False)


async def _call_model_async(prompt: str, api_key: str, model: str, api_base: str) -> str:
    """异步直接调用大模型（OpenAI 兼容接口）"""
    import httpx

    content = prompt if prompt else ""
    last_error = None
    for fmt in ["str", "array"]:
        if fmt == "str":
            messages = [{"role": "user", "content": content}]
        else:
            messages = [{"role": "user", "content": [{"type": "text", "text": content}]}]
        try:
            payload = {
                "model": model,
                "messages": messages,
                "stream": False,
            }
            async with httpx.AsyncClient(timeout=180) as client:
                resp = await client.post(
                    f"{api_base}/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json=payload,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data["choices"][0]["message"]["content"]
                if resp.status_code == 400:
                    last_error = resp.text[:300]
                    continue
                logger.error(f"大模型异步调用失败: status={resp.status_code}, {resp.text[:300]}")
                raise Exception(f"AI 调用失败 (HTTP {resp.status_code})")
        except Exception as e:
            logger.error(f"大模型异步调用异常: {e}")
            raise
    raise Exception(f"AI 调用失败: {last_error}")


# ═══════════════════════════════════════════════════════════════
# 多模态调用（图片+文本混合输入，OpenAI 兼容格式）
# ═══════════════════════════════════════════════════════════════


def is_multimodal_model(model_name: str) -> bool:
    """判断是否为多模态模式（由用户在系统配置中手动勾选决定）"""
    try:
        from backend.api.config_router import get_config_value
        return bool(get_config_value("ENABLE_MULTIMODAL", False))
    except Exception:
        return False


def _build_multimodal_content(
    prompt: str,
    image_paths: list[str] | None = None,
) -> list[dict[str, Any]]:
    """构建多模态 messages 的 content 数组（OpenAI 兼容格式）"""
    content = []

    # 添加图片（本地文件 → base64 data URI）
    if image_paths:
        for img_path in image_paths:
            if not img_path or not os.path.exists(img_path):
                continue
            try:
                mime = _get_multimodal_mime(img_path)
                with open(img_path, "rb") as f:
                    import base64
                    b64 = base64.b64encode(f.read()).decode("utf-8")
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"}
                })
            except Exception as e:
                logger.warning(f"图片编码失败 {img_path}: {e}")

    # 添加文本（放在最后）
    content.append({"type": "text", "text": prompt})

    return content


def _get_multimodal_mime(file_path: str) -> str:
    """根据文件扩展名返回 MIME 类型"""
    ext = os.path.splitext(file_path.lower())[1]
    mime_map = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.bmp': 'image/bmp', '.tiff': 'image/tiff',
        '.tif': 'image/tiff', '.webp': 'image/webp',
    }
    return mime_map.get(ext, 'image/jpeg')


def call_multimodal_stream(
    prompt: str,
    api_key: str,
    model: str,
    api_base: str,
    image_paths: list[str] | None = None,
):
    """多模态流式调用（OpenAI 兼容接口），yield {"text": str, "session_id": None}

    支持图片+文本同时输入，适用于 qwen3.5-flash / qwen3.6-flash 等多模态模型。
    """
    import requests as sync_requests

    content = _build_multimodal_content(prompt, image_paths)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "stream": True,
    }

    try:
        resp = sync_requests.post(
            f"{api_base}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            stream=True,
            timeout=180,
        )
        if resp.status_code != 200:
            logger.error(f"多模态流式调用失败: status={resp.status_code}, {resp.text[:300]}")
            yield {"text": f"AI 调用失败 (HTTP {resp.status_code})", "session_id": None}
            return

        full_text = ""
        for line in resp.iter_lines():
            if not line:
                continue
            decoded = line.decode("utf-8") if isinstance(line, bytes) else line
            if decoded.startswith("data:"):  # type: ignore[arg-type]
                data_str = decoded[5:].strip()  # type: ignore[union-attr]
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    if "choices" in data and data["choices"]:
                        delta = data["choices"][0].get("delta", {})
                        content_piece = delta.get("content", "")
                        if content_piece:
                            full_text += content_piece
                            yield {"text": full_text, "session_id": None}
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        logger.error(f"多模态流式调用异常: {e}")
        yield {"text": f"网络连接错误：{str(e)}", "session_id": None}


def call_multimodal_sync(
    prompt: str,
    api_key: str,
    model: str,
    api_base: str,
    image_paths: list[str] | None = None,
) -> str:
    """多模态同步调用（OpenAI 兼容接口），返回完整文本"""
    import requests as sync_requests

    content = _build_multimodal_content(prompt, image_paths)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
    }

    try:
        resp = sync_requests.post(
            f"{api_base}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=(30, 120),
        )
        if resp.status_code == 200:
            data = resp.json()
            return data["choices"][0]["message"]["content"]
        logger.error(f"多模态同步调用失败: status={resp.status_code}, {resp.text[:300]}")
        raise Exception(f"AI 多模态调用失败 (HTTP {resp.status_code})")
    except Exception as e:
        logger.error(f"多模态同步调用异常: {e}")
        raise
