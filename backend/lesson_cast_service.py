# -*- coding: utf-8 -*-
"""AI 讲演服务：知识点 → 分页讲稿 → 逐句 TTS → 结构化时间轴。

设计见 docs/ai-lessoncast/00-方案建议.md，三条不可回退的约束：

1. **AI 只产出结构化脚本，画面由前端版式模板渲染**。模型给 `layout` 枚举 + 字段，
   不给 HTML；否则无法翻页、无法定位、无法单页重录。
2. **一句一段音频**，不做 merge。播客为压调用次数会把同角色相邻句合并，这里**不能合并**——
   合并后一段含多句，字幕就只能整段高亮。代价是调用次数上升，但 `tts_service` 的缓存键
   是 sha1(参数+文本)，同一句话重复合成 cost_ms=0，所以句级合成实际不重复计费。
3. **翻页只由音频 ended 驱动**。本模块算出的 `page` 归属 + 逐段 `seconds` 就是时间轴，
   前端不做字数估算；真实时长在播放时用 audio.duration 回写校正。

与播客模块的分工：播客是「纯听觉」，本模块是「看 + 听」，共用音色与 TTS，但不共用脚本结构。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from datetime import datetime
from typing import Any

from backend import podcast_service as podcast
from backend.api.config_router import get_config_value
from backend.logger import logger
from backend.prompts.teaching import CAST_SCRIPT_PROMPT, CAST_STYLE_BLOCKS
from backend.tts_service import MAX_TEXT_CHARS, current_params, synthesize, tts_enabled

# ── 参数（要改就改这里；档位与上限同时可被系统配置覆盖）──
DURATION_FALLBACK: tuple[int, ...] = (3, 4, 5)
DEFAULT_MINUTES_FALLBACK = 5
MAX_SECONDS_FALLBACK = 300
MAX_PAGES_FALLBACK = 10
TTS_CONCURRENCY_FALLBACK = 6

#: 每页字数预算的一半在口语里约等于 4.5 字/秒（单主讲）、4.0 字/秒（双主播有换人停顿）
CHARS_PER_MINUTE = {"single": 270, "duo": 240}
#: 页数 ≈ 分钟 × 1.8（5 分钟 ≈ 9 页）
PAGES_PER_MINUTE = 1.8

#: 允许的版式（与前端 components/lessoncast/layouts 一一对应）
LAYOUTS = {"cover", "bullets", "compare", "steps", "figure", "summary", "cards"}


class CastDisabled(Exception):
    """语音合成总闸关闭。与播客 PodcastDisabled 同口径：配置问题，不该重试。"""


class CastError(Exception):
    """生成过程中的可读错误（原样展示给老师）。"""


# ══════════════════════════ 配置 ══════════════════════════


def duration_options() -> list[int]:
    """可选时长档位（分钟）。配置形如 "3,4,5"；缺失或非法时回落默认三档。"""
    raw = str(get_config_value("CAST_DURATION_OPTIONS", "") or "").strip()
    out: list[int] = []
    for part in re.split(r"[,，\s]+", raw):
        if part.isdigit():
            v = int(part)
            if 1 <= v <= 30 and v not in out:
                out.append(v)
    return sorted(out) or list(DURATION_FALLBACK)


def default_minutes() -> int:
    """默认档位。取 5 而不是播客的 3：讲演要看完一个完整知识点。"""
    try:
        v = int(get_config_value("CAST_DEFAULT_MINUTES", DEFAULT_MINUTES_FALLBACK))
    except (TypeError, ValueError):
        v = DEFAULT_MINUTES_FALLBACK
    opts = duration_options()
    return v if v in opts else opts[min(1, len(opts) - 1)]


def normalize_minutes(value: Any) -> int:
    """把弹窗传入的档位收进合法集合：非法值回落默认档。"""
    try:
        want = int(value)
    except (TypeError, ValueError):
        want = default_minutes()
    opts = duration_options()
    return want if want in opts else default_minutes()


def max_seconds() -> int:
    try:
        v = int(get_config_value("CAST_MAX_SECONDS", MAX_SECONDS_FALLBACK))
    except (TypeError, ValueError):
        v = MAX_SECONDS_FALLBACK
    # 不超过最大档：档位是给老师的选择，硬上限不该反而更大
    return max(60, min(v, duration_options()[-1] * 60))


def max_pages() -> int:
    try:
        v = int(get_config_value("CAST_MAX_PAGES", MAX_PAGES_FALLBACK))
    except (TypeError, ValueError):
        v = MAX_PAGES_FALLBACK
    return max(3, min(v, 20))


def tts_concurrency() -> int:
    try:
        v = int(get_config_value("CAST_TTS_CONCURRENCY", TTS_CONCURRENCY_FALLBACK))
    except (TypeError, ValueError):
        v = TTS_CONCURRENCY_FALLBACK
    return max(1, min(v, 12))


def tts_available() -> bool:
    """总闸：与播客完全同源（TTS_ENABLED）。不要另造判断。"""
    return bool(tts_enabled())


def disabled_detail(feature: str = "AI 讲演") -> str:
    """与播客 _podcast_disabled_detail() 一字不差，只换功能名。"""
    return f"语音合成未启用，{feature}不可用。请到「系统配置 → AI 与模型 → 语音合成」打开总开关"


def voices_for_mode(speaker_mode: str) -> dict[str, Any]:
    """解析本次要用的音色。复用播客的 A/B 配置，single 只用 A。

    复用而不是新增 CAST_VOICE_* 的好处：管理员只维护一处，两个功能音色天然一致。
    """
    voices = podcast.podcast_voices()
    if speaker_mode == "single":
        return {"model": voices["model"], "A": voices["A"]}
    return voices


def normalize_mode(value: Any) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in ("single", "duo") else "duo"


def target_chars(minutes: int, speaker_mode: str) -> int:
    return int(minutes * CHARS_PER_MINUTE.get(speaker_mode, 240))


def plan_pages(minutes: int) -> int:
    return max(3, min(max_pages(), int(round(minutes * PAGES_PER_MINUTE))))


# ══════════════════════════ 脚本 ══════════════════════════

_MD_JUNK = re.compile(r"[*_`#>]+")
_STAGE_WHISPER = re.compile(r"[（(]\s*(?:笑|停顿|停一下|背景音乐|音乐|音效|语气|旁白)[^)）]{0,6}[)）]")
_SPACE = re.compile(r"\s+")


def _clean_line(text: Any, limit: int = 200) -> str:
    """清掉 Markdown 残留、舞台提示与多余空白（模型偶尔还是会加）。"""
    s = str(text or "")
    s = _STAGE_WHISPER.sub("", s)
    s = _MD_JUNK.sub("", s)
    s = _SPACE.sub(" ", s).strip()
    # 半角引号在中文里很刺眼，统一成全角
    s = s.replace('"', "“").replace("'", "‘")
    return s[:limit]


def _clean_list(items: Any, limit: int = 26, max_items: int = 4) -> list[str]:
    out: list[str] = []
    for it in items or []:
        if isinstance(it, dict):
            # 容错：模型有时给 {"title":..,"desc":..} 而不是字符串
            it = "：".join(str(v) for v in it.values() if v)
        line = _clean_line(it, limit)
        if line:
            out.append(line)
        if len(out) >= max_items:
            break
    return out


def _clean_pairs(items: Any, max_items: int = 6) -> list[list[str]]:
    """steps / cards 统一成 [[标题, 说明], ...]。"""
    out: list[list[str]] = []
    for it in items or []:
        if isinstance(it, dict):
            vals = [str(v) for v in it.values() if v]
        elif isinstance(it, (list, tuple)):
            vals = [str(v) for v in it if v]
        else:
            vals = [str(it)]
        if not vals:
            continue
        head = _clean_line(vals[0], 16)
        desc = _clean_line(vals[1], 40) if len(vals) > 1 else ""
        if head:
            out.append([head, desc])
        if len(out) >= max_items:
            break
    return out


def _clean_side(side: Any) -> dict[str, Any]:
    """compare 的一栏：{head, items[]}。"""
    if not isinstance(side, dict):
        return {"head": "", "items": []}
    head = _clean_line(side.get("head") or side.get("title") or "", 12)
    items = _clean_list(side.get("items") or side.get("points") or [], 30, 4)
    return {"head": head, "items": items}


#: 讲述者称呼固定，不交给 AI 起名。模型看到示例会照抄"林老师"，而讲演面对的是学生，
#: 虚构姓名既没意义、又可能和真实上课的老师对不上。想改成"用当前教师姓名"，
#: 在这里换成查 users 表的显示名即可（只有显示用，名字不进音频，改完无需重新合成）。
SPEAKER_A = "老师"
SPEAKER_B = "同学"


def parse_cast(raw: str, speaker_mode: str = "duo") -> dict[str, Any]:
    """解析并规整模型返回的分页讲稿。

    容错优先：模型偶尔少一个字段、多一页、把 speaker 写成中文，都不该让老师重来一次。
    结构性问题（没有页、没有台词）才报错。
    """
    from backend.utils import extract_json_from_text

    data = extract_json_from_text(raw or "")
    if isinstance(data, list) and data:
        data = data[0]
    if not isinstance(data, dict):
        raise CastError("AI 没有返回可解析的讲稿（JSON 解析失败），请重试")

    pages_in = data.get("pages") or []
    if not isinstance(pages_in, list) or not pages_in:
        raise CastError("AI 返回的讲稿里没有分页内容，请重试")

    mode = normalize_mode(speaker_mode)
    pages: list[dict[str, Any]] = []

    for raw_page in pages_in:
        if not isinstance(raw_page, dict):
            continue

        lines: list[dict[str, str]] = []
        for item in raw_page.get("lines") or []:
            if not isinstance(item, dict):
                continue
            spk = str(item.get("speaker") or item.get("who") or "A").strip().upper()
            if spk in ("B", "互动", "2"):
                spk = "B"
            else:
                spk = "A"
            text = _clean_line(item.get("text") or item.get("line"))
            if text:
                lines.append({"speaker": spk, "text": text})

        # 单主讲：不论模型给了什么，一律归到 A（否则会去解析一个没配的音色）
        if mode == "single":
            lines = [{"speaker": "A", "text": ln["text"]} for ln in lines]

        if not lines:
            continue  # 没有台词的页留着也播不出声音，直接丢

        layout = str(raw_page.get("layout") or "").strip().lower()
        if layout not in LAYOUTS:
            layout = "bullets" if raw_page.get("points") else "cover"

        page: dict[str, Any] = {
            "layout": layout,
            "title": _clean_line(raw_page.get("title") or "", 30) or f"第 {len(pages) + 1} 页",
            "lines": lines,
        }
        kicker = _clean_line(raw_page.get("kicker") or "", 16)
        if kicker:
            page["kicker"] = kicker
        subtitle = _clean_line(raw_page.get("subtitle") or "", 40)
        if subtitle:
            page["subtitle"] = subtitle

        if layout in ("bullets", "summary"):
            page["points"] = _clean_list(raw_page.get("points"), 26, 4)
        elif layout == "compare":
            page["left"] = _clean_side(raw_page.get("left"))
            page["right"] = _clean_side(raw_page.get("right"))
            if not page["left"]["items"] and not page["right"]["items"]:
                page["points"] = _clean_list(raw_page.get("points"), 26, 4)
        elif layout == "steps":
            page["steps"] = _clean_pairs(raw_page.get("steps"), 5)
        elif layout == "cards":
            page["cards"] = _clean_pairs(raw_page.get("cards"), 4)
        elif layout == "figure":
            page["image"] = str(raw_page.get("image") or "").strip()
            page["caption"] = _clean_line(raw_page.get("caption") or "", 60)

        pages.append(page)
        if len(pages) >= max_pages():
            break

    if not pages:
        raise CastError("AI 返回的讲稿里没有可用台词，请重试")

    points: list[str] = []
    for p in data.get("key_points") or []:
        line = _clean_line(p, 24)
        if line:
            points.append(line)

    return {
        "title": _clean_line(data.get("title") or "", 40) or "AI 讲演",
        "summary": _clean_line(data.get("summary") or "", 120),
        "speaker_mode": mode,
        "name_a": SPEAKER_A,
        "name_b": "" if mode == "single" else SPEAKER_B,
        "key_points": points[:5],
        "pages": pages,
    }


def render_prompt(**kw: Any) -> str:
    """渲染讲演提示词。花括号很多，用哨兵替换避免 format 崩掉。"""
    style_block = CAST_STYLE_BLOCKS[kw["speaker_mode"]]
    # 模板本身含 {}，先整体 replace 再 format 会踩坑：这里用逐项替换
    text = CAST_SCRIPT_PROMPT
    values = {
        "{course_name}": kw.get("course_name") or "",
        "{chapter_name}": kw.get("chapter_name") or "",
        "{kp_name}": kw.get("kp_name") or "",
        "{kp_description}": kw.get("kp_description") or "",
        "{learning_objectives}": kw.get("learning_objectives") or "",
        "{grade_hint}": kw.get("grade_hint") or "",
        "{target_minutes}": str(kw.get("target_minutes") or 5),
        "{target_chars}": str(kw.get("target_chars") or 1200),
        "{target_pages}": str(kw.get("target_pages") or 9),
        "{voice_a_desc}": kw.get("voice_a_desc") or "",
        "{voice_b_desc}": kw.get("voice_b_desc") or "",
        "{style_block}": style_block,
    }
    for k, v in values.items():
        text = text.replace(k, str(v))
    return text


def script_max_tokens(minutes: int) -> int:
    """输出上限：每页约 180 token，给足余量避免 JSON 被截断。"""
    return max(2000, min(8000, plan_pages(minutes) * 260 + 600))


# ══════════════════════════ 指纹 ══════════════════════════


def plan_hash(pages: list[dict[str, Any]], voice_a: str, voice_b: str) -> str:
    """大纲指纹：内容或音色任一变化，音频就过期。"""
    raw = json.dumps(pages, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    payload = f"{raw}|{voice_a}|{voice_b}"
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:32]


# ══════════════════════════ 合成 ══════════════════════════


def split_long_text(text: str, limit: int = MAX_TEXT_CHARS) -> list[str]:
    """单句超过 TTS 上限时按句边界切（仍超长就硬切）。一句正常 ≤60 字，很少触发。"""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    buf = ""
    for piece in re.split(r"(?<=[。！？!?；;])", text):
        if not piece:
            continue
        if len(buf) + len(piece) > limit and buf:
            chunks.append(buf)
            buf = ""
        while len(piece) > limit:
            chunks.append(piece[:limit])
            piece = piece[limit:]
        buf += piece
    if buf:
        chunks.append(buf)
    return chunks or [text[:limit]]


def flatten_lines(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把分页台词摊平成待合成队列，保留 page 归属。"""
    flat: list[dict[str, Any]] = []
    for pi, page in enumerate(pages):
        for line in page.get("lines") or []:
            for piece in split_long_text(line["text"]):
                flat.append({"page": pi, "speaker": line["speaker"], "text": piece})
    return flat


