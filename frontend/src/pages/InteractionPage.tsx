import React, { useEffect, useRef, useState } from 'react'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import {
  Card, Tabs, Button, Space, Typography, List, Tag, Modal,
  Form, Input, InputNumber, Select, message, Empty, Spin, Radio, Result,
  Statistic, Row, Col, Table, Progress, Popconfirm, Checkbox, Pagination,
} from 'antd'
import {
  ThunderboltOutlined, BarChartOutlined,
  PlusOutlined, PlayCircleOutlined,
  RobotOutlined,
  EditOutlined, DeleteOutlined, DownloadOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useTranslation } from 'react-i18next'
import AnswerLine from '../components/AnswerLine'
import { useAuthStore } from '../stores/authStore'
import QuizEditor from '../components/QuizEditor'
import type { Question } from '../components/QuizEditor'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
import ResetActivityButton from '../components/ResetActivityButton'
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
  const [aiQuizModal, setAiQuizModal] = useState(false)
  const [aiQuizLoading, setAiQuizLoading] = useState(false)
  const [aiQuizResult, setAiQuizResult] = useState<any>(null)
  const [aiQuizForm] = Form.useForm()
  const [aiQuizScope, setAiQuizScope] = useState<ActivityScopeValue>({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
  // 列表分页
  const [quizPage, setQuizPage] = useState(1)
  const [quizPageSize, setQuizPageSize] = useState(10)
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])

  // 从系统配置加载课程列表
  useEffect(() => {
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setSubjectOptions(data.subjects)
    }).catch(() => {})
  }, [])

  // ── 当前激活的 Tab ──
  const [activeTab, setActiveTab] = useState('quizzes')

  // ── 编辑状态 ──
  const [editQuizModal, setEditQuizModal] = useState<any>(null)
  const [editQuizForm] = Form.useForm()
  // ── 编辑/删除处理 ──
  const handleDeleteQuiz = async (id: number) => {
    try { await apiClient.delete(`/api/interaction/quizzes/${id}`); message.success(t('deleted')); setActiveTab('quizzes'); await loadQuizzes() }
    catch { message.error(t('deleteFailed')) }
  }
  const handleEditQuiz = async () => {
    const values = await editQuizForm.validateFields()
    try {
      await apiClient.put(`/api/interaction/quizzes/${editQuizModal.id}`, values)
      message.success(t('updated')); setEditQuizModal(null); setActiveTab('quizzes'); await loadQuizzes()
    } catch { message.error(t('updateFailed')) }
  }
  // ── 加载数据 ──
  const loadQuizzes = async () => {
    setQuizLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/quizzes', { params: { page_size: 50 } })
      setQuizzes(data.quizzes || [])
    } catch { /* ignore */ }
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
      console.log('生成测验参数:', values)
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
          target_scope: aiQuizScope.target_scope,
          target_grade: aiQuizScope.target_grade,
          target_class: aiQuizScope.target_class,
          target_users: aiQuizScope.target_users,
        })
        message.success(t('quizCreated', { count: aiQuizResult.questions.length }))
        setAiQuizModal(false)
        setAiQuizResult(null)
        setAiQuizScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
        setActiveTab('quizzes')
        await loadQuizzes()
      } catch (err: any) {
        message.error(err.response?.data?.detail || t('createFailed'))
      }
    }
  }

  // ── 创建测验（使用 QuizEditor） ──
  const handleCreateQuiz = async (title: string, description: string, questions: Question[], scope?: any) => {
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
        target_scope: scope?.target_scope || 'teacher_classes',
        target_grade: scope?.target_grade || '',
        target_class: scope?.target_class || '',
        target_users: scope?.target_users || '',
      })
      message.success(t('quizCreatedWithTitle', { title, count: questions.length }))
      setQuizEditorOpen(false)
      setActiveTab('quizzes')
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
  }

  const handleSubmitQuiz = async () => {
    if (!takingQuiz) return
    const answers = takingQuiz.questions.map((_q: any, i: number) => ({
      question_index: i,
      answer: quizAnswers[i] || '',
    }))
    try {
      const { data } = await apiClient.post(`/api/interaction/quizzes/${takingQuiz.id}/answer`, { answers: JSON.stringify(answers) })
      setQuizResult(data)
      // S-GRADING(P3): 主观题改由后台批量批改, 提交即刻返回, 成绩稍后自动更新
      if (Number(data?.pending_ai || 0) > 0) message.info(t('ipGradingQueued', { count: data.pending_ai }))
    } catch (err: any) {
      message.error(err.response?.data?.detail || t('submitFailed'))
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

  const handleQuizAiAnalysis = async (quizId: number) => {
    if (!quizId) return
    setQuizAiAnalysisLoading(true)
    setQuizAiAnalysis(null)
    try {
      const { data } = await apiClient.get(`/api/interaction/quizzes/${quizId}/ai-analysis`, { timeout: 180000 })
      if (data.task_id) {
        // 异步任务，轮询结果
        const result = await pollAiTask(data.task_id)
        if (result) setQuizAiAnalysis(result.analysis)
        else message.error(t('aiAnalyzeTimeout'))
      } else {
        // 兼容旧版同步返回
        setQuizAiAnalysis(data.analysis)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('aiAnalyzeFailed'))
    }
    setQuizAiAnalysisLoading(false)
  }

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
              <Button icon={<RobotOutlined />} onClick={() => { setAiQuizModal(true); setAiQuizResult(null); aiQuizForm.resetFields(); }}>
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
            {quizzes.length === 0 ? <Empty description={t('noPolls')} /> : (
              <>
                <List
                  dataSource={quizzes.slice((quizPage - 1) * quizPageSize, quizPage * quizPageSize)}
                  renderItem={(quiz: any) => (
                  <Card size="small" style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <Text strong>{quiz.title}</Text>
                        <div style={{ marginTop: 4 }}>
                          <Tag>{t('ipNCount', { count: quiz.questions?.length || 0 })}</Tag>
                          <Tag color={quiz.status === 'active' ? 'green' : 'default'}>
                            {quiz.status === 'active' ? t('started') : t('ended')}
                          </Tag>
                          <Tag color="blue">{quiz.creator_name || quiz.creator_username}</Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>{t('peopleCount', { count: quiz.answer_count || 0 })}</Text>
                        </div>
                      </div>
                      <Space>
                        {quiz.status === 'active' && isStudent && !quiz.answered && (
                          <Button size="small" type="primary" icon={<PlayCircleOutlined />}
                            onClick={() => handleStartQuiz(quiz)}>{t('startQuiz')}</Button>
                        )}
                        {quiz.status === 'active' && isStudent && quiz.answered && (
                          <Button size="small" icon={<BarChartOutlined />}
                            onClick={() => handleViewQuizResults(quiz.id)}>{t('results')}</Button>
                        )}
                        {isTeacherOrAdmin && (
                          <>
                            <Button size="small" icon={<BarChartOutlined />}
                              onClick={() => handleViewQuizResults(quiz.id)}>{t('results')}</Button>
                            <Button size="small" icon={<DownloadOutlined />}
                              onClick={() => window.open(`/api/export/quiz/${quiz.id}`, '_blank')}>{t('ipExport')}</Button>
                            <Button size="small" icon={<EditOutlined />}
                              onClick={() => { editQuizForm.setFieldsValue(quiz); setEditQuizModal(quiz) }}>{t('ipEdit')}</Button>
                            <ResetActivityButton activityType="quiz" activityId={quiz.id}
                                iconOnly stopPropagation onSuccess={loadQuizzes} />
                            <Popconfirm title={t('confirmDeleteQuiz')} onConfirm={() => handleDeleteQuiz(quiz.id)}>
                              <Button size="small" danger icon={<DeleteOutlined />} />
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
                  current={quizPage} pageSize={quizPageSize} total={quizzes.length}
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
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 12 }}>
              {t('title')}
            </Text>
          </Space>
        </div>
      </Card>

      <Card>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
      </Card>

      {/* ── 答题弹窗 ── */}
      <Modal maskClosable={false} title={takingQuiz?.title} open={!!takingQuiz && !quizResult}
        onCancel={() => { setTakingQuiz(null); setQuizResult(null) }}
        footer={[
          <Button key="submit" type="primary" onClick={handleSubmitQuiz}>{t('submit')}</Button>,
        ]}
        width={640}>
        {takingQuiz?.questions?.map((q: any, i: number) => (
          <div key={i} style={{ marginBottom: 12, padding: 12, background: '#fafafa', borderRadius: 4, border: '1px solid #f0f0f0' }}>
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
                    <Radio value="对" style={{ lineHeight: 2 }}>对</Radio>
                    <Radio value="错" style={{ lineHeight: 2 }}>错</Radio>
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
              : (quizResult.percentage >= 60 ? 'success' : 'warning')}
            title={t('ipScoreOf', { score: quizResult.score, total: quizResult.total_score })}
            subTitle={Number(quizResult.pending_ai || 0) > 0
              ? t('ipGradingPendingHint', { count: quizResult.pending_ai })
              : t('accuracyRate', { percent: quizResult.percentage })}
          />
        )}
      </Modal>

      {/* ── 测验结果统计弹窗 ── */}
      <Modal title={quizResultsView?.quiz_title ? t('ipMyScore', { title: quizResultsView.quiz_title }) : t('ipQuizResult')}
        open={!!quizResultsView}
        onCancel={() => {
          setQuizResultsView(null)
          setQuizResultsId(null)          // 关掉就停轮询
          setQuizResultsPending(0)
        }}
        footer={null} width={900}>
        {quizResultsView && (
          <>
            {/* 学生端：个人答题结果 */}
            {quizResultsView.quiz_title && (
              <div>
                <Card style={{ textAlign: 'center', marginBottom: 16 }}>
                  <Progress type="circle" percent={quizResultsView.percentage}
                    format={p => `${p}%`}
                    strokeColor={quizResultsView.percentage >= 80 ? '#52c41a' : quizResultsView.percentage >= 60 ? '#faad14' : '#ff4d4f'} />
                  <div style={{ marginTop: 8 }}>
                    <Text>{t('ipScore', { score: quizResultsView.score, total: quizResultsView.total_score })}</Text>
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
                          <div key={k} style={{ fontSize: 12, color: '#555', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {k}. <FormulaRenderer content={v as string} inline />
                          </div>
                        ))}
                      </div>
                    )}
                    {r.options && Array.isArray(r.options) && (
                      <div style={{ marginTop: 4, paddingLeft: 8 }}>
                        {r.options.map((opt: string, j: number) => (
                          <div key={j} style={{ fontSize: 12, color: '#555', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
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
                      <div style={{ marginTop: 8, padding: 8, background: '#f5f5f5', borderRadius: 4 }}>
                        <Text type="secondary"><FormulaRenderer content={r.explanation} /></Text>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
            {/* 教师端：全班统计 */}
            {!quizResultsView.quiz_title && (
              <>
                <Row gutter={16} style={{ marginBottom: 16 }}>
                  <Col span={8}><Statistic title={t('ipQCount')} value={quizResultsView.quiz?.question_count} /></Col>
                  <Col span={8}><Statistic title={t('ipParticipants')} value={quizResultsView.total_answers} /></Col>
                </Row>
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
                        { title: t('ipIdx'), key: 'idx', width: 48, render: (_: any, __: any, i: number) => i + 1 },
                        { title: t('ipName'), dataIndex: 'student_name', width: 90, ellipsis: true },
                        { title: t('ipUsername'), dataIndex: 'student', width: 100, ellipsis: true },
                        { title: t('ipGrade'), dataIndex: 'grade', width: 64 },
                        { title: t('ipClass'), dataIndex: 'class_name', width: 88 },
                        { title: t('ipCorrectCol'), dataIndex: 'correct_count', width: 72,
                          render: (v: number, r: any) => (
                            <Text strong style={{ color: v === r.total_questions ? '#52c41a' : v > 0 ? '#faad14' : '#ff4d4f' }}>
                              {v}/{r.total_questions}
                            </Text>
                          ),
                        },
                        { title: t('ipScoreCol'), dataIndex: 'score', width: 64 },
                        // S-GRADING(P3): 谁的卷子还没判完
                        { title: t('ipGradingState'), key: 'gs', width: 104,
                          render: (_: any, r: any) => (
                            r.pending_ai ? <Tag color="blue">{t('ipGradingPendingN', { count: r.pending_ai })}</Tag>
                              : r.pending_review ? <Tag color="orange">{t('ipNeedsReviewN', { count: r.pending_review })}</Tag>
                              : <Tag color="green">{t('ipGraded')}</Tag>
                          ),
                        },
                        { title: t('ipSubmitted'), dataIndex: 'submitted_at', width: 150 },
                      ]} />
                  </Card>
                )}
                <div style={{ textAlign: 'right', marginBottom: 8 }}>
                  {/* S-GRADING(P3): 后台还没判完 / 有题判不准时, 教师可以立刻催批 */}
                  {(Number(quizResultsView.pending_ai_total || 0) > 0
                    || Number(quizResultsView.pending_review_total || 0) > 0) && (
                    <Space size={6} wrap style={{ marginRight: 8 }}>
                      {quizResultsView.pending_ai_total > 0 && (
                        <Tag color="blue">{t('ipGradingPendingN', { count: quizResultsView.pending_ai_total })}</Tag>
                      )}
                      {quizResultsView.pending_review_total > 0 && (
                        <Tag color="orange">{t('ipNeedsReviewN', { count: quizResultsView.pending_review_total })}</Tag>
                      )}
                      <Popconfirm title={t('ipGradeNowConfirm')} onConfirm={() => handleQuizGradeNow(false)}>
                        <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />}
                          loading={quizGradingNow} disabled={!(quizResultsView.pending_ai_total > 0)}>
                          {t('ipGradeNow')}
                        </Button>
                      </Popconfirm>
                      {quizResultsView.pending_review_total > 0 && (
                        <Popconfirm title={t('ipRetryReviewConfirm')} onConfirm={() => handleQuizGradeNow(true)}>
                          <Button size="small" loading={quizGradingNow}>{t('ipRetryReview')}</Button>
                        </Popconfirm>
                      )}
                    </Space>
                  )}
                  <Button icon={<RobotOutlined />} size="small"
                    loading={quizAiAnalysisLoading}
                    onClick={() => handleQuizAiAnalysis(quizResultsView.quiz?.id)}>
                    {t('ipAiAnalyze')}
                  </Button>
                </div>
                <Table dataSource={quizResultsView.question_stats} rowKey="index" size="small"
                  pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (num: number) => t('ipNTotal', { count: num }), pageSizeOptions: ['5', '10', '20'] }}
                  columns={[
                    { title: t('ipQNoCol'), dataIndex: 'index', render: (i: number) => i + 1, width: 60 },
                    { title: t('ipQuestionCol'), key: 'question', width: 400,
                      render: (_: any, r: any) => (
                        <div>
                          <FormulaRenderer content={r.question} />
                          <MediaDisplay svgContent={r.svg_content} hasSvg={r.has_svg} mediaFiles={(r as any).media_files} size="normal" />
                          {r.options?.length > 0 && (
                            <div style={{ marginTop: 4, paddingLeft: 8 }}>
                              {r.options.map((opt: string, j: number) => (
                                <div key={j} style={{ fontSize: 12, color: '#555', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                  <FormulaRenderer content={opt} inline />
                                </div>
                              ))}
                            </div>
                          )}
                          <AnswerLine color="blue" style={{ marginTop: 4 }} label={t('ipAnswerLabel')} value={r.correct_answer} />
                        </div>
                      ),
                    },
                    { title: t('correctRate'), dataIndex: 'correct_rate', width: 100,
                      render: (r: number) => (
                        <Text strong style={{ color: r >= 60 ? '#52c41a' : '#ff4d4f' }}>{r}%</Text>
                      ),
                    },
                  ]} />
                {quizAiAnalysis && (
                  <Card size="small" style={{ marginTop: 12, background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                    <div className="markdown-content">
                      <ReactMarkdown>{quizAiAnalysis}</ReactMarkdown>
                    </div>
                  </Card>
                )}
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
          <Form.Item name="topic" label={t('inputTopic')} rules={[{ required: true, message: t('pleaseInputTopic') }]}>
            <Input placeholder={t('topicPlaceholder')} />
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
          <Form.Item name="count" label={t('questionCount')} initialValue={5}>
            <InputNumber min={1} max={50} defaultValue={5} style={{ width: 120 }} /> {t('questions')}
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
                background: '#fafafa', border: '1px solid #f0f0f0',
              }}>
                <Text strong>{i + 1}. </Text><FormulaRenderer content={q.question} />
                <MediaDisplay svgContent={q.svg_content || q.svg_code} hasSvg={q.has_svg || (q.svg_code ? 1 : 0)} mediaFiles={(q as any).media_files} size="normal" />
                {q.options && (
                  <div style={{ marginTop: 4, paddingLeft: 16 }}>
                    {q.options.map((opt: string, j: number) => (
                      <div key={j} style={{ fontSize: 13, color: '#555' }}>{opt}</div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 4 }}>
                  <AnswerLine color="green" label={t('answerColon')} value={q.answer} />
                </div>
                {q.explanation && (
                  <div style={{ marginTop: 2, fontSize: 12, color: '#888', paddingLeft: 4 }}>
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
          <Form.Item name="status" label={t('ipStatus')}>
            <Select>
              <Select.Option value="active">{t('ipStatusActive')}</Select.Option>
              <Select.Option value="closed">{t('ipStatusEnded')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>






    </Card>
  )
}

export default InteractionPage
