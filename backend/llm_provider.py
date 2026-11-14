# -*- coding: utf-8 -*-
"""本地引擎 Provider 层（首期：Ollama）

为什么单独一层
  云端（百炼 compatible-mode）与本地引擎（Ollama）都说 OpenAI 协议，但方言不同。
  最典型的是思考开关：DashScope 认 enable_thinking，Ollama 直接忽略这个字段、
  且 qwen3/3.5 默认开思考 —— 不显式关，思考 token 会吃光 max_tokens 留下空正文
  （2026-11-14 实测：qwen3.5:0.8b，300 token 预算全部花在 reasoning 上）。
  所以分流与翻译集中在本模块做，18 个业务调用点零改动。

三档模式（系统配置 AI_MODE）
  cloud   现状：全部走百炼。本模块所有路由函数都是直通（地址链原样、payload 不动）。
  hybrid  本地优先：本地连接失败/读超时沿地址链回落到云端；知识库/TTS/生图照旧云端。
  local   只用本地：绝不外呼。智能体应用与百炼知识库接管（都要出网）一并旁路。

约定
  - 本地地址只填 OLLAMA_API_BASE，不碰 QWEN_OPENAI_API_BASE —— 云端那条
    「裸域名补 /compatible-mode/v1」的规范化是百炼专属方言，保持原样零回归。
  - Ollama 忽略 Authorization：空 Key 场景用占位符 "ollama" 填头、放行闸门。
"""
from __future__ import annotations

import threading
import time
from urllib.parse import urlparse

PROVIDER_CLOUD = "dashscope"
PROVIDER_OLLAMA = "ollama"
OLLAMA_PLACEHOLDER_KEY = "ollama"
AI_MODES = ("cloud", "hybrid", "local")


def _cfg(key: str, default=None):
    from backend.api.config_router import get_config_value   # 延迟导入，避开循环依赖
    try:
        return get_config_value(key, default)
    except Exception:
        return default


def ai_mode() -> str:
    m = str(_cfg("AI_MODE", "cloud") or "cloud").strip().lower()
    return m if m in AI_MODES else "cloud"


def normalize_ollama_base(raw) -> str:
    """把管理员填的地址规范成 OpenAI 兼容 base：补 http、裸地址补 /v1、去尾斜杠。

    本地/内网引擎缺省 http（而不是 normalize_ai_api_base 的补 https 规则——
    给 localhost:11434 套 https 只会握手失败）；没写路径时补 OpenAI 兼容前缀 /v1。
    """
    text = str(raw or "").strip().rstrip("/")
    if not text:
        return ""
    if not text.startswith(("http://", "https://")):
        text = "http://" + text
    if urlparse(text).path.rstrip("/") == "":
        text += "/v1"
    return text


def ollama_base() -> str:
    return normalize_ollama_base(_cfg("OLLAMA_API_BASE", ""))


def ollama_active() -> bool:
    """本地分流是否生效：模式开了、且地址填了才算（防止半配置状态把流量送进空地址）"""
    return ai_mode() != "cloud" and bool(ollama_base())


def ollama_model_for(capability: str) -> str:
    from backend.model_catalog import DEFAULT_OLLAMA_MODELS
    key = {"chat": "OLLAMA_CHAT_MODEL", "long": "OLLAMA_LONG_MODEL",
           "vl": "OLLAMA_VL_MODEL"}.get(capability, "OLLAMA_CHAT_MODEL")
    name = str(_cfg(key, "") or "").strip()
    return name or DEFAULT_OLLAMA_MODELS.get(capability) or DEFAULT_OLLAMA_MODELS["chat"]


def capability_of(model: str) -> str:
    """从「调用点准备用的云端模型名」推断能力档，业务侧因此零改动。

    顺序有意为之：先精确匹配配置名，再按特征词兜底（vl/ocr），都对不上按 chat ——
    最保守的档位，不会把普通对话错送进长文/视觉通道。
    """
    m = str(model or "").strip().lower()
    if not m:
        return "chat"
    if m == str(_cfg("MODEL_LONG_NAME", "") or "").strip().lower():
        return "long"
    vl = str(_cfg("MODEL_VL_NAME", "") or "").strip().lower()
    if (vl and m == vl) or "-vl" in m or "vl-" in m or "ocr" in m:
        return "vl"
    return "chat"


