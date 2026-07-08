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
import shutil
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query, UploadFile, File, Form
from pydantic import BaseModel

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

# 复用聊天模块的 API Key 获取函数
from backend.api.chat_router import get_api_keys
from backend.prompts import apply_skills

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
    options: str | None = None
    correct_answer: str | None = None
    explanation: str | None = None
    knowledge_points: str | None = None
    difficulty: str | None = None


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

    # 处理配图字段
    svg_content = req.svg_content or ""
    has_svg = req.has_svg if req.has_svg else (1 if svg_content.strip() else 0)
    media_placeholders_str = ""
    if req.media_placeholders:
        if isinstance(req.media_placeholders, (dict, list)):
            media_placeholders_str = json.dumps(req.media_placeholders, ensure_ascii=False)
        else:
            media_placeholders_str = req.media_placeholders
    media_files_str = ""
    if req.media_files:
        if isinstance(req.media_files, (dict, list)):
            media_files_str = json.dumps(req.media_files, ensure_ascii=False)
        else:
            media_files_str = req.media_files

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
):
    """删除指定 URL 对应的物理图片文件（静默忽略不存在的情况）"""
    if not url:
        return
    from backend.config import BASE_DIR
    from pathlib import Path
    filename = url.rstrip("/").split("/")[-1]
    file_path = BASE_DIR / "question_media" / str(question_id) / filename
    if file_path.exists():
        file_path.unlink()


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

    # 获取 API Key
    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请先在系统配置中设置")

    # 构造 Prompt
    type_desc = QUESTION_TYPE_MAP.get(req.question_type, "单选题")
    prompt = _build_generate_prompt(req.subject, req.knowledge_points, type_desc, req.count, req.difficulty, username)
    prompt = apply_skills(prompt, "quiz")
    logger.info(f"开始调用AI生成试题: subject={req.subject}, type={req.question_type}, count={req.count}")

    # 调用 AI
    try:
        result_text = await _call_dashscope_agent(prompt, api_key)
        logger.info(f"AI 返回原始内容: {result_text[:300]}")
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

    # 入库
    saved_questions = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for q_data in questions[:req.count]:
        q_type = q_data.get("type", req.question_type)
        options_str = json.dumps(q_data.get("options", {}), ensure_ascii=False) if q_data.get("options") else ""
        svg_code = q_data.get("svg_code") or ""
        has_svg = 1 if svg_code.strip() else 0
        media_placeholders = json.dumps(q_data.get("media_placeholders") or [], ensure_ascii=False)
        qid = execute_insert(
            """INSERT INTO question_bank
               (type, question_text, options, correct_answer, explanation,
                knowledge_points, subject, difficulty, creator_username, creator_name,
                source, status, created_at, updated_at,
                svg_content, has_svg, media_placeholders)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', 'active', ?, ?,
                       ?, ?, ?)""",
            (
                q_type,
                q_data.get("question", ""),
                options_str,
                q_data.get("answer", ""),
                q_data.get("explanation", ""),
                q_data.get("knowledge_point", req.knowledge_points),
                req.subject,
                q_data.get("difficulty", req.difficulty),
                username,
                creator_name,
                now,
                now,
                svg_code, has_svg, media_placeholders,
            ),
        )

        # 如果是代码题，额外创建 code_problems + code_test_cases
        if q_type == 'code':
            assert qid is not None
            _save_code_problem(qid, q_data, username, now)

        saved_questions.append({
            "id": qid,
            "type": q_type,
            "question_text": q_data.get("question", ""),
            "options": q_data.get("options", {}),
            "correct_answer": q_data.get("answer", ""),
            "explanation": q_data.get("explanation", ""),
            "knowledge_points": q_data.get("knowledge_point", req.knowledge_points),
            "difficulty": q_data.get("difficulty", req.difficulty),
        })

    logger.info(f"用户 {username} 生成并入库 {len(saved_questions)} 道{req.question_type}题")
    return {
        "message": f"成功生成 {len(saved_questions)} 道{TYPE_DESC.get(req.question_type, '')}",
        "questions": saved_questions,
        "total": len(saved_questions),
    }


def _build_generate_prompt(subject: str, knowledge_points: str, type_desc: str, count: int, difficulty: str, username: str = "") -> str:
    """构建 AI 生成试题的 Prompt（使用集中化模板）"""
    from backend.prompts.chat import QUESTION_GENERATE_PROMPT
    from backend.prompts import build_ai_role
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(difficulty, "中等")
    ai_role = build_ai_role(subject=subject)
    return f"{ai_role}\n" + QUESTION_GENERATE_PROMPT.format(
        subject=subject,
        knowledge_points=knowledge_points,
        type_desc=type_desc,
        count=count,
        difficulty_desc=difficulty_desc,
    )


async def _call_dashscope_agent(prompt: str, api_key: str) -> str:
    """调用 AI（异步）- 支持智能体/直接调大模型双模式"""
    from backend.api.ai_service import call_ai_async
    return await call_ai_async(prompt, api_key)


