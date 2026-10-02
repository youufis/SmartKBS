/**
 * AI 异步任务轮询工具
 * 用于轮询后台 AI 任务的结果
 */
import apiClient from './client'

/**
 * 轮询 AI 异步任务直到完成
 * @param taskId 任务 ID
 * @param maxWait 最大等待时间（毫秒），默认 120 秒
 * @returns 任务结果，失败或超时返回 null
 */
export async function pollAiTask(taskId: string, maxWait = 120000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const { data } = await apiClient.get(`/api/interaction/ai-task/${taskId}`)
      if (data.status === 'completed') return data.result
      if (data.status === 'failed') {
        console.error('AI 任务执行失败:', data.error)
        return { error: data.error || 'AI 任务执行失败' }
      }
    } catch {
      // 任务还未就绪，继续等待
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  console.error('AI 任务超时')
  return null
}

/** 后台任务上报的进度（后端只在任务主动上报时才带这个字段） */
export interface AiTaskProgress {
  phase?: string
  done?: number
  total?: number
  model?: string
  attempt?: number
  max_attempts?: number
  message?: string
  updated_at?: number
}

/** 任务完整状态 */
export interface AiTaskState {
  task_id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: any
  error?: string
  progress?: AiTaskProgress
}

/**
 * 带进度回调的轮询。与上面的 pollAiTask 有两点关键区别（都是踩过的坑）：
 * 1. 401/403（不是自己的任务）与 404（任务已过期）会**立即抛出**，不像旧实现被
 *    catch 吞掉后一路空转到超时，用户只能看到一句莫名的「超时」；
 * 2. 把 task.progress 交给 onProgress，长任务（出题+生图、单张配图）能显示 i/N。
 *
 * 超时抛出的错误带 aiTaskTimeout 标记：超时不等于失败，后台还在跑，
 * 提示"失败"会诱导教师重复提交，结果是重复入库 + 重复烧生图配额。
 */
export async function pollAiTaskWithProgress(
  taskId: string,
  onProgress?: (progress: AiTaskProgress) => void,
  maxWait = 600000,
  interval = 2000,
): Promise<AiTaskState> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    let data: AiTaskState
    try {
      const res = await apiClient.get(`/api/interaction/ai-task/${taskId}`)
      data = res.data
    } catch (e: any) {
      const status = e?.response?.status
      if (status === 401 || status === 403 || status === 404) throw e
      await new Promise(r => setTimeout(r, interval))   // 网络抖动，下一轮再试
      continue
    }
    if (data.progress && onProgress) onProgress(data.progress)
    if (data.status === 'completed') return data
    if (data.status === 'failed') {
      const err: any = new Error(data.error || 'AI task failed')
      err.aiTaskFailed = true
      throw err
    }
    await new Promise(r => setTimeout(r, interval))
  }
  const err: any = new Error('')
  err.aiTaskTimeout = true
  throw err
}

/**
 * 提交一个返回 {task_id} 的异步任务并轮询到完成，取回 result。
 * 用于「AI 生图 / 补 SVG」这类一次性长动作。
 */
export async function runAiTaskJob<T = any>(
  url: string,
  body: unknown = null,
  onProgress?: (progress: AiTaskProgress) => void,
  maxWait = 600000,
): Promise<T> {
  const { data } = await apiClient.post(url, body)
  const task = await pollAiTaskWithProgress(data.task_id, onProgress, maxWait)
  return task.result as T
}
