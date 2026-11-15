import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 翻译文件的缓存破坏值：由 public/locales 的内容本身决定（短哈希），不是构建时间戳。
 *
 * 【为什么不能用时间戳】今天用过一版时间戳，后果是每次构建产物字节都变：
 * 桌面打包脚本 package-all.ps1 的 preflight 会把 dist 与一次探测构建做**字节比对**，
 * 于是 178 个 chunk 全部改名、校验永远不可能通过（实测直接被拒打包）。
 * 而且时间戳与"文案有没有变"根本无关 —— 改一行代码也会让所有客户端重新拉一遍翻译。
 *
 * 【内容哈希为什么对】同一份文案重复构建 → 同一个值 → 产物字节一致，
 * dist 入库后再构建也不会漂移；文案一改 → 值变 → URL 变 → 旧缓存自然失效。
 * 需要强制刷新时仍可用环境变量 VITE_BUILD_ID 覆盖。
 */
function localesFingerprint(): string {
  if (process.env.VITE_BUILD_ID) return process.env.VITE_BUILD_ID
  const root = join(__dirname, 'public', 'locales')
  const h = createHash('sha256')
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { walk(p, prefix + name + '/'); continue }
      h.update(prefix + name).update(readFileSync(p))
    }
  }
  try {
    walk(root, '')
    return h.digest('hex').slice(0, 12)
  } catch {
    // 拿不到目录（非标准工作区）时退回版本号：宁可缓存破坏弱一点，也不能让构建失败
    return 'static'
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    // 翻译文件的缓存破坏参数用得上（i18n.ts）。
    // 【为什么不用 package.json 版本号】版本号只在发版时变，而翻译文案天天改：
    // 加完新键、URL 里的 ?v=9.2.0 一个字没变，浏览器继续吃旧的 system.json，
    // 界面上就只剩裸键名（实测踩过：hwDuplicate / hwDuplicateTitle 显示成键名）。
    // 绑到构建时间戳上，每次构建自然失效；开发态则随 dev server 重启变化。
    '__APP_BUILD__': JSON.stringify(localesFingerprint()),
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
    // 沙箱预览 iframe 的 origin 为 null：Vite 默认 cors 白名单只认 localhost，
    // 预检(OPTIONS)会被它拒掉（后端 CORS 管不到这层），导致 iframe 内 POST 全失败
    cors: { origin: true },
    proxy: {
      // 白板 WebSocket 优先匹配，避免 WS 断开影响 HTTP 代理
      '/api/whiteboard/ws': {
        target: 'ws://localhost:8086',
        ws: true,
        changeOrigin: true,
      },
      // 其余活动 WS（抢答/讨论/提问…）：/api 兜底代理不转发 WebSocket 升级，
      // 缺这条时开发态 WS 全部静默失败，教师端只能靠轮询兜底
      '/api/ws': {
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
