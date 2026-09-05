"""
对话历史记录 API 路由
目录树浏览 / 文件读取 / 删除
"""
import os
import shutil

from fastapi import APIRouter, HTTPException, Request, Query
from typing import Any

from backend.api.dependencies import get_current_user
from backend.utils import get_account_chat_history_dir, path_within
from backend.database import execute_query, execute_insert_update
from backend.logger import logger

# H1: 单次写入与单文件上限, 防止 /save 被无限追加撑爆磁盘
_MAX_HISTORY_APPEND_BYTES = 2 * 1024 * 1024
_MAX_HISTORY_FILE_BYTES = 20 * 1024 * 1024


def _like_prefix_escape(v: str) -> str:
    """H3: LIKE 前缀匹配需转义 % 与 _, 否则文件名含通配符会误删他人索引"""
    return v.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


router = APIRouter()


def _db_tree_to_response(username: str) -> list[dict[str, Any]]:
    """从 conversations 表构建目录树"""
    rows = execute_query(
        """SELECT date, filename, title, message_count, file_size
           FROM conversations WHERE username=? ORDER BY date DESC, filename""",
        (username,),
    )
    if not rows:
        return []

    # 按日期分组
    date_map: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        date_str = row[0]
        if date_str not in date_map:
            date_map[date_str] = []
        date_map[date_str].append({
            "title": row[1].replace("\\", "/").split("/")[-1],
            "key": row[1].replace("\\", "/"),
            "isLeaf": True,
            "size": row[4] or 0,
        })

    tree = []
    for date_str in sorted(date_map.keys(), reverse=True):
        tree.append({
            "title": date_str,
            "key": date_str,
            "isLeaf": False,
            "children": date_map[date_str],
        })
    return tree


def _scan_tree(dirpath: str, base_rel: str = "") -> list[dict[str, Any]]:
    """递归扫描目录（DB 无数据时的回退方案）"""
    entries = []
    try:
        for name in sorted(os.listdir(dirpath), key=str.lower):
            full = os.path.join(dirpath, name)
            rel = os.path.join(base_rel, name) if base_rel else name
            if os.path.isfile(full):
                entries.append({
                    "title": name,
                    "key": rel,
                    "isLeaf": True,
                    "size": os.path.getsize(full),
                })
            elif os.path.isdir(full):
                children = _scan_tree(full, rel)
                entries.append({
                    "title": name,
                    "key": rel,
                    "isLeaf": False,
                    "children": children,
                })
    except PermissionError:
        pass
    return entries


@router.get("/tree")
async def get_history_tree(request: Request):
    """获取当前用户的历史记录目录树（优先从 DB 索引）"""
    user = get_current_user(request)
    username = user["username"]

    # 优先从 DB 查询
    tree = _db_tree_to_response(username)
    if tree:
        return {"tree": tree}

    # 回退：扫描文件系统
    chat_dir = get_account_chat_history_dir(username)
    if not os.path.exists(chat_dir):
        return {"tree": []}
    tree = _scan_tree(chat_dir)
    # H4: 不再向客户端下发服务器绝对路径(前端未使用该字段)
    return {"tree": tree}


