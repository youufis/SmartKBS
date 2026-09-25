import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, List, Tag, Typography, Button, Space, Empty, Spin,
  message, Popconfirm, Segmented, Tabs, Checkbox,
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
import { useNoticeText } from '../utils/notificationText'

const { Text } = Typography

const NotificationsPage: React.FC = () => {
  const { t } = useTranslation('system')
  const noticeText = useNoticeText()

  const TYPE_CONFIG = {
    exam: { color: '#1677ff', icon: <FileAddOutlined />, label: t('notifExam') },
    score: { color: '#52c41a', icon: <TrophyOutlined />, label: t('notifScore') },
    task: { color: '#faad14', icon: <CheckCircleOutlined />, label: t('notifTask') },
    rollcall: { color: '#722ed1', icon: <AuditOutlined />, label: t('notifRollcall') },
    share: { color: '#13c2c2', icon: <InfoCircleOutlined />, label: t('notifShare') },
    info: { color: 'var(--text-tertiary)', icon: <InfoCircleOutlined />, label: t('notifInfo') },
  }

  const PUSH_TYPE_CONFIG = {
    morning: { color: '#fa8c16', icon: '\u2600\uFE0F', label: t('pushMorning') },
    achievement: { color: '#52c41a', icon: '\uD83C\uDFC6', label: t('pushAchievement') },
    encourage: { color: '#1677ff', icon: '\uD83D\uDCAA', label: t('pushEncourage') },
    reminder: { color: '#ff4d4f', icon: '\uD83D\uDCC4', label: t('pushReminder') },
    milestone: { color: '#722ed1', icon: '\u2B50', label: t('pushMilestone') },
  }

  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isStudent = user?.role === 'student'
  const [activeTab, setActiveTab] = useState('system')

  // system notification state
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [filter, setFilter] = useState('all')
  const [selectedNotifIds, setSelectedNotifIds] = useState<Set<number>>(new Set())

  // companion push state
  const [pushes, setPushes] = useState<PushMessage[]>([])
  const [pushLoading, setPushLoading] = useState(false)
  const [pushTotal, setPushTotal] = useState(0)
  const [pushPage, setPushPage] = useState(1)
  const [pushPageSize, setPushPageSize] = useState(20)
  const [pushFilter, setPushFilter] = useState('all')
  const [selectedPushIds, setSelectedPushIds] = useState<Set<number>>(new Set())

  const fetchNotifications = async () => {
    setLoading(true)
    try {
      const data = await notificationsApi.getNotifications(filter === 'unread', page, 20)
      setNotifications(data.notifications)
      setTotal(data.total)
      setSelectedNotifIds(new Set())
    } catch { message.error(t('loadFailed')) }
    setLoading(false)
  }

  useEffect(() => { if (activeTab === 'system') fetchNotifications() }, [page, filter, activeTab])

  const refreshUnreadCount = () => window.dispatchEvent(new CustomEvent('notification:unread-changed'))

  const handleMarkRead = async (id) => {
    try { await notificationsApi.markAsRead(id); fetchNotifications(); refreshUnreadCount() }
    catch { message.error(t('markReadFailed')) }
  }

  const handleMarkAllRead = async () => {
    try { await notificationsApi.markAllAsRead(); message.success(t('markAllReadSuccess')); fetchNotifications(); refreshUnreadCount() }
    catch { message.error(t('markReadFailed')) }
  }

  const handleDelete = async (id) => {
    try { await notificationsApi.deleteNotification(id); message.success(t('notificationDeleted')); fetchNotifications(); refreshUnreadCount() }
    catch { message.error(t('deleteFailed')) }
  }

  const toggleNotifSelect = (id, checked) => {
    setSelectedNotifIds(prev => { const n = new Set(prev); checked ? n.add(id) : n.delete(id); return n })
  }

  const selectAllCurrentPageNotifs = (checked) => {
    setSelectedNotifIds(checked ? new Set(notifications.map(n => n.id)) : new Set())
  }

  const handleBatchDeleteNotifs = async () => {
    if (selectedNotifIds.size === 0) return
    try {
      await notificationsApi.batchDeleteNotifications(Array.from(selectedNotifIds))
      message.success(t('batchDeleteSuccess', { count: selectedNotifIds.size }))
      fetchNotifications(); refreshUnreadCount()
    } catch { message.error(t('deleteFailed')) }
  }

  const fetchPushes = async () => {
    setPushLoading(true)
    try {
      const data = await companionApi.getPushList(pushPage, 20, pushFilter === 'unread')
      setPushes(Array.isArray(data.pushes) ? data.pushes : [])
      setPushTotal(typeof data.total === 'number' ? data.total : 0)
      setSelectedPushIds(new Set())
    } catch { setPushes([]); setPushTotal(0) }
    setPushLoading(false)
  }

  useEffect(() => { if (activeTab === 'companion') fetchPushes() }, [pushPage, pushFilter, activeTab])

  const handlePushMarkAllRead = async () => {
    try { await useCompanionStore.getState().markAllPushesRead(); message.success(t('markAllReadSuccess')); fetchPushes() }
    catch { message.error(t('markReadFailed')) }
  }

  const handlePushDelete = async (id) => {
    try { await companionApi.deletePush(id); message.success(t('messageDeleted')); fetchPushes() }
    catch { message.error(t('deleteFailedRetry')) }
  }

  const togglePushSelect = (id, checked) => {
    setSelectedPushIds(prev => { const n = new Set(prev); checked ? n.add(id) : n.delete(id); return n })
  }

  const selectAllCurrentPagePushes = (checked) => {
    setSelectedPushIds(checked ? new Set(pushes.map(p => p.id)) : new Set())
  }

  const handleBatchDeletePushes = async () => {
    if (selectedPushIds.size === 0) return
    try {
      const result = await companionApi.batchDeletePushes(Array.from(selectedPushIds))
      message.success(t('batchDeleteSuccess', { count: result.deleted || selectedPushIds.size }))
      fetchPushes()
    } catch { message.error(t('deleteFailed')) }
  }

  const renderNotifItem = (item) => {
    const cfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.info
    const nt = noticeText(item)
    const isSelected = selectedNotifIds.has(item.id)
    return (
      <List.Item key={item.id} style={{ background: item.is_read ? 'transparent' : '#f6f8ff', padding: '12px 16px', borderRadius: 8, marginBottom: 4 }} actions={[
        !item.is_read && <Button key="read" type="text" icon={<CheckOutlined />} onClick={() => handleMarkRead(item.id)}>{t('markAsRead')}</Button>,
        <Popconfirm key="del" title={t('confirmDelete')} onConfirm={() => handleDelete(item.id)}><Button type="text" danger icon={<DeleteOutlined />}>{t('delete')}</Button></Popconfirm>,
      ].filter(Boolean)}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flex: 1 }}>
          <Checkbox checked={isSelected} onChange={(e) => toggleNotifSelect(item.id, e.target.checked)} style={{ marginTop: 4 }} />
          <List.Item.Meta avatar={<span style={{ fontSize: 20, color: cfg.color }}>{cfg.icon}</span>} title={<Space><Text strong={!item.is_read}>{nt.title}</Text><Tag color={cfg.color}>{cfg.label}</Tag>{!item.is_read && <Tag color="blue">{t('unread')}</Tag>}</Space>} description={<div>{item.content && <Text type="secondary">{nt.content}</Text>}<br /><Text type="secondary" style={{ fontSize: 12 }}>{item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : ''}</Text>{item.related_link && <Button type="link" size="small" style={{ padding: 0, marginLeft: 8 }} onClick={() => navigate(item.related_link)}>{t('viewDetails')}</Button>}</div>} />
        </div>
      </List.Item>
    )
  }

  const renderPushItem = (item) => {
    const cfg = PUSH_TYPE_CONFIG[item.push_type] || { color: 'var(--text-tertiary)', icon: '\uD83D\uDCEC', label: item.push_type_label }
    const isSelected = selectedPushIds.has(item.id)
    return (
      <List.Item key={item.id} style={{ background: item.is_read ? 'transparent' : '#f6f8ff', padding: '12px 16px', borderRadius: 8, marginBottom: 4 }} actions={[
        !item.is_read && <Button key="read" type="text" icon={<CheckOutlined />} onClick={async () => { await useCompanionStore.getState().markPushRead(item.id); fetchPushes() }}>{t('markAsRead')}</Button>,
        <Popconfirm key="del" title={t('confirmDelete')} onConfirm={() => handlePushDelete(item.id)}><Button type="text" danger icon={<DeleteOutlined />}>{t('delete')}</Button></Popconfirm>,
      ].filter(Boolean)}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flex: 1 }}>
          <Checkbox checked={isSelected} onChange={(e) => togglePushSelect(item.id, e.target.checked)} style={{ marginTop: 4 }} />
          <List.Item.Meta avatar={<span style={{ fontSize: 20 }}>{cfg.icon}</span>} title={<Space><Text strong={!item.is_read}>{item.title}</Text><Tag color={cfg.color}>{cfg.label}</Tag>{!item.is_read && <Tag color="blue">{t('unread')}</Tag>}</Space>} description={<div><Text type="secondary">{item.content}</Text><br /><Text type="secondary" style={{ fontSize: 12 }}>{item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : ''}</Text></div>} />
        </div>
      </List.Item>
    )
  }

  return (
    <Card
      title={<Space><InfoCircleOutlined />{t('notifications')}</Space>}
      extra={
        activeTab === 'system' ? (
          <Space>
            {selectedNotifIds.size > 0 && <>
              <Popconfirm title={t('confirmBatchDelete', { count: selectedNotifIds.size })} onConfirm={handleBatchDeleteNotifs}>
                <Button type="primary" danger icon={<DeleteOutlined />}>{t('deleteSelected', { count: selectedNotifIds.size })}</Button>
              </Popconfirm>
              <Button onClick={() => setSelectedNotifIds(new Set())}>{t('clearSelection')}</Button>
            </>}
            <Button icon={<CheckOutlined />} onClick={handleMarkAllRead}>{t('markAllAsRead')}</Button>
            <Button icon={<ReloadOutlined />} onClick={fetchNotifications}>{t('refresh')}</Button>
          </Space>
        ) : (
          <Space>
            {selectedPushIds.size > 0 && <>
              <Popconfirm title={t('confirmBatchDelete', { count: selectedPushIds.size })} onConfirm={handleBatchDeletePushes}>
                <Button type="primary" danger icon={<DeleteOutlined />}>{t('deleteSelected', { count: selectedPushIds.size })}</Button>
              </Popconfirm>
              <Button onClick={() => setSelectedPushIds(new Set())}>{t('clearSelection')}</Button>
            </>}
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
                  <Segmented options={[{ label: t('allCount', { count: total }), value: 'all' }, { label: t('unread'), value: 'unread' }]} value={filter} onChange={(val) => { setFilter(val); setPage(1) }} />
                </div>
                <Spin spinning={loading}>
                  {notifications.length === 0 ? <Empty description={t('noNotifications')} /> : <>
                    {selectedNotifIds.size > 0 && <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fff7e6', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 12 }}>
                      <Text strong>{t('selectedCount', { count: selectedNotifIds.size })}</Text>
                      <Button size="small" onClick={() => selectAllCurrentPageNotifs(true)}>{t('selectAllCurrentPage')}</Button>
                      <Button size="small" danger onClick={handleBatchDeleteNotifs}>{t('deleteSelected', { count: selectedNotifIds.size })}</Button>
                      <Button size="small" onClick={() => setSelectedNotifIds(new Set())}>{t('clearSelection')}</Button>
                    </div>}
                    <List dataSource={notifications} renderItem={renderNotifItem} pagination={{ current: page, pageSize, total, showSizeChanger: true, showTotal: (tot) => t('totalNotifications', { count: tot }), pageSizeOptions: ['10', '20', '50'], onChange: (p, ps) => { if (ps && ps !== pageSize) { setPageSize(ps); setPage(1) } else { setPage(p) } } }} />
                  </>}
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
                  <Segmented options={[{ label: t('allCount', { count: pushTotal }), value: 'all' }, { label: t('unread'), value: 'unread' }]} value={pushFilter} onChange={(val) => { setPushFilter(val); setPushPage(1) }} />
                </div>
                <Spin spinning={pushLoading}>
                  {pushes.length === 0 ? <Empty description={t('noNotifications')} /> : <>
                    {selectedPushIds.size > 0 && <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fff7e6', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 12 }}>
                      <Text strong>{t('selectedCount', { count: selectedPushIds.size })}</Text>
                      <Button size="small" onClick={() => selectAllCurrentPagePushes(true)}>{t('selectAllCurrentPage')}</Button>
                      <Button size="small" danger onClick={handleBatchDeletePushes}>{t('deleteSelected', { count: selectedPushIds.size })}</Button>
                      <Button size="small" onClick={() => setSelectedPushIds(new Set())}>{t('clearSelection')}</Button>
                    </div>}
                    <List dataSource={pushes} renderItem={renderPushItem} pagination={{ current: pushPage, pageSize: pushPageSize, total: pushTotal, showSizeChanger: true, showTotal: (tot) => t('totalMessages', { count: tot }), pageSizeOptions: ['10', '20', '50'], onChange: (p, ps) => { if (ps && ps !== pushPageSize) { setPushPageSize(ps); setPushPage(1) } else { setPushPage(p) } } }} />
                  </>}
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
