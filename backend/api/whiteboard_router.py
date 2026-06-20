"""
协作白板 API 路由
房间管理、页面管理、WebSocket 通信、AI 辅助
"""
import json
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.api.chat_router import get_api_keys
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
            """SELECT r.id, r.room_code, r.title, r.room_type, r.mode,
                      r.creator_username, COALESCE(u.name, r.creator_username),
                      r.status, r.student_count, r.created_at
               FROM whiteboard_rooms r
               LEFT JOIN users u ON u.username = r.creator_username
               WHERE r.creator_username=?
               ORDER BY r.created_at DESC
               LIMIT ? OFFSET ?""",
            (user["username"], size, (page - 1) * size),
        )
    else:
        # 学生：只看自己年级班级教师（及管理员）创建的房间
        user_rows = execute_query(
            "SELECT grade, class_name FROM users WHERE username=?",
            (user["username"],),
        )
        u_grade = (user_rows[0][0] or "") if user_rows else ""
        u_class = (user_rows[0][1] or "") if user_rows else ""
        rows = execute_query(
            """SELECT r.id, r.room_code, r.title, r.room_type, r.mode,
                      r.creator_username, COALESCE(u.name, r.creator_username),
                      r.status, r.student_count, r.created_at
               FROM whiteboard_rooms r
               LEFT JOIN users u ON u.username = r.creator_username
               WHERE r.status='active'
                 AND (? = '' OR r.grade = '' OR r.grade = ?)
                 AND (? = '' OR r.class_name = '' OR r.class_name = ?)
               ORDER BY r.created_at DESC
               LIMIT ? OFFSET ?""",
            (u_grade, u_grade, u_class, u_class, size, (page - 1) * size),
        )
    return [
        {
            "id": r[0], "room_code": r[1], "title": r[2], "room_type": r[3],
            "mode": r[4], "creator_username": r[5], "creator_name": r[6],
            "status": r[7], "student_count": r[8], "created_at": r[9],
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

    # 学生只能加入自己年级/班级的房间
    if _get_user_role(user) == 2:  # student
        user_rows = execute_query(
            "SELECT grade, class_name FROM users WHERE username=?",
            (user["username"],),
        )
        if user_rows:
            u_grade = user_rows[0][0] or ""
            u_class = user_rows[0][1] or ""
            room_grade = r[3] or ""
            room_class = r[4] or ""
            # 如果房间指定了年级/班级，学生必须匹配
            if room_grade and room_grade != u_grade:
                raise HTTPException(status_code=403, detail="该白板房间不属于你的年级")
            if room_class and room_class != u_class:
                raise HTTPException(status_code=403, detail="该白板房间不属于你的班级")

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

def _get_snapshot_text(room_id: int) -> str:
    """从内存或数据库获取白板当前内容的文字和图形描述"""

    def _extract_text(props: dict) -> str:
        """从形状 props 中提取文字（兼容 richText 和 text）"""
        rt = props.get("richText")
        if rt and isinstance(rt, dict):
            try:
                texts = []
                for node in rt.get("content", []):
                    for child in node.get("content", []):
                        t = child.get("text", "")
                        if t:
                            texts.append(t)
                return "".join(texts)
            except Exception:
                pass
        t = props.get("text", "")
        return t if t else ""

    snap = whiteboard_manager.rooms.get(room_id, {}).get("last_snapshot", "")
    if not snap or snap == "{}":
        rows = execute_query(
            "SELECT snapshot_data FROM whiteboard_pages WHERE room_id=? AND is_current=1 ORDER BY updated_at DESC LIMIT 1",
            (room_id,),
        )
        if rows and rows[0][0] and rows[0][0] != "{}":
            snap = rows[0][0]
    if not snap or snap == "{}":
        logger.info(f"[白板AI] room={room_id} 快照为空")
        return "白板当前为空"

    try:
        parsed = json.loads(snap)
        # TLDraw getSnapshot() 格式: { document: { store: { shapeId: {...}, ... } }, session: {...} }
        doc = parsed.get("document", {})
        store = doc.get("store", parsed.get("store", {}))
        # 筛选 typeName 为 shape 的记录（兼容新旧格式）
        shapes = {k: v for k, v in store.items() if isinstance(v, dict) and v.get("typeName") == "shape"}
        if not shapes:
            shapes = store.get("shapes", {})
        if not shapes:
            return "白板当前为空"

        type_names = {"geo": "几何形状", "arrow": "箭头", "text": "文本", "draw": "手绘", "image": "图片", "line": "线条"}
        geo_names = {"rectangle": "矩形", "ellipse": "椭圆", "diamond": "菱形", "triangle": "三角形",
                     "cloud": "云形", "pentagon": "五边形", "hexagon": "六边形", "trapezoid": "梯形",
                     "rhombus": "菱形", "star": "星形", "arrow-up": "上箭头", "arrow-down": "下箭头",
                     "arrow-left": "左箭头", "arrow-right": "右箭头", "cross": "叉形", "x-box": "X框"}

        lines = []
        texts = []
        arrows = []
        for sid, shape in shapes.items():
            props = shape.get("props", {}) or {}
            stype = shape.get("type", "unknown")
            sname = type_names.get(stype, stype)
            text = _extract_text(props)
            x = int(shape.get("x", 0))
            y = int(shape.get("y", 0))

            if text:
                texts.append(text)

            if stype == "geo":
                geo = props.get("geo", "rectangle")
                gname = geo_names.get(geo, geo)
                color = props.get("color", "black")
                fill = props.get("fill", "none")
                w = int(props.get("w", 0))
                h = int(props.get("h", 0))
                desc = f"位于({x},{y})的{gname}({w}x{h})"
                if color != "black":
                    desc += f"，{color}色边框"
                if fill and fill not in ("none", "null"):
                    desc += f"，{fill}色填充"
                if text:
                    desc += f"，文字「{text[:30]}」"
                lines.append(desc)

            elif stype == "arrow":
                start = props.get("start", {})
                end = props.get("end", {})
                sx = int(start.get("x", 0) + shape.get("x", 0))
                sy = int(start.get("y", 0) + shape.get("y", 0))
                ex = int(end.get("x", 0) + shape.get("x", 0))
                ey = int(end.get("y", 0) + shape.get("y", 0))
                arrows.append(f"从({sx},{sy})指向({ex},{ey})的箭头")

            elif stype == "image":
                src = props.get("src", "")
                desc = f"位于({x},{y})的图片"
                if src and isinstance(src, str):
                    desc += f"，来源: {src[:80]}"
                lines.append(desc)

            elif stype == "draw":
                lines.append(f"位于({x},{y})的手绘笔迹")

            elif text:
                lines.append(f"位于({x},{y})的文字「{text[:30]}」")

        # 构建结构化描述
        parts = []
        if texts:
            parts.append(f"## 白板中的文字内容\n{' | '.join(texts)}")
        if lines:
            parts.append(f"## 白板中的图形\n{chr(10).join('- ' + l for l in lines)}")
        if arrows:
            parts.append(f"## 图形之间的连线\n{chr(10).join('- ' + a for a in arrows)}")

        result = "\n\n".join(parts) if parts else "白板当前有内容，但无法识别具体元素"
        return result

    except Exception as e:
        logger.warning(f"解析白板快照失败: {e}")
        return "白板当前有内容"


def _get_snapshot_images(room_id: int) -> list[str]:
    """从白板快照中提取图片，保存为临时文件，返回文件路径列表"""
    import base64, tempfile, os, re

    snap = whiteboard_manager.rooms.get(room_id, {}).get("last_snapshot", "")
    if not snap or snap == "{}":
        rows = execute_query(
            "SELECT snapshot_data FROM whiteboard_pages WHERE room_id=? AND is_current=1 ORDER BY updated_at DESC LIMIT 1",
            (room_id,),
        )
        if rows and rows[0][0] and rows[0][0] != "{}":
            snap = rows[0][0]
    if not snap or snap == "{}":
        return []

    try:
        parsed = json.loads(snap)
        store = parsed.get("document", {}).get("store", parsed.get("store", {}))
        if not store:
            return []

        # 收集所有 assets
        assets = {}
        for k, v in store.items():
            if isinstance(v, dict) and v.get("typeName") == "asset" and v.get("type") == "image":
                assets[k] = v

        # 收集所有 image shapes
        image_shapes = []
        for k, v in store.items():
            if isinstance(v, dict) and v.get("typeName") == "shape" and v.get("type") == "image":
                image_shapes.append(v)

        if not image_shapes or not assets:
            return []

        saved_paths = []
        for shape in image_shapes:
            # TLDraw v3 image shape 用 assetId 引用 asset，不是 src
            src_ref = (shape.get("props") or {}).get("assetId", "")
            if not src_ref or not isinstance(src_ref, str):
                continue

            # assetId 已经是 asset:xxx 格式
            asset_src = ""
            if src_ref.startswith("asset:") and src_ref in assets:
                asset_src = (assets[src_ref].get("props") or {}).get("src", "")
            elif src_ref.startswith("data:") or src_ref.startswith("http"):
                asset_src = src_ref

            if not asset_src:
                continue

            # 处理 data URL
            if asset_src.startswith("data:"):
                try:
                    m = re.match(r'data:image/(\w+);base64,(.+)', asset_src)
                    if m:
                        ext = m.group(1)
                        raw = base64.b64decode(m.group(2))
                        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}")
                        tmp.write(raw)
                        tmp.close()
                        saved_paths.append(tmp.name)
                except Exception:
                    continue

            # 处理 http/https URL
            elif asset_src.startswith("http"):
                try:
                    import requests as sync_req
                    r = sync_req.get(asset_src, timeout=10)
                    if r.status_code == 200:
                        ext = "png"
                        ct = r.headers.get("content-type", "")
                        if "jpeg" in ct or "jpg" in ct:
                            ext = "jpg"
                        elif "gif" in ct:
                            ext = "gif"
                        elif "webp" in ct:
                            ext = "webp"
                        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}")
                        tmp.write(r.content)
                        tmp.close()
                        saved_paths.append(tmp.name)
                except Exception:
                    continue

        return saved_paths
    except Exception as e:
        logger.warning(f"[白板AI] 提取图片失败: {e}")
        return []


