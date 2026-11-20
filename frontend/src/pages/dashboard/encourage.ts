/** 首页降噪共用：今日要做口径、本周完成统计、鼓励句规则库（docs/student-dashboard/00 方案 §1B/§3） */
import type { TaskTodoItem, TaskTodoResponse } from '../../api/taskTodo'

export interface EncouragePick { key: string; params?: Record<string, string | number> }

export const parseMs = (s?: string | null): number => {
  if (!s) return 0
  const d = new Date(String(s).trim().replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? 0 : d.getTime()
}

/** 今天要做 N 项：已逾期 + 今天 24 点前截止 + 课堂进行中（与任务清单 todayMust 同口径） */
export function computeTodayMust(items: TaskTodoItem[], nowMs: number): number {
  const dayEnd = new Date(nowMs)
  dayEnd.setHours(24, 0, 0, 0)
  const endMs = dayEnd.getTime()
  return items.reduce((n, it) => {
    if (it.status === 'completed') return n
    const ms = parseMs(it.deadline)
    if ((ms > 0 && ms < endMs) || (it.live && !it.suggest)) return n + 1
    return n
  }, 0)
}

/** 本周完成 X 项 + 与上周对比（recent_done 近 30 天时间戳前端计算，后端 0 改动） */
export function computeWeeklyDone(todo: TaskTodoResponse | null, nowMs: number): { thisWeek: number; deltaVsLastWeek: number } {
  const day = 86400000
  let thisWeek = 0
  let lastWeek = 0
  for (const r of todo?.recent_done ?? []) {
    const ms = parseMs(r.time)
    if (!ms) continue
    if (ms >= nowMs - 7 * day) thisWeek += 1
    else if (ms >= nowMs - 14 * day) lastWeek += 1
  }
  return { thisWeek, deltaVsLastWeek: thisWeek - lastWeek }
}

/** 今日完成 X 项：recent_done 落在今天 [0,24) 的条数（与"今天要做"形成投入→产出闭环） */
export function computeTodayDone(todo: TaskTodoResponse | null, nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  const start = d.getTime()
  let c = 0
  for (const r of todo?.recent_done ?? []) {
    const ms = parseMs(r.time)
    if (ms >= start && ms <= nowMs) c += 1
  }
  return c
}

/** 鼓励句规则库：按优先级取第一句命中；全页最多 1 句（今日要事脚部），零 AI 成本 */
export function pickEncouragement(ctx: {
  todayMust: number; activeTotal: number; weeklyDone: number; streak: number
  titleProgress: number; nextTitle?: string | null
  wrongPending: number; wrongTotal: number; approvedAnswers: number
}): EncouragePick | null {
  if (ctx.todayMust === 0 && ctx.activeTotal > 0) return { key: 'todayCalm' }
  if (ctx.weeklyDone >= 5) return { key: 'weekSteady', params: { n: ctx.weeklyDone } }
  if (ctx.weeklyDone >= 1) return { key: 'weekKeep', params: { n: ctx.weeklyDone } }
  if (ctx.streak >= 7) return { key: 'streakValue', params: { n: ctx.streak } }
  if ((ctx.titleProgress ?? 0) >= 80 && ctx.nextTitle) {
    return { key: 'titleNear', params: { next: ctx.nextTitle, p: Math.max(1, 100 - ctx.titleProgress) } }
  }
  if (ctx.wrongTotal > 0 && ctx.wrongPending === 0) return { key: 'wrongCleared' }
  if (ctx.approvedAnswers > 0) return { key: 'helper', params: { n: ctx.approvedAnswers } }
  if (ctx.activeTotal === 0 && ctx.weeklyDone === 0 && ctx.streak === 0) return { key: 'newStart' }
  return null
}
