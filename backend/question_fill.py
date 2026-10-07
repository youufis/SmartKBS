# -*- coding: utf-8 -*-
"""凑够 N 道题的统一策略：题库优先 → 缺口交给 AI → AI 题走统一入库口。

为什么要单独一个模块（2026-10-07 全入口走查）
------------------------------------------
"题库优先、不足时 AI 补"这件事，仓库里有两处各写了一遍（同步练习、随堂测验），另有三处
**根本没写**（知识抢答缺口靠 3 道硬编码常识题循环重复凑数；考试自动选题与智能组卷只报缺口
不补题）。同一个策略写两遍就会漂成两套文案与两套降级路径，漏写的那几处则各自发明了
"补不够"的土办法 —— 抢答因此会让学生在一局里看到重复题。

本模块只负责**策略**（谁先谁后、缺多少、失败怎么降级、怎么防与题库重复），
具体"怎么抽题库、怎么问模型、怎么入库"由调用方以三个回调注入：

    fetch_bank(need)        → 题库题（已是给学生/界面看的形状，不入库）
    gen_ai(need, avoid)     → 模型生成的原始题目 dict 列表（可抛 MissingApiKey / 其它异常）
    persist(items)          → 入库（应当走 question_factory）并返回"真正可用"的条目

三条不可让步的规则（都是踩过的坑）
--------------------------------
1. **AI 题必须先入库再返回**，且调用方只能用 persist 的返回值 —— 入库会拒收不合格条目
   （缺答案、答案越界、题干过短），沿用"原地改 + 丢弃返回值"就把判不了分的题发给了学生
   （同步练习真实踩过，见 cac1a84）。
2. **AI 题要和已抽到的题库题防重**：prompt 里虽然写了"禁止重复"，但模型不保证遵守，
   出口必须再拦一道，否则同一份卷子里出现两道同题干，学生白做一遍。
3. **降级不静默**：AI 不可用/失败/被全部拒收时，能给几道给几道，并把原因写进 notes 让老师
   看见（旧实现里有的只写日志、有的干脆不提示，"为什么只有 5 道"变成用户猜）。
"""
from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Sequence

# 与同步练习/随堂测验历史上完全一致的兜底文案（两处原本各写一套，这里统一成一份）
NOTE_NO_KEY = "未配置 API Key，仅返回题库题"
NOTE_BANK_HIT = "题库命中 %d 道"
NOTE_AI_OK = "AI 新生成 %d 道"
NOTE_AI_SHORT = "AI 新生成 %d 道(要求 %d 道, 已尽力补足)"
NOTE_AI_FAIL = "AI 补足失败(%s)，仅返回题库题"

DETAIL_NO_KEY = "未配置 API Key，请在系统配置中设置"
DETAIL_AI_FAIL = "AI 出题失败: %s"
DETAIL_NOTHING = "未能生成可用题目：题库无匹配题，AI 补题也未成功，请重试或调整主题"


class MissingApiKey(Exception):
    """回调里抛出它 = "这台部署没配 AI Key"，与"调用了但失败"要分开处理。"""


@dataclass
class FillUnavailable(Exception):
    """题库一道没有、AI 又补不出来 → 交不出任何题。调用方翻成自己的 HTTP 语义。"""
    status_code: int = 502
    detail: str = DETAIL_NOTHING


@dataclass
class FillResult:
    questions: list[dict[str, Any]]
    bank_count: int
    ai_count: int
    gap: int                       # 还缺几道（>0 说明尽力了仍不够）
    notes: list[str] = field(default_factory=list)
    ai_failed: bool = False        # AI 这条路走过但没成功（供调用方决定要不要提示重试）


def stem_of(item: dict[str, Any]) -> str:
    """取题干：模型侧习惯 question，题库/入库后是 question_text。"""
    return str(item.get("question") or item.get("question_text") or "").strip()


def _norm(text: str) -> str:
    """题干归一：去空白与末尾标点，用于防重比较（与各入库口同一思路）。"""
    return "".join(str(text or "").split()).rstrip("。．.！!？?；;，,").lower()


