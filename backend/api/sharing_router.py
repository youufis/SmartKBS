"""
共享资源 API 路由
管理员/教师共享 HTML 资源和下载文件，可按角色、年级、班级灵活设置共享范围
支持多选教师、多选年级、多选班级
"""
import asyncio
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.auth import is_admin, is_teacher
from backend.database import execute_query, execute_insert_update, execute_batch
from backend.logger import logger
from backend.api.config_router import get_config_value
from backend.config import STU_DIR, ROOT_DIR

router = APIRouter()


class ShareRequest(BaseModel):
    file_path: str
    file_name: str
    resource_type: str  # 'html' or 'download'
    share_scope: str = "all"  # 'all', 'teacher', 'staff', 'class'
    target_users: list[str] = []
    target_grades: list[str] = []
    target_classes: list[str] = []


def _list_to_csv(items: list[str]) -> str:
    """将列表转为逗号分隔字符串"""
    return ",".join(items)


def _build_url_path(owner: str, resource_type: str, file_path: str) -> str:
    """构建完整的 /api/files/ 访问路径（相对于 BASE_DIR）"""
    dir_name = "html" if resource_type == "html" else "downloads"
    if file_path.startswith(f"{owner}/{dir_name}/") or file_path.startswith(f"{STU_DIR}/{owner}/{dir_name}/"):
        return file_path
    return f"{owner}/{dir_name}/{file_path}"


_VALID_SCOPES = {"all", "teacher", "staff", "class"}


# ── 创建共享 ──

