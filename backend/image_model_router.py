"""图像理解模型路由

为什么需要：带图的提问原本一律走视觉模型（MODEL_VL_NAME），贵且慢；而配置里的
对话模型（MODEL_NAME）本身就能看图。日常"这是什么/图里写了啥"用对话模型更快更省，
只有真正要解题（题干、公式、手写算式）才值得上视觉模型。

三条约束（改代码前先看这里）：
1. **模型名一律来自配置**：本模块只读 MODEL_NAME / MODEL_VL_NAME，不写死任何模型；
2. **能否看图靠事实判定**：对话模型明确拒绝图片时记为"不吃图"（进程内缓存 1 小时，到期自动重试，
   换模型后能自愈），不需要任何手工名单；
3. **拿不准就走视觉模型**：多花几厘钱，好过让学生对着错误答案发呆。
"""
from __future__ import annotations

import json
import re
import threading
import time

from backend.logger import logger

# ── 解题意图判定 ──
# 强特征：出现就按解题处理（避开"要求/请求"这类常见词，所以不收单独的"求"）
_STRONG = (
    "求解", "求值", "求下列", "求出", "证明", "求证", "计算", "解方程", "解不等式",
    "化简", "下列", "选项", "答案", "等于多少", "结果是多少", "步骤", "怎么算",
)
# 弱特征：需与数学符号或第二条弱特征同时出现
_WEAK = (
    "公式", "方程", "函数", "几何", "概率", "面积", "体积", "周长", "速度", "单位",
    "因式", "代入", "图形", "分数", "小数", "比例", "平方", "根号",
)
_SYMBOLS = ("=", "√", "∑", "∫", "²", "³", "×", "÷", "π", "°", "≈", "≠", "≤", "≥", "<>", "+", "-")

_CACHE_TTL = 3600
# 只有错误信息明确说"不接受图片"才算不支持；尺寸/比例/过大/编码问题都不算——
# 曾经拿 8×8 的图探活，被"图片尺寸不符"顶回 400，差点把能吃图的模型永久拉黑。
_UNSUPPORTED_HINTS = (
    "unsupported image", "image is not supported", "images are not supported",
    "does not support image", "do not support image", "not support image",
    "image_url is not supported", "invalid content type", "content type is not supported",
    "only text", "text-only", "text only", "不支持图片", "不支持图像", "仅支持文本",
)
_UNSUPPORTED: dict[str, float] = {}
_CACHE_LOCK = threading.Lock()


def _cfg(name, default):
    from backend.api.config_router import get_config_value
    try:
        return get_config_value(name, default)
    except Exception:
        return default


def _vl_model() -> str:
    from backend.model_catalog import resolve_vl_model
    return resolve_vl_model(_cfg("MODEL_VL_NAME", ""))


def _chat_model() -> str:
    from backend.model_catalog import resolve_chat_model
    return resolve_chat_model(_cfg("MODEL_NAME", ""))


def looks_like_solve(prompt: str, extra: str = "") -> bool:
    """判断这次提问是不是"解题"。宁可漏判（走对话模型）也不误判（白花 VL 的钱）。"""
    text = ((prompt or "") + "\n" + (extra or ""))[:2000]
    if not text.strip():
        return False
    if any(k in text for k in _STRONG):
        return True
    weak = sum(1 for k in _WEAK if k in text)
    syms = sum(1 for s in _SYMBOLS if s in text)
    if weak >= 2:
        return True
    if weak >= 1 and syms >= 1:
        return True
    # 纯符号堆（例如整页算式截图 + 一句话提问）
    return syms >= 3 and bool(re.search(r"\d", text))


def _cached_unsupported(model: str) -> bool:
    with _CACHE_LOCK:
        ts = _UNSUPPORTED.get(model)
        if not ts:
            return False
        if time.time() - ts > _CACHE_TTL:
            _UNSUPPORTED.pop(model, None)
            return False
        return True


def mark_unsupported(model: str) -> None:
    """对话模型明确拒绝图片时登记，1 小时内不再尝试（到期自动重试，模型升级后能自愈）。"""
    if not model:
        return
    with _CACHE_LOCK:
        _UNSUPPORTED[model] = time.time()
    logger.info("[图像路由] %s 不支持图片输入，1 小时内改走视觉模型", model)


