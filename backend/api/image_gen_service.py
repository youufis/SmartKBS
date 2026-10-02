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
import re
import uuid
from pathlib import Path
from typing import Any

import dashscope

from backend.ai_task_manager import report_progress

from backend.api.config_router import get_config_value
from backend.logger import logger

# ── 全局并发控制 ──
# 通义万相 API 并发限制较低，使用信号量控制最大并发数
IMAGE_GEN_SEMAPHORE = asyncio.Semaphore(2)

# 支持的模型列表（管理员可在系统配置里填其中之一；填别的也能用，只是会打警告）
# 说明：万相 2.7 / Qwen-Image 系列是 2026 年的现役代际，中文文字渲染明显好于 2.1/2.2；
# 默认值保持历史配置不变，避免已有部署一夜之间换成没开通的模型而全线生图失败。
SUPPORTED_MODELS = {
    "wanx2.1-t2i-turbo": "通义万相-快速（上一代）",
    "wanx2.1-t2i-plus": "通义万相-高质量（上一代）",
    "wan2.2-t2i-flash": "万相生图-快速",
    "wan2.2-t2i-plus": "万相生图-高质量",
    "wan2.5-t2i-preview": "万相 2.5",
    "wan2.6-t2i": "万相 2.6",
    "wan2.7-image": "万相 2.7（推荐）",
    "wan2.7-image-pro": "万相 2.7 Pro（4K）",
    "qwen-image-2.0": "Qwen-Image 2.0（中文标注准确）",
    "qwen-image-3.0-pro": "Qwen-Image 3.0 Pro（复杂排版）",
}

# 降级链：主模型失败后按此顺序尝试（去重后追加到调用链尾部）
FALLBACK_MODEL_CHAIN = ["wan2.2-t2i-flash", "wanx2.1-t2i-turbo"]

DEFAULT_MODEL = "wan2.2-t2i-flash"
DEFAULT_SIZE = "1024*1024"

#: 单次下载的体积上限（防止 CDN 返回异常大包撑爆磁盘）
MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

#: 不可重试的错误码：认证/参数/内容安全/模型不存在——换模型或重试都救不回来
TERMINAL_STATUS_CODES = {400, 401, 403, 404}
#: 命中这些关键词说明是账号/参数层面的死错，直接终止整条模型链
TERMINAL_ERROR_HINTS = (
    "invalidapikey", "api key", "arrearage", "insufficient", "quota",
    "model not exist", "not authorized", "unsupported model",
    "datainspectionfailed", "contentpolicy", "inappropriate",
)


def normalize_size(raw: str | None) -> str:
    """把生图尺寸配置规范成 API 认的写法

    管理员常在网页里手抖写成 1024x1024 / 1024 × 1024，DashScope 只认 ``宽*高``，
    否则会 400，再叠加 3 次重试 × 3 个模型 = 9 次无意义调用。
    另外放行 wan2.7 那一代的预设尺寸写法（1K/2K/4K）。
    """
    text = (raw or "").strip().lower().replace("\u00d7", "*").replace("x", "*")
    if not text:
        return DEFAULT_SIZE
    if text in {"1k", "2k", "4k"}:
        return text.upper()
    m = re.match(r"^(\d{3,5})\*(\d{3,5})$", text)
    if not m:
        return ""
    w, h = int(m.group(1)), int(m.group(2))
    if not (256 <= w <= 4096 and 256 <= h <= 4096):
        return ""
    return f"{w}*{h}"


