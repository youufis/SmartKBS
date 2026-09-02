import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Table, Typography, Button, Space, Modal, Form, Input,
  Select, message, Empty, Tag, Switch, Popconfirm,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, EditOutlined, BellOutlined, PushpinOutlined,
  ReloadOutlined, BulbOutlined, EyeOutlined,
} from '@ant-design/icons'
import * as notificationsApi from '../api/notifications'
import type { AnnouncementItem } from '../api/notifications'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'

const { Text } = Typography
const { TextArea } = Input

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'red',
  important: 'orange',
  normal: 'blue',
  low: 'default',
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

  const fetchAnnouncements = async (p = page, ps = pageSize) => {
    setLoading(true)
    try {
      const data = await notificationsApi.getAnnouncements(p, ps)
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
      const { data } = await apiClient.post('/api/notifications/announcements/ai-generate', values)
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

  const handleTableChange = (pagination: any) => {
    setPage(pagination.current)
    setPageSize(pagination.pageSize)
    fetchAnnouncements(pagination.current, pagination.pageSize)
  }

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
      ellipsis: true,
      render: (title: string, record: AnnouncementItem) => (
        <Space>
          <Text strong style={{ cursor: 'pointer' }} onClick={() => setDetailModal(record)}>{title}</Text>
          <Tag color={PRIORITY_COLORS[record.priority] || 'default'}>
            {PRIORITY_LABELS[record.priority] || record.priority}
          </Tag>
        </Space>
      ),
    },
    {
      title: t('publisher'),
      dataIndex: 'creator_name',
      key: 'creator_name',
      width: 100,
      render: (name: string) => name || '-',
    },
    {
      title: t('scope'),
      key: 'target',
      width: 120,
      render: (_: any, record: AnnouncementItem) => (
        <Space size={4}>
          {record.target_role !== 'all' && (
            <Tag>{record.target_role === 'teacher' ? t('anRoleTeacher') : record.target_role === 'student' ? t('anRoleStudent') : record.target_role}</Tag>
          )}
          {record.target_grade && <Tag>{record.target_grade}</Tag>}
          {record.target_class && <Tag>{t('anClassSuffix', { cls: record.target_class })}</Tag>}
        </Space>
      ),
    },
    {
      title: t('publishTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (t: string) => t ? new Date(t).toLocaleString('zh-CN') : '-',
    },
    {
      title: t('actions'),
      key: 'actions',
      width: 120,
      render: (_: any, record: AnnouncementItem) => (
        <Space>
          <Button type="text" icon={<EyeOutlined />} size="small" onClick={() => setDetailModal(record)} />
          {isAdminOrTeacher && (
            <>
              <Button type="text" icon={<EditOutlined />} size="small"
                onClick={() => { setEditModal(record); editForm.setFieldsValue(record) }} />
              <Popconfirm title={t('confirmDeleteAnnouncement')} onConfirm={() => handleDelete(record.id)}>
                <Button type="text" danger icon={<DeleteOutlined />} size="small" />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Card
        title={<Space><BellOutlined />{t('announcements')}</Space>}
        extra={
          <Space>
            {isAdminOrTeacher && (
              <>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModal(true)}>
                  {t('addAnnouncement')}
                </Button>
                <Button icon={<BulbOutlined />} onClick={() => { setAiModal(true); aiForm.resetFields(); }}>
                  {t('aiDraft')}
                </Button>
              </>
            )}
            <Button icon={<ReloadOutlined />} onClick={() => fetchAnnouncements(page, pageSize)}>{t('refresh')}</Button>
          </Space>
        }
      >
        <Table
          dataSource={announcements}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="small"
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
              {detailModal.target_grade && <Tag>{detailModal.target_grade}</Tag>}
              {detailModal.target_class && <Tag>{t('anClassSuffix', { cls: detailModal.target_class })}</Tag>}
            </Space>
            <div style={{ color: '#999', fontSize: 12, marginBottom: 16 }}>
              {t('anPublisher')}{detailModal.creator_name || detailModal.creator_username}
              &nbsp;|&nbsp;
              {detailModal.created_at ? new Date(detailModal.created_at).toLocaleString('zh-CN') : ''}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>
              {detailModal.content}
            </div>
          </div>
        )}
      </Modal>

      {/* ── AI 生成公告弹窗 ── */}
      <Modal
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
      <Modal
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
      <Modal
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
