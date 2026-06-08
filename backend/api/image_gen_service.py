"""
AI 图片生成服务
从系统配置读取生图参数，调用通义万相（OpenAI 兼容接口 / DashScope SDK）

API Key 复用现有的 dashscope_api_key（环境变量 > 系统配置）。
支持模型：
  - wanx2.1-t2i-turbo（快速）
  - wanx2.1-t2i-plus（高清）
  - wan2.2-t2i-flash（默认推荐，最新万相生图模型）
"""
import asyncio
import os
import uuid
from pathlib import Path

import dashscope

from backend.api.config_router import get_config_value
from backend.logger import logger

# 支持的模型列表（仅供展示参考，实际以系统配置为准）
SUPPORTED_MODELS = {
    "wanx2.1-t2i-turbo": "通义万相-快速",
    "wanx2.1-t2i-plus": "通义万相-高质量",
    "wan2.2-t2i-flash": "万相生图-最新（默认）",
}


def get_image_gen_config() -> dict | None:
    """读取生图配置，返回配置字典或 None（禁用时）

    API Key 获取优先级：
    1. 环境变量 DASHSCOPE_API_KEY
    2. 系统配置 dashscope_api_key
    3. dashscope 库默认的 api_key（由 SDK 自身管理）
    """
    if not get_config_value("IMAGE_GEN_ENABLED", True):
        logger.debug("图片生成功能已禁用（IMAGE_GEN_ENABLED=False）")
        return None

    # 复用对话模型的 API Key（优先级：环境变量 > 系统配置 > dashscope SDK 默认）
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
        "api_base": get_config_value(
            "QWEN_OPENAI_API_BASE",
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
        ),
    }


async def generate_and_save_image(
    prompt: str,
    save_dir: str | Path,
    filename: str | None = None,
) -> str | None:
    """
    调用通义万相生成图片，下载到本地，返回本地路径

    使用 DashScope SDK 的 ImageSynthesis API，复用系统已有的 API Key。
    优先级：环境变量 DASHSCOPE_API_KEY > 系统配置 > dashscope SDK 默认。

    Args:
        prompt: 图片描述文字
        save_dir: 保存目录（如 backend/question_media/{question_id}/）
        filename: 文件名（不含扩展名），默认自动生成 UUID

    Returns:
        str: 本地文件路径，失败返回 None
    """
    cfg = get_image_gen_config()
    if not cfg or not cfg.get("api_key"):
        logger.warning("生图功能未启用或 API Key 未配置")
        return None

    # 设置 DashScope SDK 的 API Key
    dashscope.api_key = cfg["api_key"]

    save_path = Path(save_dir)
    save_path.mkdir(parents=True, exist_ok=True)
    filename = filename or uuid.uuid4().hex

    try:
        # 调用 DashScope ImageSynthesis API（通过线程池运行，避免阻塞事件循环）
        response = await asyncio.to_thread(
            dashscope.ImageSynthesis.call,
            model=cfg["model"],
            prompt=prompt,
            n=1,
            size=cfg["size"],
            timeout=120,  # 设置生图超时 120 秒
        )

        if response.status_code != 200:
            logger.error(f"通义万相 API 调用失败: {response.status_code} {response.message}")
            return None

        # 获取生成的图片 URL
        image_url = response.output.results[0].url

        # 下载图片到本地
        import httpx
        file_path = save_path / f"{filename}.png"
        async with httpx.AsyncClient(timeout=120) as client:
            img_resp = await client.get(image_url)
            if img_resp.status_code == 200:
                file_path.write_bytes(img_resp.content)
                logger.info(f"图片生成成功: {file_path}")
                return str(file_path)
            else:
                logger.error(f"图片下载失败: {img_resp.status_code}")
                return None

    except asyncio.TimeoutError:
        logger.error(f"生图超时: prompt={prompt[:50]}")
        return None
    except Exception as e:
        logger.error(f"生图异常: {e}")
        return None
