/**
 * StudentQuestionsPage — 课堂提问（独立页）
 * 从 InteractionPage 提取，独立的师生问答页面
 */
import { studentLabel } from '../utils/studentLabel'
import React, { useState, useEffect, useRef } from 'react'
import FormulaRenderer from '../components/FormulaRenderer'
import {
  Card, Button, Space, Typography, Tag, Modal,
  Form, Input, Select, message, Empty, Spin, Popconfirm,
  Checkbox,
} from 'antd'
import {
  QuestionCircleOutlined, PlusOutlined,
  SendOutlined, RobotOutlined,
  EditOutlined, DeleteOutlined,
  CheckCircleOutlined, LikeOutlined, PushpinOutlined, StarOutlined, StarFilled,
} from '@ant-design/icons'
import apiClient, { getToken } from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import { reportLoadError } from '../utils/loadError'
import { startPoller, stopPoller } from '../utils/poller'
import { RowList } from '../components/RowList'
import { useSubjectOptions } from '../hooks/useSubjectOptions'
import KnowledgePointSelect from '../components/KnowledgePointSelect'

const { Title, Text } = Typography
const { TextArea } = Input

interface QuestionQuota {
  limit: number
  used: number
  remaining: number
}

/** 幂等键：双击/网络重试复用同一个值，后端只入库一次 */
function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// ── 独立的 QuestionItem 组件，避免在 renderItem 中调用 Hooks ──
interface QuestionItemProps {
  q: any
  isTeacherOrAdmin: boolean
  isStudent: boolean
  t: (key: string, options?: any) => string
  onDelete: (id: number) => void
  onEdit: (q: any) => void
  onAnswerClick: (q: any) => void
  onVote: (q: any) => void
  onPin: (q: any) => void
  onFeature: (q: any) => void
  onResolve: (q: any) => void
  loadQuestions: () => Promise<void>
}

