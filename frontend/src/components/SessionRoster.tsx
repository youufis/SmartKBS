/**
 * 练习/测验提交名册 — 已交/未交 + 班级 + 按学生查询（P1-6 起随堂测验结果共用）。
 *
 * 数据形状与 practice get_session_detail / interaction quizzes results 对齐：
 *   students: [{username,name,grade,class,submitted,score,total_score,submitted_at}]
 *   attempts: [{student_username,pending_ai,pending_review,teacher_reviewed?,score,total_score,submitted_at}]
 */
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Input, Radio, Space, Table, Tag, Typography } from 'antd'
import ScopeTag from './ScopeTag'
import { toPercent, percentStatus } from '../utils/score'

const { Text } = Typography

// ════════════════════════════════════════
// 练习提交名册 — 已交/未交 + 班级 + 按学生查询
// ════════════════════════════════════════
const SessionRoster: React.FC<{
  attempts: any[]
  students: any[]
  /** S-GRADE: 点开某个学生的答卷(含主观题作答与批改, 可逐题改分) */
  onShowSheet?: (attempt: any) => void
}> = ({ attempts, students, onShowSheet }) => {
  const { t } = useTranslation('practice')
  const [kw, setKw] = useState('')
  const [filter, setFilter] = useState<'all' | 'done' | 'undone'>('all')

  const attMap = useMemo(() => {
    const m = new Map<string, any>()
    ;(attempts || []).forEach((a: any) => m.set(a.student_username, a))
    return m
  }, [attempts])

  const rows = useMemo(() => {
    const map = new Map<string, any>()
    ;(students || []).forEach((x: any) => map.set(x.username, { ...x }))
    ;(attempts || []).forEach((a: any) => {
      if (!map.has(a.student_username)) {
        map.set(a.student_username, {
          username: a.student_username,
          name: a.student_name || a.student_username,
          grade: a.student_grade || '',
          class: a.student_class || '',
          submitted: true, score: a.score, total_score: a.total_score, submitted_at: a.submitted_at,
        })
      }
    })
    const k = kw.trim().toLowerCase()
    return Array.from(map.values()).filter((r: any) => {
      if (filter === 'done' && !r.submitted) return false
      if (filter === 'undone' && r.submitted) return false
      if (!k) return true
      // 学号/姓名/年级/班级都可搜(学号即登录用户名)
      return [r.name, r.username, String(r.class || ''), String(r.grade || '')]
        .some(v => String(v).toLowerCase().includes(k))
    })
  }, [students, attempts, kw, filter])

  const pendingCount = (attempts || []).reduce((n: number, a: any) => n + (a.pending_review || 0), 0)
  // S-GRADING: 还在后台批改的题数, 教师据此决定要不要「立即批改」
  const aiPending = (attempts || []).reduce((n: number, a: any) => n + (a.pending_ai || 0), 0)
  const reviewedCount = (attempts || []).filter((a: any) => a.teacher_reviewed).length

  return (
    <div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Input allowClear style={{ width: 220 }} value={kw} onChange={e => setKw(e.target.value)}
          placeholder={`${t('studentId')} / ${t('studentName')} / ${t('grade')}`} />
        <Radio.Group value={filter} onChange={e => setFilter(e.target.value)}>
          <Radio.Button value="all">{t('all')}</Radio.Button>
          <Radio.Button value="done">{t('submitted')}</Radio.Button>
          <Radio.Button value="undone">{t('notStarted')}</Radio.Button>
        </Radio.Group>
        <Text type="secondary">{t('totalItems', { count: rows.length })}</Text>
        {reviewedCount > 0 && <Tag color="green">{t('reviewedStudents', { count: reviewedCount })}</Tag>}
        {aiPending > 0 && <Tag color="processing">{t('pendingAiN', { count: aiPending })}</Tag>}
        {pendingCount > 0 && <Tag color="orange">{t('pendingReviewTotal', { count: pendingCount })}</Tag>}
      </Space>
      <Table size="small" rowKey="username" dataSource={rows}
        locale={{ emptyText: t('noStudentSubmissions') }}
        pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total: number) => t('totalItems', { count: total }) }}
        columns={[
          // 姓名只留一行（下面那行学号去掉）：名册本来就要短，学号对老师是噪音
          { title: t('studentName'), key: 'student', width: 104,
            render: (_: any, r: any) => <div>{r.name || '-'}</div> },
          { title: t('gradeClass'), key: 'grade_class', width: 116,
            render: (_: any, r: any) => (
              <ScopeTag variant="text" grade={r.grade} classes={String(r.class ?? '')} />
            ) },
          {
            title: t('status'), dataIndex: 'submitted', width: 84,
            render: (v: boolean) => (v ? <Tag color="success">{t('submitted')}</Tag> : <Tag>{t('notStarted')}</Tag>),
          },
          {
            title: t('questionScore'), key: 'score', width: 104,
            render: (_: any, r: any) => {
              if (!r.submitted) return '-'
              const pct = toPercent(r.score, r.total_score)
              // 得分统一 100 分制: 按 x/y 展示（满分即 100），不再附"原始得分 x/y"
              return (
                <Text strong color={percentStatus(pct)}>
                  {r.score ?? 0} / {r.total_score ?? 100}
                </Text>
              )
            },
          },
          {
            // S-GRADE: 谁判的分、还剩几题待批改, 教师一眼可见
            title: t('gradingState'), key: 'grading', width: 124,
            render: (_: any, r: any) => {
              const a = attMap.get(r.username)
              if (!a) return '-'
              if (a.teacher_reviewed) return <Tag color="green">{t('gradedByTeacher')}</Tag>
              if (a.pending_ai) return <Tag color="processing">{t('pendingAiN', { count: a.pending_ai })}</Tag>
              if (a.pending_review) return <Tag color="orange">{t('pendingReviewN', { count: a.pending_review })}</Tag>
              // 判分来源(AI/系统/要点)已经在逐题标签里显示, 这一列只说「判完没判完」,
              // 三处(练习/考试/测验)口径统一用「已批改」
              return <Tag color="green">{t('gradedDone')}</Tag>
            },
          },
          { title: t('submitTime'), dataIndex: 'submitted_at', width: 138, ellipsis: true, render: (v: string) => v || '-' },
          {
            title: t('actions'), key: 'op', width: 88,
            render: (_: any, r: any) => {
              const a = attMap.get(r.username)
              return a && onShowSheet
                ? <Button size="small" onClick={() => onShowSheet(a)}>{t('viewSheet')}</Button>
                : <Text type="secondary">-</Text>
            },
          },
        ] as any}
      />
    </div>
  )
}

export default SessionRoster
