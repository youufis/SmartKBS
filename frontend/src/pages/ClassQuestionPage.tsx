/**
 * ClassQuestionPage — 课堂抽问（随机抽问）
 *
 * 课前热身 / 课中提问互动用的"大屏"页面：
 *   选年级 → 选班级 → 选知识点（课程知识点或手动输入）→ 抽题（题库优先，可开关 AI 生题）
 *   → 抽人（与智能点名同一套公平权重）→ 判定（答对 +5 / 答错 +2 / 跳过 0）→ 下一题，无限循环。
 *
 * 学生不使用自己的设备，本页只面向教师投屏；积分落现有积分表（教师积分 / 学生成长档案同源）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Card, Button, Space, Typography, Select, Switch, Tag, Empty, message,
  Divider, Segmented, Input, Popconfirm, Spin, Alert, Collapse, Tooltip,
} from 'antd'
import {
  AimOutlined, ThunderboltOutlined, CheckOutlined, ForwardOutlined,
  SoundOutlined, MutedOutlined, ReloadOutlined, RobotOutlined, DatabaseOutlined,
  EditOutlined, BulbOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import apiClient from '../api/client'
import useSubjectOptions from '../hooks/useSubjectOptions'
import FormulaRenderer from '../components/FormulaRenderer'
import { reportLoadError } from '../utils/loadError'
import {
  DrillConfig, DrillQuestion, DrillRecord,
  drawDrillQuestion, getDrillConfig, getDrillRecords, judgeDrillAnswer,
  pickDrillStudent, resetDrillSession,
} from '../api/classDrill'

const { Text } = Typography

/** 教师自己的播报偏好（与点名页分开记，互不影响） */
const SPEAK_PREF_KEY = 'class_drill_speak_on'

interface KpOption {
  value: string
  label: string
  subject: string
}

/**
 * 取选项的"作答键"：单选题是字母（A/B/C/D…），判断题就是「对 / 错」。
 * 题库来的选项文字带 "A. " 前缀，AI 来的也带；两处都按前缀取，取不到才退回序号字母。
 */
function optionKey(opt: string, idx: number, questionType: string): string {
  if (questionType === 'true_false') return String(opt || '').trim()
  const matched = String(opt || '').trim().match(/^([A-Ha-h])[.、．]/)
  return matched ? matched[1].toUpperCase() : String.fromCharCode(65 + idx)
}

/** 把课程树摊平成"知识点"下拉项（按课程名做区分，同名知识点只留一条） */
function flattenKnowledgePoints(courses: any[]): KpOption[] {
  const out: KpOption[] = []
  const seen = new Set<string>()
  const walk = (nodes: any[], courseName: string, subject: string) => {
    for (const node of nodes || []) {
      walk(node?.children || [], courseName, subject)
      for (const kp of node?.knowledge_points || []) {
        const name = String(kp?.name || '').trim()
        if (!name || seen.has(name)) continue
        seen.add(name)
        out.push({ value: name, label: `${name}（${courseName}）`, subject })
      }
    }
  }
  for (const course of courses || []) {
    walk(course?.chapters || [], String(course?.name || ''), String(course?.subject || ''))
  }
  return out
}

