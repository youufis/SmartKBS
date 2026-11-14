import apiClient from './client'
import type { ChatAttachment } from '../types'

/** 预览 iframe 专用：附加缓存破坏参数，避免浏览器启发式缓存复用修复前的旧 HTML */
export const previewSrc = (url: string): string =>
  url + (url.includes('?') ? '&' : '?') + '_pv=2'

/** 内容源预览地址：资源 HTML 跑在独立 origin（跨域隔离替代 sandbox），Worker/wasm 原生运行；
 *  附带打开者 token 供桥补权（此前 iframe src 未带 token 是应用内预览 401 的直接原因） */
export const contentPreviewUrl = (url: string): string => {
  try {
    const u = new URL(url, location.href)
    const token = localStorage.getItem('smartkb_token') || ''
    const c = new URL(u.pathname + u.search, `${location.protocol}//${location.hostname}:8087`)
    if (token) c.searchParams.set('token', token)
    return c.href
  } catch { return url }
}

export interface PromotedAttachment extends ChatAttachment {
  /** 入档后的服务端绝对路径（发给模型读图用） */
  path: string
}

export interface PromoteResult {
  name: string
  f: string
  path?: string
  kind?: 'image' | 'file'
  size?: number
  error?: string
}

/** 把已发送的附件从临时区转入长期目录（与历史记录同寿命） */
export async function promoteChatAssets(
  items: { path: string; name: string }[],
): Promise<PromoteResult[]> {
  if (!items.length) return []
  const { data } = await apiClient.post('/api/files/promote', { items })
  return (data?.attachments || []) as PromoteResult[]
}
