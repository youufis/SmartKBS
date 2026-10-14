/**
 * R2: 得分统一按百分制展示。
 *
 * 背景：同步练习/考试建卷时会把总分折算成 100（backend/utils.distribute_scores），
 * 随堂测验原来是每题 1 分（满分 = 题数），于是同一个"3/5"在结果页、"得分 3 分"在
 * 首页动态、汇总导出里被当成满分 100，学生与教师看到的口径互相打架。
 * 这里集中一份折算与配色，页面只读字段、不再各写一遍 Math.round(x / y * 100)。
 */

/** 原始分 → 百分制百分数（保留 1 位小数）；满分为 0/非法时返回 0 */
export function toPercent(score: unknown, total: unknown): number {
  const s = Number(score ?? 0)
  const t = Number(total ?? 0)
  if (!Number.isFinite(s) || !Number.isFinite(t) || t <= 0) return 0
  return Math.round(Math.max(0, Math.min(1, s / t)) * 1000) / 10
}

/** 百分制百分数 → 整数（用于圆环/进度条展示） */
export function toPercentInt(score: unknown, total: unknown): number {
  return Math.round(toPercent(score, total))
}

/** 百分数 → antd 语义色（与全站 80/60 阈值一致） */
export function percentColor(percent: number): string {
  if (percent >= 80) return "var(--color-success, #52c41a)"
  if (percent >= 60) return "var(--color-warning, #faad14)"
  return "var(--color-error, #ff4d4f)"
}

/** 百分数 → antd Tag/语义状态名（暗色主题下用语义色而不是写死色号） */
export function percentStatus(percent: number): "success" | "warning" | "error" {
  if (percent >= 80) return "success"
  if (percent >= 60) return "warning"
  return "error"
}

/** 百分数 → i18n 等级键（结果页正反馈用；调用方直接 t(percentLevelKey(p))） */
export function percentLevelKey(percent: number): "levelExcellent" | "levelGood" | "levelPass" | "levelWeak" {
  if (percent >= 90) return "levelExcellent"
  if (percent >= 80) return "levelGood"
  if (percent >= 60) return "levelPass"
  return "levelWeak"
}

/**
 * 分值均摊（与后端 backend/utils.distribute_scores 同算法，列表和恒等于 total）。
 *
 * 随堂测验原来每题固定 1 分，满分等于题数；建卷时用它把总分折成 100，
 * 与同步练习/考试同一口径，结果页才能直接显示"60/100"。
 */
export function distributeScores(n: number, total = 100, minimum = 1): number[] {
  if (n <= 0) return []
  if (n * minimum > total) return new Array(n).fill(minimum)
  const base = Math.floor(total / n)
  const rem = total % n
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0))
}
