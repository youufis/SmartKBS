# -*- coding: utf-8 -*-
"""智能组卷选题引擎（题型配额 + 难度配比 + 分层召回 + AI 择优与回退）。

从 backend/api/paper_router.py 抽出，成为考试中心三个组卷入口共用的唯一实现：
  POST /api/exams/{id}/compose            智能组卷页（显式配置题型/分值/难度配比）
  POST /api/exams/{id}/auto-select-questions  「管理题目」弹窗的自动选题
  POST /api/exams/{id}/ai-compose            「管理题目」弹窗的 AI 生成

抽出来之前，只有第一个入口用得上这套逻辑；后两个各自写着更弱的版本（题量靠运气、
候选池用 subject 精确等值 + ORDER BY difficulty LIMIT 50，知识点重点输入对候选池
零影响）。行为语义一条都没改，先由 tests/test_paper_compose.py 钉住再搬。

选题分两层：
  get_question_pool()        候选池 —— 走 backend/question_select 的 T0>T1>…>T5 分层召回，
                             学科严格隔离，近重复题折叠，层内按相关度+随机种子排序；
  select_questions_by_rules  按题型配额 + 难度配比（最大余数法）从池子里拼卷；
  select_questions_by_ai     让模型在池子里挑，但**结果不原样入库**：去重、丢配置外题型、
                             超配额截断，缺额按池子顺序（相关度优先）补齐；任何异常回退规则选题。
"""
from __future__ import annotations

import json
import random
from typing import Any, Sequence

from pydantic import BaseModel

from backend.logger import logger
from backend.prompts import build_ai_role

# 候选池召回（question_select）与 AI 调用（ai_service/chat_router）都在函数内延迟导入：
# 保持与被抽出前逐字一致，也避免 router 之间的导入环。


# ── 题型中文名（组卷说明与 AI prompt 共用）──
TYPE_LABELS = {
    "single": "单选题",
    "multiple": "多选题",
    "true_false": "判断题",
    "short": "简答题",
    "fill": "填空题",
    "essay": "作文",
    "subjective": "主观题",
}


class TypeConfigItem(BaseModel):
    """题型配置项"""
    type: str                          # single | multiple | true_false | short
    count: int = 0                     # 题数
    score_per_question: float = 5.0    # 每题分值


class ComposeRequest(BaseModel):
    """智能组卷请求"""
    school_name: str = ""              # 学校名称
    semester: str = ""                 # 学年学期
    target_grade: str = ""             # 考试年级
    type_configs: list[TypeConfigItem] = []  # 题型配置列表
    difficulty_easy_ratio: int = 20    # 简单题占比 %
    difficulty_medium_ratio: int = 50  # 中等题占比 %
    difficulty_hard_ratio: int = 30    # 困难题占比 %
    knowledge_points: list[str] = []   # 知识点范围（留空=全部）
    total_score: float | None = None   # 目标总分（留空则沿用考试已设定的总分）
    # 默认追加而不是替换：旧默认 True 让「开始智能组卷」一键删空老师已有的卷子
    replace_existing: bool = False     # 是否替换考试中已有题目
    use_ai: bool = True                # 是否使用 AI 智能选择
    # 题库凑不够配额时是否让 AI 补差（默认关：组卷的老行为是"只报缺口"，
    # 判分链路只碰可复核的存量题更安全；勾选后补的题照样过题目入库唯一出口）
    fill_by_ai: bool = False


class ComposeResponse(BaseModel):
    """组卷响应"""
    message: str
    added: int
    total_questions: int
    type_stats: dict[str, int]
    difficulty_stats: dict[str, int]
    total_score: float                 # 库里实算的总分（= Σ每题分值），不再是老师填的那个数
    reason: str = ""
    # 已有提交份数：组卷不会重算历史成绩，界面据此提示"要不要先去成绩页复核"
    submitted_attempts: int = 0
    # 组卷后卷面与目标总分的差额（配平成功时恒为 0）
    score_gap: float = 0.0
    config_total: float = 0.0          # 老师按"每题分值"配出来的合计
    target_total: float = 0.0          # 本次实际配平到的目标总分
    type_scores: dict[str, float] = {}  # 配平后各题型每题真实分值
    warnings: list[str] = []
    # 只有勾选"题库不足时用 AI 补差"时非零：补了几道、以及补题过程的说明
    ai_filled: int = 0
    ai_fill_notes: list[str] = []