@router.post("/ai/chat-stream", summary="AI 白板助手流式对话")
async def ai_chat_stream(request: Request):
    """白板 AI 助手 SSE 流式对话"""
    user = get_current_user(request)
    username = user["username"]
    body = await request.json()
    prompt = body.get("prompt", "")
    room_id = body.get("room_id")

    if not prompt:
        raise HTTPException(status_code=400, detail="请输入问题")

    # 获取 API Key
    dashscope_api_key, _ = get_api_keys(username)
    if not dashscope_api_key:
        return StreamingResponse(
            _error_stream("API Key 未配置，请联系管理员"),
            media_type="text/event-stream",
        )

    # 获取白板上下文
    mode = whiteboard_manager.get_mode(room_id) if room_id else "demo"
    snapshot_text = _get_snapshot_text(room_id) if room_id else "无白板内容"
    kp_name = body.get("kp_name", "")
    subject = body.get("subject", "通用技术")

    # 构建系统提示词
    from backend.prompts.whiteboard_ai import WHITEBOARD_TEACHER_ASSISTANT
    system_prompt = WHITEBOARD_TEACHER_ASSISTANT.format(
        mode=mode,
        kp_name=kp_name or "未指定",
        subject=subject,
        snapshot_text=snapshot_text,
    )
    enhanced_prompt = f"{system_prompt}\n\n---\n\n用户提问：{prompt}"

    # 检测白板中是否有图片，有则走视觉模型
    image_paths = _get_snapshot_images(room_id) if room_id else []
    if image_paths:
        return StreamingResponse(
            _whiteboard_ai_vision_stream(system_prompt, prompt, image_paths, username, dashscope_api_key),
            media_type="text/event-stream",
        )

    from backend.api.chat_router import _chat_event_generator as _cg
    return StreamingResponse(
        _whiteboard_ai_stream(enhanced_prompt, username, dashscope_api_key),
        media_type="text/event-stream",
    )


