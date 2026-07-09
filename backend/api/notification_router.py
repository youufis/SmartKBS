"""
通知消息与公告系统 API 路由
提供用户通知的增删改查和公告管理
"""
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.database import execute_query, execute_insert_update, execute_batch, execute_query_dict
from backend.utils import extract_json_from_text
from backend.api.config_router import get_config_value
from backend.api.dependencies import get_current_user
from backend.auth import is_admin
from backend.logger import logger
from backend.permission_service import get_students_by_scope, filter_activities_by_scope

router = APIRouter()


# ── 请求模型 ──

class AnnouncementCreate(BaseModel):
    """创建公告请求"""
    title: str
    content: str
    target_role: str = "all"
    target_grade: str = ""
    target_class: str = ""
    target_scope: str = "teacher_classes"
    target_users: str = ""
    priority: str = "normal"
    is_pinned: bool = False


class AnnouncementUpdate(BaseModel):
    """更新公告请求"""
    title: str | None = None
    content: str | None = None
    target_role: str | None = None
    target_grade: str | None = None
    target_class: str | None = None
    target_scope: str | None = None
    target_users: str | None = None
    priority: str | None = None
    is_pinned: bool | None = None

class AiGenerateAnnouncement(BaseModel):
    """AI 生成公告请求"""
    topic: str
    target_role: str = "all"
    priority: str = "normal"
    target_grade: str = ""
    target_class: str = ""

# ── 辅助函数 ──

# ── 通知类型黑白名单 ──

def _get_enabled_notification_types() -> set[str]:
    """获取系统当前启用的通知类型，默认启用考试和系统通知"""
    types = get_config_value("enabled_notification_types", ["exam", "system"])
    return set(types)


def _is_notification_type_enabled(type_: str) -> bool:
    """判断某通知类型是否被系统启用"""
    enabled = _get_enabled_notification_types()
    return type_ in enabled


def create_notification(recipient: str, type_: str, title: str, content: str = "", related_link: str = "",
                        source_type: str = "", source_id: str = ""):
    """创建一条通知（内部调用，会检查类型是否启用）"""
    if not _is_notification_type_enabled(type_):
        return
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        execute_insert_update(
            """INSERT INTO notifications (recipient_username, type, title, content, related_link, is_read, created_at, source_type, source_id)
               VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)""",
            (recipient, type_, title, content, related_link, now, source_type, source_id),
        )
    except Exception as e:
        logger.error(f"创建通知失败: {e}")


def notify_users(usernames: list[str], type_: str, title: str, content: str = "", related_link: str = "",
                 source_type: str = "", source_id: str = ""):
    """批量通知多个用户（使用批量插入优化性能，会检查类型是否启用）"""
    if not usernames:
        return
    if not _is_notification_type_enabled(type_):
        return
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sql = """INSERT INTO notifications
             (recipient_username, type, title, content, related_link, is_read, created_at, source_type, source_id)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)"""
    try:
        ops = [(sql, (r, type_, title, content, related_link, now, source_type, source_id)) for r in usernames]
        execute_batch(ops)
    except Exception as e:
        logger.error(f"批量创建通知失败: {e}")


def notify_users_by_scope(
    creator_username: str,
    type_: str,
    title: str,
    content: str = "",
    related_link: str = "",
    target_scope: str = "teacher_classes",
    target_grade: str = "",
    target_class: str = "",
    target_users: str = "",
    source_type: str = "",
    source_id: str = "",
):
    """
    根据目标范围参数向对应的学生发送通知
    复用 permission_service.get_students_by_scope 获取目标学生列表
    """
    students = get_students_by_scope(
        creator_username,
        target_scope=target_scope,
        target_grade=target_grade,
        target_class=target_class,
        target_users=target_users,
    )
    if not students:
        logger.info(f"通知按范围发送: 目标范围={target_scope}, 无匹配学生, 跳过通知")
        return

    usernames = [s["username"] for s in students]
    notify_users(usernames, type_, title, content, related_link, source_type=source_type, source_id=source_id)


