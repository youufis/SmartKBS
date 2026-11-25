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
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.config import MEDIA_ROOT
from backend.svg_safety import is_usable_svg, sanitize_svg
from backend.utils import path_within

logger = logging.getLogger(__name__)

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
    """配图根目录（与 files_router 静态服务基准一致：MEDIA_ROOT / STORAGE_DIR）

    Web 版 == <项目根>/question_media（与历史完全一致）；
    桌面版 == %APPDATA%\\<app>\\question_media，不再随安装目录被删。
    """
    return Path(MEDIA_ROOT)


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
    """题库题目**被删除**时归档配图目录（可完整恢复），到期由日志保留任务物理清除

    只搬 ``question_media/<id>``，绝不碰 ``quest/``、``whiteboard_ai/`` 等子命名空间。
    目录里没有图片就只回收空壳、不生成归档条目：历史上 ``question_media/1`` 被
    ``ensure_media_dir`` 反复重建，每轮治理都搬出一个空 ``1__<时间戳>``，攒了几十个。
    """
    qid = _safe_token(question_id)
    if not qid:
        return None
    src = media_dir(SOURCE_BANK, qid)
    if not _contained(src) or not src.is_dir():
        return None
    if not any(p.is_file() for p in src.rglob("*")):
        shutil.rmtree(src, ignore_errors=True)
        return None
    dst_root = media_root() / ARCHIVE_DIR_NAME
    dst_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    dst = dst_root / f"{qid}__{stamp}"
    shutil.move(str(src), str(dst))
    return str(dst)


def purge_bank_dir(question_id: Any) -> dict[str, Any]:
    """彻底删除试题时物理清除它的配图：本题目录 + 之前软删归档出去的 ``.archived/<id>__*`` 副本。

    与 :func:`archive_bank_dir` 相反：归档是"先收起来，30 天后由日志保留任务清"，
    彻底删除是老师明确说了"不要了"，所以两处都清干净，不留待清理的尾巴。
    只碰本题的目录；``quest/``、``whiteboard_ai/`` 这些子命名空间一律不动。
    """
    out: dict[str, Any] = {"live_removed": 0, "archived_removed": 0, "files": 0, "errors": []}
    qid = _safe_token(question_id)
    if not qid:
        return out
    live = media_dir(SOURCE_BANK, qid)
    if _contained(live) and live.is_dir():
        try:
            out["files"] += sum(1 for p in live.rglob("*") if p.is_file())
            shutil.rmtree(live)
            out["live_removed"] = 1
        except OSError as e:
            out["errors"].append(f"live:{e}")
    arch = media_root() / ARCHIVE_DIR_NAME
    if arch.is_dir():
        for d in sorted(arch.glob(f"{qid}__*")):
            if not d.is_dir() or not _contained(d):
                continue
            try:
                out["files"] += sum(1 for p in d.rglob("*") if p.is_file())
                shutil.rmtree(d)
                out["archived_removed"] += 1
            except OSError as e:
                out["errors"].append(f"archived:{e}")
    return out


def restore_bank_dir(question_id: Any) -> dict[str, Any]:
    """把软删时归档出去的配图目录搬回本题目录（还原题目时配套调用）。

    只认 ``.archived/<id>__<时间戳>``，有多份时取最新那一份。本题目录已存在就不动它
    —— 那说明删除后又生成过配图，覆盖会把新图弄丢；此时归档留在原地，
    由日志保留任务到期清理。
    """
    out: dict[str, Any] = {"restored": 0, "files": 0, "kept": 0, "errors": []}
    qid = _safe_token(question_id)
    if not qid:
        return out
    arch = media_root() / ARCHIVE_DIR_NAME
    if not arch.is_dir():
        return out
    cands = sorted((d for d in arch.glob(f"{qid}__*") if d.is_dir() and _contained(d)),
                   key=lambda d: d.name, reverse=True)
    if not cands:
        return out
    live = media_dir(SOURCE_BANK, qid)
    if _contained(live) and live.exists():
        out["kept"] = len(cands)
        return out
    try:
        live.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(cands[0]), str(live))
        out["restored"] = 1
        out["files"] = sum(1 for p in live.rglob("*") if p.is_file())
    except (OSError, shutil.Error) as e:
        out["errors"].append(str(e))
    return out


