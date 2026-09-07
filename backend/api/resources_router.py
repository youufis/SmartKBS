"""
资源中心 API 路由
HTML 文件列表/上传/删除/导航
"""
import asyncio
import json
import os
import re
import shutil
import sqlite3
import urllib.parse
from typing import Any

from fastapi import APIRouter, HTTPException, Request, File, Form, Query
from fastapi.responses import HTMLResponse
from starlette.datastructures import UploadFile

from backend.api.dependencies import get_current_user
from backend.auth import can_manage_html_files, is_admin, is_teacher
from backend.config import ROOT_DIR, DEFAULT_LOGGED_IN_NAME, BASE_DIR
from backend.prompts.html_generator import build_html_prompt
from backend.utils import (
    normalize_rel_path,
    path_within,
    safe_join,
    get_account_html_dir,
    get_user_base_dir,
    ensure_teacher_html_files,
)
from backend.logger import logger

router = APIRouter()

ALLOWED_UPLOAD_EXTENSIONS = {
    '.html', '.htm', '.css', '.js', '.txt', '.md', '.json',
    '.jpg', '.jpeg', '.png', '.gif', '.bmp',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
}
MAX_UPLOAD_SIZE_MB = 5


# ── 文件列表 ──

@router.get("/list")
async def list_resources(request: Request):
    """获取当前用户的 HTML 文件列表"""
    from backend.config import BASE_DIR
    user = get_current_user(request)
    username = user["username"]
    html_dir = get_account_html_dir(username)
    os.makedirs(html_dir, exist_ok=True)

    files = []
    try:
        for fname in sorted(os.listdir(html_dir), key=str.lower):
            fpath = os.path.join(html_dir, fname)
            if os.path.isfile(fpath) and not fname.endswith(".json") and not fname.endswith(".js"):
                # 生成相对于项目根目录的路径（用于链接）
                rel_path = os.path.relpath(fpath, str(BASE_DIR)).replace("\\", "/")
                files.append({
                    "name": fname,
                    # T6: 前端用 path 做 key/重命名/删除参数, 只需相对 html 根, 不再泄露服务器绝对路径
                    "path": os.path.relpath(fpath, html_dir).replace("\\", "/"),
                    "url_path": rel_path,
                    "size": os.path.getsize(fpath),
                    "display_name": os.path.splitext(fname)[0],
                })
    except Exception as e:
        logger.error(f"获取资源列表失败: {e}")

    return {"files": files, "count": len(files)}


# ── 目录树 ──

_TREE_MAX_DEPTH = 8
_TREE_MAX_ENTRIES = 4000


def _scan_tree(dirpath: str, base_rel: str = "", with_meta: bool = True,
               _depth: int = 0, _budget: list | None = None) -> list[dict[str, Any]]:
    """扫描目录树; 限制深度与条目数, 避免大目录把响应撑到几百 KB 并卡住前端渲染。"""
    if _budget is None:
        _budget = [0, False]        # [剩余条目, 是否截断]
    entries: list[dict[str, Any]] = []
    if _depth >= _TREE_MAX_DEPTH:
        _budget[1] = True
        return entries
    try:
        names = sorted(os.listdir(dirpath), key=str.lower)
    except (PermissionError, OSError):
        return entries
    for name in names:
        if _budget[0] <= 0:
            _budget[1] = True
            break
        _budget[0] -= 1
        full = os.path.join(dirpath, name)
        rel = os.path.join(base_rel, name) if base_rel else name
        if os.path.isfile(full):
            try:
                stat = os.stat(full)
            except OSError:
                continue
            _, ext = os.path.splitext(name.lower())
            entry = {"title": name, "key": rel.replace("\\", "/"), "isLeaf": True}
            if with_meta:
                entry["size"] = stat.st_size
                entry["mtime"] = __import__("datetime").datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M")
                entry["ext"] = ext
            entries.append(entry)
        elif os.path.isdir(full):
            children = _scan_tree(full, rel, with_meta, _depth + 1, _budget)
            entries.append({"title": name, "key": rel.replace("\\", "/"), "isLeaf": False, "children": children})
    return entries


@router.get("/tree")
async def get_resource_tree(request: Request):
    """获取用户 HTML 目录的树形结构"""
    user = get_current_user(request)
    username = user["username"]
    html_dir = get_account_html_dir(username)
    if not os.path.exists(html_dir):
        return {"tree": []}
    budget = [_TREE_MAX_ENTRIES, False]
    tree = _scan_tree(html_dir, with_meta=True, _budget=budget)
    # T6: 不再返回服务器绝对路径(前端未使用)
    return {"tree": tree, "truncated": bool(budget[1])}


# ── 上传文件 ──

@router.post("/upload")
async def upload_resource(request: Request):
    """上传资源文件（仅管理员/教师）"""
    user = get_current_user(request)
    username = user["username"]

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员和教师可以上传")

    html_dir = get_account_html_dir(username)
    os.makedirs(html_dir, exist_ok=True)

    form = await request.form()
    uploaded = []
    errors = []

    file_items: dict[str, tuple[UploadFile, str]] = {}  # index -> (filename, subpath)
    # 第一轮：收集文件（subpath 初始为空，不依赖字段顺序）
    for key in form.keys():
        if key.startswith("file"):
            idx = key[4:]  # "file0" -> "0"
            item = form[key]
            if not isinstance(item, UploadFile) or not item.filename:
                continue
            file_items[idx] = (item, "")
    # 第二轮：合并子目录路径
    for key in form.keys():
        if key.startswith("path"):
            idx = key[4:]  # "path0" -> "0"
            if idx in file_items:
                _item, _fn = file_items[idx]
                sub_path = form[key] or ""
                assert isinstance(sub_path, str)
                file_items[idx] = (_item, sub_path)

    for idx, (item, subpath) in file_items.items():
        filename = item.filename or ''
        if not filename:
            continue

        # T1: 客户端可传 path<idx> 子目录, 必须规范化并禁止 ../ / 隐藏文件 / 绝对路径逃逸
        raw_rel = os.path.join(subpath, os.path.basename(filename)) if subpath else filename
        rel_path = normalize_rel_path(raw_rel)
        if not rel_path:
            errors.append(f"文件 '{filename}' 路径不合法（禁止上级目录或以 . 开头的名称）")
            continue

        # 检查扩展名
        _, ext = os.path.splitext(rel_path.lower())
        if ext not in ALLOWED_UPLOAD_EXTENSIONS:
            errors.append(f"文件 '{filename}' 类型不支持")
            continue

        # 检查大小
        content = await item.read()
        if len(content) > MAX_UPLOAD_SIZE_MB * 1024 * 1024:
            errors.append(f"文件 '{filename}' 超过 {MAX_UPLOAD_SIZE_MB}MB 限制")
            continue

        # 目标路径（含子目录）—— 必须仍在本次账户 html 目录内
        target_path = safe_join(html_dir, rel_path)
        if not target_path:
            errors.append(f"文件 '{filename}' 目标路径越界，已拒绝")
            continue
        os.makedirs(os.path.dirname(target_path), exist_ok=True)

        # 处理重名
        if os.path.exists(target_path):
            name, ext = os.path.splitext(os.path.basename(rel_path))
            timestamp = __import__("time").strftime("%Y%m%d_%H%M%S")
            new_name = f"{name}_{timestamp}{ext}"
            target_path = os.path.join(os.path.dirname(target_path), new_name)
            rel_path = os.path.join(os.path.dirname(rel_path), new_name)

        try:
            with open(target_path, "wb") as f:
                f.write(content)
            uploaded.append(rel_path)
        except Exception as e:
            errors.append(f"文件 '{filename}' 上传失败: {str(e)}")

    # 刷新教师资源同步
    ensure_teacher_html_files(username)

    msg = f"成功上传 {len(uploaded)} 个文件"
    if errors:
        msg += f"\n失败 {len(errors)} 个: {'; '.join(errors[:5])}"

    logger.info(f"资源上传: {username}, uploaded={len(uploaded)}, errors={len(errors)}")
    return {"message": msg, "uploaded": uploaded, "errors": errors[:10]}


# ── 删除文件 ──

