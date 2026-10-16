# -*- coding: utf-8 -*-
"""语音合成服务（百炼 qwen-audio-3.0-tts-flash）。

调用通道（实测于 2026-10-05）
  该系列**没有 HTTP 直出通道**，只有 WebSocket 实时合成（run-task → task-started →
  continue-task → finish-task，二进制帧即音频）。dashscope SDK 的
  `dashscope.audio.tts_v2.SpeechSynthesizer` 发的就是这个协议
  （task_group=audio / task=tts / function=SpeechSynthesizer，parameters 里
  voice、format、sample_rate、volume、rate、pitch 逐项对得上），所以直接用它，
  **不需要再引入 websockets 依赖**（SDK 自带 websocket-client）。

三个实测踩到的坑，本模块内部已全部处理
  1. `call()` 失败**不抛异常**：返回空 bytes，真错在 `get_response()` 里
     （音色与模型不匹配时是 `InvalidParameter / [cosyvoice:]Engine error [411]`）。
     所以判成功只能判音频长度，失败原因另外取。
  2. 流式 wav 的 RIFF/data 长度字段是占位值（实测 declared=2147483591 vs actual=115244），
     播放器会显示十几小时时长、插进 PPT/剪映会异常。→ `_fix_wav_sizes()` 回填。
     （当前固定用 mp3，这个函数是为将来换格式留着。）
  3. `streaming_call()` 不带 callback 会 `InputRequired`，只用非流式 `call()`。

延迟与成本（实测，24kHz）
  「张三」≈0.9–1.1 秒 / wav 34KB / mp3 15KB；一句十来字 ≈1.4 秒 / mp3 67KB。
  点名播报是短姓名，合成完全藏得进前端约 4.8 秒的滚动动画里，不需要预生成。

计费：按量计费（走 DASHSCOPE_API_KEY）。订阅/TokenPlan 通道只支持
  qwen-audio-3.0-tts-plus 且仅 3 个音色，本仓库音色清单里的音色用不了。
"""
from __future__ import annotations

import asyncio
import hashlib
import struct
import threading
import time
from pathlib import Path
from typing import Any

from backend.api.config_router import get_config_value
from backend.bailian_kb import resolve_api_key      # 与对话链路一致：环境变量优先，回退系统配置
from backend.logger import logger
from backend.question_media import media_dir, url_for
from backend.tts_voices import (DEFAULT_MODEL, DEFAULT_VOICE, MODEL_DEFAULT_VOICE,
                                fix_name_reading, resolve_voice)

# ── 固定参数（刻意不进系统配置，减少管理员决策负担；要改就改这里） ──
AUDIO_FORMAT_NAME = "mp3"                 # 姓名播报走 mp3：体积是 wav 的四成，浏览器原生可播
SAMPLE_RATE = 24000
PITCH_RATE = 1.0
SYNTH_TIMEOUT_SEC = 15                    # 单次合成上限；点名动画 4.8 秒，留足冗余也不至于挂住
MAX_TEXT_CHARS = 200                      # 播报文本长度硬上限（姓名远小于它，防被当免费 TTS 接口刷）

#: 点名播报文本。想只念名字改成 "{name}"、想加提示语改成 "{name}同学，请回答问题" 即可。
ROLLCALL_SPEECH_TEMPLATE = "{name}同学"

#: 产物落盘目录（question_media/tts/）：files_router 已允许"登录即可读"，
#: 且孤儿回收只清纯数字命名的目录，tts 这种具名目录天然豁免。
TTS_DIR_NAME = "tts"

#: SDK 调用是阻塞的（内部起 websocket-client 线程），并发压一压，避免一次批量把 WS 打满
_SYNTH_SEMAPHORE = threading.Semaphore(2)
_KEY_LOCK = threading.Lock()

