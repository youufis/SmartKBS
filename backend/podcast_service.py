# -*- coding: utf-8 -*-
"""AI 播客服务：知识点 → 双主播脚本 → 分段合成 → 时长截断 → 渲染 HTML 页面。

设计要点（详见 docs/ai-podcast/00-方案建议.md）
------------------------------------------------
1. **AI 只写脚本，页面由本模块模板渲染**。播客页面本质是播放器（分段顺序播放、
   文稿同步高亮、倍速、跳段），让模型写这段 JS 出错率高且没法测；而音频 URL 也只能在
   合成之后才存在。所以：模型产出结构化 JSON → 本模块切段/合成/算时长/渲染页面。
2. **分段合成 + 页面顺序播放，不拼接 mp3**。`tts_service.MAX_TEXT_CHARS = 200` 是硬上限，
   3 分钟稿子约 750 字必然要切段；拼接 mp3 会让总时长与进度条不可靠（无 Xing/VBR 头）。
3. **时长能算准**：dashscope 返回 CBR mp3（`MP3_24000HZ_MONO_256KBPS` = 32 KB/s），
   所以 `秒数 ≈ 字节数 ÷ 码率`，落盘前即可判断是否超档并按上限截断。
4. **双主播 = 角色与音色解耦**：脚本里只有 speaker A/B；A 默认男声（主讲）、
   B 默认女声（互动），都可在系统配置里改（两个槽位，想换主讲是谁就换槽位）。
5. **合并同角色相邻段**：对话体会被切成很多短回合，逐段合成会把 TTS 调用次数推高
   一倍以上。合成前把连续同一 speaker 的段拼起来（拼后 ≤180 字），3 分钟可落到 5~7 次。
"""
from __future__ import annotations

import asyncio
import html as _html
import json
import re
from typing import Any

from backend.api.config_router import get_config_value
from backend.logger import logger
from backend.prompts.teaching import PODCAST_SCRIPT_PROMPT
from backend.tts_service import MAX_TEXT_CHARS, current_params, synthesize, tts_enabled
from backend.tts_voices import catalog_of, resolve_voice, voices_for_ui

# ── 参数（要改就改这里；档位与上限同时进了系统配置，管理员可在配置里覆盖）──
DURATION_OPTIONS_FALLBACK: tuple[int, ...] = (3, 4, 5)
MAX_SECONDS_FALLBACK = 300

#: 中文朗读 rate 1.0 ≈ 250 字/分钟；对话体有换人停顿，取下界
CHARS_PER_MINUTE = 250
#: 每段字数上限（给 TTS 的 200 字硬上限留余量）
SEGMENT_CHAR_LIMIT = 180
#: MP3_24000HZ_MONO_256KBPS 是 CBR 256kbps → 每秒固定 32000 字节，可直接换算时长
BYTES_PER_SECOND = 32000


class PodcastDisabled(Exception):
    """语音合成总闸关闭（或未配 Key）—— 与点名播报同口径，避免任何计费调用"""


class PodcastError(Exception):
    """生成过程中的可读错误（会原样展示给老师）"""


# ══════════════════════════ 配置 ══════════════════════════


def duration_options() -> list[int]:
    """可选时长档位（分钟）。配置形如 "3,4,5"；缺失或非法时回落默认三档。"""
    raw = str(get_config_value("PODCAST_DURATION_OPTIONS", "") or "").strip()
    out: list[int] = []
    for part in re.split(r"[,，\s]+", raw):
        if part.isdigit():
            v = int(part)
            if 1 <= v <= 30 and v not in out:
                out.append(v)
    return sorted(out) or list(DURATION_OPTIONS_FALLBACK)


def max_seconds() -> int:
    """硬上限（秒）。默认 300（5 分钟），与最大档一致。"""
    try:
        v = int(get_config_value("PODCAST_MAX_SECONDS", MAX_SECONDS_FALLBACK))
    except (TypeError, ValueError):
        v = MAX_SECONDS_FALLBACK
    return max(60, min(v, 1800))


