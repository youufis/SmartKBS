"""
代码沙箱执行引擎

安全地在子进程中运行 Python / JavaScript 代码，支持输入/输出捕获和超时控制。

设计要点（2026-11 重构）：
1. **不阻塞事件循环**：全部走 asyncio 子进程，一个学生跑代码不会卡住全班请求。
2. **有上限的读取**：stdout/stderr 边读边截断，死循环打印也不会把服务端内存吃满。
3. **UTF-8 全链路**：Windows 下显式指定编码，中文输出不再乱码。
4. **逐用例超时**：调用方按题目的 time_limit 传入，不再一律 10 秒。
5. **全局并发闸**：所有运行共享一个信号量，防止几十个学生同时运行把机器打满。

安全策略：
1. AST 静态分析 — 拦截危险 import、危险内置函数与反射逃逸常用的 dunder 属性。
2. subprocess 隔离 — 独立进程 + 临时目录，不污染主进程。
3. 资源限制 — 超时 + 有界输出 + 全局并发上限。

注意：这是「教学级沙箱」，不是强隔离。部署到不可信公网时仍应使用低权限账号 /
容器 / AppContainer 等 OS 级隔离。
"""
import ast
import asyncio
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

from backend.logger import logger

# ── 安全常量 ──

# 危险模块黑名单（禁止导入）
BLOCKED_MODULES: set[str] = {
    'os', 'subprocess', 'shutil', 'sys', 'socket', 'requests',
    'http', 'flask', 'django', 'multiprocessing', 'threading',
    'ctypes', 'signal', 'fcntl', 'tty', 'pty', 'code', 'codeop',
    'importlib', 'pkgutil', 'pdb', 'traceback', 'inspect',
    'pickle', 'shelve', 'marshal', 'base64', 'hashlib',
    'crypt', 'cffi', 'numpy.distutils', 'distutils',
    'urllib', 'xml', 'configparser',
}

# 危险内置函数（禁止直接调用）
# 注意：input 是合法的标准输入函数，子进程已配置 stdin 传入，不应拦截
BLOCKED_FUNCTIONS: set[str] = {
    'eval', 'exec', 'compile', '__import__', 'open',
    'breakpoint', 'globals', 'locals', 'vars',
    'memoryview', 'bytearray', 'callable',
    # 反射逃逸常用入口：本课程里的入门题不需要它们
    'getattr', 'setattr', 'delattr',
}

# 通过 obj.__xxx__ 拿运行时对象的常见逃逸路径
BLOCKED_ATTRS: set[str] = {
    '__class__', '__bases__', '__base__', '__subclasses__', '__mro__',
    '__globals__', '__builtins__', '__dict__', '__code__', '__closure__',
    '__loader__', '__spec__', '__getattribute__', '__reduce__',
    '__reduce_ex__', '__import__',
}

# 这些名字本身就可直达 builtins
BLOCKED_NAMES: set[str] = {'__builtins__', '__loader__', '__spec__', 'builtins'}

# 限制常量
MAX_CODE_LENGTH: int = 50000       # 最大代码长度（字符）
MAX_OUTPUT_CHARS: int = 10000      # 「运行一下」最多回显的字符数
GRADE_OUTPUT_CHARS: int = 200000   # 判题时允许的输出上限（超过按错误处理）
MAX_INPUT_CHARS: int = 20000       # 标准输入上限
MAX_EXECUTION_TIME: int = 10       # 默认单用例超时（秒）
MAX_ALLOWED_TIME: int = 60         # 单用例允许的最大超时（秒）

# 全局判题并发闸：一次最多同时跑多少个用户进程
try:
    _JUDGE_LIMIT = max(1, min(16, int(os.environ.get("CODE_JUDGE_CONCURRENCY", "4"))))
except ValueError:
    _JUDGE_LIMIT = 4
_JUDGE_SEM = asyncio.Semaphore(_JUDGE_LIMIT)

# Node.js 是否可用
NODE_AVAILABLE: bool = shutil.which("node") is not None


# ── AST 静态安全检查 ──

