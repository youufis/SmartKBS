import React, { useState, useEffect } from 'react'
import {
  Card, Tabs, Button, Space, Typography, List, Tag, Modal,
  Form, Input, Select, message, Empty, Spin, Radio, Result,
  Statistic, Row, Col, Table, Progress, Popconfirm, Checkbox,
} from 'antd'
import {
  ThunderboltOutlined, BarChartOutlined, QuestionCircleOutlined,
  PlusOutlined, PlayCircleOutlined, CheckCircleOutlined,
  SendOutlined, RobotOutlined,
  EditOutlined, DeleteOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import QuizEditor from '../components/QuizEditor'
import type { Question } from '../components/QuizEditor'

const { Title, Text } = Typography
const { TextArea } = Input

const InteractionPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  // ── 随堂测验 ──
  const [quizzes, setQuizzes] = useState<any[]>([])
  const [quizLoading, setQuizLoading] = useState(false)
  const [quizEditorOpen, setQuizEditorOpen] = useState(false)
  const [takingQuiz, setTakingQuiz] = useState<any>(null)
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({})
  const [quizResult, setQuizResult] = useState<any>(null)
  const [quizResultsView, setQuizResultsView] = useState<any>(null)
  const [aiQuizModal, setAiQuizModal] = useState(false)
  const [aiQuizLoading, setAiQuizLoading] = useState(false)
  const [aiQuizResult, setAiQuizResult] = useState<any>(null)
  const [aiQuizForm] = Form.useForm()

  // ── 投票 ──
  const [polls, setPolls] = useState<any[]>([])
  const [pollLoading, setPollLoading] = useState(false)
  const [pollModal, setPollModal] = useState(false)
  const [votedPolls, setVotedPolls] = useState<Record<number, boolean>>({})
  const [selectedOption, setSelectedOption] = useState<Record<number, number | null>>({})
  const [selectedOptions, setSelectedOptions] = useState<Record<number, number[]>>({})
  const [pollForm] = Form.useForm()
  const [pollResults, setPollResults] = useState<any>(null)
  const [aiPollModal, setAiPollModal] = useState(false)
  const [aiPollLoading, setAiPollLoading] = useState(false)
  const [aiPollResult, setAiPollResult] = useState<any>(null)
  const [aiPollForm] = Form.useForm()
  const [myVotedPolls, setMyVotedPolls] = useState<Record<number, any>>({})

  // ── 提问 ──
  const [questions, setQuestions] = useState<any[]>([])
  const [questionLoading, setQuestionLoading] = useState(false)
  const [askModal, setAskModal] = useState(false)
  const [answerModal, setAnswerModal] = useState<any>(null)
  const [answerText, setAnswerText] = useState('')
  const [askForm] = Form.useForm()

  // ── 编辑状态 ──
  const [editQuizModal, setEditQuizModal] = useState<any>(null)
  const [editQuizForm] = Form.useForm()
  const [editPollModal, setEditPollModal] = useState<any>(null)
  const [editPollForm] = Form.useForm()
  const [editQuestionModal, setEditQuestionModal] = useState<any>(null)
  const [editQuestionForm] = Form.useForm()

  // ── 编辑/删除处理 ──
  const handleDeleteQuiz = async (id: number) => {
    try { await apiClient.delete(`/api/interaction/quizzes/${id}`); message.success('已删除'); loadQuizzes() }
    catch { message.error('删除失败') }
  }
  const handleDeletePoll = async (id: number) => {
    try { await apiClient.delete(`/api/interaction/polls/${id}`); message.success('已删除'); loadPolls() }
    catch { message.error('删除失败') }
  }
  const handleDeleteQuestion = async (id: number) => {
    try { await apiClient.delete(`/api/interaction/questions/${id}`); message.success('已删除'); loadQuestions() }
    catch { message.error('删除失败') }
  }
  const handleEditQuiz = async () => {
    const values = await editQuizForm.validateFields()
    try {
      await apiClient.put(`/api/interaction/quizzes/${editQuizModal.id}`, values)
      message.success('已更新'); setEditQuizModal(null); loadQuizzes()
    } catch { message.error('更新失败') }
  }
  const handleEditPoll = async () => {
    const values = await editPollForm.validateFields()
    try {
      await apiClient.put(`/api/interaction/polls/${editPollModal.id}`, {
        question: values.question,
        options: values.options.split('\n').filter((l: string) => l.trim()),
        poll_type: values.poll_type || 'single',
      })
      message.success('已更新'); setEditPollModal(null); loadPolls()
    } catch { message.error('更新失败') }
  }
  const handleEditQuestion = async () => {
    const values = await editQuestionForm.validateFields()
    try {
      await apiClient.put(`/api/interaction/questions/${editQuestionModal.id}`, { content: values.content })
      message.success('已更新'); setEditQuestionModal(null); loadQuestions()
    } catch { message.error('更新失败') }
  }

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

  // ── AI 生成测验 ──
  const handleAiGenerateQuiz = async (values: any) => {
    setAiQuizLoading(true)
    setAiQuizResult(null)
    try {
      const { data } = await apiClient.post('/api/interaction/quizzes/ai-generate', values)
      setAiQuizResult(data)
      if (data.questions?.length > 0) {
        message.success(`AI 生成了 ${data.questions.length} 道题目`)
      } else if (data.error) {
        message.warning(data.error)
      }
    } catch { message.error('AI 生成失败') }
    setAiQuizLoading(false)
  }

  const handleApplyAiQuiz = async () => {
    if (aiQuizResult?.questions) {
      // 直接通过 API 创建测验，保留完整题目结构
      try {
        await apiClient.post('/api/interaction/quizzes', {
          title: aiQuizForm.getFieldValue('topic') + ' - 随堂测验',
          description: '由 AI 自动生成',
          questions: JSON.stringify(aiQuizResult.questions),
        })
        message.success(`成功创建测验，共 ${aiQuizResult.questions.length} 题`)
        setAiQuizModal(false)
        setAiQuizResult(null)
        loadQuizzes()
      } catch (err: any) {
        message.error(err.response?.data?.detail || '创建失败')
      }
    }
  }

  // ── AI 生成投票 ──
  const handleAiGeneratePoll = async (values: any) => {
    setAiPollLoading(true)
    setAiPollResult(null)
    try {
      const { data } = await apiClient.post('/api/interaction/polls/ai-generate', values)
      setAiPollResult(data)
      if (data.poll) {
        message.success('AI 生成了投票')
      } else if (data.error) {
        message.warning(data.error)
      }
    } catch { message.error('AI 生成失败') }
    setAiPollLoading(false)
  }

  const handleApplyAiPoll = () => {
    if (aiPollResult?.poll) {
      pollForm.setFieldsValue({
        question: aiPollResult.poll.question,
        options: aiPollResult.poll.options.join('\n'),
        poll_type: aiPollForm.getFieldValue('poll_type') || 'single',
      })
      message.success('已填入表单，可手动修改')
      setAiPollModal(false)
    }
  }

  // ── AI 建议回答 ──
  const handleAiSuggestAnswer = async (qId: number) => {
    try {
      const { data } = await apiClient.post(`/api/interaction/questions/${qId}/ai-suggest`)
      if (data.suggested_answer) {
        setAnswerText(data.suggested_answer)
        message.success('AI 已生成建议回答，可修改后提交')
      }
    } catch { message.error('AI 建议失败') }
  }

  // ── 创建测验（使用 QuizEditor） ──
  const handleCreateQuiz = async (title: string, description: string, questions: Question[]) => {
    try {
      const formatted = questions.map(q => ({
        type: q.type,
        question: q.question,
        options: q.options,
        answer: q.answer,
        score: q.score || 1,
        explanation: q.explanation || '',
      }))
      await apiClient.post('/api/interaction/quizzes', {
        title,
        description: description || '',
        questions: JSON.stringify(formatted),
      })
      message.success(`测验「${title}」创建成功，共 ${questions.length} 题`)
      setQuizEditorOpen(false)
      loadQuizzes()
    } catch (err: any) {
      message.error(err.response?.data?.detail || '创建失败')
      throw err
    }
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
      await apiClient.post('/api/interaction/polls', {
        question: values.question,
        options,
        poll_type: values.poll_type || 'single',
      })
      message.success('投票创建成功')
      setPollModal(false)
      pollForm.resetFields()
      loadPolls()
    } catch (err: any) {
      message.error(err.response?.data?.detail || '创建失败')
    }
  }

  const handleVote = async (pollId: number) => {
    const poll = polls.find(p => p.id === pollId)
    if (!poll) return
    const isMultiple = poll.poll_type === 'multiple'

    if (isMultiple) {
      const selOpts = selectedOptions[pollId] || []
      if (selOpts.length === 0) { message.warning('请至少选择一个选项'); return }
      const indicesStr = selOpts.sort().join(',')
      try {
        await apiClient.post(`/api/interaction/polls/${pollId}/vote`, null, {
          params: { option_indices: indicesStr },
        })
        message.success('投票成功')
        setVotedPolls({ ...votedPolls, [pollId]: true })
        setMyVotedPolls({ ...myVotedPolls, [pollId]: selOpts })
        loadPolls()
      } catch (err: any) {
        message.error(err.response?.data?.detail || '投票失败')
      }
    } else {
      const selOpt = selectedOption[pollId]
      if (selOpt === undefined || selOpt === null) { message.warning('请选择一个选项'); return }
      try {
        await apiClient.post(`/api/interaction/polls/${pollId}/vote`, null, {
          params: { option_index: selOpt },
        })
        message.success('投票成功')
        setVotedPolls({ ...votedPolls, [pollId]: true })
        setMyVotedPolls({ ...myVotedPolls, [pollId]: selOpt })
        loadPolls()
      } catch (err: any) {
        message.error(err.response?.data?.detail || '投票失败')
      }
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
            <Space style={{ marginBottom: 16 }}>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setQuizEditorOpen(true)}>
                创建测验
              </Button>
              <Button icon={<RobotOutlined />} onClick={() => setAiQuizModal(true)}>
                AI 生成
              </Button>
            </Space>
          )}
          {/* 使用 QuizEditor 组件（完整编辑器） */}
          <QuizEditor
            open={quizEditorOpen}
            onCancel={() => setQuizEditorOpen(false)}
            onSave={handleCreateQuiz}
          />
          <Spin spinning={quizLoading}>
            {quizzes.length === 0 ? <Empty description="暂无测验" /> : (
              <List
                dataSource={quizzes}
                renderItem={(quiz: any) => (
                  <Card size="small" style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <Text strong>{quiz.title}</Text>
                        {quiz.description && <Text type="secondary" style={{ marginLeft: 8 }}>{quiz.description}</Text>}
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
                            onClick={() => handleStartQuiz(quiz)}>开始答题</Button>
                        )}
                        {isTeacherOrAdmin && (
                          <>
                            <Button size="small" icon={<BarChartOutlined />}
                              onClick={() => handleViewQuizResults(quiz.id)}>查看结果</Button>
                            <Button size="small" icon={<EditOutlined />}
                              onClick={() => { editQuizForm.setFieldsValue(quiz); setEditQuizModal(quiz) }}>编辑</Button>
                            <Popconfirm title="删除此测验？" onConfirm={() => handleDeleteQuiz(quiz.id)}>
                              <Button size="small" danger icon={<DeleteOutlined />} />
                            </Popconfirm>
                          </>
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
            <Space style={{ marginBottom: 16 }}>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setPollModal(true)}>
                创建投票
              </Button>
              <Button icon={<RobotOutlined />} onClick={() => setAiPollModal(true)}>
                AI 生成
              </Button>
            </Space>
          )}
          <Spin spinning={pollLoading}>
            {polls.length === 0 ? <Empty description="暂无活跃投票" /> : (
              <List
                dataSource={polls}
                renderItem={(poll: any) => {
                  const isMultiple = poll.poll_type === 'multiple'
                  const hasVoted = votedPolls[poll.id]
                  return (
                    <Card size="small" style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Space>
                          <Text strong>{poll.question}</Text>
                          <Tag color={isMultiple ? 'purple' : 'blue'}>
                            {isMultiple ? '多选' : '单选'}
                          </Tag>
                        </Space>
                        <Space>
                          <Text type="secondary">
                            {poll.unique_voters || poll.total_votes} 人参与
                          </Text>
                          {isTeacherOrAdmin && (
                            <>
                              <Button size="small" type="text" icon={<EditOutlined />}
                                onClick={() => {
                                  editPollForm.setFieldsValue({
                                    question: poll.question,
                                    options: poll.options.map((o: any) => o.text).join('\n'),
                                    poll_type: poll.poll_type,
                                  })
                                  setEditPollModal(poll)
                                }} />
                              <Popconfirm title="删除此投票？" onConfirm={() => handleDeletePoll(poll.id)}>
                                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                              </Popconfirm>
                            </>
                          )}
                        </Space>
                      </div>
                      <div style={{ marginTop: 8 }}>
                        {poll.options.map((opt: any, i: number) => (
                          <div key={i} style={{ marginBottom: 4 }}>
                            {isStudent && !hasVoted ? (
                              isMultiple ? (
                                <Checkbox
                                  checked={(selectedOptions[poll.id] || []).includes(i)}
                                  onChange={(e) => {
                                    const current = selectedOptions[poll.id] || []
                                    const updated = e.target.checked
                                      ? [...current, i]
                                      : current.filter((v: number) => v !== i)
                                    setSelectedOptions({ ...selectedOptions, [poll.id]: updated })
                                  }}
                                >
                                  {opt.text}
                                </Checkbox>
                              ) : (
                                <Radio
                                  checked={selectedOption[poll.id] === i}
                                  onChange={() => setSelectedOption({ ...selectedOption, [poll.id]: i })}
                                >
                                  {opt.text}
                                </Radio>
                              )
                            ) : (
                              <div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                  <Text>{opt.text}</Text>
                                  <Text type="secondary">{opt.votes} 票 ({opt.percentage || 0}%)</Text>
                                </div>
                                <Progress percent={opt.percentage || 0} size="small" style={{ marginTop: 2 }} />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      {isStudent && !hasVoted && (
                        <Button type="primary" size="small" icon={<CheckCircleOutlined />}
                          onClick={() => handleVote(poll.id)} style={{ marginTop: 8 }}>提交投票</Button>
                      )}
                      {hasVoted && isStudent && (
                        <Tag color="green" style={{ marginTop: 8 }}>✓ 已投票</Tag>
                      )}
                      {isTeacherOrAdmin && (
                        <Button size="small" icon={<BarChartOutlined />}
                          onClick={() => handleViewPollResults(poll.id)} style={{ marginTop: 8 }}>查看结果</Button>
                      )}
                    </Card>
                  )
                }}
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
                    <div>
                      {/* 顶栏：学生信息左，操作按钮右 */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Space>
                          {q.is_anonymous ? <Tag>匿名</Tag> : !isStudent && <Tag>{q.student_username}</Tag>}
                          <Tag color={q.status === 'answered' ? 'green' : 'orange'}>
                            {q.status === 'answered' ? '已回答' : '待回答'}
                          </Tag>
                          <Text type="secondary" style={{ fontSize: 11 }}>{q.created_at?.slice(0, 16)}</Text>
                        </Space>
                        <Space size={4}>
                          {isTeacherOrAdmin && (
                            <Button size="small" type={q.status === 'pending' ? 'primary' : 'default'}
                              icon={<SendOutlined />}
                              onClick={() => { setAnswerText(q.answer || ''); setAnswerModal(q) }}>
                              {q.status === 'pending' ? '回答' : '编辑'}
                            </Button>
                          )}
                          {isStudent && q.student_username === user?.username && (
                            <Button size="small" type="text" icon={<EditOutlined />}
                              onClick={() => {
                                editQuestionForm.setFieldsValue({ content: q.content })
                                setEditQuestionModal(q)
                              }} />
                          )}
                          {(isTeacherOrAdmin || q.student_username === user?.username) && (
                            <Popconfirm title="删除此提问？" onConfirm={() => handleDeleteQuestion(q.id)}>
                              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                            </Popconfirm>
                          )}
                        </Space>
                      </div>
                      {/* 问题内容 */}
                      <div style={{ marginTop: 8 }} className="markdown-content">
                        <ReactMarkdown>{q.content}</ReactMarkdown>
                      </div>
                      {/* 教师回答 */}
                      {q.answer && (
                        <div style={{ marginTop: 8, padding: 10, background: '#f6f8ff', borderRadius: 6, borderLeft: '3px solid #1677ff' }}>
                          <Text type="secondary" strong>教师回答：</Text>
                          <div className="markdown-content">
                            <ReactMarkdown>{q.answer}</ReactMarkdown>
                          </div>
                        </div>
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

      {/* ── 答题弹窗 ── */}
      <Modal title={takingQuiz?.title} open={!!takingQuiz && !quizResult}
        onCancel={() => { setTakingQuiz(null); setQuizResult(null) }}
        footer={[
          <Button key="submit" type="primary" onClick={handleSubmitQuiz}>提交答案</Button>,
        ]}
        width={640}>
        {takingQuiz?.questions?.map((q: any, i: number) => (
          <div key={i} style={{ marginBottom: 12, padding: 12, background: '#fafafa', borderRadius: 4, border: '1px solid #f0f0f0' }}>
            <Space style={{ marginBottom: 8 }}>
              <Text strong>{i + 1}. {q.question || q.question_text}</Text>
              {q.type === 'single' && <Tag color="blue" style={{ fontSize: 11 }}>单选题</Tag>}
              {q.type === 'multiple' && <Tag color="purple" style={{ fontSize: 11 }}>多选题</Tag>}
              {q.type === 'true_false' && <Tag color="orange" style={{ fontSize: 11 }}>判断题</Tag>}
            </Space>
            <div style={{ marginTop: 8, paddingLeft: 8 }}>
              {q.type === 'single' && q.options ? (
                <Radio.Group onChange={(e) => setQuizAnswers({ ...quizAnswers, [i]: e.target.value })}>
                  <Space direction="vertical">
                    {q.options.map((opt: string, j: number) => (
                      <Radio key={j} value={opt.charAt(0)} style={{ lineHeight: 2 }}>{opt}</Radio>
                    ))}
                  </Space>
                </Radio.Group>
              ) : q.type === 'multiple' && q.options ? (
                <Checkbox.Group onChange={(vals) => setQuizAnswers({ ...quizAnswers, [i]: (vals as string[]).sort().join(',') })}>
                  <Space direction="vertical">
                    {q.options.map((opt: string, j: number) => (
                      <Checkbox key={j} value={opt.charAt(0)} style={{ lineHeight: 2 }}>{opt}</Checkbox>
                    ))}
                  </Space>
                </Checkbox.Group>
              ) : q.type === 'true_false' ? (
                <Radio.Group onChange={(e) => setQuizAnswers({ ...quizAnswers, [i]: e.target.value })}>
                  <Space>
                    <Radio value="对" style={{ lineHeight: 2 }}>对</Radio>
                    <Radio value="错" style={{ lineHeight: 2 }}>错</Radio>
                  </Space>
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

      {/* ── AI 生成测验弹窗 ── */}
      <Modal title={<Space><RobotOutlined />AI 生成随堂测验</Space>} open={aiQuizModal}
        onCancel={() => { setAiQuizModal(false); setAiQuizResult(null) }}
        footer={aiQuizResult?.questions?.length > 0 ? [
          <Button key="cancel" onClick={() => { setAiQuizModal(false); setAiQuizResult(null) }}>取消</Button>,
          <Button key="apply" type="primary" onClick={handleApplyAiQuiz}>填入表单</Button>,
        ] : null}>
        <Form form={aiQuizForm} layout="vertical" onFinish={handleAiGenerateQuiz}>
          <Form.Item name="topic" label="输入主题" rules={[{ required: true, message: '请输入主题' }]}>
            <Input placeholder="例如：信息技术的发展历程、通用技术中的设计原则" />
          </Form.Item>
          <Form.Item name="subject" label="学科" initialValue="信息技术">
            <Select>
              <Select.Option value="信息技术">信息技术</Select.Option>
              <Select.Option value="通用技术">通用技术</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="question_type" label="题型" initialValue="single">
            <Select>
              <Select.Option value="single">单选题</Select.Option>
              <Select.Option value="true_false">判断题</Select.Option>
              <Select.Option value="mixed">混合</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="count" label="题目数量" initialValue={5}>
            <Select>
              {[3, 5, 10].map(n => <Select.Option key={n} value={n}>{n} 题</Select.Option>)}
            </Select>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={aiQuizLoading} icon={<RobotOutlined />} block>
            AI 生成
          </Button>
        </Form>
        {aiQuizResult?.questions?.length > 0 && (
          <div style={{ marginTop: 12, maxHeight: 400, overflow: 'auto' }}>
            <Text strong style={{ fontSize: 15 }}>生成结果（{aiQuizResult.questions.length} 题）：</Text>
            {aiQuizResult.questions.map((q: any, i: number) => (
              <div key={i} style={{
                padding: 10, marginTop: 8, borderRadius: 6,
                background: '#fafafa', border: '1px solid #f0f0f0',
              }}>
                <Text strong>{i + 1}. {q.question}</Text>
                {q.options && (
                  <div style={{ marginTop: 4, paddingLeft: 16 }}>
                    {q.options.map((opt: string, j: number) => (
                      <div key={j} style={{ fontSize: 13, color: '#555' }}>{opt}</div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 4 }}>
                  <Tag color="green">答案：{q.answer}</Tag>
                </div>
                {q.explanation && (
                  <div style={{ marginTop: 2, fontSize: 12, color: '#888', paddingLeft: 4 }}>
                    💡 {q.explanation}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* ── AI 生成投票弹窗 ── */}
      <Modal title={<Space><RobotOutlined />AI 生成投票</Space>} open={aiPollModal}
        onCancel={() => { setAiPollModal(false); setAiPollResult(null) }}
        footer={aiPollResult?.poll ? [
          <Button key="cancel" onClick={() => { setAiPollModal(false); setAiPollResult(null) }}>取消</Button>,
          <Button key="apply" type="primary" onClick={handleApplyAiPoll}>填入表单</Button>,
        ] : null}>
        <Form form={aiPollForm} layout="vertical" onFinish={handleAiGeneratePoll}>
          <Form.Item name="topic" label="投票主题" rules={[{ required: true }]}>
            <Input placeholder="例如：你更喜欢哪种学习方式？" />
          </Form.Item>
          <Form.Item name="poll_type" label="投票类型" initialValue="single">
            <Select>
              <Select.Option value="single">单选投票</Select.Option>
              <Select.Option value="multiple">多选投票</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="option_count" label="选项数量" initialValue={4}>
            <Select>
              {[2, 3, 4, 5, 6].map(n => <Select.Option key={n} value={n}>{n} 个</Select.Option>)}
            </Select>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={aiPollLoading} icon={<RobotOutlined />} block>
            AI 生成
          </Button>
        </Form>
        {aiPollResult?.poll && (
          <div style={{ marginTop: 12 }}>
            <Text strong>投票问题：</Text>
            <Text>{aiPollResult.poll.question}</Text>
            <div style={{ marginTop: 8 }}>
              {aiPollResult.poll.options.map((opt: string, i: number) => (
                <div key={i} style={{ padding: '2px 0' }}>• {opt}</div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* ── 创建投票弹窗 ── */}
      <Modal title="创建快速投票" open={pollModal} onCancel={() => setPollModal(false)}
        footer={null}>
        <Form form={pollForm} layout="vertical" onFinish={handleCreatePoll}>
          <Form.Item name="question" label="投票问题" rules={[{ required: true }]}>
            <Input placeholder="例如：你更喜欢哪种编程语言？" />
          </Form.Item>
          <Form.Item name="poll_type" label="投票类型" initialValue="single">
            <Select>
              <Select.Option value="single">单选投票</Select.Option>
              <Select.Option value="multiple">多选投票</Select.Option>
            </Select>
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
            <Space style={{ marginBottom: 12 }}>
              <Text strong style={{ fontSize: 16 }}>{pollResults.question}</Text>
              <Tag color={pollResults.poll_type === 'multiple' ? 'purple' : 'blue'}>
                {pollResults.poll_type === 'multiple' ? '多选' : '单选'}
              </Tag>
            </Space>
            <div style={{ marginTop: 8 }}>
              {pollResults.options.map((opt: any, i: number) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text>{opt.text}</Text>
                    <Text type="secondary">{opt.votes} 票 ({opt.percentage}%)</Text>
                  </div>
                  <Progress percent={opt.percentage} size="small" />
                </div>
              ))}
            </div>
            <div>
              <Text type="secondary">共 {pollResults.unique_voters ?? pollResults.total_votes} 人参与</Text>
              {pollResults.poll_type === 'multiple' && pollResults.unique_voters ? (
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  （共 {pollResults.total_votes} 票）
                </Text>
              ) : null}
            </div>
          </>
        )}
      </Modal>

      {/* ── 提问弹窗 ── */}
      <Modal title="发起提问" open={askModal} onCancel={() => setAskModal(false)}
        footer={null}>
        <Form form={askForm} layout="vertical" onFinish={handleAskQuestion}>
          <Form.Item name="content" label="问题内容" rules={[{ required: true }]}>
            <TextArea rows={3} placeholder="输入你的问题...（支持 Markdown 格式）" />
          </Form.Item>
          <Form.Item name="is_anonymous" valuePropName="checked">
            <Radio checked={false}>匿名提问</Radio>
          </Form.Item>
          <Button type="primary" htmlType="submit" block>提交问题</Button>
        </Form>
      </Modal>

      {/* ── 编辑测验弹窗 ── */}
      <Modal title="编辑测验" open={!!editQuizModal} onCancel={() => setEditQuizModal(null)}
        onOk={handleEditQuiz} okText="保存">
        <Form form={editQuizForm} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select>
              <Select.Option value="active">进行中</Select.Option>
              <Select.Option value="closed">已结束</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 编辑投票弹窗 ── */}
      <Modal title="编辑投票" open={!!editPollModal} onCancel={() => setEditPollModal(null)}
        onOk={handleEditPoll} okText="保存">
        <Form form={editPollForm} layout="vertical">
          <Form.Item name="question" label="问题" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="poll_type" label="投票类型">
            <Select>
              <Select.Option value="single">单选投票</Select.Option>
              <Select.Option value="multiple">多选投票</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="options" label="选项（每行一个）" rules={[{ required: true }]}>
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 编辑提问弹窗 ── */}
      <Modal title="编辑提问" open={!!editQuestionModal} onCancel={() => setEditQuestionModal(null)}
        onOk={handleEditQuestion} okText="保存">
        <Form form={editQuestionForm} layout="vertical">
          <Form.Item name="content" label="内容" rules={[{ required: true }]}>
            <TextArea rows={4} placeholder="支持 Markdown 格式" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 回答弹窗 ── */}
      <Modal title={answerModal?.status === 'answered' ? '编辑回答' : '回答提问'} open={!!answerModal} onCancel={() => setAnswerModal(null)}
        footer={[
          <Button key="cancel" onClick={() => setAnswerModal(null)}>取消</Button>,
          <Button key="aisuggest" icon={<RobotOutlined />} onClick={() => handleAiSuggestAnswer(answerModal?.id)}>
            AI 建议
          </Button>,
          <Button key="submit" type="primary" onClick={() => handleAnswerQuestion(answerModal?.id)}>提交回答</Button>,
        ]}>
        <Text strong>问题：</Text>
        <div className="markdown-content"><ReactMarkdown>{answerModal?.content || ''}</ReactMarkdown></div>
        <div style={{ marginTop: 12 }}>
          <TextArea rows={4} value={answerText} onChange={(e) => setAnswerText(e.target.value)}
            placeholder="输入回答（支持 Markdown），或点击「AI 建议」生成..." />
        </div>
      </Modal>
    </div>
  )
}

export default InteractionPage
