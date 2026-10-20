# -*- coding: utf-8 -*-
"""
课堂互动 API 路由
随堂测验、快速投票、课堂提问
"""
import asyncio
import traceback
import json
import random
import re
import hashlib
import sqlite3
import time
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from backend.api.dependencies import get_current_user
from backend.text_utils import clip
from backend.database import (
    execute_query, execute_insert_update, execute_batch, execute_query_dict,
    get_connection as db_get_connection,
)
# S-GRADING(P3): 主观题后台批量批改引擎 + 共用判分规则
from backend.ai_grading import GradingJob, SourceAdapter, register_source, pending_keys
from backend.grading_rules import keyword_fallback
# P0-2: 测验判分/统计口径收敛到 backend.quiz_stats (唯一实现), 本模块只保留别名
from backend.quiz_stats import (
    quiz_graded as _quiz_graded,
    quiz_questions as _quiz_questions,
    quiz_total as _quiz_total,
    centesimal as _centesimal,
    quiz_subjects as _quiz_subjects,
    normalize_quiz_scores,
    answer_index_map as _answer_index_map,
    is_question_correct as _is_question_correct,
    split_answers as _split_answers,
    build_question_stats as _build_question_stats,
)
from backend.logger import logger
from backend.prompts import apply_skills, build_ai_role
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_async
from backend.utils import extract_json_from_text
from backend.question_db import execute_update as qb_execute_update
from backend.config import BASE_DIR
from backend.permission_service import get_user_grade_class, check_activity_visibility
from backend.question_ws import ADMIN_ROOM, class_room, question_ws

router = APIRouter()


# ── 请求模型 ──

class QuizCreate(BaseModel):
    title: str
    description: str = ""
    questions: str  # JSON 字符串 [{type, question, options, answer, score}]
    subject: str = ""      # 学科（AI 建测验的弹窗里选的那个，落库后活动监控/列表才显示得出科目）
    knowledge_points: str = ""   # 知识点（AI 弹窗的"主题"即知识点；手动建卷也可填）
    target_scope: str = "teacher_classes"
    target_grade: str = ""
    target_class: str = ""
    target_users: str = ""
    # R2(Step B): True=由后端把各题分值折算成合计 100(教师没手工配分值时)
    auto_scores: bool = True
    # 立即发布：默认 False=存为草稿（与考试「新建即草稿」一致），
    # 老师在列表里点「发布」才对学生开放；显式传 true 才会创建即进行中
    publish: bool = False


class QuizAnswerSubmit(BaseModel):
    answers: str  # JSON 字符串 [{question_index, answer}]


class PollCreate(BaseModel):
    question: str
    options: list[str]
    poll_type: str = "single"  # single / multiple
    subject: str = ""          # 学科（投票创建弹窗里选的，落库后活动监控/列表才显示得出科目）
    target_scope: str = "teacher_classes"
    target_grade: str = ""
    target_class: str = ""
    target_users: str = ""


class QuestionCreate(BaseModel):
    content: str = Field(min_length=1, max_length=500)
    is_anonymous: bool = False
    subject: str = Field(default="", max_length=50)
    knowledge_point: str = Field(default="", max_length=100)
    # 前端每次提问生成、失败重试复用；后端据此做幂等，避免网络重试重复入库
    client_request_id: str | None = Field(default=None, max_length=64)


class QuestionAnswer(BaseModel):
    answer: str


class QuestionPin(BaseModel):
    pinned: bool = True


class QuestionFeature(BaseModel):
    featured: bool = True


class QuestionResolve(BaseModel):
    resolved: bool = True


class QuestionFollowupCreate(BaseModel):
    content: str = Field(min_length=1, max_length=500)


class AiGenerateQuiz(BaseModel):
    topic: str
    subject: str = ""  # 由前端传递
    count: int = 5
    question_type: str = "single"  # single / true_false / mixed


class AiGeneratePoll(BaseModel):
    topic: str
    option_count: int = 4


# ── AI 辅助函数 ──

def _call_ai(prompt: str) -> str:
    """调用 AI（非流式）- 支持智能体/直接调大模型双模式"""
    from backend.api.chat_router import get_api_keys
    api_key, _ = get_api_keys("")
    if not api_key:
        return "⚠️ AI 功能不可用：请配置 DashScope API Key"

    from backend.api.ai_service import call_ai_sync
    try:
        return call_ai_sync(prompt, api_key, use_kb=False)
    except Exception as e:
        return f"AI 调用出错: {str(e)}"


# ── 从题库搜索题目 ──


def _search_questions_from_bank(
    topic: str,
    subject: str,
    question_type: str,
    count: int,
    exclude_ids: tuple[int, ...] | list[int] = (),
) -> list[dict[str, Any]]:
    """从学科题库（question_bank）搜索匹配的题目，返回与 AI 出题一致的格式。

    查询逻辑已上移到 backend.question_search（同步练习共用），
    这里只做展示层转换：options dict -> "A. 文本" 数组、判断题固定选项等。

    exclude_ids：本次已经出过的题（课堂抽问连续出题时防重复），透传给 question_select。
    """
    from backend.question_search import query_bank_questions

    rows = query_bank_questions(topic, subject, question_type, count, exclude_ids=exclude_ids)

    questions = []
    for r in rows:
        opts = r.get("options") or {}

        # 将选项对象 {"A": "文本"} 转为数组格式 ["A. 文本"]
        opt_array: list[str] = []
        if isinstance(opts, dict):
            for key in sorted(opts.keys()):
                label = str(key).strip().upper()
                text = str(opts[key]).strip()
                # 避免重复前缀
                if text.startswith(f"{label}.") or text.startswith(f"{label}、"):  # type: ignore[union-attr]
                    opt_array.append(text)
                else:
                    opt_array.append(f"{label}. {text}")
        elif isinstance(opts, list):
            opt_array = [str(o) for o in opts]

        # 判断题固定选项
        if r.get("type") == "true_false":
            opt_array = ["对", "错"]

        questions.append({
            "id": r.get("id"),
            "type": r.get("type", "single"),
            "question": r.get("question_text", ""),
            "options": opt_array,
            "answer": (r.get("correct_answer") or "").strip().upper(),
            "explanation": r.get("explanation") or "",
            "score": 1,
            "svg_code": r.get("svg_content") or "",
            "svg_content": r.get("svg_content") or "",
            "has_svg": r.get("has_svg") or 0,
            "media_files": r.get("media_files") or "",
            "media_placeholders": r.get("media_placeholders") or "",
            "_source": "bank",
        })

    return questions


async def _persist_quiz_ai_questions(questions: list[dict[str, Any]], *, topic: str,
                                     subject: str, username: str,
                                     now: str) -> list[dict[str, Any]]:
    """随堂测验 AI 补题的入库：收敛到 backend.question_factory（题目入库唯一出口）。

    原地把 id / media_files 写回输入对象（前端按条渲染），并**返回过滤后的可答题列表**：
    被剔掉的条目必须从返回值里消失，否则前端会渲染出一道没有 id、判不了分的幽灵题
    （同步练习那条路径踩过，见 cac1a84）。

    与旧实现的差异（都是往统一口径靠，没有任何放宽）：
      · 判重口径不变 —— 旧代码本来就在用 question_select.find_duplicate_question
        （学科族 + 题型 + 规范化题干），现在直接复用 factory 里的同一份调用。
      · 新增入库前体检：缺答案、答案越界、选项不足 2 个的模型输出不再进题库。
      · 新增连教材知识点边：旧实现从来不连，于是随堂测验生成的题下次仍走不到 T0、
        还要再烧一次 AI；命中已有题也补边（老题只有连上边才进得了候选池）。
      · 判断题的选项与答案对齐：旧实现强制选项 {"A":"对","B":"错"}，却把模型写的
        "正确/错误"原样存进答案列，两边对不上，判分必然判错；现在按选项文字归一成
        库内约定的「对/错」，并且保留模型真正给出的选项文字。
      · 题型仍以模型输出为准 —— 本站"混合出题"是一等选项，不能像课程练习那样强制
        single；但未知题型（'choice' 这类）会收敛成 single，不再把脏值写进库。
      · 整批一个事务，中途失败全部回滚（旧实现逐条写，崩在半路会留下半套题）；
        生图与连边都放在提交之后，绝不按住数据库写锁去等外部 HTTP。
    """
    from backend import question_factory

    outcome = question_factory.persist_questions(
        questions,
        subject=subject,
        source="ai",
        username=username,
        knowledge_points=topic,
        difficulty="medium",
        link_duplicates=True,
        write_creator_name=False,
    )
    stats = outcome["stats"]
    logger.info(f"[随堂测验入库] topic={topic} 新入库={stats['saved']} "
                f"重复回填={stats['duplicated']} 不合格={stats['rejected']}")
    for r in outcome["rejected"][:5]:
        logger.info(f"[随堂测验入库] 拒收 {r['type']}: {r['reason']} | {r['question_text']}")

    kept: set[int] = set()
    for e in list(outcome["saved"]) + list(outcome["duplicated"]):
        idx = e.get("source_index")
        if not isinstance(idx, int) or idx >= len(questions) or e.get("id") is None:
            continue
        questions[idx]["id"] = e["id"]
        if e.get("duplicated"):
            # 命中题库已有题：把旧题的配图带回来。同一道题没道理让老师看到"新题有图、
            # 重复题没图"（与同步练习/课程练习同一口径）
            questions[idx]["media_files"] = e.get("media_files") or []
        elif "media_files" not in questions[idx]:
            questions[idx]["media_files"] = []
        kept.add(idx)

    # 生图只给本次**新入库**的题烧配额；重复命中沿用题库里已有的配图
    to_draw = [e for e in outcome["saved"] if e.get("media_raw") and e.get("id") is not None]
    if to_draw:
        from backend.api.config_router import get_config_value
        if get_config_value("IMAGE_GEN_ENABLED", True):
            from backend.api.image_gen_service import generate_placeholders_batch
            for e in to_draw:
                placeholders = e.get("media_raw") or []
                media_files: list[Any] = []
                try:
                    media_dir = BASE_DIR / "question_media" / str(e["id"])
                    media_files = await generate_placeholders_batch(
                        placeholders=placeholders,
                        subject=subject,
                        media_dir=media_dir,
                        qid=e["id"],
                        now=now,
                    ) or []
                    qb_execute_update(
                        "UPDATE question_bank SET media_placeholders=?, media_files=? WHERE id=?",
                        (json.dumps(placeholders, ensure_ascii=False),
                         json.dumps(media_files, ensure_ascii=False), e["id"]),
                    )
                except Exception as img_err:
                    # 配图失败只降级为无图题，不能让整次出题作废
                    logger.warning(f"AI 题目自动生图失败 (id={e['id']}): {img_err}")
                idx = e.get("source_index")
                if isinstance(idx, int) and idx < len(questions):
                    questions[idx]["media_files"] = media_files

    return [q for i, q in enumerate(questions) if i in kept]


# ── AI 生成随堂测验 ──

@router.post("/quizzes/ai-generate", summary="AI 自动生成随堂测验（优先题库，不足时 AI 补充）")
async def ai_generate_quiz(req: AiGenerateQuiz, request: Request):
    """优先从题库抽取匹配题目，不足时 AI 补充"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    if not req.topic.strip():
        raise HTTPException(status_code=400, detail="请输入主题")
    if req.count < 1 or req.count > 50:
        raise HTTPException(status_code=400, detail="数量范围为 1-50")

    # 出题策略统一走 backend.question_fill：**题库优先，缺口才交给 AI，AI 题必须先入库**。
    # 以前这个流程在本文件里手写了一遍（步骤 1 抽题 / 步骤 2 补题 / 无 Key 分支 / 失败降级 /
    # 切片 / 防重），而同样的流程在同步练习里又写了另一份 —— 两份各改各的，文案与降级路径
    # 就漂了（知识抢答干脆没写，缺口拿 3 道硬编码常识题循环凑数）。现在只剩一份实现。
    from backend import question_fill

    # 适配器①：题库抽题。查不动不阻断 —— 当 0 命中继续走 AI 补差。
    def _fetch_bank(need: int) -> list[dict[str, Any]]:
        try:
            rows = _search_questions_from_bank(
                topic=req.topic,
                subject=req.subject,
                question_type=req.question_type,
                count=need,
            )
        except Exception as e:
            logger.warning(f"题库搜索异常，跳过: {e}")
            return []
        if rows:
            logger.info(f"从题库命中 {len(rows)} 道题 (topic={req.topic})")
        return rows

    # 适配器②：AI 补差。只补真正缺的那几道，不做整批重出。
    async def _gen_ai(need: int, avoid: list[str]) -> list[dict[str, Any]]:
        api_key, _ = get_api_keys(username)
        if not api_key:
            raise question_fill.MissingApiKey(question_fill.NOTE_NO_KEY)
        type_desc = {
            "single": "单选题（4个选项）",
            "true_false": "判断题",
            "mixed": "混合出题（AI 自动搭配单选/判断）",
        }.get(req.question_type, "单选题")

        from backend.prompts.quiz import QUIZ_GENERATE_PROMPT
        from backend.prompts.question_schema import schema_block, render_question_prompt
        ai_role = build_ai_role(subject=req.subject)
        prompt = f"{ai_role}\n" + render_question_prompt(
            QUIZ_GENERATE_PROMPT,
            schema=schema_block("single/true_false", options_shape="list"),
            subject=req.subject,
            topic=req.topic,
            type_desc=type_desc,
            count=need,
        )
        # 注意：不注入技能 — 技能的结构化输出指令与 JSON 格式要求冲突
        text = await call_ai_async(prompt, api_key, json_mode=True,
                                   kb_query=f"{req.subject} {req.topic}")
        return _parse_ai_generated(text)

    # 适配器③：入库。只有真入库/命中已有题的条目会被返回，被拒收的不会变成"没有 id 的幽灵题"。
    dropped_note: list[str] = []

    async def _persist(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for q in items:
            if "svg_code" in q and "svg_content" not in q:
                q["svg_content"] = q["svg_code"]
            if "has_svg" not in q:
                q["has_svg"] = 1 if q.get("svg_code") or q.get("svg_content") else 0
            q["_source"] = "ai"
        kept = await _persist_quiz_ai_questions(
            items, topic=req.topic, subject=req.subject, username=username, now=now_str)
        dropped = len(items) - len(kept)
        if dropped:
            dropped_note.append(f"其中 {dropped} 道未通过校验或与本次重复，已剔除")
        return kept

    try:
        filled = await question_fill.fill_questions(
            count=req.count,
            fetch_bank=_fetch_bank,
            gen_ai=_gen_ai,
            persist=_persist,
            detail_when_empty="AI 未能给出可用题目（未解析出题目，或题目全部未通过入库校验），请重试",
        )
    except question_fill.FillUnavailable as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)

    all_questions = filled.questions
    notes = list(filled.notes) + dropped_note
    if filled.gap > 0:
        notes.append(f"目标 {req.count} 道，实得 {len(all_questions)} 道（还缺 {filled.gap} 道）")
        logger.warning(f"AI 出题数量不足: 请求 {req.count} 道, 实得 {len(all_questions)} 道")
    quiz_note = "；".join(notes)
    logger.info(f"随堂测验出题完成: topic={req.topic} 题库={filled.bank_count} "
                f"AI={filled.ai_count} 合计={len(all_questions)}")

    # 随机打乱，混合题库与 AI 题目
    random.shuffle(all_questions)

    result: dict[str, Any] = {"questions": all_questions, "total": len(all_questions)}
    if quiz_note:
        result["note"] = quiz_note
    return result


# ── AI 生成快速投票 ──

@router.post("/polls/ai-generate", summary="AI 自动生成投票")
async def ai_generate_poll(req: AiGeneratePoll, request: Request):
    """AI 根据主题自动生成投票问题和选项（异步调用）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    if not req.topic.strip():
        raise HTTPException(status_code=400, detail="请输入主题")
    if req.option_count < 2 or req.option_count > 10:
        raise HTTPException(status_code=400, detail="选项数量范围为 2-10")

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请在系统配置中设置")

    prompt = (
        '请根据主题"' + req.topic + '"生成一个课堂投票，包含' + str(req.option_count) + '个选项。\n\n'
        '请严格按照以下JSON格式输出，不要包含任何其他文字：\n'
        '{\n'
        '  "question": "投票问题",\n'
        '  "options": ["选项1", "选项2", ...]\n'
        '}'
    )
    # 注意：不注入技能 — 技能的结构化输出指令与 JSON 格式要求冲突

    try:
        result_text = await call_ai_async(prompt, api_key, json_mode=True, use_kb=False)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 生成投票失败: {str(e)}")

    data = extract_json_from_text(result_text)
    if data:
        return {"poll": data, "raw": result_text}
    return {"poll": None, "raw": result_text, "error": "AI 返回格式异常，请重试或手动输入"}


# ── 解析 AI 返回的题目 JSON ──


