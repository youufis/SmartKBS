"""本地知识库（独立模块）——SQLite 权威源 + FTS5 关键词腿 + Chroma 向量腿。

设计约束（见 docs/本地知识库方案-v2-向量版.md）：
- 独立目录：DB_DIR/local_kb.db、STORAGE_DIR/kb_files、STORAGE_DIR/kb_vectors
- 不与文件中心/资源中心共用任何存储与配额
- chromadb 全链路懒加载（冷导入约 4s，不得进启动关键路径）
- 任何一条腿挂掉，另一条腿照常可用；向量签名不一致时 fail-closed 只走关键词
"""
from __future__ import annotations

import hashlib
import os
import queue
import re
import shutil
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from backend.config import DB_DIR, STORAGE_DIR
from backend.logger import logger

STD_EXTS = {".md", ".txt", ".docx", ".pdf"}
EXT_OK = STD_EXTS  # 兼容旧引用；实际判断请用 allowed_exts()


def allowed_exts() -> set:
    """允许上传的格式：配置只能在已支持解析的四种里增减。"""
    raw = _cfg("LOCAL_KB_EXTENSIONS", None)
    if isinstance(raw, list) and raw:
        exts = {str(x).lower() for x in raw if str(x).lower() in STD_EXTS}
        if exts:
            return exts
    return set(STD_EXTS)
EXT_LEGACY = {".doc", ".xls", ".xlsx", ".ppt", ".pptx", ".csv", ".html", ".htm"}

_INJECT_HEAD = (
    "【本地知识库资料】以下内容检索自本校知识库（标注了文档名与相关度）。"
    "若与当前任务相关，请优先以其为依据作答或创作，并保留任务原有的输出格式要求；"
    "与任务无关时忽略本资料。\n\n"
)

_worker_lock = threading.Lock()
_workers_started = False
_queue: "queue.Queue[int]" = queue.Queue()
_chroma_client = None
_chroma_lock = threading.Lock()
_count_cache = {"t": 0.0, "n": 0}
_ollama_cache = {"t": 0.0, "ok": False}
_model_cache = {"t": 0.0, "model": "", "ok": False}


# ── 配置 ──
def _cfg(key: str, default: Any = None) -> Any:
    try:
        from backend.api.config_router import get_config_value
        return get_config_value(key, default)
    except Exception:
        return default


def enabled() -> bool:
    return bool(_cfg("LOCAL_KB_ENABLED", False))


def _trash_days() -> int:
    try:
        return int(_cfg("LOCAL_KB_TRASH_DAYS", 30) or 30)
    except Exception:
        return 30


def _max_file_mb() -> int:
    try:
        return int(_cfg("LOCAL_KB_MAX_FILE_MB", 20) or 20)
    except Exception:
        return 20


def _max_docs() -> int:
    try:
        return int(_cfg("LOCAL_KB_MAX_DOCS", 500) or 500)
    except Exception:
        return 500


def _max_total_mb() -> int:
    try:
        return int(_cfg("LOCAL_KB_MAX_TOTAL_MB", 200) or 200)
    except Exception:
        return 200


def _max_pages() -> int:
    try:
        return int(_cfg("LOCAL_KB_MAX_PAGES", 500) or 500)
    except Exception:
        return 500


# 与 DEFAULT_CONFIG 同口径，避免键缺失时代码三处分支各自漂移
_DUAL_DEFAULT = False
# 单通道 embedding 尝试次数（首发 + 2 次重试），瞬时失败按 2s/6s 退避后断点续传
_VEC_ATTEMPTS = 3
_VEC_RETRY_DELAYS = (2.0, 6.0)


def _rel_path(p: Any) -> str:
    """kb_docs.path 一律按相对 STORAGE_DIR 存储：搬根/换机后可用；存储根之外的旧绝对值原样保留。"""
    s = str(p or "")
    if not s:
        return s
    try:
        return str(Path(s).relative_to(Path(STORAGE_DIR))).replace("\\", "/")
    except Exception:
        return s


def _abs_path(p: Any) -> str:
    """kb_docs.path → 当前绝对路径：相对值拼回存储根，历史绝对值原样使用。"""
    s = str(p or "")
    if not s:
        return s
    q = Path(s)
    if q.is_absolute():
        return s
    return str(Path(STORAGE_DIR) / s.replace("/", os.sep))


def _is_transient_error(e: BaseException) -> bool:
    """区分 embedding 的瞬时失败（值得重试）与鉴权/配置类失败（重试无意义，快速失败）。"""
    try:
        import httpx
        if isinstance(e, (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)):
            return True
        if isinstance(e, httpx.HTTPStatusError):
            code = int(e.response.status_code)
            return code == 429 or code >= 500
    except Exception:
        pass
    if isinstance(e, OSError):
        return True
    msg = str(e).lower()
    m = re.search(r"http (\d{3})", msg)
    if m:
        code = int(m.group(1))
        return code == 429 or code >= 500
    return any(h in msg for h in ("timeout", "timed out", "connect", "connection reset",
                                  "temporarily", "unavailable", "too many requests", "rate limit"))


# ── 路径与连接 ──
def db_path() -> Path:
    return Path(DB_DIR) / "local_kb.db"


def files_dir() -> Path:
    p = Path(STORAGE_DIR) / "kb_files"
    p.mkdir(parents=True, exist_ok=True)
    return p


def tmp_dir() -> Path:
    p = files_dir() / "_tmp"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _vectors_dir() -> Path:
    p = Path(STORAGE_DIR) / "kb_vectors"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(db_path()), timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.execute("PRAGMA busy_timeout=30000")
    c.execute("PRAGMA foreign_keys=ON")
    return c

