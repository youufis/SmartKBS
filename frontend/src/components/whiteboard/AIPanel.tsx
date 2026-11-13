/**
 * AI白板助手侧栏面板
 * 支持：流式对话、图示生成、一键板书、教学建议
 */
import { useTranslation } from 'react-i18next'
import { blobToDataUrl, collectText, detectPenCircles, shapePlainText, smartExcerptInCircle } from '../explore/selectionHelpers'
import i18n from '../../i18n'
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Input, Button, Typography, Space, Spin, Tag, Tooltip, Divider, Select } from 'antd'
import { message, modalApi as Modal } from '../../utils/feedback'
import {
  SendOutlined, RobotOutlined, CloseOutlined,
  PictureOutlined, FileTextOutlined, QuestionCircleOutlined,
  ClearOutlined, LoadingOutlined, StopOutlined,
  FullscreenOutlined, FullscreenExitOutlined,
  CopyOutlined, BulbOutlined, HighlightOutlined,
  EditOutlined, ApartmentOutlined, TranslationOutlined,
  RiseOutlined, ReloadOutlined, PlusSquareOutlined,
  ExpandAltOutlined, ShrinkOutlined,
} from '@ant-design/icons'
import VoiceInput from '../VoiceInput'
import KnowledgePointSelect from '../KnowledgePointSelect'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import * as whiteboardApi from '../../api/whiteboard'
import { useProgressModal } from './ProgressModal'
import useSubjectOptions from '../../hooks/useSubjectOptions'
import type { Editor } from 'tldraw'
import { Box } from 'tldraw'

// ── 统一错误转换：把各种错误转为友好、可操作的提示 ──
function friendlyError(err: any, defaultMsg: string = ''): string {
  const status = err?.response?.status
  const detail = err?.response?.data?.detail
  const isNetwork = !err?.response && (err?.message?.includes('Network') || err?.message?.includes('network'))

  if (status === 502 || status === 504 || isNetwork) {
    return i18n.t('discussion:aiTimeout')
  }
  if (status === 401) {
    return i18n.t('discussion:aiExpired')
  }
  if (status === 403) {
    return i18n.t('discussion:aiForbidden')
  }
  if (status === 400) {
    return detail || i18n.t('discussion:aiBadParams')
  }
  if (status === 500) {
    return detail || i18n.t('discussion:aiServerError')
  }
  return detail || err?.message || defaultMsg
}

const { Text } = Typography
const { TextArea } = Input

// TLDraw 形状颜色映射：将 hex 颜色转为 TLDraw 内置颜色名
const TL_COLORS = ['black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue',
  'yellow', 'orange', 'green', 'light-green', 'light-red', 'red', 'white'] as const
type TLColor = typeof TL_COLORS[number]

function toTLColor(hex: string): string {
  if (!hex || hex.startsWith('#')) {
    // 近似映射常见 hex 到 TLDraw 颜色
    const map: Record<string, TLColor> = {
      '#1a1a1a': 'black', '#000000': 'black', '#333333': 'black',
      '#1890ff': 'blue', '#1677ff': 'blue', '#096dd9': 'blue',
      '#52c41a': 'green', '#389e0d': 'green', '#237804': 'green',
      '#fa8c16': 'orange', '#faad14': 'orange', '#d48806': 'orange',
      '#f5222d': 'red', '#ff4d4f': 'red', '#cf1322': 'red',
      '#722ed1': 'violet', '#eb2f96': 'light-violet',
      '#e6f7ff': 'light-blue', '#f6ffed': 'light-green',
      '#fff7e6': 'orange', '#fff1f0': 'light-red',
      '#ffffff': 'white', '#f5f5f5': 'grey', '#d9d9d9': 'grey',
      '#e8f4f8': 'light-blue', '#f0f0f0': 'grey',
    }
    const key = hex?.toLowerCase() || ''
    if (map[key]) return map[key]
    // 如果没匹配到，根据色值智能判断
    if (hex) {
      const r = parseInt(hex.slice(1, 3), 16)
      const g = parseInt(hex.slice(3, 5), 16)
      const b = parseInt(hex.slice(5, 7), 16)
      if (r > 200 && g > 200 && b > 200) return 'grey'
      if (r > 200 && g < 100 && b < 100) return 'red'
      if (r < 100 && g > 150 && b < 100) return 'green'
      if (r < 100 && g < 100 && b > 150) return 'blue'
      if (r > 150 && g > 100 && b < 100) return 'orange'
    }
    return 'black'
  }
  // 已经是合法颜色名
  if (TL_COLORS.includes(hex as TLColor)) return hex
  return 'black'
}

// 修复形状 props，适配 TLDraw v5
function fixShapeProps(props: Record<string, any>): Record<string, any> {
  const result = { ...props }
  if (result.color) result.color = toTLColor(result.color)
  result.fill = toTLFill(result.fill)
  if (!result.geo) result.geo = 'rectangle'
  if (!result.w) result.w = 300
  if (!result.h) result.h = 50
  // TLDraw v5 用 richText 代替 text
  if (result.text) {
    result.richText = toRichText(result.text)
    delete result.text
  }
  // 删除 TLDraw v5 不支持的 props
  const invalidProps = ['fontSize', 'fontWeight', 'textAlign', 'lineHeight']
  for (const key of invalidProps) {
    delete result[key]
  }
  // 修复箭头 start/end（AI 可能输出为字符串而非对象）
  if (result.start && typeof result.start === 'string') {
    try { result.start = JSON.parse(result.start) } catch { result.start = { x: 0, y: 0 } }
  }
  if (result.end && typeof result.end === 'string') {
    try { result.end = JSON.parse(result.end) } catch { result.end = { x: 100, y: 0 } }
  }
  return result
}

// TLDraw v5 的 text 形状用 richText 而非 text，将 text 型转为 geo 矩形
function convertTextType(type: string): string {
  return type === 'text' ? 'geo' : type
}
// TLDraw v5 富文本格式（TipTap ProseMirror 文档格式）
function toRichText(text: string): any {
  if (!text) return { type: 'doc', content: [] }
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

/**
 * 提取形状上的文字，与后端 _extract_text 同口径。
 * 白板组件升级到 TLDraw v5 后，文字可能落在三种位置：
 *   props.richText —— ProseMirror 文档树（段落里还能再嵌 link/mention/列表，必须递归）
 *   props.richText —— 个别版本降级成的纯字符串
 *   props.label    —— geo/arrow/line 的标签，不走 richText
 * 之前这里只按「固定两层 content」取 richText，再退回 props.text，
 * 结果带标签的图形和嵌套结构的文字全部被当成空，AI 就报「白板为空」。
 */
function richDocText(node: any): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  if (node.type === 'text' && node.text) return String(node.text)
  const kids: any[] = Array.isArray(node.content) ? node.content : []
  if (!kids.length) return ''
  const joined = kids.map(richDocText).filter(Boolean).join('')
  return ['paragraph', 'doc', 'blockquote', 'list_item'].includes(node.type) ? joined + '\n' : joined
}

function shapeText(props: Record<string, any> | undefined): string {
  const p = props || {}
  let out = ''
  if (typeof p.richText === 'string') out = p.richText.trim()
  else if (p.richText && typeof p.richText === 'object') out = richDocText(p.richText).trim()
  if (!out) {
    for (const key of ['label', 'text']) {
      const v = (p as any)[key]
      if (typeof v === 'string' && v.trim()) { out = v.trim(); break }
      if (v && typeof v === 'object') {
        const nested = richDocText(v).trim()
        if (nested) { out = nested; break }
      }
    }
  }
  return out
}

// TLDraw 填充值枚举
const TL_FILLS = ['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill'] as const

function toTLFill(fill: any): string {
  if (!fill || fill === 'null' || fill === 'undefined') return 'none'
  if (TL_FILLS.includes(fill)) return fill
  return 'none'
}

function fixTextShapeProps(type: string, props: Record<string, any>): Record<string, any> {
  const result = { ...props }
  if (type === 'text') {
    return {
      geo: 'rectangle',
      w: result.w || 300,
      h: result.h || 40,
      color: result.color || 'black',
      fill: 'none',
      richText: toRichText(result.text || ''),
      size: result.size || 'm',
    }
  }
  return result
}

