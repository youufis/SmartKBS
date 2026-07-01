import React, { useState, useEffect, useCallback } from 'react'
import { Badge, Popover, List, Button, Space, Typography, Empty, Spin, Tag, Tooltip } from 'antd'
import {
  BellOutlined, CheckOutlined, DeleteOutlined,
  FileAddOutlined, TrophyOutlined, CheckCircleOutlined,
  AuditOutlined, InfoCircleOutlined, RightOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import * as notificationsApi from '../api/notifications'
import * as companionApi from '../api/companion'
import { useCompanionStore } from '../stores/companionStore'
import type { NotificationItem } from '../api/notifications'
import type { PushMessage } from '../api/companion'

const { Text } = Typography

const TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  exam: { color: '#1677ff', icon: <FileAddOutlined /> },
  score: { color: '#52c41a', icon: <TrophyOutlined /> },
  task: { color: '#faad14', icon: <CheckCircleOutlined /> },
  rollcall: { color: '#722ed1', icon: <AuditOutlined /> },
  share: { color: '#13c2c2', icon: <InfoCircleOutlined /> },
  info: { color: '#999', icon: <InfoCircleOutlined /> },
}

const PUSH_TYPE_CONFIG: Record<string, { color: string; icon: string }> = {
  morning: { color: '#fa8c16', icon: '☀️' },
  achievement: { color: '#52c41a', icon: '🏆' },
  encourage: { color: '#1677ff', icon: '💪' },
  reminder: { color: '#ff4d4f', icon: '📌' },
  milestone: { color: '#722ed1', icon: '⭐' },
}

