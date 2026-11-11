/**
 * QuickQuizPage — 知识抢答主页
 * 教师：创建房间、管理历史
 * 学生：查看可加入的房间、参与历史
 */
import React, { useState, useEffect, useMemo } from 'react'
import {
  Card, Button, Typography, Space, Tag, message, Spin, Empty, Pagination,
  Modal, Form, Input, InputNumber, Select, Row, Col, Popconfirm, Tooltip,
  Checkbox, Alert,
} from 'antd'
import {
  ThunderboltOutlined, PlusOutlined, PlayCircleOutlined,
  HistoryOutlined, TeamOutlined, ClockCircleOutlined,
  TrophyOutlined, SettingOutlined, QuestionCircleOutlined,
  UserOutlined, EditOutlined, DeleteOutlined, EyeOutlined, RedoOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { RowList } from '../components/RowList'
import PageHeader from '../components/PageHeader'
import KnowledgePointSelect, { splitKps, joinKps } from '../components/KnowledgePointSelect'
import useSubjectOptions from '../hooks/useSubjectOptions'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
import { useTranslation } from 'react-i18next'
import ScopeTag from '../components/ScopeTag'
import ResetActivityButton from '../components/ResetActivityButton'
import ListFilterBar from '../components/ListFilterBar'
import { reportLoadError } from '../utils/loadError'
import { relativeTime } from '../utils/relativeTime'

const { Text } = Typography
const { TextArea } = Input

const QuickQuizPage: React.FC = () => {
  const { t } = useTranslation('interaction')
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  const [rooms, setRooms] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  // 列表查找/分类：标题或房间码关键词 + 状态 + 学科（数据已全量在本地，无需再打接口）
  const [roomKw, setRoomKw] = useState('')
  const [roomStatus, setRoomStatus] = useState('all')
  const [roomSubject, setRoomSubject] = useState('')
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
  // 卡片列表分页（原来靠 Table 内置分页；换卡片后自己管）
  const [roomPage, setRoomPage] = useState(1)
  const [roomPageSize, setRoomPageSize] = useState(10)
  const [historyPage, setHistoryPage] = useState(1)
  const [historyPageSize, setHistoryPageSize] = useState(10)
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
        reportLoadError(e, { key: 'QuickQuizPage.loadRooms', retry: () => { void loadRooms() } })
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

  /** 重新开始：复制本场配置开新一场（本场成绩/排名原样保留），成功后直接进等待页 */
  const [restartRoom, setRestartRoom] = useState<any>(null)
  const [restartReuse, setRestartReuse] = useState(true)
  const [restarting, setRestarting] = useState(false)
  const handleRestart = async () => {
    if (!restartRoom) return
    setRestarting(true)
    try {
      const { data } = await apiClient.post(
        `/api/quick-quiz/room/${restartRoom.id}/restart`, { reuse_questions: restartReuse })
      setRestartRoom(null)
      message.success(t('restartCreated', { code: data.room_code }))
      await loadRooms()
      navigate(`/quick-quiz/lobby/${data.room_id}`)
    } catch (err: any) {
      message.error(err.response?.data?.detail || t('restartFailed'))
    } finally { setRestarting(false) }
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

  // ── 活动列表 / 抢答记录：卡片列表（与随堂测验、同步练习、活动监控同款） ──
  // 这张表是“列宽博弈”的典型：房间码 + 名称 + 学科 + 状态 + 题量时限 + 参与者 +
  // 年级班级 + 创建者 + 最多 5 个操作图标，窄窗必然横向滚动、图标被挤到第二行。
  // 换卡片后不用再给每列定宽，操作图标也一定在同一行（与其它活动列表统一）。
  const openEditRoom = (record: any) => {
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
  }

  const renderRoomCard = (record: any) => (
    <Card size="small" hoverable={isTeacherOrAdmin}
      style={{ marginBottom: 8, cursor: isTeacherOrAdmin ? 'pointer' : 'default' }}
      onClick={isTeacherOrAdmin ? () => navigate(`/quick-quiz/lobby/${record.id}`) : undefined}>
      <div className="page-header-flex stack-row"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={8} align="center" wrap>
            <Text code strong style={{ fontSize: 15 }}>{record.room_code}</Text>
            <Text strong>{record.title}</Text>
            {getStatusTag(record.status)}
          </Space>
          <div style={{ marginTop: 4 }}>
            <Tag>{t('subject')}：{record.subject || '-'}</Tag>
            {isTeacherOrAdmin && (
              <ScopeTag scope={record.target_scope} grade={record.target_grade}
                classes={record.target_class} users={record.target_users} />
            )}
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.question_count ?? 0} {t('questions')} · {record.time_limit ?? 0}s
              {isTeacherOrAdmin && <>{' · '}<TeamOutlined /> {record.player_count || 0}</>}
              {' · '}{isTeacherOrAdmin ? '' : `${t('teacher')}：`}{record.creator_username || '-'}
              {' · '}{relativeTime(record.created_at)}
            </Text>
          </div>
        </div>
        {/* 卡片整块可点 → 操作区必须掉断冒泡，否则点“删除”会先跳进房间 */}
        <span onClick={(e) => e.stopPropagation()}>
          <Space size={2} wrap={false} align="center" style={{ whiteSpace: 'nowrap' }}>
            {isTeacherOrAdmin ? (
              <>
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
                {/* 重新开始：已结束的场次一键「再比一场」，复制配置开新房，本场成绩保留 */}
                {record.status === 'ended' && (
                  <Tooltip title={t('restartActivity')}>
                    <Button size="small" icon={<RedoOutlined />}
                      onClick={() => { setRestartReuse(true); setRestartRoom(record) }} />
                  </Tooltip>
                )}
                {/* 编辑：待开始 + 已结束都能改配置（已结束改的是下一场模板，不动已有成绩） */}
                {record.status !== 'playing' && (
                  <Tooltip title={t('edit')}>
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEditRoom(record)} />
                  </Tooltip>
                )}
                {/* 重置：清参与数据、留房间配置；进行中也能重置（弹窗里会要求强制确认） */}
                <ResetActivityButton activityType="quick_quiz" activityId={record.id}
                  iconOnly stopPropagation
                  onSuccess={() => { void loadRooms(); void loadHistory() }} />
                {record.status !== 'playing' && (
                  <Popconfirm title={t('confirmDeleteActivity')}
                    description={t('deleteActivityHint')}
                    onConfirm={() => handleDelete(record.id)}>
                    <Tooltip title={t('delete')}>
                      <Button size="small" danger icon={<DeleteOutlined />}
                        onClick={(e) => e.stopPropagation()} />
                    </Tooltip>
                  </Popconfirm>
                )}
                {/* 详情只在「待开始」有意义：进行中会跳控制台、已结束会跳结果页，
                    与旁边的按钮完全重复，所以这两种状态不再显示 */}
                {record.status === 'waiting' && (
                  <Tooltip title={t('details')}>
                    <Button size="small" icon={<EyeOutlined />}
                      onClick={() => navigate(`/quick-quiz/lobby/${record.id}`)} />
                  </Tooltip>
                )}
              </>
            ) : (
              <>
                {record.status === 'waiting' && (
                  <Button type="primary" size="small" icon={<PlayCircleOutlined />}
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
                  <Button type="primary" size="small" icon={<ThunderboltOutlined />}
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
                  <Button size="small" icon={<TrophyOutlined />}
                    onClick={() => navigate(`/quick-quiz/result/${record.id}`)}>
                    {t('viewResults')}
                  </Button>
                )}
              </>
            )}
          </Space>
        </span>
      </div>
    </Card>
  )

  // ── 房间列表的查找/分类（本地全量数据，切筛选即时生效） ──
  const roomStatusCount = useMemo(() => ({
    waiting: rooms.filter((r: any) => r.status === 'waiting').length,
    playing: rooms.filter((r: any) => r.status === 'playing').length,
    ended: rooms.filter((r: any) => r.status === 'ended').length,
  }), [rooms])
  const roomSubjects = useMemo(
    () => Array.from(new Set(rooms.map((r: any) => String(r.subject || '').trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map((s) => ({ value: s, label: s })),
    [rooms],
  )
  const visibleRooms = useMemo(() => {
    const k = roomKw.trim().toLowerCase()
    return rooms.filter((r: any) => {
      if (roomStatus !== 'all' && r.status !== roomStatus) return false
      if (roomSubject && String(r.subject || '').trim() !== roomSubject) return false
      if (!k) return true
      return `${r.title || ''} ${r.room_code || ''} ${r.creator_username || ''}`.toLowerCase().includes(k)
    })
  }, [rooms, roomKw, roomStatus, roomSubject])

  // 学生的“我的抢答记录”
  const renderHistoryCard = (r: any) => (
    <Card size="small" hoverable style={{ marginBottom: 8, cursor: 'pointer' }}
      onClick={() => navigate(`/quick-quiz/result/${r.id}`)}>
      <div className="page-header-flex stack-row"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong>{r.title}</Text>
          <div style={{ marginTop: 4 }}>
            {getStatusTag(r.status)}
            <Tag color="gold">{t('score')} {r.total_score}</Tag>
            <Tag>{t('correct')} {r.correct_count}</Tag>
            <Tag>{t('wrong')} {r.wrong_count}</Tag>
            {r.max_streak > 1 && <Tag color="volcano">🔥 x{r.max_streak}</Tag>}
            <Text type="secondary" style={{ fontSize: 12 }}>{t('teacher')}：{r.creator_username || '-'}</Text>
          </div>
        </div>
        <span onClick={(e) => e.stopPropagation()}>
          <Tooltip title={t('viewDetails')}>
            <Button size="small" icon={<EyeOutlined />}
              onClick={() => navigate(`/quick-quiz/result/${r.id}`)} />
          </Tooltip>
        </span>
      </div>
    </Card>
  )

  return (
    <div>
      <PageHeader
        icon={<ThunderboltOutlined />}
        title={t('quickQuiz')}
        subtitle={isTeacherOrAdmin ? t('quizManageDesc') : t('quizPlayDesc')}
        extra={(
          <>
            <Tooltip title={t('refreshList')}>
              <Button icon={<HistoryOutlined />} onClick={loadRooms} />
            </Tooltip>
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
          </>
        )}
      />

      {/* 房间列表 */}
      <Card title={t('activityList', { count: visibleRooms.length })} style={{ borderRadius: 8 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
        ) : rooms.length === 0 ? (
          <Empty description={isTeacherOrAdmin ? t('noActivitiesTeacher') : t('noActivitiesStudent')} />
        ) : (
          <>
            <ListFilterBar
              keyword={roomKw}
              onKeyword={(v) => { setRoomKw(v); setRoomPage(1) }}
              searchPlaceholder={t('listSearchPh')}
              status={roomStatus}
              onStatus={(v) => { setRoomStatus(v); setRoomPage(1) }}
              statusOptions={[
                { value: 'all', label: `${t('all')} (${rooms.length})` },
                { value: 'waiting', label: `${t('waiting')} (${roomStatusCount.waiting})` },
                { value: 'playing', label: `${t('playing')} (${roomStatusCount.playing})` },
                { value: 'ended', label: `${t('ended')} (${roomStatusCount.ended})` },
              ]}
              subject={roomSubject}
              onSubject={(v) => { setRoomSubject(v); setRoomPage(1) }}
              subjectOptions={roomSubjects}
              subjectPlaceholder={t('subject')}
              dirty={!!roomKw || roomStatus !== 'all' || !!roomSubject}
              onReset={() => { setRoomKw(''); setRoomStatus('all'); setRoomSubject(''); setRoomPage(1) }}
              resetLabel={t('clearFilter')}
            />
            {visibleRooms.length === 0 ? (
              <Empty description={t('listNoMatch')} />
            ) : (
              <>
                <RowList items={visibleRooms.slice((roomPage - 1) * roomPageSize, roomPage * roomPageSize)}
                  split={false} renderItem={renderRoomCard} />
                <div style={{ marginTop: 12, textAlign: 'center' }}>
                  <Pagination
                    current={roomPage} pageSize={roomPageSize} total={visibleRooms.length}
                    showSizeChanger showTotal={(total) => t('totalCount', { count: total })}
                    pageSizeOptions={['10', '20', '50']}
                    onChange={(p, ps) => { setRoomPage(p); setRoomPageSize(ps) }}
                    size="small"
                  />
                </div>
              </>
            )}
          </>
        )}
      </Card>

      {/* 学生历史记录 */}
      {isStudent && (
        <Card title={t('myQuizHistory')} style={{ borderRadius: 12, marginTop: 16 }}>
          {historyLoading ? <Spin /> : history.length === 0 ? (
            <Empty description={t('noHistory')} />
          ) : (
            <>
              <RowList items={history.slice((historyPage - 1) * historyPageSize, historyPage * historyPageSize)}
                split={false} renderItem={renderHistoryCard} />
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <Pagination
                  current={historyPage} pageSize={historyPageSize} total={history.length}
                  showSizeChanger showTotal={(total) => t('totalCount', { count: total })}
                  pageSizeOptions={['10', '20', '50']}
                  onChange={(p, ps) => { setHistoryPage(p); setHistoryPageSize(ps) }}
                  size="small"
                />
              </div>
            </>
          )}
        </Card>
      )}

      {/* ── 创建房间弹窗 ── */}
      <Modal mask={{ closable: false }}
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
            extra={t('kpOptionalHint')}
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
      <Modal mask={{ closable: false }}
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
      <Modal mask={{ closable: false }}
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
          {editRoom?.status === 'ended' && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }}
              title={t('editEndedHint')} />
          )}
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
            extra={t('kpOptionalHint')}
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

      {/* ── 重新开始弹窗：复制配置开新一场，本场数据不动 ── */}
      <Modal mask={{ closable: false }}
        title={<Space><RedoOutlined />{t('restartActivity')}</Space>}
        open={!!restartRoom}
        onCancel={() => setRestartRoom(null)}
        onOk={handleRestart}
        confirmLoading={restarting}
        okText={t('restartConfirm')}
        width={520}
      >
        {restartRoom && (
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            <Alert type="info" showIcon
              title={t('restartTarget', { title: restartRoom.title })}
              description={t('restartKeepHint')} />
            <Checkbox checked={restartReuse} onChange={(e) => setRestartReuse(e.target.checked)}>
              {t('restartReuseQuestions', { count: restartRoom.question_count ?? 0 })}
            </Checkbox>
          </Space>
        )}
      </Modal>
    </div>
  )
}

export default QuickQuizPage