def _parse_ai_generated(text: str) -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 题目列表（兼容课程练习的解析逻辑）"""
    data = extract_json_from_text(text)
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and "questions" in data:
        return data["questions"]
    if not data:
        logger.warning(f"AI 返回解析失败: {text[:300]}")
    return []


# ── AI 建议回答提问 ──

@router.post("/questions/{question_id}/ai-suggest", summary="AI 建议回答")
async def ai_suggest_answer(question_id: int, request: Request):
    """AI suggests answer based on question content (teacher can modify before submit)"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师可用")
    if not _question_scope(question_id):
        raise HTTPException(status_code=404, detail="问题不存在")
    if not _can_view_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权查看该提问")

    rows = execute_query(
        "SELECT content FROM interaction_questions WHERE id = ?",
        (question_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="问题不存在")

    content = rows[0][0]
    ai_role = build_ai_role()
    prompt = (
        f'{ai_role}学生在课堂上提出了以下问题，请给出专业、清晰的回答。\n\n'
        '学生问题：' + content + '\n\n'
        '请用中文回答，语气亲切，条理清晰。'
    )

    # AI 建议是几十秒级同步调用, 直接在 async 端点里跑会卡死整个事件循环
    answer = await asyncio.to_thread(_call_ai, prompt)
    return {"suggested_answer": answer, "question": content}


class QuizUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    questions: str | None = None
    subject: str | None = None      # 学科（老测验可以补上，列表/活动监控随即显示）
    knowledge_points: str | None = None   # 知识点（老测验可以补）
    auto_scores: bool = True
    # 状态不再走编辑接口：发布/结束/重开各有显式端点，避免绕过"发布前校验"，
    # 也避免历史上那个 `closed`（与 ended 两套写法并存）再被写进来


class PollUpdate(BaseModel):
    question: str | None = None
    options: list[str] | None = None
    poll_type: str | None = None
    subject: str | None = None    # 学科（老投票可以在编辑弹窗里补上）


class QuestionUpdate(BaseModel):
    content: str | None = None
    subject: str | None = None
    knowledge_point: str | None = None


# ── 随堂测验 ──

def _get_quiz_row(quiz_id: int) -> dict[str, Any] | None:
    """S10: 统一按字典取测验字段, 淘汰 quiz[0][4] 这类位置索引"""
    rows = execute_query_dict("SELECT * FROM interaction_quizzes WHERE id = ?", (quiz_id,))
    return rows[0] if rows else None


def _answer_matches(user_ans: str, correct_ans: str, q_type: str, options: Any = None) -> bool:
    """判分口径与提交端保持一致：统一走 backend.answer_norm
    （多选乱序等价、忽略大小写空白，并兼容下标/判断词写法）"""
    from backend.answer_norm import answers_equal
    return answers_equal(user_ans, correct_ans, options, q_type)


def _teacher_hits_scope(viewer: str, target_grade: str, target_class: str) -> bool:
    """教师任教范围与目标年级/班级是否有交集"""
    from backend.permission_service import get_teacher_grades
    grades = [g.strip() for g in str(target_grade or "").replace("，", ",").split(",") if g.strip()]
    teacher_grades = {str(g.get("name") or "").strip() for g in get_teacher_grades(viewer)}
    if grades:
        return bool(set(grades) & teacher_grades)
    return False


def _can_view_activity_results(username: str, role: int, row: dict[str, Any]) -> bool:
    """S4/S8: 成绩与投票统计的查看权限 = 管理员 / 创建者 / 任教范围有交集"""
    if role == 0:
        return True
    if (row.get("creator_username") or "") == username:
        return True
    if role != 1:
        return False
    scope = (row.get("target_scope") or "teacher_classes").strip()
    if scope in ("all", "school"):
        return True
    if scope in ("teacher_classes", "class", "grade"):
        return _teacher_hits_scope(username, row.get("target_grade") or "", row.get("target_class") or "")
    return False


@router.post("/quizzes", summary="创建随堂测验")
async def create_quiz(req: QuizCreate, request: Request):
    """教师创建随堂测验"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可创建测验")

    # R5: 发布范围必须落在本人任教范围内(与公告共用同一道闸)
    from backend.api.notification_router import validate_activity_scope
    validate_activity_scope(user, req.target_scope, req.target_grade, req.target_class,
                            req.target_users, what="随堂测验")

    # 验证 JSON
    try:
        questions = json.loads(req.questions)
        if not isinstance(questions, list) or len(questions) == 0:
            raise ValueError("试题不能为空")
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"试题格式错误: {e}")

    # R2(Step B): 题面分值折算成合计 100 —— 与同步练习/考试同一套百分制口径。
    # 老实现每题固定 1 分(满分=题数), 5 题答对 3 题显示"3/5", 与"60 分"对不上。
    questions = normalize_quiz_scores(questions, req.auto_scores)

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    # 状态：draft=草稿(学生看不到) / active=进行中 / ended=已结束
    status = "active" if req.publish else "draft"
    quiz_id = execute_insert_update(
        """INSERT INTO interaction_quizzes
           (creator_username, title, description, questions, subject, knowledge_points,
            status, created_at, updated_at,
            target_scope, target_grade, target_class, target_users)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (user["username"], req.title, req.description, json.dumps(questions, ensure_ascii=False),
         (req.subject or "").strip(), (req.knowledge_points or "").strip(), status, now, now,
         req.target_scope, req.target_grade, req.target_class, req.target_users),
    )

    logger.info(f"用户 {user['username']} 创建随堂测验: {req.title} (id={quiz_id}, {status})")

    # ── 异步通知学生（不阻塞创建操作） ──
    # 草稿不发通知：还没发布就推给学生会让人点进来发现答不了
    async def _notify_quiz():
        try:
            from backend.api.notification_router import notify_users_by_scope
            notify_users_by_scope(
                creator_username=user["username"],
                type_="info",
                title=f"新随堂测验「{req.title}」已发布",
                content=f"共 {len(questions)} 题，请及时完成",
                related_link="/interaction",
                target_scope=req.target_scope,
                target_grade=req.target_grade,
                target_class=req.target_class,
                target_users=req.target_users,
                source_type="quiz",
                source_id=str(quiz_id),
            )
        except Exception as e:
            logger.warning(f"发送随堂测验通知失败: {e}")
    if req.publish:
        asyncio.create_task(_notify_quiz())

    return {"message": "测验已发布" if req.publish else "已存为草稿",
            "quiz_id": quiz_id, "status": status, "total_score": _quiz_total(questions)}


def _can_manage_quiz(username: str, role: int, quiz_id: int) -> bool:
    """检查是否有管理测验的权限"""
    if role == 0:
        return True
    rows = execute_query(
        "SELECT creator_username FROM interaction_quizzes WHERE id = ?",
        (quiz_id,),
    )
    return bool(rows and rows[0][0] == username)


@router.put("/quizzes/{quiz_id}", summary="更新测验")
async def update_quiz(quiz_id: int, req: QuizUpdate, request: Request):
    """编辑随堂测验"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_quiz(user["username"], role, quiz_id):
        raise HTTPException(status_code=403, detail="无权修改此测验")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    updates = ["updated_at = ?"]
    params: list[Any] = [now]
    # 状态不在编辑接口里改（发布/结束/重开各有显式端点，带各自的前置校验）
    for field in ("title", "description", "subject", "knowledge_points"):
        val = getattr(req, field, None)
        if val is not None:
            updates.append(f"{field} = ?")
            params.append(val)
    if req.questions is not None:
        try:
            edited = json.loads(req.questions)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="试题格式错误")
        # 已有答卷时不动分值: 老答卷的分数是按旧满分(题数)记的, 改了分母就对不上了
        has_answers = bool(execute_query(
            "SELECT 1 FROM interaction_quiz_answers WHERE quiz_id = ? LIMIT 1", (quiz_id,)))
        if isinstance(edited, list) and not has_answers:
            edited = normalize_quiz_scores(edited, req.auto_scores)
        updates.append("questions = ?")
        params.append(json.dumps(edited, ensure_ascii=False) if isinstance(edited, list) else req.questions)

    params.append(quiz_id)
    execute_insert_update(
        f"UPDATE interaction_quizzes SET {', '.join(updates)} WHERE id = ?",
        tuple(params),
    )
    return {"message": "测验已更新"}


def _quiz_question_count(quiz_id: int) -> int:
    rows = execute_query_dict("SELECT questions FROM interaction_quizzes WHERE id=?", (quiz_id,))
    if not rows:
        return 0
    raw = rows[0].get("questions")
    try:
        items = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except (json.JSONDecodeError, TypeError):
        items = []
    return len(items) if isinstance(items, list) else 0


@router.post("/quizzes/{quiz_id}/publish", summary="发布随堂测验（草稿 → 进行中）")
async def publish_quiz(quiz_id: int, request: Request):
    """发布草稿：发布后学生才看得到、才能作答（发布前校验题数与分值）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_quiz(user["username"], role, quiz_id):
        raise HTTPException(status_code=403, detail="无权发布此测验")

    rows = execute_query_dict("SELECT status, questions FROM interaction_quizzes WHERE id=?", (quiz_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="测验不存在")
    status = str(rows[0].get("status") or "").strip()
    if status == "active":
        return {"message": "该测验已在进行中", "status": "active"}
    if status in ("ended", "closed"):
        raise HTTPException(status_code=400, detail="已结束的测验请用「重新开启」")
    if _quiz_question_count(quiz_id) <= 0:
        raise HTTPException(status_code=400, detail="测验里还没有题目，无法发布")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "UPDATE interaction_quizzes SET status='active', updated_at=? WHERE id=?", (now, quiz_id))
    logger.info(f"教师 {user['username']} 发布随堂测验 {quiz_id}")
    return {"message": "已发布", "status": "active"}


@router.post("/quizzes/{quiz_id}/end", summary="结束随堂测验")
async def end_quiz(quiz_id: int, request: Request):
    """结束测验：学生不能再答；已交的答卷与统计保留"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_quiz(user["username"], role, quiz_id):
        raise HTTPException(status_code=403, detail="无权结束此测验")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "UPDATE interaction_quizzes SET status='ended', updated_at=? WHERE id=?", (now, quiz_id))
    logger.info(f"教师 {user['username']} 结束随堂测验 {quiz_id}")
    return {"message": "已结束", "status": "ended"}


@router.post("/quizzes/{quiz_id}/reopen", summary="重新开启随堂测验（已结束 → 进行中）")
async def reopen_quiz(quiz_id: int, request: Request):
    """重新开启：已交的答卷与积分都不动，未交的学生可以继续作答"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_quiz(user["username"], role, quiz_id):
        raise HTTPException(status_code=403, detail="无权开启此测验")

    rows = execute_query_dict("SELECT status FROM interaction_quizzes WHERE id=?", (quiz_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="测验不存在")
    status = str(rows[0].get("status") or "").strip()
    if status == "active":
        return {"message": "该测验已在进行中", "status": "active"}
    if status not in ("ended", "closed"):
        raise HTTPException(status_code=400, detail="只有已结束的测验才能重新开启")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "UPDATE interaction_quizzes SET status='active', updated_at=? WHERE id=?", (now, quiz_id))
    logger.info(f"教师 {user['username']} 重新开启随堂测验 {quiz_id}")
    return {"message": "已重新开启", "status": "active"}


@router.delete("/quizzes/{quiz_id}", summary="删除测验")
async def delete_quiz(quiz_id: int, request: Request):
    """删除随堂测验及其答案"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_quiz(user["username"], role, quiz_id):
        raise HTTPException(status_code=403, detail="无权删除此测验")

    execute_insert_update("DELETE FROM interaction_quiz_answers WHERE quiz_id = ?", (quiz_id,))
    from backend.reward_engine import activity_reward_students, recompute_students
    _affected = activity_reward_students([("quiz", quiz_id)])
    execute_insert_update("DELETE FROM activity_rewards WHERE activity_type='quiz' AND activity_id=?", (str(quiz_id),))
    execute_insert_update("DELETE FROM notifications WHERE source_type='quiz' AND source_id=?", (str(quiz_id),))
    execute_insert_update("DELETE FROM interaction_quizzes WHERE id = ?", (quiz_id,))
    recompute_students(_affected)          # 缺陷A：删流水必须就地重算总分
    return {"message": "测验已删除"}


@router.delete("/quizzes/{quiz_id}/questions/{question_index}", summary="删除测验中的单道题")
async def delete_quiz_question(quiz_id: int, question_index: int, request: Request):
    """删除随堂测验中的单道题，同时清理该题对应的答题记录"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_quiz(user["username"], role, quiz_id):
        raise HTTPException(status_code=403, detail="无权修改此测验")

    # 读出当前测验
    rows = execute_query("SELECT questions FROM interaction_quizzes WHERE id = ?", (quiz_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="测验不存在")
    questions_str = rows[0][0]
    questions = json.loads(questions_str) if isinstance(questions_str, str) else questions_str

    if question_index < 0 or question_index >= len(questions):
        raise HTTPException(status_code=400, detail="题目索引超出范围")

    # 从数组中移除指定题目
    questions.pop(question_index)
    new_questions_str = json.dumps(questions, ensure_ascii=False)

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "UPDATE interaction_quizzes SET questions = ?, updated_at = ? WHERE id = ?",
        (new_questions_str, now, quiz_id),
    )

    # 清理答题记录：移除该题对应的答案，并重新索引后续题目
    answer_rows = execute_query(
        "SELECT id, answers FROM interaction_quiz_answers WHERE quiz_id = ?",
        (quiz_id,),
    )
    for ans_row in answer_rows:
        ans_id = ans_row[0]
        ans_str = ans_row[1]
        try:
            user_answers = json.loads(ans_str) if isinstance(ans_str, str) else ans_str
            if not isinstance(user_answers, list):
                continue
            # 移除 question_index 对应的答案，并调整后续索引
            new_answers = []
            for a in user_answers:
                qi = a.get("question_index")
                if qi == question_index:
                    continue  # 跳过被删除题的答案
                if qi is not None and qi > question_index:
                    a["question_index"] = qi - 1  # 索引前移
                new_answers.append(a)
            execute_insert_update(
                "UPDATE interaction_quiz_answers SET answers = ? WHERE id = ?",
                (json.dumps(new_answers, ensure_ascii=False), ans_id),
            )
        except (json.JSONDecodeError, TypeError):
            continue

    return {"message": "题目已删除", "questions_remaining": len(questions)}


def _can_manage_poll(username: str, role: int, poll_id: int) -> bool:
    if role == 0:
        return True
    rows = execute_query("SELECT creator_username FROM interaction_polls WHERE id = ?", (poll_id,))
    return bool(rows and rows[0][0] == username)


