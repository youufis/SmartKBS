"""
资源中心 API 路由
HTML 文件列表/上传/删除/导航
"""
import os
import re
import shutil
import urllib.parse

from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Form, Query
from fastapi.responses import HTMLResponse

from backend.api.dependencies import get_current_user
from backend.auth import can_manage_html_files, is_admin, is_teacher
from backend.config import ROOT_DIR, DEFAULT_LOGGED_IN_NAME
from backend.utils import (
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
                    "path": fpath,
                    "url_path": rel_path,
                    "size": os.path.getsize(fpath),
                    "display_name": os.path.splitext(fname)[0],
                })
    except Exception as e:
        logger.error(f"获取资源列表失败: {e}")

    return {"files": files, "html_dir": html_dir}


# ── 目录树 ──

def _scan_tree(dirpath: str, base_rel: str = "", with_meta: bool = True) -> list:
    entries = []
    try:
        for name in sorted(os.listdir(dirpath), key=str.lower):
            full = os.path.join(dirpath, name)
            rel = os.path.join(base_rel, name) if base_rel else name
            if os.path.isfile(full):
                stat = os.stat(full)
                _, ext = os.path.splitext(name.lower())
                entry = {"title": name, "key": rel, "isLeaf": True}
                if with_meta:
                    entry["size"] = stat.st_size
                    entry["mtime"] = __import__("datetime").datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M")
                    entry["ext"] = ext
                entries.append(entry)
            elif os.path.isdir(full):
                children = _scan_tree(full, rel, with_meta)
                entries.append({"title": name, "key": rel, "isLeaf": False, "children": children})
    except PermissionError:
        pass
    return entries


