"""
对话历史记录 API 路由
目录树浏览 / 文件读取 / 删除
"""
import asyncio
import os
import re
import shutil
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query

from backend.api.dependencies import get_current_user
from backend.utils import get_account_chat_history_dir, path_within, like_escape as _like_prefix_escape
from backend.database import execute_query, execute_insert_update
from backend.logger import logger

# H1: 单次写入与单文件上限, 防止 /save 被无限追加撑爆磁盘
_MAX_HISTORY_APPEND_BYTES = 2 * 1024 * 1024
_MAX_HISTORY_FILE_BYTES = 20 * 1024 * 1024
# 读取上限：整份对话可能长到几十 MB（反复追加同一文件），
# 全量 read() 会一次性吃掉等量内存并把响应撑爆；超限只给前一段并标记截断。
_MAX_HISTORY_READ_CHARS = 2_000_000


router = APIRouter()


# 历史文件是「**用户**: 正文」这样的行拼起来的 Markdown（老数据里还带时间戳：
# `**用户** (2025-11-23 17:18:37): 正文`），角色标签会随界面语言与来源变化，
# 所以只按「**角色**:」的形状识别，不写死中文角色名。
_ROLE_LINE = re.compile(r"^\*\*([^*\n]{1,24})\*\*(?:\s*\([^)]{0,48}\))?\s*[:：]\s*(.*)$")
# 取标题时优先跳过助手侧发言，让标题落在学生说的第一句话上
_ASSISTANT_ROLE = re.compile(r"助手|学伴|智能体|AI|Assistant|Bot", re.I)
_TITLE_MAX = 28
_READ_HEAD_BYTES = 256 * 1024
_DATE_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MAX_TREE_FILES = 3000
_TREE_RECONCILE_TTL = 60        # 秒：同一用户一分钟内不重复扫盘对账


