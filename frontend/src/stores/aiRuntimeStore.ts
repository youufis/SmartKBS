/**
 * AI 运行状态的全局缓存（zustand + 引用计数）
 *
 * 为什么不是各页各自 useEffect：这颗胶囊要挂在对话 / 本地文库 / 智能题库 / 课程大纲 /
 * 讲演生成弹层 / 简报 / 学情 / 课堂总结等七八个页面上。各挂各的，切一次页面就是
 * 一次配置读 + 一次 kb_docs 计数；收成一个 store 后，同一份快照全端复用，
 * 定时器也只有一份（交给 utils/poller：切后台自动停、回前台立刻补一轮、401 统一停表）。
 *
 * 新鲜度分两层：本地 60s 内直接用缓存（同一次会话里页面间跳转不该重复请求），
 * 服务端另有 15s 快照缓存（管理员改完配置最迟 15s 生效），所以 2 分钟一轮轮询足够。
 */
import { create } from 'zustand'
import { getAiRuntime, type AiRuntime } from '../api/aiRuntime'
import { startPoller, stopPoller } from '../utils/poller'

const FRESH_MS = 60_000
const POLL_MS = 120_000
const POLL_KEY = 'ai-runtime'

interface AiRuntimeState {
  data: AiRuntime | null
  loadedAt: number
  load: (force?: boolean) => void
  invalidate: () => void
}

let subscribers = 0
let inFlight: Promise<void> | null = null

export const useAiRuntimeStore = create<AiRuntimeState>()((set, get) => ({
  data: null,
  loadedAt: 0,

  load: (force = false) => {
    const { data, loadedAt } = get()
    if (inFlight) return
    if (!force && data && Date.now() - loadedAt < FRESH_MS) return
    inFlight = getAiRuntime()
      .then((d) => set({ data: d, loadedAt: Date.now() }))
      // 读不到就当没有：状态位是辅助信息，绝不在页面上留"读取失败"的占位；
      // loadedAt 不更新，下一次挂载或轮询自然重试
      .catch(() => undefined)
      .finally(() => { inFlight = null })
  },

  invalidate: () => set({ loadedAt: 0 }),
}))

/**
 * 组件挂载期间订阅：首个挂载者发起请求并挂上轮询，最后一个卸载时停表。
 * StrictMode 的双挂载/卸载由引用计数吸收，不会叠定时器。
 */
export function subscribeAiRuntime(): () => void {
  subscribers += 1
  useAiRuntimeStore.getState().load()
  if (subscribers === 1) {
    startPoller(POLL_KEY, () => useAiRuntimeStore.getState().load(true), POLL_MS, { immediate: false })
  }
  return () => {
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0) stopPoller(POLL_KEY)
  }
}
