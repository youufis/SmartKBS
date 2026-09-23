# -*- coding: utf-8 -*-
"""统一选题模块：分层召回 + 受控降级 + 可解释审计。

取代此前散落在 7 个入口的 6 套 LIKE 策略（考试自动选题 / AI 练习策略ABC /
智能练习 / 随堂测验 / 同步练习 / 快速测验 / 组卷）。那些写法各有两类毛病：
  漏选 —— 90% 的知识点用"全名 LIKE"一道题都捞不到（题库标签 40% 为空 + 学科名
          写法差异下 subject 精确等值），于是每次都退化成烧 AI；
  乱选/错选 —— 剥词会造出「的描述」「流程的」这类虚词再拿去 LIKE，实测把通用技术、
          人工智能甚至生物的题混进信息科技的知识点，且策略 A/B/C 完全没有学科过滤。

规则（与产品约定一致）：
  1) 学科族：信息技术 ≡ 信息科技（同一族，写法不同而已）；通用技术、人工智能等各自
     独立。**调用方指定了学科，就绝不跨族给题**（宁可少给并说明，也不错选）。
  2) 召回分层，够数即停：T1 标签相等 > T2 标签互为子串 > T3 题干实词命中 >
     T4 同章节兄弟知识点 > T5 同学族兜底。层级越低越"宽"，放宽一律写进审计。
  3) 虚词与泛词防护：纯助词直接丢弃；某候选词在同学科里命中占比过高（默认 40%）
     视为过于宽泛，不作为判据 —— 这就是「技术」「信息」「的描述」不再串题的原因。
  4) 题库大时**必须轮换**：默认每次调用都换一批题（rotate="call"）；需要"今天全班
     同一套"用 rotate="day"（同一天内稳定、隔天自动换）；需要完全复现（回归测试、
     老师就要上次那套）用 rotate="none" + 固定 seed。另外可传 avoid_ids 软避开
     上一批用过的题 —— 池子不够时仍会补齐，绝不因为避让而选空。
"""
from __future__ import annotations

import json
import random
import re
from datetime import datetime as _dt
from uuid import uuid4 as _uuid4
from typing import Any, Iterable, Sequence

from backend.logger import logger
from backend.question_db import execute_query

# ── 学科族：只有"同一门课的不同叫法"才归一，其余一律严格隔离 ──────────────
_SUBJECT_FAMILY = {
    "信息技术": "信息",
    "信息科技": "信息",
    "通用技术": "通用技术",
    "人工智能": "人工智能",
    "ai": "人工智能",
}


def subject_family(subject: str) -> str:
    s = (subject or "").strip()
    return _SUBJECT_FAMILY.get(s, s)


def family_members(subject: str) -> list[str]:
    """给定学科名，返回同族的全部写法（用于 SQL 侧 IN 过滤，兼容历史数据）。"""
    fam = subject_family(subject)
    if not fam:
        return []
    return [k for k, v in _SUBJECT_FAMILY.items() if v == fam]


# ── 文本规范化与词项处理 ────────────────────────────────────────────────
_PUNCT = " \t\r\n　·、,，.;：:!?？“”\"'（）()【】\\[\\]{}|/_—\\-+"
# 纯助词/连接词：作为检索词毫无意义（历史上「算法的描述方法」被剥成「的描述」去搜题）
_STOP_WORDS = {"的", "地", "得", "与", "和", "及", "以及", "及其", "或", "等", "之", "所",
               "对", "于", "以", "其", "这", "那", "在", "是", "有", "个", "类", "种",
               "方法", "方式", "内容", "部分", "相关", "问题", "含义", "概念", "特点",
               "概述", "介绍", "基础", "入门", "应用", "技术", "描述", "过程", "原则",
               "途径", "目标", "类型", "作用", "意义", "关系"}
# 剥离后缀得到"核心词"，但结果必须仍然够长够实（长度不足即放弃该层，而不是拿虚词去搜）
_SUFFIX_STRIP = re.compile(r"(原理|方法|技术|概述|应用|优化|算法|设计|实现|介绍|基础|入门|进阶|实战|及其\w*|的\w*)$")


def norm(s: Any) -> str:
    t = str(s or "")
    for ch in _PUNCT:
        t = t.replace(ch, "")
    return t.lower()


