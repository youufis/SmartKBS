/**
 * AI 助手浮动按钮
 * 固定在右下角，点击展开对话面板
 */
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Button, Drawer, Input, Space, Typography, Spin, Empty, message as antMsg } from 'antd'
import { RobotOutlined, CloseOutlined, SendOutlined } from '@ant-design/icons'
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
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: 'assistant', content: '你好！我是小K，SmartKBS 平台的 AI 助手。有什么可以帮你的吗？😊' },
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

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

    // 构建带上下文的消息历史
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

  return (
    <>
      {/* 浮动按钮 */}
      <div style={{ position: 'fixed', bottom: 88, right: 24, zIndex: 1000 }}>
        <Button
          type="primary"
          shape="circle"
          size="large"
          style={{ width: 52, height: 52, boxShadow: '0 4px 14px rgba(22,119,255,0.4)' }}
          icon={open ? <CloseOutlined /> : <RobotOutlined style={{ fontSize: 22 }} />}
          onClick={() => setOpen(!open)}
        />
      </div>

      {/* 对话面板 */}
      <Drawer
        title={<Space><RobotOutlined style={{ color: '#1677ff' }} />AI 助手 - 小K</Space>}
        placement="right"
        width={420}
        open={open}
        onClose={() => setOpen(false)}
        styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
      >
        <div
          ref={listRef}
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '12px 16px',
            background: '#f9f9f9',
          }}
        >
          {messages.map((msg, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  maxWidth: '80%',
                  padding: '8px 14px',
                  borderRadius: 12,
                  background: msg.role === 'user' ? '#1677ff' : '#fff',
                  color: msg.role === 'user' ? '#fff' : '#333',
                  border: msg.role === 'user' ? 'none' : '1px solid #e8e8e8',
                  fontSize: 14,
                  lineHeight: 1.6,
                  wordBreak: 'break-word',
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
            </div>
          ))}
          {/* 流式输出 */}
          {streaming && streamText && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
              <div
                style={{
                  maxWidth: '80%', padding: '8px 14px', borderRadius: 12,
                  background: '#fff', color: '#333',
                  border: '1px solid #e8e8e8', fontSize: 14, lineHeight: 1.6,
                }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamText}</ReactMarkdown>
                <span
                  style={{
                    display: 'inline-block', width: 2, height: '1em',
                    backgroundColor: '#1677ff', marginLeft: 2,
                    animation: 'blink 1s step-end infinite',
                  }}
                />
              </div>
            </div>
          )}
          {streaming && !streamText && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
              <div style={{ padding: '8px 14px', borderRadius: 12, background: '#fff', border: '1px solid #e8e8e8' }}>
                <Spin size="small" />
              </div>
            </div>
          )}
          {!streaming && messages.length <= 1 && (
            <Empty description="有什么想问的吗？" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </div>

        {/* 输入区 */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #f0f0f0', background: '#fff' }}>
          <Space.Compact style={{ width: '100%' }}>
            <TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入问题..."
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
              style={{ borderRadius: 6 }}
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
