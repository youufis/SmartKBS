/**
 * 看板图表的「形式轮换」：稳定 + 用户主权，**不是**真随机。
 *
 * 为什么不每次随机：
 * ① 图表类型是读图契约。同一张卡今天增长条、明天环形，用户每次进来都要重新建立
 *    「这图怎么看」的映射，扫读效率直接下降；
 * ② 随机会把不合适的形式套在不合适的数据上——7 天里只有 2 天非零时画折线，
 *    就是一条从底爬起的斜线，比柱状更难读；
 * ③ 无法复现。教研说「我看到的图和你不一样」时无法核对，视觉回归也没法做。
 *
 * 所以：日期做种子决定「今天用哪种」——同一天内刷新、多标签页完全一致，跨天自然变化；
 * 用户手动切换后以用户为准，不再轮换。
 *
 * 每张卡用自己的 card 名做种子盐，各卡独立轮换（不会出现全站同一天整齐划一）。
 */
import { useCallback, useState } from 'react'

const KEY_PREFIX = 'smartkbs.dashboard.variant.'

/** 旧版本只有趋势卡能切换，key 不带卡片名，读的时候兜底一次，免得用户选过的偏好丢掉 */
const LEGACY_KEYS: Record<string, string> = {
  trend: 'smartkbs.dashboard.trendVariant',
}

/** FNV-1a */
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 今天这张卡该用哪种形式：纯函数，同一天任意次调用结果一致 */
export function seededVariant<V extends string>(card: string, pool: readonly V[], d: Date = new Date()): V {
  return pool[hashStr(`${card}:${ymd(d)}`) % pool.length]
}

export function readUserVariant<V extends string>(card: string, pool: readonly V[]): V | null {
  const accept = (raw: string | null) =>
    raw && (pool as readonly string[]).includes(raw) ? (raw as V) : null
  try {
    const hit = accept(localStorage.getItem(KEY_PREFIX + card))
    if (hit) return hit
    const legacy = LEGACY_KEYS[card]
    return legacy ? accept(localStorage.getItem(legacy)) : null
  } catch {
    // 隐私模式 / 存储被禁用时 localStorage 会直接抛错，退回按日期轮换
    return null
  }
}

/**
 * [当前形式, 用户选定]。用户没选过 → 按日期轮换；选过 → 一直是它。
 * 初始值放在 useState 惰性初始化里，避免每次渲染重算日期。
 */
export function useChartVariant<V extends string>(
  card: string,
  pool: readonly V[],
): [V, (v: V) => void] {
  const [variant, setVariant] = useState<V>(() => readUserVariant(card, pool) ?? seededVariant(card, pool))
  const choose = useCallback((v: V) => {
    setVariant(v)
    try {
      localStorage.setItem(KEY_PREFIX + card, v)
    } catch {
      // 存不下就只在本次会话生效，不影响功能
    }
  }, [card])
  return [variant, choose]
}
