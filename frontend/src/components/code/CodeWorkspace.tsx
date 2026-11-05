import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Typography, Button, Space, Tag, Modal, Spin, message, Tabs, Empty,
  Table, Progress, Descriptions, Divider, Input, Alert, Statistic, Row, Col,
  Grid, Tooltip,
} from 'antd'
import {
  PlayCircleOutlined, SendOutlined, RobotOutlined, HistoryOutlined,
  ArrowLeftOutlined, MinusSquareOutlined,
  DiffOutlined, UploadOutlined,
} from '@ant-design/icons'
import apiClient from '../../api/client'
import CodeEditor from '../CodeEditor'
import FormulaRenderer from '../FormulaRenderer'
import { RowList, RowItem } from '../RowList'
import { useAuthStore } from '../../stores/authStore'
import { pollAiTask } from '../../api/aiTask'
import { reportLoadError } from '../../utils/loadError'
import { STATUS_MAP, isTerminalStatus, isSuccessStatus } from './constants'

const { Title, Text } = Typography
const { TextArea } = Input

export type CodeWorkspaceVariant = 'inline' | 'full'

interface CodeWorkspaceProps {
  problemId: number
  variant?: CodeWorkspaceVariant
  onBack?: () => void
  onSubmitted?: () => void
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const normalizeText = (text: string) =>
  (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()

type DiffLine = { type: 'same' | 'del' | 'add'; text: string }

/** 行级 LCS diff；行数过多时退化为「先给期望、再给实际」，避免前端卡死。 */
function buildLineDiff(expected: string, actual: string): DiffLine[] {
  const a = normalizeText(expected).split('\n')
  const b = normalizeText(actual).split('\n')
  if (a.length * b.length > 250000) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ]
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const out: DiffLine[] = []
  let i = a.length
  let j = b.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.push({ type: 'same', text: a[i - 1] })
      i -= 1
      j -= 1
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.push({ type: 'add', text: b[j - 1] })
      j -= 1
    } else {
      out.push({ type: 'del', text: a[i - 1] })
      i -= 1
    }
  }
  return out.reverse()
}

export const DiffBlock: React.FC<{ expected: string; actual: string; error?: string }> = ({
  expected, actual, error,
}) => {
  const { t } = useTranslation('practice')
  const lines = useMemo(() => buildLineDiff(expected, actual), [expected, actual])
  if (error) {
    return <Alert type="error" showIcon title={t('runFailed')} description={error} />
  }
  const hasDiff = lines.some((l) => l.type !== 'same')
  if (!hasDiff) {
    return <Alert type="success" showIcon title={t('samplePass')} description={t('outputMatched')} />
  }
  return (
    <div
      style={{
        background: 'var(--code-console-bg, #1e1e1e)',
        color: 'var(--code-console-fg, #d4d4d4)',
        borderRadius: 6,
        padding: '8px 10px',
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: 12,
        maxHeight: 280,
        overflow: 'auto',
      }}
    >
      <div style={{ color: 'var(--text-tertiary)', marginBottom: 4 }}>{t('compareHint')}</div>
      {lines.map((line, idx) => (
        <div
          key={`${idx}-${line.type}`}
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            padding: '0 4px',
            background: line.type === 'add'
              ? 'var(--code-diff-add-bg, rgba(82,196,26,.18))'
              : line.type === 'del'
                ? 'var(--code-diff-del-bg, rgba(255,77,79,.18))'
                : 'transparent',
            color: line.type === 'add' ? '#95de64' : line.type === 'del' ? '#ff9c9c' : undefined,
          }}
        >
          <span style={{ opacity: 0.55, userSelect: 'none', marginRight: 6 }}>
            {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
          </span>
          {line.text || ' '}
        </div>
      ))}
    </div>
  )
}


