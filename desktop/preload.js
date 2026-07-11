/**
 * SmartKBS Desktop - 预加载脚本
 *
 * 在渲染进程加载前执行，通过 contextBridge 安全地暴露有限的 API。
 * 保持最小权限原则：仅暴露必要的能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartkbs', {
  // 应用信息
  platform: process.platform,

  // 版本信息
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  // 应用控制
  quit: () => ipcRenderer.send('app-quit'),
  minimize: () => ipcRenderer.send('app-minimize'),
  maximize: () => ipcRenderer.send('app-maximize'),
});
