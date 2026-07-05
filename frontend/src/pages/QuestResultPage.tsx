/**
 * QuestResultPage — 闯关结算页面
 * 显示战果、每题回顾、奖励信息
 */
import React, { useState, useEffect } from 'react'
import {
  Card, Button, Typography, Space, Row, Col, Tag,
  Spin, message, Collapse, Divider, Empty, Result,
} from 'antd'
import {
  TrophyOutlined, ReloadOutlined, HomeOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
  CrownOutlined, FireOutlined, StarOutlined,
  ClockCircleOutlined, TeamOutlined, PhoneOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import apiClient from '../api/client'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'

const { Title, Text, Paragraph } = Typography

interface QuestionReview {
  sort_order: number
  category: string
  question_text: string
  options: Record<string, string>
  correct_answer: string
  student_answer: string | null
  is_correct: number
  lifeline_used: string
  svg_content?: string
  has_svg?: number
  media_files?: string
  media_placeholders?: string
  time_spent: number
  score: number
  explanation: string
}

interface QuestResult {
  quest_id: number
  completed: number
  correct_count: number
  answered_count: number
  total_score: number
  wrong_question_index: number
  lifelines_used: string[]
  questions: QuestionReview[]
  badge_count: number
  total_badges: number
  created_at: string
  completed_at: string
}

const LIFELINE_LABELS: Record<string, string> = {
  remove_one: '🎯 去伪存真',
  phone_friend: '📞 远程连线',
  audience_vote: '👥 群策群力',
}

const CATEGORY_COLORS: Record<string, string> = {
  '文学': '#eb2f96', '历史': '#fa8c16', '地理': '#52c41a',
  '科技': '#1677ff', '天文': '#722ed1', '自然科学': '#13c2c2',
  '人物传记': '#fa541c', '艺术': '#f5222d', '体育': '#faad14',
  '生活常识': '#2f54eb', '传统文化': '#a0d911', '时事百科': '#08979c',
}

const SCORE_COLORS = ['#ff4d4f', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1']

const getScoreColor = (correct: number) => {
  if (correct >= 12) return SCORE_COLORS[5]
  if (correct >= 8) return SCORE_COLORS[4]
  if (correct >= 4) return SCORE_COLORS[3]
  if (correct >= 1) return SCORE_COLORS[2]
  return SCORE_COLORS[0]
}

const QuestResultPage: React.FC = () => {
  const { questId } = useParams<{ questId: string }>()
  const navigate = useNavigate()
  const [result, setResult] = useState<QuestResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadResult()
  }, [questId])

  const loadResult = async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get(`/api/quest/${questId}/result`)
      setResult(data)
    } catch {
      message.error('加载结算数据失败')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh' }}>
        <Spin size="large" description="加载结算中..." />
      </div>
    )
  }

  if (!result) {
    return (
      <Empty description="结算数据不存在" style={{ paddingTop: 80 }}>
        <Button type="primary" onClick={() => navigate('/quest')}>返回闯关</Button>
      </Empty>
    )
  }

  const isAllCorrect = result.correct_count >= 15
  // 闯关成功 = 后端标记 completed=1（完成全部 15 题）
  const isSuccess = result.completed === 1
  const scoreColor = getScoreColor(result.correct_count)

  const getGradeTag = () => {
    if (result.correct_count >= 15) return <Tag color="gold" style={{ fontSize: 16, padding: '4px 16px' }}>💎 一站到底！</Tag>
    if (result.correct_count >= 12) return <Tag color="purple" style={{ fontSize: 14, padding: '4px 14px' }}>🏆 优秀</Tag>
    if (result.correct_count >= 8) return <Tag color="blue" style={{ fontSize: 14, padding: '4px 14px' }}>🥈 良好</Tag>
    if (result.correct_count >= 4) return <Tag color="green" style={{ fontSize: 14, padding: '4px 14px' }}>🥉 及格</Tag>
    if (result.correct_count >= 1) return <Tag color="orange" style={{ fontSize: 14, padding: '4px 14px' }}>📖 初次挑战</Tag>
    return <Tag color="red" style={{ fontSize: 14, padding: '4px 14px' }}>💪 再接再厉</Tag>
  }

  const confettiEmojis = ['🎉', '⭐', '🌟', '✨', '🎊', '💫', '🏅']
  const confettiAnimation = isSuccess ? (
    <style>{`
      @keyframes resultConfetti {
        0% { transform: translateY(-10px) rotate(0deg); opacity: 0; }
        50% { opacity: 1; }
        100% { transform: translateY(30px) rotate(360deg); opacity: 0; }
      }
      .confetti-particle {
        display: inline-block;
        animation: resultConfetti 1.5s ease-in-out infinite;
        font-size: 24px;
      }
      .confetti-particle:nth-child(2) { animation-delay: 0.2s; }
      .confetti-particle:nth-child(3) { animation-delay: 0.4s; }
      .confetti-particle:nth-child(4) { animation-delay: 0.6s; }
      .confetti-particle:nth-child(5) { animation-delay: 0.8s; }
      .confetti-particle:nth-child(6) { animation-delay: 1.0s; }
      .confetti-particle:nth-child(7) { animation-delay: 1.2s; }
    `}</style>
  ) : null

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      {confettiAnimation}

      {/* ── 结算卡片 ── */}
      <Card
        style={{
          borderRadius: 16,
          textAlign: 'center',
          marginBottom: 24,
          background: isSuccess
            ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
            : 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
          border: 'none',
        }}
      >
        <Space orientation="vertical" size={12}>
          {isSuccess && (
            <div>
              {confettiEmojis.map((emoji, i) => (
                <span key={i} className="confetti-particle">{emoji}</span>
              ))}
            </div>
          )}
          <Title level={2} style={{ color: isSuccess ? '#fff' : '#666', margin: 0 }}>
            {isSuccess ? '🎉 闯关成功！' : '💪 闯关结束'}
          </Title>
          {getGradeTag()}

          <div style={{ marginTop: 8 }}>
            <Title level={1} style={{ color: isSuccess ? '#ffd700' : '#999', margin: 0, fontSize: 56 }}>
              {result.correct_count}
            </Title>
            <Text style={{ color: isSuccess ? 'rgba(255,255,255,0.8)' : '#999', fontSize: 18 }}>
              答对 / {result.answered_count} 题
            </Text>
          </div>

          <Row gutter={[24, 16]} justify="center" style={{ marginTop: 8 }}>
            <Col>
              <StatisticItem
                title="总得分"
                value={result.total_score}
                suffix="分"
                color="#ffd700"
              />
            </Col>
            <Col>
              <StatisticItem
                title="🏅 闯关徽章"
                value={result.badge_count}
                suffix="枚"
                color="#ffd700"
              />
            </Col>
            <Col>
              <StatisticItem
                title="总徽章"
                value={result.total_badges}
                suffix="枚"
                color="#ffd700"
              />
            </Col>
          </Row>
        </Space>
      </Card>

      {/* ── 操作按钮 ── */}
      <Row gutter={16} style={{ marginBottom: 24 }} justify="center">
        <Col>
          <Button
            type="primary"
            size="large"
            icon={<ReloadOutlined />}
            onClick={() => navigate('/quest')}
            style={{ borderRadius: 20, paddingLeft: 24, paddingRight: 24 }}
          >
            再来一次
          </Button>
        </Col>
        <Col>
          <Button
            size="large"
            icon={<HomeOutlined />}
            onClick={() => navigate('/quest')}
            style={{ borderRadius: 20, paddingLeft: 24, paddingRight: 24 }}
          >
            返回闯关主页
          </Button>
        </Col>
      </Row>

      {/* ── 每题回顾 ── */}
      <Card title="📋 答题回顾" style={{ borderRadius: 12 }}>
        {result.questions.length === 0 ? (
          <Empty description="暂无答题记录" />
        ) : (
          <Collapse
            items={result.questions.map((q, idx) => ({
              key: String(idx),
              label: (
                <Space>
                  <Text strong>第{q.sort_order}题</Text>
                  <Tag color={CATEGORY_COLORS[q.category] || '#1677ff'}>{q.category}</Tag>
                  {q.is_correct === 1 ? (
                    <Tag color="success" icon={<CheckCircleOutlined />}>正确 +{q.score}分</Tag>
                  ) : q.is_correct === 0 ? (
                    <Tag color="error" icon={<CloseCircleOutlined />}>错误</Tag>
                  ) : (
                    <Tag color="default">未作答</Tag>
                  )}
                  {q.lifeline_used && (
                    <Tag color="orange">
                      {q.lifeline_used.split(',').filter(Boolean).map((l) => LIFELINE_LABELS[l] || l).join(', ')}
                    </Tag>
                  )}
                </Space>
              ),
              children: (
                <div>
                  <Paragraph style={{ fontSize: 15, fontWeight: 500 }}>
                    {q.sort_order}. <FormulaRenderer content={q.question_text} />
                  </Paragraph>
                  <MediaDisplay
                    svgContent={q.svg_content}
                    hasSvg={q.has_svg}
                    mediaFiles={q.media_files}
                  />
                  <Space orientation="vertical" style={{ width: '100%' }} size={4}>
                    {Object.entries(q.options).map(([k, v]) => {
                      const isStudentAns = q.student_answer === k
                      const isCorrectAns = q.correct_answer === k
                      let color = 'default'
                      if (isCorrectAns) color = 'success'
                      else if (isStudentAns && q.is_correct === 0) color = 'error'
                      return (
                        <Tag key={k} color={color} style={{ padding: '4px 8px', fontSize: 14 }}>
                          {k}. <FormulaRenderer content={v as string} inline />
                          {isCorrectAns && ' ✓'}
                          {isStudentAns && q.is_correct === 0 && ' ✗'}
                        </Tag>
                      )
                    })}
                  </Space>
                  {q.student_answer === '__timeout__' && (
                    <Tag color="warning" style={{ marginTop: 8 }}>⏱ 超时未答</Tag>
                  )}
                  <div style={{ marginTop: 8, padding: 8, background: '#f6f8fa', borderRadius: 6 }}>
                    <Text type="secondary">💡 </Text>
                    <FormulaRenderer content={q.explanation} />
                  </div>
                </div>
              ),
            }))}
          />
        )}
      </Card>
    </div>
  )
}

const StatisticItem: React.FC<{ title: string; value: number; suffix?: string; color?: string }> = ({
  title, value, suffix, color
}) => (
  <div style={{ textAlign: 'center' }}>
    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>{title}</div>
    <div style={{ color: color || '#fff', fontSize: 28, fontWeight: 700 }}>
      {value}
      {suffix && <span style={{ fontSize: 14, opacity: 0.8 }}> {suffix}</span>}
    </div>
  </div>
)

export default QuestResultPage
