import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Layout, Card, Table, Button, Modal, Form, Input, Select, Segmented, InputNumber, Tag, Space, Typography, Tooltip, Popconfirm, Row, Col, Divider, Empty, Tabs, Upload, Image, DatePicker, Dropdown, Badge, theme } from 'antd'
import { message, modalApi } from '../utils/feedback'
import {
  PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined, ClearOutlined,
  LoadingOutlined, BookOutlined, FilterOutlined, FileTextOutlined, UploadOutlined, TagsOutlined,
  BarChartOutlined, ExclamationCircleOutlined, UndoOutlined,
  PictureOutlined, UpOutlined, ToolOutlined,
} from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import dayjs, { type Dayjs } from 'dayjs'
import * as questionsApi from '../api/questions'
import apiClient from '../api/client'
import KnowledgePointSelect, { splitKps, joinKps } from '../components/KnowledgePointSelect'
import useSubjectOptions from '../hooks/useSubjectOptions'
import { pollAiTask } from '../api/aiTask'
import { describeProgress } from '../utils/aiProgress'
import { useAuthStore } from '../stores/authStore'
import type { QuestionInfo } from '../types'
import { useTranslation } from 'react-i18next'
import PageHeader from '../components/PageHeader'
import AnswerLine from '../components/AnswerLine'
import QuestionFormModal from '../components/QuestionFormModal'
import FormulaRenderer from '../components/FormulaRenderer'
import SVGViewer from '../components/SVGViewer'
import MediaDisplay from '../components/MediaDisplay'
import { TYPE_LABELS, TYPE_COLORS, TYPE_OPTIONS } from '../constants/questionTypes'

const { TextArea } = Input
const { Option } = Select

/** 状态色用半透明叠加而不是固定 hex：不用 darkAlgorithm 的主题里，antd 的
 *  colorSuccessBg 等派生令牌仍是浅色，硬编码会更糟。 */
const TINT = {
  success: { bg: 'rgba(82, 196, 26, 0.08)', border: 'rgba(82, 196, 26, 0.35)' },
  info: { bg: 'rgba(22, 119, 255, 0.06)', border: 'rgba(22, 119, 255, 0.30)' },
  warning: { bg: 'rgba(250, 173, 20, 0.10)', border: 'rgba(250, 173, 20, 0.40)' },
  danger: { bg: 'rgba(255, 77, 79, 0.07)', border: 'rgba(255, 77, 79, 0.35)' },
}

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'green',
  medium: 'gold',
  hard: 'red',
}

/**
 * 单元格更新判据：只有这一行的数据对象换了才重渲染。
 * 勾选、开关弹窗、改筛选输入框这类纯本地状态变化，原本会把 50 行 × 8 列的
 * render（Tooltip / Tag / Button / Popconfirm / 公式渲染）全部重算一遍 ——
 * 实测点一个复选框阻塞主线程约 1.1 秒，加这条后回到几十毫秒。
 */
const CELL_UPDATE = (record: QuestionInfo, prevRecord: QuestionInfo) => record !== prevRecord

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: 'easy',
  medium: 'medium',
  hard: 'hard',
}

type SortField = 'created_at' | 'updated_at' | 'id' | 'difficulty'
interface SortState { sortBy: SortField; order: 'asc' | 'desc' }
const SORT_FIELDS: SortField[] = ['created_at', 'updated_at', 'id', 'difficulty']

/** 列表筛选条件（同时是 URL 下钻参数的载体，见 filtersFromQuery） */
interface QBFilters {
  type?: string
  difficulty?: string
  subject?: string
  creator?: string
  knowledge_points?: string
  kp_state?: string
  /** 质量筛选（统计页下钻用）：no_explanation | no_media | pending_media */
  quality?: string
  keyword?: string
  start_date?: string
  end_date?: string
  /** 回收站视图：'deleted' = 只看已软删的题；不设 = 在用题 */
  status?: string
}

const FILTER_KEYS: (keyof QBFilters)[] = [
  'type', 'difficulty', 'subject', 'creator', 'knowledge_points', 'kp_state', 'quality',
  'keyword', 'start_date', 'end_date', 'status',
]

/** 质量筛选的展示名（键在 questions 命名空间） */
const QUALITY_LABELS: Record<string, string> = {
  no_explanation: 'qualityNoExplanation',
  no_media: 'qualityNoMedia',
  pending_media: 'qualityPendingMedia',
}

/** 支持从统计页下钻：/question-bank?type=...&creator=...&keyword=... */
function filtersFromQuery(qs: string): QBFilters {
  const params = new URLSearchParams(qs)
  const next: QBFilters = {}
  for (const key of FILTER_KEYS) {
    const val = params.get(key)
    if (val) (next as Record<string, string>)[key] = val
  }
  return next
}

/** 内容相同就复用旧对象：filters 是 loadQuestions 的依赖，引用一变就会多发一次请求 */
function sameFilters(a: QBFilters, b: QBFilters): boolean {
  for (const key of FILTER_KEYS) {
    if ((a[key] || undefined) !== (b[key] || undefined)) return false
  }
  return true
}

/** 日期区间同样要"值相等即复用"，否则每次 effect 都产生新数组、连累 dateRange 相关渲染 */
function sameRange(
  a: [Dayjs | null, Dayjs | null] | null,
  b: [Dayjs | null, Dayjs | null] | null,
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return String(a[0]?.valueOf()) === String(b[0]?.valueOf()) && String(a[1]?.valueOf()) === String(b[1]?.valueOf())
}

function rangeFromQuery(qs: string): [Dayjs | null, Dayjs | null] | null {
  const params = new URLSearchParams(qs)
  const sd = params.get('start_date')
  const ed = params.get('end_date')
  if (!sd && !ed) return null
  return [sd ? dayjs(sd) : null, ed ? dayjs(ed) : null]
}

function sortFromQuery(qs: string): SortState {
  const params = new URLSearchParams(qs)
  const raw = params.get('sort') || 'created_at'
  const sortBy = (SORT_FIELDS as string[]).includes(raw) ? (raw as SortField) : 'created_at'
  const order = params.get('order') === 'asc' ? 'asc' : 'desc'
  return { sortBy, order }
}

