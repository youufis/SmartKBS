import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Layout, Card, Table, Button, message, Modal, Form, Input, Select,
  InputNumber, Tag, Space, Typography, Tooltip, Popconfirm, Row, Col,
  Divider, Empty, Tabs, Spin, Statistic, Checkbox, Alert,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined, SafetyCertificateOutlined,
  HolderOutlined,
  PlayCircleOutlined, PauseCircleOutlined,
  CheckCircleOutlined, BarChartOutlined,
  OrderedListOutlined, FileAddOutlined, SaveOutlined,
  DownloadOutlined, BulbOutlined, FileOutlined, RobotOutlined,
  FileTextOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import * as examsApi from '../api/exams'
import * as questionsApi from '../api/questions'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import type { AiTaskProgress } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import type { ExamInfo, ExamAttempt } from '../types'

import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import { TYPE_OPTIONS } from '../constants/questionTypes'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
import ResetActivityButton from '../components/ResetActivityButton'
import { closeWithDirtyGuard } from '../utils/dirtyClose'
import { reportLoadError } from '../utils/loadError'
import MobileCardTable from '../components/MobileCardTable'
import { useIsMobile } from '../hooks/useIsMobile'

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
  // 窄屏：列表类表格改卡片渲染（复用同一套 columns，桌面仍为 Table）
  const isMobile = useIsMobile()
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'
  const { t } = useTranslation('exam')
  const { t: tc } = useTranslation('common')

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
    }).catch((err) => { reportLoadError(err, { key: 'exam.subjects' }) })
  }, [])

  // ── 考试列表 ──
  const [exams, setExams] = useState<ExamInfo[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [statusFilter, setStatusFilter] = useState<string | undefined>()
  // 首页「待处理批阅」卡片带 ?grading=pending 进来时，列表只留仍有待批改答卷的考试，
  // 否则会出现「卡片 13（份答卷）/ 列表 9（场考试）」这种看着像丢数据的错位
  const [searchParams, setSearchParams] = useSearchParams()
  const [pendingOnly, setPendingOnly] = useState(() => searchParams.get('grading') === 'pending')

  const togglePendingOnly = (v: boolean) => {
    setPendingOnly(v)
    setPage(1)
    const next = new URLSearchParams(searchParams)
    if (v) next.set('grading', 'pending')
    else next.delete('grading')
    setSearchParams(next, { replace: true })
  }

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
  // 与「自动选题」同一个开关：题库凑不够配额时是否让 AI 按缺口补题（默认关）
  const [aiComposeFill, setAiComposeFill] = useState(false)
  const [aiComposeFocus, setAiComposeFocus] = useState('')
  const [aiComposeTypes, setAiComposeTypes] = useState<string[]>([])
  const [aiComposeDifficulty, setAiComposeDifficulty] = useState<string>()
  const [aiComposeNote, setAiComposeNote] = useState('')

  // ── 成绩查看弹窗 ──
  const [resultModal, setResultModal] = useState(false)
  const [resultExam, setResultExam] = useState<ExamInfo | null>(null)
  const [resultData, setResultData] = useState<any>(null)
  const [resultSearch, setResultSearch] = useState('')
  const [resultLoading, setResultLoading] = useState(false)
  // S-GRADING(P2): 教师手动触发该考试的主观题批改
  const [gradingNow, setGradingNow] = useState(false)

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
        pending_grading: pendingOnly ? 1 : undefined,
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
  }, [statusFilter, page, pageSize, isStudent, t, pendingOnly])

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
        // shuffle_options 不再提交：选项乱序需要改动判分链路五处字母重映射，尚未实现；
        // 不发送即后端保持原值，避免把存量卷子的 0 静默翻成 1
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
  const [scoreBaseline, setScoreBaseline] = useState<Record<string, number>>({})  // 已落库的对照
  const [savingScores, setSavingScores] = useState(false)
  const [balancing, setBalancing] = useState(false)

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
      // 目标总分要跟着详情走：智能组卷会改它，用打开弹窗时的列表快照会显示成旧值
      if (detail && typeof detail.total_score === "number") setQuestionExam(detail)
      // 初始化可编辑分值映射 (使用 eq_id)，并留一份基线用来判断"有没有没保存的改动"
      const scores: Record<string, number> = {}
      questions.forEach((q: any) => { scores[String(q.eq_id)] = q.question_score })
      setScoreInputs(scores)
      setScoreBaseline(scores)
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
  const scoreGap = Math.round((currentTotal - expectedTotal) * 10) / 10   // 正=超出，负=还差
  const scoreSig = (m: Record<string, number>) =>
    Object.keys(m).sort().map((k) => `${k}:${Number(m[k]) || 0}`).join("|")
  const scoreDirty = scoreSig(scoreInputs) !== scoreSig(scoreBaseline)
  // 提示语：超出与不足要说反话，旧写法直接打印负数（"分数差值 -12.0 分"）读不懂
  const gapText = scoreGap > 0
    ? t("scoreOverBy", { n: Math.abs(scoreGap).toFixed(1) })
    : t("scoreShortBy", { n: Math.abs(scoreGap).toFixed(1) })
  // 服务端回报的影响面：有人在作答会被 409 拦住；有历史提交要提醒"不会重算成绩"
  const reportImpact = (res: any) => {
    if (res?.submitted_attempts > 0) {
      message.warning(t("submittedImpact", { count: res.submitted_attempts }))
    }
    // 配平后的真实每题分值：老师配的是"单选 3 分"，实际可能落成 3.4 分，
    // 不显示出来就只有总分对了、没人知道每题到底几分
    const ts = res?.type_scores as Record<string, number> | undefined
    if (ts && Object.keys(ts).length) {
      message.info(t("actualScores", {
        scores: Object.entries(ts).map(([k, v]) => `${typeLabel(k)} ${v}`).join("、"),
      }))
    }
  }

  // ── 更新单题分值 ──
  const handleScoreChange = (eqId: string, value: number | null) => {
    setScoreInputs(prev => ({ ...prev, [eqId]: value ?? 0 }))
  }

  // ── 自动均衡 ──
  const handleAutoBalance = async () => {
    if (!questionExam) return
    setBalancing(true)
    try {
      const res = await examsApi.autoBalanceScores(questionExam.id)
      message.success(res.message)
      reportImpact(res)
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('autoBalanceFailed'))
    } finally {
      setBalancing(false)
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
      reportImpact(res)
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
      reportImpact(res)
      setSelectedQIds([])
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('addFailed'))
    }
  }

  // 组卷说明 + 本次入卷结构（题型×题数、难度分布），只回一个 reason 老师看不出卷面长什么样
  const composePlanText = (res: any) => {
    const parts: string[] = [String(res?.reason || '')]
    const ts = res?.type_stats as Record<string, number> | undefined
    const ds = res?.difficulty_stats as Record<string, number> | undefined
    if (ts && Object.keys(ts).length) {
      parts.push(t('typeStatsLine', { stats: Object.entries(ts)
        .map(([k, v]) => `${typeLabel(k)} ${v}`).join('、') }))
    }
    if (ds && Object.keys(ds).length) {
      parts.push(t('difficultyStatsLine', { stats: Object.entries(ds)
        .filter(([, v]) => v > 0).map(([k, v]) => `${difficultyLabel(k)} ${v}`).join('、') }))
    }
    return parts.filter(Boolean).join('\n')
  }

  // 卷面结构：题型与难度分布（弹窗里直接可见，不用自己去数表格）
  const paperStats = useMemo(() => {
    const byType: Record<string, number> = {}
    const byDiff: Record<string, number> = {}
    examQuestions.forEach((q: any) => {
      byType[q.type] = (byType[q.type] || 0) + 1
      byDiff[q.difficulty] = (byDiff[q.difficulty] || 0) + 1
    })
    return { byType, byDiff }
  }, [examQuestions])

  const [removeIds, setRemoveIds] = useState<number[]>([])
  // ── 拖拽排序：sort_order 决定试卷/答案卷/答题卡的排版顺序，此前界面上没有入口能调 ──
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [orderSaving, setOrderSaving] = useState(false)

  const handleRowDrop = async (toIdx: number) => {
    if (dragIdx === null || dragIdx === toIdx || !questionExam) { setDragIdx(null); return }
    const prev = examQuestions
    const next = [...prev]
    const [moved] = next.splice(dragIdx, 1)
    next.splice(toIdx, 0, moved)
    setDragIdx(null)
    setExamQuestions(next)                 // 先乐观更新，失败再拿服务端真相回滚
    setOrderSaving(true)
    try {
      const res = await examsApi.reorderExamQuestions(questionExam.id, next.map((q: any) => q.id))
      message.success(res.message)
      reportImpact(res)
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('orderFailed'))
      setExamQuestions(prev)
    } finally {
      setOrderSaving(false)
    }
  }

  const removeQuestions = async (ids: number[]) => {
    if (!questionExam || !ids.length) return
    try {
      const res = await examsApi.removeQuestionsFromExam(questionExam.id, ids)
      message.success(res.message)
      reportImpact(res)
      setRemoveIds([])
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('removeFailed'))
    }
  }

  const handleClearPaper = () => removeQuestions(examQuestions.map((q: any) => q.id))

  // ── 卷面体检 ──
  const [healthModal, setHealthModal] = useState(false)
  const [healthLoading, setHealthLoading] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [health, setHealth] = useState<any>(null)
  const [repairReport, setRepairReport] = useState<any>(null)

  const runHealthScan = useCallback(async () => {
    setHealthLoading(true)
    try {
      setHealth(await examsApi.scanPaperHealth())
      setRepairReport(null)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('paperHealthFailed'))
    } finally {
      setHealthLoading(false)
    }
  }, [t])

  const openPaperHealth = () => { setHealthModal(true); void runHealthScan() }

  const runRepair = async (dryRun: boolean) => {
    setRepairing(true)
    try {
      const res = await examsApi.repairPaperHealth({ dry_run: dryRun })
      setRepairReport(res)
      if (!dryRun) {
        message.success(res.message)
        await runHealthScan()
        loadExams()
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('paperHealthFailed'))
    } finally {
      setRepairing(false)
    }
  }

  const closeQModal = () => {
    closeWithDirtyGuard(scoreDirty, tc, () => setQuestionModal(false))
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
        fill_by_ai: values.fill_by_ai === true,
      })
      message.success(res.message)
      if (res.ai_filled) message.info(t('aiFilledNotice', { n: res.ai_filled }))
      if (res.notice) message.info(res.notice)        // 兜底题/放宽条件必须让老师看见
      if (res.reason) message.info(t('autoSelectReason', { reason: res.reason }))
      reportImpact(res)
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      if (err?.response?.data?.detail) {
        message.error(err.response.data.detail)
      } else if (!err?.errorFields) {
        // 表单校验失败交给 antd 自己标红字段，其余异常不能一声不吭
        message.error(t('operationFailed'))
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
      const data = await examsApi.aiComposeExam(questionExam.id, {
        target_count: aiComposeCount,
        knowledge_focus: aiComposeFocus,
        question_types: aiComposeTypes.length ? aiComposeTypes : undefined,
        difficulty: aiComposeDifficulty || undefined,
        fill_by_ai: aiComposeFill,
      }, (p: AiTaskProgress) => setAiComposeNote(p?.message || ''))
      message.success(data.message || t('composeSuccess'))
      if (data.ai_filled) message.info(t('aiFilledNotice', { n: data.ai_filled }))
      if (data.notice) message.info(data.notice)      // 题从哪来：兜底/放宽情况要说清楚
      reportImpact(data)
      if (data.reason) {
        Modal.info({
          title: t('cwPlanTitle'),
          content: composePlanText(data),
        })
      }
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      // 超时不等于失败：后台还在跑。说"失败"会诱导老师重复点，结果是重复入卷
      if (err?.aiTaskTimeout) message.warning(t('aiComposeTimeout'))
      else if (err?.aiTaskFailed) message.error(err.message || t('composeFailed'))
      else message.error(err?.response?.data?.detail || err?.message || t('composeFailed'))
      await loadExamQuestions(questionExam.id)
    } finally {
      setAiComposing(false)
      setAiComposeNote('')
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

  // ── S-GRADING(P2): 立即批改待判的主观题(进度走 AI 任务轮询) ──
  const handleGradeNow = async () => {
    if (!resultExam) return
    setGradingNow(true)
    try {
      const res = await examsApi.gradeExamNow(resultExam.id)
      if (!res.task_id) {
        message.info(res.message || t('exNoPendingGrading'))
        await handleViewResults(resultExam)
        return
      }
      message.info(t('exGradeNowStarted', { count: res.pending_attempts || 0 }))
      const out: any = await pollAiTask(res.task_id, 240000)
      if (out?.error) message.error(out.error)
      else if (out) {
        message.success(t('exGradeNowDone', { graded: out.graded ?? 0, review: out.to_review ?? 0 }))
        await handleViewResults(resultExam)
      } else {
        message.warning(t('exGradeNowTimeout'))
        await handleViewResults(resultExam)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('exGradeNowFailed'))
    } finally { setGradingNow(false) }
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
      // 让「13 份答卷」在列表里能逐场对上，而不是只看到一个总数
      title: t('exPendingCol'),
      key: 'pending_grading',
      width: 86,
      render: (_: unknown, r: ExamInfo & { pending_grading?: number }) => {
        const n = r.pending_grading ?? 0
        return n > 0
          ? (
            <Tooltip title={t('exPendingTip', { count: n })}>
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t('exPendingN', { count: n })}</Tag>
            </Tooltip>
          )
          : <Typography.Text type="secondary" style={{ fontSize: 12 }}>-</Typography.Text>
      },
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
            {/* 重置数据：与活动状态无关（草稿/已发布/已结束都可），属主与角色由服务端校验 */}
            {canEdit && (
              <ResetActivityButton activityType="exam" activityId={record.id}
                iconOnly stopPropagation onSuccess={loadExams} />
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
    <Layout style={{ height: 'calc(100vh - 112px)', background: 'var(--bg-container)', borderRadius: 8, overflow: 'auto', padding: 24 }}>
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
              {isTeacherOrAdmin && (
                <Tooltip title={t('paperHealthDesc')}>
                  <Button icon={<SafetyCertificateOutlined />}
                    onClick={openPaperHealth}>{t('paperHealth')}</Button>
                </Tooltip>
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
          <Col xs={12} sm={6} md={3}>
            <Select allowClear placeholder={t('all')} style={{ width: '100%' }}
              value={statusFilter}
              onChange={(val) => { setStatusFilter(val); setPage(1) }}>
              <Option value="draft">{t('draft')}</Option>
              <Option value="published">{t('published')}</Option>
              <Option value="ended">{t('ended')}</Option>
            </Select>
          </Col>
          <Col>
            <Checkbox checked={pendingOnly} onChange={(e) => togglePendingOnly(e.target.checked)}>
              <span style={{ fontSize: 13 }}>{t('exPendingOnly')}</span>
            </Checkbox>
          </Col>
          <Col>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {pendingOnly ? t('exPendingHint', { count: total }) : t('totalExams', { count: total })}
            </Typography.Text>
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
                isMobile ? (
                  <MobileCardTable
                    dataSource={exams} columns={studentColumns} rowKey="id" loading={loading}
                    pagination={{ current: page, pageSize, total, onChange: (p) => setPage(p) }}
                    emptyText={<Empty description={t('noExams')} />}
                  />
                ) : (
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
                )
              ),
            },
            {
              key: 'results',
              label: <Space><BarChartOutlined />{t('result')}</Space>,
              children: (
                <Table className="nowrap-cells-table" dataSource={myResults} rowKey="id" loading={myResultsLoading} size="small"
                  columns={[
                    { title: t('examTitle'), dataIndex: 'exam_title', key: 'exam_title', ellipsis: true },
                    { title: t('subject'), dataIndex: 'exam_subject', key: 'exam_subject', width: 80 },
                    { title: t('publisher'), dataIndex: 'creator_name', key: 'creator_name', width: 90,
                      render: (name: string) => <Tag color="blue">{name || '-'}</Tag> },
                    {
                      title: t('score'), key: 'score', width: 100,
                      render: (_: any, r: any) => {
                        // S-GRADING(P2): 主观题还在后台批改时, 分数是临时值, 不下通过/未通过结论
                        const pend = Number(r.ai_pending || 0)
                        const passed = r.score >= (r.pass_score || 60)
                        return (
                          <Space>
                            <Typography.Text strong style={{ color: pend ? '#1677ff' : (passed ? '#52c41a' : '#ff4d4f') }}>
                              {r.score} / {r.total_score}
                            </Typography.Text>
                            {pend
                              ? <Tag color="blue">{t('exGradingPending')}</Tag>
                              : (passed ? <Tag color="green">{t('pass')}</Tag> : <Tag color="red">{t('fail')}</Tag>)}
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
                  <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-tertiary)' }}>
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
      <Modal maskClosable={false} title={t('createExam')} open={createModal}
        onCancel={() => closeWithDirtyGuard(createForm.isFieldsTouched(), tc, () => setCreateModal(false))}
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
              {/* Select 上挂 valuePropName="checked" 是复制粘贴留下的错：Select 不认 checked，
                  控件显示空值、提交时又因 !== false 一律落 true，开关形同虚设 */}
              <Form.Item label={t('shuffleQuestions')} name="shuffle_questions"
                tooltip={t('shuffleQuestionsTip')}>
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
      <Modal maskClosable={false} title={t('editExam')} open={editModal}
        onCancel={() => closeWithDirtyGuard(editForm.isFieldsTouched(), tc, () => setEditModal(false))}
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
              <Form.Item label={t('shuffleQuestions')} name="shuffle_questions"
                tooltip={t('shuffleQuestionsTip')}>
                <Select>
                  <Option value={true}>{t('yes')}</Option>
                  <Option value={false}>{t('no')}</Option>
                </Select>
              </Form.Item>
            </Col>
            {/* 选项乱序开关已下线：该字段此前只被读写、从未被应用，
                真正接入需要改动判分链路五处字母重映射（见后端 _ordered_for_student 注释） */}
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
        maskClosable={false}
        onCancel={() => closeQModal()}
        width={960}
        footer={[
          <span key="dirty" style={{ float: 'left', lineHeight: '32px' }}>
            {scoreDirty && (
              <Tag color="orange" style={{ marginRight: 8 }}>⚠️ {t('unsavedScores')}</Tag>
            )}
            {t('paperTotal', { total: currentTotal.toFixed(1), target: expectedTotal.toFixed(1) })}
          </span>,
          <Button key="close" onClick={() => closeQModal()}>{t('close')}</Button>,
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
                        ⚠️ {t('scoreDiff')} {gapText}
                      </Tag>
                  }
                  {scoreDirty && <Tag color="blue" style={{ marginLeft: 8 }}>{t('unsavedScores')}</Tag>}
                </Space>
                <Space>
                  {/* 旧写法在 disabled 里挂了一个永远求值为 false 的条件（把一个内置函数
                      toString 成真值再取反），"分数不平衡就别保存"的本意一行都没生效。
                      现在改为：不平衡也允许保存（服务端会回报缺口），但没改动时不给空点。 */}
                  <Button size="small" icon={<ReloadOutlined />} loading={balancing}
                    onClick={handleAutoBalance}>
                    {t('autoBalance')}
                  </Button>
                  <Button type="primary" size="small" icon={<SaveOutlined />}
                    loading={savingScores} onClick={handleSaveScores}
                    disabled={!scoreDirty}>
                    {t('saveScore')}
                  </Button>
                </Space>
              </Space>
            </Card>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <Typography.Title level={5} style={{ fontSize: 14, margin: 0 }}>
              {t('selectedQuestions', { count: examQuestions.length })}
              {examQuestions.length > 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8, fontWeight: 'normal' }}>
                  {t('editableScoreHint')} · {t('expandQuestionHint')} · {t('dragOrderHint')}
                </Typography.Text>
              )}
            </Typography.Title>
            {examQuestions.length > 0 && (
              <Space size={4}>
                <Button size="small" danger icon={<DeleteOutlined />}
                  disabled={!removeIds.length}
                  onClick={() => removeQuestions(removeIds)}>
                  {t('removeSelectedCount', { count: removeIds.length })}
                </Button>
                <Popconfirm title={t('clearWholePaperConfirm', { count: examQuestions.length })}
                  onConfirm={handleClearPaper} okText={t('confirm')} cancelText={t('cancel')}
                  okButtonProps={{ danger: true }}>
                  <Button size="small" type="text" danger>{t('clearWholePaper')}</Button>
                </Popconfirm>
              </Space>
            )}
          </div>
          {examQuestions.length > 0 && (
            <Space wrap size={4} style={{ marginBottom: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('paperStructure')}：
              </Typography.Text>
              {Object.entries(paperStats.byType).map(([k, v]) => (
                <Tag key={k}>{typeLabel(k)} × {v}</Tag>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {t('difficulty')}：
              </Typography.Text>
              {Object.entries(paperStats.byDiff).map(([k, v]) => (
                <Tag key={k} color={k === 'hard' ? 'red' : k === 'easy' ? 'green' : 'blue'}>
                  {difficultyLabel(k)} × {v}
                </Tag>
              ))}
            </Space>
          )}
          {examQuestions.length === 0 ? (
            <Empty description={t('noQuestionsHint')} />
          ) : (
            <Spin spinning={orderSaving} tip={t('saving')}>
            <Table dataSource={examQuestions} rowKey="id" size="small" pagination={false}
              onRow={(_: any, index?: number) => ({
                draggable: examQuestions.length > 1,
                onDragStart: (e: any) => {
                  // 从分值输入框/下拉里起手时不要触发拖拽，否则老师没法选文字改数字
                  const el = e.target as HTMLElement
                  if (el?.closest?.('input, textarea, .ant-select, .ant-input-number')) {
                    e.preventDefault()
                    return
                  }
                  setDragIdx(index ?? null)
                },
                onDragOver: (e: any) => e.preventDefault(),
                onDragEnd: () => setDragIdx(null),
                onDrop: (e: any) => { e.preventDefault(); void handleRowDrop(index ?? 0) },
                style: {
                  cursor: examQuestions.length > 1 ? 'move' : 'default',
                  opacity: dragIdx !== null && dragIdx === index ? 0.35 : 1,
                },
              })}
              rowSelection={{
                selectedRowKeys: removeIds,
                onChange: (keys) => setRemoveIds(keys as number[]),
              }}
              expandable={{
                // 展开即预览：此前弹窗里看不到选项与答案，老师要判断题目好坏只能回题库找
                expandedRowRender: (rec: any) => {
                  const opts = rec.options && typeof rec.options === 'object' ? rec.options : null
                  const correct = String(rec.correct_answer || '').split(',').map((s: string) => s.trim())
                  return (
                    <div style={{ padding: '4px 8px', background: '#fafafa' }}>
                      <Typography.Paragraph style={{ marginBottom: 8 }}>
                        <FormulaRenderer content={rec.question_text} />
                      </Typography.Paragraph>
                      <MediaDisplay svgContent={rec.svg_content} hasSvg={rec.has_svg}
                        mediaFiles={rec.media_files} size="compact" />
                      {opts ? (
                        <div style={{ marginBottom: 8 }}>
                          {Object.entries(opts).map(([k, v]) => (
                            <div key={k} style={{ marginBottom: 2 }}>
                              <strong>{k}.</strong>{' '}
                              <FormulaRenderer content={String(v)} inline />
                              {correct.includes(k) && (
                                <Tag color="success" style={{ marginLeft: 6 }}>{t('xCorrect')}</Tag>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Typography.Text type="secondary">{t('noOptionsHint')}</Typography.Text>
                      )}
                      <Space wrap size={4}>
                        {rec.correct_answer && (
                          <Tag color="success">{t('correctAnsColon')}{rec.correct_answer}</Tag>
                        )}
                        {rec.difficulty && <Tag>{difficultyLabel(rec.difficulty)}</Tag>}
                        {rec.knowledge_points && <Tag color="blue">{rec.knowledge_points}</Tag>}
                      </Space>
                      {!!rec.explanation && (
                        <Typography.Paragraph style={{ marginTop: 8, marginBottom: 0 }}>
                          <strong>{t('explanationColon')}</strong>
                          <FormulaRenderer content={rec.explanation} />
                        </Typography.Paragraph>
                      )}
                    </div>
                  )
                },
              }}
              columns={[
                { title: '#', key: 'index', width: 46,
                  render: (_: any, __: any, idx: number) => (
                    <Space size={2}>
                      <HolderOutlined style={{ color: '#bbb' }} />
                      <span>{idx + 1}</span>
                    </Space>
                  ) },
                { title: t('questionType'), dataIndex: 'type', width: 70,
                  // 题型是后台可配的，硬编码四种会把填空/作文/编程一律显示成"简答"
                  render: (v: string) => <Tag>{typeLabel(v)}</Tag> },
                { title: t('questionText'), dataIndex: 'question_text', ellipsis: true },
                { title: t('scorePerQuestion'), dataIndex: 'question_score', width: 100,
                  render: (_: any, rec: any) => (
                    <InputNumber
                      size="small"
                      min={0.5}
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
            </Spin>
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
              {/* 默认不勾：组卷的老行为是"凑不够就只报缺口"，判分链路只碰存量题更稳；
                  勾上后缺额由 AI 出新题，题目照常过入库关口并连知识点边 */}
              <Form.Item name="fill_by_ai" valuePropName="checked" style={{ width: '100%' }}>
                <Checkbox>{t('fillByAi')}</Checkbox>
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
            {/* 与「自动选题」同一套筛选条件：题型与难度会真的决定候选池与配额，
                不再只是塞进 prompt（旧实现候选池是 subject 精确等值 + ORDER BY difficulty） */}
            <Space wrap style={{ gap: 8 }}>
              <Typography.Text style={{ fontSize: 13 }}>{t('targetCount')}</Typography.Text>
              <InputNumber size="small" min={1} max={100} value={aiComposeCount}
                onChange={(v) => setAiComposeCount(v || 10)} style={{ width: 80 }} />
              <Checkbox checked={aiComposeFill} onChange={(e) => setAiComposeFill(e.target.checked)}>
                {t('fillByAi')}
              </Checkbox>
              <Select size="small" allowClear mode="multiple" placeholder={t('questionTypeAny')}
                value={aiComposeTypes} onChange={(v) => setAiComposeTypes(v || [])}
                maxTagCount={2} style={{ minWidth: 160 }}>
                {TYPE_OPTIONS.map(opt => (
                  <Option key={opt.value} value={opt.value}>{opt.label}</Option>
                ))}
              </Select>
              <Select size="small" allowClear placeholder={t('difficulty')}
                value={aiComposeDifficulty} onChange={(v) => setAiComposeDifficulty(v)}
                style={{ width: 100 }}>
                <Option value="easy">{t('easy')}</Option>
                <Option value="medium">{t('medium')}</Option>
                <Option value="hard">{t('hard')}</Option>
              </Select>
              <Typography.Text style={{ fontSize: 13 }}>{t('knowledgeFocus')}</Typography.Text>
              <Input size="small" value={aiComposeFocus}
                onChange={(e) => setAiComposeFocus(e.target.value)}
                placeholder={t('aiComposePlaceholder')} style={{ width: 200 }} />
              {aiComposing && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  <ThunderboltOutlined spin /> {aiComposeNote || t('aiComposing')}
                </Typography.Text>
              )}
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

      {/* ── 卷面体检弹窗 ── */}
      <Modal title={<Space><SafetyCertificateOutlined />{t('paperHealth')}</Space>}
        open={healthModal}
        maskClosable={false}
        onCancel={() => setHealthModal(false)}
        width={860}
        footer={[
          <Button key="close" onClick={() => setHealthModal(false)}>{t('close')}</Button>,
          <Button key="dry" icon={<ReloadOutlined />} loading={repairing || healthLoading}
            onClick={() => runRepair(true)}>{t('phDryRun')}</Button>,
          <Popconfirm key="apply" title={t('phApplyConfirm', { n: health?.fixable_count ?? 0 })}
            disabled={!health?.fixable_count}
            onConfirm={() => runRepair(false)} okText={t('confirm')} cancelText={t('cancel')}
            okButtonProps={{ danger: true }}>
            <Button type="primary" danger icon={<CheckCircleOutlined />}
              loading={repairing} disabled={!health?.fixable_count}>
              {t('phApply')}
            </Button>
          </Popconfirm>,
        ]}>
        <Spin spinning={healthLoading}>
          {!health ? null : health.flagged === 0 ? (
            <Alert type="success" showIcon message={t('phNone')} />
          ) : (
            <>
              <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                message={t('phFlagged', { flagged: health.flagged, total: health.total_scanned, fixable: health.fixable_count })}
                description={t('phHint')} />
              <Table dataSource={health.exams} rowKey="exam_id" size="small"
                pagination={false}
                columns={[
                  { title: t('phExam'), dataIndex: 'title', ellipsis: true, width: 200,
                    render: (v: string, r: any) => `#${r.exam_id} ${v}` },
                  { title: t('status'), dataIndex: 'status', width: 80,
                    render: (v: string) => <Tag>{v === 'draft' ? t('ecDraft') : v === 'published' ? t('ecPublished') : t('ecEnded')}</Tag> },
                  { title: t('questionCount'), dataIndex: 'question_count', width: 70 },
                  { title: t('targetScore'), dataIndex: 'target_total', width: 80 },
                  { title: t('phPaperTotal'), dataIndex: 'paper_total', width: 90,
                    render: (v: number, r: any) => (
                      <Typography.Text type={Math.abs(v - r.target_total) > 0.5 ? 'danger' : undefined}>
                        {v}
                      </Typography.Text>
                    ) },
                  { title: t('phProblems'), dataIndex: 'problems',
                    render: (ps: any[]) => (
                      <Space orientation="vertical" size={2}>
                        {ps.map((p) => (
                          <Typography.Text key={p.code} type={p.fixable ? 'warning' : 'danger'}
                            style={{ fontSize: 12 }}>
                            {p.message}{p.fixable ? `（${t('phAutoFixable')}）` : `（${t('phManual')}）`}
                          </Typography.Text>
                        ))}
                      </Space>
                    ) },
                ]}
              />
              {!!repairReport && (
                <Alert style={{ marginTop: 12 }} type={repairReport.dry_run ? 'info' : 'success'}
                  showIcon message={repairReport.message}
                  description={
                    <Space orientation="vertical" size={2}>
                      {(repairReport.results || []).map((x: any) => (
                        <Typography.Text key={x.exam_id} style={{ fontSize: 12 }}>
                          #{x.exam_id} {x.title}: {x.before_total} → {x.after_total}
                          {x.removed_duplicates > 0 ? ` （${t('phRemovedDupes', { n: x.removed_duplicates })}）` : ''}
                        </Typography.Text>
                      ))}
                      {(repairReport.skipped || []).map((s: any) => (
                        <Typography.Text key={s.exam_id} type="warning" style={{ fontSize: 12 }}>
                          #{s.exam_id} {s.title}: {s.reason}
                        </Typography.Text>
                      ))}
                    </Space>
                  }
                />
              )}
            </>
          )}
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
            onClick={() => window.open(`/api/export/exam/${resultExam?.id}`, '_blank')}>{t('exportReport')}</Button>,
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
              <Space style={{ marginBottom: 8 }} wrap>
                <Input allowClear size="small" style={{ width: 260 }}
                  placeholder={t('exSearchStudent')} value={resultSearch} onChange={(e) => setResultSearch(e.target.value)} />
                {/* S-GRADING(P2): 还有主观题没判完时, 教师可以立刻催批, 不必等后台节拍 */}
                {Number(resultData.statistics?.pending_ai_total || 0) > 0 && (
                  <>
                    <Tag color="blue">{t('exGradingPendingN', { count: resultData.statistics.pending_ai_total })}</Tag>
                    {Number(resultData.statistics?.pending_review_total || 0) > 0 && (
                      <Tag color="orange">{t('exPendingReviewN', { count: resultData.statistics.pending_review_total })}</Tag>
                    )}
                    <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />}
                      loading={gradingNow} onClick={handleGradeNow}>{t('exGradeNow')}</Button>
                  </>
                )}
              </Space>
              <Table
                dataSource={(resultData.attempts || []).filter((r: any) => {
                  const kw = resultSearch.trim().toLowerCase()
                  if (!kw) return true
                  return [r.student_username, r.student_name, r.grade, r.class_name]
                    .some((x: any) => String(x || '').toLowerCase().includes(kw))
                })}
                rowKey="id" size="small"
                pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (n: number) => t('exTotalStudents', { count: n }) }}
                columns={[
                  { title: t('exName'), dataIndex: 'student_name', key: 'student_name', width: 90, ellipsis: true },
                  { title: t('exStudentId'), dataIndex: 'student_username', key: 'student_username', width: 100, ellipsis: true },
                  { title: t('exGrade'), dataIndex: 'grade', key: 'grade', width: 64 },
                  { title: t('exClass'), dataIndex: 'class_name', key: 'class_name', width: 88 },
                  { title: t('score'), key: 'score', width: 100,
                    render: (_: any, r: ExamAttempt) => {
                      const passed = r.score >= (resultExam?.pass_score || 60)
                      return <span style={{ color: passed ? '#52c41a' : '#ff4d4f', fontWeight: 600 }}>{r.score} / {r.total_score}</span>
                    },
                  },
                  // S-GRADING(P2): 一眼看出谁的卷子还在批改中 / 谁需要人工批改
                  { title: t('exGradingState'), key: 'grading_state', width: 110,
                    render: (_: any, r: any) => {
                      if (r.teacher_reviewed) return <Tag color="green">{t('exGradedByTeacher')}</Tag>
                      if (r.pending_ai) return <Tag color="blue">{t('exGradingPendingN', { count: r.pending_ai })}</Tag>
                      if (r.pending_review) return <Tag color="orange">{t('exPendingReviewN', { count: r.pending_review })}</Tag>
                      return <Tag color="green">{t('exGradedDone')}</Tag>
                    },
                  },
                  { title: t('submittedAt'), dataIndex: 'submitted_at', key: 'submitted_at', width: 150,
                    render: (v: string) => v ? v.slice(0, 16) : '-' },
                ]}
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
            <div style={{ marginTop: 16, color: 'var(--text-secondary)' }}>{t('aiAnalyzing')}</div>
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
                <Space wrap>
                  <Statistic title={t('score')} value={detailData.attempt.score} suffix={`/ ${detailData.attempt.total_score}`}
                    styles={{ content: { color: detailData.attempt.score >= (detailData.attempt.total_score || 100) * 0.6 ? '#52c41a' : '#ff4d4f' } }} />
                  {Number(detailData.attempt?.pending_ai || 0) > 0 && (
                    <Tag color="blue">{t('exGradingPendingN', { count: detailData.attempt.pending_ai })}</Tag>
                  )}
                </Space>
              </Card>
              {(!detailData.questions || detailData.questions.length === 0) ? (
                <Typography.Text type="secondary">{t('noQuestionData')}</Typography.Text>
              ) : detailData.questions.map((q: any, idx: number) => {
                const answers = detailData.attempt.answers || {}
                const ans = answers[String(q.id)] || {}
                // S-GRADING(P2): 还在后台批改的题不显示对错与得分
                const pendingItem = ans.grading === 'pending' || ans.graded_by === 'queued'
                const isCorrect = ans.is_correct
                const isEssay = !pendingItem
                  && (q.type === 'essay' || q.type === 'subjective' || ans.grading_type === 'essay')
                const options = q.options || {}
                const optionLabels = Object.keys(options)
                const TYPE_MAP2: Record<string, string> = {
                  single: t('q_short_single'), multiple: t('q_short_multi'), true_false: t('q_short_tf'), short: t('q_short_short'),
                  fill: t('q_short_fill'), essay: t('q_short_essay'), subjective: t('q_short_subj'),
                }
                return (
                  <Card key={q.id} size="small" style={{ marginBottom: 8 }}
                    title={<Space>{pendingItem
                        ? <Tag color="blue">{t('exGradingPending')}</Tag>
                        : <Tag color={isCorrect ? 'green' : 'red'}>{isCorrect ? t('xCorrect') : t('xWrong')}</Tag>}
                      {TYPE_MAP2[q.type] || q.type} | {t('qLabelIdx', { no: idx + 1 })}</Space>}>
                    <Typography.Paragraph style={{ fontWeight: 500, marginBottom: 8 }}><FormulaRenderer content={q.question_text} /></Typography.Paragraph>
                    <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} size="large" />
                    {optionLabels.length > 0 && (
                      <div style={{ marginBottom: 8, padding: 8, background: 'var(--bg-layout)', borderRadius: 4 }}>
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
                        <span style={{ color: pendingItem ? '#1677ff' : (isCorrect ? '#52c41a' : '#ff4d4f') }}>
                          {pendingItem ? t('exGradingPending') : `${ans.score || 0} / ${ans.max_score || q.question_score || 0}`}
                        </span>
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
                        <div style={{ background: 'var(--bg-layout)', padding: 10, borderRadius: 6, marginTop: 4 }}>
                          <div style={{ fontWeight: 'bold', marginBottom: 6, fontSize: 13 }}>{t('aiMultiScore')}</div>
                          <Row gutter={8}>
                            {['content', 'structure', 'language'].map((dim) => {
                              const dimData = ans.dimensions?.[dim] || q.dimensions?.[dim]
                              if (!dimData) return null
                              const labels2: Record<string, string> = { content: t('dimContent'), structure: t('dimStructure'), language: t('dimLanguage') }
                              return (
                                <Col span={8} key={dim}>
                                  <div style={{ textAlign: 'center', background: 'var(--bg-container)', borderRadius: 4, padding: 4 }}>
                                    <div style={{ fontSize: 18, fontWeight: 'bold', color: '#1677ff' }}>{dimData.score}</div>
                                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{labels2[dim]}/10</div>
                                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{dimData.comment}</div>
                                  </div>
                                </Col>
                              )
                            })}
                          </Row>
                          {(ans.overall_comment || q.overall_comment) && (
                            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-primary)' }}>
                              <strong>{t('overallColon')}</strong>{ans.overall_comment || q.overall_comment}
                            </div>
                          )}
                          {(ans.improvement_suggestions || q.improvement_suggestments)?.length > 0 && (
                            <div style={{ marginTop: 6, fontSize: 12 }}>
                              <strong>{t('improveColon')}</strong>
                              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                                {(ans.improvement_suggestions || q.improvement_suggestions || []).map((s: string, i: number) => (
                                  <li key={i} style={{ color: 'var(--text-secondary)' }}>{s}</li>
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
          {Number(detail.attempt?.pending_ai || 0) > 0 && (
            <Tag color="blue">{t('exGradingPendingN', { count: detail.attempt.pending_ai })}</Tag>
          )}
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
        // S-GRADING(P2): 后台还没判完的题不显示对错
        const pendingItem = ans.grading === 'pending' || ans.graded_by === 'queued'
        const isCorrect = ans.is_correct
        const isEssay = !pendingItem && (q.type === 'essay' || q.type === 'subjective')
        const options = q.options || {}
        const optionLabels = Object.keys(options)

        return (
          <Card key={q.id} size="small" style={{ marginBottom: 6 }}
            title={<Space>
              {pendingItem
                ? <Tag color="blue">{t('exGradingPending')}</Tag>
                : <Tag color={isCorrect ? 'green' : 'red'}>{isCorrect ? t('xCorrect') : t('xWrong')}</Tag>}
              {TYPE_MAP[q.type] || q.type} | {t('qLabelIdx', { no: idx + 1 })}
              {ans.teacher_adjusted && <Tag color="purple">{t('adjusted')}</Tag>}
            </Space>}>
            <Typography.Paragraph style={{ fontWeight: 500, marginBottom: 8, fontSize: 13 }}>
              <FormulaRenderer content={q.question_text} />
            </Typography.Paragraph>
            <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} size="large" />

            {/* 选择题选项 */}
            {optionLabels.length > 0 && (
              <div style={{ marginBottom: 8, padding: 8, background: 'var(--bg-layout)', borderRadius: 4 }}>
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
                <span style={{ color: pendingItem ? '#1677ff' : (isCorrect ? '#52c41a' : '#ff4d4f') }}>
                  {pendingItem ? t('exGradingPending') : `${ans.score || 0} / ${ans.max_score || q.question_score || 0}`}
                </span>
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
                <div style={{ background: 'var(--bg-layout)', padding: 10, borderRadius: 6, marginTop: 4 }}>
                  <div style={{ fontWeight: 'bold', marginBottom: 6, fontSize: 13 }}>{t('aiMultiScore')}</div>
                  <Row gutter={8}>
                    {['content', 'structure', 'language'].map((dim) => {
                      const dimData = ans.dimensions?.[dim] || q.dimensions?.[dim]
                      if (!dimData) return null
                      const labels: Record<string, string> = { content: t('dimContent'), structure: t('dimStructure'), language: t('dimLanguage') }
                      return (
                        <Col span={8} key={dim}>
                          <div style={{ textAlign: 'center', background: 'var(--bg-container)', borderRadius: 4, padding: 4 }}>
                            <div style={{ fontSize: 18, fontWeight: 'bold', color: '#1677ff' }}>{dimData.score}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{labels[dim]}/10</div>
                            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{dimData.comment}</div>
                          </div>
                        </Col>
                      )
                    })}
                  </Row>
                  {(ans.overall_comment || q.overall_comment) && (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-primary)' }}>
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
      <Modal maskClosable={false} title={t('reviewAiTitle')} open={reviewModal} onCancel={() => setReviewModal(false)}
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
