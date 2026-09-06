/**
 * QuestAdminPage — 教师端闯关管理
 * 包含两个标签页：
 *   1. 闯关记录 — 查看学生闯关记录
 *   2. 题库管理 — 闯关题目的 CRUD 管理
 */
import { studentLabel } from '../utils/studentLabel'
import React, { useState, useEffect, useCallback, startTransition } from 'react'
import {
  Card, Table, Tag, Typography, Space, Input, Select,
  message, Button, Modal, Tabs, Form, Image, Tooltip,
} from 'antd'
import {
  TrophyOutlined, SearchOutlined,
  ClockCircleOutlined, DeleteOutlined, ExclamationCircleOutlined,
  DatabaseOutlined, PlusOutlined, EditOutlined, ReloadOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import FormulaRenderer from '../components/FormulaRenderer'
import SVGViewer from '../components/SVGViewer'
import PlaceholderManager from '../components/PlaceholderManager'
import { useTranslation } from 'react-i18next'

const { Title, Text } = Typography
const { TextArea } = Input

// ── 闯关记录类型 ──

interface QuestionDetail {
  sort_order: number
  category: string
  question_text: string
  options: Record<string, string>
  correct_answer: string
  student_answer: string
  is_correct: number
  lifeline_used: string
  time_spent: number
  score: number
  explanation: string
}

interface QuestRecord {
  id: number
  student_username: string
  student_name: string
  grade: string
  class_name: string
  answered_count: number
  correct_count: number
  score: number
  wrong_question_index: number
  completed: number
  lifelines_used: string[]
  questions: QuestionDetail[]
  created_at: string
  completed_at: string | null
}

// ── 闯关题目类型 ──

interface QuestBankQuestion {
  id: number
  category: string
  question_text: string
  options: Record<string, string>
  correct_answer: string
  explanation: string
  used_count: number
  svg_content: string
  has_svg: number
  media_files: any
  media_placeholders: any
  created_at: string
}

const SCORE_COLORS = ['#ff4d4f', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1']

// ════════════════════════════════════════════
// 子组件：闯关记录标签页
// ════════════════════════════════════════════

const QuestRecordsTab: React.FC = () => {
  const [records, setRecords] = useState<QuestRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [gradeFilter, setGradeFilter] = useState('')
  const [classFilter, setClassFilter] = useState('')
  const [nameFilter, setNameFilter] = useState('')

  // 动态下拉选项
  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [gradesLoading, setGradesLoading] = useState(true)
  const [classesLoading, setClassesLoading] = useState(false)
  const { t } = useTranslation('questions')

  const lifelineLabels: Record<string, string> = {
    remove_one: t('lifelineRemoveOne'),
    phone_friend: t('lifelinePhoneFriend'),
    audience_vote: t('lifelineAudienceVote'),
  }

  // 加载年级列表
  useEffect(() => {
    (async () => {
      try {
        const { data } = await apiClient.get('/api/quest/admin/grades')
        setGrades(Array.isArray(data) ? data : [])
      } catch {
        // ignore
      } finally {
        setGradesLoading(false)
      }
    })()
  }, [])

  // 年级变化时加载班级
  useEffect(() => {
    if (!gradeFilter) return
    startTransition(() => setClassesLoading(true))
    startTransition(() => setClassFilter(''))
    ;(async () => {
      try {
        const { data } = await apiClient.get('/api/quest/admin/classes', {
          params: { grade: gradeFilter },
        })
        startTransition(() => setClasses(Array.isArray(data) ? data : []))
      } catch {
        // ignore
      } finally {
        startTransition(() => setClassesLoading(false))
      }
    })()
  }, [gradeFilter])

  const loadRecords = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = { page, page_size: pageSize }
      if (gradeFilter) params.grade = gradeFilter
      if (classFilter) params.class_name = classFilter
      if (nameFilter) params.student_name = nameFilter
      const { data } = await apiClient.get('/api/quest/admin/records', { params })
      setRecords(data.records || [])
      setTotal(data.total || 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, gradeFilter, classFilter, nameFilter])

  useEffect(() => {
    startTransition(() => loadRecords())
  }, [loadRecords])

  const handleDelete = (record: QuestRecord) => {
    Modal.confirm({
      title: t('confirmDelete'),
      icon: <ExclamationCircleOutlined />,
      content: t('confirmDeleteRecord', {
        name: record.student_name,
        id: record.id,
        correct: record.correct_count,
        total: record.answered_count,
      }),
      okText: t('delete'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        try {
          await apiClient.delete(`/api/quest/admin/records/${record.id}`)
          loadRecords()
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('deleteFailed'))
        }
      },
    })
  }

  const columns = [
    {
      title: t('student'),
      key: 'student',
      width: 200,
      render: (_: any, r: QuestRecord) => (
        <Text strong>{studentLabel(r)}</Text>
      ),
    },
    {
      title: t('class'),
      key: 'class',
      width: 120,
      render: (_: any, r: QuestRecord) => (
        <Text type="secondary">{r.grade} {r.class_name}</Text>
      ),
    },
    {
      title: t('result'),
      key: 'status',
      width: 80,
      render: (_: any, r: QuestRecord) => {
        if (r.completed === 0) return <Tag color="processing">{t('inProgress')}</Tag>
        if (r.completed === 1 && r.correct_count >= 1) return <Tag color="success">{t('success')}</Tag>
        return <Tag color="error">{t('terminated')}</Tag>
      },
    },
    {
      title: t('correctTotal'),
      key: 'count',
      width: 100,
      render: (_: any, r: QuestRecord) => {
        const c = SCORE_COLORS[Math.min(Math.floor(r.correct_count / 3), 5)]
        return <Text strong style={{ color: c }}>{r.correct_count} / {r.answered_count}</Text>
      },
    },
    {
      title: t('score'),
      dataIndex: 'score',
      key: 'score',
      width: 70,
      render: (s: number) => <Text strong>{s}</Text>,
    },
    {
      title: t('wrongQuestion'),
      key: 'wrong',
      width: 80,
      render: (_: any, r: QuestRecord) =>
        r.wrong_question_index > 0 ? t('questionNo', { n: r.wrong_question_index }) : '-',
    },
    {
      title: t('lifeline'),
      key: 'lifelines',
      width: 160,
      render: (_: any, r: QuestRecord) => (
        <Space size={2} wrap>
          {r.lifelines_used.length > 0
            ? r.lifelines_used.map((l) => (
                <Tag key={l} color="orange" style={{ fontSize: 11 }}>
                  {lifelineLabels[l] || l}
                </Tag>
              ))
            : <Text type="secondary">{t('notUsed')}</Text>
          }
        </Space>
      ),
    },
    {
      title: t('time'),
      dataIndex: 'created_at',
      key: 'time',
      width: 140,
      render: (v: string) => v?.slice(0, 16) || '-',
    },
    {
      title: t('actions'),
      key: 'action',
      width: 70,
      render: (_: any, r: QuestRecord) => (
        <Button
          type="link"
          danger
          size="small"
          icon={<DeleteOutlined />}
          onClick={(e) => { e.stopPropagation(); handleDelete(r) }}
        />
      ),
    },
  ]

  const expandedRowRender = (record: QuestRecord) => (
    <div style={{ maxWidth: '100%', overflow: 'auto' }}>
      {record.questions.length === 0 ? (
        <Text type="secondary">{t('noQuestionDetails')}</Text>
      ) : (
        <Table
          dataSource={record.questions}
          rowKey="sort_order"
          pagination={false}
          size="small"
          bordered
          columns={[
            {
              title: '#',
              dataIndex: 'sort_order',
              key: 'sort',
              width: 40,
            },
            {
              title: t('category'),
              dataIndex: 'category',
              key: 'cat',
              width: 80,
              render: (c: string) => <Tag>{c}</Tag>,
            },
            {
              title: t('question'),
              dataIndex: 'question_text',
              key: 'q',
              width: 280,
              render: (text: string) => (
                <div style={{ maxWidth: 280, wordBreak: 'break-word' }}>
                  <Text style={{ fontSize: 13 }}>{text}</Text>
                </div>
              ),
            },
            {
              title: t('studentAnswer'),
              dataIndex: 'student_answer',
              key: 'sa',
              width: 100,
              render: (ans: string, q: QuestionDetail) => {
                if (q.is_correct === 1) return <Tag color="success">{ans || '✓'}</Tag>
                if (q.is_correct === 0) return <Tag color="error">{ans || '✗'}</Tag>
                return <Tag>-</Tag>
              },
            },
            {
              title: t('correctAnswer'),
              key: 'ca',
              width: 100,
              render: (_: any, q: QuestionDetail) => (
                <Tag color="green">{q.correct_answer}. {q.options[q.correct_answer]?.slice(0, 20) || ''}</Tag>
              ),
            },
            {
              title: t('score'),
              dataIndex: 'score',
              key: 's',
              width: 50,
              render: (s: number) => <Text strong>{s}</Text>,
            },
            {
              title: t('timeSpent'),
              dataIndex: 'time_spent',
              key: 'ts',
              width: 60,
              render: (sec: number) => (
                <Space>
                  <ClockCircleOutlined style={{ fontSize: 12 }} />
                  {sec || 0}s
                </Space>
              ),
            },
            {
              title: t('lifeline'),
              dataIndex: 'lifeline_used',
              key: 'll',
              width: 80,
              render: (l: string) =>
                l ? <Tag color="orange" style={{ fontSize: 11 }}>{lifelineLabels[l.split(',')[0]] || l}</Tag> : '-',
            },
            {
              title: t('explanation'),
              dataIndex: 'explanation',
              key: 'exp',
              width: 200,
              render: (e: string) => (
                <Text type="secondary" style={{ fontSize: 12 }}>{e}</Text>
              ),
            },
          ]}
          scroll={{ x: 1100 }}
        />
      )}
    </div>
  )

  return (
    <div style={{ width: '100%' }}>
      {/* ── 筛选栏 ── */}
      <Card style={{ marginBottom: 8, borderRadius: 8 }} size="small">
        <Space wrap>
          <Input
            placeholder={t('studentNamePlaceholder')}
            prefix={<SearchOutlined />}
            style={{ width: 160 }}
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            allowClear
            onPressEnter={loadRecords}
          />
          <Select
            placeholder={t('selectGrade')}
            style={{ width: 120 }}
            value={gradeFilter || undefined}
            onChange={(v) => {
              setGradeFilter(v || '')
              if (!v) setClasses([])
            }}
            allowClear
            loading={gradesLoading}
            options={grades.map((g) => ({ label: g, value: g }))}
          />
          <Select
            placeholder={t('selectClass')}
            style={{ width: 120 }}
            value={classFilter || undefined}
            onChange={(v) => setClassFilter(v || '')}
            allowClear
            loading={classesLoading}
            disabled={!gradeFilter}
            options={classes.map((c) => ({ label: c, value: c }))}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={loadRecords}>{t('search')}</Button>
          <Text type="secondary" style={{ fontSize: 13 }}>{t('totalRecords', { count: total })}</Text>
        </Space>
      </Card>

      {/* ── 表格 ── */}
      <Card style={{ borderRadius: 8, marginBottom: 0 }}>
        <Table
          dataSource={records}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showQuickJumper: true,
            hideOnSinglePage: false,
            showTotal: (totalItems, range) => t('pageInfo', { start: range[0], end: range[1], total: totalItems }),
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
          expandable={{
            expandedRowRender,
            rowExpandable: (r) => r.questions.length > 0,
          }}
          scroll={{ x: 900 }}
        />
      </Card>
    </div>
  )
}


