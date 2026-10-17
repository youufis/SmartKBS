import React, { useEffect, useRef, useState } from 'react'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import {
  Card, Tabs, Button, Space, Typography, Tag, Modal,
  Form, Input, InputNumber, Select, message, Empty, Spin, Radio, Result,
  Statistic, Row, Col, Table, Progress, Popconfirm, Checkbox, Pagination, Tooltip,
  Alert, Segmented,
} from 'antd'
import {
  ThunderboltOutlined, BarChartOutlined,
  PlusOutlined, PlayCircleOutlined, PauseCircleOutlined, RedoOutlined,
  RobotOutlined,
  EditOutlined, DeleteOutlined, DownloadOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useTranslation } from 'react-i18next'
import ScopeTag from '../components/ScopeTag'
import AnswerLine from '../components/AnswerLine'
import { useAuthStore } from '../stores/authStore'
import KnowledgePointSelect, { joinKps } from '../components/KnowledgePointSelect'
import QuizEditor from '../components/QuizEditor'
import type { Question } from '../components/QuizEditor'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
import ResetActivityButton from '../components/ResetActivityButton'
import { reportLoadError } from '../utils/loadError'
import { confirmUnanswered, unansweredIndexes } from '../utils/submitGuard'
import AnswerNav from '../components/AnswerNav'
import { draftKey, loadDraft, clearDraft, useDebouncedDraft, countAnswered } from '../utils/answerDraft'
import { RowList } from '../components/RowList'
import { toPercent, toPercentInt, percentStatus, percentColor, percentLevelKey } from '../utils/score'
const { Title, Text } = Typography

/** S-GRADING(P3): 这道题的分是谁给的 */
const GRADED_BY_KEYS: Record<string, string> = {
  ai: 'ipGradedByAi', keyword: 'ipGradedByKeyword', exact: 'ipGradedByExact',
  none: 'ipGradedByNone', teacher: 'ipGradedByTeacher', queued: 'ipGradedByQueued',
}
const isQuizPending = (r: any) => r?.grading === 'pending' || r?.graded_by === 'queued'

