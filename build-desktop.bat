@echo off
chcp 65001 >nul
title SmartKBS 桌面版构建工具
setlocal enabledelayedexpansion

echo ══════════════════════════════════════════
echo   SmartKBS 桌面版 - 一键构建
echo ══════════════════════════════════════════
echo.

REM ── 检查依赖 ──
echo [1/4] 检查构建环境...

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装 Node.js 18+
    echo        下载: https://nodejs.org/
    pause
    exit /b 1
)
echo   ✓ Node.js 已安装

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Python，请先安装 Python 3.10+
    pause
    exit /b 1
)
echo   ✓ Python 已安装

REM ── 确保 pip 包安装 ──
echo.
echo [2/4] 安装 Python 打包依赖...
pip install pyinstaller openpyxl >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] pip install pyinstaller 失败
    pause
    exit /b 1
)
echo   ✓ PyInstaller + openpyxl

REM ── 构建前端 ──
echo.
echo [3/4] 构建前端...
echo   正在安装前端依赖...
cd /d "%~dp0frontend"
if not exist "node_modules" (
    call npm install --silent
    if !errorlevel! neq 0 (
        echo [错误] npm install 失败
        pause
        exit /b 1
    )
)

echo   正在构建前端...
call npm run build
if %errorlevel% neq 0 (
    echo [错误] 前端构建失败
    pause
    exit /b 1
)
echo   ✓ 前端构建完成 (frontend/dist/)

REM ── 构建后端 ──
echo.
echo [4/4] 打包 Python 后端...
cd /d "%~dp0desktop"

REM 清理旧的构建产物
if exist "backend-dist" rmdir /s /q "backend-dist"
if exist "build" rmdir /s /q "build"

pyinstaller --onedir ^
    --name smartkb-backend ^
    --distpath ./backend-dist ^
    --workpath ./build ^
    --paths D:\SmartKBS ^
    --add-data "../version.json;." ^
    --add-data "../README.md;." ^
    --add-data "../README.en.md;." ^
    --hidden-import uvicorn.loggers ^
    --hidden-import uvicorn.loops.auto ^
    --hidden-import uvicorn.protocols.http.auto ^
    --hidden-import uvicorn.protocols.websockets.auto ^
    --hidden-import httpx._transports.default ^
    --hidden-import python_multipart ^
    --hidden-import PyPDF2 ^
    --collect-all httpx ^
    _backend_entry.py

if %errorlevel% neq 0 (
    echo [错误] PyInstaller 打包失败
    pause
    exit /b 1
)

echo   复制 backend Python 包...
cd /d "%~dp0desktop"
powershell -ExecutionPolicy Bypass -File copy-backend.ps1
if %errorlevel% neq 0 (
    echo [错误] 复制 backend 包失败
    pause
    exit /b 1
)
echo   ✓ 后端打包完成 (desktop/backend-dist/)

REM ── 打包安装程序 ──
echo.
echo ══════════════════════════════════════════
echo   正在打包安装程序...
echo ══════════════════════════════════════════
echo.
echo   安装桌面依赖...

cd /d "%~dp0desktop"
if not exist "node_modules" (
    call npm install --silent
)

echo   生成安装程序...
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
call npx electron-builder --win
if %errorlevel% neq 0 (
    echo [错误] 安装程序打包失败
    pause
    exit /b 1
)

echo.
echo ══════════════════════════════════════════
echo   ✓✓✓ 构建成功！ ✓✓✓
echo ══════════════════════════════════════════
echo.
echo   安装程序位置:
echo   %~dp0desktop\release\SmartKBS-Setup-*.exe
echo.
echo   清理构建缓存...
if exist "%~dp0desktop\build" rmdir /s /q "%~dp0desktop\build"
echo.
pause
