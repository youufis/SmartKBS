/**
 * AI 助手浮动按钮
 * 可爱风格，可拖动，可隐藏
 */
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Button, Drawer, Input, Space, Typography, Spin, Empty, message as antMsg, Tooltip } from 'antd'
import { SendOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { chatStream } from '../api/chat'

const { TextArea } = Input
const { Text } = Typography

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

const SYSTEM_PROMPT = `你叫小K，是SmartKBS智慧教学平台的AI助手。请用友好、简洁的语言回答用户的问题。

关于SmartKBS：
- 面向高中信息技术与通用技术课程的AI智慧教学管理平台
- 功能包括：AI对话、资源中心、资源管理、试题管理、考试发布、任务管理、文件中心、用户管理、系统配置、课堂积分、点名管理、学情分析、成长档案、课堂互动(随堂测验/投票/提问)、分组讨论、消息通知、系统公告
- 教师和管理员可共享HTML资源和下载文件给其他用户
- 系统基于FastAPI + React构建，使用DashScope/DeepSeek AI模型

注意：回答要简洁，如果不知道答案就诚实地说不知道`

const AIAssistant: React.FC = () => {
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(() => localStorage.getItem('ai_assistant_hidden') === 'true')
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: 'assistant', content: '你好呀！我是小K ~ 有什么可以帮你的吗？(◕‿◕)♡' },
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLDivElement>(null)

  // 拖动状态
  const [pos, setPos] = useState(() => {
    const saved = localStorage.getItem('ai_assistant_pos')
    return saved ? JSON.parse(saved) : { x: 24, y: 88 }
  })
  const dragging = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })

  // 自动滚动到底部
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, streamText])

  // 清理中断
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // 保存隐藏状态
  useEffect(() => {
    localStorage.setItem('ai_assistant_hidden', String(hidden))
  }, [hidden])

  // 保存位置
  useEffect(() => {
    localStorage.setItem('ai_assistant_pos', JSON.stringify(pos))
  }, [pos])

  // 拖动开始
  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    dragging.current = true
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY
      dragOffset.current = { x: clientX - rect.left, y: clientY - rect.top }
    }
  }, [])

  // 拖动移动
  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!dragging.current) return
      const clientX = 'touches' in e ? (e as TouchEvent).touches[0].clientX : (e as MouseEvent).clientX
      const clientY = 'touches' in e ? (e as TouchEvent).touches[0].clientY : (e as MouseEvent).clientY
      const newX = Math.max(0, Math.min(window.innerWidth - 60, clientX - dragOffset.current.x))
      const newY = Math.max(0, Math.min(window.innerHeight - 60, clientY - dragOffset.current.y))
      setPos({ x: newX, y: newY })
    }
    const handleUp = () => { dragging.current = false }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    window.addEventListener('touchmove', handleMove, { passive: true })
    window.addEventListener('touchend', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      window.removeEventListener('touchmove', handleMove)
      window.removeEventListener('touchend', handleUp)
    }
  }, [])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return

    setInput('')
    const userMsg: ChatMsg = { role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])
    setStreaming(true)
    setStreamText('')

    const controller = new AbortController()
    abortRef.current = controller

    const recentMessages = [...messages.slice(-9), userMsg]
    const contextPrompt = `${SYSTEM_PROMPT}\n\n历史对话：\n${recentMessages
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .join('\n')}\n\n助手（请根据以上上下文回复）:`

    await chatStream(
      { prompt: contextPrompt },
      (delta) => setStreamText(delta),
      () => {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: streamText },
        ])
        setStreamText('')
        setStreaming(false)
      },
      (err) => {
        antMsg.error(err || '请求失败')
        setStreaming(false)
      },
      controller.signal,
    )
  }, [input, streaming, messages])

  if (hidden) {
    return (
      <Tooltip title="显示 AI 助手">
        <div
          style={{
            position: 'fixed', bottom: 20, right: 20, zIndex: 1000,
            cursor: 'pointer', userSelect: 'none',
          }}
          onClick={() => setHidden(false)}
        >
          <span style={{ fontSize: 28, filter: 'grayscale(0.5)', opacity: 0.6 }}>
            🐣
          </span>
        </div>
      </Tooltip>
    )
  }

  return (
    <>
      {/* 可拖动的可爱浮动按钮 */}
      <div
        ref={buttonRef}
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
        style={{
          position: 'fixed',
          left: pos.x,
          bottom: pos.y,
          zIndex: 1000,
          cursor: dragging.current ? 'grabbing' : 'grab',
          userSelect: 'none',
          touchAction: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {/* 隐藏按钮 */}
        <div
          style={{
            fontSize: 12, color: '#ccc', cursor: 'pointer',
            background: '#fff', borderRadius: 8, padding: '0 6px',
            border: '1px solid #f0f0f0', lineHeight: '18px',
            userSelect: 'none',
          }}
          onClick={(e) => { e.stopPropagation(); setHidden(true) }}
        >
          ✕ 隐藏
        </div>

        {/* 可爱图标 */}
        <div
          onClick={() => setOpen(!open)}
          style={{
            width: 58, height: 58, borderRadius: '50%',
            background: 'linear-gradient(135deg, #ff9a9e 0%, #fad0c4 50%, #a18cd1 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 20px rgba(161,140,209,0.4)',
            transition: 'transform 0.2s',
            transform: open ? 'scale(0.9)' : 'scale(1)',
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 32, lineHeight: 1 }}>
            {open ? '😊' : '🤖'}
          </span>
        </div>

        {/* 小标签 */}
        <div
          style={{
            fontSize: 11, color: '#a18cd1', fontWeight: 600,
            background: '#fff', borderRadius: 8, padding: '0 6px',
            border: '1px solid #f0f0f0', lineHeight: '18px',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          小K助手
        </div>
      </div>

      {/* 对话面板 */}
      <Drawer
        title={
          <Space>
            <span style={{ fontSize: 20 }}>🤖</span>
            <span style={{ fontWeight: 600, background: 'linear-gradient(135deg, #ff9a9e, #a18cd1)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              AI 助手 - 小K
            </span>
          </Space>
        }
        placement="right"
        width={420}
        open={open}
        onClose={() => setOpen(false)}
        styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
      >
        <div
          ref={listRef}
          style={{
            flex: 1, overflow: 'auto', padding: '12px 16px',
            background: '#fafafa',
          }}
        >
          {messages.map((msg, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                marginBottom: 12,
                alignItems: 'flex-end',
                gap: 6,
              }}
            >
              {msg.role === 'assistant' && (
                <span style={{ fontSize: 18, flexShrink: 0 }}>🤖</span>
              )}
              <div
                style={{
                  maxWidth: '75%',
                  padding: '8px 14px',
                  borderRadius: msg.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                  background: msg.role === 'user' ? 'linear-gradient(135deg, #667eea, #764ba2)' : '#fff',
                  color: msg.role === 'user' ? '#fff' : '#333',
                  border: msg.role === 'user' ? 'none' : '1px solid #f0f0f0',
                  fontSize: 14,
                  lineHeight: 1.6,
                  wordBreak: 'break-word',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
                }}
              >
                {msg.role === 'user' ? (
                  msg.content
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                )}
              </div>
              {msg.role === 'user' && (
                <span style={{ fontSize: 16, flexShrink: 0 }}>🧑</span>
              )}
            </div>
          ))}
          {/* 流式输出 */}
          {streaming && streamText && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12, alignItems: 'flex-end', gap: 6 }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>🤖</span>
              <div
                style={{
                  maxWidth: '75%', padding: '8px 14px',
                  borderRadius: '12px 12px 12px 4px',
                  background: '#fff', color: '#333',
                  border: '1px solid #f0f0f0', fontSize: 14, lineHeight: 1.6,
                  boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
                }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamText}</ReactMarkdown>
                <span
                  style={{
                    display: 'inline-block', width: 2, height: '1em',
                    backgroundColor: '#a18cd1', marginLeft: 2,
                    animation: 'blink 1s step-end infinite',
                  }}
                />
              </div>
            </div>
          )}
          {streaming && !streamText && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12, gap: 6 }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>🤖</span>
              <div style={{ padding: '8px 14px', borderRadius: 12, background: '#fff', border: '1px solid #f0f0f0' }}>
                <Spin size="small" />
              </div>
            </div>
          )}
          {!streaming && messages.length <= 1 && (
            <div style={{ paddingTop: 40 }}>
              <Empty description="有什么想问的吗？(◕‿◕)" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          )}
        </div>

        {/* 输入区 */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #f0f0f0', background: '#fff' }}>
          <Space.Compact style={{ width: '100%' }}>
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="给小K发消息..."
              autoSize={{ minRows: 1, maxRows: 4 }}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              disabled={streaming}
              style={{ borderRadius: 6 }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={handleSend}
              loading={streaming}
              disabled={!input.trim()}
              style={{ borderRadius: 6, background: 'linear-gradient(135deg, #667eea, #764ba2)', border: 'none' }}
            />
          </Space.Compact>
          <div style={{ marginTop: 4, textAlign: 'right' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              Enter 发送 · Shift+Enter 换行
            </Text>
          </div>
        </div>
      </Drawer>
    </>
  )
}

export default AIAssistant
