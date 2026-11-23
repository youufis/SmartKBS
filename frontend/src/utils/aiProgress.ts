import type { AiTaskProgress } from '../api/aiTask'

/**
 * 把后台任务的 progress 结构翻成界面文案。
 *
 * 原本长在 QuestionBankPage 里，配图弹窗被抽成独立组件后两处都要用，
 * 因此下沉到 utils；仍然不直接用后端的中文 message（英文界面会露中文）。
 */
export function describeProgress(
  p: AiTaskProgress,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  switch (p.phase) {
    case 'generate':
      return t('pmProgGenerate')
    case 'svg':
      return t('pmProgSvg')
    case 'image':
      return t('pmProgImage', {
        model: p.model || '-',
        attempt: p.attempt ?? 1,
        maxAttempts: p.max_attempts ?? 3,
      })
    case 'download':
      return t('pmProgDownload')
    case 'fallback':
      return t('pmProgFallback')
    case 'media':
      if (p.total) return t('pmProgMedia', { done: p.done ?? 0, total: p.total })
      return t('pmProgWorking')
    case 'done':
      return t('pmProgDone')
    default:
      return t('pmProgWorking')
  }
}
