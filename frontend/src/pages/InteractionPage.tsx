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
import { useAuthStore } from '../stores/authStore'
import QuizEditor from '../components/QuizEditor'
import type { Question } from '../components/QuizEditor'
const { Title, Text } = Typography

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
    try { await apiClient.delete(`/api/interaction/quizzes/${id}`); message.success('已删除'); setActiveTab('quizzes'); await loadQuizzes() }
    catch { message.error('删除失败') }
  }
  const handleEditQuiz = async () => {
    const values = await editQuizForm.validateFields()
    try {
      await apiClient.put(`/api/interaction/quizzes/${editQuizModal.id}`, values)
      message.success('已更新'); setEditQuizModal(null); setActiveTab('quizzes'); await loadQuizzes()
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
        setActiveTab('quizzes')
        await loadQuizzes()
      } catch (err: any) {
        message.error(err.response?.data?.detail || '创建失败')
      }
    }
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
      setActiveTab('quizzes')
      await loadQuizzes()
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
  ]

  return (
    <div>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <ThunderboltOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>课堂互动</Title>
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 12 }}>
              随堂测验
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
                    <Text>得分：{quizResultsView.score}/{quizResultsView.total_score}</Text>
                  </div>
                </Card>
                {quizResultsView.details?.map((r: any, i: number) => (
                  <Card key={i} size="small" style={{ marginBottom: 8 }}
                    title={`第 ${i+1} 题`}
                    extra={r.is_correct ? <Tag color="success">正确</Tag> : <Tag color="error">错误</Tag>}>
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
                      <Text>你的答案：<Text type={r.is_correct ? 'success' : 'danger'}>{r.user_answer || '（未作答）'}</Text></Text>
                      {!r.is_correct && <div><Text type="secondary">正确答案：{r.correct_answer}</Text></div>}
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
                  <Col span={8}><Statistic title="题目数" value={quizResultsView.quiz?.question_count} /></Col>
                  <Col span={8}><Statistic title="参与人数" value={quizResultsView.total_answers} /></Col>
                </Row>
                {/* 学生答题汇总 */}
                {quizResultsView.student_answers?.length > 0 && (
                  <Card title="学生答题情况" size="small" style={{ marginBottom: 16 }}>
                    <Table dataSource={quizResultsView.student_answers} rowKey="student" size="small"
                      pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
                      columns={[
                        { title: '序号', key: 'idx', width: 50, render: (_: any, __: any, i: number) => i + 1 },
                        { title: '学生', dataIndex: 'student', width: 120 },
                        { title: '答对', dataIndex: 'correct_count', width: 80,
                          render: (v: number, r: any) => (
                            <Text strong style={{ color: v === r.total_questions ? '#52c41a' : v > 0 ? '#faad14' : '#ff4d4f' }}>
                              {v}/{r.total_questions}
                            </Text>
                          ),
                        },
                        { title: '得分', dataIndex: 'score', width: 80 },
                        { title: '提交时间', dataIndex: 'submitted_at', width: 160 },
                      ]} />
                  </Card>
                )}
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
            <Input placeholder="例如：输入课程主题或知识点名称" />
          </Form.Item>
          <Form.Item name="subject" label="学科" initialValue={subjectOptions[0] || ''}>
            <Select>
              {subjectOptions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="question_type" label="出题模式" initialValue="single">
            <Select>
              <Select.Option value="single">仅单选题</Select.Option>
              <Select.Option value="true_false">仅判断题</Select.Option>
              <Select.Option value="mixed">混合出题（单选+判断）</Select.Option>
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






    </div>
  )
}

export default InteractionPage
