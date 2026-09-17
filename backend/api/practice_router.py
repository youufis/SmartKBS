"""
自适应出题 API 路由
教师：AI 出题 → 布置到班级
学生：查看练习 → 答题 → 提交 → 看结果
"""
import json
import re
import sqlite3
import asyncio
import traceback
from datetime import datetime
from typing import Optional, Any

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.question_db import execute_insert, execute_query, execute_query_one, execute_update
from backend.database import execute_query as db_execute_query, execute_insert_update as db_execute_update
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_async
from backend.utils import extract_json_from_text
from backend.api.config_router import get_config_value
from backend.logger import logger
# S-GRADING: 评分/出题 prompt 一律不注入技能(与 _build_generate_prompt 内注释同结论), 故不再 import apply_skills
from backend.prompts import build_ai_role
from backend.async_utils import spawn_bg as _spawn_bg
# S-GRADING: 主观题后台批量批改引擎
from backend.ai_grading import GradingJob, SourceAdapter, register_source, pending_keys
from backend.question_db import get_connection

router = APIRouter()

TYPE_DESC_MAP = {
    "single": "单选题（4个选项）",
    "multiple": "多选题（多个正确选项）",
    "true_false": "判断题",
    "short": "简答题",
    "fill": "填空题",
    "essay": "作文",
    "subjective": "主观题",
    "mixed": "混合出题（AI 自动搭配单选/多选/判断/简答/填空等）",
}


# ── 请求模型 ──

class PracticeGenerateRequest(BaseModel):
    """教师：AI 出题"""
    knowledge_points: str
    subject: str = ""
    question_type: str = "mixed"
    count: int = 5
    difficulty: str = "medium"
    # 题库优先(与随堂测验同口径): 先抽题库匹配题, 不足再 AI 补;
    # False = 全部 AI 新生成(旧行为)
    prefer_bank: bool = True


class PracticeCreateSession(BaseModel):
    """教师：创建练习任务"""
    title: str
    knowledge_points: str
    question_ids: list[int]
    scores: Optional[list[int]] = None
    target_grade: str = ""
    target_class: str = ""
    target_students: list[str] = []
    subject: str = ""
    # 统一活动范围体系(与随堂测验/投票/公告一致): teacher_classes|all|grade|class|individual
    target_scope: str = ""
    target_users: str = ""


class PracticeSubmitRequest(BaseModel):
    """学生：提交答案"""
    answers: dict[str, str]


class PracticeReviewRequest(BaseModel):
    """教师：复核/修改练习批改结果"""
    attempt_id: int
    # 逐题覆盖得分/评语(key = 题库题目 id), 越界会被夹到该题满分
    question_scores: Optional[dict[str, float]] = None
    question_comments: Optional[dict[str, str]] = None
    # 直接指定总分(留空则按逐题分自动重算)与整卷评语
    teacher_score: Optional[float] = None
    teacher_comment: Optional[str] = None


# ════════════════════════════════════════════
# 教师端
# ════════════════════════════════════════════

# ════════════════════════════════════════════
# 共用工具：权限 / 可见性 / 归一化 / 后台任务
# ════════════════════════════════════════════

# 走 AI 语义批改的题型(P5: 主观题必须有人批改, 不允许静默丢题)
# S-FILL: 填空题不再默认走 AI —— 先按「逐空精确比对」规则判分, 只有规则不可靠时才降级 AI
AI_GRADED_TYPES = ("short", "essay", "subjective")
FILL_TYPES = ("fill",)

_ANS_SEP_RE = re.compile(r"[,，;；、/\s|]+")

# ── S-GRADING: 判分工具（要点切分 / 归一化 / 命中比例给分）──
# 参考答案里的要点分隔符: 中英文标点、空白、以及 ①②③ /(1)/ 1. 这类标号
_POINT_SEP_RE = re.compile(
    r"[,，;；、。①②③④⑤⑥⑦⑧⑨⑩\s|｜/]+"
    r"|[（(]\s*\d+\s*[)）]"
    r"|(?<![\d.])\.(?![\d.])"
)
# 只在「确实是题号标号」时剥前缀: 括号编号 / 圈号 / 数字+.、且后面不是数字
# (后者若不限定, 小数答案 "0.5" 会被剥成 "5")
_LEAD_NUM_RE = re.compile(r"^\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]|[（(]\s*\d+\s*[)）]|\d+\s*[\.、](?!\d))\s*")
_PUNCT_RE = re.compile("""[\s\u3000，。、；：“”‘’'"()（）《》【】\[\]！!？?～~\u2014\-_,./\\|]+""")
# 兜底/规则判分可用的要点最长长度: 超过说明是整段描述文字, 关键词命中没有意义
MAX_POINT_LEN = 12


def _norm_text(v: Any) -> str:
    """归一化: 去空白与标点 + 转小写, 用于跨格式比对"""
    return _PUNCT_RE.sub("", str(v if v is not None else "")).lower()


def _num_tokens(v: Any) -> set[str]:
    """抽出文本里的数字并归一('02'→'2', '2.0'→'2'), 供数字要点精确比对"""
    out: set[str] = set()
    for m in re.findall(r"[-+]?\d+(?:\.\d+)?", str(v if v is not None else "")):
        out.add(m)
        try:
            f = float(m)
            out.add(str(int(f)) if f == int(f) else str(f))
        except ValueError:
            pass
    return out


def _split_points(raw: Any) -> list[str]:
    """参考答案 → 要点列表(去标号、去空项、去重)"""
    pts: list[str] = []
    for part in _POINT_SEP_RE.split(str(raw or "")):
        raw_pt = str(part or "").strip(" \t\r\n：:，。、；")
        pt = _LEAD_NUM_RE.sub("", raw_pt).strip(" \t\r\n：:，。、；")
        if not pt:
            pt = raw_pt  # 整段本身就是一个数字答案(如填空 "2"), 不能被当标号剥掉
        # 单字符要点只保留有意义的答案(数字/字母选项/对错), 其余噪声片段丢弃
        if (len(pt) >= 2 or re.fullmatch(r"[-+]?\d+(?:\.\d+)?|[A-Za-z对错√×±]", pt)) and pt not in pts:
            pts.append(pt)
    return pts


def _point_hit(point: str, student_norm: str, student_nums: set[str]) -> bool:
    """单个要点是否命中。
    纯数字要点必须整词命中(否则参考答案 '2' 会被学生答案 '12' 蒙对), 其余按归一化包含判断。"""
    pt = point.strip()
    if re.fullmatch(r"[A-Za-z]", pt):
        return student_norm == pt.lower()
    if re.fullmatch(r"[-+]?\d+(?:\.\d+)?", pt):
        return _num_tokens(pt) & student_nums != set() or pt in student_nums
    return bool(pt) and _norm_text(pt) in student_norm


def _ratio_score(q_score: float, hits: int, total: int) -> float:
    """按要点命中比例给分(保留 1 位小数)"""
    if total <= 0:
        return 0.0
    return round(q_score * min(hits / total, 1.0), 1)


def _grade_fill_by_rule(q: dict, student_ans: str) -> dict[str, Any] | None:
    """[S-FILL] 填空题规则判分: 逐空比对参考答案, 按命中空数比例给分。

    返回 None 表示规则不可靠(参考答案为空 / 空位里是长段描述), 调用方再降级 AI。
    is_correct 要求全部空命中(部分正确只给部分分, 仍算错题进错题本)。
    """
    correct = str(q.get("correct_answer") or "").strip()
    blanks = _split_points(correct)
    if not blanks or any(len(b) > MAX_POINT_LEN for b in blanks):
        return None
    q_score = float(q.get("score") or 10)
    norm = _norm_text(student_ans)
    nums = _num_tokens(student_ans)
    hits = sum(1 for b in blanks if _point_hit(b, norm, nums))
    return {
        "student_answer": student_ans, "correct_answer": correct,
        "score": _ratio_score(q_score, hits, len(blanks)), "max_score": q_score,
        "is_correct": hits == len(blanks), "graded_by": "exact",
    }

