# -*- coding: utf-8 -*-
"""后端实例守卫: 启动期点名"还有谁在共用同一份 LogFiles 日志"

背景: SizeRotatingHandler 轮转依赖 os.rename, 只要另一个存活进程还持有
backend.log 写句柄, rename 就会 WinError 32 失败, 日志只能原地退避续写、
永不截断。多实例常见来源: uvicorn --reload 双代并存、桌面端与源码实例同时
运行、看门狗反复拉起新进程。

本模块只"点名"不"动手": 启动时把当前 pid 写入 LogFiles/backend-instance.pid,
若旧 pid 仍存活则打 WARNING(不杀任何进程)。真正的单实例约束应由启动器/部署负责。
"""
import ctypes
import logging
import os
import sys
import time

from backend.config import LOG_FILES_DIR
from backend.logger import logger

PID_FILENAME = "backend-instance.pid"


def _process_alive(pid: int) -> bool:
    """探活。Windows 禁用 os.kill(pid, 0): 非 CTRL_* 信号会走 TerminateProcess(等于杀进程)。"""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return False
            kernel32.CloseHandle(handle)
            return True
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _pid_path() -> str:
    return os.path.join(str(LOG_FILES_DIR), PID_FILENAME)


def check_and_write():
    """读旧 pid 文件返回疑似存活的其他 pid 列表, 并把当前 pid 写回(覆盖)。尽力而为, 不抛错。"""
    others = []
    path = _pid_path()
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                tokens = f.read().split()
            if tokens:
                try:
                    old_pid = int(tokens[0])
                except ValueError:
                    old_pid = -1
                if old_pid > 0 and old_pid != os.getpid() and _process_alive(old_pid):
                    others.append(old_pid)
    except OSError:
        pass
    try:
        os.makedirs(str(LOG_FILES_DIR), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"{os.getpid()} {int(time.time())} {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    except OSError:
        pass
    return others


_LOCK_HANDLE = None
_LOCK_ACQUIRED = False


def _detach_file_handler() -> None:
    """摘掉 smartkb logger 的文件 handler(控制台照常), 本进程从此不碰 backend.log"""
    try:
        lg = logging.getLogger("smartkb")
        for h in list(lg.handlers):
            if isinstance(h, logging.FileHandler):
                lg.removeHandler(h)
                try:
                    h.close()
                except Exception:
                    pass
    except Exception:
        pass


def enforce_log_writer_exclusion() -> bool:
    """单写者保证: 用 OS 文件锁(Windows=msvcrt 区域锁, POSIX=flock)独占 backend.lock。

    拿不到锁 = 别的进程已经认领了 backend.log 的写入权。两边同时写会让 rename
    永久失败, 5MB 自动轮转卡死 —— 所以本进程直接停用文件日志(只发控制台),
    服务本身不受影响。逃生门: SMARTKB_ALLOW_MULTI_INSTANCE=1。
    """
    global _LOCK_HANDLE, _LOCK_ACQUIRED
    if _LOCK_ACQUIRED:
        return True
    if os.environ.get("SMARTKB_ALLOW_MULTI_INSTANCE", "").strip() not in ("", "0"):
        return True
    path = os.path.join(str(LOG_FILES_DIR), "backend.lock")
    handle = None
    try:
        handle = open(path, "a+", encoding="utf-8")
        if sys.platform == "win32":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass
        _detach_file_handler()
        logger.warning(
            "[实例守卫] 另一实例已持有日志写入权(backend.lock), 本进程自动降级为仅控制台日志; "
            "以此保证 backend.log 单写者、5MB 自动轮转不被互锁。如需多实例同写文件, "
            "设 SMARTKB_ALLOW_MULTI_INSTANCE=1"
        )
        return False
    except Exception as e:
        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass
        logger.warning(f"[实例守卫] 日志写入权检查异常(忽略, 照常启用文件日志): {e}")
        return True
    _LOCK_HANDLE, _LOCK_ACQUIRED = handle, True
    logger.debug(f"[实例守卫] 已取得日志文件写入权, 单写者成立 (pid={os.getpid()})")
    return True


def warn_multi_instance():
    """启动流程调用: 发现其他疑似存活实例则 WARNING, 正常则 DEBUG 记一笔。"""
    others = check_and_write()
    if others:
        logger.warning(
            f"[实例守卫] 启动时发现 pid={others} 疑似仍存活并共用 LogFiles 日志; "
            "多实例会导致 backend.log 轮转退避(不截断)与数据库锁重试, 请收敛为单实例"
        )
    else:
        logger.debug(f"[实例守卫] 未发现其他实例, 当前 pid={os.getpid()}")
    return others
