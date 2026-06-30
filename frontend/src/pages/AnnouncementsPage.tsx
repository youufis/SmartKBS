import React, { useState, useEffect } from 'react'
import {
  Card, Table, Typography, Button, Space, Modal, Form, Input,
  Select, message, Empty, Spin, Tag, Switch, Popconfirm,
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

const { Text, Paragraph } = Typography
const { TextArea } = Input

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'red',
  important: 'orange',
  normal: 'blue',
  low: 'default',
}

const PRIORITY_LABELS: Record<string, string> = {
  urgent: '紧急',
  important: '重要',
  normal: '普通',
  low: '低优先级',
}

const AnnouncementsPage: React.FC = () => {
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
      message.error('加载公告失败')
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
          message.success('AI 已生成公告内容，请确认后发布')
          setAiModal(false)
          aiForm.resetFields()
          setCreateModal(true)
        } else {
          message.error(result?.content || 'AI 生成失败')
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
        message.success('AI 已生成公告内容，请确认后发布')
        setAiModal(false)
        aiForm.resetFields()
        setCreateModal(true)
      } else {
        message.error(data.content || 'AI 生成失败')
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return
      message.error('生成失败')
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
      message.success('公告发布成功')
      setCreateModal(false)
      form.resetFields()
      setAnnounceScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
      fetchAnnouncements(1, pageSize)
      setPage(1)
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return
      message.error('发布失败')
    }
    setSubmitting(false)
  }
  const handleEdit = async () => {
    if (!editModal) return
    try {
      const values = await editForm.validateFields()
      setSubmitting(true)
      await notificationsApi.updateAnnouncement(editModal.id, values)
      message.success('公告已更新')
      setEditModal(null)
      fetchAnnouncements(page, pageSize)
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return
      message.error('更新失败')
    }
    setSubmitting(false)
  }
  const handleDelete = async (id: number) => {
    try {
      await notificationsApi.deleteAnnouncement(id)
      message.success('公告已删除')
      fetchAnnouncements(page, pageSize)
    } catch {
      message.error('删除失败')
    }
  }

  const handleTableChange = (pagination: any) => {
    setPage(pagination.current)
    setPageSize(pagination.pageSize)
    fetchAnnouncements(pagination.current, pagination.pageSize)
  }

  const columns = [
    {
      title: '置顶',
      dataIndex: 'is_pinned',
      key: 'is_pinned',
      width: 50,
      render: (pinned: boolean) => pinned ? <PushpinOutlined style={{ color: '#fa8c16' }} /> : null,
    },
    {
      title: '公告标题',
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
      title: '发布者',
      dataIndex: 'creator_name',
      key: 'creator_name',
      width: 100,
      render: (name: string) => name || '-',
    },
    {
      title: '范围',
      key: 'target',
      width: 120,
      render: (_: any, record: AnnouncementItem) => (
        <Space size={4}>
          {record.target_role !== 'all' && (
            <Tag>{record.target_role === 'teacher' ? '教师' : record.target_role === 'student' ? '学生' : record.target_role}</Tag>
          )}
          {record.target_grade && <Tag>{record.target_grade}</Tag>}
          {record.target_class && <Tag>{record.target_class}班</Tag>}
        </Space>
      ),
    },
    {
      title: '发布时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (t: string) => t ? new Date(t).toLocaleString('zh-CN') : '-',
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_: any, record: AnnouncementItem) => (
        <Space>
          <Button type="text" icon={<EyeOutlined />} size="small" onClick={() => setDetailModal(record)} />
          {isAdminOrTeacher && (
            <>
              <Button type="text" icon={<EditOutlined />} size="small"
                onClick={() => { setEditModal(record); editForm.setFieldsValue(record) }} />
              <Popconfirm title="确定删除此公告？" onConfirm={() => handleDelete(record.id)}>
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
        title={<Space><BellOutlined />系统公告</Space>}
        extra={
          <Space>
            {isAdminOrTeacher && (
              <>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModal(true)}>
                  发布公告
                </Button>
                <Button icon={<BulbOutlined />} onClick={() => { setAiModal(true); aiForm.resetFields(); }}>
                  AI 起草
                </Button>
              </>
            )}
            <Button icon={<ReloadOutlined />} onClick={() => fetchAnnouncements(page, pageSize)}>刷新</Button>
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
            showTotal: (t) => `共 ${t} 条公告`,
            pageSizeOptions: ['10', '20', '50'],
          }}
          onChange={handleTableChange}
          locale={{ emptyText: <Empty description="暂无公告" /> }}
        />
      </Card>

      {/* ── 查看公告详情弹窗 ── */}
      <Modal
        title={<Space><BellOutlined />{detailModal?.title}</Space>}
        open={!!detailModal}
        onCancel={() => setDetailModal(null)}
        footer={<Button onClick={() => setDetailModal(null)}>关闭</Button>}
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
                <Tag>{detailModal.target_role === 'teacher' ? '教师' : detailModal.target_role === 'student' ? '学生' : detailModal.target_role}</Tag>
              )}
              {detailModal.target_grade && <Tag>{detailModal.target_grade}</Tag>}
              {detailModal.target_class && <Tag>{detailModal.target_class}班</Tag>}
            </Space>
            <div style={{ color: '#999', fontSize: 12, marginBottom: 16 }}>
              发布者：{detailModal.creator_name || detailModal.creator_username}
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
        title="🤖 AI 起草公告"
        open={aiModal}
        onCancel={() => setAiModal(false)}
        onOk={handleAiGenerate}
        confirmLoading={aiLoading}
        okText="生成公告"
      >
        <Form form={aiForm} layout="vertical">
          <Form.Item name="topic" label="公告主题" rules={[{ required: true, message: '请输入公告主题' }]}>
            <Input placeholder="如：期末考试安排通知" />
          </Form.Item>
          <Form.Item name="target_role" label="发布范围" initialValue="all">
            <Select>
              <Select.Option value="all">全体用户</Select.Option>
              <Select.Option value="teacher">仅教师</Select.Option>
              <Select.Option value="student">仅学生</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="priority" label="优先级" initialValue="normal">
            <Select>
              <Select.Option value="normal">普通</Select.Option>
              <Select.Option value="important">重要</Select.Option>
              <Select.Option value="urgent">紧急</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="target_grade" label="适用年级（留空不限）">
            <Input placeholder="如：高一" />
          </Form.Item>
          <Form.Item name="target_class" label="适用班级（留空不限）">
            <Input placeholder="如：1,2,3" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 发布公告弹窗 ── */}
      <Modal
        title="发布公告"
        open={createModal}
        onCancel={() => { setCreateModal(false); setAnnounceScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' }) }}
        onOk={handleCreate}
        confirmLoading={submitting}
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="公告标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="请输入公告标题" maxLength={100} />
          </Form.Item>
          <Form.Item name="content" label="公告内容" rules={[{ required: true, message: '请输入内容' }]}>
            <TextArea rows={6} placeholder="请输入公告内容（支持 Markdown 格式）" />
          </Form.Item>
          <Form.Item
            name="target_role"
            label="可见角色"
            initialValue={isAdminOrTeacher && user?.role === 'teacher' ? 'student' : 'all'}
            extra={user?.role === 'teacher' ? '教师公告默认发送给所教班级学生，管理员始终可见' : '管理员公告默认发送给所有人'}
          >
            <Select>
              <Select.Option value="all">所有人</Select.Option>
              <Select.Option value="teacher">仅教师</Select.Option>
              <Select.Option value="student">仅学生</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label="年级/班级范围">
            <ActivityScopeSelector value={announceScope} onChange={setAnnounceScope} />
          </Form.Item>
          <Space style={{ width: '100%' }} size={16}>
            <Form.Item name="priority" label="优先级" initialValue="normal">
              <Select style={{ width: 140 }}>
                <Select.Option value="normal">普通</Select.Option>
                <Select.Option value="important">重要</Select.Option>
                <Select.Option value="urgent">紧急</Select.Option>
                <Select.Option value="low">低</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item name="is_pinned" label="置顶" valuePropName="checked" initialValue={false}>
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
      {/* ── 编辑公告弹窗 ── */}
      <Modal
        title="编辑公告"
        open={!!editModal}
        onCancel={() => setEditModal(null)}
        onOk={handleEdit}
        confirmLoading={submitting}
        width={640}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="title" label="公告标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="content" label="公告内容" rules={[{ required: true, message: '请输入内容' }]}>
            <TextArea rows={6} />
          </Form.Item>
          <Form.Item name="priority" label="优先级">
            <Select>
              <Select.Option value="normal">普通</Select.Option>
              <Select.Option value="important">重要</Select.Option>
              <Select.Option value="urgent">紧急</Select.Option>
              <Select.Option value="low">低</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default AnnouncementsPage
