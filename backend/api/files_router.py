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
from backend.config import IMAGE_EXTENSIONS, DOCUMENT_EXTENSIONS, BASE_DIR
from backend.logger import logger

router = APIRouter()

TEMP_UPLOAD_DIR = BASE_DIR / "temp_uploads"
TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = set(IMAGE_EXTENSIONS + DOCUMENT_EXTENSIONS)

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
    removed = 0
    for user_dir in TEMP_UPLOAD_DIR.iterdir():
        if not user_dir.is_dir():
            continue
        for f in user_dir.iterdir():
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink()
                removed += 1
        # 删除空目录
        if user_dir.exists() and not list(user_dir.iterdir()):
            user_dir.rmdir()
    if removed:
        logger.info(f"临时文件自动清理: 移除 {removed} 个过期文件")


@router.post("/upload-temp")
async def upload_temp_file(request: Request, file: UploadFile = File(...)):
    """上传临时文件，返回服务器端路径"""
    _auto_cleanup_temp()
    user = get_current_user(request)
    username = user["username"]
    filename = file.filename or "unknown"
    _, ext = os.path.splitext(filename.lower())
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的文件类型: {ext}")
    unique_name = f"{uuid.uuid4().hex}{ext}"
    user_dir = TEMP_UPLOAD_DIR / username
    user_dir.mkdir(parents=True, exist_ok=True)
    save_path = user_dir / unique_name
    try:
        content = await file.read()
        max_size = 10 * 1024 * 1024
        if ext in IMAGE_EXTENSIONS:
            max_size = 5 * 1024 * 1024
        if len(content) > max_size:
            raise HTTPException(status_code=400, detail="文件超过大小限制")
        with open(save_path, "wb") as f:
            f.write(content)
        logger.info(f"临时文件已上传: {save_path}")
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
        logger.info(f"所有临时文件已清理 (by: {username})")
        return {"message": "所有临时文件已清理"}
    else:
        user_dir = TEMP_UPLOAD_DIR / username
        if user_dir.exists():
            shutil.rmtree(user_dir)
        logger.info(f"临时文件已清理: {username}")
        return {"message": "已清理"}


@router.get("/{path:path}")
async def serve_static_file(path: str, request: Request):
    """静态文件服务（需登录，按用户角色隔离）
    
    URL 示例: /api/files/root/html/some/file.html
    
    访问权限规则：
    - 管理员 (role=0): 可访问所有目录
    - 教师 (role=1): 可访问 root/（共享资源）和自己目录下的资源
    - 学生 (role=2): 仅可访问 stu/自己学号/ 下的资源
    - 未登录: 仅可访问 about_help.md 等公开文件
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
    public_files = {"about_help.md"}
    if basename in public_files:
        return FileResponse(requested_path)
    
    # 必须登录
    if user is None:
        raise HTTPException(status_code=401, detail="需要登录才能访问资源文件")
    
    username = user.get("username", "")
    role = user.get("role", 2)  # 默认学生
    rel_path = os.path.relpath(requested_path, base_dir_abs).replace("\\", "/")
    path_parts = rel_path.split("/")
    
    # 管理员：可访问所有文件
    if role == 0:
        pass  # 放行
    
    # 教师：可访问 root/（共享）和自己名下的资源
    elif role == 1:
        if path_parts[0] == "root":
            pass  # root/ 共享资源，教师可访问
        elif path_parts[0] == "backend" and len(path_parts) > 1 and path_parts[1] == "data":
            pass  # backend/data/ 系统数据，教师可访问
        elif path_parts[0] == username:
            pass  # 自己的目录
        else:
            raise HTTPException(status_code=403, detail="无权访问其他用户的资源")
    
    # 学生：仅可访问 stu/自己学号/ 下的资源
    elif role == 2:
        if len(path_parts) >= 3 and path_parts[0] == "stu" and path_parts[1] == username:
            pass  # 自己的 stu/学号/ 目录
        else:
            raise HTTPException(status_code=403, detail="无权访问该资源")
    
    else:
        raise HTTPException(status_code=403, detail="无权访问该资源")
    
    return FileResponse(requested_path)
