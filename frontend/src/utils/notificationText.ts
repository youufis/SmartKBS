/**
 * 通知文案本地化
 *
 * 后端写入的通知有两套文本：
 *   title / content —— 落库的原文（多为后端中文或教师填写的内容），老渲染器直接用
 *   payload        —— 可选的 {i18n, params}；params 只放"数据"（活动名、人名），
 *                      句式由前端词典按界面语言拼装
 * 带 payload 的通知在英文界面下走词典，词典缺项时回退原文；绝不把键名漏到界面上。
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

export interface NoticeLike {
  title: string
  content?: string
  payload?: string
}

interface NoticePayload {
  i18n?: string
  params?: Record<string, string | number>
}

function parsePayload(raw?: string): NoticePayload | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object' && typeof (v as NoticePayload).i18n === 'string') {
      return v as NoticePayload
    }
    return null
  } catch {
    return null
  }
}

export function useNoticeText() {
  const { t } = useTranslation('common')
  return useCallback(
    (item: NoticeLike) => {
      const p = parsePayload(item.payload)
      if (!p?.i18n) return { title: item.title, content: item.content || '' }
      const key = `notifications.i18n.${p.i18n}`
      const opts = { ...(p.params || {}), defaultValue: '' }
      return {
        title: t(`${key}.title`, opts) || item.title,
        content: t(`${key}.body`, opts) || item.content || '',
      }
    },
    [t],
  )
}
