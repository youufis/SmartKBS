"""探索画布 · 素材自动清理（T8）

细则：docs/explore-canvas/00-详细设计书v1.md §6。线程模式与 ai_grading 一致：
main.py lifespan 调 start()，重复调用只起一个 daemon 线程；每日 EXPLORE_SWEEP_HOUR
低峰跑一轮，启动 60 秒后先跑一轮轻量。

上线安全阀：EXPLORE_SWEEP_DRY 默认 True——只算清单、写 manifest，不碰文件；
管理员核对几天清单后再到系统配置关掉 dry-run 才真正动手。
删除=移入回收站（explore_canvas_trash/YYYYMMDD/），满 EXPLORE_ASSET_TRASH_DAYS 天才物理删。
只处置 explore_canvas_assets / explore_canvas_trash 两个目录——路径写死，
物理上不可能误伤白板素材、题库配图等其它地盘。
"""
import json
import re
import shutil
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from backend.config import MEDIA_ROOT
from backend.database import get_connection
from backend.logger import logger

ASSET_DIR = MEDIA_ROOT / "explore_canvas_assets"
TRASH_DIR = MEDIA_ROOT / "explore_canvas_trash"
ASSET_NAME_RE = re.compile(r"^[0-9a-f]{16}\.(png|jpe?g|webp)$")
REF_RE = re.compile(r"explore_canvas_assets/([A-Za-z0-9._-]+)")

_STARTED = False
_START_LOCK = threading.Lock()


def _num(name, default):
    from backend.api.config_router import get_config_value
    try:
        return float(get_config_value(name, default))
    except Exception:
        return float(default)


def _bool(name, default):
    from backend.api.config_router import get_config_value
    try:
        return bool(get_config_value(name, default))
    except Exception:
        return default


def _fmt(d):
    return d.strftime("%Y-%m-%d %H:%M:%S")


def _collect_refs():
    """全量引用扫描：所有页面快照 + 历史存档里出现过的素材文件名"""
    refs = set()
    with get_connection() as conn:
        c = conn.cursor()
        for table, col in (("pc_pages", "snapshot_data"), ("pc_pages_history", "snapshot_json"), ("pc_archives", "image_src"), ("pc_shares", "snapshot_json"), ("pc_shares", "image_src"), ("pc_templates", "snapshot_json"), ("pc_templates", "image_src")):
            try:
                for (snap,) in c.execute("SELECT " + col + " FROM " + table):
                    if snap:
                        refs.update(REF_RE.findall(snap))
            except Exception as e:
                logger.warning("[explore-sweep] 扫描 %s 失败: %s", table, e)
    return refs


def _to_trash(c, fn, rule, dry, entries):
    src = ASSET_DIR / fn
    size = src.stat().st_size if src.exists() else 0
    entries.append({"filename": fn, "bytes": size, "rule": rule, "dry": dry})
    if dry:
        return False
    if not src.exists():
        c.execute("UPDATE pc_assets SET status = 'missing' WHERE filename = ?", (fn,))
        return False
    dest_dir = TRASH_DIR / datetime.now().strftime("%Y%m%d")
    dest_dir.mkdir(parents=True, exist_ok=True)
    try:
        shutil.move(str(src), str(dest_dir / fn))
        c.execute("UPDATE pc_assets SET status = 'trashed' WHERE filename = ?", (fn,))
        return True
    except OSError as e:
        logger.warning("[explore-sweep] 移入回收站失败 %s: %s", fn, e)
        return False