def reset_cache() -> None:
    with _CACHE_LOCK:
        _UNSUPPORTED.clear()


def pick_image_model(prompt: str = "", extra: str = "") -> tuple[str, str]:
    """选模型：返回 (模型名, 原因)。原因用于日志与活动监控归因。"""
    vl = _vl_model()
    if bool(_cfg("MODEL_IMAGE_SOLVE_VL", True)) and looks_like_solve(prompt, extra):
        return vl, "solve"
    if not bool(_cfg("MODEL_IMAGE_VIA_CHAT", True)):
        return vl, "chat-off"
    chat = _chat_model()   # 配置留空时由 model_catalog 回落默认对话模型，不会为空
    if chat == vl:
        return chat, "same-model"
    if _cached_unsupported(chat):
        return vl, "chat-no-vision"
    return chat, "chat"


def looks_like_image_unsupported(error_text: str) -> bool:
    t = (error_text or "").lower()
    if t and any(k in t for k in ("length and width", "resolution", "image size", "too large",
                                  "exceeds", "aspect ratio", "base64", "decode")):
        return False
    return any(k in t for k in _UNSUPPORTED_HINTS)


def fallback_model(model_used: str, http_status: int, error_text: str = "") -> str:
    """对话模型被判定为"不吃图"时，返回该换用的视觉模型；无需回落返回空串。

    只有 400/415/422 才认（参数/媒体类型层面的明确拒绝）；5xx 是服务端抖动，
    换个模型也一样抖，交给上层的错误提示处理。
    """
    if http_status not in (400, 415, 422):
        return ""
    if not looks_like_image_unsupported(error_text):
        return ""
    chat = _chat_model()
    if not model_used or not chat or model_used != chat:
        return ""
    mark_unsupported(chat)
    vl = _vl_model()
    return vl if vl and vl != chat else ""


def probe_chat_vision(api_key: str, timeout: int = 20) -> dict:
    """显式探测对话模型能否读图（配置页自检/测试用）。

    用 8×8 纯色 PNG 探活：成本近乎为零，返回 200 视为支持；
    400/415/422 视为不支持并登记缓存。其它状态码按"未知"返回，不写缓存。
    """
    import base64
    import io

    import requests

    out = {"ok": False, "model": "", "status": 0, "supported": None, "error": ""}
    chat = _chat_model()
    out["model"] = chat
    if not chat:
        out["error"] = "未配置对话模型"
        return out
    if not api_key:
        out["error"] = "缺少 API Key"
        return out
    try:
        from PIL import Image
        buf = io.BytesIO()
        # 尺寸必须满足各家的下限/比例要求，否则会拿到"尺寸不符"的 400，误判成不支持图片
        Image.new("RGB", (640, 480), (200, 200, 200)).save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        out["error"] = "构造测试图片失败：" + str(e)[:80]
        return out

    from backend.config import ai_api_base
    from backend import llm_provider
    _pl = {"model": chat, "max_tokens": 1,
           "messages": [{"role": "user", "content": [
               {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
               {"type": "text", "text": "这是什么颜色？"},
           ]}]}
    _base, _pl = llm_provider.decorate(ai_api_base(), _pl)
    try:
        resp = requests.post(
            _base + "/chat/completions",
            headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
            json=_pl,
            timeout=timeout,
        )
    except Exception as e:
        out["error"] = "连不上模型服务：" + str(e)[:120]
        return out
    out["status"] = resp.status_code
    if resp.status_code == 200:
        out["ok"] = True
        out["supported"] = True
        return out
    if resp.status_code in (400, 415, 422):
        if looks_like_image_unsupported(resp.text):
            mark_unsupported(chat)
            out["supported"] = False
            out["error"] = "模型不接受图片输入（HTTP " + str(resp.status_code) + "）"
        else:
            # 未知原因（尺寸、参数、限流等）：不写缓存，避免误伤
            out["supported"] = None
            out["error"] = "探测失败但不确定是否支持图片：" + (resp.text or "")[:160]
        return out
    out["error"] = "HTTP " + str(resp.status_code) + "：" + (resp.text or "")[:160]
    return out


def describe_route(model: str, reason: str) -> str:
    return json.dumps({"model": model, "route": reason}, ensure_ascii=False)
