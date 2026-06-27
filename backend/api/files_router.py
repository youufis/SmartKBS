"""
文件服务 API 路由
文件上传 + 静态文件服务
"""
import os
import uuid
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse

from backend.api.dependencies import get_current_user
from backend.auth import is_admin
from backend.config import BASE_DIR
from backend.api.config_router import get_config_value
from backend.config import ROOT_DIR, STU_DIR
from backend.api.sharing_router import is_file_shared_with_user
from backend.database import execute_insert_update
from backend.logger import logger

router = APIRouter()

TEMP_UPLOAD_DIR = BASE_DIR / "temp_uploads"
TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

def _get_allowed_extensions() -> set[str]:
    """获取允许的文件扩展名集合（运行时读取，支持热更新）"""
    img = get_config_value("IMAGE_EXTENSIONS", ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'])
    doc = get_config_value("DOCUMENT_EXTENSIONS", ['.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.json', '.html', '.htm'])
    return set(img + doc)

# ── 自动清理旧临时文件（每 24 小时检查一次，删除超过 24 小时的） ──
_last_temp_cleanup: float = 0
_TEMP_CLEANUP_INTERVAL = 86400  # 24 小时
_TEMP_MAX_AGE = 86400  # 24 小时


def _auto_cleanup_temp():
    """自动清理过期临时文件"""
    global _last_temp_cleanup
    import time
    now = time.time()
    if now - _last_temp_cleanup < _TEMP_CLEANUP_INTERVAL:
        return
    _last_temp_cleanup = now
    if not TEMP_UPLOAD_DIR.exists():
        return
    cutoff = now - _TEMP_MAX_AGE
    for user_dir in TEMP_UPLOAD_DIR.iterdir():
        if not user_dir.is_dir():
            continue
        for f in user_dir.iterdir():
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink()
        # 删除空目录
        if user_dir.exists() and not list(user_dir.iterdir()):
            user_dir.rmdir()


@router.post("/upload-temp")
async def upload_temp_file(request: Request, file: UploadFile = File(...)):
    """上传临时文件，返回服务器端路径（相同内容只保存一份）"""
    _auto_cleanup_temp()
    user = get_current_user(request)
    username = user["username"]
    filename = file.filename or "unknown"
    _, ext = os.path.splitext(filename.lower())
    if ext not in _get_allowed_extensions():
        raise HTTPException(status_code=400, detail=f"不支持的文件类型: {ext}")
    user_dir = TEMP_UPLOAD_DIR / username
    user_dir.mkdir(parents=True, exist_ok=True)
    try:
        content = await file.read()
        max_size = 10 * 1024 * 1024
        if ext in get_config_value("IMAGE_EXTENSIONS", ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp']):
            max_size = 5 * 1024 * 1024
        if len(content) > max_size:
            raise HTTPException(status_code=400, detail="文件超过大小限制")

        # 计算内容哈希，相同内容的文件只保存一份
        import hashlib
        file_hash = hashlib.sha256(content).hexdigest()
        save_path = user_dir / f"{file_hash}{ext}"

        if not save_path.exists():
            with open(save_path, "wb") as f:
                f.write(content)

        return {"path": str(save_path), "filename": filename, "size": len(content)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"文件上传失败: {e}")
        raise HTTPException(status_code=500, detail=f"文件上传失败: {str(e)}")


@router.delete("/cleanup-temp")
async def cleanup_temp_files(request: Request, all: bool = False):
    """清理临时文件
    - 管理员传 all=true 清理所有用户的临时文件
    - 普通用户只能清理自己的
    """
    user = get_current_user(request)
    username = user["username"]

    if all:
        if not is_admin(username):
            raise HTTPException(status_code=403, detail="权限不足：仅管理员可清理所有缓存")
        if TEMP_UPLOAD_DIR.exists():
            shutil.rmtree(TEMP_UPLOAD_DIR)
            TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        return {"message": "所有临时文件已清理"}
    else:
        user_dir = TEMP_UPLOAD_DIR / username
        if user_dir.exists():
            shutil.rmtree(user_dir)
        return {"message": "已清理"}


def _parse_file_owner_and_type(rel_path: str):
    """从相对路径解析文件的所有者和资源类型"""
    parts = rel_path.split("/")
    if len(parts) >= 3:
        if parts[0] == STU_DIR:
            return parts[1], parts[2]  # stu/s110005/html/... → (s110005, html)
        elif parts[0] == ROOT_DIR:
            return parts[0], parts[1]  # root/html/... → (root, html)
        else:
            return parts[0], parts[1]  # youufis/html/... → (youufis, html)
    return None, None


@router.get("/{path:path}")
async def serve_static_file(path: str, request: Request):
    """静态文件服务（需登录，按用户角色隔离）
    
    URL 示例: /api/files/root/html/some/file.html
    
    访问权限规则：
    - 管理员 (role=0): 可访问所有目录
    - 教师 (role=1): 可访问 root/（共享资源）和自己目录下的资源
    - 学生 (role=2): 仅可访问 stu/自己学号/ 下的资源 + 共享给该学生的资源
    - 未登录: 仅可访问 USER_MANUAL.md 等公开文件
    
    共享覆盖：管理员共享给所有人的资源、教师共享给对应年级/班级的资源也可访问。
    """
    requested_path = os.path.abspath(os.path.join(str(BASE_DIR), path))
    base_dir_abs = os.path.abspath(str(BASE_DIR))
    
    # 安全校验：必须在项目目录内
    if not requested_path.startswith(base_dir_abs):
        raise HTTPException(status_code=403, detail="无权访问该文件")
    
    if not os.path.exists(requested_path):
        raise HTTPException(status_code=404, detail="文件不存在")
    
    # ── 用户隔离检查 ──
    user = request.state.user  # 由中间件注入
    basename = os.path.basename(requested_path)
    
    # 公开文件：未登录也可访问
    public_files = {"USER_MANUAL.md"}
    if basename in public_files:
        return FileResponse(requested_path)

    # question_media 目录：试题配图，未登录可访问
    if "/question_media/" in request.url.path:
        return FileResponse(requested_path)

    # 必须登录
    if user is None:
        raise HTTPException(status_code=401, detail="需要登录才能访问资源文件")
    
    username = user.get("username", "")
    role = user.get("role", 2)  # 默认学生
    rel_path = os.path.relpath(requested_path, base_dir_abs).replace("\\", "/")
    path_parts = rel_path.split("/")
    
    # 标记是否允许访问
    allowed = False
    
    # 管理员：可访问所有文件
    if role == 0:
        allowed = True
    
    # 教师：可访问 root/（共享）和自己名下的资源
    elif role == 1:
        if path_parts[0] == ROOT_DIR:
            allowed = True
        elif path_parts[0] == "backend" and len(path_parts) > 1 and path_parts[1] == "data":
            allowed = True
        elif path_parts[0] == username:
            allowed = True
    
    # 学生：仅可访问 stu/自己学号/ 下的资源
    elif role == 2:
        if len(path_parts) >= 3 and path_parts[0] == STU_DIR and path_parts[1] == username:
            allowed = True
    
    # ── 共享覆盖检查：如果普通检查未通过，检查是否为共享资源 ──
    if not allowed:
        owner, dir_type = _parse_file_owner_and_type(rel_path)
        resource_type_map = {"html": "html", "downloads": "download"}
        if owner and dir_type in resource_type_map:
            res_type = resource_type_map[dir_type]
            # 构建相对于所有者目录的文件路径
            if dir_type in ("html", "downloads"):
                idx = rel_path.index(dir_type)
                file_rel = rel_path[idx + len(dir_type) + 1:]  # 去掉 "html/" 或 "downloads/"
            else:
                file_rel = ""
            # 同时尝试两种路径格式：
            # 1. 截短后的相对路径（来自资源管理页 tree node.key）
            # 2. 完整 rel_path（来自资源中心页 f.url_path）
            if is_file_shared_with_user(file_rel, res_type, owner, username):
                allowed = True
            elif is_file_shared_with_user(rel_path, res_type, owner, username):
                allowed = True
    
    if not allowed:
        raise HTTPException(status_code=403, detail="无权访问该资源")
    
    # ── 学生访问 HTML/下载文件时记录查看日志 ──
    if role == 2 and (path_parts[-1].endswith('.html') or path_parts[-1].endswith('.htm') or "downloads" in path_parts):
        try:
            _log_resource_access(rel_path, username, role, path_parts, request)
        except Exception:
            pass  # 日志记录失败不影响文件访问
    
    return FileResponse(requested_path)


def _log_resource_access(rel_path: str, username: str, role: int, path_parts: list[str], request: Request):
    """记录学生访问 HTML 资源的日志（后端兜底记录）"""
    from datetime import datetime

    # 只记录学生
    if role != 2:
        return

    # 推断资源类型
    if "html" in path_parts:
        dir_type = "html"
    elif "downloads" in path_parts:
        dir_type = "download"
    else:
        return

    # 尝试从共享记录中查找 resource_id
    resource_id = 0
    owner_username = ""
    try:
        # 解析所有者
        if len(path_parts) >= 3:
            if path_parts[0] == "stu":
                owner_username = path_parts[1]
            else:
                owner_username = path_parts[0]

        # 通过文件路径查询共享记录中的资源 ID
        file_rel = "/".join(path_parts[path_parts.index(dir_type) + 1:])
        from backend.database import execute_query_one
        share = execute_query_one(
            "SELECT id, owner_username FROM shared_resources WHERE resource_type=? AND (file_path=? OR file_path LIKE ?) LIMIT 1",
            (dir_type, file_rel, f"%/{file_rel}"),
        )
        if share:
            resource_id = share["id"]
            owner_username = share["owner_username"]
    except Exception:
        pass

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    client_ip = request.client.host if request.client else ""

    try:
        execute_insert_update(
            """INSERT INTO resource_view_logs
               (student_username, resource_type, resource_id, knowledge_point_id,
                binding_id, source, file_path, owner_username, viewed_at, ip_address)
               VALUES (?, ?, ?, NULL, NULL, 'direct', ?, ?, ?, ?)""",
            (username, dir_type, resource_id, rel_path, owner_username, now, client_ip),
        )

        # 首次浏览共享资源奖励 1 分（幂等，不重复累计）
        if resource_id > 0:
            try:
                from backend.reward_engine import award_participation
                award_participation(
                    student_username=username,
                    activity_type="resource_view",
                    activity_id=str(resource_id),
                    activity_title=rel_path.split("/")[-1] or "共享资源",
                )
            except Exception:
                pass
    except Exception:
        pass
