/** 学生端首页看板 */
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, Col, Empty, Row, Typography } from 'antd'
import {
  BookOutlined, CheckCircleOutlined, FileAddOutlined, TrophyOutlined,
} from '@ant-design/icons'
import { getTaskTodo, type TaskTodoResponse } from '../../api/taskTodo'
import { useCompanionStore } from '../../stores/companionStore'
import { useDashboardData } from './useDashboardData'
import WelcomeBanner from './WelcomeBanner'
import TodoFocusCard from './TodoFocusCard'
import TrendCard from './TrendCard'
import AbilityRadarCard from './AbilityRadarCard'
import ExamScoresCard from './ExamScoresCard'
import GrowthCard from './GrowthCard'
import CompanionCard from './CompanionCard'
import AnnouncementsCard from './AnnouncementsCard'
import QuickActionsCard from './QuickActionsCard'
import ActivityTimelineCard from './ActivityTimelineCard'
import PendingExamsCard from './PendingExamsCard'
import DailyQuoteCard from './DailyQuoteCard'
import { reportLoadError } from '../../utils/loadError'
import DashboardSkeleton from './DashboardSkeleton'
import { useChartTheme } from './chartTheme'
import StatCard from './StatCard'
import './dashboard.css'

const { Text } = Typography

const StudentDashboard: React.FC = () => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const { summary, activities, announcements, loading, activityLoading, activityError, fetchActivities } = useDashboardData()
  const [todo, setTodo] = useState<TaskTodoResponse | null>(null)
  const [todoLoading, setTodoLoading] = useState(true)
  const [urgentStats, setUrgentStats] = useState({ overdue: 0, urgent: 0 })

  useEffect(() => {
    let cancelled = false
    getTaskTodo().then((d) => {
      if (cancelled) return
      setTodo(d)
      // 在数据回调里计算（避免渲染期调用 impure 的 Date.now）
      const now = Date.now()
      const withDl = d.items.filter((i) => i.status !== 'completed' && i.deadline)
        .map((i) => ({ diff: new Date(i.deadline!.replace(' ', 'T')).getTime() - now }))
      const overdue = withDl.filter((x) => x.diff < 0).length
      const urgent = withDl.filter((x) => x.diff >= 0 && x.diff < 24 * 3600000).length
      setUrgentStats({ overdue, urgent })
    }).catch((err) => { if (!cancelled) reportLoadError(err, { key: 'dashboard.StudentTodo' }) }).finally(() => {
      if (!cancelled) setTodoLoading(false)
    })
    // 学伴初始化（问候推送 + 留言列表）
    const companionStore = useCompanionStore.getState()
    companionStore.checkMorningPush()
    companionStore.loadPushes()
    return () => { cancelled = true }
  }, [])

  if (loading) return <DashboardSkeleton />
  if (!summary) return <Empty description={t('loadFailed')} />

  const todoTotal = todo ? Object.values(todo.counts ?? {}).reduce((a, b) => a + b, 0) : 0

  return (
    <div>
      <WelcomeBanner summary={summary} todoTotal={todoTotal} isStudent isTeacher={false} isAdmin={false} />

      {/* 今日要事 + 成长档案 */}
      <Row gutter={[16, 16]} className="dash-stagger" style={{ marginBottom: 16 }}>
        <Col xs={24} lg={16}>
          <TodoFocusCard todo={todo} loading={todoLoading} />
        </Col>
        <Col xs={24} lg={8}>
          <GrowthCard summary={summary} />
        </Col>
      </Row>

      {/* 关键数字 */}
      <Row gutter={[16, 16]} className="dash-stagger" style={{ marginBottom: 16 }}>
        <StatCard
          title={t('statsS.todoExams')} value={summary.pending_exam_count ?? 0} color={ct.primary}
          icon={<FileAddOutlined />} onGo={() => navigate('/exam')}
          parts={[(summary.completed_exam_count ?? 0) > 0 && t('statsS.unitDone', { n: summary.completed_exam_count ?? 0 })]}
        />
        <StatCard
          title={t('statsS.pendingTodo')} value={todoTotal} color={ct.gold}
          icon={<CheckCircleOutlined />} onGo={() => navigate('/task-todo')}
          parts={[
            urgentStats.overdue > 0 && t('statsS.unitOverdue', { n: urgentStats.overdue }),
            urgentStats.urgent > 0 && t('statsS.unitUrgent', { n: urgentStats.urgent }),
          ]}
        />
        <StatCard
          title={t('statsS.wrongPending')} value={summary.wrong_book_pending ?? 0} color={(summary.wrong_book_pending ?? 0) > 0 ? ct.danger : ct.success}
          icon={<BookOutlined />} onGo={() => navigate('/wrong-book')}
          parts={[
            (summary.wrong_book_total ?? 0) > 0 && t('statsS.unitTotal', { n: summary.wrong_book_total ?? 0 }),
            (summary.wrong_book_mastered ?? 0) > 0 && t('statsS.unitMastered', { n: summary.wrong_book_mastered ?? 0 }),
          ]}
        />
        <StatCard
          title={t('statsS.myScore')} value={summary.total_score ?? 0} color={ct.success}
          icon={<TrophyOutlined />} onGo={() => navigate('/score')}
          parts={[summary.rank ? t('statsS.unitRank', { rank: summary.rank }) : '']}
        />
      </Row>

      {/* 数据看板：真实趋势 + 能力画像 + 成绩 */}
      <Row gutter={[16, 16]} className="dash-stagger" style={{ marginBottom: 16 }}>
        <Col xs={24} lg={10}><TrendCard /></Col>
        <Col xs={24} md={12} lg={6}><AbilityRadarCard summary={summary} /></Col>
        <Col xs={24} md={12} lg={8}><ExamScoresCard summary={summary} /></Col>
      </Row>

      {/* 主列 + 侧栏 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <PendingExamsCard summary={summary} />
          <AnnouncementsCard announcements={announcements} />
          <QuickActionsCard isStudent isAdmin={false} />
        </Col>
        <Col xs={24} lg={8}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <CompanionCard />
            <DailyQuoteCard />
            <ActivityTimelineCard activities={activities} loading={activityLoading} error={activityError} onRefresh={fetchActivities} />
          </div>
        </Col>
      </Row>
    </div>
  )
}

export default StudentDashboard