def _num_class(v: Any) -> str:
    """班级归一化: '高一1班' / '1班' / '01' / 1 -> '1'"""
    digits = re.sub(r"\D", "", str(v if v is not None else ""))
    return digits.lstrip("0")


def _normalize_objective_answer(v: Any) -> str:
    """P7: 客观题答案归一化(去分隔符/空白 + 大写 + 排序, 使多选 AC 与 CA 等价)"""
    return "".join(sorted(_ANS_SEP_RE.sub("", str(v if v is not None else "")).upper()))


def _is_correct_objective(student_ans: str, correct: str) -> bool:
    ref = _normalize_objective_answer(correct)
    return bool(ref) and _normalize_objective_answer(student_ans) == ref


def _parse_target_students(raw: Any) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw]
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    return [str(x) for x in data] if isinstance(data, list) else []


def _student_scope(username: str) -> tuple[str, str]:
    """学生的年级与班级(users 在 smartkb.db)"""
    rows = db_execute_query("SELECT grade, class FROM users WHERE username=?", (username,))
    if not rows:
        return "", ""
    return (rows[0][0] or "").strip(), str(rows[0][1] or "").strip()


def _session_visible_to_student(sess: dict, username: str, grade: str, cls: str) -> bool:
    """P2/P9: 练习是否对该学生开放 —— 定向名单优先; 有统一 target_scope 时
    走共用可见性判断(支持 任教班级/全体/年级/班级/指定学生);
    老数据无 scope 时按年级+班级范围回退, 行为不变"""
    targets = _parse_target_students(sess.get("target_students"))
    if targets:
        return username in targets
    scope = (sess.get("target_scope") or "").strip()
    if scope:
        from backend.permission_service import check_activity_visibility
        return check_activity_visibility(
            student_username=username,
            student_grade=grade,
            student_class=cls,
            creator_username=sess.get("creator_username", "") or "",
            target_scope=scope,
            target_grade=sess.get("target_grade", "") or "",
            target_class=sess.get("target_class", "") or "",
            target_users=sess.get("target_users", "") or "",
        )
    sg = (sess.get("target_grade") or "").strip()
    if sg and sg != grade:
        return False
    sc = _num_class(sess.get("target_class"))
    if sc and sc != _num_class(cls):
        return False
    return True


def _assert_student_session(sess: dict, username: str) -> None:
    """学生取题/提交前的范围与状态校验"""
    if (sess.get("status") or "") == "ended":
        raise HTTPException(status_code=400, detail="该练习已结束，无法继续作答或提交")
    grade, cls = _student_scope(username)
    if not _session_visible_to_student(sess, username, grade, cls):
        raise HTTPException(status_code=403, detail="该练习未分配给你")


def _user_info_map(usernames: set[str]) -> dict[str, dict[str, str]]:
    """批量取学生/教师姓名与班级(避免逐行查询)"""
    if not usernames:
        return {}
    ph = ",".join("?" for _ in usernames)
    rows = db_execute_query(
        f"SELECT username, name, grade, class FROM users WHERE username IN ({ph})",
        tuple(usernames),
    )
    out = {}
    for r in rows or []:
        out[r[0]] = {"name": (r[1] or r[0]), "grade": (r[2] or ""), "class": str(r[3] or "")}
    for u in usernames:
        out.setdefault(u, {"name": u, "grade": "", "class": ""})
    return out


def _grade_class_totals() -> tuple[dict[tuple[str, str], int], dict[str, int], int]:
    """一次统计全校学生分布: {(年级,班级): 人数}, {年级: 人数}, 总人数"""
    rows = db_execute_query("SELECT grade, class, COUNT(*) FROM users WHERE role=2 GROUP BY grade, class")
    by_gc: dict[tuple[str, str], int] = {}
    by_grade: dict[str, int] = {}
    total = 0
    for r in rows or []:
        g = (r[0] or "").strip()
        c = _num_class(r[1])
        n = r[2] or 0
        by_gc[(g, c)] = by_gc.get((g, c), 0) + n
        by_grade[g] = by_grade.get(g, 0) + n
        total += n
    return by_gc, by_grade, total


# ════════════════════════════════════════════
# 教师端
# ════════════════════════════════════════════

def _validate_generate(req: PracticeGenerateRequest, user: dict) -> tuple[str, str]:
    username = user["username"]
    if user.get("role", 2) not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可出题")
    if not req.knowledge_points.strip():
        raise HTTPException(status_code=400, detail="请输入知识点")
    if req.count < 1 or req.count > 20:
        raise HTTPException(status_code=400, detail="数量范围为 1-20")
    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")
    return username, api_key


def _norm_q_text(s: str) -> str:
    """题干归一化: 去空白/全角空格/末尾标点, 用于跨来源防重复比对"""
    import re as _re
    t = str(s or "").replace("\u3000", "")
    t = _re.sub(r"\s+", "", t)
    return t.rstrip("。．.！!？?；;，,")


def _build_generate_prompt(req: PracticeGenerateRequest, avoid_texts: list[str] | None = None) -> str:
    from backend.prompts.practice import PRACTICE_GENERATE_PROMPT
    type_desc = TYPE_DESC_MAP.get(req.question_type, "混合出题")
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(req.difficulty, "中等")
    # 注意：不注入技能 —— 技能的结构化输出指令与 JSON 格式要求冲突
    prompt = f"{build_ai_role(subject=req.subject)}\n" + PRACTICE_GENERATE_PROMPT.format(
        subject=req.subject, knowledge_points=req.knowledge_points,
        type_desc=type_desc, count=req.count, difficulty_desc=difficulty_desc,
    )
    if avoid_texts:
        lines = "\n".join(f"{i+1}. {str(t)[:40]}" for i, t in enumerate(avoid_texts[:10]))
        prompt += ("\n\n## 禁止重复的已有题目\n"
                   "以下题干已在题库中，**不要**输出与其相同或高度相似的题目"
                   "（换个角度、材料或考点侧重重新设计）：\n" + lines)
    return prompt


# 题库优先复用时的候选题型: mixed 只复用客观题+填空/简答,
# 作文/主观大题依赖上下文语境, 不做跨次随机复用
_BANK_REUSE_TYPES_MIXED = ("single", "multiple", "true_false", "short", "fill")


def _format_bank_row(r: dict) -> dict:
    """题库原始行 → 同步练习题目格式(与 AI 出题/persist 后的结构一致)"""
    qtype = r.get("type") or "single"
    answer = str(r.get("correct_answer") or "")
    if qtype in ("single", "multiple", "true_false"):
        answer = answer.strip().upper()
    opts = r.get("options") or {}
    if qtype == "true_false" and not isinstance(opts, dict):
        opts = {"A": "对", "B": "错"}
    return {
        "id": r.get("id"),
        "type": qtype,
        "question": r.get("question_text") or "",
        "options": opts if isinstance(opts, dict) else {},
        "answer": answer,
        "explanation": r.get("explanation") or "",
        "knowledge_point": r.get("knowledge_points") or "",
        "difficulty": r.get("difficulty") or "medium",
        "svg_content": r.get("svg_content") or "",
        "has_svg": r.get("has_svg") or 0,
        "media_files": r.get("media_files") or [],
        "media_placeholders": r.get("media_placeholders") or [],
        "_source": "bank",
    }


