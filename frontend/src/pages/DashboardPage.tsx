import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card, Row, Col, Statistic, Typography, Spin, List, Tag, Space,
  Timeline, Button, Empty, Progress,
} from 'antd'
import {
  FileAddOutlined, TrophyOutlined, CheckCircleOutlined,
  MessageOutlined, TeamOutlined,
  ClockCircleOutlined, ThunderboltOutlined,
  AuditOutlined, BarChartOutlined, ReloadOutlined,
  RightOutlined, ExperimentOutlined, BellOutlined,
  FireOutlined, CustomerServiceOutlined, EyeOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useCompanionStore } from '../stores/companionStore'
import * as notificationsApi from '../api/notifications'
import type { AnnouncementItem } from '../api/notifications'
import { getTaskTodo } from '../api/taskTodo'

const { Text, Paragraph } = Typography

interface DashboardSummary {
  role: 'admin' | 'teacher' | 'student'
  username: string
  user_name: string
  // 学生
  pending_exam_count?: number
  completed_exam_count?: number
  total_score?: number
  rank?: number
  active_task_count?: number
  // 称号系统
  title_name?: string
  title_level?: number
  title_emoji?: string
  title_color?: string
  next_title_name?: string | null
  title_progress?: number
  submission_count?: number
  recent_chat_count?: number
  exam_results?: Array<{
    id: number
    title: string
    score: number
    total_score: number
    submitted_at: string
    pass_score: number
    passed: boolean
  }>
  pending_exams?: Array<{
    id: number
    title: string
    subject: string
    duration: number
    total_score: number
    pass_score: number
    start_time: string | null
    end_time: string | null
  }>
  // 学生 - 课堂互动
  active_quiz_count?: number
  my_quiz_answers?: number
  student_poll_vote_count?: number
  my_questions_count?: number
  my_answers_count?: number
  // 教师/管理员
  exam_stats?: {
    total: number
    draft: number
    published: number
    ended: number
  }
  total_submissions?: number
  active_task_count_teacher?: number
  total_students?: number
  total_teachers?: number
  rollcall_this_week?: number
  today_chat_count?: number
  teacher_grades?: string
  teacher_classes?: string
  teacher_subjects?: string[]
  // 教师/管理员 - 课堂互动
  teacher_quiz_count?: number
  teacher_active_quiz_count?: number
  teacher_poll_count?: number
  teacher_quiz_answer_count?: number
  teacher_poll_vote_count?: number
  teacher_question_count?: number
  teacher_pending_question_count?: number
  teacher_student_answer_count?: number
  teacher_approved_answer_count?: number
  // 学生 - 分组讨论
  active_discussion_count?: number
  my_discussion_count?: number
  // 智能练习
  pending_practice_count?: number
  completed_practice_count?: number
  // 错题本
  wrong_exam_count?: number
  // 知识闯关
  quest_completed_count?: number
  quest_score?: number
  // 知识抢答
  quick_quiz_participated?: number
  quick_quiz_correct?: number
  // 课程练习
  course_practice_count?: number
  course_practice_avg_accuracy?: number
  // 教师 - 智能练习
  practice_published?: number
  practice_submitted?: number
  // 共享资源
  shared_files_count?: number
  shared_resources_count?: number
  // 教师/管理员 - 分组讨论
  discussion_total?: number
  discussion_active?: number
  discussion_member_count?: number
  // 教师/管理员 - 知识闯关
  quest_total_count?: number
  quest_completed_count_t?: number
  // 教师/管理员 - 知识抢答
  quick_quiz_total?: number
  quick_quiz_ended?: number
  // 管理员专有
  online_count?: number
  recent_exams?: Array<{ id: number; title: string; status: string; created_at: string; creator_username?: string; creator_name?: string }>
}

interface Activity {
  time: string
  type: string
  title: string
  detail: string
}

const TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  exam: { color: '#1677ff', icon: <FileAddOutlined /> },
  score: { color: '#52c41a', icon: <TrophyOutlined /> },
  task: { color: '#faad14', icon: <CheckCircleOutlined /> },
  rollcall: { color: '#722ed1', icon: <AuditOutlined /> },
  quiz: { color: '#ff4d4f', icon: <ThunderboltOutlined /> },
  poll: { color: '#722ed1', icon: <BarChartOutlined /> },
  discussion: { color: '#1677ff', icon: <TeamOutlined /> },
  quest: { color: '#ff4d4f', icon: <FireOutlined /> },
  quick_quiz: { color: '#722ed1', icon: <CustomerServiceOutlined /> },
  practice: { color: '#52c41a', icon: <ExperimentOutlined /> },
  resource_view: { color: '#1677ff', icon: <EyeOutlined /> },
}

