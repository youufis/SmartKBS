/**
 * QuestBattlePage — 知识闯关·答题对战页面
 * 倒计时、锦囊、答题、即时反馈（纯 div 布局，避免 antd Col 类型问题）
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Card, Button, Typography, Space, Tag, Progress, Modal, Spin, Dropdown } from 'antd'
import { message, modalApi } from '../utils/feedback'
import {
  ThunderboltOutlined, CloseCircleOutlined, CheckCircleOutlined,
  ClockCircleOutlined, PhoneOutlined, TeamOutlined,
  DeleteOutlined, TrophyOutlined, LogoutOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import apiClient from '../api/client'
import { useIsMobile } from '../hooks/useIsMobile'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import { useTranslation, Trans } from 'react-i18next'
import { reportLoadError } from '../utils/loadError'

const { Title, Text, Paragraph } = Typography

interface QuestionData {
  sort_order: number
  category: string
  question_text: string
  options: Record<string, string>
  explanation: string
  lifeline_used?: string
  lifeline_data?: any
  correct_answer?: string
  svg_content?: string
  has_svg?: number
  media_files?: string
  media_placeholders?: string
}

interface QuestInfo {
  answered_count: number
  correct_count: number
  score: number
  current_question_index: number
  total_questions: number
  lifelines_used: string[]
  completed: number
  lives_left?: number
}

const TIMER_SECONDS = 30

const CATEGORY_COLORS: Record<string, string> = {
  '文学': '#eb2f96', '历史': '#fa8c16', '地理': '#52c41a',
  '科技': '#1677ff', '天文': '#722ed1', '自然科学': '#13c2c2',
  '人物传记': '#fa541c', '艺术': '#f5222d', '体育': '#faad14',
  '生活常识': '#2f54eb', '传统文化': '#a0d911', '时事百科': '#08979c',
}

const LIFELINE_ICONS: Record<string, React.ReactNode> = {
  remove_one: <DeleteOutlined />,
  phone_friend: <PhoneOutlined />,
  audience_vote: <TeamOutlined />,
}

const QuestBattlePage: React.FC = () => {
  const { t } = useTranslation('questions')
  const isMobile = useIsMobile()
  const { questId } = useParams<{ questId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const initialData = (location.state as any)?.initialData

  // 锦囊名称走 i18n（原来硬编码中文+emoji）
  const lifelineNames = useMemo<Record<string, string>>(() => ({
    remove_one: t('lifelineRemoveOne'),
    phone_friend: t('lifelinePhoneFriend'),
    audience_vote: t('lifelineAudienceVote'),
  }), [t])

  const [question, setQuestion] = useState<QuestionData | null>(null)
  const [questInfo, setQuestInfo] = useState<QuestInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [answering, setAnswering] = useState(false)
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null)
  const [showResult, setShowResult] = useState(false)
  const [isCorrect, setIsCorrect] = useState(false)
  const [terminated, setTerminated] = useState(false)
  const [timer, setTimer] = useState(TIMER_SECONDS)
  const [lifelineData, setLifelineData] = useState<any>(null)
  const [lifelineModal, setLifelineModal] = useState(false)
  const [usedLifelines, setUsedLifelines] = useState<string[]>([])
  const [removedOption, setRemovedOption] = useState<string | null>(null)
  // 判后讲解：/answer 才返回正确项与解析（题面不再提前携带，防作答前偷看）
  const [revealInfo, setRevealInfo] = useState<{ correctAnswer: string; correctAnswerText: string; explanation: string } | null>(null)
  // 限时秒数以服务端 /quest/config 为准（旧版前端硬编码 30 秒）
  const [limitSec, setLimitSec] = useState(TIMER_SECONDS)
  const [baseScores, setBaseScores] = useState<number[]>([])
  // M2：题量/生命数跟随服务端配置（E8）；dots 记录每题对错供进度点
  const [maxQ, setMaxQ] = useState(15)
  const [lives, setLives] = useState<number | null>(null)
  const [lives0, setLives0] = useState(3)
  const [dots, setDots] = useState<Record<number, 0 | 1>>({})
  const deadlineRef = useRef(0)

  // 审查修 TDZ：handleTimeout 定义在 loadQuestion 之前，经 ref 间接调用避免暂时性死区崩溃
  const loadQuestionRef = useRef<() => void>(() => {})
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMountedRef = useRef(true)
  const answeringRef = useRef(false)
  const terminatedRef = useRef(false)

  useEffect(() => { answeringRef.current = answering }, [answering])
  useEffect(() => { terminatedRef.current = terminated }, [terminated])

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 计时以服务端 remaining 起表（旧版每次都在本地重放 30 秒，刷新即续命）
  const startTimer = useCallback((seconds?: number) => {
    stopTimer()
    const sec = Math.max(0, seconds ?? limitSec)
    setTimer(Math.ceil(sec))
    deadlineRef.current = Date.now() + sec * 1000
    timerRef.current = setInterval(() => {
      const left = Math.max(0, (deadlineRef.current - Date.now()) / 1000)
      setTimer(Math.ceil(left))
      if (left <= 0 && timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }, 250)
  }, [stopTimer, limitSec])

  // M2/C1：推进到下一题——答对、答错有命、超时有命共用同一条链
  const advanceWith = useCallback((data: any) => {
    setQuestInfo((prev) => prev ? {
      ...prev,
      answered_count: (prev.answered_count || 0) + 1,
      correct_count: (prev.correct_count || 0) + (data.is_correct ? 1 : 0),
      score: data.total_score ?? prev.score,
      current_question_index: data.next_question.sort_order,
    } : prev)
    setTimeout(() => {
      if (isMountedRef.current) {
        setQuestion(data.next_question)
        setSelectedAnswer(null)
        setShowResult(false)
        setRevealInfo(null)
        setLifelineData(null)
        setRemovedOption(null)
        startTimer(typeof data.remaining === 'number' ? data.remaining : undefined)
      }
    }, 2500)
  }, [startTimer])

  const handleTimeout = useCallback(async () => {
    if (answeringRef.current || terminatedRef.current) return
    setAnswering(true)
    try {
      const { data } = await apiClient.post(`/api/quest/${questId}/timeout`)
      if (data.ignored) {
        // 审查修 B：服务端说还没到——按剩余时间重启倒计时；已作答——直接同步到当前题
        if (data.answered) { loadQuestionRef.current() } else if (typeof data.remaining === 'number' && data.remaining > 0) { startTimer(data.remaining) }
        return
      }
      if (typeof data.lives_left === 'number') setLives(data.lives_left)
      if (data.terminated) {
        setTerminated(true)
        setShowResult(true)
        setIsCorrect(false)
        setRevealInfo({
          correctAnswer: data.correct_answer || '',
          correctAnswerText: data.correct_answer_text || '',
          explanation: data.explanation || '',
        })
        setTimeout(() => {
          if (isMountedRef.current) navigate(`/quest/result/${questId}`)
        }, 3500)
      } else if (data.next_question && data.next_question.sort_order) {
        // M2 三命制：超时按答错扣一命，命未尽则讲评后继续
        setShowResult(true)
        setIsCorrect(false)
        setRevealInfo({
          correctAnswer: data.correct_answer || '',
          correctAnswerText: data.correct_answer_text || '',
          explanation: data.explanation || '',
        })
        setDots((prev) => ({ ...prev, [(data.next_question.sort_order || 1) - 1]: 0 }))
        advanceWith(data)
      }
    } catch (err) { reportLoadError(err, { key: 'quest.timeout' }) } finally {
      setAnswering(false)
    }
  }, [questId, navigate, advanceWith, startTimer])

  useEffect(() => {
    if (timer === 0 && !answeringRef.current && !terminatedRef.current) {
      handleTimeout()
    }
  }, [timer, handleTimeout])

  const loadQuestion = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get(`/api/quest/${questId}/question`, { timeout: 60000 })
      setQuestion(data)
      // 刷新恢复：服务端随题面带回比分/已用锦囊（旧版刷新后 questInfo 缺失直接丢局）
      if (data.quest_info) setQuestInfo(data.quest_info)
      if (typeof data.quest_info?.lives_left === 'number') setLives(data.quest_info.lives_left)
      if (typeof data.quest_info?.total_questions === 'number' && data.quest_info.total_questions > 0) setMaxQ(data.quest_info.total_questions)
      if (Array.isArray(data.quest_info?.lifelines_used)) setUsedLifelines(data.quest_info.lifelines_used)
      setSelectedAnswer(null)
      setShowResult(false)
      setRevealInfo(null)
      setLifelineData(null)
      setRemovedOption(null)
      const rem = typeof data.remaining === 'number' ? data.remaining : undefined
      startTimer(rem)
      // M2/D5：刷新恢复时明说剩余时间（计时走服务端真值，不是 bug）
      if (typeof rem === 'number' && rem > 0 && rem < limitSec - 2) {
        message.info(t('quest.resumeSynced', { sec: Math.ceil(rem) }))
      }
    } catch {
      navigate('/quest')
    } finally {
      setLoading(false)
    }
  }, [questId, navigate, startTimer, limitSec, t])

  useEffect(() => { loadQuestionRef.current = loadQuestion }, [loadQuestion])

  const handleAnswer = useCallback(async (answer: string) => {
    if (answeringRef.current || showResult || terminatedRef.current || timer <= 0) return
    setAnswering(true)
    setSelectedAnswer(answer)
    stopTimer()

    try {
      const { data } = await apiClient.post(`/api/quest/${questId}/answer`, {
        answer,
        // A1：声明所答题号，服务端拒绝错序/重放请求（双击不再误杀下一题）
        sort_order: question?.sort_order,
      }, { timeout: 90000 })

      if (data.replay) {
        // 幂等回放：本题早已结算（响应丢失后的重发）——回到服务端当前题，不重复处理
        void loadQuestion()
        return
      }

      setIsCorrect(data.is_correct)
      setShowResult(true)
      // 判后讲解改为取 /answer 返回值：题面已不带解析（旧版在下一题载荷里提前泄露）
      setRevealInfo({
        correctAnswer: data.correct_answer || '',
        correctAnswerText: data.correct_answer_text || '',
        explanation: data.explanation || '',
      })

      // M2/C1：服务端回传生命与本题结果（进度点用）
      if (typeof data.lives_left === 'number') setLives(data.lives_left)
      setDots((prev) => (question ? { ...prev, [question.sort_order]: data.is_correct ? 1 : 0 } : prev))

      if (data.terminated) {
        setTerminated(true)
        setQuestInfo((prev) => prev ? { ...prev, score: data.total_score ?? prev.score } : prev)
        setTimeout(() => {
          if (isMountedRef.current) navigate(`/quest/result/${questId}`)
        }, 3500)
      } else if (data.next_question && data.next_question.sort_order) {
        // 答对或"答错但仍有命"：讲评 2.5s 后推进下一题
        advanceWith(data)
      } else if (data.next_question) {
        // 三轮审查加固：异常推进载荷（缺题面）→ 直接同步服务端，不落入空题死状态
        loadQuestionRef.current()
      } else if (data.completed) {
        setTerminated(true)
        setTimeout(() => {
          if (isMountedRef.current) navigate(`/quest/result/${questId}`)
        }, 3500)
      }
    } catch (e: any) {
      if (e?.response?.status === 409) {
        // 服务端已推进到下一题（连点/重发被拒）：同步回当前题，不惩罚学生
        message.warning(t('quest.answerStaleSync'))
        void loadQuestion()
      } else {
        message.error(e?.response?.data?.detail || t('quest.submitFailed'))
      }
    } finally {
      setAnswering(false)
    }
  }, [questId, navigate, timer, showResult, stopTimer, question, advanceWith, loadQuestion])

  const handleLifeline = useCallback(async (type: string) => {
    if (answeringRef.current || showResult || terminatedRef.current) return
    if (usedLifelines.includes(type)) {
      message.warning(t('quest.lifelineUsed', { name: lifelineNames[type] }))
      return
    }
    setAnswering(true)
    try {
      const { data } = await apiClient.post(`/api/quest/${questId}/lifeline`, { type }, { timeout: 60000 })
      setUsedLifelines((prev) => [...prev, type])
      if (typeof data.discount === 'number' && data.discount < 1) {
        message.info(t('quest.lifelineDiscountMsg', { name: lifelineNames[type], pct: Math.round(data.discount * 100) }), 4)
      }
      if (type === 'remove_one') {
        setRemovedOption(data.removed_option)
        if (question) {
          setQuestion({ ...question, options: data.remaining_options })
        }
      } else if (type === 'phone_friend') {
        setLifelineData({ type: 'phone_friend', advice: data.advice })
        setLifelineModal(true)
      } else if (type === 'audience_vote') {
        setLifelineData({ type: 'audience_vote', votes: data.votes })
        setLifelineModal(true)
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('quest.lifelineFailed'))
    } finally {
      setAnswering(false)
    }
  }, [questId, question, usedLifelines, showResult, terminated, lifelineNames])

  useEffect(() => {
    isMountedRef.current = true
    apiClient.get('/api/quest/config')
      .then(({ data }) => {
        if (typeof data?.time_limit_sec === 'number') setLimitSec(data.time_limit_sec)
        if (Array.isArray(data?.base_scores)) setBaseScores(data.base_scores)
        if (typeof data?.max_questions === 'number' && data.max_questions > 0) setMaxQ(data.max_questions)
        if (typeof data?.lives === 'number' && data.lives > 0) { setLives0(data.lives); setLives((prev) => prev ?? data.lives) }
      })
      .catch(() => {})
    if (initialData) {
      setQuestion(initialData.question)
      setQuestInfo(initialData.quest_info)
      if (typeof initialData.quest_info?.lives_left === 'number') setLives(initialData.quest_info.lives_left)
      if (typeof initialData.quest_info?.total_questions === 'number' && initialData.quest_info.total_questions > 0) setMaxQ(initialData.quest_info.total_questions)
      setUsedLifelines(Array.isArray(initialData.quest_info?.lifelines_used) ? initialData.quest_info.lifelines_used : [])
      startTimer(typeof initialData.question?.remaining === 'number' ? initialData.question.remaining : undefined)
      setLoading(false)
    } else if (questId) {
      loadQuestion()
    }
    return () => {
      isMountedRef.current = false
      stopTimer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questId])

  const getTimerColor = () => {
    if (limitSec <= 0) return '#52c41a'
    const ratio = timer / limitSec
    if (ratio > 0.4) return '#52c41a'
    if (ratio > 0.2) return '#faad14'
    return '#ff4d4f'
  }

  // 键盘作答：数字 1-9 直接选答案提交（与大屏闯关同一手感）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
      const opts = question?.options ? Object.keys(question.options) : []
      if (/^[1-9]$/.test(e.key)) {
        const pick = opts[Number(e.key) - 1]
        if (pick && !showResult && !terminatedRef.current && !answeringRef.current) {
          void handleAnswer(pick)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [question, showResult, handleAnswer])

  const getScoreForCurrent = () => {
    if (!questInfo) return 0
    const idx = questInfo.current_question_index || 1
    // 分值阶梯以服务端配置为真值，本地数组仅作兜底
    if (baseScores.length >= idx) return baseScores[idx - 1]
    const baseScore = [0, 10, 15, 15, 20, 20, 20, 25, 25, 25, 30, 30, 30, 50, 50, 50]
    return baseScore[idx] || 10
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70dvh' }}>
        <Spin size="large" description={t('loading')} />
      </div>
    )
  }

  if (!question || !questInfo) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 120 }}>
        <Title level={4}>{t('quest.loadFailed')}</Title>
        <Button type="primary" onClick={() => navigate('/quest')}>{t('quest.backBtn')}</Button>
      </div>
    )
  }

  const options = question.options || {}
  const currentIdx = questInfo.current_question_index || 1
  const timerPercent = (timer / (limitSec || TIMER_SECONDS)) * 100

  return (
    // 本页挂在 AppLayout 之外：没有内容区那层 padding，窄屏必须自己给，
    // 否则卡片直接贴屏幕边（实测 390px 下左右各 0px）。
    // 收窄与居中只写在 mobile.css 里，桌面的整屏版式一点不动（红线）。
    <div className="battle-page">
      <style>{`
        @keyframes battleTimerPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,77,79,0); } 50% { box-shadow: 0 0 0 6px rgba(255,77,79,.25); } }
        .battle-timer-danger { animation: battleTimerPulse 1s ease-in-out infinite; }
        @keyframes battleFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        .battle-q-fade { animation: battleFadeIn .35s ease; }
      `}</style>
      {/* ── 顶部状态栏 ── */}
      <Card
        style={{ borderRadius: 12, marginBottom: 16, background: 'var(--bg-layout)' }}
        styles={{ body: { padding: '12px 16px' } }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 20, flex: 1, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('quest.round')}</div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                <ThunderboltOutlined style={{ marginRight: 4 }} />
                {currentIdx} / {questInfo.total_questions}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('quest.livesTitle')}</div>
              <div style={{ fontSize: 15, letterSpacing: 1 }} title={t('quest.livesHint')}>
                {Array.from({ length: lives0 }, (_, i) => (
                  <span key={i} style={{ opacity: i < (lives ?? lives0) ? 1 : 0.25, marginRight: 2 }}>❤️</span>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('score')}</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#faad14' }}>
                <TrophyOutlined style={{ marginRight: 4 }} />
                {questInfo.score}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('quest.totalCorrect')}</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#52c41a' }}>
                <CheckCircleOutlined style={{ marginRight: 4 }} />
                {questInfo.correct_count}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {isMobile ? (
              /* M2/D2：窄屏锦囊收进一个入口，不再两排挤压题面 */
              <Dropdown
                trigger={['click']}
                menu={{
                  items: Object.entries(lifelineNames).map(([key, name]) => ({
                    key,
                    icon: LIFELINE_ICONS[key],
                    label: usedLifelines.includes(key) ? name + '（' + t('quest.lifelineUsedTag') + '）' : name,
                    disabled: usedLifelines.includes(key) || answering || showResult || terminated,
                    onClick: () => handleLifeline(key),
                  })),
                }}
              >
                <Button size="small" type="primary" ghost disabled={answering || showResult || terminated}>
                  {t('quest.lifelineGroup', { left: 3 - usedLifelines.length })}
                </Button>
              </Dropdown>
            ) : (
              Object.entries(lifelineNames).map(([key, name]) => (
                <Button
                  key={key}
                  type={usedLifelines.includes(key) ? 'default' : 'primary'}
                  ghost={!usedLifelines.includes(key)}
                  disabled={usedLifelines.includes(key) || answering || showResult || terminated}
                  icon={LIFELINE_ICONS[key]}
                  onClick={() => handleLifeline(key)}
                  size="small"
                  style={{ opacity: usedLifelines.includes(key) ? 0.4 : 1 }}
                >
                  {name}
                </Button>
              ))
            )}
            {/* M2/D1：显式放弃，不再靠浏览器后退留僵尸局 */}
            <Button
              size="small"
              type="text"
              danger
              icon={<LogoutOutlined />}
              disabled={terminated}
              onClick={() => modalApi.confirm({
                title: t('quest.confirmAbandonTitle'),
                content: t('quest.confirmAbandonDesc'),
                okText: t('quest.abandonOk'),
                cancelText: t('cancel'),
                okButtonProps: { danger: true },
                onOk: async () => {
                  try { await apiClient.post(`/api/quest/${questId}/abandon`) } catch { /* 已结束等情况照常返回 */ }
                  navigate(`/quest/result/${questId}`)
                },
              })}
            >
              {t('quest.abandonBtn')}
            </Button>
          </div>
        </div>
      </Card>

      {/* ── 倒计时 ── */}
      <Card
        className={timer <= 10 && timer > 0 && !showResult && !terminated ? 'battle-timer-danger' : ''}
        style={{
          borderRadius: 12, marginBottom: 16,
          border: `2px solid ${getTimerColor()}`,
          transition: 'border-color 0.3s',
        }}
        styles={{ body: { padding: '12px 16px' } }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ClockCircleOutlined style={{ fontSize: 24, color: getTimerColor() }} />
          <div style={{ flex: 1 }}>
            <Progress
              percent={timerPercent}
              showInfo={false}
              strokeColor={getTimerColor()}
              railColor="#f0f0f0"
              size="small"
            />
          </div>
          <div>
            <Text strong style={{ fontSize: 20, color: getTimerColor() }}>
              {timer}s
            </Text>
          </div>
        </div>
      </Card>

      {/* ── M2/D3：题量进度点（绿=答对 红=答错 蓝=当前 灰=未答） ── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, justifyContent: 'center' }}>
        {Array.from({ length: questInfo.total_questions || maxQ }, (_, i) => {
          const n = i + 1
          const r = dots[n]
          const cur = n === currentIdx && !terminated
          return (
            <span
              key={n}
              style={{
                width: 9, height: 9, borderRadius: '50%',
                background: r === 1 ? '#52c41a' : r === 0 ? '#ff4d4f' : cur ? '#1677ff' : '#d9d9d9',
                transform: cur ? 'scale(1.3)' : 'none',
                transition: 'all .2s',
              }}
            />
          )
        })}
      </div>

      {/* ── 题目卡片 ── */}
      <Card key={question.sort_order} className="battle-q-fade" style={{ borderRadius: 12, marginBottom: 16 }} styles={{ body: { padding: 24 } }}>
        {/* 分类标签 */}
        <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Tag
            color={CATEGORY_COLORS[question.category] || '#1677ff'}
            style={{ borderRadius: 12, padding: '2px 12px' }}
          >
            {question.category}
          </Tag>
          <Tag style={{ borderRadius: 12 }}>
            {t('quest.baseScore', { score: getScoreForCurrent() })}
          </Tag>
          {removedOption && <Tag color="red">{t('quest.optionRemoved', { option: removedOption })}</Tag>}
        </div>

        {/* 题目内容 */}
        <Title level={4} style={{ marginBottom: 12, lineHeight: 1.6 }}>
          {currentIdx}. <FormulaRenderer content={question.question_text} />
        </Title>

        {/* 配图 */}
        <MediaDisplay
          svgContent={question.svg_content}
          hasSvg={question.has_svg}
          mediaFiles={question.media_files}
        />

        {/* 选项 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {Object.entries(options).map(([key, value]) => {
            const isSelected = selectedAnswer === key
            let btnType: 'default' | 'primary' | 'dashed' = 'default'
            const btnStyle: React.CSSProperties = {
              height: 'auto', padding: '12px 16px', borderRadius: 10,
              textAlign: 'left', width: '100%', whiteSpace: 'normal',
              display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start',
            }

            if (showResult) {
              if (key === revealInfo?.correctAnswer) {
                btnType = 'primary'
                btnStyle.background = '#52c41a'
                btnStyle.borderColor = '#52c41a'
                btnStyle.color = '#fff'
              } else if (isSelected && !isCorrect) {
                btnType = 'primary'
                btnStyle.background = '#ff4d4f'
                btnStyle.borderColor = '#ff4d4f'
                btnStyle.color = '#fff'
              } else {
                btnStyle.opacity = 0.6
              }
            } else if (isSelected) {
              btnType = 'primary'
            }

            return (
              <Button
                key={key}
                type={btnType}
                style={btnStyle}
                disabled={showResult || terminated || answering}
                onClick={() => handleAnswer(key)}
                icon={
                  showResult && key === revealInfo?.correctAnswer
                    ? <CheckCircleOutlined />
                    : showResult && isSelected && !isCorrect
                      ? <CloseCircleOutlined />
                      : undefined
                }
              >
                <span style={{
                  flex: '0 0 auto', width: 26, height: 26, borderRadius: '50%',
                  background: 'rgba(0,0,0,0.05)', display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center', fontWeight: 700, marginTop: 1,
                }}>{key}</span>
                <span style={{ flex: '1 1 auto', minWidth: 0, marginLeft: 10 }}>
                  <FormulaRenderer content={value as string} inline />
                </span>
                <span style={{ flex: '0 0 auto', marginLeft: 8, fontSize: 11, opacity: 0.35 }}>
                  ⌨{Object.keys(options).indexOf(key) + 1}
                </span>
              </Button>
            )
          })}
        </div>

        {/* 反馈 */}
        {showResult && (
          <Card
            style={{
              marginTop: 16, borderRadius: 10,
              background: isCorrect ? '#f6ffed' : '#fff2f0',
              border: `1px solid ${isCorrect ? '#b7eb8f' : '#ffccc7'}`,
            }}
            styles={{ body: { padding: 12 } }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              {isCorrect
                ? <CheckCircleOutlined style={{ fontSize: 20, color: '#52c41a', marginTop: 2 }} />
                : <CloseCircleOutlined style={{ fontSize: 20, color: '#ff4d4f', marginTop: 2 }} />
              }
              <div>
                <Text strong style={{ fontSize: 16, color: isCorrect ? '#52c41a' : '#ff4d4f' }}>
                  {isCorrect ? t('quest.answerCorrect') : t('quest.answerWrong')}
                </Text>
                {!isCorrect && revealInfo?.correctAnswer && (
                  <div>
                    <Text>{t('quest.correctAnswerText', { answer: revealInfo.correctAnswer })}. </Text>
                    <FormulaRenderer content={revealInfo.correctAnswerText || (options[revealInfo.correctAnswer] as string) || ''} inline />
                  </div>
                )}
              </div>
            </div>
            {showResult && revealInfo?.explanation && (
              <div style={{ marginTop: 8, marginBottom: 0, color: 'var(--text-secondary)' }}>
                <Text type="secondary">💡 </Text>
                <FormulaRenderer content={revealInfo.explanation} />
              </div>
            )}
          </Card>
        )}

        {terminated && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <Text strong style={{ fontSize: 18, color: '#ff4d4f' }}>
              {t('quest.gameOver')}
            </Text>
          </div>
        )}
      </Card>

      {/* ── 锦囊弹窗 ── */}
      <Modal
        title={
          lifelineData?.type === 'phone_friend'
            ? t('quest.lifelinePhoneTitle')
            : t('quest.lifelineVoteTitle')
        }
        open={lifelineModal}
        onCancel={() => setLifelineModal(false)}
        footer={<Button type="primary" onClick={() => setLifelineModal(false)}>{t('quest.lifelineOk')}</Button>}
      >
        {lifelineData?.type === 'phone_friend' && (
          <div style={{ padding: 16, background: '#f6f8fa', borderRadius: 10 }}>
            <Text style={{ fontSize: 16, fontStyle: 'italic' }}>
              💬 &ldquo;{lifelineData.advice}&rdquo;
            </Text>
          </div>
        )}
        {lifelineData?.type === 'audience_vote' && lifelineData.votes && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Object.entries(lifelineData.votes).map(([key, val]: any) => {
              const colorIdx = ['A', 'B', 'C', 'D'].indexOf(key) % 6
              const colors = ['#ff4d4f', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1']
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 24, fontWeight: 700 }}>{key}</div>
                  <div style={{ flex: 1 }}>
                    <Progress percent={val} showInfo={false} strokeColor={colors[colorIdx]} size="small" />
                  </div>
                  <div style={{ width: 40, textAlign: 'right', fontWeight: 700 }}>{val}%</div>
                </div>
              )
            })}
          </div>
        )}
      </Modal>
    </div>
  )
}

export default QuestBattlePage