async def _compose_practice_questions(req: PracticeGenerateRequest,
                                      username: str, api_key: str) -> tuple[list[dict], str]:
    """题库优先 + AI 补足 的统一出题流程(同步/异步端点共用)。

    返回 (questions, note)。AI 题走 _persist_generated_questions 入库;
    题库题原样引用不再入库。AI 失败/无 Key 但已有题库命中 → 降级返回部分题。
    """
    from backend.question_search import query_bank_questions

    bank_qs: list[dict] = []
    if req.prefer_bank:
        types = _BANK_REUSE_TYPES_MIXED
        if req.question_type and req.question_type != "mixed":
            types = (req.question_type,) if req.question_type in _BANK_REUSE_TYPES_MIXED else ()
        if types:
            rows = query_bank_questions(
                topic=req.knowledge_points, subject=req.subject,
                question_type=req.question_type, count=req.count, types=types,
            )
            bank_qs = [_format_bank_row(r) for r in rows][: req.count]

    notes = []
    if bank_qs:
        notes.append(f"题库命中 {len(bank_qs)} 道")
    remaining = req.count - len(bank_qs)

    ai_qs: list[dict] = []
    if remaining > 0:
        if not api_key:
            if bank_qs:
                return bank_qs, "；".join(notes + ["未配置 API Key，仅返回题库匹配题"])
            raise HTTPException(status_code=400, detail="未配置 API Key，请在系统配置中设置")
        prompt = _build_generate_prompt(req, avoid_texts=[q["question"] for q in bank_qs])
        try:
            result_text = await call_ai_async(prompt, api_key)
        except Exception as e:
            if bank_qs:
                return bank_qs, "；".join(notes + [f"AI 补足失败({e})，仅返回题库题"])
            raise HTTPException(status_code=502, detail=f"AI 出题失败: {str(e)}")
        ai_qs = _parse_ai_result(result_text)
        # 与已抽题库题防重: prompt 已声明禁止, 但模型可能不遵守, 出口再拦一道
        seen = {_norm_q_text(q["question"]) for q in bank_qs}
        dedup: list[dict] = []
        for q in ai_qs:
            key = _norm_q_text(q.get("question") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            dedup.append(q)
        ai_qs = dedup[: remaining]
        if ai_qs:
            await _persist_generated_questions(ai_qs, req, username)
        if len(ai_qs) < remaining:
            notes.append(f"AI 新生成 {len(ai_qs)} 道(要求 {remaining} 道, 已尽力补足)")
        else:
            notes.append(f"AI 新生成 {len(ai_qs)} 道")

    return bank_qs + ai_qs, "；".join(notes)


async def _persist_generated_questions(questions: list[dict], req: PracticeGenerateRequest,
                                       username: str) -> list[dict]:
    """P11: 同步/异步两个出题端点共用一套入库逻辑(P10: 命中重复题时回填题库已有的图与媒体)"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for q in questions:
        q_text = (q.get("question") or "").strip()
        if not q_text:
            continue
        dup = execute_query(
            """SELECT id, svg_content, has_svg, media_files FROM question_bank
               WHERE knowledge_points LIKE ? AND question_text=? AND status='active' LIMIT 1""",
            (f"%{req.knowledge_points}%", q_text),
        )
        if dup:
            logger.info(f"跳过重复题目 (kp={req.knowledge_points}): {q_text[:40]}...")
            old = dict(dup[0])
            q["id"] = old["id"]
            q["index"] = old["id"]
            q["svg_content"] = old.get("svg_content") or ""
            q["has_svg"] = old.get("has_svg") or 0
            raw_media = old.get("media_files")
            try:
                q["media_files"] = json.loads(raw_media) if isinstance(raw_media, str) and raw_media else (raw_media or [])
            except (json.JSONDecodeError, TypeError):
                q["media_files"] = []
            continue

        opts = json.dumps(q.get("options", {}), ensure_ascii=False) if q.get("options") else ""
        svg_code = q.get("svg_code") or ""
        has_svg = 1 if svg_code.strip() else 0
        media_placeholders = json.dumps(q.get("media_placeholders") or [], ensure_ascii=False)
        qid = execute_insert(
            """INSERT INTO question_bank (type,question_text,options,correct_answer,explanation,
                knowledge_points,subject,difficulty,creator_username,source,status,created_at,updated_at,
                svg_content,has_svg,media_placeholders)
               VALUES (?,?,?,?,?,?,?,?,?,'ai','active',?,?,?,?,?)""",
            (q.get("type", "single"), q_text, opts,
             q.get("answer", ""), q.get("explanation", ""),
             # 知识点列以教师输入为准(与随堂测验入库口径一致), 否则按
             # req.knowledge_points LIKE 检索永远命中不了自己生成的题
             req.knowledge_points or q.get("knowledge_point", ""), req.subject,
             q.get("difficulty", req.difficulty), username, now, now,
             svg_code, has_svg, media_placeholders),
        )
        if qid is None:
            logger.warning(f"题目入库失败, 已跳过: {q_text[:40]}")
            continue
        q["id"] = qid
        q["index"] = qid
        # 统一字段名：AI 返回 svg_code -> 前端用 svg_content
        if "svg_code" in q and "svg_content" not in q:
            q["svg_content"] = q["svg_code"]
        if "has_svg" not in q:
            q["has_svg"] = 1 if q.get("svg_code") or q.get("svg_content") else 0

        placeholders = q.get("media_placeholders") or []
        media_files: list = []
        if placeholders and get_config_value("IMAGE_GEN_ENABLED", True):
            from backend.api.image_gen_service import generate_placeholders_batch
            from backend.config import BASE_DIR
            media_dir = BASE_DIR / "question_media" / str(qid)
            try:
                media_files = await generate_placeholders_batch(
                    placeholders=placeholders, subject=req.subject,
                    media_dir=media_dir, qid=qid, now=now,
                ) or []
                execute_update(
                    "UPDATE question_bank SET media_placeholders=?, media_files=? WHERE id=?",
                    (json.dumps(placeholders, ensure_ascii=False),
                     json.dumps(media_files, ensure_ascii=False), qid),
                )
            except Exception as gen_err:
                # 配图失败只降级为无图题, 不能让整次出题作废
                logger.warning(f"题目 {qid} 自动配图失败: {gen_err}")
        q["media_files"] = media_files
    return questions


@router.post("/generate")
async def generate_practice(req: PracticeGenerateRequest, request: Request):
    """[教师] AI 出题（同步版，仅预览不布置；建议用 /generate-async 避免长请求）"""
    user = get_current_user(request)
    username, api_key = _validate_generate(req, user)

    questions, note = await _compose_practice_questions(req, username, api_key)
    if not questions:
        raise HTTPException(status_code=502, detail="AI 返回格式异常，未能解析出题目")

    return {"questions": questions, "total": len(questions), "note": note,
            "message": f"已生成 {len(questions)} 道题"}


@router.post("/generate-async")
async def generate_practice_async(req: PracticeGenerateRequest, request: Request):
    """[教师] AI 异步出题（后台任务，不阻塞）"""
    user = get_current_user(request)
    username, api_key = _validate_generate(req, user)

    from backend.ai_task_manager import task_manager

    async def _generate_and_save() -> dict[str, Any]:
        questions, note = await _compose_practice_questions(req, username, api_key)
        if not questions:
            raise ValueError("AI 返回格式异常，未能解析出题目")
        return {"questions": questions, "total": len(questions), "note": note}

    task_id = await task_manager.create_task(
        description=f"教师 {username} 出题：{req.knowledge_points}",
        coro_factory=_generate_and_save,
    )
    return {"task_id": task_id, "message": "AI 已开始出题，请稍候..."}


@router.post("/sessions")
async def create_session(req: PracticeCreateSession, request: Request):
    """[教师] 创建练习任务并布置到班级"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可布置练习")

    if not req.title.strip():
        raise HTTPException(status_code=400, detail="请输入练习标题")
    if not req.question_ids:
        raise HTTPException(status_code=400, detail="请选择题目")

    # 题目必须存在且未被删除, 否则会布置出无法判分的练习
    qph = ",".join("?" for _ in req.question_ids)
    alive = {r["id"] for r in execute_query(
        f"SELECT id FROM question_bank WHERE id IN ({qph}) AND status='active'",
        tuple(req.question_ids),
    )}
    missing = [qid for qid in req.question_ids if qid not in alive]
    if missing:
        raise HTTPException(status_code=400, detail=f"部分题目不存在或已被删除: {missing}")

    # 分值归一, 避免 0/负分把得分率算成无穷大:
    # - 教师显式给了逐题分值 → 照用(缺的部分按 10 补, 与旧行为一致)
    # - 未指定分值 → 按题量折算, 总分恒为 100(旧实现固定每题 10 分,
    #   5 道题只有 50 分, 与考试/测验的百分制口径对不上)
    from backend.utils import distribute_scores
    if req.scores:
        scores: list[int] = []
        for i in range(len(req.question_ids)):
            raw = req.scores[i] if i < len(req.scores) else 10
            try:
                val = int(raw)
            except (TypeError, ValueError):
                val = 10
            scores.append(min(max(val, 1), 100))
    else:
        scores = distribute_scores(len(req.question_ids), 100)
    total = sum(scores)

    # 统一范围闸(与随堂测验/投票/公告共用): 教师发布范围必须落在本人任教内
    from backend.api.notification_router import validate_activity_scope
    validate_activity_scope(user, req.target_scope, req.target_grade, req.target_class,
                            req.target_users, what="同步练习")
    # 错题巩固等定向推送走 target_students 老通道, 同样校验任教范围
    if req.target_students and role != 0:
        from backend.permission_service import is_student_in_teacher_scope
        for stu in req.target_students:
            if not is_student_in_teacher_scope(stu, username):
                raise HTTPException(status_code=403, detail=f"学生 {stu} 不在您的任教范围内")

    target_students_str = json.dumps(req.target_students, ensure_ascii=False) if req.target_students else ""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    session_id = execute_insert(
        """INSERT INTO practice_sessions
           (title, knowledge_points, creator_username, subject, question_count,
            total_score, target_grade, target_class, target_students, status, created_at, updated_at,
            target_scope, target_users)
           VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?,?)""",
        (req.title.strip(), req.knowledge_points, username, req.subject,
         len(req.question_ids), total, req.target_grade, req.target_class,
         target_students_str, now, now,
         (req.target_scope or "").strip(), (req.target_users or "").strip()),
    )

    for i, qid in enumerate(req.question_ids):
        execute_insert(
            "INSERT INTO practice_session_questions (session_id, question_id, sort_order, score) VALUES (?,?,?,?)",
            (session_id, qid, i, scores[i]),
        )

    logger.info(f"教师 {username} 创建练习任务 {session_id} → {req.target_grade or '全部年级'} {req.target_class or '全部班级'}")
    return {"session_id": session_id, "message": "练习任务已发布", "total_score": total}