@router.get("/tree")
async def get_resource_tree(request: Request):
    """获取用户 HTML 目录的树形结构"""
    user = get_current_user(request)
    username = user["username"]
    html_dir = get_account_html_dir(username)
    if not os.path.exists(html_dir):
        return {"tree": [], "root": html_dir}
    tree = _scan_tree(html_dir)
    return {"tree": tree, "root": html_dir}


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

    file_items: dict[str, tuple[str, str]] = {}  # index -> (filename, subpath)
    for key in form.keys():
        if key.startswith("file"):
            idx = key[4:]  # "file0" -> "0"
            item = form[key]
            if not hasattr(item, "filename") or not item.filename:
                continue
            file_items[idx] = (item, item.filename)
        elif key.startswith("path"):
            idx = key[4:]  # "path0" -> "0"
            if idx in file_items:
                _item, _fn = file_items[idx]
                file_items[idx] = (_item, form[key] or "")

    for idx, (item, subpath) in file_items.items():
        filename = item.filename if hasattr(item, 'filename') else ''
        if not filename:
            continue

        # 使用 webkitRelativePath 或 subpath 构建相对路径
        rel_path = getattr(item, 'filename', '')
        if subpath:
            rel_path = os.path.join(subpath, os.path.basename(filename))

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

        # 目标路径（含子目录）
        target_path = os.path.join(html_dir, rel_path)
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
async def delete_resource(path: str = Query(...), request: Request = None):
    """删除资源文件或目录（仅管理员/教师）"""
    if request:
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

        if not target_path.startswith(html_dir):
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
                from backend.database import execute_insert_update
                execute_insert_update(
                    "DELETE FROM resource_group_items WHERE file_path=?",
                    (db_path,),
                )
                # 也尝试清理绝对路径格式的引用
                execute_insert_update(
                    "DELETE FROM resource_group_items WHERE file_path=?",
                    (target_path.replace("\\", "/"),),
                )
            except Exception as cleanup_err:
                logger.warning(f"清理资源分组引用失败: {cleanup_err}")

            # 同步清理共享记录和关联的课程绑定
            try:
                from backend.database import execute_query
                # 匹配所有指向该文件的共享记录（统一用正斜杠匹配）
                share_rows = execute_query(
                    """SELECT id FROM shared_resources
                       WHERE owner_username=? AND resource_type='html'
                       AND (file_path=? OR file_path LIKE ?)""",
                    (username, db_path, f"%/{db_path}"),
                )
                # 额外尝试一次：如果 path 是绝对路径（来自卡片视图），也用相对路径再查一次
                if not share_rows and os.path.isabs(path):
                    share_rows = execute_query(
                        """SELECT id FROM shared_resources
                           WHERE owner_username=? AND resource_type='html'
                           AND (file_path=? OR file_path LIKE ?)""",
                        (username, os.path.basename(path), f"%/{os.path.basename(path)}"),
                    )
                for row in share_rows:
                    sid = row["id"]
                    # 清理该共享关联的课程绑定
                    execute_insert_update(
                        "DELETE FROM curriculum_bindings WHERE resource_type='html' AND resource_id=?",
                        (sid,),
                    )
                    # 清理共享记录
                    execute_insert_update(
                        "DELETE FROM shared_resources WHERE id=?",
                        (sid,),
                    )
                if share_rows:
                    logger.info(f"已同步清理 {len(share_rows)} 条共享记录及关联绑定")
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
    if "/" in new_name or "\\" in new_name:
        raise HTTPException(status_code=400, detail="新名称不能包含路径分隔符")

    html_dir = os.path.abspath(get_account_html_dir(username))
    if not os.path.isabs(path):
        old_path = os.path.abspath(os.path.join(html_dir, path))
    else:
        old_path = os.path.abspath(path)

    if not old_path.startswith(html_dir):
        raise HTTPException(status_code=403, detail="无权操作该文件")

    if not os.path.exists(old_path):
        raise HTTPException(status_code=404, detail="文件或目录不存在")

    new_path = os.path.join(os.path.dirname(old_path), new_name)
    if os.path.exists(new_path):
        raise HTTPException(status_code=409, detail="目标名称已存在")

    try:
        os.rename(old_path, new_path)
        logger.info(f"资源已重命名: {old_path} -> {new_path}")
        return {"message": f"已重命名为 {new_name}"}
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
            base_url_path = html_dir.replace("\\", "/") + "/"
            base_url = "/api/files/" + urllib.parse.quote(base_url_path)
            content = _rewrite_html_links(content, base_url)
            return HTMLResponse(content=content)
        else:
            # 自动创建默认导航（含文件列表）
            default_html = _generate_default_nav_html(html_dir)
            os.makedirs(html_dir, exist_ok=True)
            with open(index_path, "w", encoding="utf-8") as f:
                f.write(default_html)
            return HTMLResponse(content=default_html)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"加载导航页失败: {str(e)}")


