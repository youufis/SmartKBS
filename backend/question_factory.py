# -*- coding: utf-8 -*-
"""题目入库唯一出口：normalize → validate → 查重 → 事务插入 → 连边。

为什么要有这个模块（2026-10 走查）
--------------------------------
全仓有 9 处 `INSERT INTO question_bank`，散在 5 个 router 里，各自手写"解析后规整 +
校验 + 查重 + 插入 + 连边"。结果是需要哪几件事全凭各站点自觉：

    站点                        校验  查重  连边
    同步练习 / 章节练习 / 课程练习   ✅    ✅    ✅
    智能提取                       ✗    ✅    ✅
    随堂测验                       ✗    ✅    ✗
    AI 生成（两个端点）             ✗    ✗    ✗     ← 题库 59% 的题从这里来
    手动导入                       ✗    ✗    ✗

本模块**不重新实现任何判定**，只把仓库里早已存在、且已被部分站点验证过的零件按固定顺序
编排起来：ai_json.question_is_complete（字段体检）、answer_norm（答案归一）、
question_select.find_duplicate_question（学科族+题型+规范化题干查重）、
question_select.link_question_kp（教材知识点连边）、question_media.media_columns_for_insert
（配图列）。所以它是"编排器"，不是"第 10 份实现"。

三条硬规矩（都是踩过的坑）
------------------------
1. **不碰解析**。进来的必须是已经过 `_parse_ai_response`（快速三策略 + ai_json 容错层兜底
   + 题干内嵌选项剥离）解析好的 dict 列表。历史上"模型返回带客套话 / 中文引号当定界符 /
   尾逗号 / 响应被截断"导致的无法解析，全部由那一层修好并有原文留档，本模块一律不参与，
   避免把已经修好的链路再改坏。
2. **事务只包题目插入**，配图生图（外部 HTTP）与连边都在提交之后做。
   `link_question_kp` 自己开连接写库，若把它放进 BEGIN IMMEDIATE 里，等于持着写锁等
   另一条连接 —— 轻则 SQLITE_BUSY，重则自锁。生图同理：一批图几十秒，
   绝不能把数据库写锁按住这么久。
3. **不静默改老师的意图**。题型以请求为准（模型给的不符时，只在无歧义处修复，
   修不了就拒绝并说明原因）；知识点以输入为准（模型的标签只在输入为空时采用）。
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Sequence

from backend.ai_json import question_is_complete
from backend.answer_norm import normalize_answer, option_keys
from backend.logger import logger
from backend.question_db import execute_query, get_connection
from backend.question_media import media_columns_for_insert
from backend.question_select import (
    family_members,
    find_duplicate_question,
    link_question_kp,
    norm,
)

# 选择题（需要选项与字母答案）与非选择题（文字作答）
CHOICE_TYPES = ("single", "multiple", "true_false")
TEXT_TYPES = ("short", "fill", "essay", "subjective")
ALL_TYPES = CHOICE_TYPES + TEXT_TYPES + ("code",)

_DUP_COLS = ("id, question_text, options, correct_answer, explanation, knowledge_points,"
             " difficulty, svg_content, has_svg, media_placeholders, media_files")


# ══════════════════════════════════════════════════════════════
# 一、归一化：把各家 prompt 的不同写法收敛成一套
# ══════════════════════════════════════════════════════════════

_LEADING_LABEL = re.compile(r"^\s*([A-Za-z])\s*[.、．:：)）]\s*")


def normalize_options(raw: Any) -> dict[str, str]:
    """把 options 统一成 {"A": "…", "B": "…"}。

    必须同时吃下三种历史写法，否则"统一"就会把老数据读坏：
      1) dict —— chat.py / practice.py / teaching.py / quest.py 这套
      2) JSON 字符串 —— 数据库里存的原样
      3) list["A. 甲", "B. 乙"] 或 list["对", "错"] —— quiz.py（随堂测验）那套
    """
    if raw is None or raw == "":
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
    if isinstance(raw, dict):
        return {str(k).strip(): ("" if v is None else str(v)) for k, v in raw.items()}
    if isinstance(raw, list):
        out: dict[str, str] = {}
        for i, item in enumerate(raw):
            text = "" if item is None else str(item).strip()
            m = _LEADING_LABEL.match(text)
            if m:
                key = m.group(1).upper()
                body = text[m.end():].strip()
            else:
                key = chr(65 + i)
                body = text
            if key in out:                      # 出现重复字母时不再覆盖，退到下一个空位
                key = chr(65 + len(out))
            out[key] = body
        return out
    return {}


# 判断题固定选项：全库 113 道判断题都是这个形状（实测），模型不给选项时按此补齐
TF_OPTIONS = {"A": "对", "B": "错"}
_FALSE_WORDS = ("错误", "不对", "不正确", "有误", "否", "false", "×", "错")
_TRUE_WORDS = ("正确", "对", "是", "true", "√", "无误")


def answer_letters(answer: Any, options: Any, qtype: str = "") -> list[str]:
    """把各种写法（"A" / "AC" / "A,B,C" / "A. 甲" / "对" / "0"）归一成选项字母列表。

    一律委托 answer_norm.normalize_answer —— 那层已经把"下标答案 '0'、连写 'ABC'、
    中文'对/错/正确/√'、'A、B、C' 分隔"这些真实踩过的坑都处理好了，
    这里绝不再写第二套 split 规则（历史上各处自写 split 正是判分不一致的来源）。
    落在选项键之外的字母会被丢掉，交给 validate_item 去拒，不静默采纳。
    """
    # options 可能是 dict、也可能是库里存的 JSON 串：question_is_complete 两种都吃，
    # 这里也必须两种都吃，否则"校验前先 normalize"的调用方与直接传库值的调用方会得到
    # 不同结论（同一个答案，一处判合法一处判越界，是最难查的那类不一致）
    if isinstance(options, str):
        options = normalize_options(options)
    keys = [str(k).strip().upper() for k in option_keys(options)]
    norm = str(normalize_answer(answer, options, qtype) or "").upper()
    out: list[str] = []
    for ch in norm:
        if ch in keys and ch not in out:
            out.append(ch)
    return out


def _truth_text(options: dict[str, str], key: str) -> str:
    """把判断题的选项文字归到全库约定的「对 / 错」。"""
    text = str((options or {}).get(key, "")).strip().lower()
    # 先判否定：「不对」里含「对」，顺序反了会把否定项认成正确答案
    if any(w in text for w in _FALSE_WORDS):
        return "错"
    if any(w in text for w in _TRUE_WORDS):
        return "对"
    keys = [str(k).strip().upper() for k in option_keys(options)]
    return "对" if keys and key == keys[0] else "错"


def normalize_item(raw: dict[str, Any], *, subject: str = "", question_type: str = "",
                   difficulty: str = "", knowledge_points: str = "") -> dict[str, Any]:
    """把一条模型/外部返回的题目规整成入库形态，并记录做了哪些修复。

    question_type 非空表示"老师指定的题型"：此时**以指定为准**，模型给的 type 只在
    无歧义处用于修复答案写法，绝不用来换题型（这是本次修的 P0：UI 选单选题、
    结果入库五种题型）。
    """
    notes: list[str] = []
    q_text = str(raw.get("question") or raw.get("question_text") or "").strip()
    options = normalize_options(raw.get("options"))
    model_type = str(raw.get("type") or "").strip().lower()
    q_type = (question_type or model_type or "single").strip().lower()
    if q_type not in ALL_TYPES:
        q_type = "single"
    if question_type and model_type and model_type != question_type:
        notes.append(f"模型给的是{model_type}，已按指定题型{question_type}处理")

    raw_answer = str(raw.get("answer") or raw.get("correct_answer") or "").strip()
    answer = raw_answer
    if q_type == "true_false" and not options:
        # 模型常只给「对/错」不给选项；补齐成全库统一形状，否则会被"选项不足 2 个"整批拒收
        options = dict(TF_OPTIONS)
        notes.append("判断题补齐固定选项 对/错")
    if q_type in CHOICE_TYPES and options:
        letters = answer_letters(raw_answer, options, q_type)
        if q_type == "true_false":
            if letters:
                answer = _truth_text(options, letters[0])
            else:
                answer = _truth_text(options, "A") if raw_answer in ("对", "错") else raw_answer
            if answer != raw_answer:
                notes.append(f"判断题答案 {raw_answer!r} 已归一为 {answer!r}")
        elif q_type == "single":
            if len(letters) > 1:
                notes.append(f"单选题答案 {raw_answer!r} 含多个选项，无法确定唯一答案")
            else:
                answer = letters[0] if letters else raw_answer
        else:  # multiple：统一成约定的 "A,B,C" 写法（表注释口径）
            if letters:
                answer = ",".join(letters)
                if answer != raw_answer:
                    notes.append(f"多选答案 {raw_answer!r} 已统一为 {answer!r}")
            else:
                notes.append(f"多选答案 {raw_answer!r} 未落在选项键内")

    kp = (knowledge_points or "").strip() or str(
        raw.get("knowledge_point") or raw.get("knowledge_points") or "").strip()
    if not (knowledge_points or "").strip() and kp:
        notes.append("知识点由模型给出")

    diff = str(raw.get("difficulty") or "").strip().lower()
    if diff not in ("easy", "medium", "hard"):
        diff = difficulty if difficulty in ("easy", "medium", "hard") else "medium"

    svg_code, has_svg, media_placeholders = media_columns_for_insert(raw)

    return {
        "type": q_type,
        "question_text": q_text,
        "options": options,
        "correct_answer": answer,
        "explanation": str(raw.get("explanation") or "").strip(),
        "knowledge_points": kp,
        "subject": subject,
        "difficulty": diff,
        "svg_content": svg_code,
        "has_svg": has_svg,
        # 对外一律给 list（调用方要渲染、要传给生图），入库时再由 _as_json 序列化。
        # media_raw 保留模型给的原始那份：占位符数量会被 media_columns_for_insert 按
        # 上限裁切，而生图要用的是原始描述列表。
        "media_placeholders": _as_list(media_placeholders),
        "media_raw": raw.get("media_placeholders") or [],
        "normalize_notes": notes,
    }


def validate_item(n: dict[str, Any], *, allow_code: bool = False) -> tuple[bool, str]:
    """入库前体检。复用 ai_json.question_is_complete（非选择题跳过选项项检查）。

    allow_code：编程题的模板代码与测试用例只有「代码练习」那张表存得下，机器生成的
    链路默认拒收（AI 给的 code 题进题库就是不可判分的死题）；人工维护链路可以放行 ——
    题库里本来就有人手写的 code 题，一律拒反而是改坏。
    """
    if not n.get("question_text"):
        return False, "题干为空"
    if len(n["question_text"]) < 6:
        return False, "题干过短"
    if n["type"] == "code" and not allow_code:
        return False, "编程题请走「代码练习」"
    if n["type"] in CHOICE_TYPES:
        ok, reason = question_is_complete(n)
        if not ok:
            return False, reason
        if n["type"] == "single":
            letters = answer_letters(n["correct_answer"], n["options"], "single")
            if len(letters) != 1:
                return False, f"单选题答案应为 1 个选项（实际 {n['correct_answer']!r}）"
        elif n["type"] == "multiple":
            letters = answer_letters(n["correct_answer"], n["options"], "multiple")
            if len(letters) < 2:
                return False, f"多选题答案应至少 2 个选项（实际 {n['correct_answer']!r}）"
        else:  # true_false：答案必须是「对/错」，且能落到某个选项键上
            if str(n["correct_answer"]).strip() not in ("对", "错"):
                return False, f"判断题答案应为「对/错」（实际 {n['correct_answer']!r}）"
            if not answer_letters(n["correct_answer"], n["options"], "true_false"):
                return False, "判断题答案无法对应到选项"
        return True, ""
    if not str(n.get("correct_answer") or "").strip():
        return False, "参考答案为空"
    return True, ""


# ══════════════════════════════════════════════════════════════
# 二、查重
# ══════════════════════════════════════════════════════════════

class DupIndex:
    """按 (题型) 缓存"该学科族内已有题"，命中判定走 question_select 的统一口径。

    口径与智能提取路径完全一致：学科族（信息技术≡信息科技）+ 题型 + 规范化题干。
    新插入的题会即时补进缓存，所以**同一批里的自重复也能查到**。
    """

    def __init__(self, subject: str):
        self.subject = subject
        self._cache: dict[str, list[dict[str, Any]]] = {}
        self._misses = 0

    def rows(self, q_type: str) -> list[dict[str, Any]]:
        if q_type not in self._cache:
            fam = family_members(self.subject)
            cond = (" AND subject IN (" + ",".join("?" * len(fam)) + ")") if fam else ""
            prm = ([q_type] + list(fam)) if fam else [q_type]
            self._cache[q_type] = [dict(r) for r in (execute_query(
                f"SELECT {_DUP_COLS} FROM question_bank"
                f" WHERE status='active' AND type=?{cond}", tuple(prm)) or [])]
        return self._cache[q_type]

    def find(self, q_type: str, q_text: str) -> dict[str, Any] | None:
        rows = self.rows(q_type)
        hit = find_duplicate_question([(r["id"], r["question_text"]) for r in rows], q_text)
        if hit is None:
            return None
        self._misses += 1
        return next((r for r in rows if r["id"] == hit), None)

    def add(self, q_type: str, row: dict[str, Any]) -> None:
        self.rows(q_type).append(row)

    @property
    def dup_hits(self) -> int:
        return self._misses


def _as_json(value: Any) -> str:
    if value in (None, "", {}, []):
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


# ══════════════════════════════════════════════════════════════
# 三、入库（事务）+ 连边（提交后）
# ══════════════════════════════════════════════════════════════

def persist_questions(items: Sequence[dict[str, Any]], *, subject: str = "", source: str = "ai",
                      username: str = "", creator_name: str = "", question_type: str = "",
                      difficulty: str = "medium", knowledge_points: str = "",
                      dedup: bool = True, link: bool = True,
                      dry_run: bool = False, allow_code: bool = False,
                      link_duplicates: bool = False,
                      kp_id: int = 0,
                      write_creator_name: bool = True) -> dict[str, Any]:
    """把一批题目入库，返回 saved / duplicated / rejected 三段结果。

    items 可以是模型原始 dict（会自动 normalize），也可以是已 normalize 的 dict。
    dry_run=True 时不写库，只报告将要发生什么。

    link_duplicates=True 时，命中题库已有题也补一条知识点边（连边本身幂等，
    INSERT OR IGNORE）。章节练习那条路径历史上就是这么做的：老题只有连上边才能进 T0
    候选池，下次才不必再烧一次 AI。默认关，避免"统一"顺手改掉其它站点已有的行为。

    source_index 是必须的：调用方（同步练习、课程练习）拿到结果后要**按输入顺序**把
    id 与旧题配图写回原来的题目对象，再交给前端渲染。没有它就只能赌"顺序恰好一致"，
    一旦有题目被拒或被折叠，回填就错位 —— 那是把 A 题的图配到 B 题上，比不回填更糟。

    返回：
      saved       [{id, …入库字段…, normalize_notes:[]}]
      duplicated  [{id, question_text, …}]            命中已有题，回填旧 id
      rejected    [{reason, question_text, type}]     校验没过，未入库
      （三类条目都带 source_index = 该条在本次输入里的下标）
      stats       {requested, saved, duplicated, rejected, by_type, by_difficulty,
                   normalize_notes, dup_index_size}
    """
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if not creator_name:
        creator_name = username
    index = DupIndex(subject)
    saved: list[dict[str, Any]] = []
    duplicated: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    notes: list[str] = []
    # 批内自重复：查重缓存要等插完库才补，所以同一批里的第二道相同题查不到 ——
    # 用与 find_duplicate_question 同一个 norm() 做键，先在本批内折叠。
    seen_in_batch: dict[tuple[str, str], int] = {}
    in_batch_pairs: list[tuple[int, dict[str, Any]]] = []
    dup_links: list[tuple[int, str]] = []

    for i, raw in enumerate(items or []):
        # 一律过 normalize_item，**不做"看起来已经规整过"的嗅探**：历史上这里用
        # 「有 question_text 且 options 是 dict」当作已规整的判据，于是章节练习那种
        # 半成品输入（有题干、有选项字典，但没有 has_svg / media_placeholders）会整批
        # 绕过规直，直到 INSERT 时 KeyError: 'has_svg' —— 而且发生在事务里，一整批题
        # 全部回滚。normalize_item 对已规整的 dict 是幂等的（题干、选项、答案原样，
        # 配图列按同一套清洗规则重算），少一条分支就少一类"两处口径不一致"。
        n = normalize_item(raw or {}, subject=subject, question_type=question_type,
                           difficulty=difficulty, knowledge_points=knowledge_points)
        n["subject"] = subject or n.get("subject", "")
        for note in n.get("normalize_notes") or []:
            notes.append(note)
        ok, reason = validate_item(n, allow_code=allow_code)
        if not ok:
            rejected.append({"reason": reason, "question_text": n.get("question_text", "")[:60],
                             "type": n.get("type", ""), "source_index": i})
            continue
        key = (n["type"], norm(n["question_text"]))
        if dedup and key in seen_in_batch:
            # 折叠到本批第一次出现的那一道（id 在插库后回填）
            i = seen_in_batch[key]
            first = saved[i]
            in_batch_pairs.append((i, {
                "id": None, "type": first["type"], "question_text": first["question_text"],
                "options": first["options"], "correct_answer": first["correct_answer"],
                "explanation": first.get("explanation", ""),
                "knowledge_points": first.get("knowledge_points", ""),
                "difficulty": first.get("difficulty", ""),
                "has_svg": first.get("has_svg", 0), "svg_content": first.get("svg_content"),
                "media_placeholders": first.get("media_placeholders") or [],
                "media_files": [], "media_raw": [],
                "duplicated": True, "in_batch": True, "normalize_notes": [],
            }))
            continue

        if dedup:
            hit = index.find(n["type"], n["question_text"])
            if hit is not None:
                if link_duplicates:
                    dup_links.append((int(hit["id"]), n.get("knowledge_points") or ""))
                duplicated.append({
                    "id": hit["id"], "type": n["type"],
                    "question_text": hit.get("question_text") or n["question_text"],
                    "options": _loads(hit.get("options")),
                    "correct_answer": hit.get("correct_answer") or n["correct_answer"],
                    "explanation": hit.get("explanation") or "",
                    "knowledge_points": hit.get("knowledge_points") or n["knowledge_points"],
                    "difficulty": hit.get("difficulty") or n["difficulty"],
                    "has_svg": hit.get("has_svg") or 0,
                    "svg_content": hit.get("svg_content") or None,
                    # 旧题的配图与媒体原样带回：命中重复时老师仍然要看得到图（P10）。
                    # 智能提取那侧此前固定回空列表，于是"新题有图、重复题没图"，一并修齐
                    "media_placeholders": _loads(hit.get("media_placeholders")) or [],
                    "media_files": _as_list(hit.get("media_files")),
                    "media_raw": [],
                    "duplicated": True,
                    "normalize_notes": [],
                    "source_index": i,
                })
                continue

        n["source_index"] = i
        saved.append(n)
        if dedup:
            seen_in_batch[key] = len(saved) - 1
        if not dry_run:
            n["_pending_id"] = None

    to_link: list[tuple[int, str]] = []
    if saved and not dry_run:
        with get_connection() as conn:
            conn.isolation_level = None
            conn.execute("BEGIN IMMEDIATE")
            try:
                cur = conn.cursor()
                # 列名与占位符按 write_creator_name 同步增删：有的站点历史上不写这一列，
                # 把 NULL 变成 '' 也是行为变化，不该被"统一"顺手带进来
                cn_cols = "creator_username, creator_name," if write_creator_name else "creator_username,"
                cn_ph = "?, ?," if write_creator_name else "?,"
                insert_sql = (
                    "INSERT INTO question_bank"
                    " (type, question_text, options, correct_answer, explanation,"
                    "  knowledge_points, subject, difficulty, " + cn_cols +
                    "  source, status, created_at, updated_at,"
                    "  svg_content, has_svg, media_placeholders)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, " + cn_ph +
                    " ?, 'active', ?, ?, ?, ?, ?)"
                )
                for n in saved:
                    tail = (username, creator_name) if write_creator_name else (username,)
                    cur.execute(insert_sql, (
                        n["type"], n["question_text"], _as_json(n["options"]), n["correct_answer"],
                        n["explanation"], n["knowledge_points"], n["subject"], n["difficulty"],
                        *tail, source, now, now,
                        n["svg_content"], n["has_svg"], _as_json(n["media_placeholders"]),
                    ))
                    n["id"] = int(cur.lastrowid)
                    if dedup:
                        index.add(n["type"], {
                            "id": n["id"], "question_text": n["question_text"],
                            "options": _as_json(n["options"]), "correct_answer": n["correct_answer"],
                            "explanation": n["explanation"], "knowledge_points": n["knowledge_points"],
                            "difficulty": n["difficulty"], "svg_content": n["svg_content"],
                            "has_svg": n["has_svg"], "media_placeholders": _as_json(n["media_placeholders"]),
                            "media_files": "",
                        })
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        for n in saved:
            n.pop("_pending_id", None)
            if link:
                to_link.append((int(n["id"]), n.get("knowledge_points") or ""))

    # 批内折叠项的 id 必须在插库之后回填：放在之前拿到的永远是 None，
    # 前端就会渲染出一条"题库里已有"但点不动、也删不掉的条目
    for i, dup in in_batch_pairs:
        dup["id"] = saved[i].get("id")          # dry_run 时没有 id，保持 None
        duplicated.append(dup)

    linked = 0
    if link and link_duplicates and not dry_run:
        # 重复题的补边同样必须在事务提交之后（link_question_kp 自开连接）
        to_link.extend(dup_links)
    for qid, kp in to_link:
        # 连边必须在事务提交之后：link_question_kp 自己开连接写库
        try:
            # kp_id 是现成的场景（课程练习按知识点生成）直接连 ID 边，最准且不受
            # "知识点名是否全库唯一"限制；没有 kp_id 时才退回按名字唯一命中
            if link_question_kp(qid, kp, kp_id):
                linked += 1
        except Exception as e:
            logger.debug(f"[入库] 连边失败 qid={qid}: {e}")

    by_type: dict[str, int] = {}
    by_diff: dict[str, int] = {}
    for n in saved:
        by_type[n["type"]] = by_type.get(n["type"], 0) + 1
        by_diff[n["difficulty"]] = by_diff.get(n["difficulty"], 0) + 1

    return {
        "saved": saved,
        "duplicated": duplicated,
        "rejected": rejected,
        "stats": {
            "requested": len(items or []),
            "saved": len(saved),
            "duplicated": len(duplicated),
            "rejected": len(rejected),
            "by_type": by_type,
            "by_difficulty": by_diff,
            "normalize_notes": notes[:12],
            "in_batch_duplicates": len(in_batch_pairs),
            "linked": linked,
            "dry_run": dry_run,
        },
    }


def _as_list(raw: Any) -> list[Any]:
    """JSON 列取出来必须是 list（不是就回空表，不抛异常）。"""
    got = _loads(raw)
    return got if isinstance(got, list) else []


def _loads(raw: Any) -> Any:
    """回填已有题的 JSON 列时保持原类型（options 是 dict、media_files 可能是 list）。"""
    if raw in (None, ""):
        return {}
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}