def adapt_payload(payload: dict) -> dict:
    """DashScope 方言 → Ollama 方言。就地修改并返回；只在 route() 判给本地后调用。

    思考策略：enable_thinking=False 或（未表态且 OLLAMA_THINKING=off）→ reasoning_effort=none。
    Ollama 对 qwen 系「未表态」的默认是开思考，不显式关就复现 120s 空回复事故。
    """
    et = payload.pop("enable_thinking", None)
    thinking = str(_cfg("OLLAMA_THINKING", "off") or "off").strip().lower()
    if et is False or (et is None and thinking != "on"):
        payload["reasoning_effort"] = "none"
    return payload


def route(api_base: str, payload: dict, cloud_chain: list) -> tuple:
    """返回 (生效地址链, provider)；本地生效时顺带改写 payload（模型名 + 参数方言）。

    cloud 模式（或未配本地地址）：原样返回 (cloud_chain, PROVIDER_CLOUD)，payload 一字节不动。
    """
    if not ollama_active():
        return cloud_chain, PROVIDER_CLOUD
    base = ollama_base()
    payload["model"] = ollama_model_for(capability_of(payload.get("model", "")))
    adapt_payload(payload)
    chain = [base]
    if ai_mode() == "hybrid" and bool(_cfg("OLLAMA_FALLBACK_TO_CLOUD", True)):
        for b in cloud_chain or []:
            if b and b not in chain:
                chain.append(b)
    return chain, PROVIDER_OLLAMA


def decorate(api_base: str, payload: dict) -> tuple:
    """绕过 ai_service 的直连站点（图像摘要/白板识图/视觉提取/能力探测）的统一入口。

    返回 (生效地址, 生效 payload)。云端模式原样返回两个入参 —— 行为零变化；
    本地模式按能力改写模型名并显式关思考（与 route() 同一套方言规则）。
    这些站点历史上直连 ai_api_base()，不接就会在本地模式下继续出网、
    纯离线时拿占位 Key 撞 401 —— 属于分流遗漏，不是设计意图。
    """
    if not ollama_active():
        return api_base, payload
    payload["model"] = ollama_model_for(capability_of(str(payload.get("model", ""))))
    adapt_payload(payload)
    return ollama_base(), payload


def friendly_chain_error(bases: list, exc: Exception) -> Exception:
    """把"连不上/等不到 Ollama"翻译成可执行的中文提示。

    只处理本地链首地址的连接类错误与超时；云端链、非本地模式、其它错误
    原样返回 None（调用方保持既有行为）。业务层报 HTTPConnectionPool(...)
    这类原文时，用户既看不懂也不知道该装 Ollama 还是该切回云端 —— 这里补上。
    """
    if not bases or not ollama_active() or str(bases[0]) != ollama_base():
        return None
    text = str(exc).lower()
    conn = ("refused" in text or "getaddrinfo" in text or "failed to establish" in text
            or "connect" in text or type(exc).__name__ in ("ConnectError", "ConnectionError"))
    timeout = type(exc).__name__ in ("ReadTimeout", "ConnectTimeout", "TimeoutException", "TimeoutError") or "timed out" in text
    if not (conn or timeout):
        return None
    if conn:
        if ai_mode() == "local":
            return ValueError("本地引擎（Ollama）连不上：请确认已安装并启动 Ollama"
                              "（官网 ollama.com/download 或 winget install Ollama.Ollama，装好后 ollama pull 所需模型），"
                              "或在「系统配置 → AI 能力 → 本地模型（Ollama）」把模式切回云端。")
        return ValueError("本地引擎（Ollama）与云端备用地址都不可达：请检查 Ollama 服务是否启动、"
                          "云端网络与 API Key 是否正常，或在系统配置里「检测本地引擎」查看明细。")
    return ValueError("本地引擎（Ollama）响应超时：模型过大或首次加载较慢，可稍后重试；"
                      "持续超时请换更小档位，或在「系统配置 → AI 能力 → 本地模型（Ollama）」切回云端/检查 OLLAMA_KEEP_ALIVE。")


def effective_key(api_key: str, provider: str) -> str:
    """Ollama 忽略 Authorization；空 Key 场景用占位符，别把空串送进 Bearer 头"""
    k = str(api_key or "").strip()
    if k:
        return k
    return OLLAMA_PLACEHOLDER_KEY if provider == PROVIDER_OLLAMA else ""


def key_ok(api_key: str) -> bool:
    """各调用入口的 Key 闸门：本地引擎开着时放行空 Key"""
    return bool(str(api_key or "").strip()) or ollama_active()


