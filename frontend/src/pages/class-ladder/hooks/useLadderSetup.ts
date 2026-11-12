import { App, } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import apiClient from '../../../api/client'
import { runAiTaskJob } from '../../../api/aiTask'
import {
  getLadderSession, openLadderSession, endSession, getSessionReport,
} from '../../../api/classLadder'
import type { LadderConfig, LadderSession } from '../../../api/classLadder'
import useSubjectOptions from '../../../hooks/useSubjectOptions'
import { reportLoadError } from '../../../utils/loadError'
import { SCOPE_LS_KEY } from '../constants'

type MsgApi = ReturnType<typeof App.useApp>['message']

interface Args {
  config: LadderConfig | null
  message: MsgApi
  activeSkin: string
  session: LadderSession | null
  setSession: (s: LadderSession | null) => void
  /** 重开/结束场次时清掉对局与结算（setupOpen 由容器复位） */
  onSessionReset: () => void
  refreshBoard: (g: string, c: string) => void
  clearBoard: () => void
}

/**
 * 开场设置：年级/班级/学科/知识点/题型/限时/题池/AI 补题 + 建池、开场、结束场次。
 * 配置到达后套用服务端默认值；年级班级变化联动班级列表与红榜。
 */
export function useLadderSetup(a: Args) {
  const { t } = useTranslation('classLadder')
  const { subjects } = useSubjectOptions()
  const { config, message, activeSkin, session, setSession, onSessionReset, refreshBoard, clearBoard } = a

  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [grade, setGrade] = useState('')
  const [cls, setCls] = useState('')
  const [subject, setSubject] = useState('')
  const [courseKp, setCourseKp] = useState('')
  const [questionType, setQuestionType] = useState('single')
  const [timeLimit, setTimeLimit] = useState(0)
  const [poolSize, setPoolSize] = useState(30)
  const [allowAi, setAllowAi] = useState(false)
  const [safeMode, setSafeMode] = useState(false)
  const [lifelinesSel, setLifelinesSel] = useState<string[]>([])
  const [report, setReport] = useState<Awaited<ReturnType<typeof getSessionReport>> | null>(null)
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [poolProgress, setPoolProgress] = useState<{ done: number; total: number } | null>(null)
  const [opening, setOpening] = useState(false)
  const [building, setBuilding] = useState(false)

  // 配置到达：套用服务端默认（题型限时题池、AI 总闸）
  useEffect(() => {
    if (!config) return
    setAllowAi(Boolean(config.ai_enabled))
    setTimeLimit(config.default_time_limit ?? 0)
    setPoolSize(config.default_pool_size || 30)
  }, [config])

  // 初始化：名单年级列表 + 语音合成可用性 + 恢复上次场次（投屏页误刷新不再丢现场）
  useEffect(() => {
    apiClient.get('/api/rollcall/speech-status')
      .then(({ data }) => setTtsEnabled(!!data?.enabled))
      .catch(() => {})
    apiClient.get('/api/rollcall/grades')
      .then(({ data }) => setGrades(Array.isArray(data) ? data : []))
      .catch((e) => reportLoadError(e, { key: 'classladder-grades' }))
  }, [])

  const loadClasses = useCallback(async (g: string) => {
    if (!g) { setClasses([]); return }
    try {
      const { data } = await apiClient.get('/api/rollcall/classes', { params: { grade: g } })
      setClasses(Array.isArray(data) ? data : [])
    } catch (e) { setClasses([]); reportLoadError(e, { key: 'classladder-classes' }) }
  }, [])

  // 刷新/重进页面：恢复上次场次与红榜（投屏页被 F5 后不再丢现场）
  useEffect(() => {
    let raw: string
    try { raw = localStorage.getItem(SCOPE_LS_KEY) || '' } catch { return }
    if (!raw) return
    try {
      const saved = JSON.parse(raw) as { grade?: string; cls?: string }
      if (!saved.grade || !saved.cls) return
      setGrade(saved.grade); setCls(saved.cls)
      void loadClasses(saved.grade)
      getLadderSession(saved.grade, saved.cls)
        .then(({ session: s }) => {
          if (s) { setSession(s); refreshBoard(saved.grade as string, saved.cls as string) }
        })
        .catch(() => { /* 恢复失败保持手动选择 */ })
    } catch { /* 坏数据忽略 */ }
  }, [loadClasses, refreshBoard, setSession])

  const handleGradeChange = (v: string) => {
    setGrade(v); setCls(''); setClasses([]); setSession(null); clearBoard(); loadClasses(v)
  }
  const handleClassChange = (v: string) => {
    setCls(v); setSession(null); clearBoard(); refreshBoard(grade, v)
    if (grade && v) localStorage.setItem(SCOPE_LS_KEY, JSON.stringify({ grade, cls: v }))
  }

  // ── 建池 / 开场（建池在前：openSession 会调用它）──
  const doBuildPool = useCallback(async (s?: LadderSession) => {
    const sess = s || session
    if (!sess) { message.warning(t('selectGradeClass')); return }
    setBuilding(true)
    setPoolProgress({ done: 0, total: sess.pool_size || 30 })
    try {
      // 走后台任务：题库命中时瞬间返回，AI 补题时页面不卡、进度条照常走
      const res = await runAiTaskJob<{ added: number; notes: string[] }>(
        '/api/class-ladder/session/pool/async',
        { grade: sess.grade, class: sess.class },
        (pr) => setPoolProgress({ done: Number(pr.done || 0), total: Number(pr.total || 1) }),
      )
      const fresh = await getLadderSession(sess.grade, sess.class)
      if (fresh.session) setSession(fresh.session)
      const pool = fresh.session?.pool
      if (res?.added) {
        message.success(t('poolDone', { total: pool?.total ?? 0 }))
      } else {
        message.warning(res?.notes?.[0] || t('poolFailed'))
      }
    } catch (e: any) {
      message.error(String(e?.response?.data?.detail || t('poolFailed')), 6)
    } finally { setBuilding(false); setPoolProgress(null) }
  }, [session, t, message, setSession])

  const topic = courseKp.trim()
  // 学科、知识点都可留空（＝整库随机），硬门槛只剩年级 + 班级
  const ready = Boolean(grade && cls)

  const doOpenSession = useCallback(async () => {
    if (!ready) { message.warning(t('selectGradeClass')); return }
    setOpening(true)
    try {
      const s = await openLadderSession({
        grade, class: cls, subject, topic,
        allow_ai: allowAi && Boolean(topic), question_type: questionType,
        time_limit_sec: timeLimit, pool_size: poolSize, skin: activeSkin,
        safe_mode: safeMode ? 1 : 0,
        lifelines: lifelinesSel.length ? lifelinesSel : undefined,
      })
      setSession(s)
      clearBoard()
      onSessionReset()
      message.success(t('sessionOpened'))
      await doBuildPool(s)
    } catch (e: any) {
      message.error(String(e?.response?.data?.detail || t('openFailed')), 6)
    } finally { setOpening(false) }
  }, [ready, grade, cls, subject, topic, allowAi, safeMode, lifelinesSel, questionType, timeLimit, poolSize,
      activeSkin, t, doBuildPool, message, setSession, clearBoard, onSessionReset])

  const doEndSession = useCallback(async () => {
    try {
      let rep: Awaited<ReturnType<typeof getSessionReport>> | null = null
      try { rep = await getSessionReport(grade, cls) } catch { /* 战报拉不到不挡结束本场 */ }
      await endSession(grade, cls)
      setSession(null)
      clearBoard()
      onSessionReset()
      if (rep && ((rep.board && rep.board.length) || (rep.runs && rep.runs.length))) setReport(rep)
      message.success(t('endSession'))
    } catch (e: any) {
      message.error(String(e?.response?.data?.detail || t('openFailed')))
    }
  }, [grade, cls, t, message, setSession, clearBoard, onSessionReset])

  return {
    subjects, grades, classes, grade, cls, subject, courseKp, questionType,
    timeLimit, poolSize, allowAi, safeMode, lifelinesSel, report, ttsEnabled, poolProgress, opening, building,
    setSubject, setCourseKp, setQuestionType, setTimeLimit, setPoolSize, setAllowAi, setTtsEnabled,
    setSafeMode, setLifelinesSel, clearReport: () => setReport(null),
    handleGradeChange, handleClassChange, doBuildPool, doOpenSession, doEndSession,
    ready, topic,
  }
}

export type LadderSetupApi = ReturnType<typeof useLadderSetup>
