/**
 * 资源文件大类：按扩展名归类（资源浏览器分类、图标配色共用）
 * 与 fileIcon.tsx 分开存放，避免组件文件混导常量触发 react-refresh 规则
 */
export type FileKind =
  | 'web' | 'img' | 'video' | 'audio' | 'pdf' | 'word' | 'excel'
  | 'ppt' | 'zip' | 'md' | 'text' | 'code' | 'other'

export const EXT_KIND: Record<string, FileKind> = {
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

export const KIND_COLOR: Record<string, string> = {
  web: '#1677ff', img: '#13c2c2', video: '#722ed1', audio: '#eb2f96',
  pdf: '#f5222d', word: '#2f54eb', excel: '#52c41a', ppt: '#fa541c',
  zip: '#faad14', md: '#083fa1', text: '#8c8c8c', code: '#6b6bd6',
}

const base = (nameOrPath: string) =>
  String(nameOrPath || '').replace(/\\/g, '/').split('/').pop() || ''

/** 取扩展名对应的资源大类 */
export function getFileKind(nameOrPath: string): FileKind {
  const b = base(nameOrPath)
  const ext = b.includes('.') ? (b.split('.').pop() || '').toLowerCase() : ''
  return EXT_KIND[ext] || 'other'
}

/** 文档类（PDF/Word/表格/演示/Markdown/文本） */
export const DOC_KINDS: FileKind[] = ['pdf', 'word', 'excel', 'ppt', 'md', 'text']
/** 影音图片类 */
export const MEDIA_KINDS: FileKind[] = ['video', 'audio', 'img']