const NotificationBell: React.FC = () => {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isStudent = user?.role === 'student'
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [pushUnreadCount, setPushUnreadCount] = useState(0)
  const [pushes, setPushes] = useState<PushMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const fetchAllUnreadCounts = useCallback(async () => {
    try {
      const tasks = [notificationsApi.getUnreadCount()]
      if (isStudent) {
        tasks.push(companionApi.getUnreadPushCount().then(r => r.count).catch(() => 0))
      }
      const [notifCount, pushCount = 0] = await Promise.all(tasks)
      setUnreadCount(notifCount)
      setPushUnreadCount(pushCount as number)
    } catch {
      // ignore
    }
  }, [isStudent])

  const fetchRecentNotifications = useCallback(async () => {
    setLoading(true)
    try {
      const tasks: Promise<any>[] = [notificationsApi.getNotifications(false, 1, 5)]
      if (isStudent) {
        tasks.push(companionApi.getPushList(1, 3, true).catch(() => ({ pushes: [], total: 0 })))
      }
      const [notifData, pushData] = await Promise.all(tasks)
      setNotifications(notifData.notifications)
      setPushes(pushData?.pushes || [])
    } catch {
      // ignore
    }
    setLoading(false)
  }, [isStudent])

  useEffect(() => {
    fetchAllUnreadCounts()
    const timer = setInterval(fetchAllUnreadCounts, 30000)
    return () => clearInterval(timer)
  }, [fetchAllUnreadCounts])

  useEffect(() => {
    if (!isStudent) return
    const unsub = useCompanionStore.subscribe((state) => {
      setPushUnreadCount(state.unreadCount)
    })
    return () => unsub()
  }, [isStudent])

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen)
    if (newOpen) {
      fetchRecentNotifications()
    }
  }

  const handleMarkAllRead = async () => {
    try {
      const tasks: Promise<any>[] = [notificationsApi.markAllAsRead()]
      if (isStudent) {
        tasks.push(useCompanionStore.getState().markAllPushesRead())
      }
      await Promise.all(tasks)
      fetchAllUnreadCounts()
      fetchRecentNotifications()
    } catch {
      // ignore
    }
  }

  const handleMarkRead = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    try {
      await notificationsApi.markAsRead(id)
      setUnreadCount((prev) => Math.max(0, prev - 1))
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)))
      fetchAllUnreadCounts()
    } catch {
      // ignore
    }
  }

  const handleDelete = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    try {
      await notificationsApi.deleteNotification(id)
      setNotifications((prev) => prev.filter((n) => n.id !== id))
      fetchAllUnreadCounts()
    } catch {
      // ignore
    }
  }

  const handlePushMarkRead = async (e: React.MouseEvent, pushId: number) => {
    e.stopPropagation()
    await useCompanionStore.getState().markPushRead(pushId)
    setPushes((prev) => prev.filter((p) => p.id !== pushId))
    setPushUnreadCount((prev) => Math.max(0, prev - 1))
  }

  const handlePushDelete = async (e: React.MouseEvent, pushId: number) => {
    e.stopPropagation()
    try {
      await companionApi.deletePush(pushId)
      setPushes((prev) => prev.filter((p) => p.id !== pushId))
      fetchAllUnreadCounts()
    } catch {
      // ignore
    }
  }

  const content = (
    <div style={{ width: 360, maxHeight: 420, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
        <Text strong>消息通知</Text>
        <Space size={4}>
          {unreadCount > 0 && (
            <Button type="text" size="small" icon={<CheckOutlined />} onClick={handleMarkAllRead}>
              全部已读
            </Button>
          )}
        </Space>
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 100 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}><Spin size="small" /></div>
        ) : notifications.length === 0 && (!isStudent || pushes.length === 0) ? (
          <Empty description="暂无通知" style={{ padding: 24 }} />
        ) : (
          <>
            {/* 系统通知 */}
            {notifications.length > 0 && (
              <div style={{ padding: '4px 12px', fontSize: 11, color: '#999', fontWeight: 600 }}>系统通知</div>
            )}
            <List
              dataSource={notifications}
              renderItem={(item) => {
                const cfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.info
                return (
                  <List.Item
                    style={{
                      padding: '8px 12px',
                      background: item.is_read ? 'transparent' : '#f6f8ff',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#f5f5f5' }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = item.is_read ? 'transparent' : '#f6f8ff'
                    }}
                    onClick={() => {
                      if (item.related_link) {
                        navigate(item.related_link)
                        setOpen(false)
                      }
                    }}
                    actions={
                      item.is_read
                        ? [<Button type="text" size="small" icon={<DeleteOutlined />} onClick={(e) => handleDelete(e, item.id)} />]
                        : [
                          <Button type="text" size="small" icon={<CheckOutlined />} onClick={(e) => handleMarkRead(e, item.id)} />,
                          <Button type="text" size="small" icon={<DeleteOutlined />} onClick={(e) => handleDelete(e, item.id)} />,
                        ]
                    }
                  >
                    <List.Item.Meta
                      avatar={
                        <span style={{ fontSize: 16, color: cfg.color }}>{cfg.icon}</span>
                      }
                      title={
                        <Space size={4}>
                          <Text strong={!item.is_read} style={{ fontSize: 13 }}>{item.title}</Text>
                          {!item.is_read && <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>新</Tag>}
                        </Space>
                      }
                      description={
                        <div>
                          {item.content && <Text type="secondary" style={{ fontSize: 12 }}>{item.content}</Text>}
                          <br />
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : ''}
                          </Text>
                        </div>
                      }
                    />
                  </List.Item>
                )
              }}
            />
            {/* 学伴推送（仅学生） */}
            {isStudent && pushes.length > 0 && (
              <>
                <div style={{ padding: '4px 12px', fontSize: 11, color: '#999', fontWeight: 600, borderTop: notifications.length > 0 ? '1px solid #f0f0f0' : 'none' }}>学伴消息</div>
                <List
                  dataSource={pushes}
                  renderItem={(item) => {
                    const cfg = PUSH_TYPE_CONFIG[item.push_type] || { color: '#999', icon: '💌' }
                    return (
                      <List.Item
                        style={{
                          padding: '8px 12px',
                          background: 'transparent',
                          cursor: 'default',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = '#f5f5f5' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                        actions={[
                          <Button type="text" size="small" icon={<CheckOutlined />}
                            onClick={(e) => handlePushMarkRead(e, item.id)}
                          />,
                          <Button type="text" size="small" icon={<DeleteOutlined />}
                            onClick={(e) => handlePushDelete(e, item.id)}
                          />,
                        ]}
                      >
                        <List.Item.Meta
                          avatar={
                            <span style={{ fontSize: 16 }}>{cfg.icon}</span>
                          }
                          title={
                            <Space size={4}>
                              <Text style={{ fontSize: 13 }}>{item.title}</Text>
                              <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>学伴</Tag>
                            </Space>
                          }
                          description={
                            <div>
                              {item.content && <Text type="secondary" style={{ fontSize: 12 }}>{item.content}</Text>}
                              <br />
                              <Text type="secondary" style={{ fontSize: 11 }}>
                                {item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : ''}
                              </Text>
                            </div>
                          }
                        />
                      </List.Item>
                    )
                  }}
                />
              </>
            )}
          </>
        )}
      </div>
      <div style={{ borderTop: '1px solid #f0f0f0', padding: '6px 12px', textAlign: 'center' }}>
        <Button type="link" size="small" onClick={() => { setOpen(false); navigate('/notifications') }}>
          查看全部通知 <RightOutlined />
        </Button>
      </div>
    </div>
  )

  return (
    <Popover
      content={content}
      trigger="click"
      open={open}
      onOpenChange={handleOpenChange}
      placement="bottomRight"
    >
      <Tooltip title="消息通知">
        <Badge count={unreadCount + pushUnreadCount} size="small" offset={[-2, 2]}>
          <BellOutlined style={{ fontSize: 18, cursor: 'pointer', color: '#666' }} />
        </Badge>
      </Tooltip>
    </Popover>
  )
}

export default NotificationBell
