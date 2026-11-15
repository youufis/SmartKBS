/**
 * 文件作业的前端数据模型与展示辅助（不含组件）。
 *
 * 单独成文件是因为 react-refresh 要求组件文件只导出组件，
 * 否则热更新整页失效（改一行要重进页面）。
 */
import type { TaskInfo } from '../../types'
import * as tasksApi from '../../api/tasks'
import { pollAiTaskWithProgress } from '../../api/aiTask'

/** 教师未填维度时的默认四维（与后端 homework.DEFAULT_RUBRIC 同一口径） */
export const DEFAULT_DIMS = [
  { name: '内容切题', max: 40 },
  { name: '结构表达', max: 30 },
  { name: '规范完整', max: 20 },
  { name: '创意亮点', max: 10 },
]

/** 抽取状态 → 标签颜色 + 文案键（教师一眼知道哪些必须看原件）
 *
 * 这里只给键不给译文：本文件不是组件、拿不到 useTranslation 声明的命名空间，
 * 在模型层直接取词会让 i18n 护栏按默认命名空间去查，进而误报"缺词条"。
 */
export function statusMeta(status: string): { color: string; key: string } {
  switch (status) {
    case 'ok': return { color: 'success', key: 'hwStOk' }
    case 'image': return { color: 'processing', key: 'hwStImage' }
    case 'scanned': return { color: 'warning', key: 'hwStScanned' }
    case 'empty': return { color: 'warning', key: 'hwStEmpty' }
    case 'failed': return { color: 'error', key: 'hwStFailed' }
    default: return { color: 'default', key: 'hwStPending' }
  }
}

export const fmtSize = (n: number) => (n >= 1024 * 1024
  ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

export interface HomeworkValue {
  submit_mode: 'conversation' | 'file' | 'mixed'
  allowed_exts: string
  max_files: number
  max_file_mb: number
  deadline_at: string
  resubmit_limit: number
  allow_late: number
  total_score: number
  rubric: string
  grading_policy: 'ai_then_review' | 'manual_only' | 'ai_auto_publish'
}

export const emptyHomework = (): HomeworkValue => ({
  submit_mode: 'conversation', allowed_exts: '', max_files: 3, max_file_mb: 10,
  deadline_at: '', resubmit_limit: 3, allow_late: 1, total_score: 100, rubric: '',
  grading_policy: 'ai_then_review',
})

export const homeworkFromTask = (task: TaskInfo): HomeworkValue => ({
  submit_mode: (task.submit_mode || 'conversation') as HomeworkValue['submit_mode'],
  allowed_exts: task.allowed_exts || '',
  max_files: task.max_files ?? 3,
  max_file_mb: task.max_file_mb ?? 10,
  deadline_at: task.deadline_at || '',
  resubmit_limit: task.resubmit_limit ?? 3,
  allow_late: task.allow_late ?? 1,
  total_score: task.total_score ?? 100,
  rubric: task.rubric || '',
  grading_policy: (task.grading_policy || 'ai_then_review') as HomeworkValue['grading_policy'],
})

// 截止时间统一按后端口径存 'YYYY-MM-DD HH:MM:SS'（DatePicker 直接 format 出来）。
// 这里不再提供 parseDeadline：是否已截止一律由后端按服务器时间算好下发（P1-4），
// 前端自己比时钟会被学生改本机时间绕过，留着这个函数就是在引诱下一轮再写回前端判断。

/** 后台批改的产物（后端 _hw_grade_class / _hw_grade_one_student 的 result） */
export interface FileGradingResult {
  message?: string
  needs_review_students?: string[]
  similarity_pairs?: unknown[]
}

/**
 * 起一个文件作业后台批改任务并轮询到结束。
 *
 * 列表上的「AI 批改」按钮与批改台里的批量按钮共用这一份，避免两处各写一遍轮询与超时口径。
 * 文件作业走的是后台任务（不是同步长请求），全班几十人也能看到 done/total 进度。
 */
export async function startAndPollFileGrading(
  taskId: string,
  student?: string,
  onPhase?: (text: string) => void,
): Promise<FileGradingResult> {
  const res = await tasksApi.startFileGradingJob(taskId, student)
  const state = await pollAiTaskWithProgress(res.task_id, (p) => {
    if (p?.phase) onPhase?.(`${p.phase}${p.total ? ` ${p.done ?? 0}/${p.total}` : ''}`)
  }, 900000)
  return (state.result || {}) as FileGradingResult
}

/** 提交上限：作业限额 + 教师额外给这个学生的次数（0 = 不限） */
export const submitCeiling = (limit?: number, extra?: number): number => {
  const l = Number(limit || 0)
  return l ? l + Math.max(0, Number(extra || 0)) : 0
}
