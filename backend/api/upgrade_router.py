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
GIT_DOWNLOAD_URL = "https://git-scm.com/downloads/win"
REMOTE_REPO_URL = "https://github.com/youufis/SmartKBS.git"

# Git 常见错误 → 中文解决方案
GIT_ERROR_TIPS: dict[str, str] = {
    "not a git repository": (
        "部署目录没有 Git 仓库。重新点击「增量升级」系统将自动初始化。\n"
        "（仅创建 .git 目录和配置远程，不会修改当前运行的文件）"
    ),
    "does not appear to be a git repository": (
        "Git 远程仓库未配置。重新点击「增量升级」系统将自动修复。"
    ),
    "Could not read from remote repository": "无法连接 GitHub，服务器网络可能被防火墙拦截。",
    "Connection refused": "连接 GitHub 被拒绝（端口 443），请检查防火墙设置。",
    "Could not connect to server": "无法连接到 GitHub.com，请检查服务器网络。",
    "Failed to connect": "无法连接到 GitHub.com，请检查服务器网络或代理设置。",
    "Timeout": "连接 GitHub 超时，请检查网络或稍后重试。",
    "Permission denied (publickey)": (
        "SSH 密钥认证失败。请改用 HTTPS 远程地址：\n"
        f"  git remote set-url origin {REMOTE_REPO_URL}"
    ),
    "Authentication failed": "Git 身份验证失败。请检查凭据配置。",
    "filename too long": (
        "文件名过长。请执行一次以下命令后重试：\n"
        "  git config --system core.longpaths true"
    ),
    "Connection was reset": "连接被重置，可能是网络不稳定或防火墙中断了连接。",
}


def _git_setup_repo() -> None:
    """仅初始化 .git 目录 + 配置远程仓库，不修改任何工作文件"""
    git_dir = BASE_DIR / ".git"
    if not git_dir.exists():
        _run_subprocess_sync(["git", "init"], cwd=str(BASE_DIR), timeout=10)

    # 检查并配置 remote（仅当缺失时添加）
    env = os.environ.copy()
    env["GIT_DIR"] = str(git_dir)
    env["GIT_WORK_TREE"] = str(BASE_DIR)
    r = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        capture_output=True, timeout=5, stdin=subprocess.DEVNULL,
        cwd=str(BASE_DIR), env=env,
    )
    if r.returncode != 0:
        _run_subprocess_sync(
            ["git", "remote", "add", "origin", REMOTE_REPO_URL],
            cwd=str(BASE_DIR), timeout=10, env=env,
        )


def _run_subprocess_sync(
    cmd: list[str],
    *,
    cwd: str = str(BASE_DIR),
    timeout: int = 120,
    env: dict[str, str] | None = None,
) -> str:
    """同步执行子进程（不在线程池，用于预检和初始化场景）"""
    kw: dict[str, Any] = dict(
        cwd=cwd, timeout=timeout,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        startupinfo=_make_startupinfo(),
    )
    if platform.system() == "Windows":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    if env:
        kw["env"] = env
    result = subprocess.run(cmd, **kw)
    if result.returncode != 0:
        msg = result.stderr.decode().strip() if result.stderr else "未知错误"
        raise RuntimeError(f"{' '.join(cmd)} 失败: {msg}")
    return result.stdout.decode().strip() if result.stdout else ""


def _check_git_installed() -> bool:
    """检测 Git 是否已安装（在 PATH 中可找到）"""
    try:
        result = subprocess.run(
            ["git", "--version"],
            capture_output=True, timeout=5,
            stdin=subprocess.DEVNULL,
        )
        return result.returncode == 0
    except Exception:
        return False


