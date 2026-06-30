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
from typing import Any

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


def get_image_gen_config() -> dict[str, Any] | None:
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
    placeholders: list[dict[str, Any]],
    subject: str,
    media_dir: Path,
    qid: int,
    now: str,
) -> list[dict[str, Any]]:
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

    media_files: list[dict[str, Any]] = []

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


# ═══════════════════════════════════════════════════════════
# SVG 生成 + HTML 配图增强（用于 AI 生成 HTML 资源）
# ═══════════════════════════════════════════════════════════

SVG_GENERATE_PROMPT = """你是一个专业的 SVG 教育图表设计师。请根据以下主题，生成一个纯 SVG 教育示意图。

## ◈ 主题
{topic}

## ◈ 用途
{purpose}

## ◈ 设计要求
- 输出**纯 SVG 代码**，用 ```svg ... ``` 包裹，不要加任何解释
- SVG 必须包含 viewBox，建议 viewBox="0 0 800 500"
- 使用合适的颜色、标注文字（中文）、图例
- 清晰展示知识点核心概念
- 适合课堂教学展示，文字大小适中
- 不要包含任何外部资源引用
- 使用现代扁平化设计风格
"""


async def generate_svg_via_ai(
    topic: str,
    purpose: str,
    api_key: str,
) -> str | None:
    """调用 AI 生成 SVG 教育示意图

    Args:
        topic: 知识点主题
        purpose: SVG 用途说明（如"冒泡排序过程示意图"、"光的折射原理图"）
        api_key: API Key

    Returns:
        str: 纯 SVG 代码（含 <svg> 标签），失败返回 None
    """
    prompt = SVG_GENERATE_PROMPT.format(topic=topic, purpose=purpose)

    try:
        from backend.api.ai_service import call_ai_sync_with_timeout
        result = await call_ai_sync_with_timeout(prompt, api_key, timeout=120)
        if not result:
            return None

        # 提取 SVG 代码
        import re
        svg_match = re.search(r'```svg\s*(<svg[^>]*>.*?</svg>)\s*```', result, re.DOTALL | re.IGNORECASE)
        if svg_match:
            svg_code = svg_match.group(1).strip()
        else:
            # 尝试直接匹配 <svg> 标签
            svg_match = re.search(r'(<svg[^>]*>.*?</svg>)', result, re.DOTALL | re.IGNORECASE)
            if svg_match:
                svg_code = svg_match.group(1).strip()
            else:
                logger.warning(f"AI 返回内容未能提取 SVG: {result[:100]}...")
                return None

        if len(svg_code) < 100:
            logger.warning(f"SVG 代码过短: {len(svg_code)} chars")
            return None

        logger.info(f"SVG 生成成功: topic={topic}, purpose={purpose}, len={len(svg_code)}")
        return svg_code
    except TimeoutError:
        logger.warning(f"SVG 生成超时: topic={topic}")
        return None
    except Exception as e:
        logger.warning(f"SVG 生成失败: {e}")
        return None


def _inject_media_into_html(
    html_content: str,
    media_items: list[dict[str, str]],
) -> str:
    """将生成的 SVG/图片注入到 HTML 中的合适位置

    策略：
    1. 如果 HTML 中有 <!-- SVG:xxx --> 占位符，替换它们
    2. 否则在 <body> 末尾、</body> 前插入配图区域
    """
    if not media_items:
        return html_content

    modified = html_content

    # 策略1: 替换占位符 <!-- SVG:描述 -->
    import re
    for item in media_items:
        placeholder_desc = item.get("alt", item.get("purpose", ""))[:30]
        # 尝试精确匹配占位符
        pattern = re.escape(f"<!-- SVG:{placeholder_desc} -->")
        replacement = item["content"]
        if re.search(pattern, modified):
            modified = re.sub(pattern, replacement, modified)
            item["_injected"] = True
            continue

        # 尝试模糊匹配
        for ph_match in re.finditer(r'<!--\s*SVG:([^>]*?)\s*-->', modified):
            ph_text = ph_match.group(1).strip()
            # 如果占位符描述包含在 item 描述中，或反之
            if (placeholder_desc in ph_text or ph_text in placeholder_desc
                    or any(kw in ph_text for kw in item.get("keywords", []))):
                modified = modified.replace(ph_match.group(0), replacement)
                item["_injected"] = True
                break

    # 策略2: 对尚未被替换的媒体项，在 </body> 前插入配图画廊
    remaining_items = [item for item in media_items if item.get("_injected") != True]
    if remaining_items:
        # 为剩余的媒体项创建画廊
        gallery_items = []
        for item in media_items:
            if item["type"] == "svg":
                gallery_items.append(
                    f'<div class="media-figure">\n{item["content"]}\n'
                    f'<p class="media-caption">{item.get("alt", "")}</p>\n</div>'
                )
            elif item["type"] == "image":
                gallery_items.append(
                    f'<div class="media-figure">\n'
                    f'<img src="{item["content"]}" alt="{item.get("alt", "")}" '
                    f'style="max-width:100%;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.1);">\n'
                    f'<p class="media-caption">{item.get("alt", "")}</p>\n</div>'
                )

        if gallery_items:
            gallery_html = (
                '\n<!-- auto-generated media gallery -->\n'
                '<div class="media-gallery" style="margin:30px 0;padding:20px;'
                'background:var(--card-bg,#f9f9f9);border-radius:12px;">\n'
                '<h3 style="margin-bottom:16px;font-size:1.1em;color:var(--text,#333);">'
                '📊 相关图示</h3>\n'
                '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));'
                'gap:20px;">\n'
                + '\n'.join(gallery_items) +
                '\n</div>\n</div>\n<!-- end media gallery -->\n'
            )
            # 在 </body> 前插入（只替换最后一个 </body>，确保插入到末尾）
            last_body_close = modified.rfind('</body>')
            if last_body_close != -1:
                modified = modified[:last_body_close] + gallery_html + '\n' + modified[last_body_close:]

            # 添加画廊样式（如果还没有，在第一个 </style> 后追加）
            gallery_style = (
                '\n/* auto-generated media styles */\n'
                '.media-figure { text-align:center; }\n'
                '.media-figure svg { max-width:100%; height:auto; border-radius:8px; }\n'
                '.media-caption { margin-top:8px; font-size:0.9em; color:#666; text-align:center; }\n'
            )
            if gallery_style not in modified:
                first_style_close = modified.find('</style>')
                if first_style_close != -1:
                    modified = modified[:first_style_close] + gallery_style + '\n' + modified[first_style_close:]

    return modified


