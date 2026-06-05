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