@router.delete("/file")
async def delete_resource(request: Request, path: str = Query(...)):
    """删除资源文件或目录（仅管理员/教师）"""
    # T5: 鉴权与边界检查无条件执行(旧写法包在 `if request:` 内, 参数缺失即整体跳过)
    user = get_current_user(request)
    username = user["username"]

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员和教师可以删除")

    html_dir = os.path.abspath(get_account_html_dir(username))
    # 如果 path 是相对路径（来自树节点的 key），拼接到 html_dir
    if not os.path.isabs(path):
        target_path = os.path.abspath(os.path.join(html_dir, path))
    else:
        target_path = os.path.abspath(path)

    if not path_within(html_dir, target_path):
        raise HTTPException(status_code=403, detail="只能删除自己 HTML 目录下的文件")

    if not os.path.exists(target_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    try:
        if os.path.isfile(target_path):
            os.remove(target_path)
            msg = f"文件 {os.path.basename(target_path)} 已删除"
        elif os.path.isdir(target_path):
            shutil.rmtree(target_path)
            msg = f"目录 {os.path.basename(target_path)} 已删除"
        else:
            raise HTTPException(status_code=400, detail="路径不是文件也不是目录")

        logger.info(f"资源已删除: {target_path}")

        # 同步清理资源分组中的引用
        rel_path = path if not os.path.isabs(path) else os.path.relpath(target_path, html_dir)
        # 统一将路径分隔符转为正斜杠（数据库中用正斜杠）
        db_path = rel_path.replace("\\", "/")
        try:
            # 按统一后的规范路径匹配（含目录删除时的子树），避免旧格式匹配不到而残留引用
            purged = _purge_group_items_for_path(username, target_path)
            if purged:
                logger.info(f"已同步清理 {purged} 条资源分组引用: {db_path}")
        except Exception as cleanup_err:
            logger.warning(f"清理资源分组引用失败: {cleanup_err}")

        # 同步清理共享记录和关联的课程绑定
        try:
            from backend.database import execute_insert_update, execute_query_dict
            basename = os.path.basename(target_path)
            # 尝试多种路径格式匹配，确保能找到共享记录
            share_rows = execute_query_dict(
                """SELECT id FROM shared_resources
                   WHERE owner_username=? AND resource_type='html'
                   AND (file_path=? OR file_path=? OR file_path LIKE ? OR file_path LIKE ?)""",
                (username, db_path, basename, f"%/{db_path}", f"%/{basename}"),
            )
            if not share_rows:
                # 再试一次：用文件名后缀匹配（兼容路径格式差异）
                share_rows = execute_query_dict(
                    """SELECT id FROM shared_resources
                       WHERE owner_username=? AND resource_type='html'
                       AND file_path LIKE ?""",
                    (username, f"%{basename}"),
                )
            for row in share_rows:
                sid = row["id"]
                # 清理该共享关联的课程绑定
                execute_insert_update(
                    "DELETE FROM curriculum_bindings WHERE resource_type='html' AND resource_id=?",
                    (sid,),
                )
                # 清理资源查看日志
                try:
                    execute_insert_update(
                        "DELETE FROM resource_view_logs WHERE resource_id=? AND resource_type='html'",
                        (sid,),
                    )
                except Exception:
                    pass
                # 清理共享记录
                execute_insert_update(
                    "DELETE FROM shared_resources WHERE id=?",
                    (sid,),
                )
            if share_rows:
                logger.info(f"已同步清理 {len(share_rows)} 条共享记录及关联绑定")

            # ── 额外清理：如果文件名匹配 AI 练习模式 {kp_id}_*_练习.html，清理练习成绩 ──
            practice_match = re.match(r'^(\d+)_.*_练习\.html$', basename)
            if practice_match:
                kp_id = int(practice_match.group(1))
                from backend.question_db import execute_insert as q_exec_i
                q_exec_i("DELETE FROM ai_practice_results WHERE kp_id=?", (kp_id,))
                logger.info(f"已清理知识点 {kp_id} 的 AI 练习成绩记录")
        except Exception as cleanup_err:
            logger.warning(f"清理共享记录失败: {cleanup_err}")

        return {"message": msg}
    except Exception as e:
        logger.error(f"删除资源失败: {e}")
        raise HTTPException(status_code=500, detail=f"删除失败: {str(e)}")

    raise HTTPException(status_code=401, detail="未登录")


# ── 重命名 ──

@router.put("/rename")
async def rename_resource(request: Request):
    """重命名文件或目录（仅管理员/教师）"""
    user = get_current_user(request)
    username = user["username"]

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足")

    body = await request.json()
    path = body.get("path", "")
    new_name = body.get("new_name", "")

    if not path or not new_name:
        raise HTTPException(status_code=400, detail="缺少 path 或 new_name")
    if "/" in new_name or "\\" in new_name or ".." in new_name:
        raise HTTPException(status_code=400, detail="新名称不能包含路径分隔符")
    if new_name.startswith("."):
        raise HTTPException(status_code=400, detail="新名称不能以 . 开头")

    html_dir = os.path.abspath(get_account_html_dir(username))
    if not os.path.isabs(path):
        old_path = os.path.abspath(os.path.join(html_dir, path))
    else:
        old_path = os.path.abspath(path)

    # T2: 旧实现用 startswith, 兄弟目录 html_bypass 也能通过
    if not path_within(html_dir, old_path):
        raise HTTPException(status_code=403, detail="无权操作该文件")

    if not os.path.exists(old_path):
        raise HTTPException(status_code=404, detail="文件或目录不存在")

    new_path = os.path.join(os.path.dirname(old_path), new_name)
    if not path_within(html_dir, new_path):
        raise HTTPException(status_code=403, detail="目标位置超出资源目录范围")
    if os.path.exists(new_path):
        raise HTTPException(status_code=409, detail="目标名称已存在")

    try:
        os.rename(old_path, new_path)
        logger.info(f"资源已重命名: {old_path} -> {new_path}")

        # ── 同步更新数据库关联记录（共享记录 / 资源分组 / 资源元数据），
        #    避免重命名后旧名称残留、共享与绑定指向不存在的文件 ──
        synced_shares = synced_groups = 0
        try:
            from datetime import datetime as _dt
            from backend.database import execute_query_dict, execute_insert_update
            now = _dt.now().strftime("%Y-%m-%d %H:%M:%S")
            old_rel = os.path.relpath(old_path, html_dir).replace("\\", "/")
            new_rel = os.path.relpath(new_path, html_dir).replace("\\", "/")
            old_bn = os.path.basename(old_path)
            new_bn = os.path.basename(new_path)

            def _swap(fp: str) -> str:
                """把路径中指向旧名的尾段/目录段替换为新名，保持原存储格式"""
                fp = (fp or "").replace("\\", "/")
                for suffix in ("", "/"):
                    core = fp[: -1] if suffix else fp
                    if core.endswith(old_bn) and (core == old_bn or core[-len(old_bn) - 1] == "/"):
                        return fp[: len(core) - len(old_bn)] + new_bn + suffix
                if ("/" + old_bn + "/") in fp:
                    return fp.replace("/" + old_bn + "/", "/" + new_bn + "/", 1)
                if fp.startswith(old_bn + "/"):
                    return new_bn + fp[len(old_bn):]
                return fp

            new_display = new_bn
            for _ext in (".html", ".htm"):
                if new_display.lower().endswith(_ext):
                    new_display = new_display[: -len(_ext)]
                    break

            share_rows = execute_query_dict(
                """SELECT id, file_path FROM shared_resources
                   WHERE owner_username=?
                   AND (file_path=? OR file_path=? OR file_path LIKE ? OR file_path LIKE ?
                        OR file_path LIKE ? OR file_path LIKE ?)""",
                (username, old_rel, old_bn,
                 f"%/{old_rel}", f"%/{old_bn}",
                 f"{old_rel}/%", f"%/{old_rel}/%"),
            )
            for row in share_rows:
                fp = (row["file_path"] or "").replace("\\", "/")
                swapped = _swap(fp)
                if swapped == fp:
                    continue
                if os.path.basename(fp.rstrip("/")) == old_bn:
                    execute_insert_update(
                        "UPDATE shared_resources SET file_path=?, file_name=?, updated_at=? WHERE id=?",
                        (swapped, new_display, now, row["id"]),
                    )
                else:  # 目录改名下的子资源：仅调整路径前缀，保留自身显示名
                    execute_insert_update(
                        "UPDATE shared_resources SET file_path=?, updated_at=? WHERE id=?",
                        (swapped, now, row["id"]),
                    )
                synced_shares += 1

            # 资源分组引用：按统一后的规范路径重写（含目录改名下的子资源）
            synced_groups = _remap_group_items_after_rename(username, old_path, new_path)

            execute_insert_update(
                "UPDATE resource_meta SET file_path=?, file_name=?, updated_at=? WHERE file_path=? OR file_path=?",
                (new_bn, new_bn, now, old_bn, old_rel),
            )

            if synced_shares or synced_groups:
                logger.info(f"重命名同步: shares={synced_shares}, groups={synced_groups} ({old_bn} -> {new_bn})")
        except Exception as sync_err:
            logger.warning(f"重命名后同步数据库记录失败: {sync_err}")

        return {"message": f"已重命名为 {new_name}", "synced_shares": synced_shares, "synced_groups": synced_groups}
    except Exception as e:
        logger.error(f"重命名失败: {e}")
        raise HTTPException(status_code=500, detail=f"重命名失败: {str(e)}")


# ── 导航页 ──

def _rewrite_html_links(html_content: str, base_url: str, token: str = "") -> str:
    """重写 HTML 中的相对链接为可访问的绝对链接，并添加 target=_blank"""

    def _rewrite_attr(match):
        prefix = match.group(1)  # href="
        url = match.group(2)     # 链接值
        if url.startswith(("http://", "https://", "#", "javascript:", "data:", "mailto:")):
            return match.group(0)
        if url.startswith(("/api/", "/gradio_api/", "/uploads/")):
            # 已是绝对路径，加 target
            return f'{prefix}{url}" target="_blank"'
        # 重写相对路径为绝对路径并加 target（Cookie 自动认证，无需 URL token）
        return f'{prefix}{base_url}{url}" target="_blank"'

    # 先处理已有的 target，避免重复
    html_content = re.sub(r'\s+target="[^"]*"', '', html_content)
    # 重写所有链接
    html_content = re.sub(r'(href=")([^"]*)(")', _rewrite_attr, html_content)
    html_content = re.sub(r"(data-href=')([^']*)(')", _rewrite_attr, html_content)
    html_content = re.sub(r'(data-href=")([^"]*)(")', _rewrite_attr, html_content)
    return html_content


@router.get("/nav")
async def get_nav_html(request: Request):
    """获取导航页 HTML 内容（需登录，展示对应用户的资源）"""
    user = request.state.user
    if not user:
        return HTMLResponse(content="""<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>请登录</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;color:#999;text-align:center}
</style></head>
<body><div><h2>🔒 请先登录</h2><p>您需要登录后才能查看自己的资源。</p></div></body></html>""")

    username = user["username"]
    html_dir = get_account_html_dir(username)
    index_path = os.path.join(html_dir, "index.html")

    try:
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                content = f.read()
            # 机器生成的历史落盘页 → 删除文件并迁移为动态生成。
            # 需同时命中自动标记，或（旧版页脚 + 旧版主标题）双重特征，避免误删用户自定义文件
            is_auto = (_NAV_AUTO_MARK in content) or (
                ("SmartKB 资源中心" in content) and ("<h1>\U0001F4DA 资源中心</h1>" in content)
            )
            if is_auto:
                try:
                    os.remove(index_path)
                    logger.info(f"资源中心导航页迁移为动态生成，已删除旧自动文件: {index_path}")
                except OSError as rm_err:
                    logger.warning(f"删除旧自动导航页失败: {rm_err}")
            else:
                # 用户自定义 index.html → 继续原样服务（重写相对链接）
                base_url_path = html_dir.replace("\\", "/") + "/"
                base_url = "/api/files/" + urllib.parse.quote(base_url_path)
                content = _rewrite_html_links(content, base_url)
                return HTMLResponse(content=content)
        # 默认导航：每次按当前文件实时生成、直接返回，不再落盘
        return HTMLResponse(content=_generate_default_nav_html(html_dir))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"加载导航页失败: {str(e)}")


