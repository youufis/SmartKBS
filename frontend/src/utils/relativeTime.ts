/**
 * 全站统一的时间展示工具。
 *
 * 后端时间串多为 "YYYY-MM-DD HH:MM:SS"（部分只有日期），
 * 这里统一解析并输出「相对时间 + 完整时间」两个口径，
 * 供列表/详情等场景配合 Tooltip 使用，避免各页面各自 slice 裸时间戳。
 */

/** 解析后端时间串，失败返回 null */
export function parseServerDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const normalized = String(s).trim().replace(' ', 'T')
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 完整时间（用于 Tooltip / 无障碍） */
export function fullTime(s: string | null | undefined, locale = 'zh-CN'): string {
  const d = parseServerDate(s)
  if (!d) return ''
  const hasTime = /\d{2}:\d{2}/.test(String(s ?? ''))
  return hasTime
    ? d.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期。
 * 用 Intl.RelativeTimeFormat 原生适配中英文，不硬编码文案。
 */
export function relativeTime(s: string | null | undefined, now = new Date(), locale = 'zh-CN'): string {
  const d = parseServerDate(s)
  if (!d) return ''
  const diffMs = now.getTime() - d.getTime()
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (diffMs < 60_000) return rtf.format(0, 'minute')
  if (diffMs < 3_600_000) return rtf.format(-Math.floor(diffMs / 60_000), 'minute')
  if (diffMs < 86_400_000) return rtf.format(-Math.floor(diffMs / 3_600_000), 'hour')
  if (diffMs < 604_800_000) return rtf.format(-Math.floor(diffMs / 86_400_000), 'day')
  return d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
}