def normalize_minutes(minutes: Any) -> int:
    """把弹窗传进来的档位收进合法集合：非法值回落默认档（第一个）。"""
    try:
        want = int(minutes)
    except (TypeError, ValueError):
        want = 0
    opts = duration_options()
    return want if want in opts else opts[0]


# ══════════════════════════ 音色 ══════════════════════════


def _pick_voice(model: str, gender: str) -> str:
    """按「性别 + 中文 + main 组」挑一条实测可用音色，优先讲解/旁白类风格。"""
    fallback = ""
    for v in voices_for_ui(model):
        if v.get("gender") != gender:
            continue
        if "中文" not in str(v.get("lang") or ""):
            continue
        if v.get("group") != "main":
            continue
        style = str(v.get("style") or "")
        if "讲解" in style or "旁白" in style:
            return str(v.get("voice") or "")
        fallback = fallback or str(v.get("voice") or "")
    return fallback


def _resolve_voice_for_model(raw: str, model: str, gender: str) -> str:
    """把配置里的音色归一；明确属于别的模型时回落自动挑选（并写 warning，不静默）。"""
    res = resolve_voice(raw, model)
    if res["status"] == "mismatch":
        picked = _pick_voice(model, gender)
        logger.warning(
            f"[podcast] 配置的播客音色 {res['voice']} 属于模型 {res['owner_model']}，"
            f"与当前合成模型 {model} 不配对（实测报 411），本次回落 {picked}；"
            "请到 系统配置 → 语音合成 把播客音色改回来")
        return picked
    return res["voice"]


def _voice_entry(voice: str, model: str, role: str) -> dict[str, Any]:
    cat = catalog_of(voice, model) or {}
    name = str(cat.get("name") or voice)
    # 目录里的 style 常带括号补注（"知识讲解·沉稳男（主力旁白）"），展示时只留前半段，
    # 否则会套出"龙辉焱杏（知识讲解·沉稳男（主力旁白））"这种双层括号
    style = str(cat.get("style") or "").split("（")[0].strip()
    gender = str(cat.get("gender") or "")
    label = f"{name}（{style}）" if style else name
    return {"role": role, "voice": voice, "name": name, "style": style,
            "gender": gender, "label": label}


def podcast_voices() -> dict[str, Any]:
    """解析出本期要用的 A/B 音色（A 主讲默认男声、B 互动默认女声）。"""
    params = current_params()
    model = str(params["model"])
    raw_a = str(get_config_value("PODCAST_VOICE_A", "") or "").strip()
    raw_b = str(get_config_value("PODCAST_VOICE_B", "") or "").strip()
    voice_a = _resolve_voice_for_model(raw_a or _pick_voice(model, "男"), model, "男")
    voice_b = _resolve_voice_for_model(raw_b or _pick_voice(model, "女"), model, "女")
    if voice_a == voice_b:
        # 两人同音色就没有"双主播"了：B 换成本模型另一条异性音色
        other = _pick_voice(model, "女") if voice_a == _pick_voice(model, "男") else _pick_voice(model, "男")
        if other and other != voice_a:
            voice_b = other
    return {
        "model": model,
        "A": _voice_entry(voice_a, model, "主讲"),
        "B": _voice_entry(voice_b, model, "互动"),
    }


def _voice_desc(entry: dict[str, Any]) -> str:
    gender = entry.get("gender") or ""
    style = entry.get("style") or ""
    name = entry.get("name") or entry.get("voice") or ""
    bits = "".join(x for x in (gender, style) if x)
    return f"{bits}（{name}）" if bits else f"{name}"


# ══════════════════════════ 脚本 ══════════════════════════