def split_tags(raw: Any) -> list[str]:
    """题库 knowledge_points 是自由文本（逗号/顿号/分号混合），切成标签集合。"""
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        parts = [str(x) for x in raw]
    else:
        parts = re.split(r"[,，、;；/|\n]+", str(raw))
    return [p.strip() for p in parts if p and p.strip()]


def key_terms(name: str, min_len: int = 2) -> list[str]:
    """从一个知识点名里抽出可用于判定的"实词"，并剥掉过泛的尾词。"""
    parts = [p for p in re.split(r"[,，、;；/|（）()]+|及其|以及|与其|和|与|及|的|之|等|或", str(name or "")) if p]
    out: list[str] = []
    for p in parts:
        p = p.strip()
        if len(p) < min_len or p in _STOP_WORDS:
            continue
        out.append(p)
        core = _SUFFIX_STRIP.sub("", p).strip()
        if len(core) >= max(3, min_len) and core not in _STOP_WORDS:
            out.append(core)
    # 去重保序
    seen, uniq = set(), []
    for t in out:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    return uniq


def fold_near_duplicates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """同题型 + 规范化题干完全一致的题只留一条。

    题库里有 ids=[42,140] [66,476] [151,508] 这类"题干一模一样"的重复题（实测 25 组），
    不去重就可能同时进同一份卷子，学生会看到两道相同的题。保留规则确定可复现：
    标签更全者优先，其次 ID 更小者（不随机，便于排查）。
    """
    best: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        key = ((r.get("type") or ""), norm(r.get("question_text")))
        cur = best.get(key)
        if cur is None:
            best[key] = r
            continue
        rank_new = (len(split_tags(r.get("knowledge_points"))), -int(r.get("id") or 0))
        rank_cur = (len(split_tags(cur.get("knowledge_points"))), -int(cur.get("id") or 0))
        if rank_new > rank_cur:
            best[key] = r
    return list(best.values())



def kp_ids_of_chapter(chapter_id: int) -> list[int]:
    """按 ID 展开某章节下的全部知识点（体现"课程→章节→知识点"层次，不靠名字猜）。"""
    try:
        from backend.database import execute_query as main_exec
        rows = main_exec(
            "SELECT id FROM knowledge_points WHERE chapter_id = ? AND COALESCE(status,'') <> 'deleted'",
            (int(chapter_id),),
        ) or []
        return [int((r[0] if not isinstance(r, dict) else list(r.values())[0])) for r in rows]
    except Exception as e:
        logger.debug(f"[选题] 章节知识点展开失败 chapter_id={chapter_id}: {e}")
        return []


def linked_question_ids(kp_ids: Sequence[int]) -> set[int]:
    """ID 映射表里挂了这些知识点的题目集合（T0 的数据源）。"""
    ids = [int(i) for i in kp_ids if i]
    if not ids:
        return set()
    try:
        marks = ",".join("?" * len(ids))
        rows = execute_query(
            f"SELECT DISTINCT question_id FROM question_kp_map WHERE kp_id IN ({marks})", tuple(ids))
        return {int(r[0] if not isinstance(r, dict) else list(r.values())[0]) for r in rows or []}
    except Exception as e:
        logger.debug(f"[选题] 映射表查询失败: {e}")
        return set()


_WARNED: set[str] = set()   # 同类配置告警只提示一次，避免刷屏


def _col(row: Any, idx: int, key: str) -> Any:
    """兼容 元组行 / sqlite3.Row / dict 三种返回形态（两个库的 execute_query 形态不同）。"""
    if isinstance(row, dict):
        return row.get(key)
    try:
        return row[key]
    except (TypeError, IndexError, KeyError):
        return row[idx]