DEFAULT_POOL_TYPES = ("single", "multiple", "true_false", "short", "fill")

# 难度配比默认值：与组卷页 / PaperConfigForm 的建议比例一致（简单:中等:困难 = 20:50:30）
DEFAULT_DIFFICULTY = (20, 50, 30)


def get_question_pool(
    subject: str,
    exclude_ids: set[int],
    knowledge_points: list[str] | None = None,
    types: Sequence[str] | None = None,
    seed: str = "paper",
    with_audit: bool = False,
):
    """获取候选题目池（走统一分层召回：T0 关联 > T1 标签相等 > … > T5 同学科兜底）。

    Args:
        subject: 科目（严格限族，绝不跨学科给题）
        exclude_ids: 需要排除的题目 ID 集合
        knowledge_points: 知识点列表（为空则全部）
        types: 允许入池的题型，默认不含作文/主观（组卷页沿用旧默认）
        seed: 选题种子，同种子同池子可复现
        with_audit: 是否连带返回审计信息（考试弹窗要把"兜底了几题"显示给老师）

    Returns:
        候选题目列表；with_audit=True 时返回 (题目列表, 审计 dict)
    """
    from backend.question_select import log_audit, select_questions
    # 组卷是"先出池、后按配额拼卷"，因此取满池并允许同学科族兜底（兜底题在池子末尾，
    # 命中知识点的题排在前面），但仍严格限制在指定学科族内，绝不跨学科。
    rows, _audit = select_questions(
        kp_name="、".join(knowledge_points or []), subject=subject,
        types=tuple(types) if types else DEFAULT_POOL_TYPES,
        count=1000, exclude_ids=list(exclude_ids or []),
        allow_family_fallback=True, seed=seed,
    )
    log_audit("paper_pool", _audit)
    # 解析 options JSON
    for row in rows:
        if row.get("options") and isinstance(row["options"], str):
            try:
                row["options"] = json.loads(row["options"])
            except (json.JSONDecodeError, TypeError):
                row["options"] = None

    return (rows, _audit) if with_audit else rows


def split_count_by_types(total: int, types: Sequence[str],
                         score_per_question: float = 5.0,
                         pool: Sequence[dict[str, Any]] | None = None) -> list[TypeConfigItem]:
    """把"我要 N 道题"摊成题型配额（最大余数法）。

    考试弹窗的「自动选题 / AI 生成」原本只有一个总数，题型分布全靠池子里的运气 ——
    实测 10 道题能清一色是单选。至少让每个被选中的题型都轮得到题，才是可用的组卷。

    给了 pool（候选池）就在"池子里真有题的题型"之间**均匀分配**，单题型不超过其可用量，
    拿不到的额度自动转给别的题型 —— 于是 sum(count) == min(total, 池子可用题数)，
    既不会因为"系统默认允许但题库里没有"的题型（作文/主观）白白缺题，也不会因为
    题库里单选题占九成而把整份卷子都出成单选题。
    """
    ts = [x for x in dict.fromkeys(types or ()) if x]
    if not ts or total <= 0:
        return []
    if pool is not None:
        avail: dict[str, int] = {}
        for q in pool:
            ty = str(q.get("type") or "")
            if ty in ts:
                avail[ty] = avail.get(ty, 0) + 1
        present = [t for t in ts if avail.get(t)]
        if not present:
            return []
        cap = min(int(total), sum(avail[t] for t in present))
        quota = {t: 0 for t in present}
        left = cap
        # 轮转式均匀分配：每轮给"还拿得到题"的题型各 +1，优先补当前拿到最少的。
        # 为什么不是按可用量比例 —— 真实题库 90% 是单选题，按比例分出来的卷子仍然
        # 接近"10 道全是单选"；均匀为主 + 可用量封顶 + 溢出转配，才既摊得开又凑得满。
        while left > 0:
            room = [t for t in present if quota[t] < avail[t]]
            if not room:
                break
            room.sort(key=lambda k: (quota[k], -avail[k], present.index(k)))
            for t in room:
                if left <= 0:
                    break
                quota[t] += 1
                left -= 1
        return [TypeConfigItem(type=t, count=c, score_per_question=score_per_question)
                for t, c in quota.items() if c > 0]

    base_even = [(total / len(ts)) for _ in ts]
    quota_i = [int(x) for x in base_even]
    rem = total - sum(quota_i)
    for i in sorted(range(len(ts)), key=lambda k: (base_even[k] - quota_i[k], -k),
                    reverse=True)[:max(rem, 0)]:
        quota_i[i] += 1
    return [TypeConfigItem(type=ty, count=c, score_per_question=score_per_question)
            for ty, c in zip(ts, quota_i) if c > 0]


