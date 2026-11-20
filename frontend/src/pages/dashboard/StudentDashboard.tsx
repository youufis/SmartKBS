/** 学生端首页看板 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Col, Empty, Row } from 'antd'
import {
  CheckCircleOutlined, FireOutlined, RiseOutlined, TrophyOutlined,
} from '@ant-design/icons'
import { computeTodayDone, computeTodayMust, computeWeeklyDone, pickEncouragement } from './encourage'
import { getTaskTodo, type TaskTodoResponse } from '../../api/taskTodo'
import { useCompanionStore } from '../../stores/companionStore'
import { useDashboardData } from './useDashboardData'
import { useAutoRefresh } from './useAutoRefresh'
import { useNow } from './useNow'
import RefreshHint from './RefreshHint'
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

const StudentDashboard: React.FC = () => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const { summary, activities, announcements, loading, activityLoading, activityError, fetchActivities, refresh, refreshing, updatedAt } = useDashboardData()
  const [todo, setTodo] = useState<TaskTodoResponse | null>(null)
  const [todoLoading, setTodoLoading] = useState(true)

  const fetchTodo = useCallback(() => {
    getTaskTodo().then((d) => {
      setTodo(d)
      setTodoLoading(false)
    }).catch((err) => {
      reportLoadError(err, { key: 'dashboard.StudentTodo' })
      setTodoLoading(false)
    })
  }, [])

  useEffect(() => {
    fetchTodo()
    // 学伴初始化（问候推送 + 留言列表）
    const companionStore = useCompanionStore.getState()
    companionStore.checkMorningPush()
    companionStore.loadPushes()
  }, [fetchTodo])
  useAutoRefresh(fetchTodo)

  // 逾期/紧急随时间走动（原来在数据回调里算一次，长开页面冻结）
  const now = useNow()
  /** 降噪口径（与任务清单一致）：今天要做 N / 本周完成 X / 鼓励句 */
  const todayMust = useMemo(() => (todo ? computeTodayMust(todo.items, now) : 0), [todo, now])
  const weekly = useMemo(() => computeWeeklyDone(todo, now), [todo, now])
  const todayDone = useMemo(() => computeTodayDone(todo, now), [todo, now])
  const enc = useMemo(() => (todo && summary ? pickEncouragement({
    todayMust,
    activeTotal: todo.items.filter((i) => i.status !== 'completed').length,
    weeklyDone: weekly.thisWeek,
    streak: summary.streak_days ?? 0,
    titleProgress: summary.title_progress ?? 0,
    nextTitle: summary.next_title_name,
    wrongPending: summary.wrong_book_pending ?? 0,
    wrongTotal: summary.wrong_book_total ?? 0,
    approvedAnswers: summary.my_approved_answers_count ?? 0,
  }) : null), [todo, summary, todayMust, weekly])

  if (loading) return <DashboardSkeleton isStudent />
  if (!summary) return (
    <Empty description={t('loadFailed')}>
      <Button type="primary" onClick={refresh}>{t('retry')}</Button>
    </Empty>
  )

  const todoTotal = todo ? Object.values(todo.counts ?? {}).reduce((a, b) => a + b, 0) : 0

  return (
    <div>
      <WelcomeBanner summary={summary} todoTotal={todoTotal} isStudent isTeacher={false} isAdmin={false} />
      <RefreshHint updatedAt={updatedAt} refreshing={refreshing} onRefresh={refresh} />

      {/* 今日要事 + "我的进展"四卡（2×2）占左列，成长档案占右列：
          四卡上移填掉"今日要事只露 3 行"后的大块空白，左右两列高度自然对齐 */}
      <Row gutter={[16, 16]} align="top" className="dash-stagger" style={{ marginBottom: 16 }}>
        <Col xs={24} lg={16}>
          <TodoFocusCard todo={todo} loading={todoLoading} todayMust={todayMust} enc={enc} />
          <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
            {/* 今日完成：与"今天要做 N 项"徽标形成投入→产出闭环，不再重复库存数 */}
            <StatCard
              span={{ xs: 12, md: 12, lg: 12 }}
              title={t('statsS2.todayDone')} value={todayDone} zeroText={t('statsS2.todayDoneZero')}
              color={ct.primary} icon={<CheckCircleOutlined />} onGo={() => navigate('/task-todo?tab=done')}
            />
            <StatCard
              span={{ xs: 12, md: 12, lg: 12 }}
              title={t('statsS2.weekDone')} value={weekly.thisWeek} zeroText={t('statsS2.weekDoneZero')}
              parts={[weekly.deltaVsLastWeek > 0 && t('statsS2.weekVs', { n: weekly.deltaVsLastWeek })]}
              color={ct.success} icon={<RiseOutlined />} onGo={() => navigate('/task-todo')}
            />
            <StatCard
              span={{ xs: 12, md: 12, lg: 12 }}
              title={t('statsS2.streak')} value={summary.streak_days ?? 0} zeroText={t('statsS2.streakZero')}
              parts={[(summary.streak_days ?? 0) > 0 && t('statsS2.streakDayUnit')]}
              color={ct.warning} icon={<FireOutlined />} onGo={() => navigate('/task-todo?simple=1')}
            />
            <StatCard
              span={{ xs: 12, md: 12, lg: 12 }}
              title={t('statsS2.title')}
              textValue={`${summary.title_emoji ?? '🏅'} ${summary.title_name || t('statsS2.titleNone')}`}
              progress={summary.title_progress ?? 0}
              parts={[summary.next_title_name
                ? t('statsS2.titleGap', { next: summary.next_title_name, p: Math.max(1, 100 - (summary.title_progress ?? 0)) })
                : t('statsS2.titleMax')]}
              tip={t('statsS2.badgesTip', { a: summary.badges_unlocked ?? 0, b: summary.badges_total ?? 0 })}
              color={ct.gold} icon={<TrophyOutlined />} onGo={() => navigate('/score')}
            />
          </Row>
        </Col>
        <Col xs={24} lg={8}>
          <GrowthCard summary={summary} />
        </Col>
      </Row>

      {/* 数据看板：三张卡等宽。雷达图原来只有 1/4 宽，四个轴标签挤在一起、图形缩成小三角 */}
      <Row gutter={[16, 16]} className="dash-stagger" style={{ marginBottom: 16 }}>
        <Col xs={24} lg={8}><TrendCard /></Col>
        <Col xs={24} md={12} lg={8}><AbilityRadarCard summary={summary} /></Col>
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
            {/* 每日一句上移到侧栏首位（用户反馈垫底不合适）：与左列今日要事顶部对齐，学伴、动态随后 */}
            <DailyQuoteCard />
            <CompanionCard />
            <ActivityTimelineCard activities={activities} loading={activityLoading} error={activityError} onRefresh={fetchActivities} />
          </div>
        </Col>
      </Row>
    </div>
  )
}

export default StudentDashboard
