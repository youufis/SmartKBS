import React, { useState, useEffect, useReducer } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Card, Row, Col, Statistic, Typography, Spin, Tag, Space,
  Timeline, Empty, Alert, Button, Select, message,
  Table, List, Modal,
} from 'antd'
import {
  TrophyOutlined, FileAddOutlined, CheckCircleOutlined,
  AuditOutlined, MessageOutlined,
  RightOutlined,
  BookOutlined, CalendarOutlined, RobotOutlined, DownloadOutlined,
  ExperimentOutlined, EyeOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import * as trackingApi from '../api/tracking'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

const COLOR_MAP: Record<string, string> = {
  lime: '#a0d911', green: '#52c41a', cyan: '#13c2c2',
  blue: '#1677ff', geekblue: '#2f54eb', purple: '#722ed1',
  magenta: '#eb2f96', gold: '#faad14', orange: '#fa8c16',
  volcano: '#fa541c', red: '#f5222d', default: '#d9d9d9',
}

interface PortfolioData {
  user: {
    username: string
    name: string
    class: string
    grade: string
    gender: string
  }
  summary: string
  exams: {
    results: any[]
    stats: {
      total_exams: number
      avg_score: number
      avg_percentage: number
      passed_count: number
      failed_count: number
      max_score: number
      min_score: number
      trend: number[]
      subjects: string[]
    }
  }
  scores: {
    total_score: number
    teacher_count: number
    class_count: number
    records: Array<{ teacher: string; grade: string; class: string; score: number; updated_at: string }>
    trend: Array<{ date: string; score: number }>
  } | null
  reward_points: number
  reward_history: Array<{
    activity_type: string
    activity_title: string
    reward_type: string
    points: number
    reason: string
    created_at: string
  }>
  rollcall: {
    total_calls: number
    correct_count: number
    wrong_count: number
    accuracy: number
    total_points: number
  } | null
  tasks: {
    completed: number
    tasks: Array<{ name: string; description: string; submitted_at: string }>
  }
  chats: {
    total_days: number
    total_chats: number
    avg_daily: number
    recent_days: Array<{ date: string; count: number }>
  } | null
  course_practice: {
    total_count: number
    avg_accuracy: number
    total_score: number
    records: Array<{
      id: number
      kp_name: string
      score: number
      total_score: number
      accuracy: number
      evaluation: string
      submitted_at: string
    }>
  } | null
}

const TYPE_ICONS: Record<string, React.ReactNode> = {
  exam: <FileAddOutlined style={{ color: '#1677ff' }} />,
  score: <TrophyOutlined style={{ color: '#faad14' }} />,
  rollcall: <AuditOutlined style={{ color: '#722ed1' }} />,
  task: <CheckCircleOutlined style={{ color: '#52c41a' }} />,
  practice: <ExperimentOutlined style={{ color: '#52c41a' }} />,
}

interface PortfolioState {
  data: PortfolioData | null
  timeline: any[]
  loading: boolean
  error: string
  titleInfo: any
}

type PortfolioAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; data: PortfolioData; timeline: any[]; titleInfo: any }
  | { type: 'FETCH_ERROR'; error: string }

function portfolioReducer(state: PortfolioState, action: PortfolioAction): PortfolioState {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, loading: true, error: '' }
    case 'FETCH_SUCCESS':
      return { data: action.data, timeline: action.timeline, loading: false, error: '', titleInfo: action.titleInfo }
    case 'FETCH_ERROR':
      return { ...state, loading: false, error: action.error }
    default:
      return state
  }
}

const initialState: PortfolioState = {
  data: null,
  timeline: [],
  loading: true,
  error: '',
  titleInfo: null,
}

