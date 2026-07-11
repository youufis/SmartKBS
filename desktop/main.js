/**
 * SmartKBS Desktop - Electron 主进程
 *
 * 职责：
 * 1. 启动 Python 后端作为子进程（本地 API 服务）
 * 2. 等待后端就绪后创建浏览器窗口加载前端
 * 3. 窗口关闭时自动清理后端进程
 */
const { app, BrowserWindow, Menu, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

// ── 配置 ──
const BACKEND_PORT = 8086;
const BACKEND_HOST = '127.0.0.1';
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
const BACKEND_TIMEOUT_MS = 60000;       // 后端启动超时（60 秒）
const BACKEND_POLL_INTERVAL_MS = 800;   // 轮询间隔

let mainWindow = null;
let backendProcess = null;

// ── 后端路径解析 ──
function getBackendPath() {
  if (app.isPackaged) {
    // 生产环境：extractResources 中的后端可执行文件
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(process.resourcesPath, 'backend', `smartkb-backend${ext}`);
  }
  // 开发环境：直接使用系统 Python
  return 'python';
}

function getBackendArgs() {
  if (app.isPackaged) {
    return [];
  }
  return ['-m', 'uvicorn', 'backend.main:app', '--host', BACKEND_HOST, '--port', String(BACKEND_PORT)];
}

function getBackendCwd() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend');
  }
  // 开发环境：项目根目录
  return path.join(__dirname, '..');
}

function getBackendEnv() {
  const env = { ...process.env };

  if (app.isPackaged) {
    // 生产环境：设置前端静态文件路径和用户数据目录
    const frontendPath = path.join(process.resourcesPath, 'static', 'frontend');
    if (fs.existsSync(frontendPath)) {
      env.SMARTKB_FRONTEND_PATH = frontendPath;
    }
    // 将用户数据目录设为 Electron 的用户数据目录（持久化在 AppData）
    env.SMARTKB_DATA_DIR = app.getPath('userData');
  }

  return env;
}

// ── 等待后端就绪 ──
function waitForBackend(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    function poll() {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) {
        return reject(new Error(`后端服务启动超时（${timeoutMs / 1000}秒）`));
      }

      const req = http.get(url, (res) => {
        res.resume(); // 消耗响应数据以释放连接
        resolve();
      });

      req.on('error', () => {
        // 后端尚未就绪，继续轮询
        setTimeout(poll, BACKEND_POLL_INTERVAL_MS);
      });

      req.setTimeout(3000, () => {
        req.destroy();
        setTimeout(poll, BACKEND_POLL_INTERVAL_MS);
      });
    }

    poll();
  });
}

// ── 启动后端 ──
function startBackend() {
  return new Promise((resolve, reject) => {
    const backendPath = getBackendPath();
    const backendArgs = getBackendArgs();
    const cwd = getBackendCwd();
    const env = getBackendEnv();

    console.log(`[main] 启动后端: ${backendPath} ${backendArgs.join(' ')}`);
    console.log(`[main] 工作目录: ${cwd}`);
    console.log(`[main] 前端路径: ${env.SMARTKB_FRONTEND_PATH || '默认'}`);
    console.log(`[main] 数据目录: ${env.SMARTKB_DATA_DIR || '默认'}`);

    backendProcess = spawn(backendPath, backendArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 收集启动日志（用于调试）
    let startupLog = '';

    backendProcess.stdout.on('data', (data) => {
      const text = data.toString();
      startupLog += text;
      console.log(`[backend:out] ${text.trim()}`);
    });

    backendProcess.stderr.on('data', (data) => {
      const text = data.toString();
      startupLog += text;
      console.log(`[backend:err] ${text.trim()}`);
    });

    backendProcess.on('error', (err) => {
      console.error(`[main] 后端进程启动失败:`, err.message);
      reject(err);
    });

    backendProcess.on('exit', (code, signal) => {
      console.log(`[main] 后端进程已退出 (code=${code}, signal=${signal})`);
      backendProcess = null;
    });

    // 等待后端 HTTP 服务就绪
    waitForBackend(`${BACKEND_URL}/`, BACKEND_TIMEOUT_MS)
      .then(() => {
        console.log('[main] 后端服务已就绪 ✓');
        resolve();
      })
      .catch((err) => {
        console.error('[main] 后端启动失败:', err.message);
        // 终止后端进程
        killBackend();
        reject(err);
      });
  });
}

// ── 停止后端 ──
function killBackend() {
  if (backendProcess) {
    console.log('[main] 正在停止后端进程...');
    try {
      if (process.platform === 'win32') {
        // Windows 下使用 taskkill 确保进程树被终止
        spawn('taskkill', ['/pid', String(backendProcess.pid), '/f', '/t']);
      } else {
        backendProcess.kill('SIGTERM');
      }
    } catch (e) {
      console.error('[main] 停止后端时出错:', e.message);
    }
    backendProcess = null;
  }
}

// ── 创建主窗口 ──
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    title: 'SmartKBS 智慧教学平台',
    icon: path.join(__dirname, 'resources', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false, // 等待 ready-to-show 再显示，避免白屏
  });

  // 加载前端
  mainWindow.loadURL(BACKEND_URL);

  // 窗口准备好后再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 开发环境下打开 DevTools
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 监听页面加载失败
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`[main] 页面加载失败: ${errorDescription} (${errorCode})`);
  });
}

// ── 显示错误对话框 ──
function showErrorDialog(title, message) {
  dialog.showErrorBox(title, message);
  app.quit();
}

// ── 应用生命周期 ──
app.whenReady().then(async () => {
  // 移除默认菜单栏
  Menu.setApplicationMenu(null);

  // 检查后端可执行文件是否存在（生产环境）
  if (app.isPackaged) {
    const backendPath = getBackendPath();
    if (!fs.existsSync(backendPath)) {
      showErrorDialog(
        '启动失败',
        `后端程序文件不存在:\n${backendPath}\n\n请重新安装 SmartKBS。`
      );
      return;
    }
  }

  try {
    await startBackend();
    createMainWindow();
  } catch (err) {
    showErrorDialog(
      '启动失败',
      `无法启动 SmartKBS 后端服务:\n${err.message}\n\n请尝试重新安装或联系技术支持。`
    );
  }
});

app.on('window-all-closed', () => {
  killBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killBackend();
});

app.on('will-quit', () => {
  killBackend();
});
