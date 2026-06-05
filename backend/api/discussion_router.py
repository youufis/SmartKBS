# -*- coding: utf-8 -*-
"""
分组讨论 API 路由
教师创建讨论、学生分组聊天、AI 助教参与、讨论报告
"""
import json
import random
import asyncio
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.database import execute_query, execute_insert_update
from backend.logger import logger
from backend.ws_manager import manager as ws_manager

router = APIRouter()


# ── 辅助函数 ──

def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _get_user_grade_class(username: str) -> tuple:
    rows = execute_query(
        "SELECT grade, class FROM users WHERE username = ?",
        (username,),
    )
    if rows and rows[0]:
        return rows[0][0] or "", rows[0][1] or ""
    return "", ""


# ── 请求/响应模型 ──

class DiscussionCreate(BaseModel):
    title: str
    description: str = ""
    subject: str = ""
    group_mode: str = "auto"       # auto / manual / random
    group_count: int = 0
    members_per_group: int = 4
    ai_role: str = "guide"         # observer / guide / proactive / judge
    duration_minutes: int = 30
    grade: str = ""
    classes: str = ""
    require_summary: bool = False


class DiscussionUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    subject: str | None = None
    duration_minutes: int | None = None
    ai_role: str | None = None
    require_summary: bool | None = None


class MessageSend(BaseModel):
    content: str


class BroadcastMessage(BaseModel):
    content: str


class AiGenerateDiscussion(BaseModel):
    topic: str
    subject: str = ""  # 由前端传递
    ai_role: str = "guide"
    duration_minutes: int = 30


# ── 创建讨论 ──

