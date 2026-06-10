"""
代码沙箱执行引擎
安全地在子进程中运行 Python 代码，支持输入/输出捕获和超时控制

安全策略：
1. AST 静态分析 — 拦截危险 import 和危险函数调用
2. subprocess 隔离 — 在独立进程中执行，不污染主进程
3. 资源限制 — 超时控制 + 输出大小限制
4. 临时目录 — 用完即焚，不留残留文件
"""
import ast
import subprocess
import tempfile
import os
import time
import re
import shutil
from pathlib import Path
from typing import Optional

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
}

# 限制常量
MAX_CODE_LENGTH: int = 50000       # 最大代码长度（字符）
MAX_OUTPUT_CHARS: int = 10000      # 最大输出捕获长度（字符）
MAX_EXECUTION_TIME: int = 10       # 最大执行时间（秒）

# Node.js 是否可用
NODE_AVAILABLE: bool = shutil.which("node") is not None


# ── AST 静态安全检查 ──

def _safety_check_python(source_code: str) -> tuple[bool, str]:
    """对 Python 代码进行静态安全检查

    Returns:
        (is_safe: bool, error_message: str)
    """
    if len(source_code) > MAX_CODE_LENGTH:
        return False, f"代码超过最大长度限制（{MAX_CODE_LENGTH} 字符）"

    try:
        tree = ast.parse(source_code)
    except SyntaxError as e:
        return False, f"语法错误: {e}"

    for node in ast.walk(tree):
        # ── 拦截 import os / import sys 等 ──
        if isinstance(node, ast.Import):
            for alias in node.names:
                top_module = alias.name.split('.')[0]
                if top_module in BLOCKED_MODULES:
                    return False, f"禁止导入危险模块: {alias.name}"

        # ── 拦截 from os import path / from os.path import * 等 ──
        if isinstance(node, ast.ImportFrom):
            if node.module:
                top_module = node.module.split('.')[0]
                if top_module in BLOCKED_MODULES:
                    return False, f"禁止导入危险模块: {node.module}"

        # ── 拦截 eval() / exec() / __import__() 等直接调用 ──
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in BLOCKED_FUNCTIONS:
                return False, f"禁止使用危险函数: {node.func.id}"
            # 拦截 obj.eval() / obj.exec() 形式
            if isinstance(node.func, ast.Attribute):
                if node.func.attr in ('eval', 'exec', '__import__'):
                    return False, f"禁止使用危险方法: {node.func.attr}"

        # ── 拦截 with open(...) / open(...) 等 ──
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id == 'open':
                return False, "禁止直接操作文件（open），请使用题目提供的输入参数"

        # ── 拦截星号导入（from xxx import *）──
        if isinstance(node, ast.ImportFrom) and node.names and any(
            alias.name == '*' for alias in node.names
        ):
            return False, "禁止使用星号导入（import *）"

    return True, ""


def get_supported_languages() -> list[dict]:
    """获取当前环境支持的语言列表"""
    languages = [
        {"value": "python", "label": "Python", "available": True},
    ]
    if NODE_AVAILABLE:
        languages.append({"value": "javascript", "label": "JavaScript", "available": True})
    return languages


# ── Python 代码执行 ──

async def run_python(source_code: str, input_data: str = "") -> dict:
    """安全执行 Python 代码

    Args:
        source_code: Python 源代码
        input_data: 标准输入数据

    Returns:
        {"stdout", "stderr", "exit_code", "execution_time", "error"}
    """
    # 1. 安全检查
    ok, msg = _safety_check_python(source_code)
    if not ok:
        logger.warning(f"Python 安全检查未通过: {msg[:60]}")
        return {
            "stdout": "",
            "stderr": msg,
            "exit_code": 1,
            "execution_time": 0,
            "error": msg,
        }

    # 2. 在临时目录中执行
    tmpdir_obj = tempfile.TemporaryDirectory(prefix="smkbs_code_")
    tmpdir = tmpdir_obj.name
    try:
        script_path = Path(tmpdir) / "script.py"
        script_path.write_text(source_code, encoding="utf-8")

        start = time.time()
        try:
            proc = subprocess.run(
                [sys_executable or "python", str(script_path)],
                input=input_data,
                capture_output=True,
                text=True,
                timeout=MAX_EXECUTION_TIME,
                cwd=tmpdir,
                env={
                    "PATH": os.environ.get("PATH", ""),
                    "HOME": tmpdir,
                    # 清空可能泄漏敏感信息的变量
                    "DASHSCOPE_API_KEY": "",
                    "JWT_SECRET_KEY": "",
                },
            )
            elapsed = round(time.time() - start, 3)
            stdout = proc.stdout[:MAX_OUTPUT_CHARS]
            stderr = proc.stderr[:MAX_OUTPUT_CHARS]

            return {
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": proc.returncode,
                "execution_time": elapsed,
                "error": "",
            }

        except subprocess.TimeoutExpired:
            logger.warning(f"Python 代码执行超时（{MAX_EXECUTION_TIME}s）")
            return {
                "stdout": "",
                "stderr": "",
                "exit_code": -1,
                "execution_time": MAX_EXECUTION_TIME,
                "error": f"⏱ 执行超时（超过 {MAX_EXECUTION_TIME} 秒），请检查是否有死循环",
            }
        except Exception as e:
            logger.error(f"Python 子进程执行异常: {e}")
            return {
                "stdout": "",
                "stderr": str(e),
                "exit_code": 1,
                "execution_time": 0,
                "error": f"执行异常: {str(e)}",
            }
    finally:
        try:
            tmpdir_obj.cleanup()
        except Exception:
            pass