const InteractionPage: React.FC = () => {
  const { t } = useTranslation('interaction')
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  // ── 随堂测验 ──
  const [quizzes, setQuizzes] = useState<any[]>([])
  const [quizLoading, setQuizLoading] = useState(false)
  const [quizEditorOpen, setQuizEditorOpen] = useState(false)
  const [takingQuiz, setTakingQuiz] = useState<any>(null)
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({})
  // A1: 随堂测验同样有本机草稿（原先关掉弹窗即清空作答）
  const [quizDraftInfo, setQuizDraftInfo] = useState<{ answers: Record<number, string>; ts: number } | null>(null)
  // P2: 提交失败的可见重试（随堂测验交卷失败后，答案还在内存里，给一次再交的机会）
  const [quizSubmitError, setQuizSubmitError] = useState<string | null>(null)
  // 列表工具条：测验多了以后靠翻页找太累（筛选/排序只在已加载的这页数据里做，不动接口）
  const [quizKeyword, setQuizKeyword] = useState('')
  const [quizFilter, setQuizFilter] = useState<'all' | 'todo' | 'done'>('all')
  const [quizSort, setQuizSort] = useState<'newest' | 'oldest' | 'title'>('newest')
  const [quizSubmitting, setQuizSubmitting] = useState(false)
  const [quizResult, setQuizResult] = useState<any>(null)
  const [quizResultsView, setQuizResultsView] = useState<any>(null)
  // S-GRADING(P3): 结果弹窗对应的测验 id(自动刷新/催批要用) + 催批中状态
  const [quizResultsId, setQuizResultsId] = useState<number | null>(null)
  // 该结果里还剩几题在后台批改：为 0 就完全不需要轮询
  const [quizResultsPending, setQuizResultsPending] = useState(0)
  // 弹窗是否还开着：供延时回调判断。闭包里的 state 是点击当时的旧值, 不能拿来判断
  const quizResultsOpenRef = useRef(false)
  quizResultsOpenRef.current = !!quizResultsView
  const quizPollTries = useRef(0)
  const quizSubmitTries = useRef(0)
  const [quizGradingNow, setQuizGradingNow] = useState(false)
  const [quizStuSearch, setQuizStuSearch] = useState('')
  const [quizAiAnalysis, setQuizAiAnalysis] = useState<string | null>(null)
  const [quizAiAnalysisLoading, setQuizAiAnalysisLoading] = useState(false)
  // P1: AI 分析结果是否来自缓存(命中缓存时给个提示, 避免教师以为"没重新算")
  const [quizAiCached, setQuizAiCached] = useState(false)
  // 结果弹窗内层页签(AI 分析出结果后自动切到「逐题分析」)
  const [quizResultTab, setQuizResultTab] = useState('overview')
  const [aiQuizModal, setAiQuizModal] = useState(false)
  const [aiQuizLoading, setAiQuizLoading] = useState(false)
  const [aiQuizResult, setAiQuizResult] = useState<any>(null)
  const [aiQuizForm] = Form.useForm()
  const aiQuizSubject = Form.useWatch('subject', aiQuizForm)
  const [aiQuizScope, setAiQuizScope] = useState<ActivityScopeValue>({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
  // 列表分页
  const [quizPage, setQuizPage] = useState(1)
  const [quizPageSize, setQuizPageSize] = useState(10)
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])

  // 从系统配置加载课程列表
  useEffect(() => {
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setSubjectOptions(data.subjects)
    }).catch((err) => { reportLoadError(err, { key: 'interaction.subjects' }) })
  }, [])

  // ── 当前激活的 Tab ──

  // ── 编辑状态 ──
  const [editQuizModal, setEditQuizModal] = useState<any>(null)
  const [editQuizForm] = Form.useForm()
  // ── 编辑/删除处理 ──
  const handleDeleteQuiz = async (id: number) => {
    try { await apiClient.delete(`/api/interaction/quizzes/${id}`); message.success(t('deleted')); await loadQuizzes() }
    catch { message.error(t('deleteFailed')) }
  }
  const handleEditQuiz = async () => {
    const values = await editQuizForm.validateFields()
    try {
      await apiClient.put(`/api/interaction/quizzes/${editQuizModal.id}`, values)
      message.success(t('updated')); setEditQuizModal(null); await loadQuizzes()
    } catch { message.error(t('updateFailed')) }
  }
  // 发布开关：草稿 → 发布；进行中 → 结束（确认后）；已结束 → 重新开启
  const [quizStatusBusy, setQuizStatusBusy] = useState<number | null>(null)
  const toggleQuizStatus = async (quiz: any, next: 'active' | 'ended') => {
    setQuizStatusBusy(quiz.id)
    try {
      if (next === 'ended') {
        await apiClient.post(`/api/interaction/quizzes/${quiz.id}/end`)
        message.success(t('ipStatusEnded'))
      } else {
        const action = quiz.status === 'draft' ? 'publish' : 'reopen'
        await apiClient.post(`/api/interaction/quizzes/${quiz.id}/${action}`)
        message.success(action === 'publish' ? t('publishedOk') : t('reopenedOk'))
      }
      await loadQuizzes()
    } catch (err: any) {
      message.error(err.response?.data?.detail || t('updateFailed'))
    } finally { setQuizStatusBusy(null) }
  }
  // ── 加载数据 ──
  const loadQuizzes = async () => {
    setQuizLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/quizzes', { params: { page_size: 100 } })
      setQuizzes(data.quizzes || [])
    } catch (err) { reportLoadError(err, { key: 'InteractionPage.loadQuizzes', retry: () => { void loadQuizzes() } }) }
    setQuizLoading(false)
  }

  useEffect(() => {
    loadQuizzes()
  }, [])

  // ── AI 生成测验 ──
  const handleAiGenerateQuiz = async (values: any) => {
    setAiQuizLoading(true)
    setAiQuizResult(null)
    try {
      const { data } = await apiClient.post('/api/interaction/quizzes/ai-generate', values, { timeout: 300000 })
      setAiQuizResult(data)
      if (data.questions?.length > 0) {
        message.success(t('aiGeneratedQuestions', { count: data.questions.length }))
      } else if (data.error) {
        message.warning(data.error)
      }
    } catch { message.error(t('aiGenerateFailed')) }
    setAiQuizLoading(false)
  }

  const handleApplyAiQuiz = async () => {
    if (aiQuizResult?.questions) {
      // 直接通过 API 创建测验，保留完整题目结构
      try {
        await apiClient.post('/api/interaction/quizzes', {
          title: t('ipQuizSuffix', { topic: aiQuizForm.getFieldValue('topic') }),
          questions: JSON.stringify(aiQuizResult.questions),
          knowledge_points: aiQuizForm.getFieldValue('topic') || '',
          // 学科：AI 弹窗里选过（图一那个下拉），必须一起落库 —— 否则活动监控/列表显示不出科目
          subject: aiQuizForm.getFieldValue('subject') || '',
          target_scope: aiQuizScope.target_scope,
          target_grade: aiQuizScope.target_grade,
          target_class: aiQuizScope.target_class,
          target_users: aiQuizScope.target_users,
        })
        // 默认存草稿（与考试一致）：提示老师去列表里发布
        message.success(t('savedAsDraft'))
        setAiQuizModal(false)
        setAiQuizResult(null)
        setAiQuizScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
        await loadQuizzes()
      } catch (err: any) {
        message.error(err.response?.data?.detail || t('createFailed'))
      }
    }
  }

  // ── 创建测验（使用 QuizEditor） ──
  const handleCreateQuiz = async (title: string, description: string, questions: Question[],
                                  scope?: any, subject?: string, kps?: string[], publish = true) => {
    try {
      const formatted = questions.map(q => ({
        type: q.type,
        question: q.question,
        options: q.options,
        answer: q.answer,
        score: q.score || 1,
        explanation: q.explanation || '',
      }))
      await apiClient.post('/api/interaction/quizzes', {
        title,
        description: description || '',
        questions: JSON.stringify(formatted),
        subject: subject || '',
        knowledge_points: joinKps(kps || []),
        target_scope: scope?.target_scope || 'teacher_classes',
        target_grade: scope?.target_grade || '',
        target_class: scope?.target_class || '',
        target_users: scope?.target_users || '',
        publish,
      })
      message.success(publish
        ? t('quizCreatedWithTitle', { title, count: questions.length })
        : t('savedAsDraft'))
      setQuizEditorOpen(false)
      await loadQuizzes()
    } catch (err: any) {
      message.error(err.response?.data?.detail || t('createFailed'))
      throw err
    }
  }

  // ── 开始答题 ──
  const handleStartQuiz = (quiz: any) => {
    setTakingQuiz(quiz)
    setQuizAnswers({})
    setQuizResult(null)
    setQuizSubmitError(null)
    // A1: 有本机草稿就提示恢复（题量对不上会自动丢弃）
    const draft = loadDraft<Record<number, string>>(
      draftKey('quiz', quiz.id, user?.username), (quiz.questions || []).length)
    setQuizDraftInfo(draft && countAnswered(draft.answers as any) > 0 ? draft : null)
  }

  // A1: 作答防抖落盘 / 提交即清 / 未提交离开时提醒
  const quizDraftK = takingQuiz?.id ? draftKey('quiz', takingQuiz.id, user?.username) : ''
  const quizDone = countAnswered(quizAnswers as any)
  useDebouncedDraft(quizDraftK, quizAnswers,
    !!takingQuiz && !quizResult && !quizDraftInfo, (takingQuiz?.questions || []).length)
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!takingQuiz || quizResult || quizDone === 0) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [takingQuiz, quizResult, quizDone])

  const handleSubmitQuiz = async (retry = false) => {
    if (!takingQuiz) return
    const qs: any[] = takingQuiz.questions || []
    // P0 防误交：随堂测验提交后不能重复作答，没答完必须先确认
    if (!retry) {
      const missing = unansweredIndexes(qs, (_q, i) => !!(quizAnswers[i] || '').trim())
      const ok = await confirmUnanswered({ missing, total: qs.length, extra: t('ipQuizOneShot') })
      if (!ok) return
    }
    const answers = qs.map((_q: any, i: number) => ({
      question_index: i,
      answer: quizAnswers[i] || '',
    }))
    setQuizSubmitting(true)
    setQuizSubmitError(null)
    try {
      const { data } = await apiClient.post(`/api/interaction/quizzes/${takingQuiz.id}/answer`, { answers: JSON.stringify(answers) })
      setQuizResult(data)
      clearDraft(quizDraftK)                 // A1: 提交成功即清草稿
      setQuizDraftInfo(null)
      // S-GRADING(P3): 主观题改由后台批量批改, 提交即刻返回, 成绩稍后自动更新
      if (Number(data?.pending_ai || 0) > 0) message.info(t('ipGradingQueued', { count: data.pending_ai }))
    } catch (err: any) {
      const msg = err.response?.data?.detail || t('submitFailed')
      message.error(msg)
      setQuizSubmitError(msg)
    } finally {
      setQuizSubmitting(false)
    }
  }

  const handleViewQuizResults = async (quizId: number) => {
    try {
      const url = isStudent
        ? `/api/interaction/quizzes/${quizId}/my-result`
        : `/api/interaction/quizzes/${quizId}/results`
      const { data } = await apiClient.get(url)
      setQuizResultsView(data)
      setQuizResultsId(quizId)
      setQuizResultsPending(Number(data?.pending_ai ?? data?.pending_ai_total ?? 0))
      setQuizAiAnalysis(null)
      setQuizAiCached(false)
      setQuizResultTab('overview')
    } catch { message.error(t('loadResultFailed')) }
  }

  // S-GRADING(P3): 弹窗打开期间若还有题在后台批改, 每 8 秒自动刷新(累计最多 12 次)
  // 没有待批改题就不建轮询 —— 旧实现关掉弹窗 8 秒后会被第一次回调"复活"再弹一次
  useEffect(() => {
    if (!quizResultsId || !(quizResultsPending > 0)) { quizPollTries.current = 0; return }
    const url = isStudent
      ? `/api/interaction/quizzes/${quizResultsId}/my-result`
      : `/api/interaction/quizzes/${quizResultsId}/results`
    const id = window.setInterval(async () => {
      if (++quizPollTries.current > 12) { window.clearInterval(id); return }
      try {
        const { data } = await apiClient.get(url)
        // 关键: quizResultsView 同时是「弹窗是否打开」的判据, 弹窗已关就不能再写它,
        // 否则已关闭的结果弹窗会自己再弹出来。
        setQuizResultsView((prev: any) => (prev ? data : prev))
        setQuizResultsPending(Number(data?.pending_ai ?? data?.pending_ai_total ?? 0))
      } catch { /* 本轮没判完, 下一轮再看 */ }
    }, 8000)
    return () => window.clearInterval(id)
  }, [quizResultsId, quizResultsPending, isStudent])

  // S-GRADING(P3): 提交后的结果框在批改期间同步刷新成绩。
  // 只在弹窗还开着(prev 非空)时写 state —— 关掉后绝不能写, 否则弹窗会被自己"复活"。
  useEffect(() => {
    const qid = takingQuiz?.id
    const pend = Number(quizResult?.pending_ai || 0)
    if (!qid || !(pend > 0)) { quizSubmitTries.current = 0; return }
    const id = window.setInterval(async () => {
      if (++quizSubmitTries.current > 12) { window.clearInterval(id); return }
      try {
        const { data } = await apiClient.get(`/api/interaction/quizzes/${qid}/my-result`)
        setQuizResult((prev: any) => (prev ? {
          ...prev, score: data.score, total_score: data.total_score,
          percentage: data.percentage, pending_ai: data.pending_ai,
        } : prev))
      } catch { /* 本轮没判完, 下一轮再看 */ }
    }, 8000)
    return () => window.clearInterval(id)
  }, [takingQuiz?.id, quizResult?.pending_ai])

  /** S-GRADING(P3): 教师催批待判的主观题; retryReview=true 时把「转人工」的题也重新排队再试 */
  const handleQuizGradeNow = async (retryReview = false) => {
    if (!quizResultsId) return
    setQuizGradingNow(true)
    try {
      const { data } = await apiClient.post(
        `/api/interaction/quizzes/${quizResultsId}/grade-now`, { retry_review: retryReview })
      if (!data?.task_id) {
        message.info(data?.message || t('ipNoPendingGrading'))
        if (quizResultsOpenRef.current) await handleViewQuizResults(quizResultsId)
        return
      }
      message.info(t('ipGradingStarted', { count: data.pending_attempts || 0 }))
      const out: any = await pollAiTask(data.task_id, 240000)
      if (out?.error) message.error(out.error)
      else if (out) message.success(t('ipGradingDone', { graded: out.graded ?? 0, review: out.to_review ?? 0 }))
      else message.warning(t('ipGradingTimeout'))
      if (quizResultsOpenRef.current) await handleViewQuizResults(quizResultsId)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('ipGradingFailed'))
    } finally { setQuizGradingNow(false) }
  }

  /** 关闭结果弹窗: 同时停掉后台批改轮询(否则关掉后又被回调"复活") */
  const closeQuizResults = () => {
    setQuizResultsView(null)
    setQuizResultsId(null)
    setQuizResultsPending(0)
  }

  /** P1: AI 分析结果缓存到 sessionStorage —— 关弹窗再打开不该再烧一次 token */
  const handleQuizAiAnalysis = async (quizId: number, force = false) => {
    if (!quizId) return
    const cacheKey = `quiz-ai:${quizId}`
    if (!force) {
      try {
        const raw = sessionStorage.getItem(cacheKey)
        if (raw) {
          const cached = JSON.parse(raw)
          if (cached?.text && Date.now() - Number(cached.ts || 0) < 24 * 3600 * 1000) {
            setQuizAiAnalysis(cached.text)
            setQuizAiCached(true)
            setQuizResultTab('questions')     // 直接把教师带到分析结果所在的页签
            return
          }
        }
      } catch { /* 缓存坏了就当没有 */ }
    }
    setQuizAiAnalysisLoading(true)
    setQuizAiAnalysis(null)
    setQuizAiCached(false)
    try {
      const { data } = await apiClient.get(`/api/interaction/quizzes/${quizId}/ai-analysis`, { timeout: 180000 })
      let text: string | null = null
      if (data.task_id) {
        // 异步任务，轮询结果
        const result = await pollAiTask(data.task_id)
        if (result) text = result.analysis
        else message.error(t('aiAnalyzeTimeout'))
      } else {
        // 兼容旧版同步返回
        text = data.analysis
      }
      if (text) {
        setQuizAiAnalysis(text)
        setQuizResultTab('questions')
        try { sessionStorage.setItem(cacheKey, JSON.stringify({ text, ts: Date.now() })) } catch { /* 存不下就算了 */ }
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('aiAnalyzeFailed'))
    }
    setQuizAiAnalysisLoading(false)
  }

  // 学生端「待作答 / 已完成」的判定与筛选排序 —— 都在本页已加载的数据里做
  const quizStateOf = (q: any): 'todo' | 'done' => (q?.answered ? 'done' : 'todo')
  const quizTodoCount = quizzes.filter(q => quizStateOf(q) === 'todo').length
  const quizDoneCount = quizzes.length - quizTodoCount
  const qkw = quizKeyword.trim().toLowerCase()
  const visibleQuizzes = [...quizzes]
    .filter(q => {
      if (quizFilter !== 'all' && quizStateOf(q) !== quizFilter) return false
      if (!qkw) return true
      return `${q.title || ''} ${q.description || ''}`.toLowerCase().includes(qkw)
    })
    .sort((a, b) => quizSort === 'title'
      ? String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN')
      : quizSort === 'oldest'
      ? String(a.created_at || '').localeCompare(String(b.created_at || ''))
      : String(b.created_at || '').localeCompare(String(a.created_at || '')))

  const tabItems = [
    {
      key: 'quizzes',
      label: <span><ThunderboltOutlined /> {t('title')}</span>,
      children: (
        <div>
          {isTeacherOrAdmin && (
            <Space style={{ marginBottom: 16 }}>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setQuizEditorOpen(true)}>
                {t('createQuiz')}
              </Button>
              <Button icon={<RobotOutlined />} onClick={() => {
                setAiQuizModal(true); setAiQuizResult(null)
                aiQuizForm.resetFields()
                // 学科默认第一个（resetFields 走的是字段注册时的 initialValue，
                // 若学科清单当时还没加载完就会留空 → 这里显式补一次）
                aiQuizForm.setFieldValue('subject', subjectOptions[0] || '')
              }}>
                AI {t('createQuiz')}
              </Button>
            </Space>
          )}
          {/* 使用 QuizEditor 组件（完整编辑器） */}
          <QuizEditor
            open={quizEditorOpen}
            onCancel={() => setQuizEditorOpen(false)}
            onSave={handleCreateQuiz}
          />
          <Spin spinning={quizLoading}>
            {/* 工具条：学生看「待作答 / 已完成」，教师也一样能用（长的行自动换行） */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <Input allowClear prefix={<SearchOutlined />} placeholder={t('ipSearchPh')}
                value={quizKeyword} style={{ width: 240 }}
                onChange={e => { setQuizKeyword(e.target.value); setQuizPage(1) }} />
              {isStudent && (
                <Segmented value={quizFilter}
                  onChange={(v) => { setQuizFilter(v as 'all' | 'todo' | 'done'); setQuizPage(1) }}
                  options={[
                    { value: 'all', label: t('ipFilterAll') },
                    { value: 'todo', label: t('ipFilterTodo') },
                    { value: 'done', label: t('ipFilterDone') },
                  ]} />
              )}
              <Select value={quizSort} style={{ width: 140 }}
                onChange={(v) => { setQuizSort(v); setQuizPage(1) }}
                options={[
                  { value: 'newest', label: t('ipSortNewest') },
                  { value: 'oldest', label: t('ipSortOldest') },
                  { value: 'title', label: t('ipSortTitle') },
                ]} />
            </div>
            {quizzes.length === 0
              ? <Empty description={isStudent ? t('ipNoListTitle') : t('noPolls')}>
                  {isStudent && <div><Text type="secondary" style={{ fontSize: 12 }}>{t('ipNoListHint')}</Text></div>}
                </Empty>
              : visibleQuizzes.length === 0
              ? <Empty description={t('ipNoMatch')}>
                  <Button size="small" onClick={() => { setQuizKeyword(''); setQuizFilter('all'); setQuizPage(1) }}>
                    {t('ipClearFilter')}
                  </Button>
                </Empty>
              : (
              <>
                <RowList
                  items={visibleQuizzes.slice((quizPage - 1) * quizPageSize, quizPage * quizPageSize)}
                  split={false}
                  renderItem={(quiz: any) => (
                  <Card size="small" style={{ marginBottom: 8, cursor: isStudent ? 'pointer' : 'default' }}
                    hoverable={isStudent}
                    onClick={isStudent
                      ? () => (quiz.answered ? handleViewQuizResults(quiz.id) : handleStartQuiz(quiz))
                      : undefined}>
                    <div className="page-header-flex stack-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <Text strong>{quiz.title}</Text>
                        {!!quiz.description && (
                          <div><Text type="secondary" style={{ fontSize: 12 }}>{quiz.description}</Text></div>
                        )}
                        <div style={{ marginTop: 4 }}>
                          <Tag>{t('ipNCount', { count: quiz.questions?.length || 0 })}</Tag>
                          {quiz.status === 'draft'
                            ? <Tag>{t('draft')}</Tag>
                            : quiz.status === 'active'
                            ? <Tag color="green">{t('started')}</Tag>
                            : <Tag color="red">{t('ended')}</Tag>}
                          {/* 学生最关心的是"我答没答"，教师名单里则没这一格 */}
                          {isStudent && (
                            quiz.answered
                              ? <Tag color="success">{t('ipFilterDone')}</Tag>
                              : <Tag color="warning">{t('ipFilterTodo')}</Tag>
                          )}
                          <Tag color="blue">{quiz.creator_username || quiz.creator_name}</Tag>
                          {quiz.subject && <Tag color="cyan">{quiz.subject}</Tag>}
                          {isTeacherOrAdmin && (
                            <ScopeTag scope={quiz.target_scope} grade={quiz.target_grade}
                              classes={quiz.target_class} users={quiz.target_users} />
                          )}
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {t('createdAt')}：{String(quiz.created_at || '').slice(0, 10)} · {t('peopleCount', { count: quiz.answer_count || 0 })}
                          </Text>
                        </div>
                      </div>
                      <Space>
                        {quiz.status === 'active' && isStudent && !quiz.answered && (
                          <Button size="small" type="primary" icon={<PlayCircleOutlined />}
                            onClick={(e) => { e.stopPropagation(); void handleStartQuiz(quiz) }}>{t('startQuiz')}</Button>
                        )}
                        {/* 已结束的测验仍留在学生列表里（自己答过），给「结果」入口 */}
                        {isStudent && quiz.answered && (
                          <Tooltip title={t('results')}>
                            <Button size="small" icon={<BarChartOutlined />}
                              onClick={(e) => { e.stopPropagation(); void handleViewQuizResults(quiz.id) }} />
                          </Tooltip>
                        )}
                        {isTeacherOrAdmin && (
                          <>
                            {/* 发布 / 结束 / 重开：与考试中心同一套（绿=发布、红=结束、灰=重开） */}
                            {quiz.status === 'draft' && (
                              <Tooltip title={t('publishAction')}>
                                <Button size="small" icon={<PlayCircleOutlined />}
                                  style={{ color: '#52c41a' }} loading={quizStatusBusy === quiz.id}
                                  onClick={(e) => { e.stopPropagation(); void toggleQuizStatus(quiz, 'active') }} />
                              </Tooltip>
                            )}
                            {quiz.status === 'active' && (
                              <Tooltip title={t('endAction')}>
                                <Button size="small" icon={<PauseCircleOutlined />}
                                  style={{ color: '#ff4d4f' }}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    Modal.confirm({
                                      title: t('endQuizConfirm'),
                                      okText: t('endAction'),
                                      cancelText: t('cancel'),
                                      okButtonProps: { danger: true },
                                      onOk: () => toggleQuizStatus(quiz, 'ended'),
                                    })
                                  }} />
                              </Tooltip>
                            )}
                            {quiz.status === 'ended' && (
                              <Tooltip title={t('reopenAction')}>
                                <Button size="small" icon={<RedoOutlined />}
                                  loading={quizStatusBusy === quiz.id}
                                  onClick={(e) => { e.stopPropagation(); void toggleQuizStatus(quiz, 'active') }} />
                              </Tooltip>
                            )}
                            {/* 操作按钮只留图标 + tooltip：文字按钮太占地方，整行会被挤长 */}
                            <Tooltip title={t('results')}>
                              <Button size="small" icon={<BarChartOutlined />}
                                onClick={(e) => { e.stopPropagation(); void handleViewQuizResults(quiz.id) }} />
                            </Tooltip>
                            <Tooltip title={t('ipExport')}>
                              <Button size="small" icon={<DownloadOutlined />}
                                onClick={(e) => { e.stopPropagation(); window.open(`/api/export/quiz/${quiz.id}`, '_blank') }} />
                            </Tooltip>
                            <Tooltip title={t('ipEdit')}>
                              <Button size="small" icon={<EditOutlined />}
                                onClick={(e) => { e.stopPropagation(); editQuizForm.setFieldsValue(quiz); setEditQuizModal(quiz) }} />
                            </Tooltip>
                            <ResetActivityButton activityType="quiz" activityId={quiz.id}
                                iconOnly stopPropagation onSuccess={loadQuizzes} />
                            <Popconfirm title={t('confirmDeleteQuiz')} onConfirm={() => handleDeleteQuiz(quiz.id)}>
                              <Tooltip title={t('delete')}>
                                <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                              </Tooltip>
                            </Popconfirm>
                          </>
                        )}
                      </Space>
                    </div>
                  </Card>
                )}
              />
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <Pagination
                  current={quizPage} pageSize={quizPageSize} total={visibleQuizzes.length}
                  showSizeChanger showTotal={(total) => t('totalQuizzes', { count: total })}
                  pageSizeOptions={['5', '10', '20', '50']}
                  onChange={(p, ps) => { setQuizPage(p); setQuizPageSize(ps) }}
                  size="small"
                />
              </div>
            </>
            )}

          </Spin>
        </div>
      ),
    },
  ]

  return (
    <Card style={{ borderRadius: 8 }}>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <ThunderboltOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>{t('title')}</Title>
            {/* 原先这里又写了一遍标题，横幅上同一个词出现两次；换成一句有用的说明 */}
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 12 }}>
              {isStudent ? t('ipListSub') : t('ipMyProgress', { todo: quizTodoCount, done: quizDoneCount })}
            </Text>
          </Space>
        </div>
      </Card>

      {/* 整页只有「随堂测验」一个页签，Tabs 只是白占一行（学生端尤其明显） */}
      <Card>
        {tabItems[0].children}
      </Card>

      {/* ── 答题弹窗 ── */}
      <Modal maskClosable={false} title={takingQuiz?.title} open={!!takingQuiz && !quizResult}
        onCancel={() => {
          // A1: 有未提交作答时先确认（草稿已存本机，离开不会真丢）
          const close = () => { setTakingQuiz(null); setQuizResult(null); setQuizDraftInfo(null); setQuizSubmitError(null) }
          if (!quizDone) { close(); return }
          Modal.confirm({
            title: t('common:leaveTitle'),
            content: t('common:leaveBody', { done: quizDone }),
            okText: t('common:leaveConfirmOk'),
            cancelText: t('common:draftResume'),
            onOk: close,
          })
        }}
        footer={[
          <Button key="submit" type="primary" loading={quizSubmitting} onClick={() => { void handleSubmitQuiz() }}>{t('submit')}</Button>,
        ]}
        width="min(680px, 94vw)">
        {/* P2: 交卷失败 → 就地重试（答案都还在，不必重答一遍） */}
        {quizSubmitError && (
          <Alert
            type="error" showIcon closable style={{ marginBottom: 12 }}
            title={t('submitFailed')}
            description={quizSubmitError}
            onClose={() => setQuizSubmitError(null)}
            action={
              <Button size="small" type="primary" danger loading={quizSubmitting}
                onClick={() => { void handleSubmitQuiz(true) }}>
                {t('common:retry')}
              </Button>
            }
          />
        )}
        {/* P1: 答题进度 —— 以前只有提交时弹一次「还有几题没答」, 做到一半完全没参照 */}
        {takingQuiz?.questions?.length > 0 && (() => {
          const total = takingQuiz.questions.length
          const done = takingQuiz.questions.filter((_q: any, i: number) => (quizAnswers[i] || '').trim()).length
          const nextIdx = takingQuiz.questions.findIndex((_q: any, i: number) => !(quizAnswers[i] || '').trim())
          return (
            <div style={{ marginBottom: 12 }}>
              <Space size={8} style={{ marginBottom: 4 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('answerProgress', { current: nextIdx >= 0 ? nextIdx + 1 : total, total, done })}
                </Text>
                {done < total && (
                  <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                    {t('unansweredN', { count: total - done })}
                  </Tag>
                )}
              </Space>
              <Progress percent={Math.round(done / total * 100)} size="small" showInfo={false} />
              {/* A3: 题号导航（点击滚动到该题） */}
              <div style={{ marginTop: 6 }}>
                <AnswerNav
                  answered={takingQuiz.questions.map((_q: any, i: number) => !!(quizAnswers[i] || '').trim())}
                  current={nextIdx}
                  onJump={(i) => document.getElementById(`quiz-q-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                />
              </div>
            </div>
          )
        })()}
        {/* A1: 发现未提交的本机草稿 → 继续 / 重新开始 */}
        {quizDraftInfo && (
          <Alert
            type="info" showIcon style={{ marginBottom: 12 }}
            title={t('common:draftFound', { done: countAnswered(quizDraftInfo.answers as any), total: (takingQuiz?.questions || []).length })}
            action={
              <Space>
                <Button size="small" type="primary"
                  onClick={() => { setQuizAnswers(quizDraftInfo.answers as Record<number, string>); setQuizDraftInfo(null) }}>
                  {t('common:draftResume')}
                </Button>
                <Button size="small" onClick={() => { clearDraft(quizDraftK); setQuizDraftInfo(null) }}>
                  {t('common:draftRestart')}
                </Button>
              </Space>
            }
          />
        )}
        {takingQuiz?.questions?.map((q: any, i: number) => (
          <div key={i} id={`quiz-q-${i}`} style={{ marginBottom: 12, padding: 12, background: 'var(--bg-layout)', borderRadius: 4, border: '1px solid var(--border-color)' }}>
            <div style={{ marginBottom: 8 }}>
              <Text strong>{i + 1}. </Text>
              <FormulaRenderer content={q.question || q.question_text} />
              {q.type === 'single' && <Tag color="blue" style={{ fontSize: 11, marginLeft: 8 }}>{t('single')}</Tag>}
              {q.type === 'multiple' && <Tag color="purple" style={{ fontSize: 11, marginLeft: 8 }}>{t('multiple')}</Tag>}
              {q.type === 'true_false' && <Tag color="orange" style={{ fontSize: 11, marginLeft: 8 }}>{t('trueFalse')}</Tag>}
            </div>
            <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} size="normal" />
            <div style={{ marginTop: 8, paddingLeft: 8 }}>
              {q.type === 'single' && q.options ? (
                <Radio.Group onChange={(e) => setQuizAnswers({ ...quizAnswers, [i]: e.target.value })}>
                  <Space orientation="vertical">
                    {q.options.map((opt: string, j: number) => (
                      <Radio key={j} value={opt.charAt(0)} style={{ lineHeight: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><FormulaRenderer content={opt} inline /></Radio>
                    ))}
                  </Space>
                </Radio.Group>
              ) : q.type === 'multiple' && q.options ? (
                <Checkbox.Group onChange={(vals) => setQuizAnswers({ ...quizAnswers, [i]: (vals as string[]).sort().join(',') })}>
                  <Space orientation="vertical">
                    {q.options.map((opt: string, j: number) => (
                      <Checkbox key={j} value={opt.charAt(0)} style={{ lineHeight: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><FormulaRenderer content={opt} inline /></Checkbox>
                    ))}
                  </Space>
                </Checkbox.Group>
              ) : q.type === 'true_false' ? (
                <Radio.Group onChange={(e) => setQuizAnswers({ ...quizAnswers, [i]: e.target.value })}>
                  <Space>
                    <Radio value="对" style={{ lineHeight: 2 }}>{t('judgeTrue')}</Radio>
                    <Radio value="错" style={{ lineHeight: 2 }}>{t('judgeFalse')}</Radio>
                  </Space>
                </Radio.Group>
              ) : (
                <Input onChange={(e) => setQuizAnswers({ ...quizAnswers, [i]: e.target.value })}
                  placeholder={t('inputAnswer')} />
              )}
            </div>
          </div>
        ))}
      </Modal>

      {/* ── 答题结果 ── */}
      <Modal title={t('result')} open={!!quizResult}
        onCancel={() => { setQuizResult(null); setTakingQuiz(null) }}
        footer={<Button onClick={() => { setQuizResult(null); setTakingQuiz(null) }}>{t('close')}</Button>}>
        {quizResult && (
          <Result
            status={Number(quizResult.pending_ai || 0) > 0 ? 'info'
              : (toPercent(quizResult.score, quizResult.total_score) >= 60 ? 'success' : 'warning')}
            /* R2(Step A) + 2026-10-16: 得分统一 100 分制 —— 后端直接给百分制得分 */
            title={t('quizPercentScore', {
              percent: toPercent(quizResult.score, quizResult.total_score),
            })}
            subTitle={Number(quizResult.pending_ai || 0) > 0
              ? t('ipGradingPendingHint', { count: quizResult.pending_ai })
              : t('accuracyRate', { percent: quizResult.percentage })}
          />
        )}
      </Modal>

      {/* ── 测验结果统计弹窗 ── */}
      <Modal title={quizResultsView?.quiz_title ? t('ipMyScore', { title: quizResultsView.quiz_title }) : t('ipQuizResult')}
        open={!!quizResultsView}
        onCancel={closeQuizResults}
        width="min(980px, 94vw)"
        footer={isStudent
          ? <Button type="primary" onClick={closeQuizResults}>{t('close')}</Button>
          : (
            <Space wrap>
              {/* S-GRADING(P3): 后台还没判完 / 有题判不准时, 教师可以立刻催批 */}
              {(Number(quizResultsView?.pending_ai_total || 0) > 0
                || Number(quizResultsView?.pending_review_total || 0) > 0) && (
                <>
                  {quizResultsView?.pending_ai_total > 0 && (
                    <Tag color="blue">{t('ipGradingPendingN', { count: quizResultsView.pending_ai_total })}</Tag>
                  )}
                  {quizResultsView?.pending_review_total > 0 && (
                    <Tag color="orange">{t('ipNeedsReviewN', { count: quizResultsView.pending_review_total })}</Tag>
                  )}
                  <Popconfirm title={t('ipGradeNowConfirm')} onConfirm={() => handleQuizGradeNow(false)}>
                    <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />}
                      loading={quizGradingNow} disabled={!(Number(quizResultsView?.pending_ai_total || 0) > 0)}>
                      {t('ipGradeNow')}
                    </Button>
                  </Popconfirm>
                  {Number(quizResultsView?.pending_review_total || 0) > 0 && (
                    <Popconfirm title={t('ipRetryReviewConfirm')} onConfirm={() => handleQuizGradeNow(true)}>
                      <Button size="small" loading={quizGradingNow}>{t('ipRetryReview')}</Button>
                    </Popconfirm>
                  )}
                </>
              )}
              <Button icon={<RobotOutlined />} size="small"
                loading={quizAiAnalysisLoading}
                disabled={!quizResultsView?.question_stats?.length}
                onClick={() => handleQuizAiAnalysis(quizResultsView?.quiz?.id, !!(quizAiAnalysis || quizAiCached))}>
                {quizAiAnalysis ? t('aiReAnalyze') : t('ipAiAnalyze')}
              </Button>
              <Button type="primary" onClick={closeQuizResults}>{t('close')}</Button>
            </Space>
          )}>
        {quizResultsView && (
          <>
            {/* 学生端：个人答题结果 */}
            {/* P2-14: 视角以后端 view 字段为准(老后端没这个字段时回退按 quiz_title 判断) */}
            {(quizResultsView.view ? quizResultsView.view === 'student' : !!quizResultsView.quiz_title) && (
              <div>
                <Card style={{ textAlign: 'center', marginBottom: 16 }}>
                  {/* R2(Step A): 圆环与分数都走百分制; 原始分只作次要说明 */}
                  <Progress type="circle"
                    percent={toPercentInt(quizResultsView.score, quizResultsView.total_score)}
                    format={p => `${p}%`} />
                  <div style={{ marginTop: 8 }}>
                    <Space size={8} wrap>
                      <Text strong>{t('quizPercentScore', {
                        percent: toPercent(quizResultsView.score, quizResultsView.total_score),
                      })}</Text>
                      <Tag color={percentStatus(toPercent(quizResultsView.score, quizResultsView.total_score))}>
                        {t(percentLevelKey(toPercent(quizResultsView.score, quizResultsView.total_score)))}
                      </Tag>
                    </Space>
                  </div>
                </Card>
                {quizResultsView.details?.map((r: any, i: number) => (
                  <Card key={i} size="small" style={{ marginBottom: 8 }}
                    title={t('ipQNo', { no: i + 1 })}
                    extra={isQuizPending(r)
                      ? <Tag color="blue">{t('ipGradingPending')}</Tag>
                      : r.needs_review
                      ? <Tag color="orange">{t('ipNeedsReview')}</Tag>
                      : (r.is_correct ? <Tag color="success">{t('ipCorrect')}</Tag> : <Tag color="error">{t('ipWrong')}</Tag>)}>
                    <FormulaRenderer content={r.question} />
                    <MediaDisplay svgContent={r.svg_content} hasSvg={r.has_svg} mediaFiles={r.media_files} size="compact" />
                    {r.options && typeof r.options === 'object' && !Array.isArray(r.options) && (
                      <div style={{ marginTop: 4, paddingLeft: 8 }}>
                        {Object.entries(r.options).map(([k, v]) => (
                          <div key={k} style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {k}. <FormulaRenderer content={v as string} inline />
                          </div>
                        ))}
                      </div>
                    )}
                    {r.options && Array.isArray(r.options) && (
                      <div style={{ marginTop: 4, paddingLeft: 8 }}>
                        {r.options.map((opt: string, j: number) => (
                          <div key={j} style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            <FormulaRenderer content={opt} inline />
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: 8 }}>
                      <Text>{t('ipYourAnswer')}<Text type={isQuizPending(r) ? undefined : (r.is_correct ? 'success' : 'danger')}>{r.user_answer || t('ipUnanswered')}</Text></Text>
                      {!r.is_correct && !isQuizPending(r) && !r.needs_review && (
                        <div><Text type="secondary">{t('ipCorrectAnswer')}{r.correct_answer}</Text></div>
                      )}
                      {/* S-GRADING(P3): 逐题得分与判分来源(以前简答题只给"对/错", 扣了几分完全看不出) */}
                      {!isQuizPending(r) && (
                        <div style={{ marginTop: 4 }}>
                          <Text type="secondary">{t('ipQuestionScore')} {r.score ?? 0}/{r.max_score ?? 0}</Text>
                          {!!r.graded_by && <Tag style={{ marginLeft: 6 }}>{t(GRADED_BY_KEYS[String(r.graded_by)] || 'ipGradedByNone')}</Tag>}
                        </div>
                      )}
                      {!!r.comment && (
                        <div style={{ marginTop: 4 }}><Text type="secondary">{t('ipAiComment')}{r.comment}</Text></div>
                      )}
                      {!!r.feedback && (
                        <div style={{ marginTop: 4 }}><Text type="secondary">{t('ipAiFeedback')}{r.feedback}</Text></div>
                      )}
                      {!!r.needs_review && (
                        <div style={{ marginTop: 4 }}><Text type="warning">{t('ipNeedsReviewHint')}</Text></div>
                      )}
                    </div>
                    {r.explanation && (
                      <div style={{ marginTop: 8, padding: 8, background: 'var(--bg-layout)', borderRadius: 4 }}>
                        <Text type="secondary"><FormulaRenderer content={r.explanation} /></Text>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
            {/* 教师端：全班统计 */}
            {!(quizResultsView.view ? quizResultsView.view === 'student' : !!quizResultsView.quiz_title) && (
              <>
                {/* P1-4: 教师结果页原来只有"题目数/参与人数", 看不出整体水平 —— 补班级统计 */}
                {/* P1-3: 三段内容拆成页签 —— 概览 / 学生成绩 / 逐题分析(催批与 AI 按钮移到弹窗底部) */}
                <Tabs
                  activeKey={quizResultTab}
                  onChange={setQuizResultTab}
                  items={[
                    {
                      key: 'overview',
                      label: t('tabOverview'),
                      children: (
                        <>
                <Row gutter={[16, 12]} style={{ marginBottom: 16 }}>
                  <Col xs={12} sm={8} md={4}><Statistic title={t('ipQCount')} value={quizResultsView.quiz?.question_count} /></Col>
                  <Col xs={12} sm={8} md={4}><Statistic title={t('ipParticipants')} value={quizResultsView.total_answers} /></Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic title={t('statAvgScore')} value={quizResultsView.stats?.avg_score ?? 0}
                      suffix={`/ ${quizResultsView.quiz?.total_score ?? 0}`} />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic title={t('statAvgRate')} value={quizResultsView.stats?.avg_rate ?? 0} suffix="%" />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic title={t('statPassRate')} value={quizResultsView.stats?.pass_rate ?? 0} suffix="%" />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      {t('statHighRate')}: {quizResultsView.stats?.high_rate ?? '-'}%
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      {t('statLowRate')}: {quizResultsView.stats?.low_rate ?? '-'}%
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      {t('statGraded')}: {quizResultsView.stats?.graded_count ?? 0}
                    </div>
                  </Col>
                </Row>
                        </>
                      ),
                    },
                    {
                      key: 'students',
                      label: t('tabStudents'),
                      children: (
                        <>
                {/* 学生答题汇总 */}
                {quizResultsView.student_answers?.length > 0 && (
                  <Card title={t('ipStudentTable')} size="small" style={{ marginBottom: 16 }}
                    extra={<Input allowClear size="small" style={{ width: 220 }} placeholder={t('ipSearchStudent')}
                      value={quizStuSearch} onChange={(e) => setQuizStuSearch(e.target.value)} />}>
                    <Table
                      dataSource={(quizResultsView.student_answers || []).filter((r: any) => {
                        const kw = quizStuSearch.trim().toLowerCase()
                        if (!kw) return true
                        return [r.student, r.student_name, r.class_name, r.grade]
                          .some((x: any) => String(x || '').toLowerCase().includes(kw))
                      })}
                      rowKey="student" size="small"
                      pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], showTotal: (num: number) => t('ipNTotal', { count: num }) }}
                      columns={[
                        // 列合并(去横向滚动): 姓名+学号、年级+班级、答对/总题 双行; 得分改百分制并带得分率
                        { title: t('ipIdx'), key: 'idx', width: 44, render: (_: any, __: any, i: number) => i + 1 },
                        { title: t('ipName'), key: 'student', width: 124, ellipsis: true,
                          render: (_: any, r: any) => (
                            <div>
                              <div>{r.student_name || r.student}</div>
                              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{r.student}</div>
                            </div>
                          ) },
                        { title: t('ipGrade'), key: 'grade_class', width: 108,
                          render: (_: any, r: any) => (
                            <ScopeTag variant="text" grade={r.grade} classes={String(r.class_name ?? '')} />
                          ) },
                        { title: t('ipCorrectCol'), dataIndex: 'correct_count', width: 92,
                          render: (v: number, r: any) => (
                            r.pending_ai
                              ? <Tooltip title={t('ipGradingPendingN', { count: r.pending_ai })}>
                                  <Text type="secondary">—</Text>
                                </Tooltip>
                              : <Text strong color={percentStatus(toPercentInt(v, r.total_questions))}>
                                  {v}/{r.total_questions}
                                </Text>
                          ),
                        },
                        // R2 + 2026-10-16: 得分列统一 100 分制 —— 按 x/y 展示（满分即 100），
                        // 不再附"原始得分 x/y"之类的注解
                        { title: t('ipScoreCol'), key: 'score', width: 96,
                          render: (_: any, r: any) => {
                            const pct = r.percentage ?? toPercent(r.score, r.total_score)
                            if (r.pending_ai) {
                              return <Tooltip title={t('ipGradingPendingN', { count: r.pending_ai })}>
                                <Text type="secondary">—</Text>
                              </Tooltip>
                            }
                            return (
                              <Text strong color={percentStatus(pct)}>
                                {r.score ?? pct} / {r.total_score ?? 100}
                              </Text>
                            )
                          },
                        },
                        // S-GRADING(P3): 谁的卷子还没判完
                        { title: t('ipGradingState'), key: 'gs', width: 96,
                          render: (_: any, r: any) => (
                            r.pending_ai ? <Tag color="blue">{t('ipGradingPendingN', { count: r.pending_ai })}</Tag>
                              : r.pending_review ? <Tag color="orange">{t('ipNeedsReviewN', { count: r.pending_review })}</Tag>
                              : <Tag color="green">{t('ipGraded')}</Tag>
                          ),
                        },
                        { title: t('ipSubmitted'), dataIndex: 'submitted_at', width: 130, ellipsis: true },
                      ]} />
                  </Card>
                )}
                        </>
                      ),
                    },
                    {
                      key: 'questions',
                      label: t('tabQuestions'),
                      children: (
                        <>
                {/* 宽表收敛: 题面单行截断, 选项/配图/答案收进展开行 —— 不再靠 400px 列宽铺满 */}
                <Table dataSource={quizResultsView.question_stats} rowKey="index" size="small"
                  locale={{ emptyText: t('aiNeedData') }}
                  pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (num: number) => t('ipNTotal', { count: num }), pageSizeOptions: ['5', '10', '20'] }}
                  expandable={{
                    expandedRowRender: (r: any) => (
                      <div>
                        <MediaDisplay svgContent={r.svg_content} hasSvg={r.has_svg} mediaFiles={(r as any).media_files} size="normal" />
                        {r.options?.length > 0 && (
                          <div style={{ marginTop: 4, paddingLeft: 8 }}>
                            {r.options.map((opt: string, j: number) => (
                              <div key={j} style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                <FormulaRenderer content={opt} inline />
                              </div>
                            ))}
                          </div>
                        )}
                        <AnswerLine color="blue" style={{ marginTop: 4 }} label={t('ipAnswerLabel')} value={r.correct_answer} />
                      </div>
                    ),
                  }}
                  columns={[
                    { title: t('ipQNoCol'), dataIndex: 'index', render: (i: number) => i + 1, width: 56 },
                    { title: t('ipQuestionCol'), key: 'question',
                      render: (_: any, r: any) => (
                        <Tooltip title={<div style={{ maxWidth: 420 }}><FormulaRenderer content={r.question} /></div>}>
                          <div style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                            <FormulaRenderer content={r.question} />
                          </div>
                        </Tooltip>
                      ),
                    },
                    { title: t('correctRate'), dataIndex: 'correct_rate', width: 132,
                      render: (v: number, r: any) => (
                        <Space size={6}>
                          <Progress type="circle" percent={Math.round(v)} size={30}
                            strokeColor={percentColor(Number(v))} format={(p) => `${p}%`} />
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {r.correct_count}/{r.total_count}
                            {r.pending_count > 0 ? ` (+${r.pending_count} ${t('gradingInProgress')})` : ''}
                          </Text>
                        </Space>
                      ),
                    },
                  ]} />
                {quizAiAnalysis && (
                  <Card size="small" style={{ marginTop: 12 }} title={<Space><RobotOutlined />{t('ipAiAnalyze')}</Space>}>
                    {quizAiCached && (
                      <div style={{ marginBottom: 6 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>{t('aiAnalyzeCached')}</Text>
                      </div>
                    )}
                    <div className="markdown-content">
                      <FormulaRenderer content={quizAiAnalysis} />
                    </div>
                  </Card>
                )}
                        </>
                      ),
                    },
                  ]}
                />
              </>
            )}
          </>
        )}
      </Modal>

      {/* ── AI 生成测验弹窗 ── */}
      <Modal maskClosable={false} title={<Space><RobotOutlined />{t('aiGenerateQuiz')}</Space>} open={aiQuizModal}
        onCancel={() => { setAiQuizModal(false); setAiQuizResult(null); setAiQuizScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' }) }}
        footer={aiQuizResult?.questions?.length > 0 ? [
          <Button key="cancel" onClick={() => { setAiQuizModal(false); setAiQuizResult(null); setAiQuizScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' }) }}>{t('cancel')}</Button>,
          <Button key="apply" type="primary" onClick={handleApplyAiQuiz}>{t('fillForm')}</Button>,
        ] : null}>
        <Form form={aiQuizForm} layout="vertical" onFinish={handleAiGenerateQuiz}>
          {/* 知识点（= 出题主题）：与试题管理同款控件，下拉选课程知识点或直接手输 */}
          <Form.Item name="topic" label={t('knowledgePoint')} rules={[{ required: true, message: t('pleaseInputTopic') }]}>
            <KnowledgePointSelect
              multiple={false}
              subject={aiQuizSubject}
            />
          </Form.Item>
          <Form.Item name="subject" label={t('subject')} initialValue={subjectOptions[0] || ''}>
            <Select>
              {subjectOptions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="question_type" label={t('questionMode')} initialValue="single">
            <Select>
              <Select.Option value="single">{t('singleOnly')}</Select.Option>
              <Select.Option value="true_false">{t('trueFalseOnly')}</Select.Option>
              <Select.Option value="mixed">{t('mixedMode')}</Select.Option>
            </Select>
          </Form.Item>
          {/* 单位「题」放在控件外面：Form.Item 只有"唯一子元素是控件"时才会把
              value/onChange 注入进去。以前这里写成 <InputNumber /> {t('questions')}
              两个子元素，导致 count 从来没进过表单状态，请求体里也就没有它，
              老师把数量改成 8 也永远拿到后端默认值的 5 题。 */}
          <Form.Item label={t('questionCount')}>
            <Space size={6}>
              <Form.Item name="count" initialValue={5} noStyle>
                <InputNumber min={1} max={50} style={{ width: 120 }} />
              </Form.Item>
              <Text type="secondary">{t('questions')}</Text>
            </Space>
          </Form.Item>
          <Form.Item label={t('targetScope')}>
            <ActivityScopeSelector value={aiQuizScope} onChange={setAiQuizScope} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={aiQuizLoading} icon={<RobotOutlined />} block>
            {t('aiGenerate')}
          </Button>
        </Form>
        {aiQuizResult?.questions?.length > 0 && (
          <div style={{ marginTop: 12, maxHeight: 400, overflow: 'auto' }}>
            <Text strong style={{ fontSize: 15 }}>{t('generateResult', { count: aiQuizResult.questions.length })}</Text>
            {aiQuizResult.questions.map((q: any, i: number) => (
              <div key={i} style={{
                padding: 10, marginTop: 8, borderRadius: 6,
                background: 'var(--bg-layout)', border: '1px solid var(--border-color)',
              }}>
                <Text strong>{i + 1}. </Text><FormulaRenderer content={q.question} />
                <MediaDisplay svgContent={q.svg_content || q.svg_code} hasSvg={q.has_svg || (q.svg_code ? 1 : 0)} mediaFiles={(q as any).media_files} size="normal" />
                {q.options && (
                  <div style={{ marginTop: 4, paddingLeft: 16 }}>
                    {q.options.map((opt: string, j: number) => (
                      <div key={j} style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{opt}</div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 4 }}>
                  <AnswerLine color="green" label={t('answerColon')} value={q.answer} />
                </div>
                {q.explanation && (
                  <div style={{ marginTop: 2, fontSize: 12, color: 'var(--text-tertiary)', paddingLeft: 4 }}>
                    💡 <FormulaRenderer content={q.explanation} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>









      {/* ── 编辑测验弹窗 ── */}
      <Modal maskClosable={false} title={t('ipEditQuiz')} open={!!editQuizModal} onCancel={() => setEditQuizModal(null)}
        onOk={handleEditQuiz} okText={t('ipSave')}>
        <Form form={editQuizForm} layout="vertical">
          <Form.Item name="title" label={t('quizTitle')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('ipDesc')}>
            <Input />
          </Form.Item>
          {/* 学科：AI 建卷时选的会在这里显示，老测验也能在这里补上（列表与活动监控随即显示） */}
          <Form.Item name="subject" label={t('subject')}>
            <Select allowClear placeholder={t('subject')}>
              {subjectOptions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
            </Select>
          </Form.Item>
          {/* 状态不在这里改：列表上的「发布开关」负责发布/结束/重开，各有前置校验 */}
        </Form>
      </Modal>






    </Card>
  )
}

export default InteractionPage
