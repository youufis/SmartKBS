import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    // TLDraw v5 在生产模式下检查 license key，HTTPS 下判定为非开发环境
    // 覆写 NODE_ENV 为 development 让 TLDraw 始终以开发模式运行，跳过 license 强制验证
    'process.env.NODE_ENV': JSON.stringify('development'),
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