#: 渲染哨兵：脚本模板里的 {podcast_schema} 先换成它，format 完再回填带花括号的片段
_SCHEMA_SENTINEL = "\x00__PODCAST_SCHEMA__\x00"


def podcast_schema_block() -> str:
    """播客脚本的输出规范（含 JSON 示例）。**含大量花括号，只能渲染后回填**。"""
    return """━━━━ 输出格式 ━━━━
只输出一个合法的 JSON 对象，不得有任何其他文字（不要写"好的""以下是脚本"这类开场白），
也不要用 Markdown 代码块包裹。

━━━━ 字段（逐字一致） ━━━━
title / topic / summary / key_points / name_a / name_b / segments
- title：本期的标题，12~20 字，可带书名号
- topic：本期话题（用我给的话题原文）
- summary：100 字以内的导语，会显示在页面副标题
- key_points：3~5 条要点，每条 8~16 字，不要标点结尾
- name_a / name_b：给两位主播起的名字（2~4 字，贴合话题）
- segments：段落数组，每段 {"speaker": "A" 或 "B", "text": "可直接朗读的台词"}

━━━━ 示例（形状照抄，内容另写） ━━━━
{
  "title": "三分钟听懂什么是算法",
  "topic": "算法到底是什么",
  "summary": "用做菜的步骤打比方，聊聊算法为什么是计算机的办事指南。",
  "key_points": ["算法是解决问题的步骤", "有输入也有输出", "步骤必须有限且明确"],
  "name_a": "阿算",
  "name_b": "小问",
  "segments": [
    {"speaker": "A", "text": "欢迎收听本期节目。今天我们用三分钟，把算法这个词讲清楚。"},
    {"speaker": "B", "text": "等一下，我总觉得算法是很玄的东西，是不是只有程序员才用得着？"},
    {"speaker": "A", "text": "其实你每天都在用。比如菜谱就是一份算法：先做什么、再做什么、什么时候出锅。"}
  ]
}

━━━━ 朗读铁律（违反会直接毁掉音频） ━━━━
- **严禁公式符号与 LaTeX**：不要写 $...$、\\frac{1}{2}、^2、下标这类写法，
  一律改成口语说法（"二分之一"、"平方"、"下标二"）。这一条与出题 prompt 正好相反，务必注意。
- 严禁 ** 加粗、# 标题、表格、代码块等 Markdown 标记。
- 不要出现括号里的舞台提示或语气标注（如"（笑）""（停顿）"）。""" 


def render_podcast_prompt(**kw: Any) -> str:
    """渲染播客脚本提示词：先按调用点参数 format，再回填带花括号的规范段。

    顺序很关键 —— 规范段里有大量 JSON 花括号，先回填再 format 会被当成占位符解析
    （轻则 KeyError，重则把示例打成乱码）。这套哨兵做法与 prompts/question_schema.py 一致。
    """
    if "{podcast_schema}" not in PODCAST_SCRIPT_PROMPT:
        return PODCAST_SCRIPT_PROMPT.format(**kw)
    tpl = PODCAST_SCRIPT_PROMPT.replace("{podcast_schema}", _SCHEMA_SENTINEL)
    return tpl.format(**kw).replace(_SCHEMA_SENTINEL, podcast_schema_block())


def target_chars(minutes: int) -> int:
    """按时长换算目标字数（提示词里的硬指标）"""
    return int(CHARS_PER_MINUTE * max(1, minutes))


_MD_JUNK = re.compile(r"(\*\*|__|`{1,3}|^#{1,6}\s*)", re.M)
_SPACE = re.compile(r"[ \t\u3000]+")


def _clean_line(text: Any) -> str:
    """清掉 Markdown 残留与多余空白（模型偶尔还是会加）"""
    s = str(text or "")
    s = _MD_JUNK.sub("", s)
    s = _SPACE.sub(" ", s)
    return s.strip()


