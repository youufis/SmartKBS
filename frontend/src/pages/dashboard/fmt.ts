/** 看板通用时间/数字格式化工具 */

/** 解析后端时间串（"YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM:SS"），失败返回 null */
export function parseServerDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const normalized = s.trim().replace(' ', 'T')
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 相对截止描述：逾期/今天剩几小时/还剩几天 */
export function deadlineInfo(deadline: string | null | undefined, now = new Date()) {
  const d = parseServerDate(deadline)
  if (!d) return null
  const diffMs = d.getTime() - now.getTime()
  const days = Math.floor(diffMs / 86400000)
  if (diffMs < 0) {
    const overdueDays = Math.max(1, Math.ceil(-diffMs / 86400000))
    return { level: 'overdue' as const, overdueDays, diffMs }
  }
  if (diffMs < 24 * 3600000) {
    return { level: 'today' as const, hoursLeft: Math.max(1, Math.round(diffMs / 3600000)), diffMs }
  }
  return { level: 'later' as const, days: days + (diffMs % 86400000 > 0 ? 1 : 0), diffMs }
}

/** 人性化时间：今天 HH:mm / 昨天 / M月D日 */
export function friendlyTime(s: string | null | undefined, locale = 'zh-CN'): string {
  const d = parseServerDate(s)
  if (!d) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const y = new Date(now.getTime() - 86400000)
  if (d.toDateString() === y.toDateString()) return d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function pct(v: number | null | undefined): number {
  if (v == null || Number.isNaN(v)) return 0
  return Math.max(0, Math.min(100, Math.round(v)))
}