# ── 配图规划提示词 ──

MEDIA_PLAN_PROMPT = """你是教育多媒体设计师。请分析以下 HTML 教学资源内容，规划需要补充哪些视觉素材（SVG 示意图 + 实景图片）。

## ◈ HTML 标题
{html_title}

## ◈ 资源类型
{resource_type}

## ◈ 资源主题
{topic}

## ◈ 学科
{subject}

## ◈ 当前 HTML 内容预览（前 1000 字符）
{html_preview}

## ◈ 输出格式要求
请分析上述内容，输出一个 JSON 数组，表示需要补充的视觉素材。
每个素材包含：
- "type": "svg" 或 "image"
- "purpose": 简短用途描述（10字内）
- "description": 详细描述，说清楚要画什么（20-50字）
- "keywords": 匹配占位符的关键词数组（用于在 HTML 中定位）

**重要规则**：
1. SVG 适合：流程图、结构图、原理图、对比图、步骤图、数据可视化
2. 图片适合：实景示意图、物理现象、化学实验装置、历史场景
3. 总数不超过 3 个（SVG 优先，最多 2 张图片）
4. 如果 HTML 中已有 Canvas 或大量 SVG，则只补充 1-2 个

**输出格式**（纯 JSON 数组，不要 markdown 标记）：
```json
[
  {"type":"svg","purpose":"冒泡排序流程图","description":"冒泡排序的完整流程图，包含比较和交换步骤","keywords":["排序","流程","算法"]},
  {"type":"image","purpose":"排序对比示意图","description":"展示不同排序算法速度对比的示意图","keywords":["排序","对比","性能"]}
]
```
如果没有需要补充的视觉素材，返回空数组 []。
"""


