/**
 * mediaEntries — 试题配图条目归一（配图管理面板与列表共用）
 *
 * 条目 = 「占位符」∪「media_files 里有图的 key」：
 *   - 万相直接配图（key=wanxiang）没有占位符，只按占位符渲染就会把它整个隐藏，
 *     教师看不到、删不掉、也点不了"重新生成"；
 *   - 出题时自动生成的图片，历史上只回写了 media_files、没回写占位符的 status，
 *     于是 status 缺失的条目既不显示图片也不给任何按钮（只剩删除）。
 * 因此：预览只看有没有 url，status 只决定标签，缺 status 时按 url 推断。
 */
import type { MediaFile, MediaPlaceholder } from '../types'

/** 配图面板里的一条条目 */
export interface MediaEntry {
  key: string
  description: string
  purpose?: string
  /** pending | generated | uploaded | failed | missing */
  status: string
  url?: string
  /** 是否有对应占位符（万相直接配图没有占位符） */
  fromPlaceholder: boolean
}

/** JSON 字段兼容层：不同接口有的已解析成数组、有的还是 JSON 字符串 */
export function toArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return []
}

/** 汇总占位符与媒体清单 → 面板要渲染的条目（占位符在前，多余的图片在后） */
export function buildMediaEntries(
  rawPlaceholders: unknown,
  rawMediaFiles: unknown,
): MediaEntry[] {
  const placeholders = toArray<MediaPlaceholder>(rawPlaceholders).filter(
    (p): p is MediaPlaceholder => !!p && typeof p === 'object' && !!p.key,
  )
  const files = toArray<MediaFile>(rawMediaFiles).filter(
    (f): f is MediaFile => !!f && typeof f === 'object' && !!f.key,
  )
  const entries: MediaEntry[] = placeholders.map(ph => {
    const file = files.find(f => f.key === ph.key)
    const url = file?.url
    const declared = String(ph.status || '').toLowerCase()
    let status = declared || (url ? 'generated' : 'pending')
    // 库里说图已生成、但清单没有条目，或后端标了 exists=false（文件已不在磁盘）：
    // 单独一个 missing 状态，让教师能直接重试，而不是摆一张破图
    if ((status === 'generated' || status === 'uploaded') && (!url || file?.exists === false)) {
      status = 'missing'
    }
    return {
      key: ph.key,
      description: ph.description || ph.key,
      purpose: ph.purpose,
      status,
      url,
      fromPlaceholder: true,
    }
  })

  const knownKeys = new Set(entries.map(e => e.key))
  files.forEach(f => {
    if (knownKeys.has(f.key) || !f.url) return
    // 万相直接配图这类"只有清单没有占位符"的条目：文件丢了也要能看见并删掉

    knownKeys.add(f.key)
    entries.push({
      key: f.key,
      description: f.alt || f.key,
      purpose: undefined,
      status: f.exists === false ? 'missing' : 'generated',
      url: f.url,
      fromPlaceholder: false,
    })
  })
  return entries
}