def _safety_check_python(source_code: str) -> tuple[bool, str, str]:
    """对 Python 代码进行静态安全检查

    Returns:
        (is_safe, error_message, error_kind)
        error_kind: '' | 'compile'（语法错误） | 'security'（被拦截）
    """
    if len(source_code) > MAX_CODE_LENGTH:
        return False, f"代码超过最大长度限制（{MAX_CODE_LENGTH} 字符）", "compile"

    try:
        tree = ast.parse(source_code)
    except SyntaxError as e:
        # 语法错误要单独归类：前端显示「编译错误 + 行号」比「运行时错误」有用得多
        line = f"（第 {e.lineno} 行）" if getattr(e, "lineno", None) else ""
        return False, f"语法错误{line}: {e.msg}", "compile"

    for node in ast.walk(tree):
        # ── 拦截 import os / import sys 等 ──
        if isinstance(node, ast.Import):
            for alias in node.names:
                top_module = alias.name.split('.')[0]
                if top_module in BLOCKED_MODULES:
                    return False, f"禁止导入危险模块: {alias.name}", "security"

        # ── 拦截 from os import path / from os.path import * 等 ──
        if isinstance(node, ast.ImportFrom):
            if node.module:
                top_module = node.module.split('.')[0]
                if top_module in BLOCKED_MODULES:
                    return False, f"禁止导入危险模块: {node.module}", "security"
            # ── 拦截星号导入（from xxx import *）──
            if node.names and any(alias.name == '*' for alias in node.names):
                return False, "禁止使用星号导入（import *）", "security"

        # ── 拦截 eval() / exec() / __import__() 等直接调用 ──
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in BLOCKED_FUNCTIONS:
                return False, f"禁止使用危险函数: {node.func.id}", "security"
            # 拦截 obj.eval() / obj.exec() 形式
            if isinstance(node.func, ast.Attribute):
                if node.func.attr in ('eval', 'exec', '__import__'):
                    return False, f"禁止使用危险方法: {node.func.attr}", "security"

        # ── 拦截直接拿内置/加载器对象 ──
        if isinstance(node, ast.Name) and node.id in BLOCKED_NAMES:
            return False, f"禁止访问内部对象: {node.id}", "security"

        # ── 拦截 __class__ / __globals__ 这类反射链 ──
        if isinstance(node, ast.Attribute) and node.attr in BLOCKED_ATTRS:
            return False, f"禁止访问内部属性: {node.attr}", "security"

    return True, "", ""


def get_supported_languages() -> list[dict[str, Any]]:
    """获取当前环境支持的语言列表"""
    languages = [
        {"value": "python", "label": "Python", "available": True},
    ]
    if NODE_AVAILABLE:
        languages.append({"value": "javascript", "label": "JavaScript", "available": True})
    return languages


# ── 子进程公共设施 ──

def _build_env(tmpdir: str) -> dict[str, str]:
    """构造子进程环境变量：保留系统必需项，剔除可能的密钥。"""
    env: dict[str, str] = {}
    for key, value in os.environ.items():
        upper = key.upper()
        if any(token in upper for token in ("KEY", "SECRET", "TOKEN", "PASSWORD", "API_")):
            continue
        # 不让学生通过 PYTHONPATH 摸到仓库里的 backend 模块（里面能读到配置/密钥）
        if upper in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"):
            continue
        env[key] = value
    env.update({
        "HOME": tmpdir,
        "TMPDIR": tmpdir,
        "TEMP": tmpdir,
        "TMP": tmpdir,
        # Windows 上缺少 SYSTEMROOT 会让部分标准库/编码初始化异常
        **({"SYSTEMROOT": os.environ["SYSTEMROOT"]} if os.environ.get("SYSTEMROOT") else {}),
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
    })
    return env


def _clamp_timeout(timeout: Optional[float]) -> float:
    try:
        value = float(timeout) if timeout is not None else float(MAX_EXECUTION_TIME)
    except (TypeError, ValueError):
        value = float(MAX_EXECUTION_TIME)
    return max(0.5, min(float(MAX_ALLOWED_TIME), value))


def _read_capped_sync(stream, limit_bytes: int) -> tuple[bytes, bool]:
    """边读边丢，保证最多只保留 limit_bytes，防止死循环打印把内存吃满。"""
    chunks: list[bytes] = []
    size = 0
    truncated = False
    try:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            if size < limit_bytes:
                take = chunk[: limit_bytes - size]
                chunks.append(take)
                size += len(take)
                if len(take) < len(chunk):
                    truncated = True
            else:
                truncated = True
    except Exception:
        pass
    return b"".join(chunks), truncated


def _feed_stdin_sync(proc, data: bytes) -> None:
    try:
        if data:
            proc.stdin.write(data)
        proc.stdin.close()
    except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
        pass
    except Exception:
        pass


