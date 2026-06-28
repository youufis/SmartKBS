"""
在线增量升级管理 API
利用 Git 增量拉取实现可靠在线升级，支持备份/升级/回滚/数据库迁移
"""
import asyncio
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user, require_admin
from backend.config import APP_VERSION, BASE_DIR
from backend.logger import logger

router = APIRouter()

# ── 常量 ──
REMOTE_VERSION_URL = "https://raw.githubusercontent.com/youufis/SmartKBS/master/version.json"
BACKUP_DIR = BASE_DIR / ".upgrade_backups"
STATE_FILE = BASE_DIR / ".upgrade_state.json"
MIGRATIONS_DIR = BASE_DIR / "backend" / "migrations"

# 所有运行时数据（数据库、配置、上传文件等）已在 .gitignore 中，
# git reset --hard 不会影响它们，无需额外保护

# ── 运行时状态 ──
_state: dict[str, Any] = {
    "running": False,
    "task_id": None,
    "step": "",
    "progress": 0,
    "message": "",
    "started_at": None,
    "error": None,
}


# ═══════════════════════════════════════════════════════
#  数据模型
# ═══════════════════════════════════════════════════════

class VersionCheckResult(BaseModel):
    current_version: str
    latest_version: str
    has_update: bool
    changelog: list[str]
    breaking_changes: list[str]
    release_date: str
    behind_commits: int = 0
    last_checked: str = ""


class UpgradeProgress(BaseModel):
    running: bool
    task_id: str | None
    step: str
    progress: int
    message: str
    error: str | None
    started_at: str | None


# ═══════════════════════════════════════════════════════
#  内部工具函数
# ═══════════════════════════════════════════════════════

async def _run_git(args: list[str], timeout: int = 120, capture_output: bool = True) -> str:
    """执行 Git 命令

    - capture_output=True: 返回 stdout（用于 fetch、rev-list 等需要输出的命令）
    - capture_output=False: stdout/stderr 指向 DEVNULL（用于 archive -o 等写入文件的命令）
    设置 GIT_TERMINAL_PROMPT=0 防止 git 因需要认证而挂起等待输入
    """
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    kw: dict[str, Any] = dict(
        cwd=str(BASE_DIR),
        env=env,
    )
    if platform.system() == "Windows":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    if capture_output:
        kw["stdout"] = asyncio.subprocess.PIPE
        kw["stderr"] = asyncio.subprocess.PIPE
    else:
        kw["stdout"] = asyncio.subprocess.DEVNULL
        kw["stderr"] = asyncio.subprocess.DEVNULL
    proc = await asyncio.create_subprocess_exec("git", *args, **kw)
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        if proc.returncode != 0:
            msg = stderr.decode().strip() if stderr else "未知错误"
            raise RuntimeError(f"git {' '.join(args)} 失败: {msg}")
        return stdout.decode().strip() if stdout else ""
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"Git 命令超时 ({timeout}s): {' '.join(args)}")


async def _run_cmd(cmd: list[str], cwd: str, timeout: int = 120, capture_output: bool = True) -> str:
    """执行任意 shell 命令
    capture_output=False 时 stdout/stderr 指向 DEVNULL（用于不需要输出的命令）
    """
    kw: dict[str, Any] = dict(cwd=cwd)
    if platform.system() == "Windows":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    if capture_output:
        kw["stdout"] = asyncio.subprocess.PIPE
        kw["stderr"] = asyncio.subprocess.PIPE
    else:
        kw["stdout"] = asyncio.subprocess.DEVNULL
        kw["stderr"] = asyncio.subprocess.DEVNULL
    proc = await asyncio.create_subprocess_exec(*cmd, **kw)
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        if proc.returncode != 0:
            msg = stderr.decode().strip() if stderr else "未知错误"
            raise RuntimeError(f"{' '.join(cmd)} 失败: {msg}")
        return stdout.decode().strip() if stdout else ""
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"命令超时 ({timeout}s): {' '.join(cmd)}")


def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"history": [], "current_backup": None}


