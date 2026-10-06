# -*- coding: utf-8 -*-
r"""模型候选清单（对话 / 长文本 / 视觉 / 生图）与账号可见性探测。

为什么要有这个文件
  此前模型名以字面量散在 18 个调用点与配置说明里：换一次默认值要一次改齐（漏一处就是
  "配置页改了、某条链路仍偷偷用旧模型"），管理员在页面上只能手打模型名，填了下线的
  模型也要等运行时才报错。清单集中在这里，配置页按下拉取用，运行时兜底也引用这里的常量。

模型名字从哪来
  全部取自 2026-10-06 实测的账号可见清单（`/compatible-mode/v1/models`，262 条，
  去掉带日期的快照版本后 196 条）—— 不凭印象编名字。

关于"下线"的判据（重要）
  上面那份清单**不完整**：qwen-audio-3.0/3.1-tts-flash 都不在其中，却实测能正常出声；
  wan2.2-t2i-flash 不在其中，text2image 端点实测可用。
  所以可见性只当提示、不当闸门 —— 查不到只标灰，绝不拦保存，也绝不因为拉不到清单
  就让配置页打不开。

生图尺寸规则怎么来的
  用"故意传一个非法尺寸"探测：服务端在扣费之前就把规则写在错误信息里，
  既问出了每个模型属于哪条端点，也问出了各自的尺寸上限，全程零出图费用。
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

# ── 对话模型候选（只放确认要用的三个，别堆清单：管理员面对长列表反而不会选） ──
# tier 保留给前端分组用；将来要加备选，往这里添行即可，端点与尺寸规则不受影响。
CHAT_MODELS: list[dict[str, str]] = [
    {"id": "qwen3.7-flash", "tier": "recommended", "note": "当前默认，线上长期实测稳定"},
    {"id": "qwen3.8-flash", "tier": "recommended", "note": "最新一代，对话与出题首选"},
    {"id": "deepseek-v4.1-flash", "tier": "recommended", "note": "长文与逻辑推理口碑好"},
]

LONG_MODELS: list[dict[str, str]] = [
    {"id": "qwen-long", "tier": "recommended", "note": "长文档汇总与批改分析，当前默认"},
]

VL_MODELS: list[dict[str, str]] = [
    {"id": "qwen3-vl-plus", "tier": "recommended", "note": "识别更准，题目图片解析用（当前默认）"},
    {"id": "qwen3-vl-flash", "tier": "recommended", "note": "便宜快速，日常看图够用"},
]

# ── 生图模型候选 ──
# endpoint 决定调用哪条通道，两代的参数与返回结构都不同，跨端点调用实测 400：
#   image_synthesis  = dashscope.ImageSynthesis（text2image 端点）
#   image_generation = dashscope.aigc.image_generation（多模态端点）
IMAGE_MODELS: list[dict[str, Any]] = [
    {"id": "wan2.2-t2i-flash", "endpoint": "image_synthesis", "tier": "recommended",
     "note": "当前默认，实测可用"},
    {"id": "wanx2.1-t2i-turbo", "endpoint": "image_synthesis", "tier": "legacy",
     "note": "上一代快速模型，保留作降级兜底（实测可用）"},
    {"id": "wan2.7-image", "endpoint": "image_generation", "tier": "recommended",
     "note": "中文标注更准，实测 3.5 秒出图，最大 4096×4096"},
    {"id": "wan2.7-image-pro", "endpoint": "image_generation", "tier": "premium",
     "note": "Pro 档，尺寸范围与 2.7 相同、成本更高"},
    {"id": "qwen-image-2.0", "endpoint": "image_generation", "tier": "recommended",
     "note": "中文文字渲染好，最大 2048×2048"},
    {"id": "qwen-image-3.0-pro", "endpoint": "image_generation", "tier": "premium",
     "note": "复杂排版，最大 2560×2560"},
]

# ══════════════════════════════════════════════════════════════
#  生图尺寸规则（全部实测，2026-10-06）
#
#  两种约束形式，各家不同：
#    side → 宽和高各自都必须在 [lo, hi] 内
#    area → 宽×高 的总面积必须在 [lo, hi] 内
#  服务端原话摘录：
#    wan2.2 / wanx2.1      Either width or height should be between 512 and 1440
#    wan2.7-image(-pro)    Total pixels (99980001) must be between 589824 and 16777216
#    qwen-image-2.0        Image area must be between 262144 (512x512) and 4194304 (2048x2048)
#    qwen-image-2.1/3.0    ... and 6553600 (2560x2560) pixels for t2i requests
#    qwen-image-max        Size 9999*9999 is out of range [512*512, 1664*1664]
#    z-image-turbo         Image area must be between 262144 and 4194304 pixels
#  另外：新端点的 "4K" 预设 token 在文生图场景被拒（Maximum supported size is 2K），
#  但 4096*4096 这种写宽高的形式落在 wan2.7 的面积范围内是合法的 —— 所以预设 token
#  只给 2.7 两条，且只到 2K。
# ══════════════════════════════════════════════════════════════
SIDE = "side"
AREA = "area"

SIZE_RULES: dict[str, dict[str, Any]] = {
    "wan2.2-t2i-flash":   {"kind": SIDE, "lo": 512, "hi": 1440},
    "wanx2.1-t2i-turbo":  {"kind": SIDE, "lo": 512, "hi": 1440},
    "wan2.7-image":       {"kind": AREA, "lo": 589_824, "hi": 16_777_216},
    "wan2.7-image-pro":   {"kind": AREA, "lo": 589_824, "hi": 16_777_216},
    "qwen-image-2.0":     {"kind": AREA, "lo": 262_144, "hi": 4_194_304},
    "qwen-image-2.1-pro": {"kind": AREA, "lo": 262_144, "hi": 6_553_600},
    "qwen-image-3.0":     {"kind": AREA, "lo": 262_144, "hi": 6_553_600},
    "qwen-image-3.0-pro": {"kind": AREA, "lo": 262_144, "hi": 6_553_600},
    "qwen-image-max":     {"kind": SIDE, "lo": 512, "hi": 1664},
    "z-image-turbo":      {"kind": AREA, "lo": 262_144, "hi": 4_194_304},
}

#: 清单外的手填模型按最保守的老端点边长规则判（宁可不给，也别放出一个必失败的值）
DEFAULT_SIZE_RULE: dict[str, Any] = {"kind": SIDE, "lo": 512, "hi": 1440}

#: 各模型允许的预设 token（实测才放）
PRESET_TOKENS: dict[str, set[str]] = {
    "wan2.7-image": {"1k", "2k"},
    "wan2.7-image-pro": {"1k", "2k"},
}

#: 下拉档位的母表 —— 某个模型能选哪几档，由它自己的尺寸规则过滤，加档位只改这里
SIZE_PRESET_MASTER: list[dict[str, Any]] = [
    {"value": "1024*1024", "label": "方形 1024×1024（出题配图最稳）"},
    {"value": "1280*720", "label": "横版 1280×720"},
    {"value": "720*1280", "label": "竖版 720×1280"},
    {"value": "1440*1440", "label": "方形 1440×1440"},
    {"value": "2048*2048", "label": "高清 2048×2048"},
    {"value": "2560*2560", "label": "超清 2560×2560"},
    {"value": "4096*4096", "label": "最大 4096×4096"},
]

_KINDS = {"chat": CHAT_MODELS, "long": LONG_MODELS, "vl": VL_MODELS, "image": IMAGE_MODELS}

#: 没进下拉、但端点与尺寸规则都已实测过的模型。
#: 下拉只放确认要用的那几个，其余靠管理员手填 —— 手填时也必须路由到正确端点，
#: 否则会落到"清单外保守走老端点"的分支，而这些模型在老端点上实测是 400。
MEASURED_EXTRA_ENDPOINTS: dict[str, str] = {
    "qwen-image-2.1-pro": "image_generation",
    "qwen-image-3.0": "image_generation",
    "qwen-image-max": "image_generation",
    "z-image-turbo": "image_generation",
}

IMAGE_ENDPOINTS: dict[str, str] = {
    **MEASURED_EXTRA_ENDPOINTS,
    **{m["id"]: m["endpoint"] for m in IMAGE_MODELS},
}


def options_for(kind: str) -> list[dict[str, Any]]:
    """某类模型的候选清单（kind: chat / long / vl / image）"""
    return list(_KINDS.get(kind, []))


def known_ids(kind: str) -> set[str]:
    return {m["id"] for m in _KINDS.get(kind, [])}


def image_endpoint_of(model: str) -> str:
    """模型该走哪条端点。

    下拉里的、以及"没进下拉但已实测过"的模型都按实测结果走；只有完全没测过的
    手填模型才退回老端点（与历史行为一致），此时尺寸也按最保守的 512~1440 判。
    """
    return IMAGE_ENDPOINTS.get(str(model or "").strip(), "image_synthesis")


def size_rule(model: str) -> dict[str, Any]:
    return SIZE_RULES.get(str(model or "").strip(), DEFAULT_SIZE_RULE)


def size_ok(model: str, w: int, h: int) -> bool:
    """按该模型实测到的规则判一个宽高能不能用"""
    rule = size_rule(model)
    if w <= 0 or h <= 0:
        return False
    if rule["kind"] == AREA:
        return rule["lo"] <= w * h <= rule["hi"]
    return rule["lo"] <= w <= rule["hi"] and rule["lo"] <= h <= rule["hi"]


def describe_size_rule(model: str) -> str:
    """给管理员看的一句人话（保存报错与下拉说明共用）"""
    rule = size_rule(model)
    if rule["kind"] == AREA:
        return f"宽×高 的总面积需在 {rule['lo']:,}~{rule['hi']:,} 像素之间"
    return f"宽高都需在 {rule['lo']}~{rule['hi']} 之间"


def size_presets_for(model: str) -> list[dict[str, str]]:
    """该模型可选的尺寸档位：从母表按它自己的实测规则过滤出来"""
    out = []
    for preset in SIZE_PRESET_MASTER:
        w, h = (int(n) for n in preset["value"].split("*"))
        if size_ok(model, w, h):
            out.append({"value": preset["value"], "label": preset["label"]})
    return out


def preset_values_for(model: str) -> set[str]:
    """该模型允许的预设 token（小写）。只放实测接受的，别在别处再抄一份 1K/2K/4K。"""
    return PRESET_TOKENS.get(str(model or "").strip(), set())


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
        new_value = got if got is not None else value
        globals()["_cache"] = (now, new_value)
        return new_value


def annotate(kind: str) -> list[dict[str, Any]]:
    """给候选清单打上可见性标记：True 查到 / False 未见于清单（只标灰） / None 未校验"""
    vis = visible_models()
    out = []
    for m in _KINDS.get(kind, []):
        item = dict(m)
        item["visible"] = None if vis is None else (m["id"] in vis)
        out.append(item)
    return out