@router.put("/polls/{poll_id}", summary="更新投票")
async def update_poll(poll_id: int, req: PollUpdate, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_poll(user["username"], role, poll_id):
        raise HTTPException(status_code=403, detail="无权修改")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if req.question is not None:
        execute_insert_update("UPDATE interaction_polls SET question = ? WHERE id = ?",
                              (req.question, poll_id))
    if req.options is not None:
        execute_insert_update("UPDATE interaction_polls SET options = ? WHERE id = ?",
                              (json.dumps(req.options, ensure_ascii=False), poll_id))
        # 选项变更时清理旧投票记录，避免统计错误
        execute_insert_update("DELETE FROM interaction_poll_votes WHERE poll_id = ?", (poll_id,))
    if req.poll_type is not None:
        execute_insert_update("UPDATE interaction_polls SET poll_type = ? WHERE id = ?",
                              (req.poll_type, poll_id))
    if req.subject is not None:
        execute_insert_update("UPDATE interaction_polls SET subject = ? WHERE id = ?",
                              (req.subject.strip(), poll_id))
    return {"message": "投票已更新"}


@router.delete("/polls/{poll_id}", summary="删除投票")
async def delete_poll(poll_id: int, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")
    if not _can_manage_poll(user["username"], role, poll_id):
        raise HTTPException(status_code=403, detail="无权删除")

    execute_insert_update("DELETE FROM interaction_poll_votes WHERE poll_id = ?", (poll_id,))
    from backend.reward_engine import activity_reward_students, recompute_students
    _affected = activity_reward_students([("poll", poll_id)])
    execute_insert_update("DELETE FROM activity_rewards WHERE activity_type='poll' AND activity_id=?", (str(poll_id),))
    execute_insert_update("DELETE FROM notifications WHERE source_type='poll' AND source_id=?", (str(poll_id),))
    execute_insert_update("DELETE FROM interaction_polls WHERE id = ?", (poll_id,))
    recompute_students(_affected)          # 缺陷A：删流水必须就地重算总分
    return {"message": "投票已删除"}


@router.delete("/questions/{question_id}", summary="删除提问")
async def delete_question(question_id: int, request: Request):
    user = get_current_user(request)
    scope = _question_scope(question_id)
    if not scope:
        raise HTTPException(status_code=404, detail="提问不存在")
    if not _can_manage_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权删除该提问")
    execute_insert_update("DELETE FROM interaction_questions WHERE id = ?", (question_id,))

    # 清理关联数据
    # R9: 不再连带删除该提问已发放的积分记录 —— 学生真实参与过, 悄悄把分扣回去更伤信任;
    # 只清掉已经失去载体的通知。
    execute_insert_update(
        "DELETE FROM interaction_question_answers WHERE question_id = ?", (question_id,)
    )
    execute_insert_update(
        "DELETE FROM interaction_question_votes WHERE question_id = ?", (question_id,)
    )
    execute_insert_update(
        "DELETE FROM interaction_question_followups WHERE question_id = ?", (question_id,)
    )
    execute_insert_update("DELETE FROM notifications WHERE source_type='question' AND source_id=?", (str(question_id),))
    asyncio.create_task(
        _broadcast_question_event(scope[1], scope[2], "question_deleted", question_id)
    )
    return {"message": "提问已删除"}


@router.put("/questions/{question_id}", summary="更新提问")
async def update_question(question_id: int, req: QuestionUpdate, request: Request):
    user = get_current_user(request)
    scope = _question_scope(question_id)
    if not scope:
        raise HTTPException(status_code=404, detail="提问不存在")
    # 学生只能改自己的；教师只能改任教范围内学生的；管理员不受限
    if not _can_manage_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权修改")
    if req.content is not None:
        content = req.content.strip()
        if not content:
            raise HTTPException(status_code=400, detail="提问内容不能为空")
        if len(content) > 500:
            raise HTTPException(status_code=400, detail="问题最多 500 字")
        # 编辑后不再参与“提交时的 2 分钟内容去重”，避免唯一索引挡住正常修改
        execute_insert_update(
            "UPDATE interaction_questions SET content = ?, content_hash = NULL, dedup_bucket = 0 WHERE id = ?",
            (content, question_id),
        )
    fields = []
    values: list[Any] = []
    if req.subject is not None:
        fields.append("subject = ?")
        values.append(req.subject.strip())
    if req.knowledge_point is not None:
        fields.append("knowledge_point = ?")
        values.append(req.knowledge_point.strip())
    if fields:
        values.append(question_id)
        execute_insert_update(
            f"UPDATE interaction_questions SET {', '.join(fields)} WHERE id = ?",
            tuple(values),
        )
    asyncio.create_task(
        _broadcast_question_event(scope[1], scope[2], "question_updated", question_id)
    )
    return {"message": "提问已更新"}


@router.get("/quizzes", summary="获取随堂测验列表")
async def list_quizzes(
    request: Request,
    status: str = Query("", description="筛选状态"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """获取随堂测验列表"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]

    conditions = []
    params: list[Any] = []

    if role == 2:
        # 学生：进行中的 + **自己已答过的**（已结束也保留，方便回看自己的结果）。
        # 旧写法只放 active，老师一结束，学生连自己的答题记录都找不到了。
        conditions.append(
            "(q.status = 'active' OR (q.status IN ('ended','closed') AND EXISTS ("
            "SELECT 1 FROM interaction_quiz_answers a "
            "WHERE a.quiz_id = q.id AND a.student_username = ?)))"
        )
        params.append(username)
    elif role == 1:
        conditions.append("q.creator_username = ?")
        params.append(username)
        if status:
            conditions.append("q.status = ?")
            params.append(status)
    else:
        if status:
            conditions.append("q.status = ?")
            params.append(status)

    where = " AND ".join(conditions) if conditions else "1=1"
    offset = (page - 1) * page_size

    if role == 2:
        # 学生：获取所有活跃测验后按目标范围过滤
        s_grade, s_class = get_user_grade_class(username)
        # 注意：列顺序必须与后续索引访问一致
        all_rows = execute_query(
            f"""SELECT q.id, q.creator_username, q.title, q.description, q.questions, q.status,
                      q.created_at, q.updated_at,
                      q.target_scope, q.target_grade, q.target_class, q.target_users,
                      COALESCE(u.name, u.username) AS creator_name,
                      COALESCE(q.subject, '') AS subject,
                      COALESCE(q.knowledge_points, '') AS knowledge_points
                FROM interaction_quizzes q
                JOIN users u ON q.creator_username = u.username AND u.role IN (0, 1)
                WHERE {where}
                ORDER BY CASE WHEN q.status = 'active' THEN 0 ELSE 1 END, q.created_at DESC""",
            tuple(params),
        )
        rows = []
        for r in all_rows:
            if check_activity_visibility(
                student_username=username,
                student_grade=s_grade,
                student_class=s_class,
                creator_username=r[1],
                target_scope=r[8] if len(r) > 8 else "teacher_classes",
                target_grade=r[9] if len(r) > 9 else "",
                target_class=r[10] if len(r) > 10 else "",
                target_users=r[11] if len(r) > 11 else "",
            ):
                rows.append(r)
        # 内存分页
        offset_idx = (page - 1) * page_size
        rows = rows[offset_idx:offset_idx + page_size]
    else:
        rows = execute_query(
            f"""SELECT q.id, q.creator_username, q.title, q.description, q.questions, q.status, q.created_at, q.updated_at,
                        q.target_scope, q.target_grade, q.target_class, q.target_users,
                        COALESCE(u.name, u.username) AS creator_name,
                        COALESCE(q.subject, '') AS subject,
                        COALESCE(q.knowledge_points, '') AS knowledge_points
                FROM interaction_quizzes q
                LEFT JOIN users u ON q.creator_username = u.username
                WHERE {where}
                ORDER BY q.created_at DESC LIMIT ? OFFSET ?""",
            tuple(params + [page_size, offset]),
        )

    quizzes = []
    for r in rows:
        # 学生/教师两条路径现同为 13 列布局(target_* 在 8-11, creator_name 在 12); 保留 len 兜底防旧查询混入
        creator_name_idx = 12 if len(r) > 12 else (8 if len(r) > 8 else 1)
        q = {
            "id": r[0],
            "creator_username": r[1],
            "title": r[2],
            "description": r[3],
            "questions": json.loads(r[4]) if isinstance(r[4], str) else r[4],
            "status": r[5],
            "created_at": r[6],
            "updated_at": r[7],
            "creator_name": r[creator_name_idx],
            "target_scope": r[8] if len(r) > 12 else "teacher_classes",
            "target_grade": (r[9] if len(r) > 12 else "") or "",
            "target_class": (r[10] if len(r) > 12 else "") or "",
            "target_users": (r[11] if len(r) > 12 else "") or "",
            # 学科/知识点：第 14、15 列（列序必须与上面两条 SELECT 一致；老查询没有这列时给空串）
            "subject": (r[13] if len(r) > 13 else "") or "",
            "knowledge_points": (r[14] if len(r) > 14 else "") or "",
        }
        # 统一字段名：svg_code → svg_content
        questions = q.get("questions", [])
        if isinstance(questions, list):
            for qs in questions:
                if isinstance(qs, dict) and "svg_code" in qs and "svg_content" not in qs:
                    qs["svg_content"] = qs["svg_code"]
        # 计算答题人数
        count_rows = execute_query(
            "SELECT COUNT(*) FROM interaction_quiz_answers WHERE quiz_id = ?",
            (r[0],),
        )
        q["answer_count"] = count_rows[0][0] if count_rows else 0
        # 学生端标记是否已答题
        if role == 2:
            answered = execute_query(
                "SELECT COUNT(*) FROM interaction_quiz_answers WHERE quiz_id = ? AND student_username = ?",
                (r[0], username),
            )
            q["answered"] = (answered[0][0] if answered else 0) > 0
        quizzes.append(q)

    # 学科：新卷用建卷时落库的 subject；老卷（那时还没这列）按题目里带的题库 id 反查，
    # 与活动监控同一口径（都取不到就留空，界面显示"-"）
    missing = [q for q in quizzes if not (q.get("subject") or "").strip()]
    if missing:
        fallback = _quiz_subjects(missing)
        for q in missing:
            q["subject"] = fallback.get(q["id"], "")

    return {"quizzes": quizzes}


@router.post("/quizzes/{quiz_id}/answer", summary="提交测验答案")
async def submit_quiz_answer(quiz_id: int, req: QuizAnswerSubmit, request: Request):
    """学生提交随堂测验答案"""
    user = get_current_user(request)
    username = user["username"]

    # 验证测验存在且活跃
    role = user.get("role", 2)
    quiz_rows = execute_query_dict(
        "SELECT * FROM interaction_quizzes WHERE id = ? AND status = 'active'",
        (quiz_id,),
    )
    if not quiz_rows:
        raise HTTPException(status_code=404, detail="测验不存在或已结束")

    quiz_row = quiz_rows[0]

    # 学生只能回答自己权限范围内的测验
    if role == 2:
        s_grade, s_class = get_user_grade_class(username)
        if not check_activity_visibility(
            student_username=username,
            student_grade=s_grade,
            student_class=s_class,
            creator_username=quiz_row["creator_username"],
            target_scope=quiz_row.get("target_scope", "") or "teacher_classes",
            target_grade=quiz_row.get("target_grade", "") or "",
            target_class=quiz_row.get("target_class", "") or "",
            target_users=quiz_row.get("target_users", "") or "",
        ):
            raise HTTPException(status_code=403, detail="无权回答该测验")

    # 验证是否已答过
    existing = execute_query(
        "SELECT id FROM interaction_quiz_answers WHERE quiz_id = ? AND student_username = ?",
        (quiz_id, username),
    )
    if existing:
        raise HTTPException(status_code=400, detail="您已提交过该测验，不能重复作答")

    # 解析答案并评分
    try:
        questions = json.loads(quiz_row["questions"]) if isinstance(quiz_row["questions"], str) else quiz_row["questions"]
        user_answers = json.loads(req.answers)
    except (json.JSONDecodeError, TypeError) as parse_err:
        raise HTTPException(status_code=400, detail=f"答题数据格式不正确: {parse_err}")
    if not isinstance(user_answers, list):
        raise HTTPException(status_code=400, detail="答题数据必须是数组")

    # ── S-GRADING(P3): 逐题判分留痕 + 主观题交后台批量批改 ──
    # 旧实现只往库里写一个总分：简答题判了多少分、是谁判的、还剩几题没判全都查不到，
    # 学生端/教师端只能"再精确匹配一遍"猜，于是简答题永远显示答错；而每道简答题还要在
    # 提交请求里现场等一次 AI。现在客观题当场判、主观题入队由后台按题合并批量评分。
    q_total = sum(float(q.get("score", 1) or 0) for q in questions)   # 全卷满分
    # 分离简答题和其他题
    short_indices = [i for i, q in enumerate(questions) if q.get("type") in ("short", "fill")]
    other_indices = [i for i, q in enumerate(questions) if q.get("type") not in ("short", "fill")]
    graded: dict[str, Any] = {}
    earned = 0.0

    def _ans_at(idx: int) -> str:
        return str(next((ua.get("answer", "") for ua in user_answers
                         if isinstance(ua, dict) and ua.get("question_index") == idx), "")).strip()

    # 客观题：归一化精确匹配(多选按集合比较)
    for idx in other_indices:
        q = questions[idx]
        mx = float(q.get("score", 1) or 0)
        user_ans = _ans_at(idx)
        correct_ans = str(q.get("answer", "")).strip()
        ok = _answer_matches(user_ans, correct_ans, q.get("type", "single"))
        if ok:
            earned += mx
        graded[str(idx)] = {
            "student_answer": user_ans, "correct_answer": correct_ans,
            "score": mx if ok else 0, "max_score": mx,
            "is_correct": ok, "graded_by": "exact",
        }

    # 主观题(简答/填空)：配了 AI Key 就入队；没配才当场按要点兜底
    try:
        api_key, _ = get_api_keys(username)
    except Exception:
        api_key = ""
    has_key = bool((api_key or "").strip())
    pending_ai = 0
    for idx in short_indices:
        q = questions[idx]
        mx = float(q.get("score", 1) or 0)
        user_ans = _ans_at(idx)
        correct_ans = str(q.get("answer", "")).strip()
        if has_key:
            graded[str(idx)] = {
                "student_answer": user_ans, "correct_answer": correct_ans,
                "score": 0, "max_score": mx, "is_correct": False,
                "grading": "pending", "graded_by": "queued",
                "comment": "", "feedback": "",
            }
            pending_ai += 1
            continue
        one = keyword_fallback(correct_ans, mx, user_ans)
        graded[str(idx)] = one
        earned += float(one.get("score") or 0)

    earned = round(earned, 1)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    row_id = execute_insert_update(
        """INSERT INTO interaction_quiz_answers
           (quiz_id, student_username, answers, score, submitted_at, graded, ai_pending)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (quiz_id, username, json.dumps(user_answers, ensure_ascii=False), earned, now,
         json.dumps(graded, ensure_ascii=False), 1 if pending_ai else 0),
    )

    # ── 积分奖励 ──
    # 参与分与成绩无关，当场发；等级分必须等判分完整，否则按"只含客观分"的临时成绩发档。
    quiz_title = quiz_row.get("title") or f"测验#{quiz_id}"
    try:
        from backend.reward_engine import award_participation
        award_participation(username, "quiz", str(quiz_id), quiz_title)
    except Exception as e:
        logger.warning(f"测验参与积分发放失败 (user={username}, quiz_id={quiz_id}): {e}")
        logger.warning(traceback.format_exc())

    if not pending_ai:
        try:
            _settle_quiz_answer({"id": row_id, "quiz_id": quiz_id, "student_username": username,
                                 "score": earned}, quiz_title, q_total)
        except Exception as e:
            logger.warning(f"测验结算失败 (user={username}, quiz_id={quiz_id}): {e}")
    else:
        logger.info(f"测验 {quiz_id} 答卷 {row_id} 已提交，{pending_ai} 道主观题转入后台批改队列")

    return {
        "message": ("提交成功，主观题批改中，成绩稍后自动更新" if pending_ai else "提交成功"),
        "attempt_id": row_id,
        "score": earned,
        "total_score": q_total,
        "percentage": round(earned / max(q_total, 1) * 100, 1),
        "pending_ai": pending_ai,
    }


def _settle_quiz_answer(row: dict, quiz_title: str = "", q_total: float = 0) -> dict:
    """一份测验答卷判分完整后的收尾：按最终得分率发等级积分(参与分提交时已发)。

    与练习/考试同一套做法：待批改期间不发等级分，避免"按 0 分发一档、几十秒后又变了"。
    判不准的题(grading=review)不在此处理，由教师端逐题批改。
    """
    quiz_id = row["quiz_id"]
    username = row["student_username"]
    earned = float(row.get("score") or 0)
    qr = _get_quiz_row(quiz_id) or {}
    if not quiz_title:
        quiz_title = qr.get("title") or f"测验#{quiz_id}"
    if not q_total:
        q_total = sum(float(q.get("score", 1) or 0) for q in _quiz_questions(qr))
    try:
        from backend.reward_engine import award_grade
        award_grade(username, "quiz", str(quiz_id), earned, q_total or 1, quiz_title)
    except Exception as e:
        logger.warning(f"测验等级积分结算失败 (user={username}, quiz_id={quiz_id}): {e}")
    return {"settled": True, "score": earned, "total": q_total}


@router.get("/quizzes/{quiz_id}/my-result", summary="学生查看自己的答题结果")
async def get_my_quiz_result(quiz_id: int, request: Request):
    """学生查看自己的随堂测验答题详情"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可查看")

    quiz_row0 = _get_quiz_row(quiz_id)
    if not quiz_row0:
        raise HTTPException(status_code=404, detail="测验不存在")

    # 查询该学生的答题记录
    answers = execute_query(
        """SELECT answers, score, submitted_at, graded, ai_pending
           FROM interaction_quiz_answers WHERE quiz_id = ? AND student_username = ?""",
        (quiz_id, username),
    )
    if not answers:
        raise HTTPException(status_code=404, detail="未找到答题记录")

    questions = _quiz_questions(quiz_row0)
    user_answers = json.loads(answers[0][0]) if isinstance(answers[0][0], str) else answers[0][0]
    raw_score = float(answers[0][1] or 0)
    q_score = sum(float(q.get("score", 1) or 0) for q in questions)
    # 得分统一 100 分制（老测验满分=题数也折算），原始分照旧给界面做"原始分 3/5"提示
    cent = _centesimal(raw_score, q_score)
    cent_total = 100.0 if q_score > 0 else q_score
    # S-GRADING(P3): 判分结果以提交/批改时写下的 graded 为准。
    # 旧实现这里"再精确匹配一遍"，简答题(AI 判的 8 分)被重算成 0 分并标成答错。
    graded_map = _quiz_graded(answers[0][3])

    # 每题批改详情
    details = []
    for i, q in enumerate(questions):
        user_ans = ""
        for ua in user_answers:
            if ua.get("question_index") == i:
                user_ans = str(ua.get("answer", "")).strip()
                break
        correct_ans = str(q.get("answer", "")).strip()
        q_type = q.get("type", "single")
        mx = float(q.get("score", 1) or 0)
        g = graded_map.get(str(i))
        if isinstance(g, dict) and g:
            is_correct = bool(g.get("is_correct"))
            got_score = float(g.get("score") or 0)
            mx = float(g.get("max_score") or mx)
            grading = str(g.get("grading") or "")
            graded_by = str(g.get("graded_by") or "")
            needs_review = bool(g.get("needs_review"))
            comment = str(g.get("comment") or "")
            feedback = str(g.get("feedback") or "")
        else:                       # 老数据没留痕: 只能沿用旧的精确匹配口径
            is_correct = _answer_matches(user_ans, correct_ans, q_type)
            got_score = mx if is_correct else 0
            grading, graded_by, needs_review, comment, feedback = "", "", False, "", ""
        details.append({
            "index": i,
            "question": q.get("question", q.get("question_text", "")),
            "options": q.get("options", None),
            "type": q_type,
            "user_answer": user_ans,
            "correct_answer": correct_ans,
            "is_correct": is_correct,
            "score": got_score,
            "max_score": mx,
            # S-GRADING(P3): 题态与判分来源, 前端据此显示「AI 批改中」而不是误显示答错
            "grading": grading,
            "graded_by": graded_by,
            "needs_review": needs_review,
            "comment": comment,
            "feedback": feedback,
            "explanation": q.get("explanation", ""),
            "svg_content": q.get("svg_content") or q.get("svg_code", ""),
            "has_svg": q.get("has_svg", 1 if q.get("svg_code") or q.get("svg_content") else 0),
            "media_files": q.get("media_files", ""),
        })

    pending_ai = sum(1 for d in details if d.get("grading") == "pending")
    return {
        # P2-14: 显式声明视角 —— 前端原来靠 "有无 quiz_title 字段" 区分师生, 语义脆弱
        "view": "student",
        "quiz_title": quiz_row0.get("title"),
        "score": cent if cent is not None else round(raw_score, 1),   # 百分制
        "total_score": cent_total,                                   # 固定 100
        "raw_score": round(raw_score, 1),
        "raw_total_score": q_score,
        "percentage": cent,
        "details": details,
        # S-GRADING(P3): 还有几题在后台批改 / 几题待教师人工批改
        "pending_ai": pending_ai,
        "pending_review": sum(1 for d in details if d.get("needs_review")),
    }


def _calc_student_correct_count(answer_row: tuple[Any, ...], questions: list[Any],
                                graded_map: dict[str, Any] | None = None) -> int:
    """计算学生的答对题数"""
    try:
        user_map = _answer_index_map(answer_row[1])
        gm = graded_map or {}
        return sum(
            1 for i, q in enumerate(questions)
            if _is_question_correct(gm.get(str(i)), user_map.get(i, ""),
                                    str(q.get("answer", "")).strip(), q.get("type", "single"))
        )
    except Exception:
        return 0


@router.get("/quizzes/{quiz_id}/results", summary="教师查看测验结果统计")
async def get_quiz_results(quiz_id: int, request: Request):
    """教师查看随堂测验结果统计"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="无权查看")

    quiz_row = _get_quiz_row(quiz_id)
    if not quiz_row:
        raise HTTPException(status_code=404, detail="测验不存在")
    # S4: 旧实现只挡学生, 任何教师都能读他人测验的逐人成绩(含学号/姓名/班级)
    if not _can_view_activity_results(user["username"], role, quiz_row):
        raise HTTPException(status_code=403, detail="无权查看该测验的统计")

    questions = _quiz_questions(quiz_row)
    answers = execute_query(
        """SELECT student_username, answers, score, submitted_at, graded, ai_pending
           FROM interaction_quiz_answers WHERE quiz_id = ?""",
        (quiz_id,),
    )

    # S9: 每份答卷只解析一次并按题号建索引(旧实现是"题数 × 人数"次重复 json.loads)
    # S-GRADING(P3): 同时带上逐题批改留痕, 简答题的对错以 AI 判定为准
    parsed: list[tuple[Any, dict[int, str], dict[str, Any]]] = []
    for a in answers:
        parsed.append((a, _answer_index_map(a[1]), _quiz_graded(a[4])))

    quiz_total = _quiz_total(questions)
    question_stats = _build_question_stats(questions, parsed)

    # 建立学生用户名→姓名/年级/班级映射（批量查询，班级优先用 classes.display_name）
    usernames = [a[0] for a in answers]
    stu_map: dict[str, dict] = {}
    if usernames:
        placeholders = ",".join("?" * len(usernames))
        name_rows = execute_query(
            f"SELECT username, name, grade, class, class_id FROM users WHERE username IN ({placeholders})",
            tuple(usernames),
        )
        class_ids = sorted({r[4] for r in name_rows if r[4]})
        cdisp: dict = {}
        if class_ids:
            cph = ",".join("?" * len(class_ids))
            for cid, dname in execute_query(f"SELECT id, display_name FROM classes WHERE id IN ({cph})", tuple(class_ids)):
                cdisp[cid] = dname
        for r in name_rows:
            cls_disp = cdisp.get(r[4]) if r[4] else None
            if not cls_disp:
                raw_cls = str(r[3] or "").strip()
                if raw_cls:
                    cls_disp = raw_cls if ("班" in raw_cls or not raw_cls.isdigit()) else f"{raw_cls}班"
            stu_map[r[0]] = {"name": r[1] or r[0], "grade": str(r[2] or "").strip(), "class_name": (cls_disp or "").strip()}

    # R2/P0: 逐人成绩统一口径 —— 百分制折算 + 批改中的题不计入"答对题数"
    # 2026-10-16: 得分统一 100 分制：老测验(满分=题数)也折算过来，对外只给百分制，
    #   原始分另用 raw_score/raw_total_score 暴露（界面"原始分 3/5"提示与 CSV 导出读它）。
    cent_total = 100.0 if quiz_total > 0 else quiz_total
    student_answers = []
    for a, m, gm in parsed:
        pending_set = pending_keys(gm)
        correct_count = sum(
            1 for i2, q2 in enumerate(questions)
            if str(i2) not in pending_set and
            _is_question_correct(gm.get(str(i2)), m.get(i2, ""),
                                 str(q2.get("answer", "")).strip(), q2.get("type", "single"))
        )
        raw_score = float(a[2] or 0)
        cent = _centesimal(raw_score, quiz_total)
        student_answers.append({
            "student": a[0],
            "student_name": stu_map.get(a[0], {}).get("name", a[0]),
            "grade": stu_map.get(a[0], {}).get("grade", ""),
            "class_name": stu_map.get(a[0], {}).get("class_name", ""),
            "score": cent if cent is not None else round(raw_score, 1),   # 百分制
            "total_score": cent_total,                                    # 固定 100
            "raw_score": round(raw_score, 1),                             # 原始分(附注用)
            "raw_total_score": quiz_total,                                # 原始满分
            # R2(Step A): 前端只读这个字段, 不再各自 Math.round(score/total*100)
            "percentage": cent,
            "submitted_at": a[3],
            "correct_count": correct_count,
            "total_questions": len(questions),
            "graded_questions": max(len(questions) - len(pending_set), 0),
            "pending_ai": len(pending_set),
            "pending_review": sum(1 for v in gm.values()
                                  if isinstance(v, dict) and v.get("needs_review")),
        })
    rates = [s["percentage"] for s in student_answers
             if not s["pending_ai"] and s["percentage"] is not None]

    return {
        # P2-14: 显式声明视角(前端不必再靠 quiz_title 是否存在来判断)
        "view": "teacher",
        "quiz": {
            "id": quiz_row.get("id"),
            "title": quiz_row.get("title"),
            "question_count": len(questions),
            # R2 + 2026-10-16: 对外满分统一 100（老测验的"满分=题数"只留在 raw_total_score）
            "total_score": cent_total,
            "pass_score": round(cent_total * 0.6, 1),
            "raw_total_score": quiz_total,
        },
        "total_answers": len(answers),
        # 班级整体统计(与同步练习详情同口径)
        "stats": {
            "submitted_count": len(answers),
            "graded_count": sum(1 for s in student_answers if not s["pending_ai"]),
            "avg_score": round(sum(s["score"] or 0 for s in student_answers) / max(len(student_answers), 1), 1),
            "avg_rate": round(sum(rates) / len(rates), 1) if rates else None,
            "high_rate": max(rates) if rates else None,
            "low_rate": min(rates) if rates else None,
            "pass_rate": round(sum(1 for r in rates if r >= 60) / len(rates) * 100, 1) if rates else None,
        },
        # S-GRADING(P3): 整场测验还有多少题在后台批改(教师可催批)
        "pending_ai_total": sum(len(pending_keys(gm)) for _a, _m, gm in parsed),
        "pending_review_total": sum(
            1 for _a, _m, gm in parsed for v in gm.values()
            if isinstance(v, dict) and v.get("needs_review")),
        "question_stats": question_stats,
        "student_answers": student_answers,
    }


# ── 快速投票 ──

@router.post("/polls", summary="创建快速投票")
async def create_poll(req: PollCreate, request: Request):
    """教师创建快速投票"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可创建投票")

    if len(req.options) < 2:
        raise HTTPException(status_code=400, detail="至少需要2个选项")

    if req.poll_type not in ("single", "multiple"):
        raise HTTPException(status_code=400, detail="poll_type 必须是 single 或 multiple")

    # R5: 发布范围必须落在本人任教范围内(与公告共用同一道闸)
    from backend.api.notification_router import validate_activity_scope
    validate_activity_scope(user, req.target_scope, req.target_grade, req.target_class,
                            req.target_users, what="投票")



    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    poll_id = execute_insert_update(
        """INSERT INTO interaction_polls (creator_username, question, options, poll_type, status, created_at,
                                          subject, target_scope, target_grade, target_class, target_users)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)""",
        (user["username"], req.question, json.dumps(req.options, ensure_ascii=False), req.poll_type, now,
         (req.subject or "").strip(),
         req.target_scope, req.target_grade, req.target_class, req.target_users),
    )

    # ── 异步通知学生（不阻塞创建操作） ──
    async def _notify_poll():
        try:
            from backend.api.notification_router import notify_users_by_scope
            notify_users_by_scope(
                creator_username=user["username"],
                type_="info",
                title=f"新投票「{req.question}」已发布",
                content=f"共 {len(req.options)} 个选项，请参与投票",
                related_link="/interaction",
                target_scope=req.target_scope,
                target_grade=req.target_grade,
                target_class=req.target_class,
                target_users=req.target_users,
                source_type="poll",
                source_id=str(poll_id),
            )
        except Exception as e:
            logger.warning(f"发送投票通知失败: {e}")
    asyncio.create_task(_notify_poll())

    return {"message": "投票创建成功", "poll_id": poll_id}


@router.get("/polls", summary="获取活跃投票")
async def list_polls(request: Request):
    """获取当前活跃的投票列表"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]

    if role == 2:
        # 学生：获取所有活跃投票后按目标范围过滤
        s_grade, s_class = get_user_grade_class(username)
        # 注意：列顺序必须与后续索引访问一致
        all_rows = execute_query(
            """SELECT p.id, p.creator_username, p.question, p.options, p.poll_type, p.status, p.created_at,
                      p.target_scope, p.target_grade, p.target_class, p.target_users,
                      COALESCE(u.name, u.username) AS creator_name,
                      COALESCE(p.subject, '') AS subject
               FROM interaction_polls p
               JOIN users u ON p.creator_username = u.username AND u.role IN (0, 1)
               WHERE p.status = 'active'
               ORDER BY p.created_at DESC LIMIT 50""",
        )
        rows = []
        for r in all_rows:
            if check_activity_visibility(
                student_username=username,
                student_grade=s_grade,
                student_class=s_class,
                creator_username=r[1],
                target_scope=r[7] if len(r) > 7 else "teacher_classes",
                target_grade=r[8] if len(r) > 8 else "",
                target_class=r[9] if len(r) > 9 else "",
                target_users=r[10] if len(r) > 10 else "",
            ):
                rows.append(r)
    elif role == 1:
        # 教师：只看自己创建的投票
        rows = execute_query(
            """SELECT p.id, p.creator_username, p.question, p.options, p.poll_type, p.status, p.created_at,
                        p.target_scope, p.target_grade, p.target_class, p.target_users,
                        COALESCE(u.name, u.username) AS creator_name,
                      COALESCE(p.subject, '') AS subject
               FROM interaction_polls p
               LEFT JOIN users u ON p.creator_username = u.username
               WHERE p.status = 'active' AND p.creator_username = ?
               ORDER BY p.created_at DESC LIMIT 50""",
            (username,),
        )
    else:
        rows = execute_query(
            """SELECT p.id, p.creator_username, p.question, p.options, p.poll_type, p.status, p.created_at,
                        p.target_scope, p.target_grade, p.target_class, p.target_users,
                        COALESCE(u.name, u.username) AS creator_name,
                      COALESCE(p.subject, '') AS subject
               FROM interaction_polls p
               LEFT JOIN users u ON p.creator_username = u.username
               WHERE p.status = 'active'
               ORDER BY p.created_at DESC LIMIT 50""",
        )

    polls = []
    for r in rows:
        options = json.loads(r[3]) if isinstance(r[3], str) else r[3]
        poll_type = r[4] if r[4] else "single"
        # 学生/教师/管理员三条路径现同为同一列布局: 7-10 = target_*(scope/grade/class/users), 11 = creator_name
        creator_name = r[11] if len(r) > 11 else (r[7] if len(r) > 7 else r[1])
        vote_counts = []
        for i in range(len(options)):
            cnt = execute_query(
                "SELECT COUNT(*) FROM interaction_poll_votes WHERE poll_id = ? AND selected_option = ?",
                (r[0], i),
            )
            vote_counts.append(cnt[0][0] if cnt else 0)

        # 对于多选投票，计算每人投了几项
        total_votes = sum(vote_counts)
        unique_voters = 0
        if poll_type == "multiple":
            voters = execute_query(
                "SELECT COUNT(DISTINCT student_username) FROM interaction_poll_votes WHERE poll_id = ?",
                (r[0],),
            )
            unique_voters = voters[0][0] if voters else 0

        # 学生端标记是否已投票
        voted = False
        if role == 2:
            voted_row = execute_query(
                "SELECT COUNT(*) FROM interaction_poll_votes WHERE poll_id = ? AND student_username = ?",
                (r[0], username),
            )
            voted = (voted_row[0][0] if voted_row else 0) > 0

        polls.append({
            "id": r[0],
            "creator_username": r[1],
            "creator_name": creator_name,
            "question": r[2],
            "poll_type": poll_type,
            "options": [{"index": i, "text": opt, "votes": vote_counts[i]} for i, opt in enumerate(options)],
            "total_votes": total_votes,
            "unique_voters": unique_voters or total_votes,
            "voted": voted,
            "created_at": r[6],
            # 列表展示目标范围(年级/班级), 与考试/测验同口径
            "target_scope": (r[7] if len(r) > 10 else "") or "teacher_classes",
            "target_grade": (r[8] if len(r) > 10 else "") or "",
            "target_class": (r[9] if len(r) > 10 else "") or "",
            "target_users": (r[10] if len(r) > 10 else "") or "",
            # 学科：第 13 列（两条 SELECT 都加了；老查询没有这列时给空串）
            "subject": (r[12] if len(r) > 12 else "") or "",
        })

    return {"polls": polls}


@router.post("/polls/{poll_id}/vote", summary="提交投票")
async def submit_vote(
    poll_id: int,
    request: Request,
    option_index: int = Query(None, description="单选：选项索引"),
    option_indices: str = Query(None, description="多选：逗号分隔的选项索引，如 '0,2,3'"),
):
    """学生参与投票，支持单选和多选"""
    user = get_current_user(request)
    username = user["username"]

    poll_rows = execute_query_dict(
        "SELECT * FROM interaction_polls WHERE id = ? AND status = 'active'",
        (poll_id,),
    )
    if not poll_rows:
        raise HTTPException(status_code=404, detail="投票不存在或已结束")

    poll_row = poll_rows[0]

    # 学生只能参与自己权限范围内的投票
    role = user.get("role", 2)
    if role == 2:
        s_grade, s_class = get_user_grade_class(username)
        if not check_activity_visibility(
            student_username=username,
            student_grade=s_grade,
            student_class=s_class,
            creator_username=poll_row["creator_username"],
            target_scope=poll_row.get("target_scope", "") or "teacher_classes",
            target_grade=poll_row.get("target_grade", "") or "",
            target_class=poll_row.get("target_class", "") or "",
            target_users=poll_row.get("target_users", "") or "",
        ):
            raise HTTPException(status_code=403, detail="无权参与该投票")

    poll_type = poll_row.get("poll_type") or "single"
    options = json.loads(poll_row["options"]) if isinstance(poll_row["options"], str) else poll_row["options"]

    # 解析选择的选项
    selected_indices = []
    if poll_type == "single":
        if option_index is None:
            raise HTTPException(status_code=400, detail="请选择一个选项")
        selected_indices = [option_index]
    else:
        if not option_indices:
            raise HTTPException(status_code=400, detail="请至少选择一个选项")
        try:
            selected_indices = [int(i.strip()) for i in option_indices.split(",") if i.strip()]
        except ValueError:
            raise HTTPException(status_code=400, detail="选项索引格式错误")
        if not selected_indices:
            raise HTTPException(status_code=400, detail="请至少选择一个选项")

    # 验证所有选项索引
    for idx in selected_indices:
        if idx < 0 or idx >= len(options):
            raise HTTPException(status_code=400, detail=f"无效的选项索引: {idx}")

    # R9: 统一"改答案"口径 —— 旧实现单选直接报错、多选静默覆盖, 两种投票行为不一致。
    # 投票不是判分依据, 统一为"以最后一次为准"; 参与积分本身按 (学生,活动) 幂等, 不会因此刷分。
    existing = execute_query(
        "SELECT id FROM interaction_poll_votes WHERE poll_id = ? AND student_username = ?",
        (poll_id, username),
    )
    re_vote = bool(existing)
    if re_vote:
        execute_insert_update(
            "DELETE FROM interaction_poll_votes WHERE poll_id = ? AND student_username = ?",
            (poll_id, username),
        )

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if poll_type == "multiple":
        # 多选：先删后插，所有操作在同一个事务中执行
        ops: list[tuple[str, tuple[Any, ...]]] = [
            ("DELETE FROM interaction_poll_votes WHERE poll_id = ? AND student_username = ?", (poll_id, username)),
        ]
        for idx in selected_indices:
            ops.append((
                "INSERT INTO interaction_poll_votes (poll_id, student_username, selected_option, created_at) VALUES (?, ?, ?, ?)",
                (poll_id, username, idx, now),
            ))
        execute_batch(ops)
    else:
        # 单选：直接插入一条记录
        execute_insert_update(
            "INSERT INTO interaction_poll_votes (poll_id, student_username, selected_option, created_at) VALUES (?, ?, ?, ?)",
            (poll_id, username, selected_indices[0], now),
        )

    # ── 积分奖励 ──
    try:
        from backend.reward_engine import award_participation
        poll_title = poll_row["question"] or f"投票#{poll_id}"
        award_participation(username, "poll", str(poll_id), poll_title)
    except Exception:
        pass

    return {"message": "投票已更新" if re_vote else "投票成功",
            "selected_count": len(selected_indices), "updated": re_vote}


@router.get("/polls/{poll_id}/results", summary="查看投票结果")
async def get_poll_results(poll_id: int, request: Request):
    """获取投票实时结果"""
    # S8: 旧实现连登录都不要求, 未登录即可读到题目与各选项票数
    user = get_current_user(request)
    poll_rows = execute_query_dict(
        "SELECT * FROM interaction_polls WHERE id = ?",
        (poll_id,),
    )
    if not poll_rows:
        raise HTTPException(status_code=404, detail="投票不存在")

    poll_row = poll_rows[0]
    role = user.get("role", 2)
    allowed = _can_view_activity_results(user["username"], role, poll_row)
    if not allowed and role == 2:
        # R: 学生投票后点击“投票”按钮会拉取汇总结果（前端一直有此交互，
        # S8 收口后被误伤成 403“加载结果失败”）。仅返回去标识的汇总票数，
        # 且必须已投过票并落在该投票可见范围内才放行。
        voted_row = execute_query(
            "SELECT COUNT(*) FROM interaction_poll_votes WHERE poll_id = ? AND student_username = ?",
            (poll_id, user["username"]),
        )
        has_voted = (voted_row[0][0] if voted_row else 0) > 0
        if has_voted:
            s_grade, s_class = get_user_grade_class(user["username"])
            allowed = check_activity_visibility(
                student_username=user["username"],
                student_grade=s_grade,
                student_class=s_class,
                creator_username=poll_row["creator_username"],
                target_scope=poll_row.get("target_scope", "") or "teacher_classes",
                target_grade=poll_row.get("target_grade", "") or "",
                target_class=poll_row.get("target_class", "") or "",
                target_users=poll_row.get("target_users", "") or "",
            )
    if not allowed:
        raise HTTPException(status_code=403, detail="无权查看该投票结果")
    options = json.loads(poll_row["options"]) if isinstance(poll_row["options"], str) else poll_row["options"]
    # S8: 一次 GROUP BY 统计(旧实现每个选项一次查询)
    counts_map = {
        (r[0] if r[0] is not None else -1): r[1]
        for r in execute_query(
            "SELECT selected_option, COUNT(*) FROM interaction_poll_votes WHERE poll_id = ? GROUP BY selected_option",
            (poll_id,),
        )
    }
    vote_counts = [int(counts_map.get(i, 0)) for i in range(len(options))]

    total = sum(vote_counts)
    # 计算实际参与人数（去重）
    voters = execute_query(
        "SELECT COUNT(DISTINCT student_username) FROM interaction_poll_votes WHERE poll_id = ?",
        (poll_id,),
    )
    unique_voters = voters[0][0] if voters else 0
    poll_type = poll_row.get("poll_type") or "single"
    denominator = unique_voters if unique_voters > 0 else total
    return {
        "poll_id": poll_id,
        "question": poll_row["question"],
        "poll_type": poll_type,
        "options": [
            {"index": i, "text": opt, "votes": vote_counts[i],
             "percentage": round(vote_counts[i] / max(denominator, 1) * 100, 1)}
            for i, opt in enumerate(options)
        ],
        "total_votes": total,
        "unique_voters": unique_voters,
    }


# ── AI 内容审核 + 重复/频率限制（用于提问和回答的合规检查） ──

import time as _time
import hashlib as _hashlib

# 内容审核跟踪：username -> { rejected_hashes: set, rejection_count: int, window_start: float, blocked_until: float }
_content_review_tracker: dict[str, dict[str, Any]] = {}
_MAX_REJECTIONS = 3           # 时间窗口内最大拒绝次数
_WINDOW_SECONDS = 300         # 时间窗口（5分钟）
_BLOCK_SECONDS = 60           # 触发限制后封禁时长


def _check_review_rate_limit(username: str, content: str) -> tuple[bool, str]:
    """检查是否触发频率限制或重复提交，返回 (是否放行, 提示消息)"""
    now = _time.time()
    tracker = _content_review_tracker.setdefault(username, {
        "rejected_hashes": set(),
        "rejection_count": 0,
        "window_start": now,
        "blocked_until": 0,
    })

    # 1. 检查是否被临时封禁
    if now < tracker["blocked_until"]:
        remain = int(tracker["blocked_until"] - now)
        return False, f"提交过于频繁，请{remain}秒后再试"

    # 2. 检查时间窗口是否过期，过期则重置
    if now - tracker["window_start"] > _WINDOW_SECONDS:
        tracker["rejected_hashes"] = set()
        tracker["rejection_count"] = 0
        tracker["window_start"] = now

    # 3. 检查是否重复提交已被拒绝过的内容
    content_hash = _hashlib.md5(content.encode("utf-8")).hexdigest()
    if content_hash in tracker["rejected_hashes"]:
        return False, "该内容与之前被拒绝的内容相同，请修改后重新提交"

    return True, ""


def _record_rejection(username: str, content: str):
    """记录一次审核拒绝并扣除 2 分"""
    now = _time.time()
    tracker = _content_review_tracker.setdefault(username, {
        "rejected_hashes": set(),
        "rejection_count": 0,
        "window_start": now,
        "blocked_until": 0,
    })
    content_hash = _hashlib.md5(content.encode("utf-8")).hexdigest()
    tracker["rejected_hashes"].add(content_hash)
    tracker["rejection_count"] += 1

    # 扣除 2 分
    try:
        from backend.reward_engine import deduct_points
        deduct_points(username, "内容审核不通过", 2)
    except Exception:
        pass

    # 如果累计拒绝次数达到上限，临时封禁
    if tracker["rejection_count"] >= _MAX_REJECTIONS:
        tracker["blocked_until"] = now + _BLOCK_SECONDS
        logger.warning(f"用户 {username} 触发审核频率限制，封禁 {_BLOCK_SECONDS} 秒")


def _review_prompt(content: str, role: str) -> str:
    role_desc = "提问" if role == "question" else "回答"
    return (
        '你是一个课堂内容审核助手。请判断以下学生' + role_desc + '是否包含：\n'
        '1. 违反法律法规的内容\n'
        '2. 违反道德规范、社会公序良俗的内容\n'
        '3. 不文明用语、辱骂、攻击性、歧视性言论\n'
        '4. 色情、暴力、恐怖、血腥等内容\n'
        '5. 广告、垃圾信息\n\n'
        '学生' + role_desc + '：' + content + '\n\n'
        '请严格判断。只返回以下JSON格式（不要包含其他文字）：\n'
        '{"safe": true, "reason": ""} 或 {"safe": false, "reason": "简要说明违规原因（10字以内）"}'
    )


async def _ai_content_review_async(
    content: str, username: str, role: str = "question"
) -> tuple[bool, str]:
    """异步 AI 内容审核。

    旧实现直接在 async 路由里 `future.result()`，会把整个事件循环卡住 6～15 秒：
    同一时间其他学生的请求、甚至老师刷新列表都只能排队。这里改成
    `run_in_executor + asyncio.wait_for`，事件循环始终可响应其他请求。
    """
    # 先检查频率限制和重复提交（纯内存操作，很快）
    allowed, msg = _check_review_rate_limit(username, content)
    if not allowed:
        return False, msg

    api_key, _ = get_api_keys(username)
    if not api_key:
        return True, ""

    prompt = _review_prompt(content, role)
    try:
        from backend.api.ai_service import _ai_thread_pool
        from backend.api.discussion_router import _call_review_sync
        from backend import ai_json

        loop = asyncio.get_running_loop()
        result = await asyncio.wait_for(
            loop.run_in_executor(_ai_thread_pool, _call_review_sync, prompt, api_key),
            timeout=8,
        )
        jm = re.search(r'\{[^}]+\}', result or "")
        data = (ai_json.try_parse(jm.group()) if jm else None) or ai_json.try_parse(result or "") or {}
        if isinstance(data, dict) and not data.get("safe", True):
            _record_rejection(username, content)
            return False, data.get("reason", "内容不合规")
        return True, ""
    except asyncio.TimeoutError:
        logger.warning(f"AI 内容审核超时（8秒），已放行: user={username}")
        return True, ""
    except Exception:
        return True, ""


# ── 提问幂等 / 去重辅助 ──

_DAILY_QUESTION_LIMIT = 5
_QUESTION_DEDUP_WINDOW_SECONDS = 120
_QUESTION_COLUMNS = (
    "id, student_username, content, is_anonymous, status, answer, "
    "created_at, answered_at, answered_by, grade_id, class_id, "
    "subject, knowledge_point, is_pinned, is_featured, is_resolved, resolved_at, resolved_by"
)


def _normalize_question_content(content: str) -> str:
    """给去重用的归一化：忽略空白与大小写，避免「积分 」和「积分」算两条。"""
    return re.sub(r"\s+", "", content or "").strip().lower()


def _question_content_hash(content: str) -> str:
    return hashlib.sha256(_normalize_question_content(content).encode("utf-8")).hexdigest()


def _today_question_count(username: str) -> int:
    today_start = datetime.now().strftime("%Y-%m-%d") + " 00:00:00"
    rows = execute_query(
        "SELECT COUNT(*) FROM interaction_questions WHERE student_username = ? AND created_at >= ?",
        (username, today_start),
    )
    return int(rows[0][0]) if rows else 0


def _question_payload(
    row: dict[str, Any], *, role: int, username: str, duplicate: bool = False
) -> dict[str, Any]:
    """把 interaction_questions 行转成前端使用的结构（提问/重复提交共用）。"""
    qid = row["id"]
    student_username = row["student_username"]
    is_anonymous = bool(row["is_anonymous"])
    payload: dict[str, Any] = {
        "id": qid,
        "content": row["content"],
        "is_anonymous": is_anonymous,
        "status": row["status"],
        "answer": row["answer"] or "",
        "created_at": row["created_at"],
        "answered_at": row["answered_at"] or "",
        "answered_by": row["answered_by"] or "",
        "grade_id": row.get("grade_id"),
        "class_id": row.get("class_id"),
        "subject": row.get("subject") or "",
        "knowledge_point": row.get("knowledge_point") or "",
        "is_pinned": bool(row.get("is_pinned")),
        "is_featured": bool(row.get("is_featured")),
        "is_resolved": bool(row.get("is_resolved")),
        "resolved_at": row.get("resolved_at") or "",
        "resolved_by": row.get("resolved_by") or "",
        "student_answer_count": 0,
        "approved_answer_count": 0,
        "pending_answer_count": 0,
        "my_answer_status": None,
        "vote_count": 0,
        "my_voted": False,
        "followup_count": 0,
        "is_own": student_username == username,
    }
    if role != 2:
        # 匿名只对同学隐藏；教师/管理员始终能看到提问者
        payload["student_username"] = student_username

    counts = execute_query(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0), "
        "COALESCE(SUM(CASE WHEN status = 'pending_approval' THEN 1 ELSE 0 END), 0) "
        "FROM interaction_question_answers WHERE question_id = ?",
        (qid,),
    )
    if counts:
        payload["student_answer_count"] = int(counts[0][0] or 0)
        payload["approved_answer_count"] = int(counts[0][1] or 0)
        payload["pending_answer_count"] = int(counts[0][2] or 0)

    if role == 2:
        mine = execute_query(
            "SELECT status FROM interaction_question_answers WHERE question_id = ? AND student_username = ?",
            (qid, username),
        )
        if mine:
            payload["my_answer_status"] = mine[0][0]

    if duplicate:
        payload["duplicate"] = True
    return payload


def _find_question_by_request_id(username: str, request_id: str | None) -> dict[str, Any] | None:
    if not request_id:
        return None
    rows = execute_query_dict(
        f"SELECT {_QUESTION_COLUMNS} FROM interaction_questions "
        "WHERE student_username = ? AND client_request_id = ? LIMIT 1",
        (username, request_id),
    )
    return rows[0] if rows else None


def _find_recent_duplicate(
    username: str, content_hash: str, cutoff: str
) -> dict[str, Any] | None:
    rows = execute_query_dict(
        f"SELECT {_QUESTION_COLUMNS} FROM interaction_questions "
        "WHERE student_username = ? AND content_hash = ? AND created_at >= ? "
        "ORDER BY id DESC LIMIT 1",
        (username, content_hash, cutoff),
    )
    return rows[0] if rows else None


def _duplicate_question_response(
    row: dict[str, Any], *, role: int, username: str
) -> dict[str, Any]:
    return {
        "message": "该问题刚刚已提交，请勿重复提交",
        "duplicate": True,
        "question_id": row["id"],
        "question": _question_payload(row, role=role, username=username, duplicate=True),
    }


def _attach_question_answer_stats(
    questions: list[dict[str, Any]], *, role: int, username: str
) -> None:
    """批量补齐回答统计，避免列表里每道题 3 次查询（30 秒自动刷新时尤其明显）。"""
    if not questions:
        return
    qids = [q["id"] for q in questions]
    placeholders = ",".join("?" for _ in qids)
    stats = execute_query(
        "SELECT question_id, COUNT(*), "
        "COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0), "
        "COALESCE(SUM(CASE WHEN status = 'pending_approval' THEN 1 ELSE 0 END), 0) "
        f"FROM interaction_question_answers WHERE question_id IN ({placeholders}) "
        "GROUP BY question_id",
        tuple(qids),
    )
    stats_map = {r[0]: (int(r[1] or 0), int(r[2] or 0), int(r[3] or 0)) for r in stats}

    mine_map: dict[int, str] = {}
    if role == 2:
        mine = execute_query(
            "SELECT question_id, status FROM interaction_question_answers "
            f"WHERE question_id IN ({placeholders}) AND student_username = ?",
            tuple(qids + [username]),
        )
        mine_map = {r[0]: r[1] for r in mine}

    for q in questions:
        count, approved, pending = stats_map.get(q["id"], (0, 0, 0))
        q["student_answer_count"] = count
        q["approved_answer_count"] = approved
        q["pending_answer_count"] = pending
        q["my_answer_status"] = mine_map.get(q["id"])


def _attach_question_votes(
    questions: list[dict[str, Any]], *, role: int, username: str
) -> None:
    """批量补齐“我也想问”票数与当前学生是否已投。"""
    if not questions:
        return
    qids = [q["id"] for q in questions]
    placeholders = ",".join("?" for _ in qids)
    rows = execute_query(
        f"SELECT question_id, COUNT(*) FROM interaction_question_votes "
        f"WHERE question_id IN ({placeholders}) GROUP BY question_id",
        tuple(qids),
    )
    counts = {r[0]: int(r[1] or 0) for r in rows}
    voted: set[int] = set()
    if role == 2:
        rows = execute_query(
            f"SELECT question_id FROM interaction_question_votes "
            f"WHERE question_id IN ({placeholders}) AND student_username = ?",
            tuple(qids + [username]),
        )
        voted = {r[0] for r in rows}
    for q in questions:
        q["vote_count"] = counts.get(q["id"], 0)
        q["my_voted"] = q["id"] in voted


def _attach_question_followup_stats(questions: list[dict[str, Any]]) -> None:
    if not questions:
        return
    qids = [q["id"] for q in questions]
    placeholders = ",".join("?" for _ in qids)
    rows = execute_query(
        f"SELECT question_id, COUNT(*) FROM interaction_question_followups "
        f"WHERE question_id IN ({placeholders}) GROUP BY question_id",
        tuple(qids),
    )
    counts = {r[0]: int(r[1] or 0) for r in rows}
    for q in questions:
        q["followup_count"] = counts.get(q["id"], 0)


def _teacher_class_options(assignments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """教师端班级筛选选项：同一班级多学科只保留一条。"""
    grade_wide = {a["grade_id"] for a in assignments if a.get("class_id") is None}
    options = []
    seen = set()
    for a in assignments:
        gid = a["grade_id"]
        # 该年级有“整年级任教”时，只给一个整年级选项，避免下面再列具体班级造成误解
        cid = None if gid in grade_wide else a.get("class_id")
        key = (gid, cid)
        if key in seen:
            continue
        seen.add(key)
        options.append({
            "grade_id": gid,
            "class_id": cid,
            "grade_name": a.get("grade_name") or "",
            "class_name": "" if cid is None else (a.get("class_display_name") or a.get("class_name") or ""),
        })
    return options


def _get_student_scope(username: str) -> tuple[int | None, int | None]:
    """读取学生当前年级/班级；缺任何一项都返回 None，调用方必须按“仅本人”处理。"""
    rows = execute_query_dict(
        "SELECT grade_id, class_id FROM users WHERE username = ? AND role = 2",
        (username,),
    )
    if not rows:
        return None, None
    return rows[0].get("grade_id"), rows[0].get("class_id")


def _question_scope(question_id: int) -> tuple[str, int | None, int | None] | None:
    """返回 (提问者, 提问时 grade_id, 提问时 class_id)。"""
    rows = execute_query(
        "SELECT student_username, grade_id, class_id FROM interaction_questions WHERE id = ?",
        (question_id,),
    )
    if not rows:
        return None
    return rows[0][0], rows[0][1], rows[0][2]


def _scope_allows_user(scope: tuple[str, int | None, int | None], user: dict[str, Any]) -> bool:
    """按“提问时班级快照”判断可见性；旧数据缺快照时老师回退到当前学籍。"""
    asker, q_grade, q_class = scope
    role = user.get("role", 2)
    if role == 0:
        return True
    if role == 1:
        if q_grade and q_class:
            from backend.permission_service import can_access_class
            return can_access_class(user["username"], q_grade, q_class)
        from backend.permission_service import check_teacher_access_to_student
        return check_teacher_access_to_student(user["username"], asker)
    if asker == user["username"]:
        return True
    if not q_grade or not q_class:
        return False
    grade, cls = _get_student_scope(user["username"])
    return bool(grade and cls and grade == q_grade and cls == q_class)


def _can_view_question(question_id: int, user: dict[str, Any]) -> bool:
    """列表/详情/回答共用的可见性口径：管理员全部，教师任教范围，学生同班或本人。"""
    scope = _question_scope(question_id)
    return bool(scope and _scope_allows_user(scope, user))


def _can_manage_question(question_id: int, user: dict[str, Any]) -> bool:
    """编辑/删除等写操作：学生只能动自己的，教师只能动任教范围内的。"""
    scope = _question_scope(question_id)
    if not scope:
        return False
    asker = scope[0]
    role = user.get("role", 2)
    if role == 0:
        return True
    if role == 1:
        return _scope_allows_user(scope, user)
    return asker == user["username"]


# ── 课堂提问 ──

@router.post("/questions", summary="学生发起提问")
async def ask_question(req: QuestionCreate, request: Request):
    """学生在课堂上提问"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]
    content = (req.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="提问内容不能为空")
    if len(content) > 500:
        raise HTTPException(status_code=400, detail="问题最多 500 字")
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    request_id = (req.client_request_id or "").strip() or None

    # 1) 幂等：同一 client_request_id 直接返回已有问题（双击/网络重试）
    existing = _find_question_by_request_id(username, request_id)
    if existing:
        logger.info(f"提问幂等命中: user={username} request_id={request_id} qid={existing['id']}")
        return _duplicate_question_response(existing, role=role, username=username)

    # 2) 短时内容去重：同一学生 2 分钟内相同内容只入库一次
    content_hash = _question_content_hash(content)
    cutoff = (datetime.now() - timedelta(seconds=_QUESTION_DEDUP_WINDOW_SECONDS)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    existing = _find_recent_duplicate(username, content_hash, cutoff)
    if existing:
        logger.info(f"提问内容去重命中: user={username} qid={existing['id']} content={clip(content, 30)}")
        return _duplicate_question_response(existing, role=role, username=username)

    # 3) 每日提问上限检查（放在幂等之后：重试不会误报“次数已用完”）
    if role == 2 and _today_question_count(username) >= _DAILY_QUESTION_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=f"⚠️ 每日最多提 {_DAILY_QUESTION_LIMIT} 个问题，已达到今日上限。"
        )

    # 4) AI 内容审核（异步执行，不阻塞事件循环）
    safe, reason = await _ai_content_review_async(content, username, "question")
    if not safe:
        logger.info(f"学生 {username} 提问内容不合规已拦截: {reason}")
        raise HTTPException(
            status_code=400,
            detail=f"⚠️ 内容审核未通过：{reason}。请修改后重新提交。"
        )

    dedup_bucket = int(time.time() // _QUESTION_DEDUP_WINDOW_SECONDS)
    grade_id, class_id = _get_student_scope(username)
    try:
        qid = execute_insert_update(
            """INSERT INTO interaction_questions
               (student_username, content, is_anonymous, status, created_at,
                client_request_id, content_hash, dedup_bucket, grade_id, class_id,
                subject, knowledge_point)
               VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)""",
            (username, content, 1 if req.is_anonymous else 0, now,
             request_id, content_hash, dedup_bucket, grade_id, class_id,
             (req.subject or "").strip(), (req.knowledge_point or "").strip()),
        )
    except sqlite3.IntegrityError:
        # 并发双击：唯一索引兜底，返回已经入库的那一条
        existing = (
            _find_question_by_request_id(username, request_id)
            or _find_recent_duplicate(username, content_hash, cutoff)
        )
        if existing:
            logger.info(f"提问并发去重命中: user={username} qid={existing['id']}")
            return _duplicate_question_response(existing, role=role, username=username)
        raise

    asyncio.create_task(_broadcast_question_event(grade_id, class_id, "question_created", qid))

    # ── 积分奖励 ──
    try:
        from backend.reward_engine import award_participation
        award_participation(username, "question", str(qid), clip(content, 30))
    except Exception:
        pass

    # ── 异步通知教师（通过 teacher_assignments 精确匹配） ──
    async def _notify_question():
        try:
            from backend.api.notification_router import notify_users
            from backend.database import execute_query_dict as db_dict
            # 查询学生所在年级的 grade_id
            student = db_dict(
                "SELECT grade_id, class_id, grade, class FROM users WHERE username=?",
                (username,),
            )
            if student and student[0].get("grade_id"):
                s = student[0]
                gid = s["grade_id"]
                cid = s.get("class_id")
                # 查找所有在 teacher_assignments 中匹配该年级/班级的教师
                if cid:
                    assign_rows = db_dict(
                        """SELECT DISTINCT ta.teacher_username
                           FROM teacher_assignments ta
                           WHERE ta.grade_id=? AND (ta.class_id=? OR ta.class_id IS NULL)""",
                        (gid, cid),
                    )
                else:
                    assign_rows = db_dict(
                        """SELECT DISTINCT ta.teacher_username
                           FROM teacher_assignments ta
                           WHERE ta.grade_id=?""",
                        (gid,),
                    )
                teacher_usernames = [r["teacher_username"] for r in assign_rows]
                if teacher_usernames:
                    notify_users(
                        teacher_usernames, "info",
                        "新课堂提问",
                        f"学生提出了新问题：{clip(content)}",
                        "/interaction",
                        source_type="question",
                        source_id=str(qid),
                    )
        except Exception as e:
            logger.warning(f"发送提问通知失败: {e}")
    asyncio.create_task(_notify_question())

    rows = execute_query_dict(
        f"SELECT {_QUESTION_COLUMNS} FROM interaction_questions WHERE id = ?", (qid,)
    )
    question = (
        _question_payload(rows[0], role=role, username=username)
        if rows else {
            "id": qid, "content": content, "is_anonymous": bool(req.is_anonymous),
            "status": "pending", "answer": "", "created_at": now, "answered_at": "",
            "answered_by": "", "student_answer_count": 0, "approved_answer_count": 0,
            "pending_answer_count": 0, "subject": (req.subject or "").strip(),
            "knowledge_point": (req.knowledge_point or "").strip(),
            "is_pinned": False, "is_featured": False, "is_resolved": False,
            "resolved_at": "", "resolved_by": "",
            "vote_count": 0, "my_voted": False, "followup_count": 0,
            "my_answer_status": None, "is_own": True,
        }
    )
    return {
        "message": "提问成功",
        "duplicate": False,
        "question_id": qid,
        "question": question,
    }


@router.get("/questions", summary="获取课堂提问列表")
async def list_questions(
    request: Request,
    status: str = Query("", description="筛选状态"),
    mine: bool = Query(False, description="学生只看自己的提问"),
    grade_id: int | None = Query(None, description="按年级筛选（教师/管理员）"),
    class_id: int | None = Query(None, description="按班级筛选（教师/管理员）"),
    subject: str = Query("", description="按学科筛选"),
    keyword: str = Query("", description="按提问内容搜索"),
    answer_pending: bool = Query(False, description="只看有待审批学生回答的提问"),
    unresolved: bool = Query(False, description="只看未解决"),
    time_range: str = Query("", description="7d / 30d / 180d"),
    sort: str = Query("newest", description="newest / oldest / pending_first / hot"),
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=100, description="每页数量"),
):
    """获取课堂提问（学生看同班，教师看任教班级，管理员看全部）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]
    offset = (page - 1) * page_size

    conditions: list[str] = []
    params: list[Any] = []
    teacher_assignments: list[dict[str, Any]] = []

    if role == 2:
        grade, cls = _get_student_scope(username)
        if grade and cls:
            # 班级快照 + 本人：转班后仍能看到自己以前的提问
            conditions.append("(q.grade_id = ? AND q.class_id = ? OR q.student_username = ?)")
            params.extend([grade, cls, username])
        else:
            # 学生档案缺年级/班级时绝不能回落到全校：只展示自己的提问
            conditions.append("q.student_username = ?")
            params.append(username)
        if mine:
            conditions.append("q.student_username = ?")
            params.append(username)
    elif role == 1:
        from backend.permission_service import get_teacher_assignments
        teacher_assignments = get_teacher_assignments(username)
        if not teacher_assignments:
            return {
                "questions": [], "total": 0, "page": page, "page_size": page_size,
                "teacher_classes": [],
            }
        scoped = []
        for a in teacher_assignments:
            if grade_id is not None and a["grade_id"] != grade_id:
                continue
            if class_id is not None:
                a_cls = a.get("class_id")
                # 年级整包任教的老师也覆盖该年级下的任意班级
                if a_cls is not None and a_cls != class_id:
                    continue
            scoped.append(a)
        if not scoped:
            return {
                "questions": [], "total": 0, "page": page, "page_size": page_size,
                "teacher_classes": _teacher_class_options(teacher_assignments),
            }
        seen_scope = set()
        scope_parts = []
        for a in scoped:
            key = (a["grade_id"], a.get("class_id"))
            if key in seen_scope:
                continue
            seen_scope.add(key)
            if a.get("class_id"):
                scope_parts.append("(q.grade_id = ? AND q.class_id = ?)")
                params.extend([a["grade_id"], a["class_id"]])
            else:
                scope_parts.append("(q.grade_id = ?)")
                params.append(a["grade_id"])
        conditions.append("(" + " OR ".join(scope_parts) + ")")
    else:
        if grade_id is not None:
            conditions.append("q.grade_id = ?")
            params.append(grade_id)
        if class_id is not None:
            conditions.append("q.class_id = ?")
            params.append(class_id)

    if status:
        conditions.append("q.status = ?")
        params.append(status)

    keyword = (keyword or "").strip()
    if keyword:
        like = f"%{keyword}%"
        conditions.append("(q.content LIKE ? OR q.subject LIKE ? OR q.knowledge_point LIKE ?)")
        params.extend([like, like, like])

    subject = (subject or "").strip()
    if subject:
        conditions.append("q.subject = ?")
        params.append(subject)

    if unresolved:
        conditions.append("COALESCE(q.is_resolved, 0) = 0")

    if time_range in ("7d", "30d", "180d"):
        days = {"7d": 7, "30d": 30, "180d": 180}[time_range]
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
        conditions.append("q.created_at >= ?")
        params.append(cutoff)

    if answer_pending:
        conditions.append(
            "EXISTS (SELECT 1 FROM interaction_question_answers a "
            "WHERE a.question_id = q.id AND a.status = 'pending_approval')"
        )

    where = " AND ".join(conditions) if conditions else "1=1"
    order = ("COALESCE(q.is_pinned, 0) DESC, COALESCE(q.is_featured, 0) DESC, "
             "q.created_at DESC")
    if sort == "oldest":
        order = ("COALESCE(q.is_pinned, 0) DESC, COALESCE(q.is_featured, 0) DESC, "
                 "q.created_at ASC")
    elif sort == "pending_first":
        order = ("COALESCE(q.is_pinned, 0) DESC, COALESCE(q.is_featured, 0) DESC, "
                 "CASE WHEN q.status = 'pending' THEN 0 ELSE 1 END, q.created_at DESC")
    elif sort == "hot":
        order = ("COALESCE(q.is_pinned, 0) DESC, COALESCE(q.is_featured, 0) DESC, "
                 "(SELECT COUNT(*) FROM interaction_question_votes v "
                 "WHERE v.question_id = q.id) DESC, q.created_at DESC")

    rows = execute_query_dict(
        f"""SELECT q.id, q.student_username, q.content, q.is_anonymous, q.status,
                   q.answer, q.created_at, q.answered_at, q.answered_by,
                   q.grade_id, q.class_id, q.subject, q.knowledge_point,
                   q.is_pinned, q.is_featured, q.is_resolved, q.resolved_at, q.resolved_by
            FROM interaction_questions q
            WHERE {where}
            ORDER BY {order} LIMIT ? OFFSET ?""",
        tuple(params + [page_size, offset]),
    )
    count_rows = execute_query(
        f"SELECT COUNT(*) FROM interaction_questions q WHERE {where}",
        tuple(params),
    )
    total = count_rows[0][0] if count_rows else 0

    questions = []
    for r in rows:
        q = {
            "id": r["id"],
            "content": r["content"],
            "is_anonymous": bool(r["is_anonymous"]),
            "status": r["status"],
            "answer": r["answer"] or "",
            "created_at": r["created_at"],
            "answered_at": r["answered_at"] or "",
            "answered_by": r["answered_by"] or "",
            "grade_id": r.get("grade_id"),
            "class_id": r.get("class_id"),
            "subject": r.get("subject") or "",
            "knowledge_point": r.get("knowledge_point") or "",
            "is_pinned": bool(r.get("is_pinned")),
            "is_featured": bool(r.get("is_featured")),
            "is_resolved": bool(r.get("is_resolved")),
            "resolved_at": r.get("resolved_at") or "",
            "resolved_by": r.get("resolved_by") or "",
            "vote_count": 0,
            "my_voted": False,
            "followup_count": 0,
        }
        if role != 2:
            # 匿名只对同学隐藏；老师仍能看到提问者，便于课后跟进
            q["student_username"] = r["student_username"]
        else:
            q["is_own"] = (r["student_username"] == username)
            if not r["is_anonymous"]:
                q["student_username"] = r["student_username"]
        questions.append(q)

    _attach_question_answer_stats(questions, role=role, username=username)
    _attach_question_votes(questions, role=role, username=username)
    _attach_question_followup_stats(questions)

    # 提问管理: 补上学号对应的姓名/年级/班级
    from backend.permission_service import attach_student_info
    attach_student_info(questions, key="student_username", prefix="student_")

    response: dict[str, Any] = {
        "questions": questions, "total": total, "page": page, "page_size": page_size,
    }
    if role == 2:
        used = _today_question_count(username)
        response["quota"] = {
            "limit": _DAILY_QUESTION_LIMIT,
            "used": used,
            "remaining": max(0, _DAILY_QUESTION_LIMIT - used),
        }
    elif role == 1:
        response["teacher_classes"] = _teacher_class_options(teacher_assignments)
    return response