def _clean_title(raw: str) -> str:
    """把一行消息正文收成能当标题看的短句：去代码块/公式/图片/链接符号并限长"""
    text = re.sub(r"```[\s\S]*?```", " ", raw or "")
    text = re.sub(r"\$+\s*([^$]*?)\s*\$+", lambda m: m.group(1), text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\\[A-Za-z]+", "", text)          # 残留的 \times、\frac 等命令
    text = re.sub(r"[#*_>`~$]", "", text)
    text = re.sub(r"\s+", " ", text).strip(" -—:：,，。;；")
    if len(text) > _TITLE_MAX:
        text = text[:_TITLE_MAX].rstrip() + "…"
    return text


def _derive_title_and_count(text: str) -> tuple[str, int]:
    """从对话正文推「标题 + 消息条数」；解析不出标题时返回空串，由界面回退到文件名"""
    title = ""
    fallback = ""
    count = 0
    for line in (text or "").splitlines():
        m = _ROLE_LINE.match(line.strip())
        if not m:
            continue
        count += 1                      # 条数要数到底，不能取到标题就提前退出
        if title:
            continue
        body = _clean_title(m.group(2))
        if not body:
            continue
        if not fallback:
            fallback = body
        if not _ASSISTANT_ROLE.search(m.group(1) or ""):
            title = body
    return title or fallback, count


def _read_title_and_count(file_path: str) -> tuple[str, int]:
    """只读文件开头一段就够：标题在第一条，条数按已写入的行计（超大文件不做全文统计）"""
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(_READ_HEAD_BYTES)
    except OSError:
        return "", 0
    return _derive_title_and_count(head)


def _iter_history_files(chat_dir: str) -> list[tuple[str, int, str]]:
    """列出磁盘上的历史 md 文件：[(相对 chat_dir 的路径, 大小, 修改时间)]

    只认「日期目录下的 md」与「顶层 md」两种布局，避免把用户随手放进来的子目录全扫进来。
    """
    import datetime as _dt
    out: list[tuple[str, int, str]] = []
    if not os.path.isdir(chat_dir):
        return out

    def _push(full: str, rel: str) -> None:
        try:
            st = os.stat(full)
        except OSError:
            return
        out.append((rel, st.st_size,
                    _dt.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S")))

    try:
        for name in sorted(os.listdir(chat_dir)):
            full = os.path.join(chat_dir, name)
            if os.path.isfile(full) and name.lower().endswith(".md"):
                _push(full, name)
            elif os.path.isdir(full) and _DATE_DIR.match(name):
                try:
                    subs = sorted(os.listdir(full))
                except OSError:
                    subs = []
                for sub in subs:
                    if not sub.lower().endswith(".md"):
                        continue
                    sfull = os.path.join(full, sub)
                    if os.path.isfile(sfull):
                        _push(sfull, f"{name}/{sub}")
                    if len(out) >= _MAX_TREE_FILES:
                        return out
    except OSError:
        pass
    return out


_RECONCILED_AT: dict[str, float] = {}


def _reconcile_disk_index(username: str, chat_dir: str) -> None:
    """磁盘与 conversations 索引对账：有文件无索引就补，有索引无文件就清。

    旧逻辑是「库里只要有一行就完全不扫盘」，于是索引建立之前的老会话、以及手工放回
    目录里的文件，永远不会出现在历史列表里（用户以为记录丢了）。
    """
    now = time.time()
    if now - _RECONCILED_AT.get(username, 0.0) < _TREE_RECONCILE_TTL:
        return
    _RECONCILED_AT[username] = now

    disk = {rel: (size, mtime) for rel, size, mtime in _iter_history_files(chat_dir)}
    rows = execute_query("SELECT filename, title FROM conversations WHERE username=?", (username,))
    indexed = {r[0]: (r[1] or "") for r in rows}

    added = 0
    for rel, (size, mtime) in disk.items():
        date_str = rel.split("/")[0] if "/" in rel else mtime[:10]
        if rel in indexed and indexed[rel]:
            continue
        title, count = _read_title_and_count(os.path.join(chat_dir, *rel.split("/")))
        if rel in indexed:
            execute_insert_update(
                "UPDATE conversations SET title=?, message_count=?, file_size=? "
                "WHERE username=? AND filename=?",
                (title, count, size, username, rel),
            )
            continue
        execute_insert_update(
            """INSERT OR REPLACE INTO conversations
               (username, session_id, date, filename, title, message_count, file_size, created_at)
               VALUES (?, '', ?, ?, ?, ?, ?, ?)""",
            (username, date_str, rel, title, count, size, mtime),
        )
        added += 1

    removed = 0
    for rel in [f for f in indexed if f not in disk]:
        execute_insert_update("DELETE FROM conversations WHERE username=? AND filename=?",
                              (username, rel))
        removed += 1

    if added or removed:
        logger.info(f"[历史记录] 索引对账: user={username} 补 {added} 条 / 清 {removed} 条")


def _file_stem(rel: str) -> str:
    """conversation_20260926_074756.md -> 20260926_074756（没标题时的兜底显示）"""
    name = rel.split("/")[-1]
    if name.lower().endswith(".md"):
        name = name[:-3]
    for prefix in ("conversation_", "companion_", "task_"):
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


def _db_tree_to_response(username: str) -> list[dict[str, Any]]:
    """从 conversations 表构建目录树"""
    rows = execute_query(
        """SELECT date, filename, title, message_count, file_size, created_at
           FROM conversations WHERE username=?
           ORDER BY date DESC, created_at DESC, filename""",
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
        rel = row[1].replace("\\", "/")
        stem = rel.split("/")[-1]
        # 标题优先用库里存的（首条学生发言），解析不出来时才回退成时间戳文件名
        date_map[date_str].append({
            "title": (row[2] or "").strip() or _file_stem(rel),
            "key": rel,
            "filename": stem,
            "isLeaf": True,
            "size": row[4] or 0,
            "message_count": row[3] or 0,
            "created_at": row[5] or "",
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
                    "title": _file_stem(name),
                    "key": rel,
                    "filename": name,
                    "isLeaf": True,
                    "size": os.path.getsize(full),
                    "message_count": 0,
                    "created_at": "",
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
    """获取当前用户的历史记录目录树（先与磁盘对账，再走 DB 索引）"""
    user = get_current_user(request)
    username = user["username"]
    chat_dir = get_account_chat_history_dir(username)

    # 扫盘 + 补索引会读文件，放线程池里跑，别卡住事件循环
    await asyncio.to_thread(_reconcile_disk_index, username, chat_dir)

    tree = _db_tree_to_response(username)
    if tree:
        return {"tree": tree}

    # 兜底：目录存在但索引仍为空（对账被限流跳过时）直接扫盘
    if not os.path.exists(chat_dir):
        return {"tree": []}
    tree = await asyncio.to_thread(_scan_tree, chat_dir)
    # H4: 不再向客户端下发服务器绝对路径(前端未使用该字段)
    return {"tree": tree}


def _make_snippet(text: str, pos: int, keyword: str, span: int = 40) -> str:
    """取命中处前后各一段做摘要：压掉换行与 Markdown 符号，方便列表里直接看"""
    start = max(0, pos - span)
    end = min(len(text), pos + len(keyword) + span)
    raw = text[start:end]
    raw = re.sub(r"```[\s\S]*?```", " ", raw)
    raw = re.sub(r"[#*_>`~]", "", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    return ("…" if start > 0 else "") + raw + ("…" if end < len(text) else "")


def _search_files(chat_dir: str, files: list[tuple[str, int, str]],
                  keyword: str, limit: int) -> list[dict[str, Any]]:
    """在历史 md 里找关键词。

    只搜每个文件开头 _READ_HEAD_BYTES 之内：历史文件是整段对话追加，命中基本都在
    前半部分，全库全文扫描的收益远小于代价。
    """
    needle = keyword.lower()
    out: list[dict[str, Any]] = []
    for rel, size, mtime in files:
        if len(out) >= limit:
            break
        full = os.path.join(chat_dir, *rel.split("/"))
        try:
            with open(full, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read(_READ_HEAD_BYTES)
        except OSError:
            continue
        pos = text.lower().find(needle)
        if pos < 0:
            continue
        title, count = _derive_title_and_count(text)
        out.append({
            "key": rel,
            "filename": rel.split("/")[-1],
            "title": title or _file_stem(rel),
            "date": rel.split("/")[0] if "/" in rel else mtime[:10],
            "created_at": mtime,
            "size": size,
            "message_count": count,
            "snippet": _make_snippet(text, pos, keyword),
        })
    return out


@router.get("/search")
async def search_history(request: Request, q: str = Query(..., max_length=64),
                         limit: int = Query(30, ge=1, le=100)):
    """按正文检索自己的历史记录（标题/文件名过滤在前端即时做，这里只补正文命中）"""
    user = get_current_user(request)
    username = user["username"]
    keyword = (q or "").strip()
    chat_dir = os.path.realpath(get_account_chat_history_dir(username))
    if not keyword or not os.path.isdir(chat_dir):
        return {"results": [], "keyword": keyword}

    files = await asyncio.to_thread(_iter_history_files, chat_dir)
    hits = await asyncio.to_thread(_search_files, chat_dir, files, keyword, limit)
    return {"results": hits, "keyword": keyword, "scanned": len(files)}

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
        total_size = os.path.getsize(target_path)
        with open(target_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read(_MAX_HISTORY_READ_CHARS)
            # 还能再读到一个字符，说明文件被截断了
            truncated = bool(f.read(1))

        # 检测是否包含 HTML 代码块
        import re
        html_blocks = re.findall(r'```(?:html|HTML)\s*(.*?)\s*```', content, re.DOTALL)
        has_html = len(html_blocks) > 0

        return {
            "content": content,
            "filename": os.path.basename(target_path),
            "has_html": has_html,
            "html_blocks": html_blocks[:5] if has_html else [],
            "truncated": truncated,
            "total_size": total_size,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取文件失败: {str(e)}")


def _read_head_text(file_path: str, chars: int) -> str:
    """读文件开头一段并压成纯文本预览：去掉头信息与 Markdown 记号，代码块折叠成占位。

    预览是给"只想看一眼"用的，不做全文解析，也不渲染公式，所以读得越少越好。
    """
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            raw = f.read(max(int(chars), 50) * 4 + 2048)
    except OSError:
        return ""
    raw = re.sub(r"^文件:.*$", "", raw, flags=re.M)
    raw = re.sub(r"^创建时间:.*$", "", raw, flags=re.M)
    raw = re.sub(r"```[\s\S]*?```", "（代码块）", raw)
    raw = re.sub(r"\$+", "", raw)
    raw = re.sub(r"[#*_>`~]", "", raw)
    raw = re.sub(r"[ \t]+", " ", raw)
    raw = re.sub(r"\n{3,}", "\n\n", raw).strip()
    return raw[:chars]


@router.get("/preview")
async def preview_history_file(request: Request, path: str = Query(...),
                               chars: int = Query(400, ge=50, le=4000)):
    """悬浮/弹窗预览：只给开头一段，避免为了看一眼内容而替换当前对话"""
    user = get_current_user(request)
    username = user["username"]
    chat_dir = os.path.realpath(get_account_chat_history_dir(username))
    target = os.path.realpath(os.path.join(chat_dir, path))
    if not path_within(chat_dir, target) or not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="文件不存在或无权访问")

    rel = os.path.relpath(target, chat_dir).replace("\\", "/")
    preview = await asyncio.to_thread(_read_head_text, target, chars)
    row = execute_query(
        "SELECT title, message_count, file_size, created_at FROM conversations "
        "WHERE username=? AND filename=?", (username, rel))
    return {
        "title": (row[0][0] if row and row[0][0] else "") or _file_stem(rel),
        "filename": rel.split("/")[-1],
        "preview": preview,
        "message_count": (row[0][1] if row else 0) or 0,
        "size": (row[0][2] if row else 0) or os.path.getsize(target),
        "created_at": (row[0][3] if row else "") or "",
    }


@router.put("/title")
async def rename_history_title(request: Request):
    """改历史记录的显示标题：只动索引里的 title，不改磁盘文件名（避免路径与已有引用错位）"""
    user = get_current_user(request)
    username = user["username"]
    body = await request.json()
    path = str(body.get("path", "")).strip()
    title = re.sub(r"\s+", " ", str(body.get("title", ""))).strip()[:60]
    if not path:
        raise HTTPException(status_code=400, detail="缺少 path")
    if not title:
        raise HTTPException(status_code=400, detail="标题不能为空")

    chat_dir = os.path.realpath(get_account_chat_history_dir(username))
    target = os.path.realpath(os.path.join(chat_dir, path))
    if not path_within(chat_dir, target) or not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="文件不存在或无权访问")

    rel = os.path.relpath(target, chat_dir).replace("\\", "/")
    rows = execute_query("SELECT id FROM conversations WHERE username=? AND filename=?",
                         (username, rel))
    if rows:
        execute_insert_update(
            "UPDATE conversations SET title=? WHERE username=? AND filename=?",
            (title, username, rel))
    else:
        # 老文件可能还没进索引：补一行，别让改完标题反而在列表里看不见
        date_str = rel.split("/")[0] if "/" in rel else time.strftime("%Y-%m-%d")
        st = os.stat(target)
        _, count = _derive_title_and_count(_read_head_text(target, 4000))
        execute_insert_update(
            """INSERT OR REPLACE INTO conversations
               (username, session_id, date, filename, title, message_count, file_size, created_at)
               VALUES (?, '', ?, ?, ?, ?, ?, ?)""",
            (username, date_str, rel, title, max(count, 1), st.st_size,
             time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime))),
        )

    logger.info(f"[历史记录] 标题已更新: user={username} file={rel} title={title!r}")
    return {"message": "标题已更新", "title": title, "path": rel}

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


# ═══════════════════════════════════════════════════════════
# 自动保存的幂等语义（V8.6.1 修"问一遍，写两条"）
# ═══════════════════════════════════════════════════════════
#
# 前端 chatStore / companionStore 每次触发保存时提交的是**整段对话快照**
# （messages.map(...).join("---")），而 /save 一直是追加写 ——
# 于是第 2 轮把第 1 轮再抄一遍，第 3 轮把前两轮再抄一遍：
# 实测 root 会话 3 轮问答落盘成 6 轮（`root/ChatHistory/2026-10-11/conversation_20261011_221033.md`），
# 与 chat_turns 里的 3 组真实问答对不上。
#
# 这里按"快照"语义收敛，同时不破坏只提交增量的老客户端：
#   skip      —— 内容与已存内容一致（重复提交/重试），什么都不做
#   overwrite —— 来的是更长的完整快照（快照式客户端），整份替换
#   append    —— 来的是新的一小段（增量式客户端），照旧追加
_SEP_BLOCK = "\n\n---\n\n"


def _history_body(raw: str) -> str:
    """取历史文件正文（去掉「创建时间:」头、首尾分隔线）

    每次落盘都会在结尾留一条 `---`，比对前必须剥掉，否则"同一份快照重复提交"
    会因为尾部这条分隔线被判成内容变了而白写一遍（幂等就失效了）。
    """
    body = re.sub(r"^\s*创建时间:.*\n*", "", raw or "", count=1)
    body = re.sub(r"^\s*---\s*\n*", "", body, count=1)
    body = re.sub(r"(\s*\n\s*---\s*)+$", "", body)
    return body.strip()


def _block_count(text: str) -> int:
    """数消息块：按「**角色**:」行计（与 _derive_title_and_count 同口径）"""
    n = 0
    for line in (text or "").splitlines():
        if _ROLE_LINE.match(line.strip()):
            n += 1
    return n


def plan_history_write(existing_raw: str, incoming: str) -> tuple[str, str]:
    """返回 (动作, 应写入的正文)。动作 ∈ skip / overwrite / append。

    existing_raw 为空表示文件还不存在（首次落盘 → overwrite）。
    """
    incoming = (incoming or "").strip()
    existing = _history_body(existing_raw)
    if not existing:
        return ("overwrite", incoming)
    if not incoming or existing == incoming:
        return ("skip", existing)
    # 快照式客户端：来的是同一段的加长版（或老文件被重复追加过的脏快照）
    if _block_count(incoming) >= _block_count(existing):
        return ("overwrite", incoming)
    if existing.endswith(incoming):
        return ("skip", existing)      # 增量重复提交（网络重试等）
    return ("append", existing + _SEP_BLOCK + incoming)


def split_role_blocks(text: str) -> list[str]:
    """按「**角色**:」行切消息块（一条消息 = 角色行 + 其后所有行）

    不能按 `\n\n---\n\n` 切：助手回答里经常自带 `---` 分隔线（Markdown 水平线），
    会把一条消息劈成两块，清洗时既认错重复又可能删掉正文。
    """
    blocks: list[str] = []
    cur: list[str] = []

    def flush() -> None:
        if not cur:
            return
        # 块尾常挂着上一段留下的分隔线（"---"）与空行：留着它们再按 SEP 拼回去
        # 会变成两条分隔线，清洗出来的文件就比原文多一层横线
        while cur and (not cur[-1].strip() or cur[-1].strip() in ("---", "***", "—", "——")):
            cur.pop()
        if cur:
            blocks.append("\n".join(cur).strip())

    for line in (text or "").splitlines():
        if _ROLE_LINE.match(line.strip()):
            flush()
            cur = [line]
        elif cur:
            cur.append(line)
    flush()
    return [b for b in blocks if b]


def is_snapshot_accumulation(dirty_text: str, clean_text: str) -> bool:
    """证明脏文件 = 若干"从头 growing 的前缀快照"依次拼接（清洗可逆性的硬校验）

    逐段贪心匹配 clean 的前缀：能一段不多一段不少地拼回 dirty，说明被删掉的每一块
    都确实是旧快照重发；拼不出来就判为不可信，宁可留着重复也不删内容。
    """
    dirty = split_role_blocks(dirty_text)
    clean = split_role_blocks(clean_text)
    if not clean or len(dirty) <= len(clean):
        return False        # 没有"更长"就谈不上重发，等长的两份是同一份快照
    i, segs = 0, 0
    while i < len(dirty):
        for m in range(min(len(clean), len(dirty) - i), 0, -1):
            if dirty[i:i + m] == clean[:m]:
                i += m
                segs += 1
                break
        else:
            return False
    return segs >= 2


def collapse_snapshot_repeats(text: str) -> tuple[str, int]:
    """把「整段快照被反复追加」的历史折叠回真实轮次。返回 (清洗后正文, 丢弃块数)

    判据（三条同时成立才动刀，宁可漏洗不误删）：
    1. 文件开头的一整段，紧接着被**原样**重复了一遍 → 那一份是旧快照，删前者；
    2. 反复剥离后至少剩下一段不重复的尾巴（累计快照的形状：2、4、6… 递增）；
    3. 若整个文件只是"两段一模一样"（n = 2m 且只剥一次），判为**用户真的问了同样的问题**，
       不洗 —— 这种情况无法与"单轮被重复提交"区分，保留原样更安全。
    """
    blocks = split_role_blocks(text)
    original_n = len(blocks)
    strips: list[int] = []
    while len(blocks) >= 4:
        n = len(blocks)
        cut = 0
        for m in range(n // 2, 0, -1):
            if blocks[:m] == blocks[m:2 * m]:
                cut = m
                break
        if not cut:
            break
        strips.append(cut)
        blocks = blocks[cut:]
    if not strips:
        return (text or "").strip(), 0
    if len(strips) == 1 and strips[0] * 2 == original_n:
        return (text or "").strip(), 0          # 形状与"真重复提问"无法区分 → 不洗
    return _SEP_BLOCK.join(blocks), sum(strips)


def save_history_snapshot(file_path: str, content: str) -> str:
    """按快照语义落盘一份对话历史，返回实际动作：skip / overwrite / append

    单独成函数是为了能被离线单测直接喂 tmp_path 验"问一遍不会写两条"。
    """
    from datetime import datetime
    existing_raw = ""
    if os.path.isfile(file_path):
        try:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                existing_raw = f.read()
        except OSError as e:
            logger.warning(f"历史文件预读失败，按整份写入: {file_path} - {e}")
    action, body = plan_history_write(existing_raw, content)
    if action == "skip":
        return action

    # 「创建时间」沿用文件里原有的那份，整份替换时不把它冲掉
    m_created = re.match(r"^\s*创建时间:\s*(.+?)\s*$", existing_raw or "")
    created = m_created.group(1) if m_created else ""
    header = f"创建时间: {created or datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n"
    tmp_path = f"{file_path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(f"{header}{body}\n\n---\n\n")
    os.replace(tmp_path, file_path)       # 原子替换：中途断电也不会留下半份快照
    return action


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
        action = save_history_snapshot(file_path, payload)

        # 更新 DB 索引(统一用相对 chat_dir 的路径)
        rel_path = os.path.relpath(file_path, chat_dir).replace("\\", "/")
        fsize = os.path.getsize(file_path)
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 标题与条数：按整份文件算（同一文件多次追加时标题仍是第一条学生发言）。
        # 旧实现根本不写这两列，历史列表只能显示 20260926_074756 这种时间戳文件名。
        title, msg_count = _read_title_and_count(file_path)
        if not title or not msg_count:
            old = execute_query(
                "SELECT title, message_count FROM conversations "
                "WHERE username=? AND date=? AND filename=?",
                (username, date_str, rel_path),
            )
            if old:
                title = title or (old[0][0] or "")
                msg_count = msg_count or (old[0][1] or 0)
        execute_insert_update(
            """INSERT OR REPLACE INTO conversations
               (username, session_id, date, filename, title, message_count, file_size, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (username, session_id or "", date_str, rel_path, title, msg_count, fsize, now),
        )

        # H4: 不再回传服务器绝对路径
        brief = {"skip": "对话已是最新（未重复写入）", "overwrite": "对话已保存（整份快照）",
                 "append": "对话已保存（追加）"}
        return {"message": brief.get(action, "对话已保存"), "path": rel_path,
                "filename": os.path.basename(file_path), "action": action}
    except Exception as e:
        logger.error(f"保存对话记录失败: {e}")
        raise HTTPException(status_code=500, detail=f"保存失败: {str(e)}")
