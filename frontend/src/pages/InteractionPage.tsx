import React, { useState, useEffect } from 'react'
import {
  Card, Tabs, Button, Space, Typography, List, Tag, Modal,
  Form, Input, Select, message, Empty, Spin, Radio, Result,
  Statistic, Row, Col, Table, Progress,
} from 'antd'
import {
  ThunderboltOutlined, BarChartOutlined, QuestionCircleOutlined,
  PlusOutlined, PlayCircleOutlined, CheckCircleOutlined,
  SendOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography
const { TextArea } = Input

const InteractionPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  // ── 随堂测验 ──
  const [quizzes, setQuizzes] = useState<any[]>([])
  const [quizLoading, setQuizLoading] = useState(false)
  const [quizModal, setQuizModal] = useState(false)
  const [takingQuiz, setTakingQuiz] = useState<any>(null)
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({})
  const [quizResult, setQuizResult] = useState<any>(null)
  const [quizResultsView, setQuizResultsView] = useState<any>(null)
  const [quizForm] = Form.useForm()
  const [creating, setCreating] = useState(false)

  // ── 投票 ──
  const [polls, setPolls] = useState<any[]>([])
  const [pollLoading, setPollLoading] = useState(false)
  const [pollModal, setPollModal] = useState(false)
  const [votedPoll, setVotedPoll] = useState<number | null>(null)
  const [selectedOption, setSelectedOption] = useState<number | null>(null)
  const [pollForm] = Form.useForm()
  const [pollResults, setPollResults] = useState<any>(null)

  // ── 提问 ──
  const [questions, setQuestions] = useState<any[]>([])
  const [questionLoading, setQuestionLoading] = useState(false)
  const [askModal, setAskModal] = useState(false)
  const [answerModal, setAnswerModal] = useState<any>(null)
  const [answerText, setAnswerText] = useState('')
  const [askForm] = Form.useForm()

  // ── 加载数据 ──
  const loadQuizzes = async () => {
    setQuizLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/quizzes', { params: { page_size: 50 } })
      setQuizzes(data.quizzes || [])
    } catch { /* ignore */ }
    setQuizLoading(false)
  }

  const loadPolls = async () => {
    setPollLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/polls')
      setPolls(data.polls || [])
    } catch { /* ignore */ }
    setPollLoading(false)
  }

  const loadQuestions = async () => {
    setQuestionLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/questions', {
        params: isTeacherOrAdmin ? {} : {},
      })
      setQuestions(data.questions || [])
    } catch { /* ignore */ }
    setQuestionLoading(false)
  }

  useEffect(() => {
    loadQuizzes()
    loadPolls()
    loadQuestions()
  }, [])

  // ── 创建测验 ──
  const handleCreateQuiz = async (values: any) => {
    setCreating(true)
    try {
      const questions = values.questions_text.split('\n').filter((l: string) => l.trim())
        .map((line: string, i: number) => ({
          type: values.qtype || 'single',
          question: line,
          options: values.options ? values.options.split('|') : [],
          answer: (values.answers || '').split('\n')[i] || '',
          score: 1,
        }))
      await apiClient.post('/api/interaction/quizzes', {
        title: values.title,
        description: values.description || '',
        questions: JSON.stringify(questions),
      })
      message.success('测验创建成功')
      setQuizModal(false)
      quizForm.resetFields()
      loadQuizzes()
    } catch (err: any) {
      message.error(err.response?.data?.detail || '创建失败')
    }
    setCreating(false)
  }

  // ── 开始答题 ──
  const handleStartQuiz = (quiz: any) => {
    setTakingQuiz(quiz)
    setQuizAnswers({})
    setQuizResult(null)
  }

  const handleSubmitQuiz = async () => {
    if (!takingQuiz) return
    const answers = takingQuiz.questions.map((_q: any, i: number) => ({
      question_index: i,
      answer: quizAnswers[i] || '',
    }))
    try {
      const { data } = await apiClient.post(`/api/interaction/quizzes/${takingQuiz.id}/answer`, { answers: JSON.stringify(answers) })
      setQuizResult(data)
    } catch (err: any) {
      message.error(err.response?.data?.detail || '提交失败')
    }
  }

  const handleViewQuizResults = async (quizId: number) => {
    try {
      const { data } = await apiClient.get(`/api/interaction/quizzes/${quizId}/results`)
      setQuizResultsView(data)
    } catch { message.error('加载结果失败') }
  }

  // ── 投票 ──
  const handleCreatePoll = async (values: any) => {
    const options = values.options.split('\n').filter((l: string) => l.trim())
    if (options.length < 2) { message.warning('至少需要2个选项'); return }
    try {
      await apiClient.post('/api/interaction/polls', { question: values.question, options })
      message.success('投票创建成功')
      setPollModal(false)
      pollForm.resetFields()
      loadPolls()
    } catch (err: any) {
      message.error(err.response?.data?.detail || '创建失败')
    }
  }

  const handleVote = async (pollId: number) => {
    if (selectedOption === null) { message.warning('请选择一个选项'); return }
    try {
      await apiClient.post(`/api/interaction/polls/${pollId}/vote?option_index=${selectedOption}`)
      message.success('投票成功')
      setVotedPoll(pollId)
      setSelectedOption(null)
      loadPolls()
    } catch (err: any) {
      message.error(err.response?.data?.detail || '投票失败')
    }
  }

  const handleViewPollResults = async (pollId: number) => {
    try {
      const { data } = await apiClient.get(`/api/interaction/polls/${pollId}/results`)
      setPollResults(data)
    } catch { message.error('加载结果失败') }
  }

  // ── 提问 ──
  const handleAskQuestion = async (values: any) => {
    try {
      await apiClient.post('/api/interaction/questions', {
        content: values.content,
        is_anonymous: values.is_anonymous || false,
      })
      message.success('提问成功')
      setAskModal(false)
      askForm.resetFields()
      loadQuestions()
    } catch { message.error('提问失败') }
  }

  const handleAnswerQuestion = async (qId: number) => {
    if (!answerText.trim()) { message.warning('请输入回答'); return }
    try {
      await apiClient.put(`/api/interaction/questions/${qId}/answer`, { answer: answerText })
      message.success('回答成功')
      setAnswerModal(null)
      setAnswerText('')
      loadQuestions()
    } catch { message.error('回答失败') }
  }

  const tabItems = [
    {
      key: 'quizzes',
      label: <span><ThunderboltOutlined /> 随堂测验</span>,
      children: (
        <div>
          {isTeacherOrAdmin && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setQuizModal(true)}
              style={{ marginBottom: 16 }}>
              创建测验
            </Button>
          )}
          <Spin spinning={quizLoading}>
            {quizzes.length === 0 ? <Empty description="暂无测验" /> : (
              <List
                dataSource={quizzes}
                renderItem={(quiz: any) => (
                  <Card size="small" style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <Text strong>{quiz.title}</Text>
                        <Text type="secondary" style={{ marginLeft: 8 }}>{quiz.description}</Text>
                        <div style={{ marginTop: 4 }}>
                          <Tag>{quiz.questions?.length || 0} 题</Tag>
                          <Tag color={quiz.status === 'active' ? 'green' : 'default'}>
                            {quiz.status === 'active' ? '进行中' : '已结束'}
                          </Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>{quiz.answer_count || 0} 人参与</Text>
                        </div>
                      </div>
                      <Space>
                        {quiz.status === 'active' && isStudent && (
                          <Button size="small" type="primary" icon={<PlayCircleOutlined />}
                            onClick={() => handleStartQuiz(quiz)}>
                            开始答题
                          </Button>
                        )}
                        {isTeacherOrAdmin && (
                          <Button size="small" icon={<BarChartOutlined />}
                            onClick={() => handleViewQuizResults(quiz.id)}>
                            查看结果
                          </Button>
                        )}
                      </Space>
                    </div>
                  </Card>
                )}
              />
            )}
          </Spin>
        </div>
      ),
    },
    {
      key: 'polls',
      label: <span><BarChartOutlined /> 快速投票</span>,
      children: (
        <div>
          {isTeacherOrAdmin && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setPollModal(true)}
              style={{ marginBottom: 16 }}>
              创建投票
            </Button>
          )}
          <Spin spinning={pollLoading}>
            {polls.length === 0 ? <Empty description="暂无活跃投票" /> : (
              <List
                dataSource={polls}
                renderItem={(poll: any) => (
                  <Card size="small" style={{ marginBottom: 8 }}>
                    <Text strong>{poll.question}</Text>
                    <Text type="secondary" style={{ marginLeft: 8 }}>共 {poll.total_votes} 票</Text>
                    <div style={{ marginTop: 8 }}>
                      {poll.options.map((opt: any, i: number) => (
                        <div key={i} style={{ marginBottom: 4 }}>
                          {isStudent && votedPoll !== poll.id ? (
                            <Radio value={i} onChange={() => setSelectedOption(i)}
                              checked={selectedOption === i}>
                              {opt.text}
                            </Radio>
                          ) : (
                            <div>
                              <Text>{opt.text}</Text>
                              <Progress percent={opt.percentage || 0} size="small"
                                style={{ marginTop: 2 }} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {isStudent && votedPoll !== poll.id && (
                      <Button type="primary" size="small" icon={<CheckCircleOutlined />}
                        onClick={() => handleVote(poll.id)} style={{ marginTop: 8 }}>
                        提交投票
                      </Button>
                    )}
                    {isTeacherOrAdmin && (
                      <Button size="small" icon={<BarChartOutlined />}
                        onClick={() => handleViewPollResults(poll.id)} style={{ marginTop: 8 }}>
                        查看结果
                      </Button>
                    )}
                  </Card>
                )}
              />
            )}
          </Spin>
        </div>
      ),
    },
    {
      key: 'questions',
      label: <span><QuestionCircleOutlined /> 课堂提问</span>,
      children: (
        <div>
          {isStudent && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAskModal(true)}
              style={{ marginBottom: 16 }}>
              发起提问
            </Button>
          )}
          <Spin spinning={questionLoading}>
            {questions.length === 0 ? <Empty description="暂无提问" /> : (
              <List
                dataSource={questions}
                renderItem={(q: any) => (
                  <Card size="small" style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <div style={{ flex: 1 }}>
                        <Space>
                          {q.is_anonymous ? <Tag>匿名</Tag> : !isStudent && <Tag>{q.student_username}</Tag>}
                          <Tag color={q.status === 'answered' ? 'green' : 'orange'}>
                            {q.status === 'answered' ? '已回答' : '待回答'}
                          </Tag>
                        </Space>
                        <div style={{ marginTop: 4 }}><Text>{q.content}</Text></div>
                        {q.answer && (
                          <div style={{ marginTop: 4, padding: '4px 8px', background: '#f6f8ff', borderRadius: 4 }}>
                            <Text type="secondary">教师回答：</Text>
                            <Text>{q.answer}</Text>
                          </div>
                        )}
                        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                          {q.created_at?.slice(0, 16)}
                        </Text>
                      </div>
                      {isTeacherOrAdmin && q.status === 'pending' && (
                        <Button size="small" type="primary" icon={<SendOutlined />}
                          onClick={() => setAnswerModal(q)}>
                          回答
                        </Button>
                      )}
                    </div>
                  </Card>
                )}
              />
            )}
          </Spin>
        </div>
      ),
    },
  ]

  return (
    <div>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #fa8c16 0%, #f5222d 100%)', border: 'none' }}>
        <div style={{ color: '#fff' }}>
          <Space>
            <ThunderboltOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>课堂互动</Title>
          </Space>
          <Text style={{ color: 'rgba(255,255,255,0.85)', display: 'block', marginTop: 8 }}>
            随堂测验 · 快速投票 · 课堂提问
          </Text>
        </div>
      </Card>

      <Card>
        <Tabs items={tabItems} />
      </Card>

      {/* ── 创建测验弹窗 ── */}
      <Modal title="创建随堂测验" open={quizModal} onCancel={() => setQuizModal(false)}
        footer={null} width={640}>
        <Form form={quizForm} layout="vertical" onFinish={handleCreateQuiz}>
          <Form.Item name="title" label="测验标题" rules={[{ required: true }]}>
            <Input placeholder="例如：第1节随堂小测" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input placeholder="可选说明" />
          </Form.Item>
          <Form.Item name="qtype" label="题型" initialValue="single">
            <Select>
              <Select.Option value="single">单选题</Select.Option>
              <Select.Option value="true_false">判断题</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="questions_text" label="题目（每行一题）" rules={[{ required: true }]}>
            <TextArea rows={5} placeholder="每行一道题目&#10;例如：&#10;信息技术的特点包括？&#10;通用技术的核心思想是？" />
          </Form.Item>
          <Form.Item name="answers" label="参考答案（每行一个，与题目对应）">
            <TextArea rows={3} placeholder="每行一个答案，与题目顺序对应" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={creating} block>创建测验</Button>
        </Form>
      </Modal>

      {/* ── 答题弹窗 ── */}
      <Modal title={takingQuiz?.title} open={!!takingQuiz && !quizResult}
        onCancel={() => { setTakingQuiz(null); setQuizResult(null) }}
        footer={[
          <Button key="submit" type="primary" onClick={handleSubmitQuiz}>提交答案</Button>,
        ]}>
        {takingQuiz?.questions?.map((q: any, i: number) => (
          <div key={i} style={{ marginBottom: 12, padding: 8, background: '#fafafa', borderRadius: 4 }}>
            <Text strong>{i + 1}. {q.question || q.question_text}</Text>
            <div style={{ marginTop: 8 }}>
              {q.type === 'true_false' ? (
                <Radio.Group onChange={(e) => setQuizAnswers({ ...quizAnswers, [i]: e.target.value })}>
                  <Radio value="对">对</Radio>
                  <Radio value="错">错</Radio>
                </Radio.Group>
              ) : (
                <Input onChange={(e) => setQuizAnswers({ ...quizAnswers, [i]: e.target.value })}
                  placeholder="输入答案" />
              )}
            </div>
          </div>
        ))}
      </Modal>

      {/* ── 答题结果 ── */}
      <Modal title="答题结果" open={!!quizResult} onCancel={() => { setQuizResult(null); setTakingQuiz(null) }}
        footer={<Button onClick={() => { setQuizResult(null); setTakingQuiz(null) }}>关闭</Button>}>
        {quizResult && (
          <Result
            status={quizResult.percentage >= 60 ? 'success' : 'warning'}
            title={`${quizResult.score} / ${quizResult.total_score} 分`}
            subTitle={`正确率 ${quizResult.percentage}%`}
          />
        )}
      </Modal>

      {/* ── 测验结果统计弹窗 ── */}
      <Modal title="测验结果" open={!!quizResultsView} onCancel={() => setQuizResultsView(null)}
        footer={null} width={700}>
        {quizResultsView && (
          <>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={8}><Statistic title="题目数" value={quizResultsView.quiz?.question_count} /></Col>
              <Col span={8}><Statistic title="参与人数" value={quizResultsView.total_answers} /></Col>
            </Row>
            <Table dataSource={quizResultsView.question_stats} rowKey="index" size="small" pagination={false}
              columns={[
                { title: '题号', dataIndex: 'index', render: (i: number) => i + 1, width: 60 },
                { title: '题目', dataIndex: 'question', ellipsis: true },
                { title: '正确率', dataIndex: 'correct_rate', width: 100,
                  render: (r: number) => (
                    <Text strong style={{ color: r >= 60 ? '#52c41a' : '#ff4d4f' }}>{r}%</Text>
                  ),
                },
              ]} />
          </>
        )}
      </Modal>

      {/* ── 创建投票弹窗 ── */}
      <Modal title="创建快速投票" open={pollModal} onCancel={() => setPollModal(false)}
        footer={null}>
        <Form form={pollForm} layout="vertical" onFinish={handleCreatePoll}>
          <Form.Item name="question" label="投票问题" rules={[{ required: true }]}>
            <Input placeholder="例如：你更喜欢哪种编程语言？" />
          </Form.Item>
          <Form.Item name="options" label="选项（每行一个）" rules={[{ required: true }]}>
            <TextArea rows={4} placeholder="每行一个选项&#10;例如：&#10;Python&#10;JavaScript&#10;C++" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>创建投票</Button>
        </Form>
      </Modal>

      {/* ── 投票结果弹窗 ── */}
      <Modal title="投票结果" open={!!pollResults} onCancel={() => setPollResults(null)}
        footer={null}>
        {pollResults && (
          <>
            <Text strong style={{ fontSize: 16 }}>{pollResults.question}</Text>
            <div style={{ marginTop: 16 }}>
              {pollResults.options.map((opt: any, i: number) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <Text>{opt.text}</Text>
                  <Text type="secondary" style={{ marginLeft: 8 }}>{opt.votes} 票 ({opt.percentage}%)</Text>
                  <Progress percent={opt.percentage} size="small" />
                </div>
              ))}
            </div>
            <Text type="secondary">共 {pollResults.total_votes} 人参与</Text>
          </>
        )}
      </Modal>

      {/* ── 提问弹窗 ── */}
      <Modal title="发起提问" open={askModal} onCancel={() => setAskModal(false)}
        footer={null}>
        <Form form={askForm} layout="vertical" onFinish={handleAskQuestion}>
          <Form.Item name="content" label="问题内容" rules={[{ required: true }]}>
            <TextArea rows={3} placeholder="输入你的问题..." />
          </Form.Item>
          <Form.Item name="is_anonymous" valuePropName="checked">
            <Radio checked={false}>匿名提问</Radio>
          </Form.Item>
          <Button type="primary" htmlType="submit" block>提交问题</Button>
        </Form>
      </Modal>

      {/* ── 回答弹窗 ── */}
      <Modal title="回答提问" open={!!answerModal} onCancel={() => setAnswerModal(null)}
        footer={[
          <Button key="cancel" onClick={() => setAnswerModal(null)}>取消</Button>,
          <Button key="submit" type="primary" onClick={() => handleAnswerQuestion(answerModal?.id)}>提交回答</Button>,
        ]}>
        <Text strong>问题：</Text>
        <Text>{answerModal?.content}</Text>
        <div style={{ marginTop: 12 }}>
          <TextArea rows={4} value={answerText} onChange={(e) => setAnswerText(e.target.value)}
            placeholder="输入回答..." />
        </div>
      </Modal>
    </div>
  )
}

export default InteractionPage
