# SmartKBS Desktop - 后端包复制脚本
# 在 PyInstaller 完成后，将 backend Python 包和数据文件复制到 _internal/ 中
# 原因：PyInstaller 的 --add-data 与 Python 包同名目录冲突，导致 backend 包不被收集

param(
    [string]$BackendSource = (Resolve-Path "$PSScriptRoot\..\backend").Path,
    [string]$OutputDir = "$PSScriptRoot\backend-dist\smartkb-backend\_internal\backend"
)

Write-Host "复制 backend 包到: $OutputDir" -ForegroundColor Cyan

# 创建目标目录
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# 使用 robocopy 复制所有文件和目录（排除 __pycache__ 和 .pyc 文件）
$robocopyArgs = @(
    $BackendSource,
    $OutputDir,
    "/E",           # 复制子目录（包括空目录）
    "/COPY:DAT",    # 复制数据、属性、时间戳
    "/NDL",         # 无目录日志
    "/NFL",         # 无文件日志
    "/NJH",         # 无作业头
    "/NJS",         # 无作业摘要
    "/R:0",         # 无重试
    "/XD", "__pycache__", ".git",  # 排除的目录
    "/XF", "*.db", "*.db-shm", "*.db-wal", "system_config.json"  # 排除数据库和配置文件
)

$result = Start-Process -Wait -NoNewWindow -FilePath "robocopy" -ArgumentList $robocopyArgs -PassThru
if ($result.ExitCode -ge 8) {
    Write-Host "robocopy 失败，退出码: $($result.ExitCode)" -ForegroundColor Red
    exit 1
}

# robocopy 的 /XF 对通配符支持有限，额外清理确保删除
Get-ChildItem -Path $OutputDir -Recurse -Include "*.db", "*.db-shm", "*.db-wal" -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "✅ backend 包复制完成" -ForegroundColor Green

# 验证关键文件
$keyFiles = @("__init__.py", "main.py", "config.py", "api\__init__.py", "prompts\__init__.py")
$allOk = $true
foreach ($f in $keyFiles) {
    $path = Join-Path $OutputDir $f
    if (Test-Path $path) {
        Write-Host "   ✅ $f" -ForegroundColor Green
    } else {
        Write-Host "   ❌ $f" -ForegroundColor Red
        $allOk = $false
    }
}

if (-not $allOk) {
    Write-Host "错误: backend 包关键文件缺失！" -ForegroundColor Red
    exit 1
}

Write-Host "✅ 全部验证通过" -ForegroundColor Green
