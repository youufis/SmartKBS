# -*- coding: utf-8 -*-
"""AI 调用输出预算的统一口径：一张表、一个入口、一个全局上限。

为什么要收口
------------
max_tokens 以前散落在十几个调用点里各写一个数（8000 / 16000 / 1200 / 300 / 200*n+200 …），
带来三个反复踩到的问题：

1. **写小了静默截断**：教案、课件、出题这类长输出被腰斩，表现是"解析只剩半句、
   公式只剩 \rac{2}{2}、整批缺答案"，而日志只留一行 len=xxxx；
2. **写大了白等一次超时**：超过模型自身最大输出长度时服务商直接 400，整单失败；
3. **改不动**：想调只能改代码重新发版，配置页看不到，部署机上无从下手。

本模块把"该给多少"集中成命名预算（BUDGETS），每个预算都有一个可覆盖的配置键
（AI_TOKENS_*），并统一被 AI_MAX_OUTPUT_TOKENS 这个全局上限夹一次 —— 所以
"上限大一些"这件事只需要改一个数，而且不会把某个模型顶到 400。

用法
----
    from backend.ai_budget import budget
    text = await call_ai_async(prompt, api_key, max_tokens=budget("lesson_plan"))
    text = await call_ai_async(prompt, api_key, max_tokens=budget("cast_script", units=pages))

约定：调用方**不传** max_tokens 时默认沿用服务商上限（AI_TOKENS_DEFAULT=0），
聊天这类"越长越好"的链路不会被我们凭空砍一刀；把 AI_TOKENS_DEFAULT 调成非 0
即可给全站兜底。
"""
from __future__ import annotations

from typing import Any, Optional

#: 全局上限：任何预算都不会超过它（对齐所用模型的最大输出长度）
KEY_MAX = "AI_MAX_OUTPUT_TOKENS"
#: 调用方没给 max_tokens 时的兜底；0 = 不发该参数，沿用服务商默认
KEY_DEFAULT = "AI_TOKENS_DEFAULT"

#: 命名预算表。default=固定预算；per_unit/base/floor/cap=按量估算（units 一般是题数/份数/分钟/页）
#: key=配置页可覆盖的键名；note 会进配置页文案与排障输出
BUDGETS: dict[str, dict[str, Any]] = {
    # ── 长文本生成（最容易腰斩的一类）──
    "lesson_plan":      {"default": 8000,  "key": "AI_TOKENS_LESSON_PLAN",      "note": "AI 教案 / 教学设计正文"},
    "courseware_html":  {"default": 16000, "key": "AI_TOKENS_COURSEWARE_HTML",  "note": "AI 课件（整页 HTML）"},
    "resource_html":    {"default": 16000, "key": "AI_TOKENS_RESOURCE_HTML",    "note": "资源中心 AI 生成 HTML 页面"},
    "task_draft":       {"default": 1500,  "key": "AI_TOKENS_TASK_DRAFT",       "note": "作业 / 任务起草"},
    # ── 出题链路（按题量估，见 ai_service.estimate_question_tokens）──
    "question_per_item": {"default": 1400, "key": "QUESTION_GEN_TOKENS_PER_ITEM", "note": "出题单题预算（含配图自动 x2）"},
    "question_min":      {"default": 4000, "key": "QUESTION_GEN_TOKENS_MIN",      "note": "出题单次下限"},
    "question_max":      {"default": 16000, "key": "QUESTION_GEN_TOKENS_MAX",     "note": "出题单次上限"},
    # ── 批改 ──
    "grading_short":    {"default": 900,   "key": "AI_TOKENS_GRADING_SHORT",    "note": "单条简答/填空批改"},
    "grading_essay":    {"default": 1600,  "key": "AI_TOKENS_GRADING_ESSAY",    "note": "单条作文多维批改"},
    "grading_batch":    {"per_unit": 200, "base": 200, "floor": 400, "cap": 16000,
                         "key": "AI_TOKENS_GRADING_BATCH", "note": "批量批改：份数 x 每份预算 + 余量"},
    "grading_batch_per_item": {"default": 200, "key": "AI_TOKENS_GRADING_BATCH_PER_ITEM", "note": "批量批改每份摊的预算"},
    "grading_batch_margin":   {"default": 200, "key": "AI_TOKENS_GRADING_BATCH_MARGIN",   "note": "批量批改固定余量"},
    # ── 音频 / 讲演 ──
    "podcast_topics":   {"default": 1200,  "key": "AI_TOKENS_PODCAST_TOPICS",   "note": "播客候选话题（短 JSON）"},
    "podcast_script":   {"per_unit": 900, "base": 0, "floor": 2000, "cap": 8000,
                         "key": "AI_TOKENS_PODCAST_SCRIPT", "note": "播客脚本：按分钟估"},
    "cast_script":      {"per_unit": 260, "base": 600, "floor": 2000, "cap": 8000,
                         "key": "AI_TOKENS_CAST_SCRIPT", "note": "讲演逐页脚本：按页估"},
    "cast_description": {"default": 300,   "key": "AI_TOKENS_CAST_DESCRIPTION", "note": "讲演简介帮写"},
    # ── 简报（按周期）──
    "briefing_day":     {"default": 800,   "key": "AI_TOKENS_BRIEFING_DAY",     "note": "教学简报（日）"},
    "briefing_week":    {"default": 1400,  "key": "AI_TOKENS_BRIEFING_WEEK",    "note": "教学简报（周）"},
    "briefing_month":   {"default": 2000,  "key": "AI_TOKENS_BRIEFING_MONTH",   "note": "教学简报（月）"},
    "briefing_year":    {"default": 2600,  "key": "AI_TOKENS_BRIEFING_YEAR",    "note": "教学简报（年）"},
    # ── 陪伴助手 ──
    "companion_memory": {"default": 400,   "key": "AI_TOKENS_COMPANION_MEMORY", "note": "陪伴助手记忆整理"},
    "companion_push":   {"default": 160,   "key": "AI_TOKENS_COMPANION_PUSH",   "note": "陪伴助手主动消息"},
    # ── 图片题目提取（沿用既有键名）──
    "image_extract":    {"default": 8000,  "key": "IMAGE_EXTRACT_MAX_TOKENS",   "note": "单次图片题目识别"},
}


