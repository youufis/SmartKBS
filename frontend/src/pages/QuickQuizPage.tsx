/**
 * QuickQuizPage — 知识抢答主页
 * 教师：创建房间、管理历史
 * 学生：查看可加入的房间、参与历史
 */
import React, { useState, useEffect } from 'react'
import {
  Card, Button, Typography, Space, Table, Tag, message, Spin, Empty,
  Modal, Form, Input, InputNumber, Select, Switch, Row, Col, Statistic, Popconfirm, Tooltip,
} from 'antd'
import {
  ThunderboltOutlined, PlusOutlined, PlayCircleOutlined,
  HistoryOutlined, TeamOutlined, ClockCircleOutlined,
  TrophyOutlined, SettingOutlined, QuestionCircleOutlined,
  UserOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import MobileCardTable from '../components/MobileCardTable'
import KnowledgePointSelect, { splitKps, joinKps } from '../components/KnowledgePointSelect'
import { useIsMobile } from '../hooks/useIsMobile'
import useSubjectOptions from '../hooks/useSubjectOptions'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
import { useTranslation } from 'react-i18next'
import ScopeTag from '../components/ScopeTag'
import ResetActivityButton from '../components/ResetActivityButton'
import { reportLoadError } from '../utils/loadError'

const { Title, Text } = Typography
const { TextArea } = Input

/** 房间创建时间: 列表双行显示用 */
const fmtRoomTime = (v?: string) => v?.split('.')[0]?.replace('T', ' ').slice(0, 16) || '-'

const QuickQuizPage: React.FC = () => {
  const { t } = useTranslation('interaction')
  // 窄屏：活动列表与历史记录改卡片渲染（桌面仍为 Table）
  const isMobile = useIsMobile()
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
  // 知识点下拉选项跟随所选学科过滤（创建/编辑两个表单各一份）
  const createKpSubject = Form.useWatch('subject', form)
  const editKpSubject = Form.useWatch('subject', editForm)
  const [history, setHistory] = useState<any[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyTab, setHistoryTab] = useState('active')
  const [activityScope, setActivityScope] = useState<ActivityScopeValue>({
    target_scope: 'teacher_classes',
    target_grade: '',
    target_class: '',
    target_users: '',
  })

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
    } catch (err) { reportLoadError(err, { key: 'QuickQuizPage.loadHistory', retry: () => { void loadHistory() } }) }
    finally { setHistoryLoading(false) }
  }

  const handleCreate = async (values: any) => {
    try {
      const scope = activityScope || { target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' }
      const payload = {
        ...values,
        target_scope: scope.target_scope,
        target_grade: scope.target_grade,
        target_class: scope.target_class,
        target_users: scope.target_users,
      }
      const { data } = await apiClient.post('/api/quick-quiz/room', payload)
      message.success(t('roomCreated', { title: data.title, code: data.room_code }))
      setCreateModal(false)
      form.resetFields()
      setActivityScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
      loadRooms()
    } catch (err: any) {
      message.error(err.response?.data?.detail || t('createFailed'))
    }
  }

  const handleJoin = async () => {
    if (!joinCode.trim()) { message.warning(t('enterJoinCode')); return }
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
      message.error(err.response?.data?.detail || t('joinFailed'))
    } finally {
      setJoining(false)
    }
  }

  const handleEdit = async (values: any) => {
    if (!editRoom) return
    try {
      const scope = activityScope || { target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' }
      const payload = {
        ...values,
        target_scope: scope.target_scope,
        target_grade: scope.target_grade,
        target_class: scope.target_class,
        target_users: scope.target_users,
      }
      await apiClient.put(`/api/quick-quiz/room/${editRoom.id}`, payload)
      setEditModal(false)
      setEditRoom(null)
      editForm.resetFields()
      loadRooms()
    } catch (err: any) {
      message.error(err.response?.data?.detail || t('updateFailed'))
    }
  }

  const handleDelete = async (roomId: number) => {
    try {
      await apiClient.delete(`/api/quick-quiz/room/${roomId}`)
      loadRooms()
    } catch (err: any) {
      message.error(err.response?.data?.detail || t('deleteFailed'))
    }
  }

  const handleStart = async (roomId: number) => {
    try {
      await apiClient.post(`/api/quick-quiz/room/${roomId}/start`)
      navigate(`/quick-quiz/console/${roomId}`)
    } catch (err: any) {
      message.error(err.response?.data?.detail || t('startFailed'))
    }
  }

  const getStatusTag = (status: string) => {
    const map: Record<string, { color: string; text: string }> = {
      waiting: { color: 'processing', text: t('waiting') },
      playing: { color: 'success', text: t('playing') },
      ended: { color: 'default', text: t('ended') },
    }
    const s = map[status] || { color: 'default', text: status }
    return <Tag color={s.color}>{s.text}</Tag>
  }

  // ── 教师房间列表 ──
  const teacherColumns = [
    { title: t('roomCode'), dataIndex: 'room_code', key: 'code', width: 86,
      render: (code: string) => <Text code strong style={{ fontSize: 15 }}>{code}</Text>
    },
    // 列标题原先写的是 t('title') —— 这个 key 在 interaction 命名空间里是页面标题「随堂测验」，
    // 于是抢答列表的"活动名称"列一直显示成"随堂测验"（内容其实是竞赛名称）。改用 activityName。
    { title: t('activityName'), dataIndex: 'title', key: 'title', width: 150, ellipsis: true },
    // 科目：房间表本来就有 subject（建活动时选的），列表以前没展示
    { title: t('subject'), dataIndex: 'subject', key: 'subject', width: 90,
      render: (v: string) => v || '-' },
    { title: t('status'), dataIndex: 'status', key: 'status', width: 80, render: getStatusTag },
    // 题量与时限合成一格：少一列、行更短，一眼读完
    { title: t('quizMeta'), key: 'meta', width: 104,
      render: (_: any, r: any) => `${r.question_count ?? 0} ${t('questions')} · ${r.time_limit ?? 0}s` },
    { title: t('players'), key: 'players', width: 60,
      render: (_: any, r: any) => (
        <span><TeamOutlined /> {r.player_count || 0}</span>
      )
    },
    { title: t('gradeClass'), key: 'scope', width: 150,
      render: (_: any, r: any) => (
        <ScopeTag scope={r.target_scope} grade={r.target_grade} classes={r.target_class} users={r.target_users} />
      )
    },
    { title: t('creator'), key: 'creator_time', width: 110,
      render: (_: any, r: any) => (
        <div>
          <div>{r.creator_username || '-'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{fmtRoomTime(r.created_at)}</div>
        </div>
      )
    },
    {
      // 操作列全用图标 + tooltip（文字按钮太占地方，整行会被挤到屏幕外）；
      // 宽度按"主操作 + 4 个图标"给足，避免图标被挤到第二行
      title: t('actions'), key: 'action', width: 168,
      render: (_: any, record: any) => (
        <Space size={2} wrap={false} align="center" style={{ whiteSpace: 'nowrap' }}>
          {record.status === 'waiting' && (
            <Tooltip title={t('startGame')}>
              <Button type="primary" size="small" icon={<PlayCircleOutlined />}
                onClick={() => handleStart(record.id)} />
            </Tooltip>
          )}
          {record.status === 'playing' && (
            <Tooltip title={t('console')}>
              <Button type="primary" size="small" icon={<ThunderboltOutlined />}
                onClick={() => navigate(`/quick-quiz/console/${record.id}`)} />
            </Tooltip>
          )}
          {record.status === 'ended' && (
            <Tooltip title={t('viewResults')}>
              <Button size="small" icon={<TrophyOutlined />}
                onClick={() => navigate(`/quick-quiz/result/${record.id}`)} />
            </Tooltip>
          )}
          {record.status === 'waiting' && (
            <Tooltip title={t('edit')}>
            <Button size="small" icon={<EditOutlined />}
              onClick={() => {
                setEditRoom(record)
                setActivityScope({
                  target_scope: record.target_scope || 'teacher_classes',
                  target_grade: record.target_grade || '',
                  target_class: record.target_class || '',
                  target_users: record.target_users || '',
                })
                editForm.setFieldsValue({
                  title: record.title,
                  question_source: record.question_source || 'bank_academic',
                  question_count: record.question_count,
                  time_limit: record.time_limit,
                  scoring_mode: record.scoring_mode,
                  subject: record.subject,
                  difficulty: record.difficulty,
                  knowledge_points: record.knowledge_points,
                  min_players: record.min_players,
                  max_players: record.max_players,
                })
                setEditModal(true)
              }} />
            </Tooltip>
          )}
          {/* 重置：清参与数据、留房间配置；进行中也能重置（弹窗里会要求强制确认） */}
          <ResetActivityButton activityType="quick_quiz" activityId={record.id}
            iconOnly
            onSuccess={() => { void loadRooms(); void loadHistory(); }} />
          {record.status !== 'playing' && (
            <Popconfirm title={t('confirmDeleteActivity')}
              description={t('deleteActivityHint')}
              onConfirm={() => handleDelete(record.id)}>
              <Tooltip title={t('delete')}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
          <Tooltip title={t('details')}>
            <Button size="small" icon={<EyeOutlined />}
              onClick={() => navigate(`/quick-quiz/lobby/${record.id}`)} />
          </Tooltip>
        </Space>
      )
    },
  ]

  // ── 学生房间列表 ──
  const studentColumns = [
    { title: t('roomCode'), dataIndex: 'room_code', key: 'code', width: 86,
      render: (code: string) => <Text code strong style={{ fontSize: 15 }}>{code}</Text>
    },
    // 同教师视图：这里以前也是 t('title')（= 页面标题"随堂测验"），改为活动名称
    { title: t('activityName'), dataIndex: 'title', key: 'title', width: 150, ellipsis: true },
    { title: t('subject'), dataIndex: 'subject', key: 'subject', width: 90,
      render: (v: string) => v || '-' },
    { title: t('status'), dataIndex: 'status', key: 'status', width: 80, render: getStatusTag },
    { title: t('quizMeta'), key: 'meta', width: 104,
      render: (_: any, r: any) => `${r.question_count ?? 0} ${t('questions')} · ${r.time_limit ?? 0}s` },
    { title: t('teacher'), key: 'teacher_time', width: 110,
      render: (_: any, r: any) => (
        <div>
          <div>{r.creator_username || '-'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{fmtRoomTime(r.created_at)}</div>
        </div>
      )
    },
    {
      title: t('actions'), key: 'action', width: 120,
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
              {t('joinRoom')}
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
              {t('participateQuiz')}
            </Button>
          )}
          {record.status === 'ended' && (
            <Button size="small"
              onClick={() => navigate(`/quick-quiz/result/${record.id}`)}>
              {t('viewResults')}
            </Button>
          )}
        </Space>
      )
    },
  ]

  // 抢答历史记录列定义（桌面表格与窄屏卡片共用同一份）
  const historyColumns = [
                { title: t('activityName'), dataIndex: 'title', key: 'title', ellipsis: true },
                { title: t('status'), dataIndex: 'status', key: 'status', render: getStatusTag },
                { title: t('score'), dataIndex: 'total_score', key: 'score',
                  render: (s: number) => <Text strong style={{ color: '#faad14' }}>{s}</Text>
                },
                { title: t('correct'), dataIndex: 'correct_count', key: 'correct' },
                { title: t('wrong'), dataIndex: 'wrong_count', key: 'wrong' },
                { title: t('maxStreak'), dataIndex: 'max_streak', key: 'streak',
                  render: (s: number) => s > 1 ? <Tag color="volcano">🔥 x{s}</Tag> : '-'
                },
                { title: t('teacher'), dataIndex: 'creator_username', key: 'teacher' },
                {
                  title: t('actions'), key: 'action',
                  render: (_: any, r: any) => (
                    <Button size="small" onClick={() => navigate(`/quick-quiz/result/${r.id}`)}>
                      {t('viewDetails')}
                    </Button>
                  )
                },
                ]

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* 顶栏 */}
      <Card style={{ borderRadius: 12, marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}
        styles={{ body: { padding: '16px 24px' } }}>
        <Space>
          <ThunderboltOutlined style={{ fontSize: 28, color: '#fff' }} />
          <div>
            <Title level={4} style={{ color: '#fff', margin: 0 }}>{t('quickQuiz')}</Title>
            <Text style={{ color: 'rgba(255,255,255,0.85)' }}>
              {isTeacherOrAdmin ? t('quizManageDesc') : t('quizPlayDesc')}
            </Text>
          </div>
        </Space>
      </Card>

      {/* 操作按钮 */}
      <Card style={{ borderRadius: 12, marginBottom: 16 }} styles={{ body: { padding: '12px 16px' } }}>
        <Space wrap>
          {isTeacherOrAdmin && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModal(true)}>
              {t('createQuizActivity')}
            </Button>
          )}
          {isStudent && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setJoinModal(true)}>
              {t('enterCodeJoin')}
            </Button>
          )}
          <Button icon={<HistoryOutlined />} onClick={loadRooms}>{t('refreshList')}</Button>
        </Space>
      </Card>

      {/* 房间列表 */}
      <Card title={t('activityList', { count: rooms.length })} style={{ borderRadius: 12 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
        ) : rooms.length === 0 ? (
          <Empty description={isTeacherOrAdmin ? t('noActivitiesTeacher') : t('noActivitiesStudent')} />
        ) : (
          isMobile ? (
            <MobileCardTable
              dataSource={rooms}
              columns={isTeacherOrAdmin ? teacherColumns : studentColumns}
              rowKey="id"
            />
          ) : (
          <Table
            dataSource={rooms}
            columns={isTeacherOrAdmin ? teacherColumns : studentColumns}
            rowKey="id"
            pagination={{ pageSize: 20 }}
            size="small"
            /* 列多而窗外窄时横向滚动，别把右边列挤没/裁掉（此前"详情"会被切掉） */
            scroll={{ x: 'max-content' }}
          />
          )
        )}
      </Card>

      {/* 学生历史记录 */}
      {isStudent && (
        <Card title={t('myQuizHistory')} style={{ borderRadius: 12, marginTop: 16 }}>
          {historyLoading ? <Spin /> : history.length === 0 ? (
            <Empty description={t('noHistory')} />
          ) : (
            isMobile ? (
              <MobileCardTable dataSource={history} columns={historyColumns} rowKey="id" />
            ) : (
            <Table
              dataSource={history}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10 }}
              columns={historyColumns}
            />
            )
          )}
        </Card>
      )}

      {/* ── 创建房间弹窗 ── */}
      <Modal maskClosable={false}
        title={t('createQuizModal')}
        open={createModal}
        onCancel={() => {
          setCreateModal(false)
          form.resetFields()
          setActivityScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
        }}
        onOk={() => form.submit()}
        okText={t('create')}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}
          initialValues={{
            title: t('quickQuiz'),
            question_source: 'bank_academic',
            question_count: 10,
            time_limit: 15,
            scoring_mode: 'speed',
            min_players: 2,
            max_players: 50,
            subject: '',
            difficulty: 'medium',
          }}
        >
          <Form.Item name="title" label={t('activityTitle')} rules={[{ required: true }]}>
            <Input placeholder={t('activityTitlePlaceholder')} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="question_source" label={t('questionSource')} rules={[{ required: true }]}>
                <Select options={[
                  { value: 'bank_academic', label: t('bankAcademic') },
                  { value: 'bank_general', label: t('bankGeneral') },
                ]} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="question_count" label={t('questionCount')}>
                <InputNumber min={3} max={30} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="time_limit" label={t('timeLimitSeconds')}>
                <InputNumber min={5} max={60} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="scoring_mode" label={t('scoringMode')}>
                <Select options={[
                  { value: 'speed', label: t('speedScoringDesc') },
                  { value: 'tiered', label: t('tieredScoringDesc') },
                ]} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="min_players" label={t('minPlayers')}>
                <InputNumber min={1} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="max_players" label={t('maxPlayers')}>
                <InputNumber min={2} max={200} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="subject" label={t('subject')}>
                <Select
                  showSearch
                  placeholder={t('selectSubject')}
                  options={subjectOptions.map(s => ({ value: s, label: s }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="difficulty" label={t('difficulty')}>
                <Select options={[
                  { value: 'easy', label: t('difficultyEasy') },
                  { value: 'medium', label: t('difficultyMedium') },
                  { value: 'hard', label: t('difficultyHard') },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          {/* 知识点：与试题管理同款控件（下拉选课程知识点 + 手输） */}
          <Form.Item name="knowledge_points" label={t('knowledgePoints')}
            getValueProps={(v) => ({ value: splitKps(v) })}
            normalize={(v) => joinKps(v)}>
            <KnowledgePointSelect subject={createKpSubject || ''} />
          </Form.Item>
          <Form.Item label={t('activityScope')} style={{ marginBottom: 16 }}>
            <ActivityScopeSelector
              value={activityScope}
              onChange={setActivityScope}
              showAllOption={isTeacherOrAdmin && user?.role === 'admin'}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 加入房间弹窗 ── */}
      <Modal maskClosable={false}
        title={t('enterJoinCodeModal')}
        open={joinModal}
        onCancel={() => { setJoinModal(false); setJoinCode('') }}
        onOk={handleJoin}
        confirmLoading={joining}
        okText={t('join')}
      >
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Input
            size="large"
            style={{ width: 200, fontSize: 28, textAlign: 'center', letterSpacing: 8 }}
            value={joinCode}
            onChange={e => setJoinCode(e.target.value.toUpperCase())}
            placeholder={t('joinCodePlaceholder')}
            maxLength={6}
            autoFocus
          />
          <div style={{ marginTop: 12, color: 'var(--text-tertiary)' }}>
            {t('askTeacherForCode')}
          </div>
        </div>
      </Modal>

      {/* ── 编辑房间弹窗 ── */}
      <Modal maskClosable={false}
        title={t('editQuizModal')}
        open={editModal}
        onCancel={() => {
          setEditModal(false)
          setEditRoom(null)
          editForm.resetFields()
          setActivityScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
        }}
        onOk={() => editForm.submit()}
        okText={t('save')}
        width={600}
      >
        <Form form={editForm} layout="vertical" onFinish={handleEdit}>
          <Form.Item name="title" label={t('activityTitle')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="question_source" label={t('questionSource')}>
            <Select options={[
              { value: 'bank_academic', label: t('bankAcademicLabel') },
              { value: 'bank_general', label: t('bankGeneralLabel') },
            ]} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="question_count" label={t('questionCount')}>
                <InputNumber min={3} max={30} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="time_limit" label={t('timeLimitSeconds')}>
                <InputNumber min={5} max={60} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="scoring_mode" label={t('scoringMode')}>
                <Select options={[
                  { value: 'speed', label: t('speedScoring') },
                  { value: 'tiered', label: t('tieredScoring') },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="subject" label={t('subject')}>
                <Select
                  showSearch
                  options={subjectOptions.map(s => ({ value: s, label: s }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="difficulty" label={t('difficulty')}>
                <Select options={[
                  { value: 'easy', label: t('difficultyEasy') },
                  { value: 'medium', label: t('difficultyMedium') },
                  { value: 'hard', label: t('difficultyHard') },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          {/* 知识点：与试题管理同款控件（下拉选课程知识点 + 手输） */}
          <Form.Item name="knowledge_points" label={t('knowledgePoints')}
            getValueProps={(v) => ({ value: splitKps(v) })}
            normalize={(v) => joinKps(v)}>
            <KnowledgePointSelect subject={editKpSubject || ''} />
          </Form.Item>
          <Form.Item label={t('activityScope')} style={{ marginBottom: 16 }}>
            <ActivityScopeSelector
              value={activityScope}
              onChange={setActivityScope}
              showAllOption={isTeacherOrAdmin && user?.role === 'admin'}
            />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="min_players" label={t('minPlayers')}>
                <InputNumber min={1} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="max_players" label={t('maxPlayers')}>
                <InputNumber min={2} max={200} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Card>
  )
}

export default QuickQuizPage