def _whiteboard_ai_stream(prompt: str, username: str, api_key: str):
    """白板 AI 流式生成器（后端自行累加，前端只替换不追加）"""
    from backend.api.chat_router import _agent_chat_stream
    try:
        full = ""
        for chunk in _agent_chat_stream(prompt, None, api_key, username):
            full += chunk["text"]
            yield f"data: {json.dumps({'type': 'delta', 'content': full})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"
    except Exception as e:
        logger.error(f"白板 AI 流式生成失败: {e}")
        yield f"data: {json.dumps({'type': 'error', 'content': f'AI 响应失败：{str(e)}'})}\n\n"


def _whiteboard_ai_vision_stream(system_prompt: str, user_prompt: str, image_paths: list[str],
                                 username: str, api_key: str):
    """白板 AI 视觉流式生成：将白板图片+文字一起送入视觉模型"""
    import requests as sync_requests
    from backend.api.chat_router import get_config_value as get_cfg
    from backend.utils import encode_image_to_base64, get_image_mime_type

    model_name = get_cfg("MODEL_VL_NAME", "qwen3-vl-plus")
    api_base = get_cfg("QWEN_OPENAI_API_BASE",
                       "https://dashscope.aliyuncs.com/compatible-mode/v1")

    # 构建多模态 content 数组
    content = []
    # 先加图片
    for fp in image_paths:
        try:
            b64 = encode_image_to_base64(fp)
            mime = get_image_mime_type(fp)
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{b64}"},
            })
        except Exception as e:
            logger.warning(f"[白板AI] 图片编码失败 {fp}: {e}")
    # 再加用户提问
    content.append({"type": "text", "text": f"{system_prompt}\n\n用户提问：{user_prompt}"})

    payload = {
        "model": model_name,
        "messages": [{"role": "user", "content": content}],
        "stream": True,
    }

    try:
        resp = sync_requests.post(
            f"{api_base}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            stream=True,
            timeout=120,
        )
        if resp.status_code != 200:
            yield f"data: {json.dumps({'type': 'error', 'content': f'视觉模型调用失败: HTTP {resp.status_code}'})}\n\n"
            return

        full_text = ""
        for line in resp.iter_lines():
            if not line:
                continue
            decoded = line.decode("utf-8") if isinstance(line, bytes) else line
            if decoded.startswith("data:"):
                data_str = decoded[5:]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    if "choices" in data and data["choices"]:
                        delta = data["choices"][0].get("delta", {})
                        content_delta = delta.get("content", "")
                        if content_delta:
                            full_text += content_delta
                            yield f"data: {json.dumps({'type': 'delta', 'content': full_text})}\n\n"
                except json.JSONDecodeError:
                    continue
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

        # 清理临时图片文件
        for fp in image_paths:
            try:
                import os
                os.unlink(fp)
            except Exception:
                pass

    except Exception as e:
        logger.error(f"[白板AI] 视觉流式生成失败: {e}")
        yield f"data: {json.dumps({'type': 'error', 'content': f'AI 响应失败：{str(e)}'})}\n\n"