def _parse_ai_response(text: str) -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 试题列表"""
    # 尝试直接解析
    text = text.strip()
    
    # 尝试提取 JSON 数组（处理 AI 可能额外输出的内容）
    json_match = re.search(r'\[[\s\S]*\]', text)
    if json_match:
        json_str = json_match.group()
    else:
        json_str = text

    # 清理可能的 Markdown 代码块标记
    json_str = json_str.replace("```json", "").replace("```", "").strip()

    try:
        questions = json.loads(json_str)
        if isinstance(questions, list):
            return questions
        elif isinstance(questions, dict) and "questions" in questions:
            return questions["questions"]
    except json.JSONDecodeError as e:
        logger.error(f"JSON 解析失败: {e}, 原文: {text[:200]}")
        return []

    return []


def _save_code_problem(question_id: int, q_data: dict[str, Any], username: str, now: str):
    """保存代码题的 code_problems 和 code_test_cases 记录"""
    try:
        language = q_data.get("language", "python")
        template_code = q_data.get("template_code", "")
        starter_code = q_data.get("starter_code", "")
        test_cases = q_data.get("test_cases", []) or []

        pid = execute_insert(
            """INSERT INTO code_problems
               (question_id, template_code, starter_code, language, time_limit, created_at, updated_at)
               VALUES (?, ?, ?, ?, 5, ?, ?)""",
            (question_id, template_code, starter_code, language, now, now),
        )

        for i, tc in enumerate(test_cases):
            execute_insert(
                """INSERT INTO code_test_cases
                   (problem_id, input, expected_output, is_sample, score, sort_order, description, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (pid,
                 tc.get("input", ""),
                 tc.get("expected_output", ""),
                 1 if tc.get("is_sample") else 0,
                 tc.get("score", 1),
                 i,
                 tc.get("description", ""),
                 now),
            )

        logger.info(f"代码题已保存: question_id={question_id}, problem_id={pid}, test_cases={len(test_cases)}")
    except Exception as e:
        logger.error(f"保存代码题失败 (question_id={question_id}): {e}")


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
    page_size: int = Query(50, ge=1, le=200),
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
        conditions.append("(q.question_text LIKE ? OR q.knowledge_points LIKE ?)")
        kw = f"%{keyword}%"
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

    return {
        "questions": rows,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/{question_id}")
async def get_question(question_id: int, request: Request):
    """获取单道试题详情"""
    get_current_user(request)  # 仅验证登录

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

    # 构建更新字段
    updates = []
    params = []
    for field in ["question_text", "options", "correct_answer", "explanation", "knowledge_points", "difficulty"]:
        val = getattr(req, field, None)
        if val is not None:
            if field == "options" and isinstance(val, dict):
                val = json.dumps(val, ensure_ascii=False)
            updates.append(f"{field} = ?")
            params.append(val)

    if not updates:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")

    updates.append("updated_at = ?")
    params.append(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    params.append(question_id)

    execute_update(
        f"UPDATE question_bank SET {', '.join(updates)} WHERE id = ?",
        tuple(params),
    )

    return {"message": "更新成功"}


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

    # 检查是否有考试引用该题
    exam_refs = execute_query(
        """SELECT e.id, e.title FROM exams e
           JOIN exam_questions eq ON eq.exam_id = e.id
           WHERE eq.question_id = ?""",
        (question_id,),
    )
    # 检查是否有智能练习引用该题
    practice_refs = []
    try:
        from backend.database import execute_query_dict as db_query
        practice_refs = db_query(
            """SELECT ps.id, ps.title FROM practice_sessions ps
               JOIN practice_session_questions psq ON psq.session_id = ps.id
               WHERE psq.question_id = ?""",
            (question_id,),
        )
    except Exception:
        pass

    if exam_refs or practice_refs:
        details = []
        if exam_refs:
            exam_names = "、".join([f"「{r['title']}」" for r in exam_refs])
            details.append(f"考试({len(exam_refs)}个)：{exam_names}")
        if practice_refs:
            practice_names = "、".join([f"「{r['title']}」" for r in practice_refs])
            details.append(f"智能练习({len(practice_refs)}个)：{practice_names}")
        return {
            "status": "error",
            "message": "该试题正在被使用中，无法删除。请先在相关活动中移除该题后再试。",
            "refs": "；".join(details),
        }

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE question_bank SET status = 'deleted', updated_at = ? WHERE id = ?",
        (now, question_id),
    )

    # 清理配图目录
    try:
        from backend.config import BASE_DIR
        media_dir = BASE_DIR / "question_media" / str(question_id)
        if media_dir.exists():
            shutil.rmtree(media_dir)
            logger.info(f"已清理试题配图目录: question_media/{question_id}")
    except Exception as e:
        logger.warning(f"清理试题配图目录失败 (id={question_id}): {e}")

    return {"message": "删除成功"}


@router.post("/dedup")
async def dedup_questions(request: Request):
    """查找并删除重复试题（基于题目文本完全匹配），保留最早创建的那条"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：需要教师或管理员权限")

    # 查找重复的 question_text（只统计 active 状态的）
    rows = execute_query(
        """SELECT question_text, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
           FROM question_bank
           WHERE status = 'active'
           GROUP BY question_text
           HAVING cnt > 1"""
    )

    results = []
    total_deleted = 0
    total_skipped_owner = 0
    total_skipped_ref = 0

    for row in rows:
        question_text = row["question_text"]
        id_list = sorted([int(x) for x in row["ids"].split(",")])
        keep_id = id_list[0]
        delete_ids = id_list[1:]

        allowed_delete = []
        skipped_owner = 0
        skipped_ref = 0
        for did in delete_ids:
            q = execute_query_one(
                "SELECT creator_username FROM question_bank WHERE id = ?", (did,)
            )
            if not q or (role != 0 and q["creator_username"] != username):
                skipped_owner += 1
                continue
            # 检查是否被考试引用
            ref_exam = execute_query_one(
                "SELECT COUNT(*) as cnt FROM exam_questions WHERE question_id=?",
                (did,),
            )
            if ref_exam and ref_exam["cnt"] > 0:
                skipped_ref += 1
                continue
            # 检查是否被智能练习引用
            try:
                from backend.database import execute_query_dict as db_query
                ref_practice = db_query(
                    "SELECT 1 FROM practice_session_questions WHERE question_id=? LIMIT 1",
                    (did,),
                )
                if ref_practice:
                    skipped_ref += 1
                    continue
            except Exception:
                pass
            allowed_delete.append(did)

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for did in allowed_delete:
            execute_update(
                "UPDATE question_bank SET status = 'deleted', updated_at = ? WHERE id = ?",
                (now, did),
            )
            # 清理配图目录
            try:
                from backend.config import BASE_DIR
                media_dir = BASE_DIR / "question_media" / str(did)
                if media_dir.exists():
                    shutil.rmtree(media_dir)
            except Exception:
                pass

        if allowed_delete or skipped_owner or skipped_ref:
            results.append({
                "question_text": question_text[:60] + ("..." if len(question_text) > 60 else ""),
                "keep_id": keep_id,
                "deleted_ids": allowed_delete,
                "count": len(allowed_delete),
                "skipped_owner": skipped_owner,
                "skipped_ref": skipped_ref,
            })
            total_deleted += len(allowed_delete)
            total_skipped_owner += skipped_owner
            total_skipped_ref += skipped_ref

    msg = f"共删除 {total_deleted} 条重复试题"
    parts = []
    if total_deleted:
        parts.append(f"删除 {total_deleted} 条")
    if total_skipped_owner:
        parts.append(f"{total_skipped_owner} 条因权限不足跳过")
    if total_skipped_ref:
        parts.append(f"{total_skipped_ref} 条因被活动引用跳过")
    msg = "，".join(parts) if parts else "未发现重复试题"
    logger.info(f"去重完成: {msg}, by={username}")
    return {
        "total_deleted": total_deleted,
        "total_skipped_owner": total_skipped_owner,
        "total_skipped_ref": total_skipped_ref,
        "groups": results,
        "message": msg,
    }


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
            content = _extract_text_from_file(file_bytes, ext)
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

    # ── JSON 文件直接解析（不调用 AI） ──
    questions = None
    json_bytes: bytes | None = None
    if file and file.filename and source_label == "json":
        json_bytes = content.encode("utf-8")
    if json_bytes:
        try:
            parsed = json.loads(json_bytes.decode("utf-8", errors="replace"))
            if isinstance(parsed, list):
                raw_questions = parsed
            elif isinstance(parsed, dict) and "questions" in parsed:
                raw_questions = parsed["questions"]
            else:
                raw_questions = []
            # 智能识别并规范化字段名
            if raw_questions and all(isinstance(q, dict) for q in raw_questions):
                normalized = []
                for q in raw_questions:
                    nq = _normalize_question_json(q)
                    if nq.get("question"):
                        normalized.append(nq)
                if normalized:
                    questions = normalized
                    source_label = "json_import"
                    logger.info(f"JSON 文件直接解析成功（{len(raw_questions)} 项，归一化后 {len(questions)} 道有效试题），跳过 AI 提取")
        except Exception as e:
            logger.info(f"JSON 直接解析失败，回退到 AI 提取: {e}")

    # ── 非 JSON 或 JSON 回退：走 AI 提取 ──
    if questions is None:
        # 截取过长内容（JSON 直接解析不截断）
        MAX_CHARS = 50000
        if len(content) > MAX_CHARS:
            logger.info(f"文本内容过长 ({len(content)} 字符)，已截取前 {MAX_CHARS} 字符")
            content = content[:MAX_CHARS]

        # 获取 API Key
        api_key, _ = get_api_keys(username)
        if not api_key:
            raise HTTPException(status_code=400, detail="未配置 API Key，请先在系统配置中设置")

        # 构造提取 Prompt
        prompt = _build_extract_prompt(subject, difficulty, content)
        prompt = apply_skills(prompt, "quiz")
        logger.info(f"开始调用AI提取试题: subject={subject}, source={source_label}, content_len={len(content)}")

        # 调用 AI
        try:
            result_text = await _call_dashscope_agent(prompt, api_key)
            logger.info(f"AI 返回原始内容: {result_text[:300]}")
        except Exception as e:
            logger.error(f"AI 提取试题失败: {e}")
            raise HTTPException(status_code=502, detail=f"AI 提取失败: {str(e)}")

        # 解析 JSON
        questions = _parse_ai_response(result_text)
        if not questions:
            logger.error(f"AI 返回无法解析: {result_text[:500]}")
            raise HTTPException(status_code=502, detail="AI 返回格式异常，未能提取出试题，请重试")

    # 获取创建者姓名
    from backend.database import execute_query as user_query
    user_row = user_query("SELECT name FROM users WHERE username=?", (username,))
    creator_name = user_row[0][0] if user_row and user_row[0][0] else username

    # 入库
    saved_questions = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for q_data in questions:
        q_type = q_data.get("type", "single")
        options_str = json.dumps(q_data.get("options", {}), ensure_ascii=False) if q_data.get("options") else ""
        svg_code = q_data.get("svg_code") or ""
        has_svg = 1 if svg_code.strip() else 0
        media_placeholders = json.dumps(q_data.get("media_placeholders") or [], ensure_ascii=False)
        qid = execute_insert(
            """INSERT INTO question_bank
               (type, question_text, options, correct_answer, explanation,
                knowledge_points, subject, difficulty, creator_username, creator_name,
                source, status, created_at, updated_at,
                svg_content, has_svg, media_placeholders)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?,
                       ?, ?, ?)""",
            (
                q_type,
                q_data.get("question", ""),
                options_str,
                q_data.get("answer", ""),
                q_data.get("explanation", ""),
                q_data.get("knowledge_point", ""),
                subject,
                q_data.get("difficulty", difficulty),
                username,
                creator_name,
                source_label,
                now,
                now,
                svg_code, has_svg, media_placeholders,
            ),
        )
        saved_questions.append({
            "id": qid,
            "type": q_type,
            "question_text": q_data.get("question", ""),
            "options": q_data.get("options", {}),
            "correct_answer": q_data.get("answer", ""),
            "explanation": q_data.get("explanation", ""),
            "knowledge_points": q_data.get("knowledge_point", ""),
            "difficulty": q_data.get("difficulty", difficulty),
            "has_svg": has_svg,
            "svg_content": svg_code if has_svg else None,
            "media_placeholders": q_data.get("media_placeholders") or [],
            "media_files": [],
        })

    source_display = {"docx": "Word文档", "txt": "文本文件", "md": "Markdown文件", "pdf": "PDF文件", "json": "JSON文件", "json_import": "JSON文件", "paste": "粘贴文本"}
    logger.info(f"用户 {username} 从{source_display.get(source_label, '文件')}提取并入库 {len(saved_questions)} 道试题")
    return {
        "message": f"成功提取 {len(saved_questions)} 道试题",
        "questions": saved_questions,
        "total": len(saved_questions),
    }


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
    import httpx
    import base64

    file_bytes = await file.read()
    if len(file_bytes) < 100:
        raise HTTPException(status_code=400, detail="图片内容过小，请上传清晰的试卷截图")

    # 根据扩展名确定 MIME 类型
    mime_map = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'}
    mime_type = mime_map.get(ext, 'image/jpeg')
    encoded = base64.b64encode(file_bytes).decode("utf-8")

    # 获取 API Key
    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    # 调用视觉模型提取试题
    model_name = get_config_value("MODEL_VL_NAME", "qwen3-vl-plus")
    api_base = get_config_value("QWEN_OPENAI_API_BASE", "https://dashscope.aliyuncs.com/compatible-mode/v1")

    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(difficulty, "中等")
    prompt_text = f"""你是一个试题提取助手。请从图片中识别并提取出所有试题。
