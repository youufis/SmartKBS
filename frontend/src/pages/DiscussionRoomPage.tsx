import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Card, Button, Space, Typography, Input, Tag, message,
  Spin, Empty, Tooltip, Modal, Rate, Collapse,
} from 'antd'
import {
  SendOutlined, RobotOutlined, ArrowLeftOutlined,
  UserOutlined, BellOutlined, BulbOutlined,
  ThunderboltOutlined, DownloadOutlined,
} from '@ant-design/icons'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
  const { t } = useTranslation('discussion')
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
  const [summaryModal, setSummaryModal] = useState(false)
  const [summaryData, setSummaryData] = useState<any>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [generatingSummary, setGeneratingSummary] = useState(false)

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

  // 轮询用的最新消息 ID
  const [lastPollId, setLastPollId] = useState(0)

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
        if (maxId > lastPollId) setLastPollId(maxId)
      }
    } catch {
      // 忽略
    } finally {
      setLoading(false)
    }
  }, [groupId, lastPollId])

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
    const aiAssistantName = t('aiAssistant')
    let reconnectTimer: ReturnType<typeof setTimeout>
    // 服务端会以 4401/4403/4404 拒绝握手, 但浏览器只能看到 1006, 因此用重试次数上限兜底
    let reconnectAttempts = 0
    const MAX_RECONNECT = 5
    let currentPollId = lastPollId

    const updatePollId = (newId: number) => {
      if (newId > currentPollId) {
        currentPollId = newId
        setLastPollId(newId)
      }
    }

    const connectWs = () => {
      try {
        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          // 连接成功，重置重连计数
          reconnectAttempts = 0
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (data.type === 'new_message') {
              // 使用后端返回的真实消息 ID，确保与轮询数据 ID 一致，避免重复
              const msgId = data.id || Date.now()
              const newMsg: Message = {
                id: msgId,
                username: data.username || aiAssistantName,
                content: data.content,
                msg_type: data.msg_type || 'text',
                created_at: data.created_at || new Date().toISOString(),
              }
              // 同步更新轮询 ID，防止轮询再次拉取同一条消息
              if (typeof msgId === 'number') updatePollId(msgId)
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
          if (reconnectAttempts >= MAX_RECONNECT) return  // 交给轮询兜底
          reconnectAttempts++
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
      try {
        const { data } = await apiClient.get(
          `/api/interaction/groups/${groupId}/messages`,
          { params: { after_id: currentPollId } }
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
          updatePollId(maxId)
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, lastPollId])

  // 发送消息
  const handleSend = async () => {
    const content = input.trim()
    if (!content || !groupId) return

    setSending(true)
    try {
      const { data } = await apiClient.post(`/api/interaction/groups/${groupId}/messages`, { content })
      setInput('')
      // 用后端返回的真实 ID 更新轮询 ID，防止轮询再次拉取同一条消息
      if (data?.id && typeof data.id === 'number' && data.id > lastPollId) {
        setLastPollId(data.id)
      }
      // 不本地追加，由 WebSocket/轮询带回消息（避免重复）
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      message.error(detail || t('sendFailed'))
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
        message.success(t('aiTutorReplied'))
      } else {
        message.info(data.content || t('aiNoSuggestions'))
      }
    } catch {
      message.error(t('aiCallFailed'))
    } finally {
      setAiLoading(false)
    }
  }

  // AI 归纳总结
  const handleAiSummary = async () => {
    if (!groupId) return
    setGeneratingSummary(true)
    try {
      const { data } = await apiClient.post(`/api/interaction/groups/${groupId}/ai-summary`)
      if (data.status === 'ok') {
        message.success(t('aiSummarySuccess'))
        setSummaryData(data)
        setSummaryModal(true)
      } else {
        message.error(data.content || t('summaryGenerateFailed'))
      }
    } catch (err: any) {
      message.error(t('aiSummaryFailed') + ': ' + (err?.response?.data?.detail || err?.message))
    } finally {
      setGeneratingSummary(false)
    }
  }

  // 查看已有总结
  const handleViewSummary = async () => {
    if (!groupId) return
    setSummaryLoading(true)
    setSummaryModal(true)
    try {
      const { data } = await apiClient.get(`/api/interaction/groups/${groupId}/summary`)
      if (data.has_summary) {
        setSummaryData(data)
      } else {
        setSummaryData(null)
      }
    } catch {
      setSummaryData(null)
    } finally {
      setSummaryLoading(false)
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

  // 检查是否有总结
  const [hasExistingSummary, setHasExistingSummary] = useState(false)
  useEffect(() => {
    if (!groupId) return
    apiClient.get(`/api/interaction/groups/${groupId}/summary`).then(({ data }) => {
      setHasExistingSummary(data.has_summary)
    }).catch(() => {})
  }, [groupId])

  return (
    <div style={{ height: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
      {/* 顶部栏 */}
      <Card
        style={{ marginBottom: 0, borderRadius: 0 }}
        styles={{ body: { padding: '12px 16px' } }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={handleBack} />
            <div>
              <Text strong style={{ fontSize: 16 }}>
                {groupInfo?.name || (discussionInfo?.group_mode === 'none' ? t('noGroup') : `${t('groupMode')}${t('roomList')}`)}
              </Text>
              {discussionInfo && (
                <div className="markdown-content" style={{ fontSize: 13, color: '#888' }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ p: ({children}) => <>{children}</> }}>{discussionInfo.title}</ReactMarkdown>
                </div>
              )}
            </div>
          </Space>
          <Space>
            {/* 成员列表 */}
            <Tooltip title={
              members.length > 0
                ? `${t('members')}: ${members.map((m: any) => m.username).join(', ')}`
                : t('noMembers')
            }>
              <Tag icon={<UserOutlined />}>
                {members.length}{t('people')}
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
                AI {t('teacher')}
              </Button>
            )}

            {/* 教师广播 */}
            {isTeacherInGroup && discussionId && (
              <Button
                size="small"
                icon={<BellOutlined />}
                onClick={async () => {
                  const val = prompt(t('broadcast') + ':')
                  if (val && val.trim()) {
                    try {
                      await apiClient.post(`/api/interaction/discussions/${discussionId}/broadcast`, { content: val.trim() })
                      message.success(t('broadcastSent'))
                    } catch {
                      message.error(t('broadcastFailed'))
                    }
                  }
                }}
              >
                {t('broadcast')}
              </Button>
            )}

            {/* AI 归纳总结 (仅教师/管理员) */}
            {isTeacherOrAdmin && (
              <Button
                size="small"
                type={hasExistingSummary ? 'default' : 'primary'}
                icon={<BulbOutlined />}
                loading={generatingSummary}
                onClick={async () => {
                  if (hasExistingSummary) {
                    await handleViewSummary()
                  } else {
                    await handleAiSummary()
                  }
                }}
              >
                {generatingSummary ? t('generating') : hasExistingSummary ? t('viewSummary') : t('aiSummary')}
              </Button>
            )}
          </Space>
        </div>
      </Card>

      {/* 讨论主题折叠面板 */}
      {discussionInfo?.description && (
        <Collapse
          ghost
          size="small"
          items={[
            {
              key: 'topic',
              label: <span style={{ fontSize: 13, color: '#888' }}>{t('viewTopic')}</span>,
              children: (
                <div className="markdown-content" style={{ fontSize: 13, color: '#555', padding: '4px 0 8px 0' }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{discussionInfo.description}</ReactMarkdown>
                </div>
              ),
            },
          ]}
          style={{ background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}
        />
      )}

      {/* 消息列表 */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          background: '#f5f5f5',
          padding: '12px 16px',
          minHeight: 0,
        }}
      >
        <Spin spinning={loading}>
          {messages.length === 0 ? (
            <Empty description={t('noMessages')} style={{ marginTop: 60 }} />
          ) : (
            messages.map((msg) => {
              const isAi = msg.msg_type === 'ai_suggest' || msg.username === t('aiAssistant')
              const isMe = msg.username === user?.username
              const isBroadcast = msg.msg_type === 'broadcast'
              const isSystem = msg.msg_type === 'system'

              if (isBroadcast) {
                return (
                  <div key={msg.id} style={{ textAlign: 'center', margin: '8px 0' }}>
                    <Tag color="gold" style={{ fontSize: 12, padding: '2px 12px' }}>
                      {t('teacherBroadcast', { message: msg.content })}
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
                          <Tag icon={<RobotOutlined />} color="orange" style={{ fontSize: 11 }}>{t('aiAssistant')}</Tag>
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
        styles={{ body: { padding: '12px 16px' } }}
      >
        <Space.Compact style={{ width: '100%' }}>
          <TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`${t('inputPlaceholder')} (Enter ${t('send')}, Shift+Enter ${t('send')})`}
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
            {t('send')}
          </Button>
        </Space.Compact>
      </Card>

      {/* AI 归纳总结弹窗 */}
      <Modal
        title={
          <Space>
            <BulbOutlined style={{ color: '#faad14' }} />
            <span>{t('aiSummaryTitle')}</span>
          </Space>
        }
        open={summaryModal}
        onCancel={() => setSummaryModal(false)}
        footer={[
          <Button key="close" onClick={() => setSummaryModal(false)}>{t('close')}</Button>,
          <Button key="export" icon={<DownloadOutlined />}
            disabled={!summaryData?.content && !summaryData?.parsed}
            onClick={() => {
              window.open(`/api/interaction/groups/${groupId}/summary/export`, '_blank')
            }}>
            {t('exportWord')}
          </Button>,
          <Button key="regenerate" type="primary" icon={<ThunderboltOutlined />}
            loading={generatingSummary}
            onClick={handleAiSummary}>
            {t('regenerate')}
          </Button>,
        ]}
        width={700}
      >
        <Spin spinning={summaryLoading || generatingSummary}>
          {(() => {
            // 统一两种数据格式：生成后(data.parsed) vs 查看已有(data.content.parsed)
            const parsed = summaryData?.content?.parsed || summaryData?.parsed || null
            const raw = summaryData?.content?.raw_content ||
                        (typeof summaryData?.content === 'string' ? summaryData.content : null) ||
                        null
            if (parsed) {
              return (
                <div style={{ padding: '8px 0' }}>
                  {/* 总体总结 */}
                  <div style={{ marginBottom: 20 }}>
                    <Text strong style={{ fontSize: 16, color: '#1677ff' }}>{t('overallSummary')}</Text>
                    <div style={{
                      marginTop: 8, padding: 12, background: '#f6ffed',
                      borderRadius: 8, border: '1px solid #b7eb8f', lineHeight: 1.8,
                      fontSize: 14, color: '#333',
                    }}>
                      {parsed.summary || t('noContent')}
                    </div>
                  </div>

                  {/* 关键观点 */}
                  {parsed.key_points?.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <Text strong style={{ fontSize: 16, color: '#1677ff' }}>{t('keyPoints')}</Text>
                      <div style={{ marginTop: 8 }}>
                        {parsed.key_points.map((point: string, i: number) => (
                          <div key={i} style={{
                            padding: '8px 12px', marginBottom: 6,
                            background: '#fff7e6', borderRadius: 6,
                            border: '1px solid #ffd591',
                            fontSize: 14,
                          }}>
                            <Text strong style={{ color: '#fa8c16' }}>{t('pointN', { n: i + 1 })}</Text>
                            {point}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* AI 评价 */}
                  {parsed.ai_comment && (
                    <div style={{ marginBottom: 20 }}>
                      <Text strong style={{ fontSize: 16, color: '#1677ff' }}>{t('aiComment')}</Text>
                      <div style={{
                        marginTop: 8, padding: 12, background: '#e6f7ff',
                        borderRadius: 8, border: '1px solid #91d5ff',
                        fontSize: 14, lineHeight: 1.8,
                      }}>
                        {parsed.ai_comment}
                      </div>
                    </div>
                  )}

                  {/* 评分 */}
                  {parsed.score && (
                    <div style={{ marginBottom: 12 }}>
                      <Text strong style={{ fontSize: 16, color: '#1677ff' }}>{t('overallScore')}</Text>
                      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
                        <Rate
                          disabled
                          value={Math.round(parseInt(parsed.score) / 2)}
                          count={5}
                          style={{ fontSize: 20 }}
                        />
                        <Text style={{ fontSize: 20, fontWeight: 'bold', color: '#fa8c16' }}>
                          {parsed.score}/10
                        </Text>
                      </div>
                    </div>
                  )}

                  {/* 原始 AI 回复 */}
                  {raw && (
                    <details style={{ marginTop: 16 }}>
                      <summary style={{ cursor: 'pointer', color: '#888', fontSize: 13 }}>
                        {t('viewRawAIResponse')}
                      </summary>
                      <pre style={{
                        marginTop: 8, padding: 12, background: '#f5f5f5',
                        borderRadius: 6, fontSize: 12, color: '#666',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        maxHeight: 300, overflow: 'auto',
                      }}>
                        {raw}
                      </pre>
                    </details>
                  )}
                </div>
              )
            }
            // 有原始文本但没有解析结构
            if (raw) {
              return (
                <div style={{ padding: '8px 0' }}>
                  <div style={{
                    padding: 16, background: '#f6ffed',
                    borderRadius: 8, border: '1px solid #b7eb8f',
                    lineHeight: 1.8, fontSize: 14,
                    whiteSpace: 'pre-wrap',
                  }}>
                    {raw}
                  </div>
                </div>
              )
            }
            return (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <Text type="secondary">{t('noSummaryHint')}</Text>
              </div>
            )
          })()}
        </Spin>
      </Modal>
    </div>
  )
}

export default DiscussionRoomPage