def bank_media_footprint(question_id: Any) -> dict[str, int]:
    """彻底删除前的只读盘点：本题目录与归档副本里各有多少文件（预览用，不落任何改动）。"""
    live_files = archived_dirs = archived_files = 0
    qid = _safe_token(question_id)
    if qid:
        live = media_dir(SOURCE_BANK, qid)
        if _contained(live) and live.is_dir():
            live_files = sum(1 for p in live.rglob("*") if p.is_file())
        arch = media_root() / ARCHIVE_DIR_NAME
        if arch.is_dir():
            for d in arch.glob(f"{qid}__*"):
                if d.is_dir() and _contained(d):
                    archived_dirs += 1
                    archived_files += sum(1 for p in d.rglob("*") if p.is_file())
    return {"live_files": live_files, "archived_dirs": archived_dirs, "archived_files": archived_files}


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
    """孤儿目录回收 —— **不再由定时任务调用**（2026-11-07），只允许人工磁盘清理显式使用

    规矩：只有题目被删除才允许移除它的配图。按目录年龄回收会误删「题目还在、题池/考试/
    练习/错题本快照仍在引用」的图，``_maintain_question_media`` 已停用本函数。

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

    **不再由定时任务调用**（2026-11-07）：manifest 丢了引用不等于图该删 —— 历史上就有
    一批题的 media_files 被后续写库覆盖成空数组、图其实生成成功了（现场见 906/1299/
    1304/1322/1325），按清单差异回收正好和下面 ``plan_salvage`` 的抢救目标相反。

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


class _FigureRejected(Exception):
    """内部信号：这张图不合格，不要入库。

    只用来把"三个分支的失败"收敛成一条出口 —— 以前每个分支各自往 notes 里写
    拒收原因、各自 return ""，于是同一个校验（清洗、公式排版、几何体检、可用性）
    在三个分支里各写了一遍，改一处漏两处（刻度格式化、泄答案检查都漂移过）。
    """

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _read_inputs(q_data: dict[str, Any]) -> dict[str, Any]:
    """把 AI 返回的各种字段形状收敛成一份规范输入（绝不抛异常）"""
    spec = q_data.get("figure_spec") or q_data.get("figure") or q_data.get("graph_spec")
    if isinstance(spec, str) and spec.strip().startswith("{"):
        # 模型有时把嵌套对象再序列化一次，figure_spec 到手是 JSON 字符串。
        # 不解析就会被 isinstance(dict) 判掉，表现成"spec 明明给了却当没给"。
        try:
            spec = json.loads(spec)
        except (TypeError, ValueError):
            spec = None
    raw_opts = q_data.get("options")
    return {
        "spec": spec if isinstance(spec, dict) else None,
        "hand": str(q_data.get("svg_code") or q_data.get("svg_content") or ""),
        "text": str(q_data.get("question") or q_data.get("question_text") or ""),
        "options": raw_opts if isinstance(raw_opts, dict) else {},
        "answer": str(q_data.get("answer") or q_data.get("correct_answer") or ""),
    }


def _is_shape_spec(spec: dict[str, Any]) -> bool:
    """判断 spec 是统计图/几何图（而不是函数图像）

    分派靠字段特征而不是强制 shape 键：模型经常不写 shape，但 series/categories
    或 segments/relations 这些结构一定会给。有 functions 的不走这里 —— 那类还要
    额外做题干条件与答案选项的交叉验算。
    """
    if spec.get("functions"):
        return False
    shape = str(spec.get("shape") or "").strip().lower()
    if shape in ("stat", "chart", "statistics", "pie", "bar", "geometry", "figure", "geo"):
        return True
    if spec.get("series") or spec.get("categories"):
        return True
    if spec.get("points") and (spec.get("segments") or spec.get("polygons")
                               or spec.get("relations") or spec.get("angles")
                               or spec.get("circles") or spec.get("right_angles")):
        return True
    return False


def _plan(inp: dict[str, Any]) -> str:
    """定策：shape / function / hand / none。规则只在这里说一次。"""
    spec, hand = inp["spec"], inp["hand"]
    if spec is not None and _is_shape_spec(spec):
        return "shape"
    if spec is not None and (spec.get("functions") or []):
        return "function"
    if hand.strip():
        return "hand"
    if spec is not None:
        # 只有点、没有函数也没有手绘 —— 是"图型不适用参数化"，不是图文矛盾。
        # 报清楚，否则老师只看到"图没了"，完全不知道发生了什么。
        raise _FigureRejected("figure_spec 未声明函数且没有 svg_code，"
                              "该图型（几何/装置/结构等）暂不支持参数化渲染")
    return "none"


class _DrawFallbackToHand(Exception):
    """渲染器不可用时退回手绘通道（不是"图不合格"，所以单独一个信号）"""


def _draw_shape(spec: dict[str, Any]) -> str:
    """统计图/几何图：柱高=数据、饼图角度=占比、几何关系逐条代入坐标验算"""
    try:
        from backend.figure_shapes import ShapeSpecError, render_shape
    except Exception as exc:                    # noqa: BLE001 — 依赖坏了退回手绘通道
        logger.warning("figure_shapes 不可用，退回手绘 SVG 通道: %s", exc)
        raise _DrawFallbackToHand() from exc
    try:
        return render_shape(spec)
    except ShapeSpecError as exc:
        # 这是"图不合格"，不是"程序坏了"。让它冒到顶层兜底的话，老师看到的是
        # "配图被拒收：处理异常 线段 引用了未定义的点 Z" —— 前半句把人引去查日志，
        # 其实后半句才是他该改的东西。
        raise _FigureRejected(str(exc)) from exc


def _draw_function(inp: dict[str, Any], notes: list[str]) -> str:
    """函数图像：先按题干条件与答案选项交叉验算（必要时自动重建），再确定性渲染"""
    from backend.figure_svg import (FigureSpecError, render_figure, repair_spec,
                                    verify_figure)
    spec = inp["spec"]
    problems = verify_figure(spec, question_text=inp["text"], options=inp["options"],
                             correct_answer=inp["answer"])
    if problems:
        # 模型把解析式写歪、把答案写进标注，都是这类题的常见错法；而正确的图完全
        # 能从题干+答案键推出来。先修，修不动（例如答案键本身与题干矛盾）才拒收 ——
        # 直接拒收只会让老师对着空配图以为功能坏了。
        repaired, action = repair_spec(spec, question_text=inp["text"],
                                       options=inp["options"],
                                       correct_answer=inp["answer"])
        if repaired is not None:
            # 提示直接写进 notes：以前塞进一个没人读的中转列表，
            # 结果"图被自动改过"这件最重要的事反而没告诉老师
            notes.append("配图已自动修正（%s）：%s" % (action, "；".join(problems[:1])))
            spec = repaired
        else:
            raise _FigureRejected("；".join(problems[:3]))
    try:
        return render_figure(spec)
    except FigureSpecError as exc:              # 同上：校验失败要说人话
        raise _FigureRejected(str(exc)) from exc


def _finish(svg: str, *, notes: list[str], strict: bool, inp: dict[str, Any],
            origin: str = "配图里") -> str:
    """统一收尾：清洗 → 公式排版 → 可用性 → 几何体检 → 处置策略

    这一段是整条管线唯一的出口。所有分支的产物都必须经过这里，因此
    "某条路忘了查泄答案"这类问题在结构上不可能再出现。
    """
    cleaned = sanitize_svg(svg)
    try:
        from backend.math_text import mathify_svg
        cleaned, fixed = mathify_svg(cleaned)
        if fixed:
            notes.append("%s %d 处公式已自动排版" % (origin, fixed))
    except Exception as exc:                    # noqa: BLE001 — 排版失败退回原样，不拦
        logger.warning("配图公式排版异常: %s", exc)
    if not is_usable_svg(cleaned):
        raise _FigureRejected("渲染结果不是可渲染的 SVG（可能被截断或包在响应壳里）")
    try:
        from backend.svg_geometry import inspect_svg
        hard, soft = inspect_svg(cleaned, options=inp["options"],
                                 correct_answer=inp["answer"])
    except Exception as exc:                    # noqa: BLE001 — 体检坏了不能牵连所有内容
        # 上一版这里只兜 ImportError，其余异常冒到顶层兜底，结果是**连 strict=False
        # 的教师粘贴图也一起丢掉** —— 一个体检 bug 就能让全题库的配图消失。
        logger.error("SVG 几何体检内部错误: %s", exc, exc_info=True)
        if strict:
            # AI 产出的图按"宁缺勿错"处理：没检查过的图不进试卷，但原因要写清是
            # 体检没跑成，而不是暗示图画错了。
            raise _FigureRejected("配图体检未完成（内部错误），按宁缺勿错暂不入库") from exc
        notes.append("配图体检未完成，已保留原图（不影响使用，但请人工核对）")
        return cleaned

    notes.extend(soft)
    if hard:
        if strict:
            raise _FigureRejected("；".join(hard[:2]))
        # 教师自己上传/粘贴的图不适用"宁缺勿错"：那是他已经认可的内容，
        # 悄悄丢掉等于改功能行为。这里照样清洗与排版，只把问题作为提示返回。
        notes.append("配图存在 %d 个问题（已保留，请核对）：" % len(hard)
                     + "；".join(hard[:2]))
    return cleaned


def resolve_svg(q_data: dict[str, Any], notes: list[str] | None = None, *,
                 strict: bool = True) -> str:
    """AI 出题返回的配图字段 -> 可入库的 SVG；**不合格一律返回空串**（宁缺勿错）

    单管线：``读入 -> 定策 -> 绘制 -> 统一收尾``。

    三种绘制方式按可靠性排序：

    1. ``shape``：统计图/几何图，交 ``backend.figure_shapes.render_shape``；
    2. ``function``：函数图像，交 ``backend.figure_svg.render_figure``，
       渲染前用题干的数值条件与答案选项做交叉验算（``verify_figure``），
       对不上先试自动重建（``repair_spec``），重建不了才拒收；
    3. ``hand``：电路图/流程图/装置图这类无法参数化的图，才用模型手绘的 svg_code。

    无论走哪条，产物都必须过同一个 :func:`_finish`（清洗 → 公式排版 → 可用性 →
    几何体检 → 处置策略）。历史上这里是"照单全收"，且校验散在各分支各写一遍，
    于是画到画布外的空图、印着 ``$R_1$`` 反斜杠的乱码图、描述另一道题的错图，
    都能直接进试卷。
    """
    notes = notes if notes is not None else []
    inp = _read_inputs(q_data)
    try:
        mode = _plan(inp)
        if mode == "none":
            notes.append("配图未生成：模型没有给出 figure_spec 也没有给出 svg_code，请重试")
            return ""
        try:
            if mode == "shape":
                svg = _draw_shape(inp["spec"])
            elif mode == "function":
                svg = _draw_function(inp, notes)
            else:
                svg = inp["hand"]
        except _DrawFallbackToHand:
            if not inp["hand"].strip():
                notes.append("配图未生成：渲染器不可用且模型没有给出手绘 SVG，请重试")
                return ""
            svg = inp["hand"]
        out = _finish(svg, notes=notes, strict=strict, inp=inp)
        return out
    except _FigureRejected as exc:
        notes.append("配图被拒收：%s" % str(exc.reason)[:200])
        return ""
    except Exception as exc:                    # noqa: BLE001 — 一张图失败不能带崩整批出题
        logger.error("配图处理内部异常（%s）: %s", type(exc).__name__, exc, exc_info=True)
        # 口径必须分开："配图被拒收" = 图与题目不符（该改题）；
        # "配图未生成（内部错误）" = 我们这边出问题了（该重试/报修，别去改题）。
        notes.append("配图未生成：内部错误 %s: %s" % (type(exc).__name__, str(exc)[:140]))
        return ""


def polish_svg(svg: Any, notes: list[str] | None = None) -> str:
    """对**已经入库/从题库复制过来**的 SVG 只做无损改进：安全清洗 + 公式自动排版

    与 :func:`resolve_svg` 的区别是刻意不拒收。闯关、随堂测验、课堂阶梯这些派生表
    里的图是从题库复制的，是老师已经看到并认可的；如果因为新加的闸在复制环节把它们
    丢掉，用户看到的就是"原本有图的题现在没图了"——那是改功能行为，不是修质量。
    图形本身一个像素都不动。
    """
    notes = notes if notes is not None else []
    text = str(svg or "")
    if not text.strip():
        return ""
    inp = {"spec": None, "hand": text, "text": "", "options": {}, "answer": ""}
    try:
        out = _finish(text, notes=notes, strict=False, inp=inp,
                      origin="复制过来的配图里")
    except _FigureRejected as exc:
        # 连清洗后都不可渲染（整张图基本是脚本/坏结构）—— 这种留着也没用
        logger.info("polish_svg 放弃一张不可渲染的图: %s", exc.reason)
        return ""
    return out


def media_columns_for_insert(q_data: dict[str, Any],
                             placeholder_limit: int | None = MAX_PLACEHOLDERS_PER_QUESTION,
                             notes: list[str] | None = None, *,
                             strict: bool = True,
                             ) -> tuple[str, int, str]:
    """AI 出题/提取返回的配图字段 -> 可直接入库的 (svg_content, has_svg, media_placeholders)

    统一做三件过去各入口做得不一致的事：
    - **配图质量闸**：能参数化的走确定性渲染，其余先排版公式再做几何体检，
      不合格的不入库（见 :func:`resolve_svg`）；
    - **SVG 清洗**：模型可能返回 ``<script>`` / ``onload=`` / ``href="javascript:..."``，
      这些内容会被前端渲染或被拼进导出的练习 HTML（同源页面），是存储型 XSS 面；
    - **占位符规整**：丢掉缺 description 的畸形项（否则生图循环里 ``ph["description"]``
      KeyError 会把整批已入库的题目带崩）、去重 key、按上限截断（控住单题生图成本）。
    """
    svg_code = resolve_svg(q_data, notes=notes, strict=strict)
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