def get_image_gen_config() -> dict[str, Any] | None:
    """读取生图配置，返回配置字典或 None（禁用/缺 Key 时）"""
    if not get_config_value("IMAGE_GEN_ENABLED", True):
        logger.debug("图片生成功能已禁用（IMAGE_GEN_ENABLED=False）")
        return None

    api_key = (os.environ.get("DASHSCOPE_API_KEY", "")
               or get_config_value("dashscope_api_key", "")
               or getattr(dashscope, 'api_key', ''))
    if not api_key:
        logger.warning("图片生成失败：API Key 未配置")
        return None

    model = (str(get_config_value("IMAGE_GEN_MODEL", DEFAULT_MODEL) or "").strip()
             or DEFAULT_MODEL)
    if model not in SUPPORTED_MODELS:
        # 不阻断：账号可能开了新模型而清单没更新；只提醒，便于排查"生图一直失败"
        logger.warning(f"生图模型 {model} 不在已知清单内，仍将尝试调用")

    size = normalize_size(get_config_value("IMAGE_GEN_SIZE", DEFAULT_SIZE))
    if not size:
        raw_size = get_config_value("IMAGE_GEN_SIZE", DEFAULT_SIZE)
        logger.warning(f"IMAGE_GEN_SIZE={raw_size!r} 不合法（应为 宽*高，如 {DEFAULT_SIZE}），已回落 {DEFAULT_SIZE}")
        size = DEFAULT_SIZE

    return {
        "api_key": api_key,
        "model": model,
        "size": size,
    }


async def _call_dashscope_safe(
    model: str,
    prompt: str,
    size: str,
    timeout: int,
) -> tuple[int, str | None, str | None, bool]:
    """安全调用 DashScope ImageSynthesis API

    Returns:
        (status_code, image_url, error_msg, terminal)
        terminal=True 表示换模型/重试都不会有结果（认证、参数、内容安全、模型不存在），
        调用方应当立刻结束整条降级链，而不是把 3 个模型各重试 3 次。
    """
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
                return (200, url, None, False)
            except (AttributeError, IndexError, KeyError) as e:
                # 200 但没图：多半是异步任务还没就绪或返回结构变化，重试无意义
                return (code, None, f"解析响应结果失败: {e}", True)
        msg = str(getattr(response, "message", "未知错误") or "未知错误")
        return (code, None, msg, _is_terminal_error(code, msg))
    except asyncio.TimeoutError:
        return (408, None, "生图请求超时", False)
    except Exception as e:
        text = str(e)
        return (500, None, text, _is_terminal_error(0, text))


def _is_terminal_error(code: int, message: str) -> bool:
    """判断是否为"重试与换模型都救不回来"的失败"""
    if code in TERMINAL_STATUS_CODES:
        return True
    lowered = (message or "").lower()
    return any(hint in lowered for hint in TERMINAL_ERROR_HINTS)


def _sniff_image_format(data: bytes) -> str:
    """按魔数判断图片真实格式；识别不出来返回空串

    万相返回的 URL 偶发会指向一段 HTML 错误页（限流/过期），旧实现不判断内容
    就一律存成 ``.png``，于是：① 配图管理里显示破图；② python-docx 认不出
    这种"扩展名说谎"的文件，组卷导出 Word 时整张配图被静默丢掉。
    """
    if len(data) < 12:
        return ""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:2] == b"BM":
        return "bmp"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return ""


def _encode_for_office(data: bytes, fmt: str) -> tuple[bytes, str]:
    """统一转成 Office/浏览器都稳妥的格式：png / jpg 原样，其余（webp/bmp）转 png"""
    if fmt in ("png", "jpg"):
        return data, fmt
    try:
        import io

        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            buf = io.BytesIO()
            im.convert("RGBA").save(buf, format="PNG")
            return buf.getvalue(), "png"
    except Exception as e:                                    # PIL 没装或解码失败
        logger.warning(f"图片格式 {fmt} 转换失败，按原格式保存: {e}")
        return data, fmt