def _check_git_env() -> list[str]:
    """预检 Git 环境，返回所有问题（空列表=一切正常）"""
    issues: list[str] = []

    # 1. Git 是否安装
    if not _check_git_installed():
        issues.append(
            "未检测到 Git 命令。请先安装 Git：\n"
            f"  下载地址：{GIT_DOWNLOAD_URL}\n"
            "  安装后需回收 IIS 应用池使 PATH 生效。"
        )
        return issues  # 后续检查依赖 git，直接返回

    # 2. .git 目录是否存在
    git_dir = BASE_DIR / ".git"
    if not git_dir.exists():
        issues.append(
            "部署目录没有 Git 仓库，无法执行升级。\n"
            "请先在服务器上执行以下命令初始化：\n"
            f"  cd {BASE_DIR}\n"
            "  git init\n"
            f"  git remote add origin {REMOTE_REPO_URL}\n"
            "  git fetch origin master\n"
            "  git reset --hard origin/master"
        )
        return issues

    # 3. remote origin 是否配置（和 _run_git 一样设置 GIT_DIR/GIT_WORK_TREE）
    try:
        env = os.environ.copy()
        env["GIT_DIR"] = str(BASE_DIR / ".git")
        env["GIT_WORK_TREE"] = str(BASE_DIR)
        r = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, timeout=5, stdin=subprocess.DEVNULL,
            cwd=str(BASE_DIR), env=env,
        )
        if r.returncode != 0:
            issues.append(
                "Git 远程仓库 (origin) 未配置。请执行：\n"
                f"  cd {BASE_DIR}\n"
                f"  git remote add origin {REMOTE_REPO_URL}"
            )
    except Exception as e:
        issues.append(f"无法检查 Git 远程配置: {e}")

    return issues

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
    git_available: bool = True
    git_download_url: str = ""  # Git 未安装时提供下载链接
    git_issues: list[str] = []  # Git 环境问题列表（中文提示）


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

def _make_startupinfo() -> subprocess.STARTUPINFO | None:
    """Windows 下创建隐藏窗口的 startupinfo（避免弹控制台窗口）"""
    if platform.system() == "Windows":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = subprocess.SW_HIDE
        return si
    return None


def _run_subprocess(
    cmd: list[str],
    *,
    cwd: str = str(BASE_DIR),
    timeout: int = 120,
    capture_output: bool = True,
    env: dict[str, str] | None = None,
) -> str:
    """同步执行子进程（统一入口）

    - 始终设置 stdin=DEVNULL，避免 IIS 下父进程 stdin 句柄无效导致 [WinError 6]
    - Windows 下使用 STARTUPINFO 隐藏控制台窗口
    - capture_output=True 时用 PIPE 捕获输出，否则用 DEVNULL
    """
    kw: dict[str, Any] = dict(
        cwd=cwd,
        timeout=timeout,
        stdin=subprocess.DEVNULL,  # ← 关键：不继承父进程可能无效的 stdin
        startupinfo=_make_startupinfo(),
    )
    if platform.system() == "Windows":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    if capture_output:
        kw["stdout"] = subprocess.PIPE
        kw["stderr"] = subprocess.PIPE
    else:
        kw["stdout"] = subprocess.DEVNULL
        kw["stderr"] = subprocess.DEVNULL
    if env:
        kw["env"] = env

    result = subprocess.run(cmd, **kw)
    if result.returncode != 0:
        msg = result.stderr.decode().strip() if result.stderr else "未知错误"
        error_msg = f"{' '.join(cmd)} 失败: {msg}"
        # 翻译常见 Git 错误为用户友好的中文提示
        for keyword, tip in GIT_ERROR_TIPS.items():
            if keyword.lower() in msg.lower():
                error_msg += f"\n\n💡 {tip}"
                break
        raise RuntimeError(error_msg)
    return result.stdout.decode().strip() if result.stdout else ""



async def _run_git(args: list[str], timeout: int = 120, capture_output: bool = True) -> str:
    """执行 Git 命令（subprocess.run + asyncio.to_thread）"""
    def _run() -> str:
        return _run_subprocess(
            ["git", *args],
            cwd=str(BASE_DIR),
            timeout=timeout,
            capture_output=capture_output,
            env=_make_git_env(),
        )
    try:
        return await asyncio.to_thread(_run)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Git 命令超时 ({timeout}s): {' '.join(args)}")


async def _run_cmd(cmd: list[str], cwd: str, timeout: int = 120, capture_output: bool = True) -> str:
    """执行任意 shell 命令（subprocess.run + asyncio.to_thread）"""
    def _run() -> str:
        return _run_subprocess(cmd, cwd=cwd, timeout=timeout, capture_output=capture_output)
    try:
        return await asyncio.to_thread(_run)
    except subprocess.TimeoutExpired:
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


