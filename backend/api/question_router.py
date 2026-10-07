"""
试题库 API 路由
AI 生成试题 + 题库 CRUD
"""
import asyncio
import json
import os
import io
import time
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request, Query, UploadFile, File, Form
from pydantic import BaseModel

from backend.config import ai_api_base
from backend.model_catalog import DEFAULT_VL_MODEL
from backend.api.config_router import get_config_value
from backend.question_db import (
    execute_query,
    execute_query_one,
    execute_insert,
    execute_update,
)
from backend.api.dependencies import get_current_user
from backend.auth import can_manage_html_files
from backend.logger import logger
# 出题入库统一走 question_factory（校验 → 查重 → 事务插入 → 连边）
from backend import question_factory
from backend.question_media import (
    SOURCE_BANK,
    archive_bank_dir,
    attach_media,
    delete_media_file,
    dump_json,
    ensure_media_dir,
    infer_status,
    media_columns_for_insert,
    media_summary,
    normalize_media_files,
    resolve_media_path,
    url_for,
)
from backend.svg_safety import extract_svg, is_usable_svg, sanitize_svg

# 复用聊天模块的 API Key 获取函数
from backend.api.chat_router import get_api_keys
# 注：本模块不再注入技能 —— 出题要求纯 JSON、SVG 要求纯代码，技能段的"结构化输出"指令会破坏这两种格式

router = APIRouter()


# ── 请求/响应模型 ──

class GenerateRequest(BaseModel):
    """AI 生成试题请求"""
    subject: str = ""  # 科目（由前端传递）
    knowledge_points: str = ""         # 知识点
    question_type: str = "single"      # single | multiple | true_false | short
    count: int = 5                     # 生成数量
    difficulty: str = "medium"         # easy | medium | hard


class QuestionUpdate(BaseModel):
    """更新题目请求"""
    question_text: str | None = None
    options: str | dict[str, Any] | list[Any] | None = None
    correct_answer: str | None = None
    explanation: str | None = None
    knowledge_points: str | None = None
    difficulty: str | None = None
    type: str | None = None          # Q8: 题型录错应可修正
    subject: str | None = None       # Q8: 科目挂错应可修正


_VALID_SOURCES = {"manual", "ai", "quiz_import", "batch_import", "exam_import"}


class ImportQuestion(BaseModel):
    """导入题目到题库请求"""
    type: str = "single"
    question_text: str
    options: str | list[Any] | dict[str, Any] | None = None
    correct_answer: str = ""
    explanation: str = ""
    knowledge_points: str = ""
    difficulty: str = "medium"
    source: str = "manual"
    svg_content: str | None = None
    has_svg: int = 0
    media_placeholders: str | list[Any] | None = None
    media_files: str | list[Any] | None = None


# ── 题型配置 ──

QUESTION_TYPE_MAP = {
    "single": "单选题（4个选项，唯一正确答案）",
    "multiple": "多选题（4-5个选项，至少2个正确答案）",
    "true_false": "判断题（回答「对」或「错」）",
    "short": "简答题（写出参考答案）",
    "fill": "填空题（填写正确内容）",
    "essay": "作文题（完整文章）",
    "subjective": "主观题（开放性问题）",
    "code": "编程题（Python 代码实现，需提供测试用例）",
}

TYPE_DESC = {
    "single": "单选题",
    "multiple": "多选题",
    "true_false": "判断题",
    "code": "编程题",
    "short": "简答题",
    "fill": "填空题",
    "essay": "作文",
    "subjective": "主观题",
}

# 编程题的模板代码与测试用例由「代码练习」模块（backend/api/code_router.py）独占管理：
# code_problems 已改版为独立表，与 question_bank 之间没有任何关联字段，
# 题库里的 code 题只能存题干与解析，既不能运行也不参与判分。
# 与其照旧往一张已经没有 question_id 列的表里 INSERT（必然失败、又被 except 吞掉），
# 不如在入口处就把话说清楚。
CODE_BANK_NOTE = (
    "题库中的「编程题」只保留题干与解析，不能运行、不参与判分；"
    "需要可运行的代码题（含模板代码与测试用例）请在「代码练习」中创建。"
)


# ── 导入题目到题库（用于随堂测验题目复用） ──

@router.post("/import", summary="导入题目到题库")
async def import_question(req: ImportQuestion, request: Request):
    """将题目导入 question_bank，返回新题目的 ID"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可导入题目")

    # 校验 source 字段
    if req.source not in _VALID_SOURCES:
        raise HTTPException(status_code=400, detail=f"无效的 source 值: {req.source}，允许值: {', '.join(sorted(_VALID_SOURCES))}")

    # 获取用户姓名
    from backend.database import execute_query as user_query
    user_row = user_query("SELECT name FROM users WHERE username=?", (username,))
    creator_name = user_row[0][0] if user_row and user_row[0][0] else username

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    options_str = ""
    if req.options:
        if isinstance(req.options, (dict, list)):
            options_str = json.dumps(req.options, ensure_ascii=False)
        else:
            options_str = req.options

    # 处理配图字段（外部导入按不可信输入处理：SVG 清洗、占位符与清单规整）
    # 导入不限占位符数量（教师可能一次搬 3 个描述进来），只有"自动生图"才受上限约束
    svg_content, has_svg_computed, media_placeholders_str = _media_columns(
        {"svg_code": req.svg_content, "media_placeholders": req.media_placeholders},
        placeholder_limit=0,
    )
    has_svg = req.has_svg if req.has_svg else has_svg_computed
    media_files_list = normalize_media_files(req.media_files)
    media_files_str = dump_json(media_files_list) if media_files_list else ""

    qid = execute_insert(
        """INSERT INTO question_bank
           (type, question_text, options, correct_answer, explanation,
            knowledge_points, difficulty, creator_username, creator_name,
            source, status, created_at, updated_at,
            svg_content, has_svg, media_placeholders, media_files)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?,
                   ?, ?, ?, ?)""",
        (req.type, req.question_text, options_str, req.correct_answer,
         req.explanation, req.knowledge_points, req.difficulty,
         username, creator_name, req.source, now, now,
         svg_content, has_svg, media_placeholders_str, media_files_str),
    )
    return {"id": qid, "message": "导入成功"}


# ── 公共辅助函数 ──

# 配图目录命名空间与归档规则统一在 backend/question_media.py，不在这里重复定义

_LIKE_ESCAPE = "!"


def _esc_like(v: str) -> str:
    """转义 LIKE 通配符, 避免用户输入的 % 与 _ 改变搜索语义(Q11)。

    用 ! 作为 ESCAPE 字符而不是反斜杠: SQL 字面量里不需要二次转义, 不会踩
    "ESCAPE '\\'" 变成两个字符而被 SQLite 拒绝的坑。
    """
    return re.sub(r"([%_!])", "!\\1", v or "")


def _question_refs(question_id: int) -> tuple[list, list]:
    """Q2: 返回引用该题的(考试, 智能练习)。

    practice_* 表与题库同在 questions.db。旧实现从 backend.database(主库 smartkb.db)
    查同名空表, 且外层 except: pass, 导致"正在使用中"保护恒判定为无引用。
    """
    exam_refs = execute_query(
        """SELECT DISTINCT e.id, e.title, e.status FROM exams e
           JOIN exam_questions eq ON eq.exam_id = e.id
           WHERE eq.question_id = ?""",
        (question_id,),
    )
    practice_refs = execute_query(
        """SELECT DISTINCT ps.id, ps.title, ps.status FROM practice_sessions ps
           JOIN practice_session_questions psq ON psq.session_id = ps.id
           WHERE psq.question_id = ?""",
        (question_id,),
    )
    return exam_refs, practice_refs


def _format_refs(exam_refs: list, practice_refs: list) -> str:
    parts = []
    if exam_refs:
        parts.append("考试(%d个)：%s" % (len(exam_refs), "、".join("「%s」" % r["title"] for r in exam_refs)))
    if practice_refs:
        parts.append("智能练习(%d个)：%s" % (len(practice_refs), "、".join("「%s」" % r["title"] for r in practice_refs)))
    return "；".join(parts)


def _archive_media_dir(question_id: int) -> None:
    """Q6: 题目软删时归档配图目录(可完整恢复), 由日志保留任务到期清理

    只搬本题自己的目录；闯关（quest/）与白板（whiteboard_ai/）在同一根目录下，
    它们的归属由 backend.question_media 判断，这里绝不越界。
    """
    try:
        moved = archive_bank_dir(question_id)
        if moved:
            logger.info(f"试题配图已归档: {moved}")
    except Exception as e:
        logger.warning(f"归档试题配图目录失败 (id={question_id}): {e}")


async def _verify_question_owner(
    question_id: int, username: str, role: int,
) -> dict[str, Any]:
    """校验试题存在性 + 操作权限，返回题目行数据"""
    row = execute_query_one("SELECT * FROM question_bank WHERE id=?", (question_id,))
    if not row:
        raise HTTPException(status_code=404, detail="试题不存在")
    if row["creator_username"] != username and role != 0:
        raise HTTPException(status_code=403, detail="无权操作")
    return row


def _delete_physical_media(
    question_id: int, url: str | None,
) -> bool:
    """删除指定 URL 对应的物理图片文件（静默忽略不存在的情况）

    URL 可能来自教师导入的数据，按不可信输入处理：只取最后一段文件名，
    并且只在配图根目录内删除，``/../`` 之类的值一律拒绝。
    """
    try:
        return delete_media_file(url, SOURCE_BANK, question_id)
    except Exception as e:
        logger.warning(f"删除配图文件失败 (id={question_id}, url={str(url)[:60]}): {e}")
        return False


def _hydrate_media_state(row: dict[str, Any]) -> None:
    """给读接口补上配图状态（不改数据库，只在返回前推断一次）

    两类历史脏数据都要能看出来，否则教师只能"删图重来"：
    - 占位符没有 status（出题自动生图当年只回写了 media_files）→ 按 manifest 推断；
    - manifest 有记录但磁盘上文件已不在（早年的覆盖写/目录回收）→ 标 missing，
      前端显示"图片已丢失"并给出「重试」，而不是摆一张破图。
    """
    placeholders = row.get("media_placeholders")
    files = row.get("media_files")
    if not isinstance(placeholders, list):
        return

    alive_keys: set[Any] = set()
    if isinstance(files, list):
        for item in files:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not url:
                continue
            exists = resolve_media_path(url, row.get("id"))
            item["exists"] = bool(exists)
            if exists:
                alive_keys.add(item.get("key"))

    for ph in placeholders:
        if not isinstance(ph, dict):
            continue
        status = infer_status(ph, files)
        if status in ("generated", "uploaded") and ph.get("key") not in alive_keys:
            status = "missing"
        ph["status"] = status


def _media_columns(q_data: dict[str, Any], placeholder_limit: int | None = 2) -> tuple[str, int, str]:
    """配图字段入库前的统一清洗与规整（实现见 backend.question_media）"""
    return media_columns_for_insert(q_data, placeholder_limit=placeholder_limit)


def _question_media_rows(row) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """从数据库行里取出（占位符, 媒体清单）两份列表，缺字段/坏 JSON 都不会抛"""
    placeholders = [p for p in normalize_media_rows(row["media_placeholders"])
                    if isinstance(p, dict)]
    files = normalize_media_files(row["media_files"])
    return placeholders, files


def normalize_media_rows(raw: Any) -> list[dict[str, Any]]:
    """读取历史占位符列表：保留原有条目（含状态），只丢掉非 dict 的脏数据

    注意与 ``normalize_placeholders`` 的区别：这个用于"读已有数据"，不做数量截断，
    否则老题里第 3、4 个占位符会在下次保存时被静默删掉。
    """
    from backend.question_media import _as_list
    return [item for item in _as_list(raw) if isinstance(item, dict)]


class _InternalRequest:
    """在后台任务里复用端点实现。

    这些出题/生成端点只通过 request 读取登录用户(request.state.user),
    因此用一个最小替身即可把同一份实现挂到 ai_task_manager 上跑,
    避免长 AI 调用占住一条 HTTP 连接(Q7)。
    """

    def __init__(self, user: dict[str, Any]):
        self.state = type("_State", (), {"user": user})()
        self.query_params: dict[str, str] = {}
        self.headers: dict[str, str] = {}
        self.cookies: dict[str, str] = {}
        self.client = None


async def _submit_ai_task(corps, description: str, owner: str | None = None,
                          dedupe_key: str | None = None,
                          reuse_completed: bool = True) -> str:
    """提交 AI 后台任务。

    新增的两个可选参数只在配图类端点使用，默认值保持旧行为：
    - owner: 明确任务归属（后台执行时 request 上下文已经不在了）
    - dedupe_key + reuse_completed=False: 同一个题目的同一个动作，进行中直接复用
      同一个 task（挡住连点造成的重复生图计费），但已完成的旧任务不复用
      —— 否则「再点一次重新生成」会拿到上一轮的回执，看起来生成了、实际没跑。
    """
    from backend.ai_task_manager import task_manager
    return await task_manager.create_task(
        description=description, coro_factory=corps,
        owner_username=owner, dedupe_key=dedupe_key, reuse_completed=reuse_completed,
    )


def _precheck_media_action(question_id: int, username: str, role: int, kind: str,
                           placeholder_key: str | None = None) -> None:
    """异步端点的提交前校验：能在 HTTP 阶段判定的一律当场返回

    异步化最容易制造的新问题就是把"参数错/权限错/功能没开"塞进后台任务里，
    教师只能看到一条含义不明的「任务失败」。这里把可预判的分支前移：
    题目归属、生图开关、占位符是否存在且描述完整、题干是否够长、API Key 是否配置。
    """
    row = execute_query_one("SELECT * FROM question_bank WHERE id=?", (question_id,))
    if not row:
        raise HTTPException(status_code=404, detail="试题不存在")
    if row["creator_username"] != username and role != 0:
        raise HTTPException(status_code=403, detail="无权操作")

    if kind == "svg":
        api_key, _ = get_api_keys(username)
        if not api_key:
            raise HTTPException(status_code=400, detail="API Key 未配置")
        return

    if not get_config_value("IMAGE_GEN_ENABLED", True):
        raise HTTPException(status_code=400,
                            detail="系统未开启 AI 生图功能（系统配置 → IMAGE_GEN_ENABLED）")

    if kind == "image":
        if len((row["question_text"] or "")[:200]) < 10:
            raise HTTPException(status_code=400, detail="题干过短，无法生成配图")
        return

    if kind == "media":
        placeholders, _files = _question_media_rows(row)
        target = next((ph for ph in placeholders if ph.get("key") == placeholder_key), None)
        if not target:
            raise HTTPException(status_code=404, detail="占位符不存在")
        if not str(target.get("description") or "").strip():
            raise HTTPException(status_code=400,
                                detail="该占位符缺少图片描述，请改用「万相生图」或直接上传图片")


def _as_media_task(factory):
    """把配图动作包成后台任务体：HTTPException 转成可读的失败原因

    后台任务的 error 字段是直接展示给教师的，带 "502: " 这种状态码前缀既难读
    也没法本地化，所以在这里统一降级成纯文案。
    """
    async def _run():
        try:
            return await factory()
        except HTTPException as e:
            raise RuntimeError(str(e.detail)) from None
    return _run


# ── AI 生成试题 ──

@router.post("/generate")
async def generate_questions(req: GenerateRequest, request: Request):
    """AI 生成试题并直接入库"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")

    if not req.knowledge_points.strip():
        raise HTTPException(status_code=400, detail="请输入知识点")

    if req.count < 1 or req.count > 50:
        raise HTTPException(status_code=400, detail="生成数量范围为 1-50")

    if req.question_type == "code":
        # 编程题的模板代码/测试用例只有「代码练习」能落库与判分，题库侧没有这条链路
        raise HTTPException(status_code=400, detail=CODE_BANK_NOTE)

    # 获取 API Key
    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请先在系统配置中设置")

    # 构造 Prompt
    type_desc = QUESTION_TYPE_MAP.get(req.question_type, "单选题")
    prompt = _build_generate_prompt(req.subject, req.knowledge_points, type_desc, req.count, req.difficulty, username)
    # 注意：不注入技能 — 技能的结构化输出指令与纯 JSON 输出要求冲突
    logger.info(f"开始调用AI生成试题: subject={req.subject}, type={req.question_type}, count={req.count}")

    # 调用 AI
    try:
        result_text = await _call_dashscope_agent(prompt, api_key, json_mode=True,
                                              kb_query=f"{req.subject} {req.knowledge_points}")
    except Exception as e:
        logger.error(f"AI 生成试题失败: {e}")
        raise HTTPException(status_code=502, detail=f"AI 生成失败: {str(e)}")

    # 解析 JSON
    questions = _parse_ai_response(result_text)
    if not questions:
        logger.error(f"AI 返回无法解析: {result_text[:500]}")
        raise HTTPException(status_code=502, detail="AI 返回格式异常，未能解析出试题，请重试")

    # 获取用户姓名（database.execute_query 返回 tuple 列表）
    from backend.database import execute_query as user_query
    user_row = user_query("SELECT name FROM users WHERE username=?", (username,))
    creator_name = user_row[0][0] if user_row and user_row[0][0] else username

    # 入库统一走 question_factory（与含配图版同一口径、同一实现，见其注释）
    outcome = question_factory.persist_questions(
        questions[:req.count],
        subject=req.subject,
        source="ai",
        username=username,
        creator_name=creator_name,
        question_type=req.question_type,
        difficulty=req.difficulty,
        knowledge_points=req.knowledge_points,
    )
    stats = outcome["stats"]

    saved_questions = [
        {
            "id": n["id"],
            "type": n["type"],
            "question_text": n["question_text"],
            "options": n["options"],
            "correct_answer": n["correct_answer"],
            "explanation": n["explanation"],
            "knowledge_points": n["knowledge_points"],
            "difficulty": n["difficulty"],
        }
        for n in outcome["saved"]
    ]
    for d in outcome["duplicated"]:
        saved_questions.append({
            "id": d["id"], "type": d["type"], "question_text": d["question_text"],
            "options": d["options"], "correct_answer": d["correct_answer"],
            "explanation": d["explanation"], "knowledge_points": d["knowledge_points"],
            "difficulty": d["difficulty"], "duplicated": True,
        })

    note = _generation_note(outcome, [], asked=req.count, parsed=len(questions))
    logger.info(f"用户 {username} AI 出题 入库={stats['saved']} 重复={stats['duplicated']} "
                f"拒绝={stats['rejected']} 题型={stats['by_type']}")
    return {
        "message": f"成功生成 {stats['saved']} 道{TYPE_DESC.get(req.question_type, '')}题",
        "questions": saved_questions,
        "total": len(saved_questions),
        "requested": req.count,
        "saved": stats["saved"],
        "duplicated": stats["duplicated"],
        "rejected": stats["rejected"],
        "stats": stats,
        "note": note,
    }


