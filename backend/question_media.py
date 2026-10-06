"""试题配图文件的目录命名空间与素材清单（manifest）治理。

为什么需要这一层
----------------
``question_media/`` 过去被三套数据按「数字 id」共用同一层目录：

- 题库 ``question_bank``           → ``question_media/<id>/``
- 闯关题库 ``quest_question_bank`` → ``question_media/<id>/``（另一张表、另一套自增 id）
- 白板 AI 生图                     → ``question_media/whiteboard_ai/``（还是相对路径）

于是出现过两类静默数据损坏：

1. 删闯关题 ``shutil.rmtree(question_media/<quest_id>)``，连带清空「同号」题库题的配图；
2. 磁盘治理任务把「不在题库 id 集合里」的目录当孤儿整目录回收，闯关/白板配图被静默删掉。

本模块把命名空间收口，同时**保持历史 URL 继续可读**（不迁移、不改库、不换 URL 格式）：

- 题库   ``question_media/<id>/``          —— 与历史完全一致
- 闯关   ``question_media/quest/<id>/``    —— 新写入；旧的平铺目录只按 manifest 精确清理
- 白板   ``question_media/whiteboard_ai/`` —— 目录名不变，改为绝对路径并被治理任务豁免

路径与数据来源都按不可信输入处理：``media_files`` 的 url 允许教师从导入接口直接填写，
所以任何用于拼路径的片段都要先过 ``_safe_token``，再验证结果仍在配图根目录内。
"""
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.config import BASE_DIR
from backend.utils import path_within

# ── 命名空间 ──
SOURCE_BANK = "bank"            # question_bank
SOURCE_QUEST = "quest"          # quest_question_bank
SOURCE_WHITEBOARD = "whiteboard"

MEDIA_ROOT_NAME = "question_media"
ARCHIVE_DIR_NAME = ".archived"
WHITEBOARD_DIR_NAME = "whiteboard_ai"

#: 这些目录不是「某道题库题的配图」，孤儿回收必须永久豁免
PROTECTED_DIR_NAMES = {ARCHIVE_DIR_NAME, SOURCE_QUEST, WHITEBOARD_DIR_NAME}

#: 单题占位符默认上限：AI 一次给 5 个描述就会烧 5 张图，成本失控。
#: 2026-10-06 由 2 收到 1 —— 一道题配两张实拍图的情况极少，而批量出题时这是成倍的成本差。
#: 可在系统配置 IMAGE_GEN_MAX_PLACEHOLDERS 调整，0 表示不限制
MAX_PLACEHOLDERS_PER_QUESTION = 1


def media_root() -> Path:
    """配图根目录（与 files_router 静态服务基准一致：BASE_DIR）"""
    return BASE_DIR / MEDIA_ROOT_NAME


def media_dir(source: str = SOURCE_BANK, question_id: Any = None,
              extra: str | None = None) -> Path:
    """某来源某题的配图目录（不自动创建，调用方按需 mkdir）"""
    root = media_root()
    if source == SOURCE_QUEST:
        base = root / SOURCE_QUEST
    elif source == SOURCE_WHITEBOARD:
        base = root / WHITEBOARD_DIR_NAME
    else:
        base = root
    if question_id is None:
        return base if extra is None else base / extra
    sub = _safe_token(question_id) or "_unknown"
    return base / sub if extra is None else base / sub / extra


def ensure_media_dir(source: str = SOURCE_BANK, question_id: Any = None,
                     extra: str | None = None) -> Path:
    """确保目录存在并返回（幂等）"""
    path = media_dir(source, question_id, extra)
    path.mkdir(parents=True, exist_ok=True)
    return path


def url_for(source: str = SOURCE_BANK, question_id: Any = None,
            filename: str = "", extra: str | None = None) -> str:
    """由目录内文件名拼出可下发的相对 URL（格式与历史一致）"""
    path = media_dir(source, question_id, extra) / filename
    try:
        rel = path.relative_to(media_root()).as_posix()
    except ValueError:                     # 调用方给了根目录之外的路径
        rel = path.name
    return f"/api/files/{MEDIA_ROOT_NAME}/{rel}"


# ═══════════════════════════ 安全解析 ═══════════════════════════