按照 JSON 格式输出。

科目：{subject}
难度：{difficulty_desc}

要求：
1. 仔细查看图片，提取其中的试题（题干、选项、答案）
2. 涉及公式用 $...$ LaTeX 语法标记
3. 可根据题目内容生成 svg_code 和 media_placeholders
4. **⚠️ 安全约束**：svg_code 和 media_placeholders 生成的配图中**严禁**出现题目答案、解析、解题过程或任何会泄露正确选项的文字内容

只返回 JSON 数组：
[
  {{
    "type": "single/multiple/true_false/short/fill/essay/subjective",
    "question": "题目内容（含 $...$ 公式）",
    "options": {{"A":"选项", "B":"...", "C":"...", "D":"..."}},
    "answer": "正确答案",
    "explanation": "解析",
    "knowledge_point": "知识点",
    "difficulty": "easy/medium/hard",
    "svg_code": "<svg>...</svg>",
    "media_placeholders": [{{"key":"p1","description":"图片描述","purpose":"示意图"}}]
  }}
]

注意：
- 判断题 options 为 {{"对":"对", "错":"错"}}，answer 为"对"或"错"
- 简答题/填空题 options 为 null，answer 为参考答案
- 作文/主观题 options 为 null，answer 为评分要点"""

    async with httpx.AsyncClient(timeout=120) as client:
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
                    ]
                }],
                "stream": False,
            },
        )

    if resp.status_code != 200:
        err_msg = resp.text[:500]
        logger.error(f"视觉模型调用失败: status={resp.status_code}, {err_msg}")
        raise HTTPException(status_code=502, detail=f"视觉模型调用失败: {err_msg}")

    result_text = resp.json()["choices"][0]["message"]["content"]
    logger.info(f"图片提取 AI 返回: {result_text[:200]}")

    # 解析 JSON
    json_match = re.search(r'\[[\s\S]*\]', result_text)
    if not json_match:
        raise HTTPException(status_code=502, detail="AI 返回格式异常，未能提取出试题")

    questions = json.loads(json_match.group())
    if not questions:
        raise HTTPException(status_code=502, detail="未提取到任何试题")

    # 入库（复用文本提取的入库逻辑）
    from backend.database import execute_query as user_query
    user_row = user_query("SELECT name FROM users WHERE username=?", (username,))
    creator_name = user_row[0][0] if user_row and user_row[0][0] else username

    saved_questions = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for q_data in questions:
        q_type = q_data.get("type", "single")
        options_str = json.dumps(q_data.get("options", {}), ensure_ascii=False) if q_data.get("options") else ""
        svg_code = q_data.get("svg_code") or ""
        has_svg = 1 if svg_code.strip() else 0
        media_placeholders = json.dumps(q_data.get("media_placeholders") or [], ensure_ascii=False)
        qid = execute_insert(
            """INSERT INTO question_bank
               (type, question_text, options, correct_answer, explanation,
                knowledge_points, subject, difficulty, creator_username, creator_name,
                source, status, created_at, updated_at,
                svg_content, has_svg, media_placeholders)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image_extract', 'active', ?, ?,
                       ?, ?, ?)""",
            (
                q_type,
                q_data.get("question", ""),
                options_str,
                q_data.get("answer", ""),
                q_data.get("explanation", ""),
                q_data.get("knowledge_point", ""),
                subject,
                q_data.get("difficulty", difficulty),
                username, creator_name,
                now, now,
                svg_code, has_svg, media_placeholders,
            ),
        )
        saved_questions.append({
            "id": qid, "type": q_type,
            "question_text": q_data.get("question", ""),
            "options": q_data.get("options", {}),
            "correct_answer": q_data.get("answer", ""),
            "explanation": q_data.get("explanation", ""),
            "knowledge_points": q_data.get("knowledge_point", ""),
            "difficulty": q_data.get("difficulty", difficulty),
            "has_svg": has_svg, "svg_content": svg_code if has_svg else None,
            "media_placeholders": q_data.get("media_placeholders") or [],
            "media_files": [],
        })

    return {
        "message": f"成功从图片提取 {len(saved_questions)} 道试题",
        "questions": saved_questions,
        "total": len(saved_questions),
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
    prompt = f"""{ai_role}