@router.post("/generate-async", summary="AI 生成试题(异步任务版)")
async def generate_questions_async(req: GenerateRequest, request: Request):
    """与 /generate 相同, 但放到后台任务里跑, 前端用 pollAiTask 轮询(Q7)"""
    user = get_current_user(request)
    username = user["username"]
    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")
    if not req.knowledge_points.strip():
        raise HTTPException(status_code=400, detail="请输入知识点")
    if req.count < 1 or req.count > 50:
        raise HTTPException(status_code=400, detail="生成数量范围为 1-50")

    if req.question_type == "code":
        # 丢进后台任务后再抛 HTTPException 只会变成"任务失败"，这里先给出明确指引
        raise HTTPException(status_code=400, detail=CODE_BANK_NOTE)

    task_id = await _submit_ai_task(
        lambda: generate_questions(req, _InternalRequest(user)),
        f"教师 {username} AI 出题：{req.knowledge_points}({req.count}题)",
    )
    return {"task_id": task_id, "message": "AI 已开始出题，请稍候..."}


def _generation_note(outcome: dict[str, Any], media_notes: list[str], *,
                     asked: int = 0, parsed: int = 0) -> str:
    """把 factory 回报的"哪些没入库、为什么"拼成给老师看的一句话。

    只报"成功生成 N 道"是不够的：模型返回的题型与指定不符、答案落在选项外、
    题干与题库已有题重复、模型少给或多给被截断 —— 过去全部被静默吞掉，
    老师以为 5 道都出题成功了。

    三个数量必须分清：asked=老师要几道，parsed=模型实际返回几道，
    saved/duplicated/rejected=factory 处置结果。stats["requested"] 是 parsed，
    拿它跟 saved 比永远相等，所以缺口要用 asked 来算。
    """
    stats = outcome.get("stats") or {}
    bits: list[str] = []
    rejected = stats.get("rejected") or 0
    if rejected:
        reasons = "；".join(f"{r['question_text'][:18]}…：{r['reason']}"
                            for r in (outcome.get("rejected") or [])[:3])
        bits.append(f"{rejected} 道未入库（{reasons}）")
    dup = stats.get("duplicated") or 0
    if dup:
        kind = "与本批重复" if (stats.get("in_batch_duplicates") or 0) == dup else "题库里已有"
        bits.append(f"{dup} 道{kind}，未重复入库")
    if asked and parsed and parsed < asked:
        bits.append(f"模型只返回 {parsed} 道（要求 {asked} 道），可重试或减少数量")
    elif asked and parsed > asked:
        bits.append(f"模型返回 {parsed} 道，已按要求只取前 {asked} 道")
    fixed = [n for n in (stats.get("normalize_notes") or []) if n]
    if fixed:
        bits.append("已自动纠正：" + "；".join(fixed[:4]))
    if media_notes:
        bits.append("配图情况：" + "；".join(media_notes[:3]))
    return "。".join(bits)


def _build_generate_prompt(subject: str, knowledge_points: str, type_desc: str, count: int, difficulty: str, username: str = "") -> str:
    """构建 AI 生成试题的 Prompt（使用集中化模板）"""
    from backend.prompts.chat import QUESTION_GENERATE_PROMPT
    from backend.prompts import build_ai_role
    from backend.prompts.question_schema import render_question_prompt
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(difficulty, "中等")
    ai_role = build_ai_role(subject=subject)
    return f"{ai_role}\n" + render_question_prompt(QUESTION_GENERATE_PROMPT, 
        subject=subject,
        knowledge_points=knowledge_points,
        type_desc=type_desc,
        count=count,
        difficulty_desc=difficulty_desc,
    )


async def _call_dashscope_agent(prompt: str, api_key: str, json_mode: bool = False,
                                kb_query: str = "") -> str:
    """调用 AI（异步）- 支持智能体/直接调大模型双模式；json_mode 由网关保证输出合法 JSON"""
    from backend.api.ai_service import call_ai_async
    return await call_ai_async(prompt, api_key, json_mode=json_mode, kb_query=kb_query)


def _parse_ai_response(text: str) -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 试题列表：先走快速策略，失败再上 8.2 容错层兜底。

    兜底层处理：客套话包裹、fence 代码块、尾逗号、非法转义、截断补齐；
    全部失败时原文留档 LogFiles/ai_raw 便于复盘；
    解析成功后剥离误写进题干的选项（strip 只在证据充分时动手，不会误伤）。
    """
    from backend import ai_json
    questions = _parse_ai_response_fast(text)
    if not questions:
        got, meta = ai_json.extract_json_array2(text, salvage=True)
        if got:
            logger.info(f"[题解析] 容错层兜底成功 salvaged={meta.get('salvaged')}，共 {len(got)} 条")
            questions = got
        elif (text or "").strip():
            raw_path = ai_json.dump_failed_raw("questions", text)
            logger.error(f"[题解析] 全部策略失败（原文留档: {raw_path}）前200字: {text[:200]}")
    out: list[dict[str, Any]] = []
    for q in questions or []:
        if isinstance(q, dict):
            q, changed, why = ai_json.strip_options_from_stem(q)
            if changed:
                logger.info(f"[题解析] 已剥离题干内嵌选项（{why}）")
        out.append(q)
    return out


def _parse_ai_response_fast(text: str) -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 试题列表（多策略鲁棒解析）——快速路径，失败交给上层容错层"""
    text = text.strip()
    if not text:
        return []

    # 策略1：直接解析
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        elif isinstance(data, dict) and "questions" in data:
            return data["questions"]
    except json.JSONDecodeError:
        pass

    # 策略2：从 ```json ``` 代码块提取
    match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(1))
            if isinstance(data, list):
                return data
            elif isinstance(data, dict) and "questions" in data:
                return data["questions"]
        except json.JSONDecodeError:
            pass

    # 策略3：从最外层 [ 到 ] 提取 JSON 数组
    start = text.find('[')
    end = text.rfind(']')
    if start != -1 and end != -1 and end > start:
        json_str = text[start:end + 1]
        # 清理代码块标记
        json_str = json_str.replace("```json", "").replace("```", "").strip()
        try:
            data = json.loads(json_str)
            if isinstance(data, list):
                return data
            elif isinstance(data, dict) and "questions" in data:
                return data["questions"]
        except json.JSONDecodeError as e:
            logger.error(f"JSON 解析失败: {e}, 原文前200字: {text[:200]}")
            return []

    return []