@router.get("/sessions")
async def list_teacher_sessions(request: Request):
    """[教师] 查看自己创建的练习任务（root 可查看全部）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 0:
        rows = execute_query('SELECT * FROM practice_sessions ORDER BY created_at DESC')
    else:
        rows = execute_query(
            'SELECT * FROM practice_sessions WHERE creator_username=? ORDER BY created_at DESC',
            (username,),
        )
    if not rows:
        return {"sessions": []}

    # P8: 提交数与姓名都改为批量查询(原来每行 3 次 SQL, 练习一多就卡)
    sids = [r["id"] for r in rows]
    sph = ",".join("?" for _ in sids)
    sub_map = {
        r["session_id"]: r["c"] for r in execute_query(
            f"SELECT session_id, COUNT(DISTINCT student_username) c FROM practice_attempts "
            f"WHERE session_id IN ({sph}) GROUP BY session_id",
            tuple(sids),
        )
    }
    creator_map = _user_info_map({r["creator_username"] for r in rows if r.get("creator_username")})

    by_gc: dict[tuple[str, str], int] = {}
    by_grade: dict[str, int] = {}
    all_students = 0
    if any(not _parse_target_students(r.get("target_students")) for r in rows):
        by_gc, by_grade, all_students = _grade_class_totals()

    sessions = []
    for r in rows:
        target_students = _parse_target_students(r.get("target_students"))
        grade = (r.get("target_grade") or "").strip()
        cls = _num_class(r.get("target_class"))
        # P3: 之前按年级布置(未指定班级)时目标人数恒为 0, 列表显示 "2/0"
        if target_students:
            student_count = len(target_students)
        elif grade and cls:
            student_count = by_gc.get((grade, cls), 0)
        elif grade:
            student_count = by_grade.get(grade, 0)
        elif cls:
            student_count = sum(n for (_g, c), n in by_gc.items() if c == cls)
        else:
            student_count = all_students

        sessions.append({
            "id": r["id"], "title": r["title"],
            "knowledge_points": r["knowledge_points"],
            "subject": r["subject"], "question_count": r["question_count"],
            "total_score": r["total_score"],
            "target_grade": r["target_grade"], "target_class": r["target_class"],
            "target_students": target_students,
            "status": r["status"],
            "source": r.get("source") or "teacher",
            "creator_name": creator_map.get(r.get("creator_username", ""), {}).get("name") or r.get("creator_username", ""),
            "student_count": student_count,
            "submitted_count": sub_map.get(r["id"], 0),
            "created_at": r["created_at"],
        })

    return {"sessions": sessions}


@router.get("/sessions/{session_id}")
async def get_session_detail(session_id: int, request: Request):
    """[教师] 查看练习详情（含提交情况与未交名单）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    # P1: 本端点含正确答案与其他学生成绩, 学生账号一律拒绝
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看练习详情")

    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")
    if role != 0 and sess["creator_username"] != username:
        raise HTTPException(status_code=403, detail="只能查看自己创建的练习")

    questions = execute_query(
        """SELECT psq.*, qb.question_text, qb.type, qb.options, qb.correct_answer,
                  qb.explanation, qb.knowledge_points,
                  qb.svg_content, qb.has_svg, qb.media_files, qb.media_placeholders
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )
    for q in questions:
        for field in ("options", "media_files", "media_placeholders"):
            if isinstance(q.get(field), str) and q.get(field):
                try:
                    q[field] = json.loads(q[field])
                except (json.JSONDecodeError, TypeError):
                    q[field] = None

    attempts = execute_query(
        'SELECT * FROM practice_attempts WHERE session_id=? ORDER BY score DESC',
        (session_id,),
    )
    target_students = _parse_target_students(sess.get("target_students"))

    # 目标学生名单(定向名单优先, 否则按年级/班级范围), 用于教师看"谁没交"
    if target_students:
        tph = ",".join("?" for _ in target_students)
        urows = db_execute_query(
            f"SELECT username, name, class FROM users WHERE role=2 AND username IN ({tph})",
            tuple(target_students),
        ) or []
    else:
        grade = (sess.get("target_grade") or "").strip()
        if grade:
            urows = db_execute_query(
                "SELECT username, name, class FROM users WHERE role=2 AND grade=?", (grade,)
            ) or []
        else:
            urows = db_execute_query(
                "SELECT username, name, class FROM users WHERE role=2"
            ) or []
        want_cls = _num_class(sess.get("target_class"))
        if want_cls:
            urows = [r for r in urows if _num_class(r[2]) == want_cls]

    info = _user_info_map({a["student_username"] for a in attempts} | {r[0] for r in urows})
    for a in attempts:
        meta = info.get(a["student_username"], {})
        a["student_name"] = meta.get("name") or a["student_username"]
        a["student_class"] = meta.get("class") or ""
        a["student_grade"] = meta.get("grade") or ""
        # S-GRADE: 把批改明细解析成结构化对象下发, 教师端才能直接渲染答卷与逐题改分
        raw = a.get("answers")
        try:
            graded = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (json.JSONDecodeError, TypeError):
            graded = {}
        if not isinstance(graded, dict):
            graded = {}
        a["graded"] = graded
        a["pending_review"] = sum(
            1 for v in graded.values() if isinstance(v, dict) and v.get("needs_review")
        )
        a["pending_ai"] = len(_pending_keys(graded))

    att_map = {a["student_username"]: a for a in attempts}
    students = [{
        "username": r[0],
        "name": r[1] or r[0],
        "grade": info.get(r[0], {}).get("grade", ""),   # S-GRADE: 教师端名册补年级
        "class": str(r[2] or ""),
        "submitted": r[0] in att_map,
        "score": att_map[r[0]]["score"] if r[0] in att_map else None,
        "total_score": att_map[r[0]]["total_score"] if r[0] in att_map else None,
        "submitted_at": att_map[r[0]]["submitted_at"] if r[0] in att_map else None,
    } for r in urows]
    students.sort(key=lambda x: (bool(x["submitted"]), _num_class(x["class"]), x["name"]))

    sess_dict = dict(sess)
    sess_dict["target_students"] = target_students

    return {
        "session": sess_dict,
        "questions": questions,
        "attempts": attempts,
        "students": students,
        # S-GRADING: 整场练习还有多少题在后台批改 / 待人工批改
        "pending_ai_total": sum(a.get("pending_ai") or 0 for a in attempts),
        "pending_review_total": sum(a.get("pending_review") or 0 for a in attempts),
    }


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: int, request: Request):
    """[教师] 删除练习任务"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")
    if role != 0 and sess["creator_username"] != username:
        raise HTTPException(status_code=403, detail="只能删除自己的练习")

    left = execute_query_one("SELECT COUNT(*) c FROM practice_attempts WHERE session_id=?", (session_id,))
    logger.info(f"删除练习 {session_id}(操作者 {username}): 连带清除 {left['c'] if left else 0} 条学生提交记录")
    execute_update("DELETE FROM practice_attempts WHERE session_id=?", (session_id,))
    execute_update("DELETE FROM practice_session_questions WHERE session_id=?", (session_id,))
    # 清理关联的积分奖励(P14: 原来用只读 helper 执行 DELETE, 事务不提交被静默回滚, 奖励记录永久残留)
    from backend.reward_engine import activity_reward_students, recompute_students
    _affected = activity_reward_students([("practice", session_id)])
    db_execute_update(
        "DELETE FROM activity_rewards WHERE activity_type='practice' AND activity_id=?",
        (str(session_id),),
    )
    execute_update("DELETE FROM practice_sessions WHERE id=?", (session_id,))
    recompute_students(_affected)          # 缺陷A：删流水必须就地重算总分
    return {"message": "已删除"}