你是一个试题提取助手。下面是一些文本内容，可能包含试题和答案。
请从文本中识别并提取出所有试题，按照 JSON 格式输出。

科目：{subject}
难度：{difficulty_desc}

要求：
1. 仔细阅读文本，找出其中的试题（包括题干、选项、答案）
2. 如果文本中没有明确的试题，可以根据文本内容中的知识点，自动生成相关试题
3. 每个试题必须包含：题目、正确答案、题型
4. 选择题必须有选项（最少4个选项）
5. 判断题的选项为 {{"对":"对","错":"错"}}
6. 涉及数学、物理、化学公式时，用 $...$ LaTeX 语法标记
7. 可根据题目内容生成 svg_code（技术图示）和 media_placeholders（实物图描述）
8. **⚠️ 安全约束**：svg_code 和 media_placeholders 生成的配图中**严禁**出现题目答案、解析、解题过程或任何会泄露正确选项的文字内容

请严格按照 JSON 格式输出，只返回一个 JSON 数组，不要包含其他内容：

[
  {{
    "type": "题型标识(single/multiple/true_false/short/fill/essay/subjective/code)",
    "question": "题目内容（含 $...$ LaTeX 公式）",
    "options": {{"A":"选项（含公式）", "B":"...", "C":"...", "D":"..."}},
    "answer": "正确答案",
    "explanation": "解析内容（含公式）",
    "knowledge_point": "所属知识点",
    "difficulty": "easy/medium/hard",
    "svg_code": "<svg>...</svg>",
    "media_placeholders": [{{"key":"p1","description":"图片描述","purpose":"示意图/实物图"}}]
  }}
]

