/** 教师/管理员首页看板：待办驱动 + 班级亮点 */
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, Col, Empty, Row, Space, Tag, Typography } from 'antd'
import {
  AlignLeftOutlined, AppstoreOutlined, AuditOutlined, FileAddOutlined, FireOutlined,
  PieChartOutlined, TeamOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import { getTeacherTodo, type TeacherTodo } from '../../api/dashboard'
import { useDashboardData } from './useDashboardData'
import { useChartTheme } from './chartTheme'
import { useChartVariant } from './chartVariant'
import VariantSwitch from './VariantSwitch'
import ChartEmpty from './ChartEmpty'
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
 * 考试状态：分段条 + 逐行数字，内容贴顶。
 *
 * 原来是饼图 + 下方三个 Tag：同一组数字在卡内说两遍、又与上方"已发布考试"卡重复，
 * 而且饼图对"3 类状态"这种一维构成并不比条形好读。分段条把"构成"和"数量"合到一处，
 * 宽度带补间动画，刷新时能看见结构在变。
 *
 * 后又修了两处：
 * ① 去掉 dash-center-body。卡高 226、内容只有 90，居中后上下各空 70px，内容浮在卡中间，
 *    「标题 → 内容」的视线起点没了。现在贴顶，底部用一行入口收尾。
 * ② 三行百分比原来各自四舍五入，出现 63% + 38% = 101%，合计不等于 100 会让人怀疑数据。
 *    改用最大余数法，保证合计恒为 100。
 */

/** 最大余数法分百分比：先取整，余数按小数部分从大到小补给非零项，合计必为 100 */
function percentParts(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0)
  if (total <= 0) return values.map(() => 0)
  const raw = values.map((v) => (v / total) * 100)
  const out = raw.map((v) => Math.floor(v))
  let rest = 100 - out.reduce((a, b) => a + b, 0)
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (rest <= 0) break
    // 只在真有数量的项上补，否则「草稿 0 场」会被凑成 1%
    if (values[i] > 0) { out[i] += 1; rest -= 1 }
  }
  return out
}

const EXAM_STATUS_POOL = ['segment', 'donut', 'ticks'] as const
type ExamStatusVariant = (typeof EXAM_STATUS_POOL)[number]

const STATUS_ICON: Record<ExamStatusVariant, React.ReactNode> = {
  segment: <AlignLeftOutlined />,
  donut: <PieChartOutlined />,
  ticks: <AppstoreOutlined />,
}

/** 环形半径与周长：半径定死，周长只算一次 */
const DONUT_R = 30
const DONUT_C = 2 * Math.PI * DONUT_R
/** 点阵最多画这么多格；超出的按比例合并，免得一学期几百场考试把卡片撑爆 */
const MAX_TICKS = 60

type StatusPart = { key: string; label: string; value: number; color: string }