# ── 通知 API ──

@router.get("", summary="获取我的通知列表")
async def list_notifications(
    request: Request,
    unread_only: bool = Query(False, description="仅未读"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """获取当前用户的通知列表"""
    user = get_current_user(request)
    username = user["username"]

    conditions = ["recipient_username = ?"]
    params = [username]

    if unread_only:
        conditions.append("is_read = 0")

    where = " AND ".join(conditions)

    # 总数
    count_result = execute_query(
        f"SELECT COUNT(*) FROM notifications WHERE {where}", tuple(params)
    )
    total = count_result[0][0] if count_result else 0

    # 列表
    offset = (page - 1) * page_size
    rows = execute_query(
        f"""SELECT id, type, title, content, related_link, is_read, created_at
            FROM notifications WHERE {where}
            ORDER BY created_at DESC LIMIT ? OFFSET ?""",
        tuple(params + [page_size, offset]),
    )

    notifications = []
    for r in rows:
        notifications.append({
            "id": r[0],
            "type": r[1],
            "title": r[2],
            "content": r[3],
            "related_link": r[4],
            "is_read": bool(r[5]),
            "created_at": r[6],
        })

    return {
        "notifications": notifications,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/unread-count", summary="获取未读通知数量")
async def unread_count(request: Request):
    """获取当前用户未读通知数量"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        "SELECT COUNT(*) FROM notifications WHERE recipient_username = ? AND is_read = 0",
        (username,),
    )
    count = rows[0][0] if rows else 0
    return {"unread_count": count}


@router.put("/{notification_id}/read", summary="标记通知为已读")
async def mark_read(notification_id: int, request: Request):
    """标记单条通知为已读"""
    user = get_current_user(request)
    username = user["username"]

    from backend.database import get_connection
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(
            "UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_username = ?",
            (notification_id, username),
        )
        conn.commit()
        affected = c.rowcount

    logger.info(f"标记通知已读: id={notification_id}, username={username}, affected={affected}")
    if affected == 0:
        logger.warning(f"标记已读未找到通知: id={notification_id}, username={username}")

    return {"message": "已标记为已读"}


@router.put("/read-all", summary="标记所有通知为已读")
async def mark_all_read(request: Request):
    """标记当前用户所有通知为已读"""
    user = get_current_user(request)
    username = user["username"]

    execute_insert_update(
        "UPDATE notifications SET is_read = 1 WHERE recipient_username = ? AND is_read = 0",
        (username,),
    )
    return {"message": "全部标记为已读"}


@router.delete("/{notification_id}", summary="删除通知")
async def delete_notification(notification_id: int, request: Request):
    """删除一条通知"""
    user = get_current_user(request)
    username = user["username"]

    execute_insert_update(
        "DELETE FROM notifications WHERE id = ? AND recipient_username = ?",
        (notification_id, username),
    )
    return {"message": "通知已删除"}


# ── 公告 API（管理员/教师）──

@router.post("/announcements/ai-generate", summary="AI 自动生成公告")
async def ai_generate_announcement(req: AiGenerateAnnouncement, request: Request):
    """AI 根据主题自动生成公告内容"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    role_desc = {"all": "全体用户", "teacher": "教师", "student": "学生"}.get(req.target_role, "全体用户")
    priority_desc = {"normal": "普通", "important": "重要", "urgent": "紧急", "low": "低"}.get(req.priority, "普通")

    prompt = f"""你是一位学校管理员。请根据以下要求撰写一份系统公告。

主题：{req.topic}
发布范围：{role_desc}
优先级：{priority_desc}
适用年级：{req.target_grade or '不限'}
适用班级：{req.target_class or '不限'}

请按以下 JSON 格式输出，不要包含其他文字：
{{
  "title": "公告标题（简洁醒目）",
  "content": "公告正文（支持 Markdown 格式，包括背景说明、具体内容和注意事项，200字以内）"
}}
"""

    import json
    from backend.api.chat_router import get_api_keys
    api_key, _ = get_api_keys(user["username"])
    if not api_key:
        return {"status": "error", "content": "AI 功能不可用：请配置 API Key"}

    from backend.prompts import apply_skills
    from backend.api.ai_service import call_ai_async
    from backend.ai_task_manager import task_manager

    async def _do_generate() -> dict[str, Any]:
        try:
            prompt = apply_skills(prompt, "notification")
            result = await call_ai_async(prompt, api_key)
            if result:
                data = extract_json_from_text(result)
                if data:
                    return {"status": "ok", "data": data, "raw": result}
                return {"status": "error", "content": result}
            return {"status": "error", "content": "AI 未返回有效结果"}
        except Exception as e:
            logger.warning(f"AI 生成公告失败: {e}")
            return {"status": "error", "content": f"AI 调用出错: {str(e)}"}

    task_id = await task_manager.create_task(description="AI 生成公告", coro_factory=_do_generate)
    return {"task_id": task_id, "message": "AI 生成已提交，请稍后查询结果"}


@router.post("/announcements", summary="发布公告")
async def create_announcement(req: AnnouncementCreate, request: Request):
    """创建公告（管理员/教师）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    announcement_id = execute_insert_update(
        """INSERT INTO announcements
           (creator_username, title, content, target_role, target_grade, target_class,
            target_scope, target_users, priority, is_pinned, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (username, req.title, req.content, req.target_role, req.target_grade, req.target_class,
         req.target_scope, req.target_users, req.priority, 1 if req.is_pinned else 0, now, now),
    )

    logger.info(f"用户 {username} 发布公告: {req.title}")
    return {"message": "公告发布成功", "announcement_id": announcement_id}


@router.get("/announcements", summary="获取公告列表")
async def list_announcements(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """获取对当前用户可见的公告列表"""
    user = get_current_user(request)
    role = user.get("role", 2)
    user_info = execute_query(
        "SELECT grade, class FROM users WHERE username = ?",
        (user["username"],),
    )
    user_grade = user_info[0][0] if user_info else ""
    user_class = user_info[0][1] if user_info else ""

    # 根据不同角色，用不同的 SQL 查询可见公告
    # 先获取 total 总数
    total = 0

    if role == 0:
        # 管理员：全部可见
        count_result = execute_query("SELECT COUNT(*) FROM announcements")
        total = count_result[0][0] if count_result else 0
        rows = execute_query(
            """SELECT id, creator_username, title, content, target_role, target_grade, target_class,
                      priority, is_pinned, created_at, updated_at
               FROM announcements
               ORDER BY is_pinned DESC, created_at DESC
               LIMIT ? OFFSET ?""",
            (page_size, (page - 1) * page_size),
        )
    elif role == 1:
        # 教师：仅查看自己发布的公告
        count_result = execute_query(
            "SELECT COUNT(*) FROM announcements WHERE creator_username=?", (user["username"],)
        )
        total = count_result[0][0] if count_result else 0
        rows = execute_query(
            """SELECT id, creator_username, title, content, target_role, target_grade, target_class,
                      priority, is_pinned, created_at, updated_at
               FROM announcements WHERE creator_username=?
               ORDER BY is_pinned DESC, created_at DESC
               LIMIT ? OFFSET ?""",
            (user["username"], page_size, (page - 1) * page_size),
        )
    else:
        # 学生：管理员公告 + 匹配班级的教师公告，再按 target_scope 过滤
        admin_names = [r[0] for r in execute_query("SELECT username FROM users WHERE role=0")]
        teacher_rows = execute_query(
            """SELECT DISTINCT ta.teacher_username FROM teacher_assignments ta
               JOIN users u ON u.grade_id = ta.grade_id
               WHERE u.username = ?
               AND (ta.class_id IS NULL OR ta.class_id = u.class_id)""",
            (user["username"],),
        )
        teacher_names = [r[0] for r in teacher_rows]

        all_creator_names = admin_names + teacher_names
        if all_creator_names:
            placeholders = ",".join("?" for _ in all_creator_names)
            # 总数
            count_result = execute_query(
                f"SELECT COUNT(*) FROM announcements WHERE creator_username IN ({placeholders})",
                tuple(all_creator_names),
            )
            total = count_result[0][0] if count_result else 0
            offset = (page - 1) * page_size
            all_rows = execute_query(
                f"""SELECT id, creator_username, title, content, target_role,
                           target_grade, target_class, priority, is_pinned,
                           created_at, updated_at, target_scope, target_users
                   FROM announcements
                   WHERE creator_username IN ({placeholders})
                   ORDER BY is_pinned DESC, created_at DESC
                   LIMIT ? OFFSET ?""",
                tuple(all_creator_names + [page_size, offset]),
            )
        else:
            all_rows = []

        announcements = []
        for r in all_rows:
            creator_name_row = execute_query(
                "SELECT COALESCE(NULLIF(name, ''), username) FROM users WHERE username = ?", (r[1],)
            )
            creator_name = creator_name_row[0][0] if creator_name_row else r[1]
            announcements.append({
                "id": r[0],
                "creator_username": r[1],
                "creator_name": creator_name,
                "title": r[2],
                "content": r[3],
                "target_role": r[4],
                "target_grade": r[5] or "",
                "target_class": r[6] or "",
                "priority": r[7],
                "is_pinned": bool(r[8]),
                "created_at": r[9],
                "updated_at": r[10],
                "target_scope": r[11] if len(r) > 11 else "teacher_classes",
                "target_users": r[12] if len(r) > 12 else "",
            })

        # 按目标范围过滤
        announcements = filter_activities_by_scope(announcements, user["username"])

        # 内存分页
        total = len(announcements)
        offset = (page - 1) * page_size
        announcements = announcements[offset:offset + page_size]

        return {
            "announcements": announcements,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    announcements = []
    for r in rows:
        # 查询创建者姓名（name 为空时显示 username）
        creator_name_row = execute_query(
            "SELECT COALESCE(NULLIF(name, ''), username) FROM users WHERE username = ?", (r[1],)
        )
        creator_name = creator_name_row[0][0] if creator_name_row else r[1]

        announcements.append({
            "id": r[0],
            "creator_username": r[1],
            "creator_name": creator_name,
            "title": r[2],
            "content": r[3],
            "target_role": r[4],
            "target_grade": r[5] or "",
            "target_class": r[6] or "",
            "priority": r[7],
            "is_pinned": bool(r[8]),
            "created_at": r[9],
            "updated_at": r[10],
        })

    return {
        "announcements": announcements,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.put("/announcements/{announcement_id}", summary="更新公告")
async def update_announcement(announcement_id: int, req: AnnouncementUpdate, request: Request):
    """更新公告（管理员/教师）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    # 检查是否为创建者或管理员
    if role == 1:
        ann = execute_query(
            "SELECT creator_username FROM announcements WHERE id = ?",
            (announcement_id,),
        )
        if not ann or ann[0][0] != username:
            raise HTTPException(status_code=403, detail="无权修改此公告")

    updates = []
    params = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for field, value in req.model_dump(exclude_none=True).items():
        if field == "is_pinned":
            updates.append(f"{field} = ?")
            params.append(1 if value else 0)
        else:
            updates.append(f"{field} = ?")
            params.append(value)

    if updates:
        updates.append("updated_at = ?")
        params.append(now)
        params.append(announcement_id)
        execute_insert_update(
            f"UPDATE announcements SET {', '.join(updates)} WHERE id = ?",
            tuple(params),
        )

    return {"message": "公告已更新"}


@router.delete("/announcements/{announcement_id}", summary="删除公告")
async def delete_announcement(announcement_id: int, request: Request):
    """删除公告（管理员/创建者）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 0:
        execute_insert_update("DELETE FROM announcements WHERE id = ?", (announcement_id,))
    elif role == 1:
        execute_insert_update(
            "DELETE FROM announcements WHERE id = ? AND creator_username = ?",
            (announcement_id, username),
        )
    else:
        raise HTTPException(status_code=403, detail="权限不足")

    return {"message": "公告已删除"}