# ── 失败分类与重试（点名"偶尔念不出名字"的现场治理）──
# 现场日志：websocket connection could not established within 5s —— SDK 内部把建链
# 超时硬编码成 5 秒（SpeechSynthesizer.__start_stream → self.__connect(5)），公网
# 抖一下就会吃满。这类失败绝大多数是**瞬时**的：重试一次基本就好了，而老师看到的
# 却是一个英文异常弹窗。所以这里做三件事：抬一点建链超时、瞬时失败自动重试一次、
# 把失败按"谁能处理"分类（前端据此决定要不要打扰老师）。
WS_CONNECT_TIMEOUT_SEC = 8      # SDK 写死 5 秒，这里抬到 8 秒（仅首次建链，正常时无感）
MAX_ATTEMPTS = 2                # 首次 + 1 次重试
RETRY_BACKOFF_SEC = 0.4

#: 失败分类（与前端 utils/nameSpeech.ts 的提示策略一一对应）
FAIL_TRANSIENT = "transient"    # 网络抖动/建链超时/服务端 5xx：重试，UI 静默
FAIL_QUOTA = "quota"            # 账号限额或并发受限：跟老师无关，UI 静默
FAIL_CONFIG = "config"          # 音色与模型不匹配、没配 Key：需要管理员动手，UI 提示一次
FAIL_DISABLED = "disabled"      # 总开关关掉了
FAIL_INVALID = "invalid"        # 入参问题（空文本、超长、姓名不在名册）
FAIL_UNKNOWN = "unknown"        # 认不出来：不重试，UI 用一句人话 + 重试按钮兜着

_TRANSIENT_HINTS = (
    "websocket", "could not established", "connection", "timed out", "timeout",
    "temporarily", "unavailable", "reset by peer", "broken pipe", "eof",
    "502", "503", "504", "internal error",
)


def classify_error(raw: str) -> tuple[str, str]:
    """SDK/服务端异常文本 → (error_kind, 给老师看的一句话)。

    原始文本既不友好也不可执行（`websocket connection could not established
    within 5s. Please check your network connection, firewall settings, or
    server status.`），前端绝不直接展示；完整内容只进后端日志，管理员在
    「系统配置 → 语音合成 → 自检」里看得到。
    """
    low = (raw or "").lower()
    if "411" in low or "invalidparameter" in low or "engine error" in low:
        return FAIL_CONFIG, "音色与模型不匹配，请到「系统配置 → 语音合成」把音色改成与当前模型配套的"
    if "throttl" in low or "quota" in low or "limit" in low:
        return FAIL_QUOTA, "语音服务当前限流或配额不足，稍后会自动恢复"
    if any(h in low for h in _TRANSIENT_HINTS):
        return FAIL_TRANSIENT, "语音服务连接超时（网络抖动），本次未生成语音"
    return FAIL_UNKNOWN, "语音服务暂时不可用，本次未生成语音"


# ══════════════════════════════ 配置读取 ══════════════════════════════

def tts_enabled() -> bool:
    """总开关：关掉时全线不调用（点名页接口会直接回 feature_off，不产生任何计费请求）"""
    return bool(get_config_value("TTS_ENABLED", False))


