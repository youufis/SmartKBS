/**
 * StudentQuestionsPage — 课堂提问（独立页）
 * 从 InteractionPage 提取，独立的师生问答页面
 */
import { studentLabel } from '../utils/studentLabel'
import React, { useState, useEffect } from 'react'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import {
  Card, Button, Space, Typography, List, Tag, Modal,
  Form, Input, Select, message, Empty, Spin, Popconfirm,
  Checkbox,
} from 'antd'
import {
  QuestionCircleOutlined, PlusOutlined,
  SendOutlined, RobotOutlined,
  EditOutlined, DeleteOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'

const { Title, Text } = Typography
const { TextArea } = Input

// ── 独立的 QuestionItem 组件，避免在 renderItem 中调用 Hooks ──
interface QuestionItemProps {
  q: any
  isTeacherOrAdmin: boolean
  isStudent: boolean
  t: (key: string, options?: any) => string
  onDelete: (id: number) => void
  onEdit: (q: any) => void
  onAnswerClick: (q: any) => void
  loadQuestions: () => Promise<void>
}

const QuestionItem: React.FC<QuestionItemProps> = ({ q, isTeacherOrAdmin, isStudent, t, onDelete, onEdit, onAnswerClick, loadQuestions }) => {
  const qContent = q.content?.length > 50 ? q.content.slice(0, 50) + '...' : q.content
  const [expanded, setExpanded] = React.useState(false)
  const [studentAnswers, setStudentAnswers] = React.useState<any[]>([])
  const [answersLoading, setAnswersLoading] = React.useState(false)
  const [expandedAnswers, setExpandedAnswers] = React.useState<Record<number, boolean>>({})

  const loadStudentAnswers = async (forceRefresh = false) => {
    if (!forceRefresh && expanded) { setExpanded(false); return }
    setAnswersLoading(true)
    try {
      const { data } = await apiClient.get(`/api/interaction/questions/${q.id}/answers`)
      setStudentAnswers(data.answers || [])
      setExpanded(true)
    } catch { message.error(t('loadFailed')) }
    setAnswersLoading(false)
  }

  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Text strong>{qContent}</Text>
          <div style={{ marginTop: 4 }}>
            {q.is_anonymous ? <Tag>{t('anonymous')}</Tag> : !isStudent && <Tag>{studentLabel(q)}</Tag>}
            {q.status === 'answered' && <Tag color="green">{t('answeredQuestions')}</Tag>}
            {q.status === 'pending' && <Tag color="orange">{t('pendingQuestions')}</Tag>}
            <Text type="secondary" style={{ fontSize: 12 }}>{q.created_at?.slice(0, 16)}</Text>
            {q.answered_by && q.status === 'answered' && (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {t('answeredBy', { name: q.answered_by })}
              </Text>
            )}
            {q.student_answer_count > 0 && (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {t('studentAnswerCount', { count: q.student_answer_count })}
                {q.approved_answer_count > 0 && t('approvedCount', { approved: q.approved_answer_count })}
              </Text>
            )}
            {isStudent && q.my_answer_status === 'pending_approval' && (
              <Tag color="purple" style={{ marginLeft: 4 }}>{t('myAnswerPending')}</Tag>
            )}
            {isStudent && q.my_answer_status === 'approved' && (
              <Tag color="green" style={{ marginLeft: 4 }}>{t('myAnswerApproved')}</Tag>
            )}
            {isStudent && q.my_answer_status === 'rejected' && (
              <Tag color="red" style={{ marginLeft: 4 }}>{t('myAnswerRejected')}</Tag>
            )}
          </div>
        </div>
        <Space>
          {isStudent && (
            <>
              <Button size="small" type="primary" icon={<QuestionCircleOutlined />}
                onClick={() => onAnswerClick(q)}>{t('viewDetails')}</Button>
              {!q.is_own && q.status === 'pending' && !q.my_answer_status && (
                <Button size="small" icon={<SendOutlined />}
                  onClick={() => onAnswerClick(q)}>{t('answer')}</Button>
              )}
              {!q.is_own && q.my_answer_status === 'rejected' && (
                <Button size="small" icon={<SendOutlined />}
                  onClick={() => onAnswerClick(q)}>{t('reAnswer')}</Button>
              )}
              {q.is_own && (
                <Button size="small" icon={<EditOutlined />}
                  onClick={() => onEdit(q)}>{t('edit')}</Button>
              )}
              {q.is_own && (
                <Popconfirm title={t('deleteConfirm')} onConfirm={() => onDelete(q.id)}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              )}
            </>
          )}
          {isTeacherOrAdmin && (
            <>
              <Button size="small"
                type={q.answer ? 'default' : 'primary'}
                icon={<SendOutlined />}
                onClick={() => onAnswerClick(q)}>
                {q.answer ? t('edit') : t('answer')}
              </Button>
              {q.student_answer_count > 0 && (
                <Button size="small" icon={expanded ? <EditOutlined /> : <PlusOutlined />}
                  loading={answersLoading}
                  onClick={() => {
                    if (expanded) { setExpanded(false); return }
                    loadStudentAnswers(true)
                  }}>
                  {expanded ? t('collapse') : t('answerCount', { count: q.student_answer_count })}
                </Button>
              )}
              <Popconfirm title={t('deleteConfirm')} onConfirm={() => onDelete(q.id)}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      </div>
      {/* 展开的学生回答列表（教师端） */}
      {expanded && isTeacherOrAdmin && (
        <div style={{ marginTop: 8, paddingLeft: 16, borderLeft: '2px solid #d9d9d9' }}>
          {studentAnswers.length === 0 ? (
            <Text type="secondary">{t('noStudentAnswers')}</Text>
          ) : (
            studentAnswers.map((sa: any) => (
              <div key={sa.id} style={{
                marginBottom: 8, padding: 8, borderRadius: 4,
                background: sa.status === 'approved' ? '#f6ffed' :
                           sa.status === 'rejected' ? '#fff2f0' : '#fffbe6',
                border: '1px solid',
                borderColor: sa.status === 'approved' ? '#b7eb8f' :
                            sa.status === 'rejected' ? '#ffccc7' : '#ffe58f',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Text strong style={{ fontSize: 13 }}>{studentLabel(sa)}</Text>
                  <Space size="small">
                    {sa.status === 'pending_approval' && (
                      <>
                        <Button size="small" type="primary"
                          icon={<CheckCircleOutlined />}
                          onClick={async () => {
                            try {
                              await apiClient.put(`/api/interaction/questions/${q.id}/answers/${sa.id}/approve`)
                              message.success(t('approved'))
                              loadStudentAnswers(true)
                            } catch { message.error(t('operationFail')) }
                          }}>{t('approve')}</Button>
                        <Popconfirm title={t('rejectConfirm')} onConfirm={async () => {
                          try {
                            await apiClient.put(`/api/interaction/questions/${q.id}/answers/${sa.id}/reject`)
                            message.success(t('rejected'))
                            loadStudentAnswers(true)
                          } catch { message.error(t('operationFail')) }
                        }}>
                          <Button size="small" danger icon={<DeleteOutlined />}>{t('reject')}</Button>
                        </Popconfirm>
                      </>
                    )}
                    {sa.status === 'approved' && <Tag color="green">{t('approved')}</Tag>}
                    {sa.status === 'rejected' && <Tag color="red">{t('rejected')}</Tag>}
                  </Space>
                </div>
                <div style={{
                  marginTop: 4, fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: expandedAnswers[sa.id] ? 'none' : '72px',
                  overflow: 'hidden',
                  transition: 'max-height 0.2s',
                  lineHeight: '22px',
                  display: 'block',
                }}>
                  {sa.answer}
                </div>
                {sa.answer?.length > 80 && (
                  <Button type="link" size="small" style={{ padding: 0, height: 20, fontSize: 12 }}
                    onClick={() => setExpandedAnswers(prev => ({ ...prev, [sa.id]: !prev[sa.id] }))}>
                    {expandedAnswers[sa.id] ? t('collapse') : t('expandFull')}
                  </Button>
                )}
                <div style={{ marginTop: 2 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {sa.created_at?.slice(0, 16)}
                  </Text>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  )
}

const StudentQuestionsPage: React.FC = () => {
  const { t } = useTranslation('questions')
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  // ── 提问 ──
  const [questions, setQuestions] = useState<any[]>([])
  const [questionTotal, setQuestionTotal] = useState(0)
  const [questionFilter, setQuestionFilter] = useState<string>('')
  const [questionLoading, setQuestionLoading] = useState(false)
  const [askModal, setAskModal] = useState(false)
  const [answerModal, setAnswerModal] = useState<any>(null)
  const [answerText, setAnswerText] = useState('')
  const [askForm] = Form.useForm()
  // 弹窗中展示的学生回答列表
  const [modalAnswers, setModalAnswers] = useState<any[]>([])
  const [modalAnswersLoading, setModalAnswersLoading] = useState(false)
  const [modalExpandedAnswers, setModalExpandedAnswers] = useState<Record<number, boolean>>({})
  // 分页
  const [questionPage, setQuestionPage] = useState(1)
  const [questionPageSize, setQuestionPageSize] = useState(10)
  // 编辑
  const [editQuestionModal, setEditQuestionModal] = useState<any>(null)
  const [editQuestionForm] = Form.useForm()

  // 打开详情弹窗时，加载已通过的学生回答
  useEffect(() => {
    if (!answerModal?.id) { setModalAnswers([]); setModalExpandedAnswers({}); return }
    (async () => {
      setModalAnswersLoading(true)
      try {
        const { data } = await apiClient.get(`/api/interaction/questions/${answerModal.id}/answers`)
        const approved = (data.answers || []).filter((a: any) => a.status === 'approved')
        setModalAnswers(approved)
      } catch { /* ignore */ }
      setModalAnswersLoading(false)
    })()
  }, [answerModal?.id])

  // ── 加载数据 ──
  const loadQuestions = async (page?: number, pageSize?: number, filter?: string) => {
    setQuestionLoading(true)
    try {
      const p = page ?? questionPage
      const ps = pageSize ?? questionPageSize
      const f = filter !== undefined ? filter : questionFilter
      const params: Record<string, any> = { page: p, page_size: ps }
      if (f) params.status = f
      const { data } = await apiClient.get('/api/interaction/questions', { params })
      if (data) {
        setQuestions(data.questions || [])
        setQuestionTotal(data.total || 0)
      }
    } catch (e) {
      console.error('加载提问列表失败:', e)
    } finally {
      setQuestionLoading(false)
    }
  }

  useEffect(() => {
    loadQuestions()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 提问 ──
  const handleAskQuestion = async (values: any) => {
    try {
      const { data } = await apiClient.post('/api/interaction/questions', {
        content: values.content,
        is_anonymous: values.is_anonymous || false,
      })
      message.success(t('submitSuccess'))
      setAskModal(false)
      askForm.resetFields()
      if (data?.question) {
        setQuestions(prev => [data.question, ...prev])
        setQuestionTotal(prev => prev + 1)
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      message.error(detail || t('submitFail'))
    }
  }

  // ── 回答 ──
  const handleAnswerQuestion = async (qId: number) => {
    if (!answerText.trim()) { message.warning(t('enterAnswer')); return }
    try {
      await apiClient.put(`/api/interaction/questions/${qId}/answer`, { answer: answerText })
      const isStudentAnswer = !isTeacherOrAdmin
      message.success(isStudentAnswer ? t('answerSubmitted') : t('answerSuccess'))
      setAnswerModal(null)
      setAnswerText('')
      await loadQuestions()
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      message.error(detail || t('answerFail'))
    }
  }

  // ── AI 建议回答 ──
  const handleAiSuggestAnswer = async (qId: number) => {
    try {
      const { data } = await apiClient.post(`/api/interaction/questions/${qId}/ai-suggest`)
      if (data.suggested_answer) {
        setAnswerText(data.suggested_answer)
        message.success(t('aiSuggestedAnswer'))
      }
    } catch { message.error(t('aiSuggestFail')) }
  }

  // ── 删除 ──
  const handleDeleteQuestion = async (id: number) => {
    try {
      await apiClient.delete(`/api/interaction/questions/${id}`)
      message.success(t('deleteSuccess'))
      setQuestions(prev => prev.filter(q => q.id !== id))
      setQuestionTotal(prev => Math.max(0, prev - 1))
    } catch (err: any) { message.error(err?.response?.data?.detail || t('deleteFail')) }
  }

  // ── 编辑 ──
  const handleEditQuestion = async () => {
    const values = await editQuestionForm.validateFields()
    try {
      await apiClient.put(`/api/interaction/questions/${editQuestionModal.id}`, { content: values.content })
      message.success(t('updated'))
      setEditQuestionModal(null)
      setQuestions(prev => prev.map(q => q.id === editQuestionModal.id ? { ...q, content: values.content } : q))
    } catch (err: any) { message.error(err?.response?.data?.detail || t('updateFail')) }
  }

  return (
    <Card style={{ borderRadius: 8 }}>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <QuestionCircleOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>{t('studentQuestions')}</Title>
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 12 }}>
              {t('subtitle')}
            </Text>
          </Space>
        </div>
      </Card>

      <Card>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <Space>
            {isStudent && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setAskModal(true)}>
                {t('askQuestion')}
              </Button>
            )}
          </Space>
          <Space>
            <Text type="secondary">{t('statusLabel')}</Text>
            <Select
              value={questionFilter || 'all'}
              onChange={(val) => {
                const newFilter = val === 'all' ? '' : val
                setQuestionFilter(newFilter)
                setQuestionPage(1)
                loadQuestions(1, questionPageSize, newFilter)
              }}
              style={{ width: 120 }}
              options={[
                { label: t('allStatus'), value: 'all' },
                { label: t('pendingQuestions'), value: 'pending' },
                { label: t('answeredQuestions'), value: 'answered' },
              ]}
            />
          </Space>
        </div>

        <Spin spinning={questionLoading}>
          {questions.length === 0 ? <Empty description={t('noQuestions')} /> : (
            <List
              dataSource={questions}
              renderItem={(q: any) => (
                <QuestionItem
                  q={q}
                  isTeacherOrAdmin={isTeacherOrAdmin}
                  isStudent={isStudent}
                  t={t}
                  onDelete={handleDeleteQuestion}
                  onEdit={(question) => {
                    editQuestionForm.setFieldsValue({ content: question.content })
                    setEditQuestionModal(question)
                  }}
                  onAnswerClick={(question) => {
                    setAnswerText(question.answer || '')
                    setAnswerModal(question)
                  }}
                  loadQuestions={() => loadQuestions()}
                />
              )}
            />
          )}
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            {questions.length > 0 && (
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <span style={{ color: '#999', fontSize: 13, marginRight: 12 }}>{t('totalQuestions', { count: questionTotal })}</span>
                <button
                  style={{ border: '1px solid #d9d9d9', background: '#fff', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', margin: '0 4px', fontSize: 13, color: questionPage <= 1 ? '#d9d9d9' : '#333' }}
                  disabled={questionPage <= 1}
                  onClick={() => {
                    const newPage = questionPage - 1
                    setQuestionPage(newPage)
                    loadQuestions(newPage, questionPageSize, questionFilter)
                  }}
                >{t('prevPage')}</button>
                <span style={{ margin: '0 8px', fontSize: 13 }}>{questionPage}</span>
                <button
                  style={{ border: '1px solid #d9d9d9', background: '#fff', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', margin: '0 4px', fontSize: 13, color: questionPage * questionPageSize >= questionTotal ? '#d9d9d9' : '#333' }}
                  disabled={questionPage * questionPageSize >= questionTotal}
                  onClick={() => {
                    const newPage = questionPage + 1
                    setQuestionPage(newPage)
                    loadQuestions(newPage, questionPageSize, questionFilter)
                  }}
                >{t('nextPage')}</button>
              </div>
            )}
          </div>
        </Spin>
      </Card>

      {/* ── 发起提问弹窗 ── */}
      <Modal title={t('askQuestion')} open={askModal} onCancel={() => setAskModal(false)}
        footer={null}>
        <Form form={askForm} layout="vertical" onFinish={handleAskQuestion}>
          <Form.Item name="content" label={t('questionContent')} rules={[{ required: true }]}>
            <TextArea rows={3} placeholder={t('inputQuestion')} />
          </Form.Item>
          <Form.Item name="is_anonymous" valuePropName="checked">
            <Checkbox>{t('anonymousAsk')}</Checkbox>
          </Form.Item>
          <Button type="primary" htmlType="submit" block>{t('submitQuestion')}</Button>
        </Form>
      </Modal>

      {/* ── 编辑提问弹窗 ── */}
      <Modal title={t('editQuestionTitle')} open={!!editQuestionModal} onCancel={() => setEditQuestionModal(null)}
        onOk={handleEditQuestion} okText={t('save')}>
        <Form form={editQuestionForm} layout="vertical">
          <Form.Item name="content" label={t('contentLabel')} rules={[{ required: true }]}>
            <TextArea rows={4} placeholder={t('markdownPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 提问详情/回答弹窗 ── */}
      <Modal title={t('questionDetail')} open={!!answerModal} onCancel={() => setAnswerModal(null)}
        footer={isTeacherOrAdmin ? [
          <Button key="cancel" onClick={() => setAnswerModal(null)}>{t('cancel')}</Button>,
          <Button key="aisuggest" icon={<RobotOutlined />} onClick={() => handleAiSuggestAnswer(answerModal?.id)}>
            {t('aiSuggest')}
          </Button>,
          <Button key="submit" type="primary" onClick={() => handleAnswerQuestion(answerModal?.id)}>
            {answerModal?.status === 'answered' ? t('updateAnswer') : t('submitAnswer')}
          </Button>,
        ] : [
          <Button key="close" onClick={() => setAnswerModal(null)}>{t('close')}</Button>,
          ...(answerModal?.status === 'pending' && !answerModal?.is_own
            ? [<Button key="submit" type="primary" onClick={() => handleAnswerQuestion(answerModal?.id)}>{t('submitAnswer')}</Button>]
            : []),
        ]}
        width={640}>
        {/* 问题信息 */}
        <Card size="small" style={{ marginBottom: 12, background: '#fafafa' }}>
          <div style={{ marginBottom: 8 }}>
            {answerModal?.is_anonymous ? <Tag>{t('anonymous')}</Tag> : (
              isTeacherOrAdmin ? <Tag>{answerModal?.student_username}</Tag> : null
            )}
            {answerModal?.status === 'answered' && <Tag color="green">{t('answeredQuestions')}</Tag>}
            {answerModal?.status === 'pending' && <Tag color="orange">{t('pendingQuestions')}</Tag>}
            <Text type="secondary" style={{ fontSize: 12 }}>{answerModal?.created_at?.slice(0, 16)}</Text>
            {answerModal?.answered_at && (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {t('answeredAt', { time: answerModal.answered_at?.slice(0, 16) })}
              </Text>
            )}
          </div>
          <div className="markdown-content">
            <ReactMarkdown>{answerModal?.content || ''}</ReactMarkdown>
          </div>
        </Card>
        {/* 统一回答展示区：教师回答 + 已通过的学生回答 */}
        {(answerModal?.answer || modalAnswers.length > 0) && (
          <div style={{ marginBottom: 12 }}>
            <Text strong style={{ fontSize: 14 }}>{t('answer_')}</Text>
            {answerModal?.answer && (
              <div style={{
                marginTop: 8, padding: 10, borderRadius: 6,
                background: '#e6f4ff', border: '1px solid #91caff',
              }}>
                <div style={{ marginBottom: 4 }}>
                  <Text strong style={{ fontSize: 13 }}>{t('teacherLabel', { name: answerModal.answered_by || '' })}</Text>
                  <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                    {answerModal.answered_at?.slice(0, 16)}
                  </Text>
                </div>
                <div className="markdown-content">
                  <ReactMarkdown>{answerModal.answer}</ReactMarkdown>
                </div>
              </div>
            )}
            {modalAnswers.map((ma: any) => (
              <div key={ma.id} style={{
                marginTop: 8, padding: 10, borderRadius: 6,
                background: '#f6ffed', border: '1px solid #b7eb8f',
              }}>
                <div style={{ marginBottom: 4 }}>
                  <Text strong style={{ fontSize: 13 }}>{ma.student_username}</Text>
                  <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                    {ma.created_at?.slice(0, 16)}
                  </Text>
                </div>
                <div style={{
                  fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: modalExpandedAnswers[ma.id] ? 'none' : '72px',
                  overflow: 'hidden',
                  transition: 'max-height 0.2s',
                  lineHeight: '22px',
                  display: 'block',
                }}>{ma.answer}</div>
                {ma.answer?.length > 80 && (
                  <Button type="link" size="small" style={{ padding: 0, height: 20, fontSize: 12 }}
                    onClick={() => setModalExpandedAnswers(prev => ({ ...prev, [ma.id]: !prev[ma.id] }))}>
                    {modalExpandedAnswers[ma.id] ? t('collapse') : t('expandFull')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {/* 回答编辑区 */}
        {(isTeacherOrAdmin || (answerModal?.status === 'pending' && !answerModal?.is_own) || answerModal?.my_answer_status === 'rejected') && (
          <div style={{ marginTop: 12 }}>
            <Text strong>
              {answerModal?.status === 'answered' ? t('editAnswer') : t('writeAnswer')}
            </Text>
            <TextArea rows={4} value={answerText} onChange={(e) => setAnswerText(e.target.value)}
              placeholder={t('answerPlaceholder')} style={{ marginTop: 8 }} />
          </div>
        )}
      </Modal>
    </Card>
  )
}

export default StudentQuestionsPage
