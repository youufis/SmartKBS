/** 教师/管理员首页看板：待办驱动 + 班级亮点 */
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, Col, Empty, Row, Space, Spin, Statistic, Tag, Typography } from 'antd'
import {
  AuditOutlined, FileAddOutlined, FireOutlined, TeamOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { getTeacherTodo, type TeacherTodo } from '../../api/dashboard'
import { useDashboardData } from './useDashboardData'
import { tooltipStyle, useChartTheme } from './chartTheme'
import WelcomeBanner from './WelcomeBanner'
import TrendCard from './TrendCard'
import AnnouncementsCard from './AnnouncementsCard'
import QuickActionsCard from './QuickActionsCard'
import ActivityTimelineCard from './ActivityTimelineCard'
import TeacherTodoBar from './TeacherTodoBar'
import ClassStarsCard from './ClassStarsCard'
import DailyQuoteCard from './DailyQuoteCard'
import { reportLoadError } from '../../utils/loadError'

const { Text } = Typography

const TeacherDashboard: React.FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const { summary, activities, announcements, loading, activityLoading, activityError, fetchActivities } = useDashboardData()
  const [todo, setTodo] = useState<TeacherTodo | null>(null)

  useEffect(() => {
    let cancelled = false
    getTeacherTodo().then((d) => { if (!cancelled) setTodo(d) }).catch((err) => { if (!cancelled) reportLoadError(err, { key: 'dashboard.TeacherTodo' }) })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <Spin size="large" description={t('loading')} />
      </div>
    )
  }
  if (!summary) return <Empty description={t('loadFailed')} />

  const ongoing = (todo?.active_quizzes ?? 0) + (todo?.active_quick_quiz_rooms ?? 0)
    + (todo?.active_discussions ?? 0) + (todo?.active_polls ?? 0) + (todo?.active_tasks ?? 0)
    + (todo?.in_progress_exam_count ?? 0)
  const pendingTotal = (todo?.pending_exam_grading ?? 0) + (todo?.pending_task_grades ?? 0)
    + (todo?.pending_questions ?? 0) + (todo?.pending_answer_reviews ?? 0)

  const examStats = summary.exam_stats

  return (
    <div>
      <WelcomeBanner summary={summary} todoTotal={0} isStudent={false} isTeacher={!isAdmin} isAdmin={isAdmin} />

      <TeacherTodoBar data={todo} />

      {/* 关键数字 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card hoverable size="small" style={{ height: '100%' }} onClick={() => navigate('/exam')}>
            <Statistic title={t('statsT.examManage')} value={examStats?.published ?? 0}
              prefix={<FileAddOutlined style={{ color: '#1677ff' }} />}
              styles={{ content: { color: '#1677ff' } }}
              suffix={<Text type="secondary" style={{ fontSize: 12, marginInlineStart: 6 }}>{t('statsT.examSuffix', { draft: examStats?.draft ?? 0, ended: examStats?.ended ?? 0 })}</Text>} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card hoverable size="small" style={{ height: '100%' }} onClick={() => navigate('/exam?grading=pending')}>
            <Statistic title={t('statsT.pending')} value={pendingTotal}
              prefix={<AuditOutlined style={{ color: pendingTotal > 0 ? '#ff4d4f' : '#52c41a' }} />}
              styles={{ content: { color: pendingTotal > 0 ? '#ff4d4f' : '#52c41a' } }}
              suffix={<Text type="secondary" style={{ fontSize: 12, marginInlineStart: 6 }}>
                {pendingTotal > 0
                  ? t('statsT.pendingSuffix', {
                    papers: todo?.pending_exam_grading ?? 0,
                    exams: todo?.pending_exam_grading_exams ?? 0,
                    tasks: todo?.pending_task_grades ?? 0,
                  })
                  : t('statsT.pendingClear')}
              </Text>} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card hoverable size="small" style={{ height: '100%' }} onClick={() => navigate('/interaction')}>
            <Statistic title={t('statsT.ongoing')} value={ongoing}
              prefix={<ThunderboltOutlined style={{ color: '#fa8c16' }} />}
              styles={{ content: { color: '#fa8c16' } }}
              suffix={<Text type="secondary" style={{ fontSize: 12, marginInlineStart: 6 }}>{t('statsT.ongoingSuffix', { quiz: todo?.active_quizzes ?? 0, quick: todo?.active_quick_quiz_rooms ?? 0 })}</Text>} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card hoverable size="small" style={{ height: '100%' }} onClick={() => navigate(isAdmin ? '/user-mgmt' : '/score')}>
            <Statistic title={t('statsT.students')} value={summary.total_students ?? 0}
              prefix={<TeamOutlined style={{ color: '#722ed1' }} />}
              styles={{ content: { color: '#722ed1' } }}
              suffix={<Text type="secondary" style={{ fontSize: 12, marginInlineStart: 6 }}>{t('statsT.studentsSuffix', { active: todo?.active_students_today ?? 0 })}</Text>} />
          </Card>
        </Col>
      </Row>

      {/* 数据看板 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={10}><TrendCard /></Col>
        <Col xs={24} md={12} lg={6}>
          {examStats && examStats.total > 0 ? (
            <Card size="small" style={{ height: '100%' }}
              title={<Text style={{ fontSize: 13 }}>{t('chart.examStatus')}</Text>}
              styles={{ body: { padding: '0 4px 4px', minHeight: 226 } }}>
              <ResponsiveContainer width="100%" height={150}>
                <PieChart>
                  <Pie
                    data={[
                      { name: t('draft'), value: Math.max(examStats.draft, 0.1) },
                      { name: t('published'), value: Math.max(examStats.published, 0.1) },
                      { name: t('ended'), value: Math.max(examStats.ended, 0.1) },
                    ]}
                    cx="50%" cy="50%" innerRadius={32} outerRadius={52} dataKey="value"
                    paddingAngle={3} strokeWidth={0}
                  >
                    <Cell fill="#d9d9d9" /><Cell fill="#52c41a" /><Cell fill="#ff7a45" />
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle(ct)} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 6, fontSize: 11, flexWrap: 'wrap' }}>
                <span><Tag color="default" style={{ fontSize: 9, lineHeight: '14px', minWidth: 18, textAlign: 'center', padding: '0 3px' }}>{examStats.draft}</Tag> {t('draft')}</span>
                <span><Tag color="green" style={{ fontSize: 9, lineHeight: '14px', minWidth: 18, textAlign: 'center', padding: '0 3px' }}>{examStats.published}</Tag> {t('published')}</span>
                <span><Tag color="orange" style={{ fontSize: 9, lineHeight: '14px', minWidth: 18, textAlign: 'center', padding: '0 3px' }}>{examStats.ended}</Tag> {t('ended')}</span>
              </div>
            </Card>
          ) : (
            <Card size="small" style={{ height: '100%' }} title={<Text style={{ fontSize: 13 }}>{t('chart.examStatus')}</Text>}>
              <div style={{ textAlign: 'center', padding: '64px 0', color: ct.empty, fontSize: 12 }}>{t('chart.noTeachingData')}</div>
            </Card>
          )}
        </Col>
        <Col xs={24} md={12} lg={8}><ClassStarsCard summary={summary} todo={todo} /></Col>
      </Row>

      {/* 主列 + 侧栏 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          {/* 最近创建的考试（管理员看全站） */}
          {(summary.recent_exams?.length ?? 0) > 0 && (
            <Card size="small"
              style={{ marginBottom: 16 }}
              title={<span style={{ fontSize: 13 }}><FireOutlined style={{ color: '#fa8c16', marginRight: 6 }} />{t('recentCreatedExams')}</span>}
              extra={<a onClick={() => navigate('/exam')}>{t('manage')} →</a>}
              styles={{ body: { padding: '2px 16px 8px' } }}
            >
              {(summary.recent_exams ?? []).map((exam, idx, arr) => {
                const statusMap: Record<string, { label: string; color: string }> = {
                  draft: { label: t('draft'), color: 'default' },
                  published: { label: t('published'), color: 'green' },
                  ended: { label: t('ended'), color: 'orange' },
                }
                const st = statusMap[exam.status] || { label: exam.status, color: 'default' }
                return (
                  <div
                    key={exam.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
                      borderBottom: idx === arr.length - 1 ? 'none' : '1px solid rgba(128,128,128,0.12)',
                    }}
                  >
                    <Text style={{ fontSize: 13, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {exam.title}
                    </Text>
                    <Space size={8} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                      <Tag color={st.color} style={{ fontSize: 11, marginInlineEnd: 0 }}>{st.label}</Tag>
                      {isAdmin && (
                        <Text type="secondary" style={{ fontSize: 11 }}>{exam.creator_name || exam.creator_username || ''}</Text>
                      )}
                      <Text type="secondary" style={{ fontSize: 11 }}>{exam.created_at?.slice(0, 10)}</Text>
                    </Space>
                  </div>
                )
              })}
            </Card>
          )}
          <AnnouncementsCard announcements={announcements} />
          <QuickActionsCard isStudent={false} isAdmin={isAdmin} />
        </Col>
        <Col xs={24} lg={8}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <DailyQuoteCard />
            <ActivityTimelineCard activities={activities} loading={activityLoading} error={activityError} onRefresh={fetchActivities} />
          </div>
        </Col>
      </Row>
    </div>
  )
}


export default TeacherDashboard