async def _download_image(
    url: str,
    save_path: Path,
    filename: str,
    timeout: int = 60,
) -> str | None:
    """下载图片到本地，返回本地路径（扩展名与真实内容一致）"""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            img_resp = await client.get(url)
    except httpx.TimeoutException:
        logger.error(f"图片下载超时: {url[:60]}")
        return None
    except Exception as e:
        logger.error(f"图片下载异常: {e}")
        return None

    if img_resp.status_code != 200:
        logger.error(f"图片下载失败: HTTP {img_resp.status_code}")
        return None
    data = img_resp.content
    if not data:
        logger.error("图片下载失败: 返回内容为空")
        return None
    if len(data) > MAX_DOWNLOAD_BYTES:
        logger.error(f"图片下载失败: 超过 {MAX_DOWNLOAD_BYTES // 1024 // 1024}MB 上限")
        return None

    fmt = _sniff_image_format(data)
    if not fmt:
        head = data[:60].decode("utf-8", "replace").replace("\n", " ")
        logger.error(f"图片下载失败: 返回内容不是图片（{head!r}）")
        return None

    data, fmt = _encode_for_office(data, fmt)
    file_path = save_path / f"{filename}.{fmt}"
    try:
        file_path.write_bytes(data)
    except OSError as e:
        logger.error(f"图片写入失败: {file_path} - {e}")
        return None
    logger.info(f"图片下载成功: {file_path} ({len(data)} bytes, {fmt})")
    return str(file_path)


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
    error_sink: list[str] | None = None,
) -> str | None:
    """调用通义万相生成图片，下载到本地，返回本地路径（失败返回 None）

    特性：
    - 自动重试（指数退避，429 限流退避更久）
    - 模型降级（主模型失败 → FALLBACK_MODEL_CHAIN）
    - 终止性错误（认证失败 / 参数非法 / 内容安全 / 模型不存在）立刻收手，
      不再把整条模型链 × max_retries 全跑一遍（过去一次配错要白等 9 次调用）
    - error_sink: 失败原因回传通道，供端点把"到底为什么失败"告诉教师

    Args:
        prompt: 图片描述文字
        save_dir: 保存目录
        filename: 文件名（不含扩展名），默认自动生成 UUID
        max_retries: 每个模型的最大重试次数
        error_sink: 可选，传入 list 时追加失败原因字符串

    Returns:
        str: 本地文件路径，失败返回 None
    """
    cfg = get_image_gen_config()
    if not cfg or not cfg.get("api_key"):
        reason = "生图功能未启用或 API Key 未配置"
        logger.warning(reason)
        if error_sink is not None:
            error_sink.append(reason)
        return None

    dashscope.api_key = cfg["api_key"]

    save_path = Path(save_dir)
    try:
        save_path.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        reason = f"配图目录不可写: {save_path} ({e})"
        logger.error(reason)
        if error_sink is not None:
            error_sink.append(reason)
        return None

    filename = filename or uuid.uuid4().hex
    model_chain = _build_model_chain(cfg["model"])
    size = cfg["size"]

    # 全局信号量控并发，避免触发 API 限流
    async with IMAGE_GEN_SEMAPHORE:
        last_error = ""

        for model_idx, model in enumerate(model_chain):
            for attempt in range(1, max_retries + 1):
                logger.info(f"生图尝试: model={model} attempt={attempt}/{max_retries} prompt={prompt[:50]}...")
                report_progress(phase="image", model=model, attempt=attempt,
                                max_attempts=max_retries,
                                models_left=len(model_chain) - model_idx,
                                message=f"{model} 第 {attempt}/{max_retries} 次尝试")

                status_code, image_url, error_msg, terminal = await _call_dashscope_safe(
                    model=model, prompt=prompt, size=size, timeout=180,
                )

                if status_code == 200 and image_url:
                    report_progress(phase="download", model=model, message="图片已生成，正在下载")
                    local_path = await _download_image(image_url, save_path, filename, timeout=60)
                    if local_path:
                        return local_path
                    last_error = f"{model}: 图片下载失败（URL 可能已过期）"
                    continue

                last_error = f"{model}[HTTP {status_code}]: {error_msg or '未知错误'}"

                if terminal:
                    logger.error(f"生图终止性失败，不再重试与降级: {last_error}")
                    if error_sink is not None:
                        error_sink.append(last_error)
                    return None

                if attempt < max_retries:
                    # 限流退避更久，其余按 2/4/8 秒
                    wait = (5 * attempt) if status_code == 429 else (2 ** attempt)
                    logger.warning(f"生图失败 ({last_error})，{wait}s 后重试 (attempt={attempt}/{max_retries})")
                    await asyncio.sleep(wait)

            if model_idx < len(model_chain) - 1:
                logger.warning(f"模型 {model} 失败，降级到 {model_chain[model_idx + 1]}")
                report_progress(phase="fallback",
                                message=f"{model} 失败，改用 {model_chain[model_idx + 1]}")

        logger.error(f"生图最终失败: prompt={prompt[:50]} 最后错误={last_error}")
        if error_sink is not None and last_error:
            error_sink.append(last_error)
        return None