_NAV_AUTO_MARK = "<!-- smartkb-nav:auto v2 -->"

# 扩展名 -> 文件类型图标（资源中心导航页）
_NAV_ICON_MAP = {
    ".html": "\U0001F310", ".htm": "\U0001F310",
    ".png": "\U0001F5BC\uFE0F", ".jpg": "\U0001F5BC\uFE0F", ".jpeg": "\U0001F5BC\uFE0F",
    ".gif": "\U0001F5BC\uFE0F", ".bmp": "\U0001F5BC\uFE0F", ".webp": "\U0001F5BC\uFE0F",
    ".svg": "\U0001F5BC\uFE0F", ".ico": "\U0001F5BC\uFE0F", ".tiff": "\U0001F5BC\uFE0F",
    ".mp4": "\U0001F3AC", ".avi": "\U0001F3AC", ".mov": "\U0001F3AC", ".wmv": "\U0001F3AC",
    ".flv": "\U0001F3AC", ".mkv": "\U0001F3AC", ".webm": "\U0001F3AC",
    ".mp3": "\U0001F3B5", ".wav": "\U0001F3B5", ".flac": "\U0001F3B5", ".aac": "\U0001F3B5",
    ".ogg": "\U0001F3B5", ".m4a": "\U0001F3B5",
    ".pdf": "\U0001F4D5",
    ".doc": "\U0001F4D8", ".docx": "\U0001F4D8",
    ".xls": "\U0001F4D7", ".xlsx": "\U0001F4D7", ".csv": "\U0001F4D7",
    ".ppt": "\U0001F4D9", ".pptx": "\U0001F4D9",
    ".txt": "\U0001F4DD", ".md": "\U0001F4DD",
    ".zip": "\U0001F4E6", ".rar": "\U0001F4E6", ".7z": "\U0001F4E6", ".tar": "\U0001F4E6", ".gz": "\U0001F4E6",
    ".py": "\U0001F40D", ".java": "\u2615", ".go": "\U0001F537", ".rs": "\U0001F980",
    ".c": "\U0001F9E9", ".cpp": "\U0001F9E9", ".h": "\U0001F9E9",
}

# 资源包辅助文件 / 配置文件，不作为独立资源展示
_NAV_SKIP_EXT = {".js", ".css", ".map"}


