"""
共享资源 API 路由
管理员/教师共享 HTML 资源和下载文件，可按角色、年级、班级灵活设置共享范围
支持多选教师、多选年级、多选班级
"""
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.auth import is_admin, is_teacher
from backend.database import execute_query, execute_insert_update
from backend.logger import logger

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
    if file_path.startswith(f"{owner}/{dir_name}/") or file_path.startswith(f"stu/{owner}/{dir_name}/"):
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
        return {"message": "共享成功", "file_path": body.file_path}
    except Exception as e:
        logger.error(f"共享创建失败: {e}")
        raise HTTPException(status_code=500, detail=f"共享失败: {str(e)}")


# ── 取消共享 ──

@router.delete("/share")
async def unshare_resource(id: int = Query(...), request: Request = None):
    """取消共享"""
    if request is None:
        raise HTTPException(status_code=401, detail="未登录")

    user = get_current_user(request)
    username = user["username"]
    role = user["role"]

    rows = execute_query(
        "SELECT owner_username FROM shared_resources WHERE id=?",
        (id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="共享记录不存在")

    owner = rows[0][0]

    if username != owner and role != 0:
        raise HTTPException(status_code=403, detail="无权取消此共享")

    try:
        execute_insert_update(
            "DELETE FROM shared_resources WHERE id=?",
            (id,),
        )
        logger.info(f"共享已取消: id={id}, by={username}")
        return {"message": "共享已取消"}
    except Exception as e:
        logger.error(f"取消共享失败: {e}")
        raise HTTPException(status_code=500, detail=f"取消共享失败: {str(e)}")


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