async def plan_and_generate_media(
    html_content: str,
    topic: str,
    subject: str,
    resource_type: str,
    api_key: str,
    html_dir: str,
) -> str:
    """规划并生成配图，注入 HTML

    流程：
    1. 分析 HTML 内容，规划需要的 SVG 和图片
    2. 并行生成 SVG（AI 调用）
    3. 串行生成图片（万相 API，需控制并发）
    4. 注入到 HTML 并返回增强后的内容

    Args:
        html_content: 原始 HTML 内容
        topic: 知识点主题
        subject: 学科
        resource_type: 资源类型
        api_key: API Key
        html_dir: HTML 文件保存目录（图片下载到此）

    Returns:
        str: 增强后的 HTML 内容（含配图）
    """
    html_title = _extract_html_title_fast(html_content) or topic
    html_preview = html_content[:1000]

    # ── 步骤1: 规划配图 ──
    plan_prompt = MEDIA_PLAN_PROMPT.format(
        html_title=html_title,
        resource_type=resource_type,
        topic=topic,
        subject=subject or "通用",
        html_preview=html_preview,
    )

    media_plan_json = None
    try:
        from backend.api.ai_service import call_ai_sync_with_timeout
        plan_result = await call_ai_sync_with_timeout(plan_prompt, api_key, timeout=60)
        if plan_result:
            # 提取 JSON
            import re as _re
            json_match = _re.search(r'```(?:json)?\s*(\[[\s\S]*?\])\s*```', plan_result, re.DOTALL)
            if json_match:
                media_plan_json = json_match.group(1)
            else:
                json_match = _re.search(r'(\[[\s\S]*?\])', plan_result, re.DOTALL)
                if json_match:
                    media_plan_json = json_match.group(1)

            if media_plan_json:
                import json as _json
                media_plan = _json.loads(media_plan_json)
                logger.info(f"配图规划完成: 共 {len(media_plan)} 项")
            else:
                logger.info("配图规划未返回有效 JSON")
                return html_content
    except Exception as e:
        logger.warning(f"配图规划失败（跳过配图生成）: {e}")
        return html_content

    if not media_plan_json or not media_plan:
        return html_content

    # ── 步骤2: 生成配图 ──
    media_items = []

    # 先并行生成所有 SVG
    svg_tasks = []
    for item in media_plan:
        if item.get("type") == "svg":
            svg_tasks.append(_generate_svg_item(item, topic, api_key))

    if svg_tasks:
        svg_results = await asyncio.gather(*svg_tasks, return_exceptions=True)
        for result in svg_results:
            if isinstance(result, dict) and result.get("content"):
                media_items.append(result)
            elif isinstance(result, Exception):
                logger.warning(f"SVG 生成异常: {result}")

    # 再串行生成图片（控制并发）
    image_count = 0
    for item in media_plan:
        if item.get("type") == "image" and image_count < 2:  # 最多 2 张图片
            img_result = await _generate_image_item(item, topic, subject, html_dir)
            if img_result:
                media_items.append(img_result)
                image_count += 1
            await asyncio.sleep(0.5)  # 间隔防止限流

    if not media_items:
        logger.info("未生成任何配图")
        return html_content

    logger.info(f"配图生成完成: {len(media_items)} 项 (SVG={sum(1 for m in media_items if m['type']=='svg')}, 图片={sum(1 for m in media_items if m['type']=='image')})")

    # ── 步骤3: 注入 HTML ──
    enhanced_html = _inject_media_into_html(html_content, media_items)
    return enhanced_html


def _extract_html_title_fast(html_content: str) -> str:
    """快速从 HTML 中提取标题"""
    import re
    m = re.search(r'<title[^>]*>(.*?)</title>', html_content, re.DOTALL)
    if m:
        return m.group(1).strip()
    m = re.search(r'<h1[^>]*>(.*?)</h1>', html_content, re.DOTALL)
    if m:
        # 去除 HTML 标签
        return re.sub(r'<[^>]+>', '', m.group(1)).strip()
    return ""


async def _generate_svg_item(
    item: dict,
    topic: str,
    api_key: str,
) -> dict | None:
    """生成单个 SVG 配图项"""
    purpose = item.get("purpose", "示意图")
    description = item.get("description", purpose)
    keywords = item.get("keywords", [])

    svg_code = await generate_svg_via_ai(topic, description, api_key)
    if svg_code:
        return {
            "type": "svg",
            "content": svg_code,
            "alt": description,
            "purpose": purpose,
            "keywords": keywords,
        }
    return None


async def _generate_image_item(
    item: dict,
    topic: str,
    subject: str,
    html_dir: str,
) -> dict | None:
    """生成单个图片配图项（调用万相）"""
    description = item.get("description", item.get("purpose", "示意图"))
    keywords = item.get("keywords", [])

    # 构建生图 Prompt
    img_prompt = (
        f"为「{topic}」教学绘制一张{description}。"
        f"风格：清晰准确，适合课堂教学使用，标注关键部分。"
        f"图片中不要包含文字标注。"
    ) if subject else (
        f"绘制一张{description}。风格清晰教学用。不要包含文字。"
    )

    # 保存到 html_dir 下的 media 子目录
    media_dir = Path(html_dir) / "_media"
    import uuid
    filename = f"img_{uuid.uuid4().hex[:12]}"

    local_path = await generate_and_save_image(img_prompt, media_dir, filename)
    if local_path:
        # 转换为相对项目根目录的路径 URL
        # 从 BASE_DIR 计算相对路径（兼容教师和学生目录结构）
        try:
            from backend.config import BASE_DIR
            rel_path = Path(local_path).relative_to(BASE_DIR).as_posix()
        except (ValueError, ImportError):
            # 降级：尝试从 html_dir 向上推算
            try:
                rel_path = Path(local_path).relative_to(
                    Path(html_dir).parent.parent
                ).as_posix()
            except ValueError:
                logger.warning(f"图片路径计算失败: {local_path}")
                return None
        return {
            "type": "image",
            "content": f"/api/files/{rel_path}",
            "alt": description,
            "purpose": item.get("purpose", "示意图"),
            "keywords": keywords,
        }
    return None