def _is_running_under_iis() -> bool:
    """检测是否运行在 IIS httpPlatform 下"""
    # IIS httpPlatform 会设置 HTTP_PLATFORM_PORT 环境变量
    if os.environ.get("HTTP_PLATFORM_PORT"):
        return True
    # 检查 appcmd.exe 是否存在（IIS 管理工具）
    appcmd = os.path.expandvars("%windir%\\system32\\inetsrv\\appcmd.exe")
    return os.path.isfile(appcmd)


async def _restart_service():
    """重启服务：自动检测 IIS 或 uvicorn 模式"""
    if _is_running_under_iis():
        appcmd = os.path.expandvars("%windir%\\system32\\inetsrv\\appcmd.exe")
        try:
            await _run_cmd(
                # IIS 应用池名称可通过环境变量 SMARTKB_APP_POOL 自定义，默认 SmartKBS
                [appcmd, "recycle", "apppool",
                 f"/apppool.name:{os.environ.get('SMARTKB_APP_POOL', 'SmartKBS')}"],
                cwd=str(BASE_DIR), timeout=15, capture_output=False,
            )
            logger.info("IIS 应用池已回收，服务重启完成")
            return
        except Exception as e:
            logger.warning(f"IIS appcmd 回收失败: {e}")

    # uvicorn 模式
    # 检查是否启用了 --reload (文件变动自动重启)
    import sys as _sys
    has_reload = any("--reload" in a for a in _sys.argv)
    if has_reload:
        logger.info("检测到 uvicorn --reload 模式，服务将自动检测文件变更重启")
        return

    # 尝试通过 taskkill 仅杀当前端口的 uvicorn 进程
    try:
        from backend.config import SERVER_PORT
        port = SERVER_PORT
        # 用 PowerShell 查找占用指定端口的进程并终止
        ps_cmd = [
            "powershell", "-Command",
            f"Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue "
            f"| Select-Object -ExpandProperty OwningProcess "
            f"| ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}"
        ]
        await _run_cmd(ps_cmd, cwd=str(BASE_DIR), timeout=10, capture_output=False)
        logger.info(f"已终止占用端口 {port} 的进程（uvicorn 将自动退出）")
    except Exception:
        logger.warning("无法自动重启服务，请手动重启 uvicorn 使新代码生效")


async def _fetch_remote_version() -> dict[str, Any] | None:
    """从 GitHub 获取 version.json 元数据"""
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as c:
            resp = await c.get(REMOTE_VERSION_URL)
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.warning(f"获取远程版本信息失败: {e}")
    return None


async def _count_behind() -> int:
    """获取远程最新并计算落后 commit 数（用于升级前确认）"""
    try:
        await _run_git(["fetch", "--all"], timeout=120)
        out = await _run_git(
            ["rev-list", "--count", "HEAD..origin/master"], timeout=30
        )
        return int(out)
    except Exception:
        return -1


