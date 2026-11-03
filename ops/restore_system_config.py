# -*- coding: utf-8 -*-
"""系统配置恢复工具（在线升级后配置变默认值时用）

背景
----
v9.0.0 之后配置读 <项目根>/system_config.json；更早版本读 <项目根>/backend/system_config.json。
升级跨越这条边界时，新位置没有文件，历史版本会静默回落出厂默认值：课程只剩「人工智能」、
APPID / 知识库 / 讲演版本号全空。配置文件本身通常还在，只是位置变了或被"保存"覆盖过。

关键：默认值版本同样是 111 个键、也可能有 4 门课程，光看文件大小和键数无法判断好坏。
本脚本用"指纹"打分 —— APPID 是否有值、AGENT_EDITION 是不是通用版、知识库是否配置过。

用法
----
    python ops/restore_system_config.py              # 只体检，不改文件（默认）
    python ops/restore_system_config.py --apply      # 按推荐项恢复
    python ops/restore_system_config.py --apply --from backend/system_config.json.bak
    python ops/restore_system_config.py --apply --force   # 当前已最健康也强制覆盖

恢复前会自动把现有文件另存为 system_config.json.before-restore.<时间戳>。
恢复后无需重建数据库；Web 版等 1~2 秒（mtime 缓存自动失效），桌面版建议重启。
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORAGE = Path(os.environ.get("SMARTKB_DATA_DIR") or ROOT)
CONFIG = STORAGE / "system_config.json"

#: 出厂默认值的指纹值（命中说明这份文件是被重置过的）
DEFAULT_EDITION = "通用版"


def _load(p: Path) -> dict | None:
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def score(data: dict) -> tuple[int, list[str]]:
    """健康度打分，越高越像"真实配置"。返回 (分数, 命中项说明)"""
    s = 0
    hits: list[str] = []
    if str(data.get("APPID") or "").strip():
        s += 5
        hits.append("APPID有值")
    if str(data.get("AGENT_EDITION") or "").strip() not in ("", DEFAULT_EDITION):
        s += 3
        hits.append(f"版本={data.get('AGENT_EDITION')}")
    if str(data.get("KB_AGENT_ID") or "").strip():
        s += 3
        hits.append("知识库已配")
    if isinstance(data.get("skill_scene_map"), dict) and len(data["skill_scene_map"]) > 2:
        s += 2
        hits.append(f"技能场景{len(data['skill_scene_map'])}个")
    for key in ("TTS_ENABLED", "ENABLE_MULTIMODAL", "AGENT_ENABLED", "ENABLE_REQUEST_LIMIT"):
        if data.get(key) is True:
            s += 1
    subjects = data.get("SUBJECTS")
    if isinstance(subjects, list) and len(subjects) > 1:
        s += 1
        hits.append(f"{len(subjects)}门课程")
    s += min(len(data) // 40, 2)          # 键数只作微调，默认值同样是 111 键
    return s, hits


def candidates() -> list[Path]:
    """所有可能藏着真实配置的位置（按可信度粗排，最终以打分为准）"""
    raw: list[Path] = [
        CONFIG,
        CONFIG.with_name(CONFIG.name + ".bak"),
        ROOT / "backend" / "system_config.json",
        ROOT / "backend" / "system_config.json.bak",
    ]
    for pattern in (
        str(ROOT / "system_config.json.bak-*"),                    # 本脚本做的备份
        str(ROOT / "system_config.json.before-restore.*"),         # 人工恢复前的备份
        str(ROOT / "db_backups" / "system_config*.json"),
        str(ROOT / ".upgrade_backups" / "*" / "protected" / "system_config.json"),
        str(ROOT / "backend" / "system_config.json.before-restore.*"),
    ):
        raw.extend(Path(p) for p in sorted(glob.glob(pattern)))
    out, seen = [], set()
    for p in raw:
        try:
            key = p.resolve()
        except OSError:
            continue
        if key in seen or not p.is_file():
            continue
        seen.add(key)
        out.append(p)
    return out


def describe(p: Path) -> dict:
    data = _load(p)
    if data is None:
        return {"path": p, "ok": False, "score": -1, "hits": ["JSON 解析失败"],
                "size": p.stat().st_size, "mtime": p.stat().st_mtime,
                "subjects": 0, "edition": "", "appid": "", "keys": 0}
    s, hits = score(data)
    return {
        "path": p, "ok": True, "score": s, "hits": hits,
        "size": p.stat().st_size, "mtime": p.stat().st_mtime,
        "subjects": len(data.get("SUBJECTS") or []),
        "edition": str(data.get("AGENT_EDITION") or ""),
        "appid": "有" if str(data.get("APPID") or "").strip() else "空",
        "keys": len(data),
    }


def print_table(rows: list[dict], best: dict | None) -> None:
    print(f"{'':2} {'文件':46s} {'大小':>6s}  {'键':>3s} {'课程':>2s} {'APPID':>5s} {'版本':<8s} {'分':>2s}")
    print("-" * 96)
    for r in rows:
        mark = "->" if best and r["path"] == best["path"] else "  "
        rel = str(r["path"]).replace(str(ROOT) + os.sep, "")
        ts = datetime.fromtimestamp(r["mtime"]).strftime("%m-%d %H:%M")
        print(f"{mark} {rel:46s} {r['size']:6d}  {r['keys']:3d} {r['subjects']:2d} "
              f"{r['appid']:>5s} {r['edition']:<8s} {r['score']:2d}  {ts}")
        if r["hits"]:
            print(f"   {'':46s} 命中: {', '.join(r['hits'])}")


def main() -> int:
    ap = argparse.ArgumentParser(description="系统配置恢复工具")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只体检）")
    ap.add_argument("--from", dest="src", help="指定要用哪个文件，如 backend/system_config.json.bak")
    ap.add_argument("--force", action="store_true", help="当前配置已最健康时也强制覆盖")
    args = ap.parse_args()

    print(f"项目根    : {ROOT}")
    print(f"配置目标位: {CONFIG}  ({'存在' if CONFIG.exists() else '不存在'})")
    print()

    rows = [describe(p) for p in candidates()]
    if not rows:
        print("没有找到任何配置文件。请确认部署路径，或从备份/另一台机器拷一份过来。")
        return 1
    usable = [r for r in rows if r["ok"]]
    if not usable:
        print("找到的文件都无法解析为 JSON，请检查是否拷贝过程中损坏。")
        return 1

    best = max(usable, key=lambda r: (r["score"], r["mtime"]))
    print_table(rows, best)
    print()
    current = next((r for r in rows if r["path"] == CONFIG), None)
    print(f"推荐使用: {str(best['path']).replace(str(ROOT) + os.sep, '')}  (分 {best['score']})")
    if current and current["ok"]:
        print(f"当前位置: 分 {current['score']}"
              f"（APPID={current['appid']}, 版本={current['edition']}）")

    if current and current["ok"] and current["score"] >= best["score"] and not args.force:
        print("\n当前位置的配置已经是最健康的一份，无需恢复。")
        print("如果页面仍显示旧值：确认后端进程读的是这个路径（看启动日志的 [配置] 行），")
        print("必要时 touch 一下文件或重启后端，让 mtime 缓存失效。")
        return 0

    src = Path(args.src) if args.src else best["path"]
    if not src.is_absolute():
        src = ROOT / args.src
    if not src.is_file():
        print(f"\n指定文件不存在: {src}")
        return 1
    picked = next((r for r in rows if r["path"] == src), describe(src))
    if not picked["ok"]:
        print(f"\n{src} 不是合法 JSON，已中止。")
        return 1

    if not args.apply:
        print(f"\n[体检模式] 未改动任何文件。执行恢复请加 --apply：")
        print(f"    python ops/restore_system_config.py --apply --from \"{args.src or str(src).replace(str(ROOT) + os.sep, '')}\"")
        return 0

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    if CONFIG.exists():
        keep = CONFIG.with_name(f"{CONFIG.name}.before-restore.{stamp}")
        shutil.copy2(CONFIG, keep)
        print(f"\n已备份当前配置: {keep.name}")
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG.with_name(CONFIG.name + ".tmp")
    shutil.copy2(src, tmp)                      # copy2 保留内容与时间戳
    os.replace(tmp, CONFIG)
    try:                                        # 保证 mtime 变化，让运行中的进程立刻重读
        os.utime(CONFIG, None)
    except OSError:
        pass

    check = _load(CONFIG)
    if check is None:
        print("写入后校验失败，请用上面的备份文件回滚。")
        return 1
    print(f"已写入 {CONFIG}（{len(check)} 键，{len(check.get('SUBJECTS') or [])} 门课程，"
          f"APPID={'有' if str(check.get('APPID') or '').strip() else '空'}，"
          f"版本={check.get('AGENT_EDITION')}）")
    print("\n接下来：")
    print("  1) Web 版等 1~2 秒即可（配置带 mtime 缓存）；桌面版请重启应用")
    print("  2) 浏览器刷新后打开系统配置页复核：APPID / 课程列表 / 知识库是否都回来了")
    print("  3) 如需留档，可在配置页点一次「保存」，让 .bak 也同步为这份内容")
    return 0


if __name__ == "__main__":
    sys.exit(main())
