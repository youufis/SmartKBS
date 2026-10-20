/**
 * ClassLadderPage — 课堂闯关（大屏版）
 *
 * 教师投屏用的「百万富翁」式单人阶梯闯关：
 *   选主题/学科/知识点 → 生成题池（题库优先，可开关 AI 补题）→ 开一场
 *   → 抽一名学生 → 连打 15 关（每关可用 3 个锦囊之一）→ 答错/超时即止
 *   → 结算上榜 → 抽下一名学生开新局。
 *
 * 规则与学生端「知识闯关」同口径（15 关阶梯 + 3 锦囊 + 答错终止）；
 * 抽人/出题/计分复用课堂抽问与题库链路；积分落现有课堂积分表。
 * 学生不使用自己的设备，本页只面向教师投屏。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, Space, Typography, Select, Switch, Tag, message, Popconfirm, Tooltip, Modal,
  Collapse, Empty, Divider, InputNumber,
} from 'antd'
import {
  RocketOutlined, ThunderboltOutlined, FullscreenOutlined,
  FullscreenExitOutlined, AimOutlined, CheckOutlined, ForwardOutlined, DatabaseOutlined,
  RobotOutlined, BulbOutlined, StarOutlined, SoundOutlined, MutedOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import apiClient from '../api/client'
import useSubjectOptions from '../hooks/useSubjectOptions'
import { useIsMobile } from '../hooks/useIsMobile'
import KnowledgePointSelect from '../components/KnowledgePointSelect'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import { reportLoadError } from '../utils/loadError'
import { runAiTaskJob } from '../api/aiTask'
import useNameSpeech from '../hooks/useNameSpeech'
import ladderSound from '../utils/ladderSound'
import './ClassLadderPage.css'
import {
  LadderConfig, LadderRun, LadderQuestion, LadderSession,
  LadderBoardRow, LadderResultItem,
  getLadderConfig, openLadderSession, getLadderSession, endSession,
  openRun, answerRun, timeoutRun, useLifeline, getRunResult, getBoard, getLadderRecords,
} from '../api/classLadder'

const { Text } = Typography

/** 皮肤 / 音效 / 播报偏好记本地（与页面其它偏好分开记） */
const SKIN_PREF_KEY = 'class_ladder_skin'
const SOUND_PREF_KEY = 'class_ladder_sound_on'

/** 锦囊图标（含大屏新增的现场表决 / 请军师） */
const LF_I18N: Record<string, string> = {
  remove_one: 'lifelineRemoveOne', phone_friend: 'lifelinePhoneFriend',
  audience_vote: 'lifelineAudienceVote', class_vote: 'lifelineClassVote', helper: 'lifelineHelper',
}

const LF_ICON: Record<string, string> = {
  remove_one: '🎯', phone_friend: '📞', audience_vote: '👥', class_vote: '🙋', helper: '🤝',
}

/** 取选项的作答键：单选是字母（A/B/C/D…），判断/其他退回序号字母。 */
function optionKey(opt: string, idx: number, questionType: string): string {
  if (questionType === 'true_false') return String(opt || '').trim()
  const matched = String(opt || '').trim().match(/^([A-Ha-h])[.、．]/)
  return matched ? matched[1].toUpperCase() : String.fromCharCode(65 + idx)
}

/** 选项去掉 "A. " 前缀后的展示文本（前缀由圆标显示） */
function optionText(opt: string, questionType: string): string {
  const s = String(opt || '').trim()
  if (questionType === 'true_false') return s
  return s.length > 2 && ['.', '、', '．'].includes(s[1]) ? s.slice(2).trim() : s
}