def _cfg(key: str, fallback: Any) -> Any:
    try:
        from backend.api.config_router import get_config_value
        v = get_config_value(key, fallback)
        return v if v is not None else fallback
    except Exception:                      # 配置层不可用（单测/脚本）时退回表里的默认
        return fallback


def _num(value: Any, fallback: int) -> int:
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return fallback
    return n if n > 0 else fallback


def budget(name: str, units: int = 1, **overrides: Any) -> int:
    """取一个命名预算的最终值：配置覆盖 > 表内公式 > 表内默认，最后夹全局上限。

    units 用于按量估算的预算（题数、份数、分钟、页数）；固定预算传不传都一样。
    """
    spec = BUDGETS.get(name)
    if spec is None:
        raise KeyError("未登记的 AI 输出预算: %s（请在 backend/ai_budget.py 的 BUDGETS 里补一行）" % name)

    key = spec.get("key") or ("AI_TOKENS_" + name.upper())
    n: Optional[int] = None
    if "per_unit" in spec:
        per = _num(overrides.get("per_unit", _cfg(key, spec["per_unit"])), spec["per_unit"])
        base = _num(overrides.get("base", _cfg(key + "_BASE", spec.get("base", 0))), spec.get("base", 0))
        floor = _cfg(key + "_MIN", spec.get("floor", per))
        cap = _cfg(key + "_MAX", spec.get("cap", spec.get("default", 16000)))
        n = max(_num(floor, 0), int(units or 1) * per + base)
        n = min(_num(cap, n), n)
    else:
        n = _num(overrides.get("default", _cfg(key, spec.get("default", 1000))), spec.get("default", 1000))
    return clamp_output_tokens(n)


def clamp_output_tokens(n: int) -> int:
    """全局上限夹一次：配置可以调大，但不许超过 AI_MAX_OUTPUT_TOKENS"""
    cap = _num(_cfg(KEY_MAX, 16000), 16000)
    return int(min(cap, max(64, int(n))))


def default_output_tokens() -> int:
    """调用方没写 max_tokens 时的兜底；0 表示不发这个参数（沿用服务商默认）"""
    try:
        return max(0, int(_cfg(KEY_DEFAULT, 0) or 0))
    except (TypeError, ValueError):
        return 0


def describe() -> dict[str, Any]:
    """排障用：把当前生效的预算全部列出来（配置页/接口都能直接读）"""
    return {
        "global_max": clamp_output_tokens(10 ** 9),
        "default_when_unset": default_output_tokens(),
        "budgets": {name: budget(name) for name in BUDGETS},
    }