const PortfolioPage: React.FC = () => {
  const { t } = useTranslation('score')
  const { username: paramUsername } = useParams<{ username: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  const targetUsername = paramUsername || user?.username || ''
  const [state, dispatch] = useReducer(portfolioReducer, initialState)
  const { data, timeline, loading, error, titleInfo } = state

  useEffect(() => {
    if (!targetUsername) return
    dispatch({ type: 'FETCH_START' })
    Promise.all([
      apiClient.get(`/api/portfolio/${targetUsername}`),
      apiClient.get(`/api/portfolio/${targetUsername}/timeline`),
      apiClient.get(`/api/rewards/my-title`).catch(() => ({ data: null })),
    ])
      .then(([portfolioRes, timelineRes, titleRes]) => {
        dispatch({
          type: 'FETCH_SUCCESS',
          data: portfolioRes.data,
          timeline: timelineRes.data || [],
          titleInfo: titleRes?.data,
        })
      })
      .catch((err) => {
        dispatch({ type: 'FETCH_ERROR', error: err.response?.data?.detail || t('queryFail') })
      })
  }, [targetUsername])

  // ── AI 学习报告 ──
  const [reportModal, setReportModal] = useState(false)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportData, setReportData] = useState<{ report: string; period: string; data?: any } | null>(null)
  const [reportDays, setReportDays] = useState<number>(30)
  const [viewStats, setViewStats] = useState<{ total_views: number; unique_html: number; unique_download: number; total_reward_points: number }>({ total_views: 0, unique_html: 0, unique_download: 0, total_reward_points: 0 })

  useEffect(() => {
    trackingApi.getMyViewStats().then(setViewStats).catch(() => {})
  }, [])

  const handleGenerateReport = async () => {
    setReportLoading(true)
    setReportData(null)
    setReportModal(true)
    try {
      const { data } = await apiClient.get(`/api/portfolio/${targetUsername}/report`, {
        params: { days: reportDays, period: t('portfolio.recentDays', { days: reportDays }) },
      })
      if (data.task_id) {
        const result = await pollAiTask(data.task_id)
        if (result) setReportData(result)
        else message.error(t('aiAnalysisTimeout'))
      } else {
        setReportData(data)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('portfolio.reportFailed'))
      setReportModal(false)
    }
    setReportLoading(false)
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <Spin size="large" description={t('loading')} />
      </div>
    )
  }

  if (error) {
    return <Alert type="error" message={error} showIcon />
  }

  if (!data) {
    return <Empty description={t('noData')} />
  }

  const { user: student, exams, scores, reward_points, reward_history, rollcall, tasks, chats, course_practice } = data
  const examStats = exams?.stats

  // ── 根据称号等级、性别、角色动态获取头像 emoji（成长进化主题）──
  const getAvatarEmoji = (level: number, gender: string, role?: string): string => {
    if (role === 'admin') return '⚜️'
    if (role === 'teacher') return '🎓'
    // 学生按等级：萌芽→生长→绽放→卓越→巅峰
    if (level <= 1) return '🪴'   // 萌芽
    if (level <= 2) return '🌱'   // 幼苗
    if (level <= 3) return '🌿'   // 生长
    if (level <= 4) return '🌳'   // 成才
    if (level <= 5) return '🎯'   // 精准
    if (level <= 6) return '🔮'   // 洞察
    if (level <= 7) return '🚀'   // 突破
    if (level <= 8) return '🌟'   // 闪耀
    if (level <= 9) return '🌙'   // 卓越
    if (level <= 10) return '☀️'  // 辉煌
    if (level <= 11) return '👑'  // 至尊
    return '💎'                    // 巅峰
  }
  // 判断：titleInfo 是否属于当前查看的学生（自己查看自己，或教师查看时的 titleInfo 取自 my-title）
  const isSelfView = !isTeacherOrAdmin || targetUsername === user?.username
  const avatarLevel = isSelfView ? (titleInfo?.main_title?.level || 1) : 2
  const avatarRole = isSelfView ? undefined : (isTeacherOrAdmin ? 'teacher' : undefined)
  const avatarEmoji = getAvatarEmoji(avatarLevel, student.gender, avatarRole)
  const baseColor = COLOR_MAP[titleInfo?.main_title?.color] || '#667eea'
  const avatarColor = isSelfView ? baseColor : (isTeacherOrAdmin ? '#722ed1' : '#667eea')

  const totalDataPoints = [
    { label: t('exam'), value: examStats?.total_exams ?? 0, icon: <FileAddOutlined />, color: '#1677ff' },
    { label: t('classScore'), value: scores?.total_score ?? 0, icon: <TrophyOutlined />, color: '#faad14' },
    { label: t('rewardPoints'), value: reward_points ?? 0, icon: <TrophyOutlined />, color: '#eb2f96' },
    { label: t('rollcallCount'), value: rollcall?.total_calls ?? 0, icon: <AuditOutlined />, color: '#722ed1' },
    { label: t('taskCompleted'), value: tasks?.completed ?? 0, icon: <CheckCircleOutlined />, color: '#52c41a' },
    { label: t('chatDays'), value: chats?.total_days ?? 0, icon: <MessageOutlined />, color: '#13c2c2' },
    { label: t('coursePractice'), value: course_practice?.total_count ?? 0, icon: <ExperimentOutlined />, color: '#52c41a' },
    { label: t('resourceViews'), value: viewStats.total_views, icon: <EyeOutlined />, color: '#1677ff' },
  ]

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* ─── 页面标题 + 学生信息合并行 ─── */}
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, color: '#fff' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 28,
            background: `linear-gradient(135deg, ${avatarColor} 0%, ${avatarColor}cc 100%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28, flexShrink: 0, boxShadow: `0 2px 8px ${avatarColor}40`,
          }}>
            {avatarEmoji}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Title level={4} style={{ color: '#fff', margin: 0 }}>📋 {t('portfolio')}</Title>
              <Title level={3} style={{ color: '#fff', margin: 0 }}>{student.name}</Title>
            </div>
            <Space style={{ marginTop: 4, flexWrap: 'wrap' }}>
              <Tag color="rgba(255,255,255,0.3)" style={{ color: '#fff', border: 'none' }}>{student.grade}</Tag>
              <Tag color="rgba(255,255,255,0.3)" style={{ color: '#fff', border: 'none' }}>{student.class}班</Tag>
              <Tag color="rgba(255,255,255,0.3)" style={{ color: '#fff', border: 'none' }}>{student.username}</Tag>
              {titleInfo?.main_title && (
                <Tag color={titleInfo.main_title.color !== 'default' ? titleInfo.main_title.color : undefined}
                  style={{ fontSize: 13, padding: '0 10px', borderRadius: 10 }}>
                  {titleInfo.main_title.emoji} Lv.{titleInfo.main_title.level} {titleInfo.main_title.name}
                </Tag>
              )}
            </Space>
          </div>
          {isTeacherOrAdmin && (
            <Button ghost icon={<RightOutlined />} onClick={() => navigate(-1)}>
              {t('cancel')}
            </Button>
          )}
        </div>
      </Card>

      {/* ─── 综合摘要 ─── */}
      <Alert
        type="info"
        message={
          <Space>
            <BookOutlined />
            <Text>{data.summary}</Text>
          </Space>
        }
        style={{ marginBottom: 16, background: '#f6f8ff', border: '1px solid #d6e4ff' }}
      />

      {/* ─── AI 学习报告（仅教师/管理员可见） ─── */}
      {isTeacherOrAdmin && (
        <Card size="small" style={{ marginBottom: 16, background: '#fffbe6', border: '1px solid #ffe58f' }}>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space>
              <RobotOutlined style={{ color: '#faad14', fontSize: 18 }} />
              <Text strong>{t('aiReport')}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('aiReportDesc')}</Text>
            </Space>
            <Space>
              <Select value={reportDays} onChange={setReportDays} style={{ width: 100 }} size="small"
                options={[
                  { value: 7, label: t('portfolio.recentDays', { days: 7 }) },
                  { value: 30, label: t('portfolio.recentDays', { days: 30 }) },
                  { value: 90, label: t('portfolio.recentDays', { days: 90 }) },
                ]} />
              <Button type="primary" size="small" icon={<RobotOutlined />}
                loading={reportLoading} onClick={handleGenerateReport}>
                {t('generateReport')}
              </Button>
            </Space>
          </Space>
        </Card>
      )}

      {/* ─── 数据总览卡片 ─── */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {totalDataPoints.map((item) => (
          <Col xs={12} sm={8} lg={4} key={item.label}>
            <Card hoverable size="small" style={{ textAlign: 'center' }}>
              <Space orientation="vertical" size={2}>
                <span style={{ fontSize: 22, color: item.color }}>{item.icon}</span>
                <Text strong style={{ fontSize: 20, color: item.color }}>{item.value}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{item.label}</Text>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]}>
        {/* ─── 左侧：详细数据 ─── */}
        <Col xs={24} lg={14}>
          {/* 考试成绩表 */}
          {exams?.results && exams.results.length > 0 && (
            <Card title={<Space><FileAddOutlined />{t('examResults')}</Space>} style={{ marginBottom: 16 }} size="small">
              <Row gutter={16} style={{ marginBottom: 12 }}>
                <Col span={6}><Statistic title={t('avgScore')} value={examStats?.avg_percentage ?? 0} suffix="%" styles={{ content: { color: '#1677ff' } }} /></Col>
                <Col span={6}><Statistic title={t('maxScore')} value={examStats?.max_score ?? 0} styles={{ content: { color: '#52c41a' } }} /></Col>
                <Col span={6}><Statistic title={t('passed')} value={examStats?.passed_count ?? 0} suffix={`/ ${examStats?.total_exams ?? 0}`} styles={{ content: { color: '#52c41a' } }} /></Col>
                <Col span={6}>
                  <Statistic title={t('accuracy')} value={rollcall?.accuracy ?? 0} suffix="%" prefix={<AuditOutlined />} />
                </Col>
              </Row>

              {/* 简易成绩走势图（纯 CSS 条形） */}
              {examStats?.trend && examStats.trend.length > 1 && (
                <div style={{ marginBottom: 12 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('portfolio.scoreTrend')}</Text>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 60, paddingTop: 8 }}>
                    {examStats.trend.map((pct: number, i: number) => (
                      <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <div style={{
                          width: '100%', height: `${Math.max(pct, 2)}%`, minHeight: 4,
                          background: pct >= 60 ? '#52c41a' : '#ff4d4f',
                          borderRadius: '4px 4px 0 0',
                          transition: 'height 0.3s',
                        }} />
                        <Text style={{ fontSize: 9, marginTop: 2 }}>{pct}%</Text>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Table
                dataSource={exams.results}
                rowKey="id"
                size="small"
                pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => t('totalRecords', { count: total }), pageSizeOptions: ['5', '10', '20'] }}
                columns={[
                  { title: t('exam'), dataIndex: 'title', ellipsis: true },
                  {
                    title: t('score'), key: 'score',
                    render: (_: any, r: any) => (
                      <Text strong style={{ color: r.score >= r.pass_score ? '#52c41a' : '#ff4d4f' }}>
                        {r.score} / {r.total_score}
                      </Text>
                    ),
                  },
                  {
                    title: t('portfolio.result'), key: 'result',
                    render: (_: any, r: any) => (
                      <Tag color={r.score >= r.pass_score ? 'green' : 'red'}>
                        {r.score >= r.pass_score ? t('portfolio.passed') : t('portfolio.failed')}
                      </Tag>
                    ),
                  },
                  {
                    title: t('time'), dataIndex: 'submitted_at',
                    render: (val: string) => val ? val.slice(0, 10) : '-',
                    width: 100,
                  },
                ]}
              />
            </Card>
          )}

          {/* 课堂积分明细 */}
          {scores?.records && scores.records.length > 0 && (
            <Card title={<Space><TrophyOutlined />{t('classScore')}</Space>} style={{ marginBottom: 16 }} size="small">
              <Row gutter={16} style={{ marginBottom: 12 }}>
                <Col span={8}><Statistic title={t('totalScore')} value={scores.total_score} styles={{ content: { color: '#faad14' } }} prefix={<TrophyOutlined />} /></Col>
                <Col span={8}><Statistic title={t('teacherCount')} value={scores.teacher_count} suffix={t('portfolio.peopleSuffix')} /></Col>
                <Col span={8}><Statistic title={t('classCount')} value={scores.class_count} suffix={t('portfolio.classesSuffix')} /></Col>
              </Row>

              {/* 积分趋势 */}
              {scores.trend && scores.trend.length > 1 && (
                <div style={{ marginBottom: 12 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('portfolio.scoreTrend')}</Text>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 50, paddingTop: 8 }}>
                    {scores.trend.map((point, i) => {
                      const maxVal = Math.max(...scores.trend.map((p) => p.score), 1)
                      return (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <div style={{
                            width: '100%', height: `${(point.score / maxVal) * 100}%`, minHeight: 4,
                            background: '#faad14', borderRadius: '4px 4px 0 0',
                          }} />
                          <Text style={{ fontSize: 8, marginTop: 1 }}>{point.date.slice(5)}</Text>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <Table
                dataSource={scores.records}
                rowKey={(_, i) => String(i)}
                size="small"
                pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => t('totalRecords', { count: total }), pageSizeOptions: ['5', '10', '20'] }}
                columns={[
                  { title: t('portfolio.teacher'), dataIndex: 'teacher', width: 80 },
                  { title: t('grade'), dataIndex: 'grade', width: 60 },
                  { title: t('class_'), dataIndex: 'class', width: 80 },
                  { title: t('score'), dataIndex: 'score', width: 60 },
                  { title: t('time'), dataIndex: 'updated_at', render: (val: string) => val ? val.slice(0, 10) : '-' },
                ]}
              />
            </Card>
          )}

          {/* 奖励积分（活动自动发放） */}
          {(reward_points > 0 || reward_history?.length > 0) && (
            <Card title={<Space><TrophyOutlined style={{ color: '#eb2f96' }} />{t('rewardPoints')}</Space>} style={{ marginBottom: 16 }} size="small">
              <Row gutter={16} style={{ marginBottom: 12 }}>
                <Col span={24}>
                  <Statistic title={t('portfolio.totalRewardPoints')} value={reward_points} styles={{ content: { color: '#eb2f96' } }} prefix={<TrophyOutlined />} />
                </Col>
              </Row>
              {reward_history?.length > 0 && (
                <Table
                  dataSource={reward_history}
                  rowKey={(_, i) => String(i)}
                  size="small"
                  pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => t('totalRecords', { count: total }), pageSizeOptions: ['5', '10', '20'] }}
                  columns={[
                    { title: t('portfolio.activityType'), dataIndex: 'activity_type_name', width: 80 },
                    { title: t('activityName'), dataIndex: 'activity_title', ellipsis: true },
                    { title: t('rewardType'), dataIndex: 'reward_type_name', width: 80 },
                    { title: t('points'), dataIndex: 'points', width: 60 },
                    {
                      title: t('description'), dataIndex: 'reason', ellipsis: true,
                      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text>,
                    },
                    {
                      title: t('time'), dataIndex: 'created_at',
                      render: (val: string) => val ? val.slice(0, 10) : '-', width: 90,
                    },
                  ]}
                />
              )}
            </Card>
          )}

          {/* 任务完成 */}
          {tasks.tasks.length > 0 && (
            <Card title={<Space><CheckCircleOutlined />{t('taskCompleted')}</Space>} style={{ marginBottom: 16 }} size="small">
              <List
                size="small"
                dataSource={tasks.tasks}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      title={item.name}
                      description={
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {item.description} | {t('portfolio.submittedAt', { date: item.submitted_at?.slice(0, 10) || t('portfolio.unknown') })}
                        </Text>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}

          {/* 对话活跃 */}
          {chats?.total_days != null && (
            <Card title={<Space><MessageOutlined />{t('aiChatActivity')}</Space>} size="small">
              <Row gutter={16}>
                <Col span={8}><Statistic title={t('chatDays')} value={chats.total_days} suffix={t('portfolio.daysSuffix')} /></Col>
                <Col span={8}><Statistic title={t('portfolio.totalChats')} value={chats.total_chats} suffix={t('portfolio.timesSuffix')} /></Col>
                <Col span={8}><Statistic title={t('portfolio.dailyAvg')} value={chats.avg_daily} suffix={t('portfolio.timesSuffix')} /></Col>
              </Row>
            </Card>
          )}

          {/* 课程练习 */}
          {course_practice?.records && course_practice.records.length > 0 && (
            <Card title={<Space><ExperimentOutlined style={{ color: '#52c41a' }} />{t('coursePractice')}</Space>} style={{ marginBottom: 16 }} size="small">
              <Row gutter={16} style={{ marginBottom: 12 }}>
                <Col span={8}><Statistic title={t('portfolio.completedCount')} value={course_practice.total_count} suffix={t('portfolio.knowledgePointsSuffix')} styles={{ content: { color: '#52c41a' } }} /></Col>
                <Col span={8}><Statistic title={t('portfolio.avgAccuracy')} value={course_practice.avg_accuracy} suffix="%" styles={{ content: { color: '#1677ff' } }} /></Col>
                <Col span={8}><Statistic title={t('totalScore')} value={course_practice.total_score} styles={{ content: { color: '#faad14' } }} /></Col>
              </Row>
              <Table
                dataSource={course_practice.records}
                rowKey="id"
                size="small"
                pagination={{ pageSize: 10, showTotal: (total) => t('totalRecords', { count: total }) }}
                columns={[
                  { title: t('portfolio.knowledgePoint'), dataIndex: 'kp_name', ellipsis: true },
                  {
                    title: t('score'), key: 'score',
                    render: (_: any, r: any) => (
                      <Text strong style={{ color: r.accuracy >= 60 ? '#52c41a' : '#ff4d4f' }}>
                        {r.score} / {r.total_score}
                      </Text>
                    ),
                  },
                  {
                    title: t('portfolio.accuracyRate'), dataIndex: 'accuracy',
                    render: (v: number) => (
                      <Tag color={v >= 90 ? 'green' : v >= 60 ? 'blue' : 'red'}>{v}%</Tag>
                    ),
                  },
                  {
                    title: t('portfolio.evaluation'), dataIndex: 'evaluation',
                    ellipsis: true,
                    render: (v: string) => (
                      <Text type="secondary" style={{ fontSize: 12 }}>{v?.slice(0, 20)}</Text>
                    ),
                  },
                  {
                    title: t('time'), dataIndex: 'submitted_at',
                    render: (val: string) => val ? val.slice(0, 10) : '-',
                    width: 90,
                  },
                ]}
              />
            </Card>
          )}
        </Col>

        {/* ─── 右侧：成长时间轴 ─── */}
        <Col xs={24} lg={10}>
          <Card
            title={<Space><CalendarOutlined />{t('growthTimeline')}</Space>}
            style={{ height: '100%' }}
          >
            {timeline.length === 0 ? (
              <Empty description={t('noGrowthRecords')} />
            ) : (
              <Timeline
                items={timeline.slice(-30).reverse().map((ev: any) => ({
                  color: ev.type === 'exam' ? '#1677ff' : ev.type === 'score' ? '#faad14' : ev.type === 'rollcall' ? '#722ed1' : '#52c41a',
                  content: (
                    <div>
                      <Space>
                        {TYPE_ICONS[ev.type]}
                        <Text strong style={{ fontSize: 13 }}>{ev.title}</Text>
                      </Space>
                      {ev.detail && <div><Text type="secondary" style={{ fontSize: 12 }}>{ev.detail}</Text></div>}
                      <div><Text type="secondary" style={{ fontSize: 11 }}>{ev.time?.slice(0, 16) || ''}</Text></div>
                    </div>
                  ),
                }))}
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* ── AI 学习报告弹窗 ── */}
      <Modal
        title={<><RobotOutlined style={{ color: '#1677ff' }} /> {t('aiReport')} - {student.name}（{reportData?.period || t('portfolio.generatingReport')}）</>}
        open={reportModal}
        onCancel={() => { if (reportLoading) return; setReportModal(false) }}
        width={700}
        footer={
          reportLoading ? null : (
            <Space style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
              <Button icon={<DownloadOutlined />} onClick={() => {
                if (!targetUsername) return
                const token = localStorage.getItem('smartkb_token')
                window.open(`/api/portfolio/${targetUsername}/report/export?days=${reportDays}&period=${encodeURIComponent(t('portfolio.recentDays', { days: reportDays }))}&token=${token}`, '_blank')
              }}>{t('portfolio.exportWord')}</Button>
              <Button onClick={() => setReportModal(false)}>{t('cancel')}</Button>
            </Space>
          )
        }
      >
        {reportLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: '#666' }}>{t('portfolio.generatingReport')}</div>
          </div>
        ) : reportData ? (
          <div style={{ maxHeight: '70vh', overflow: 'auto', padding: '0 4px' }}>
            {reportData.data && (
              <Row gutter={12} style={{ marginBottom: 16 }}>
                <Col span={6}><Statistic title={t('portfolio.examCount')} value={reportData.data.exams} suffix={t('portfolio.timesSuffix')} /></Col>
                <Col span={6}><Statistic title={t('totalScore')} value={reportData.data.total_score} /></Col>
                <Col span={6}><Statistic title={t('portfolio.rollcallRate')} value={reportData.data.rollcall_rate} suffix="%" /></Col>
                <Col span={6}><Statistic title={t('chatDays')} value={reportData.data.chat_days} suffix={t('portfolio.daysSuffix')} /></Col>
              </Row>
            )}
            <div className="markdown-content">
              <ReactMarkdown>{reportData.report}</ReactMarkdown>
            </div>
          </div>
        ) : null}
      </Modal>
    </Card>
  )
}

export default PortfolioPage
