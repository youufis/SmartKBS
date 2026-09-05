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
import { useTranslation } from 'react-i18next'
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
  easy: 'easy',
  medium: 'medium',
  hard: 'hard',
}

let subjectOptions: string[] = []

const QuestionBankPage: React.FC = () => {
  const { t } = useTranslation('questions')
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
      message.error(err?.response?.data?.detail || t('loadFailed'))
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
      setGenProgress({ step: 1, text: t('generating'), count: 0, total: totalCount })

      await new Promise(r => setTimeout(r, 100))
      setGenProgress({ step: 2, text: `${t('aiGenerating')} ${totalCount}...`, count: 0, total: totalCount })

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
      const errMsg = err?.response?.data?.detail || err?.message || t('generateFailedRetry')
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
      message.warning(t('uploadDocument'))
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
      const errMsg = err?.response?.data?.detail || err?.message || t('extractFail')
      setExtractError(errMsg)
    } finally {
      if (extractTimerRef.current) clearInterval(extractTimerRef.current)
      setExtracting(false)
    }
  }

  // ── 删除重复试题 ──
  const [dedupResult, setDedupResult] = useState<{
    dry_run?: boolean;
    total_deleted: number;
    deletable_count?: number;
    total_skipped_owner?: number;
    total_skipped_ref?: number;
    groups: { question_text: string; count: number }[];
    message: string;
  } | null>(null)
  const [dedupLoading, setDedupLoading] = useState(false)

  // Q4: 先预览重复组(不写库), 用户在结果弹窗里点“确认清理”才真正执行
  const handleDedup = async () => {
    setDedupLoading(true)
    try {
      const res = await questionsApi.dedupQuestions(false)
      setDedupResult(res)
    } catch {
      message.error(t('dedupFail'))
    } finally {
      setDedupLoading(false)
    }
  }

  const runDedupConfirm = async () => {
    setDedupLoading(true)
    try {
      const res = await questionsApi.dedupQuestions(true)
      setDedupResult(res)
      if (res.total_deleted > 0) loadQuestions()
    } catch {
      message.error(t('dedupFail'))
    } finally {
      setDedupLoading(false)
    }
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
      message.success(t('svgRegenerated'))
      await loadQuestions()
      // 更新弹窗中的 mediaQuestion
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('svgGenFail'))
    } finally {
      setSvgLoading(false)
    }
  }

  const handleGenerateImage = async () => {
    if (!mediaQuestion) return
    setWanxiangLoading(true)
    try {
      await apiClient.post(`/api/questions/${mediaQuestion.id}/generate-image`)
      message.success(t('imageGenerated'))
      await loadQuestions()
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('imageGenFail'))
    } finally {
      setWanxiangLoading(false)
    }
  }

  const handleDeleteSVG = async () => {
    if (!mediaQuestion) return
    try {
      await apiClient.delete(`/api/questions/${mediaQuestion.id}/svg`)
      message.success(t('svgDeleted'))
      await loadQuestions()
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('deleteFail'))
    }
  }

  const handleGenerateMedia = async (key: string) => {
    if (!mediaQuestion) return
    // PlaceholderManager 内部管理 per-key loading，父组件仅调用接口
    try {
      await apiClient.post(`/api/questions/${mediaQuestion.id}/generate-media/${key}`)
      message.success(t('imageGenerated'))
      await loadQuestions()
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('imageGenFail'))
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
      message.success(t('imageUploaded'))
      await loadQuestions()
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('uploadFail'))
    }
  }

  const handleDeleteMedia = async (key: string) => {
    if (!mediaQuestion) return
    try {
      await apiClient.delete(`/api/questions/${mediaQuestion.id}/media/${key}`)
      message.success(t('imageDeleted'))
      await loadQuestions()
      const { data } = await apiClient.get(`/api/questions/${mediaQuestion.id}`)
      setMediaQuestion(data)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('deleteFail'))
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
      type: q.type,
      subject: (q as any).subject || '',
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
        explanation: values.explanation ?? '',
        knowledge_points: values.knowledge_points ?? '',
        difficulty: values.difficulty,
        type: values.type,
        subject: values.subject ?? '',
        // 总是回传 options：后端按“字段是否出现”区分未改动与显式清空(Q8)
        options: optionsStr,
      }

      const res = await questionsApi.updateQuestion(editingQuestion.id, updates)
      message.success(t('editSuccess'))
      ;(res?.warnings || []).forEach((w) => message.warning(w, 8))
      setEditModal(false)
      loadQuestions()
    } catch (err: any) {
      if (err?.errorFields) {
        // 表单校验失败, antd 已在字段上标红, 不再重复弹提示
        return
      }
      message.error(err?.response?.data?.detail || err?.message || t('updateFail'))
    } finally {
      setSaving(false)
    }
  }

  // ── 删除题目 ──
  const handleDelete = async (id: number) => {
    try {
      const res = await questionsApi.deleteQuestion(id) as any
      if (res?.status === 'error') {
        message.warning(res.message)
        return
      }
      message.success(t('deleteSuccess'))
      loadQuestions()
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      if (err?.response?.status === 409) {
        // 题目正被考试/练习引用: 提示里已带具体活动名
        message.warning(typeof detail === 'string' ? detail : t('deleteFail'), 10)
      } else {
        message.error(typeof detail === 'string' ? detail : t('deleteFail'))
      }
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
      title: t('questionType'),
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (type: string) => (
        <Tag color={TYPE_COLORS[type]}>{TYPE_LABELS[type] || type}</Tag>
      ),
    },
    {
      title: t('questionContent'),
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
      title: t('knowledgePoints'),
      dataIndex: 'knowledge_points',
      key: 'knowledge_points',
      width: 150,
      ellipsis: true,
      render: (text: string) => text ? (
        <span style={{ fontSize: 13, color: '#666' }}>{text}</span>
      ) : '-',
    },
    {
      title: t('difficulty'),
      dataIndex: 'difficulty',
      key: 'difficulty',
      width: 80,
      render: (d: string) => (
        <Tag color={DIFFICULTY_COLORS[d]}>{t(DIFFICULTY_LABELS[d]) || d}</Tag>
      ),
    },
    {
      title: t('creator'),
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
      title: t('media'),
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
          return <SVGViewer svgCode={record.svg_content} description={t('preview')} thumbHeight={50} />
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
            <Tooltip title={t('placeholderCount', { count: record.media_placeholders?.length || 0 })}>
              <Tag color="orange">📷 {record.media_placeholders?.length}</Tag>
            </Tooltip>
          )
        }
        return <span style={{ color: '#ddd' }}>—</span>
      },
    },
    {
      title: t('time'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (t: string) => t ? t.slice(0, 16) : '-',
    },
    {
      title: t('actions'),
      key: 'action',
      width: 100,
      render: (_: any, record: QuestionInfo) => {
        // 权限：管理员（role=0）可操作全部，教师只能操作自己的
        const canEdit = user?.role === 'admin' || record.creator_username === user?.username
        if (!canEdit) return <span style={{ color: '#ccc', fontSize: 12 }}>{t('onlyCreatorCanOperate')}</span>
        return (
          <Space size="small">
            <Tooltip title={t('editQuestion')}>
              <Button type="link" size="small" icon={<EditOutlined />}
                onClick={() => handleEdit(record)} />
            </Tooltip>
            <Tooltip title={t('imageManagement')}>
              <Button type="link" size="small" icon={<span>🎨</span>}
                onClick={() => handleManageMedia(record)} />
            </Tooltip>
            <Popconfirm
              title={t('confirmDelete')}
              description={t('confirmDeleteDesc')}
              onConfirm={() => handleDelete(record.id)}
              okText={t('confirm')}
              cancelText={t('cancel')}
            >
              <Tooltip title={t('deleteQuestion')}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', fontSize: 14, padding: 24 }}>
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        {/* ── 标题和操作栏 ── */}
        <Row justify="space-between" align="middle">
          <Col>
            <Typography.Title level={5} style={{ margin: 0, fontSize: 18 }}>
              📝 {t('title')}
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {t('title')}
            </Typography.Text>
          </Col>
          <Col>
            <Space>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setShowGeneratePanel(!showGeneratePanel)}
              >
                {showGeneratePanel ? t('collapsePanel') : t('generateExtract')}
              </Button>
              <Button icon={<ReloadOutlined />} onClick={loadQuestions} loading={loading}>
                {t('refresh')}
              </Button>
              <Button icon={<ClearOutlined />} onClick={handleDedup} loading={dedupLoading}>
                {t('dedup')}
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
                  label: <Space><BookOutlined />{t('aiGenerate')}</Space>,
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
                            <Form.Item label={t('subject')} name="subject" rules={[{ required: true }]}>
                              <Select>
                                {subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>)}
                              </Select>
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item label={t('questionType')} name="question_type" rules={[{ required: true }]}>
                              <Select>
                                {TYPE_OPTIONS.map(opt => (
                                  <Option key={opt.value} value={opt.value}>{opt.label}</Option>
                                ))}
                              </Select>
                            </Form.Item>
                          </Col>
                          <Col span={4}>
                            <Form.Item label={t('count')} name="count" rules={[{ required: true }]}>
                              <InputNumber min={1} max={100} style={{ width: '100%' }}
                                onChange={(v) => {
                                  if (v && v > 20) message.warning(t('generateMoreThan20Warn'))
                                }}
                              />
                            </Form.Item>
                          </Col>
                          <Col span={4}>
                            <Form.Item label={t('difficulty')} name="difficulty">
                              <Select>
                                <Option value="easy">{t('easy')}</Option>
                                <Option value="medium">{t('medium')}</Option>
                                <Option value="hard">{t('hard')}</Option>
                              </Select>
                            </Form.Item>
                          </Col>
                        </Row>
                        <Form.Item
                          label={t('knowledgePoints')}
                          name="knowledge_points"
                          rules={[{ required: true, message: t('enterQuestionContent') }]}
                        >
                          <TextArea
                            rows={2}
                            placeholder={t('inputKnowledgePoints')}
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
                              {generating ? t('aiGenerating') : t('startGenerate')}
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
                            {t('generatedCount', { count: generatedQuestions.length })}
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
                                  <SVGViewer svgCode={q.svg_content} description={t('imageManagement')} expandable={false} />
                                </div>
                              )}
                              <MediaDisplay svgContent={null} hasSvg={0} mediaFiles={(q as any).media_files} />
                              <div style={{ marginTop: 8, fontSize: 13 }}>
                                <Tag color="green">{t('answerColon')}{q.correct_answer}</Tag>
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
                  label: <Space><FileTextOutlined />{t('smartExtract')}</Space>,
                  children: (
                    <>
                      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                        {t('smartExtract')}
                      </Typography.Text>
                      <Row gutter={16}>
                        <Col span={8}>
                          <Typography.Text strong style={{ fontSize: 13 }}>{t('subject')}</Typography.Text>
                          <Select
                            value={extractSubject}
                            onChange={setExtractSubject}
                            style={{ width: '100%', marginTop: 4 }}
                          >
                            {subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>)}
                          </Select>
                        </Col>
                        <Col span={8}>
                          <Typography.Text strong style={{ fontSize: 13 }}>{t('difficulty')}</Typography.Text>
                          <Select
                            value={extractDifficulty}
                            onChange={setExtractDifficulty}
                            style={{ width: '100%', marginTop: 4 }}
                          >
                            <Option value="easy">{t('easy')}</Option>
                            <Option value="medium">{t('medium')}</Option>
                            <Option value="hard">{t('hard')}</Option>
                          </Select>
                        </Col>
                        <Col span={8}>
                          <Typography.Text strong style={{ fontSize: 13 }}>{t('uploadDocument')}</Typography.Text>
                          <div style={{ marginTop: 4 }}>
                            <Upload
                              accept=".docx,.txt,.md,.pdf,.json"
                              maxCount={1}
                              fileList={extractFile ? [{ uid: '-1', name: extractFile.name, status: 'done' }] : []}
                              beforeUpload={(file) => {
                                const ext = file.name.toLowerCase().split('.').pop()
                                if (!['docx', 'txt', 'md', 'pdf', 'json'].includes(ext || '')) {
                                  message.warning(t('formatSupport'))
                                  return Upload.LIST_IGNORE
                                }
                                setExtractFile(file)
                                return false
                              }}
                              onRemove={() => setExtractFile(null)}
                            >
                              <Button icon={<UploadOutlined />}>
                                {extractFile ? t('fileReplace') : t('selectFile')}
                              </Button>
                            </Upload>
                          </div>
                        </Col>
                      </Row>
                      <div style={{ marginTop: 12 }}>
                        <Typography.Text strong style={{ fontSize: 13 }}>📷 {t('imageExtract')}</Typography.Text>
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
                                message.success(data.message || t('extractedCount', { count: data.total || 0 }))
                                loadQuestions()
                              } catch (err: any) {
                                setExtractError(err.response?.data?.detail || err.message || t('extractFail'))
                              } finally {
                                clearInterval(timer)
                                setExtracting(false)
                              }
                              return false
                            }}
                          >
                            <Button icon={<UploadOutlined />}>{t('selectImage')}</Button>
                          </Upload>
                        </div>
                      </div>
                      <div style={{ marginTop: 16 }}>
                        <Typography.Text strong style={{ fontSize: 13 }}>{t('orPasteText')}</Typography.Text>
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
                          {extracting ? t('extractingWithTime', { time: extractElapsed }) : t('startExtract')}
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
                            {t('extractedCount', { count: extractedQuestions.length })}
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
                                <Tag color="green">{t('answerColon')}{q.correct_answer}</Tag>
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
            <span style={{ fontSize: 13, color: '#888' }}><FilterOutlined /> {t('filter')}：</span>
          </Col>
          <Col span={3}>
            <Select
              allowClear
              placeholder={t('questionType')}
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
              placeholder={t('difficulty')}
              style={{ width: '100%' }}
              value={filters.difficulty}
              onChange={(val) => { setFilters(f => ({ ...f, difficulty: val })); setPage(1) }}
            >
              <Option value="easy">{t('easy')}</Option>
              <Option value="medium">{t('medium')}</Option>
              <Option value="hard">{t('hard')}</Option>
            </Select>
          </Col>
          <Col span={3}>
            <Select
              allowClear
              placeholder={t('subject')}
              style={{ width: '100%' }}
              value={filters.subject}
              onChange={(val) => { setFilters(f => ({ ...f, subject: val })); setPage(1) }}
            >
              {subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>)}
            </Select>
          </Col>
          <Col span={6}>
            <Input.Search
              placeholder={t('searchContentOrKp')}
              allowClear
              onSearch={(val) => { setFilters(f => ({ ...f, keyword: val || undefined })); setPage(1) }}
            />
          </Col>
          <Col>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {t('totalQuestions', { count: total })}
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
            showTotal: (total) => t('totalQuestions', { count: total }),
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
          locale={{ emptyText: <Empty description={t('emptyQuestions')} /> }}
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
                    {t('referenceAnswer')}：<FormulaRenderer content={record.correct_answer} inline />
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <Tag color="green">{t('correctAnswerColon')}</Tag>
                  <FormulaRenderer content={record.correct_answer} inline />
                  {record.explanation && (
                    <div style={{ marginTop: 4 }}>
                      <FormulaRenderer content={record.explanation} />
                    </div>
                  )}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: '#aaa' }}>
                  {t('knowledgePointColon')}{record.knowledge_points || '-'} | {t('creator')}：{record.creator_name || record.creator_username}
                </div>
              </div>
            ),
          }}
        />
      </Space>

      {/* ── 编辑弹窗 ── */}
      <Modal
        title={t('editQuestion_', { id: editingQuestion?.id })}
        open={editModal}
        onOk={handleSaveEdit}
        onCancel={() => setEditModal(false)}
        confirmLoading={saving}
        width={760}
        okText={t('save')}
        cancelText={t('cancel')}
        destroyOnHidden
      >
        <Form
          form={editForm}
          layout="vertical"
          onValuesChange={(_, all: any) => setEditingQuestion((prev) => (
            prev ? { ...prev, type: all.type ?? prev.type, subject: all.subject ?? prev.subject } : prev
          ))}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t('questionType')} name="type">
                <Select
                  showSearch
                  optionFilterProp="children"
                  suffixIcon={
                    <Tag color={TYPE_COLORS[editingQuestion?.type || '']} style={{ margin: 0, lineHeight: '18px' }}>
                      {TYPE_LABELS[editingQuestion?.type || '']}
                    </Tag>
                  }
                >
                  {TYPE_OPTIONS.map((o) => (
                    <Option key={o.value} value={o.value}>{o.label}</Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('subject')} name="subject">
                <Input placeholder={t('subject')} allowClear />
              </Form.Item>
            </Col>
          </Row>

          {/* ── 题目内容（含公式预览） ── */}
          <Form.Item
            label={t('questionContent')}
            name="question_text"
            rules={[{ required: true, message: t('enterQuestionContent') }]}
            extra={t('formulaSupport')}
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
                  <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>📐 {t('livePreview')}：</div>
                  <div style={{ fontSize: 14, lineHeight: 1.8 }}>
                    <FormulaRenderer content={qt} />
                  </div>
                </div>
              )
            }}
          </Form.Item>

          {/* ── 选项编辑（非简答题） ── */}
          {editingQuestion?.type !== 'short' && (
            <Form.Item label={t('options')} required>
              <div style={{ border: '1px solid #d9d9d9', borderRadius: 6, padding: 12, background: '#fafafa' }}>
                {optionEntries.length === 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    {t('noOptionsYet')}
                  </Typography.Text> 
                )}
                {optionEntries.map((entry, idx) => (
                  <div key={idx} style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <Input
                      style={{ width: 56, textAlign: 'center', fontWeight: 'bold' }}
                      value={entry.key}
                      onChange={(e) => handleOptionKeyChange(idx, e.target.value)}
                      placeholder={t('optionKeyPlaceholder')}
                    />
                    <div style={{ flex: 1 }}>
                      <TextArea
                        rows={1}
                        value={entry.value}
                        onChange={(e) => handleOptionValueChange(idx, e.target.value)}
                        placeholder={t('optionValuePlaceholder')}
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
                  {t('addOption')}
                </Button>
              </div>
            </Form.Item>
          )}

          {/* ── 正确答案（含公式预览） ── */}
          <Form.Item
            label={editingQuestion?.type === 'short' ? t('referenceAnswer') : t('correctAnswer')}
            name="correct_answer"
            rules={[{ required: true, message: t('enterQuestionContent') }]}
          >
            <Input placeholder={editingQuestion?.type === 'short' ? t('referenceAnswer') : t('correctAnswer')} />
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
                  <span style={{ fontSize: 12, color: '#52c41a' }}>✅ {t('preview')}：</span>
                  <FormulaRenderer content={ca} inline />
                </div>
              )
            }}
          </Form.Item>

          {/* ── 解析（含公式预览） ── */}
          <Form.Item label={t('explanation')} name="explanation">
            <TextArea rows={2} placeholder={t('explanation')} />
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
                  <span style={{ fontSize: 12, color: '#1677ff' }}>📖 {t('explanationPreview')}：</span>
                  <FormulaRenderer content={exp} />
                </div>
              )
            }}
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t('knowledgePoint')} name="knowledge_points">
                <Input placeholder={t('knowledgePoint')} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('difficulty')} name="difficulty">
                <Select>
                  <Option value="easy">{t('easy')}</Option>
                  <Option value="medium">{t('medium')}</Option>
                  <Option value="hard">{t('hard')}</Option>
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
                <span>🖼️ {t('imageManagement')}</span>
                <Button size="small" onClick={() => {
                  handleManageMedia(editingQuestion)
                }}>
                  {t('imageManagement')}
                </Button>
                {editingQuestion.has_svg === 1 && (
                  <Tag color="blue">{t('hasSvg')}</Tag>
                )}
                {editingQuestion.media_files && Array.isArray(editingQuestion.media_files) && editingQuestion.media_files.length > 0 && (
                  <Tag color="green">{t('imageCount', { count: editingQuestion.media_files.length })}</Tag>
                )}
                {(editingQuestion.media_placeholders?.length || 0) > 0 && (
                  <Tag color="orange">{t('placeholderCount', { count: editingQuestion.media_placeholders?.length || 0 })}</Tag>
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
              {showFormulaHelp ? t('collapsePanel') : t('preview')} LaTeX 📐
            </Button>
          </div>
          {showFormulaHelp && (
            <div style={{
              padding: '8px 12px', background: '#f6f8fa', borderRadius: 6,
              border: '1px solid #e8e8e8', fontSize: 12, lineHeight: 2, marginBottom: 8,
            }}>
              <Typography.Text strong style={{ fontSize: 13 }}>{t('latexExamplesTitle')}</Typography.Text>
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
        title={`${t('imageManagement')} #${mediaQuestion?.id}`}
        open={mediaModal}
        onCancel={() => setMediaModal(false)}
        footer={<Button onClick={() => setMediaModal(false)}>{t('close')}</Button>}
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
        title="🧹"
        open={dedupResult !== null}
        onCancel={() => setDedupResult(null)}
        footer={
          <Space>
            <Button onClick={() => setDedupResult(null)}>{t('close')}</Button>
            {dedupResult?.dry_run && (dedupResult?.deletable_count ?? 0) > 0 && (
              <Button type="primary" danger loading={dedupLoading} onClick={runDedupConfirm}>
                {t('dedupRun')}
              </Button>
            )}
          </Space>
        }
        width={600}
      >
        {dedupResult && (
          <div>
            <Typography.Title level={4} style={{ color: dedupResult.total_deleted > 0 ? '#52c41a' : '#999' }}>
              {dedupResult.dry_run
                ? (dedupResult.deletable_count ?? 0) > 0
                  ? t('dedupFound', { groups: dedupResult.groups.length, count: dedupResult.deletable_count ?? 0 })
                  : t('noDuplicates')
                : dedupResult.total_deleted > 0
                  ? t('dedupDeletedCount', { count: dedupResult.total_deleted })
                  : t('noDuplicates')}
            </Typography.Title>
            {(dedupResult.total_skipped_owner ?? 0) > 0 || (dedupResult.total_skipped_ref ?? 0) > 0 ? (
              <div style={{ marginBottom: 12 }}>
                {(dedupResult.total_skipped_owner ?? 0) > 0 && (
                  <Tag color="orange">{t('dedupSkipOwner', { count: dedupResult.total_skipped_owner ?? 0 })}</Tag>
                )}
                {(dedupResult.total_skipped_ref ?? 0) > 0 && (
                  <Tag color="blue">{t('dedupSkipRef', { count: dedupResult.total_skipped_ref ?? 0 })}</Tag>
                )}
              </div>
            ) : null}
            {dedupResult.groups.length > 0 && (
              <>
                <Divider />
                <Typography.Text strong>{t('dupGroupDetail')}</Typography.Text>
                <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 12 }}>
                  {dedupResult.groups.map((g, i) => (
                    <div key={i} style={{
                      padding: '8px 12px', marginBottom: 6,
                      background: '#fffbe6', borderRadius: 6,
                      border: '1px solid #ffe58f',
                    }}>
                      <Typography.Text style={{ fontSize: 13 }}>{g.question_text}</Typography.Text>
                      <Tag color="red" style={{ marginLeft: 8 }}>{t('dupTimes', { count: g.count })}</Tag>
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