@router.post("/questions/{question_id}/vote", summary="我也想问（学生点赞/取消）")
async def toggle_question_vote(question_id: int, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]
    if role != 2:
        raise HTTPException(status_code=403, detail="仅学生可以点赞提问")
    if not _can_view_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权查看该提问")
    scope = _question_scope(question_id)
    if not scope:
        raise HTTPException(status_code=404, detail="提问不存在")
    if scope[0] == username:
        raise HTTPException(status_code=400, detail="不能给自己的提问点赞")

    existing = execute_query(
        "SELECT id FROM interaction_question_votes WHERE question_id = ? AND student_username = ?",
        (question_id, username),
    )
    if existing:
        execute_insert_update(
            "DELETE FROM interaction_question_votes WHERE question_id = ? AND student_username = ?",
            (question_id, username),
        )
        voted = False
    else:
        try:
            execute_insert_update(
                "INSERT INTO interaction_question_votes (question_id, student_username, created_at) "
                "VALUES (?, ?, ?)",
                (question_id, username, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            )
        except sqlite3.IntegrityError:
            pass  # 并发双击已经投上，按已投处理
        voted = True
    rows = execute_query(
        "SELECT COUNT(*) FROM interaction_question_votes WHERE question_id = ?",
        (question_id,),
    )
    asyncio.create_task(
        _broadcast_question_event(scope[1], scope[2], "question_updated", question_id)
    )
    return {"voted": voted, "vote_count": int(rows[0][0] or 0) if rows else 0}


@router.put("/questions/{question_id}/pin", summary="置顶/取消置顶提问")
async def pin_question(question_id: int, req: QuestionPin, request: Request):
    user = get_current_user(request)
    if user.get("role", 2) == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可置顶")
    scope = _question_scope(question_id)
    if not scope:
        raise HTTPException(status_code=404, detail="提问不存在")
    if not _can_manage_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权操作该提问")
    execute_insert_update(
        "UPDATE interaction_questions SET is_pinned = ? WHERE id = ?",
        (1 if req.pinned else 0, question_id),
    )
    asyncio.create_task(
        _broadcast_question_event(scope[1], scope[2], "question_updated", question_id)
    )
    return {"is_pinned": bool(req.pinned)}


@router.put("/questions/{question_id}/feature", summary="设为精华/取消精华")
async def feature_question(question_id: int, req: QuestionFeature, request: Request):
    user = get_current_user(request)
    if user.get("role", 2) == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可设精华")
    scope = _question_scope(question_id)
    if not scope:
        raise HTTPException(status_code=404, detail="提问不存在")
    if not _can_manage_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权操作该提问")
    execute_insert_update(
        "UPDATE interaction_questions SET is_featured = ? WHERE id = ?",
        (1 if req.featured else 0, question_id),
    )
    asyncio.create_task(
        _broadcast_question_event(scope[1], scope[2], "question_updated", question_id)
    )
    return {"is_featured": bool(req.featured)}


@router.put("/questions/{question_id}/resolve", summary="标记已解决/未解决")
async def resolve_question(question_id: int, req: QuestionResolve, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]
    scope = _question_scope(question_id)
    if not scope:
        raise HTTPException(status_code=404, detail="提问不存在")
    if role == 2 and scope[0] != username:
        raise HTTPException(status_code=403, detail="只有提问者可以标记解决")
    if role == 1 and not _can_manage_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权操作该提问")
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if req.resolved:
        execute_insert_update(
            "UPDATE interaction_questions SET is_resolved = 1, resolved_at = ?, resolved_by = ? "
            "WHERE id = ?",
            (now, username, question_id),
        )
    else:
        execute_insert_update(
            "UPDATE interaction_questions SET is_resolved = 0, resolved_at = '', resolved_by = '' "
            "WHERE id = ?",
            (question_id,),
        )
    asyncio.create_task(
        _broadcast_question_event(scope[1], scope[2], "question_updated", question_id)
    )
    return {"is_resolved": bool(req.resolved)}


@router.get("/questions/{question_id}/followups", summary="获取追问列表")
async def list_question_followups(question_id: int, request: Request):
    user = get_current_user(request)
    if not _can_view_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权查看该提问")
    rows = execute_query_dict(
        "SELECT id, username, content, created_at FROM interaction_question_followups "
        "WHERE question_id = ? ORDER BY created_at ASC",
        (question_id,),
    )
    from backend.permission_service import attach_student_info
    attach_student_info(rows, key="username", prefix="student_")
    return {"followups": rows}


@router.post("/questions/{question_id}/followups", summary="新增追问")
async def add_question_followup(
    question_id: int, req: QuestionFollowupCreate, request: Request
):
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]
    scope = _question_scope(question_id)
    if not scope:
        raise HTTPException(status_code=404, detail="提问不存在")
    if role == 2 and scope[0] != username:
        raise HTTPException(status_code=403, detail="只有提问者可以追问")
    if role == 1 and not _can_manage_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权追问该提问")
    content = (req.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="追问内容不能为空")
    safe, reason = await _ai_content_review_async(content, username, "answer")
    if not safe:
        raise HTTPException(
            status_code=400,
            detail=f"⚠️ 追问审核未通过：{reason}。请修改后重新提交。",
        )
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    fid = execute_insert_update(
        "INSERT INTO interaction_question_followups (question_id, username, content, created_at) "
        "VALUES (?, ?, ?, ?)",
        (question_id, username, content, now),
    )
    if username != scope[0]:
        try:
            from backend.api.notification_router import create_notification
            create_notification(
                scope[0], "info", "你的提问有新追问", clip(content),
                "/interaction", source_type="question", source_id=str(question_id),
            )
        except Exception as e:
            logger.warning(f"发送追问通知失败: {e}")
    asyncio.create_task(
        _broadcast_question_event(scope[1], scope[2], "question_updated", question_id)
    )
    return {"id": fid, "message": "追问已发送"}


