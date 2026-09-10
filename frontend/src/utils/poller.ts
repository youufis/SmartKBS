/**
 * 全站定时轮询统一管理
 *
 * 背景：通知未读 / 学伴推送未读 / 称号庆祝 / 在线人数各自 setInterval，
 * 一旦 token 失效又没人停表，就会出现"未登录的页面每 30 秒三连发 401"刷爆后端日志。
 * 这里把所有周期轮询收进一个注册表，统一三件事：
 *   1. 未登录（本地没有 token）不发请求；
 *   2. 标签页在后台时不发请求（visibilitychange 触发时回到前台立即补一次）；
 *   3. 401 拦截器调一次 stopAllPollers() 就能全停。
 */

/** 与 authStore / api/client.ts 共用同一个 key */
export const TOKEN_STORAGE_KEY = 'smartkb_token'

export interface PollerOptions {
  /** 默认 true：本地没有 token 时跳过本轮（免鉴权接口传 false） */
  requireAuth?: boolean
  /** 默认 true：注册后立刻跑一次，不等第一个周期 */
  immediate?: boolean
}

interface PollerEntry {
  fn: () => unknown
  intervalMs: number
  requireAuth: boolean
  timer: ReturnType<typeof setInterval> | null
}

const pollers = new Map<string, PollerEntry>()
let visibilityBound = false

export const hasToken = (): boolean => !!localStorage.getItem(TOKEN_STORAGE_KEY)

export const isPageVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden'

function shouldRun(entry: PollerEntry): boolean {
  return (!entry.requireAuth || hasToken()) && isPageVisible()
}

function tick(entry: PollerEntry): void {
  if (!shouldRun(entry)) return
  try {
    void Promise.resolve(entry.fn()).catch(() => {
      /* 轮询失败由调用方/拦截器处理，这里只防止 unhandled rejection */
    })
  } catch {
    /* 同步抛错的轮询任务同样不让它带走定时器 */
  }
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    // 回到前台：立刻补一轮（badge 数字不失联）；切到后台：靠 shouldRun 自动跳过，无需改定时器
    if (!isPageVisible()) return
    pollers.forEach((entry) => tick(entry))
  })
}

/**
 * 注册（或同名覆盖）一个轮询任务。
 * key 相同的重复注册会先停掉旧的，组件热更新/依赖变化不会叠加定时器。
 */
export function startPoller(
  key: string,
  fn: () => unknown,
  intervalMs = 30_000,
  options: PollerOptions = {},
): void {
  const { requireAuth = true, immediate = true } = options
  bindVisibility()
  stopPoller(key)
  const entry: PollerEntry = { fn, intervalMs, requireAuth, timer: null }
  entry.timer = setInterval(() => tick(entry), intervalMs)
  pollers.set(key, entry)
  if (immediate) tick(entry)
}

export function stopPoller(key: string): void {
  const entry = pollers.get(key)
  if (!entry) return
  if (entry.timer) clearInterval(entry.timer)
  pollers.delete(key)
}

export function stopAllPollers(): void {
  for (const key of Array.from(pollers.keys())) stopPoller(key)
}

/** 调试/自检用：当前挂着的轮询数量 */
export function pollerKeys(): string[] {
  return Array.from(pollers.keys())
}
