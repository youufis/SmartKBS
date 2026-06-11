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

const { Title, Text } = Typography

interface QuestionData {
  sort_order: number
  question_text: string
  options: Record<string, string>
  time_limit: number
  total_questions: number
}

interface RankingEntry {
  rank: number
  student_name: string
  total_score: number
  correct_count: number
  wrong_count?: number
}

const QuickQuizPlay: React.FC = () => {
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
    const wsUrl = `${protocol}//${window.location.host}/ws/quick-quiz/${roomId}`
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
      // 检测是否有新题目
      if (data.question && !stoppedRef.current) {
        setQuestion(data.question)
        setTimer(data.question.time_limit || 15)
        setPhase('question')
        setAnswered(false)
        setSelectedAnswer(null)
        setResult(null)
        startTimer(data.question.time_limit || 15)
        stoppedRef.current = true
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
      }
    } catch (err: any) {
      // 房间被删除时返回 404，跳回主页
      if (err?.response?.status === 404) {
        message.warning('该抢答活动已被教师删除')
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
        setErrorMsg('您没有权限进入此房间')
        message.error('您没有权限进入此房间')
      } else if (err?.response?.status === 404) {
        setErrorMsg('房间不存在')
        message.error('房间不存在')
      } else {
        setErrorMsg('加载房间信息失败，请刷新页面重试')
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
        setQuestion(msg.data)
        setTimer(msg.data.time_limit || 15)
        setPhase('question')
        setAnswered(false)
        setSelectedAnswer(null)
        setResult(null)
        setAnsweredCount(0)
        startTimer(msg.data.time_limit || 15)
        // 通过 WebSocket 拿到题目了，停止轮询
        stoppedRef.current = true
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
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
        // 重置轮询，下一题到达时自动显示
        stoppedRef.current = false
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
      message.error(err.response?.data?.detail || '提交失败')
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
        <Button style={{ marginTop: 16 }} onClick={() => navigate('/quick-quiz')}>返回抢答主页</Button>
      </div>
    )
  }

  if (phase === 'reveal' && !result?.correct_answer && !question) {
    // 公布答案后、下一题到达前
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh', flexDirection: 'column' }}>
        <Spin size="large" />
        <div style={{ marginTop: 24 }}>
          <Text type="secondary">等待下一题...</Text>
        </div>
      </div>
    )
  }

  if (!question && phase !== 'ended') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh', flexDirection: 'column' }}>
        <Spin size="large" />
        <div style={{ marginTop: 24 }}>
          <Text type="secondary">等待教师出题...</Text>
        </div>
      </div>
    )
  }

  const options = question?.options || {}
  const timerPercent = question?.time_limit ? (timer / question.time_limit) * 100 : 100
  const myRank = getMyRank()

  return (
    <div style={{ width: '100%', maxWidth: 900, margin: '0 auto', padding: 16 }}>
      {/* 顶部状态栏 */}
      <Card style={{ borderRadius: 12, marginBottom: 16, background: '#fafafa' }}
        styles={{ body: { padding: '12px 16px' } }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <Space>
            <ThunderboltOutlined style={{ fontSize: 20, color: '#fa8c16' }} />
            <Text strong>
              {question ? `第 ${question.sort_order} / ${question.total_questions} 题` : '抢答中'}
            </Text>
          </Space>
          <Space size={16}>
            <span>
              <TrophyOutlined style={{ color: '#faad14', marginRight: 4 }} />
              <Text strong style={{ color: '#faad14' }}>{myTotalScore}</Text> 分
            </span>
            {myRank && (
              <span>
                <TeamOutlined style={{ color: '#1677ff', marginRight: 4 }} />
                <Text strong style={{ color: '#1677ff' }}>第 {myRank} 名</Text>
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
          <Title level={4} style={{ marginBottom: 24, lineHeight: 1.6 }}>
            {question.sort_order}. {question.question_text}
          </Title>

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
                  <Text style={{ fontSize: 15 }}>{value as string}</Text>
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
                  {result.is_correct ? `✓ 答对了！+${result.score}分` : '✗ 答错了...'}
                </Text>
                {result.time_spent !== undefined && (
                  <Text type="secondary">用时 {result.time_spent}s</Text>
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
                <Text strong>正确答案：{result.correct_answer}. {options[result.correct_answer]}</Text>
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
              已作答：<Text strong>{answeredCount}</Text> / {totalPlayers || '?'} 人
              {result && result.is_correct && ' ✅ 你已答对'}
            </Text>
          </Space>
        </Card>
      )}

      {/* 排行榜（简略） */}
      {phase === 'reveal' && ranking.length > 0 && (
        <Card title="🏆 当前排行榜" style={{ borderRadius: 12, marginTop: 16 }}
          extra={<Button size="small" type="link" onClick={() => setShowFullRanking(!showFullRanking)}>
            {showFullRanking ? '收起' : '查看全部'}
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
                <Text style={{ color: '#52c41a' }}>{r.correct_count} 对</Text>
                <Text strong style={{ color: '#faad14', fontSize: 16 }}>{r.total_score}</Text>
              </Space>
            </div>
          ))}
        </Card>
      )}

    </div>
  )
}

export default QuickQuizPlay