/**
 * 把白板当前页导出成 JPEG data URL，交给视觉模型「看图」。
 *
 * 为什么不是发坐标清单：手写题干、题目截图、文本框，只有渲染成一页画面
 * 才是 VL 模型真正认得的东西；坐标清单再详细也读不出手写笔迹。
 * 导出后统一压到最长边 1600 / 质量 0.82，避免几十 MB 的板书撑爆请求。
 */
async function exportPageImage(editor: Editor, maxEdge = 1600): Promise<string> {
  const shapes = editor.getCurrentPageShapes()
  if (!shapes.length) return ''
  const { blob } = await editor.toImage(shapes, {
    format: 'jpeg',
    quality: 0.9,
    background: true,
    padding: 16,
  })
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close?.()
    return ''
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  return canvas.toDataURL('image/jpeg', 0.82)
}

/**
 * 新插入的 AI 内容一律落在「已有板书最右侧」。板子上攒了几屏内容之后，
 * 这个位置离视口几千像素，创建完不把镜头移过去，老师看到的就是一片空白
 * ——「已生成思维导图（10 个节点）」但画布上什么都没有，就是这么来的。
 * 这里统一做两件事：选中新内容 + 缩放到合适大小。
 */
function focusNewShapes(editor: Editor, ids: (string | undefined)[]) {
  const clean = ids.filter(Boolean) as string[]
  if (!clean.length) return
  try {
    editor.setSelectedShapes(clean as any)
  } catch { /* 选中失败不影响已创建的内容 */ }
  try {
    const boxes = clean
      .map((id) => editor.getShapePageBounds(id as any))
      .filter((b) => !!b) as { x: number; y: number; w: number; h: number }[]
    if (!boxes.length) return
    const minX = Math.min(...boxes.map((b) => b.x))
    const minY = Math.min(...boxes.map((b) => b.y))
    const maxX = Math.max(...boxes.map((b) => b.x + b.w))
    const maxY = Math.max(...boxes.map((b) => b.y + b.h))
    editor.zoomToBounds(new Box(minX, minY, maxX - minX, maxY - minY), {
      inset: 64,
      animation: { duration: 220 },
    })
  } catch { /* 视口缩放失败也不该让「已插入」变成报错 */ }
}

/**
 * 弹窗里的「知识点」输入框：下拉选课程知识点，也可直接打字。
 * 复用全站统一的 KnowledgePointSelect（下拉 + 手输 + 逗号/顿号分词 + 按学科过滤），
 * 以前这两个弹窗是纯 TextArea，老师只能凭记忆手打，容易和课程树口径对不上。
 */
const KpPromptInput: React.FC<{
  subject?: string
  hint?: string
  onChange: (v: string) => void
}> = ({ subject, hint, onChange }) => {
  const [value, setValue] = useState('')
  return (
    <div>
      <KnowledgePointSelect
        multiple={false}
        subject={subject}
        value={value}
        onChange={(v) => {
          const next = String(v || '')
          setValue(next)
          onChange(next)
        }}
        style={{ width: '100%' }}
      />
      {hint && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>{hint}</div>
      )}
    </div>
  )
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  isStreaming?: boolean
  refs?: { doc_name?: string; title?: string }[]
}

/** 同一文档多切片命中只展示一次，最多 3 条 */
function uniqRefs(refs: { doc_name?: string; title?: string }[]): { doc_name?: string; title?: string }[] {
  const seen = new Set<string>()
  const out: { doc_name?: string; title?: string }[] = []
  for (const r of refs) {
    const k = (r.doc_name || '') + '|' + (r.title || '')
    if (!seen.has(k)) { seen.add(k); out.push(r) }
  }
  return out.slice(0, 3)
}

// ── 空态示例话题（P1 移植自探索画布）：按「用户名+日期+批次」做种子随机抽 3 条——人人不同、天天不同、同日稳定 ──
const WB_SAMPLE_POOL: { zh: string; en: string }[] = [
  { zh: '用生活例子讲讲今天最核心的概念', en: 'Explain today\'s core concept with an everyday example' },
  { zh: '这个知识点里最容易误解的地方是什么', en: 'What do students usually get wrong here' },
  { zh: '帮我想 3 个能引发讨论的课堂问题', en: 'Give me 3 discussion questions for class' },
  { zh: '把刚才的概念和上一章做个对比', en: 'Compare this concept with the last chapter' },
  { zh: '给我一个 5 分钟的课堂导入创意', en: 'Suggest a 5-minute lesson intro idea' },
  { zh: '出 2 道基础题和 1 道拓展题', en: 'Create 2 basic and 1 challenge question' },
  { zh: '用一个比喻讲清楚抽象的定义', en: 'Explain the abstract definition with one metaphor' },
  { zh: '下课前帮我梳理 3 条板书要点', en: 'Summarize 3 key takeaways before class ends' },
  { zh: '为什么学这个？给我一个让学生信服的理由', en: 'Why learn this? Give a reason students believe' },
  { zh: '设计一个不用电脑也能做的理解小活动', en: 'Design an unplugged activity to check understanding' },
]

function pickWbSamples(username: string, lang: string, nonce: number): string[] {
  const day = new Date().toISOString().slice(0, 10)
  const key = 'wb|' + username + '|' + day + '|' + nonce
  let h = 2166136261
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) }
  const rand = () => { h += 0x6D2B79F5; let x = h; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296 }
  const idx = WB_SAMPLE_POOL.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp
  }
  const isEn = !(lang || '').startsWith('zh')
  return idx.slice(0, 3).map((i) => (isEn ? WB_SAMPLE_POOL[i].en : WB_SAMPLE_POOL[i].zh))
}

interface Props {
  roomId: number
  visible: boolean
  onClose: () => void
  editorRef: React.MutableRefObject<Editor | null>
  isTeacher?: boolean
  kpName?: string
  subject?: string
  grade?: string
}