const CodeWorkspace: React.FC<CodeWorkspaceProps> = ({
  problemId,
  variant = 'inline',
  onBack,
  onSubmitted,
}) => {
  const { t } = useTranslation('practice')
  const user = useAuthStore((s) => s.user)
  const screens = Grid.useBreakpoint()
  const narrow = !screens.md
  const isFull = variant === 'full'

  const [problem, setProblem] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [code, setCode] = useState('')
  const [customInput, setCustomInput] = useState('')
  const [runResult, setRunResult] = useState<any>(null)
  const [runHistory, setRunHistory] = useState<any[]>([])
  const [runLoading, setRunLoading] = useState(false)
  const [submitLoading, setSubmitLoading] = useState(false)
  const [submissionResult, setSubmissionResult] = useState<any>(null)
  const [polling, setPolling] = useState(false)
  const [submissions, setSubmissions] = useState<any[]>([])
  const [submissionsLoading, setSubmissionsLoading] = useState(false)
  const [aiReview, setAiReview] = useState<any>(null)
  const [aiReviewLoading, setAiReviewLoading] = useState(false)
  const [aiReviewError, setAiReviewError] = useState('')
  const [descCollapsed, setDescCollapsed] = useState(false)
  const [activeTab, setActiveTab] = useState('output')
  const [sampleResults, setSampleResults] = useState<Record<number, any>>({})
  const [draftSavedAt, setDraftSavedAt] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)

  const aliveRef = useRef(true)
  const pollSeqRef = useRef(0)
  const onSubmittedRef = useRef(onSubmitted)
  useEffect(() => { onSubmittedRef.current = onSubmitted }, [onSubmitted])

  const draftKey = user?.username ? `code_draft:${user.username}:${problemId}` : ''
  const initialCode = problem?.initial_code || problem?.starter_code || problem?.template_code || ''
  const maxScore = Number(submissionResult?.max_score || problem?.max_score || 0)

  useEffect(() => {
    let cancelled = false
    aliveRef.current = true
    pollSeqRef.current += 1
    setLoading(true)
    setProblem(null)
    setRunResult(null)
    setRunHistory([])
    setSubmissionResult(null)
    setSubmissions([])
    setAiReview(null)
    setAiReviewError('')
    setSampleResults({})
    setDraftSavedAt('')
    setHistoryOpen(false)
    setDescCollapsed(false)
    setActiveTab('output')

    apiClient.get(`/api/code/problems/${problemId}`)
      .then(({ data }) => {
        if (cancelled) return
        setProblem(data)
        setLoading(false)
        setCustomInput(data?.sample_cases?.[0]?.input || '')
        let draftCode = ''
        if (draftKey) {
          try {
            const raw = localStorage.getItem(draftKey)
            if (raw) {
              const parsed = JSON.parse(raw)
              if (parsed?.code) draftCode = String(parsed.code)
            }
          } catch { /* ignore */ }
        }
        const starter = data?.initial_code || data?.starter_code || data?.template_code || t('defaultCode')
        const bestCode = data?.best_submission?.source_code || ''
        if (draftCode && draftCode !== (bestCode || starter)) {
          setCode(draftCode)
          message.info(t('draftRestored'))
        } else if (bestCode) {
          setCode(bestCode)
        } else {
          setCode(starter)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoading(false)
          reportLoadError(err, { key: 'codePractice.problem' })
        }
      })
    return () => {
      cancelled = true
      aliveRef.current = false
      pollSeqRef.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemId, draftKey])

  // 草稿自动保存（800ms 防抖）
  useEffect(() => {
    if (!draftKey || !problem || !code) return
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ code, updatedAt: Date.now() }))
        setDraftSavedAt(new Date().toLocaleTimeString())
      } catch { /* 隐私模式/配额满：静默失败，不影响答题 */ }
    }, 800)
    return () => clearTimeout(timer)
  }, [code, draftKey, problem])

  const loadSubmissions = async () => {
    setSubmissionsLoading(true)
    try {
      const { data } = await apiClient.get(`/api/code/my-submissions/${problemId}`)
      if (aliveRef.current) setSubmissions(data.submissions || [])
    } catch { /* silent */ } finally {
      if (aliveRef.current) setSubmissionsLoading(false)
    }
  }

  useEffect(() => {
    if (problem) loadSubmissions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem])

  const handleReset = () => {
    Modal.confirm({
      title: t('resetCodeConfirm'),
      content: t('resetCodeContent'),
      okText: t('confirmReset'),
      cancelText: t('cancel'),
      onOk: () => {
        setCode(initialCode)
        try { if (draftKey) localStorage.removeItem(draftKey) } catch { /* ignore */ }
        setDraftSavedAt('')
        message.success(t('resetCodeDone'))
      },
    })
  }

  const handleRun = async (input: string = customInput, sample?: any) => {
    if (!problem) return
    if (!code.trim()) { message.warning(t('writeCode')); return }
    setRunLoading(true)
    setRunResult(null)
    try {
      const { data } = await apiClient.post('/api/code/run', {
        problem_id: problemId,
        language: problem.language || 'python',
        source_code: code,
        input_data: input,
      }, { timeout: 70000 })
      if (!aliveRef.current) return
      setRunResult(data)
      setActiveTab('output')
      setRunHistory((prev) => {
        const entry = {
          id: Date.now(), ...data, input_data: input,
          createdAt: new Date().toLocaleTimeString(),
        }
        return [entry, ...prev].slice(0, 10)
      })
      if (sample) {
        const pass = !data.error && normalizeText(data.stdout) === normalizeText(sample.expected_output)
        setSampleResults((prev) => ({
          ...prev,
          [sample.id]: {
            status: data.error ? 'error' : pass ? 'pass' : 'fail',
            actual: data.stdout || '',
            expected: sample.expected_output || '',
            error: data.error || data.stderr || '',
            at: Date.now(),
          },
        }))
        if (pass) message.success(t('samplePass'))
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('runFailed'))
    } finally {
      if (aliveRef.current) setRunLoading(false)
    }
  }

  const pollSubmission = async (submissionId: number) => {
    const token = ++pollSeqRef.current
    const start = Date.now()
    while (aliveRef.current && pollSeqRef.current === token && Date.now() - start < 180000) {
      try {
        const { data } = await apiClient.get(`/api/code/submissions/${submissionId}`)
        if (isTerminalStatus(data.status)) {
          if (!aliveRef.current || pollSeqRef.current !== token) return
          setSubmissionResult(data)
          setPolling(false)
          setActiveTab('result')
          setAiReview(null)
          setAiReviewError('')
          loadSubmissions()
          onSubmittedRef.current?.()
          return
        }
      } catch { /* transient */ }
      await sleep(1200)
    }
    if (aliveRef.current && pollSeqRef.current === token) {
      setPolling(false)
      message.warning(t('gradingTimeoutRefresh'))
    }
  }

  const handleSubmit = async () => {
    if (!problem) return
    if (!code.trim()) { message.warning(t('writeCode')); return }
    if (polling) return
    setSubmitLoading(true)
    setSubmissionResult(null)
    setAiReview(null)
    setAiReviewError('')
    try {
      const { data } = await apiClient.post('/api/code/submit', {
        problem_id: problemId,
        language: problem.language || 'python',
        source_code: code,
      })
      message.success(t('submitSuccessGrading'))
      setPolling(true)
      setActiveTab('result')
      pollSubmission(data.submission_id)
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('submitFailed'))
    } finally {
      setSubmitLoading(false)
    }
  }

  const fetchReview = async (submissionId: number) => {
    try {
      const { data } = await apiClient.get(`/api/code/submissions/${submissionId}/review`)
      if (data.status === 'completed' && data.review) {
        setAiReview(data.review)
        setAiReviewError('')
        return true
      }
      if (data.status === 'failed') {
        setAiReviewError(data.error || t('aiReviewFailed'))
        return true
      }
    } catch { /* ignore */ }
    return false
  }

  const handleAiReview = async () => {
    if (!submissionResult?.id) { message.warning(t('submitAndWaitForGrading')); return }
    if (polling) { message.info(t('grading')); return }
    setAiReviewLoading(true)
    setAiReview(null)
    setAiReviewError('')
    try {
      const { data } = await apiClient.post(`/api/code/submissions/${submissionResult.id}/review`)
      if (data.task_id) {
        message.info(t('aiReviewSubmitted'))
        const result = await pollAiTask(data.task_id, 180000)
        if (result && !result.error) {
          setAiReview(result)
          setActiveTab('review')
        } else {
          // AI 任务返回异常时，数据库里的审查可能还在跑：再给它 60 秒
          let done = false
          for (let i = 0; i < 30 && aliveRef.current; i += 1) {
            done = await fetchReview(submissionResult.id)
            if (done) break
            await sleep(2000)
          }
          if (done) setActiveTab('review')
        }
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('aiReviewRequestFailed'))
    } finally {
      if (aliveRef.current) setAiReviewLoading(false)
    }
  }

  const openSubmission = async (submissionId: number) => {
    // 切看历史提交时取消当前轮询，避免旧判题结果稍后把新内容覆盖掉
    pollSeqRef.current += 1
    setPolling(false)
    try {
      const { data } = await apiClient.get(`/api/code/submissions/${submissionId}`)
      if (!aliveRef.current) return
      setSubmissionResult(data)
      setRunResult(null)
      setAiReview(null)
      setAiReviewError('')
      setActiveTab('result')
      await fetchReview(submissionId)
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('loadFailed'))
    }
  }

  const loadCodeFromSubmission = async (submissionId: number) => {
    try {
      const { data } = await apiClient.get(`/api/code/submissions/${submissionId}`)
      if (data?.source_code) {
        setCode(data.source_code)
        message.success(t('codeLoaded'))
      }
    } catch {
      message.error(t('loadFailed'))
    }
  }


  const renderSamples = () => {
    const samples = problem?.sample_cases || []
    if (!samples.length) return null
    return (
      <div style={{ marginTop: 8 }}>
        <Text strong style={{ fontSize: 13 }}>{t('sampleCases')}</Text>
        {samples.map((sc: any, idx: number) => {
          const sr = sampleResults[sc.id]
          return (
            <Card key={sc.id ?? idx} size="small" style={{ marginTop: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Space size={4}>
                  <Text strong style={{ fontSize: 12 }}>{t('example')} {idx + 1}</Text>
                  {sr && (
                    <Tag color={sr.status === 'pass' ? 'success' : sr.status === 'fail' ? 'error' : 'warning'}>
                      {sr.status === 'pass' ? t('samplePass') : sr.status === 'fail' ? t('sampleFail') : t('statusRuntimeError')}
                    </Tag>
                  )}
                </Space>
                <Space size={4}>
                  <Button size="small" onClick={() => { setCustomInput(sc.input || ''); message.success(t('sampleFilled')) }}>
                    {t('fillSample')}
                  </Button>
                  <Button size="small" type="primary" ghost icon={<PlayCircleOutlined />}
                    loading={runLoading} onClick={() => handleRun(sc.input || '', sc)}>
                    {t('runSample')}
                  </Button>
                </Space>
              </div>
              {sc.description && <Text type="secondary" style={{ fontSize: 12 }}>{sc.description}</Text>}
              <pre style={{
                margin: '6px 0 0', background: 'var(--bg-layout)', padding: 8, borderRadius: 4,
                fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>
                <Text strong>{t('input')}：</Text>{sc.input || t('cpNone')}{'\n'}
                <Text strong>{t('output')}：</Text>{sc.expected_output || t('cpNone')}
              </pre>
              {sr && (
                <div style={{ marginTop: 6 }}>
                  <DiffBlock expected={sc.expected_output || ''} actual={sr.actual} error={sr.error} />
                </div>
              )}
            </Card>
          )
        })}
      </div>
    )
  }

  const renderHistory = () => (
    <div style={{ marginTop: 4 }}>
      <Spin spinning={submissionsLoading}>
        {submissions.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>{t('noHistory')}</Text>
        ) : (
          <RowList
            items={submissions}
            renderItem={(s: any) => {
              const st = STATUS_MAP[s.status]
              return (
                <RowItem
                  dense
                  style={{ cursor: 'pointer', width: '100%', paddingInline: 0 }}
                  onClick={() => openSubmission(s.id)}
                  title={(
                    <Space size={4} wrap>
                      <Tag color={st?.color}>{st?.icon} {t(st?.labelKey ?? '') || s.status}</Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {s.score ?? 0}/{s.max_score || problem?.max_score || 0}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>{s.created_at?.slice(5, 16)}</Text>
                      {s.is_best ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>{t('bestSubmission')}</Tag> : null}
                      {s.ai_review_status === 'completed' ? <Tag color="purple" style={{ marginInlineEnd: 0 }}>AI</Tag> : null}
                    </Space>
                  )}
                  actions={[
                    <Tooltip key="load" title={t('loadCode')}>
                      <Button
                        type="text" size="small" icon={<UploadOutlined />}
                        onClick={(e) => { e.stopPropagation(); loadCodeFromSubmission(s.id) }}
                      />
                    </Tooltip>,
                  ]}
                />
              )
            }}
          />
        )}
      </Spin>
    </div>
  )

  const renderOutput = () => (
    <div>
      {runResult ? (
        <div style={{
          background: 'var(--code-console-bg, #1e1e1e)',
          color: 'var(--code-console-fg, #d4d4d4)',
          padding: 12, borderRadius: 6, fontFamily: 'Consolas, "Courier New", monospace',
          fontSize: 13, maxHeight: 240, overflow: 'auto',
        }}>
          {runResult.error ? (
            <div style={{ color: '#ff9c9c' }}>
              <div>{runResult.error_kind === 'compile' ? t('statusCompileError') : t('errorPrefix')}{runResult.error}</div>
              {runResult.stderr && <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{runResult.stderr}</pre>}
            </div>
          ) : (
            <>
              <div style={{ color: 'var(--text-tertiary)', marginBottom: 4 }}>
                Exit {runResult.exit_code} | {runResult.execution_time}s
                {runResult.time_limit ? ` | ${t('timeLimitLabel')}: ${runResult.time_limit}s` : ''}
                {runResult.stdout_truncated ? ` | ${t('outputTruncated')}` : ''}
              </div>
              {runResult.stdout ? (
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{runResult.stdout}</pre>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>{t('noOutput')}</span>
              )}
              {runResult.stderr && <pre style={{ margin: '8px 0 0', color: '#ff9c9c', whiteSpace: 'pre-wrap' }}>{runResult.stderr}</pre>}
            </>
          )}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('runFirstHint')} />
      )}
      {runHistory.length > 1 && (
        <details style={{ marginTop: 8, fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-tertiary)', userSelect: 'none' }}>
            {t('runHistory')}（{runHistory.length} {t('countRuns')}）
          </summary>
          <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 4 }}>
            {runHistory.map((entry, idx) => (
              <div key={entry.id} style={{
                background: 'var(--code-console-bg, #1e1e1e)', color: 'var(--code-console-fg, #d4d4d4)',
                padding: '6px 10px', borderRadius: 4, marginBottom: 4,
                fontFamily: 'Consolas, "Courier New", monospace', fontSize: 12,
                borderLeft: `3px solid ${entry.exit_code === 0 ? 'var(--success-color)' : 'var(--error-color)'}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ color: 'var(--text-tertiary)' }}>#{runHistory.length - idx} {entry.createdAt}</span>
                  <span>Exit {entry.exit_code} | {entry.execution_time}s</span>
                </div>
                {entry.input_data && <div style={{ color: '#69b1ff' }}>↳ {t('input')}: {entry.input_data}</div>}
                <pre style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', maxHeight: 70, overflow: 'hidden' }}>
                  {entry.stdout || (entry.error ? entry.error.slice(0, 120) : `(${t('noOutput')})`)}
                </pre>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )

  const renderResult = () => {
    if (!submissionResult) {
      return (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin spinning={polling} tip={t('grading')} />
          {!polling && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('submitFirstHint')} />}
        </div>
      )
    }
    const st = STATUS_MAP[submissionResult.status]
    const details = submissionResult.details || []
    return (
      <div>
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={12} sm={6}>
            <Statistic
              title={t('status')}
              value={st ? t(st.labelKey) || submissionResult.status : submissionResult.status}
              styles={{ content: { fontSize: 15, color: isSuccessStatus(submissionResult.status) ? 'var(--success-color)' : 'var(--error-color)' } }}
            />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title={t('cpScore')} value={`${submissionResult.score ?? 0} / ${maxScore}`} styles={{ content: { fontSize: 15 } }} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title={t('cpPassedCases')} value={`${submissionResult.passed_cases || 0} / ${submissionResult.total_cases || 0}`} styles={{ content: { fontSize: 15 } }} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title={t('cpRuntime')} value={submissionResult.execution_time || 0} suffix="s" styles={{ content: { fontSize: 15 } }} />
          </Col>
        </Row>

        {submissionResult.error_message && (
          <Alert
            style={{ marginBottom: 8 }}
            type={submissionResult.status === 'compile_error' ? 'warning' : 'error'}
            showIcon
            title={submissionResult.error_message}
          />
        )}

        {details.length > 0 && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <Text strong style={{ fontSize: 13 }}>{t('testCaseDetail')}</Text>
              {submissionResult.source_code && (
                <Button size="small" type="link" icon={<UploadOutlined />}
                  onClick={() => { setCode(submissionResult.source_code); message.success(t('codeLoaded')) }}>
                  {t('loadThisCode')}
                </Button>
              )}
            </div>
            <Table
              size="small"
              dataSource={details}
              rowKey={(r: any) => String(r.case_id ?? r.case_index)}
              pagination={false}
              scroll={{ x: narrow ? 520 : undefined }}
              expandable={{
                rowExpandable: (r: any) => !r.is_pass,
                expandedRowRender: (r: any) => (
                  <DiffBlock expected={r.expected || ''} actual={r.actual || ''} error={r.error || ''} />
                ),
              }}
              columns={[
                {
                  title: t('cpColCase'), dataIndex: 'description',
                  render: (v: string, r: any) => v || `${t('cpCasePrefix')} #${(r.case_index ?? 0) + 1}`,
                },
                {
                  title: t('testResult'), dataIndex: 'is_pass', width: 90,
                  render: (v: boolean, r: any) => (
                    <Tag color={v ? 'success' : (r.error ? 'warning' : 'error')}>
                      {v ? t('passed') : (r.error ? t('statusRuntimeError') : t('failed'))}
                    </Tag>
                  ),
                },
                { title: t('score'), dataIndex: 'score', width: 70, render: (v: number) => v ?? 0 },
                { title: t('runTime'), dataIndex: 'execution_time', width: 80, render: (v: number) => v ? `${v}s` : '-' },
              ]}
            />
          </>
        )}
      </div>
    )
  }

  const renderReview = () => {
    if (aiReviewLoading) return <div style={{ padding: 24, textAlign: 'center' }}><Spin tip={t('aiAnalyzing')} /></div>
    if (aiReviewError) return <Alert type="error" showIcon title={t('aiReviewFailed')} description={aiReviewError} />
    if (!aiReview) {
      return (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('aiReviewEmpty')}>
          <Button type="primary" icon={<RobotOutlined />} onClick={handleAiReview} loading={aiReviewLoading}>
            {t('aiReview')}
          </Button>
        </Empty>
      )
    }
    return (
      <div>
        <Row gutter={16} style={{ marginBottom: 12 }}>
          <Col xs={12} sm={6}>
            <Statistic title={t('cpOverallScore')} value={aiReview.overall_score} suffix="/100" styles={{ content: { fontSize: 16 } }} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title={t('cpRating')} value={aiReview.overall_rating} styles={{ content: { fontSize: 16 } }} />
          </Col>
        </Row>

        <Descriptions column={narrow ? 1 : 2} size="small" bordered style={{ marginBottom: 12 }}>
          {aiReview.dimensions?.correctness && (
            <Descriptions.Item label={t('cpDimCorrect')}>
              <Progress percent={Number(aiReview.dimensions.correctness.score) || 0} size="small" />
            </Descriptions.Item>
          )}
          {aiReview.dimensions?.code_quality && (
            <Descriptions.Item label={t('cpDimQuality')}>
              <Progress percent={Number(aiReview.dimensions.code_quality.score) || 0} size="small" />
            </Descriptions.Item>
          )}
          {aiReview.dimensions?.efficiency && (
            <Descriptions.Item label={t('cpDimEfficiency')}>
              <Progress percent={Number(aiReview.dimensions.efficiency.score) || 0} size="small" />
            </Descriptions.Item>
          )}
          {aiReview.dimensions?.style && (
            <Descriptions.Item label={t('cpDimStyle')}>
              <Progress percent={Number(aiReview.dimensions.style.score) || 0} size="small" />
            </Descriptions.Item>
          )}
        </Descriptions>

        {aiReview.strengths?.length > 0 && (
          <>
            <Text strong style={{ color: 'var(--success-color)' }}>{t('strengths')}</Text>
            <ul style={{ margin: '4px 0 12px' }}>
              {aiReview.strengths.map((s: string, i: number) => <li key={i}><Text>{s}</Text></li>)}
            </ul>
          </>
        )}
        {aiReview.weaknesses?.length > 0 && (
          <>
            <Text strong style={{ color: 'var(--error-color)' }}>{t('improvements')}</Text>
            <ul style={{ margin: '4px 0 12px' }}>
              {aiReview.weaknesses.map((w: string, i: number) => <li key={i}><Text>{w}</Text></li>)}
            </ul>
          </>
        )}
        {aiReview.suggestions?.length > 0 && (
          <>
            <Text strong style={{ color: 'var(--primary-color)' }}>{t('suggestions')}</Text>
            <ul style={{ margin: '4px 0 12px' }}>
              {aiReview.suggestions.map((s: string, i: number) => <li key={i}><Text>{s}</Text></li>)}
            </ul>
          </>
        )}
        {aiReview.improved_code && (
          <>
            <Divider>{t('reference')}</Divider>
            <pre style={{ background: 'var(--bg-layout)', padding: 12, borderRadius: 6, fontSize: 13, overflow: 'auto' }}>
              <code>{aiReview.improved_code}</code>
            </pre>
          </>
        )}
      </div>
    )
  }


  const tabsItems: any[] = []
  if (runResult || runHistory.length) {
    tabsItems.push({
      key: 'output',
      label: <span><PlayCircleOutlined />{t('runOutput')}</span>,
      children: renderOutput(),
    })
  }
  if (submissionResult || polling) {
    tabsItems.push({
      key: 'result',
      label: <span><DiffOutlined />{t('scoreResult')}</span>,
      children: renderResult(),
    })
  }
  if (aiReview || aiReviewError || aiReviewLoading) {
    tabsItems.push({
      key: 'review',
      label: <span><RobotOutlined />{t('aiReview')}</span>,
      children: renderReview(),
    })
  }
  const effectiveTab = tabsItems.some((item) => item.key === activeTab)
    ? activeTab
    : (tabsItems[0]?.key || '')

  if (loading) {
    return <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>
  }
  if (!problem) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('loadFailed')} />
  }

  const difficultyLabel = problem.difficulty === 'easy' ? t('easy')
    : problem.difficulty === 'hard' ? t('hard') : t('medium')
  const difficultyColor = problem.difficulty === 'easy' ? 'green'
    : problem.difficulty === 'hard' ? 'red' : 'orange'

  const leftPanel = (
    <div
      style={{
        // 用 flex-basis 而不是 width+flexShrink:0：外层宽度由容器决定时，百分比
        // width 在"宽度待定"的父级里会退化成内容宽度，长知识点能把面板顶到几屏宽。
        // 折叠后必须收成窄条：留给它的 35% 宽度会变成一大块空白，编辑器只能挤在右边。
        flex: narrow ? '1 1 100%' : descCollapsed ? '0 0 44px' : `0 0 ${isFull ? 38 : 35}%`,
        width: narrow ? '100%' : undefined,
        minWidth: narrow || descCollapsed ? 0 : 260,
        maxWidth: narrow ? '100%' : undefined,
        boxSizing: 'border-box',
        height: isFull && !narrow ? '100%' : 'auto',
        maxHeight: isFull && !narrow ? '100%' : (narrow ? 320 : 520),
        overflow: 'auto',
        overflowWrap: 'anywhere',
        background: 'var(--bg-layout)',
        borderRadius: 8,
        padding: descCollapsed ? '8px 6px' : 12,
        border: '1px solid var(--border-color)',
        cursor: descCollapsed ? 'pointer' : 'default',
        transition: 'flex-basis .2s, padding .2s',
      }}
      onClick={() => { if (descCollapsed) setDescCollapsed(false) }}
    >
      {descCollapsed ? (
        <div style={{ writingMode: 'vertical-rl', fontSize: 13, color: 'var(--text-tertiary)', userSelect: 'none' }}>
          <span
            onClick={(e) => { e.stopPropagation(); setDescCollapsed(false) }}
            style={{ cursor: 'pointer', color: 'var(--primary-color)' }}
          >
            📄 {t('problemTitle')}
          </span>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <Space wrap size={6}>
              {isFull && onBack && (
                <Button size="small" icon={<ArrowLeftOutlined />} onClick={onBack}>{t('backToList')}</Button>
              )}
              <Title level={5} style={{ margin: 0 }}>{problem.title}</Title>
              <Tag color={difficultyColor}>{difficultyLabel}</Tag>
              <Tag>{(problem.language || 'python').toUpperCase()}</Tag>
              <Tag color="blue">{t('maxScore')} {problem.max_score ?? 0}</Tag>
              {problem.status === 'paused' && <Tag color="default">{t('statusPaused')}</Tag>}
            </Space>
            {!isFull && (
              <Button type="text" size="small" icon={<MinusSquareOutlined />}
                onClick={() => setDescCollapsed(true)} style={{ color: 'var(--text-tertiary)' }} />
            )}
          </div>

          {(problem.subject || problem.knowledge_points) && (
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>
              {problem.subject ? `${t('subject')}: ${problem.subject}` : ''}
              {problem.subject && problem.knowledge_points ? ' · ' : ''}
              {problem.knowledge_points ? `${t('knowledgePoints')}: ${problem.knowledge_points}` : ''}
            </div>
          )}

          <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
            <FormulaRenderer content={problem.description || ''} />
          </div>

          {renderSamples()}

          <Divider style={{ margin: '12px 0 6px' }}>
            <Space size={4}><HistoryOutlined /><Text strong style={{ fontSize: 13 }}>{t('submissionHistory')}</Text></Space>
          </Divider>
          {isFull ? renderHistory() : (
            <details onToggle={(e) => setHistoryOpen((e.currentTarget as HTMLDetailsElement).open)}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 12 }}>
                {t('viewSubmissionHistory')}（{submissions.length}）
              </summary>
              <div style={{ marginTop: 6 }}>{historyOpen ? renderHistory() : null}</div>
            </details>
          )}
        </>
      )}
    </div>
  )

  const rightPanel = (
    <div style={{ flex: 1, minWidth: 0, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 8, height: isFull && !narrow ? '100%' : 'auto', overflow: isFull && !narrow ? 'auto' : 'visible', paddingRight: isFull && !narrow ? 4 : 0 }}>
      <CodeEditor
        language={problem.language || 'python'}
        value={code}
        onChange={setCode}
        showLanguageSelector={false}
        height={narrow ? 280 : isFull ? 250 : 240}
        onRun={() => handleRun()}
        onReset={handleReset}
        runDisabled={runLoading}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => handleRun()} loading={runLoading}>
          {t('runCode')}
        </Button>
        <Button type="primary" ghost icon={<SendOutlined />} onClick={handleSubmit} loading={submitLoading || polling}>
          {polling ? t('grading') : t('submitCode')}
        </Button>
        <Button icon={<RobotOutlined />} onClick={handleAiReview} loading={aiReviewLoading}
          disabled={!submissionResult || polling}>
          {t('aiReview')}
        </Button>
        <div style={{ flex: 1 }} />
        {draftSavedAt && (
          <Text type="secondary" style={{ fontSize: 11 }}>{t('draftSavedAt', { time: draftSavedAt })}</Text>
        )}
        <Tag color="default">{t('timeLimitLabel')} {problem.time_limit || 5}s</Tag>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('stdinLabel')}</Text>
          {problem.sample_cases?.[0]?.input ? (
            <Button type="link" size="small"
              onClick={() => setCustomInput(problem.sample_cases[0].input || '')}>
              {t('fillSampleOne')}
            </Button>
          ) : null}
        </div>
        <TextArea
          rows={isFull && !narrow ? 2 : 3}
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          placeholder={t('cpStdinPh')}
          style={{ fontSize: 12, marginTop: 4, fontFamily: 'Consolas, "Courier New", monospace' }}
        />
      </div>

      {tabsItems.length > 0 && (
        <div>
          <Tabs
            size="small"
            activeKey={effectiveTab}
            onChange={setActiveTab}
            items={tabsItems}
          />
        </div>
      )}
    </div>
  )

  return (
    <div style={{
      display: 'flex',
      flexDirection: narrow ? 'column' : 'row',
      gap: 12,
      alignItems: 'stretch',
      width: '100%',
      maxWidth: '100%',
      minWidth: 0,
      boxSizing: 'border-box',
      height: isFull && !narrow ? '100%' : 'auto',
    }}>
      {leftPanel}
      {rightPanel}
    </div>
  )
}

export default CodeWorkspace