def _error_stream(msg: str):
    """生成错误流"""
    yield f"data: {json.dumps({'type': 'error', 'content': msg})}\n\n"


@router.post("/ai/generate-diagram", summary="AI 生成图示（SVG 优先，必要时万相生图）")
async def ai_generate_diagram(request: Request):
    """AI 图示生成：SVG 优先，复杂生图走通义万相"""
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可使用")
    body = await request.json()
    description = body.get("description", "")
    subject = body.get("subject", "通用技术")
    if not description:
        raise HTTPException(status_code=400, detail="请输入描述")

    dashscope_api_key, _ = get_api_keys(user["username"])
    if not dashscope_api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    from backend.prompts.whiteboard_ai import DIAGRAM_GENERATION_PROMPT
    prompt = DIAGRAM_GENERATION_PROMPT.format(description=description, subject=subject)

    # 阶段1: 让 AI 判断模式并生成 SVG 或 生图提示词
    try:
        from backend.api.ai_service import call_ai_sync
        result = call_ai_sync(prompt, dashscope_api_key)
        import re
        jm = re.search(r'\{[\s\S]*\}', result.strip())
        if not jm:
            return {"mode": "svg", "svg": "", "error": "AI 返回格式异常"}
        data = json.loads(jm.group())
    except Exception as e:
        logger.error(f"AI 判断失败: {e}")
        raise HTTPException(status_code=500, detail=f"AI 分析失败: {str(e)}")

    mode = data.get("mode", "svg")

    # ── SVG 模式 ──
    if mode == "svg":
        svg_content = data.get("svg", "")
        if not svg_content:
            return {"mode": "svg", "svg": "", "error": "AI 未生成 SVG 内容"}
        # 简单校验：必须有 <svg 标签
        if "<svg" not in svg_content:
            return {"mode": "svg", "svg": "", "error": "AI 生成内容不是有效 SVG"}
        return {
            "mode": "svg",
            "svg": svg_content,
            "width": data.get("width", 800),
            "height": data.get("height", 600),
            "title": data.get("title", ""),
        }

    # ── 图片模式（调用通义万相） ──
    if mode == "image":
        image_prompt = data.get("prompt", description)
        try:
            from backend.api.image_gen_service import generate_and_save_image
            import uuid
            from pathlib import Path

            # 存到 question_media/whiteboard_ai/ 下，通过已有静态挂载点访问
            save_dir = Path("question_media") / "whiteboard_ai"
            save_dir.mkdir(parents=True, exist_ok=True)
            filename = f"wb_{uuid.uuid4().hex}"

            local_path = await generate_and_save_image(
                prompt=image_prompt,
                save_dir=save_dir,
                filename=filename,
            )
            if local_path:
                return {
                    "mode": "image",
                    "image_url": f"/api/files/question_media/whiteboard_ai/{Path(local_path).name}",
                    "title": data.get("title", ""),
                }
            else:
                logger.error("万相生图失败，降级为文字描述")
                return {
                    "mode": "text",
                    "text": image_prompt,
                    "title": data.get("title", ""),
                    "error": "图片生成失败，请稍后重试",
                }
        except Exception as e:
            logger.error(f"万相生图异常: {e}")
            return {
                "mode": "text",
                "text": image_prompt,
                "title": data.get("title", ""),
                "error": f"图片生成异常: {str(e)}",
            }

    return {"mode": "svg", "svg": "", "error": f"未知模式: {mode}"}


