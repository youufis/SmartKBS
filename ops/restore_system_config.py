# -*- coding: utf-8 -*-
"""系统配置恢复工具（应用起不来 / 桌面版进不去页面时的命令行出路）

背景
----
v9.0.0 起配置读 <数据根>/system_config.json（Web/源码部署 = 项目根，桌面版 = %APPDATA%\\smartkbs-desktop），
更早版本读 <代码目录>/backend/system_config.json。跨越这条边界时新位置没有文件，
历史版本会**静默回落出厂默认值**：课程只剩「人工智能」、APPID / 知识库 / 版本号全空。
2d6f69c 把本脚本删掉换成页面操作，但"应用本身起不来"就没有出路了，现恢复并加强。

关键判据：默认值同样是 111 个键、约 5KB，**看大小和键数分不出好坏**。
本脚本按指纹打分：APPID 有没有值、版本号是不是通用版、知识库配过没有、课程几门。

用法
----
    python ops/restore_system_config.py                       # 只体检，不动文件
    python ops/restore_system_config.py --data-dir "%%APPDATA%%\\smartkbs-desktop"     # 桌面版
    python ops/restore_system_config.py --apply               # 用推荐的那份恢复
    python ops/restore_system_config.py --apply --from config_history/system_config.json.20261103_180000.123.json
    python ops/restore_system_config.py --apply --force       # 当前那份已最健康也强制覆盖

恢复前一定把现场另存为 system_config.json.before-restore.<时间戳>。
Web 版恢复后 1~2 秒生效（mtime 缓存自动失效）；桌面版建议重启应用。
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

CODE_ROOT = Path(__file__).resolve().parent.parent
FACTORY_EDITION = "通用版"

#: 候选位置（按可信度）：数据根 / 滚动历史 / .bak / 各类备份目录 / 旧代码目录位置
def candidate_roots(data_dir: Path) -> list[Path]:
    return [data_dir, CODE_ROOT]


def collect(data_dir: Path) -> list[Path]:
    found: list[Path] = []
    for root in candidate_roots(data_dir):
        patterns = [
            "system_config.json",
            "system_config.json.bak",
            "system_config.json.before-restore.*",
            "system_config.json.before-upgrade-restore.*",
            "system_config.json.replaced-by-migration.*",
            "config_history/system_config.json.*.json",
            "backend/system_config.json",
            "backend/system_config.json.bak",
            ".upgrade_backups/*/protected/system_config*.json",
            "db_backups/system_config*.json",
        ]
        for pat in patterns:
            for hit in sorted(glob.glob(str(root / pat)), reverse=True)[:40]:
                found.append(Path(hit))
    uniq: list[Path] = []
    seen: set = set()
    for p in found:
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key in seen or not p.is_file():
            continue
        seen.add(key)
        uniq.append(p)
    return uniq


def load(p: Path) -> dict | None:
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def score(data: dict) -> tuple[int, list[str]]:
    s = 0
    hits: list[str] = []
    if str(data.get("APPID") or "").strip():
        s += 5
        hits.append("APPID 有值")
    edition = str(data.get("AGENT_EDITION") or "").strip()
    if edition and edition != FACTORY_EDITION:
        s += 3
        hits.append(f"版本={edition}")
    if str(data.get("KB_AGENT_ID") or "").strip():
        s += 3
        hits.append("知识库已配")
    subjects = data.get("SUBJECTS")
    if isinstance(subjects, list) and len(subjects) > 1:
        s += 3
        hits.append(f"课程 {len(subjects)} 门")
    scene = data.get("skill_scene_map")
    if isinstance(scene, dict) and len(scene) > 2:
        s += 2
        hits.append(f"场景映射 {len(scene)} 项")
    for key in ("TTS_ENABLED", "ENABLE_MULTIMODAL", "AGENT_ENABLED", "ENABLE_REQUEST_LIMIT"):
        if data.get(key) is True:
            s += 1
    return s, hits


def is_factory(data: dict) -> bool:
    """身份类字段全空 + 课程仍是单门默认 —— 与后端判据保持一致"""
    if not isinstance(data, dict) or not data:
        return True
    empty = (not str(data.get("APPID") or "").strip()
             and not str(data.get("KB_AGENT_ID") or "").strip()
             and str(data.get("AGENT_EDITION") or "").strip() in ("", FACTORY_EDITION))
    subjects = data.get("SUBJECTS")
    return bool(empty and (not isinstance(subjects, list) or len(subjects) <= 1))


def main() -> int:
    ap = argparse.ArgumentParser(description="系统配置体检 / 恢复")
    ap.add_argument("--data-dir", default=os.environ.get("SMARTKB_DATA_DIR") or "",
                    help="用户数据目录（桌面版传 %%APPDATA%%\\smartkbs-desktop）")
    ap.add_argument("--apply", action="store_true", help="写入恢复（默认只体检）")
    ap.add_argument("--from", dest="src", default="", help="指定用哪一份恢复（相对数据根或绝对路径）")
    ap.add_argument("--force", action="store_true", help="当前那份已最健康也强制覆盖")
    args = ap.parse_args()

    data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else CODE_ROOT
    target = data_dir / "system_config.json"
    print(f"数据根：{data_dir}")
    print(f"当前配置：{target}{'（存在）' if target.is_file() else '（不存在 —— 正在用出厂默认值运行）'}")

    rows = []
    for p in collect(data_dir):
        cfg = load(p)
        if cfg is None:
            rows.append((-99, p, "JSON 解析失败", [], False))
            continue
        sc, hits = score(cfg)
        rows.append((sc, p, f"{len(cfg)} 键", hits, is_factory(cfg)))
    rows.sort(key=lambda r: (r[0], r[1].stat().st_mtime), reverse=True)

    cur_score, cur_is_factory = -1, True
    cur_cfg = load(target)
    if cur_cfg is not None:
        cur_score, _ = score(cur_cfg)
        cur_is_factory = is_factory(cur_cfg)

    print("\n候选副本（按健康分）：")
    for sc, p, note, hits, factory in rows[:20]:
        try:
            shown = str(p.relative_to(data_dir)) if p.is_relative_to(data_dir) else str(p)
        except Exception:
            shown = str(p)
        mark = "★" if sc == rows[0][0] else " "
        flag = "疑似出厂默认" if factory else "像真实配置"
        st = p.stat()
        print(f" {mark} [{sc:>3}] {shown:<62} {flag:<12} "
              f"{time.strftime('%Y-%m-%d %H:%M', time.localtime(st.st_mtime))} "
              f"{st.st_size / 1024:.1f}KB {note} {'、'.join(hits[:4])}")
    if not rows:
        print("  （一个候选都没找到 —— 先确认 --data-dir 是否指对了）")
        return 1

    best = rows[0]
    print(f"\n当前生效那份健康分：{cur_score}{'（出厂默认值）' if cur_is_factory else ''}")
    print(f"推荐：{best[1]}（健康分 {best[0]}）")

    if not args.apply:
        print("\n只体检模式，未改动任何文件。要恢复请加 --apply")
        return 0

    if args.src:
        src = Path(args.src)
        if not src.is_absolute():
            src = (data_dir / src) if (data_dir / src).is_file() else (CODE_ROOT / src)
    else:
        src = best[1]
    if not src.is_file():
        print(f"源文件不存在：{src}")
        return 1
    src_cfg = load(src)
    if src_cfg is None:
        print("源文件不是合法 JSON，拒绝写入")
        return 1
    if not (src_cfg.get("SUBJECTS") or []):
        print("源文件没有课程列表（SUBJECTS），可能不是系统配置，拒绝写入")
        return 1
    if not args.force and score(load(target) or {})[0] >= best[0] and not cur_is_factory:
        print("当前那份已经是可用的健康配置，未做覆盖（确要覆盖请加 --force）")
        return 0

    if target.exists():
        keep = target.with_name(f"{target.name}.before-restore."
                                f"{datetime.now().strftime('%Y%m%d_%H%M%S')}")
        shutil.copy2(target, keep)
        print(f"现场已留底：{keep}")
    shutil.copy2(src, target)
    os.utime(target, None)
    print(f"✅ 已用 {src} 恢复 {target}")
    print("Web 版 1~2 秒内自动生效；桌面版请重启应用。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
