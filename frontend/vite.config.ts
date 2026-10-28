import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    // 【为什么这里要动 NODE_ENV】
    // TLDraw v5 的 LicenseManager.getIsDevelopment() = 「页面协议不是 https:」或「localhost」或「NODE_ENV != production」。
    // 早年为了跳过白板 license 校验，这里把 NODE_ENV 全局钉成 development，
    // 代价是打进产物的 React / antd / rc-* 全变成**开发版**，渲染慢 3~5 倍
    //（实测：试题管理翻页阻塞主线程 4.0s → 1.2s，勾选一行 1.0s → 85ms）。
    //
    // 现在的默认值：production（React 生产构建）。
    // 桌面版和 http 内网部署靠"协议非 https:"就走 TLDraw 的 development 分支，白板不受影响。
    // 只有「公网 HTTPS 站点 + 教学白板」需要旧的无 license 行为：
    //   npm run build:https-site   ← 只有这条命令会把 React 退回 development 模式
    'process.env.NODE_ENV': JSON.stringify(process.env.VITE_REACT_DEV === '1' ? 'development' : 'production'),
  },
  build: {
    target: 'es2015',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // 白板 WebSocket 优先匹配，避免 WS 断开影响 HTTP 代理
      '/api/whiteboard/ws': {
        target: 'ws://localhost:8086',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8086',
        changeOrigin: true,
      },
      '/score-api': 'http://localhost:8086',
      '/rollcall-api': 'http://localhost:8086',
      '/downloads-api': 'http://localhost:8086',
    },
  },
})
