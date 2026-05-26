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
async def serve_static_file(path: str):
    """静态文件服务（无需认证，替代 Gradio 的 /gradio_api/file=）
    
    URL 示例: /api/files/root/html/some/file.html
    安全限制：只允许访问 root/html/ 和 stu/ 等公开目录。
    """
    requested_path = os.path.abspath(os.path.join(str(BASE_DIR), path))
    base_dir_abs = os.path.abspath(str(BASE_DIR))
    
    # 安全校验：必须在项目目录内
    if not requested_path.startswith(base_dir_abs):
        raise HTTPException(status_code=403, detail="无权访问该文件")
    
    # 额外限制：只允许访问特定公开目录
    allowed_prefixes = [
        os.path.join(base_dir_abs, "root", "html"),
        os.path.join(base_dir_abs, "root", "imgs"),
        os.path.join(base_dir_abs, "root", "downloads"),
        os.path.join(base_dir_abs, "backend", "data"),
    ]
    # 允许访问 stu/ 和 教师/管理员 个人目录中的 html 和 downloads 文件
    for entry in os.listdir(base_dir_abs):
        for sub in ("html", "downloads"):
            entry_path = os.path.join(base_dir_abs, entry, sub)
            if os.path.isdir(entry_path):
                allowed_prefixes.append(entry_path)
    stu_path = os.path.join(base_dir_abs, "stu")
    if os.path.isdir(stu_path):
        for entry in os.listdir(stu_path):
            for sub in ("html", "downloads"):
                entry_sub = os.path.join(stu_path, entry, sub)
                if os.path.isdir(entry_sub):
                    allowed_prefixes.append(entry_sub)
    # 允许项目根目录下的特定文件
    allowed_root_files = ["about_help.md"]
    is_allowed = any(requested_path.startswith(p) for p in allowed_prefixes)
    is_allowed = is_allowed or os.path.basename(requested_path) in allowed_root_files
    if not is_allowed:
        raise HTTPException(status_code=403, detail="无权访问该文件")
    
    if not os.path.exists(requested_path):
        raise HTTPException(status_code=404, detail="文件不存在")
    
    return FileResponse(requested_path)
