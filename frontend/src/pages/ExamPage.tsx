import React, { useState, useEffect, useCallback } from 'react'
import {
  Layout, Card, Table, Button, message, Modal, Form, Input, Select,
  InputNumber, Tag, Space, Typography, Tooltip, Popconfirm, Row, Col,
  Divider, Empty, Tabs, Spin, Statistic,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined,
  PlayCircleOutlined, PauseCircleOutlined,
  CheckCircleOutlined, BarChartOutlined,
  OrderedListOutlined, FileAddOutlined, SaveOutlined,
  DownloadOutlined, BulbOutlined, FileOutlined, RobotOutlined,
  FileTextOutlined,
} from '@ant-design/icons'
import * as examsApi from '../api/exams'
import * as questionsApi from '../api/questions'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import type { ExamInfo, ExamAttempt } from '../types'

import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import { TYPE_OPTIONS } from '../constants/questionTypes'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'

const { TextArea } = Input
const { Option } = Select

const STATUS_COLORS: Record<string, string> = {
  draft: 'default',
  published: 'green',
  ended: 'red',
}

// 课程列表将从后端动态加载
let subjectOptions: string[] = []

const ExamPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'
  const { t } = useTranslation('exam')

  // 题型标签映射
  const typeLabel = (type: string): string => {
    const map: Record<string, string> = {
      single: t('singleChoice'),
      multiple: t('multipleChoice'),
      true_false: t('trueFalse'),
      short: t('shortAnswer'),
      fill: t('fillBlank'),
      essay: t('essay'),
      subjective: t('subjective'),
    }
    return map[type] || type
  }

  // 难度标签映射
  const difficultyLabel = (d: string): string => {
    const map: Record<string, string> = {
      easy: t('easy'),
      medium: t('medium'),
      hard: t('hard'),
    }
    return map[d] || d
  }

  const STATUS_LABELS: Record<string, string> = {
    draft: t('draft'),
    published: t('published'),
    ended: t('ended'),
  }

  // 从后端加载课程列表
  const [subjects, setSubjects] = useState<string[]>([])
  useEffect(() => {
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) {
        setSubjects(data.subjects)
        subjectOptions = data.subjects
      }
    }).catch(() => {})
  }, [])

  // ── 考试列表 ──
  const [exams, setExams] = useState<ExamInfo[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [statusFilter, setStatusFilter] = useState<string | undefined>()

  // ── 创建/编辑弹窗 ──
  const [createModal, setCreateModal] = useState(false)
  const [editModal, setEditModal] = useState(false)
  const [editingExam, setEditingExam] = useState<ExamInfo | null>(null)
  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()
  const [saving, setSaving] = useState(false)

  // ── 题目管理弹窗 ──
  const [questionModal, setQuestionModal] = useState(false)
  const [questionExam, setQuestionExam] = useState<ExamInfo | null>(null)
  const [examQuestions, setExamQuestions] = useState<any[]>([])
  const [allQuestions, setAllQuestions] = useState<any[]>([])
  const [selectedQIds, setSelectedQIds] = useState<number[]>([])
  const [qLoading, setQLoading] = useState(false)
  const [qPage, setQPage] = useState(1)
  const [qSubject, setQSubject] = useState<string>()
  const [qType, setQType] = useState<string>()
  const [qDifficulty, setQDifficulty] = useState<string>()
  const [qKeyword, setQKeyword] = useState('')
  const [autoSelectForm] = Form.useForm()
  const [autoSelecting, setAutoSelecting] = useState(false)

  // ── AI 智能组卷 ──
  const [aiComposing, setAiComposing] = useState(false)
  const [aiComposeCount, setAiComposeCount] = useState(10)
  const [aiComposeFocus, setAiComposeFocus] = useState('')

  // ── 成绩查看弹窗 ──
  const [resultModal, setResultModal] = useState(false)
  const [resultExam, setResultExam] = useState<ExamInfo | null>(null)
  const [resultData, setResultData] = useState<any>(null)
  const [resultLoading, setResultLoading] = useState(false)

  // ── 学生：我的成绩 ──
  const [myResults, setMyResults] = useState<ExamAttempt[]>([])
  const [myResultsLoading, setMyResultsLoading] = useState(false)

  // ── AI 错题讲解 ──
  const [explainModal, setExplainModal] = useState(false)
  const [explainLoading, setExplainLoading] = useState(false)
  const [explainData, setExplainData] = useState<{ exam_title: string; explanations: any[]; total_wrong: number } | null>(null)
  const handleExplainWrong = async (examId: number) => {
    setExplainModal(true)
    setExplainLoading(true)
    setExplainData(null)
    try {
      const { data } = await apiClient.get(`/api/exams/${examId}/explain-wrong`)
      if (data.task_id) {
        const result = await pollAiTask(data.task_id)
        if (result) setExplainData(result)
        else message.error(t('aiExplainTimeout'))
      } else {
        setExplainData(data)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('aiExplainFailed'))
      setExplainModal(false)
    } finally {
      setExplainLoading(false)
    }
  }

  // ── 学生查看答题详情 ──
  const [detailModal, setDetailModal] = useState(false)
  const [detailData, setDetailData] = useState<any>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const handleViewMyDetail = async (attempt: ExamAttempt) => {
    setDetailModal(true)
    setDetailLoading(true)
    setDetailData(null)
    try {
      const { data } = await apiClient.get(`/api/exams/attempt/${attempt.id}/exam/${attempt.exam_id}`)
      setDetailData(data)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('loadDetailFailed'))
      setDetailModal(false)
    } finally {
      setDetailLoading(false)
    }
  }

  const isAdmin = user?.role === 'admin'

  // ── 加载考试列表 ──
  const loadExams = useCallback(async () => {
    setLoading(true)
    try {
      const scope = isStudent ? 'all' : 'all'
      const res = await examsApi.listExams({
        status: statusFilter,
        scope,
        page,
        page_size: pageSize,
      })
      setExams(res.exams)
      setTotal(res.total)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [statusFilter, page, pageSize, isStudent, t])

  useEffect(() => { const fn = async () => { loadExams() }; fn() }, [loadExams])

  // ── 加载学生成绩 ──
  const loadMyResults = useCallback(async () => {
    if (!isStudent) return
    setMyResultsLoading(true)
    try {
      const res = await examsApi.getMyResults()
      setMyResults(res.results)
    } catch (err: any) {
      console.error('加载考试成绩失败:', err)
      // 不弹出错误提示，静默失败
    } finally {
      setMyResultsLoading(false)
    }
  }, [isStudent])

  useEffect(() => {
    const fn = async () => { if (isStudent) loadMyResults() }
    fn()
  }, [isStudent, loadMyResults])

  // ── 创建考试 ──
  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields()
      setSaving(true)
      const scope = values.activityScope || { target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' }
      const res = await examsApi.createExam({
        title: values.title,
        description: values.description || '',
        subject: values.subject,
        duration: values.duration,
        total_score: values.total_score,
        pass_score: values.pass_score,
        shuffle_questions: values.shuffle_questions !== false,
        shuffle_options: values.shuffle_options !== false,
        show_result_immediately: values.show_result_immediately || false,
        max_attempts: values.max_attempts || 1,
        target_scope: scope.target_scope,
        target_grade: scope.target_grade,
        target_class: scope.target_class,
        target_users: scope.target_users,
      })
      message.success(res.message)
      setCreateModal(false)
      createForm.resetFields()
      loadExams()
    } catch (err: any) {
      if (err?.response?.data?.detail) {
        message.error(err.response.data.detail)
      }
    } finally {
      setSaving(false)
    }
  }

  // ── 编辑考试 ──
  const handleEdit = (exam: ExamInfo) => {
    setEditingExam(exam)
    editForm.setFieldsValue({
      title: exam.title,
      description: exam.description,
      subject: exam.subject,
      duration: exam.duration,
      total_score: exam.total_score,
      pass_score: exam.pass_score,
      shuffle_questions: exam.shuffle_questions === 1,
      shuffle_options: exam.shuffle_options === 1,
      show_result_immediately: exam.show_result_immediately === 1,
      max_attempts: exam.max_attempts,
    })
    setEditModal(true)
  }

  const handleSaveEdit = async () => {
    if (!editingExam) return
    try {
      const values = await editForm.validateFields()
      setSaving(true)
      await examsApi.updateExam(editingExam.id, {
        title: values.title,
        description: values.description,
        subject: values.subject,
        duration: values.duration,
        total_score: values.total_score,
        pass_score: values.pass_score,
        shuffle_questions: values.shuffle_questions !== false,
        shuffle_options: values.shuffle_options !== false,
        show_result_immediately: values.show_result_immediately || false,
        max_attempts: values.max_attempts || 1,
      })
      message.success(t('editSuccess'))
      setEditModal(false)
      loadExams()
    } catch (err: any) {
      if (err?.response?.data?.detail) {
        message.error(err.response.data.detail)
      }
    } finally {
      setSaving(false)
    }
  }

  // ── 删除考试 ──
  const handleDelete = async (id: number) => {
    try {
      await examsApi.deleteExam(id)
      message.success(t('deleteSuccess'))
      loadExams()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('deleteFailed'))
    }
  }

  // ── 发布/结束考试 ──
  const handlePublish = async (id: number) => {
    try {
      const res = await examsApi.publishExam(id)
      message.success(res.message)
      loadExams()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('publishFailed'))
    }
  }

  const handleEnd = async (id: number) => {
    try {
      const res = await examsApi.endExam(id)
      message.success(res.message)
      loadExams()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('operationFailed'))
    }
  }

  // ── 管理题目 ──
  const [scoreInputs, setScoreInputs] = useState<Record<string, number>>({})  // eq_id -> score
  const [savingScores, setSavingScores] = useState(false)

  const handleManageQuestions = async (exam: ExamInfo) => {
    setQuestionExam(exam)
    setQuestionModal(true)
    setSelectedQIds([])
    setQPage(1)
    setScoreInputs({})
    await loadExamQuestions(exam.id)
  }

  const loadExamQuestions = async (examId: number) => {
    setQLoading(true)
    try {
      const detail = await examsApi.getExam(examId)
      const questions = detail.questions || []
      setExamQuestions(questions)
      // 初始化可编辑分值映射 (使用 eq_id)
      const scores: Record<string, number> = {}
      questions.forEach((q: any) => { scores[String(q.eq_id)] = q.question_score })
      setScoreInputs(scores)
    } catch {
      setExamQuestions([])
    } finally {
      setQLoading(false)
    }
  }

  const [qTotal, setQTotal] = useState(0)

  const loadAllQuestions = async (page?: number) => {
    try {
      const targetPage = page ?? 1
      const res = await questionsApi.listQuestions({
        page: targetPage,
        page_size: 10,
        keyword: qKeyword || undefined,
        subject: qSubject || undefined,
        type: qType || undefined,
        difficulty: qDifficulty || undefined,
      })
      setAllQuestions(res.questions || [])
      setQTotal(res.total || 0)
      setQPage(targetPage)
    } catch {
      setAllQuestions([])
      setQTotal(0)
    }
  }

  useEffect(() => {
    const fn = async () => { if (questionModal) { loadAllQuestions(1) } }
    fn()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionModal, qSubject, qType, qDifficulty])

  // ── 计算当前总分 ──
  const currentTotal = Object.values(scoreInputs).reduce((s, v) => s + (Number(v) || 0), 0)
  const expectedTotal = questionExam?.total_score || 100
  const totalBalanced = Math.abs(currentTotal - expectedTotal) < 0.1

  // ── 更新单题分值 ──
  const handleScoreChange = (eqId: string, value: number | null) => {
    setScoreInputs(prev => ({ ...prev, [eqId]: value ?? 0 }))
  }

  // ── 自动均衡 ──
  const handleAutoBalance = async () => {
    if (!questionExam) return
    try {
      const res = await examsApi.autoBalanceScores(questionExam.id)
      message.success(res.message)
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('autoBalanceFailed'))
    }
  }

  // ── 批量保存分值 ──
  const handleSaveScores = async () => {
    if (!questionExam) return
    setSavingScores(true)
    try {
      const res = await examsApi.batchUpdateScores(questionExam.id, scoreInputs)
      if (res.balanced) {
        message.success(res.message)
      } else {
        message.warning(t('scoreMismatch', { current: res.current_total, expected: res.expected_total }))
      }
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('saveScoreFailed'))
    } finally {
      setSavingScores(false)
    }
  }

  // ── 已添加题目的 ID 集合（用于禁用重复选择） ──
  const existingQuestionIds = new Set(examQuestions.map((q: any) => q.id))

  // ── 过滤掉已存在的重复项 ──
  const newSelectedIds = selectedQIds.filter(id => !existingQuestionIds.has(id))
  const hasDuplicatesInSelection = newSelectedIds.length !== selectedQIds.length

  const handleAddQuestions = async () => {
    if (!questionExam || selectedQIds.length === 0) {
      message.warning(t('selectQuestionsFirst'))
      return
    }
    // 自动过滤掉已存在的题目
    const toAdd = newSelectedIds
    if (toAdd.length === 0) {
      message.warning(t('allQuestionsExist'))
      return
    }
    try {
      const res = await examsApi.addQuestionsToExam(questionExam.id, toAdd)
      if (res.skipped_existing) {
        message.warning(t('questionsAdded', { added: res.added, skipped: res.skipped_existing }))
      } else {
        message.success(res.message)
      }
      setSelectedQIds([])
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('addFailed'))
    }
  }

  const handleRemoveQuestion = async (qId: number) => {
    if (!questionExam) return
    try {
      await examsApi.removeQuestionsFromExam(questionExam.id, [qId])
      message.success(t('removed'))
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('removeFailed'))
    }
  }

  // ── 智能选题 ──
  const handleAutoSelect = async () => {
    if (!questionExam) return
    try {
      const values = await autoSelectForm.validateFields()
      setAutoSelecting(true)
      const res = await examsApi.autoSelectQuestions(questionExam.id, {
        subject: values.subject || undefined,
        question_types: values.question_types?.length ? values.question_types : undefined,
        difficulty: values.difficulty || undefined,
        knowledge_keyword: values.knowledge_keyword || undefined,
        count: values.count || 10,
        exclude_existing: true,
      })
      message.success(res.message)
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      if (err?.response?.data?.detail) {
        message.error(err.response.data.detail)
      }
    } finally {
      setAutoSelecting(false)
    }
  }

  // ── AI 智能组卷 ──
  const handleAiCompose = async () => {
    if (!questionExam) return
    setAiComposing(true)
    try {
      const { data } = await apiClient.post(`/api/exams/${questionExam.id}/ai-compose`, {
        target_count: aiComposeCount,
        knowledge_focus: aiComposeFocus,
      })
      message.success(data.message || t('composeSuccess'))
      if (data.reason) {
        Modal.info({
          title: t('cwPlanTitle'),
          content: data.reason,
        })
      }
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('composeFailed'))
    } finally {
      setAiComposing(false)
    }
  }

  // ── 查看成绩 ──
  const handleViewResults = async (exam: ExamInfo) => {
    setResultExam(exam)
    setResultModal(true)
    setResultLoading(true)
    try {
      const res = await examsApi.getExamResults(exam.id)
      setResultData(res)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('loadScoreFailed'))
    } finally {
      setResultLoading(false)
    }
  }

  // ── 参加考试 ──
  const handleTakeExam = async (examId: number) => {
    navigate(`/exam-take/${examId}`)
  }

  // ── 智能组卷导航 ──
  const handleComposeExam = (examId: number) => {
    navigate(`/exam-compose/${examId}`)
  }

  // ── 导出 Word 试卷 ──
  const handleExportPaper = (examId: number) => {
    const url = examsApi.getExportPaperUrl(examId)
    window.open(url, '_blank')
  }

  // ── 表格列（教师/管理员视图） ──
  const teacherColumns = [
    {
      title: t('examTitle'),
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (text: string, record: ExamInfo) => (
        <Space>
          <span style={{ fontWeight: record.status === 'published' ? 500 : 'normal' }}>{text}</span>
          <Tag color={STATUS_COLORS[record.status]}>{STATUS_LABELS[record.status]}</Tag>
        </Space>
      ),
    },
    {
      title: t('subject'),
      dataIndex: 'subject',
      key: 'subject',
      width: 100,
    },
    {
      title: t('duration'),
      dataIndex: 'duration',
      key: 'duration',
      width: 70,
      render: (v: number) => `${v}${t('minutes')}`,
    },
    {
      title: t('totalScore'),
      dataIndex: 'total_score',
      key: 'total_score',
      width: 60,
    },
    {
      title: t('questionCount'),
      dataIndex: 'question_count',
      key: 'question_count',
      width: 70,
    },
    {
      title: t('creator'),
      dataIndex: 'creator_name',
      key: 'creator_name',
      width: 100,
      render: (name: string, record: ExamInfo) => name || record.creator_username,
    },
    {
      title: t('createdAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 140,
      render: (t: string) => t ? t.slice(0, 16) : '-',
    },
    {
      title: t('actions'),
      key: 'action',
      width: 320,
      render: (_: any, record: ExamInfo) => {
        const canEdit = isAdmin || record.creator_username === user?.username
        return (
          <Space size="small" wrap>
            {record.status === 'draft' && canEdit && (
              <>
                <Tooltip title={t('editExam')}>
                  <Button type="link" size="small" icon={<EditOutlined />}
                    onClick={() => handleEdit(record)} />
                </Tooltip>
                <Tooltip title={t('manageQuestions')}>
                  <Button type="link" size="small" icon={<OrderedListOutlined />}
                    onClick={() => handleManageQuestions(record)} />
                </Tooltip>
                <Tooltip title={t('composeExam')}>
                  <Button type="link" size="small" icon={<RobotOutlined />}
                    style={{ color: '#722ed1' }}
                    onClick={() => handleComposeExam(record.id)} />
                </Tooltip>
                <Popconfirm title={t('confirmPublish')} description={t('publishDesc')}
                  onConfirm={() => handlePublish(record.id)} okText={t('publish')} cancelText={t('cancel')}>
                  <Tooltip title={t('publish')}>
                    <Button type="link" size="small" icon={<PlayCircleOutlined />}
                      style={{ color: '#52c41a' }} />
                  </Tooltip>
                </Popconfirm>
                <Popconfirm title={t('confirmDelete')} onConfirm={() => handleDelete(record.id)}
                  okText={t('confirm')} cancelText={t('cancel')}>
                  <Tooltip title={t('deleteExam')}>
                    <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                  </Tooltip>
                </Popconfirm>
              </>
            )}
            {record.status === 'published' && canEdit && (
              <>
                <Tooltip title={t('manageQuestions')}>
                  <Button type="link" size="small" icon={<OrderedListOutlined />}
                    onClick={() => handleManageQuestions(record)} />
                </Tooltip>
                <Tooltip title={t('exportPaper')}>
                  <Button type="link" size="small" icon={<FileTextOutlined />}
                    style={{ color: '#1677ff' }}
                    onClick={() => handleExportPaper(record.id)} />
                </Tooltip>
                <Tooltip title={t('reviewExam')}>
                  <Button type="link" size="small" icon={<BarChartOutlined />}
                    onClick={() => handleViewResults(record)} />
                </Tooltip>
                <Popconfirm title={t('confirmEnd')} description={t('endDesc')}
                  onConfirm={() => handleEnd(record.id)} okText={t('end')} cancelText={t('cancel')}>
                  <Tooltip title={t('endExam')}>
                    <Button type="link" size="small" icon={<PauseCircleOutlined />}
                      style={{ color: '#ff4d4f' }} />
                  </Tooltip>
                </Popconfirm>
              </>
            )}
            {record.status === 'ended' && canEdit && (
              <>
                <Tooltip title={t('exportPaper')}>
                  <Button type="link" size="small" icon={<FileTextOutlined />}
                    style={{ color: '#1677ff' }}
                    onClick={() => handleExportPaper(record.id)} />
                </Tooltip>
                <Tooltip title={t('reviewExam')}>
                  <Button type="link" size="small" icon={<BarChartOutlined />}
                    onClick={() => handleViewResults(record)} />
                </Tooltip>
                <Popconfirm title={t('confirmDelete')} onConfirm={() => handleDelete(record.id)}
                  okText={t('confirm')} cancelText={t('cancel')}>
                  <Tooltip title={t('deleteExam')}>
                    <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                  </Tooltip>
                </Popconfirm>
              </>
            )}
          </Space>
        )
      },
    },
  ]

  // ── 表格列（学生视图） ──
  const studentColumns = [
    {
      title: t('examTitle'),
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (text: string, record: ExamInfo) => (
        <Space>
          <span>{text}</span>
          {record.status === 'ended' && <Tag color="red">{t('ended')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('subject'),
      dataIndex: 'subject',
      key: 'subject',
      width: 100,
    },
    {
      title: t('publisher'),
      dataIndex: 'creator_name',
      key: 'creator_name',
      width: 90,
      render: (name: string, record: ExamInfo) => <Tag color="blue">{name || record.creator_username || '-'}</Tag>,
    },
    {
      title: t('duration'),
      dataIndex: 'duration',
      key: 'duration',
      width: 70,
      render: (v: number) => `${v}${t('minutes')}`,
    },
    {
      title: t('totalScore'),
      dataIndex: 'total_score',
      key: 'total_score',
      width: 60,
    },
    {
      title: t('questionCount'),
      dataIndex: 'question_count',
      key: 'question_count',
      width: 70,
    },
    {
      title: t('myStatus'),
      key: 'my_status',
      width: 120,
      render: (_: any, record: ExamInfo) => {
        const attempt = record.my_attempt
        if (!attempt) return <Tag>{t('status')}</Tag>
        if (attempt.status === 'in_progress') return <Tag color="processing">{t('inProgress')}</Tag>
        if (attempt.status === 'submitted') {
          const passed = attempt.score >= (record.pass_score || 60)
          return (
            <Space size={4}>
              <Tag color={passed ? 'green' : 'red'}>{attempt.score}{t('scoreUnit')}</Tag>
              {passed ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : null}
            </Space>
          )
        }
        return <Tag>{attempt.status}</Tag>
      },
    },
    {
      title: t('actions'),
      key: 'action',
      width: 200,
      render: (_: any, record: ExamInfo) => {
        const attempt = record.my_attempt

        if (record.status === 'ended') {
          return (
            <Space>
              {attempt ? (
                <Button size="small" icon={<BarChartOutlined />}
                  onClick={() => handleViewMyDetail(attempt)}>{t('reviewExam')}</Button>
              ) : (
                <Tag>{t('ended')}</Tag>
              )}
            </Space>
          )
        }

        return (
          <Space>
            {!attempt || attempt.status === 'submitted' ? (
              <Button type="primary" size="small"
                icon={<PlayCircleOutlined />}
                onClick={() => handleTakeExam(record.id)}>
                {attempt ? t('retake') : t('startExam')}
              </Button>
            ) : attempt.status === 'in_progress' ? (
              <Button type="primary" size="small"
                onClick={() => handleTakeExam(record.id)}>
                {t('continueExam')}
              </Button>
            ) : null}
          </Space>
        )
      },
    },
  ]

  // ── 创建表单初始值 ──
  const createInitialValues = {
    subject: subjects[0] || '',
    duration: 45,
    total_score: 100,
    pass_score: 60,
    shuffle_questions: true,
    shuffle_options: true,
    show_result_immediately: false,
    max_attempts: 1,
    activityScope: {
      target_scope: 'teacher_classes',
      target_grade: '',
      target_class: '',
      target_users: '',
    } as ActivityScopeValue,
  }

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        {/* ── 标题和操作栏 ── */}
        <Row justify="space-between" align="middle">
          <Col>
            <Typography.Title level={5} style={{ margin: 0, fontSize: 18 }}>
              📋 {t('title')}
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {isStudent ? t('studentDesc') : t('teacherDesc')}
            </Typography.Text>
          </Col>
          <Col>
            <Space>
              {isTeacherOrAdmin && (
                <Button type="primary" icon={<PlusOutlined />}
                  onClick={() => { setCreateModal(true); createForm.resetFields() }}>
                  {t('createExam')}
                </Button>
              )}
              <Button icon={<ReloadOutlined />} onClick={loadExams} loading={loading}>
                {t('refresh')}
              </Button>
            </Space>
          </Col>
        </Row>

        {/* ── 状态筛选 ── */}
        <Row gutter={12} align="middle">
          <Col>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>{t('status')}：</Typography.Text>
          </Col>
          <Col span={3}>
            <Select allowClear placeholder={t('all')} style={{ width: '100%' }}
              value={statusFilter}
              onChange={(val) => { setStatusFilter(val); setPage(1) }}>
              <Option value="draft">{t('draft')}</Option>
              <Option value="published">{t('published')}</Option>
              <Option value="ended">{t('ended')}</Option>
            </Select>
          </Col>
          <Col>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>{t('totalExams', { count: total })}</Typography.Text>
          </Col>
        </Row>

        {/* ── 学生：我的成绩标签 ── */}
        {isStudent && (
          <Tabs defaultActiveKey="exams" onChange={(key) => {
            if (key === 'results') loadMyResults()
          }} items={[
            {
              key: 'exams',
              label: <Space><FileAddOutlined />{t('examList')}</Space>,
              children: (
                <Table dataSource={exams} columns={studentColumns} rowKey="id"
                  loading={loading} size="small"
                  pagination={{
                    current: page, pageSize, total,
                    showSizeChanger: true,
                    showTotal: (total) => t('totalExams', { count: total }),
                    onChange: (p, ps) => { setPage(p); setPageSize(ps) },
                  }}
                  locale={{ emptyText: <Empty description={t('noExams')} /> }}
                />
              ),
            },
            {
              key: 'results',
              label: <Space><BarChartOutlined />{t('result')}</Space>,
              children: (
                <Table dataSource={myResults} rowKey="id" loading={myResultsLoading} size="small"
                  columns={[
                    { title: t('examTitle'), dataIndex: 'exam_title', key: 'exam_title', ellipsis: true },
                    { title: t('subject'), dataIndex: 'exam_subject', key: 'exam_subject', width: 80 },
                    { title: t('publisher'), dataIndex: 'creator_name', key: 'creator_name', width: 90,
                      render: (name: string) => <Tag color="blue">{name || '-'}</Tag> },
                    {
                      title: t('score'), key: 'score', width: 100,
                      render: (_: any, r: ExamAttempt) => {
                        const passed = r.score >= (r.pass_score || 60)
                        return (
                          <Space>
                            <Typography.Text strong style={{ color: passed ? '#52c41a' : '#ff4d4f' }}>
                              {r.score} / {r.total_score}
                            </Typography.Text>
                            {passed ? <Tag color="green">{t('pass')}</Tag> : <Tag color="red">{t('fail')}</Tag>}
                          </Space>
                        )
                      },
                    },
                    {
                      title: t('startTime'), dataIndex: 'submitted_at', key: 'submitted_at', width: 160,
                      render: (t: string) => t ? t.slice(0, 16) : '-',
                    },
                    {
                      title: t('actions'), key: 'actions', width: 200,
                      render: (_: any, r: ExamAttempt) => (
                        <Space>
                          <Button type="link" size="small" icon={<FileOutlined />}
                            onClick={() => handleViewMyDetail(r)}>
                            {t('viewDetail')}
                          </Button>
                          <Button type="link" size="small" icon={<BulbOutlined />}
                            onClick={() => handleExplainWrong(r.exam_id)}>
                            {t('aiExplain')}
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                  locale={{ emptyText: <Empty description={t('noResults')} /> }}
                />
              ),
            },
          ]} />
        )}

        {/* ── 教师/管理员：考试列表 ── */}
        {!isStudent && (
          <Table dataSource={exams} columns={teacherColumns} rowKey="id"
            loading={loading} size="small"
            pagination={{
              current: page, pageSize, total,
              showSizeChanger: true,
              showTotal: (total) => t('totalExams', { count: total }),
              onChange: (p, ps) => { setPage(p); setPageSize(ps) },
            }}
            locale={{ emptyText: <Empty description={t('noExams')} /> }}
            expandable={{
              expandedRowRender: (record) => (
                <div style={{ padding: '8px 0', maxWidth: 800 }}>
                  <Typography.Text style={{ fontSize: 14 }}>{record.description || t('noDescription')}</Typography.Text>
                  <div style={{ marginTop: 8, fontSize: 13, color: '#888' }}>
                    {t('creatorColon')}{record.creator_name || record.creator_username} |
                    {t('durationColon')}{record.duration}{t('minutes')} |
                    {t('passingScoreColon')}{record.pass_score}{t('scoreUnit')}
                  </div>
                </div>
              ),
            }}
          />
        )}
      </Space>

      {/* ── 创建考试弹窗 ── */}
      <Modal title={t('createExam')} open={createModal}
        onCancel={() => setCreateModal(false)}
        onOk={handleCreate} confirmLoading={saving}
        okText={t('createExam')} width={640}>
        <Form form={createForm} layout="vertical"
          initialValues={createInitialValues}>
          <Form.Item label={t('examTitle')} name="title"
            rules={[{ required: true, message: t('examTitleRequired') }]}>
            <Input placeholder={t('examTitlePlaceholder')} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label={t('subject')} name="subject">
                <Select>
                  {subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('duration')} name="duration">
                <InputNumber min={1} max={180} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('maxAttempts')} name="max_attempts">
                <InputNumber min={1} max={10} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t('totalScore')} name="total_score">
                <InputNumber min={1} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('passScore')} name="pass_score">
                <InputNumber min={0} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('description')} name="description">
            <TextArea rows={3} placeholder={t('descriptionPlaceholder')} />
          </Form.Item>

          {/* ── 活动目标范围 ── */}
          <Form.Item label={t('activityScope')} name="activityScope" style={{ marginBottom: 16 }}>
            <ActivityScopeSelector
              showAllOption={isTeacherOrAdmin && user?.role === 'admin'}
            />
          </Form.Item>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label={t('shuffleQuestions')} name="shuffle_questions" valuePropName="checked">
                <Select>
                  <Option value={true}>{t('yes')}</Option>
                  <Option value={false}>{t('no')}</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('shuffleOptions')} name="shuffle_options" valuePropName="checked">
                <Select>
                  <Option value={true}>{t('yes')}</Option>
                  <Option value={false}>{t('no')}</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('showResults')} name="show_result_immediately">
                <Select>
                  <Option value={true}>{t('yes')}</Option>
                  <Option value={false}>{t('no')}</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ── 编辑考试弹窗 ── */}
      <Modal title={t('editExam')} open={editModal}
        onCancel={() => setEditModal(false)}
        onOk={handleSaveEdit} confirmLoading={saving}
        okText={t('save')} width={640}>
        <Form form={editForm} layout="vertical">
          <Form.Item label={t('examTitle')} name="title"
            rules={[{ required: true, message: t('examTitleRequired') }]}>
            <Input />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label={t('subject')} name="subject">
                <Select>
                  {subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('duration')} name="duration">
                <InputNumber min={1} max={180} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('maxAttempts')} name="max_attempts">
                <InputNumber min={1} max={10} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t('totalScore')} name="total_score">
                <InputNumber min={1} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('passScore')} name="pass_score">
                <InputNumber min={0} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('description')} name="description">
            <TextArea rows={3} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label={t('shuffleQuestions')} name="shuffle_questions">
                <Select>
                  <Option value={true}>{t('yes')}</Option>
                  <Option value={false}>{t('no')}</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('shuffleOptions')} name="shuffle_options">
                <Select>
                  <Option value={true}>{t('yes')}</Option>
                  <Option value={false}>{t('no')}</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('showResults')} name="show_result_immediately">
                <Select>
                  <Option value={true}>{t('yes')}</Option>
                  <Option value={false}>{t('no')}</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ── 题目管理弹窗 ── */}
      <Modal title={`${t('manageQuestions')} - ${questionExam?.title || ''}`}
        open={questionModal}
        onCancel={() => setQuestionModal(false)}
        width={960}
        footer={[
          <Button key="close" onClick={() => setQuestionModal(false)}>{t('close')}</Button>,
        ]}>
        <Spin spinning={qLoading}>
          {/* ── 总分指示器 ── */}
          {examQuestions.length > 0 && (
            <Card size="small" style={{ marginBottom: 12, background: totalBalanced ? '#f6ffed' : '#fff7e6', borderColor: totalBalanced ? '#b7eb8f' : '#ffd591' }}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Space>
                  <Typography.Text strong>{t('currentScore')}：</Typography.Text>
                  <Typography.Text strong style={{
                    fontSize: 18, color: totalBalanced ? '#52c41a' : '#fa8c16'
                  }}>
                    {currentTotal.toFixed(1)}
                  </Typography.Text>
                  <Typography.Text> / {expectedTotal}（{t('targetScore')}）</Typography.Text>
                  {totalBalanced
                    ? <Tag color="green" style={{ marginLeft: 8 }}>✅ {t('scoreBalanced')}</Tag>
                    : <Tag color="orange" style={{ marginLeft: 8 }}>
                        ⚠️ {t('scoreDiff')} {(expectedTotal - currentTotal).toFixed(1)} {t('points')}
                      </Tag>
                  }
                </Space>
                <Space>
                  <Button size="small" icon={<ReloadOutlined />} onClick={handleAutoBalance}>
                    {t('autoBalance')}
                  </Button>
                  <Button type="primary" size="small" icon={<SaveOutlined />}
                    loading={savingScores} onClick={handleSaveScores}
                    disabled={!totalBalanced && !window.confirm?.toString()}>
                    {t('saveScore')}
                  </Button>
                </Space>
              </Space>
            </Card>
          )}

          <Typography.Title level={5} style={{ fontSize: 14, marginTop: 0 }}>
            {t('selectedQuestions', { count: examQuestions.length })}
            {examQuestions.length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8, fontWeight: 'normal' }}>
                {t('editableScoreHint')}
              </Typography.Text>
            )}
          </Typography.Title>
          {examQuestions.length === 0 ? (
            <Empty description={t('noQuestionsHint')} />
          ) : (
            <Table dataSource={examQuestions} rowKey="id" size="small" pagination={false}
              columns={[
                { title: '#', key: 'index', width: 40,
                  render: (_: any, __: any, idx: number) => idx + 1 },
                { title: t('questionType'), dataIndex: 'type', width: 70,
                  render: (v: string) => <Tag>{v === 'single' ? t('q_short_single') : v === 'multiple' ? t('q_short_multi') : v === 'true_false' ? t('q_short_tf') : t('q_short_short')}</Tag> },
                { title: t('questionText'), dataIndex: 'question_text', ellipsis: true },
                { title: t('scorePerQuestion'), dataIndex: 'question_score', width: 100,
                  render: (_: any, rec: any) => (
                    <InputNumber
                      size="small"
                      min={0}
                      max={expectedTotal}
                      step={0.5}
                      value={scoreInputs[String(rec.eq_id)]}
                      onChange={(val) => handleScoreChange(String(rec.eq_id), val)}
                      style={{ width: 80 }}
                      variant="outlined"
                    />
                  ),
                },
                { title: t('actions'), width: 70,
                  render: (_: any, rec: any) => (
                    <Popconfirm title={t('removeQuestionConfirm')} onConfirm={() => handleRemoveQuestion(rec.id)}>
                      <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  ),
                },
              ]}
            />
          )}

          <Divider />

          {/* ── 智能选题卡片 ── */}
          <Card
            size="small"
            title={<Space><FileAddOutlined />{t('smartSelect')}</Space>}
            style={{ marginBottom: 16, background: '#fafaff', border: '1px solid #1677ff22' }}
            extra={
              <Button type="primary" size="small" icon={<FileAddOutlined />}
                loading={autoSelecting} onClick={handleAutoSelect}>
                {t('autoSelect')}
              </Button>
            }
          >
            <Form form={autoSelectForm} layout="inline" initialValues={{ count: 10 }}
              style={{ flexWrap: 'wrap', gap: 8 }}>
              <Form.Item name="subject" style={{ minWidth: 120 }}>
                <Select allowClear placeholder={t('subject')}>
                  {subjects.map(s => <Option key={s} value={s}>{s}</Option>)}
                </Select>
              </Form.Item>
              <Form.Item name="question_types" style={{ minWidth: 160 }}>
                <Select allowClear mode="multiple" placeholder={t('questionTypeAny')} maxTagCount={2}>
                  {TYPE_OPTIONS.map(opt => (
                    <Option key={opt.value} value={opt.value}>{opt.label}</Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item name="difficulty" style={{ minWidth: 100 }}>
                <Select allowClear placeholder={t('difficulty')}>
                  <Option value="easy">{t('easy')}</Option>
                  <Option value="medium">{t('medium')}</Option>
                  <Option value="hard">{t('hard')}</Option>
                </Select>
              </Form.Item>
              <Form.Item name="knowledge_keyword" style={{ minWidth: 160 }}>
                <Input placeholder={t('keywordPlaceholder')} />
              </Form.Item>
              <Form.Item name="count" label={t('selectCount')} style={{ width: 100 }}>
                <InputNumber min={1} max={100} />
              </Form.Item>
            </Form>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
              {t('smartSelectHint')}
            </Typography.Text>
          </Card>

          {/* ── AI 智能组卷卡片 ── */}
          <Card
            size="small"
            title={<Space><RobotOutlined />{t('aiCompose')}</Space>}
            style={{ marginBottom: 16, background: '#f0fff0', border: '1px solid #52c41a44' }}
            extra={
              <Button type="primary" size="small" icon={<RobotOutlined />}
                loading={aiComposing} onClick={handleAiCompose}
                disabled={!questionExam?.id}>
                {t('aiComposeButton')}
              </Button>
            }
          >
            <Space wrap style={{ gap: 8 }}>
              <Typography.Text style={{ fontSize: 13 }}>{t('targetCount')}</Typography.Text>
              <InputNumber size="small" min={1} max={100} value={aiComposeCount}
                onChange={(v) => setAiComposeCount(v || 10)} style={{ width: 80 }} />
              <Typography.Text style={{ fontSize: 13 }}>{t('knowledgeFocus')}</Typography.Text>
              <Input size="small" value={aiComposeFocus}
                onChange={(e) => setAiComposeFocus(e.target.value)}
                placeholder={t('aiComposePlaceholder')} style={{ width: 200 }} />
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
              {t('aiComposeHint')}
            </Typography.Text>
          </Card>

          <Typography.Title level={5} style={{ fontSize: 14 }}>
            {t('questionBank')}
          </Typography.Title>
          <Space wrap style={{ marginBottom: 8 }}>
            <Select allowClear placeholder={t('subject')} style={{ width: 120 }}
              value={qSubject} onChange={(v) => { setQSubject(v); setQPage(1) }}>
              {subjects.map(s => <Option key={s} value={s}>{s}</Option>)}
            </Select>
            <Select allowClear placeholder={t('questionType')} style={{ width: 110 }}
              value={qType} onChange={(v) => { setQType(v); setQPage(1) }}>
              {TYPE_OPTIONS.map(opt => (
                <Option key={opt.value} value={opt.value}>{opt.label}</Option>
              ))}
            </Select>
            <Select allowClear placeholder={t('difficulty')} style={{ width: 100 }}
              value={qDifficulty} onChange={(v) => { setQDifficulty(v); setQPage(1) }}>
              <Option value="easy">{t('easy')}</Option>
              <Option value="medium">{t('medium')}</Option>
              <Option value="hard">{t('hard')}</Option>
            </Select>
            <Input.Search placeholder={t('searchQuestions')} allowClear
              value={qKeyword}
              onChange={(e) => setQKeyword(e.target.value)}
              onSearch={(val) => { setQKeyword(val); loadAllQuestions(1) }}
              style={{ width: 220 }} />
            <Button type="primary" icon={<PlusOutlined />}
              disabled={selectedQIds.length === 0}
              onClick={handleAddQuestions}>
              {t('addSelected', { count: selectedQIds.length })}
              {hasDuplicatesInSelection && <Typography.Text style={{ marginLeft: 4, fontSize: 11, opacity: 0.8 }}>({t('newCount', { count: newSelectedIds.length })})</Typography.Text>}
            </Button>
          </Space>
          <Table dataSource={allQuestions} rowKey="id" size="small"
            pagination={{ current: qPage, pageSize: 10, total: qTotal, showSizeChanger: false, showTotal: (total) => t('totalQuestions', { count: total }),
              onChange: (page) => loadAllQuestions(page)
            }}
            rowSelection={{
              selectedRowKeys: selectedQIds,
              onChange: (keys) => setSelectedQIds(keys as number[]),
              getCheckboxProps: (record: any) => ({
                disabled: existingQuestionIds.has(record.id),
              }),
            }}
            columns={[
              { title: t('questionType'), dataIndex: 'type', width: 70,
                render: (t: string) => <Tag>{typeLabel(t)}</Tag> },
              { title: t('questionText'), dataIndex: 'question_text', ellipsis: true,
                render: (text: string, record: any) => (
                  <span style={{ color: existingQuestionIds.has(record.id) ? '#bbb' : undefined }}>
                    {existingQuestionIds.has(record.id) && <Tag color="default" style={{ marginRight: 4, fontSize: 11 }}>{t('added')}</Tag>}
                    {text}
                  </span>
                ),
              },
              { title: t('knowledgePoints'), dataIndex: 'knowledge_points', width: 150, ellipsis: true },
              { title: t('difficulty'), dataIndex: 'difficulty', width: 70,
                render: (d: string) => <Tag>{difficultyLabel(d)}</Tag> },
            ]}
            onRow={(record: any) => ({
              style: { opacity: existingQuestionIds.has(record.id) ? 0.5 : 1, cursor: existingQuestionIds.has(record.id) ? 'not-allowed' : 'pointer' },
            })}
          />
        </Spin>
      </Modal>

      {/* ── 成绩查看弹窗 ── */}
      <Modal title={`${t('result')} - ${resultExam?.title || ''}`}
        open={resultModal}
        onCancel={() => setResultModal(false)}
        width={900}
        footer={[
          <Button key="export" icon={<DownloadOutlined />}
            disabled={!resultExam?.id}
            onClick={() => {
              const token = localStorage.getItem('smartkb_token')
              window.open(`/api/export/exam/${resultExam?.id}?token=${token}`, '_blank')
            }}>{t('exportReport')}</Button>,
          <Button key="close" onClick={() => setResultModal(false)}>{t('close')}</Button>,
        ]}>
        <Spin spinning={resultLoading}>
          {resultData && (
            <>
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title={t('totalStudents')} value={resultData.statistics.total_students} />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title={t('average')} value={resultData.statistics.avg_score} precision={1} />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title={t('passCount')} value={resultData.statistics.pass_count}
                      suffix={`/ ${resultData.statistics.total_students}`} />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title={t('passRate')} value={resultData.statistics.pass_rate}
                      suffix="%" precision={1} />
                  </Card>
                </Col>
              </Row>
              <Table dataSource={resultData.attempts} rowKey="id" size="small"
                columns={[
                  { title: t('student'), dataIndex: 'student_name', key: 'student_name', width: 100 },
                  { title: t('score'), key: 'score', width: 100,
                    render: (_: any, r: ExamAttempt) => {
                      const passed = r.score >= (resultExam?.pass_score || 60)
                      return <span style={{ color: passed ? '#52c41a' : '#ff4d4f', fontWeight: 600 }}>{r.score} / {r.total_score}</span>
                    },
                  },
                  { title: t('submittedAt'), dataIndex: 'submitted_at', key: 'submitted_at', width: 160,
                    render: (t: string) => t ? t.slice(0, 16) : '-' },
                ]}
                pagination={false}
                expandable={{
                  expandedRowRender: (record: any) => <StudentExamDetail
                    examId={resultExam?.id ?? 0}
                    attemptId={record.id}
                    studentName={record.student_name}
                    showReview={true}
                  />,
                  rowExpandable: () => true,
                }}
              />
            </>
          )}
        </Spin>
      </Modal>

      {/* ── AI 错题讲解弹窗 ── */}
      <Modal title={<><BulbOutlined style={{ color: '#faad14' }} /> {t('aiExplainTitle')} - {explainData?.exam_title || t('loading')}</>}
        open={explainModal}
        onCancel={() => { if (explainLoading) return; setExplainModal(false) }}
        width={800}
        footer={explainLoading ? null : <Button onClick={() => setExplainModal(false)}>{t('close')}</Button>}
      >
        {explainLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: '#666' }}>{t('aiAnalyzing')}</div>
          </div>
        ) : explainData ? (
          <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
            {explainData.total_wrong === 0 ? (
              <Typography.Text type="success" style={{ fontSize: 16 }}>
                <CheckCircleOutlined /> {t('noWrongAnswers')}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
                {t('totalWrong')} {explainData.total_wrong} {t('questions')}
              </Typography.Text>
            )}
            {explainData.explanations.map((exp: any, idx: number) => (
              <Card key={idx} size="small" style={{ marginBottom: 12 }}
                title={<Space><Tag color="error">{t('wrongQuestion')} {idx + 1}</Tag><FormulaRenderer content={exp.question_text} /></Space>}>
                {exp.error ? (
                  <Typography.Text type="danger">{exp.error}</Typography.Text>
                ) : (
                  <div className="markdown-content">
                    <FormulaRenderer content={exp.explanation} />
                  </div>
                )}
              </Card>
            ))}
          </div>
        ) : null}
      </Modal>

      {/* ── 答题详情弹窗（学生查看） ── */}
      <Modal title={t('detailTitle')} open={detailModal}
        onCancel={() => setDetailModal(false)}
        width={800}
        footer={<Button onClick={() => setDetailModal(false)}>{t('close')}</Button>}
      >
        <Spin spinning={detailLoading}>
          {detailData ? (
            <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
              {detailData.attempt ? (
                <>
              <Card size="small" style={{ marginBottom: 16 }}>
                <Space>
                  <Statistic title={t('score')} value={detailData.attempt.score} suffix={`/ ${detailData.attempt.total_score}`}
                    styles={{ content: { color: detailData.attempt.score >= (detailData.attempt.total_score || 100) * 0.6 ? '#52c41a' : '#ff4d4f' } }} />
                </Space>
              </Card>
              {(!detailData.questions || detailData.questions.length === 0) ? (
                <Typography.Text type="secondary">{t('noQuestionData')}</Typography.Text>
              ) : detailData.questions.map((q: any, idx: number) => {
                const answers = detailData.attempt.answers || {}
                const ans = answers[String(q.id)] || {}
                const isCorrect = ans.is_correct
                const isEssay = q.type === 'essay' || q.type === 'subjective' || ans.grading_type === 'essay'
                const options = q.options || {}
                const optionLabels = Object.keys(options)
                const TYPE_MAP2: Record<string, string> = {
                  single: t('q_short_single'), multiple: t('q_short_multi'), true_false: t('q_short_tf'), short: t('q_short_short'),
                  fill: t('q_short_fill'), essay: t('q_short_essay'), subjective: t('q_short_subj'),
                }
                return (
                  <Card key={q.id} size="small" style={{ marginBottom: 8 }}
                    title={<Space><Tag color={isCorrect ? 'green' : 'red'}>{isCorrect ? t('xCorrect') : t('xWrong')}</Tag>
                      {TYPE_MAP2[q.type] || q.type} | {t('qLabelIdx', { no: idx + 1 })}</Space>}>
                    <Typography.Paragraph style={{ fontWeight: 500, marginBottom: 8 }}><FormulaRenderer content={q.question_text} /></Typography.Paragraph>
                    <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} size="large" />
                    {optionLabels.length > 0 && (
                      <div style={{ marginBottom: 8, padding: 8, background: '#fafafa', borderRadius: 4 }}>
                        {optionLabels.map((key: string) => {
                          const isSelected = ans.student_answer?.includes(key)
                          const isCorrectOpt = q.correct_answer?.includes(key)
                          return (
                            <div key={key} style={{
                              padding: '4px 8px', marginBottom: 2, borderRadius: 4,
                              background: isSelected && isCorrectOpt ? '#f6ffed' : isSelected ? '#fff2f0' : isCorrectOpt ? '#e6f7ff' : 'transparent',
                              border: isSelected ? '1px solid ' + (isCorrectOpt ? '#b7eb8f' : '#ffccc7') : isCorrectOpt ? '1px solid #91d5ff' : '1px solid transparent',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            }}>
                              <Typography.Text style={{ fontSize: 13 }}>
                                <strong>{key}.</strong> <FormulaRenderer content={options[key]} inline />
                                {isSelected && <Tag color={isCorrectOpt ? 'green' : 'red'} style={{ marginLeft: 6, fontSize: 10 }}>{isCorrectOpt ? '✓ ' + t('yourAns') : '✗ ' + t('yourAns')}</Tag>}
                                {!isSelected && isCorrectOpt && <Tag color="blue" style={{ marginLeft: 6, fontSize: 10 }}>{t("correctAnsLabel")}</Tag>}
                              </Typography.Text>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    <Space orientation="vertical" style={{ width: '100%' }} size={4}>
                      <Typography.Text><strong>{t('yourAnsColon')}</strong>{ans.student_answer || t('unanswered')}</Typography.Text>
                      <Typography.Text><strong>{t('correctAnsColon')}</strong>{q.correct_answer}</Typography.Text>
                      <Typography.Text><strong>{t('scoreColon')}</strong>
                        <span style={{ color: isCorrect ? '#52c41a' : '#ff4d4f' }}>{ans.score || 0} / {ans.max_score || q.question_score || 0}</span>
                      </Typography.Text>
                      {q.explanation && (
                        <Typography.Text><strong>{t('explanationColon')}</strong><FormulaRenderer content={q.explanation} /></Typography.Text>
                      )}

                      {/* AI 简答评语 */}
                      {ans.comment && (
                        <div style={{ background: '#f6ffed', padding: 8, borderRadius: 4, marginTop: 4 }}>
                          <Typography.Text style={{ color: '#1677ff' }}><strong>{t('aiCommentColon')}</strong>{ans.comment}</Typography.Text>
                          {ans.feedback && <div style={{ marginTop: 4 }}><Typography.Text style={{ color: '#52c41a' }}><strong>{t('studyAdviceColon')}</strong>{ans.feedback}</Typography.Text></div>}
                        </div>
                      )}

                      {/* AI 主观题/作文 多维评分 */}
                      {isEssay && (ans.dimensions || q.dimensions) && (
                        <div style={{ background: '#f5f5f5', padding: 10, borderRadius: 6, marginTop: 4 }}>
                          <div style={{ fontWeight: 'bold', marginBottom: 6, fontSize: 13 }}>{t('aiMultiScore')}</div>
                          <Row gutter={8}>
                            {['content', 'structure', 'language'].map((dim) => {
                              const dimData = ans.dimensions?.[dim] || q.dimensions?.[dim]
                              if (!dimData) return null
                              const labels2: Record<string, string> = { content: t('dimContent'), structure: t('dimStructure'), language: t('dimLanguage') }
                              return (
                                <Col span={8} key={dim}>
                                  <div style={{ textAlign: 'center', background: '#fff', borderRadius: 4, padding: 4 }}>
                                    <div style={{ fontSize: 18, fontWeight: 'bold', color: '#1677ff' }}>{dimData.score}</div>
                                    <div style={{ fontSize: 11, color: '#666' }}>{labels2[dim]}/10</div>
                                    <div style={{ fontSize: 11, color: '#888' }}>{dimData.comment}</div>
                                  </div>
                                </Col>
                              )
                            })}
                          </Row>
                          {(ans.overall_comment || q.overall_comment) && (
                            <div style={{ marginTop: 6, fontSize: 12, color: '#333' }}>
                              <strong>{t('overallColon')}</strong>{ans.overall_comment || q.overall_comment}
                            </div>
                          )}
                          {(ans.improvement_suggestions || q.improvement_suggestments)?.length > 0 && (
                            <div style={{ marginTop: 6, fontSize: 12 }}>
                              <strong>{t('improveColon')}</strong>
                              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                                {(ans.improvement_suggestions || q.improvement_suggestions || []).map((s: string, i: number) => (
                                  <li key={i} style={{ color: '#666' }}>{s}</li>
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
              </>
              ) : (
                <Typography.Text type="danger">{t('loadAnsFail')}</Typography.Text>
              )}
            </div>
          ) : (
            <Typography.Text type="secondary">{t('loadingDots')}</Typography.Text>
          )}
        </Spin>
      </Modal>
    </Layout>
  )
}

/** 学生答题详情子组件（教师端展开时按需加载） */
const StudentExamDetail: React.FC<{
  examId: number; attemptId: number; studentName: string;
  showReview?: boolean;
}> = ({ examId, attemptId, studentName, showReview = false }) => {
  const { t } = useTranslation('exam')
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<any>(null)
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  // 教师复核状态
  const [reviewModal, setReviewModal] = useState(false)
  const [reviewScore, setReviewScore] = useState<number | null>(null)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewing, setReviewing] = useState(false)

  const loadDetail = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get(`/api/exams/${examId}/attempt/${attemptId}/detail`)
      setDetail(data)
      if (data.attempt?.teacher_score > 0) setReviewScore(data.attempt.teacher_score)
      if (data.attempt?.teacher_comment) setReviewComment(data.attempt.teacher_comment)
    } catch {
      message.error(t('loadDetailFailed'))
    } finally {
      setLoading(false)
    }
  }, [examId, attemptId, t])

  useEffect(() => { loadDetail() }, [loadDetail])

  // 教师提交复核
  const handleReviewSubmit = async () => {
    setReviewing(true)
    try {
      await examsApi.teacherReviewGrading({
        attempt_id: attemptId,
        teacher_score: reviewScore,
        teacher_comment: reviewComment || null,
      })
      message.success(t('reviewComplete'))
      setReviewModal(false)
      loadDetail()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('reviewFailed'))
    } finally {
      setReviewing(false)
    }
  }

  if (loading) return <Spin size="small" style={{ display: 'block', textAlign: 'center', padding: 24 }} />
  if (!detail) return <Typography.Text type="danger">{t('loadFail')}</Typography.Text>

  const answers = detail.attempt?.answers || {}
  const questions = detail.questions || []
  const isReviewed = detail.attempt?.teacher_reviewed

  const TYPE_MAP: Record<string, string> = {
    single: t('q_short_single'), multiple: t('q_short_multi'), true_false: t('q_short_tf'), short: t('q_short_short'),
    fill: t('q_short_fill'), essay: t('q_short_essay'), subjective: t('q_short_subj'),
  }

  return (
    <div style={{ maxHeight: 500, overflow: 'auto' }}>
      <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Typography.Text strong>{studentName}</Typography.Text>
          <Tag>{detail.attempt.score} / {detail.attempt.total_score} {t('fenUnit')}</Tag>
          {isReviewed ? <Tag color="blue">{t('recheckDone')}</Tag> : <Tag color="orange">{t('aiGraded')}</Tag>}
        </Space>
        {isTeacherOrAdmin && showReview && (
          <Button size="small" icon={<EditOutlined />} onClick={() => setReviewModal(true)}>
            {isReviewed ? t('modifyRecheck') : t('recheck')}
          </Button>
        )}
      </div>

      {questions.length === 0 ? (
        <Typography.Text type="secondary">{t('noQData')}</Typography.Text>
      ) : questions.map((q: any, idx: number) => {
        const ans = answers[String(q.id)] || {}
        const isCorrect = ans.is_correct
        const isEssay = q.type === 'essay' || q.type === 'subjective'
        const options = q.options || {}
        const optionLabels = Object.keys(options)

        return (
          <Card key={q.id} size="small" style={{ marginBottom: 6 }}
            title={<Space>
              <Tag color={isCorrect ? 'green' : 'red'}>{isCorrect ? t('xCorrect') : t('xWrong')}</Tag>
              {TYPE_MAP[q.type] || q.type} | {t('qLabelIdx', { no: idx + 1 })}
              {ans.teacher_adjusted && <Tag color="purple">{t('adjusted')}</Tag>}
            </Space>}>
            <Typography.Paragraph style={{ fontWeight: 500, marginBottom: 8, fontSize: 13 }}>
              <FormulaRenderer content={q.question_text} />
            </Typography.Paragraph>
            <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} size="large" />

            {/* 选择题选项 */}
            {optionLabels.length > 0 && (
              <div style={{ marginBottom: 8, padding: 8, background: '#fafafa', borderRadius: 4 }}>
                {optionLabels.map((key: string) => {
                  const isSelected = ans.student_answer?.includes(key)
                  const isCorrectOpt = q.correct_answer?.includes(key)
                  return (
                    <div key={key} style={{
                      padding: '3px 8px', marginBottom: 2, borderRadius: 4, fontSize: 13,
                      background: isSelected && isCorrectOpt ? '#f6ffed' : isSelected ? '#fff2f0' : isCorrectOpt ? '#e6f7ff' : 'transparent',
                      border: isSelected ? '1px solid ' + (isCorrectOpt ? '#b7eb8f' : '#ffccc7') : isCorrectOpt ? '1px solid #91d5ff' : '1px solid transparent',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                      <Typography.Text style={{ fontSize: 13 }}>
                        <strong>{key}.</strong> <FormulaRenderer content={options[key]} inline />
                        {isSelected && <Tag color={isCorrectOpt ? 'green' : 'red'} style={{ marginLeft: 6, fontSize: 10 }}>{isCorrectOpt ? '✓ ' + t('studentAns') : '✗ ' + t('studentAns')}</Tag>}
                        {!isSelected && isCorrectOpt && <Tag color="blue" style={{ marginLeft: 6, fontSize: 10 }}>{t("correctAnsLabel")}</Tag>}
                      </Typography.Text>
                    </div>
                  )
                })}
              </div>
            )}

            <Space orientation="vertical" size={2} style={{ fontSize: 13, width: '100%' }}>
              <Typography.Text style={{ fontSize: 13 }}><strong>{t('studentAnsColon')}</strong>{ans.student_answer || t('unanswered')}</Typography.Text>
              <Typography.Text style={{ fontSize: 13 }}><strong>{t('correctAnsColon')}</strong>{q.correct_answer}</Typography.Text>
              <Typography.Text style={{ fontSize: 13 }}><strong>{t('scoreColon')}</strong>
                <span style={{ color: isCorrect ? '#52c41a' : '#ff4d4f' }}>{ans.score || 0} / {ans.max_score || q.question_score || 0}</span>
              </Typography.Text>

              {/* AI 简答评语 */}
              {ans.comment && (
                <Typography.Text style={{ fontSize: 13, color: '#1677ff' }}>
                  <strong>{t('aiCommentColon')}</strong>{ans.comment}
                </Typography.Text>
              )}
              {ans.feedback && (
                <Typography.Text style={{ fontSize: 13, color: '#52c41a' }}>
                  <strong>{t('studyAdviceColon')}</strong>{ans.feedback}
                </Typography.Text>
              )}

              {/* AI 主观题/作文 多维评分 */}
              {isEssay && (ans.dimensions?.content || q.dimensions?.content) && (
                <div style={{ background: '#f5f5f5', padding: 10, borderRadius: 6, marginTop: 4 }}>
                  <div style={{ fontWeight: 'bold', marginBottom: 6, fontSize: 13 }}>{t('aiMultiScore')}</div>
                  <Row gutter={8}>
                    {['content', 'structure', 'language'].map((dim) => {
                      const dimData = ans.dimensions?.[dim] || q.dimensions?.[dim]
                      if (!dimData) return null
                      const labels: Record<string, string> = { content: t('dimContent'), structure: t('dimStructure'), language: t('dimLanguage') }
                      return (
                        <Col span={8} key={dim}>
                          <div style={{ textAlign: 'center', background: '#fff', borderRadius: 4, padding: 4 }}>
                            <div style={{ fontSize: 18, fontWeight: 'bold', color: '#1677ff' }}>{dimData.score}</div>
                            <div style={{ fontSize: 11, color: '#666' }}>{labels[dim]}/10</div>
                            <div style={{ fontSize: 11, color: '#888' }}>{dimData.comment}</div>
                          </div>
                        </Col>
                      )
                    })}
                  </Row>
                  {(ans.overall_comment || q.overall_comment) && (
                    <div style={{ marginTop: 6, fontSize: 12, color: '#333' }}>
                      <strong>{t('overallColon')}</strong>{ans.overall_comment || q.overall_comment}
                    </div>
                  )}
                </div>
              )}

              {q.explanation && (
                <Typography.Text style={{ fontSize: 13 }}><strong>{t('explanationColon')}</strong><FormulaRenderer content={q.explanation} /></Typography.Text>
              )}

              {/* 教师评语 */}
              {ans.teacher_comment && (
                <Typography.Text style={{ fontSize: 13, color: '#722ed1' }}>
                  <strong>{t('teacherCommentColon')}</strong>{ans.teacher_comment}
                </Typography.Text>
              )}
            </Space>
          </Card>
        )
      })}

      {/* ── 教师复核弹窗 ── */}
      <Modal title={t('reviewAiTitle')} open={reviewModal} onCancel={() => setReviewModal(false)}
        onOk={handleReviewSubmit} confirmLoading={reviewing}
        okText={t('confirmRecheck')} cancelText={t('cancel')}>
        <Space orientation="vertical" style={{ width: '100%' }}>
          <div>
            <Typography.Text>{t('curAiScoreColon')}</Typography.Text>
            <Tag color="blue">{detail.attempt.score} / {detail.attempt.total_score}</Tag>
          </div>
          <div>
            <Typography.Text>{t('adjustTotalColon')}</Typography.Text>
            <InputNumber
              min={0} max={detail.attempt.total_score}
              value={reviewScore}
              onChange={(v) => setReviewScore(v)}
              style={{ width: 120 }}
              placeholder={t('blankKeep')}
            />
            <Typography.Text type="secondary" style={{ marginLeft: 8 }}> / {detail.attempt.total_score}</Typography.Text>
          </div>
          <div style={{ width: '100%' }}>
            <Typography.Text>{t('teacherCommentColon')}</Typography.Text>
            <TextArea rows={3} value={reviewComment}
              onChange={(e) => setReviewComment(e.target.value)}
              placeholder={t('teacherCommentPh')} style={{ width: '100%' }} />
          </div>
        </Space>
      </Modal>
    </div>
  )
}

export default ExamPage