def sweep_once(dry=None):
    """跑一轮清理；dry=None 时按配置 EXPLORE_SWEEP_DRY。返回汇总 dict。"""
    if dry is None:
        dry = _bool("EXPLORE_SWEEP_DRY", True)
    now = datetime.now()
    orphan_days = _num("EXPLORE_ASSET_ORPHAN_DAYS", 30)
    trash_days = _num("EXPLORE_ASSET_TRASH_DAYS", 14)
    tmp_hours = _num("EXPLORE_TMP_HOURS", 24)
    watermark_mb = _num("EXPLORE_ASSET_MAX_MB", 1024)
    entries = []
    moved = purged = healed = reclaimed = 0

    refs = _collect_refs()

    # 0) 先救回：回收站里被画布重新引用的文件放回在用目录（再做任何"缺文件"判定）
    if TRASH_DIR.exists():
        for sub in TRASH_DIR.iterdir():
            if not sub.is_dir() or not re.match(r"^\d{8}$", sub.name):
                continue
            for p in sub.iterdir():
                if p.is_file() and p.name in refs:
                    if not dry:
                        shutil.move(str(p), str(ASSET_DIR / p.name))
                    with get_connection() as conn2:
                        conn2.cursor().execute(
                            "UPDATE pc_assets SET status = 'active', last_seen_at = ? WHERE filename = ?",
                            (_fmt(now), p.name))
                        conn2.commit()
                    entries.append({"filename": p.name, "rule": "ref_back_to_active", "dry": dry})
                    reclaimed += 1

    with get_connection() as conn:
        c = conn.cursor()
        # 1) 引用续命
        for fn in refs:
            c.execute("UPDATE pc_assets SET last_seen_at = ? WHERE filename = ? AND status = 'active'",
                      (_fmt(now), fn))

        # 2) 账本自愈：库有行、盘没文件 → missing；盘有文件、库没行 → 补册
        known = set()
        for (fn, status) in c.execute("SELECT filename, status FROM pc_assets WHERE status != 'purged'"):
            known.add(fn)
            if status == "active" and not (ASSET_DIR / fn).exists():
                c.execute("UPDATE pc_assets SET status = 'missing' WHERE filename = ?", (fn,))
                entries.append({"filename": fn, "rule": "heal_missing_file", "dry": dry})
                healed += 1
        if ASSET_DIR.exists():
            for p in ASSET_DIR.iterdir():
                if p.is_file() and p.name not in known and ASSET_NAME_RE.match(p.name):
                    c.execute(
                        "INSERT OR IGNORE INTO pc_assets (filename, source, owner_username, bytes, mime,"
                        " created_at, last_seen_at, status) VALUES (?, 'canvas_ref', '', '', '', ?, ?, 'active')",
                        (p.name, _fmt(now), _fmt(now)))
                    entries.append({"filename": p.name, "rule": "heal_add_ledger", "dry": dry})
                    healed += 1

        # 3) 临时件到期（未被引用）→ 回收站
        tmp_cut = _fmt(now - timedelta(hours=tmp_hours))
        for (fn,) in c.execute(
                "SELECT filename FROM pc_assets WHERE status = 'active' AND source = 'asr_tmp' AND created_at < ?",
                (tmp_cut,)):
            if fn not in refs:
                if _to_trash(c, fn, "tmp_expired", dry, entries):
                    moved += 1

        # 4) 孤儿素材：超期未被引用 → 回收站
        orphan_cut = _fmt(now - timedelta(days=orphan_days))
        for (fn,) in c.execute(
                "SELECT filename FROM pc_assets WHERE status = 'active' AND last_seen_at < ? ORDER BY last_seen_at",
                (orphan_cut,)):
            if fn not in refs:
                if _to_trash(c, fn, "orphan_" + str(int(orphan_days)) + "d", dry, entries):
                    moved += 1

        # 4.5) 回收站画布到期：archived=1 超 EXPLORE_CANVAS_TRASH_DAYS → 连页面/历史一并销毁
        canvas_days = _num("EXPLORE_CANVAS_TRASH_DAYS", 30)
        canvas_cut = _fmt(now - timedelta(days=canvas_days))
        for (cid, ctitle) in c.execute(
                "SELECT id, title FROM pc_canvases WHERE archived = 1 AND updated_at < ?", (canvas_cut,)).fetchall():
            entries.append({"canvas_id": cid, "title": ctitle, "rule": "canvas_trash_expired", "dry": dry})
            if not dry:
                c.execute("DELETE FROM pc_pages WHERE canvas_id = ?", (cid,))
                c.execute("DELETE FROM pc_pages_history WHERE canvas_id = ?", (cid,))
                c.execute("DELETE FROM pc_canvases WHERE id = ?", (cid,))
                moved += 1

        # 4.6) 分享快照到期：行直接删除（快照是副本；引用的素材若仍被画布使用会照常续命）
        for (sid,) in c.execute(
                "SELECT id FROM pc_shares WHERE expires_at != '' AND expires_at < ?", (_fmt(now),)).fetchall():
            entries.append({"share_id": sid, "rule": "share_expired", "dry": dry})
            if not dry:
                c.execute("DELETE FROM pc_shares WHERE id = ?", (sid,))
                purged += 1
        # 5) 水位：只统计与告警，绝不强删学生正在用的作品（设计 §6.2-6）
        total = c.execute("SELECT COALESCE(SUM(bytes), 0) FROM pc_assets WHERE status = 'active'").fetchone()[0]
        active_bytes = int(total or 0)

    # 5.5) TTS 缓存治理：缓存是可再生资产——超水位清最久未动的，最近 7 天产物豁免（课堂讲演/播客不受影响）
    try:
        from backend.tts_service import _cache_dir as _tts_cache_dir
        cap_mb = _num("EXPLORE_TTS_CACHE_MB", 200)
        d = _tts_cache_dir()
        if d.exists():
            files = [f for f in d.iterdir() if f.is_file()]
            total = sum(f.stat().st_size for f in files)
            if total > cap_mb * 1024 * 1024:
                grace = time.time() - 7 * 86400
                old = sorted((f for f in files if f.stat().st_mtime < grace), key=lambda f: f.stat().st_mtime)
                for f in old:
                    if total <= cap_mb * 1024 * 1024:
                        break
                    if not dry:
                        try:
                            size = f.stat().st_size
                            f.unlink()
                            total -= size
                            entries.append({"filename": f.name, "bytes": size, "rule": "tts_cache_lru", "dry": dry})
                        except OSError:
                            pass
                    else:
                        entries.append({"filename": f.name, "rule": "tts_cache_lru", "dry": dry})
    except Exception as e:
        logger.debug("[explore-sweep] TTS 缓存治理跳过: %s", e)

    # 6) 回收站到期 → 物理删除（按日期子目录名判定）
    if TRASH_DIR.exists():
        cut_tag = (now - timedelta(days=trash_days)).strftime("%Y%m%d")
        for sub in TRASH_DIR.iterdir():
            if sub.is_dir() and re.match(r"^\d{8}$", sub.name) and sub.name < cut_tag:
                for p in sub.iterdir():
                    if p.is_file() and ASSET_NAME_RE.match(p.name):
                        if not dry:
                            try:
                                p.unlink()
                                with get_connection() as conn3:
                                    conn3.cursor().execute("UPDATE pc_assets SET status = 'purged' WHERE filename = ?",
                                                           (p.name,))
                                    conn3.commit()
                            except OSError as e:
                                logger.warning("[explore-sweep] 物理删除失败 %s: %s", p, e)
                        purged += 1
                        entries.append({"filename": p.name, "rule": "trash_expired", "dry": dry})
                if not dry:
                    try:
                        if not any(sub.iterdir()):
                            sub.rmdir()
                    except OSError:
                        pass

    over = active_bytes > watermark_mb * 1024 * 1024
    if over:
        logger.warning("[explore-sweep] 素材目录 %s MB 已超水位 %s MB（在用作品不自动删，请管理员处理）",
                       round(active_bytes / 1048576, 1), int(watermark_mb))

    # 7) 写当日 manifest（试跑也写，管理端可查）
    try:
        TRASH_DIR.mkdir(parents=True, exist_ok=True)
        mpath = TRASH_DIR / ("manifest_" + now.strftime("%Y%m%d") + ".json")
        old = []
        if mpath.exists():
            try:
                old = json.loads(mpath.read_text(encoding="utf-8"))
                old = old.get("entries", []) if isinstance(old, dict) else old
            except Exception:
                old = []
        mpath.write_text(json.dumps({"run_at": _fmt(now), "dry": dry, "entries": old + entries},
                                    ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError as e:
        logger.warning("[explore-sweep] manifest 写入失败: %s", e)

    summary = {"dry": dry, "moved_to_trash": moved, "purged": purged, "healed": healed,
               "reclaimed": reclaimed, "active_bytes": active_bytes, "over_watermark": over,
               "entries": len(entries)}
    logger.info("[explore-sweep] 一轮完成 dry=%s 入站=%s 物删=%s 自愈=%s 救回=%s 活动=%sMB",
                dry, moved, purged, healed, reclaimed, round(active_bytes / 1048576, 1))
    return summary


def _loop():
    time.sleep(60)  # 启动后先跑一轮（默认 dry-run，无风险）
    while True:
        try:
            sweep_once()
        except Exception as e:
            logger.warning("[explore-sweep] 轮次失败: %s", e)
        hour = int(_num("EXPLORE_SWEEP_HOUR", 3))
        now = datetime.now()
        nxt = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        if nxt <= now:
            nxt = nxt + timedelta(days=1)
        time.sleep(max(60, (nxt - now).total_seconds()))


def start():
    """main.py lifespan 调用；重复调用只起一个线程。"""
    global _STARTED
    if _STARTED:
        return
    with _START_LOCK:
        if _STARTED:
            return
        _STARTED = True
    threading.Thread(target=_loop, name="explore-sweeper", daemon=True).start()
    logger.info("[explore-sweep] 素材清理线程已启动（dry-run 由系统配置控制，默认开）")
