import type { ChatAttachment } from '../types'

/** 历史文件里的附件元数据：<!-- attachments: [...] -->（Markdown 里不可见，程序可解析） */
const ATTACH_RE = /<!--\s*attachments:\s*(\[[\s\S]*?\])\s*-->/

/** 组装注释行：没有有效附件时返回空串，避免历史文件里出现空注释 */
export function buildAttachmentsComment(list: ChatAttachment[] | undefined): string {
  const slim = (list || [])
    .filter((a) => a && a.f)
    .map((a) => ({ name: a.name, f: a.f, kind: a.kind, size: a.size || 0 }))
  if (!slim.length) return ''
  return `<!-- attachments: ${JSON.stringify(slim)} -->`
}

/** 从一条消息块里取出附件清单（老文件没有这段，返回空数组） */
export function parseAttachments(block: string): ChatAttachment[] {
  const m = ATTACH_RE.exec(block || '')
  if (!m) return []
  try {
    const arr = JSON.parse(m[1])
    if (!Array.isArray(arr)) return []
    return arr
      .filter((a) => a && a.f)
      .map((a) => ({
        name: String(a.name || ''),
        f: String(a.f),
        kind: a.kind === 'image' ? ('image' as const) : ('file' as const),
        size: Number(a.size) || 0,
      }))
  } catch {
    return []
  }
}

/** 历史正文里去掉注释，别把它当文字渲染出来 */
export function stripAttachmentsComment(text: string): string {
  return (text || '').replace(ATTACH_RE, '').trim()
}

/** 附件访问地址（相对路径 → 接口地址；token 由 authedFileUrl 统一附加） */
export function chatAssetUrl(f: string, download = false): string {
  return `/api/files/chat-asset?f=${encodeURIComponent(f)}${download ? '&dl=1' : ''}`
}

/** 字节数 → 可读体积 */
export function formatSize(bytes?: number): string {
  const n = Number(bytes) || 0
  if (n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}
