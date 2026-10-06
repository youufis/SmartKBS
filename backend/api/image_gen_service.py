"""
AI 图片生成服务（增强版）
从系统配置读取生图参数，调用通义万相（OpenAI 兼容接口 / DashScope SDK）

增强特性：
  - 自动重试（3次，指数退避）
  - 模型降级（主模型失败→备用快速模型）
  - 更细粒度的超时控制
  - 详细的失败原因日志

API Key 复用现有的 dashscope_api_key（环境变量 > 系统配置）。

两代端点（2026-10-06 实测，这是本文件最容易踩的坑）
  image_synthesis  = dashscope.ImageSynthesis（text2image 端点）：wan2.2 / wanx2.1 这一代，
                     尺寸只认 宽*高，且宽高实测需在 512~1440。
  image_generation = dashscope.aigc.image_generation（多模态端点）：wan2.7 / qwen-image 这一代，
                     尺寸可用 宽*高，也可用 1K/2K/4K 预设。
  跨端点调用直接 400 —— 而旧版配置说明恰恰推荐 wan2.7-image，照说明改就全线生不出图。
  现在按 model_catalog 里每个模型的 endpoint 自动分派，降级链也按各自端点重新装配参数。

"HTTP 200 但其实失败了"（同样实测）
  老端点收到不属于自己的尺寸（如 size=1K）、或产物被内容审核拦下时，状态码是 200、
  也不抛异常，真原因只在 output.task_status=FAILED + output.code/message 里。
  旧实现只报"解析响应结果失败"，管理员无从判断；现在把服务端原文带出来。

模型优先级：系统配置 IMAGE_GEN_MODEL → FALLBACK_MODEL_CHAIN 依次兜底（跨端点也兜，
  因为参数按每个模型自己的端点装配）。
"""
import asyncio
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

import dashscope

from backend.ai_task_manager import report_progress

from backend.api.config_router import get_config_value
from backend.model_catalog import (DEFAULT_IMAGE_MODEL, describe_size_rule, image_endpoint_of,
                                   options_for, preset_values_for, size_ok)
from backend.logger import logger

# ── 全局并发控制 ──
# 通义万相 API 并发限制较低，使用信号量控制最大并发数
IMAGE_GEN_SEMAPHORE = asyncio.Semaphore(2)

# 模型清单、端点归属、尺寸档位与允许范围统一由 backend/model_catalog.py 维护
# （含 2026-10-06 实测边界：老端点宽高 512~1440；wan2.6-t2i 实测不可用，已从清单里去掉）。
# 这个别名保留是给老引用用的，值来自同一份目录，不再各处抄一遍。
SUPPORTED_MODELS = {m["id"]: m["note"] for m in options_for("image")}

# 降级链：主模型失败后按此顺序尝试（去重后追加到调用链尾部）。
# 两个都是"实测仍可用"的老端点模型，留作最后兜底 —— 新端点模型万一账号没开通还能出图。
FALLBACK_MODEL_CHAIN = ["wan2.2-t2i-flash", "wanx2.1-t2i-turbo"]

DEFAULT_MODEL = DEFAULT_IMAGE_MODEL

#: "自动"：不传 size，让模型用它自己的默认值（实测两代端点都能正常出图，是最省心的档）
AUTO_SIZE = "auto"
_PRESET_TOKENS = {"1k", "2k", "4k"}   # 具体哪档可用由 model_catalog 的实测目录判
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
    # 实测：尺寸越界与参数非法都是这一类 —— 换模型、重试都救不回来，只会白等 9 次
    "invalidparameter", "should be between",
)


def normalize_size(raw: str | None, model: str | None = None) -> str:
    """把生图尺寸配置规范成 API 认的写法；不合法返回空串。

    管理员常手抖写成 1024x1024 / 1024 × 1024 / 全角，DashScope 只认 ``宽*高``，
    否则会 400，再叠加 3 次重试 × 3 个模型 = 9 次无意义调用。

    传了 model 就按它自己的实测规则校验（model_catalog.SIZE_RULES）：
      - ``auto`` 一律合法（含义是不传 size）；
      - 预设 token 只有部分模型接受（实测 wan2.7 收 1K/2K、4K 被拒；老端点只认 宽*高），
        而老端点收到不属于自己的写法会变成"HTTP 200 但任务 FAILED"，所以在这里就判掉；
      - 宽高是按边长判还是按面积判，各家不同，交给 size_ok。
    """
    text = (str(raw or "").strip().lower()
            .replace("\u00d7", "*").replace("x", "*").replace("\u3000", "").replace(" ", ""))
    if not text:
        return DEFAULT_SIZE
    if text == AUTO_SIZE:
        return AUTO_SIZE
    if text in _PRESET_TOKENS:
        # 没给模型就不替调用方下判断；给了就按该模型实测接受的预设判
        if model is None:
            return text.upper()
        return text.upper() if text in preset_values_for(model) else ""
    m = re.match(r"^(\d{3,5})\*(\d{3,5})$", text)
    if not m:
        return ""
    w, h = int(m.group(1)), int(m.group(2))
    return f"{w}*{h}" if size_ok(model, w, h) else ""


