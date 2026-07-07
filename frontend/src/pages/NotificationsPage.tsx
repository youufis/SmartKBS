import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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

const NotificationsPage: React.FC = () => {
  const { t } = useTranslation('system')

  const TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
    exam: { color: '#1677ff', icon: <FileAddOutlined />, label: t('notifExam') },
    score: { color: '#52c41a', icon: <TrophyOutlined />, label: t('notifScore') },
    task: { color: '#faad14', icon: <CheckCircleOutlined />, label: t('notifTask') },
    rollcall: { color: '#722ed1', icon: <AuditOutlined />, label: t('notifRollcall') },
    share: { color: '#13c2c2', icon: <InfoCircleOutlined />, label: t('notifShare') },
    info: { color: '#999', icon: <InfoCircleOutlined />, label: t('notifInfo') },
  }

  const PUSH_TYPE_CONFIG: Record<string, { color: string; icon: string; label: string }> = {
    morning: { color: '#fa8c16', icon: '☀️', label: t('pushMorning') },
    achievement: { color: '#52c41a', icon: '🏆', label: t('pushAchievement') },
    encourage: { color: '#1677ff', icon: '💪', label: t('pushEncourage') },
    reminder: { color: '#ff4d4f', icon: '📌', label: t('pushReminder') },
    milestone: { color: '#722ed1', icon: '⭐', label: t('pushMilestone') },
  }
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
      message.error(t('loadFailed'))
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
      message.error(t('markReadFailed'))
    }
  }

  const handleMarkAllRead = async () => {
    try {
      await notificationsApi.markAllAsRead()
      message.success(t('markAllReadSuccess'))
      fetchNotifications()
      refreshUnreadCount()
    } catch {
      message.error(t('markReadFailed'))
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await notificationsApi.deleteNotification(id)
      message.success(t('notificationDeleted'))
      fetchNotifications()
      refreshUnreadCount()
    } catch {
      message.error(t('deleteFailed'))
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
      message.success(t('markAllReadSuccess'))
      fetchPushes()
    } catch {
      message.error(t('markReadFailed'))
    }
  }

  const handlePushDelete = async (id: number) => {
    try {
      await companionApi.deletePush(id)
      message.success(t('messageDeleted'))
      fetchPushes()
    } catch {
      message.error(t('deleteFailedRetry'))
    }
  }

  return (
    <Card
      title={
        <Space>
          <InfoCircleOutlined />
          {t('notifications')}
        </Space>
      }
      extra={
        activeTab === 'system' ? (
          <Space>
            <Button icon={<CheckOutlined />} onClick={handleMarkAllRead}>{t('markAllAsRead')}</Button>
            <Button icon={<ReloadOutlined />} onClick={fetchNotifications}>{t('refresh')}</Button>
          </Space>
        ) : (
          <Space>
            <Button icon={<CheckOutlined />} onClick={handlePushMarkAllRead}>{t('markAllAsRead')}</Button>
            <Button icon={<ReloadOutlined />} onClick={fetchPushes}>{t('refresh')}</Button>
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
            label: <span><InfoCircleOutlined /> {t('notifications')}</span>,
            children: (
              <>
                <div style={{ marginBottom: 16 }}>
                  <Segmented
                    options={[
                      { label: t('allCount', { count: total }), value: 'all' },
                      { label: t('unread'), value: 'unread' },
                    ]}
                    value={filter}
                    onChange={(val) => { setFilter(val as string); setPage(1) }}
                  />
                </div>
                <Spin spinning={loading}>
                  {notifications.length === 0 ? (
                    <Empty description={t('noNotifications')} />
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
                                <Button key="read" type="text" icon={<CheckOutlined />} onClick={() => handleMarkRead(item.id)}>{t('markAsRead')}</Button>
                              ),
                              <Popconfirm key="delete" title={t('confirmDelete')} onConfirm={() => handleDelete(item.id)}>
                                <Button type="text" danger icon={<DeleteOutlined />}>{t('delete')}</Button>
                              </Popconfirm>,
                            ].filter(Boolean)}
                          >
                            <List.Item.Meta
                              avatar={<span style={{ fontSize: 20, color: cfg.color }}>{cfg.icon}</span>}
                              title={
                                <Space>
                                  <Text strong={!item.is_read}>{item.title}</Text>
                                  <Tag color={cfg.color}>{cfg.label}</Tag>
                                  {!item.is_read && <Tag color="blue">{t('unread')}</Tag>}
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
                                    <Button type="link" size="small" style={{ padding: 0, marginLeft: 8 }} onClick={() => navigate(item.related_link)}>{t('viewDetails')}</Button>
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
                        showTotal: (total) => t('totalNotifications', { count: total }),
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
            label: <span><CustomerServiceOutlined /> {t('companion')}</span>,
            children: (
              <>
                <div style={{ marginBottom: 16 }}>
                  <Segmented
                    options={[
                      { label: t('allCount', { count: pushTotal }), value: 'all' },
                      { label: t('unread'), value: 'unread' },
                    ]}
                    value={pushFilter}
                    onChange={(val) => { setPushFilter(val as string); setPushPage(1) }}
                  />
                </div>
                <Spin spinning={pushLoading}>
                  {pushes.length === 0 ? (
                    <Empty description={t('noNotifications')} />
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
                                >{t('markAsRead')}</Button>
                              ),
                              <Popconfirm key="delete" title={t('confirmDelete')} onConfirm={() => handlePushDelete(item.id)}>
                                <Button type="text" danger icon={<DeleteOutlined />}>{t('delete')}</Button>
                              </Popconfirm>,
                            ].filter(Boolean)}
                          >
                            <List.Item.Meta
                              avatar={<span style={{ fontSize: 20 }}>{cfg.icon}</span>}
                              title={
                                <Space>
                                  <Text strong={!item.is_read}>{item.title}</Text>
                                  <Tag color={cfg.color}>{cfg.label}</Tag>
                                  {!item.is_read && <Tag color="blue">{t('unread')}</Tag>}
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
                        showTotal: (total) => t('totalMessages', { count: total }),
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