def _nav_icon_for(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    return _NAV_ICON_MAP.get(ext, "\U0001F4C4")


def _generate_default_nav_html(html_dir: str = "") -> str:
    """生成默认导航页：列出目录中生成/上传的资源文件，按扩展名显示类型图标"""
    import html as _html
    body_section = ""
    if html_dir and os.path.exists(html_dir):
        from backend.config import BASE_DIR
        files = [
            f for f in os.listdir(html_dir)
            if os.path.isfile(os.path.join(html_dir, f))
            and f != "index.html"
            and not f.startswith(".")
            and os.path.splitext(f)[1].lower() not in _NAV_SKIP_EXT
        ]
        # HTML 资源在前，其余文件在后，各自按名称排序
        files.sort(key=lambda f: (0 if f.lower().endswith((".html", ".htm")) else 1, f.lower()))
        if files:
            cards = []
            for f in files:
                rel = os.path.relpath(os.path.join(html_dir, f), str(BASE_DIR)).replace("\\", "/")
                display = _html.escape(os.path.splitext(f)[0])
                icon = _nav_icon_for(f)
                href = "/api/files/" + urllib.parse.quote(rel)
                cards.append(
                    f'<a href="{href}" target="_blank" class="card" title="{display}">'
                    f'<span class="ic">{icon}</span><span class="nm">{display}</span></a>'
                )
            body_section = (
                f'<h2>\U0001F4DA 我的资源（{len(files)}）</h2>'
                f'<div class="grid">{"".join(cards)}</div>'
            )

    return f"""{_NAV_AUTO_MARK}
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>资源中心</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:960px;margin:0 auto;padding:30px 20px;color:#333}}
h1{{color:#1677ff;border-bottom:2px solid #1677ff;padding-bottom:10px}}
h2{{font-size:1.05em;color:#555;margin:18px 0 10px}}
.tip{{background:#e8f0fe;border-left:4px solid #1677ff;padding:14px 18px;margin:20px 0;border-radius:0 4px 4px 0}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin:16px 0}}
.card{{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#fafafa;border:1px solid #e8e8e8;border-radius:6px;text-decoration:none;color:#333;font-size:14px;transition:all .2s;min-width:0}}
.card:hover{{background:#e6f4ff;border-color:#1677ff;transform:translateY(-1px);box-shadow:0 2px 6px rgba(22,119,255,0.1)}}
.card .ic{{font-size:18px;flex:none;line-height:1}}
.card .nm{{word-break:break-all;white-space:normal}}
.footer{{margin-top:40px;font-size:.85em;color:#888;text-align:center}}
</style>
</head>
<body>
<h1>\U0001F4DA 资源中心</h1>
<div class="tip"><strong>\U0001F4A1 提示：</strong>点击下方资源文件可在新标签页中打开查看；图标按文件类型自动匹配。</div>
{body_section if body_section else '<p style="color:#999;text-align:center;padding:40px">暂无资源文件，请在「资源管理」中上传或使用 AI 生成。</p>'}
<div class="footer"><p>此页面由系统自动生成并随文件变化更新 · SmartKB</p></div>
</body>
</html>"""


# ═══════════════════════════════════════════════
# 资源分组管理 API
# ═══════════════════════════════════════════════

import time
from backend.database import (
    execute_query, execute_insert_update, execute_batch, get_connection, get_transaction,
)


# ── 分组内资源路径统一（收敛为 url_path 格式）+ 残留清理 ──
#
# 分组条目 file_path 历史上并存过 4 种写法：相对项目根(前端 url_path, 正确格式)、
# 相对 html 目录(资源管理树节点 key)、纯文件名、服务器绝对路径。
# 混用导致两类问题：① 删除/重命名后按单一格式匹配不到 -> 引用残留；
# ② 侧栏分组计数(数据库行数) 与右侧真实可见资源数不一致。
# 下面统一收敛为「相对项目根的 POSIX 路径」，与前端 url_path 完全一致。

def _html_root_rel(username: str) -> str:
    """当前用户 html 根目录相对项目根的 POSIX 路径, 如 root/html、stu/张三/html"""
    html_dir = os.path.abspath(get_account_html_dir(username))
    return os.path.relpath(html_dir, str(BASE_DIR)).replace("\\", "/")


def _resolve_group_path(raw: str, root_rel: str) -> tuple[str, bool, bool]:
    """把任意写法的路径统一为「相对项目根的 POSIX 路径」。

    返回 (规范路径, 目标是否存在, 是否能落在项目根内)。
    第三个返回值为 False 表示无法判定(项目根之外/URL 等), 调用方不得据此删除数据。
    """
    fp = (raw or "").strip().replace("\\", "/")
    if not fp:
        return "", False, False
    if "://" in fp:  # 外链等异常存量数据, 原样保留
        return fp, False, False
    base = str(BASE_DIR)
    if os.path.isabs(fp) or re.match(r"^[A-Za-z]:[/\\]", fp):
        abs_p = os.path.normpath(fp)
    else:
        rel = fp.lstrip("/")
        parts = rel.split("/")
        inside_root = bool(root_rel) and (rel == root_rel or rel.startswith(root_rel + "/"))
        if not inside_root and "/" in rel and os.path.exists(os.path.join(base, *parts)):
            inside_root = True  # 已是相对项目根的写法(可能指向其他账号目录/共享资源)
        if inside_root:
            abs_p = os.path.normpath(os.path.join(base, *parts))
        else:
            # 相对 html 目录或纯文件名 -> 补全本用户 html 根前缀
            joined = f"{root_rel}/{rel}" if root_rel else rel
            abs_p = os.path.normpath(os.path.join(base, *joined.split("/")))
    try:
        rel_out = os.path.relpath(abs_p, base).replace("\\", "/")
    except ValueError:  # 跨盘符等, 无法相对化
        return fp, os.path.exists(abs_p), False
    if rel_out.startswith(".."):
        return fp, os.path.exists(abs_p), False
    return rel_out, os.path.exists(abs_p), True


def _group_item_rows(username: str) -> list[tuple[int, int, str]]:
    """一次取出该用户全部分组条目 (group_id, item_id, file_path), 避免 N+1 查询"""
    return execute_query(
        """SELECT i.group_id, i.id, i.file_path
           FROM resource_group_items i
           JOIN resource_groups g ON g.id = i.group_id
           WHERE g.username=?
           ORDER BY i.group_id, i.sort_order, i.id""",
        (username,),
    )


def _group_existing_paths(username: str) -> dict[int, list[str]]:
    """分组 ID -> 规范化且真实存在的资源路径列表。

    顺带自愈存量脏数据：删除指向已不存在资源的残留引用、合并同一资源的重复
    不同写法引用, 并把保留下来的路径统一成规范格式, 使「个数」与「列表」一致。
    """
    html_dir = os.path.abspath(get_account_html_dir(username))
    root_rel = _html_root_rel(username)
    # html 目录缺失或为空时不做删除, 避免挂载/同步/新部署异常时误清用户的分组数据
    try:
        can_purge = os.path.isdir(html_dir) and bool(os.listdir(html_dir))
    except OSError:
        can_purge = False

    paths_by_group: dict[int, list[str]] = {}
    del_ids: list[int] = []
    norm_ops: list[tuple[str, tuple]] = []
    for gid, iid, raw in _group_item_rows(username):
        raw_norm = (raw or "").strip().replace("\\", "/")
        canon, exists, resolved = _resolve_group_path(raw_norm, root_rel)
        if can_purge and resolved and not exists:
            del_ids.append(iid)  # 残留: 资源已被删除/改名, 引用失效
            continue
        seen = paths_by_group.setdefault(gid, [])
        key = canon or raw_norm
        if key and key in seen:
            del_ids.append(iid)  # 残留: 同一资源被多种写法重复引用
            continue
        seen.append(key)
        if resolved and canon and canon != raw_norm:
            norm_ops.append(("UPDATE resource_group_items SET file_path=? WHERE id=?", (canon, iid)))

    if del_ids or norm_ops:
        try:
            execute_batch(
                [("DELETE FROM resource_group_items WHERE id=?", (iid,)) for iid in del_ids] + norm_ops
            )
            logger.info(f"资源分组引用自愈: user={username} 清理残留={len(del_ids)} 路径统一={len(norm_ops)}")
        except Exception as e:
            logger.warning(f"资源分组引用自愈失败: {e}")
    return paths_by_group


def _purge_group_items_for_path(username: str, target_abs: str) -> int:
    """删除指向 target_abs（文件或目录, 含其子树）的分组引用, 返回删除条数"""
    root_rel = _html_root_rel(username)
    tgt = os.path.normpath(target_abs)
    base = str(BASE_DIR)
    hit_ids: list[int] = []
    for _gid, iid, raw in _group_item_rows(username):
        canon, _exists, resolved = _resolve_group_path((raw or "").strip(), root_rel)
        if not resolved or not canon:
            continue
        abs_p = os.path.normpath(os.path.join(base, *canon.split("/")))
        if abs_p == tgt or abs_p.startswith(tgt + os.sep):
            hit_ids.append(iid)
    if hit_ids:
        execute_batch([("DELETE FROM resource_group_items WHERE id=?", (iid,)) for iid in hit_ids])
    return len(hit_ids)


def _remap_group_items_after_rename(username: str, old_abs: str, new_abs: str) -> int:
    """资源/目录改名后同步分组内引用路径, 避免旧名称残留"""
    base = str(BASE_DIR)
    try:
        old_canon = os.path.relpath(os.path.normpath(old_abs), base).replace("\\", "/")
        new_canon = os.path.relpath(os.path.normpath(new_abs), base).replace("\\", "/")
    except ValueError:
        return 0
    if old_canon == new_canon:
        return 0
    root_rel = _html_root_rel(username)
    ops: list[tuple[int, str]] = []
    for _gid, iid, raw in _group_item_rows(username):
        canon, _exists, resolved = _resolve_group_path((raw or "").strip(), root_rel)
        if not resolved or not canon:
            continue
        if canon == old_canon:
            ops.append((iid, new_canon))
        elif canon.startswith(old_canon + "/"):
            ops.append((iid, new_canon + canon[len(old_canon):]))
    if not ops:
        return 0
    synced = 0
    with get_transaction() as conn:
        cur = conn.cursor()
        for item_id, new_path in ops:
            try:
                cur.execute("UPDATE resource_group_items SET file_path=? WHERE id=?", (new_path, item_id))
            except sqlite3.IntegrityError:
                # 改名后与分组内已有条目重复(UNIQUE(group_id, file_path)) -> 合并为一条
                cur.execute("DELETE FROM resource_group_items WHERE id=?", (item_id,))
            synced += 1
    return synced


def _find_group_name_conflict(username: str, group_name: str, exclude_id: int | None = None):
    """同名分组检查（大小写不敏感, 与用户认知一致）, 返回冲突分组 (id, name) 或 None"""
    rows = execute_query(
        "SELECT id, group_name FROM resource_groups WHERE username=? AND LOWER(group_name)=LOWER(?)",
        (username, group_name),
    )
    for gid, gname in rows:
        if exclude_id is None or gid != exclude_id:
            return (gid, gname)
    return None


@router.get("/groups")
async def list_groups(request: Request):
    """获取当前用户的所有资源分组及包含的文件（已统一路径格式并剔除失效引用）"""
    user = get_current_user(request)
    username = user["username"]

    groups = execute_query(
        "SELECT id, group_name, sort_order FROM resource_groups WHERE username=? ORDER BY sort_order, id",
        (username,),
    )
    paths_by_group = _group_existing_paths(username)
    result = []
    for gid, gname, sort in groups:
        files = paths_by_group.get(gid, [])
        result.append({
            "id": gid,
            "group_name": gname,
            "sort_order": sort,
            "files": files,
            "file_count": len(files),
        })
    return {"groups": result}


@router.post("/groups")
async def create_group(request: Request):
    """创建新分组"""
    user = get_current_user(request)
    username = user["username"]
    body = await request.json()
    group_name = (body.get("group_name") or "").strip()
    if not group_name:
        raise HTTPException(status_code=400, detail="分组名称不能为空")

    if _find_group_name_conflict(username, group_name):
        raise HTTPException(status_code=409, detail=f"分组 '{group_name}' 已存在，请换一个名称")

    now = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        gid = execute_insert_update(
            "INSERT INTO resource_groups (username, group_name, sort_order, created_at) VALUES (?, ?, ?, ?)",
            (username, group_name, 0, now),
        )
    except sqlite3.IntegrityError:
        # 并发创建的兜底(UNIQUE(username, group_name)), 统一转成业务错误而不是 500
        raise HTTPException(status_code=409, detail=f"分组 '{group_name}' 已存在，请换一个名称")
    logger.info(f"资源分组创建: {username}/{group_name}")
    return {"message": f"分组 '{group_name}' 已创建", "id": gid, "group_name": group_name}


@router.put("/groups/reorder")
async def reorder_groups(request: Request):
    """调整分组排序（传入分组 ID 数组，按数组顺序更新 sort_order）"""
    user = get_current_user(request)
    username = user["username"]
    body = await request.json()
    group_ids = body.get("group_ids", [])
    if not group_ids:
        raise HTTPException(status_code=400, detail="group_ids 不能为空")

    ops = []
    for idx, gid in enumerate(group_ids):
        ops.append((
            "UPDATE resource_groups SET sort_order=? WHERE id=? AND username=?",
            (idx, gid, username),
        ))
    execute_batch(ops)
    logger.info(f"分组排序已更新: {username}, order={group_ids}")
    return {"message": "排序已更新"}


@router.put("/groups/{group_id}")
async def rename_group(group_id: int, request: Request):
    """重命名分组"""
    user = get_current_user(request)
    username = user["username"]
    body = await request.json()
    new_name = (body.get("group_name") or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="分组名称不能为空")

    # 验证分组属于当前用户
    rows = execute_query(
        "SELECT group_name FROM resource_groups WHERE id=? AND username=?",
        (group_id, username),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="分组不存在")
    old_name = rows[0][0]
    if old_name == new_name:
        # 幂等：同名提交(未做任何修改)直接返回成功, 不再触发唯一约束
        return {"message": f"分组名称未变更", "group_name": new_name, "id": group_id}

    # 同名检测（大小写不敏感）：提前给出友好提示, 避免撞上 UNIQUE(username, group_name)
    if _find_group_name_conflict(username, new_name, exclude_id=group_id):
        raise HTTPException(status_code=409, detail=f"分组 '{new_name}' 已存在，请换一个名称")

    try:
        execute_insert_update(
            "UPDATE resource_groups SET group_name=? WHERE id=? AND username=?",
            (new_name, group_id, username),
        )
    except sqlite3.IntegrityError:
        # 并发改名的兜底: 转成业务错误, 不再抛 sqlite3.IntegrityError -> 500
        raise HTTPException(status_code=409, detail=f"分组 '{new_name}' 已存在，请换一个名称")
    logger.info(f"资源分组重命名: {username}/{group_id} {old_name} -> {new_name}")
    return {"message": f"已重命名为 '{new_name}'", "group_name": new_name, "id": group_id}


@router.delete("/groups/{group_id}")
async def delete_group(group_id: int, request: Request):
    """删除分组（不删除资源文件）"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        "SELECT id FROM resource_groups WHERE id=? AND username=?",
        (group_id, username),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="分组不存在")

    # 删除分组及关联记录
    execute_batch([
        ("DELETE FROM resource_group_items WHERE group_id=?", (group_id,)),
        ("DELETE FROM resource_groups WHERE id=?", (group_id,)),
    ])
    logger.info(f"资源分组删除: {username}/{group_id}")
    return {"message": "分组已删除"}


@router.post("/groups/{group_id}/items")
async def add_to_group(group_id: int, request: Request):
    """将资源添加到分组"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        "SELECT id FROM resource_groups WHERE id=? AND username=?",
        (group_id, username),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="分组不存在")

    body = await request.json()
    raw_path = (body.get("file_path") or "").strip()
    if not raw_path:
        raise HTTPException(status_code=400, detail="file_path 不能为空")

    # 入库前统一路径格式, 同一资源不再因写法不同产生重复引用
    root_rel = _html_root_rel(username)
    canon, exists, resolved = _resolve_group_path(raw_path, root_rel)
    if not resolved or not exists:
        raise HTTPException(status_code=400, detail="资源不存在，请刷新后重试")
    # 只能分组自己 html 目录内的资源, 避免 ../ 等越界路径入库
    abs_target = os.path.join(str(BASE_DIR), *canon.split("/"))
    if not path_within(os.path.abspath(get_account_html_dir(username)), abs_target):
        raise HTTPException(status_code=400, detail="只能将本人资源目录内的资源加入分组")

    now = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        execute_insert_update(
            "INSERT OR IGNORE INTO resource_group_items (group_id, file_path, sort_order, created_at) VALUES (?, ?, ?, ?)",
            (group_id, canon, 0, now),
        )
        logger.info(f"资源加入分组: {username}/group={group_id}, file={canon}")
        return {"message": "已添加到分组", "file_path": canon}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"添加失败: {str(e)}")