# ── 题库 CRUD ──

@router.get("")
async def list_questions(
    request: Request,
    type: str = Query(None, description="筛选题型"),
    keyword: str = Query(None, description="关键词搜索(题目/知识点)"),
    creator: str = Query(None, description="筛选创建者"),
    difficulty: str = Query(None, description="筛选难度"),
    subject: str = Query(None, description="筛选科目"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
):
    """查询题库列表（支持筛选、搜索、分页）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    # 学生只能查看（后续阶段学生可见范围会有更细控制）
    # 目前教师和管理员可管理题库，学生不可见（等考试功能上线后学生通过考试看到题目）
    if role == 2:  # student
        raise HTTPException(status_code=403, detail="学生无权访问题库")

    conditions = ["q.status = 'active'"]
    params = []

    if type:
        conditions.append("q.type = ?")
        params.append(type)
    if keyword:
        # Q11: 转义 LIKE 通配符, 用户输入 % 或 _ 时按字面量搜索
        conditions.append("(q.question_text LIKE ? ESCAPE \'!\' OR q.knowledge_points LIKE ? ESCAPE \'!\')")
        kw = f"%{_esc_like(keyword)}%"
        params.extend([kw, kw])
    if creator:
        conditions.append("q.creator_username = ?")
        params.append(creator)
    if difficulty:
        conditions.append("q.difficulty = ?")
        params.append(difficulty)
    if subject:
        conditions.append("q.subject = ?")
        params.append(subject)

    where = " AND ".join(conditions)

    # 统计总数
    count_row = execute_query_one(f"SELECT COUNT(*) as total FROM question_bank q WHERE {where}", tuple(params))
    total = count_row["total"] if count_row else 0

    # 分页查询
    offset = (page - 1) * page_size
    rows = execute_query(
        f"""SELECT q.* FROM question_bank q
            WHERE {where}
            ORDER BY q.created_at DESC
            LIMIT ? OFFSET ?""",
        tuple(params) + (page_size, offset),
    )

    # 解析 options、media_placeholders、media_files JSON 字段
    for row in rows:
        for field in ["options", "media_placeholders", "media_files"]:
            val = row.get(field)
            if val:
                try:
                    parsed = json.loads(val)
                    row[field] = parsed if isinstance(parsed, (dict, list)) else val
                except (json.JSONDecodeError, TypeError):
                    pass
            elif field == "options":
                row[field] = None
            else:
                row[field] = [] if field != "options" else None
        _hydrate_media_state(row)

    return {
        "questions": rows,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/{question_id}")
async def get_question(question_id: int, request: Request):
    """获取单道试题详情（含参考答案与解析, 学生不可访问）"""
    user = get_current_user(request)
    if user.get("role", 2) == 2:
        # 列表端点已禁止学生, 详情不校验就会被连续 id 枚举出整库答案(Q1)
        raise HTTPException(status_code=403, detail="学生无权访问题库")

    row = execute_query_one("SELECT * FROM question_bank WHERE id = ?", (question_id,))
    if not row:
        raise HTTPException(status_code=404, detail="试题不存在")

    for field in ["options", "media_placeholders", "media_files"]:
        val = row.get(field)
        if val:
            try:
                parsed = json.loads(val)
                row[field] = parsed if isinstance(parsed, (dict, list)) else val
            except (json.JSONDecodeError, TypeError):
                pass
        elif field == "options":
            row[field] = None
        else:
            row[field] = []
    _hydrate_media_state(row)

    return row


@router.put("/{question_id}")
async def update_question(question_id: int, req: QuestionUpdate, request: Request):
    """更新试题（仅创建者和管理员可操作）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    row = execute_query_one("SELECT * FROM question_bank WHERE id = ?", (question_id,))
    if not row:
        raise HTTPException(status_code=404, detail="试题不存在")

    # 权限：管理员可编辑全部，教师只能编辑自己的
    if role != 0 and row["creator_username"] != username:
        raise HTTPException(status_code=403, detail="只能编辑自己创建的试题")

    provided = set(req.model_fields_set)
    if not provided:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")

    if "type" in provided and req.type not in QUESTION_TYPE_MAP:
        raise HTTPException(status_code=400, detail=f"未知题型: {req.type}")
    if "difficulty" in provided and req.difficulty not in ("easy", "medium", "hard"):
        raise HTTPException(status_code=400, detail=f"未知难度: {req.difficulty}")

    def _options_to_str(val: Any) -> str:
        # Q8: 显式传 options=null/"" 表示清空选项(旧实现 if val is not None + 前端 if(optionsStr) 双重导致清不掉)
        if val is None:
            return ""
        if isinstance(val, (dict, list)):
            return json.dumps(val, ensure_ascii=False)
        text = str(val).strip()
        if not text:
            return ""
        try:
            json.loads(text)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="options 必须是合法的 JSON 字符串")
        return text

    opts_str = _options_to_str(req.options) if "options" in provided else (row.get("options") or "")

    # 校验合并后的最终状态, 避免保存出"永远判错"的题
    final_type = req.type if "type" in provided else (row.get("type") or "single")
    final_ans = (req.correct_answer if "correct_answer" in provided else row.get("correct_answer")) or ""
    if final_type in ("single", "multiple"):
        try:
            opt_map = json.loads(opts_str) if opts_str else {}
        except json.JSONDecodeError:
            opt_map = {}
        keys = {str(k) for k in (opt_map or {}).keys()}
        if len(keys) < 2:
            raise HTTPException(status_code=400, detail="选择题至少需要 2 个选项, 请补全后再保存")
        letters = re.sub(r"[^A-Za-z]", "", final_ans).upper()
        if final_type == "multiple" and len(letters) < 2:
            raise HTTPException(status_code=400, detail="多选题的正确答案至少 2 个字母")
        if final_type == "single" and len(letters) != 1:
            raise HTTPException(status_code=400, detail="单选题的正确答案只能是 1 个字母")
        bad = sorted({ch for ch in letters if ch not in keys})
        if bad:
            raise HTTPException(
                status_code=400,
                detail="正确答案包含不在选项中的字母: %s（现有选项: %s）" % ("".join(bad), "".join(sorted(keys))),
            )
    elif final_type == "true_false":
        if (final_ans or "").strip() not in ("对", "错", "T", "F", "true", "false", "TRUE", "FALSE"):
            raise HTTPException(status_code=400, detail="判断题的正确答案只能是「对」或「错」")
    elif final_type in ("short", "fill", "essay", "subjective") and "correct_answer" in provided \
            and not (final_ans or "").strip():
        raise HTTPException(status_code=400, detail="主观题/填空题必须填写参考答案, 否则无法批改")

    updates, params = [], []
    for field in ("question_text", "options", "correct_answer", "explanation",
                  "knowledge_points", "difficulty", "type", "subject"):
        if field not in provided:
            continue
        if field == "options":
            updates.append("options = ?")
            params.append(opts_str)
            continue
        val = getattr(req, field, None)
        if field == "question_text" and not str(val or "").strip():
            raise HTTPException(status_code=400, detail="题干不能为空")
        updates.append(f"{field} = ?")
        params.append(val)

    updates.append("updated_at = ?")
    params.append(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    params.append(question_id)

    execute_update(
        f"UPDATE question_bank SET {', '.join(updates)} WHERE id = ?",
        tuple(params),
    )

    # 题库审计: 关键字段变更留痕, 误改时可以从日志里回查原值(避免"改完找不回")
    _audit_fields = ("question_text", "correct_answer", "type", "options", "subject", "difficulty", "explanation")
    changes = {}
    for field in _audit_fields:
        if field not in provided:
            continue
        old_val = str(row.get(field) or "")
        new_val = str(opts_str if field == "options" else (getattr(req, field, None) or ""))
        if old_val != new_val:
            changes[field] = {"from": old_val[:200], "to": new_val[:200]}
    if changes:
        logger.info("题库变更 id=%s by=%s: %s" % (question_id, username, json.dumps(changes, ensure_ascii=False)))

    # 该题正被哪些活动使用: 修改会立即影响未开始的考试/练习, 给教师明确提示
    try:
        exam_refs, practice_refs = _question_refs(question_id)
    except Exception as ref_err:
        logger.warning(f"查询试题引用失败 (id={question_id}): {ref_err}")
        exam_refs, practice_refs = [], []
    warnings = []
    if exam_refs or practice_refs:
        warnings.append("该题正被以下活动使用（%s），修改会立即生效于尚未作答的考试/练习" % _format_refs(exam_refs, practice_refs))
    if row.get("status") != "active":
        warnings.append("该题当前处于已删除状态, 本次修改不会让它自动重新出现在题库列表中")

    return {"message": "更新成功", "warnings": warnings}


@router.delete("/{question_id}")
async def delete_question(question_id: int, request: Request):
    """软删除试题（仅创建者和管理员可操作）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    row = execute_query_one("SELECT * FROM question_bank WHERE id = ?", (question_id,))
    if not row:
        raise HTTPException(status_code=404, detail="试题不存在")

    if role != 0 and row["creator_username"] != username:
        raise HTTPException(status_code=403, detail="只能删除自己创建的试题")

    # Q2: 题库与 practice_* 同在 questions.db, 统一走 _question_refs
    #     (旧实现去主库查同名空表 + except pass, 保护恒失效)
    exam_refs, practice_refs = _question_refs(question_id)
    if exam_refs or practice_refs:
        # Q11: 被占用用 409 表达, 不再返回 HTTP 200 + status="error"
        raise HTTPException(
            status_code=409,
            detail="该试题正在被使用中，无法删除。请先在相关活动中移除该题后再试。（%s）"
                   % _format_refs(exam_refs, practice_refs),
        )

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    logger.info(
        "题目软删 id=%s by=%s: 题型=%s 答案=%s 题干=%s"
        % (question_id, username, row.get("type"), str(row.get("correct_answer"))[:40],
           str(row.get("question_text"))[:60].replace("\n", " "))
    )
    execute_update(
        "UPDATE question_bank SET status = 'deleted', updated_at = ? WHERE id = ?",
        (now, question_id),
    )

    # Q6: 配图目录归档而非物理删除, 保证以后"恢复题目"不会丢图
    _archive_media_dir(question_id)

    return {"message": "删除成功"}


class DedupRequest(BaseModel):
    """题库去重请求(Q4: 默认只做预览)"""
    confirm: bool = False
    include_all_creators: bool = False


def _group_duplicate_questions(rows_all: list[dict]) -> list[dict]:
    """按 (题型, 规范化题干, 参考答案) 分组出重复候选。

    题干比较与入库查重(B)同用 question_select.norm 口径：空格/全半角标点变体
    也能归到一组；题型与答案仍要求精确一致，保持"同题干不同答案不误删"的旧保护。
    """
    from backend.question_select import norm as _norm_q
    grouped: dict[tuple, list[int]] = {}
    sample: dict[tuple, str] = {}
    for r in rows_all:
        key = (r["type"], _norm_q(r["question_text"]), r["ans"])
        grouped.setdefault(key, []).append(r["id"])
        sample.setdefault(key, r["question_text"])
    groups = [{"question_text": sample[k], "type": k[0], "ans": k[2],
               "ids": ",".join(str(i) for i in v), "cnt": len(v)}
              for k, v in grouped.items() if len(v) > 1]
    groups.sort(key=lambda g: (-g["cnt"], int(g["ids"].split(",")[0])))
    return groups


@router.post("/dedup", summary="查找/清理重复试题(默认仅预览)")
async def dedup_questions(req: DedupRequest | None = Body(default=None), request: Request = None):
    """查找重复试题; `confirm=false` 只返回清单, `confirm=true` 才执行软删除。

    重复判定 = 题干 + 题型 + 参考答案 三者完全一致
    (旧实现只比 question_text, 同题干不同题型/答案的题会被误删)。
    """
    req = req or DedupRequest()   # 兼容旧调用(不带 body 即预览模式)
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")

    rows_all = [dict(r) for r in (execute_query(
        """SELECT id, question_text, type, IFNULL(correct_answer, '') AS ans
           FROM question_bank WHERE status = 'active' ORDER BY id ASC""") or [])]
    groups = _group_duplicate_questions(rows_all)
    candidate_ids: list[int] = []
    for g in groups:
        candidate_ids.extend(int(x) for x in (g["ids"] or "").split(",") if x)

    owners: dict[int, str] = {}
    exam_ref_ids: set[int] = set()
    prac_ref_ids: set[int] = set()
    if candidate_ids:
        idph = ",".join("?" for _ in candidate_ids)
        params = tuple(candidate_ids)
        owners = {r["id"]: (r["creator_username"] or "") for r in execute_query(
            f"SELECT id, creator_username FROM question_bank WHERE id IN ({idph})", params)}
        exam_ref_ids = {r["question_id"] for r in execute_query(
            f"SELECT DISTINCT question_id FROM exam_questions WHERE question_id IN ({idph})", params)}
        prac_ref_ids = {r["question_id"] for r in execute_query(
            f"SELECT DISTINCT question_id FROM practice_session_questions WHERE question_id IN ({idph})", params)}

    results = []
    delete_ids: list[int] = []
    total_skipped_owner = 0
    total_skipped_ref = 0

    for g in groups:
        ids = sorted(int(x) for x in (g["ids"] or "").split(",") if x)
        keep_id, dup_ids = ids[0], ids[1:]
        allowed, skipped_owner, skipped_ref = [], 0, 0
        for did in dup_ids:
            owner = owners.get(did, "")
            if role != 0 and owner != username and not req.include_all_creators:
                skipped_owner += 1
                continue
            if did in exam_ref_ids or did in prac_ref_ids:
                skipped_ref += 1
                continue
            allowed.append(did)
        delete_ids.extend(allowed)
        total_skipped_owner += skipped_owner
        total_skipped_ref += skipped_ref
        if allowed or skipped_owner or skipped_ref:
            text = g["question_text"] or ""
            results.append({
                "question_text": text[:60] + ("..." if len(text) > 60 else ""),
                "type": g["type"],
                "correct_answer": g["ans"],
                "keep_id": keep_id,
                "deleted_ids": allowed,
                "count": len(allowed),
                "skipped_owner": skipped_owner,
                "skipped_ref": skipped_ref,
            })

    if not req.confirm:
        # Q4: 预览模式, 不做任何写入
        parts = []
        if delete_ids:
            parts.append("可删除 %d 条重复试题(保留每组最早的一条)" % len(delete_ids))
        if total_skipped_ref:
            parts.append("%d 条因被考试/练习引用而保留" % total_skipped_ref)
        if total_skipped_owner:
            parts.append("%d 条因不属于当前教师而跳过" % total_skipped_owner)
        return {
            "dry_run": True,
            "total_deleted": 0,
            "deletable_count": len(delete_ids),
            "total_skipped_owner": total_skipped_owner,
            "total_skipped_ref": total_skipped_ref,
            "groups": results,
            "message": ("；".join(parts) if parts else "未发现可清理的重复试题"),
        }

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for did in delete_ids:
        execute_update(
            "UPDATE question_bank SET status = 'deleted', updated_at = ? WHERE id = ?",
            (now, did),
        )
        _archive_media_dir(did)   # Q6: 归档而不是物理删除

    parts = []
    if delete_ids:
        parts.append("删除 %d 条" % len(delete_ids))
    if total_skipped_owner:
        parts.append("%d 条因权限不足跳过" % total_skipped_owner)
    if total_skipped_ref:
        parts.append("%d 条因被活动引用跳过" % total_skipped_ref)
    msg = "，".join(parts) if parts else "未发现重复试题"
    logger.info(f"去重完成: {msg}, by={username}")
    return {
        "dry_run": False,
        "total_deleted": len(delete_ids),
        "deletable_count": len(delete_ids),
        "total_skipped_owner": total_skipped_owner,
        "total_skipped_ref": total_skipped_ref,
        "groups": results,
        "message": msg,
    }


class TagFillItemIn(BaseModel):
    id: int
    tags: list[str] = []


class TagFillRequest(BaseModel):
    limit: int = 50        # 本次最多处理的无标题数(1~200)
    batch_size: int = 10   # 每次 AI 调用题数(1~20)
    confirm: bool = False  # False=只预览建议; True=写入(仅补空标签, 不覆盖已有)
    # 编辑后确认写入: 前端把用户修改过的建议列表传回, 后端仍逐字校验教材清单
    items: list[TagFillItemIn] | None = None


@router.post("/tag-fill", summary="[管理员] AI 补标无标签题目(默认预览)")
async def tag_fill_questions(req: TagFillRequest | None = Body(default=None), request: Request = None):
    """给题库中没有知识点标签的题补 1~3 个教材知识点标签。

    - 默认 dry-run 只返回建议; confirm=true 才写库, 且只写当前仍无标签的题(不覆盖)。
    - 标签只能从教材知识点清单里选, 清单外的返回一律丢弃(防幻觉造词)。
    - 写入后自动重建 题目↔知识点 ID 映射, 选题引擎 T0 层立即受益。
    """
    req = req or TagFillRequest()
    user = get_current_user(request)
    if user.get("role", 2) != 0:
        raise HTTPException(status_code=403, detail="仅管理员可执行批量补标")
    api_key, _ = get_api_keys(user["username"])
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")
    from backend.database import execute_query as main_exec
    try:
        # 主库 execute_query 返回元组列表(无 row_factory)，兼容 元组/Row/dict 三种形态
        _kp_rows = main_exec(
            "SELECT name FROM knowledge_points WHERE COALESCE(status,'') <> 'deleted'") or []
        kp_names = sorted({str((r["name"] if isinstance(r, dict) else r[0]) or "").strip()
                            for r in _kp_rows} - {""})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取教材知识点失败: {e}")
    if not kp_names:
        raise HTTPException(status_code=400, detail="教材知识点库为空，没有可挑选的标签")
    limit = max(1, min(int(req.limit or 50), 200))
    rows = execute_query(
        "SELECT id, subject, question_text FROM question_bank"
        " WHERE status='active' AND (knowledge_points IS NULL OR TRIM(knowledge_points)='')"
        " ORDER BY id LIMIT ?", (limit,)) or []
    if not rows:
        return {"dry_run": not req.confirm, "scanned": 0, "suggested": 0, "written": 0,
                "message": "没有缺标签的题目"}
    from backend.prompts.tag_fill import TAG_FILL_PROMPT
    from backend.api.ai_service import call_ai_async
    from backend import ai_json
    allowed = set(kp_names)
    kp_list_text = "\n".join("- " + n for n in kp_names[:300])
    bs = max(1, min(int(req.batch_size or 10), 20))
    suggestions: list[dict] = []
    errors = 0
    qtext = {int(r["id"]): str(r["question_text"] or "") for r in rows}
    for i in range(0, len(rows), bs):
        batch = rows[i:i + bs]
        lines = "\n\n".join(
            f"[{r['id']}] ({r['subject'] or '无学科'}) {(r['question_text'] or '')[:150]}" for r in batch)
        prompt = TAG_FILL_PROMPT.format(kp_list=kp_list_text, questions=lines)
        try:
            text = await call_ai_async(prompt, api_key, json_mode=True)
            parsed = ai_json.try_parse(str(text or ""))
            items = parsed.get("items") if isinstance(parsed, dict) else None
            if not isinstance(items, list):
                items = parsed if isinstance(parsed, list) else []
        except Exception as e:
            errors += 1
            logger.warning(f"[tag-fill] 第 {i // bs + 1} 批 AI 调用/解析失败: {e}")
            continue
        for it in items:
            if not isinstance(it, dict):
                continue
            try:
                qid = int(it.get("id"))
            except (TypeError, ValueError):
                continue
            tags = [str(x).strip() for x in (it.get("tags") or []) if str(x).strip() in allowed][:3]
            if tags:
                q0 = qtext.get(qid, "")
                suggestions.append({"id": qid, "tags": tags,
                                    "question": q0[:120] + ("..." if len(q0) > 120 else "")})
    if not req.confirm:
        return {"dry_run": True, "scanned": len(rows), "suggested": len(suggestions),
                "failed_batches": errors, "items": suggestions[:100],
                "allowed_tags": sorted(allowed),
                "message": "预览模式：可编辑建议标签后确认写入(只补无标签题)"}
    # 编辑后写入: 前端传回用户改过的建议列表时以其为准(仍逐字校验清单、只补空标签)
    if req.items is not None:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        written = 0
        dropped = 0
        for it in req.items[:300]:
            tags = [t.strip() for t in it.tags if t.strip() in allowed][:3]
            if not tags:
                dropped += 1
                continue
            n = execute_update(
                "UPDATE question_bank SET knowledge_points=?, updated_at=?"
                " WHERE id=? AND status='active' AND (knowledge_points IS NULL OR TRIM(knowledge_points)='')",
                (",".join(tags), now, int(it.id)))
            if n:
                written += 1
        map_stat = {}
        try:
            from backend.question_select import rebuild_kp_map
            map_stat = rebuild_kp_map()
        except Exception as e:
            logger.warning(f"[tag-fill] 重建知识点映射失败: {e}")
        logger.info(f"[tag-fill] {user['username']} 按编辑结果写入 {written} 题(跳过空/非法 {dropped})")
        return {"dry_run": False, "scanned": len(rows), "suggested": len(req.items),
                "written": written, "dropped": dropped, "kp_map": map_stat}
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    written = 0
    for s in suggestions:
        n = execute_update(
            "UPDATE question_bank SET knowledge_points=?, updated_at=?"
            " WHERE id=? AND status='active' AND (knowledge_points IS NULL OR TRIM(knowledge_points)='')",
            (",".join(s["tags"]), now, s["id"]))
        if n:
            written += 1
    map_stat = {}
    try:
        from backend.question_select import rebuild_kp_map
        map_stat = rebuild_kp_map()
    except Exception as e:
        logger.warning(f"[tag-fill] 重建知识点映射失败: {e}")
    logger.info(f"[tag-fill] {user['username']} 扫描 {len(rows)} 题, 建议 {len(suggestions)}, 写入 {written}")
    return {"dry_run": False, "scanned": len(rows), "suggested": len(suggestions),
            "written": written, "failed_batches": errors, "kp_map": map_stat}

@router.get("/types/list")
async def list_question_types():
    """获取支持的题型列表"""
    return {
        "types": [
            {"key": "single", "label": "单选题"},
            {"key": "multiple", "label": "多选题"},
            {"key": "true_false", "label": "判断题"},
            {"key": "short", "label": "简答题"},
            {"key": "fill", "label": "填空题"},
            {"key": "essay", "label": "作文"},
            {"key": "subjective", "label": "主观题"},
        ]
    }


# ── 从粘贴文本或 Word 文档提取试题 ──

def _persist_extracted_questions(questions: list[dict[str, Any]], subject: str,
                                 difficulty: str, username: str,
                                 source_label: str) -> list[dict[str, Any]]:
    """提取结果统一入库(同步/后台任务共用), 返回带 id 的题目列表。

    实现已收敛到 backend/question_factory（校验 → 查重 → 事务插入 → 连边），
    这里只负责两件事：
      1. 补齐 creator_name；
      2. 把 factory 分开的 saved / duplicated 两拨结果**按输入顺序**合回一个列表 ——
         调用方与前端都按"逐条对应输入"来渲染，顺序错位会把 A 题的图配到 B 题上。
    """
    from backend import question_factory
    from backend.database import execute_query as user_query
    user_row = user_query("SELECT name FROM users WHERE username=?", (username,))
    creator_name = user_row[0][0] if user_row and user_row[0][0] else username

    outcome = question_factory.persist_questions(
        questions,
        subject=subject,
        source=source_label,
        username=username,
        creator_name=creator_name,
        difficulty=difficulty,
    )
    saved = outcome["stats"]["saved"]
    if saved:
        logger.info(f"[提取入库] source={source_label} 新入库={saved} "
                    f"重复回填={outcome['stats']['duplicated']} 不合格={outcome['stats']['rejected']}")
    for r in outcome["rejected"][:5]:
        logger.info(f"[提取入库] 拒收 {r['type']}: {r['reason']} | {r['question_text']}")

    out: list[dict[str, Any]] = []
    for e in sorted(outcome["saved"] + outcome["duplicated"],
                    key=lambda x: x.get("source_index", 0)):
        out.append({
            "id": e["id"],
            "type": e["type"],
            "question_text": e["question_text"],
            "options": e["options"],
            "correct_answer": e["correct_answer"],
            "explanation": e["explanation"],
            "knowledge_points": e["knowledge_points"],
            "difficulty": e["difficulty"],
            "has_svg": e["has_svg"],
            "svg_content": e["svg_content"] if e["has_svg"] else None,
            "media_placeholders": e["media_placeholders"],
            "media_files": e.get("media_files") or [],
            **({"duplicated": True} if e.get("duplicated") else {}),
        })
    return out


def _parse_json_field_safe(val):
    """查重回填时把 JSON 字符串字段还原成对象, 失败原样返回。"""
    if isinstance(val, str) and val:
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return val
    return val if val is not None else None


def _build_batch_extract_prompt(subject: str, difficulty: str, chunk: str,
                               part: int, total: int) -> str:
    """分批提取 prompt: 声明"这是长文档的第 i/N 部分", 只提取真实存在的题, 防编造"""
    from backend.prompts import build_ai_role
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(difficulty, "中等")
    ai_role = build_ai_role(subject=subject)
    return f"""下面是一份长文档的第 {part}/{total} 部分，其中包含若干试题（部分题目可能被截断不完整）。

=== 文本数据 ===
{chunk}
=== 数据结束 ===

{ai_role}
你的任务是从上面的文本中提取其中**真实存在**的全部试题。
请严格按照 JSON 数组格式输出，只输出 JSON，不得有任何其他文字。

科目：{subject}
难度：{difficulty_desc}

要求：
1. 只提取文本中明确出现的题目，**禁止编造、禁止凭常识补全**不存在的题目
2. 被截断而不完整（缺题干或缺答案与选项）的题目直接跳过
3. 每个试题必须包含：题目、正确答案、题型（single/multiple/true_false/short/fill）
4. 选择题必须有选项（A/B/C/D），判断题选项为 {{"对":"对","错":"错"}}
5. 本段没有题目时输出 []

JSON 格式：
[
  {{
    "type": "single/multiple/true_false/short/fill",
    "question": "题目",
    "options": {{"A":"选项", "B":"...", "C":"...", "D":"..."}},
    "answer": "正确答案",
    "explanation": "解析",
    "knowledge_point": "知识点",
    "difficulty": "easy/medium/hard"
  }}
]"""


@router.post("/extract")
async def extract_questions_from_text(
    request: Request,
    subject: str = Form(""),  # 由前端传递
    difficulty: str = Form("medium"),
    text: str = Form(""),
    file: UploadFile = File(None),
):
    """从粘贴文本或 Word 文档中智能提取试题"""
    user = get_current_user(request)
    username = user["username"]

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")

    # 提取文本内容
    content = ""
    source_label = "paste"
    if file and file.filename:
        ext = os.path.splitext(file.filename.lower())[1]
        supported = {'.docx', '.txt', '.md', '.pdf', '.json'}
        if ext not in supported:
            raise HTTPException(status_code=400, detail=f"不支持的文件格式: {ext}，支持 docx/txt/md/pdf/json")
        try:
            file_bytes = await file.read()
            # docx/pypdf 解析是纯 CPU 活, 放线程里做, 避免冻结事件循环(Q7)
            content = await asyncio.to_thread(_extract_text_from_file, file_bytes, ext)
            source_label = ext.lstrip(".")
        except Exception as e:
            logger.error(f"解析文件失败: {e}")
            raise HTTPException(status_code=400, detail=f"解析文件失败: {str(e)}")
    elif text.strip():
        content = text.strip()
    else:
        raise HTTPException(status_code=400, detail="请提供粘贴文本或上传文件（docx/txt/md/pdf/json）")

    if len(content) < 10:
        raise HTTPException(status_code=400, detail="文本内容太少，无法提取试题")

    # ── 结构化直通: JSON 类内容(上传文件或粘贴)先"语法修复→解析"，
    #    再在任意嵌套结构(按课/章分组、题库导出等)里深挖题目字典。
    #    成功即全量入库：0 token、不受"喂模型长度上限/输出截断"影响 ──
    questions = None
    extract_note = ""
    if source_label == "json" or content.lstrip()[:1] in ("[", "{"):
        try:
            from backend.json_repair import try_parse_repaired
            from backend.question_extract import collect_question_dicts
            parsed = try_parse_repaired(content)
            if parsed is not None:
                normalized: list[dict[str, Any]] = []
                for q in collect_question_dicts(parsed):
                    nq = _normalize_question_json(q)
                    if nq.get("question"):
                        normalized.append(nq)
                if normalized:
                    questions = normalized
                    source_label = "json_import"
                    extract_note = f"结构化直通：解析出 {len(normalized)} 道题（未调用 AI）"
                    logger.info(f"结构化试题直通解析成功: {len(normalized)} 道 (source={source_label})")
        except Exception as e:
            logger.info(f"结构化直通解析失败，转 AI 提取: {e}")

    # ── AI 提取兜底: 规则分题目块 → 单批同步 / 多批后台任务 ──
    if questions is None:
        api_key, _ = get_api_keys(username)
        if not api_key:
            raise HTTPException(status_code=400, detail="未配置 API Key，请先在系统配置中设置")

        # 超长输入护栏(约60万字, 正常文档远小于此): 防误传超大文件烧钱
        content = content[:600000]
        from backend.question_extract import merge_questions, pack_batches, split_question_blocks
        blocks, est = split_question_blocks(content)
        batches = pack_batches(blocks)

        if len(batches) <= 1:
            prompt = _build_extract_prompt(subject, difficulty, batches[0] if batches else content)
            logger.info(f"开始调用AI提取试题: subject={subject}, source={source_label}, content_len={len(content)}")
            try:
                result_text = await _call_dashscope_agent(prompt, api_key, json_mode=True, kb_query=subject)
            except Exception as e:
                logger.error(f"AI 提取试题失败: {e}")
                raise HTTPException(status_code=502, detail=f"AI 提取失败: {str(e)}")
            questions = _parse_ai_response(result_text)
            if not questions:
                logger.error(f"AI 返回无法解析: {result_text[:500]}")
                raise HTTPException(status_code=502, detail="AI 返回格式异常，未能提取出试题，请重试")
        else:
            # 长文档一次性"转抄"必然被输出 token 腰斩 → 分批提取后台任务
            from backend.ai_task_manager import task_manager
            _subject, _difficulty, _source_label = subject, difficulty, source_label

            async def _run_batches() -> dict[str, Any]:
                import asyncio as _aio
                sem = _aio.Semaphore(2)  # 限并发, 不冲击其他在线用户

                async def _one(idx: int, chunk: str):
                    p = _build_batch_extract_prompt(_subject, _difficulty, chunk, idx + 1, len(batches))
                    last_err = "返回无法解析"
                    for _attempt in (1, 2):
                        try:
                            rt = await _call_dashscope_agent(p, api_key, json_mode=True, kb_query=_subject)
                            qs = _parse_ai_response(rt)
                            if qs:
                                return qs, None
                        except Exception as e:
                            last_err = str(e)[:120]
                    return None, f"第{idx + 1}批失败({last_err})"

                results = await _aio.gather(*[_one(i, c) for i, c in enumerate(batches)])
                ok_batches = [r[0] for r in results if r[0]]
                failed = [r[1] for r in results if r[0] is None]
                merged = merge_questions(ok_batches)
                if not merged:
                    raise ValueError("分批提取均失败: " + "; ".join(failed[:3]))
                saved = _persist_extracted_questions(merged, _subject, _difficulty, username, _source_label)
                note = f"分 {len(batches)} 批提取，成功 {len(batches) - len(failed)} 批，入库 {len(saved)} 道题"
                if failed:
                    note += "；未成功：" + "；".join(failed[:3])
                logger.info(f"用户 {username} 分批智能提取完成: {note}")
                return {"questions": saved, "total": len(saved), "note": note,
                        "message": f"成功提取 {len(saved)} 道试题"}

            task_id = await task_manager.create_task(
                description=f"教师 {username} 智能提取（约{est or '?'}题/{len(batches)}批）",
                coro_factory=_run_batches,
            )
            return {"mode": "task", "task_id": task_id, "batches": len(batches),
                    "estimated": est,
                    "message": f"文档较长（约识别 {est} 道题，分 {len(batches)} 批提取），已转后台处理，请稍候…"}

    saved_questions = _persist_extracted_questions(questions, subject, difficulty, username, source_label)

    source_display = {"docx": "Word文档", "txt": "文本文件", "md": "Markdown文件", "pdf": "PDF文件", "json": "JSON文件", "json_import": "JSON文件", "paste": "粘贴文本"}
    logger.info(f"用户 {username} 从{source_display.get(source_label, '文件')}提取并入库 {len(saved_questions)} 道试题")
    return {
        "message": f"成功提取 {len(saved_questions)} 道试题",
        "questions": saved_questions,
        "total": len(saved_questions),
        "note": extract_note,
    }


def _slice_tall_image(image_bytes: bytes, mime_type: str) -> list[tuple[bytes, str]]:
    """长截图(高>1.8倍宽)自动横向切成多片, 片间留 15% 重叠防切断题干。

    视觉模型对细长图会整体缩放丢细节, 分片既保分辨率又天然把输出预算分摊到各片;
    普通截图原样返回单片。PIL 缺失/异常一律回退原图, 不影响主流程。"""
    try:
        import io
        from PIL import Image
        im = Image.open(io.BytesIO(image_bytes))
        w, h = im.size
        if w <= 0 or h <= 1.8 * w:
            return [(image_bytes, mime_type)]
        chunk = max(400, int(w * 1.4))
        step = max(200, int(chunk * 0.85))
        out: list[tuple[bytes, str]] = []
        top = 0
        while top < h:
            bottom = min(top + chunk, h)
            buf = io.BytesIO()
            im.crop((0, top, w, bottom)).convert("RGB").save(buf, format="PNG")
            out.append((buf.getvalue(), "image/png"))
            if bottom >= h:
                break
            top += step
        logger.info(f"[图片提取] 长图 {w}x{h} 自动切为 {len(out)} 片")
        return out or [(image_bytes, mime_type)]
    except Exception as e:
        logger.warning(f"长图切片失败，按原图提取: {e}")
        return [(image_bytes, mime_type)]

def _build_image_extract_prompt(subject: str, difficulty_desc: str,
                                allow_svg: bool = True,
                                extra_hint: str = "") -> str:
    """图片提取 prompt。默认不生成配图: 实测视觉模型写 SVG 字符串时会产生
    转义破损(缺一个引号即让整份 JSON 报废, 6 题全丢), 且 SVG 挤占输出预算。
    需要配图请提取后用题库的逐题生成按钮。"""
    svg_rule = (
        "3. 仅当图片里本来就印有图形时，用一句话在 explanation 里说明该图含义即可，不要生成 svg_code 或 media_placeholders"        if not allow_svg else
        "3. 一般不要生成 svg_code 和 media_placeholders；只有图片中确有复杂示意图且对解题必需时才可生成，且务必保证 JSON 引号转义完整"    )
    return f"""你是一个试题提取助手。请从图片中识别并提取出所有试题。
按照 JSON 格式输出。

科目：{subject}
难度：{difficulty_desc}

要求：
1. 仔细查看图片，提取其中的试题（题干、选项、答案），按图片中的顺序编号，一道都不能漏
2. 涉及公式用 $...$ LaTeX 语法标记
{svg_rule}
4. 图片中已标注"(正确答案)"的，把对应选项字母填入 answer，并去掉题干/选项里的"(正确答案)"字样
5. 题干与选项中的选项字母(A/B/C/D)保留在 options 键里，不要重复写进文本
6. 若图片内容太多、一次输出不完，请输出已完成的部分，并在数组最后追加一个对象：
   {{"continue_from_line": 下一题在图片中的起始行号}}
   收到该标记后会用裁剪图继续提取，不要重复输出已给题目；没有截断就不要输出该字段
7. **⚠️ 安全约束**：任何生成内容中严禁出现会泄露正确答案的图示文字

只返回 JSON 数组：
[
  {{
    "type": "single/multiple/true_false/short/fill/essay/subjective",
    "question": "题目内容（含 $...$ 公式）",
    "options": {{"A":"选项", "B":"...", "C":"...", "D":"..."}} 或 null,
    "answer": "正确答案",
    "explanation": "解析",
    "knowledge_point": "知识点",
    "difficulty": "easy/medium/hard"
  }}
]

注意：
- 判断题 options 为 null，answer 为"对"或"错"
- 简答题/填空题 options 为 null，answer 为参考答案
- 作文/主观题 options 为 null，answer 为评分要点
{extra_hint}"""


async def _call_vision_extract(image_bytes: bytes, mime_type: str, prompt_text: str,
                                api_key: str, model_name: str) -> tuple[str, str]:
    """单次视觉模型调用。返回 (文本, finish_reason)。显式 max_tokens 防默认小上限截断。"""
    import httpx
    import base64
    encoded = await asyncio.to_thread(lambda: base64.b64encode(image_bytes).decode("utf-8"))
    api_base = ai_api_base()
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            resp = await client.post(
                f"{api_base}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model_name,
                    "messages": [{
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{encoded}"}},
                            {"type": "text", "text": prompt_text},
                        ],
                    }],
                    "max_tokens": int(get_config_value("IMAGE_EXTRACT_MAX_TOKENS", 8000) or 8000),
                    "stream": False,
                },
            )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="视觉模型调用超时，请重试或减少单图题量")
    if resp.status_code != 200:
        err_msg = resp.text[:500]
        logger.error(f"视觉模型调用失败: status={resp.status_code}, {err_msg}")
        raise HTTPException(status_code=502, detail=f"视觉模型调用失败: {err_msg}")
    choice = (resp.json().get("choices") or [{}])[0]
    content = ((choice.get("message") or {}).get("content")) or ""
    finish = choice.get("finish_reason") or ""
    logger.info(f"图片提取 AI 返回: {content[:200]}")
    return content, finish


def _crop_image_from_line(image_bytes: bytes, mime_type: str, line_no: int) -> tuple[bytes, str]:
    """按模型报告的"下一题起始行号"裁掉图片顶部已提取部分(留 0.5 行重叠)。
    行高按 图片高/10 估算——行号只当粗略游标用, 重复题由 merge_questions 规范化去重兜底。
    任何失败返回 (b"", "") 由调用方降级。"""
    if line_no <= 0:
        return image_bytes, mime_type
    try:
        import io
        from PIL import Image
        im = Image.open(io.BytesIO(image_bytes))
        w, h = im.size
        line_h = h / 10.0
        top = int((line_no - 1) * line_h)
        top = max(0, min(top - int(line_h * 0.5), h - 100))
        out = io.BytesIO()
        im.crop((0, top, w, h)).convert("RGB").save(out, format="PNG")
        return out.getvalue(), "image/png"
    except Exception as e:
        logger.warning(f"图片续提裁剪失败: {e}")
        return b"", ""

@router.post("/extract-from-image", summary="从图片中智能提取试题（使用视觉模型）")
async def extract_questions_from_image(
    request: Request,
    subject: str = Form(""),
    difficulty: str = Form("medium"),
    file: UploadFile = File(...),
):
    """从图片（截图/扫描件）中提取试题，使用视觉模型识别"""
    user = get_current_user(request)
    username = user["username"]

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")

    # 验证图片格式
    filename_lower = (file.filename or "").lower()
    ext = os.path.splitext(filename_lower)[1]
    supported_images = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}
    if ext not in supported_images:
        raise HTTPException(status_code=400, detail=f"不支持的图片格式: {ext}，支持 jpg/png/gif/webp/bmp")

    # 读取图片（直接在内存处理，不落盘）

    file_bytes = await file.read()
    if len(file_bytes) < 100:
        raise HTTPException(status_code=400, detail="图片内容过小，请上传清晰的试卷截图")

    # 根据扩展名确定 MIME 类型
    mime_map = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'}
    mime_type = mime_map.get(ext, 'image/jpeg')
    # 获取 API Key
    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    # 调用视觉模型提取试题
    model_name = get_config_value("MODEL_VL_NAME", DEFAULT_VL_MODEL)

    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(difficulty, "中等")
    prompt_text = _build_image_extract_prompt(subject, difficulty_desc)

    # ── 外层逐片(长图自动切), 内层逐轮(截断续提), 最后规范化去重合并 ──
    from backend.question_extract import merge_questions
    MAX_IMG_ROUNDS = 3
    all_q: list[dict] = []
    notes: list[str] = []
    slices = _slice_tall_image(file_bytes, mime_type)
    if len(slices) > 1:
        notes.append(f"长图已自动切为 {len(slices)} 片")

    for _si, (img_bytes, img_mime) in enumerate(slices):
        cur_bytes, cur_mime = img_bytes, img_mime
        note = ""
        prompt_text = _build_image_extract_prompt(subject, difficulty_desc)
        for round_no in range(MAX_IMG_ROUNDS):
            try:
                result_text, finish = await _call_vision_extract(
                    cur_bytes, cur_mime, prompt_text, api_key, model_name)
            except HTTPException:
                if round_no == 0:
                    raise
                note = f"第 {round_no + 1} 轮续提失败，保留已提取结果"
                break
            questions = _parse_ai_response(result_text)
            if not questions:
                # 整轮解析失败(如模型生成的 SVG 转义破损): 不连坐, 换纯文字重提一轮
                if round_no == 0:
                    prompt_text = _build_image_extract_prompt(subject, difficulty_desc, allow_svg=False)
                    note = "首轮输出解析失败，已按纯文字模式重提"
                    continue
                break
            all_q.extend(questions)
            cont = None
            for q in questions:
                if isinstance(q, dict) and str(q.get("continue_from_line") or "").isdigit():
                    cont = int(q["continue_from_line"])
            if not cont:
                break
            cur_bytes, cur_mime = _crop_image_from_line(file_bytes, mime_type, cont)
            if not cur_bytes:
                note = "模型要求续提，但图片裁剪失败，已保留前几轮结果"
                break
            if round_no + 1 < MAX_IMG_ROUNDS - 1:
                prompt_text = _build_image_extract_prompt(subject, difficulty_desc,
                                                          extra_hint=f"注意：本图从第 {cont + 1} 行开始，只需提取其后的新题，前面已提取过的不要重复。")

        if note:
            notes.append(f"第 {_si + 1} 片: {note}")

    merged = merge_questions([all_q])
    if not merged:
        raise HTTPException(status_code=502, detail="未提取到任何试题（模型输出解析失败，请重试或换更清晰的截图）")

    saved_questions = _persist_extracted_questions(merged, subject, difficulty, username, "image_extract")
    logger.info(f"用户 {username} 图片提取: 模型输出 {len(all_q)} 题, 去重入库 {len(saved_questions)} 题")
    return {
        "message": f"成功从图片提取 {len(saved_questions)} 道试题",
        "questions": saved_questions,
        "total": len(saved_questions),
        "note": "；".join(notes),
    }


def _normalize_question_json(q: dict[str, Any]) -> dict[str, Any]:
    """智能识别并规范化 JSON 试题字段名，兼容多种常见命名格式"""
    import re

    def _first_of(*keys):
        for k in keys:
            v = q.get(k)
            if v is not None:
                return v
        return ""

    # ── 题目文本 ──
    question = _first_of("question", "title", "stem", "content", "题干", "题目")
    if isinstance(question, (list, dict)):
        question = str(question)

    # ── 答案 ──
    answer = _first_of("answer", "correct_answer", "correctAnswer", "answerKey", "key", "答案", "正确答案")

    # ── 题型 ──
    raw_type = str(_first_of("type", "question_type", "questionType", "qtype", "题型")).lower()
    type_map = {
        "single": "single", "单选": "single", "单选题": "single",
        "multiple": "multiple", "多选": "multiple", "多选题": "multiple",
        "true_false": "true_false", "judge": "true_false", "判断": "true_false", "判断题": "true_false",
        "short": "short", "简答": "short", "简答题": "short",
        "fill": "fill", "填空": "fill", "填空题": "fill",
        "essay": "essay", "作文": "essay", "作文题": "essay",
        "subjective": "subjective", "主观": "subjective", "主观题": "subjective",
    }
    q_type = type_map.get(raw_type, "single")

    # ── 选项 ──
    options_raw = _first_of("options", "choices", "items", "select", "选项", "选择题选项")
    options = {}
    if isinstance(options_raw, dict):
        options = options_raw
    elif isinstance(options_raw, (list, tuple)):
        # 将 ["选项1", "选项2"] 转为 {"A": "选项1", "B": "选项2", ...}
        labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        for i, opt in enumerate(options_raw):
            if i < len(labels):
                options[labels[i]] = str(opt)
    # 如果 q 中直接有 A/B/C/D 键，也视为选项
    for k in ("A", "B", "C", "D", "E", "F"):
        if k in q and k not in options:
            options[k] = str(q[k])

    # ── 答案归一化：数字索引 → 字母 ──
    if answer and options:
        labels_list = sorted(options.keys())
        # 单数字：0→A, 1→B ...
        if isinstance(answer, (int, float)) or (isinstance(answer, str) and answer.strip().isdigit()):
            idx = int(float(answer)) if isinstance(answer, str) else int(answer)
            if 0 <= idx < len(labels_list):
                answer = labels_list[idx]
        # 逗号分隔的数字索引：如 "0,2" → "A,C"
        elif isinstance(answer, str) and all(s.strip().isdigit() for s in answer.replace("，", ",").split(",") if s.strip()):
            indices = [int(s.strip()) for s in answer.replace("，", ",").split(",") if s.strip()]
            letters = [labels_list[i] for i in indices if 0 <= i < len(labels_list)]
            if letters:
                answer = ",".join(letters)

    # ── 解析 ──
    explanation = _first_of("explanation", "analysis", "解析", "详解", "评论", "comment", "solution")

    # ── 知识点 ──
    kp = _first_of("knowledge_point", "knowledgePoints", "knowledge_point", "tags", "subject", "知识点", "标签")
    if isinstance(kp, (list, tuple)):
        kp = ", ".join(str(t) for t in kp)

    # ── 难度 ──
    diff = str(_first_of("difficulty", "level", "difficulty_level", "difficultyLevel", "难度")).lower()
    diff_map = {
        "easy": "easy", "简单": "easy",
        "medium": "medium", "中等": "medium", "中": "medium", "normal": "medium",
        "hard": "hard", "困难": "hard", "难": "hard",
    }
    difficulty = diff_map.get(diff, "medium")

    return {
        "type": q_type,
        "question": question,
        "options": options,
        "answer": answer,
        "explanation": explanation,
        "knowledge_point": kp,
        "difficulty": difficulty,
        "svg_code": q.get("svg_code") or q.get("svg_content", ""),
        "media_placeholders": q.get("media_placeholders") or q.get("media_files", []),
    }


def _extract_text_from_file(file_bytes: bytes, ext: str) -> str:
    """根据文件扩展名提取纯文本，支持 docx/txt/md/pdf"""
    if ext == ".docx":
        from docx import Document
        doc = Document(io.BytesIO(file_bytes))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        # 试卷题常排进表格, 只读段落会整批漏题 → 表格行一并提取
        for tb in doc.tables:
            for row in tb.rows:
                cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
                if cells:
                    paragraphs.append("  ".join(cells))
        return "\n".join(paragraphs)
    elif ext == ".pdf":
        try:
            import pypdf
            reader = pypdf.PdfReader(io.BytesIO(file_bytes))
            pages = [p.extract_text() for p in reader.pages if p.extract_text()]
            return "\n".join(pages)
        except ImportError:
            import PyPDF2
            reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
            pages = [reader.pages[i].extract_text() or "" for i in range(len(reader.pages))]
            return "\n".join(p.strip() for p in pages if p.strip())
    elif ext == ".json":
        # JSON 文件直接转为文本让 AI 提取
        raw = file_bytes.decode("utf-8", errors="replace")
        try:
            # 尝试美化输出，便于 AI 理解
            parsed = json.loads(raw)
            return json.dumps(parsed, ensure_ascii=False, indent=2)
        except json.JSONDecodeError:
            return raw
    else:  # .txt, .md
        return file_bytes.decode("utf-8", errors="replace")


def _build_extract_prompt(subject: str, difficulty: str, content: str) -> str:
    """构建 AI 提取试题的 Prompt（含公式和配图支持）"""
    from backend.prompts import build_ai_role
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(difficulty, "中等")
    ai_role = build_ai_role(subject=subject)
    MAX_EXTRACT_LEN = 7000
    trimmed = content[:MAX_EXTRACT_LEN]
    prompt = f"""下面是一段需要处理的文本数据，请根据数据后面的要求进行操作。

=== 文本数据 ===
{trimmed}
=== 数据结束 ===

{ai_role}
你的唯一任务是从上面的文本数据中提取或生成试题。
请严格按照 JSON 数组格式输出，只输出 JSON，不得有任何其他文字。

科目：{subject}
难度：{difficulty_desc}

要求：
1. 如果文本中有明确的试题（含题干、选项、答案），直接提取出来；只提取文本中真实存在的题目，禁止编造
2. 如果文本是知识点讲解，则针对每个核心知识点生成一道试题
3. 每个试题必须包含：题目、正确答案、题型（single/multiple/true_false/short/fill）
4. 选择题必须有选项（A/B/C/D），判断题选项为 {{"对":"对","错":"错"}}

JSON 格式：
[
  {{
    "type": "single/multiple/true_false/short/fill",
    "question": "题目",
    "options": {{"A":"选项", "B":"...", "C":"...", "D":"..."}},
    "answer": "正确答案",
    "explanation": "解析",
    "knowledge_point": "知识点",
    "difficulty": "easy/medium/hard"
  }}
]"""
    return prompt


# ════════════════════════════════════════════
# 新接口：含多媒体/公式的试题生成
# ════════════════════════════════════════════

class GenerateWithMediaRequest(BaseModel):
    """AI 生成试题请求（含多媒体配图和公式支持）"""
    subject: str = ""
    knowledge_points: str = ""
    question_type: str = "single"
    count: int = 5
    difficulty: str = "medium"


@router.post("/generate-with-media", summary="AI 生成试题（含SVG配图+占位符+公式）")
async def generate_questions_with_media(req: GenerateWithMediaRequest, request: Request):
    """AI 生成试题，自动配 SVG 图 / 占位符，支持 LaTeX 公式"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")
    if not req.knowledge_points.strip():
        raise HTTPException(status_code=400, detail="请输入知识点")
    if req.count < 1 or req.count > 50:
        raise HTTPException(status_code=400, detail="生成数量范围为 1-50")

    if req.question_type == "code":
        # 编程题的模板代码/测试用例只有「代码练习」能落库与判分，题库侧没有这条链路
        raise HTTPException(status_code=400, detail=CODE_BANK_NOTE)

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请先在系统配置中设置")

    # 使用增强 Prompt
    from backend.prompts.chat import QUESTION_GENERATE_WITH_MEDIA_PROMPT
    from backend.prompts.question_schema import render_question_prompt
    type_desc = {"single": "单选题（4个选项）", "multiple": "多选题（4-5个选项）",
                 "true_false": "判断题", "short": "简答题", "fill": "填空题",
                 "essay": "作文", "subjective": "主观题"}.get(req.question_type, "单选题")
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(req.difficulty, "中等")
    prompt = render_question_prompt(QUESTION_GENERATE_WITH_MEDIA_PROMPT, 
        subject=req.subject,
        knowledge_points=req.knowledge_points,
        type_desc=type_desc,
        count=req.count,
        difficulty_desc=difficulty_desc,
    )
    # 注意：不注入技能 — 技能的结构化输出指令与纯 JSON 输出要求冲突
    logger.info(f"开始调用AI生成多媒体试题: subject={req.subject}, type={req.question_type}")

    try:
        # 含配图出题输出长、结构复杂：走 json_mode，由网关兜底 JSON 合法性
        result_text = await _call_dashscope_agent(prompt, api_key, json_mode=True,
                                          kb_query=f"{req.subject} {req.knowledge_points}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 生成失败: {str(e)}")

    questions = _parse_ai_response_with_media(result_text)
    if not questions:
        raise HTTPException(status_code=502, detail="AI 返回格式异常，未能解析出试题，请重试")

    # 获取创建者姓名
    from backend.database import execute_query as user_query
    user_row = user_query("SELECT name FROM users WHERE username=?", (username,))
    creator_name = user_row[0][0] if user_row and user_row[0][0] else username

    # 入库统一走 question_factory：字段体检 → 查重（学科族 + 题型 + 规范化题干）
    # → 整批一个事务插入 → 提交后连教材知识点边（当天就进选题引擎的 T0 候选）。
    # 解析链路 _parse_ai_response（快速三策略 + ai_json 容错层 + 题干内嵌选项剥离）
    # 原样不动：历史上"客套话包裹 / 中文引号当定界符 / 尾逗号 / 响应截断"导致的
    # 无法解析，全部由那一层修好并有原文留档，这里不参与、也不许改口径。
    outcome = question_factory.persist_questions(
        questions[:req.count],
        subject=req.subject,
        source="ai",
        username=username,
        creator_name=creator_name,
        question_type=req.question_type,
        difficulty=req.difficulty,
        knowledge_points=req.knowledge_points,
    )
    saved_items = outcome["saved"]
    stats = outcome["stats"]
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    saved_questions: list[dict[str, Any]] = []
    media_notes: list[str] = []
    for n in saved_items:
        qid = n["id"]
        # ── 自动配图（通义万相）：统一走 generate_placeholders_batch ──
        # 配图状态必须**同时回写 media_placeholders 与 media_files 两列**。过去这里
        # 自己手写了一份并发版，最大的问题是只回写 media_files、不回写
        # media_placeholders：generated/failed 状态留在内存里就丢了。配图管理面板按
        # status 决定显不显示图片、给不给"AI 生成/上传替换"按钮，于是出题生成的图在
        # 面板里既看不见也点不动，失败项连"批量重试"都不出现。
        # （占位符取 factory 保留的原始列表 media_raw，生图要的是模型给的那份描述）
        placeholders = n.get("media_raw") or []
        media_files: list[dict[str, Any]] = []
        if placeholders and get_config_value("IMAGE_GEN_ENABLED", True):
            from backend.api.image_gen_service import generate_placeholders_batch

            media_dir = ensure_media_dir(SOURCE_BANK, qid)
            errors: list[str] = []
            try:
                media_files = await generate_placeholders_batch(
                    placeholders=placeholders,
                    subject=req.subject,
                    media_dir=media_dir,
                    qid=qid,
                    now=now,
                    error_sink=errors,
                ) or []
            except Exception as media_err:
                # 配图失败只降级成"无图题"，不能让整次出题（题目已入库）报错
                logger.warning(f"试题 {qid} 自动配图异常: {media_err}")
                errors.append(str(media_err)[:120])
            placeholders = attach_media(placeholders, media_files)
            execute_update(
                "UPDATE question_bank SET media_placeholders=?, media_files=? WHERE id=?",
                (dump_json(placeholders), dump_json(media_files), qid),
            )
            if errors:
                media_notes.append(f"第 {len(saved_questions) + 1} 题配图未成功：" + "；".join(errors[:1]))

        saved_questions.append({
            "id": qid,
            "type": n["type"],
            "question_text": n["question_text"],
            "options": n["options"],
            "correct_answer": n["correct_answer"],
            "explanation": n["explanation"],
            "knowledge_points": n["knowledge_points"],
            "difficulty": n["difficulty"],
            "has_svg": n["has_svg"],
            "svg_content": n["svg_content"] if n["has_svg"] else None,
            "media_placeholders": placeholders,
            "media_files": media_files,
            "media_summary": media_summary(placeholders, media_files),
        })

    # 命中题库已有题的，回填旧题一起展示（与智能提取同一口径），但不重复入库
    for d in outcome["duplicated"]:
        saved_questions.append({
            "id": d["id"], "type": d["type"], "question_text": d["question_text"],
            "options": d["options"], "correct_answer": d["correct_answer"],
            "explanation": d["explanation"], "knowledge_points": d["knowledge_points"],
            "difficulty": d["difficulty"], "has_svg": d["has_svg"],
            "svg_content": d["svg_content"], "media_placeholders": d["media_placeholders"],
            "media_files": [], "media_summary": media_summary(d["media_placeholders"], []),
            "duplicated": True,
        })

    note = _generation_note(outcome, media_notes, asked=req.count, parsed=len(questions))
    logger.info(f"用户 {username} AI 出题(含配图) 入库={stats['saved']} 重复={stats['duplicated']} "
                f"拒绝={stats['rejected']} 题型={stats['by_type']}")

    return {
        "message": f"成功生成 {stats['saved']} 道试题",
        "questions": saved_questions,
        "total": len(saved_questions),
        "requested": req.count,
        "saved": stats["saved"],
        "duplicated": stats["duplicated"],
        "rejected": stats["rejected"],
        "stats": stats,
        "note": note,
    }