def parse_script(raw: str) -> dict[str, Any]:
    """解析并校验模型返回的播客脚本。"""
    from backend.utils import extract_json_from_text

    data = extract_json_from_text(raw or "")
    if isinstance(data, list) and data:
        data = data[0]
    if not isinstance(data, dict):
        raise PodcastError("AI 没有返回可解析的播客脚本（JSON 解析失败），请重试")

    segments: list[dict[str, str]] = []
    for item in data.get("segments") or []:
        if not isinstance(item, dict):
            continue
        speaker = str(item.get("speaker") or "A").strip().upper()
        if speaker not in ("A", "B"):
            speaker = "A"
        text = _clean_line(item.get("text"))
        if text:
            segments.append({"speaker": speaker, "text": text})
    if not segments:
        raise PodcastError("AI 返回的脚本里没有可用台词，请重试")

    points: list[str] = []
    for p in data.get("key_points") or []:
        line = _clean_line(p)
        if line:
            points.append(line[:24])

    return {
        "title": _clean_line(data.get("title"))[:60] or "知识播客",
        "topic": _clean_line(data.get("topic"))[:80],
        "summary": _clean_line(data.get("summary"))[:200],
        "key_points": points[:5],
        "name_a": _clean_line(data.get("name_a"))[:8] or "主讲",
        "name_b": _clean_line(data.get("name_b"))[:8] or "互动",
        "segments": segments,
    }


# ══════════════════════════ 切段与合成 ══════════════════════════


def merge_segments(segments: list[dict[str, str]], limit: int = SEGMENT_CHAR_LIMIT) -> list[dict[str, str]]:
    """合并**连续同一 speaker** 的段（拼后 ≤limit），把 TTS 调用次数压下来。"""
    out: list[dict[str, str]] = []
    for seg in segments:
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        if out and out[-1]["speaker"] == seg["speaker"] and len(out[-1]["text"]) + len(text) <= limit:
            out[-1]["text"] = out[-1]["text"] + text
        else:
            out.append({"speaker": seg["speaker"], "text": text})
    return out


_SENT_SPLIT = re.compile(r"(?<=[。！？!?；;])")


def split_long_text(text: str, limit: int = MAX_TEXT_CHARS) -> list[str]:
    """单段超过 TTS 上限时按句子边界切分（仍超长就硬切）。"""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    buf = ""
    for piece in _SENT_SPLIT.split(text):
        if not piece:
            continue
        if len(buf) + len(piece) > limit and buf:
            chunks.append(buf)
            buf = ""
        while len(piece) > limit:            # 单句就超长：硬切
            chunks.append(piece[:limit])
            piece = piece[limit:]
        buf += piece
    if buf:
        chunks.append(buf)
    return chunks or [text[:limit]]


def plan_chunks(merged: list[dict[str, str]]) -> list[dict[str, str]]:
    """最终送给 TTS 的段落列表（每段 ≤ MAX_TEXT_CHARS）"""
    out: list[dict[str, str]] = []
    for seg in merged:
        for part in split_long_text(seg["text"]):
            out.append({"speaker": seg["speaker"], "text": part})
    return out


def estimate_seconds(nbytes: int) -> float:
    """CBR mp3：秒数 ≈ 字节数 ÷ 码率（不解码即可算准）"""
    return round(max(0, int(nbytes)) / BYTES_PER_SECOND, 2)


