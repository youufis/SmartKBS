"""资源内容类型（小类）的唯一读写入口 —— C 档第 1+2 步。

背景：网页资源没有主数据表（`/api/resources/list` 是磁盘扫描），内容类型此前每次请求
现算 —— `resource_registry.sub_kind_of()` 按文件名后缀猜。代价有两条：

  · 改个文件名，分类就掉；
  · 同一个值散落在后端 3 个读取点 + 前端 2 个判定里，加一类漏一处 —— 历史上真漏了两次：
    界面上先把 AI 课件显示成「其它网页」，后来又露出裸键 kind.courseware。

现在的口径：

  1. 显式标注（表 resource_kind_marks）优先于文件名推断；
  2. 标注分三档来源，低优先级不覆盖人工：manual(3) > ai(2) > rule(1)；
  3. 键是「相对项目根的 POSIX 物理路径」（本身已含属主目录，如 root/html/x.html），
     同一个物理文件被多人「再共享」也只有一个内容类型；
  4. 所有读取点都走本模块，前端拿 GET /api/resources/kinds 判「哪些值属于内容类型」，
     不再各自硬列名单。

标注表只存"人 / 机器明确说过"的记录，不做清理：文件删了留一行脏记录无害，同名文件
重建时沿用旧标注反而符合直觉。
"""
from __future__ import annotations

import os
import re
import sqlite3
import time
from typing import Iterable

from backend.config import BASE_DIR, STU_DIR
from backend.database import execute_query, execute_insert_update, get_connection
from backend.logger import logger
from backend.resource_registry import SUBKIND_LABELS, sub_kind_of

# 生效优先级：人工标注压过 AI 补标，AI 补标压过生成时按来源写入的值
PRIORITY: dict[str, int] = {"manual": 3, "ai": 2, "rule": 1}

_IN_CHUNK = 400   # 分片 IN 的上限，避开 SQLite 变量数限制


def canon_path(row_owner: str, file_path: object, resource_type: str) -> str:
    """共享行里的路径 -> 相对项目根的物理路径（内容类型标注的唯一键）。

    入库形态混着 x.html / html/x.html / <owner>/html/x.html / stu/<owner>/html/x.html，
    「再共享」还会出现「行 owner=root、路径却是 youufis/html/x.html」这种 owner 与文件属主
    不一致的行，所以只看路径自己是否已带 <谁>/html|downloads/ 前缀，不能一律再拼一遍 owner。
    """
    _dir = "html" if resource_type == "html" else "downloads"
    p = str(file_path or "").replace("\\", "/").strip().lstrip("/")
    if not p:
        return f"{row_owner}/{_dir}/"
    if p.startswith(f"{STU_DIR}/"):
        return p
    if p.startswith(f"{_dir}/"):
        return f"{row_owner}/{p}"
    if f"/{_dir}/" in f"/{p}":       # 已带 <某账号>/html|downloads/ 前缀 -> 本身就是物理路径
        return p
    return f"{row_owner}/{_dir}/{p}"


def valid_kind(kind: object) -> bool:
    return str(kind or "") in SUBKIND_LABELS


def norm_path(path: object) -> str:
    # 任意写法（绝对 / 相对项目根 / 相对 html 目录 / 带前导斜杠）-> 相对项目根的 POSIX 路径
    raw = str(path or "").strip()
    if not raw:
        return ""
    is_abs_win = bool(re.match(r"^[A-Za-z]:[/\\]", raw))
    if raw.startswith("/") and "://" not in raw and not is_abs_win:
        raw = raw.lstrip("/")           # 前端偶尔会带个前导斜杠
    if os.path.isabs(raw) or is_abs_win:
        try:
            return os.path.relpath(os.path.normpath(raw), str(BASE_DIR)).replace("\\", "/")
        except ValueError:              # 跨盘符无法相对化：原样收敛分隔符
            return raw.replace("\\", "/")
    return raw.replace("\\", "/").lstrip("/")


def mark_file(path: object, sub_kind: str, set_by: str = "manual", by_user: str = "") -> bool:
    # 按任意写法的路径写标注（产物落盘后调用，不用调用方自己算相对路径）
    return set_mark(norm_path(path), sub_kind, set_by, by_user)


def remap_mark(old_path: object, new_path: object) -> int:
    # 文件/目录改名后把标注搬过去 —— 这正是「落盘即定类」的价值：改名不掉标。
    # 先读出来、删干净、再按新路径写回：比在 SQL 里做子树字符串拼接更好核对。
    old, new = norm_path(old_path), norm_path(new_path)
    if not old or not new or old == new:
        return 0
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            rows = cur.execute(
                "SELECT file_path, sub_kind, set_by, set_by_user FROM resource_kind_marks "
                "WHERE file_path=? OR file_path LIKE ?", (old, old + "/%"),
            ).fetchall()
            if not rows:
                return 0
            cur.execute("DELETE FROM resource_kind_marks WHERE file_path=? OR file_path LIKE ?",
                        (old, old + "/%"))
            moved = 0
            for fp, kind, set_by, by_user in rows:
                target = new if fp == old else new + fp[len(old):]
                cur.execute(
                    "INSERT OR REPLACE INTO resource_kind_marks "
                    "(file_path, sub_kind, set_by, set_by_user, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (target, kind, set_by or "manual", by_user or "", now),
                )
                moved += 1
            conn.commit()
        return moved
    except Exception as e:
        logger.warning(f"搬迁资源内容类型标注失败 ({old} -> {new}): {e}")
        return 0


