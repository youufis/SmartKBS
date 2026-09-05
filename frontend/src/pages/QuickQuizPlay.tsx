/**
 * QuickQuizPlay — 抢答答题界面（学生端）
 * 实时显示题目、倒计时、提交答案、查看结果
 */
import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Card, Button, Typography, Space, Progress, message, Spin,
} from 'antd'
import {
  ThunderboltOutlined, ClockCircleOutlined, CheckCircleOutlined,
  CloseCircleOutlined, TrophyOutlined,
  TeamOutlined, HomeOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'

const { Title, Text } = Typography

interface QuestionData {
  sort_order: number
  question_text: string
  options: Record<string, string>
  time_limit: number
  total_questions: number
  svg_content?: string
  has_svg?: number
  media_files?: string
  media_placeholders?: string
}

interface RankingEntry {
  rank: number
  student_name: string
  total_score: number
  correct_count: number
  wrong_count?: number
}

const QuickQuizPlay: React.FC = () => {
  const { t } = useTranslation('interaction')
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)

  const [question, setQuestion] = useState<QuestionData | null>(null)
  const [timer, setTimer] = useState(15)
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null)
  const [answered, setAnswered] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [ranking, setRanking] = useState<RankingEntry[]>([])
  const [phase, setPhase] = useState<'waiting' | 'question' | 'reveal' | 'ended'>('waiting')
  const [myTotalScore, setMyTotalScore] = useState(0)
  const [answeredCount, setAnsweredCount] = useState(0)
  const [totalPlayers, setTotalPlayers] = useState(0)
  const [showFullRanking, setShowFullRanking] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const answeredRef = useRef(false)
  const reconnectRef = useRef(false)

  useEffect(() => { answeredRef.current = answered }, [answered])

  const connectWebSocket = () => {
    if (!roomId) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = localStorage.getItem('smartkb_token') || ''
    // S1: WS 现在必须带有效 token, 无凭证时不再反复重连(旧代码会 3 秒一次无限重试)
    if (!token) {
      console.warn('[quick-quiz] 缺少登录凭证, 跳过 WebSocket 连接')
      return
    }
    const wsUrl = `${protocol}//${window.location.host}/api/ws/quick-quiz/${roomId}?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'register',
        data: { username: user?.username || '' }
      }))
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        handleWsMessage(msg)
      } catch { /* ignore */ }
    }

    ws.onclose = () => {
      if (!reconnectRef.current) {
        reconnectRef.current = true
        setTimeout(connectWebSocket, 3000)
      }
    }

    ws.onerror = () => ws.close()
  }

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stoppedRef = useRef(false)
  const lastQuestionRef = useRef(0) // 追踪已显示的最新题号，用于轮询检测新题

  const startTimer = useCallback((limit: number) => {
    if (timerRef.current) clearInterval(timerRef.current)
    setTimer(limit)
    timerRef.current = setInterval(() => {
      setTimer((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }, [])

  const doPoll = useCallback(async () => {
    try {
      const { data } = await apiClient.get(`/api/quick-quiz/room/${roomId}/current-question`)
      // 检测游戏是否已结束
      if (data.phase === 'ended' || data.phase === 'end') {
        navigate(`/quick-quiz/result/${roomId}`, { replace: true })
        return
      }
      // 检测是否有新题目（比较题号，不受 stoppedRef 影响）
      if (data.question && data.current_question !== lastQuestionRef.current) {
        lastQuestionRef.current = data.current_question
        setQuestion(data.question)
        setTimer(data.question.time_limit || 15)
        setPhase('question')
        setAnswered(false)
        setSelectedAnswer(null)
        setResult(null)
        startTimer(data.question.time_limit || 15)
      }
    } catch (err: any) {
      // 房间被删除时返回 404，跳回主页
      if (err?.response?.status === 404) {
        message.warning(t('quizDeletedByTeacher'))
        navigate('/quick-quiz', { replace: true })
      }
    }
  }, [roomId, startTimer, navigate])

  // 组件挂载时启动轮询（不直接调用 doPoll，由 interval 触发）
  useEffect(() => {
    stoppedRef.current = false
    pollTimerRef.current = setInterval(doPoll, 1000)
    return () => {
      stoppedRef.current = true
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [doPoll])

  const loadRoomInfo = async () => {
    try {
      const { data } = await apiClient.get(`/api/quick-quiz/room/${roomId}`)
      if (data.status === 'ended') {
        navigate(`/quick-quiz/result/${roomId}`, { replace: true })
        return
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail || ''
      if (detail.includes('无权')) {
        setErrorMsg(t('qqNoPerm'))
        message.error(t('noPermissionToEnter'))
      } else if (err?.response?.status === 404) {
        setErrorMsg(t('qqRoomNotFound'))
        message.error(t('roomNotFound'))
      } else {
        setErrorMsg(t('qqLoadRoomFail'))
      }
    }
  }

  // WebSocket + 加载（放在函数定义之后，避免 hoisting 警告）
  useEffect(() => {
    connectWebSocket()
    setTimeout(() => loadRoomInfo(), 0)
    return () => {
      if (wsRef.current) wsRef.current.close()
      if (timerRef.current) clearInterval(timerRef.current)
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  const handleWsMessage = (msg: any) => {
    switch (msg.type) {
      case 'game_start':
        setPhase('question')
        setMyTotalScore(0)
        setAnswered(false)
        setSelectedAnswer(null)
        setResult(null)
        break

      case 'new_question':
        lastQuestionRef.current = msg.data.sort_order
        setQuestion(msg.data)
        setTimer(msg.data.time_limit || 15)
        setPhase('question')
        setAnswered(false)
        setSelectedAnswer(null)
        setResult(null)
        setAnsweredCount(0)
        startTimer(msg.data.time_limit || 15)
        break

      case 'your_answer_result':
        setResult(msg.data)
        break

      case 'someone_answered':
        setAnsweredCount(msg.data.answered_count)
        setTotalPlayers(msg.data.total_players)
        // 所有人都答了但还没 reveal，当前端主动触发
        if (msg.data.all_answered && !answeredRef.current) {
          apiClient.post(`/api/quick-quiz/room/${roomId}/reveal`).catch(() => {})
        }
        break

      case 'answer_reveal':
        if (timerRef.current) clearInterval(timerRef.current)
        // 如果是最后一题，直接跳转到结果页
        if (msg.data.is_last) {
          navigate(`/quick-quiz/result/${roomId}`, { replace: true })
          return
        }
        setPhase('reveal')
        setRanking(msg.data.ranking || [])
        // 如果没有答过，显示正确答案
        if (!answered) {
          setResult({
            is_correct: false,
            correct_answer: msg.data.correct_answer,
          })
        }
        break

      case 'game_end':
        if (timerRef.current) clearInterval(timerRef.current)
        stoppedRef.current = true
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
        // 跳转到结果页
        navigate(`/quick-quiz/result/${roomId}`, { replace: true })
        break
    }
  }

  const getTimerColor = () => {
    if (!question?.time_limit) return '#52c41a'
    const ratio = timer / question.time_limit
    if (ratio > 0.5) return '#52c41a'
    if (ratio > 0.25) return '#faad14'
    return '#ff4d4f'
  }

  const handleAnswer = useCallback(async (answer: string) => {
    if (answeredRef.current || phase !== 'question') return
    setSelectedAnswer(answer)
    setAnswered(true)
    if (timerRef.current) clearInterval(timerRef.current)

    try {
      const { data } = await apiClient.post(`/api/quick-quiz/room/${roomId}/answer`, {
        answer,
        time_spent: (question?.time_limit || 15) - timer,
      })
      setResult({
        is_correct: data.is_correct,
        score: data.score,
        time_spent: data.time_spent,
        correct_answer: data.correct_answer,
      })
      setMyTotalScore(data.total_score)
      // 如果所有人都答完了，前端主动触发 reveal，直接拿下一题
      if (data.all_answered) {
        stoppedRef.current = false
        try {
          const res = await apiClient.post(`/api/quick-quiz/room/${roomId}/reveal`)
          // 如果是最后一题，直接跳转结果页
          if (res.data?.is_last) {
            navigate(`/quick-quiz/result/${roomId}`, { replace: true })
            return
          }
          const nq = res.data?.next_question
          if (nq) {
            lastQuestionRef.current = nq.sort_order
            // 直接从响应拿到下一题，立即显示，不等 WebSocket
            setQuestion(nq)
            setTimer(nq.time_limit || 15)
            setPhase('question')
            setAnswered(false)
            setSelectedAnswer(null)
            setResult(null)
            startTimer(nq.time_limit || 15)
            stoppedRef.current = true
          }
        } catch { /* 可能已被其他客户端触发 */ }
      }
    } catch (err: any) {
      message.error(err.response?.data?.detail || t('submitFailed'))
      setAnswered(false)
    }
  }, [roomId, timer, question, phase, startTimer, navigate])

  // 获取排名名次
  const getMyRank = () => {
    if (!ranking.length) return null
    const myName = user?.name || user?.username
    const found = ranking.find(r => r.student_name === myName)
    return found?.rank || null
  }

  if (errorMsg) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh', flexDirection: 'column' }}>
        <Text type="danger" style={{ fontSize: 18 }}>{errorMsg}</Text>
        <Button style={{ marginTop: 16 }} onClick={() => navigate('/quick-quiz')}>{t('qqBackHome')}</Button>
      </div>
    )
  }

  if (phase === 'reveal' && !result?.correct_answer && !question) {
    // 公布答案后、下一题到达前
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh', flexDirection: 'column' }}>
        <Spin size="large" />
        <div style={{ marginTop: 24 }}>
          <Text type="secondary">{t('qqWaitNext')}</Text>
        </div>
      </div>
    )
  }

  if (!question && phase !== 'ended') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh', flexDirection: 'column' }}>
        <Spin size="large" />
        <div style={{ marginTop: 24 }}>
          <Text type="secondary">{t('qqWaitQuestion')}</Text>
        </div>
      </div>
    )
  }

  const options = question?.options || {}
  const timerPercent = question?.time_limit ? (timer / question.time_limit) * 100 : 100
  const myRank = getMyRank()

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* 顶部状态栏 */}
      <Card style={{ borderRadius: 12, marginBottom: 16, background: '#fafafa' }}
        styles={{ body: { padding: '12px 16px' } }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <Space>
            <ThunderboltOutlined style={{ fontSize: 20, color: '#fa8c16' }} />
            <Text strong>
              {question ? t('qqProgress', { no: question.sort_order, total: question.total_questions }) : t('qqBuzzing')}
            </Text>
          </Space>
          <Space size={16}>
            <span>
              <TrophyOutlined style={{ color: '#faad14', marginRight: 4 }} />
              <Text strong style={{ color: '#faad14' }}>{myTotalScore}</Text> {t('fenUnit2')}
            </span>
            {myRank && (
              <span>
                <TeamOutlined style={{ color: '#1677ff', marginRight: 4 }} />
                <Text strong style={{ color: '#1677ff' }}>{t('qqRank', { no: myRank })}</Text>
              </span>
            )}
          </Space>
        </div>
      </Card>

      {/* 倒计时 */}
      <Card style={{
        borderRadius: 12, marginBottom: 16,
        border: phase === 'question' ? `2px solid ${getTimerColor()}` : '2px solid #d9d9d9',
        transition: 'border-color 0.3s',
      }} styles={{ body: { padding: '12px 16px' } }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ClockCircleOutlined style={{ fontSize: 24, color: getTimerColor() }} />
          <div style={{ flex: 1 }}>
            <Progress
              percent={timerPercent}
              showInfo={false}
              strokeColor={phase === 'question' ? getTimerColor() : '#d9d9d9'}
              trailColor="#f0f0f0"
              size="small"
            />
          </div>
          <Text strong style={{ fontSize: 20, color: getTimerColor(), minWidth: 50, textAlign: 'right' }}>
            {phase === 'question' ? `${timer}s` : '--'}
          </Text>
        </div>
      </Card>

      {/* 题目 */}
      {question && (
        <Card style={{ borderRadius: 12, marginBottom: 16 }} styles={{ body: { padding: 24 } }}>
          <Title level={4} style={{ marginBottom: 12, lineHeight: 1.6 }}>
            {question.sort_order}. <FormulaRenderer content={question.question_text} />
          </Title>

          {/* 配图（SVG + 万相图片） */}
          <MediaDisplay
            svgContent={question.svg_content}
            hasSvg={question.has_svg}
            mediaFiles={question.media_files}
          />

          {/* 选项 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Object.entries(options).map(([key, value]) => {
              const isSelected = selectedAnswer === key
              let btnType: 'default' | 'primary' = 'default'
              const btnStyle: React.CSSProperties = {
                height: 'auto', padding: '12px 16px', borderRadius: 10,
                textAlign: 'left', width: '100%', whiteSpace: 'normal',
              }

              if (phase === 'reveal' || (result && result.correct_answer)) {
                const correctAns = result?.correct_answer
                if (key === correctAns) {
                  btnType = 'primary'
                  btnStyle.background = '#52c41a'
                  btnStyle.borderColor = '#52c41a'
                  btnStyle.color = '#fff'
                } else if (isSelected && result && !result.is_correct) {
                  btnType = 'primary'
                  btnStyle.background = '#ff4d4f'
                  btnStyle.borderColor = '#ff4d4f'
                  btnStyle.color = '#fff'
                } else {
                  btnStyle.opacity = 0.5
                }
              } else if (isSelected) {
                btnType = 'primary'
              }

              return (
                <Button
                  key={key}
                  type={btnType}
                  style={btnStyle}
                  disabled={answered || phase !== 'question'}
                  onClick={() => handleAnswer(key)}
                  icon={
                    phase === 'reveal' && key === result?.correct_answer
                      ? <CheckCircleOutlined />
                      : phase === 'reveal' && isSelected && result && !result.is_correct
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

          {/* 答题反馈 */}
          {result && !result.correct_answer && result.is_correct !== undefined && (
            <Card style={{
              marginTop: 16, borderRadius: 10,
              background: result.is_correct ? '#f6ffed' : '#fff2f0',
              border: `1px solid ${result.is_correct ? '#b7eb8f' : '#ffccc7'}`,
            }} styles={{ body: { padding: 12 } }}>
              <Space>
                {result.is_correct
                  ? <CheckCircleOutlined style={{ fontSize: 20, color: '#52c41a' }} />
                  : <CloseCircleOutlined style={{ fontSize: 20, color: '#ff4d4f' }} />
                }
                <Text strong style={{ fontSize: 16, color: result.is_correct ? '#52c41a' : '#ff4d4f' }}>
                  {result.is_correct ? `\u2713 ${t('qqRight')} +${result.score}${t('fenUnit2')}` : '\u2717 ' + t('qqWrong')}
                </Text>
                {result.time_spent !== undefined && (
                  <Text type="secondary">{t('qqTimeUsed')}{result.time_spent}s</Text>
                )}
              </Space>
            </Card>
          )}

          {/* 公布答案后的解析 */}
          {phase === 'reveal' && result?.correct_answer && (
            <Card style={{
              marginTop: 12, borderRadius: 10,
              background: '#f6ffed',
              border: '1px solid #b7eb8f',
            }} styles={{ body: { padding: 12 } }}>
              <Space>
                <CheckCircleOutlined style={{ fontSize: 20, color: '#52c41a' }} />
                <Text strong>{t('qqCorrectAns')}{result.correct_answer}. </Text>
                <FormulaRenderer content={options[result.correct_answer] as string} inline />
              </Space>
            </Card>
          )}
        </Card>
      )}

      {/* 实时状态 */}
      {phase === 'question' && answeredCount > 0 && (
        <Card style={{ borderRadius: 12 }} size="small">
          <Space>
            <TeamOutlined />
            <Text>
              {t('qqAnsweredPrefix')}<Text strong>{answeredCount}</Text> / {totalPlayers || '?'} {t('qqPeopleUnit')}
              {result && result.is_correct && ' \u2705 ' + t('qqYouGotIt')}
            </Text>
          </Space>
        </Card>
      )}

      {/* 排行榜（简略） */}
      {phase === 'reveal' && ranking.length > 0 && (
        <Card title={t('qqRanking')} style={{ borderRadius: 12, marginTop: 16 }}
          extra={<Button size="small" type="link" onClick={() => setShowFullRanking(!showFullRanking)}>
            {showFullRanking ? t('qqCollapse') : t('qqViewAll')}
          </Button>}
        >
          {(showFullRanking ? ranking : ranking.slice(0, 5)).map((r, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 0', borderBottom: i < ranking.length - 1 ? '1px solid #f0f0f0' : 'none',
            }}>
              <Space>
                <Text strong style={{
                  width: 24, textAlign: 'center',
                  color: i === 0 ? '#ff4d4f' : i === 1 ? '#fa8c16' : i === 2 ? '#faad14' : '#666',
                }}>
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${r.rank}`}
                </Text>
                <Text strong>{r.student_name}</Text>
              </Space>
              <Space size={12}>
                <Text style={{ color: '#52c41a' }}>{r.correct_count} {t('qqRightUnit')}</Text>
                <Text strong style={{ color: '#faad14', fontSize: 16 }}>{r.total_score}</Text>
              </Space>
            </div>
          ))}
        </Card>
      )}

    </Card>
  )
}

export default QuickQuizPlay
