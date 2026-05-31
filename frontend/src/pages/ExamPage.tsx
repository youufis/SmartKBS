import React, { useState, useEffect, useCallback } from 'react'
import {
  Layout, Card, Table, Button, message, Modal, Form, Input, Select,
  InputNumber, Tag, Space, Typography, Tooltip, Popconfirm, Row, Col,
  Divider, Empty, Tabs, Spin, Statistic,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined,
  PlayCircleOutlined, PauseCircleOutlined,
  CheckCircleOutlined, BarChartOutlined,
  OrderedListOutlined, FileAddOutlined, SaveOutlined,
  DownloadOutlined,
} from '@ant-design/icons'
import * as examsApi from '../api/exams'
import * as questionsApi from '../api/questions'
import { useAuthStore } from '../stores/authStore'
import type { ExamInfo, ExamAttempt } from '../types'
import { useNavigate } from 'react-router-dom'

const { TextArea } = Input
const { Option } = Select

const STATUS_COLORS: Record<string, string> = {
  draft: 'default',
  published: 'green',
  ended: 'red',
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  ended: '已结束',
}

const subjectOptions = ['信息技术', '通用技术']

const ExamPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  // ── 考试列表 ──
  const [exams, setExams] = useState<ExamInfo[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [statusFilter, setStatusFilter] = useState<string | undefined>()

  // ── 创建/编辑弹窗 ──
  const [createModal, setCreateModal] = useState(false)
  const [editModal, setEditModal] = useState(false)
  const [editingExam, setEditingExam] = useState<ExamInfo | null>(null)
  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()
  const [saving, setSaving] = useState(false)

  // ── 题目管理弹窗 ──
  const [questionModal, setQuestionModal] = useState(false)
  const [questionExam, setQuestionExam] = useState<ExamInfo | null>(null)
  const [examQuestions, setExamQuestions] = useState<any[]>([])
  const [allQuestions, setAllQuestions] = useState<any[]>([])
  const [selectedQIds, setSelectedQIds] = useState<number[]>([])
  const [qLoading, setQLoading] = useState(false)
  const [qPage, setQPage] = useState(1)
  const [qSubject, setQSubject] = useState<string>()
  const [qType, setQType] = useState<string>()
  const [qDifficulty, setQDifficulty] = useState<string>()
  const [qKeyword, setQKeyword] = useState('')
  const [autoSelectForm] = Form.useForm()
  const [autoSelecting, setAutoSelecting] = useState(false)

  // ── 成绩查看弹窗 ──
  const [resultModal, setResultModal] = useState(false)
  const [resultExam, setResultExam] = useState<ExamInfo | null>(null)
  const [resultData, setResultData] = useState<any>(null)
  const [resultLoading, setResultLoading] = useState(false)

  // ── 学生：我的成绩 ──
  const [myResults, setMyResults] = useState<ExamAttempt[]>([])
  const [myResultsLoading, setMyResultsLoading] = useState(false)

  const isAdmin = user?.role === 'admin'

  // ── 加载考试列表 ──
  const loadExams = useCallback(async () => {
    setLoading(true)
    try {
      const scope = isStudent ? 'all' : 'all'
      const res = await examsApi.listExams({
        status: statusFilter,
        scope,
        page,
        page_size: pageSize,
      })
      setExams(res.exams)
      setTotal(res.total)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '加载考试列表失败')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, page, pageSize, isStudent])

  useEffect(() => { loadExams() }, [loadExams])

  // ── 加载学生成绩 ──
  const loadMyResults = useCallback(async () => {
    if (!isStudent) return
    setMyResultsLoading(true)
    try {
      const res = await examsApi.getMyResults()
      setMyResults(res.results)
    } catch (err: any) {
      console.error('加载考试成绩失败:', err)
      // 不弹出错误提示，静默失败
    } finally {
      setMyResultsLoading(false)
    }
  }, [isStudent])

  useEffect(() => {
    if (isStudent) loadMyResults()
  }, [isStudent, loadMyResults])

  // ── 创建考试 ──
  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields()
      setSaving(true)
      const res = await examsApi.createExam({
        title: values.title,
        description: values.description || '',
        subject: values.subject,
        duration: values.duration,
        total_score: values.total_score,
        pass_score: values.pass_score,
        shuffle_questions: values.shuffle_questions !== false,
        shuffle_options: values.shuffle_options !== false,
        show_result_immediately: values.show_result_immediately || false,
        max_attempts: values.max_attempts || 1,
      })
      message.success(res.message)
      setCreateModal(false)
      createForm.resetFields()
      loadExams()
    } catch (err: any) {
      if (err?.response?.data?.detail) {
        message.error(err.response.data.detail)
      }
    } finally {
      setSaving(false)
    }
  }

  // ── 编辑考试 ──
  const handleEdit = (exam: ExamInfo) => {
    setEditingExam(exam)
    editForm.setFieldsValue({
      title: exam.title,
      description: exam.description,
      subject: exam.subject,
      duration: exam.duration,
      total_score: exam.total_score,
      pass_score: exam.pass_score,
      shuffle_questions: exam.shuffle_questions === 1,
      shuffle_options: exam.shuffle_options === 1,
      show_result_immediately: exam.show_result_immediately === 1,
      max_attempts: exam.max_attempts,
    })
    setEditModal(true)
  }

  const handleSaveEdit = async () => {
    if (!editingExam) return
    try {
      const values = await editForm.validateFields()
      setSaving(true)
      await examsApi.updateExam(editingExam.id, {
        title: values.title,
        description: values.description,
        subject: values.subject,
        duration: values.duration,
        total_score: values.total_score,
        pass_score: values.pass_score,
        shuffle_questions: values.shuffle_questions !== false,
        shuffle_options: values.shuffle_options !== false,
        show_result_immediately: values.show_result_immediately || false,
        max_attempts: values.max_attempts || 1,
      })
      message.success('修改成功')
      setEditModal(false)
      loadExams()
    } catch (err: any) {
      if (err?.response?.data?.detail) {
        message.error(err.response.data.detail)
      }
    } finally {
      setSaving(false)
    }
  }

  // ── 删除考试 ──
  const handleDelete = async (id: number) => {
    try {
      await examsApi.deleteExam(id)
      message.success('已删除')
      loadExams()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  // ── 发布/结束考试 ──
  const handlePublish = async (id: number) => {
    try {
      const res = await examsApi.publishExam(id)
      message.success(res.message)
      loadExams()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '发布失败')
    }
  }

  const handleEnd = async (id: number) => {
    try {
      const res = await examsApi.endExam(id)
      message.success(res.message)
      loadExams()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '操作失败')
    }
  }

  // ── 管理题目 ──
  const [scoreInputs, setScoreInputs] = useState<Record<string, number>>({})  // eq_id -> score
  const [savingScores, setSavingScores] = useState(false)

  const handleManageQuestions = async (exam: ExamInfo) => {
    setQuestionExam(exam)
    setQuestionModal(true)
    setSelectedQIds([])
    setQPage(1)
    setScoreInputs({})
    await loadExamQuestions(exam.id)
  }

  const loadExamQuestions = async (examId: number) => {
    setQLoading(true)
    try {
      const detail = await examsApi.getExam(examId)
      const questions = detail.questions || []
      setExamQuestions(questions)
      // 初始化可编辑分值映射 (使用 eq_id)
      const scores: Record<string, number> = {}
      questions.forEach((q: any) => { scores[String(q.eq_id)] = q.question_score })
      setScoreInputs(scores)
    } catch {
      setExamQuestions([])
    } finally {
      setQLoading(false)
    }
  }

  const [qTotal, setQTotal] = useState(0)

  const loadAllQuestions = async (search?: string) => {
    try {
      const res = await questionsApi.listQuestions({
        page: qPage,
        page_size: 200,
        keyword: (search ?? qKeyword) || undefined,
        subject: qSubject || undefined,
        type: qType || undefined,
        difficulty: qDifficulty || undefined,
      })
      setAllQuestions(res.questions || [])
      setQTotal(res.total || 0)
    } catch {
      setAllQuestions([])
      setQTotal(0)
    }
  }

  useEffect(() => {
    if (questionModal) {
      loadAllQuestions()
    }
  }, [questionModal, qPage, qSubject, qType, qDifficulty])

  // ── 计算当前总分 ──
  const currentTotal = Object.values(scoreInputs).reduce((s, v) => s + (Number(v) || 0), 0)
  const expectedTotal = questionExam?.total_score || 100
  const totalBalanced = Math.abs(currentTotal - expectedTotal) < 0.1

  // ── 更新单题分值 ──
  const handleScoreChange = (eqId: string, value: number | null) => {
    setScoreInputs(prev => ({ ...prev, [eqId]: value ?? 0 }))
  }

  // ── 自动均衡 ──
  const handleAutoBalance = async () => {
    if (!questionExam) return
    try {
      const res = await examsApi.autoBalanceScores(questionExam.id)
      message.success(res.message)
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '自动均衡失败')
    }
  }

  // ── 批量保存分值 ──
  const handleSaveScores = async () => {
    if (!questionExam) return
    setSavingScores(true)
    try {
      const res = await examsApi.batchUpdateScores(questionExam.id, scoreInputs)
      if (res.balanced) {
        message.success(res.message)
      } else {
        message.warning(`总分 ${res.current_total} ≠ 目标 ${res.expected_total}，已保存但请检查`)
      }
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '保存分值失败')
    } finally {
      setSavingScores(false)
    }
  }

  // ── 已添加题目的 ID 集合（用于禁用重复选择） ──
  const existingQuestionIds = new Set(examQuestions.map((q: any) => q.id))

  // ── 过滤掉已存在的重复项 ──
  const newSelectedIds = selectedQIds.filter(id => !existingQuestionIds.has(id))
  const hasDuplicatesInSelection = newSelectedIds.length !== selectedQIds.length

  const handleAddQuestions = async () => {
    if (!questionExam || selectedQIds.length === 0) {
      message.warning('请选择要添加的试题')
      return
    }
    // 自动过滤掉已存在的题目
    const toAdd = newSelectedIds
    if (toAdd.length === 0) {
      message.warning('选中的题目都已存在于本考试中，无需重复添加')
      return
    }
    try {
      const res = await examsApi.addQuestionsToExam(questionExam.id, toAdd)
      if (res.skipped_existing) {
        message.warning(`成功添加 ${res.added} 道，${res.skipped_existing} 道重复已自动跳过`)
      } else {
        message.success(res.message)
      }
      setSelectedQIds([])
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '添加失败')
    }
  }

  const handleRemoveQuestion = async (qId: number) => {
    if (!questionExam) return
    try {
      await examsApi.removeQuestionsFromExam(questionExam.id, [qId])
      message.success('已移除')
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '移除失败')
    }
  }

  // ── 智能选题 ──
  const handleAutoSelect = async () => {
    if (!questionExam) return
    try {
      const values = await autoSelectForm.validateFields()
      setAutoSelecting(true)
      const res = await examsApi.autoSelectQuestions(questionExam.id, {
        subject: values.subject || undefined,
        question_types: values.question_types?.length ? values.question_types : undefined,
        difficulty: values.difficulty || undefined,
        knowledge_keyword: values.knowledge_keyword || undefined,
        count: values.count || 10,
        exclude_existing: true,
      })
      message.success(res.message)
      await loadExamQuestions(questionExam.id)
    } catch (err: any) {
      if (err?.response?.data?.detail) {
        message.error(err.response.data.detail)
      }
    } finally {
      setAutoSelecting(false)
    }
  }

  // ── 查看成绩 ──
  const handleViewResults = async (exam: ExamInfo) => {
    setResultExam(exam)
    setResultModal(true)
    setResultLoading(true)
    try {
      const res = await examsApi.getExamResults(exam.id)
      setResultData(res)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '加载成绩失败')
    } finally {
      setResultLoading(false)
    }
  }

  // ── 参加考试 ──
  const handleTakeExam = async (examId: number) => {
    navigate(`/exam-take/${examId}`)
  }

  // ── 表格列（教师/管理员视图） ──
  const teacherColumns = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (text: string, record: ExamInfo) => (
        <Space>
          <span style={{ fontWeight: record.status === 'published' ? 500 : 'normal' }}>{text}</span>
          <Tag color={STATUS_COLORS[record.status]}>{STATUS_LABELS[record.status]}</Tag>
        </Space>
      ),
    },
    {
      title: '科目',
      dataIndex: 'subject',
      key: 'subject',
      width: 100,
    },
    {
      title: '时长',
      dataIndex: 'duration',
      key: 'duration',
      width: 70,
      render: (v: number) => `${v}分钟`,
    },
    {
      title: '总分',
      dataIndex: 'total_score',
      key: 'total_score',
      width: 60,
    },
    {
      title: '题目数',
      dataIndex: 'question_count',
      key: 'question_count',
      width: 70,
    },
    {
      title: '创建者',
      dataIndex: 'creator_name',
      key: 'creator_name',
      width: 100,
      render: (name: string, record: ExamInfo) => name || record.creator_username,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 140,
      render: (t: string) => t ? t.slice(0, 16) : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 320,
      render: (_: any, record: ExamInfo) => {
        const canEdit = isAdmin || record.creator_username === user?.username
        return (
          <Space size="small" wrap>
            {record.status === 'draft' && canEdit && (
              <>
                <Tooltip title="编辑考试">
                  <Button type="link" size="small" icon={<EditOutlined />}
                    onClick={() => handleEdit(record)} />
                </Tooltip>
                <Tooltip title="管理题目">
                  <Button type="link" size="small" icon={<OrderedListOutlined />}
                    onClick={() => handleManageQuestions(record)} />
                </Tooltip>
                <Popconfirm title="确认发布？" description="发布后学生即可参加考试"
                  onConfirm={() => handlePublish(record.id)} okText="发布" cancelText="取消">
                  <Tooltip title="发布考试">
                    <Button type="link" size="small" icon={<PlayCircleOutlined />}
                      style={{ color: '#52c41a' }} />
                  </Tooltip>
                </Popconfirm>
                <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}
                  okText="确认" cancelText="取消">
                  <Tooltip title="删除">
                    <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                  </Tooltip>
                </Popconfirm>
              </>
            )}
            {record.status === 'published' && canEdit && (
              <>
                <Tooltip title="管理题目">
                  <Button type="link" size="small" icon={<OrderedListOutlined />}
                    onClick={() => handleManageQuestions(record)} />
                </Tooltip>
                <Tooltip title="查看成绩">
                  <Button type="link" size="small" icon={<BarChartOutlined />}
                    onClick={() => handleViewResults(record)} />
                </Tooltip>
                <Popconfirm title="确认结束考试？" description="结束后学生将无法继续作答"
                  onConfirm={() => handleEnd(record.id)} okText="结束" cancelText="取消">
                  <Tooltip title="结束考试">
                    <Button type="link" size="small" icon={<PauseCircleOutlined />}
                      style={{ color: '#ff4d4f' }} />
                  </Tooltip>
                </Popconfirm>
              </>
            )}
            {record.status === 'ended' && canEdit && (
              <Tooltip title="查看成绩">
                <Button type="link" size="small" icon={<BarChartOutlined />}
                  onClick={() => handleViewResults(record)} />
              </Tooltip>
            )}
            {record.status === 'ended' && canEdit && (
              <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}
                okText="确认" cancelText="取消">
                <Tooltip title="删除">
                  <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                </Tooltip>
              </Popconfirm>
            )}
          </Space>
        )
      },
    },
  ]

  // ── 表格列（学生视图） ──
  const studentColumns = [
    {
      title: '考试名称',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
    },
    {
      title: '科目',
      dataIndex: 'subject',
      key: 'subject',
      width: 100,
    },
    {
      title: '时长',
      dataIndex: 'duration',
      key: 'duration',
      width: 70,
      render: (v: number) => `${v}分钟`,
    },
    {
      title: '总分',
      dataIndex: 'total_score',
      key: 'total_score',
      width: 60,
    },
    {
      title: '题目数',
      dataIndex: 'question_count',
      key: 'question_count',
      width: 70,
    },
    {
      title: '我的状态',
      key: 'my_status',
      width: 120,
      render: (_: any, record: ExamInfo) => {
        const attempt = record.my_attempt
        if (!attempt) return <Tag>未参加</Tag>
        if (attempt.status === 'in_progress') return <Tag color="processing">进行中</Tag>
        if (attempt.status === 'submitted') {
          const passed = attempt.score >= (record.pass_score || 60)
          return (
            <Space size={4}>
              <Tag color={passed ? 'green' : 'red'}>{attempt.score}分</Tag>
              {passed ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : null}
            </Space>
          )
        }
        return <Tag>{attempt.status}</Tag>
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: any, record: ExamInfo) => {
        const attempt = record.my_attempt

        return (
          <Space>
            {!attempt || attempt.status === 'submitted' ? (
              <Button type="primary" size="small"
                icon={<PlayCircleOutlined />}
                onClick={() => handleTakeExam(record.id)}>
                {attempt ? '重考' : '参加考试'}
              </Button>
            ) : attempt.status === 'in_progress' ? (
              <Button type="primary" size="small"
                onClick={() => handleTakeExam(record.id)}>
                继续作答
              </Button>
            ) : null}
          </Space>
        )
      },
    },
  ]

  // ── 创建表单初始值 ──
  const createInitialValues = {
    subject: '信息技术',
    duration: 45,
    total_score: 100,
    pass_score: 60,
    shuffle_questions: true,
    shuffle_options: true,
    show_result_immediately: false,
    max_attempts: 1,
  }

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 20 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        {/* ── 标题和操作栏 ── */}
        <Row justify="space-between" align="middle">
          <Col>
            <Typography.Title level={5} style={{ margin: 0, fontSize: 18 }}>
              📋 考试发布
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {isStudent ? '查看和参加已发布的考试' : '创建和管理考试'}
            </Typography.Text>
          </Col>
          <Col>
            <Space>
              {isTeacherOrAdmin && (
                <Button type="primary" icon={<PlusOutlined />}
                  onClick={() => { setCreateModal(true); createForm.resetFields() }}>
                  创建考试
                </Button>
              )}
              <Button icon={<ReloadOutlined />} onClick={loadExams} loading={loading}>
                刷新
              </Button>
            </Space>
          </Col>
        </Row>

        {/* ── 状态筛选 ── */}
        <Row gutter={12} align="middle">
          <Col>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>状态：</Typography.Text>
          </Col>
          <Col span={3}>
            <Select allowClear placeholder="全部" style={{ width: '100%' }}
              value={statusFilter}
              onChange={(val) => { setStatusFilter(val); setPage(1) }}>
              <Option value="draft">草稿</Option>
              <Option value="published">已发布</Option>
              <Option value="ended">已结束</Option>
            </Select>
          </Col>
          <Col>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>共 {total} 场考试</Typography.Text>
          </Col>
        </Row>

        {/* ── 学生：我的成绩标签 ── */}
        {isStudent && (
          <Tabs defaultActiveKey="exams" onChange={(key) => {
            if (key === 'results') loadMyResults()
          }} items={[
            {
              key: 'exams',
              label: <Space><FileAddOutlined />考试列表</Space>,
              children: (
                <Table dataSource={exams} columns={studentColumns} rowKey="id"
                  loading={loading} size="small"
                  pagination={{
                    current: page, pageSize, total,
                    showSizeChanger: true,
                    showTotal: (t) => `共 ${t} 场考试`,
                    onChange: (p, ps) => { setPage(p); setPageSize(ps) },
                  }}
                  locale={{ emptyText: <Empty description="暂无发布的考试" /> }}
                />
              ),
            },
            {
              key: 'results',
              label: <Space><BarChartOutlined />我的成绩</Space>,
              children: (
                <Table dataSource={myResults} rowKey="id" loading={myResultsLoading} size="small"
                  columns={[
                    { title: '考试名称', dataIndex: 'exam_title', key: 'exam_title', ellipsis: true },
                    { title: '科目', dataIndex: 'exam_subject', key: 'exam_subject', width: 100 },
                    {
                      title: '得分', key: 'score', width: 100,
                      render: (_: any, r: ExamAttempt) => {
                        const passed = r.score >= (r.pass_score || 60)
                        return (
                          <Space>
                            <Typography.Text strong style={{ color: passed ? '#52c41a' : '#ff4d4f' }}>
                              {r.score} / {r.total_score}
                            </Typography.Text>
                            {passed ? <Tag color="green">及格</Tag> : <Tag color="red">未及格</Tag>}
                          </Space>
                        )
                      },
                    },
                    {
                      title: '提交时间', dataIndex: 'submitted_at', key: 'submitted_at', width: 160,
                      render: (t: string) => t ? t.slice(0, 16) : '-',
                    },
                  ]}
                  locale={{ emptyText: <Empty description="暂无考试记录" /> }}
                />
              ),
            },
          ]} />
        )}

        {/* ── 教师/管理员：考试列表 ── */}
        {!isStudent && (
          <Table dataSource={exams} columns={teacherColumns} rowKey="id"
            loading={loading} size="small"
            pagination={{
              current: page, pageSize, total,
              showSizeChanger: true,
              showTotal: (t) => `共 ${t} 场考试`,
              onChange: (p, ps) => { setPage(p); setPageSize(ps) },
            }}
            locale={{ emptyText: <Empty description="暂无考试，点击「创建考试」开始" /> }}
            expandable={{
              expandedRowRender: (record) => (
                <div style={{ padding: '8px 0', maxWidth: 800 }}>
                  <Typography.Text style={{ fontSize: 14 }}>{record.description || '无说明'}</Typography.Text>
                  <div style={{ marginTop: 8, fontSize: 13, color: '#888' }}>
                    创建者：{record.creator_name || record.creator_username} |
                    时长：{record.duration}分钟 |
                    及格线：{record.pass_score}分
                  </div>
                </div>
              ),
            }}
          />
        )}
      </Space>

      {/* ── 创建考试弹窗 ── */}
      <Modal title="创建考试" open={createModal}
        onCancel={() => setCreateModal(false)}
        onOk={handleCreate} confirmLoading={saving}
        okText="创建" width={640}>
        <Form form={createForm} layout="vertical"
          initialValues={createInitialValues}>
          <Form.Item label="考试标题" name="title"
            rules={[{ required: true, message: '请输入考试标题' }]}>
            <Input placeholder="如：第一章单元测试" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="科目" name="subject">
                <Select>
                  {subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="考试时长（分钟）" name="duration">
                <InputNumber min={1} max={180} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="最大答题次数" name="max_attempts">
                <InputNumber min={1} max={10} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="总分" name="total_score">
                <InputNumber min={1} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="及格分" name="pass_score">
                <InputNumber min={0} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="考试说明" name="description">
            <TextArea rows={3} placeholder="可选：填写考试说明或注意事项" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="随机题目顺序" name="shuffle_questions" valuePropName="checked">
                <Select>
                  <Option value={true}>是</Option>
                  <Option value={false}>否</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="随机选项顺序" name="shuffle_options" valuePropName="checked">
                <Select>
                  <Option value={true}>是</Option>
                  <Option value={false}>否</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="立即显示结果" name="show_result_immediately">
                <Select>
                  <Option value={true}>是</Option>
                  <Option value={false}>否</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ── 编辑考试弹窗 ── */}
      <Modal title="编辑考试" open={editModal}
        onCancel={() => setEditModal(false)}
        onOk={handleSaveEdit} confirmLoading={saving}
        okText="保存" width={640}>
        <Form form={editForm} layout="vertical">
          <Form.Item label="考试标题" name="title"
            rules={[{ required: true, message: '请输入考试标题' }]}>
            <Input />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="科目" name="subject">
                <Select>
                  {subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>)}
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="考试时长（分钟）" name="duration">
                <InputNumber min={1} max={180} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="最大答题次数" name="max_attempts">
                <InputNumber min={1} max={10} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="总分" name="total_score">
                <InputNumber min={1} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="及格分" name="pass_score">
                <InputNumber min={0} max={1000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="考试说明" name="description">
            <TextArea rows={3} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="随机题目顺序" name="shuffle_questions">
                <Select>
                  <Option value={true}>是</Option>
                  <Option value={false}>否</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="随机选项顺序" name="shuffle_options">
                <Select>
                  <Option value={true}>是</Option>
                  <Option value={false}>否</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="立即显示结果" name="show_result_immediately">
                <Select>
                  <Option value={true}>是</Option>
                  <Option value={false}>否</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ── 题目管理弹窗 ── */}
      <Modal title={`管理题目 - ${questionExam?.title || ''}`}
        open={questionModal}
        onCancel={() => setQuestionModal(false)}
        width={960}
        footer={[
          <Button key="close" onClick={() => setQuestionModal(false)}>关闭</Button>,
        ]}>
        <Spin spinning={qLoading}>
          {/* ── 总分指示器 ── */}
          {examQuestions.length > 0 && (
            <Card size="small" style={{ marginBottom: 12, background: totalBalanced ? '#f6ffed' : '#fff7e6', borderColor: totalBalanced ? '#b7eb8f' : '#ffd591' }}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Space>
                  <Typography.Text strong>当前总分：</Typography.Text>
                  <Typography.Text strong style={{
                    fontSize: 18, color: totalBalanced ? '#52c41a' : '#fa8c16'
                  }}>
                    {currentTotal.toFixed(1)}
                  </Typography.Text>
                  <Typography.Text> / {expectedTotal}（目标总分）</Typography.Text>
                  {totalBalanced
                    ? <Tag color="green" style={{ marginLeft: 8 }}>✅ 总分一致</Tag>
                    : <Tag color="orange" style={{ marginLeft: 8 }}>
                        ⚠️ 相差 {(expectedTotal - currentTotal).toFixed(1)} 分
                      </Tag>
                  }
                </Space>
                <Space>
                  <Button size="small" icon={<ReloadOutlined />} onClick={handleAutoBalance}>
                    自动均衡
                  </Button>
                  <Button type="primary" size="small" icon={<SaveOutlined />}
                    loading={savingScores} onClick={handleSaveScores}
                    disabled={!totalBalanced && !window.confirm?.toString()}>
                    保存分值
                  </Button>
                </Space>
              </Space>
            </Card>
          )}

          <Typography.Title level={5} style={{ fontSize: 14, marginTop: 0 }}>
            已选题目（{examQuestions.length} 道）
            {examQuestions.length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8, fontWeight: 'normal' }}>
                可编辑每道题的分值
              </Typography.Text>
            )}
          </Typography.Title>
          {examQuestions.length === 0 ? (
            <Empty description="尚未添加题目，请从下方题库选择添加" />
          ) : (
            <Table dataSource={examQuestions} rowKey="id" size="small" pagination={false}
              columns={[
                { title: '#', key: 'index', width: 40,
                  render: (_: any, __: any, idx: number) => idx + 1 },
                { title: '题型', dataIndex: 'type', width: 70,
                  render: (t: string) => <Tag>{t === 'single' ? '单选' : t === 'multiple' ? '多选' : t === 'true_false' ? '判断' : '简答'}</Tag> },
                { title: '题目', dataIndex: 'question_text', ellipsis: true },
                { title: '分值', dataIndex: 'question_score', width: 100,
                  render: (_: any, rec: any) => (
                    <InputNumber
                      size="small"
                      min={0}
                      max={expectedTotal}
                      step={0.5}
                      value={scoreInputs[String(rec.eq_id)]}
                      onChange={(val) => handleScoreChange(String(rec.eq_id), val)}
                      style={{ width: 80 }}
                      variant="outlined"
                    />
                  ),
                },
                { title: '操作', width: 70,
                  render: (_: any, rec: any) => (
                    <Popconfirm title="移除该题？移除后需重新分配分值" onConfirm={() => handleRemoveQuestion(rec.id)}>
                      <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  ),
                },
              ]}
            />
          )}

          <Divider />

          {/* ── 智能选题卡片 ── */}
          <Card
            size="small"
            title={<Space><FileAddOutlined />智能选题</Space>}
            style={{ marginBottom: 16, background: '#fafaff', border: '1px solid #1677ff22' }}
            extra={
              <Button type="primary" size="small" icon={<FileAddOutlined />}
                loading={autoSelecting} onClick={handleAutoSelect}>
                自动选题
              </Button>
            }
          >
            <Form form={autoSelectForm} layout="inline" initialValues={{ count: 10 }}
              style={{ flexWrap: 'wrap', gap: 8 }}>
              <Form.Item name="subject" style={{ minWidth: 120 }}>
                <Select allowClear placeholder="科目">
                  <Option value="信息技术">信息技术</Option>
                  <Option value="通用技术">通用技术</Option>
                </Select>
              </Form.Item>
              <Form.Item name="question_types" style={{ minWidth: 160 }}>
                <Select allowClear mode="multiple" placeholder="题型（不限）" maxTagCount={2}>
                  <Option value="single">单选题</Option>
                  <Option value="multiple">多选题</Option>
                  <Option value="true_false">判断题</Option>
                  <Option value="short">简答题</Option>
                </Select>
              </Form.Item>
              <Form.Item name="difficulty" style={{ minWidth: 100 }}>
                <Select allowClear placeholder="难度">
                  <Option value="easy">简单</Option>
                  <Option value="medium">中等</Option>
                  <Option value="hard">困难</Option>
                </Select>
              </Form.Item>
              <Form.Item name="knowledge_keyword" style={{ minWidth: 160 }}>
                <Input placeholder="知识点关键词" />
              </Form.Item>
              <Form.Item name="count" label="选题数" style={{ width: 100 }}>
                <InputNumber min={1} max={100} />
              </Form.Item>
            </Form>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
              💡 将根据筛选条件智能随机选题，自动排除已添加的题目。添加后可用「自动均衡」统一分配分值
            </Typography.Text>
          </Card>

          <Typography.Title level={5} style={{ fontSize: 14 }}>
            题库列表（手动选择）
          </Typography.Title>
          <Space wrap style={{ marginBottom: 8 }}>
            <Select allowClear placeholder="科目" style={{ width: 120 }}
              value={qSubject} onChange={(v) => { setQSubject(v); setQPage(1) }}>
              <Option value="信息技术">信息技术</Option>
              <Option value="通用技术">通用技术</Option>
            </Select>
            <Select allowClear placeholder="题型" style={{ width: 110 }}
              value={qType} onChange={(v) => { setQType(v); setQPage(1) }}>
              <Option value="single">单选题</Option>
              <Option value="multiple">多选题</Option>
              <Option value="true_false">判断题</Option>
              <Option value="short">简答题</Option>
            </Select>
            <Select allowClear placeholder="难度" style={{ width: 100 }}
              value={qDifficulty} onChange={(v) => { setQDifficulty(v); setQPage(1) }}>
              <Option value="easy">简单</Option>
              <Option value="medium">中等</Option>
              <Option value="hard">困难</Option>
            </Select>
            <Input.Search placeholder="搜索题目/知识点..." allowClear
              value={qKeyword}
              onChange={(e) => setQKeyword(e.target.value)}
              onSearch={(val) => { setQKeyword(val); setQPage(1); loadAllQuestions(val || undefined) }}
              style={{ width: 220 }} />
            <Button type="primary" icon={<PlusOutlined />}
              disabled={selectedQIds.length === 0}
              onClick={handleAddQuestions}>
              添加选中题目（{selectedQIds.length}）
              {hasDuplicatesInSelection && <Typography.Text style={{ marginLeft: 4, fontSize: 11, opacity: 0.8 }}>(新{newSelectedIds.length})</Typography.Text>}
            </Button>
          </Space>
          <Table dataSource={allQuestions} rowKey="id" size="small"
            pagination={{ simple: true, pageSize: 10, total: qTotal, onChange: (page) => setQPage(page) }}
            rowSelection={{
              selectedRowKeys: selectedQIds,
              onChange: (keys) => setSelectedQIds(keys as number[]),
              getCheckboxProps: (record: any) => ({
                disabled: existingQuestionIds.has(record.id),
              }),
            }}
            columns={[
              { title: '题型', dataIndex: 'type', width: 70,
                render: (t: string) => <Tag>{t === 'single' ? '单选' : t === 'multiple' ? '多选' : t === 'true_false' ? '判断' : '简答'}</Tag> },
              { title: '题目', dataIndex: 'question_text', ellipsis: true,
                render: (text: string, record: any) => (
                  <span style={{ color: existingQuestionIds.has(record.id) ? '#bbb' : undefined }}>
                    {existingQuestionIds.has(record.id) && <Tag color="default" style={{ marginRight: 4, fontSize: 11 }}>已添加</Tag>}
                    {text}
                  </span>
                ),
              },
              { title: '知识点', dataIndex: 'knowledge_points', width: 150, ellipsis: true },
              { title: '难度', dataIndex: 'difficulty', width: 70,
                render: (d: string) => <Tag>{d === 'easy' ? '简单' : d === 'hard' ? '困难' : '中等'}</Tag> },
            ]}
            onRow={(record: any) => ({
              style: { opacity: existingQuestionIds.has(record.id) ? 0.5 : 1, cursor: existingQuestionIds.has(record.id) ? 'not-allowed' : 'pointer' },
            })}
          />
        </Spin>
      </Modal>

      {/* ── 成绩查看弹窗 ── */}
      <Modal title={`考试成绩 - ${resultExam?.title || ''}`}
        open={resultModal}
        onCancel={() => setResultModal(false)}
        width={900}
        footer={[
          <Button key="export" type="primary" icon={<DownloadOutlined />}
            disabled={!resultExam?.id}
            onClick={() => {
              const token = localStorage.getItem('smartkb_token')
              window.open(`/api/export/exam/${resultExam?.id}?token=${token}`, '_blank')
            }}>导出报告</Button>,
          <Button key="close" onClick={() => setResultModal(false)}>关闭</Button>,
        ]}>
        <Spin spinning={resultLoading}>
          {resultData && (
            <>
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title="参考人数" value={resultData.statistics.total_students} />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title="平均分" value={resultData.statistics.avg_score} precision={1} />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title="及格人数" value={resultData.statistics.pass_count}
                      suffix={`/ ${resultData.statistics.total_students}`} />
                  </Card>
                </Col>
                <Col span={6}>
                  <Card size="small">
                    <Statistic title="及格率" value={resultData.statistics.pass_rate}
                      suffix="%" precision={1} />
                  </Card>
                </Col>
              </Row>
              <Table dataSource={resultData.attempts} rowKey="id" size="small"
                columns={[
                  { title: '学生', dataIndex: 'student_name', key: 'student_name', width: 100 },
                  { title: '得分', key: 'score', width: 100,
                    render: (_: any, r: ExamAttempt) => {
                      const passed = r.score >= (resultExam?.pass_score || 60)
                      return <span style={{ color: passed ? '#52c41a' : '#ff4d4f', fontWeight: 600 }}>{r.score} / {r.total_score}</span>
                    },
                  },
                  { title: '提交时间', dataIndex: 'submitted_at', key: 'submitted_at', width: 160,
                    render: (t: string) => t ? t.slice(0, 16) : '-' },
                ]}
                pagination={false}
              />
            </>
          )}
        </Spin>
      </Modal>
    </Layout>
  )
}

export default ExamPage