def size_for_call(model: str, configured: str) -> tuple[str | None, str]:
    """按模型所在端点解析出真正要发送的 size，返回 (要发的值或 None, 人话说明)。

    降级链换端点时原尺寸可能不再合法（如 4K 到了老端点）—— 这里回落到常用档而不是
    把非法值发出去，避免"降级反而必然失败"。
    """
    raw = str(configured or "").strip()
    if not raw or raw.lower() == AUTO_SIZE:
        return None, "auto（不传 size，用模型默认值）"
    ok = normalize_size(raw, model)
    if ok and ok.lower() != AUTO_SIZE:
        return ok, ok
    return DEFAULT_SIZE, (f"{raw} 不适用于 {model}（{describe_size_rule(model)}），"
                          f"已改用 {DEFAULT_SIZE}")


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

    endpoint = image_endpoint_of(model)
    raw_size = str(get_config_value("IMAGE_GEN_SIZE", AUTO_SIZE) or "").strip()
    size = normalize_size(raw_size, model)
    size_note = size or AUTO_SIZE
    if not size:
        # 以前这里静默回落，管理员以为配的是 2048 实际出的是 1024 —— 把回落原因带出去，
        # 自检接口与日志都能看到（generate_and_save_image 也照旧继续，不阻断教学）。
        size = DEFAULT_SIZE
        size_note = (f"{raw_size!r} 不适用于 {model}（{describe_size_rule(model)}），"
                     f"已回落 {DEFAULT_SIZE}")
        logger.warning(f"IMAGE_GEN_SIZE={raw_size!r} {size_note}")

    return {
        "api_key": api_key,
        "model": model,
        "endpoint": endpoint,
        "size": size,
        "size_raw": raw_size,
        "size_note": size_note,
    }


def _pick(obj: Any, key: str, default: Any = None) -> Any:
    """output 有时是 dict、有时是带属性的对象，两种都取一次，避免结构变化就解析失败"""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _task_failure(out: Any) -> tuple[bool, str]:
    """老端点把失败藏在 output 里（HTTP 仍是 200）：task_status=FAILED + code/message。

    实测两种情形都是这个形状：尺寸不属于该端点（InvalidParameter: Either width or
    height should be between 512 and 1440）、产物被内容审核拦下。旧实现看不见它们，
    只会报"解析响应结果失败"，所以这里先读 task_status。
    """
    status = str(_pick(out, "task_status") or "").upper()
    if status and status != "SUCCEEDED":
        code = str(_pick(out, "code") or "").strip()
        msg = str(_pick(out, "message") or "").strip()
        return True, " ".join(x for x in (code, msg) if x)
    return False, ""


def _extract_image_url(out: Any, endpoint: str) -> str:
    """按端点各自的返回结构取图片地址：老 results[].url / 新 choices[].message.content[].image"""
    if endpoint == "image_generation":
        for choice in (_pick(out, "choices") or []):
            for part in (_pick(_pick(choice, "message") or {}, "content") or []):
                url = _pick(part, "image") or _pick(part, "url")
                if url:
                    return str(url)
        return ""
    for item in (_pick(out, "results") or []):
        url = _pick(item, "url")
        if url:
            return str(url)
    return ""