def _make_git_env() -> dict[str, str]:
    """构建统一的 Git 环境变量"""
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    temp_dir = str(BASE_DIR / "Temp")
    env.setdefault("HOME", temp_dir)
    env.setdefault("USERPROFILE", temp_dir)
    env["GIT_DIR"] = str(BASE_DIR / ".git")
    env["GIT_WORK_TREE"] = str(BASE_DIR)
    return env


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

    git_ok = _check_git_installed()
    git_issues = _check_git_env() if git_ok else []
    auto_setup = _can_auto_setup() if git_ok else False
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
            git_available=git_ok,
            git_download_url="https://git-scm.com/downloads/win" if not git_ok else "",
        )

    latest = remote.get("latest_version", current)

    # 先执行 git fetch 刷新本地 ref，确保能检测到同版本内的新提交
    behind = 0
    if git_ok and not git_issues:
        try:
            await _run_git(["fetch", "--all"], timeout=120)
            out = await _run_git(
                ["rev-list", "--count", "HEAD..origin/master"], timeout=30
            )
            behind = int(out) if out else 0
        except Exception:
            behind = -1

    # 有更新条件：版本号不同 或 同版本内有新提交（热修复）
    version_changed = latest != current
    has_update = version_changed or (behind > 0)

    return VersionCheckResult(
        current_version=current,
        latest_version=latest,
        has_update=has_update,
        changelog=remote.get("changelog", []),
        breaking_changes=remote.get("breaking_changes", []),
        release_date=remote.get("release_date", ""),
        behind_commits=behind,
        last_checked=datetime.now(timezone.utc).isoformat(),
        git_available=git_ok,
        git_download_url="https://git-scm.com/downloads/win" if not git_ok else "",
        git_issues=git_issues,
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

    # ── 预检并自动修复 Git 环境 ──
    git_issues = _check_git_env()
    if git_issues:
        if _can_auto_setup():
            try:
                _git_setup_repo()
                logger.info("Git 仓库已自动初始化（git init + remote add）")
                # 修复后重新验证
                remaining = _check_git_env()
                if remaining:
                    raise HTTPException(status_code=500,
                        detail="Git 环境自动修复后仍存在问题，请手动处理：\n" + "\n".join(remaining))
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Git 自动初始化失败: {e}")
        else:
            # 不可自动修复（如 Git 未安装），给用户明确指引
            raise HTTPException(status_code=400, detail="\n\n".join(git_issues))

    # 检查是否有可更新的内容（版本不同 或 同版本内有新提交）
    remote = await _fetch_remote_version()
    if remote is None:
        raise HTTPException(status_code=503, detail="无法连接 GitHub，请稍后重试")
    behind = await _count_behind()
    version_changed = remote.get("latest_version") != APP_VERSION
    if not version_changed and behind <= 0:
        raise HTTPException(status_code=400, detail="已是最新版本，无需升级")

    task_id = uuid.uuid4().hex[:12]
    _state["running"] = True
    _state["task_id"] = task_id
    _state["started_at"] = datetime.now().isoformat()
    _state["error"] = None
    _set_progress("init", "初始化...", 5)

    asyncio.create_task(_upgrade_pipeline(task_id, user["username"], remote))
    return {"status": "started", "task_id": task_id}


async def _upgrade_pipeline(task_id: str, admin: str, remote: dict):
    """升级流水线：全部增量操作（每步单独 try/except 以便精确定位错误）"""
    to_version = remote.get("latest_version", "unknown")
    behind = 0
    try:
        # ── Step 1: git fetch 增量拉取 ──
        _set_progress("fetch", "正在获取远程更新（增量传输差异代码）...", 10)
        logger.info(f"[upgrade] Step 1/7: git fetch --all")
        await _run_git(["fetch", "--all"], timeout=180)
        logger.info(f"[upgrade] Step 1/7: fetch 完成")

        # Step 1b: 计算 commit 数
        behind = int(await _run_git(
            ["rev-list", "--count", "HEAD..origin/master"], timeout=30
        ))
        logger.info(f"[upgrade] 落后 {behind} 个提交")

        # ── Step 2: git reset 快速同步 ──
        _set_progress("sync", f"正在同步 {behind} 个提交的变更到本地...", 30)
        logger.info(f"[upgrade] Step 2/7: git reset --hard origin/master")
        await _run_git(["reset", "--hard", "origin/master"], timeout=60)
        logger.info(f"[upgrade] Step 2/7: reset 完成")

        # ── Step 3: 数据库迁移 ──
        _set_progress("migrate", "执行数据库迁移...", 50)
        logger.info(f"[upgrade] Step 3/7: 数据库迁移")
        try:
            applied = _run_migrations(APP_VERSION, to_version)
            if applied:
                logger.info(f"[upgrade] 数据库迁移完成: {', '.join(applied)}")
        except RuntimeError as e:
            raise RuntimeError(f"数据库迁移失败，将自动回滚: {e}")
        logger.info(f"[upgrade] Step 3/7: 迁移完成")

        # ── Step 4: pip install ──
        _set_progress("pip", "正在增量安装 Python 依赖...", 65)
        logger.info(f"[upgrade] Step 4/7: pip install")
        await _run_cmd(
            [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"],
            cwd=str(BASE_DIR), timeout=600,
        )
        logger.info(f"[upgrade] Step 4/7: pip 完成")

        # ── Step 5: 重载模块版本 ──
        try:
            import backend.config as cfg
            cfg.APP_VERSION = to_version
        except Exception:
            pass
        logger.info(f"[upgrade] Step 5/7: 版本号已更新")

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
            "changelog": remote.get("changelog", []),
        })
        _save_state(s)
        logger.info(f"[upgrade] Step 6/7: 历史已记录")

        # ── Step 7: 重启服务 ──
        _set_progress("restart", "正在重启服务（短暂离线）...", 95)
        logger.info(f"[upgrade] Step 7/7: 重启服务")
        await _restart_service()

        _set_progress("done", f"✅ 升级完成！{APP_VERSION} → {to_version}（{behind} 个提交）", 100)
        _state["running"] = False
        logger.info(f"[upgrade] 在线增量升级成功: {APP_VERSION} → {to_version}")

    except Exception as e:
        logger.error(f"升级失败: {e}")
        _state["error"] = str(e)
        _state["running"] = False
        _set_progress("failed", f"❌ 升级失败: {e}", -1)

        # 自动回滚：利用 git reflog 回到升级前的 HEAD
        logger.warning("升级失败，自动执行 git reflog 回滚...")
        try:
            await _run_git(["reset", "--hard", "HEAD@{1}"], timeout=60)
            logger.info("git reflog 回滚成功")
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
    """⑤ 回滚：利用 git reflog 回到升级前的 HEAD"""
    user = get_current_user(request)
    require_admin(user)

    try:
        # HEAD@{1} 是执行 git reset --hard origin/master 之前的位置
        await _run_git(["reset", "--hard", "HEAD@{1}"], timeout=60)
        await _restart_service()

        s = _load_state()
        s["history"].append({
            "task_id": f"rollback_{uuid.uuid4().hex[:8]}",
            "action": "rollback",
            "timestamp": datetime.now().isoformat(),
            "admin": user["username"],
            "status": "rolled_back",
        })
        _save_state(s)
        return {"status": "ok", "message": "回滚完成，服务已重启，请刷新页面"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"回滚失败: {str(e)}")