const DashboardPage: React.FC = () => {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [activities, setActivities] = useState<Activity[]>([])
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([])
  const [loading, setLoading] = useState(true)
  const [activityLoading, setActivityLoading] = useState(true)
  const [todoTotal, setTodoTotal] = useState(0)

  const { t } = useTranslation('dashboard')

  const isStudent = user?.role === 'student'
  const isTeacher = user?.role === 'teacher'
  const isAdmin = user?.role === 'admin'

  const fetchActivities = async () => {
    setActivityLoading(true)
    try {
      const { data } = await apiClient.get('/api/dashboard/recent-activity')
      setActivities(data || [])
    } catch {
      // ignore
    }
    setActivityLoading(false)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [sumRes, actRes] = await Promise.all([
          apiClient.get('/api/dashboard/summary'),
          apiClient.get('/api/dashboard/recent-activity').catch(() => ({ data: [] })),
        ])
        if (cancelled) return
        setSummary(sumRes.data)
        setActivities(Array.isArray(actRes.data) ? actRes.data : [])
        // 学生端获取任务清单总数作为徽标
        if (user?.role === 'student') {
          getTaskTodo().then(todo => {
            const total = Object.values(todo.counts).reduce((a, b) => a + b, 0)
            setTodoTotal(total)
          }).catch(() => {})
        }
      } catch { /* ignore */ }
      if (!cancelled) {
        setLoading(false)
        setActivityLoading(false)
      }
    })()
    notificationsApi.getAnnouncements(1, 5).then((data) => {
      if (!cancelled) setAnnouncements(data.announcements || [])
    }).catch(() => {})

    // 学伴初始化（学生用户）
    if (user?.role === 'student') {
      const companionStore = useCompanionStore.getState()
      companionStore.checkMorningPush()
      companionStore.loadPushes()
    }
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <Spin size="large" description={t('loading')} />
      </div>
    )
  }

  if (!summary) {
    return <Empty description={t('loadFailed')} />
  }

  // ── 欢迎横幅 ──
  const hour = new Date().getHours()
  const timeKey = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const roleKey = isStudent ? 'student' : isTeacher ? 'teacher' : 'admin'
  const roleLabel = t(`welcome.${roleKey}`)

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* ─── 欢迎横幅 ─── */}
      <Card
        size="small"
        style={{
          marginBottom: 20,
          background: 'linear-gradient(135deg, #1677ff 0%, #0958d9 100%)',
          borderRadius: 8,
          border: 'none',
        }}
        styles={{ body: { padding: '10px 20px' } }}
      >
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap' }}>
            {t('welcome.greeting', { time: t(`welcome.${timeKey}`), name: summary.user_name, role: roleLabel })}
          </span>
          {isStudent && summary.title_name && (
            <Tag style={{ fontSize: 13, padding: '0 10px', borderRadius: 10, margin: 0 }}
              color={summary.title_color !== 'default' ? summary.title_color : undefined}>
              {summary.title_emoji} {summary.title_name}
            </Tag>
          )}
          <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, whiteSpace: 'nowrap' }}>
            {isStudent ? t('welcome.studentPrompt') : t('welcome.teacherPrompt')}
          </span>
          {isStudent && (
            <span style={{ marginLeft: 'auto', fontSize: 14, color: '#fff', whiteSpace: 'nowrap' }}>
              <TrophyOutlined style={{ marginRight: 4 }} />
              {t('welcome.score')} <Text strong style={{ color: '#fff', fontSize: 18 }}>{summary.total_score ?? 0}</Text>
              <Text style={{ color: 'rgba(255,255,255,0.7)', marginLeft: 8, fontSize: 13 }}>
                · {t('welcome.rank')} {summary.rank ?? '-'}
              </Text>
              {summary.title_name && summary.next_title_name && (
                <Progress
                  percent={summary.title_progress ?? 0}
                  size="small"
                  strokeColor="#fff"
                  trailColor="rgba(255,255,255,0.3)"
                  format={() => ''}
                  style={{ width: 80, display: 'inline-flex', marginLeft: 8, verticalAlign: 'middle' }}
                />
              )}
              <Text style={{ color: 'rgba(255,255,255,0.3)', margin: '0 8px' }}>|</Text>
              <Button
                size="small"
                type="text"
                style={{ color: '#fff', padding: 0 }}
                icon={<span>📋</span>}
                onClick={() => navigate('/task-todo')}
              >
                {t('welcome.taskList')}
                <Tag style={{ marginLeft: 4, fontSize: 10, borderRadius: 8, background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', lineHeight: '16px' }}>
                  {todoTotal || (summary.pending_exam_count ?? 0) + (summary.active_task_count ?? 0) + (summary.active_quiz_count ?? 0) + (summary.pending_practice_count ?? 0) + (summary.shared_files_count ?? 0)}
                </Tag>
              </Button>
              <Text style={{ color: 'rgba(255,255,255,0.3)', margin: '0 8px' }}>|</Text>
              <Button
                size="small"
                type="text"
                style={{ color: '#fff', padding: 0 }}
                icon={<span>🧠</span>}
                onClick={() => navigate('/chat?companion=1')}
              >
                {t('welcome.aiCompanion')}
              </Button>
            </span>
          )}
          {isTeacher && summary.teacher_grades && (
            <span style={{ marginLeft: 'auto', fontSize: 13, color: 'rgba(255,255,255,0.9)' }}>
              <TeamOutlined /> {summary.teacher_grades} · {summary.teacher_classes}{t('classUnit')}
            </span>
          )}
          {isTeacher && summary.teacher_subjects && summary.teacher_subjects.length > 0 && (
            <span style={{ marginLeft: 12, fontSize: 13, color: 'rgba(255,255,255,0.9)' }}>
              <ExperimentOutlined style={{ marginRight: 4 }} />
              {t('welcome.teaching')}{summary.teacher_subjects.join('、')}
            </span>
          )}
        </div>
      </Card>

      {/* ─── 统计卡片（整合为每行 4 个） ─── */}
      {isStudent ? (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={12} sm={6} md={6}>
              <Card hoverable onClick={() => navigate('/exam')} size="small">
                <Statistic
                  title={t('stats.exam')}
                  value={`${summary.completed_exam_count ?? 0}/${summary.pending_exam_count ?? 0}`}
                  prefix={<FileAddOutlined style={{ color: '#1677ff' }} />}
                  suffix={<Text type="secondary" style={{ fontSize: 12 }}>{t('stats.examSuffix', { done: summary.completed_exam_count ?? 0, pending: summary.pending_exam_count ?? 0, wrong: summary.wrong_exam_count ?? 0 })}</Text>}
                  styles={{ content: { color: '#1677ff', fontSize: 22 } }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6} md={6}>
              <Card hoverable onClick={() => navigate('/score')} size="small">
                <Statistic
                  title={t('stats.score')}
                  value={summary.total_score ?? 0}
                  prefix={<TrophyOutlined style={{ color: '#faad14' }} />}
                  suffix={<Text type="secondary" style={{ fontSize: 12 }}>{t('stats.scoreSuffix', { rank: summary.rank ?? '-', count: summary.active_task_count ?? 0 })}</Text>}
                  styles={{ content: { color: '#faad14', fontSize: 22 } }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6} md={6}>
              <Card hoverable onClick={() => navigate('/interaction')} size="small">
                <Statistic
                  title={t('stats.interaction')}
                  value={(summary.active_quiz_count ?? 0) + (summary.pending_practice_count ?? 0)}
                  prefix={<ThunderboltOutlined style={{ color: '#ff4d4f' }} />}
                  suffix={<Text type="secondary" style={{ fontSize: 12 }}>{t('stats.interactionSuffix', { quiz: summary.active_quiz_count ?? 0, practice: summary.pending_practice_count ?? 0 })}</Text>}
                  styles={{ content: { color: '#ff4d4f', fontSize: 22 } }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6} md={6}>
              <Card hoverable onClick={() => navigate('/quest')} size="small">
                <Statistic
                  title={t('stats.quest')}
                  value={summary.quest_completed_count ?? 0}
                  prefix={<FireOutlined style={{ color: '#ff4d4f' }} />}
                  suffix={<Text type="secondary" style={{ fontSize: 12 }}>{t('stats.questSuffix', { quest: summary.quest_completed_count ?? 0, quick: summary.quick_quiz_participated ?? 0 })}</Text>}
                  styles={{ content: { color: '#ff4d4f', fontSize: 22 } }}
                />
              </Card>
            </Col>
          </Row>
        </>
      ) : (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={12} sm={6} md={6}>
            <Card hoverable onClick={() => navigate('/exam')} size="small">
              <Statistic
                title={t('stats.examManage')}
                value={summary.exam_stats?.total ?? 0}
                prefix={<FileAddOutlined style={{ color: '#1677ff' }} />}
                suffix={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('stats.examManageSuffix', { draft: summary.exam_stats?.draft ?? 0, published: summary.exam_stats?.published ?? 0, ended: summary.exam_stats?.ended ?? 0 })}
                  </Text>
                }
                styles={{ content: { color: '#1677ff', fontSize: 22 } }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={6}>
            <Card hoverable onClick={() => navigate(isAdmin ? '/user-mgmt' : '/score')} size="small">
              <Statistic
                title={t('stats.teachingOverview')}
                value={summary.total_students ?? 0}
                prefix={<TeamOutlined style={{ color: '#722ed1' }} />}
                suffix={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {isAdmin ? t('stats.teachingOverviewSuffix', { teachers: summary.total_teachers ?? 0, submissions: summary.total_submissions ?? 0, rollcall: summary.rollcall_this_week ?? 0 }) : t('stats.teachingOverviewSuffixTeacher', { submissions: summary.total_submissions ?? 0, rollcall: summary.rollcall_this_week ?? 0 })}
                  </Text>
                }
                styles={{ content: { color: '#722ed1', fontSize: 22 } }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={6}>
            <Card hoverable onClick={() => navigate('/interaction')} size="small">
              <Statistic
                title={t('stats.classActivity')}
                value={(summary.teacher_quiz_count ?? 0) + (summary.practice_published ?? 0)}
                prefix={<ThunderboltOutlined style={{ color: '#ff4d4f' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>{t('stats.classActivitySuffix', { quiz: summary.teacher_quiz_count ?? 0, practice: summary.practice_published ?? 0, questions: summary.teacher_question_count ?? 0, answers: summary.teacher_student_answer_count ?? 0 })}</Text>}
                styles={{ content: { color: '#ff4d4f', fontSize: 22 } }}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6} md={6}>
            <Card hoverable onClick={() => navigate('/quest')} size="small">
              <Statistic
                title={t('stats.funChallenge')}
                value={summary.quest_total_count ?? 0}
                prefix={<FireOutlined style={{ color: '#ff4d4f' }} />}
                suffix={<Text type="secondary" style={{ fontSize: 12 }}>{t('stats.funChallengeSuffix', { total: summary.quest_total_count ?? 0, done: summary.quest_completed_count_t ?? 0, quizTotal: summary.quick_quiz_total ?? 0, quizEnded: summary.quick_quiz_ended ?? 0 })}</Text>}
                styles={{ content: { color: '#ff4d4f', fontSize: 22 } }}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Row gutter={[16, 16]}>
        {/* ─── 左侧：待办/考试列表 ─── */}
        <Col xs={24} lg={14}>
          {isStudent && summary.pending_exams && summary.pending_exams.length > 0 && (
            <Card
              title={<Space><ClockCircleOutlined style={{ color: '#faad14' }} />{t('pendingExams')}</Space>}
              style={{ marginBottom: 16 }}
              extra={
                <Button type="link" onClick={() => navigate('/exam')}>
                  {t('viewAll')} <RightOutlined />
                </Button>
              }
            >
              <List
                dataSource={summary.pending_exams}
                renderItem={(exam) => (
                  <List.Item
                    actions={[
                      <Button
                        type="primary"
                        size="small"
                        onClick={() => navigate(`/exam-take/${exam.id}`)}
                      >
                        {t('startExam')}
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<ExperimentOutlined style={{ fontSize: 20, color: '#1677ff' }} />}
                      title={exam.title}
                      description={
                        <Space size={16}>
                          <Tag>{exam.subject}</Tag>
                          <Text type="secondary">{t('duration', { minutes: exam.duration })}</Text>
                          <Text type="secondary">{t('points', { score: exam.total_score })}</Text>
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}

          {/* ── 教师：在线状态 + 最近考试 ── */}
          {isTeacher && (
            <>
              <Card size="small" style={{ marginBottom: 16 }}>
                <Space>
                  <Statistic
                    title={t('todayChat')}
                    value={summary.today_chat_count ?? 0}
                    prefix={<MessageOutlined style={{ color: '#13c2c2' }} />}
                    styles={{ content: { color: '#13c2c2', fontSize: 20 } }}
                  />
                  <Statistic
                    title={t('thisWeekRollcall')}
                    value={summary.rollcall_this_week ?? 0}
                    prefix={<AuditOutlined style={{ color: '#fa8c16' }} />}
                    styles={{ content: { color: '#fa8c16', fontSize: 20 } }}
                  />
                </Space>
              </Card>
              {summary.recent_exams && summary.recent_exams.length > 0 && (
                <Card
                  title={<Space><FileAddOutlined style={{ color: '#1677ff' }} />{t('recentCreatedExams')}</Space>}
                  size="small"
                  style={{ marginBottom: 16 }}
                  extra={
                    <Button type="link" size="small" onClick={() => navigate('/exam')}>
                      {t('manage')} <RightOutlined />
                    </Button>
                  }
                >
                  <List
                    size="small"
                    dataSource={summary.recent_exams}
                    renderItem={(exam) => {
                      const statusMap: Record<string, { label: string; color: string }> = {
                        draft: { label: t('draft'), color: 'default' },
                        published: { label: t('published'), color: 'green' },
                        ended: { label: t('ended'), color: 'red' },
                      }
                      const s = statusMap[exam.status] || { label: exam.status, color: 'default' }
                      return (
                        <List.Item>
                          <List.Item.Meta
                            title={<Text style={{ fontSize: 13 }}>{exam.title}</Text>}
                            description={
                              <Space size={8}>
                                <Tag color={s.color} style={{ fontSize: 11 }}>{s.label}</Tag>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {exam.created_at?.slice(0, 10)}
                                </Text>
                              </Space>
                            }
                          />
                        </List.Item>
                      )
                    }}
                  />
                </Card>
              )}
            </>
          )}

          {/* 学生：近期考试成绩 */}
          {isStudent && summary.exam_results && summary.exam_results.length > 0 && (
            <Card
              title={<Space><BarChartOutlined style={{ color: '#1677ff' }} />{t('recentScores')}</Space>}
              style={{ marginBottom: 16 }}
              extra={
                <Button type="link" onClick={() => navigate('/exam')}>
                  {t('viewAll')} <RightOutlined />
                </Button>
              }
            >
              <List
                dataSource={summary.exam_results}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      title={item.title}
                      description={
                        <Space>
                          <Text>
                            {t('score')}
                            <Text strong style={{ color: item.passed ? '#52c41a' : '#ff4d4f' }}>
                              {item.score} / {item.total_score}
                            </Text>
                          </Text>
                          <Tag color={item.passed ? 'green' : 'red'}>
                            {item.passed ? t('passed') : t('failed')}
                          </Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {item.submitted_at ? new Date(item.submitted_at).toLocaleString('zh-CN') : ''}
                          </Text>
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}

          {/* ── 管理员：在线状态 + 最近考试 ── */}
          {isAdmin && (
            <>
              <Card size="small" style={{ marginBottom: 16 }}>
                <Space>
                  <Statistic
                    title={t('currentOnline')}
                    value={summary.online_count ?? 0}
                    prefix={<TeamOutlined style={{ color: '#52c41a' }} />}
                    styles={{ content: { color: '#52c41a', fontSize: 20 } }}
                  />
                  <Statistic
                    title={t('todayChat')}
                    value={summary.today_chat_count ?? 0}
                    prefix={<MessageOutlined style={{ color: '#13c2c2' }} />}
                    styles={{ content: { color: '#13c2c2', fontSize: 20 } }}
                  />
                </Space>
              </Card>
              {summary.recent_exams && summary.recent_exams.length > 0 && (
                <Card
                  title={<Space><FileAddOutlined style={{ color: '#1677ff' }} />{t('recentCreatedExams')}</Space>}
                  size="small"
                  style={{ marginBottom: 16 }}
                  extra={
                    <Button type="link" size="small" onClick={() => navigate('/exam')}>
                      {t('manage')} <RightOutlined />
                    </Button>
                  }
                >
                  <List
                    size="small"
                    dataSource={summary.recent_exams}
                    renderItem={(exam) => {
                      const statusMap: Record<string, { label: string; color: string }> = {
                        draft: { label: t('draft'), color: 'default' },
                        published: { label: t('published'), color: 'green' },
                        ended: { label: t('ended'), color: 'red' },
                      }
                      const s = statusMap[exam.status] || { label: exam.status, color: 'default' }
                      return (
                        <List.Item>
                          <List.Item.Meta
                            title={<Text style={{ fontSize: 13 }}>{exam.title}</Text>}
                            description={
                              <Space size={8}>
                                <Tag color={s.color} style={{ fontSize: 11 }}>{s.label}</Tag>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {exam.creator_name || exam.creator_username || ''}
                                </Text>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {exam.created_at?.slice(0, 10)}
                                </Text>
                              </Space>
                            }
                          />
                        </List.Item>
                      )
                    }}
                  />
                </Card>
              )}
            </>
          )}

          {/* 系统公告 */}
          {announcements.length > 0 && (
            <Card
              title={<Space><BellOutlined style={{ color: '#fa8c16' }} />{t('announcements')}</Space>}
              style={{ marginBottom: 16 }}
              size="small"
              extra={
                <Button type="link" onClick={() => navigate('/announcements')}>
                  {t('viewAll')} <RightOutlined />
                </Button>
              }
            >
              <List
                size="small"
                dataSource={announcements.slice(0, 3)}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      title={
                        <Space>
                          {item.is_pinned && <BellOutlined style={{ color: '#fa8c16', fontSize: 12 }} />}
                          <Text strong style={{ fontSize: 13 }}>{item.title}</Text>
                          <Tag color={item.priority === 'urgent' ? 'red' : item.priority === 'important' ? 'orange' : 'blue'} style={{ fontSize: 10, lineHeight: '16px' }}>
                            {item.priority === 'urgent' ? t('urgent') : item.priority === 'important' ? t('important') : t('normal')}
                          </Tag>
                        </Space>
                      }
                      description={
                        <Paragraph
                          ellipsis={{ rows: 2 }}
                          type="secondary"
                          style={{ fontSize: 12, margin: 0 }}
                        >
                          {item.content}
                        </Paragraph>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}

          {/* 快捷导航 */}
          <Card size="small" title={<Space><ThunderboltOutlined style={{ color: '#faad14' }} />{t('quickNav')}</Space>}>
            <Row gutter={[8, 8]}>
              {isStudent ? (
                <>
                  <Col span={8}><Button size="small" block icon={<MessageOutlined />} onClick={() => navigate('/chat')}>{t('aiChat')}</Button></Col>
                  <Col span={8}><Button size="small" block icon={<FileAddOutlined />} onClick={() => navigate('/exam')}>{t('onlineExam')}</Button></Col>
                  <Col span={8}><Button size="small" block icon={<TeamOutlined />} onClick={() => navigate('/discussion')}>{t('groupDiscussion')}</Button></Col>
                </>
              ) : (
                <>
                  <Col span={6}><Button size="small" block icon={<MessageOutlined />} onClick={() => navigate('/chat')}>{t('aiChat')}</Button></Col>
                  <Col span={6}><Button size="small" block icon={<FileAddOutlined />} onClick={() => navigate('/exam')}>{t('examPublish')}</Button></Col>
                  <Col span={6}><Button size="small" block icon={<AuditOutlined />} onClick={() => navigate('/rollcall')}>{t('smartRollcall')}</Button></Col>
                  <Col span={6}><Button size="small" block icon={<TeamOutlined />} onClick={() => navigate('/discussion')}>{t('groupDiscussion')}</Button></Col>
                </>
              )}
            </Row>
          </Card>
        </Col>

        {/* ─── 右侧：最近动态时间线 ─── */}
        <Col xs={24} lg={10}>
          <Card
            title={<Space><ClockCircleOutlined />{t('recentActivity')}</Space>}
            extra={
              <Button type="text" icon={<ReloadOutlined />} onClick={fetchActivities} />
            }
            style={{ height: 500 }}
            styles={{ body: { height: 450, overflow: 'auto' } }}
          >
            {activityLoading ? (
              <Spin style={{ display: 'block', margin: '40px auto' }} />
            ) : activities.length === 0 ? (
              <Empty description={t('noActivity')} />
            ) : (
              <Timeline
                items={activities.slice(0, 30).map((act) => ({
                  color: TYPE_CONFIG[act.type]?.color || '#999',
                  content: (
                    <div>
                      <Space>
                        {TYPE_CONFIG[act.type]?.icon}
                        <Text strong>{act.title}</Text>
                      </Space>
                      {act.detail && (
                        <div>
                          <Text type="secondary" style={{ fontSize: 12 }}>{act.detail}</Text>
                        </div>
                      )}
                      <div>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {act.time ? new Date(act.time).toLocaleString('zh-CN') : ''}
                        </Text>
                      </div>
                    </div>
                  ),
                }))}
              />
            )}
          </Card>
        </Col>
      </Row>
    </Card>
  )
}

export default DashboardPage