def _question_rooms(grade_id: int | None, class_id: int | None) -> list[str]:
    rooms = [ADMIN_ROOM]
    if grade_id and class_id:
        rooms.append(class_room(int(grade_id), int(class_id)))
    return rooms


async def _broadcast_question_event(
    grade_id: int | None, class_id: int | None, event: str, question_id: int
) -> None:
    try:
        await question_ws.broadcast(
            _question_rooms(grade_id, class_id),
            {"type": event, "question_id": question_id},
        )
    except Exception as e:
        logger.debug(f"[提问WS] 广播失败: {e}")


@router.websocket("/questions/ws")
async def questions_ws(websocket: WebSocket, token: str = ""):
    """课堂提问实时推送。客户端带 token 连接，收到 question_* 事件后刷新列表。"""
    from backend.auth import verify_token
    from backend.ws_reject import close_hint, reject_websocket

    raw_token = token or websocket.query_params.get("token", "")
    payload, auth_code = verify_token(raw_token)
    if not payload or not payload.get("username"):
        # 现场(2026-10-21)是挂机页面攥着已被顶下线的旧 token_version 每 5 秒撞一次
        # 握手。accept 之前 close() 只会被 uvicorn 当成 HTTP 403，浏览器拿到的是没有
        # 原因的 1006，前端"未认证就别重连"的判断触发不了 —— 必须先握手再按 4401 关闭
        # （见 backend/ws_reject.py），同时只留一行限流后的可排查记录。
        code, reason = close_hint(auth_code)
        await reject_websocket(
            websocket, code=code, reason=reason, where="提问WS",
            token=raw_token, auth_code=auth_code,
        )
        return
    username = payload["username"]
    role = payload.get("role", 2)
    rooms: list[str] = []
    if role == 0:
        rooms = [ADMIN_ROOM]
    elif role == 1:
        from backend.permission_service import get_teacher_assignments
        seen = set()
        for a in get_teacher_assignments(username):
            gid = a["grade_id"]
            cid = a.get("class_id")
            if cid:
                key = (gid, cid)
                if key not in seen:
                    rooms.append(class_room(gid, cid))
                    seen.add(key)
            else:
                # 整年级任教：订阅该年级所有班级
                for row in execute_query("SELECT id FROM classes WHERE grade_id = ?", (gid,)):
                    key = (gid, row[0])
                    if key not in seen:
                        rooms.append(class_room(gid, row[0]))
                        seen.add(key)
        if not rooms:
            rooms = [f"question:teacher:{username}"]
    else:
        gid, cid = _get_student_scope(username)
        rooms = [class_room(gid, cid)] if gid and cid else [f"question:user:{username}"]

    await question_ws.connect(rooms, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        question_ws.disconnect(rooms, websocket)
    except Exception:
        question_ws.disconnect(rooms, websocket)


# ── 多学生回答：每个学生限答一次，教师按回答审批 ──

@router.put("/questions/{question_id}/answer", summary="回答提问（教师直接通过，学生写入多回答表）")
async def answer_question(question_id: int, req: QuestionAnswer, request: Request):
    """回答学生提问。教师直接写入主表；学生写入 interaction_question_answers（每人限答一次）。"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]

    if not req.answer or not req.answer.strip():
        raise HTTPException(status_code=400, detail="回答内容不能为空")

    # 查询提问信息
    question_rows = execute_query(
        "SELECT student_username, content, status, answer, answered_by, grade_id, class_id "
        "FROM interaction_questions WHERE id = ?",
        (question_id,),
    )
    if not question_rows:
        raise HTTPException(status_code=404, detail="提问不存在")
    asker_username = question_rows[0][0]
    question_content = question_rows[0][1]
    q_status = question_rows[0][2]
    q_answer = question_rows[0][3] or ""
    q_answered_by = question_rows[0][4] or ""
    q_grade_id = question_rows[0][5]
    q_class_id = question_rows[0][6]

    # 学生：不能回答已标记为已答的问题（教师已答或已审批通过）
    if role == 2 and q_status == "answered":
        raise HTTPException(status_code=400, detail="该问题已被回答")

    # 教师/管理员：允许覆盖/更新自己的回答（与学生回答独立）
    if role != 2 and q_answer and q_answered_by != username:
        # 其他教师/管理员已回答过，询问是否覆盖
        pass  # 允许覆盖

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if role == 2:
        # ── 学生回答：写入多回答表 ──
        if username == asker_username:
            raise HTTPException(status_code=403, detail="不能回答自己的提问")

        # 班级验证：按提问时班级快照判断（转班后仍由原班同学回答）
        if not _can_view_question(question_id, user):
            raise HTTPException(status_code=403, detail="只能回答同班同学的提问")

        # ── AI 内容审核 ──
        safe, reason = await _ai_content_review_async(req.answer, username, "answer")
        if not safe:
            logger.info(f"学生 {username} 回答内容不合规已拦截: {reason}")
            raise HTTPException(
                status_code=400,
                detail=f"⚠️ 回答审核未通过：{reason}。请修改后重新提交。"
            )

        # INSERT OR REPLACE：每人限答一次
        execute_insert_update(
            """INSERT OR REPLACE INTO interaction_question_answers
               (question_id, student_username, answer, status, created_at)
               VALUES (?, ?, ?, 'pending_approval', ?)""",
            (question_id, username, req.answer, now),
        )

        # ── 积分奖励：参与回答 ──
        try:
            from backend.reward_engine import award_participation
            award_participation(username, "question", str(question_id),
                                f"回答：{clip(question_content, 30)}")
        except Exception:
            pass

        # ── 通知提问学生 ──
        try:
            from backend.api.notification_router import create_notification
            create_notification(asker_username, "info",
                "你的提问收到同学回答（待教师审批）",
                f"问题：{clip(question_content)}",
                "/interaction",
                source_type="question",
                source_id=str(question_id))
        except Exception as e:
            logger.warning(f"发送回答通知失败: {e}")

        # ── 通知教师审批（通过 teacher_assignments 精确匹配）──
        try:
            from backend.api.notification_router import notify_users
            from backend.database import execute_query_dict as db_dict
            from backend.permission_service import get_teachers_for_student
            if q_grade_id and q_class_id:
                rows = db_dict(
                    """SELECT DISTINCT teacher_username FROM teacher_assignments
                       WHERE grade_id=? AND (class_id=? OR class_id IS NULL)""",
                    (q_grade_id, q_class_id),
                )
                teachers = [r["teacher_username"] for r in rows]
            else:
                teachers = get_teachers_for_student(asker_username)
            if teachers:
                notify_users(teachers, "info",
                    "有学生回答了提问，需要审批",
                    f"问题：{clip(question_content)}",
                    "/interaction",
                    source_type="question",
                    source_id=str(question_id))
        except Exception as e:
            logger.warning(f"发送审批通知失败: {e}")

        asyncio.create_task(
            _broadcast_question_event(q_grade_id, q_class_id, "question_updated", question_id)
        )
        return {"message": "回答已提交，等待教师审批"}

    # ── 教师/管理员回答：直接写入主表 ──
    if role == 1 and not _can_view_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权回答非本班学生的提问")

    execute_insert_update(
        """UPDATE interaction_questions SET answer = ?, status = 'answered',
           answered_at = ?, answered_by = ? WHERE id = ?""",
        (req.answer, now, username, question_id),
    )

    try:
        from backend.api.notification_router import create_notification
        create_notification(asker_username, "info",
            "你的提问已被教师回答",
            f"问题：{clip(question_content)}",
            "/interaction",
                source_type="question",
                source_id=str(question_id))
    except Exception as e:
        logger.warning(f"发送回答通知失败: {e}")

    asyncio.create_task(
        _broadcast_question_event(q_grade_id, q_class_id, "question_updated", question_id)
    )
    return {"message": "回答成功"}


# ── 获取某个问题的所有学生回答（教师看全部，学生看已通过的） ──

@router.get("/questions/{question_id}/answers", summary="获取问题的学生回答列表")
async def list_question_answers(question_id: int, request: Request):
    """获取某个问题的所有学生回答。教师看全部，学生看已通过的和自己的。"""
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]

    # 验证问题存在
    q = execute_query("SELECT id FROM interaction_questions WHERE id = ?", (question_id,))
    if not q:
        raise HTTPException(status_code=404, detail="提问不存在")
    if not _can_view_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权查看该提问的回答")

    if role == 2:
        # 学生：看所有已通过的 + 自己的（含待审批/已拒绝）
        rows = execute_query(
            """SELECT id, student_username, answer, status, created_at
               FROM interaction_question_answers
               WHERE question_id = ? AND (status = 'approved' OR student_username = ?)
               ORDER BY created_at DESC""",
            (question_id, username),
        )
    else:
        # 教师/管理员：看全部
        rows = execute_query(
            """SELECT a.id, a.student_username, a.answer, a.status, a.created_at
               FROM interaction_question_answers a
               JOIN users u ON a.student_username = u.username AND u.role = 2
               WHERE a.question_id = ?
               ORDER BY a.created_at DESC""",
            (question_id,),
        )

    answers = []
    for r in rows:
        ans = {
            "id": r[0],
            "student_username": r[1],
            "answer": r[2],
            "status": r[3],
            "created_at": r[4],
        }
        answers.append(ans)

    # 回答列表同样补学生身份
    from backend.permission_service import attach_student_info
    attach_student_info(answers, key="student_username", prefix="student_")
    return {"answers": answers}


# ── 教师逐条审批学生回答 ──

@router.put("/questions/{question_id}/answers/{answer_id}/approve", summary="教师审批通过某条学生回答")
async def approve_student_answer(question_id: int, answer_id: int, request: Request):
    """教师审批通过某条学生回答"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可审批")

    # 查询该回答
    answer_row = execute_query(
        """SELECT a.id, a.student_username, a.answer, q.content, q.student_username
           FROM interaction_question_answers a
           JOIN interaction_questions q ON a.question_id = q.id
           WHERE a.id = ? AND a.question_id = ?""",
        (answer_id, question_id),
    )
    if not answer_row:
        raise HTTPException(status_code=404, detail="回答不存在")
    answer_username = answer_row[0][1]
    question_content = answer_row[0][3]
    asker_username = answer_row[0][4]

    # 教师：验证该提问来自自己班级
    if role == 1 and not _can_manage_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权审批该提问")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_insert_update(
        "UPDATE interaction_question_answers SET status = 'approved' WHERE id = ?",
        (answer_id,),
    )
    # 标记问题已回答（但不覆盖主表 answer 字段，多个学生回答各自独立展示）
    execute_insert_update(
        """UPDATE interaction_questions SET status = 'answered',
           answered_at = COALESCE(answered_at, ?) WHERE id = ?""",
        (now, question_id),
    )

    # ── 积分奖励：回答被审批通过 ──
    try:
        from backend.reward_engine import award_participation
        # 用 question_id + answer_id 作为唯一标识，确保不被重复发放
        award_participation(answer_username, "question",
            f"{question_id}_{answer_id}",
            f"回答被审批通过：{clip(question_content, 30)}",
            teacher_username=user["username"])
    except Exception:
        pass

    # ── 通知回答者 ──
    try:
        from backend.api.notification_router import create_notification
        create_notification(answer_username, "info",
            "你的回答已通过教师审批",
            f"问题：{clip(question_content)}",
            "/interaction",
                source_type="question",
                source_id=str(question_id))
    except Exception as e:
        logger.warning(f"发送审批通过通知失败: {e}")

    # ── 通知提问者 ──
    try:
        from backend.api.notification_router import create_notification
        create_notification(asker_username, "info",
            "你的提问已有回答（已通过教师审批）",
            f"问题：{clip(question_content)}",
            "/interaction",
                source_type="question",
                source_id=str(question_id))
    except Exception as e:
        logger.warning(f"发送审批通知失败: {e}")

    scope = _question_scope(question_id)
    if scope:
        asyncio.create_task(
            _broadcast_question_event(scope[1], scope[2], "question_updated", question_id)
        )
    return {"message": "审批通过"}