async def fill_questions(
    *,
    count: int,
    fetch_bank: Callable[[int], Sequence[dict[str, Any]]] | None,
    gen_ai: Callable[[int, list[str]], Awaitable[list[dict[str, Any]]]] | None,
    persist: Callable[[list[dict[str, Any]]], Awaitable[list[dict[str, Any]]]] | None = None,
    text_of: Callable[[dict[str, Any]], str] = stem_of,
    allow_bank_only: bool = True,
    detail_when_empty: str = DETAIL_NOTHING,
) -> FillResult:
    """凑够 count 道题：先题库、缺口 AI 补、AI 题入库后才算数。

    fetch_bank=None 或返回空 → 全靠 AI；gen_ai=None → 只抽题库（缺口如实记在 gap 里，
    调用方可据此提示"题库不足"）。这样考试类入口可以先接"报缺口"，再按需打开 AI 补差。
    """
    want = max(1, int(count or 1))
    notes: list[str] = []

    bank_qs: list[dict[str, Any]] = []
    if fetch_bank is not None:
        got = fetch_bank(want)
        # 抽题库允许是同步或异步实现（各入口的取题函数历史上就有两种：学科题库走
        # question_select 是同步的，走 HTTP/DB 包装的可能是异步的），策略本身不关心。
        if inspect.isawaitable(got):
            got = await got
        bank_qs = list(got or [])[: want]
    if bank_qs:
        notes.append(NOTE_BANK_HIT % len(bank_qs))
    remaining = want - len(bank_qs)

    if remaining <= 0 or gen_ai is None:
        return FillResult(questions=bank_qs, bank_count=len(bank_qs), ai_count=0,
                          gap=max(remaining, 0), notes=notes)

    avoid = [text_of(q) for q in bank_qs if text_of(q)]
    try:
        raw_ai = list(await gen_ai(remaining, avoid) or [])
    except MissingApiKey as e:
        if bank_qs and allow_bank_only:
            notes.append(str(e) or NOTE_NO_KEY)
            return FillResult(questions=bank_qs, bank_count=len(bank_qs), ai_count=0,
                              gap=remaining, notes=notes, ai_failed=True)
        raise FillUnavailable(400, DETAIL_NO_KEY) from e
    except Exception as e:
        if bank_qs and allow_bank_only:
            notes.append(NOTE_AI_FAIL % str(e)[:120])
            return FillResult(questions=bank_qs, bank_count=len(bank_qs), ai_count=0,
                              gap=remaining, notes=notes, ai_failed=True)
        raise FillUnavailable(502, DETAIL_AI_FAIL % str(e)[:120]) from e

    # 与题库题防重（模型不一定遵守 prompt 里的"禁止重复"），再与同批自身防重
    seen = {_norm(t) for t in avoid if t}
    deduped: list[dict[str, Any]] = []
    for q in raw_ai:
        key = _norm(text_of(q))
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(q)
    deduped = deduped[: remaining]

    if persist is not None and deduped:
        # 只能用 persist 的返回值：被入库门槛拒收的条目不在其中（否则就是"幽灵题"）
        kept = persist(deduped)
        if inspect.isawaitable(kept):
            kept = await kept
        deduped = list(kept or [])

    if len(deduped) < remaining:
        notes.append(NOTE_AI_SHORT % (len(deduped), remaining))
    else:
        notes.append(NOTE_AI_OK % len(deduped))

    out = bank_qs + deduped
    if not out:
        # AI 出了题但全被门槛拒收，且题库也没有 → 与其发一张空卷，不如让老师重试
        raise FillUnavailable(502, detail_when_empty)
    # ai_failed：走过 AI 这条路但一道可用的都没拿到（供调用方决定要不要提示重试）
    return FillResult(questions=out, bank_count=len(bank_qs), ai_count=len(deduped),
                      gap=max(want - len(out), 0), notes=notes, ai_failed=not deduped)