@router.post("/ai/generate-board", summary="AI 根据知识点生成完整板书")
async def ai_generate_board(request: Request):
    """一键板书：根据知识点生成结构化板书形状"""
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可使用")
    body = await request.json()
    kp_name = body.get("kp_name", "")
    subject = body.get("subject", "通用技术")
    grade = body.get("grade", "")
    if not kp_name:
        raise HTTPException(status_code=400, detail="请指定知识点")

    dashscope_api_key, _ = get_api_keys(user["username"])
    if not dashscope_api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    from backend.prompts.whiteboard_ai import BOARD_GENERATION_PROMPT
    prompt = BOARD_GENERATION_PROMPT.format(kp_name=kp_name, subject=subject, grade=grade)

    try:
        from backend.api.ai_service import call_ai_sync
        result = call_ai_sync(prompt, dashscope_api_key)
        import re
        jm = re.search(r'\{[\s\S]*\}', result.strip())
        if jm:
            data = json.loads(jm.group())
            return {"title": data.get("title", kp_name), "shapes": data.get("shapes", [])}
        return {"title": kp_name, "shapes": [], "raw": result}
    except Exception as e:
        logger.error(f"AI 生成板书失败: {e}")
        raise HTTPException(status_code=500, detail=f"AI 生成板书失败: {str(e)}")