async def _call_dashscope_safe(
    model: str,
    prompt: str,
    size: str | None,
    timeout: int,
) -> tuple[int, str | None, str | None, bool]:
    """安全调用生图，按模型所在端点分派两代 API。

    Args:
        size: 要发送的尺寸；None 表示不传（"auto"，用模型自己的默认值）。

    Returns:
        (status_code, image_url, error_msg, terminal)
        terminal=True 表示换模型/重试都不会有结果（认证、参数、内容安全、模型不存在），
        调用方应当立刻结束整条降级链，而不是把 3 个模型各重试 3 次。
    """
    endpoint = image_endpoint_of(model)
    kwargs = {} if size is None else {"size": size}
    try:
        if endpoint == "image_generation":
            from dashscope.aigc.image_generation import ImageGeneration
            fn = ImageGeneration.call
            call_kwargs: dict[str, Any] = {
                "model": model,
                "messages": [{"role": "user", "content": [{"text": prompt}]}],
                **kwargs,
            }
        else:
            fn = dashscope.ImageSynthesis.call
            call_kwargs = {"model": model, "prompt": prompt, "n": 1, **kwargs}
        response = await asyncio.to_thread(fn, **call_kwargs)
        code = getattr(response, "status_code", 500)
        out = getattr(response, "output", None)
        if code == 200:
            failed, reason = _task_failure(out)
            if failed:
                # 状态码 200 但任务失败：把服务端原话带出去，别再含糊成"解析失败"
                msg = reason or "服务端未给原因"
                logger.warning(f"生图任务失败 model={model} endpoint={endpoint} :: {msg}")
                return code, None, msg, _is_terminal_error(0, msg)
            url = _extract_image_url(out, endpoint)
            if url:
                return (200, url, None, False)
            return (code, None, "接口成功但没有图片地址（异步任务未就绪或返回结构变化）", True)
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
                                endpoint=image_endpoint_of(model),
                                message=f"{model} 第 {attempt}/{max_retries} 次尝试")

                # 每个模型按自己所在端点解析尺寸：降级跨端点时（4K → 老端点）不能照发原值
                send_size, size_note = size_for_call(model, size)
                status_code, image_url, error_msg, terminal = await _call_dashscope_safe(
                    model=model, prompt=prompt, size=send_size, timeout=180,
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


# ══════════════════════════════ 自检 ══════════════════════════════

#: 自检产物目录（question_media/selftest/，登录后可读，孤儿回收豁免具名目录）
SELFTEST_DIR = "selftest"
#: 固定提示词：内容安全友好、成本最小，只为验证"模型 + 端点 + 尺寸 + Key"这条链通不通
SELFTEST_PROMPT = "一支红色铅笔放在打开的课本上，简洁插画风格"


async def self_test() -> dict[str, Any]:
    """用**当前配置**真生成一张图，把"配置到底能不能用"如实报出来。

    与 model-test / appid-test / kb-test 同一套思路：管理员在页面上填完就该立刻知道
    对不对，而不是等到出题时才发现"生图一直没出图"。会产生一次真实调用与少量费用，
    所以端点侧限管理员并做次数节流。

    返回里刻意把 size_configured / size_sent / size_note 分开：
    配置值与实际发送值可能不同（auto 不传、跨端点回落），这正是过去最难自查的一类问题。
    """
    from backend.question_media import ensure_media_dir, url_for

    cfg = get_image_gen_config()
    if not cfg:
        enabled = bool(get_config_value("IMAGE_GEN_ENABLED", True))
        return {"ok": False,
                "error": ("生图开关未启用" if not enabled else "API Key 未配置，请在系统配置中填写")}
    if not cfg.get("api_key"):
        return {"ok": False, "error": "API Key 未配置", "model": cfg["model"]}

    send_size, size_note = size_for_call(cfg["model"], cfg["size"])
    t0 = time.time()
    errors: list[str] = []
    media = ensure_media_dir(extra=SELFTEST_DIR)
    name = f"selftest-{int(time.time() * 1000)}"
    path = await generate_and_save_image(SELFTEST_PROMPT, media, filename=name,
                                         max_retries=1, error_sink=errors)
    out: dict[str, Any] = {
        "ok": bool(path),
        "model": cfg["model"],
        "endpoint": cfg["endpoint"],
        "size_configured": cfg["size_raw"] or AUTO_SIZE,
        "size_sent": send_size or AUTO_SIZE,
        "size_note": size_note,
        "cost_ms": int((time.time() - t0) * 1000),
    }
    if path:
        file_path = Path(path)
        out["url"] = url_for(extra=SELFTEST_DIR, filename=file_path.name)
        out["bytes"] = file_path.stat().st_size if file_path.exists() else 0
    else:
        out["error"] = (errors[0] if errors else "生成失败（未拿到原因）")
    return out


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