def _save_state(s: dict):
    STATE_FILE.write_text(
        json.dumps(s, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _set_progress(step: str, message: str, progress: int):
    _state["step"] = step
    _state["message"] = message
    _state["progress"] = progress


async def _restart_service():
    """重启服务：优先 IIS appcmd，备选 taskkill（均无需捕获输出）"""
    appcmd = os.path.expandvars("%windir%\\system32\\inetsrv\\appcmd.exe")
    try:
        await _run_cmd(
            [appcmd, "recycle", "apppool", "/apppool.name:SmartKBS"],
            cwd=str(BASE_DIR), timeout=15, capture_output=False,
        )
        logger.info("IIS 应用池已回收，服务重启完成")
    except Exception:
        logger.warning("appcmd 回收失败，尝试 taskkill 重启 uvicorn")
        try:
            await _run_cmd(
                ["taskkill", "/f", "/im", "python.exe"],
                cwd=str(BASE_DIR), timeout=10, capture_output=False,
            )
        except Exception:
            logger.warning("taskkill 未找到 python 进程（可能已退出）")


async def _fetch_remote_version() -> dict[str, Any] | None:
    """从 GitHub 获取 version.json 元数据"""
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as c:
            resp = await c.get(REMOTE_VERSION_URL)
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.warning(f"获取远程版本信息失败: {e}")
    return None


async def _count_behind() -> int:
    """计算本地落后 origin/master 的 commit 数"""
    try:
        await _run_git(["fetch", "--all"], timeout=30)
        out = await _run_git(
            ["rev-list", "--count", "HEAD..origin/master"], timeout=15
        )
        return int(out)
    except Exception:
        return -1


def _run_migrations(from_version: str, to_version: str) -> list[str]:
    """按版本顺序执行数据库迁移脚本"""
    applied = []
    if not MIGRATIONS_DIR.exists():
        return applied

    mig_files = sorted(MIGRATIONS_DIR.glob("V*.py"))
    for mig in mig_files:
        ver = mig.stem.lstrip("V").replace("_", ".")
        if _compare_versions(ver, from_version) > 0 and _compare_versions(ver, to_version) <= 0:
            try:
                import importlib.util
                spec = importlib.util.spec_from_file_location(
                    f"migrations.{mig.stem}", mig
                )
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                if hasattr(mod, "migrate"):
                    mod.migrate()
                    applied.append(ver)
                    logger.info(f"数据库迁移 V{ver} 完成")
            except Exception as e:
                logger.error(f"数据库迁移 V{ver} 失败: {e}")
                raise RuntimeError(f"迁移 V{ver} 失败: {e}")
    return applied


def _compare_versions(v1: str, v2: str) -> int:
    """比较两个版本号，>0 表示 v1 > v2
    安全处理非数字后缀（如 "6.7.0-beta" 视为 "6.7.0"）
    """
    def _parse(v: str) -> list[int]:
        parts = []
        for x in v.split("."):
            # 提取数字部分，忽略后缀
            digits = ""
            for ch in x:
                if ch.isdigit():
                    digits += ch
                else:
                    break
            parts.append(int(digits) if digits else 0)
        return parts
    p1 = _parse(v1)
    p2 = _parse(v2)
    for a, b in zip(p1, p2):
        if a != b:
            return a - b
    return len(p1) - len(p2)


# ═══════════════════════════════════════════════════════
#  API 端点
# ═══════════════════════════════════════════════════════

@router.get("/version-check")
async def check_version(request: Request) -> VersionCheckResult:
    """① 检测最新版本（仅 HTTP 获取 version.json，~1KB）"""
    user = get_current_user(request)
    require_admin(user)

    remote = await _fetch_remote_version()
    current = APP_VERSION

    if remote is None:
        return VersionCheckResult(
            current_version=current,
            latest_version=current,
            has_update=False,
            changelog=[],
            breaking_changes=[],
            release_date="",
        )

    latest = remote.get("latest_version", current)
    has_update = latest != current
    behind = await _count_behind() if has_update else 0

    return VersionCheckResult(
        current_version=current,
        latest_version=latest,
        has_update=has_update,
        changelog=remote.get("changelog", []),
        breaking_changes=remote.get("breaking_changes", []),
        release_date=remote.get("release_date", ""),
        behind_commits=behind,
        last_checked=datetime.now(timezone.utc).isoformat(),
    )


@router.post("/backup")
async def create_backup(request: Request):
    """② 升级前备份源码和关键数据"""
    user = get_current_user(request)
    require_admin(user)

    if _state["running"]:
        raise HTTPException(status_code=409, detail="已有升级任务运行中")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = BACKUP_DIR / f"pre_upgrade_{timestamp}"
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    try:
        # 用 git archive 备份跟踪的文件（轻量、快速，输出到文件无需捕获）
        tar_path = backup_path.with_suffix(".tar")
        await _run_git(["archive", "-o", str(tar_path), "HEAD"], timeout=30, capture_output=False)

        # 额外备份数据库和配置（虽在 .gitignore 中，但很重要）
        prot_dir = backup_path / "protected"
        prot_dir.mkdir(parents=True, exist_ok=True)
        for rel in ["backend/smartkb.db", "backend/system_config.json", "backend/.node_id"]:
            src = BASE_DIR / rel
            if src.exists():
                try:
                    shutil.copy2(src, prot_dir / src.name)
                except Exception as copy_err:
                    logger.warning(f"备份 {rel} 跳过: {copy_err}")

        s = _load_state()
        s["current_backup"] = {
            "path": str(backup_path),
            "tar": str(tar_path),
            "version": APP_VERSION,
            "created_at": timestamp,
            "admin": user["username"],
        }
        _save_state(s)

        logger.info(f"升级备份完成: {backup_path}")
        return {"status": "ok", "backup_path": str(backup_path), "version": APP_VERSION}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"备份失败: {str(e)}")


@router.post("/run")
async def start_upgrade(request: Request):
    """③ 启动增量升级（后台异步执行）"""
    user = get_current_user(request)
    require_admin(user)

    if _state["running"]:
        raise HTTPException(status_code=409, detail="已有升级任务运行中")

    # 先检查远程版本
    remote = await _fetch_remote_version()
    if remote is None:
        raise HTTPException(status_code=503, detail="无法连接 GitHub，请稍后重试")
    if remote.get("latest_version") == APP_VERSION:
        raise HTTPException(status_code=400, detail="已是最新版本，无需升级")

    # 自动备份
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = BACKUP_DIR / f"pre_upgrade_{timestamp}"
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    try:
        tar_path = backup_path.with_suffix(".tar")
        # archive 输出到文件，无需捕获 stdout
        await _run_git(["archive", "-o", str(tar_path), "HEAD"], timeout=30, capture_output=False)
        prot_dir = backup_path / "protected"
        prot_dir.mkdir(parents=True, exist_ok=True)
        # 数据库可能在运行中被锁定，尝试复制但不阻塞升级
        for rel in ["backend/smartkb.db", "backend/system_config.json"]:
            src = BASE_DIR / rel
            if src.exists():
                try:
                    shutil.copy2(src, prot_dir / src.name)
                except Exception as copy_err:
                    logger.warning(f"备份 {rel} 跳过（文件可能被锁定）: {copy_err}")
        s = _load_state()
        s["current_backup"] = {"path": str(backup_path), "version": APP_VERSION}
        _save_state(s)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"预升级备份失败: {str(e)}")

    task_id = uuid.uuid4().hex[:12]
    _state["running"] = True
    _state["task_id"] = task_id
    _state["started_at"] = datetime.now().isoformat()
    _state["error"] = None
    _set_progress("init", "初始化...", 5)

    asyncio.create_task(_upgrade_pipeline(task_id, user["username"], remote))
    return {"status": "started", "task_id": task_id}