def _parse_ai_response_with_media(text: str) -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 试题列表（含 svg_code / media_placeholders）"""
    questions = _parse_ai_response(text)
    # svg_code 和 media_placeholders 已在 JSON 中，原样保留
    return questions


@router.post("/generate-with-media-async", summary="AI 生成试题(含配图, 异步任务版)")
async def generate_questions_with_media_async(req: GenerateWithMediaRequest, request: Request):
    """与 /generate-with-media 相同, 但放到后台任务里跑(Q7: 出题+生图最耗时)"""
    user = get_current_user(request)
    username = user["username"]
    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")
    if not req.knowledge_points.strip():
        raise HTTPException(status_code=400, detail="请输入知识点")

    if req.question_type == "code":
        # 丢进后台任务后再抛 HTTPException 只会变成"任务失败"，这里先给出明确指引
        raise HTTPException(status_code=400, detail=CODE_BANK_NOTE)

    task_id = await _submit_ai_task(
        lambda: generate_questions_with_media(req, _InternalRequest(user)),
        f"教师 {username} AI 出题(含配图)：{req.knowledge_points}",
    )
    return {"task_id": task_id, "message": "AI 已开始出题，请稍候..."}


async def _apply_generate_svg(question_id: int, username: str, role: int) -> dict[str, Any]:
    """生成/重生成 SVG 配图的真实实现（同步端点与后台任务共用一份）

    拆出来是为了让"改异步"不必复制第二份业务逻辑 —— 配图链路历史上正是因为它
    有 7 份各写各的实现，才出现状态不回写、清洗不一致这类问题。
    """
    from backend.ai_task_manager import report_progress
    from backend.prompts.chat import SVG_GENERATE_PROMPT

    report_progress(phase="svg", message="AI 正在绘制 SVG 图示")
    row = await _verify_question_owner(question_id, username, role)

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置")

    prompt = SVG_GENERATE_PROMPT.format(
        description=row["question_text"],
        subject=row["subject"]
    )
    # 注意：不注入技能 —— 技能段带"结构化输出/展示过程"类指令，会让模型偶发把 SVG
    # 包进 {"code":0,"result":"<svg …\n…"} 这种响应壳里返回。壳里的 SVG 是被 JSON
    # 转义过的（引号变 \"、换行变 \\n），过去照原样入库，浏览器按严格 XML 解析必然
    # 失败，表现就是"生成成功但配图是空的"（2026-10 事故）。闯关侧早已按同一口径处理。

    try:
        result = await _call_dashscope_agent(prompt, api_key)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 生成 SVG 失败: {str(e)}")

    svg_code = _extract_svg_code(result)
    if not svg_code:
        logger.warning(f"SVG 生成结果不可用 (qid={question_id}): {str(result)[:160]}")
        raise HTTPException(
            status_code=502,
            detail="AI 返回的内容不是可渲染的 SVG（可能被包裹成 JSON 或被截断），请重试一次",
        )

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE question_bank SET svg_content=?, has_svg=1, updated_at=? WHERE id=?",
        (svg_code, now, question_id),
    )
    report_progress(phase="done", message="SVG 配图已写入")
    return {"message": "SVG 配图已生成", "svg_code": svg_code}


@router.post("/{question_id}/generate-svg", summary="为指定试题生成/重新生成SVG配图")
async def generate_svg_for_question(question_id: int, request: Request):
    """为已有试题单独生成或重新生成SVG配图（同步版，保留兼容）"""
    user = get_current_user(request)
    return await _apply_generate_svg(question_id, user["username"], user.get("role", 2))


@router.post("/{question_id}/generate-svg-async", summary="为试题生成SVG配图（异步任务版）")
async def generate_svg_for_question_async(question_id: int, request: Request):
    """generate-svg 的后台任务版：先校验权限再入队，避免鉴权失败被吞成一条难以理解的「任务失败」"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    _precheck_media_action(question_id, username, role, "svg")

    task_id = await _submit_ai_task(
        _as_media_task(lambda: _apply_generate_svg(question_id, username, role)),
        f"教师 {username} 生成试题 SVG 配图 (id={question_id})",
        owner=username,
        dedupe_key=f"q_svg:{question_id}",
        reuse_completed=False,
    )
    return {"task_id": task_id, "message": "SVG 配图生成中，请稍候...",
            "poll_url": f"/api/interaction/ai-task/{task_id}"}