def init_db() -> None:
    c = _conn()
    try:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS kb_docs(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL DEFAULT '',
          sha256 TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          pages INTEGER NOT NULL DEFAULT 0,
          chunks INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          progress INTEGER NOT NULL DEFAULT 0,
          vec_state TEXT NOT NULL DEFAULT 'pending',
          vec_collection TEXT DEFAULT '',
          error TEXT DEFAULT '',
          visibility TEXT NOT NULL DEFAULT 'school',
          owner TEXT DEFAULT '',
          source TEXT NOT NULL DEFAULT 'upload',
          folder_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          deleted_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_kb_docs_status ON kb_docs(status);
        CREATE TABLE IF NOT EXISTS kb_folders(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          owner TEXT DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_docs_sha_active
          ON kb_docs(sha256) WHERE status != 'deleted';
        CREATE TABLE IF NOT EXISTS kb_doc_vec(
          doc_id INTEGER NOT NULL,
          sig TEXT NOT NULL,
          collection TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL DEFAULT 'done',
          error TEXT DEFAULT '',
          updated_at TEXT NOT NULL,
          PRIMARY KEY(doc_id, sig)
        );
        CREATE INDEX IF NOT EXISTS idx_kb_doc_vec_sig ON kb_doc_vec(sig, state);
        CREATE TABLE IF NOT EXISTS kb_chunks(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_id INTEGER NOT NULL,
          ord INTEGER NOT NULL DEFAULT 0,
          title TEXT DEFAULT '',
          text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);
        CREATE TABLE IF NOT EXISTS kb_audit(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_id INTEGER,
          action TEXT NOT NULL,
          username TEXT DEFAULT '',
          detail TEXT DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
          text, content='kb_chunks', content_rowid='id', tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
          INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
          INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE OF text ON kb_chunks BEGIN
          INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
        """)
        cols = {r["name"] for r in c.execute("PRAGMA table_info(kb_docs)").fetchall()}
        if "folder_id" not in cols:
            c.execute("ALTER TABLE kb_docs ADD COLUMN folder_id INTEGER")
        c.execute("CREATE INDEX IF NOT EXISTS idx_kb_docs_folder ON kb_docs(folder_id)")
        # 历史绝对路径一次性转为相对 STORAGE_DIR（读侧 _abs_path 始终兼容绝对值）
        for r in c.execute("SELECT id,path FROM kb_docs WHERE path != ''").fetchall():
            rel = _rel_path(r["path"])
            if rel != r["path"]:
                c.execute("UPDATE kb_docs SET path=? WHERE id=?", (rel, int(r["id"])))
        c.commit()
    finally:
        c.close()


def _audit(doc_id: Optional[int], action: str, username: str = "", detail: str = "") -> None:
    try:
        c = _conn()
        c.execute("INSERT INTO kb_audit(doc_id, action, username, detail, created_at) VALUES(?,?,?,?,?)",
                  (doc_id, action, username, detail[:200], _now()))
        c.commit()
        c.close()
    except Exception as e:
        logger.warning(f"[KB] audit 写入失败: {e}")


def safe_name(name: str) -> str:
    base = os.path.basename(str(name or "")).strip().replace("\x00", "")
    base = re.sub(r'[\\\\/:*?"<>|]+', "_", base)
    base = base.lstrip(".") or "document"
    stem, ext = os.path.splitext(base)
    return (stem[:100] + ext.lower())[:120]


def _disk_name(doc_id: int, name: str) -> str:
    safe = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "_", name).strip("._") or "doc"
    return f"{doc_id}_{safe[:100]}"


def _read_text_file(path: Path) -> str:
    data = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore")


def _md_blocks(text: str) -> list[dict]:
    blocks, title = [], ""
    for line in (text or "").splitlines():
        s = line.strip()
        if not s:
            continue
        if re.match(r"^#{1,6}\s+", s):
            title = re.sub(r"^#{1,6}\s+", "", s).strip()
            continue
        blocks.append({"title": title, "text": s})
    return blocks


def _txt_blocks(text: str) -> list[dict]:
    blocks = []
    for para in re.split(r"\n\s*\n", text or ""):
        p = " ".join(x.strip() for x in para.splitlines() if x.strip())
        if p:
            blocks.append({"title": "", "text": p})
    return blocks


def _docx_blocks(path: Path) -> tuple[list[dict], int, int]:
    from docx import Document
    doc = Document(str(path))
    blocks, title, chars = [], "", 0
    for p in doc.paragraphs:
        t = (p.text or "").strip()
        if not t:
            continue
        style = ""
        try:
            style = (p.style.name or "")
        except Exception:
            pass
        if re.match(r"(?i)^heading\s*\d", style) or style in ("Title", "标题"):
            title = t
            continue
        chars += len(t)
        blocks.append({"title": title, "text": t})
    for tbl in doc.tables:
        rows = []
        for row in tbl.rows:
            cells = [(cell.text or "").strip() for cell in row.cells]
            if any(cells):
                rows.append(" | ".join(cells))
        txt = "\n".join(rows).strip()
        if txt:
            chars += len(txt)
            blocks.append({"title": title, "text": txt})
    return blocks, 0, chars


def _pdf_blocks(path: Path) -> tuple[list[dict], int, int]:
    from PyPDF2 import PdfReader
    reader = PdfReader(str(path))
    if getattr(reader, "is_encrypted", False):
        raise ValueError("PDF 已加密，无法解析")
    blocks, chars = [], 0
    pages = len(reader.pages)
    limit = _max_pages()
    if pages > limit:
        raise ValueError(f"PDF 共 {pages} 页，超过单篇 {limit} 页上限，请按章节拆分后上传")
    for i, page in enumerate(reader.pages):
        try:
            t = (page.extract_text() or "").strip()
        except Exception:
            t = ""
        if not t:
            continue
        chars += len(t)
        for para in re.split(r"\n\s*\n|\r\n\s*\r\n", t):
            p = " ".join(x.strip() for x in para.splitlines() if x.strip())
            if p:
                blocks.append({"title": f"第{i + 1}页", "text": p})
    return blocks, pages, chars


def extract_blocks(path: Path) -> tuple[list[dict], int, int]:
    ext = path.suffix.lower()
    if ext == ".md":
        text = _read_text_file(path)
        return _md_blocks(text), 0, len(text)
    if ext == ".txt":
        text = _read_text_file(path)
        return _txt_blocks(text), 0, len(text)
    if ext == ".docx":
        return _docx_blocks(path)
    if ext == ".pdf":
        return _pdf_blocks(path)
    raise ValueError(f"不支持的格式 {ext}")


def _pack(blocks: list[dict], target: int = 400, hard: int = 900, overlap: int = 60) -> list[dict]:
    chunks: list[dict] = []
    cur, cur_title = "", ""

    def flush() -> None:
        nonlocal cur
        t = cur.strip()
        if t:
            chunks.append({"text": t[:hard], "title": cur_title})
        cur = ""

    for b in blocks:
        t = (b.get("text") or "").strip()
        if not t:
            continue
        title = b.get("title") or ""
        if title and title != cur_title:
            flush()
            cur_title = title
        if len(t) > hard:
            flush()
            for i in range(0, len(t), hard - overlap):
                piece = t[i:i + hard].strip()
                if piece:
                    chunks.append({"text": piece, "title": cur_title})
            continue
        if len(cur) + len(t) + 1 > hard:
            tail = cur[-overlap:] if overlap and len(cur) > overlap else ""
            flush()
            cur = (tail + "\n" + t).strip() if tail else t
            if len(cur) >= target:
                flush()
        else:
            cur = (cur + "\n" + t).strip() if cur else t
            if len(cur) >= target:
                flush()
    flush()
    return [c for c in chunks if len(c["text"]) >= 8]

# ── 向量通道 ──
def _ollama_base() -> str:
    return str(_cfg("OLLAMA_API_BASE", "http://localhost:11434/v1") or "http://localhost:11434/v1").rstrip("/")


def _ollama_alive() -> bool:
    now = time.time()
    if now - _ollama_cache["t"] < 60:
        return _ollama_cache["ok"]
    ok = False
    try:
        import httpx
        r = httpx.get(_ollama_base() + "/models", timeout=1.5)
        ok = r.status_code < 500
    except Exception:
        ok = False
    _ollama_cache.update({"t": now, "ok": ok})
    return ok


def embed_provider() -> str:
    p = str(_cfg("LOCAL_KB_EMBED_PROVIDER", "cloud") or "cloud").lower()
    mode = str(_cfg("AI_MODE", "cloud") or "cloud")
    if p in ("cloud", "local"):
        return p                # 显式选择优先，不被 AI_MODE 覆盖
    if mode == "local":
        return "local"
    if mode == "hybrid" and _ollama_alive():
        return "local"
    return "cloud"


def embed_model(provider: str) -> str:
    if provider == "local":
        return str(_cfg("LOCAL_KB_EMBED_MODEL_LOCAL", "bge-m3") or "bge-m3")
    return str(_cfg("LOCAL_KB_EMBED_MODEL_CLOUD", "text-embedding-v4") or "text-embedding-v4")


def _embed_dim() -> int:
    try:
        return int(_cfg("LOCAL_KB_EMBED_DIM", 1024) or 1024)
    except Exception:
        return 1024


def embed_sig(provider: Optional[str] = None) -> str:
    p = provider or embed_provider()
    return f"{p}|{embed_model(p)}|{_embed_dim()}"


def _collection_name(sig: str) -> str:
    return "kb_" + hashlib.sha1(sig.encode("utf-8")).hexdigest()[:12]


def _resolve_api_key() -> str:
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not key:
        key = str(_cfg("dashscope_api_key", "") or "").strip()
    return key


def _embed_cloud(texts: list[str], text_type: str = "document", timeout: float = 30.0) -> list[list[float]]:
    import httpx
    key = _resolve_api_key()
    if not key:
        raise RuntimeError("未配置 DashScope API Key")
    from backend.config import ai_api_bases
    model = embed_model("cloud")
    dim = _embed_dim()
    last: Optional[Exception] = None
    for base in ai_api_bases():
        url = base.rstrip("/") + "/embeddings"
        for payload in (
            {"model": model, "input": texts, "dimensions": dim, "encoding_format": "float"},
            {"model": model, "input": texts},
        ):
            try:
                r = httpx.post(url, headers={"Authorization": f"Bearer {key}"}, json=payload, timeout=timeout)
                if r.status_code == 200:
                    data = (r.json() or {}).get("data") or []
                    if len(data) != len(texts):
                        raise RuntimeError(f"embedding 返回条数不符 {len(data)}/{len(texts)}")
                    return [d.get("embedding") or [] for d in data]
                last = RuntimeError(f"HTTP {r.status_code}: {r.text[:160]}")
            except Exception as e:
                last = e
    raise last or RuntimeError("云端 embedding 失败")


def _embed_local(texts: list[str], timeout: float = 90.0) -> list[list[float]]:
    import httpx
    model = embed_model("local")
    r = httpx.post(_ollama_base() + "/embeddings",
                   json={"model": model, "input": texts}, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"Ollama HTTP {r.status_code}: {r.text[:120]}")
    data = (r.json() or {}).get("data") or []
    if len(data) != len(texts):
        raise RuntimeError("Ollama embedding 返回条数不符")
    return [d.get("embedding") or [] for d in data]


def embed_texts(texts: list[str], provider: Optional[str] = None, text_type: str = "document") -> list[list[float]]:
    p = provider or embed_provider()
    if p == "local":
        return _embed_local(texts)
    return _embed_cloud(texts, text_type=text_type)


def _chroma():
    global _chroma_client
    if _chroma_client is not None:
        return _chroma_client
    with _chroma_lock:
        if _chroma_client is None:
            import chromadb
            _chroma_client = chromadb.PersistentClient(path=str(_vectors_dir()))
    return _chroma_client


def _collection(sig: Optional[str] = None, create: bool = True):
    s = sig or embed_sig()
    name = _collection_name(s)
    try:
        client = _chroma()
        if create:
            return client.get_or_create_collection(
                name=name, metadata={"hnsw:space": "cosine", "embed_sig": s})
        return client.get_collection(name=name)
    except Exception:
        return None


def _delete_vectors(collection_name: str, ids: list[int]) -> None:
    if not collection_name or not ids:
        return
    try:
        col = _chroma().get_collection(collection_name)
        for i in range(0, len(ids), 400):
            col.delete(ids=[str(x) for x in ids[i:i + 400]])
    except Exception as e:
        logger.warning(f"[KB] 向量删除失败 {collection_name}: {e}")


def _record_vec(doc_id: int, sig: str, collection: str, state: str, error: str = "") -> None:
    """记录某文档在某向量通道上的状态（done/failed）。"""
    try:
        c = _conn()
        try:
            c.execute("INSERT INTO kb_doc_vec(doc_id,sig,collection,state,error,updated_at) VALUES(?,?,?,?,?,?) "
                      "ON CONFLICT(doc_id,sig) DO UPDATE SET collection=excluded.collection, "
                      "state=excluded.state, error=excluded.error, updated_at=excluded.updated_at",
                      (doc_id, sig, collection or "", state, error[:200], _now()))
            c.commit()
        finally:
            c.close()
    except Exception as e:
        logger.warning(f"[KB] 向量状态写入失败 doc={doc_id}: {e}")


def _clear_doc_vectors(doc_id: int) -> None:
    """删除文档在所有向量通道的向量与记录（重索引/移除/彻底删除时调用）。"""
    c = _conn()
    try:
        ids = [int(r["id"]) for r in c.execute("SELECT id FROM kb_chunks WHERE doc_id=?", (doc_id,)).fetchall()]
        rows = c.execute("SELECT collection FROM kb_doc_vec WHERE doc_id=?", (doc_id,)).fetchall()
        c.execute("DELETE FROM kb_doc_vec WHERE doc_id=?", (doc_id,))
        c.commit()
    finally:
        c.close()
    for r in rows:
        _delete_vectors(r["collection"], ids)


def _ollama_model_present(model: str) -> bool:
    now = time.time()
    if now - _model_cache["t"] < 60 and _model_cache["model"] == model:
        return bool(_model_cache["ok"])
    ok = _ollama_model_present_uncached(model)
    _model_cache.update({"t": now, "model": model, "ok": ok})
    return ok


def _ollama_model_present_uncached(model: str) -> bool:
    try:
        import httpx
        r = httpx.get(_ollama_base() + "/models", timeout=1.5)
        if r.status_code != 200:
            return False
        data = (r.json() or {}).get("data") or []
        base = str(model).split(":")[0]
        return any(str(m.get("id") or "").split(":")[0] == base for m in data)
    except Exception:
        return False


def _target_channels() -> list[str]:
    """索引通道：以用户选择的通道为主；双通道开启时另一通道可用也一并写入。"""
    primary = embed_provider()
    if not bool(_cfg("LOCAL_KB_DUAL_INDEX", _DUAL_DEFAULT)):
        return [primary]
    channels: list[str] = []

    def _add(p: str) -> None:
        if p == "cloud":
            if _resolve_api_key() and "cloud" not in channels:
                channels.append("cloud")
        elif p == "local":
            if _ollama_alive() and _ollama_model_present(embed_model("local")) and "local" not in channels:
                channels.append("local")

    _add(primary)
    _add("local" if primary == "cloud" else "cloud")
    return channels or [primary]

# ── 索引 worker ──
def _reset_stale() -> None:
    cutoff = (datetime.now() - timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M:%S")
    c = _conn()
    try:
        n = c.execute("UPDATE kb_docs SET status='pending', progress=0, updated_at=? "
                      "WHERE status='indexing' AND updated_at < ?", (_now(), cutoff)).rowcount
        c.commit()
        if n:
            logger.info(f"[KB] 重置超时索引任务 {n} 个")
    finally:
        c.close()


def _enqueue_pending() -> None:
    c = _conn()
    try:
        for row in c.execute("SELECT id FROM kb_docs WHERE status='pending' ORDER BY id").fetchall():
            _queue.put(int(row["id"]))
    finally:
        c.close()


def _set_doc(doc_id: int, **fields: Any) -> None:
    if not fields:
        return
    fields["updated_at"] = _now()
    cols = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [doc_id]
    c = _conn()
    try:
        c.execute(f"UPDATE kb_docs SET {cols} WHERE id=?", vals)
        c.commit()
    finally:
        c.close()


def _claim_pending(doc_id: int) -> bool:
    """原子认领：只有 pending 才能进入 indexing，防止同一文档被队列重复处理。"""
    c = _conn()
    try:
        n = c.execute("UPDATE kb_docs SET status='indexing', progress=1, error='', vec_state='pending', "
                      "updated_at=? WHERE id=? AND status='pending'", (_now(), doc_id)).rowcount
        c.commit()
        return n > 0
    finally:
        c.close()


def _vectorize_chunks(doc_id: int, ids: list[int], chunks: list[dict],
                      channels: list[str], done_sigs: set[str],
                      cleanup_on_delete: bool = True) -> tuple[str, str, str]:
    """把既有切片按目标通道写入 Chroma（upsert 可重入：中断重跑不产生重复或孤儿）。

    - done_sigs：已成功的通道直接跳过，增量补灌不对云通道重复计费；
    - 瞬时网络类错误在同一通道内最多重试 _VEC_ATTEMPTS 次（退避 2s/6s），从断点续传；
      鉴权/配置类错误快速失败，交给半小时一次的自动补灌或人工重建；
    - cleanup_on_delete：文档中途被删时，索引路径清理切片与向量（原行为），
      补灌路径只需停止——remove_doc 已经清过，绝不能反过来删掉关键词索引。
    返回 (vec_state, error, 首个成功集合名)，vec_state ∈ done/failed/off/deleted。
    """
    errors: list[str] = []
    col_name = ""
    done_any = False
    seg = 65.0 / max(1, len(channels))
    for ci, p in enumerate(channels):
        sig = embed_sig(p)
        if sig in done_sigs:
            done_any = True      # 仅当前通道签名已 done 才算成功；旧签名的 done 不得掩盖当前通道的失败
            continue
        col = _collection(sig)
        if col is None:
            errors.append(f"{p}: 向量库不可用")
            _record_vec(doc_id, sig, "", "failed", "向量库不可用")
            continue
        batch = 10 if p == "cloud" else 8
        added = 0
        last_err: Optional[BaseException] = None
        for attempt in range(_VEC_ATTEMPTS):
            last_err = None
            try:
                while added < len(ids):
                    cr = _conn()
                    try:
                        st = cr.execute("SELECT status FROM kb_docs WHERE id=?", (doc_id,)).fetchone()
                    finally:
                        cr.close()
                    if not st or st["status"] == "deleted":
                        if cleanup_on_delete:
                            _delete_vectors(_collection_name(sig), ids[:added])
                            c2 = _conn()
                            try:
                                c2.execute("DELETE FROM kb_chunks WHERE doc_id=?", (doc_id,))
                                c2.execute("DELETE FROM kb_doc_vec WHERE doc_id=?", (doc_id,))
                                c2.commit()
                            finally:
                                c2.close()
                            _count_cache["t"] = 0
                        return "deleted", "", ""
                    part = ids[added:added + batch]
                    texts = [chunks[j]["text"] for j in range(added, added + len(part))]
                    vecs = embed_texts(texts, provider=p)
                    metas = [{"doc_id": doc_id, "ord": added + j,
                              "title": (chunks[added + j].get("title") or "")[:200]}
                             for j in range(len(part))]
                    col.upsert(ids=[str(x) for x in part], embeddings=vecs, metadatas=metas)
                    added += len(part)
                    if cleanup_on_delete:      # 进度语义只属于索引路径，补灌不得回退 ready 文档进度
                        prog = 30 + int(seg * (ci + added / max(1, len(ids))))
                        _set_doc(doc_id, progress=min(95, prog))
                    time.sleep(0.05 if p == "cloud" else 0.2)
                break
            except Exception as e:
                last_err = e
                if not _is_transient_error(e) or attempt >= _VEC_ATTEMPTS - 1:
                    break
                delay = _VEC_RETRY_DELAYS[min(attempt, len(_VEC_RETRY_DELAYS) - 1)]
                logger.info(f"[KB] 通道 {p} 瞬时失败（{str(e)[:120]}），{delay:.0f}s 后断点续传 id={doc_id}")
                time.sleep(delay)
        if last_err is not None:
            msg = str(last_err)[:200]
            errors.append(f"{p}: {msg}")
            _record_vec(doc_id, sig, _collection_name(sig), "failed", msg)
            logger.warning(f"[KB] 向量化失败通道={p} id={doc_id}: {msg}")
        else:
            done_any = True
            _record_vec(doc_id, sig, _collection_name(sig), "done", "")
            if not col_name:
                col_name = _collection_name(sig)      # 兼容字段：第一成功通道
    vec_state = "done" if done_any else ("off" if not channels else "failed")
    return vec_state, "; ".join(errors)[:300], col_name


def _process_doc(doc_id: int) -> None:
    c = _conn()
    try:
        row = c.execute("SELECT * FROM kb_docs WHERE id=?", (doc_id,)).fetchone()
    finally:
        c.close()
    if not row or row["status"] == "deleted":
        return
    if not _claim_pending(doc_id):
        return
    path = Path(_abs_path(row["path"]))
    if not path.exists():
        _set_doc(doc_id, status="failed", error="源文件缺失", vec_state="off", progress=0)
        return

    _set_doc(doc_id, progress=2)
    _clear_doc_vectors(doc_id)
    try:
        blocks, pages, chars = extract_blocks(path)
        if chars < 30 or not blocks:
            _set_doc(doc_id, status="empty", progress=100, vec_state="off",
                     error="未检测到可索引文本（扫描版 PDF 或空文档）")
            logger.info(f"[KB] 文档无文本 id={doc_id} name={row['name']}")
            return
        chunks = _pack(blocks)
        if not chunks:
            _set_doc(doc_id, status="empty", progress=100, vec_state="off", error="切片为空")
            return

        # 解析期间可能已被用户移除：写切片前再确认一次，避免给已删文档补回孤儿切片
        chk = _conn()
        try:
            st = chk.execute("SELECT status FROM kb_docs WHERE id=?", (doc_id,)).fetchone()
        finally:
            chk.close()
        if not st or st["status"] == "deleted":
            return

        c = _conn()
        try:
            c.execute("DELETE FROM kb_chunks WHERE doc_id=?", (doc_id,))
            ids = []
            for i, ch in enumerate(chunks):
                cur = c.execute("INSERT INTO kb_chunks(doc_id, ord, title, text) VALUES(?,?,?,?)",
                                (doc_id, i, (ch.get("title") or "")[:200], ch["text"]))
                ids.append(int(cur.lastrowid))
            c.execute("UPDATE kb_docs SET pages=?, chunks=?, progress=30, updated_at=? WHERE id=?",
                      (pages, len(chunks), _now(), doc_id))
            c.commit()
        finally:
            c.close()

        vec_state, vec_err, col_name = "off", "", ""
        if enabled():
            vec_state, vec_err, col_name = _vectorize_chunks(
                doc_id, ids, chunks, _target_channels(), set(), cleanup_on_delete=True)
            if vec_state == "deleted":
                return

        _set_doc(doc_id, status="ready", progress=100, vec_state=vec_state,
                 vec_collection=col_name, error=vec_err)
        logger.info(f"[KB] 索引完成 id={doc_id} chunks={len(chunks)} vec={vec_state}")
    except ValueError as e:
        _set_doc(doc_id, status="failed", progress=0, vec_state="off", error=str(e)[:300])
        logger.info(f"[KB] 解析失败 id={doc_id}: {e}")
    except Exception as e:
        _set_doc(doc_id, status="failed", progress=0, vec_state="off", error=str(e)[:300])
        logger.warning(f"[KB] 索引异常 id={doc_id}: {e}")


def _worker_loop() -> None:
    while True:
        doc_id = _queue.get()
        try:
            _process_doc(doc_id)
        except Exception as e:
            logger.error(f"[KB] worker 异常 doc={doc_id}: {e}")
        finally:
            _queue.task_done()


def _housekeeping_loop() -> None:
    last_reconcile = 0.0
    last_audit = time.time()
    ticks = 0
    while True:
        time.sleep(600)
        ticks += 1
        try:
            _purge_expired_trash()
        except Exception as e:
            logger.warning(f"[KB] 回收站清理失败: {e}")
        if ticks % 3 == 0:
            # 自愈：embedding 通道恢复后，自动补上此前瞬时失败/集合缺失的向量（限 20 篇/轮）
            try:
                res = refill_vectors(limit=20)
                if res.get("ok") and res.get("targeted"):
                    logger.info(f"[KB] 自动补向量：成功 {res.get('done')}，失败 {res.get('failed')}")
            except Exception as e:
                logger.warning(f"[KB] 自动补向量失败: {e}")
        if time.time() - last_reconcile > 3600:
            last_reconcile = time.time()
            try:
                reconcile()
            except Exception as e:
                logger.warning(f"[KB] 对账失败: {e}")
        if time.time() - last_audit > 24 * 3600:
            last_audit = time.time()
            try:
                _purge_old_audit()
            except Exception as e:
                logger.warning(f"[KB] 审计日志清理失败: {e}")


def _purge_old_audit() -> None:
    """kb_audit 只增不删，按保留天数截断（默认 365 天）。"""
    try:
        keep = int(_cfg("LOCAL_KB_AUDIT_KEEP_DAYS", 365) or 365)
    except Exception:
        keep = 365
    cutoff = (datetime.now() - timedelta(days=keep)).strftime("%Y-%m-%d %H:%M:%S")
    c = _conn()
    try:
        n = c.execute("DELETE FROM kb_audit WHERE created_at < ?", (cutoff,)).rowcount
        c.commit()
    finally:
        c.close()
    if n:
        logger.info(f"[KB] 审计日志清理 {n} 条（保留 {keep} 天）")


def _purge_expired_trash() -> None:
    cutoff = (datetime.now() - timedelta(days=_trash_days())).strftime("%Y-%m-%d %H:%M:%S")
    c = _conn()
    try:
        rows = c.execute("SELECT id FROM kb_docs WHERE status='deleted' AND deleted_at IS NOT NULL AND deleted_at < ?",
                         (cutoff,)).fetchall()
    finally:
        c.close()
    for r in rows:
        purge_doc(int(r["id"]), username="system")


def _ensure_workers() -> None:
    global _workers_started
    with _worker_lock:
        if _workers_started:
            return
        init_db()
        _reset_stale()
        threading.Thread(target=_worker_loop, name="localkb-worker", daemon=True).start()
        threading.Thread(target=_housekeeping_loop, name="localkb-house", daemon=True).start()
        _workers_started = True
        _enqueue_pending()


def warmup() -> None:
    """后台预热：把 embedding 的 TLS/冷启动成本消化在启动期（失败无感）。"""
    try:
        if not enabled() or not has_index():
            return
        warmed = []
        for p in _target_channels():
            try:
                embed_texts(["知识库预热"], provider=p)
                warmed.append(p)
            except Exception as e:
                logger.info(f"[KB] 通道 {p} 预热失败（不影响使用）: {e}")
        logger.info(f"[KB] 向量通道预热完成（{'+'.join(warmed) or '无'}）")
    except Exception as e:
        logger.info(f"[KB] 预热未完成（不影响使用）: {e}")


def start() -> None:
    if not enabled():
        return
    try:
        _ensure_workers()
        threading.Thread(target=warmup, daemon=True, name="localkb-warmup").start()
        threading.Thread(target=verify_vector_collections, daemon=True, name="localkb-verify").start()
        logger.info("[KB] 本地知识库 worker 已启动")
    except Exception as e:
        logger.warning(f"[KB] 启动失败（不影响主服务）: {e}")

# ── 检索 ──
_Q_WORDS = ("请问", "帮我", "麻烦", "一下", "什么", "怎么", "怎样", "如何", "为什么",
            "哪些", "哪个", "哪里", "多少", "是否", "能否", "可否", "可以", "需要",
            "应该", "有关", "关于", "对于", "介绍", "简述", "说明", "列举", "举例")

_STRUCT_CHARS = "的了是在和与及或等中里就都也很更于对从当为把被让使向以之其该此"


def _kb_tokens(query: str) -> list[str]:
    """KB 专用分词：只剔疑问/客套词，保留「作用/意义/影响」等学科实词。"""
    kws: list[str] = []
    seen: set[str] = set()

    def push(w: str) -> None:
        w = w.strip()
        if len(w) >= 2 and w not in seen:
            seen.add(w)
            kws.append(w)

    for w in re.findall(r"[A-Za-z][A-Za-z0-9+#.\-]{1,15}", query or ""):
        push(w)
    for run in re.findall(r"[\u4e00-\u9fff]+", query or ""):
        for frag in re.split(f"[{_STRUCT_CHARS}]", run):
            if not frag:
                continue
            for w in _Q_WORDS:
                if w in frag and len(frag) > len(w):
                    frag = frag.replace(w, " ")
            for part in frag.split():
                if len(part) >= 2:
                    push(part)
                if len(part) > 5:
                    for i in range(len(part) - 2):
                        push(part[i:i + 3])
    kws.sort(key=len, reverse=True)
    return kws[:8]


def _tokens(query: str) -> list[str]:
    return _kb_tokens(query)


def build_fts_query(tokens: list[str]) -> str:
    parts = []
    for t in tokens:
        t = (t or "").strip()
        if len(t) < 3:
            continue
        parts.append('"' + t.replace('"', '""') + '"')
    return " OR ".join(parts)


def _keyword_hits(tokens: list[str], k: int) -> list[int]:
    ids: list[int] = []
    q = build_fts_query(tokens)
    c = _conn()
    try:
        if q:
            try:
                rows = c.execute(
                    "SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ? "
                    "ORDER BY rank LIMIT ?", (q, k * 2)).fetchall()
                ids = [int(r["rowid"]) for r in rows]
            except Exception as e:
                logger.warning(f"[KB] FTS 查询失败: {e}")
        if len(ids) < 3:
            for t in [x for x in tokens if len(x) == 2][:3]:
                rows = c.execute("SELECT id FROM kb_chunks WHERE text LIKE ? LIMIT ?",
                                 (f"%{t}%", k)).fetchall()
                for r in rows:
                    if int(r["id"]) not in ids:
                        ids.append(int(r["id"]))
    finally:
        c.close()
    return ids[:k]


def has_index() -> bool:
    now = time.time()
    if now - _count_cache["t"] < 5:
        return _count_cache["n"] > 0
    n = 0
    try:
        c = _conn()
        try:
            n = int(c.execute("SELECT COUNT(*) FROM kb_chunks c JOIN kb_docs d ON d.id=c.doc_id "
                              "WHERE d.status='ready'").fetchone()[0])
        finally:
            c.close()
    except Exception:
        n = 0
    _count_cache.update({"t": now, "n": n})
    return n > 0


def ready() -> bool:
    return enabled() and has_index()


_qvec_cache: dict[str, tuple[float, list[float]]] = {}
_QVEC_MAX = 128


def _query_vector(query: str, p: str) -> list[float]:
    """查询向量：LRU 缓存（10 分钟）+ 超时降级，避免每次检索都等云端 embedding。"""
    sig = embed_sig(p)
    key = f"{sig}|{query}"
    now = time.time()
    hit = _qvec_cache.get(key)
    if hit and now - hit[0] < 600:
        return hit[1]
    timeout_ms = int(_cfg("LOCAL_KB_QUERY_TIMEOUT_MS", 1500) or 1500)
    if p == "local":
        # 首次查询可能要加载模型；给 8s 硬顶，超时由上游降级为关键词腿
        vec = _embed_local([query], timeout=8.0)[0]
    else:
        vec = _embed_cloud([query], text_type="query", timeout=timeout_ms / 1000.0)[0]
    if len(_qvec_cache) >= _QVEC_MAX:
        oldest = min(_qvec_cache.items(), key=lambda kv: kv[1][0])[0]
        _qvec_cache.pop(oldest, None)
    _qvec_cache[key] = (now, vec)
    return vec


def _channel_done(sig: str) -> bool:
    try:
        c = _conn()
        try:
            return bool(c.execute("SELECT 1 FROM kb_doc_vec WHERE sig=? AND state='done' LIMIT 1",
                                  (sig,)).fetchone())
        finally:
            c.close()
    except Exception:
        return False


def _vector_hits(query: str, k: int) -> tuple[list[tuple[int, float]], dict]:
    """向量检索：当前通道优先，失败自动切另一通道（各查各的 collection，绝不混空间）。"""
    info = {"provider": "", "ok": False, "error": "", "fallback": False}
    # 通道只看 LOCAL_KB_EMBED_PROVIDER（显式选择优先，不被 AI_MODE 覆盖）：
    # 向量通道是"检索要不要出网"的唯一开关，与生成引擎无关（v9.3 解耦）。
    primary = embed_provider()
    candidates = [primary]
    if bool(_cfg("LOCAL_KB_DUAL_INDEX", _DUAL_DEFAULT)):
        alt = "local" if primary == "cloud" else "cloud"
        if alt and _channel_done(embed_sig(alt)):
            candidates.append(alt)
    for idx, p in enumerate(candidates):
        sig = embed_sig(p)
        try:
            col = _collection(sig, create=False)
            if col is None:
                info["error"] = "collection 不存在"
                continue
            meta = getattr(col, "metadata", None) or {}
            if str(meta.get("embed_sig") or "") != sig:
                info["error"] = "sig_mismatch"
                continue
            vec = _query_vector(query, p)
            # 候选数跟随 VEC_TOP_K（配置上限 50），不再钉死 20
            n = max(1, min(max(20, k), int(col.count() or 0)))
            res = col.query(query_embeddings=[vec], n_results=n, include=["distances"])
            ids = (res.get("ids") or [[]])[0]
            dists = (res.get("distances") or [[]])[0]
            out = []
            for i, cid in enumerate(ids):
                d = float(dists[i]) if i < len(dists) else 1.0
                out.append((int(cid), max(0.0, min(1.0, 1.0 - d))))
            info.update(provider=p, ok=True, fallback=idx > 0)
            return out[:k], info
        except Exception as e:
            info["error"] = str(e)[:160]
            logger.info(f"[KB] 向量通道 {p} 失败，尝试下一通道: {info['error']}")
    return [], info


def search(query: str, top_k: Optional[int] = None) -> tuple[list[dict], dict]:
    t0 = time.time()
    q = (query or "").strip()
    if not q or not enabled():
        return [], {"elapsed_ms": 0, "legs": {}}
    try:
        from backend.rag import resolve_search_query
        q = resolve_search_query(q)
    except Exception:
        pass
    k = int(top_k or _cfg("LOCAL_KB_TOP_K", 5) or 5)
    tokens = _tokens(q)
    kw_ids = _keyword_hits(tokens, int(_cfg("LOCAL_KB_KW_TOP_K", 12) or 12))
    vec_pairs, vec_info = _vector_hits(q, int(_cfg("LOCAL_KB_VEC_TOP_K", 12) or 12))

    rrf_w = float(_cfg("LOCAL_KB_RRF_W", 0.6) or 0.6)
    scores: dict[int, float] = {}
    legs: dict[int, set] = {}
    for rank, cid in enumerate([p[0] for p in vec_pairs]):
        scores[cid] = scores.get(cid, 0.0) + rrf_w / (60 + rank + 1)
        legs.setdefault(cid, set()).add("vec")
    for rank, cid in enumerate(kw_ids):
        scores[cid] = scores.get(cid, 0.0) + (1 - rrf_w) / (60 + rank + 1)
        legs.setdefault(cid, set()).add("kw")

    if scores:
        mx = max(scores.values())
        if mx > 0:
            scores = {i: s / mx for i, s in scores.items()}
    min_score = float(_cfg("LOCAL_KB_MIN_SCORE", 0.15) or 0.0)
    gap = float(_cfg("LOCAL_KB_REL_GAP", 0.6) or 0.0)
    ranked = sorted(scores.items(), key=lambda x: -x[1])
    if ranked and gap > 0:
        top1 = ranked[0][1]
        ranked = [(i, s) for i, s in ranked if s >= top1 * gap]
    ranked = [(i, s) for i, s in ranked if s >= min_score]

    ids = [i for i, _ in ranked]
    rows: dict[int, sqlite3.Row] = {}
    if ids:
        c = _conn()
        try:
            marks = ",".join("?" * len(ids))
            for r in c.execute(
                f"SELECT c.id, c.doc_id, c.text, c.title, d.name AS doc_name "
                f"FROM kb_chunks c JOIN kb_docs d ON d.id=c.doc_id "
                f"WHERE c.id IN ({marks}) AND d.status='ready'", ids).fetchall():
                rows[int(r["id"])] = r
        finally:
            c.close()

    vm = {cid: s for cid, s in vec_pairs}
    hits = []
    for cid, s in ranked:
        r = rows.get(cid)
        if not r:
            continue
        hits.append({
            "chunk_id": cid, "doc_id": int(r["doc_id"]), "doc_name": r["doc_name"],
            "title": r["title"] or "", "text": r["text"],
            "score": round(s, 3), "cos": round(vm.get(cid, 0.0), 3),
            "legs": sorted(legs.get(cid, [])),
        })
    return hits[:k], {"elapsed_ms": int((time.time() - t0) * 1000), "vec": vec_info,
                      "kw": len(kw_ids), "tokens": tokens[:6]}


def context_block(query: str, max_chars: Optional[int] = None) -> tuple[str, list[dict]]:
    if not ready():
        return "", []
    hits, _stat = search(query)
    if not hits:
        return "", []
    budget = int(max_chars or _cfg("LOCAL_KB_MAX_CHARS", 2500) or 2500)
    used, lines, refs = 0, [], []
    for i, h in enumerate(hits):
        text = h["text"][:900]
        if used + len(text) > budget:
            break
        lines.append(f"〔资料{i + 1}·《{h['doc_name']}》·相关度{h['score']}〕\n{text}")
        used += len(text)
        refs.append({"doc_name": h["doc_name"], "score": h["score"],
                     "title": h["title"], "source": "local"})
    if not lines:
        return "", []
    return _INJECT_HEAD + "\n\n".join(lines), refs

# ── 文档管理 ──
def list_docs(q: str = "", status: str = "", scope: str = "all",
              username: str = "", page: int = 1, page_size: int = 20,
              folder: str = "all") -> dict:
    if not enabled():
        return {"items": [], "total": 0}
    where, args = ["status != 'deleted'"], []
    if status:
        if status == "processing":
            where.append("status IN ('pending','indexing')")
        else:
            where.append("status = ?")
            args.append(status)
    if scope == "mine" and username:
        where.append("owner = ?")
        args.append(username)
    if q:
        where.append("name LIKE ?")
        args.append(f"%{q}%")
    if folder == "none":
        where.append("folder_id IS NULL")
    elif str(folder).isdigit() and folder not in ("", "all"):
        where.append("folder_id = ?")
        args.append(int(folder))
    cond = " AND ".join(where)
    c = _conn()
    try:
        total = int(c.execute(f"SELECT COUNT(*) FROM kb_docs WHERE {cond}", args).fetchone()[0])
        rows = c.execute(
            f"SELECT id,name,size,pages,chunks,status,progress,vec_state,error,owner,"
            f"folder_id,created_at,updated_at FROM kb_docs WHERE {cond} ORDER BY id DESC LIMIT ? OFFSET ?",
            args + [page_size, (page - 1) * page_size]).fetchall()
    finally:
        c.close()
    return {"items": [dict(r) for r in rows], "total": total}


def list_trash(username: Optional[str] = None) -> list[dict]:
    """回收站列表：username 为空看全部（管理员），否则只看该用户上传的（教师自助）。"""
    c = _conn()
    try:
        if username:
            rows = c.execute(
                "SELECT id,name,size,chunks,deleted_at,deleted_by,owner,status FROM kb_docs "
                "WHERE status='deleted' AND owner=? ORDER BY deleted_at DESC", (username,)).fetchall()
        else:
            rows = c.execute(
                "SELECT id,name,size,chunks,deleted_at,deleted_by,owner,status FROM kb_docs "
                "WHERE status='deleted' ORDER BY deleted_at DESC").fetchall()
    finally:
        c.close()
    out = []
    for r in rows:
        d = dict(r)
        try:
            dt = datetime.strptime(d.get("deleted_at") or "", "%Y-%m-%d %H:%M:%S")
            d["remaining_days"] = max(0, _trash_days() - (datetime.now() - dt).days)
        except Exception:
            d["remaining_days"] = _trash_days()
        out.append(d)
    return out


def caps() -> dict:
    """容量/格式上限：随配置即时生效，供前端校验与文案驱动（不再写死）。"""
    return {
        "extensions": sorted(allowed_exts()),
        "max_file_mb": _max_file_mb(),
        "max_total_mb": _max_total_mb(),
        "max_docs": _max_docs(),
        "max_pages": _max_pages(),
        "trash_days": _trash_days(),
        "max_chars": int(_cfg("LOCAL_KB_MAX_CHARS", 2500) or 2500),
    }


def runtime_counts() -> dict[str, Any]:
    """AI 运行状态位专用的轻量计数（供 /api/config/ai-runtime 的知识库胶囊）。

    与 stats() 的分工：stats() 是知识库管理页的全量体检（配额、向量通道清单、覆盖率，
    且 LOCAL_KB_DUAL_INDEX=True 时会为 local_ready 打一次网络探 Ollama）；状态胶囊只要
    "现在库里有多少料"，所以这里纯 SQL、零外呼 —— 一颗可能被七八个页面同时刷新的胶囊，
    不该为了一次计数去等探活。
    """
    p = embed_provider()
    out: dict[str, Any] = {
        "enabled": enabled(), "docs": 0, "chunks": 0, "vec_docs": 0,
        "embed_provider": p, "embed_model": embed_model(p),
    }
    if not out["enabled"]:
        return out
    try:
        c = _conn()
        try:
            row = c.execute("SELECT COUNT(*) AS n, COALESCE(SUM(chunks),0) AS ch "
                            "FROM kb_docs WHERE status != 'deleted'").fetchone()
            out["docs"] = int(row["n"] or 0)
            out["chunks"] = int(row["ch"] or 0)
            out["vec_docs"] = int(c.execute(
                "SELECT COUNT(*) FROM kb_doc_vec v JOIN kb_docs d ON d.id=v.doc_id "
                "WHERE d.status='ready' AND v.state='done' AND v.sig=?",
                (embed_sig(p),)).fetchone()[0])
        finally:
            c.close()
    except Exception as e:
        # 计数读失败按"没有料"返回：状态位宁可保守，也不能因为一次查询异常而 500
        logger.warning(f"[本地文库] 状态计数失败: {e}")
    return out


def stats() -> dict:
    if not enabled():
        return {"enabled": False}
    c = _conn()
    ch_rows = []
    try:
        row = c.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS sz, COALESCE(SUM(chunks),0) AS ch "
            "FROM kb_docs WHERE status != 'deleted'").fetchone()
        tr = c.execute("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS sz FROM kb_docs WHERE status='deleted'").fetchone()
        ready = c.execute("SELECT COUNT(*) FROM kb_docs WHERE status='ready'").fetchone()[0]
        # 只统计“当前向量模型签名且记录仍为 done”的文档：集合缺失/切换模型都会归零，提示重建
        vec_done = c.execute(
            "SELECT COUNT(*) FROM kb_doc_vec v JOIN kb_docs d ON d.id=v.doc_id "
            "WHERE d.status='ready' AND v.state='done' AND v.sig=?",
            (embed_sig(),)).fetchone()[0]
        ch_rows = c.execute("SELECT v.sig AS sig, COUNT(*) AS n FROM kb_doc_vec v "
                            "JOIN kb_docs d ON d.id=v.doc_id "
                            "WHERE v.state='done' AND d.status='ready' GROUP BY v.sig").fetchall()
        failed = c.execute("SELECT COUNT(*) FROM kb_docs WHERE status='failed'").fetchone()[0]
        empty = c.execute("SELECT COUNT(*) FROM kb_docs WHERE status='empty'").fetchone()[0]
        chunks = int(row["ch"] or 0)
    finally:
        c.close()
    p = embed_provider()
    dual = bool(_cfg("LOCAL_KB_DUAL_INDEX", _DUAL_DEFAULT))
    alive = _ollama_alive() if dual else False
    local_model = embed_model("local")
    local_present = bool(dual and alive and _ollama_model_present(local_model))
    return {
        "enabled": True, "docs": int(row["n"] or 0), "size_mb": round((row["sz"] or 0) / 1048576, 1),
        "chunks": chunks, "ready": ready, "failed": failed, "empty": empty,
        "trash_docs": int(tr["n"] or 0), "trash_mb": round((tr["sz"] or 0) / 1048576, 1),
        "used_mb": round(((row["sz"] or 0) + (tr["sz"] or 0)) / 1048576, 1),
        "vec_docs": vec_done,
        "dual_index": dual,
        "local_ready": {"alive": bool(alive), "model_present": local_present, "model": local_model},
        "vec_channels": [{"provider": str(r["sig"]).split("|")[0] if r["sig"] else "",
                          "model": str(r["sig"]).split("|")[1] if r["sig"] and "|" in str(r["sig"]) else "",
                          "docs": int(r["n"])} for r in ch_rows],
        "vec_coverage": round(vec_done / ready, 3) if ready else 0,
        "quota_docs": _max_docs(), "quota_mb": _max_total_mb(),
        "caps": caps(),
        "embed": {"provider": p, "model": embed_model(p), "dim": _embed_dim(),
                  "sig": embed_sig(p)},
    }


def status_batch(ids: list[int]) -> list[dict]:
    if not ids:
        return []
    c = _conn()
    try:
        marks = ",".join("?" * len(ids))
        rows = c.execute(f"SELECT id,status,progress,vec_state,error,chunks FROM kb_docs WHERE id IN ({marks})", ids).fetchall()
    finally:
        c.close()
    return [dict(r) for r in rows]


def doc_detail(doc_id: int) -> dict:
    c = _conn()
    try:
        row = c.execute("SELECT * FROM kb_docs WHERE id=?", (doc_id,)).fetchone()
        audit = c.execute("SELECT action,username,detail,created_at FROM kb_audit WHERE doc_id=? "
                          "ORDER BY id DESC LIMIT 3", (doc_id,)).fetchall()
        chunks = c.execute("SELECT ord,title,text FROM kb_chunks WHERE doc_id=? ORDER BY ord LIMIT 10", (doc_id,)).fetchall()
    finally:
        c.close()
    if not row:
        return {}
    d = dict(row)
    d.pop("path", None)
    d.pop("visibility", None)   # 可见性未实现：不进接口契约，避免"看似有私有库"的误导
    d["chunks_preview"] = [dict(x) for x in chunks]
    d["audit"] = [dict(x) for x in audit]
    return d


def _check_quota(extra_size: int) -> Optional[str]:
    """配额按“含回收站”统计：文件还在盘上，回收站内文档同样占容量（方案 §4.1.2）。"""
    c = _conn()
    try:
        row = c.execute("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS sz FROM kb_docs").fetchone()
    finally:
        c.close()
    if int(row["n"]) >= _max_docs():
        return f"知识库已达 {_max_docs()} 篇上限（含回收站），请先清理回收站或移除文档"
    if extra_size and (int(row["sz"]) + extra_size) > _max_total_mb() * 1024 * 1024:
        return f"知识库容量不足（上限 {_max_total_mb()}MB，含回收站）"
    return None


def register_upload(tmp: Path, filename: str, username: str, sha256: str, size: int,
                    folder_id: Optional[int] = None, force_new: bool = False) -> dict:
    err = _check_quota(size)
    if err:
        return {"ok": False, "error": err}
    name = safe_name(filename)
    ext = os.path.splitext(name)[1].lower()
    ok_exts = allowed_exts()
    if ext in EXT_LEGACY:
        return {"ok": False, "error": "旧版 Office 格式不支持，请另存为 docx/pdf"}
    if ext not in ok_exts:
        return {"ok": False, "error": "仅支持 " + " / ".join(sorted(x.lstrip(".") for x in ok_exts))}
    c = _conn()
    try:
        dup = c.execute("SELECT id,status,name FROM kb_docs WHERE sha256=?", (sha256,)).fetchone()
        if dup:
            # force_new 只对“同内容在回收站”生效：允许另建一篇，旧文档仍留在回收站
            if not (force_new and dup["status"] == "deleted"):
                return {"ok": False, "skipped": True,
                        "reason": "in_trash" if dup["status"] == "deleted" else "duplicate",
                        "id": int(dup["id"]), "name": dup["name"]}
        stem, suffix = os.path.splitext(name)
        n = 2
        while c.execute("SELECT 1 FROM kb_docs WHERE name=? AND status!='deleted'", (name,)).fetchone():
            name = f"{stem} ({n}){suffix}"
            n += 1
            if n > 50:
                break
        now = _now()
        if folder_id:
            exists = c.execute("SELECT 1 FROM kb_folders WHERE id=?", (folder_id,)).fetchone()
            if not exists:
                folder_id = None
        cur = c.execute(
            "INSERT INTO kb_docs(name,path,sha256,size,status,progress,vec_state,owner,source,folder_id,created_at,updated_at) "
            "VALUES(?,?,?,?, 'pending',0,'pending',?,'upload',?,?,?)",
            (name, "", sha256, size, username, folder_id, now, now))
        doc_id = int(cur.lastrowid)
        dest = files_dir() / _disk_name(doc_id, name)
        try:
            shutil.move(str(tmp), str(dest))
        except Exception as move_err:
            c.execute("DELETE FROM kb_docs WHERE id=?", (doc_id,))
            c.commit()
            return {"ok": False, "error": f"文件保存失败: {move_err}"}
        c.execute("UPDATE kb_docs SET path=? WHERE id=?", (_rel_path(dest), doc_id))
        c.commit()
    finally:
        c.close()
    _audit(doc_id, "upload", username, name)
    _ensure_workers()
    _count_cache["t"] = 0
    _qvec_cache.clear()
    _queue.put(doc_id)
    logger.info(f"[KB] 上传入库 id={doc_id} name={name} size={size} by={username}")
    return {"ok": True, "id": doc_id, "name": name, "status": "pending"}

def remove_doc(doc_id: int, username: str) -> dict:
    _clear_doc_vectors(doc_id)
    c = _conn()
    try:
        row = c.execute("SELECT * FROM kb_docs WHERE id=?", (doc_id,)).fetchone()
        if not row or row["status"] == "deleted":
            return {"ok": False, "error": "文档不存在或已移除"}
        c.execute("DELETE FROM kb_chunks WHERE doc_id=?", (doc_id,))
        c.execute("UPDATE kb_docs SET status='deleted',deleted_at=?,deleted_by=?,progress=0,vec_state='off',updated_at=? "
                  "WHERE id=?", (_now(), username, _now(), doc_id))
        c.commit()
    finally:
        c.close()
    _audit(doc_id, "remove", username, row["name"])
    _count_cache["t"] = 0
    _qvec_cache.clear()
    return {"ok": True}


def restore_doc(doc_id: int, username: str) -> dict:
    c = _conn()
    try:
        row = c.execute("SELECT * FROM kb_docs WHERE id=?", (doc_id,)).fetchone()
        if not row or row["status"] != "deleted":
            return {"ok": False, "error": "回收站中无此文档"}
        dup = c.execute("SELECT id FROM kb_docs WHERE sha256=? AND id != ? AND status != 'deleted'",
                        (row["sha256"], doc_id)).fetchone()
        if dup:
            return {"ok": False, "error": f"同内容文档已在知识库中（id={int(dup['id'])}），无法恢复"}
        fid = row["folder_id"]
        if fid and not c.execute("SELECT 1 FROM kb_folders WHERE id=?", (fid,)).fetchone():
            fid = None          # 目录已被删除：恢复到未分类，避免指向不存在的目录
        c.execute("UPDATE kb_docs SET status='pending',deleted_at=NULL,deleted_by=NULL,progress=0,vec_state='pending',"
                  "folder_id=?,updated_at=? WHERE id=?", (fid, _now(), doc_id))
        c.commit()
    finally:
        c.close()
    _audit(doc_id, "restore", username, row["name"])
    _ensure_workers()
    _queue.put(doc_id)
    return {"ok": True}


def purge_doc(doc_id: int, username: str) -> dict:
    _clear_doc_vectors(doc_id)
    c = _conn()
    try:
        row = c.execute("SELECT * FROM kb_docs WHERE id=?", (doc_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "文档不存在"}
        c.execute("DELETE FROM kb_chunks WHERE doc_id=?", (doc_id,))
        c.execute("DELETE FROM kb_docs WHERE id=?", (doc_id,))
        c.commit()
    finally:
        c.close()
    freed = int(row["size"] or 0)
    p = Path(_abs_path(row["path"])) if row["path"] else None
    if p and p.exists():
        try:
            p.unlink()
        except Exception as e:
            logger.warning(f"[KB] 删除原件失败 {p}: {e}")
    _audit(doc_id, "purge", username, row["name"])
    _count_cache["t"] = 0
    _qvec_cache.clear()
    return {"ok": True, "freed_mb": round(freed / 1048576, 2)}


def reindex_doc(doc_id: int) -> dict:
    _set_doc(doc_id, status="pending", progress=0, vec_state="pending", error="")
    _ensure_workers()
    _queue.put(doc_id)
    _audit(doc_id, "reindex", "", "")
    return {"ok": True}


def replace_doc(doc_id: int, tmp: Path, filename: str, sha256: str, size: int) -> dict:
    c = _conn()
    try:
        row = c.execute("SELECT * FROM kb_docs WHERE id=?", (doc_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "文档不存在"}
        dup = c.execute("SELECT id FROM kb_docs WHERE sha256=? AND id != ? AND status != 'deleted'",
                        (sha256, doc_id)).fetchone()
        if dup:
            return {"ok": False, "error": f"该文件内容已存在于知识库（文档 id={int(dup['id'])}）"}
        extra = max(0, int(size) - int(row["size"] or 0))
        if extra:
            qerr = _check_quota(extra)
            if qerr:
                return {"ok": False, "error": qerr}
        old_path = Path(_abs_path(row["path"])) if row["path"] else None
        dest = files_dir() / _disk_name(doc_id, row["name"])
        if tmp:
            shutil.move(str(tmp), str(dest))
        try:
            c.execute("UPDATE kb_docs SET path=?,sha256=?,size=?,status='pending',progress=0,vec_state='pending',"
                      "error='',updated_at=? WHERE id=?", (_rel_path(dest), sha256, size, _now(), doc_id))
        except sqlite3.IntegrityError:
            return {"ok": False, "error": "该文件内容已存在于知识库"}
        c.commit()
    finally:
        c.close()
    if old_path and old_path != dest and old_path.exists():
        try:
            old_path.unlink()
        except Exception:
            pass
    _audit(doc_id, "replace", "", filename)
    _ensure_workers()
    _queue.put(doc_id)
    return {"ok": True}


def rebuild_all() -> dict:
    try:
        client = _chroma()
        cols = client.list_collections()
        for c in cols:
            name = c if isinstance(c, str) else getattr(c, "name", None)
            if name:
                try:
                    client.delete_collection(name)
                except Exception:
                    pass
    except Exception as e:
        logger.warning(f"[KB] 清空向量库失败: {e}")
    c = _conn()
    try:
        c.execute("DELETE FROM kb_doc_vec")
        c.execute("UPDATE kb_docs SET status='pending',progress=0,vec_state='pending',vec_collection='',updated_at=? "
                  "WHERE status='ready'", (_now(),))
        c.commit()
    finally:
        c.close()
    _ensure_workers()
    _enqueue_pending()
    return {"ok": True}


def refill_vectors(limit: int = 200) -> dict:
    """增量补向量：对 ready 文档复用现有切片，只重嵌未成功的通道——不重新解析原件、不动关键词索引。

    - 页面「维护 → 补齐向量索引」与 housekeeping 半小时自动补灌共用此入口；
    - 目标通道全部已有 done 记录 → 跳过；部分通道缺失（如刚开双通道）→ 只补缺的通道；
    - 向量库不可用等瞬时错误已在 _vectorize_chunks 内重试过，仍失败的文档等下一轮自动补。
    """
    if not enabled():
        return {"ok": False, "error": "本地知识库未启用"}
    channels = _target_channels()
    if not channels:
        return {"ok": False, "error": "当前无可用向量通道（云 Key 或 Ollama 未就绪）"}
    want = {embed_sig(p) for p in channels}
    targets: list[tuple[int, list[int], list[dict], set]] = []
    c = _conn()
    try:
        rows = c.execute("SELECT id FROM kb_docs WHERE status='ready' ORDER BY id").fetchall()
        for r in rows:
            if len(targets) >= limit:
                break
            did = int(r["id"])
            done = {x["sig"] for x in c.execute(
                "SELECT sig FROM kb_doc_vec WHERE doc_id=? AND state='done'", (did,)).fetchall()}
            if want <= done:
                continue
            ch = c.execute("SELECT id, ord, title, text FROM kb_chunks WHERE doc_id=? ORDER BY ord", (did,)).fetchall()
            if not ch:
                continue
            targets.append((did, [int(x["id"]) for x in ch],
                            [{"text": x["text"], "title": x["title"] or ""} for x in ch], done))
    finally:
        c.close()
    done_n = fail_n = 0
    for did, ids, chunks, done in targets:
        vec_state, vec_err, col_name = _vectorize_chunks(did, ids, chunks, channels, done,
                                                         cleanup_on_delete=False)
        if vec_state == "deleted":
            continue
        fields: dict[str, Any] = {"vec_state": vec_state, "error": vec_err}
        if col_name:
            fields["vec_collection"] = col_name
        _set_doc(did, **fields)
        if vec_state == "done":
            done_n += 1
        else:
            fail_n += 1
    _count_cache["t"] = 0
    if done_n:
        logger.info(f"[KB] 增量补向量完成：成功 {done_n}，失败 {fail_n}，通道 {'+'.join(channels)}")
    return {"ok": True, "targeted": len(targets), "done": done_n, "failed": fail_n, "channels": channels}


def verify_vector_collections() -> dict:
    """核对 kb_doc_vec 记录的 collection 是否真实存在。

    典型场景：恢复备份只带回 local_kb.db 与原件，kb_vectors 未随备份（可重建）。
    此时记录仍标 done，覆盖率会假 100%。这里把缺失集合标为 failed，提示重建。
    仅在 Chroma 可正常枚举时执行，避免临时故障误伤状态。
    """
    if not enabled():
        return {}
    try:
        client = _chroma()
        names = set()
        for c in client.list_collections():
            name = c if isinstance(c, str) else getattr(c, "name", "")
            if name:
                names.add(name)
    except Exception as e:
        logger.info(f"[KB] 向量库不可枚举，跳过一致性检查: {e}")
        return {}
    conn = _conn()
    try:
        rows = conn.execute("SELECT doc_id, sig, collection FROM kb_doc_vec WHERE state='done'").fetchall()
    finally:
        conn.close()
    missing = [r for r in rows if r["collection"] and r["collection"] not in names]
    if not missing:
        return {"missing": 0}
    cur_sig = embed_sig()
    conn = _conn()
    try:
        for r in missing:
            conn.execute("UPDATE kb_doc_vec SET state='failed', error=?, updated_at=? WHERE doc_id=? AND sig=?",
                         ("向量集合缺失（恢复备份后需重建）", _now(), r["doc_id"], r["sig"]))
            if str(r["sig"]) == cur_sig:
                conn.execute("UPDATE kb_docs SET vec_state='failed', error=? WHERE id=?",
                             ("向量索引缺失：请到「维护 → 重建向量索引」", r["doc_id"]))
        conn.commit()
    finally:
        conn.close()
    _count_cache["t"] = 0
    logger.warning(f"[KB] 检测到 {len(missing)} 条向量记录集合缺失，已标记待重建")
    return {"missing": len(missing)}


def reconcile() -> dict:
    if not enabled():
        return {}
    try:
        verify_vector_collections()
    except Exception:
        pass
    c = _conn()
    try:
        chans = [dict(r) for r in c.execute(
            "SELECT sig, collection FROM kb_doc_vec WHERE state='done' GROUP BY sig, collection").fetchall()]
    finally:
        c.close()
    if not chans:
        return {}
    total_orphans = total_missing = 0
    for ch in chans:
        sig, coll_name = ch["sig"], ch["collection"]
        if not coll_name:
            continue
        try:
            col = _chroma().get_collection(coll_name)
        except Exception:
            continue
        c = _conn()
        try:
            expected = {int(r[0]) for r in c.execute(
                "SELECT c.id FROM kb_chunks c JOIN kb_docs d ON d.id=c.doc_id "
                "JOIN kb_doc_vec v ON v.doc_id=d.id "
                "WHERE d.status='ready' AND v.sig=? AND v.state='done'", (sig,)).fetchall()}
        finally:
            c.close()
        try:
            actual = {int(x) for x in (col.get(include=[]) or {}).get("ids", [])}
        except Exception:
            continue
        orphans = actual - expected
        missing = expected - actual
        if orphans:
            try:
                col.delete(ids=[str(x) for x in list(orphans)[:5000]])
            except Exception as e:
                logger.warning(f"[KB] 清理孤儿向量失败 {coll_name}: {e}")
        if missing:
            c = _conn()
            try:
                marks = ",".join("?" * len(missing))
                docs = {int(r[0]) for r in c.execute(
                    f"SELECT DISTINCT doc_id FROM kb_chunks WHERE id IN ({marks})", list(missing)).fetchall()}
            finally:
                c.close()
            for d in docs:
                reindex_doc(d)
        total_orphans += len(orphans)
        total_missing += len(missing)
    if total_orphans or total_missing:
        logger.info(f"[KB] 对账：清理孤儿 {total_orphans}，补灌缺失 {total_missing}")
    return {"orphans": total_orphans, "missing": total_missing}


# ── 目录管理（一层目录：试题/教材/教案…由用户自建）──
def folders() -> list[dict]:
    """目录列表 + 各目录文档数（未分类单独统计）。"""
    c = _conn()
    try:
        rows = c.execute(
            "SELECT f.id, f.name, f.owner, f.created_at, "
            "(SELECT COUNT(*) FROM kb_docs d WHERE d.folder_id=f.id AND d.status!='deleted') AS cnt "
            "FROM kb_folders f ORDER BY f.id").fetchall()
        uncat = int(c.execute("SELECT COUNT(*) FROM kb_docs WHERE folder_id IS NULL AND status!='deleted'").fetchone()[0])
    finally:
        c.close()
    return {"items": [dict(r) for r in rows], "uncategorized": uncat}


def create_folder(name: str, owner: str) -> dict:
    name = (name or "").strip()[:30]
    if not name:
        return {"ok": False, "error": "请输入文件夹名称"}
    c = _conn()
    try:
        dup = c.execute("SELECT id FROM kb_folders WHERE name=?", (name,)).fetchone()
        if dup:
            return {"ok": False, "error": "同名文件夹已存在"}
        cur = c.execute("INSERT INTO kb_folders(name, owner, created_at) VALUES(?,?,?)", (name, owner, _now()))
        c.commit()
        fid = int(cur.lastrowid)
    finally:
        c.close()
    _audit(None, "folder_create", owner, name)
    return {"ok": True, "id": fid, "name": name}


def rename_folder(fid: int, name: str, username: str) -> dict:
    name = (name or "").strip()[:30]
    if not name:
        return {"ok": False, "error": "请输入文件夹名称"}
    c = _conn()
    try:
        row = c.execute("SELECT * FROM kb_folders WHERE id=?", (fid,)).fetchone()
        if not row:
            return {"ok": False, "error": "文件夹不存在"}
        if c.execute("SELECT 1 FROM kb_folders WHERE name=? AND id != ?", (name, fid)).fetchone():
            return {"ok": False, "error": "同名文件夹已存在"}
        c.execute("UPDATE kb_folders SET name=? WHERE id=?", (name, fid))
        c.commit()
    finally:
        c.close()
    _audit(None, "folder_rename", username, name)
    return {"ok": True}


def delete_folder(fid: int, username: str) -> dict:
    c = _conn()
    try:
        row = c.execute("SELECT * FROM kb_folders WHERE id=?", (fid,)).fetchone()
        if not row:
            return {"ok": False, "error": "文件夹不存在"}
        n = c.execute("UPDATE kb_docs SET folder_id=NULL WHERE folder_id=?", (fid,)).rowcount
        c.execute("DELETE FROM kb_folders WHERE id=?", (fid,))
        c.commit()
    finally:
        c.close()
    _audit(None, "folder_delete", username, row["name"])
    return {"ok": True, "moved_to_none": int(n)}


def move_doc(doc_id: int, folder_id: Optional[int]) -> dict:
    c = _conn()
    try:
        row = c.execute("SELECT id,name FROM kb_docs WHERE id=?", (doc_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "文档不存在"}
        if folder_id:
            if not c.execute("SELECT 1 FROM kb_folders WHERE id=?", (folder_id,)).fetchone():
                return {"ok": False, "error": "文件夹不存在"}
        c.execute("UPDATE kb_docs SET folder_id=?, updated_at=? WHERE id=?", (folder_id, _now(), doc_id))
        c.commit()
    finally:
        c.close()
    _audit(doc_id, "move", "", f"folder={folder_id}")
    return {"ok": True}
