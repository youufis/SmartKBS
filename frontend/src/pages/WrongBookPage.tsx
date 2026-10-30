import React, { useEffect, useMemo, useState } from 'react'
import { Layout, Card, Button, message, Tag, Space, Typography, Spin, Collapse, Modal, Select, Pagination, Divider, Input, InputNumber, Segmented, Checkbox, Empty, Tooltip } from 'antd'
import { ReloadOutlined, BookOutlined, RobotOutlined, DownloadOutlined, SearchOutlined, CheckCircleFilled, CloseCircleFilled, DownOutlined, UpOutlined, ThunderboltOutlined } from '@ant-design/icons'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { classText } from '../utils/studentLabel'
import { reportLoadError } from '../utils/loadError'
import '../styles/wrongbook.css'

const { Title, Text } = Typography

interface WrongQuestion {
  question_id: string
  question_text: string
  question_type: string
  options: Record<string, string>
  correct_answer: string
  student_answer: string
  /** 题库解析；/list 现在直接返回，旧数据可能为空 */
  explanation?: string
  score: number
  max_score: number
  knowledge_points: string
  /** 错题本行 ID 与掌握状态（手动「已掌握」用） */
  wrong_book_id?: number
  wb_status?: string
  mastered_at?: string
  /** 同一道题累计答错次数 */
  wrong_count?: number
  /** 题目被软删时后端仍返回错题，但题干只剩占位 */
  question_status?: string
  /** SVG 配图 */
  svg_content?: string
  has_svg?: number
  /** 万相/上传的图片 */
  media_files?: any
}

interface ExamWrongGroup {
  exam_id: number
  exam_title: string
  exam_subject: string
  submitted_at: string
  score: number | null
  total_score: number | null
  source?: string
  wrong_count: number
  wrong_questions: WrongQuestion[]
}

interface WrongBookData {
  total_wrong: number
  exams: ExamWrongGroup[]
  student_username?: string
  /** 三个状态的总数，后端一次算好，筛选器上的计数与当前筛选无关 */
  pending_total?: number
  mastered_total?: number
  all_total?: number
}

type FlatQuestion = WrongQuestion & { _src: ExamWrongGroup }
type GroupMode = 'exam' | 'kp' | 'type'
type StatusFilter = 'pending' | 'mastered' | 'all'
interface Group { key: string; title: React.ReactNode; items: FlatQuestion[] }

/** 知识点串（逗号/顿号/分号分隔）拆成数组并去重：题库里有题目标了重复标签，不去重会撞 React key */
const splitKp = (raw: unknown) => Array.from(new Set(String(raw ?? '').split(/[,，、;；]/).map(s => s.trim()).filter(Boolean)))
const fmtDate = (raw: unknown) => (raw ? String(raw).slice(0, 10) : '')
/** 多选答案归一化: 忽略大小写/空格/分隔符, 且顺序无关 */
const normAnswer = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9一-龥]/g, '').split('').sort().join('')
const optionKey = (s: unknown) => String(s ?? '').trim().toUpperCase()
const letterSet = (s: unknown) => new Set(String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '').split('').filter(Boolean))
/** 每组默认只画前 N 张卡：一屏几十道题同时渲染 KaTeX 与配图会明显卡顿 */
const GROUP_PREVIEW = 5

interface QuestionCardProps {
  q: FlatQuestion
  selected: boolean
  busy: boolean
  kpFilter: string
  onSelect: (wbId: number, checked: boolean) => void
  onToggleMaster: (q: WrongQuestion, next: 'mastered' | 'pending') => void
  onPickKp: (kp: string) => void
  /** 教师/管理员才能把 AI 解析写回题库 */
  canAiExplain: boolean
  expBusy: boolean
  onAiExplain: (questionId: string) => void
  t: (key: string, opts?: any) => string
  typeLabel: Record<string, string>
}

/**
 * 错题卡片：一道题的完整叙事（题干 → 作答对照 → 解析 → 知识点/操作）。
 *
 * 取代原来 7 列宽表格里被横切开的同一道题：选项列把行撑到 250px 高、
 * 其余列下方全是空洞，读一题要在 1100px 里横向来回扫。
 * 这里对错同时用「图标 + 文字标记 + 底色」三重编码，不再只靠红绿。
 */