@router.post("/cancel")
async def cancel_upgrade(request: Request):
    """强制重置升级状态（当升级卡死时使用）"""
    user = get_current_user(request)
    require_admin(user)

    was_running = _state["running"]
    old_step = _state["step"]
    _state["running"] = False
    _state["task_id"] = None
    _state["step"] = ""
    _state["progress"] = 0
    _state["message"] = ""
    _state["error"] = None
    _state["started_at"] = None

    logger.warning(f"管理员 {user['username']} 强制重置了升级状态 (之前: running={was_running}, step={old_step})")

    return {
        "status": "ok",
        "message": "升级状态已重置",
        "was_running": was_running,
    }


def _can_auto_setup() -> bool:
    """判断是否可以一键初始化 Git 仓库（Git 已安装，但 .git 或 remote 缺失）"""
    if not _check_git_installed():
        return False
    git_dir = BASE_DIR / ".git"
    if not git_dir.exists():
        return True
    # .git 存在但 remote 缺失
    try:
        env = os.environ.copy()
        env["GIT_DIR"] = str(git_dir)
        r = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, timeout=5, stdin=subprocess.DEVNULL,
            cwd=str(BASE_DIR), env=env,
        )
        return r.returncode != 0
    except Exception:
        return False


@router.get("/history")
async def get_upgrade_history(
    request: Request,
    page: int = 1,
    page_size: int = 10,
):
    """⑥ 升级历史记录（支持分页）"""
    user = get_current_user(request)
    require_admin(user)
    s = _load_state()
    all_history = s.get("history", [])
    total = len(all_history)
    # 倒序排列（最新的在前）
    all_history.reverse()
    start = (page - 1) * page_size
    end = start + page_size
    items = all_history[start:end]
    return {
        "history": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.delete("/history/{task_id}")
async def delete_history_item(task_id: str, request: Request):
    """删除单条升级历史记录"""
    user = get_current_user(request)
    require_admin(user)
    s = _load_state()
    history = s.get("history", [])
    new_history = [h for h in history if h.get("task_id") != task_id]
    if len(new_history) == len(history):
        raise HTTPException(status_code=404, detail="记录不存在")
    s["history"] = new_history
    _save_state(s)
    return {"status": "ok", "message": "已删除"}