def build_kp_map(dry_run: bool = True) -> dict[str, Any]:
    """构建/刷新"题目 ↔ 教材知识点"ID 关联。

    只认一种关系：题目标签（按逗号/顿号切分并规范化后）与教材知识点名**完全相等**，
    且该知识点名在全库**唯一**（同名跨章节无法判定时宁可不写）。多标签题会建立多条边。
    """
    from backend.database import execute_query as main_exec
    stat = {"dry_run": dry_run, "pairs": 0, "written": 0, "ambiguous_names": 0, "unknown_tags": 0}
    try:
        kps = main_exec("SELECT id, name FROM knowledge_points WHERE COALESCE(status,'') <> 'deleted'") or []
    except Exception as e:
        stat["error"] = "知识点读取失败: %s" % e
        return stat
    by_name: dict[str, list[int]] = {}
    for r in kps:
        nn = norm(_col(r, 1, "name"))
        if nn:
            by_name.setdefault(nn, []).append(int(_col(r, 0, "id")))
    qrows = execute_query("SELECT id, knowledge_points FROM question_bank WHERE status='active'") or []
    ops: list[tuple[int, int, str]] = []
    for r in qrows:
        qid = int(_col(r, 0, "id"))
        for tag in split_tags(_col(r, 1, "knowledge_points")):
            nn = norm(tag)
            if not nn:
                continue
            hit = by_name.get(nn)
            if not hit:
                stat["unknown_tags"] += 1
                continue
            if len(hit) > 1:
                stat["ambiguous_names"] += 1     # 同名知识点跨章节，无法判定 → 不猜
                continue
            ops.append((qid, hit[0], tag.strip()))
    stat["pairs"] = len(ops)
    stat["changed"] = False
    if not dry_run and ops:
        from backend.question_db import execute_update as _upd
        for qid, kpid, name in ops:
            # 用 execute_update 逐条写（它自带 commit）；早前用 with get_connection()
            # 批量写没提交，163 条边被回滚成 0 条
            n = _upd("INSERT OR IGNORE INTO question_kp_map (question_id, kp_id, kp_name) VALUES (?,?,?)",
                     (qid, kpid, name))
            stat["written"] += int(n or 0)
    return stat


def kp_ids_by_name(name: str) -> list[int]:
    """按知识点名反查教材知识点 ID —— 只在全库唯一时才返回，绝不猜。"""
    nn = norm(name)
    if not nn:
        return []
    try:
        from backend.database import execute_query as main_exec
        rows = main_exec(
            "SELECT id, name FROM knowledge_points WHERE COALESCE(status,'') <> 'deleted'") or []
        hit = [int(_col(r, 0, "id")) for r in rows if norm(_col(r, 1, "name")) == nn]
        return hit if len(hit) == 1 else []
    except Exception as e:
        logger.debug(f"[选题] 知识点名反查失败: {e}")
        return []


def link_question_kp(question_id: int, kp_name: str = "", kp_id: int = 0) -> bool:
    """新题入库后顺手与教材知识点连一条 ID 边（喂给 T0，越用越准、越用越省 AI）。

    连边只认两种确定关系：调用方**直接给了 kp_id**（练习场景就有），或知识点名
    在全库**唯一命中**（AI 生成题只有自由文本标签时）。连不上就返回 False，
    绝不为了"有边"去猜一个知识点。重复调用安全（INSERT OR IGNORE）。
    """
    try:
        qid = int(question_id or 0)
        if qid <= 0:
            return False
        ids = [int(kp_id)] if kp_id else kp_ids_by_name(kp_name or "")
        if not ids:
            return False
        from backend.question_db import execute_update as _upd
        for kpid in ids:
            _upd("INSERT OR IGNORE INTO question_kp_map (question_id, kp_id, kp_name, source)"
                 " VALUES (?,?,?,?)", (qid, int(kpid), (kp_name or "").strip(), "ai_saved"))
        return True
    except Exception as e:
        logger.debug(f"[选题] 连边失败 qid={question_id}: {e}")
        return False


def rebuild_kp_map() -> dict[str, Any]:
    """启动自检入口：把"标签=教材知识点名且唯一"的确定关系补进 ID 关联表。

    幂等（INSERT OR IGNORE，重复跑不产生任何变化），所以可以放心每次启动都跑：
    AI 生成的新题、批量导入的旧题，都会在下次启动时自动进 T0 候选池，
    不必再手工执行脚本。歧义（同名知识点跨章节）一律不写。
    """
    stat = build_kp_map(dry_run=False)
    stat["changed"] = bool(stat.get("written"))
    if stat.get("written"):
        logger.info("[启动自检] 题库↔教材知识点 ID 关联新增 %s 条（歧义 %s 条、无对应知识点 %s 条）"
                    % (stat.get("written"), stat.get("ambiguous_names"), stat.get("unknown_tags")))
    return stat


