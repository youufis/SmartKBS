"""
共享资源 API 路由
管理员/教师共享 HTML 资源和下载文件，可按角色、年级、班级灵活设置共享范围
支持多选教师、多选年级、多选班级
"""
import asyncio
import os
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.auth import ROLE_ADMIN, ROLE_TEACHER, ROLE_STUDENT
from backend.database import execute_query, execute_insert_update, execute_batch
from backend.logger import logger
from backend.api.config_router import get_config_value
from backend.config import STU_DIR, ROOT_DIR, BASE_DIR
from backend.permission_service import check_share_visibility

router = APIRouter()


class ShareRequest(BaseModel):
    file_path: str
    file_name: str
    resource_type: str  # 'html' or 'download'
    share_scope: str = "all"  # 'all', 'teacher', 'staff', 'class'
    target_users: list[str] = []
    target_grades: list[str] = []
    target_classes: list[str] = []
    mode: str = "replace"  # 'replace' 覆盖 / 'append' 追加 / 'remove' 移除



def _list_to_csv(items: list[str]) -> str:
    """将列表转为逗号分隔字符串"""
    return ",".join(items)


def _build_url_path(owner: str, resource_type: str, file_path: str) -> str:
    """构建完整的 /api/files/ 访问路径（相对于 BASE_DIR）"""
    dir_name = "html" if resource_type == "html" else "downloads"
    if file_path.startswith(f"{owner}/{dir_name}/") or file_path.startswith(f"{STU_DIR}/{owner}/{dir_name}/"):
        return file_path
    return f"{owner}/{dir_name}/{file_path}"


def cleanup_empty_dir_shares(owner_username: str | None = None):
    """清理不存在的空目录的共享记录

    目录共享是指共享目录下的所有文件。如果目录不存在或为空，
    则该共享记录无意义，应自动清除。

    如果指定 owner_username，只清理该用户的记录。
    """
    dir_name_map = {"download": "downloads", "html": "html"}
    try:
        cond = "WHERE resource_type='download'"
        params = []
        if owner_username:
            cond += " AND owner_username=?"
            params.append(owner_username)

        rows = execute_query(
            f"SELECT id, owner_username, file_path, resource_type FROM shared_resources {cond}",
            tuple(params),
        )
        removed = 0
        for rid, owner, file_path, res_type in rows:
            # 判断是否为目录共享：路径以 / 结尾，或者路径中不含扩展名
            last_part = file_path.rstrip("/").split("/")[-1]
            is_dir = file_path.endswith("/") or "." not in last_part
            if not is_dir:
                continue
            dir_name = dir_name_map.get(res_type, "downloads")
            clean_path = file_path.strip("/")
            full_dir = os.path.join(str(BASE_DIR), owner, dir_name, clean_path)
            if not os.path.isdir(full_dir) or not os.listdir(full_dir):
                # 清理关联的课程绑定
                try:
                    execute_insert_update(
                        "DELETE FROM curriculum_bindings WHERE resource_type=? AND resource_id=?",
                        (res_type, rid),
                    )
                except Exception:
                    pass
                execute_insert_update("DELETE FROM shared_resources WHERE id=?", (rid,))
                removed += 1
                logger.info(f"自动清理空目录共享: id={rid}, owner={owner}, path={file_path}")
        if removed:
            logger.info(f"共清理 {removed} 条空目录共享记录")
    except Exception as e:
        logger.warning(f"清理空目录共享时出错: {e}")


_VALID_SCOPES = {"all", "teacher", "staff", "class"}


# ── 创建共享 ──