@router.post("/ai/suggest", summary="AI 根据当前内容推荐下一步")
async def ai_suggest(request: Request):
    user = get_current_user(request)
    body = await request.json()
    current_content = body.get("content", "")
    kp_name = body.get("kp_name", "")
    if not current_content:
        raise HTTPException(status_code=400, detail="请提供当前白板内容")

    dashscope_api_key, _ = get_api_keys(user["username"])
    if not dashscope_api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    prompt = f"""你是一位教学助手。课堂上白板当前内容如下，请给出简短的下一步教学建议（50字以内）。

{current_content}
知识点：{kp_name}

直接回复文字，不要JSON格式。"""
    try:
        from backend.api.ai_service import call_ai_sync
        result = call_ai_sync(prompt, dashscope_api_key)
        return {"suggestion": result.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI 建议失败: {str(e)}")


@router.post("/ai/generate-quiz", summary="AI 根据板书生成随堂提问")
async def ai_generate_quiz(request: Request):
    """随堂提问：根据白板内容生成一道选择题"""
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可使用")
    body = await request.json()
    room_id = body.get("room_id")
    subject = body.get("subject", "通用技术")
    kp_name = body.get("kp_name", "")
    if not room_id:
        raise HTTPException(status_code=400, detail="请提供房间 ID")

    dashscope_api_key, _ = get_api_keys(user["username"])
    if not dashscope_api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    snapshot_text = _get_snapshot_text(room_id)
    if not snapshot_text or snapshot_text == "白板当前为空":
        raise HTTPException(status_code=400, detail="白板当前为空，请先在白板上书写内容")

    from backend.prompts.whiteboard_ai import QUIZ_GENERATION_PROMPT
    prompt = QUIZ_GENERATION_PROMPT.format(
        snapshot_text=snapshot_text,
        kp_name=kp_name or "未指定",
        subject=subject,
    )

    try:
        from backend.api.ai_service import call_ai_sync
        result = call_ai_sync(prompt, dashscope_api_key)
        import re
        jm = re.search(r'\{[\s\S]*\}', result.strip())
        if jm:
            data = json.loads(jm.group())
            return data
        return {"error": "AI 返回格式异常", "raw": result}
    except Exception as e:
        logger.error(f"AI 生成随堂提问失败: {e}")
        raise HTTPException(status_code=500, detail=f"AI 生成失败: {str(e)}")


@router.post("/ai/generate-bilingual", summary="AI 将板书转换为中英双语")
async def ai_generate_bilingual(request: Request):
    """双语板书：读取当前白板内容，生成中英双语对照文本"""
    user = get_current_user(request)
    if not _is_teacher_or_admin(user):
        raise HTTPException(status_code=403, detail="仅教师可使用")
    body = await request.json()
    room_id = body.get("room_id")
    subject = body.get("subject", "通用技术")
    if not room_id:
        raise HTTPException(status_code=400, detail="请提供房间 ID")

    dashscope_api_key, _ = get_api_keys(user["username"])
    if not dashscope_api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    snapshot_text = _get_snapshot_text(room_id)
    if not snapshot_text or snapshot_text == "白板当前为空":
        raise HTTPException(status_code=400, detail="白板当前为空，请先在白板上书写内容")

    from backend.prompts.whiteboard_ai import BILINGUAL_BOARD_PROMPT
    prompt = BILINGUAL_BOARD_PROMPT.format(snapshot_text=snapshot_text, subject=subject)

    try:
        from backend.api.ai_service import call_ai_sync
        result = call_ai_sync(prompt, dashscope_api_key)
        import re
        jm = re.search(r'\{[\s\S]*\}', result.strip())
        if jm:
            data = json.loads(jm.group())
            pairs = data.get("pairs", [])
            # 将双语对转为 TLDraw 形状
            shapes = []
            for i, pair in enumerate(pairs):
                base_y = pair.get("y", 80 + i * 80)
                base_x = pair.get("x", 50)
                # 中文矩形
                shapes.append({
                    "type": "geo",
                    "x": base_x,
                    "y": base_y,
                    "props": {
                        "geo": "rectangle",
                        "w": 320,
                        "h": 36,
                        "color": "#1890ff",
                        "fill": "#e6f7ff",
                        "text": pair.get("chinese", ""),
                        "fontSize": 15,
                        "fontWeight": "normal",
                        "textAlign": "middle",
                        "size": "m",
                    },
                })
                # 英文矩形（右侧对齐）
                shapes.append({
                    "type": "geo",
                    "x": base_x + 340,
                    "y": base_y,
                    "props": {
                        "geo": "rectangle",
                        "w": 320,
                        "h": 36,
                        "color": "#52c41a",
                        "fill": "#f6ffed",
                        "text": pair.get("english", ""),
                        "fontSize": 14,
                        "fontWeight": "normal",
                        "textAlign": "middle",
                        "size": "m",
                    },
                })
            return {"shapes": shapes, "title": "中英双语板书"}
        return {"shapes": [], "raw": result}
    except Exception as e:
        logger.error(f"AI 生成双语板书失败: {e}")
        raise HTTPException(status_code=500, detail=f"AI 生成双语板书失败: {str(e)}")


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
