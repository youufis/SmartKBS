import React, { useState, useEffect } from 'react'
import {
  Card, List, Tag, Typography, Button, Space, Empty, Spin,
  message, Popconfirm, Segmented,
} from 'antd'
import {
  CheckOutlined, DeleteOutlined, ReloadOutlined,
  FileAddOutlined, TrophyOutlined, CheckCircleOutlined,
  AuditOutlined, InfoCircleOutlined,
} from '@ant-design/icons'
import * as notificationsApi from '../api/notifications'
import type { NotificationItem } from '../api/notifications'

const { Text } = Typography

const TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  exam: { color: '#1677ff', icon: <FileAddOutlined />, label: '考试' },
  score: { color: '#52c41a', icon: <TrophyOutlined />, label: '积分' },
  task: { color: '#faad14', icon: <CheckCircleOutlined />, label: '任务' },
  rollcall: { color: '#722ed1', icon: <AuditOutlined />, label: '点名' },
  share: { color: '#13c2c2', icon: <InfoCircleOutlined />, label: '分享' },
  info: { color: '#999', icon: <InfoCircleOutlined />, label: '系统' },
}

const NotificationsPage: React.FC = () => {
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState<string>('all')

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
    fetchNotifications()
  }, [page, filter])

  const handleMarkRead = async (id: number) => {
    await notificationsApi.markAsRead(id)
    fetchNotifications()
  }

  const handleMarkAllRead = async () => {
    await notificationsApi.markAllAsRead()
    message.success('已全部标记为已读')
    fetchNotifications()
  }

  const handleDelete = async (id: number) => {
    await notificationsApi.deleteNotification(id)
    message.success('通知已删除')
    fetchNotifications()
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
        <Space>
          <Button icon={<CheckOutlined />} onClick={handleMarkAllRead}>全部已读</Button>
          <Button icon={<ReloadOutlined />} onClick={fetchNotifications}>刷新</Button>
        </Space>
      }
    >
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
                      <Button
                        key="read"
                        type="text"
                        icon={<CheckOutlined />}
                        onClick={() => handleMarkRead(item.id)}
                      >
                        标记已读
                      </Button>
                    ),
                    <Popconfirm
                      key="delete"
                      title="确定删除此通知？"
                      onConfirm={() => handleDelete(item.id)}
                    >
                      <Button type="text" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>,
                  ].filter(Boolean)}
                >
                  <List.Item.Meta
                    avatar={
                      <span style={{ fontSize: 20, color: cfg.color }}>{cfg.icon}</span>
                    }
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
                          <Button type="link" size="small" style={{ padding: 0, marginLeft: 8 }}>
                            查看详情
                          </Button>
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
              onChange: (p) => setPage(p),
            }}
          />
        )}
      </Spin>
    </Card>
  )
}

export default NotificationsPage