def current_params() -> dict[str, Any]:
    """当前生效的合成参数（运行时读配置，改完即生效、无需重启）。

    音色与模型不配对时**不能静默失败**：点名现场念不出名字比念错名字更糟。
    所以这里检测到"明确属于另一个模型"的音色，就回落本模型默认音色并写 warning，
    让管理员在日志与自检里都能看到该去改配置。清单外的手填音色不回落（放行试一次）。
    """
    model = str(get_config_value("TTS_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL).strip()
    configured_voice = str(get_config_value("TTS_VOICE", DEFAULT_VOICE) or "").strip()
    resolved = resolve_voice(configured_voice, model)
    voice = resolved["voice"]
    if resolved["status"] == "mismatch":
        voice = MODEL_DEFAULT_VOICE.get(model, DEFAULT_VOICE)
        logger.warning(
            f"[tts] 配置的音色 {resolved['voice']} 属于模型 {resolved['owner_model']}，"
            f"与当前模型 {model} 不配对（实测报 411），本次已回落 {voice}；"
            "请到 系统配置 → 语音合成 把音色改回来")
    try:
        rate = float(get_config_value("TTS_SPEECH_RATE", 1.0))
    except (TypeError, ValueError):
        rate = 1.0
    try:
        volume = int(float(get_config_value("TTS_VOLUME", 50)))
    except (TypeError, ValueError):
        volume = 50
    return {
        "enabled": tts_enabled(),
        "model": model,
        "voice": voice,
        "voice_configured": configured_voice,
        "voice_status": resolved["status"],
        "speech_rate": min(2.0, max(0.5, rate)),
        "volume": min(100, max(0, volume)),
        "pitch_rate": PITCH_RATE,
        "fmt": AUDIO_FORMAT_NAME,
        "sample_rate": SAMPLE_RATE,
    }


# ══════════════════════════════ 缓存 ══════════════════════════════

def _cache_dir() -> Path:
    path = media_dir(extra=TTS_DIR_NAME)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _cache_key(params: dict[str, Any], text: str) -> str:
    """音色/语速/音量任一项变化都会换键 → 自动重合成，不会拿到旧声音"""
    raw = "|".join([params["model"], params["voice"], params["fmt"],
                    str(params["sample_rate"]), f'{params["speech_rate"]:.2f}',
                    str(params["volume"]), text])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:32]


def cache_path(params: dict[str, Any], text: str) -> Path:
    return _cache_dir() / f"{_cache_key(params, text)}.{params['fmt']}"


# ══════════════════════════════ 合成 ══════════════════════════════

def _fix_wav_sizes(data: bytes) -> bytes:
    """回填 RIFF/data 长度（流式 wav 的头部长度是占位值，见模块 docstring 坑 2）"""
    if len(data) < 44 or data[:4] != b"RIFF":
        return data
    if struct.unpack("<I", data[4:8])[0] <= len(data):
        return data                          # 长度正常，别乱改
    buf = bytearray(data)
    struct.pack_into("<I", buf, 4, len(buf) - 8)
    # data 块的位置不写死 36：标准头是 44 字节，但带 LIST/fact 等扩展块的 wav
    # 会挪位，扫一遍比猜偏移可靠。找到就把它的长度也回填。
    pos = buf.find(b"data", 12, min(len(buf) - 8, 4096))
    if pos >= 0:
        struct.pack_into("<I", buf, pos + 4, len(buf) - pos - 8)
    logger.info(f"[tts] wav 头部长度已回填 {len(buf)} 字节")
    return bytes(buf)


def _failure_reason(synth: Any) -> tuple[str, str, str]:
    """从 SDK 的最后一个事件里抠出失败原因（call() 失败不抛异常，只能这么取）

    返回 (error_kind, 给老师看的一句话, 原始 code/message 供写日志)。
    """
    try:
        resp = synth.get_response() or {}
    except Exception:
        return FAIL_TRANSIENT, "语音服务未返回音频，本次未生成语音", "get_response 异常"
    header = (resp.get("header") or {}) if isinstance(resp, dict) else {}
    code = str(header.get("error_code") or "")
    msg = str(header.get("error_message") or "")[:200]
    raw = f"{code or 'task-failed'}: {msg}".strip(": ")
    kind, friendly = classify_error(f"{code} {msg}")
    return kind, friendly, raw or "服务端未返回音频"


def _make_synthesizer(dashscope: Any, SpeechSynthesizer: Any, params: dict[str, Any],
                      fmt: Any) -> Any:
    """构造 SpeechSynthesizer，并把 SDK 写死的 5 秒建链超时抬到 8 秒。

    SDK 里 `__start_stream()` 是 `self.__connect(5)` —— 5 是显式传的实参，
    所以只能覆写这个私有方法并**忽略传入值**。SDK 内部结构将来变了也不怕：
    取不到私有方法、或子类构造失败，就原样返回原类实例（退回 5 秒 + 重试兜底）。
    """
    kwargs = dict(model=params["model"], voice=params["voice"], format=fmt,
                  volume=params["volume"], speech_rate=params["speech_rate"],
                  pitch_rate=params["pitch_rate"])
    if not hasattr(SpeechSynthesizer, "_SpeechSynthesizer__connect"):
        return SpeechSynthesizer(**kwargs)

    class _Synth(SpeechSynthesizer):                      # type: ignore[misc, valid-type]
        def _SpeechSynthesizer__connect(self, timeout_seconds: int = 5) -> None:
            return super()._SpeechSynthesizer__connect(WS_CONNECT_TIMEOUT_SEC)

    try:
        return _Synth(**kwargs)
    except Exception as exc:                              # 覆写失败不影响主流程
        logger.debug(f"[tts] 建链超时覆写未生效，回退原始 SDK 类: {exc}")
        return SpeechSynthesizer(**kwargs)


def _synth_once(text: str, params: dict[str, Any], dest: Path) -> dict[str, Any]:
    """单次合成尝试：调 SDK → 校验音频 → 原子落盘。失败不抛异常，带 error_kind 返回。"""
    t0 = time.time()
    synth = None
    with _SYNTH_SEMAPHORE:
        try:
            import dashscope
            from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer

            fmt = (AudioFormat.MP3_24000HZ_MONO_256KBPS if params["fmt"] == "mp3"
                   else AudioFormat.WAV_24000HZ_MONO_16BIT)
            # SDK 在构造时读全局 dashscope.api_key，所以赋值与构造要在同一把锁里；
            # 本系统全线共用同一个 Key，加锁只是避免读到半初始化状态。
            with _KEY_LOCK:
                dashscope.api_key = resolve_api_key()
                synth = _make_synthesizer(dashscope, SpeechSynthesizer, params, fmt)
                audio = synth.call(text, timeout_millis=SYNTH_TIMEOUT_SEC * 1000)
        except Exception as exc:
            raw = f"{type(exc).__name__}: {exc}"
            kind, friendly = classify_error(raw)
            logger.warning(f"[tts] 合成异常 model={params['model']} voice={params['voice']} "
                           f"kind={kind}: {raw[:300]}")
            return {"ok": False, "error": friendly, "error_kind": kind,
                    "error_detail": raw[:200], "cached": False,
                    "cost_ms": int((time.time() - t0) * 1000)}

    cost_ms = int((time.time() - t0) * 1000)
    if not audio or len(audio) < 512:
        kind, friendly, raw = _failure_reason(synth)
        logger.warning(f"[tts] 合成失败({cost_ms}ms) kind={kind} text={text[:20]!r} "
                       f"voice={params['voice']} :: {raw}")
        return {"ok": False, "error": friendly, "error_kind": kind,
                "error_detail": raw[:200], "cached": False, "cost_ms": cost_ms}

    if params["fmt"] == "wav":
        audio = _fix_wav_sizes(audio)
    try:
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(audio)
        tmp.replace(dest)                    # 原子落盘，避免并发下把半个文件当完整的播出去
    except OSError as exc:
        logger.warning(f"[tts] 音频落盘失败 {dest}: {exc}")
        return {"ok": False, "error": f"音频写入失败：{exc}", "error_kind": FAIL_UNKNOWN,
                "cached": False, "cost_ms": cost_ms}

    logger.info(f"[tts] 合成成功 {cost_ms}ms {len(audio)}B voice={params['voice']} text={text[:20]!r}")
    return {"ok": True, "url": url_for(extra=TTS_DIR_NAME, filename=dest.name),
            "cached": False, "cost_ms": cost_ms, "bytes": len(audio), "text": text}


def synthesize_blocking(text: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """同步合成一段音频并落盘（**不要在事件循环里直接调**，用 synthesize()）。

    Returns:
        {ok, url, cached, error, error_kind, error_detail, cost_ms, bytes, text}
        失败时 ok=False 且带中文 error，不抛异常 —— 点名不能被音频问题挡住。
        瞬时失败（建链超时/网络抖动）会自动重试一次：点名现场"偶尔念不出名字"
        绝大多数就是这么来的，重试一次通常就好了，老师不会看到任何提示。
    """
    text = str(text or "").strip()
    params = params or current_params()
    if not text:
        return {"ok": False, "error": "播报文本为空", "error_kind": FAIL_INVALID, "cached": False}
    if len(text) > MAX_TEXT_CHARS:
        return {"ok": False, "error": f"播报文本超过 {MAX_TEXT_CHARS} 字上限",
                "error_kind": FAIL_INVALID, "cached": False}
    if not params.get("enabled"):
        return {"ok": False, "error": "语音合成未启用", "error_kind": FAIL_DISABLED, "cached": False}

    key = resolve_api_key()
    if not key:
        return {"ok": False, "error": "API Key 未配置，请在系统配置中填写 DashScope API Key",
                "error_kind": FAIL_CONFIG, "cached": False}

    dest = cache_path(params, text)
    if dest.exists() and dest.stat().st_size > 1024:
        return {"ok": True, "url": url_for(extra=TTS_DIR_NAME, filename=dest.name),
                "cached": True, "cost_ms": 0, "bytes": dest.stat().st_size, "text": text}

    # 瞬时失败自动重试一次：第一次多半死在"建链超时"（5→8 秒仍不通就是真抖了），
    # 0.4 秒后再来一次通常就成功，而且成功即落缓存 —— 同一名学生下一轮秒回。
    result: dict[str, Any] = {}
    attempts = 0
    for attempt in range(1, MAX_ATTEMPTS + 1):
        attempts = attempt
        result = _synth_once(text, params, dest)
        if result.get("ok") or result.get("error_kind") != FAIL_TRANSIENT \
                or attempt >= MAX_ATTEMPTS:
            break
        logger.info(f"[tts] 第 {attempt} 次失败（{result.get('error')}），"
                    f"{RETRY_BACKOFF_SEC}s 后重试")
        time.sleep(RETRY_BACKOFF_SEC)
    result["attempts"] = attempts
    return result


async def synthesize(text: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """异步包装：SDK 是阻塞调用，扔进线程池，别把事件循环卡住（SSE/其他请求会一起停）"""
    return await asyncio.to_thread(synthesize_blocking, text, params or current_params())


# ══════════════════════════════ 自检 ══════════════════════════════

#: 自检短句：够听出音色差异，又短到几乎不产生成本
SELFTEST_TEXT = "这是语音合成自检，用来确认当前模型与音色可以正常出声。"


async def self_test() -> dict[str, Any]:
    """用**当前配置**合成一句自检音频，返回可播放 URL。

    刻意把 voice_configured / voice / voice_status 三个都回传：
    管理员改模型后音色可能仍是上一个模型的（页面下拉没跟上的情况），
    只回一个 voice 值看不出"配置写的是什么、实际用的是什么"。
    """
    params = current_params()
    out: dict[str, Any] = {"model": params["model"], "voice_configured": params["voice_configured"],
                           "voice": params["voice"], "voice_status": params["voice_status"],
                           "speech_rate": params["speech_rate"], "volume": params["volume"]}
    if not params["enabled"]:
        return {**out, "ok": False, "disabled": True, "error": "语音合成未启用（总开关关闭）"}
    result = await synthesize(SELFTEST_TEXT, params)
    # 失败时把 error_kind / error_detail / attempts 一并回给管理员自检页：
    # error 是给老师看的人话，error_detail 才是"到底为什么"（如建链超时原文）
    out.update({k: v for k, v in result.items()
                if k in ("ok", "url", "cached", "cost_ms", "bytes", "error",
                         "error_kind", "error_detail", "attempts")})
    if out.get("ok"):
        out["text"] = SELFTEST_TEXT
    return out


# ══════════════════════════════ 场景封装 ══════════════════════════════

async def speak_student_name(name: str) -> dict[str, Any]:
    """智能点名：念某位学生的姓名。

    多音姓氏在这里换成同音常用字（只影响合成文本，界面与历史里仍是原姓名）。
    """
    display = str(name or "").strip()
    if not display:
        return {"ok": False, "error": "姓名为空", "cached": False}
    text = ROLLCALL_SPEECH_TEMPLATE.format(name=fix_name_reading(display))
    result = await synthesize(text)
    result["display_name"] = display
    result["speech_text"] = text
    return result