@router.get("/file")
async def read_history_file(request: Request, path: str = Query(...)):
    """读取历史文件内容"""
    # H2: 旧实现 request 带默认值(为 None 时改读管理员目录), 且用 startswith 判边界,
    #     兄弟目录(如 ChatHistoryBak)会被当成合法前缀; 现统一走 path_within
    user = get_current_user(request)
    chat_dir = os.path.realpath(get_account_chat_history_dir(user["username"]))
    target_path = os.path.realpath(os.path.join(chat_dir, path))
    if not path_within(chat_dir, target_path):
        raise HTTPException(status_code=403, detail="无权访问该文件")

    if not os.path.isfile(target_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    try:
        with open(target_path, "r", encoding="utf-8") as f:
            content = f.read()

        # 检测是否包含 HTML 代码块
        import re
        html_blocks = re.findall(r'```(?:html|HTML)\s*(.*?)\s*```', content, re.DOTALL)
        has_html = len(html_blocks) > 0

        return {
            "content": content,
            "filename": os.path.basename(target_path),
            "has_html": has_html,
            "html_blocks": html_blocks[:5] if has_html else [],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取文件失败: {str(e)}")


@router.delete("/file")
async def delete_history_file(request: Request, path: str = Query(...)):
    """删除历史文件或目录(仅限本人 ChatHistory 之内)"""
    user = get_current_user(request)
    username = user["username"]
    chat_dir = os.path.realpath(get_account_chat_history_dir(username))
    target_path = os.path.realpath(os.path.join(chat_dir, path))
    # H2: 禁止删根目录本身
    if not path_within(chat_dir, target_path) or target_path == chat_dir:
        raise HTTPException(status_code=403, detail="无权删除该文件")

    if not os.path.exists(target_path):
        # 磁盘上可能已经被手动删除，但 DB 中仍保留索引。
        # 在此情况下不应该直接返回 404，而是尝试从 conversations 表中移除对应的索引。
        rel = os.path.relpath(target_path, chat_dir).replace("\\", "/")
        # 防止误删除根目录
        if rel in (".", ""):
            raise HTTPException(status_code=400, detail="不能删除根目录")

        try:
            # 删除与该文件或目录匹配的索引（文件精确匹配或目录前缀匹配）
            execute_insert_update(
                "DELETE FROM conversations WHERE username=? AND (filename=? OR filename LIKE ? ESCAPE '\\')",
                (username, rel, _like_prefix_escape(rel) + "/%"),
            )
            msg = f"路径在磁盘上不存在，已从索引中移除: {rel}"
            logger.info(f"历史记录索引已移除: username={username}, rel={rel}")
            return {"message": msg}
        except Exception as e:
            logger.error(f"删除历史记录索引失败: {e}")
            raise HTTPException(status_code=500, detail=f"删除失败: {str(e)}")

    try:
        if os.path.isfile(target_path):
            os.remove(target_path)
            # 删除 DB 索引
            rel = os.path.relpath(target_path, chat_dir).replace("\\", "/")
            execute_insert_update("DELETE FROM conversations WHERE username=? AND filename=?", (username, rel))
            msg = f"文件 {os.path.basename(target_path)} 已删除"
        elif os.path.isdir(target_path):
            shutil.rmtree(target_path)
            # 删除 DB 索引（匹配该日期目录下所有文件）
            rel_prefix = os.path.relpath(target_path, chat_dir).replace("\\", "/")
            execute_insert_update(
                "DELETE FROM conversations WHERE username=? AND filename LIKE ? ESCAPE '\\'",
                (username, _like_prefix_escape(rel_prefix) + "/%"),
            )
            msg = f"目录 {os.path.basename(target_path)} 已删除"
        else:
            raise HTTPException(status_code=400, detail="路径不是文件也不是目录")
        return {"message": msg}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除历史记录失败: {e}")
        raise HTTPException(status_code=500, detail=f"删除失败: {str(e)}")


@router.post("/save")
async def save_conversation(request: Request):
    """保存对话记录到文件 + 写入索引"""
    body = await request.json()
    content = body.get("content", "")
    session_id = body.get("session_id")
    filename = body.get("filename")

    user = get_current_user(request)
    username = user["username"]
    chat_dir = get_account_chat_history_dir(username)
    os.makedirs(chat_dir, exist_ok=True)

    from datetime import datetime
    date_str = datetime.now().strftime("%Y-%m-%d")
    date_dir = os.path.join(chat_dir, date_str)
    os.makedirs(date_dir, exist_ok=True)

    def _ts_name() -> str:
        return "conversation_%s.md" % datetime.now().strftime("%Y%m%d_%H%M%S")

    # H1: filename 由前端传入, 旧实现直接 os.path.join(date_dir, filename):
    #     传绝对路径时 os.path.join 会丢弃前缀 -> 可把文件写到 ChatHistory 之外;
    #     传 ../x.md 可逃逸日期目录。现只取 basename 并强制 .md 后缀。
    safe_name = os.path.basename(str(filename or "").replace("\\", "/")).strip()
    if not safe_name or safe_name.startswith(".") or safe_name in (".", ".."):
        safe_name = _ts_name()
    if not safe_name.lower().endswith(".md"):
        safe_name += ".md"
    safe_name = safe_name[:120]

    payload = str(content)
    if len(payload.encode("utf-8")) > _MAX_HISTORY_APPEND_BYTES:
        raise HTTPException(status_code=413, detail="单次保存内容过大，请分段保存")

    file_path = os.path.join(date_dir, safe_name)
    if os.path.isfile(file_path) and os.path.getsize(file_path) > _MAX_HISTORY_FILE_BYTES:
        file_path = os.path.join(date_dir, _ts_name())  # 单文件过大 -> 另起新文件
    if not path_within(os.path.realpath(chat_dir), os.path.realpath(file_path)):
        raise HTTPException(status_code=400, detail="文件名不合法")

    try:
        file_exists = os.path.exists(file_path)
        with open(file_path, "a", encoding="utf-8") as f:
            if not file_exists:
                f.write(f"创建时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n")
            f.write(f"{content}\n\n---\n\n")

        # 更新 DB 索引(统一用相对 chat_dir 的路径)
        rel_path = os.path.relpath(file_path, chat_dir).replace("\\", "/")
        fsize = os.path.getsize(file_path)
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        execute_insert_update(
            """INSERT OR REPLACE INTO conversations
               (username, session_id, date, filename, file_size, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (username, session_id or "", date_str, rel_path, fsize, now),
        )

        # H4: 不再回传服务器绝对路径
        return {"message": "对话已保存", "path": rel_path, "filename": os.path.basename(file_path)}
    except Exception as e:
        logger.error(f"保存对话记录失败: {e}")
        raise HTTPException(status_code=500, detail=f"保存失败: {str(e)}")