def _extract_svg_code(text: str) -> str:
    """从 AI 返回文本中提取并清洗 SVG（安全规则见 backend.svg_safety）"""
    svg_code = sanitize_svg(extract_svg(text))
    return svg_code if is_usable_svg(svg_code) else ""


async def _apply_generate_media(question_id: int, placeholder_key: str,
                                username: str, role: int) -> dict[str, Any]:
    """为指定占位符调用通义万相生成图片（同步端点与后台任务共用）

    三条底线：
    - 畸形数据（缺 key/description、非 dict 项）不再抛 KeyError 变成 500；
    - **先出新图再删旧图**，历史实现是"先删旧的再生成"，生成失败就两头空；
    - 失败时把真实原因（模型/状态码）回传给教师，并把该占位符标成 failed，
      这样"批量重试失败项"才会出现在面板上。
    """
    from backend.ai_task_manager import report_progress
    from backend.prompts.chat import IMAGE_GEN_PROMPT_TEMPLATE
    from backend.api.image_gen_service import generate_and_save_image

    row = await _verify_question_owner(question_id, username, role)
    if not get_config_value("IMAGE_GEN_ENABLED", True):
        raise HTTPException(status_code=400, detail="系统未开启 AI 生图功能（系统配置 → IMAGE_GEN_ENABLED）")

    placeholders, media_files = _question_media_rows(row)
    target = next((p for p in placeholders if p.get("key") == placeholder_key), None)
    if not target:
        raise HTTPException(status_code=404, detail="占位符不存在")

    description = str(target.get("description") or "").strip()
    if not description:
        raise HTTPException(status_code=400,
                            detail="该占位符缺少图片描述，请改用「万相生图」或直接上传图片")

    prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
        subject=row["subject"] or "通用",
        purpose=target.get("purpose") or "示意图",
        description=description,
    )

    media_dir = ensure_media_dir(SOURCE_BANK, question_id)
    errors: list[str] = []
    report_progress(phase="image", total=1, done=0, message="万相正在生成配图")
    local_path = await generate_and_save_image(prompt, media_dir, error_sink=errors)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if not local_path:
        target["status"] = "failed"
        execute_update(
            "UPDATE question_bank SET media_placeholders=?, updated_at=? WHERE id=?",
            (dump_json(placeholders), now, question_id),
        )
        reason = (errors[0] if errors else "生图服务未返回图片")[:180]
        logger.warning(f"占位符生图失败 (qid={question_id} key={placeholder_key}): {reason}")
        raise HTTPException(status_code=502, detail=f"AI 生图失败：{reason}")

    relative_url = url_for(SOURCE_BANK, question_id, Path(local_path).name)

    # 新图已落盘，才清理旧图
    old_entry = next((f for f in media_files if f.get("key") == placeholder_key), None)
    if old_entry:
        old_url = old_entry.get("url") or ""
        if old_url and old_url != relative_url:
            _delete_physical_media(question_id, old_url)
        old_entry["url"] = relative_url
        old_entry["type"] = "image"
        old_entry["alt"] = description
        old_entry["created_at"] = now
    else:
        media_files.append({
            "key": placeholder_key,
            "type": "image",
            "url": relative_url,
            "alt": description,
            "created_at": now,
        })

    target["status"] = "generated"
    execute_update(
        "UPDATE question_bank SET media_placeholders=?, media_files=?, updated_at=? WHERE id=?",
        (dump_json(placeholders), dump_json(media_files), now, question_id),
    )
    report_progress(phase="done", done=1, message="配图已写入题库")
    return {"message": "图片已生成", "url": relative_url, "placeholder_key": placeholder_key,
            "status": "generated"}


