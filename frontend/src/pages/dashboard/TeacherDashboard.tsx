/** 教师/管理员首页看板：待办驱动 + 班级亮点 */
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, Col, Empty, Row, Space, Tag, Typography } from 'antd'
import {
  AuditOutlined, FileAddOutlined, FireOutlined, TeamOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import { getTeacherTodo, type TeacherTodo } from '../../api/dashboard'
import { useDashboardData } from './useDashboardData'
import { useChartTheme } from './chartTheme'
import WelcomeBanner from './WelcomeBanner'
import TrendCard from './TrendCard'
import AnnouncementsCard from './AnnouncementsCard'
import QuickActionsCard from './QuickActionsCard'
import ActivityTimelineCard from './ActivityTimelineCard'
import TeacherTodoBar from './TeacherTodoBar'
import ClassStarsCard from './ClassStarsCard'
import DailyQuoteCard from './DailyQuoteCard'
import { reportLoadError } from '../../utils/loadError'
import DashboardSkeleton from './DashboardSkeleton'
import StatCard from './StatCard'
import './dashboard.css'

const { Text } = Typography

/**
 * 考试状态：分段条 + 逐行数字。
 *
 * 原来是饼图 + 下方三个 Tag：同一组数字在卡内说两遍、又与上方"已发布考试"卡重复，
 * 而且饼图对"3 类状态"这种一维构成并不比条形好读。分段条把"构成"和"数量"合到一处，
 * 宽度带补间动画，刷新时能看见结构在变。
 */
const SegmentBar: React.FC<{
  parts: { label: string; value: number; color: string }[]
  emptyText: string
}> = ({ parts, emptyText }) => {
  const total = parts.reduce((a, p) => a + p.value, 0)
  if (total <= 0) {
    return <div style={{ textAlign: 'center', padding: '64px 0', color: 'rgba(128,128,128,0.85)', fontSize: 12 }}>{emptyText}</div>
  }
  return (
    <div style={{ padding: '6px 12px 0' }}>
      <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: 'rgba(128,128,128,0.14)' }}>
        {parts.filter((p) => p.value > 0).map((p) => (
          <div
            key={p.label} className="dash-bar-fill" title={`${p.label} ${p.value}`}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
          />
        ))}
      </div>
      <div className="dash-stagger" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {parts.map((p) => (
          <div key={p.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{p.value}</strong>
            <span style={{ width: 40, textAlign: 'right', color: 'rgba(128,128,128,0.9)' }}>
              {Math.round((p.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

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

  if (loading) return <DashboardSkeleton />
  if (!summary) return <Empty description={t('loadFailed')} />

  const ongoing = (todo?.active_quizzes ?? 0) + (todo?.active_quick_quiz_rooms ?? 0)
    + (todo?.active_discussions ?? 0) + (todo?.active_polls ?? 0) + (todo?.active_tasks ?? 0)
    + (todo?.in_progress_exam_count ?? 0)
  const pendingTotal = (todo?.pending_exam_grading ?? 0) + (todo?.pending_task_grades ?? 0)
    + (todo?.pending_questions ?? 0) + (todo?.pending_answer_reviews ?? 0)

  const examStats = summary.exam_stats

  // 聚合卡的数字含多类待办，跳转要落到“当前确实有事可做”的那一类，不能永远只去考试中心
  const pendingTarget = (todo?.pending_exam_grading ?? 0) > 0 ? '/exam?grading=pending'
    : (todo?.pending_task_grades ?? 0) > 0 ? '/tasks?grading=pending'
    : (todo?.pending_questions ?? 0) + (todo?.pending_answer_reviews ?? 0) > 0 ? '/student-questions'
    : '/exam?grading=pending'
  const ongoingTarget = (todo?.active_quizzes ?? 0) > 0 ? '/interaction'
    : (todo?.active_quick_quiz_rooms ?? 0) > 0 ? '/quick-quiz'
    : (todo?.active_discussions ?? 0) > 0 ? '/discussion'
    : (todo?.active_polls ?? 0) > 0 ? '/quick-poll'
    : (todo?.active_tasks ?? 0) > 0 ? '/tasks'
    : '/exam'

  return (
    <div>
      <WelcomeBanner summary={summary} todoTotal={pendingTotal} isStudent={false} isTeacher={!isAdmin} isAdmin={isAdmin} />

      <TeacherTodoBar data={todo} />

      {/* 关键数字 */}
      <Row gutter={[16, 16]} className="dash-stagger" style={{ marginBottom: 16 }}>
        <StatCard
          title={t('statsT.examManage')} value={examStats?.published ?? 0} color={ct.primary}
          icon={<FileAddOutlined />} onGo={() => navigate('/exam')}
          parts={[
            (examStats?.draft ?? 0) > 0 && t('statsT.unitDraft', { n: examStats?.draft ?? 0 }),
            (examStats?.ended ?? 0) > 0 && t('statsT.unitEnded', { n: examStats?.ended ?? 0 }),
          ]}
        />
        <StatCard
          title={t('statsT.pending')} value={pendingTotal}
          color={pendingTotal > 0 ? ct.danger : ct.success}
          icon={<AuditOutlined />} onGo={() => navigate(pendingTarget)}
          parts={[
            (todo?.pending_exam_grading ?? 0) > 0 && t('statsT.unitPapers', { n: todo?.pending_exam_grading ?? 0 }),
            (todo?.pending_exam_grading_exams ?? 0) > 0 && t('statsT.unitExams', { n: todo?.pending_exam_grading_exams ?? 0 }),
            (todo?.pending_task_grades ?? 0) > 0 && t('statsT.unitTasks', { n: todo?.pending_task_grades ?? 0 }),
            ((todo?.pending_questions ?? 0) + (todo?.pending_answer_reviews ?? 0)) > 0
              && t('statsT.unitQuestions', { n: (todo?.pending_questions ?? 0) + (todo?.pending_answer_reviews ?? 0) }),
          ]}
          emptyText={t('statsT.pendingClear')}
        />
        <StatCard
          title={t('statsT.ongoing')} value={ongoing} color={ct.warning}
          icon={<ThunderboltOutlined />} onGo={() => navigate(ongoingTarget)}
          parts={[
            (todo?.active_quizzes ?? 0) > 0 && t('statsT.unitQuizzes', { n: todo?.active_quizzes ?? 0 }),
            (todo?.active_quick_quiz_rooms ?? 0) > 0 && t('statsT.unitQuick', { n: todo?.active_quick_quiz_rooms ?? 0 }),
            (todo?.active_tasks ?? 0) > 0 && t('statsT.unitHomework', { n: todo?.active_tasks ?? 0 }),
            (todo?.in_progress_exam_count ?? 0) > 0 && t('statsT.unitLiveExams', { n: todo?.in_progress_exam_count ?? 0 }),
          ]}
        />
        <StatCard
          title={t('statsT.students')} value={summary.total_students ?? 0} color={ct.purple}
          icon={<TeamOutlined />} onGo={() => navigate(isAdmin ? '/user-mgmt' : '/score')}
        />
      </Row>

      {/* 数据看板 */}
      <Row gutter={[16, 16]} className="dash-stagger" style={{ marginBottom: 16 }}>
        <Col xs={24} lg={10}><TrendCard /></Col>
        <Col xs={24} md={12} lg={6}>
          <Card size="small" style={{ height: '100%' }}
            title={<Text style={{ fontSize: 13 }}>{t('chart.examStatus')}</Text>}
            styles={{ body: { padding: '0 4px 8px', minHeight: 226 } }}>
            <SegmentBar
              emptyText={t('chart.noTeachingData')}
              parts={[
                { label: t('published'), value: examStats?.published ?? 0, color: '#52c41a' },
                { label: t('ended'), value: examStats?.ended ?? 0, color: '#ff7a45' },
                { label: t('draft'), value: examStats?.draft ?? 0, color: '#bfbfbf' },
              ]}
            />
          </Card>
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
