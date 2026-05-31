import React, { useState, useEffect, useCallback } from 'react'
import {
  Layout, Card, Button, message, Radio, Checkbox, Input,
  Typography, Space, Tag, Spin, Result, Progress, Row, Col, Divider,
} from 'antd'
import {
  ArrowLeftOutlined, ArrowRightOutlined, CheckCircleOutlined,
  CloseCircleOutlined, ClockCircleOutlined, SendOutlined,
} from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import * as examsApi from '../api/exams'
import type { ExamInfo, ExamQuestion } from '../types'

const { TextArea } = Input
const { Text, Title } = Typography

const TYPE_LABELS: Record<string, string> = {
  single: '单选题',
  multiple: '多选题',
  true_false: '判断题',
  short: '简答题',
}

const ExamTakePage: React.FC = () => {
  const { examId } = useParams<{ examId: string }>()
  const navigate = useNavigate()
  // ── 考试数据 ──
  const [exam, setExam] = useState<ExamInfo | null>(null)
  const [questions, setQuestions] = useState<ExamQuestion[]>([])
  const [loading, setLoading] = useState(true)

  // ── 答题状态 ──
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [currentIndex, setCurrentIndex] = useState(0)
  const [attemptId, setAttemptId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [result, setResult] = useState<{
    score: number;
    total_score: number;
    passed: boolean;
    details?: Record<string, any>;
  } | null>(null)

  // ── 计时器 ──
  const [timeLeft, setTimeLeft] = useState<number>(0)
  const [timerActive, setTimerActive] = useState(false)

  // ── 加载考试 ──
  const loadExam = useCallback(async () => {
    if (!examId) return
    setLoading(true)
    try {
      // 先开始考试
      const startRes = await examsApi.startExam(Number(examId))
      setAttemptId(startRes.attempt_id)

      const detail = await examsApi.getExam(Number(examId))
      setExam(detail)
      const qs = detail.questions || []
      setQuestions(qs)

      // 计时器
      if (detail.duration) {
        setTimeLeft(detail.duration * 60)
        setTimerActive(true)
      }

      // 如果是继续答题，恢复之前的答案
      if (startRes.existing && detail.my_attempt?.answers) {
        try {
          const savedAnswers = typeof detail.my_attempt.answers === 'string'
            ? JSON.parse(detail.my_attempt.answers)
            : detail.my_attempt.answers
          const restored: Record<string, string> = {}
          Object.keys(savedAnswers).forEach((qid) => {
            restored[qid] = typeof savedAnswers[qid] === 'object'
              ? (savedAnswers[qid] as any).student_answer || ''
              : savedAnswers[qid]
          })
          setAnswers(restored)
        } catch {
          // ignore
        }
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '加载考试失败')
      navigate('/exam')
    } finally {
      setLoading(false)
    }
  }, [examId, navigate])

  useEffect(() => {
    if (examId) loadExam()
  }, [examId, loadExam])

  // ── 计时器逻辑 ──
  useEffect(() => {
    if (!timerActive || timeLeft <= 0) return
    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval)
          setTimerActive(false)
          // 自动提交
          message.warning('考试时间到，自动提交')
          handleSubmit()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [timerActive])

  // ── 格式化时间 ──
  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  // ── 设置答案 ──
  const setAnswer = (qId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [qId]: value }))
  }

  const handleMultipleChange = (qId: string, optionKey: string, checked: boolean) => {
    const current = (answers[qId] || '').split(',').filter(Boolean)
    if (checked) {
      if (!current.includes(optionKey)) {
        setAnswer(qId, [...current, optionKey].join(','))
      }
    } else {
      setAnswer(qId, current.filter((k) => k !== optionKey).join(','))
    }
  }

  // ── 提交 ──
  const handleSubmit = async () => {
    if (!examId || !attemptId) return
    setSubmitting(true)
    try {
      const res = await examsApi.submitExam(Number(examId), answers)
      setSubmitted(true)
      setResult({
        score: res.score,
        total_score: res.total_score,
        passed: res.passed,
        details: res.details || undefined,
      })
      message.success('提交成功')
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  // ── 返回 ──
  const handleBack = () => {
    navigate('/exam')
  }

  // ── 渲染题目 ──
  const renderQuestion = (q: ExamQuestion, idx: number) => {
    const qId = String(q.id)
    const answer = answers[qId] || ''

    return (
      <Card
        key={q.id}
        title={
          <Space>
            <Tag color="blue">{TYPE_LABELS[q.type] || q.type}</Tag>
            <span>第 {idx + 1} 题（{q.question_score} 分）</span>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <div style={{ fontSize: 15, lineHeight: 1.8, marginBottom: 16 }}>
          {q.question_text}
        </div>

        {q.type === 'single' && q.options && (
          <Radio.Group value={answer} onChange={(e) => setAnswer(qId, e.target.value)}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {Object.entries(q.options).map(([key, val]) => (
                <Radio key={key} value={key}
                  style={{ padding: '8px 12px', borderRadius: 6, border: answer === key ? '1px solid #1677ff' : '1px solid #eee', width: '100%', margin: 0 }}>
                  <strong>{key}.</strong> {val as string}
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        )}

        {q.type === 'multiple' && q.options && (
          <Checkbox.Group value={answer ? answer.split(',') : []}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {Object.entries(q.options).map(([key, val]) => (
                <Checkbox key={key} value={key}
                  onChange={(e) => handleMultipleChange(qId, key, e.target.checked)}
                  style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #eee', width: '100%', margin: 0 }}>
                  <strong>{key}.</strong> {val as string}
                </Checkbox>
              ))}
            </Space>
          </Checkbox.Group>
        )}

        {q.type === 'true_false' && (
          <Radio.Group value={answer} onChange={(e) => setAnswer(qId, e.target.value)}>
            <Space>
              <Radio value="对" style={{ padding: '8px 20px', borderRadius: 6, border: answer === '对' ? '1px solid #1677ff' : '1px solid #eee' }}>对</Radio>
              <Radio value="错" style={{ padding: '8px 20px', borderRadius: 6, border: answer === '错' ? '1px solid #1677ff' : '1px solid #eee' }}>错</Radio>
            </Space>
          </Radio.Group>
        )}

        {q.type === 'short' && (
          <TextArea rows={4} value={answer}
            onChange={(e) => setAnswer(qId, e.target.value)}
            placeholder="请输入你的答案..." />
        )}
      </Card>
    )
  }

  // ── 渲染结果 ──
  if (submitted && result) {
    const correctCount = result.details
      ? Object.values(result.details).filter((d: any) => d.is_correct).length
      : 0
    return (
      <Layout style={{ minHeight: '100vh', background: '#f5f5f5', padding: 24 }}>
        <Card style={{ maxWidth: 700, margin: '40px auto' }}>
          <Result
            status={result.passed ? 'success' : 'error'}
            title={result.passed ? '考试通过！' : '未通过'}
            subTitle={
              <Space direction="vertical" size={8}>
                <Typography.Title level={2}
                  style={{ color: result.passed ? '#52c41a' : '#ff4d4f', margin: 0 }}>
                  {result.score} 分
                </Typography.Title>
                <Typography.Text type="secondary">
                  满分 {result.total_score} 分
                </Typography.Text>
              </Space>
            }
            extra={[
              <Button type="primary" key="back" onClick={handleBack}>
                返回考试列表
              </Button>,
            ]}
          >
            {result.details && (
              <div style={{ marginTop: 16 }}>
                <Divider />
                <Typography.Title level={5}>答题详情</Typography.Title>
                <Progress
                  percent={Math.round((result.score / result.total_score) * 100)}
                  status={result.passed ? 'success' : 'exception'}
                  format={() => `${correctCount}/${Object.keys(result.details || {}).length} 题正确`}
                />
                {Object.entries(result.details).map(([qId, detail]: [string, any]) => (
                  <Card key={qId} size="small"
                    style={{ marginTop: 8, background: detail.is_correct ? '#f6ffed' : '#fff2f0' }}>
                    <Space>
                      {detail.is_correct
                        ? <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 18 }} />
                        : <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 18 }} />}
                      <span>你的答案：{detail.student_answer || '未作答'}</span>
                      {!detail.is_correct && (
                        <span style={{ color: '#888' }}>正确答案：{detail.correct_answer}</span>
                      )}
                      <Tag color={detail.is_correct ? 'green' : 'red'}>
                        {detail.score}/{detail.max_score} 分
                      </Tag>
                    </Space>
                  </Card>
                ))}
              </div>
            )}
          </Result>
        </Card>
      </Layout>
    )
  }

  // ── 加载中 ──
  if (loading) {
    return (
      <Layout style={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#f5f5f5' }}>
        <Spin size="large" tip="加载考试中..." />
      </Layout>
    )
  }

  if (!exam || questions.length === 0) {
    return (
      <Layout style={{ minHeight: '100vh', background: '#f5f5f5', padding: 24 }}>
        <Result status="warning" title="考试暂无题目"
          subTitle="请联系教师添加题目"
          extra={<Button onClick={handleBack}>返回</Button>} />
      </Layout>
    )
  }

  const currentQuestion = questions[currentIndex]
  const answeredCount = Object.keys(answers).length
  const progressPercent = Math.round((answeredCount / questions.length) * 100)

  return (
    <Layout style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      {/* ── 顶栏 ── */}
      <div style={{
        background: '#fff', padding: '12px 24px',
        borderBottom: '1px solid #f0f0f0',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={handleBack}>退出</Button>
          <Title level={5} style={{ margin: 0 }}>{exam.title}</Title>
        </Space>
        <Space size={24}>
          <span>
            <ClockCircleOutlined style={{ marginRight: 4 }} />
            剩余时间：
            <Text strong style={{ color: timeLeft < 300 ? '#ff4d4f' : '#1677ff', fontSize: 18 }}>
              {formatTime(timeLeft)}
            </Text>
          </span>
          <span>
            进度：{answeredCount}/{questions.length}
          </span>
          <Button type="primary" icon={<SendOutlined />}
            loading={submitting}
            onClick={() => {
              if (answeredCount < questions.length) {
                message.warning(`还有 ${questions.length - answeredCount} 题未作答，确认提交吗？`)
              }
              handleSubmit()
            }}>
            提交
          </Button>
        </Space>
      </div>

      <div style={{ padding: 16, maxWidth: 960, margin: '0 auto', width: '100%' }}>
        {/* ── 进度条 ── */}
        <Progress percent={progressPercent} size="small" style={{ marginBottom: 16 }} />

        {/* ── 题号导航 ── */}
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text strong style={{ fontSize: 13, whiteSpace: 'nowrap' }}>题目导航：</Text>
          <Space size={12}>
            <Text style={{ fontSize: 12 }}><Tag color="#1677ff" style={{ lineHeight: '18px', padding: '0 6px' }}>1</Tag> 当前</Text>
            <Text style={{ fontSize: 12 }}><Tag color="#52c41a" style={{ lineHeight: '18px', padding: '0 6px' }}>2</Tag> 已答</Text>
            <Text style={{ fontSize: 12 }}><Tag color="#f0f0f0" style={{ lineHeight: '18px', padding: '0 6px', border: '1px solid #d9d9d9' }}>3</Tag> 未答</Text>
          </Space>
        </div>
        <div style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {questions.map((q, idx) => {
            const answered = !!answers[String(q.id)]
            const isCurrent = idx === currentIndex
            let tagColor: string
            let borderStyle: React.CSSProperties = {}
            if (isCurrent) {
              tagColor = '#1677ff'
            } else if (answered) {
              tagColor = '#52c41a'
            } else {
              tagColor = '#f0f0f0'
              borderStyle = { border: '1px solid #d9d9d9', color: '#666' }
            }
            return (
              <Tag
                key={q.id}
                color={tagColor}
                style={{ cursor: 'pointer', padding: '2px 10px', fontSize: 13, minWidth: 32, textAlign: 'center', ...borderStyle }}
                onClick={() => setCurrentIndex(idx)}
              >
                {idx + 1}
                {answered && <CheckCircleOutlined style={{ marginLeft: 2, fontSize: 11 }} />}
              </Tag>
            )
          })}
        </div>

        {/* ── 当前题目 ── */}
        {currentQuestion && renderQuestion(currentQuestion, currentIndex)}

        {/* ── 翻页按钮 ── */}
        <Row justify="space-between" style={{ marginTop: 16 }}>
          <Col>
            <Button disabled={currentIndex === 0}
              onClick={() => setCurrentIndex((i) => i - 1)}
              icon={<ArrowLeftOutlined />}>
              上一题
            </Button>
          </Col>
          <Col>
            <Button disabled={currentIndex >= questions.length - 1}
              type="primary"
              onClick={() => setCurrentIndex((i) => i + 1)}>
              下一题 <ArrowRightOutlined />
            </Button>
          </Col>
        </Row>
      </div>
    </Layout>
  )
}

export default ExamTakePage