def sibling_names_of(kp_id: int) -> list[str]:
    """同章节其它知识点名（T4 用）：同一节课的题是最安全的兜底来源。跨库只读，失败即空。"""
    try:
        from backend.database import execute_query as main_exec
        rows = main_exec(
            """SELECT k2.name FROM knowledge_points k1
               JOIN knowledge_points k2 ON k2.chapter_id = k1.chapter_id AND k2.id <> k1.id
               WHERE k1.id = ? AND COALESCE(k2.status, '') <> 'deleted' LIMIT 30""",
            (int(kp_id),),
        ) or []
        return [r[0] if not isinstance(r, dict) else r.get("name", "") for r in rows]
    except Exception as e:
        logger.debug(f"[选题] 兄弟知识点取失败 kp_id={kp_id}: {e}")
        return []


def _chunk(seq: Sequence, n: int = 400):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


_SELECT_COLS = ("id, type, question_text, options, correct_answer, explanation, "
                "knowledge_points, subject, difficulty, source, status, created_at, updated_at, "
                "svg_content, has_svg, media_placeholders, media_files, creator_username")


def select_questions(
    *,
    kp_name: str = "",
    sibling_kp_names: Iterable[str] = (),
    kp_id: int = 0,
    chapter_id: int = 0,
    subject: str = "",
    types: Sequence[str] = ("single",),
    count: int = 10,
    exclude_ids: Sequence[int] = (),
    avoid_ids: Sequence[int] = (),
    rotate: str = "call",
    difficulty: str = "",
    require_family: bool = True,
    allow_family_fallback: bool = False,
    broad_ratio: float = 0.4,
    broad_min_hits: int = 15,
    seed: str = "",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """按 T1>T2>T3>T4>T5 分层选题，返回 (题目行 dict 列表, 审计信息)。

    题目行是 question_bank 的原始列（options 等仍是 JSON 字符串），由调用方按各自
    前端形状再加工 —— 这样接入老代码时不必同时改两处格式。
    """
    audit: dict[str, Any] = {"requested": count, "tiers": {}, "skipped": {}, "short_by": count}
    if kp_id and not sibling_kp_names:
        sibling_kp_names = sibling_names_of(kp_id)
        if sibling_kp_names:
            audit["siblings"] = len(sibling_kp_names)
    if count <= 0:
        audit["reason"] = "count<=0"
        return [], audit

    types = tuple(t for t in (types or ("single",)) if t) or ("single",)
    fam = subject_family(subject)
    if require_family and not fam:
        # 指定了要严格隔离，但学科名没给：宁可退回不隔离，也要在审计里写明
        audit["skipped"]["family"] = "未提供学科名，本次不做学科隔离"
    fam_writes = family_members(subject) if fam else []

    conditions = ["status='active'", "type IN (" + ",".join("?" for _ in types) + ")"]
    params: list[Any] = list(types)
    if fam and require_family:
        marks = ",".join("?" for _ in fam_writes)
        # 学科为空的题不参与（它们无法证明属于本族）—— 这是"指定学科就不许错选"的硬要求
        conditions.append(f"subject IN ({marks})")
        params.extend(fam_writes)
    avoid = {int(i) for i in avoid_ids if i}
    if avoid:
        audit["avoid_prev_batch"] = len(avoid)
    excl = [int(i) for i in exclude_ids if i]
    if excl:
        for part in _chunk(excl):
            conditions.append("id NOT IN (" + ",".join("?" for _ in part) + ")")
            params.extend(part)

    rows = execute_query(
        f"SELECT {_SELECT_COLS} FROM question_bank WHERE " + " AND ".join(conditions),
        tuple(params),
    ) or []
    cand = [dict(r) for r in rows]
    # 近重复折叠：同题型+规范化题干一致的只留一条，避免一份卷子里出现两道相同题
    _raw_n = len(cand)
    cand = fold_near_duplicates(cand)
    if _raw_n - len(cand):
        audit["folded_duplicates"] = _raw_n - len(cand)
    audit["pool"] = len(cand)
    if not cand:
        audit["reason"] = "学科/题型池子为空（题库无该学科该题型可用题）"
        return [], audit

    # 泛词判定：某实词在本学科池子里命中占比过高就不作判据（防「技术」串题）
    terms = key_terms(kp_name)
    kept, broad = [], []
    for t in terms:
        hits = sum(1 for r in cand if t in (norm(r.get("knowledge_points")) + norm(r.get("question_text"))))
        if hits and not (hits >= broad_min_hits and hits / len(cand) > broad_ratio):
            kept.append(t)
        else:
            broad.append(t)
    audit["terms"] = kept
    # T0：ID 级关联（映射表由 build_kp_map 用"标签=知识点名且唯一"的确定关系建立）
    kp_scope = [int(kp_id)] if kp_id else []
    if chapter_id:
        kp_scope.extend(kp_ids_of_chapter(chapter_id))
    if not kp_scope and kp_name:
        kp_scope = kp_ids_by_name(kp_name)   # 只有主题名（资源管理场景）：唯一命中才建 ID 关联
    # 挂接展开（一对多，只到知识点级）：把挂上的教材知识点一起拉进召回范围
    alias_names: list[str] = []
    if kp_id:
        try:
            from backend.kp_link import expand_kp
            _ids, _names = expand_kp(int(kp_id))
            kp_scope = list(dict.fromkeys(kp_scope + _ids))
            alias_names = [n for n in _names if norm(n) and norm(n) != norm(kp_name)]
        except Exception as e:
            # 表没建好时挂接会静默失效，必须看得见（只提示一次，避免每次请求刷屏）
            if "kp_link" not in _WARNED:
                _WARNED.add("kp_link")
                logger.warning(f"[选题] 挂接展开失败，挂接不会生效（kp_link 表未就绪？启动自检会建表）: {e}")
            else:
                logger.debug(f"[选题] 挂接展开失败 kp_id={kp_id}: {e}")
    if alias_names:
        audit["linked"] = alias_names
    t0_ids = linked_question_ids(kp_scope)
    audit["t0_linked_pool"] = len(t0_ids)
    if kp_scope:
        audit["kp_scope"] = sorted(set(kp_scope))
    if broad:
        audit["skipped"]["broad_terms"] = ",".join(broad)
    kp_norm = norm(kp_name)
    alias_norms = [norm(a) for a in alias_names]
    kp_norms = [x for x in ([kp_norm] + alias_norms) if x]
    terms = list(dict.fromkeys(terms + [t for a in alias_names for t in key_terms(a)]))
    sib_norms = {norm(s) for s in sibling_kp_names if norm(s)}

    def tier_of(r: dict[str, Any]) -> tuple[int, int]:
        tags = split_tags(r.get("knowledge_points"))
        ntags = [norm(t) for t in tags]
        ntext = norm(r.get("question_text"))
        if r.get("id") in t0_ids:
            return 0, 120
        if kp_norms and any(t in kp_norms for t in ntags):
            return 1, 100
        if kp_norms and any(t and any((t in kn or kn in t) and len(t) >= 3 and t not in _STOP_WORDS
                                      for kn in kp_norms) for t in ntags):
            return 2, 80
        if terms:
            hit = sum(1 for t in terms if t in ntext or any(t in x for x in tags))
            need = 2 if len(terms) >= 3 else 1
            if hit >= need:
                return 3, 60
        if sib_norms and any(t in sib_norms for t in ntags):
            return 4, 40
        return 5, 10  # T5: 同学科族但内容与本知识点无关

    by_tier: dict[int, list[dict[str, Any]]] = {}
    for r in cand:
        t, _score = tier_of(r)
        by_tier.setdefault(t, []).append(r)
        audit["tiers"][f"T{t}"] = audit["tiers"].get(f"T{t}", 0) + 1

    # 层内顺序 = 固定种子打乱（同活动同知识点可复现）；指定难度时把该难度排在前面，
    # 但**不会因为难度不够而选空** —— 同层其他难度接着补，并在审计里写明放宽了什么。
    nonce = {"call": _uuid4().hex, "day": _dt.now().strftime("%Y-%m-%d")}.get(rotate, "")
    audit["rotate"] = rotate

    def ordered(pool_tier: int, want_diff: str) -> list[dict[str, Any]]:
        bucket = list(by_tier.get(pool_tier, []))
        rng = random.Random("%s|%s|T%s|%s" % (seed, kp_name, pool_tier, nonce))
        rng.shuffle(bucket)
        if avoid:      # 上一批用过的题排到后面（软避开：不够仍会拿来补，不会选空）
            bucket.sort(key=lambda r: 1 if r.get("id") in avoid else 0)
        if want_diff:  # 稳定排序：难度偏好排在避让之后应用，两者互不覆盖
            bucket.sort(key=lambda r: 0 if r.get("difficulty") == want_diff else 1)
        return bucket

    # T5 默认不参与：有 AI 补差的入口宁可让 AI 出题，也不拿"同学科但无关"的题充数；
    # 只有考试自动选题、组卷这类不会自动生成题目的场景才显式打开兜底。
    chosen: list[dict[str, Any]] = []
    used: set[int] = set()
    tiers = (0, 1, 2, 3, 4, 5) if allow_family_fallback else (0, 1, 2, 3, 4)
    if not allow_family_fallback and audit["tiers"].get("T5"):
        audit["skipped"]["T5"] = "同学科兜底未启用(默认): 宁可 AI 补差, 也不用与知识点无关的题"

    def one_pass(skip_avoid: bool) -> None:
        for t in tiers:
            if len(chosen) >= count:
                return
            if not audit["tiers"].get("T%s" % t):
                continue
            want = count - len(chosen)
            want_diff = difficulty if (difficulty and t <= 4) else ""
            got = 0
            for r in ordered(t, want_diff):
                if got >= want or r["id"] in used:
                    continue
                if skip_avoid and r["id"] in avoid:
                    continue       # 第一遍不立即复用上一批，先让后面的层级顶上
                used.add(r["id"])
                chosen.append(r)
                got += 1
            key = "T%s_used" % t
            audit["tiers"][key] = audit["tiers"].get(key, 0) + got
            if want_diff and got:
                pref = sum(1 for r in by_tier.get(t, []) if r.get("difficulty") == want_diff)
                if pref < want:
                    audit["skipped"]["T%s_difficulty" % t] = ("该层难度 %s 仅 %d 题, 已放宽同层其他难度" % (want_diff, pref))

    one_pass(skip_avoid=bool(avoid))
    if avoid and len(chosen) < count:
        one_pass(skip_avoid=False)   # 避让后凑不满：宁可复用上一批，也不能选空
        audit["skipped"]["avoid_relaxed"] = "避让上一批后不足，已允许复用(避免选空)"

    if len(chosen) < count:
        audit["short_by"] = count - len(chosen)
        audit["reason"] = f"题库可用 {len(chosen)} 题（池子 {len(cand)}），仍缺 {audit['short_by']} 题，需 AI 补差"
    else:
        audit["short_by"] = 0
    if avoid and chosen:
        audit["repeated_from_prev_batch"] = sum(1 for r in chosen if r.get("id") in avoid)
    audit["fallback_only"] = bool(chosen) and allow_family_fallback and all(tier_of(r)[0] >= 5 for r in chosen)
    return chosen, audit


def summarize_audit(audit: dict[str, Any]) -> str:
    """把审计压成一行日志：一眼看出题从哪来、为什么放宽、还差几题。"""
    tiers = audit.get("tiers", {})
    parts = [f"T{t}={tiers.get(f'T{t}_used', 0)}/{tiers.get(f'T{t}', 0)}" for t in (1, 2, 3, 4, 5) if f"T{t}" in tiers]
    s = "池=%s 选=%s %s" % (audit.get("pool"), audit.get("requested", 0) - audit.get("short_by", 0), " ".join(parts))
    if audit.get("skipped"):
        s += " 跳过:" + ";".join(f"{k}={v}" for k, v in audit["skipped"].items())
    if audit.get("reason"):
        s += " 原因:" + str(audit["reason"])[:80]
    return s


def bank_notice(audit: dict[str, Any]) -> str:
    """把审计翻成一句给老师看的话（提示不拦截）：命中多少、缺多少、为什么。"""
    want = int(audit.get("requested", 0) or 0)
    short = int(audit.get("short_by", 0) or 0)
    got = max(want - short, 0)
    linked = audit.get("linked") or []
    pool = int(audit.get("pool", 0) or 0)
    if not want:
        return ""
    if short == 0:
        base = f"题库命中 {got}/{want} 题"
    else:
        base = (f"题库命中 {got}/{want} 题，缺 {short} 题由 AI 生成"
                f"（该知识点题库可召 {pool} 题）")
        if not got:
            base += "；建议在课程管理中把本知识点挂接到教材知识点，或补充题目标签"
    if linked:
        base += "；已挂接教材知识点：" + "、".join(str(x)[:14] for x in linked[:4])
    skip = audit.get("skipped") or {}
    if skip.get("avoid_relaxed"):
        base += "；上一批题目已复用（题库量不足）"
    return base


def log_audit(scene: str, audit: dict[str, Any]) -> None:
    logger.info(f"[选题]{scene} {summarize_audit(audit)}")
