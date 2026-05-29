"""
试题库 API 路由
AI 生成试题 + 题库 CRUD
"""
import json
import os
import time
import re
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query
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

router = APIRouter()


# ── 请求/响应模型 ──

class GenerateRequest(BaseModel):
    """AI 生成试题请求"""
    subject: str = "信息技术"          # 科目
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


# ── 题型配置 ──

QUESTION_TYPE_MAP = {
    "single": "单选题（4个选项，唯一正确答案）",
    "multiple": "多选题（4-5个选项，至少2个正确答案）",
    "true_false": "判断题（回答「对」或「错」）",
    "short": "简答题（写出参考答案）",
}

TYPE_DESC = {
    "single": "单选题",
    "multiple": "多选题",
    "true_false": "判断题",
    "short": "简答题",
}


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
    prompt = _build_generate_prompt(req.subject, req.knowledge_points, type_desc, req.count, req.difficulty)
    logger.info(f"开始调用AI生成试题: subject={req.subject}, type={req.question_type}, count={req.count}")

    # 调用 AI
    try:
        result_text = _call_dashscope_agent(prompt, api_key)
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
        qid = execute_insert(
            """INSERT INTO question_bank
               (type, question_text, options, correct_answer, explanation,
                knowledge_points, subject, difficulty, creator_username, creator_name,
                source, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', 'active', ?, ?)""",
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
            ),
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
        })

    logger.info(f"用户 {username} 生成并入库 {len(saved_questions)} 道{req.question_type}题")
    return {
        "message": f"成功生成 {len(saved_questions)} 道{TYPE_DESC.get(req.question_type, '')}",
        "questions": saved_questions,
        "total": len(saved_questions),
    }


def _build_generate_prompt(subject: str, knowledge_points: str, type_desc: str, count: int, difficulty: str) -> str:
    """构建 AI 生成试题的 Prompt（直接传给百炼智能体）"""
    difficulty_desc = {"easy": "简单", "medium": "中等", "hard": "困难"}.get(difficulty, "中等")
    return f"""请根据以下要求生成试题。

科目：{subject}
知识点范围：{knowledge_points}
题型：{type_desc}
数量：{count}道
难度：{difficulty_desc}

请严格按照 JSON 格式输出，只返回一个 JSON 数组，不要包含其他内容：

[
  {{
    "type": "题型标识(single/multiple/true_false/short)",
    "question": "题目内容",
    "options": {{"A":"选项A", "B":"选项B", "C":"选项C", "D":"选项D"}},
    "answer": "正确答案",
    "explanation": "解析内容",
    "knowledge_point": "所属知识点",
    "difficulty": "easy/medium/hard"
  }}
]

注意：
- 如果是判断题，options 设为 {{"对":"对", "错":"错"}}，answer 为"对"或"错"
- 如果是简答题，options 设为 null，answer 为参考答案
- 题目和选项要与高中{subject}课程内容紧密相关"""


def _call_dashscope_agent(prompt: str, api_key: str) -> str:
    """调用 DashScope 智能体（非流式），返回完整响应文本"""
    from dashscope import Application as DashScopeApp
    from backend.token_usage import record_token_usage

    os.environ["DASHSCOPE_API_KEY"] = api_key

    call_params = {
        "app_id": get_config_value("APPID", "6fcb54e8f16f4e3b94e4b9fd4eab1125"),
        "prompt": prompt,
        "stream": False,
        "headers": {"X-DashScope-OssResourceResolve": "enable"},
    }

    response = DashScopeApp.call(**call_params)

    # 记录 token 用量
    try:
        usage = getattr(response, "usage", None)
        if usage:
            record_token_usage("system", 0, "deepseek-v4-flash",
                getattr(usage, "input_tokens", 0) or 0,
                getattr(usage, "output_tokens", 0) or 0,
                "quiz", "")
    except Exception:
        pass

    output = getattr(response, "output", None)
    if output:
        text = getattr(output, "text", None)
        if text:
            return text

    # 尝试从 response 直接获取文本
    if hasattr(response, "text"):
        return response.text

    raise Exception("AI 响应为空，请重试")


def _parse_ai_response(text: str) -> list:
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

    # 解析 options 字段
    for row in rows:
        if row.get("options"):
            try:
                row["options"] = json.loads(row["options"])
            except (json.JSONDecodeError, TypeError):
                pass
        else:
            row["options"] = None

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

    if row.get("options"):
        try:
            row["options"] = json.loads(row["options"])
        except (json.JSONDecodeError, TypeError):
            pass
    else:
        row["options"] = None

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

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    execute_update(
        "UPDATE question_bank SET status = 'deleted', updated_at = ? WHERE id = ?",
        (now, question_id),
    )

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

    for row in rows:
        question_text = row["question_text"]
        id_list = sorted([int(x) for x in row["ids"].split(",")])
        keep_id = id_list[0]  # 保留 ID 最小的（最早创建的）
        delete_ids = id_list[1:]

        # 检查权限：只删除当前用户有权限的
        allowed_delete = []
        for did in delete_ids:
            q = execute_query_one(
                "SELECT creator_username FROM question_bank WHERE id = ?", (did,)
            )
            if q and (role == 0 or q["creator_username"] == username):
                allowed_delete.append(did)

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for did in allowed_delete:
            execute_update(
                "UPDATE question_bank SET status = 'deleted', updated_at = ? WHERE id = ?",
                (now, did),
            )

        if allowed_delete:
            results.append({
                "question_text": question_text[:60] + ("..." if len(question_text) > 60 else ""),
                "keep_id": keep_id,
                "deleted_ids": allowed_delete,
                "count": len(allowed_delete),
            })
            total_deleted += len(allowed_delete)

    logger.info(f"去重完成: 删除 {total_deleted} 条重复试题, by={username}")
    return {
        "total_deleted": total_deleted,
        "groups": results,
        "message": f"共删除 {total_deleted} 条重复试题",
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
        ]
    }
