# -*- coding: utf-8 -*-
"""数据类文件永不允许被 git 跟踪（升级安全断言）

为什么需要这个脚本
----------------
Git 部署的在线增量升级第一步是 `git reset --hard origin/master`：它只替换**已跟踪**文件，
未跟踪的用户数据不受影响 —— 这是整套升级安全的前提。一旦哪天有人把配置/库/节点身份
提交进仓库，所有 Git 部署机在下一次升级时都会被仓库里那份覆盖，表现成"升级后配置/数据
被重置"，而且**没有任何报错**。已经真发生过一次：backend/.node_id 被提交进仓库，
每台部署机的节点身份都被覆盖成同一份（多机上报串号）。system_config.json 搬回项目根
时差点再来一次。

用法
----
    python ops/check_no_tracked_user_data.py          # 命中即非零退出（打包/发布前跑）
    python ops/check_no_tracked_user_data.py --fix    # 打印可执行的 git rm --cached 命令
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: 这些后缀属于运行期数据，任何时候都不该在版本库里
BAD_SUFFIXES = (".db", ".db-wal", ".db-shm", ".db-journal")
#: 这些文件名是"每台机器各有一份"的配置/身份
BAD_NAMES = {"system_config.json", "system_config.json.bak", "system_config.json.tmp", ".node_id"}
#: 这些一级目录整体是用户内容
BAD_TOPS = {"root", "stu", "question_media", "temp_uploads", "whiteboard_assets",
            "db_backups", "ChatHistory", "LogFiles", ".upgrade_backups", "config_history"}


def tracked_files() -> list[str]:
    r = subprocess.run(["git", "ls-files"], cwd=str(ROOT), capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        print(f"git ls-files 失败：{r.stderr.strip()}")
        sys.exit(2)
    return [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]


def main() -> int:
    fix = "--fix" in sys.argv
    hits: list[str] = []
    for rel in tracked_files():
        norm = rel.replace("\\", "/")
        parts = norm.split("/")
        name = parts[-1]
        if name in BAD_NAMES or norm.endswith(BAD_SUFFIXES) or parts[0] in BAD_TOPS:
            hits.append(norm)
    if not hits:
        print(f"✅ 版本库里没有运行期数据文件（共检查 {len(tracked_files())} 个跟踪文件）")
        return 0
    print(f"❌ 发现 {len(hits)} 个被跟踪的运行期数据文件：")
    for h in hits[:40]:
        print(f"   - {h}")
    if len(hits) > 40:
        print(f"   ... 还有 {len(hits) - 40} 个")
    print("\n后果：Git 部署在线升级的 `git reset --hard` 会用仓库里这份覆盖每台部署机的本机数据。")
    if fix:
        print("\n可执行（保留本机文件、只退出版本库）：")
        for h in hits:
            print(f"   git rm --cached \"{h}\"")
        print("然后把对应路径补进 .gitignore。")
    else:
        print("处理：加 --fix 查看命令，并在 .gitignore 中补上这些路径。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