@router.post("/discussions", summary="创建讨论活动")
async def create_discussion(req: DiscussionCreate, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可创建讨论")

    now = _now()
    disc_id = execute_insert_update(
        """INSERT INTO discussions
           (creator_username, title, description, subject, group_mode,
            group_count, members_per_group, ai_role, duration_minutes,
            status, grade, classes, require_summary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)""",
        (user["username"], req.title, req.description, req.subject,
         req.group_mode, req.group_count, req.members_per_group,
         req.ai_role, req.duration_minutes,
         req.grade, req.classes, 1 if req.require_summary else 0, now, now),
    )
    logger.info(f"教师 {user['username']} 创建讨论: {req.title}")
    return {"status": "ok", "discussion_id": disc_id}


# ── AI 生成讨论方案 ──

@router.post("/discussions/ai-generate", summary="AI 自动生成讨论方案")
async def ai_generate_discussion(req: AiGenerateDiscussion, request: Request):
    """AI 根据主题自动生成讨论方案"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    ai_role_desc = {
        "observer": "旁观者，不主动发言",
        "guide": "适时引导讨论方向的引导者",
        "proactive": "主动参与讨论并提供观点的参与者",
        "judge": "辩论裁判，分析各方论点",
    }.get(req.ai_role, "引导者")

    from backend.prompts.discussion import DISCUSSION_PLAN_PROMPT
    prompt = DISCUSSION_PLAN_PROMPT.format(
        subject=req.subject,
        topic=req.topic,
        ai_role_desc=ai_role_desc,
        duration_minutes=req.duration_minutes,
    )

    import os
    import json
    import re

    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        try:
            from backend.api.config_router import load_config
            cfg = load_config()
            api_key = cfg.get("dashscope_api_key", "")
        except Exception:
            pass

    if not api_key:
        return {"status": "error", "content": "AI 功能不可用：请配置 DashScope API Key"}

    from backend.api.ai_service import call_ai_async
    from backend.ai_task_manager import task_manager

    async def _do_generate() -> dict:
        try:
            result = await call_ai_async(prompt, api_key)
            if result:
                json_match = __import__('re').search(r'\{[\s\S]*\}', result)
                if json_match:
                    try:
                        data = __import__('json').loads(json_match.group())
                        return {"status": "ok", "data": data, "raw": result}
                    except json.JSONDecodeError:
                        pass
                return {"status": "error", "content": result, "raw": result}
            return {"status": "error", "content": "AI 未返回有效结果"}
        except Exception as e:
            logger.warning(f"AI 生成讨论方案失败: {e}")
            return {"status": "error", "content": f"AI 调用出错: {str(e)}"}

    task_id = await task_manager.create_task(description="AI 生成讨论方案", coro_factory=_do_generate)
    return {"task_id": task_id, "message": "AI 生成已提交，请稍后查询结果"}


# ── 获取讨论列表 ──

@router.get("/discussions", summary="获取讨论列表")
async def list_discussions(
    request: Request,
    status: str | None = Query(None, description="筛选状态: pending/active/ended"),
):
    user = get_current_user(request)
    role = user.get("role", 2)
    username = user["username"]

    if role == 0:
        # 管理员：查看全部讨论
        if status:
            rows = execute_query(
                "SELECT * FROM discussions WHERE status=? ORDER BY created_at DESC",
                (status,),
            )
        else:
            rows = execute_query(
                "SELECT * FROM discussions ORDER BY created_at DESC"
            )
    elif role == 1:
        # 教师：查看自己创建的 + 管理员创建的讨论
        if status:
            rows = execute_query(
                """SELECT * FROM discussions
                   WHERE status=? AND (creator_username=? OR creator_username IN
                     (SELECT username FROM users WHERE role=0))
                   ORDER BY created_at DESC""",
                (status, username),
            )
        else:
            rows = execute_query(
                """SELECT * FROM discussions
                   WHERE creator_username=? OR creator_username IN
                     (SELECT username FROM users WHERE role=0)
                   ORDER BY created_at DESC""",
                (username,),
            )
    else:
        # 学生：只看到管理员和自己班级教师发布的讨论
        grade, cls = _get_user_grade_class(username)
        base_sql = """SELECT DISTINCT d.* FROM discussions d
            WHERE (d.creator_username IN (SELECT username FROM users WHERE role=0)
               OR d.creator_username IN (
                   SELECT username FROM users
                   WHERE role=1
                   AND (grade='' OR grade IS NULL OR INSTR(grade, ?)>0 OR INSTR(?, grade)>0)
                   AND (class='' OR class IS NULL OR INSTR(class, ?)>0 OR INSTR(?, class)>0)
               ))
            ORDER BY d.created_at DESC"""
        params = (grade, grade, cls, cls)

        if status:
            base_sql = """SELECT DISTINCT d.* FROM discussions d
                WHERE d.status=? AND (d.creator_username IN (SELECT username FROM users WHERE role=0)
                   OR d.creator_username IN (
                       SELECT username FROM users
                       WHERE role=1
                       AND (grade='' OR grade IS NULL OR INSTR(grade, ?)>0 OR INSTR(?, grade)>0)
                       AND (class='' OR class IS NULL OR INSTR(class, ?)>0 OR INSTR(?, class)>0)
                   ))
                ORDER BY d.created_at DESC"""
            params = (status, grade, grade, cls, cls)

        rows = execute_query(base_sql, params)

    columns = ["id", "creator_username", "title", "description", "subject",
               "group_mode", "group_count", "members_per_group", "ai_role",
               "duration_minutes", "status", "grade", "classes",
               "require_summary", "created_at", "updated_at"]
    results = []
    for row in rows:
        item = dict(zip(columns, row))
        # 统计各组消息数
        groups = execute_query(
            "SELECT id, group_index, name FROM discussion_groups WHERE discussion_id=?",
            (item["id"],),
        )
        group_list = []
        total_messages = 0
        for g in groups:
            msg_count = execute_query(
                "SELECT COUNT(*) FROM discussion_messages WHERE group_id=?",
                (g[0],),
            )[0][0]
            member_count = execute_query(
                "SELECT COUNT(*) FROM discussion_members WHERE group_id=?",
                (g[0],),
            )[0][0]
            total_messages += msg_count
            group_list.append({
                "id": g[0], "group_index": g[1], "name": g[2],
                "member_count": member_count, "message_count": msg_count,
            })
        item["groups"] = group_list
        item["total_messages"] = total_messages
        item["total_members"] = sum(g["member_count"] for g in group_list)
        item["require_summary"] = bool(item["require_summary"])
        # 学生标记是否已加入
        if role == 2:
            joined = execute_query(
                """SELECT 1 FROM discussion_members dm
                   JOIN discussion_groups dg ON dm.group_id = dg.id
                   WHERE dg.discussion_id=? AND dm.username=?""",
                (item["id"], username),
            )
            item["has_joined"] = len(joined) > 0
            if item["has_joined"]:
                my_g = execute_query(
                    """SELECT dg.id, dg.group_index, dg.name FROM discussion_groups dg
                       JOIN discussion_members dm ON dm.group_id = dg.id
                       WHERE dg.discussion_id=? AND dm.username=?""",
                    (item["id"], username),
                )
                if my_g:
                    item["my_group"] = {"id": my_g[0][0], "group_index": my_g[0][1], "name": my_g[0][2]}
        results.append(item)

    return results


# ── 获取讨论详情 ──

@router.get("/discussions/{disc_id}", summary="获取讨论详情")
async def get_discussion(disc_id: int, request: Request):
    user = get_current_user(request)
    rows = execute_query("SELECT * FROM discussions WHERE id=?", (disc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="讨论不存在")

    columns = ["id", "creator_username", "title", "description", "subject",
               "group_mode", "group_count", "members_per_group", "ai_role",
               "duration_minutes", "status", "grade", "classes",
               "require_summary", "created_at", "updated_at"]
    disc = dict(zip(columns, rows[0]))

    # 获取所有小组
    groups = execute_query(
        "SELECT id, group_index, name FROM discussion_groups WHERE discussion_id=? ORDER BY group_index",
        (disc_id,),
    )
    group_list = []
    for g in groups:
        members = execute_query(
            "SELECT username, role, joined_at FROM discussion_members WHERE group_id=?",
            (g[0],),
        )
        msg_count = execute_query(
            "SELECT COUNT(*) FROM discussion_messages WHERE group_id=?",
            (g[0],),
        )[0][0]
        group_list.append({
            "id": g[0], "group_index": g[1], "name": g[2],
            "members": [{"username": m[0], "role": m[1], "joined_at": m[2]} for m in members],
            "message_count": msg_count,
        })

    disc["groups"] = group_list
    disc["require_summary"] = bool(disc["require_summary"])
    return disc


# ── 更新讨论 ──

@router.put("/discussions/{disc_id}", summary="更新讨论")
async def update_discussion(disc_id: int, req: DiscussionUpdate, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可编辑讨论")

    rows = execute_query("SELECT creator_username FROM discussions WHERE id=?", (disc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="讨论不存在")
    if rows[0][0] != user["username"] and role != 0:
        raise HTTPException(status_code=403, detail="只能编辑自己的讨论")

    updates = []
    params = []
    for field in ["title", "description", "subject", "duration_minutes", "ai_role"]:
        val = getattr(req, field, None)
        if val is not None:
            updates.append(f"{field}=?")
            params.append(val)
    if req.require_summary is not None:
        updates.append("require_summary=?")
        params.append(1 if req.require_summary else 0)

    if updates:
        updates.append("updated_at=?")
        params.append(_now())
        params.append(disc_id)
        execute_insert_update(
            f"UPDATE discussions SET {', '.join(updates)} WHERE id=?",
            tuple(params),
        )

    return {"status": "ok"}


# ── 开始讨论（自动分组）──

@router.post("/discussions/{disc_id}/start", summary="开始讨论")
async def start_discussion(disc_id: int, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可开始讨论")

    rows = execute_query("SELECT * FROM discussions WHERE id=?", (disc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="讨论不存在")

    # 教师只能管理自己的讨论
    if role == 1 and rows[0][1] != user["username"]:
        raise HTTPException(status_code=403, detail="只能管理自己的讨论")

    columns = ["id", "creator_username", "title", "description", "subject",
               "group_mode", "group_count", "members_per_group", "ai_role",
               "duration_minutes", "status", "grade", "classes",
               "require_summary", "created_at", "updated_at"]
    disc = dict(zip(columns, rows[0]))

    if disc["status"] != "pending":
        raise HTTPException(status_code=400, detail="讨论已开始或已结束")

    # 计算分组数量
    group_count = disc["group_count"]
    members_per_group = disc["members_per_group"]

    if group_count <= 0 and members_per_group > 0:
        group_count = members_per_group  # 先按人数创建组，后续加入的学生会分配到最少人的组
    if group_count <= 0:
        group_count = 4  # 默认 4 组

    # 删除旧的临时分组（如果有）
    old_groups = execute_query("SELECT id FROM discussion_groups WHERE discussion_id=?", (disc_id,))
    for og in old_groups:
        execute_insert_update("DELETE FROM discussion_members WHERE group_id=?", (og[0],))
    execute_insert_update("DELETE FROM discussion_groups WHERE discussion_id=?", (disc_id,))

    # 创建空分组，学生后续加入时会自动分配到人数最少的组
    now = _now()
    for idx in range(group_count):
        gid = execute_insert_update(
            "INSERT INTO discussion_groups (discussion_id, group_index, name) VALUES (?, ?, ?)",
            (disc_id, idx + 1, f"第{idx + 1}组"),
        )

    # 更新状态
    execute_insert_update(
        "UPDATE discussions SET status='active', updated_at=? WHERE id=?",
        (_now(), disc_id),
    )

    logger.info(f"教师 {user['username']} 开始了讨论 {disc['title']}, 共 {group_count} 个小组")
    return {"status": "ok", "message": f"讨论已开始，共 {group_count} 个小组"}


# ── 结束讨论 ──

@router.post("/discussions/{disc_id}/end", summary="结束讨论")
async def end_discussion(disc_id: int, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可结束讨论")

    rows = execute_query("SELECT creator_username FROM discussions WHERE id=?", (disc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="讨论不存在")
    if role == 1 and rows[0][0] != user["username"]:
        raise HTTPException(status_code=403, detail="只能管理自己的讨论")

    execute_insert_update(
        "UPDATE discussions SET status='ended', updated_at=? WHERE id=?",
        (_now(), disc_id),
    )
    logger.info(f"教师 {user['username']} 结束了讨论 #{disc_id}")

    # 自动生成报告
    try:
        # 在后台异步生成报告
        asyncio.create_task(_auto_generate_report(disc_id))
    except Exception as e:
        logger.warning(f"自动生成报告失败: {e}")

    return {"status": "ok", "message": "讨论已结束，报告生成中"}


async def _auto_generate_report(disc_id: int):
    """异步生成讨论报告（结束讨论时自动调用）"""
    from backend.api.config_router import get_config_value, load_config
    import os

    rows = execute_query("SELECT * FROM discussions WHERE id=?", (disc_id,))
    if not rows:
        return

    columns = ["id", "creator_username", "title", "description", "subject",
               "group_mode", "group_count", "members_per_group", "ai_role",
               "duration_minutes", "status", "grade", "classes",
               "require_summary", "created_at", "updated_at"]
    disc = dict(zip(columns, rows[0]))

    groups = execute_query(
        "SELECT id, group_index, name FROM discussion_groups WHERE discussion_id=? ORDER BY group_index",
        (disc_id,),
    )

    now = _now()
    overall_parts = [f"# 讨论报告：{disc['title']}\n"]

    for g in groups:
        members = execute_query(
            "SELECT username FROM discussion_members WHERE group_id=?",
            (g[0],),
        )
        msgs = execute_query(
            "SELECT username, content, msg_type FROM discussion_messages WHERE group_id=? ORDER BY id ASC",
            (g[0],),
        )
        member_names = [m[0] for m in members]
        overall_parts.append(f"\n## {g[2] or f'第{g[1]}组'}")
        overall_parts.append(f"- 成员：{', '.join(member_names) if member_names else '（空）'}")
        overall_parts.append(f"- 消息数：{len(msgs)}")

        ai_texts = [m[1] for m in msgs if m[2] == 'ai_suggest']
        if ai_texts:
            overall_parts.append(f"- AI 介入次数：{len(ai_texts)}")

        # 生成小组 AI 分析摘要
        if msgs:
            api_key = os.environ.get("DASHSCOPE_API_KEY", "")
            if not api_key:
                cfg = load_config()
                api_key = cfg.get("dashscope_api_key", "")
            if api_key:
                messages_text = "\n".join(
                    [f"{m[0] or 'AI助教'}: {m[1][:200]}" for m in msgs[-20:]]
                )
                prompt = f"""请对以下课堂讨论内容进行简要分析（50字以内），总结该小组的关键观点和讨论质量：

讨论主题：{disc['title']}
讨论内容：
{messages_text}

简要分析："""

                try:
                    from backend.api.ai_service import call_ai_async
                    summary = await call_ai_async(prompt, api_key)
                    if summary:
                        overall_parts.append(f"\n**AI 分析**：{summary}")

                        # 保存小组报告
                        report_content = f"# 小组报告：{g[2] or f'第{g[1]}组'}\n\n"
                        report_content += f"## 基本信息\n- 成员：{', '.join(member_names) if member_names else '（空）'}\n- 消息数：{len(msgs)}\n\n"
                        report_content += f"## AI 分析\n{summary}\n\n"
                        report_content += f"## 讨论内容\n```\n{messages_text}\n```"
                        execute_insert_update(
                            "INSERT INTO discussion_reports (discussion_id, group_id, report_content, generated_at) VALUES (?, ?, ?, ?)",
                            (disc_id, g[0], report_content, now),
                        )
                except Exception:
                    pass

    overall_report = "\n".join(overall_parts)
    execute_insert_update(
        "INSERT INTO discussion_reports (discussion_id, group_id, report_content, generated_at) VALUES (?, NULL, ?, ?)",
        (disc_id, overall_report, now),
    )
    logger.info(f"讨论 #{disc_id} 报告自动生成完成")


# ── 重新开始讨论 ──

@router.post("/discussions/{disc_id}/restart", summary="重新开始讨论")
async def restart_discussion(disc_id: int, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可操作")

    rows = execute_query("SELECT status, creator_username FROM discussions WHERE id=?", (disc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="讨论不存在")
    if role == 1 and rows[0][1] != user["username"]:
        raise HTTPException(status_code=403, detail="只能管理自己的讨论")
    if not rows:
        raise HTTPException(status_code=404, detail="讨论不存在")
    if rows[0][0] != "ended":
        raise HTTPException(status_code=400, detail="仅已结束的讨论可重新开始")

    execute_insert_update(
        "UPDATE discussions SET status='active', updated_at=? WHERE id=?",
        (_now(), disc_id),
    )
    logger.info(f"教师 {user['username']} 重新开始了讨论 #{disc_id}")
    return {"status": "ok", "message": "讨论已重新开始"}


# ── 删除讨论 ──

@router.delete("/discussions/{disc_id}", summary="删除讨论")
async def delete_discussion(disc_id: int, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可删除讨论")

    rows = execute_query("SELECT creator_username FROM discussions WHERE id=?", (disc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="讨论不存在")
    if rows[0][0] != user["username"] and role != 0:
        raise HTTPException(status_code=403, detail="只能删除自己的讨论")

    # 删除关联数据
    groups = execute_query("SELECT id FROM discussion_groups WHERE discussion_id=?", (disc_id,))
    for g in groups:
        execute_insert_update("DELETE FROM discussion_messages WHERE group_id=?", (g[0],))
        execute_insert_update("DELETE FROM discussion_members WHERE group_id=?", (g[0],))
    execute_insert_update("DELETE FROM discussion_groups WHERE discussion_id=?", (disc_id,))
    execute_insert_update("DELETE FROM discussion_reports WHERE discussion_id=?", (disc_id,))
    execute_insert_update("DELETE FROM discussions WHERE id=?", (disc_id,))

    logger.info(f"教师 {user['username']} 删除了讨论 #{disc_id}")
    return {"status": "ok", "message": "讨论已删除"}


# ── 学生加入讨论 ──

@router.post("/discussions/{disc_id}/join", summary="学生加入讨论")
async def join_discussion(disc_id: int, request: Request):
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query("SELECT status, group_mode FROM discussions WHERE id=?", (disc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="讨论不存在")
    status = rows[0][0]

    # 检查是否已在某个小组中
    existing = execute_query(
        """SELECT 1 FROM discussion_members dm
           JOIN discussion_groups dg ON dm.group_id = dg.id
           WHERE dg.discussion_id = ? AND dm.username = ?""",
        (disc_id, username),
    )
    if existing:
        # 已在组中，返回其小组 ID
        group_row = execute_query(
            """SELECT dg.id, dg.group_index FROM discussion_groups dg
               JOIN discussion_members dm ON dm.group_id = dg.id
               WHERE dg.discussion_id = ? AND dm.username = ?""",
            (disc_id, username),
        )
        return {
            "status": "already_joined",
            "group_id": group_row[0][0],
            "group_index": group_row[0][1],
        }

    if status != "active":
        raise HTTPException(status_code=400, detail="讨论未开始或已结束，暂无法加入")

    # 如果还没有任何分组，先创建一个临时分组（待教师开始后重新分组）
    groups = execute_query(
        "SELECT id, group_index FROM discussion_groups WHERE discussion_id=? ORDER BY group_index",
        (disc_id,),
    )
    if not groups:
        gid = execute_insert_update(
            "INSERT INTO discussion_groups (discussion_id, group_index, name) VALUES (?, 1, '待分组')",
            (disc_id,),
        )
        group_id = gid
    else:
        # 找人数最少的小组加入
        min_count = float("inf")
        group_id = groups[0][0]
        for g in groups:
            cnt = execute_query(
                "SELECT COUNT(*) FROM discussion_members WHERE group_id=?",
                (g[0],),
            )[0][0]
            if cnt < min_count:
                min_count = cnt
                group_id = g[0]

    now = _now()
    execute_insert_update(
        "INSERT OR IGNORE INTO discussion_members (group_id, username, role, joined_at) VALUES (?, ?, 'member', ?)",
        (group_id, username, now),
    )

    return {"status": "joined", "group_id": group_id}


# ── 教师广播 ──

@router.post("/discussions/{disc_id}/broadcast", summary="教师广播消息")
async def broadcast_message(disc_id: int, req: BroadcastMessage, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可广播")

    groups = execute_query("SELECT id FROM discussion_groups WHERE discussion_id=?", (disc_id,))
    now = _now()
    for g in groups:
        execute_insert_update(
            "INSERT INTO discussion_messages (group_id, username, content, msg_type, created_at) VALUES (?, ?, ?, 'broadcast', ?)",
            (g[0], user["username"], req.content, now),
        )
        # WebSocket 广播
        msg_data = {
            "type": "new_message",
            "username": user["username"] or "教师",
            "content": req.content,
            "msg_type": "broadcast",
            "created_at": now,
        }
        asyncio.create_task(ws_manager.broadcast(g[0], msg_data))

    return {"status": "ok", "message": "广播已发送"}


# ── 发送消息 ──

@router.post("/groups/{group_id}/messages", summary="发送消息")
async def send_message(group_id: int, req: MessageSend, request: Request):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    # 验证是该组成员（管理员/教师例外，可发到任意组）
    if role == 2:
        is_member = execute_query(
            "SELECT 1 FROM discussion_members WHERE group_id=? AND username=?",
            (group_id, username),
        )
        if not is_member:
            raise HTTPException(status_code=403, detail="你不在该小组中")

    now = _now()
    msg_id = execute_insert_update(
        "INSERT INTO discussion_messages (group_id, username, content, msg_type, created_at) VALUES (?, ?, ?, 'text', ?)",
        (group_id, username, req.content, now),
    )
    # 广播新消息到 WebSocket（带上真实 ID，供前端去重）
    msg_data = {
        "type": "new_message",
        "id": msg_id,
        "username": username,
        "content": req.content,
        "msg_type": "text",
        "created_at": now,
    }
    asyncio.create_task(ws_manager.broadcast(group_id, msg_data))
    return {"status": "ok", "id": msg_id}


# ── 获取消息（轮询）──

@router.get("/groups/{group_id}/messages", summary="获取消息")
async def get_messages(
    group_id: int,
    request: Request,
    after_id: int = Query(0, description="只返回大于此 ID 的新消息"),
):
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    # 校验权限：管理员/教师可看任意组，学生只能看自己所在组
    if role == 2:
        is_member = execute_query(
            "SELECT 1 FROM discussion_members WHERE group_id=? AND username=?",
            (group_id, username),
        )
        if not is_member:
            raise HTTPException(status_code=403, detail="你不在该小组中")

    rows = execute_query(
        """SELECT id, username, content, msg_type, created_at
           FROM discussion_messages
           WHERE group_id=? AND id>?
           ORDER BY id ASC""",
        (group_id, after_id),
    )
    return [
        {
            "id": r[0],
            "username": r[1] or "AI助教",
            "content": r[2],
            "msg_type": r[3],
            "created_at": r[4],
        }
        for r in rows
    ]


# ── 获取我的讨论（学生视角）──

@router.get("/my-discussions", summary="获取我的讨论")
async def get_my_discussions(request: Request):
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        """SELECT DISTINCT d.* FROM discussions d
           JOIN discussion_groups dg ON dg.discussion_id = d.id
           JOIN discussion_members dm ON dm.group_id = dg.id
           WHERE dm.username = ?
           ORDER BY d.created_at DESC""",
        (username,),
    )
    columns = ["id", "creator_username", "title", "description", "subject",
               "group_mode", "group_count", "members_per_group", "ai_role",
               "duration_minutes", "status", "grade", "classes",
               "require_summary", "created_at", "updated_at"]
    results = []
    for row in rows:
        item = dict(zip(columns, row))
        item["require_summary"] = bool(item["require_summary"])
        # 找出该学生所在的小组
        my_group = execute_query(
            """SELECT dg.id, dg.group_index, dg.name FROM discussion_groups dg
               JOIN discussion_members dm ON dm.group_id = dg.id
               WHERE dg.discussion_id=? AND dm.username=?""",
            (item["id"], username),
        )
        if my_group:
            item["my_group"] = {
                "id": my_group[0][0],
                "group_index": my_group[0][1],
                "name": my_group[0][2],
            }
        else:
            item["my_group"] = None
        results.append(item)

    return results


# ── AI 助教建议（手动触发）──

@router.post("/groups/{group_id}/ai-suggest", summary="AI 助教建议")
async def ai_suggest(group_id: int, request: Request):
    """手动触发 AI 助教生成讨论引导（仅教师/管理员可用）"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可触发 AI 助教")

    # 获取讨论信息
    disc_row = execute_query(
        """SELECT d.title, d.description, d.ai_role FROM discussions d
           JOIN discussion_groups dg ON dg.discussion_id = d.id
           WHERE dg.id=?""",
        (group_id,),
    )
    if not disc_row:
        raise HTTPException(status_code=404, detail="小组不存在")

    title = disc_row[0][0]
    description = disc_row[0][1]
    ai_role = disc_row[0][2]

    # 获取最近消息
    msgs = execute_query(
        """SELECT username, content FROM discussion_messages
           WHERE group_id=? ORDER BY id DESC LIMIT 10""",
        (group_id,),
    )
    messages_text = "\n".join(
        [f"{m[0] or 'AI助教'}: {m[1]}" for m in reversed(msgs)]
    )

    role_desc = {
        "observer": "观察讨论，不做干预",
        "guide": "适时引导讨论方向，提出启发式问题",
        "proactive": "主动参与讨论，提供观点和论据",
        "judge": "作为辩论裁判，分析各方论点",
    }.get(ai_role, "适时引导讨论")

    prompt = f"""你是一位高中课堂讨论的AI助教，角色是：{role_desc}

讨论主题：{title}
讨论说明：{description}

当前讨论内容：
{messages_text or "（讨论尚未开始）"}

请根据讨论情况给出简短的引导或总结（50-100字）："""

    # 调用 AI
    import os
    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        try:
            from backend.api.config_router import load_config
            cfg = load_config()
            api_key = cfg.get("dashscope_api_key", "")
        except Exception:
            pass

    if not api_key:
        return {"status": "error", "content": "AI 功能不可用：请配置 API Key"}

    from backend.api.ai_service import call_ai_async

    try:
        content = await call_ai_async(prompt, api_key)
        if content:
            # 将 AI 回复作为消息存入
            now_str = _now()
            msg_id = execute_insert_update(
                "INSERT INTO discussion_messages (group_id, username, content, msg_type, created_at) VALUES (?, NULL, ?, 'ai_suggest', ?)",
                (group_id, content, now_str),
            )
            # WebSocket 广播，实时推送给所有小组成员（带上真实 ID）
            asyncio.create_task(ws_manager.broadcast(group_id, {
                "type": "new_message",
                "id": msg_id,
                "username": None,
                "content": content,
                "msg_type": "ai_suggest",
                "created_at": now_str,
            }))
            return {"status": "ok", "content": content}
        return {"status": "error", "content": "AI 未返回有效结果"}
    except Exception as e:
        logger.warning(f"AI 助教调用失败: {e}")
        return {"status": "error", "content": f"AI 调用出错: {str(e)}"}


