"""
用户数据落盘位置 + 一次性迁移（桌面版升级不丢数据的兜底）

背景
----
v9.0.0 及更早，两个数据库（smartkb.db / questions.db）、system_config.json、
question_media/、temp_uploads/ 的路径都是按「代码所在目录」(BASE_DIR) 算的。
桌面版打包后 BASE_DIR 就是安装目录 `...\\resources\\backend\\_internal`，于是：

    覆盖安装 → electron-builder 先清空旧安装目录 → 库和配置一起被删
    → 新版本首次启动重建空库 → 用户看到「所有资料都没了」

修复分两层：

1. 路径层（config.py）：上述数据统一走 STORAGE_DIR（
   Web/源码部署时 == BASE_DIR，行为不变；桌面版 == %APPDATA%\\smartkbs-desktop）。
2. 迁移层（本模块）：升级上来的老用户，数据还躺在安装目录里。
   启动时把「新位置不存在、旧位置存在」的数据**复制**过去（不删原件），
   幂等、可重复执行、任何异常都只记日志不阻断启动。

只复制，不移动、不删除 —— 迁移失败最多是没迁成，绝不会让数据更少。
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

from backend.config import (
    BASE_DIR,
    DATA_DIR,
    DB_DIR,
    MEDIA_ROOT,
    STORAGE_DIR,
    TEMP_UPLOAD_ROOT,
)
from backend.logger import logger

#: 迁移记录（写成功才落盘，便于复盘/排查）
MARKER_NAME = ".data_migration.json"

#: 迁移前的原件留底目录（万一迁移出错，用户还能从这里拿回原文件）
BACKUP_DIR_NAME = "_pre_migration_backup"

_DB_FILES = ("smartkb.db", "questions.db")


def _is_desktop_layout() -> bool:
    """只有「数据目录 != 代码目录」时才需要迁移（Web/源码部署两者相同，跳过）"""
    try:
        return Path(STORAGE_DIR).resolve() != Path(BASE_DIR).resolve()
    except OSError:
        return str(STORAGE_DIR) != str(BASE_DIR)


def _legacy_db_dir() -> Path:
    """旧版数据库位置：`<代码目录>/backend/`（桌面版即安装目录内）"""
    return Path(BASE_DIR) / "backend"


def _marker_path() -> Path:
    return Path(STORAGE_DIR) / MARKER_NAME


def _read_marker() -> dict:
    try:
        p = _marker_path()
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _write_marker(payload: dict) -> None:
    try:
        _marker_path().parent.mkdir(parents=True, exist_ok=True)
        _marker_path().write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception as exc:  # pragma: no cover - 落盘失败不影响业务
        logger.warning("[迁移] 写迁移标记失败：%s", exc)


def _db_has_data(path: Path) -> bool:
    """粗略判断库是不是「空壳」：users 表有行即认为有数据。

    只读打开，绝不影响原库；打不开（被占用/损坏）时按「有数据」处理，
    宁可多留一份也不要误判为空。
    """
    try:
        con = sqlite3.connect("file:%s?mode=ro" % str(path).replace("\\", "/"), uri=True, timeout=3)
        try:
            row = con.execute("SELECT COUNT(*) FROM users").fetchone()
            return bool(row and row[0])
        finally:
            con.close()
    except Exception:
        return True


def _copy_file(src: Path, dst: Path, records: list) -> None:
    """目标不存在才复制；顺带把 -wal/-shm 一起复制，避免只拷主库导致数据不全"""
    if not src.exists() or dst.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    records.append({"type": "file", "from": str(src), "to": str(dst),
                    "size": src.stat().st_size})
    for suffix in ("-wal", "-shm"):
        side = Path(str(src) + suffix)
        if side.exists():
            try:
                shutil.copy2(side, Path(str(dst) + suffix))
                records.append({"type": "file", "from": str(side),
                                "to": str(dst) + suffix, "size": side.stat().st_size})
            except Exception as exc:
                logger.warning("[迁移] 复制 %s 失败：%s", side, exc)
    logger.info("[迁移] 已复制 %s → %s", src, dst)


def _copy_tree_merge(src: Path, dst: Path, records: list, limit: int = 20000) -> int:
    """目录合并复制：只补目标缺失的文件，已存在的不覆盖。返回复制文件数"""
    if not src.is_dir():
        return 0
    copied = 0
    for root, _dirs, files in os.walk(src):
        rel = Path(root).relative_to(src)
        (dst / rel).mkdir(parents=True, exist_ok=True)
        for name in files:
            if copied >= limit:
                logger.warning("[迁移] %s 文件数超过上限 %d，剩余未复制", src, limit)
                return copied
            s = Path(root) / name
            d = dst / rel / name
            if d.exists():
                continue
            try:
                shutil.copy2(s, d)
                copied += 1
            except Exception as exc:
                logger.warning("[迁移] 复制 %s 失败：%s", s, exc)
    if copied:
        records.append({"type": "dir", "from": str(src), "to": str(dst), "files": copied})
        logger.info("[迁移] 已合并目录 %s → %s（%d 个文件）", src, dst, copied)
    return copied


def _backup_original(paths: list, records: list) -> None:
    """迁移前把要被读的原件留一份底（不移动原件）"""
    if not paths:
        return
    stamp = datetime.now().strftime("%Y%m%d.%H%M%S")
    target = Path(STORAGE_DIR) / BACKUP_DIR_NAME / stamp
    try:
        target.mkdir(parents=True, exist_ok=True)
        for p in paths:
            p = Path(p)
            if p.is_file():
                shutil.copy2(p, target / p.name)
        records.append({"type": "backup", "to": str(target),
                        "files": [p.name for p in paths]})
    except Exception as exc:
        logger.warning("[迁移] 留底失败（不影响迁移）：%s", exc)


def migrate_legacy_data() -> dict:
    """把旧版落在代码目录里的用户数据迁到 STORAGE_DIR。幂等，可反复调用。

    返回执行摘要（便于自检脚本/日志查看）。任何异常都被吞掉并记录，
    保证「迁移出问题也不影响系统正常启动」。
    """
    summary = {"desktop_layout": False, "copied": [], "skipped": None}

    if not _is_desktop_layout():
        summary["skipped"] = "Web/源码部署：数据目录与代码目录一致，无需迁移"
        return summary

    summary["desktop_layout"] = True
    records: list = []
    try:
        legacy_db = _legacy_db_dir()
        db_targets = []

        # ① 两个数据库
        for name in _DB_FILES:
            src = legacy_db / name
            dst = Path(DB_DIR) / name
            if src.exists() and not dst.exists():
                db_targets.append(src)
                if name == "smartkb.db" and not _db_has_data(src):
                    logger.warning(
                        "[迁移] 旧库 %s 看起来是空库（users 表无记录），仍将复制以免丢失其它数据", src)
                _copy_file(src, dst, records)

        # ② 系统配置（含 API Key）
        cfg_src = Path(BASE_DIR) / "system_config.json"
        cfg_dst = Path(STORAGE_DIR) / "system_config.json"
        if cfg_src.exists() and not cfg_dst.exists():
            _copy_file(cfg_src, cfg_dst, records)

        # ③ 媒体与临时上传目录（目录合并，不覆盖已有文件）
        _copy_tree_merge(Path(BASE_DIR) / "question_media", Path(MEDIA_ROOT), records)
        _copy_tree_merge(Path(BASE_DIR) / "temp_uploads", Path(TEMP_UPLOAD_ROOT), records)

        # ④ 留底：确实迁移了东西，才把原件再拷一份（避免每次启动都生成新目录）
        if any(item.get("type") in ("file", "dir") for item in records):
            _backup_original(
                db_targets + ([cfg_src] if cfg_src.exists() else []), records)

        if records:
            prev = _read_marker()
            history = prev.get("history", [])
            history.append({"at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                            "storage": str(STORAGE_DIR), "legacy": str(BASE_DIR),
                            "items": records})
            _write_marker({"version": 1, "history": history[-5:]})
            summary["copied"] = records
            logger.info("[迁移] 完成：%d 项写入 %s", len(records), STORAGE_DIR)
        else:
            logger.info("[迁移] 检查完成：没有需要迁移的数据（新位置已就绪或缺旧数据）")
    except Exception as exc:  # 绝不让迁移失败阻断启动
        logger.error("[迁移] 迁移过程异常，已跳过（不影响启动）：%s", exc, exc_info=True)

    return summary


def storage_overview() -> dict:
    """当前数据落盘概览（自检/排查用）"""
    def _size(p: Path) -> int:
        try:
            return p.stat().st_size
        except OSError:
            return -1

    return {
        "BASE_DIR": str(BASE_DIR),
        "DATA_DIR": str(DATA_DIR),
        "STORAGE_DIR": str(STORAGE_DIR),
        "DB_DIR": str(DB_DIR),
        "MEDIA_ROOT": str(MEDIA_ROOT),
        "desktop_layout": _is_desktop_layout(),
        "db": {name: _size(Path(DB_DIR) / name) for name in _DB_FILES},
        "legacy_db": {name: _size(_legacy_db_dir() / name) for name in _DB_FILES},
        "config": _size(Path(STORAGE_DIR) / "system_config.json"),
        "legacy_config": _size(Path(BASE_DIR) / "system_config.json"),
        "migrated_at": _read_marker().get("history", [{}])[-1].get("at") if _read_marker() else None,
    }


if __name__ == "__main__":  # pragma: no cover - 手工自检入口
    print(json.dumps(storage_overview(), ensure_ascii=False, indent=2))
    plan = migrate_legacy_data()
    print("\n迁移结果：")
    print(json.dumps(plan, ensure_ascii=False, indent=2, default=str))
