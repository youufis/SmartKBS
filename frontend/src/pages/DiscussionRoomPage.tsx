import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Card, Button, Space, Typography, Input, Tag, message,
  Spin, Empty, Tooltip,
} from 'antd'
import {
  SendOutlined, RobotOutlined, ArrowLeftOutlined,
  UserOutlined, BellOutlined,
} from '@ant-design/icons'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Text } = Typography
const { TextArea } = Input

interface Message {
  id: number
  username: string
  content: string
  msg_type: string
  created_at: string
}

const DiscussionRoomPage: React.FC = () => {
  const { groupId } = useParams<{ groupId: string }>()
  const [searchParams] = useSearchParams()
  const discussionId = searchParams.get('discussion_id')
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [discussionInfo, setDiscussionInfo] = useState<any>(null)
  const [groupInfo, setGroupInfo] = useState<any>(null)
  const [members, setMembers] = useState<any[]>([])
  const [aiLoading, setAiLoading] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // 滚动到底部
  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, 50)
  }

  // 加载讨论和小组信息
  useEffect(() => {
    if (!discussionId || !groupId) return

    const loadInfo = async () => {
      try {
        const { data } = await apiClient.get(`/api/interaction/discussions/${discussionId}`)
        setDiscussionInfo(data)
        const g = data.groups?.find((grp: any) => grp.id === parseInt(groupId!))
        if (g) {
          setGroupInfo(g)
          setMembers(g.members || [])
        }
      } catch {
        // 忽略
      }
    }
    loadInfo()
  }, [discussionId, groupId])

  // 加载历史消息（初始）
  const loadInitialMessages = useCallback(async () => {
    if (!groupId) return
    try {
      const { data } = await apiClient.get(
        `/api/interaction/groups/${groupId}/messages`,
        { params: { after_id: 0 } }
      )
      if (Array.isArray(data) && data.length > 0) {
        setMessages(data)
        // 更新轮询 ID 为最新消息 ID
        const maxId = Math.max(...data.map(m => m.id))
        if (maxId > lastPollIdRef.current) {
          lastPollIdRef.current = maxId
        }
      }
    } catch {
      // 忽略
    } finally {
      setLoading(false)
    }
  }, [groupId])

  // 轮询用的最新消息 ID ref
  const lastPollIdRef = useRef(0)

  // 初始加载消息
  useEffect(() => {
    loadInitialMessages().then(() => {
      // 初始化轮询 ID 为当前最大消息 ID
      setTimeout(scrollToBottom, 50)
    })
  }, [loadInitialMessages])

  // WebSocket 连接（替代轮询）
  useEffect(() => {
    if (!groupId) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // 优先使用当前页面 host，若连接失败 WebSocket 会自动重连
    // 如果通过 IIS 反向代理访问，需确保 IIS 配置了 WebSocket 转发
    const token = localStorage.getItem('smartkb_token') || ''
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/api/interaction/ws/${groupId}?token=${encodeURIComponent(token)}`
    let reconnectTimer: ReturnType<typeof setTimeout>

    const connectWs = () => {
      try {
        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          // 连接成功
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (data.type === 'new_message') {
              // 使用后端返回的真实消息 ID，确保与轮询数据 ID 一致，避免重复
              const msgId = data.id || Date.now()
              const newMsg: Message = {
                id: msgId,
                username: data.username || 'AI助教',
                content: data.content,
                msg_type: data.msg_type || 'text',
                created_at: data.created_at || new Date().toISOString(),
              }
              // 同步更新轮询 ID，防止轮询再次拉取同一条消息
              if (typeof msgId === 'number' && msgId > lastPollIdRef.current) {
                lastPollIdRef.current = msgId
              }
              setMessages(prev => {
                // 去重：避免与轮询带回的消息重复
                if (prev.some(m => m.id === newMsg.id)) return prev
                return [...prev, newMsg]
              })
              scrollToBottom()
            }
          } catch {
            // 忽略
          }
        }

        ws.onclose = () => {
          wsRef.current = null
          // 3 秒后重连
          reconnectTimer = setTimeout(connectWs, 3000)
        }

        ws.onerror = () => {
          ws.close()
        }
      } catch {
        reconnectTimer = setTimeout(connectWs, 3000)
      }
    }

    connectWs()

    // 轮询 fallback：每 3 秒拉取新消息（WebSocket 的补充，确保 IIS 下也能实时同步）
    const pollInterval = setInterval(async () => {
      const afterId = lastPollIdRef.current
      try {
        const { data } = await apiClient.get(
          `/api/interaction/groups/${groupId}/messages`,
          { params: { after_id: afterId } }
        )
        if (Array.isArray(data) && data.length > 0) {
          setMessages(prev => {
            // 去重：避免与 WebSocket 推送的消息重复
            const existingIds = new Set(prev.map(m => m.id))
            const newMsgs = data.filter(m => !existingIds.has(m.id))
            if (newMsgs.length > 0) {
              setTimeout(scrollToBottom, 50)
              return [...prev, ...newMsgs]
            }
            return prev
          })
          const maxId = Math.max(...data.map(m => m.id))
          if (maxId > lastPollIdRef.current) {
            lastPollIdRef.current = maxId
          }
        }
      } catch {
        // 忽略轮询错误
      }
    }, 2000)

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      clearInterval(pollInterval)
    }
  }, [groupId])

  // 发送消息
  const handleSend = async () => {
    const content = input.trim()
    if (!content || !groupId) return

    setSending(true)
    try {
      const { data } = await apiClient.post(`/api/interaction/groups/${groupId}/messages`, { content })
      setInput('')
      // 用后端返回的真实 ID 更新轮询 ID，防止轮询再次拉取同一条消息
      if (data?.id && typeof data.id === 'number' && data.id > lastPollIdRef.current) {
        lastPollIdRef.current = data.id
      }
      // 不本地追加，由 WebSocket/轮询带回消息（避免重复）
    } catch {
      message.error('发送失败')
    } finally {
      setSending(false)
    }
  }

  // 快捷键发送
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // AI 助教建议
  const handleAiSuggest = async () => {
    if (!groupId) return
    setAiLoading(true)
    try {
      const { data } = await apiClient.post(`/api/interaction/groups/${groupId}/ai-suggest`)
      if (data.status === 'ok' && data.content) {
        // 不本地追加，由 WebSocket/轮询带回消息（避免重复）
        message.success('AI 助教已回复')
      } else {
        message.info(data.content || 'AI 暂无建议')
      }
    } catch {
      message.error('AI 调用失败')
    } finally {
      setAiLoading(false)
    }
  }

  // 返回
  const handleBack = () => {
    if (discussionId) {
      navigate(`/discussion?discussion_id=${discussionId}`)
    } else {
      navigate('/discussion')
    }
  }

  const isTeacherInGroup = isTeacherOrAdmin

  return (
    <div style={{ height: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column' }}>
      {/* 顶部栏 */}
      <Card
        style={{ marginBottom: 0, borderRadius: '8px 8px 0 0' }}
        bodyStyle={{ padding: '12px 16px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={handleBack} />
            <div>
              <Text strong style={{ fontSize: 16 }}>
                {groupInfo?.name || `小组讨论`}
              </Text>
              {discussionInfo && (
                <div style={{ fontSize: 13, color: '#888' }}>{discussionInfo.title}</div>
              )}
            </div>
          </Space>
          <Space>
            {/* 成员列表 */}
            <Tooltip title={
              members.length > 0
                ? `成员: ${members.map((m: any) => m.username).join(', ')}`
                : '暂无成员'
            }>
              <Tag icon={<UserOutlined />}>
                {members.length} 人
              </Tag>
            </Tooltip>

            {/* AI 助教按钮（仅教师/管理员可主动触发） */}
            {isTeacherOrAdmin && discussionInfo?.ai_role !== 'observer' && (
              <Button
                size="small"
                icon={<RobotOutlined />}
                loading={aiLoading}
                onClick={handleAiSuggest}
              >
                AI 助教
              </Button>
            )}

            {/* 教师广播 */}
            {isTeacherInGroup && discussionId && (
              <Button
                size="small"
                icon={<BellOutlined />}
                onClick={async () => {
                  const val = prompt('请输入广播消息:')
                  if (val && val.trim()) {
                    try {
                      await apiClient.post(`/api/interaction/discussions/${discussionId}/broadcast`, { content: val.trim() })
                      message.success('广播已发送')
                    } catch {
                      message.error('广播发送失败')
                    }
                  }
                }}
              >
                广播
              </Button>
            )}
          </Space>
        </div>
      </Card>

      {/* 消息列表 */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          background: '#f5f5f5',
          padding: '12px 16px',
        }}
      >
        <Spin spinning={loading}>
          {messages.length === 0 ? (
            <Empty description="暂无消息，开始讨论吧！" style={{ marginTop: 60 }} />
          ) : (
            messages.map((msg) => {
              const isAi = msg.msg_type === 'ai_suggest' || msg.username === 'AI助教'
              const isMe = msg.username === user?.username
              const isBroadcast = msg.msg_type === 'broadcast'
              const isSystem = msg.msg_type === 'system'

              if (isBroadcast) {
                return (
                  <div key={msg.id} style={{ textAlign: 'center', margin: '8px 0' }}>
                    <Tag color="gold" style={{ fontSize: 12, padding: '2px 12px' }}>
                      📢 教师广播: {msg.content}
                    </Tag>
                  </div>
                )
              }

              if (isSystem) {
                return (
                  <div key={msg.id} style={{ textAlign: 'center', margin: '8px 0' }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>{msg.content}</Text>
                  </div>
                )
              }

              return (
                <div
                  key={msg.id}
                  style={{
                    display: 'flex',
                    flexDirection: isMe ? 'row-reverse' : 'row',
                    marginBottom: 12,
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      maxWidth: '70%',
                      background: isAi ? '#fff7e6' : isMe ? '#1677ff' : '#fff',
                      color: isMe ? '#fff' : '#333',
                      borderRadius: 12,
                      padding: '8px 14px',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                      borderTopLeftRadius: isMe ? 12 : 4,
                      borderTopRightRadius: isMe ? 4 : 12,
                    }}
                  >
                    {!isMe && (
                      <div style={{ fontSize: 12, marginBottom: 4 }}>
                        {isAi ? (
                          <Tag icon={<RobotOutlined />} color="orange" style={{ fontSize: 11 }}>AI助教</Tag>
                        ) : (
                          <Text type="secondary" style={{ fontSize: 12 }}>{msg.username}</Text>
                        )}
                      </div>
                    )}
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {msg.content}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: isMe ? 'rgba(255,255,255,0.7)' : '#bbb',
                        textAlign: 'right',
                        marginTop: 4,
                      }}
                    >
                      {msg.created_at?.split(' ')[1]?.slice(0, 5) || ''}
                    </div>
                  </div>
                </div>
              )
            })
          )}
          <div ref={messagesEndRef} />
        </Spin>
      </div>

      {/* 输入区 */}
      <Card
        style={{ borderRadius: '0 0 8px 8px', borderTop: '1px solid #f0f0f0' }}
        bodyStyle={{ padding: '12px 16px' }}
      >
        <Space.Compact style={{ width: '100%' }}>
          <TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            rows={2}
            disabled={sending}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            loading={sending}
            style={{ height: 50 }}
          >
            发送
          </Button>
        </Space.Compact>
      </Card>
    </div>
  )
}

export default DiscussionRoomPage
