/**
 * 资源文件类型图标：根据扩展名返回相应的 antd 图标（资源浏览 / 文件中心 / 分类页共用）
 */
import React from 'react'
import {
  GlobalOutlined, FileImageOutlined, VideoCameraOutlined, SoundOutlined,
  FilePdfOutlined, FileWordOutlined, FileExcelOutlined, FilePptOutlined,
  FileZipOutlined, FileMarkdownOutlined, FileTextOutlined, CodeOutlined,
  FolderOutlined,
} from '@ant-design/icons'

const EXT_KIND: Record<string, string> = {
  html: 'web', htm: 'web',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', bmp: 'img', webp: 'img',
  svg: 'img', ico: 'img', tif: 'img', tiff: 'img',
  mp4: 'video', avi: 'video', mov: 'video', wmv: 'video', flv: 'video', mkv: 'video', webm: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio',
  pdf: 'pdf',
  doc: 'word', docx: 'word',
  xls: 'excel', xlsx: 'excel', csv: 'excel',
  ppt: 'ppt', pptx: 'ppt',
  zip: 'zip', rar: 'zip', '7z': 'zip', tar: 'zip', gz: 'zip',
  md: 'md',
  txt: 'text',
  js: 'code', ts: 'code', tsx: 'code', jsx: 'code', json: 'code', py: 'code',
  java: 'code', c: 'code', cpp: 'code', h: 'code', go: 'code', rs: 'code', css: 'code',
}

const KIND_COLOR: Record<string, string> = {
  web: '#1677ff', img: '#13c2c2', video: '#722ed1', audio: '#eb2f96',
  pdf: '#f5222d', word: '#2f54eb', excel: '#52c41a', ppt: '#fa541c',
  zip: '#faad14', md: '#083fa1', text: '#8c8c8c', code: '#6b6bd6',
}

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

export { FolderOutlined }
