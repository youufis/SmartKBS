import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import {
  Card, Table, Typography, Button, Space, Modal, Form, Input,
  Select, message, Empty, Tag, Switch, Popconfirm, Pagination, Tooltip,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, EditOutlined, BellOutlined, PushpinOutlined,
  ReloadOutlined, BulbOutlined, EyeOutlined, SearchOutlined, TeamOutlined,
} from '@ant-design/icons'
import * as notificationsApi from '../api/notifications'
import type { AnnouncementItem } from '../api/notifications'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useIsMobile } from '../hooks/useIsMobile'
import { useAuthStore } from '../stores/authStore'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
import ScopeTag from '../components/ScopeTag'

const { Text } = Typography
const { TextArea } = Input

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'red',
  important: 'orange',
  normal: 'blue',
  low: 'default',
}

/** 相对时间展示：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 7 天回退日期 */
function relativeTime(v: string): string {
  const t = new Date(v).getTime()
  if (Number.isNaN(t)) return v
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day <= 7) return `${day} 天前`
  return new Date(v).toLocaleDateString('zh-CN')
}

const AnnouncementsPage: React.FC = () => {
  const { t } = useTranslation('system')

  const PRIORITY_LABELS: Record<string, string> = {
    urgent: t('urgent'),
    important: t('important'),
    normal: t('normal'),
    low: t('lowPriority'),
  }
  const user = useAuthStore((s) => s.user)
  const isAdminOrTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [createModal, setCreateModal] = useState(false)
  const [aiModal, setAiModal] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [editModal, setEditModal] = useState<AnnouncementItem | null>(null)
  const [detailModal, setDetailModal] = useState<AnnouncementItem | null>(null)
  const [form] = Form.useForm()
  const [editForm] = Form.useForm()
  const [aiForm] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [announceScope, setAnnounceScope] = useState<ActivityScopeValue>({
    target_scope: 'teacher_classes',
    target_grade: '',
    target_class: '',
    target_users: '',
  })
  const [keyword, setKeyword] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [readUsersModal, setReadUsersModal] = useState<AnnouncementItem | null>(null)
  const [readUsers, setReadUsers] = useState<Array<{ username: string; name: string; read_at: string }>>([])
  const [readUsersLoading, setReadUsersLoading] = useState(false)

  const fetchAnnouncements = async (p = page, ps = pageSize, kw = keyword, pri = priorityFilter) => {
    setLoading(true)
    try {
      const data = await notificationsApi.getAnnouncements(p, ps, kw, pri)
      setAnnouncements(data.announcements || [])
      setTotal(data.total || 0)
    } catch {
      message.error(t('loadFailed'))
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchAnnouncements(1, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


      // AI 生成公告
  const handleAiGenerate = async () => {
    try {
      const values = await aiForm.validateFields()
      setAiLoading(true)
      const { data } = await apiClient.post('/api/notifications/announcements/ai-generate', values, { timeout: 180000 })
      if (data.task_id) {
        const result = await pollAiTask(data.task_id)
        if (result && result.status === 'ok' && result.data) {
          form.setFieldsValue({
            title: result.data.title,
            content: result.data.content,
            target_role: values.target_role,
            priority: values.priority,
          })
          // 同步 AI 选择的年级/班级到 scope selector
          const aiGrade = values.target_grade || ''
          const aiClass = values.target_class || ''
          setAnnounceScope({
            target_scope: aiClass ? 'class' : aiGrade ? 'grade' : 'teacher_classes',
            target_grade: aiGrade,
            target_class: aiClass,
            target_users: '',
          })
          message.success(t('aiContentReady'))
          setAiModal(false)
          aiForm.resetFields()
          setCreateModal(true)
        } else {
          message.error(result?.content || t('aiGenerateFailed'))
        }
      } else if (data.status === 'ok' && data.data) {
        form.setFieldsValue({
          title: data.data.title,
          content: data.data.content,
          target_role: values.target_role,
          priority: values.priority,
        })
        // 同步 AI 选择的年级/班级到 scope selector
        const aiGrade = values.target_grade || ''
        const aiClass = values.target_class || ''
        setAnnounceScope({
          target_scope: aiClass ? 'class' : aiGrade ? 'grade' : 'teacher_classes',
          target_grade: aiGrade,
          target_class: aiClass,
          target_users: '',
        })
        message.success(t('aiContentReady'))
        setAiModal(false)
        aiForm.resetFields()
        setCreateModal(true)
      } else {
        message.error(data.content || t('anGenFailed'))
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return
      message.error(t('generateFailed'))
    } finally {
      setAiLoading(false)
    }
  }

  const handleCreate = async () => {
    try {
      const values = await form.validateFields()
      setSubmitting(true)
      await notificationsApi.createAnnouncement({
        ...values,
        target_scope: announceScope.target_scope,
        target_grade: announceScope.target_grade,
        target_class: announceScope.target_class,
        target_users: announceScope.target_users,
      })
      message.success(t('publishSuccess'))
      setCreateModal(false)
      form.resetFields()
      setAnnounceScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
      fetchAnnouncements(1, pageSize)
      setPage(1)
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return
      message.error(t('publishFailed'))
    }
    setSubmitting(false)
  }
  const handleEdit = async () => {
    if (!editModal) return
    try {
      const values = await editForm.validateFields()
      setSubmitting(true)
      await notificationsApi.updateAnnouncement(editModal.id, values)
      message.success(t('updateSuccess'))
      setEditModal(null)
      fetchAnnouncements(page, pageSize)
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return
      message.error(t('publishFailed'))
    }
    setSubmitting(false)
  }
  const handleDelete = async (id: number) => {
    try {
      await notificationsApi.deleteAnnouncement(id)
      message.success(t('deleteSuccess'))
      fetchAnnouncements(page, pageSize)
    } catch {
      message.error(t('deleteFailed'))
    }
  }

  const handleBatchDelete = async () => {
    if (selectedRowKeys.length === 0) return
    setBatchDeleting(true)
    try {
      const { deleted } = await notificationsApi.batchDeleteAnnouncements(selectedRowKeys.map(Number))
      message.success(deleted > 0 ? t('batchDeleteAnnSuccess', { count: deleted }) : t('noDeleteTarget'))
      setSelectedRowKeys([])
      fetchAnnouncements(1, pageSize)
      setPage(1)
    } catch {
      message.error(t('deleteFailed'))
    } finally {
      setBatchDeleting(false)
    }
  }

  // 查看公告详情：同时标记当前用户已读（幂等）
  const openDetail = async (record: AnnouncementItem) => {
    setDetailModal(record)
    try {
      await notificationsApi.markAnnouncementRead(record.id)
    } catch {
      // 标记已读失败不阻断查看
    }
  }
  // 首页公告卡是「点哪条开哪条」（/announcements?id=N）。以前统一只跳列表，
  // 学生点第一条却落到列表页，还得自己再找一遍。
  const [searchParams, setSearchParams] = useSearchParams()
  const deepLinkDone = useRef(false)
  useEffect(() => {
    const wanted = Number(searchParams.get('id'))
    if (!wanted || deepLinkDone.current) return
    deepLinkDone.current = true
    void (async () => {
      const inList = announcements.find((a) => a.id === wanted)
      const hit = inList ?? (await notificationsApi.getAnnouncements(1, 50)
        .then((r) => r.announcements.find((a) => a.id === wanted))
        .catch(() => undefined))
      if (hit) void openDetail(hit)
      searchParams.delete('id')
      setSearchParams(searchParams, { replace: true })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcements, searchParams])

  // 查看已读名单
  const openReadUsers = async (record: AnnouncementItem) => {
    setReadUsersModal(record)
    setReadUsers([])
    setReadUsersLoading(true)
    try {
      const data = await notificationsApi.getAnnouncementReadUsers(record.id)
      setReadUsers(data.read_users || [])
    } catch {
      setReadUsers([])
    } finally {
      setReadUsersLoading(false)
    }
  }

  const handleTableChange = (pagination: any) => {
    setPage(pagination.current)
    setPageSize(pagination.pageSize)
    fetchAnnouncements(pagination.current, pagination.pageSize)
  }

  // 窄屏用卡片列表替代六列表格：免横滑即可读全标题与关键信息（桌面仍为表格）
  const isMobile = useIsMobile()

  const columns = [
    {
      title: t('pinned'),
      dataIndex: 'is_pinned',
      key: 'is_pinned',
      width: 50,
      render: (pinned: boolean) => pinned ? <PushpinOutlined style={{ color: '#fa8c16' }} /> : null,
    },
    {
      title: t('announcementTitle'),
      dataIndex: 'title',
      key: 'title',
      className: 'col-min-190',
      ellipsis: true,
      render: (title: string, record: AnnouncementItem) => (
        <Space>
          <Text strong style={{ cursor: 'pointer' }} onClick={() => openDetail(record)}>{title}</Text>
          <Tag color={PRIORITY_COLORS[record.priority] || 'default'}>
            {PRIORITY_LABELS[record.priority] || record.priority}
          </Tag>
        </Space>
      ),
    },
    {
      title: t('publisher'),
      dataIndex: 'creator_username',
      key: 'creator_username',
      width: 100,
      render: (name: string, record: AnnouncementItem) => record.creator_name || name || '-',
    },
    {
      title: t('scope'),
      key: 'target',
      width: 140,
      render: (_: any, record: AnnouncementItem) => {
        const hasSpecific = record.target_role !== 'all' || record.target_grade || record.target_class
        if (!hasSpecific) return <Tag color="blue">{t('anEveryone')}</Tag>
        return (
          <Space size={4}>
            {record.target_role !== 'all' && (
              <Tag>{record.target_role === 'teacher' ? t('anRoleTeacher') : record.target_role === 'student' ? t('anRoleStudent') : record.target_role}</Tag>
            )}
            {(record.target_grade || record.target_class) && (
              <ScopeTag variant="text" grade={record.target_grade} classes={record.target_class} />
            )}
          </Space>
        )
      },
    },
    {
      title: t('publishTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 140,
      render: (v: string) => v ? (
        <Tooltip title={new Date(v).toLocaleString('zh-CN')}>
          <Text type="secondary" style={{ fontSize: 12 }}>{relativeTime(v)}</Text>
        </Tooltip>
      ) : '-',
    },
    ...(isAdminOrTeacher ? [{
      title: t('readCount'),
      key: 'read_count',
      width: 80,
      render: (_: any, record: AnnouncementItem) => (
        <Button type="link" size="small" style={{ padding: 0 }}
          onClick={() => openReadUsers(record)}>
          <TeamOutlined /> {record.read_count ?? 0}
        </Button>
      ),
    }] : []),
    {
      title: t('actions'),
      key: 'actions',
      width: 140,
      render: (_: any, record: AnnouncementItem) => (
        <Space>
          <Tooltip title={t('view')}>
            <Button type="text" icon={<EyeOutlined />} size="small" onClick={() => openDetail(record)} />
          </Tooltip>
          {isAdminOrTeacher && (
            <>
              <Tooltip title={t('edit')}>
                <Button type="text" icon={<EditOutlined />} size="small"
                  onClick={() => { setEditModal(record); editForm.setFieldsValue(record) }} />
              </Tooltip>
              <Popconfirm title={t('confirmDeleteAnnouncement')} onConfirm={() => handleDelete(record.id)}>
                <Tooltip title={t('delete')}>
                  <Button type="text" danger icon={<DeleteOutlined />} size="small" />
                </Tooltip>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        icon={<BellOutlined />}
        title={t('announcements')}
        subtitle={t('announcementsSubtitle')}
        extra={(
          <>
            <Button icon={<ReloadOutlined />} onClick={() => fetchAnnouncements(page, pageSize)}
              aria-label={t('refresh')} />
            {isAdminOrTeacher && (
              <>
                <Button icon={<BulbOutlined />} onClick={() => { setAiModal(true); aiForm.resetFields(); }}>
                  {t('aiDraft')}
                </Button>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModal(true)}>
                  {t('addAnnouncement')}
                </Button>
              </>
            )}
          </>
        )}
      />

      <Card>
        {/* 搜索筛选 + 批量删除栏 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t('searchAnnouncementPh')}
            style={{ width: 240 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => { setPage(1); fetchAnnouncements(1, pageSize) }}
          />
          <Select
            allowClear
            placeholder={t('priorityFilterPh')}
            style={{ width: 140 }}
            value={priorityFilter || undefined}
            onChange={(v) => { setPriorityFilter(v || ''); setPage(1); fetchAnnouncements(1, pageSize, keyword, v || '') }}
            options={[
              { value: 'urgent', label: t('urgent') },
              { value: 'important', label: t('important') },
              { value: 'normal', label: t('normal') },
              { value: 'low', label: t('lowPriority') },
            ]}
          />
          <Button onClick={() => { setPage(1); fetchAnnouncements(1, pageSize) }}>{t('search')}</Button>
          {(keyword || priorityFilter) && (
            <Button type="text" onClick={() => { setKeyword(''); setPriorityFilter(''); setPage(1); fetchAnnouncements(1, pageSize, '', '') }}>
              {t('clearFilter')}
            </Button>
          )}
          {isAdminOrTeacher && selectedRowKeys.length > 0 && (
            <Button danger icon={<DeleteOutlined />} loading={batchDeleting} onClick={handleBatchDelete}>
              {t('batchDelete')} ({selectedRowKeys.length})
            </Button>
          )}
        </div>
        {isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {announcements.length === 0 && !loading && <Empty description={t('noAnnouncements')} />}
            {announcements.map((record: AnnouncementItem) => (
              <Card key={record.id} size="small" styles={{ body: { padding: '10px 12px' } }}>
                <Text strong style={{ cursor: 'pointer', display: 'block' }} onClick={() => openDetail(record)}>
                  {record.is_pinned && <PushpinOutlined style={{ color: '#fa8c16', marginRight: 4 }} />}
                  {record.title}
                </Text>
                <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                  <Tag color={PRIORITY_COLORS[record.priority] || 'default'}>
                    {PRIORITY_LABELS[record.priority] || record.priority}
                  </Tag>
                  {record.target_role !== 'all' && (
                    <Tag>{record.target_role === 'teacher' ? t('anRoleTeacher') : record.target_role === 'student' ? t('anRoleStudent') : record.target_role}</Tag>
                  )}
                  {(record.target_grade || record.target_class) && (
                    <ScopeTag variant="text" grade={record.target_grade} classes={record.target_class} />
                  )}
                </div>
                <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }} className="page-header-flex">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {record.creator_username || record.creator_name || '-'} · {record.created_at ? new Date(record.created_at).toLocaleString('zh-CN') : '-'}
                  </Text>
                  <Space size={4}>
                    <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => openDetail(record)} />
                    {isAdminOrTeacher && (
                      <>
                        <Button type="text" size="small" icon={<EditOutlined />}
                          onClick={() => { setEditModal(record); editForm.setFieldsValue(record) }} />
                        <Popconfirm title={t('confirmDeleteAnnouncement')} onConfirm={() => handleDelete(record.id)}>
                          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </>
                    )}
                  </Space>
                </div>
              </Card>
            ))}
            {total > 0 && (
              <Pagination
                current={page} pageSize={pageSize} total={total} simple size="small"
                onChange={(p) => fetchAnnouncements(p, pageSize)}
                style={{ textAlign: 'center', paddingTop: 4 }}
              />
            )}
          </div>
        ) : (
        <Table className="nowrap-cells-table announce-table"
          dataSource={announcements}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="small"
          rowSelection={isAdminOrTeacher ? {
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys),
          } : undefined}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (total) => t('totalAnnouncements', { count: total }),
            pageSizeOptions: ['10', '20', '50'],
          }}
          onChange={handleTableChange}
          locale={{ emptyText: <Empty description={t('noAnnouncements')} /> }}
        />
        )}
      </Card>

      {/* ── 查看公告详情弹窗 ── */}
      <Modal
        title={<Space><BellOutlined />{detailModal?.title}</Space>}
        open={!!detailModal}
        onCancel={() => setDetailModal(null)}
        footer={<Button onClick={() => setDetailModal(null)}>{t('close')}</Button>}
        width={640}
      >
        {detailModal && (
          <div>
            <Space style={{ marginBottom: 12 }}>
              {detailModal.is_pinned && <PushpinOutlined style={{ color: '#fa8c16' }} />}
              <Tag color={PRIORITY_COLORS[detailModal.priority] || 'default'}>
                {PRIORITY_LABELS[detailModal.priority] || detailModal.priority}
              </Tag>
              {detailModal.target_role !== 'all' && (
                <Tag>{detailModal.target_role === 'teacher' ? t('anRoleTeacher') : detailModal.target_role === 'student' ? t('anRoleStudent') : detailModal.target_role}</Tag>
              )}
              {(detailModal.target_grade || detailModal.target_class) && (
                <ScopeTag variant="text" grade={detailModal.target_grade} classes={detailModal.target_class} />
              )}
            </Space>
            <div style={{ color: 'var(--text-tertiary)', fontSize: 12, marginBottom: 16 }}>
              {t('anPublisher')}{detailModal.creator_username || detailModal.creator_name}
              &nbsp;|&nbsp;
              {detailModal.created_at ? new Date(detailModal.created_at).toLocaleString('zh-CN') : ''}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>
              {detailModal.content}
            </div>
          </div>
        )}
      </Modal>

      {/* ── 已读名单弹窗 ── */}
      <Modal
        title={<Space><TeamOutlined />{t('readUsers')} - {readUsersModal?.title}</Space>}
        open={!!readUsersModal}
        onCancel={() => setReadUsersModal(null)}
        footer={<Button onClick={() => setReadUsersModal(null)}>{t('close')}</Button>}
        width={480}
      >
        <div style={{ marginBottom: 12, color: 'var(--text-secondary)' }}>
          {t('readCount')}: {readUsers.length}
        </div>
        {readUsersLoading ? (
          <div style={{ textAlign: 'center', padding: 20 }}>{t('loading')}</div>
        ) : readUsers.length === 0 ? (
          <Empty description={t('noReadUsers')} />
        ) : (
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            {readUsers.map((u) => (
              <div key={u.username} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-color)' }}>
                <Text>{u.name || u.username}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{u.read_at ? new Date(u.read_at).toLocaleString('zh-CN') : ''}</Text>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* ── AI 生成公告弹窗 ── */}
      <Modal maskClosable={false}
        title={t('anDraftTitle')}
        open={aiModal}
        onCancel={() => setAiModal(false)}
        onOk={handleAiGenerate}
        confirmLoading={aiLoading}
        okText={t('generateAnnouncement')} cancelText={t('cancel')}
      >
        <Form form={aiForm} layout="vertical">
          <Form.Item name="topic" label={t('anTopic')} rules={[{ required: true, message: t('anTopicReq') }]}>
            <Input placeholder={t('anTopicPh')} />
          </Form.Item>
          <Form.Item name="target_role" label={t('anScope')} initialValue="all">
            <Select>
              <Select.Option value="all">{t('anAllUsers')}</Select.Option>
              <Select.Option value="teacher">{t('anOnlyTeacher')}</Select.Option>
              <Select.Option value="student">{t('anOnlyStudent')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="priority" label={t('anPriority')} initialValue="normal">
            <Select>
              <Select.Option value="normal">{t('anPNormal')}</Select.Option>
              <Select.Option value="important">{t('anPImportant')}</Select.Option>
              <Select.Option value="urgent">{t('anPUrgent')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="target_grade" label={t('anGradeLbl')}>
            <Input placeholder={t('anGradePh')} />
          </Form.Item>
          <Form.Item name="target_class" label={t('anClassLbl')}>
            <Input placeholder={t('anClassPh')} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 发布公告弹窗 ── */}
      <Modal maskClosable={false}
        title={t('addAnnouncement')}
        open={createModal}
        onCancel={() => { setCreateModal(false); setAnnounceScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' }) }}
        onOk={handleCreate}
        confirmLoading={submitting}
        okText={t('publish')} cancelText={t('cancel')}
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label={t('announcementTitle')} rules={[{ required: true, message: t('anTitleReq') }]}>
            <Input placeholder={t('announcementTitle')} maxLength={100} />
          </Form.Item>
          <Form.Item name="content" label={t('announcementContent')} rules={[{ required: true, message: t('anContentReq') }]}>
            <TextArea rows={6} placeholder={t('announcementContent')} />
          </Form.Item>
          <Form.Item
            name="target_role"
            label={t('anVisRole')}
            initialValue={isAdminOrTeacher && user?.role === 'teacher' ? 'student' : 'all'}
            extra={user?.role === 'teacher' ? t('anExtraTeacher') : t('anExtraAdmin')}
          >
            <Select>
              <Select.Option value="all">{t('anEveryone')}</Select.Option>
              <Select.Option value="teacher">{t('anOnlyTeacher')}</Select.Option>
              <Select.Option value="student">{t('anOnlyStudent')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label={t('anGradeRange')}>
            <ActivityScopeSelector value={announceScope} onChange={setAnnounceScope} />
          </Form.Item>
          <Space style={{ width: '100%' }} size={16}>
            <Form.Item name="priority" label={t('anPriority')} initialValue="normal">
              <Select style={{ width: 140 }}>
                <Select.Option value="normal">{t('anPNormal')}</Select.Option>
                <Select.Option value="important">{t('anPImportant')}</Select.Option>
                <Select.Option value="urgent">{t('anPUrgent')}</Select.Option>
                <Select.Option value="low">{t('anPLow')}</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item name="is_pinned" label={t('pinned')} valuePropName="checked" initialValue={false}>
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
      {/* ── 编辑公告弹窗 ── */}
      <Modal maskClosable={false}
        title={t('editAnnouncement')}
        open={!!editModal}
        onCancel={() => setEditModal(null)}
        onOk={handleEdit}
        confirmLoading={submitting}
        okText={t('save')} cancelText={t('cancel')}
        width={640}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="title" label={t('announcementTitle')} rules={[{ required: true, message: t('anTitleReq') }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="content" label={t('announcementContent')} rules={[{ required: true, message: t('anContentReq') }]}>
            <TextArea rows={6} />
          </Form.Item>
          <Form.Item name="priority" label={t('anPriority')}>
            <Select>
              <Select.Option value="normal">{t('anPNormal')}</Select.Option>
              <Select.Option value="important">{t('anPImportant')}</Select.Option>
              <Select.Option value="urgent">{t('anPUrgent')}</Select.Option>
              <Select.Option value="low">{t('anPLow')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default AnnouncementsPage
