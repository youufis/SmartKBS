/**
 * QuestAdminPage — 教师端闯关管理
 * 包含两个标签页：
 *   1. 闯关记录 — 查看学生闯关记录
 *   2. 题库管理 — 闯关题目的 CRUD 管理
 */
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

const LIFELINE_LABELS: Record<string, string> = {
  remove_one: '🎯去伪存真',
  phone_friend: '📞远程连线',
  audience_vote: '👥群策群力',
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
      message.error('加载闯关记录失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, gradeFilter, classFilter, nameFilter])

  useEffect(() => {
    startTransition(() => loadRecords())
  }, [loadRecords])

  const handleDelete = (record: QuestRecord) => {
    Modal.confirm({
      title: '确认删除',
      icon: <ExclamationCircleOutlined />,
      content: `确定删除 ${record.student_name} 的闯关记录 #${record.id}（答对 ${record.correct_count}/${record.answered_count} 题）？此操作不可恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiClient.delete(`/api/quest/admin/records/${record.id}`)
          message.success('删除成功')
          loadRecords()
        } catch (e: any) {
          message.error(e?.response?.data?.detail || '删除失败')
        }
      },
    })
  }

  const columns = [
    {
      title: '学生',
      key: 'student',
      width: 120,
      render: (_: any, r: QuestRecord) => (
        <Text strong>{r.student_name}</Text>
      ),
    },
    {
      title: '班级',
      key: 'class',
      width: 120,
      render: (_: any, r: QuestRecord) => (
        <Text type="secondary">{r.grade} {r.class_name}</Text>
      ),
    },
    {
      title: '结果',
      key: 'status',
      width: 80,
      render: (_: any, r: QuestRecord) => {
        if (r.completed === 0) return <Tag color="processing">进行中</Tag>
        if (r.completed === 1 && r.correct_count >= 1) return <Tag color="success">成功</Tag>
        return <Tag color="error">终止</Tag>
      },
    },
    {
      title: '答对/总题',
      key: 'count',
      width: 100,
      render: (_: any, r: QuestRecord) => {
        const c = SCORE_COLORS[Math.min(Math.floor(r.correct_count / 3), 5)]
        return <Text strong style={{ color: c }}>{r.correct_count} / {r.answered_count}</Text>
      },
    },
    {
      title: '得分',
      dataIndex: 'score',
      key: 'score',
      width: 70,
      render: (s: number) => <Text strong>{s}</Text>,
    },
    {
      title: '终止题号',
      key: 'wrong',
      width: 80,
      render: (_: any, r: QuestRecord) =>
        r.wrong_question_index > 0 ? `第${r.wrong_question_index}题` : '-',
    },
    {
      title: '锦囊',
      key: 'lifelines',
      width: 160,
      render: (_: any, r: QuestRecord) => (
        <Space size={2} wrap>
          {r.lifelines_used.length > 0
            ? r.lifelines_used.map((l) => (
                <Tag key={l} color="orange" style={{ fontSize: 11 }}>
                  {LIFELINE_LABELS[l] || l}
                </Tag>
              ))
            : <Text type="secondary">未使用</Text>
          }
        </Space>
      ),
    },
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'time',
      width: 140,
      render: (t: string) => t?.slice(0, 16) || '-',
    },
    {
      title: '操作',
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
        <Text type="secondary">暂无题目详情</Text>
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
              title: '领域',
              dataIndex: 'category',
              key: 'cat',
              width: 80,
              render: (c: string) => <Tag>{c}</Tag>,
            },
            {
              title: '题目',
              dataIndex: 'question_text',
              key: 'q',
              width: 280,
              render: (t: string) => (
                <div style={{ maxWidth: 280, wordBreak: 'break-word' }}>
                  <Text style={{ fontSize: 13 }}>{t}</Text>
                </div>
              ),
            },
            {
              title: '学生答案',
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
              title: '正确答案',
              key: 'ca',
              width: 100,
              render: (_: any, q: QuestionDetail) => (
                <Tag color="green">{q.correct_answer}. {q.options[q.correct_answer]?.slice(0, 20) || ''}</Tag>
              ),
            },
            {
              title: '得分',
              dataIndex: 'score',
              key: 's',
              width: 50,
              render: (s: number) => <Text strong>{s}</Text>,
            },
            {
              title: '用时',
              dataIndex: 'time_spent',
              key: 'ts',
              width: 60,
              render: (t: number) => (
                <Space>
                  <ClockCircleOutlined style={{ fontSize: 12 }} />
                  {t || 0}s
                </Space>
              ),
            },
            {
              title: '锦囊',
              dataIndex: 'lifeline_used',
              key: 'll',
              width: 80,
              render: (l: string) =>
                l ? <Tag color="orange" style={{ fontSize: 11 }}>{LIFELINE_LABELS[l.split(',')[0]] || l}</Tag> : '-',
            },
            {
              title: '解析',
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
            placeholder="学生姓名"
            prefix={<SearchOutlined />}
            style={{ width: 160 }}
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            allowClear
            onPressEnter={loadRecords}
          />
          <Select
            placeholder="选择年级"
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
            placeholder="选择班级"
            style={{ width: 120 }}
            value={classFilter || undefined}
            onChange={(v) => setClassFilter(v || '')}
            allowClear
            loading={classesLoading}
            disabled={!gradeFilter}
            options={classes.map((c) => ({ label: c, value: c }))}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={loadRecords}>查询</Button>
          <Text type="secondary" style={{ fontSize: 13 }}>共 {total} 条记录</Text>
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
            showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条`,
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
      message.success('SVG 已重新生成')
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'SVG 生成失败')
    } finally {
      setSvgLoading(false)
    }
  }

  const handleDeleteSVG = async () => {
    if (!mediaQuestion) return
    try {
      await apiClient.delete(`/api/quest/admin/bank/${mediaQuestion.id}/svg`)
      message.success('SVG 配图已删除')
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '删除失败')
    }
  }

  const handleGenerateImage = async () => {
    if (!mediaQuestion) return
    setWanxiangLoading(true)
    try {
      await apiClient.post(`/api/quest/admin/bank/${mediaQuestion.id}/generate-image`)
      message.success('配图已生成')
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '生图失败')
    } finally {
      setWanxiangLoading(false)
    }
  }

  const handleGenerateMedia = async (key: string) => {
    if (!mediaQuestion) return
    try {
      await apiClient.post(`/api/quest/admin/bank/${mediaQuestion.id}/generate-media/${key}`)
      message.success('图片已生成')
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '图片生成失败')
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
      message.success('图片已上传')
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '上传失败')
    }
  }

  const handleDeleteMedia = async (key: string) => {
    if (!mediaQuestion) return
    try {
      await apiClient.delete(`/api/quest/admin/bank/${mediaQuestion.id}/media/${key}`)
      message.success('配图已删除')
      await loadQuestions()
      const { data } = await apiClient.get(`/api/quest/admin/bank/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '删除失败')
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
      message.error('加载闯关题库失败')
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
      title: '确认删除',
      icon: <ExclamationCircleOutlined />,
      content: `确定删除题目 #${q.id}：「${q.question_text.slice(0, 50)}」？此操作不可恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiClient.delete(`/api/quest/admin/bank/${q.id}`)
          message.success('删除成功')
          loadQuestions()
        } catch (e: any) {
          message.error(e?.response?.data?.detail || '删除失败')
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
      message.success('更新成功')
      setEditModalOpen(false)
      loadQuestions()
    } catch (e: any) {
      if (e?.errorFields) return // 表单验证失败
      message.error(e?.response?.data?.detail || '更新失败')
    } finally {
      setSaving(false)
    }
  }

  // ── AI 生题 ──
  const handleAiGenerate = async () => {
    setAiGenerating(true)
    try {
      const { data } = await apiClient.post('/api/quest/admin/bank/ai-generate', { count: aiCount })
      message.success(`AI 成功生成 ${data.saved}/${data.total} 道题目`)
      loadQuestions()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'AI 生题失败')
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
      return <SVGViewer svgCode={r.svg_content} description="预览" thumbHeight={50} />
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
        <Tooltip title={`${ph.length} 个占位符`}>
          <Tag color="orange">📷 {ph.length}</Tag>
        </Tooltip>
      )
    }
    return <span style={{ color: '#ddd' }}>—</span>
  }

  // ── 展开行渲染 ──
  const expandedRowRender = (r: QuestBankQuestion) => (
    <div style={{ padding: '8px 0', maxWidth: '100%', overflow: 'auto' }}>
      <Space orientation="vertical" style={{ width: '100%' }} size={8}>
        <div>
          <Text strong style={{ fontSize: 13 }}>📝 题目：</Text>
          <div style={{ marginTop: 4, padding: '8px 12px', background: '#fafafa', borderRadius: 6 }}>
            <FormulaRenderer content={r.question_text} />
          </div>
        </div>
        <div>
          <Text strong style={{ fontSize: 13 }}>🔤 选项：</Text>
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
          <Text strong style={{ fontSize: 13 }}>✅ 正确答案：</Text>
          <Tag color="green" style={{ marginLeft: 8 }}>{r.correct_answer}</Tag>
        </div>
        {r.explanation && (
          <div>
            <Text strong style={{ fontSize: 13 }}>💡 解析：</Text>
            <div style={{ marginTop: 4, padding: '8px 12px', background: '#fafafa', borderRadius: 6 }}>
              <FormulaRenderer content={r.explanation} />
            </div>
          </div>
        )}
        {(r.has_svg && r.svg_content) && (
          <div>
            <Text strong style={{ fontSize: 13 }}>🖼️ SVG 配图：</Text>
            <div style={{ marginTop: 4 }}>
              <SVGViewer svgCode={r.svg_content} description="配图" expandable={false} />
            </div>
          </div>
        )}
      </Space>
    </div>
  )

  const columns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 60,
    },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      width: 90,
      render: (c: string) => <Tag color="blue">{c}</Tag>,
    },
    {
      title: '题目',
      dataIndex: 'question_text',
      key: 'question_text',
      width: 220,
      render: (t: string) => (
        <div style={{ maxWidth: 220, wordBreak: 'break-word' }}>
          <Text>{t.length > 50 ? t.slice(0, 50) + '…' : t}</Text>
        </div>
      ),
    },
    {
      title: '配图',
      key: 'media',
      width: 80,
      render: renderMediaCell,
    },
    {
      title: '使用次数',
      dataIndex: 'used_count',
      key: 'used_count',
      width: 70,
      render: (c: number) => <Text>{c} 次</Text>,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 130,
      render: (t: string) => t?.slice(0, 16) || '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_: any, r: QuestBankQuestion) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Tooltip title="配图管理">
            <Button type="link" size="small" icon={<span>🎨</span>} onClick={() => handleManageMedia(r)} />
          </Tooltip>
          <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(r)}>
            删除
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
            AI生题 {aiGenerating ? '中...' : `(${aiCount}道)`}
          </Button>
          <Select
            value={aiCount}
            onChange={setAiCount}
            style={{ width: 76 }}
            size="small"
            options={[1, 3, 5, 10, 15, 20].map(n => ({ label: `${n}道`, value: n }))}
          />
          <Input
            placeholder="搜索题目"
            prefix={<SearchOutlined />}
            style={{ width: 200 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            allowClear
            onPressEnter={loadQuestions}
          />
          <Select
            placeholder="按分类筛选"
            style={{ width: 140 }}
            value={categoryFilter || undefined}
            onChange={(v) => setCategoryFilter(v || '')}
            allowClear
            options={categories.map((c) => ({ label: `${c.name} (${c.count})`, value: c.name }))}
          />
          <Button icon={<ReloadOutlined />} onClick={loadQuestions}>刷新</Button>
          <Text type="secondary" style={{ fontSize: 13 }}>共 {total} 道题</Text>
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
            showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条`,
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
        title="编辑闯关题目"
        open={editModalOpen}
        onOk={handleEditSave}
        onCancel={() => setEditModalOpen(false)}
        confirmLoading={saving}
        width={700}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="category" label="分类" rules={[{ required: true }]}>
            <Input placeholder="例如：科学、历史、地理" />
          </Form.Item>
          <Form.Item name="question_text" label="题目" rules={[{ required: true }]}>
            <TextArea rows={3} placeholder="请输入题目内容" />
          </Form.Item>
          <Space style={{ width: '100%' }} align="start">
            <Form.Item name="option_a" label="选项 A" rules={[{ required: true }]} style={{ width: 240 }}>
              <Input placeholder="选项 A" />
            </Form.Item>
            <Form.Item name="option_b" label="选项 B" rules={[{ required: true }]} style={{ width: 240 }}>
              <Input placeholder="选项 B" />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} align="start">
            <Form.Item name="option_c" label="选项 C" rules={[{ required: true }]} style={{ width: 240 }}>
              <Input placeholder="选项 C" />
            </Form.Item>
            <Form.Item name="option_d" label="选项 D" rules={[{ required: true }]} style={{ width: 240 }}>
              <Input placeholder="选项 D" />
            </Form.Item>
          </Space>
          <Form.Item name="correct_answer" label="正确答案" rules={[{ required: true }]}>
            <Select placeholder="选择正确答案">
              <Select.Option value="A">A</Select.Option>
              <Select.Option value="B">B</Select.Option>
              <Select.Option value="C">C</Select.Option>
              <Select.Option value="D">D</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="explanation" label="解析">
            <TextArea rows={3} placeholder="题目解析（可选）" />
          </Form.Item>
        </Form>
      </Modal>


      {/* ── 配图管理弹窗 ── */}
      <Modal
        title={`🎨 配图管理 #${mediaQuestion?.id}`}
        open={mediaModalOpen}
        onCancel={() => setMediaModalOpen(false)}
        footer={<Button onClick={() => setMediaModalOpen(false)}>关闭</Button>}
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
  // 根据 URL 路径自动切换默认标签
  const [activeTab, setActiveTab] = useState('records')

  const tabItems = [
    {
      key: 'records',
      label: (
        <span><TrophyOutlined /> 闯关记录</span>
      ),
      children: <QuestRecordsTab />,
    },
    {
      key: 'bank',
      label: (
        <span><DatabaseOutlined /> 题库管理</span>
      ),
      children: <QuestBankTab />,
    },
  ]

  return (
    <Card style={{ borderRadius: 8 }}>
      <Title level={4} style={{ marginBottom: 12 }}>
        <TrophyOutlined style={{ marginRight: 8 }} />
        闯关管理
      </Title>
      <Card style={{ borderRadius: 8 }}>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
      </Card>
    </Card>
  )
}

export default QuestAdminPage
