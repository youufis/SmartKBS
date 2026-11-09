"""探索画布 · 页面文本索引（搜索用）

为什么需要：`list_canvases` 的全文搜索原来是 `pc_pages.snapshot_data LIKE '%kw%'`，
而单页快照可达 8MB —— 学生一多就变成全表 JSON 扫描。这里在保存时把页面里的文字
抽出来单独存一张小表（每页通常几百字），搜索只扫这张表，体积差两个数量级。

抽取用正则而不是 json.loads：每次保存都完整解析 8MB 快照太贵；文本只是给搜索用，
丢掉结构信息完全够。
"""
import re
import threading
from datetime import datetime

from backend.database import get_connection
from backend.logger import logger

_TEXT_RE = re.compile(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"')
_ESC = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/"}
MAX_TEXT_PER_PAGE = 4000          # 单页只留前 4000 字，够搜索用，避免表膨胀

_STARTED = False
_LOCK = threading.Lock()


def _unescape(s: str) -> str:
    if "\\" not in s:
        return s
    out = []
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == "\\" and i + 1 < n:
            nxt = s[i + 1]
            if nxt in _ESC:
                out.append(_ESC[nxt])
                i += 2
                continue
            if nxt == "u" and i + 5 < n:
                try:
                    out.append(chr(int(s[i + 2:i + 6], 16)))
                    i += 6
                    continue
                except ValueError:
                    pass
        out.append(ch)
        i += 1
    return "".join(out)


def extract_text(snapshot: str, limit: int = MAX_TEXT_PER_PAGE) -> str:
    """从 tldraw 快照 JSON 里抽纯文本（卡片标题、便签、提问卡、文本框都在 props.text）。"""
    if not snapshot:
        return ""
    parts = []
    total = 0
    for m in _TEXT_RE.finditer(snapshot):
        t = _unescape(m.group(1)).strip()
        if not t:
            continue
        parts.append(t)
        total += len(t)
        if total >= limit:
            break
    return "\n".join(parts)[:limit]


def index_page(c, canvas_id: int, page_number: int, snapshot: str, now: str) -> None:
    """在保存事务里顺带更新索引（同一条连接，避免多一次事务开销）。"""
    try:
        text = extract_text(snapshot)
        c.execute(
            "INSERT INTO pc_page_text (canvas_id, page_number, text, updated_at) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(canvas_id, page_number) DO UPDATE SET text = excluded.text,"
            " updated_at = excluded.updated_at",
            (canvas_id, page_number, text, now),
        )
    except Exception as e:
        logger.warning("[explore] 文本索引更新失败 canvas=%s page=%s: %s", canvas_id, page_number, e)


def drop_page(c, canvas_id: int, page_number: int) -> None:
    c.execute("DELETE FROM pc_page_text WHERE canvas_id = ? AND page_number = ?", (canvas_id, page_number))


def drop_canvas(c, canvas_id: int) -> None:
    c.execute("DELETE FROM pc_page_text WHERE canvas_id = ?", (canvas_id,))


def backfill(batch: int = 200) -> int:
    """给存量页面补索引（只跑一次，靠 pc_page_text 自身是否已有行判断）。"""
    done = 0
    while True:
        with get_connection() as conn:
            c = conn.cursor()
            rows = c.execute(
                "SELECT p.canvas_id, p.page_number, p.snapshot_data FROM pc_pages p"
                " WHERE NOT EXISTS (SELECT 1 FROM pc_page_text t"
                "  WHERE t.canvas_id = p.canvas_id AND t.page_number = p.page_number)"
                " LIMIT ?", (batch,)).fetchall()
            if not rows:
                return done
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            for cid, pn, snap in rows:
                index_page(c, cid, pn, snap or "", now)
            conn.commit()
            done += len(rows)
    return done


def _loop() -> None:
    try:
        n = backfill()
        if n:
            logger.info("[explore] 页面文本索引补齐 %s 页", n)
    except Exception as e:
        logger.warning("[explore] 文本索引补齐失败: %s", e)


def start_backfill() -> None:
    """main.py lifespan 调用；只起一个后台线程，失败不影响启动。"""
    global _STARTED
    if _STARTED:
        return
    with _LOCK:
        if _STARTED:
            return
        _STARTED = True
    threading.Thread(target=_loop, name="explore-text-index", daemon=True).start()
