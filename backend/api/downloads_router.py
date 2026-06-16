"""
文件下载管理 API 路由（重构版）
从 backend/downloads_api.py 迁移，保持功能完全一致
"""
import os
import shutil
from datetime import datetime

from fastapi import APIRouter, Request

from backend.config import BASE_DIR
from backend.utils import get_user_base_dir
from backend.database import execute_query
from backend.api.config_router import get_config_value

router = APIRouter()

# ── 常量 ──

ADMIN_QUOTA = 0
EXCLUDE = {"index.html"}


# ── 内部工具（原 downloads_api.py 直接迁移）──

def _get_user_downloads_dir(username: str) -> str:
    """获取用户个人的 downloads 目录路径"""
    base = get_user_base_dir(username)
    return os.path.join(str(BASE_DIR), base, "downloads")


def _get_user_quota(username: str) -> int:
    """获取用户的配额上限（字节），0 表示无限制"""
    if username == "root":
        return ADMIN_QUOTA
    rows = execute_query("SELECT role FROM users WHERE username=?", (username,))
    if rows:
        role = rows[0][0]
        if role in (0,):
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
        return f"{size / 1024:.1f} KB"
    elif size < 1073741824:
        return f"{size / 1048576:.1f} MB"
    else:
        return f"{size / 1073741824:.2f} GB"


def _safe_rel_path(rel_path: str) -> str:
    """规范化相对路径，防止路径穿越"""
    rel_path = rel_path.replace("\\", "/").strip("/")
    norm = os.path.normpath(rel_path).replace("\\", "/")
    if norm.startswith("..") or norm.startswith("/"):
        return ""
    return norm


def _scan_dir(dirpath: str, base_rel: str) -> list:
    """递归扫描目录，返回 [{name, path, size, mtime}]"""
    entries = []
    for name in sorted(os.listdir(dirpath), key=str.lower):
        full = os.path.join(dirpath, name)
        rel = (base_rel + "/" + name) if base_rel else name
        if name in EXCLUDE and not base_rel:
            continue
        if os.path.isfile(full):
            stat = os.stat(full)
            entries.append({
                "name": name,
                "path": _safe_rel_path(rel),
                "size": stat.st_size,
                "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
            })
        elif os.path.isdir(full):
            entries.append({
                "name": name,
                "path": _safe_rel_path(rel) + "/",
                "size": 0,
                "mtime": "",
                "is_dir": True,
            })
            entries.extend(_scan_dir(full, rel))
    return entries


# ── API 端点 ──


@router.get("/list", summary="文件列表")
async def api_list_files(request: Request):
    """动态递归扫描当前用户的 downloads 目录，返回文件列表 + 配额信息"""
    user = getattr(request.state, "user", None)
    if not user:
        return {"files": [], "error": "未登录"}
    username = user["username"]
    dldir = _get_user_downloads_dir(username)
    if not os.path.isdir(dldir):
        return {"files": [], "usage": 0, "quota": _get_user_quota(username)}
    entries = _scan_dir(dldir, "")
    usage = _get_user_usage(username)
    quota = _get_user_quota(username)
    return {
        "files": entries,
        "usage": usage,
        "usage_str": _format_size(usage),
        "quota": quota,
        "quota_str": "无限制" if quota == 0 else _format_size(quota),
    }


@router.get("/ping", summary="诊断端点")
async def api_ping(request: Request):
    """诊断端点"""
    user = getattr(request.state, "user", None)
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


@router.post("/upload", summary="上传文件")
async def api_upload(request: Request):
    """上传文件到当前用户的 downloads 目录，含配额检查"""
    user = getattr(request.state, "user", None)
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
        if key.startswith("file"):
            idx = key[4:]
            item = form[key]
            if hasattr(item, "filename") and item.filename:
                file_map[idx] = [item, ""]
    for key in form.keys():
        if key.startswith("path"):
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

            # 配额检查
            if quota != 0 and current_usage + file_size > quota:
                errors.append(
                    f"{raw_filename}: 存储空间不足（已用 {_format_size(current_usage)}，配额 {_format_size(quota)}）"
                )
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
            with open(dest, "wb") as f:
                f.write(content)
            uploaded.append(full_rel)
            current_usage += file_size
        except Exception as e:
            errors.append(f"{raw_filename if 'raw_filename' in locals() else '?'}: {str(e)}")

    return {"success": len(uploaded) > 0, "files": uploaded, "errors": errors}


@router.post("/delete", summary="删除文件")
async def api_delete(request: Request):
    """删除当前用户 downloads 目录中的文件或空目录"""
    user = getattr(request.state, "user", None)
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
    if rel == "index.html":
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
        # 文件删除后清理空目录共享记录
        try:
            from backend.api.sharing_router import _cleanup_empty_dir_shares
            _cleanup_empty_dir_shares(username)
        except Exception:
            pass
        # 清理该文件的共享记录和关联的课程绑定
        try:
            from backend.database import execute_insert_update, execute_query_dict
            # 查找所有指向该文件的共享记录
            share_rows = execute_query_dict(
                "SELECT id FROM shared_resources WHERE owner_username=? AND (file_path=? OR file_path LIKE ?)",
                (username, rel, f"%/{rel}"),
            )
            for row in share_rows:
                sid = row["id"]
                # 先清理关联的课程绑定
                execute_insert_update(
                    "DELETE FROM curriculum_bindings WHERE resource_type='download' AND resource_id=?",
                    (sid,),
                )
                # 再删除共享记录
                execute_insert_update("DELETE FROM shared_resources WHERE id=?", (sid,))
            if share_rows:
                logger.info(f"已同步清理 {len(share_rows)} 条下载共享记录及关联绑定")
        except Exception:
            pass
        return {"success": True, "filename": rel}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.get("/shared-list", summary="浏览共享目录内容")
async def api_shared_list(request: Request, owner: str = "", dir_path: str = ""):
    """浏览共享给当前用户的目录内容

    接收方点击共享的目录卡片后，调用此接口列出该目录下的文件。
    需要验证该目录确实已共享给当前用户。
    """
    user = getattr(request.state, "user", None)
    if not user:
        return {"files": [], "error": "未登录"}
    username = user["username"]
    viewer_role = user.get("role", 2)

    if not owner or not dir_path:
        return {"files": [], "error": "缺少 owner 或 dir_path"}

    # 检查共享权限：该目录是否对当前用户可见
    from backend.api.sharing_router import is_file_shared_with_user
    clean_dir = dir_path.strip("/")
    if not is_file_shared_with_user(clean_dir, "download", owner, username):
        return {"files": [], "error": "无权访问该目录"}

    # 构建实际目录路径
    from backend.utils import get_user_base_dir
    base = get_user_base_dir(owner)
    full_dir = os.path.join(str(BASE_DIR), base, "downloads", clean_dir)

    if not os.path.isdir(full_dir):
        return {"files": [], "error": "目录不存在"}

    entries = _scan_dir(full_dir, clean_dir)
    # 过滤掉目录项（只保留文件），因为接收方只需看到可下载的文件
    files_only = [e for e in entries if not e.get("is_dir")]
    return {"files": files_only, "dir_path": clean_dir, "owner": owner}


@router.get("/check", summary="诊断用户状态")
async def api_check(request: Request):
    """检查当前用户状态"""
    user = getattr(request.state, "user", None)
    auth = request.headers.get("Authorization", "")
    return {
        "has_user": user is not None,
        "username": user["username"] if user else None,
        "has_auth": bool(auth),
        "auth_prefix": auth[:20] if auth else "",
    }