async def generate_placeholders_batch(
    placeholders: list[dict[str, Any]],
    subject: str,
    media_dir: Path,
    qid: int,
    now: str,
    error_sink: list[str] | None = None,
) -> list[dict[str, Any]]:
    """批量处理一道题的所有占位符生图请求

    特性：
    - 入口先做 ``normalize_placeholders``：丢掉缺 description 的畸形项，否则
      ``ph["description"]`` 会 KeyError 把整批已入库的题目带崩
    - 并发受全局信号量（2）约束，起跑时间错开，兼顾速度与限流
    - 单张图失败互不影响：整批用 ``return_exceptions=True`` 收口
    - 失败项在 placeholders 上标 ``failed``，成功标 ``generated``——**调用方需要把
      placeholders 一起写回数据库**，否则配图管理面板认不出状态（历史 bug 的成因）

    Args:
        placeholders: 占位符列表（原地更新 status）
        subject: 科目名称
        media_dir: 图片保存目录
        qid: 题目 ID（只用于拼 URL）
        now: 当前时间字符串
        error_sink: 失败原因回传通道

    Returns:
        list[dict]: 生成的 media_files 列表
    """
    from backend.prompts.chat import IMAGE_GEN_PROMPT_TEMPLATE
    from backend.question_media import (
        MAX_PLACEHOLDERS_PER_QUESTION,
        normalize_placeholders,
        url_for,
    )

    if not placeholders:
        return []

    # 只做结构清洗（丢畸形项），**不截断条目**：截断会把教师已有的占位符从库里悄悄删掉。
    # 花钱的次数改用"配额"控制 —— 超出配额的占位符保持原状态，面板上随时能手动生成。
    cleaned = normalize_placeholders(placeholders, limit=0)
    if len(cleaned) != len(placeholders):
        placeholders[:] = cleaned
    if not placeholders:
        return []

    try:
        quota = int(get_config_value("IMAGE_GEN_MAX_PLACEHOLDERS", MAX_PLACEHOLDERS_PER_QUESTION))
    except Exception:
        quota = MAX_PLACEHOLDERS_PER_QUESTION

    # 已经生成过的占位符不重复烧钱（重新生成单题时由调用方先清 manifest）
    already = {item.get("key") for item in placeholders
               if item.get("status") in ("generated", "uploaded")}

    todo: list[tuple[int, dict[str, Any]]] = []
    for idx, ph in enumerate(placeholders):
        if not str(ph.get("key") or "") or not str(ph.get("description") or ""):
            continue
        if ph.get("key") in already:
            continue
        if quota > 0 and len(todo) >= quota:
            break
        todo.append((idx, ph))
    todo_keys = {ph.get("key") for _i, ph in todo}
    skipped = [ph for ph in placeholders
               if str(ph.get("description") or "")
               and ph.get("key") not in already and ph.get("key") not in todo_keys]
    for ph in skipped:
        ph["status"] = "pending"      # 明确标成待配图，面板上才会出现"AI 生图"按钮
    if skipped:
        logger.info(f"单题生图配额 {quota} 已用满，{len(skipped)} 个占位符留待手动生成 (qid={qid})")

    async def _gen_one(index: int, ph: dict[str, Any]) -> dict[str, Any] | None:
        if index:
            await asyncio.sleep(0.4 * index)          # 错开起跑，避免同时打满限流
        key = str(ph.get("key") or "")
        description = str(ph.get("description") or "")
        if not key or not description or key in already:
            return None
        ph_prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
            subject=subject or "通用",
            purpose=ph.get("purpose") or "示意图",
            description=description,
        )
        errors: list[str] = []
        local_path = await generate_and_save_image(ph_prompt, media_dir, error_sink=errors)
        if not local_path:
            ph["status"] = "failed"
            reason = errors[0] if errors else "生图未返回图片"
            logger.warning(f"占位符生图失败 (qid={qid} key={key}): {reason}")
            if error_sink is not None:
                error_sink.append(f"{key}: {reason}")
            return None
        ph["status"] = "generated"
        return {
            "key": key,
            "type": "image",
            "url": url_for("bank", qid, Path(local_path).name),
            "alt": description,
            "created_at": now,
        }

    report_progress(phase="media", done=0, total=len(todo), message=f"配图 0/{len(todo)}")
    done_count = {"n": 0}

    async def _gen_one_tracked(index: int, item: dict[str, Any]):
        outcome = await _gen_one(index, item)
        done_count["n"] += 1
        report_progress(done=done_count["n"], total=len(todo),
                        message=f"配图 {done_count['n']}/{len(todo)}")
        return outcome

    results = await asyncio.gather(
        *[_gen_one_tracked(idx, ph) for idx, ph in todo],
        return_exceptions=True,
    )

    media_files: list[dict[str, Any]] = []
    for (_idx, ph), result in zip(todo, results):
        if isinstance(result, Exception):
            ph["status"] = "failed"
            logger.warning(f"占位符生图异常 (qid={qid} key={ph.get('key', '')}): {result}")
            if error_sink is not None:
                error_sink.append(f"{ph.get('key', '')}: {result}")
        elif isinstance(result, dict):
            media_files.append(result)
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
    """调用 AI 生成 SVG 教育示意图（已做安全清洗）

    Args:
        topic: 知识点主题
        purpose: SVG 用途说明（如"冒泡排序过程示意图"、"光的折射原理图"）
        api_key: API Key

    Returns:
        str: 安全 SVG 代码（含 <svg> 标签），失败返回 None
    """
    prompt = SVG_GENERATE_PROMPT.format(topic=topic, purpose=purpose)

    try:
        from backend.api.ai_service import call_ai_sync_with_timeout
        from backend.svg_safety import is_usable_svg, sanitize_ai_svg_output
        result = await call_ai_sync_with_timeout(prompt, api_key, timeout=120)
        if not result:
            return None

        svg_code = sanitize_ai_svg_output(result)
        if not is_usable_svg(svg_code):
            logger.warning(f"AI 返回内容未能提取或清洗出可用 SVG: {result[:100]}...")
            return None

        logger.info(f"SVG 生成成功: topic={topic}, purpose={purpose}, len={len(svg_code)}")
        return svg_code
    except TimeoutError:
        logger.warning(f"SVG 生成超时: topic={topic}")
        return None
    except Exception as e:
        logger.warning(f"SVG 生成失败: {e}")
        return None