const QuestionItem: React.FC<QuestionItemProps> = ({
  q, isTeacherOrAdmin, isStudent, t, onDelete, onEdit, onAnswerClick,
  onVote, onPin, onFeature, onResolve, loadQuestions,
}) => {
  const qContent = q.content?.length > 50 ? q.content.slice(0, 50) + '...' : q.content
  const [expanded, setExpanded] = React.useState(false)
  const [studentAnswers, setStudentAnswers] = React.useState<any[]>([])
  const [answersLoading, setAnswersLoading] = React.useState(false)
  const [expandedAnswers, setExpandedAnswers] = React.useState<Record<number, boolean>>({})

  const loadStudentAnswers = async (forceRefresh = false) => {
    if (!forceRefresh && expanded) { setExpanded(false); return }
    setAnswersLoading(true)
    try {
      const { data } = await apiClient.get(`/api/interaction/questions/${q.id}/answers`)
      setStudentAnswers(data.answers || [])
      setExpanded(true)
    } catch { message.error(t('loadFailed')) }
    setAnswersLoading(false)
  }

  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <div className="page-header-flex sq-card-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Text strong>{qContent}</Text>
          <div style={{ marginTop: 4 }}>
            {q.is_anonymous && (
              <Tag color={isStudent ? undefined : 'purple'}>
                {isStudent ? t('anonymous') : t('anonymousToClassmates')}
              </Tag>
            )}
            {(!q.is_anonymous || !isStudent) && (q.student_name || q.student_username) && (
              <Tag>{studentLabel(q)}</Tag>
            )}
            {isStudent && q.is_own && <Tag color="blue">{t('myQuestion')}</Tag>}
            {isTeacherOrAdmin && q.pending_answer_count > 0 && (
              <Tag color="red">{t('pendingApprovalCount', { count: q.pending_answer_count })}</Tag>
            )}
            {q.is_pinned && <Tag color="gold">{t('pinned')}</Tag>}
            {q.is_featured && <Tag color="gold">{t('featured')}</Tag>}
            {q.is_resolved && <Tag color="green">{t('resolved')}</Tag>}
            {q.subject && <Tag color="blue">{q.subject}</Tag>}
            {q.knowledge_point && <Tag>{q.knowledge_point}</Tag>}
            {q.followup_count > 0 && <Tag>{t('followups')} {q.followup_count}</Tag>}
            {isTeacherOrAdmin && q.vote_count > 0 && (
              <Tag color="blue">{t('voteCount', { count: q.vote_count })}</Tag>
            )}
            {q.status === 'answered' && <Tag color="green">{t('answeredQuestions')}</Tag>}
            {q.status === 'pending' && <Tag color="orange">{t('pendingQuestions')}</Tag>}
            <Text type="secondary" style={{ fontSize: 12 }}>{q.created_at?.slice(0, 16)}</Text>
            {q.answered_by && q.status === 'answered' && (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {t('answeredBy', { name: q.answered_by })}
              </Text>
            )}
            {q.student_answer_count > 0 && (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {t('studentAnswerCount', { count: q.student_answer_count })}
                {q.approved_answer_count > 0 && t('approvedCount', { approved: q.approved_answer_count })}
              </Text>
            )}
            {isStudent && q.my_answer_status === 'pending_approval' && (
              <Tag color="purple" style={{ marginLeft: 4 }}>{t('myAnswerPending')}</Tag>
            )}
            {isStudent && q.my_answer_status === 'approved' && (
              <Tag color="green" style={{ marginLeft: 4 }}>{t('myAnswerApproved')}</Tag>
            )}
            {isStudent && q.my_answer_status === 'rejected' && (
              <Tag color="red" style={{ marginLeft: 4 }}>{t('myAnswerRejected')}</Tag>
            )}
          </div>
        </div>
        <Space>
          {isStudent && (
            <>
              {!q.is_own && (
                <Button size="small" icon={<LikeOutlined />}
                  type={q.my_voted ? 'primary' : 'default'}
                  onClick={() => onVote(q)}>
                  {t('voteCount', { count: q.vote_count })}
                </Button>
              )}
              <Button size="small" type="primary" icon={<QuestionCircleOutlined />}
                onClick={() => onAnswerClick(q)}>{t('viewDetails')}</Button>
              {!q.is_own && q.status === 'pending' && !q.my_answer_status && (
                <Button size="small" icon={<SendOutlined />}
                  onClick={() => onAnswerClick(q)}>{t('answer')}</Button>
              )}
              {!q.is_own && q.my_answer_status === 'rejected' && (
                <Button size="small" icon={<SendOutlined />}
                  onClick={() => onAnswerClick(q)}>{t('reAnswer')}</Button>
              )}
              {q.is_own && (
                <Button size="small" icon={<EditOutlined />}
                  onClick={() => onEdit(q)}>{t('edit')}</Button>
              )}
              {q.is_own && (
                <Button size="small" type="text" icon={<CheckCircleOutlined />}
                  title={q.is_resolved ? t('unmarkResolved') : t('markResolved')}
                  aria-label={q.is_resolved ? t('unmarkResolved') : t('markResolved')}
                  onClick={() => onResolve(q)} />
              )}
              {q.is_own && (
                <Popconfirm title={t('deleteConfirm')} onConfirm={() => onDelete(q.id)}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              )}
            </>
          )}
          {isTeacherOrAdmin && (
            <>
              <Button size="small"
                type={q.answer ? 'default' : 'primary'}
                icon={<SendOutlined />}
                onClick={() => onAnswerClick(q)}>
                {q.answer ? t('edit') : t('answer')}
              </Button>
              {q.student_answer_count > 0 && (
                <Button size="small" icon={expanded ? <EditOutlined /> : <PlusOutlined />}
                  loading={answersLoading}
                  onClick={() => {
                    if (expanded) { setExpanded(false); return }
                    loadStudentAnswers(true)
                  }}>
                  {expanded ? t('collapse') : t('answerCount', { count: q.student_answer_count })}
                </Button>
              )}
              <Button size="small" type="text" icon={<PushpinOutlined />}
                title={q.is_pinned ? t('unpinQuestion') : t('pinQuestion')}
                aria-label={q.is_pinned ? t('unpinQuestion') : t('pinQuestion')}
                onClick={() => onPin(q)} />
              <Button size="small" type="text"
                icon={q.is_featured ? <StarFilled /> : <StarOutlined />}
                title={q.is_featured ? t('unfeatureQuestion') : t('featureQuestion')}
                aria-label={q.is_featured ? t('unfeatureQuestion') : t('featureQuestion')}
                onClick={() => onFeature(q)} />
              <Button size="small" type="text" icon={<CheckCircleOutlined />}
                title={q.is_resolved ? t('unmarkResolved') : t('markResolved')}
                aria-label={q.is_resolved ? t('unmarkResolved') : t('markResolved')}
                onClick={() => onResolve(q)} />
              <Popconfirm title={t('deleteConfirm')} onConfirm={() => onDelete(q.id)}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      </div>
      {/* 展开的学生回答列表（教师端） */}
      {expanded && isTeacherOrAdmin && (
        <div style={{ marginTop: 8, paddingLeft: 16, borderLeft: '2px solid var(--border-color-secondary)' }}>
          {studentAnswers.length === 0 ? (
            <Text type="secondary">{t('noStudentAnswers')}</Text>
          ) : (
            studentAnswers.map((sa: any) => (
              <div key={sa.id} style={{
                marginBottom: 8, padding: 8, borderRadius: 4,
                background: sa.status === 'approved' ? '#f6ffed' :
                           sa.status === 'rejected' ? '#fff2f0' : '#fffbe6',
                border: '1px solid',
                borderColor: sa.status === 'approved' ? '#b7eb8f' :
                            sa.status === 'rejected' ? '#ffccc7' : '#ffe58f',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Text strong style={{ fontSize: 13 }}>{studentLabel(sa)}</Text>
                  <Space size="small">
                    {sa.status === 'pending_approval' && (
                      <>
                        <Button size="small" type="primary"
                          icon={<CheckCircleOutlined />}
                          onClick={async () => {
                            try {
                              await apiClient.put(`/api/interaction/questions/${q.id}/answers/${sa.id}/approve`)
                              message.success(t('approved'))
                              await loadStudentAnswers(true)
                              await loadQuestions()
                            } catch { message.error(t('operationFail')) }
                          }}>{t('approve')}</Button>
                        <Popconfirm title={t('rejectConfirm')} onConfirm={async () => {
                          try {
                            await apiClient.put(`/api/interaction/questions/${q.id}/answers/${sa.id}/reject`)
                            message.success(t('rejected'))
                            await loadStudentAnswers(true)
                            await loadQuestions()
                          } catch { message.error(t('operationFail')) }
                        }}>
                          <Button size="small" danger icon={<DeleteOutlined />}>{t('reject')}</Button>
                        </Popconfirm>
                      </>
                    )}
                    {sa.status === 'approved' && <Tag color="green">{t('approved')}</Tag>}
                    {sa.status === 'rejected' && <Tag color="red">{t('rejected')}</Tag>}
                  </Space>
                </div>
                <div style={{
                  marginTop: 4, fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: expandedAnswers[sa.id] ? 'none' : '72px',
                  overflow: 'hidden',
                  transition: 'max-height 0.2s',
                  lineHeight: '22px',
                  display: 'block',
                }}>
                  {sa.answer}
                </div>
                {sa.answer?.length > 80 && (
                  <Button type="link" size="small" style={{ padding: 0, height: 20, fontSize: 12 }}
                    onClick={() => setExpandedAnswers(prev => ({ ...prev, [sa.id]: !prev[sa.id] }))}>
                    {expandedAnswers[sa.id] ? t('collapse') : t('expandFull')}
                  </Button>
                )}
                <div style={{ marginTop: 2 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {sa.created_at?.slice(0, 16)}
                  </Text>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  )
}

// ── 提问输入区：内联在页面顶部，提交中状态直接可见 ──
interface AskQuestionFormProps {
  form: any
  submitting: boolean
  quota: QuestionQuota | null
  subjects: string[]
  t: (key: string, options?: any) => string
  onSubmit: (values: any) => void
  onValuesChange: () => void
}

const AskQuestionForm: React.FC<AskQuestionFormProps> = ({
  form, submitting, quota, subjects, t, onSubmit, onValuesChange,
}) => {
  const exhausted = !!quota && quota.remaining <= 0
  const subjectValue = Form.useWatch('subject', form) || ''
  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={onSubmit}
      onValuesChange={onValuesChange}
      disabled={submitting}
    >
      <Form.Item
        name="content"
        label={t('questionContent')}
        style={{ marginBottom: 28 }}
        rules={[
          { required: true, whitespace: true, message: t('enterAskContent') },
          { max: 500, message: t('questionTooLong') },
        ]}
      >
        <TextArea
          id="ask-question-input"
          autoSize={{ minRows: 3, maxRows: 6 }}
          maxLength={500}
          showCount
          placeholder={t('inputQuestion')}
          disabled={submitting}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              form.submit()
            }
          }}
        />
      </Form.Item>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Form.Item name="subject" label={t('subjectLabel')}
          style={{ flex: '1 1 180px', marginBottom: 12 }}>
          <Select
            allowClear
            disabled={submitting}
            placeholder={t('subjectPlaceholder')}
            options={subjects.map(s => ({ label: s, value: s }))}
          />
        </Form.Item>
        <Form.Item name="knowledge_point" label={t('knowledgePointLabel')}
          style={{ flex: '1 1 240px', marginBottom: 12 }}>
          <KnowledgePointSelect
            multiple={false}
            subject={subjectValue}
            disabled={submitting}
            style={{ width: '100%' }}
          />
        </Form.Item>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Form.Item name="is_anonymous" valuePropName="checked" noStyle>
          <Checkbox disabled={submitting}>{t('anonymousAsk')}</Checkbox>
        </Form.Item>
        <Space size="middle" wrap>
          {quota && (
            <Text type={exhausted ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
              {exhausted
                ? t('quotaExhausted')
                : t('quotaLabel', { remaining: quota.remaining, limit: quota.limit })}
            </Text>
          )}
          <Button
            type="primary"
            htmlType="submit"
            loading={submitting}
            disabled={submitting || exhausted}
          >
            {submitting ? t('submittingQuestion') : t('submitQuestion')}
          </Button>
        </Space>
      </div>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
        {submitting ? t('reviewHintSubmitting') : t('reviewHint')}
      </Text>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
        {t('scopeHint')}
      </Text>
    </Form>
  )
}

const StudentQuestionsPage: React.FC = () => {
  const { t } = useTranslation('questions')
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'
  const { subjects } = useSubjectOptions()

  // ── 提问 ──
  const [questions, setQuestions] = useState<any[]>([])
  const [questionTotal, setQuestionTotal] = useState(0)
  const [questionFilter, setQuestionFilter] = useState<string>('')
  const [mineOnly, setMineOnly] = useState(false)
  const [teacherClasses, setTeacherClasses] = useState<any[]>([])
  const [classFilter, setClassFilter] = useState('')
  const [subjectFilter, setSubjectFilter] = useState('')
  const [timeRange, setTimeRange] = useState('')
  const [unresolvedOnly, setUnresolvedOnly] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [answerPending, setAnswerPending] = useState(false)
  const [sortBy, setSortBy] = useState('newest')
  const [questionLoading, setQuestionLoading] = useState(false)
  const [quota, setQuota] = useState<QuestionQuota | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const requestIdRef = useRef(newRequestId())
  const loadSeqRef = useRef(0)
  const refreshQuestionsRef = useRef<() => void>(() => {})
  const [answerModal, setAnswerModal] = useState<any>(null)
  const [answerText, setAnswerText] = useState('')
  const [answerSubmitting, setAnswerSubmitting] = useState(false)
  const [aiSuggesting, setAiSuggesting] = useState(false)
  const [askForm] = Form.useForm()
  // 弹窗中展示的学生回答列表
  const [modalAnswers, setModalAnswers] = useState<any[]>([])
  const [modalOwnAnswer, setModalOwnAnswer] = useState<any>(null)
  const [modalAnswersLoading, setModalAnswersLoading] = useState(false)
  const [modalAnswersReload, setModalAnswersReload] = useState(0)
  const [modalAnswerAction, setModalAnswerAction] = useState<string | null>(null)
  const [followups, setFollowups] = useState<any[]>([])
  const [followupText, setFollowupText] = useState('')
  const [followupLoading, setFollowupLoading] = useState(false)
  const [followupSubmitting, setFollowupSubmitting] = useState(false)
  const [followupReload, setFollowupReload] = useState(0)
  const [modalExpandedAnswers, setModalExpandedAnswers] = useState<Record<number, boolean>>({})
  // 分页
  const [questionPage, setQuestionPage] = useState(1)
  const [questionPageSize, setQuestionPageSize] = useState(10)
  // 编辑
  const [editQuestionModal, setEditQuestionModal] = useState<any>(null)
  const [editQuestionForm] = Form.useForm()

  // 打开详情弹窗时，加载已通过的学生回答
  useEffect(() => {
    if (!answerModal?.id) {
      setModalAnswers([]); setModalOwnAnswer(null); setModalExpandedAnswers({}); return
    }
    (async () => {
      setModalAnswersLoading(true)
      try {
        const { data } = await apiClient.get(`/api/interaction/questions/${answerModal.id}/answers`)
        const all = data.answers || []
        // 教师看全部状态（含待审批），学生只看已通过 + 自己的
        setModalAnswers(isTeacherOrAdmin ? all : all.filter((a: any) => a.status === 'approved'))
        setModalOwnAnswer(
          all.find((a: any) => a.student_username === user?.username && a.status !== 'approved') || null,
        )
      } catch (err) { reportLoadError(err, { key: 'studentQuestions.answers' }) }
      setModalAnswersLoading(false)
    })()
  }, [answerModal?.id, user?.username, isTeacherOrAdmin, modalAnswersReload])

  useEffect(() => {
    if (!answerModal?.id) {
      setFollowups([])
      setFollowupText('')
      return
    }
    (async () => {
      setFollowupLoading(true)
      try {
        const { data } = await apiClient.get(
          `/api/interaction/questions/${answerModal.id}/followups`,
        )
        setFollowups(data.followups || [])
      } catch (err) {
        reportLoadError(err, { key: 'studentQuestions.followups' })
      } finally {
        setFollowupLoading(false)
      }
    })()
  }, [answerModal?.id, followupReload])

  // ── 加载数据 ──
  const loadQuestions = async (
    page?: number, pageSize?: number, filter?: string, mine?: boolean, silent = false,
  ) => {
    const p = page ?? questionPage
    const ps = pageSize ?? questionPageSize
    const f = filter !== undefined ? filter : questionFilter
    const m = mine !== undefined ? mine : mineOnly
    const seq = ++loadSeqRef.current
    if (!silent) setQuestionLoading(true)
    try {
      const params: Record<string, any> = { page: p, page_size: ps, mine: m }
      if (f) params.status = f
      if (!isStudent && classFilter) {
        const [gid, cid] = classFilter.split(':')
        if (gid) params.grade_id = Number(gid)
        if (cid) params.class_id = Number(cid)
      }
      if (keyword.trim()) params.keyword = keyword.trim()
      if (!isStudent && answerPending) params.answer_pending = true
      if (subjectFilter) params.subject = subjectFilter
      if (timeRange) params.time_range = timeRange
      if (unresolvedOnly) params.unresolved = true
      if (sortBy) params.sort = sortBy
      const { data } = await apiClient.get('/api/interaction/questions', { params })
      // 自动刷新/翻页并发时，只接受最后一次请求的结果
      if (seq === loadSeqRef.current && data) {
        setQuestions(data.questions || [])
        setQuestionTotal(data.total || 0)
        if (data.quota) setQuota(data.quota)
        if (data.teacher_classes) setTeacherClasses(data.teacher_classes)
      }
    } catch (e) {
      if (seq === loadSeqRef.current) {
        reportLoadError(e, {
          key: 'studentQuestions.list',
          retry: () => { void loadQuestions(p, ps, f, m) },
        })
      }
    } finally {
      if (seq === loadSeqRef.current) setQuestionLoading(false)
    }
  }

  useEffect(() => {
    setQuestionPage(1)
    loadQuestions(1, questionPageSize, questionFilter, mineOnly)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionFilter, mineOnly, keyword, classFilter, answerPending, sortBy,
      subjectFilter, timeRange, unresolvedOnly])

  // 老师回答/同学回答后列表自动刷新；后台标签页由 poller 自动暂停
  useEffect(() => {
    if (!user?.username) return
    const key = `student-questions:${user.username}`
    startPoller(
      key,
      () => loadQuestions(questionPage, questionPageSize, questionFilter, mineOnly, true),
      30_000,
      { immediate: false },
    )
    return () => stopPoller(key)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.username, questionPage, questionPageSize, questionFilter, mineOnly,
      classFilter, keyword, answerPending, sortBy, subjectFilter, timeRange, unresolvedOnly])

  // 实时推送：新提问/新回答/审批/置顶/点赞/追问都触发一次静默刷新
  useEffect(() => {
    if (!user?.username) return
    let closed = false
    let socket: WebSocket | null = null
    let reconnectTimer: number | undefined
    let pingTimer: number | undefined
    let refreshTimer: number | undefined

    const connect = () => {
      if (closed) return
      const token = getToken()
      if (!token) return
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(
        `${proto}//${window.location.host}/api/interaction/questions/ws?token=${encodeURIComponent(token)}`,
      )
      socket.onopen = () => {
        if (pingTimer) window.clearInterval(pingTimer)
        pingTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send('ping')
        }, 25_000)
        refreshQuestionsRef.current()
      }
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          if (typeof msg?.type !== 'string' || !msg.type.startsWith('question_')) return
        } catch {
          return
        }
        if (refreshTimer) return
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          refreshQuestionsRef.current()
        }, 300)
      }
      socket.onclose = (event) => {
        if (pingTimer) window.clearInterval(pingTimer)
        // 未认证/无权限不要无限重连
        if (!closed && event.code !== 4401 && event.code !== 4403) {
          reconnectTimer = window.setTimeout(connect, 5000)
        }
      }
      socket.onerror = () => socket?.close()
    }

    connect()
    return () => {
      closed = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      if (pingTimer) window.clearInterval(pingTimer)
      if (refreshTimer) window.clearTimeout(refreshTimer)
      socket?.close()
    }
  }, [user?.username])

  useEffect(() => {
    refreshQuestionsRef.current = () => {
      void loadQuestions(questionPage, questionPageSize, questionFilter, mineOnly, true)
    }
  })

  // ── 提问 ──
  const handleAskQuestion = async (values: any) => {
    if (submittingRef.current) return
    if (quota && quota.remaining <= 0) {
      message.warning(t('quotaExhausted'))
      return
    }
    const content = String(values?.content || '').trim()
    if (!content) {
      message.warning(t('enterAskContent'))
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    try {
      const { data } = await apiClient.post(
        '/api/interaction/questions',
        {
          content,
          is_anonymous: values.is_anonymous || false,
          subject: values.subject || '',
          knowledge_point: (values.knowledge_point || '').trim(),
          client_request_id: requestIdRef.current,
        },
        { timeout: 60000 },
      )
      if (data?.duplicate) message.info(t('duplicateSubmit'))
      else message.success(t('submitSuccess'))
      askForm.resetFields()
      requestIdRef.current = newRequestId()
      // 正在看「已回答」时，新问题不会落进当前筛选；切回全部并回到第一页
      const nextFilter = questionFilter === 'answered' ? '' : questionFilter
      setQuestionFilter(nextFilter)
      setQuestionPage(1)
      await loadQuestions(1, questionPageSize, nextFilter, mineOnly)
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      const timedOut = err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT'
      message.error(timedOut ? t('submitTimeout') : (detail || t('submitFail')))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  // ── 回答 ──
  const handleAnswerQuestion = async (qId: number) => {
    if (!answerText.trim()) { message.warning(t('enterAnswer')); return }
    if (answerSubmitting) return
    setAnswerSubmitting(true)
    try {
      await apiClient.put(`/api/interaction/questions/${qId}/answer`, { answer: answerText })
      const isStudentAnswer = !isTeacherOrAdmin
      message.success(isStudentAnswer ? t('answerSubmitted') : t('answerSuccess'))
      setAnswerModal(null)
      setAnswerText('')
      await loadQuestions()
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      message.error(detail || t('answerFail'))
    } finally {
      setAnswerSubmitting(false)
    }
  }

  // ── AI 建议回答 ──
  const handleAiSuggestAnswer = async (qId: number) => {
    if (aiSuggesting) return
    setAiSuggesting(true)
    try {
      const { data } = await apiClient.post(`/api/interaction/questions/${qId}/ai-suggest`, null, { timeout: 180000 })
      if (data.suggested_answer) {
        setAnswerText(data.suggested_answer)
        message.success(t('aiSuggestedAnswer'))
      }
    } catch { message.error(t('aiSuggestFail')) }
    finally { setAiSuggesting(false) }
  }

  // ── 教师：在详情弹窗内直接审批学生回答 ──
  const handleApproveModalAnswer = async (answerId: number) => {
    if (!answerModal?.id || modalAnswerAction) return
    setModalAnswerAction(`approve-${answerId}`)
    try {
      await apiClient.put(`/api/interaction/questions/${answerModal.id}/answers/${answerId}/approve`)
      message.success(t('approved'))
      setModalAnswersReload(v => v + 1)
      await loadQuestions()
    } catch { message.error(t('operationFail')) }
    finally { setModalAnswerAction(null) }
  }

  const handleRejectModalAnswer = async (answerId: number) => {
    if (!answerModal?.id || modalAnswerAction) return
    setModalAnswerAction(`reject-${answerId}`)
    try {
      await apiClient.put(`/api/interaction/questions/${answerModal.id}/answers/${answerId}/reject`)
      message.success(t('rejected'))
      setModalAnswersReload(v => v + 1)
      await loadQuestions()
    } catch { message.error(t('operationFail')) }
    finally { setModalAnswerAction(null) }
  }

  // ── 我也想问 / 置顶 / 已解决 ──
  const handleVoteQuestion = async (q: any) => {
    try {
      const { data } = await apiClient.post(`/api/interaction/questions/${q.id}/vote`)
      setQuestions(prev => prev.map(item => item.id === q.id
        ? { ...item, vote_count: data.vote_count, my_voted: data.voted }
        : item))
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('operationFail'))
    }
  }

  const handlePinQuestion = async (q: any) => {
    try {
      await apiClient.put(`/api/interaction/questions/${q.id}/pin`, { pinned: !q.is_pinned })
      message.success(!q.is_pinned ? t('pinQuestion') : t('unpinQuestion'))
      await loadQuestions()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('operationFail'))
    }
  }

  const handleFeatureQuestion = async (q: any) => {
    try {
      await apiClient.put(`/api/interaction/questions/${q.id}/feature`, { featured: !q.is_featured })
      message.success(!q.is_featured ? t('featureQuestion') : t('unfeatureQuestion'))
      await loadQuestions()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('operationFail'))
    }
  }

  const handleResolveQuestion = async (q: any) => {
    try {
      await apiClient.put(`/api/interaction/questions/${q.id}/resolve`, { resolved: !q.is_resolved })
      message.success(!q.is_resolved ? t('markResolved') : t('unmarkResolved'))
      await loadQuestions()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('operationFail'))
    }
  }

  const handleSendFollowup = async () => {
    if (!answerModal?.id || followupSubmitting) return
    const content = followupText.trim()
    if (!content) return
    setFollowupSubmitting(true)
    try {
      await apiClient.post(
        `/api/interaction/questions/${answerModal.id}/followups`,
        { content },
        { timeout: 60000 },
      )
      setFollowupText('')
      setFollowupReload(v => v + 1)
      await loadQuestions()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('operationFail'))
    } finally {
      setFollowupSubmitting(false)
    }
  }

  // ── 删除 ──
  const handleDeleteQuestion = async (id: number) => {
    try {
      await apiClient.delete(`/api/interaction/questions/${id}`)
      message.success(t('deleteSuccess'))
      setQuestions(prev => prev.filter(q => q.id !== id))
      setQuestionTotal(prev => Math.max(0, prev - 1))
    } catch (err: any) { message.error(err?.response?.data?.detail || t('deleteFail')) }
  }

  // ── 编辑 ──
  const handleEditQuestion = async () => {
    const values = await editQuestionForm.validateFields()
    try {
      await apiClient.put(`/api/interaction/questions/${editQuestionModal.id}`, { content: values.content })
      message.success(t('updated'))
      setEditQuestionModal(null)
      setQuestions(prev => prev.map(q => q.id === editQuestionModal.id ? { ...q, content: values.content } : q))
    } catch (err: any) { message.error(err?.response?.data?.detail || t('updateFail')) }
  }

  return (
    <Card style={{ borderRadius: 8 }}>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div className="page-header-flex" style={{ color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <QuestionCircleOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>{t('studentQuestions')}</Title>
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 12 }}>
              {isStudent ? t('subtitle') : t('teacherSubtitle')}
            </Text>
          </Space>
        </div>
      </Card>

      {isStudent && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <AskQuestionForm
            form={askForm}
            submitting={submitting}
            quota={quota}
            subjects={subjects}
            t={t}
            onSubmit={handleAskQuestion}
            onValuesChange={() => { requestIdRef.current = newRequestId() }}
          />
        </Card>
      )}

      <Card>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <Space wrap>
            {isStudent && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={!!quota && quota.remaining <= 0}
                onClick={() => {
                  document.getElementById('ask-question-input')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  window.setTimeout(() => document.getElementById('ask-question-input')?.focus(), 250)
                }}
              >
                {t('askQuestion')}
              </Button>
            )}
          </Space>
          <Space wrap>
            <Select
              value={sortBy}
              onChange={(val) => {
                setSortBy(val)
                setQuestionPage(1)
              }}
              style={{ width: 120 }}
              options={[
                { label: t('sortNewest'), value: 'newest' },
                { label: t('sortHot'), value: 'hot' },
                { label: t('sortPendingFirst'), value: 'pending_first' },
                { label: t('sortOldest'), value: 'oldest' },
              ]}
            />
            {!isStudent && teacherClasses.length > 1 && (
              <Select
                value={classFilter}
                onChange={(val) => {
                  setClassFilter(val)
                  setQuestionPage(1)
                }}
                style={{ width: 150 }}
                options={[
                  { label: t('allClasses'), value: '' },
                  ...teacherClasses.map((c: any) => ({
                    label: c.class_id
                      ? (c.class_name || c.grade_name || '')
                      : `${c.grade_name || ''}（${t('wholeGrade')}）`,
                    value: `${c.grade_id}:${c.class_id ?? ''}`,
                  })),
                ]}
              />
            )}
            <Select
              value={subjectFilter}
              onChange={(val) => {
                setSubjectFilter(val)
                setQuestionPage(1)
              }}
              style={{ width: 120 }}
              options={[
                { label: t('allSubjects'), value: '' },
                ...subjects.map(s => ({ label: s, value: s })),
              ]}
            />
            <Select
              value={timeRange}
              onChange={(val) => {
                setTimeRange(val)
                setQuestionPage(1)
              }}
              style={{ width: 110 }}
              options={[
                { label: t('allTime'), value: '' },
                { label: t('last7Days'), value: '7d' },
                { label: t('last30Days'), value: '30d' },
                { label: t('last180Days'), value: '180d' },
              ]}
            />
            <Input.Search
              allowClear
              placeholder={t('searchQuestionPlaceholder')}
              style={{ width: 170 }}
              onChange={(e) => {
                if (!e.target.value) {
                  setKeyword('')
                  setQuestionPage(1)
                }
              }}
              onSearch={(val) => {
                setKeyword(val.trim())
                setQuestionPage(1)
              }}
            />
            {isStudent && (
              <Checkbox
                checked={mineOnly}
                onChange={(e) => {
                  setMineOnly(e.target.checked)
                  setQuestionPage(1)
                }}
              >
                {t('onlyMine')}
              </Checkbox>
            )}
            {!isStudent && (
              <Checkbox
                checked={answerPending}
                onChange={(e) => {
                  setAnswerPending(e.target.checked)
                  setQuestionPage(1)
                }}
              >
                {t('pendingApprovalOnly')}
              </Checkbox>
            )}
            <Checkbox
              checked={unresolvedOnly}
              onChange={(e) => {
                setUnresolvedOnly(e.target.checked)
                setQuestionPage(1)
              }}
            >
              {t('unresolvedOnly')}
            </Checkbox>
            <Text type="secondary">{t('statusLabel')}</Text>
            <Select
              value={questionFilter || 'all'}
              onChange={(val) => {
                const newFilter = val === 'all' ? '' : val
                setQuestionFilter(newFilter)
                setQuestionPage(1)
              }}
              style={{ width: 100 }}
              options={[
                { label: t('allStatus'), value: 'all' },
                { label: t('pendingQuestions'), value: 'pending' },
                { label: t('answeredQuestions'), value: 'answered' },
              ]}
            />
          </Space>
        </div>

        <Spin spinning={questionLoading}>
          {questions.length === 0 ? <Empty description={t('noQuestions')} /> : (
            <RowList
              items={questions}
              split={false}
              renderItem={(q: any) => (
                <QuestionItem
                  q={q}
                  isTeacherOrAdmin={isTeacherOrAdmin}
                  isStudent={isStudent}
                  t={t}
                  onDelete={handleDeleteQuestion}
                  onEdit={(question) => {
                    editQuestionForm.setFieldsValue({ content: question.content })
                    setEditQuestionModal(question)
                  }}
                  onAnswerClick={(question) => {
                    setAnswerText(question.answer || '')
                    setAnswerModal(question)
                  }}
                  onVote={handleVoteQuestion}
                  onPin={handlePinQuestion}
                  onFeature={handleFeatureQuestion}
                  onResolve={handleResolveQuestion}
                  loadQuestions={() => loadQuestions()}
                />
              )}
            />
          )}
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            {questions.length > 0 && (
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 13, marginRight: 12 }}>{t('totalQuestions', { count: questionTotal })}</span>
                <button
                  style={{ border: '1px solid var(--border-color-secondary)', background: 'var(--bg-container)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', margin: '0 4px', fontSize: 13, color: questionPage <= 1 ? '#d9d9d9' : '#333' }}
                  disabled={questionPage <= 1}
                  onClick={() => {
                    const newPage = questionPage - 1
                    setQuestionPage(newPage)
                    loadQuestions(newPage, questionPageSize, questionFilter, mineOnly)
                  }}
                >{t('prevPage')}</button>
                <span style={{ margin: '0 8px', fontSize: 13 }}>{questionPage}</span>
                <button
                  style={{ border: '1px solid var(--border-color-secondary)', background: 'var(--bg-container)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', margin: '0 4px', fontSize: 13, color: questionPage * questionPageSize >= questionTotal ? '#d9d9d9' : '#333' }}
                  disabled={questionPage * questionPageSize >= questionTotal}
                  onClick={() => {
                    const newPage = questionPage + 1
                    setQuestionPage(newPage)
                    loadQuestions(newPage, questionPageSize, questionFilter, mineOnly)
                  }}
                >{t('nextPage')}</button>
              </div>
            )}
          </div>
        </Spin>
      </Card>

      {/* ── 编辑提问弹窗 ── */}
      <Modal maskClosable={false} title={t('editQuestionTitle')} open={!!editQuestionModal} onCancel={() => setEditQuestionModal(null)}
        onOk={handleEditQuestion} okText={t('save')}>
        <Form form={editQuestionForm} layout="vertical">
          <Form.Item name="content" label={t('contentLabel')} rules={[
            { required: true, whitespace: true, message: t('enterAskContent') },
            { max: 500, message: t('questionTooLong') },
          ]}>
            <TextArea rows={4} maxLength={500} showCount placeholder={t('markdownPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 提问详情/回答弹窗 ── */}
      <Modal title={t('questionDetail')} open={!!answerModal} onCancel={() => setAnswerModal(null)}
        footer={isTeacherOrAdmin ? [
          <Button key="cancel" onClick={() => setAnswerModal(null)} disabled={answerSubmitting}>{t('cancel')}</Button>,
          <Button key="aisuggest" icon={<RobotOutlined />} loading={aiSuggesting}
            disabled={aiSuggesting || answerSubmitting}
            onClick={() => handleAiSuggestAnswer(answerModal?.id)}>
            {t('aiSuggest')}
          </Button>,
          <Button key="submit" type="primary" loading={answerSubmitting}
            disabled={answerSubmitting || !answerText.trim()}
            onClick={() => handleAnswerQuestion(answerModal?.id)}>
            {answerModal?.status === 'answered' ? t('updateAnswer') : t('submitAnswer')}
          </Button>,
        ] : [
          <Button key="close" onClick={() => setAnswerModal(null)} disabled={answerSubmitting}>{t('close')}</Button>,
          ...(answerModal?.status === 'pending' && !answerModal?.is_own
            ? [<Button key="submit" type="primary" loading={answerSubmitting}
                disabled={answerSubmitting || !answerText.trim()}
                onClick={() => handleAnswerQuestion(answerModal?.id)}>{t('submitAnswer')}</Button>]
            : []),
        ]}
        width={640}>
        {/* 问题信息 */}
        <Card size="small" style={{ marginBottom: 12, background: 'var(--bg-layout)' }}>
          <div style={{ marginBottom: 8 }}>
            {answerModal?.is_anonymous && (
              <Tag color={isTeacherOrAdmin ? 'purple' : undefined}>
                {isTeacherOrAdmin ? t('anonymousToClassmates') : t('anonymous')}
              </Tag>
            )}
            {(!answerModal?.is_anonymous || isTeacherOrAdmin)
              && (answerModal?.student_name || answerModal?.student_username) && (
              <Tag>{studentLabel(answerModal)}</Tag>
            )}
            {answerModal?.status === 'answered' && <Tag color="green">{t('answeredQuestions')}</Tag>}
            {answerModal?.status === 'pending' && <Tag color="orange">{t('pendingQuestions')}</Tag>}
            <Text type="secondary" style={{ fontSize: 12 }}>{answerModal?.created_at?.slice(0, 16)}</Text>
            {answerModal?.answered_at && (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {t('answeredAt', { time: answerModal.answered_at?.slice(0, 16) })}
              </Text>
            )}
          </div>
          <div className="markdown-content">
            <FormulaRenderer content={answerModal?.content || ''} />
          </div>
        </Card>
        {/* 统一回答展示区：教师回答 + 已通过的学生回答 */}
        {(answerModal?.answer || modalAnswers.length > 0 || (isStudent && modalOwnAnswer)) && (
          <div style={{ marginBottom: 12 }}>
            <Text strong style={{ fontSize: 14 }}>{t('answer_')}</Text>
            {answerModal?.answer && (
              <div style={{
                marginTop: 8, padding: 10, borderRadius: 6,
                background: '#e6f4ff', border: '1px solid #91caff',
              }}>
                <div style={{ marginBottom: 4 }}>
                  <Text strong style={{ fontSize: 13 }}>{t('teacherLabel', { name: answerModal.answered_by || '' })}</Text>
                  <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                    {answerModal.answered_at?.slice(0, 16)}
                  </Text>
                </div>
                <div className="markdown-content">
                  <FormulaRenderer content={answerModal.answer} />
                </div>
              </div>
            )}
            {modalAnswers.map((ma: any) => {
              const isApproved = ma.status === 'approved'
              const isRejected = ma.status === 'rejected'
              return (
              <div key={ma.id} style={{
                marginTop: 8, padding: 10, borderRadius: 6,
                background: isApproved ? '#f6ffed' : isRejected ? '#fff2f0' : '#fffbe6',
                border: `1px solid ${isApproved ? '#b7eb8f' : isRejected ? '#ffccc7' : '#ffe58f'}`,
              }}>
                <div style={{ marginBottom: 4, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div>
                    <Text strong style={{ fontSize: 13 }}>{ma.student_username}</Text>
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                      {ma.created_at?.slice(0, 16)}
                    </Text>
                    {ma.status === 'pending_approval' && <Tag color="orange" style={{ marginLeft: 4 }}>{t('pendingApproval')}</Tag>}
                    {isApproved && <Tag color="green" style={{ marginLeft: 4 }}>{t('approved')}</Tag>}
                    {isRejected && <Tag color="red" style={{ marginLeft: 4 }}>{t('rejected')}</Tag>}
                  </div>
                  {isTeacherOrAdmin && ma.status === 'pending_approval' && (
                    <Space size="small">
                      <Button size="small" type="primary" icon={<CheckCircleOutlined />}
                        loading={modalAnswerAction === `approve-${ma.id}`}
                        disabled={!!modalAnswerAction && modalAnswerAction !== `approve-${ma.id}`}
                        onClick={() => handleApproveModalAnswer(ma.id)}>{t('approve')}</Button>
                      <Popconfirm title={t('rejectConfirm')} onConfirm={() => handleRejectModalAnswer(ma.id)}>
                        <Button size="small" danger icon={<DeleteOutlined />}
                          loading={modalAnswerAction === `reject-${ma.id}`}
                          disabled={!!modalAnswerAction && modalAnswerAction !== `reject-${ma.id}`}>
                          {t('reject')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  )}
                </div>
                <div style={{
                  fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: modalExpandedAnswers[ma.id] ? 'none' : '72px',
                  overflow: 'hidden',
                  transition: 'max-height 0.2s',
                  lineHeight: '22px',
                  display: 'block',
                }}>{ma.answer}</div>
                {ma.answer?.length > 80 && (
                  <Button type="link" size="small" style={{ padding: 0, height: 20, fontSize: 12 }}
                    onClick={() => setModalExpandedAnswers(prev => ({ ...prev, [ma.id]: !prev[ma.id] }))}>
                    {modalExpandedAnswers[ma.id] ? t('collapse') : t('expandFull')}
                  </Button>
                )}
              </div>
              )
            })}
            {isStudent && modalOwnAnswer && (
              <div style={{
                marginTop: 8, padding: 10, borderRadius: 6,
                background: modalOwnAnswer.status === 'rejected' ? '#fff2f0' : '#fffbe6',
                border: `1px solid ${modalOwnAnswer.status === 'rejected' ? '#ffccc7' : '#ffe58f'}`,
              }}>
                <div style={{ marginBottom: 4 }}>
                  <Tag color={modalOwnAnswer.status === 'rejected' ? 'red' : 'purple'}>
                    {modalOwnAnswer.status === 'rejected' ? t('myAnswerRejected') : t('myAnswerPending')}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {modalOwnAnswer.created_at?.slice(0, 16)}
                  </Text>
                </div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {modalOwnAnswer.answer}
                </div>
              </div>
            )}
          </div>
        )}
        {isStudent && answerModal?.is_own && answerModal?.status === 'pending'
          && !answerModal?.answer && !modalOwnAnswer && (
          <Text type="secondary" style={{ fontSize: 12 }}>{t('waitingTeacherAnswer')}</Text>
        )}
        {/* 追问 */}
        <div style={{ marginTop: 12 }}>
          <Text strong style={{ fontSize: 14 }}>{t('followups')}</Text>
          <Spin spinning={followupLoading}>
            {followups.length === 0 ? (
              <div style={{ marginTop: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('noFollowups')}</Text>
              </div>
            ) : followups.map((f: any) => (
              <div key={f.id} style={{
                marginTop: 8, padding: 8, borderRadius: 4,
                background: 'var(--bg-layout)',
                border: '1px solid var(--border-color-secondary)',
              }}>
                <div style={{ marginBottom: 4 }}>
                  <Text strong style={{ fontSize: 12 }}>{studentLabel(f)}</Text>
                  <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                    {f.created_at?.slice(0, 16)}
                  </Text>
                </div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {f.content}
                </div>
              </div>
            ))}
          </Spin>
          {(isTeacherOrAdmin || answerModal?.is_own) && (
            <div style={{ marginTop: 8 }}>
              <TextArea
                rows={2}
                maxLength={500}
                showCount
                value={followupText}
                onChange={(e) => setFollowupText(e.target.value)}
                placeholder={t('followupPlaceholder')}
                disabled={followupSubmitting}
              />
              <Button type="primary" size="small" style={{ marginTop: 6 }}
                loading={followupSubmitting}
                disabled={followupSubmitting || !followupText.trim()}
                onClick={handleSendFollowup}>
                {t('sendFollowup')}
              </Button>
            </div>
          )}
        </div>
        {/* 回答编辑区 */}
        {(isTeacherOrAdmin || (answerModal?.status === 'pending' && !answerModal?.is_own) || answerModal?.my_answer_status === 'rejected') && (
          <div style={{ marginTop: 12 }}>
            <Text strong>
              {answerModal?.status === 'answered' ? t('editAnswer') : t('writeAnswer')}
            </Text>
            <TextArea rows={4} value={answerText} onChange={(e) => setAnswerText(e.target.value)}
              placeholder={t('answerPlaceholder')} style={{ marginTop: 8 }}
              disabled={answerSubmitting} />
          </div>
        )}
      </Modal>
    </Card>
  )
}

export default StudentQuestionsPage
