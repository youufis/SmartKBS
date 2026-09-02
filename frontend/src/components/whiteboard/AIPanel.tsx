/**
 * AI白板助手侧栏面板
 * 支持：流式对话、图示生成、一键板书、教学建议
 */
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  Input, Button, Typography, Space, Spin, Tag, Tooltip,
  message, Modal,
} from 'antd'
import {
  SendOutlined, RobotOutlined, CloseOutlined,
  PictureOutlined, FileTextOutlined, QuestionCircleOutlined,
  ClearOutlined, LoadingOutlined, StopOutlined,
  FullscreenOutlined, FullscreenExitOutlined,
  CopyOutlined, BulbOutlined, HighlightOutlined,
  EditOutlined, ApartmentOutlined, TranslationOutlined,
  RiseOutlined,
} from '@ant-design/icons'
import VoiceInput from '../VoiceInput'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import * as whiteboardApi from '../../api/whiteboard'
import { useProgressModal } from './ProgressModal'
import type { Editor } from 'tldraw'

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

interface Message {
  role: 'user' | 'assistant'
  content: string
  isStreaming?: boolean
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
  subject,
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
  const progressModal = useProgressModal()

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

  // 发送对话消息
  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || loading || sendingRef.current) return

    sendingRef.current = true
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setLoading(true)
    setStreamingText('')

    const abortController = new AbortController()
    abortRef.current = abortController

    let fullContent = ''
    try {
      await whiteboardApi.aiChatStream(
        text,
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
            { role: 'assistant', content: fullContent },
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
        },
      )
    } finally {
      sendingRef.current = false
      setLoading(false)
    }
  }, [input, loading, roomId, kpName, subject, useVision])

  // 一键生成图示（流式进度版，防止 IIS 超时）
  const handleGenerateDiagram = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }
    // 弹出输入框让用户描述图示
    const desc = await new Promise<string>((resolve) => {
      Modal.confirm({
        title: t('aiFigModalTitle'),
        content: (
          <TextArea
            id="ai-diagram-desc"
            placeholder={t('aiFigPh')}
            rows={3}
          />
        ),
        okText: t('aiGen'),
        cancelText: t('aiCancel'),
        onOk: () => {
          const el = document.getElementById('ai-diagram-desc') as HTMLTextAreaElement
          resolve(el?.value || '')
        },
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
        { signal: abortController.signal },
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
  }, [editorRef, subject, progressModal])

  // 一键生成板书（带进度模态框）
  const handleGenerateBoard = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }

    // 如果没有知识点名称，弹窗让教师输入
    let topic = kpName
    if (!topic) {
      topic = await new Promise<string>((resolve) => {
        Modal.confirm({
          title: t('aiBoardModalTitle'),
          content: (
            <TextArea
              id="ai-board-topic"
              placeholder={t('aiBoardPh')}
              rows={2}
            />
          ),
          okText: t('aiGen'),
          cancelText: t('aiCancel'),
          onOk: () => {
            const el = document.getElementById('ai-board-topic') as HTMLTextAreaElement
            resolve(el?.value || '')
          },
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
      const result = await whiteboardApi.aiGenerateBoard(topic, subject || '', grade || '')
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
  }, [editorRef, kpName, subject, grade, progressModal, getRightSidePosition])

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
      const result = await whiteboardApi.aiBeautifyBoard(roomId, subject)
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
      const result = await whiteboardApi.aiGenerateQuiz(roomId, subject, kpName)
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

  // 解答题目：识别白板图片中的题目并用视觉模型解析
  const handleSolveQuestion = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning(t('aiBoardNotReady'))
      return
    }

    const prompt = '请认真查看白板上的题目（包括图片和文字），逐步解答这道题，给出详细的解析过程和最终答案。如果白板上有图片，请结合图片内容一起分析。'
    setMessages((prev) => [...prev, { role: 'user', content: '📝 ' + t('aiCmdSolve') }])
    setLoading(true)
    setStreamingText('')

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
        },
      )
    } finally {
      sendingRef.current = false
      setLoading(false)
    }
  }, [editorRef, roomId, kpName, subject])

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
      const text = props.richText?.content?.map((n: any) => n.content?.map((c: any) => c.text).join('')).join('') || props.text || ''
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
      const result = await whiteboardApi.aiGenerateMindmap(roomId, subject)
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
      const result = await whiteboardApi.aiGenerateBilingual(roomId, subject)
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
      return props.richText?.content?.map((n: any) => n.content?.map((c: any) => c.text).join('')).join('') || props.text || ''
    }).filter(Boolean).join('\n')

    if (!content) {
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
      const result = await whiteboardApi.aiSuggest(content, kpName)
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
      style={{
        width: panelWidth,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid #f0f0f0',
        background: '#fff',
        flexShrink: 0,
        userSelect: 'text',
      }}
    >
      {/* ── 头部 ── */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #f0f0f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: '#fafafa',
        }}
      >
        <Space>
          <RobotOutlined style={{ color: '#1890ff', fontSize: 18 }} />
          <Text strong>{t('aiAssistant')}</Text>
          {kpName && <Tag color="blue" style={{ fontSize: 12 }}>{kpName}</Tag>}
        </Space>
        <Space size={4}>
          <Tooltip title={expanded ? t('aiShrink') : t('aiExpand')}>
            <Button type="text" size="small"
              icon={expanded ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={() => setExpanded(!expanded)} />
          </Tooltip>
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
            <Tooltip title={t('aiTipBeautify')}>
              <Button size="small" icon={<HighlightOutlined />} onClick={handleBeautify} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title={t('aiTipAnno')}>
              <Button size="small" icon={<EditOutlined />} onClick={handleSmartAnnotation} />
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
        <div style={{ fontSize: 11, color: '#bbb', marginTop: 6 }}>
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
          <div style={{ textAlign: 'center', color: '#bbb', marginTop: 40 }}>
            <RobotOutlined style={{ fontSize: 40, display: 'block', marginBottom: 12 }} />
            <Text type="secondary">{t('aiAskPlaceholder')}</Text>
            <div style={{ marginTop: 8, fontSize: 12, color: '#ccc' }}>
              {t('aiAskExample')}
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
                          ? <code style={{ background: '#eee', padding: '1px 4px', borderRadius: 3, fontSize: 13 }}>{children}</code>
                          : <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 8, borderRadius: 6, overflow: 'auto', fontSize: 13 }}>{children}</pre>
                      },
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              )}
              {msg.isStreaming && <LoadingOutlined style={{ marginLeft: 4 }} />}
            </div>
            <div style={{ fontSize: 11, color: '#bbb', marginTop: 2, textAlign: msg.role === 'user' ? 'right' : 'left' }}>
              {msg.role === 'user' ? t('aiYou') : isTeacher ? t('aiAssist') : t('aiMate')}
            </div>
          </div>
        ))}

        {/* 流式输出中的内容 */}
        {loading && streamingText && (
          <div style={{ alignSelf: 'flex-start', maxWidth: '90%' }}>
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 12,
                background: '#f5f5f5',
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
            <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>{isTeacher ? t('aiAssist') : t('aiMate')}</div>
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
      <div style={{ padding: '12px 16px', borderTop: '1px solid #f0f0f0' }}>
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
        <div style={{ fontSize: 11, color: '#ccc', marginTop: 4, textAlign: 'right' }}>
          {t('aiSendHint')}
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
