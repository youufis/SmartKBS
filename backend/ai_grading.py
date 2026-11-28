# -*- coding: utf-8 -*-
"""主观题后台批量批改引擎（同步练习 / 学习考试 / 随堂测验 共用）

学生提交时只判客观题（毫秒级返回），主观题在每份答卷的 answers JSON 里打
`grading="pending"`、整行标记 `ai_pending=1`；本模块把「同一道题」的多份答案合并成
一次 AI 调用评分（40 人 × 5 题：200 次调用 → 25 次），写回后再补做积分与错题本结算。

接入方式：各业务模块 register_source(SourceAdapter(...)) 提供三个回调即可复用整套
调度/批量/去重/降级/并发保护逻辑（P1 先接同步练习，考试与随堂测验在 P2/P3 接入）。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
import time as _time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from backend.logger import logger
from backend.ai_budget import budget


# ── 可调参数（系统配置里同名键可覆盖）──
_CFG_DEFAULTS: dict[str, int] = {
    "AI_GRADING_INTERVAL_SEC": 25,           # 后台扫描节拍（秒）
    "AI_GRADING_BATCH_SIZE": 8,              # 一次 AI 调用合并评几份答案
    "AI_GRADING_CONCURRENCY": 2,             # 同时进行中的 AI 调用数（避免挤占出题/对话）
    "AI_GRADING_MAX_ITEMS_PER_ROUND": 60,    # 单轮最多处理多少题（防一次跑太久）
    "GRADING_SPOT_CHECK_PERCENT": 0,         # C3 抽检双评比例(0=关闭, 拍板默认关)
}


# ── B2: 送评预算 ── 长答案不截断会撑爆批量 prompt；调用不带 max_tokens 会吃服务商默认上限,
# 输出被腰斩 → 整批 JSON 解析失败 → 逐条重试又失败 → 全班转人工。截断统一走 clip_answer。
ANSWER_CLIP_SHORT = 1200       # 简答/填空答案送评前长度
ANSWER_CLIP_ESSAY = 4000       # 作文/长主观答案送评前长度
# 批改输出预算统一走 backend/ai_budget.py（grading_short / grading_essay / grading_batch，
# 配置键 AI_TOKENS_GRADING_*）：以前这里是四个硬编码常量，改一次要发一版，而「批改 JSON
# 被腰斩 → 整班转人工」恰恰是最需要现场调大的一档。
_DEFAULT_TOKENS_SHORT = 900
_DEFAULT_TOKENS_ESSAY = 1600
GRADING_TEMPERATURE = 0.0      # B3: 批改固定 temperature=0 —— 同一答案多次重批要稳定可复现
PROMPT_VERSION = "2026-11.3"   # C1: 批改 prompt 留痕版本号; 改任何评分 prompt 都要在这里 +1
SPOT_CHECK_DIFF_RATIO = 0.2    # C3: 抽检双评分差超过满分的这个比例 → 转教师确认
SPOT_RECHECK_NOTE = ("【独立复核】你是第二遍阅卷的教师。忽略任何已有评分结果，"
                     "只根据题目、参考答案与评分细则独立评分；宁可给保守分也不要凑分。")


def grading_model() -> str:
    """批改用哪个模型 —— 不再单独配置，固定跟随当前对话模型。

    调用侧一律不传 model：由 ai_service 按 AI 接入模式解析（云端档取 MODEL_NAME，
    本地档落到 Ollama 对话模型），与教师端那颗 AI 状态胶囊同源。这里只负责把
    "本次实际应答的模型名"写进判分留痕（grade_meta.model），供事后质询与回归对照。
    """
    try:
        from backend import llm_provider
        if llm_provider.ollama_active():
            return llm_provider.ollama_model_for("chat")
        from backend.api.config_router import get_config_value
        return str(get_config_value("MODEL_NAME", "") or "").strip()
    except Exception:
        return ""


def clip_answer(text, mode: str = "short") -> str:
    """把学生答案裁到送评预算：超长时留头 80% + 尾 20%（结尾也可能是得分点）并标注。"""
    limit = ANSWER_CLIP_ESSAY if mode == "essay" else ANSWER_CLIP_SHORT
    # C2: 剥控制字符(保留换行/制表) —— 零宽字符与转义戏法不该混进评分 prompt
    s = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff\x00-\x08\x0b\x0c\x0e-\x1f\x7f]",
               " ", str(text or "")).strip()
    if len(s) <= limit:
        return s
    keep = limit - 40
    head, tail = int(keep * 0.8), int(keep * 0.2)
    return s[:head] + f"…(原文 {len(s)} 字，中间已截断，只按可见内容评分)…" + s[-tail:]


def _cfg(key: str) -> int:
    try:
        from backend.api.config_router import get_config_value
        raw = get_config_value(key, _CFG_DEFAULTS[key])
        return int(raw) if raw not in (None, "") else _CFG_DEFAULTS[key]
    except Exception:
        return _CFG_DEFAULTS[key]


@dataclass
class GradingJob:
    """一道待批改的主观题（某个学生的某题）"""
    source: str
    attempt_id: int
    entry_key: str          # 写回 answers JSON 时用的 key
    student_username: str
    activity_id: str        # 积分/错题本结算用的活动 id
    question_text: str
    ref_answer: str
    max_score: float
    answer_text: str
    mode: str = "short"     # short=可合并批量; essay=多维评分(逐条调用)
    rubric: str = ""        # C4: 题目自带的"评分要点/给分分配"(可空), 拼进批改依据
    meta: dict[str, Any] = field(default_factory=dict)   # 源侧附加信息(学科/题型等)
    # 说明: 不做跨轮重试计数 —— 一轮里「批量→逐条→仍失败即转教师批改」，
    # 判不出的题当场就出队(grading=review)，不存在反复回炉的题目。


@dataclass
class SourceAdapter:
    """业务侧适配器：三个回调 + 一个"是否批完"的收尾钩子"""
    source: str
    label: str
    fetch_jobs: Callable[[int], list[GradingJob]]
    save_batch: Callable[[int, list[tuple[GradingJob, dict[str, Any]]]], None]
    finalize_if_done: Callable[[int], None]
    # 可选: 源侧自定义「单条批改」(返回结果结构需与本模块一致)。
    # 考试要沿用它自己的简答/作文多维评分 prompt, 故必须走这个口子; 不传则用内置默认。
    grade_single: Optional[Callable[[GradingJob, str], Any]] = None


_ADAPTERS: dict[str, SourceAdapter] = {}
_RUNNING = threading.Lock()          # 跨事件循环互斥：后台线程与"立即批改"请求共用
_STARTED = threading.Event()         # 防 reload/重复 import 起多个线程


def register_source(adapter: SourceAdapter) -> None:
    _ADAPTERS[adapter.source] = adapter
    logger.debug(f"[ai_grading] 已接入批改来源: {adapter.source}")


def registered_sources() -> list[str]:
    return sorted(_ADAPTERS)


def pending_keys(graded: dict[str, Any]) -> list[str]:
    """仍待后台批改的题号（各业务共用判据：题态 grading=='pending'）"""
    return [k for k, v in (graded or {}).items()
            if isinstance(v, dict) and v.get("grading") == "pending"]


def grading_reference(job: GradingJob) -> str:
    """C4: 批改依据 = 参考答案 (+ 评分细则)。有 rubric 时逐条给分依据更硬, 评分更稳。"""
    ref = str(job.ref_answer or "").strip()
    rb = str(job.rubric or "").strip()
    if rb:
        return f"{ref}\n\n【评分细则(逐条给分, 分值以它为准)】\n{rb}" if ref else rb
    return ref


def _group_key(job: GradingJob) -> tuple:
    """批量合并分组键：同来源 + 同活动 + 同题 + 同模式分值 + 同题面指纹，缺一不可。

    A1(2026-11 走查): 随堂测验的 entry_key 是题目序号而不是题目 id，旧键不含 activity_id
    时两场测验同序号同满值的题会被并成一批，_build_batch_prompt 拿第一份的题面评整批 →
    跨卷串分。题面指纹再挡一种事故：老师中途改题干/参考答案，两个版本不能同批。
    """
    fp = hashlib.md5(
        f"{job.question_text}\x1f{job.ref_answer}".encode("utf-8")).hexdigest()[:12]
    return (job.source, job.activity_id, job.entry_key, job.mode, job.max_score, fp)


def pending_summary() -> dict[str, int]:
    """各来源待批改题数（只数不写，供健康检查/教师端提示）"""
    out: dict[str, int] = {}
    for src, ad in _ADAPTERS.items():
        try:
            out[src] = len(ad.fetch_jobs(500))
        except Exception as e:
            logger.warning(f"[ai_grading] 统计 {src} 待批改失败: {e}")
            out[src] = -1
    return out


# ════════════════════════════════════════════════════════════
# AI 调用：批量评分 + 单条降级
# ════════════════════════════════════════════════════════════

def _clamp(score: Any, max_score: float) -> Optional[float]:
    try:
        v = float(score)
    except (TypeError, ValueError):
        return None
    if v != v:                      # NaN
        return None
    return round(max(0.0, min(v, max_score)), 1)


def review_result(reason: str) -> dict[str, Any]:
    """对外别名：业务侧自定义批改失败时复用的「转教师批改」结果"""
    return _review_result(reason)


def _spot_picked(job: GradingJob, pct: int) -> bool:
    """C3: 确定性抽样 —— 同一题每轮抽不抽中固定可复现(无随机数, 事后可审计)。"""
    if pct <= 0:
        return False
    h = int(hashlib.md5(
        f"spot:{job.source}:{job.attempt_id}:{job.entry_key}".encode("utf-8")).hexdigest()[:6], 16)
    return h % 100 < pct


def _review_result(reason: str) -> dict[str, Any]:
    """判不出来时的结果：不猜分，转教师批改"""
    return {"score": 0.0, "is_correct": False, "graded_by": "none",
            "needs_review": True, "comment": "", "feedback": reason}


def _build_batch_prompt(jobs: list[GradingJob]) -> str:
    from backend.prompts.teaching import BATCH_SUBJECTIVE_GRADING_PROMPT
    base = jobs[0]
    blocks = []
    for n, j in enumerate(jobs, 1):
        blocks.append(f"### 第 {n} 份\n{clip_answer(j.answer_text, j.mode) or '（空白）'}")
    return BATCH_SUBJECTIVE_GRADING_PROMPT.format(
        count=str(len(jobs)),
        question_text=str(base.question_text or "")[:1200].replace("{", "{{").replace("}", "}}"),
        ref_answer=grading_reference(base)[:2000].replace("{", "{{").replace("}", "}}"),
        max_score=str(base.max_score),
        items="\n\n".join(blocks),
    )


def _parse_batch_result(text: str, count: int) -> dict[int, dict[str, Any]]:
    """解析批量评分返回的 JSON 数组 → {序号(1 基): {score, comment}}"""
    from backend.utils import extract_json_from_text
    data = extract_json_from_text(text)
    if isinstance(data, dict):                     # 兼容 {"results": [...]} 与单对象
        inner = data.get("results") or data.get("items")
        data = inner if isinstance(inner, list) else [data]
    if not isinstance(data, list):
        return {}
    out: dict[int, dict[str, Any]] = {}
    for i, one in enumerate(data, 1):
        if not isinstance(one, dict):
            continue
        idx = one.get("index", one.get("id", i))
        try:
            idx = int(idx)
        except (TypeError, ValueError):
            idx = i
        if idx < 1 or idx > count or idx in out:
            continue
        out[idx] = {
            "score": one.get("score", one.get("得分")),
            "comment": str(one.get("comment") or one.get("评语") or "")[:600],
            "feedback": str(one.get("feedback") or one.get("建议") or "")[:600],
            # B6: 批量也回填命中要点(兼容 hit / key_points_hit 两种键名)，要点覆盖率统计不再只有单条路径有数
            "key_points_hit": [str(x)[:80] for x in
                               (one.get("key_points_hit") or one.get("hit") or [])
                               if str(x).strip()][:12],
        }
    return out


async def _grade_one(job: GradingJob, api_key: str, sem: asyncio.Semaphore,
                     single: Optional[Callable[[GradingJob, str], Any]] = None,
                     spot: bool = False) -> dict[str, Any]:
    """单条批改（B1: 与批量共用并发闸）。

    旧实现里 sem 只罩住了批量调用，essay/逐条完全裸并发 —— 全班交作文的一轮能并发
    几十个 AI 调用，触发限流后整批失败转人工。现在统一先占坑再评。
    """
    async with sem:
        return await _grade_one_inner(job, api_key, single, spot=spot)


async def _grade_one_inner(job: GradingJob, api_key: str,
                           single: Optional[Callable[[GradingJob, str], Any]],
                           spot: bool = False) -> dict[str, Any]:
    """单条批改：源侧自定义优先，否则用内置 prompt；异常一律转「待教师批改」，不猜分"""
    if single is None or spot:
        return await _grade_single_fallback(job, api_key, spot=spot)
    try:
        res = single(job, api_key)
        if asyncio.iscoroutine(res):
            res = await res
    except Exception as e:
        logger.warning(f"[ai_grading] 源侧单条批改失败(attempt={job.attempt_id} key={job.entry_key}): {e}")
        return _review_result("AI 批改未成功，已转教师批改。")
    if isinstance(res, dict) and isinstance(res.get("score"), (int, float)):
        return res
    return _review_result("AI 批改未成功，已转教师批改。")


async def _grade_single_fallback(job: GradingJob, api_key: str,
                                 spot: bool = False) -> dict[str, Any]:
    """逐条批改（批量解析失败时的降级），复用各自的单条评分 prompt。

    spot=True 时为 C3 抽检复核：不取源侧自定义评分(那是同一判分口径, 复读没意义)，
    改用"独立复核"前言 + 内置 prompt, 与首评形成对照。
    """
    from backend.api.ai_service import call_ai_async
    from backend.utils import extract_json_from_text
    try:
        if job.mode == "essay":
            prompt = _essay_prompt(job)
        else:
            from backend.prompts.teaching import SHORT_ANSWER_GRADING_PROMPT
            prompt = SHORT_ANSWER_GRADING_PROMPT.format(
                question_text=str(job.question_text or "").replace("{", "{{").replace("}", "}}"),
                correct_answer=grading_reference(job).replace("{", "{{").replace("}", "}}"),
                max_score=str(job.max_score),
                half_score=str(job.max_score * 0.5),
                near_full=str(job.max_score * 0.8),
                half_minus=str(job.max_score * 0.4),
                student_answer=clip_answer(job.answer_text, "short").replace("{", "{{").replace("}", "}}"),
            )
        max_tokens = budget("grading_essay" if job.mode == "essay" else "grading_short")
        if spot:
            prompt = SPOT_RECHECK_NOTE + "\n\n" + prompt
        result = extract_json_from_text(await call_ai_async(prompt, api_key, json_mode=True,
                                              use_kb=False, max_tokens=max_tokens,
                                              temperature=GRADING_TEMPERATURE))
        if isinstance(result, dict):
            score = _clamp(result.get("score"), job.max_score)
            if score is not None:
                cm = str(result.get("comment") or result.get("reason") or "").strip()
                fb = str(result.get("feedback") or "").strip()
                return {
                    "score": score,
                    "is_correct": score >= job.max_score * 0.6,
                    "graded_by": "ai",
                    "needs_review": False,
                    "comment": cm[:600],
                    "feedback": "\n".join(x for x in (cm, fb) if x)[:600],
                    "dimensions": result.get("dimensions") or {},
                    "overall_comment": str(result.get("overall_comment") or "")[:600],
                    "improvement_suggestions": result.get("improvement_suggestions") or [],
                    "key_points_hit": result.get("key_points_hit") or [],
                    "key_points_missed": result.get("key_points_missed") or [],
                }
    except Exception as e:
        logger.warning(f"[ai_grading] 单条批改失败(attempt={job.attempt_id} key={job.entry_key}): {e}")
    return _review_result("AI 批改未成功，已转教师批改。")


def _essay_prompt(job: GradingJob) -> str:
    """作文/主观题多维评分 prompt（与考试端同一份，逐条调用）"""
    from backend.prompts.exam import ESSAY_GRADING_PROMPT
    from backend.prompts import build_ai_role
    role = build_ai_role(subject="")
    return role + ESSAY_GRADING_PROMPT.format(
        subject="".replace("{", "{{"),
        question_text=str(job.question_text or "").replace("{", "{{").replace("}", "}}"),
        correct_answer=grading_reference(job).replace("{", "{{").replace("}", "}}"),
        max_score=str(job.max_score),
        student_answer=clip_answer(job.answer_text, "essay").replace("{", "{{").replace("}", "}}"),
    )


async def _grade_group(jobs: list[GradingJob], api_key: str, sem: asyncio.Semaphore,
                       single: Optional[Callable[[GradingJob, str], Any]] = None) -> dict[int, dict[str, Any]]:
    """一道题的一组作业（可能来自多个学生）→ {id(job): result}

    先在组内按答案文本去重（同答案只评一次），再按 batch 上限分批送 AI。
    """
    from backend.api.ai_service import call_ai_async

    uniq: dict[str, list[GradingJob]] = {}
    for j in jobs:
        uniq.setdefault(j.answer_text.strip(), []).append(j)

    results: dict[int, dict[str, Any]] = {}
    batch_size = max(1, _cfg("AI_GRADING_BATCH_SIZE"))
    reps = list(uniq.values())            # 每组取代表评分一次
    for start in range(0, len(reps), batch_size):
        chunk = [g[0] for g in reps[start:start + batch_size]]
        if not chunk:
            continue
        # mode=essay 必须逐条（多维评分输出结构不同），其余可批量
        singles = [c for c in chunk if c.mode == "essay"]
        batchable = [c for c in chunk if c.mode != "essay"]
        tasks: list[Any] = [_grade_one(c, api_key, sem, single) for c in singles]
        if batchable:
            tasks.append(_grade_batch_call(batchable, api_key, sem, single))
        got = await asyncio.gather(*tasks) if tasks else []
        gi = 0
        for c in singles:
            results[id(c)] = got[gi]; gi += 1
        if batchable:
            per_call = got[gi] if gi < len(got) else {}
            for pos, c in enumerate(batchable):
                one = per_call.get(id(c)) or _review_result("AI 未返回该题结果，已转教师批改。")
                results[id(c)] = one
    for reps_group in uniq.values():       # 去重的答案复制结果
        if len(reps_group) <= 1:
            continue
        src = results.get(id(reps_group[0]))
        if src is None:
            continue
        for dup in reps_group[1:]:
            results[id(dup)] = dict(src)
    return results


async def _grade_batch_call(jobs: list[GradingJob], api_key: str, sem: asyncio.Semaphore,
                            single: Optional[Callable[[GradingJob, str], Any]] = None) -> dict[int, dict[str, Any]]:
    """同题多份答案 → 1 次 AI 调用；解析不出的条目自动逐条重试"""
    from backend.api.ai_service import call_ai_async

    async with sem:
        try:
            text = await call_ai_async(
                _build_batch_prompt(jobs), api_key, json_mode=True, use_kb=False,
                max_tokens=budget("grading_batch", units=len(jobs)),
                temperature=GRADING_TEMPERATURE)
            parsed = _parse_batch_result(text, len(jobs))
        except Exception as e:
            logger.warning(f"[ai_grading] 批量批改调用失败(题面 {str(jobs[0].question_text)[:24]!r}, {len(jobs)} 份): {e}")
            parsed = {}

    out: dict[int, dict[str, Any]] = {}
    missing: list[GradingJob] = []
    for n, j in enumerate(jobs, 1):
        one = parsed.get(n)
        score = _clamp(one.get("score"), j.max_score) if one else None
        if one is None or score is None:
            missing.append(j)
            continue
        cm, fb = one.get("comment", ""), one.get("feedback", "")
        entry = {
            "score": score,
            "is_correct": score >= j.max_score * 0.6,
            "graded_by": "ai",
            "needs_review": False,
            "comment": cm[:600],
            "feedback": "\n".join(x for x in (cm, fb) if x and x != cm)[:600],
        }
        if one.get("key_points_hit"):
            entry["key_points_hit"] = one["key_points_hit"]   # B6
        out[id(j)] = entry
    if missing:
        logger.info(f"[ai_grading] 批量返回缺 {len(missing)} 份，逐条重试")
        retry = await asyncio.gather(*[_grade_one(j, api_key, sem, single) for j in missing])
        for j, r in zip(missing, retry):
            out[id(j)] = r
    return out


# ════════════════════════════════════════════════════════════
# 调度
# ════════════════════════════════════════════════════════════

async def drain_async(only_source: str = "", only_activity: str = "") -> dict[str, Any]:
    """跑一轮批改：取作业 → 分组并发评 → 交回各业务写回与结算

    幂等且可重入：拿不到互斥时（后台线程正在跑）改为等待队列清空，不会重复评分。
    """
    started = _time.time()
    if not _ADAPTERS:
        return {"graded": 0, "note": "未接入任何批改来源"}

    api_key = ""
    try:
        from backend.api.chat_router import get_api_keys
        api_key, _ = get_api_keys("system")
    except Exception as e:
        logger.warning(f"[ai_grading] 取 API Key 失败: {e}")
    if not (api_key or "").strip():
        # 没有 key 就别排队：由各业务在提交时自行兜底（关键词要点判分 + 待教师批改）
        return {"graded": 0, "note": "未配置 AI Key，跳过后台批改"}

    if not _RUNNING.acquire(blocking=False):
        # 另一轮在跑（后台线程或另一个"立即批改"请求）：等它把队列清掉
        for _ in range(120):
            await asyncio.sleep(1)
            if not _ADAPTERS:
                break
            if not _has_pending(only_source, only_activity):
                break
        return {"graded": 0, "note": "已有批改轮次在运行，已等待其完成", "cost_sec": round(_time.time() - started)}

    try:
        limit = _cfg("AI_GRADING_MAX_ITEMS_PER_ROUND")
        jobs: list[GradingJob] = []
        for src, ad in _ADAPTERS.items():
            if only_source and src != only_source:
                continue
            try:
                got = ad.fetch_jobs(limit)
            except Exception as e:
                logger.warning(f"[ai_grading] {src} 取作业失败: {e}")
                continue
            if only_activity:
                got = [j for j in got if j.activity_id == only_activity]
            jobs.extend(got)
            if len(jobs) >= limit:
                break
        jobs = jobs[:limit]
        if not jobs:
            return {"graded": 0, "note": "队列为空"}

        groups: dict[tuple, list[GradingJob]] = {}
        for j in jobs:
            groups.setdefault(_group_key(j), []).append(j)
        sem = asyncio.Semaphore(max(1, _cfg("AI_GRADING_CONCURRENCY")))
        def _single_of(g: list[GradingJob]):
            ad = _ADAPTERS.get(g[0].source)
            return getattr(ad, "grade_single", None) if ad else None

        outcomes = await asyncio.gather(
            *[_grade_group(g, api_key, sem, _single_of(g)) for g in groups.values()],
            return_exceptions=True
        )
        results: dict[int, dict[str, Any]] = {}
        for oc in outcomes:
            if isinstance(oc, Exception):
                logger.warning(f"[ai_grading] 分组批改异常: {oc!r}")
                continue
            results.update(oc or {})

        # C1: 批改留痕 —— 什么模型、哪版 prompt、何时判的, 事后质询/回归对照都有据可查
        meta = {"model": grading_model() or "default", "pver": PROMPT_VERSION,
                "at": _time.strftime("%Y-%m-%d %H:%M:%S")}
        by_attempt: dict[tuple[str, int], list[tuple[GradingJob, dict[str, Any]]]] = {}
        for j in jobs:
            r = results.get(id(j))
            if r is None:
                r = _review_result("AI 批改未完成，已转教师批改。")
            r.setdefault("grade_meta", {}).update(meta)
            by_attempt.setdefault((j.source, j.attempt_id), []).append((j, r))

        # C3(默认 0=关闭): 抽检双评 —— 复核 prompt 独立再判一次, 分差过大转教师
        pct = _cfg("GRADING_SPOT_CHECK_PERCENT")
        spot_n = 0
        if pct > 0:
            cands = [j for j in jobs
                     if results.get(id(j)) is not None
                     and not results[id(j)].get("needs_review") and _spot_picked(j, pct)]
            # S1: 与首评同一套答案去重 —— 相同答案只复评一次, 结果写回所有同答案卷
            reps: dict[tuple, list[GradingJob]] = {}
            for j in cands:
                reps.setdefault((j.question_text, j.ref_answer, j.answer_text), []).append(j)
            if reps:
                rep_jobs = [g[0] for g in reps.values()]
                souts = await asyncio.gather(
                    *[_grade_one(j, api_key, sem, None, spot=True) for j in rep_jobs],
                    return_exceptions=True)
                for j, r2 in zip(rep_jobs, souts):
                    if not isinstance(r2, dict) or r2.get("needs_review"):
                        continue
                    s2 = _clamp(r2.get("score"), j.max_score)
                    if s2 is None:
                        continue
                    for jj in reps[(j.question_text, j.ref_answer, j.answer_text)]:
                        r1 = results[id(jj)]
                        if r1.get("needs_review"):
                            continue
                        diff = abs(s2 - float(r1.get("score") or 0))
                        r1["grade_meta"]["spot"] = {"score": s2, "diff": round(diff, 1)}
                        if diff > max(1.0, j.max_score * SPOT_CHECK_DIFF_RATIO):
                            r1["needs_review"] = True
                            r1["is_correct"] = False
                            r1["feedback"] = (str(r1.get("feedback") or "") + f"（抽检复评 {s2:g} 分，"
                                              f"与原分差 {diff:g} 分，转教师确认）")[:600]
                            spot_n += 1
                logger.info(f"[ai_grading] 抽检双评 抽中{len(cands)}份/去重后复评{len(rep_jobs)}次, "
                            f"分差过大转人工 {spot_n}")

        done_attempts: list[tuple[str, int]] = []
        for (src, attempt_id), items in by_attempt.items():
            ad = _ADAPTERS.get(src)
            if not ad:
                continue
            try:
                applied = ad.save_batch(attempt_id, items)
                # 返回 None = 该来源还没约定返回值, 照旧收尾; 返回 0 = 本轮对它一次没写,
                # 不能再触发结算(否则重复收敛会重发一遍成绩通知)
                if applied is None or applied:
                    done_attempts.append((src, attempt_id))
            except Exception as e:
                logger.warning(f"[ai_grading] 写回失败 source={src} attempt={attempt_id}: {e}")
        for src, attempt_id in done_attempts:
            try:
                _ADAPTERS[src].finalize_if_done(attempt_id)
            except Exception as e:
                logger.warning(f"[ai_grading] 收尾结算失败 source={src} attempt={attempt_id}: {e}")

        graded = len(jobs)
        to_review = sum(1 for r in results.values() if r.get("needs_review"))  # 含 C3 抽检翻转
        logger.info(f"[ai_grading] 本轮批改 {graded} 题（转人工 {to_review}），"
                    f"合并为 {len(groups)} 组 / {len(by_attempt)} 份答卷，"
                    f"耗时 {round(_time.time() - started, 1)}s")
        return {"graded": graded, "to_review": to_review, "attempts": len(by_attempt),
                "cost_sec": round(_time.time() - started, 1)}
    finally:
        _RUNNING.release()


def _has_pending(only_source: str, only_activity: str) -> bool:
    for src, ad in _ADAPTERS.items():
        if only_source and src != only_source:
            continue
        try:
            jobs = ad.fetch_jobs(5)
        except Exception:
            continue
        if only_activity:
            jobs = [j for j in jobs if j.activity_id == only_activity]
        if jobs:
            return True
    return False


def _loop() -> None:
    _time.sleep(20)                      # 等服务自身启动完成
    while True:
        try:
            st = asyncio.run(drain_async())
            if st.get("note") not in (None, "队列为空") and st.get("graded", 0) == 0:
                logger.debug(f"[ai_grading] 空转: {st}")
        except Exception as e:
            logger.warning(f"[ai_grading] 后台批改轮次失败: {e}")
        _time.sleep(max(5, _cfg("AI_GRADING_INTERVAL_SEC")))


def start() -> None:
    """启动后台批改线程（main.py lifespan 调用，重复调用只起一个）"""
    if _STARTED.is_set():
        return
    _STARTED.set()
    threading.Thread(target=_loop, daemon=True, name="ai-grading").start()
    logger.info(f"[ai_grading] 后台批改线程已启动，间隔 {_cfg('AI_GRADING_INTERVAL_SEC')}s，"
                f"批量 {_cfg('AI_GRADING_BATCH_SIZE')} 份/次，并发 {_cfg('AI_GRADING_CONCURRENCY')}")
    try:
        from backend.api.chat_router import get_api_keys
        key, _ = get_api_keys("system")
        if not (key or "").strip():
            logger.warning("[ai_grading] 未配置 AI Key，后台批改不会执行（主观题提交时走要点兜底并转教师批改）")
    except Exception:
        pass
