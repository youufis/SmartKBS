"""
AI 图片生成服务（增强版）
从系统配置读取生图参数，调用通义万相（OpenAI 兼容接口 / DashScope SDK）

增强特性：
  - 自动重试（3次，指数退避）
  - 模型降级（主模型失败→备用快速模型）
  - 更细粒度的超时控制
  - 详细的失败原因日志

API Key 复用现有的 dashscope_api_key（环境变量 > 系统配置）。
模型优先级：
  1. 系统配置 IMAGE_GEN_MODEL（默认 wanx2.1-t2i-turbo）
  2. 降级模型 wanx2.1-t2i-turbo（如果主模型不是它）
  3. 最终降级 wan2.2-t2i-flash
"""
import asyncio
import os
import uuid
from pathlib import Path

import dashscope

from backend.api.config_router import get_config_value
from backend.logger import logger

# ── 全局并发控制 ──
# 通义万相 API 并发限制较低，使用信号量控制最大并发数
IMAGE_GEN_SEMAPHORE = asyncio.Semaphore(2)

# 支持的模型列表
SUPPORTED_MODELS = {
    "wanx2.1-t2i-turbo": "通义万相-快速",
    "wanx2.1-t2i-plus": "通义万相-高质量",
    "wan2.2-t2i-flash": "万相生图-最新",
}

# 降级链：如果主模型失败，按此顺序尝试
FALLBACK_MODEL_CHAIN = ["wanx2.1-t2i-turbo", "wan2.2-t2i-flash"]


def get_image_gen_config() -> dict | None:
    """读取生图配置，返回配置字典或 None（禁用时）"""
    if not get_config_value("IMAGE_GEN_ENABLED", True):
        logger.debug("图片生成功能已禁用（IMAGE_GEN_ENABLED=False）")
        return None

    api_key = (os.environ.get("DASHSCOPE_API_KEY", "")
               or get_config_value("dashscope_api_key", "")
               or getattr(dashscope, 'api_key', ''))
    if not api_key:
        logger.warning("图片生成失败：API Key 未配置")
        return None

    return {
        "api_key": api_key,
        "model": get_config_value("IMAGE_GEN_MODEL", "wanx2.1-t2i-turbo"),
        "size": get_config_value("IMAGE_GEN_SIZE", "1024*1024"),
    }


async def _call_dashscope_safe(
    model: str,
    prompt: str,
    size: str,
    timeout: int,
) -> tuple[int, str | None, str | None]:
    """安全调用 DashScope ImageSynthesis API，返回 (status_code, image_url, error_msg)"""
    try:
        response = await asyncio.to_thread(
            dashscope.ImageSynthesis.call,
            model=model,
            prompt=prompt,
            n=1,
            size=size,
            timeout=timeout,
        )
        code = getattr(response, "status_code", 500)
        if code == 200:
            try:
                url = response.output.results[0].url
                return (200, url, None)
            except (AttributeError, IndexError, KeyError) as e:
                return (code, None, f"解析响应结果失败: {e}")
        else:
            msg = getattr(response, "message", "未知错误") or "未知错误"
            return (code, None, msg)
    except asyncio.TimeoutError:
        return (408, None, "生图请求超时")
    except Exception as e:
        return (500, None, str(e))


async def _download_image(
    url: str,
    save_path: Path,
    filename: str,
    timeout: int = 60,
) -> str | None:
    """下载图片到本地，返回本地路径"""
    import httpx
    file_path = save_path / f"{filename}.png"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            img_resp = await client.get(url)
            if img_resp.status_code == 200:
                file_path.write_bytes(img_resp.content)
                logger.info(f"图片下载成功: {file_path} ({len(img_resp.content)} bytes)")
                return str(file_path)
            else:
                logger.error(f"图片下载失败: HTTP {img_resp.status_code}")
                return None
    except httpx.TimeoutException:
        logger.error(f"图片下载超时: {url[:60]}")
        return None
    except Exception as e:
        logger.error(f"图片下载异常: {e}")
        return None


def _build_model_chain(primary_model: str) -> list[str]:
    """构建模型调用链（主模型 + 降级模型），自动去重"""
    chain = [primary_model]
    for fallback in FALLBACK_MODEL_CHAIN:
        if fallback not in chain:
            chain.append(fallback)
    return chain


