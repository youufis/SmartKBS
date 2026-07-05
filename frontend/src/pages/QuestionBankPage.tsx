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
import { TYPE_LABELS, TYPE_COLORS, TYPE_OPTIONS } from '../constants/questionTypes'

const { TextArea } = Input
const { Option } = Select

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

let subjectOptions: string[] = []

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
  const [optionEntries, setOptionEntries] = useState<{ key: string; value: string }[]>([])
  const [showFormulaHelp, setShowFormulaHelp] = useState(false)

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
    loadQuestions()
  }, [loadQuestions])

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
    total_skipped_owner?: number;
    total_skipped_ref?: number;
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

  // ── 配图管理（粒度 loading 状态） ──
  const [svgLoading, setSvgLoading] = useState(false)
  const [wanxiangLoading, setWanxiangLoading] = useState(false)

  const handleManageMedia = (q: QuestionInfo) => {
    setMediaQuestion(q)
    setMediaModal(true)
  }

  const handleRegenerateSVG = async () => {
    if (!mediaQuestion) return
    setSvgLoading(true)
    try {
      await apiClient.post(`/api/questions/${mediaQuestion.id}/generate-svg`)
      message.success('SVG 已重新生成')
      await loadQuestions()
      // 更新弹窗中的 mediaQuestion
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'SVG 生成失败')
    } finally {
      setSvgLoading(false)
    }
  }

  const handleGenerateImage = async () => {
    if (!mediaQuestion) return
    setWanxiangLoading(true)
    try {
      await apiClient.post(`/api/questions/${mediaQuestion.id}/generate-image`)
      message.success('配图已生成')
      await loadQuestions()
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '生图失败')
    } finally {
      setWanxiangLoading(false)
    }
  }

  const handleDeleteSVG = async () => {
    if (!mediaQuestion) return
    try {
      await apiClient.delete(`/api/questions/${mediaQuestion.id}/svg`)
      message.success('SVG 配图已删除')
      await loadQuestions()
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '删除失败')
    }
  }

  const handleGenerateMedia = async (key: string) => {
    if (!mediaQuestion) return
    // PlaceholderManager 内部管理 per-key loading，父组件仅调用接口
    try {
      await apiClient.post(`/api/questions/${mediaQuestion.id}/generate-media/${key}`)
      message.success('图片已生成')
      await loadQuestions()
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
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
      await apiClient.post(`/api/questions/${mediaQuestion.id}/upload-media/${key}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      message.success('图片已上传')
      await loadQuestions()
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
      await loadQuestions()
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '删除失败')
    }
  }

  // ── 编辑题目 ──
  const handleEdit = (q: QuestionInfo) => {
    setEditingQuestion(q)
    // 解析选项为逐个输入框
    let entries: { key: string; value: string }[] = []
    if (q.options && typeof q.options === 'object') {
      entries = Object.entries(q.options).map(([k, v]) => ({ key: k, value: String(v) }))
    }
    setOptionEntries(entries)
    editForm.setFieldsValue({
      question_text: q.question_text,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
      knowledge_points: q.knowledge_points,
      difficulty: q.difficulty,
    })
    setEditModal(true)
  }

  // ── 选项值变更 ──
  const handleOptionKeyChange = (index: number, newKey: string) => {
    setOptionEntries(prev => prev.map((e, i) => i === index ? { ...e, key: newKey.toUpperCase() } : e))
  }
  const handleOptionValueChange = (index: number, newValue: string) => {
    setOptionEntries(prev => prev.map((e, i) => i === index ? { ...e, value: newValue } : e))
  }
  const handleAddOption = () => {
    const nextKey = String.fromCharCode(65 + optionEntries.length)
    setOptionEntries([...optionEntries, { key: nextKey, value: '' }])
  }
  const handleRemoveOption = (index: number) => {
    setOptionEntries(prev => prev.filter((_, i) => i !== index))
  }

  const handleSaveEdit = async () => {
    if (!editingQuestion) return
    try {
      const values = await editForm.validateFields()
      setSaving(true)

      // 从 optionEntries 构建 options JSON
      let optionsStr = ''
      if (editingQuestion.type !== 'short' && optionEntries.length > 0) {
        const optObj: Record<string, string> = {}
        for (const e of optionEntries) {
          if (e.key && e.value) optObj[e.key] = e.value
        }
        if (Object.keys(optObj).length > 0) {
          optionsStr = JSON.stringify(optObj)
        }
      }

      const updates: any = {
        question_text: values.question_text,
        correct_answer: values.correct_answer,
        explanation: values.explanation,
        knowledge_points: values.knowledge_points,
        difficulty: values.difficulty,
      }

      if (optionsStr) {
        updates.options = optionsStr
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
      const res = await questionsApi.deleteQuestion(id) as any
      if (res?.status === 'error') {
        message.warning(res.message + (res.refs ? `\n${res.refs}` : ''))
        return
      }
      message.success('已删除')
      loadQuestions()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  // ── 表格列定义 ──
  const columns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 72,
      render: (id: number) => (
        <span style={{ fontSize: 12, color: '#999', fontFamily: 'monospace' }}>#{id}</span>
      ),
    },
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
        <Tooltip
          title={<div style={{ maxWidth: 400 }}><FormulaRenderer content={text} /></div>}
          overlayStyle={{ maxWidth: 500 }}
        >
          <span style={{ cursor: 'pointer' }}>
            {text.length > 80 ? (
              <FormulaRenderer content={text.slice(0, 80) + '...'} inline />
            ) : (
              <FormulaRenderer content={text} inline />
            )}
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
                          subject: extractSubject || subjectOptions[0] || '',
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
                                {TYPE_OPTIONS.map(opt => (
                                  <Option key={opt.value} value={opt.value}>{opt.label}</Option>
                                ))}
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
                              fd.append('subject', extractSubject || subjectOptions[0] || '')
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
              {TYPE_OPTIONS.map(opt => (
                <Option key={opt.value} value={opt.value}>{opt.label}</Option>
              ))}
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
                    参考答案：<FormulaRenderer content={record.correct_answer} inline />
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <Tag color="green">正确答案：</Tag>
                  <FormulaRenderer content={record.correct_answer} inline />
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
        width={760}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={editForm} layout="vertical">
          <Form.Item label="题型">
            <Typography.Text>
              <Tag color={TYPE_COLORS[editingQuestion?.type || '']}>
                {TYPE_LABELS[editingQuestion?.type || '']}
              </Tag>
            </Typography.Text>
          </Form.Item>

          {/* ── 题目内容（含公式预览） ── */}
          <Form.Item
            label="题目内容"
            name="question_text"
            rules={[{ required: true, message: '请输入题目内容' }]}
            extra="支持 Markdown 和 LaTeX 公式：行内 $E=mc^2$、独立 $$\sum_{i=1}^n i$$"
          >
            <TextArea rows={3} />
          </Form.Item>
          {/* 公式预览 */}
          <Form.Item shouldUpdate={(prev, cur) => prev.question_text !== cur.question_text} noStyle>
            {({ getFieldValue }) => {
              const qt = getFieldValue('question_text')
              if (!qt) return null
              return (
                <div style={{
                  marginTop: -16, marginBottom: 16, padding: '8px 12px',
                  background: '#f9f9f9', borderRadius: 6, border: '1px solid #e8e8e8',
                }}>
                  <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>📐 实时预览：</div>
                  <div style={{ fontSize: 14, lineHeight: 1.8 }}>
                    <FormulaRenderer content={qt} />
                  </div>
                </div>
              )
            }}
          </Form.Item>

          {/* ── 选项编辑（非简答题） ── */}
          {editingQuestion?.type !== 'short' && (
            <Form.Item label="选项" required>
              <div style={{ border: '1px solid #d9d9d9', borderRadius: 6, padding: 12, background: '#fafafa' }}>
                {optionEntries.length === 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    暂无选项，请添加
                  </Typography.Text>
                )}
                {optionEntries.map((entry, idx) => (
                  <div key={idx} style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <Input
                      style={{ width: 56, textAlign: 'center', fontWeight: 'bold' }}
                      value={entry.key}
                      onChange={(e) => handleOptionKeyChange(idx, e.target.value)}
                      placeholder="键"
                    />
                    <div style={{ flex: 1 }}>
                      <TextArea
                        rows={1}
                        value={entry.value}
                        onChange={(e) => handleOptionValueChange(idx, e.target.value)}
                        placeholder="选项内容（支持公式 $...$）"
                        style={{ minHeight: 32 }}
                      />
                      {/* 选项预览 */}
                      {entry.value && (
                        <div style={{
                          marginTop: 2, padding: '2px 8px',
                          background: '#fff', borderRadius: 4,
                          fontSize: 13, color: '#666',
                          border: '1px dashed #e8e8e8',
                        }}>
                          <FormulaRenderer content={entry.value} inline />
                        </div>
                      )}
                    </div>
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => handleRemoveOption(idx)}
                      disabled={optionEntries.length <= 2}
                    />
                  </div>
                ))}
                <Button
                  size="small"
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={handleAddOption}
                  style={{ marginTop: 4 }}
                >
                  添加选项
                </Button>
              </div>
            </Form.Item>
          )}

          {/* ── 正确答案（含公式预览） ── */}
          <Form.Item
            label={editingQuestion?.type === 'short' ? '参考答案' : '正确答案'}
            name="correct_answer"
            rules={[{ required: true, message: '请输入正确答案' }]}
          >
            <Input placeholder={editingQuestion?.type === 'short' ? '输入参考答案（支持 LaTeX 公式）' : '输入正确答案（如 A 或 A,B,C 或 对）'} />
          </Form.Item>
          {/* 答案预览 */}
          <Form.Item shouldUpdate={(prev, cur) => prev.correct_answer !== cur.correct_answer} noStyle>
            {({ getFieldValue }) => {
              const ca = getFieldValue('correct_answer')
              if (!ca) return null
              return (
                <div style={{
                  marginTop: -16, marginBottom: 16, padding: '4px 12px',
                  background: '#f6ffed', borderRadius: 6, border: '1px solid #b7eb8f',
                }}>
                  <span style={{ fontSize: 12, color: '#52c41a' }}>✅ 预览：</span>
                  <FormulaRenderer content={ca} inline />
                </div>
              )
            }}
          </Form.Item>

          {/* ── 解析（含公式预览） ── */}
          <Form.Item label="解析" name="explanation" extra="选填，支持 Markdown 和 LaTeX 公式">
            <TextArea rows={2} placeholder="选填，题目的解析说明" />
          </Form.Item>
          {/* 解析预览 */}
          <Form.Item shouldUpdate={(prev, cur) => prev.explanation !== cur.explanation} noStyle>
            {({ getFieldValue }) => {
              const exp = getFieldValue('explanation')
              if (!exp) return null
              return (
                <div style={{
                  marginTop: -16, marginBottom: 16, padding: '6px 12px',
                  background: '#f0f5ff', borderRadius: 6, border: '1px solid #d6e4ff',
                  fontSize: 13,
                }}>
                  <span style={{ fontSize: 12, color: '#1677ff' }}>📖 解析预览：</span>
                  <FormulaRenderer content={exp} />
                </div>
              )
            }}
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

          {/* ── 配图管理入口 ── */}
          {editingQuestion && editingQuestion.id > 0 && (
            <div style={{
              padding: '8px 12px', background: '#fffbe6', borderRadius: 6,
              border: '1px solid #ffe58f', marginBottom: 12,
            }}>
              <Space>
                <span>🖼️ 配图管理</span>
                <Button size="small" onClick={() => {
                  handleManageMedia(editingQuestion)
                }}>
                  打开配图管理
                </Button>
                {editingQuestion.has_svg === 1 && (
                  <Tag color="blue">有 SVG</Tag>
                )}
                {editingQuestion.media_files && Array.isArray(editingQuestion.media_files) && editingQuestion.media_files.length > 0 && (
                  <Tag color="green">{editingQuestion.media_files.length} 张配图</Tag>
                )}
                {(editingQuestion.media_placeholders?.length || 0) > 0 && (
                  <Tag color="orange">{editingQuestion.media_placeholders?.length} 个占位符</Tag>
                )}
              </Space>
            </div>
          )}

          {/* ── 公式语法帮助 ── */}
          <div style={{ textAlign: 'right' }}>
            <Button
              type="link"
              size="small"
              onClick={() => setShowFormulaHelp(!showFormulaHelp)}
              style={{ fontSize: 12 }}
            >
              {showFormulaHelp ? '收起' : '展开'} LaTeX 公式帮助 📐
            </Button>
          </div>
          {showFormulaHelp && (
            <div style={{
              padding: '8px 12px', background: '#f6f8fa', borderRadius: 6,
              border: '1px solid #e8e8e8', fontSize: 12, lineHeight: 2, marginBottom: 8,
            }}>
              <Typography.Text strong style={{ fontSize: 13 }}>LaTeX 公式语法示例：</Typography.Text>
              <table style={{ width: '100%', marginTop: 4, borderCollapse: 'collapse' }}>
                <tbody>
                  {[
                    ['行内公式', '$E=mc^2$', '$E=mc^2$'],
                    ['独立公式', '$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$', '$$\\sum_{i=1}^n i$$'],
                    ['分数', '$\\frac{a}{b}$', '$\\frac{a}{b}$'],
                    ['上标/下标', '$x^{2}_{i}$', '$x^{2}_{i}$'],
                    ['平方根', '$\\sqrt{x}$ / $\\sqrt[3]{x}$', '$\\sqrt{x}$'],
                    ['希腊字母', '$\\alpha \\beta \\gamma \\pi$', '$\\alpha \\beta \\gamma \\pi$'],
                    ['化学式', '$\\ce{H2O}$ / $\\ce{CO2}$', '$\\ce{H2O}$'],
                    ['矢量', '$\\vec{v}$ / $\\overrightarrow{AB}$', '$\\vec{v}$'],
                  ].map(([desc, syntax, preview], i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '2px 8px', color: '#666', width: 80 }}>{desc}</td>
                      <td style={{ padding: '2px 8px', fontFamily: 'monospace', fontSize: 11 }}>{syntax}</td>
                      <td style={{ padding: '2px 8px' }}><FormulaRenderer content={preview} inline /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
            {(dedupResult.total_skipped_owner ?? 0) > 0 || (dedupResult.total_skipped_ref ?? 0) > 0 ? (
              <div style={{ marginBottom: 12 }}>
                {(dedupResult.total_skipped_owner ?? 0) > 0 && (
                  <Tag color="orange">{dedupResult.total_skipped_owner} 条因权限不足跳过</Tag>
                )}
                {(dedupResult.total_skipped_ref ?? 0) > 0 && (
                  <Tag color="blue">{dedupResult.total_skipped_ref} 条因被活动引用跳过</Tag>
                )}
              </div>
            ) : null}
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