def _safe_token(value: Any) -> str:
    """目录名/文件名用的安全片段：拒绝路径穿越、隐藏文件与超长名"""
    text = str(value or "").strip()
    if not text or len(text) > 128:
        return ""
    if text.startswith(".") or text in {".", ".."}:
        return ""
    for ch in "/\\:*?\"<>|\t\r\n":
        if ch in text:
            return ""
    return text


def _contained(path: Path) -> bool:
    """路径必须真的落在 question_media/ 内（realpath + 路径段比较）"""
    try:
        return path_within(str(media_root()), str(path))
    except OSError:
        return False


def _question_id_from(url: str | None, question_id: Any = None) -> str:
    """配图归属目录名：优先调用方给的 id，否则取 url 倒数第二节"""
    if question_id is not None and question_id != "":
        return _safe_token(question_id)
    parts = (url or "").split("?")[0].split("#")[0].rstrip("/").split("/")
    return _safe_token(parts[-2]) if len(parts) >= 2 else ""


def filename_from_url(url: str | None) -> str:
    """从 media_files 的 url 里取文件名（只取最后一段，非法值返回空串）"""
    if not url or not isinstance(url, str):
        return ""
    clean = url.split("?")[0].split("#")[0].rstrip("/")
    return _safe_token(clean.split("/")[-1])


def _as_list(raw: Any) -> list[Any]:
    """JSON 字段兼容层：None / JSON 字符串 / 列表都归一成列表"""
    if raw is None:
        return []
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def manifest_filenames(raw: Any) -> set[str]:
    """收集 media_files（JSON 字符串或列表）里记录的物理文件名"""
    out: set[str] = set()
    for item in _as_list(raw):
        if isinstance(item, dict):
            name = filename_from_url(item.get("url"))
            if name:
                out.add(name)
    return out


# ═══════════════════════════ 物理文件操作 ═══════════════════════════

def delete_media_file(url: str | None, source: str = SOURCE_BANK,
                      question_id: Any = None) -> bool:
    """按 URL 删除配图物理文件（找不到就静默返回 False）

    先在本题目录找，再在兄弟命名空间找，避免「删不掉留下孤儿」；
    同时把候选路径限制在配图根目录内，防 ``/../`` 之类的 url 越界删文件。
    """
    name = filename_from_url(url)
    if not name:
        return False
    qid = _question_id_from(url, question_id)
    if not qid:
        return False
    candidates: list[Path] = [media_dir(source, qid) / name]
    if source == SOURCE_QUEST:
        candidates.append(media_dir(SOURCE_BANK, qid) / name)   # 历史平铺目录
    elif source == SOURCE_BANK:
        candidates.append(media_dir(SOURCE_QUEST, qid) / name)
    for path in candidates:
        try:
            if _contained(path) and path.is_file():
                path.unlink()
                return True
        except OSError:
            continue
    return False


def archive_bank_dir(question_id: Any) -> str | None:
    """题库题目软删时归档配图目录（可完整恢复），到期由日志保留任务物理清除

    只搬 ``question_media/<id>``，绝不碰 ``quest/``、``whiteboard_ai/`` 等子命名空间。
    """
    qid = _safe_token(question_id)
    if not qid:
        return None
    src = media_dir(SOURCE_BANK, qid)
    if not _contained(src) or not src.is_dir():
        return None
    dst_root = media_root() / ARCHIVE_DIR_NAME
    dst_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    dst = dst_root / f"{qid}__{stamp}"
    shutil.move(str(src), str(dst))
    return str(dst)


def cleanup_quest_media(question_id: Any, raw_media_files: Any) -> int:
    """删除闯关题配图：新命名空间整目录删 + 历史平铺目录按 manifest 精确删

    历史平铺目录 ``question_media/<id>`` 可能与某道同号题库题共用，
    因此那里**只删本题 manifest 记录过的文件**，绝不 rmtree。
    """
    removed = 0
    qid = _safe_token(question_id)
    if not qid:
        return 0
    new_dir = media_dir(SOURCE_QUEST, qid)
    if _contained(new_dir) and new_dir.is_dir():
        shutil.rmtree(new_dir, ignore_errors=True)
        removed += 1
    legacy_dir = media_dir(SOURCE_BANK, qid)
    if _contained(legacy_dir) and legacy_dir.is_dir():
        for name in manifest_filenames(raw_media_files):
            if delete_media_file(name, SOURCE_QUEST, qid):
                removed += 1
    return removed