def _figure_html(item: dict[str, Any]) -> str:
    """把一条媒体项渲染成 HTML 片段（用于画廊兜底）"""
    import html as _html
    alt = _html.escape(str(item.get("alt") or item.get("purpose") or ""), quote=True)
    if item.get("type") == "svg":
        return f'<div class="media-figure">\n{item["content"]}\n<p class="media-caption">{alt}</p>\n</div>'
    src = _html.escape(str(item.get("content") or ""), quote=True)
    return (f'<div class="media-figure">\n'
            f'<img src="{src}" alt="{alt}" loading="lazy" '
            f'style="max-width:100%;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.1);">\n'
            f'<p class="media-caption">{alt}</p>\n</div>')


def _match_placeholder(item: dict[str, Any], ph_text: str) -> bool:
    """媒体项是否对应 HTML 里的这个 ``<!-- SVG:xxx -->`` 占位符"""
    if not ph_text:
        return False
    alt = str(item.get("alt") or "").strip()
    purpose = str(item.get("purpose") or "").strip()
    for candidate in (alt, purpose):
        if not candidate:
            continue
        if candidate in ph_text or ph_text in candidate:
            return True
        if candidate[:30] and candidate[:30] in ph_text:
            return True
    return any(kw and kw in ph_text for kw in (item.get("keywords") or []) if isinstance(kw, str))


