import React, { useState, useEffect } from 'react'
import {
  Card, Tabs, Button, Space, Typography, Tag, Modal,
  Form, Input, Select, InputNumber, message, Empty, Spin,
  Tooltip, Popconfirm,
} from 'antd'
import {
  TeamOutlined, PlusOutlined, PlayCircleOutlined,
  StopOutlined, MessageOutlined, UserOutlined,
  FieldTimeOutlined, RobotOutlined, BulbOutlined,
  ReloadOutlined, DeleteOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography
const { TextArea } = Input

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending: { label: '待开始', color: 'default' },
  active: { label: '进行中', color: 'green' },
  ended: { label: '已结束', color: 'red' },
}

const AI_ROLE_MAP: Record<string, string> = {
  observer: '旁观者',
  guide: '引导者',
  proactive: '主动参与',
  judge: '辩论裁判',
}

const DiscussionPage: React.FC = () => {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  const [discussions, setDiscussions] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [aiModal, setAiModal] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [detailModal, setDetailModal] = useState<any>(null)
  const [activeTab, setActiveTab] = useState('all')
  const [createForm] = Form.useForm()
  const [aiForm] = Form.useForm()

  // 加载讨论列表
  const loadDiscussions = async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/discussions')
      setDiscussions(Array.isArray(data) ? data : [])
    } catch {
      message.error('加载讨论列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadDiscussions()
  }, [])

  // 创建讨论
  const handleCreate = async () => {
    try {
      await createForm.validateFields()
      setCreateLoading(true)
      const values = createForm.getFieldsValue()
      await apiClient.post('/api/interaction/discussions', values)
      message.success('讨论创建成功')
      setCreateOpen(false)
      createForm.resetFields()
      loadDiscussions()
    } catch (err: any) {
      if (err?.errorFields) return
      message.error('创建失败: ' + (err?.response?.data?.detail || err?.message))
    } finally {
      setCreateLoading(false)
    }
  }

  // AI 生成讨论方案
  const handleAiGenerate = async () => {
    try {
      await aiForm.validateFields()
      setAiLoading(true)
      const values = aiForm.getFieldsValue()
      const { data } = await apiClient.post('/api/interaction/discussions/ai-generate', values)
      if (data.status === 'ok' && data.data) {
        // 自动填充创建表单
        createForm.setFieldsValue(data.data)
        message.success('AI 已生成讨论方案，请确认后创建')
        setAiModal(false)
        setCreateOpen(true)
      } else {
        message.error(data.content || 'AI 生成失败')
      }
    } catch (err: any) {
      if (err?.errorFields) return
      message.error('生成失败: ' + (err?.response?.data?.detail || err?.message))
    } finally {
      setAiLoading(false)
    }
  }

  // 开始讨论
  const handleStart = async (id: number) => {
    try {
      const { data } = await apiClient.post(`/api/interaction/discussions/${id}/start`)
      message.success(data.message || '讨论已开始')
      loadDiscussions()
    } catch (err: any) {
      message.error('启动失败: ' + (err?.response?.data?.detail || err?.message))
    }
  }

  // 结束讨论
  const handleEnd = async (id: number) => {
    try {
      await apiClient.post(`/api/interaction/discussions/${id}/end`)
      message.success('讨论已结束')
      loadDiscussions()
    } catch (err: any) {
      message.error('操作失败: ' + (err?.response?.data?.detail || err?.message))
    }
  }

  // 重新开始讨论
  const handleRestart = async (id: number) => {
    try {
      await apiClient.post(`/api/interaction/discussions/${id}/restart`)
      message.success('讨论已重新开始')
      loadDiscussions()
    } catch (err: any) {
      message.error('操作失败: ' + (err?.response?.data?.detail || err?.message))
    }
  }

  // 删除讨论
  const handleDelete = async (id: number) => {
    try {
      await apiClient.delete(`/api/interaction/discussions/${id}`)
      message.success('讨论已删除')
      loadDiscussions()
    } catch (err: any) {
      message.error('删除失败: ' + (err?.response?.data?.detail || err?.message))
    }
  }

  // 加入讨论
  const handleJoin = async (id: number) => {
    try {
      await apiClient.post(`/api/interaction/discussions/${id}/join`)
      message.success('已加入讨论')
      loadDiscussions()
    } catch (err: any) {
      message.error('加入失败: ' + (err?.response?.data?.detail || err?.message))
    }
  }

  // 查看详情
  const handleDetail = async (id: number) => {
    try {
      const { data } = await apiClient.get(`/api/interaction/discussions/${id}`)
      setDetailModal(data)
    } catch {
      message.error('获取详情失败')
    }
  }

  // 进入聊天室（教师视角）
  const handleEnterGroup = (groupId: number, discussionId: number) => {
    navigate(`/discussion-room/${groupId}?discussion_id=${discussionId}`)
  }

  // 过滤列表
  const filtered = activeTab === 'all'
    ? discussions
    : discussions.filter(d => d.status === activeTab)

  // ── 创建讨论表单 ──
  const renderCreateForm = () => (
    <Form form={createForm} layout="vertical" style={{ maxWidth: 600 }}>
      <Form.Item name="title" label="讨论主题" rules={[{ required: true, message: '请输入讨论主题' }]}>
        <Input placeholder="如：人工智能的伦理困境" />
      </Form.Item>
      <Form.Item name="description" label="讨论说明">
        <TextArea rows={3} placeholder="描述讨论的目标和要点" />
      </Form.Item>
      <Form.Item name="subject" label="学科">
        <Select placeholder="选择学科（可选）" allowClear>
          <Select.Option value="信息技术">信息技术</Select.Option>
          <Select.Option value="通用技术">通用技术</Select.Option>
          <Select.Option value="人工智能通识">人工智能通识</Select.Option>
        </Select>
      </Form.Item>
      <Form.Item name="group_mode" label="分组方式" initialValue="auto">
        <Select>
          <Select.Option value="auto">自动分组（按每组人数）</Select.Option>
          <Select.Option value="random">随机分组（按组数）</Select.Option>
        </Select>
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.group_mode !== cur.group_mode}>
        {({ getFieldValue }) => {
          const mode = getFieldValue('group_mode')
          return mode === 'auto' ? (
            <Form.Item name="members_per_group" label="每组人数" initialValue={4}
              rules={[{ required: true, message: '请输入每组人数' }]}>
              <InputNumber min={2} max={10} style={{ width: '100%' }} />
            </Form.Item>
          ) : (
            <Form.Item name="group_count" label="小组数量" initialValue={4}
              rules={[{ required: true, message: '请输入小组数量' }]}>
              <InputNumber min={1} max={20} style={{ width: '100%' }} />
            </Form.Item>
          )
        }}
      </Form.Item>
      <Form.Item name="ai_role" label="AI 助教角色" initialValue="guide">
        <Select>
          <Select.Option value="observer">👀 旁观者（不主动发言）</Select.Option>
          <Select.Option value="guide">💡 引导者（适时引导讨论）</Select.Option>
          <Select.Option value="proactive">🗣️ 主动参与（提供观点）</Select.Option>
          <Select.Option value="judge">⚖️ 辩论裁判（分析论点）</Select.Option>
        </Select>
      </Form.Item>
      <Form.Item name="duration_minutes" label="讨论时长 (分钟)" initialValue={30}>
        <InputNumber min={5} max={120} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="grade" label="适用年级（留空则不限）">
        <Input placeholder="如：高一" />
      </Form.Item>
      <Form.Item name="classes" label="适用班级（留空则不限）">
        <Input placeholder="多个用逗号分隔，如：1,2,3" />
      </Form.Item>
      <Form.Item name="require_summary" label="提交要求" valuePropName="checked" initialValue={false}>
        <Select>
          <Select.Option value={false}>无需提交总结</Select.Option>
          <Select.Option value={true}>每组需提交总结</Select.Option>
        </Select>
      </Form.Item>
    </Form>
  )

  // ── 讨论卡片 ──
  const renderDiscussionCard = (disc: any) => {
    const statusInfo = STATUS_MAP[disc.status] || { label: '未知', color: 'default' }
    return (
      <Card
        key={disc.id}
        size="small"
        style={{ marginBottom: 12 }}
        actions={
          isTeacherOrAdmin
            ? [
                <Tooltip title="查看详情"><TeamOutlined onClick={() => handleDetail(disc.id)} /></Tooltip>,
                ...(disc.status === 'pending' ? [
                  <Tooltip title="开始讨论"><PlayCircleOutlined style={{ color: '#52c41a' }} onClick={() => handleStart(disc.id)} /></Tooltip>,
                ] : []),
                ...(disc.status === 'active' ? [
                  <Popconfirm title="确定结束讨论？" onConfirm={() => handleEnd(disc.id)}>
                    <Tooltip title="结束讨论"><StopOutlined style={{ color: '#ff4d4f' }} /></Tooltip>
                  </Popconfirm>,
                ] : []),
                ...(disc.status === 'ended' ? [
                  <Tooltip title="重新开始"><ReloadOutlined style={{ color: '#52c41a' }} onClick={() => handleRestart(disc.id)} /></Tooltip>,
                  <Popconfirm title="确定删除此讨论及其所有消息？" onConfirm={() => handleDelete(disc.id)}>
                    <Tooltip title="删除讨论"><DeleteOutlined style={{ color: '#ff4d4f' }} /></Tooltip>
                  </Popconfirm>,
                ] : []),
              ]
            : [
                ...(disc.has_joined && disc.status === 'active'
                  ? [<Tooltip title="进入小组"><TeamOutlined onClick={() => navigate(`/discussion-room/${disc.my_group.id}?discussion_id=${disc.id}`)} /></Tooltip>]
                  : disc.status === 'active' && !disc.has_joined
                  ? [<Tooltip title="加入讨论"><MessageOutlined onClick={() => handleJoin(disc.id)} /></Tooltip>]
                  : []),
              ]
        }
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <Space>
              <Text strong>{disc.title}</Text>
              <Tag color={statusInfo.color}>{statusInfo.label}</Tag>
              {disc.subject && <Tag>{disc.subject}</Tag>}
            </Space>
            {disc.description && (
              <div style={{ color: '#666', fontSize: 13, marginTop: 4 }}>{disc.description}</div>
            )}
          </div>
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 16, fontSize: 13, color: '#888' }}>
          <span><TeamOutlined /> {disc.total_members || 0} 人参与</span>
          <span><MessageOutlined /> {disc.total_messages || 0} 条消息</span>
          <span><RobotOutlined /> {AI_ROLE_MAP[disc.ai_role] || disc.ai_role}</span>
          {disc.duration_minutes > 0 && (
            <span><FieldTimeOutlined /> {disc.duration_minutes} 分钟</span>
          )}
        </div>
        {isStudent && disc.has_joined && disc.status === 'active' && disc.my_group && (
          <div style={{ marginTop: 4 }}>
            <Tag color="blue">你的小组: {disc.my_group.name || `第${disc.my_group.group_index}组`}</Tag>
          </div>
        )}
      </Card>
    )
  }

  return (
    <div>
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <TeamOutlined style={{ fontSize: 24, color: '#1677ff' }} />
          <Title level={4} style={{ margin: 0 }}>分组讨论</Title>
        </Space>

        {isTeacherOrAdmin && (
          <Space style={{ marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              创建讨论
            </Button>
            <Button icon={<BulbOutlined />} onClick={() => { setAiModal(true); aiForm.resetFields(); }}>
              AI 生成方案
            </Button>
          </Space>
        )}

        <Tabs activeKey={activeTab} onChange={setActiveTab} tabBarStyle={{ marginBottom: 16 }}>
          <Tabs.TabPane tab="全部" key="all" />
          <Tabs.TabPane tab="待开始" key="pending" />
          <Tabs.TabPane tab="进行中" key="active" />
          <Tabs.TabPane tab="已结束" key="ended" />
        </Tabs>

        <Spin spinning={loading}>
          {filtered.length === 0 ? (
            <Empty description="暂无讨论" />
          ) : (
            filtered.map(renderDiscussionCard)
          )}
        </Spin>
      </Card>

      {/* 创建讨论弹窗 */}
      <Modal
        title="创建讨论"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreate}
        confirmLoading={createLoading}
        width={640}
        okText="创建"
      >
        {renderCreateForm()}
      </Modal>

      {/* 讨论详情弹窗（教师） */}
      <Modal
        title={detailModal?.title || '讨论详情'}
        open={!!detailModal}
        onCancel={() => setDetailModal(null)}
        footer={null}
        width={700}
      >
        {detailModal && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Tag color={STATUS_MAP[detailModal.status]?.color}>
                {STATUS_MAP[detailModal.status]?.label}
              </Tag>
              <Tag>{detailModal.subject || '未指定学科'}</Tag>
              <span style={{ marginLeft: 12, color: '#888' }}>
                <RobotOutlined /> {AI_ROLE_MAP[detailModal.ai_role] || detailModal.ai_role}
              </span>
            </div>

            {detailModal.description && (
              <div style={{ marginBottom: 16, color: '#666' }}>{detailModal.description}</div>
            )}

            {isTeacherOrAdmin && (
              <Button
                icon={<TeamOutlined />}
                style={{ marginBottom: 16 }}
                onClick={() => navigate(`/discussion-monitor/${detailModal.id}`)}
              >
                监控面板
              </Button>
            )}

            <Title level={5}>小组列表</Title>
            {detailModal.groups?.map((g: any) => (
              <Card
                key={g.id}
                size="small"
                title={`${g.name || `第${g.group_index}组`}`}
                style={{ marginBottom: 8 }}
                extra={
                  <Space>
                    <Text type="secondary">{g.members?.length || 0} 人</Text>
                    {detailModal.status === 'active' && (
                      <Button size="small" onClick={() => handleEnterGroup(g.id, detailModal.id)}>
                        进入
                      </Button>
                    )}
                  </Space>
                }
              >
                <Space wrap>
                  {g.members?.length > 0 ? g.members.map((m: any) => (
                    <Tag key={m.username} icon={<UserOutlined />}>{m.username}</Tag>
                  )) : <Text type="secondary">暂无成员</Text>}
                </Space>
                <div style={{ marginTop: 8 }}>
                  <Text type="secondary">消息数: {g.message_count || 0}</Text>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Modal>

      {/* AI 生成讨论方案弹窗 */}
      <Modal
        title="🤖 AI 生成讨论方案"
        open={aiModal}
        onCancel={() => setAiModal(false)}
        onOk={handleAiGenerate}
        confirmLoading={aiLoading}
        okText="生成方案"
      >
        <Form form={aiForm} layout="vertical">
          <Form.Item name="topic" label="讨论主题" rules={[{ required: true, message: '请输入讨论主题' }]}>
            <Input placeholder="如：人工智能的伦理困境" />
          </Form.Item>
          <Form.Item name="subject" label="学科" initialValue="信息技术">
            <Select>
              <Select.Option value="信息技术">信息技术</Select.Option>
              <Select.Option value="通用技术">通用技术</Select.Option>
              <Select.Option value="人工智能通识">人工智能通识</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="ai_role" label="AI 助教角色" initialValue="guide">
            <Select>
              <Select.Option value="observer">👀 旁观者</Select.Option>
              <Select.Option value="guide">💡 引导者</Select.Option>
              <Select.Option value="proactive">🗣️ 主动参与</Select.Option>
              <Select.Option value="judge">⚖️ 辩论裁判</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="duration_minutes" label="预计时长 (分钟)" initialValue={30}>
            <InputNumber min={5} max={120} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default DiscussionPage
