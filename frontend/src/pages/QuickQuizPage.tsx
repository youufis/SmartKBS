/**
 * QuickQuizPage — 知识抢答主页
 * 教师：创建房间、管理历史
 * 学生：查看可加入的房间、参与历史
 */
import React, { useState, useEffect } from 'react'
import {
  Card, Button, Typography, Space, Table, Tag, message, Spin, Empty,
  Modal, Form, Input, InputNumber, Select, Switch, Row, Col, Statistic, Popconfirm,
} from 'antd'
import {
  ThunderboltOutlined, PlusOutlined, PlayCircleOutlined,
  HistoryOutlined, TeamOutlined, ClockCircleOutlined,
  TrophyOutlined, SettingOutlined, QuestionCircleOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import useSubjectOptions from '../hooks/useSubjectOptions'

const { Title, Text } = Typography
const { TextArea } = Input

const QuickQuizPage: React.FC = () => {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  const [rooms, setRooms] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [createModal, setCreateModal] = useState(false)
  const [joinModal, setJoinModal] = useState(false)
  const { subjects: subjectOptions } = useSubjectOptions()
  const [joinCode, setJoinCode] = useState('')
  const [joining, setJoining] = useState(false)
  const [form] = Form.useForm()
  const [editModal, setEditModal] = useState(false)
  const [editRoom, setEditRoom] = useState<any>(null)
  const [editForm] = Form.useForm()
  const [history, setHistory] = useState<any[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyTab, setHistoryTab] = useState('active')

  useEffect(() => {
    loadRooms()
    if (isStudent) loadHistory()
  }, [])

  const loadRooms = async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/quick-quiz/rooms', {
        params: { status: historyTab === 'active' ? '' : historyTab }
      })
      setRooms(data.rooms || [])
    } catch (e: any) {
      if (e?.response?.status !== 403) {
        message.error('加载抢答活动列表失败')
      }
    } finally {
      setLoading(false)
    }
  }

  const loadHistory = async () => {
    setHistoryLoading(true)
    try {
      const { data } = await apiClient.get('/api/quick-quiz/history')
      setHistory(data.records || [])
    } catch { /* ignore */ }
    finally { setHistoryLoading(false) }
  }

  const handleCreate = async (values: any) => {
    try {
      const { data } = await apiClient.post('/api/quick-quiz/room', values)
      message.success(`房间「${data.title}」创建成功！房间码：${data.room_code}`)
      setCreateModal(false)
      form.resetFields()
      loadRooms()
    } catch (err: any) {
      message.error(err.response?.data?.detail || '创建失败')
    }
  }

  const handleJoin = async () => {
    if (!joinCode.trim()) { message.warning('请输入房间码'); return }
    setJoining(true)
    try {
      const { data } = await apiClient.post('/api/quick-quiz/join', { room_code: joinCode.trim().toUpperCase() })
      setJoinModal(false)
      setJoinCode('')
      if (data.room.status === 'playing') {
        navigate(`/quick-quiz/play/${data.room_id}`)
      } else {
        navigate(`/quick-quiz/lobby/${data.room_id}`)
      }
    } catch (err: any) {
      message.error(err.response?.data?.detail || '加入失败')
    } finally {
      setJoining(false)
    }
  }

  const handleEdit = async (values: any) => {
    if (!editRoom) return
    try {
      await apiClient.put(`/api/quick-quiz/room/${editRoom.id}`, values)
      message.success('活动配置已更新')
      setEditModal(false)
      setEditRoom(null)
      editForm.resetFields()
      loadRooms()
    } catch (err: any) {
      message.error(err.response?.data?.detail || '更新失败')
    }
  }

  const handleDelete = async (roomId: number) => {
    try {
      await apiClient.delete(`/api/quick-quiz/room/${roomId}`)
      message.success('已删除')
      loadRooms()
    } catch (err: any) {
      message.error(err.response?.data?.detail || '删除失败')
    }
  }

  const handleStart = async (roomId: number) => {
    try {
      await apiClient.post(`/api/quick-quiz/room/${roomId}/start`)
      navigate(`/quick-quiz/console/${roomId}`)
    } catch (err: any) {
      message.error(err.response?.data?.detail || '启动失败')
    }
  }

  const getStatusTag = (status: string) => {
    const map: Record<string, { color: string; text: string }> = {
      waiting: { color: 'processing', text: '等待中' },
      playing: { color: 'success', text: '进行中' },
      ended: { color: 'default', text: '已结束' },
    }
    const s = map[status] || { color: 'default', text: status }
    return <Tag color={s.color}>{s.text}</Tag>
  }

  // ── 教师房间列表 ──
  const teacherColumns = [
    { title: '房间码', dataIndex: 'room_code', key: 'code', width: 100,
      render: (code: string) => <Text code strong style={{ fontSize: 16 }}>{code}</Text>
    },
    { title: '标题', dataIndex: 'title', key: 'title', width: 160 },
    { title: '状态', dataIndex: 'status', key: 'status', width: 80, render: getStatusTag },
    { title: '题目', dataIndex: 'question_count', key: 'count', width: 60 },
    { title: '时限', dataIndex: 'time_limit', key: 'time', width: 60,
      render: (t: number) => `${t}s`
    },
    { title: '玩家', key: 'players', width: 60,
      render: (_: any, r: any) => (
        <span><TeamOutlined /> {r.player_count || 0}</span>
      )
    },
    { title: '创建者', dataIndex: 'creator_name', key: 'creator', width: 80 },
    { title: '创建时间', dataIndex: 'created_at', key: 'created', width: 150,
      render: (t: string) => t?.split('.')[0]?.replace('T', ' ') || t
    },
    {
      title: '操作', key: 'action', width: 200,
      render: (_: any, record: any) => (
        <Space>
          {record.status === 'waiting' && (
            <Button type="primary" size="small" icon={<PlayCircleOutlined />}
              onClick={() => handleStart(record.id)}>
              开始
            </Button>
          )}
          {record.status === 'playing' && (
            <Button type="primary" size="small"
              onClick={() => navigate(`/quick-quiz/console/${record.id}`)}>
              控制台
            </Button>
          )}
          {record.status === 'ended' && (
            <Button size="small"
              onClick={() => navigate(`/quick-quiz/result/${record.id}`)}>
              查看结果
            </Button>
          )}
          {record.status === 'waiting' && (
            <Button size="small"
              onClick={() => {
                setEditRoom(record)
                editForm.setFieldsValue({
                  title: record.title,
                  question_source: record.question_source || 'bank_academic',
                  question_count: record.question_count,
                  time_limit: record.time_limit,
                  scoring_mode: record.scoring_mode,
                  subject: record.subject,
                  difficulty: record.difficulty,
                  knowledge_points: record.knowledge_points,
                  target_grade: record.target_grade,
                  target_class: record.target_class,
                  min_players: record.min_players,
                  max_players: record.max_players,
                })
                setEditModal(true)
              }}>
              编辑
            </Button>
          )}
          {record.status !== 'playing' && (
            <Popconfirm title="确定删除此活动？"
              description="删除后数据不可恢复"
              onConfirm={() => handleDelete(record.id)}>
              <Button size="small" danger>删除</Button>
            </Popconfirm>
          )}
          <Button size="small"
            onClick={() => navigate(`/quick-quiz/lobby/${record.id}`)}>
            详情
          </Button>
        </Space>
      )
    },
  ]

  // ── 学生房间列表 ──
  const studentColumns = [
    { title: '房间码', dataIndex: 'room_code', key: 'code', width: 100,
      render: (code: string) => <Text code strong style={{ fontSize: 16 }}>{code}</Text>
    },
    { title: '标题', dataIndex: 'title', key: 'title', width: 160 },
    { title: '状态', dataIndex: 'status', key: 'status', width: 80, render: getStatusTag },
    { title: '题目', dataIndex: 'question_count', key: 'count', width: 60 },
    { title: '时限', dataIndex: 'time_limit', key: 'time', width: 60,
      render: (t: number) => `${t}s`
    },
    { title: '教师', dataIndex: 'creator_name', key: 'teacher', width: 80 },
    { title: '创建时间', dataIndex: 'created_at', key: 'created', width: 150,
      render: (t: string) => t?.split('.')[0]?.replace('T', ' ') || t
    },
    {
      title: '操作', key: 'action', width: 120,
      render: (_: any, record: any) => (
        <Space>
          {record.status === 'waiting' && (
            <Button type="primary" size="small"
              onClick={async () => {
                try {
                  await apiClient.post('/api/quick-quiz/join', { room_code: record.room_code })
                } catch { /* 可能已加入 */ }
                navigate(`/quick-quiz/lobby/${record.id}`)
              }}>
              加入房间
            </Button>
          )}
          {record.status === 'playing' && (
            <Button type="primary" size="small"
              onClick={async () => {
                try {
                  await apiClient.post('/api/quick-quiz/join', { room_code: record.room_code })
                } catch { /* 可能已加入 */ }
                navigate(`/quick-quiz/play/${record.id}`)
              }}>
              参与抢答
            </Button>
          )}
          {record.status === 'ended' && (
            <Button size="small"
              onClick={() => navigate(`/quick-quiz/result/${record.id}`)}>
              查看结果
            </Button>
          )}
        </Space>
      )
    },
  ]

  return (
    <div style={{ width: '100%', margin: '0 auto', padding: 16 }}>
      {/* 顶栏 */}
      <Card style={{ borderRadius: 12, marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}
        styles={{ body: { padding: '16px 24px' } }}>
        <Space>
          <ThunderboltOutlined style={{ fontSize: 28, color: '#fff' }} />
          <div>
            <Title level={4} style={{ color: '#fff', margin: 0 }}>知识抢答</Title>
            <Text style={{ color: 'rgba(255,255,255,0.85)' }}>
              {isTeacherOrAdmin ? '创建和管理课堂抢答活动' : '参与课堂实时抢答，比速度拼知识'}
            </Text>
          </div>
        </Space>
      </Card>

      {/* 操作按钮 */}
      <Card style={{ borderRadius: 12, marginBottom: 16 }} styles={{ body: { padding: '12px 16px' } }}>
        <Space wrap>
          {isTeacherOrAdmin && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModal(true)}>
              创建抢答活动
            </Button>
          )}
          {isStudent && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setJoinModal(true)}>
              输入房间码加入
            </Button>
          )}
          <Button icon={<HistoryOutlined />} onClick={loadRooms}>刷新列表</Button>
        </Space>
      </Card>

      {/* 房间列表 */}
      <Card title={`📋 活动列表 (${rooms.length})`} style={{ borderRadius: 12 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
        ) : rooms.length === 0 ? (
          <Empty description={isTeacherOrAdmin ? '暂无活动，点击上方按钮创建' : '暂无可加入的活动'} />
        ) : (
          <Table
            dataSource={rooms}
            columns={isTeacherOrAdmin ? teacherColumns : studentColumns}
            rowKey="id"
            pagination={{ pageSize: 20 }}
            size="small"
          />
        )}
      </Card>

      {/* 学生历史记录 */}
      {isStudent && (
        <Card title="📜 我的抢答记录" style={{ borderRadius: 12, marginTop: 16 }}>
          {historyLoading ? <Spin /> : history.length === 0 ? (
            <Empty description="暂无参与记录" />
          ) : (
            <Table
              dataSource={history}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10 }}
              columns={[
                { title: '标题', dataIndex: 'title', key: 'title' },
                { title: '状态', dataIndex: 'status', key: 'status', render: getStatusTag },
                { title: '得分', dataIndex: 'total_score', key: 'score',
                  render: (s: number) => <Text strong style={{ color: '#faad14' }}>{s}</Text>
                },
                { title: '答对', dataIndex: 'correct_count', key: 'correct' },
                { title: '答错', dataIndex: 'wrong_count', key: 'wrong' },
                { title: '最高连击', dataIndex: 'max_streak', key: 'streak',
                  render: (s: number) => s > 1 ? <Tag color="volcano">🔥 x{s}</Tag> : '-'
                },
                { title: '教师', dataIndex: 'creator_name', key: 'teacher' },
                {
                  title: '操作', key: 'action',
                  render: (_: any, r: any) => (
                    <Button size="small" onClick={() => navigate(`/quick-quiz/result/${r.id}`)}>
                      查看详情
                    </Button>
                  )
                },
              ]}
            />
          )}
        </Card>
      )}

      {/* ── 创建房间弹窗 ── */}
      <Modal
        title="🚀 创建抢答活动"
        open={createModal}
        onCancel={() => setCreateModal(false)}
        onOk={() => form.submit()}
        okText="创建"
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}
          initialValues={{
            title: '知识抢答',
            question_source: 'bank_academic',
            question_count: 10,
            time_limit: 15,
            scoring_mode: 'speed',
            min_players: 2,
            max_players: 50,
            subject: '信息科技',
            difficulty: 'medium',
          }}
        >
          <Form.Item name="title" label="活动标题" rules={[{ required: true }]}>
            <Input placeholder="例如：第3章 随堂抢答" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="question_source" label="题目来源" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'bank_academic', label: '📚 学科试题库' },
                  { value: 'bank_general', label: '🧠 百科知识题库' },
                ]} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="question_count" label="题量">
                <InputNumber min={3} max={30} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="time_limit" label="每题时限(秒)">
                <InputNumber min={5} max={60} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="scoring_mode" label="计分模式">
                <Select options={[
                  { value: 'speed', label: '速度递减（越快分越高）' },
                  { value: 'tiered', label: '分段奖励（固定档位）' },
                ]} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="min_players" label="最少人数">
                <InputNumber min={1} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="max_players" label="最多人数">
                <InputNumber min={2} max={200} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="subject" label="学科">
                <Select
                  showSearch
                  placeholder="选择学科"
                  options={subjectOptions.map(s => ({ value: s, label: s }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="difficulty" label="难度">
                <Select options={[
                  { value: 'easy', label: '简单' },
                  { value: 'medium', label: '中等' },
                  { value: 'hard', label: '困难' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="knowledge_points" label="知识点（可选，逗号分隔）">
            <Input placeholder="例如：计算机网络, 数据结构" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="target_grade" label="目标年级（留空不限）">
                <Input placeholder="高一、高二..." />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="target_class" label="目标班级（留空不限）">
                <Input placeholder="1,2,3..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ── 加入房间弹窗 ── */}
      <Modal
        title="🔑 输入房间码加入抢答"
        open={joinModal}
        onCancel={() => { setJoinModal(false); setJoinCode('') }}
        onOk={handleJoin}
        confirmLoading={joining}
        okText="加入"
      >
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Input
            size="large"
            style={{ width: 200, fontSize: 28, textAlign: 'center', letterSpacing: 8 }}
            value={joinCode}
            onChange={e => setJoinCode(e.target.value.toUpperCase())}
            placeholder="输入房间码"
            maxLength={6}
            autoFocus
          />
          <div style={{ marginTop: 12, color: '#888' }}>
            向老师获取 6 位房间码
          </div>
        </div>
      </Modal>

      {/* ── 编辑房间弹窗 ── */}
      <Modal
        title="✏️ 编辑抢答活动"
        open={editModal}
        onCancel={() => { setEditModal(false); setEditRoom(null); editForm.resetFields() }}
        onOk={() => editForm.submit()}
        okText="保存"
        width={600}
      >
        <Form form={editForm} layout="vertical" onFinish={handleEdit}>
          <Form.Item name="title" label="活动标题" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="question_source" label="题目来源">
            <Select options={[
              { value: 'bank_academic', label: '📚 学科试题库' },
              { value: 'bank_general', label: '🧠 百科知识题库' },
            ]} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="question_count" label="题量">
                <InputNumber min={3} max={30} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="time_limit" label="每题时限(秒)">
                <InputNumber min={5} max={60} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="scoring_mode" label="计分模式">
                <Select options={[
                  { value: 'speed', label: '速度递减' },
                  { value: 'tiered', label: '分段奖励' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="subject" label="学科">
                <Select
                  showSearch
                  options={subjectOptions.map(s => ({ value: s, label: s }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="difficulty" label="难度">
                <Select options={[
                  { value: 'easy', label: '简单' },
                  { value: 'medium', label: '中等' },
                  { value: 'hard', label: '困难' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="knowledge_points" label="知识点（可选，逗号分隔）">
            <Input placeholder="例如：计算机网络, 数据结构" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="target_grade" label="目标年级">
                <Input placeholder="留空不限" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="target_class" label="目标班级">
                <Input placeholder="留空不限" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="min_players" label="最少人数">
                <InputNumber min={1} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="max_players" label="最多人数">
                <InputNumber min={2} max={200} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}

export default QuickQuizPage