@router.delete("/groups/{group_id}/items")
async def remove_from_group(group_id: int, request: Request):
    """从分组中移除资源"""
    user = get_current_user(request)
    username = user["username"]

    rows = execute_query(
        "SELECT id FROM resource_groups WHERE id=? AND username=?",
        (group_id, username),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="分组不存在")

    body = await request.json()
    raw_path = (body.get("file_path") or "").strip()
    if not raw_path:
        raise HTTPException(status_code=400, detail="file_path 不能为空")

    # 按统一后的路径匹配, 兼容存量旧格式引用, 避免"点了移除但记录还在"导致计数不变
    root_rel = _html_root_rel(username)
    target = _resolve_group_path(raw_path, root_rel)[0] or raw_path.replace("\\", "/")
    item_rows = execute_query(
        "SELECT id, file_path FROM resource_group_items WHERE group_id=?", (group_id,)
    )
    hit_ids = [
        iid for iid, fp in item_rows
        if (fp or "").strip().replace("\\", "/") == raw_path.replace("\\", "/")
        or (_resolve_group_path((fp or "").strip(), root_rel)[0] or (fp or "")) == target
    ]
    if hit_ids:
        execute_batch([("DELETE FROM resource_group_items WHERE id=?", (iid,)) for iid in hit_ids])
    logger.info(f"资源移出分组: {username}/group={group_id}, file={target}, removed={len(hit_ids)}")
    return {"message": "已从分组移除", "removed": len(hit_ids)}


# ═══════════════════════════════════════════════
# AI 生成 HTML 资源（预览 + 保存）
# ═══════════════════════════════════════════════

def _sanitize_filename(name: str) -> str:
    """清理文件名，移除不安全字符"""
    name = re.sub(r'[\\/:*?"<>|]', '_', name)
    name = re.sub(r'\s+', '', name)
    return name[:80]


def _extract_html_title(html_content: str) -> str:
    """从 HTML 中提取 <title> 内容"""
    m = re.search(r'<title[^>]*>(.*?)</title>', html_content, re.DOTALL)
    if m:
        return m.group(1).strip()
    return ""


@router.get("/ai-themes")
async def get_ai_themes(type: str = Query("animation", description="资源类型: animation/quiz/practice/custom/interactive")):
    """获取指定资源类型的可选视觉主题列表"""
    from backend.prompts.html_generator import get_themes_for_type
    themes = get_themes_for_type(type)
    return {"themes": themes, "type": type}


# ── 题库取题 ──

def _fetch_matching_questions(topic: str, subject: str = "",
                               limit: int = 15,
                               need_types: tuple[str, ...] = ('single', 'true_false')) -> list[dict]:
    """从 question_bank 检索与主题匹配的试题，按知识点匹配优先"""
    try:
        from backend.question_db import execute_query
        keywords = _extract_keywords(topic)
        if subject:
            keywords.append(subject)

        seen = set()
        results = []
        for kw in keywords[:5]:
            like = f"%{kw}%"
            rows = execute_query(
                """SELECT id, type, question_text, options, correct_answer,
                          explanation, knowledge_points, difficulty,
                          svg_content, has_svg, media_files
                   FROM question_bank
                   WHERE (question_text LIKE ? OR knowledge_points LIKE ? OR subject LIKE ?)
                   AND status = 'active'
                   ORDER BY id DESC
                   LIMIT ?""",
                (like, like, like, limit * 2),
            )
            for r in rows:
                qid = r["id"]
                if qid not in seen and r["type"] in need_types:
                    seen.add(qid)
                    # 解析 options JSON
                    opts = r.get("options")
                    if opts and isinstance(opts, str):
                        try:
                            r["options"] = json.loads(opts)
                        except (json.JSONDecodeError, TypeError):
                            r["options"] = {}
                    results.append(r)
                    if len(results) >= limit:
                        return results
        return results
    except Exception as e:
        logger.warning(f"题库检索失败: {e}")
        return []


def _extract_keywords(text: str) -> list[str]:
    """从文本中提取关键词"""
    import re
    stop_words = {"的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
                  "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
                  "会", "着", "没有", "看", "好", "自己", "这", "他", "她", "它",
                  "们", "那", "些", "能", "下", "过", "出", "来", "么", "个",
                  "里", "后", "前", "从", "被", "把", "让", "对", "与", "为",
                  "以", "及", "但", "而", "或", "如果", "因为", "所以", "可以",
                  "什么", "怎么", "如何", "哪些", "为何", "怎样", "啥"}
    # 按中英文标点/空格拆分
    tokens = re.split(r'[\s,，。；：、！？（）()【】\[\]{}""""''\/\\+＝=#@&*%]', text)
    result = []
    for t in tokens:
        t = t.strip()
        if len(t) >= 2 and t not in stop_words:
            result.append(t)
    if not result:
        result = [text.strip()] if text.strip() else []
    return result


def _save_questions_to_db(questions: list[dict], username: str, name: str = "") -> int:
    """将题目列表保存到 question_bank，返回保存数量"""
    import time
    from backend.question_db import execute_insert
    saved = 0
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    for q in questions:
        try:
            qid = execute_insert(
                """INSERT INTO question_bank
                   (type, question_text, options, correct_answer, explanation,
                    knowledge_points, subject, difficulty, creator_username, creator_name,
                    source, svg_content, has_svg, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, 'active', ?, ?)""",
                (
                    q.get("type", "single"),
                    q.get("question_text", ""),
                    json.dumps(q.get("options", {}), ensure_ascii=False) if q.get("options") else "",
                    q.get("correct_answer", ""),
                    q.get("explanation", ""),
                    q.get("knowledge_points", ""),
                    q.get("subject", ""),
                    q.get("difficulty", "medium"),
                    username,
                    name,
                    q.get("svg_content", ""),
                    1 if q.get("svg_content") else 0,
                    now, now,
                ),
            )
            if qid:
                saved += 1
        except Exception as e:
            logger.warning(f"保存题目到题库失败: {e}")
    return saved