const ExamStatusChart: React.FC<{
  variant: ExamStatusVariant
  parts: StatusPart[]
  emptyText: string
}> = ({ variant, parts, emptyText }) => {
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const total = parts.reduce((a, p) => a + p.value, 0)
  if (total <= 0) {
    return <ChartEmpty text={emptyText} />
  }
  const pcts = percentParts(parts.map((p) => p.value))

  /** donut / ticks 共用的图例：色块 + 名称 + 数量 + 百分比 */
  const legend = (
    <div className="dash-stagger" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {parts.map((p, i) => (
        <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, lineHeight: '16px' }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: p.color, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: ct.tick }}>
            {p.label}
          </span>
          <strong style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{p.value}</strong>
          <span style={{ width: 32, textAlign: 'right', color: ct.tick, fontVariantNumeric: 'tabular-nums' }}>{pcts[i]}%</span>
        </div>
      ))}
    </div>
  )

  if (variant === 'donut') {
    // 每段的起点用「前面所有段之和」直接算，不引入累加变量（render 期改外部变量是反模式）
    const visible = parts.filter((p) => p.value > 0)
    const arcs = visible.map((p, i) => {
      const len = (p.value / total) * DONUT_C
      const start = visible.slice(0, i).reduce((sum, q) => sum + (q.value / total) * DONUT_C, 0)
      return { key: p.key, color: p.color, len, start }
    })
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 12px 4px' }}>
        <div style={{ position: 'relative', width: 82, height: 82, flexShrink: 0 }}>
          <svg width={82} height={82} viewBox="0 0 82 82" aria-hidden>
            <circle cx={41} cy={41} r={DONUT_R} fill="none" stroke={ct.track} strokeWidth={11} />
            {arcs.map((a) => (
              <circle
                key={a.key} cx={41} cy={41} r={DONUT_R} fill="none" stroke={a.color} strokeWidth={11}
                strokeDasharray={`${a.len.toFixed(2)} ${(DONUT_C - a.len).toFixed(2)}`}
                strokeDashoffset={(-a.start).toFixed(2)}
                transform="rotate(-90 41 41)"
              />
            ))}
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <strong style={{ fontSize: 18, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{total}</strong>
            <span style={{ fontSize: 9, color: ct.tick }}>{t('chart.totalUnit')}</span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>{legend}</div>
      </div>
    )
  }

  if (variant === 'ticks') {
    const step = Math.max(1, Math.ceil(total / MAX_TICKS))
    const cells: string[] = []
    parts.forEach((p) => {
      const cnt = step === 1 ? p.value : Math.round(p.value / step)
      for (let i = 0; i < cnt; i += 1) cells.push(p.color)
    })
    return (
      <div style={{ padding: '14px 12px 4px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {cells.map((color, i) => (
            <span key={i} style={{ width: 13, height: 13, borderRadius: 3, background: color }} />
          ))}
        </div>
        <div style={{ marginTop: 14 }}>{legend}</div>
      </div>
    )
  }

  return (
    <div style={{ padding: '4px 12px 0' }}>
      <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: ct.track }}>
        {parts.filter((p) => p.value > 0).map((p) => (
          <div
            key={p.key} className="dash-bar-fill" title={`${p.label} ${p.value}`}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
          />
        ))}
      </div>
      <div className="dash-stagger" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {parts.map((p, i) => {
          // 已发布是这张卡真正要回答的数字，其余两类弱化；字号差控制在一档，避免行高跳动
          const isMain = p.key === 'published'
          return (
            <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: '20px' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isMain ? undefined : ct.tick }}>
                {p.label}
              </span>
              <strong style={{ fontVariantNumeric: 'tabular-nums', fontSize: isMain ? 15 : 12 }}>
                {p.value}
              </strong>
              <span style={{ width: 34, textAlign: 'right', color: ct.tick, fontVariantNumeric: 'tabular-nums' }}>
                {pcts[i]}%
              </span>
            </div>
          )
        })}
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
  const [statusVariant, chooseStatusVariant] = useChartVariant('examStatus', EXAM_STATUS_POOL)

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
  // 「进行中的活动」是聚合概念（测验/讨论/投票/作业/考试都算），不能挑一个类别跳：
  // 原来只要有用测验就固定去随堂测验，点了"进行中"却看不到讨论和投票，像是数据丢了。
  // 统一去活动监控，那里能一次看全。
  const ongoingTarget = '/activity-monitor'

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
          <Card size="small" className="dash-card dash-fill-card dash-top-body" style={{ height: '100%' }}
            title={<Text style={{ fontSize: 14, fontWeight: 500 }}>{t('chart.examStatus')}</Text>}
            extra={(examStats?.total ?? 0) > 0 && (
              <VariantSwitch
                title={t('chart.switchTitle')}
                value={statusVariant}
                onChange={chooseStatusVariant}
                options={EXAM_STATUS_POOL.map((k) => ({ key: k, icon: STATUS_ICON[k], label: t(`examStatus.view.${k}`) }))}
              />
            )}
            styles={{ body: { padding: '0 4px 8px', minHeight: 226 } }}>
            <ExamStatusChart
              variant={statusVariant}
              emptyText={t('chart.noTeachingData')}
              parts={[
                { key: 'published', label: t('published'), value: examStats?.published ?? 0, color: '#52c41a' },
                { key: 'ended', label: t('ended'), value: examStats?.ended ?? 0, color: '#ff7a45' },
                { key: 'draft', label: t('draft'), value: examStats?.draft ?? 0, color: '#bfbfbf' },
              ]}
            />
            {/* 贴顶后底部会空，用一行入口收尾：看到"3 场已结束"的人下一步一定是想去看成绩 */}
            {(examStats?.total ?? 0) > 0 && (
              <div style={{ marginTop: 'auto', padding: '10px 12px 2px' }}>
                <a className="dash-inline-link" style={{ fontSize: 11 }} onClick={() => navigate('/exam')}>
                  {t('chart.examManageLink')} →
                </a>
              </div>
            )}
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
              title={<span style={{ fontSize: 14, fontWeight: 500 }}><FireOutlined style={{ color: '#fa8c16', marginRight: 6 }} />{t('recentCreatedExams')}</span>}
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
                    className="dash-row"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 6px', margin: '0 -6px',
                      borderBottom: idx === arr.length - 1 ? 'none' : '1px solid rgba(128,128,128,0.12)',
                    }}
                  >
                    <Text style={{ fontSize: 13, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {exam.title}
                    </Text>
                    <Space size={8} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                      <Tag color={st.color} style={{ fontSize: 11, marginInlineEnd: 0 }}>{st.label}</Tag>
                      {isAdmin && (
                        <Text type="secondary" style={{ fontSize: 11 }}>{exam.creator_username || exam.creator_name || ''}</Text>
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
