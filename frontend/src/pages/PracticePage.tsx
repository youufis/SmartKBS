import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import AnswerLine from '../components/AnswerLine'
import {
  Card, Button, Input, InputNumber, Select, Tag, message, Spin,
  Radio, Space, Typography, Divider, Progress, Table, Modal, Result, Popconfirm, Pagination, Checkbox,
  Switch, Tooltip,
} from 'antd'
import {
  RobotOutlined, ReloadOutlined, CheckCircleOutlined,
  FormOutlined, FileTextOutlined, StopOutlined, DeleteOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import { classText } from '../utils/studentLabel'
import { TYPE_LABELS as typeLabel, TYPE_OPTIONS } from '../constants/questionTypes'

/** 详情/答卷里显示题型名(与做题页同一份映射) */
const TYPE_LABELS_LOCAL: Record<string, string> = typeLabel as Record<string, string>
import ResetActivityButton from '../components/ResetActivityButton'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'

const { Title, Text } = Typography
const { TextArea } = Input

/** S-GRADE: 每题判分来源, 让学生和教师一眼看出这个分数是谁给的 */
const GRADED_BY_KEYS: Record<string, string> = {
  ai: "gradedByAi", keyword: "gradedByKeyword", exact: "gradedByExact",
  none: "gradedByNone", teacher: "gradedByTeacher", queued: "gradedByQueued",
}
const gradedByKey = (v: unknown) => GRADED_BY_KEYS[String(v ?? "")] || "gradedByUnknown"

/** 得分率(无满分字段时退回对错) */
const scoreRatio = (r: any) => {
  const mx = Number(r?.max_score ?? 0)
  if (!mx) return r?.is_correct ? 1 : 0
  return Number(r?.score ?? 0) / mx
}
const scoreColor = (ratio: number) => (ratio >= 0.999 ? "green" : ratio > 0 ? "orange" : "red")
/** 主观题题型(后端 AI_GRADED_TYPES + 填空题) */
const SUBJ_TYPES = ["short", "fill", "essay", "subjective"]
/** S-GRADING: 主观题已转后台批改队列 —— 分数未定, 先不显示得分与对错 */
const isGradingPending = (r: any) => r?.grading === "pending" || r?.graded_by === "queued"

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
        scroll={{ x: 900 }}
        pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total: number) => t('totalItems', { count: total }) }}
        columns={[
          { title: t('studentId'), dataIndex: 'username', width: 100, ellipsis: true },
          { title: t('studentName'), dataIndex: 'name', width: 110, ellipsis: true },
          { title: t('grade'), dataIndex: 'grade', width: 80, render: (v: string) => v || '-' },
          {
            title: t('studentClass'), dataIndex: 'class', width: 80,
            render: (v: string) => classText(v) || '-',
          },
          {
            title: t('status'), dataIndex: 'submitted', width: 90,
            render: (v: boolean) => (v ? <Tag color="success">{t('submitted')}</Tag> : <Tag>{t('notStarted')}</Tag>),
          },
          {
            title: t('score'), key: 'score', width: 96,
            render: (_: any, r: any) => (r.submitted ? `${r.score ?? 0}/${r.total_score ?? 0}` : '-'),
          },
          {
            // S-GRADE: 谁判的分、还剩几题待批改, 教师一眼可见
            title: t('gradingState'), key: 'grading', width: 130,
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
          { title: t('submitTime'), dataIndex: 'submitted_at', width: 150, ellipsis: true, render: (v: string) => v || '-' },
          {
            title: t('actions'), key: 'op', width: 100, fixed: 'right' as const,
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

// ════════════════════════════════════════
// 学生端
// ════════════════════════════════════════
const StudentView: React.FC = () => {
  const { t } = useTranslation('practice')
  const [loading, setLoading] = useState(true)
  const [sessions, setSessions] = useState<any[]>([])
  const [activeSession, setActiveSession] = useState<any>(null)
  const [questions, setQuestions] = useState<any[]>([])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [submittedView, setSubmittedView] = useState<any>(null)
  // S-GRADING: 自动刷新次数上限, 避免后台一直判不完时前端无限轮询
  const refreshTries = useRef(0)
  const [stuPage, setStuPage] = useState(1)
  const [stuPageSize, setStuPageSize] = useState(10)

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/practice/my-sessions')
      setSessions(data.sessions || [])
    } catch { message.error(t('loadFailed')) }
    finally { setLoading(false) }
  }, [])

  // 初始加载：不在 effect 中同步调用 setLoading，直接从 true→false
  useEffect(() => {
    apiClient.get('/api/practice/my-sessions')
      .then(({ data }) => setSessions(data.sessions || []))
      .catch(() => message.error(t('loadFailed')))
      .finally(() => setLoading(false))
  }, [])

  const startPractice = async (sid: number) => {
    try {
      const { data } = await apiClient.get(`/api/practice/my-sessions/${sid}`)
      if (data.attempt) {
        setSubmittedView(data)
      } else {
        setActiveSession(data.session)
        setQuestions(data.questions || [])
        setAnswers({})
        setResult(null)
      }
    } catch { message.error(t('loadPracticeFailed')) }
  }

  const submitAnswers = async () => {
    setSubmitting(true)
    try {
      // S-GRADE: 含主观题时后端要逐题调 AI 批改, 默认 30s 超时会让「提交失败」误报
      const { data } = await apiClient.post(
        `/api/practice/my-sessions/${activeSession.id}/submit`,
        { answers },
        { timeout: 120000 },
      )
      setResult(data)
      // S-GRADING: 主观题不再卡在提交里, 明确告知成绩稍后自动更新
      if (Number(data?.pending_ai || 0) > 0) message.info(t('gradingQueuedToast', { count: data.pending_ai }))
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('submitFailed'))
    } finally { setSubmitting(false) }
  }

  // S-GRADING: 仍有题在后台批改 → 8 秒后静默重取一次, 判完自动显示真实得分
  useEffect(() => {
    const sid = submittedView?.session?.id
    const left = Number(submittedView?.attempt?.pending_ai || 0)
    if (!sid || left <= 0) { refreshTries.current = 0; return }
    if (refreshTries.current >= 12) return          // 最多再刷 12 次(约 96 秒)
    const timer = setTimeout(() => {
      refreshTries.current += 1
      apiClient.get(`/api/practice/my-sessions/${sid}`)
        .then(({ data }) => { if (data?.attempt) setSubmittedView(data) })
        .catch(() => { /* 本轮没判完, 下次进入页面再看 */ })
    }, 8000)
    return () => clearTimeout(timer)
  }, [submittedView])

  const allAnswered = questions.length > 0 && questions.every(q => answers[String(q.id)]?.trim())

  if (submittedView) {
    return (
      <div>
        <Title level={4}><CheckCircleOutlined /> {submittedView.session?.title} — {t('practiceComplete')}</Title>
        <Card style={{ textAlign: 'center', marginBottom: 16 }}>
          <Progress type="circle" percent={submittedView.attempt?.accuracy || 0}
            format={p => `${p}%`}
            strokeColor={submittedView.attempt?.accuracy >= 80 ? '#52c41a' : submittedView.attempt?.accuracy >= 60 ? '#faad14' : '#ff4d4f'}
          />
          <div style={{ marginTop: 8 }}>
            <Text>{t('scoreLabel', { score: submittedView.attempt?.score, total: submittedView.attempt?.total_score })}</Text>
          </div>
          {Number(submittedView.attempt?.pending_ai || 0) > 0 && (
            <div style={{ marginTop: 8 }}>
              <Space size={6} wrap>
                <Tag color="processing">{t('gradingPending')}</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('pendingAiHint', { count: submittedView.attempt.pending_ai })}
                </Text>
              </Space>
            </div>
          )}
        </Card>
        {submittedView.results?.map((r: any, i: number) => (
          <Card key={i} size="small" style={{ marginBottom: 8 }}
            title={t('questionN', { n: i+1 })}
            extra={
              <Space size={4} wrap>
                {/* S-GRADE: 每题得分必须显示 —— 以前只给「正确/错误」, 简答题被扣几分学生看不到 */}
                {!isGradingPending(r) && (
                  <Tag color={scoreColor(scoreRatio(r))}>{t('questionScore')} {Number(r.score ?? 0)}/{Number(r.max_score ?? 0)}</Tag>
                )}
                {isGradingPending(r)
                  ? <Tag color="processing">{t('gradingPending')}</Tag>
                  : r.needs_review
                  ? <Tag color="orange">{t('pendingReview')}</Tag>
                  : (r.is_correct ? <Tag color="success">{t('correct')}</Tag> : <Tag color="error">{t('incorrect')}</Tag>)}
                <Tag>{t(gradedByKey(r.graded_by))}</Tag>
              </Space>
            }
          >
            <FormulaRenderer content={r.question_text} />
            <MediaDisplay svgContent={r.svg_content} hasSvg={r.has_svg} mediaFiles={(r as any).media_files} />
            <div style={{ marginTop: 8 }}>
              <Text>{t('yourAnswer')}：<Text type={isGradingPending(r) ? undefined : (r.is_correct ? 'success' : 'danger')}>{r.student_answer || t('noHistory')}</Text></Text>
              {/* 参考答案常显: 主观题即使判对也值得对照, 不再只在判错时才给看 */}
              <div><Text type="secondary">{t('correctAnswer')}：{r.correct_answer || '-'}</Text></div>
              {!!r.feedback && (
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary">{t('aiComment')}：<FormulaRenderer content={r.feedback} inline /></Text>
                </div>
              )}
              {!!r.teacher_comment && (
                <div style={{ marginTop: 4 }}>
                  <Text style={{ color: '#389e0d' }}>{t('teacherComment')}：{r.teacher_comment}</Text>
                </div>
              )}
              {!!r.needs_review && (
                <div style={{ marginTop: 4 }}><Text type="warning">{t('needsReviewHint')}</Text></div>
              )}
            </div>
            {r.explanation && (
              <div style={{ marginTop: 8, padding: 8, background: '#f5f5f5', borderRadius: 4 }}>
                <Text type="secondary"><FormulaRenderer content={r.explanation} /></Text>
              </div>
            )}
          </Card>
        ))}
        <Button icon={<FormOutlined />} onClick={() => { setSubmittedView(null); loadSessions() }}
          style={{ marginTop: 16 }}>{t('practiceHistory')}</Button>
      </div>
    )
  }

  if (activeSession) {
    return (
      <div>
        <Title level={4}><FormOutlined /> {activeSession.title}</Title>
        <Text type="secondary">{t('knowledgePoints')}：{activeSession.knowledge_points}</Text>
        <Divider />
        {questions.map((q, i) => (
          <Card key={q.id} size="small" title={t('questionNWithType', { n: i+1, type: typeLabel[q.type] || q.type })}
            style={{ marginBottom: 12 }}>
            <FormulaRenderer content={q.question_text} />
            <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} />
            {q.type === 'single' && q.options && (
              <Radio.Group value={answers[String(q.id)]} onChange={e => setAnswers(p => ({...p, [String(q.id)]: e.target.value}))}>
                <Space orientation="vertical">
                  {Object.entries(q.options).map(([k, v]) => (
                    <Radio key={k} value={k} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{k}. <FormulaRenderer content={v as string} inline /></Radio>
                  ))}
                </Space>
              </Radio.Group>
            )}
            {q.type === 'true_false' && (
              <Radio.Group value={answers[String(q.id)]} onChange={e => setAnswers(p => ({...p, [String(q.id)]: e.target.value}))}>
                <Radio value="对">{t('true')}</Radio>
                <Radio value="错" style={{ marginLeft: 24 }}>{t('false')}</Radio>
              </Radio.Group>
            )}
            {q.type === 'multiple' && q.options && (
              <Checkbox.Group
                value={answers[String(q.id)] ? String(answers[String(q.id)]).split('') : []}
                onChange={(v: any) => setAnswers(p => ({ ...p, [String(q.id)]: [...(v as string[])].sort().join('') }))}>
                <Space orientation="vertical">
                  {Object.entries(q.options).map(([k, v]) => (
                    <Checkbox key={k} value={k} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{k}. <FormulaRenderer content={v as string} inline /></Checkbox>
                  ))}
                </Space>
              </Checkbox.Group>
            )}
            {!['single', 'multiple', 'true_false'].includes(q.type) && (
              <TextArea rows={q.type === 'short' || q.type === 'fill' ? 3 : 5} placeholder={t('inputAnswer')}
                value={answers[String(q.id)] || ''}
                onChange={e => setAnswers(p => ({...p, [String(q.id)]: e.target.value}))} />
            )}
          </Card>
        ))}
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Button type="primary" size="large" loading={submitting} disabled={!allAnswered}
            onClick={submitAnswers}>
            {allAnswered ? `${t('submit')} (${Object.keys(answers).length}/${questions.length})` : t('answerAll')}
          </Button>
          <Button style={{ marginLeft: 12 }} onClick={() => { setActiveSession(null); loadSessions() }}>{t('practiceHistory')}</Button>
        </div>
        {questions.some(q => SUBJ_TYPES.includes(q.type)) && (
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('aiGradingWait')}</Text>
          </div>
        )}
        {result && (
          <Card style={{ marginTop: 16, textAlign: 'center' }}>
            <Title level={4}>{t('submit')}</Title>
            <Progress type="circle" percent={result.accuracy}
              format={p => `${p}%`}
              strokeColor={result.accuracy >= 80 ? '#52c41a' : result.accuracy >= 60 ? '#faad14' : '#ff4d4f'} />
            <div style={{ marginTop: 8 }}><Text>{t('score')}：{result.score}/{result.total_score}</Text></div>
            {Number(result.pending_ai || 0) > 0 && (
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('pendingAiHint', { count: result.pending_ai })}</Text>
              </div>
            )}
            <Space style={{ marginTop: 12 }}>
              <Button type="primary" icon={<CheckCircleOutlined />}
                onClick={() => startPractice(activeSession.id)}>{t('detail')}</Button>
              <Button icon={<ReloadOutlined />}
                onClick={() => { setActiveSession(null); setResult(null); loadSessions() }}>{t('practiceHistory')}</Button>
            </Space>
          </Card>
        )}
      </div>
    )
  }

  return (
    <div>
      <Title level={4}><FormOutlined /> {t('practiceHistory')}</Title>
      <Text type="secondary">{t('practiceComplete')}</Text>
      <Divider />
      {loading ? <Spin style={{ display: 'block', margin: '40px auto' }} />
        : sessions.length === 0
        ? <Result icon={<FileTextOutlined />} title={t('noProblems')} subTitle={t('noHistory')} />
        : <>
            {sessions.slice((stuPage - 1) * stuPageSize, stuPage * stuPageSize).map(s => (
              <Card key={s.id} size="small" style={{ marginBottom: 8 }}
                hoverable onClick={() => startPractice(s.id)}
                extra={s.attempted ? <Tag color="processing">{t('submitted')}</Tag> : <Tag color="default">{t('notStarted')}</Tag>}>
                <Text strong>{s.title}</Text>
                <div><Text type="secondary">{s.knowledge_points}</Text></div>
                <div><Text type="secondary">{t('publisher')}：{s.creator_name} · {s.question_count} {t('questionCount')}
                  {s.source === 'wrong_book' && <Tag color="purple" style={{ marginLeft: 6 }}>{t('sourceWrongBook')}</Tag>}
                </Text></div>
              </Card>
            ))}
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <Pagination
                current={stuPage} pageSize={stuPageSize} total={sessions.length}
                showSizeChanger showTotal={(total) => t('totalItems', { count: total })}
                pageSizeOptions={['5', '10', '20', '50']}
                onChange={(p, ps) => { setStuPage(p); setStuPageSize(ps) }}
                size="small"
              />
            </div>
          </>
      }
    </div>
  )
}