async def synthesize_segments(pages: list[dict[str, Any]], voices: dict[str, Any]) -> list[dict[str, Any]]:
    """逐句合成（A/B 各自音色），返回带 url / bytes / seconds 的段列表。"""
    base = current_params()
    if not base.get("enabled"):
        raise CastDisabled(disabled_detail())

    items = flatten_lines(pages)
    if not items:
        raise CastError("讲稿里没有可合成的台词")

    sem = asyncio.Semaphore(tts_concurrency())

    async def _one(idx: int, seg: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            params = dict(base)
            params["voice"] = voices[seg["speaker"]]["voice"]
            res = await synthesize(seg["text"], params)
        if not res.get("ok"):
            raise CastError(f"第 {idx + 1} 句语音合成失败：{res.get('error') or '未知原因'}")
        nbytes = int(res.get("bytes") or 0)
        return {
            "index": idx,
            "page": seg["page"],
            "speaker": seg["speaker"],
            "text": seg["text"],
            "url": res.get("url") or "",
            "bytes": nbytes,
            "seconds": podcast.estimate_seconds(nbytes),
            "cached": bool(res.get("cached")),
        }

    results = await asyncio.gather(*(_one(i, s) for i, s in enumerate(items)),
                                  return_exceptions=True)
    out: list[dict[str, Any]] = []
    for idx, r in enumerate(results):
        if isinstance(r, BaseException):
            # 一段失败不留半成品：已成功段的缓存仍在，重试不重复计费
            raise r if isinstance(r, CastError) else CastError(f"第 {idx + 1} 句合成异常：{r}")
        out.append(r)  # type: ignore[arg-type]
    out.sort(key=lambda x: x["index"])
    return out


def truncate_by_pages(pages: list[dict[str, Any]], segments: list[dict[str, Any]],
                      limit_seconds: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    """超时长上限时**按整页**截断（绝不切在半页），返回 (pages, segments, truncated)。"""
    total = 0.0
    keep_pages = 0
    for pi, page in enumerate(pages):
        page_seconds = sum(float(s.get("seconds") or 0) for s in segments if s["page"] == pi)
        if keep_pages > 0 and total + page_seconds > limit_seconds:
            return pages[:keep_pages], [s for s in segments if s["page"] < keep_pages], True
        total += page_seconds
        keep_pages = pi + 1
    return pages, segments, False


def total_of(segments: list[dict[str, Any]]) -> float:
    return round(sum(float(s.get("seconds") or 0) for s in segments), 2)


def audio_pages(pages: list[dict[str, Any]], segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把音频段挂回页上（前端直接按 pages[].audio 渲染，不用自己 join）。"""
    out: list[dict[str, Any]] = []
    for pi, page in enumerate(pages):
        item = {k: v for k, v in page.items() if k != "lines"}
        item["lines"] = page.get("lines") or []
        item["audio"] = [
            {"speaker": s["speaker"], "text": s["text"], "url": s["url"], "seconds": s["seconds"]}
            for s in segments if s["page"] == pi
        ]
        out.append(item)
    return out


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def log_summary(tag: str, pages: list[dict[str, Any]], segments: list[dict[str, Any]]) -> None:
    cached = sum(1 for s in segments if s.get("cached"))
    logger.info(f"[cast] {tag}: {len(pages)} 页 / {len(segments)} 段 / "
                f"{total_of(segments)}s / 缓存命中 {cached}/{len(segments)}")
