"""
AI 服务封装：根据是否配置 APPID 自动选择调用模式

- 配置了 APPID → 调用百炼平台智能体应用 (DashScopeApp.call)
- 未配置 APPID → 直接调用大模型 (OpenAI 兼容接口 /chat/completions)
"""
import json
import os
from typing import Optional

from backend.logger import logger


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


def _call_agent_sync(prompt: str, api_key: str, app_id: str) -> str:
    """调用百炼智能体应用（同步）"""
    from dashscope import Application as DashScopeApp
    try:
        response = DashScopeApp.call(
            app_id=app_id,
            prompt=prompt,
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
                if hasattr(response, "text"):
                    text = response.text
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
    try:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
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
        logger.error(f"大模型调用失败: status={resp.status_code}, {resp.text[:300]}")
        raise Exception(f"AI 调用失败 (HTTP {resp.status_code})")
    except Exception as e:
        logger.error(f"大模型调用异常: {e}")
        raise


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
    call_params = {
        "app_id": app_id,
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
        # 智能体返回空文本时降级
        if not full_text:
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
    try:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": True,
        }
        resp = sync_requests.post(
            f"{api_base}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            stream=True,
            timeout=180,
        )
        if resp.status_code != 200:
            logger.error(f"大模型流式调用失败: status={resp.status_code}")
            yield {"text": f"AI 调用失败 (HTTP {resp.status_code})", "session_id": None}
            return

        full_text = ""
        for line in resp.iter_lines():
            if not line:
                continue
            decoded = line.decode("utf-8") if isinstance(line, bytes) else line
            if decoded.startswith("data:"):
                data_str = decoded[5:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    if "choices" in data and data["choices"]:
                        delta = data["choices"][0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            full_text += content
                            yield {"text": full_text, "session_id": None}
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

    try:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
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
            logger.error(f"大模型异步调用失败: status={resp.status_code}, {resp.text[:300]}")
            raise Exception(f"AI 调用失败 (HTTP {resp.status_code})")
    except Exception as e:
        logger.error(f"大模型异步调用异常: {e}")
        raise
