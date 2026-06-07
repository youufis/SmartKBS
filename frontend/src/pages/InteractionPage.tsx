import React, { useState, useEffect } from 'react'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import {
  Card, Tabs, Button, Space, Typography, List, Tag, Modal,
  Form, Input, InputNumber, Select, message, Empty, Spin, Radio, Result,
  Statistic, Row, Col, Table, Progress, Popconfirm, Checkbox, Divider, Pagination,
} from 'antd'
import {
  ThunderboltOutlined, BarChartOutlined, QuestionCircleOutlined,
  PlusOutlined, PlayCircleOutlined, CheckCircleOutlined,
  SendOutlined, RobotOutlined,
  EditOutlined, DeleteOutlined, DownloadOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import QuizEditor from '../components/QuizEditor'
import { StudentView as PracticeStudentView, TeacherView as PracticeTeacherView } from '../pages/PracticePage'
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
  const [quizAiAnalysis, setQuizAiAnalysis] = useState<string | null>(null)
  const [quizAiAnalysisLoading, setQuizAiAnalysisLoading] = useState(false)
  const [aiQuizModal, setAiQuizModal] = useState(false)
  const [aiQuizLoading, setAiQuizLoading] = useState(false)
  const [aiQuizResult, setAiQuizResult] = useState<any>(null)
  const [aiQuizForm] = Form.useForm()
  const [subjectOptions, setSubjectOptions] = useState<string[]>(['信息科技', '通用技术'])

  // 列表分页
  const [quizPage, setQuizPage] = useState(1)
  const [quizPageSize, setQuizPageSize] = useState(10)
  const [pollPage, setPollPage] = useState(1)
  const [pollPageSize, setPollPageSize] = useState(10)
  const [questionPage, setQuestionPage] = useState(1)
  const [questionPageSize, setQuestionPageSize] = useState(10)

  // 从系统配置加载课程列表
  useEffect(() => {
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setSubjectOptions(data.subjects)
    }).catch(() => {})
  }, [])

  // ── 投票 ──
  const [polls, setPolls] = useState<any[]>([])
  const [pollLoading, setPollLoading] = useState(false)
  const [pollModal, setPollModal] = useState(false)
  const [votedPolls, setVotedPolls] = useState<Record<number, boolean>>({})
  const [selectedOption, setSelectedOption] = useState<Record<number, number | null>>({})
  const [selectedOptions, setSelectedOptions] = useState<Record<number, number[]>>({})
  const [pollForm] = Form.useForm()
  const [takingPoll, setTakingPoll] = useState<any>(null)
  const [pollResult, setPollResult] = useState<any>(null)
  const [aiPollModal, setAiPollModal] = useState(false)
  const [aiPollLoading, setAiPollLoading] = useState(false)
  const [aiPollResult, setAiPollResult] = useState<any>(null)
  const [aiPollForm] = Form.useForm()

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
      const polls = data.polls || []
      setPolls(polls)
      // 同步后端 voted 字段到 votedPolls 状态
      const votedMap: Record<number, boolean> = {}
      for (const p of polls) {
        votedMap[p.id] = p.voted === true
      }
      setVotedPolls(votedMap)
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── AI 生成测验 ──
  const handleAiGenerateQuiz = async (values: any) => {
    setAiQuizLoading(true)
    setAiQuizResult(null)
    try {
      console.log('生成测验参数:', values)
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
      const url = isStudent
        ? `/api/interaction/quizzes/${quizId}/my-result`
        : `/api/interaction/quizzes/${quizId}/results`
      const { data } = await apiClient.get(url)
      setQuizResultsView(data)
      setQuizAiAnalysis(null)
    } catch { message.error('加载结果失败') }
  }

  const handleQuizAiAnalysis = async (quizId: number) => {
    if (!quizId) return
    setQuizAiAnalysisLoading(true)
    setQuizAiAnalysis(null)
    try {
      const { data } = await apiClient.get(`/api/interaction/quizzes/${quizId}/ai-analysis`)
      if (data.task_id) {
        // 异步任务，轮询结果
        const result = await pollAiTask(data.task_id)
        if (result) setQuizAiAnalysis(result.analysis)
        else message.error('AI 分析超时')
      } else {
        // 兼容旧版同步返回
        setQuizAiAnalysis(data.analysis)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'AI 分析失败')
    }
    setQuizAiAnalysisLoading(false)
  }

  // ── AI 课堂总结 ──
  const [classSummaryLoading, setClassSummaryLoading] = useState(false)
  const [classSummaryData, setClassSummaryData] = useState<{ summary: string; data?: any } | null>(null)
  const handleClassSummary = async () => {
    setClassSummaryLoading(true)
    setClassSummaryData(null)
    try {
      const { data } = await apiClient.get('/api/interaction/class-summary', {
        params: { grade: user?.grade || '', cls: user?.class || '', subject: '信息科技', teacher_username: user?.username },
      })
      if (data.task_id) {
        const result = await pollAiTask(data.task_id)
        if (result) setClassSummaryData(result)
      } else {
        setClassSummaryData(data)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '生成课堂总结失败')
    }
    setClassSummaryLoading(false)
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
        loadPolls()
        setTakingPoll(null)
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
        loadPolls()
        setTakingPoll(null)
      } catch (err: any) {
        message.error(err.response?.data?.detail || '投票失败')
      }
    }
  }

  const handleViewPollResults = async (pollId: number) => {
    try {
      const { data } = await apiClient.get(`/api/interaction/polls/${pollId}/results`)
      setPollResult(data)
    } catch { message.error('加载结果失败') }
  }

  const handleStartPoll = (poll: any) => {
    setSelectedOption({})
    setSelectedOptions({})
    setTakingPoll(poll)
    setPollResult(null)
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
      key: 'practice',
      label: <span><RobotOutlined /> 智能练习</span>,
      children: isTeacherOrAdmin ? <PracticeTeacherView /> : <PracticeStudentView />,
    },
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
              <Button icon={<RobotOutlined />} onClick={() => { setAiQuizModal(true); setAiQuizResult(null); aiQuizForm.resetFields(); }}>
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
              <>
                <List
                  dataSource={quizzes.slice((quizPage - 1) * quizPageSize, quizPage * quizPageSize)}
                  renderItem={(quiz: any) => (
                  <Card size="small" style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <Text strong>{quiz.title}</Text>
                        <div style={{ marginTop: 4 }}>
                          <Tag>{quiz.questions?.length || 0} 题</Tag>
                          <Tag color={quiz.status === 'active' ? 'green' : 'default'}>
                            {quiz.status === 'active' ? '进行中' : '已结束'}
                          </Tag>
                          <Tag color="blue">{quiz.creator_name || quiz.creator_username}</Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>{quiz.answer_count || 0} 人参与</Text>
                        </div>
                      </div>
                      <Space>
                        {quiz.status === 'active' && isStudent && !quiz.answered && (
                          <Button size="small" type="primary" icon={<PlayCircleOutlined />}
                            onClick={() => handleStartQuiz(quiz)}>开始答题</Button>
                        )}
                        {quiz.status === 'active' && isStudent && quiz.answered && (
                          <Button size="small" icon={<BarChartOutlined />}
                            onClick={() => handleViewQuizResults(quiz.id)}>查看结果</Button>
                        )}
                        {isTeacherOrAdmin && (
                          <>
                            <Button size="small" icon={<BarChartOutlined />}
                              onClick={() => handleViewQuizResults(quiz.id)}>查看结果</Button>
                            <Button size="small" icon={<DownloadOutlined />}
                              onClick={() => {
                                const token = localStorage.getItem('smartkb_token')
                                window.open(`/api/export/quiz/${quiz.id}?token=${token}`, '_blank')
                              }}>导出</Button>
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
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <Pagination
                  current={quizPage} pageSize={quizPageSize} total={quizzes.length}
                  showSizeChanger showTotal={(t) => `共 ${t} 个测验`}
                  pageSizeOptions={['5', '10', '20', '50']}
                  onChange={(p, ps) => { setQuizPage(p); setQuizPageSize(ps) }}
                  size="small"
                />
              </div>
            </>
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
              <>
              <List
                dataSource={polls.slice((pollPage - 1) * pollPageSize, pollPage * pollPageSize)}
                renderItem={(poll: any) => {
                  const isMultiple = poll.poll_type === 'multiple'
                  const hasVoted = poll.voted ?? votedPolls[poll.id]
                  return (
                    <Card size="small" style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1 }}>
                          <Text strong><FormulaRenderer content={poll.question} /></Text>
                          <div style={{ marginTop: 4 }}>
                            <Tag color={isMultiple ? 'purple' : 'blue'}>
                              {isMultiple ? '多选' : '单选'}
                            </Tag>
                            <Tag color="blue">{poll.creator_name || poll.creator_username}</Tag>
                            <Text type="secondary" style={{ fontSize: 12 }}>{poll.unique_voters || poll.total_votes} 人参与</Text>
                          </div>
                        </div>
                        <Space>
                          {isStudent && !hasVoted && (
                            <Button size="small" type="primary" icon={<CheckCircleOutlined />}
                              onClick={() => handleStartPoll(poll)}>开始投票</Button>
                          )}
                          {isStudent && hasVoted && (
                            <Button size="small" icon={<BarChartOutlined />}
                              onClick={() => handleViewPollResults(poll.id)}>已投票</Button>
                          )}
                          {isTeacherOrAdmin && (
                            <>
                              <Button size="small" icon={<BarChartOutlined />}
                                onClick={() => handleViewPollResults(poll.id)}>查看结果</Button>
                              <Button size="small" icon={<DownloadOutlined />}
                                onClick={() => {
                                  const token = localStorage.getItem('smartkb_token')
                                  window.open(`/api/export/poll/${poll.id}?token=${token}`, '_blank')
                                }}>导出</Button>
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
                    </Card>
                  )
                }}
              />
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <Pagination
                  current={pollPage} pageSize={pollPageSize} total={polls.length}
                  showSizeChanger showTotal={(t) => `共 ${t} 个投票`}
                  pageSizeOptions={['5', '10', '20', '50']}
                  onChange={(p, ps) => { setPollPage(p); setPollPageSize(ps) }}
                  size="small"
                />
              </div>
            </>
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
              <>
              <List
                dataSource={questions.slice((questionPage - 1) * questionPageSize, questionPage * questionPageSize)}
                renderItem={(q: any) => {
                  const qContent = q.content?.length > 50 ? q.content.slice(0, 50) + '...' : q.content
                  return (
                    <Card size="small" style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1 }}>
                          <Text strong>{qContent}</Text>
                          <div style={{ marginTop: 4 }}>
                            {q.is_anonymous ? <Tag>匿名</Tag> : !isStudent && <Tag>{q.student_username}</Tag>}
                            <Tag color={q.status === 'answered' ? 'green' : 'orange'}>
                              {q.status === 'answered' ? '已回答' : '待回答'}
                            </Tag>
                            <Text type="secondary" style={{ fontSize: 12 }}>{q.created_at?.slice(0, 16)}</Text>
                          </div>
                        </div>
                        <Space>
                          {isStudent && (
                            <Button size="small" type="primary" icon={<QuestionCircleOutlined />}
                              onClick={() => { setAnswerText(q.answer || ''); setAnswerModal(q) }}>查看详情</Button>
                          )}
                          {isTeacherOrAdmin && (
                            <>
                              <Button size="small" type={q.status === 'pending' ? 'primary' : 'default'}
                                icon={<SendOutlined />}
                                onClick={() => { setAnswerText(q.answer || ''); setAnswerModal(q) }}>
                                {q.status === 'pending' ? '回答' : '编辑'}
                              </Button>
                              <Popconfirm title="删除此提问？" onConfirm={() => handleDeleteQuestion(q.id)}>
                                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                              </Popconfirm>
                            </>
                          )}
                          {isStudent && q.student_username === user?.username && (
                            <Popconfirm title="删除此提问？" onConfirm={() => handleDeleteQuestion(q.id)}>
                              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                            </Popconfirm>
                          )}
                        </Space>
                      </div>
                    </Card>
                  )
                }}
              />
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <Pagination
                  current={questionPage} pageSize={questionPageSize} total={questions.length}
                  showSizeChanger showTotal={(t) => `共 ${t} 个提问`}
                  pageSizeOptions={['5', '10', '20', '50']}
                  onChange={(p, ps) => { setQuestionPage(p); setQuestionPageSize(ps) }}
                  size="small"
                />
              </div>
            </>
            )}
          </Spin>
        </div>
      ),
    },
    ...(isTeacherOrAdmin ? [{
      key: 'summary',
      label: <span><RobotOutlined /> 课堂总结</span>,
      children: (
        <div>
          {isTeacherOrAdmin && (
            <Space style={{ marginBottom: 16 }}>
              <Button icon={<RobotOutlined />} onClick={handleClassSummary} loading={classSummaryLoading}>
                AI 课堂总结
              </Button>
            </Space>
          )}
          {classSummaryData && (
            <>
              <Row gutter={12} style={{ marginBottom: 12 }}>
                <Col span={6}><Statistic title="测验数" value={classSummaryData.data?.quiz_count || 0} /></Col>
                <Col span={6}><Statistic title="投票数" value={classSummaryData.data?.poll_count || 0} /></Col>
                <Col span={6}><Statistic title="提问数" value={classSummaryData.data?.question_count || 0} /></Col>
                <Col span={6}><Statistic title="参与学生" value={classSummaryData.data?.student_count || 0} /></Col>
              </Row>
              <Card style={{ background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                <div className="markdown-content">
                  <ReactMarkdown>{classSummaryData.summary}</ReactMarkdown>
                </div>
              </Card>
            </>
          )}
          {!classSummaryData && !classSummaryLoading && (
            <Empty description="点击「AI 课堂总结」生成综合分析报告" />
          )}
        </div>
      ),
    }] : []),
  ]

  return (
    <div>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <ThunderboltOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>课堂互动</Title>
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 12 }}>
              随堂测验 · 快速投票 · 课堂提问 · 智能练习
            </Text>
          </Space>
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
            <div style={{ marginBottom: 8 }}>
              <Text strong>{i + 1}. </Text>
              <FormulaRenderer content={q.question || q.question_text} />
              {q.type === 'single' && <Tag color="blue" style={{ fontSize: 11, marginLeft: 8 }}>单选题</Tag>}
              {q.type === 'multiple' && <Tag color="purple" style={{ fontSize: 11, marginLeft: 8 }}>多选题</Tag>}
              {q.type === 'true_false' && <Tag color="orange" style={{ fontSize: 11, marginLeft: 8 }}>判断题</Tag>}
            </div>
            <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} size="normal" />
            <div style={{ marginTop: 8, paddingLeft: 8 }}>
              {q.type === 'single' && q.options ? (
                <Radio.Group onChange={(e) => setQuizAnswers({ ...quizAnswers, [i]: e.target.value })}>
                  <Space direction="vertical">
                    {q.options.map((opt: string, j: number) => (
                      <Radio key={j} value={opt.charAt(0)} style={{ lineHeight: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><FormulaRenderer content={opt} inline /></Radio>
                    ))}
                  </Space>
                </Radio.Group>
              ) : q.type === 'multiple' && q.options ? (
                <Checkbox.Group onChange={(vals) => setQuizAnswers({ ...quizAnswers, [i]: (vals as string[]).sort().join(',') })}>
                  <Space direction="vertical">
                    {q.options.map((opt: string, j: number) => (
                      <Checkbox key={j} value={opt.charAt(0)} style={{ lineHeight: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><FormulaRenderer content={opt} inline /></Checkbox>
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

      {/* ── 投票弹窗 ── */}
      <Modal title={takingPoll?.question} open={!!takingPoll && !pollResult}
        onCancel={() => { setTakingPoll(null); setPollResult(null) }}
        footer={[
          <Button key="submit" type="primary" onClick={() => handleVote(takingPoll?.id)}>提交投票</Button>,
        ]}
        width={500}>
        {takingPoll?.options?.map((opt: any, i: number) => (
          <div key={i} style={{ marginBottom: 8, padding: '8px 12px', background: '#fafafa', borderRadius: 4, border: '1px solid #f0f0f0' }}>
            {takingPoll.poll_type === 'multiple' ? (
              <Checkbox
                checked={(selectedOptions[takingPoll.id] || []).includes(i)}
                onChange={(e) => {
                  const current = selectedOptions[takingPoll.id] || []
                  const updated = e.target.checked
                    ? [...current, i]
                    : current.filter((v: number) => v !== i)
                  setSelectedOptions({ ...selectedOptions, [takingPoll.id]: updated })
                }}
              >
                {opt.text}
              </Checkbox>
            ) : (
              <Radio
                checked={selectedOption[takingPoll.id] === i}
                onChange={() => setSelectedOption({ ...selectedOption, [takingPoll.id]: i })}
              >
                {opt.text}
              </Radio>
            )}
          </div>
        ))}
      </Modal>

      {/* ── 投票结果弹窗 ── */}
      <Modal title={pollResult?.question || '投票结果'} open={!!pollResult}
        onCancel={() => setPollResult(null)}
        footer={<Button onClick={() => setPollResult(null)}>关闭</Button>}
        width={500}>
        {pollResult?.options?.map((opt: any, i: number) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text>{opt.text}</Text>
              <Text type="secondary">{opt.votes} 票 ({opt.percentage || 0}%)</Text>
            </div>
            <Progress percent={opt.percentage || 0} size="small" />
          </div>
        ))}
        <Divider />
        <Text type="secondary">共 {pollResult?.unique_voters || pollResult?.total_votes} 人参与</Text>
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
      <Modal title={quizResultsView?.quiz_title ? `我的成绩 - ${quizResultsView.quiz_title}` : "测验结果"}
        open={!!quizResultsView} onCancel={() => setQuizResultsView(null)}
        footer={null} width={700}>
        {quizResultsView && (
          <>
            {/* 学生端：个人答题结果 */}
            {quizResultsView.quiz_title && (
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <Progress type="circle" percent={quizResultsView.percentage}
                  format={p => `${p}%`}
                  strokeColor={quizResultsView.percentage >= 80 ? '#52c41a' : quizResultsView.percentage >= 60 ? '#faad14' : '#ff4d4f'} />
                <div style={{ marginTop: 8 }}>
                  <Text>得分：{quizResultsView.score}/{quizResultsView.total_score}</Text>
                </div>
                <Table dataSource={quizResultsView.details} rowKey="index" size="small" style={{ marginTop: 16 }}
                  pagination={false}
                  columns={[
                    { title: '#', dataIndex: 'index', render: (i: number) => i + 1, width: 50 },
                    { title: '题目', dataIndex: 'question', ellipsis: true,
                      render: (t: string, r: any) => (
                        <div>
                          <FormulaRenderer content={t} />
                          <MediaDisplay svgContent={r.svg_content} hasSvg={r.has_svg} mediaFiles={r.media_files} size="compact" />
                        </div>
                      ) },
                    { title: '你的答案', dataIndex: 'user_answer', width: 120,
                      render: (v: string, r: any) => (
                        <Text type={r.is_correct ? 'success' : 'danger'}>{v || '（未答）'}</Text>
                      ),
                    },
                    { title: '正确答案', dataIndex: 'correct_answer', width: 120 },
                    { title: '状态', width: 60,
                      render: (_: any, r: any) => r.is_correct
                        ? <Tag color="success">正确</Tag>
                        : <Tag color="error">错误</Tag>,
                    },
                  ]} />
              </div>
            )}
            {/* 教师端：全班统计 */}
            {!quizResultsView.quiz_title && (
              <>
                <Row gutter={16} style={{ marginBottom: 16 }}>
                  <Col span={8}><Statistic title="题目数" value={quizResultsView.quiz?.question_count} /></Col>
                  <Col span={8}><Statistic title="参与人数" value={quizResultsView.total_answers} /></Col>
                </Row>
                <div style={{ textAlign: 'right', marginBottom: 8 }}>
                  <Button icon={<RobotOutlined />} size="small"
                    loading={quizAiAnalysisLoading}
                    onClick={() => handleQuizAiAnalysis(quizResultsView.quiz?.id)}>
                    AI 分析
                  </Button>
                </div>
                <Table dataSource={quizResultsView.question_stats} rowKey="index" size="small"
                  pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `共 ${t} 题`, pageSizeOptions: ['5', '10', '20'] }}
                  columns={[
                    { title: '题号', dataIndex: 'index', render: (i: number) => i + 1, width: 60 },
                    { title: '题目', key: 'question', width: 400,
                      render: (_: any, r: any) => (
                        <div>
                          <FormulaRenderer content={r.question} />
                          <MediaDisplay svgContent={r.svg_content} hasSvg={r.has_svg} mediaFiles={(r as any).media_files} size="normal" />
                          {r.options?.length > 0 && (
                            <div style={{ marginTop: 4, paddingLeft: 8 }}>
                              {r.options.map((opt: string, j: number) => (
                                <div key={j} style={{ fontSize: 12, color: '#555', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                  <FormulaRenderer content={opt} inline />
                                </div>
                              ))}
                            </div>
                          )}
                          <Tag color="blue" style={{ marginTop: 4 }}>答案：{r.correct_answer}</Tag>
                        </div>
                      ),
                    },
                    { title: '正确率', dataIndex: 'correct_rate', width: 100,
                      render: (r: number) => (
                        <Text strong style={{ color: r >= 60 ? '#52c41a' : '#ff4d4f' }}>{r}%</Text>
                      ),
                    },
                  ]} />
                {quizAiAnalysis && (
                  <Card size="small" style={{ marginTop: 12, background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                    <div className="markdown-content">
                      <ReactMarkdown>{quizAiAnalysis}</ReactMarkdown>
                    </div>
                  </Card>
                )}
              </>
            )}
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
            <Input placeholder="例如：信息科技的发展历程、通用技术中的设计原则" />
          </Form.Item>
          <Form.Item name="subject" label="学科" initialValue={subjectOptions[0] || '信息科技'}>
            <Select>
              {subjectOptions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="question_type" label="题型" initialValue="single">
            <Select>
              <Select.Option value="single">单选题</Select.Option>
              <Select.Option value="true_false">判断题</Select.Option>
              <Select.Option value="mixed">混合</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="count" label="题目数量" initialValue={1}>
            <InputNumber min={1} max={50} style={{ width: 120 }} /> 题
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
                <Text strong>{i + 1}. </Text><FormulaRenderer content={q.question} />
                <MediaDisplay svgContent={q.svg_content || q.svg_code} hasSvg={q.has_svg || (q.svg_code ? 1 : 0)} mediaFiles={(q as any).media_files} size="normal" />
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
                    💡 <FormulaRenderer content={q.explanation} />
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

      {/* ── 投票结果弹窗（教师查看用） ── */}
      <Modal title={pollResult?.question || '投票结果'} open={!!pollResult}
        onCancel={() => setPollResult(null)}
        footer={<Button onClick={() => setPollResult(null)}>关闭</Button>}
        width={500}>
        {pollResult && (
          <>
            <Space style={{ marginBottom: 12 }}>
              <Tag color={pollResult.poll_type === 'multiple' ? 'purple' : 'blue'}>
                {pollResult.poll_type === 'multiple' ? '多选' : '单选'}
              </Tag>
            </Space>
            {pollResult.options?.map((opt: any, i: number) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text>{opt.text}</Text>
                  <Text type="secondary">{opt.votes} 票 ({opt.percentage || 0}%)</Text>
                </div>
                <Progress percent={opt.percentage || 0} size="small" />
              </div>
            ))}
            <Divider />
            <Text type="secondary">共 {pollResult.unique_voters || pollResult.total_votes} 人参与</Text>
            {pollResult.poll_type === 'multiple' && pollResult.unique_voters ? (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                （共 {pollResult.total_votes} 票）
              </Text>
            ) : null}
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

      {/* ── 提问详情/回答弹窗 ── */}
      <Modal title="提问详情" open={!!answerModal} onCancel={() => setAnswerModal(null)}
        footer={isTeacherOrAdmin ? [
          <Button key="cancel" onClick={() => setAnswerModal(null)}>取消</Button>,
          <Button key="aisuggest" icon={<RobotOutlined />} onClick={() => handleAiSuggestAnswer(answerModal?.id)}>
            AI 建议
          </Button>,
          <Button key="submit" type="primary" onClick={() => handleAnswerQuestion(answerModal?.id)}>
            {answerModal?.status === 'answered' ? '更新回答' : '提交回答'}
          </Button>,
        ] : [
          <Button key="close" onClick={() => setAnswerModal(null)}>关闭</Button>,
        ]}
        width={640}>
        {/* 问题信息 */}
        <Card size="small" style={{ marginBottom: 12, background: '#fafafa' }}>
          <div style={{ marginBottom: 8 }}>
            {answerModal?.is_anonymous ? <Tag>匿名</Tag> : <Tag>{answerModal?.student_username}</Tag>}
            <Tag color={answerModal?.status === 'answered' ? 'green' : 'orange'}>
              {answerModal?.status === 'answered' ? '已回答' : '待回答'}
            </Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>{answerModal?.created_at?.slice(0, 16)}</Text>
          </div>
          <div className="markdown-content">
            <ReactMarkdown>{answerModal?.content || ''}</ReactMarkdown>
          </div>
        </Card>
        {/* 教师回答区 */}
        {answerModal?.answer && (
          <div style={{ marginBottom: 12, padding: 12, background: '#f6f8ff', borderRadius: 6, borderLeft: '3px solid #1677ff' }}>
            <Text type="secondary" strong>教师回答：</Text>
            <div className="markdown-content" style={{ marginTop: 4 }}>
              <ReactMarkdown>{answerModal.answer}</ReactMarkdown>
            </div>
          </div>
        )}
        {/* 教师编辑区 */}
        {isTeacherOrAdmin && (
          <div style={{ marginTop: 12 }}>
            <Text strong>{answerModal?.status === 'answered' ? '编辑回答' : '撰写回答'}</Text>
            <TextArea rows={4} value={answerText} onChange={(e) => setAnswerText(e.target.value)}
              placeholder="输入回答（支持 Markdown），或点击「AI 建议」生成..." style={{ marginTop: 8 }} />
          </div>
        )}
      </Modal>
    </div>
  )
}

export default InteractionPage