def resolve_media_path(url: str | None, question_id: Any = None) -> Path | None:
    """把 media_files 的 url 解析成本地文件（组卷 / Word 导出用）

    兼容四种落位：本题目录、闯关新目录、闯关历史平铺目录、白板目录。
    """
    name = filename_from_url(url)
    if not name:
        return None
    source = SOURCE_QUEST if f"/{SOURCE_QUEST}/" in (url or "") else SOURCE_BANK
    qid = _question_id_from(url, question_id)
    dirs: list[Path] = [media_dir(SOURCE_WHITEBOARD)]
    if qid:
        dirs = [media_dir(source, qid), media_dir(SOURCE_BANK, qid),
                media_dir(SOURCE_QUEST, qid), media_dir(SOURCE_WHITEBOARD)]
    for base in dirs:
        candidate = base / name
        try:
            if _contained(candidate) and candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


def sweep_orphan_dirs(keep_ids: set[str], older_than_days: int = 30,
                      dry_run: bool = False) -> tuple[int, int]:
    """孤儿目录回收（供日志保留任务调用）

    只处理 ``question_media/<纯数字>`` 这种「题库题目录」：
      - 数字名 + 不在 keep_ids + 目录超过 N 天 → 回收
      - 非数字名（quest / whiteboard_ai / .archived）一律不动 —— 这正是过去误删
        闯关与白板配图的原因，治理任务无权判断它们的归属。
    返回 (回收目录数, 释放字节数)。
    """
    import os
    import time

    root = media_root()
    if not root.is_dir():
        return 0, 0
    deadline = time.time() - older_than_days * 86400
    removed = 0
    freed = 0
    for name in os.listdir(root):
        path = root / name
        try:
            if not path.is_dir():
                continue
        except OSError:
            continue
        if not name.isdigit() or name in keep_ids or name in PROTECTED_DIR_NAMES:
            continue
        try:
            if path.stat().st_mtime >= deadline:
                continue
        except OSError:
            continue
        freed += _dir_size(path)
        if not dry_run:
            shutil.rmtree(path, ignore_errors=True)
        removed += 1
    return removed, freed


def sweep_stale_files(questions: list[dict[str, Any]], older_than_days: int = 30,
                      dry_run: bool = False, extra_referenced: set[str] | None = None) -> tuple[int, int]:
    """文件级对账：把「本题 manifest 没记录、其它来源也没引用、且超过 N 天」的图移入归档

    注意是**移入 ``.archived``**而不是直接删：历史上有一批题的 media_files 被后续写库
    覆盖成空数组（图片其实生成成功了），归档保留 30 天可恢复窗口，配合
    ``plan_salvage`` 的重新挂接，避免"治理任务反而把能救的图删了"。

    历史版本只在「替换同 key 配图」时删旧文件，中途异常/改描述都会留下孤儿文件，
    目录级回收看不见它们（目录本身仍被引用）。这里补上文件级清理。

    ``questions`` 需要包含 ``id`` 与 ``media_files`` 两列；``extra_referenced`` 传入
    其它来源（闯关题库、白板等独立自增 id 的表）引用到的文件名 —— 历史上这些来源
    与题库共用过同一层目录，把它们的引用一起算进来才不会误删在用的图。
    """
    import os
    import time

    root = media_root()
    if not root.is_dir():
        return 0, 0
    referenced: set[str] = set(extra_referenced or set())
    bank_ids: set[str] = set()
    for row in questions:
        qid = _safe_token(row.get("id"))
        if qid:
            bank_ids.add(qid)
        referenced |= manifest_filenames(row.get("media_files"))
    deadline = time.time() - older_than_days * 86400
    removed = 0
    freed = 0
    for name in os.listdir(root):
        if not name.isdigit() or name not in bank_ids:
            continue                      # 只碰「确实在用的题库题目录」
        path = root / name
        if not _contained(path) or not path.is_dir():
            continue
        for fp in list(path.iterdir()):
            try:
                if not fp.is_file() or fp.name in referenced:
                    continue
                if fp.stat().st_mtime >= deadline:
                    continue
                if not path_within(str(root / name), str(fp)):
                    continue
            except OSError:
                continue
            try:
                freed += fp.stat().st_size
            except OSError:
                continue
            if not dry_run:
                try:
                    staging = media_root() / ARCHIVE_DIR_NAME / f"{name}__files"
                    staging.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(fp), str(staging / fp.name))
                except OSError:
                    continue
            removed += 1
    return removed, freed


