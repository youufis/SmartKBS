/**
 * QuestAdminPage — 教师端闯关记录查看
 * 分页展示学生闯关记录，+ 号展开显示每题详情
 */
import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Table, Tag, Typography, Space, Spin, Input, Select,
  message, Progress, Button, Modal,
} from 'antd'
import {
  TrophyOutlined, SearchOutlined, ReloadOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
  ClockCircleOutlined, DeleteOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'

const { Title, Text } = Typography

interface QuestionDetail {
  sort_order: number
  category: string
  question_text: string
  options: Record<string, string>
  correct_answer: string
  student_answer: string
  is_correct: number
  lifeline_used: string
  time_spent: number
  score: number
  explanation: string
}

interface QuestRecord {
  id: number
  student_username: string
  student_name: string
  grade: string
  class_name: string
  answered_count: number
  correct_count: number
  score: number
  wrong_question_index: number
  completed: number
  lifelines_used: string[]
  questions: QuestionDetail[]
  created_at: string
  completed_at: string | null
}

const LIFELINE_LABELS: Record<string, string> = {
  remove_one: '🎯去伪存真',
  phone_friend: '📞远程连线',
  audience_vote: '👥群策群力',
}

const SCORE_COLORS = ['#ff4d4f', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1']

const QuestAdminPage: React.FC = () => {
  const [records, setRecords] = useState<QuestRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [gradeFilter, setGradeFilter] = useState('')
  const [classFilter, setClassFilter] = useState('')
  const [nameFilter, setNameFilter] = useState('')

  // 动态下拉选项
  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [gradesLoading, setGradesLoading] = useState(true)
  const [classesLoading, setClassesLoading] = useState(false)

  // 加载年级列表
  useEffect(() => {
    (async () => {
      try {
        const { data } = await apiClient.get('/api/quest/admin/grades')
        setGrades(Array.isArray(data) ? data : [])
      } catch {
        // ignore
      } finally {
        setGradesLoading(false)
      }
    })()
  }, [])

  // 年级变化时加载班级
  useEffect(() => {
    if (!gradeFilter) {
      setClasses([])
      return
    }
    setClassesLoading(true)
    setClassFilter('')
    ;(async () => {
      try {
        const { data } = await apiClient.get('/api/quest/admin/classes', {
          params: { grade: gradeFilter },
        })
        setClasses(Array.isArray(data) ? data : [])
      } catch {
        // ignore
      } finally {
        setClassesLoading(false)
      }
    })()
  }, [gradeFilter])

  const loadRecords = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = { page, page_size: pageSize }
      if (gradeFilter) params.grade = gradeFilter
      if (classFilter) params.class_name = classFilter
      if (nameFilter) params.student_name = nameFilter
      const { data } = await apiClient.get('/api/quest/admin/records', { params })
      setRecords(data.records || [])
      setTotal(data.total || 0)
    } catch {
      message.error('加载闯关记录失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, gradeFilter, classFilter, nameFilter])

  useEffect(() => {
    loadRecords()
  }, [loadRecords])

  const handleDelete = (record: QuestRecord) => {
    Modal.confirm({
      title: '确认删除',
      icon: <ExclamationCircleOutlined />,
      content: `确定删除 ${record.student_name} 的闯关记录 #${record.id}（答对 ${record.correct_count}/${record.answered_count} 题）？此操作不可恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiClient.delete(`/api/quest/admin/records/${record.id}`)
          message.success('删除成功')
          loadRecords()
        } catch (e: any) {
          message.error(e?.response?.data?.detail || '删除失败')
        }
      },
    })
  }

  const columns = [
    {
      title: '学生',
      key: 'student',
      width: 120,
      render: (_: any, r: QuestRecord) => (
        <Text strong>{r.student_name}</Text>
      ),
    },
    {
      title: '班级',
      key: 'class',
      width: 120,
      render: (_: any, r: QuestRecord) => (
        <Text type="secondary">{r.grade} {r.class_name}</Text>
      ),
    },
    {
      title: '结果',
      key: 'status',
      width: 80,
      render: (_: any, r: QuestRecord) => {
        if (r.completed === 0) return <Tag color="processing">进行中</Tag>
        if (r.completed === 1 && r.correct_count >= 1) return <Tag color="success">成功</Tag>
        return <Tag color="error">终止</Tag>
      },
    },
    {
      title: '答对/总题',
      key: 'count',
      width: 100,
      render: (_: any, r: QuestRecord) => {
        const c = SCORE_COLORS[Math.min(Math.floor(r.correct_count / 3), 5)]
        return <Text strong style={{ color: c }}>{r.correct_count} / {r.answered_count}</Text>
      },
    },
    {
      title: '得分',
      dataIndex: 'score',
      key: 'score',
      width: 70,
      render: (s: number) => <Text strong>{s}</Text>,
    },
    {
      title: '终止题号',
      key: 'wrong',
      width: 80,
      render: (_: any, r: QuestRecord) =>
        r.wrong_question_index > 0 ? `第${r.wrong_question_index}题` : '-',
    },
    {
      title: '锦囊',
      key: 'lifelines',
      width: 160,
      render: (_: any, r: QuestRecord) => (
        <Space size={2} wrap>
          {r.lifelines_used.length > 0
            ? r.lifelines_used.map((l) => (
                <Tag key={l} color="orange" style={{ fontSize: 11 }}>
                  {LIFELINE_LABELS[l] || l}
                </Tag>
              ))
            : <Text type="secondary">未使用</Text>
          }
        </Space>
      ),
    },
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'time',
      width: 140,
      render: (t: string) => t?.slice(0, 16) || '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 70,
      render: (_: any, r: QuestRecord) => (
        <Button
          type="link"
          danger
          size="small"
          icon={<DeleteOutlined />}
          onClick={(e) => { e.stopPropagation(); handleDelete(r) }}
        />
      ),
    },
  ]

  const expandedRowRender = (record: QuestRecord) => (
    <div style={{ maxWidth: '100%', overflow: 'auto' }}>
      {record.questions.length === 0 ? (
        <Text type="secondary">暂无题目详情</Text>
      ) : (
        <Table
          dataSource={record.questions}
          rowKey="sort_order"
          pagination={false}
          size="small"
          bordered
          columns={[
            {
              title: '#',
              dataIndex: 'sort_order',
              key: 'sort',
              width: 40,
            },
            {
              title: '领域',
              dataIndex: 'category',
              key: 'cat',
              width: 80,
              render: (c: string) => <Tag>{c}</Tag>,
            },
            {
              title: '题目',
              dataIndex: 'question_text',
              key: 'q',
              width: 280,
              render: (t: string) => (
                <div style={{ maxWidth: 280, wordBreak: 'break-word' }}>
                  <Text style={{ fontSize: 13 }}>{t}</Text>
                </div>
              ),
            },
            {
              title: '学生答案',
              dataIndex: 'student_answer',
              key: 'sa',
              width: 100,
              render: (ans: string, q: QuestionDetail) => {
                if (q.is_correct === 1) return <Tag color="success">{ans || '✓'}</Tag>
                if (q.is_correct === 0) return <Tag color="error">{ans || '✗'}</Tag>
                return <Tag>-</Tag>
              },
            },
            {
              title: '正确答案',
              key: 'ca',
              width: 100,
              render: (_: any, q: QuestionDetail) => (
                <Tag color="green">{q.correct_answer}. {q.options[q.correct_answer]?.slice(0, 20) || ''}</Tag>
              ),
            },
            {
              title: '得分',
              dataIndex: 'score',
              key: 's',
              width: 50,
              render: (s: number) => <Text strong>{s}</Text>,
            },
            {
              title: '用时',
              dataIndex: 'time_spent',
              key: 'ts',
              width: 60,
              render: (t: number) => (
                <Space>
                  <ClockCircleOutlined style={{ fontSize: 12 }} />
                  {t || 0}s
                </Space>
              ),
            },
            {
              title: '锦囊',
              dataIndex: 'lifeline_used',
              key: 'll',
              width: 80,
              render: (l: string) =>
                l ? <Tag color="orange" style={{ fontSize: 11 }}>{LIFELINE_LABELS[l.split(',')[0]] || l}</Tag> : '-',
            },
            {
              title: '解析',
              dataIndex: 'explanation',
              key: 'exp',
              width: 200,
              render: (e: string) => (
                <Text type="secondary" style={{ fontSize: 12 }}>{e}</Text>
              ),
            },
          ]}
          scroll={{ x: 1100 }}
        />
      )}
    </div>
  )

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <Title level={3}>
        <TrophyOutlined style={{ marginRight: 8 }} />
        闯关记录 · 教师查看
      </Title>

      {/* ── 筛选栏 ── */}
      <Card style={{ marginBottom: 16, borderRadius: 10 }} size="small">
        <Space wrap>
          <Input
            placeholder="学生姓名"
            prefix={<SearchOutlined />}
            style={{ width: 160 }}
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            allowClear
            onPressEnter={loadRecords}
          />
          <Select
            placeholder="选择年级"
            style={{ width: 120 }}
            value={gradeFilter || undefined}
            onChange={(v) => setGradeFilter(v || '')}
            allowClear
            loading={gradesLoading}
            options={grades.map((g) => ({ label: g, value: g }))}
          />
          <Select
            placeholder="选择班级"
            style={{ width: 120 }}
            value={classFilter || undefined}
            onChange={(v) => setClassFilter(v || '')}
            allowClear
            loading={classesLoading}
            disabled={!gradeFilter}
            options={classes.map((c) => ({ label: c, value: c }))}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={loadRecords}>查询</Button>
          <Text type="secondary" style={{ fontSize: 13 }}>共 {total} 条记录</Text>
        </Space>
      </Card>

      {/* ── 表格 ── */}
      <Card style={{ borderRadius: 10 }}>
        <Table
          dataSource={records}
          columns={columns}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showQuickJumper: true,
            hideOnSinglePage: false,
            showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
          expandable={{
            expandedRowRender,
            rowExpandable: (r) => r.questions.length > 0,
          }}
          scroll={{ x: 900 }}
        />
      </Card>
    </div>
  )
}

export default QuestAdminPage
