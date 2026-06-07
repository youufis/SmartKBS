import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Layout, Card, Table, Button, message, Modal, Form, Input, Select,
  InputNumber, Tag, Space, Typography, Tooltip, Popconfirm, Row, Col, Divider, Empty, Tabs, Upload, Image,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined, ClearOutlined,
  LoadingOutlined, BookOutlined, FilterOutlined, FileTextOutlined, UploadOutlined,
} from '@ant-design/icons'
import * as questionsApi from '../api/questions'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import type { QuestionInfo } from '../types'
import FormulaRenderer from '../components/FormulaRenderer'
import SVGViewer from '../components/SVGViewer'
import MediaDisplay from '../components/MediaDisplay'
import PlaceholderManager from '../components/PlaceholderManager'

const { TextArea } = Input
const { Option } = Select

const TYPE_COLORS: Record<string, string> = {
  single: 'blue',
  multiple: 'purple',
  true_false: 'orange',
  short: 'green',
}

const TYPE_LABELS: Record<string, string> = {
  single: '单选题',
  multiple: '多选题',
  true_false: '判断题',
  short: '简答题',
}

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'green',
  medium: 'gold',
  hard: 'red',
}

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
}

let subjectOptions = ['信息科技', '通用技术']

const QuestionBankPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)

  // 从后端加载课程列表
  useEffect(() => {
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) {
        subjectOptions = data.subjects
      }
    }).catch(() => {})
  }, [])
  // ── 生成试题表单 ──
  const [generateForm] = Form.useForm()
  const [generating, setGenerating] = useState(false)
  const [genProgress, setGenProgress] = useState({ step: 0, text: '', count: 0, total: 0 })
  const [generatedQuestions, setGeneratedQuestions] = useState<QuestionInfo[]>([])
  const [showGeneratePanel, setShowGeneratePanel] = useState(false)
  const [genTab, setGenTab] = useState('generate')

  // ── 提取试题 ──
  const [extractSubject, setExtractSubject] = useState('')
  const [extractDifficulty, setExtractDifficulty] = useState('medium')
  const [extractText, setExtractText] = useState('')
  const [extractFile, setExtractFile] = useState<File | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractedQuestions, setExtractedQuestions] = useState<QuestionInfo[]>([])
  const [extractError, setExtractError] = useState<string | null>(null)
  const [extractElapsed, setExtractElapsed] = useState(0)
  const extractTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── 题库列表 ──
  const [questions, setQuestions] = useState<QuestionInfo[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [filters, setFilters] = useState<{
    type?: string
    keyword?: string
    difficulty?: string
    subject?: string
  }>({})

  // ── 编辑弹窗 ──
  const [editModal, setEditModal] = useState(false)
  const [mediaModal, setMediaModal] = useState(false)
  const [mediaQuestion, setMediaQuestion] = useState<QuestionInfo | null>(null)
  const [editingQuestion, setEditingQuestion] = useState<QuestionInfo | null>(null)
  const [editForm] = Form.useForm()
  const [saving, setSaving] = useState(false)

  // ── 加载题库列表 ──
  const loadQuestions = useCallback(async () => {
    setLoading(true)
    try {
      const res = await questionsApi.listQuestions({
        ...filters,
        page,
        page_size: pageSize,
      })
      setQuestions(res.questions)
      setTotal(res.total)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '加载题库失败')
    } finally {
      setLoading(false)
    }
  }, [filters, page, pageSize])

  useEffect(() => {
    const params: any = { page: 1, page_size: 50 }
    questionsApi.listQuestions(params)
      .then(res => { setQuestions(res.questions); setTotal(res.total) })
      .catch(err => message.error(err?.response?.data?.detail || '加载题库失败'))
      .finally(() => setLoading(false))
  }, [])

  // ── 生成试题 ──
  const [genError, setGenError] = useState<string | null>(null)

  const handleGenerate = async () => {
    try {
      const values = await generateForm.validateFields()
      setGenerating(true)
      setGenError(null)
      setGeneratedQuestions([])

      const totalCount = values.count || 5
      setGenProgress({ step: 1, text: '正在连接 AI 服务...', count: 0, total: totalCount })

      await new Promise(r => setTimeout(r, 100))
      setGenProgress({ step: 2, text: `AI 正在生成 ${totalCount} 道试题...`, count: 0, total: totalCount })

      const res = await questionsApi.generateQuestionsWithMedia({
        subject: values.subject,
        knowledge_points: values.knowledge_points,
        question_type: values.question_type,
        count: totalCount,
        difficulty: values.difficulty || 'medium',
      })

      setGeneratedQuestions(res.questions)
      setGenProgress({ step: 0, text: '', count: 0, total: 0 })
      message.success(res.message)
      loadQuestions()
      setGenerating(false)
    } catch (err: any) {
      const errMsg = err?.response?.data?.detail || err?.message || '生成失败，请重试'
      if (!err?.errorFields) {
        setGenError(errMsg)
        setGenProgress({ step: -1, text: '', count: 0, total: 0 })
        setGenerating(false)
      } else {
        setGenerating(false)
      }
    }
  }

  // ── 提取试题 ──
  const handleExtract = async () => {
    if (!extractText.trim() && !extractFile) {
      message.warning('请粘贴文本或上传文档（docx/txt/md/pdf/json）')
      return
    }
    setExtracting(true)
    setExtractError(null)
    setExtractedQuestions([])
    setExtractElapsed(0)
    extractTimerRef.current = setInterval(() => {
      setExtractElapsed((prev) => prev + 1)
    }, 1000)
    try {
      const formData = new FormData()
      formData.append('subject', extractSubject)
      formData.append('difficulty', extractDifficulty)
      if (extractFile) {
        formData.append('file', extractFile)
      } else {
        formData.append('text', extractText)
      }
      const res = await questionsApi.extractQuestions(formData)
      setExtractedQuestions(res.questions)
      message.success(res.message)
      loadQuestions()
    } catch (err: any) {
      const errMsg = err?.response?.data?.detail || err?.message || '提取失败，请重试'
      setExtractError(errMsg)
    } finally {
      if (extractTimerRef.current) clearInterval(extractTimerRef.current)
      setExtracting(false)
    }
  }

  // ── 删除重复试题 ──
  const [dedupResult, setDedupResult] = useState<{
    total_deleted: number;
    groups: { question_text: string; count: number }[];
    message: string;
  } | null>(null)
  const [dedupLoading, setDedupLoading] = useState(false)

  const handleDedup = async () => {
    Modal.confirm({
      title: '确认去重',
      content: '将查找并删除完全重复的试题（基于题目文本），仅保留最早创建的那条。确定继续？',
      onOk: async () => {
        setDedupLoading(true)
        try {
          const res = await questionsApi.dedupQuestions()
          setDedupResult(res)
          if (res.total_deleted > 0) {
            loadQuestions()
          }
        } catch {
          message.error('去重失败')
        } finally {
          setDedupLoading(false)
        }
      },
    })
  }

  // ── 配图管理 ──
  const [mediaGenerating, setMediaGenerating] = useState(false)

  const handleManageMedia = (q: QuestionInfo) => {
    setMediaQuestion(q)
    setMediaModal(true)
  }

  const handleRegenerateSVG = async () => {
    if (!mediaQuestion) return
    setMediaGenerating(true)
    try {
      await apiClient.post(`/api/questions/${mediaQuestion.id}/generate-svg`)
      message.success('SVG 已重新生成')
      loadQuestions()
      // 更新弹窗中的 mediaQuestion
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'SVG 生成失败')
    } finally {
      setMediaGenerating(false)
    }
  }

  const handleGenerateMedia = async (key: string) => {
    if (!mediaQuestion) return
    setMediaGenerating(true)
    try {
      await apiClient.post(`/api/questions/${mediaQuestion.id}/generate-media/${key}`)
      message.success('图片已生成')
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '图片生成失败')
    } finally {
      setMediaGenerating(false)
    }
  }

  const handleUploadMedia = async (key: string, file: File) => {
    if (!mediaQuestion) return
    const formData = new FormData()
    formData.append('file', file)
    try {
      await apiClient.post(`/api/questions/${mediaQuestion.id}/upload-media/${key}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      message.success('图片已上传')
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '上传失败')
    }
  }

  const handleDeleteMedia = async (key: string) => {
    if (!mediaQuestion) return
    try {
      await apiClient.delete(`/api/questions/${mediaQuestion.id}/media/${key}`)
      message.success('配图已删除')
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '删除失败')
    }
  }

  // ── 编辑题目 ──
  const handleEdit = (q: QuestionInfo) => {
    setEditingQuestion(q)
    editForm.setFieldsValue({
      question_text: q.question_text,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
      knowledge_points: q.knowledge_points,
      difficulty: q.difficulty,
      options: q.options ? JSON.stringify(q.options, null, 2) : '',
    })
    setEditModal(true)
  }

  const handleSaveEdit = async () => {
    if (!editingQuestion) return
    try {
      const values = await editForm.validateFields()
      setSaving(true)

      const updates: any = {
        question_text: values.question_text,
        correct_answer: values.correct_answer,
        explanation: values.explanation,
        knowledge_points: values.knowledge_points,
        difficulty: values.difficulty,
      }

      // 如果有 options（非简答题），解析 JSON 后提交
      if (values.options && editingQuestion.type !== 'short') {
        try {
          JSON.parse(values.options)
          updates.options = values.options
        } catch {
          message.warning('选项格式不是合法 JSON，将保持原值')
        }
      }

      await questionsApi.updateQuestion(editingQuestion.id, updates)
      message.success('修改成功')
      setEditModal(false)
      loadQuestions()
    } catch (err: any) {
      if (err?.response?.data?.detail) {
        message.error(err.response.data.detail)
      }
    } finally {
      setSaving(false)
    }
  }

  // ── 删除题目 ──
  const handleDelete = async (id: number) => {
    try {
      await questionsApi.deleteQuestion(id)
      message.success('已删除')
      loadQuestions()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  // ── 表格列定义 ──
  const columns = [
    {
      title: '题型',
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (type: string) => (
        <Tag color={TYPE_COLORS[type]}>{TYPE_LABELS[type] || type}</Tag>
      ),
    },
    {
      title: '题目内容',
      dataIndex: 'question_text',
      key: 'question_text',
      ellipsis: true,
      render: (text: string) => (
        <Tooltip title={text}>
          <span style={{ cursor: 'pointer' }}>
            {text.length > 60 ? text.slice(0, 60) + '...' : text}
          </span>
        </Tooltip>
      ),
    },
    {
      title: '知识点',
      dataIndex: 'knowledge_points',
      key: 'knowledge_points',
      width: 150,
      ellipsis: true,
      render: (text: string) => text ? (
        <span style={{ fontSize: 13, color: '#666' }}>{text}</span>
      ) : '-',
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      key: 'difficulty',
      width: 80,
      render: (d: string) => (
        <Tag color={DIFFICULTY_COLORS[d]}>{DIFFICULTY_LABELS[d] || d}</Tag>
      ),
    },
    {
      title: '创建者',
      dataIndex: 'creator_name',
      key: 'creator_name',
      width: 100,
      render: (name: string, record: QuestionInfo) => (
        <span style={{ fontSize: 13, color: '#888' }}>
          {name || record.creator_username}
        </span>
      ),
    },
    {
      title: '配图',
      dataIndex: 'has_svg',
      key: 'has_svg',
      width: 80,
      render: (has_svg: number, record: QuestionInfo) => {
        // 解析 media_files（可能是 JSON 字符串或数组）
        let mf: any[] = []
        if (Array.isArray(record.media_files)) {
          mf = record.media_files
        } else if (typeof record.media_files === 'string') {
          try { mf = JSON.parse(record.media_files) } catch { /* ignore */ }
        }
        // 有 SVG 配图 → 显示 SVG 缩略图
        if (has_svg && record.svg_content) {
          return <SVGViewer svgCode={record.svg_content} description="预览" thumbHeight={50} />
        }
        // 有万相/上传的图片 → 显示第一张缩略图
        if (mf.length > 0 && mf[0].url) {
          return (
            <div style={{ width: 60, height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              <Image src={mf[0].url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                preview={{ mask: null }} />
            </div>
          )
        }
        // 有占位符未生成 → 显示数量标记
        if ((record.media_placeholders?.length || 0) > 0) {
          return (
            <Tooltip title={`${record.media_placeholders?.length} 个占位符`}>
              <Tag color="orange">📷 {record.media_placeholders?.length}</Tag>
            </Tooltip>
          )
        }
        return <span style={{ color: '#ddd' }}>—</span>
      },
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (t: string) => t ? t.slice(0, 16) : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_: any, record: QuestionInfo) => {
        // 权限：管理员（role=0）可操作全部，教师只能操作自己的
        const canEdit = user?.role === 'admin' || record.creator_username === user?.username
        if (!canEdit) return <span style={{ color: '#ccc', fontSize: 12 }}>仅创建者可操作</span>
        return (
          <Space size="small">
            <Tooltip title="编辑">
              <Button type="link" size="small" icon={<EditOutlined />}
                onClick={() => handleEdit(record)} />
            </Tooltip>
            <Tooltip title="配图管理">
              <Button type="link" size="small" icon={<span>🎨</span>}
                onClick={() => handleManageMedia(record)} />
            </Tooltip>
            <Popconfirm
              title="确认删除？"
              description="删除后将无法恢复"
              onConfirm={() => handleDelete(record.id)}
              okText="确认"
              cancelText="取消"
            >
              <Tooltip title="删除">
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 20, fontSize: 14 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        {/* ── 标题和操作栏 ── */}
        <Row justify="space-between" align="middle">
          <Col>
            <Typography.Title level={5} style={{ margin: 0, fontSize: 18 }}>
              📝 试题管理
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              通过 AI 生成或从文本/Word 文档提取试题，统一管理题库
            </Typography.Text>
          </Col>
          <Col>
            <Space>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setShowGeneratePanel(!showGeneratePanel)}
              >
                {showGeneratePanel ? '收起面板' : '生成/提取试题'}
              </Button>
              <Button icon={<ReloadOutlined />} onClick={loadQuestions} loading={loading}>
                刷新
              </Button>
              <Button icon={<ClearOutlined />} onClick={handleDedup} loading={dedupLoading}>
                去重
              </Button>
            </Space>
          </Col>
        </Row>

        {/* ── 试题生成/提取面板 ── */}
        {showGeneratePanel && (
          <Card style={{ border: '1px solid #1677ff22', background: '#fafaff' }}>
            <Tabs
              activeKey={genTab}
              onChange={setGenTab}
              items={[
                {
                  key: 'generate',
                  label: <Space><BookOutlined />AI 生成</Space>,
                  children: (
                    <>
                      <Form
                        form={generateForm}
                        layout="vertical"
                        initialValues={{
                          subject: extractSubject || subjectOptions[0] || '信息科技',
                          question_type: 'single',
                          count: 5,
                          difficulty: 'medium',
                          knowledge_points: '',
                        }}
                        style={{ maxWidth: 800 }}
                      >
                        <Row gutter={16}>
                          <Col span={8}>
                            <Form.Item label="科目" name="subject" rules={[{ required: true }]}>
                              <Select>
                                {subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>)}
                              </Select>
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item label="题型" name="question_type" rules={[{ required: true }]}>
                              <Select>
                                <Option value="single">单选题</Option>
                                <Option value="multiple">多选题</Option>
                                <Option value="true_false">判断题</Option>
                                <Option value="short">简答题</Option>
                              </Select>
                            </Form.Item>
                          </Col>
                          <Col span={4}>
                            <Form.Item label="数量" name="count" rules={[{ required: true }]}>
                              <InputNumber min={1} max={100} style={{ width: '100%' }}
                                onChange={(v) => {
                                  if (v && v > 20) message.warning('超过 20 题生成时间较长，建议减少数量')
                                }}
                              />
                            </Form.Item>
                          </Col>
                          <Col span={4}>
                            <Form.Item label="难度" name="difficulty">
                              <Select>
                                <Option value="easy">简单</Option>
                                <Option value="medium">中等</Option>
                                <Option value="hard">困难</Option>
                              </Select>
                            </Form.Item>
                          </Col>
                        </Row>
                        <Form.Item
                          label="知识点"
                          name="knowledge_points"
                          rules={[{ required: true, message: '请输入知识点' }]}
                        >
                          <TextArea
                            rows={2}
                            placeholder="输入知识点，如：TCP/IP协议、IP地址分类、子网掩码（多个知识点用逗号分隔）"
                          />
                        </Form.Item>
                        <Form.Item>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <Button
                              type="primary"
                              onClick={handleGenerate}
                              loading={generating}
                              icon={generating ? <LoadingOutlined /> : <BookOutlined />}
                              disabled={generating}
                            >
                              {generating ? 'AI 生成中...' : '开始生成'}
                            </Button>
                            {generating && genProgress.text && (
                              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                                {genProgress.text}
                              </Typography.Text>
                            )}
                            {genError && (
                              <Typography.Text type="danger" style={{ fontSize: 13 }}>
                                ❌ {genError}
                              </Typography.Text>
                            )}
                          </div>
                        </Form.Item>
                      </Form>

                      {/* ── 生成结果预览 ── */}
                      {generatedQuestions.length > 0 && (
                        <>
                          <Divider style={{ fontSize: 14 }}>
                            ✅ 已生成 {generatedQuestions.length} 道题（已自动保存到题库）
                          </Divider>
                          {generatedQuestions.map((q, idx) => (
                            <Card
                              key={q.id}
                              size="small"
                              style={{ marginBottom: 8, background: '#f6ffed', border: '1px solid #b7eb8f' }}
                              title={<span style={{ fontSize: 14 }}>#{idx + 1} {TYPE_LABELS[q.type] || q.type}</span>}
                            >
                              <FormulaRenderer content={q.question_text} />
                              {q.options && Object.entries(q.options).map(([k, v]) => (
                                <div key={k} style={{ margin: '4px 0 0 16px', fontSize: 13 }}>
                                  <Tag>{k}</Tag> <FormulaRenderer content={v as string} inline />
                                </div>
                              ))}
                              {q.has_svg === 1 && q.svg_content && (
                                <div style={{ margin: '8px 0' }}>
                                  <SVGViewer svgCode={q.svg_content} description="试题配图" expandable={false} />
                                </div>
                              )}
                              <MediaDisplay svgContent={null} hasSvg={0} mediaFiles={(q as any).media_files} />
                              <div style={{ marginTop: 8, fontSize: 13 }}>
                                <Tag color="green">答案：{q.correct_answer}</Tag>
                                {q.explanation && (
                                  <div style={{ marginTop: 4 }}>
                                    <FormulaRenderer content={q.explanation} />
                                  </div>
                                )}
                              </div>
                            </Card>
                          ))}
                        </>
                      )}
                    </>
                  ),
                },
                {
                  key: 'extract',
                  label: <Space><FileTextOutlined />智能提取</Space>,
                  children: (
                    <>
                      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                        从粘贴文本或上传文档（docx/txt/md/pdf/json）中智能提取试题，自动识别入库。
                      </Typography.Text>
                      <Row gutter={16}>
                        <Col span={8}>
                          <Typography.Text strong style={{ fontSize: 13 }}>科目</Typography.Text>
                          <Select
                            value={extractSubject}
                            onChange={setExtractSubject}
                            style={{ width: '100%', marginTop: 4 }}
                          >
                            {subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>)}
                          </Select>
                        </Col>
                        <Col span={8}>
                          <Typography.Text strong style={{ fontSize: 13 }}>难度</Typography.Text>
                          <Select
                            value={extractDifficulty}
                            onChange={setExtractDifficulty}
                            style={{ width: '100%', marginTop: 4 }}
                          >
                            <Option value="easy">简单</Option>
                            <Option value="medium">中等</Option>
                            <Option value="hard">困难</Option>
                          </Select>
                        </Col>
                        <Col span={8}>
                          <Typography.Text strong style={{ fontSize: 13 }}>上传文档（支持 docx/txt/md/pdf/json）</Typography.Text>
                          <div style={{ marginTop: 4 }}>
                            <Upload
                              accept=".docx,.txt,.md,.pdf,.json"
                              maxCount={1}
                              fileList={extractFile ? [{ uid: '-1', name: extractFile.name, status: 'done' }] : []}
                              beforeUpload={(file) => {
                                const ext = file.name.toLowerCase().split('.').pop()
                                if (!['docx', 'txt', 'md', 'pdf', 'json'].includes(ext || '')) {
                                  message.warning('仅支持 docx/txt/md/pdf/json 格式')
                                  return Upload.LIST_IGNORE
                                }
                                setExtractFile(file)
                                return false
                              }}
                              onRemove={() => setExtractFile(null)}
                            >
                              <Button icon={<UploadOutlined />}>
                                {extractFile ? '更换文件' : '选择文件'}
                              </Button>
                            </Upload>
                          </div>
                        </Col>
                      </Row>
                      <div style={{ marginTop: 12 }}>
                        <Typography.Text strong style={{ fontSize: 13 }}>📷 从图片提取（截图/扫描件，使用视觉模型识别）</Typography.Text>
                        <div style={{ marginTop: 4 }}>
                          <Upload
                            accept=".jpg,.jpeg,.png,.gif,.webp,.bmp"
                            maxCount={1}
                            showUploadList={true}
                            beforeUpload={async (file) => {
                              const fd = new FormData()
                              fd.append('file', file)
                              fd.append('subject', extractSubject || subjectOptions[0] || '信息科技')
                              fd.append('difficulty', extractDifficulty)
                              setExtracting(true)
                              setExtractError(null)
                              setExtractElapsed(0)
                              const startTime = Date.now()
                              const timer = setInterval(() => setExtractElapsed(Math.round((Date.now() - startTime) / 1000)), 1000)
                              try {
                                const { data } = await apiClient.post('/api/questions/extract-from-image', fd, {
                                  headers: { 'Content-Type': 'multipart/form-data' },
                                  timeout: 120000,
                                })
                                setExtractedQuestions(data.questions || [])
                                message.success(data.message || `成功提取 ${data.total || 0} 道试题`)
                              } catch (err: any) {
                                setExtractError(err.response?.data?.detail || err.message || '提取失败，请检查图片是否清晰或联系管理员')
                              } finally {
                                clearInterval(timer)
                                setExtracting(false)
                              }
                              return false
                            }}
                          >
                            <Button icon={<UploadOutlined />}>选择图片</Button>
                          </Upload>
                        </div>
                      </div>
                      <div style={{ marginTop: 16 }}>
                        <Typography.Text strong style={{ fontSize: 13 }}>或粘贴文本内容</Typography.Text>
                        <TextArea
                          rows={6}
                          value={extractText}
                          onChange={(e) => setExtractText(e.target.value)}
                          placeholder={`在此粘贴试题文本，例如：

1. 世界上最大的海洋是？
   A. 大西洋  B. 太平洋  C. 印度洋  D. 北冰洋
   答案：B

2. 计算机的核心部件是？
   A. 显示器  B. 键盘  C. CPU  D. 内存
   答案：C`}
                          style={{ marginTop: 4 }}
                          disabled={!!extractFile}
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
                        <Button
                          type="primary"
                          onClick={handleExtract}
                          loading={extracting}
                          icon={extracting ? <LoadingOutlined /> : <FileTextOutlined />}
                          disabled={extracting || (!extractText.trim() && !extractFile)}
                        >
                          {extracting ? `AI 提取中... ${extractElapsed}s` : '开始提取'}
                        </Button>
                        {extractError && (
                          <Typography.Text type="danger" style={{ fontSize: 13 }}>
                            ❌ {extractError}
                          </Typography.Text>
                        )}
                      </div>

                      {/* ── 提取结果预览 ── */}
                      {extractedQuestions.length > 0 && (
                        <>
                          <Divider style={{ fontSize: 14 }}>
                            ✅ 已提取 {extractedQuestions.length} 道题（已自动保存到题库）
                          </Divider>
                          {extractedQuestions.map((q, idx) => (
                            <Card
                              key={q.id}
                              size="small"
                              style={{ marginBottom: 8, background: '#f6ffed', border: '1px solid #b7eb8f' }}
                              title={<span style={{ fontSize: 14 }}>#{idx + 1} {TYPE_LABELS[q.type] || q.type}</span>}
                            >
                              <FormulaRenderer content={q.question_text} />
                              {q.options && Object.entries(q.options).map(([k, v]) => (
                                <div key={k} style={{ margin: '4px 0 0 16px', fontSize: 13 }}>
                                  <Tag>{k}</Tag> <FormulaRenderer content={v as string} inline />
                                </div>
                              ))}
                              <div style={{ marginTop: 8, fontSize: 13 }}>
                                <Tag color="green">答案：{q.correct_answer}</Tag>
                                {q.explanation && (
                                  <div style={{ marginTop: 4 }}>
                                    <FormulaRenderer content={q.explanation} />
                                  </div>
                                )}
                              </div>
                            </Card>
                          ))}
                        </>
                      )}
                    </>
                  ),
                },
              ]}
            />
          </Card>
        )}

        {/* ── 筛选栏 ── */}
        <Row gutter={12} align="middle" style={{ marginTop: 8 }}>
          <Col>
            <span style={{ fontSize: 13, color: '#888' }}><FilterOutlined /> 筛选：</span>
          </Col>
          <Col span={3}>
            <Select
              allowClear
              placeholder="题型"
              style={{ width: '100%' }}
              value={filters.type}
              onChange={(val) => { setFilters(f => ({ ...f, type: val })); setPage(1) }}
            >
              <Option value="single">单选题</Option>
              <Option value="multiple">多选题</Option>
              <Option value="true_false">判断题</Option>
              <Option value="short">简答题</Option>
            </Select>
          </Col>
          <Col span={3}>
            <Select
              allowClear
              placeholder="难度"
              style={{ width: '100%' }}
              value={filters.difficulty}
              onChange={(val) => { setFilters(f => ({ ...f, difficulty: val })); setPage(1) }}
            >
              <Option value="easy">简单</Option>
              <Option value="medium">中等</Option>
              <Option value="hard">困难</Option>
            </Select>
          </Col>
          <Col span={3}>
            <Select
              allowClear
              placeholder="科目"
              style={{ width: '100%' }}
              value={filters.subject}
              onChange={(val) => { setFilters(f => ({ ...f, subject: val })); setPage(1) }}
            >
              {subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>)}
            </Select>
          </Col>
          <Col span={6}>
            <Input.Search
              placeholder="搜索题目内容或知识点..."
              allowClear
              onSearch={(val) => { setFilters(f => ({ ...f, keyword: val || undefined })); setPage(1) }}
            />
          </Col>
          <Col>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              共 {total} 题
            </Typography.Text>
          </Col>
        </Row>

        {/* ── 题库表格 ── */}
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
            showTotal: (t) => `共 ${t} 题`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
          locale={{ emptyText: <Empty description="题库为空，点击上方「生成试题」开始创建" /> }}
          expandable={{
            expandedRowRender: (record) => (
              <div style={{ padding: '8px 0', maxWidth: 800 }}>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>
                  <FormulaRenderer content={record.question_text} />
                </div>
                <MediaDisplay svgContent={record.svg_content} hasSvg={record.has_svg} mediaFiles={record.media_files} size="normal" />
                {record.type !== 'short' && record.options && Object.entries(record.options).map(([k, v]) => (
                  <div key={k} style={{ margin: '4px 0 0 20px', fontSize: 13, color: '#555' }}>
                    <Tag>{k}</Tag> <FormulaRenderer content={v as string} inline />
                  </div>
                ))}
                {record.type === 'short' && (
                  <div style={{ margin: '4px 0 0 20px', fontSize: 13, color: '#555' }}>
                    参考答案：{record.correct_answer}
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <Tag color="green">正确答案：{record.correct_answer}</Tag>
                  {record.explanation && (
                    <div style={{ marginTop: 4 }}>
                      <FormulaRenderer content={record.explanation} />
                    </div>
                  )}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: '#aaa' }}>
                  知识点：{record.knowledge_points || '-'} | 创建者：{record.creator_name || record.creator_username}
                </div>
              </div>
            ),
          }}
        />
      </Space>

      {/* ── 编辑弹窗 ── */}
      <Modal
        title={`编辑题目 #${editingQuestion?.id}`}
        open={editModal}
        onOk={handleSaveEdit}
        onCancel={() => setEditModal(false)}
        confirmLoading={saving}
        width={700}
        okText="保存"
        cancelText="取消"
      >
        <Form form={editForm} layout="vertical">
          <Form.Item label="题型">
            <Typography.Text>
              <Tag color={TYPE_COLORS[editingQuestion?.type || '']}>
                {TYPE_LABELS[editingQuestion?.type || '']}
              </Tag>
            </Typography.Text>
          </Form.Item>
          <Form.Item
            label="题目内容"
            name="question_text"
            rules={[{ required: true, message: '请输入题目内容' }]}
          >
            <TextArea rows={3} />
          </Form.Item>
          {editingQuestion?.type !== 'short' && (
            <Form.Item
              label="选项（JSON 格式）"
              name="options"
              rules={[{ required: true, message: '请输入选项 JSON' }]}
              extra='格式：{"A":"选项A","B":"选项B","C":"选项C","D":"选项D"}'
            >
              <TextArea rows={4} placeholder='{"A":"选项A","B":"选项B","C":"选项C","D":"选项D"}' />
            </Form.Item>
          )}
          <Form.Item
            label={editingQuestion?.type === 'short' ? '参考答案' : '正确答案'}
            name="correct_answer"
            rules={[{ required: true, message: '请输入正确答案' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item label="解析" name="explanation">
            <TextArea rows={2} placeholder="选填，题目的解析说明" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="知识点" name="knowledge_points">
                <Input placeholder="逗号分隔" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="难度" name="difficulty">
                <Select>
                  <Option value="easy">简单</Option>
                  <Option value="medium">中等</Option>
                  <Option value="hard">困难</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ── 配图管理弹窗 ── */}
      <Modal
        title={`配图管理 #${mediaQuestion?.id}`}
        open={mediaModal}
        onCancel={() => setMediaModal(false)}
        footer={<Button onClick={() => setMediaModal(false)}>关闭</Button>}
        width={700}
      >
        {mediaQuestion && (
          <PlaceholderManager
            questionId={mediaQuestion.id}
            svgContent={mediaQuestion.svg_content}
            hasSvg={mediaQuestion.has_svg}
            placeholders={mediaQuestion.media_placeholders}
            mediaFiles={mediaQuestion.media_files}
            generating={mediaGenerating}
            onRegenerateSVG={handleRegenerateSVG}
            onGenerateMedia={handleGenerateMedia}
            onUploadMedia={handleUploadMedia}
            onDeleteMedia={handleDeleteMedia}
          />
        )}
      </Modal>

      {/* ── 生成进度弹窗（已改为内联显示） ── */}

      {/* ── 去重结果弹窗 ── */}
      <Modal
        title="🧹 去重结果"
        open={dedupResult !== null}
        onCancel={() => setDedupResult(null)}
        footer={<Button onClick={() => setDedupResult(null)}>关闭</Button>}
        width={600}
      >
        {dedupResult && (
          <div>
            <Typography.Title level={4} style={{ color: dedupResult.total_deleted > 0 ? '#52c41a' : '#999' }}>
              {dedupResult.total_deleted > 0
                ? `已删除 ${dedupResult.total_deleted} 条重复试题`
                : '未发现重复试题'}
            </Typography.Title>
            {dedupResult.groups.length > 0 && (
              <>
                <Divider />
                <Typography.Text strong>重复组详情：</Typography.Text>
                <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 12 }}>
                  {dedupResult.groups.map((g, i) => (
                    <div key={i} style={{
                      padding: '8px 12px', marginBottom: 6,
                      background: '#fffbe6', borderRadius: 6,
                      border: '1px solid #ffe58f',
                    }}>
                      <Typography.Text style={{ fontSize: 13 }}>{g.question_text}</Typography.Text>
                      <Tag color="red" style={{ marginLeft: 8 }}>重复 {g.count} 次</Tag>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </Layout>
  )
}

export default QuestionBankPage