# ── AI 自动生成报告 ──

@router.post("/discussions/{disc_id}/generate-report", summary="AI 生成讨论报告")
async def generate_report(disc_id: int, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可生成报告")

    rows = execute_query("SELECT * FROM discussions WHERE id=?", (disc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="讨论不存在")

    columns = ["id", "creator_username", "title", "description", "subject",
               "group_mode", "group_count", "members_per_group", "ai_role",
               "duration_minutes", "status", "grade", "classes",
               "require_summary", "created_at", "updated_at"]
    disc = dict(zip(columns, rows[0]))

    # 获取所有小组的消息
    groups = execute_query(
        "SELECT id, group_index, name FROM discussion_groups WHERE discussion_id=? ORDER BY group_index",
        (disc_id,),
    )

    reports = []
    now = _now()

    # 生成总体报告
    overall_parts = [f"# 讨论报告：{disc['title']}\n"]
    overall_parts.append(f"\n## 总体概览\n")
    overall_parts.append(f"- 讨论主题：{disc['title']}")
    overall_parts.append(f"- 讨论说明：{disc['description']}")
    overall_parts.append(f"- 小组数量：{len(groups)}")

    group_summaries = []
    for g in groups:
        members = execute_query(
            "SELECT username FROM discussion_members WHERE group_id=?",
            (g[0],),
        )
        msgs = execute_query(
            "SELECT username, content, msg_type FROM discussion_messages WHERE group_id=? ORDER BY id ASC",
            (g[0],),
        )
        member_names = [m[0] for m in members]
        msg_count = len(msgs)
        group_summaries.append(f"\n### {g[2] or f'第{g[1]}组'}")
        group_summaries.append(f"- 成员：{', '.join(member_names)}")
        group_summaries.append(f"- 消息数：{msg_count}")
        # 取最后 5 条消息作为摘要
        recent = msgs[-5:] if msgs else []
        for rm in recent:
            sender = rm[0] or "AI助教"
            content = rm[1][:100]
            group_summaries.append(f"  - {sender}: {content}")

        # 为该小组生成 AI 分析摘要
        if msgs:
            messages_text = "\n".join(
                [f"{m[0] or 'AI助教'}: {m[1][:200]}" for m in msgs[-20:]]
            )
            prompt = f"""请对以下讨论内容进行简要分析（50字以内），总结该小组的关键观点和讨论质量：

讨论主题：{disc['title']}
讨论内容：
{messages_text}

简要分析："""

            ai_summary = ""
            try:
                import os
                api_key = os.environ.get("DASHSCOPE_API_KEY", "")
                if not api_key:
                    from backend.api.config_router import load_config
                    cfg = load_config()
                    api_key = cfg.get("dashscope_api_key", "")
                if api_key:
                    from backend.api.ai_service import call_ai_async
                    ai_summary = await call_ai_async(prompt, api_key)
            except Exception:
                pass

            if ai_summary:
                group_summaries.append(f"\n**AI 分析**：{ai_summary}")

            # 保存小组报告
            report_content = f"# 小组报告：{g[2] or f'第{g[1]}组'}\n\n"
            report_content += f"## 基本信息\n- 成员：{', '.join(member_names)}\n- 消息数：{msg_count}\n\n"
            report_content += f"## AI 分析\n{ai_summary}\n\n" if ai_summary else ""
            report_content += f"## 讨论内容\n```\n{messages_text}\n```"

            execute_insert_update(
                "INSERT INTO discussion_reports (discussion_id, group_id, report_content, generated_at) VALUES (?, ?, ?, ?)",
                (disc_id, g[0], report_content, now),
            )

    overall_parts.extend(group_summaries)
    overall_report = "\n".join(overall_parts)

    execute_insert_update(
        "INSERT INTO discussion_reports (discussion_id, group_id, report_content, generated_at) VALUES (?, NULL, ?, ?)",
        (disc_id, overall_report, now),
    )

    return {"status": "ok", "message": "报告生成完成"}


# ── 获取报告 ──

@router.get("/discussions/{disc_id}/reports", summary="获取讨论报告")
async def get_reports(disc_id: int, request: Request):
    rows = execute_query(
        "SELECT dr.id, dr.group_id, dr.report_content, dr.generated_at, "
        "dg.group_index, dg.name "
        "FROM discussion_reports dr "
        "LEFT JOIN discussion_groups dg ON dr.group_id = dg.id "
        "WHERE dr.discussion_id=? "
        "ORDER BY dr.group_id IS NULL DESC, dg.group_index ASC",
        (disc_id,),
    )
    return [
        {
            "id": r[0],
            "group_id": r[1],
            "content": r[2],
            "generated_at": r[3],
            "group_index": r[4],
            "group_name": r[5],
            "is_overall": r[1] is None,
        }
        for r in rows
    ]


# ── WebSocket 实时消息 ──

@router.websocket("/ws/{group_id}")
async def websocket_endpoint(websocket: WebSocket, group_id: int):
    """WebSocket 端点，客户端连接后实时接收新消息"""
    # 从 query 参数中获取 token 验证身份
    from backend.auth import decode_jwt_token
    token = websocket.query_params.get("token", "")
    payload = decode_jwt_token(token) if token else None
    username = payload.get("username", "anonymous") if payload else "anonymous"

    await ws_manager.connect(group_id, websocket)
    try:
        while True:
            # 保持连接，等待客户端发来 ping 或断开
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        ws_manager.disconnect(group_id, websocket)
    except Exception:
        ws_manager.disconnect(group_id, websocket)


# ── 讨论监控（教师/管理员）──

@router.get("/discussions/{disc_id}/monitor", summary="讨论监控面板数据")
async def monitor_discussion(disc_id: int, request: Request):
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可查看监控")

    rows = execute_query("SELECT status, title FROM discussions WHERE id=?", (disc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="讨论不存在")
    status, title = rows[0]

    # 获取所有小组状态
    groups = execute_query(
        "SELECT id, group_index, name FROM discussion_groups WHERE discussion_id=? ORDER BY group_index",
        (disc_id,),
    )
    now = datetime.now()
    group_list = []
    total_messages = 0
    total_members = 0
    cold_groups = 0

    for g in groups:
        members = execute_query(
            "SELECT COUNT(*) FROM discussion_members WHERE group_id=?",
            (g[0],),
        )[0][0]

        msg_count = execute_query(
            "SELECT COUNT(*) FROM discussion_messages WHERE group_id=?",
            (g[0],),
        )[0][0]

        last_msg = execute_query(
            "SELECT content, created_at FROM discussion_messages WHERE group_id=? ORDER BY id DESC LIMIT 1",
            (g[0],),
        )

        last_active = ""
        is_cold = False
        last_preview = ""
        if last_msg:
            last_preview = last_msg[0][0][:60]
            last_active = last_msg[0][1]
            try:
                last_time = datetime.strptime(last_active, "%Y-%m-%d %H:%M:%S")
                idle_seconds = (now - last_time).total_seconds()
                is_cold = idle_seconds > 60 and status == "active"
            except ValueError:
                pass

        if is_cold:
            cold_groups += 1
        total_messages += msg_count
        total_members += members

        group_list.append({
            "id": g[0],
            "group_index": g[1],
            "name": g[2] or f"第{g[1]}组",
            "member_count": members,
            "message_count": msg_count,
            "last_active": last_active,
            "last_preview": last_preview,
            "is_cold": is_cold,
        })

    return {
        "discussion_id": disc_id,
        "title": title,
        "status": status,
        "total_groups": len(groups),
        "total_members": total_members,
        "total_messages": total_messages,
        "cold_groups": cold_groups,
        "online_count": sum(ws_manager.get_group_connections(g["id"]) for g in group_list),
        "groups": group_list,
    }


# ── AI 自动触发 ──

@router.post("/discussions/{disc_id}/auto-trigger", summary="触发 AI 自动引导（冷场检测）")
async def auto_trigger_ai(disc_id: int, request: Request):
    """检测所有小组是否需要 AI 介入（冷场超过 60 秒），自动发送引导"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    rows = execute_query("SELECT status FROM discussions WHERE id=?", (disc_id,))
    if not rows or rows[0][0] != "active":
        return {"status": "ok", "triggered": 0, "message": "讨论未激活"}

    groups = execute_query(
        "SELECT id, group_index FROM discussion_groups WHERE discussion_id=?",
        (disc_id,),
    )
    now = datetime.now()
    triggered = 0
    import os

    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        try:
            from backend.api.config_router import load_config
            cfg = load_config()
            api_key = cfg.get("dashscope_api_key", "")
        except Exception:
            pass
    if not api_key:
        return {"status": "error", "triggered": 0, "message": "API Key 未配置"}

    from backend.api.ai_service import call_ai_async

    for g in groups:
        last_msg = execute_query(
            "SELECT content FROM discussion_messages WHERE group_id=? AND username IS NOT NULL ORDER BY id DESC LIMIT 1",
            (g[0],),
        )
        if not last_msg:
            continue

        last_content = last_msg[0][0]

        # 获取最近 5 条消息
        recent = execute_query(
            "SELECT username, content FROM discussion_messages WHERE group_id=? ORDER BY id DESC LIMIT 5",
            (g[0],),
        )
        messages_text = "\n".join(
            [f"{m[0] or 'AI助教'}: {m[1][:200]}" for m in reversed(recent)]
        )

        prompt = f"""你是一位高中课堂讨论的AI助教。
请根据以下讨论内容给出一个简短的引导问题或总结（30-50字），目的是推动讨论继续深入：

讨论内容：
{messages_text}

简短引导："""

        try:
            content = await call_ai_async(prompt, api_key)
            if content:
                now_str = _now()
                execute_insert_update(
                    "INSERT INTO discussion_messages (group_id, username, content, msg_type, created_at) VALUES (?, NULL, ?, 'ai_suggest', ?)",
                    (g[0], content, now_str),
                )
                # WebSocket 广播
                asyncio.create_task(ws_manager.broadcast(g[0], {
                    "type": "new_message",
                    "username": None,
                    "content": content,
                    "msg_type": "ai_suggest",
                    "created_at": now_str,
                }))
                triggered += 1
        except Exception as e:
            logger.warning(f"AI 自动触发失败 小组#{g[0]}: {e}")

    return {"status": "ok", "triggered": triggered}
