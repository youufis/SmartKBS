import React, { useState, useEffect } from 'react'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import {
  Card, Tabs, Button, Space, Typography, List, Tag, Modal,
  Form, Input, InputNumber, Select, message, Empty, Spin, Radio, Result,
  Statistic, Row, Col, Table, Progress, Popconfirm, Checkbox, Pagination,
} from 'antd'
import {
  ThunderboltOutlined, BarChartOutlined,
  PlusOutlined, PlayCircleOutlined,
  RobotOutlined,
  EditOutlined, DeleteOutlined, DownloadOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import QuizEditor from '../components/QuizEditor'
import type { Question } from '../components/QuizEditor'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
const { Title, Text } = Typography

const InteractionPage: React.FC = () => {
  const { t } = useTranslation('interaction')
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
  const [aiQuizScope, setAiQuizScope] = useState<ActivityScopeValue>({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
  // 列表分页
  const [quizPage, setQuizPage] = useState(1)
  const [quizPageSize, setQuizPageSize] = useState(10)
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])

  // 从系统配置加载课程列表
  useEffect(() => {
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setSubjectOptions(data.subjects)
    }).catch(() => {})
  }, [])

  // ── 当前激活的 Tab ──
  const [activeTab, setActiveTab] = useState('quizzes')

  // ── 编辑状态 ──
  const [editQuizModal, setEditQuizModal] = useState<any>(null)
  const [editQuizForm] = Form.useForm()
  // ── 编辑/删除处理 ──
  const handleDeleteQuiz = async (id: number) => {
    try { await apiClient.delete(`/api/interaction/quizzes/${id}`); message.success(t('deleted')); setActiveTab('quizzes'); await loadQuizzes() }
    catch { message.error(t('deleteFailed')) }
  }
  const handleEditQuiz = async () => {
    const values = await editQuizForm.validateFields()
    try {
      await apiClient.put(`/api/interaction/quizzes/${editQuizModal.id}`, values)
      message.success(t('updated')); setEditQuizModal(null); setActiveTab('quizzes'); await loadQuizzes()
    } catch { message.error(t('updateFailed')) }
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

  useEffect(() => {
    loadQuizzes()
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
        message.success(t('aiGeneratedQuestions', { count: data.questions.length }))
      } else if (data.error) {
        message.warning(data.error)
      }
    } catch { message.error(t('aiGenerateFailed')) }
    setAiQuizLoading(false)
  }

  const handleApplyAiQuiz = async () => {
    if (aiQuizResult?.questions) {
      // 直接通过 API 创建测验，保留完整题目结构
      try {
        await apiClient.post('/api/interaction/quizzes', {
          title: t('ipQuizSuffix', { topic: aiQuizForm.getFieldValue('topic') }),
          questions: JSON.stringify(aiQuizResult.questions),
          target_scope: aiQuizScope.target_scope,
          target_grade: aiQuizScope.target_grade,
          target_class: aiQuizScope.target_class,
          target_users: aiQuizScope.target_users,
        })
        message.success(t('quizCreated', { count: aiQuizResult.questions.length }))
        setAiQuizModal(false)
        setAiQuizResult(null)
        setAiQuizScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
        setActiveTab('quizzes')
        await loadQuizzes()
      } catch (err: any) {
        message.error(err.response?.data?.detail || t('createFailed'))
      }
    }
  }

  // ── 创建测验（使用 QuizEditor） ──
  const handleCreateQuiz = async (title: string, description: string, questions: Question[], scope?: any) => {
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
        target_scope: scope?.target_scope || 'teacher_classes',
        target_grade: scope?.target_grade || '',
        target_class: scope?.target_class || '',
        target_users: scope?.target_users || '',
      })
      message.success(t('quizCreatedWithTitle', { title, count: questions.length }))
      setQuizEditorOpen(false)
      setActiveTab('quizzes')
      await loadQuizzes()
    } catch (err: any) {
      message.error(err.response?.data?.detail || t('createFailed'))
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
      message.error(err.response?.data?.detail || t('submitFailed'))
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
    } catch { message.error(t('loadResultFailed')) }
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
        else message.error(t('aiAnalyzeTimeout'))
      } else {
        // 兼容旧版同步返回
        setQuizAiAnalysis(data.analysis)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('aiAnalyzeFailed'))
    }
    setQuizAiAnalysisLoading(false)
  }

  const tabItems = [
    {
      key: 'quizzes',
      label: <span><ThunderboltOutlined /> {t('title')}</span>,
      children: (
        <div>
          {isTeacherOrAdmin && (
            <Space style={{ marginBottom: 16 }}>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setQuizEditorOpen(true)}>
                {t('createQuiz')}
              </Button>
              <Button icon={<RobotOutlined />} onClick={() => { setAiQuizModal(true); setAiQuizResult(null); aiQuizForm.resetFields(); }}>
                AI {t('createQuiz')}
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
            {quizzes.length === 0 ? <Empty description={t('noPolls')} /> : (
              <>
                <List
                  dataSource={quizzes.slice((quizPage - 1) * quizPageSize, quizPage * quizPageSize)}
                  renderItem={(quiz: any) => (
                  <Card size="small" style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <Text strong>{quiz.title}</Text>
                        <div style={{ marginTop: 4 }}>
                          <Tag>{t('ipNCount', { count: quiz.questions?.length || 0 })}</Tag>
                          <Tag color={quiz.status === 'active' ? 'green' : 'default'}>
                            {quiz.status === 'active' ? t('started') : t('ended')}
                          </Tag>
                          <Tag color="blue">{quiz.creator_name || quiz.creator_username}</Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>{t('peopleCount', { count: quiz.answer_count || 0 })}</Text>
                        </div>
                      </div>
                      <Space>
                        {quiz.status === 'active' && isStudent && !quiz.answered && (
                          <Button size="small" type="primary" icon={<PlayCircleOutlined />}
                            onClick={() => handleStartQuiz(quiz)}>{t('startQuiz')}</Button>
                        )}
                        {quiz.status === 'active' && isStudent && quiz.answered && (
                          <Button size="small" icon={<BarChartOutlined />}
                            onClick={() => handleViewQuizResults(quiz.id)}>{t('results')}</Button>
                        )}
                        {isTeacherOrAdmin && (
                          <>
                            <Button size="small" icon={<BarChartOutlined />}
                              onClick={() => handleViewQuizResults(quiz.id)}>{t('results')}</Button>
                            <Button size="small" icon={<DownloadOutlined />}
                              onClick={() => {
                                const token = localStorage.getItem('smartkb_token')
                                window.open(`/api/export/quiz/${quiz.id}?token=${token}`, '_blank')
                              }}>{t('ipExport')}</Button>
                            <Button size="small" icon={<EditOutlined />}
                              onClick={() => { editQuizForm.setFieldsValue(quiz); setEditQuizModal(quiz) }}>{t('ipEdit')}</Button>
                            <Popconfirm title={t('confirmDeleteQuiz')} onConfirm={() => handleDeleteQuiz(quiz.id)}>
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
                  showSizeChanger showTotal={(total) => t('totalQuizzes', { count: total })}
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
  ]

  return (
    <Card style={{ borderRadius: 8 }}>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <ThunderboltOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>{t('title')}</Title>
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 12 }}>
              {t('title')}
            </Text>
          </Space>
        </div>
      </Card>

      <Card>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
      </Card>

      {/* ── 答题弹窗 ── */}
      <Modal title={takingQuiz?.title} open={!!takingQuiz && !quizResult}
        onCancel={() => { setTakingQuiz(null); setQuizResult(null) }}
        footer={[
          <Button key="submit" type="primary" onClick={handleSubmitQuiz}>{t('submit')}</Button>,
        ]}
        width={640}>
        {takingQuiz?.questions?.map((q: any, i: number) => (
          <div key={i} style={{ marginBottom: 12, padding: 12, background: '#fafafa', borderRadius: 4, border: '1px solid #f0f0f0' }}>
            <div style={{ marginBottom: 8 }}>
              <Text strong>{i + 1}. </Text>
              <FormulaRenderer content={q.question || q.question_text} />
              {q.type === 'single' && <Tag color="blue" style={{ fontSize: 11, marginLeft: 8 }}>{t('single')}</Tag>}
              {q.type === 'multiple' && <Tag color="purple" style={{ fontSize: 11, marginLeft: 8 }}>{t('multiple')}</Tag>}
              {q.type === 'true_false' && <Tag color="orange" style={{ fontSize: 11, marginLeft: 8 }}>{t('trueFalse')}</Tag>}
            </div>
            <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} size="normal" />
            <div style={{ marginTop: 8, paddingLeft: 8 }}>
              {q.type === 'single' && q.options ? (
                <Radio.Group onChange={(e) => setQuizAnswers({ ...quizAnswers, [i]: e.target.value })}>
                  <Space orientation="vertical">
                    {q.options.map((opt: string, j: number) => (
                      <Radio key={j} value={opt.charAt(0)} style={{ lineHeight: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><FormulaRenderer content={opt} inline /></Radio>
                    ))}
                  </Space>
                </Radio.Group>
              ) : q.type === 'multiple' && q.options ? (
                <Checkbox.Group onChange={(vals) => setQuizAnswers({ ...quizAnswers, [i]: (vals as string[]).sort().join(',') })}>
                  <Space orientation="vertical">
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
                  placeholder={t('inputAnswer')} />
              )}
            </div>
          </div>
        ))}
      </Modal>

      {/* ── 答题结果 ── */}
      <Modal title={t('result')} open={!!quizResult} onCancel={() => { setQuizResult(null); setTakingQuiz(null) }}
        footer={<Button onClick={() => { setQuizResult(null); setTakingQuiz(null) }}>{t('close')}</Button>}>
        {quizResult && (
          <Result
            status={quizResult.percentage >= 60 ? 'success' : 'warning'}
            title={t('ipScoreOf', { score: quizResult.score, total: quizResult.total_score })}
            subTitle={t('accuracyRate', { percent: quizResult.percentage })}
          />
        )}
      </Modal>

      {/* ── 测验结果统计弹窗 ── */}
      <Modal title={quizResultsView?.quiz_title ? t('ipMyScore', { title: quizResultsView.quiz_title }) : t('ipQuizResult')}
        open={!!quizResultsView} onCancel={() => setQuizResultsView(null)}
        footer={null} width={720}>
        {quizResultsView && (
          <>
            {/* 学生端：个人答题结果 */}
            {quizResultsView.quiz_title && (
              <div>
                <Card style={{ textAlign: 'center', marginBottom: 16 }}>
                  <Progress type="circle" percent={quizResultsView.percentage}
                    format={p => `${p}%`}
                    strokeColor={quizResultsView.percentage >= 80 ? '#52c41a' : quizResultsView.percentage >= 60 ? '#faad14' : '#ff4d4f'} />
                  <div style={{ marginTop: 8 }}>
                    <Text>{t('ipScore', { score: quizResultsView.score, total: quizResultsView.total_score })}</Text>
                  </div>
                </Card>
                {quizResultsView.details?.map((r: any, i: number) => (
                  <Card key={i} size="small" style={{ marginBottom: 8 }}
                    title={t('ipQNo', { no: i + 1 })}
                    extra={r.is_correct ? <Tag color="success">{t('ipCorrect')}</Tag> : <Tag color="error">{t('ipWrong')}</Tag>}>
                    <FormulaRenderer content={r.question} />
                    <MediaDisplay svgContent={r.svg_content} hasSvg={r.has_svg} mediaFiles={r.media_files} size="compact" />
                    {r.options && typeof r.options === 'object' && !Array.isArray(r.options) && (
                      <div style={{ marginTop: 4, paddingLeft: 8 }}>
                        {Object.entries(r.options).map(([k, v]) => (
                          <div key={k} style={{ fontSize: 12, color: '#555', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {k}. <FormulaRenderer content={v as string} inline />
                          </div>
                        ))}
                      </div>
                    )}
                    {r.options && Array.isArray(r.options) && (
                      <div style={{ marginTop: 4, paddingLeft: 8 }}>
                        {r.options.map((opt: string, j: number) => (
                          <div key={j} style={{ fontSize: 12, color: '#555', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            <FormulaRenderer content={opt} inline />
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: 8 }}>
                      <Text>{t('ipYourAnswer')}<Text type={r.is_correct ? 'success' : 'danger'}>{r.user_answer || t('ipUnanswered')}</Text></Text>
                      {!r.is_correct && <div><Text type="secondary">{t('ipCorrectAnswer')}{r.correct_answer}</Text></div>}
                    </div>
                    {r.explanation && (
                      <div style={{ marginTop: 8, padding: 8, background: '#f5f5f5', borderRadius: 4 }}>
                        <Text type="secondary"><FormulaRenderer content={r.explanation} /></Text>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
            {/* 教师端：全班统计 */}
            {!quizResultsView.quiz_title && (
              <>
                <Row gutter={16} style={{ marginBottom: 16 }}>
                  <Col span={8}><Statistic title={t('ipQCount')} value={quizResultsView.quiz?.question_count} /></Col>
                  <Col span={8}><Statistic title={t('ipParticipants')} value={quizResultsView.total_answers} /></Col>
                </Row>
                {/* 学生答题汇总 */}
                {quizResultsView.student_answers?.length > 0 && (
                  <Card title={t('ipStudentTable')} size="small" style={{ marginBottom: 16 }}>
                    <Table dataSource={quizResultsView.student_answers} rowKey="student" size="small"
                      pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
                      columns={[
                        { title: t('ipIdx'), key: 'idx', width: 50, render: (_: any, __: any, i: number) => i + 1 },
                        { title: t('ipStudent'), dataIndex: 'student', width: 120 },
                        { title: t('ipCorrectCol'), dataIndex: 'correct_count', width: 80,
                          render: (v: number, r: any) => (
                            <Text strong style={{ color: v === r.total_questions ? '#52c41a' : v > 0 ? '#faad14' : '#ff4d4f' }}>
                              {v}/{r.total_questions}
                            </Text>
                          ),
                        },
                        { title: t('ipScoreCol'), dataIndex: 'score', width: 80 },
                        { title: t('ipSubmitted'), dataIndex: 'submitted_at', width: 160 },
                      ]} />
                  </Card>
                )}
                <div style={{ textAlign: 'right', marginBottom: 8 }}>
                  <Button icon={<RobotOutlined />} size="small"
                    loading={quizAiAnalysisLoading}
                    onClick={() => handleQuizAiAnalysis(quizResultsView.quiz?.id)}>
                    {t('ipAiAnalyze')}
                  </Button>
                </div>
                <Table dataSource={quizResultsView.question_stats} rowKey="index" size="small"
                  pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (num: number) => t('ipNTotal', { count: num }), pageSizeOptions: ['5', '10', '20'] }}
                  columns={[
                    { title: t('ipQNoCol'), dataIndex: 'index', render: (i: number) => i + 1, width: 60 },
                    { title: t('ipQuestionCol'), key: 'question', width: 400,
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
                          <Tag color="blue" style={{ marginTop: 4 }}>{t('ipAnswerLabel')}{r.correct_answer}</Tag>
                        </div>
                      ),
                    },
                    { title: t('correctRate'), dataIndex: 'correct_rate', width: 100,
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
      <Modal title={<Space><RobotOutlined />{t('aiGenerateQuiz')}</Space>} open={aiQuizModal}
        onCancel={() => { setAiQuizModal(false); setAiQuizResult(null); setAiQuizScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' }) }}
        footer={aiQuizResult?.questions?.length > 0 ? [
          <Button key="cancel" onClick={() => { setAiQuizModal(false); setAiQuizResult(null); setAiQuizScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' }) }}>{t('cancel')}</Button>,
          <Button key="apply" type="primary" onClick={handleApplyAiQuiz}>{t('fillForm')}</Button>,
        ] : null}>
        <Form form={aiQuizForm} layout="vertical" onFinish={handleAiGenerateQuiz}>
          <Form.Item name="topic" label={t('inputTopic')} rules={[{ required: true, message: t('pleaseInputTopic') }]}>
            <Input placeholder={t('topicPlaceholder')} />
          </Form.Item>
          <Form.Item name="subject" label={t('subject')} initialValue={subjectOptions[0] || ''}>
            <Select>
              {subjectOptions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="question_type" label={t('questionMode')} initialValue="single">
            <Select>
              <Select.Option value="single">{t('singleOnly')}</Select.Option>
              <Select.Option value="true_false">{t('trueFalseOnly')}</Select.Option>
              <Select.Option value="mixed">{t('mixedMode')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="count" label={t('questionCount')} initialValue={5}>
            <InputNumber min={1} max={50} defaultValue={5} style={{ width: 120 }} /> {t('questions')}
          </Form.Item>
          <Form.Item label={t('targetScope')}>
            <ActivityScopeSelector value={aiQuizScope} onChange={setAiQuizScope} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={aiQuizLoading} icon={<RobotOutlined />} block>
            {t('aiGenerate')}
          </Button>
        </Form>
        {aiQuizResult?.questions?.length > 0 && (
          <div style={{ marginTop: 12, maxHeight: 400, overflow: 'auto' }}>
            <Text strong style={{ fontSize: 15 }}>{t('generateResult', { count: aiQuizResult.questions.length })}</Text>
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
                  <Tag color="green">{t('answerColon')}{q.answer}</Tag>
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









      {/* ── 编辑测验弹窗 ── */}
      <Modal title={t('ipEditQuiz')} open={!!editQuizModal} onCancel={() => setEditQuizModal(null)}
        onOk={handleEditQuiz} okText={t('ipSave')}>
        <Form form={editQuizForm} layout="vertical">
          <Form.Item name="title" label={t('quizTitle')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('ipDesc')}>
            <Input />
          </Form.Item>
          <Form.Item name="status" label={t('ipStatus')}>
            <Select>
              <Select.Option value="active">{t('ipStatusActive')}</Select.Option>
              <Select.Option value="closed">{t('ipStatusEnded')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>






    </Card>
  )
}

export default InteractionPage
