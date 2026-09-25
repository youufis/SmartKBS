import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Layout, Card, Button, message, Modal, Radio, Checkbox, Input, Alert,
  Typography, Space, Tag, Spin, Result, Progress, Row, Col, Divider, theme,
} from 'antd'
import {
  ArrowLeftOutlined, ArrowRightOutlined, CheckCircleOutlined,
  CloseCircleOutlined, ClockCircleOutlined, SendOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import { confirmUnanswered, unansweredIndexes } from '../utils/submitGuard'
import * as examsApi from '../api/exams'
import type { ExamInfo, ExamQuestion } from '../types'

const { TextArea } = Input
const { Text, Title } = Typography

/** B1: 本地草稿镜像键（断网或服务端草稿缺失时的兜底） */
const draftKey = (examId: string | number, attemptId?: number | null) =>
  `smartkb_exam_draft_${examId}_${attemptId ?? 0}`

/** 草稿/正式答案都可能是 {qid: string} 或 {qid: {student_answer}}，统一成 {qid: string} */
function normalizeAnswerMap(raw: unknown): Record<string, string> | null {
  let obj: any = raw
  if (typeof obj === 'string') {
    if (!obj.trim()) return null
    try { obj = JSON.parse(obj) } catch { return null }
  }
  if (!obj || typeof obj !== 'object') return null
  const out: Record<string, string> = {}
  Object.keys(obj).forEach((qid) => {
    const v = obj[qid]
    out[qid] = v && typeof v === 'object' ? String(v.student_answer ?? '') : String(v ?? '')
  })
  return Object.keys(out).length ? out : null
}

function readLocalDraft(examId: string | number, attemptId?: number | null) {
  try {
    const raw = localStorage.getItem(draftKey(examId, attemptId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { at?: number; answers?: unknown }
    const map = normalizeAnswerMap(parsed?.answers)
    return map ? { at: Number(parsed.at) || 0, answers: map } : null
  } catch { return null }
}

/**
 * 续答恢复优先级：服务端草稿与本地镜像取「更新且更全」的那个，
 * 都没有才回落到已提交的 answers（兼容老数据）。
 */
function pickRestoredAnswers(attempt: any, examId: string | number, attemptId?: number | null) {
  const server = normalizeAnswerMap(attempt?.draft_answers)
  const serverAt = attempt?.draft_saved_at
    ? new Date(String(attempt.draft_saved_at).replace(' ', 'T')).getTime() || 0
    : 0
  const local = readLocalDraft(examId, attemptId)
  if (server && local) {
    const localNewer = local.at > serverAt
    const localMore = Object.keys(local.answers).length > Object.keys(server).length
    return (localNewer && localMore) ? local.answers : server
  }
  return server || local?.answers || normalizeAnswerMap(attempt?.answers)
}

const ExamTakePage: React.FC = () => {
  const { t } = useTranslation('exam')
  const { examId } = useParams<{ examId: string }>()
  const navigate = useNavigate()
  const { token } = theme.useToken()

  const TYPE_LABELS: Record<string, string> = {
    single: t('singleChoice'),
    multiple: t('multipleChoice'),
    true_false: t('trueFalse'),
    short: t('shortAnswer'),
    fill: t('fillBlank'),
    essay: t('essay'),
    subjective: t('subjective'),
  }
  // ── 考试数据 ──
  const [exam, setExam] = useState<ExamInfo | null>(null)
  const [questions, setQuestions] = useState<ExamQuestion[]>([])
  const [loading, setLoading] = useState(true)

  // ── 答题状态 ──
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [currentIndex, setCurrentIndex] = useState(0)
  const [attemptId, setAttemptId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [result, setResult] = useState<{
    score: number;
    total_score: number;
    passed: boolean;
    details?: Record<string, any>;
    /** S-GRADING(P2): 还有几道主观题在后台批改 */
    pending_ai?: number;
  } | null>(null)

  // ── 计时器 ──
  const [timeLeft, setTimeLeft] = useState<number>(0)
  const [timerActive, setTimerActive] = useState(false)
  // B1: 个人时限已到（服务端裁决），页面转只读但仍允许交卷
  const [timeExpired, setTimeExpired] = useState(false)
  // B1: 草稿自动保存状态与本地时间戳
  const [draftState, setDraftState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [draftAt, setDraftAt] = useState('')
  const draftTimerRef = useRef<number | null>(null)
  // 恢复出来的答案不要立刻反向回写一次草稿
  const draftSkipRef = useRef(true)

  // ── 加载考试 ──
  const loadExam = useCallback(async () => {
    if (!examId) return
    setLoading(true)
    try {
      // 先开始考试
      const startRes = await examsApi.startExam(Number(examId))
      setAttemptId(startRes.attempt_id)

      const detail = await examsApi.getExam(Number(examId))
      setExam(detail)
      const qs = detail.questions || []
      setQuestions(qs)

      // B1: 倒计时以服务端 started_at 算出的剩余秒数为准，刷新/换设备不再从头计
      const serverLeft = typeof startRes.remaining_seconds === 'number'
        ? startRes.remaining_seconds
        : (typeof detail.remaining_seconds === 'number' ? detail.remaining_seconds : null)
      if (serverLeft !== null) {
        setTimeLeft(serverLeft)
        if (serverLeft <= 0) {
          setTimeExpired(true)
          setTimerActive(false)
        } else {
          setTimerActive(true)
        }
      } else if (detail.duration) {
        // 未设个人时长的老口径：只受考试起止窗约束
        setTimeLeft(detail.duration * 60)
        setTimerActive(true)
      }

      // B1: 续答恢复（服务端草稿 / 本地镜像 / 已提交答案 三级兜底）
      if (startRes.existing) {
        const restored = pickRestoredAnswers(detail.my_attempt, examId, startRes.attempt_id)
        if (restored) {
          draftSkipRef.current = true
          setAnswers(restored)
        }
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('loadFailed'))
      navigate('/exam')
    } finally {
      setLoading(false)
    }
  }, [examId, navigate])

  useEffect(() => {
    if (examId) loadExam()
  }, [examId, loadExam])

  const handleSubmit = async () => {
    if (!examId || !attemptId) return
    setSubmitting(true)
    try {
      const res = await examsApi.submitExam(Number(examId), answers)
      setSubmitted(true)
      // B1: 交卷成功即清草稿（服务端写库时一并清空 draft_answers）
      if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current)
      try { localStorage.removeItem(draftKey(examId, attemptId)) } catch { /* 忽略 */ }
      setDraftState('idle')
      setResult({
        score: res.score,
        total_score: res.total_score,
        passed: res.passed,
        details: res.details || undefined,
        pending_ai: Number(res.pending_ai || 0),
      })
      // S-GRADING(P2): 主观题不再卡在本请求里, 提交即刻返回, 成绩判完自动刷新
      if (Number(res.pending_ai || 0) > 0) message.info(t('exSubmitQueued', { count: res.pending_ai }))
      else message.success(t('submitSuccess'))
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('submitFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  // ── 计时器逻辑 ──
  useEffect(() => {
    if (!timerActive || timeLeft <= 0) return
    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval)
          setTimerActive(false)
          // 自动提交
          message.warning(t('timeUp'))
          handleSubmit()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [timerActive])

  // ── 格式化时间 ──
  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  // ── 设置答案 ──
  const setAnswer = (qId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [qId]: value }))
  }

  const handleMultipleChange = (qId: string, optionKey: string, checked: boolean) => {
    const current = (answers[qId] || '').split(',').filter(Boolean)
    if (checked) {
      if (!current.includes(optionKey)) {
        setAnswer(qId, [...current, optionKey].join(','))
      }
    } else {
      setAnswer(qId, current.filter((k) => k !== optionKey).join(','))
    }
  }

  // ── 提交 ──

  // ── S-GRADING(P2): 主观题在后台批改时轮询成绩(8 秒一次, 最多 12 次≈96 秒) ──
  const pollRef = useRef<number | null>(null)
  useEffect(() => {
    if (!submitted || !attemptId || !result?.pending_ai) return
    let n = 0
    const id = window.setInterval(async () => {
      if (++n > 12) { window.clearInterval(id); return }
      try {
        const st = await examsApi.getAttemptGradingStatus(attemptId)
        setResult(prev => {
          if (!prev) return prev
          let details = prev.details
          if (st.show_details && details && st.items) {
            details = { ...details }
            Object.entries(st.items).forEach(([qid, patch]) => {
              if (details && details[qid]) details[qid] = { ...details[qid], ...(patch as object) }
            })
          }
          return {
            ...prev, score: st.score, total_score: st.total_score || prev.total_score,
            passed: st.passed, pending_ai: st.pending_ai, details,
          }
        })
        if (!st.pending_ai) {
          window.clearInterval(id)
          message.success(t('exGradingFinished'))
        }
      } catch { /* 本轮没判完, 下一轮再看 */ }
    }, 8000)
    pollRef.current = id
    return () => { if (pollRef.current) window.clearInterval(pollRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted, attemptId])

  /** S-GRADING(P2): 一道题当前是否还在批改中(分数未定, 不显示得分与对错) */
  const isPendingItem = (d: any) => d?.grading === 'pending' || d?.graded_by === 'queued'

  // ── B1: 答案变化 → 先落本地镜像，再防抖 2s 回写服务端草稿 ──
  useEffect(() => {
    if (!examId || submitted) return
    if (draftSkipRef.current) { draftSkipRef.current = false; return }
    try {
      localStorage.setItem(draftKey(examId, attemptId), JSON.stringify({ at: Date.now(), answers }))
    } catch { /* 隐私模式忽略 */ }
    setDraftState('saving')
    if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current)
    draftTimerRef.current = window.setTimeout(async () => {
      try {
        await examsApi.saveExamDraft(Number(examId), answers)
        setDraftState('saved')
        setDraftAt(new Date().toLocaleTimeString())
      } catch {
        // 不打断答题：状态标出来，下一次改动自然重试
        setDraftState('error')
      }
    }, 2000)
    return () => { if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current) }
  }, [answers, attemptId, examId, submitted])

  // ── B1: 有未交卷内容时拦一下刷新/关标签 ──
  const dirty = !submitted && Object.keys(answers).length > 0
  useEffect(() => {
    if (!dirty) return
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  /** P0 防误交：没答完必须明确点「仍然提交」才交卷（考试提交后不可改，还消耗答题机会） */
  const handleClickSubmit = async () => {
    const missing = unansweredIndexes(questions, (q) => !!(answers[String((q as { id?: number }).id ?? '')] || '').trim())
    const ok = await confirmUnanswered({
      missing,
      total: questions.length,
      t,
      extra: t('unansweredOneShot'),
    })
    if (ok) void handleSubmit()
  }

  // ── 返回 ──
  const handleBack = () => {
    if (!dirty) { navigate('/exam'); return }
    Modal.confirm({
      title: t('exLeaveTitle'),
      content: t('exLeaveContent'),
      okText: t('exLeaveOk'),
      cancelText: t('exLeaveStay'),
      onOk: () => navigate('/exam'),
    })
  }

  // ── 渲染题目 ──
  const renderQuestion = (q: ExamQuestion, idx: number) => {
    const qId = String(q.id)
    const answer = answers[qId] || ''

    return (
      <Card
        key={q.id}
        title={
          <Space>
            <Tag color="blue">{TYPE_LABELS[q.type] || q.type}</Tag>
            <span>{t('questionNum', { num: idx + 1 })}（{q.question_score} {t('points')}）</span>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <div style={{ fontSize: 15, lineHeight: 1.8, marginBottom: 16 }}>
          <FormulaRenderer content={q.question_text} />
        </div>

        <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} size="large" />

        {q.type === 'single' && q.options && (
          <Radio.Group value={answer} disabled={timeExpired} onChange={(e) => setAnswer(qId, e.target.value)}>
            <Space orientation="vertical" style={{ width: '100%' }}>
              {Object.entries(q.options).map(([key, val]) => (
                <Radio key={key} value={key}
                  style={{ padding: '8px 12px', borderRadius: 6, border: answer === key ? `1px solid ${token.colorPrimary}` : `1px solid ${token.colorBorderSecondary}`, width: '100%', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  <strong>{key}.</strong> <FormulaRenderer content={val as string} inline />
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        )}

        {q.type === 'multiple' && q.options && (
          <Checkbox.Group value={answer ? answer.split(',') : []} disabled={timeExpired}>
            <Space orientation="vertical" style={{ width: '100%' }}>
              {Object.entries(q.options).map(([key, val]) => (
                <Checkbox key={key} value={key}
                  onChange={(e) => handleMultipleChange(qId, key, e.target.checked)}
                  style={{ padding: '8px 12px', borderRadius: 6, border: `1px solid ${token.colorBorderSecondary}`, width: '100%', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  <strong>{key}.</strong> <FormulaRenderer content={val as string} inline />
                </Checkbox>
              ))}
            </Space>
          </Checkbox.Group>
        )}

        {q.type === 'true_false' && (
          <Radio.Group value={answer} disabled={timeExpired} onChange={(e) => setAnswer(qId, e.target.value)}>
            <Space>
              <Radio value="true" style={{ padding: '8px 20px', borderRadius: 6, border: answer === 'true' ? `1px solid ${token.colorPrimary}` : `1px solid ${token.colorBorderSecondary}` }}>{t('true')}</Radio>
              <Radio value="false" style={{ padding: '8px 20px', borderRadius: 6, border: answer === 'false' ? `1px solid ${token.colorPrimary}` : `1px solid ${token.colorBorderSecondary}` }}>{t('false')}</Radio>
            </Space>
          </Radio.Group>
        )}

        {(q.type === 'short' || q.type === 'fill' || q.type === 'essay' || q.type === 'subjective') && (
          <TextArea rows={q.type === 'essay' ? 10 : q.type === 'subjective' ? 8 : q.type === 'short' ? 4 : 3}
            disabled={timeExpired}
            value={answer}
            onChange={(e) => setAnswer(qId, e.target.value)}
            placeholder={q.type === 'essay' ? t('essayPlaceholder') : q.type === 'subjective' ? t('answerPlaceholder') : q.type === 'fill' ? t('fillPlaceholder') : t('answerPlaceholder')}
            showCount={q.type === 'essay'}
            maxLength={q.type === 'essay' ? 2000 : q.type === 'fill' ? 200 : undefined}
          />
        )}
      </Card>
    )
  }

  // ── 渲染结果 ──
  if (submitted && result) {
    // S-GRADING(P2): 还在批改中的题不计对错, 否则学生看到的就是"简答题全错"
    const allDetails = Object.values(result.details || {}) as any[]
    const pendingCount = Number(result.pending_ai || 0)
    const gradedDetails = allDetails.filter((d: any) => !isPendingItem(d))
    const correctCount = gradedDetails.filter((d: any) => d.is_correct).length
    return (
      <Layout style={{ minHeight: '100vh', background: token.colorBgLayout, padding: 24 }}>
        <Card style={{ maxWidth: 700, margin: '40px auto' }}>
          <Result
            status={pendingCount > 0 ? 'info' : (result.passed ? 'success' : 'error')}
            title={pendingCount > 0 ? t('exGradingPendingTitle') : (result.passed ? t('passExam') : t('failExam'))}
            subTitle={
              <Space orientation="vertical" size={8}>
                <Typography.Title level={2}
                  style={{ color: pendingCount > 0 ? token.colorPrimary : (result.passed ? token.colorSuccess : token.colorError), margin: 0 }}>
                  {result.score} {t('points')}
                </Typography.Title>
                <Typography.Text type="secondary">
                  {t('fullScore')} {result.total_score} {t('points')}
                </Typography.Text>
                {pendingCount > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 14 }}>
                    {t('exGradingPendingHint', { count: pendingCount })}
                  </Typography.Text>
                )}
              </Space>
            }
            extra={[
              <Button type="primary" key="back" onClick={handleBack}>
                {t('backToList')}
              </Button>,
            ]}
          >
            {result.details && (
              <div style={{ marginTop: 16 }}>
                <Divider />
                <Typography.Title level={5}>{t('answerDetail')}</Typography.Title>
                <Progress
                  percent={Math.round((result.score / result.total_score) * 100)}
                  status={pendingCount > 0 ? 'active' : (result.passed ? 'success' : 'exception')}
                  format={() => (pendingCount > 0
                    ? t('exGradingCountFormat', { graded: gradedDetails.length, total: allDetails.length })
                    : `${correctCount}/${allDetails.length} ${t('questionsCorrect')}`)}
                />
                {Object.entries(result.details).map(([qId, detail]: [string, any]) => {
                  const pendingItem = isPendingItem(detail)
                  const dims = detail.dimensions || {}
                  const isEssay = !pendingItem
                    && (detail.grading_type === 'essay' || !!(dims.content || dims.structure || dims.language))
                  return (
                    <Card key={qId} size="small"
                      style={{ marginTop: 8, background: pendingItem ? token.colorPrimaryBg : (detail.is_correct ? token.colorSuccessBg : token.colorErrorBg) }}>
                      <Space orientation="vertical" style={{ width: '100%' }}>
                        <Space wrap>
                          {pendingItem
                            ? <ClockCircleOutlined style={{ color: token.colorPrimary, fontSize: 18 }} />
                            : detail.is_correct
                            ? <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: 18 }} />
                            : <CloseCircleOutlined style={{ color: token.colorError, fontSize: 18 }} />}
                          <span>{t('yourAnsColon')}{detail.student_answer || t('unanswered')}</span>
                          {!detail.is_correct && !pendingItem && (
                            <span style={{ color: token.colorTextTertiary }}>{t('correctAnsColon')}{detail.correct_answer}</span>
                          )}
                          {pendingItem
                            ? <Tag color="blue">{t('exGradingPending')}</Tag>
                            : <Tag color={detail.is_correct ? 'green' : 'red'}>
                              {detail.score}/{detail.max_score} {t('fenUnit')}
                            </Tag>}
                        </Space>

                        {/* AI 简答题评语 */}
                        {detail.comment && (
                          <div style={{ color: token.colorPrimary, fontSize: 14 }}>
                            <strong>{t('aiCommentColon')}</strong>{detail.comment}
                          </div>
                        )}
                        {detail.feedback && (
                          <div style={{ color: token.colorSuccess, fontSize: 14 }}>
                            <strong>{t('studyAdviceColon')}</strong>{detail.feedback}
                          </div>
                        )}

                        {/* AI 主观题/作文 多维评分 */}
                        {isEssay && detail.dimensions && (
                          <div style={{ background: token.colorFillQuaternary, padding: 12, borderRadius: 6, width: '100%' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: 8 }}>{t('multiScore')}</div>
                            <Row gutter={16}>
                              {detail.dimensions.content && (
                                <Col span={8}>
                                  <div style={{ textAlign: 'center' }}>
                                    <div style={{ fontSize: 20, fontWeight: 'bold', color: token.colorPrimary }}>{detail.dimensions.content.score}</div>
                                    <div style={{ fontSize: 13, color: token.colorTextSecondary }}>{t('dimContent')}/10</div>
                                    <div style={{ fontSize: 13, color: token.colorTextTertiary }}>{detail.dimensions.content.comment}</div>
                                  </div>
                                </Col>
                              )}
                              {detail.dimensions.structure && (
                                <Col span={8}>
                                  <div style={{ textAlign: 'center' }}>
                                    <div style={{ fontSize: 20, fontWeight: 'bold', color: token.colorSuccess }}>{detail.dimensions.structure.score}</div>
                                    <div style={{ fontSize: 13, color: token.colorTextSecondary }}>{t('dimStructure')}/10</div>
                                    <div style={{ fontSize: 13, color: token.colorTextTertiary }}>{detail.dimensions.structure.comment}</div>
                                  </div>
                                </Col>
                              )}
                              {detail.dimensions.language && (
                                <Col span={8}>
                                  <div style={{ textAlign: 'center' }}>
                                    <div style={{ fontSize: 20, fontWeight: 'bold', color: token.colorWarning }}>{detail.dimensions.language.score}</div>
                                    <div style={{ fontSize: 13, color: token.colorTextSecondary }}>{t('dimLanguage')}/10</div>
                                    <div style={{ fontSize: 13, color: token.colorTextTertiary }}>{detail.dimensions.language.comment}</div>
                                  </div>
                                </Col>
                              )}
                            </Row>
                            {detail.overall_comment && (
                              <div style={{ marginTop: 8, fontSize: 14, color: token.colorText }}>
                                <strong>{t('overallColon')}</strong>{detail.overall_comment}
                              </div>
                            )}
                            {detail.improvement_suggestions?.length > 0 && (
                              <div style={{ marginTop: 6, fontSize: 13 }}>
                                <strong>{t('improveColon')}</strong>
                                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                                  {detail.improvement_suggestions.map((s: string, i: number) => (
                                    <li key={i} style={{ color: token.colorTextSecondary }}>{s}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                      </Space>
                    </Card>
                  )
                })}
              </div>
            )}
          </Result>
        </Card>
      </Layout>
    )
  }

  // ── 加载中 ──
  if (loading) {
    return (
      <Layout style={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', background: token.colorBgLayout }}>
        <Spin size="large" description={t('loadingExam')} />
      </Layout>
    )
  }

  if (!exam || questions.length === 0) {
    return (
      <Layout style={{ minHeight: '100vh', background: token.colorBgLayout, padding: 24 }}>
        <Result status="warning" title={t('examNoQ')}
          subTitle={t('contactTeacherAddQ')}
          extra={<Button onClick={handleBack}>{t('backBtn')}</Button>} />
      </Layout>
    )
  }

  const currentQuestion = questions[currentIndex]
  const answeredCount = Object.keys(answers).length
  const progressPercent = Math.round((answeredCount / questions.length) * 100)

  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      {/* ── 顶栏 ── */}
      <div style={{
        background: token.colorBgContainer, padding: '12px 24px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={handleBack}>{t('exitBtn')}</Button>
          <Title level={5} style={{ margin: 0 }}>{exam.title}</Title>
        </Space>
        <Space size={24}>
          <span>
            <ClockCircleOutlined style={{ marginRight: 4 }} />
            {t('remainTime')}
            <Text strong style={{ color: timeLeft < 300 ? token.colorError : token.colorPrimary, fontSize: 18 }}>
              {formatTime(timeLeft)}
            </Text>
          </span>
          <span>
            {t('progressLabel')}{answeredCount}/{questions.length}
          </span>
          {/* B1: 草稿自动保存状态（失败不打断答题，只标出来） */}
          {!submitted && draftState !== 'idle' && (
            <Text type="secondary" style={{ fontSize: 13 }}>
              {draftState === 'saving' && t('exDraftSaving')}
              {draftState === 'saved' && t('exDraftSaved', { at: draftAt })}
              {draftState === 'error' && t('exDraftRetry')}
            </Text>
          )}
          <Button type="primary" icon={<SendOutlined />}
            loading={submitting}
            onClick={() => { void handleClickSubmit() }}>
            {t('submitBtn')}
          </Button>
        </Space>
      </div>

      <div style={{ padding: 16, maxWidth: 960, margin: '0 auto', width: '100%' }}>
        {timeExpired && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} title={t('exTimeOverBanner')} />
        )}
        {/* ── 进度条 ── */}
        <Progress percent={progressPercent} size="small" style={{ marginBottom: 16 }} />

        {/* ── 题号导航 ── */}
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text strong style={{ fontSize: 14, whiteSpace: 'nowrap' }}>{t('qNavLabel')}</Text>
          <Space size={12}>
            <Text style={{ fontSize: 13 }}><Tag color={token.colorPrimary} style={{ lineHeight: '18px', padding: '0 6px' }}>1</Tag> {t('tkCurrent')}</Text>
            <Text style={{ fontSize: 13 }}><Tag color={token.colorSuccess} style={{ lineHeight: '18px', padding: '0 6px' }}>2</Tag> {t('tkAnswered')}</Text>
            <Text style={{ fontSize: 13 }}><Tag color={token.colorFillSecondary} style={{ lineHeight: '18px', padding: '0 6px', border: `1px solid ${token.colorBorder}` }}>3</Tag> {t('tkUnanswered')}</Text>
          </Space>
        </div>
        <div style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {questions.map((q, idx) => {
            const answered = !!answers[String(q.id)]
            const isCurrent = idx === currentIndex
            let tagColor: string
            let borderStyle: React.CSSProperties = {}
            if (isCurrent) {
              tagColor = token.colorPrimary
            } else if (answered) {
              tagColor = token.colorSuccess
            } else {
              tagColor = token.colorFillSecondary
              borderStyle = { border: `1px solid ${token.colorBorder}`, color: token.colorTextSecondary }
            }
            return (
              <Tag
                key={q.id}
                color={tagColor}
                style={{ cursor: 'pointer', padding: '2px 10px', fontSize: 14, minWidth: 32, textAlign: 'center', ...borderStyle }}
                onClick={() => setCurrentIndex(idx)}
              >
                {idx + 1}
                {answered && <CheckCircleOutlined style={{ marginLeft: 2, fontSize: 11 }} />}
              </Tag>
            )
          })}
        </div>

        {/* ── 当前题目 ── */}
        {currentQuestion && renderQuestion(currentQuestion, currentIndex)}

        {/* ── 翻页按钮 ── */}
        <Row justify="space-between" style={{ marginTop: 16 }}>
          <Col>
            <Button disabled={currentIndex === 0}
              onClick={() => setCurrentIndex((i) => i - 1)}
              icon={<ArrowLeftOutlined />}>
              {t('prevQ')}
            </Button>
          </Col>
          <Col>
            <Button disabled={currentIndex >= questions.length - 1}
              type="primary"
              onClick={() => setCurrentIndex((i) => i + 1)}>
              {t('nextQ')} <ArrowRightOutlined />
            </Button>
          </Col>
        </Row>
      </div>
    </Layout>
  )
}

export default ExamTakePage