@router.put("/questions/{question_id}/answers/{answer_id}/reject", summary="教师拒绝某条学生回答")
async def reject_student_answer(question_id: int, answer_id: int, request: Request):
    """教师拒绝某条学生回答，该学生仍可重新回答"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可审批")

    answer_row = execute_query(
        """SELECT a.id, a.student_username, q.content
           FROM interaction_question_answers a
           JOIN interaction_questions q ON a.question_id = q.id
           WHERE a.id = ? AND a.question_id = ?""",
        (answer_id, question_id),
    )
    if not answer_row:
        raise HTTPException(status_code=404, detail="回答不存在")
    answer_username = answer_row[0][1]
    question_content = answer_row[0][2]

    if role == 1 and not _can_manage_question(question_id, user):
        raise HTTPException(status_code=403, detail="无权审批该提问")

    execute_insert_update(
        "UPDATE interaction_question_answers SET status = 'rejected' WHERE id = ?",
        (answer_id,),
    )

    # ── 通知回答者 ──
    try:
        from backend.api.notification_router import create_notification
        create_notification(answer_username, "info",
            "你的回答未通过教师审批，可重新回答",
            f"问题：{clip(question_content)}",
            "/interaction",
                source_type="question",
                source_id=str(question_id))
    except Exception as e:
        logger.warning(f"发送拒绝通知失败: {e}")

    scope = _question_scope(question_id)
    if scope:
        asyncio.create_task(
            _broadcast_question_event(scope[1], scope[2], "question_updated", question_id)
        )
    return {"message": "已拒绝"}


# ═══════════════════════════════════════════════════════════
# V3.4 新增：AI 实时答题分析
# ═══════════════════════════════════════════════════════════

@router.get("/quizzes/{quiz_id}/ai-analysis", summary="AI 实时答题分析")
async def ai_quiz_analysis(quiz_id: int, request: Request):
    """AI 分析随堂测验结果，生成教学建议"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    quiz_row0 = _get_quiz_row(quiz_id)
    if not quiz_row0:
        raise HTTPException(status_code=404, detail="测验不存在")
    # S4: AI 学情分析含逐人成绩, 同样需要范围校验
    if not _can_view_activity_results(user["username"], role, quiz_row0):
        raise HTTPException(status_code=403, detail="无权分析该测验的答题数据")

    questions = _quiz_questions(quiz_row0)

    answers = execute_query(
        "SELECT student_username, answers, score, graded FROM interaction_quiz_answers WHERE quiz_id = ?",
        (quiz_id,),
    )
    # S9: 每份答卷只解析一次; R2-c: 带批改留痕, 与 /results 共用同一份统计口径
    parsed_list = []
    for a in answers:
        try:
            ua_list = json.loads(a[1]) if isinstance(a[1], str) else (a[1] or [])
        except (json.JSONDecodeError, TypeError):
            ua_list = []
        idx_map = {}
        if isinstance(ua_list, list):
            for ua in ua_list:
                if isinstance(ua, dict) and ua.get("question_index") is not None:
                    try:
                        idx_map[int(ua["question_index"])] = str(ua.get("answer", "")).strip()
                    except (TypeError, ValueError):
                        continue
        parsed_list.append((a, idx_map, _quiz_graded(a[3])))

    participant_count = len(answers)
    total_possible = _quiz_total(questions)

    # 每题正确率统计 —— 唯一口径(与 /results 完全一致)
    shared_stats = _build_question_stats(questions, parsed_list)
    question_stats = []
    for st in shared_stats:
        wrong_text = ""
        if st["wrong_options"]:
            wrong_text = "，错误选项分布：" + "、".join(f"{k}({v}人)" for k, v in st["wrong_options"])
        question_stats.append({
            "index": st["index"] + 1,
            "text": str(st["question"] or "")[:60],
            "type": st["type"],
            "correct_rate": st["correct_rate"],
            "correct_count": st["correct_count"],
            "total": st["total_count"],
            "wrong_distribution": wrong_text,
        })

    # 构建统计文本
    stats_text = ""
    for qs in question_stats:
        stats_text += f"第{qs['index']}题 ({qs['type']}): 正确率{qs['correct_rate']}% ({qs['correct_count']}/{qs['total']}人){qs['wrong_distribution']}\n"
        stats_text += f"  题目：{qs['text']}\n\n"

    from backend.api.ai_service import call_ai_async
    from backend.ai_task_manager import task_manager

    async def _do_analysis() -> dict[str, Any]:
        from backend.prompts.interaction import QUIZ_ANALYSIS_PROMPT
        from backend.api.chat_router import get_api_keys

        keys = get_api_keys(user["username"])
        api_key = keys[0] if keys and keys[0] else ""
        if not api_key:
            raise HTTPException(status_code=400, detail="未配置 API Key")

        def _safe(s):
            return str(s).replace('{', '{{').replace('}', '}}')

        ai_role = build_ai_role()
        prompt = f"{ai_role}" + QUIZ_ANALYSIS_PROMPT.format(
            quiz_title=_safe(quiz_row0.get("title") or ""),
            subject=_safe(""),
            participant_count=_safe(participant_count),
            question_stats=_safe(stats_text),
        )
        prompt = apply_skills(prompt, "quiz")

        analysis = await call_ai_async(prompt, api_key, use_kb=False)
        # R2: 平均分也按百分制给, 避免"平均 3.5 分"这种没有满分参照的数
        avg_raw = sum(float(a[2] or 0) for a in answers) / max(participant_count, 1)
        return {
            "analysis": analysis,
            "stats": question_stats,
            "participant_count": participant_count,
            "avg_score": round(avg_raw / max(total_possible, 1) * 100, 1),
            "avg_raw_score": round(avg_raw, 1),
            "total_score": total_possible,
        }

    task_id = await task_manager.create_task(
        description=f"测验 #{quiz_id} AI 答题分析",
        coro_factory=_do_analysis,
        dedupe_key=f"quiz-ai:{quiz_id}", max_concurrent=4,
    )
    return {"task_id": task_id, "message": "AI 分析已提交，请稍后查询结果"}