@router.post("/{question_id}/generate-media/{placeholder_key}", summary="为占位符调用AI生图")
async def generate_media_for_placeholder(
    question_id: int,
    placeholder_key: str,
    request: Request,
):
    """为指定占位符调用通义万相生成图片（同步版，保留兼容）"""
    user = get_current_user(request)
    return await _apply_generate_media(question_id, placeholder_key,
                                       user["username"], user.get("role", 2))


@router.post("/{question_id}/generate-media/{placeholder_key}/async",
             summary="为占位符调用AI生图（异步任务版）")
async def generate_media_for_placeholder_async(
    question_id: int,
    placeholder_key: str,
    request: Request,
):
    """/generate-media/{key} 的后台任务版

    为什么值得异步：万相同步等待 + 最多 3 模型 × 3 次重试，前端那条 320s 的 HTTP
    长连接在反代/网关下必断；断连后教师看到"失败"，图却可能已经生成并计费。
    """
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    _precheck_media_action(question_id, username, role, "media", placeholder_key)

    task_id = await _submit_ai_task(
        _as_media_task(lambda: _apply_generate_media(question_id, placeholder_key, username, role)),
        f"教师 {username} 生成试题配图 (id={question_id} 占位符={placeholder_key})",
        owner=username,
        dedupe_key=f"q_media:{question_id}:{placeholder_key}",
        reuse_completed=False,
    )
    return {"task_id": task_id, "message": "配图生成中，请稍候...",
            "poll_url": f"/api/interaction/ai-task/{task_id}"}