def difficulty_split(difficulty: str = "") -> tuple[int, int, int]:
    """弹窗的单个"难度"下拉 → 组卷引擎要的三档配比。

    选了某一档就按 100% 偏好该档（池子里该档不够时引擎会自动放宽并写进 reason，
    绝不会因为难度不够而选空）；没选就用系统默认 20:50:30，比"靠运气"稳定。
    """
    key = (difficulty or "").strip()
    if key in ("easy", "medium", "hard"):
        return {"easy": (100, 0, 0), "medium": (0, 100, 0), "hard": (0, 0, 100)}[key]
    return DEFAULT_DIFFICULTY


def stats_of(selected: Sequence[dict[str, Any]]) -> tuple[dict[str, int], dict[str, int]]:
    """(题型统计, 难度统计) —— 让老师在界面上看见这套卷到底长什么样。"""
    type_stats: dict[str, int] = {}
    diff_stats = {"easy": 0, "medium": 0, "hard": 0}
    for q in selected:
        ty = str(q.get("type") or "")
        type_stats[ty] = type_stats.get(ty, 0) + 1
        d = str(q.get("difficulty") or "")
        if d in diff_stats:
            diff_stats[d] += 1
    return type_stats, diff_stats


def gap_by_type(type_configs: Sequence[Any], picked: Sequence[dict[str, Any]]) -> dict[str, int]:
    """按题型算"还缺几道"（配置数 − 实选数），供 AI 补差用。"""
    want: dict[str, int] = {}
    for tc in type_configs or []:
        t = getattr(tc, "type", None) or (tc.get("type") if isinstance(tc, dict) else "")
        n = getattr(tc, "count", None)
        if n is None and isinstance(tc, dict):
            n = tc.get("count")
        if t:
            want[str(t)] = want.get(str(t), 0) + int(n or 0)
    got: dict[str, int] = {}
    for q in picked or []:
        t = str(q.get("type") or "")
        got[t] = got.get(t, 0) + 1
    return {t: c - got.get(t, 0) for t, c in want.items() if c - got.get(t, 0) > 0}


def validate_compose_config(req: ComposeRequest) -> tuple[float, str]:
    """验证组卷配置，返回 (计算总分, 错误信息)"""
    if not req.type_configs:
        return 0, "请配置至少一种题型"

    total = 0.0
    for tc in req.type_configs:
        if tc.count < 0:
            return 0, f"题型 {TYPE_LABELS.get(tc.type, tc.type)} 的题数不能为负"
        if tc.score_per_question <= 0:
            return 0, f"题型 {TYPE_LABELS.get(tc.type, tc.type)} 的分值必须大于 0"
        total += tc.count * tc.score_per_question

    if total <= 0:
        return 0, "试卷总分必须大于 0"

    total_ratio = req.difficulty_easy_ratio + req.difficulty_medium_ratio + req.difficulty_hard_ratio
    if total_ratio != 100:
        return 0, "难度分布比例之和必须为 100"

    return total, ""