async def _upgrade_pipeline(task_id: str, admin: str, remote: dict):
    """升级流水线：全部增量操作"""
    to_version = remote.get("latest_version", "unknown")
    try:
        # ── Step 1: git fetch 增量拉取 ──
        _set_progress("fetch", "正在获取远程更新（增量传输差异代码）...", 10)
        await _run_git(["fetch", "--all"], timeout=60)
        behind = int(await _run_git(
            ["rev-list", "--count", "HEAD..origin/master"], timeout=15
        ))
        logger.info(f"检测到落后 {behind} 个提交，开始增量同步")

        # ── Step 2: git reset 快速同步 ──
        _set_progress("sync", f"正在同步 {behind} 个提交的变更到本地...", 30)
        await _run_git(["reset", "--hard", "origin/master"], timeout=30)

        # ── Step 3: 数据库迁移 ──
        _set_progress("migrate", "执行数据库迁移...", 50)
        try:
            applied = _run_migrations(APP_VERSION, to_version)
            if applied:
                logger.info(f"数据库迁移完成: {', '.join(applied)}")
        except RuntimeError as e:
            raise RuntimeError(f"数据库迁移失败，将自动回滚: {e}")

        # ── Step 4: pip install ──
        _set_progress("pip", "正在增量安装 Python 依赖...", 65)
        await _run_cmd(
            [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"],
            cwd=str(BASE_DIR), timeout=300,
        )

        # ── Step 5: 重载模块版本（不重启进程） ──
        try:
            import backend.config as cfg
            cfg.APP_VERSION = to_version  # 热更新版本号
        except Exception:
            pass

        # ── Step 6: 记录历史 ──
        s = _load_state()
        s["history"].append({
            "task_id": task_id,
            "from_version": APP_VERSION,
            "to_version": to_version,
            "timestamp": datetime.now().isoformat(),
            "admin": admin,
            "status": "success",
            "commits": behind,
        })
        _save_state(s)

        # ── Step 7: 重启服务 ──
        _set_progress("restart", "正在重启服务（短暂离线）...", 95)
        await _restart_service()

        _set_progress("done", f"✅ 升级完成！{APP_VERSION} → {to_version}（{behind} 个提交）", 100)
        _state["running"] = False
        logger.info(f"在线增量升级成功: {APP_VERSION} → {to_version}")

    except Exception as e:
        logger.error(f"升级失败: {e}")
        _state["error"] = str(e)
        _state["running"] = False
        _set_progress("failed", f"❌ 升级失败: {e}", -1)

        # 自动回滚
        s = _load_state()
        backup = s.get("current_backup")
        if backup:
            logger.warning("升级失败，自动执行回滚...")
            try:
                await _rollback_to(Path(backup["path"]))
                _set_progress("rolled_back", "已自动回滚到升级前状态", -2)
            except Exception as rb_e:
                logger.error(f"自动回滚失败: {rb_e}")
                _set_progress("rollback_failed", f"回滚也失败，请手动处理: {rb_e}", -3)

        s = _load_state()
        s["history"].append({
            "task_id": task_id,
            "from_version": APP_VERSION,
            "to_version": to_version,
            "timestamp": datetime.now().isoformat(),
            "admin": admin,
            "status": "failed",
            "error": str(e),
        })
        _save_state(s)


@router.get("/status")
async def get_status(request: Request) -> UpgradeProgress:
    """④ 轮询升级进度"""
    user = get_current_user(request)
    require_admin(user)
    return UpgradeProgress(**_state)


@router.post("/rollback")
async def rollback(request: Request):
    """⑤ 回滚到最近的备份"""
    user = get_current_user(request)
    require_admin(user)

    s = _load_state()
    backup = s.get("current_backup")
    if not backup:
        raise HTTPException(status_code=404, detail="没有可用的备份")

    backup_path = Path(backup["path"])
    if not backup_path.exists():
        raise HTTPException(status_code=404, detail="备份目录不存在")

    try:
        await _rollback_to(backup_path)

        s["history"].append({
            "task_id": f"rollback_{uuid.uuid4().hex[:8]}",
            "action": "rollback",
            "from_backup": str(backup_path),
            "timestamp": datetime.now().isoformat(),
            "admin": user["username"],
            "status": "rolled_back",
        })
        _save_state(s)
        return {"status": "ok", "message": "回滚完成，服务已重启，请刷新页面"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"回滚失败: {str(e)}")


async def _rollback_to(backup_path: Path):
    """执行回滚：恢复源码 + 数据库 + 重启"""
    tar_file = backup_path.with_suffix(".tar")

    if tar_file.exists():
        # 从 tar 恢复 git 跟踪的文件
        await _run_git(["checkout", "--force", "HEAD"], timeout=15)
        # 用 Python tarfile 模块解压（兼容 Windows，不依赖系统 tar 命令）
        with tarfile.open(str(tar_file), "r") as _tar:
            _tar.extractall(path=str(BASE_DIR))
    else:
        logger.warning("备份 tar 不存在，尝试 git reflog 回退")
        await _run_git(["reset", "--hard", "HEAD@{1}"], timeout=15)

    # 恢复数据库和配置
    prot_dir = backup_path / "protected"
    if prot_dir.exists():
        for f in prot_dir.iterdir():
            shutil.copy2(f, BASE_DIR / "backend" / f.name)

    await _restart_service()


@router.get("/history")
async def get_upgrade_history(request: Request):
    """⑥ 升级历史记录"""
    user = get_current_user(request)
    require_admin(user)
    s = _load_state()
    return {"history": s.get("history", [])}
