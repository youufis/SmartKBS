import React, { useState, useEffect } from 'react'
import {
  Card, List, Typography, Button, Space, Modal, Form, Input,
  Select, message, Empty, Spin, Tag, Switch, Popconfirm,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, BellOutlined, PushpinOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import * as notificationsApi from '../api/notifications'
import type { AnnouncementItem } from '../api/notifications'
import { useAuthStore } from '../stores/authStore'

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
  const [createModal, setCreateModal] = useState(false)
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  const fetchAnnouncements = async () => {
    setLoading(true)
    try {
      const data = await notificationsApi.getAnnouncements(1, 50)
      setAnnouncements(data.announcements || [])
    } catch {
      message.error('加载公告失败')
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchAnnouncements()
  }, [])

  const handleCreate = async () => {
    try {
      const values = await form.validateFields()
      setSubmitting(true)
      await notificationsApi.createAnnouncement(values)
      message.success('公告发布成功')
      setCreateModal(false)
      form.resetFields()
      fetchAnnouncements()
    } catch (err: any) {
      if (err?.errorFields) return // validation error
      message.error('发布失败')
    }
    setSubmitting(false)
  }

  const handleDelete = async (id: number) => {
    try {
      await notificationsApi.deleteAnnouncement(id)
      message.success('公告已删除')
      fetchAnnouncements()
    } catch {
      message.error('删除失败')
    }
  }

  return (
    <div>
      <Card
        title={<Space><BellOutlined />系统公告</Space>}
        extra={
          <Space>
            {isAdminOrTeacher && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModal(true)}>
                发布公告
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={fetchAnnouncements}>刷新</Button>
          </Space>
        }
      >
        <Spin spinning={loading}>
          {announcements.length === 0 ? (
            <Empty description="暂无公告" />
          ) : (
            <List
              dataSource={announcements}
              renderItem={(item) => (
                <Card
                  size="small"
                  style={{
                    marginBottom: 12,
                    borderLeft: `4px solid ${
                      item.priority === 'urgent' ? '#ff4d4f' :
                      item.priority === 'important' ? '#fa8c16' :
                      item.priority === 'normal' ? '#1677ff' : '#d9d9d9'
                    }`,
                  }}
                  extra={
                    isAdminOrTeacher && (
                      <Popconfirm title="确定删除此公告？" onConfirm={() => handleDelete(item.id)}>
                        <Button type="text" danger icon={<DeleteOutlined />} size="small" />
                      </Popconfirm>
                    )
                  }
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <Space>
                        {item.is_pinned && <PushpinOutlined style={{ color: '#fa8c16' }} />}
                        <Text strong style={{ fontSize: 15 }}>{item.title}</Text>
                        <Tag color={PRIORITY_COLORS[item.priority] || 'default'}>
                          {PRIORITY_LABELS[item.priority] || item.priority}
                        </Tag>
                      </Space>
                      <Paragraph
                        style={{ marginTop: 8, marginBottom: 4, whiteSpace: 'pre-wrap' }}
                        type="secondary"
                      >
                        {item.content}
                      </Paragraph>
                      <Space size={12}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          发布者：{item.creator_username}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : ''}
                        </Text>
                        {item.target_role !== 'all' && (
                          <Tag>{item.target_role === 'teacher' ? '教师' : item.target_role === 'student' ? '学生' : item.target_role}</Tag>
                        )}
                        {item.target_grade && <Tag>{item.target_grade}</Tag>}
                        {item.target_class && <Tag>{item.target_class}班</Tag>}
                      </Space>
                    </div>
                  </div>
                </Card>
              )}
            />
          )}
        </Spin>
      </Card>

      {/* ── 发布公告弹窗 ── */}
      <Modal
        title="发布公告"
        open={createModal}
        onCancel={() => setCreateModal(false)}
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
          <Form.Item name="target_role" label="可见范围" initialValue="all">
            <Select>
              <Select.Option value="all">所有人</Select.Option>
              <Select.Option value="teacher">仅教师</Select.Option>
              <Select.Option value="student">仅学生</Select.Option>
            </Select>
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
    </div>
  )
}

export default AnnouncementsPage