def _generate_default_nav_html(html_dir: str = "") -> str:
    """生成默认导航页，如果 html_dir 中有实际文件则列出它们"""
    file_links = ""
    if html_dir and os.path.exists(html_dir):
        from backend.config import BASE_DIR
        files = sorted([
            f for f in os.listdir(html_dir)
            if os.path.isfile(os.path.join(html_dir, f))
            and f.endswith('.html') and f != 'index.html'
        ])
        if files:
            file_links = '<h2>📄 资源中心</h2><div class="grid">'
            for f in files:
                rel = os.path.relpath(os.path.join(html_dir, f), str(BASE_DIR)).replace("\\", "/")
                display = os.path.splitext(f)[0]
                file_links += f'<a href="/api/files/{rel}" target="_blank" class="card">{display}</a>'
            file_links += '</div>'

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>资源中心</title>
<style>
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:900px;margin:0 auto;padding:30px 20px;color:#333}}
h1{{color:#1677ff;border-bottom:2px solid #1677ff;padding-bottom:10px}}
.tip{{background:#e8f0fe;border-left:4px solid #1677ff;padding:14px 18px;margin:20px 0;border-radius:0 4px 4px 0}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin:16px 0}}
.card{{display:block;padding:10px 14px;background:#fafafa;border:1px solid #e8e8e8;border-radius:6px;text-decoration:none;color:#333;font-size:14px;transition:all .2s}}
.card:hover{{background:#e6f4ff;border-color:#1677ff;transform:translateY(-1px);box-shadow:0 2px 6px rgba(22,119,255,0.1)}}
.footer{{margin-top:40px;font-size:.85em;color:#888;text-align:center}}
</style>
</head>
<body>
<h1>📚 资源中心</h1>
<div class="tip"><strong>💡 提示：</strong>点击下方资源文件即可在新标签页中打开查看。</div>
{file_links if file_links else '<p style="color:#999;text-align:center;padding:40px">暂无资源文件，请在「资源管理」中上传。</p>'}
<div class="footer"><p>SmartKB 资源中心</p></div>
</body></html>"""


# ═══════════════════════════════════════════════
# 资源分组管理 API
# ═══════════════════════════════════════════════

import time
from backend.database import execute_query, execute_insert_update, execute_batch, get_connection


@router.get("/groups")
async def list_groups(request: Request):
    """获取当前用户的所有资源分组及包含的文件"""
    user = get_current_user(request)
    username = user["username"]

    groups = execute_query(
        "SELECT id, group_name, sort_order FROM resource_groups WHERE username=? ORDER BY sort_order, id",
        (username,),
    )
    result = []
    for gid, gname, sort in groups:
        items = execute_query(
            "SELECT file_path FROM resource_group_items WHERE group_id=? ORDER BY sort_order, id",
            (gid,),
        )
        result.append({
            "id": gid,
            "group_name": gname,
            "sort_order": sort,
            "files": [row[0] for row in items],
        })
    return {"groups": result}


@router.post("/groups")
async def create_group(request: Request):
    """创建新分组"""
    user = get_current_user(request)
    username = user["username"]
    body = await request.json()
    group_name = body.get("group_name", "").strip()
    if not group_name:
        raise HTTPException(status_code=400, detail="分组名称不能为空")

    existing = execute_query(
        "SELECT id FROM resource_groups WHERE username=? AND group_name=?",
        (username, group_name),
    )
    if existing:
        raise HTTPException(status_code=400, detail=f"分组 '{group_name}' 已存在")

    now = time.strftime("%Y-%m-%d %H:%M:%S")
    gid = execute_insert_update(
        "INSERT INTO resource_groups (username, group_name, sort_order, created_at) VALUES (?, ?, ?, ?)",
        (username, group_name, 0, now),
    )
    logger.info(f"资源分组创建: {username}/{group_name}")
    return {"message": f"分组 '{group_name}' 已创建", "id": gid}


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
    new_name = body.get("group_name", "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="分组名称不能为空")

    # 验证分组属于当前用户
    rows = execute_query(
        "SELECT id FROM resource_groups WHERE id=? AND username=?",
        (group_id, username),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="分组不存在")

    execute_insert_update(
        "UPDATE resource_groups SET group_name=? WHERE id=?",
        (new_name, group_id),
    )
    logger.info(f"资源分组重命名: {username}/{group_id} -> {new_name}")
    return {"message": f"已重命名为 '{new_name}'"}


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
    file_path = body.get("file_path", "").strip()
    if not file_path:
        raise HTTPException(status_code=400, detail="file_path 不能为空")

    now = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        execute_insert_update(
            "INSERT OR IGNORE INTO resource_group_items (group_id, file_path, sort_order, created_at) VALUES (?, ?, ?, ?)",
            (group_id, file_path, 0, now),
        )
        logger.info(f"资源加入分组: {username}/group={group_id}, file={file_path}")
        return {"message": "已添加到分组"}
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
    file_path = body.get("file_path", "").strip()
    if not file_path:
        raise HTTPException(status_code=400, detail="file_path 不能为空")

    execute_insert_update(
        "DELETE FROM resource_group_items WHERE group_id=? AND file_path=?",
        (group_id, file_path),
    )
    logger.info(f"资源移出分组: {username}/group={group_id}, file={file_path}")
    return {"message": "已从分组移除"}
