import React, { useState, useEffect } from 'react'
import {
  Card, List, Tag, Typography, Button, Space, Empty, Spin,
  message, Popconfirm, Segmented, Tabs,
} from 'antd'
import {
  CheckOutlined, DeleteOutlined, ReloadOutlined,
  FileAddOutlined, TrophyOutlined, CheckCircleOutlined,
  AuditOutlined, InfoCircleOutlined,
  CustomerServiceOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import * as notificationsApi from '../api/notifications'
import * as companionApi from '../api/companion'
import { useCompanionStore } from '../stores/companionStore'
import type { NotificationItem } from '../api/notifications'
import type { PushMessage } from '../api/companion'

const { Text } = Typography

const TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  exam: { color: '#1677ff', icon: <FileAddOutlined />, label: '考试' },
  score: { color: '#52c41a', icon: <TrophyOutlined />, label: '积分' },
  task: { color: '#faad14', icon: <CheckCircleOutlined />, label: '任务' },
  rollcall: { color: '#722ed1', icon: <AuditOutlined />, label: '点名' },
  share: { color: '#13c2c2', icon: <InfoCircleOutlined />, label: '分享' },
  info: { color: '#999', icon: <InfoCircleOutlined />, label: '系统' },
}

const PUSH_TYPE_CONFIG: Record<string, { color: string; icon: string; label: string }> = {
  morning: { color: '#fa8c16', icon: '☀️', label: '早安提醒' },
  achievement: { color: '#52c41a', icon: '🏆', label: '成就通知' },
  encourage: { color: '#1677ff', icon: '💪', label: '鼓励消息' },
  reminder: { color: '#ff4d4f', icon: '📌', label: '学习提醒' },
  milestone: { color: '#722ed1', icon: '⭐', label: '里程碑' },
}

