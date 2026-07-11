"""
SmartKBS Desktop - Python 后端入口

PyInstaller 入口点。
将 FastAPI 后端打包为独立可执行文件，供 Electron 桌面应用调用。

路径说明（PyInstaller --onedir 模式下）：
  smartkb-backend.exe
  └─ _internal/              ← Python 运行时 + 第三方包 + backend 包
      └─ backend/            ← backend Python 包（自动收集）
      └─ locales/            ← i18n 数据（通过 --add-data）
      └─ skills/             ← 技能引擎数据（通过 --add-data）
      └─ version.json        ← 版本信息（通过 --add-data）

BASE_DIR 解析：
  config.py 中 BASE_DIR = Path(__file__).parent.parent
  → __file__ = <_internal>/backend/config.py
  → BASE_DIR = <_internal>/   （即 sys._MEIPASS 目录）
"""
import os
import sys
from pathlib import Path


# ── 关键：在导入 backend 模块之前，先把项目根目录加入 sys.path ──
# 这样 PyInstaller 静态分析时能正确找到 backend 包

_THIS_FILE = Path(__file__).resolve()
_THIS_DIR = _THIS_FILE.parent

if getattr(sys, 'frozen', False):
    # PyInstaller 打包模式：项目根目录就是 sys._MEIPASS
    _PROJECT_ROOT = Path(sys._MEIPASS)
else:
    # 开发模式：_backend_entry.py 位于 desktop/，项目根目录是其父目录
    _PROJECT_ROOT = _THIS_DIR.parent

sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(str(_PROJECT_ROOT))


# ── 启动 FastAPI 服务 ──
from backend.main import app
from backend.config import SERVER_PORT
import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",       # 仅本地访问，安全
        port=SERVER_PORT,
        reload=False,            # 桌面版禁用热重载
        log_level="info",
        access_log=True,
        use_colors=False,        # 日志输出到文件时禁用颜色
    )
