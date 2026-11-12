/**
 * QuestBattlePage — 知识闯关·答题对战页面
 * 倒计时、锦囊、答题、即时反馈（纯 div 布局，避免 antd Col 类型问题）
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Card, Button, Typography, Space, Tag, Progress, Modal,
  Spin, message,
} from 'antd'
import {
  ThunderboltOutlined, CloseCircleOutlined, CheckCircleOutlined,
  ClockCircleOutlined, PhoneOutlined, TeamOutlined,
  DeleteOutlined, TrophyOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import apiClient from '../api/client'
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
  const deadlineRef = useRef(0)

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

  const handleTimeout = useCallback(async () => {
    if (answeringRef.current || terminatedRef.current) return
    setAnswering(true)
    try {
      const { data } = await apiClient.post(`/api/quest/${questId}/timeout`)
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
      }
    } catch (err) { reportLoadError(err, { key: 'quest.timeout' }) } finally {
      setAnswering(false)
    }
  }, [questId, navigate])

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
      if (Array.isArray(data.quest_info?.lifelines_used)) setUsedLifelines(data.quest_info.lifelines_used)
      setSelectedAnswer(null)
      setShowResult(false)
      setRevealInfo(null)
      setLifelineData(null)
      setRemovedOption(null)
      startTimer(typeof data.remaining === 'number' ? data.remaining : undefined)
    } catch {
      navigate('/quest')
    } finally {
      setLoading(false)
    }
  }, [questId, navigate, startTimer])

  const handleAnswer = useCallback(async (answer: string) => {
    if (answeringRef.current || showResult || terminatedRef.current || timer <= 0) return
    setAnswering(true)
    setSelectedAnswer(answer)
    stopTimer()

    try {
      const { data } = await apiClient.post(`/api/quest/${questId}/answer`, {
        answer,
      }, { timeout: 90000 })

      setIsCorrect(data.is_correct)
      setShowResult(true)
      // 判后讲解改为取 /answer 返回值：题面已不带解析（旧版在下一题载荷里提前泄露）
      setRevealInfo({
        correctAnswer: data.correct_answer || '',
        correctAnswerText: data.correct_answer_text || '',
        explanation: data.explanation || '',
      })

      if (data.terminated || data.reason === 'timeout') {
        setTerminated(true)
        setQuestInfo((prev) => prev ? { ...prev, score: data.total_score || 0 } : prev)
        setTimeout(() => {
          if (isMountedRef.current) navigate(`/quest/result/${questId}`)
        }, 3500)
      } else if (data.next_question) {
        setQuestInfo((prev) => prev ? {
          ...prev,
          answered_count: (prev.answered_count || 0) + 1,
          correct_count: (prev.correct_count || 0) + 1,
          score: data.total_score,
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
      } else if (data.completed) {
        setTerminated(true)
        setTimeout(() => {
          if (isMountedRef.current) navigate(`/quest/result/${questId}`)
        }, 3500)
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('quest.submitFailed'))
    } finally {
      setAnswering(false)
    }
  }, [questId, navigate, timer, showResult, stopTimer, startTimer])

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
    apiClient.get('/quest/config')
      .then(({ data }) => {
        if (typeof data?.time_limit_sec === 'number') setLimitSec(data.time_limit_sec)
        if (Array.isArray(data?.base_scores)) setBaseScores(data.base_scores)
      })
      .catch(() => {})
    if (initialData) {
      setQuestion(initialData.question)
      setQuestInfo(initialData.quest_info)
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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(lifelineNames).map(([key, name]) => (
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
            ))}
          </div>
        </div>
      </Card>

      {/* ── 倒计时 ── */}
      <Card
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
              trailColor="#f0f0f0"
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

      {/* ── 题目卡片 ── */}
      <Card style={{ borderRadius: 12, marginBottom: 16 }} styles={{ body: { padding: 24 } }}>
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
                <Text strong style={{ fontSize: 16, marginRight: 8 }}>{key}.</Text>
                <FormulaRenderer content={value as string} inline />
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
