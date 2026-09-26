/** 教师/管理员"今日待办"行动条：可点击徽标直达工作台 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Card, Space, Tag, Tooltip, Typography } from 'antd'
import {
  AuditOutlined, BarChartOutlined, CheckCircleOutlined, FileDoneOutlined,
  FormOutlined, MessageOutlined, QuestionCircleOutlined, TeamOutlined,
  ThunderboltOutlined, FireOutlined, ClockCircleOutlined,
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

const TeacherTodoBar: React.FC<{ data: TeacherTodo | null }> = ({ data }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  if (!data) return null

  const pendingCount =
    data.pending_exam_grading + data.pending_task_grades + data.pending_questions + data.pending_answer_reviews
  const ongoingCount =
    data.active_quizzes + data.active_quick_quiz_rooms + data.active_discussions + data.active_polls + data.active_tasks + data.in_progress_exam_count

  return (
    <Card size="small" style={{ marginBottom: 16 }} styles={{ body: { padding: '10px 16px' } }}>
      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
        {data.next_exam && (
          <Alert
            type="warning"
            showIcon
            banner
            title={
              <Text style={{ fontSize: 12.5 }}>
                {t('teacherTodo.nextExam', { title: data.next_exam.title })}
                {data.next_exam.end_time ? ` · ${friendlyTime(data.next_exam.end_time)}` : ''}
              </Text>
            }
            action={
              <Button size="small" type="link" onClick={() => navigate('/exam')}>{t('teacherTodo.go')} →</Button>
            }
            style={{ borderRadius: 6 }}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Text strong style={{ fontSize: 13, flexShrink: 0 }}>
            {t('teacherTodo.title')}
            <AuditOutlined style={{ marginLeft: 4, color: '#1677ff' }} />
          </Text>
          {CHIPS.map((chip) => {
            const n = (data[chip.key] as number) ?? 0
            if (n === 0) return null
            const isPending = chip.actionable
            return (
              <Tooltip key={chip.key} title={isPending ? t('teacherTodo.pendingHint') : t('teacherTodo.ongoingHint')}>
                <Tag
                  onClick={() => navigate(chip.route)}
                  style={{
                    cursor: 'pointer', margin: 0, padding: '2px 10px', borderRadius: 8, userSelect: 'none',
                    borderColor: n > 0 && isPending ? chip.color : undefined,
                  }}
                  color={isPending ? undefined : 'default'}
                >
                  <Space size={4} style={{ color: isPending ? chip.color : undefined }}>
                    {chip.icon}
                    <span>{t(chip.labelKey)}</span>
                    <Text strong style={{ color: isPending ? chip.color : undefined }}>{n}</Text>
                  </Space>
                </Tag>
              </Tooltip>
            )
          })}
          {pendingCount === 0 && ongoingCount === 0 && (
            <Text type="success" style={{ fontSize: 13 }}>{t('teacherTodo.clear')}</Text>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'rgba(128,128,128,0.85)', whiteSpace: 'nowrap' }}>
            {t('teacherTodo.activeToday', { n: data.active_students_today })}
          </span>
        </div>
      </Space>
    </Card>
  )
}

export default TeacherTodoBar