def _run_process_sync(
    cmd: list[str],
    input_bytes: bytes,
    timeout: float,
    limit_bytes: int,
    cwd: str,
    env: dict[str, str],
) -> dict[str, Any]:
    """阻塞式执行一个子进程；由 asyncio.to_thread 放到线程池里跑。

    为什么不用 asyncio.create_subprocess_exec：
    Windows 上 uvicorn 常把事件循环设成 SelectorEventLoop，它不支持子进程，
    调用会直接抛 NotImplementedError。to_thread + subprocess 在所有平台都可用，
    同时同样不会阻塞事件循环。
    """
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    out_holder: dict[str, Any] = {"data": b"", "trunc": False}
    err_holder: dict[str, Any] = {"data": b"", "trunc": False}

    def _read_out() -> None:
        out_holder["data"], out_holder["trunc"] = _read_capped_sync(proc.stdout, limit_bytes)

    def _read_err() -> None:
        err_holder["data"], err_holder["trunc"] = _read_capped_sync(proc.stderr, limit_bytes)

    t_out = threading.Thread(target=_read_out, daemon=True)
    t_err = threading.Thread(target=_read_err, daemon=True)
    t_in = threading.Thread(target=_feed_stdin_sync, args=(proc, input_bytes), daemon=True)
    t_out.start()
    t_err.start()
    t_in.start()

    start = time.time()
    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            proc.kill()
        except Exception:
            pass
        try:
            proc.wait(timeout=3)
        except Exception:
            pass
    elapsed = round(time.time() - start, 3)

    # 正常退出时管道会关闭，读线程很快结束；超时被 kill 也同理。
    # 若子进程又拉起了孙进程占着管道，最多再等 2 秒，不让服务端线程被拖死。
    for th in (t_out, t_err, t_in):
        th.join(timeout=2)

    return {
        "stdout_bytes": out_holder["data"],
        "stderr_bytes": err_holder["data"],
        "stdout_truncated": bool(out_holder["trunc"]),
        "stderr_truncated": bool(err_holder["trunc"]),
        "exit_code": -1 if timed_out else proc.returncode,
        "execution_time": timeout if timed_out else elapsed,
        "timed_out": timed_out,
    }


async def _execute(
    cmd_prefix: list[str],
    source_code: str,
    filename: str,
    input_data: str,
    timeout: Optional[float],
    max_output_chars: int,
    language: str,
) -> dict[str, Any]:
    limit = _clamp_timeout(timeout)
    limit_bytes = max(1024, max_output_chars * 4)
    tmpdir_obj = tempfile.TemporaryDirectory(prefix=f"smkbs_{language}_")
    tmpdir = tmpdir_obj.name
    acquired = False
    try:
        script_path = Path(tmpdir) / filename
        script_path.write_text(source_code, encoding="utf-8")
        cmd = [*cmd_prefix, str(script_path)]

        try:
            await asyncio.wait_for(_JUDGE_SEM.acquire(), timeout=30)
            acquired = True
        except asyncio.TimeoutError:
            return {
                "stdout": "", "stderr": "", "exit_code": -2, "execution_time": 0,
                "error": "判题机繁忙，请稍后再试", "error_kind": "busy",
                "stdout_truncated": False, "stderr_truncated": False,
            }

        try:
            raw = await asyncio.to_thread(
                _run_process_sync,
                cmd,
                (input_data or "").encode("utf-8", errors="replace"),
                limit,
                limit_bytes,
                tmpdir,
                _build_env(tmpdir),
            )
        except FileNotFoundError:
            return {
                "stdout": "", "stderr": "", "exit_code": 1, "execution_time": 0,
                "error": f"未找到运行环境（{cmd_prefix[0]}）", "error_kind": "runtime",
                "stdout_truncated": False, "stderr_truncated": False,
            }

        stdout_full = raw["stdout_bytes"].decode("utf-8", errors="replace")
        stderr_full = raw["stderr_bytes"].decode("utf-8", errors="replace")
        stdout = stdout_full[:max_output_chars]
        # 去掉临时目录前缀，学生看到的是 script.py 而不是服务端绝对路径
        stderr = stderr_full.replace(tmpdir + os.sep, "").replace(tmpdir, "")[:max_output_chars]
        stdout_truncated = raw["stdout_truncated"] or len(stdout_full) > max_output_chars
        stderr_truncated = raw["stderr_truncated"] or len(stderr_full) > max_output_chars

        if raw["timed_out"]:
            return {
                "stdout": stdout, "stderr": stderr, "exit_code": -1,
                "execution_time": limit,
                "error": f"⏱ 执行超时（超过 {limit:g} 秒），请检查是否有死循环",
                "error_kind": "timeout",
                "stdout_truncated": stdout_truncated, "stderr_truncated": stderr_truncated,
            }

        exit_code = raw["exit_code"]
        # 非 0 退出且没有更具体的错误类型：按运行时错误处理，
        # 否则 Traceback 会被当成「答案不对」，学生看不到异常原因。
        if exit_code not in (0, None):
            message = stderr.strip() or f"程序异常退出（exit_code={exit_code}）"
            return {
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": exit_code,
                "execution_time": raw["execution_time"],
                "error": message[:2000],
                "error_kind": "runtime",
                "stdout_truncated": stdout_truncated,
                "stderr_truncated": stderr_truncated,
            }

        return {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
            "execution_time": raw["execution_time"],
            "error": "",
            "error_kind": "",
            "stdout_truncated": stdout_truncated,
            "stderr_truncated": stderr_truncated,
        }
    except Exception as e:
        logger.error(f"{language} 子进程执行异常: {e}")
        return {
            "stdout": "", "stderr": str(e), "exit_code": 1, "execution_time": 0,
            "error": f"执行异常: {str(e)}", "error_kind": "runtime",
            "stdout_truncated": False, "stderr_truncated": False,
        }
    finally:
        if acquired:
            _JUDGE_SEM.release()
        try:
            tmpdir_obj.cleanup()
        except Exception:
            pass