@router.post("/ai-preview")
async def ai_preview_html(request: Request):
    """AI 生成 HTML 资源预览（不保存，返回 HTML 内容）
    
    题目来源策略（quiz/practice 类型）：
    1. 优先从 question_bank 检索匹配的试题
    2. 检索到的试题直接嵌入 HTML
    3. 若试题不够，AI 补充生成缺少的题目
    4. AI 新生成的题目自动存入 question_bank
    """
    user = get_current_user(request)
    username = user["username"]

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员和教师可以生成资源")

    body = await request.json()
    gen_type = body.get("type", "custom")  # animation / quiz / practice / custom / interactive
    topic = body.get("topic", "").strip()
    subject = body.get("subject", "").strip()
    grade = body.get("grade", "").strip()
    custom_prompt = body.get("custom_prompt", "").strip()
    theme = body.get("theme", "").strip()
    experiment_params = body.get("experiment_params", {})
    enable_media = body.get("enable_media", True)

    # 校验
    if gen_type == "custom":
        if not custom_prompt:
            raise HTTPException(status_code=400, detail="自定义类型需要提供 custom_prompt")
    elif gen_type == "interactive":
        # 交互式类型：topic 或 custom_prompt 至少有一个
        if not topic and not custom_prompt:
            raise HTTPException(status_code=400, detail="请输入实验/交互主题或自定义需求")
        # 如果有 experiment_params，附加到 custom_prompt
        if experiment_params and isinstance(experiment_params, dict):
            extra = "\n【用户指定的实验参数】\n"
            for k, v in experiment_params.items():
                extra += f"- {k}: {v}\n"
            custom_prompt = (custom_prompt or "") + extra
    elif not topic:
        raise HTTPException(status_code=400, detail="请输入知识点/主题")

    # 获取 API Key
    from backend.api.chat_router import get_api_keys
    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置，请在系统配置中设置")

    # RAG 检索相关知识
    rag_context = ""
    try:
        from backend.rag import retrieve_knowledge
        rag_context = retrieve_knowledge(topic, username)
    except Exception as e:
        logger.warning(f"RAG 检索失败（不影响生成）: {e}")
        rag_context = ""

    # ── 题库取题（仅 quiz/practice / interactive 类型）──
    real_questions = []
    user_name = user.get("name", "")
    if gen_type in ("quiz", "practice"):
        need_types = ('single', 'true_false', 'multiple')
        q_limit = 15 if gen_type == "practice" else 10
        real_questions = _fetch_matching_questions(topic, subject, limit=q_limit, need_types=need_types)
        logger.info(f"从题库检索到 {len(real_questions)} 道与「{topic}」相关的题目")

    # 构建 Prompt（含真实题目数据）
    prompt = build_html_prompt(
        prompt_type=gen_type,
        topic=topic,
        rag_context=rag_context,
        subject=subject,
        grade=grade,
        custom_prompt=custom_prompt,
        theme=theme,
        real_questions=real_questions,  # 传入真实题目
    )

    # ── 技能增强 ──
    from backend.prompts import apply_skills
    prompt = apply_skills(prompt, "html-generation")

    # 调用 AI
    try:
        from backend.api.ai_service import call_ai_sync_with_timeout
        logger.info(f"开始 AI 生成 HTML, 类型={gen_type}, 主题={topic}, prompt长度={len(prompt)}")
        html_content = await call_ai_sync_with_timeout(prompt, api_key, timeout=300)
        logger.info(f"AI 生成完成, 内容长度={len(html_content) if html_content else 0}")
    except TimeoutError as e:
        logger.error(f"AI 生成超时: {e}")
        raise HTTPException(status_code=504, detail=f"AI 生成超时，请简化描述或稍后重试")
    except Exception as e:
        logger.error(f"AI 生成 HTML 失败: {e}")
        raise HTTPException(status_code=502, detail=f"AI 生成失败: {str(e)}")

    if not html_content or len(html_content.strip()) < 50:
        raise HTTPException(status_code=502, detail="AI 返回内容为空或过短，请重试")

    # 提取纯 HTML
    html_match = re.search(r'```(?:html)?\s*(\<!DOCTYPE html\>.*?)\s*```', html_content, re.DOTALL | re.IGNORECASE)
    if html_match:
        html_content = html_match.group(1).strip()
    else:
        doctype_match = re.search(r'(\<!DOCTYPE html\>.*)', html_content, re.DOTALL | re.IGNORECASE)
        if doctype_match:
            html_content = doctype_match.group(1).strip()

    # ── 保存 AI 新生成的题目到题库 ──
    new_saved = 0
    if gen_type in ("quiz", "practice"):
        try:
            # 从 HTML 中提取 AI 生成的新题目
            new_questions = _extract_questions_from_html(html_content, real_questions, topic, subject)
            if new_questions:
                new_saved = _save_questions_to_db(new_questions, username, user_name)
                if new_saved:
                    logger.info(f"AI 生成的 {new_saved} 道新题目已保存到题库")
        except Exception as e:
            logger.warning(f"保存 AI 题目到题库失败（不影响结果）: {e}")

    # ── SVG + 图片配图增强（仅交互/自定义类型需要，简单资源跳过） ──
    if enable_media and gen_type in ("interactive", "custom"):
        try:
            from backend.api.image_gen_service import plan_and_generate_media
            html_dir = get_account_html_dir(username)
            enhanced_html = await plan_and_generate_media(
                html_content=html_content,
                topic=topic or custom_prompt or "",
                subject=subject,
                resource_type=gen_type,
                api_key=api_key,
                html_dir=html_dir,
            )
            if enhanced_html and len(enhanced_html) > len(html_content):
                logger.info(f"配图增强完成: {len(enhanced_html) - len(html_content)} chars 新增")
                html_content = enhanced_html
        except ImportError:
            logger.debug("image_gen_service 中未找到 plan_and_generate_media")
        except Exception as e:
            logger.warning(f"配图增强失败（不影响主结果）: {e}")

    # 生成建议文件名
    title = _extract_html_title(html_content)
    type_labels = {"animation": "动画讲解", "quiz": "互动答题", "practice": "练习题", "custom": "自定义", "interactive": "实验交互"}
    type_label = type_labels.get(gen_type, "HTML资源")
    if title:
        suggested_name = f"{_sanitize_filename(title)}_{type_label}.html"
    elif topic:
        suggested_name = f"{_sanitize_filename(topic)}_{type_label}.html"
    else:
        suggested_name = f"AI生成_{type_label}_{int(time.time())}.html"

    result = {
        "html_content": html_content,
        "suggested_name": suggested_name,
        "type_label": type_label,
    }
    if new_saved:
        result["db_saved"] = new_saved

    return result


def _extract_questions_from_html(html_content: str,
                                  existing_questions: list[dict],
                                  topic: str, subject: str) -> list[dict]:
    """从生成的 HTML 中提取 AI 新增的题目（排除已有题库题目）
    
    通过解析 HTML 中的 JavaScript 题目数据（QUESTION_BANK / questions 数组）
    与已有的题库题目对比，找出 AI 新生成的题目。
    """
    # 跳过 animation 和 custom 类型
    if not html_content or "<!DOCTYPE" not in html_content:
        return []

    # 构建已有题目的指纹集合（用于去重）
    existing_fingerprints = set()
    for q in existing_questions:
        text = q.get("question_text", "")[:50]
        ans = q.get("correct_answer", "")
        existing_fingerprints.add(f"{text}|{ans}")

    new_questions = []

    # 尝试匹配 quiz 格式: const QUESTION_BANK = [...] 或 const questions = [...]
    import json as _json
    qb_match = re.search(
        r'(?:const|let|var)\s+(?:QUESTION_BANK|questions)\s*=\s*(\[)',
        html_content,
    )
    if qb_match:
        try:
            # 手动查找匹配的闭合 ]（处理嵌套 []）
            start = qb_match.start(1)
            depth = 0
            end = start
            for i in range(start, len(html_content)):
                ch = html_content[i]
                if ch == '[':
                    depth += 1
                elif ch == ']':
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        break
                elif ch == '"' or ch == "'":
                    # 跳过字符串中的内容
                    quote = ch
                    i += 1
                    while i < len(html_content):
                        if html_content[i] == '\\':
                            i += 2
                            continue
                        if html_content[i] == quote:
                            break
                        i += 1
            raw = html_content[start:end]
            # 处理单引号 JS 格式，转为标准 JSON
            # 1. 属性名: 'xxx' → "xxx"
            raw = re.sub(r"'([^']+)'\s*:", r'"\1":', raw)
            # 2. 字符串值: : 'xxx' → : "xxx"（但在引号内不转义）
            raw = re.sub(r":\s*'([^']*?)'(\s*[,}\]])", r': "\1"\2', raw)
            parsed = _json.loads(raw)
            for item in parsed:
                qtext = item.get("question", item.get("text", ""))[:50]
                qans = str(item.get("answer", item.get("correctAnswer", "")))
                fingerprint = f"{qtext}|{qans}"
                if fingerprint not in existing_fingerprints and len(qtext) > 5:
                    # 转换为 question_bank 格式
                    opts = item.get("options", {})
                    # 如果是数组格式（练习题的 options），转为 dict
                    if isinstance(opts, list):
                        opt_dict = {}
                        for o in opts:
                            if isinstance(o, dict):
                                k = o.get("value", "")
                                v = o.get("text", "")
                                if k and v:
                                    opt_dict[k] = v
                        opts = opt_dict
                    new_q = {
                        "type": "single",
                        "question_text": item.get("question", item.get("text", "")),
                        "options": opts,
                        "correct_answer": str(item.get("answer", item.get("correctAnswer", ""))),
                        "explanation": item.get("explanation", ""),
                        "knowledge_points": topic,
                        "subject": subject,
                        "difficulty": "medium",
                        "svg_content": item.get("svg_code", item.get("svg_content", "")),
                    }
                    # 处理 principle 字段作为知识点
                    if "principle" in item:
                        new_q["knowledge_points"] = item["principle"]
                    new_questions.append(new_q)
        except Exception as e:
            logger.warning(f"解析 HTML 题目数据失败: {e}")

    return new_questions