export const AIPanel: React.FC<Props> = ({
  roomId,
  visible,
  onClose,
  editorRef,
  isTeacher = false,
  kpName,
  subject: subjectProp,
  grade,
}) => {
  const { t } = useTranslation('discussion')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [useVision, setUseVision] = useState(false)  // 启用视觉模型理解白板
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)  // 防止并发发送
  // 供「重新生成」等回调读取最新消息，避免闭包拿到旧列表
  const messagesRef = useRef<Message[]>([])
  useEffect(() => { messagesRef.current = messages }, [messages])
  const progressModal = useProgressModal()

  // ── P1 新增：弹出专注窗（探索画布同款三态之一，白板常驻形态仍是侧栏） ──
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const [popMode, setPopMode] = useState(() => localStorage.getItem('smartkb_wb_ai_pop') === '1')
  const [winPos, setWinPos] = useState<{ x: number; y: number } | null>(null)
  const [wbRoll, setWbRoll] = useState(0)
  const myName = (() => { try { return String((JSON.parse(localStorage.getItem('smartkb_user') || '{}') as any).username || '') } catch { return '' } })()
  const wbLang = i18n.language
  const wbSamples = React.useMemo(() => pickWbSamples(myName, wbLang, wbRoll), [myName, wbRoll, wbLang])
  const dayKey = () => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return 'smartkb_wb_ai_used_' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }
  const [todayUsed, setTodayUsed] = useState(() => Number(localStorage.getItem(dayKey()) || '0') || 0)
  const bumpUsed = useCallback(() => {
    const k = dayKey()
    const n = Number(localStorage.getItem(k) || '0') + 1
    localStorage.setItem(k, String(n))
    setTodayUsed(n)
  }, [])
  // 弹出=专注对话：tldraw 工具栏/样式面板让位（body 类控制，收回即恢复画图工具）
  useEffect(() => {
    const cls = 'wb-ai-pop'
    if (visible && popMode) document.body.classList.add(cls)
    else document.body.classList.remove(cls)
    return () => document.body.classList.remove(cls)
  }, [visible, popMode])

  // 学科口径：默认「自动判断」，由后端按教师任教学科/白板内容收敛；老师也能临时切换某一科。
  // 以前这里由房间页写死传 "通用技术"，其他学科的老师问什么都被当成通用技术作答。
  const [subjectSel, setSubjectSel] = useState<string>(
    () => localStorage.getItem('smartkb_wb_subject') || '',
  )
  const { subjects: subjectOptions } = useSubjectOptions()
  const subject = subjectSel || subjectProp || ''

  /**
   * AI 请求一律带上浏览器里的当前快照。
   * 服务端那份是异步副本：WS 约 1s、HTTP 兜底 30s 才写一次，后端重启后内存房间还会清空，
   * 只读副本就会出现「板子上明明有内容，AI 说白板是空的」。
   */
  const boardSnapshot = useCallback((): string => {
    try {
      const ed = editorRef.current
      return ed ? JSON.stringify(ed.getSnapshot()) : ''
    } catch {
      return ''
    }
  }, [editorRef])

  // 圈选感知 + 上下文提示条（防抖 250ms，相机移动不重算）
  const [selCount, setSelCount] = useState(0)
  const [ctxHint, setCtxHint] = useState('')
  const lastDrawsRef = useRef<{ id: string; ts: number }[]>([])
  const prefillTimer = useRef(0)
  const inputValRef = useRef('')
  useEffect(() => { inputValRef.current = input }, [input])
  const refreshHint = useCallback(() => {
    const ed = editorRef.current
    if (!ed || !visible) { setSelCount(0); setCtxHint(''); return }
    let n = 0
    try { n = ed.getSelectedShapeIds().length } catch { /* ignore */ }
    setSelCount(n)
    if (n > 0) setCtxHint(t('aiSelHint', { n }))
    else if (lastDrawsRef.current.some((r) => Date.now() - r.ts < 90000)) setCtxHint(t('aiCircleHint'))
    else setCtxHint('')
  }, [editorRef, visible, t])
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || !visible) { setSelCount(0); setCtxHint(''); return }
    let tm = 0
    const off = ed.store.listen(() => { window.clearTimeout(tm); tm = window.setTimeout(refreshHint, 250) }, { source: 'user', scope: 'all' })
    const t0 = window.setTimeout(refreshHint, 300)
    return () => { off?.(); window.clearTimeout(tm); window.clearTimeout(t0) }
  }, [editorRef, visible, refreshHint])

  // 笔画圈（P1 移植自探索画布）：圈住内容 90 秒内自动提取文字填入输入框
  useEffect(() => {
    if (!visible) return
    const onDraw = (ev: Event) => {
      const id = (ev as CustomEvent).detail?.id
      if (id) { lastDrawsRef.current.push({ id, ts: Date.now() }); if (lastDrawsRef.current.length > 8) lastDrawsRef.current.shift() }
      refreshHint()
      window.clearTimeout(prefillTimer.current)
      prefillTimer.current = window.setTimeout(() => {
        const e3 = editorRef.current
        if (!e3 || inputValRef.current.trim()) return
        const circ = detectPenCircles(e3, lastDrawsRef.current)
        if (!circ || !circ.inside.length) return
        // ① 智能提取：只取落在圈内的文字；② 取不到再退回圈内首行
        let excerpt = smartExcerptInCircle(e3, circ)
        if (!excerpt) {
          const lines = circ.inside
            .map((sh: any) => shapePlainText({ type: String(sh.type), props: sh.props as Record<string, unknown> }))
            .join('\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 1)
          excerpt = (lines[0] || '').replace(/[#*·]/g, '').trim().slice(0, 80)
        }
        if (!excerpt) return
        setInput(excerpt)
        setCtxHint(t('aiCircleFilled'))
        window.setTimeout(() => inputRef.current?.focus?.(), 60)
      }, 700)
    }
    window.addEventListener('wb:draw-created', onDraw)
    return () => {
      window.removeEventListener('wb:draw-created', onDraw)
      window.clearTimeout(prefillTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, refreshHint])

  // 计算右侧空白区域起始位置：遍历已有形状，取最右侧边界 + 间距
  const getRightSidePosition = useCallback((editor: Editor) => {
    let rightEdge = 50
    try {
      const existing = editor.getCurrentPageShapes()
      if (existing && existing.length > 0) {
        for (const shape of existing) {
          const bounds = editor.getShapePageBounds(shape.id)
          if (bounds) {
            const edge = bounds.x + bounds.w
            if (edge > rightEdge) rightEdge = edge
          }
        }
      }
    } catch { /* 静默降级 */ }
    return { x: rightEdge + 60, y: 60 }
  }, [])

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  // 清空对话
  const handleClear = useCallback(() => {
    setMessages([])
    setStreamingText('')
  }, [])

  // 语音输入回调
  const handleVoiceTranscript = useCallback((text: string) => {
    setInput((prev) => prev + text)
    inputRef.current?.focus()
  }, [])

  // 停止生成
  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    sendingRef.current = false
    setLoading(false)
    setMessages((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].isStreaming) {
        return prev.map((m) => ({ ...m, isStreaming: false }))
      }
      return prev
    })
    setStreamingText('')
  }, [])

  /** 把消息列表压成「最近几轮」上下文，太长的单条截断，避免请求体膨胀 */
  const toHistory = useCallback((rows: Message[], limit = 6) => {
    return rows
      .filter((m) => m.content.trim())
      .slice(-limit)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }))
  }, [])

  /**
   * 统一的白板问答执行器：直接提问与「重新生成」共用一条链路。
   * userText 传 null 表示不追加用户气泡（重新生成时原问题还在列表里）。
   */
  const runChat = useCallback(async (
    modelPrompt: string,
    userText: string | null,
    history: { role: 'user' | 'assistant'; content: string }[],
    withPageImage = false,
  ) => {
    if (sendingRef.current) return
    sendingRef.current = true
    bumpUsed()
    setLoading(true)
    setStreamingText('')
    if (userText) setMessages((prev) => [...prev, { role: 'user', content: userText }])

    const abortController = new AbortController()
    abortRef.current = abortController

    // 「🧠 结合画面」开着时，普通提问也把整页截图带上
    let pageImage = ''
    if (withPageImage) {
      const ed = editorRef.current
      if (ed) {
        try {
          pageImage = await exportPageImage(ed)
        } catch {
          pageImage = ''
        }
      }
    }

    // 圈选优先：有选中内容只带选区截图（整页文字清单反而干扰模型）；
    // 没选东西时识别 90 秒内的笔画圈（探索画布同款）；都没有才回退整页逻辑
    let snapshotArg = boardSnapshot()
    let circleNote = ''
    const ed0 = editorRef.current
    if (!pageImage && ed0) {
      let focus: any[] = ed0.getSelectedShapes() as any[]
      let circMode = false
      const onlyDraws = focus.length > 0 && focus.every((sh) => String(sh.type) === 'draw')
      if (!focus.length || onlyDraws) {
        const circ = detectPenCircles(ed0, lastDrawsRef.current)
        if (circ) { focus = [circ.draw, ...circ.inside]; circMode = true }
      }
      if (focus.length) {
        try {
          const { blob } = await ed0.toImage(focus as never, { format: 'jpeg', quality: 0.88, background: true, padding: 12 })
          pageImage = await blobToDataUrl(blob, 1400)
          // snapshot 参数后端按 JSON 解析（解析失败静默丢），圈选说明必须并进 prompt 才进得了模型
          snapshotArg = '{}'
          if (circMode) {
            const insideText = collectText(focus)
            circleNote = '（用户在白板上用笔圈了一块区域；配图里的笔圈就是圈选范围'
              + (insideText ? '，圈内文字：' + insideText : '')
              + '，请聚焦被圈住的部分作答）\n'
          }
        } catch { /* 选区导出失败则保持原逻辑 */ }
      }
    }
    let refs: { doc_name?: string; title?: string }[] = []

    let fullContent = ''
    try {
      await whiteboardApi.aiChatStream(
        circleNote ? circleNote + modelPrompt : modelPrompt,
        roomId,
        (delta) => {
          // 后端返回的是累计文本，直接替换
          fullContent = delta
          setStreamingText(fullContent)
        },
        () => {
          if (!fullContent) return
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: fullContent, refs },
          ])
          setStreamingText('')
          setLoading(false)
          sendingRef.current = false
        },
        (error) => {
          if (fullContent) {
            setMessages((prev) => [
              ...prev,
              { role: 'assistant', content: fullContent + `\n\n[${t('aiErrPrefix')}: ${error}]` },
            ])
          } else {
            message.error(error)
          }
          setStreamingText('')
          setLoading(false)
          sendingRef.current = false
        },
        {
          kpName,
          subject,
          signal: abortController.signal,
          useVision,
          snapshot: snapshotArg,
          history,
          pageImage,
          onReferences: (items) => { refs = items },
        },
      )
    } finally {
      sendingRef.current = false
      setLoading(false)
    }
  }, [roomId, kpName, subject, useVision, editorRef, boardSnapshot, bumpUsed, t])

  // 发送对话消息
  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || loading || sendingRef.current) return
    const history = toHistory(messages)
    setInput('')
    await runChat(text, text, history, useVision)
  }, [input, loading, messages, runChat, toHistory, useVision])

  // 重新生成：丢掉这条回答及其后内容，用同一个问题再问一次
  const handleRegenerate = useCallback(async (index: number) => {
    const rows = messagesRef.current
    let userIdx = -1
    for (let i = index - 1; i >= 0; i -= 1) {
      if (rows[i].role === 'user') { userIdx = i; break }
    }
    if (userIdx < 0) return
    const prompt = rows[userIdx].content
    setMessages(rows.slice(0, index))
    await runChat(prompt, null, toHistory(rows.slice(0, userIdx)), useVision)
  }, [runChat, toHistory, useVision])

  // 把 AI 的回答直接贴成白板上的一个卡片：讲完就留在板书上，不用手抄
  const handleInsertToBoard = useCallback((text: string) => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }
    const plain = text
      .replace(/```[\s\S]*?```/g, '（代码块见对话）')
      .replace(/\*\*|__|`|^#{1,6}\s*/gm, '')
      .trim()
      .slice(0, 600)
    if (!plain) return
    const pos = getRightSidePosition(editor)
    const lineCount = plain.split('\n').filter((x) => x.trim()).length
    const answerId = `shape:ai-answer-${Date.now()}`
    editor.createShapes([{
      id: answerId,
      type: 'geo',
      x: pos.x,
      y: pos.y,
      props: {
        geo: 'rectangle',
        w: 380,
        h: Math.min(560, Math.max(90, 36 + lineCount * 22)),
        color: 'black',
        fill: 'none',
        size: 's',
        richText: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: plain }] }],
        },
      },
    }] as any)
    focusNewShapes(editor, [answerId])
    message.success(t('aiInserted'))
  }, [editorRef, getRightSidePosition, t])

  // 一键生成图示（流式进度版，防止 IIS 超时）
  const handleGenerateDiagram = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }
    // 弹窗让老师选/填图示主题（可下拉选课程知识点，也可直接输入）
    let picked = ''
    const desc = await new Promise<string>((resolve) => {
      Modal.confirm({
        title: t('aiFigModalTitle'),
        content: (
          <KpPromptInput
            subject={subject}
            hint={t('aiFigPh')}
            onChange={(v) => { picked = v }}
          />
        ),
        okText: t('aiGen'),
        cancelText: t('aiCancel'),
        onOk: () => resolve(picked),
        onCancel: () => resolve(''),
      })
    })
    if (!desc) return

    // ── 启动流式生成（SSE 进度） ──
    const abortController = new AbortController()

    progressModal.startProgress({
      title: t('aiFigProgressTitle'),
      steps: [
        { key: 'analyze', label: t('aiStepAnalyzeReq'), status: 'active' },
        { key: 'generate', label: t('aiStepGenFig'), status: 'pending' },
        { key: 'insert', label: t('aiStepInsert'), status: 'pending' },
      ],
      onCancel: () => abortController.abort(),
    })

    try {
      await whiteboardApi.aiGenerateDiagramStream(
        desc,
        subject,
        {
          onProgress: (phase, message) => {
            progressModal.updateMessage(message)
            if (phase === 'analyzing') {
              progressModal.updateStep('analyze', 'active')
            } else if (phase === 'svg' || phase === 'image_gen') {
              progressModal.updateStep('analyze', 'done')
              progressModal.updateStep('generate', 'active')
            }
          },
          onResult: async (result) => {
            progressModal.updateStep('analyze', 'done')
            progressModal.updateStep('generate', 'done')
            progressModal.updateStep('insert', 'active')
            progressModal.updateMessage(t('aiInserting'))

            try {
              if (result.mode === 'svg' && result.svg) {
                // ── SVG 模式 ──
                await editor.putExternalContent({
                  type: 'svg-text',
                  text: result.svg,
                } as any)
                progressModal.updateStep('insert', 'done')
                progressModal.markSuccess()
                setMessages((prev) => [
                  ...prev,
                  { role: 'user', content: `📐 ${t('aiCmdFig')}: ${desc}` },
                  { role: 'assistant', content: t('aiDoneFigSvg', { title: result.title || '' }) },
                ])

              } else if (result.mode === 'image' && result.image_url) {
                // ── 图片模式 ──
                await editor.putExternalContent({
                  type: 'url',
                  url: result.image_url,
                } as any)
                progressModal.updateStep('insert', 'done')
                progressModal.markSuccess()
                setMessages((prev) => [
                  ...prev,
                  { role: 'user', content: `📐 ${t('aiCmdFig')}: ${desc}` },
                  { role: 'assistant', content: t('aiDoneFigImg', { title: result.title || '' }) },
                ])

              } else {
                progressModal.updateStep('insert', 'error')
                progressModal.markError(t('aiNoValidFig'))
                setMessages((prev) => [
                  ...prev,
                  { role: 'user', content: `📐 ${t('aiCmdFig')}: ${desc}` },
                  { role: 'assistant', content: result.error || t('aiGenFailed') },
                ])
              }
            } catch (insertErr: any) {
              progressModal.updateStep('insert', 'error')
              progressModal.markError(friendlyError(insertErr, t('aiInsertRetry')))
            }
          },
          onError: (error) => {
            progressModal.updateStep('generate', 'error')
            progressModal.markError(error)
            setMessages((prev) => [
              ...prev,
              { role: 'user', content: `📐 ${t('aiCmdFig')}: ${desc}` },
              { role: 'assistant', content: `${t('aiGenFailed')}: ${error}` },
            ])
          },
        },
        { signal: abortController.signal, roomId },
      )
    } catch (err: any) {
      if (err.name === 'AbortError') {
        progressModal.markError(t('aiCancelled'))
        return
      }
      console.error('[AI生成图示]', err)
      progressModal.updateStep('generate', 'error')
      progressModal.markError(friendlyError(err, t('aiFigFailed')))
    }
  }, [editorRef, subject, roomId, progressModal])

  // 一键生成板书（带进度模态框）
  const handleGenerateBoard = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }

    // 如果没有知识点名称，弹窗让教师选/填（下拉课程知识点，也可直接输入）
    let topic = kpName
    if (!topic) {
      let pickedTopic = ''
      topic = await new Promise<string>((resolve) => {
        Modal.confirm({
          title: t('aiBoardModalTitle'),
          content: (
            <KpPromptInput
              subject={subject}
              hint={t('aiBoardPh')}
              onChange={(v) => { pickedTopic = v }}
            />
          ),
          okText: t('aiGen'),
          cancelText: t('aiCancel'),
          onOk: () => resolve(pickedTopic),
          onCancel: () => resolve(''),
        })
      })
      if (!topic) return
    }

    const abortController = new AbortController()
    progressModal.startProgress({
      title: t('aiBoardProgressTitle'),
      steps: [
        { key: 'generate', label: t('aiStepGenBoard'), status: 'active' },
        { key: 'insert', label: t('aiStepInsert'), status: 'pending' },
      ],
      onCancel: () => abortController.abort(),
    })

    try {
      const result = await whiteboardApi.aiGenerateBoard(topic, subject || '', grade || '', roomId)
      progressModal.updateStep('generate', 'done')

      if (result.shapes && result.shapes.length > 0) {
        progressModal.updateStep('insert', 'active')
        progressModal.updateMessage(t('aiInsertShapes', { count: result.shapes.length }))

        // 直接插入白板，不再弹二次确认
        const pos = getRightSidePosition(editor)
        const shapes = result.shapes.map((s: any, index: number) => {
          const shapeId = `shape:ai-board-${Date.now()}-${index}`
          const fixedType = convertTextType(s.type)
          const finalType = fixedType === 'geo' ? 'geo' : 'geo'
          const shapeProps = { ...fixTextShapeProps(s.type, fixShapeProps(s.props || {})) }
          if (finalType === 'geo' && !shapeProps.richText) {
            shapeProps.richText = { type: 'doc', content: [] }
          }
          return {
            id: shapeId,
            type: finalType,
            x: (s.x || 100) + pos.x - 50,
            y: (s.y || 100 + index * 80) + pos.y - 60,
            props: shapeProps,
          } as Record<string, any>
        })
        editor.createShapes(shapes as any)
        focusNewShapes(editor, shapes.map((s: any) => s.id))
        progressModal.updateStep('insert', 'done')
        progressModal.markSuccess()
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: `📝 ${t('aiCmdBoard')}: ${topic}` },
          { role: 'assistant', content: t('aiDoneBoard', { title: result.title, count: shapes.length }) },
        ])
      } else {
        progressModal.updateStep('insert', 'error')
        progressModal.markError(t('aiNoValidBoard'))
      }
    } catch (err: any) {
      console.error('[AI一键板书]', err)
      progressModal.markError(friendlyError(err, t('aiBoardFailed')))
    }
  }, [editorRef, kpName, subject, grade, roomId, progressModal, getRightSidePosition])

  // 板书美化+自动排版（带进度模态框）
  const handleBeautify = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }

    const abortController = new AbortController()
    progressModal.startProgress({
      title: t('aiBeautifyTitle'),
      steps: [
        { key: 'analyze', label: t('aiStepAnalyzeBoard'), status: 'active' },
        { key: 'generate', label: t('aiStepLayout'), status: 'pending' },
        { key: 'insert', label: t('aiStepReplace'), status: 'pending' },
      ],
      onCancel: () => abortController.abort(),
    })

    try {
      const result = await whiteboardApi.aiBeautifyBoard(roomId, subject, boardSnapshot())
      progressModal.updateStep('analyze', 'done')
      progressModal.updateStep('generate', 'done')

      if (result.shapes && result.shapes.length > 0) {
        progressModal.updateStep('insert', 'active')
        progressModal.updateMessage(t('aiReplacingShapes', { count: result.shapes.length }))

        // 删除原有形状
        const oldIds = editor.getCurrentPageShapeIds()
        if (oldIds.size > 0) {
          editor.deleteShapes(Array.from(oldIds))
        }
        // 插入美化后的形状
        const shapes = result.shapes.map((s: any, index: number) => {
          const shapeId = `shape:beautify-${Date.now()}-${index}`
          const shapeProps = { ...fixTextShapeProps(s.type, fixShapeProps(s.props || {})) }
          if (!shapeProps.richText && shapeProps.text) {
            shapeProps.richText = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: shapeProps.text }] }] }
            delete shapeProps.text
          }
          return {
            id: shapeId,
            type: 'geo',
            x: s.x || 100,
            y: s.y || 100 + index * 80,
            props: shapeProps,
          } as Record<string, any>
        })
        editor.createShapes(shapes as any)
        progressModal.updateStep('insert', 'done')
        progressModal.markSuccess()
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: '🎨 ' + t('aiCmdBeautify') },
          { role: 'assistant', content: t('aiDoneBeautify', { title: result.title, count: shapes.length }) },
        ])
      } else {
        progressModal.updateStep('insert', 'error')
        progressModal.markError(t('aiNoValidBeautify'))
      }
    } catch (err: any) {
      console.error('[AI美化排版]', err)
      progressModal.markError(friendlyError(err, t('aiBeautifyFailed')))
    }
  }, [editorRef, roomId, subject, progressModal])

  // 随堂提问（带进度模态框）
  const handleQuiz = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }

    const abortController = new AbortController()
    progressModal.startProgress({
      title: t('aiQuizTitle'),
      steps: [
        { key: 'analyze', label: t('aiStepAnalyzeQuiz'), status: 'active' },
        { key: 'generate', label: t('aiStepGenQuiz'), status: 'pending' },
        { key: 'insert', label: t('aiStepPublish'), status: 'pending' },
      ],
      onCancel: () => abortController.abort(),
    })

    try {
      const result = await whiteboardApi.aiGenerateQuiz(roomId, subject, kpName, boardSnapshot())
      progressModal.updateStep('analyze', 'done')
      progressModal.updateStep('generate', 'done')

      if (result.error) {
        progressModal.markError(result.error)
        return
      }
      if (!result.question) {
        progressModal.markError(t('aiNoValidQuiz'))
        return
      }

      progressModal.updateStep('insert', 'active')
      progressModal.updateMessage(t('aiPublishing'))

      // ── 将题目写入白板画布，同步展示给学生 ──
      const labels = ['A', 'B', 'C', 'D']
      const maxW = 500

      // 动态计算位置：放在所有已有内容的右侧空白区
      const pos = getRightSidePosition(editor)
      const startX = pos.x
      const startY = pos.y

      const shapes: any[] = []
      const now = Date.now()

      // 标题
      shapes.push({
        id: `shape:quiz-title-${now}`,
        type: 'geo',
        x: startX,
        y: startY,
        props: {
          geo: 'rectangle',
          w: maxW,
          h: 48,
          color: 'blue',
          fill: 'none',
          size: 'xl',
          richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '🎯 随堂提问' }] }] },
        },
      })

      // 题目文本（自动换行，高度根据文字长度估算）
      const lineHeight = 24
      const questionLines = Math.ceil((result.question.length || 1) / 30) + 1
      const questionH = Math.max(60, questionLines * lineHeight + 20)
      const questionY = startY + 48 + 10
      shapes.push({
        id: `shape:quiz-question-${now}`,
        type: 'geo',
        x: startX,
        y: questionY,
        props: {
          geo: 'rectangle',
          w: maxW,
          h: questionH,
          color: 'black',
          fill: 'none',
          size: 'm',
          richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: result.question }] }] },
        },
      })

      // 选项
      const optStartY = questionY + questionH + 12
      const optH = 42
      const optGap = 8
      result.options?.forEach((opt: string, i: number) => {
        const cleanOpt = opt.replace(/^[A-D][.、\s]*/, '')
        shapes.push({
          id: `shape:quiz-opt-${now}-${i}`,
          type: 'geo',
          x: startX,
          y: optStartY + i * (optH + optGap),
          props: {
            geo: 'rectangle',
            w: maxW,
            h: optH,
            color: i === result.correct_index ? 'green' : 'grey',
            fill: i === result.correct_index ? 'solid' : 'none',
            size: 'm',
            richText: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `${labels[i]}. ${cleanOpt}` }] }],
            },
          },
        })
      })

      // 答案解析
      const explY = optStartY + ((result.options?.length || 4)) * (optH + optGap) + 10
      if (result.explanation) {
        shapes.push({
          id: `shape:quiz-expl-${now}`,
          type: 'geo',
          x: startX,
          y: explY,
          props: {
            geo: 'rectangle',
            w: maxW,
            h: 48,
            color: 'orange',
            fill: 'none',
            size: 'm',
            richText: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `💡 ${result.explanation}` }] }],
            },
          },
        })
      }

      // 写入白板
      editor.createShapes(shapes)
      focusNewShapes(editor, shapes.map((s: any) => s.id))
      progressModal.updateStep('insert', 'done')
      progressModal.markSuccess()

      setMessages((prev) => [
        ...prev,
        { role: 'user', content: '🎯 ' + t('aiCmdQuiz') },
        { role: 'assistant', content: `**${t('aiQuizQ')}**：${result.question}\n\n**${t('aiQuizA')}**：${result.options?.[result.correct_index] || ''}` },
      ])
    } catch (err: any) {
      console.error('[AI随堂提问]', err)
      progressModal.markError(friendlyError(err, t('aiQuizFailed')))
    }
  }, [editorRef, roomId, subject, kpName, progressModal, getRightSidePosition])

  // 解答题目：把整页画面 + 板上的图片一起交给视觉模型解析
  const handleSolveQuestion = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }
    if (loading || sendingRef.current) return
    sendingRef.current = true

    const prompt = '请认真查看白板上的题目（包括图片、手写和文字），逐步解答这道题，给出详细的解析过程和最终答案。'
    const history = toHistory(messagesRef.current)
    setMessages((prev) => [...prev, { role: 'user', content: '📝 ' + t('aiCmdSolve') }])
    setLoading(true)
    setStreamingText('')

    // 整页截图是这里的关键输入：手写题干、题目图片只有渲染后才认得出
    let pageImage = ''
    try {
      pageImage = await exportPageImage(editor)
    } catch {
      // 导出失败就退回纯文字描述，不要让整个「解答题目」挂掉
    }

    const abortController = new AbortController()
    abortRef.current = abortController

    let fullContent = ''
    try {
      await whiteboardApi.aiChatStream(
        prompt,
        roomId,
        (delta) => {
          fullContent = delta
          setStreamingText(fullContent)
        },
        () => {
          if (!fullContent) return
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: fullContent },
          ])
          setStreamingText('')
          setLoading(false)
        },
        (error) => {
          if (fullContent) {
            setMessages((prev) => [
              ...prev,
              { role: 'assistant', content: fullContent + `\n\n[${t('aiErrPrefix')}: ${error}]` },
            ])
          } else {
            message.error(error)
          }
          setStreamingText('')
          setLoading(false)
        },
        {
          kpName,
          subject,
          signal: abortController.signal,
          snapshot: boardSnapshot(),
          history,
          pageImage,
        },
      )
    } finally {
      sendingRef.current = false
      setLoading(false)
    }
  }, [editorRef, roomId, kpName, subject, loading, boardSnapshot, toHistory])

  // 智能批注：分析选中内容并添加标注（带进度模态框）
  const handleSmartAnnotation = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }

    const selectedShapes = editor.getSelectedShapes()
    if (!selectedShapes || selectedShapes.length === 0) {
      message.warning(t('aiSelectFirst'))
      return
    }

    // 提取选中形状的文字描述
    const desc = selectedShapes.map((s: any) => {
      const props = s.props || {}
      const text = shapeText(props)
      return `[${s.type}] 位置(${Math.round(s.x)},${Math.round(s.y)}) 文字: ${text}`
    }).join('\n')

    const abortController = new AbortController()
    progressModal.startProgress({
      title: t('aiAnnoTitle'),
      steps: [
        { key: 'analyze', label: t('aiStepAnalyzeSel'), status: 'active' },
        { key: 'generate', label: t('aiStepGenAnno'), status: 'pending' },
        { key: 'insert', label: t('aiStepAddAnno'), status: 'pending' },
      ],
      onCancel: () => abortController.abort(),
    })

    try {
      const result = await whiteboardApi.aiSmartAnnotation(desc)
      progressModal.updateStep('analyze', 'done')
      progressModal.updateStep('generate', 'done')

      if (result.label_text) {
        progressModal.updateStep('insert', 'active')
        progressModal.updateMessage(t('aiAddingAnno'))

        // 在选中区域旁边创建批注形状
        const selBounds = editor.getSelectionPageBounds()
        const ax = (selBounds?.x || 100) + (selBounds?.w || 200) + 20
        const ay = selBounds?.y || 100
        editor.createShapes([{
          id: `shape:annotation-${Date.now()}`,
          type: 'geo',
          x: ax,
          y: ay,
          props: {
            geo: 'rectangle',
            w: 280,
            h: 80,
            color: 'orange',
            fill: 'none',
            size: 'm',
            richText: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `📌 ${result.label_text}` }] }],
            },
          },
        }] as any)
        progressModal.updateStep('insert', 'done')
        progressModal.markSuccess()
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: '📌 ' + t('aiCmdAnno') },
          { role: 'assistant', content: `**${t('aiAnnoLabel')}**：${result.label_text}\n\n**${t('aiAnnoSummary')}**：${result.summary || ''}` },
        ])
      } else {
        progressModal.updateStep('generate', 'error')
        progressModal.markError(result.summary || t('aiNoValidAnno'))
      }
    } catch (err: any) {
      console.error('[AI智能批注]', err)
      progressModal.markError(friendlyError(err, t('aiAnnoFailed')))
    }
  }, [editorRef, progressModal])

  // 生成思维导图（带进度模态框）
  const handleGenerateMindmap = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }

    const abortController = new AbortController()
    progressModal.startProgress({
      title: t('aiMindTitle'),
      steps: [
        { key: 'analyze', label: t('aiStepAnalyzeBoard'), status: 'active' },
        { key: 'generate', label: t('aiStepGenMind'), status: 'pending' },
        { key: 'insert', label: t('aiStepInsert'), status: 'pending' },
      ],
      onCancel: () => abortController.abort(),
    })

    try {
      const result = await whiteboardApi.aiGenerateMindmap(roomId, subject, boardSnapshot())
      progressModal.updateStep('analyze', 'done')
      progressModal.updateStep('generate', 'done')

      if (result.shapes && result.shapes.length > 0) {
        progressModal.updateStep('insert', 'active')
        progressModal.updateMessage(t('aiInsertNodes', { count: result.shapes.length }))

        const pos = getRightSidePosition(editor)
        const shapes = result.shapes.map((s: any, index: number) => {
          const shapeId = `shape:mindmap-${Date.now()}-${index}`
          const shapeProps = { ...fixTextShapeProps(s.type, fixShapeProps(s.props || {})) }
          if (!shapeProps.richText && shapeProps.text) {
            shapeProps.richText = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: shapeProps.text }] }] }
            delete shapeProps.text
          }
          return {
            id: shapeId,
            type: 'geo',
            x: (s.x || 100) + pos.x - 50,
            y: (s.y || 100 + index * 80) + pos.y - 60,
            props: shapeProps,
          } as Record<string, any>
        })
        editor.createShapes(shapes as any)
        focusNewShapes(editor, shapes.map((s: any) => s.id))
        progressModal.updateStep('insert', 'done')
        progressModal.markSuccess()
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: '🧠 ' + t('aiCmdMind') },
          { role: 'assistant', content: t('aiDoneMind', { title: result.title, count: shapes.length }) },
        ])
      } else {
        progressModal.updateStep('insert', 'error')
        progressModal.markError(t('aiNoValidMind'))
      }
    } catch (err: any) {
      console.error('[AI思维导图]', err)
      progressModal.markError(friendlyError(err, t('aiMindFailed')))
    }
  }, [editorRef, roomId, subject, progressModal, getRightSidePosition])

  // 中英双语转换（带进度模态框）
  const handleGenerateBilingual = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }

    const abortController = new AbortController()
    progressModal.startProgress({
      title: t('aiBiliTitle'),
      steps: [
        { key: 'analyze', label: t('aiStepAnalyzeBoard'), status: 'active' },
        { key: 'generate', label: t('aiStepGenBili'), status: 'pending' },
        { key: 'insert', label: t('aiStepInsert'), status: 'pending' },
      ],
      onCancel: () => abortController.abort(),
    })

    try {
      const result = await whiteboardApi.aiGenerateBilingual(roomId, subject, boardSnapshot())
      progressModal.updateStep('analyze', 'done')
      progressModal.updateStep('generate', 'done')

      if (result.shapes && result.shapes.length > 0) {
        progressModal.updateStep('insert', 'active')
        progressModal.updateMessage(t('aiInsertShapes', { count: result.shapes.length }))

        const pos = getRightSidePosition(editor)
        const shapes = result.shapes.map((s: any, index: number) => {
          const shapeId = `shape:bilingual-${Date.now()}-${index}`
          const shapeProps = { ...fixTextShapeProps(s.type, fixShapeProps(s.props || {})) }
          if (!shapeProps.richText && shapeProps.text) {
            shapeProps.richText = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: shapeProps.text }] }] }
            delete shapeProps.text
          }
          return {
            id: shapeId,
            type: 'geo',
            x: (s.x || 100) + pos.x - 50,
            y: (s.y || 100 + index * 80) + pos.y - 60,
            props: shapeProps,
          } as Record<string, any>
        })
        editor.createShapes(shapes as any)
        focusNewShapes(editor, shapes.map((s: any) => s.id))
        progressModal.updateStep('insert', 'done')
        progressModal.markSuccess()
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: '🌐 ' + t('aiCmdBili') },
          { role: 'assistant', content: t('aiDoneBili', { title: result.title, count: shapes.length }) },
        ])
      } else {
        progressModal.updateStep('insert', 'error')
        progressModal.markError(t('aiNoValidBili'))
      }
    } catch (err: any) {
      console.error('[AI双语板书]', err)
      progressModal.markError(friendlyError(err, t('aiBiliFailed')))
    }
  }, [editorRef, roomId, subject, progressModal, getRightSidePosition])

  // AI 教学建议（带进度模态框）
  const handleSuggest = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }
    // 提取白板上的文字内容
    const allShapes = editor.getCurrentPageShapes()
    const content = allShapes.map((s: any) => {
      const props = s.props || {}
      return shapeText(props)
    }).filter(Boolean).join('\n')

    // 板面上有图形/手绘但没有文字时不算空：让后端用快照描述兜底，别把功能整体判死
    if (!content && allShapes.length === 0) {
      message.warning(t('aiBoardEmpty'))
      return
    }

    const abortController = new AbortController()
    progressModal.startProgress({
      title: t('aiAdviceTitle'),
      steps: [
        { key: 'analyze', label: t('aiStepAnalyzeBoard'), status: 'active' },
        { key: 'generate', label: t('aiStepGenAdvice'), status: 'pending' },
      ],
      onCancel: () => abortController.abort(),
    })

    try {
      // 带上整页截图：手写板书、图片题干只有看图才认得出来，纯文字清单读不出内容
      let pageImage = ''
      try {
        pageImage = await exportPageImage(editor)
      } catch {
        pageImage = ''
      }
      const result = await whiteboardApi.aiSuggest(content, kpName, {
        snapshot: boardSnapshot(), roomId, pageImage,
      })
      progressModal.updateStep('analyze', 'done')
      progressModal.updateStep('generate', 'done')

      if (result.suggestion) {
        progressModal.markSuccess()
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: '💡 ' + t('aiCmdAdvice') },
          { role: 'assistant', content: result.suggestion },
        ])
      } else {
        progressModal.markError(t('aiNoValidAdvice'))
      }
    } catch (err: any) {
      console.error('[AI教学建议]', err)
      progressModal.markError(friendlyError(err, t('aiAdviceFailed')))
    }
  }, [editorRef, kpName, progressModal])

  // 快捷键：Ctrl+Enter 发送
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        handleSend()
      }
    },
    [handleSend],
  )

  if (!visible) return null

  const panelWidth = expanded ? 640 : 360

  return (
    <div
      ref={rootRef}
      style={popMode ? {
        // 弹出模式：盖在画布上方的可拖动大窗，上下锚定（高度恒等于可视区，输入框不可能被裁掉）
        position: 'absolute', zIndex: 900,
        ...(winPos ? { left: winPos.x, top: winPos.y, bottom: 8 } : { left: '50%', top: 8, bottom: 8, transform: 'translateX(-50%)' }),
        width: 760, maxWidth: 'calc(100% - 24px)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        borderRadius: 14, border: '1px solid var(--border-color, #e5e9f0)',
        boxShadow: '0 16px 48px rgba(15, 35, 75, 0.28)',
        background: 'var(--bg-container, #fff)',
        flexShrink: 0,
        userSelect: 'text',
      } : {
        width: panelWidth,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid var(--border-color)',
        background: 'var(--bg-container)',
        flexShrink: 0,
        userSelect: 'text',
      }}
    >
      {/* ── 头部（弹出模式：标题栏即拖动把手） ── */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'var(--bg-layout)',
          cursor: popMode ? 'move' : 'default',
          touchAction: 'none',
        }}
        onPointerDown={(e) => {
          if (!popMode) return
          if ((e.target as HTMLElement).closest('button')) return
          const wrap = rootRef.current?.parentElement?.getBoundingClientRect()
          const r = rootRef.current?.getBoundingClientRect()
          if (!wrap || !r) return
          dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
          setWinPos({ x: r.left - wrap.left, y: r.top - wrap.top })
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return
          const wrap = rootRef.current?.parentElement?.getBoundingClientRect()
          if (!wrap) return
          const self = rootRef.current?.getBoundingClientRect()
          const w = self?.width || 400
          const nx = Math.max(4, Math.min(e.clientX - wrap.left - dragRef.current.dx, wrap.width - w - 4))
          // 底边锚定在容器底部：往下拖=压扁自己，按最小可用高度(≈268px)钳制，输入区任何位置必可见
          const ny = Math.max(0, Math.min(e.clientY - wrap.top - dragRef.current.dy, Math.max(0, wrap.height - 268)))
          setWinPos({ x: nx, y: ny })
        }}
        onPointerUp={() => { dragRef.current = null }}
      >
        <Space>
          <RobotOutlined style={{ color: '#1890ff', fontSize: 18 }} />
          <Text strong>{t('aiAssistant')}</Text>
          {kpName && <Tag color="blue" style={{ fontSize: 12 }}>{kpName}</Tag>}
        </Space>
        <Space size={4}>
          <Tooltip title={popMode ? t('aiPopBack') : t('aiPop')}>
            <Button type="text" size="small"
              icon={popMode ? <ShrinkOutlined /> : <ExpandAltOutlined />}
              onClick={() => {
                const next = !popMode
                setPopMode(next)
                localStorage.setItem('smartkb_wb_ai_pop', next ? '1' : '0')
                setWinPos(null)
                // 形态切换后让 tldraw 重算一次视口（与开关面板同一处理）
                window.setTimeout(() => window.dispatchEvent(new Event('resize')), 150)
              }} />
          </Tooltip>
          {!popMode && (
            <Tooltip title={expanded ? t('aiShrink') : t('aiExpand')}>
              <Button type="text" size="small"
                icon={expanded ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                onClick={() => setExpanded(!expanded)} />
            </Tooltip>
          )}
          <Tooltip title={t('aiClearChat')}>
            <Button type="text" size="small" icon={<ClearOutlined />} onClick={handleClear} />
          </Tooltip>
          <Tooltip title={t('aiClose')}>
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} />
          </Tooltip>
        </Space>
      </div>

      {/* ── 快捷操作 ── */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f5f5f5' }}>
        <Space wrap size={4}>
          {/* ① 生成内容：图示 / 一键板书 / 思维导图 / 双语 */}
          {isTeacher && (
            <Tooltip title={t('aiTipFig')}>
              <Button size="small" icon={<PictureOutlined />} onClick={handleGenerateDiagram} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('aiTipBoard')}>
              <Button size="small" icon={<FileTextOutlined />} onClick={handleGenerateBoard} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('aiTipMind')}>
              <Button size="small" icon={<ApartmentOutlined />} onClick={handleGenerateMindmap} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('aiTipBili')}>
              <Button size="small" icon={<TranslationOutlined />} onClick={handleGenerateBilingual} />
            </Tooltip>
          )}
          {isTeacher && <Divider type="vertical" style={{ margin: '0 2px' }} />}
          {/* ② 改板书：美化排版 / 智能批注 */}
          {isTeacher && (
            <Tooltip title={t('aiTipBeautify')}>
              <Button size="small" icon={<HighlightOutlined />} onClick={handleBeautify} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('aiTipAnno')}>
              <Button size="small" icon={<EditOutlined />} onClick={handleSmartAnnotation} />
            </Tooltip>
          )}
          {isTeacher && <Divider type="vertical" style={{ margin: '0 2px' }} />}
          {/* ③ 课堂分析：教学建议 / 随堂提问 / 解答题目 */}
          {isTeacher && (
            <Tooltip title={t('aiTipAdvice')}>
              <Button size="small" icon={<RiseOutlined />} onClick={handleSuggest} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('aiTipQuiz')}>
              <Button size="small" icon={<QuestionCircleOutlined />} onClick={handleQuiz} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('aiTipSolve')}>
              <Button size="small" icon={<BulbOutlined />} onClick={handleSolveQuestion} />
            </Tooltip>
          )}
          <Tooltip title={t('aiSubjectTip')}>
            <Select
              size="small"
              style={{ minWidth: 104 }}
              value={subjectSel}
              onChange={(v: string) => {
                setSubjectSel(v)
                localStorage.setItem('smartkb_wb_subject', v)
              }}
              options={[
                { value: '', label: t('aiSubjectAuto') },
                ...subjectOptions.map((x) => ({ value: x, label: x })),
              ]}
            />
          </Tooltip>
          {/* 视觉理解开关（切换图标样式，放在图标行） */}
          <Tooltip title={useVision ? t('aiVisionOn') : t('aiVisionOff')}>
            <Button
              size="small"
              type={useVision ? 'primary' : 'default'}
              icon={useVision ? <span style={{ fontSize: 14 }}>🧠</span> : <span style={{ fontSize: 14 }}>📝</span>}
              onClick={() => setUseVision(!useVision)}
              style={useVision ? { background: '#fa8c16', borderColor: '#fa8c16' } : {}}
            />
          </Tooltip>
          <div style={{ flex: 1 }} />
          <Tooltip title={t('aiCopyAll')}>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => {
                if (messages.length === 0) {
                  message.info(t('aiNothingCopy'))
                  return
                }
                const text = messages
                  .map((m) => `[${m.role === 'user' ? t('aiMe') : 'AI'}]\n${m.content}`)
                  .join('\n\n---\n\n')
                navigator.clipboard.writeText(text)
                message.success(t('aiCopied'))
              }}
            />
          </Tooltip>
        </Space>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
          {t('aiTipInput')}
        </div>
      </div>

      {/* ── 对话列表 ── */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          userSelect: 'text',
        }}
      >
        {messages.length === 0 && !loading && (
          <div style={{ textAlign: 'center', color: 'var(--text-tertiary)', marginTop: 40, padding: '0 12px' }}>
            <RobotOutlined style={{ fontSize: 40, display: 'block', marginBottom: 12 }} />
            <Text type="secondary">{t('aiAskPlaceholder')}</Text>
            {/* 空态示例话题：点即填入输入框，换一批重抽（P1 移植自探索画布） */}
            <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
              {wbSamples.map((x) => (
                <Tag key={x} style={{ cursor: 'pointer', maxWidth: '100%', whiteSpace: 'normal', textAlign: 'left', fontSize: 12, lineHeight: 1.5, margin: 0 }}
                  onClick={() => { setInput(x); window.setTimeout(() => inputRef.current?.focus?.(), 40) }}>
                  {x}
                </Tag>
              ))}
              <Tag icon={<ReloadOutlined />} style={{ cursor: 'pointer', fontSize: 12, margin: 0 }} onClick={() => setWbRoll((v) => v + 1)}>
                {t('aiSampleMore')}
              </Tag>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-tertiary)' }}>
              {t('aiSampleTip')}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '90%',
              position: 'relative',
            }}
          >
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 12,
                background: msg.role === 'user' ? '#e6f7ff' : '#f5f5f5',
                fontSize: 14,
                lineHeight: 1.6,
                wordBreak: 'break-word',
                userSelect: 'text',
                cursor: 'text',
              }}
            >
              {msg.role === 'user' ? (
                <span className="ai-msg-content">{msg.content}</span>
              ) : (
                <div className="ai-msg-content markdown-content">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={{
                      p: ({ children }) => <span style={{ display: 'block', marginBottom: 4 }}>{children}</span>,
                      code: ({ children, className }) => {
                        const isInline = !className
                        return isInline
                          ? <code style={{ background: 'var(--bg-layout)', padding: '1px 4px', borderRadius: 3, fontSize: 13 }}>{children}</code>
                          : <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 8, borderRadius: 6, overflow: 'auto', fontSize: 13 }}>{children}</pre>
                      },
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              )}
              {msg.role === 'assistant' && !!msg.refs?.length && (
                <div style={{
                  marginTop: 6, fontSize: 11, color: 'var(--text-tertiary, #999)',
                  display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'flex-start',
                }}>
                  <span style={{ flexShrink: 0, lineHeight: '20px' }}>{t('aiRefsLabel')}</span>
                  {uniqRefs(msg.refs).map((r, j) => {
                    const label = (r.doc_name || '') + (r.title ? '·' + r.title : '')
                    return (
                      <Tooltip key={j} title={label}>
                        <Tag style={{ fontSize: 11, margin: 0, maxWidth: '100%', whiteSpace: 'normal', lineHeight: 1.5, textAlign: 'left' }}>
                          {label.length > 30 ? label.slice(0, 29) + '…' : label}
                        </Tag>
                      </Tooltip>
                    )
                  })}
                </div>
              )}
              {msg.isStreaming && <LoadingOutlined style={{ marginLeft: 4 }} />}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, textAlign: msg.role === 'user' ? 'right' : 'left' }}>
              {msg.role === 'user' ? t('aiYou') : isTeacher ? t('aiAssist') : t('aiMate')}
            </div>
            {msg.role === 'assistant' && !msg.isStreaming && msg.content.trim() && (
              <Space size={0} style={{ marginTop: 2 }}>
                <Tooltip title={t('aiMsgCopy')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => {
                      navigator.clipboard.writeText(msg.content)
                      message.success(t('aiCopied'))
                    }}
                  />
                </Tooltip>
                {isTeacher && (
                  <Tooltip title={t('aiMsgInsert')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<PlusSquareOutlined />}
                      onClick={() => handleInsertToBoard(msg.content)}
                    />
                  </Tooltip>
                )}
                <Tooltip title={t('aiMsgRetry')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    disabled={loading}
                    onClick={() => handleRegenerate(i)}
                  />
                </Tooltip>
              </Space>
            )}
          </div>
        ))}

        {/* 流式输出中的内容 */}
        {loading && streamingText && (
          <div style={{ alignSelf: 'flex-start', maxWidth: '90%' }}>
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 12,
                background: 'var(--bg-layout)',
                fontSize: 14,
                lineHeight: 1.6,
                wordBreak: 'break-word',
                userSelect: 'text',
                cursor: 'text',
              }}
            >
              <div className="ai-msg-content markdown-content">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {streamingText}
                </ReactMarkdown>
              </div>
              <span style={{ display: 'inline-block', animation: 'blink 1s step-end infinite' }}>▍</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{isTeacher ? t('aiAssist') : t('aiMate')}</div>
          </div>
        )}

        {/* loading 但还没有流式内容 */}
        {loading && !streamingText && (
          <div style={{ alignSelf: 'flex-start', padding: '8px 12px' }}>
            <Spin size="small" /> <Text type="secondary" style={{ marginLeft: 8 }}>{t('aiThinking')}...</Text>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── 输入区 ── */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-color)' }}>
        {ctxHint && (
          <div style={{ fontSize: 11, color: selCount > 0 ? '#389e0d' : '#d46b08', marginBottom: 6 }}>
            {selCount > 0 ? '🟢 ' : '✏️ '}{ctxHint}
          </div>
        )}
        {loading ? (
          <Button block danger icon={<StopOutlined />} onClick={handleStop}>
            {t('aiStop')}
          </Button>
        ) : (
          <Space.Compact style={{ width: '100%', alignItems: 'stretch' }}>
            <VoiceInput
              onTranscript={handleVoiceTranscript}
              disabled={loading}
            />
            <TextArea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('aiInputPh')}
              autoSize={{ minRows: 1, maxRows: 4 }}
              style={{ flex: 1, fontSize: 13 }}
            />
            <Button
              type="primary"
              size="small"
              icon={<SendOutlined />}
              onClick={handleSend}
              disabled={!input.trim()}
            />
          </Space.Compact>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
          <span>{t('aiSendHint')}</span>
          <span style={{ whiteSpace: 'nowrap' }}>{isTeacher ? t('aiTodayUsed', { n: todayUsed }) : t('aiTodayUsedStudent', { n: todayUsed })}</span>
        </div>
      </div>

      {/* ── 进度模态框 ── */}
      {progressModal.modal}

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes voice-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(255, 77, 79, 0.4); }
          50% { box-shadow: 0 0 0 6px rgba(255, 77, 79, 0); }
        }
        /* tldraw 5.x 把工具条根节点改名成 .tlui-main-toolbar，两个都写，否则规则是死的 */
        .wb-ai-pop .tlui-toolbar,
        .wb-ai-pop .tlui-main-toolbar,
        .wb-ai-pop .tlui-style-panel__wrapper { display: none !important; }
        .ai-msg-content, .ai-msg-content * {
          user-select: text !important;
          -webkit-user-select: text !important;
          -moz-user-select: text !important;
          -ms-user-select: text !important;
        }
      `}</style>
    </div>
  )
}