const NotificationsPage: React.FC = () => {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isStudent = user?.role === 'student'
  const [activeTab, setActiveTab] = useState('system')

  // ── 系统通知 ──
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<string>('all')

  // ── 学伴消息 ──
  const [pushes, setPushes] = useState<PushMessage[]>([])
  const [pushLoading, setPushLoading] = useState(false)
  const [pushTotal, setPushTotal] = useState(0)
  const [pushPage, setPushPage] = useState(1)
  const [pushFilter, setPushFilter] = useState<string>('all')

  // ── 系统通知 ──
  const fetchNotifications = async () => {
    setLoading(true)
    try {
      const data = await notificationsApi.getNotifications(filter === 'unread', page, 20)
      setNotifications(data.notifications)
      setTotal(data.total)
    } catch {
      message.error('加载通知失败')
    }
    setLoading(false)
  }

  useEffect(() => {
    if (activeTab === 'system') fetchNotifications()
  }, [page, filter, activeTab])

  const refreshUnreadCount = () => {
    window.dispatchEvent(new CustomEvent('notification:unread-changed'))
  }

  const handleMarkRead = async (id: number) => {
    try {
      await notificationsApi.markAsRead(id)
      fetchNotifications()
      refreshUnreadCount()
    } catch {
      message.error('标记已读失败，请重试')
    }
  }

  const handleMarkAllRead = async () => {
    try {
      await notificationsApi.markAllAsRead()
      message.success('已全部标记为已读')
      fetchNotifications()
      refreshUnreadCount()
    } catch {
      message.error('操作失败，请重试')
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await notificationsApi.deleteNotification(id)
      message.success('通知已删除')
      fetchNotifications()
      refreshUnreadCount()
    } catch {
      message.error('删除失败，请重试')
    }
  }

  // ── 学伴消息 ──
  const fetchPushes = async () => {
    setPushLoading(true)
    try {
      const data = await companionApi.getPushList(pushPage, 20, pushFilter === 'unread')
      setPushes(Array.isArray(data.pushes) ? data.pushes : [])
      setPushTotal(typeof data.total === 'number' ? data.total : 0)
    } catch {
      setPushes([])
      setPushTotal(0)
    }
    setPushLoading(false)
  }

  useEffect(() => {
    if (activeTab === 'companion') fetchPushes()
  }, [pushPage, pushFilter, activeTab])

  const handlePushMarkAllRead = async () => {
    try {
      await useCompanionStore.getState().markAllPushesRead()
      message.success('已全部标记为已读')
      fetchPushes()
    } catch {
      message.error('操作失败')
    }
  }

  const handlePushDelete = async (id: number) => {
    try {
      await companionApi.deletePush(id)
      message.success('消息已删除')
      fetchPushes()
    } catch {
      message.error('删除失败')
    }
  }

  return (
    <Card
      title={
        <Space>
          <InfoCircleOutlined />
          消息通知
        </Space>
      }
      extra={
        activeTab === 'system' ? (
          <Space>
            <Button icon={<CheckOutlined />} onClick={handleMarkAllRead}>全部已读</Button>
            <Button icon={<ReloadOutlined />} onClick={fetchNotifications}>刷新</Button>
          </Space>
        ) : (
          <Space>
            <Button icon={<CheckOutlined />} onClick={handlePushMarkAllRead}>全部已读</Button>
            <Button icon={<ReloadOutlined />} onClick={fetchPushes}>刷新</Button>
          </Space>
        )
      }
    >
      <Tabs
        activeKey={activeTab}
        onChange={(key) => { setActiveTab(key); setPage(1); setPushPage(1) }}
        items={[
          {
            key: 'system',
            label: <span><InfoCircleOutlined /> 系统通知</span>,
            children: (
              <>
                <div style={{ marginBottom: 16 }}>
                  <Segmented
                    options={[
                      { label: `全部 (${total})`, value: 'all' },
                      { label: '未读', value: 'unread' },
                    ]}
                    value={filter}
                    onChange={(val) => { setFilter(val as string); setPage(1) }}
                  />
                </div>
                <Spin spinning={loading}>
                  {notifications.length === 0 ? (
                    <Empty description="暂无通知" />
                  ) : (
                    <List
                      dataSource={notifications}
                      renderItem={(item) => {
                        const cfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.info
                        return (
                          <List.Item
                            style={{
                              background: item.is_read ? 'transparent' : '#f6f8ff',
                              padding: '12px 16px',
                              borderRadius: 8,
                              marginBottom: 4,
                            }}
                            actions={[
                              !item.is_read && (
                                <Button key="read" type="text" icon={<CheckOutlined />} onClick={() => handleMarkRead(item.id)}>标记已读</Button>
                              ),
                              <Popconfirm key="delete" title="确定删除此通知？" onConfirm={() => handleDelete(item.id)}>
                                <Button type="text" danger icon={<DeleteOutlined />}>删除</Button>
                              </Popconfirm>,
                            ].filter(Boolean)}
                          >
                            <List.Item.Meta
                              avatar={<span style={{ fontSize: 20, color: cfg.color }}>{cfg.icon}</span>}
                              title={
                                <Space>
                                  <Text strong={!item.is_read}>{item.title}</Text>
                                  <Tag color={cfg.color}>{cfg.label}</Tag>
                                  {!item.is_read && <Tag color="blue">未读</Tag>}
                                </Space>
                              }
                              description={
                                <div>
                                  {item.content && <Text type="secondary">{item.content}</Text>}
                                  <br />
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    {item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : ''}
                                  </Text>
                                  {item.related_link && (
                                    <Button type="link" size="small" style={{ padding: 0, marginLeft: 8 }} onClick={() => navigate(item.related_link)}>查看详情</Button>
                                  )}
                                </div>
                              }
                            />
                          </List.Item>
                        )
                      }}
                      pagination={{
                        current: page,
                        pageSize: 20,
                        total,
                        showSizeChanger: true,
                        showTotal: (t) => `共 ${t} 条通知`,
                        pageSizeOptions: ['10', '20', '50'],
                        onChange: (p) => setPage(p),
                      }}
                    />
                  )}
                </Spin>
              </>
            ),
          },
          ...(isStudent ? [{
            key: 'companion',
            label: <span><CustomerServiceOutlined /> 学伴消息</span>,
            children: (
              <>
                <div style={{ marginBottom: 16 }}>
                  <Segmented
                    options={[
                      { label: `全部 (${pushTotal})`, value: 'all' },
                      { label: '未读', value: 'unread' },
                    ]}
                    value={pushFilter}
                    onChange={(val) => { setPushFilter(val as string); setPushPage(1) }}
                  />
                </div>
                <Spin spinning={pushLoading}>
                  {pushes.length === 0 ? (
                    <Empty description="暂无学伴消息" />
                  ) : (
                    <List
                      dataSource={pushes}
                      renderItem={(item) => {
                        const cfg = PUSH_TYPE_CONFIG[item.push_type] || { color: '#999', icon: '💌', label: item.push_type_label }
                        return (
                          <List.Item
                            style={{
                              background: item.is_read ? 'transparent' : '#f6f8ff',
                              padding: '12px 16px',
                              borderRadius: 8,
                              marginBottom: 4,
                            }}
                            actions={[
                              !item.is_read && (
                                <Button key="read" type="text" icon={<CheckOutlined />}
                                  onClick={async () => {
                                    await useCompanionStore.getState().markPushRead(item.id)
                                    fetchPushes()
                                  }}
                                >标记已读</Button>
                              ),
                              <Popconfirm key="delete" title="确定删除此消息？" onConfirm={() => handlePushDelete(item.id)}>
                                <Button type="text" danger icon={<DeleteOutlined />}>删除</Button>
                              </Popconfirm>,
                            ].filter(Boolean)}
                          >
                            <List.Item.Meta
                              avatar={<span style={{ fontSize: 20 }}>{cfg.icon}</span>}
                              title={
                                <Space>
                                  <Text strong={!item.is_read}>{item.title}</Text>
                                  <Tag color={cfg.color}>{cfg.label}</Tag>
                                  {!item.is_read && <Tag color="blue">未读</Tag>}
                                </Space>
                              }
                              description={
                                <div>
                                  <Text type="secondary">{item.content}</Text>
                                  <br />
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    {item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : ''}
                                  </Text>
                                </div>
                              }
                            />
                          </List.Item>
                        )
                      }}
                      pagination={{
                        current: pushPage,
                        pageSize: 20,
                        total: pushTotal,
                        showSizeChanger: true,
                        showTotal: (t) => `共 ${t} 条消息`,
                        pageSizeOptions: ['10', '20', '50'],
                        onChange: (p) => setPushPage(p),
                      }}
                    />
                  )}
                </Spin>
              </>
            ),
          }] : []),
        ]}
      />
    </Card>
  )
}

export default NotificationsPage