# ── Python 代码执行 ──

async def run_python(
    source_code: str,
    input_data: str = "",
    timeout: Optional[float] = None,
    max_output_chars: int = MAX_OUTPUT_CHARS,
) -> dict[str, Any]:
    """执行 Python 代码。

    Args:
        source_code: Python 源代码
        input_data: 标准输入
        timeout: 单用例超时（秒）；None 用默认 10 秒
        max_output_chars: 回显/返回的最大字符数

    Returns:
        {"stdout", "stderr", "exit_code", "execution_time", "error", "error_kind", ...}
    """
    ok, msg, kind = _safety_check_python(source_code)
    if not ok:
        logger.warning(f"Python 安全检查未通过: {msg[:80]}")
        return {
            "stdout": "", "stderr": msg, "exit_code": 1, "execution_time": 0,
            "error": msg, "error_kind": kind,
            "stdout_truncated": False, "stderr_truncated": False,
        }
    if len(input_data or "") > MAX_INPUT_CHARS:
        return {
            "stdout": "", "stderr": "", "exit_code": 1, "execution_time": 0,
            "error": f"输入超过上限（{MAX_INPUT_CHARS} 字符）", "error_kind": "runtime",
            "stdout_truncated": False, "stderr_truncated": False,
        }

    return await _execute(
        [sys.executable or "python", "-u"],
        source_code, "script.py", input_data, timeout, max_output_chars, "python",
    )


# ── JavaScript 代码执行（需要 Node.js） ──

_ALLOWED_JS_MODULES = {"readline"}


def _check_js(source_code: str) -> tuple[bool, str]:
    if len(source_code) > MAX_CODE_LENGTH:
        return False, f"代码超过最大长度限制（{MAX_CODE_LENGTH} 字符）"
    for m in re.finditer(r'require\s*\(\s*[\'"]([^\'"]+)[\'"]\s*\)', source_code):
        module_name = m.group(1)
        if module_name not in _ALLOWED_JS_MODULES:
            return False, f"禁止使用危险模块: {module_name}"
    # 阻止直接摸 process：process.exit / process.env / process.binding
    if re.search(r'\bprocess\s*\.', source_code) or re.search(r'\bglobalThis\s*\.\s*process\b', source_code):
        return False, "禁止访问 process 对象"
    # 动态 import 与 child_process 字面量
    if re.search(r'\bimport\s*\(', source_code):
        return False, "禁止使用动态 import()"
    if re.search(r'child_process|worker_threads|cluster', source_code):
        return False, "禁止使用危险模块"
    return True, ""


async def run_javascript(
    source_code: str,
    input_data: str = "",
    timeout: Optional[float] = None,
    max_output_chars: int = MAX_OUTPUT_CHARS,
) -> dict[str, Any]:
    """执行 JavaScript 代码（需要服务端安装 Node.js）"""
    if not NODE_AVAILABLE:
        return {
            "stdout": "", "stderr": "", "exit_code": 1, "execution_time": 0,
            "error": "服务端未安装 Node.js，无法执行 JavaScript 代码", "error_kind": "runtime",
            "stdout_truncated": False, "stderr_truncated": False,
        }

    ok, msg = _check_js(source_code)
    if not ok:
        return {
            "stdout": "", "stderr": msg, "exit_code": 1, "execution_time": 0,
            "error": msg, "error_kind": "security",
            "stdout_truncated": False, "stderr_truncated": False,
        }
    if len(input_data or "") > MAX_INPUT_CHARS:
        return {
            "stdout": "", "stderr": "", "exit_code": 1, "execution_time": 0,
            "error": f"输入超过上限（{MAX_INPUT_CHARS} 字符）", "error_kind": "runtime",
            "stdout_truncated": False, "stderr_truncated": False,
        }

    return await _execute(
        ["node"],
        source_code, "script.js", input_data, timeout, max_output_chars, "javascript",
    )


# ── 当前 Python 解释器 ──
sys_executable = sys.executable or "python"
