"""
文件下载管理 API - 用户隔离 + 配额限制
每个用户使用自己的 downloads 目录，教师配额 5GB
"""
import os, json, shutil
from datetime import datetime
from fastapi import Request, UploadFile, File, Form
from fastapi.responses import JSONResponse

from backend.config import BASE_DIR
from backend.utils import get_user_base_dir
from backend.database import execute_query
from backend.api.config_router import get_config_value

# 管理员无限制（用 0 表示无限制，避免 JSON 序列化 float('inf') 失败）
ADMIN_QUOTA = 0

# 需要排除的文件（只排除页面自身）
EXCLUDE = {'index.html'}


def _get_user_downloads_dir(username: str) -> str:
    """获取用户个人的 downloads 目录路径"""
    base = get_user_base_dir(username)
    return os.path.join(str(BASE_DIR), base, "downloads")


def _get_user_quota(username: str) -> int:
    """获取用户的配额上限（字节），0 表示无限制，教师从系统配置读取"""
    if username == "root":
        return ADMIN_QUOTA
    rows = execute_query("SELECT role FROM users WHERE username=?", (username,))
    if rows:
        role = rows[0][0]
        if role in (0,):  # 管理员
            return ADMIN_QUOTA
    quota_gb = get_config_value("TEACHER_DOWNLOAD_QUOTA_GB", 5)
    return int(quota_gb) * 1024 * 1024 * 1024


def _get_user_usage(username: str) -> int:
    """计算用户 downloads 目录的当前使用量（字节）"""
    dldir = _get_user_downloads_dir(username)
    if not os.path.exists(dldir):
        return 0
    total = 0
    for dirpath, _, filenames in os.walk(dldir):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            try:
                total += os.path.getsize(fp)
            except OSError:
                pass
    return total


def _format_size(size: int) -> str:
    """格式化文件大小"""
    if size < 1024:
        return f"{size} B"
    elif size < 1048576:
        return f"{size/1024:.1f} KB"
    elif size < 1073741824:
        return f"{size/1048576:.1f} MB"
    else:
        return f"{size/1073741824:.2f} GB"

def _safe_rel_path(rel_path: str) -> str:
    """规范化相对路径，防止路径穿越，返回相对于 DOWNLOADS_DIR 的安全路径"""
    # 用 posix 风格统一
    rel_path = rel_path.replace('\\', '/').strip('/')
    norm = os.path.normpath(rel_path).replace('\\', '/')
    # 不允许跳出
    if norm.startswith('..') or norm.startswith('/'):
        return ''
    return norm

def _scan_dir(dirpath: str, base_rel: str) -> list:
    """递归扫描目录，返回 [{name, path, size, mtime}]，path 为相对于用户 downloads 目录"""
    entries = []
    for name in sorted(os.listdir(dirpath), key=str.lower):
        full = os.path.join(dirpath, name)
        rel = (base_rel + '/' + name) if base_rel else name
        if name in EXCLUDE and not base_rel:
            continue
        if os.path.isfile(full):
            stat = os.stat(full)
            entries.append({
                'name': name,
                'path': _safe_rel_path(rel),
                'size': stat.st_size,
                'mtime': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M')
            })
        elif os.path.isdir(full):
            entries.append({
                'name': name,
                'path': _safe_rel_path(rel) + '/',
                'size': 0,
                'mtime': '',
                'is_dir': True
            })
            entries.extend(_scan_dir(full, rel))
    return entries

async def api_list_files(request: Request):
    """动态递归扫描当前用户的 downloads 目录，返回文件列表 + 配额信息"""
    user = getattr(request.state, 'user', None)
    if not user:
        return {"files": [], "error": "未登录"}
    username = user["username"]
    dldir = _get_user_downloads_dir(username)
    if not os.path.isdir(dldir):
        return {"files": [], "usage": 0, "quota": _get_user_quota(username)}
    entries = _scan_dir(dldir, '')
    usage = _get_user_usage(username)
    quota = _get_user_quota(username)
    return {
        "files": entries,
        "usage": usage,
        "usage_str": _format_size(usage),
        "quota": quota,
        "quota_str": "无限制" if quota == 0 else _format_size(quota),
    }

async def api_ping(request: Request):
    """诊断端点"""
    user = getattr(request.state, 'user', None)
    if not user:
        return {"status": "error", "error": "未登录"}
    username = user["username"]
    dldir = _get_user_downloads_dir(username)
    count = 0
    if os.path.isdir(dldir):
        for root, dirs, files in os.walk(dldir):
            for f in files:
                if f not in EXCLUDE or root != dldir:
                    count += 1
    return {
        "status": "ok",
        "downloads_dir": dldir,
        "exists": os.path.isdir(dldir),
        "file_count": count,
    }