const ClassLadderPage: React.FC = () => {
  const { t } = useTranslation('classLadder')
  const { subjects } = useSubjectOptions()
  const isMobile = useIsMobile()

  // ── 配置 ──
  const [config, setConfig] = useState<LadderConfig | null>(null)

  // ── 开场设置 ──
  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [grade, setGrade] = useState('')
  const [cls, setCls] = useState('')
  const [subject, setSubject] = useState('')
  const [courseKp, setCourseKp] = useState('')
  const [questionType, setQuestionType] = useState('single')
  const [timeLimit, setTimeLimit] = useState(90)
  const [poolSize, setPoolSize] = useState(30)
  const [skin, setSkin] = useState(() => localStorage.getItem(SKIN_PREF_KEY) || '')
  const [allowAi, setAllowAi] = useState(false)
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(SOUND_PREF_KEY) !== '0')
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [poolProgress, setPoolProgress] = useState<{ done: number; total: number } | null>(null)
  const [votePanel, setVotePanel] = useState<Record<string, number> | null>(null)

  // ── 场次 / 题池 ──
  const [session, setSession] = useState<LadderSession | null>(null)
  const [opening, setOpening] = useState(false)
  const [building, setBuilding] = useState(false)

  // ── 本局 ──
  const [run, setRun] = useState<LadderRun | null>(null)
  const [currentQ, setCurrentQ] = useState<LadderQuestion | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [reveal, setReveal] = useState<{ correct: boolean; answer: string; score: number } | null>(null)
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [rolling, setRolling] = useState(false)
  const [rollName, setRollName] = useState('')
  const [remaining, setRemaining] = useState(0)

  // ── 锦囊 / 红榜 / 结算 ──
  const [lfModal, setLfModal] = useState<{ type: string; advice?: string; votes?: Record<string, number> } | null>(null)
  const [board, setBoard] = useState<LadderBoardRow[]>([])
  const [records, setRecords] = useState<LadderBoardRow[]>([])
  const [result, setResult] = useState<{ run: LadderRun; detail: LadderResultItem[] } | null>(null)
  const [fs, setFs] = useState(false)

  // 语音念名（与点名/抽问同一份实现：失败只给一句人话 + 重试入口）
  const {
    prepare: prepareSpeech, cancel: cancelSpeech, play: playSpeech,
    retry: retrySpeech, failure: speechFailure, clearFailure: clearSpeechFailure,
  } = useNameSpeech({
    grade, class: cls, enabled: ttsEnabled, speakOn: soundOn,
    onDisabled: () => setTtsEnabled(false),
    onConfigIssue: (msg) => message.warning(msg, 6),
  })

  // 声音总开关可用性：音效总闸开着 或 语音合成可用（任一可用就能控制）
  const soundAvailable = Boolean(config?.sound_enabled) || ttsEnabled

  const rollTimer = useRef<number | null>(null)
  const advanceTimer = useRef<number | null>(null)
  const studentPool = useRef<string[]>([])

  const activeSkin = skin || session?.skin || config?.default_skin || 'cloud'
  const skinMeta = useMemo(
    () => config?.skins.find((s) => s.value === activeSkin),
    [config, activeSkin])
  const mode = skinMeta?.light ? 'light' : 'dark'

  // 锦囊固定三件套（与学生端一致）：默认集由服务端下发，本场若被主题/接口指定则以其为准
  const activeLifelines = useMemo(() => {
    const all = config?.lifelines || []
    const keys = session?.lifelines?.length
      ? session.lifelines
      : (config?.default_lifelines?.length ? config.default_lifelines : ['remove_one', 'phone_friend', 'audience_vote'])
    return keys.map((k) => all.find((x) => x.type === k)).filter(Boolean) as
      { type: string; name: string; discount: number }[]
  }, [config, session])

  const topic = courseKp.trim()
  const ready = Boolean(grade && cls && (topic || subject))

  const clearTimers = useCallback(() => {
    if (rollTimer.current) { clearInterval(rollTimer.current); rollTimer.current = null }
    if (advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null }
    cancelSpeech()
  }, [cancelSpeech])
  useEffect(() => clearTimers, [clearTimers])

  // ── 初始化 ──
  useEffect(() => {
    getLadderConfig().then((cfg) => {
      setConfig(cfg)
      setAllowAi(Boolean(cfg.ai_enabled))
      setTimeLimit(cfg.default_time_limit || 90)
      setPoolSize(cfg.default_pool_size || 30)
      if (!skin) setSkin(cfg.default_skin || 'star')

    }).catch((e) => reportLoadError(e, { key: 'classladder-config' }))

    apiClient.get('/api/rollcall/speech-status')
      .then(({ data }) => setTtsEnabled(!!data?.enabled))
      .catch(() => {})

    apiClient.get('/api/rollcall/grades')
      .then(({ data }) => setGrades(Array.isArray(data) ? data : []))
      .catch((e) => reportLoadError(e, { key: 'classladder-grades' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadClasses = useCallback(async (g: string) => {
    if (!g) { setClasses([]); return }
    try {
      const { data } = await apiClient.get('/api/rollcall/classes', { params: { grade: g } })
      setClasses(Array.isArray(data) ? data : [])
    } catch (e) { setClasses([]); reportLoadError(e, { key: 'classladder-classes' }) }
  }, [])

  const refreshBoard = useCallback(async (g: string, c: string) => {
    if (!g || !c) return
    try {
      const [b, r] = await Promise.all([getBoard(g, c, 12), getLadderRecords(g, c, 30)])
      setBoard(b.rows || [])
      setRecords(r.records || [])
    } catch { /* 红榜读不到不影响闯关 */ }
  }, [])

  const handleGradeChange = (v: string) => { setGrade(v); setCls(''); setClasses([]); setSession(null); setBoard([]); setRecords([]); loadClasses(v) }
  const handleClassChange = (v: string) => { setCls(v); setSession(null); setBoard([]); setRecords([]); refreshBoard(grade, v) }

  const handleSkinChange = (v: string) => { setSkin(v); localStorage.setItem(SKIN_PREF_KEY, v) }

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
  }, [session, t])

  const doOpenSession = useCallback(async () => {
    if (!ready) { message.warning(t('selectTopicOrSubject')); return }
    setOpening(true)
    try {
      const s = await openLadderSession({
        grade, class: cls, subject, topic,
        allow_ai: allowAi, question_type: questionType,
        time_limit_sec: timeLimit, pool_size: poolSize, skin: activeSkin,
      })
      setSession(s)
      setRun(null); setCurrentQ(null); setResult(null); setBoard([]); setRecords([])
      message.success(t('sessionOpened'))
      await doBuildPool(s)
    } catch (e: any) {
      message.error(String(e?.response?.data?.detail || t('openFailed')), 6)
    } finally { setOpening(false) }
  }, [ready, grade, cls, subject, topic, allowAi, questionType, timeLimit, poolSize, activeSkin, t, doBuildPool])

  // ── 抽人开新局 ──
  const doOpenRun = useCallback(async () => {
    if (!session) { message.warning(t('selectGradeClass')); return }
    if (!session.pool?.total) { message.warning(t('needPool')); return }
    setResult(null); setReveal(null); setSelected(null); setHiddenKeys([])
    clearSpeechFailure()
    setBusy(true); setRolling(true)
    // 占位名单（大屏滚动效果）：用班级人数做假滚动，真实名单服务端才知道
    const pool = studentPool.current.length ? studentPool.current : ['🎲', '🎯', '⭐', '🏆', '✨']
    if (rollTimer.current) clearInterval(rollTimer.current)
    let i = 0
    rollTimer.current = window.setInterval(() => {
      setRollName(pool[i % pool.length]); i += 1
    }, 70)
    try {
      const r = await openRun(session.grade, session.class)
      if (rollTimer.current) { clearInterval(rollTimer.current); rollTimer.current = null }
      setRun(r.run)
      setCurrentQ(r.run.question || null)
      setRemaining(r.run.time_limit_sec || 0)
      setRolling(false)
      setRollName(r.run.student)
      prepareSpeech(r.run.student)
      playSpeech(r.run.student)
      if (soundOn) ladderSound.start()
      message.success(`${r.run.student}`)
      refreshBoard(session.grade, session.class)
    } catch (e: any) {
      clearTimers(); setRolling(false); setRollName('😅')
      message.error(String(e?.response?.data?.detail || t('drawFailed')))
    } finally { setBusy(false) }
  }, [session, refreshBoard, clearTimers, prepareSpeech, playSpeech, clearSpeechFailure, soundOn, t])

  // ── 提交作答 ──
  const doSubmit = useCallback(async (skip = false) => {
    if (!run || !currentQ) { message.warning(t('noQuestionYet')); return }
    if (!skip && selected === null) { message.warning(t('pickAnswerFirst')); return }
    if (busy || reveal) return
    setBusy(true)
    const key = skip ? '' : optionKey(currentQ.options[selected as number] || '', selected as number, currentQ.type)
    try {
      const res = skip
        ? await answerRun(run.run_id, { level: currentQ.level, selected: '', time_spent: 0 })
        : await answerRun(run.run_id, { level: currentQ.level, selected: key, time_spent: 0 })
      setReveal({ correct: res.correct, answer: res.correct_answer, score: res.score_added })
      if (soundOn) {
        if (res.correct && res.run.status === 'win') ladderSound.settle()
        else if (res.correct) ladderSound.correct()
        else ladderSound.wrong()
      }
      if (res.correct && res.run.status === 'playing') {
        advanceTimer.current = window.setTimeout(() => {
          setRun(res.run); setCurrentQ(res.run.question || null)
          setSelected(null); setReveal(null); setHiddenKeys([])
          setRemaining(res.run.time_limit_sec || 0)
        }, 1900)
      } else {
        setRun(res.run)
        const full = await getRunResult(res.run.run_id)
        setResult(full)
        if (session) refreshBoard(session.grade, session.class)
      }
    } catch (e: any) {
      message.error(String(e?.response?.data?.detail || t('answerFailed')))
    } finally { setBusy(false) }
  }, [run, currentQ, selected, busy, reveal, session, refreshBoard, soundOn, t])

  const doTimeout = useCallback(async () => {
    if (!run || !currentQ || reveal || busy) return
    setBusy(true)
    try {
      const res = await timeoutRun(run.run_id, currentQ.level)
      setReveal({ correct: false, answer: res.correct_answer, score: 0 })
      if (soundOn) ladderSound.wrong()
      setRun(res.run)
      const full = await getRunResult(res.run.run_id)
      setResult(full)
      if (session) refreshBoard(session.grade, session.class)
    } catch { /* 超时提交失败就不打断 */ } finally { setBusy(false) }
  }, [run, currentQ, reveal, busy, session, refreshBoard, soundOn])

  // ── 锦囊 ──
  const doLifeline = useCallback(async (type: string) => {
    if (!run || !currentQ) return
    if (run.lifelines_used?.includes(type)) {
      message.warning(t('lifelineUsedTip', { name: t(LF_I18N[type] || 'lifelineRemoveOne') }))
      return
    }
    // 现场表决：先弹面板录入举手人数，提交时才消耗锦囊
    if (type === 'class_vote') {
      const init: Record<string, number> = {}
      ;(currentQ.options || []).forEach((o, i) => { init[optionKey(o, i, currentQ.type)] = 0 })
      setVotePanel(init)
      return
    }
    setBusy(true)
    try {
      const r = await useLifeline(run.run_id, type)
      setRun((prev) => prev ? { ...prev, lifelines_used: [...(prev.lifelines_used || []), type] } : prev)
      if (r.removed) setHiddenKeys((prev) => [...prev, r.removed as string])
      if (type === 'helper') message.info(t('helperHint', { name: r.student || '' }), 6)
      else setLfModal({ type, advice: r.advice, votes: r.votes })
      if (r.score_after != null) message.info(t('lifelineScoreAfter', { score: r.score_after }))
      if (soundOn) ladderSound.lifeline()
    } catch (e: any) {
      message.error(String(e?.response?.data?.detail || t('lifelineFailed')))
    } finally { setBusy(false) }
  }, [run, currentQ, soundOn, t])

  /** 现场表决：提交举手人数（服务端换算成百分比） */
  const submitClassVote = useCallback(async () => {
    if (!run || !votePanel) return
    if (Object.values(votePanel).every((v) => !v)) { message.warning(t('voteNeedCount')); return }
    setBusy(true)
    try {
      const r = await useLifeline(run.run_id, 'class_vote', votePanel)
      setRun((prev) => prev ? { ...prev, lifelines_used: [...(prev.lifelines_used || []), 'class_vote'] } : prev)
      setVotePanel(null)
      setLfModal({ type: 'class_vote', votes: r.votes })
      if (soundOn) ladderSound.lifeline()
    } catch (e: any) {
      message.error(String(e?.response?.data?.detail || t('lifelineFailed')))
    } finally { setBusy(false) }
  }, [run, votePanel, soundOn, t])


  // ── 计时 ──
  useEffect(() => {
    if (!run || run.status !== 'playing' || !run.time_limit_sec || reveal) return
    if (remaining <= 0) return
    const id = window.setInterval(() => setRemaining((n) => Math.max(0, n - 1)), 1000)
    return () => clearInterval(id)
  }, [run, reveal, remaining > 0])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (run?.status === 'playing' && run.time_limit_sec && remaining === 0 && !reveal) void doTimeout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining])

  // 倒计时音效：>10s 滴答，<=10s 告急
  useEffect(() => {
    if (!soundOn || !run || run.status !== 'playing' || reveal || remaining <= 0) return
    if (remaining <= 10) ladderSound.urgent()
    else ladderSound.tick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining])

  // ── 快捷键 ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
      if (e.key === ' ') { e.preventDefault(); if (!busy) void doOpenRun(); return }
      if (e.key === 'Enter') { e.preventDefault(); void doSubmit(false); return }
      if (e.key === '0') { void doSubmit(true); return }
      if (/^[1-9]$/.test(e.key) && currentQ && !reveal) {
        const idx = Number(e.key) - 1
        if (idx < (currentQ.options || []).length) setSelected(idx)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [busy, currentQ, reveal, doOpenRun, doSubmit])

  const toggleFs = useCallback(() => {
    if (!document.fullscreenElement) { document.documentElement.requestFullscreen?.(); setFs(true) }
    else { document.exitFullscreen?.(); setFs(false) }
  }, [])

  const ladderRows = useMemo(() => (config?.ladder || []).slice().sort((a, b) => b.level - a.level), [config])
  const curLevel = run?.status === 'playing' ? (run.current_level || 1) : 0

  if (isMobile) return <div className="cl-mobile">{t('mobileGuide')}</div>

  return (
    <div className="cl-root" data-skin={activeSkin} data-mode={mode}>
      <div className="cl-inner">
        {/* 顶部条 */}
        <div className="cl-bar">
          <div className="cl-brand"><span className="dot" /><h1>{t('title')}</h1></div>
          {run && (
            <div className="cl-whochip">
              <span className="lb">{t('studentIs')}：</span>
              <span className={`nm${rolling ? ' rolling' : ''}`}>
                {rolling ? rollName : run.student}
              </span>
              {reveal && reveal.score > 0 && <span className="sc">{t('scoreAdded', { score: reveal.score })}</span>}
              {speechFailure && (
                <span className="sf">
                  {speechFailure.kind === 'network' ? t('speakFailed') : (speechFailure.message || t('speakFailed'))}
                  <Button type="link" size="small" style={{ fontSize: 12, padding: '0 4px' }}
                    onClick={() => { void retrySpeech() }}>{t('speakRetry')}</Button>
                </span>
              )}
            </div>
          )}
          {session && <div className="cl-chip gold">{session.topic || session.subject || t('title')}</div>}
          {session && <div className="cl-chip">{session.grade}{session.class}</div>}
          {run && <div className="cl-chip">{t('levelOf', { n: curLevel || run.reached_level, total: config?.max_levels || 15 })}</div>}
          {run && <div className="cl-chip gold">{t('totalScore')} {run.ladder_score}</div>}
          <div className="cl-spacer" />
          {run?.status === 'playing' && (
            <div className="cl-lfs">
              {activeLifelines.map((lf) => {
                const used = run.lifelines_used?.includes(lf.type)
                const label = t(LF_I18N[lf.type] || 'lifelineRemoveOne')
                return (
                  <div key={lf.type} className={`cl-lf${used ? ' used' : ''}`} data-disabled={used || busy ? '1' : '0'}
                    title={`${label}（得分 ×${lf.discount}）`}
                    onClick={() => !used && void doLifeline(lf.type)}>
                    <div className="ico">{LF_ICON[lf.type] || '💡'}</div>
                    <div className="nm">{label}</div>
                  </div>
                )
              })}
            </div>
          )}
          {run?.status === 'playing' && run.time_limit_sec > 0 && (
            <div className={`cl-timer${remaining <= 10 ? ' hot' : ''}`}>
              <svg width="64" height="64">
                <circle className="track" cx="32" cy="32" r="27" fill="none" strokeWidth="6" />
                <circle className="arc" cx="32" cy="32" r="27" fill="none" strokeWidth="6"
                  strokeDasharray={169.6}
                  strokeDashoffset={169.6 * (1 - remaining / Math.max(1, run.time_limit_sec))} />
              </svg>
              <b>{remaining}</b>
            </div>
          )}
          <Tooltip title={fs ? t('exitFullscreen') : t('fullscreen')}>
            <Button size="small" icon={fs ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={toggleFs} />
          </Tooltip>
        </div>

        {/* ── 开场设置 ── */}
        <div className="cl-setup">
          <Select placeholder={t('selectGradePlaceholder')} value={grade || undefined} onChange={handleGradeChange}
            style={{ width: 118 }} options={grades.map((g) => ({ label: g, value: g }))} />
          <Select placeholder={t('selectClassPlaceholder')} value={cls || undefined} onChange={handleClassChange}
            style={{ width: 130 }} disabled={!grade} options={classes.map((c) => ({ label: c, value: c }))} />

          <Select placeholder={t('subjectPlaceholder')} value={subject || undefined} allowClear
            onChange={(v) => { setSubject(v || ''); setCourseKp('') }}
            style={{ width: 118 }} options={subjects.map((s) => ({ label: s, value: s }))} />
          <KnowledgePointSelect multiple={false} subject={subject} value={courseKp}
            onChange={(v) => setCourseKp(String(v || ''))} style={{ width: 200 }} />

          <Select value={questionType} onChange={setQuestionType} style={{ width: 116 }}
            options={(config?.question_types || [{ value: 'single', label: t('qtSingle') }]).map((o) => ({
              label: o.value === 'true_false' ? t('qtTrueFalse') : t('qtSingle'), value: o.value,
            }))} />
          <Select value={timeLimit} onChange={setTimeLimit} style={{ width: 116 }}
            options={[...(config?.time_limits || [30, 45, 60, 90]).map((n) => ({ label: t('secondUnit', { n }), value: n })),
              { label: t('timeLimitNone'), value: 0 }]} />
          <Select value={poolSize} onChange={setPoolSize} style={{ width: 108 }}
            options={[15, 30, 45].map((n) => ({ label: t('poolSizeUnit', { n }), value: n }))} />

          <Select value={activeSkin} onChange={handleSkinChange} style={{ width: 132 }}
            options={(config?.skins || []).map((s) => ({
              label: `${s.light ? '☀ ' : '🌙 '}${s.label}`, value: s.value,
            }))} />

          {/* 一个声音总开关：音效（WebAudio 合成）与抽中念名一起控制 */}
          <Tooltip title={!soundAvailable ? t('soundDisabledByAdmin') : (soundOn ? t('soundOnHint') : t('soundOffHint'))}>
            <Button size="small" disabled={!soundAvailable}
              icon={soundOn && soundAvailable ? <SoundOutlined /> : <MutedOutlined />}
              onClick={() => setSoundOn((v) => { localStorage.setItem(SOUND_PREF_KEY, v ? '0' : '1'); return !v })} />
          </Tooltip>
          <Tooltip title={config && !config.ai_enabled ? t('aiDisabledByAdmin') : t('aiSwitchHint')}>
            <Space size={6}>
              <Switch checked={allowAi} disabled={!config?.ai_enabled} onChange={setAllowAi} size="small" />
              <Text type={config?.ai_enabled ? undefined : 'secondary'} style={{ fontSize: 13 }}>
                <RobotOutlined /> {t('aiSwitch')}
              </Text>
            </Space>
          </Tooltip>
          <Button type="primary" icon={<RocketOutlined />} loading={opening} disabled={!ready} onClick={doOpenSession}>
            {session ? t('resetSession') : t('startSession')}
          </Button>
          <Button icon={<DatabaseOutlined />} loading={building} disabled={!session} onClick={() => doBuildPool()}>
            {building && poolProgress
              ? t('poolProgress', { done: poolProgress.done, total: poolProgress.total })
              : (session?.pool?.total ? t('rebuildPool') : t('buildPool'))}
          </Button>


          <Popconfirm title={t('confirmEnd')} disabled={!session} onConfirm={async () => {
            try {
              await endSession(grade, cls)
              setSession(null); setRun(null); setCurrentQ(null); setResult(null); setBoard([]); setRecords([])
              message.success(t('endSession'))
            } catch (e: any) { message.error(String(e?.response?.data?.detail || t('openFailed'))) }
          }}>
            <Button danger disabled={!session}>{t('endSession')}</Button>
          </Popconfirm>
        </div>


        {/* ── 主区：阶梯 / 舞台 / 红榜 ── */}
        <div className="cl-main">
          <section className="cl-ladder cl-panel">
            <h2><StarOutlined /> {t('ladderTitle')}</h2>
            <div className="cl-rungs">
              {ladderRows.map((row) => {
                const cls2 = row.level === curLevel ? ' now' : (curLevel && row.level < curLevel ? ' done' : '') + (row.safe ? ' safe' : '')
                return (
                  <div key={row.level} className={`cl-rung${cls2}`}>
                    <span className="lv">{t('levelLabel', { n: row.level })}</span>
                    <span>{row.score} 分{row.safe ? ` · ${t('safeShort')}` : ''}</span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="cl-stage">

            <div className="cl-qcard">
              {currentQ ? (
                <>
                  <div className="cl-qmeta">
                    <span className="cl-pill"><BulbOutlined /> {currentQ.type === 'true_false' ? t('qtTrueFalse') : t('qtSingle')} · {currentQ.source === 'ai' ? t('sourceAi') : t('sourceBank')}</span>
                    <span className="cl-pill point">{t('levelLabel', { n: currentQ.level })} · {currentQ.score} 分</span>
                    <span className="cl-pill">{t('difficulty')}：{currentQ.difficulty === 'easy' ? t('diffEasy') : currentQ.difficulty === 'hard' ? t('diffHard') : t('diffMedium')}</span>
                  </div>
                  <div className="cl-stem"><FormulaRenderer content={currentQ.question} /></div>
                  <MediaDisplay svgContent={currentQ.svg_content} hasSvg={currentQ.has_svg}
                    mediaFiles={currentQ.media_files as never} size="large" />
                  <div className="cl-opts">
                    {(currentQ.options || []).map((opt, i) => {
                      const key = optionKey(opt, i, currentQ.type)
                      const gone = hiddenKeys.includes(key)
                      const isRight = Boolean(reveal) && key === reveal?.answer
                      const isWrong = Boolean(reveal) && selected === i && !reveal?.correct
                      const cls3 = [gone ? ' gone' : '', selected === i && !reveal ? ' sel' : '',
                        isRight ? ' right' : '', isWrong ? ' wrong' : ''].join('')
                      return (
                        <div key={i} className={`cl-opt${cls3}`}
                          onClick={() => { if (!gone && !reveal && !busy) setSelected(i) }}>
                          <span className="k">{key}</span>
                          <span className="txt"><FormulaRenderer content={optionText(opt, currentQ.type)} inline /></span>
                          {isRight && <span className="mark">✓</span>}
                        </div>
                      )
                    })}
                  </div>
                  <div className="cl-footline">
                    {reveal ? (
                      <>
                        <span>{t('answerIs')}：<b style={{ color: '#2f9e44' }}>{reveal.answer || '—'}</b></span>
                        {!reveal.correct && <span>· {t('incorrectTxt')}</span>}
                      </>
                    ) : (
                      <span>{t('enterHint')}</span>
                    )}
                  </div>
                </>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('drawStudent')} style={{ margin: 'auto' }} />
              )}
            </div>
          </section>

          <aside className="cl-board cl-panel">
            <h2>🏆 {t('boardTitle')}</h2>
            {board.length === 0 ? <div className="empty">{t('boardEmpty')}</div> : board.map((r, i) => (
              <div key={r.id} className={`cl-row${i === 0 ? ' top1' : ''}`}>
                <span className="rk">{i + 1}</span>
                <span className="nm">{r.student_name}</span>
                <span className="sc">{r.ladder_score}</span>
              </div>
            ))}
            {board.length > 0 && (
              <div className="empty" style={{ marginTop: 6 }}>
                {t('boardReached', { n: board[0].reached_level })} · {t('correctCount')} {board[0].correct_count}
              </div>
            )}
          </aside>
        </div>

        {/* ── 底部操作条 ── */}
        <div className="cl-foot">
          <div className={`cl-btn ghost${!session || !session.pool?.total ? ' dim' : ''}`} onClick={() => void doOpenRun()}>
            <AimOutlined /> {busy && rolling ? t('drawing') : t('drawStudent')}
          </div>
          <div className={`cl-btn gold${!currentQ || selected === null || Boolean(reveal) ? ' dim' : ''}`} onClick={() => void doSubmit(false)}>
            <CheckOutlined /> {t('submitAnswer')}
          </div>
          <div className={`cl-btn ghost${!currentQ || Boolean(reveal) ? ' dim' : ''}`} onClick={() => void doSubmit(true)}>
            <ForwardOutlined /> {t('skipLevel')}
          </div>
          <div className="cl-hint">{t('kbdHint')}</div>
        </div>

        {/* ── 本场流水 ── */}
        <Collapse ghost items={[{
          key: 'rec',
          label: <span><ThunderboltOutlined /> {t('recordsTitle')} · {t('recordsCount', { count: records.length })}</span>,
          children: records.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('recordsEmpty')} />
            : (
              <div className="cl-detail">
                {records.map((r, i) => (
                  <div key={r.id} className="cl-detail-row">
                    <Text type="secondary" style={{ width: 34 }}>#{records.length - i}</Text>
                    <Text strong style={{ width: 88 }}>{r.student_name}</Text>
                    <Tag color={r.status === 'win' ? 'green' : r.status === 'lost' ? 'orange' : 'default'}>
                      {t('boardReached', { n: r.reached_level })}
                    </Tag>
                    <span style={{ color: 'var(--cl-ink-dim)' }}>{t('correctCount')} {r.correct_count}</span>
                    <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{t('ladderScore')} {r.ladder_score}</span>
                    <span style={{ width: 70, textAlign: 'right', color: '#2f9e44' }}>{t('pointsUnit', { n: r.correct_count })}</span>
                  </div>
                ))}
              </div>
            ),
        }]} />

        <Divider style={{ margin: '4px 0' }} />
      </div>

      {/* ── 结算遮罩 ── */}
      {result && (
        <div className={`cl-overlay${mode === 'light' ? ' light' : ''}`}>
          {result.run.status === 'win' && (
            <div className="cl-cf">
              {['#ffd54f', '#4fc3f7', '#7c4dff', '#52c41a', '#ff8a80', '#ffe9a8'].map((c, i) => (
                <i key={i} style={{ left: `${8 + i * 15}%`, background: c, animationDuration: `${4.5 + i * 0.5}s` }} />
              ))}
            </div>
          )}
          <div className="cl-ovbox">
            <div className={`cl-ovtitle ${result.run.status === 'win' ? 'win' : result.run.status === 'timeout' ? 'timeout' : 'lose'}`}>
              {result.run.status === 'win' ? t('winTitle') : result.run.status === 'timeout' ? t('timeoutTitle') : t('loseTitle')}
            </div>
            <div className="cl-ovsub">
              {result.run.student} · {t('boardReached', { n: result.run.reached_level })} · {t('gameOver')}
            </div>
            <div className="cl-ovcards">
              <div className="cl-ovcard"><div className="k">{t('reachedLevel')}</div><div className="v">{result.run.reached_level}</div></div>
              <div className="cl-ovcard"><div className="k">{t('correctCount')}</div><div className="v">{result.run.correct_count}</div></div>
              <div className="cl-ovcard gold"><div className="k">{t('ladderScore')}</div><div className="v">{result.run.ladder_score}</div></div>
              <div className="cl-ovcard gold"><div className="k">{t('pointsAwarded')}</div><div className="v">+{result.run.points_awarded}</div></div>
            </div>
            {result.detail.length > 0 && (
              <div className="cl-ovans">
                {(() => {
                  const last = result.detail[result.detail.length - 1]
                  return (
                    <>
                      {t('levelLabel', { n: last.level })} · {t('answerIs')}：<b>{last.correct_answer || '—'}</b>
                      {last.selected ? ` · ${t('yourPick')}：${last.selected}` : ''}
                      {last.explanation ? <div style={{ marginTop: 6, fontSize: 15, color: 'var(--cl-ink-dim)' }}>
                        <FormulaRenderer content={last.explanation} /></div> : null}
                    </>
                  )
                })()}
              </div>
            )}
            <div className="cl-ovbtns">
              <div className="cl-btn gold" onClick={() => void doOpenRun()}><AimOutlined /> {t('newRun')}</div>
              <div className="cl-btn ghost" onClick={() => setResult(null)}>{t('seeBoard')}</div>
            </div>
          </div>
        </div>
      )}

      {/* ── 锦囊弹窗 ── */}
      <Modal
        open={Boolean(lfModal)} onCancel={() => setLfModal(null)} footer={null}
        title={lfModal?.type === 'phone_friend' ? t('lifelineAdviceTitle') : t('lifelineVoteTitle')}
      >
        {lfModal?.type === 'phone_friend' && <div style={{ fontSize: 18 }}>💬 “{lfModal.advice}”</div>}
        {lfModal?.type === 'audience_vote' && lfModal.votes && (
          <Space orientation="vertical" style={{ width: '100%' }}>
            {Object.entries(lfModal.votes).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <b style={{ width: 20 }}>{k}</b>
                <div style={{ flex: 1, height: 20, background: 'var(--cl-chip, #f0f0f0)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ width: `${v}%`, height: '100%', background: 'linear-gradient(90deg,#4fc3f7,#7c4dff)' }} />
                </div>
                <span style={{ width: 48, textAlign: 'right' }}>{v}%</span>
              </div>
            ))}
          </Space>
        )}
        <div style={{ textAlign: 'right', marginTop: 16 }}>
          <Button type="primary" onClick={() => setLfModal(null)}>{t('lifelineOk')}</Button>
        </div>
      </Modal>

      {/* ── 现场表决：录入举手人数 ── */}
      <Modal open={Boolean(votePanel)} onCancel={() => setVotePanel(null)} footer={null}
        maskClosable={false} title={t('voteTitle')}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>{t('voteHint')}</div>
        {votePanel && (currentQ?.options || []).map((o, i) => {
          const k = optionKey(o, i, currentQ?.type || 'single')
          return (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <b style={{ width: 22 }}>{k}</b>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {optionText(o, currentQ?.type || 'single')}
              </span>
              <InputNumber min={0} value={votePanel[k] ?? 0} style={{ width: 96 }}
                onChange={(v) => setVotePanel((prev) => ({ ...(prev || {}), [k]: Number(v || 0) }))} />
            </div>
          )
        })}
        {votePanel && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 6 }}>
            {t('voteTotal', { n: Object.values(votePanel).reduce((a2, b2) => a2 + b2, 0) })}
          </div>
        )}
        <div style={{ textAlign: 'right', marginTop: 16 }}>
          <Space>
            <Button onClick={() => setVotePanel(null)}>{t('lifelineOk')}</Button>
            <Button type="primary" loading={busy} onClick={() => void submitClassVote()}>{t('voteSubmit')}</Button>
          </Space>
        </div>
      </Modal>

    </div>
  )
}

export default ClassLadderPage