import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Table, Button, message, Modal, Input, Tag, Space,
  Typography, Spin, Popconfirm, Popover, Drawer,
} from 'antd'
import {
  PlusOutlined, SendOutlined, ReloadOutlined, DeleteOutlined,
  CheckCircleOutlined, EyeOutlined, UndoOutlined, UserOutlined,
} from '@ant-design/icons'
import * as tasksApi from '../api/tasks'
import { useAuthStore } from '../stores/authStore'
import type { TaskInfo } from '../types'
import { useChatStore, setTaskFilename } from '../stores/chatStore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const TaskPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const messages = useChatStore((s) => s.messages)
  const isAdminOrTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const username = user?.username || ''
  const isStudent = user?.role === 'student'

  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [createModal, setCreateModal] = useState(false)
  const [taskName, setTaskName] = useState('')
  const [taskDesc, setTaskDesc] = useState('')
  const [submitModal, setSubmitModal] = useState(false)
  const [selectedTask, setSelectedTask] = useState<TaskInfo | null>(null)

  // 提交详情
  const [submissionsDrawer, setSubmissionsDrawer] = useState(false)
  const [submissionsData, setSubmissionsData] = useState<{
    task_name: string; task_status: string; submissions: tasksApi.TaskSubmission[]; count: number
  }>({ task_name: '', task_status: '', submissions: [], count: 0 })
  const [submissionsLoading, setSubmissionsLoading] = useState(false)
  const [viewTask, setViewTask] = useState<TaskInfo | null>(null)

  // 查看学生提交内容
  const [contentDrawer, setContentDrawer] = useState(false)
  const [studentContent, setStudentContent] = useState('')
  const [contentLoading, setContentLoading] = useState(false)

  const loadTasks = useCallback(async () => {
    setLoading(true)
    try {
      const { tasks: list } = await tasksApi.getActiveTasks()
      setTasks(list)
    } catch {
      message.error('加载任务列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadTasks() }, [loadTasks])

  // ── 创建任务 ──
  const handleCreate = async () => {
    if (!taskName.trim()) { message.warning('请输入任务名称'); return }
    try {
      const res = await tasksApi.createTask(taskName.trim(), taskDesc.trim())
      message.success(res.message)
      setCreateModal(false)
      setTaskName('')
      setTaskDesc('')
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '创建失败')
    }
  }

  // ── 结束任务 ──
  const handleEnd = async (taskId: string) => {
    try {
      const res = await tasksApi.endTask(taskId)
      message.success(res.message)
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '结束失败')
    }
  }

  // ── 删除任务 ──
  const handleDelete = async (taskId: string) => {
    try {
      const res = await tasksApi.deleteTask(taskId)
      message.success(res.message)
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  // ── 提交任务 ──
  const handleSubmit = async () => {
    if (!selectedTask) return
    const content = messages.map(m =>
      `**${m.role === 'user' ? '用户' : '助手'}**: ${m.content}`
    ).join('\n\n---\n\n')
    if (!content.trim()) {
      message.warning('当前对话为空，请先进行对话')
      return
    }
    try {
      const res = await tasksApi.submitTask(selectedTask.id, content)
      message.success(res.message)
      setTaskFilename(selectedTask.name)
      setSubmitModal(false)
      setSelectedTask(null)
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '提交失败')
    }
  }

  // ── 查看提交详情 ──
  const handleViewSubmissions = async (task: TaskInfo) => {
    setViewTask(task)
    setSubmissionsDrawer(true)
    setSubmissionsLoading(true)
    try {
      const data = await tasksApi.getTaskSubmissions(task.id)
      setSubmissionsData({
        task_name: data.task_name,
        task_status: data.task_status,
        submissions: data.submissions,
        count: data.submission_count,
      })
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '加载提交详情失败')
      setSubmissionsData({ task_name: '', task_status: '', submissions: [], count: 0 })
    } finally {
      setSubmissionsLoading(false)
    }
  }

  // ── 查看单个学生提交内容 ──
  const handleViewContent = async (studentUsername: string) => {
    if (!viewTask) return
    setContentLoading(true)
    setContentDrawer(true)
    setStudentContent('加载中...')
    try {
      const data = await tasksApi.getTaskSubmissions(viewTask.id, studentUsername)
      setStudentContent(data.student_content || '（无提交内容）')
    } catch (err: any) {
      setStudentContent(`❌ 加载失败: ${err?.response?.data?.detail || err.message}`)
    } finally {
      setContentLoading(false)
    }
  }

  // ── 回退学生提交 ──
  const handleRevert = async (taskId: string, studentUsername: string) => {
    try {
      const msg = await tasksApi.revertSubmission(taskId, studentUsername)
      message.success(msg)
      // 刷新提交列表
      if (viewTask) handleViewSubmissions(viewTask)
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '回退失败')
    }
  }

  // ── 列定义 ──
  const studentStatusColumn = {
    title: '我的状态', key: 'myStatus', width: 100,
    render: (_: any, record: TaskInfo) => {
      const submitted = record.submissions?.includes(username)
      return submitted
        ? <Tag color="success">✅ 已提交</Tag>
        : <Tag color="default">⏳ 未提交</Tag>
    },
  }

  const columns = [
    { title: '任务名称', dataIndex: 'name', key: 'name', width: 180 },
    {
      title: '任务说明', dataIndex: 'description', key: 'description', width: 200,
      render: (d: string) => d ? (
        <Typography.Paragraph ellipsis={{ rows: 1 }} style={{ margin: 0, fontSize: 13, color: '#666' }}>
          {d}
        </Typography.Paragraph>
      ) : <Typography.Text type="secondary" style={{ fontSize: 12 }}>--</Typography.Text>,
    },
    { title: '创建者', dataIndex: 'creator', key: 'creator', width: 80 },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 70,
      render: (s: string) => (
        <Tag color={s === 'active' ? 'green' : 'default'}>
          {s === 'active' ? '进行中' : '已结束'}
        </Tag>
      ),
    },
    { title: '创建时间', dataIndex: 'created_time', key: 'created_time', width: 160 },
    ...(isStudent
      ? [studentStatusColumn]
      : [{
          title: '已提交', key: 'submissions', width: 100,
          render: (_: any, record: TaskInfo) => {
            const names = (record as any).submissions_names || []
            const count = record.submissions?.length || 0
            if (count === 0) return <Typography.Text type="secondary">0 人</Typography.Text>
            return (
              <Popover
                title="已提交学生"
                content={
                  <div style={{ maxHeight: 200, overflow: 'auto' }}>
                    {names.map((n: string, i: number) => (
                      <div key={i} style={{ padding: '2px 0' }}>{n}</div>
                    ))}
                  </div>
                }
                trigger="click"
              >
                <Button type="link" size="small">{count} 人 👤</Button>
              </Popover>
            )
          },
        }]
    ),
    {
      title: '操作', key: 'action', width: 280,
      render: (_: any, record: TaskInfo) => (
        <Space size="small" wrap>
          {isStudent && record.status === 'active' && (
            <Button size="small" type="primary" icon={<SendOutlined />}
              onClick={() => { setSelectedTask(record); setSubmitModal(true) }}
            >提交</Button>
          )}
          {isAdminOrTeacher && (
            <Button size="small" icon={<EyeOutlined />}
              onClick={() => handleViewSubmissions(record)}
            >详情</Button>
          )}
          {isAdminOrTeacher && record.status === 'active' && (
            <Popconfirm
              title={`确认结束任务「${record.name}」？`}
              description="结束后学生将无法再提交"
              onConfirm={() => handleEnd(record.id)}
              okText="确认结束" cancelText="取消"
            >
              <Button size="small" icon={<CheckCircleOutlined />}>结束</Button>
            </Popconfirm>
          )}
          {isAdminOrTeacher && (
            <Popconfirm
              title={`确认删除任务「${record.name}」？`}
              onConfirm={() => handleDelete(record.id)}
              okText="确认删除" cancelText="取消"
            >
              <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>📋 任务管理</Typography.Title>
          {isAdminOrTeacher && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModal(true)}>
              创建任务
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={loadTasks}>刷新</Button>
        </Space>

        <Spin spinning={loading}>
          <Table
            dataSource={tasks}
            columns={columns}
            rowKey="id"
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 个任务`, pageSizeOptions: ['10', '20', '50'] }}
            size="small"
            locale={{ emptyText: '暂无活动任务' }}
          />
        </Spin>
      </Card>

      {/* 创建任务弹窗 */}
      <Modal
        title="创建新任务"
        open={createModal}
        onOk={handleCreate}
        onCancel={() => { setCreateModal(false); setTaskName('') }}
        okText="创建" cancelText="取消"
      >
        <Input
          placeholder="输入任务名称"
          value={taskName}
          onChange={(e) => setTaskName(e.target.value)}
        />
        <Input.TextArea
          placeholder="任务说明（可选，学生可见）"
          value={taskDesc}
          onChange={(e) => setTaskDesc(e.target.value)}
          rows={3}
          style={{ marginTop: 12 }}
        />
      </Modal>

      {/* 提交任务确认弹窗 */}
      <Modal
        title={`提交到任务: ${selectedTask?.name || ''}`}
        open={submitModal}
        onOk={handleSubmit}
        onCancel={() => { setSubmitModal(false); setSelectedTask(null) }}
        okText="确认提交" cancelText="取消"
      >
        <Space direction="vertical">
          <Typography.Text>
            将当前 AI 对话内容提交到任务 <strong>{selectedTask?.name}</strong>？
          </Typography.Text>
          {selectedTask?.description && (
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              📋 任务说明：{selectedTask.description}
            </Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {messages.length} 条对话记录
          </Typography.Text>
        </Space>
      </Modal>

      {/* 提交详情侧栏 */}
      <Drawer
        title={`📋 ${submissionsData.task_name || '加载中...'}`}
        placement="right"
        width={480}
        open={submissionsDrawer}
        onClose={() => { setSubmissionsDrawer(false); setContentDrawer(false) }}
      >
        <Spin spinning={submissionsLoading}>
          <Tag color={submissionsData.task_status === 'active' ? 'green' : 'default'} style={{ marginBottom: 16 }}>
            {submissionsData.task_status === 'active' ? '进行中' : '已结束'}
          </Tag>
          {submissionsData.submissions.length === 0 ? (
            <Typography.Text type="secondary">暂无学生提交</Typography.Text>
          ) : (
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Typography.Text strong>已提交学生（{submissionsData.count} 人）：</Typography.Text>
              {submissionsData.submissions.map((s) => (
                <Card key={s.username} size="small" style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Space>
                      <UserOutlined />
                      <Typography.Text strong>{s.name}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>({s.username})</Typography.Text>
                    </Space>
                    <Space>
                      <Button size="small" icon={<EyeOutlined />}
                        onClick={() => handleViewContent(s.username)}
                      >查看</Button>
                      <Popconfirm
                        title={`回退 ${s.name} 的提交？`}
                        description="回退后该学生可重新提交"
                        onConfirm={() => handleRevert(viewTask?.id || '', s.username)}
                        okText="确认回退" cancelText="取消"
                      >
                        <Button size="small" icon={<UndoOutlined />}>回退</Button>
                      </Popconfirm>
                    </Space>
                  </Space>
                </Card>
              ))}
            </Space>
          )}
        </Spin>

        {/* 学生提交内容抽屉 */}
        <Drawer
          title="提交内容"
          placement="right"
          width={520}
          open={contentDrawer}
          onClose={() => setContentDrawer(false)}
          getContainer={false}
          style={{ position: 'absolute' }}
        >
          <Spin spinning={contentLoading}>
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {studentContent || '（无内容）'}
              </ReactMarkdown>
            </div>
          </Spin>
        </Drawer>
      </Drawer>

      <style>{`
        .markdown-content p { margin-bottom: 4px; }
        .markdown-content pre { background: #f5f5f5; padding: 8px; border-radius: 4px; overflow-x: auto; }
        .markdown-content code { background: #f5f5f5; padding: 2px 4px; border-radius: 3px; font-size: 0.9em; }
      `}</style>
    </div>
  )
}

export default TaskPage
