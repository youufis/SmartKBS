"""
协作白板 API 路由
房间管理、页面管理、WebSocket 通信、AI 辅助
"""
import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.database import execute_query, execute_insert_update, get_connection
from backend.whiteboard_ws import whiteboard_manager
from backend.logger import logger

router = APIRouter()


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _get_user_role(user: dict) -> int: # pyright: ignore[reportMissingTypeArgument]
    return user.get("role", 2)


def _is_teacher_or_admin(user: dict) -> bool: # type: ignore
    return _get_user_role(user) in (0, 1)


def _is_admin(user: dict) -> bool: # type: ignore
    return _get_user_role(user) == 0


# ── 请求模型 ──

class CreateRoomRequest(BaseModel):
    title: str
    room_type: str = "classroom"        # classroom / course / temporary
    mode: str = "demo"                  # demo / interactive / self_study
    course_kp_id: int | None = None
    grade: str = ""
    class_name: str = ""
    max_pages: int = 20


class UpdateRoomRequest(BaseModel):
    title: str | None = None
    mode: str | None = None
    allow_student_draw: bool | None = None


class JoinByCodeRequest(BaseModel):
    room_code: str


class SavePageRequest(BaseModel):
    snapshot_data: str                 # TLDraw 快照 JSON 字符串
    thumbnail: str = ""               # base64 缩略图
    title: str = ""


class GrantControlRequest(BaseModel):
    username: str


class SaveToResourceRequest(BaseModel):
    kp_id: int


# ═══════════════════════════════════════════════════════════
# 房间管理 API
# ═══════════════════════════════════════════════════════════