def select_questions_by_rules(
    pool: list[dict[str, Any]],
    type_configs: list[TypeConfigItem],
    easy_ratio: int,
    medium_ratio: int,
    hard_ratio: int,
) -> tuple[list[dict[str, Any]], str]:
    """基于规则从候选池中选题（非 AI 模式）

    Returns:
        (选中的题目列表, 说明文字)
    """
    selected: list[dict[str, Any]] = []
    reason_parts = []

    # 按题型分组
    type_pool: dict[str, list[dict[str, Any]]] = {}
    for q in pool:
        q_type = q["type"]
        if q_type not in type_pool:
            type_pool[q_type] = []
        type_pool[q_type].append(q)

    # 按题型配置选题
    for tc in type_configs:
        q_type = tc.type
        target_count = tc.count
        if target_count == 0:
            continue

        candidates = type_pool.get(q_type, [])
        if not candidates:
            reason_parts.append(f"{TYPE_LABELS.get(q_type, q_type)}：题库中无候选题目")
            continue

        if len(candidates) < target_count:
            reason_parts.append(
                f"{TYPE_LABELS.get(q_type, q_type)}：需要{target_count}题，候选仅{len(candidates)}题，已全部选取"
            )
            selected.extend(candidates)
            continue

        # 按难度比例从候选池中分层抽样
        easy_pool = [q for q in candidates if q["difficulty"] == "easy"]
        medium_pool = [q for q in candidates if q["difficulty"] == "medium"]
        hard_pool = [q for q in candidates if q["difficulty"] == "hard"]

        # 计算每种难度应选题数 —— 最大余数法，三档之和恒等于 target_count。
        # （旧写法 max(1, round(...)) 在比例含 0 时会让计划总数超过题数：
        #   实测 target=3、难度比 0/90/10 会抽出 4 题，卷面题量与总分双双错位）
        _raw = {"easy": target_count * easy_ratio / 100,
                "medium": target_count * medium_ratio / 100,
                "hard": target_count * hard_ratio / 100}
        _quota = {d: int(v) for d, v in _raw.items()}
        _rem = target_count - sum(_quota.values())
        for d in sorted(_raw, key=lambda x: (_raw[x] - _quota[x], _raw[x]), reverse=True):
            if _rem <= 0:
                break
            if _raw[d] > 0:
                _quota[d] += 1
                _rem -= 1
        target_easy, target_medium, target_hard = _quota["easy"], _quota["medium"], _quota["hard"]

        # 调整：如果某种难度的题不够，均分给其他难度
        chosen: list[dict[str, Any]] = []

        def _pick_from(pool_list: list[dict[str, Any]], n: int) -> list[dict[str, Any]]:
            # 按候选池顺序取前 n：池子由 select_questions 生成——层级按相关度排序(T0 最前)、
            # 层内已按每次调用的随机种子打乱。旧写法 random.sample 等概率抽样，
            # 会让 T5 同学科兜底题和 T1 命中题同率入卷；切片既保相关度优先又每次换一批。
            if not pool_list or n <= 0:
                return []
            return pool_list[:n]

        chosen.extend(_pick_from(easy_pool, target_easy))
        chosen.extend(_pick_from(medium_pool, target_medium))
        chosen.extend(_pick_from(hard_pool, target_hard))

        # 如果还不够，从剩余中随机补足
        if len(chosen) < target_count:
            _chosen_ids = {q["id"] for q in chosen}
            remaining = [q for q in candidates if q["id"] not in _chosen_ids]
            additional = _pick_from(remaining, target_count - len(chosen))
            chosen.extend(additional)

        # 打乱顺序
        random.shuffle(chosen)
        selected.extend(chosen)

    if not selected:
        return [], "未能从题库中选出任何题目，请检查题库是否为空或筛选条件是否过于严格"

    # 统计
    type_stats_str = ", ".join(
        f"{TYPE_LABELS.get(tc.type, tc.type)}{tc.count}题"
        for tc in type_configs if tc.count > 0
    )
    reason_parts.insert(0, f"共选题 {len(selected)} 道（{type_stats_str}）")
    reason = "；".join(reason_parts)

    return selected, reason


