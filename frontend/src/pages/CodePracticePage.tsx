import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Typography, Button, Space, Tag, Modal, Spin, message, Tabs, Empty, Select,
  Table, Descriptions, Input, Alert, InputNumber, Pagination, Grid, Switch, Tooltip,
  Row, Col, Statistic, Segmented, Progress,
} from 'antd'
import {
  PlayCircleOutlined, RobotOutlined, FileTextOutlined, BarChartOutlined,
  EditOutlined, DeleteOutlined, PlusSquareOutlined, MinusSquareOutlined,
  DownloadOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import KnowledgePointSelect, { splitKps, joinKps } from '../components/KnowledgePointSelect'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import ResetActivityButton from '../components/ResetActivityButton'
import ScopeTag from '../components/ScopeTag'
import CodeWorkspace, { DiffBlock } from '../components/code/CodeWorkspace'
import TestCaseEditor from '../components/code/TestCaseEditor'
import { type EditableTestCase } from '../components/code/constants'
import { STATUS_MAP } from '../components/code/constants'

/** 分数换算成百分制：满分跟着用例走（1 分制、10 分制都可能），原始分只放在 title 里 */
function toPercent(score: any, maxScore: any): number | null {
  const sc = Number(score) || 0;
  const mx = Number(maxScore) || 0;
  if (mx <= 0) return null;   // 老数据没有 max_score，别除零
  return Math.round((sc / mx) * 1000) / 10;
}
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

interface CreateFormState {
  title: string
  description: string
  subject: string
  knowledge_points: string
  difficulty: string
  language: string
  template_code: string
  reference_solution: string
  time_limit: number
  status: string
  target_scope: string
  target_grade: string
  target_class: string
  target_users: string
  test_cases: EditableTestCase[]
}

const defaultTemplate = '# 在此编写你的代码\n\ndef solution():\n    pass\n\n\nif __name__ == "__main__":\n    solution()\n'

const emptyCreateForm = (subject = ''): CreateFormState => ({
  title: '',
  description: '',
  subject,
  knowledge_points: '',
  difficulty: 'medium',
  language: 'python',
  template_code: defaultTemplate,
  reference_solution: '',
  time_limit: 5,
  status: 'active',
  target_scope: 'teacher_classes',
  target_grade: '',
  target_class: '',
  target_users: '',
  test_cases: [],
})

const toApiCases = (cases: EditableTestCase[]) => cases.map((c) => ({
  input: c.input || '',
  expected_output: c.expected || '',
  description: c.description || '',
  score: Number(c.score) || 0,
  is_sample: !!c.is_sample,
}))

const fromApiCases = (cases: any[]): EditableTestCase[] => (cases || []).map((c) => ({
  input: c.input || '',
  expected: c.expected_output || '',
  description: c.description || '',
  score: Number(c.score) || 1,
  is_sample: !!c.is_sample,
}))

const CodePracticePage: React.FC = () => {
  const { t } = useTranslation('practice')
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const screens = Grid.useBreakpoint()
  const narrow = !screens.md

  // ── 列表 ──
  const [problemList, setProblemList] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [expandedRowKeys, setExpandedRowKeys] = useState<number[]>([])
  const [currentProblemId, setCurrentProblemId] = useState<number | null>(null)

  // ── 筛选 ──
  const [searchInput, setSearchInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [subjectFilter, setSubjectFilter] = useState('')
  const [difficultyFilter, setDifficultyFilter] = useState('')
  const [myStatusFilter, setMyStatusFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])
  const [supportedLangs, setSupportedLangs] = useState<{ value: string; label: string; available: boolean }[]>([])

  // ── 创建 ──
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [createForm, setCreateForm] = useState<CreateFormState>(emptyCreateForm())

  // ── 编辑 ──
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editLoading, setEditLoading] = useState(false)
  const [editTarget, setEditTarget] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<CreateFormState>(emptyCreateForm())
  const [validating, setValidating] = useState(false)
  const [validateResult, setValidateResult] = useState<any>(null)

  // ── 统计 ──
  const [statsModalOpen, setStatsModalOpen] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsTitle, setStatsTitle] = useState('')
  const [statsProblemId, setStatsProblemId] = useState<number | null>(null)
  const [statsData, setStatsData] = useState<any>(null)
  const [statsTab, setStatsTab] = useState('overview')
  const [rosterFilter, setRosterFilter] = useState<'all' | 'unsubmitted' | 'submitted'>('all')
  const [regrading, setRegrading] = useState(false)
  const [detailCache, setDetailCache] = useState<Record<number, any>>({})
  const [reviewModalOpen, setReviewModalOpen] = useState(false)
  const [reviewModalLoading, setReviewModalLoading] = useState(false)
  const [reviewModalData, setReviewModalData] = useState<any>(null)

  // ── AI 生成 ──
  const [aiGenModal, setAiGenModal] = useState(false)
  const [aiGenTopic, setAiGenTopic] = useState('')
  const [aiGenSubject, setAiGenSubject] = useState('')
  const [aiGenLanguage, setAiGenLanguage] = useState('python')
  const [aiGenDifficulty, setAiGenDifficulty] = useState('medium')
  const [aiGenLoading, setAiGenLoading] = useState(false)
  const [aiGenResult, setAiGenResult] = useState<any>(null)

  // 搜索防抖：输入停下 400ms 再请求，避免每敲一个字打一次接口
  useEffect(() => {
    const timer = setTimeout(() => {
      setKeyword(searchInput.trim())
      setPage(1)
    }, 400)
    return () => clearTimeout(timer)
  }, [searchInput])

  const loadProblems = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/code/problems', {
        params: {
          page,
          page_size: pageSize,
          subject: subjectFilter || undefined,
          difficulty: difficultyFilter || undefined,
          my_status: myStatusFilter || undefined,
          status: statusFilter || undefined,
          keyword: keyword || undefined,
        },
      })
      setProblemList(data.items || [])
      setTotal(data.total || 0)
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, subjectFilter, difficultyFilter, myStatusFilter, statusFilter, keyword, t])

  useEffect(() => {
    loadProblems()
  }, [loadProblems])

  useEffect(() => {
    apiClient.get('/api/code/languages').then(({ data }) => {
      if (data?.languages) setSupportedLangs(data.languages)
    }).catch(() => { /* 语言列表拿不到不影响 Python 题目 */ })
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) {
        setSubjectOptions(data.subjects)
        setAiGenSubject((prev) => prev || data.subjects[0])
        setCreateForm((prev) => ({ ...prev, subject: prev.subject || data.subjects[0] }))
      }
    }).catch(() => { /* ignore */ })
  }, [])

  const resetListFilters = () => {
    setSearchInput('')
    setKeyword('')
    setSubjectFilter('')
    setDifficultyFilter('')
    setMyStatusFilter('')
    setStatusFilter('all')
    setPage(1)
  }


  // ── 创建题目 ──
  const handleCreateProblem = async () => {
    try {
      await doCreateProblem()
    } catch (e: any) {
      // 兜底：这里以前一旦抛异常就整段静默，表现成"点保存没反应"
      message.error(e?.message || t('createFailed'))
    }
  }

  const doCreateProblem = async () => {
    if (!String(createForm.title || '').trim()) { message.warning(t('inputTitle')); return }
    if (createForm.test_cases.length === 0) { message.warning(t('addAtLeastOneTestCase')); return }
    // 用 String() 兜底：字段缺失时 c.input.trim() 会抛 TypeError，异常在事件里被吞掉，
    // 用户只会看到「点了没反应」，很难排查
    const emptyIdx = createForm.test_cases.findIndex((c) =>
      !String(c.input ?? '').trim()
      && !String(c.expected ?? '').trim()
      && !String(c.description ?? '').trim())
    if (emptyIdx >= 0) {
      message.warning(`第 ${emptyIdx + 1} 个测试用例是空的，请填写输入、期望输出或说明`)
      return
    }
    setCreateLoading(true)
    try {
      await apiClient.post('/api/code/problems', {
        ...createForm,
        test_cases: toApiCases(createForm.test_cases),
      })
      message.success(t('createSuccess'))
      setCreateModalOpen(false)
      setCreateForm(emptyCreateForm(subjectOptions[0] || ''))
      loadProblems()
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('createFailed'))
    } finally {
      setCreateLoading(false)
    }
  }

  // ── 打开编辑 ──
  const handleEditProblem = async (problemId: number) => {
    setEditLoading(true)
    try {
      const [{ data: p }, tcRes] = await Promise.all([
        apiClient.get(`/api/code/problems/${problemId}`),
        apiClient.get(`/api/code/problems/${problemId}/test-cases`),
      ])
      setEditTarget(problemId)
      setValidateResult(null)
      setEditForm({
        title: p.title || '',
        description: p.description || '',
        subject: p.subject || '',
        knowledge_points: p.knowledge_points || '',
        difficulty: p.difficulty || 'medium',
        language: p.language || 'python',
        template_code: p.template_code || p.initial_code || '',
        reference_solution: p.reference_solution || '',
        time_limit: p.time_limit || 5,
        status: p.status || 'active',
        target_scope: p.target_scope || 'teacher_classes',
        target_grade: p.target_grade || '',
        target_class: p.target_class || '',
        target_users: p.target_users || '',
        test_cases: fromApiCases(tcRes.data.test_cases),
      })
      setEditModalOpen(true)
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('loadFailed'))
    } finally {
      setEditLoading(false)
    }
  }

  const handleSaveEdit = async () => {
    if (!editTarget) return
    if (!editForm.title.trim()) { message.warning(t('inputTitle')); return }
    if (editForm.test_cases.length === 0) { message.warning(t('addAtLeastOneTestCase')); return }
    setEditLoading(true)
    try {
      const { data } = await apiClient.put(`/api/code/problems/${editTarget}`, {
        ...editForm,
        test_cases: toApiCases(editForm.test_cases),
      })
      message.success(t('updateSuccess'))
      setEditModalOpen(false)
      loadProblems()
      if (data?.needs_regrade) {
        message.info(t('needsRegradeHint'))
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('updateFailed'))
    } finally {
      setEditLoading(false)
    }
  }

  const handleValidateSolution = async (form: CreateFormState) => {
    if (!form.reference_solution.trim()) { message.warning(t('validateNeedsRef')); return }
    if (form.test_cases.length === 0) { message.warning(t('addAtLeastOneTestCase')); return }
    setValidating(true)
    setValidateResult(null)
    try {
      // 用弹窗里的当前用例验证，不依赖是否已保存——创建和编辑走同一条链路
      const { data } = await apiClient.post('/api/code/validate', {
        language: form.language,
        time_limit: form.time_limit,
        source_code: form.reference_solution,
        test_cases: toApiCases(form.test_cases),
      }, { timeout: 70000 })
      setValidateResult(data)
      if (data.all_pass) message.success(t('allCasesPass'))
      else message.warning(t('casesFailed', { count: (data.total || 0) - (data.passed || 0) }))
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('validateFailed'))
    } finally {
      setValidating(false)
    }
  }

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
        } catch (e: any) {
          message.error(e.response?.data?.detail || t('deleteFailed'))
        }
      },
    })
  }

  // ── AI 生成题目 ──
  // 打开 AI 弹窗时对齐创建表单当前的语言/难度/科目，避免两处选择漂移
  const openAiGenModal = () => {
    setAiGenLanguage(createForm.language || 'python')
    setAiGenDifficulty(createForm.difficulty || 'medium')
    setAiGenSubject(createForm.subject || aiGenSubject || subjectOptions[0] || '')
    setAiGenModal(true)
  }

  const handleAiGenerate = async () => {
    if (!aiGenTopic.trim()) { message.warning(t('inputTopic')); return }
    setAiGenLoading(true)
    setAiGenResult(null)
    try {
      const { data } = await apiClient.post('/api/code/ai-generate', {
        topic: aiGenTopic,
        subject: aiGenSubject,
        language: aiGenLanguage,
        difficulty: aiGenDifficulty,
      })
      if (!data.task_id) { message.error(t('aiGenerateFailed')); return }
      message.info(t('aiGeneratingWait'))
      const result = await pollAiTask(data.task_id, 180000)
      if (result?.status === 'ok' && result.data) {
        setAiGenResult(result.data)
        message.success(t('aiGenerateDone'))
      } else {
        message.error(t('aiGenerateFailed'))
      }
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('aiGenerateRequestFailed'))
    } finally {
      setAiGenLoading(false)
    }
  }

  const applyAiGenResult = () => {
    if (!aiGenResult) return
    const d = aiGenResult
    setCreateForm((prev) => ({
      ...prev,
      subject: aiGenSubject || prev.subject,
      language: aiGenLanguage || prev.language,
      difficulty: aiGenDifficulty || prev.difficulty,
      title: d.title || prev.title,
      description: d.description || prev.description,
      knowledge_points: d.knowledge_points || aiGenTopic.trim() || prev.knowledge_points,
      template_code: d.template_code || d.starter_code || prev.template_code,
      reference_solution: d.reference_solution || '',
      time_limit: prev.time_limit,
      test_cases: fromApiCases(d.test_cases || []),
    }))
    setAiGenModal(false)
    setAiGenResult(null)
    setValidateResult(null)
    setCreateModalOpen(true)
    message.success(t('contentFilled'))
  }

  // ── 教师统计 ──
  const openStats = async (problemId: number, title: string) => {
    setStatsProblemId(problemId)
    setStatsTitle(title)
    setStatsData(null)
    setDetailCache({})
    setStatsTab('overview')
    setRosterFilter('all')
    setStatsModalOpen(true)
    setStatsLoading(true)
    try {
      const { data } = await apiClient.get(`/api/code/problems/${problemId}/submissions/detail`)
      setStatsData(data)
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('loadDetailFailed'))
    } finally {
      setStatsLoading(false)
    }
  }

  const loadSubmissionDetail = async (submissionId: number) => {
    if (detailCache[submissionId]) return
    try {
      const { data } = await apiClient.get(`/api/code/submissions/${submissionId}`)
      setDetailCache((prev) => ({ ...prev, [submissionId]: data }))
    } catch {
      message.error(t('loadFailed'))
    }
  }

  const handleRegrade = async () => {
    if (!statsProblemId) return
    setRegrading(true)
    try {
      const { data } = await apiClient.post(`/api/code/problems/${statsProblemId}/regrade`)
      message.success(data?.message || t('regradeDone'))
      // 稍等一两秒再刷新，给后台任务一点落库时间
      setTimeout(() => { openStats(statsProblemId, statsTitle) }, 1500)
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('regradeFailed'))
    } finally {
      setRegrading(false)
    }
  }

  const openAiReview = async (submissionId: number) => {
    setReviewModalOpen(true)
    setReviewModalLoading(true)
    setReviewModalData(null)
    try {
      const { data } = await apiClient.get(`/api/code/submissions/${submissionId}/review`)
      setReviewModalData(data)
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('aiReviewRequestFailed'))
    } finally {
      setReviewModalLoading(false)
    }
  }

  const exportRosterCsv = () => {
    if (!statsData?.roster) return
    const header = ['username', 'name', 'grade', 'class', 'submitted', 'status', 'score', 'max_score', 'passed_cases', 'total_cases', 'submitted_at']
    const lines = [header.join(',')]
    for (const r of statsData.roster) {
      const vals = [
        r.username, r.name, r.grade, r.class,
        r.submitted ? '1' : '0', r.status || '', r.score ?? '', r.max_score ?? '',
        r.passed_cases ?? '', r.total_cases ?? '', r.submitted_at || '',
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`)
      lines.push(vals.join(','))
    }
    const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${statsTitle || 'code'}_roster.csv`
    a.click()
    URL.revokeObjectURL(url)
  }


  const renderSubmissionDetail = (data: any) => {
    if (!data) return <div style={{ padding: 16, textAlign: 'center' }}><Spin /></div>
    return (
      <div style={{ padding: '6px 0' }}>
        <Text strong style={{ fontSize: 13 }}>{t('submittedCode')}</Text>
        <pre style={{
          background: 'var(--code-console-bg, #1e1e1e)', color: 'var(--code-console-fg, #d4d4d4)',
          padding: 10, borderRadius: 6, fontSize: 12, maxHeight: 240, overflow: 'auto', marginTop: 4,
        }}>
          <code>{data.source_code || t('codeNotVisible')}</code>
        </pre>
        {(data.details || []).length > 0 && (
          <>
            <Text strong style={{ fontSize: 13, display: 'block', marginTop: 10 }}>{t('testCaseDetail')}</Text>
            <Table
              size="small"
              dataSource={data.details}
              rowKey={(r: any) => String(r.case_id ?? r.case_index)}
              pagination={false}
              expandable={{
                rowExpandable: (r: any) => !r.is_pass,
                expandedRowRender: (r: any) => (
                  <DiffBlock expected={r.expected || ''} actual={r.actual || ''} error={r.error || ''} />
                ),
              }}
              columns={[
                { title: t('cpColCase'), dataIndex: 'description', render: (v: string, r: any) => v || `#${(r.case_index ?? 0) + 1}` },
                {
                  title: t('testResult'), dataIndex: 'is_pass', width: 80,
                  render: (v: boolean, r: any) => (
                    <Tag color={v ? 'success' : 'error'}>{v ? t('passed') : (r.error ? t('statusRuntimeError') : t('failed'))}</Tag>
                  ),
                },
                { title: t('score'), dataIndex: 'score', width: 60 },
              ]}
            />
          </>
        )}
      </div>
    )
  }

  const renderAiReviewBody = (payload: any) => {
    if (!payload) return null
    if (payload.status !== 'completed' || !payload.review) {
      return (
        <Alert
          type={payload.status === 'failed' ? 'error' : 'info'}
          showIcon
          title={payload.status === 'failed' ? t('aiReviewFailed') : t('aiReviewPending')}
          description={payload.error || undefined}
        />
      )
    }
    const r = payload.review
    return (
      <div>
        <Row gutter={16} style={{ marginBottom: 12 }}>
          <Col span={12}><Statistic title={t('cpOverallScore')} value={r.overall_score} suffix="/100" /></Col>
          <Col span={12}><Statistic title={t('cpRating')} value={r.overall_rating} /></Col>
        </Row>
        {r.strengths?.length > 0 && (
          <>
            <Text strong style={{ color: 'var(--success-color)' }}>{t('strengths')}</Text>
            <ul>{r.strengths.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
          </>
        )}
        {r.weaknesses?.length > 0 && (
          <>
            <Text strong style={{ color: 'var(--error-color)' }}>{t('improvements')}</Text>
            <ul>{r.weaknesses.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
          </>
        )}
        {r.suggestions?.length > 0 && (
          <>
            <Text strong style={{ color: 'var(--primary-color)' }}>{t('suggestions')}</Text>
            <ul>{r.suggestions.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
          </>
        )}
        {r.improved_code && (
          <pre style={{ background: 'var(--bg-layout)', padding: 10, borderRadius: 6, fontSize: 12, overflow: 'auto' }}>
            <code>{r.improved_code}</code>
          </pre>
        )}
      </div>
    )
  }

  // ── 详情页：整页代码工作区 ──
  if (currentProblemId !== null) {
    return (
      <Card style={{ borderRadius: 8, height: '100%' }} styles={{ body: { height: '100%' } }}>
        <div style={{ height: narrow ? 'auto' : 'calc(100vh - 145px)' }}>
          <CodeWorkspace
            problemId={currentProblemId}
            variant="full"
            onBack={() => { setCurrentProblemId(null); loadProblems() }}
            onSubmitted={loadProblems}
          />
        </div>
      </Card>
    )
  }

  const filteredRoster = (statsData?.roster || []).filter((r: any) => {
    if (rosterFilter === 'unsubmitted' && r.submitted) return false
    if (rosterFilter === 'submitted' && !r.submitted) return false
    return true
  })

  const columns: any[] = [
    {
      dataIndex: 'title',
      render: (text: string, record: any) => (
        <Space wrap size={4}>
          <Text strong style={{ cursor: 'pointer', color: 'var(--primary-color)' }}
            onClick={() => setCurrentProblemId(record.problem_id)}>
            {text}
          </Text>
          <Tag color={record.difficulty === 'easy' ? 'green' : record.difficulty === 'hard' ? 'red' : 'orange'}>
            {record.difficulty === 'easy' ? t('easy') : record.difficulty === 'hard' ? t('hard') : t('medium')}
          </Tag>
          {record.status === 'paused' && <Tag>{t('statusPaused')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('subject'), dataIndex: 'subject', width: 100, responsive: ['md'],
      render: (v: string) => v || '-',
    },
    {
      title: t('gradeClass'), key: 'scope', width: 160, responsive: ['lg'],
      render: (_: any, record: any) => (
        <ScopeTag scope={record.target_scope} grade={record.target_grade}
          classes={record.target_class} users={record.target_users} />
      ),
    },
  ]

  if (isTeacherOrAdmin) {
    columns.push({
      title: t('studentProgress'), key: 'stats', width: 160, responsive: ['md'],
      render: (_: any, record: any) => (
        <Space size={4}>
          <Tooltip title={t('submissionCount')}>
            <Tag>{record.total_students || 0}{t('peopleUnit')}</Tag>
          </Tooltip>
          <Tooltip title={t('passRate')}>
            <Tag color={(record.pass_rate || 0) >= 60 ? 'green' : (record.pass_rate || 0) > 0 ? 'orange' : 'default'}>
              {record.pass_rate || 0}%
            </Tag>
          </Tooltip>
        </Space>
      ),
    })
  } else {
    columns.push({
      title: t('myStatus'), key: 'my', width: 140,
      render: (_: any, record: any) => {
        if (!record.my_status) return <Tag>{t('notStarted')}</Tag>
        const st = STATUS_MAP[record.my_status]
        if (record.my_status === 'accepted') {
          return <Tag color="success">{record.my_score ?? 0}/{record.max_score ?? 0}</Tag>
        }
        return <Tag color={st?.color}>{st?.icon} {t(st?.labelKey ?? '') || record.my_status}</Tag>
      },
    })
  }

  columns.push({
    key: 'actions',
    width: isTeacherOrAdmin ? 320 : 100,
    style: { whiteSpace: 'nowrap' },
    render: (_: any, record: any) => (
      <Space size={2} wrap>
        {isTeacherOrAdmin && (
          <>
            <Text type="secondary" style={{ fontSize: 12 }}>{record.creator_name || record.creator_username}</Text>
            <Tag>{record.language?.toUpperCase()}</Tag>
          </>
        )}
        {isTeacherOrAdmin && (
          <Tooltip title={t('viewSubmissionDetails')}>
            <Button type="text" size="small" icon={<BarChartOutlined />}
              onClick={(e) => { e.stopPropagation(); openStats(record.problem_id, record.title) }} />
          </Tooltip>
        )}
        <Button type="link" size="small" icon={<PlayCircleOutlined />}
          onClick={(e) => { e.stopPropagation(); setCurrentProblemId(record.problem_id) }}>
          {t('start')}
        </Button>
        {isTeacherOrAdmin && (
          <>
            <Tooltip title={t('edit')}>
              <Button type="text" size="small" icon={<EditOutlined />}
                onClick={(e) => { e.stopPropagation(); handleEditProblem(record.problem_id) }} />
            </Tooltip>
            <ResetActivityButton activityType="code" activityId={record.problem_id}
              iconOnly stopPropagation onSuccess={loadProblems} />
            <Tooltip title={t('delete')}>
              <Button type="text" size="small" danger icon={<DeleteOutlined />}
                onClick={(e) => { e.stopPropagation(); handleDeleteProblem(record.problem_id) }} />
            </Tooltip>
          </>
        )}
      </Space>
    ),
  })

  const listView = (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Space wrap size={6}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('searchProblems')}
            style={{ width: narrow ? 180 : 220 }}
          />
          <Select
            allowClear
            value={subjectFilter || undefined}
            onChange={(v) => { setSubjectFilter(v || ''); setPage(1) }}
            placeholder={t('selectSubject')}
            style={{ width: 120 }}
            options={subjectOptions.map((s) => ({ value: s, label: s }))}
          />
          <Select
            allowClear
            value={difficultyFilter || undefined}
            onChange={(v) => { setDifficultyFilter(v || ''); setPage(1) }}
            placeholder={t('selectDifficulty')}
            style={{ width: 110 }}
            options={[
              { value: 'easy', label: t('easy') },
              { value: 'medium', label: t('medium') },
              { value: 'hard', label: t('hard') },
            ]}
          />
          {isTeacherOrAdmin && (
            <Select
              value={statusFilter}
              onChange={(v) => { setStatusFilter(v); setPage(1) }}
              style={{ width: 110 }}
              options={[
                { value: 'all', label: t('allStatus') },
                { value: 'active', label: t('statusActive') },
                { value: 'paused', label: t('statusPaused') },
              ]}
            />
          )}
          {!isTeacherOrAdmin && (
            <Select
              allowClear
              value={myStatusFilter || undefined}
              onChange={(v) => { setMyStatusFilter(v || ''); setPage(1) }}
              placeholder={t('myStatus')}
              style={{ width: 120 }}
              options={[
                { value: 'accepted', label: t('filterAccepted') },
                { value: 'unaccepted', label: t('filterUnaccepted') },
                { value: 'untried', label: t('filterUntried') },
              ]}
            />
          )}
          {(searchInput || subjectFilter || difficultyFilter || myStatusFilter || (isTeacherOrAdmin && statusFilter !== 'all')) && (
            <Button size="small" onClick={resetListFilters}>{t('clearFilter')}</Button>
          )}
        </Space>

        {isTeacherOrAdmin && (
          <Space size={6}>
            <Button size="small" icon={<RobotOutlined />} onClick={openAiGenModal}>{t('aiGenerate')}</Button>
            <Button size="small" type="primary" icon={<FileTextOutlined />} onClick={() => { setValidateResult(null); setCreateModalOpen(true) }}>
              {t('createProblem')}
            </Button>
          </Space>
        )}
      </div>

      <Spin spinning={loading}>
        <Table
          dataSource={problemList}
          rowKey="problem_id"
          pagination={false}
          size={narrow ? 'small' : 'middle'}
          showHeader={!narrow}
          scroll={{ x: 'max-content' }}
          expandable={{
            expandedRowRender: (record: any) => (
              <div style={{ padding: '8px 0' }}>
                <CodeWorkspace problemId={record.problem_id} onSubmitted={loadProblems} />
              </div>
            ),
            rowExpandable: () => true,
            expandedRowKeys,
            onExpand: (expanded, record) => setExpandedRowKeys(expanded ? [record.problem_id] : []),
            expandIcon: ({ expanded, onExpand, record }: any) => (
              <Button
                type="text"
                size="small"
                icon={expanded ? <MinusSquareOutlined /> : <PlusSquareOutlined />}
                onClick={(e) => { e.stopPropagation(); onExpand(record, e) }}
                style={{ marginRight: 6 }}
              />
            ),
          }}
          columns={columns}
          locale={{ emptyText: <Empty description={isTeacherOrAdmin ? t('noProblemsHint') : t('noProblems')} /> }}
        />
      </Spin>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Pagination
          current={page}
          total={total}
          pageSize={pageSize}
          onChange={(p, size) => {
            setPage(p)
            if (size && size !== pageSize) setPageSize(size)
            setExpandedRowKeys([])
          }}
          onShowSizeChange={(_p, size) => { setPageSize(size); setPage(1) }}
          showSizeChanger
          pageSizeOptions={['5', '10', '20', '50']}
          showTotal={(count) => t('totalProblems', { count })}
          hideOnSinglePage={false}
        />
      </div>
    </>
  )


  // ── 教师统计弹窗 ──
  const statsModal = (
    <Modal
      title={t('submissionDetailTitle', { title: statsTitle })}
      open={statsModalOpen}
      onCancel={() => setStatsModalOpen(false)}
      footer={null}
      width={narrow ? '96%' : 1000}
    >
      <Spin spinning={statsLoading}>
        {statsData ? (
          <>
            <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
              <Col xs={12} sm={6}>
                <Statistic title={t('targetStudents')} value={statsData.summary?.target_count ?? 0} />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic title={t('submittedStudents')} value={statsData.summary?.submitted_count ?? 0} />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic title={t('passRate')} value={statsData.summary?.pass_rate ?? 0} suffix="%" />
              </Col>
              <Col xs={12} sm={6}>
                {/* 主数字用百分制：满分跟着用例走（可能是 1 分也可能是 10 分），
                    只显示原始分的话，和旁边的通过率不是一个口径，容易误读 */}
                <Statistic
                  title={t('avgScore')}
                  value={statsData.summary?.avg_percent ?? '—'}
                  precision={statsData.summary?.avg_percent == null ? 0 : 1}
                  suffix={statsData.summary?.avg_percent == null ? undefined : '/100'}
                />
                {(statsData.summary?.max_score ?? 0) > 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: -4 }}>
                    {statsData.summary?.avg_score ?? 0} / {statsData.summary.max_score}
                  </div>
                ) : null}
              </Col>
            </Row>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
              <Button size="small" icon={<DownloadOutlined />} onClick={exportRosterCsv}>{t('exportRoster')}</Button>
              <Button size="small" icon={<ReloadOutlined />} loading={regrading} onClick={handleRegrade}>
                {t('regrade')}
              </Button>
            </div>

            <Tabs
              size="small"
              activeKey={statsTab}
              onChange={setStatsTab}
              items={[
                {
                  key: 'overview',
                  label: t('tabOverview'),
                  children: (
                    <div>
                      <Descriptions size="small" bordered column={narrow ? 1 : 2} style={{ marginBottom: 12 }}>
                        <Descriptions.Item label={t('targetStudents')}>{statsData.summary?.target_count ?? 0}</Descriptions.Item>
                        <Descriptions.Item label={t('submittedStudents')}>{statsData.summary?.submitted_count ?? 0}</Descriptions.Item>
                        <Descriptions.Item label={t('acceptedStudents')}>{statsData.summary?.accepted_count ?? 0}</Descriptions.Item>
                        <Descriptions.Item label={t('passRate')}>{statsData.summary?.pass_rate ?? 0}%</Descriptions.Item>
                      </Descriptions>
                      <Text strong style={{ fontSize: 13 }}>{t('caseStats')}</Text>
                      {(statsData.case_stats || []).length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('noData')} />
                      ) : (
                        <Table
                          size="small"
                          style={{ marginTop: 6 }}
                          dataSource={statsData.case_stats}
                          rowKey="case_id"
                          pagination={false}
                          columns={[
                            { title: '#', dataIndex: 'case_id', width: 50 },
                            {
                              title: t('description'), dataIndex: 'description',
                              render: (v: string, r: any) => v || (r.is_sample ? t('cpSampleTag') : t('cpCasePrefix')),
                            },
                            { title: t('score'), dataIndex: 'score', width: 60 },
                            {
                              title: t('passRate'), key: 'rate', width: 180,
                              render: (_: any, r: any) => (
                                <Progress percent={r.pass_rate || 0} size="small" />
                              ),
                            },
                            {
                              title: t('passedCount'), key: 'count', width: 100,
                              render: (_: any, r: any) => `${r.passed || 0}/${r.judged || 0}`,
                            },
                          ]}
                        />
                      )}
                    </div>
                  ),
                },
                {
                  key: 'submissions',
                  label: t('submitted'),
                  children: (
                    <Table
                      size="small"
                      dataSource={statsData.submissions || []}
                      rowKey="id"
                      pagination={{ pageSize: 10, showSizeChanger: false }}
                      scroll={{ x: 'max-content' }}
                      expandable={{
                        onExpand: (expanded, record: any) => { if (expanded) loadSubmissionDetail(record.id) },
                        expandedRowRender: (record: any) => renderSubmissionDetail(detailCache[record.id]),
                      }}
                      columns={[
                        { title: t('studentName'), dataIndex: 'student_name', width: 90 },
                        { title: t('studentId'), dataIndex: 'student_username', width: 100, ellipsis: true },
                        { title: t('studentClass'), dataIndex: 'student_class', width: 90, responsive: ['md'] },
                        {
                          title: t('status'), dataIndex: 'status', width: 110,
                          render: (v: string) => {
                            const st = STATUS_MAP[v]
                            return <Tag color={st?.color}>{st?.icon} {t(st?.labelKey ?? '') || v}</Tag>
                          },
                        },
                        {
                          title: t('score'), key: 'score', width: 80,
                          render: (_: any, r: any) => {
                            const pct = toPercent(r.score, r.max_score);
                            const raw = `${r.score ?? 0} / ${r.max_score ?? 0}`;
                            return pct === null ? <span title={raw}>—</span> : <span title={raw}>{pct}</span>;
                          },
                        },
                        { title: t('passedCases'), key: 'passed', width: 80, render: (_: any, r: any) => `${r.passed_cases || 0}/${r.total_cases || 0}` },
                        { title: t('runTime'), dataIndex: 'execution_time', width: 70, render: (v: number) => v ? `${v}s` : '-' },
                        { title: t('submitTime'), dataIndex: 'created_at', width: 110, render: (v: string) => v?.slice(5, 16) || '' },
                        {
                          title: 'AI', key: 'ai', width: 70,
                          render: (_: any, r: any) => (
                            <Button type="link" size="small" disabled={r.ai_review_status !== 'completed'}
                              onClick={() => openAiReview(r.id)}>
                              {t('view')}
                            </Button>
                          ),
                        },
                      ]}
                    />
                  ),
                },
                {
                  key: 'roster',
                  label: t('tabRoster'),
                  children: (
                    <div>
                      <div style={{ marginBottom: 8 }}>
                        <Segmented
                          size="small"
                          value={rosterFilter}
                          onChange={(v) => setRosterFilter(v as any)}
                          options={[
                            { value: 'all', label: `${t('all')} (${(statsData.roster || []).length})` },
                            { value: 'unsubmitted', label: `${t('unsubmitted')} (${(statsData.roster || []).filter((r: any) => !r.submitted).length})` },
                            { value: 'submitted', label: `${t('submitted')} (${(statsData.roster || []).filter((r: any) => r.submitted).length})` },
                          ]}
                        />
                      </div>
                      <Table
                        size="small"
                        dataSource={filteredRoster}
                        rowKey="username"
                        pagination={{ pageSize: 15, showSizeChanger: false }}
                        scroll={{ x: 'max-content' }}
                        columns={[
                          { title: t('studentName'), dataIndex: 'name', width: 100 },
                          { title: t('studentId'), dataIndex: 'username', width: 110 },
                          { title: t('studentClass'), dataIndex: 'class', width: 90, render: (v: string) => v || '-' },
                          {
                            title: t('submitted'), dataIndex: 'submitted', width: 90,
                            render: (v: boolean) => v ? <Tag color="success">{t('submitted')}</Tag> : <Tag color="default">{t('unsubmitted')}</Tag>,
                          },
                          {
                            title: t('status'), dataIndex: 'status', width: 110,
                            render: (v: string) => {
                              if (!v) return '-'
                              const st = STATUS_MAP[v]
                              return <Tag color={st?.color}>{st ? t(st.labelKey) : v}</Tag>
                            },
                          },
                          {
                            title: t('score'), key: 'score', width: 80,
                            render: (_: any, r: any) => {
                              if (!r.submitted) return '-';
                              const pct = toPercent(r.score, r.max_score);
                              const raw = `${r.score ?? 0} / ${r.max_score ?? 0}`;
                              return pct === null ? <span title={raw}>—</span> : <span title={raw}>{pct}</span>;
                            },
                          },
                          { title: t('submitTime'), dataIndex: 'submitted_at', width: 120, render: (v: string) => v?.slice(5, 16) || '' },
                        ]}
                      />
                    </div>
                  ),
                },
              ]}
            />
          </>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('noStudentSubmissions')} />
        )}
      </Spin>
    </Modal>
  )

  // ── 创建 / 编辑共用字段 ──
  const renderFormTabs = (form: CreateFormState, setForm: React.Dispatch<React.SetStateAction<CreateFormState>>) => (
    <Tabs items={[
      {
        key: 'basic',
        label: t('basicInfo'),
        children: (
          <Space orientation="vertical" style={{ width: '100%' }}>
            <Input
              placeholder={t('problemTitlePlaceholder')}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
            <Input.TextArea
              rows={5}
              placeholder={t('problemDescriptionPlaceholder')}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <Space wrap>
              <Select
                value={form.subject || undefined}
                onChange={(v) => setForm({ ...form, subject: v })}
                style={{ width: 140 }}
                placeholder={t('selectSubject')}
                options={subjectOptions.map((s) => ({ value: s, label: s }))}
              />
              <Select
                value={form.difficulty}
                onChange={(v) => setForm({ ...form, difficulty: v })}
                style={{ width: 100 }}
                options={[
                  { value: 'easy', label: t('easy') },
                  { value: 'medium', label: t('medium') },
                  { value: 'hard', label: t('hard') },
                ]}
              />
              <Select
                value={form.language}
                onChange={(v) => setForm({ ...form, language: v })}
                style={{ width: 120 }}
                options={supportedLangs.length > 0 ? supportedLangs : [{ value: 'python', label: 'Python', available: true }]}
              />
              <InputNumber
                min={1}
                max={60}
                value={form.time_limit}
                onChange={(v) => setForm({ ...form, time_limit: Number(v) || 5 })}
                addonAfter={t('timeLimitLabel')}
                style={{ width: 160 }}
              />
              <Space size={4}>
                <Switch
                  checked={form.status === 'active'}
                  onChange={(checked) => setForm({ ...form, status: checked ? 'active' : 'paused' })}
                />
                <Text type="secondary">{form.status === 'active' ? t('statusActive') : t('statusPaused')}</Text>
              </Space>
            </Space>
            <KnowledgePointSelect
              subject={form.subject}
              style={{ width: 260 }}
              value={splitKps(form.knowledge_points)}
              onChange={(v) => setForm({ ...form, knowledge_points: joinKps(v as string[]) })}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>{t('problemDescHint')}</Text>
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
              rows={14}
              value={form.template_code}
              onChange={(e) => setForm({ ...form, template_code: e.target.value })}
              style={{ fontFamily: 'Consolas, "Courier New", monospace', fontSize: 13 }}
            />
          </>
        ),
      },
      {
        key: 'cases',
        label: <span>{t('testCases')} <Tag style={{ marginLeft: 4 }}>{form.test_cases.length}</Tag></span>,
        children: (
          <TestCaseEditor
            value={form.test_cases}
            onChange={(cases) => setForm({ ...form, test_cases: cases })}
          />
        ),
      },
      {
        key: 'reference',
        label: t('referenceSolution'),
        children: (
          <>
            <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('referenceSolutionHint')}</Text>
            <Input.TextArea
              rows={12}
              value={form.reference_solution}
              onChange={(e) => setForm({ ...form, reference_solution: e.target.value })}
              style={{ fontFamily: 'Consolas, "Courier New", monospace', fontSize: 13 }}
            />
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Button type="primary" icon={<PlayCircleOutlined />} loading={validating}
                onClick={() => handleValidateSolution(form)}>
                {t('validateSolution')}
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('validateHint')}</Text>
            </div>
            {validateResult && (
              <div style={{ marginTop: 10 }}>
                <Alert
                  type={validateResult.all_pass ? 'success' : 'warning'}
                  showIcon
                  title={validateResult.all_pass
                    ? t('allCasesPass')
                    : t('validateSummary', { passed: validateResult.passed, total: validateResult.total })}
                  style={{ marginBottom: 8 }}
                />
                <Table
                  size="small"
                  dataSource={validateResult.details || []}
                  rowKey={(r: any) => String(r.case_id ?? r.case_index)}
                  pagination={false}
                  expandable={{
                    rowExpandable: (r: any) => !r.is_pass,
                    expandedRowRender: (r: any) => (
                      <DiffBlock expected={r.expected || ''} actual={r.actual || ''} error={r.error || ''} />
                    ),
                  }}
                  columns={[
                    { title: t('cpColCase'), dataIndex: 'description', render: (v: string, r: any) => v || `#${(r.case_index ?? 0) + 1}` },
                    {
                      title: t('testResult'), dataIndex: 'is_pass', width: 90,
                      render: (v: boolean) => (
                        <Tag color={v ? 'success' : 'error'}>{v ? t('passed') : t('failed')}</Tag>
                      ),
                    },
                    { title: t('score'), dataIndex: 'score', width: 70 },
                  ]}
                />
              </div>
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
                target_scope: (form.target_scope || 'teacher_classes') as any,
                target_grade: form.target_grade || '',
                target_class: form.target_class || '',
                target_users: form.target_users || '',
              }}
              onChange={(val) => setForm({
                ...form,
                target_scope: val.target_scope,
                target_grade: val.target_grade,
                target_class: val.target_class,
                target_users: val.target_users,
              })}
              showAllOption={user?.role === 'admin'}
            />
          </div>
        ),
      },
    ]} />
  )


  return (
    <Card style={{ borderRadius: 8, height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>{t('codePractice')}</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>{t('codePracticeIntro')}</Text>
        </div>
      </div>

      {listView}

      {/* ── 创建题目 ── */}
      <Modal
        maskClosable={false}
        title={t('createCodeProblem')}
        open={createModalOpen}
        onCancel={() => setCreateModalOpen(false)}
        onOk={handleCreateProblem}
        confirmLoading={createLoading}
        width={narrow ? '96%' : 860}
        okText={t('saveProblem')}
        destroyOnHidden
      >
        {renderFormTabs(createForm, setCreateForm)}
      </Modal>

      {/* ── 编辑题目 ── */}
      <Modal
        maskClosable={false}
        title={t('cpEditTitle')}
        open={editModalOpen}
        onCancel={() => setEditModalOpen(false)}
        onOk={handleSaveEdit}
        confirmLoading={editLoading}
        width={narrow ? '96%' : 860}
        okText={t('cpSaveChanges')}
        destroyOnHidden
      >
        {renderFormTabs(editForm, setEditForm)}
      </Modal>

      {/* ── AI 生成 ── */}
      <Modal
        maskClosable={false}
        title={t('aiGenerateCodeProblem')}
        open={aiGenModal}
        onCancel={() => { setAiGenModal(false); setAiGenResult(null) }}
        footer={null}
        width={narrow ? '96%' : 560}
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Text>{t('aiGenerateDesc')}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('aiApplyHint')}</Text>
          <Space wrap>
            <KnowledgePointSelect
              multiple={false}
              subject={aiGenSubject}
              value={aiGenTopic}
              onChange={(v) => setAiGenTopic(String(v || ''))}
              placeholder={t('aiGenTopicPlaceholder')}
              style={{ width: 280 }}
            />
            <Select
              value={aiGenSubject}
              onChange={setAiGenSubject}
              style={{ width: 120 }}
              options={subjectOptions.map((s) => ({ value: s, label: s }))}
            />
          </Space>
          <Space wrap>
            <Select
              value={aiGenLanguage}
              onChange={setAiGenLanguage}
              style={{ width: 130 }}
              options={supportedLangs.length > 0 ? supportedLangs : [{ value: 'python', label: 'Python', available: true }]}
            />
            <Select
              value={aiGenDifficulty}
              onChange={setAiGenDifficulty}
              style={{ width: 110 }}
              options={[
                { value: 'easy', label: t('easy') },
                { value: 'medium', label: t('medium') },
                { value: 'hard', label: t('hard') },
              ]}
            />
            <Button type="primary" onClick={handleAiGenerate} loading={aiGenLoading}>
              {t('generate')}
            </Button>
          </Space>

          {aiGenResult && (
            <Alert
              type="success"
              showIcon
              title={t('aiGenerateComplete')}
              description={(
                <div>
                  <Text strong>{t('title')}：</Text>{aiGenResult.title}<br />
                  <Text strong>{t('knowledgePoints')}：</Text>{aiGenResult.knowledge_points || '-'}<br />
                  <Text strong>{t('testCases')}：</Text>{t('countCases', { count: aiGenResult.test_cases?.length || 0 })}<br />
                  <Text strong>{t('referenceSolution')}：</Text>
                  {aiGenResult.reference_solution ? t('hasReferenceSolution') : t('noReferenceSolution')}
                </div>
              )}
              action={(
                <Button size="small" type="primary" onClick={applyAiGenResult}>
                  {t('cpConfirmEdit')}
                </Button>
              )}
              style={{ marginTop: 8 }}
            />
          )}
        </Space>
      </Modal>

      {/* ── 教师统计 ── */}
      {statsModal}

      {/* ── AI 审查详情 ── */}
      <Modal
        title={t('aiReview')}
        open={reviewModalOpen}
        onCancel={() => setReviewModalOpen(false)}
        footer={null}
        width={narrow ? '96%' : 720}
      >
        <Spin spinning={reviewModalLoading}>
          {renderAiReviewBody(reviewModalData)}
        </Spin>
      </Modal>
    </Card>
  )
}

export default CodePracticePage
