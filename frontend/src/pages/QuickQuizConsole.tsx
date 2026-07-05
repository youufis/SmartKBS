/**
 * QuickQuizConsole — 抢答活动教师控制台
 * 实时监控学生答题进度
 */
import React, { useState, useEffect, useRef } from 'react'
import {
  Card, Button, Typography, Space, Table, Tag, message, Spin,
  Progress, Row, Col, Statistic, Modal, Input, Select, Form,
} from 'antd'
import {
  ThunderboltOutlined, PlayCircleOutlined, StepForwardOutlined,
  TrophyOutlined, CheckCircleOutlined, CloseCircleOutlined,
  TeamOutlined, ClockCircleOutlined, BarChartOutlined,
  StopOutlined, ReloadOutlined, DatabaseOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import useSubjectOptions from '../hooks/useSubjectOptions'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'

const { Title, Text } = Typography

interface RankingEntry {
  rank: number
  student_name: string
  student_username: string
  total_score: number
  correct_count: number
  wrong_count?: number
}

const QuickQuizConsole: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)

  const [room, setRoom] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [currentQuestion, setCurrentQuestion] = useState(0)
  const [totalQuestions, setTotalQuestions] = useState(0)
  const [phase, setPhase] = useState<'waiting' | 'question' | 'reveal' | 'ended'>('waiting')
  const [players, setPlayers] = useState<any[]>([])
  const [ranking, setRanking] = useState<RankingEntry[]>([])
  const [answeredCount, setAnsweredCount] = useState(0)
  const [totalPlayers, setTotalPlayers] = useState(0)
  const [optionStats, setOptionStats] = useState<Record<string, number>>({})
  const [firstBlood, setFirstBlood] = useState<string | null>(null)
  const [questionText, setQuestionText] = useState('')
  const [correctAnswer, setCorrectAnswer] = useState('')
  const [explanation, setExplanation] = useState('')
  const [options, setOptions] = useState<Record<string, string>>({})
  const [svgContent, setSvgContent] = useState('')
  const [hasSvg, setHasSvg] = useState(0)
  const [mediaFiles, setMediaFiles] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const { subjects: subjectOptions } = useSubjectOptions()
  const [bankModalOpen, setBankModalOpen] = useState(false)
  const [bankQuestions, setBankQuestions] = useState<any[]>([])
  const [bankTotal, setBankTotal] = useState(0)
  const [bankLoading, setBankLoading] = useState(false)
  const [bankType, setBankType] = useState('academic')
  const [bankFilter, setBankFilter] = useState({ subject: '', difficulty: '', keyword: '', category: '' })
  const [bankPage, setBankPage] = useState(1)
  const [selectedBankIds, setSelectedBankIds] = useState<number[]>([])
  const [addingBankQ, setAddingBankQ] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef(false)
  const autoNextRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentQuestionRef = useRef(0)
  const totalQuestionsRef = useRef(0)
  const phaseRef = useRef(phase)
  // 保持 ref 同步
  useEffect(() => { currentQuestionRef.current = currentQuestion }, [currentQuestion])
  useEffect(() => { totalQuestionsRef.current = totalQuestions }, [totalQuestions])
  useEffect(() => { phaseRef.current = phase }, [phase])

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    loadRoom()
    connectWebSocket()
    // 轮询检测当前题目变化 + 答题情况
    pollTimerRef.current = setInterval(async () => {
      try {
        // 检测题目变化
        const qRes = await apiClient.get(`/api/quick-quiz/room/${roomId}/current-question`)
        if (qRes.data.question && qRes.data.current_question !== currentQuestionRef.current) {
          loadCurrentQuestionFromData(qRes.data)
        }
        if (qRes.data.phase === 'ended') {
          setPhase('ended')
        }
        // 刷新答题统计和排行
        const rRes = await apiClient.get(`/api/quick-quiz/room/${roomId}`)
        if (rRes.data?.players) {
          setPlayers(rRes.data.players)
          // 计算已作答人数（total_score > 0 或 correct_count + wrong_count > 0）
          const answered = rRes.data.players.filter(
            (p: any) => (p.correct_count || 0) + (p.wrong_count || 0) > 0
          ).length
          setAnsweredCount(answered)
          setTotalPlayers(rRes.data.players.length)
        }
        // 刷新排行
        if (phaseRef.current === 'reveal' || phaseRef.current === 'question') {
          try {
            const rankRes = await apiClient.get(`/api/quick-quiz/room/${roomId}/ranking`)
            if (rankRes.data?.ranking) setRanking(rankRes.data.ranking)
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }, 2000)
    return () => {
      if (wsRef.current) wsRef.current.close()
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    }
  }, [roomId])

  const loadRoom = async () => {
    try {
      const { data } = await apiClient.get(`/api/quick-quiz/room/${roomId}`)
      setRoom(data)
      setPlayers(data.players || [])
      if (data.status === 'ended') {
        setPhase('ended')
      } else if (data.phase === 'question' && data.current_question > 0) {
        // 已经出题了，拉取当前题目
        loadCurrentQuestion()
      }
    } catch {
      message.error('加载房间失败')
      navigate('/quick-quiz')
    } finally {
      setLoading(false)
    }
  }

  const loadCurrentQuestionFromData = (data: any) => {
    if (!data.question) return
    setCurrentQuestion(data.current_question)
    setTotalQuestions(data.total_questions)
    setPhase(data.phase || 'question')
    setQuestionText(data.question.question_text)
    setOptions(data.question.options || {})
    setSvgContent(data.question.svg_content || '')
    setHasSvg(data.question.has_svg || 0)
    setMediaFiles(data.question.media_files || '')
    setAnsweredCount(0)
    setOptionStats({})
    setFirstBlood(null)
    setCorrectAnswer('')
    setExplanation('')
  }

  const loadCurrentQuestion = async () => {
    try {
      const res = await apiClient.get(`/api/quick-quiz/room/${roomId}/current-question`)
      loadCurrentQuestionFromData(res.data)
    } catch { /* ignore */ }
  }

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

  const handleWsMessage = (msg: any) => {
    switch (msg.type) {
      case 'player_list':
        setPlayers(msg.data.players || [])
        break
      case 'new_question':
        setPhase('question')
        setCurrentQuestion(msg.data.sort_order)
        setTotalQuestions(msg.data.total_questions)
        setQuestionText(msg.data.question_text)
        setOptions(msg.data.options || {})
        setSvgContent(msg.data.svg_content || '')
        setHasSvg(msg.data.has_svg || 0)
        setMediaFiles(msg.data.media_files || '')
        setAnsweredCount(0)
        setOptionStats({})
        setFirstBlood(null)
        setCorrectAnswer('')
        setExplanation('')
        break
      case 'someone_answered':
        setAnsweredCount(msg.data.answered_count)
        break
      case 'answer_reveal':
        setPhase('reveal')
        setCorrectAnswer(msg.data.correct_answer)
        setExplanation(msg.data.explanation || '')
        setOptionStats(msg.data.option_stats || {})
        setFirstBlood(msg.data.first_blood)
        setRanking(msg.data.ranking || [])
        // 自动推进下一题
        if (msg.data.next_in && !msg.data.is_last) {
          if (autoNextRef.current) clearTimeout(autoNextRef.current)
          autoNextRef.current = setTimeout(() => {
            if (currentQuestionRef.current < totalQuestionsRef.current) {
              handleNext()
            }
          }, (msg.data.next_in || 3) * 1000)
        } else if (msg.data.next_in && msg.data.is_last) {
          // 最后一题，自动结束
          if (autoNextRef.current) clearTimeout(autoNextRef.current)
          autoNextRef.current = setTimeout(handleEnd, (msg.data.next_in || 3) * 1000)
        }
        break
      case 'game_end':
        setPhase('ended')
        setRanking(msg.data.final_ranking || [])
        message.success('🎉 抢答活动已结束！')
        break
    }
  }

  const handleNext = async () => {
    if (autoNextRef.current) clearTimeout(autoNextRef.current)
    setActionLoading(true)
    try {
      await apiClient.post(`/api/quick-quiz/room/${roomId}/next`)
    } catch (err: any) {
      message.error(err.response?.data?.detail || '操作失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleEnd = () => {
    if (autoNextRef.current) clearTimeout(autoNextRef.current)
    Modal.confirm({
      title: '确定结束抢答活动？',
      content: '结束后的结果将不可更改，系统会自动发放积分奖励。',
      okText: '确定结束',
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiClient.post(`/api/quick-quiz/room/${roomId}/end`)
          setPhase('ended')
          message.success('活动已结束')
        } catch (err: any) {
          message.error(err.response?.data?.detail || '结束失败')
        }
      },
    })
  }

  const handleViewResult = () => {
    navigate(`/quick-quiz/result/${roomId}`)
  }

  const loadBankQuestions = async (pageNum = 1) => {
    setBankLoading(true)
    setBankPage(pageNum)
    try {
      const params: any = {
        bank_type: bankType,
        keyword: bankFilter.keyword,
        page: pageNum,
        page_size: 20,
      }
      if (bankType === 'academic') {
        params.subject = bankFilter.subject
        params.difficulty = bankFilter.difficulty
      } else {
        params.category = bankFilter.category
      }
      const { data } = await apiClient.get(`/api/quick-quiz/room/${roomId}/bank-questions`, { params })
      setBankQuestions(data.questions || [])
      setBankTotal(data.total || 0)
    } catch (err: any) {
      message.error(err.response?.data?.detail || '加载题库失败')
    } finally {
      setBankLoading(false)
    }
  }

  const handleAddBankQuestions = async () => {
    if (selectedBankIds.length === 0) { message.warning('请选择题目'); return }
    setAddingBankQ(true)
    try {
      const { data } = await apiClient.post(`/api/quick-quiz/room/${roomId}/add-bank-questions`, {
        question_ids: selectedBankIds,
        bank_type: bankType,
      })
      setTotalQuestions(data.total_questions)
      message.success(`已添加 ${data.added_count} 题到抢答列表`)
      setBankModalOpen(false)
      setSelectedBankIds([])
    } catch (err: any) {
      message.error(err.response?.data?.detail || '添加失败')
    } finally {
      setAddingBankQ(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh' }}>
        <Spin size="large" description="加载中..." />
      </div>
    )
  }

  if (!room) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 120 }}>
        <Title level={4}>房间不存在</Title>
        <Button type="primary" onClick={() => navigate('/quick-quiz')}>返回</Button>
      </div>
    )
  }

  const answeredColor = totalPlayers > 0
    ? (answeredCount / totalPlayers >= 0.8 ? '#52c41a' : answeredCount / totalPlayers >= 0.5 ? '#faad14' : '#1677ff')
    : '#1677ff'

  return (
    <div style={{ width: '100%', margin: '0 auto', padding: 16 }}>
      {/* 顶栏 */}
      <Card style={{
        borderRadius: 12, marginBottom: 16,
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }} styles={{ body: { padding: '16px 24px' } }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <Space>
            <ThunderboltOutlined style={{ fontSize: 24, color: '#fff' }} />
            <div>
              <Title level={4} style={{ color: '#fff', margin: 0 }}>{room.title}</Title>
              <Text style={{ color: 'rgba(255,255,255,0.8)' }}>
                房间码: <Text code style={{ color: '#fff', background: 'rgba(255,255,255,0.2)' }}>{room.room_code}</Text>
              </Text>
            </div>
          </Space>
          <Space>
            {phase !== 'ended' ? (
              <>
                {phase === 'reveal' && currentQuestion < totalQuestions && (
                  <Button type="primary" ghost icon={<StepForwardOutlined />}
                    onClick={handleNext} loading={actionLoading}
                    style={{ borderColor: '#fff', color: '#fff' }}>
                    下一题
                  </Button>
                )}
                <Button danger icon={<StopOutlined />} onClick={handleEnd}
                  style={{ borderColor: '#ff4d4f', color: '#ff4d4f' }}>
                  结束活动
                </Button>
              </>
            ) : (
              <Button icon={<TrophyOutlined />} onClick={handleViewResult}
                style={{ borderColor: '#fff', color: '#fff' }} ghost>
                查看结果
              </Button>
            )}
          </Space>
        </div>
      </Card>

      {/* 实时状态 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card size="small" style={{ borderRadius: 8, textAlign: 'center' }}>
            <Statistic
              title="当前题号"
              value={currentQuestion}
              suffix={`/ ${totalQuestions}`}
              styles={{ content: { color: '#1677ff' } }}
              prefix={<BarChartOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={{ borderRadius: 8, textAlign: 'center' }}>
            <Statistic
              title="状态"
              value={phase === 'question' ? '答题中' : phase === 'reveal' ? '已公布' : phase === 'ended' ? '已结束' : '等待中'}
              styles={{ content: {
                color: phase === 'question' ? '#faad14' : phase === 'reveal' ? '#52c41a' : phase === 'ended' ? '#888' : '#1677ff'
              } }}
              prefix={<ClockCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={{ borderRadius: 8, textAlign: 'center' }}>
            <Statistic
              title="已作答"
              value={answeredCount}
              suffix={`/ ${totalPlayers}`}
              styles={{ content: { color: answeredColor } }}
              prefix={<TeamOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={{ borderRadius: 8, textAlign: 'center' }}>
            <Statistic
              title="玩家数"
              value={players.length}
              styles={{ content: { color: '#722ed1' } }}
              prefix={<TeamOutlined />}
            />
          </Card>
        </Col>
      </Row>

      {/* 当前题目 */}
      {phase !== 'waiting' && (
        <Card title={`📝 第 ${currentQuestion} 题`} style={{ borderRadius: 12, marginBottom: 16 }}>
          {questionText && (
            <Title level={5} style={{ marginBottom: 12 }}>
              <FormulaRenderer content={questionText} />
            </Title>
          )}
          {/* 配图（SVG + 万相图片） */}
          <MediaDisplay
            svgContent={svgContent}
            hasSvg={hasSvg}
            mediaFiles={mediaFiles}
          />
          {Object.keys(options).length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {Object.entries(options).map(([k, v]) => (
                <Tag key={k} color={phase === 'reveal' && k === correctAnswer ? '#52c41a' : 'default'}
                  style={{ margin: 4, padding: '4px 12px', fontSize: 14 }}>
                  {k}. <FormulaRenderer content={v as string} inline />
                  {phase === 'reveal' && k === correctAnswer && ' ✅'}
                </Tag>
              ))}
            </div>
          )}

          {phase === 'reveal' && (
            <>
              <div style={{ marginTop: 8, padding: 12, background: '#f6ffed', borderRadius: 8 }}>
                <Space>
                  <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  <Text strong style={{ color: '#52c41a', fontSize: 16 }}>
                    正确答案：{correctAnswer}
                  </Text>
                </Space>
                {firstBlood && (
                  <div style={{ marginTop: 4 }}>
                    <Text>⚡ 首杀：</Text>
                    <Text strong style={{ color: '#fa8c16' }}>{firstBlood}</Text>
                  </div>
                )}
                {explanation && (
                  <div style={{ marginTop: 8 }}>
                    <Text type="secondary">💡 </Text>
                    <FormulaRenderer content={explanation} />
                  </div>
                )}
              </div>

              {/* 选项统计 */}
              {Object.keys(optionStats).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <Text strong>📊 选项分布：</Text>
                  {Object.entries(optionStats).map(([k, v]) => {
                    const total = Object.values(optionStats).reduce((a, b) => a + b, 0)
                    const pct = total > 0 ? Math.round(v / total * 100) : 0
                    return (
                      <div key={k} style={{ marginTop: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                          <Text>
                            {k}. {options[k] || ''}
                            {k === correctAnswer && ' ✅'}
                          </Text>
                          <Text strong>{v}人 ({pct}%)</Text>
                        </div>
                        <Progress
                          percent={pct}
                          showInfo={false}
                          strokeColor={k === correctAnswer ? '#52c41a' : '#1677ff'}
                          size="small"
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* 实时排行榜 */}
      <Card title={<Space><TrophyOutlined /> 实时排行榜</Space>}
        style={{ borderRadius: 12, marginBottom: 16 }}
        extra={phase === 'ended' ? <Button type="primary" onClick={handleViewResult}>查看完整结果</Button> : null}
      >
        <Table
          dataSource={ranking.length > 0 ? ranking : players.map((p: any, i: number) => ({
            rank: i + 1,
            student_name: p.student_name || p.student_username,
            total_score: p.total_score || 0,
            correct_count: p.correct_count || 0,
            wrong_count: p.wrong_count || 0,
          }))}
          rowKey="student_username"
          pagination={false}
          size="small"
          columns={[
            {
              title: '名次', key: 'rank', width: 60,
              render: (_: any, __: any, idx: number) => (
                <Text strong style={{ fontSize: 16, color: idx < 3 ? ['#ff4d4f', '#fa8c16', '#faad14'][idx] : '#666' }}>
                  {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`}
                </Text>
              ),
            },
            { title: '姓名', dataIndex: 'student_name', key: 'name' },
            {
              title: '总分', dataIndex: 'total_score', key: 'score',
              render: (s: number) => <Text strong style={{ color: '#faad14' }}>{s}</Text>,
            },
            {
              title: '答对', dataIndex: 'correct_count', key: 'correct',
              render: (c: number) => <Text style={{ color: '#52c41a' }}>{c}</Text>,
            },
            {
              title: '答错', dataIndex: 'wrong_count', key: 'wrong',
              render: (w: number) => <Text style={{ color: '#ff4d4f' }}>{w}</Text>,
            },
          ]}
        />
      </Card>

      {/* 玩家列表 */}
      <Card title={<Space><TeamOutlined /> 玩家列表 ({players.length})</Space>}
        style={{ borderRadius: 12 }} size="small">
        <Space wrap>
          {players.map((p: any, i: number) => (
            <Tag key={p.student_username} color={['#1677ff', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1'][i % 5]}
              style={{ borderRadius: 12, padding: '2px 10px' }}>
              {p.student_name || p.student_username}
            </Tag>
          ))}
          {players.length === 0 && <Text type="secondary">暂无玩家</Text>}
        </Space>
      </Card>

      {/* 底部操作 */}
      {phase !== 'ended' && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Space>
            {phase === 'reveal' && currentQuestion < totalQuestions && (
              <Button type="primary" size="large" icon={<StepForwardOutlined />}
                onClick={handleNext} loading={actionLoading}
                style={{ height: 44, borderRadius: 22, paddingLeft: 24, paddingRight: 24 }}>
                下一题（{currentQuestion}/{totalQuestions}）
              </Button>
            )}
            {phase === 'reveal' && currentQuestion >= totalQuestions && (
              <Button type="primary" size="large" icon={<TrophyOutlined />}
                onClick={handleViewResult}
                style={{ height: 44, borderRadius: 22, paddingLeft: 24, paddingRight: 24 }}>
                查看最终结果
              </Button>
            )}
            <Button icon={<StopOutlined />} danger onClick={handleEnd}>结束活动</Button>
          </Space>
        </div>
      )}

      {/* ── 从题库选题弹窗 ── */}
      <Modal
        title={<Space><DatabaseOutlined style={{ color: '#1677ff' }} /> 从题库选题</Space>}
        open={bankModalOpen}
        onCancel={() => { setBankModalOpen(false); setSelectedBankIds([]) }}
        onOk={handleAddBankQuestions}
        okText={`添加所选题目（${selectedBankIds.length}题）`}
        okButtonProps={{ disabled: selectedBankIds.length === 0, loading: addingBankQ }}
        width={800}
      >
        {/* 题库来源切换 + 筛选区 */}
        <div style={{ marginBottom: 12 }}>
          <Space>
            <Text strong>题目来源：</Text>
            <Select
              value={bankType}
              onChange={v => {
                setBankType(v)
                setBankFilter({ subject: '', difficulty: '', keyword: '', category: '' })
                setSelectedBankIds([])
                setBankPage(1)
              }}
              style={{ width: 160 }}
              options={[
                { value: 'academic', label: '📚 学科题库' },
                { value: 'general', label: '🧠 百科题库' },
              ]}
            />
          </Space>
        </div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          {bankType === 'academic' ? (
            <>
              <Select
                style={{ width: 140 }}
                placeholder="全部学科"
                allowClear
                value={bankFilter.subject || undefined}
                onChange={v => setBankFilter(f => ({ ...f, subject: v || '' }))}
                options={subjectOptions.map(s => ({ value: s, label: s }))}
              />
              <Select
                style={{ width: 100 }}
                placeholder="全部难度"
                allowClear
                value={bankFilter.difficulty || undefined}
                onChange={v => setBankFilter(f => ({ ...f, difficulty: v || '' }))}
                options={[
                  { value: 'easy', label: '简单' },
                  { value: 'medium', label: '中等' },
                  { value: 'hard', label: '困难' },
                ]}
              />
            </>
          ) : (
            <Input
              style={{ width: 200 }}
              placeholder="分类筛选（如：文学、历史）"
              value={bankFilter.category}
              onChange={e => setBankFilter(f => ({ ...f, category: e.target.value }))}
              onPressEnter={() => loadBankQuestions(1)}
            />
          )}
          <Input
            style={{ flex: 1 }}
            placeholder="搜索题目关键词..."
            value={bankFilter.keyword}
            onChange={e => setBankFilter(f => ({ ...f, keyword: e.target.value }))}
            onPressEnter={() => loadBankQuestions(1)}
          />
          <Button onClick={() => loadBankQuestions(1)}>搜索</Button>
        </div>

        {bankLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : bankQuestions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>
            {bankTotal === 0 ? '题库暂无符合条件的单选题' : '没有更多题目'}
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary">共 {bankTotal} 题，已选 {selectedBankIds.length} 题</Text>
            </div>
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {bankQuestions.map((q: any) => {
                const selected = selectedBankIds.includes(q.id)
                return (
                  <Card
                    key={q.id}
                    size="small"
                    style={{
                      marginBottom: 8,
                      borderRadius: 8,
                      cursor: 'pointer',
                      border: selected ? '2px solid #1677ff' : '1px solid #f0f0f0',
                      background: selected ? '#f0f5ff' : '#fff',
                    }}
                    onClick={() => {
                      setSelectedBankIds(prev =>
                        prev.includes(q.id)
                          ? prev.filter(id => id !== q.id)
                          : [...prev, q.id]
                      )
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <div>
                        <CheckCircleOutlined
                          style={{
                            fontSize: 18,
                            color: selected ? '#1677ff' : '#d9d9d9',
                            marginTop: 2,
                          }}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div>
                          <Text strong>{q.question_text}</Text>
                        </div>
                        <div style={{ marginTop: 4 }}>
                          {Object.entries(q.options || {}).map(([k, v]) => (
                            <Tag key={k} color={k === q.correct_answer ? '#52c41a' : 'default'}
                              style={{ margin: 2 }}>
                              {k}. {v as string}
                            </Tag>
                          ))}
                        </div>
                        <div style={{ marginTop: 4 }}>
                          {q.difficulty && (
                            <Tag color={q.difficulty === 'easy' ? 'green' : q.difficulty === 'medium' ? 'orange' : 'red'}>
                              {q.difficulty === 'easy' ? '简单' : q.difficulty === 'medium' ? '中等' : '困难'}
                            </Tag>
                          )}
                          {q.subject && <Tag>{q.subject}</Tag>}
                          {q.knowledge_points && <Tag>{q.knowledge_points}</Tag>}
                        </div>
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
            {/* 分页 */}
            {bankTotal > 20 && (
              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <Space>
                  <Button size="small" disabled={bankPage <= 1}
                    onClick={() => loadBankQuestions(bankPage - 1)}>上一页</Button>
                  <Text>第 {bankPage} / {Math.ceil(bankTotal / 20)} 页</Text>
                  <Button size="small" disabled={bankPage * 20 >= bankTotal}
                    onClick={() => loadBankQuestions(bankPage + 1)}>下一页</Button>
                </Space>
              </div>
            )}
          </>
        )}
      </Modal>
    </div>
  )
}

export default QuickQuizConsole