def plan_salvage(question_id: Any, raw_placeholders: Any, raw_media_files: Any,
                 dir_files: list[str]) -> list[dict[str, Any]]:
    """把「目录里躺着、manifest 却没记」的配图重新挂回对应占位符

    判定必须无歧义才动手：该占位符状态是 generated/uploaded、manifest 里没有它的
    条目，而目录里**恰好只剩一个**未被引用的文件。多义一律不猜（留给归档流程处理）。

    Returns:
        需要补进 media_files 的条目列表（可能为空）
    """
    qid = _safe_token(question_id)
    if not qid or not dir_files:
        return []
    placeholders = [p for p in _as_list(raw_placeholders) if isinstance(p, dict)]
    if not placeholders:
        return []
    files = normalize_media_files(raw_media_files)
    referenced = {f.get("url", "").split("/")[-1] for f in files if f.get("url")}
    missing = [p for p in placeholders
               if str(p.get("status") or "") in ("generated", "uploaded")
               and p.get("key") not in {f.get("key") for f in files}]
    orphans = [name for name in dir_files if name not in referenced]
    out: list[dict[str, Any]] = []
    used: set[str] = set()
    for ph in missing:
        available = [name for name in orphans if name not in used]
        if len(available) != 1:
            continue          # 有歧义就不猜
        name = available[0]
        used.add(name)
        entry: dict[str, Any] = {
            "key": ph.get("key"),
            "type": "image",
            "url": url_for(SOURCE_BANK, qid, name),
            "alt": str(ph.get("description") or "配图")[:300],
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        out.append(entry)
    return out


def media_columns_for_insert(q_data: dict[str, Any],
                             placeholder_limit: int | None = MAX_PLACEHOLDERS_PER_QUESTION,
                             ) -> tuple[str, int, str]:
    """AI 出题/提取返回的配图字段 → 可直接入库的 (svg_content, has_svg, media_placeholders)

    统一做两件过去各入口做得不一致的事：
    - **SVG 清洗**：模型可能返回 ``<script>`` / ``onload=`` / ``href="javascript:..."``，
      这些内容会被前端渲染或被拼进导出的练习 HTML（同源页面），是存储型 XSS 面；
    - **占位符规整**：丢掉缺 description 的畸形项（否则生图循环里 ``ph["description"]``
      KeyError 会把整批已入库的题目带崩）、去重 key、按上限截断（控住单题生图成本）。
    """
    from backend.svg_safety import is_usable_svg, sanitize_svg

    svg_code = sanitize_svg(str(q_data.get("svg_code") or q_data.get("svg_content") or ""))
    if not is_usable_svg(svg_code):
        svg_code = ""
    placeholders = normalize_placeholders(q_data.get("media_placeholders"),
                                          limit=placeholder_limit)
    return svg_code, (1 if svg_code.strip() else 0), dump_json(placeholders)


def _dir_size(path: Path) -> int:
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for fname in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, fname))
            except OSError:
                pass
    return total


# ═══════════════════════════ 素材清单规整 ═══════════════════════════

def normalize_placeholders(raw: Any, limit: int | None = None) -> list[dict[str, Any]]:
    """把 AI/前端给的 media_placeholders 规整成安全结构

    - 丢掉非 dict、缺 description 的项（否则生图循环里 ``ph["description"]`` 直接
      KeyError，把整批已入库的题目一起带崩）
    - key 缺失或重复时补 p1/p2…（面板按 key 定位条目，重复 key 会让两张图互相覆盖）
    - 数量截到 ``MAX_PLACEHOLDERS_PER_QUESTION``（默认 1），控住单题生图成本
    - status 归一成 pending / generated / uploaded / failed 之一
    """
    if limit is None:
        # 上限可在系统配置里调（0 = 不限制），默认 2 只是给"自动生图"兜成本闸
        cap = MAX_PLACEHOLDERS_PER_QUESTION
        try:
            from backend.api.config_router import get_config_value
            cap = int(get_config_value("IMAGE_GEN_MAX_PLACEHOLDERS", MAX_PLACEHOLDERS_PER_QUESTION))
        except Exception:
            cap = MAX_PLACEHOLDERS_PER_QUESTION
    else:
        cap = int(limit)
    allowed_status = {"pending", "generated", "uploaded", "failed"}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for idx, item in enumerate(_as_list(raw)):
        if not isinstance(item, dict):
            continue
        description = str(item.get("description") or "").strip()
        if not description:
            continue
        key = _safe_token(item.get("key")) or f"p{len(out) + 1}"
        if key in seen:
            key = f"{key}-{idx + 1}"
        seen.add(key)
        status = str(item.get("status") or "pending").strip().lower()
        entry: dict[str, Any] = {
            "key": key,
            "description": description[:500],
            "purpose": str(item.get("purpose") or "示意图").strip()[:40],
            "status": status if status in allowed_status else "pending",
        }
        if isinstance(item.get("keywords"), list):
            entry["keywords"] = [str(kw)[:30] for kw in item["keywords"][:8]]
        out.append(entry)
        if cap > 0 and len(out) >= cap:
            break
    return out


