# -*- coding: utf-8 -*-
"""模型候选清单（对话 / 长文本 / 视觉 / 生图）与账号可见性探测。

为什么要有这个文件
  此前模型名以字面量散在 18 个调用点与配置说明里：换一次默认值要一次改齐（漏一处就是
  "配置页改了、某条链路仍偷偷用旧模型"），管理员在页面上只能手打模型名，填了下线的
  模型也要等运行时才报错。清单集中在这里，配置页按下拉取用，运行时兜底也引用这里的常量。

关于"下线"的判据（2026-10-06 实测）
  `GET /compatible-mode/v1/models` 返回的清单**不完整**：qwen-audio-3.0/3.1-tts-flash
  都不在其中，却实测能正常出声；wan2.2-t2i-flash 不在其中，text2image 端点实测可用。
  所以可见性只当提示、不当闸门 —— 查不到只标灰，绝不拦保存，也绝不因为拉不到清单
  就让配置页打不开。
"""
from __future__ import annotations

import threading
import time
from typing import Any

# ── 默认模型（改默认只动这四行） ──
DEFAULT_CHAT_MODEL = "qwen3.7-flash"
DEFAULT_LONG_MODEL = "qwen-long"
DEFAULT_VL_MODEL = "qwen3-vl-plus"
DEFAULT_IMAGE_MODEL = "wan2.2-t2i-flash"

# ── 对话模型候选 ──
# tier: recommended 推荐 / legacy 可用但不推荐 / premium 高档（成本高，只在关键任务用）
CHAT_MODELS: list[dict[str, str]] = [
    {"id": "qwen3.8-flash", "tier": "recommended", "note": "最新一代，对话与出题首选"},
    {"id": "qwen3.7-flash", "tier": "recommended", "note": "当前默认，线上长期实测稳定"},
    {"id": "deepseek-v4.1-flash", "tier": "recommended", "note": "长文与逻辑推理口碑好"},
    {"id": "deepseek-v4-flash", "tier": "legacy", "note": "仍在服务，已被 v4.1 取代，不主动推荐"},
    {"id": "qwen3.8-max", "tier": "premium", "note": "成本明显更高，留给关键任务"},
    {"id": "qwen3.7-max", "tier": "premium", "note": "同上"},
]

LONG_MODELS: list[dict[str, str]] = [
    {"id": "qwen-long", "tier": "recommended", "note": "长文本汇总与批改分析，当前默认"},
]

VL_MODELS: list[dict[str, str]] = [
    {"id": "qwen3-vl-plus", "tier": "recommended", "note": "识别更准，题目图片解析用（当前默认）"},
    {"id": "qwen3-vl-flash", "tier": "recommended", "note": "便宜快速，日常看图够用"},
]

# ── 生图模型候选 ──
# endpoint 决定调用哪条通道：两代模型的端点与参数结构都不同，跨端点调用实测 400。
#   image_synthesis  = dashscope.ImageSynthesis（text2image 端点，宽高 512~1440，实测边界）
#   image_generation = dashscope.aigc.image_generation.ImageGeneration（多模态端点，支持更大尺寸）
IMAGE_MODELS: list[dict[str, Any]] = [
    {"id": "wan2.2-t2i-flash", "endpoint": "image_synthesis", "tier": "recommended",
     "note": "当前默认，实测可用；宽高需在 512~1440"},
    {"id": "wanx2.1-t2i-turbo", "endpoint": "image_synthesis", "tier": "legacy",
     "note": "上一代快速模型，保留作降级兜底（实测可用）"},
    {"id": "wan2.7-image", "endpoint": "image_generation", "tier": "recommended",
     "note": "中文标注更准，实测 3.5 秒出图；尺寸上限 2K"},
    {"id": "wan2.7-image-pro", "endpoint": "image_generation", "tier": "premium",
     "note": "Pro 档，成本更高（4K 未实测，先不放开）"},
    {"id": "qwen-image-2.0", "endpoint": "image_generation", "tier": "recommended",
     "note": "中文文字渲染好，实测可用"},
    {"id": "qwen-image-3.0-pro", "endpoint": "image_generation", "tier": "premium",
     "note": "复杂排版，成本高（4K 未实测，先不放开）"},
]

# ── 生图尺寸目录（全部按实测边界给，宁少不多） ──
# "auto" = 不传 size，用模型自己的默认值（实测两代端点都能正常出图），是最省心的默认档。
# 边界来源（2026-10-06 实测）：
#   image_synthesis  → 1440*1440 成功、2048*2048 与 9999*9999 被拒：
#                      "Either width or height should be between 512 and 1440"
#   image_generation → 1024*1024 与 1K 成功；4K 被拒：
#                      "Size 4K is not supported for t2i scenario. Maximum supported size is 2K"
#                      所以文生图这一路只放到 2K，Pro 档的 4K 未实测就先不放开。
_SIZES_SYNTHESIS = [
    {"value": "1024*1024", "label": "方形 1024×1024（出题配图最稳）"},
    {"value": "1280*720", "label": "横版 1280×720"},
    {"value": "720*1280", "label": "竖版 720×1280"},
    {"value": "1440*1440", "label": "方形 1440×1440（该端点实测上限）"},
]
_SIZES_GENERATION = [
    {"value": "1024*1024", "label": "方形 1024×1024"},
    {"value": "1280*720", "label": "横版 1280×720"},
    {"value": "720*1280", "label": "竖版 720×1280"},
    {"value": "2048*2048", "label": "高清 2048×2048"},
    {"value": "2K", "label": "2K（该端点文生图实测上限）"},
]