@router.post("/share")
async def share_resource(request: Request, body: ShareRequest):
    """共享一个资源，支持多选教师、多选年级/班级"""
    user = get_current_user(request)
    username = user["username"]
    role = user["role"]

    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅管理员和教师可以共享资源")

    if body.resource_type not in ("html", "download"):
        raise HTTPException(status_code=400, detail="resource_type 必须是 html 或 download")

    if body.share_scope not in _VALID_SCOPES:
        raise HTTPException(status_code=400, detail=f"无效的共享范围: {body.share_scope}")

    # 权限校验
    if role == 1:  # 教师
        if body.share_scope == "all":
            raise HTTPException(status_code=403, detail="教师不能选择「所有人」范围")
        if body.share_scope == "class":
            rows = execute_query(
                "SELECT grade, class FROM users WHERE username=?",
                (username,),
            )
            if rows:
                allowed_grade = rows[0][0] or ""
                for g in body.target_grades:
                    if g != allowed_grade:
                        raise HTTPException(status_code=403, detail="教师只能共享给自己所在年级")

    # 将数组转为逗号分隔字符串存储
    target_users_csv = _list_to_csv(body.target_users)
    target_grades_csv = _list_to_csv(body.target_grades)
    target_classes_csv = _list_to_csv(body.target_classes)

    # 如果是教师 scope='class' 但未指定，自动填充教师的年级/班级
    if role == 1 and body.share_scope == 'class' and not target_grades_csv and not target_classes_csv:
        rows = execute_query(
            "SELECT grade, class FROM users WHERE username=?",
            (username,),
        )
        if rows:
            target_grades_csv = rows[0][0] or ""
            target_classes_csv = rows[0][1] or ""

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    try:
        execute_insert_update(
            """INSERT OR REPLACE INTO shared_resources
               (owner_username, file_path, file_name, resource_type, share_scope,
                target_users, target_grade, target_class, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (username, body.file_path, body.file_name, body.resource_type,
             body.share_scope, target_users_csv, target_grades_csv, target_classes_csv, now, now),
        )
        logger.info(f"共享创建成功: {username} -> {body.file_path} (scope={body.share_scope})")

        # ── 后台批量发送通知（不阻塞共享操作） ──
        def _send_notifications_sync():
            """同步执行通知发送，在后台线程中运行"""
            try:
                # 检查分享通知类型是否启用
                enabled = set(get_config_value("enabled_notification_types", ["exam"]))
                if "share" not in enabled:
                    return
                resource_label = "HTML 资源" if body.resource_type == "html" else "下载文件"
                now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                # 确定收件人列表
                recipients: list[str] = []
                link = "/html-files" if body.resource_type == "html" else "/downloads"
                title = f"新的{resource_label}已分享"
                content = ""
                if body.share_scope == "all":
                    rows = execute_query("SELECT username FROM users WHERE role IN (1, 2)")
                    recipients = [r[0] for r in rows]
                    content = f"{username} 分享了「{body.file_name}」"
                elif body.share_scope == "staff":
                    rows = execute_query("SELECT username FROM users WHERE role IN (0, 1)")
                    recipients = [r[0] for r in rows]
                    content = f"{username} 分享了「{body.file_name}」（教师共享）"
                elif body.share_scope == "teacher" and body.target_users:
                    recipients = body.target_users
                    content = f"{username} 分享了「{body.file_name}」给您"
                elif body.share_scope == "class":
                    conds, params = ["role = 2"], []
                    if body.target_grades:
                        ph = ",".join(["?"] * len(body.target_grades))
                        conds.append(f"grade IN ({ph})")
                        params.extend(body.target_grades)
                    if body.target_classes:
                        ph = ",".join(["?"] * len(body.target_classes))
                        conds.append(f"class IN ({ph})")
                        params.extend(body.target_classes)
                    if conds:
                        rows = execute_query(
                            f"SELECT username FROM users WHERE {' AND '.join(conds)}", tuple(params))
                        recipients = [r[0] for r in rows]
                    content = f"「{body.file_name}」可供您所在班级使用"

                # 批量插入通知（单条 SQL 替代逐条循环）
                if recipients:
                    sql = """INSERT INTO notifications
                             (recipient_username, type, title, content, related_link, is_read, created_at)
                             VALUES (?, 'share', ?, ?, ?, 0, ?)"""
                    ops = [(sql, (r, title, content, link, now)) for r in recipients]
                    execute_batch(ops)
                    logger.info(f"已发送 {len(recipients)} 条共享通知")
            except Exception as notify_err:
                logger.warning(f"发送共享通知失败: {notify_err}")

        # 在线程池中运行，不阻塞事件循环
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _send_notifications_sync)

        return {"message": "共享成功", "file_path": body.file_path}
    except Exception as e:
        logger.error(f"共享创建失败: {e}")
        raise HTTPException(status_code=500, detail=f"共享失败: {str(e)}")


# ── 取消共享 ──

@router.delete("/share")
async def unshare_resource(request: Request, id: int = Query(...)):
    """取消共享（含通知）"""
    user = get_current_user(request)
    username = user["username"]
    role = user["role"]

    # 在删除前查出完整的共享信息（用于后续通知）
    rows = execute_query(
        """SELECT owner_username, file_path, file_name, resource_type,
                  share_scope, target_users, target_grade, target_class
           FROM shared_resources WHERE id=?""",
        (id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="共享记录不存在")

    (owner, file_path, file_name, resource_type,
     share_scope, target_users_csv, target_grade_csv, target_class_csv) = rows[0]

    if username != owner and role != 0:
        raise HTTPException(status_code=403, detail="无权取消此共享")

    try:
        execute_insert_update(
            "DELETE FROM shared_resources WHERE id=?",
            (id,),
        )
        logger.info(f"共享已取消: id={id}, by={username}")

        # ── 后台发送取消通知（不阻塞取消操作） ──
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _notify_unshare_sync,
            owner, file_name, resource_type,
            share_scope, target_users_csv,
            target_grade_csv, target_class_csv)

        return {"message": "共享已取消"}
    except Exception as e:
        logger.error(f"取消共享失败: {e}")
        raise HTTPException(status_code=500, detail=f"取消共享失败: {str(e)}")


def _notify_unshare_sync(owner: str, file_name: str, resource_type: str,
                          share_scope: str, target_users_csv: str,
                          target_grade_csv: str, target_class_csv: str):
    """同步发送取消共享通知，在后台线程中运行"""
    try:
        enabled = set(get_config_value("enabled_notification_types", ["exam"]))
        if "share" not in enabled:
            return
        resource_label = "HTML 资源" if resource_type == "html" else "下载文件"
        link = "/html-files" if resource_type == "html" else "/downloads"
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        target_users = [u for u in target_users_csv.split(",") if u] if target_users_csv else []
        target_grades = [g for g in target_grade_csv.split(",") if g] if target_grade_csv else []
        target_classes = [c for c in target_class_csv.split(",") if c] if target_class_csv else []

        recipients: list[str] = []
        title = f"{resource_label}共享已取消"
        content = ""
        if share_scope == "all":
            rows = execute_query("SELECT username FROM users WHERE role IN (1, 2)")
            recipients = [r[0] for r in rows]
            content = f"{owner} 已取消对「{file_name}」的共享"
        elif share_scope == "staff":
            rows = execute_query("SELECT username FROM users WHERE role IN (0, 1)")
            recipients = [r[0] for r in rows]
            content = f"{owner} 已取消对「{file_name}」的共享（教师共享）"
        elif share_scope == "teacher" and target_users:
            recipients = target_users
            content = f"{owner} 已取消对「{file_name}」的共享"
        elif share_scope == "class":
            conds, params = ["role = 2"], []
            if target_grades:
                ph = ",".join(["?"] * len(target_grades))
                conds.append(f"grade IN ({ph})")
                params.extend(target_grades)
            if target_classes:
                ph = ",".join(["?"] * len(target_classes))
                conds.append(f"class IN ({ph})")
                params.extend(target_classes)
            if conds:
                rows = execute_query(
                    f"SELECT username FROM users WHERE {' AND '.join(conds)}", tuple(params))
                recipients = [r[0] for r in rows]
            content = f"「{file_name}」已不再对您所在班级共享"

        if recipients:
            sql = """INSERT INTO notifications
                     (recipient_username, type, title, content, related_link, is_read, created_at)
                     VALUES (?, 'share', ?, ?, ?, 0, ?)"""
            ops = [(sql, (r, title, content, link, now)) for r in recipients]
            execute_batch(ops)
            logger.info(f"已发送 {len(recipients)} 条取消共享通知")
    except Exception as e:
        logger.warning(f"发送取消共享通知失败: {e}")


# ── 我创建的共享 ──

@router.get("/my-shares")
async def my_shares(request: Request):
    """获取我创建的共享列表"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        """SELECT id, file_path, file_name, resource_type, share_scope,
                  target_users, target_grade, target_class, created_at
           FROM shared_resources WHERE owner_username=?
           ORDER BY created_at DESC""",
        (username,),
    )

    return {
        "shares": [
            {
                "id": r[0],
                "file_path": r[1],
                "file_name": r[2],
                "resource_type": r[3],
                "share_scope": r[4],
                "target_users": r[5] or "",
                "target_grade": r[6] or "",
                "target_class": r[7] or "",
                "created_at": r[8],
                "url_path": _build_url_path(username, r[3], r[1]),
            }
            for r in rows
        ]
    }


# ── 收到的共享（给当前用户可见的共享） ──

@router.get("/received")
async def received_shares(request: Request):
    """获取共享给当前用户的资源（按角色、年级、班级、指定用户过滤）"""
    user = get_current_user(request)
    username = user["username"]
    role = user["role"]

    # 构建可见条件：
    #   scope='all'       → 所有人可见
    #   scope='staff'     → 管理员(role=0)和教师(role=1)可见
    #   scope='teacher'   → 在 target_users 列表中的用户可见（若同时有 grade/class，也匹配学生）
    #   scope='class'     → 仅匹配年级/班级的学生可见（管理员/教师不通过此范围看到）
    seen_conditions = ["s.share_scope='all'"]
    if role in (0, 1):
        seen_conditions.append("s.share_scope='staff'")
    # scope='teacher' → target_users 精确匹配（仅被选中的用户可见，不含空匹配）
    seen_conditions.append(
        f"(s.share_scope='teacher' AND s.target_users!=''"
        f" AND ',' || s.target_users || ',' LIKE '%,' || '{username}' || ',%')"
    )

    if role == 2:
        # 学生：匹配 scope='class'（target_grade 必填，target_class 可选）
        # 或 scope='teacher' 含班级的组合共享（target_grade 和 target_class 都必须非空）
        seen_conditions.append(
            """(s.share_scope='class'
                AND s.target_grade != ''
                AND (s.target_grade=u.grade
                     OR ',' || s.target_grade || ',' LIKE '%,' || CAST(u.grade AS TEXT) || ',%')
                AND (s.target_class='' OR s.target_class=u.class
                     OR ',' || s.target_class || ',' LIKE '%,' || CAST(u.class AS TEXT) || ',%'))"""
        )
        seen_conditions.append(
            """(s.share_scope='teacher' AND s.target_grade != '' AND s.target_class != ''
                AND (s.target_grade=u.grade
                     OR ',' || s.target_grade || ',' LIKE '%,' || CAST(u.grade AS TEXT) || ',%')
                AND (s.target_class=u.class
                     OR ',' || s.target_class || ',' LIKE '%,' || CAST(u.class AS TEXT) || ',%'))"""
        )

    where_clause = " OR ".join(seen_conditions)

    if role == 2:
        rows = execute_query(
            f"""SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                       s.share_scope, s.target_users, s.target_grade, s.target_class, s.created_at
                FROM shared_resources s
                LEFT JOIN users u ON u.username=?
                WHERE {where_clause}
                ORDER BY s.created_at DESC""",
            (username,),
        )
    else:
        rows = execute_query(
            f"""SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                       s.share_scope, s.target_users, s.target_grade, s.target_class, s.created_at
                FROM shared_resources s
                WHERE {where_clause}
                ORDER BY s.created_at DESC""",
        )

    return {
        "shares": [
            {
                "id": r[0],
                "owner_username": r[1],
                "file_path": r[2],
                "file_name": r[3],
                "resource_type": r[4],
                "share_scope": r[5],
                "target_users": r[6] or "",
                "target_grade": r[7] or "",
                "target_class": r[8] or "",
                "created_at": r[9],
                "url_path": _build_url_path(r[1], r[4], r[2]),
            }
            for r in rows
        ]
    }


# ── 通用：检查文件是否对用户可见（供 serve_static_file 调用） ──

def is_file_shared_with_user(file_rel_path: str, resource_type: str,
                             owner_username: str, viewer_username: str) -> bool:
    """检查一个文件是否通过共享对当前用户可见"""
    if not viewer_username:
        return False

    rows = execute_query(
        """SELECT s.share_scope, s.target_users, s.target_grade, s.target_class
           FROM shared_resources s
           WHERE s.owner_username=? AND s.file_path=? AND s.resource_type=?""",
        (owner_username, file_rel_path, resource_type),
    )
    if not rows:
        return False

    share_scope, target_users, target_grade, target_class = rows[0]

    # scope='all'：所有人可见
    if share_scope == 'all':
        return True

    viewer_rows = execute_query(
        "SELECT grade, class, role FROM users WHERE username=?",
        (viewer_username,),
    )
    if not viewer_rows:
        return False

    viewer_role = viewer_rows[0][2]

    # scope='staff'：管理员和教师可见
    if share_scope == 'staff':
        return viewer_role in (0, 1)

    # scope='teacher'：检查是否在 target_users 列表中，或者匹配年级/班级（组合共享）
    if share_scope == 'teacher':
        # 检查是否在 target_users 中
        if target_users and (
            viewer_username == target_users
            or f',{target_users},'.find(f',{viewer_username},') != -1
        ):
            return True
        # 如果同时指定了年级/班级，也匹配学生（需要 grade 和 class 都非空）
        if viewer_role == 2 and target_grade and target_class:
            viewer_grade = str(viewer_rows[0][0] or "")
            viewer_class = str(viewer_rows[0][1] or "")
            grade_ok = (
                viewer_grade == target_grade
                or f',{target_grade},'.find(f',{viewer_grade},') != -1
            )
            if not grade_ok:
                return False
            class_ok = not target_class or (
                viewer_class == target_class
                or f',{target_class},'.find(f',{viewer_class},') != -1
            )
            return class_ok
        return False

    # scope='class'：需要年级/班级匹配（target_grade 必须非空）
    if viewer_role in (0, 1):
        return False
    if not target_grade:
        return False

    viewer_grade = str(viewer_rows[0][0] or "")
    viewer_class = str(viewer_rows[0][1] or "")

    grade_ok = (
        viewer_grade == target_grade
        or f',{target_grade},'.find(f',{viewer_grade},') != -1
    )
    if not grade_ok:
        return False

    class_ok = not target_class or (
        viewer_class == target_class
        or f',{target_class},'.find(f',{viewer_class},') != -1
    )
    return class_ok