@router.post("/rooms", summary="创建白板房间")
async def create_room(req: CreateRoomRequest, request: Request):
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师和管理员可创建白板房间")

    room_code = whiteboard_manager.generate_room_code()
    now = _now()
    room_id = execute_insert_update(
        """INSERT INTO whiteboard_rooms
           (room_code, title, room_type, mode, creator_username, course_kp_id,
            grade, class_name, max_pages, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (room_code, req.title, req.room_type, req.mode, user["username"],
         req.course_kp_id, req.grade, req.class_name, req.max_pages, now),
    )
    # 创建默认第1页
    execute_insert_update(
        """INSERT INTO whiteboard_pages (room_id, page_number, title, is_current)
           VALUES (?, 1, '第1页', 1)""",
        (room_id,),
    )
    logger.info(f"白板房间创建: #{room_id} {room_code} by {user['username']}")
    return {"id": room_id, "room_code": room_code, "status": "ok"}


@router.get("/rooms", summary="获取白板房间列表")
async def list_rooms(
    request: Request,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
):
    user = get_current_user(request)
    if _is_teacher_or_admin(user):
        rows = execute_query(
            """SELECT id, room_code, title, room_type, mode, creator_username,
                      status, student_count, created_at
               FROM whiteboard_rooms
               WHERE creator_username=?
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?""",
            (user["username"], size, (page - 1) * size),
        )
    else:
        # 学生查看自己加入过的房间（已结束的也能看到）
        rows = execute_query(
            """SELECT r.id, r.room_code, r.title, r.room_type, r.mode, r.creator_username,
                      r.status, r.student_count, m.join_time as created_at
               FROM whiteboard_rooms r
               JOIN whiteboard_room_members m ON m.room_id = r.id AND m.username = ?
               ORDER BY m.join_time DESC
               LIMIT ? OFFSET ?""",
            (user["username"], size, (page - 1) * size),
        )
    return [
        {
            "id": r[0], "room_code": r[1], "title": r[2], "room_type": r[3],
            "mode": r[4], "creator_username": r[5], "status": r[6],
            "student_count": r[7], "created_at": r[8],
        }
        for r in rows
    ]


@router.get("/rooms/{room_id}", summary="获取房间详情")
async def get_room(room_id: int, request: Request):
    user = get_current_user(request)
    rows = execute_query(
        "SELECT * FROM whiteboard_rooms WHERE id=?", (room_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="房间不存在")
    r = rows[0]
    cols = ["id", "room_code", "title", "room_type", "mode", "creator_username",
            "course_kp_id", "grade", "class_name", "allow_student_draw", "max_pages",
            "auto_save_interval", "status", "student_count", "created_at", "ended_at"]
    return {cols[i]: r[i] for i in range(len(cols))}


@router.get("/rooms/{room_id}/snapshot", summary="获取当前快照（HTTP 兜底，IIS 环境用）")
async def get_snapshot(room_id: int, request: Request):
    """通过 HTTP 获取当前快照和授权状态，IIS 下 WebSocket 不可用时作为兜底"""
    user = get_current_user(request)
    username = user["username"]
    # 优先从内存取快照
    snap = whiteboard_manager.rooms.get(room_id, {}).get("last_snapshot", "")
    if not snap:
        rows = execute_query(
            "SELECT snapshot_data FROM whiteboard_pages WHERE room_id=? AND is_current=1 ORDER BY updated_at DESC LIMIT 1",
            (room_id,),
        )
        if rows and rows[0][0] and rows[0][0] != "{}":
            snap = rows[0][0]
    # 获取当前模式和学生授权状态
    mode = whiteboard_manager.get_mode(room_id)
    granted = whiteboard_manager.is_granted(room_id, username)
    return {"snapshot": snap, "mode": mode, "granted": granted}


@router.patch("/rooms/{room_id}", summary="更新房间配置")
async def update_room(room_id: int, req: UpdateRoomRequest, request: Request):
    user = get_current_user(request)
    rows = execute_query(
        "SELECT creator_username FROM whiteboard_rooms WHERE id=?", (room_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="房间不存在")
    if rows[0][0] != user["username"] and not _is_admin(user):
        raise HTTPException(status_code=403, detail="仅房主和管理员可修改")

    fields = []
    values = []
    if req.title is not None:
        fields.append("title=?")
        values.append(req.title)
    if req.mode is not None:
        fields.append("mode=?")
        values.append(req.mode)
        whiteboard_manager.set_mode(room_id, req.mode)
    if req.allow_student_draw is not None:
        fields.append("allow_student_draw=?")
        values.append(1 if req.allow_student_draw else 0)
    if fields:
        values.append(room_id)
        execute_insert_update(
            f"UPDATE whiteboard_rooms SET {', '.join(fields)} WHERE id=?",
            tuple(values),
        )
    return {"status": "ok"}


@router.post("/rooms/{room_id}/end", summary="结束房间")
async def end_room(room_id: int, request: Request):
    user = get_current_user(request)
    rows = execute_query(
        "SELECT creator_username FROM whiteboard_rooms WHERE id=? AND status='active'",
        (room_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="房间不存在或已结束")
    if rows[0][0] != user["username"] and not _is_admin(user):
        raise HTTPException(status_code=403, detail="仅房主和管理员可结束")

    now = _now()
    execute_insert_update(
        "UPDATE whiteboard_rooms SET status='ended', ended_at=? WHERE id=?",
        (now, room_id),
    )
    await whiteboard_manager.broadcast(room_id, {"type": "room_ended"})
    whiteboard_manager.rooms.pop(room_id, None)
    return {"status": "ok"}


@router.delete("/rooms/{room_id}", summary="删除房间")
async def delete_room(room_id: int, request: Request):
    user = get_current_user(request)
    rows = execute_query(
        "SELECT creator_username FROM whiteboard_rooms WHERE id=?", (room_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="房间不存在")
    if rows[0][0] != user["username"] and not _is_admin(user):
        raise HTTPException(status_code=403, detail="权限不足")

    execute_insert_update("DELETE FROM whiteboard_operations WHERE room_id=?", (room_id,))
    execute_insert_update("DELETE FROM whiteboard_room_members WHERE room_id=?", (room_id,))
    execute_insert_update("DELETE FROM whiteboard_pages WHERE room_id=?", (room_id,))
    execute_insert_update("DELETE FROM whiteboard_rooms WHERE id=?", (room_id,))
    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════
# 加入/离开
# ═══════════════════════════════════════════════════════════

@router.post("/join-by-code", summary="通过房间码加入")
async def join_by_code(req: JoinByCodeRequest, request: Request):
    user = get_current_user(request)
    rows = execute_query(
        "SELECT id, title, mode, grade, class_name FROM whiteboard_rooms WHERE room_code=? AND status='active'",
        (req.room_code.upper().strip(),),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="房间不存在或已结束")
    r = rows[0]
    # 插入或更新成员记录
    execute_insert_update(
        """INSERT OR REPLACE INTO whiteboard_room_members
           (room_id, username, role, join_time)
           VALUES (?, ?, ?, ?)""",
        (r[0], user["username"], "teacher" if _is_teacher_or_admin(user) else "student", _now()),
    )
    return {
        "room_id": r[0],
        "title": r[1],
        "mode": r[2],
        "grade": r[3],
        "class_name": r[4],
    }


@router.post("/rooms/{room_id}/leave", summary="离开房间")
async def leave_room_api(room_id: int, request: Request):
    user = get_current_user(request)
    execute_insert_update(
        "UPDATE whiteboard_room_members SET leave_time=? WHERE room_id=? AND username=?",
        (_now(), room_id, user["username"]),
    )
    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════
# 页面管理
# ═══════════════════════════════════════════════════════════

@router.get("/rooms/{room_id}/pages", summary="获取所有页面")
async def list_pages(room_id: int, request: Request):
    get_current_user(request)
    rows = execute_query(
        """SELECT page_number, title, snapshot_data, thumbnail, is_current, duration_seconds
           FROM whiteboard_pages WHERE room_id=?
           ORDER BY page_number""",
        (room_id,),
    )
    return [
        {
            "page_number": r[0], "title": r[1], "snapshot_data": r[2],
            "thumbnail": r[3], "is_current": bool(r[4]),
            "duration_seconds": r[5],
        }
        for r in rows
    ]


@router.get("/rooms/{room_id}/pages/{page_number}", summary="获取指定页面快照")
async def get_page(room_id: int, page_number: int, request: Request):
    get_current_user(request)
    rows = execute_query(
        "SELECT snapshot_data, title FROM whiteboard_pages WHERE room_id=? AND page_number=?",
        (room_id, page_number),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="页面不存在")
    return {"snapshot_data": rows[0][0], "title": rows[0][1]}


@router.put("/rooms/{room_id}/pages/{page_number}", summary="保存页面快照")
async def save_page(room_id: int, page_number: int, req: SavePageRequest, request: Request):
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可保存页面")
    now = _now()
    execute_insert_update(
        """INSERT OR REPLACE INTO whiteboard_pages
           (room_id, page_number, snapshot_data, thumbnail, title, is_current, updated_at, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, COALESCE((SELECT created_at FROM whiteboard_pages WHERE room_id=? AND page_number=?), ?))""",
        (room_id, page_number, req.snapshot_data, req.thumbnail, req.title, now,
         room_id, page_number, now),
    )
    return {"status": "ok"}


@router.post("/rooms/{room_id}/pages", summary="新增页面")
async def add_page(room_id: int, request: Request):
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可新增页面")

    # 获取最大页码
    rows = execute_query(
        "SELECT COALESCE(MAX(page_number), 0) FROM whiteboard_pages WHERE room_id=?",
        (room_id,),
    )
    next_num = (rows[0][0] or 0) + 1
    execute_insert_update(
        "INSERT INTO whiteboard_pages (room_id, page_number, title) VALUES (?, ?, ?)",
        (room_id, next_num, f"第{next_num}页"),
    )
    return {"page_number": next_num, "status": "ok"}


@router.delete("/rooms/{room_id}/pages/{page_number}", summary="删除页面")
async def delete_page(room_id: int, page_number: int, request: Request):
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可删除页面")
    execute_insert_update(
        "DELETE FROM whiteboard_pages WHERE room_id=? AND page_number=?",
        (room_id, page_number),
    )
    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════
# 控制权管理（互动模式）
# ═══════════════════════════════════════════════════════════

@router.post("/rooms/{room_id}/control/grant", summary="授权学生操作")
async def grant_control(room_id: int, req: GrantControlRequest, request: Request):
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可授权")
    await whiteboard_manager.grant_control(room_id, req.username, user["username"])
    return {"status": "ok"}


@router.post("/rooms/{room_id}/control/revoke", summary="收回操作权")
async def revoke_control(room_id: int, req: GrantControlRequest, request: Request):
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可收回")
    await whiteboard_manager.revoke_control(room_id, req.username)
    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════
# 自习模式：学生列表
# ═══════════════════════════════════════════════════════════

@router.get("/rooms/{room_id}/students", summary="获取房间内学生列表（教师巡览）")
async def list_students(room_id: int, request: Request):
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可查看")

    # 从 WebSocket 内存中获取当前真实在线的学生
    room_data = whiteboard_manager.rooms.get(room_id)
    if not room_data:
        return []
    connected_students = {
        username for username, conn in room_data.get("connections", {}).items()
        if conn.get("role") == "student"
    }
    if not connected_students:
        return []

    placeholders = ",".join("?" * len(connected_students))
    rows = execute_query(
        f"""SELECT m.username, m.role, m.self_snapshot, u.name, u.class,
                  m.join_time
           FROM whiteboard_room_members m
           LEFT JOIN users u ON u.username = m.username
           WHERE m.room_id=? AND m.role='student' AND m.username IN ({placeholders})
           ORDER BY m.join_time""",
        (room_id, *connected_students),
    )
    return [
        {
            "username": r[0], "role": r[1], "self_snapshot": r[2],
            "name": r[3] or r[0], "class": r[4] or "",
            "join_time": r[5],
        }
        for r in rows
    ]


@router.post("/rooms/{room_id}/spotlight", summary="投屏学生白板到全班")
async def spotlight_student(room_id: int, request: Request):
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可投屏")
    body = await request.json()
    target = body.get("username", "")
    rows = execute_query(
        "SELECT self_snapshot FROM whiteboard_room_members WHERE room_id=? AND username=?",
        (room_id, target),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="学生不在房间中")
    await whiteboard_manager.broadcast(room_id, {
        "type": "spotlight",
        "username": target,
        "snapshot": rows[0][0] or "{}",
    })
    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════
# AI 辅助功能
# ═══════════════════════════════════════════════════════════

@router.post("/ai/generate-diagram", summary="AI 根据描述生成图示")
async def ai_generate_diagram(request: Request):
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可使用")
    body = await request.json()
    description = body.get("description", "")
    subject = body.get("subject", "通用技术")
    if not description:
        raise HTTPException(status_code=400, detail="请输入描述")

    from backend.api.config_router import get_config_value
    api_key = get_config_value("dashscope_api_key", "") or get_config_value("DASHSCOPE_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    prompt = f"""你是一位教学图示设计师。请根据以下描述，生成可插入白板的SVG或简单图示描述。

描述：{description}
学科：{subject}

请输出JSON格式（不要其他文字）：
{{
  "shapes": [
    {{"type": "svg", "svg": "<svg>...</svg>", "x": 100, "y": 100, "label": "描述"}}
  ]
}}
如果无法生成SVG，则用 shapes 数组中给出几何形状的描述（如矩形、圆形等）。
"""
    try:
        from backend.api.ai_service import call_ai_sync
        result = call_ai_sync(prompt, api_key)
        jm = __import__("re").search(r'\{[\s\S]*\}', result.strip())
        if jm:
            return json.loads(jm.group())
        return {"shapes": [], "raw": result}
    except Exception as e:
        logger.error(f"AI 生成图示失败: {e}")
        raise HTTPException(status_code=500, detail=f"AI 生成失败: {str(e)}")


@router.post("/ai/suggest", summary="AI 根据当前内容推荐下一步")
async def ai_suggest(request: Request):
    user = get_current_user(request)
    body = await request.json()
    current_content = body.get("content", "")
    kp_name = body.get("kp_name", "")
    if not current_content:
        raise HTTPException(status_code=400, detail="请提供当前白板内容")

    from backend.api.config_router import get_config_value
    api_key = get_config_value("dashscope_api_key", "") or get_config_value("DASHSCOPE_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    prompt = f"""你是一位教学助手。学生在白板上画了以下内容，请给出简短的下一步建议（50字以内）。

{current_content}
知识点：{kp_name}

直接回复文字，不要JSON格式。"""
    try:
        from backend.api.ai_service import call_ai_sync
        result = call_ai_sync(prompt, api_key)
        return {"suggestion": result.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 建议失败: {str(e)}")


# ═══════════════════════════════════════════════════════════
# WebSocket 端点
# ═══════════════════════════════════════════════════════════

@router.websocket("/ws/{room_id}")
async def whiteboard_websocket(websocket: WebSocket, room_id: int):
    """白板 WebSocket 实时通信"""
    # 1. 认证
    from backend.auth import decode_jwt_token
    token = websocket.query_params.get("token", "")
    if not token:
        await websocket.close(code=4001, reason="缺少认证令牌")
        return

    try:
        payload = decode_jwt_token(token)
        if payload is None:
            await websocket.close(code=4001, reason="认证失败")
            return
        username = payload.get("username", "") or ""
    except Exception:
        await websocket.close(code=4001, reason="认证失败")
        return

    if not username:
        await websocket.close(code=4001, reason="认证失败")
        return

    # 2. 查询用户详情
    rows = execute_query(
        "SELECT username, role, name FROM users WHERE username=?", (username,),
    )
    if not rows:
        await websocket.close(code=4001, reason="用户不存在")
        return

    row = rows[0]
    username = row[0]
    role_num = row[1]
    role = "teacher" if role_num in (0, 1) else "student"

    # 3. 验证房间存在
    room_rows = execute_query(
        "SELECT id, mode, creator_username FROM whiteboard_rooms WHERE id=? AND status='active'",
        (room_id,),
    )
    if not room_rows:
        await websocket.close(code=4003, reason="房间不存在或已结束")
        return

    room_mode = room_rows[0][1]

    # 4. 加入房间
    await whiteboard_manager.join_room(room_id, username, role, websocket)
    # 同步房间模式
    whiteboard_manager.set_mode(room_id, room_mode)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "")

            # ── 白板操作 ──
            if msg_type == "op":
                # 使用管理器中的实时模式，而非连接时的缓存值
                live_mode = whiteboard_manager.get_mode(room_id)
                if _can_operate(room_id, username, role, live_mode):
                    logger.info(f"[白板WS] op from {username}({role}), room={room_id}, page={data.get('page','?')}, snapshotSize={len(str(data.get('data',{}).get('snapshot','')))}")
                    await whiteboard_manager.handle_op(room_id, username, data)
                else:
                    logger.warning(f"[白板WS] op denied for {username}({role}), room={room_id}, mode={live_mode}")

            # ── 光标同步 ──
            elif msg_type == "cursor":
                await whiteboard_manager.handle_cursor(room_id, username, data)

            # ── 切换页面（教师）──
            elif msg_type == "switch_page":
                if role == "teacher":
                    page = data.get("page", 1)
                    whiteboard_manager.set_current_page(room_id, page)
                    # 加载新页面快照
                    page_rows = execute_query(
                        "SELECT snapshot_data FROM whiteboard_pages WHERE room_id=? AND page_number=?",
                        (room_id, page),
                    )
                    await whiteboard_manager.broadcast(room_id, {
                        "type": "page_switched",
                        "page": page,
                        "snapshot": page_rows[0][0] if page_rows else "{}",
                    })

            # ── 切换模式（教师）──
            elif msg_type == "mode_change":
                if role == "teacher":
                    new_mode = data.get("mode", "demo")
                    old_mode = whiteboard_manager.get_mode(room_id)
                    whiteboard_manager.set_mode(room_id, new_mode)
                    execute_insert_update(
                        "UPDATE whiteboard_rooms SET mode=? WHERE id=?",
                        (new_mode, room_id),
                    )
                    # 退出互动模式时清除所有学生授权
                    if old_mode == "interactive" and new_mode != "interactive":
                        room = whiteboard_manager.rooms.get(room_id)
                        if room:
                            room.get("granted_users", set()).clear()
                            for conn in room.get("connections", {}).values():
                                conn["granted"] = False
                    await whiteboard_manager.broadcast(room_id, {
                        "type": "mode_changed",
                        "mode": new_mode,
                    })

            # ── 举手 ──
            elif msg_type == "raise_hand":
                await whiteboard_manager.broadcast(room_id, {
                    "type": "hand_raised",
                    "username": username,
                })

            # ── 学生请求同步当前快照 ──
            elif msg_type == "request_sync":
                last_snap = whiteboard_manager.rooms.get(room_id, {}).get("last_snapshot", "")
                if last_snap:
                    await whiteboard_manager.send_to_user(room_id, username, {
                        "type": "op_broadcast",
                        "sender": "system",
                        "data": {"snapshot": last_snap},
                    })
                    logger.info(f"[白板] request_sync: 响应 {username}, size={len(last_snap)}")

            # ── 自习模式：学生保存自己的白板 ──
            elif msg_type == "self_save":
                if role == "student" and whiteboard_manager.get_mode(room_id) == "self_study":
                    execute_insert_update(
                        "UPDATE whiteboard_room_members SET self_snapshot=? WHERE room_id=? AND username=?",
                        (data.get("snapshot", "{}"), room_id, username),
                    )

            # ── 自习模式：学生提交 ──
            elif msg_type == "self_submit":
                if role == "student" and whiteboard_manager.get_mode(room_id) == "self_study":
                    execute_insert_update(
                        "UPDATE whiteboard_room_members SET self_snapshot=? WHERE room_id=? AND username=?",
                        (data.get("snapshot", "{}"), room_id, username),
                    )
                    await whiteboard_manager.broadcast(room_id, {
                        "type": "student_submitted",
                        "username": username,
                    })

    except WebSocketDisconnect:
        await whiteboard_manager.leave_room(room_id, username)
    except Exception as e:
        logger.warning(f"白板 WS 异常 room#{room_id} user={username}: {e}")
        await whiteboard_manager.leave_room(room_id, username)


def _can_operate(room_id: int, username: str, role: str, mode: str) -> bool:
    """检查操作权限"""
    if role == "teacher":
        return True
    if mode == "interactive":
        return whiteboard_manager.is_granted(room_id, username)
    if mode == "self_study":
        return True  # 自习模式各自可操作
    return False  # demo 模式学生不可操作