async def ai_fill_gap(need_by_type: dict[str, int], *, subject: str, difficulty: str = "medium",
                      knowledge_points: list[str] | None = None, username: str = "",
                      scene: str = "exam_ai_fill") -> tuple[list[dict[str, Any]], list[str]]:
    """按题型缺口让 AI 出新题，经题目入库唯一出口校验后返回可入卷的题目行。

    给考试的两条选题链路（自动选题 / 智能组卷）共用。两条链路历史上"题库凑不够就只报缺口"：
    报告本身没错（判分链路必须只用可复核的存量题），但老师没有别的选择 —— 于是加一个
    **默认关闭**的开关，勾选后按缺额补题，补出来的题照样走 question_factory
    （字段体检 → 查重 → 单事务 → 连知识点边），因此不会出现"进了卷却判不了分"的题。

    返回 (rows, notes)；rows 只含真入库/命中已有题的条目，形状与 get_question_pool 一致
    （id / type / question_text / difficulty / knowledge_points / options ...）。
    """
    from backend import question_fill

    want = {t: int(n) for t, n in (need_by_type or {}).items() if int(n) > 0}
    if not want:
        return [], []

    kp_text = "、".join([k for k in (knowledge_points or []) if k]) or "不限"
    rows: list[dict[str, Any]] = []
    notes: list[str] = []
    for qtype, gap in want.items():
        async def _gen(need: int, avoid: list[str], _t: str = qtype, _g: int = gap) -> list[dict]:
            from backend.api.chat_router import get_api_keys
            from backend.api.ai_service import call_ai_async
            from backend.prompts.chat import QUESTION_GENERATE_PROMPT
            from backend.prompts.question_schema import render_question_prompt
            api_key, _ = get_api_keys(username)
            if not api_key:
                raise question_fill.MissingApiKey("未配置 API Key，无法按缺口补题")
            prompt = render_question_prompt(
                QUESTION_GENERATE_PROMPT,
                subject=subject or "不限学科",
                knowledge_points=kp_text,
                type_desc=TYPE_LABELS.get(_t, _t) + ("（4个选项）" if _t in ("single", "multiple") else ""),
                count=_g,
                difficulty_desc={"easy": "简单", "medium": "中等", "hard": "困难"}.get(difficulty, "中等"),
            )
            # 判分链路宁可失败也不吞下半截题：只接受完整 JSON（salvage=False）
            text = await call_ai_async(prompt, api_key, json_mode=True,
                                       kb_query=f"{subject} {kp_text}")
            from backend import ai_json
            got, meta = ai_json.extract_json_array2(text, salvage=False)
            if not got:
                ai_json.dump_failed_raw(scene, text or "")
                raise RuntimeError(f"AI 未返回可用题目（{meta.get('reason') or '解析失败'}）")
            for it in got:
                if isinstance(it, dict):
                    it["type"] = _t          # 题型由缺口决定，不让模型自由发挥
            return [it for it in got if isinstance(it, dict)]

        async def _persist(items: list[dict], _t: str = qtype) -> list[dict]:
            from backend import question_factory
            outcome = question_factory.persist_questions(
                items,
                subject=subject or "",
                source="ai",
                username=username or "",
                question_type=_t,
                difficulty=difficulty or "medium",
                knowledge_points=kp_text if kp_text != "不限" else "",
                link_duplicates=True,
                write_creator_name=False,
            )
            st = outcome["stats"]
            logger.info(f"[组卷补题] 题型={_t} 新入库={st['saved']} 重复回填={st['duplicated']} "
                        f"不合格={st['rejected']}")
            out = []
            for e in list(outcome["saved"]) + list(outcome["duplicated"]):
                out.append({
                    "id": e["id"], "type": e.get("type") or _t,
                    "question_text": e.get("question_text", ""),
                    "options": e.get("options") or {},
                    "difficulty": e.get("difficulty") or difficulty or "medium",
                    "knowledge_points": e.get("knowledge_points") or kp_text,
                    "correct_answer": e.get("correct_answer", ""),
                    "svg_content": e.get("svg_content") or "",
                    "has_svg": e.get("has_svg") or 0,
                })
            return out

        try:
            filled = await question_fill.fill_questions(
                count=gap,
                fetch_bank=None,               # 题库已在这条链路上走过，这里只补差
                gen_ai=_gen,
                persist=_persist,
            )
            rows.extend(filled.questions)
            tag = TYPE_LABELS.get(qtype, qtype)
            if filled.gap > 0:
                notes.append(f"{tag}仍缺 {filled.gap} 道（{'；'.join(filled.notes)}）")
            elif filled.notes:
                notes.append(f"{tag}已用 AI 补 {filled.ai_count} 道")
        except question_fill.FillUnavailable as e:
            notes.append(f"{TYPE_LABELS.get(qtype, qtype)}补题失败：{e.detail}")
        except Exception as e:                    # 补题失败不毁掉整次组卷
            logger.warning(f"[组卷补题] 题型={qtype} 失败: {e}")
            notes.append(f"{TYPE_LABELS.get(qtype, qtype)}补题失败：{str(e)[:80]}")

    return rows, notes