def marks_for(paths: Iterable[str]) -> dict[str, tuple[str, str]]:
    # 批量取显式标注：物理路径 -> (sub_kind, set_by)。一次查完，不做 N+1。
    want = {str(p or "").replace("\\", "/") for p in paths if p}
    if not want:
        return {}
    out: dict[str, tuple[str, str]] = {}
    ordered = sorted(want)
    try:
        for i in range(0, len(ordered), _IN_CHUNK):
            chunk = ordered[i:i + _IN_CHUNK]
            ph = ",".join("?" for _ in chunk)
            for fp, kind, set_by in execute_query(
                f"SELECT file_path, sub_kind, set_by FROM resource_kind_marks WHERE file_path IN ({ph})",
                tuple(chunk),
            ) or []:
                key = str(fp or "").replace("\\", "/")
                if key in want and valid_kind(kind):
                    out[key] = (str(kind), str(set_by or "manual"))
    except Exception as e:   # 老库首启、表还没建等情况：退回文件名推断，绝不阻断页面
        logger.warning(f"读取资源内容类型标注失败，本请求退回文件名推断: {e}")
        return {}
    return out


def resolve(path: str, name: object, marks: dict[str, tuple[str, str]] | None = None) -> str:
    """一条资源的内容类型：显式标注优先，其次按文件名推断。"""
    key = str(path or "").replace("\\", "/")
    hit = (marks or {}).get(key)
    if hit:
        return hit[0]
    return sub_kind_of(name)


def set_mark(path: str, sub_kind: str, set_by: str = "manual", by_user: str = "") -> bool:
    """写一条标注。低优先级不覆盖更高优先级的既有标注（人工标注不会被 AI 冲掉）。"""
    key = str(path or "").replace("\\", "/")
    if not key or not valid_kind(sub_kind):
        return False
    who = set_by if set_by in PRIORITY else "manual"
    try:
        rows = execute_query(
            "SELECT sub_kind, set_by FROM resource_kind_marks WHERE file_path=?", (key,)
        ) or []
        if rows:
            cur_kind = str(rows[0][0] or "")
            cur_by = str(rows[0][1] or "manual")
            if PRIORITY.get(cur_by, 3) > PRIORITY.get(who, 3):
                return False
            if cur_kind == sub_kind and cur_by == who:
                return True
        execute_insert_update(
            "INSERT INTO resource_kind_marks (file_path, sub_kind, set_by, set_by_user, updated_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(file_path) DO UPDATE SET sub_kind=excluded.sub_kind, "
            "set_by=excluded.set_by, set_by_user=excluded.set_by_user, updated_at=excluded.updated_at",
            (key, sub_kind, who, by_user or "", time.strftime("%Y-%m-%d %H:%M:%S")),
        )
        return True
    except Exception as e:
        logger.warning(f"写入资源内容类型标注失败 ({key} -> {sub_kind}): {e}")
        return False


def clear_mark(path: str) -> int:
    """撤销标注，把这一条交回给文件名推断。"""
    key = str(path or "").replace("\\", "/")
    if not key:
        return 0
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM resource_kind_marks WHERE file_path=?", (key,))
            n = cur.rowcount
            conn.commit()
        return n
    except Exception as e:
        logger.warning(f"撤销资源内容类型标注失败 ({key}): {e}")
        return 0



def purge_mark(path: object) -> int:
    # 删文件/删目录时清掉标注（含整棵子树），不留指向已删资源的脏记录
    key = norm_path(path)
    if not key:
        return 0
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            n = cur.execute(
                "DELETE FROM resource_kind_marks WHERE file_path=? OR file_path LIKE ?",
                (key, key + "/%"),
            ).rowcount
            conn.commit()
        return n
    except Exception as e:
        logger.warning(f"清理资源内容类型标注失败 ({key}): {e}")
        return 0

def label(kind: str) -> str:
    """小类的中文兜底标签（未知值原样返回，绝不返回键路径）。"""
    return SUBKIND_LABELS.get(str(kind or ""), str(kind or ""))


def kinds_payload() -> list[dict[str, str]]:
    """给前端的唯一清单：键 + 中文兜底标签（前端 i18n 命中时优先用 i18n 文案）。"""
    return [{"key": k, "label": v} for k, v in SUBKIND_LABELS.items()]