const QuestionCard: React.FC<QuestionCardProps> = ({
  q, selected, busy, kpFilter, onSelect, onToggleMaster, onPickKp,
  canAiExplain, expBusy, onAiExplain, t, typeLabel,
}) => {
  const [showExp, setShowExp] = useState(false)
  const done = q.wb_status === 'mastered'
  const opts = Object.entries(q.options || {})
  const mineKeys = letterSet(q.student_answer)
  const rightKeys = letterSet(q.correct_answer)
  // 判分口径与后端一致：作答与参考答案归一化后相同时，两边都按命中处理
  const sameAnswer = !!optionKey(q.student_answer) && normAnswer(q.student_answer) === normAnswer(q.correct_answer)
  const isMine = (k: string) => mineKeys.has(optionKey(k)) || (sameAnswer && optionKey(k) === optionKey(q.student_answer))
  const isRight = (k: string) => rightKeys.has(optionKey(k)) || (sameAnswer && optionKey(k) === optionKey(q.correct_answer))
  const kps = splitKp(q.knowledge_points)
  const wbId = Number(q.wrong_book_id) || 0
  const gone = q.question_status === 'missing' || String(q.question_text || '').startsWith('(题目ID')
  const hasMedia = q.has_svg === 1 || !!q.svg_content
    || (Array.isArray(q.media_files) ? q.media_files.length > 0 : !!q.media_files && String(q.media_files) !== '[]')

  return (
    <div className={`wb-card${done ? ' is-mastered' : ''}${selected ? ' is-selected' : ''}`}>
      <div className="wb-card-main">
        <div className="wb-card-head">
          {!!wbId && (
            <Checkbox checked={selected} onChange={e => onSelect(wbId, e.target.checked)} />
          )}
          <Tag>{typeLabel[q.question_type] || q.question_type || t('questionType')}</Tag>
          {(q.wrong_count || 1) > 1 && <Tag color="red">{t('wrongTimes', { count: q.wrong_count })}</Tag>}
          {gone && <Tag color="orange">{t('wbQuestionGone')}</Tag>}
          <span className="wb-meta">{q._src.exam_title}{fmtDate(q._src.submitted_at) ? ` · ${fmtDate(q._src.submitted_at)}` : ''}</span>
          <span className="wb-flex" />
          <Tag color={done ? 'green' : 'red'}>{done ? t('statusMastered') : t('notMastered')}</Tag>
        </div>

        <div className="wb-stem-row">
          <div className="wb-stem"><FormulaRenderer content={q.question_text} /></div>
          {hasMedia && (
            <div className="wb-media">
              <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={q.media_files} size="card" />
            </div>
          )}
        </div>

        {opts.length > 0 ? (
          <>
            <div className="wb-answer-line">
              <span>{t('yourChoice')}: <b className={sameAnswer ? 'ok' : 'bad'}>{q.student_answer || t('wbNotAnswered')}</b></span>
              <span>{t('correctAnswerColon')}<b className="ok">{q.correct_answer || t('dash')}</b></span>
              {sameAnswer && <Tag color="gold">{t('wbAnswerSame')}</Tag>}
            </div>
            <div>
              {opts.map(([k, v]) => {
                const mine = isMine(k)
                const right = isRight(k)
                return (
                  <div key={k} className={`wb-opt${right ? ' is-right' : ''}${mine ? ' is-mine' : ''}`}>
                    <span className="wb-opt-mark">
                      {right ? <CheckCircleFilled /> : mine ? <CloseCircleFilled /> : <span className="wb-opt-dot" />}
                    </span>
                    <span className="wb-opt-key">{k}.</span>
                    <span className="wb-opt-text"><FormulaRenderer content={String(v)} inline /></span>
                    {right && <span className="wb-opt-badge right">{t('correctAnswer')}</span>}
                    {mine && <span className="wb-opt-badge mine">{t('yourChoice')}</span>}
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <div className="wb-answer-block is-mine">
              <div className="wb-answer-label">{t('wbMyAnswer')}</div>
              <div className="wb-answer-body">{q.student_answer || t('wbNotAnswered')}</div>
            </div>
            {!!q.correct_answer && (
              <div className="wb-answer-block is-ref">
                <div className="wb-answer-label">{t('referenceAnswer')}</div>
                <div className="wb-answer-body"><FormulaRenderer content={q.correct_answer} inline /></div>
              </div>
            )}
          </>
        )}

        {q.explanation ? (
          <div className="wb-exp">
            <Button type="text" size="small" className="wb-exp-toggle"
              icon={showExp ? <UpOutlined /> : <DownOutlined />}
              onClick={() => setShowExp(v => !v)}>
              {showExp ? t('collapse') : t('explanation')}
            </Button>
            {/* 折叠时整块不挂载，解析里的公式/图片不进 DOM */}
            {showExp && (
              <div className="wb-exp-body markdown-content"><FormulaRenderer content={q.explanation} /></div>
            )}
          </div>
        ) : (
          <div className="wb-exp-empty">
            {t('wbNoExplanation')}
            {canAiExplain && q.question_status !== 'missing' && (
              <Button type="link" size="small" icon={<RobotOutlined />} loading={expBusy}
                onClick={() => onAiExplain(String(q.question_id))}>
                {t('wbAiExplain')}
              </Button>
            )}
          </div>
        )}

        <div className="wb-card-foot">
          {kps.length > 0 ? (
            <>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('knowledgePointColon')}</Text>
              {kps.map(kp => (
                <Tag key={kp} className={`wb-kp-chip${kpFilter === kp ? ' is-active' : ''}`}
                  onClick={() => onPickKp(kpFilter === kp ? '' : kp)}>{kp}</Tag>
              ))}
            </>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>{t('analyticsNoKp')}</Text>
          )}
          <span className="wb-flex" />
          {done && !!q.mastered_at && <span className="wb-meta">{fmtDate(q.mastered_at)}</span>}
          <div className="wb-actions">
            <Button size="small" type={done ? 'default' : 'primary'} loading={busy}
              onClick={() => onToggleMaster(q, done ? 'pending' : 'mastered')}>
              {done ? t('unmarkMastered') : t('wbMarkMastered')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

const WrongBookPage: React.FC = () => {
  const { t } = useTranslation('questions')
  const typeLabel: Record<string, string> = {
    single: t('singleChoice'), multiple: t('multipleChoice'), true_false: t('trueFalse'), short: t('shortAnswer'),
  }
  const user = useAuthStore((s) => s.user)
  const isStudent = user?.role === 'student'
  const navigate = useNavigate()

  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<WrongBookData | null>(null)

  // 分组分页（分组可能是考试，也可能是知识点/题型）
  const [groupPage, setGroupPage] = useState(1)
  const [groupPageSize, setGroupPageSize] = useState(10)

  // 年级/班级/学生三级联动
  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [students, setStudents] = useState<{ username: string; name: string; grade: string; class: string }[]>([])
  const [selectedGrade, setSelectedGrade] = useState<string>('')
  const [selectedClass, setSelectedClass] = useState<string>('')
  const [selectedStudent, setSelectedStudent] = useState<string>('')
  const [selectedStudentName, setSelectedStudentName] = useState<string>('')
  const [wrongStatus, setWrongStatus] = useState<StatusFilter>('pending')

  // 视图控制：分组维度 / 知识点筛选 / 关键词 / 展开态 / 批量勾选
  const [groupMode, setGroupMode] = useState<GroupMode>('exam')
  const [kpFilter, setKpFilter] = useState<string>('')
  const [keyword, setKeyword] = useState<string>('')
  const [openKeys, setOpenKeys] = useState<string[] | null>(null)
  const [wideGroups, setWideGroups] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const [planModal, setPlanModal] = useState(false)
  const [planLoading, setPlanLoading] = useState(false)
  const [planData, setPlanData] = useState<{ plan: string; total_wrong: number; knowledge_points: string[]; weak_types: string[] } | null>(null)

  // ── 生成练习 ──
  const [practiceModal, setPracticeModal] = useState(false)
  const [genLoading, setGenLoading] = useState(false)
  const [generatedQuestions, setGeneratedQuestions] = useState<any[]>([])
  const [genKp, setGenKp] = useState('')
  const [pubTitle, setPubTitle] = useState('')
  const [pubLoading, setPubLoading] = useState(false)
  const [practiceCount, setPracticeCount] = useState(5)
  const [countModal, setCountModal] = useState(false)
  const [selfBusy, setSelfBusy] = useState(false)
  const [expBusy, setExpBusy] = useState(false)
  // 自动错题巩固的策略与该生当前状态（教师端可见）
  const [autoState, setAutoState] = useState<any>(null)
  const [autoBusy, setAutoBusy] = useState(false)

  /** 换学生/换筛选口径时把视图状态清干净：残留的知识点与关键词会让新对象显示成「没有错题」 */
  const resetView = () => {
    setOpenKeys(null); setWideGroups(new Set()); setSelected(new Set())
    setKpFilter(''); setKeyword(''); setGroupPage(1)
  }

  const loadGrades = async () => {
    if (isStudent) return
    try {
      const { data: res } = await apiClient.get('/api/wrong-book/grades')
      setGrades(res.grades || [])
      setSelectedGrade('')
      setSelectedClass('')
      setSelectedStudent('')
      setStudents([])
      setData(null)
    } catch (err) { reportLoadError(err, { key: 'WrongBookPage.loadGrades', retry: () => { void loadGrades() } }) }
  }

  const loadClasses = async (grade: string) => {
    try {
      const { data: res } = await apiClient.get('/api/wrong-book/classes', { params: { grade } })
      setClasses(res.classes || [])
      setSelectedClass('')
      setSelectedStudent('')
      setStudents([])
      setData(null)
    } catch (err) { reportLoadError(err, { key: 'WrongBookPage.loadClasses' }) }
  }

  const loadStudents = async (grade: string, cls: string) => {
    try {
      const params: any = { grade }
      if (cls) params.class_name = cls
      const { data: res } = await apiClient.get('/api/wrong-book/students', { params })
      setStudents(res.students || [])
      setSelectedStudent('')
      setData(null)
    } catch (err) { reportLoadError(err, { key: 'wrongBook.students' }) }
  }

  const handleGradeChange = (grade: string) => {
    setSelectedGrade(grade)
    setSelectedClass('')
    setSelectedStudent('')
    setStudents([])
    setData(null)
    resetView()
    loadClasses(grade)
  }

  const handleClassChange = (cls: string) => {
    setSelectedClass(cls)
    setSelectedStudent('')
    setData(null)
    resetView()
    if (cls) loadStudents(selectedGrade, cls)
  }

  const loadData = async (studentUsername?: string, status?: string) => {
    setLoading(true)
    try {
      // status 可显式传入: 筛选切换时 setState 后闭包里仍是旧值，会永远慢一步
      const params: Record<string, string> = { status: status ?? wrongStatus }
      if (studentUsername) params.student_username = studentUsername
      const { data: res } = await apiClient.get('/api/wrong-book/list', { params })
      setData(res)
      setSelected(new Set())
    } catch {
      message.error(t('loadFailed'))
    }
    setLoading(false)
  }

  const loadAutoStatus = async (student?: string) => {
    if (isStudent || !student) { setAutoState(null); return }
    try {
      const { data } = await apiClient.get('/api/wrong-book/practice/auto-status', {
        params: { student_username: student },
      })
      setAutoState(data)
    } catch { setAutoState(null) }
  }

  /** 教师点名布置一组：后端会跳过阈值与冷却，但沿用未作答的旧会话，不叠两份 */
  const forcePractice = async () => {
    if (!selectedStudent || autoBusy) return
    setAutoBusy(true)
    try {
      const { data: res } = await apiClient.post('/api/wrong-book/practice/auto-trigger', {
        student_username: selectedStudent, force: true,
      })
      message.success(res?.reused ? t('wbForceReused') : t('wbForceOk', { count: res?.question_count || 0 }))
      await loadAutoStatus(selectedStudent)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('wbForceFail'))
    }
    setAutoBusy(false)
  }

  const handleStudentChange = (username: string) => {
    setSelectedStudent(username)
    const student = students.find(s => s.username === username)
    setSelectedStudentName(student?.name || username)
    resetView()
    setAutoState(null)
    if (username) { loadData(username); void loadAutoStatus(username) }
  }

  // 手动切换单条错题的掌握状态（学生自主控制错题本）
  const [masterBusy, setMasterBusy] = useState<number | null>(null)
  const toggleMastered = async (r: WrongQuestion, next: 'mastered' | 'pending') => {
    const wbId = Number(r.wrong_book_id)
    if (!wbId) { message.error(t('markFailed')); return }
    setMasterBusy(wbId)
    try {
      await apiClient.post('/api/wrong-book/master', { wrong_book_id: wbId, status: next })
      message.success(next === 'mastered' ? t('markMasteredOk') : t('markPendingOk'))
      await loadData(isStudent ? undefined : selectedStudent)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('markFailed'))
    }
    setMasterBusy(null)
  }

  // 批量标记（勾选多道一次改）
  const [bulkBusy, setBulkBusy] = useState(false)
  const applyBulk = async (next: 'mastered' | 'pending') => {
    const ids = Array.from(selected)
    if (!ids.length) return
    setBulkBusy(true)
    try {
      await apiClient.post('/api/wrong-book/master', { wrong_book_ids: ids, status: next })
      message.success(t('wbBulkDone', { count: ids.length }))
      await loadData(isStudent ? undefined : selectedStudent)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('wbBulkFail'))
    }
    setBulkBusy(false)
  }

  const handleSelect = (wbId: number, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (checked) next.add(wbId); else next.delete(wbId)
      return next
    })
  }

  // ── 派生视图数据 ──
  const flat = useMemo<FlatQuestion[]>(
    () => (data?.exams || []).flatMap(ex => (ex.wrong_questions || []).map(q => ({ ...q, _src: ex }))),
    [data],
  )

  const kpOptions = useMemo(() => {
    const m = new Map<string, number>()
    flat.forEach(q => splitKp(q.knowledge_points).forEach(kp => m.set(kp, (m.get(kp) || 0) + 1)))
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([kp, c]) => ({ value: kp, label: `${kp} (${c})` }))
  }, [flat])

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    return flat.filter(q => {
      if (kpFilter && !splitKp(q.knowledge_points).includes(kpFilter)) return false
      if (!k) return true
      return [q.question_text, q.knowledge_points, q.correct_answer, q.student_answer,
        ...Object.values(q.options || {})].join(' ').toLowerCase().includes(k)
    })
  }, [flat, kpFilter, keyword])

  /** 当前筛选下仍没有解析的题（题目已下架的不算，AI 也写不回去） */
  const missingExpIds = useMemo(
    () => filtered.filter(q => !(q.explanation || '').trim() && q.question_status !== 'missing')
      .map(q => String(q.question_id)),
    [filtered],
  )

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>()
    filtered.forEach(q => {
      const key = groupMode === 'exam' ? `exam:${q._src.exam_id}`
        : groupMode === 'kp' ? `kp:${splitKp(q.knowledge_points)[0] || '__none__'}`
          : `type:${q.question_type || '__unknown__'}`
      let g = map.get(key)
      if (!g) { g = { key, title: null, items: [] }; map.set(key, g) }
      g.items.push(q)
    })
    const list = Array.from(map.values())
    list.forEach(g => {
      const src = g.items[0]._src
      if (groupMode === 'exam') {
        g.title = (
          <div className="wb-group-title">
            <Text strong>{src.exam_title}</Text>
            {!!src.exam_subject && <Tag>{src.exam_subject}</Tag>}
            <Tag color="red">{t('wrongCountLabel', { count: g.items.length })}</Tag>
            {src.score != null && src.total_score ? (
              <Text type="secondary" style={{ fontSize: 12 }}>{t('scoreLabel', { score: src.score, total: src.total_score })}</Text>
            ) : null}
            <Text type="secondary" style={{ fontSize: 12 }}>{fmtDate(src.submitted_at)}</Text>
          </div>
        )
        return
      }
      const label = groupMode === 'kp'
        ? (splitKp(g.items[0].knowledge_points)[0] || t('analyticsNoKp'))
        : (typeLabel[g.items[0].question_type] || g.items[0].question_type || t('questionType'))
      const examCount = new Set(g.items.map(q => String(q._src.exam_id))).size
      g.title = (
        <div className="wb-group-title">
          <Text strong>{label}</Text>
          <Tag color="red">{t('wrongCountLabel', { count: g.items.length })}</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('wbGroupExams', { count: examCount })}</Text>
        </div>
      )
    })
    // 按考试分组沿用后端的时间倒序；按知识点/题型时题多的组排前面
    return groupMode === 'exam' ? list : list.sort((a, b) => b.items.length - a.items.length)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, groupMode, wrongStatus])

  const pagedGroups = groups.slice((groupPage - 1) * groupPageSize, groupPage * groupPageSize)
  const activeKeys = openKeys ?? (pagedGroups.length ? [pagedGroups[0].key] : [])
  const counts = {
    pending: data?.pending_total ?? data?.total_wrong ?? 0,
    mastered: data?.mastered_total ?? 0,
    all: data?.all_total ?? data?.total_wrong ?? 0,
  }

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(groups.length / groupPageSize))
    if (groupPage > maxPage) setGroupPage(1)
  }, [groups.length, groupPage, groupPageSize])

  /** AI 补解析：单次上限 20 道，任务在后台跑，跑完重新拉列表 */
  const runExplainGen = async (qids: string[]) => {
    const ids = qids.map(Number).filter(Boolean)
    if (!ids.length || expBusy) return
    setExpBusy(true)
    try {
      const { data: res } = await apiClient.post('/api/wrong-book/explanation/generate', {
        question_ids: ids,
        student_username: isStudent ? undefined : (selectedStudent || undefined),
      })
      if (!res?.task_id) {
        message.info(res?.message || t('wbExpAllHave'))
      } else {
        const result = await pollAiTask(String(res.task_id), 300000)
        if (result?.error) message.error(String(result.error))
        else if (result?.saved) message.success(t('wbExpSaved', { saved: result.saved, total: result.total }))
        else message.warning(t('wbExpNone'))
      }
      await loadData(isStudent ? undefined : selectedStudent)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('wbExpFail'))
    }
    setExpBusy(false)
  }

  /** 学生自助：有没做完的一组就直接续做，没有就现抽一组 */
  const selfPractice = async () => {
    if (selfBusy) return
    setSelfBusy(true)
    try {
      const { data: res } = await apiClient.post('/api/wrong-book/practice/self', { count: practiceCount })
      message.success(res?.reused ? t('wbPracticeReused') : t('wbPracticeCreated', { count: res?.question_count || 0 }))
      if (res?.session_id) navigate(`/practice?open=${res.session_id}`)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('wbPracticeFail'))
    }
    setSelfBusy(false)
  }

  const exportWrongBook = () => {
    if (!data) return
    const params = new URLSearchParams({ status: wrongStatus })
    if (!isStudent && selectedStudent) params.set('student_username', selectedStudent)
    window.open(`/api/wrong-book/export?${params.toString()}`, '_blank')
  }

  const generatePracticeFromWrong = async () => {
    if (!data || data.exams.length === 0) { message.warning(t('noWrongData')); return }
    // 收集所有错题的知识点（去重）
    const kpSet = new Set<string>()
    data.exams.forEach(exam => exam.wrong_questions.forEach(q => {
      if (q.knowledge_points) q.knowledge_points.split(/[,，、]/).forEach(kp => { if (kp.trim()) kpSet.add(kp.trim()) })
    }))
    const kps = Array.from(kpSet)
    if (kps.length === 0) { message.warning(t('noKpExtracted')); return }

    // 教师/管理员 → 生成并弹窗预览，可直接布置
    if (!isStudent) {
      // 立即弹窗显示 loading
      setGeneratedQuestions([])
      setGenLoading(true)
      setPracticeModal(true)
      try {
        const { data: gen } = await apiClient.post('/api/wrong-book/practice/generate', {
          count: practiceCount,
          subjects: [],
          knowledge_points: kps.join('，'),
          student_username: selectedStudent,
        }, { timeout: 180000 })
        // 直接返回题目列表（非异步）
        const questions = gen.questions || []
        // 存入 state 供弹窗使用
        const studentName = students.find(s => s.username === selectedStudent)?.name || selectedStudent
        setGeneratedQuestions(questions)
        setGenKp(kps.join('，'))
        setGenLoading(false)
        setPubTitle(t('studentPracticeTitle', { name: studentName }))
      } catch (e: any) {
        message.error(e.response?.data?.detail || t('generateFailed'))
        setGenLoading(false)
        setPracticeModal(false)
      }
    } else {
      // 学生 → 跳转到错题巩固练习（TODO）
      message.info(t('extractingWrong'))
    }
  }

  useEffect(() => {
    if (isStudent) {
      loadData()
      apiClient.get('/api/wrong-book/practice/check-auto').then(() => {}).catch(() => {})
    } else {
      const init = async () => { await loadGrades() }
      init()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStudent])


  const loadReviewPlan = async () => {
    setPlanLoading(true)
    setPlanData(null)
    setPlanModal(true)
    try {
      const params = selectedStudent ? { student_username: selectedStudent } : {}
      const { data: res } = await apiClient.get('/api/wrong-book/review-plan', { params })
      if (res.task_id) {
        const result = await pollAiTask(res.task_id)
        if (result) {
          setPlanData({ plan: result.plan || result.result, total_wrong: res.total_wrong, knowledge_points: res.knowledge_points, weak_types: res.weak_types })
        } else {
          message.error(t('aiAnalyzeTimeout'))
          setPlanModal(false)
        }
      } else {
        setPlanData(res)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('genPlanFailed'))
      setPlanModal(false)
    }
    setPlanLoading(false)
  }

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: 'var(--bg-container)', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        <div className="page-header-flex" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Space wrap>
            <Title level={4} style={{ margin: 0 }}>📕 {t('wrongBook')}</Title>
            {!!data && (
              <Text type="secondary">
                {t('totalQuestions', { count: data.total_wrong })}，{t('fromExams', { count: data.exams.length })}
              </Text>
            )}
          </Space>
          <Space wrap>
            {!isStudent && (
              <>
                <Select
                  style={{ width: 100 }}
                  placeholder={t('selectGrade')}
                  value={selectedGrade || undefined}
                  onChange={handleGradeChange}
                  options={grades.map(g => ({ label: g, value: g }))}
                />
                <Select
                  style={{ width: 100 }}
                  placeholder={t('selectClass')}
                  value={selectedClass || undefined}
                  onChange={handleClassChange}
                  options={classes.map(c => ({ label: classText(c), value: c }))}
                />
                <Select
                  style={{ width: 170 }}
                  placeholder={t('selectStudent')}
                  value={selectedStudent || undefined}
                  onChange={handleStudentChange}
                  showSearch
                  optionFilterProp="label"
                  options={students.map(s => ({ label: `${s.name} (${s.username})`, value: s.username }))}
                />
              </>
            )}
            {!isStudent && (
              <Button icon={<RobotOutlined />} onClick={loadReviewPlan} loading={planLoading}
                disabled={!data || counts.all === 0}>
                {t('aiReviewPlan')}
              </Button>
            )}
            {!isStudent && (
              <Button icon={<RobotOutlined />} onClick={() => setCountModal(true)}
                disabled={!data || counts.all === 0}>
                {t('practiceWrong')}
              </Button>
            )}
            {isStudent && (
              <Button type="primary" icon={<RobotOutlined />} loading={selfBusy}
                onClick={selfPractice} disabled={!data || counts.pending === 0}>
                {t('practiceWrong')}
              </Button>
            )}
            <Button icon={<DownloadOutlined />} onClick={exportWrongBook}
              disabled={!data || counts.all === 0}>
              {t('wbExport')}
            </Button>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => {
              if (isStudent) { void loadData(); return }
              void loadData(selectedStudent)
              void loadAutoStatus(selectedStudent)
            }}>{t('refresh')}</Button>
          </Space>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
        ) : !data || data.exams.length === 0 ? (
          <Card>
            <Space orientation="vertical" style={{ width: '100%', textAlign: 'center', padding: 40 }}>
              <BookOutlined style={{ fontSize: 48, color: 'var(--border-color-secondary)' }} />
              <Text type="secondary">{t('noWrongQuestions')}</Text>
            </Space>
          </Card>
        ) : (
          <div>
            <div className="wb-toolbar">
              <div className="wb-toolbar-group">
                <Segmented value={wrongStatus}
                  onChange={(v: any) => {
                    const s = v as StatusFilter
                    setWrongStatus(s); setGroupPage(1); resetView()
                    loadData(isStudent ? undefined : selectedStudent, s)
                  }}
                  options={[
                    { value: 'pending', label: `${t('statusPending')} ${counts.pending}` },
                    { value: 'mastered', label: `${t('statusMastered')} ${counts.mastered}` },
                    { value: 'all', label: `${t('statusAll')} ${counts.all}` },
                  ]}
                />
                <Select style={{ width: 128 }} value={groupMode}
                  onChange={(v: any) => { setGroupMode(v); setGroupPage(1); resetView() }}
                  options={[
                    { value: 'exam', label: t('wbGroupExam') },
                    { value: 'kp', label: t('wbGroupKp') },
                    { value: 'type', label: t('wbGroupType') },
                  ]}
                />
                <Select allowClear showSearch style={{ minWidth: 170 }} placeholder={t('knowledgePoint')}
                  value={kpFilter || undefined} onChange={(v: any) => setKpFilter(v || '')}
                  options={kpOptions} optionFilterProp="label"
                />
                <Input allowClear style={{ width: 210 }} prefix={<SearchOutlined />}
                  placeholder={t('searchContentOrKp')} value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                />
              </div>
              <div className="wb-toolbar-group">
                {!isStudent && missingExpIds.length > 0 && (
                  <Button size="small" icon={<RobotOutlined />} loading={expBusy}
                    onClick={() => runExplainGen(missingExpIds.slice(0, 20))}>
                    {t('wbAiExplainBatch', { count: Math.min(missingExpIds.length, 20) })}
                  </Button>
                )}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {filtered.length === flat.length
                    ? t('wbGroupCount', { count: groups.length })
                    : t('wbFilteredCount', { count: filtered.length, total: flat.length })}
                </Text>
                <Button size="small" type="link" onClick={() => setOpenKeys(groups.map(g => g.key))}>{t('wbOpenAll')}</Button>
                <Button size="small" type="link" onClick={() => setOpenKeys([])}>{t('wbCloseAll')}</Button>
                {!isStudent && !!selectedStudent && !!autoState && (
                  <Tooltip title={t('wbAutoTip')}>
                    <span className="wb-auto-state">
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {t('wbAutoPolicy', {
                          pending: autoState.pending_total, threshold: autoState.policy?.threshold ?? 30,
                          perSet: autoState.policy?.per_set ?? 5, days: autoState.policy?.interval_days ?? 7,
                        })}
                        {' · '}
                        {autoState.last_created_at
                          ? t('wbAutoLast', { days: autoState.days_since_last })
                          : t('wbAutoNever')}
                      </Text>
                      {!!autoState.outstanding_id && <Tag color="orange">{t('wbAutoUnanswered')}</Tag>}
                      <Button size="small" type="link" icon={<ThunderboltOutlined />}
                        loading={autoBusy} onClick={forcePractice}>
                        {t('wbForcePractice')}
                      </Button>
                    </span>
                  </Tooltip>
                )}
              </div>
            </div>

            {selected.size > 0 && (
              <div className="wb-bulkbar" style={{ marginTop: 12 }}>
                <Text strong>{t('selectedCount', { count: selected.size })}</Text>
                <Button size="small" type="primary" loading={bulkBusy} onClick={() => applyBulk('mastered')}>{t('wbMarkMastered')}</Button>
                <Button size="small" loading={bulkBusy} onClick={() => applyBulk('pending')}>{t('unmarkMastered')}</Button>
                <span className="wb-flex" />
                <Button size="small" type="text" onClick={() => setSelected(new Set())}>{t('clearSelection')}</Button>
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              {pagedGroups.length === 0 ? (
                <Card>
                  {/* antd v6 的 Empty 没有 actions 属性，重置按钮放进 description */}
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={(
                    <Space orientation="vertical" size={8}>
                      <span>{t('wbNoMatch')}</span>
                      {(keyword || kpFilter) && (
                        <Button size="small" onClick={() => { setKeyword(''); setKpFilter('') }}>{t('analyticsReset')}</Button>
                      )}
                    </Space>
                  )} />
                </Card>
              ) : pagedGroups.map(g => {
                const wide = wideGroups.has(g.key)
                const visible = wide ? g.items : g.items.slice(0, GROUP_PREVIEW)
                const hidden = g.items.length - visible.length
                return (
                  <Collapse key={g.key} size="small" style={{ marginBottom: 12 }} activeKey={activeKeys}
                    onChange={(k: any) => setOpenKeys((Array.isArray(k) ? k : [k]).map(String))}
                    items={[{
                      key: g.key,
                      label: g.title,
                      children: (
                        <div>
                          {visible.map(q => (
                            <QuestionCard key={`${g.key}:${q.wrong_book_id || q.question_id}`} q={q}
                              selected={!!q.wrong_book_id && selected.has(Number(q.wrong_book_id))}
                              busy={masterBusy === Number(q.wrong_book_id)}
                              kpFilter={kpFilter}
                              onSelect={handleSelect}
                              onToggleMaster={toggleMastered}
                              onPickKp={setKpFilter}
                              canAiExplain={!isStudent}
                              expBusy={expBusy}
                              onAiExplain={(qid) => runExplainGen([qid])}
                              t={t} typeLabel={typeLabel}
                            />
                          ))}
                          {(hidden > 0 || wide) && (
                            <div className="wb-more">
                              <Button size="small" type="link" icon={wide ? <UpOutlined /> : <DownOutlined />}
                                onClick={() => setWideGroups(prev => {
                                  const next = new Set(prev)
                                  if (wide) next.delete(g.key); else next.add(g.key)
                                  return next
                                })}>
                                {wide ? t('collapse') : t('wbShowMore', { count: hidden })}
                              </Button>
                            </div>
                          )}
                        </div>
                      ),
                    }]}
                  />
                )
              })}
            </div>

            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <Pagination
                current={groupPage} pageSize={groupPageSize} total={groups.length}
                showSizeChanger
                showTotal={(total) => groupMode === 'exam' ? t('examTotal', { total }) : t('wbGroupTotal', { total })}
                pageSizeOptions={['5', '10', '20', '50']}
                onChange={(p, ps) => { setGroupPage(p); setGroupPageSize(ps); setOpenKeys(null) }}
                size="small"
              />
            </div>
          </div>
        )}
      </Space>

      <Modal
        title={<><RobotOutlined style={{ color: '#1677ff' }} /> {t('aiReviewPlan')}</>}
        open={planModal}
        onCancel={() => { if (planLoading) return; setPlanModal(false) }}
        width={700}
        footer={
          planLoading ? null : (
            <Space style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
              <Button icon={<DownloadOutlined />} onClick={() => {
                const params = new URLSearchParams()
                if (selectedStudent) params.set('student_username', selectedStudent)
                const qs = params.toString()
                window.open(`/api/wrong-book/review-plan/export${qs ? `?${qs}` : ''}`, '_blank')
              }}>{t('exportWord')}</Button>
              <Button onClick={() => setPlanModal(false)}>{t('close')}</Button>
            </Space>
          )
        }
      >
        {planLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
              <div style={{ marginTop: 16, color: 'var(--text-secondary)' }}>{t('genPlanLoading')}</div>
          </div>
        ) : planData ? (
          <div style={{ maxHeight: '70vh', overflow: 'auto', padding: '0 4px' }}>
            {planData.total_wrong > 0 && (
              <Space style={{ marginBottom: 16 }} wrap>
                <Tag icon={<BookOutlined />} color="blue">{t('wrongCountLabel', { count: planData.total_wrong })}</Tag>
                {planData.weak_types?.map(tw => <Tag key={tw} color="orange">{tw}</Tag>)}
                {planData.knowledge_points?.slice(0, 5).map(kp => (
                  <Tag key={kp} color="purple">{kp}</Tag>
                ))}
              </Space>
            )}
            <div className="markdown-content">
              <FormulaRenderer content={planData.plan} />
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ── 设置题目数量 ── */}
      <Modal mask={{ closable: false }} title={t('generatePractice')} open={countModal}
        onCancel={() => setCountModal(false)}
        footer={[
          <Button key="cancel" onClick={() => setCountModal(false)}>{t('cancel')}</Button>,
          <Button key="go" type="primary" icon={<RobotOutlined />}
            onClick={() => {
              setCountModal(false);
              setTimeout(() => generatePracticeFromWrong(), 100);
            }}>
            {t('startGenerate')}
          </Button>,
        ]}>
        <Space orientation="vertical" style={{ width: '100%', padding: '20px 0' }}>
          <Text>{t('practiceCountLabel')}</Text>
          <InputNumber min={1} max={20} value={practiceCount} onChange={v => setPracticeCount(v || 5)}
            style={{ width: 120 }} />
          <Text type="secondary" style={{ fontSize: 13 }}>{t('practiceCountHint')}</Text>
        </Space>
      </Modal>

      {/* ── 生成练习弹窗 ── */}
      <Modal title={<><RobotOutlined style={{ color: '#1677ff' }} /> {genLoading ? t('aiGenerating') : t('practiceGenerated')}</>}
        open={practiceModal} onCancel={() => { if (genLoading) return; setPracticeModal(false) }}
        width={700} footer={null} closable={!genLoading}>
        {genLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: 'var(--text-secondary)' }}>{t('generatingPracticeDesc')}</div>
          </div>
        ) : generatedQuestions.length > 0 && (
          <>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">{t('generatedCountWithKp', { count: generatedQuestions.length, kp: genKp })}</Text>
            </div>
            {generatedQuestions.map((q: any, i: number) => (
              <Card key={i} size="small" title={<>{t('questionNo', { n: i+1 })} [{typeLabel[q.type] || q.type}]</>}
                style={{ marginBottom: 8, overflowX: 'auto' }}>
                <div style={{ overflowX: 'auto' }}>
                  <FormulaRenderer content={q.question || q.question_text} />
                </div>
                <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} />
                {q.options && Object.entries(q.options).map(([k, v]) => (
                  <div key={k}><Text type="secondary">{k}. <FormulaRenderer content={v as string} inline /></Text></div>
                ))}
                <div style={{ marginTop: 4 }}><Tag color="blue">{t('answerColon')}{q.answer}</Tag></div>
              </Card>
            ))}
            <Divider />
            <Space orientation="vertical" style={{ width: '100%' }}>
              <Input placeholder={t('practiceTitlePlaceholder')} value={pubTitle} onChange={e => setPubTitle(e.target.value)} />
              <Card size="small" style={{ background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                <Space>
                  <Tag color="green">{t('targetedPush')}</Tag>
                  <Text strong>{selectedStudentName}</Text>
                  <Text type="secondary">({selectedStudent})</Text>
                </Space>
              </Card>
              <Space style={{ marginTop: 8 }}>
                <Button type="primary" loading={pubLoading} onClick={async () => {
                  if (!pubTitle.trim()) { message.warning(t('titleRequired')); return }
                  setPubLoading(true)
                  try {
                    await apiClient.post('/api/practice/sessions', {
                      title: pubTitle.trim(), knowledge_points: genKp,
                      question_ids: generatedQuestions.map((q: any) => q.id),
                      target_students: [selectedStudent],
                    })
                    message.success(t('practicePushed'))
                    setPracticeModal(false)
                  } catch (e: any) { message.error(e.response?.data?.detail || t('assignFailed')) }
                  finally { setPubLoading(false) }
                }}>{t('assignPractice')}</Button>
              </Space>
            </Space>
          </>
        )}
      </Modal>
    </Layout>
  )
}

export default WrongBookPage