SIZE_PRESETS: dict[str, list[dict[str, str]]] = {
    "image_synthesis": _SIZES_SYNTHESIS,
    "image_generation": _SIZES_GENERATION,
}

#: 各端点允许的宽高范围（用于校验手填值，与上面的预设档位是两回事）
SIZE_RANGES: dict[str, tuple[int, int]] = {"image_synthesis": (512, 1440), "image_generation": (512, 2048)}

_KINDS = {"chat": CHAT_MODELS, "long": LONG_MODELS, "vl": VL_MODELS, "image": IMAGE_MODELS}

# 端点归属查表（生图专用）
IMAGE_ENDPOINTS: dict[str, str] = {m["id"]: m["endpoint"] for m in IMAGE_MODELS}


def options_for(kind: str) -> list[dict[str, Any]]:
    """某类模型的候选清单（kind: chat / long / vl / image）"""
    return list(_KINDS.get(kind, []))


def known_ids(kind: str) -> set[str]:
    return {m["id"] for m in _KINDS.get(kind, [])}


def image_endpoint_of(model: str) -> str:
    """模型该走哪条端点；清单外的手填模型按老端点走（与历史行为一致）"""
    return IMAGE_ENDPOINTS.get(str(model or "").strip(), "image_synthesis")


def size_presets_for(model: str) -> list[dict[str, str]]:
    """该模型可选的尺寸档位（清单外的手填模型按老端点给，保守）"""
    return SIZE_PRESETS.get(image_endpoint_of(model), SIZE_PRESETS["image_synthesis"])


def size_range_for(model: str) -> tuple[int, int]:
    """该模型允许的宽高范围，用于校验手填的 宽*高"""
    return SIZE_RANGES.get(image_endpoint_of(model), SIZE_RANGES["image_synthesis"])


#: 各端点**实际接受**的预设 token（用于校验手填值，小写）。
#: 与下拉档不完全相同：1K 与 1024*1024 等价，下拉里只留更直观的那个，
#: 但管理员手填 1K 也该放过。4K 不放 —— 实测文生图场景 "Maximum supported size is 2K"。
PRESET_TOKENS: dict[str, set[str]] = {
    "image_synthesis": set(),               # 老端点只认 宽*高
    "image_generation": {"1k", "2k"},
}


def preset_values_for(model: str) -> set[str]:
    """该模型允许的预设 token。校验时以本表为准，别在别处再抄一份 1K/2K/4K。"""
    return PRESET_TOKENS.get(image_endpoint_of(model), set())


# ══════════════════════════════════════════════════════════════
#  账号可见性探测（只作提示，不作闸门）
# ══════════════════════════════════════════════════════════════

_CACHE_TTL = 300            # 秒：配置页不该每次打开都打网络
_lock = threading.Lock()
_cache: tuple[float, frozenset[str] | None] = (0.0, None)


def _fetch_visible_models() -> frozenset[str] | None:
    """拉账号可见的模型 id 集合；任何失败都返回 None（调用方按"未知"处理）"""
    import httpx

    from backend.config import ai_api_base
    from backend.tts_service import resolve_api_key   # 与对话/合成同一条 Key 解析口径

    key = resolve_api_key()
    if not key:
        return None
    base = ai_api_base().rstrip("/")
    try:
        resp = httpx.get(f"{base}/models", headers={"Authorization": "Bearer " + key}, timeout=15)
        if resp.status_code != 200:
            return None
        data = resp.json().get("data") or []
        ids = {str(m.get("id") or "") for m in data if isinstance(m, dict)}
        return frozenset(ids) if ids else None
    except Exception:
        return None


def visible_models(force: bool = False) -> frozenset[str] | None:
    """带缓存的可见模型集合；None 表示未取到（一律按"未知"处理，不影响页面可用性）"""
    now = time.time()
    with _lock:
        stamp, value = _cache
        if not force and value is not None and now - stamp < _CACHE_TTL:
            return value
        got = _fetch_visible_models()
        # 拉取失败时保留旧值继续用（哪怕过期）：有参考总比没有好，且绝不报错
        _cache_new = (now, got if got is not None else value)
        globals()["_cache"] = _cache_new
        return _cache_new[1]


def annotate(kind: str) -> list[dict[str, Any]]:
    """给候选清单打上可见性标记：True 查到 / False 未见于清单（只标灰） / None 未校验"""
    vis = visible_models()
    out = []
    for m in _KINDS.get(kind, []):
        item = dict(m)
        item["visible"] = None if vis is None else (m["id"] in vis)
        out.append(item)
    return out