async def generate_and_save_image(
    prompt: str,
    save_dir: str | Path,
    filename: str | None = None,
    max_retries: int = 3,
) -> str | None:
    """
    调用通义万相生成图片，下载到本地，返回本地路径（增强版）

    特性：
    - 自动重试（最多 max_retries 次，指数退避）
    - 模型降级（主模型失败→备用模型）
    - 详细的失败原因追踪

    Args:
        prompt: 图片描述文字
        save_dir: 保存目录
        filename: 文件名（不含扩展名），默认自动生成 UUID
        max_retries: 每个模型的最大重试次数

    Returns:
        str: 本地文件路径，失败返回 None
    """
    cfg = get_image_gen_config()
    if not cfg or not cfg.get("api_key"):
        logger.warning("生图功能未启用或 API Key 未配置")
        return None

    dashscope.api_key = cfg["api_key"]

    save_path = Path(save_dir)
    save_path.mkdir(parents=True, exist_ok=True)
    filename = filename or uuid.uuid4().hex

    # 构建模型调用链
    model_chain = _build_model_chain(cfg["model"])

    # 使用全局信号量控制并发，避免触发 API 限流
    async with IMAGE_GEN_SEMAPHORE:
        size = cfg["size"]

        last_error = ""
        last_status = 0

        for model_idx, model in enumerate(model_chain):
            for attempt in range(1, max_retries + 1):
                logger.info(f"生图尝试: model={model} attempt={attempt}/{max_retries} prompt={prompt[:50]}...")

                # 阶段1: 调用生图 API（超时 180s）
                status_code, image_url, error_msg = await _call_dashscope_safe(
                    model=model, prompt=prompt, size=size, timeout=180,
                )

                if status_code == 200 and image_url:
                    # 阶段2: 下载图片（超时 60s）
                    local_path = await _download_image(image_url, save_path, filename, timeout=60)
                    if local_path:
                        return local_path
                    else:
                        last_error = f"模型{model}下载失败"
                        last_status = 0
                        # 下载失败也重试
                        continue
                else:
                    last_status = status_code
                    last_error = error_msg or f"HTTP {status_code}"

                    # 特定错误码无需重试（认证错误、参数错误等）
                    if status_code in (400, 401, 403):
                        logger.error(f"生图不可恢复错误: model={model} status={status_code} msg={error_msg}")
                        break  # 跳出重试循环，尝试下一个模型

                    # 退避等待
                    if attempt < max_retries:
                        wait = 2 ** attempt  # 2, 4, 8 秒
                        logger.warning(f"生图失败 ({last_error})，{wait}s 后重试 (attempt={attempt}/{max_retries})")
                        await asyncio.sleep(wait)

            # 如果当前模型成功就不继续降级
            if last_status == 200:
                break

            # 降级模型提示
            if model_idx < len(model_chain) - 1:
                logger.warning(f"模型 {model} 失败，降级到 {model_chain[model_idx + 1]}")
                # 重置重试状态
                last_status = 0
                last_error = ""

        logger.error(f"生图最终失败: prompt={prompt[:50]} 最后错误={last_error}")
        return None


async def generate_placeholders_batch(
    placeholders: list[dict],
    subject: str,
    media_dir: Path,
    qid: int,
    now: str,
) -> list[dict]:
    """
    批量处理一道题的所有占位符生图请求

    特性：
    - 顺序处理（每张图之间间隔 1s，避免限流）
    - 每张图独立重试，互不影响
    - 失败的占位符标记为 "failed" 状态

    Args:
        placeholders: 占位符列表，每项含 key/description/purpose
        subject: 科目名称
        media_dir: 图片保存目录
        qid: 题目 ID
        now: 当前时间字符串

    Returns:
        list[dict]: 生成的 media_files 列表
    """
    if not placeholders:
        return []

    from backend.prompts.chat import IMAGE_GEN_PROMPT_TEMPLATE

    media_files: list[dict] = []

    for idx, ph in enumerate(placeholders):
        # 每张图之间间隔至少 1 秒，避免触发限流
        if idx > 0:
            await asyncio.sleep(1)

        ph_prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
            subject=subject,
            purpose=ph.get("purpose", "示意图"),
            description=ph["description"],
        )

        from pathlib import Path as PPath
        local_path = await generate_and_save_image(ph_prompt, media_dir)
        if local_path:
            ph["status"] = "generated"
            media_files.append({
                "key": ph["key"],
                "type": "image",
                "url": f"/api/files/question_media/{qid}/{PPath(local_path).name}",
                "alt": ph["description"],
                "created_at": now,
            })
        else:
            ph["status"] = "failed"
            logger.warning(f"占位符生图失败 (qid={qid} key={ph.get('key','')}): {ph.get('description','')[:40]}")

    return media_files
