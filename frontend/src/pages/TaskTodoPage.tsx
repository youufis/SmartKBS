/** 学生任务清单：多维筛选 + 多视图 + 首屏降噪 + 内联筛选面板。
 *  降噪三件套：① 数字降权——页头主徽标=「今天要做 N 项」，总量/瓦片/chips 数字改小灰，只有行动指向的数字带色；
 *  ② 分组收起——各状态组首屏只露 3~5 条（live 按开始时间最新在前），推荐看看整组默认收成一行摘要，展开态持久化；
 *  ③ 行级简化——学科/教师/课程合并为一行可点灰字（点=快捷筛选），标签汤→元数据。
 *  简化模式（默认开，可记忆）：只渲染 逾期+3天内截止+课堂进行中，其余收进「还有 N 项不急的」一行。
 *  筛选面板（常驻内联，替代弹层与分类瓦片）：分类/活动类型/截止时间/发起教师/学科课程/资源形态 六节勾选即生效；
 *  面板默认收起为一行引导条（展开状态记忆，展开后默认打开「分类+截止时间」两节基础项）；勾选与筛选结果始终持久。
 *  面板与各节展开态、勾选状态、包含无归属全部 localStorage 记忆；URL 深链模式不回写。
 *  视图：分组清单（轴：状态/类型/教师/课程）| 截止日时间线；密度 舒适/紧凑；45s 轮询与错误态分离沿用。 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Badge, Button, Card, Col, Empty, Input, Progress, Row, Segmented, Select, Space,
  Switch, Tabs, Tag, Tooltip, Typography, Collapse,
} from 'antd'
import {
  AlertOutlined, AppstoreOutlined, BarChartOutlined, BellOutlined, BookOutlined, BulbOutlined,
  CalendarOutlined, CheckCircleOutlined, ClockCircleOutlined, CodeOutlined, ColumnHeightOutlined,
  CustomerServiceOutlined, EditOutlined, ExperimentOutlined, FileAddOutlined, FilterOutlined,
  FireOutlined, FolderOutlined, MessageOutlined, ReloadOutlined, RightOutlined, SearchOutlined,
  TeamOutlined, ThunderboltOutlined, TrophyOutlined, UserOutlined,
} from '@ant-design/icons'
import { getTaskTodo, type DoneRecord, type TaskTodoItem, type TaskTodoResponse } from '../api/taskTodo'
import { deadlineInfo, friendlyTime } from './dashboard/fmt'
import { useChartTheme, withAlpha, type ChartColorToken } from './dashboard/chartTheme'
import { useAutoRefresh } from './dashboard/useAutoRefresh'
import { message } from '../utils/feedback'
import PageHeader from '../components/PageHeader'
import TaskTodoSkeleton from './TaskTodoSkeleton'
import './dashboard/dashboard.css'

const { Text, Paragraph } = Typography

/** 类型 → 分类（与导航菜单一致，无需翻译） */
const TYPE_CATEGORY: Record<string, string> = {
  exam: 'exam', task: 'exam', practice: 'exam', code: 'exam', quest: 'exam', wrong_book: 'exam',
  course_practice: 'curriculum',
  quiz: 'interactive', poll: 'interactive', discussion: 'interactive',
  whiteboard: 'interactive', quick_quiz: 'interactive',
  question_waiting: 'interactive', question_can_answer: 'interactive',
  shared_resource: 'challenge',
  notification: 'service',
}

const FOCUS_TYPES = ['exam', 'task', 'wrong_book', 'practice', 'course_practice', 'code']
const GROUP_ORDER = ['overdue', 'urgent', 'live', 'study', 'suggest'] as const
/** 类型轴/筛选面板的固定陈列顺序（同类相邻） */
const TYPE_ORDER = ['exam', 'task', 'practice', 'code', 'course_practice', 'quiz', 'poll', 'discussion',
  'whiteboard', 'quick_quiz', 'quest', 'wrong_book', 'question_waiting', 'question_can_answer',
  'shared_resource', 'notification'] as const
/** 首屏降噪：各状态组默认露出条数（suggest=0 表示整组收成一行摘要） */
const SEC_CAP: Record<string, number> = { overdue: 3, urgent: 3, live: 3, study: 5, suggest: 0 }
const AXIS_CAP = 5
const DONE_COLLAPSED = 10
/** "无教师/无课程归属"虚拟选项 */
const NO_OWNER = '__none__'

const QUICK_KEYS = ['all', 'overdue', 'todayDue', 'live', 'task', 'exam', 'newResource'] as const
type QuickKey = (typeof QUICK_KEYS)[number]
const DUE_KEYS = ['', 'today', 'd3', 'week', 'overdue', 'noDeadline'] as const
type DueKey = (typeof DUE_KEYS)[number]
type ViewKey = 'group' | 'timeline'
type AxisKey = 'status' | 'type' | 'teacher' | 'course'
type DensityKey = 'comfortable' | 'compact'

const LS = {
  cat: 'smartkb_todo_cat', quick: 'smartkb_todo_quick', sort: 'smartkb_todo_sort',
  types: 'smartkb_todo_types', due: 'smartkb_todo_due', teacher: 'smartkb_todo_teacher',
  course: 'smartkb_todo_course', rkind: 'smartkb_todo_rkind',
  view: 'smartkb_todo_view', axis: 'smartkb_todo_axis', density: 'smartkb_todo_density',
  simple: 'smartkb_todo_simple', incn: 'smartkb_todo_incnobowner',
  panel: 'smartkb_todo_panel', panelSecs: 'smartkb_todo_panel_secs',
  courseOpen: 'smartkb_todo_course_open', teacherMore: 'smartkb_todo_teacher_more',
  secs: 'smartkb_todo_secs',
  uiv: 'smartkb_todo_uiv',
}

const lsGet = (k: string, d: string): string => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 隐私模式忽略 */ } }
const lsArr = (k: string): string[] => {
  try { const v = JSON.parse(lsGet(k, '[]')); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}
const lsObj = (k: string): Record<string, boolean> => {
  try { const v = JSON.parse(lsGet(k, '{}')); return v && typeof v === 'object' ? v as Record<string, boolean> : {} } catch { return {} }
}

interface Boot {
  urlActive: boolean
  cat: string; quick: QuickKey; sort: string; kw: string
  types: string[]; due: DueKey; teacherSel: string[]; courseSel: string[]; rkindSel: string[]
  includeNoOwner: boolean; view: ViewKey; axis: AxisKey; density: DensityKey; simple: boolean; tab: string
}

/** 一次性迁移：v1 把"面板默认折叠"等开合默认值在挂载时就写进了 localStorage，
 *  导致后续改默认值对老用户永不生效。v2 起开合类键只在用户实际操作时写入，
 *  这里清掉被污染的旧值让新默认生效（筛选勾选结果不动）。 */
const UI_DEFAULTS_VERSION = '2'
function migrateUiDefaults() {
  try {
    if (localStorage.getItem(LS.uiv) === UI_DEFAULTS_VERSION) return
    ;[LS.panel, LS.panelSecs, LS.courseOpen, LS.teacherMore, LS.secs, LS.simple].forEach((k) => localStorage.removeItem(k))
    localStorage.setItem(LS.uiv, UI_DEFAULTS_VERSION)
  } catch { /* 隐私模式忽略 */ }
}

/** 挂载时读一次：URL 参数 > localStorage > 默认（URL 模式不回写 localStorage） */
function readBoot(): Boot {
  migrateUiDefaults()
  const sp = new URLSearchParams(window.location.search)
  const urlActive = ['f_quick', 'f_cat', 'f_types', 'f_due', 'f_teacher', 'f_course', 'f_rkind', 'f_kw',
    'view', 'axis', 'sort', 'density', 'inc', 'simple', 'tab'].some((k) => sp.has(k))
  const csv = (v: string | null | undefined): string[] => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : [])
  const pick = (u: string, l: string, d: string) => (sp.has(u) ? String(sp.get(u)) : lsGet(l, d))
  const quickRaw = pick('f_quick', LS.quick, 'all')
  const dueRaw = pick('f_due', LS.due, '')
  const sortRaw = pick('sort', LS.sort, 'deadline')
  const viewRaw = pick('view', LS.view, 'group')
  const axisRaw = pick('axis', LS.axis, 'status')
  const densRaw = pick('density', LS.density, 'comfortable')
  return {
    urlActive,
    cat: pick('f_cat', LS.cat, 'all'),
    quick: (QUICK_KEYS as readonly string[]).includes(quickRaw) ? quickRaw as QuickKey : 'all',
    sort: ['deadline', 'priority', 'type'].includes(sortRaw) ? sortRaw : 'deadline',
    kw: sp.has('f_kw') ? String(sp.get('f_kw')) : '',
    types: sp.has('f_types') ? csv(sp.get('f_types')) : lsArr(LS.types),
    due: (DUE_KEYS as readonly string[]).includes(dueRaw) ? dueRaw as DueKey : '',
    teacherSel: sp.has('f_teacher') ? csv(sp.get('f_teacher')) : lsArr(LS.teacher),
    courseSel: sp.has('f_course') ? csv(sp.get('f_course')) : lsArr(LS.course),
    rkindSel: sp.has('f_rkind') ? csv(sp.get('f_rkind')) : lsArr(LS.rkind),
    includeNoOwner: sp.has('inc') ? sp.get('inc') === '1' : lsGet(LS.incn, '0') === '1',
    view: viewRaw === 'timeline' ? 'timeline' : 'group',
    axis: axisRaw === 'type' || axisRaw === 'teacher' || axisRaw === 'course' ? axisRaw : 'status',
    density: densRaw === 'compact' ? 'compact' : 'comfortable',
    // 简化模式首次默认开（03 方案 Q1）；学生关过就记住关
    simple: sp.has('simple') ? sp.get('simple') === '1' : lsGet(LS.simple, '1') === '1',
    // 页签不持久化：URL ?tab=done 直达已完成，其余情况永远从待办开始
    tab: sp.get('tab') === 'done' ? 'done' : 'todo',
  }
}

