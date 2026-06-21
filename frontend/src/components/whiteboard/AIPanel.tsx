/**
 * AI白板助手侧栏面板
 * 支持：流式对话、图示生成、一键板书、教学建议
 */
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
import type { Editor } from 'tldraw'

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
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)  // 防止并发发送

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
              { role: 'assistant', content: fullContent + `\n\n[错误: ${error}]` },
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
        },
      )
    } finally {
      sendingRef.current = false
      setLoading(false)
    }
  }, [input, loading, roomId, kpName, subject])

  // 一键生成图示
  const handleGenerateDiagram = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning('白板尚未加载')
      return
    }
    // 弹出输入框让用户描述图示
    const desc = await new Promise<string>((resolve) => {
      Modal.confirm({
        title: 'AI 生成图示',
        content: (
          <TextArea
            id="ai-diagram-desc"
            placeholder="请输入图示描述，例如：OSI七层模型的层次结构图"
            rows={3}
          />
        ),
        okText: '生成',
        cancelText: '取消',
        onOk: () => {
          const el = document.getElementById('ai-diagram-desc') as HTMLTextAreaElement
          resolve(el?.value || '')
        },
        onCancel: () => resolve(''),
      })
    })
    if (!desc) return

    message.loading({ content: 'AI 正在生成图示...', key: 'aiDiagram' })
    try {
      const result = await whiteboardApi.aiGenerateDiagram(desc, subject)

      if (result.mode === 'svg' && result.svg) {
        // ── SVG 模式：用 TLDraw 原生 svg-text 处理器插入 ──
        await editor.putExternalContent({
          type: 'svg-text',
          text: result.svg,
        } as any)
        message.success({ content: 'SVG 图示已插入白板', key: 'aiDiagram' })
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: `📐 生成图示: ${desc}` },
          { role: 'assistant', content: `已生成 SVG 图示「${result.title || ''}」并插入白板` },
        ])

      } else if (result.mode === 'image' && result.image_url) {
        // ── 图片模式（万相生图）：直接插入图片 URL ──
        await editor.putExternalContent({
          type: 'url',
          url: result.image_url,
        } as any)
        message.success({ content: '图片已插入白板', key: 'aiDiagram' })
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: `📐 生成图示: ${desc}` },
          { role: 'assistant', content: `已生成图片「${result.title || ''}」并插入白板` },
        ])

      } else if (result.mode === 'text') {
        // ── 兜底：仅文字描述 ──
        message.warning({ content: result.error || 'AI 未能生成有效图示', key: 'aiDiagram' })
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: `📐 生成图示: ${desc}` },
          { role: 'assistant', content: (result as any).text || result.error || '生成失败' },
        ])

      } else {
        message.warning({ content: result.error || 'AI 未能生成有效图示，请优化描述后重试', key: 'aiDiagram' })
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      const status = err?.response?.status
      const msg = detail || (status ? `HTTP ${status}` : err.message || '生成失败')
      console.error('[AI生成图示]', err)
      message.error({ content: msg, key: 'aiDiagram' })
    }
  }, [editorRef, subject])

  // 一键生成板书
  const handleGenerateBoard = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning('白板尚未加载')
      return
    }

    // 如果没有知识点名称，弹窗让教师输入
    let topic = kpName
    if (!topic) {
      topic = await new Promise<string>((resolve) => {
        Modal.confirm({
          title: '一键生成板书',
          content: (
            <TextArea
              id="ai-board-topic"
              placeholder="请输入知识点名称，例如：勾股定理、OSI七层模型"
              rows={2}
            />
          ),
          okText: '生成',
          cancelText: '取消',
          onOk: () => {
            const el = document.getElementById('ai-board-topic') as HTMLTextAreaElement
            resolve(el?.value || '')
          },
          onCancel: () => resolve(''),
        })
      })
      if (!topic) return
    }

    message.loading({ content: 'AI 正在生成板书...', key: 'aiBoard' })
    try {
      const result = await whiteboardApi.aiGenerateBoard(topic, subject || '', grade || '')
      if (result.shapes && result.shapes.length > 0) {
        // 清空当前白板（教师确认）
        Modal.confirm({
          title: `生成板书: ${result.title}`,
          content: `将插入 ${result.shapes.length} 个形状到白板，是否继续？`,
          okText: '插入',
          onOk: async () => {
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
            message.success({ content: `板书「${result.title}」已插入`, key: 'aiBoard' })
            setMessages((prev) => [
              ...prev,
              { role: 'user', content: `📝 一键生成板书: ${topic}` },
              { role: 'assistant', content: `已生成板书「${result.title}」（${shapes.length} 个形状）` },
            ])
          },
        })
      } else {
        message.warning({ content: 'AI 未能生成有效板书', key: 'aiBoard' })
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      const status = err?.response?.status
      console.error('[AI一键板书]', err)
      message.error({ content: detail || (status ? `HTTP ${status}` : err.message || '生成失败'), key: 'aiBoard' })
    }
  }, [editorRef, kpName, subject, grade])

  // 板书美化+自动排版
  const handleBeautify = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning('白板尚未加载')
      return
    }

    message.loading({ content: 'AI 正在美化排版...', key: 'aiBeautify' })
    try {
      const result = await whiteboardApi.aiBeautifyBoard(roomId, subject)
      if (result.shapes && result.shapes.length > 0) {
        Modal.confirm({
          title: `美化排版: ${result.title}`,
          content: `将替换为 ${result.shapes.length} 个重新排版的形状，是否继续？`,
          okText: '替换',
          onOk: async () => {
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
            message.success({ content: `美化排版完成`, key: 'aiBeautify' })
            setMessages((prev) => [
              ...prev,
              { role: 'user', content: '🎨 美化排版' },
              { role: 'assistant', content: `已重新排版为「${result.title}」（${shapes.length} 个形状）` },
            ])
          },
        })
      } else {
        message.warning({ content: 'AI 未能生成美化排版', key: 'aiBeautify' })
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      const status = err?.response?.status
      console.error('[AI美化排版]', err)
      message.error({ content: detail || (status ? `HTTP ${status}` : err.message || '美化失败'), key: 'aiBeautify' })
    }
  }, [editorRef, roomId, subject])

  // 随堂提问
  const handleQuiz = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning('白板尚未加载')
      return
    }

    message.loading({ content: 'AI 正在生成随堂提问...', key: 'aiQuiz' })
    try {
      const result = await whiteboardApi.aiGenerateQuiz(roomId, subject, kpName)
      if (result.error) {
        message.warning({ content: result.error, key: 'aiQuiz' })
        return
      }
      if (!result.question) {
        message.warning({ content: 'AI 未能生成有效题目', key: 'aiQuiz' })
        return
      }

      // ── 将题目写入白板画布，同步展示给学生 ──
      const colors = ['#ff4d4f', '#52c41a', '#1890ff', '#fa8c16']
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

      // 弹窗展示题目供教师查看
      Modal.info({
        title: '🎯 随堂提问（已发布到白板）',
        width: 520,
        content: (
          <div style={{ padding: '12px 0' }}>
            <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 16, lineHeight: 1.6 }}>
              {result.question}
            </div>
            {result.options?.map((opt: string, i: number) => (
              <div
                key={i}
                style={{
                  padding: '10px 14px',
                  marginBottom: 8,
                  borderRadius: 8,
                  border: `1px solid ${i === result.correct_index ? colors[i % 4] : '#e8e8e8'}`,
                  background: i === result.correct_index ? `${colors[i % 4]}10` : '#fafafa',
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                <span style={{
                  display: 'inline-block',
                  width: 24, height: 24,
                  borderRadius: 12,
                  background: colors[i % 4],
                  color: '#fff',
                  textAlign: 'center',
                  lineHeight: '24px',
                  fontSize: 12,
                  fontWeight: 'bold',
                  marginRight: 10,
                }}>{labels[i]}</span>
                {opt.replace(/^[A-D][.、\s]*/, '')}
                {i === result.correct_index && (
                  <span style={{ float: 'right', color: '#52c41a', fontSize: 12 }}>✅ 正确答案</span>
                )}
              </div>
            ))}
            {result.explanation && (
              <div style={{
                marginTop: 12, padding: 10, background: '#fff7e6', borderRadius: 8,
                fontSize: 13, color: '#666', lineHeight: 1.6,
              }}>
                💡 {result.explanation}
              </div>
            )}
            <div style={{ marginTop: 12, padding: 8, background: '#f0f5ff', borderRadius: 6, fontSize: 12, color: '#1890ff', textAlign: 'center' }}>
              ✅ 题目已同步发布到白板，所有学生可见
            </div>
          </div>
        ),
        okText: '收起',
      })

      setMessages((prev) => [
        ...prev,
        { role: 'user', content: '🎯 生成随堂提问' },
        { role: 'assistant', content: `**题目**：${result.question}\n\n**答案**：${result.options?.[result.correct_index] || ''}` },
      ])
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      const status = err?.response?.status
      console.error('[AI随堂提问]', err)
      message.error({ content: detail || (status ? `HTTP ${status}` : err.message || '生成失败'), key: 'aiQuiz' })
    }
  }, [editorRef, roomId, subject, kpName])

  // 解答题目：识别白板图片中的题目并用视觉模型解析
  const handleSolveQuestion = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning('白板尚未加载')
      return
    }

    const prompt = '请认真查看白板上的题目（包括图片和文字），逐步解答这道题，给出详细的解析过程和最终答案。如果白板上有图片，请结合图片内容一起分析。'
    setMessages((prev) => [...prev, { role: 'user', content: '📝 解答白板上的题目' }])
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
              { role: 'assistant', content: fullContent + `\n\n[错误: ${error}]` },
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

  // 智能批注：分析选中内容并添加标注
  const handleSmartAnnotation = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning('白板尚未加载')
      return
    }

    const selectedShapes = editor.getSelectedShapes()
    if (!selectedShapes || selectedShapes.length === 0) {
      message.warning('请先在白板上选中要批注的内容')
      return
    }

    // 提取选中形状的文字描述
    const desc = selectedShapes.map((s: any) => {
      const props = s.props || {}
      const text = props.richText?.content?.map((n: any) => n.content?.map((c: any) => c.text).join('')).join('') || props.text || ''
      return `[${s.type}] 位置(${Math.round(s.x)},${Math.round(s.y)}) 文字: ${text}`
    }).join('\n')

    message.loading({ content: 'AI 正在分析...', key: 'aiAnnotation' })
    try {
      const result = await whiteboardApi.aiSmartAnnotation(desc)
      if (result.label_text) {
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
        message.success({ content: '批注已添加', key: 'aiAnnotation' })
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: '📌 智能批注' },
          { role: 'assistant', content: `**批注**：${result.label_text}\n\n**概括**：${result.summary || ''}` },
        ])
      } else {
        message.warning({ content: result.summary || 'AI 未能生成批注', key: 'aiAnnotation' })
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      console.error('[AI智能批注]', err)
      message.error({ content: detail || '批注失败', key: 'aiAnnotation' })
    }
  }, [editorRef])

  // 生成思维导图
  const handleGenerateMindmap = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning('白板尚未加载')
      return
    }
    message.loading({ content: 'AI 正在生成思维导图...', key: 'aiMindmap' })
    try {
      const result = await whiteboardApi.aiGenerateMindmap(roomId, subject)
      if (result.shapes && result.shapes.length > 0) {
        Modal.confirm({
          title: `思维导图: ${result.title}`,
          content: `将插入 ${result.shapes.length} 个形状到白板，是否继续？`,
          okText: '插入',
          onOk: async () => {
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
            message.success({ content: `思维导图已插入`, key: 'aiMindmap' })
            setMessages((prev) => [
              ...prev,
              { role: 'user', content: '🧠 生成思维导图' },
              { role: 'assistant', content: `已生成思维导图「${result.title}」（${shapes.length} 个节点）` },
            ])
          },
        })
      } else {
        message.warning({ content: 'AI 未能生成思维导图', key: 'aiMindmap' })
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      console.error('[AI思维导图]', err)
      message.error({ content: detail || '生成失败', key: 'aiMindmap' })
    }
  }, [editorRef, roomId, subject])

  // 中英双语转换
  const handleGenerateBilingual = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning('白板尚未加载')
      return
    }
    message.loading({ content: 'AI 正在生成双语板书...', key: 'aiBilingual' })
    try {
      const result = await whiteboardApi.aiGenerateBilingual(roomId, subject)
      if (result.shapes && result.shapes.length > 0) {
        Modal.confirm({
          title: `双语板书: ${result.title}`,
          content: `将插入 ${result.shapes.length} 个形状到白板，是否继续？`,
          okText: '插入',
          onOk: async () => {
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
            message.success({ content: `双语板书已插入`, key: 'aiBilingual' })
            setMessages((prev) => [
              ...prev,
              { role: 'user', content: '🌐 生成双语板书' },
              { role: 'assistant', content: `已生成双语板书「${result.title}」（${shapes.length} 个对照项）` },
            ])
          },
        })
      } else {
        message.warning({ content: 'AI 未能生成双语板书', key: 'aiBilingual' })
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      console.error('[AI双语板书]', err)
      message.error({ content: detail || '生成失败', key: 'aiBilingual' })
    }
  }, [editorRef, roomId, subject])

  // AI 教学建议
  const handleSuggest = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      message.warning('白板尚未加载')
      return
    }
    // 提取白板上的文字内容
    const allShapes = editor.getCurrentPageShapes()
    const content = allShapes.map((s: any) => {
      const props = s.props || {}
      return props.richText?.content?.map((n: any) => n.content?.map((c: any) => c.text).join('')).join('') || props.text || ''
    }).filter(Boolean).join('\n')

    if (!content) {
      message.warning('白板为空，请先在白板上书写内容')
      return
    }

    message.loading({ content: 'AI 正在分析并给出建议...', key: 'aiSuggest' })
    try {
      const result = await whiteboardApi.aiSuggest(content, kpName)
      if (result.suggestion) {
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: '💡 请给出教学建议' },
          { role: 'assistant', content: result.suggestion },
        ])
        message.success({ content: '建议已生成', key: 'aiSuggest' })
      } else {
        message.warning({ content: 'AI 未能生成建议', key: 'aiSuggest' })
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      console.error('[AI教学建议]', err)
      message.error({ content: detail || '生成失败', key: 'aiSuggest' })
    }
  }, [editorRef, kpName])

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
          <Text strong>AI白板助手</Text>
          {kpName && <Tag color="blue" style={{ fontSize: 12 }}>{kpName}</Tag>}
        </Space>
        <Space size={4}>
          <Tooltip title={expanded ? '缩小' : '展开'}>
            <Button type="text" size="small"
              icon={expanded ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={() => setExpanded(!expanded)} />
          </Tooltip>
          <Tooltip title="清空对话">
            <Button type="text" size="small" icon={<ClearOutlined />} onClick={handleClear} />
          </Tooltip>
          <Tooltip title="关闭">
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} />
          </Tooltip>
        </Space>
      </div>

      {/* ── 快捷操作 ── */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f5f5f5' }}>
        <Space wrap size={4}>
          {isTeacher && (
            <Tooltip title="生成图示">
              <Button size="small" icon={<PictureOutlined />} onClick={handleGenerateDiagram} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title="一键板书">
              <Button size="small" icon={<FileTextOutlined />} onClick={handleGenerateBoard} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title="美化排版">
              <Button size="small" icon={<HighlightOutlined />} onClick={handleBeautify} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title="智能批注（选中内容后使用）">
              <Button size="small" icon={<EditOutlined />} onClick={handleSmartAnnotation} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title="思维导图">
              <Button size="small" icon={<ApartmentOutlined />} onClick={handleGenerateMindmap} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title="中英双语">
              <Button size="small" icon={<TranslationOutlined />} onClick={handleGenerateBilingual} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title="教学建议">
              <Button size="small" icon={<RiseOutlined />} onClick={handleSuggest} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title="随堂提问">
              <Button size="small" icon={<QuestionCircleOutlined />} onClick={handleQuiz} />
            </Tooltip>
          )}
          {isTeacher && (
            <Tooltip title="解答题目（识别图片中的题目并解析）">
              <Button size="small" icon={<BulbOutlined />} onClick={handleSolveQuestion} />
            </Tooltip>
          )}
          <div style={{ flex: 1 }} />
          <Tooltip title="复制全部对话">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => {
                if (messages.length === 0) {
                  message.info('没有可复制的内容')
                  return
                }
                const text = messages
                  .map((m) => `[${m.role === 'user' ? '我' : 'AI'}]\n${m.content}`)
                  .join('\n\n---\n\n')
                navigator.clipboard.writeText(text)
                message.success('已复制全部对话')
              }}
            />
          </Tooltip>
        </Space>
        <div style={{ fontSize: 11, color: '#bbb', marginTop: 6 }}>
          💡 直接在下方提问，AI 会结合白板当前内容回答
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
            <Text type="secondary">向AI白板助手提问</Text>
            <div style={{ marginTop: 8, fontSize: 12, color: '#ccc' }}>
              例如：解释白板上的内容 / 总结重点 / 生成流程图
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
              {msg.role === 'user' ? '你' : isTeacher ? 'AI 助手' : 'AI 学伴'}
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
            <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>{isTeacher ? 'AI 助手' : 'AI 学伴'}</div>
          </div>
        )}

        {/* loading 但还没有流式内容 */}
        {loading && !streamingText && (
          <div style={{ alignSelf: 'flex-start', padding: '8px 12px' }}>
            <Spin size="small" /> <Text type="secondary" style={{ marginLeft: 8 }}>AI 思考中...</Text>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── 输入区 ── */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid #f0f0f0' }}>
        {loading ? (
          <Button block danger icon={<StopOutlined />} onClick={handleStop}>
            停止生成
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
              placeholder="输入问题... (Ctrl+Enter 发送)"
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
          支持 Ctrl+Enter 发送
        </div>
      </div>

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
