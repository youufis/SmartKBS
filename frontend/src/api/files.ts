import apiClient from './client'
import type { ChatAttachment } from '../types'

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