# ── JavaScript 代码执行（需要 Node.js） ──

async def run_javascript(source_code: str, input_data: str = "") -> dict:
    """安全执行 JavaScript 代码（需要服务端安装 Node.js）

    Args:
        source_code: JavaScript 源代码
        input_data: 标准输入数据

    Returns:
        {"stdout", "stderr", "exit_code", "execution_time", "error"}
    """
    if not NODE_AVAILABLE:
        return {
            "stdout": "",
            "stderr": "",
            "exit_code": 1,
            "execution_time": 0,
            "error": "服务端未安装 Node.js，无法执行 JavaScript 代码",
        }

    # JS 安全检查：禁止危险模块
    blocked_js_modules = [
        'child_process', 'fs', 'net', 'dgram', 'cluster',
        'worker_threads', 'vm', 'module', 'os', 'path',
        'process', 'require', 'electron',
    ]
    for mod in blocked_js_modules:
        if mod == 'require':
            # require('xxx') 或 require("xxx")
            pattern = r'require\s*\(\s*[\'"]'
            if re.search(pattern, source_code):
                # 但允许 require('readline') 等安全模块
                for m in re.finditer(r'require\s*\(\s*[\'"]([^\'"]+)[\'"]\s*\)', source_code):
                    module_name = m.group(1)
                    if module_name not in ('readline', 'fs'):
                        pass  # 只放行 readline
                    if module_name in blocked_js_modules or module_name not in ('readline',):
                        return {
                            "stdout": "", "stderr": "",
                            "exit_code": 1, "execution_time": 0,
                            "error": f"禁止使用危险模块: {module_name}",
                        }

    tmpdir_obj = tempfile.TemporaryDirectory(prefix="smkbs_js_")
    tmpdir = tmpdir_obj.name
    try:
        script_path = Path(tmpdir) / "script.js"
        script_path.write_text(source_code, encoding="utf-8")

        start = time.time()
        try:
            proc = subprocess.run(
                ["node", str(script_path)],
                input=input_data,
                capture_output=True,
                text=True,
                timeout=MAX_EXECUTION_TIME,
                cwd=tmpdir,
                env={"PATH": os.environ.get("PATH", "")},
            )
            elapsed = round(time.time() - start, 3)
            return {
                "stdout": proc.stdout[:MAX_OUTPUT_CHARS],
                "stderr": proc.stderr[:MAX_OUTPUT_CHARS],
                "exit_code": proc.returncode,
                "execution_time": elapsed,
                "error": "",
            }
        except subprocess.TimeoutExpired:
            return {
                "stdout": "", "stderr": "", "exit_code": -1,
                "execution_time": MAX_EXECUTION_TIME,
                "error": f"⏱ 执行超时（超过 {MAX_EXECUTION_TIME} 秒）",
            }
        except Exception as e:
            return {
                "stdout": "", "stderr": str(e),
                "exit_code": 1, "execution_time": 0, "error": str(e),
            }
    finally:
        try:
            tmpdir_obj.cleanup()
        except Exception:
            pass


# ── 获取当前 Python 解释器路径 ──
_sys_executable_cache: Optional[str] = None


def _get_sys_executable() -> str:
    """获取可用的 Python 解释器路径"""
    global _sys_executable_cache
    if _sys_executable_cache:
        return _sys_executable_cache

    # 优先使用当前解释器
    import sys as _sys
    candidates = [
        _sys.executable,
        "python3",
        "python",
    ]
    for cmd in candidates:
        if cmd and shutil.which(cmd):
            _sys_executable_cache = cmd
            return cmd
    # 兜底
    _sys_executable_cache = "python"
    return "python"


sys_executable = _get_sys_executable()
