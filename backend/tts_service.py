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
from backend.tts_voices import DEFAULT_MODEL, DEFAULT_VOICE, fix_name_reading, normalize_voice

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


# ══════════════════════════════ 配置读取 ══════════════════════════════

def tts_enabled() -> bool:
    """总开关：关掉时全线不调用（点名页接口会直接回 feature_off，不产生任何计费请求）"""
    return bool(get_config_value("TTS_ENABLED", False))


def current_params() -> dict[str, Any]:
    """当前生效的合成参数（运行时读配置，改完即生效、无需重启）"""
    model = str(get_config_value("TTS_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL).strip()
    voice = normalize_voice(get_config_value("TTS_VOICE", DEFAULT_VOICE), model)
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


def _failure_reason(synth: Any) -> str:
    """从 SDK 的最后一个事件里抠出可读原因（call() 失败不抛异常，只能这么取）"""
    try:
        resp = synth.get_response() or {}
    except Exception:
        return "服务端未返回音频"
    header = (resp.get("header") or {}) if isinstance(resp, dict) else {}
    code = str(header.get("error_code") or "")
    msg = str(header.get("error_message") or "")[:200]
    if "411" in msg or "InvalidParameter" in code:
        return (f"音色与模型不匹配（{code or 'InvalidParameter'}）："
                "voice 必须属于所填 model，跨模型混用会报 411")
    if "Throttling" in code or "quota" in msg.lower():
        return f"账号配额或并发受限：{msg}"
    return f"{code or 'task-failed'}: {msg}" or "服务端未返回音频"


def synthesize_blocking(text: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """同步合成一段音频并落盘（**不要在事件循环里直接调**，用 synthesize()）。

    Returns:
        {ok, url, cached, error, cost_ms, bytes, text}
        失败时 ok=False 且带中文 error，不抛异常 —— 点名不能被音频问题挡住。
    """
    text = str(text or "").strip()
    params = params or current_params()
    if not text:
        return {"ok": False, "error": "播报文本为空", "cached": False}
    if len(text) > MAX_TEXT_CHARS:
        return {"ok": False, "error": f"播报文本超过 {MAX_TEXT_CHARS} 字上限", "cached": False}
    if not params.get("enabled"):
        return {"ok": False, "error": "语音合成未启用", "cached": False}

    key = resolve_api_key()
    if not key:
        return {"ok": False, "error": "API Key 未配置，请在系统配置中填写 DashScope API Key",
                "cached": False}

    dest = cache_path(params, text)
    if dest.exists() and dest.stat().st_size > 1024:
        return {"ok": True, "url": url_for(extra=TTS_DIR_NAME, filename=dest.name),
                "cached": True, "cost_ms": 0, "bytes": dest.stat().st_size, "text": text}

    t0 = time.time()
    with _SYNTH_SEMAPHORE:
        try:
            import dashscope
            from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer

            fmt = (AudioFormat.MP3_24000HZ_MONO_256KBPS if params["fmt"] == "mp3"
                   else AudioFormat.WAV_24000HZ_MONO_16BIT)
            # SDK 在构造时读全局 dashscope.api_key，所以赋值与构造要在同一把锁里；
            # 本系统全线共用同一个 Key，加锁只是避免读到半初始化状态。
            with _KEY_LOCK:
                dashscope.api_key = key
                synth = SpeechSynthesizer(
                    model=params["model"], voice=params["voice"], format=fmt,
                    volume=params["volume"], speech_rate=params["speech_rate"],
                    pitch_rate=params["pitch_rate"],
                )
                audio = synth.call(text, timeout_millis=SYNTH_TIMEOUT_SEC * 1000)
        except Exception as exc:
            logger.warning(f"[tts] 合成异常 model={params['model']} voice={params['voice']}: {exc}")
            return {"ok": False, "error": f"合成异常：{type(exc).__name__}: {str(exc)[:160]}",
                    "cached": False, "cost_ms": int((time.time() - t0) * 1000)}

    cost_ms = int((time.time() - t0) * 1000)
    if not audio or len(audio) < 512:
        reason = _failure_reason(synth)
        logger.warning(f"[tts] 合成失败({cost_ms}ms) text={text[:20]!r} voice={params['voice']} :: {reason}")
        return {"ok": False, "error": reason, "cached": False, "cost_ms": cost_ms}

    if params["fmt"] == "wav":
        audio = _fix_wav_sizes(audio)
    try:
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(audio)
        tmp.replace(dest)                    # 原子落盘，避免并发下把半个文件当完整的播出去
    except OSError as exc:
        logger.warning(f"[tts] 音频落盘失败 {dest}: {exc}")
        return {"ok": False, "error": f"音频写入失败：{exc}", "cached": False, "cost_ms": cost_ms}

    logger.info(f"[tts] 合成成功 {cost_ms}ms {len(audio)}B voice={params['voice']} text={text[:20]!r}")
    return {"ok": True, "url": url_for(extra=TTS_DIR_NAME, filename=dest.name),
            "cached": False, "cost_ms": cost_ms, "bytes": len(audio), "text": text}


async def synthesize(text: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """异步包装：SDK 是阻塞调用，扔进线程池，别把事件循环卡住（SSE/其他请求会一起停）"""
    return await asyncio.to_thread(synthesize_blocking, text, params or current_params())


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