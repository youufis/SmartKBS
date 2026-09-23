# -*- coding: utf-8 -*-
"""公共选题入口（适配器）：按 学科族+题型+知识点 从题库抽题。

历史上本文件自己写了一套 `knowledge_points LIKE ? OR question_text LIKE ?` + `ORDER BY
RANDOM()`，与各活动入口的另 5 套写法互不一致，且命中无优先级、结果每次都抖。
现在统一走 backend.question_select（分层召回 T1>T2>T3>T4(>T5) + 学科族隔离 + 可解释审计），
本文件只负责把 question_bank 原始行加工成各业务习惯的形状。
"""
from __future__ import annotations

import json
from typing import Any

from backend.question_select import log_audit, select_questions

# 最近一次选题的审计信息（调用方可读出来展示"为什么只有 N 题/为什么放宽了"）
LAST_AUDIT: dict[str, Any] = {}


def _parse(raw: Any, default: Any) -> Any:
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return default
    return raw if raw is not None else default


def bank_notice_from_audit(audit: dict[str, Any]) -> str:
    from backend.question_select import bank_notice
    return bank_notice(audit or {})


def query_bank_questions(
    topic: str,
    subject: str,
    question_type: str,
    count: int,
    types: tuple[str, ...] | None = None,
    *,
    scene: str = "question_search",
    exclude_ids: tuple[int, ...] | list[int] = (),
    difficulty: str = "",
    allow_family_fallback: bool = False,
) -> list[dict[str, Any]]:
    """随机抽取题库匹配题（分层召回；返回 options 已解析为 dict）。

    topic 支持"知识点全名"或以分隔符串起来的多个知识点；
    types 为候选题型白名单（默认与旧口径一致：单选+判断）；
    question_type != "mixed" 时进一步限定为单一题型。
    """
    global LAST_AUDIT
    qtypes: tuple[str, ...]
    if question_type and question_type != "mixed":
        qtypes = (question_type,)
    else:
        qtypes = tuple(types or ("single", "true_false"))
    rows, audit = select_questions(
        kp_name=topic or "", subject=subject or "", types=qtypes, count=count,
        exclude_ids=list(exclude_ids or []), difficulty=difficulty,
        allow_family_fallback=allow_family_fallback, seed=f"{scene}|{subject}|{topic}",
    )
    LAST_AUDIT = audit
    if scene:
        log_audit(scene, audit)
    out: list[dict[str, Any]] = []
    for r in rows or []:
        r = dict(r)
        r["options"] = _parse(r.get("options"), {}) or {}
        r["media_files"] = _parse(r.get("media_files"), "")
        r["media_placeholders"] = _parse(r.get("media_placeholders"), "")
        out.append(r)
    return out