@router.post("/ai-save")
async def ai_save_html(request: Request):
    """保存 AI 生成的 HTML 到用户目录"""
    user = get_current_user(request)
    username = user["username"]

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员和教师可以保存资源")

    body = await request.json()
    html_content = body.get("html_content", "").strip()
    filename = body.get("filename", "").strip()

    if not html_content:
        raise HTTPException(status_code=400, detail="HTML 内容不能为空")
    if not filename:
        raise HTTPException(status_code=400, detail="文件名不能为空")
    if not filename.lower().endswith(".html"):
        filename += ".html"

    # 清理文件名
    filename = _sanitize_filename(filename)
    if not filename.lower().endswith(".html"):
        filename += ".html"

    # 目标目录
    html_dir = get_account_html_dir(username)
    os.makedirs(html_dir, exist_ok=True)

    target_path = os.path.join(html_dir, filename)

    # 处理重名
    if os.path.exists(target_path):
        name, ext = os.path.splitext(filename)
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"{name}_{timestamp}{ext}"
        target_path = os.path.join(html_dir, filename)

    try:
        with open(target_path, "w", encoding="utf-8") as f:
            f.write(html_content)
        logger.info(f"AI 生成 HTML 已保存: {target_path}")
    except Exception as e:
        logger.error(f"保存 HTML 失败: {e}")
        raise HTTPException(status_code=500, detail=f"保存失败: {str(e)}")

    # 刷新教师同步
    ensure_teacher_html_files(username)

    from backend.config import BASE_DIR
    rel_path = os.path.relpath(target_path, str(BASE_DIR)).replace("\\", "/")

    return {
        "message": f"✅ HTML 资源已保存为 {filename}",
        "file_name": filename,
        "file_path": rel_path,
        "url_path": rel_path,
        "is_subdir": False,
    }


# ═══════════════════════════════════════════════
# 多文件结构解析 + 子目录保存（适用于复杂交互资源）
# ═══════════════════════════════════════════════

def _parse_multi_file_output(ai_output: str) -> dict[str, str]:
    """解析 AI 输出的多文件格式，返回 {相对路径: 文件内容} 字典

    格式示例：
    === FILE: index.html ===
    <!DOCTYPE html>...
    === FILE: css/style.css ===
    ...

    Returns:
        { "index.html": "...", "css/style.css": "...", "js/app.js": "..." }
    """
    files: dict[str, str] = {}
    if not ai_output:
        return files

    # 匹配 === FILE: 路径 === 块
    pattern = r'=== FILE:\s*([^\n=]+?)\s*==='
    matches = list(re.finditer(pattern, ai_output))
    if not matches:
        # 没有多文件标记，当作单文件处理
        return {}

    for i, match in enumerate(matches):
        file_path = match.group(1).strip()
        # 文件内容从当前标记末尾到下一个标记开始（或字符串末尾）
        content_start = match.end()
        if i + 1 < len(matches):
            content_end = matches[i + 1].start()
        else:
            content_end = len(ai_output)
        content = ai_output[content_start:content_end].strip()

        # 清理可能残留的 markdown 代码块标记
        if content.startswith("```"):
            first_nl = content.find("\n")
            if first_nl != -1:
                content = content[first_nl + 1:]
        if content.endswith("```"):
            content = content[:-3].strip()
        elif content.endswith("```\n"):
            content = content[:-4].strip()

        if content:
            files[file_path] = content

    return files


def _save_resource_subdir(
    files: dict[str, str],
    base_dir: str,
    dir_name: str,
) -> tuple[str, str]:
    """将多文件结构保存到 HTML 目录

    结构：
      base_dir/
        res_name.html       ← 主入口，直接放在 HTML 目录，资源列表可见
        res_name/            ← 同名子目录，存放 CSS/JS/图片等配套文件
          css/style.css
          js/app.js
          data/config.json
          media/img_xxx.png

    Args:
        files: {相对路径: 文件内容} 字典
        base_dir: HTML 目录（如 /d/SmartKBS/youufis/html）
        dir_name: 目录/文件名前缀（如 "冒泡排序_实验交互"）

    Returns:
        (main_entry_abs_path, main_entry_rel_path)
    """
    os.makedirs(base_dir, exist_ok=True)

    safe_name = _sanitize_filename(dir_name)

    # 确定主 .html 文件名（处理重名）
    main_html = f"{safe_name}.html"
    main_path = os.path.join(base_dir, main_html)
    counter = 1
    while os.path.exists(main_path):
        main_html = f"{safe_name}_{counter}.html"
        main_path = os.path.join(base_dir, main_html)
        counter += 1

    # 配套子目录（与 .html 同名，不含扩展名）
    assets_dir_name = os.path.splitext(main_html)[0]
    assets_dir = os.path.join(base_dir, assets_dir_name)
    os.makedirs(assets_dir, exist_ok=True)

    # 分离主入口和配套文件
    main_content = ""
    saved_asset_count = 0
    for rel_path, content in files.items():
        clean_path = rel_path.replace("\\", "/")
        # 安全校验
        if ".." in clean_path.split("/"):
            logger.warning(f"跳过含路径穿越的条目: {rel_path}")
            continue

        if clean_path in ("index.html", "index.htm"):
            main_content = content
        else:
            # 配套文件 → 保存到 assets_dir
            target_path = os.path.normpath(os.path.join(assets_dir, clean_path))
            if not target_path.startswith(os.path.normpath(assets_dir)):
                logger.warning(f"跳过越界路径: {rel_path}")
                continue
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            with open(target_path, "w", encoding="utf-8") as f:
                f.write(content)
            saved_asset_count += 1

    # 如果没有 index.html，将第一个文件当作主入口
    if not main_content:
        first_key = next(iter(files.keys()), "")
        if first_key:
            main_content = files[first_key]
            # 如果第一个文件是配套文件，已写入 assets_dir，需复制到主文件
            if first_key not in ("index.html", "index.htm"):
                with open(main_path, "w", encoding="utf-8") as f:
                    f.write(main_content)
                saved_asset_count -= 1  # 已在 assets_dir 写了一份

    # ── 路径重写：将 index.html 中的相对引用改为带 assets_dir 前缀 ──
    if main_content and saved_asset_count > 0:
        # 只重写非绝对路径引用，添加 assets_dir_name/ 前缀
        # 处理 href="xxx" / src="xxx" / src='xxx' — 排除已含 / 前缀的绝对路径
        main_content = re.sub(
            r'(href="|src=")([^"\'/][^"]*")',
            lambda m: f'{m.group(1)}{assets_dir_name}/{m.group(2)}'
            if not m.group(2).startswith(("http://", "https://", "data:", "#", "mailto:"))
            else m.group(0),
            main_content,
        )
        main_content = re.sub(
            r"(src=')([^'/][^']*')",
            lambda m: f"{m.group(1)}{assets_dir_name}/{m.group(2)}",
            main_content,
        )
        # 处理 CSS url(xxx) / url("xxx")
        main_content = re.sub(
            r'(url\()([^"\')\s][^)\s]*\))',
            lambda m: f'{m.group(1)}{assets_dir_name}/{m.group(2)}',
            main_content,
        )
        main_content = re.sub(
            r'(url\(")([^"]+)("\))',
            lambda m: f'{m.group(1)}{assets_dir_name}/{m.group(2)}{m.group(3)}',
            main_content,
        )
        # 处理 import 语句
        main_content = re.sub(
            r'(import\s+["\'])([^"\']+)(["\'])',
            lambda m: f'{m.group(1)}{assets_dir_name}/{m.group(2)}{m.group(3)}'
            if not m.group(2).startswith(("/", "http", ".")) else m.group(0),
            main_content,
        )

    # 写主入口
    if main_content:
        with open(main_path, "w", encoding="utf-8") as f:
            f.write(main_content)

    logger.info(
        f"多文件资源已保存: {main_html} + {assets_dir_name}/ "
        f"({saved_asset_count} 个配套文件)"
    )

    from backend.config import BASE_DIR as _BASE_DIR
    rel_path = os.path.relpath(main_path, str(_BASE_DIR)).replace("\\", "/")

    return main_path, rel_path


@router.post("/ai-save-multi")
async def ai_save_multi_html(request: Request):
    """保存 AI 生成的多文件 HTML 资源到子目录

    从 AI 输出的多文件格式中解析出各个文件，保存到子目录。
    """
    user = get_current_user(request)
    username = user["username"]

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足")

    body = await request.json()
    ai_output = body.get("ai_output", "").strip()
    dir_name = body.get("dir_name", "").strip()
    single_html = body.get("html_content", "").strip()

    if not ai_output and not single_html:
        raise HTTPException(status_code=400, detail="请提供 AI 输出内容")

    html_dir = get_account_html_dir(username)

    if ai_output:
        # 尝试解析多文件格式
        files = _parse_multi_file_output(ai_output)
        if files:
            # 有多文件结构，保存到子目录
            if not dir_name:
                # 从文件名或 index.html 标题推断
                if "index.html" in files:
                    title_match = re.search(r'<title[^>]*>(.*?)</title>', files["index.html"], re.DOTALL)
                    if title_match:
                        dir_name = _sanitize_filename(title_match.group(1).strip())
                    else:
                        dir_name = f"AI资源_{int(time.time())}"
                else:
                    dir_name = f"AI资源_{int(time.time())}"

            main_path, rel_path = _save_resource_subdir(files, html_dir, dir_name)
            main_basename = os.path.basename(main_path)
            assets_dir_name = os.path.splitext(main_basename)[0]

            file_count = len(files)
            return {
                "message": f"✅ 多文件资源已保存：{main_basename} + {assets_dir_name}/ 目录 ({file_count} 个文件)",
                "is_subdir": True,
                "dir_name": assets_dir_name,
                "main_entry": main_basename,
                "url_path": rel_path,
                "file_count": file_count,
            }

    # 没有多文件结构，回退到单文件保存
    if not single_html:
        single_html = ai_output  # 把整个输出当 HTML 保存

    # 沿用现有的 ai-save 逻辑
    from backend.config import BASE_DIR as _BASE_DIR
    filename = f"{_sanitize_filename(dir_name or 'AI资源')}.html"
    filename = filename if filename.lower().endswith(".html") else filename + ".html"
    target_path = os.path.join(html_dir, filename)

    if os.path.exists(target_path):
        name, ext = os.path.splitext(filename)
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"{name}_{timestamp}{ext}"
        target_path = os.path.join(html_dir, filename)

    with open(target_path, "w", encoding="utf-8") as f:
        f.write(single_html)

    ensure_teacher_html_files(username)
    rel_path = os.path.relpath(target_path, str(_BASE_DIR)).replace("\\", "/")

    return {
        "message": f"✅ HTML 资源已保存为 {filename}",
        "file_name": filename,
        "file_path": rel_path,
        "url_path": rel_path,
        "is_subdir": False,
    }