// ════════════════════════════════════════════
// 子组件：闯关题库管理标签页
// ════════════════════════════════════════════

const QuestBankTab: React.FC = () => {
  const { t } = useTranslation('questions')
  const [questions, setQuestions] = useState<QuestBankQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [keyword, setKeyword] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [categories, setCategories] = useState<{ name: string; count: number }[]>([])

  // 编辑弹窗
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editingQuestion, setEditingQuestion] = useState<QuestBankQuestion | null>(null)
  const [editForm] = Form.useForm()
  const [saving, setSaving] = useState(false)

  // AI 生题
  const [aiGenerating, setAiGenerating] = useState(false)
  const [aiCount, setAiCount] = useState(5)

  // ── 配图管理 ──
  const [mediaModalOpen, setMediaModalOpen] = useState(false)
  const [mediaQuestion, setMediaQuestion] = useState<QuestBankQuestion | null>(null)
  const [svgLoading, setSvgLoading] = useState(false)
  const [wanxiangLoading, setWanxiangLoading] = useState(false)

  const handleManageMedia = (q: QuestBankQuestion) => {
    setMediaQuestion(q)
    setMediaModalOpen(true)
  }

  const handleRegenerateSVG = async () => {
    if (!mediaQuestion) return
    setSvgLoading(true)
    try {
      await apiClient.post(`/api/quest/admin/bank/${mediaQuestion.id}/generate-svg`)
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('svgGenerateFailed'))
    } finally {
      setSvgLoading(false)
    }
  }

  const handleDeleteSVG = async () => {
    if (!mediaQuestion) return
    try {
      await apiClient.delete(`/api/quest/admin/bank/${mediaQuestion.id}/svg`)
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('deleteFailed'))
    }
  }

  const handleGenerateImage = async () => {
    if (!mediaQuestion) return
    setWanxiangLoading(true)
    try {
      await apiClient.post(`/api/quest/admin/bank/${mediaQuestion.id}/generate-image`)
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('imageGenerateFailed'))
    } finally {
      setWanxiangLoading(false)
    }
  }

  const handleGenerateMedia = async (key: string) => {
    if (!mediaQuestion) return
    try {
      await apiClient.post(`/api/quest/admin/bank/${mediaQuestion.id}/generate-media/${key}`)
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('imageGenFailed'))
    }
  }

  const handleUploadMedia = async (key: string, file: File) => {
    if (!mediaQuestion) return
    const formData = new FormData()
    formData.append('file', file)
    try {
      await apiClient.post(`/api/quest/admin/bank/${mediaQuestion.id}/upload-media/${key}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('uploadFailed'))
    }
  }

  const handleDeleteMedia = async (key: string) => {
    if (!mediaQuestion) return
    try {
      await apiClient.delete(`/api/quest/admin/bank/${mediaQuestion.id}/media/${key}`)
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('deleteFailed'))
    }
  }

  const loadQuestions = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = { page, page_size: pageSize }
      if (keyword) params.keyword = keyword
      if (categoryFilter) params.category = categoryFilter
      const { data } = await apiClient.get('/api/quest/admin/bank', { params })
      setQuestions(data.questions || [])
      setTotal(data.total || 0)
      if (data.categories) setCategories(data.categories)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, keyword, categoryFilter])

  useEffect(() => {
    startTransition(() => loadQuestions())
  }, [loadQuestions])

  // ── 删除 ──
  const handleDelete = (q: QuestBankQuestion) => {
    Modal.confirm({
      title: t('confirmDelete'),
      icon: <ExclamationCircleOutlined />,
      content: t('confirmDeleteQuestion', { id: q.id, text: q.question_text.slice(0, 50) }),
      okText: t('delete'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        try {
          await apiClient.delete(`/api/quest/admin/bank/${q.id}`)
          loadQuestions()
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('deleteFailed'))
        }
      },
    })
  }

  // ── 编辑 ──
  const openEdit = (q: QuestBankQuestion) => {
    setEditingQuestion(q)
    editForm.setFieldsValue({
      category: q.category,
      question_text: q.question_text,
      option_a: Object.entries(q.options || {})[0]?.[1] || '',
      option_b: Object.entries(q.options || {})[1]?.[1] || '',
      option_c: Object.entries(q.options || {})[2]?.[1] || '',
      option_d: Object.entries(q.options || {})[3]?.[1] || '',
      correct_answer: q.correct_answer,
      explanation: q.explanation,
    })
    setEditModalOpen(true)
  }

  const handleEditSave = async () => {
    try {
      const values = await editForm.validateFields()
      if (!editingQuestion) return
      setSaving(true)
      const options: Record<string, string> = {
        A: values.option_a,
        B: values.option_b,
        C: values.option_c,
        D: values.option_d,
      }
      await apiClient.put(`/api/quest/admin/bank/${editingQuestion.id}`, {
        category: values.category,
        question_text: values.question_text,
        options,
        correct_answer: values.correct_answer,
        explanation: values.explanation,
      })
      setEditModalOpen(false)
      loadQuestions()
    } catch (e: any) {
      if (e?.errorFields) return // 表单验证失败
      message.error(e?.response?.data?.detail || t('updateFailed'))
    } finally {
      setSaving(false)
    }
  }

  // ── AI 生题 ──
  const handleAiGenerate = async () => {
    setAiGenerating(true)
    try {
      const { data } = await apiClient.post('/api/quest/admin/bank/ai-generate', { count: aiCount })
      message.success(t('aiGenerateSuccess', { saved: data.saved, total: data.total }))
      loadQuestions()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('aiGenerateFailed'))
    } finally {
      setAiGenerating(false)
    }
  }

  // ── 配图列渲染 ──
  const renderMediaCell = (_: any, r: QuestBankQuestion) => {
    let mf: any[] = []
    if (Array.isArray(r.media_files)) {
      mf = r.media_files
    } else if (typeof r.media_files === 'string') {
      try { mf = JSON.parse(r.media_files) } catch { /* ignore */ }
    }
    if (r.has_svg && r.svg_content) {
      return <SVGViewer svgCode={r.svg_content} description={t('preview')} thumbHeight={50} />
    }
    if (mf.length > 0 && mf[0].url) {
      return (
        <div style={{ width: 60, height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          <Image src={mf[0].url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            preview={{ mask: null }} />
        </div>
      )
    }
    let ph: any[] = []
    if (Array.isArray(r.media_placeholders)) ph = r.media_placeholders
    else if (typeof r.media_placeholders === 'string') {
      try { ph = JSON.parse(r.media_placeholders) } catch { /* ignore */ }
    }
    if (ph.length > 0) {
      return (
        <Tooltip title={t('placeholderCount', { count: ph.length })}>
          <Tag color="orange">📷 {ph.length}</Tag>
        </Tooltip>
      )
    }
    return <span style={{ color: '#ddd' }}>{t('dash')}</span>
  }

  // ── 展开行渲染 ──
  const expandedRowRender = (r: QuestBankQuestion) => (
    <div style={{ padding: '8px 0', maxWidth: '100%', overflow: 'auto' }}>
      <Space orientation="vertical" style={{ width: '100%' }} size={8}>
        <div>
          <Text strong style={{ fontSize: 13 }}>{t('questionLabel')}</Text>
          <div style={{ marginTop: 4, padding: '8px 12px', background: '#fafafa', borderRadius: 6 }}>
            <FormulaRenderer content={r.question_text} />
          </div>
        </div>
        <div>
          <Text strong style={{ fontSize: 13 }}>{t('optionsLabel')}</Text>
          <div style={{ marginTop: 4, padding: '8px 12px', background: '#fafafa', borderRadius: 6 }}>
            {Object.entries(r.options || {}).map(([k, v]) => (
              <div key={k} style={{ marginBottom: 4 }}>
                <Tag color={k === r.correct_answer ? 'green' : 'default'}>{k}</Tag>
                <FormulaRenderer content={v} inline />
              </div>
            ))}
          </div>
        </div>
        <div>
          <Text strong style={{ fontSize: 13 }}>{t('correctAnswerLabel')}</Text>
          <Tag color="green" style={{ marginLeft: 8 }}>{r.correct_answer}</Tag>
        </div>
        {r.explanation && (
          <div>
            <Text strong style={{ fontSize: 13 }}>{t('explanationLabel')}</Text>
            <div style={{ marginTop: 4, padding: '8px 12px', background: '#fafafa', borderRadius: 6 }}>
              <FormulaRenderer content={r.explanation} />
            </div>
          </div>
        )}
        {(r.has_svg && r.svg_content) && (
          <div>
            <Text strong style={{ fontSize: 13 }}>{t('svgLabel')}</Text>
            <div style={{ marginTop: 4 }}>
              <SVGViewer svgCode={r.svg_content} description={t('media')} expandable={false} />
            </div>
          </div>
        )}
      </Space>
    </div>
  )

  const columns = [
    {
      title: t('id'),
      dataIndex: 'id',
      key: 'id',
      width: 60,
    },
    {
      title: t('categoryColon'),
      dataIndex: 'category',
      key: 'category',
      width: 90,
      render: (c: string) => <Tag color="blue">{c}</Tag>,
    },
    {
      title: t('question'),
      dataIndex: 'question_text',
      key: 'question_text',
      width: 220,
      render: (text: string) => (
        <div style={{ maxWidth: 220, wordBreak: 'break-word' }}>
          <Text>{text.length > 50 ? text.slice(0, 50) + '…' : text}</Text>
        </div>
      ),
    },
    {
      title: t('media'),
      key: 'media',
      width: 80,
      render: renderMediaCell,
    },
    {
      title: t('usedCount'),
      dataIndex: 'used_count',
      key: 'used_count',
      width: 70,
      render: (c: number) => <Text>{t('times', { count: c })}</Text>,
    },
    {
      title: t('createdTime'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 130,
      render: (v: string) => v?.slice(0, 16) || '-',
    },
    {
      title: t('actions'),
      key: 'action',
      width: 180,
      render: (_: any, r: QuestBankQuestion) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />

          <Tooltip title={t('mediaManage')}>
            <Button type="link" size="small" icon={<span>🎨</span>} onClick={() => handleManageMedia(r)} />
          </Tooltip>
          <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(r)}>
            {t('delete')}
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <div>
      {/* ── 操作栏 ── */}
      <Card style={{ marginBottom: 8, borderRadius: 8 }} size="small">
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAiGenerate} loading={aiGenerating}>
            {t('aiGenerateQuest')}{aiGenerating ? t('generatingQuest') : t('questionCount', { count: aiCount })}
          </Button>
          <Select
            value={aiCount}
            onChange={setAiCount}
            style={{ width: 76 }}
            size="small"
            options={[1, 3, 5, 10, 15, 20].map(n => ({ label: t('questionCount', { count: n }), value: n }))}
          />
          <Input
            placeholder={t('searchQuestion')}
            prefix={<SearchOutlined />}
            style={{ width: 200 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            allowClear
            onPressEnter={loadQuestions}
          />
          <Select
            placeholder={t('filterByCategory')}
            style={{ width: 140 }}
            value={categoryFilter || undefined}
            onChange={(v) => setCategoryFilter(v || '')}
            allowClear
            options={categories.map((c) => ({ label: t('categoryOption', { name: c.name, count: c.count }), value: c.name }))}
          />
          <Button icon={<ReloadOutlined />} onClick={loadQuestions}>{t('refresh')}</Button>
          <Text type="secondary" style={{ fontSize: 13 }}>{t('totalQuestions', { count: total })}</Text>
        </Space>
      </Card>

      {/* ── 表格 ── */}
      <Card style={{ borderRadius: 8 }}>
        <Table
          dataSource={questions}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showQuickJumper: true,
            hideOnSinglePage: false,
            showTotal: (totalItems, range) => t('pageInfo', { start: range[0], end: range[1], total: totalItems }),
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
          expandable={{
            expandedRowRender,
            rowExpandable: () => true,
          }}
          scroll={{ x: 1200 }}
        />
      </Card>

      {/* ── 编辑弹窗 ── */}
      <Modal
        title={t('editQuestTitle')}
        open={editModalOpen}
        onOk={handleEditSave}
        onCancel={() => setEditModalOpen(false)}
        confirmLoading={saving}
        width={700}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="category" label={t('categoryLabel')} rules={[{ required: true }]}>
            <Input placeholder={t('categoryPlaceholder')} />
          </Form.Item>
          <Form.Item name="question_text" label={t('questionLabelForm')} rules={[{ required: true }]}>
            <TextArea rows={3} placeholder={t('questionPlaceholder')} />
          </Form.Item>
          <Space style={{ width: '100%' }} align="start">
            <Form.Item name="option_a" label={t('optionALabel')} rules={[{ required: true }]} style={{ width: 240 }}>
              <Input placeholder={t('optionAPlaceholder')} />
            </Form.Item>
            <Form.Item name="option_b" label={t('optionBLabel')} rules={[{ required: true }]} style={{ width: 240 }}>
              <Input placeholder={t('optionBPlaceholder')} />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} align="start">
            <Form.Item name="option_c" label={t('optionCLabel')} rules={[{ required: true }]} style={{ width: 240 }}>
              <Input placeholder={t('optionCPlaceholder')} />
            </Form.Item>
            <Form.Item name="option_d" label={t('optionDLabel')} rules={[{ required: true }]} style={{ width: 240 }}>
              <Input placeholder={t('optionDPlaceholder')} />
            </Form.Item>
          </Space>
          <Form.Item name="correct_answer" label={t('correctAnswerSelect')} rules={[{ required: true }]}>
            <Select placeholder={t('selectCorrectAnswer')}>
              <Select.Option value="A">A</Select.Option>
              <Select.Option value="B">B</Select.Option>
              <Select.Option value="C">C</Select.Option>
              <Select.Option value="D">D</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="explanation" label={t('explanationFormLabel')}>
            <TextArea rows={3} placeholder={t('explanationPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>


      {/* ── 配图管理弹窗 ── */}
      <Modal
        title={t('mediaManageTitle', { id: mediaQuestion?.id })}
        open={mediaModalOpen}
        onCancel={() => setMediaModalOpen(false)}
        footer={<Button onClick={() => setMediaModalOpen(false)}>{t('close')}</Button>}
        width={700}
      >
        {mediaQuestion && (
          <PlaceholderManager
            questionId={mediaQuestion.id}
            svgContent={mediaQuestion.svg_content}
            hasSvg={mediaQuestion.has_svg}
            placeholders={mediaQuestion.media_placeholders}
            mediaFiles={mediaQuestion.media_files}
            svgLoading={svgLoading}
            wanxiangLoading={wanxiangLoading}
            onRegenerateSVG={handleRegenerateSVG}
            onDeleteSVG={handleDeleteSVG}
            onGenerateImage={handleGenerateImage}
            onGenerateMedia={handleGenerateMedia}
            onUploadMedia={handleUploadMedia}
            onDeleteMedia={handleDeleteMedia}
          />
        )}
      </Modal>
    </div>
  )
}


// ════════════════════════════════════════════
// 主组件：含标签页切换
// ════════════════════════════════════════════

const QuestAdminPage: React.FC = () => {
  const { t } = useTranslation('questions')
  // 根据 URL 路径自动切换默认标签
  const [activeTab, setActiveTab] = useState('records')

  const tabItems = [
    {
      key: 'records',
      label: (
        <span><TrophyOutlined /> {t('questRecords')}</span>
      ),
      children: <QuestRecordsTab />,
    },
    {
      key: 'bank',
      label: (
        <span><DatabaseOutlined /> {t('questBank')}</span>
      ),
      children: <QuestBankTab />,
    },
  ]

  return (
    <Card style={{ borderRadius: 8 }}>
      <Title level={4} style={{ marginBottom: 12 }}>
        <TrophyOutlined style={{ marginRight: 8 }} />
        {t('questManagement')}
      </Title>
      <Card style={{ borderRadius: 8 }}>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
      </Card>
    </Card>
  )
}

export default QuestAdminPage