def infer_status(placeholder: dict[str, Any], media_files: Any) -> str:
    """占位符状态兜底推断

    历史数据里有一批「出题时自动生图」写下的题：图已生成、media_files 里有 URL，
    但 placeholders 里没写 status（旧代码只 UPDATE 了 media_files 一列）。前端按
    status 决定显不显示图片/按钮，于是这些题在配图管理里变成「看不到图、也点不到
    重新生成」的死条目。这里按 manifest 兜底推断一次，让旧数据立刻可用。
    """
    status = str(placeholder.get("status") or "").strip().lower()
    if status:
        return status
    key = placeholder.get("key")
    for item in _as_list(media_files):
        if isinstance(item, dict) and item.get("key") == key and item.get("url"):
            return "generated"
    return "pending"


def attach_media(placeholders: list[dict[str, Any]], media_files: Any) -> list[dict[str, Any]]:
    """把 manifest 里有图的条目补进占位符列表（含万相直接配图这类无占位符条目）

    返回新的占位符列表，保证「media_files 里有的，面板里就能看到」——
    这是配图管理能管理配图的前提。
    """
    out = [dict(p) for p in placeholders if isinstance(p, dict)]
    known = {p.get("key") for p in out}
    for item in _as_list(media_files):
        if not isinstance(item, dict):
            continue
        key = item.get("key")
        if not key or not item.get("url"):
            continue
        if key in known:
            for entry in out:
                if entry.get("key") == key and entry.get("status") in ("", None, "pending"):
                    entry["status"] = "generated"
            continue
        known.add(key)
        out.append({
            "key": key,
            "description": item.get("alt") or "配图",
            "purpose": "配图",
            "status": "generated",
        })
    return out


def normalize_media_files(raw: Any) -> list[dict[str, Any]]:
    """规整 media_files（导入接口允许外部直接传，必须按不可信输入处理）

    只保留 dict 形态、带 key/url 的条目，url 截断到 500 字符并去掉换行 ——
    这些值最终会被拼进 ``<img src>`` 与导出的 HTML，不能塞任意字符串进来。
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in _as_list(raw):
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip().replace("\r", "").replace("\n", "")[:500]
        key = _safe_token(item.get("key")) or ""
        if not url or not key or key in seen:
            continue
        seen.add(key)
        entry = {
            "key": key,
            "type": str(item.get("type") or "image")[:20],
            "url": url,
            "alt": str(item.get("alt") or "")[:300],
            "created_at": str(item.get("created_at") or "")[:32],
        }
        out.append({k: v for k, v in entry.items() if v})
    return out


def dump_json(value: Any) -> str:
    """统一 ensure_ascii=False 的序列化（DB 里存中文，检索与排查都更直观）"""
    return json.dumps(value, ensure_ascii=False)


def media_summary(placeholders: Any, media_files: Any) -> dict[str, int]:
    """给接口回信用的一句话统计（多少占位符、多少已生成、多少待补）"""
    ph = [p for p in _as_list(placeholders) if isinstance(p, dict)]
    files = [f for f in _as_list(media_files) if isinstance(f, dict) and f.get("url")]
    done = sum(1 for p in ph if str(p.get("status") or "") in ("generated", "uploaded"))
    return {
        "placeholders": len(ph),
        "media_files": len(files),
        "done": done,
        "pending": sum(1 for p in ph if str(p.get("status") or "pending") == "pending"),
        "failed": sum(1 for p in ph if str(p.get("status") or "") == "failed"),
    }