async def synthesize_chunks(chunks: list[dict[str, str]], voices: dict[str, Any]) -> list[dict[str, Any]]:
    """逐段合成（A/B 各自音色），返回带 url / 字节数 / 秒数的段落列表。"""
    base = current_params()
    if not base.get("enabled"):
        raise PodcastDisabled("语音合成未启用，请在「系统配置 → AI 与模型 → 语音合成」中开启")

    async def _one(idx: int, seg: dict[str, str]) -> dict[str, Any]:
        params = dict(base)
        params["voice"] = voices[seg["speaker"]]["voice"]
        res = await synthesize(seg["text"], params)
        if not res.get("ok"):
            raise PodcastError(f"第 {idx + 1} 段语音合成失败：{res.get('error') or '未知原因'}")
        nbytes = int(res.get("bytes") or 0)
        return {
            "index": idx,
            "speaker": seg["speaker"],
            "text": seg["text"],
            "url": res.get("url") or "",
            "bytes": nbytes,
            "seconds": estimate_seconds(nbytes),
            "cached": bool(res.get("cached")),
        }

    results = await asyncio.gather(*(_one(i, s) for i, s in enumerate(chunks)),
                                   return_exceptions=True)
    out: list[dict[str, Any]] = []
    for idx, r in enumerate(results):
        if isinstance(r, BaseException):
            # 一段失败就不落半成品：把原因说清（已成功段的缓存仍在，重试不重复计费）
            raise r if isinstance(r, PodcastError) else PodcastError(f"第 {idx + 1} 段合成异常：{r}")
        out.append(r)  # type: ignore[arg-type]
    out.sort(key=lambda x: x["index"])
    return out


def truncate_by_seconds(items: list[dict[str, Any]], limit: int) -> tuple[list[dict[str, Any]], bool]:
    """超过时长上限就只保留装得下的前 N 段（首段超限也保留，避免产出空页面）。"""
    kept: list[dict[str, Any]] = []
    total = 0.0
    for it in items:
        if kept and total + it["seconds"] > limit:
            return kept, True
        kept.append(it)
        total += it["seconds"]
    return kept, total > limit


# ══════════════════════════ 页面渲染 ══════════════════════════

_PAGE_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>%%PAGE_TITLE%%</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:linear-gradient(160deg,#0f172a,#1e293b 55%,#0f172a);color:#e2e8f0;
     font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;min-height:100vh;padding:20px}