def _inject_media_into_html(
    html_content: str,
    media_items: list[dict[str, Any]],
) -> str:
    """将生成的 SVG/图片注入 HTML

    策略：
    1. 逐个匹配 HTML 里的 ``<!-- SVG:描述 -->`` 占位符，就地换成对应素材；
    2. 没匹配上占位符的素材，追加到 </body> 前的「相关图示」画廊。

    两条历史坑必须守住：
    - 画廊只能放**未被注入过**的素材，否则同一张图在页面里出现两遍；
    - 替换用字面 ``str.replace``，不能用 ``re.sub``——SVG 源码里的 ``\\1``、
      ``\\g<0>`` 会被 re 当反向引用解释，图就废了。
    """
    if not media_items:
        return html_content

    modified = html_content
    injected_ids: set[int] = set()      # 只在本函数内记账，不回头改调用方传入的 dict

    for ph_match in list(re.finditer(r'<!--\s*SVG:([^>]*?)\s*-->', html_content)):
        occurrence = ph_match.group(0)
        ph_text = ph_match.group(1).strip()
        if not ph_text:
            continue
        matched = None
        for item in media_items:
            if id(item) in injected_ids or item.get("_injected") is True:
                continue
            if _match_placeholder(item, ph_text):
                matched = item
                break
        if matched is None:
            continue
        injected_ids.add(id(matched))
        modified = modified.replace(occurrence, str(matched.get("content") or ""), 1)

    remaining = [item for item in media_items
                 if id(item) not in injected_ids and item.get("_injected") is not True]
    if not remaining:
        return modified

    gallery_items = [_figure_html(item) for item in remaining if item.get("content")]
    if not gallery_items:
        return modified

    gallery_html = (
        '\n<!-- auto-generated media gallery -->\n'
        '<div class="media-gallery" style="margin:30px 0;padding:20px;'
        'background:var(--card-bg,#f9f9f9);border-radius:12px;">\n'
        '<h3 style="margin-bottom:16px;font-size:1.1em;color:var(--text,#333);">'
        '📊 相关图示</h3>\n'
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));'
        'gap:20px;">\n'
        + "\n".join(gallery_items) +
        '\n</div>\n</div>\n<!-- end media gallery -->\n'
    )
    last_body_close = modified.rfind("</body>")
    if last_body_close != -1:
        modified = modified[:last_body_close] + gallery_html + "\n" + modified[last_body_close:]
    else:
        modified = modified + gallery_html

    gallery_style = (
        "\n/* auto-generated media styles */\n"
        ".media-figure { text-align:center; }\n"
        ".media-figure svg { max-width:100%; height:auto; border-radius:8px; }\n"
        ".media-caption { margin-top:8px; font-size:0.9em; color:#666; text-align:center; }\n"
    )
    if ".media-figure" not in modified:
        first_style_close = modified.find("</style>")
        if first_style_close != -1:
            modified = modified[:first_style_close] + gallery_style + "\n" + modified[first_style_close:]

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
  {{"type":"svg","purpose":"冒泡排序流程图","description":"冒泡排序的完整流程图，包含比较和交换步骤","keywords":["排序","流程","算法"]}},
  {{"type":"image","purpose":"排序对比示意图","description":"展示不同排序算法速度对比的示意图","keywords":["排序","对比","性能"]}}
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

    流程：1) AI 规划素材 → 2) SVG 并行生成 → 3) 图片串行生成（限流）→ 4) 注入 HTML

    Args:
        html_content: 原始 HTML 内容
        topic: 知识点主题
        subject: 学科
        resource_type: 资源类型
        api_key: API Key
        html_dir: HTML 文件保存目录（图片下载到此目录下的 _media）

    Returns:
        str: 增强后的 HTML 内容（含配图）；任何一步失败都原样返回，绝不把课件生成带崩
    """
    html_title = _extract_html_title_fast(html_content) or topic
    html_preview = html_content[:1000]

    plan_prompt = MEDIA_PLAN_PROMPT.format(
        html_title=html_title,
        resource_type=resource_type,
        topic=topic,
        subject=subject or "通用",
        html_preview=html_preview,
    )

    media_plan: list[dict[str, Any]] = []
    try:
        from backend.api.ai_service import call_ai_sync_with_timeout
        plan_result = await call_ai_sync_with_timeout(plan_prompt, api_key, timeout=60)
        if not plan_result:
            # 模型没回东西属于正常分支（过去这里没初始化 media_plan，直接 NameError 抛穿）
            logger.info("配图规划无返回，跳过配图")
            return html_content

        from backend.json_repair import try_parse_repaired
        parsed = try_parse_repaired(plan_result)
        if isinstance(parsed, list):
            media_plan = [item for item in parsed if isinstance(item, dict)]
        else:
            logger.info(f"配图规划返回非 JSON 数组，跳过配图: {plan_result[:80]}...")
            return html_content
    except Exception as e:
        logger.warning(f"配图规划失败（跳过配图生成）: {e}")
        return html_content

    if not media_plan:
        return html_content

    # 上限由代码兜住，不能只写在提示词里："总数 ≤3、图片 ≤2"
    media_plan = media_plan[:3]
    image_quota = 2
    svg_items = [item for item in media_plan if item.get("type") == "svg"]
    image_items = []
    for item in media_plan:
        if item.get("type") != "svg" and image_quota > 0:
            image_items.append(item)
            image_quota -= 1

    media_items: list[dict[str, Any]] = []
    if svg_items:
        svg_results = await asyncio.gather(
            *[_generate_svg_item(item, topic, api_key) for item in svg_items],
            return_exceptions=True,
        )
        for item, result in zip(svg_items, svg_results):
            if isinstance(result, dict) and result.get("content"):
                media_items.append(result)
            elif isinstance(result, Exception):
                logger.warning(f"SVG 生成异常: {result}")

    for item in image_items:
        img_result = await _generate_image_item(item, topic, subject, html_dir)
        if img_result:
            media_items.append(img_result)
        await asyncio.sleep(0.5)

    if not media_items:
        logger.info("未生成任何配图")
        return html_content

    logger.info(
        f"配图生成完成: {len(media_items)} 项 "
        f"(SVG={sum(1 for m in media_items if m['type'] == 'svg')}, "
        f"图片={sum(1 for m in media_items if m['type'] == 'image')})"
    )
    return _inject_media_into_html(html_content, media_items)


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
    """生成单个图片配图项（调用万相）

    提示词与题库路径共用 ``IMAGE_GEN_PROMPT_TEMPLATE``：过去这里单独写了一套
    「图片中不要包含文字标注」，题库那套却写着「标注关键部分」，同一个模型收到
    相反指令，中文标注必然糊。
    """
    from backend.prompts.chat import IMAGE_GEN_PROMPT_TEMPLATE
    description = item.get("description") or item.get("purpose") or "示意图"
    purpose = item.get("purpose") or "示意图"
    keywords = item.get("keywords", [])

    img_prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
        subject=subject or "通用",
        purpose=purpose,
        description=f"围绕「{topic}」的教学插图：{description}",
    )

    media_dir = Path(html_dir) / "_media"
    filename = f"img_{uuid.uuid4().hex[:12]}"

    errors: list[str] = []
    local_path = await generate_and_save_image(img_prompt, media_dir, filename, error_sink=errors)
    if not local_path:
        logger.warning(f"课件配图生成失败: {topic} / {purpose} -> {errors[:1]}")
        return None

    file_name = Path(local_path).name
    try:
        rel_path = Path(local_path).relative_to(BASE_DIR).as_posix()
    except (ValueError, NameError):
        rel_path = f"question_media/_html/{file_name}"
    return {
        "type": "image",
        "content": f"/api/files/{rel_path}",
        "alt": description,
        "purpose": purpose,
        "keywords": keywords,
    }