@router.post("/share")
async def share_resource(request: Request, body: ShareRequest):
    """共享一个资源，支持多选教师、多选年级/班级"""
    user = get_current_user(request)
    username = user["username"]
    role = user["role"]

    if role not in (ROLE_ADMIN, ROLE_TEACHER):
        raise HTTPException(status_code=403, detail="仅管理员和教师可以共享资源")

    if body.resource_type not in ("html", "download"):
        raise HTTPException(status_code=400, detail="resource_type 必须是 html 或 download")

    if body.share_scope not in _VALID_SCOPES:
        raise HTTPException(status_code=400, detail=f"无效的共享范围: {body.share_scope}")

    if body.mode not in ("replace", "append", "remove"):
        raise HTTPException(status_code=400, detail=f"无效的操作模式: {body.mode}，必须为 replace/append/remove")

    # 参数完整性校验
    if body.share_scope == "class" and not body.target_grades:
        raise HTTPException(status_code=400, detail="指定年级/班级时必须至少选择一个年级")
    if body.share_scope == "teacher" and not body.target_users:
        raise HTTPException(status_code=400, detail="指定教师时必须至少选择一个用户")

    # 权限校验
    if role == ROLE_TEACHER:
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
    if role == ROLE_TEACHER and body.share_scope == 'class' and not target_grades_csv and not target_classes_csv:
        rows = execute_query(
            "SELECT grade, class FROM users WHERE username=?",
            (username,),
        )
        if rows:
            target_grades_csv = rows[0][0] or ""
            target_classes_csv = rows[0][1] or ""

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    try:
        if body.mode == "append":
            # 追加模式：合并现有目标
            existing = execute_query(
                """SELECT target_users, target_grade, target_class, share_scope
                   FROM shared_resources
                   WHERE owner_username=? AND file_path=? AND resource_type=?""",
                (username, body.file_path, body.resource_type),
            )
            if existing:
                exist_users = existing[0][0] or ""
                exist_grades = existing[0][1] or ""
                exist_classes = existing[0][2] or ""
                exist_scope = existing[0][3]

                # 合并目标用户
                merged_users = set(exist_users.split(",")) if exist_users else set()
                merged_users.update(body.target_users)
                merged_users.discard("")
                target_users_csv = _list_to_csv(sorted(merged_users))

                # 合并年级
                merged_grades = set(exist_grades.split(",")) if exist_grades else set()
                merged_grades.update(body.target_grades)
                merged_grades.discard("")
                target_grades_csv = _list_to_csv(sorted(merged_grades))

                # 合并班级
                merged_classes = set(exist_classes.split(",")) if exist_classes else set()
                merged_classes.update(body.target_classes)
                merged_classes.discard("")
                target_classes_csv = _list_to_csv(sorted(merged_classes))

                # 保留原来的 scope（追加不改变 scope）
                actual_scope = exist_scope
            else:
                actual_scope = body.share_scope
        elif body.mode == "remove":
            # 移除模式：从现有目标中移除指定项
            existing = execute_query(
                """SELECT target_users, target_grade, target_class, share_scope
                   FROM shared_resources
                   WHERE owner_username=? AND file_path=? AND resource_type=?""",
                (username, body.file_path, body.resource_type),
            )
            if not existing:
                raise HTTPException(status_code=404, detail="未找到现有共享记录，无法移除")

            exist_users = set(existing[0][0].split(",")) if existing[0][0] else set()
            exist_grades = set(existing[0][1].split(",")) if existing[0][1] else set()
            exist_classes = set(existing[0][2].split(",")) if existing[0][2] else set()
            actual_scope = existing[0][3]

            remove_users_set = set(body.target_users)
            remove_grades_set = set(body.target_grades)
            remove_classes_set = set(body.target_classes)

            merged_users = exist_users - remove_users_set
            merged_grades = exist_grades - remove_grades_set
            merged_classes = exist_classes - remove_classes_set

            merged_users.discard("")
            merged_grades.discard("")
            merged_classes.discard("")

            target_users_csv = _list_to_csv(sorted(merged_users))
            target_grades_csv = _list_to_csv(sorted(merged_grades))
            target_classes_csv = _list_to_csv(sorted(merged_classes))

            # 如果所有目标都被移除了，自动删除共享记录
            if not merged_users and not merged_grades and not merged_classes:
                execute_insert_update(
                    "DELETE FROM shared_resources WHERE owner_username=? AND file_path=? AND resource_type=?",
                    (username, body.file_path, body.resource_type),
                )
                logger.info(f"共享所有目标已移除，自动删除共享: {username} -> {body.file_path}")
                return {"message": "共享目标已全部移除，共享已取消", "file_path": body.file_path}
        else:
            # replace 模式（默认）：直接覆盖
            actual_scope = body.share_scope

        execute_insert_update(
            """INSERT OR REPLACE INTO shared_resources
               (owner_username, file_path, file_name, resource_type, share_scope,
                target_users, target_grade, target_class, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (username, body.file_path, body.file_name, body.resource_type,
             actual_scope, target_users_csv, target_grades_csv, target_classes_csv, now, now),
        )
        logger.info(f"共享创建成功: {username} -> {body.file_path} (scope={actual_scope})")

        # 共享后清理空目录共享记录（如果共享的是空目录，会自动删除）
        cleanup_empty_dir_shares(username)

        # ── 后台批量发送通知（仅 replace/新建时发送，追加/移除模式跳过） ──
        if body.mode != "append" and body.mode != "remove":
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
                        rows = execute_query("SELECT username FROM users WHERE role IN (0, 1, 2)")
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
                        # 通知目标年级/班级的学生（使用 class_id + classes.display_name 匹配）
                        _student_params: list[str] = []
                        if body.target_grades:
                            ph = ",".join(["?"] * len(body.target_grades))
                            grade_cond = f"u.grade IN ({ph})"
                            _student_params.extend(body.target_grades)
                        else:
                            grade_cond = "1=1"
                        class_cond = "1=1"
                        if body.target_classes:
                            ph = ",".join(["?"] * len(body.target_classes))
                            class_cond = (
                                f"(u.class_id IN (SELECT id FROM classes WHERE display_name IN ({ph}))"
                                f" OR u.class IN ({ph}))"
                            )
                            _student_params.extend(body.target_classes * 2)
                        if _student_params:
                            rows = execute_query(
                                f"""SELECT u.username FROM users u
                                    WHERE u.role=2 AND {grade_cond} AND {class_cond}""",
                                tuple(_student_params),
                            )
                            recipients = [r[0] for r in rows]
                        # 也通知任教这些年级/班级的教师和管理员（使用 class_id 匹配）
                        _t_params: list[str] = []
                        if body.target_grades:
                            ph = ",".join(["?"] * len(body.target_grades))
                            t_grade_cond = f"u.grade IN ({ph})"
                            _t_params.extend(body.target_grades)
                        else:
                            t_grade_cond = "1=1"
                        t_class_cond = "1=1"
                        if body.target_classes:
                            ph = ",".join(["?"] * len(body.target_classes))
                            t_class_cond = (
                                f"(u.class_id IN (SELECT id FROM classes WHERE display_name IN ({ph}))"
                                f" OR u.class IN ({ph}))"
                            )
                            _t_params.extend(body.target_classes * 2)
                        if _t_params:
                            t_rows = execute_query(
                                f"""SELECT u.username FROM users u
                                    WHERE u.role IN (0,1) AND {t_grade_cond} AND {t_class_cond}""",
                                tuple(_t_params),
                            )
                            for tr in t_rows:
                                if tr[0] not in recipients:
                                    recipients.append(tr[0])
                        content = f"「{body.file_name}」可供您所在班级使用"

                    # 批量插入通知
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

    if username != owner and role != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="无权取消此共享")

    try:
        execute_insert_update(
            "DELETE FROM shared_resources WHERE id=?",
            (id,),
        )
        logger.info(f"共享已取消: id={id}, by={username}")

        # 清理关联的课程绑定
        try:
            bind_rows = execute_query(
                "SELECT knowledge_point_id FROM curriculum_bindings WHERE resource_type=? AND resource_id=?",
                (resource_type, id),
            )
            if bind_rows:
                # 仅 HTML 资源（练习）需要清理学生作答记录
                if resource_type == "html":
                    kp_ids = [r["knowledge_point_id"] for r in bind_rows]
                    from backend.question_db import execute_insert as q_del
                    for kpid in kp_ids:
                        q_del("DELETE FROM ai_practice_results WHERE kp_id=?", (kpid,))
                # 清理绑定记录
                execute_insert_update(
                    "DELETE FROM curriculum_bindings WHERE resource_type=? AND resource_id=?",
                    (resource_type, id),
                )
                logger.info(f"已清理 {resource_type} 资源 id={id} 关联的 {len(bind_rows)} 个课程绑定")
        except Exception as e2:
            logger.warning(f"清理关联记录时出错: {e2}")

        # 清理资源查看日志
        try:
            execute_insert_update(
                "DELETE FROM resource_view_logs WHERE resource_type=? AND resource_id=?",
                (resource_type, id),
            )
            logger.info(f"已清理 resource_view_logs: type={resource_type}, id={id}")
        except Exception as e3:
            logger.warning(f"清理资源查看日志失败: {e3}")

        # 取消共享后清理空目录共享
        cleanup_empty_dir_shares(owner)

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
            rows = execute_query("SELECT username FROM users WHERE role IN (0, 1, 2)")
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
            # 通知目标年级/班级的学生（使用 class_id + classes.display_name 匹配）
            unshare_params: list[str] = []
            if target_grades:
                ph = ",".join(["?"] * len(target_grades))
                g_cond = f"u.grade IN ({ph})"
                unshare_params.extend(target_grades)
            else:
                g_cond = "1=1"
            c_cond = "1=1"
            if target_classes:
                ph = ",".join(["?"] * len(target_classes))
                c_cond = (
                    f"(u.class_id IN (SELECT id FROM classes WHERE display_name IN ({ph}))"
                    f" OR u.class IN ({ph}))"
                )
                unshare_params.extend(target_classes * 2)
            if unshare_params:
                rows = execute_query(
                    f"""SELECT u.username FROM users u
                        WHERE u.role=2 AND {g_cond} AND {c_cond}""",
                    tuple(unshare_params),
                )
                recipients = [r[0] for r in rows]
            # 也通知任教这些年级/班级的教师和管理员
            t_params: list[str] = []
            if target_grades:
                ph = ",".join(["?"] * len(target_grades))
                tg_cond = f"u.grade IN ({ph})"
                t_params.extend(target_grades)
            else:
                tg_cond = "1=1"
            tc_cond = "1=1"
            if target_classes:
                ph = ",".join(["?"] * len(target_classes))
                tc_cond = (
                    f"(u.class_id IN (SELECT id FROM classes WHERE display_name IN ({ph}))"
                    f" OR u.class IN ({ph}))"
                )
                t_params.extend(target_classes * 2)
            if t_params:
                t_rows = execute_query(
                    f"""SELECT u.username FROM users u
                        WHERE u.role IN (0,1) AND {tg_cond} AND {tc_cond}""",
                    tuple(t_params),
                )
                for tr in t_rows:
                    if tr[0] not in recipients:
                        recipients.append(tr[0])
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
    #   scope='teacher'   → 在 target_users 列表中，或匹配年级/班级
    #   scope='class'     → 学生按年级/班级匹配；管理员可见全部；教师按任教范围匹配
    seen_conditions = ["s.share_scope='all'"]
    if role in (ROLE_ADMIN, ROLE_TEACHER):
        seen_conditions.append("s.share_scope='staff'")
    # scope='teacher' → target_users 精确匹配（使用参数化查询防SQL注入）
    teacher_user_cond = (
        "(s.share_scope='teacher' AND s.target_users!=''"
        " AND (',' || s.target_users || ',') LIKE ('%,' || ? || ',%'))"
    )
    seen_conditions.append(teacher_user_cond)

    if role == ROLE_ADMIN:
        # 管理员：可见所有 class 范围共享
        seen_conditions.append("(s.share_scope='class' AND s.target_grade != '')")
        # 管理员也可见 teacher+grade/class 组合共享
        seen_conditions.append(
            """(s.share_scope='teacher' AND s.target_grade != '' AND s.target_class != '')"""
        )
    elif role == ROLE_TEACHER:
        # 教师：通过 teacher_assignments 匹配 class 范围共享
        seen_conditions.append(
            """(s.share_scope='class' AND s.target_grade != ''
                AND EXISTS (
                    SELECT 1 FROM teacher_assignments ta
                    JOIN grades g ON ta.grade_id = g.id
                    WHERE ta.teacher_username=?
                    AND (s.target_grade=g.name
                         OR ',' || s.target_grade || ',' LIKE '%,' || g.name || ',%')
                    AND (s.target_class='' OR EXISTS (
                        SELECT 1 FROM classes c
                        WHERE c.grade_id = g.id
                        AND (c.display_name=s.target_class
                             OR ',' || s.target_class || ',' LIKE '%,' || c.display_name || ',%')
                        AND (ta.class_id IS NULL OR ta.class_id = c.id)
                    ))
                )
            )"""
        )
        # 教师也可见 teacher+grade/class 组合共享（匹配任教范围）
        seen_conditions.append(
            """(s.share_scope='teacher' AND s.target_grade != '' AND s.target_class != ''
                AND EXISTS (
                    SELECT 1 FROM teacher_assignments ta
                    JOIN grades g ON ta.grade_id = g.id
                    JOIN classes c ON c.grade_id = g.id
                    WHERE ta.teacher_username=?
                    AND (s.target_grade=g.name
                         OR ',' || s.target_grade || ',' LIKE '%,' || g.name || ',%')
                    AND (s.target_class=c.display_name
                         OR ',' || s.target_class || ',' LIKE '%,' || c.display_name || ',%')
                    AND (ta.class_id IS NULL OR ta.class_id = c.id)
                )
            )"""
        )
    elif role == ROLE_STUDENT:
        # 学生：匹配 scope='class'（仅匹配年级，班级由 Python 层精确过滤）
        seen_conditions.append(
            """(s.share_scope='class'
                AND s.target_grade != ''
                AND (s.target_grade=u.grade
                     OR ',' || s.target_grade || ',' LIKE '%,' || CAST(u.grade AS TEXT) || ',%'))"""
        )
        # 学生：匹配 teacher+grade/class 组合共享（仅匹配年级，班级由 Python 层过滤）
        seen_conditions.append(
            """(s.share_scope='teacher' AND s.target_grade != '' AND s.target_class != ''
                AND (s.target_grade=u.grade
                     OR ',' || s.target_grade || ',' LIKE '%,' || CAST(u.grade AS TEXT) || ',%'))"""
        )

    where_clause = " OR ".join(seen_conditions)

    if role == ROLE_TEACHER:
        # 教师：需要额外参数用于 EXISTS 子查询 + teacher_user_cond 的 ?
        rows = execute_query(
            f"""SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                       s.share_scope, s.target_users, s.target_grade, s.target_class, s.created_at
                FROM shared_resources s
                WHERE {where_clause}
                ORDER BY s.created_at DESC""",
            (username, username, username),
        )
    elif role == ROLE_STUDENT:
        rows = execute_query(
            f"""SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                       s.share_scope, s.target_users, s.target_grade, s.target_class, s.created_at
                FROM shared_resources s
                LEFT JOIN users u ON u.username=?
                WHERE {where_clause}
                ORDER BY s.created_at DESC""",
            (username, username),
        )
    else:
        rows = execute_query(
            f"""SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                       s.share_scope, s.target_users, s.target_grade, s.target_class, s.created_at
                FROM shared_resources s
                WHERE {where_clause}
                ORDER BY s.created_at DESC""",
            (username,),
        )

    # 对所有角色的结果再做一次精确的 Python 层权限过滤
    # （弥补 SQL 复杂匹配因数据格式差异（如 "高一1班" vs "1"）可能存在的偏差）
    filtered = []
    for r in rows:
        row_data = (r[5], r[6] or "", r[7] or "", r[8] or "")
        if _check_share_scope(row_data, username):
            filtered.append(r)
    rows = filtered

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
    """检查一个文件是否通过共享对当前用户可见

    支持目录共享：如果文件的父目录被共享，该文件也对用户可见。
    """
    if not viewer_username:
        return False

    # 先尝试精确匹配（同时尝试带 / 和不带 / 的格式）
    # 数据库中目录共享的 file_path 可能以 / 结尾（如 "pics/"）
    # 但前端传入的 file_rel_path 可能不带 /（如 "pics"）
    candidates = [file_rel_path]
    if file_rel_path.endswith("/"):
        candidates.append(file_rel_path.rstrip("/"))
    else:
        candidates.append(file_rel_path + "/")

    for candidate in candidates:
        rows = execute_query(
            """SELECT s.share_scope, s.target_users, s.target_grade, s.target_class
               FROM shared_resources s
               WHERE s.owner_username=? AND s.file_path=? AND s.resource_type=?""",
            (owner_username, candidate, resource_type),
        )
        if rows:
            if _check_share_scope(rows[0], viewer_username):
                return True

    # 目录共享匹配：逐级向上检查父目录是否被共享
    # 例如 file_rel_path = "subdir/images/photo.png"
    # 检查 "subdir/images" 和 "subdir" 是否有共享记录
    parts = file_rel_path.strip("/").split("/")
    for i in range(len(parts) - 1, 0, -1):
        dir_path = "/".join(parts[:i])
        # 同时尝试带 / 和不带 / 的格式
        for d in [dir_path, dir_path + "/"]:
            rows = execute_query(
                """SELECT s.share_scope, s.target_users, s.target_grade, s.target_class
                   FROM shared_resources s
                   WHERE s.owner_username=? AND s.file_path=? AND s.resource_type=?""",
                (owner_username, d, resource_type),
            )
            if rows:
                if _check_share_scope(rows[0], viewer_username):
                    return True

    return False


def _check_share_scope(row, viewer_username: str) -> bool:
    """检查共享范围是否对 viewer_username 可见

    统一委托给 permission_service.check_share_visibility
    """
    share_scope, target_users, target_grade, target_class = row
    return check_share_visibility(
        viewer_username=viewer_username,
        share_scope=share_scope,
        target_users_csv=target_users or "",
        target_grade_csv=target_grade or "",
        target_class_csv=target_class or "",
    )