async def api_upload(request: Request):
    """上传文件到当前用户的 downloads 目录（支持子目录结构），含配额检查"""
    user = getattr(request.state, 'user', None)
    if not user:
        return {"success": False, "files": [], "errors": ["未登录，请重新登录"]}
    username = user["username"]
    dldir = _get_user_downloads_dir(username)
    os.makedirs(dldir, exist_ok=True)

    quota = _get_user_quota(username)
    current_usage = _get_user_usage(username)

    form = await request.form()
    uploaded = []
    errors = []

    file_map = {}
    for key in form.keys():
        if key.startswith('file'):
            idx = key[4:]
            item = form[key]
            if hasattr(item, 'filename') and item.filename:
                file_map[idx] = [item, '']
    for key in form.keys():
        if key.startswith('path'):
            idx = key[4:]
            if idx in file_map:
                file_map[idx][1] = form[key]

    for idx, (item, rel_path) in file_map.items():
        try:
            raw_filename = item.filename
            if not raw_filename:
                continue
            content = await item.read()
            file_size = len(content)

            # 配额检查（quota=0 表示无限制）
            if quota != 0 and current_usage + file_size > quota:
                errors.append(f"{raw_filename}: 存储空间不足（已用 {_format_size(current_usage)}，配额 {_format_size(quota)}）")
                continue

            rel = _safe_rel_path(rel_path)
            if not rel and rel_path:
                errors.append(f"{raw_filename}: 非法路径")
                continue
            if rel:
                full_rel = os.path.join(rel, os.path.basename(raw_filename))
            else:
                full_rel = os.path.basename(raw_filename)
            full_rel = _safe_rel_path(full_rel)
            if not full_rel:
                errors.append(f"{raw_filename}: 非法路径")
                continue

            if os.path.basename(full_rel) in EXCLUDE and not os.path.dirname(full_rel):
                errors.append(f"{full_rel}: 不允许上传此文件")
                continue

            dest = os.path.join(dldir, full_rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, 'wb') as f:
                f.write(content)
            uploaded.append(full_rel)
            current_usage += file_size
        except Exception as e:
            errors.append(f"{raw_filename if 'raw_filename' in dir() else '?'}: {str(e)}")

    return {"success": len(uploaded) > 0, "files": uploaded, "errors": errors}

async def api_delete(request: Request):
    """删除当前用户 downloads 目录中的文件或空目录"""
    user = getattr(request.state, 'user', None)
    if not user:
        return {"success": False, "error": "未登录，请重新登录"}
    username = user["username"]
    dldir = _get_user_downloads_dir(username)

    body = await request.json()
    filename = body.get("filename", "")
    if not filename:
        return {"success": False, "error": "未指定文件名"}
    rel = _safe_rel_path(filename)
    if not rel:
        return {"success": False, "error": "非法路径"}
    if rel == 'index.html':
        return {"success": False, "error": "不允许删除此文件"}
    filepath = os.path.join(dldir, rel)
    if not os.path.exists(filepath):
        return {"success": False, "error": "文件或目录不存在"}

    def _rm_and_clean(path):
        if os.path.isfile(path):
            os.remove(path)
            parent = os.path.dirname(path)
            while parent and os.path.isdir(parent) and parent != dldir:
                try:
                    os.rmdir(parent)
                except OSError:
                    break
                parent = os.path.dirname(parent)
        elif os.path.isdir(path):
            shutil.rmtree(path)
            parent = os.path.dirname(path)
            while parent and os.path.isdir(parent) and parent != dldir:
                try:
                    os.rmdir(parent)
                except OSError:
                    break
                parent = os.path.dirname(parent)
        else:
            raise FileNotFoundError()

    try:
        _rm_and_clean(filepath)
        return {"success": True, "filename": rel}
    except Exception as e:
        return {"success": False, "error": str(e)}


def mount_downloads_api(app):
    """挂载下载管理 API 路由到 FastAPI app"""
    app.get("/downloads-api/list")(api_list_files)
    app.get("/downloads-api/ping")(api_ping)
    app.post("/downloads-api/upload")(api_upload)
    app.post("/downloads-api/delete")(api_delete)
    
    # 诊断端点：检查当前用户状态
    async def api_check(request: Request):
        user = getattr(request.state, 'user', None)
        auth = request.headers.get("Authorization", "")
        return {
            "has_user": user is not None,
            "username": user["username"] if user else None,
            "has_auth": bool(auth),
            "auth_prefix": auth[:20] if auth else "",
        }
    app.get("/downloads-api/check")(api_check)
    
    routes = [r.path for r in app.routes if hasattr(r, 'path')]
    dl_routes = [r for r in routes if 'downloads' in r]
