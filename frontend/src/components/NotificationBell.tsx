import React, { useState, useEffect, useCallback } from 'react'
import { Badge, Popover, List, Button, Space, Typography, Empty, Spin, Tag, Tooltip } from 'antd'
import {
  BellOutlined, CheckOutlined, DeleteOutlined,
  FileAddOutlined, TrophyOutlined, CheckCircleOutlined,
  AuditOutlined, InfoCircleOutlined, RightOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import * as notificationsApi from '../api/notifications'
import type { NotificationItem } from '../api/notifications'

const { Text } = Typography

const TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  exam: { color: '#1677ff', icon: <FileAddOutlined /> },
  score: { color: '#52c41a', icon: <TrophyOutlined /> },
  task: { color: '#faad14', icon: <CheckCircleOutlined /> },
  rollcall: { color: '#722ed1', icon: <AuditOutlined /> },
  share: { color: '#13c2c2', icon: <InfoCircleOutlined /> },
  info: { color: '#999', icon: <InfoCircleOutlined /> },
}

const NotificationBell: React.FC = () => {
  const navigate = useNavigate()
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const fetchUnreadCount = useCallback(async () => {
    try {
      const count = await notificationsApi.getUnreadCount()
      setUnreadCount(count)
    } catch {
      // ignore
    }
  }, [])

  const fetchRecentNotifications = useCallback(async () => {
    setLoading(true)
    try {
      const data = await notificationsApi.getNotifications(false, 1, 8)
      setNotifications(data.notifications)
    } catch {
      // ignore
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchUnreadCount()
    const timer = setInterval(fetchUnreadCount, 30000)
    return () => clearInterval(timer)
  }, [fetchUnreadCount])

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen)
    if (newOpen) {
      fetchRecentNotifications()
    }
  }

  const handleMarkAllRead = async () => {
    try {
      await notificationsApi.markAllAsRead()
      setUnreadCount(0)
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })))
    } catch {
      // ignore
    }
  }

  const handleMarkRead = async (id: number) => {
    try {
      await notificationsApi.markAsRead(id)
      setUnreadCount((prev) => Math.max(0, prev - 1))
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)))
    } catch {
      // ignore
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await notificationsApi.deleteNotification(id)
      setNotifications((prev) => prev.filter((n) => n.id !== id))
      fetchUnreadCount()
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
        ) : notifications.length === 0 ? (
          <Empty description="暂无通知" style={{ padding: 24 }} />
        ) : (
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
                      ? [<Button type="text" size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(item.id)} />]
                      : [
                        <Button type="text" size="small" icon={<CheckOutlined />} onClick={() => handleMarkRead(item.id)} />,
                        <Button type="text" size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(item.id)} />,
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
        <Badge count={unreadCount} size="small" offset={[-2, 2]}>
          <BellOutlined style={{ fontSize: 18, cursor: 'pointer', color: '#666' }} />
        </Badge>
      </Tooltip>
    </Popover>
  )
}

export default NotificationBell