# ═══════════════════════════════════════════════════════════
# V3.4 新增：AI 课堂总结
# ═══════════════════════════════════════════════════════════

@router.get("/class-summary", summary="AI 课堂总结")
async def ai_class_summary(
    request: Request,
    grade: str = Query("", description="年级"),
    cls: str = Query("", description="班级"),
    subject: str = Query("", description="学科（由前端传递）"),
    teacher_username: str = Query("", description="教师用户名"),
    time_range: str = Query("本堂课", description="时间范围"),
    start: str = Query("", description="统计开始时间"),
    end: str = Query("", description="统计结束时间"),
    snapshot_only: bool = Query(False, description="只返回数据快照，不生成 AI 报告"),
):
    """AI 综合分析课堂互动数据，生成课堂总结"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看")

    # R6: 课堂总结会聚合"该教师名下"的测验/投票/提问数据, 归属只能由管理员指定;
    # 教师传别人的用户名 -> 403(前端本来就只传自己), 并校验年级属于本人任教范围
    if role != 0:
        if teacher_username and teacher_username != user["username"]:
            raise HTTPException(status_code=403, detail="只能生成自己的课堂总结")
        from backend.permission_service import can_access_grade, get_grade_by_name
        _gi = get_grade_by_name(grade)
        if _gi and not can_access_grade(user["username"], _gi["id"]):
            raise HTTPException(status_code=403, detail="无权查看该年级的课堂数据")
    from backend.analytics_service import resolve_query_teacher
    query_teacher = resolve_query_teacher(user, teacher_username)

    # 2026-10: 班级范围、时间窗、参与学生统一收敛到 analytics_service，
    # 避免把其他班级/其他月份的测验、投票、提问混进"本堂课"总结。
    from backend.analytics_service import build_class_activity_snapshot
    snapshot = build_class_activity_snapshot(
        user, query_teacher, grade, cls, start=start, end=end, subject=subject,
    )
    stats = snapshot["data"]
    student_count = stats["student_count"]
    if not any(stats[k] for k in ("quiz_count", "poll_count", "question_count", "discussion_count")):
        return {
            "task_id": None,
            "empty": True,
            "message": "所选时间范围内暂无课堂活动数据，请调整统计范围后再试",
            "data": stats,
            "sources": [],
            "window": snapshot["window"],
        }
    if snapshot_only:
        return {
            "task_id": None,
            "snapshot_only": True,
            "data": stats,
            "sources": snapshot["sources"],
            "window": snapshot["window"],
        }

    from backend.api.ai_service import call_ai_async
    from backend.ai_task_manager import task_manager

    # 将参数复制到局部变量，避免闭包引用外层参数
    _subject = subject
    _time_range = snapshot["window"]["label"] or time_range
    _quiz_data = snapshot["quiz_lines"]
    _poll_data = snapshot["poll_lines"]
    _question_data = snapshot["question_lines"]
    _discussion_data = snapshot["discussion_lines"]
    _scope_key = (
        f"cs:{query_teacher}:{grade}:{cls}:{subject}:"
        f"{snapshot['window']['start']}:{snapshot['window']['end']}"
    )

    async def _do_summary() -> dict[str, Any]:
        from backend.prompts.class_summary import CLASS_SUMMARY_PROMPT
        from backend.api.chat_router import get_api_keys
        from backend.ai_report_cache import save_report

        keys = get_api_keys(user["username"])
        api_key = keys[0] if keys and keys[0] else ""
        if not api_key:
            raise HTTPException(status_code=400, detail="未配置 API Key")

        def _safe(s):
            return str(s).replace('{', '{{').replace('}', '}}')

        from backend.prompts import build_ai_role
        ai_role = build_ai_role()
        prompt = f"{ai_role}\n" + CLASS_SUMMARY_PROMPT.format(
            subject=_safe(_subject),
            time_range=_safe(_time_range),
            student_count=_safe(student_count),
            quiz_data=_safe(_quiz_data),
            poll_data=_safe(_poll_data),
            question_data=_safe(_question_data),
            discussion_data=_safe(_discussion_data),
        )
        prompt = apply_skills(prompt, "quiz")

        summary = await call_ai_async(prompt, api_key, use_kb=False)
        report_id = save_report(
            "class_summary", _scope_key, summary, user["username"],
            meta={**stats, "window_label": snapshot["window"]["label"]},
        )
        return {
            "summary": summary,
            "data": stats,
            "sources": snapshot["sources"],
            "window": snapshot["window"],
            "report_id": report_id,
        }

    task_id = await task_manager.create_task(
        description="AI 课堂总结",
        coro_factory=_do_summary,
        dedupe_key=_scope_key,
        max_concurrent=4,
    )
    return {
        "task_id": task_id,
        "message": "课堂总结已提交，请稍后查询结果",
        "data": stats,
        "sources": snapshot["sources"],
        "window": snapshot["window"],
    }


@router.get("/class-summary/export", summary="导出课堂总结为 Word 文档")
async def export_class_summary_docx(
    request: Request,
    grade: str = Query("", description="年级"),
    cls: str = Query("", description="班级"),
    subject: str = Query("", description="学科"),
    teacher_username: str = Query("", description="教师用户名"),
    start: str = Query("", description="统计开始时间"),
    end: str = Query("", description="统计结束时间"),
    report_id: int | None = Query(None, description="页面生成的报告 ID"),
):
    """导出课堂总结；只读已生成报告，不再重复调用模型。"""
    import io
    import urllib.parse
    from docx import Document
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from fastapi.responses import StreamingResponse

    user = get_current_user(request)
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可导出")
    if role != 0 and teacher_username and teacher_username != user["username"]:
        raise HTTPException(status_code=403, detail="只能导出自己的课堂总结")

    from backend.analytics_service import (
        assert_class_access,
        class_display_name,
        parse_window,
        resolve_class_scope,
        resolve_query_teacher,
    )
    query_teacher = resolve_query_teacher(user, teacher_username)
    scope = resolve_class_scope(grade, cls)
    assert_class_access(user, scope)
    window = parse_window(start, end)
    scope_key = (
        f"cs:{query_teacher}:{grade}:{cls}:{subject}:"
        f"{window['start']}:{window['end']}"
    )

    from backend.ai_report_cache import get_latest_report, get_report
    if report_id:
        report = get_report(report_id, user["username"], role, kind="class_summary")
    else:
        report = get_latest_report("class_summary", scope_key)
    if not report:
        raise HTTPException(status_code=409, detail="请先在页面生成课堂总结，再导出")

    content = report.get("content") or ""
    meta = report.get("meta") or {}
    cls_name = meta.get("class_display") or class_display_name(grade, cls)
    student_count = meta.get("student_count", 0)
    window_label = meta.get("window_label", "") or window["label"]

    doc = Document()
    style = doc.styles['Normal']  # type: ignore[union-attr]
    style.font.name = 'Microsoft YaHei'  # type: ignore[attr-defined]
    style.font.size = Pt(11)  # type: ignore[attr-defined]
    style.paragraph_format.line_spacing = 1.5  # type: ignore[attr-defined]

    title = doc.add_heading(f"{cls_name} 课堂总结报告", level=1)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER

    info = doc.add_paragraph()
    info.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = info.add_run(
        f"年级：{grade}  班级：{cls}  学科：{subject or '全部'}  "
        f"参与学生：{student_count}人  统计范围：{window_label}"
    )
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    doc.add_paragraph()
    doc.add_heading("课堂数据统计", level=2)
    stats_table_data = [
        ("随堂测验", str(meta.get("quiz_count", 0))),
        ("投票活动", str(meta.get("poll_count", 0))),
        ("学生提问", str(meta.get("question_count", 0))),
        ("分组讨论", str(meta.get("discussion_count", 0))),
        ("参与学生", str(student_count)),
    ]
    table = doc.add_table(rows=len(stats_table_data), cols=2, style='Light Shading Accent 1')
    for i, (label, value) in enumerate(stats_table_data):
        table.rows[i].cells[0].text = label
        table.rows[i].cells[1].text = value

    doc.add_paragraph()
    doc.add_heading("AI 分析总结", level=2)
    _markdown_to_docx(doc, content)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    safe_filename = urllib.parse.quote(f"课堂总结_{cls_name}.docx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}"},
    )


# ═══════════════════════════════════════════════════════════
# Word 导出工具
# ═══════════════════════════════════════════════════════════

def _markdown_to_docx(doc, text: str):
    """将 Markdown 文本写入 docx 文档"""
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    for line in text.split('\n'):
        line = line.strip()
        if not line:
            doc.add_paragraph()
            continue
        if line.startswith('### '):
            doc.add_heading(line[4:], level=3)
        elif line.startswith('## '):
            doc.add_heading(line[3:], level=2)
        elif line.startswith('# '):
            doc.add_heading(line[2:], level=1)
        elif line.startswith('- **') and '：' in line:
            content = line.lstrip('- ')
            p = doc.add_paragraph()
            bold_end = content.find('**', 2)
            if bold_end > 0:
                run = p.add_run(content[2:bold_end])
                run.bold = True
                p.add_run(content[bold_end + 2:])
            else:
                p.add_run(content)
        elif line.startswith('- '):
            doc.add_paragraph(line[2:], style='List Bullet')
        elif any(line.startswith(f'{i}. ') for i in range(1, 10)):
            doc.add_paragraph(line, style='List Number')
        else:
            if '**' in line:
                p = doc.add_paragraph()
                parts = line.split('**')
                for i, part in enumerate(parts):
                    if part:
                        run = p.add_run(part)
                        if i % 2 == 1:
                            run.bold = True
            else:
                doc.add_paragraph(line)


# ═══════════════════════════════════════════════════════════
# V3.4 新增：AI 异步任务状态查询
# ═══════════════════════════════════════════════════════════

@router.get("/ai-task/{task_id}", summary="查询 AI 异步任务状态")
async def get_ai_task_status(task_id: str, request: Request):
    """查询 AI 后台任务的执行状态和结果。

    S5: 旧实现完全无鉴权(未登录也能凭 task_id 读到 AI 生成的整套试题/复习计划/学情总结),
    现要求登录, 且只有任务归属者或管理员可读。
    """
    user = get_current_user(request)
    from backend.ai_task_manager import task_manager
    task = task_manager.get_task_dict(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    owner = task.pop("owner", "") or ""
    if owner and user.get("role", 2) != 0 and owner != user["username"]:
        raise HTTPException(status_code=403, detail="无权查看该任务")
    return task


# ════════════════════════════════════════════════════════════
# S-GRADING(P3): 随堂测验主观题「后台批量批改」适配（引擎见 backend/ai_grading.py）
#   提交时: 客观题当场判, 简答/填空写 grading='pending' + 行标记 ai_pending=1
#   引擎按「同一道题」合并多份答案一次评分, 判完写回并补等级积分
# ════════════════════════════════════════════════════════════

QUIZ_SUBJECTIVE_TYPES = ("short", "fill")


class QuizGradeNowRequest(BaseModel):
    """教师：立即批改该测验的主观题"""
    retry_review: bool = False     # 同时把「转人工」的题重新排队再试一次 AI


@router.post("/quizzes/{quiz_id}/grade-now", summary="教师：立即批改测验待判的主观题")
async def grade_quiz_now(quiz_id: int, request: Request, req: QuizGradeNowRequest | None = None):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可发起批改")
    quiz_row = _get_quiz_row(quiz_id)
    if not quiz_row:
        raise HTTPException(status_code=404, detail="测验不存在")
    if not _can_view_activity_results(username, role, quiz_row):
        raise HTTPException(status_code=403, detail="无权批改该测验")

    if req and req.retry_review:
        requeued = _quiz_requeue_review(quiz_id)
        if requeued:
            logger.info(f"测验 {quiz_id}: {requeued} 题重新排队批改")

    pend = execute_query(
        "SELECT COUNT(*) FROM interaction_quiz_answers WHERE quiz_id=? AND ai_pending=1", (quiz_id,),
    )
    cnt = int(pend[0][0]) if pend and pend[0][0] is not None else 0
    if not cnt:
        return {"task_id": "", "message": "没有待批改的主观题", "pending_attempts": 0}

    from backend.ai_grading import drain_async
    from backend.ai_task_manager import task_manager
    task_id = await task_manager.create_task(
        description=f"随堂测验 #{quiz_id} 主观题批改",
        coro_factory=lambda: drain_async(only_source="quiz", only_activity=str(quiz_id)),
        owner_username=username,
        dedupe_key=f"quiz-grade:{quiz_id}",
        reuse_completed=False,   # 再点一次就得真再批一轮
    )
    return {"task_id": task_id, "message": "批改已开始", "pending_attempts": cnt}


def _quiz_requeue_review(quiz_id: int) -> int:
    """把「转人工」的题重新放回批改队列（教师点了重试再试一次 AI）"""
    rows = execute_query(
        "SELECT id, graded FROM interaction_quiz_answers WHERE quiz_id=? AND ai_pending=0", (quiz_id,)
    )
    requeued = 0
    for r in rows or []:
        gm = _quiz_graded(r[1])
        keys = [k for k, v in gm.items()
                if isinstance(v, dict) and (v.get("needs_review") or v.get("grading") == "review")]
        if not keys:
            continue
        for k in keys:
            gm[k]["grading"] = "pending"
            gm[k]["graded_by"] = "queued"
            gm[k].pop("needs_review", None)
        execute_insert_update(
            "UPDATE interaction_quiz_answers SET graded=?, ai_pending=1 WHERE id=?",
            (json.dumps(gm, ensure_ascii=False), r[0]),
        )
        requeued += len(keys)
    return requeued


def _quiz_force_review(attempt_id: int, keys: list[str], reason: str) -> None:
    """判不了的题直接转教师批改（并清掉 pending，避免队列里空转）"""
    with db_get_connection() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT graded FROM interaction_quiz_answers WHERE id=?", (attempt_id,)).fetchone()
        if not row:
            conn.execute("COMMIT")
            return
        gm = _quiz_graded(row[0])
        for k in keys:
            one = gm.get(str(k))
            if isinstance(one, dict):
                one["grading"] = "review"
                one["needs_review"] = True
                one["graded_by"] = "none"
                one["feedback"] = reason
        still = pending_keys(gm)
        conn.execute("UPDATE interaction_quiz_answers SET graded=?, ai_pending=? WHERE id=?",
                     (json.dumps(gm, ensure_ascii=False), 1 if still else 0, attempt_id))
        conn.execute("COMMIT")


def _quiz_fetch_jobs(limit: int) -> list[GradingJob]:
    rows = execute_query(
        """SELECT id, quiz_id, student_username, graded FROM interaction_quiz_answers
           WHERE ai_pending=1 ORDER BY submitted_at LIMIT ?""",
        (limit,),
    )
    jobs: list[GradingJob] = []
    qcache: dict[int, list[Any]] = {}
    for r in rows or []:
        aid, qid, stu, raw = r[0], r[1], r[2], r[3]
        gm = _quiz_graded(raw)
        pend = pending_keys(gm)
        if not pend:
            execute_insert_update("UPDATE interaction_quiz_answers SET ai_pending=0 WHERE id=?", (aid,))
            continue
        if qid not in qcache:
            qcache[qid] = _quiz_questions(_get_quiz_row(qid) or {})
        qs = qcache[qid]
        for key in pend:
            try:
                pos = int(key)
            except (TypeError, ValueError):
                pos = -1
            q = qs[pos] if 0 <= pos < len(qs) else None
            if not isinstance(q, dict):   # 题目被改/删: 转人工, 别在队列里回炉
                _quiz_force_review(aid, [key], "题目已被修改或删除，无法自动批改。")
                continue
            one = gm.get(key) or {}
            jobs.append(GradingJob(
                source="quiz", attempt_id=aid, entry_key=str(key), student_username=stu,
                activity_id=str(qid),
                question_text=str(q.get("question") or q.get("question_text") or ""),
                ref_answer=str(q.get("answer") or ""),
                max_score=float(one.get("max_score") or q.get("score") or 1),
                answer_text=str(one.get("student_answer") or ""),
                mode="short",     # 测验主观题只有简答/填空, 全部可合并批量
            ))
        if len(jobs) >= limit:
            break
    return jobs


def _quiz_save_batch(attempt_id: int, items: list[tuple[GradingJob, dict[str, Any]]]) -> None:
    """读-改-写一份测验答卷的逐题批改结果（与教师操作互斥；题态已变的条目不覆盖）"""
    with db_get_connection() as conn:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT graded FROM interaction_quiz_answers WHERE id=?", (attempt_id,)).fetchone()
        if not row:
            conn.execute("COMMIT")
            return
        gm = _quiz_graded(row[0])
        for job, res in items:
            one = gm.get(str(job.entry_key))
            if not isinstance(one, dict) or one.get("grading") != "pending":
                continue            # 已被别的轮次写回/教师已定分 → 不覆盖
            review = bool(res.get("needs_review"))
            one["grading"] = "review" if review else "graded"
            one["score"] = round(float(res.get("score") or 0), 1)
            one["max_score"] = job.max_score
            one["is_correct"] = False if review else bool(res.get("is_correct"))
            one["graded_by"] = str(res.get("graded_by") or "ai")
            if res.get("comment"):
                one["comment"] = str(res["comment"])[:600]
            note = str(res.get("feedback") or res.get("comment") or "")[:600]
            if note:
                one["feedback"] = note
            if review:
                one["needs_review"] = True
            else:
                one.pop("needs_review", None)
        earned = round(sum(float(v.get("score") or 0) for v in gm.values() if isinstance(v, dict)), 1)
        still = pending_keys(gm)
        conn.execute("UPDATE interaction_quiz_answers SET graded=?, score=?, ai_pending=? WHERE id=?",
                     (json.dumps(gm, ensure_ascii=False), earned, 1 if still else 0, attempt_id))
        conn.execute("COMMIT")


def _quiz_finalize_if_done(attempt_id: int) -> None:
    """该份答卷判完 → 补发等级积分（参与分提交时已发）"""
    rows = execute_query(
        "SELECT quiz_id, student_username, score, ai_pending FROM interaction_quiz_answers WHERE id=?",
        (attempt_id,),
    )
    if not rows or rows[0][3]:
        return
    _settle_quiz_answer({"id": attempt_id, "quiz_id": rows[0][0],
                         "student_username": rows[0][1], "score": rows[0][2]})


register_source(SourceAdapter(
    source="quiz",
    label="随堂测验",
    fetch_jobs=_quiz_fetch_jobs,
    save_batch=_quiz_save_batch,
    finalize_if_done=_quiz_finalize_if_done,
))
