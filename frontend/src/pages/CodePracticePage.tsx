import React, { useState, useEffect } from 'react'
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
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'

const { Title, Text } = Typography
const { TextArea } = Input

// ── 状态标签映射 ──
const STATUS_MAP: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  pending:        { label: '等待中',   color: 'default',   icon: <ClockCircleOutlined /> },
  running:        { label: '运行中',   color: 'processing', icon: <Spin size="small" /> },
  accepted:       { label: '通过 ✅',   color: 'success',   icon: <CheckCircleOutlined /> },
  wrong_answer:   { label: '答案错误 ❌', color: 'error',     icon: <CloseCircleOutlined /> },
  runtime_error:  { label: '运行时错误 💥', color: 'error',   icon: <CloseCircleOutlined /> },
  time_limit:     { label: '超时 ⏱',   color: 'warning',   icon: <ClockCircleOutlined /> },
  compile_error:  { label: '编译错误 🔧', color: 'error',    icon: <CloseCircleOutlined /> },
  failed:         { label: '评分失败', color: 'default',    icon: <CloseCircleOutlined /> },
}

// ── 紧凑型代码练习视图（用于表格展开行） ──
const CompactCodeView: React.FC<{
  problemId: number
  starterCode?: string
  language?: string
  supportedLanguages?: { value: string; label: string; available: boolean }[]
}> = ({ problemId, starterCode, language: initLang = 'python', supportedLanguages }) => {
  const [code, setCode] = useState(starterCode || '# 在此编写你的代码\n\ndef solution():\n    pass\n')
  const [lang, setLang] = useState(initLang)
  const [customInput, setCustomInput] = useState('')
  const [runResult, setRunResult] = useState<any>(null)
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
    if (!code.trim()) { message.warning('请编写代码'); return }
    setRunLoading(true)
    setRunResult(null)
    try {
      const { data } = await apiClient.post('/api/code/run', {
        problem_id: problemId, language: lang, source_code: code, input_data: customInput,
      })
      setRunResult(data)
    } catch (e: any) { message.error(e.response?.data?.detail || '运行失败') }
    finally { setRunLoading(false) }
  }

  const handleSubmit = async () => {
    if (!code.trim()) { message.warning('请编写代码'); return }
    setSubmitLoading(true)
    setSubmissionResult(null)
    try {
      const { data } = await apiClient.post('/api/code/submit', {
        problem_id: problemId, language: lang, source_code: code,
      })
      message.success('提交成功，正在评分...')
      setPollingSubmission(true)
      pollResult(data.submission_id)
    } catch (e: any) { message.error(e.response?.data?.detail || '提交失败') }
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
    message.warning('评分超时')
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
              <span onClick={(e) => { e.stopPropagation(); setDescCollapsed(false) }} style={{ cursor: 'pointer', color: '#1677ff' }}>📄 题目</span>
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
                  <Text strong style={{ fontSize: 12 }}>示例：</Text>
                  {problemData.sample_cases.map((sc: any, i: number) => (
                    <div key={sc.id || i} style={{ background: '#fff', padding: 6, borderRadius: 4, marginTop: 4, fontSize: 12, border: '1px solid #e8e8e8' }}>
                      <Text type="secondary">示例 {i + 1}</Text>
                      {sc.description && <Text type="secondary"> — {sc.description}</Text>}
                      <pre style={{ margin: 2, fontSize: 11 }}>输入：{sc.input || '(无)'}{'\n'}输出：{sc.expected_output}</pre>
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
          <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} loading={runLoading}>运行</Button>
          <Button size="small" type="primary" ghost icon={<SendOutlined />} onClick={handleSubmit} loading={submitLoading || pollingSubmission}>
            {pollingSubmission ? '评分中...' : '提交'}
          </Button>
          <Select size="small" value={lang} onChange={setLang} style={{ width: 100 }}
            options={supportedLanguages && supportedLanguages.length > 0
              ? supportedLanguages
              : [{ value: 'python', label: 'Python', available: true }, { value: 'javascript', label: 'JavaScript', available: true }]} />
          <Input size="small" placeholder="自定义输入" value={customInput}
            onChange={e => setCustomInput(e.target.value)} style={{ width: 160, fontSize: 12 }} />
          {/* 结果与按钮同行显示 */}
          {submissionResult && (
            <span style={{ fontSize: 12, color: submissionResult.status === 'accepted' ? '#52c41a' : '#f48771' }}>
              {STATUS_MAP[submissionResult.status]?.label || submissionResult.status}
              {' | '}{submissionResult.score}分 | 通过 {submissionResult.passed_cases ?? 0}/{submissionResult.total_cases ?? 0} 用例
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
                {runResult.stdout ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{runResult.stdout}</pre> : <span style={{ color: '#888' }}>（无输出）</span>}
                {runResult.stderr && <pre style={{ margin: 0, color: '#f48771', marginTop: 4 }}>{runResult.stderr}</pre>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface CodePracticePageProps {
  inTab?: boolean
}

const CodePracticePage: React.FC<CodePracticePageProps> = ({ inTab = false }) => {
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
      message.error('加载提交详情失败')
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

  // ── 教师端：统计 ──
  const [teacherStats, setTeacherStats] = useState<any[]>([])

  // ═══════════════════════════════════════════════════════════
  // 所有 const 函数必须先声明，再在 useEffect 中调用
  // ═══════════════════════════════════════════════════════════

  // 教师统计已内联到 useEffect 中

  // ── 创建题目 ──
  const handleCreateProblem = async () => {
    if (!createForm.title.trim()) {
      message.warning('请输入题目标题')
      return
    }
    if (createForm.test_cases.length === 0) {
      message.warning('请至少添加一个测试用例')
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
      message.success('题目创建成功')
      setCreateModalOpen(false)
      setCreateForm({
        title: '', description: '', subject: '', knowledge_points: '',
        difficulty: 'medium', language: 'python',
        template_code: '# 在此编写你的代码\n\ndef solution():\n    pass\n',
        starter_code: '', time_limit: 5, test_cases: [],
        target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '',
      })
      loadProblems()
      apiClient.get('/api/code/teachers/statistics').then(({ data }) => {
        setTeacherStats(data.problems || [])
      }).catch(() => {})
    } catch (e: any) {
      message.error(e.response?.data?.detail || '创建失败')
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
      message.error(e.response?.data?.detail || '加载题目失败')
    } finally {
      setEditLoading(false)
    }
  }

  // ── 保存编辑 ──
  const handleSaveEdit = async () => {
    if (!editForm.title.trim()) { message.warning('请输入题目标题'); return }
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
      message.success('题目已更新')
      setEditModalOpen(false)
      loadProblems()
    } catch (e: any) {
      message.error(e.response?.data?.detail || '更新失败')
    } finally {
      setEditLoading(false)
    }
  }

  // ── 删除题目 ──
  const handleDeleteProblem = (problemId: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '删除后学生将无法看到该题目，确定要删除吗？',
      okText: '确认删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiClient.delete(`/api/code/problems/${problemId}`)
          message.success('题目已删除')
          loadProblems()
          apiClient.get('/api/code/teachers/statistics').then(({ data }) => {
            setTeacherStats(data.problems || [])
          }).catch(() => {})
        } catch (e: any) {
          message.error(e.response?.data?.detail || '删除失败')
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
    if (!aiGenTopic.trim()) { message.warning('请输入主题'); return }
    setAiGenLoading(true)
    setAiGenResult(null)
    try {
      const { data } = await apiClient.post('/api/code/ai-generate', {
        topic: aiGenTopic, subject: aiGenSubject, language: 'python', difficulty: 'medium',
      })
      if (data.task_id) {
        setAiGenTaskId(data.task_id)
        message.info('AI 生成中，请稍候...')
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
          message.success('AI 生成完成，请确认后保存')
        } else {
          message.error('AI 生成失败：返回格式异常')
        }
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || 'AI 生成请求失败')
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
      message.error('加载题目列表失败')
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
      message.error('加载题目详情失败')
    }
  }

  // ── 运行代码 ──
  const handleRun = async () => {
    if (!sourceCode.trim()) {
      message.warning('请先编写代码')
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
    } catch (e: any) {
      message.error(e.response?.data?.detail || '运行失败')
    } finally {
      setRunLoading(false)
    }
  }

  // ── 提交评分 ──
  const handleSubmit = async () => {
    if (!sourceCode.trim()) {
      message.warning('请先编写代码')
      return
    }
    if (!currentProblem?.problem_id) {
      message.error('请先选择题目')
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
      message.success('提交成功，正在评分...')
      setPollingSubmission(true)
      pollSubmissionResult(data.submission_id)
    } catch (e: any) {
      message.error(e.response?.data?.detail || '提交失败')
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
    message.warning('评分超时，请稍后刷新查看结果')
  }

  // ── AI 代码审查 ──
  const handleAiReview = async () => {
    if (!submissionResult?.id) {
      message.warning('请先提交代码并等待评分完成')
      return
    }
    setAiReviewLoading(true)
    setAiReview(null)
    try {
      const { data } = await apiClient.post(`/api/code/submissions/${submissionResult.id}/review`)
      if (data.task_id) {
          message.info('AI 审查已提交，正在分析...')
        const result = await pollAiTask(data.task_id, 120000)
        if (result && !result.error) {
          setAiReview(result)
        } else {
          // 尝试直接查询
          await pollAiReviewResult(submissionResult.id)
        }
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || 'AI 审查请求失败')
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
          message.error('AI 审查失败')
          return
        }
      } catch {
        // ignore
      }
      await new Promise(r => setTimeout(r, 2000))
    }
    message.warning('AI 审查超时')
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
      apiClient.get('/api/code/teachers/statistics').then(({ data }) => {
        setTeacherStats(data.problems || [])
      }).catch(() => {})
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
              <Button size="small" icon={<RobotOutlined />} onClick={() => setAiGenModal(true)}>AI 生成</Button>
              <Button size="small" type="primary" icon={<FileTextOutlined />} onClick={() => setCreateModalOpen(true)}>创建题目</Button>
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
                    {record.difficulty === 'easy' ? '简单' : record.difficulty === 'hard' ? '困难' : '中等'}
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
                      title="查看提交详情"
                    />
                  )}
                  {record.my_status && (
                    <Tag color={record.my_status === 'accepted' ? 'success' : 'error'}>
                      {record.my_status === 'accepted' ? `${record.my_score}分` : STATUS_MAP[record.my_status]?.label || record.my_status}
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
          locale={{ emptyText: <Empty description={isTeacherOrAdmin ? '暂无代码题目，点击「创建题目」开始' : '暂无代码题目'} /> }}
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
          showTotal={(t) => `共 ${t} 道题目`}
          hideOnSinglePage={false}
        />
      </div>

      {/* ── 提交统计弹窗 ── */}
      <Modal
        title={`提交详情 - ${statsProblemTitle}`}
        open={statsModalOpen}
        onCancel={() => setStatsModalOpen(false)}
        footer={null}
        width={900}
      >
        <Spin spinning={statsLoading}>
          {statsDetail.length === 0 ? (
            <Empty description="暂无学生提交" />
          ) : (
            <Table
              dataSource={statsDetail}
              rowKey="id"
              size="small"
              pagination={false}
              expandable={{
                expandedRowRender: (record: any) => (
                  <div style={{ padding: '8px 0' }}>
                    <Text strong style={{ fontSize: 13 }}>提交代码：</Text>
                    <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 12, borderRadius: 6, fontSize: 12, overflow: 'auto', maxHeight: 300, marginTop: 4 }}>
                      <code>{record.source_code || '（代码不可见）'}</code>
                    </pre>
                  </div>
                ),
                rowExpandable: () => true,
              }}
              columns={[
                { title: '姓名', dataIndex: 'student_name', width: 100 },
                { title: '班级', dataIndex: 'student_class', width: 80 },
                {
                  title: '状态', dataIndex: 'status', width: 100,
                  render: (v: string) => {
                    const st = STATUS_MAP[v]
                    return <Tag color={st?.color}>{st?.icon} {st?.label || v}</Tag>
                  },
                },
                { title: '得分', dataIndex: 'score', width: 60 },
                { title: '通过用例', render: (_: any, r: any) => `${r.passed_cases || 0}/${r.total_cases || 0}`, width: 90 },
                { title: '用时', dataIndex: 'execution_time', render: (v: number) => v ? `${v}s` : '-', width: 70 },
                { title: '提交时间', dataIndex: 'created_at', render: (v: string) => v?.slice(5, 16) || '', width: 120 },
              ]}
            />
          )}
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Text type="secondary">共 {statsDetail.length} 名学生提交</Text>
          </div>
        </Spin>
      </Modal>

      {/* ── 创建题目弹窗 ── */}
      <Modal
        title="创建代码题"
        open={createModalOpen}
        onCancel={() => setCreateModalOpen(false)}
        onOk={handleCreateProblem}
        confirmLoading={createLoading}
        width={800}
        okText="保存题目"
      >
        <Tabs items={[
          {
            key: 'basic',
            label: '基本信息',
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Input
                  placeholder="题目标题"
                  value={createForm.title}
                  onChange={e => setCreateForm({ ...createForm, title: e.target.value })}
                />
                <Input.TextArea
                  rows={4}
                  placeholder="题目描述（支持 Markdown 格式，描述输入输出和样例）"
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
                      { value: 'easy', label: '简单' },
                      { value: 'medium', label: '中等' },
                      { value: 'hard', label: '困难' },
                    ]}
                  />
                  <Select
                    value={createForm.language}
                    onChange={v => setCreateForm({ ...createForm, language: v })}
                    style={{ width: 120 }}
                    options={supportedLangs.length > 0 ? supportedLangs : [{ value: 'python', label: 'Python', available: true }]}
                  />
                  <Input
                    placeholder="知识点标签（逗号分隔）"
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
            label: '代码模板',
            children: (
              <>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>学生编写代码时的初始模板（含 TODO 注释引导）</Text>
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
                测试用例
                <Tag style={{ marginLeft: 4 }}>{createForm.test_cases.length}</Tag>
              </span>
            ),
            children: (
              <>
                {/* 新增测试用例 */}
                <Card size="small" style={{ marginBottom: 12 }}>
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Text strong>添加测试用例</Text>
                    <Space>
                      <Input
                        placeholder="标准输入"
                        value={newTestCase.input}
                        onChange={e => setNewTestCase({ ...newTestCase, input: e.target.value })}
                        style={{ width: 180 }}
                      />
                      <Input
                        placeholder="期望输出"
                        value={newTestCase.expected}
                        onChange={e => setNewTestCase({ ...newTestCase, expected: e.target.value })}
                        style={{ width: 180 }}
                      />
                      <Input
                        placeholder="用例说明"
                        value={newTestCase.description}
                        onChange={e => setNewTestCase({ ...newTestCase, description: e.target.value })}
                        style={{ width: 160 }}
                      />
                      <InputNumber
                        placeholder="分值"
                        value={newTestCase.score}
                        onChange={v => setNewTestCase({ ...newTestCase, score: v || 1 })}
                        min={0.5} max={10} step={0.5}
                        style={{ width: 70 }}
                      />
                      <Button
                        type="primary" size="small"
                        onClick={() => {
                          if (!newTestCase.expected.trim()) { message.warning('请输入期望输出'); return }
                          setCreateForm({
                            ...createForm,
                            test_cases: [...createForm.test_cases, { ...newTestCase, is_sample: createForm.test_cases.length < 2 }],
                          })
                          setNewTestCase({ input: '', expected: '', description: '', score: 1, is_sample: false })
                        }}
                      >
                        添加
                      </Button>
                    </Space>
                  </Space>
                </Card>

                {/* 测试用例列表 */}
                {createForm.test_cases.length === 0 ? (
                  <Text type="secondary">暂无测试用例，请至少添加一个</Text>
                ) : (
                  <Table
                    size="small"
                    dataSource={createForm.test_cases}
                    rowKey={(_, i) => String(i)}
                    pagination={false}
                    columns={[
                      { title: '#', render: (_: any, __: any, i: number) => i + 1, width: 40 },
                      { title: '输入', dataIndex: 'input', render: (v: string) => <code>{v || '(空)'}</code> },
                      { title: '期望输出', dataIndex: 'expected', render: (v: string) => <code>{v}</code> },
                      { title: '说明', dataIndex: 'description' },
                      { title: '分值', dataIndex: 'score', width: 60 },
                      { title: '示例', dataIndex: 'is_sample', render: (v: boolean) => v ? <Tag color="blue">示例</Tag> : null, width: 60 },
                      { title: '操作', width: 60, render: (_: any, __: any, i: number) => (
                        <Button type="link" danger size="small" onClick={() => {
                          setCreateForm({
                            ...createForm,
                            test_cases: createForm.test_cases.filter((_, idx) => idx !== i),
                          })
                        }}>删除</Button>
                      )},
                    ]}
                  />
                )}
              </>
            ),
          },
          {
            key: 'scope',
            label: '目标范围',
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
        title="AI 生成代码题"
        open={aiGenModal}
        onCancel={() => { setAiGenModal(false); setAiGenResult(null) }}
        footer={null}
        width={500}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text>输入一个主题，AI 会自动生成完整的代码题目（含描述、模板、测试用例）。</Text>
          <Space>
            <Input
              placeholder="例如：冒泡排序、判断回文数、两数之和"
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
              生成
            </Button>
          </Space>

          {aiGenResult && (
            <Alert
              type="success"
              showIcon
              message="AI 生成完成"
              description={
                <div>
                  <Text strong>标题：</Text>{aiGenResult.title}<br />
                  <Text strong>知识点：</Text>{aiGenResult.knowledge_points}<br />
                  <Text strong>测试用例：</Text>{aiGenResult.test_cases?.length || 0} 个
                </div>
              }
              action={
                <Button size="small" type="primary" onClick={() => {
                  setAiGenModal(false)
                  setAiGenResult(null)
                  message.success('内容已填入创建表单，请确认后保存')
                }}>
                  确认并编辑
                </Button>
              }
              style={{ marginTop: 8 }}
            />
          )}
        </Space>
      </Modal>

      {/* ── 编辑题目弹窗 ── */}
      <Modal
        title="编辑代码题"
        open={editModalOpen}
        onCancel={() => setEditModalOpen(false)}
        onOk={handleSaveEdit}
        confirmLoading={editLoading}
        width={800}
        okText="保存修改"
      >
        <Tabs items={[
          {
            key: 'basic',
            label: '基本信息',
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Input placeholder="题目标题" value={editForm.title}
                  onChange={e => setEditForm({ ...editForm, title: e.target.value })} />
                <Input.TextArea rows={4} placeholder="题目描述（支持 Markdown）" value={editForm.description}
                  onChange={e => setEditForm({ ...editForm, description: e.target.value })} />
                <Space>
                  <Select value={editForm.subject} onChange={v => setEditForm({ ...editForm, subject: v })}
                    style={{ width: 140 }}
                    options={subjectOptions.map(s => ({ value: s, label: s }))} />
                  <Select value={editForm.difficulty} onChange={v => setEditForm({ ...editForm, difficulty: v })}
                    style={{ width: 100 }}
                    options={[{ value: 'easy', label: '简单' }, { value: 'medium', label: '中等' }, { value: 'hard', label: '困难' }]} />
                  <Select value={editForm.language} onChange={v => setEditForm({ ...editForm, language: v })}
                    style={{ width: 120 }}
                    options={supportedLangs.length > 0 ? supportedLangs : [{ value: 'python', label: 'Python', available: true }]} />
                  <Input placeholder="知识点标签（逗号分隔）" value={editForm.knowledge_points}
                    onChange={e => setEditForm({ ...editForm, knowledge_points: e.target.value })} style={{ width: 200 }} />
                </Space>
              </Space>
            ),
          },
          {
            key: 'code',
            label: '代码模板',
            children: (
              <>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>学生编写代码时的初始模板</Text>
                <Input.TextArea rows={12} value={editForm.template_code}
                  onChange={e => setEditForm({ ...editForm, template_code: e.target.value })}
                  style={{ fontFamily: 'monospace', fontSize: 13 }} />
              </>
            ),
          },
          {
            key: 'cases',
            label: <span>测试用例 <Tag style={{ marginLeft: 4 }}>{editTestCases.length}</Tag></span>,
            children: (
              <>
                {editTestCases.length === 0 ? (
                  <Text type="secondary">暂无测试用例数据</Text>
                ) : (
                  <Table size="small" dataSource={editTestCases} rowKey={(_, i) => String(i)} pagination={false}
                    columns={[
                      { title: '#', render: (_: any, __: any, i: number) => i + 1, width: 40 },
                      { title: '输入', dataIndex: 'input', render: (v: string) => <code>{v || '(空)'}</code> },
                      { title: '期望输出', dataIndex: 'expected', render: (v: string) => <code>{v}</code> },
                      { title: '说明', dataIndex: 'description' },
                      { title: '分值', dataIndex: 'score', width: 60 },
                      { title: '示例', dataIndex: 'is_sample', render: (v: boolean) => v ? <Tag color="blue">示例</Tag> : null, width: 60 },
                    ]}
                  />
                )}
                <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                  💡 测试用例管理将在后续版本中支持在线编辑
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
            <Button icon={<ArrowLeftOutlined />} onClick={handleBack} size="small">返回</Button>
            <Title level={5} style={{ margin: 0 }}>{currentProblem.title}</Title>
            <Tag color={currentProblem.difficulty === 'easy' ? 'green' : currentProblem.difficulty === 'hard' ? 'red' : 'orange'}>
              {currentProblem.difficulty === 'easy' ? '简单' : currentProblem.difficulty === 'hard' ? '困难' : '中等'}
            </Tag>
          </Space>

          <div className="markdown-content" style={{ fontSize: 14, lineHeight: 1.7 }}>
            <ReactMarkdown>{currentProblem.description || ''}</ReactMarkdown>
          </div>

          {/* 示例测试用例 */}
          {currentProblem.sample_cases?.length > 0 && (
            <>
              <Divider>示例测试用例</Divider>
              {currentProblem.sample_cases.map((sc: any, i: number) => (
                <Card key={sc.id} size="small" style={{ marginBottom: 8 }}>
                  <Text strong>示例 {i + 1}</Text>
                  {sc.description && <Text type="secondary"> — {sc.description}</Text>}
                  <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4, marginTop: 4, fontSize: 12 }}>
                    <Text strong>输入：</Text>{sc.input || '(无)'}{'\n'}
                    <Text strong>输出：</Text>{sc.expected_output}
                  </pre>
                </Card>
              ))}
            </>
          )}

          {/* 提交历史 */}
          <Divider>
            <Space>
              <HistoryOutlined />
              <span>提交历史</span>
            </Space>
          </Divider>
          <Spin spinning={submissionsLoading}>
            {submissions.length === 0 ? (
              <Text type="secondary">暂无提交记录</Text>
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
                        <Tag color={st?.color}>{st?.icon} {st?.label || s.status}</Tag>
                        <Text type="secondary" style={{ fontSize: 12 }}>{s.score}分</Text>
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
              运行一下
            </Button>
            <Button
              type="primary"
              ghost
              icon={<SendOutlined />}
              onClick={handleSubmit}
              loading={submitLoading || pollingSubmission}
            >
              {pollingSubmission ? '评分中...' : '提交评分'}
            </Button>
            {isTeacherOrAdmin && (
              <Button
                icon={<RobotOutlined />}
                onClick={handleAiReview}
                loading={aiReviewLoading}
                disabled={!submissionResult}
              >
                AI 审查
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
            <Text type="secondary" style={{ fontSize: 12 }}>自定义输入（可选）：</Text>
            <TextArea
              rows={2}
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              placeholder="输入程序的标准输入数据..."
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
                  label: <span><PlayCircleOutlined /> 运行输出</span>,
                  children: (
                    <div style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 12, borderRadius: 6, fontFamily: 'monospace', fontSize: 13, maxHeight: 300, overflow: 'auto' }}>
                      {runResult.error ? (
                        <div style={{ color: '#f48771' }}>
                          <div>⚠ 错误：{runResult.error}</div>
                          {runResult.stderr && <pre style={{ margin: 0, color: '#f48771' }}>{runResult.stderr}</pre>}
                        </div>
                      ) : (
                        <>
                          <div style={{ color: '#888', marginBottom: 4 }}>Exit Code: {runResult.exit_code} | Time: {runResult.execution_time}s</div>
                          {runResult.stdout ? (
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{runResult.stdout}</pre>
                          ) : (
                            <div style={{ color: '#888' }}>（无输出）</div>
                          )}
                          {runResult.stderr && <pre style={{ margin: 0, color: '#f48771', marginTop: 8 }}>{runResult.stderr}</pre>}
                        </>
                      )}
                    </div>
                  ),
                }] : []),
                ...(submissionResult ? [{
                  key: 'result',
                  label: <span><BarChartOutlined /> 评分结果</span>,
                  children: (
                    <div>
                      <Row gutter={16} style={{ marginBottom: 12 }}>
                        <Col span={6}>
                          <Statistic
                            title="状态"
                            value={statusInfo?.label || submissionResult.status}
                            valueStyle={{ fontSize: 16, color: statusInfo?.color === 'success' ? '#52c41a' : '#ff4d4f' }}
                          />
                        </Col>
                        <Col span={6}>
                          <Statistic title="得分" value={submissionResult.score} suffix={`/ ${submissionResult.total_cases}`} valueStyle={{ fontSize: 16 }} />
                        </Col>
                        <Col span={6}>
                          <Statistic title="通过用例" value={`${submissionResult.passed_cases || 0} / ${submissionResult.total_cases || 0}`} valueStyle={{ fontSize: 16 }} />
                        </Col>
                        <Col span={6}>
                          <Statistic title="运行时间" value={submissionResult.execution_time || 0} suffix="s" valueStyle={{ fontSize: 16 }} />
                        </Col>
                      </Row>

                      {/* 测试用例详情 */}
                      {submissionResult.details?.length > 0 && (
                        <>
                          <Divider>测试用例详情</Divider>
                          <Table
                            size="small"
                            dataSource={submissionResult.details}
                            rowKey="case_id"
                            pagination={false}
                            columns={[
                              { title: '用例', dataIndex: 'description', render: (v: string, r: any) => v || (r.is_sample ? '示例' : `测试 #${r.case_id}`) },
                              { title: '输入', dataIndex: 'input', render: (v: string) => <code style={{ fontSize: 12 }}>{(v || '(空)').slice(0, 50)}</code> },
                              { title: '期望输出', dataIndex: 'expected', render: (v: string) => <code style={{ fontSize: 12 }}>{v.slice(0, 80)}</code> },
                              { title: '实际输出', dataIndex: 'actual', render: (v: string, r: any) => (
                                <span style={{ color: r.is_pass ? '#52c41a' : '#ff4d4f' }}>
                                  <code style={{ fontSize: 12 }}>{v ? v.slice(0, 80) : '(空)'}</code>
                                </span>
                              )},
                              { title: '结果', dataIndex: 'is_pass', render: (v: boolean) => v ? <Tag color="success">通过</Tag> : <Tag color="error">失败</Tag> },
                              { title: '得分', dataIndex: 'score', render: (v: number) => v || 0 },
                            ]}
                          />
                        </>
                      )}
                    </div>
                  ),
                }] : []),
                ...(aiReview ? [{
                  key: 'review',
                  label: <span><RobotOutlined /> AI 审查</span>,
                  children: (
                    <div>
                      <Row gutter={16} style={{ marginBottom: 12 }}>
                        <Col span={6}>
                          <Statistic title="综合评分" value={aiReview.overall_score} suffix="/100" valueStyle={{ fontSize: 16 }} />
                        </Col>
                        <Col span={6}>
                          <Statistic title="评价" value={aiReview.overall_rating} valueStyle={{ fontSize: 16 }} />
                        </Col>
                      </Row>

                      <Descriptions column={2} size="small" bordered style={{ marginBottom: 12 }}>
                        {aiReview.dimensions?.correctness && (
                          <Descriptions.Item label="正确性" span={1}>
                            <Progress percent={aiReview.dimensions.correctness.score} size="small" />
                          </Descriptions.Item>
                        )}
                        {aiReview.dimensions?.code_quality && (
                          <Descriptions.Item label="代码质量" span={1}>
                            <Progress percent={aiReview.dimensions.code_quality.score} size="small" />
                          </Descriptions.Item>
                        )}
                        {aiReview.dimensions?.efficiency && (
                          <Descriptions.Item label="算法效率" span={1}>
                            <Progress percent={aiReview.dimensions.efficiency.score} size="small" />
                          </Descriptions.Item>
                        )}
                        {aiReview.dimensions?.style && (
                          <Descriptions.Item label="编码规范" span={1}>
                            <Progress percent={aiReview.dimensions.style.score} size="small" />
                          </Descriptions.Item>
                        )}
                      </Descriptions>

                      {/* 优点 */}
                      {aiReview.strengths?.length > 0 && (
                        <>
                          <Text strong style={{ color: '#52c41a' }}>✅ 优点</Text>
                          <ul style={{ margin: '4px 0 12px' }}>
                            {aiReview.strengths.map((s: string, i: number) => <li key={i}><Text>{s}</Text></li>)}
                          </ul>
                        </>
                      )}

                      {/* 不足 */}
                      {aiReview.weaknesses?.length > 0 && (
                        <>
                          <Text strong style={{ color: '#ff4d4f' }}>❌ 待改进</Text>
                          <ul style={{ margin: '4px 0 12px' }}>
                            {aiReview.weaknesses.map((w: string, i: number) => <li key={i}><Text>{w}</Text></li>)}
                          </ul>
                        </>
                      )}

                      {/* 改进建议 */}
                      {aiReview.suggestions?.length > 0 && (
                        <>
                          <Text strong style={{ color: '#1677ff' }}>💡 改进建议</Text>
                          <ul style={{ margin: '4px 0 12px' }}>
                            {aiReview.suggestions.map((s: string, i: number) => <li key={i}><Text>{s}</Text></li>)}
                          </ul>
                        </>
                      )}

                      {/* 改进代码 */}
                      {aiReview.improved_code && (
                        <>
                          <Divider>改进参考</Divider>
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

  // ── 主渲染 ──
  return (
    <div style={{ padding: inTab ? 0 : 24, height: '100%' }}>
      {currentProblem ? renderCodeEditor() : renderProblemList()}
    </div>
  )
}

export default CodePracticePage