/** 时间边界：今天=[0,24) 本地日；本周日到周日 24 点；逾期按当前时刻 */
interface Bounds { todayStart: number; todayEnd: number; tomorrowEnd: number; weekEnd: number }
const makeBounds = (nowMs: number): Bounds => {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  const todayStart = d.getTime()
  const todayEnd = todayStart + 86400000
  const dow = new Date(nowMs).getDay() // 0=周日
  const daysToSun = dow === 0 ? 0 : 7 - dow
  return { todayStart, todayEnd, tomorrowEnd: todayEnd + 86400000, weekEnd: todayStart + (daysToSun + 1) * 86400000 }
}

const parseMs = (s?: string | null): number => {
  if (!s) return 0
  const d = new Date(String(s).trim().replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? 0 : d.getTime()
}
const coursePath = (it: TaskTodoItem): string => (it.course ? `${it.course.subject}/${it.course.name}` : '')
const subjOf = (it: TaskTodoItem): string => it.subject || it.course?.subject || ''

const matchQuick = (k: QuickKey, it: TaskTodoItem, nowMs: number, b: Bounds): boolean => {
  if (k === 'all') return true
  const ms = parseMs(it.deadline)
  switch (k) {
    case 'overdue': return ms > 0 && ms < nowMs
    case 'todayDue': return ms >= nowMs && ms < b.todayEnd
    case 'live': return !!it.live
    case 'task': return it.type === 'task'
    case 'exam': return it.type === 'exam'
    case 'newResource': return it.type === 'shared_resource'
    default: return true
  }
}
const matchDue = (k: DueKey, it: TaskTodoItem, nowMs: number, b: Bounds): boolean => {
  if (!k) return true
  const ms = parseMs(it.deadline)
  switch (k) {
    case 'overdue': return ms > 0 && ms < nowMs
    case 'today': return ms >= nowMs && ms < b.todayEnd
    case 'd3': return ms >= nowMs && ms < nowMs + 3 * 86400000
    case 'week': return ms >= nowMs && ms < b.weekEnd
    case 'noDeadline': return ms === 0
    default: return true
  }
}
const matchTeacher = (list: string[], it: TaskTodoItem): boolean =>
  list.length === 0 || list.includes(it.teacher?.username || NO_OWNER)
const matchCourse = (list: string[], it: TaskTodoItem): boolean => {
  if (list.length === 0) return true
  const path = coursePath(it)
  return list.some((sel) => {
    if (sel === NO_OWNER) return !path
    if (!path) return false
    if (sel.includes('/')) return path === sel
    return it.course ? it.course.subject === sel : subjOf(it) === sel
  })
}
const matchRkind = (list: string[], it: TaskTodoItem): boolean => {
  if (list.length === 0) return true
  if (it.type !== 'shared_resource') return true
  return list.includes(String((it.meta || {}).kind || 'file'))
}
/** 简化模式口径：现在能做(live) + 已逾期 + 3 天内截止 */
const inSimpleScope = (it: TaskTodoItem, nowMs: number): boolean => {
  if (it.live && !it.suggest) return true
  const ms = parseMs(it.deadline)
  return ms > 0 && ms < nowMs + 3 * 86400000
}

/** 状态分组（逾期→紧急(≤3天)→live→学习→推荐） */
function bucketStatus(items: TaskTodoItem[], now: Date): Record<(typeof GROUP_ORDER)[number], TaskTodoItem[]> {
  const g: Record<(typeof GROUP_ORDER)[number], TaskTodoItem[]> = { overdue: [], urgent: [], live: [], study: [], suggest: [] }
  for (const it of items) {
    if (it.suggest) { g.suggest.push(it); continue }
    const dl = deadlineInfo(it.deadline, now)
    if (dl?.level === 'overdue') g.overdue.push(it)
    else if (dl && dl.diffMs <= 3 * 86400000) g.urgent.push(it)
    else if (it.live) g.live.push(it)
    else g.study.push(it)
  }
  return g
}

function cmpOf(sort: string) {
  return (a: TaskTodoItem, b: TaskTodoItem): number => {
    if (sort === 'type') return a.type.localeCompare(b.type) || a.title.localeCompare(b.title)
    const da = parseMs(a.deadline)
    const db = parseMs(b.deadline)
    if (sort === 'deadline' && da !== db) return da === 0 ? 1 : db === 0 ? -1 : da - db
    return (b.priority ?? 0) - (a.priority ?? 0)
  }
}

const TYPE_ICONS: Record<string, { icon: React.ReactNode; color: ChartColorToken }> = {
  exam: { icon: <FileAddOutlined />, color: 'primary' },
  task: { icon: <CheckCircleOutlined />, color: 'gold' },
  practice: { icon: <ExperimentOutlined />, color: 'success' },
  code: { icon: <CodeOutlined />, color: 'purple' },
  course_practice: { icon: <BookOutlined />, color: 'cyan' },
  quiz: { icon: <ThunderboltOutlined />, color: 'danger' },
  poll: { icon: <BarChartOutlined />, color: 'purple' },
  discussion: { icon: <TeamOutlined />, color: 'primary' },
  whiteboard: { icon: <EditOutlined />, color: 'magenta' },
  quick_quiz: { icon: <CustomerServiceOutlined />, color: 'warning' },
  quest: { icon: <FireOutlined />, color: 'danger' },
  wrong_book: { icon: <BookOutlined />, color: 'warning' },
  question_waiting: { icon: <MessageOutlined />, color: 'warning' },
  question_can_answer: { icon: <MessageOutlined />, color: 'success' },
  shared_resource: { icon: <FolderOutlined />, color: 'success' },
  notification: { icon: <BellOutlined />, color: 'magenta' },
}

interface Section {
  id: string
  title: React.ReactNode
  hint?: React.ReactNode
  icon?: React.ReactNode
  colorT?: ChartColorToken | 'tick'
  items: TaskTodoItem[]
  cap: number
  onHeader?: () => void
  headerActive?: boolean
}

const TaskTodoPage: React.FC = () => {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation('dashboard')
  const ct = useChartTheme()

  /** 挂载时读 URL/localStorage 一次 */
  const [boot] = useState<Boot>(readBoot)
  const urlModeRef = useRef(boot.urlActive)

  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<TaskTodoResponse | null>(null)
  const [cat, setCat] = useState(boot.cat)
  const [quick, setQuick] = useState<QuickKey>(boot.quick)
  const [sort, setSort] = useState(boot.sort)
  const [kw, setKw] = useState(boot.kw)
  const [kwInput, setKwInput] = useState(boot.kw)
  const [types, setTypes] = useState<string[]>(boot.types)
  const [due, setDue] = useState<DueKey>(boot.due)
  const [teacherSel, setTeacherSel] = useState<string[]>(boot.teacherSel)
  const [courseSel, setCourseSel] = useState<string[]>(boot.courseSel)
  const [rkindSel, setRkindSel] = useState<string[]>(boot.rkindSel)
  const [includeNoOwner, setIncludeNoOwner] = useState(boot.includeNoOwner)
  const [view, setView] = useState<ViewKey>(boot.view)
  const [axis, setAxis] = useState<AxisKey>(boot.axis)
  const [density, setDensity] = useState<DensityKey>(boot.density)
  /** 简化模式（03）：只看今天要做的；simpleReveal=临时展开长尾（会话级） */
  const [simple, setSimple] = useState(boot.simple)
  const [simpleReveal, setSimpleReveal] = useState(false)
  /** 内联筛选面板（02）：整体开合 + 各节开合 + 学科子级/教师更多 */
  const [panelOpen, setPanelOpen] = useState(() => lsGet(LS.panel, '0') === '1')
  const [panelSecs, setPanelSecs] = useState<Record<string, boolean>>(() => ({
    cat: true, types: false, due: true, teacher: false, course: false, rkind: false, ...lsObj(LS.panelSecs),
  }))
  const [courseOpen, setCourseOpen] = useState<string[]>(() => lsArr(LS.courseOpen))
  const [teacherMore, setTeacherMore] = useState(() => lsGet(LS.teacherMore, '0') === '1')
  /** 列表各分组展开态（持久化；suggest 默认收成一行摘要） */
  const [secs, setSecs] = useState<Record<string, boolean>>(() => lsObj(LS.secs))
  const [tab, setTab] = useState(boot.tab)
  const [doneMore, setDoneMore] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.parse(new Date().toISOString()))
  const quickRef = useRef<HTMLDivElement | null>(null)
  const [quickFade, setQuickFade] = useState(false)
  const hasDataRef = useRef(false)
  const failNotifiedRef = useRef(false)
  const composingRef = useRef(false)

  const tone = (k: ChartColorToken | 'tick'): string => (k === 'tick' ? ct.tick : ct[k])
  const toneTag = (k: ChartColorToken): React.CSSProperties => ({
    color: ct[k],
    background: withAlpha(ct[k], ct.isDark ? 0.16 : 0.10),
    borderColor: withAlpha(ct[k], 0.4),
    marginInlineEnd: 0,
  })

  const fetchSilent = useCallback(async () => {
    try {
      const res = await getTaskTodo()
      setData(res)
      failNotifiedRef.current = false
      setNowMs(Date.now())
    } catch {
      if (hasDataRef.current) {
        if (!failNotifiedRef.current) {
          failNotifiedRef.current = true
          message.warning(t('todo.refreshFailed'))
        }
      } else {
        setData(null)
      }
      setNowMs(Date.now())
    } finally {
      setLoading(false)
    }
  }, [t])

  const fetchManual = useCallback(async () => {
    setLoading(true)
    await fetchSilent()
  }, [fetchSilent])

  useEffect(() => { hasDataRef.current = data !== null }, [data])
  useEffect(() => { fetchSilent() }, [fetchSilent])

  useAutoRefresh(fetchSilent, 45_000)

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  /** 关键词防抖 300ms + IME 组合期不打扰 */
  useEffect(() => {
    if (composingRef.current) return
    const tm = window.setTimeout(() => setKw(kwInput.trim()), 300)
    return () => window.clearTimeout(tm)
  }, [kwInput])

  /** 筛选/视图偏好记忆（URL 深链模式不回写） */
  useEffect(() => {
    if (urlModeRef.current) return
    lsSet(LS.cat, cat); lsSet(LS.quick, quick); lsSet(LS.sort, sort); lsSet(LS.due, due)
    lsSet(LS.view, view); lsSet(LS.axis, axis); lsSet(LS.density, density)
    lsSet(LS.types, JSON.stringify(types)); lsSet(LS.teacher, JSON.stringify(teacherSel))
    lsSet(LS.course, JSON.stringify(courseSel)); lsSet(LS.rkind, JSON.stringify(rkindSel))
    lsSet(LS.simple, simple ? '1' : '0'); lsSet(LS.incn, includeNoOwner ? '1' : '0')
  }, [cat, quick, sort, due, view, axis, density, types, teacherSel, courseSel, rkindSel, simple, includeNoOwner])

  /** 纯 UI 开合状态：只在用户实际操作时写入记忆（挂载不写，避免旧默认值污染） */
  const togglePanel = () => { const nv = !panelOpen; setPanelOpen(nv); lsSet(LS.panel, nv ? '1' : '0') }
  const togglePanelSec = (key: string) => { const nx = { ...panelSecs, [key]: !panelSecs[key] }; setPanelSecs(nx); lsSet(LS.panelSecs, JSON.stringify(nx)) }
  const toggleCourseOpen = (key: string) => { const nx = courseOpen.includes(key) ? courseOpen.filter((x) => x !== key) : [...courseOpen, key]; setCourseOpen(nx); lsSet(LS.courseOpen, JSON.stringify(nx)) }
  const toggleTeacherMore = () => { const nv = !teacherMore; setTeacherMore(nv); lsSet(LS.teacherMore, nv ? '1' : '0') }

  const updateQuickFade = useCallback(() => {
    const el = quickRef.current
    if (!el) return
    setQuickFade(el.scrollWidth - el.clientWidth - el.scrollLeft > 4)
  }, [])

  useEffect(() => {
    updateQuickFade()
    window.addEventListener('resize', updateQuickFade)
    return () => window.removeEventListener('resize', updateQuickFade)
  }, [updateQuickFade, data, quick, tab, view, axis, panelOpen, simple])

  const now = useMemo(() => new Date(nowMs), [nowMs])
  const bounds = useMemo(() => makeBounds(nowMs), [nowMs])

  const CATEGORY_LABELS = useMemo<Record<string, { label: string; color: ChartColorToken | 'tick'; icon: React.ReactNode }>>(() => ({
    exam: { label: t('todo.category.exam'), color: 'primary', icon: <FileAddOutlined /> },
    curriculum: { label: t('todo.category.curriculum'), color: 'cyan', icon: <BookOutlined /> },
    interactive: { label: t('todo.category.interactive'), color: 'danger', icon: <ThunderboltOutlined /> },
    challenge: { label: t('todo.category.challenge'), color: 'success', icon: <FolderOutlined /> },
    service: { label: t('todo.category.service'), color: 'tick', icon: <BellOutlined /> },
  }), [t])

  const GROUP_META = useMemo<Record<string, { title: string; hint: string; icon: React.ReactNode; color: ChartColorToken | 'tick' }>>(() => ({
    overdue: { title: t('todo.group.overdue'), hint: t('todo.groupHint.overdue'), icon: <AlertOutlined />, color: 'danger' },
    urgent: { title: t('todo.group.urgent'), hint: t('todo.groupHint.urgent'), icon: <ClockCircleOutlined />, color: 'warning' },
    live: { title: t('todo.group.live'), hint: t('todo.groupHint.live'), icon: <ThunderboltOutlined />, color: 'cyan' },
    study: { title: t('todo.group.study'), hint: t('todo.groupHint.study'), icon: <FileAddOutlined />, color: 'primary' },
    suggest: { title: t('todo.group.suggest'), hint: t('todo.groupHint.suggest'), icon: <FolderOutlined />, color: 'tick' },
  }), [t])

  const typeLabelOf = useCallback((ty: string) => t(`todo.type.${ty}`, { defaultValue: ty }), [t])
  const typeLabel = (item: TaskTodoItem) => typeLabelOf(item.type)
  const actionLabel = (item: TaskTodoItem) =>
    t(`todo.action.${item.type}`, { defaultValue: item.action_label || t('todo.action.default') })

  const dlLabel = (dl: ReturnType<typeof deadlineInfo>): string => {
    if (!dl) return ''
    if (dl.level === 'overdue') return t('todo.deadline.overdue', { days: dl.overdueDays })
    if (dl.level === 'today') return t('todo.deadline.today', { hours: dl.hoursLeft })
    return t('todo.deadline.remaining', { days: dl.days })
  }

  /** 分类 + 关键词基础口径 */
  const scoped = useMemo(() => {
    const items = data?.items ?? []
    const k = kw.trim().toLowerCase()
    return items.filter((it) => {
      if (cat !== 'all' && TYPE_CATEGORY[it.type] !== cat) return false
      if (!k) return true
      return `${it.title} ${it.description} ${it.subject}`.toLowerCase().includes(k)
    })
  }, [data, cat, kw])

  const chipCounts = useMemo<Record<QuickKey, number>>(() => {
    const out = { all: scoped.length, overdue: 0, todayDue: 0, live: 0, task: 0, exam: 0, newResource: 0 } as Record<QuickKey, number>
    for (const k of QUICK_KEYS) {
      if (k === 'all') continue
      out[k] = scoped.reduce((n, it) => n + (matchQuick(k, it, nowMs, bounds) ? 1 : 0), 0)
    }
    return out
  }, [scoped, nowMs, bounds])

  /** 今天要做 = 已逾期 + 今天截止 + 课堂进行中（页头唯一强调数字） */
  const todayMust = useMemo(() => scoped.reduce(
    (n, it) => n + ((matchQuick('overdue', it, nowMs, bounds) || matchQuick('todayDue', it, nowMs, bounds) || (it.live && !it.suggest)) ? 1 : 0),
    0,
  ), [scoped, nowMs, bounds])

  /** 完整筛选管线 */
  const { filtered, hiddenNoOwner } = useMemo(() => {
    const v: TaskTodoItem[] = []
    let hidden = 0
    for (const it of scoped) {
      if (!matchQuick(quick, it, nowMs, bounds)) continue
      if (types.length && !types.includes(it.type)) continue
      if (!matchDue(due, it, nowMs, bounds)) continue
      if (!matchRkind(rkindSel, it)) continue
      const tOk = matchTeacher(teacherSel, it)
      const cOk = matchCourse(courseSel, it)
      if (tOk && cOk) { v.push(it); continue }
      const bypassT = includeNoOwner && !it.teacher
      const bypassC = includeNoOwner && !coursePath(it)
      if ((tOk || bypassT) && (cOk || bypassC)) { v.push(it); continue }
      if ((!tOk && !it.teacher) || (!cOk && !coursePath(it))) hidden += 1
    }
    return { filtered: v, hiddenNoOwner: hidden }
  }, [scoped, quick, types, due, rkindSel, teacherSel, courseSel, includeNoOwner, nowMs, bounds])

  /** 简化模式：只渲染今天要做的，长尾收成一行（展开后不影响筛选集合） */
  const { visibleSet, restCount } = useMemo(() => {
    if (!simple || simpleReveal) return { visibleSet: filtered, restCount: 0 }
    const v = filtered.filter((it) => inSimpleScope(it, nowMs))
    return { visibleSet: v, restCount: filtered.length - v.length }
  }, [filtered, simple, simpleReveal, nowMs])

  const catCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of data?.items ?? []) {
      const c = TYPE_CATEGORY[it.type]
      if (c) m[c] = (m[c] || 0) + 1
    }
    return m
  }, [data])

  /** 旧口径分组（顶栏/聚焦用，不受视图与简化影响） */
  const groups = useMemo(() => {
    const g = bucketStatus(scoped, now)
    const arr = cmpOf(sort)
    Object.values(g).forEach((a) => a.sort(arr))
    return g
  }, [scoped, now, sort])

  const todoCount = groups.overdue.length + groups.urgent.length + groups.live.length + groups.study.length
  const suggestCount = groups.suggest.length

  const focus = useMemo(() => {
    const pool = [...groups.overdue, ...groups.urgent, ...groups.study, ...groups.live]
      .filter((it) => FOCUS_TYPES.includes(it.type))
    pool.sort((a, b) => {
      const da = parseMs(a.deadline) || Number.MAX_SAFE_INTEGER
      const db = parseMs(b.deadline) || Number.MAX_SAFE_INTEGER
      return da - db || (b.priority ?? 0) - (a.priority ?? 0)
    })
    return pool.slice(0, 4)
  }, [groups])

  const quickOptions = useMemo(() => {
    const opts: { value: string; label: React.ReactNode }[] = [{ value: 'all', label: t('todo.quick.all') }]
    for (const k of ['overdue', 'todayDue', 'live', 'task', 'exam', 'newResource'] as QuickKey[]) {
      if (!chipCounts[k]) continue
      const hot = k === 'overdue' || k === 'todayDue'
      opts.push({
        value: k,
        label: (
          <span>
            {t(`todo.quick.${k}`)}
            <span style={{ color: hot ? ct.warning : ct.tick, marginInlineStart: 3 }}>({chipCounts[k]})</span>
          </span>
        ),
      })
      if (opts.length >= 6) break
    }
    if (quick !== 'all' && !opts.some((o) => o.value === quick)) {
      opts.push({ value: quick, label: `${t(`todo.quick.${quick}`)} (${chipCounts[quick]})` })
    }
    return opts
  }, [chipCounts, quick, t, ct])

  /** 分组轴分区（数据源=visibleSet；live 组按开始时间最新在前） */
  const sections = useMemo<Section[]>(() => {
    const arr = cmpOf(sort)
    if (axis === 'status') {
      const g = bucketStatus(visibleSet, now)
      g.live.sort((a, b) => (parseMs(b.start_at || '') - parseMs(a.start_at || '')) || arr(a, b))
      return GROUP_ORDER.filter((k) => g[k].length > 0).map((k) => ({
        id: k, title: GROUP_META[k].title, hint: GROUP_META[k].hint, icon: GROUP_META[k].icon,
        colorT: GROUP_META[k].color, items: g[k], cap: SEC_CAP[k] ?? 0,
      }))
    }
    if (axis === 'type') {
      return TYPE_ORDER
        .map((ty) => ({ ty, items: visibleSet.filter((it) => it.type === ty) }))
        .filter((x) => x.items.length > 0)
        .map(({ ty, items }) => ({
          id: `ty-${ty}`, title: typeLabelOf(ty), icon: TYPE_ICONS[ty]?.icon,
          colorT: (TYPE_ICONS[ty]?.color ?? 'primary') as ChartColorToken,
          items: items.slice().sort(arr), cap: AXIS_CAP,
          onHeader: () => setTypes((cur) => (cur.length === 1 && cur[0] === ty ? [] : [ty])),
          headerActive: types.length === 1 && types[0] === ty,
        }))
    }
    if (axis === 'teacher') {
      const m = new Map<string, { name: string; items: TaskTodoItem[] }>()
      for (const it of visibleSet) {
        const key = it.teacher?.username || NO_OWNER
        const cur = m.get(key) || { name: it.teacher?.name || '', items: [] }
        cur.items.push(it)
        m.set(key, cur)
      }
      return Array.from(m.entries())
        .sort((a, b) => (a[0] === NO_OWNER ? 1 : b[0] === NO_OWNER ? -1 : b[1].items.length - a[1].items.length || a[1].name.localeCompare(b[1].name)))
        .map(([key, v]) => ({
          id: `te-${key}`, title: key === NO_OWNER ? t('todo.noTeacher') : v.name,
          icon: <UserOutlined />, colorT: 'primary' as ChartColorToken,
          items: v.items.slice().sort(arr), cap: AXIS_CAP,
          onHeader: () => setTeacherSel((cur) => (cur.length === 1 && cur[0] === key ? [] : [key])),
          headerActive: teacherSel.length === 1 && teacherSel[0] === key,
        }))
    }
    const m = new Map<string, { label: string; hint?: string; items: TaskTodoItem[] }>()
    for (const it of visibleSet) {
      const key = coursePath(it) || NO_OWNER
      const cur = m.get(key) || { label: it.course ? `《${it.course.name}》` : '', hint: it.course?.subject, items: [] }
      cur.items.push(it)
      m.set(key, cur)
    }
    return Array.from(m.entries())
      .sort((a, b) => (a[0] === NO_OWNER ? 1 : b[0] === NO_OWNER ? -1 : b[1].items.length - a[1].items.length || a[1].label.localeCompare(b[1].label)))
      .map(([key, v]) => ({
        id: `co-${key}`, title: key === NO_OWNER ? t('todo.course.none') : v.label, hint: v.hint,
        icon: <BookOutlined />, colorT: 'cyan' as ChartColorToken,
        items: v.items.slice().sort(arr), cap: AXIS_CAP,
        onHeader: () => setCourseSel((cur) => (cur.length === 1 && cur[0] === key ? [] : [key])),
        headerActive: courseSel.length === 1 && courseSel[0] === key,
      }))
  }, [visibleSet, axis, sort, now, types, teacherSel, courseSel, GROUP_META, typeLabelOf, t])

  /** 截止日时间线分桶（同样吃简化模式） */
  const TL_KEYS = ['overdue', 'today', 'tomorrow', 'week', 'later', 'none'] as const
  const TL_META: Record<string, { icon: React.ReactNode; color: ChartColorToken | 'tick' }> = {
    overdue: { icon: <AlertOutlined />, color: 'danger' },
    today: { icon: <ClockCircleOutlined />, color: 'warning' },
    tomorrow: { icon: <CalendarOutlined />, color: 'gold' },
    week: { icon: <CalendarOutlined />, color: 'primary' },
    later: { icon: <CalendarOutlined />, color: 'cyan' },
    none: { icon: <FolderOutlined />, color: 'tick' },
  }
  const tlBuckets = useMemo(() => {
    const b: Record<string, TaskTodoItem[]> = { overdue: [], today: [], tomorrow: [], week: [], later: [], none: [] }
    for (const it of visibleSet) {
      const ms = parseMs(it.deadline)
      if (!ms) { (it.live ? b.today : b.none).push(it); continue }
      if (ms < bounds.todayStart) b.overdue.push(it)
      else if (ms < bounds.todayEnd) b.today.push(it)
      else if (ms < bounds.tomorrowEnd) b.tomorrow.push(it)
      else if (ms < bounds.weekEnd) b.week.push(it)
      else b.later.push(it)
    }
    const arr = cmpOf(sort)
    Object.values(b).forEach((a) => a.sort(arr))
    return b
  }, [visibleSet, bounds, sort])

  /* ─────────── 内联筛选面板：选项计数（facets 未就绪时对应节显示"暂未启用"） ─────────── */
  const hasFacets = !!data?.facets
  const typeCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of data?.items ?? []) m[it.type] = (m[it.type] || 0) + 1
    return m
  }, [data])
  const teacherCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of data?.items ?? []) {
      const k = it.teacher?.username || NO_OWNER
      m[k] = (m[k] || 0) + 1
    }
    return m
  }, [data])
  const subjCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of data?.items ?? []) {
      const s = subjOf(it)
      if (s) m[s] = (m[s] || 0) + 1
    }
    return m
  }, [data])
  const courseCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of data?.items ?? []) {
      const p = coursePath(it)
      if (p) m[p] = (m[p] || 0) + 1
    }
    return m
  }, [data])
  const kindCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of data?.items ?? []) {
      if (it.type !== 'shared_resource') continue
      const k = String((it.meta || {}).kind || 'file')
      m[k] = (m[k] || 0) + 1
    }
    return m
  }, [data])

  /** 学科→课程树：facets 为骨架，条目计数为血肉；学科顺序按条目数降序 */
  const courseTree = useMemo(() => {
    const tree = new Map<string, Map<string, number>>()
    const ensure = (s: string) => { if (!tree.has(s)) tree.set(s, new Map()); return tree.get(s)! }
    for (const c of data?.facets?.courses ?? []) ensure(c.subject || t('todo.course.noSubject')).set(c.name, 0)
    for (const [p, n] of Object.entries(courseCounts)) {
      const [s, name] = p.split('/')
      if (!s) continue
      const cs = ensure(s)
      cs.set(name || '', (cs.get(name || '') || 0) + n)
    }
    for (const s of Object.keys(subjCounts)) ensure(s)
    return Array.from(tree.entries())
      .map(([s, cs]) => ({ s, n: subjCounts[s] || 0, courses: Array.from(cs.entries()).filter(([, cn]) => cn > 0).sort((a, b) => b[1] - a[1]) }))
      .sort((a, b) => b.n - a.n || a.s.localeCompare(b.s))
  }, [data, courseCounts, subjCounts, t])

  const dimsActive = (types.length ? 1 : 0) + (due ? 1 : 0) + (teacherSel.length ? 1 : 0)
    + (courseSel.length ? 1 : 0) + (rkindSel.length ? 1 : 0)
  const hasFilter = cat !== 'all' || quick !== 'all' || !!kw.trim() || dimsActive > 0
  const clearDims = () => { setTypes([]); setDue(''); setTeacherSel([]); setCourseSel([]); setRkindSel([]) }
  const clearAllFilters = () => { clearDims(); setCat('all'); setQuick('all'); setKw(''); setKwInput(''); setIncludeNoOwner(false) }

  const toggleType = (ty: string) => setTypes((cur) => (cur.includes(ty) ? cur.filter((x) => x !== ty) : [...cur, ty]))
  const toggleTeacher = (u: string) => setTeacherSel((cur) => (cur.includes(u) ? cur.filter((x) => x !== u) : [...cur, u]))
  const toggleCourse = (p: string) => setCourseSel((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]))
  const toggleRkind = (rk: string) => setRkindSel((cur) => (cur.includes(rk) ? cur.filter((x) => x !== rk) : [...cur, rk]))
  const toggleSec = (key: string) => { const nx = { ...secs, [key]: !secs[key] }; setSecs(nx); lsSet(LS.secs, JSON.stringify(nx)) }

  /** 已选条件条 */
  const conds = useMemo(() => {
    const list: { key: string; label: string; clear: () => void }[] = []
    if (quick !== 'all') list.push({ key: 'quick', label: t(`todo.quick.${quick}`), clear: () => setQuick('all') })
    if (cat !== 'all') list.push({ key: 'cat', label: CATEGORY_LABELS[cat]?.label || cat, clear: () => setCat('all') })
    for (const ty of types) list.push({ key: `ty${ty}`, label: typeLabelOf(ty), clear: () => setTypes((cur) => cur.filter((x) => x !== ty)) })
    if (due) list.push({ key: 'due', label: t(`todo.due.${due}`), clear: () => setDue('') })
    for (const u of teacherSel) {
      const name = u === NO_OWNER ? t('todo.noTeacher') : (data?.facets?.teachers?.find((x) => x.username === u)?.name || u)
      list.push({ key: `te${u}`, label: name, clear: () => setTeacherSel((cur) => cur.filter((x) => x !== u)) })
    }
    for (const cp of courseSel) {
      const label = cp === NO_OWNER ? t('todo.course.none') : (cp.includes('/') ? `《${cp.split('/')[1]}》` : cp)
      list.push({ key: `co${cp}`, label, clear: () => setCourseSel((cur) => cur.filter((x) => x !== cp)) })
    }
    for (const rk of rkindSel) list.push({ key: `rk${rk}`, label: t(`todo.rkind.${rk}`), clear: () => setRkindSel((cur) => cur.filter((x) => x !== rk)) })
    if (kw.trim()) list.push({ key: 'kw', label: `“${kw.trim()}”`, clear: () => { setKw(''); setKwInput('') } })
    return list
  }, [quick, cat, types, due, teacherSel, courseSel, rkindSel, kw, CATEGORY_LABELS, typeLabelOf, data, t])

  /** 面板折叠态摘要（只汇总筛选维度，不含 chips/瓦片/关键词） */
  const dimsBrief = useMemo(() => {
    const parts = conds.filter((c) => !['quick', 'cat', 'kw'].includes(c.key)).map((c) => c.label)
    if (!parts.length) return ''
    return parts.length > 3 ? `${parts.slice(0, 3).join(' · ')} +${parts.length - 3}` : parts.join(' · ')
  }, [conds])

  const dueOptions = useMemo(() => [
    { value: '', label: t('todo.due.none') },
    { value: 'today', label: t('todo.due.today') },
    { value: 'd3', label: t('todo.due.d3') },
    { value: 'week', label: t('todo.due.week') },
    { value: 'overdue', label: t('todo.due.overdue') },
    { value: 'noDeadline', label: t('todo.due.noDeadline') },
  ], [t])

  /** 面板小节：标题+已选徽标+重置+折叠（折叠态记忆） */
  const panelSec = (id: string, title: string, selected: number, body: React.ReactNode, note?: string) => (
    <div className="todo-panel-sec">
      <div className="todo-panel-sec-head" role="button" tabIndex={0}
        onClick={() => togglePanelSec(id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanelSec(id) } }}>
        <Text strong style={{ fontSize: 12.5 }}>{title}</Text>
        <span style={{ color: ct.tick, fontSize: 10, marginInlineStart: 4 }}>{panelSecs[id] ? '▾' : '▸'}</span>
        {selected > 0 && <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', marginInlineStart: 6, marginInlineEnd: 0 }}>{selected}</Tag>}
        {note && <Text type="secondary" style={{ fontSize: 11, marginInlineStart: 8 }}>{note}</Text>}
        {selected > 0 && (
          <Button type="link" size="small" style={{ padding: 0, marginInlineStart: 'auto' }}
            onClick={(e) => {
              e.stopPropagation()
              if (id === 'cat') setCat('all')
              else if (id === 'types') setTypes([])
              else if (id === 'due') setDue('')
              else if (id === 'teacher') setTeacherSel([])
              else if (id === 'course') setCourseSel([])
              else if (id === 'rkind') setRkindSel([])
            }}>
            {t('todo.secReset')}
          </Button>
        )}
      </div>
      {panelSecs[id] && <div className="todo-panel-sec-body">{body}</div>}
    </div>
  )

  const panelBody = (
    <>
      {panelSec('cat', t('todo.catTitle'), cat !== 'all' ? 1 : 0, (
        <div className="todo-pill-row">
          <Tag.CheckableTag checked={cat === 'all'} onChange={() => setCat('all')}>{t('todo.filter.all')}</Tag.CheckableTag>
          {Object.entries(CATEGORY_LABELS).map(([ck, cfg]) => {
            const cn = catCounts[ck] || 0
            const checked = cat === ck
            if (!cn && !checked) return <Tag key={ck} style={{ fontSize: 11, marginInlineEnd: 0, opacity: 0.45 }}>{cfg.label}</Tag>
            return (
              <Tag.CheckableTag key={ck} checked={checked} onChange={() => setCat(checked ? 'all' : ck)}>
                {cfg.label} {cn}
              </Tag.CheckableTag>
            )
          })}
        </div>
      ))}
      {panelSec('types', t('todo.typesTitle'), types.length, (
        <>
          {Object.entries(CATEGORY_LABELS).map(([ck, cfg]) => {
            const ts = TYPE_ORDER.filter((ty) => TYPE_CATEGORY[ty] === ck)
            if (!ts.length) return null
            return (
              <div key={ck} className="todo-pill-row">
                <Text type="secondary" style={{ fontSize: 11, width: 62, flexShrink: 0 }}>{cfg.label}</Text>
                {ts.map((ty) => {
                  const n = typeCounts[ty] || 0
                  const checked = types.includes(ty)
                  if (!n && !checked) {
                    return <Tag key={ty} style={{ fontSize: 11, marginInlineEnd: 0, opacity: 0.45 }}>{typeLabelOf(ty)}</Tag>
                  }
                  return (
                    <Tag.CheckableTag key={ty} checked={checked} onChange={() => toggleType(ty)}>
                      {typeLabelOf(ty)}{n ? ` ${n}` : ''}
                    </Tag.CheckableTag>
                  )
                })}
              </div>
            )
          })}
        </>
      ))}
      {panelSec('due', t('todo.dueTitle'), due ? 1 : 0, (
        <div className="todo-pill-row">
          {dueOptions.map((o) => (
            <Tag.CheckableTag key={o.value || 'none'} checked={due === o.value}
              onChange={() => setDue(o.value === due ? '' : o.value as DueKey)}>
              {o.label}
            </Tag.CheckableTag>
          ))}
        </div>
      ))}
      {panelSec('teacher', t('todo.teachersTitle'), teacherSel.length, hasFacets ? (
        <div className="todo-pill-row">
          {(() => {
            const list = (data?.facets?.teachers ?? [])
              .map((u) => ({ u, n: teacherCounts[u.username] || 0 }))
              .filter((x) => x.n > 0)
              .sort((a, b) => b.n - a.n)
            const shown = teacherMore ? list : list.slice(0, 8)
            return (
              <>
                {shown.map(({ u, n }) => (
                  <Tag.CheckableTag key={u.username} checked={teacherSel.includes(u.username)} onChange={() => toggleTeacher(u.username)}>
                    <UserOutlined style={{ marginInlineEnd: 3 }} />{u.name} {n}
                  </Tag.CheckableTag>
                ))}
                {list.length > 8 && (
                  <Button type="link" size="small" style={{ padding: 0 }} onClick={toggleTeacherMore}>
                    {teacherMore ? t('todo.lessTeachers') : t('todo.moreTeachers')}
                  </Button>
                )}
                {!!teacherCounts[NO_OWNER] && (
                  <Tag.CheckableTag checked={teacherSel.includes(NO_OWNER)} onChange={() => toggleTeacher(NO_OWNER)}>
                    {t('todo.noTeacher')} {teacherCounts[NO_OWNER]}
                  </Tag.CheckableTag>
                )}
              </>
            )
          })()}
        </div>
      ) : <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.panelNotReady')}</Text>)}
      {panelSec('course', t('todo.coursesTitle'), courseSel.length, hasFacets ? (
        <>
          <div className="todo-pill-row">
            {courseTree.map(({ s, n }) => (
              <span key={s} style={{ display: 'inline-flex', alignItems: 'center' }}>
                <Tag.CheckableTag checked={courseSel.includes(s)} onChange={() => toggleCourse(s)}>
                  {s}{n ? ` ${n}` : ''}
                </Tag.CheckableTag>
                {!!courseTree.find((x) => x.s === s)?.courses.length && (
                  <span className="todo-meta-part" style={{ fontSize: 11, color: ct.tick, margin: '0 6px 0 1px' }}
                    onClick={() => toggleCourseOpen(s)}>
                    {courseOpen.includes(s) ? '▾' : '▸'}
                  </span>
                )}
              </span>
            ))}
            <Tag.CheckableTag checked={courseSel.includes(NO_OWNER)} onChange={() => toggleCourse(NO_OWNER)}>
              {t('todo.course.none')}
            </Tag.CheckableTag>
          </div>
          {courseTree.filter((x) => courseOpen.includes(x.s) && x.courses.length).map((x) => (
            <div key={`c-${x.s}`} className="todo-pill-row" style={{ paddingInlineStart: 12 }}>
              {x.courses.map(([name, n]) => {
                const p = `${x.s}/${name}`
                return (
                  <Tag.CheckableTag key={p} checked={courseSel.includes(p)} onChange={() => toggleCourse(p)}>
                    {`《${name}》`} {n}
                  </Tag.CheckableTag>
                )
              })}
            </div>
          ))}
        </>
      ) : <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.panelNotReady')}</Text>)}
      {panelSec('rkind', t('todo.rkindTitle'), rkindSel.length, hasFacets ? (
        <div className="todo-pill-row">
          {(['html', 'file', 'dir'] as const).map((rk) => {
            const n = kindCounts[rk] || 0
            const checked = rkindSel.includes(rk)
            if (!n && !checked) return <Tag key={rk} style={{ fontSize: 11, marginInlineEnd: 0, opacity: 0.45 }}>{t(`todo.rkind.${rk}`)}</Tag>
            return (
              <Tag.CheckableTag key={rk} checked={checked} onChange={() => toggleRkind(rk)}>
                {t(`todo.rkind.${rk}`)} {n}
              </Tag.CheckableTag>
            )
          })}
          <Text type="secondary" style={{ fontSize: 11, width: '100%' }}>{t('todo.rkindNote')}</Text>
        </div>
      ) : <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.panelNotReady')}</Text>)}
    </>
  )

  const go = (url: string) => {
    if (url.startsWith('/api/')) window.open(url, '_blank', 'noopener')
    else navigate(url)
  }

  const compact = density === 'compact'

  const renderRow = (item: TaskTodoItem, idx: number) => {
    const cfg = TYPE_ICONS[item.type] || { icon: <BellOutlined />, color: 'tick' as ChartColorToken }
    const dl = deadlineInfo(item.deadline, now)
    const dlText = item.deadline ? dlLabel(dl) : item.live ? '' : t('todo.noDeadline')
    const dlColor = !item.deadline ? ct.tick : dl?.level === 'overdue' ? ct.danger : dl?.level === 'today' ? ct.warning : ct.gold
    const soft = !!item.suggest
    const tileColor = soft ? ct.tick : tone(cfg.color)
    const teacher = item.teacher
    const cpath = coursePath(item)
    const hasMeta = !!(item.subject || teacher || item.course)

    return (
      <div
        key={`${item.id}-${idx}`}
        className="todo-row dash-row"
        role="button"
        tabIndex={0}
        aria-label={item.title}
        onClick={() => go(item.url)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(item.url) } }}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: compact ? '5px 0' : '9px 0', cursor: 'pointer',
          borderBottom: `1px solid ${ct.grid}`,
        }}
      >
        <div style={{
          width: compact ? 30 : 36, height: compact ? 30 : 36, borderRadius: 10, flexShrink: 0,
          background: withAlpha(tileColor, ct.isDark ? 0.14 : 0.08),
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: compact ? 14 : 16, color: tileColor,
        }}>
          {cfg.icon}
        </div>
        <div className="todo-main" style={{ flex: 1, minWidth: 0 }}>
          <Space size={6} wrap style={{ marginBottom: 2 }}>
            <Text strong style={{ fontSize: 14 }}>{item.title}</Text>
            <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0, color: tileColor, borderColor: withAlpha(tileColor, 0.45), background: 'transparent' }}>
              {typeLabel(item)}
            </Tag>
            {item.live && (
              <span className="todo-live" style={{ color: ct.cyan }}>
                <i className="todo-live-dot" aria-hidden />{t('todo.liveBadge')}
              </span>
            )}
            {dlText && (
              <Text style={{ fontSize: 12, color: dlColor }}>
                <CalendarOutlined style={{ marginRight: 3 }} />{dlText}
              </Text>
            )}
          </Space>
          {/* 元数据一行：学科 · 👤教师 · 《课程》，后两段可点=快捷筛选（标签汤→一行灰字） */}
          {hasMeta && (
            <div style={{ fontSize: 11.5, color: ct.tick, lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.subject && <span>{item.subject}</span>}
              {item.subject && (teacher || item.course) && <span> · </span>}
              {teacher && (
                <span className="todo-meta-part" title={t('todo.teacherFilterHint')}
                  onClick={(e) => { e.stopPropagation(); setTeacherSel((cur) => (cur.length === 1 && cur[0] === teacher.username ? [] : [teacher.username])) }}>
                  <UserOutlined style={{ marginInlineEnd: 2 }} />{teacher.name}
                </span>
              )}
              {teacher && item.course && <span> · </span>}
              {item.course && (
                <span className="todo-meta-part" style={{ color: ct.cyan }}
                  title={item.course.subject ? `${item.course.subject} · ${item.course.name}` : item.course.name}
                  onClick={(e) => { e.stopPropagation(); setCourseSel((cur) => (cur.length === 1 && cur[0] === cpath ? [] : [cpath])) }}>
                  {`《${item.course.name}》`}
                </span>
              )}
            </div>
          )}
          <Paragraph type="secondary" ellipsis={{ rows: compact ? 1 : 2, tooltip: item.description }} style={{ fontSize: 12, margin: 0 }}>
            {item.description}
          </Paragraph>
        </div>
        <Button
          className="todo-action" size="small" type={soft ? 'default' : 'primary'} ghost={!soft}
          icon={<RightOutlined />} style={{ flexShrink: 0 }}
          onClick={(e) => { e.stopPropagation(); go(item.url) }}
        >
          {actionLabel(item)}
        </Button>
      </div>
    )
  }

  /** 推荐看看：默认整组收成一行摘要（03-Q5），展开态记忆 */
  const renderSuggestSummary = (sec: Section) => (
    <Card
      size="small"
      style={{ marginBottom: 12, borderRadius: 8, background: withAlpha(ct.tick, ct.isDark ? 0.08 : 0.05) }}
      styles={{ body: { padding: '8px 14px' } }}
    >
      <Space size={8} wrap>
        <FolderOutlined style={{ color: ct.tick }} />
        <Text type="secondary" style={{ fontSize: 12.5 }}>{t('todo.suggestSummary', { count: sec.items.length })}</Text>
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => toggleSec(sec.id)}>
          {t('todo.expand', { count: sec.items.length })}
        </Button>
      </Space>
    </Card>
  )

  const renderSection = (sec: Section) => {
    if (sec.cap === 0 && !secs[sec.id]) return renderSuggestSummary(sec)
    const isOpen = !!secs[sec.id]
    const shown = isOpen || sec.items.length <= sec.cap ? sec.items : sec.items.slice(0, sec.cap)
    return (
      <Card
        key={sec.id}
        size="small"
        style={{ marginBottom: 16, borderRadius: 8 }}
        title={
          <Space size={8}>
            {sec.colorT && <span style={{ color: tone(sec.colorT) }}>{sec.icon}</span>}
            {sec.onHeader ? (
              <Tooltip title={t('todo.onlyThis')}>
                <Text strong className="todo-sec-title" role="button" tabIndex={0}
                  onClick={sec.onHeader}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sec.onHeader?.() } }}>
                  {sec.title}
                </Text>
              </Tooltip>
            ) : (
              <Text strong>{sec.title}</Text>
            )}
            <Tag style={{ fontSize: 11, borderRadius: 8, marginInlineEnd: 0 }}>{sec.items.length}</Tag>
            {sec.hint && <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>{sec.hint}</Text>}
          </Space>
        }
        styles={{ body: { padding: '0 16px 8px' } }}
      >
        {shown.map((it, i) => renderRow(it, i))}
        {sec.items.length > sec.cap && (
          <div style={{ textAlign: 'center', paddingTop: 8 }}>
            <Button type="link" size="small" onClick={() => toggleSec(sec.id)}>
              {isOpen ? t('todo.collapse') : t('todo.expand', { count: sec.items.length })}
            </Button>
          </div>
        )}
      </Card>
    )
  }

  const renderDone = () => {
    const rows: DoneRecord[] = data?.recent_done ?? []
    if (!rows.length) {
      return (
        <Card style={{ borderRadius: 8 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="secondary">{t('todo.done.empty')}</Text>} />
        </Card>
      )
    }
    const shown = doneMore ? rows : rows.slice(0, DONE_COLLAPSED)
    return (
      <Card
        size="small"
        style={{ borderRadius: 8 }}
        title={<Text strong>{t('todo.done.title', { count: rows.length })}</Text>}
        styles={{ body: { padding: '0 16px 8px' } }}
      >
        {shown.map((r) => {
          const cfg = TYPE_ICONS[r.type] || { icon: <CheckCircleOutlined />, color: 'success' as ChartColorToken }
          const color = tone(cfg.color)
          const scoreText = r.score == null
            ? ''
            : r.total
              ? t('todo.done.score', { score: fmtNum(r.score), total: fmtNum(r.total) })
              : t('todo.done.scoreOnly', { score: fmtNum(r.score) })
          const rate = r.score != null && r.total ? (Number(r.score) / Number(r.total)) * 100 : null
          const scoreToken: ChartColorToken = rate == null ? 'success' : rate >= 60 ? 'success' : rate >= 40 ? 'warning' : 'danger'
          return (
            <div
              key={r.id}
              className="dash-row"
              role="button"
              tabIndex={0}
              aria-label={r.title}
              onClick={() => go(r.url)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(r.url) } }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', cursor: 'pointer',
                borderBottom: `1px solid ${ct.grid}`,
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                background: withAlpha(color, ct.isDark ? 0.14 : 0.08),
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, color,
              }}>
                {cfg.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Space size={6} wrap>
                  <Text style={{ fontSize: 13.5 }}>{r.title}</Text>
                  {r.detail && <Text type="secondary" style={{ fontSize: 11 }}>{r.detail}</Text>}
                </Space>
                <div><Text type="secondary" style={{ fontSize: 11 }}>{friendlyTime(r.time, i18n.language)}</Text></div>
              </div>
              {scoreText && <Tag style={{ fontSize: 11, ...toneTag(scoreToken) }}>{scoreText}</Tag>}
            </div>
          )
        })}
        {rows.length > DONE_COLLAPSED && (
          <div style={{ textAlign: 'center', paddingTop: 8 }}>
            <Button type="link" size="small" onClick={() => setDoneMore((v) => !v)}>
              {doneMore ? t('todo.collapse') : t('todo.expand', { count: rows.length })}
            </Button>
          </div>
        )}
      </Card>
    )
  }

  if (loading && !data) return <TaskTodoSkeleton />
  if (!data) {
    return (
      <Card style={{ borderRadius: 8 }}>
        <Empty description={<Text type="secondary">{t('todo.loadFailed')}</Text>}>
          <Button type="primary" onClick={fetchManual}>{t('retry')}</Button>
        </Empty>
      </Card>
    )
  }

  const totalCount = data.items.length

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* ─── 页头：主数字只留「今天要做」，总量退成小灰字（03 数字降权） ─── */}
      <PageHeader
        icon={<CheckCircleOutlined />}
        title={
          <Space size={8} wrap>
            <span>{t('todo.title')}</span>
            {todayMust > 0 && (
              <Tag style={{ fontSize: 13, padding: '0 12px', borderRadius: 8, ...toneTag('warning') }}>
                {t('todo.todayMust', { count: todayMust })}
              </Tag>
            )}
            <Tooltip title={t('todo.totalTip', { todo: todoCount, suggest: suggestCount })}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('todo.totalBrief', { count: todoCount + suggestCount })}
              </Text>
            </Tooltip>
          </Space>
        }
        subtitle={t('todo.subtitle')}
        extra={
          <Space size={8} wrap>
            <Input
              allowClear
              size="small"
              style={{ width: 170 }}
              prefix={<SearchOutlined style={{ color: ct.tick }} />}
              placeholder={t('todo.searchPh')}
              value={kwInput}
              onChange={(e) => setKwInput(e.target.value)}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={(e) => { composingRef.current = false; setKwInput((e.target as HTMLInputElement).value) }}
            />
            <Segmented
              size="small"
              value={view}
              onChange={(v) => setView(v as ViewKey)}
              options={[
                { value: 'group', label: <Tooltip title={t('todo.view.group')}><AppstoreOutlined /></Tooltip> },
                { value: 'timeline', label: <Tooltip title={t('todo.view.timeline')}><ClockCircleOutlined /></Tooltip> },
              ]}
            />
            {view === 'group' && (
              <Select
                size="small"
                style={{ width: 104 }}
                value={axis}
                onChange={(v) => setAxis(v as AxisKey)}
                options={[
                  { value: 'status', label: t('todo.axis.status') },
                  { value: 'type', label: t('todo.axis.type') },
                  { value: 'teacher', label: t('todo.axis.teacher') },
                  { value: 'course', label: t('todo.axis.course') },
                ]}
              />
            )}
            <Select
              size="small"
              style={{ width: 112 }}
              value={sort}
              onChange={setSort}
              options={[
                { value: 'deadline', label: t('todo.sort.deadline') },
                { value: 'priority', label: t('todo.sort.priority') },
                { value: 'type', label: t('todo.sort.type') },
              ]}
            />
            <Tooltip title={compact ? t('todo.densityComfort') : t('todo.densityCompact')}>
              <Button
                size="small"
                icon={<ColumnHeightOutlined />}
                type={compact ? 'primary' : 'default'}
                ghost={compact}
                onClick={() => setDensity(compact ? 'comfortable' : 'compact')}
              />
            </Tooltip>
            <Tooltip title={simple ? t('todo.simpleOff') : t('todo.simpleOn')}>
              <Button
                size="small"
                icon={<BulbOutlined />}
                type={simple ? 'primary' : 'default'}
                ghost={simple}
                onClick={() => { setSimple((v) => !v); setSimpleReveal(false) }}
              />
            </Tooltip>
            <Badge count={dimsActive} size="small" offset={[-2, 2]}>
              <Button
                size="small"
                icon={<FilterOutlined />}
                type={panelOpen ? 'primary' : 'default'}
                ghost={panelOpen}
                onClick={togglePanel}
              >
                {panelOpen ? t('todo.panelHide') : t('todo.filterBtn')}
              </Button>
            </Badge>
            <Tooltip title={t('todo.refresh')}>
              <Button icon={<ReloadOutlined />} onClick={fetchManual} size="small" loading={loading} />
            </Tooltip>
          </Space>
        }
      />

      {/* ─── 今日必须完成（常驻；全页唯一强调动作数字） ─── */}
      {focus.length > 0 && (
        <Card
          size="small"
          style={{
            marginBottom: 14, borderRadius: 8,
            border: `1px solid ${withAlpha(ct.warning, ct.isDark ? 0.45 : 0.35)}`,
            background: withAlpha(ct.warning, ct.isDark ? 0.10 : 0.06),
          }}
          styles={{ body: { padding: '10px 14px' } }}
        >
          <Space size={10} wrap>
            <Text strong style={{ fontSize: 13 }}>
              <ThunderboltOutlined style={{ color: ct.warning, marginRight: 6 }} />{t('todo.focus.title')}
            </Text>
            {focus.map((it) => {
              const dl = deadlineInfo(it.deadline, now)
              const toneKey: ChartColorToken = dl?.level === 'overdue' ? 'danger' : dl?.level === 'today' ? 'warning' : 'primary'
              return (
                <Tooltip key={it.id} title={it.title}>
                  <Tag
                    role="button"
                    tabIndex={0}
                    style={{ cursor: 'pointer', padding: '2px 8px', borderRadius: 8, ...toneTag(toneKey) }}
                    onClick={() => go(it.url)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(it.url) } }}
                  >
                    {it.title.length > 14 ? `${it.title.slice(0, 14)}…` : it.title}
                    {it.deadline && (
                      <Text style={{ fontSize: 11, marginInlineStart: 4, color: 'inherit' }}>{dlLabel(dl)}</Text>
                    )}
                  </Tag>
                </Tooltip>
              )
            })}
          </Space>
        </Card>
      )}
      {/* ─── 待办 / 已完成 ─── */}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        size="small"
        items={[
          {
            key: 'todo',
            label: <span><CheckCircleOutlined /> {t('todo.tabs.todo')} ({todoCount})</span>,
            children: (
              <>
                {/* 内联筛选面板：折叠=一行摘要，展开=五节勾选即生效（02） */}
                <div className="todo-panel" style={{ marginBottom: 12 }}>
                  <div className="todo-panel-bar">
                    <Text type="secondary" style={{ fontSize: 12.5 }}>
                      <FilterOutlined style={{ marginInlineEnd: 5 }} />
                      {panelOpen ? t('todo.panelTitle') : t('todo.panelHint')}
                    </Text>
                    {!panelOpen && dimsActive > 0 && (
                      <Text style={{ fontSize: 12, color: ct.primary, marginLeft: 8 }} ellipsis>
                        {t('todo.panelSelected', { brief: dimsBrief })}
                      </Text>
                    )}
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {dimsActive > 0 && (
                        <Button type="link" size="small" style={{ padding: 0 }} onClick={clearDims}>{t('todo.clearDims')}</Button>
                      )}
                      <Button type="link" size="small" style={{ padding: 0 }} onClick={togglePanel}>
                        {panelOpen ? t('todo.panelCollapse') : t('todo.panelExpand')}
                      </Button>
                    </span>
                  </div>
                  {panelOpen && panelBody}
                </div>

                {/* 智能快捷 chips */}
                <div style={{ position: 'relative', marginBottom: 12 }}>
                  <div className="todo-quick-scroll" ref={quickRef} onScroll={updateQuickFade}>
                    <Segmented size="small" value={quick} onChange={(v) => setQuick(v as QuickKey)} options={quickOptions} />
                  </div>
                  {quickFade && <span className="todo-quick-fade" aria-hidden />}
                </div>

                {/* 已选条件条 */}
                {hasFilter && (
                  <div className="todo-cond-bar" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, margin: '-2px 0 12px' }}>
                    {conds.map((cd) => (
                      <Tag key={cd.key} closable style={{ marginInlineEnd: 0, fontSize: 11, borderRadius: 8 }}
                        onClose={(e) => { e.preventDefault(); cd.clear() }}>
                        {cd.label}
                      </Tag>
                    ))}
                    <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.showing', { n: filtered.length, m: scoped.length })}</Text>
                    {(teacherSel.length > 0 || courseSel.length > 0) && !includeNoOwner && hiddenNoOwner > 0 && (
                      <Space size={4}>
                        <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.hiddenNoOwner', { count: hiddenNoOwner })}</Text>
                        <Switch size="small" checked={includeNoOwner} onChange={setIncludeNoOwner} />
                        <Text style={{ fontSize: 12 }}>{t('todo.includeNoOwner')}</Text>
                      </Space>
                    )}
                    <Button type="link" size="small" style={{ padding: 0 }} onClick={clearAllFilters}>
                      {t('todo.clearAll')}
                    </Button>
                  </div>
                )}

                {totalCount === 0 ? (
                  <Card style={{ borderRadius: 8 }}>
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="secondary">{t('todo.empty')}</Text>}>
                      <Space direction="vertical" size={8}>
                        <Button type="primary" size="small" onClick={() => navigate('/curriculum')}>
                          <BookOutlined /> {t('todo.emptyGuide.curriculum')}
                        </Button>
                        <Button size="small" onClick={() => navigate('/discussion')}>
                          <TeamOutlined /> {t('todo.emptyGuide.discussion')}
                        </Button>
                      </Space>
                    </Empty>
                  </Card>
                ) : filtered.length === 0 ? (
                  <Card style={{ borderRadius: 8 }}>
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={
                        <Space direction="vertical" size={4}>
                          <Text type="secondary">{t('todo.filterEmpty')}</Text>
                          <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.filterHidden', { count: scoped.length })}</Text>
                        </Space>
                      }
                    >
                      <Button type="primary" size="small" onClick={clearAllFilters}>{t('todo.clearAll')}</Button>
                    </Empty>
                  </Card>
                ) : (
                  <>
                    {visibleSet.length === 0 ? (
                      /* 简化模式今天没急事：正向反馈，不露长尾 */
                      <Card style={{ borderRadius: 8, marginBottom: 8 }}>
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="secondary">{t('todo.focus.empty')}</Text>} />
                      </Card>
                    ) : view === 'timeline' ? (
                      TL_KEYS.filter((k) => tlBuckets[k].length > 0).map((k) => renderSection({
                        id: `tl-${k}`, title: t(`todo.bucket.${k}`), icon: TL_META[k].icon,
                        colorT: TL_META[k].color, items: tlBuckets[k], cap: AXIS_CAP,
                      }))
                    ) : (
                      sections.map(renderSection)
                    )}
                    {simple && !simpleReveal && restCount > 0 && (
                      <Card
                        size="small"
                        style={{ borderRadius: 8, background: withAlpha(ct.tick, ct.isDark ? 0.08 : 0.05) }}
                        styles={{ body: { padding: '8px 14px' } }}
                      >
                        <Space size={8} wrap>
                          <FolderOutlined style={{ color: ct.tick }} />
                          <Text type="secondary" style={{ fontSize: 12.5 }}>{t('todo.simpleRest', { count: restCount })}</Text>
                          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setSimpleReveal(true)}>
                            {t('todo.simpleReveal')}
                          </Button>
                        </Space>
                      </Card>
                    )}
                  </>
                )}
              </>
            ),
          },
          {
            key: 'done',
            label: <span><TrophyOutlined /> {t('todo.tabs.done')} ({data?.recent_done?.length ?? 0})</span>,
            children: renderDone(),
          },
        ]}
      />

      {/* ─── 学习进度概览（可折叠，默认收起） ─── */}
      {data.stats && (
        <Collapse
          ghost
          size="small"
          style={{ marginTop: 8, borderRadius: 8, background: 'var(--bg-container)' }}
          items={[
            {
              key: 'stats',
              label: (
                <Space>
                  <TrophyOutlined style={{ color: ct.gold }} />
                  <Text strong>{t('todo.stats.title')}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('todo.stats.brief', {
                      completion: data.stats.completion_rate || 0,
                      streak: data.stats.streak_days || 0,
                    })}
                  </Text>
                </Space>
              ),
              children: (
                <Row gutter={[16, 16]}>
                  <Col xs={12} sm={6}>
                    <div style={{ textAlign: 'center' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.courseProgress')}</Text>
                      <Progress type="dashboard" percent={data.stats.course_progress || 0} size={80} strokeColor={ct.primary} />
                    </div>
                  </Col>
                  <Col xs={12} sm={6}>
                    <div style={{ textAlign: 'center' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.completionRate')}</Text>
                      <Progress type="dashboard" percent={data.stats.completion_rate || 0} size={80} strokeColor={ct.success} />
                    </div>
                  </Col>
                  <Col xs={12} sm={6}>
                    <div style={{ textAlign: 'center' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.accuracyRate')}</Text>
                      <Progress type="dashboard" percent={data.stats.accuracy_rate || 0} size={80} strokeColor={ct.purple} format={(p) => `${p}%`} />
                    </div>
                  </Col>
                  <Col xs={12} sm={6}>
                    <div style={{ textAlign: 'center', paddingTop: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t('todo.stats.streakDays')}</Text>
                      <div style={{ fontSize: 28, fontWeight: 700, color: ct.warning }}>
                        {data.stats.streak_days || 0}
                        <Text style={{ fontSize: 14, color: ct.warning, marginLeft: 4 }}>{t('todo.stats.streakDaysUnit')}</Text>
                      </div>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {data.stats.streak_days > 0 ? t('todo.stats.streakActive') : t('todo.stats.streakInactive')}
                      </Text>
                    </div>
                  </Col>
                </Row>
              ),
            },
          ]}
        />
      )}
    </Card>
  )
}

function fmtNum(v: number | null | undefined): string {
  const n = Number(v ?? 0)
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export default TaskTodoPage
