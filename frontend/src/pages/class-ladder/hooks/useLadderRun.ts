import { App } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  openRun, answerRun, timeoutRun, useLifeline, getRunResult,
} from '../../../api/classLadder'
import type { LadderRun as LadderRunT, LadderQuestion, LadderSession } from '../../../api/classLadder'
import ladderSound from '../../../utils/ladderSound'
import { LF_I18N } from '../constants'
import { optionKey } from '../utils'
import type { LadderLfModal, LadderResult, LadderReveal, LadderVotePanel } from '../types'

type MsgApi = ReturnType<typeof App.useApp>['message']

interface Args {
  session: LadderSession | null
  message: MsgApi
  soundOn: boolean
  speech: {
    prepare: (name: string) => void
    play: (name: string) => void
    cancel: () => void
    clearFailure: () => void
  }
  refreshBoard: (g: string, c: string) => void
  patchBoard: (r: LadderRunT) => void
  /** 抽中人后收起开场设置行 */
  onRunStarted: () => void
}

/**
 * 对局状态机：抽人（滚动动画）→ 逐关作答/跳过/超时 → 锦囊 → 结算。
 * 计时、倒计时音效、键盘快捷键都收敛在这里；逻辑与拆分前一致。
 */
export function useLadderRun(a: Args) {
  const { t } = useTranslation('classLadder')
  const { session, message, soundOn, refreshBoard, patchBoard, onRunStarted } = a
  const { prepare: prepareSpeech, play: playSpeech, cancel: cancelSpeech, clearFailure: clearSpeechFailure } = a.speech

  const [run, setRun] = useState<LadderRunT | null>(null)
  const [currentQ, setCurrentQ] = useState<LadderQuestion | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [reveal, setReveal] = useState<LadderReveal | null>(null)
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [rolling, setRolling] = useState(false)
  const [rollName, setRollName] = useState('')
  const [remaining, setRemaining] = useState(0)

  const [lfModal, setLfModal] = useState<LadderLfModal | null>(null)
  const [votePanel, setVotePanel] = useState<LadderVotePanel | null>(null)
  const [result, setResult] = useState<LadderResult | null>(null)

  const rollTimer = useRef<number | null>(null)
  const advanceTimer = useRef<number | null>(null)
  const studentPool = useRef<string[]>([])

  const clearTimers = useCallback(() => {
    if (rollTimer.current) { clearInterval(rollTimer.current); rollTimer.current = null }
    if (advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null }
    cancelSpeech()
  }, [cancelSpeech])
  useEffect(() => clearTimers, [clearTimers])

  /** 换场/结束场次时清掉本局与结算（红榜由容器单独清） */
  const resetRun = useCallback(() => {
    setRun(null); setCurrentQ(null); setResult(null)
    setSelected(null); setReveal(null); setHiddenKeys([])
    setVotePanel(null); setLfModal(null)
  }, [])

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
      onRunStarted()
      refreshBoard(session.grade, session.class)
    } catch (e: any) {
      clearTimers(); setRolling(false); setRollName('😅')
      message.error(String(e?.response?.data?.detail || t('drawFailed')))
    } finally { setBusy(false) }
  }, [session, refreshBoard, clearTimers, prepareSpeech, playSpeech, clearSpeechFailure,
      soundOn, onRunStarted, t, message])

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
        patchBoard(res.run)
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
  }, [run, currentQ, selected, busy, reveal, session, refreshBoard, soundOn, t, message, patchBoard])

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
      const init: LadderVotePanel = {}
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
      if (r.score_after != null) {
        message.info(t('lifelineScoreAfter', { score: r.score_after }))
        patchBoard({ ...run, ladder_score: r.score_after })
      }
      if (soundOn) ladderSound.lifeline()
    } catch (e: any) {
      message.error(String(e?.response?.data?.detail || t('lifelineFailed')))
    } finally { setBusy(false) }
  }, [run, currentQ, soundOn, t, message, patchBoard])

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
  }, [run, votePanel, soundOn, t, message])

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

  return {
    run, currentQ, selected, reveal, hiddenKeys, busy, rolling, rollName, remaining,
    lfModal, setLfModal, votePanel, setVotePanel, result, setResult, setSelected,
    doOpenRun, doSubmit, doLifeline, submitClassVote, resetRun,
  }
}

export type LadderRunApi = ReturnType<typeof useLadderRun>
