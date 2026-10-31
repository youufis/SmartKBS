/**
 * 教师/管理员"今日待办"行动条
 *
 * 分两层：上层是三个汇总指标（待批阅 / 进行中 / 下一场考试），下层才是细粒度入口。
 * 原来只有一层六七个同权重标签，最该突出的"待批阅"淹没在中间；
 * 下一场考试原本单独占一条黄色 Alert，和这里的指标说的是同一件事，已合并。
 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, Space, Tag, Tooltip, Typography } from 'antd'
import {
  AuditOutlined, BarChartOutlined, CheckCircleOutlined, ClockCircleOutlined,
  FileDoneOutlined, FireOutlined, FormOutlined, MessageOutlined,
  QuestionCircleOutlined, TeamOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import type { TeacherTodo } from '../../api/dashboard'
import { friendlyTime } from './fmt'

const { Text } = Typography

interface ChipDef {
  key: keyof TeacherTodo
  labelKey: string
  icon: React.ReactNode
  color: string
  route: string
  actionable?: boolean
}

const CHIPS: ChipDef[] = [
  { key: 'pending_exam_grading', labelKey: 'teacherTodo.grading', icon: <FormOutlined />, color: '#ff4d4f', route: '/exam?grading=pending', actionable: true },
  { key: 'pending_task_grades', labelKey: 'teacherTodo.taskGrades', icon: <FileDoneOutlined />, color: '#fa8c16', route: '/tasks?grading=pending', actionable: true },
  { key: 'pending_questions', labelKey: 'teacherTodo.questions', icon: <QuestionCircleOutlined />, color: '#722ed1', route: '/student-questions', actionable: true },
  { key: 'pending_answer_reviews', labelKey: 'teacherTodo.answers', icon: <MessageOutlined />, color: '#eb2f96', route: '/student-questions', actionable: true },
  { key: 'active_quizzes', labelKey: 'teacherTodo.quizzes', icon: <ThunderboltOutlined />, color: '#1677ff', route: '/interaction' },
  { key: 'active_quick_quiz_rooms', labelKey: 'teacherTodo.quickQuiz', icon: <FireOutlined />, color: '#13c2c2', route: '/quick-quiz' },
  { key: 'active_discussions', labelKey: 'teacherTodo.discussions', icon: <TeamOutlined />, color: '#2f54eb', route: '/discussion' },
  { key: 'active_polls', labelKey: 'teacherTodo.polls', icon: <BarChartOutlined />, color: '#52c41a', route: '/quick-poll' },
  { key: 'active_tasks', labelKey: 'teacherTodo.tasks', icon: <CheckCircleOutlined />, color: '#389e0d', route: '/tasks' },
  { key: 'in_progress_exam_count', labelKey: 'teacherTodo.exams', icon: <ClockCircleOutlined />, color: '#d48806', route: '/exam' },
]

/** 汇总指标：标签小、数字大，0 值降级成灰 */
const Metric: React.FC<{ label: string; value: number; color: string; onClick?: () => void }> = ({
  label, value, color, onClick,
}) => (
  <span
    onClick={onClick}
    role={onClick ? 'button' : undefined}
    tabIndex={onClick ? 0 : undefined}
    onKeyDown={(ev) => { if (onClick && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); onClick() } }}
    style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, cursor: onClick ? 'pointer' : 'default', flexShrink: 0 }}
  >
    <span style={{ fontSize: 12, color: 'rgba(128,128,128,0.95)' }}>{label}</span>
    <strong style={{
      fontSize: 18, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
      color: value > 0 ? color : 'rgba(128,128,128,0.5)',
    }}>
      {value}
    </strong>
  </span>
)