# ═══════════════════════════════════════════════
# 异步 AI 生成（适用于复杂耗时的资源生成）
# ═══════════════════════════════════════════════

@router.post("/ai-generate-async")
async def ai_generate_async(request: Request):
    """异步启动 AI 生成 HTML 资源，立即返回 task_id

    前端通过轮询 /api/resources/ai-task/{task_id} 获取生成进度和结果。
    """
    user = get_current_user(request)
    username = user["username"]
    user_name = user.get("name", "")

    if not can_manage_html_files(username):
        raise HTTPException(status_code=403, detail="权限不足")

    body = await request.json()
    gen_type = body.get("type", "interactive")
    topic = body.get("topic", "").strip()
    subject = body.get("subject", "").strip()
    grade = body.get("grade", "").strip()
    custom_prompt = body.get("custom_prompt", "").strip()
    theme = body.get("theme", "").strip()
    experiment_params = body.get("experiment_params", {})
    enable_media = body.get("enable_media", True)

    if not topic and not custom_prompt:
        raise HTTPException(status_code=400, detail="请输入主题或自定义需求")

    # 处理实验参数（与同步路径一致）
    if experiment_params and isinstance(experiment_params, dict):
        extra = "\n【用户指定的实验参数】\n"
        for k, v in experiment_params.items():
            extra += f"- {k}: {v}\n"
        custom_prompt = (custom_prompt or "") + extra

    # 获取 API Key
    from backend.api.chat_router import get_api_keys
    api_key, _ = get_api_keys(username)
    if not api_key:
        raise HTTPException(status_code=400, detail="API Key 未配置")

    # 构建异步任务
    from backend.ai_task_manager import task_manager as _task_manager

    async def _do_generate_inner() -> dict:
        """实际生成逻辑（在超时保护内执行）"""
        try:
            # ── 阶段1: 构建 Prompt 并调用 AI ──
            logger.info(f"[异步] 开始 AI 生成 HTML, 类型={gen_type}, 主题={topic}")

            # RAG 检索
            rag_context = ""
            try:
                from backend.rag import retrieve_knowledge
                rag_context = retrieve_knowledge(topic, username)
            except Exception as e:
                logger.warning(f"[异步] RAG 检索失败: {e}")

            # ── 异步任务用更长的超时（后台不阻塞 HTTP）──
            ASYNC_AI_TIMEOUT = 600  # 10 分钟，复杂资源可能需要更长时间

            prompt = build_html_prompt(
                prompt_type=gen_type,
                topic=topic,
                rag_context=rag_context,
                subject=subject,
                grade=grade,
                custom_prompt=custom_prompt,
                theme=theme,
            )

            from backend.api.ai_service import call_ai_sync_with_timeout
            ai_result = await call_ai_sync_with_timeout(prompt, api_key, timeout=ASYNC_AI_TIMEOUT)
            if not ai_result or len(ai_result.strip()) < 50:
                return {"error": "AI 返回内容为空或过短"}

            # 清理 AI 输出
            html_cleaned = ai_result.strip()
            html_match = re.search(
                r'```(?:html)?\s*(\<!DOCTYPE html\>.*?)\s*```',
                html_cleaned, re.DOTALL | re.IGNORECASE,
            )
            if html_match:
                html_cleaned = html_match.group(1).strip()
            else:
                doctype_match = re.search(
                    r'(\<!DOCTYPE html\>.*)', html_cleaned, re.DOTALL | re.IGNORECASE,
                )
                if doctype_match:
                    html_cleaned = doctype_match.group(1).strip()

            # ── 阶段2: 解析多文件结构 ──
            files = _parse_multi_file_output(ai_result)
            html_dir = get_account_html_dir(username)

            # 确定目录名
            title = _extract_html_title(html_cleaned) or topic
            type_labels = {
                "animation": "动画讲解", "quiz": "互动答题",
                "practice": "练习题", "custom": "自定义", "interactive": "实验交互",
            }
            dir_name = f"{_sanitize_filename(title)}_{type_labels.get(gen_type, '资源')}"

            saved_info = {}
            if files:
                # 多文件 → 主 .html + 同名目录
                main_path, rel_path = _save_resource_subdir(files, html_dir, dir_name)
                main_basename = os.path.basename(main_path)
                assets_dir = os.path.splitext(main_basename)[0]
                saved_info = {
                    "is_subdir": True,
                    "dir_name": assets_dir,
                    "main_entry": main_basename,
                    "url_path": rel_path,
                    "file_count": len(files),
                }
            else:
                # 单文件
                from backend.config import BASE_DIR as _BASE_DIR
                filename = f"{_sanitize_filename(dir_name)}.html"
                target_path = os.path.join(html_dir, filename)
                if os.path.exists(target_path):
                    name, ext = os.path.splitext(filename)
                    ts = time.strftime("%Y%m%d_%H%M%S")
                    filename = f"{name}_{ts}{ext}"
                    target_path = os.path.join(html_dir, filename)
                with open(target_path, "w", encoding="utf-8") as f:
                    f.write(html_cleaned)
                ensure_teacher_html_files(username)
                rel_path = os.path.relpath(target_path, str(_BASE_DIR)).replace("\\", "/")
                saved_info = {
                    "is_subdir": False,
                    "file_name": filename,
                    "url_path": rel_path,
                }

            # ── 阶段3: 配图增强（如果启用）──
            media_count = 0
            if enable_media:
                try:
                    from backend.api.image_gen_service import plan_and_generate_media
                    # 如果是子目录，将增强后的内容写回 index.html
                    enhanced = await plan_and_generate_media(
                        html_content=html_cleaned,
                        topic=topic,
                        subject=subject,
                        resource_type=gen_type,
                        api_key=api_key,
                        html_dir=html_dir,
                    )
                    if enhanced and len(enhanced) > len(html_cleaned):
                        if files and saved_info.get("is_subdir"):
                            # 配图增强写入主 .html 文件
                            main_html_path = os.path.join(html_dir, saved_info["main_entry"])
                            if os.path.exists(main_html_path):
                                with open(main_html_path, "w", encoding="utf-8") as f:
                                    f.write(enhanced)
                        elif not saved_info.get("is_subdir"):
                            fpath = os.path.join(html_dir, saved_info.get("file_name", ""))
                            if os.path.exists(fpath):
                                with open(fpath, "w", encoding="utf-8") as f:
                                    f.write(enhanced)
                except Exception as e:
                    logger.warning(f"[异步] 配图增强失败: {e}")

            logger.info(f"[异步] 生成完成: {saved_info}")
            return {"saved": saved_info}

        except Exception as e:
            logger.error(f"[异步] 生成失败: {e}")
            return {"error": str(e)}

    async def _generate_task() -> dict:
        """后台生成任务（带整体超时保护）"""
        OVERALL_TASK_TIMEOUT = 900  # 15 分钟
        try:
            return await asyncio.wait_for(
                _do_generate_inner(),
                timeout=OVERALL_TASK_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.error(f"[异步] 生成任务整体超时（{OVERALL_TASK_TIMEOUT}s）")
            return {"error": f"生成任务超时（超过 {OVERALL_TASK_TIMEOUT//60} 分钟），请简化描述后重试"}

    task_id = await _task_manager.create_task(
        description=f"AI 生成 {gen_type} 资源: {topic or custom_prompt[:30]}",
        coro_factory=_generate_task,
    )

    return {
        "task_id": task_id,
        "message": "生成任务已启动",
        "poll_url": f"/api/resources/ai-task/{task_id}",
    }


@router.get("/ai-task/{task_id}")
async def get_ai_task_status(task_id: str, request: Request):
    """获取异步 AI 生成任务的状态和结果（T3: 必须登录且只能读自己/管理员可读的任务）"""
    user = get_current_user(request)
    from backend.ai_task_manager import task_manager as _task_manager
    task = _task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")

    owner = getattr(task, "owner", "") or ""
    if owner and user.get("role", 2) != 0 and owner != user["username"]:
        raise HTTPException(status_code=403, detail="无权查看该任务")

    result = task.to_dict()
    result.pop("owner", None)
    # 如果已完成且有 saved_info，格式化输出
    if task.status.value == "completed" and task.result:
        result["data"] = task.result

    return result