def is_placeholder_key(api_key: str) -> bool:
    return str(api_key or "").strip() == OLLAMA_PLACEHOLDER_KEY


# ── 探活（配置页红绿灯；TTL 缓存，Ollama 不在线绝不炸调用方） ──
_HEALTH_TTL = 30.0
_health_lock = threading.Lock()
_health_cache: dict = {}


def health(refresh: bool = False) -> dict:
    now = time.time()
    if not refresh:
        with _health_lock:
            cached = dict(_health_cache)
        if cached and now - cached.get("checked_at", 0) < _HEALTH_TTL:
            return cached
    base = ollama_base()
    out = {"ok": False, "base": base, "mode": ai_mode(), "models": [], "error": ""}
    if not base:
        out["error"] = "未配置 OLLAMA_API_BASE"
    else:
        try:
            import httpx
            t0 = time.time()
            r = httpx.get(f"{base}/models", timeout=httpx.Timeout(3.0, read=5.0))
            out["latency_ms"] = int((time.time() - t0) * 1000)
            if r.status_code == 200:
                out["ok"] = True
                out["models"] = sorted(str(m.get("id", "")) for m in (r.json().get("data") or []))
            else:
                out["error"] = f"HTTP {r.status_code}: {r.text[:120]}"
        except Exception as exc:
            out["error"] = f"{type(exc).__name__}: {exc}"[:160]
    out["checked_at"] = time.time()
    with _health_lock:
        _health_cache.clear()
        _health_cache.update(out)
    return out


def _origin(base: str) -> str:
    parsed = urlparse(base)
    return f"{parsed.scheme}://{parsed.netloc}"


def model_catalog(refresh: bool = True) -> dict:
    """配置页下拉用的实时模型明细：名字来自 /v1/models，用原生 /api/tags 补参数与体积、
    /api/ps 补驻留与真实 context。管理员刚 ollama pull 完就该在下拉里看见新模型，
    所以默认不走缓存直探；任何一个辅助数据源失败都只降级为"少了注释"，
    拉不到清单时返回空表 —— 前端按既有口径退回手输，配置页永不因此打开不了。
    """
    h = health(refresh=refresh)
    out = {"ok": bool(h.get("ok")), "options": [], "error": str(h.get("error") or "")}
    if not out["ok"]:
        return out
    import httpx
    origin = _origin(ollama_base())
    meta: dict = {}
    resident: dict = {}
    try:
        r = httpx.get(f"{origin}/api/tags", timeout=5.0)
        if r.status_code == 200:
            for m in r.json().get("models") or []:
                d = m.get("details") or {}
                bits = [str(d.get("parameter_size") or "").strip(),
                        str(d.get("quantization_level") or "").strip()]
                size_gb = (m.get("size") or 0) / 2 ** 30
                if size_gb:
                    bits.append(f"{size_gb:.1f}G")
                meta[str(m.get("name"))] = " ".join(x for x in bits if x)
    except Exception:
        pass
    try:
        r = httpx.get(f"{origin}/api/ps", timeout=5.0)
        if r.status_code == 200:
            for m in r.json().get("models") or []:
                resident[str(m.get("name"))] = m
    except Exception:
        pass
    options = []
    for name in h.get("models") or []:
        note_bits = [x for x in [meta.get(name, "")] if x]
        ps = resident.get(name) or resident.get(f"{name}:latest")
        if ps:
            note_bits.append(f"驻留·ctx{ps.get('context_length', '?')}")
        options.append({"id": name, "note": " · ".join(note_bits) or "Ollama",
                        "tier": "", "visible": True})
    out["options"] = options
    return out


def live_info() -> dict:
    """Ollama 原生 /api/ps：当前驻留模型、context、卸载时限。拿不到就 {ok: False}。"""
    base = ollama_base()
    if not base:
        return {"ok": False, "error": "未配置 OLLAMA_API_BASE"}
    parsed = urlparse(base)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    try:
        import httpx
        r = httpx.get(f"{origin}/api/ps", timeout=5.0)
        if r.status_code != 200:
            return {"ok": False, "error": f"HTTP {r.status_code}"}
        models = [{
            "name": m.get("name"),
            "size_mb": round((m.get("size") or 0) / 2 ** 20),
            "vram_mb": round((m.get("size_vram") or 0) / 2 ** 20),
            "context": m.get("context_length"),
            "expires_at": m.get("expires_at"),
        } for m in (r.json().get("models") or [])]
        return {"ok": True, "models": models}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:160]}