const QuestionBankPage: React.FC = () => {
  const { t } = useTranslation('questions')
  const { t: tc } = useTranslation('common')
  const { token } = theme.useToken()
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryString = searchParams.toString()
  const queryFilters = useMemo(() => filtersFromQuery(queryString), [queryString])
  const queryRange = useMemo(() => rangeFromQuery(queryString), [queryString])

  // 学科清单统一走共享 hook：与组卷/测验同一份，换学科只改配置，不在页面里各拉一份
  const { subjects: subjectOptions, defaultSubject: subjectDefault } = useSubjectOptions()

  // ── 生成试题表单 ──
  const [generateForm] = Form.useForm()
  // 知识点候选由共用控件从课程树拉取（含模块级缓存），此处只负责按学科过滤
  const genSubject = Form.useWatch('subject', generateForm)
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
  const [filters, setFilters] = useState<QBFilters>(() => filtersFromQuery(queryString))
  const [keywordInput, setKeywordInput] = useState(() => filtersFromQuery(queryString).keyword || '')
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(() => rangeFromQuery(queryString))
  const [creatorOptions, setCreatorOptions] = useState<{ username: string; name: string }[]>([])
  /** 题库里实际出现过的学科（可能包含已从配置移除的历史值，如"生物"） */
  const [metaSubjects, setMetaSubjects] = useState<string[]>([])
  const [sort, setSort] = useState<SortState>(() => sortFromQuery(queryString))

  // 创建者筛选项 + 未标注角标：与统计页共用同一份元数据，页面本来就拉一次，不多打请求
  const [untaggedCount, setUntaggedCount] = useState(0)
  const loadMeta = useCallback(async () => {
    try {
      const meta = await questionsApi.getQuestionAnalyticsMeta()
      setCreatorOptions(meta.creators || [])
      setMetaSubjects(meta.subjects || [])
      setUntaggedCount(Number(meta.untagged_count ?? 0))
    } catch {
      setCreatorOptions([])
    }
  }, [])
  useEffect(() => { void loadMeta() }, [loadMeta])

  // 学科下拉 = 配置里的学科 ∪ 题库里实际存在的学科。
  // 只吃配置会漏掉历史值（如已下线课程的"生物"题），只吃实际值又会出现"数学"这类空学科。
  const subjectFilterOptions = useMemo(() => {
    const set = new Set<string>([...(subjectOptions || []), ...metaSubjects])
    return [...set].filter(Boolean)
  }, [subjectOptions, metaSubjects])

  /** 筛选 + 分页写回 URL：刷新不丢、链接可分享、浏览器前进后退可用 */
  const writeUrl = useCallback((f: QBFilters, p: number, s: SortState) => {
    const next = new URLSearchParams()
    for (const key of FILTER_KEYS) {
      const v = f[key]
      if (v) next.set(key, String(v))
    }
    if (p > 1) next.set('page', String(p))
    if (s.sortBy !== 'created_at' || s.order !== 'desc') {
      next.set('sort', s.sortBy)
      next.set('order', s.order)
    }
    setSearchParams(next, { replace: true })
  }, [setSearchParams])

  /** 唯一的筛选入口：改条件、回到第 1 页、同步 URL、切换视图时清空勾选 */
  const applyFilters = (patch: Partial<QBFilters>, opts?: { keepPage?: boolean }) => {
    const next: QBFilters = { ...filters, ...patch }
    for (const key of FILTER_KEYS) {
      if (!next[key]) delete next[key]
    }
    const p = opts?.keepPage ? page : 1
    if ((next.status || '') !== (filters.status || '')) setSelectedRowKeys([])
    setFilters(next)
    if (p !== page) setPage(p)
    writeUrl(next, p, sort)
  }

  // 一键只看未标注，再点取消；数字与 kp_state=none 的列表口径同源，点进去"共 N 道题"必然对得上
  const toggleUntaggedFilter = () => {
    applyFilters({ kp_state: filters.kp_state === 'none' ? undefined : 'none' })
  }

  const filterChips = useMemo(() => {
    const chips: { key: keyof QBFilters | 'date'; label: string }[] = []
    if (filters.type) chips.push({ key: 'type', label: `${t('questionType')}：${TYPE_LABELS[filters.type] || filters.type}` })
    if (filters.difficulty) chips.push({ key: 'difficulty', label: `${t('difficulty')}：${t(filters.difficulty)}` })
    if (filters.subject) chips.push({ key: 'subject', label: `${t('subject')}：${filters.subject}` })
    if (filters.creator) {
      const c = creatorOptions.find((x) => x.username === filters.creator)
      chips.push({ key: 'creator', label: `${t('creator')}：${c ? c.name : filters.creator}` })
    }
    if (filters.knowledge_points) {
      chips.push({ key: 'knowledge_points', label: `${t('knowledgePoint')}：${filters.knowledge_points}` })
    }
    if (filters.kp_state) {
      chips.push({
        key: 'kp_state',
        label: `${t('kpStateFilter')}：${filters.kp_state === 'none' ? t('kpStateNone') : t('kpStateTagged')}`,
      })
    }
    if (filters.quality) {
      chips.push({
        key: 'quality',
        label: `${t('qualityFilter')}：${QUALITY_LABELS[filters.quality] ? t(QUALITY_LABELS[filters.quality]) : filters.quality}`,
      })
    }
    if (filters.keyword) chips.push({ key: 'keyword', label: t('keywordChip', { value: filters.keyword }) })
    if (filters.start_date || filters.end_date) {
      chips.push({ key: 'date', label: t('dateChip', { range: `${filters.start_date || '…'} ~ ${filters.end_date || '…'}` }) })
    }
    if (filters.status === 'deleted') chips.push({ key: 'status', label: t('viewRecycle') })
    return chips
  }, [filters, creatorOptions, t])

  const resetFilters = () => {
    setKeywordInput('')
    setDateRange(null)
    setSelectedRowKeys([])
    setPage(1)
    setFilters({})
    writeUrl({}, 1, sort)
  }

  // 多选批量删除：只作用于当前页可见行（翻页后自动剔除不可见 id，见下方 effect）
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [batchDeleting, setBatchDeleting] = useState(false)
  // 回收站：计数只用来在视图切换上标出积压量，彻底删除时才用
  const [recycleTotal, setRecycleTotal] = useState(0)
  const [purging, setPurging] = useState(false)
  const [restoring, setRestoring] = useState(false)

  // ── 试题表单弹窗（新建 / 编辑 / 配图，同一个组件三个入口） ──
  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create')
  const [formQuestion, setFormQuestion] = useState<QuestionInfo | null>(null)
  const [formTab, setFormTab] = useState<'form' | 'media'>('form')
  /** 深链打开别人创建的题时置 true：能看到全貌但保存按钮不可用 */
  const [formReadOnly, setFormReadOnly] = useState(false)

  // URL 参数 -> 筛选条件。两个 setter 都做了"值没变就保留原引用"，
  // 避免挂载时 filters 被换成等价的新对象后 loadQuestions 重建、同一页数据再拉一遍
  useEffect(() => {
    setFilters(prev => (sameFilters(prev, queryFilters) ? prev : queryFilters))
    setKeywordInput(queryFilters.keyword || '')
    setDateRange(prev => (sameRange(prev, queryRange) ? prev : queryRange))
    // 分页/排序从 URL 读回（刷新、分享链接、浏览器后退都靠这里）
    const urlPage = Math.max(1, Number(searchParams.get('page') || 1) || 1)
    setPage(prev => (prev === urlPage ? prev : urlPage))
    const urlSort = sortFromQuery(queryString)
    setSort(prev => (prev.sortBy === urlSort.sortBy && prev.order === urlSort.order ? prev : urlSort))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryFilters, queryRange, queryString])

  // ── ?id= 深链：错题管理 / 练习 / 抽问里点题号直达某道题 ──
  // 只取详情后打开表单，不改列表筛选；题在回收站时切到回收站视图。
  const deepLinkRef = useRef('')
  useEffect(() => {
    const raw = searchParams.get('id')
    if (!raw) { deepLinkRef.current = ''; return }
    if (deepLinkRef.current === raw) return
    deepLinkRef.current = raw

    const clearParam = () => {
      const next = new URLSearchParams(searchParams)
      next.delete('id')
      setSearchParams(next, { replace: true })
    }
    const idNum = Number(raw)
    if (!Number.isFinite(idNum) || idNum <= 0) { clearParam(); return }

    // 注意：不要用 cancelled 标志 —— StrictMode 下 effect 会挂载→清理→再挂载，
    // 第一次请求被 cleanup 作废、第二次又被上面的 ref 拦住，结果谁都不执行
    void (async () => {
      try {
        const q = await questionsApi.getQuestion(idNum)
        if (q.status === 'deleted') {
          message.info(t('deepLinkInRecycle'))
          // applyFilters 会按筛选重建参数，id 自然被丢掉，不必再清一次
          applyFilters({ status: 'deleted' })
          return
        }
        const canEdit = user?.role === 'admin' || q.creator_username === user?.username
        setFormMode('edit')
        setFormQuestion(q)
        setFormTab('form')
        setFormReadOnly(!canEdit)
        setFormOpen(true)
        clearParam()
      } catch (err: any) {
        message.warning(
          err?.response?.status === 404
            ? t('deepLinkMissing')
            : (err?.response?.data?.detail || t('deepLinkMissing')),
        )
        clearParam()
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // ── 加载题库列表 ──
  // 翻页/筛选连点时，旧请求的结果一律作废：否则慢的那次会把新页数据盖掉
  const reqSeqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const loadQuestions = useCallback(async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const seq = ++reqSeqRef.current
    setLoading(true)
    try {
      const res = await questionsApi.listQuestions(
        {
          ...filters, page, page_size: pageSize,
          sort: sort.sortBy, order: sort.order, include_refs: 1,
        },
        { signal: ctrl.signal },
      )
      if (seq !== reqSeqRef.current) return
      // 删掉某页最后一条后停在空页很困惑：还有数据就自动回退一页
      if (res.questions.length === 0 && page > 1 && res.total > 0) {
        setPage(page - 1)
        return
      }
      setQuestions(res.questions)
      setTotal(res.total)
    } catch (err: any) {
      if (ctrl.signal.aborted || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return
      message.error(err?.response?.data?.detail || t('loadFailed'))
    } finally {
      if (seq === reqSeqRef.current) setLoading(false)
    }
  }, [filters, page, pageSize, sort, t])

  useEffect(() => {
    loadQuestions()
  }, [loadQuestions])

  // 回收站积压多少道：只查 total（page_size=1），标在视图切换上，别让人靠猜
  const loadRecycleTotal = useCallback(async () => {
    try {
      const res = await questionsApi.listQuestions({ status: 'deleted', page: 1, page_size: 1 })
      setRecycleTotal(res.total ?? 0)
    } catch { /* 次要数据：拿不到就不显示数字，不影响列表 */ }
  }, [])
  useEffect(() => { void loadRecycleTotal() }, [loadRecycleTotal])

  // 列表一变（翻页/改筛选/删完刷新）就把不在这一页的 id 从选择里剔掉：
  // 否则"已选 30 道"里混着一屏看不见的题，删除结果永远对不上号
  useEffect(() => {
    setSelectedRowKeys((keys) => keys.filter((k) => questions.some((q) => q.id === Number(k))))
  }, [questions])

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

      const res = await questionsApi.generateQuestionsWithMedia({
        subject: values.subject,
        knowledge_points: Array.isArray(values.knowledge_points)
          ? values.knowledge_points.join('、')
          : String(values.knowledge_points || '').trim(),
        question_type: values.question_type,
        count: totalCount,
        difficulty: values.difficulty || 'medium',
      }, (p) => {
        // 后台任务会报 generate / media / done 阶段，直接翻成界面文案（原来是 setTimeout 假进度）
        setGenProgress({
          step: 2,
          text: describeProgress(p, t),
          count: p.done ?? 0,
          total: p.total ?? totalCount,
        })
      })

      setGeneratedQuestions(res.questions)
      setGenProgress({ step: 0, text: '', count: 0, total: 0 })
      message.success(res.message)
      // note 里带的是"配图哪几张没成功/代码题不落题库"这类降级信息，
      // 只显示"成功生成 N 道"会让教师以为图都齐了
      if (res.note) message.warning(res.note, 10)
      loadQuestions()
      setGenerating(false)
    } catch (err: any) {
      // 轮询超时 != 任务失败：后台还在出题+生图，此时提示"失败"会诱导教师重复提交，
      // 结果是重复入库的题目 + 重复烧掉生图配额
      if (err?.aiTaskTimeout) {
        setGenError(t('generateStillRunning'))
        setGenProgress({ step: -1, text: '', count: 0, total: 0 })
        setGenerating(false)
        loadQuestions()
        return
      }
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
      let res = await questionsApi.extractQuestions(formData)
      if (res.mode === 'task' && res.task_id) {
        // 长文档分批提取转后台: 轮询任务(计时器继续走, 界面显示已用时)
        message.info(res.message)
        const polled = await pollAiTask(res.task_id, 900000)
        if (!polled) throw new Error(t('extractFail'))
        if (polled.error) throw new Error(String(polled.error))
        res = polled as typeof res
      }
      setExtractedQuestions(res.questions || [])
      message.success(res.message || t('extractedCount', { count: res.total || 0 }))
      if (res.note) message.info(res.note)
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
  const [dedupResult, setDedupResult] = useState<questionsApi.DedupResult | null>(null)
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

  // ── AI 补标（仅管理员；先预览建议，确认后才写入） ──
  const [tagFillResult, setTagFillResult] = useState<questionsApi.TagFillResult | null>(null)
  const [tagFillLoading, setTagFillLoading] = useState(false)
  // 可编辑的建议清单(预览返回后本地维护, 确认时回传后端二次校验)
  const [tagFillItems, setTagFillItems] = useState<questionsApi.TagFillItem[]>([])

  const handleTagFill = async () => {
    setTagFillLoading(true)
    try {
      const res = await questionsApi.tagFillQuestions(false)
      setTagFillResult(res)
      setTagFillItems(res.items ?? [])
    } catch (e: any) {
      message.error(t('tagFillFail') + ': ' + (e?.response?.data?.detail || e?.message || tc('failed')))
    } finally {
      setTagFillLoading(false)
    }
  }

  const runTagFillConfirm = async () => {
    setTagFillLoading(true)
    try {
      const edited = tagFillItems
        .filter((it) => it.tags.length > 0)
        .map((it) => ({ id: it.id, tags: it.tags.slice(0, 3) }))
      const res = await questionsApi.tagFillQuestions(true, edited.length ? 0 : 50, edited.length ? edited : undefined)
      setTagFillResult(res)
      if ((res.written ?? 0) > 0) { loadQuestions(); void loadMeta() }
    } catch (e: any) {
      message.error(t('tagFillFail') + ': ' + (e?.response?.data?.detail || e?.message || tc('failed')))
    } finally {
      setTagFillLoading(false)
    }
  }

  const openCreate = () => {
    setFormReadOnly(false)
    setFormMode('create')
    setFormQuestion(null)
    setFormTab('form')
    setFormOpen(true)
  }
  const openEdit = (q: QuestionInfo) => {
    setFormReadOnly(false)
    setFormMode('edit')
    setFormQuestion(q)
    setFormTab('form')
    setFormOpen(true)
  }
  const openMedia = (q: QuestionInfo) => {
    setFormReadOnly(false)
    setFormMode('edit')
    setFormQuestion(q)
    setFormTab('media')
    setFormOpen(true)
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
      // 回收站角标与未标注角标都要跟着变，否则删完还显示旧数字
      void loadRecycleTotal()
      void loadMeta()
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

  // 权限口径统一在这里：管理员（role=admin）可动全部，教师只能动自己创建的
  const canOperate = (record: QuestionInfo) => user?.role === 'admin' || record.creator_username === user?.username

  // ── 多选批量删除 ──
  /**
   * 把后端按条返回的跳过原因翻成一句提示。
   * 原因文案放前端而不是后端拼中文，英文界面才不会露出中文兜底。
   */
  const describeSkipped = (skipped: questionsApi.BatchDeleteSkipped[]): string => {
    if (skipped.length === 0) return ''
    const groups = new Map<string, questionsApi.BatchDeleteSkipped[]>()
    skipped.forEach((s) => {
      const arr = groups.get(s.kind) || []
      arr.push(s)
      groups.set(s.kind, arr)
    })
    const parts: string[] = []
    groups.forEach((items, kind) => {
      const count = items.length
      if (kind === 'in_use') {
        const names = items.flatMap((i) => [...(i.exams || []), ...(i.practices || [])]).slice(0, 3)
        parts.push(t('bulkDeleteSkipInUse', { count, names: names.join(', ') }))
      } else if (kind === 'not_owner') {
        parts.push(t('bulkDeleteSkipNotOwner', { count }))
      } else if (kind === 'not_found' || kind === 'already_deleted') {
        parts.push(t('bulkDeleteSkipGone', { count }))
      } else {
        parts.push(t('bulkDeleteSkipOther', { count }))
      }
    })
    return parts.join(' · ')
  }

  const handleBulkDelete = () => {
    const ids = selectedRowKeys.map(Number)
    if (ids.length === 0) {
      message.warning(t('bulkDeleteSelectFirst'))
      return
    }
    modalApi.confirm({
      title: t('confirmBulkDeleteQuestions', { count: ids.length }),
      icon: <ExclamationCircleOutlined />,
      content: t('confirmBulkDeleteQuestionsDesc'),
      okText: t('bulkDelete'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        setBatchDeleting(true)
        try {
          const res = await questionsApi.batchDeleteQuestions(ids)
          const skipped = res.skipped || []
          if (res.deleted > 0 && skipped.length === 0) {
            message.success(t('bulkDeleteDone', { count: res.deleted }))
          } else if (res.deleted > 0) {
            // 部分成功：把跳过的原因摊开说，教师才知道去哪儿解除占用
            message.warning(t('bulkDeletePartial', { deleted: res.deleted, detail: describeSkipped(skipped) }), 10)
          } else {
            message.warning(t('bulkDeleteNone', { detail: describeSkipped(skipped) }), 10)
          }
          setSelectedRowKeys([])
          loadQuestions()
          void loadRecycleTotal()
          void loadMeta()
        } catch (err: any) {
          const detail = err?.response?.data?.detail
          message.error(typeof detail === 'string' ? detail : t('deleteFailed'))
        } finally {
          setBatchDeleting(false)
        }
      },
    })
  }

  // ── 彻底删除（回收站 → 物理删除，不可撤销）──
  /** 后端按条返回 kind，文案在前端拼：英文界面才不会露出中文兜底 */
  const describePurgeBlocker = (b?: questionsApi.PurgeBlocker): string => {
    if (!b) return t('purgeSkipOther')
    switch (b.kind) {
      case 'not_found':
        return t('purgeSkipNotFound')
      case 'not_in_recycle_bin':
        return t('purgeSkipNotRecycle')
      case 'not_owner':
        return t('purgeSkipNotOwner')
      case 'in_use':
        return t('purgeSkipInUse', {
          names: [...(b.exams || []), ...(b.practices || [])].slice(0, 3).join('、') || '-',
        })
      case 'in_wrong_book':
        return t('purgeSkipWrongBook', { entries: b.entries ?? 0, students: b.students ?? 0 })
      default:
        return t('purgeSkipOther')
    }
  }

  /**
   * 先拉预览再弹确认：判定与执行共用后端同一份函数，所以这里列出的"能删/不能删"
   * 与点确认后的结果一致。彻底删除不可撤销，绝不能凭勾选数直接删。
   */
  const handlePurge = async (ids: number[]) => {
    if (ids.length === 0) {
      message.warning(t('bulkDeleteSelectFirst'))
      return
    }
    setPurging(true)
    let preview: questionsApi.PurgePreviewResponse
    try {
      preview = await questionsApi.purgePreview(ids)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('purgePreviewFailed'))
      setPurging(false)
      return
    }
    setPurging(false)

    const ok = preview.items.filter((i) => i.purgeable)
    const blocked = preview.items.filter((i) => !i.purgeable)
    const edges = ok.reduce((n, i) => n + (i.cleanup?.kp_edges || 0), 0)
    const files = ok.reduce(
      (n, i) => n + (i.cleanup?.live_files || 0) + (i.cleanup?.archived_files || 0), 0)

    modalApi.confirm({
      title: t('purgeConfirmTitle', { count: ok.length }),
      icon: <ExclamationCircleOutlined />,
      width: 620,
      okText: t('purgeOk'),
      okType: 'danger',
      cancelText: t('cancel'),
      okButtonProps: { disabled: ok.length === 0 },
      content: (
        <div style={{ maxHeight: 340, overflow: 'auto' }}>
          <Typography.Paragraph type="danger" style={{ fontSize: 12, marginBottom: 6 }}>
            {t('purgeConfirmDesc')}
          </Typography.Paragraph>
          {ok.length > 0 && (
            <ul style={{ paddingLeft: 18, margin: '0 0 6px' }}>
              {ok.slice(0, 12).map((i) => (
                <li key={i.id} style={{ fontSize: 12 }}>
                  #{i.id} {(i.title || '-').slice(0, 40)}
                  <Typography.Text type="secondary">
                    （{TYPE_LABELS[i.type || ''] || i.type || '-'}·{i.subject || '-'}）
                  </Typography.Text>
                </li>
              ))}
              {ok.length > 12 && (
                <li style={{ fontSize: 12 }}>{t('purgeMore', { n: ok.length - 12 })}</li>
              )}
            </ul>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('purgeCleanup', { edges, files })}
          </Typography.Text>
          {blocked.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <Typography.Text style={{ fontSize: 12 }}>
                {t('purgeBlockedNote', { count: blocked.length })}
              </Typography.Text>
              <ul style={{ paddingLeft: 18, margin: '2px 0 0' }}>
                {blocked.slice(0, 8).map((i) => (
                  <li key={i.id} style={{ fontSize: 12 }}>
                    #{i.id} {(i.title || '').slice(0, 24) || '-'} — {i.blockers.map(describePurgeBlocker).join('；')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ),
      onOk: async () => {
        if (ok.length === 0) return
        setPurging(true)
        try {
          const res = await questionsApi.purgeQuestions(ids)
          const skipped = res.skipped || []
          const why = skipped
            .map((x) => `#${x.id} ${describePurgeBlocker(x.blockers?.[0] || { kind: x.kind })}`)
            .join('；')
          if (res.deleted > 0 && skipped.length === 0) {
            message.success(t('purgeDone', { count: res.deleted, files: res.media?.files ?? 0 }))
          } else if (res.deleted > 0) {
            message.warning(t('purgePartial', { count: res.deleted, detail: why }), 10)
          } else {
            message.warning(t('purgeNone', { detail: why }), 10)
          }
          setSelectedRowKeys([])
          loadQuestions()
          void loadRecycleTotal()
        } catch (err: any) {
          message.error(err?.response?.data?.detail || t('purgeFailed'))
        } finally {
          setPurging(false)
        }
      },
    })
  }

  // ── 从回收站还原 ──
  /**
   * 还原比彻底删除轻：不改内容，只把 status 改回 active，后端顺手把归档的配图目录搬回、
   * 按题目自带标签重建知识点连边，所以这里不需要预览清单，说清数量即可。
   */
  const handleRestore = (ids: number[]) => {
    if (ids.length === 0) {
      message.warning(t('bulkDeleteSelectFirst'))
      return
    }
    modalApi.confirm({
      title: t('restoreConfirmTitle', { count: ids.length }),
      icon: <ExclamationCircleOutlined />,
      content: t('restoreConfirmDesc'),
      okText: t('restoreOk'),
      cancelText: t('cancel'),
      onOk: async () => {
        setRestoring(true)
        try {
          const res = await questionsApi.restoreQuestions(ids)
          const skipped = res.skipped || []
          const why = skipped
            .map((x) => `#${x.id} ${x.kind === 'already_active' ? t('restoreSkipAlready')
              : x.kind === 'not_owner' ? t('restoreSkipNotOwner') : t('restoreSkipGone')}`)
            .join('；')
          if (res.restored > 0 && skipped.length === 0) {
            message.success(t('restoreDone', { count: res.restored }))
          } else if (res.restored > 0) {
            message.warning(t('restorePartial', { count: res.restored, detail: why }), 10)
          } else {
            message.warning(t('restoreNone', { detail: why }), 10)
          }
          setSelectedRowKeys([])
          loadQuestions()
          void loadRecycleTotal()
        } catch (err: any) {
          message.error(err?.response?.data?.detail || t('restoreFailed'))
        } finally {
          setRestoring(false)
        }
      },
    })
  }

  // ── 表格列定义 ──
  const rawColumns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 54,
      sorter: true,
      sortOrder: sort.sortBy === 'id' ? (sort.order === 'asc' ? 'ascend' as const : 'descend' as const) : null,
      render: (id: number) => (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>#{id}</span>
      ),
    },
    {
      title: t('questionType'),
      dataIndex: 'type',
      key: 'type',
      width: 68,
      render: (type: string) => (
        <Tag color={TYPE_COLORS[type]}>{TYPE_LABELS[type] || type}</Tag>
      ),
    },
    {
      // 多学科学校里，一屏 50 行分不清哪道题属于哪门课；学科是筛选项却不在列里
      title: t('subject'),
      dataIndex: 'subject',
      key: 'subject',
      width: 68,
      ellipsis: true,
      render: (subject: string) => (
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{subject || '—'}</span>
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
          {/* 省略号交给列宽（CSS），这里只限制送进 KaTeX 的字符数：
              247 字的长题干整段渲染会让 50 行的表格明显变卡 */}
          <span style={{ cursor: 'pointer' }}>
            <FormulaRenderer content={text.length > 120 ? text.slice(0, 120) : text} inline />
          </span>
        </Tooltip>
      ),
    },
    {
      title: t('knowledgePoints'),
      dataIndex: 'knowledge_points',
      key: 'knowledge_points',
      width: 80,
      ellipsis: true,
      // 知识点最长 46 字，列宽只兜得住 p90（15 字）：截断时悬浮看全，别让人去展开行翻
      render: (text: string) => text ? (
        <Tooltip title={text}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{text}</span>
        </Tooltip>
      ) : (
        <Tooltip title={t('kpUnlabeledTip')}>
          <Tag color="default" style={{ marginInlineEnd: 0, fontSize: 12 }}>{t('kpUnlabeled')}</Tag>
        </Tooltip>
      ),
    },
    {
      title: t('difficulty'),
      dataIndex: 'difficulty',
      key: 'difficulty',
      width: 60,
      sorter: true,
      sortOrder: sort.sortBy === 'difficulty' ? (sort.order === 'asc' ? 'ascend' as const : 'descend' as const) : null,
      render: (d: string) => (
        <Tag color={DIFFICULTY_COLORS[d]}>{t(DIFFICULTY_LABELS[d]) || d}</Tag>
      ),
    },
    {
      title: t('creator'),
      // C-CREATOR: 统一显示用户名 —— 库里 creator_name 历史混存了姓名/角色名/空值,
      // 导致同一批题的创建者一会儿 root、一会儿 管理员、一会儿 UNET; creator_username 恒有值且唯一
      dataIndex: 'creator_username',
      key: 'creator_username',
      width: 72,
      ellipsis: true,
      render: (username: string, record: QuestionInfo) => (
        <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
          {username || record.creator_name}
        </span>
      ),
    },
    {
      title: t('media'),
      dataIndex: 'has_svg',
      key: 'has_svg',
      width: 72,
      align: 'center' as const,
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
          return <SVGViewer svgCode={record.svg_content} description={t('preview')} thumbHeight={30} />
        }
        // 有万相/上传的图片 → 显示第一张缩略图
        if (mf.length > 0 && mf[0].url) {
          return (
            <div style={{ width: 60, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              <Image src={mf[0].url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                preview={{ mask: null }} />
            </div>
          )
        }
        // 有占位符未生成 → 显示数量标记
        if ((record.media_placeholders?.length || 0) > 0) {
          return (
            <Tooltip title={t('placeholderCount', { count: record.media_placeholders?.length || 0 })}>
              <Tag color="orange" icon={<PictureOutlined />}>{record.media_placeholders?.length}</Tag>
            </Tooltip>
          )
        }
        return <span style={{ color: token.colorTextQuaternary }}>—</span>
      },
    },
    {
      // 删除前先给出"正在使用"的信号，不用等 409 弹回来才知道
      title: t('refCount'),
      dataIndex: 'ref_count',
      key: 'ref_count',
      width: 56,
      align: 'center' as const,
      render: (n: number) => (n > 0 ? (
        <Tooltip title={t('refCountTip', { count: n })}>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>{n}</Tag>
        </Tooltip>
      ) : (
        <span style={{ color: token.colorTextQuaternary }}>—</span>
      )),
    },
    {
      title: t('time'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 96,
      sorter: true,
      sortOrder: sort.sortBy === 'created_at' ? (sort.order === 'asc' ? 'ascend' as const : 'descend' as const) : null,
      render: (v: string) => {
        if (!v) return '-'
        // 同一年的题只显示"月-日 时:分"，跨年才补年份；完整时间戳收进 Tooltip
        const compact = v.slice(0, 4) === dayjs().format('YYYY') ? v.slice(5, 16) : v.slice(0, 10)
        return (
          <Tooltip title={v.slice(0, 19)}>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{compact}</span>
          </Tooltip>
        )
      },
    },
    {
      title: t('actions'),
      key: 'action',
      width: 104,
      render: (_: any, record: QuestionInfo) => {
        // 权限：管理员（role=0）可操作全部，教师只能操作自己的（与勾选框同一口径）
        const canEdit = canOperate(record)
        if (!canEdit) return <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{t('onlyCreatorCanOperate')}</span>
        if (filters.status === 'deleted') {
          // 回收站里不给"编辑/配图/再软删"，只给还原与彻底删除这两个真实可用的动作
          return (
            <Space size="small">
              <Tooltip title={t('restore')}>
                <Button
                  type="link"
                  size="small"
                  loading={restoring}
                  icon={<UndoOutlined />}
                  onClick={() => handleRestore([record.id])}
                />
              </Tooltip>
              <Tooltip title={t('purge')}>
                <Button
                  type="link"
                  size="small"
                  danger
                  loading={purging}
                  icon={<DeleteOutlined />}
                  onClick={() => { void handlePurge([record.id]) }}
                />
              </Tooltip>
            </Space>
          )
        }
        return (
          <Space size="small">
            <Tooltip title={t('editQuestion')}>
              <Button type="link" size="small" icon={<EditOutlined />}
                aria-label={t('editQuestion')}
                onClick={() => openEdit(record)} />
            </Tooltip>
            <Tooltip title={t('imageManagement')}>
              <Button type="link" size="small" icon={<PictureOutlined />}
                aria-label={t('imageManagement')}
                onClick={() => openMedia(record)} />
            </Tooltip>
            <Popconfirm
              title={t('confirmDelete')}
              description={t('confirmDeleteDesc')}
              onConfirm={() => handleDelete(record.id)}
              okText={t('confirm')}
              cancelText={t('cancel')}
            >
              <Tooltip title={t('deleteQuestion')}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />}
                  aria-label={t('deleteQuestion')} />
              </Tooltip>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  // 见 CELL_UPDATE 注释：纯展示列挂上；操作列必须排除 —— 它读 restoring/purging，
  // 只比较 record 引用会让"还原/彻底删除"的 loading 永远不显示
  const columns = rawColumns.map((col) => (
    col.key === 'action' ? col : { ...col, shouldCellUpdate: CELL_UPDATE }
  ))

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: 'var(--bg-container)', borderRadius: 8, overflow: 'auto', fontSize: 14, padding: 24 }}>
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        {/* ── 统一页面头：标题 / 副标题 / 主次操作 ── */}
        <PageHeader
          icon={<BookOutlined />}
          title={t('title')}
          subtitle={t('pageSubtitle')}
          extra={(
            <>
              <Button icon={<ReloadOutlined />} onClick={loadQuestions} loading={loading}
                aria-label={t('refresh')} />
              {user?.role === 'admin' && untaggedCount > 0 && (
                <Tooltip title={t('kpUnlabeledChipTip', { count: untaggedCount })}>
                  <Badge count={untaggedCount} size="small" overflowCount={9999}
                         color={filters.kp_state === 'none' ? '#ff4d4f' : '#faad14'} offset={[-4, 4]}>
                    <Button icon={<TagsOutlined />}
                            type={filters.kp_state === 'none' ? 'primary' : 'default'}
                            onClick={toggleUntaggedFilter}>
                      {t('kpUnlabeled')}
                    </Button>
                  </Badge>
                </Tooltip>
              )}
              <Button icon={<BarChartOutlined />} onClick={() => navigate('/question-bank/analytics')}>
                {t('analyticsTitle')}
              </Button>
              {/* 低频维护动作收进一个菜单：原来「更多操作」只有一个 AI 补标，
                  去重又单独占一个按钮，7 个按钮同权重反而看不出主次 */}
              <Dropdown
                // 教室一体机是触摸屏：默认 hover 触发时点一下可能只悬停不展开
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'dedup', label: t('dedup'), icon: <ClearOutlined />, disabled: dedupLoading },
                    ...(user?.role === 'admin'
                      ? [{ key: 'tag', label: t('tagFill'), icon: <TagsOutlined />, disabled: tagFillLoading }]
                      : []),
                  ],
                  onClick: ({ key }) => {
                    if (key === 'dedup') void handleDedup()
                    else if (key === 'tag') void handleTagFill()
                  },
                }}
              >
                <Button icon={<ToolOutlined />} loading={dedupLoading || tagFillLoading}>
                  {t('governance')}
                </Button>
              </Dropdown>
              <Button icon={<PlusOutlined />} onClick={openCreate}>{t('manualCreate')}</Button>
              <Button
                type="primary"
                icon={showGeneratePanel ? <UpOutlined /> : <PlusOutlined />}
                onClick={() => setShowGeneratePanel(!showGeneratePanel)}
              >
                {showGeneratePanel ? t('collapsePanel') : t('generateExtract')}
              </Button>
            </>
          )}
        />

        {/* ── 试题生成/提取面板 ── */}
        {showGeneratePanel && (
          <Card style={{ border: `1px solid ${TINT.info.border}`, background: TINT.info.bg }}>
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
                          subject: extractSubject || subjectDefault || subjectOptions[0] || '',
                          question_type: 'single',
                          count: 5,
                          difficulty: 'medium',
                          knowledge_points: [],
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
                          rules={[{ required: true, message: t('knowledgePointRequired') }]}
                        >
                          {/* 全站统一控件：下拉选课程知识点 + 手输（本控件的原型就是这一处） */}
                          <KnowledgePointSelect subject={genSubject || ''} />
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
                                {genError}
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
                              key={`${q.id}-${idx}`}
                              size="small"
                              style={{
                                marginBottom: 8,
                                // 命中题库已有题的是"回填展示"，不是新入库的题：
                                // 画成一样的绿卡会让老师以为又生成了几道，数量也对不上
                                background: (q as any).duplicated ? token.colorFillQuaternary : TINT.success.bg,
                                border: (q as any).duplicated
                                  ? `1px dashed ${token.colorBorder}` : `1px solid ${TINT.success.border}`,
                              }}
                              title={(
                                <span style={{ fontSize: 14 }}>
                                  #{idx + 1} {TYPE_LABELS[q.type] || q.type}
                                  {(q as any).duplicated && (
                                    <Tag color="default" style={{ marginLeft: 8 }}>
                                      {t('qbAlreadyInBank')}
                                    </Tag>
                                  )}
                                </span>
                              )}
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
                                <AnswerLine color="green" label={t('answerColon')} value={q.correct_answer} />
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
                        <Typography.Text strong style={{ fontSize: 13 }}><PictureOutlined /> {t('imageExtract')}</Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
                          {t('imageExtractHint')}
                        </Typography.Text>
                        <div style={{ marginTop: 4 }}>
                          <Upload
                            accept=".jpg,.jpeg,.png,.gif,.webp,.bmp"
                            maxCount={1}
                            showUploadList={true}
                            beforeUpload={async (file) => {
                              const fd = new FormData()
                              fd.append('file', file)
                              fd.append('subject', extractSubject || subjectDefault || subjectOptions[0] || '')
                              fd.append('difficulty', extractDifficulty)
                              // 长图会被切片并逐轮续提，同步请求必然撞上网关超时；
                              // 统一转后台任务，失败重试也不会重复入库
                              fd.append('background', '1')
                              setExtracting(true)
                              setExtractError(null)
                              setExtractElapsed(0)
                              const startTime = Date.now()
                              const timer = setInterval(() => setExtractElapsed(Math.round((Date.now() - startTime) / 1000)), 1000)
                              try {
                                const { data } = await apiClient.post('/api/questions/extract-from-image', fd, {
                                  headers: { 'Content-Type': 'multipart/form-data' },
                                  timeout: 180000,
                                })
                                let result = data
                                if (data?.mode === 'task' && data.task_id) {
                                  message.info(t('imageExtractQueued'))
                                  const polled = await pollAiTask(data.task_id, 900000)
                                  if (!polled) throw new Error(t('extractFail'))
                                  if (polled.error) throw new Error(String(polled.error))
                                  result = polled
                                }
                                setExtractedQuestions(result.questions || [])
                                message.success(result.message || t('extractedCount', { count: result.total || 0 }))
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
                            <Button icon={<UploadOutlined />} disabled={extracting}>{t('selectImage')}</Button>
                          </Upload>
                        </div>
                      </div>
                      <div style={{ marginTop: 16 }}>
                        <Typography.Text strong style={{ fontSize: 13 }}>{t('orPasteText')}</Typography.Text>
                        <TextArea
                          rows={6}
                          value={extractText}
                          onChange={(e) => setExtractText(e.target.value)}
                          placeholder={t('pasteExamplePlaceholder')}
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
                            {extractError}
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
                              key={`${q.id}-${idx}`}
                              size="small"
                              style={{ marginBottom: 8, background: TINT.success.bg, border: `1px solid ${TINT.success.border}` }}
                              title={<span style={{ fontSize: 14 }}>#{idx + 1} {TYPE_LABELS[q.type] || q.type}</span>}
                            >
                              <FormulaRenderer content={q.question_text} />
                              {q.options && Object.entries(q.options).map(([k, v]) => (
                                <div key={k} style={{ margin: '4px 0 0 16px', fontSize: 13 }}>
                                  <Tag>{k}</Tag> <FormulaRenderer content={v as string} inline />
                                </div>
                              ))}
                              <div style={{ marginTop: 8, fontSize: 13 }}>
                                <AnswerLine color="green" label={t('answerColon')} value={q.correct_answer} />
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
        <Row gutter={[8, 8]} align="middle" style={{ marginTop: 8 }}>
          <Col>
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}><FilterOutlined /> {t('filter')}：</span>
          </Col>
          <Col>
            {/* 在用 / 回收站两个视图：回收站里的题不会出现在题库列表、组卷与练习中 */}
            <Segmented
              value={filters.status === 'deleted' ? 'deleted' : 'active'}
              onChange={(v) => applyFilters({ status: v === 'deleted' ? 'deleted' : undefined })}
              options={[
                { value: 'active', label: t('viewActive') },
                { value: 'deleted', label: recycleTotal > 0 ? t('viewRecycleCount', { n: recycleTotal }) : t('viewRecycle') },
              ]}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Select
              allowClear
              placeholder={t('questionType')}
              style={{ width: '100%' }}
              value={filters.type}
              onChange={(val) => applyFilters({ type: val })}
              options={TYPE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Select
              allowClear
              placeholder={t('difficulty')}
              style={{ width: '100%' }}
              value={filters.difficulty}
              onChange={(val) => applyFilters({ difficulty: val })}
              options={[
                { value: 'easy', label: t('easy') },
                { value: 'medium', label: t('medium') },
                { value: 'hard', label: t('hard') },
              ]}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('subject')}
              style={{ width: '100%' }}
              value={filters.subject}
              onChange={(val) => applyFilters({ subject: val })}
              options={subjectFilterOptions.map((sub) => ({ value: sub, label: sub }))}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('analyticsAllCreators')}
              style={{ width: '100%' }}
              value={filters.creator}
              onChange={(val) => applyFilters({ creator: val })}
              options={creatorOptions.map((c) => ({ value: c.username, label: `${c.name} (${c.username})` }))}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <KnowledgePointSelect
              subject={filters.subject || ''}
              value={splitKps(filters.knowledge_points || '')}
              onChange={(v) => applyFilters({
                knowledge_points: joinKps(Array.isArray(v) ? v : [v]) || undefined,
              })}
              style={{ width: '100%' }}
              placeholder={t('analyticsKnowledgePointFilter')}
            />
          </Col>
          <Col xs={12} sm={8} md={3}>
            {/* 标注状态：管理员批量补标/编辑时先只看没标的题（配合"更多操作 → AI 补标"用） */}
            <Select
              allowClear
              placeholder={t('kpStateFilter')}
              style={{ width: '100%' }}
              value={filters.kp_state}
              onChange={(val) => applyFilters({ kp_state: val })}
              options={[
                { value: 'none', label: t('kpStateNone') },
                { value: 'tagged', label: t('kpStateTagged') },
              ]}
            />
          </Col>
          <Col xs={24} sm={10} md={6}>
            <DatePicker.RangePicker
              style={{ width: '100%' }}
              value={dateRange}
              onChange={(v) => {
                const range = v as [Dayjs | null, Dayjs | null] | null
                setDateRange(range)
                applyFilters({
                  start_date: range?.[0]?.format('YYYY-MM-DD'),
                  end_date: range?.[1]?.format('YYYY-MM-DD'),
                })
              }}
            />
          </Col>
          <Col xs={24} sm={14} md={7}>
            <Input.Search
              placeholder={t('searchContentOrKp')}
              allowClear
              value={keywordInput}
              onChange={(e) => {
                setKeywordInput(e.target.value)
                if (!e.target.value) applyFilters({ keyword: undefined })
              }}
              onSearch={(val) => applyFilters({ keyword: val || undefined })}
            />
          </Col>
          <Col>
            <Button onClick={resetFilters} disabled={filterChips.length === 0}>{t('resetFilters')}</Button>
          </Col>
        </Row>

        {/* 已选条件回显：只剩一个小计数时，老师容易把"筛出 3 道"当成"题库只有 3 道" */}
        {filterChips.length > 0 && (
          <Space wrap size={6}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('activeFilters', { count: filterChips.length })}：
            </Typography.Text>
            {filterChips.map((chip) => (
              <Tag
                key={chip.key}
                closable
                style={{ marginInlineEnd: 0 }}
                onClose={() => {
                  if (chip.key === 'date') {
                    setDateRange(null)
                    applyFilters({ start_date: undefined, end_date: undefined })
                  } else if (chip.key === 'keyword') {
                    setKeywordInput('')
                    applyFilters({ keyword: undefined })
                  } else {
                    applyFilters({ [chip.key]: undefined } as Partial<QBFilters>)
                  }
                }}
              >
                {chip.label}
              </Tag>
            ))}
            <Button type="link" size="small" style={{ fontSize: 12 }} onClick={resetFilters}>{t('clearAllFilters')}</Button>
          </Space>
        )}

        {/* ── 多选操作条：勾选后才出现，紧贴表格，删完即隐藏 ── */}
        {selectedRowKeys.length > 0 && (
          <Card size="small" style={{ borderRadius: 8, background: TINT.danger.bg, border: `1px solid ${TINT.danger.border}` }}>
            <Space wrap size={8}>
              <Typography.Text style={{ fontSize: 13 }}>
                <DeleteOutlined /> {t('selectedCount', { count: selectedRowKeys.length })}
              </Typography.Text>
              {filters.status === 'deleted' ? (
                <>
                  <Button size="small" loading={restoring} icon={<UndoOutlined />} onClick={() => handleRestore(selectedRowKeys.map(Number))}>
                    {t('bulkRestore')}
                  </Button>
                  <Button danger size="small" loading={purging} onClick={() => { void handlePurge(selectedRowKeys.map(Number)) }}>
                    {t('bulkPurge')}
                  </Button>
                </>
              ) : (
                <Button danger size="small" loading={batchDeleting} onClick={handleBulkDelete}>
                  {t('bulkDelete')}
                </Button>
              )}
              <Button size="small" onClick={() => setSelectedRowKeys([])}>{t('clearSelection')}</Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {filters.status === 'deleted' ? t('bulkPurgeScopeTip') : t('bulkDeleteScopeTip')}
              </Typography.Text>
            </Space>
          </Card>
        )}

        {/* ── 题库表格 ── */}
        <Table
          dataSource={questions}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="small"
          tableLayout="fixed"
          sticky
          scroll={{ x: 1020 }}
          onChange={(pag, _colFilters, sorter, extra) => {
            if (extra?.action === 'sort') {
              const single = Array.isArray(sorter) ? sorter[0] : sorter
              const field = single?.field as SortField | undefined
              if (field && (SORT_FIELDS as string[]).includes(field)) {
                // 第三次点击取消排序时回到默认（按创建时间倒序），避免出现"无排序"的随机顺序
                const next: SortState = single?.order
                  ? { sortBy: field, order: single.order === 'ascend' ? 'asc' : 'desc' }
                  : { sortBy: 'created_at', order: 'desc' }
                setSort(next)
                setPage(1)
                writeUrl(filters, 1, next)
              }
              return
            }
            const ps = pag.pageSize || pageSize
            if (ps !== pageSize) {
              setPageSize(ps)
              setPage(1)
              writeUrl(filters, 1, sort)
              return
            }
            const p = pag.current || 1
            if (p !== page) {
              setPage(p)
              writeUrl(filters, p, sort)
            }
          }}
          rowSelection={{
            columnWidth: 40,
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys),
            preserveSelectedRowKeys: false,
            getCheckboxProps: (record: QuestionInfo) => ({
              // 别人创建的题直接不让勾，省掉"删完才发现没权限"
              disabled: !canOperate(record),
            }),
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (n) => t('totalQuestions', { count: n }),
          }}
          locale={{ emptyText: <Empty description={t('emptyQuestions')} /> }}
          expandable={{
            columnWidth: 36,
            expandedRowRender: (record) => (
              <div style={{ padding: '8px 0', maxWidth: 800 }}>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>
                  <FormulaRenderer content={record.question_text} />
                </div>
                <MediaDisplay svgContent={record.svg_content} hasSvg={record.has_svg} mediaFiles={record.media_files} size="normal" />
                {record.type !== 'short' && record.options && Object.entries(record.options).map(([k, v]) => (
                  <div key={k} style={{ margin: '4px 0 0 20px', fontSize: 13, color: token.colorTextSecondary }}>
                    <Tag>{k}</Tag> <FormulaRenderer content={v as string} inline />
                  </div>
                ))}
                {record.type === 'short' && (
                  <div style={{ margin: '4px 0 0 20px', fontSize: 13, color: token.colorTextSecondary }}>
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
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {t('knowledgePointColon')}{record.knowledge_points || '-'} | {t('creator')}：{record.creator_username || record.creator_name}
                </div>
              </div>
            ),
          }}
        />
      </Space>

      {/* ── 试题表单弹窗：新建 / 编辑 / 配图 ── */}
      <QuestionFormModal
        open={formOpen}
        mode={formMode}
        question={formQuestion}
        subjectOptions={subjectOptions}
        initialTab={formTab}
        readOnly={formReadOnly}
        onClose={() => { setFormOpen(false); setFormReadOnly(false) }}
        onSaved={() => { loadQuestions(); void loadMeta() }}
      />

      {/* ── 生成进度弹窗（已改为内联显示） ── */}

      {/* ── AI 补标结果弹窗（预览 -> 确认两步式） ── */}
      <Modal
        title={t('tagFillTitle')}
        open={tagFillResult !== null}
        onCancel={() => setTagFillResult(null)}
        footer={
          <Space>
            <Button onClick={() => setTagFillResult(null)}>{t('close')}</Button>
            {tagFillResult?.dry_run && (tagFillResult?.suggested ?? 0) > 0 && (
              <Button type="primary" loading={tagFillLoading} onClick={runTagFillConfirm}>
                {t('tagFillRun')}
              </Button>
            )}
          </Space>
        }
        width={640}
      >
        {tagFillResult && (
          <div>
            <Typography.Paragraph>
              {tagFillResult.dry_run
                ? t('tagFillFound', { scanned: tagFillResult.scanned, suggested: tagFillResult.suggested })
                : t('tagFillWritten', { count: tagFillResult.written ?? 0 })}
            </Typography.Paragraph>
            {(tagFillResult.failed_batches ?? 0) > 0 && (
              <Tag color="orange">{t('tagFillFailed', { count: tagFillResult.failed_batches ?? 0 })}</Tag>
            )}
            {(tagFillResult.items ?? []).length > 0 && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('tagFillEditTip')}</Typography.Text>
                <Table
                  size="small" rowKey="id" pagination={{ pageSize: 8, size: 'small' }}
                  dataSource={tagFillItems}
                  columns={[
                    { title: t('tagFillColId'), dataIndex: 'id', width: 64 },
                    {
                      title: t('tagFillColText'), dataIndex: 'question', ellipsis: true,
                      render: (s: string) => <Tooltip title={s}><span>{s}</span></Tooltip>,
                    },
                    {
                      title: t('tagFillTags'), dataIndex: 'tags', width: 260,
                      render: (tags: string[], row) => (
                        <Select
                          mode="tags"
                          size="small"
                          style={{ width: '100%' }}
                          value={tags}
                          maxCount={3}
                          showSearch
                          options={(tagFillResult.allowed_tags ?? []).map((n) => ({ value: n }))}
                          filterOption={(inp, opt) => String(opt?.value ?? '').toLowerCase().includes(inp.toLowerCase())}
                          onChange={(v) => setTagFillItems((prev) => prev.map((x) => (
                            x.id === row.id ? { ...x, tags: (v as string[]).slice(0, 3) } : x
                          )))}
                        />
                      ),
                    },
                  ]}
                  style={{ marginTop: 4 }}
                />
              </>
            )}
            {tagFillResult.dry_run && (tagFillResult.items?.length ?? 0) >= 100 && (
              <Typography.Text type="secondary">{t('tagFillTruncated')}</Typography.Text>
            )}
          </div>
        )}
      </Modal>

      {/* ── 去重结果弹窗 ── */}
      <Modal
        title={<Space><ClearOutlined />{t('dedupTitle')}</Space>}
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
            <Typography.Title level={4} style={{ color: dedupResult.total_deleted > 0 ? token.colorSuccess : token.colorTextTertiary }}>
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
                      background: TINT.warning.bg, borderRadius: 6,
                      border: `1px solid ${TINT.warning.border}`,
                    }}>
                      <Typography.Text style={{ fontSize: 13 }}>{g.question_text}</Typography.Text>
                      <Tag color="red" style={{ marginLeft: 8 }}>{t('dupTimes', { count: g.count })}</Tag>
                      {/* 只给"重复 N 次"等于让老师盲签：必须说清保留哪条、删哪几条 */}
                      <div style={{ marginTop: 6 }}>
                        <Tag color="green">{t('dedupKeep', { id: g.keep_id })}</Tag>
                        {(g.deleted_ids || []).map((id) => (
                          <Tag key={id} color="red">{t('dedupRemove', { id })}</Tag>
                        ))}
                      </div>
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