@router.put("/sessions/{session_id}/end")
async def end_session(session_id: int, request: Request):
    """[教师] 结束练习任务（标记为结束，学生不可再提交）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")
    if role != 0 and sess["creator_username"] != username:
        raise HTTPException(status_code=403, detail="只能结束自己的练习")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update("UPDATE practice_sessions SET status='ended', updated_at=? WHERE id=?", (now, session_id))
    return {"message": "已结束"}


@router.post("/sessions/{session_id}/grade-now")
async def grade_practice_now(session_id: int, request: Request):
    """[教师] 立刻批改该练习的主观题，不等后台轮次(S-GRADING)

    走 ai_task_manager，前端用 pollAiTask 看进度；dedupe_key 保证连点/刷新不会重复评。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可发起批改")
    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")
    if role != 0 and sess["creator_username"] != username:
        raise HTTPException(status_code=403, detail="只能批改自己布置的练习")

    pend = execute_query(
        "SELECT COUNT(*) c FROM practice_attempts WHERE session_id=? AND ai_pending=1",
        (session_id,),
    )
    if not pend or not pend[0]["c"]:
        return {"task_id": "", "message": "没有待批改的主观题", "pending_sessions": 0}

    from backend.ai_grading import drain_async
    from backend.ai_task_manager import task_manager

    task_id = await task_manager.create_task(
        description=f"同步练习 #{session_id} 主观题批改",
        coro_factory=lambda: drain_async(only_source="practice", only_activity=str(session_id)),
        owner_username=username,
        dedupe_key=f"practice-grade:{session_id}",
    )
    return {"task_id": task_id, "message": "批改已开始", "pending_sessions": pend[0]["c"]}


@router.post("/review")
async def review_practice_attempt(req: PracticeReviewRequest, request: Request):
    """[教师] 复核练习批改结果：逐题改分/补评语，或直接改总分(S-GRADE)

    练习此前「AI 判完即定稿」，误判无人可纠；本接口对齐考试模块的复核链路
    (exam_router: POST /review)。改分后逐题 score 覆盖、graded_by 记为 teacher、
    该题撤销 needs_review，attempt.score 按新逐题分重算；学生端刷新即见最终分。

    注意：积分奖励与错题本按提交当时的判定生成，复核改分不自动回滚(与考试模块一致)。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可复核批改")

    attempt = execute_query_one("SELECT * FROM practice_attempts WHERE id=?", (req.attempt_id,))
    if not attempt:
        raise HTTPException(status_code=404, detail="答题记录不存在")
    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (attempt["session_id"],))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")
    if role != 0 and sess["creator_username"] != username:
        raise HTTPException(status_code=403, detail="只能复核自己布置的练习")

    answers = attempt.get("answers")
    if isinstance(answers, str):
        try:
            answers = json.loads(answers)
        except (json.JSONDecodeError, TypeError):
            answers = {}
    if not isinstance(answers, dict):
        answers = {}

    touched = False
    for qid, new_score in (req.question_scores or {}).items():
        one = answers.get(str(qid))
        if not isinstance(one, dict):
            continue
        try:
            val = max(0.0, float(new_score))
        except (TypeError, ValueError):
            continue
        mx = float(one.get("max_score") or 0)
        if mx:
            val = min(val, mx)                      # 逐题改分不得越过该题满分
        one["score"] = round(val, 1)
        one["is_correct"] = one["score"] >= mx * 0.6
        one["teacher_adjusted"] = True
        one["graded_by"] = "teacher"
        one["grading"] = "graded"          # 教师已定分, 不再进后台批改队列
        one.pop("needs_review", None)
        touched = True

    for qid, comment in (req.question_comments or {}).items():
        one = answers.get(str(qid))
        if isinstance(one, dict):
            one["teacher_comment"] = str(comment or "").strip()[:1000]
            touched = True

    if not touched and req.teacher_score is None and not (req.teacher_comment or "").strip():
        raise HTTPException(status_code=400, detail="没有需要保存的修改")

    final_score = attempt.get("score") or 0
    if touched:
        final_score = round(sum(
            float(v.get("score") or 0) for v in answers.values() if isinstance(v, dict)
        ), 1)
    if req.teacher_score is not None:
        final_score = round(max(float(req.teacher_score), 0), 1)

    # S-GRADING: 本次复核前该答卷是否还有题在后台队列里(决定要不要补结算)
    was_pending = bool(attempt.get("ai_pending"))

    # status 保持 submitted 不动：活动监测/仪表盘的参与人数按 status='submitted' 统计
    updates = ["teacher_reviewed = 1", "graded_by = ?", "ai_pending = ?"]
    params: list[Any] = [username, 1 if _pending_keys(answers) else 0]
    if req.teacher_score is not None:
        updates.append("teacher_score = ?")
        params.append(final_score)
    if req.teacher_comment is not None:
        updates.append("teacher_comment = ?")
        params.append(req.teacher_comment.strip()[:2000])
    if touched or req.teacher_score is not None:
        updates += ["score = ?", "answers = ?"]
        params += [final_score, json.dumps(answers, ensure_ascii=False)]
    params.append(attempt["id"])
    execute_update(f"UPDATE practice_attempts SET {', '.join(updates)} WHERE id=?", tuple(params))

    # 教师把最后一题定分时, 补做积分与错题本结算(与后台批改器同一入口)。
    # 只在「原本挂在后台待批改」时补一次; 平时改分不再重复结算, 免得错题次数与积分重复累加。
    if was_pending and not _pending_keys(answers):
        try:
            again = execute_query_one("SELECT * FROM practice_attempts WHERE id=?", (attempt["id"],))
            if again:
                _settle_practice_attempt(again)
        except Exception as settle_err:
            logger.warning(f"练习结算失败 attempt={req.attempt_id}: {settle_err}")

    logger.info(f"教师 {username} 复核练习成绩 attempt={req.attempt_id}: "
                f"{attempt.get('score')} → {final_score}")
    return {
        "message": "已保存批改",
        "attempt_id": attempt["id"],
        "score": final_score,
        "total_score": attempt.get("total_score") or 0,
        "teacher_reviewed": 1,
        "results": answers,
    }


# ════════════════════════════════════════════
# 学生端
# ════════════════════════════════════════════

# ════════════════════════════════════════════
# 学生端
# ════════════════════════════════════════════

@router.get("/my-sessions")
async def list_my_practices(request: Request):
    """[学生] 查看分配给自己的练习任务"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role != 2:
        # 教师/管理员查看自己布置的练习
        return await list_teacher_sessions(request)

    grade, cls = _student_scope(username)

    # P9: 可见性只由 target_* 决定。旧实现额外要求"发布者必须是本班教师或管理员",
    #     导致①任教该课程但未列该班的教师发的年级练习学生永远看不到;
    #     ②系统自动生成的错题巩固练习(creator=system)学生看不到。
    rows = execute_query(
        """SELECT ps.*,
                  (SELECT COUNT(*) FROM practice_attempts pa
                    WHERE pa.session_id = ps.id AND pa.student_username = ?) AS attempted
           FROM practice_sessions ps
           WHERE ps.status = 'active'
             AND (
               (COALESCE(ps.target_students, '') <> '' AND ps.target_students LIKE ?)
               OR
               (COALESCE(ps.target_students, '') = ''
                 AND (
                   COALESCE(ps.target_scope, '') <> ''
                   OR COALESCE(ps.target_grade, '') = ''
                   OR ps.target_grade = ?
                   OR ps.target_grade LIKE ?
                 ))
             )
           ORDER BY ps.created_at DESC""",
        (username, f'%"{username}"%', grade, f"%{grade}%"),
    )
    # 精确判定(班级归一化 + 定向名单成员), SQL 只做粗筛
    visible = [r for r in rows if _session_visible_to_student(r, username, grade, cls)]
    creator_map = _user_info_map({r["creator_username"] for r in visible if r.get("creator_username")})

    result = []
    for s_ in visible:
        result.append({
            "id": s_["id"], "title": s_["title"],
            "knowledge_points": s_["knowledge_points"],
            "subject": s_["subject"], "question_count": s_["question_count"],
            "total_score": s_["total_score"],
            "creator_name": creator_map.get(s_.get("creator_username", ""), {}).get("name") or s_.get("creator_username", ""),
            "source": s_.get("source") or "teacher",
            "attempted": bool(s_["attempted"]),
            "created_at": s_["created_at"],
        })

    return {"sessions": result}


