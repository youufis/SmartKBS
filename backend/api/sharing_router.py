"""
共享资源 API 路由
管理员/教师共享 HTML 资源和下载文件，学生按年级/班级查看
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


# ── 创建共享 ──

@router.post("/share")
async def share_resource(request: Request, body: ShareRequest):
    """共享一个资源或文件（管理员：全员共享；教师：自动共享给自己班级学生）"""
    user = get_current_user(request)
    username = user["username"]
    role = user["role"]

    # 仅管理员和教师可以共享
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅管理员和教师可以共享资源")

    if body.resource_type not in ("html", "download"):
        raise HTTPException(status_code=400, detail="resource_type 必须是 html 或 download")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if role == 0:
        # 管理员：共享给所有人
        share_scope = "all"
        target_grade = ""
        target_class = ""
    else:
        # 教师：自动从用户信息获取班级和年级
        share_scope = "class"
        rows = execute_query(
            "SELECT grade, class FROM users WHERE username=?",
            (username,),
        )
        if rows:
            target_grade = rows[0][0] or ""
            target_class = rows[0][1] or ""
        else:
            target_grade = ""
            target_class = ""

    try:
        execute_insert_update(
            """INSERT OR REPLACE INTO shared_resources
               (owner_username, file_path, file_name, resource_type, share_scope, target_grade, target_class, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (username, body.file_path, body.file_name, body.resource_type,
             share_scope, target_grade, target_class, now, now),
        )
        logger.info(f"共享创建成功: {username} -> {body.file_path} (scope={share_scope})")
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

    # 查询共享记录
    rows = execute_query(
        "SELECT owner_username FROM shared_resources WHERE id=?",
        (id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="共享记录不存在")

    owner = rows[0][0]

    # 仅共享者本人或管理员可以取消
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
        """SELECT id, file_path, file_name, resource_type, share_scope, target_grade, target_class, created_at
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
                "target_grade": r[5] or "",
                "target_class": r[6] or "",
                "created_at": r[7],
            }
            for r in rows
        ]
    }


# ── 收到的共享（给当前用户可见的共享） ──

@router.get("/received")
async def received_shares(request: Request):
    """获取共享给当前用户的资源（按角色和年级/班级过滤）"""
    user = get_current_user(request)
    username = user["username"]
    role = user["role"]

    if role == 0:
        # 管理员：看到所有共享
        rows = execute_query(
            """SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                      s.share_scope, s.target_grade, s.target_class, s.created_at
               FROM shared_resources s
               ORDER BY s.created_at DESC""",
        )
    elif role == 1:
        # 教师：看到所有共享（用于管理）
        rows = execute_query(
            """SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                      s.share_scope, s.target_grade, s.target_class, s.created_at
               FROM shared_resources s
               ORDER BY s.created_at DESC""",
        )
    else:
        # 学生：看到管理员共享(scope=all) + 匹配自己年级/班级的教师共享
        # 教师可能有多个年级/班级（用逗号分隔），需要逐一匹配
        rows = execute_query(
            """SELECT s.id, s.owner_username, s.file_path, s.file_name, s.resource_type,
                      s.share_scope, s.target_grade, s.target_class, s.created_at
               FROM shared_resources s
               LEFT JOIN users u ON u.username=?
               WHERE s.share_scope='all'
                  OR (s.share_scope='class'
                      AND (s.target_grade='' OR s.target_grade=u.grade
                           OR ',' || s.target_grade || ',' LIKE '%,' || CAST(u.grade AS TEXT) || ',%')
                      AND (s.target_class='' OR s.target_class=u.class
                           OR ',' || s.target_class || ',' LIKE '%,' || CAST(u.class AS TEXT) || ',%'))
               ORDER BY s.created_at DESC""",
            (username,),
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
                "target_grade": r[6] or "",
                "target_class": r[7] or "",
                "created_at": r[8],
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

    # 查共享表中是否有这条记录，且 viewer 有权限
    rows = execute_query(
        """SELECT s.share_scope, s.target_grade, s.target_class
           FROM shared_resources s
           WHERE s.owner_username=? AND s.file_path=? AND s.resource_type=?""",
        (owner_username, file_rel_path, resource_type),
    )
    if not rows:
        return False

    share_scope, target_grade, target_class = rows[0]

    if share_scope == 'all':
        return True

    # scope='class'：需要年级/班级匹配（支持 | 分隔的多值匹配）
    viewer_rows = execute_query(
        "SELECT grade, class FROM users WHERE username=?",
        (viewer_username,),
    )
    if not viewer_rows:
        return False

    viewer_grade = str(viewer_rows[0][0] or "")
    viewer_class = str(viewer_rows[0][1] or "")

    # 年级匹配（支持逗号分隔的多值匹配）
    grade_ok = not target_grade or (
        viewer_grade == target_grade
        or f',{target_grade},'.find(f',{viewer_grade},') != -1
    )
    if not grade_ok:
        return False

    # 班级匹配（支持逗号分隔的多值匹配）
    class_ok = not target_class or (
        viewer_class == target_class
        or f',{target_class},'.find(f',{viewer_class},') != -1
    )
    return class_ok