async def select_questions_by_ai(
    pool: list[dict[str, Any]],
    type_configs: list[TypeConfigItem],
    easy_ratio: int,
    medium_ratio: int,
    hard_ratio: int,
    knowledge_points: list[str],
    exam_info: dict[str, Any],
    username: str,
) -> tuple[list[dict[str, Any]], str]:
    """使用 AI 从候选池中智能选题"""
    from backend.api.chat_router import get_api_keys
    from backend.api.ai_service import call_ai_async
    from backend.prompts.paper import AI_PAPER_COMPOSE_PROMPT

    keys = get_api_keys(username)
    api_key = keys[0] if keys and keys[0] else ""
    if not api_key:
        logger.warning("AI 组卷：未配置 API Key，回退到规则选题")
        return select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio, hard_ratio)

    # 构建题型配置文本
    type_config_lines = []
    for tc in type_configs:
        if tc.count > 0:
            label = TYPE_LABELS.get(tc.type, tc.type)
            type_config_lines.append(f"- {label}：{tc.count} 题，每题 {tc.score_per_question:.0f} 分")
    type_config_text = "\n".join(type_config_lines)

    # 构建候选题目文本
    type_map = {"single": "单选题", "multiple": "多选题", "true_false": "判断题", "short": "简答题",
                 "fill": "填空题", "essay": "作文", "subjective": "主观题"}
    diff_map = {"easy": "简单", "medium": "中等", "hard": "困难"}

    # 候选池按题型截断后再进 prompt（池子本身已按相关度分层排序，取每型前若干题）：
    # 整池上千题全量塞给模型会推高成本/超时并拉低选题质量。
    _quota_types = [tc.type for tc in type_configs if tc.count > 0]
    _per_type_cap = max(20, 120 // max(1, len(_quota_types)))
    _ai_cnt: dict[str, int] = {}
    ai_pool = []
    for q in pool:
        if _ai_cnt.get(q["type"], 0) < _per_type_cap:
            ai_pool.append(q)
            _ai_cnt[q["type"]] = _ai_cnt.get(q["type"], 0) + 1

    candidate_lines = []
    for i, q in enumerate(ai_pool, 1):
        q_type = type_map.get(q["type"], q["type"])
        q_diff = diff_map.get(q["difficulty"], q["difficulty"])
        q_text = q["question_text"][:100]
        q_kp = q.get("knowledge_points", "") or "无"
        # 为每道题加一个预设分值
        matching_config = next((tc for tc in type_configs if tc.type == q["type"]), None)
        q_score = matching_config.score_per_question if matching_config else 5
        candidate_lines.append(
            f"{i}. [ID:{q['id']}] [{q_type}][{q_diff}] {q_text} (知识点: {q_kp}, 预设分值: {q_score:.0f}分)"
        )
    candidate_text = "\n".join(candidate_lines)

    knowledge_focus = "、".join(knowledge_points) if knowledge_points else "无特定要求，覆盖广泛"

    def _safe(s):
        return str(s).replace('{', '{{').replace('}', '}}')

    ai_role = build_ai_role(subject=exam_info.get("subject", ""), grade=exam_info.get("target_grade", ""))
    prompt = f"{ai_role}" + AI_PAPER_COMPOSE_PROMPT.format(
        subject=_safe(exam_info.get("subject", "")),
        exam_title=_safe(exam_info.get("title", "")),
        total_score=_safe(exam_info.get("total_score", 100)),
        grade=_safe(exam_info.get("target_grade", "")),
        type_config=_safe(type_config_text),
        easy_ratio=easy_ratio,
        medium_ratio=medium_ratio,
        hard_ratio=hard_ratio,
        knowledge_focus=_safe(knowledge_focus),
        candidate_questions=_safe(candidate_text),
    )
    # 注意：不注入技能 — 技能的结构化输出指令与 JSON 格式要求冲突

    try:
        ai_response = await call_ai_async(prompt, api_key, json_mode=True, kb_query=knowledge_focus)
        logger.info(f"AI 组卷返回: {str(ai_response)[:300]}")
    except Exception as e:
        logger.error(f"AI 组卷调用失败: {e}")
        logger.warning("AI 组卷失败，回退到规则选题")
        return select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio, hard_ratio)

    # 解析 AI 返回的 JSON（支持嵌套对象）
    import re
    text = str(ai_response).strip()

    # 1) 先尝试提取 ```json ... ``` 中的内容
    json_str = None
    code_match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if code_match:
        json_str = code_match.group(1).strip()
    else:
        # 2) 从第一个 { 到最后一个 } 截取
        start = text.find('{')
        end = text.rfind('}')
        if start >= 0 and end > start:
            json_str = text[start:end + 1]

    if not json_str:
        logger.warning("AI 组卷返回中未找到 JSON，回退到规则选题")
        return select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio, hard_ratio)

    try:
        result = json.loads(json_str)
        selected_ids = result.get("selected_ids", [])
        reason = result.get("reason", "AI 智能组卷")
    except (json.JSONDecodeError, TypeError) as e:
        logger.warning(f"AI 组卷 JSON 解析失败: {e}，回退到规则选题")
        return select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio, hard_ratio)

    if not selected_ids:
        logger.warning("AI 未选择任何题目，回退到规则选题")
        return select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio, hard_ratio)

    # 匹配选中的题目：按配置配额校验（去重、丢配置外题型、超配额截断），
    # 缺额按候选池顺序（相关度优先）补同题型题 —— AI 结果不再原样入库。
    pool_map = {q["id"]: q for q in pool}
    quota_by_type = {tc.type: tc.count for tc in type_configs if tc.count > 0}
    seen: set[int] = set()
    selected: list[dict[str, Any]] = []
    dropped_dup = dropped_offquota = 0
    for sid in selected_ids:
        q = pool_map.get(sid)
        if not q:
            continue
        if q["id"] in seen:
            dropped_dup += 1
            continue
        t_type = q["type"]
        if t_type not in quota_by_type or sum(1 for x in selected if x["type"] == t_type) >= quota_by_type[t_type]:
            dropped_offquota += 1
            continue
        seen.add(q["id"])
        selected.append(q)

    if not selected:
        logger.warning("AI 组卷结果经配额校验后为空，回退到规则选题")
        return select_questions_by_rules(pool, type_configs, easy_ratio, medium_ratio, hard_ratio)

    filled = 0
    for t_type, want in quota_by_type.items():
        for q in pool:
            if sum(1 for x in selected if x["type"] == t_type) >= want:
                break
            if q["type"] == t_type and q["id"] not in seen:
                seen.add(q["id"])
                selected.append(q)
                filled += 1
    notes = []
    if filled:
        notes.append(f"AI 选题不足，已按题库相关度补齐 {filled} 题")
    if dropped_dup or dropped_offquota:
        notes.append(f"AI 结果中 {dropped_dup} 题重复、{dropped_offquota} 题超出题型配额，已剔除")
    if notes:
        reason = reason + "（" + "；".join(notes) + "）"

    return selected, reason