.wrap{max-width:860px;margin:0 auto}
.crumb{font-size:13px;color:#94a3b8;margin-bottom:8px}
h1{font-size:24px;margin:0 0 6px;line-height:1.35}
.sub{color:#94a3b8;font-size:14px;margin-bottom:14px}
.topic{font-size:14px;color:#c4b5fd;margin:-6px 0 14px}
.tags{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.tag{font-size:12px;padding:3px 10px;border-radius:999px;background:#334155;color:#cbd5e1}
.tag.purple{background:#4c1d95;color:#ddd6fe}
.card{background:rgba(30,41,59,.75);border:1px solid #334155;border-radius:16px;padding:18px;margin-bottom:16px}
.player{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.play{width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;font-size:22px;color:#fff;
      background:linear-gradient(135deg,#8b5cf6,#6366f1)}
.play:disabled{opacity:.5;cursor:default}
.bar{flex:1;min-width:180px;height:8px;border-radius:999px;background:#334155;cursor:pointer;position:relative}
.bar>i{display:block;height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,#8b5cf6,#22d3ee)}
.time{font-variant-numeric:tabular-nums;font-size:14px;color:#cbd5e1;min-width:96px;text-align:right}
.ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
.btn{background:#334155;border:1px solid #475569;color:#e2e8f0;border-radius:10px;padding:6px 12px;
     font-size:13px;cursor:pointer}
.btn.on{background:#6366f1;border-color:#818cf8}
.pts{display:flex;flex-wrap:wrap;gap:8px}
.pt{font-size:14px;background:#1e293b;border:1px solid #334155;border-radius:10px;padding:8px 12px}
.line{display:flex;gap:10px;padding:10px 12px;border-radius:12px;cursor:pointer;margin-bottom:6px;
      border:1px solid transparent;transition:.15s}
.line:hover{background:#1e293b}
.line.cur{background:#312e81;border-color:#6366f1}
.who{flex:0 0 76px;font-size:13px;font-weight:600}
.who.a{color:#a78bfa}.who.b{color:#22d3ee}
.txt{flex:1;font-size:15px;line-height:1.7;color:#cbd5e1}
.foot{color:#64748b;font-size:12px;text-align:center;padding:6px 0 20px}
@media(max-width:560px){h1{font-size:20px}.who{flex-basis:60px;font-size:12px}.txt{font-size:14px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="crumb">%%CRUMB%%</div>
  <h1>%%TITLE%%</h1>
  <div class="sub">%%SUMMARY%%</div>
  <div class="topic">🎯 话题：%%TOPIC%%</div>
  <div class="tags">%%TAGS%%</div>

  <div class="card">
    <div class="player">
      <button class="play" id="play" aria-label="播放">▶</button>
      <div class="bar" id="bar"><i id="fill"></i></div>
      <div class="time" id="time">00:00 / %%TOTAL%%</div>
    </div>
    <div class="ctl">
      <button class="btn" id="prev">⏮ 上一段</button>
      <button class="btn" id="next">下一段 ⏭</button>
      <span style="color:#94a3b8;font-size:13px">倍速</span>
      <button class="btn spd" data-s="0.75">0.75x</button>
      <button class="btn spd on" data-s="1">1x</button>
      <button class="btn spd" data-s="1.25">1.25x</button>
      <button class="btn spd" data-s="1.5">1.5x</button>
      <span id="seg" style="color:#94a3b8;font-size:13px"></span>
    </div>
  </div>

  <div class="card">
    <div style="font-size:14px;color:#94a3b8;margin-bottom:10px">📌 要点</div>
    <div class="pts">%%POINTS%%</div>
  </div>

  <div class="card">
    <div style="font-size:14px;color:#94a3b8;margin-bottom:10px">📝 对话文稿</div>
    <div id="lines">%%LINES%%</div>
  </div>

  <div class="foot">%%FOOT%%</div>
</div>
<script>
var DATA = %%DATA%%;
(function(){
  var segs = DATA.segments, n = segs.length, idx = 0, speed = 1;
  var audio = new Audio();
  var playBtn = document.getElementById('play'), fill = document.getElementById('fill'),
      bar = document.getElementById('bar'), timeEl = document.getElementById('time'),
      segEl = document.getElementById('seg'), lines = DATA.lines;
  var starts = [], acc = 0;
  for (var i = 0; i < n; i++) { starts.push(acc); acc += segs[i].seconds; }
  var totalEst = acc;

  function fmt(s){ s = Math.max(0, Math.round(s)); var m = Math.floor(s/60);
    return (m<10?'0':'')+m+':'+((s%60)<10?'0':'')+(s%60); }
  function paint(){
    var t = (starts[idx]||0) + (isFinite(audio.currentTime)?audio.currentTime:0);
    var tot = Math.max(totalEst, t);
    fill.style.width = (tot > 0 ? Math.min(100, t/tot*100) : 0) + '%';
    timeEl.textContent = fmt(t) + ' / ' + fmt(tot);
    segEl.textContent = '第 ' + (idx+1) + ' / ' + n + ' 段';
    for (var i = 0; i < lines.length; i++) lines[i].classList.toggle('cur', i === idx);
  }
  function load(i, autoplay){
    idx = Math.max(0, Math.min(n-1, i));
    audio.src = segs[idx].url;
    audio.playbackRate = speed;
    paint();
    if (autoplay) audio.play().catch(function(){ playBtn.textContent = '▶'; });
  }
  audio.addEventListener('timeupdate', paint);
  audio.addEventListener('ended', function(){
    // 用真实时长修正这一段（估计值有几 % 误差，逐段校正避免累积漂移）
    if (isFinite(audio.duration) && audio.duration > 0) {
      var diff = audio.duration - segs[idx].seconds;
      segs[idx].seconds = audio.duration;
      for (var j = idx+1; j < n; j++) starts[j] += diff;
      totalEst += diff;
    }
    if (idx + 1 < n) load(idx + 1, true);
    else { playBtn.textContent = '▶'; paint(); }
  });
  playBtn.addEventListener('click', function(){
    if (audio.paused) { if (!audio.src) load(0, true); else { audio.play(); } playBtn.textContent = '⏸'; }
    else { audio.pause(); playBtn.textContent = '▶'; }
  });
  audio.addEventListener('play', function(){ playBtn.textContent = '⏸'; });
  audio.addEventListener('pause', function(){ playBtn.textContent = '▶'; });
  document.getElementById('prev').addEventListener('click', function(){ load(idx-1, !audio.paused); });
  document.getElementById('next').addEventListener('click', function(){ load(idx+1, !audio.paused); });
  bar.addEventListener('click', function(e){
    var r = bar.getBoundingClientRect(), ratio = (e.clientX - r.left) / r.width;
    var target = ratio * totalEst, i = 0;
    while (i < n-1 && target >= starts[i+1]) i++;
    load(i, !audio.paused);
    var into = target - starts[i];
    if (into > 0) audio.addEventListener('loadedmetadata', function once(){
      audio.removeEventListener('loadedmetadata', once);
      try { audio.currentTime = into; } catch (err) {}
    });
  });
  var spds = document.querySelectorAll('.spd');
  for (var k = 0; k < spds.length; k++) (function(btn){
    btn.addEventListener('click', function(){
      speed = parseFloat(btn.getAttribute('data-s')) || 1;
      audio.playbackRate = speed;
      for (var m = 0; m < spds.length; m++) spds[m].classList.toggle('on', spds[m] === btn);
    });
  })(spds[k]);
  for (var q = 0; q < lines.length; q++) (function(el, i){
    el.addEventListener('click', function(){ load(i, true); });
  })(lines[q], q);
  load(0, false);
})();
</script>
</body>
</html>
"""


def _esc(text: Any) -> str:
    """用户/模型文本进 HTML 前一律转义（手输话题也在其中）"""
    return _html.escape(str(text or ""), quote=True)


def render_podcast_html(*, script: dict[str, Any], segments: list[dict[str, Any]],
                        voices: dict[str, Any], meta: dict[str, Any]) -> str:
    """把脚本、音频段与元信息渲染成自包含的播客页面。"""
    name_a = script.get("name_a") or "主讲"
    name_b = script.get("name_b") or "互动"
    tag_a = f"{name_a}·{voices['A'].get('gender') or ''}"
    tag_b = f"{name_b}·{voices['B'].get('gender') or ''}"

    lines_html: list[str] = []
    for i, seg in enumerate(segments):
        who = "a" if seg["speaker"] == "A" else "b"
        label = _esc(name_a if seg["speaker"] == "A" else name_b)
        lines_html.append(
            f'<div class="line" data-i="{i}"><div class="who {who}">{label}</div>'
            f'<div class="txt">{_esc(seg["text"])}</div></div>')

    points = script.get("key_points") or []
    points_html = "".join(f'<div class="pt">• {_esc(p)}</div>' for p in points) \
        or '<div class="pt">本期无额外要点</div>'

    total_seconds = sum(float(s.get("seconds") or 0) for s in segments)
    total_text = f"{int(round(total_seconds)) // 60:02d}:{int(round(total_seconds)) % 60:02d}"

    tags = [f'<span class="tag purple">🎧 双主播对话</span>',
            f'<span class="tag">约 {meta.get("minutes")} 分钟</span>',
            f'<span class="tag">{_esc(tag_a)}</span>',
            f'<span class="tag">{_esc(tag_b)}</span>']
    if meta.get("truncated"):
        tags.append(f'<span class="tag">已按 {meta.get("max_minutes")} 分钟上限截断</span>')

    data = {
        "segments": [{"url": s.get("url") or "", "seconds": float(s.get("seconds") or 0)} for s in segments],
        "lines": list(range(len(segments))),
    }
    # 嵌进 <script> 的 JSON：转义 </ 防提前闭合，并保证中文不转义
    data_json = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")

    page = _PAGE_TEMPLATE
    for token, value in (
        ("%%PAGE_TITLE%%", _esc(script.get("title") or "知识播客")),
        ("%%CRUMB%%", _esc(meta.get("crumb") or "")),
        ("%%TITLE%%", _esc(script.get("title") or "知识播客")),
        ("%%SUMMARY%%", _esc(script.get("summary") or "")),
        ("%%TOPIC%%", _esc(meta.get("topic") or script.get("topic") or "")),
        ("%%TAGS%%", "".join(tags)),
        ("%%TOTAL%%", total_text),
        ("%%POINTS%%", points_html),
        ("%%LINES%%", "".join(lines_html)),
        ("%%FOOT%%", _esc(meta.get("foot") or "")),
        ("%%DATA%%", data_json),
    ):
        page = page.replace(token, value)
    return page


# ══════════════════════════ 编排 ══════════════════════════


async def generate_podcast(*, kp: dict[str, Any], topic: str, minutes: int,
                           grade_hint: str, api_key: str,
                           crumb: str = "", foot: str = "") -> dict[str, Any]:
    """完整生成一条播客：出稿 → 合并分段 → 逐段合成 → 时长截断 → 渲染页面。"""
    if not tts_enabled():
        raise PodcastDisabled("语音合成未启用，请在「系统配置 → AI 与模型 → 语音合成」中开启")

    minutes = normalize_minutes(minutes)
    voices = podcast_voices()
    chars = target_chars(minutes)
    prompt = render_podcast_prompt(
        course_name=kp.get("course_name") or "",
        chapter_name=kp.get("chapter_name") or "",
        kp_name=kp.get("name") or "",
        kp_description=kp.get("description") or "",
        learning_objectives=kp.get("learning_objectives") or "",
        topic=topic or (kp.get("name") or ""),
        target_minutes=minutes,
        target_chars=chars,
        voice_a_desc=_voice_desc(voices["A"]),
        voice_b_desc=_voice_desc(voices["B"]),
        grade_hint=grade_hint or "",
    )

    from backend.api.ai_service import call_ai_async

    logger.info(f"[podcast] 开始出稿 kp={kp.get('name')} topic={topic!r} {minutes}min "
                f"音色 A={voices['A']['voice']} B={voices['B']['voice']}")
    text = await call_ai_async(prompt, api_key, json_mode=True,
                               kb_query=f"{kp.get('course_name') or ''} {kp.get('name') or ''} {topic}")
    script = parse_script(text)

    merged = merge_segments(script["segments"])
    chunks = plan_chunks(merged)
    logger.info(f"[podcast] 出稿完成：原 {len(script['segments'])} 段 → 合并 {len(merged)} 段 "
                f"→ 合成 {len(chunks)} 段")

    items = await synthesize_chunks(chunks, voices)
    limit = min(minutes * 60, max_seconds())
    kept, truncated = truncate_by_seconds(items, limit)
    total = round(sum(float(s.get("seconds") or 0) for s in kept), 2)
    logger.info(f"[podcast] 合成完成：{len(kept)}/{len(items)} 段，估算总时长 {total}s"
                f"{'（已截断）' if truncated else ''}")

    page = render_podcast_html(
        script=script, segments=kept, voices=voices,
        meta={"minutes": minutes, "max_minutes": max(1, max_seconds() // 60),
              "truncated": truncated, "crumb": crumb, "foot": foot,
              "topic": script.get("topic") or topic},
    )
    return {
        "html": page,
        "script": script,
        "segments": kept,
        "seconds": total,
        "truncated": truncated,
        "voices": voices,
        "minutes": minutes,
        "cached_segments": sum(1 for s in kept if s.get("cached")),
    }
