import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Card, Row, Col, Statistic, Typography, Spin, List, Tag, Space,
  Timeline, Button, Empty, Progress,
} from 'antd'
import { BarChart, Bar, XAxis, YAxis, Tooltip, Cell, PieChart, Pie, ResponsiveContainer,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Legend, AreaChart, Area } from 'recharts'
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

      {/* ─── 统计卡片 ─── */}
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
          {/* 学生：图表看板 */}
          <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
            {/* 能力雷达图 */}
            <Col xs={12} md={6}>
              <Card size="small" title={<Space><RadarChart style={{ color: '#722ed1', width: 14, height: 14 }} /><Text style={{ fontSize: 13 }}>能力维度</Text></Space>} styles={{ body: { padding: '2px 2px', minHeight: 158 }, header: { padding: '6px 12px', minHeight: 0 } }}>
                <ResponsiveContainer width="100%" height={140}>
                  <RadarChart data={[
                    { d: '考试', v: Math.min(100, ((summary.completed_exam_count ?? 0) * 20 + (summary.exam_results?.length ?? 0) * 10)) },
                    { d: '互动', v: Math.min(100, ((summary.active_quiz_count ?? 0) * 15 + (summary.my_quiz_answers ?? 0) * 10 + (summary.student_poll_vote_count ?? 0) * 5)) },
                    { d: '闯关', v: Math.min(100, (summary.quest_completed_count ?? 0) * 25 + (summary.quick_quiz_correct ?? 0) * 5) },
                    { d: '练习', v: Math.min(100, ((summary.pending_practice_count ?? 0) * 10 + (summary.course_practice_avg_accuracy ?? 0))) },
                    { d: '讨论', v: Math.min(100, ((summary.my_discussion_count ?? 0) * 20 + (summary.active_discussion_count ?? 0) * 15)) },
                  ]}>
                    <PolarGrid stroke="#f0f0f0" />
                    <PolarAngleAxis dataKey="d" tick={{ fontSize: 9 }} />
                    <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                    <Radar dataKey="v" stroke="#722ed1" fill="#722ed1" fillOpacity={0.2} strokeWidth={1.5} />
                  </RadarChart>
                </ResponsiveContainer>
              </Card>
            </Col>
            {/* 考试成绩柱状图 */}
            <Col xs={12} md={6}>
              <Card size="small" title={<Space><FileAddOutlined style={{ color: '#1677ff', fontSize: 14 }} /><Text style={{ fontSize: 13 }}>{t('recentScores')}</Text></Space>} styles={{ body: { padding: '4px 2px', minHeight: 158 }, header: { padding: '6px 12px', minHeight: 0 } }}>
                {summary.exam_results && summary.exam_results.length > 0 ? (
                  <ResponsiveContainer width="100%" height={120}>
                    <BarChart data={summary.exam_results.slice(0, 6).map(r => ({
                      name: r.title.length > 6 ? r.title.slice(0, 6) + '…' : r.title,
                      score: Math.round(r.score),
                      total: Math.round(r.total_score),
                      passed: r.passed,
                    }))} margin={{ top: 8, right: 2, left: -10, bottom: 0 }}>
                      <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <Tooltip />
                      <Bar dataKey="total" fill="#e8e8e8" radius={[3, 3, 0, 0]} maxBarSize={16} />
                      <Bar dataKey="score" radius={[3, 3, 0, 0]} maxBarSize={16}>
                        {summary.exam_results.slice(0, 6).map((entry, idx) => (<Cell key={idx} fill={entry.passed ? '#52c41a' : '#ff7a45'} />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#999', fontSize: 12 }}>暂无成绩</div>
                )}
              </Card>
            </Col>
            {/* 学习活动面积图 */}
            <Col xs={12} md={6}>
              <Card size="small" title={<Space><ThunderboltOutlined style={{ color: '#ff4d4f', fontSize: 14 }} /><Text style={{ fontSize: 13 }}>学习活动</Text></Space>} styles={{ body: { padding: '4px 2px', minHeight: 158 }, header: { padding: '6px 12px', minHeight: 0 } }}>
                {(summary.active_quiz_count ?? 0) + (summary.student_poll_vote_count ?? 0) + (summary.my_questions_count ?? 0) + (summary.pending_practice_count ?? 0) + (summary.my_discussion_count ?? 0) > 0 ? (
                  <ResponsiveContainer width="100%" height={120}>
                    <AreaChart data={[
                      { name: '测验', value: summary.active_quiz_count ?? 0 },
                      { name: '投票', value: summary.student_poll_vote_count ?? 0 },
                      { name: '提问', value: summary.my_questions_count ?? 0 },
                      { name: '练习', value: summary.pending_practice_count ?? 0 },
                      { name: '讨论', value: summary.my_discussion_count ?? 0 },
                    ]} margin={{ top: 8, right: 2, left: 0, bottom: 0 }}>
                      <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} width={18} />
                      <Tooltip />
                      <Area type="monotone" dataKey="value" stroke="#ff4d4f" fill="#ff4d4f" fillOpacity={0.15} strokeWidth={2} dot={{ r: 2, fill: '#ff4d4f' }} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#ccc', fontSize: 12 }}>暂无活动数据</div>
                )}
              </Card>
            </Col>
            {/* 闯关挑战横向柱状图 */}
            <Col xs={12} md={6}>
              <Card size="small" title={<Space><FireOutlined style={{ color: '#ff4d4f', fontSize: 14 }} /><Text style={{ fontSize: 13 }}>闯关挑战</Text></Space>} styles={{ body: { padding: '4px 2px', minHeight: 158 }, header: { padding: '6px 12px', minHeight: 0 } }}>
                {(summary.quest_completed_count ?? 0) + (summary.quick_quiz_participated ?? 0) + (summary.quick_quiz_correct ?? 0) + (summary.course_practice_count ?? 0) > 0 ? (
                  <ResponsiveContainer width="100%" height={120}>
                    <BarChart data={[
                      { name: '闯关', value: summary.quest_completed_count ?? 0 },
                      { name: '抢答', value: summary.quick_quiz_participated ?? 0 },
                      { name: '正确', value: summary.quick_quiz_correct ?? 0 },
                      { name: '课程', value: summary.course_practice_count ?? 0 },
                      { name: '正确率', value: Math.round(summary.course_practice_avg_accuracy ?? 0) },
                    ]} layout="vertical" margin={{ top: 4, right: 4, left: 2, bottom: 0 }} barSize={10}>
                      <XAxis type="number" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} width={32} />
                      <Tooltip />
                      <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                        {['#ff4d4f', '#722ed1', '#52c41a', '#1677ff', '#fa8c16'].map((color, idx) => (<Cell key={idx} fill={color} />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#ccc', fontSize: 12 }}>暂无挑战数据</div>
                )}
              </Card>
            </Col>
          </Row>
        </>
      ) : (
        <>
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
          {/* 教师/管理员：图表看板 */}
          <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
            {/* 考试状态环形图 */}
            {summary.exam_stats && summary.exam_stats.total > 0 && (
              <Col xs={12} md={6}>
                <Card size="small" title={<Space><PieChart style={{ color: '#1677ff', fontSize: 14 }} /><Text style={{ fontSize: 13 }}>考试状态</Text></Space>} styles={{ body: { padding: '4px 2px', minHeight: 158 }, header: { padding: '6px 12px', minHeight: 0 } }}>
                  <ResponsiveContainer width="100%" height={95}>
                    <PieChart>
                      <Pie
                        data={[
                          { name: t('draft'), value: Math.max(summary.exam_stats.draft, 0.1), color: '#d9d9d9' },
                          { name: t('published'), value: Math.max(summary.exam_stats.published, 0.1), color: '#52c41a' },
                          { name: t('ended'), value: Math.max(summary.exam_stats.ended, 0.1), color: '#ff7a45' },
                        ]}
                        cx="50%" cy="50%"
                        innerRadius={28}
                        outerRadius={46}
                        dataKey="value"
                        paddingAngle={3}
                        strokeWidth={0}
                      >
                        <Cell fill="#d9d9d9" /><Cell fill="#52c41a" /><Cell fill="#ff7a45" />
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: 6, fontSize: 11 }}>
                    <span><Tag color="default" style={{ fontSize: 9, lineHeight: '14px', minWidth: 18, textAlign: 'center', padding: '0 3px' }}>{summary.exam_stats.draft}</Tag> 草稿</span>
                    <span><Tag color="green" style={{ fontSize: 9, lineHeight: '14px', minWidth: 18, textAlign: 'center', padding: '0 3px' }}>{summary.exam_stats.published}</Tag> 发布</span>
                    <span><Tag color="red" style={{ fontSize: 9, lineHeight: '14px', minWidth: 18, textAlign: 'center', padding: '0 3px' }}>{summary.exam_stats.ended}</Tag> 结束</span>
                  </div>
                </Card>
              </Col>
            )}
            {/* 教学概况柱状图 */}
            <Col xs={12} md={6}>
              <Card size="small" title={<Space><TeamOutlined style={{ color: '#722ed1', fontSize: 14 }} /><Text style={{ fontSize: 13 }}>教学概况</Text></Space>} styles={{ body: { padding: '4px 2px', minHeight: 158 }, header: { padding: '6px 12px', minHeight: 0 } }}>
                {(summary.total_students ?? 0) + (summary.total_submissions ?? 0) + (summary.rollcall_this_week ?? 0) + (summary.today_chat_count ?? 0) > 0 ? (
                  <ResponsiveContainer width="100%" height={120}>
                    <BarChart data={[
                      { name: '学生', value: summary.total_students ?? 0 },
                      { name: '提交', value: summary.total_submissions ?? 0 },
                      { name: '点名', value: summary.rollcall_this_week ?? 0 },
                      { name: '对话', value: summary.today_chat_count ?? 0 },
                      { name: '教师', value: summary.total_teachers ?? 0 },
                    ]} margin={{ top: 8, right: 4, left: -10, bottom: 0 }}>
                      <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <Tooltip />
                      <Bar dataKey="value" name="数量" radius={[4, 4, 0, 0]} maxBarSize={20}>
                        {['#722ed1', '#1677ff', '#fa8c16', '#13c2c2', '#52c41a'].map((color, idx) => (<Cell key={idx} fill={color} />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#ccc', fontSize: 12 }}>暂无教学数据</div>
                )}
              </Card>
            </Col>
            {/* 课堂活动面积图 */}
            <Col xs={12} md={6}>
              <Card size="small" title={<Space><ThunderboltOutlined style={{ color: '#ff4d4f', fontSize: 14 }} /><Text style={{ fontSize: 13 }}>课堂活动</Text></Space>} styles={{ body: { padding: '4px 2px', minHeight: 158 }, header: { padding: '6px 12px', minHeight: 0 } }}>
                {(summary.teacher_quiz_count ?? 0) + (summary.teacher_poll_count ?? 0) + (summary.teacher_question_count ?? 0) + (summary.teacher_student_answer_count ?? 0) + (summary.practice_published ?? 0) + (summary.discussion_total ?? 0) > 0 ? (
                  <ResponsiveContainer width="100%" height={120}>
                    <AreaChart data={[
                      { name: '测验', value: (summary.teacher_quiz_count ?? 0) + (summary.teacher_active_quiz_count ?? 0) },
                      { name: '投票', value: summary.teacher_poll_count ?? 0 },
                      { name: '提问', value: summary.teacher_question_count ?? 0 },
                      { name: '回答', value: summary.teacher_student_answer_count ?? 0 },
                      { name: '练习', value: summary.practice_published ?? 0 },
                      { name: '讨论', value: summary.discussion_total ?? 0 },
                    ]} margin={{ top: 8, right: 2, left: 0, bottom: 0 }}>
                      <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} width={18} />
                      <Tooltip />
                      <Area type="monotone" dataKey="value" stroke="#ff4d4f" fill="#ff4d4f" fillOpacity={0.15} strokeWidth={2} dot={{ r: 2, fill: '#ff4d4f' }} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#ccc', fontSize: 12 }}>暂无活动数据</div>
                )}
              </Card>
            </Col>
            {/* 趣味挑战横向柱状图 */}
            <Col xs={12} md={6}>
              <Card size="small" title={<Space><FireOutlined style={{ color: '#ff4d4f', fontSize: 14 }} /><Text style={{ fontSize: 13 }}>趣味挑战</Text></Space>} styles={{ body: { padding: '4px 2px', minHeight: 158 }, header: { padding: '6px 12px', minHeight: 0 } }}>
                {(summary.quest_total_count ?? 0) + (summary.quest_completed_count_t ?? 0) + (summary.quick_quiz_total ?? 0) + (summary.discussion_active ?? 0) > 0 ? (
                  <ResponsiveContainer width="100%" height={120}>
                    <BarChart data={[
                      { name: '闯关', value: summary.quest_total_count ?? 0 },
                      { name: '完成', value: summary.quest_completed_count_t ?? 0 },
                      { name: '抢答', value: summary.quick_quiz_total ?? 0 },
                      { name: '结束', value: summary.quick_quiz_ended ?? 0 },
                      { name: '讨论', value: summary.discussion_active ?? 0 },
                      { name: '成员', value: summary.discussion_member_count ?? 0 },
                    ]} layout="vertical" margin={{ top: 4, right: 4, left: 2, bottom: 0 }} barSize={10}>
                      <XAxis type="number" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} width={28} />
                      <Tooltip />
                      <Bar dataKey="value" name="数量" radius={[0, 3, 3, 0]}>
                        {['#ff4d4f', '#52c41a', '#722ed1', '#fa8c16', '#1677ff', '#13c2c2'].map((color, idx) => (<Cell key={idx} fill={color} />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#ccc', fontSize: 12 }}>暂无挑战数据</div>
                )}
              </Card>
            </Col>
          </Row>
        </>
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