const ClassQuestionPage: React.FC = () => {
  const { t } = useTranslation('classQuestion')
  const { subjects } = useSubjectOptions()

  // ── 配置 ──
  const [config, setConfig] = useState<DrillConfig | null>(null)

  // ── 选择区 ──
  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [grade, setGrade] = useState('')
  const [cls, setCls] = useState('')
  const [subject, setSubject] = useState('')
  const [kpOptions, setKpOptions] = useState<KpOption[]>([])
  const [kpMode, setKpMode] = useState<'course' | 'manual'>('course')
  const [courseKp, setCourseKp] = useState('')
  const [manualKp, setManualKp] = useState('')
  const [questionType, setQuestionType] = useState('mixed')
  const [allowAi, setAllowAi] = useState(false)

  // ── 题目 ──
  const [question, setQuestion] = useState<DrillQuestion | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [showAnswer, setShowAnswer] = useState(false)
  const [usedIds, setUsedIds] = useState<number[]>([])

  // ── 抽人 ──
  const [studentNames, setStudentNames] = useState<string[]>([])
  const [displayName, setDisplayName] = useState('🎯')
  const [rolling, setRolling] = useState(false)
  const [picking, setPicking] = useState(false)
  const [lastPicked, setLastPicked] = useState('')

  // ── 作答（学生在台上/口播选一个，老师点提交 → 服务端判对错并计分） ──
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // ── 流水（顶部不再显示统计汇总，只留本次流水） ──
  const [records, setRecords] = useState<DrillRecord[]>([])
  const [lastPoints, setLastPoints] = useState<number | null>(null)

  // ── 语音播报 ──
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [speakOn, setSpeakOn] = useState(() => localStorage.getItem(SPEAK_PREF_KEY) !== '0')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speechRef = useRef<{ name: string; task: Promise<string | null> } | null>(null)
  const speakWarnedRef = useRef(false)

  const rollInterval = useRef<number | null>(null)
  const decelTimers = useRef<number[]>([])
  const frameRef = useRef(0)

  const topic = kpMode === 'manual' ? manualKp.trim() : courseKp
  const ready = Boolean(grade && cls && topic)

  const kpFiltered = useMemo(
    () => (subject ? kpOptions.filter((o) => o.subject === subject) : kpOptions),
    [kpOptions, subject],
  )

  const clearAllTimers = useCallback(() => {
    if (rollInterval.current) {
      clearInterval(rollInterval.current)
      rollInterval.current = null
    }
    decelTimers.current.forEach(clearTimeout)
    decelTimers.current = []
    speechRef.current = null
  }, [])

  useEffect(() => clearAllTimers, [clearAllTimers])
  useEffect(() => () => { audioRef.current?.pause() }, [])

  // ── 初始化：配置 / 年级 / 知识点 / TTS ──
  useEffect(() => {
    getDrillConfig().then((cfg) => {
      setConfig(cfg)
      setAllowAi(Boolean(cfg.ai_enabled))
    }).catch((e) => reportLoadError(e, { key: 'classdrill-config' }))

    apiClient.get('/api/rollcall/grades')
      .then(({ data }) => setGrades(Array.isArray(data) ? data : []))
      .catch((e) => reportLoadError(e, { key: 'classdrill-grades' }))

    apiClient.get('/api/curriculum/tree')
      .then(({ data }) => setKpOptions(flattenKnowledgePoints(Array.isArray(data) ? data : [])))
      .catch(() => { /* 知识点拿不到时仍可手动输入 */ })

    apiClient.get('/api/rollcall/speech-status')
      .then(({ data }) => setTtsEnabled(!!data?.enabled))
      .catch(() => {})
  }, [t])

  // ── 年级 → 班级 ──
  const loadClasses = useCallback(async (g: string) => {
    if (!g) { setClasses([]); return }
    try {
      const { data } = await apiClient.get('/api/rollcall/classes', { params: { grade: g } })
      setClasses(Array.isArray(data) ? data : [])
    } catch (e) {
      setClasses([])
      reportLoadError(e, { key: 'classdrill-classes' })
    }
  }, [])

  const loadStudents = useCallback(async (g: string, c: string) => {
    if (!g || !c) { setStudentNames([]); return }
    try {
      const { data } = await apiClient.get('/api/rollcall/students', { params: { grade: g, class: c } })
      setStudentNames((Array.isArray(data) ? data : []).map((s: { name: string }) => s.name))
    } catch {
      setStudentNames([])
    }
  }, [])

  const loadSession = useCallback(async (g: string, c: string) => {
    if (!g || !c) { setRecords([]); return }
    try {
      const data = await getDrillRecords(g, c)
      setRecords(data.records || [])
    } catch {
      setRecords([])
    }
  }, [])

  const handleGradeChange = (val: string) => {
    clearAllTimers()
    setGrade(val); setCls(''); setClasses([]); setStudentNames([])
    setRecords([])
    loadClasses(val)
  }

  const handleClassChange = (val: string) => {
    clearAllTimers()
    setCls(val)
    setDisplayName('🎯'); setLastPicked(''); setLastPoints(null)
    loadStudents(grade, val)
    loadSession(grade, val)
  }

  // 题库未入库的 AI 题没有 id，此时用题干做去重键
  const questionKey = (q: DrillQuestion): number | null => (q.id == null ? null : Number(q.id))

  // ── 抽题 ──
  const drawQuestion = useCallback(async () => {
    if (!ready) { message.warning(t('selectGradeClassKp')); return }
    setDrawing(true)
    try {
      const data = await drawDrillQuestion({
        grade, class: cls, subject,
        topic,
        question_type: questionType,
        allow_ai: allowAi,
        exclude_ids: usedIds,
      })
      setQuestion(data.question)
      setShowAnswer(false)
      setLastPoints(null)
      setSelectedIdx(null)
      setSubmitted(false)
      const key = questionKey(data.question)
      if (key != null) setUsedIds((prev) => (prev.includes(key) ? prev : [...prev, key]))
      if (data.source === 'ai') message.success(t('aiQuestionReady'))
    } catch (e: any) {
      const detail = e?.response?.data?.detail
      const timedOut = e?.code === 'ECONNABORTED'
      message.error(String(detail || (timedOut ? t('drawTimeout') : t('drawFailed'))), 6)
    } finally {
      setDrawing(false)
    }
  }, [ready, grade, cls, subject, topic, questionType, allowAi, usedIds, t])

  // ── 语音播报（复用点名接口） ──
  const requestSpeech = useCallback(async (name: string): Promise<string | null> => {
    try {
      const { data } = await apiClient.get('/api/rollcall/speech', {
        params: { grade, class: cls, name },
      })
      if (data?.ok && data.url) return String(data.url)
      if (!speakWarnedRef.current) {
        speakWarnedRef.current = true
        if (data?.disabled) setTtsEnabled(false)
        message.warning(String(data?.error || t('speakFailed')))
      }
      return null
    } catch {
      return null
    }
  }, [grade, cls, t])

  const playSpeech = useCallback(async (name: string) => {
    if (!ttsEnabled || !speakOn) return
    const pending = speechRef.current
    speechRef.current = null
    if (!pending || pending.name !== name) return
    const url = await Promise.race([
      pending.task, new Promise<null>((r) => window.setTimeout(() => r(null), 2000)),
    ])
    if (!url) return
    try {
      audioRef.current?.pause()
      const audio = new Audio(url)
      audioRef.current = audio
      await audio.play()
    } catch { /* 浏览器拦截自动播放：静默 */ }
  }, [ttsEnabled, speakOn])

  // ── 抽人（老虎机动画） ──
  const pickStudent = useCallback(async () => {
    if (!grade || !cls) { message.warning(t('selectGradeClass')); return }
    if (studentNames.length === 0) { message.warning(t('emptyClass')); return }
    setPicking(true)
    setLastPoints(null)
    // 换一名学生作答：清空上一轮的选择与答案揭示，避免下一位学生先看到答案
    setSelectedIdx(null)
    setSubmitted(false)
    setShowAnswer(false)
    clearAllTimers()
    speakWarnedRef.current = false

    const pool = studentNames
    setRolling(true)
    frameRef.current = 0
    rollInterval.current = window.setInterval(() => {
      setDisplayName(pool[frameRef.current % pool.length])
      frameRef.current++
    }, 50)

    try {
      const data = await pickDrillStudent(grade, cls)
      if (rollInterval.current) {
        clearInterval(rollInterval.current)
        rollInterval.current = null
      }
      speechRef.current = (ttsEnabled && speakOn)
        ? { name: data.student, task: requestSpeech(data.student) }
        : null

      const decelSteps = [
        { ms: 120, count: 8 }, { ms: 200, count: 5 }, { ms: 320, count: 3 },
        { ms: 480, count: 2 }, { ms: 700, count: 1 },
      ]
      let stepIdx = 0
      const doStep = () => {
        const step = decelSteps[stepIdx]
        if (!step) {
          setRolling(false)
          setDisplayName(data.student)
          setLastPicked(data.student)
          setPicking(false)
          playSpeech(data.student)
          return
        }
        let n = 0
        const timer = window.setInterval(() => {
          setDisplayName(pool[Math.floor(Math.random() * pool.length)])
          n++
          if (n >= step.count) {
            clearInterval(timer)
            stepIdx++
            const next = window.setTimeout(doStep, step.ms)
            decelTimers.current.push(next)
          }
        }, 60)
        decelTimers.current.push(timer as unknown as number)
      }
      doStep()
    } catch (e: any) {
      clearAllTimers()
      setRolling(false)
      setDisplayName('😅')
      setPicking(false)
      message.error(String(e?.response?.data?.detail || t('pickFailed')))
    }
  }, [grade, cls, studentNames, ttsEnabled, speakOn, requestSpeech, playSpeech, clearAllTimers, t])

  // ── 判定与计分 ──
  // 传 selected（学生所选项）时由**服务端**比答案判对错；只传 result 时是老师直接定判（跳过）。
  const judge = useCallback(async (
    payload: { selected?: string; result?: 'correct' | 'incorrect' | 'skip' },
  ): Promise<boolean> => {
    if (!lastPicked) { message.warning(t('pickFirst')); return false }
    try {
      const data = await judgeDrillAnswer({ grade, class: cls, student: lastPicked, ...payload })
      setLastPoints(data.points_added)
      setRecords((prev) => [{
        id: Date.now(), student_name: lastPicked,
        question_id: question?.id ?? null, question_type: question?.type || '',
        question_text: question?.question || '', options: question?.options || [],
        correct_answer: data.correct_answer || question?.answer || '',
        student_answer: data.student_answer || payload.selected || '',
        source: question?.source || '',
        result: data.result, points: data.points_added, created_at: new Date().toLocaleString(),
      }, ...prev])
      const label = data.result === 'correct' ? t('correctTxt')
        : data.result === 'incorrect' ? t('incorrectTxt') : t('skipTxt')
      message.success(`${lastPicked} ${label} +${data.points_added}`)
      return true
    } catch (e: any) {
      message.error(String(e?.response?.data?.detail || t('judgeFailed')))
      return false
    }
  }, [lastPicked, grade, cls, question, t])

  /** 提交作答：服务端判对错 → 自动公布答案并结算（答对 5 / 答错 2） */
  const submitAnswer = useCallback(async () => {
    if (!question) { message.warning(t('noQuestionYet')); return }
    if (selectedIdx === null) { message.warning(t('pickAnswerFirst')); return }
    if (!lastPicked) { message.warning(t('pickFirst')); return }
    setSubmitting(true)
    const ok = await judge({
      selected: optionKey(question.options[selectedIdx] || '', selectedIdx, question.type),
    })
    if (ok) {
      setSubmitted(true)
      setShowAnswer(true)
    }
    setSubmitting(false)
  }, [question, selectedIdx, lastPicked, judge, t])

  /** 跳过：0 分，保留题目给下一名学生 */
  const skipStudent = useCallback(async () => {
    const ok = await judge({ result: 'skip' })
    if (ok) { setSelectedIdx(null); setSubmitted(false) }
  }, [judge])

  const resetSession = useCallback(async () => {
    try {
      await resetDrillSession({ grade, class: cls, subject, topic, allow_ai: allowAi })
      clearAllTimers()
      setRecords([])
      setQuestion(null)
      setUsedIds([])
      setDisplayName('🎯'); setLastPicked(''); setLastPoints(null)
      message.success(t('resetDone'))
    } catch (e: any) {
      message.error(String(e?.response?.data?.detail || t('resetFailed')))
    }
  }, [grade, cls, subject, topic, allowAi, clearAllTimers, t])

  // ── 快捷键（大屏操作：老师可以全程用键盘） ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.key === ' ') { e.preventDefault(); if (!picking) pickStudent(); return }
      if (e.key === 'Enter') { e.preventDefault(); if (!submitting) submitAnswer(); return }
      if (e.key === '0') { skipStudent(); return }
      // 1-4 直接选中第 N 个选项（判断题就是 1=对、2=错）
      if (/^[1-9]$/.test(e.key) && question && !submitted) {
        const idx = Number(e.key) - 1
        if (idx < (question.options || []).length) { setSelectedIdx(idx); setShowAnswer(false) }
        return
      }
      if (e.key === 'n' || e.key === 'N') { if (!drawing) drawQuestion(); return }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [pickStudent, submitAnswer, skipStudent, drawQuestion, picking, drawing, submitting, question, submitted])

  const points = config?.points || { correct: 5, incorrect: 2, skip: 0 }

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
      <Card
        title={<Space><ThunderboltOutlined style={{ color: '#4fc3f7', fontSize: 20 }} /><span>{t('title')}</span>
          <Tag color="geekblue" style={{ fontSize: 11 }}>{t('subtitle')}</Tag></Space>}
        extra={
          <Space>
            <Popconfirm title={t('confirmReset')} onConfirm={resetSession} disabled={!grade || !cls}>
              <Button size="small" icon={<ReloadOutlined />} disabled={!grade || !cls}>{t('resetSession')}</Button>
            </Popconfirm>
          </Space>
        }
      >
        <Space wrap size={8}>
          <Select
            placeholder={t('selectGradePlaceholder')} value={grade || undefined}
            onChange={handleGradeChange} style={{ width: 120 }}
            options={grades.map((g) => ({ label: g, value: g }))}
          />
          <Select
            placeholder={t('selectClassPlaceholder')} value={cls || undefined}
            onChange={handleClassChange} style={{ width: 140 }}
            options={classes.map((c) => ({ label: c, value: c }))} disabled={!grade}
          />
          <Select
            placeholder={t('subjectPlaceholder')} value={subject || undefined}
            onChange={(v) => { setSubject(v || ''); setCourseKp('') }}
            style={{ width: 130 }} allowClear
            options={subjects.map((s) => ({ label: s, value: s }))}
          />
          <Segmented
            value={kpMode} onChange={(v) => setKpMode(v as 'course' | 'manual')}
            options={[{ label: t('kpModeCourse'), value: 'course' }, { label: t('kpModeManual'), value: 'manual' }]}
          />
          {kpMode === 'course' ? (
            <Select
              placeholder={t('kpPlaceholder')} value={courseKp || undefined}
              onChange={setCourseKp} style={{ width: 220 }}
              showSearch optionFilterProp="label" allowClear
              options={kpFiltered}
              notFoundContent={kpFiltered.length === 0 ? t('kpEmpty') : undefined}
            />
          ) : (
            <Input
              placeholder={t('kpManualPlaceholder')} value={manualKp}
              onChange={(e) => setManualKp(e.target.value)}
              style={{ width: 220 }} allowClear
            />
          )}
          <Select
            value={questionType} onChange={setQuestionType} style={{ width: 150 }}
            options={(config?.question_types || [
              { value: 'single', label: t('qtSingle') },
              { value: 'true_false', label: t('qtTrueFalse') },
              { value: 'mixed', label: t('qtMixed') },
            ]).map((o) => ({ label: o.value === 'single' ? t('qtSingle') : o.value === 'true_false' ? t('qtTrueFalse') : t('qtMixed'), value: o.value }))}
          />
          <Tooltip title={config && !config.ai_enabled ? t('aiDisabledByAdmin') : t('aiSwitchHint')}>
            <Space>
              <Switch
                checked={allowAi} disabled={!config?.ai_enabled}
                onChange={(v) => setAllowAi(v)}
              />
              <Text type={config?.ai_enabled ? undefined : 'secondary'}>
                <RobotOutlined /> {t('aiSwitch')}
              </Text>
            </Space>
          </Tooltip>
          <Tooltip title={ttsEnabled ? (speakOn ? t('speakOnHint') : t('speakOffHint')) : t('speakDisabledByAdmin')}>
            <Button
              size="large" disabled={!ttsEnabled}
              icon={speakOn && ttsEnabled ? <SoundOutlined /> : <MutedOutlined />}
              onClick={() => setSpeakOn((v) => {
                localStorage.setItem(SPEAK_PREF_KEY, v ? '0' : '1')
                return !v
              })}
            />
          </Tooltip>
        </Space>
      </Card>

      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={<Space><BulbOutlined />{t('questionCard')}</Space>}
        extra={question && (
          <Space>
            <Tag color={question.source === 'ai' ? 'purple' : 'blue'} icon={question.source === 'ai' ? <RobotOutlined /> : <DatabaseOutlined />}>
              {question.source === 'ai' ? t('sourceAi') : t('sourceBank')}
            </Tag>
            <Tag>{question.type === 'true_false' ? t('qtTrueFalse') : t('qtSingle')}</Tag>
          </Space>
        )}
      >
        {question ? (
          <div>
            <div style={{ fontSize: 26, lineHeight: 1.6, marginBottom: 16, fontWeight: 600 }}>
              <FormulaRenderer content={question.question} />
            </div>
            {/* 选项可直接点选：选中后点「提交作答」由服务端判对错（答对 +5 / 答错 +2） */}
            <Space orientation="vertical" style={{ width: '100%' }} size={10}>
              {(question.options || []).map((opt, i) => {
                const key = optionKey(opt, i, question.type)
                const active = selectedIdx === i
                const isCorrect = submitted
                  && key.toUpperCase() === String(question.answer || '').toUpperCase()
                return (
                  <div
                    key={i}
                    onClick={() => { if (!submitted) { setSelectedIdx(i); setShowAnswer(false) } }}
                    style={{
                      fontSize: 20, padding: '10px 16px', borderRadius: 10,
                      cursor: submitted ? 'default' : 'pointer',
                      border: `2px solid ${isCorrect ? '#52c41a' : active ? '#1677ff' : 'transparent'}`,
                      background: isCorrect ? '#f6ffed' : active ? '#e6f4ff' : 'var(--bg-layout, #fafafa)',
                      transition: 'all .15s', display: 'flex', alignItems: 'center', gap: 10,
                    }}
                  >
                    <span style={{ flex: 1 }}>{opt}</span>
                    {active && !submitted && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t('selectedTag')}</Tag>}
                    {isCorrect && <Tag color="green" style={{ marginInlineEnd: 0 }}>✓ {t('correctTxt')}</Tag>}
                  </div>
                )
              })}
            </Space>
            {showAnswer && (
              <div style={{ marginTop: 14 }}>
                <Alert
                  type="success" showIcon
                  message={<span style={{ fontSize: 18 }}>{t('answerIs')} <b>{question.answer}</b></span>}
                  description={question.explanation ? <FormulaRenderer content={question.explanation} /> : undefined}
                />
              </div>
            )}
          </div>
        ) : (
          <Empty description={t('noQuestionYet')} style={{ padding: '24px 0' }} />
        )}

        <Divider style={{ margin: '16px 0 12px' }} />
        {/* ── 操作条：抽题 / 抽人 / 提交作答 / 跳过（全在一行，大屏键盘也能走完） ── */}
        <Space wrap size="middle" align="center">
          <Button
            type="primary" size="large" loading={drawing} onClick={drawQuestion}
            disabled={!ready}
            style={{ height: 48, minWidth: 140, fontSize: 18, fontWeight: 600,
                     background: 'linear-gradient(135deg,#4fc3f7,#2196f3)', borderColor: '#4fc3f7' }}
          >
            {question ? t('nextQuestion') : t('drawQuestion')}
          </Button>
          <Button
            size="large" icon={<AimOutlined />} loading={picking}
            onClick={pickStudent} disabled={!grade || !cls}
            style={{ height: 48, minWidth: 120, fontSize: 18, fontWeight: 600 }}
          >
            {t('drawStudent')}
          </Button>
          <span style={{
            fontSize: rolling ? 30 : 36, fontWeight: 800, lineHeight: 1.1,
            minWidth: 140, textAlign: 'center',
            color: rolling ? '#4fc3f7' : lastPicked ? '#52c41a' : 'var(--text-tertiary, #8c8c8c)',
          }}>
            {displayName}
          </span>
          <Button
            type="primary" size="large" icon={<CheckOutlined />} loading={submitting}
            onClick={submitAnswer}
            disabled={!question || selectedIdx === null || !lastPicked || submitted}
            style={{ height: 48, minWidth: 150, fontSize: 18, fontWeight: 600,
                     background: 'linear-gradient(135deg,#66bb6a,#43a047)', borderColor: '#66bb6a' }}
          >
            {t('submitAnswer')}
          </Button>
          <Button size="large" icon={<ForwardOutlined />} disabled={!lastPicked}
            onClick={skipStudent} style={{ height: 48, minWidth: 100, fontSize: 16 }}>
            {t('skipBtn', { points: points.skip })}
          </Button>
          {lastPicked && lastPoints !== null && (
            <Text strong style={{ fontSize: 16, color: lastPoints > 0 ? '#52c41a' : 'var(--text-tertiary)' }}>
              {t('pointsAdded', { points: lastPoints })}
            </Text>
          )}
        </Space>
      </Card>

      {/* ── 本次流水 ── */}
      <Collapse
        items={[{
          key: 'records',
          label: <span><EditOutlined /> {t('records', { count: records.length })}</span>,
          children: records.length === 0 ? <Empty description={t('noRecords')} /> : (
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              {records.map((r, i) => (
                <div key={r.id ?? i} style={{
                  display: 'flex', gap: 12, alignItems: 'center', padding: '6px 10px', fontSize: 14,
                  borderRadius: 6, background: i % 2 === 0 ? 'rgba(0,0,0,0.02)' : 'transparent',
                }}>
                  <Text type="secondary" style={{ width: 26 }}>#{records.length - i}</Text>
                  <Text strong style={{ width: 90 }}>{r.student_name}</Text>
                  <Text type="secondary" style={{ fontSize: 12, width: 60 }}>
                    {r.question_type === 'true_false' ? t('qtTrueFalse') : t('qtSingle')}
                  </Text>
                  <Text ellipsis style={{ flex: 1, fontSize: 13 }} title={r.question_text}>{r.question_text}</Text>
                  <Tag color={r.result === 'correct' ? 'green' : r.result === 'incorrect' ? 'orange' : 'default'}>
                    {r.result === 'correct' ? t('correctTxt') : r.result === 'incorrect' ? t('incorrectTxt') : t('skipTxt')}
                  </Tag>
                  <span style={{ width: 44, textAlign: 'right', color: r.points > 0 ? '#52c41a' : 'var(--text-tertiary)', fontWeight: r.points > 0 ? 700 : 400 }}>
                    {r.points > 0 ? `+${r.points}` : '-'}
                  </span>
                </div>
              ))}
            </div>
          ),
        }]}
      />

      {drawing && <div style={{ textAlign: 'center' }}><Spin /> <Text type="secondary">{t('aiGenerating')}</Text></div>}
    </Space>
  )
}

export default ClassQuestionPage