文本内容：
{content}"""


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

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请先在系统配置中设置")

    # 使用增强 Prompt
    from backend.prompts.chat import QUESTION_GENERATE_WITH_MEDIA_PROMPT
    type_desc = {"single": "单选题（4个选项）", "multiple": "多选题（4-5个选项）",
                 "true_false": "判断题", "short": "简答题", "fill": "填空题",
                 "essay": "作文", "subjective": "主观题",
                 "code": "编程题（Python 代码+测试用例）"}.get(req.question_type, "单选题")
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(req.difficulty, "中等")
    prompt = QUESTION_GENERATE_WITH_MEDIA_PROMPT.format(
        subject=req.subject,
        knowledge_points=req.knowledge_points,
        type_desc=type_desc,
        count=req.count,
        difficulty_desc=difficulty_desc,
    )
    prompt = apply_skills(prompt, "quiz")

    logger.info(f"开始调用AI生成多媒体试题: subject={req.subject}, type={req.question_type}")

    try:
        result_text = await _call_dashscope_agent(prompt, api_key)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 生成失败: {str(e)}")

    questions = _parse_ai_response_with_media(result_text)
    if not questions:
        raise HTTPException(status_code=502, detail="AI 返回格式异常，未能解析出试题，请重试")

    # 获取创建者姓名
    from backend.database import execute_query as user_query
    user_row = user_query("SELECT name FROM users WHERE username=?", (username,))
    creator_name = user_row[0][0] if user_row and user_row[0][0] else username

    # 入库（含多媒体字段）
    from backend.config import BASE_DIR
    saved_questions = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for q_data in questions[:req.count]:
        q_type = q_data.get("type", req.question_type)
        options_str = json.dumps(q_data.get("options", {}), ensure_ascii=False) if q_data.get("options") else ""
        svg_code = q_data.get("svg_code") or ""
        has_svg = 1 if svg_code.strip() else 0
        media_placeholders = json.dumps(q_data.get("media_placeholders") or [], ensure_ascii=False)

        qid = execute_insert(
            """INSERT INTO question_bank
               (type, question_text, options, correct_answer, explanation,
                knowledge_points, subject, difficulty, creator_username, creator_name,
                source, status, created_at, updated_at,
                svg_content, has_svg, media_placeholders)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', 'active', ?, ?, ?, ?, ?)""",
            (
                q_type,
                q_data.get("question", ""),
                options_str,
                q_data.get("answer", ""),
                q_data.get("explanation", ""),
                q_data.get("knowledge_point", req.knowledge_points),
                req.subject,
                q_data.get("difficulty", req.difficulty),
                username,
                creator_name,
                now,
                now,
                svg_code,
                has_svg,
                media_placeholders,
            ),
        )

        # ── 代码题额外保存 code_problems 和测试用例 ──
        if q_type == 'code':
            assert qid is not None
            _save_code_problem(qid, q_data, username, now)

        # ── 自动配图（通义万相） ──
        placeholders = q_data.get("media_placeholders") or []
        media_files = []
        if get_config_value("IMAGE_GEN_ENABLED", True):
            from backend.api.image_gen_service import generate_and_save_image
            from backend.prompts.chat import IMAGE_GEN_PROMPT_TEMPLATE

            media_dir = BASE_DIR / "question_media" / str(qid)

            if placeholders:
                # 策略 A：AI 指定了占位符 → 按描述**并发**生图
                async def _gen_one(ph: dict[str, Any]) -> dict[str, Any] | None:
                    ph_prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
                        subject=req.subject,
                        purpose=ph.get("purpose", "示意图"),
                        description=ph["description"],
                    )
                    local_path = await generate_and_save_image(ph_prompt, media_dir)
                    if local_path:
                        from pathlib import Path as PPath
                        ph["status"] = "generated"
                        return {
                            "key": ph["key"],
                            "type": "image",
                            "url": f"/api/files/question_media/{qid}/{PPath(local_path).name}",
                            "alt": ph["description"],
                            "created_at": now,
                        }
                    else:
                        ph["status"] = "failed"
                        logger.warning(f"试题 {qid} 占位符 {ph['key']} 生图失败")
                        return None

                results = await asyncio.gather(*[_gen_one(ph) for ph in placeholders])
                media_files = [r for r in results if r is not None]

            elif not svg_code.strip():
                # 策略 B：既无 SVG 又无占位符 → 根据题目内容自动补一张插图
                q_text = (q_data.get("question", "") or "")[:300]
                if len(q_text) > 20:
                    fallback_prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
                        subject=req.subject,
                        purpose="示意图",
                        description=f"与「{q_text}」相关的教学插图，适合高中{req.subject}课堂展示",
                    )
                    local_path = await generate_and_save_image(fallback_prompt, media_dir)
                    if local_path:
                        from pathlib import Path as PPath
                        media_files.append({
                            "key": "auto",
                            "type": "image",
                            "url": f"/api/files/question_media/{qid}/{PPath(local_path).name}",
                            "alt": q_text[:100],
                            "created_at": now,
                        })

            # 更新 media_files 到数据库
            if media_files:
                execute_update(
                    "UPDATE question_bank SET media_files=? WHERE id=?",
                    (json.dumps(media_files, ensure_ascii=False), qid)
                )

        saved_questions.append({
            "id": qid,
            "type": q_type,
            "question_text": q_data.get("question", ""),
            "options": q_data.get("options", {}),
            "correct_answer": q_data.get("answer", ""),
            "explanation": q_data.get("explanation", ""),
            "knowledge_points": q_data.get("knowledge_point", req.knowledge_points),
            "difficulty": q_data.get("difficulty", req.difficulty),
            "has_svg": has_svg,
            "svg_content": svg_code if has_svg else None,
            "media_placeholders": placeholders,
            "media_files": media_files,
        })

    return {
        "message": f"成功生成 {len(saved_questions)} 道试题",
        "questions": saved_questions,
        "total": len(saved_questions),
    }


