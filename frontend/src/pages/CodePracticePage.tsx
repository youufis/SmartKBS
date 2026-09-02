import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, List, Typography, Button, Space, Tag, Modal, Spin,
  message, Tabs, Empty, Select, Statistic, Row, Col,
  Table, Progress, Descriptions, Divider, Input, Alert, InputNumber,
  Pagination,
} from 'antd'
import {
  PlayCircleOutlined, SendOutlined, RobotOutlined,
  HistoryOutlined, CheckCircleOutlined, CloseCircleOutlined,
  ClockCircleOutlined, FileTextOutlined,
  BarChartOutlined, ArrowLeftOutlined,
  EditOutlined, DeleteOutlined,
  PlusSquareOutlined, MinusSquareOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import CodeEditor from '../components/CodeEditor'
import ActivityScopeSelector from '../components/ActivityScopeSelector'

const { Title, Text } = Typography
const { TextArea } = Input

// ── 状态标签映射 ──
const STATUS_MAP: Record<string, { labelKey: string; color: string; icon: React.ReactNode }> = {
  pending:        { labelKey: 'statusPending',   color: 'default',   icon: <ClockCircleOutlined /> },
  running:        { labelKey: 'statusRunning',   color: 'processing', icon: <Spin size="small" /> },
  accepted:       { labelKey: 'statusAccepted',   color: 'success',   icon: <CheckCircleOutlined /> },
  wrong_answer:   { labelKey: 'statusWrongAnswer', color: 'error',     icon: <CloseCircleOutlined /> },
  runtime_error:  { labelKey: 'statusRuntimeError', color: 'error',   icon: <CloseCircleOutlined /> },
  time_limit:     { labelKey: 'statusTimeLimit',   color: 'warning',   icon: <ClockCircleOutlined /> },
  compile_error:  { labelKey: 'statusCompileError', color: 'error',    icon: <CloseCircleOutlined /> },
  failed:         { labelKey: 'statusFailed', color: 'default',    icon: <CloseCircleOutlined /> },
}

// ── 紧凑型代码练习视图（用于表格展开行） ──
const CompactCodeView: React.FC<{
  problemId: number
  starterCode?: string
  language?: string
  supportedLanguages?: { value: string; label: string; available: boolean }[]
}> = ({ problemId, starterCode, language: initLang = 'python', supportedLanguages }) => {
  const { t } = useTranslation('practice')
  const [code, setCode] = useState(starterCode || t('defaultCode'))
  const [lang, setLang] = useState(initLang)
  const [customInput, setCustomInput] = useState('')
  const [runResult, setRunResult] = useState<any>(null)
  const [runHistory, setRunHistory] = useState<any[]>([])
  const [runLoading, setRunLoading] = useState(false)
  const [submitLoading, setSubmitLoading] = useState(false)
  const [submissionResult, setSubmissionResult] = useState<any>(null)
  const [pollingSubmission, setPollingSubmission] = useState(false)
  const [problemData, setProblemData] = useState<any>(null)
  const [descCollapsed, setDescCollapsed] = useState(false)

  // 加载题目信息（描述 + 样例输入）
  useEffect(() => {
    apiClient.get(`/api/code/problems/${problemId}`).then(({ data }) => {
      setProblemData(data)
      if (data?.sample_cases?.length > 0 && data.sample_cases[0].input) {
        setCustomInput(data.sample_cases[0].input)
      }
      if (data?.starter_code) setCode(data.starter_code)
    }).catch(() => {})
  }, [problemId])

  const handleRun = async () => {
    if (!code.trim()) { message.warning(t('writeCode')); return }
    setRunLoading(true)
    setRunResult(null)
    try {
      const { data } = await apiClient.post('/api/code/run', {
        problem_id: problemId, language: lang, source_code: code, input_data: customInput,
      })
      setRunResult(data)
      // 累积运行历史（保留最近 10 条）
      setRunHistory(prev => {
        const entry = { id: Date.now(), ...data, input_data: customInput, createdAt: new Date().toLocaleTimeString() }
        return [entry, ...prev].slice(0, 10)
      })
    } catch (e: any) { message.error(e.response?.data?.detail || t('runFailed')) }
    finally { setRunLoading(false) }
  }

  const handleSubmit = async () => {
    if (!code.trim()) { message.warning(t('writeCode')); return }
    setSubmitLoading(true)
    setSubmissionResult(null)
    try {
      const { data } = await apiClient.post('/api/code/submit', {
        problem_id: problemId, language: lang, source_code: code,
      })
      message.success(t('submitSuccessGrading'))
      setPollingSubmission(true)
      pollResult(data.submission_id)
    } catch (e: any) { message.error(e.response?.data?.detail || t('submitFailed')) }
    finally { setSubmitLoading(false) }
  }

  const pollResult = async (subId: number) => {
    const start = Date.now()
    while (Date.now() - start < 60000) {
      try {
        const { data } = await apiClient.get(`/api/code/submissions/${subId}`)
        if (['accepted','wrong_answer','runtime_error','time_limit','compile_error','failed'].includes(data.status)) {
          setSubmissionResult(data)
          setPollingSubmission(false)
          return
        }
      } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 1000))
    }
    setPollingSubmission(false)
    message.warning(t('gradingTimeout'))
  }

  return (
    <div style={{ display: 'flex', gap: 12 }}>
      {/* 左面板：题目描述（可折叠） */}
      {problemData && (
        <div style={{
          width: descCollapsed ? 36 : '35%',
          minWidth: descCollapsed ? 36 : 260,
          maxHeight: 400, overflow: 'auto',
          background: '#fafafa', borderRadius: 6,
          padding: descCollapsed ? '8px 4px' : 12,
          border: '1px solid #f0f0f0',
          cursor: descCollapsed ? 'pointer' : 'default',
          transition: 'width 0.2s, minWidth 0.2s, padding 0.2s',
          flexShrink: 0,
        }} onClick={() => { if (descCollapsed) setDescCollapsed(false) }}>
          {descCollapsed ? (
            <div style={{ writingMode: 'vertical-rl', fontSize: 13, color: '#888', userSelect: 'none' }}>
              <span onClick={(e) => { e.stopPropagation(); setDescCollapsed(false) }} style={{ cursor: 'pointer', color: '#1677ff' }}>📄 {t('problemTitle')}</span>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Text strong style={{ fontSize: 14 }}>{problemData.title}</Text>
                <Button type="text" size="small" icon={<MinusSquareOutlined />} onClick={() => setDescCollapsed(true)} style={{ color: '#999' }} />
              </div>
              <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6, color: '#555' }}>
                <ReactMarkdown>{problemData.description || ''}</ReactMarkdown>
              </div>
              {problemData.sample_cases?.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <Text strong style={{ fontSize: 12 }}>{t('example')}：</Text>
                  {problemData.sample_cases.map((sc: any, i: number) => (
                    <div key={sc.id || i} style={{ background: '#fff', padding: 6, borderRadius: 4, marginTop: 4, fontSize: 12, border: '1px solid #e8e8e8' }}>
                      <Text type="secondary">{t('explanation')} {i + 1}</Text>
                      {sc.description && <Text type="secondary"> — {sc.description}</Text>}
                      <pre style={{ margin: 2, fontSize: 11 }}>{t('input')}：{sc.input || t('cpNone')}{'\n'}{t('output')}：{sc.expected_output}</pre>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {/* 右面板：编辑器 + 工具栏 */}
      <div style={{ flex: 1 }}>
        <CodeEditor
          language={lang}
          value={code}
          onChange={setCode}
          showToolbar={false}
          height="280px"
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} loading={runLoading}>{t('runCode')}</Button>
          <Button size="small" type="primary" ghost icon={<SendOutlined />} onClick={handleSubmit} loading={submitLoading || pollingSubmission}>
            {pollingSubmission ? t('grading') : t('submitCode')}
          </Button>
          <Select size="small" value={lang} onChange={setLang} style={{ width: 100 }}
            options={supportedLanguages && supportedLanguages.length > 0
              ? supportedLanguages
              : [{ value: 'python', label: 'Python', available: true }, { value: 'javascript', label: 'JavaScript', available: true }]} />
          <Input size="small" placeholder={t('input')} value={customInput}
            onChange={e => setCustomInput(e.target.value)} style={{ width: 160, fontSize: 12 }} />
          {/* 结果与按钮同行显示 */}
          {submissionResult && (
            <span style={{ fontSize: 12, color: submissionResult.status === 'accepted' ? '#52c41a' : '#f48771' }}>
              {t(STATUS_MAP[submissionResult.status]?.labelKey ?? '') || submissionResult.status}
              {' | '}{submissionResult.score}{t('scoreUnit')} | {t('passed')} {submissionResult.passed_cases ?? 0}/{submissionResult.total_cases ?? 0} {t('testCaseUnit')}
            </span>
          )}
          {runResult && !submissionResult && (
            <span style={{ fontSize: 12, color: runResult.exit_code === 0 ? '#52c41a' : '#f48771' }}>
              Exit {runResult.exit_code} | {runResult.execution_time}s
            </span>
          )}
        </div>
        {/* 运行结果输出区域（完整显示 stdout/stderr） */}
        {runResult && !submissionResult && (
          <div style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 8, borderRadius: 4, marginTop: 6, fontFamily: 'monospace', fontSize: 12, maxHeight: 160, overflow: 'auto' }}>
            {runResult.error ? (
              <span style={{ color: '#f48771' }}>⚠ {runResult.error}</span>
            ) : (
              <>
                {runResult.stdout ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{runResult.stdout}</pre> : <span style={{ color: '#888' }}>{t('noOutput')}</span>}
                {runResult.stderr && <pre style={{ margin: 0, color: '#f48771', marginTop: 4 }}>{runResult.stderr}</pre>}
              </>
            )}
          </div>
        )}
        {/* 运行历史记录 */}
        {runHistory.length > 1 && !submissionResult && (
          <div style={{ marginTop: 6 }}>
            <details style={{ fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', color: '#888', userSelect: 'none' }}>
                {t('runHistory')}（{runHistory.length} {t('countRuns')}）
              </summary>
              <div style={{ maxHeight: 200, overflow: 'auto', marginTop: 4 }}>
                {runHistory.map((entry, idx) => (
                  <div key={entry.id} style={{
                    background: '#1e1e1e', color: '#d4d4d4', padding: '4px 8px',
                    borderRadius: 4, marginBottom: 4, fontFamily: 'monospace', fontSize: 11,
                    borderLeft: `3px solid ${entry.exit_code === 0 ? '#52c41a' : '#f48771'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ color: '#888' }}>#{runHistory.length - idx} {entry.createdAt}</span>
                      <span style={{ color: entry.exit_code === 0 ? '#52c41a' : '#f48771' }}>
                        Exit {entry.exit_code} | {entry.execution_time}s
                      </span>
                    </div>
                    {entry.input_data && <div style={{ color: '#69b1ff' }}>↳ {t('input')}: {entry.input_data}</div>}
                    <pre style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>
                      {entry.stdout || (entry.error ? entry.error.slice(0, 60) : `(${t('noOutput')})`)}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}

const CodePracticePage: React.FC = () => {
  const { t } = useTranslation('practice')
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  // ── 状态 ──
  const [problemList, setProblemList] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [currentProblem, setCurrentProblem] = useState<any>(null)

  const [sourceCode, setSourceCode] = useState('')
  const [language, setLanguage] = useState('python')

  // 运行结果
  const [runResult, setRunResult] = useState<any>(null)
  const [runHistory, setRunHistory] = useState<any[]>([])
  const [runLoading, setRunLoading] = useState(false)

  // 提交评分
  const [submitLoading, setSubmitLoading] = useState(false)
  const [submissionResult, setSubmissionResult] = useState<any>(null)
  const [pollingSubmission, setPollingSubmission] = useState(false)

  // 提交历史
  const [submissions, setSubmissions] = useState<any[]>([])
  const [submissionsLoading, setSubmissionsLoading] = useState(false)

  // AI 审查
  const [aiReview, setAiReview] = useState<any>(null)
  const [aiReviewLoading, setAiReviewLoading] = useState(false)

  // 自定义输入
  const [customInput, setCustomInput] = useState('')

  // 支持的語言
  const [supportedLangs, setSupportedLangs] = useState<{value:string;label:string;available:boolean}[]>([])

  // 科目列表（从系统配置动态加载）
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])

  // ── 展开控制（每次只展开一个题目） ──
  const [expandedRowKeys, setExpandedRowKeys] = useState<number[]>([])

  // ── 教师端：创建题目 ──
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)

  // ── 教师端：提交统计弹窗 ──
  const [statsModalOpen, setStatsModalOpen] = useState(false)
  const [statsProblemTitle, setStatsProblemTitle] = useState('')
  const [statsDetail, setStatsDetail] = useState<any[]>([])
  const [statsLoading, setStatsLoading] = useState(false)

  // 加载提交详情
  const loadStatsDetail = async (problemId: number, title: string) => {
    setStatsProblemTitle(title)
    setStatsLoading(true)
    setStatsDetail([])
    setStatsModalOpen(true)
    try {
      const { data } = await apiClient.get(`/api/code/problems/${problemId}/submissions/detail`)
      setStatsDetail(data.submissions || [])
    } catch {
      message.error(t('loadDetailFailed'))
    } finally {
      setStatsLoading(false)
    }
  }
  const [createForm, setCreateForm] = useState({
    title: '',
    description: '',
    subject: '',
    knowledge_points: '',
    difficulty: 'medium' as string,
    language: 'python',
    template_code: '# 在此编写你的代码\n\ndef solution():\n    pass\n',
    starter_code: '',
    time_limit: 5,
    test_cases: [] as any[],
    target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '',
  })
  const [newTestCase, setNewTestCase] = useState({ input: '', expected: '', description: '', score: 1, is_sample: false })

  // ── 教师端：编辑/删除题目 ──
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editLoading, setEditLoading] = useState(false)
  const [editTarget, setEditTarget] = useState<number | null>(null)
  const [editForm, setEditForm] = useState({
    title: '', description: '', subject: '', knowledge_points: '',
    difficulty: 'medium' as string, language: 'python' as string,
    template_code: '', starter_code: '', time_limit: 5,
  })
  const [editTestCases, setEditTestCases] = useState<any[]>([])

  // ═══════════════════════════════════════════════════════════
  // 所有 const 函数必须先声明，再在 useEffect 中调用
  // ═══════════════════════════════════════════════════════════

  // ── 创建题目 ──
  const handleCreateProblem = async () => {
    if (!createForm.title.trim()) {
      message.warning(t('inputTitle'))
      return
    }
    if (createForm.test_cases.length === 0) {
      message.warning(t('addAtLeastOneTestCase'))
      return
    }
    setCreateLoading(true)
    try {
      await apiClient.post('/api/code/problems', {
        ...createForm,
        test_cases: createForm.test_cases.map((tc) => ({
          input: tc.input,
          expected_output: tc.expected,
          description: tc.description,
          score: tc.score,
          is_sample: tc.is_sample,
        })),
        target_scope: createForm.target_scope || 'teacher_classes',
        target_grade: createForm.target_grade || '',
        target_class: createForm.target_class || '',
        target_users: createForm.target_users || '',
      })
      message.success(t('createSuccess'))
      setCreateModalOpen(false)
      setCreateForm({
        title: '', description: '', subject: '', knowledge_points: '',
        difficulty: 'medium', language: 'python',
        template_code: '# 在此编写你的代码\n\ndef solution():\n    pass\n',
        starter_code: '', time_limit: 5, test_cases: [],
        target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '',
      })
      loadProblems()
      apiClient.get('/api/code/teachers/statistics').then(() => {}).catch(() => {})
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('createFailed'))
    } finally {
      setCreateLoading(false)
    }
  }

  // ── 编辑题目（打开弹窗并加载数据） ──
  const handleEditProblem = async (problemId: number) => {
    setEditLoading(true)
    try {
      const { data } = await apiClient.get(`/api/code/problems/${problemId}`)
      setEditTarget(problemId)
      setEditForm({
        title: data.title || '',
        description: data.description || '',
        subject: data.subject || '',
        knowledge_points: data.knowledge_points || '',
        difficulty: data.difficulty || 'medium',
        language: data.language || 'python',
        template_code: data.template_code || data.starter_code || '',
        starter_code: data.starter_code || '',
        time_limit: data.time_limit || 5,
      })
      // 加载所有测试用例
      if (isTeacherOrAdmin) {
        try {
          const tcRes = await apiClient.get(`/api/code/problems/${problemId}/test-cases`)
          setEditTestCases((tcRes.data.test_cases || []).map((tc: any) => ({
            input: tc.input || '',
            expected: tc.expected_output || '',
            description: tc.description || '',
            score: tc.score || 1,
            is_sample: !!tc.is_sample,
          })))
        } catch { setEditTestCases([]) }
      }
      setEditModalOpen(true)
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('loadFailed'))
    } finally {
      setEditLoading(false)
    }
  }

  // ── 保存编辑 ──
  const handleSaveEdit = async () => {
    if (!editForm.title.trim()) { message.warning(t('inputTitle')); return }
    if (!editTarget) return
    setEditLoading(true)
    try {
      await apiClient.put(`/api/code/problems/${editTarget}`, {
        title: editForm.title,
        description: editForm.description,
        subject: editForm.subject,
        knowledge_points: editForm.knowledge_points,
        difficulty: editForm.difficulty,
        language: editForm.language,
        template_code: editForm.template_code,
        starter_code: editForm.starter_code,
        time_limit: editForm.time_limit,
      })
      message.success(t('updateSuccess'))
      setEditModalOpen(false)
      loadProblems()
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('updateFailed'))
    } finally {
      setEditLoading(false)
    }
  }

  // ── 删除题目 ──
  const handleDeleteProblem = (problemId: number) => {
    Modal.confirm({
      title: t('confirmDelete'),
      content: t('confirmDeleteContent'),
      okText: t('confirmDeleteOk'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        try {
          await apiClient.delete(`/api/code/problems/${problemId}`)
          message.success(t('deletedSuccess'))
          loadProblems()
          apiClient.get('/api/code/teachers/statistics').then(() => {}).catch(() => {})
        } catch (e: any) {
          message.error(e.response?.data?.detail || t('deleteFailed'))
        }
      },
    })
  }

  // ── AI 生成题目（教师端） ──
  const [aiGenModal, setAiGenModal] = useState(false)
  const [aiGenTopic, setAiGenTopic] = useState('')
  const [aiGenSubject, setAiGenSubject] = useState('')
  const [aiGenLoading, setAiGenLoading] = useState(false)
  const [aiGenResult, setAiGenResult] = useState<any>(null)
  const [, setAiGenTaskId] = useState<string | null>(null)

  const handleAiGenerate = async () => {
    if (!aiGenTopic.trim()) { message.warning(t('inputTopic')); return }
    setAiGenLoading(true)
    setAiGenResult(null)
    try {
      const { data } = await apiClient.post('/api/code/ai-generate', {
        topic: aiGenTopic, subject: aiGenSubject, language: 'python', difficulty: 'medium',
      })
      if (data.task_id) {
        setAiGenTaskId(data.task_id)
        message.info(t('aiGeneratingWait'))
        const result = await pollAiTask(data.task_id, 180000)
        if (result?.status === 'ok' && result.data) {
          setAiGenResult(result.data)
          // 自动填入表单
          const d = result.data
          setCreateForm(prev => ({
            ...prev,
            title: d.title || prev.title,
            description: d.description || prev.description,
            knowledge_points: d.knowledge_points || prev.knowledge_points,
            template_code: d.template_code || d.starter_code || prev.template_code,
            starter_code: d.starter_code || '',
            test_cases: (d.test_cases || []).map((tc: any) => ({
              input: tc.input || '',
              expected: tc.expected_output || '',
              description: tc.description || '',
              score: tc.score || 1,
              is_sample: !!tc.is_sample,
            })),
          }))
          message.success(t('aiGenerateDone'))
        } else {
          message.error(t('aiGenerateFailed'))
        }
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('aiGenerateRequestFailed'))
    } finally {
      setAiGenLoading(false)
    }
  }

  // ── 加载题目列表 ──
  const loadProblems = async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/code/problems', {
        params: { page, page_size: pageSize },
      })
      setProblemList(data.items || [])
      setTotal(data.total || 0)
    } catch {
      message.error(t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  // ── 加载提交历史 ──
  const loadSubmissions = async (problemId: number) => {
    setSubmissionsLoading(true)
    try {
      const { data } = await apiClient.get(`/api/code/my-submissions/${problemId}`)
      setSubmissions(data.submissions || [])
    } catch {
      // silent
    } finally {
      setSubmissionsLoading(false)
    }
  }

  // ── 加载题目详情 ──
  const loadProblem = async (problemId: number) => {
    setRunResult(null)
    setRunHistory([])
    setSubmissionResult(null)
    setAiReview(null)
    setSubmissions([])
    try {
      const { data } = await apiClient.get(`/api/code/problems/${problemId}`)
      setCurrentProblem(data)
      // 自动填充自定义输入：优先用第一个示例用例的输入
      if (data.sample_cases?.length > 0 && data.sample_cases[0].input) {
        setCustomInput(data.sample_cases[0].input)
      } else {
        setCustomInput('')
      }
      // 设置代码：优先用最佳提交，其次用模板/初始代码
      if (data.best_submission?.source_code) {
        setSourceCode(data.best_submission.source_code)
      } else {
        setSourceCode(data.starter_code || data.template_code || '# 在此编写你的代码\n\ndef solution():\n    pass\n\n\nif __name__ == "__main__":\n    solution()\n')
      }
      setLanguage(data.language || 'python')
      // 同时加载提交历史
      loadSubmissions(problemId)
    } catch {
      message.error(t('loadFailed'))
    }
  }

  // ── 运行代码 ──
  const handleRun = async () => {
    if (!sourceCode.trim()) {
      message.warning(t('writeCode'))
      return
    }
    setRunLoading(true)
    setRunResult(null)
    try {
      const { data } = await apiClient.post('/api/code/run', {
        problem_id: currentProblem?.problem_id,
        language,
        source_code: sourceCode,
        input_data: customInput,
      })
      setRunResult(data)
      // 累积运行记录
      setRunHistory(prev => {
        const entry = { id: Date.now(), ...data, input_data: customInput, createdAt: new Date().toLocaleTimeString() }
        return [entry, ...prev].slice(0, 10)
      })
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('runFailed'))
    } finally {
      setRunLoading(false)
    }
  }

  // ── 提交评分 ──
  const handleSubmit = async () => {
    if (!sourceCode.trim()) {
      message.warning(t('writeCode'))
      return
    }
    if (!currentProblem?.problem_id) {
      message.error(t('selectProblemFirst'))
      return
    }
    setSubmitLoading(true)
    setSubmissionResult(null)
    try {
      const { data } = await apiClient.post('/api/code/submit', {
        problem_id: currentProblem.problem_id,
        language,
        source_code: sourceCode,
      })
      message.success(t('submitSuccessGrading'))
      setPollingSubmission(true)
      pollSubmissionResult(data.submission_id)
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('submitFailed'))
    } finally {
      setSubmitLoading(false)
    }
  }

  // ── 轮询评分结果 ──
  const pollSubmissionResult = async (submissionId: number) => {
    const maxWait = 60000  // 最多等 60 秒
    const start = Date.now()
    while (Date.now() - start < maxWait) {
      try {
        const { data } = await apiClient.get(`/api/code/submissions/${submissionId}`)
        if (data.status === 'accepted' || data.status === 'wrong_answer' ||
            data.status === 'runtime_error' || data.status === 'time_limit' ||
            data.status === 'failed' || data.status === 'compile_error') {
          setSubmissionResult(data)
          setPollingSubmission(false)
          // 刷新列表和提交历史
          loadProblems()
          if (currentProblem) loadSubmissions(currentProblem.problem_id)
          return
        }
      } catch {
        // 继续等待
      }
      await new Promise(r => setTimeout(r, 1000))
    }
    setPollingSubmission(false)
    message.warning(t('gradingTimeoutRefresh'))
  }

  // ── AI 代码审查 ──
  const handleAiReview = async () => {
    if (!submissionResult?.id) {
      message.warning(t('submitAndWaitForGrading'))
      return
    }
    setAiReviewLoading(true)
    setAiReview(null)
    try {
      const { data } = await apiClient.post(`/api/code/submissions/${submissionResult.id}/review`)
      if (data.task_id) {
          message.info(t('aiReviewSubmitted'))
        const result = await pollAiTask(data.task_id, 120000)
        if (result && !result.error) {
          setAiReview(result)
        } else {
          // 尝试直接查询
          await pollAiReviewResult(submissionResult.id)
        }
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('aiReviewRequestFailed'))
    } finally {
      setAiReviewLoading(false)
    }
  }

  const pollAiReviewResult = async (submissionId: number) => {
    const maxWait = 120000
    const start = Date.now()
    while (Date.now() - start < maxWait) {
      try {
        const { data } = await apiClient.get(`/api/code/submissions/${submissionId}/review`)
        if (data.status === 'completed' && data.review) {
          setAiReview(data.review)
          return
        }
        if (data.status === 'failed') {
          message.error(t('aiReviewFailed'))
          return
        }
      } catch {
        // ignore
      }
      await new Promise(r => setTimeout(r, 2000))
    }
    message.warning(t('aiReviewTimeout'))
  }

  // ── 返回列表 ──
  const handleBack = () => {
    setCurrentProblem(null)
    setSourceCode('')
    setRunResult(null)
    setSubmissionResult(null)
    setAiReview(null)
    setSubmissions([])
  }

  // ── 初始化（必须放在所有 const 函数声明之后） ──
  useEffect(() => {
    loadProblems()
    apiClient.get('/api/code/languages').then(({ data }) => {
      if (data?.languages) setSupportedLangs(data.languages)
    }).catch(() => { /* ignore */ })
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setSubjectOptions(data.subjects)
    }).catch(() => {})
    if (isTeacherOrAdmin) {
      apiClient.get('/api/code/teachers/statistics').then(() => {}).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  // ── 渲染: 题目列表视图 ──
  const renderProblemList = () => (
    <>

      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          {isTeacherOrAdmin && (
            <>
              <Button size="small" icon={<RobotOutlined />} onClick={() => setAiGenModal(true)}>{t('aiGenerate')}</Button>
              <Button size="small" type="primary" icon={<FileTextOutlined />} onClick={() => setCreateModalOpen(true)}>{t('createProblem')}</Button>
            </>
          )}
        </Space>
      </div>

      <Spin spinning={loading}>
        <Table
          dataSource={problemList}
          rowKey="problem_id"
          pagination={false}
          size="middle"
          showHeader={false}
          expandable={{
            expandedRowRender: (record: any) => (
              <div style={{ padding: '12px 0' }}>
                <CompactCodeView
                  problemId={record.problem_id}
                  starterCode={record.starter_code}
                  language={record.language || 'python'}
                  supportedLanguages={supportedLangs}
                />
              </div>
            ),
            rowExpandable: () => true,
            expandedRowKeys,
            onExpand: (expanded, record) => {
              setExpandedRowKeys(expanded ? [record.problem_id] : [])
            },
            expandIcon: ({ expanded, onExpand, record }: any) => (
              <Button
                type="text"
                size="small"
                icon={expanded ? <MinusSquareOutlined /> : <PlusSquareOutlined />}
                onClick={(e) => { e.stopPropagation(); onExpand(record, e) }}
                style={{ marginRight: 8 }}
              />
            ),
          }}
          columns={[
            {
              dataIndex: 'title',
              render: (text: string, record: any) => (
                <Space>
                  <Text strong style={{ cursor: 'pointer', color: '#1677ff' }}
                    onClick={() => loadProblem(record.problem_id)}>
                    {text}
                  </Text>
                  <Tag color={record.difficulty === 'easy' ? 'green' : record.difficulty === 'hard' ? 'red' : 'orange'}>
                    {record.difficulty === 'easy' ? t('easy') : record.difficulty === 'hard' ? t('hard') : t('medium')}
                  </Tag>
                </Space>
              ),
            },
            {
              width: 400,
              style: { whiteSpace: 'nowrap' },
              render: (_: any, record: any) => (
                <Space size="small" style={{ justifyContent: 'flex-end' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{record.creator_name || record.creator_username}</Text>
                  <Tag>{record.language?.toUpperCase()}</Tag>
                  {isTeacherOrAdmin && record.total_submissions != null && (
                    <Button type="text" size="small" icon={<BarChartOutlined />}
                      onClick={(e) => {
                        e.stopPropagation()
                        loadStatsDetail(record.problem_id, record.title)
                      }}
                      title={t('viewSubmissionDetails')}
                    />
                  )}
                  {record.my_status && (
                    <Tag color={record.my_status === 'accepted' ? 'success' : 'error'}>
                      {record.my_status === 'accepted' ? `${record.my_score}${t('scoreUnit')}` : t(STATUS_MAP[record.my_status]?.labelKey ?? '') || record.my_status}
                    </Tag>
                  )}
                  {isTeacherOrAdmin && (
                    <>
                      <Button type="link" size="small" icon={<EditOutlined />}
                        onClick={(e) => { e.stopPropagation(); handleEditProblem(record.problem_id) }}
                      />
                      <Button type="link" size="small" danger icon={<DeleteOutlined />}
                        onClick={(e) => { e.stopPropagation(); handleDeleteProblem(record.problem_id) }}
                      />
                    </>
                  )}
                </Space>
              ),
            },
          ]}
          locale={{ emptyText: <Empty description={isTeacherOrAdmin ? t('noProblemsHint') : t('noProblems')} /> }}
        />
      </Spin>

      {/* 分页 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Pagination
          current={page}
          total={total}
          pageSize={pageSize}
          onChange={(p) => { setPage(p); setTimeout(loadProblems, 0) }}
          onShowSizeChange={(_p, size) => { setPageSize(size); setPage(1); setTimeout(loadProblems, 0) }}
          showSizeChanger
          pageSizeOptions={['5', '10', '20', '50']}
          showTotal={(total) => t('totalProblems', { count: total })}
          hideOnSinglePage={false}
        />
      </div>

      {/* ── 提交统计弹窗 ── */}
      <Modal
        title={t('submissionDetailTitle', { title: statsProblemTitle })}
        open={statsModalOpen}
        onCancel={() => setStatsModalOpen(false)}
        footer={null}
        width={900}
      >
        <Spin spinning={statsLoading}>
          {statsDetail.length === 0 ? (
            <Empty description={t('noStudentSubmissions')} />
          ) : (
            <Table
              dataSource={statsDetail}
              rowKey="id"
              size="small"
              pagination={false}
              expandable={{
                expandedRowRender: (record: any) => (
                  <div style={{ padding: '8px 0' }}>
                    <Text strong style={{ fontSize: 13 }}>{t('submittedCode')}</Text>
                    <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 12, borderRadius: 6, fontSize: 12, overflow: 'auto', maxHeight: 300, marginTop: 4 }}>
                      <code>{record.source_code || t('codeNotVisible')}</code>
                    </pre>
                  </div>
                ),
                rowExpandable: () => true,
              }}
              columns={[
                { title: t('studentName'), dataIndex: 'student_name', width: 100 },
                { title: t('studentClass'), dataIndex: 'student_class', width: 80 },
                {
                  title: t('status'), dataIndex: 'status', width: 100,
                  render: (v: string) => {
                    const st = STATUS_MAP[v]
                    return <Tag color={st?.color}>{st?.icon} {t(st?.labelKey ?? '') || v}</Tag>
                  },
                },
                { title: t('score'), dataIndex: 'score', width: 60 },
                { title: t('passedCases'), render: (_: any, r: any) => `${r.passed_cases || 0}/${r.total_cases || 0}`, width: 90 },
                { title: t('runTime'), dataIndex: 'execution_time', render: (v: number) => v ? `${v}s` : '-', width: 70 },
                { title: t('submitTime'), dataIndex: 'created_at', render: (v: string) => v?.slice(5, 16) || '', width: 120 },
              ]}
            />
          )}
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Text type="secondary">{t('totalStudentsSubmitted', { count: statsDetail.length })}</Text>
          </div>
        </Spin>
      </Modal>

      {/* ── 创建题目弹窗 ── */}
      <Modal
        title={t('createCodeProblem')}
        open={createModalOpen}
        onCancel={() => setCreateModalOpen(false)}
        onOk={handleCreateProblem}
        confirmLoading={createLoading}
        width={800}
        okText={t('saveProblem')}
      >
        <Tabs items={[
          {
            key: 'basic',
            label: t('basicInfo'),
            children: (
              <Space orientation="vertical" style={{ width: '100%' }}>
                <Input
                  placeholder={t('problemTitlePlaceholder')}
                  value={createForm.title}
                  onChange={e => setCreateForm({ ...createForm, title: e.target.value })}
                />
                <Input.TextArea
                  rows={4}
                  placeholder={t('problemDescriptionPlaceholder')}
                  value={createForm.description}
                  onChange={e => setCreateForm({ ...createForm, description: e.target.value })}
                />
                <Space>
                  <Select
                    value={createForm.subject}
                    onChange={v => setCreateForm({ ...createForm, subject: v })}
                    style={{ width: 140 }}
                    options={subjectOptions.map(s => ({ value: s, label: s }))}
                  />
                  <Select
                    value={createForm.difficulty}
                    onChange={v => setCreateForm({ ...createForm, difficulty: v })}
                    style={{ width: 100 }}
                    options={[
                      { value: 'easy', label: t('easy') },
                      { value: 'medium', label: t('medium') },
                      { value: 'hard', label: t('hard') },
                    ]}
                  />
                  <Select
                    value={createForm.language}
                    onChange={v => setCreateForm({ ...createForm, language: v })}
                    style={{ width: 120 }}
                    options={supportedLangs.length > 0 ? supportedLangs : [{ value: 'python', label: 'Python', available: true }]}
                  />
                  <Input
                    placeholder={t('kpPlaceholder')}
                    value={createForm.knowledge_points}
                    onChange={e => setCreateForm({ ...createForm, knowledge_points: e.target.value })}
                    style={{ width: 200 }}
                  />
                </Space>
              </Space>
            ),
          },
          {
            key: 'code',
            label: t('codeTemplate'),
            children: (
              <>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('codeTemplateDescription')}</Text>
                <Input.TextArea
                  rows={12}
                  value={createForm.template_code}
                  onChange={e => setCreateForm({ ...createForm, template_code: e.target.value })}
                  style={{ fontFamily: 'monospace', fontSize: 13 }}
                />
              </>
            ),
          },
          {
            key: 'cases',
            label: (
              <span>
                {t('testCases')}
                <Tag style={{ marginLeft: 4 }}>{createForm.test_cases.length}</Tag>
              </span>
            ),
            children: (
              <>
                {/* 新增测试用例 */}
                <Card size="small" style={{ marginBottom: 12 }}>
                  <Space orientation="vertical" style={{ width: '100%' }}>
                    <Text strong>{t('addTestCase')}</Text>
                    <Space>
                      <Input
                        placeholder={t('standardInput')}
                        value={newTestCase.input}
                        onChange={e => setNewTestCase({ ...newTestCase, input: e.target.value })}
                        style={{ width: 180 }}
                      />
                      <Input
                        placeholder={t('expectedOutput')}
                        value={newTestCase.expected}
                        onChange={e => setNewTestCase({ ...newTestCase, expected: e.target.value })}
                        style={{ width: 180 }}
                      />
                      <Input
                        placeholder={t('testCaseDescription')}
                        value={newTestCase.description}
                        onChange={e => setNewTestCase({ ...newTestCase, description: e.target.value })}
                        style={{ width: 160 }}
                      />
                      <InputNumber
                        placeholder={t('scorePlaceholder')}
                        value={newTestCase.score}
                        onChange={v => setNewTestCase({ ...newTestCase, score: v || 1 })}
                        min={0.5} max={10} step={0.5}
                        style={{ width: 70 }}
                      />
                      <Button
                        type="primary" size="small"
                        onClick={() => {
                          if (!newTestCase.expected.trim()) { message.warning(t('inputExpectedOutput')); return }
                          setCreateForm({
                            ...createForm,
                            test_cases: [...createForm.test_cases, { ...newTestCase, is_sample: createForm.test_cases.length < 2 }],
                          })
                          setNewTestCase({ input: '', expected: '', description: '', score: 1, is_sample: false })
                        }}
                      >
                        {t('add')}
                      </Button>
                    </Space>
                  </Space>
                </Card>

                {/* 测试用例列表 */}
                {createForm.test_cases.length === 0 ? (
                  <Text type="secondary">{t('noTestCasesYet')}</Text>
                ) : (
                  <Table
                    size="small"
                    dataSource={createForm.test_cases}
                    rowKey={(_, i) => String(i)}
                    pagination={false}
                    columns={[
                      { title: '#', render: (_: any, __: any, i: number) => i + 1, width: 40 },
                      { title: t('input'), dataIndex: 'input', render: (v: string) => <code>{v || t('empty')}</code> },
                      { title: t('expectedOutput'), dataIndex: 'expected', render: (v: string) => <code>{v}</code> },
                      { title: t('description'), dataIndex: 'description' },
                      { title: t('score'), dataIndex: 'score', width: 60 },
                      { title: t('example'), dataIndex: 'is_sample', render: (v: boolean) => v ? <Tag color="blue">{t('example')}</Tag> : null, width: 60 },
                      { title: t('actions'), width: 60, render: (_: any, __: any, i: number) => (
                        <Button type="link" danger size="small" onClick={() => {
                          setCreateForm({
                            ...createForm,
                            test_cases: createForm.test_cases.filter((_, idx) => idx !== i),
                          })
                        }}>{t('delete')}</Button>
                      )},
                    ]}
                  />
                )}
              </>
            ),
          },
          {
            key: 'scope',
            label: t('targetScope'),
            children: (
              <div style={{ padding: '8px 0' }}>
                <ActivityScopeSelector
                  value={{
                    target_scope: createForm.target_scope as any || 'teacher_classes',
                    target_grade: createForm.target_grade || '',
                    target_class: createForm.target_class || '',
                    target_users: createForm.target_users || '',
                  }}
                  onChange={(val) => setCreateForm({
                    ...createForm,
                    target_scope: val.target_scope,
                    target_grade: val.target_grade,
                    target_class: val.target_class,
                    target_users: val.target_users,
                  })}
                  showAllOption={isTeacherOrAdmin && user?.role === 'admin'}
                />
              </div>
            ),
          },
        ]} />
      </Modal>

      {/* ── AI 生成弹窗 ── */}
      <Modal
        title={t('aiGenerateCodeProblem')}
        open={aiGenModal}
        onCancel={() => { setAiGenModal(false); setAiGenResult(null) }}
        footer={null}
        width={500}
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Text>{t('aiGenerateDesc')}</Text>
          <Space>
            <Input
              placeholder={t('aiGenTopicPlaceholder')}
              value={aiGenTopic}
              onChange={e => setAiGenTopic(e.target.value)}
              style={{ width: 300 }}
              onPressEnter={handleAiGenerate}
            />
            <Select
              value={aiGenSubject}
              onChange={setAiGenSubject}
              style={{ width: 120 }}
              options={subjectOptions.map(s => ({ value: s, label: s }))}
            />
            <Button type="primary" onClick={handleAiGenerate} loading={aiGenLoading}>
              {t('generate')}
            </Button>
          </Space>

          {aiGenResult && (
            <Alert
              type="success"
              showIcon
              message={t('aiGenerateComplete')}
              description={
                <div>
                  <Text strong>{t('title')}：</Text>{aiGenResult.title}<br />
                  <Text strong>{t('knowledgePoints')}：</Text>{aiGenResult.knowledge_points}<br />
                  <Text strong>{t('testCases')}：</Text>{t('countCases', { count: aiGenResult.test_cases?.length || 0 })}
                </div>
              }
              action={
                <Button size="small" type="primary" onClick={() => {
                  setAiGenModal(false)
                  setAiGenResult(null)
                  message.success(t('contentFilled'))
                }}>
                  {t('cpConfirmEdit')}
                </Button>
              }
              style={{ marginTop: 8 }}
            />
          )}
        </Space>
      </Modal>

      {/* ── 编辑题目弹窗 ── */}
      <Modal
        title={t('cpEditTitle')}
        open={editModalOpen}
        onCancel={() => setEditModalOpen(false)}
        onOk={handleSaveEdit}
        confirmLoading={editLoading}
        width={800}
        okText={t('cpSaveChanges')}
      >
        <Tabs items={[
          {
            key: 'basic',
            label: t('cpBasics'),
            children: (
              <Space orientation="vertical" style={{ width: '100%' }}>
                <Input placeholder={t('cpTitlePh')} value={editForm.title}
                  onChange={e => setEditForm({ ...editForm, title: e.target.value })} />
                <Input.TextArea rows={4} placeholder={t('cpDescPh')} value={editForm.description}
                  onChange={e => setEditForm({ ...editForm, description: e.target.value })} />
                <Space>
                  <Select value={editForm.subject} onChange={v => setEditForm({ ...editForm, subject: v })}
                    style={{ width: 140 }}
                    options={subjectOptions.map(s => ({ value: s, label: s }))} />
                  <Select value={editForm.difficulty} onChange={v => setEditForm({ ...editForm, difficulty: v })}
                    style={{ width: 100 }}
                    options={[{ value: 'easy', label: t('easy') }, { value: 'medium', label: t('medium') }, { value: 'hard', label: t('hard') }]} />
                  <Select value={editForm.language} onChange={v => setEditForm({ ...editForm, language: v })}
                    style={{ width: 120 }}
                    options={supportedLangs.length > 0 ? supportedLangs : [{ value: 'python', label: 'Python', available: true }]} />
                  <Input placeholder={t('cpKpPh')} value={editForm.knowledge_points}
                    onChange={e => setEditForm({ ...editForm, knowledge_points: e.target.value })} style={{ width: 200 }} />
                </Space>
              </Space>
            ),
          },
          {
            key: 'code',
            label: t('cpTemplate'),
            children: (
              <>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('starterCodeHint')}</Text>
                <Input.TextArea rows={12} value={editForm.template_code}
                  onChange={e => setEditForm({ ...editForm, template_code: e.target.value })}
                  style={{ fontFamily: 'monospace', fontSize: 13 }} />
              </>
            ),
          },
          {
            key: 'cases',
            label: <span>{t('testCases')} <Tag style={{ marginLeft: 4 }}>{editTestCases.length}</Tag></span>,
            children: (
              <>
                {editTestCases.length === 0 ? (
                  <Text type="secondary">{t('noTestCases')}</Text>
                ) : (
                  <Table size="small" dataSource={editTestCases} rowKey={(_, i) => String(i)} pagination={false}
                    columns={[
                      { title: '#', render: (_: any, __: any, i: number) => i + 1, width: 40 },
                          { title: t('cpColInput'), dataIndex: 'input', render: (v: string) => <code>{v || t('cpEmpty')}</code> },
                          { title: t('cpColExpected'), dataIndex: 'expected', render: (v: string) => <code>{v}</code> },
                          { title: t('cpColDesc'), dataIndex: 'description' },
                          { title: t('cpColScore'), dataIndex: 'score', width: 60 },
                          { title: t('cpColSample'), dataIndex: 'is_sample', render: (v: boolean) => v ? <Tag color="blue">{t('cpSampleTag')}</Tag> : null, width: 60 },
                    ]}
                  />
                )}
                <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                  {t('cpTestCaseHint')}
                </Text>
              </>
            ),
          },
        ]} />
      </Modal>
    </>
  )

  // ── 渲染: 代码编辑器视图 ──
  const renderCodeEditor = () => {
    if (!currentProblem) return null

    const statusInfo = submissionResult ? STATUS_MAP[submissionResult.status] : null

    return (
      <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 180px)' }}>
        {/* 左面板：题目描述 */}
        <div style={{ width: '40%', overflow: 'auto', background: '#fff', borderRadius: 8, padding: 16, border: '1px solid #f0f0f0' }}>
          <Space style={{ marginBottom: 12 }}>
            <Button icon={<ArrowLeftOutlined />} onClick={handleBack} size="small">{t('start')}</Button>
            <Title level={5} style={{ margin: 0 }}>{currentProblem.title}</Title>
            <Tag color={currentProblem.difficulty === 'easy' ? 'green' : currentProblem.difficulty === 'hard' ? 'red' : 'orange'}>
              {currentProblem.difficulty === 'easy' ? t('easy') : currentProblem.difficulty === 'hard' ? t('hard') : t('medium')}
            </Tag>
          </Space>

          <div className="markdown-content" style={{ fontSize: 14, lineHeight: 1.7 }}>
            <ReactMarkdown>{currentProblem.description || ''}</ReactMarkdown>
          </div>

          {/* 示例测试用例 */}
          {currentProblem.sample_cases?.length > 0 && (
            <>
              <Divider>{t('explanation')}</Divider>
              {currentProblem.sample_cases.map((sc: any, i: number) => (
                <Card key={sc.id} size="small" style={{ marginBottom: 8 }}>
                  <Text strong>{t('explanation')} {i + 1}</Text>
                  {sc.description && <Text type="secondary"> — {sc.description}</Text>}
                  <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, marginTop: 4, fontSize: 12 }}>
                    <Text strong>{t('input')}：</Text>{sc.input || t('cpNone')}{'\n'}
                    <Text strong>{t('output')}：</Text>{sc.expected_output}
                  </pre>
                </Card>
              ))}
            </>
          )}

          {/* 提交历史 */}
          <Divider>
            <Space>
              <HistoryOutlined />
              <span>{t('submitCode')}</span>
            </Space>
          </Divider>
          <Spin spinning={submissionsLoading}>
            {submissions.length === 0 ? (
              <Text type="secondary">{t('noHistory')}</Text>
            ) : (
              <List
                size="small"
                dataSource={submissions}
                renderItem={(s: any) => {
                  const st = STATUS_MAP[s.status]
                  return (
                    <List.Item
                      style={{ cursor: 'pointer' }}
                      onClick={async () => {
                        try {
                          const { data } = await apiClient.get(`/api/code/submissions/${s.id}`)
                          setSubmissionResult(data)
                        } catch { /* ignore */ }
                      }}
                    >
                      <Space>
                        <Tag color={st?.color}>{st?.icon} {t(st?.labelKey ?? '') || s.status}</Tag>
                        <Text type="secondary" style={{ fontSize: 12 }}>{t('scorePoints', { score: s.score })}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{s.created_at?.slice(5, 16)}</Text>
                      </Space>
                    </List.Item>
                  )
                }}
              />
            )}
          </Spin>
        </div>

        {/* 右面板：代码编辑器 + 结果 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 编辑器 */}
          <div style={{ flex: 1 }}>
            <CodeEditor
              language={language}
              value={sourceCode}
              onChange={setSourceCode}
              showLanguageSelector={false}
              supportedLanguages={supportedLangs}
            />
          </div>

          {/* 工具栏 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleRun}
              loading={runLoading}
            >
              {t('runCode')}
            </Button>
            <Button
              type="primary"
              ghost
              icon={<SendOutlined />}
              onClick={handleSubmit}
              loading={submitLoading || pollingSubmission}
            >
              {pollingSubmission ? t('testResult') : t('submitCode')}
            </Button>
            {isTeacherOrAdmin && (
              <Button
                icon={<RobotOutlined />}
                onClick={handleAiReview}
                loading={aiReviewLoading}
                disabled={!submissionResult}
              >
                {t('runCode')}
              </Button>
            )}
            <div style={{ flex: 1 }} />
            <Select
              size="small"
              value={language}
              onChange={setLanguage}
              style={{ width: 120 }}
              options={supportedLangs.length > 0 ? supportedLangs : [{ value: 'python', label: 'Python', available: true }]}
            />
          </div>

          {/* 自定义输入 */}
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('input')}：</Text>
            <TextArea
              rows={2}
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              placeholder={t('cpStdinPh')}
              style={{ fontSize: 12, marginTop: 4 }}
            />
          </div>

          {/* 结果区域 */}
          {(runResult || submissionResult || aiReview) && (
            <Tabs
              size="small"
              defaultActiveKey={runResult ? 'output' : submissionResult ? 'result' : 'review'}
              items={[
                ...(runResult ? [{
                  key: 'output',
                  label: <span><PlayCircleOutlined />{t('runOutput')}</span>,
                  children: (
                    <div>
                      {/* 当前运行结果 */}
                      <div style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 12, borderRadius: 6, fontFamily: 'monospace', fontSize: 13, maxHeight: 200, overflow: 'auto' }}>
                        {runResult.error ? (
                          <div style={{ color: '#f48771' }}>
                            <div>{t('errorPrefix')}{runResult.error}</div>
                            {runResult.stderr && <pre style={{ margin: 0, color: '#f48771' }}>{runResult.stderr}</pre>}
                          </div>
                        ) : (
                          <>
                            <div style={{ color: '#888', marginBottom: 4 }}>Exit Code: {runResult.exit_code} | Time: {runResult.execution_time}s | {t('cpInputLabel')}: {customInput || t('cpEmpty')}</div>
                            {runResult.stdout ? (
                              <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{runResult.stdout}</pre>
                            ) : (
                              <div style={{ color: '#888' }}>{t('noOutput')}</div>
                            )}
                            {runResult.stderr && <pre style={{ margin: 0, color: '#f48771', marginTop: 8 }}>{runResult.stderr}</pre>}
                          </>
                        )}
                      </div>
                      {/* 运行历史 */}
                      {runHistory.length > 1 && (
                        <details style={{ marginTop: 8, fontSize: 13 }}>
                          <summary style={{ cursor: 'pointer', color: '#888', userSelect: 'none' }}>
                            {t('runHistory')}（{runHistory.length} {t('countRuns')}）
                          </summary>
                          <div style={{ maxHeight: 200, overflow: 'auto', marginTop: 4 }}>
                            {runHistory.map((entry, idx) => (
                              <div key={entry.id} style={{
                                background: '#1e1e1e', color: '#d4d4d4', padding: '6px 10px',
                                borderRadius: 4, marginBottom: 4, fontFamily: 'monospace', fontSize: 12,
                                borderLeft: `3px solid ${entry.exit_code === 0 ? '#52c41a' : '#f48771'}`,
                              }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                  <span style={{ color: '#888' }}>#{runHistory.length - idx} {entry.createdAt}</span>
                                  <span style={{ color: entry.exit_code === 0 ? '#52c41a' : '#f48771' }}>
                                    Exit {entry.exit_code} | {entry.execution_time}s
                                  </span>
                                </div>
                                {entry.input_data && <div style={{ color: '#69b1ff' }}>↳ {t('input')}: {entry.input_data}</div>}
                                <pre style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>
                                  {entry.stdout || (entry.error ? entry.error.slice(0, 80) : `(${t('noOutput')})`)}
                                </pre>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  ),
                }] : []),
                ...(submissionResult ? [{
                  key: 'result',
                  label: <span><BarChartOutlined />{t('scoreResult')}</span>,
                  children: (
                    <div>
                      <Row gutter={16} style={{ marginBottom: 12 }}>
                        <Col span={6}>
                          <Statistic
                            title={t('status')}
                            value={statusInfo ? t(statusInfo.labelKey) || submissionResult.status : submissionResult.status}
                            styles={{ content: { fontSize: 16, color: statusInfo?.color === 'success' ? '#52c41a' : '#ff4d4f' } }}
                          />
                        </Col>
                        <Col span={6}>
                          <Statistic title={t('cpScore')} value={submissionResult.score} suffix={`/ ${submissionResult.total_cases}`} styles={{ content: { fontSize: 16 } }} />
                        </Col>
                        <Col span={6}>
                          <Statistic title={t('cpPassedCases')} value={`${submissionResult.passed_cases || 0} / ${submissionResult.total_cases || 0}`} styles={{ content: { fontSize: 16 } }} />
                        </Col>
                        <Col span={6}>
                          <Statistic title={t('cpRuntime')} value={submissionResult.execution_time || 0} suffix="s" styles={{ content: { fontSize: 16 } }} />
                        </Col>
                      </Row>

                      {/* 测试用例详情 */}
                      {submissionResult.details?.length > 0 && (
                        <>
                          <Divider>{t('testCaseDetail')}</Divider>
                          <Table
                            size="small"
                            dataSource={submissionResult.details}
                            rowKey="case_id"
                            pagination={false}
                            columns={[
                                  { title: t('cpColCase'), dataIndex: 'description', render: (v: string, r: any) => v || (r.is_sample ? t('cpSampleTag') : `${t('cpCasePrefix')} #${r.case_id}`) },
                                  { title: t('cpColInput'), dataIndex: 'input', render: (v: string) => <code style={{ fontSize: 12 }}>{(v || t('cpEmpty')).slice(0, 50)}</code> },
                                  { title: t('cpColExpected'), dataIndex: 'expected', render: (v: string) => <code style={{ fontSize: 12 }}>{v.slice(0, 80)}</code> },
                                  { title: t('cpColActual'), dataIndex: 'actual', render: (v: string, r: any) => (
                                <span style={{ color: r.is_pass ? '#52c41a' : '#ff4d4f' }}>
                                  <code style={{ fontSize: 12 }}>{v ? v.slice(0, 80) : t('cpEmpty')}</code>
                                </span>
                              )},
                              { title: t('testResult'), dataIndex: 'is_pass', render: (v: boolean) => v ? <Tag color="success">{t('passed')}</Tag> : <Tag color="error">{t('failed')}</Tag> },
                              { title: t('score'), dataIndex: 'score', render: (v: number) => v || 0 },
                            ]}
                          />
                        </>
                      )}
                    </div>
                  ),
                }] : []),
                ...(aiReview ? [{
                  key: 'review',
                  label: <span><RobotOutlined />{t('aiReview')}</span>,
                  children: (
                    <div>
                      <Row gutter={16} style={{ marginBottom: 12 }}>
                        <Col span={6}>
                          <Statistic title={t('cpOverallScore')} value={aiReview.overall_score} suffix="/100" styles={{ content: { fontSize: 16 } }} />
                        </Col>
                        <Col span={6}>
                          <Statistic title={t('cpRating')} value={aiReview.overall_rating} styles={{ content: { fontSize: 16 } }} />
                        </Col>
                      </Row>

                      <Descriptions column={2} size="small" bordered style={{ marginBottom: 12 }}>
                        {aiReview.dimensions?.correctness && (
                          <Descriptions.Item label={t('cpDimCorrect')} span={1}>
                            <Progress percent={aiReview.dimensions.correctness.score} size="small" />
                          </Descriptions.Item>
                        )}
                        {aiReview.dimensions?.code_quality && (
                          <Descriptions.Item label={t('cpDimQuality')} span={1}>
                            <Progress percent={aiReview.dimensions.code_quality.score} size="small" />
                          </Descriptions.Item>
                        )}
                        {aiReview.dimensions?.efficiency && (
                          <Descriptions.Item label={t('cpDimEfficiency')} span={1}>
                            <Progress percent={aiReview.dimensions.efficiency.score} size="small" />
                          </Descriptions.Item>
                        )}
                        {aiReview.dimensions?.style && (
                          <Descriptions.Item label={t('cpDimStyle')} span={1}>
                            <Progress percent={aiReview.dimensions.style.score} size="small" />
                          </Descriptions.Item>
                        )}
                      </Descriptions>

                      {/* 优点 */}
                      {aiReview.strengths?.length > 0 && (
                        <>
                          <Text strong style={{ color: '#52c41a' }}>{t('strengths')}</Text>
                          <ul style={{ margin: '4px 0 12px' }}>
                            {aiReview.strengths.map((s: string, i: number) => <li key={i}><Text>{s}</Text></li>)}
                          </ul>
                        </>
                      )}

                      {/* 不足 */}
                      {aiReview.weaknesses?.length > 0 && (
                        <>
                          <Text strong style={{ color: '#ff4d4f' }}>{t('improvements')}</Text>
                          <ul style={{ margin: '4px 0 12px' }}>
                            {aiReview.weaknesses.map((w: string, i: number) => <li key={i}><Text>{w}</Text></li>)}
                          </ul>
                        </>
                      )}

                      {/* 改进建议 */}
                      {aiReview.suggestions?.length > 0 && (
                        <>
                          <Text strong style={{ color: '#1677ff' }}>{t('suggestions')}</Text>
                          <ul style={{ margin: '4px 0 12px' }}>
                            {aiReview.suggestions.map((s: string, i: number) => <li key={i}><Text>{s}</Text></li>)}
                          </ul>
                        </>
                      )}

                      {/* 改进代码 */}
                      {aiReview.improved_code && (
                        <>
                          <Divider>{t('reference')}</Divider>
                          <pre style={{ background: '#f6ffed', padding: 12, borderRadius: 6, fontSize: 13, overflow: 'auto' }}>
                            <code>{aiReview.improved_code}</code>
                          </pre>
                        </>
                      )}
                    </div>
                  ),
                }] : []),
              ]}
            />
          )}
        </div>
      </div>
    )
  }

  // ── 代码随机名言 ──
  const codeQuotes = [
    'Talk is cheap. Show me the code.',
    '代码如诗，简洁为美',
    '写好每一行代码，解决每一个问题',
    '编程是思考的艺术',
    'Debug 是一种修行',
    '用代码改变世界',
    '每一次提交，都是进步',
    'Clear code, clear mind',
    'Code. Eat. Sleep. Repeat.',
    '键盘敲烂，月入过万 💪',
    '编译器不会骗你，但 debug 会 🐛',
    '先跑起来，再优化',
    'Programming is the art of logic',
    '简单的代码最优雅',
  ]
  const [codeQuote] = useState(() => codeQuotes[Math.floor(Math.random() * codeQuotes.length)])

  // ── 主渲染 ──
  return (
    <Card style={{ borderRadius: 8, height: '100%' }}>
      <div style={{
        padding: '12px 24px',
        marginBottom: 16,
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        borderRadius: 6,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div style={{ color: '#fff' }}>
          <span style={{ fontSize: 15, fontWeight: 500, opacity: 0.95 }}>
            {codeQuote}
          </span>
        </div>
        <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
          {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
        </div>
      </div>
      {currentProblem ? renderCodeEditor() : renderProblemList()}
    </Card>
  )
}

export default CodePracticePage