async def _apply_generate_image(question_id: int, username: str, role: int) -> dict[str, Any]:
    """万相直接生成配图（同步端点与后台任务共用一份实现）

    生成的条目固定 key="wanxiang"，重复点击替换旧图；配图管理面板会把它和占位符
    一起列出来（历史实现只回写 manifest，面板按占位符渲染，导致这张图永远看不见）。
    """
    from backend.ai_task_manager import report_progress
    from backend.prompts.chat import IMAGE_GEN_PROMPT_TEMPLATE
    from backend.api.image_gen_service import generate_and_save_image

    row = await _verify_question_owner(question_id, username, role)

    if not get_config_value("IMAGE_GEN_ENABLED", True):
        raise HTTPException(status_code=400, detail="系统未开启 AI 生图功能（系统配置 → IMAGE_GEN_ENABLED）")

    q_text = (row["question_text"] or "")[:200]
    if len(q_text) < 10:
        raise HTTPException(status_code=400, detail="题干过短，无法生成配图")

    subject = row["subject"] or "通用"
    prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
        subject=subject,
        purpose="示意图",
        description=f"与「{q_text}」相关的教学插图，适合{subject}课堂展示",
    )

    media_dir = ensure_media_dir(SOURCE_BANK, question_id)
    errors: list[str] = []
    report_progress(phase="image", total=1, done=0, message="万相正在生成配图")
    local_path = await generate_and_save_image(prompt, media_dir, error_sink=errors)
    if not local_path:
        reason = (errors[0] if errors else "生图服务未返回图片")[:180]
        logger.warning(f"试题直接配图失败 (qid={question_id}): {reason}")
        raise HTTPException(status_code=502, detail=f"AI 生图失败：{reason}")

    relative_url = url_for(SOURCE_BANK, question_id, Path(local_path).name)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    placeholders, media_files = _question_media_rows(row)
    key = "wanxiang"
    existing = next((f for f in media_files if f.get("key") == key), None)
    if existing:
        old_url = existing.get("url") or ""
        if old_url and old_url != relative_url:
            _delete_physical_media(question_id, old_url)
        existing["url"] = relative_url
        existing["type"] = "image"
        existing["alt"] = q_text[:100]
        existing["created_at"] = now
    else:
        media_files.append({
            "key": key,
            "type": "image",
            "url": relative_url,
            "alt": q_text[:100],
            "created_at": now,
        })

    # manifest 里有条目但没有占位符时补一条，面板才有"删除/再来一张"的落点
    placeholders = attach_media(placeholders, media_files)

    execute_update(
        "UPDATE question_bank SET media_placeholders=?, media_files=?, updated_at=? WHERE id=?",
        (dump_json(placeholders), dump_json(media_files), now, question_id),
    )

    report_progress(phase="done", done=1, message="配图已写入题库")
    return {"message": "配图已生成", "url": relative_url, "key": key,
            "media_summary": media_summary(placeholders, media_files)}


