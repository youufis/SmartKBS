/**
 * 资源文件类型图标：根据扩展名返回相应的 antd 图标（资源浏览 / 文件中心 / 分类页共用）
 */
import React from 'react'
import {
  GlobalOutlined, FileImageOutlined, VideoCameraOutlined, SoundOutlined,
  FilePdfOutlined, FileWordOutlined, FileExcelOutlined, FilePptOutlined,
  FileZipOutlined, FileMarkdownOutlined, FileTextOutlined, CodeOutlined,
} from '@ant-design/icons'

import { EXT_KIND, KIND_COLOR } from './fileKind'


export function getFileIcon(
  nameOrPath: string,
  opts: { fontSize?: number; color?: string } = {},
): React.ReactElement {
  const base = String(nameOrPath || '').replace(/\\/g, '/').split('/').pop() || ''
  const ext = base.includes('.') ? (base.split('.').pop() || '').toLowerCase() : ''
  const kind = EXT_KIND[ext] || ''
  const style: React.CSSProperties = { fontSize: opts.fontSize, color: opts.color || KIND_COLOR[kind] || '#8c8c8c' }
  switch (kind) {
    case 'web': return <GlobalOutlined style={style} />
    case 'img': return <FileImageOutlined style={style} />
    case 'video': return <VideoCameraOutlined style={style} />
    case 'audio': return <SoundOutlined style={style} />
    case 'pdf': return <FilePdfOutlined style={style} />
    case 'word': return <FileWordOutlined style={style} />
    case 'excel': return <FileExcelOutlined style={style} />
    case 'ppt': return <FilePptOutlined style={style} />
    case 'zip': return <FileZipOutlined style={style} />
    case 'md': return <FileMarkdownOutlined style={style} />
    case 'code': return <CodeOutlined style={style} />
    default: return <FileTextOutlined style={style} />
  }
}