const TeacherTodoBar: React.FC<{ data: TeacherTodo | null }> = ({ data }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  if (!data) return null

  const pendingCount =
    data.pending_exam_grading + data.pending_task_grades + data.pending_questions + data.pending_answer_reviews
  const ongoingCount =
    data.active_quizzes + data.active_quick_quiz_rooms + data.active_discussions + data.active_polls + data.active_tasks + data.in_progress_exam_count

  // 两类分开：待办是要动手的（彩色标签、逐个可点），进行中只是"课堂正在发生"（一行灰字）
  const pendingChips = CHIPS.filter((c) => c.actionable && ((data[c.key] as number) ?? 0) > 0)
  const ongoingChips = CHIPS.filter((c) => !c.actionable && ((data[c.key] as number) ?? 0) > 0)

  // 点"待处理"要落到当前确实有事的那一类，不能永远去考试中心
  const pendingRoute = data.pending_exam_grading > 0 ? '/exam?grading=pending'
    : data.pending_task_grades > 0 ? '/tasks?grading=pending'
      : (data.pending_questions + data.pending_answer_reviews) > 0 ? '/student-questions'
        : '/exam?grading=pending'

  const nextExam = data.next_exam

  return (
    <Card size="small" style={{ marginBottom: 16 }} styles={{ body: { padding: '10px 16px' } }}>
      <Space orientation="vertical" size={9} style={{ width: '100%' }}>
        {/* 汇总行：三个数字回答"今天有多少活"，下面一行回答"具体是什么活" */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap',
          paddingBottom: 9, borderBottom: '1px dashed rgba(128,128,128,0.2)',
        }}>
          <Metric
            label={t('teacherTodo.metricPending')} value={pendingCount} color="#ff4d4f"
            onClick={() => navigate(pendingRoute)}
          />
          <Metric
            label={t('teacherTodo.metricOngoing')} value={ongoingCount} color="#fa8c16"
            onClick={() => navigate('/activity-monitor')}
          />
          <span style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 12.5, color: 'rgba(128,128,128,0.95)', minWidth: 0,
          }}>
            <ClockCircleOutlined style={{ color: '#faad14' }} />
            {t('teacherTodo.metricNextExam')}：
            {nextExam ? (
              <>
                <a
                  onClick={() => navigate('/exam')}
                  style={{
                    maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                  title={nextExam.title}
                >
                  {nextExam.title}
                </a>
                {nextExam.end_time && (
                  <span style={{ color: 'rgba(128,128,128,0.7)' }}>· {friendlyTime(nextExam.end_time)}</span>
                )}
              </>
            ) : (
              <span style={{ color: 'rgba(128,128,128,0.6)' }}>{t('teacherTodo.metricNone')}</span>
            )}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Text strong style={{ fontSize: 13, flexShrink: 0 }}>
            {t('teacherTodo.title')}
            <AuditOutlined style={{ marginLeft: 4, color: '#1677ff' }} />
          </Text>
          {pendingChips.map((chip) => {
            const n = (data[chip.key] as number) ?? 0
            return (
              <Tooltip key={chip.key} title={t('teacherTodo.pendingHint')}>
                <Tag
                  onClick={() => navigate(chip.route)}
                  style={{
                    cursor: 'pointer', margin: 0, padding: '2px 10px', borderRadius: 8, userSelect: 'none',
                    borderColor: chip.color,
                  }}
                >
                  <Space size={4} style={{ color: chip.color }}>
                    {chip.icon}
                    <span>{t(chip.labelKey)}</span>
                    <Text strong style={{ color: chip.color }}>{n}</Text>
                  </Space>
                </Tag>
              </Tooltip>
            )
          })}
          {pendingCount === 0 && (
            <Text type="success" style={{ fontSize: 13 }}>{t('teacherTodo.clear')}</Text>
          )}
          {ongoingChips.length > 0 && (
            <>
              <span style={{ width: 1, height: 14, background: 'rgba(128,128,128,0.25)' }} />
              {/* 每个分类各跳各的页面。原来整串灰字共用一个 onClick，点"分组讨论"也会去随堂测验 */}
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                fontSize: 12, color: 'rgba(128,128,128,0.95)',
              }}>
                {ongoingChips.map((c, idx) => (
                  <React.Fragment key={c.key}>
                    {idx > 0 && <span style={{ color: 'rgba(128,128,128,0.4)' }}>·</span>}
                    <Tooltip title={t('teacherTodo.ongoingHint')}>
                      <span
                        className="dash-inline-link"
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(c.route)}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); navigate(c.route) }
                        }}
                      >
                        {t(c.labelKey)} {Number(data[c.key]) || 0}
                      </span>
                    </Tooltip>
                  </React.Fragment>
                ))}
              </span>
            </>
          )}
        </div>
      </Space>
    </Card>
  )
}

export default TeacherTodoBar