@router.post("/{question_id}/generate-image", summary="万相生图（直接为试题生成配图）")
async def generate_image_for_question(question_id: int, request: Request):
    """直接用通义万相为试题生成配图（同步版，保留兼容）"""
    user = get_current_user(request)
    return await _apply_generate_image(question_id, user["username"], user.get("role", 2))


@router.post("/{question_id}/generate-image-async", summary="万相生图（异步任务版）")
async def generate_image_for_question_async(question_id: int, request: Request):
    """generate-image 的后台任务版：权限先校验，生图在后台跑，前端轮询进度"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    _precheck_media_action(question_id, username, role, "image")

    task_id = await _submit_ai_task(
        _as_media_task(lambda: _apply_generate_image(question_id, username, role)),
        f"教师 {username} 万相直接生图 (id={question_id})",
        owner=username,
        dedupe_key=f"q_image:{question_id}",
        reuse_completed=False,
    )
    return {"task_id": task_id, "message": "配图生成中，请稍候...",
            "poll_url": f"/api/interaction/ai-task/{task_id}"}


@router.post("/{question_id}/upload-media/{placeholder_key}", summary="上传图片替换占位符")
async def upload_media_for_placeholder(
    question_id: int,
    placeholder_key: str,
    request: Request,
    file: UploadFile = File(...),
):
    """上传图片替换指定占位符"""
    user = get_current_user(request)
    username = user["username"]

    row = await _verify_question_owner(question_id, username, user.get("role", 2))

    # 只看扩展名不够：改名成 .png 的任意文件也能进来。这里按字节魔数判定真实格式
    import uuid

    from backend.api.image_gen_service import _sniff_image_format

    _, declared_ext = os.path.splitext((file.filename or "").lower())
    allowed = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}
    if declared_ext not in allowed:
        raise HTTPException(status_code=400, detail=f"不支持的图片格式: {declared_ext}")

    max_size_mb = get_config_value("MAX_IMAGE_SIZE_MB", 5)
    max_size = max_size_mb * 1024 * 1024
    content = await file.read()
    if len(content) > max_size:
        raise HTTPException(status_code=400, detail=f"图片大小超过 {max_size_mb}MB 限制")

    fmt = _sniff_image_format(content)
    if not fmt:
        raise HTTPException(status_code=400, detail="上传内容不是可识别的图片文件")
    ext = ".jpg" if fmt == "jpg" else f".{fmt}"

    # 先落盘，成功后才清理旧文件（反序时写盘失败会把原图一起弄丢）
    media_dir = ensure_media_dir(SOURCE_BANK, question_id)
    file_id = uuid.uuid4().hex
    save_path = media_dir / f"{file_id}{ext}"
    try:
        save_path.write_bytes(content)
    except OSError as e:
        logger.warning(f"配图上传写盘失败 (id={question_id}): {e}")
        raise HTTPException(status_code=500, detail="配图保存失败，请稍后重试")

    placeholders, media_files = _question_media_rows(row)
    target = next((ph for ph in placeholders if ph.get("key") == placeholder_key), None)
    if target:
        target["status"] = "uploaded"

    relative_url = url_for(SOURCE_BANK, question_id, save_path.name)
    alt_text = (target.get("description") if target else "") or (file.filename or "上传图片")
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    file_entry = next((f for f in media_files if f.get("key") == placeholder_key), None)
    if file_entry:
        old_url = file_entry.get("url") or ""
        if old_url and old_url != relative_url:
            # Q6: 覆盖后删掉旧物理文件, 否则每次重传都在磁盘上留一份孤儿
            _delete_physical_media(question_id, old_url)
        file_entry["url"] = relative_url
        file_entry["type"] = "image"
        file_entry["alt"] = str(alt_text)[:300]
        file_entry["created_at"] = now
    else:
        media_files.append({
            "key": placeholder_key,
            "type": "image",
            "url": relative_url,
            "alt": str(alt_text)[:300],
            "created_at": now,
        })

    placeholders = attach_media(placeholders, media_files)
    execute_update(
        "UPDATE question_bank SET media_placeholders=?, media_files=?, updated_at=? WHERE id=?",
        (dump_json(placeholders), dump_json(media_files), now, question_id)
    )

    return {"message": "图片上传成功", "url": relative_url,
            "placeholder_key": placeholder_key, "status": "uploaded"}


@router.delete("/{question_id}/svg", summary="删除 SVG 配图")
async def delete_svg_for_question(question_id: int, request: Request):
    """删除指定试题的 SVG 配图"""
    user = get_current_user(request)
    username = user["username"]

    await _verify_question_owner(question_id, username, user.get("role", 2))

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE question_bank SET svg_content='', has_svg=0, updated_at=? WHERE id=?",
        (now, question_id),
    )

    return {"message": "SVG 配图已删除", "question_id": question_id}


@router.delete("/{question_id}/media/{placeholder_key}", summary="删除配图/重置占位符")
async def delete_media_for_placeholder(
    question_id: int,
    placeholder_key: str,
    request: Request,
):
    """删除指定占位符的配图，重置为未配图状态

    顺序：先更新数据库里的引用关系，再删物理文件 —— 反序时如果写库失败，
    manifest 就会指向一个已经不存在的文件（图裂 + 无法恢复）。
    """
    user = get_current_user(request)
    username = user["username"]

    row = await _verify_question_owner(question_id, username, user.get("role", 2))

    placeholders, old_files = _question_media_rows(row)
    target = next((ph for ph in placeholders if ph.get("key") == placeholder_key), None)
    if target:
        target["status"] = "pending"

    remaining_files = [f for f in old_files if f.get("key") != placeholder_key]
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE question_bank SET media_placeholders=?, media_files=?, updated_at=? WHERE id=?",
        (dump_json(placeholders), dump_json(remaining_files), now, question_id)
    )

    deleted_file = next((f for f in old_files if f.get("key") == placeholder_key), None)
    _delete_physical_media(question_id, deleted_file.get("url", "") if deleted_file else "")

    return {"message": "配图已删除", "placeholder_key": placeholder_key,
            "media_summary": media_summary(placeholders, remaining_files)}