def _parse_ai_response_with_media(text: str) -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 试题列表（含 svg_code / media_placeholders）"""
    questions = _parse_ai_response(text)
    # svg_code 和 media_placeholders 已在 JSON 中，原样保留
    return questions


@router.post("/{question_id}/generate-svg", summary="为指定试题生成/重新生成SVG配图")
async def generate_svg_for_question(question_id: int, request: Request):
    """为已有试题单独生成或重新生成SVG配图"""
    user = get_current_user(request)
    username = user["username"]

    row = await _verify_question_owner(question_id, username, user.get("role", 2))

    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置")

    from backend.prompts.chat import SVG_GENERATE_PROMPT
    prompt = SVG_GENERATE_PROMPT.format(
        description=row["question_text"],
        subject=row["subject"]
    )
    prompt = apply_skills(prompt, "quiz")

    try:
        result = await _call_dashscope_agent(prompt, api_key)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 生成 SVG 失败: {str(e)}")

    svg_code = _extract_svg_code(result)
    if not svg_code:
        raise HTTPException(status_code=502, detail="AI 未能生成有效的 SVG 代码")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE question_bank SET svg_content=?, has_svg=1, updated_at=? WHERE id=?",
        (svg_code, now, question_id),
    )

    return {"message": "SVG 配图已生成", "svg_code": svg_code}


def _extract_svg_code(text: str) -> str:
    """从 AI 返回文本中提取标准 SVG 代码，并进行安全检查"""
    import re
    # 提取 <svg>...</svg>
    match = re.search(r'<svg[\s\S]*?</svg>', text, re.IGNORECASE)
    if match:
        svg = match.group()
        # 安全过滤
        svg = re.sub(r'<script[\s\S]*?</script>', '', svg, flags=re.IGNORECASE)
        svg = re.sub(r'\bon\w+\s*=\s*["\'][\s\S]*?["\']', '', svg)
        svg = re.sub(r'href\s*=\s*["\']\s*javascript:[\s\S]*?["\']', '', svg, flags=re.IGNORECASE)
        return svg
    return ""


@router.post("/{question_id}/generate-media/{placeholder_key}", summary="为占位符调用AI生图")
async def generate_media_for_placeholder(
    question_id: int,
    placeholder_key: str,
    request: Request,
):
    """为指定占位符调用通义万相生成图片"""
    user = get_current_user(request)
    username = user["username"]

    row = await _verify_question_owner(question_id, username, user.get("role", 2))

    # 查找占位符
    placeholders = json.loads(row["media_placeholders"] or "[]")
    target = next((p for p in placeholders if p["key"] == placeholder_key), None)
    if not target:
        raise HTTPException(status_code=404, detail="占位符不存在")

    # 构建生图 prompt
    from backend.prompts.chat import IMAGE_GEN_PROMPT_TEMPLATE
    prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
        subject=row["subject"],
        purpose=target.get("purpose", "示意图"),
        description=target["description"],
    )

    # 调用生图
    from backend.api.image_gen_service import generate_and_save_image
    from backend.config import BASE_DIR
    from pathlib import Path

    media_dir = BASE_DIR / "question_media" / str(question_id)

    # 重新生成前先清理旧的物理文件
    media_files = json.loads(row["media_files"] or "[]")
    old_entry = next((f for f in media_files if f["key"] == placeholder_key), None)
    _delete_physical_media(question_id, old_entry.get("url", "") if old_entry else None)

    local_path = await generate_and_save_image(prompt, media_dir)

    if not local_path:
        raise HTTPException(status_code=502, detail="AI 生图失败，请检查 API Key 或稍后重试")

    # 更新占位符状态和 media_files
    target["status"] = "generated"
    relative_url = f"/api/files/question_media/{question_id}/{Path(local_path).name}"

    file_entry = next((f for f in media_files if f["key"] == placeholder_key), None)
    if file_entry:
        file_entry["url"] = relative_url
        file_entry["created_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    else:
        media_files.append({
            "key": placeholder_key,
            "type": "image",
            "url": relative_url,
            "alt": target["description"],
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE question_bank SET media_placeholders=?, media_files=?, updated_at=? WHERE id=?",
        (json.dumps(placeholders, ensure_ascii=False),
         json.dumps(media_files, ensure_ascii=False),
         now, question_id)
    )

    return {"message": "图片已生成", "url": relative_url, "placeholder_key": placeholder_key}


@router.post("/{question_id}/generate-image", summary="万相生图（直接为试题生成配图）")
async def generate_image_for_question(question_id: int, request: Request):
    """直接用通义万相为试题生成配图（不依赖占位符），作为 SVG 的补充/替换方案"""
    user = get_current_user(request)
    username = user["username"]

    row = await _verify_question_owner(question_id, username, user.get("role", 2))

    # 用题干前 200 字作为生图描述
    q_text = (row["question_text"] or "")[:200]
    if len(q_text) < 10:
        raise HTTPException(status_code=400, detail="题干过短，无法生成配图")

    from backend.prompts.chat import IMAGE_GEN_PROMPT_TEMPLATE
    prompt = IMAGE_GEN_PROMPT_TEMPLATE.format(
        subject=row["subject"],
        purpose="示意图",
        description=f"与「{q_text}」相关的教学插图，适合高中{row['subject']}课堂展示",
    )

    from backend.api.image_gen_service import generate_and_save_image
    from backend.config import BASE_DIR
    from pathlib import Path

    media_dir = BASE_DIR / "question_media" / str(question_id)
    local_path = await generate_and_save_image(prompt, media_dir)

    if not local_path:
        raise HTTPException(status_code=502, detail="AI 生图失败，请检查 API Key 或稍后重试")

    relative_url = f"/api/files/question_media/{question_id}/{Path(local_path).name}"
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 追加/替换到 media_files（固定 key="wanxiang"，重复点击替换旧图）
    media_files = json.loads(row["media_files"] or "[]")
    key = "wanxiang"
    existing = next((f for f in media_files if f["key"] == key), None)
    if existing:
        # 删除旧图片文件
        old_url = existing.get("url", "")
        if old_url:
            old_filename = old_url.rstrip("/").split("/")[-1]
            old_path = media_dir / old_filename
            if old_path.exists():
                old_path.unlink()
        existing["url"] = relative_url
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

    execute_update(
        "UPDATE question_bank SET media_files=?, updated_at=? WHERE id=?",
        (json.dumps(media_files, ensure_ascii=False), now, question_id)
    )

    return {"message": "配图已生成", "url": relative_url, "key": key}


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

    # 校验文件类型
    import os
    _, ext = os.path.splitext((file.filename or "").lower())
    allowed = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"不支持的图片格式: {ext}")

    content = await file.read()
    max_size_mb = get_config_value("MAX_IMAGE_SIZE_MB", 5)
    max_size = max_size_mb * 1024 * 1024
    if len(content) > max_size:
        raise HTTPException(status_code=400, detail=f"图片大小超过 {max_size_mb}MB 限制")

    # 保存文件
    from backend.config import BASE_DIR
    from pathlib import Path
    import uuid

    media_dir = BASE_DIR / "question_media" / str(question_id)
    media_dir.mkdir(parents=True, exist_ok=True)
    file_id = uuid.uuid4().hex
    save_path = media_dir / f"{file_id}{ext}"
    save_path.write_bytes(content)

    # 查找占位符
    placeholders = json.loads(row["media_placeholders"] or "[]")
    target = next((p for p in placeholders if p["key"] == placeholder_key), None)
    if target:
        target["status"] = "uploaded"

    relative_url = f"/api/files/question_media/{question_id}/{file_id}{ext}"
    media_files = json.loads(row["media_files"] or "[]")
    file_entry = next((f for f in media_files if f["key"] == placeholder_key), None)
    if file_entry:
        file_entry["url"] = relative_url
        file_entry["created_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    else:
        media_files.append({
            "key": placeholder_key,
            "type": "image",
            "url": relative_url,
            "alt": target["description"] if target else file.filename,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE question_bank SET media_placeholders=?, media_files=?, updated_at=? WHERE id=?",
        (json.dumps(placeholders, ensure_ascii=False),
         json.dumps(media_files, ensure_ascii=False),
         now, question_id)
    )

    return {"message": "图片上传成功", "url": relative_url, "placeholder_key": placeholder_key}


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
    """删除指定占位符的配图，重置为未配图状态"""
    user = get_current_user(request)
    username = user["username"]

    row = await _verify_question_owner(question_id, username, user.get("role", 2))

    placeholders = json.loads(row["media_placeholders"] or "[]")
    target = next((p for p in placeholders if p["key"] == placeholder_key), None)
    if target:
        target["status"] = "pending"

    media_files = json.loads(row["media_files"] or "[]")
    # 删除物理文件
    deleted_file = next((f for f in media_files if f["key"] == placeholder_key), None)
    _delete_physical_media(question_id, deleted_file.get("url", "") if deleted_file else None)
    media_files = [f for f in media_files if f["key"] != placeholder_key]

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE question_bank SET media_placeholders=?, media_files=?, updated_at=? WHERE id=?",
        (json.dumps(placeholders, ensure_ascii=False),
         json.dumps(media_files, ensure_ascii=False),
         now, question_id)
    )

    return {"message": "配图已删除", "placeholder_key": placeholder_key}