def _existing_attempt_payload(existing: dict) -> dict:
    """已提交记录 → 与首次提交同构的返回体(避免并发时重复判分)"""
    raw = existing.get("answers")
    try:
        graded = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (json.JSONDecodeError, TypeError):
        graded = {}
    if not isinstance(graded, dict):
        graded = {}
    tot = max(existing.get("total_score") or 0, 1)
    pending = _pending_keys(graded)
    return {
        "score": existing.get("score") or 0,
        "total_score": existing.get("total_score") or 0,
        "accuracy": round((existing.get("score") or 0) / tot * 100, 1),
        "results": graded,
        "submitted_at": existing.get("submitted_at"),
        "pending_ai": len(pending),
        "note": "你已提交过此练习，以下是已有成绩",
        "reward_note": ("主观题批改中，成绩与积分稍后更新" if pending else "积分奖励已发放"),
    }


@router.get("/my-sessions/{session_id}")
async def get_my_practice(session_id: int, request: Request):
    """[学生] 获取练习题目（开始答题）"""
    user = get_current_user(request)
    username = user["username"]

    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")

    # 检查是否已提交
    existing = execute_query_one(
        "SELECT * FROM practice_attempts WHERE session_id=? AND student_username=?",
        (session_id, username),
    )
    if existing:
        # 已提交过 → 直接返回结果（练习结束后仍可查看成绩）
        return await _get_practice_result(session_id, username)

    # P2/P4: 未分配给该生或已结束的练习不允许再开始作答
    _assert_student_session(sess, username)

    questions = execute_query(
        """SELECT psq.id as eq_id, psq.sort_order, psq.score,
                  qb.id, qb.type, qb.question_text, qb.options, qb.difficulty,
                  qb.svg_content, qb.has_svg, qb.media_files
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )
    for q in questions:
        for field in ("options", "media_files"):
            raw = q.get(field)
            if isinstance(raw, str) and raw.strip():
                try:
                    q[field] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    q[field] = None
            elif not raw:
                q[field] = [] if field == "media_files" else None

    sess_dict = dict(sess)
    sess_dict.pop("target_students", None)  # 不把其他学生名单下发给个人

    return {"session": sess_dict, "questions": questions}


@router.post("/my-sessions/{session_id}/submit")
async def submit_practice(session_id: int, req: PracticeSubmitRequest, request: Request):
    """[学生] 提交练习答案"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可提交")

    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not sess:
        raise HTTPException(status_code=404, detail="练习不存在")

    # 防重复提交 — 如已提交，直接返回已有成绩
    existing = execute_query_one(
        "SELECT * FROM practice_attempts WHERE session_id=? AND student_username=?",
        (session_id, username),
    )
    if existing:
        return _existing_attempt_payload(existing)

    # P2/P4: 练习必须仍在进行且确实分配给了该生(否则可枚举 session 刷参与积分)
    _assert_student_session(sess, username)

    questions = execute_query(
        """SELECT qb.id, qb.type, qb.correct_answer, qb.question_text, psq.score
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )
    if not questions:
        raise HTTPException(status_code=400, detail="该练习没有可作答的题目")

    total = 0
    earned = 0.0
    graded: dict[str, Any] = {}
    student_answers = req.answers or {}

    def _ans_of(qid: Any) -> str:
        v = student_answers.get(str(qid), "")
        return "" if v is None else str(v)

    # P5: 主观题一律要有人批改; S-FILL: 填空题先走「逐空精确比对」, 判不准才降级 AI
    subj_questions = [q for q in questions if q["type"] in AI_GRADED_TYPES]
    fill_questions = [q for q in questions if q["type"] in FILL_TYPES]
    obj_questions = [q for q in questions
                     if q["type"] not in AI_GRADED_TYPES and q["type"] not in FILL_TYPES]

    def _keyword_fallback(q: dict, student_ans: str) -> dict:
        """[S-GRADING] AI 不可用 / 调用失败时的兜底判分。

        旧实现是「参考答案按逗号切词 + 任一命中即给满分」, 实测题库 56 道主观题里 42 道
        切出来的是 15~69 字的整段文本(必然命中不了) → 答对也给 0 分; 而填空答案 "2" 会被
        学生答案 "12" 子串命中 → 答错反而给满分。现改为按要点命中比例给分, 且切不出可比对
        要点时不猜分, 标 needs_review 交给教师批改(而不是把 0 分伪装成「已判错」)。
        """
        correct = str(q["correct_answer"] or "")
        q_score = float(q["score"] or 10)
        base = {"student_answer": student_ans, "correct_answer": correct, "max_score": q_score}
        points = [pt for pt in _split_points(correct) if len(pt) <= MAX_POINT_LEN]
        if not points:
            return {**base, "score": 0, "is_correct": False, "graded_by": "none",
                    "needs_review": True,
                    "feedback": "参考答案为主观描述，系统无法自动判分，已标记待教师批改。"}
        norm, nums = _norm_text(student_ans), _num_tokens(student_ans)
        hits = sum(1 for pt in points if _point_hit(pt, norm, nums))
        return {**base,
                "score": _ratio_score(q_score, hits, len(points)),
                "is_correct": hits == len(points),
                "graded_by": "keyword",
                "needs_review": True,
                "feedback": f"系统按要点批改（命中 {hits}/{len(points)}），建议教师复核。"}

    # 客观题：归一化后精确匹配(P7: 多选 AC 与 CA 等价)
    for q in obj_questions:
        qid = str(q["id"])
        student_ans = _ans_of(q["id"])
        correct = q["correct_answer"] or ""
        q_score = q["score"] or 10
        is_correct = _is_correct_objective(student_ans, correct)
        earned += q_score if is_correct else 0
        total += q_score
        graded[qid] = {
            "student_answer": student_ans, "correct_answer": correct,
            "score": q_score if is_correct else 0, "max_score": q_score,
            "is_correct": is_correct, "graded_by": "exact",
        }

    # 填空题：规则判分优先, 判不准的并入 AI 批改队列
    ai_questions = list(subj_questions)
    for q in fill_questions:
        one = _grade_fill_by_rule(q, _ans_of(q["id"]))
        if one is None:
            ai_questions.append(q)
            continue
        graded[str(q["id"])] = one
        earned += one["score"]
        total += one["max_score"]

    # 主观题：S-GRADING —— 不在提交请求里等 AI，改由后台批改器按题合并批量评分
    pending_ai = 0
    if ai_questions:
        api_key, _ = get_api_keys(username)
        if (api_key or "").strip():
            for q in ai_questions:
                qid = str(q["id"])
                q_max = float(q["score"] or 10)
                graded[qid] = {
                    "student_answer": _ans_of(q["id"]),
                    "correct_answer": q["correct_answer"] or "",
                    "score": 0,
                    "max_score": q_max,
                    "is_correct": False,
                    "grading": "pending",       # 待后台批改
                    "graded_by": "queued",
                    "feedback": "",
                }
                total += q_max                  # 满分照常计入, 得分率才有意义
            pending_ai = len(ai_questions)
        else:
            # 没配 AI Key: 当场按要点兜底并标「待教师批改」, 不占用后台队列
            for q in ai_questions:
                qid = str(q["id"])
                one = _keyword_fallback(q, _ans_of(q["id"]))
                graded[qid] = one
                earned += one["score"]
                total += one["max_score"]

    earned = round(earned, 2)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        execute_insert(
            """INSERT INTO practice_attempts (session_id, student_username, answers, score, total_score,
                       status, submitted_at, ai_pending)
               VALUES (?,?,?,?,?,'submitted',?,?)""",
            (session_id, username, json.dumps(graded, ensure_ascii=False), earned, total, now,
             1 if pending_ai else 0),
        )
    except sqlite3.IntegrityError:
        # P6: 并发重复提交撞上唯一约束 → 返回既有成绩, 不再 500 丢学生答案
        again = execute_query_one(
            "SELECT * FROM practice_attempts WHERE session_id=? AND student_username=?",
            (session_id, username),
        )
        if again:
            logger.info(f"学生 {username} 重复提交练习 {session_id}, 返回既有成绩")
            return _existing_attempt_payload(again)
        raise

    # ── 结算：参与分与成绩无关, 当场发; 错题本与等级积分等判分完整再结算 ──
    if not pending_ai:
        # W7: 练习错题不再漏记（含主观题的答卷由后台批改器调用同一套结算）
        try:
            _settle_practice_attempt({
                "session_id": session_id, "student_username": username,
                "answers": json.dumps(graded, ensure_ascii=False),
                "score": earned, "total_score": total,
            })
        except Exception as wb_err:
            logger.warning(f"练习结算失败 (user={username}, session={session_id}): {wb_err}")
            logger.warning(traceback.format_exc())

    try:
        from backend.reward_engine import award_participation
        sess_title = sess.get("title", "") or f"练习#{session_id}"
        award_participation(username, "practice", str(session_id), sess_title)
    except Exception as rw_err:
        logger.warning(f"练习参与积分发放失败 (user={username}, session_id={session_id}): {rw_err}")

    logger.info(f"学生 {username} 提交练习 {session_id}: {earned}/{total}")
    return {
        "score": earned, "total_score": total,
        "accuracy": round(earned / max(total, 1) * 100, 1),
        "results": graded,
        "pending_ai": pending_ai,          # >0 表示还有主观题在后台批改
        "reward_note": ("主观题批改中，成绩与积分稍后更新" if pending_ai else "积分奖励已发放"),
    }


async def _get_practice_result(session_id: int, username: str) -> dict[str, Any]:
    """获取已提交的练习结果"""
    attempt = execute_query_one(
        "SELECT * FROM practice_attempts WHERE session_id=? AND student_username=?",
        (session_id, username),
    )
    sess = execute_query_one("SELECT * FROM practice_sessions WHERE id=?", (session_id,))
    if not attempt or not sess:
        raise HTTPException(status_code=404, detail="练习或提交记录不存在")

    answers_data = attempt["answers"]
    try:
        answers_data = json.loads(answers_data) if isinstance(answers_data, str) else (answers_data or {})
    except (json.JSONDecodeError, TypeError):
        answers_data = {}
    if not isinstance(answers_data, dict):
        answers_data = {}

    questions = execute_query(
        """SELECT qb.id, qb.question_text, qb.type, qb.explanation, psq.score,
                  qb.svg_content, qb.has_svg, qb.media_files
           FROM practice_session_questions psq
           JOIN question_bank qb ON qb.id = psq.question_id
           WHERE psq.session_id=? ORDER BY psq.sort_order""",
        (session_id,),
    )

    results = []
    for q in questions:
        qid = str(q["id"])
        ans = answers_data.get(qid)
        # 题目在练习中被删等异常情况下也要有完整字段, 避免前端渲染 undefined
        one = {
            "student_answer": "", "correct_answer": "",
            "score": 0, "max_score": q.get("score") or 0, "is_correct": False,
        }
        if isinstance(ans, dict):
            one.update(ans)
        media = q.get("media_files")
        if isinstance(media, str) and media:
            try:
                media = json.loads(media)
            except (json.JSONDecodeError, TypeError):
                media = []
        results.append({
            "question_id": q["id"],
            "question_text": q["question_text"],
            "type": q["type"],
            "explanation": q.get("explanation", ""),
            "svg_content": q.get("svg_content", ""),
            "has_svg": q.get("has_svg", 0),
            "media_files": media or [],
            **one,
        })

    sess_dict = dict(sess)
    sess_dict.pop("target_students", None)

    return {
        "session": sess_dict,
        "attempt": {
            "score": attempt["score"],
            "total_score": attempt["total_score"],
            "accuracy": round((attempt["score"] or 0) / max(attempt["total_score"] or 0, 1) * 100, 1),
            "submitted_at": attempt["submitted_at"],
            # S-GRADING: 还有几题在后台批改(前端据此显示「AI 批改中」并自动刷新)
            "pending_ai": len(_pending_keys(answers_data)),
            "teacher_reviewed": attempt.get("teacher_reviewed") or 0,
        },
        "results": results,
    }


# ── 共享工具 ──

def _parse_ai_result(text: str) -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 题目列表（含条目校验 + 失败诊断日志）"""
    data = extract_json_from_text(text)
    if isinstance(data, dict):
        # 兼容 {"questions": [...]} 包装; 单个题目对象直接包成列表
        inner = data.get("questions")
        if isinstance(inner, list):
            data = inner
        elif "question" in data:
            data = [data]
        else:
            data = None
    if not isinstance(data, list):
        data = []
    valid: list[dict[str, Any]] = []
    for q in data:
        if not isinstance(q, dict):
            continue
        if not str(q.get("question") or "").strip():
            continue
        # 截断挽救出来的半道题可能缺 answer/options —— 缺了会判不了分, 丢弃
        if not str(q.get("answer") or "").strip():
            continue
        if q.get("type") in ("single", "multiple", "true_false") and not q.get("options"):
            continue
        valid.append(q)
    if not valid:
        head = (text or "")[:400].replace("\n", "⏎")
        logger.warning(f"[同步练习] AI 出题解析失败, 原始返回({len(text or '')}字符)头部: {head}")
    return valid


# ════════════════════════════════════════════════════════════
# S-GRADING: 主观题「后台批量批改」适配（引擎见 backend/ai_grading.py）
#   提交时: 客观题当场判, 主观题写 grading='pending' + ai_pending=1
#   引擎按题合并多份答案一次 AI 调用, 判完写回并补做积分/错题本结算
# ════════════════════════════════════════════════════════════

# _pending_keys 直接复用引擎里的 pending_keys(判据只有一份)
_pending_keys = pending_keys


def _settle_practice_attempt(attempt: dict[str, Any]) -> dict[str, Any]:
    """一份练习答卷判分完毕后的结算：等级积分 + 错题本（幂等，可重复调用）

    有主观题待批改时不在提交请求里结算，否则会出现"按 0 分进错题本、少发一档积分，
    几十秒后又变了"的脏账。参与分(award_participation)与成绩无关，仍在提交当场发。
    """
    sid = attempt["session_id"]
    username = attempt["student_username"]
    try:
        graded = json.loads(attempt.get("answers") or "{}")
    except (json.JSONDecodeError, TypeError):
        graded = {}
    if not isinstance(graded, dict):
        graded = {}
    earned = float(attempt.get("score") or 0)
    total = float(attempt.get("total_score") or 0)
    sess = execute_query_one("SELECT title FROM practice_sessions WHERE id=?", (sid,))
    title = (sess or {}).get("title") or f"练习#{sid}"

    try:
        from backend.api.wrong_book_router import (
            mark_wrong_mastered, record_wrong_answers, check_and_auto_generate_wrong_practice,
        )
        correct = {k: v for k, v in graded.items() if isinstance(v, dict) and v.get("is_correct")}
        wrong = {k: v for k, v in graded.items() if isinstance(v, dict) and not v.get("is_correct")}
        if correct:
            mark_wrong_mastered(username, correct)
        if wrong:
            record_wrong_answers(username, sid, wrong, source="practice")
        _spawn_bg(check_and_auto_generate_wrong_practice, username)
    except Exception as wb_err:
        logger.warning(f"练习错题本结算失败 (user={username}, session={sid}): {wb_err}")

    try:
        from backend.reward_engine import award_grade
        award_grade(username, "practice", str(sid), earned, total, title)
    except Exception as rw_err:
        logger.warning(f"练习等级积分结算失败 (user={username}, session={sid}): {rw_err}")
    return {"settled": True, "score": earned, "total": total}


def _practice_fetch_jobs(limit: int) -> list[GradingJob]:
    """取待批改的主观题作业（含题面/参考答案/满分，供批量评分拼 prompt）"""
    rows = execute_query(
        """SELECT id, session_id, student_username, answers
           FROM practice_attempts WHERE ai_pending=1 ORDER BY submitted_at LIMIT ?""",
        (limit,),
    )
    jobs: list[GradingJob] = []
    qcache: dict[int, dict[str, dict[str, Any]]] = {}
    for r in rows or []:
        aid, sid, stu, raw = r["id"], r["session_id"], r["student_username"], r["answers"]
        try:
            graded = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (json.JSONDecodeError, TypeError):
            graded = {}
        if not isinstance(graded, dict):
            graded = {}
        pend = _pending_keys(graded)
        if not pend:
            execute_update("UPDATE practice_attempts SET ai_pending=0 WHERE id=?", (aid,))
            continue
        if sid not in qcache:
            qcache[sid] = {
                str(q["id"]): q for q in execute_query(
                    """SELECT qb.id, qb.type, qb.question_text, qb.correct_answer, psq.score
                       FROM practice_session_questions psq
                       JOIN question_bank qb ON qb.id = psq.question_id
                       WHERE psq.session_id=?""",
                    (sid,),
                )
            }
        for key in pend:
            q = qcache[sid].get(str(key))
            if not q:      # 题目已被删, 直接转人工, 别在队列里空转
                _force_review_keys(aid, [key], "题目已从练习中移除，无法自动批改。")
                continue
            jobs.append(GradingJob(
                source="practice", attempt_id=aid, entry_key=str(key), student_username=stu,
                activity_id=str(sid),
                question_text=str(q.get("question_text") or ""),
                ref_answer=str(q.get("correct_answer") or ""),
                max_score=float(q.get("score") or 10),
                answer_text=str((graded.get(key) or {}).get("student_answer") or ""),
                mode="essay" if q.get("type") in ("essay", "subjective") else "short",
            ))
        if len(jobs) >= limit:
            break
    return jobs


def _force_review_keys(attempt_id: int, keys: list[str], reason: str) -> None:
    """判不了的题直接标记待教师批改（并清掉 pending，避免队列死循环）"""
    with get_connection() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT answers FROM practice_attempts WHERE id=?", (attempt_id,)).fetchone()
        if not row:
            conn.execute("COMMIT")
            return
        try:
            graded = json.loads(row["answers"]) if isinstance(row["answers"], str) else (row["answers"] or {})
        except (json.JSONDecodeError, TypeError):
            graded = {}
        if not isinstance(graded, dict):
            graded = {}
        for k in keys:
            one = graded.get(k)
            if isinstance(one, dict):
                one["grading"] = "review"
                one["needs_review"] = True
                one["graded_by"] = "none"
                one["feedback"] = reason
        still = _pending_keys(graded)
        conn.execute("UPDATE practice_attempts SET answers=?, ai_pending=? WHERE id=?",
                     (json.dumps(graded, ensure_ascii=False), 1 if still else 0, attempt_id))
        conn.execute("COMMIT")


def _practice_save_batch(attempt_id: int, items: list[tuple[GradingJob, dict[str, Any]]]) -> None:
    """读-改-写一份答卷（BEGIN IMMEDIATE 与教师复核互斥；题态已变的条目不覆盖）"""
    with get_connection() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT answers, total_score FROM practice_attempts WHERE id=?", (attempt_id,)
        ).fetchone()
        if not row:
            conn.execute("COMMIT")
            return
        try:
            graded = json.loads(row["answers"]) if isinstance(row["answers"], str) else (row["answers"] or {})
        except (json.JSONDecodeError, TypeError):
            graded = {}
        if not isinstance(graded, dict):
            graded = {}
        for job, res in items:
            one = graded.get(job.entry_key)
            if not isinstance(one, dict) or one.get("grading") != "pending":
                continue            # 教师已改/已被别的轮次写回 → 不覆盖
            review = bool(res.get("needs_review"))
            one["grading"] = "review" if review else "graded"
            one["score"] = float(res.get("score") or 0)
            one["max_score"] = job.max_score
            one["is_correct"] = bool(res.get("is_correct"))
            one["graded_by"] = str(res.get("graded_by") or "ai")
            note = str(res.get("feedback") or res.get("comment") or "")[:600]
            if note:
                one["feedback"] = note
            if res.get("comment"):
                one["comment"] = str(res["comment"])[:600]
            for extra in ("dimensions", "overall_comment", "improvement_suggestions",
                          "key_points_hit", "key_points_missed"):
                if res.get(extra):
                    one[extra] = res[extra]
            if review:
                one["needs_review"] = True
            else:
                one.pop("needs_review", None)
        earned = round(sum(float(v.get("score") or 0) for v in graded.values() if isinstance(v, dict)), 1)
        still = _pending_keys(graded)
        conn.execute(
            "UPDATE practice_attempts SET answers=?, score=?, ai_pending=? WHERE id=?",
            (json.dumps(graded, ensure_ascii=False), earned, 1 if still else 0, attempt_id),
        )
        conn.execute("COMMIT")


def _practice_finalize_if_done(attempt_id: int) -> None:
    """该份答卷全部判完 → 补做积分与错题本结算"""
    attempt = execute_query_one("SELECT * FROM practice_attempts WHERE id=?", (attempt_id,))
    if not attempt or attempt.get("ai_pending"):
        return
    _settle_practice_attempt(attempt)


register_source(SourceAdapter(
    source="practice",
    label="同步练习",
    fetch_jobs=_practice_fetch_jobs,
    save_batch=_practice_save_batch,
    finalize_if_done=_practice_finalize_if_done,
))