// ════════════════════════════════════════
// 教师端
// ════════════════════════════════════════
const TeacherView: React.FC = () => {
  const { t } = useTranslation('practice')
  const [tab, setTab] = useState<'generate' | 'sessions'>('generate')
  const [kpInput, setKpInput] = useState('')
  const [subject, setSubject] = useState('')
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])
  const [difficulty, setDifficulty] = useState('medium')
  const [qType, setQType] = useState('mixed')
  const [count, setCount] = useState(5)
  // 题库优先(与随堂测验同口径): 先复用题库匹配题, 不足才 AI 新生成
  const [preferBank, setPreferBank] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [questions, setQuestions] = useState<any[]>([])
  const [title, setTitle] = useState('')
  // 统一活动范围选择器(与随堂测验/投票/抢答一致): 任教班级/年级/班级/指定学生
  const [publishScope, setPublishScope] = useState<ActivityScopeValue>({
    target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '',
  })
  const [publishing, setPublishing] = useState(false)
  const [sessions, setSessions] = useState<any[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const user = useAuthStore(s => s.user)
  const isAdmin = user?.role === 'admin'
  // S-GRADE: 练习详情改用抽屉(原 Modal.info 塞不下二级交互), 并支持逐题查看答卷/改分
  const [detail, setDetail] = useState<any>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailSid, setDetailSid] = useState<number | null>(null)
  const [sheetAttempt, setSheetAttempt] = useState<any>(null)
  const [draft, setDraft] = useState<Record<string, { score: number; comment: string }>>({})
  const [savingReview, setSavingReview] = useState(false)
  // S-GRADING: 手动触发该练习的主观题批改(不等后台节拍)
  const [gradingNow, setGradingNow] = useState(false)
  // 抽屉是否还开着：批改是异步的，闭包里的 detailOpen 会过期，只能靠 ref 判断
  const detailOpenRef = useRef(false)
  detailOpenRef.current = detailOpen

  useEffect(() => {
    // 加载学科列表
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) {
        setSubjectOptions(data.subjects)
        setSubject(data.subjects[0])
      }
    }).catch(() => {})
  }, [])

  const generateQuestions = async () => {
    if (!kpInput.trim()) { message.warning(t('inputKp')); return }
    setGenerating(true)
    setQuestions([])
    try {
      const { data } = await apiClient.post('/api/practice/generate-async', {
        knowledge_points: kpInput.trim(), subject, question_type: qType, count, difficulty,
        prefer_bank: preferBank,
      })
      message.info(t('aiGeneratingWait'))
      const result = await pollAiTask(data.task_id, 120000)
      if (result?.error) {
        message.error(result.error)
      } else if (result) {
        setQuestions(result.questions || [])
        setTitle(`${kpInput.trim()}${t('practiceSuffix')}`)
        message.success(t('generatedCount', { count: result.total || result.questions?.length || 0 }))
        if (result.note) message.info(result.note)
      } else {
        message.error(t('aiTimeout'))
      }
    } catch (e: any) { message.error(e.response?.data?.detail || t('generateFailed')) }
    finally { setGenerating(false) }
  }

  const publishSession = async () => {
    if (!title.trim()) { message.warning(t('inputTitle')); return }
    setPublishing(true)
    try {
      const { data } = await apiClient.post('/api/practice/sessions', {
        title: title.trim(),
        knowledge_points: kpInput.trim(),
        question_ids: questions.map((q: any) => q.id),
        target_scope: publishScope.target_scope,
        target_grade: publishScope.target_grade,
        target_class: publishScope.target_class,
        target_users: publishScope.target_users,
        subject,
      })
      message.success(data.message)
      setQuestions([])
      setTab('sessions')
      loadSessions()
    } catch (e: any) { message.error(e.response?.data?.detail || t('publishFailed')) }
    finally { setPublishing(false) }
  }

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const { data } = await apiClient.get('/api/practice/sessions')
      setSessions(data.sessions || [])
    } catch { /* ignore */ }
    finally { setLoadingSessions(false) }
  }, [])

  useEffect(() => { if (tab === 'sessions') loadSessions() }, [tab, loadSessions])

  const viewSessionDetail = async (id: number) => {
    setDetailSid(id)
    setDetailOpen(true)
    setDetailLoading(true)
    try {
      const { data } = await apiClient.get(`/api/practice/sessions/${id}`)
      setDetail(data)
    } catch { message.error(t('loadDetailFailed')) }
    finally { setDetailLoading(false) }
  }

  /** S-GRADING: 立刻批改该练习待判的主观题，进度走 AI 任务轮询 */
  const gradeNow = async () => {
    if (!detailSid) return
    setGradingNow(true)
    try {
      const { data } = await apiClient.post(`/api/practice/sessions/${detailSid}/grade-now`)
      if (!data?.task_id) {
        message.info(data?.message || t('noPendingToGrade'))
        if (detailOpenRef.current) await viewSessionDetail(detailSid)
        return
      }
      message.info(t('gradingStarted', { count: data.pending_sessions || 0 }))
      const res = await pollAiTask(data.task_id, 240000)
      if (res?.error) message.error(res.error)
      else if (res) {
        message.success(t('gradingDone', { graded: res.graded ?? 0, review: res.to_review ?? 0 }))
        // 教师可能已经把抽屉关掉了, 别再把抽屉强行打开
        if (detailOpenRef.current) await viewSessionDetail(detailSid)
        loadSessions()
      } else {
        message.warning(t('gradingTimeoutRefresh'))
        if (detailOpenRef.current) await viewSessionDetail(detailSid)
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('gradingFailed'))
    } finally { setGradingNow(false) }
  }

  /** 打开某个学生的答卷：草稿初值取当前逐题得分与已有教师评语 */
  const openSheet = (a: any) => {
    const g: Record<string, any> = a?.graded || {}
    const d: Record<string, { score: number; comment: string }> = {}
    Object.keys(g).forEach((qid: string) => {
      d[qid] = { score: Number(g[qid]?.score ?? 0), comment: String(g[qid]?.teacher_comment ?? '') }
    })
    setDraft(d)
    setSheetAttempt(a)
  }

  const saveReview = async () => {
    if (!sheetAttempt) return
    // 只提交真正改过的题: 未动过的题保持原判分来源(否则 AI/系统判的题会被误标成「教师批改」)
    const stored: Record<string, any> = sheetAttempt.graded || {}
    const scores: Record<string, number> = {}
    const comments: Record<string, string> = {}
    Object.entries(draft).forEach(([qid, v]) => {
      const old = stored[qid]
      if (!old) return
      if (Number(v.score) !== Number(old.score ?? 0)) scores[qid] = v.score
      const oldComment = String(old.teacher_comment ?? '')
      if (v.comment.trim() !== oldComment.trim()) comments[qid] = v.comment
    })
    if (Object.keys(scores).length === 0 && Object.keys(comments).length === 0) {
      message.info(t('noChangeToSave'))
      return
    }
    setSavingReview(true)
    try {
      await apiClient.post('/api/practice/review', {
        attempt_id: sheetAttempt.id,
        question_scores: scores,
        question_comments: comments,
      })
      message.success(t('reviewSaved'))
      setSheetAttempt(null)
      if (detailSid) await viewSessionDetail(detailSid)
      loadSessions()
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('reviewSaveFailed'))
    } finally { setSavingReview(false) }
  }

  const endSession = async (sid: number) => {
    try {
      await apiClient.put(`/api/practice/sessions/${sid}/end`)
      message.success(t('endedSuccess'))
      loadSessions()
    } catch (e: any) { message.error(e.response?.data?.detail || t('operationFailed')) }
  }

  const deleteSession = async (sid: number) => {
    try {
      await apiClient.delete(`/api/practice/sessions/${sid}`)
      message.success(t('deletedSuccess'))
      loadSessions()
    } catch (e: any) { message.error(e.response?.data?.detail || t('deleteFailed')) }
  }

  return (
    <div>
      <Title level={4}>{t('syncPractice')}</Title>
      <Space style={{ marginBottom: 16 }}>
        <Button type={tab === 'generate' ? 'primary' : 'default'} onClick={() => setTab('generate')}>{t('aiGenerate')}</Button>
        <Button type={tab === 'sessions' ? 'primary' : 'default'} onClick={() => setTab('sessions')}>{t('publishedPractices')}</Button>
      </Space>

      {tab === 'generate' && (
        <>
          <Card size="small" style={{ marginBottom: 16 }}>
            <Space orientation="vertical" style={{ width: '100%' }}>
              <TextArea rows={2} placeholder={t('kpPlaceholder')}
                value={kpInput} onChange={e => setKpInput(e.target.value)} />
              <Space wrap>
                <Select value={subject} onChange={setSubject} style={{ width: 130 }}>
                  {subjectOptions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
                </Select>
                <Select value={qType} onChange={setQType} style={{ width: 130 }}>
                  <Select.Option value="mixed">{t('mixedQuestions')}</Select.Option>
                  {TYPE_OPTIONS.map(opt => (
                    <Select.Option key={opt.value} value={opt.value}>{opt.label}</Select.Option>
                  ))}
                </Select>
                <Select value={difficulty} onChange={setDifficulty} style={{ width: 100 }}>
                  <Select.Option value="easy">{t('easy')}</Select.Option>
                  <Select.Option value="medium">{t('medium')}</Select.Option>
                  <Select.Option value="hard">{t('hard')}</Select.Option>
                </Select>
                <InputNumber min={1} max={20} value={count} onChange={v => setCount(v || 5)}
                  style={{ width: 80 }} /> {t('questionCount')}
                <Tooltip title={t('preferBankTip')}>
                  <Space size={4}>
                    <Switch size="small" checked={preferBank} onChange={setPreferBank} />
                    <Text style={{ fontSize: 12 }}>{t('preferBank')}</Text>
                  </Space>
                </Tooltip>
                <Button type="primary" icon={<RobotOutlined />} loading={generating} onClick={generateQuestions}>
                  {t('aiGenerate')}
                </Button>
              </Space>
            </Space>
          </Card>

          {generating && <Spin description={t('aiGeneratingWait')} style={{ display: 'block', margin: '40px auto' }} />}

          {questions.map((q, i) => (
            <Card key={q.id} size="small" title={t('questionNWithType', { n: i+1, type: typeLabel[q.type] || q.type })}
              extra={<Tag>{q.difficulty === 'easy' ? t('easy') : q.difficulty === 'hard' ? t('hard') : t('medium')}</Tag>}
              style={{ marginBottom: 8, overflowX: 'auto' }}>
              <div style={{ overflowX: 'auto' }}>
                <FormulaRenderer content={q.question} />
              </div>
              <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} />
              {q.options && Object.entries(q.options).map(([k, v]) => (
                <div key={k} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><Text type="secondary">{k}. <FormulaRenderer content={v as string} inline /></Text></div>
              ))}
              <div style={{ marginTop: 8 }}><Tag color="blue">{t('correctAnswer')}：{q.answer}</Tag></div>
            </Card>
          ))}

          {questions.length > 0 && (
            <Card size="small" style={{ marginTop: 16 }}>
              <Space orientation="vertical" style={{ width: '100%' }}>
                <Input placeholder={t('title')} value={title} onChange={e => setTitle(e.target.value)} />
                <ActivityScopeSelector value={publishScope} onChange={setPublishScope} showAllOption={isAdmin} />
                <Button type="primary" loading={publishing} onClick={publishSession}>
                  {t('publishPractice')}
                </Button>
              </Space>
            </Card>
          )}
        </>
      )}

      {tab === 'sessions' && (
        loadingSessions ? <Spin style={{ display: 'block', margin: '40px auto' }} />
        : sessions.length === 0 ? <Result icon={<FileTextOutlined />} title={t('publishedRecords')} />
        : <Table dataSource={sessions} rowKey="id"
            scroll={{ x: 980 }}
            pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total: number) => t('totalItems', { count: total }), pageSizeOptions: ['5', '10', '20', '50'] }}
            columns={[
              { title: t('title_'), dataIndex: 'title', ellipsis: true },
              { title: t('publisher'), dataIndex: 'creator_name', width: 90 },
              { title: t('gradeClass'), width: 130, render: (_, r) => 
                r.target_students?.length > 0 
                  ? <Tag color="green">{t('targeted')} {r.target_students.length} {t('people')}</Tag>
                  : <>{`${r.target_grade || t('all')} ${r.target_class ? classText(r.target_class) : t('all')}`}
                    {r.source === 'wrong_book' && <Tag color="purple" style={{ marginLeft: 6 }}>{t('sourceWrongBook')}</Tag>}</>
              },
              { title: t('questionCount'), dataIndex: 'question_count', width: 56 },
              { title: t('status'), render: (_, r) => r.status === 'active' ? <Tag color="processing">{t('inProgress')}</Tag> : <Tag>{t('endedSuccess')}</Tag>, width: 76 },
              { title: t('submitted'), render: (_, r) => `${r.submitted_count}/${r.student_count}`, width: 76 },
              { title: t('actions'), key: 'actions', width: 336, render: (_, r) => <Space size={4} wrap={false} style={{ whiteSpace: 'nowrap' }}>
                <Button size="small" onClick={() => viewSessionDetail(r.id)}>{t('detail')}</Button>
                {r.status === 'active' && (
                  <Popconfirm title={t('endConfirm')} onConfirm={() => endSession(r.id)}>
                    <Button size="small" icon={<StopOutlined />}>{t('endedSuccess')}</Button>
                  </Popconfirm>
                )}
                <ResetActivityButton activityType="practice" activityId={r.id} onSuccess={loadSessions} />
                <Popconfirm title={t('deleteConfirm')} onConfirm={() => deleteSession(r.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />}>{t('delete')}</Button>
                </Popconfirm>
              </Space> },
            ]}
          />
      )}
      {/* ── S-GRADE: 练习详情(题目 + 名册 + 逐个看答卷批改) —— 居中弹窗，与随堂测验结果一致 ── */}
      <Modal
        title={detail?.session?.title || t('detail')}
        open={detailOpen}
        onCancel={() => { setDetailOpen(false); setSheetAttempt(null) }}
        width={900}
        styles={{ body: { maxHeight: '68vh', overflowY: 'auto', paddingRight: 6 } }}
        footer={
          <Space wrap>
            {/* 还有主观题在后台批改时, 教师可以立刻催批 */}
            {Number(detail?.pending_ai_total || 0) > 0 && !detailLoading && (
              <Button type="primary" ghost icon={<ThunderboltOutlined />} loading={gradingNow} onClick={gradeNow}>
                {t('gradeNow')}
              </Button>
            )}
            <Button onClick={() => { setDetailOpen(false); setSheetAttempt(null) }}>{t('close')}</Button>
          </Space>
        }
      >
        {detailLoading && <Spin style={{ display: 'block', margin: '60px auto' }} />}
        {!detailLoading && detail && (
          <>
            <p>{t('knowledgePoints')}：{detail.session?.knowledge_points}</p>
            <p>{t('questionCountTitle')}：{detail.session?.question_count} · {t('totalScoreTitle')}：{detail.session?.total_score}</p>
            <Divider />
            <Text strong>{t('questionListTitle')}</Text>
            {detail.questions?.map((q: any, i: number) => (
              <Card key={q.question_id || i} size="small" style={{ marginBottom: 8, marginTop: 8 }}
                title={t('questionN', { n: i + 1 })}
                extra={<Space size={4}><Tag>{TYPE_LABELS_LOCAL[q.type] || q.type}</Tag><Tag color="blue">{t('fullScore')} {q.score}</Tag></Space>}
              >
                <FormulaRenderer content={q.question_text} />
                <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={q.media_files} size="normal" />
                {q.options && Object.entries(q.options).map(([k, v]: [string, any]) => (
                  <div key={k} style={{ margin: '2px 0' }}>
                    <Text>{k}. <FormulaRenderer content={v as string} inline /></Text>
                  </div>
                ))}
                <div style={{ marginTop: 4 }}>
                  <AnswerLine color="blue" label={t('answerColon')} value={q.correct_answer} />
                </div>
              </Card>
            ))}
            <Divider />
            <Text strong>{t('submissionStatus', { count: detail.attempts?.length || 0 })}</Text>
            <div style={{ marginTop: 8 }}>
              <SessionRoster attempts={detail.attempts || []} students={detail.students || []} onShowSheet={openSheet} />
            </div>
          </>
        )}
      </Modal>

      {/* ── 学生答卷: 逐题作答/批改明细, 主观题可直接改分写评语 ── */}
      <Modal
        title={sheetAttempt
          ? `${sheetAttempt.student_name || sheetAttempt.student_username} · ${t('viewSheet')}`
          : t('viewSheet')}
        open={!!sheetAttempt}
        onCancel={() => setSheetAttempt(null)}
        onOk={saveReview}
        okText={t('saveReview')}
        cancelText={t('cancel')}
        okButtonProps={{ loading: savingReview }}
        width={880}
      >
        {sheetAttempt && (
          <div>
            <Space wrap style={{ marginBottom: 8 }}>
              <Tag>{t('studentId')}：{sheetAttempt.student_username}</Tag>
              <Tag>{t('grade')}：{sheetAttempt.student_grade || '-'}</Tag>
              <Tag>{t('studentClass')}：{classText(sheetAttempt.student_class) || '-'}</Tag>
              <Tag color="blue">{t('totalScoreLabel')}：{sheetAttempt.score}/{sheetAttempt.total_score}</Tag>
              {!!sheetAttempt.teacher_reviewed && <Tag color="green">{t('gradedByTeacher')}</Tag>}
            </Space>
            <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
              {(detail?.questions || []).map((q: any, i: number) => {
                const qid = String(q.question_id ?? q.id)
                const g = (sheetAttempt.graded || {})[qid] || {}
                const d = draft[qid] || { score: Number(g.score ?? 0), comment: '' }
                const mx = Number(g.max_score ?? q.score ?? 0)
                return (
                  <Card key={qid} size="small" style={{ marginBottom: 8 }}
                    title={t('questionN', { n: i + 1 })}
                    extra={
                      <Space size={4} wrap>
                        <Tag>{TYPE_LABELS_LOCAL[q.type] || q.type}</Tag>
                        <Tag color="blue">{t('fullScore')} {mx}</Tag>
                        {isGradingPending(g)
                          ? <Tag color="processing">{t('gradingPending')}</Tag>
                          : (!!g.needs_review && <Tag color="orange">{t('pendingReview')}</Tag>)}
                        <Tag>{t(gradedByKey(g.graded_by))}</Tag>
                      </Space>
                    }
                  >
                    <FormulaRenderer content={q.question_text} />
                    {q.options && Object.entries(q.options).map(([k, v]: [string, any]) => (
                      <div key={k}><Text type="secondary">{k}. <FormulaRenderer content={v as string} inline /></Text></div>
                    ))}
                    <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                      <Text>{t('yourAnswer')}：</Text>
                      <Text type={g.is_correct ? 'success' : 'danger'}>{g.student_answer || t('noHistory')}</Text>
                    </div>
                    <div><Text type="secondary">{t('correctAnswer')}：{g.correct_answer ?? q.correct_answer ?? '-'}</Text></div>
                    {!!g.feedback && (
                      <div style={{ marginTop: 4 }}>
                        <Text type="secondary">{t('aiComment')}：{g.feedback}</Text>
                      </div>
                    )}
                    {!!q.explanation && (
                      <div style={{ marginTop: 4 }}><Text type="secondary">{t('explanationColon')}<FormulaRenderer content={q.explanation} inline /></Text></div>
                    )}
                    <Space align="baseline" style={{ marginTop: 8 }} wrap>
                      <Text>{t('questionScore')}</Text>
                      <InputNumber min={0} max={mx || undefined} step={0.5} value={d.score}
                        style={{ width: 90 }}
                        onChange={(v: any) => setDraft(prev => ({ ...prev, [qid]: { ...d, score: Number(v ?? 0) } }))} />
                      <Text type="secondary">/ {mx}</Text>
                    </Space>
                    <div style={{ marginTop: 6 }}>
                      <Text>{t('teacherComment')}</Text>
                      <TextArea rows={2} value={d.comment} placeholder={t('teacherCommentPlaceholder')}
                        onChange={e => setDraft(prev => ({ ...prev, [qid]: { ...d, comment: e.target.value } }))} />
                    </div>
                  </Card>
                )
              })}
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('reviewNote')}</Text>
          </div>
        )}
      </Modal>
    </div>
  )
}

// ════════════════════════════════════════
// 主入口 — 同时导出供其他组件使用
// ════════════════════════════════════════
const PracticePage: React.FC = () => {
  const user = useAuthStore(s => s.user)
  const isTeacher = user?.role === 'admin' || user?.role === 'teacher'
  return (
    <Card style={{ borderRadius: 8 }}>
      {isTeacher ? <TeacherView /> : <StudentView />}
    </Card>
  )
}

export default PracticePage
export { StudentView, TeacherView }
